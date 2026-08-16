from __future__ import annotations

from datetime import UTC, datetime, timedelta
from os import utime
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import Group, Project, RepertoireItem, Score, StorageDeletionJob, utcnow
from app.storage import LocalObjectStorage
from app.storage_lifecycle import StorageLifecycleWorker

from .conftest import auth


class FakeDeleteStorage:
    def __init__(self, failing_keys: set[str] | None = None) -> None:
        self.failing_keys = failing_keys or set()
        self.deleted_keys: list[str] = []

    def delete(self, storage_key: str) -> None:
        self.deleted_keys.append(storage_key)
        if storage_key in self.failing_keys:
            raise RuntimeError("object service unavailable")


class MutableClock:
    def __init__(self, current: datetime) -> None:
        self.current = current

    def __call__(self) -> datetime:
        return self.current

    def advance(self, seconds: float) -> None:
        self.current += timedelta(seconds=seconds)


def _create_project(client: TestClient, group_id: str, headers: dict[str, str], name: str) -> str:
    response = client.post(
        f"/api/groups/{group_id}/projects",
        headers=headers,
        json={"name": name, "description": ""},
    )
    assert response.status_code == 201, response.text
    return str(response.json()["id"])


def _create_repertoire(
    client: TestClient,
    project_id: str,
    headers: dict[str, str],
    title: str,
) -> str:
    response = client.post(
        f"/api/projects/{project_id}/repertoire",
        headers=headers,
        json={"title": title, "composer": "", "notes": ""},
    )
    assert response.status_code == 201, response.text
    return str(response.json()["id"])


def _seed_score(
    client: TestClient,
    repertoire_id: str,
    creator_id: str,
    storage_key: str,
) -> None:
    with client.app.state.database.session_factory() as db:
        db.add(
            Score(
                repertoire_id=repertoire_id,
                kind="part",
                instrument="violin",
                filename=storage_key.rsplit("/", 1)[-1],
                content_type="application/pdf",
                storage_key=storage_key,
                size_bytes=12,
                upload_status="ready",
                created_by_id=creator_id,
            )
        )
        db.commit()


def _storage_tree(client: TestClient, ensemble: dict[str, Any]) -> dict[str, Any]:
    owner = ensemble["owner"]
    owner_headers = auth(owner["accessToken"])
    target_group_id = str(ensemble["group"]["id"])
    target_project_id = str(ensemble["project"]["id"])
    target_repertoire_id = str(ensemble["repertoire"]["id"])

    sibling_repertoire_id = _create_repertoire(
        client,
        target_project_id,
        owner_headers,
        "Sibling repertoire",
    )
    sibling_project_id = _create_project(
        client,
        target_group_id,
        owner_headers,
        "Sibling project",
    )
    sibling_project_repertoire_id = _create_repertoire(
        client,
        sibling_project_id,
        owner_headers,
        "Sibling project repertoire",
    )

    survivor_group_response = client.post(
        "/api/groups",
        headers=owner_headers,
        json={"name": "Survivor group", "description": ""},
    )
    assert survivor_group_response.status_code == 201, survivor_group_response.text
    survivor_group_id = str(survivor_group_response.json()["id"])
    survivor_project_id = _create_project(
        client,
        survivor_group_id,
        owner_headers,
        "Survivor project",
    )
    survivor_repertoire_id = _create_repertoire(
        client,
        survivor_project_id,
        owner_headers,
        "Survivor repertoire",
    )

    creator_id = str(owner["user"]["id"])
    keys_by_repertoire = {
        target_repertoire_id: ["scores/target/z.pdf", "scores/target/a.pdf"],
        sibling_repertoire_id: ["scores/sibling-repertoire.pdf"],
        sibling_project_repertoire_id: ["scores/sibling-project.pdf"],
        survivor_repertoire_id: ["scores/survivor-group.pdf"],
    }
    for repertoire_id, storage_keys in keys_by_repertoire.items():
        for storage_key in storage_keys:
            _seed_score(client, repertoire_id, creator_id, storage_key)

    repertoire_keys = set(keys_by_repertoire[target_repertoire_id])
    project_keys = repertoire_keys | set(keys_by_repertoire[sibling_repertoire_id])
    group_keys = project_keys | set(keys_by_repertoire[sibling_project_repertoire_id])
    all_keys = group_keys | set(keys_by_repertoire[survivor_repertoire_id])
    return {
        "headers": owner_headers,
        "ids": {
            "repertoire": target_repertoire_id,
            "project": target_project_id,
            "group": target_group_id,
        },
        "keys": {
            "repertoire": repertoire_keys,
            "project": project_keys,
            "group": group_keys,
            "all": all_keys,
        },
    }


@pytest.mark.parametrize("scope", ["repertoire", "project", "group"])
def test_parent_deletion_commits_every_descendant_to_outbox_before_worker_cleanup(
    client: TestClient,
    ensemble: dict[str, Any],
    scope: str,
) -> None:
    tree = _storage_tree(client, ensemble)
    target_id = tree["ids"][scope]
    endpoint = {
        "repertoire": f"/api/repertoire/{target_id}",
        "project": f"/api/projects/{target_id}",
        "group": f"/api/groups/{target_id}",
    }[scope]
    fake_storage = FakeDeleteStorage()
    client.app.state.storage = fake_storage

    response = client.delete(endpoint, headers=tree["headers"])

    assert response.status_code == 204, response.text
    expected_deleted = tree["keys"][scope]
    assert fake_storage.deleted_keys == []
    with client.app.state.database.session_factory() as db:
        remaining_keys = set(db.scalars(select(Score.storage_key)).all())
        jobs = db.scalars(select(StorageDeletionJob).order_by(StorageDeletionJob.storage_key)).all()
        if scope == "repertoire":
            assert db.get(RepertoireItem, target_id) is None
        elif scope == "project":
            assert db.get(Project, target_id) is None
        else:
            assert db.get(Group, target_id) is None
    assert remaining_keys == tree["keys"]["all"] - expected_deleted
    assert [job.storage_key for job in jobs] == sorted(expected_deleted)
    assert all(job.status == "pending" for job in jobs)

    worker = StorageLifecycleWorker(
        client.app.state.database,
        fake_storage,
        client.app.state.settings,
    )
    assert worker.run_once() == len(expected_deleted)
    assert fake_storage.deleted_keys == sorted(expected_deleted)
    with client.app.state.database.session_factory() as db:
        statuses = set(db.scalars(select(StorageDeletionJob.status)).all())
    assert statuses == {"completed"}


def test_worker_attempts_all_objects_and_retries_failures_without_restoring_database_rows(
    client: TestClient,
    ensemble: dict[str, Any],
) -> None:
    tree = _storage_tree(client, ensemble)
    target_id = tree["ids"]["group"]
    expected_keys = tree["keys"]["group"]
    failing_key = sorted(expected_keys)[1]
    fake_storage = FakeDeleteStorage({failing_key})
    client.app.state.storage = fake_storage

    response = client.delete(f"/api/groups/{target_id}", headers=tree["headers"])

    assert response.status_code == 204, response.text
    assert fake_storage.deleted_keys == []
    clock = MutableClock(utcnow() + timedelta(seconds=1))
    worker = StorageLifecycleWorker(
        client.app.state.database,
        fake_storage,
        client.app.state.settings,
        clock=clock,
    )
    assert worker.run_once() == len(expected_keys)
    assert fake_storage.deleted_keys == sorted(expected_keys)
    with client.app.state.database.session_factory() as db:
        assert db.get(Group, target_id) is None
        remaining_keys = set(db.scalars(select(Score.storage_key)).all())
        failed = db.scalar(select(StorageDeletionJob).where(StorageDeletionJob.storage_key == failing_key))
        assert failed is not None
        assert failed.status == "pending"
        assert failed.attempt_count == 1
        assert failed.last_error == "RuntimeError"
        assert (
            db.scalar(
                select(func.count())
                .select_from(StorageDeletionJob)
                .where(StorageDeletionJob.status == "completed")
            )
            == len(expected_keys) - 1
        )
    assert remaining_keys == tree["keys"]["all"] - expected_keys

    fake_storage.failing_keys.clear()
    clock.advance(client.app.state.settings.storage_delete_retry_base_seconds)
    assert worker.run_once() == 1
    assert fake_storage.deleted_keys.count(failing_key) == 2
    with client.app.state.database.session_factory() as db:
        assert set(db.scalars(select(StorageDeletionJob.status)).all()) == {"completed"}


def test_database_commit_failure_never_calls_storage_or_persists_outbox(
    client: TestClient,
    ensemble: dict[str, Any],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    tree = _storage_tree(client, ensemble)
    target_id = tree["ids"]["repertoire"]
    fake_storage = FakeDeleteStorage()
    client.app.state.storage = fake_storage
    original_commit = Session.commit

    def fail_outbox_commit(session: Session) -> None:
        if any(isinstance(row, StorageDeletionJob) for row in session.new):
            raise RuntimeError("database commit unavailable")
        original_commit(session)

    monkeypatch.setattr(Session, "commit", fail_outbox_commit)
    with pytest.raises(RuntimeError, match="database commit unavailable"):
        client.delete(f"/api/repertoire/{target_id}", headers=tree["headers"])

    assert fake_storage.deleted_keys == []
    with client.app.state.database.session_factory() as db:
        assert db.get(RepertoireItem, target_id) is not None
        assert set(db.scalars(select(Score.storage_key)).all()) == tree["keys"]["all"]
        assert db.scalar(select(func.count()).select_from(StorageDeletionJob)) == 0


def test_guarded_staging_job_redeletes_until_guard_then_completes(client: TestClient) -> None:
    clock = MutableClock(utcnow())
    settings = client.app.state.settings.model_copy(update={"staging_redelete_interval_seconds": 10})
    with client.app.state.database.session_factory() as db:
        db.add(
            StorageDeletionJob(
                storage_key="staging/scores/late/source.pdf",
                reason="staging-promoted",
                status="pending",
                attempt_count=0,
                next_attempt_at=clock.current,
                guard_until=clock.current + timedelta(seconds=20),
            )
        )
        db.commit()
    storage = FakeDeleteStorage()
    worker = StorageLifecycleWorker(
        client.app.state.database,
        storage,
        settings,
        clock=clock,
    )

    assert worker.run_once() == 1
    with client.app.state.database.session_factory() as db:
        job = db.scalar(select(StorageDeletionJob))
        assert job is not None
        assert job.status == "pending"
        assert job.completed_at is None

    clock.advance(10)
    assert worker.run_once() == 1
    clock.advance(10)
    assert worker.run_once() == 1
    assert storage.deleted_keys == ["staging/scores/late/source.pdf"] * 3
    with client.app.state.database.session_factory() as db:
        job = db.scalar(select(StorageDeletionJob))
        assert job is not None
        assert job.status == "completed"


def test_expired_lease_is_retried_after_delete_before_ack_crash(client: TestClient) -> None:
    clock = MutableClock(utcnow())
    settings = client.app.state.settings.model_copy(update={"storage_delete_lease_seconds": 10})
    with client.app.state.database.session_factory() as db:
        db.add(
            StorageDeletionJob(
                storage_key="scores/crash-safe.pdf",
                reason="score",
                status="pending",
                attempt_count=0,
                next_attempt_at=clock.current,
            )
        )
        db.commit()
    storage = FakeDeleteStorage()
    first = StorageLifecycleWorker(
        client.app.state.database,
        storage,
        settings,
        clock=clock,
        worker_id="first-worker",
    )
    claimed = first.claim_due_deletions()
    assert len(claimed) == 1
    storage.delete(claimed[0].storage_key)

    wrong_owner = StorageLifecycleWorker(
        client.app.state.database,
        storage,
        settings,
        clock=clock,
        worker_id="wrong-worker",
    )
    wrong_owner._finalize_success(claimed[0].id)
    with client.app.state.database.session_factory() as db:
        still_leased = db.get(StorageDeletionJob, claimed[0].id)
        assert still_leased is not None
        assert still_leased.status == "leased"
        assert still_leased.lease_owner == "first-worker"

    clock.advance(11)
    restarted = StorageLifecycleWorker(
        client.app.state.database,
        storage,
        settings,
        clock=clock,
        worker_id="restarted-worker",
    )
    assert restarted.run_once() == 1
    assert storage.deleted_keys == ["scores/crash-safe.pdf", "scores/crash-safe.pdf"]
    with client.app.state.database.session_factory() as db:
        job = db.scalar(select(StorageDeletionJob))
        assert job is not None
        assert job.status == "completed"


def test_workers_claim_disjoint_batches_and_logs_never_include_storage_details(
    client: TestClient,
    caplog: pytest.LogCaptureFixture,
) -> None:
    clock = MutableClock(utcnow())
    settings = client.app.state.settings.model_copy(update={"storage_delete_batch_size": 2})
    sensitive_key = "staging/scores/token-secret.pdf"
    with client.app.state.database.session_factory() as db:
        db.add_all(
            [
                StorageDeletionJob(
                    storage_key=key,
                    reason="score",
                    status="pending",
                    attempt_count=40 if key == sensitive_key else 0,
                    next_attempt_at=clock.current,
                )
                for key in [sensitive_key, "scores/b.pdf", "scores/c.pdf"]
            ]
        )
        db.commit()
    storage = FakeDeleteStorage({sensitive_key})
    first = StorageLifecycleWorker(
        client.app.state.database,
        storage,
        settings,
        clock=clock,
        worker_id="first-worker",
    )
    second = StorageLifecycleWorker(
        client.app.state.database,
        storage,
        settings,
        clock=clock,
        worker_id="second-worker",
    )
    first_claims = first.claim_due_deletions()
    second_claims = second.claim_due_deletions()
    assert {job.id for job in first_claims}.isdisjoint(job.id for job in second_claims)
    assert len(first_claims) == 2
    assert len(second_claims) == 1

    with caplog.at_level("WARNING", logger="app.storage_lifecycle"):
        for claimed in [*first_claims, *second_claims]:
            owner = first if claimed in first_claims else second
            owner._process_claim(claimed)
    assert sensitive_key not in caplog.text
    assert "token-secret" not in caplog.text
    assert "object service unavailable" not in caplog.text
    with client.app.state.database.session_factory() as db:
        failed = db.scalar(select(StorageDeletionJob).where(StorageDeletionJob.storage_key == sensitive_key))
        assert failed is not None
        assert failed.status == "pending"
        assert failed.attempt_count == 41
        next_attempt_at = failed.next_attempt_at
        if next_attempt_at.tzinfo is None:
            next_attempt_at = next_attempt_at.replace(tzinfo=UTC)
        assert next_attempt_at == clock.current + timedelta(seconds=settings.storage_delete_retry_max_seconds)


def test_stale_pending_reaper_atomically_enqueues_both_namespaces_and_preserves_live_rows(
    client: TestClient,
    ensemble: dict[str, Any],
) -> None:
    now = utcnow()
    settings = client.app.state.settings
    repertoire_id = str(ensemble["repertoire"]["id"])
    creator_id = str(ensemble["owner"]["user"]["id"])
    expired = Score(
        repertoire_id=repertoire_id,
        kind="part",
        instrument="violin",
        filename="expired.pdf",
        content_type="application/pdf",
        storage_key="scores/expired/final.pdf",
        staging_key="staging/scores/expired/source.pdf",
        upload_expires_at=now - timedelta(seconds=settings.pending_upload_grace_seconds + 1),
        size_bytes=4,
        upload_status="pending",
        created_by_id=creator_id,
    )
    legacy = Score(
        repertoire_id=repertoire_id,
        kind="part",
        instrument="viola",
        filename="legacy.pdf",
        content_type="application/pdf",
        storage_key="scores/legacy/source.pdf",
        staging_key=None,
        upload_expires_at=None,
        size_bytes=4,
        upload_status="pending",
        created_by_id=creator_id,
        created_at=now - timedelta(seconds=settings.legacy_pending_upload_ttl_seconds + 1),
    )
    recent = Score(
        repertoire_id=repertoire_id,
        kind="part",
        instrument="cello",
        filename="recent.pdf",
        content_type="application/pdf",
        storage_key="scores/recent/final.pdf",
        staging_key="staging/scores/recent/source.pdf",
        upload_expires_at=now + timedelta(minutes=5),
        size_bytes=4,
        upload_status="pending",
        created_by_id=creator_id,
    )
    ready = Score(
        repertoire_id=repertoire_id,
        kind="full",
        instrument="",
        filename="ready.pdf",
        content_type="application/pdf",
        storage_key="scores/ready/final.pdf",
        staging_key="staging/scores/ready/source.pdf",
        upload_expires_at=now - timedelta(days=1),
        size_bytes=4,
        upload_status="ready",
        created_by_id=creator_id,
    )
    with client.app.state.database.session_factory() as db:
        db.add_all([expired, legacy, recent, ready])
        db.commit()
        removed_ids = {expired.id, legacy.id}
        survivor_ids = {recent.id, ready.id}

    storage = FakeDeleteStorage()
    clock = MutableClock(now)
    worker = StorageLifecycleWorker(
        client.app.state.database,
        storage,
        settings,
        clock=clock,
    )
    assert worker.reap_stale_pending_scores() == 2
    assert storage.deleted_keys == []
    with client.app.state.database.session_factory() as db:
        assert all(db.get(Score, score_id) is None for score_id in removed_ids)
        assert all(db.get(Score, score_id) is not None for score_id in survivor_ids)
        jobs = db.scalars(select(StorageDeletionJob).order_by(StorageDeletionJob.storage_key)).all()
        assert [job.storage_key for job in jobs] == [
            "scores/expired/final.pdf",
            "scores/legacy/source.pdf",
            "staging/scores/expired/source.pdf",
        ]
        final = next(job for job in jobs if job.storage_key == "scores/expired/final.pdf")
        assert final.guard_until is None
        assert all(
            job.guard_until is not None for job in jobs if job.storage_key != "scores/expired/final.pdf"
        )

    assert worker.run_once() == 3
    assert set(storage.deleted_keys) == {
        "scores/expired/final.pdf",
        "scores/legacy/source.pdf",
        "staging/scores/expired/source.pdf",
    }


def test_worker_removes_only_expired_local_temporary_uploads(client: TestClient) -> None:
    storage = client.app.state.storage
    assert isinstance(storage, LocalObjectStorage)
    now = utcnow()
    expired = storage.create_temporary_upload_path()
    fresh = storage.create_temporary_upload_path()
    expired.write_bytes(b"expired")
    fresh.write_bytes(b"fresh")
    old_timestamp = (
        now - timedelta(seconds=client.app.state.settings.local_upload_temp_ttl_seconds + 1)
    ).timestamp()
    utime(expired, (old_timestamp, old_timestamp))
    worker = StorageLifecycleWorker(
        client.app.state.database,
        storage,
        client.app.state.settings,
        clock=MutableClock(now),
    )

    assert worker.run_once() == 0
    assert not expired.exists()
    assert fresh.exists()
