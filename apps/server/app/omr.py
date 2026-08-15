from __future__ import annotations

import asyncio
import contextlib
import logging
import shlex
import subprocess
import tempfile
import zipfile
from collections import defaultdict
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Protocol

from defusedxml import ElementTree
from sqlalchemy import select, update

from .config import Settings
from .db import Database
from .models import OmrDraftJob, Score
from .storage import ObjectStorage

MAX_MUSICXML_BYTES = 64 * 1024 * 1024
logger = logging.getLogger(__name__)


class OmrProcessingError(RuntimeError):
    pass


@dataclass(frozen=True)
class OmrDraftResult:
    regions: list[dict[str, object]]
    warnings: list[str]


class OmrProcessor(Protocol):
    def process(self, source: Path, output_dir: Path) -> OmrDraftResult: ...


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _read_musicxml(path: Path) -> bytes:
    if path.suffix.casefold() != ".mxl":
        data = path.read_bytes()
        if len(data) > MAX_MUSICXML_BYTES:
            raise OmrProcessingError("Audiveris MusicXML output exceeds the safety limit")
        return data

    try:
        with zipfile.ZipFile(path) as archive:
            try:
                container = ElementTree.fromstring(archive.read("META-INF/container.xml"))
                rootfile = next(
                    node.attrib["full-path"]
                    for node in container.iter()
                    if _local_name(node.tag) == "rootfile" and "full-path" in node.attrib
                )
            except (KeyError, StopIteration, ElementTree.ParseError) as exc:
                raise OmrProcessingError("Audiveris produced an invalid MXL container") from exc
            info = archive.getinfo(rootfile)
            if info.file_size > MAX_MUSICXML_BYTES:
                raise OmrProcessingError("Audiveris MusicXML output exceeds the safety limit")
            return archive.read(info)
    except (OSError, zipfile.BadZipFile, KeyError) as exc:
        raise OmrProcessingError("Audiveris produced an unreadable MXL file") from exc


def _measure_layouts(musicxml: bytes) -> list[tuple[int, int]]:
    try:
        root = ElementTree.fromstring(musicxml)
    except ElementTree.ParseError as exc:
        raise OmrProcessingError("Audiveris produced invalid MusicXML") from exc

    part = next((node for node in root.iter() if _local_name(node.tag) == "part"), None)
    if part is None:
        raise OmrProcessingError("Audiveris MusicXML contains no score part")
    measures = [node for node in part if _local_name(node.tag) == "measure"]
    if not measures:
        raise OmrProcessingError("Audiveris did not recognize any measures")

    page = 1
    system = 0
    layouts: list[tuple[int, int]] = []
    for index, measure in enumerate(measures):
        print_node = next(
            (node for node in measure if _local_name(node.tag) == "print"),
            None,
        )
        if index > 0 and print_node is not None and print_node.attrib.get("new-page") == "yes":
            page += 1
            system = 0
        elif index > 0 and print_node is not None and print_node.attrib.get("new-system") == "yes":
            system += 1
        layouts.append((page, system))
    return layouts


def _regions_from_layouts(layouts: list[tuple[int, int]]) -> list[dict[str, object]]:
    systems: dict[tuple[int, int], list[int]] = defaultdict(list)
    for measure_number, layout in enumerate(layouts, start=1):
        systems[layout].append(measure_number)

    systems_per_page: dict[int, int] = defaultdict(int)
    for page, system in systems:
        systems_per_page[page] = max(systems_per_page[page], system + 1)

    regions: list[dict[str, object]] = []
    horizontal_margin = 0.05
    horizontal_gap = 0.004
    vertical_margin = 0.06
    usable_width = 1 - horizontal_margin * 2
    usable_height = 1 - vertical_margin * 2
    for (page, system), measure_numbers in sorted(systems.items()):
        system_count = systems_per_page[page]
        system_slot = usable_height / system_count
        height = min(0.14, system_slot * 0.72)
        y = vertical_margin + system * system_slot + (system_slot - height) / 2
        width = (usable_width - horizontal_gap * (len(measure_numbers) - 1)) / len(measure_numbers)
        if width <= 0:
            raise OmrProcessingError("Audiveris system contains too many measures to map safely")
        for column, measure_number in enumerate(measure_numbers):
            x = horizontal_margin + column * (width + horizontal_gap)
            regions.append(
                {
                    "page": page,
                    "measureNumber": measure_number,
                    "rect": {
                        "x": round(x, 6),
                        "y": round(y, 6),
                        "w": round(width, 6),
                        "h": round(height, 6),
                    },
                }
            )
    return regions


class AudiverisProcessor:
    def __init__(self, settings: Settings) -> None:
        self.command = shlex.split(settings.omr_audiveris_command)
        self.timeout_seconds = settings.omr_timeout_seconds

    def process(self, source: Path, output_dir: Path) -> OmrDraftResult:
        try:
            completed = subprocess.run(
                [*self.command, "-batch", "-export", "-output", str(output_dir), str(source)],
                check=False,
                capture_output=True,
                text=True,
                timeout=self.timeout_seconds,
            )
        except FileNotFoundError as exc:
            raise OmrProcessingError("Audiveris executable is not installed on the server") from exc
        except subprocess.TimeoutExpired as exc:
            raise OmrProcessingError("Audiveris recognition timed out") from exc
        if completed.returncode != 0:
            raise OmrProcessingError(f"Audiveris recognition failed with exit code {completed.returncode}")

        candidates = sorted(output_dir.rglob("*.mxl"))
        candidates.extend(sorted(output_dir.rglob("*.musicxml")))
        if not candidates:
            candidates = [
                path for path in sorted(output_dir.rglob("*.xml")) if path.name.casefold() != "container.xml"
            ]
        if not candidates:
            raise OmrProcessingError("Audiveris did not export MusicXML")

        layouts = _measure_layouts(_read_musicxml(candidates[0]))
        return OmrDraftResult(
            regions=_regions_from_layouts(layouts),
            warnings=[
                "OMR은 보조용 초안입니다. 저장하기 전에 모든 마디를 확인하세요.",
                "단·페이지 구분은 Audiveris 결과이며 마디 사각형 좌표는 정규화된 추정값입니다.",
            ],
        )


class OmrDraftManager:
    def __init__(
        self,
        database: Database,
        storage: ObjectStorage,
        settings: Settings,
        processor: OmrProcessor | None = None,
    ) -> None:
        self.database = database
        self.storage = storage
        self.settings = settings
        self.processor = processor or AudiverisProcessor(settings)
        self.queue: asyncio.Queue[str] = asyncio.Queue()
        self.tasks: list[asyncio.Task[None]] = []
        self.recovery_tasks: set[asyncio.Task[None]] = set()

    def start(self) -> None:
        if not self.settings.omr_enabled or self.tasks:
            return
        stale_before = datetime.now(UTC) - self._claim_duration()
        with self.database.session_factory() as db:
            db.execute(
                update(OmrDraftJob)
                .where(
                    OmrDraftJob.status == "running",
                    OmrDraftJob.updated_at <= stale_before,
                )
                .values(status="pending", error=None)
            )
            pending = db.scalars(
                select(OmrDraftJob.id).where(OmrDraftJob.status == "pending").order_by(OmrDraftJob.created_at)
            ).all()
            active = db.execute(
                select(OmrDraftJob.id, OmrDraftJob.updated_at).where(OmrDraftJob.status == "running")
            ).all()
            db.commit()
        for job_id in pending:
            self.queue.put_nowait(job_id)
        for job_id, updated_at in active:
            self._schedule_recovery(job_id, updated_at)
        self.tasks = [
            asyncio.create_task(self._worker(), name=f"omr-worker-{index + 1}")
            for index in range(self.settings.omr_worker_count)
        ]

    async def stop(self) -> None:
        all_tasks = [*self.tasks, *self.recovery_tasks]
        for task in all_tasks:
            task.cancel()
        for task in all_tasks:
            with contextlib.suppress(asyncio.CancelledError):
                await task
        self.tasks.clear()
        self.recovery_tasks.clear()

    def submit(self, job_id: str) -> None:
        if not self.settings.omr_enabled:
            raise OmrProcessingError("OMR is disabled on this server")
        self.queue.put_nowait(job_id)

    async def _worker(self) -> None:
        while True:
            job_id = await self.queue.get()
            try:
                try:
                    await asyncio.to_thread(self._process_job, job_id)
                except Exception:
                    logger.exception("OMR worker could not update persistent job state")
                    self._schedule_recovery(job_id, datetime.now(UTC))
                    await asyncio.sleep(5)
                    self.queue.put_nowait(job_id)
            finally:
                self.queue.task_done()

    def _schedule_recovery(self, job_id: str, updated_at: datetime) -> None:
        claimed_at = updated_at.replace(tzinfo=UTC) if updated_at.tzinfo is None else updated_at
        remaining = max(
            0.0,
            (claimed_at + self._claim_duration() - datetime.now(UTC)).total_seconds(),
        )
        task = asyncio.create_task(
            self._recover_running_job(job_id, remaining),
            name=f"omr-recover-{job_id}",
        )
        self.recovery_tasks.add(task)
        task.add_done_callback(self.recovery_tasks.discard)

    async def _recover_running_job(self, job_id: str, delay_seconds: float) -> None:
        await asyncio.sleep(delay_seconds)
        stale_before = datetime.now(UTC) - self._claim_duration()
        with self.database.session_factory() as db:
            result = db.execute(
                update(OmrDraftJob)
                .where(
                    OmrDraftJob.id == job_id,
                    OmrDraftJob.status == "running",
                    OmrDraftJob.updated_at <= stale_before,
                )
                .values(status="pending", error=None)
            )
            recovered = getattr(result, "rowcount", 0) == 1
            db.commit()
        if recovered:
            self.queue.put_nowait(job_id)

    def _claim_duration(self) -> timedelta:
        # Audiveris is bounded by omr_timeout_seconds. The extra minute covers
        # object download and persistent result writes during rolling startup.
        return timedelta(seconds=self.settings.omr_timeout_seconds + 60)

    def _process_job(self, job_id: str) -> None:
        with self.database.session_factory() as db:
            claimed = db.execute(
                update(OmrDraftJob)
                .where(OmrDraftJob.id == job_id, OmrDraftJob.status == "pending")
                .values(status="running", error=None)
            )
            if getattr(claimed, "rowcount", 0) != 1:
                db.rollback()
                return
            job = db.get(OmrDraftJob, job_id)
            assert job is not None
            score = db.get(Score, job.score_id)
            if score is None or score.upload_status != "ready":
                job.status = "failed"
                job.error = "Score is missing or not ready"
                db.commit()
                return
            storage_key = score.storage_key
            filename = score.filename
            db.commit()

        try:
            with tempfile.TemporaryDirectory(prefix="fmr-omr-") as temporary:
                root = Path(temporary)
                source = root / Path(filename).name
                output = root / "output"
                output.mkdir()
                self.storage.download_to(storage_key, source)
                result = self.processor.process(source, output)
        except Exception as exc:
            message = (
                str(exc).strip()
                if isinstance(exc, OmrProcessingError)
                else "OMR processing failed while reading the score or object storage"
            )
            with self.database.session_factory() as db:
                job = db.get(OmrDraftJob, job_id)
                if job is not None:
                    job.status = "failed"
                    job.error = message[:500]
                    db.commit()
            return

        with self.database.session_factory() as db:
            job = db.get(OmrDraftJob, job_id)
            if job is None:
                return
            job.status = "succeeded"
            job.regions = result.regions
            job.warnings = result.warnings
            job.error = None
            db.commit()
