"""Seed or reset the legacy owner before its first managed-local SSO link."""

from __future__ import annotations

import argparse
import getpass
import os
import secrets
import sys
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

from pydantic import EmailStr, TypeAdapter, ValidationError
from sqlalchemy import delete, select, text

from app.config import Settings
from app.db import Database
from app.models import RefreshSession, User, utcnow
from app.schemas import Password
from app.security import hash_password, normalize_email

EMAIL_ADAPTER = TypeAdapter(EmailStr)
PASSWORD_ADAPTER = TypeAdapter(Password)


class BootstrapError(RuntimeError):
    pass


@dataclass(frozen=True)
class BootstrapResult:
    email: str
    created: bool


def bootstrap_single_user(
    settings: Settings,
    *,
    email: str,
    display_name: str,
    password: str,
) -> BootstrapResult:
    if settings.environment != "production" or settings.deployment_profile != "managed_local_sso":
        raise BootstrapError("bootstrap is restricted to production managed_local_sso deployments")

    try:
        normalized_email = normalize_email(str(EMAIL_ADAPTER.validate_python(email)))
        validated_password = PASSWORD_ADAPTER.validate_python(password)
    except ValidationError as exc:
        raise BootstrapError("email or password does not satisfy the account contract") from exc
    normalized_name = display_name.strip()
    if not normalized_name or len(normalized_name) > 120:
        raise BootstrapError("display name must contain between 1 and 120 characters")

    database = Database(settings.database_url)
    created = False
    try:
        with database.session_factory.begin() as session:
            if settings.database_url.startswith(("postgresql://", "postgresql+psycopg://")):
                session.execute(
                    text("SELECT pg_advisory_xact_lock(hashtext('feelmyrythm-managed-owner-bootstrap'))")
                )
            active_users = list(
                session.scalars(select(User).where(User.is_active.is_(True)).with_for_update())
            )
            if any(user.email != normalized_email for user in active_users) or len(active_users) > 1:
                raise BootstrapError("another active account already exists")

            user = session.scalar(select(User).where(User.email == normalized_email).with_for_update())
            if user is None:
                user = User(
                    email=normalized_email,
                    display_name=normalized_name,
                    password_hash=None,
                )
                session.add(user)
                created = True
            elif user.sso_subject is not None:
                raise BootstrapError("owner is already linked to managed SSO")

            user.display_name = normalized_name
            user.password_hash = hash_password(validated_password)
            user.google_subject = None
            user.email_verified_at = utcnow()
            user.email_verification_sent_at = None
            user.password_reset_sent_at = None
            user.account_delete_sent_at = None
            user.auth_generation = int(user.auth_generation or 0) + 1
            user.is_active = True
            session.flush()
            session.execute(delete(RefreshSession).where(RefreshSession.user_id == user.id))
    finally:
        database.dispose()
    return BootstrapResult(email=normalized_email, created=created)


def _reserve_credentials_file(path: Path) -> int:
    if not path.is_absolute():
        raise BootstrapError("credentials file path must be absolute")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        return os.open(path, flags, 0o600)
    except OSError as exc:
        raise BootstrapError("credentials file must not already exist and must be writable") from exc


def _write_credentials(fd: int, *, email: str, password: str) -> None:
    payload = f"FeelMyRythm temporary owner\nemail={email}\npassword={password}\n"
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(payload)
        handle.flush()
        os.fsync(handle.fileno())


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", type=Path, default=None)
    parser.add_argument("--email", required=True)
    parser.add_argument("--display-name", required=True)
    password_source = parser.add_mutually_exclusive_group()
    password_source.add_argument("--password-stdin", action="store_true")
    password_source.add_argument("--generate-credentials-file", type=Path)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    credentials_fd: int | None = None
    credentials_path: Path | None = args.generate_credentials_file
    if credentials_path is not None:
        credentials_fd = _reserve_credentials_file(credentials_path)

    try:
        if credentials_fd is not None:
            password = secrets.token_urlsafe(24)
        elif args.password_stdin:
            password = sys.stdin.readline().rstrip("\r\n")
        else:
            password = getpass.getpass("Password: ")

        settings = Settings(_env_file=args.env_file)
        result = bootstrap_single_user(
            settings,
            email=args.email,
            display_name=args.display_name,
            password=password,
        )
        if credentials_fd is not None and credentials_path is not None:
            reserved_fd = credentials_fd
            credentials_fd = None
            _write_credentials(reserved_fd, email=result.email, password=password)
        action = "created" if result.created else "reset"
        print(f"legacy owner account {action}; credentials were not printed")
        if credentials_path is not None:
            print(f"credentials file: {credentials_path}")
        return 0
    except Exception:
        if credentials_fd is not None:
            os.close(credentials_fd)
        if credentials_path is not None:
            credentials_path.unlink(missing_ok=True)
        raise


if __name__ == "__main__":
    sys.exit(main())
