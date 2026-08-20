from __future__ import annotations

from datetime import datetime, timedelta
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Request, Response, status
from pydantic import EmailStr, TypeAdapter, ValidationError
from sqlalchemy import delete, select, update
from sqlalchemy.exc import IntegrityError

from ..dependencies import AppSettings, CurrentUser, DbSession
from ..mailer import (
    AccountDeletionMessage,
    EmailVerificationMessage,
    MailDeliveryManager,
    PasswordResetMessage,
)
from ..models import (
    Annotation,
    DeviceCalibration,
    Group,
    GroupMember,
    PracticeLog,
    Project,
    RefreshSession,
    RepertoireItem,
    Score,
    Todo,
    User,
    utcnow,
)
from ..schemas import (
    EmailVerificationCompleteIn,
    EmailVerificationPendingOut,
    EmailVerificationResendIn,
    GoogleLoginIn,
    LoginIn,
    MessageOut,
    PasswordResetCompleteIn,
    PasswordResetRequestIn,
    RefreshIn,
    RegisterIn,
    TokenPairOut,
    UserDeleteIn,
    UserOut,
    UserUpdate,
)
from ..security import (
    GoogleTokenVerifier,
    PasswordVerificationBusy,
    PasswordVerifier,
    TokenError,
    create_account_delete_token,
    create_email_verification_token,
    create_password_reset_token,
    create_token_pair,
    decode_account_delete_token,
    decode_email_verification_token,
    decode_password_reset_token,
    hash_password,
    normalize_email,
    revoke_refresh_token,
    rotate_refresh_token,
    verify_password,
)
from ..serializers import user_out
from ..sso import trusted_sso_subject
from .storage_cleanup import enqueue_score_cleanup

router = APIRouter(prefix="/api/auth", tags=["auth"])
users_router = APIRouter(prefix="/api/users", tags=["users"])

VERIFICATION_REQUIRED_DETAIL = {
    "code": "EMAIL_VERIFICATION_REQUIRED",
    "message": "Verify your email before signing in.",
}
RESEND_MESSAGE = "If an unverified account exists, a verification email has been sent."
REGISTRATION_MESSAGE = "If this address can be registered, a completion email has been sent."
PASSWORD_RESET_MESSAGE = "If a password account exists, a reset email has been sent."
ACCOUNT_DELETE_MESSAGE = "If eligible, an account deletion confirmation email has been sent."
EMAIL_WORKFLOWS_DISABLED = "Email account workflows are temporarily unavailable."
PUBLIC_ENROLLMENT_DISABLED = "Public account enrollment is temporarily unavailable."
LOCAL_AUTH_DISABLED = "Local account authentication is disabled; use portfolio single sign-on."
SSO_IDENTITY_INVALID = "Single sign-on identity is missing or invalid."
SSO_IDENTITY_NOT_PROVISIONED = "Single sign-on identity is not provisioned for this application."
SSO_IDENTITY_CONFLICT = "Single sign-on identity conflicts with an existing application account."
EMAIL_ADAPTER = TypeAdapter(EmailStr)


def _require_public_email_workflows(settings: AppSettings) -> None:
    if not settings.public_email_workflows_enabled:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=EMAIL_WORKFLOWS_DISABLED,
        )


def _require_public_enrollment(settings: AppSettings) -> None:
    if settings.deployment_profile == "managed_local_sso":
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=PUBLIC_ENROLLMENT_DISABLED,
        )


def _require_local_account_authentication(settings: AppSettings) -> None:
    if settings.sso_enabled:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=LOCAL_AUTH_DISABLED,
        )


def _lock_owned_groups_and_scores(db: DbSession, user_id: str) -> tuple[list[Group], list[Score]]:
    owner_group_ids = db.scalars(
        select(GroupMember.group_id)
        .where(GroupMember.user_id == user_id, GroupMember.role == "owner")
        .order_by(GroupMember.group_id)
        .with_for_update()
    ).all()
    if not owner_group_ids:
        return [], []
    groups = db.scalars(
        select(Group).where(Group.id.in_(owner_group_ids)).order_by(Group.id).with_for_update()
    ).all()
    projects = db.scalars(
        select(Project).where(Project.group_id.in_(owner_group_ids)).order_by(Project.id).with_for_update()
    ).all()
    if not projects:
        return list(groups), []
    project_ids = [project.id for project in projects]
    repertoire = db.scalars(
        select(RepertoireItem)
        .where(RepertoireItem.project_id.in_(project_ids))
        .order_by(RepertoireItem.id)
        .with_for_update()
    ).all()
    if not repertoire:
        return list(groups), []
    repertoire_ids = [item.id for item in repertoire]
    scores = db.scalars(
        select(Score)
        .where(Score.repertoire_id.in_(repertoire_ids))
        .order_by(Score.storage_key)
        .with_for_update()
    ).all()
    return list(groups), list(scores)


def _token_response(db: DbSession, settings: AppSettings, user: User) -> TokenPairOut:
    access, refresh, expires_in = create_token_pair(db, settings, user)
    return TokenPairOut(
        access_token=access,
        refresh_token=refresh,
        expires_in=expires_in,
        user=user_out(user),
    )


def _cooldown_elapsed(attempted_at: datetime | None, seconds: int) -> bool:
    if attempted_at is None:
        return True
    timestamp = attempted_at
    if timestamp.tzinfo is None:
        timestamp = timestamp.replace(tzinfo=utcnow().tzinfo)
    return utcnow() - timestamp >= timedelta(seconds=seconds)


def _deliver_verification_attempt(
    request: Request,
    db: DbSession,
    settings: AppSettings,
    user: User,
) -> None:
    # Commit the attempt before touching SMTP. A timeout or provider error must not
    # let a caller bypass the per-email cooldown with unlimited retries. Rotating
    # the generation also makes every previously issued completion link unusable.
    user.email_verification_sent_at = utcnow()
    user.auth_generation += 1
    db.execute(delete(RefreshSession).where(RefreshSession.user_id == user.id))
    token = create_email_verification_token(settings, user)
    db.commit()
    base_url = settings.web_app_base_url.rstrip("/")
    verification_url = f"{base_url}/login#verificationToken={quote(token, safe='')}"
    manager: MailDeliveryManager = request.app.state.mail_delivery_manager
    manager.enqueue_email_verification(
        EmailVerificationMessage(
            recipient=user.email,
            display_name=user.display_name,
            verification_url=verification_url,
            expires_minutes=settings.email_verification_minutes,
        )
    )


def _deliver_password_reset_attempt(
    request: Request,
    db: DbSession,
    settings: AppSettings,
    user: User,
) -> None:
    user.password_reset_sent_at = utcnow()
    db.commit()
    token = create_password_reset_token(settings, user)
    reset_url = f"{settings.web_app_base_url.rstrip('/')}/login#passwordResetToken={quote(token, safe='')}"
    manager: MailDeliveryManager = request.app.state.mail_delivery_manager
    manager.enqueue_password_reset(
        PasswordResetMessage(
            recipient=user.email,
            display_name=user.display_name,
            reset_url=reset_url,
            expires_minutes=settings.password_reset_minutes,
        )
    )


def _deliver_account_delete_attempt(
    request: Request,
    db: DbSession,
    settings: AppSettings,
    user: User,
) -> None:
    user.account_delete_sent_at = utcnow()
    db.commit()
    token = create_account_delete_token(settings, user)
    deletion_url = (
        f"{settings.web_app_base_url.rstrip('/')}/settings#accountDeleteToken={quote(token, safe='')}"
    )
    manager: MailDeliveryManager = request.app.state.mail_delivery_manager
    manager.enqueue_account_deletion(
        AccountDeletionMessage(
            recipient=user.email,
            display_name=user.display_name,
            deletion_url=deletion_url,
            expires_minutes=settings.account_delete_minutes,
        )
    )


@router.post(
    "/register",
    response_model=EmailVerificationPendingOut,
    status_code=status.HTTP_201_CREATED,
)
def register(
    body: RegisterIn,
    request: Request,
    response: Response,
    db: DbSession,
    settings: AppSettings,
) -> EmailVerificationPendingOut:
    _require_local_account_authentication(settings)
    _require_public_enrollment(settings)
    _require_public_email_workflows(settings)
    email = normalize_email(str(body.email))
    response.headers["Retry-After"] = str(settings.email_verification_resend_seconds)
    user = db.scalar(select(User).where(User.email == email).with_for_update())
    if user is None:
        user = User(email=email, display_name=body.display_name, password_hash=None)
        db.add(user)
        try:
            db.commit()
            db.refresh(user)
        except IntegrityError:
            db.rollback()
            user = db.scalar(select(User).where(User.email == email).with_for_update())
            if user is None:
                raise
    if (
        user.is_active
        and user.email_verified_at is None
        and _cooldown_elapsed(
            user.email_verification_sent_at,
            settings.email_verification_resend_seconds,
        )
    ):
        _deliver_verification_attempt(request, db, settings, user)
    return EmailVerificationPendingOut(
        email=email,
        expires_in=settings.email_verification_minutes * 60,
        message=REGISTRATION_MESSAGE,
    )


@router.post("/verify-email", response_model=TokenPairOut)
def verify_email(
    body: EmailVerificationCompleteIn,
    db: DbSession,
    settings: AppSettings,
) -> TokenPairOut:
    _require_local_account_authentication(settings)
    try:
        user_id, token_email, token_generation = decode_email_verification_token(
            settings,
            body.token,
        )
    except TokenError as exc:
        raise HTTPException(status_code=400, detail="invalid or expired verification token") from exc
    user = db.scalar(select(User).where(User.id == user_id).with_for_update())
    if (
        user is None
        or not user.is_active
        or user.email != token_email
        or user.auth_generation != token_generation
    ):
        raise HTTPException(status_code=400, detail="invalid or expired verification token")
    if user.email_verified_at is not None:
        raise HTTPException(status_code=409, detail="email is already verified")
    # Always replace a legacy pre-verification credential. Mailbox ownership, not
    # whoever first submitted the address, chooses the account password.
    user.password_hash = hash_password(body.password)
    user.email_verified_at = utcnow()
    user.email_verification_sent_at = None
    user.auth_generation += 1
    db.execute(delete(RefreshSession).where(RefreshSession.user_id == user.id))
    db.commit()
    db.refresh(user)
    return _token_response(db, settings, user)


@router.post(
    "/resend-verification",
    response_model=MessageOut,
    status_code=status.HTTP_202_ACCEPTED,
)
def resend_verification(
    body: EmailVerificationResendIn,
    request: Request,
    response: Response,
    db: DbSession,
    settings: AppSettings,
) -> MessageOut:
    _require_local_account_authentication(settings)
    _require_public_email_workflows(settings)
    response.headers["Retry-After"] = str(settings.email_verification_resend_seconds)
    email = normalize_email(str(body.email))
    user = db.scalar(select(User).where(User.email == email).with_for_update())
    if user is None or not user.is_active or user.email_verified_at is not None:
        return MessageOut(message=RESEND_MESSAGE)
    if not _cooldown_elapsed(
        user.email_verification_sent_at,
        settings.email_verification_resend_seconds,
    ):
        return MessageOut(message=RESEND_MESSAGE)
    _deliver_verification_attempt(request, db, settings, user)
    return MessageOut(message=RESEND_MESSAGE)


@router.post(
    "/request-password-reset",
    response_model=MessageOut,
    status_code=status.HTTP_202_ACCEPTED,
)
def request_password_reset(
    body: PasswordResetRequestIn,
    request: Request,
    response: Response,
    db: DbSession,
    settings: AppSettings,
) -> MessageOut:
    _require_local_account_authentication(settings)
    _require_public_email_workflows(settings)
    response.headers["Retry-After"] = str(settings.password_reset_request_seconds)
    user = db.scalar(select(User).where(User.email == normalize_email(str(body.email))).with_for_update())
    if (
        user is None
        or not user.is_active
        or user.email_verified_at is None
        or user.password_hash is None
        or not _cooldown_elapsed(
            user.password_reset_sent_at,
            settings.password_reset_request_seconds,
        )
    ):
        return MessageOut(message=PASSWORD_RESET_MESSAGE)
    _deliver_password_reset_attempt(request, db, settings, user)
    return MessageOut(message=PASSWORD_RESET_MESSAGE)


@router.post("/reset-password", response_model=MessageOut)
def reset_password(
    body: PasswordResetCompleteIn,
    db: DbSession,
    settings: AppSettings,
) -> MessageOut:
    _require_local_account_authentication(settings)
    try:
        user_id, token_email, token_generation = decode_password_reset_token(settings, body.token)
    except TokenError as exc:
        raise HTTPException(status_code=400, detail="invalid or expired password reset token") from exc
    user = db.scalar(select(User).where(User.id == user_id).with_for_update())
    if (
        user is None
        or not user.is_active
        or user.email_verified_at is None
        or user.password_hash is None
        or user.email != token_email
        or user.auth_generation != token_generation
    ):
        raise HTTPException(status_code=400, detail="invalid or expired password reset token")
    user.password_hash = hash_password(body.password)
    user.password_reset_sent_at = None
    user.auth_generation += 1
    db.execute(delete(RefreshSession).where(RefreshSession.user_id == user.id))
    db.commit()
    return MessageOut(message="password reset complete")


@router.post("/login", response_model=TokenPairOut)
def login(
    body: LoginIn,
    request: Request,
    db: DbSession,
    settings: AppSettings,
) -> TokenPairOut:
    _require_local_account_authentication(settings)
    user = db.scalar(select(User).where(User.email == normalize_email(str(body.email))))
    password_verifier: PasswordVerifier = request.app.state.password_verifier
    comparable_hash = (
        user.password_hash
        if user is not None and user.is_active and user.email_verified_at is not None
        else None
    )
    try:
        credentials_valid = password_verifier.verify(body.password, comparable_hash)
    except PasswordVerificationBusy as exc:
        raise HTTPException(
            status_code=429,
            detail="login is temporarily busy",
            headers={"Retry-After": "1"},
        ) from exc
    if user is None or not user.is_active:
        raise HTTPException(status_code=401, detail="invalid email or password")
    if user.email_verified_at is None:
        raise HTTPException(status_code=403, detail=VERIFICATION_REQUIRED_DETAIL)
    if not credentials_valid:
        raise HTTPException(status_code=401, detail="invalid email or password")
    return _token_response(db, settings, user)


@router.post("/google", response_model=TokenPairOut)
def google_login(body: GoogleLoginIn, request: Request, db: DbSession, settings: AppSettings) -> TokenPairOut:
    _require_local_account_authentication(settings)
    _require_public_enrollment(settings)
    if not settings.google_client_id:
        raise HTTPException(status_code=503, detail="Google OAuth is not configured")
    verifier: GoogleTokenVerifier = request.app.state.google_verifier
    identity = verifier.verify(body.id_token, settings.google_client_id)
    if not identity.email_verified:
        raise HTTPException(status_code=401, detail="Google account email is not verified")
    email = normalize_email(identity.email)
    subject_user = db.scalar(select(User).where(User.google_subject == identity.subject).with_for_update())
    email_user = db.scalar(select(User).where(User.email == email).with_for_update())
    if subject_user is not None and email_user is not None and subject_user.id != email_user.id:
        raise HTTPException(status_code=409, detail="Google identity conflicts with an existing account")
    user = subject_user or email_user
    if user is None:
        user = User(
            email=email,
            display_name=identity.display_name,
            google_subject=identity.subject,
            email_verified_at=utcnow(),
        )
        db.add(user)
    elif not user.is_active:
        raise HTTPException(status_code=401, detail="inactive or missing user")
    elif user.google_subject not in (None, identity.subject):
        raise HTTPException(status_code=409, detail="email belongs to another Google identity")
    else:
        was_unverified_preclaim = user.email_verified_at is None
        if was_unverified_preclaim:
            user.password_hash = None
            user.display_name = identity.display_name
            user.auth_generation += 1
            db.execute(delete(RefreshSession).where(RefreshSession.user_id == user.id))
        user.google_subject = identity.subject
        user.email = email
        user.email_verified_at = utcnow()
        user.email_verification_sent_at = None
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(
            status_code=409,
            detail="Google identity conflicts with an existing account",
        ) from exc
    db.refresh(user)
    return _token_response(db, settings, user)


@router.post(
    "/sso",
    response_model=TokenPairOut,
    summary="Exchange a trusted portfolio SSO identity",
    description=(
        "Edge-only exchange. The portfolio proxy injects a stable subject, verified email, "
        "and an application-specific edge secret; browser clients must not construct these headers."
    ),
    responses={
        401: {"description": "Trusted edge identity is missing or invalid."},
        403: {"description": "The matched application account is inactive or not provisioned."},
        409: {"description": "The stable subject and email resolve to conflicting accounts."},
    },
)
def sso_login(request: Request, db: DbSession, settings: AppSettings) -> TokenPairOut:
    if not settings.sso_enabled:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not Found")

    remote_user = trusted_sso_subject(request, settings)
    assert remote_user is not None
    remote_email = request.headers.get("Remote-Email", "").strip()
    if not remote_email:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=SSO_IDENTITY_INVALID)
    try:
        email = normalize_email(str(EMAIL_ADAPTER.validate_python(remote_email)))
    except ValidationError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=SSO_IDENTITY_INVALID,
        ) from exc
    remote_name = request.headers.get("Remote-Name", "").strip()
    display_name = (
        remote_name
        if remote_name
        and len(remote_name) <= 120
        and not any(ord(character) < 32 or ord(character) == 127 for character in remote_name)
        else remote_user[:120]
    )

    subject_user = db.scalar(select(User).where(User.sso_subject == remote_user).with_for_update())
    email_user = db.scalar(select(User).where(User.email == email).with_for_update())
    if subject_user is not None:
        if email_user is not None and email_user.id != subject_user.id:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=SSO_IDENTITY_CONFLICT,
            )
        if not subject_user.is_active:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=SSO_IDENTITY_NOT_PROVISIONED,
            )
        user = subject_user
        # The stable subject is authoritative. A central email/name update is
        # safe only while the new email is not owned by another local identity.
        user.email = email
        user.display_name = display_name
    elif email_user is not None:
        if email_user.sso_subject is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=SSO_IDENTITY_CONFLICT,
            )
        if not email_user.is_active:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=SSO_IDENTITY_NOT_PROVISIONED,
            )
        # One-time legacy-owner link. Email is unique in the database and both
        # rows are locked, so an ambiguous or racing link fails at commit.
        user = email_user
        user.sso_subject = remote_user
        user.password_hash = None
        user.google_subject = None
        user.auth_generation += 1
        db.execute(delete(RefreshSession).where(RefreshSession.user_id == user.id))
        user.display_name = display_name
    elif settings.deployment_profile == "managed_local_sso":
        user = User(
            email=email,
            display_name=display_name,
            password_hash=None,
            google_subject=None,
            sso_subject=remote_user,
            email_verified_at=utcnow(),
            is_active=True,
        )
        db.add(user)
    else:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=SSO_IDENTITY_NOT_PROVISIONED,
        )
    if user.email_verified_at is None:
        user.email_verified_at = utcnow()
        user.email_verification_sent_at = None
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=SSO_IDENTITY_CONFLICT,
        ) from exc
    db.refresh(user)
    return _token_response(db, settings, user)


@router.post("/refresh", response_model=TokenPairOut)
def refresh(
    body: RefreshIn,
    request: Request,
    db: DbSession,
    settings: AppSettings,
) -> TokenPairOut:
    request_subject = trusted_sso_subject(request, settings)
    user, access, refresh_token, expires_in = rotate_refresh_token(
        db,
        settings,
        body.refresh_token,
        expected_sso_subject=request_subject,
    )
    return TokenPairOut(
        access_token=access,
        refresh_token=refresh_token,
        expires_in=expires_in,
        user=user_out(user),
    )


@router.post("/logout", response_model=MessageOut)
def logout(
    body: RefreshIn,
    request: Request,
    db: DbSession,
    settings: AppSettings,
) -> MessageOut:
    request_subject = trusted_sso_subject(request, settings)
    revoke_refresh_token(
        db,
        settings,
        body.refresh_token,
        expected_sso_subject=request_subject,
    )
    return MessageOut(message="logged out")


@users_router.get("/me", response_model=UserOut)
def me(user: CurrentUser) -> UserOut:
    return user_out(user)


@users_router.patch("/me", response_model=UserOut)
def update_me(body: UserUpdate, db: DbSession, user: CurrentUser) -> UserOut:
    user.display_name = body.display_name
    db.commit()
    db.refresh(user)
    return user_out(user)


@users_router.post(
    "/me/delete-challenge",
    response_model=MessageOut,
    status_code=status.HTTP_202_ACCEPTED,
)
def request_account_delete_challenge(
    request: Request,
    response: Response,
    db: DbSession,
    settings: AppSettings,
    user: CurrentUser,
) -> MessageOut:
    _require_local_account_authentication(settings)
    _require_public_email_workflows(settings)
    response.headers["Retry-After"] = str(settings.account_delete_request_seconds)
    account = db.scalar(select(User).where(User.id == user.id).with_for_update())
    if (
        account is None
        or not account.is_active
        or account.email_verified_at is None
        or account.password_hash is not None
        or account.google_subject is None
        or not _cooldown_elapsed(
            account.account_delete_sent_at,
            settings.account_delete_request_seconds,
        )
    ):
        return MessageOut(message=ACCOUNT_DELETE_MESSAGE)
    _deliver_account_delete_attempt(request, db, settings, account)
    return MessageOut(message=ACCOUNT_DELETE_MESSAGE)


@users_router.delete("/me", status_code=status.HTTP_204_NO_CONTENT)
def delete_me(
    body: UserDeleteIn,
    request: Request,
    db: DbSession,
    settings: AppSettings,
    user: CurrentUser,
) -> Response:
    _require_local_account_authentication(settings)
    account = db.scalar(select(User).where(User.id == user.id).with_for_update())
    if account is None or not account.is_active:
        raise HTTPException(status_code=401, detail="inactive or missing user")
    if normalize_email(str(body.email)) != account.email:
        raise HTTPException(status_code=400, detail="confirmation email does not match current account")
    if account.password_hash is not None:
        if body.current_password is None or not verify_password(
            body.current_password,
            account.password_hash,
        ):
            raise HTTPException(status_code=400, detail="current password is required and must be correct")
    else:
        if account.google_subject is None:
            raise HTTPException(status_code=400, detail="account cannot be reauthenticated")
        if body.google_id_token is not None:
            if not settings.google_client_id:
                raise HTTPException(status_code=503, detail="Google OAuth is not configured")
            verifier: GoogleTokenVerifier = request.app.state.google_verifier
            identity = verifier.verify(body.google_id_token, settings.google_client_id)
            if (
                not identity.email_verified
                or identity.subject != account.google_subject
                or normalize_email(identity.email) != account.email
            ):
                raise HTTPException(status_code=400, detail="Google reauthentication does not match account")
        elif body.account_delete_token is not None:
            try:
                token_user_id, token_email, token_google_subject, token_generation = (
                    decode_account_delete_token(settings, body.account_delete_token)
                )
            except TokenError as exc:
                raise HTTPException(
                    status_code=400,
                    detail="invalid or expired account deletion token",
                ) from exc
            if (
                token_user_id != account.id
                or token_email != account.email
                or token_google_subject != account.google_subject
                or token_generation != account.auth_generation
            ):
                raise HTTPException(status_code=400, detail="invalid or expired account deletion token")
        else:
            raise HTTPException(status_code=400, detail="account reauthentication is required")

    owned_groups, owned_scores = _lock_owned_groups_and_scores(db, account.id)
    enqueue_score_cleanup(
        db,
        owned_scores,
        settings,
        reason="account",
    )

    for group in owned_groups:
        db.delete(group)
    db.execute(delete(GroupMember).where(GroupMember.user_id == account.id))
    db.execute(delete(Annotation).where(Annotation.author_id == account.id))
    db.execute(delete(PracticeLog).where(PracticeLog.author_id == account.id))
    db.execute(delete(DeviceCalibration).where(DeviceCalibration.user_id == account.id))
    db.execute(delete(RefreshSession).where(RefreshSession.user_id == account.id))
    db.execute(update(Todo).where(Todo.assignee_id == account.id).values(assignee_id=None))

    account.email = f"deleted-{account.id}@deleted.invalid"
    account.display_name = "Deleted user"
    account.password_hash = None
    account.google_subject = None
    account.email_verified_at = None
    account.email_verification_sent_at = None
    account.password_reset_sent_at = None
    account.account_delete_sent_at = None
    account.auth_generation += 1
    account.is_active = False
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
