from __future__ import annotations

from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app.db import Database
from app.main import create_app
from app.models import RefreshSession, User, utcnow
from app.security import hash_password
from app.sso import SSO_EDGE_IDENTITY_INVALID, SSO_ROLE_FORBIDDEN

from .conftest import FakeGoogleVerifier, FakeMailSender
from .test_auth import managed_sso_settings, sso_headers


@pytest.mark.parametrize(
    "groups",
    [
        "",
        "developer",
        "admin",
        "user,admin",
        "developer,user",
        "user,user",
        "user,unknown",
        "user,",
        "user,developer,admin,",
        "user,developer,admin,unknown",
        " user",
        "user ",
        "user, developer",
    ],
)
def test_sso_group_contract_fails_closed(
    settings,  # type: ignore[no-untyped-def]
    groups: str,
) -> None:
    with TestClient(
        create_app(
            managed_sso_settings(settings),
            google_verifier=FakeGoogleVerifier(),
            mail_sender=FakeMailSender(),
        )
    ) as client:
        response = client.post(
            "/api/auth/sso",
            headers=sso_headers("central-user", "user@example.com", groups=groups),
        )
    assert response.status_code == 401
    assert response.json()["detail"] == SSO_EDGE_IDENTITY_INVALID


def test_sso_roles_gate_aggregate_inventory_and_idempotent_cleanup(
    settings,  # type: ignore[no-untyped-def]
) -> None:
    with TestClient(
        create_app(
            managed_sso_settings(settings),
            google_verifier=FakeGoogleVerifier(),
            mail_sender=FakeMailSender(),
        )
    ) as client:
        admin_headers = sso_headers(
            "central-admin",
            "admin@example.com",
            groups="user,developer,admin",
        )
        exchange = client.post("/api/auth/sso", headers=admin_headers)
        assert exchange.status_code == 200, exchange.text
        bearer = {"Authorization": f"Bearer {exchange.json()['accessToken']}"}

        with client.app.state.database.session_factory() as db:
            legacy = User(
                email="legacy@example.com",
                display_name="Legacy",
                password_hash=hash_password("legacy-password"),
                google_subject="legacy-google-subject",
                email_verified_at=utcnow(),
                is_active=True,
            )
            db.add(legacy)
            db.flush()
            db.add_all(
                [
                    RefreshSession(
                        user_id=legacy.id,
                        token_hash=b"l" * 32,
                        expires_at=utcnow() + timedelta(days=1),
                    ),
                    RefreshSession(
                        user_id=exchange.json()["user"]["id"],
                        token_hash=b"s" * 32,
                        expires_at=utcnow() - timedelta(seconds=1),
                    ),
                ]
            )
            db.commit()

        denied = client.get(
            "/api/operations/auth-inventory",
            headers={**bearer, **sso_headers("central-admin", "admin@example.com")},
        )
        assert denied.status_code == 403
        assert denied.json()["detail"] == SSO_ROLE_FORBIDDEN

        developer_headers = {
            **bearer,
            **sso_headers(
                "central-admin",
                "admin@example.com",
                groups="user,developer",
            ),
        }
        inventory = client.get(
            "/api/operations/auth-inventory",
            headers=developer_headers,
        )
        assert inventory.status_code == 200, inventory.text
        assert inventory.json() == {
            "totalRefreshSessions": 3,
            "activeRefreshSessions": 2,
            "usersWithPassword": 1,
            "usersWithGoogleSubject": 1,
            "usersWithLegacyCredentials": 1,
            "linkedUsersWithLegacyCredentials": 0,
            "unlinkedUsersWithLegacyCredentials": 1,
            "legacyRefreshSessions": 1,
            "staleRefreshSessions": 1,
        }

        developer_cleanup = client.post(
            "/api/admin/auth-cleanup",
            headers=developer_headers,
            json={"confirmPurgeActiveRefreshSessions": True},
        )
        assert developer_cleanup.status_code == 403
        assert developer_cleanup.json()["detail"] == SSO_ROLE_FORBIDDEN

        unconfirmed_cleanup = client.post(
            "/api/admin/auth-cleanup",
            headers={**bearer, **admin_headers},
            json={"confirmPurgeActiveRefreshSessions": False},
        )
        assert unconfirmed_cleanup.status_code == 422

        cleanup = client.post(
            "/api/admin/auth-cleanup",
            headers={**bearer, **admin_headers},
            json={"confirmPurgeActiveRefreshSessions": True},
        )
        assert cleanup.status_code == 200, cleanup.text
        assert cleanup.json()["usersCleaned"] == 1
        assert cleanup.json()["refreshSessionsDeleted"] == 1
        assert cleanup.json()["staleRefreshSessionsDeleted"] == 1
        assert cleanup.json()["activeRefreshSessionsDeleted"] == 1

        repeated = client.post(
            "/api/admin/auth-cleanup",
            headers={**bearer, **admin_headers},
            json={"confirmPurgeActiveRefreshSessions": True},
        )
        assert repeated.status_code == 200, repeated.text
        assert repeated.json()["usersCleaned"] == 0
        assert repeated.json()["refreshSessionsDeleted"] == 0
        assert repeated.json()["staleRefreshSessionsDeleted"] == 0
        assert repeated.json()["activeRefreshSessionsDeleted"] == 0
        assert repeated.json()["inventoryBefore"]["totalRefreshSessions"] == 0
        assert repeated.json()["inventoryBefore"]["activeRefreshSessions"] == 0

        with client.app.state.database.session_factory() as db:
            legacy = db.scalar(select(User).where(User.email == "legacy@example.com"))
            assert legacy is not None
            assert legacy.password_hash is None
            assert legacy.google_subject is None
            assert legacy.auth_generation == 1
            assert db.scalar(select(func.count()).select_from(User)) == 2
            assert db.scalar(select(func.count()).select_from(RefreshSession)) == 0


def test_sso_startup_removes_legacy_credentials_and_stale_sessions(
    settings,  # type: ignore[no-untyped-def]
) -> None:
    database = Database(settings.database_url)
    database.create_schema()
    with database.session_factory() as db:
        legacy = User(
            email="startup-legacy@example.com",
            display_name="Startup legacy",
            password_hash=hash_password("startup-legacy-password"),
            google_subject="startup-legacy-google",
            email_verified_at=utcnow(),
            is_active=True,
        )
        clean = User(
            email="startup-sso@example.com",
            display_name="Startup SSO",
            password_hash=None,
            google_subject=None,
            sso_subject="startup-sso",
            email_verified_at=utcnow(),
            is_active=True,
        )
        db.add_all([legacy, clean])
        db.flush()
        clean_id = clean.id
        db.add_all(
            [
                RefreshSession(
                    user_id=legacy.id,
                    token_hash=b"a" * 32,
                    expires_at=utcnow() + timedelta(days=1),
                ),
                RefreshSession(
                    user_id=clean.id,
                    token_hash=b"b" * 32,
                    expires_at=utcnow() - timedelta(seconds=1),
                ),
                RefreshSession(
                    user_id=clean.id,
                    token_hash=b"c" * 32,
                    expires_at=utcnow() + timedelta(days=1),
                ),
            ]
        )
        db.commit()
    database.dispose()

    with TestClient(
        create_app(
            managed_sso_settings(settings),
            google_verifier=FakeGoogleVerifier(),
            mail_sender=FakeMailSender(),
        )
    ) as client:
        with client.app.state.database.session_factory() as db:
            legacy = db.scalar(select(User).where(User.email == "startup-legacy@example.com"))
            assert legacy is not None
            assert legacy.password_hash is None
            assert legacy.google_subject is None
            assert legacy.auth_generation == 1
            remaining = list(db.scalars(select(RefreshSession)).all())
            assert len(remaining) == 1
            assert remaining[0].user_id == clean_id
