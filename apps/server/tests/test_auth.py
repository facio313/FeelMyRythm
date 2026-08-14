from __future__ import annotations

import hashlib
from datetime import timedelta
from threading import Event, Thread

import pytest
from fastapi.testclient import TestClient
from httpx import Response
from sqlalchemy import func, select

from app.config import Settings
from app.mailer import EmailVerificationMessage, MailDeliveryError, MailDeliveryManager
from app.main import create_app
from app.models import RefreshSession, User, utcnow
from app.security import (
    DUMMY_PASSWORD_HASH,
    GoogleIdentity,
    PasswordVerificationBusy,
    PasswordVerifier,
    _jwt_encode,
    hash_password,
    verify_password,
)

from .conftest import FakeGoogleVerifier, FakeMailSender, auth, register


def test_health_email_auth_refresh_rotation_and_logout(client: TestClient) -> None:
    assert client.get("/api/health").json() == {"ok": True}
    tokens = register(client, "  Musician@Example.COM  ", "Musician")
    assert tokens["tokenType"] == "bearer"
    assert tokens["expiresIn"] > 0
    assert tokens["user"]["email"] == "musician@example.com"

    duplicate = client.post(
        "/api/auth/register",
        json={
            "email": "musician@example.com",
            "displayName": "Duplicate",
        },
    )
    assert duplicate.status_code == 201
    assert (
        client.post(
            "/api/auth/login",
            json={"email": "musician@example.com", "password": "wrong-password"},
        ).status_code
        == 401
    )

    login = client.post(
        "/api/auth/login",
        json={"email": "MUSICIAN@example.com", "password": "correct-horse-battery-staple"},
    )
    assert login.status_code == 200
    me = client.get("/api/users/me", headers=auth(login.json()["accessToken"]))
    assert me.json()["displayName"] == "Musician"

    old_refresh = tokens["refreshToken"]
    rotated = client.post("/api/auth/refresh", json={"refreshToken": old_refresh})
    assert rotated.status_code == 200
    assert rotated.json()["refreshToken"] != old_refresh
    assert client.post("/api/auth/refresh", json={"refreshToken": old_refresh}).status_code == 401
    new_refresh = rotated.json()["refreshToken"]
    assert client.post("/api/auth/logout", json={"refreshToken": new_refresh}).status_code == 200
    assert client.post("/api/auth/refresh", json={"refreshToken": new_refresh}).status_code == 401


def test_google_verifier_adapter_and_verified_email_gate(client: TestClient) -> None:
    response = client.post("/api/auth/google", json={"idToken": "valid-google-token"})
    assert response.status_code == 200
    assert response.json()["user"]["email"] == "google@example.com"
    again = client.post("/api/auth/google", json={"idToken": "valid-google-token"})
    assert again.status_code == 200
    assert again.json()["user"]["id"] == response.json()["user"]["id"]
    assert client.post("/api/auth/google", json={"idToken": "unverified-google-token"}).status_code == 401


def test_login_runs_unknown_unverified_and_passwordless_accounts_through_fixed_cost_check(
    client: TestClient,
) -> None:
    verified = register(client, "verified-login@example.com")
    pending = client.post(
        "/api/auth/register",
        json={"email": "pending-login@example.com", "displayName": "Pending"},
    )
    assert pending.status_code == 201
    google = client.post("/api/auth/google", json={"idToken": "valid-google-token"})
    assert google.status_code == 200

    class RecordingPasswordVerifier:
        def __init__(self) -> None:
            self.hashes: list[str | None] = []

        def verify(self, password: str, password_hash: str | None) -> bool:
            assert password == "wrong-password"
            self.hashes.append(password_hash)
            return False

    recorder = RecordingPasswordVerifier()
    client.app.state.password_verifier = recorder
    responses = [
        client.post(
            "/api/auth/login",
            json={"email": "missing-login@example.com", "password": "wrong-password"},
        ),
        client.post(
            "/api/auth/login",
            json={"email": verified["user"]["email"], "password": "wrong-password"},
        ),
        client.post(
            "/api/auth/login",
            json={"email": "pending-login@example.com", "password": "wrong-password"},
        ),
        client.post(
            "/api/auth/login",
            json={"email": google.json()["user"]["email"], "password": "wrong-password"},
        ),
    ]

    assert [response.status_code for response in responses] == [401, 401, 403, 401]
    assert len(recorder.hashes) == 4
    assert recorder.hashes[0] is None
    assert recorder.hashes[1] is not None
    assert recorder.hashes[2:] == [None, None]


def test_password_verifier_uses_dummy_bcrypt_and_bounds_concurrency(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured_hashes: list[str | None] = []

    def record_password_hash(_password: str, password_hash: str | None) -> bool:
        captured_hashes.append(password_hash)
        return False

    monkeypatch.setattr("app.security.verify_password", record_password_hash)
    assert PasswordVerifier(1).verify("unknown", None) is False
    assert captured_hashes == [DUMMY_PASSWORD_HASH]

    started = Event()
    release = Event()

    def blocking_verify(_password: str, _password_hash: str | None) -> bool:
        started.set()
        release.wait(timeout=2)
        return False

    monkeypatch.setattr("app.security.verify_password", blocking_verify)
    verifier = PasswordVerifier(1)
    worker = Thread(target=lambda: verifier.verify("first", None))
    worker.start()
    assert started.wait(timeout=1)
    with pytest.raises(PasswordVerificationBusy):
        verifier.verify("second", None)
    release.set()
    worker.join(timeout=2)


def test_login_returns_generic_retry_when_bcrypt_slots_are_full(client: TestClient) -> None:
    class BusyPasswordVerifier:
        def verify(self, _password: str, _password_hash: str | None) -> bool:
            raise PasswordVerificationBusy

    client.app.state.password_verifier = BusyPasswordVerifier()
    response = client.post(
        "/api/auth/login",
        json={"email": "anyone@example.com", "password": "wrong-password"},
    )

    assert response.status_code == 429
    assert response.headers["Retry-After"] == "1"
    assert response.json() == {"detail": "login is temporarily busy"}


def test_access_token_is_required_and_refresh_token_cannot_authorize(client: TestClient) -> None:
    tokens = register(client, "types@example.com")
    assert client.get("/api/users/me").status_code == 401
    assert client.get("/api/users/me", headers=auth(tokens["refreshToken"])).status_code == 401


def test_registration_stores_no_password_or_session_until_mailbox_owner_completes(
    client: TestClient,
    mail_sender: FakeMailSender,
) -> None:
    pending = client.post(
        "/api/auth/register",
        json={
            "email": "Pending@Example.com",
            "displayName": "Pending",
        },
    )
    assert pending.status_code == 201
    assert pending.json()["email"] == "pending@example.com"
    assert "accessToken" not in pending.json()
    assert "refreshToken" not in pending.json()

    blocked_login = client.post(
        "/api/auth/login",
        json={"email": "pending@example.com", "password": "correct-horse-battery-staple"},
    )
    assert blocked_login.status_code == 403
    assert blocked_login.json()["detail"]["code"] == "EMAIL_VERIFICATION_REQUIRED"

    verification_token = mail_sender.latest_token_for("pending@example.com")
    assert client.get("/api/users/me", headers=auth(verification_token)).status_code == 401
    with client.app.state.database.session_factory() as db:
        pending_user = db.scalar(select(User).where(User.email == "pending@example.com"))
        assert pending_user is not None and pending_user.password_hash is None
        # Simulate a row created by the vulnerable legacy registration flow.
        pending_user.password_hash = hash_password("attacker-preclaim-password")
        db.commit()

    verified = client.post(
        "/api/auth/verify-email",
        json={
            "token": verification_token,
            "password": "owner-chosen-password",
            "passwordConfirmation": "owner-chosen-password",
        },
    )
    assert verified.status_code == 200
    assert verified.json()["user"]["emailVerifiedAt"] is not None
    assert (
        client.get(
            "/api/users/me",
            headers=auth(verified.json()["accessToken"]),
        ).status_code
        == 200
    )
    with client.app.state.database.session_factory() as db:
        completed = db.scalar(select(User).where(User.email == "pending@example.com"))
        assert completed is not None
        assert verify_password("owner-chosen-password", completed.password_hash)
        assert not verify_password("attacker-preclaim-password", completed.password_hash)
    assert (
        client.post(
            "/api/auth/verify-email",
            json={
                "token": verification_token,
                "password": "another-password",
                "passwordConfirmation": "another-password",
            },
        ).status_code
        == 400
    )
    assert (
        client.post(
            "/api/auth/verify-email",
            json={
                "token": verified.json()["accessToken"],
                "password": "another-password",
                "passwordConfirmation": "another-password",
            },
        ).status_code
        == 400
    )


def test_expired_email_verification_token_is_rejected(
    client: TestClient,
    settings: Settings,
) -> None:
    client.post(
        "/api/auth/register",
        json={
            "email": "expired@example.com",
            "displayName": "Expired",
        },
    )
    with client.app.state.database.session_factory() as db:
        user = db.scalar(select(User).where(User.email == "expired@example.com"))
        assert user is not None
        expired = _jwt_encode(
            settings,
            subject=user.id,
            token_type="email_verification",
            expires_at=utcnow() - timedelta(seconds=1),
            jti="expired-verification-token",
            extra_claims={"email": user.email},
        )
    response = client.post(
        "/api/auth/verify-email",
        json={
            "token": expired,
            "password": "owner-chosen-password",
            "passwordConfirmation": "owner-chosen-password",
        },
    )
    assert response.status_code == 400


def test_registration_completion_validates_password_and_confirmation(
    client: TestClient,
    mail_sender: FakeMailSender,
) -> None:
    legacy_shape = client.post(
        "/api/auth/register",
        json={
            "email": "legacy-shape@example.com",
            "displayName": "Legacy",
            "password": "must-not-be-accepted-here",
        },
    )
    assert legacy_shape.status_code == 422

    pending = client.post(
        "/api/auth/register",
        json={"email": "validation@example.com", "displayName": "Validation"},
    )
    assert pending.status_code == 201
    token = mail_sender.latest_token_for("validation@example.com")
    short = client.post(
        "/api/auth/verify-email",
        json={"token": token, "password": "short", "passwordConfirmation": "short"},
    )
    mismatch = client.post(
        "/api/auth/verify-email",
        json={
            "token": token,
            "password": "first-valid-password",
            "passwordConfirmation": "second-valid-password",
        },
    )
    assert short.status_code == mismatch.status_code == 422
    with client.app.state.database.session_factory() as db:
        user = db.scalar(select(User).where(User.email == "validation@example.com"))
        assert user is not None
        assert user.email_verified_at is None
        assert user.password_hash is None


def test_resend_is_generic_and_persistently_rate_limited(
    client: TestClient,
    settings: Settings,
    mail_sender: FakeMailSender,
) -> None:
    response = client.post(
        "/api/auth/register",
        json={
            "email": "resend@example.com",
            "displayName": "Resend",
        },
    )
    assert response.status_code == 201
    assert response.headers["Retry-After"] == str(settings.email_verification_resend_seconds)
    assert client.app.state.mail_delivery_manager.wait_until_idle(2)
    assert len(mail_sender.messages) == 1
    first_token = mail_sender.latest_token_for("resend@example.com")

    immediate = client.post(
        "/api/auth/resend-verification",
        json={"email": "RESEND@example.com"},
    )
    assert immediate.status_code == 202
    assert immediate.headers["Retry-After"] == str(settings.email_verification_resend_seconds)
    assert len(mail_sender.messages) == 1

    with client.app.state.database.session_factory() as db:
        user = db.scalar(select(User).where(User.email == "resend@example.com"))
        assert user is not None
        user.email_verification_sent_at = utcnow() - timedelta(
            seconds=settings.email_verification_resend_seconds + 1
        )
        db.commit()

    resent = client.post(
        "/api/auth/resend-verification",
        json={"email": "resend@example.com"},
    )
    unknown = client.post(
        "/api/auth/resend-verification",
        json={"email": "missing@example.com"},
    )
    assert resent.status_code == unknown.status_code == 202
    assert resent.json() == unknown.json()
    assert client.app.state.mail_delivery_manager.wait_until_idle(2)
    assert len(mail_sender.messages) == 2
    replacement_token = mail_sender.latest_token_for("resend@example.com")
    assert replacement_token != first_token
    stale = client.post(
        "/api/auth/verify-email",
        json={
            "token": first_token,
            "password": "owner-password-after-resend",
            "passwordConfirmation": "owner-password-after-resend",
        },
    )
    assert stale.status_code == 400
    completed = client.post(
        "/api/auth/verify-email",
        json={
            "token": replacement_token,
            "password": "owner-password-after-resend",
            "passwordConfirmation": "owner-password-after-resend",
        },
    )
    assert completed.status_code == 200


def test_password_reset_is_generic_one_time_and_invalidates_existing_sessions(
    client: TestClient,
    settings: Settings,
    mail_sender: FakeMailSender,
) -> None:
    tokens = register(client, "reset@example.com", "Reset")
    unknown = client.post(
        "/api/auth/request-password-reset",
        json={"email": "missing@example.com"},
    )
    requested = client.post(
        "/api/auth/request-password-reset",
        json={"email": "RESET@example.com"},
    )
    assert requested.status_code == unknown.status_code == 202
    assert requested.json() == unknown.json()
    assert requested.headers["Retry-After"] == str(settings.password_reset_request_seconds)
    assert client.app.state.mail_delivery_manager.wait_until_idle(2)
    assert len(mail_sender.password_reset_messages) == 1
    repeated = client.post(
        "/api/auth/request-password-reset",
        json={"email": "reset@example.com"},
    )
    assert repeated.status_code == 202
    assert len(mail_sender.password_reset_messages) == 1

    reset_token = mail_sender.latest_password_reset_token_for("reset@example.com")
    mismatch = client.post(
        "/api/auth/reset-password",
        json={
            "token": reset_token,
            "password": "new-owner-password",
            "passwordConfirmation": "different-password",
        },
    )
    assert mismatch.status_code == 422
    completed = client.post(
        "/api/auth/reset-password",
        json={
            "token": reset_token,
            "password": "new-owner-password",
            "passwordConfirmation": "new-owner-password",
        },
    )
    assert completed.status_code == 200
    assert client.get("/api/users/me", headers=auth(tokens["accessToken"])).status_code == 401
    assert (
        client.post(
            "/api/auth/refresh",
            json={"refreshToken": tokens["refreshToken"]},
        ).status_code
        == 401
    )
    assert (
        client.post(
            "/api/auth/login",
            json={"email": "reset@example.com", "password": "correct-horse-battery-staple"},
        ).status_code
        == 401
    )
    assert (
        client.post(
            "/api/auth/login",
            json={"email": "reset@example.com", "password": "new-owner-password"},
        ).status_code
        == 200
    )
    assert (
        client.post(
            "/api/auth/reset-password",
            json={
                "token": reset_token,
                "password": "replay-password",
                "passwordConfirmation": "replay-password",
            },
        ).status_code
        == 400
    )


def test_password_reset_smtp_failure_is_generic_and_throttled(
    client: TestClient,
    settings: Settings,
) -> None:
    register(client, "reset-timeout@example.com")

    class FailingResetSender:
        attempts = 0

        def send_password_reset(self, message: object) -> None:
            self.attempts += 1
            raise MailDeliveryError(f"timeout: {message!r}")

    sender = FailingResetSender()
    original_manager = client.app.state.mail_delivery_manager
    replacement = MailDeliveryManager(sender, worker_count=1, queue_capacity=4)
    replacement.start()
    client.app.state.mail_delivery_manager = replacement
    try:
        first = client.post(
            "/api/auth/request-password-reset",
            json={"email": "reset-timeout@example.com"},
        )
        second = client.post(
            "/api/auth/request-password-reset",
            json={"email": "reset-timeout@example.com"},
        )
        assert first.status_code == second.status_code == 202
        assert first.json() == second.json()
        assert first.headers["Retry-After"] == str(settings.password_reset_request_seconds)
        assert replacement.wait_until_idle(2)
        assert sender.attempts == 1
    finally:
        replacement.close(2)
        client.app.state.mail_delivery_manager = original_manager


def test_google_only_account_does_not_receive_password_reset_email(
    client: TestClient,
    mail_sender: FakeMailSender,
) -> None:
    assert client.post("/api/auth/google", json={"idToken": "valid-google-token"}).status_code == 200
    response = client.post(
        "/api/auth/request-password-reset",
        json={"email": "google@example.com"},
    )
    assert response.status_code == 202
    assert mail_sender.password_reset_messages == []


def test_google_verified_email_recovers_unverified_preclaim_and_invalidates_credentials(
    client: TestClient,
    settings: Settings,
    mail_sender: FakeMailSender,
) -> None:
    registered = client.post(
        "/api/auth/register",
        json={
            "email": "victim@example.com",
            "displayName": "Attacker Name",
        },
    )
    assert registered.status_code == 201
    old_verification_token = mail_sender.latest_token_for("victim@example.com")

    with client.app.state.database.session_factory() as db:
        user = db.scalar(select(User).where(User.email == "victim@example.com"))
        assert user is not None
        user.password_hash = hash_password("legacy-attacker-password")
        stale_access = _jwt_encode(
            settings,
            subject=user.id,
            token_type="access",
            expires_at=utcnow() + timedelta(minutes=5),
            jti="stale-access",
            extra_claims={"gen": user.auth_generation},
        )
        refresh_jti = "stale-refresh-session"
        db.add(
            RefreshSession(
                user_id=user.id,
                token_hash=hashlib.sha256(refresh_jti.encode()).digest(),
                expires_at=utcnow() + timedelta(days=1),
            )
        )
        db.commit()
        preclaim_id = user.id

    verifier = client.app.state.google_verifier
    assert isinstance(verifier, FakeGoogleVerifier)
    verifier.identities["victim-google-token"] = GoogleIdentity(
        subject="victim-google-subject",
        email="victim@example.com",
        display_name="Victim",
        email_verified=True,
    )
    recovered = client.post("/api/auth/google", json={"idToken": "victim-google-token"})
    assert recovered.status_code == 200
    assert recovered.json()["user"]["id"] == preclaim_id
    assert recovered.json()["user"]["displayName"] == "Victim"

    with client.app.state.database.session_factory() as db:
        user = db.get(User, preclaim_id)
        assert user is not None
        assert user.google_subject == "victim-google-subject"
        assert user.password_hash is None
        assert user.email_verified_at is not None
        assert user.auth_generation == 2
        assert (
            db.scalar(
                select(func.count()).select_from(RefreshSession).where(RefreshSession.user_id == preclaim_id)
            )
            == 1
        )
        assert (
            db.scalar(
                select(RefreshSession).where(
                    RefreshSession.token_hash == hashlib.sha256(refresh_jti.encode()).digest()
                )
            )
            is None
        )

    assert client.get("/api/users/me", headers=auth(stale_access)).status_code == 401
    assert (
        client.post(
            "/api/auth/login",
            json={"email": "victim@example.com", "password": "legacy-attacker-password"},
        ).status_code
        == 401
    )
    assert (
        client.post(
            "/api/auth/verify-email",
            json={
                "token": old_verification_token,
                "password": "owner-chosen-password",
                "passwordConfirmation": "owner-chosen-password",
            },
        ).status_code
        == 400
    )


def test_conflicting_google_subject_is_rejected_without_mutating_either_account(
    client: TestClient,
) -> None:
    google = client.post("/api/auth/google", json={"idToken": "valid-google-token"})
    assert google.status_code == 200
    pending = client.post(
        "/api/auth/register",
        json={
            "email": "other@example.com",
            "displayName": "Other",
        },
    )
    assert pending.status_code == 201

    verifier = client.app.state.google_verifier
    assert isinstance(verifier, FakeGoogleVerifier)
    verifier.identities["conflicting-google-token"] = GoogleIdentity(
        subject="google-subject-1",
        email="other@example.com",
        display_name="Conflict",
        email_verified=True,
    )
    conflict = client.post("/api/auth/google", json={"idToken": "conflicting-google-token"})
    assert conflict.status_code == 409

    with client.app.state.database.session_factory() as db:
        original = db.get(User, google.json()["user"]["id"])
        preclaim = db.scalar(select(User).where(User.email == "other@example.com"))
        assert original is not None and original.email == "google@example.com"
        assert preclaim is not None and preclaim.google_subject is None
        assert preclaim.password_hash is None


def test_registration_mail_failure_is_generic_and_still_throttled(settings: Settings) -> None:
    class FailingMailSender:
        attempts = 0

        def send_email_verification(self, message: EmailVerificationMessage) -> None:
            self.attempts += 1
            raise MailDeliveryError(f"could not send to {message.recipient}")

    sender = FailingMailSender()
    with TestClient(
        create_app(
            settings,
            google_verifier=FakeGoogleVerifier(),
            mail_sender=sender,
        )
    ) as test_client:
        response = test_client.post(
            "/api/auth/register",
            json={
                "email": "mailer-down@example.com",
                "displayName": "Mailer Down",
            },
        )
        assert response.status_code == 201
        assert "accessToken" not in response.json()
        repeated = test_client.post(
            "/api/auth/register",
            json={"email": "mailer-down@example.com", "displayName": "Repeated"},
        )
        assert repeated.status_code == 201
        assert repeated.json() == response.json()
        resend = test_client.post(
            "/api/auth/resend-verification",
            json={"email": "mailer-down@example.com"},
        )
        assert resend.status_code == 202
        assert resend.headers["Retry-After"] == str(settings.email_verification_resend_seconds)
        assert test_client.app.state.mail_delivery_manager.wait_until_idle(2)
        assert sender.attempts == 1
        blocked = test_client.post(
            "/api/auth/login",
            json={
                "email": "mailer-down@example.com",
                "password": "correct-horse-battery-staple",
            },
        )
        assert blocked.status_code == 403


def test_group_invite_waits_for_target_email_verification(
    client: TestClient,
    mail_sender: FakeMailSender,
) -> None:
    owner = register(client, "invite-owner@example.com", "Owner")
    group = client.post(
        "/api/groups",
        headers=auth(owner["accessToken"]),
        json={"name": "Verified members", "description": ""},
    ).json()
    pending = client.post(
        "/api/auth/register",
        json={
            "email": "invitee@example.com",
            "displayName": "Invitee",
        },
    )
    assert pending.status_code == 201

    def invite() -> Response:
        return client.post(
            f"/api/groups/{group['id']}/members",
            headers=auth(owner["accessToken"]),
            json={"email": "invitee@example.com", "role": "member"},
        )

    assert invite().status_code == 409
    verified = client.post(
        "/api/auth/verify-email",
        json={
            "token": mail_sender.latest_token_for("invitee@example.com"),
            "password": "correct-horse-battery-staple",
            "passwordConfirmation": "correct-horse-battery-staple",
        },
    )
    assert verified.status_code == 200
    assert invite().status_code == 201
