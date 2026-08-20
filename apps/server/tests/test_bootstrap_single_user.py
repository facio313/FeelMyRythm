from __future__ import annotations

from pathlib import Path

import pytest
from pydantic import SecretStr
from sqlalchemy import select

from app.config import Settings
from app.db import Base, Database
from app.models import User
from app.security import verify_password
from scripts.bootstrap_single_user import BootstrapError, bootstrap_single_user


def single_user_settings(tmp_path: Path) -> Settings:
    database_url = f"sqlite:///{tmp_path / 'bootstrap.db'}"
    database = Database(database_url)
    Base.metadata.create_all(database.engine)
    database.dispose()
    return Settings(
        environment="test",
        deployment_profile="managed_local_sso",
        sso_enabled=True,
        sso_edge_secret=SecretStr("test-fmr-edge-secret-with-at-least-32-characters"),
        database_url=database_url,
        jwt_secret="test-secret-generated-for-bootstrap-tests-123456789",
        local_uploads_dir=tmp_path / "uploads",
        storage_worker_enabled=False,
    ).model_copy(update={"environment": "production"})


def test_bootstrap_creates_and_resets_the_only_active_account(tmp_path: Path) -> None:
    settings = single_user_settings(tmp_path)

    created = bootstrap_single_user(
        settings,
        email=" Owner@Example.COM ",
        display_name="Owner",
        password="first-temporary-password",
    )
    assert created.created is True
    assert created.email == "owner@example.com"

    reset = bootstrap_single_user(
        settings,
        email="owner@example.com",
        display_name="Temporary Owner",
        password="second-temporary-password",
    )
    assert reset.created is False

    database = Database(settings.database_url)
    try:
        with database.session_factory() as session:
            users = list(session.scalars(select(User).where(User.is_active.is_(True))))
            assert len(users) == 1
            assert users[0].display_name == "Temporary Owner"
            assert users[0].email_verified_at is not None
            assert verify_password("second-temporary-password", users[0].password_hash)
            assert not verify_password("first-temporary-password", users[0].password_hash)
    finally:
        database.dispose()


def test_bootstrap_refuses_a_second_active_identity(tmp_path: Path) -> None:
    settings = single_user_settings(tmp_path)
    bootstrap_single_user(
        settings,
        email="owner@example.com",
        display_name="Owner",
        password="first-temporary-password",
    )

    with pytest.raises(BootstrapError, match="another active account"):
        bootstrap_single_user(
            settings,
            email="other@example.com",
            display_name="Other",
            password="other-temporary-password",
        )


def test_bootstrap_refuses_to_reintroduce_a_password_after_sso_link(tmp_path: Path) -> None:
    settings = single_user_settings(tmp_path)
    bootstrap_single_user(
        settings,
        email="owner@example.com",
        display_name="Owner",
        password="initial-owner-password",
    )
    database = Database(settings.database_url)
    try:
        with database.session_factory.begin() as session:
            owner = session.scalar(select(User).where(User.email == "owner@example.com"))
            assert owner is not None
            owner.sso_subject = "central-owner"
        with pytest.raises(BootstrapError, match="already linked"):
            bootstrap_single_user(
                settings,
                email="owner@example.com",
                display_name="Owner",
                password="replacement-owner-password",
            )
    finally:
        database.dispose()
