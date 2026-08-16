from __future__ import annotations

import asyncio
import logging
import uuid
from collections.abc import Callable, Iterable
from contextlib import suppress
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session

from .config import Settings
from .db import Database
from .models import Score, StorageDeletionJob, utcnow
from .storage import LocalObjectStorage, ObjectStorage

logger = logging.getLogger(__name__)

type Clock = Callable[[], datetime]


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def _later(first: datetime | None, second: datetime | None) -> datetime | None:
    if first is None:
        return second
    if second is None:
        return first
    return max(_as_utc(first), _as_utc(second))


def _earlier(first: datetime, second: datetime) -> datetime:
    return min(_as_utc(first), _as_utc(second))


def enqueue_storage_deletion(
    db: Session,
    storage_key: str,
    *,
    reason: str,
    now: datetime,
    guard_until: datetime | None = None,
) -> StorageDeletionJob:
    """Create or reopen a durable deletion without contacting object storage."""

    existing = db.scalar(
        select(StorageDeletionJob).where(StorageDeletionJob.storage_key == storage_key).with_for_update()
    )
    if existing is None:
        job = StorageDeletionJob(
            storage_key=storage_key,
            reason=reason,
            status="pending",
            attempt_count=0,
            next_attempt_at=now,
            guard_until=guard_until,
        )
        db.add(job)
        return job

    existing.reason = reason
    existing.guard_until = _later(existing.guard_until, guard_until)
    if existing.status == "completed":
        existing.status = "pending"
        existing.completed_at = None
        existing.lease_owner = None
        existing.lease_expires_at = None
        existing.last_error = None
        existing.next_attempt_at = now
    elif existing.status == "pending":
        existing.next_attempt_at = _earlier(existing.next_attempt_at, now)
    return existing


def _staging_guard_until(score: Score, settings: Settings) -> datetime | None:
    if score.staging_key is None and score.upload_status != "pending":
        return None
    if score.upload_expires_at is not None:
        capability_expires = _as_utc(score.upload_expires_at)
        capability_expires += timedelta(seconds=settings.pending_upload_grace_seconds)
    else:
        capability_expires = _as_utc(score.created_at) + timedelta(
            seconds=settings.legacy_pending_upload_ttl_seconds
        )
    return capability_expires + timedelta(seconds=settings.late_upload_guard_seconds)


def enqueue_score_deletions(
    db: Session,
    scores: Iterable[Score],
    settings: Settings,
    *,
    reason: str,
    now: datetime | None = None,
) -> list[StorageDeletionJob]:
    """Enqueue every possible object for locked Score rows in the caller's transaction."""

    queued_at = _as_utc(now or utcnow())
    entries: dict[str, datetime | None] = {}
    for score in scores:
        legacy_upload_key = score.staging_key is None and score.upload_status == "pending"
        final_guard = _staging_guard_until(score, settings) if legacy_upload_key else None
        entries[score.storage_key] = _later(entries.get(score.storage_key), final_guard)
        if score.staging_key is not None:
            entries[score.staging_key] = _later(
                entries.get(score.staging_key),
                _staging_guard_until(score, settings),
            )
    return [
        enqueue_storage_deletion(
            db,
            storage_key,
            reason=reason,
            now=queued_at,
            guard_until=guard_until,
        )
        for storage_key, guard_until in sorted(entries.items())
    ]


def enqueue_promoted_staging_deletion(
    db: Session,
    score: Score,
    settings: Settings,
    *,
    now: datetime | None = None,
) -> StorageDeletionJob | None:
    if score.staging_key is None or score.staging_key == score.storage_key:
        return None
    queued_at = _as_utc(now or utcnow())
    return enqueue_storage_deletion(
        db,
        score.staging_key,
        reason="staging-promoted",
        now=queued_at,
        guard_until=_staging_guard_until(score, settings),
    )


@dataclass(frozen=True)
class ClaimedDeletion:
    id: str
    storage_key: str


class StorageLifecycleWorker:
    def __init__(
        self,
        database: Database,
        storage: ObjectStorage,
        settings: Settings,
        *,
        clock: Clock = utcnow,
        worker_id: str | None = None,
    ) -> None:
        self.database = database
        self.storage = storage
        self.settings = settings
        self.clock = clock
        self.worker_id = worker_id or str(uuid.uuid4())
        self._stop = asyncio.Event()
        self._task: asyncio.Task[None] | None = None

    @property
    def running(self) -> bool:
        return self._task is not None and not self._task.done()

    def start(self) -> None:
        if not self.settings.storage_worker_enabled or self._task is not None:
            return
        self._stop.clear()
        self._task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        if self._task is None:
            return
        self._stop.set()
        await self._task
        self._task = None

    async def _run(self) -> None:
        while not self._stop.is_set():
            try:
                await asyncio.to_thread(self.run_once)
            except Exception as exc:
                logger.error("Storage lifecycle iteration failed (%s)", type(exc).__name__)
            with suppress(TimeoutError):
                await asyncio.wait_for(
                    self._stop.wait(),
                    timeout=self.settings.storage_worker_interval_seconds,
                )

    def run_once(self) -> int:
        self.reap_stale_pending_scores()
        if isinstance(self.storage, LocalObjectStorage):
            before = _as_utc(self.clock()) - timedelta(seconds=self.settings.local_upload_temp_ttl_seconds)
            self.storage.cleanup_temporary_uploads(before)
        claimed = self.claim_due_deletions()
        for job in claimed:
            self._process_claim(job)
        return len(claimed)

    def reap_stale_pending_scores(self) -> int:
        now = _as_utc(self.clock())
        signed_cutoff = now - timedelta(seconds=self.settings.pending_upload_grace_seconds)
        legacy_cutoff = now - timedelta(seconds=self.settings.legacy_pending_upload_ttl_seconds)
        with self.database.session_factory() as db:
            rows = db.scalars(
                select(Score)
                .where(
                    Score.upload_status == "pending",
                    or_(
                        and_(
                            Score.upload_expires_at.is_not(None),
                            Score.upload_expires_at <= signed_cutoff,
                        ),
                        and_(
                            Score.upload_expires_at.is_(None),
                            Score.created_at <= legacy_cutoff,
                        ),
                    ),
                )
                .order_by(Score.created_at, Score.id)
                .limit(self.settings.storage_delete_batch_size)
                .with_for_update(skip_locked=True)
            ).all()
            for score in rows:
                enqueue_score_deletions(
                    db,
                    [score],
                    self.settings,
                    reason="stale-pending",
                    now=now,
                )
                db.delete(score)
            db.commit()
            return len(rows)

    def claim_due_deletions(self) -> list[ClaimedDeletion]:
        now = _as_utc(self.clock())
        lease_expires_at = now + timedelta(seconds=self.settings.storage_delete_lease_seconds)
        with self.database.session_factory() as db:
            rows = db.scalars(
                select(StorageDeletionJob)
                .where(
                    or_(
                        and_(
                            StorageDeletionJob.status == "pending",
                            StorageDeletionJob.next_attempt_at <= now,
                        ),
                        and_(
                            StorageDeletionJob.status == "leased",
                            StorageDeletionJob.lease_expires_at <= now,
                        ),
                    )
                )
                .order_by(
                    StorageDeletionJob.next_attempt_at,
                    StorageDeletionJob.created_at,
                    StorageDeletionJob.id,
                )
                .limit(self.settings.storage_delete_batch_size)
                .with_for_update(skip_locked=True)
            ).all()
            claimed: list[ClaimedDeletion] = []
            for row in rows:
                row.status = "leased"
                row.lease_owner = self.worker_id
                row.lease_expires_at = lease_expires_at
                claimed.append(ClaimedDeletion(id=row.id, storage_key=row.storage_key))
            db.commit()
            return claimed

    def _process_claim(self, claimed: ClaimedDeletion) -> None:
        try:
            self.storage.delete(claimed.storage_key)
        except Exception as exc:
            self._finalize_failure(claimed.id, exc)
            logger.warning(
                "Storage deletion retry scheduled for job %s (%s)",
                claimed.id,
                type(exc).__name__,
            )
            return
        self._finalize_success(claimed.id)

    def _leased_job(self, db: Session, job_id: str) -> StorageDeletionJob | None:
        return db.scalar(
            select(StorageDeletionJob)
            .where(
                StorageDeletionJob.id == job_id,
                StorageDeletionJob.status == "leased",
                StorageDeletionJob.lease_owner == self.worker_id,
            )
            .with_for_update()
        )

    def _finalize_success(self, job_id: str) -> None:
        now = _as_utc(self.clock())
        with self.database.session_factory() as db:
            row = self._leased_job(db, job_id)
            if row is None:
                db.rollback()
                return
            guard_until = _as_utc(row.guard_until) if row.guard_until is not None else None
            row.lease_owner = None
            row.lease_expires_at = None
            row.last_error = None
            if guard_until is not None and now < guard_until:
                row.status = "pending"
                row.next_attempt_at = min(
                    now + timedelta(seconds=self.settings.staging_redelete_interval_seconds),
                    guard_until,
                )
            else:
                row.status = "completed"
                row.completed_at = now
            db.commit()

    def _finalize_failure(self, job_id: str, error: Exception) -> None:
        now = _as_utc(self.clock())
        with self.database.session_factory() as db:
            row = self._leased_job(db, job_id)
            if row is None:
                db.rollback()
                return
            row.attempt_count += 1
            exponent = min(max(row.attempt_count - 1, 0), 30)
            delay = min(
                self.settings.storage_delete_retry_base_seconds * (2**exponent),
                self.settings.storage_delete_retry_max_seconds,
            )
            row.status = "pending"
            row.next_attempt_at = now + timedelta(seconds=delay)
            row.lease_owner = None
            row.lease_expires_at = None
            row.last_error = type(error).__name__[:160]
            db.commit()
