from __future__ import annotations

from dataclasses import dataclass
from typing import Any, cast

from sqlalchemy import delete, func, or_, select
from sqlalchemy.engine import CursorResult
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from .models import RefreshSession, User, utcnow


@dataclass(frozen=True)
class LegacyAuthInventory:
    total_refresh_sessions: int
    active_refresh_sessions: int
    users_with_password: int
    users_with_google_subject: int
    users_with_legacy_credentials: int
    linked_users_with_legacy_credentials: int
    unlinked_users_with_legacy_credentials: int
    legacy_refresh_sessions: int
    stale_refresh_sessions: int


@dataclass(frozen=True)
class LegacyAuthCleanupResult:
    inventory_before: LegacyAuthInventory
    users_cleaned: int
    refresh_sessions_deleted: int
    stale_refresh_sessions_deleted: int
    active_refresh_sessions_deleted: int


def _legacy_credentials_filter() -> ColumnElement[bool]:
    return or_(User.password_hash.is_not(None), User.google_subject.is_not(None))


def _stale_refresh_filter() -> ColumnElement[bool]:
    return or_(RefreshSession.revoked_at.is_not(None), RefreshSession.expires_at <= utcnow())


def inventory_legacy_auth(db: Session) -> LegacyAuthInventory:
    legacy_credentials = _legacy_credentials_filter()
    return LegacyAuthInventory(
        total_refresh_sessions=int(db.scalar(select(func.count()).select_from(RefreshSession)) or 0),
        active_refresh_sessions=int(
            db.scalar(
                select(func.count())
                .select_from(RefreshSession)
                .where(
                    RefreshSession.revoked_at.is_(None),
                    RefreshSession.expires_at > utcnow(),
                )
            )
            or 0
        ),
        users_with_password=int(
            db.scalar(select(func.count()).select_from(User).where(User.password_hash.is_not(None))) or 0
        ),
        users_with_google_subject=int(
            db.scalar(select(func.count()).select_from(User).where(User.google_subject.is_not(None))) or 0
        ),
        users_with_legacy_credentials=int(
            db.scalar(select(func.count()).select_from(User).where(legacy_credentials)) or 0
        ),
        linked_users_with_legacy_credentials=int(
            db.scalar(
                select(func.count())
                .select_from(User)
                .where(legacy_credentials, User.sso_subject.is_not(None))
            )
            or 0
        ),
        unlinked_users_with_legacy_credentials=int(
            db.scalar(
                select(func.count()).select_from(User).where(legacy_credentials, User.sso_subject.is_(None))
            )
            or 0
        ),
        legacy_refresh_sessions=int(
            db.scalar(
                select(func.count())
                .select_from(RefreshSession)
                .join(User, User.id == RefreshSession.user_id)
                .where(legacy_credentials)
            )
            or 0
        ),
        stale_refresh_sessions=int(
            db.scalar(select(func.count()).select_from(RefreshSession).where(_stale_refresh_filter())) or 0
        ),
    )


def cleanup_legacy_auth(
    db: Session,
    *,
    purge_active_refresh_sessions: bool = False,
) -> LegacyAuthCleanupResult:
    """Remove usable app-local credentials while preserving every user/domain row."""

    inventory_before = inventory_legacy_auth(db)
    users = list(db.scalars(select(User).where(_legacy_credentials_filter()).with_for_update()).all())
    user_ids = [user.id for user in users]
    refresh_sessions_deleted = 0
    if user_ids:
        result = cast(
            CursorResult[Any],
            db.execute(delete(RefreshSession).where(RefreshSession.user_id.in_(user_ids))),
        )
        refresh_sessions_deleted = int(result.rowcount or 0)
        for user in users:
            user.password_hash = None
            user.google_subject = None
            user.password_reset_sent_at = None
            user.auth_generation += 1
    stale_result = cast(
        CursorResult[Any],
        db.execute(delete(RefreshSession).where(_stale_refresh_filter())),
    )
    stale_refresh_sessions_deleted = int(stale_result.rowcount or 0)
    active_refresh_sessions_deleted = 0
    if purge_active_refresh_sessions:
        active_result = cast(CursorResult[Any], db.execute(delete(RefreshSession)))
        active_refresh_sessions_deleted = int(active_result.rowcount or 0)
    db.commit()
    return LegacyAuthCleanupResult(
        inventory_before=inventory_before,
        users_cleaned=len(users),
        refresh_sessions_deleted=refresh_sessions_deleted,
        stale_refresh_sessions_deleted=stale_refresh_sessions_deleted,
        active_refresh_sessions_deleted=active_refresh_sessions_deleted,
    )
