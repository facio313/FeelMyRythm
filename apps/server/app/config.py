from __future__ import annotations

import secrets
from functools import cached_property
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

from pydantic import EmailStr, Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

UNSAFE_PRODUCTION_JWT_SECRETS = frozenset(
    {
        "replace-with-a-long-random-value",
        "change-me-before-production-deploy",
    }
)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="FMR_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    environment: Literal["development", "test", "production"] = "development"
    deployment_profile: Literal["standard", "single_user_local"] = "standard"
    database_url: str = "sqlite:///./dev.db"
    auto_create_schema: bool = True

    jwt_secret: SecretStr | None = None
    jwt_issuer: str = "feelmyrythm"
    access_token_minutes: int = 15
    refresh_token_days: int = 30

    google_client_id: str | None = None

    web_app_base_url: str = "http://localhost:5173/feelmyrythm"
    email_verification_minutes: int = Field(default=30, ge=5, le=24 * 60)
    email_verification_resend_seconds: int = Field(default=60, ge=0, le=24 * 60 * 60)
    password_reset_minutes: int = Field(default=30, ge=5, le=24 * 60)
    password_reset_request_seconds: int = Field(default=60, ge=0, le=24 * 60 * 60)
    account_delete_minutes: int = Field(default=15, ge=5, le=60)
    account_delete_request_seconds: int = Field(default=60, ge=0, le=24 * 60 * 60)
    smtp_host: str | None = None
    smtp_port: int = Field(default=587, ge=1, le=65535)
    smtp_username: str | None = None
    smtp_password: SecretStr | None = None
    smtp_from_email: EmailStr | None = None
    smtp_starttls: bool = True
    smtp_use_ssl: bool = False
    mail_worker_count: int = Field(default=2, ge=1, le=16)
    mail_queue_capacity: int = Field(default=128, ge=1, le=10_000)
    mail_shutdown_timeout_seconds: float = Field(default=5.0, ge=0, le=60)
    password_verify_concurrency: int = Field(default=4, ge=1, le=64)

    cors_origins: list[str] = ["http://localhost:5173", "http://127.0.0.1:5173"]
    public_api_base_url: str = "http://localhost:8000"

    storage_backend: Literal["local", "s3"] = "local"
    local_uploads_dir: Path = Path("./uploads")
    max_upload_bytes: int = 50 * 1024 * 1024
    upload_url_ttl_seconds: int = 900
    s3_bucket: str | None = None
    s3_region: str | None = None
    s3_endpoint_url: str | None = None
    storage_worker_enabled: bool = True
    storage_worker_interval_seconds: float = Field(default=30.0, ge=0.1, le=3600)
    storage_delete_batch_size: int = Field(default=100, ge=1, le=10_000)
    storage_delete_lease_seconds: int = Field(default=300, ge=1, le=24 * 60 * 60)
    storage_delete_retry_base_seconds: int = Field(default=5, ge=1, le=24 * 60 * 60)
    storage_delete_retry_max_seconds: int = Field(default=3600, ge=1, le=7 * 24 * 60 * 60)
    pending_upload_grace_seconds: int = Field(default=900, ge=0, le=24 * 60 * 60)
    legacy_pending_upload_ttl_seconds: int = Field(default=24 * 60 * 60, ge=60)
    late_upload_guard_seconds: int = Field(default=24 * 60 * 60, ge=1)
    staging_redelete_interval_seconds: int = Field(default=900, ge=1)
    local_upload_temp_ttl_seconds: int = Field(default=3600, ge=60)

    omr_enabled: bool = True
    omr_audiveris_command: str = "audiveris"
    omr_worker_count: int = Field(default=1, ge=1, le=4)
    omr_timeout_seconds: int = Field(default=300, ge=10, le=3600)

    room_lead_time_ms: int = 3000
    room_ttl_seconds: int = 1800
    room_cleanup_interval_seconds: int = 30
    room_presence_ttl_seconds: int = Field(default=45, ge=30, le=300)
    room_lock_seconds: int = Field(default=5, ge=1, le=30)
    room_lock_wait_seconds: float = Field(default=2.0, ge=0.1, le=30)
    redis_url: str | None = None
    redis_key_prefix: str = "fmr"

    @model_validator(mode="after")
    def validate_environment(self) -> Settings:
        smtp_host_configured = bool(self.smtp_host and self.smtp_host.strip())
        smtp_from_configured = self.smtp_from_email is not None
        if self.environment == "production":
            if self.jwt_secret is None:
                raise ValueError("FMR_JWT_SECRET is required in production")
            if len(self.jwt_secret.get_secret_value()) < 32:
                raise ValueError("FMR_JWT_SECRET must contain at least 32 characters")
            if self.jwt_secret.get_secret_value() in UNSAFE_PRODUCTION_JWT_SECRETS:
                raise ValueError("FMR_JWT_SECRET contains a known deployment placeholder")
            if not self.database_url.startswith(("postgresql://", "postgresql+psycopg://")):
                raise ValueError("production requires a PostgreSQL FMR_DATABASE_URL")
            if self.auto_create_schema:
                raise ValueError("production must use Alembic (FMR_AUTO_CREATE_SCHEMA=false)")
            if not self.storage_worker_enabled:
                raise ValueError("production requires FMR_STORAGE_WORKER_ENABLED=true")
            if self.deployment_profile == "standard":
                if self.storage_backend != "s3":
                    raise ValueError("standard production requires FMR_STORAGE_BACKEND=s3")
                if not self.s3_region or not self.s3_region.strip():
                    raise ValueError("FMR_S3_REGION is required for production S3 storage")
                if not smtp_host_configured or not smtp_from_configured:
                    raise ValueError(
                        "standard production requires FMR_SMTP_HOST and FMR_SMTP_FROM_EMAIL "
                        "for email verification"
                    )
            else:
                if self.storage_backend != "local":
                    raise ValueError("single-user local production requires FMR_STORAGE_BACKEND=local")
                if not self.local_uploads_dir.is_absolute():
                    raise ValueError(
                        "single-user local production requires an absolute FMR_LOCAL_UPLOADS_DIR"
                    )
                if smtp_host_configured or smtp_from_configured:
                    raise ValueError(
                        "single-user local production keeps SMTP disabled; use the standard "
                        "profile after configuring email"
                    )
            web_app_url = urlsplit(self.web_app_base_url)
            if web_app_url.scheme != "https" or not web_app_url.netloc:
                raise ValueError("production FMR_WEB_APP_BASE_URL must be an absolute https URL")
            if web_app_url.query or web_app_url.fragment:
                raise ValueError("production FMR_WEB_APP_BASE_URL cannot contain a query or fragment")
            public_api_url = urlsplit(self.public_api_base_url)
            if public_api_url.scheme != "https" or not public_api_url.netloc:
                raise ValueError("production FMR_PUBLIC_API_BASE_URL must be an absolute https URL")
            if public_api_url.query or public_api_url.fragment:
                raise ValueError("production FMR_PUBLIC_API_BASE_URL cannot contain a query or fragment")
            if self.smtp_starttls == self.smtp_use_ssl:
                raise ValueError("production requires exactly one of FMR_SMTP_STARTTLS or FMR_SMTP_USE_SSL")
            if self.redis_url is None or not self.redis_url.strip():
                raise ValueError("production requires FMR_REDIS_URL for multi-instance room state")
        if smtp_host_configured != smtp_from_configured:
            raise ValueError("FMR_SMTP_HOST and FMR_SMTP_FROM_EMAIL must be configured together")
        if bool(self.smtp_username) != bool(self.smtp_password):
            raise ValueError("FMR_SMTP_USERNAME and FMR_SMTP_PASSWORD must be configured together")
        if self.smtp_starttls and self.smtp_use_ssl:
            raise ValueError("FMR_SMTP_STARTTLS and FMR_SMTP_USE_SSL cannot both be enabled")
        if self.storage_backend == "s3" and (self.s3_bucket is None or not self.s3_bucket.strip()):
            raise ValueError("FMR_S3_BUCKET is required for S3 storage")
        if self.storage_delete_retry_base_seconds > self.storage_delete_retry_max_seconds:
            raise ValueError(
                "FMR_STORAGE_DELETE_RETRY_BASE_SECONDS cannot exceed FMR_STORAGE_DELETE_RETRY_MAX_SECONDS"
            )
        if self.staging_redelete_interval_seconds > self.late_upload_guard_seconds:
            raise ValueError(
                "FMR_STAGING_REDELETE_INTERVAL_SECONDS cannot exceed FMR_LATE_UPLOAD_GUARD_SECONDS"
            )
        if self.omr_enabled and not self.omr_audiveris_command.strip():
            raise ValueError("FMR_OMR_AUDIVERIS_COMMAND is required when OMR is enabled")
        if self.redis_url is not None:
            redis_url = urlsplit(self.redis_url)
            if redis_url.scheme not in {"redis", "rediss"} or not redis_url.hostname:
                raise ValueError("FMR_REDIS_URL must be an absolute redis:// or rediss:// URL")
        if not self.redis_key_prefix.strip() or any(
            character.isspace() for character in self.redis_key_prefix
        ):
            raise ValueError("FMR_REDIS_KEY_PREFIX must be non-empty and contain no whitespace")
        return self

    @property
    def public_email_workflows_enabled(self) -> bool:
        return self.deployment_profile == "standard"

    @cached_property
    def signing_secret(self) -> str:
        if self.jwt_secret is not None:
            return self.jwt_secret.get_secret_value()
        # Development-only process secret: never persisted or embedded in source.
        return secrets.token_urlsafe(48)


def load_settings() -> Settings:
    return Settings()
