from __future__ import annotations

import re
import secrets
from dataclasses import dataclass
from typing import Literal, cast

from fastapi import HTTPException, status
from starlette.requests import HTTPConnection

from .config import Settings

SSO_EDGE_IDENTITY_INVALID = "Single sign-on edge identity is missing or invalid."
SSO_SUBJECT_MISMATCH = "Single sign-on identity does not match the application session."
SSO_APP_FORBIDDEN = "Single sign-on identity is not assigned to this application."
SSO_ROLE_FORBIDDEN = "Single sign-on role does not permit this operation."

SsoRole = Literal["user", "admin", "chief-admin"]
SSO_ROLE_PREFIXES: tuple[tuple[SsoRole, ...], ...] = (
    ("user",),
    ("user", "admin"),
    ("user", "admin", "chief-admin"),
)
SSO_ROLE_RANK: dict[SsoRole, int] = {"user": 0, "admin": 1, "chief-admin": 2}
SSO_CONTRACT_MARKER = "portfolio-v2"
SSO_APPLICATION_GROUPS = (
    "access-react",
    "access-vue",
    "access-dukkeobi",
    "access-ddit-finalproject",
    "access-monitor",
    "access-pilgrimage",
    "access-multtara",
    "access-feelmyrythm",
    "access-garak",
)
SSO_APPLICATION_GROUP = "access-feelmyrythm"
SSO_LEGACY_GROUPS: dict[tuple[str, ...], SsoRole] = {
    ("user",): "user",
    ("user", "developer"): "user",
    ("user", "developer", "admin"): "chief-admin",
}
SSO_GROUP_PATTERN = re.compile(r"[a-z0-9][a-z0-9_-]{0,63}")


@dataclass(frozen=True)
class ParsedSsoGroups:
    groups: tuple[str, ...]
    role: SsoRole
    application_access: bool
    legacy: bool


@dataclass(frozen=True)
class TrustedSsoIdentity:
    subject: str
    groups: tuple[str, ...]
    role: SsoRole


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


def _canonical_role_groups(role: SsoRole) -> tuple[SsoRole, ...]:
    return SSO_ROLE_PREFIXES[SSO_ROLE_RANK[role]]


def parse_sso_groups(raw_groups: str) -> ParsedSsoGroups:
    if not raw_groups or len(raw_groups) > 1024:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=SSO_EDGE_IDENTITY_INVALID,
        )
    segments = tuple(raw_groups.split(","))
    if any(not segment or SSO_GROUP_PATTERN.fullmatch(segment) is None for segment in segments) or len(
        set(segments)
    ) != len(segments):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=SSO_EDGE_IDENTITY_INVALID,
        )

    legacy_role = SSO_LEGACY_GROUPS.get(segments)
    if legacy_role is not None:
        return ParsedSsoGroups(
            groups=(*_canonical_role_groups(legacy_role), SSO_CONTRACT_MARKER),
            role=legacy_role,
            application_access=True,
            legacy=True,
        )

    marker_index = next(
        (index for index, segment in enumerate(segments) if segment == SSO_CONTRACT_MARKER),
        -1,
    )
    if marker_index < 1:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=SSO_EDGE_IDENTITY_INVALID,
        )
    role_segments = segments[:marker_index]
    application_groups = segments[marker_index + 1 :]
    if role_segments not in SSO_ROLE_PREFIXES:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=SSO_EDGE_IDENTITY_INVALID,
        )
    role = cast(SsoRole, role_segments[-1])
    ordered_groups = tuple(group for group in SSO_APPLICATION_GROUPS if group in application_groups)
    if (
        application_groups != ordered_groups
        or any(group not in SSO_APPLICATION_GROUPS for group in application_groups)
        or (role == "chief-admin" and application_groups)
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=SSO_EDGE_IDENTITY_INVALID,
        )
    return ParsedSsoGroups(
        groups=segments,
        role=role,
        application_access=role == "chief-admin" or SSO_APPLICATION_GROUP in application_groups,
        legacy=False,
    )


def trusted_sso_identity(
    request: HTTPConnection,
    settings: Settings,
) -> TrustedSsoIdentity | None:
    """Return the edge-authenticated identity, or None outside SSO mode.

    The public proxy must overwrite every identity header. The per-application
    secret prevents a caller that can reach the loopback web origin from
    forging only the human-readable Remote-* headers. Groups are deliberately
    re-evaluated on every request instead of being persisted in an app token.
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
    subject = normalize_sso_subject(request.headers.get("Remote-User", ""))
    parsed_groups = parse_sso_groups(request.headers.get("Remote-Groups", ""))
    if not parsed_groups.application_access:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=SSO_APP_FORBIDDEN,
        )
    return TrustedSsoIdentity(
        subject=subject,
        groups=parsed_groups.groups,
        role=parsed_groups.role,
    )


def trusted_sso_subject(request: HTTPConnection, settings: Settings) -> str | None:
    identity = trusted_sso_identity(request, settings)
    return identity.subject if identity is not None else None


def require_sso_role(
    request: HTTPConnection,
    settings: Settings,
    minimum_role: SsoRole,
) -> TrustedSsoIdentity:
    identity = trusted_sso_identity(request, settings)
    if identity is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not Found")
    if SSO_ROLE_RANK[identity.role] < SSO_ROLE_RANK[minimum_role]:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=SSO_ROLE_FORBIDDEN,
        )
    return identity


def require_matching_sso_subject(user_subject: str | None, request_subject: str | None) -> None:
    if request_subject is not None and user_subject != request_subject:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=SSO_SUBJECT_MISMATCH,
        )
