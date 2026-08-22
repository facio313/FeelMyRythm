from __future__ import annotations

import os
from collections.abc import Iterator
from pathlib import Path
from threading import Condition
from typing import Any
from urllib.parse import parse_qs, urlsplit

import pytest
from fastapi.testclient import TestClient

# Unit tests exercise local authentication unless a test constructs an explicit SSO contract.
os.environ["PORTFOLIO_BRANCH"] = "test"
os.environ["PORTFOLIO_AUTH_MODE"] = "local"

from app.config import Settings
from app.mailer import AccountDeletionMessage, EmailVerificationMessage, PasswordResetMessage
from app.main import create_app
from app.security import GoogleIdentity


class FakeGoogleVerifier:
    identities: dict[str, GoogleIdentity]

    def __init__(self) -> None:
        self.identities = {
            "valid-google-token": GoogleIdentity(
                subject="google-subject-1",
                email="google@example.com",
                display_name="Google User",
                email_verified=True,
            ),
            "unverified-google-token": GoogleIdentity(
                subject="google-subject-2",
                email="unverified@example.com",
                display_name="Unverified",
                email_verified=False,
            ),
        }

    def verify(self, raw_token: str, client_id: str) -> GoogleIdentity:
        assert client_id == "test-google-client"
        return self.identities[raw_token]


class FakeMailSender:
    def __init__(self) -> None:
        self._delivered = Condition()
        self.messages: list[EmailVerificationMessage] = []
        self.password_reset_messages: list[PasswordResetMessage] = []
        self.account_deletion_messages: list[AccountDeletionMessage] = []

    def send_email_verification(self, message: EmailVerificationMessage) -> None:
        with self._delivered:
            self.messages.append(message)
            self._delivered.notify_all()

    def send_password_reset(self, message: PasswordResetMessage) -> None:
        with self._delivered:
            self.password_reset_messages.append(message)
            self._delivered.notify_all()

    def send_account_deletion(self, message: AccountDeletionMessage) -> None:
        with self._delivered:
            self.account_deletion_messages.append(message)
            self._delivered.notify_all()

    def latest_token_for(self, email: str) -> str:
        normalized = email.casefold()
        with self._delivered:
            delivered = self._delivered.wait_for(
                lambda: any(item.recipient == normalized for item in self.messages),
                timeout=2,
            )
            assert delivered, "verification email was not delivered before the test deadline"
            message = next(item for item in reversed(self.messages) if item.recipient == normalized)
        token = parse_qs(urlsplit(message.verification_url).fragment)["verificationToken"][0]
        assert token
        return token

    def latest_password_reset_token_for(self, email: str) -> str:
        normalized = email.casefold()
        with self._delivered:
            delivered = self._delivered.wait_for(
                lambda: any(item.recipient == normalized for item in self.password_reset_messages),
                timeout=2,
            )
            assert delivered, "password reset email was not delivered before the test deadline"
            message = next(
                item for item in reversed(self.password_reset_messages) if item.recipient == normalized
            )
        token = parse_qs(urlsplit(message.reset_url).fragment)["passwordResetToken"][0]
        assert token
        return token

    def latest_account_delete_token_for(self, email: str) -> str:
        normalized = email.casefold()
        with self._delivered:
            delivered = self._delivered.wait_for(
                lambda: any(item.recipient == normalized for item in self.account_deletion_messages),
                timeout=2,
            )
            assert delivered, "account deletion email was not delivered before the test deadline"
            message = next(
                item for item in reversed(self.account_deletion_messages) if item.recipient == normalized
            )
        token = parse_qs(urlsplit(message.deletion_url).fragment)["accountDeleteToken"][0]
        assert token
        return token


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return Settings(
        environment="test",
        database_url=f"sqlite:///{tmp_path / 'test.db'}",
        auto_create_schema=True,
        jwt_secret="test-secret-generated-for-tests-only-at-runtime-123456789",
        google_client_id="test-google-client",
        public_api_base_url="http://testserver",
        local_uploads_dir=tmp_path / "uploads",
        storage_worker_enabled=False,
        room_lead_time_ms=250,
        room_ttl_seconds=60,
        room_cleanup_interval_seconds=60,
    )


@pytest.fixture
def mail_sender() -> FakeMailSender:
    return FakeMailSender()


@pytest.fixture
def client(settings: Settings, mail_sender: FakeMailSender) -> Iterator[TestClient]:
    with TestClient(
        create_app(
            settings,
            google_verifier=FakeGoogleVerifier(),
            mail_sender=mail_sender,
        )
    ) as test_client:
        yield test_client


def register(client: TestClient, email: str, display_name: str | None = None) -> dict[str, Any]:
    response = client.post(
        "/api/auth/register",
        json={
            "email": email,
            "displayName": display_name or email.split("@", 1)[0],
        },
    )
    assert response.status_code == 201, response.text
    sender = client.app.state.mail_sender
    assert isinstance(sender, FakeMailSender)
    verification = client.post(
        "/api/auth/verify-email",
        json={
            "token": sender.latest_token_for(email.strip().casefold()),
            "password": "correct-horse-battery-staple",
            "passwordConfirmation": "correct-horse-battery-staple",
        },
    )
    assert verification.status_code == 200, verification.text
    return verification.json()


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def ensemble(client: TestClient) -> dict[str, Any]:
    owner = register(client, "owner@example.com", "Owner")
    leader = register(client, "leader@example.com", "Leader")
    member = register(client, "member@example.com", "Member")
    outsider = register(client, "outsider@example.com", "Outsider")
    owner_headers = auth(owner["accessToken"])
    group = client.post(
        "/api/groups",
        headers=owner_headers,
        json={"name": "Quartet", "description": "String quartet"},
    ).json()
    for identity, role in ((leader, "leader"), (member, "member")):
        response = client.post(
            f"/api/groups/{group['id']}/members",
            headers=owner_headers,
            json={"email": identity["user"]["email"], "role": role},
        )
        assert response.status_code == 201, response.text
    project_response = client.post(
        f"/api/groups/{group['id']}/projects",
        headers=auth(leader["accessToken"]),
        json={"name": "Autumn Concert", "description": ""},
    )
    assert project_response.status_code == 201, project_response.text
    project = project_response.json()
    repertoire_response = client.post(
        f"/api/projects/{project['id']}/repertoire",
        headers=auth(leader["accessToken"]),
        json={"title": "Symphony", "composer": "Composer", "notes": ""},
    )
    assert repertoire_response.status_code == 201, repertoire_response.text
    return {
        "owner": owner,
        "leader": leader,
        "member": member,
        "outsider": outsider,
        "group": group,
        "project": project,
        "repertoire": repertoire_response.json(),
    }


def tempo_map(
    repertoire_id: str,
    revision: int = 0,
    total_measures: int = 32,
) -> dict[str, Any]:
    return {
        "id": "client-draft",
        "repertoireItemId": repertoire_id,
        "revision": revision,
        "totalMeasures": total_measures,
        "sections": [
            {
                "id": "section-1",
                "startMeasure": 1,
                "endMeasure": total_measures,
                "timeSignature": {"num": 4, "denom": 4},
                "bpm": 100,
                "beatUnit": "quarter",
            }
        ],
        "jumps": [],
        "countIn": {"measures": 1, "useSectionMeter": True},
    }
