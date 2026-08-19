from __future__ import annotations

import os
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from alembic.config import Config
from sqlalchemy import create_engine, delete, inspect, text
from sqlalchemy.engine import make_url

from alembic import command
from app.config import Settings
from app.db import Database
from app.models import Base, StorageDeletionJob, utcnow
from app.storage_lifecycle import StorageLifecycleWorker


def _create_legacy_database(database_url: str) -> tuple[str, str]:
    parsed = make_url(database_url)
    database_name = f"fmr_legacy_{uuid.uuid4().hex}"
    admin_engine = create_engine(
        parsed.set(database="postgres"),
        isolation_level="AUTOCOMMIT",
    )
    try:
        with admin_engine.connect() as connection:
            connection.exec_driver_sql(f'CREATE DATABASE "{database_name}"')
    finally:
        admin_engine.dispose()
    return (
        parsed.set(database=database_name).render_as_string(hide_password=False),
        database_name,
    )


def _drop_temporary_database(database_url: str, database_name: str) -> None:
    parsed = make_url(database_url)
    admin_engine = create_engine(
        parsed.set(database="postgres"),
        isolation_level="AUTOCOMMIT",
    )
    try:
        with admin_engine.connect() as connection:
            connection.execute(
                text(
                    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
                    "WHERE datname = :database_name AND pid <> pg_backend_pid()"
                ),
                {"database_name": database_name},
            )
            connection.exec_driver_sql(f'DROP DATABASE IF EXISTS "{database_name}"')
    finally:
        admin_engine.dispose()


def _seed_pre_alembic_schema(database_url: str) -> None:
    statements = (
        """
        CREATE TABLE users (
            id VARCHAR(32) PRIMARY KEY,
            email VARCHAR(255) NOT NULL UNIQUE,
            password_hash VARCHAR(128) NOT NULL,
            display_name VARCHAR(64) NOT NULL,
            created_at TIMESTAMPTZ NOT NULL
        )
        """,
        """
        CREATE TABLE groups (
            id VARCHAR(32) PRIMARY KEY,
            name VARCHAR(128) NOT NULL,
            owner_id VARCHAR(32) NOT NULL REFERENCES users(id)
        )
        """,
        """
        CREATE TABLE group_members (
            group_id VARCHAR(32) NOT NULL REFERENCES groups(id),
            user_id VARCHAR(32) NOT NULL REFERENCES users(id),
            role VARCHAR(16) NOT NULL,
            PRIMARY KEY (group_id, user_id)
        )
        """,
        """
        CREATE TABLE projects (
            id VARCHAR(32) PRIMARY KEY,
            group_id VARCHAR(32) NOT NULL REFERENCES groups(id),
            name VARCHAR(128) NOT NULL,
            description TEXT NOT NULL
        )
        """,
        """
        CREATE TABLE repertoire_items (
            id VARCHAR(32) PRIMARY KEY,
            project_id VARCHAR(32) NOT NULL REFERENCES projects(id),
            title VARCHAR(255) NOT NULL,
            composer VARCHAR(128) NOT NULL
        )
        """,
        """
        CREATE TABLE tempo_maps (
            id VARCHAR(32) PRIMARY KEY,
            repertoire_id VARCHAR(32) NOT NULL UNIQUE REFERENCES repertoire_items(id),
            revision INTEGER NOT NULL,
            data JSON NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL
        )
        """,
        """
        CREATE TABLE scores (
            id VARCHAR(32) PRIMARY KEY,
            repertoire_id VARCHAR(32) NOT NULL REFERENCES repertoire_items(id),
            kind VARCHAR(8) NOT NULL,
            instrument VARCHAR(64) NOT NULL,
            filename VARCHAR(255) NOT NULL,
            stored_name VARCHAR(64) NOT NULL,
            content_type VARCHAR(128) NOT NULL,
            measure_map JSON,
            measure_number_offset INTEGER NOT NULL
        )
        """,
        """
        CREATE TABLE annotations (
            id VARCHAR(32) PRIMARY KEY,
            score_id VARCHAR(32) NOT NULL REFERENCES scores(id),
            user_id VARCHAR(32) NOT NULL REFERENCES users(id),
            scope VARCHAR(16) NOT NULL,
            data JSON NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL,
            UNIQUE (score_id, user_id, scope)
        )
        """,
        """
        CREATE TABLE practice_logs (
            id VARCHAR(32) PRIMARY KEY,
            repertoire_id VARCHAR(32) NOT NULL REFERENCES repertoire_items(id),
            user_id VARCHAR(32) NOT NULL REFERENCES users(id),
            content TEXT NOT NULL,
            anchors JSON NOT NULL,
            created_at TIMESTAMPTZ NOT NULL
        )
        """,
        """
        CREATE TABLE todos (
            id VARCHAR(32) PRIMARY KEY,
            repertoire_id VARCHAR(32) NOT NULL REFERENCES repertoire_items(id),
            content TEXT NOT NULL,
            assignee VARCHAR(64) NOT NULL,
            done BOOLEAN NOT NULL
        )
        """,
        """
        CREATE TABLE device_calibrations (
            id VARCHAR(32) PRIMARY KEY,
            user_id VARCHAR(32) NOT NULL REFERENCES users(id),
            device_label VARCHAR(128) NOT NULL,
            output_label VARCHAR(128) NOT NULL,
            offset_ms INTEGER NOT NULL,
            UNIQUE (user_id, device_label, output_label)
        )
        """,
        """
        INSERT INTO users VALUES (
            'uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu',
            'legacy@example.com',
            'legacy-password-hash',
            'Legacy user',
            CURRENT_TIMESTAMP
        )
        """,
        """
        INSERT INTO groups VALUES (
            'gggggggggggggggggggggggggggggggg',
            'Legacy group',
            'uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu'
        )
        """,
        """
        INSERT INTO group_members VALUES (
            'gggggggggggggggggggggggggggggggg',
            'uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu',
            'member'
        )
        """,
        """
        INSERT INTO projects VALUES (
            'pppppppppppppppppppppppppppppppp',
            'gggggggggggggggggggggggggggggggg',
            'Legacy project',
            'Preserved description'
        )
        """,
        """
        INSERT INTO repertoire_items VALUES (
            'rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr',
            'pppppppppppppppppppppppppppppppp',
            'Legacy piece',
            'Legacy composer'
        )
        """,
        """
        INSERT INTO tempo_maps VALUES (
            'tttttttttttttttttttttttttttttttt',
            'rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr',
            3,
            '{"segments": []}'::json,
            CURRENT_TIMESTAMP
        )
        """,
        """
        INSERT INTO scores VALUES (
            'ssssssssssssssssssssssssssssssss',
            'rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr',
            'full',
            'Orchestra',
            'legacy.pdf',
            'stored-legacy.pdf',
            'application/pdf',
            '[{"measure": 1}]'::json,
            4
        )
        """,
        """
        INSERT INTO annotations VALUES (
            'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            'ssssssssssssssssssssssssssssssss',
            'uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu',
            'private',
            '{"strokes": []}'::json,
            CURRENT_TIMESTAMP
        )
        """,
        """
        INSERT INTO practice_logs VALUES (
            'llllllllllllllllllllllllllllllll',
            'rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr',
            'uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu',
            'Preserved practice log',
            '[]'::json,
            CURRENT_TIMESTAMP
        )
        """,
        """
        INSERT INTO todos VALUES (
            'oooooooooooooooooooooooooooooooo',
            'rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr',
            'Preserved todo',
            'Legacy user',
            FALSE
        )
        """,
        """
        INSERT INTO device_calibrations VALUES (
            'cccccccccccccccccccccccccccccccc',
            'uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu',
            'legacy-device',
            'default',
            7
        )
        """,
    )
    engine = create_engine(database_url)
    try:
        with engine.begin() as connection:
            for statement in statements:
                connection.exec_driver_sql(statement)
    finally:
        engine.dispose()


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


def test_pre_alembic_production_schema_is_migrated_without_losing_rows(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    database_url = os.environ.get("FMR_POSTGRES_TEST_URL")
    if not database_url:
        pytest.skip("FMR_POSTGRES_TEST_URL is not configured")

    legacy_url, database_name = _create_legacy_database(database_url)
    server_root = Path(__file__).resolve().parents[1]
    try:
        _seed_pre_alembic_schema(legacy_url)
        monkeypatch.chdir(server_root)
        monkeypatch.setenv("FMR_ENVIRONMENT", "test")
        monkeypatch.setenv("FMR_DATABASE_URL", legacy_url)
        command.upgrade(Config(str(server_root / "alembic.ini")), "head")

        engine = create_engine(legacy_url)
        try:
            database_inspector = inspect(engine)
            assert set(Base.metadata.tables) <= set(database_inspector.get_table_names())
            assert "fmr_legacy" not in database_inspector.get_schema_names()
            with engine.connect() as connection:
                assert connection.scalar(text("SELECT COUNT(*) FROM users")) == 1
                assert connection.scalar(text("SELECT COUNT(*) FROM groups")) == 1
                assert connection.scalar(text("SELECT COUNT(*) FROM group_members")) == 1
                assert connection.scalar(text("SELECT role FROM group_members")) == "owner"
                assert connection.scalar(text("SELECT revision FROM tempo_map_revisions")) == 3
                assert connection.scalar(text("SELECT COUNT(*) FROM scores")) == 1
                assert connection.scalar(text("SELECT storage_key FROM scores")) == ("stored-legacy.pdf")
                assert connection.scalar(text("SELECT measure_number_offset FROM measure_maps")) == 4
                assert connection.scalar(text("SELECT COUNT(*) FROM annotations")) == 1
                assert connection.scalar(text("SELECT content FROM practice_logs")) == (
                    "Preserved practice log"
                )
                assert connection.scalar(text("SELECT content FROM todos")) == "Preserved todo"
                assert connection.scalar(text("SELECT device_fingerprint FROM device_calibrations")) == (
                    "legacy-device"
                )
                assert connection.scalar(text("SELECT password_hash FROM users")) is None
        finally:
            engine.dispose()
    finally:
        _drop_temporary_database(database_url, database_name)


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
