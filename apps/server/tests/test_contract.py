from __future__ import annotations

import hashlib
import os
import subprocess
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

import pytest
from alembic.config import Config
from botocore.exceptions import ClientError
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy import inspect, text
from sqlalchemy.exc import IntegrityError

from alembic import command
from app import config as config_module
from app.config import UNSAFE_PRODUCTION_JWT_SECRETS, Settings
from app.main import create_app
from app.models import Base
from app.routers import repertoire
from app.storage import (
    LocalObjectStorage,
    S3ObjectStorage,
)

from .conftest import FakeGoogleVerifier, FakeMailSender


def test_production_settings_require_secret_postgres_and_migrations() -> None:
    with pytest.raises(ValidationError):
        Settings(environment="production")
    with pytest.raises(ValidationError):
        Settings(
            environment="production",
            jwt_secret="too-short",
            database_url="postgresql+psycopg://user:password@db/feelmyrythm",
            auto_create_schema=False,
        )
    with pytest.raises(ValidationError):
        Settings(
            environment="production",
            jwt_secret="runtime-secret-with-at-least-32-characters",
            database_url="sqlite:///prod.db",
            auto_create_schema=False,
        )
    production_base = {
        "environment": "production",
        "jwt_secret": "runtime-secret-with-at-least-32-characters",
        "database_url": "postgresql+psycopg://user:password@db/feelmyrythm",
        "auto_create_schema": False,
        "smtp_host": "smtp.example.test",
        "smtp_from_email": "noreply@example.com",
        "web_app_base_url": "https://example.com/feelmyrythm",
        "public_api_base_url": "https://example.com/feelmyrythm",
        "redis_url": "redis://redis.example.test:6379/0",
    }
    with pytest.raises(ValidationError, match="FMR_STORAGE_BACKEND=s3"):
        Settings(**production_base)
    with pytest.raises(ValidationError, match="FMR_S3_BUCKET"):
        Settings(**production_base, storage_backend="s3", s3_region="ap-northeast-2")
    with pytest.raises(ValidationError, match="FMR_S3_REGION"):
        Settings(**production_base, storage_backend="s3", s3_bucket="scores-bucket")
    with pytest.raises(ValidationError, match="FMR_STORAGE_WORKER_ENABLED=true"):
        Settings(
            **production_base,
            storage_backend="s3",
            s3_bucket="scores-bucket",
            s3_region="ap-northeast-2",
            storage_worker_enabled=False,
        )
    production = Settings(
        **production_base,
        storage_backend="s3",
        s3_bucket="scores-bucket",
        s3_region="ap-northeast-2",
    )
    assert production.storage_backend == "s3"


def test_production_email_verification_configuration_fails_closed() -> None:
    base = {
        "portfolio_branch": "release-candidate",
        "portfolio_auth_mode": "local",
        "environment": "production",
        "jwt_secret": "runtime-secret-with-at-least-32-characters",
        "database_url": "postgresql+psycopg://user:password@db/feelmyrythm",
        "auto_create_schema": False,
        "storage_backend": "s3",
        "s3_bucket": "scores-bucket",
        "s3_region": "ap-northeast-2",
        "web_app_base_url": "https://bonifacio.work/feelmyrythm",
        "public_api_base_url": "https://bonifacio.work/feelmyrythm",
    }
    with pytest.raises(ValidationError, match="FMR_SMTP_HOST"):
        Settings(**base)
    with pytest.raises(ValidationError, match="absolute https URL"):
        Settings(
            **{**base, "web_app_base_url": "http://bonifacio.work/feelmyrythm"},
            smtp_host="smtp.example.test",
            smtp_from_email="noreply@example.com",
        )
    for public_api_base_url in (
        "http://bonifacio.work/feelmyrythm",
        "https://bonifacio.work/feelmyrythm?source=mail",
        "https://bonifacio.work/feelmyrythm#uploads",
    ):
        with pytest.raises(ValidationError, match="FMR_PUBLIC_API_BASE_URL"):
            Settings(
                **{**base, "public_api_base_url": public_api_base_url},
                smtp_host="smtp.example.test",
                smtp_from_email="noreply@example.com",
            )
    with pytest.raises(ValidationError, match="exactly one"):
        Settings(
            **base,
            smtp_host="smtp.example.test",
            smtp_from_email="noreply@example.com",
            smtp_starttls=False,
            smtp_use_ssl=False,
        )


def test_managed_local_sso_production_is_explicit_and_fail_closed() -> None:
    base = {
        "portfolio_branch": "main",
        "portfolio_auth_mode": "sso",
        "environment": "production",
        "deployment_profile": "managed_local_sso",
        "sso_enabled": True,
        "sso_edge_secret": "test-fmr-edge-secret-with-at-least-32-characters",
        "jwt_secret": "runtime-secret-with-at-least-32-characters",
        "database_url": "postgresql+psycopg://user:password@db/feelmyrythm",
        "auto_create_schema": False,
        "storage_backend": "local",
        "local_uploads_dir": "/data/uploads",
        "web_app_base_url": "https://bonifacio.work/feelmyrythm",
        "public_api_base_url": "https://bonifacio.work/feelmyrythm",
        "redis_url": "redis://fmrRedis:6379/0",
    }
    settings = Settings(**base)
    assert settings.public_email_workflows_enabled is False
    assert settings.sso_enabled is True
    assert settings.sso_edge_secret is not None
    assert settings.local_uploads_dir == Path("/data/uploads")

    with pytest.raises(ValidationError, match="FMR_STORAGE_BACKEND=local"):
        Settings(**{**base, "storage_backend": "s3", "s3_bucket": "scores"})
    with pytest.raises(ValidationError, match="absolute FMR_LOCAL_UPLOADS_DIR"):
        Settings(**{**base, "local_uploads_dir": "uploads"})
    with pytest.raises(ValidationError, match="keeps SMTP disabled"):
        Settings(
            **base,
            smtp_host="smtp.example.test",
            smtp_from_email="noreply@example.com",
        )
    with pytest.raises(ValidationError, match="FMR_SSO_ENABLED conflicts"):
        Settings(**{**base, "sso_enabled": False})
    with pytest.raises(ValidationError, match="32 to 4096 printable characters"):
        Settings(**{**base, "sso_edge_secret": "too-short"})


def test_managed_local_sso_prefers_a_bounded_private_secret_file(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    secret_file = tmp_path / "fmr-edge-secret"
    file_secret = "file-backed-edge-secret-with-at-least-32-characters"
    secret_file.write_text(file_secret, encoding="ascii")
    secret_file.chmod(0o640)
    real_fstat = os.fstat
    effective_gid = {"value": 0}
    container_ownership = {"uid": 0, "gid": 0}

    def container_fstat(file_descriptor: int) -> os.stat_result:
        metadata = list(real_fstat(file_descriptor))
        metadata[4] = container_ownership["uid"]
        metadata[5] = container_ownership["gid"]
        return os.stat_result(metadata)

    monkeypatch.setattr("app.config.os.fstat", container_fstat)
    monkeypatch.setattr("app.config.os.getegid", lambda: effective_gid["value"])
    base = {
        "portfolio_branch": "main",
        "portfolio_auth_mode": "sso",
        "environment": "production",
        "deployment_profile": "managed_local_sso",
        "sso_enabled": True,
        "sso_edge_secret": "different-fallback-secret-with-at-least-32-characters",
        "sso_edge_secret_file": secret_file,
        "jwt_secret": "runtime-secret-with-at-least-32-characters",
        "database_url": "postgresql+psycopg://user:password@db/feelmyrythm",
        "auto_create_schema": False,
        "storage_backend": "local",
        "local_uploads_dir": "/data/uploads",
        "web_app_base_url": "https://bonifacio.work/feelmyrythm",
        "public_api_base_url": "https://bonifacio.work/feelmyrythm",
        "redis_url": "redis://fmrRedis:6379/0",
    }
    settings = Settings(**base)
    assert settings.resolved_sso_edge_secret == file_secret

    secret_file.chmod(0o600)
    with pytest.raises(ValidationError, match="container mode 0640"):
        Settings(**base)

    secret_file.chmod(0o640)
    container_ownership["uid"] = 10001
    with pytest.raises(ValidationError, match="container root:root"):
        Settings(**base)
    container_ownership["uid"] = 0

    effective_gid["value"] = 10001
    with pytest.raises(ValidationError, match="effective GID 0"):
        Settings(**base)
    effective_gid["value"] = 0

    secret_file.write_text("short", encoding="ascii")
    with pytest.raises(ValidationError, match="32 to 4096 bytes") as error:
        Settings(**base)
    assert file_secret not in str(error.value)

    secret_file.write_text("x" * 4097, encoding="ascii")
    with pytest.raises(ValidationError, match="32 to 4096 bytes"):
        Settings(**base)

    with pytest.raises(ValidationError, match="regular file"):
        Settings(**{**base, "sso_edge_secret_file": tmp_path})


@pytest.mark.repository_contract
def test_env_example_loads_as_the_production_settings_contract(tmp_path: Path) -> None:
    repository_root = Path(__file__).resolve().parents[3]
    example = (repository_root / ".env.example").read_text()
    configured = (
        example.replace("PORTFOLIO_BRANCH=\n", "PORTFOLIO_BRANCH=test\n")
        .replace("PORTFOLIO_AUTH_MODE=\n", "PORTFOLIO_AUTH_MODE=local\n")
        .replace(
            "FMR_JWT_SECRET=\n",
            "FMR_JWT_SECRET=runtime-secret-with-at-least-32-characters\n",
        )
        .replace("FMR_SMTP_HOST=\n", "FMR_SMTP_HOST=smtp.example.com\n")
        .replace("FMR_SMTP_FROM_EMAIL=\n", "FMR_SMTP_FROM_EMAIL=noreply@example.com\n")
        .replace("FMR_S3_BUCKET=\n", "FMR_S3_BUCKET=scores-bucket\n")
    )
    runtime_env = tmp_path / "production.env"
    runtime_env.write_text(configured)

    settings = Settings(_env_file=runtime_env)

    assert settings.environment == "production"
    assert settings.portfolio_branch == "test"
    assert settings.portfolio_auth_mode == "local"
    assert settings.deployment_profile == "standard"
    assert settings.sso_enabled is False
    assert settings.sso_edge_secret is not None
    assert settings.sso_edge_secret.get_secret_value() == ""
    assert settings.web_app_base_url == "https://bonifacio.work/feelmyrythm"
    assert settings.smtp_host == "smtp.example.com"
    assert str(settings.smtp_from_email) == "noreply@example.com"
    assert settings.smtp_port == 587
    assert settings.smtp_starttls is True
    assert settings.smtp_use_ssl is False
    assert not settings.smtp_username
    assert not settings.smtp_password
    assert settings.mail_worker_count == 2
    assert settings.mail_queue_capacity == 128
    assert settings.mail_shutdown_timeout_seconds == 5
    assert settings.password_verify_concurrency == 4
    assert settings.public_api_base_url == "https://bonifacio.work/feelmyrythm"
    assert settings.storage_backend == "s3"
    assert settings.s3_bucket == "scores-bucket"
    assert settings.s3_region == "ap-northeast-2"
    assert settings.storage_worker_enabled is True
    assert settings.storage_worker_interval_seconds == 30
    assert settings.storage_delete_batch_size == 100
    assert settings.storage_delete_lease_seconds == 300
    assert settings.storage_delete_retry_base_seconds == 5
    assert settings.storage_delete_retry_max_seconds == 3600
    assert settings.pending_upload_grace_seconds == 900
    assert settings.legacy_pending_upload_ttl_seconds == 86400
    assert settings.late_upload_guard_seconds == 86400
    assert settings.staging_redelete_interval_seconds == 900
    assert settings.local_upload_temp_ttl_seconds == 3600
    assert settings.omr_enabled is False
    assert settings.omr_audiveris_command == "audiveris"
    assert settings.omr_worker_count == 1
    assert settings.omr_timeout_seconds == 300
    assert settings.redis_url == "redis://fmrRedis:6379/0"
    assert settings.room_presence_ttl_seconds == 45
    assert settings.room_lock_seconds == 5
    assert settings.room_lock_wait_seconds == 2


@pytest.mark.repository_contract
def test_production_compose_passes_required_runtime_settings() -> None:
    repository_root = Path(__file__).resolve().parents[3]
    compose = (repository_root / "docker-compose.prod.yml").read_text()
    nginx = (repository_root / "nginx/nginx.conf").read_text()
    redis_service = compose.split("  fmrRedis:\n", 1)[1].split("\n  fmrServer:\n", 1)[0]
    server_service = compose.split("  fmrServer:\n", 1)[1].split("\n  fmrWeb:\n", 1)[0]
    websocket_proxy = nginx.split("    location /feelmyrythm/ws/ {\n", 1)[1].split("\n    }", 1)[0]
    networks = compose.split("\nnetworks:\n", 1)[1].split("\nvolumes:\n", 1)[0]
    backend_network = networks.split("  feelmyrythm-backend:\n", 1)[1].split("\n  cksDB:\n", 1)[0]
    volumes = compose.split("\nvolumes:\n", 1)[1]

    required_lines = {
        "PORTFOLIO_BRANCH: ${PORTFOLIO_BRANCH:?set the deployed source branch}",
        "PORTFOLIO_AUTH_MODE: ${PORTFOLIO_AUTH_MODE:?resolve the branch auth contract}",
        "FMR_DEPLOYMENT_PROFILE: managed_local_sso",
        "FMR_SSO_ENABLED: 'true'",
        "FMR_SSO_EDGE_SECRET_FILE: /run/secrets/fmr_sso_edge_secret",
        "FMR_PUBLIC_API_BASE_URL: ${FMR_PUBLIC_API_BASE_URL:?set the public API base URL}",
        "FMR_REDIS_URL: redis://fmrRedis:6379/0",
        "FMR_ROOM_PRESENCE_TTL_SECONDS: ${FMR_ROOM_PRESENCE_TTL_SECONDS:-45}",
        "FMR_STORAGE_BACKEND: local",
        "FMR_LOCAL_UPLOADS_DIR: /data/uploads",
        "FMR_MAIL_WORKER_COUNT: ${FMR_MAIL_WORKER_COUNT:-2}",
        "FMR_MAIL_QUEUE_CAPACITY: ${FMR_MAIL_QUEUE_CAPACITY:-128}",
        "FMR_MAIL_SHUTDOWN_TIMEOUT_SECONDS: ${FMR_MAIL_SHUTDOWN_TIMEOUT_SECONDS:-5}",
        "FMR_PASSWORD_VERIFY_CONCURRENCY: ${FMR_PASSWORD_VERIFY_CONCURRENCY:-4}",
        "FMR_STORAGE_WORKER_ENABLED: 'true'",
        "FMR_STORAGE_DELETE_LEASE_SECONDS: ${FMR_STORAGE_DELETE_LEASE_SECONDS:-300}",
        "FMR_STORAGE_DELETE_RETRY_MAX_SECONDS: ${FMR_STORAGE_DELETE_RETRY_MAX_SECONDS:-3600}",
        "FMR_PENDING_UPLOAD_GRACE_SECONDS: ${FMR_PENDING_UPLOAD_GRACE_SECONDS:-900}",
        "FMR_LATE_UPLOAD_GUARD_SECONDS: ${FMR_LATE_UPLOAD_GUARD_SECONDS:-86400}",
        "FMR_STAGING_REDELETE_INTERVAL_SECONDS: ${FMR_STAGING_REDELETE_INTERVAL_SECONDS:-900}",
        "FMR_OMR_ENABLED: 'false'",
        "FMR_OMR_AUDIVERIS_COMMAND: ${FMR_OMR_AUDIVERIS_COMMAND:-audiveris}",
    }
    assert all(line in server_service for line in required_lines)
    assert (
        "redis:8.2.7-alpine@sha256:223b183cbc49f5ff48728e1fc52ccf101f05072decad2bd9867281a3c9bf75fd"
    ) in redis_service
    assert "ports:" not in redis_service
    assert "read_only: true" in redis_service
    assert "['redis-server', '--appendonly', 'yes', '--appendfsync', 'everysec']" in redis_service
    assert "['CMD', 'redis-cli', 'ping']" in redis_service
    assert "fmr_redis_data:/data" in redis_service
    assert "feelmyrythm-backend" in redis_service
    assert "depends_on:\n      fmrRedis:\n        condition: service_healthy" in server_service
    assert "feelmyrythm-backend" in server_service
    assert "no-new-privileges:true" in server_service
    assert "cap_drop:\n      - ALL" in server_service
    assert "internal: true" in backend_network
    assert "fmr_redis_data:" in volumes
    assert "fmr_uploads:/data/uploads" in server_service
    assert (
        "${FMR_SSO_EDGE_SECRET_FILE:?set the cks-owned mode-0640 host secret path}:"
        "/run/secrets/fmr_sso_edge_secret:ro" in server_service
    )
    assert "user: '10001:0'" in server_service
    assert "fmr_uploads:" in volumes
    assert "name: feelmyrythm-fmr-uploads" in volumes
    assert "FMR_SMTP_HOST:" not in server_service
    assert "FMR_S3_BUCKET:" not in server_service
    assert "proxy_set_header X-Portfolio-Edge-Secret $http_x_portfolio_edge_secret;" in nginx
    for trusted_header in (
        "Remote-User",
        "Remote-Email",
        "Remote-Name",
        "Remote-Groups",
        "X-Portfolio-Edge-Secret",
    ):
        assert f"proxy_set_header {trusted_header} " in websocket_proxy


@pytest.mark.repository_contract
def test_temporary_web_release_exposes_the_operator_todo_contract() -> None:
    repository_root = Path(__file__).resolve().parents[3]
    workflow = (repository_root / ".github/workflows/deploy.yml").read_text()
    web_dockerfile = (repository_root / "apps/web/Dockerfile").read_text()
    server_dockerfile = (repository_root / "apps/server/Dockerfile").read_text()
    notice = (repository_root / "apps/web/src/components/TemporaryOperationsNotice.tsx").read_text()

    assert "VITE_FMR_MANAGED_LOCAL_SSO=true" in workflow
    assert "VITE_FMR_SSO_ENABLED=true" in workflow
    assert "ARG PORTFOLIO_BRANCH" in web_dockerfile
    assert "ARG PORTFOLIO_AUTH_MODE" in web_dockerfile
    assert "ARG VITE_FMR_MANAGED_LOCAL_SSO" in web_dockerfile
    assert "ARG VITE_FMR_SSO_ENABLED" in web_dockerfile
    assert "ENV PORTFOLIO_AUTH_MODE=${PORTFOLIO_AUTH_MODE}" in web_dockerfile
    assert "ENV VITE_FMR_MANAGED_LOCAL_SSO=${VITE_FMR_MANAGED_LOCAL_SSO}" in web_dockerfile
    assert "install -d -o 10001 -g 10001 -m 0750 /data/uploads" in server_dockerfile
    for task in (
        "악보 파일을 서버 전용 영구 볼륨에 저장",
        "중앙 통합 로그인 계정을 자동 연결",
        "AWS S3를 준비하고 로컬 악보 파일 이관",
        "SMTP 발송 도메인과 키 설정",
        "로컬 파일 백업과 복구 절차 확정",
        "모바일 연결 파일과 OMR 운영 의존성 완성",
    ):
        assert task in notice


def test_portfolio_auth_contract_drives_and_checks_the_legacy_sso_adapter(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    edge_secret = "test-fmr-edge-secret-with-at-least-32-characters"
    for branch in ("main", "dev", "refs/heads/main"):
        settings = Settings(
            _env_file=None,
            portfolio_branch=branch,
            portfolio_auth_mode="sso",
            sso_edge_secret=edge_secret,
        )
        assert settings.portfolio_branch in {"main", "dev"}
        assert settings.sso_enabled is True

    local = Settings(
        _env_file=None,
        portfolio_branch="feature/local-auth",
        portfolio_auth_mode="local",
    )
    assert local.sso_enabled is False

    with pytest.raises(ValidationError, match="requires PORTFOLIO_AUTH_MODE=sso"):
        Settings(
            _env_file=None,
            portfolio_branch="main",
            portfolio_auth_mode="local",
        )
    with pytest.raises(ValidationError, match="FMR_SSO_ENABLED conflicts"):
        Settings(
            _env_file=None,
            portfolio_branch="feature/local-auth",
            portfolio_auth_mode="local",
            sso_enabled=True,
        )
    with pytest.raises(ValidationError, match="FMR_SSO_EDGE_SECRET"):
        Settings(
            _env_file=None,
            portfolio_branch="dev",
            portfolio_auth_mode="sso",
        )

    monkeypatch.delenv("PORTFOLIO_BRANCH")
    monkeypatch.delenv("PORTFOLIO_AUTH_MODE")
    with pytest.raises(ValidationError, match="PORTFOLIO_BRANCH"):
        Settings(_env_file=None)


def test_server_image_contract_cannot_be_changed_at_runtime(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    build_contract = tmp_path / "portfolio-auth-build"
    build_contract.write_text("main\nsso\n", encoding="ascii")
    monkeypatch.setattr(config_module, "PORTFOLIO_BUILD_CONTRACT_PATH", build_contract)

    matching = Settings(
        _env_file=None,
        portfolio_branch="main",
        portfolio_auth_mode="sso",
        sso_edge_secret="test-fmr-edge-secret-with-at-least-32-characters",
    )
    assert matching.portfolio_branch == "main"

    with pytest.raises(ValidationError, match="differs from the immutable server image"):
        Settings(
            _env_file=None,
            portfolio_branch="runtime-smoke",
            portfolio_auth_mode="local",
        )
    with pytest.raises(ValidationError, match="differs from the immutable server image"):
        Settings(
            _env_file=None,
            portfolio_branch="dev",
            portfolio_auth_mode="sso",
        )

    build_contract.write_text("main\nlocal\n", encoding="ascii")
    with pytest.raises(ValidationError, match="invalid branch/mode mapping"):
        Settings(
            _env_file=None,
            portfolio_branch="main",
            portfolio_auth_mode="sso",
            sso_edge_secret="test-fmr-edge-secret-with-at-least-32-characters",
        )

    build_contract.write_text("main\nsso", encoding="ascii")
    with pytest.raises(ValidationError, match="must contain branch and mode"):
        Settings(
            _env_file=None,
            portfolio_branch="main",
            portfolio_auth_mode="sso",
            sso_edge_secret="test-fmr-edge-secret-with-at-least-32-characters",
        )

    target_contract = tmp_path / "portfolio-auth-build-target"
    target_contract.write_text("main\nsso\n", encoding="ascii")
    build_contract.unlink()
    build_contract.symlink_to(target_contract)
    with pytest.raises(ValidationError, match="regular image file"):
        Settings(
            _env_file=None,
            portfolio_branch="main",
            portfolio_auth_mode="sso",
            sso_edge_secret="test-fmr-edge-secret-with-at-least-32-characters",
        )


@pytest.mark.repository_contract
def test_shared_portfolio_auth_resolver_is_pinned_and_executable() -> None:
    repository_root = Path(__file__).resolve().parents[3]
    resolver = repository_root / "scripts/portfolio-auth-mode.sh"
    resolver_test = repository_root / "scripts/test-portfolio-auth-mode.sh"

    assert hashlib.sha256(resolver.read_bytes()).hexdigest() == (
        "93d730a2507336c9bfcec3444bc83847b319e41c71dc4d6188f068abf12383ee"
    )
    assert resolver.stat().st_mode & 0o111
    assert resolver_test.stat().st_mode & 0o111
    completed = subprocess.run(
        [str(resolver_test)],
        cwd=repository_root,
        check=True,
        capture_output=True,
        text=True,
    )
    assert completed.stdout.strip() == "portfolio auth mode contract: ok"


@pytest.mark.repository_contract
def test_portfolio_auth_contract_is_injected_into_builds_and_containers() -> None:
    repository_root = Path(__file__).resolve().parents[3]
    ci = (repository_root / ".github/workflows/ci.yml").read_text()
    deploy = (repository_root / ".github/workflows/deploy.yml").read_text()
    development_compose = (repository_root / "docker-compose.yml").read_text()
    production_compose = (repository_root / "docker-compose.prod.yml").read_text()
    runtime_smoke = (repository_root / ".github/scripts/smoke-runtime-images.sh").read_text()
    package_manifest = (repository_root / "package.json").read_text()
    server_dockerfile = (repository_root / "apps/server/Dockerfile").read_text()
    web_dockerfile = (repository_root / "apps/web/Dockerfile").read_text()
    web_runtime_contract = (repository_root / "apps/web/docker/40-validate-portfolio-auth.sh").read_text()
    alembic_environment = (repository_root / "apps/server/alembic/env.py").read_text()
    operations = (repository_root / "docs/OPERATIONS.md").read_text()

    assert ci.count("name: Resolve portfolio auth contract") == 5
    assert "PORTFOLIO_BRANCH: ${{ github.head_ref || github.ref_name }}" in ci
    assert "sh scripts/portfolio-auth-mode.sh print" in ci
    assert "PORTFOLIO_BRANCH: ${{ github.event.workflow_run.head_branch }}" in deploy
    assert "PORTFOLIO_BRANCH=${{ steps.portfolio_auth.outputs.branch }}" in deploy
    assert "PORTFOLIO_AUTH_MODE=${{ steps.portfolio_auth.outputs.auth_mode }}" in deploy
    assert "branches:\n      - dev\n      - main" in deploy
    assert deploy.count("if: github.event.workflow_run.head_branch == 'main'") == 3
    assert ":latest" not in deploy
    assert development_compose.count("PORTFOLIO_BRANCH:") >= 4
    assert development_compose.count("PORTFOLIO_AUTH_MODE:") >= 4
    assert production_compose.count("PORTFOLIO_BRANCH:") >= 2
    assert production_compose.count("PORTFOLIO_AUTH_MODE:") >= 2
    assert '[[ "$PORTFOLIO_AUTH_MODE" == "sso" ]]' in runtime_smoke
    assert "PORTFOLIO_BRANCH=${PORTFOLIO_BRANCH}" in runtime_smoke
    assert "PORTFOLIO_AUTH_MODE=${PORTFOLIO_AUTH_MODE}" in runtime_smoke
    assert "differs from the immutable server image contract" in runtime_smoke
    assert "does not match image" in runtime_smoke
    assert "FROM base AS portfolio-contract" in server_dockerfile
    assert "FROM portfolio-contract AS runtime" in server_dockerfile
    assert "COPY scripts/portfolio-auth-mode.sh /usr/local/bin/portfolio-auth-mode" in server_dockerfile
    assert "RUN portfolio-auth-mode check" in server_dockerfile
    assert "/etc/portfolio-auth-build" in server_dockerfile
    assert "load_settings()' && alembic upgrade head" in server_dockerfile
    assert "load_settings().database_url" in alembic_environment
    assert "FROM nginx:1.29.4-alpine" in web_dockerfile
    assert "ENV PORTFOLIO_BRANCH=${PORTFOLIO_BRANCH}" in web_dockerfile
    assert "work.bonifacio.portfolio.auth-mode=${PORTFOLIO_AUTH_MODE}" in web_dockerfile
    assert "/etc/portfolio-auth-build" in web_dockerfile
    assert "portfolio-auth-mode check" in web_runtime_contract
    assert (repository_root / "apps/web/docker/40-validate-portfolio-auth.sh").stat().st_mode & 0o111
    assert '"portfolio-auth:check": "scripts/test-portfolio-auth-mode.sh"' in package_manifest
    assert (
        '"dev": "PORTFOLIO_AUTH_MODE=local scripts/portfolio-auth-mode.sh exec -- '
        'corepack pnpm --filter @feelmyrythm/web dev"'
    ) in package_manifest
    assert "FMR_SSO_ENABLED: 'false'" in development_compose
    assert "VITE_FMR_SSO_ENABLED: 'false'" in development_compose
    assert not (repository_root / "apps/server/scripts/bootstrap_single_user.py").exists()
    assert "bootstrap_single_user.py" not in operations


@pytest.mark.parametrize("unsafe_secret", sorted(UNSAFE_PRODUCTION_JWT_SECRETS))
def test_production_settings_reject_known_jwt_sentinels(unsafe_secret: str) -> None:
    with pytest.raises(ValidationError, match="known deployment placeholder"):
        Settings(
            environment="production",
            jwt_secret=unsafe_secret,
            database_url="postgresql+psycopg://user:password@db/feelmyrythm",
            auto_create_schema=False,
        )


def test_openapi_exposes_http_and_websocket_source_schemas(client: TestClient) -> None:
    document = client.get("/openapi.json").json()
    assert "/api/repertoire/{repertoire_id}/tempomap" in document["paths"]
    assert "/api/scores/{score_id}/omr-drafts" in document["paths"]
    assert "/api/omr-drafts/{job_id}" in document["paths"]
    for auth_path in (
        "/api/auth/sso",
        "/api/auth/register",
        "/api/auth/verify-email",
        "/api/auth/resend-verification",
        "/api/auth/request-password-reset",
        "/api/auth/reset-password",
        "/api/users/me/delete-challenge",
    ):
        assert auth_path in document["paths"]
    account_delete = document["paths"]["/api/users/me"]["delete"]
    assert account_delete["requestBody"]["content"]["application/json"]["schema"] == {
        "$ref": "#/components/schemas/UserDeleteIn"
    }
    assert "204" in account_delete["responses"]
    schemas = document["components"]["schemas"]
    assert schemas["UserDeleteIn"]["required"] == ["email"]
    assert set(schemas["UserDeleteIn"]["properties"]) == {
        "email",
        "currentPassword",
        "googleIdToken",
        "accountDeleteToken",
    }
    assert set(schemas["RegisterIn"]["required"]) == {"email", "displayName"}
    assert "password" not in schemas["RegisterIn"]["properties"]
    assert set(schemas["EmailVerificationCompleteIn"]["required"]) == {
        "token",
        "password",
        "passwordConfirmation",
    }
    assert set(schemas["PasswordResetCompleteIn"]["required"]) == {
        "token",
        "password",
        "passwordConfirmation",
    }
    assert "hasPassword" in schemas["UserOut"]["required"]
    assert "WsClientMessage" in schemas
    assert "WsServerMessage" in schemas
    assert "ServerEnvelope" in schemas
    assert schemas["WsClientMessage"]["discriminator"]["propertyName"] == "type"
    assert schemas["WsServerMessage"]["discriminator"]["propertyName"] == "type"
    assert schemas["TempoMapWrite"]["properties"]["data"] == {"$ref": "#/components/schemas/TempoMapData"}
    assert schemas["JoinRoomPayload"]["properties"]["bluetooth"]["type"] == "boolean"
    assert "bluetooth" in schemas["RosterMember"]["required"]


def test_log_detail_get_route_is_declared_once(client: TestClient) -> None:
    matching = [
        route
        for route in repertoire.router.routes
        if getattr(route, "path", None) == "/api/logs/{log_id}" and "GET" in getattr(route, "methods", set())
    ]
    assert len(matching) == 1


def test_all_declared_domain_tables_are_created(client: TestClient) -> None:
    expected = {
        "users",
        "group_members",
        "groups",
        "projects",
        "repertoire_items",
        "tempo_map_revisions",
        "scores",
        "storage_deletion_jobs",
        "measure_maps",
        "omr_draft_jobs",
        "annotations",
        "practice_logs",
        "todos",
        "practice_sessions",
        "device_calibrations",
        "refresh_sessions",
    }
    actual = set(inspect(client.app.state.database.engine).get_table_names())
    assert expected <= actual
    assert expected == set(Base.metadata.tables)


def test_application_lifespan_starts_and_stops_storage_worker(settings: Settings) -> None:
    enabled = settings.model_copy(
        update={
            "storage_worker_enabled": True,
            "storage_worker_interval_seconds": 60.0,
        }
    )
    with TestClient(
        create_app(
            enabled,
            google_verifier=FakeGoogleVerifier(),
            mail_sender=FakeMailSender(),
        )
    ) as test_client:
        worker = test_client.app.state.storage_lifecycle
        assert worker.running is True
    assert worker.running is False


def test_alembic_initial_migration_round_trip(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    server_root = Path(__file__).resolve().parents[1]
    database_path = tmp_path / "migration.db"
    monkeypatch.chdir(server_root)
    monkeypatch.setenv("FMR_DATABASE_URL", f"sqlite:///{database_path}")
    configuration = Config(str(server_root / "alembic.ini"))
    command.upgrade(configuration, "head")

    from sqlalchemy import create_engine

    engine = create_engine(f"sqlite:///{database_path}")
    database_inspector = inspect(engine)
    assert set(Base.metadata.tables) <= set(database_inspector.get_table_names())
    assert any(column["name"] == "sso_subject" for column in database_inspector.get_columns("users"))
    sso_indexes = [
        index for index in database_inspector.get_indexes("users") if index["name"] == "ix_users_sso_subject"
    ]
    assert len(sso_indexes) == 1
    assert sso_indexes[0]["unique"] == 1
    with engine.begin() as connection:
        connection.execute(
            text(
                """
                INSERT INTO users (
                    id, email, display_name, password_hash, google_subject, sso_subject,
                    email_verified_at, email_verification_sent_at, password_reset_sent_at,
                    account_delete_sent_at, auth_generation, is_active, created_at, updated_at
                ) VALUES (
                    'sso-immutable-user', 'immutable@example.com', 'Immutable', NULL, NULL,
                    'central-immutable', CURRENT_TIMESTAMP, NULL, NULL, NULL, 0, TRUE,
                    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
                )
                """
            )
        )
    with pytest.raises(IntegrityError, match="sso_subject is immutable"):
        with engine.begin() as connection:
            connection.execute(
                text("UPDATE users SET sso_subject = 'central-reassigned' WHERE id = 'sso-immutable-user'")
            )
    command.downgrade(configuration, "base")
    assert inspect(engine).get_table_names() == ["alembic_version"]
    engine.dispose()


def test_email_verification_migration_invalidates_legacy_sessions(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    server_root = Path(__file__).resolve().parents[1]
    database_path = tmp_path / "legacy-auth.db"
    database_url = f"sqlite:///{database_path}"
    monkeypatch.chdir(server_root)
    monkeypatch.setenv("FMR_DATABASE_URL", database_url)
    configuration = Config(str(server_root / "alembic.ini"))
    command.upgrade(configuration, "b881b6589baa")

    from sqlalchemy import create_engine

    engine = create_engine(database_url)
    users = [
        {
            "id": "password-user",
            "email": "password@example.com",
            "display_name": "Password",
            "password_hash": "legacy-password-hash",
            "google_subject": None,
        },
        {
            "id": "google-user",
            "email": "google@example.com",
            "display_name": "Google",
            "password_hash": "preclaim-password-hash",
            "google_subject": "google-subject",
        },
    ]
    with engine.begin() as connection:
        for user in users:
            connection.execute(
                text(
                    "INSERT INTO users "
                    "(id, email, display_name, password_hash, google_subject, is_active, "
                    "created_at, updated_at) "
                    "VALUES (:id, :email, :display_name, :password_hash, :google_subject, 1, "
                    "CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
                ),
                user,
            )
            connection.execute(
                text(
                    "INSERT INTO refresh_sessions "
                    "(id, user_id, token_hash, expires_at, revoked_at, created_at) "
                    "VALUES (:id, :user_id, :token_hash, CURRENT_TIMESTAMP, NULL, CURRENT_TIMESTAMP)"
                ),
                {
                    "id": f"session-{user['id']}",
                    "user_id": user["id"],
                    "token_hash": user["id"].encode().ljust(32, b"0"),
                },
            )

    command.upgrade(configuration, "head")
    with engine.connect() as connection:
        migrated = {
            row.email: row
            for row in connection.execute(
                text("SELECT email, password_hash, email_verified_at, auth_generation FROM users")
            ).mappings()
        }
        session_count = connection.scalar(text("SELECT COUNT(*) FROM refresh_sessions"))
    assert migrated["password@example.com"]["email_verified_at"] is None
    assert migrated["password@example.com"]["password_hash"] is None
    assert migrated["password@example.com"]["auth_generation"] == 2
    assert migrated["google@example.com"]["email_verified_at"] is not None
    assert migrated["google@example.com"]["password_hash"] is None
    assert migrated["google@example.com"]["auth_generation"] == 1
    assert session_count == 0
    engine.dispose()


def test_s3_adapter_generates_bounded_presigned_upload(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}
    client_options: dict[str, object] = {}
    copied: list[dict[str, object]] = []
    objects = {"staging/key.pdf": 123}

    class FakeS3Client:
        def generate_presigned_post(self, **kwargs: object) -> dict[str, object]:
            captured.update(kwargs)
            return {"url": "https://objects.example/upload", "fields": {"key": "scores/key.pdf"}}

        def generate_presigned_url(self, *_: object, **__: object) -> str:
            return "https://objects.example/download"

        def head_object(self, **kwargs: object) -> dict[str, int]:
            key = str(kwargs["Key"])
            if key not in objects:
                raise ClientError({"Error": {"Code": "404"}}, "HeadObject")
            return {"ContentLength": objects[key]}

        def copy_object(self, **kwargs: object) -> None:
            copied.append(kwargs)
            source = kwargs["CopySource"]
            assert isinstance(source, dict)
            objects[str(kwargs["Key"])] = objects[str(source["Key"])]

        def delete_object(self, **_: object) -> None:
            return None

    def fake_boto_client(*_: object, **kwargs: object) -> FakeS3Client:
        client_options.update(kwargs)
        return FakeS3Client()

    monkeypatch.setattr("app.storage.boto3.client", fake_boto_client)
    storage = S3ObjectStorage(
        Settings(
            storage_backend="s3",
            s3_bucket="scores-bucket",
            s3_endpoint_url="",
            jwt_secret="runtime-test-secret",
        )
    )
    target = storage.create_upload_target("staging/key.pdf", "application/pdf", 123)
    assert target.method == "POST"
    assert target.url == "https://objects.example/upload"
    assert captured["Bucket"] == "scores-bucket"
    assert client_options["endpoint_url"] is None
    assert ["content-length-range", 123, 123] in captured["Conditions"]  # type: ignore[operator]
    assert captured["Key"] == "staging/key.pdf"
    assert storage.exists("staging/key.pdf", 123) is True
    assert storage.exists("scores/key.pdf", 123) is False
    storage.promote("staging/key.pdf", "scores/key.pdf", 123)
    storage.promote("staging/key.pdf", "scores/key.pdf", 123)
    assert len(copied) == 1
    assert copied[0]["Key"] == "scores/key.pdf"
    assert storage.create_download_url("scores/key.pdf")[0] == "https://objects.example/download"


def test_local_storage_urls_encode_reserved_filename_characters(tmp_path: Path) -> None:
    storage = LocalObjectStorage(
        Settings(
            local_uploads_dir=tmp_path / "uploads",
            public_api_base_url="https://example.test",
            jwt_secret="runtime-test-secret-with-at-least-32-characters",
        )
    )
    storage_key = "scores/repertoire/violin #1?.pdf"
    urls = [
        storage.create_upload_target(storage_key, "application/pdf", 12).url,
        storage.create_download_url(storage_key)[0],
    ]

    for url in urls:
        parsed = urlsplit(url)
        assert unquote(parsed.path).endswith(f"/{storage_key}")
        assert set(parse_qs(parsed.query)) == {"token"}
        assert parsed.fragment == ""
