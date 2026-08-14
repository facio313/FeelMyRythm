from __future__ import annotations

import hashlib
import secrets
import threading
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Protocol

import bcrypt
import jwt
from fastapi import HTTPException, status
from google.auth.transport import requests as google_requests
from google.oauth2 import id_token as google_id_token
from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import Settings
from .models import RefreshSession, User, utcnow


class TokenError(ValueError):
    pass


class PasswordVerificationBusy(RuntimeError):
    pass


DUMMY_PASSWORD_HASH = "$2b$12$KV3y6PKuhAjQVJBDOrViLOyTUzDQEe3IUayLeUNBGY/5ysZTOg4By"


class PasswordVerifier:
    def __init__(self, max_concurrent: int) -> None:
        self._slots = threading.BoundedSemaphore(max_concurrent)

    def verify(self, password: str, password_hash: str | None) -> bool:
        if not self._slots.acquire(blocking=False):
            raise PasswordVerificationBusy
        try:
            return verify_password(password, password_hash or DUMMY_PASSWORD_HASH)
        finally:
            self._slots.release()


def normalize_email(email: str) -> str:
    return email.strip().casefold()


def hash_password(password: str) -> str:
    digest = hashlib.sha256(password.encode()).digest()
    return bcrypt.hashpw(digest, bcrypt.gensalt()).decode()


def verify_password(password: str, password_hash: str | None) -> bool:
    if password_hash is None:
        return False
    try:
        digest = hashlib.sha256(password.encode()).digest()
        return bcrypt.checkpw(digest, password_hash.encode())
    except ValueError:
        return False


def _jwt_encode(
    settings: Settings,
    *,
    subject: str,
    token_type: str,
    expires_at: datetime,
    jti: str,
    extra_claims: dict[str, Any] | None = None,
) -> str:
    now = utcnow()
    claims: dict[str, Any] = {
        "sub": subject,
        "typ": token_type,
        "jti": jti,
        "iss": settings.jwt_issuer,
        "iat": now,
        "exp": expires_at,
    }
    if extra_claims:
        if claims.keys() & extra_claims.keys():
            raise ValueError("extra JWT claims cannot replace reserved claims")
        claims.update(extra_claims)
    encoded = jwt.encode(
        claims,
        settings.signing_secret,
        algorithm="HS256",
    )
    return encoded.decode() if isinstance(encoded, bytes) else encoded


def create_token_pair(db: Session, settings: Settings, user: User) -> tuple[str, str, int]:
    if not user.is_active or user.email_verified_at is None:
        raise TokenError("verified active user required")
    generation = int(user.auth_generation)
    access_expires = utcnow() + timedelta(minutes=settings.access_token_minutes)
    refresh_expires = utcnow() + timedelta(days=settings.refresh_token_days)
    access = _jwt_encode(
        settings,
        subject=user.id,
        token_type="access",
        expires_at=access_expires,
        jti=secrets.token_hex(16),
        extra_claims={"gen": generation},
    )
    refresh_jti = secrets.token_hex(32)
    refresh = _jwt_encode(
        settings,
        subject=user.id,
        token_type="refresh",
        expires_at=refresh_expires,
        jti=refresh_jti,
        extra_claims={"gen": generation},
    )
    db.add(
        RefreshSession(
            user_id=user.id,
            token_hash=hashlib.sha256(refresh_jti.encode()).digest(),
            expires_at=refresh_expires,
        )
    )
    db.commit()
    return access, refresh, settings.access_token_minutes * 60


def decode_token(settings: Settings, token: str, expected_type: str) -> dict[str, Any]:
    try:
        payload = jwt.decode(
            token,
            settings.signing_secret,
            algorithms=["HS256"],
            issuer=settings.jwt_issuer,
            options={"require": ["sub", "typ", "jti", "iat", "exp", "iss"]},
        )
    except jwt.PyJWTError as exc:
        raise TokenError("invalid or expired token") from exc
    if payload.get("typ") != expected_type:
        raise TokenError("wrong token type")
    return payload


def authenticate_access_token(db: Session, settings: Settings, token: str) -> User:
    try:
        payload = decode_token(settings, token, "access")
    except TokenError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=str(exc)) from exc
    user = db.get(User, str(payload["sub"]))
    if user is None or not user.is_active or user.email_verified_at is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="inactive or missing user")
    if payload.get("gen") != user.auth_generation:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="token generation is stale")
    return user


def rotate_refresh_token(db: Session, settings: Settings, token: str) -> tuple[User, str, str, int]:
    try:
        payload = decode_token(settings, token, "refresh")
    except TokenError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=str(exc)) from exc
    token_hash = hashlib.sha256(str(payload["jti"]).encode()).digest()
    record = db.scalar(
        select(RefreshSession).where(RefreshSession.token_hash == token_hash).with_for_update()
    )
    if record is None or record.revoked_at is not None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="refresh token was revoked")
    expires_at = record.expires_at
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=UTC)
    if expires_at <= utcnow():
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="refresh token expired")
    user = db.get(User, record.user_id)
    if user is None or not user.is_active or user.email_verified_at is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="inactive or missing user")
    if payload.get("gen") != user.auth_generation:
        record.revoked_at = utcnow()
        db.commit()
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="token generation is stale")
    record.revoked_at = utcnow()
    db.commit()
    access, refresh, expires_in = create_token_pair(db, settings, user)
    return user, access, refresh, expires_in


def revoke_refresh_token(db: Session, settings: Settings, token: str) -> None:
    try:
        payload = decode_token(settings, token, "refresh")
    except TokenError:
        return
    token_hash = hashlib.sha256(str(payload["jti"]).encode()).digest()
    record = db.scalar(
        select(RefreshSession).where(RefreshSession.token_hash == token_hash).with_for_update()
    )
    if record is not None and record.revoked_at is None:
        record.revoked_at = utcnow()
        db.commit()


def create_email_verification_token(settings: Settings, user: User) -> str:
    return _jwt_encode(
        settings,
        subject=user.id,
        token_type="email_verification",
        expires_at=utcnow() + timedelta(minutes=settings.email_verification_minutes),
        jti=secrets.token_hex(24),
        extra_claims={"email": user.email, "gen": user.auth_generation},
    )


def decode_email_verification_token(settings: Settings, token: str) -> tuple[str, str, int]:
    payload = decode_token(settings, token, "email_verification")
    subject = payload.get("sub")
    email = payload.get("email")
    generation = payload.get("gen")
    if (
        not isinstance(subject, str)
        or not isinstance(email, str)
        or not isinstance(generation, int)
        or isinstance(generation, bool)
    ):
        raise TokenError("verification token is missing identity claims")
    return subject, normalize_email(email), generation


def create_password_reset_token(settings: Settings, user: User) -> str:
    return _jwt_encode(
        settings,
        subject=user.id,
        token_type="password_reset",
        expires_at=utcnow() + timedelta(minutes=settings.password_reset_minutes),
        jti=secrets.token_hex(24),
        extra_claims={"email": user.email, "gen": user.auth_generation},
    )


def decode_password_reset_token(settings: Settings, token: str) -> tuple[str, str, int]:
    payload = decode_token(settings, token, "password_reset")
    subject = payload.get("sub")
    email = payload.get("email")
    generation = payload.get("gen")
    if (
        not isinstance(subject, str)
        or not isinstance(email, str)
        or not isinstance(generation, int)
        or isinstance(generation, bool)
    ):
        raise TokenError("password reset token is missing identity claims")
    return subject, normalize_email(email), generation


def create_account_delete_token(settings: Settings, user: User) -> str:
    return _jwt_encode(
        settings,
        subject=user.id,
        token_type="account_delete",
        expires_at=utcnow() + timedelta(minutes=settings.account_delete_minutes),
        jti=secrets.token_hex(24),
        extra_claims={
            "email": user.email,
            "google_sub": user.google_subject,
            "gen": user.auth_generation,
        },
    )


def decode_account_delete_token(settings: Settings, token: str) -> tuple[str, str, str, int]:
    payload = decode_token(settings, token, "account_delete")
    subject = payload.get("sub")
    email = payload.get("email")
    google_subject = payload.get("google_sub")
    generation = payload.get("gen")
    if (
        not isinstance(subject, str)
        or not isinstance(email, str)
        or not isinstance(google_subject, str)
        or not isinstance(generation, int)
        or isinstance(generation, bool)
    ):
        raise TokenError("account deletion token is missing identity claims")
    return subject, normalize_email(email), google_subject, generation


@dataclass(frozen=True)
class GoogleIdentity:
    subject: str
    email: str
    display_name: str
    email_verified: bool


class GoogleTokenVerifier(Protocol):
    def verify(self, raw_token: str, client_id: str) -> GoogleIdentity: ...


class GoogleAuthVerifier:
    def verify(self, raw_token: str, client_id: str) -> GoogleIdentity:
        try:
            claims = google_id_token.verify_oauth2_token(  # type: ignore[no-untyped-call]
                raw_token,
                google_requests.Request(),
                audience=client_id,
            )
        except ValueError as exc:
            raise HTTPException(status_code=401, detail="invalid Google ID token") from exc
        email = claims.get("email")
        subject = claims.get("sub")
        if not isinstance(email, str) or not isinstance(subject, str):
            raise HTTPException(status_code=401, detail="Google token is missing identity claims")
        return GoogleIdentity(
            subject=subject,
            email=normalize_email(email),
            display_name=str(claims.get("name") or email.split("@", 1)[0]),
            email_verified=bool(claims.get("email_verified")),
        )


def make_upload_token(settings: Settings, storage_key: str) -> str:
    expires = utcnow() + timedelta(seconds=settings.upload_url_ttl_seconds)
    return _jwt_encode(
        settings,
        subject=storage_key,
        token_type="upload",
        expires_at=expires,
        jti=secrets.token_hex(12),
    )


def verify_upload_token(settings: Settings, token: str, storage_key: str) -> None:
    try:
        payload = decode_token(settings, token, "upload")
    except TokenError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc
    if not secrets.compare_digest(str(payload["sub"]), storage_key):
        raise HTTPException(status_code=401, detail="upload token does not match target")
