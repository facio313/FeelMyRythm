from __future__ import annotations

import logging
import queue
import smtplib
import ssl
import threading
import time
from dataclasses import dataclass
from email.message import EmailMessage
from typing import Protocol

from .config import Settings

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class EmailVerificationMessage:
    recipient: str
    display_name: str
    verification_url: str
    expires_minutes: int


@dataclass(frozen=True)
class PasswordResetMessage:
    recipient: str
    display_name: str
    reset_url: str
    expires_minutes: int


@dataclass(frozen=True)
class AccountDeletionMessage:
    recipient: str
    display_name: str
    deletion_url: str
    expires_minutes: int


class MailDeliveryError(RuntimeError):
    pass


class MailSender(Protocol):
    def send_email_verification(self, message: EmailVerificationMessage) -> None: ...

    def send_password_reset(self, message: PasswordResetMessage) -> None: ...

    def send_account_deletion(self, message: AccountDeletionMessage) -> None: ...


@dataclass(frozen=True)
class _VerificationJob:
    message: EmailVerificationMessage


@dataclass(frozen=True)
class _PasswordResetJob:
    message: PasswordResetMessage


@dataclass(frozen=True)
class _AccountDeletionJob:
    message: AccountDeletionMessage


type MailDeliveryJob = _VerificationJob | _PasswordResetJob | _AccountDeletionJob


class MailDeliveryManager:
    """Bound SMTP concurrency and keep provider I/O outside request threads.

    Shutdown stops accepting immediately, drains until the configured deadline,
    then cancels queued (but not already active) jobs. Worker threads are daemon
    threads because a blocking provider call cannot be safely interrupted.
    """

    def __init__(self, sender: MailSender, *, worker_count: int, queue_capacity: int) -> None:
        self._sender = sender
        self._worker_count = worker_count
        self._jobs: queue.Queue[MailDeliveryJob] = queue.Queue(maxsize=queue_capacity)
        self._state_lock = threading.Lock()
        self._idle = threading.Event()
        self._idle.set()
        self._stop = threading.Event()
        self._pending = 0
        self._accepting = False
        self._started = False
        self._threads: list[threading.Thread] = []

    def start(self) -> None:
        with self._state_lock:
            if self._started:
                return
            self._started = True
            self._accepting = True
            self._threads = [
                threading.Thread(
                    target=self._run_worker,
                    name=f"fmr-mail-{index}",
                    daemon=True,
                )
                for index in range(self._worker_count)
            ]
        for thread in self._threads:
            thread.start()

    def enqueue_email_verification(self, message: EmailVerificationMessage) -> bool:
        return self._enqueue(_VerificationJob(message))

    def enqueue_password_reset(self, message: PasswordResetMessage) -> bool:
        return self._enqueue(_PasswordResetJob(message))

    def enqueue_account_deletion(self, message: AccountDeletionMessage) -> bool:
        return self._enqueue(_AccountDeletionJob(message))

    def wait_until_idle(self, timeout: float) -> bool:
        return self._idle.wait(timeout=max(0.0, timeout))

    def close(self, drain_timeout: float) -> bool:
        deadline = time.monotonic() + max(0.0, drain_timeout)
        with self._state_lock:
            if not self._started:
                return True
            self._accepting = False
            self._stop.set()

        drained = self._idle.wait(timeout=max(0.0, deadline - time.monotonic()))
        if not drained:
            self._cancel_queued()
        for thread in self._threads:
            thread.join(timeout=max(0.0, deadline - time.monotonic()))
        stopped = all(not thread.is_alive() for thread in self._threads)
        with self._state_lock:
            if stopped:
                self._started = False
        return drained and stopped

    def _enqueue(self, job: MailDeliveryJob) -> bool:
        with self._state_lock:
            if not self._accepting:
                logger.warning("Email delivery manager is not accepting messages; message dropped")
                return False
            self._pending += 1
            self._idle.clear()
            try:
                self._jobs.put_nowait(job)
            except queue.Full:
                self._pending -= 1
                if self._pending == 0:
                    self._idle.set()
                logger.warning("Email delivery queue is full; message dropped")
                return False
        return True

    def _run_worker(self) -> None:
        while True:
            if self._stop.is_set() and self._jobs.empty():
                return
            try:
                job = self._jobs.get(timeout=0.1)
            except queue.Empty:
                continue
            try:
                if isinstance(job, _VerificationJob):
                    self._sender.send_email_verification(job.message)
                elif isinstance(job, _PasswordResetJob):
                    self._sender.send_password_reset(job.message)
                else:
                    self._sender.send_account_deletion(job.message)
            except Exception as exc:
                # Provider errors can contain addresses or message bodies. Log only
                # the class so operational telemetry never records a credential URL.
                logger.error("Queued email delivery failed (%s)", type(exc).__name__)
            finally:
                self._jobs.task_done()
                self._finish_job()

    def _cancel_queued(self) -> None:
        while True:
            try:
                self._jobs.get_nowait()
            except queue.Empty:
                return
            self._jobs.task_done()
            self._finish_job()

    def _finish_job(self) -> None:
        with self._state_lock:
            self._pending -= 1
            if self._pending == 0:
                self._idle.set()


class DevelopmentMailSender:
    def send_email_verification(self, message: EmailVerificationMessage) -> None:
        logger.warning(
            "Development email verification link for %s: %s",
            message.recipient,
            message.verification_url,
        )

    def send_password_reset(self, message: PasswordResetMessage) -> None:
        logger.warning(
            "Development password reset link for %s: %s",
            message.recipient,
            message.reset_url,
        )

    def send_account_deletion(self, message: AccountDeletionMessage) -> None:
        logger.warning(
            "Development account deletion link for %s: %s",
            message.recipient,
            message.deletion_url,
        )


class DisabledMailSender:
    """Fail closed without logging signed account-recovery URLs."""

    def send_email_verification(self, message: EmailVerificationMessage) -> None:
        del message
        raise MailDeliveryError("email delivery is disabled")

    def send_password_reset(self, message: PasswordResetMessage) -> None:
        del message
        raise MailDeliveryError("email delivery is disabled")

    def send_account_deletion(self, message: AccountDeletionMessage) -> None:
        del message
        raise MailDeliveryError("email delivery is disabled")


class SmtpMailSender:
    def __init__(self, settings: Settings) -> None:
        if not settings.smtp_host or settings.smtp_from_email is None:
            raise ValueError("SMTP host and sender address are required")
        self.host = settings.smtp_host
        self.port = settings.smtp_port
        self.username = settings.smtp_username
        self.password = (
            settings.smtp_password.get_secret_value() if settings.smtp_password is not None else None
        )
        self.from_email = str(settings.smtp_from_email)
        self.starttls = settings.smtp_starttls
        self.use_ssl = settings.smtp_use_ssl

    def send_email_verification(self, verification: EmailVerificationMessage) -> None:
        message = EmailMessage()
        message["Subject"] = "FeelMyRythm 가입 비밀번호를 설정해 주세요"
        message["From"] = self.from_email
        message["To"] = verification.recipient
        message.set_content(
            "\n".join(
                [
                    f"{verification.display_name}님, 아래 링크를 열어 새 비밀번호를 설정하면 FeelMyRythm 가입이 완료됩니다.",
                    "",
                    verification.verification_url,
                    "",
                    f"링크는 {verification.expires_minutes}분 동안 유효합니다.",
                    "이 단계 전에는 비밀번호나 로그인 세션이 만들어지지 않습니다.",
                    "본인이 요청하지 않았다면 이 메일을 무시하세요.",
                ]
            )
        )

        self._deliver(message)

    def send_password_reset(self, reset: PasswordResetMessage) -> None:
        message = EmailMessage()
        message["Subject"] = "FeelMyRythm 비밀번호를 재설정해 주세요"
        message["From"] = self.from_email
        message["To"] = reset.recipient
        message.set_content(
            "\n".join(
                [
                    f"{reset.display_name}님, 아래 링크를 열어 새 비밀번호를 설정하세요.",
                    "",
                    reset.reset_url,
                    "",
                    f"링크는 {reset.expires_minutes}분 동안 유효하며 한 번만 사용할 수 있습니다.",
                    "본인이 요청하지 않았다면 비밀번호는 바뀌지 않으므로 이 메일을 무시하세요.",
                ]
            )
        )

        self._deliver(message)

    def send_account_deletion(self, deletion: AccountDeletionMessage) -> None:
        message = EmailMessage()
        message["Subject"] = "FeelMyRythm 계정 삭제를 확인해 주세요"
        message["From"] = self.from_email
        message["To"] = deletion.recipient
        message.set_content(
            "\n".join(
                [
                    f"{deletion.display_name}님, 계정 삭제를 계속하려면 아래 링크를 여세요.",
                    "",
                    deletion.deletion_url,
                    "",
                    f"링크는 {deletion.expires_minutes}분 동안 유효하며 한 번만 사용할 수 있습니다.",
                    "링크를 연 뒤 앱에서 삭제를 다시 확인하기 전에는 계정이 삭제되지 않습니다.",
                    "본인이 요청하지 않았다면 이 메일을 무시하세요.",
                ]
            )
        )

        self._deliver(message)

    def _deliver(self, message: EmailMessage) -> None:
        context = ssl.create_default_context()
        try:
            if self.use_ssl:
                with smtplib.SMTP_SSL(
                    self.host,
                    self.port,
                    timeout=15,
                    context=context,
                ) as server:
                    self._send(server, message)
                return
            with smtplib.SMTP(self.host, self.port, timeout=15) as server:
                server.ehlo()
                if self.starttls:
                    server.starttls(context=context)
                    server.ehlo()
                self._send(server, message)
        except (OSError, smtplib.SMTPException) as exc:
            raise MailDeliveryError("email could not be delivered") from exc

    def _send(self, server: smtplib.SMTP, message: EmailMessage) -> None:
        if self.username is not None and self.password is not None:
            server.login(self.username, self.password)
        server.send_message(message)


def make_mail_sender(settings: Settings) -> MailSender:
    if settings.deployment_profile == "single_user_local":
        return DisabledMailSender()
    if settings.smtp_host and settings.smtp_host.strip():
        return SmtpMailSender(settings)
    return DevelopmentMailSender()
