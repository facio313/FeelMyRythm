from __future__ import annotations

from dataclasses import asdict

from fastapi import APIRouter

from ..auth_cleanup import cleanup_legacy_auth, inventory_legacy_auth
from ..dependencies import CurrentUser, DbSession, SsoAdmin, SsoDeveloper
from ..schemas import AuthCleanupIn, AuthCleanupOut, AuthInventoryOut

router = APIRouter(prefix="/api", tags=["operations"])


@router.get("/operations/auth-inventory", response_model=AuthInventoryOut)
def auth_inventory(
    db: DbSession,
    _user: CurrentUser,
    _identity: SsoDeveloper,
) -> AuthInventoryOut:
    return AuthInventoryOut.model_validate(asdict(inventory_legacy_auth(db)))


@router.post("/admin/auth-cleanup", response_model=AuthCleanupOut)
def auth_cleanup(
    body: AuthCleanupIn,
    db: DbSession,
    _user: CurrentUser,
    _identity: SsoAdmin,
) -> AuthCleanupOut:
    result = cleanup_legacy_auth(
        db,
        purge_active_refresh_sessions=body.confirm_purge_active_refresh_sessions,
    )
    return AuthCleanupOut(
        inventory_before=AuthInventoryOut.model_validate(asdict(result.inventory_before)),
        users_cleaned=result.users_cleaned,
        refresh_sessions_deleted=result.refresh_sessions_deleted,
        stale_refresh_sessions_deleted=result.stale_refresh_sessions_deleted,
        active_refresh_sessions_deleted=result.active_refresh_sessions_deleted,
    )
