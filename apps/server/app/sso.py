from __future__ import annotations

import secrets

from fastapi import HTTPException, status
from starlette.requests import HTTPConnection

from .config import Settings

SSO_EDGE_IDENTITY_INVALID = "Single sign-on edge identity is missing or invalid."
SSO_SUBJECT_MISMATCH = "Single sign-on identity does not match the application session."


def normalize_sso_subject(raw_subject: str) -> str:
    subject = raw_subject.strip()
    if (
        not subject
        or len(subject) > 255
        or any(ord(character) < 32 or ord(character) == 127 for character in subject)
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=SSO_EDGE_IDENTITY_INVALID,
        )
    return subject


def trusted_sso_subject(request: HTTPConnection, settings: Settings) -> str | None:
    """Return the edge-authenticated subject, or None outside SSO mode.

    The public proxy must overwrite both headers. The per-application secret
    prevents a caller that can reach the loopback web origin from forging only
    the human-readable Remote-* identity headers.
    """

    if not settings.sso_enabled:
        return None
    presented_secret = request.headers.get("X-Portfolio-Edge-Secret", "")
    if not secrets.compare_digest(
        presented_secret,
        settings.resolved_sso_edge_secret,
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=SSO_EDGE_IDENTITY_INVALID,
        )
    return normalize_sso_subject(request.headers.get("Remote-User", ""))


def require_matching_sso_subject(user_subject: str | None, request_subject: str | None) -> None:
    if request_subject is not None and user_subject != request_subject:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=SSO_SUBJECT_MISMATCH,
        )
