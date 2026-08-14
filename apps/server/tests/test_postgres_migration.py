from __future__ import annotations

import os
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from alembic.config import Config
from sqlalchemy import create_engine, delete, inspect

from alembic import command
from app.config import Settings
from app.db import Database
from app.models import Base, StorageDeletionJob, utcnow
from app.storage_lifecycle import StorageLifecycleWorker


def test_initial_migration_reaches_head_on_postgresql(monkeypatch: pytest.MonkeyPatch) -> None:
    database_url = os.environ.get("FMR_POSTGRES_TEST_URL")
    if not database_url:
        pytest.skip("FMR_POSTGRES_TEST_URL is not configured")

    server_root = Path(__file__).resolve().parents[1]
    monkeypatch.chdir(server_root)
    monkeypatch.setenv("FMR_ENVIRONMENT", "test")
    monkeypatch.setenv("FMR_DATABASE_URL", database_url)
    configuration = Config(str(server_root / "alembic.ini"))

    command.upgrade(configuration, "head")

    engine = create_engine(database_url)
    try:
        tables = set(inspect(engine).get_table_names())
        assert set(Base.metadata.tables) <= tables
        assert "alembic_version" in tables
    finally:
        engine.dispose()


def test_postgresql_workers_claim_disjoint_outbox_batches(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    database_url = os.environ.get("FMR_POSTGRES_TEST_URL")
    if not database_url:
        pytest.skip("FMR_POSTGRES_TEST_URL is not configured")

    server_root = Path(__file__).resolve().parents[1]
    monkeypatch.chdir(server_root)
    monkeypatch.setenv("FMR_ENVIRONMENT", "test")
    monkeypatch.setenv("FMR_DATABASE_URL", database_url)
    command.upgrade(Config(str(server_root / "alembic.ini")), "head")
    database = Database(database_url)
    marker = uuid.uuid4().hex
    keys = [f"scores/postgres-claim/{marker}/{index}.pdf" for index in range(10)]
    try:
        with database.session_factory() as db:
            db.add_all(
                [
                    StorageDeletionJob(
                        storage_key=key,
                        reason="postgres-claim-test",
                        status="pending",
                        attempt_count=0,
                        next_attempt_at=utcnow(),
                    )
                    for key in keys
                ]
            )
            db.commit()
        settings = Settings(
            environment="test",
            database_url=database_url,
            storage_worker_enabled=False,
            storage_delete_batch_size=5,
        )

        class NoopStorage:
            def delete(self, storage_key: str) -> None:
                del storage_key

        first = StorageLifecycleWorker(
            database,
            NoopStorage(),  # type: ignore[arg-type]
            settings,
            worker_id="postgres-worker-one",
        )
        second = StorageLifecycleWorker(
            database,
            NoopStorage(),  # type: ignore[arg-type]
            settings,
            worker_id="postgres-worker-two",
        )
        with ThreadPoolExecutor(max_workers=2) as executor:
            first_future = executor.submit(first.claim_due_deletions)
            second_future = executor.submit(second.claim_due_deletions)
        first_claims = first_future.result()
        second_claims = second_future.result()
        first_keys = {claim.storage_key for claim in first_claims}
        second_keys = {claim.storage_key for claim in second_claims}
        assert first_keys.isdisjoint(second_keys)
        assert first_keys | second_keys == set(keys)
    finally:
        with database.session_factory() as db:
            db.execute(delete(StorageDeletionJob).where(StorageDeletionJob.reason == "postgres-claim-test"))
            db.commit()
        database.dispose()
