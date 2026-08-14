from __future__ import annotations

import logging
from threading import Event, Lock, Thread

from _pytest.logging import LogCaptureFixture
from fastapi.testclient import TestClient

from app.config import Settings
from app.mailer import (
    AccountDeletionMessage,
    EmailVerificationMessage,
    MailDeliveryManager,
    PasswordResetMessage,
)
from app.main import create_app

from .conftest import FakeGoogleVerifier


class BlockingMailSender:
    def __init__(self) -> None:
        self.started = Event()
        self.release = Event()
        self._lock = Lock()
        self.delivered: list[str] = []

    def send_email_verification(self, message: EmailVerificationMessage) -> None:
        self.started.set()
        self.release.wait(timeout=3)
        with self._lock:
            self.delivered.append(message.verification_url)

    def send_password_reset(self, message: PasswordResetMessage) -> None:
        with self._lock:
            self.delivered.append(message.reset_url)

    def send_account_deletion(self, message: AccountDeletionMessage) -> None:
        with self._lock:
            self.delivered.append(message.deletion_url)


class RecordingMailSender:
    def __init__(self) -> None:
        self.delivered: list[str] = []

    def send_email_verification(self, message: EmailVerificationMessage) -> None:
        self.delivered.append(message.verification_url)

    def send_password_reset(self, message: PasswordResetMessage) -> None:
        self.delivered.append(message.reset_url)

    def send_account_deletion(self, message: AccountDeletionMessage) -> None:
        self.delivered.append(message.deletion_url)


def verification_message(marker: str) -> EmailVerificationMessage:
    return EmailVerificationMessage(
        recipient=f"{marker}@example.test",
        display_name="Queue Test",
        verification_url=f"https://example.test/login#verificationToken={marker}",
        expires_minutes=30,
    )


def test_registration_response_does_not_wait_for_smtp(settings: Settings) -> None:
    sender = BlockingMailSender()
    request_finished = Event()
    responses: list[int] = []
    with TestClient(
        create_app(
            settings,
            google_verifier=FakeGoogleVerifier(),
            mail_sender=sender,
        )
    ) as client:

        def register() -> None:
            response = client.post(
                "/api/auth/register",
                json={"email": "async-mail@example.com", "displayName": "Async Mail"},
            )
            responses.append(response.status_code)
            request_finished.set()

        request_thread = Thread(target=register)
        request_thread.start()
        assert sender.started.wait(timeout=2)
        returned_before_smtp = request_finished.wait(timeout=1)
        sender.release.set()
        request_thread.join(timeout=2)

        assert returned_before_smtp
        assert responses == [201]


def test_bounded_queue_drops_overflow_without_logging_credentials(
    caplog: LogCaptureFixture,
) -> None:
    sender = BlockingMailSender()
    manager = MailDeliveryManager(sender, worker_count=1, queue_capacity=1)
    manager.start()
    secret = "do-not-log-this-signed-token"

    assert manager.enqueue_email_verification(verification_message("active"))
    assert sender.started.wait(timeout=2)
    assert manager.enqueue_email_verification(verification_message("queued"))
    with caplog.at_level(logging.WARNING):
        accepted = manager.enqueue_email_verification(verification_message(secret))

    assert accepted is False
    assert secret not in caplog.text
    sender.release.set()
    assert manager.close(2)
    assert len(sender.delivered) == 2


def test_shutdown_drains_within_deadline_and_cancels_queued_work_after_deadline() -> None:
    recorder = RecordingMailSender()
    draining = MailDeliveryManager(recorder, worker_count=1, queue_capacity=4)
    draining.start()
    assert draining.enqueue_email_verification(verification_message("one"))
    assert draining.enqueue_email_verification(verification_message("two"))
    assert draining.close(2)
    assert len(recorder.delivered) == 2

    blocker = BlockingMailSender()
    cancelling = MailDeliveryManager(blocker, worker_count=1, queue_capacity=1)
    cancelling.start()
    assert cancelling.enqueue_email_verification(verification_message("active"))
    assert blocker.started.wait(timeout=2)
    assert cancelling.enqueue_email_verification(verification_message("must-be-cancelled"))
    assert cancelling.close(0) is False
    blocker.release.set()
    assert cancelling.wait_until_idle(2)
    assert blocker.delivered == [
        "https://example.test/login#verificationToken=active",
    ]
