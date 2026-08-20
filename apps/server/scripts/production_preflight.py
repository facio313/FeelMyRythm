"""Fail-closed, mostly read-only production dependency preflight.

The command never prints credentials. S3 mutation and SMTP delivery are opt-in flags;
all default checks only authenticate and inspect provider configuration.
"""

from __future__ import annotations

import argparse
import json
import os
import smtplib
import ssl
import sys
import uuid
from collections.abc import Callable, Sequence
from dataclasses import asdict, dataclass
from email.message import EmailMessage
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

import boto3
import redis
from alembic.config import Config
from alembic.migration import MigrationContext
from alembic.script import ScriptDirectory
from sqlalchemy import create_engine, text

SERVER_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER_ROOT))

from app.config import Settings  # noqa: E402

EXPECTED_ANDROID_PACKAGE = "work.bonifacio.feelmyrythm"
EXPECTED_IOS_BUNDLE = "work.bonifacio.feelmyrythm"
EXPECTED_LINK_PATHS = {
    "/feelmyrythm/session/*",
    "/feelmyrythm/login",
    "/feelmyrythm/settings",
}


@dataclass(frozen=True)
class CheckResult:
    name: str
    status: str
    detail: str


def validate_s3_configuration(
    cors: dict[str, Any],
    lifecycle: dict[str, Any],
    *,
    web_origin: str,
    minimum_staging_retention_seconds: int = 0,
) -> dict[str, int]:
    matching_rules = [
        rule for rule in cors.get("CORSRules", []) if web_origin in rule.get("AllowedOrigins", [])
    ]
    allowed_methods = {
        str(method).upper() for rule in matching_rules for method in rule.get("AllowedMethods", [])
    }
    allowed_headers = {
        str(header).lower() for rule in matching_rules for header in rule.get("AllowedHeaders", [])
    }
    if not {"GET", "POST"}.issubset(allowed_methods):
        raise ValueError("S3 CORS must allow GET and POST from the public web origin")
    if "*" not in allowed_headers and "content-type" not in allowed_headers:
        raise ValueError("S3 CORS must allow the Content-Type request header")

    staging_rules = []
    for rule in lifecycle.get("Rules", []):
        if rule.get("Status") != "Enabled" or "Expiration" not in rule:
            continue
        prefix = rule.get("Prefix")
        if prefix is None:
            filter_value = rule.get("Filter", {})
            prefix = filter_value.get("Prefix") if isinstance(filter_value, dict) else None
        if prefix != "staging/":
            continue
        expiration = rule["Expiration"]
        days = expiration.get("Days") if isinstance(expiration, dict) else None
        if not isinstance(days, int) or isinstance(days, bool) or days < 1:
            continue
        if days * 24 * 60 * 60 <= minimum_staging_retention_seconds:
            continue
        staging_rules.append(rule)
    if not staging_rules:
        raise ValueError("S3 lifecycle must expire exact staging/ objects after the late-upload guard")
    return {"corsRules": len(matching_rules), "stagingLifecycleRules": len(staging_rules)}


def validate_association_documents(
    apple_document: dict[str, Any],
    android_document: list[dict[str, Any]],
    *,
    team_id: str,
    certificate_fingerprint: str,
) -> None:
    expected_app_id = f"{team_id}.{EXPECTED_IOS_BUNDLE}"
    details = apple_document.get("applinks", {}).get("details", [])
    matching_apple = []
    for detail in details:
        app_ids = detail.get("appIDs", [])
        if detail.get("appID") == expected_app_id or expected_app_id in app_ids:
            matching_apple.append(detail)
    if not matching_apple:
        raise ValueError("AASA does not delegate to the expected signed iOS app")
    paths = {
        component.get("/")
        for detail in matching_apple
        for component in detail.get("components", [])
        if isinstance(component, dict)
    }
    if paths != EXPECTED_LINK_PATHS:
        raise ValueError("AASA link paths are missing or broader than the application contract")

    normalized_fingerprint = _normalize_fingerprint(certificate_fingerprint)
    matching_android = [
        statement
        for statement in android_document
        if statement.get("target", {}).get("namespace") == "android_app"
        and statement.get("target", {}).get("package_name") == EXPECTED_ANDROID_PACKAGE
        and normalized_fingerprint
        in {
            _normalize_fingerprint(value)
            for value in statement.get("target", {}).get("sha256_cert_fingerprints", [])
        }
        and "delegate_permission/common.handle_all_urls" in statement.get("relation", [])
    ]
    if not matching_android:
        raise ValueError("assetlinks.json does not delegate to the signed Android app")


def run_preflight(args: argparse.Namespace) -> list[CheckResult]:
    settings_holder: dict[str, Settings] = {}
    results: list[CheckResult] = []

    def configuration() -> str:
        settings = Settings(_env_file=args.env_file)
        if settings.environment != "production":
            raise ValueError("FMR_ENVIRONMENT must be production")
        settings_holder["settings"] = settings
        return "production settings validated"

    results.append(_capture("configuration", configuration))
    settings = settings_holder.get("settings")
    if settings is None:
        return results

    results.append(
        _capture(
            "postgresql",
            lambda: _check_database(
                settings,
                allow_database_behind=args.allow_database_behind,
            ),
        )
    )
    results.append(_capture("redis", lambda: _check_redis(settings)))
    if settings.deployment_profile == "managed_local_sso":
        results.append(
            CheckResult(
                "smtp",
                "skipped",
                "managed-local SSO profile disables public email workflows",
            )
        )
        results.append(_capture("local-storage", lambda: _check_local_storage(settings)))
    else:
        results.append(
            _capture(
                "smtp",
                lambda: _check_smtp(settings, test_recipient=args.send_test_email),
            )
        )
        results.append(
            _capture(
                "s3",
                lambda: _check_s3(settings, exercise=args.exercise_s3),
            )
        )
    results.append(_capture("public-health", lambda: _check_public_health(settings)))
    if args.skip_association:
        results.append(CheckResult("association-files", "skipped", "explicitly skipped"))
    else:
        results.append(
            _capture(
                "association-files",
                lambda: _check_public_associations(
                    settings,
                    team_id=args.ios_team_id,
                    certificate_fingerprint=args.android_cert_sha256,
                ),
            )
        )
    return results


def _capture(name: str, check: Callable[[], str]) -> CheckResult:
    try:
        return CheckResult(name, "passed", check())
    except Exception as exc:
        # Provider exceptions frequently embed endpoints, usernames, or signed URLs.
        detail = str(exc) if type(exc) in {ValueError, RuntimeError} else "provider check failed"
        return CheckResult(name, "failed", f"{type(exc).__name__}: {detail[:240]}")


def validate_database_revision_state(
    script: ScriptDirectory,
    *,
    current: set[str],
    expected: set[str],
    allow_database_behind: bool,
) -> int:
    """Return the known pending migration count or reject an unsafe revision state."""

    if not expected:
        raise RuntimeError("repository has no Alembic head")
    if not current:
        raise RuntimeError("database has no recorded Alembic head")
    if current == expected:
        return 0
    if not allow_database_behind:
        raise RuntimeError("database is not at the repository Alembic head")
    if len(current) != 1 or len(expected) != 1:
        raise RuntimeError("pre-migration mode requires a single recorded and target head")
    current_revision = next(iter(current))
    target_revision = next(iter(expected))
    target_path = {revision.revision for revision in script.walk_revisions(base="base", head=target_revision)}
    if current_revision not in target_path:
        raise RuntimeError("database revision is not on the target upgrade path")
    pending = tuple(script.iterate_revisions(target_revision, current_revision))
    if not pending:
        raise RuntimeError("database revision is not behind the target head")
    return len(pending)


def _check_database(settings: Settings, *, allow_database_behind: bool = False) -> str:
    engine = create_engine(settings.database_url, pool_pre_ping=True)
    try:
        with engine.connect() as connection:
            connection.execute(text("SELECT 1"))
            context = MigrationContext.configure(connection)
            current = set(context.get_current_heads())
        alembic_config = Config(str(SERVER_ROOT / "alembic.ini"))
        alembic_config.set_main_option("script_location", str(SERVER_ROOT / "alembic"))
        script = ScriptDirectory.from_config(alembic_config)
        expected = set(script.get_heads())
        pending = validate_database_revision_state(
            script,
            current=current,
            expected=expected,
            allow_database_behind=allow_database_behind,
        )
        if pending:
            return f"reachable; {len(current)} recorded Alembic head(s); {pending} known migration(s) pending"
        return f"reachable; {len(current)} Alembic head(s) current"
    finally:
        engine.dispose()


def _check_redis(settings: Settings) -> str:
    if settings.redis_url is None:
        raise ValueError("Redis URL is missing")
    client = redis.Redis.from_url(settings.redis_url, socket_connect_timeout=5, socket_timeout=5)
    try:
        if client.ping() is not True:
            raise RuntimeError("Redis PING did not return true")
        return "authenticated PING passed"
    finally:
        client.close()


def _check_smtp(settings: Settings, *, test_recipient: str | None) -> str:
    if settings.smtp_host is None or settings.smtp_from_email is None:
        raise ValueError("SMTP settings are missing")
    context = ssl.create_default_context()
    if settings.smtp_use_ssl:
        server: smtplib.SMTP = smtplib.SMTP_SSL(
            settings.smtp_host,
            settings.smtp_port,
            timeout=15,
            context=context,
        )
    else:
        server = smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=15)
    with server:
        server.ehlo()
        if settings.smtp_starttls:
            server.starttls(context=context)
            server.ehlo()
        if settings.smtp_username and settings.smtp_password:
            server.login(settings.smtp_username, settings.smtp_password.get_secret_value())
        code, _ = server.noop()
        if not 200 <= code < 300:
            raise RuntimeError("SMTP NOOP was rejected")
        if test_recipient:
            message = EmailMessage()
            message["Subject"] = "FeelMyRythm production delivery preflight"
            message["From"] = str(settings.smtp_from_email)
            message["To"] = test_recipient
            message.set_content("This message confirms the explicitly requested SMTP delivery preflight.")
            server.send_message(message)
    return "TLS/authentication passed" + ("; test message accepted" if test_recipient else "")


def _check_s3(settings: Settings, *, exercise: bool) -> str:
    client = boto3.client(
        "s3",
        region_name=settings.s3_region,
        endpoint_url=settings.s3_endpoint_url or None,
    )
    bucket = settings.s3_bucket or ""
    client.head_bucket(Bucket=bucket)
    summary = validate_s3_configuration(
        client.get_bucket_cors(Bucket=bucket),
        client.get_bucket_lifecycle_configuration(Bucket=bucket),
        web_origin=_origin(settings.web_app_base_url),
        minimum_staging_retention_seconds=settings.late_upload_guard_seconds,
    )
    if exercise:
        key = f"preflight/{uuid.uuid4()}.txt"
        try:
            client.put_object(Bucket=bucket, Key=key, Body=b"feelmyrythm-preflight")
            response = client.head_object(Bucket=bucket, Key=key)
            if int(response.get("ContentLength", -1)) != len(b"feelmyrythm-preflight"):
                raise RuntimeError("S3 canary object length does not match")
        finally:
            client.delete_object(Bucket=bucket, Key=key)
    return (
        f"bucket reachable; {summary['corsRules']} CORS rule(s); "
        f"{summary['stagingLifecycleRules']} staging lifecycle rule(s)"
        + ("; canary put/head/delete passed" if exercise else "")
    )


def _check_local_storage(settings: Settings) -> str:
    root = settings.local_uploads_dir.resolve()
    if not root.is_dir():
        raise ValueError("local upload root does not exist")
    if not os.access(root, os.R_OK | os.W_OK | os.X_OK):
        raise ValueError("local upload root is not accessible to the runtime user")
    return "persistent local upload root is accessible"


def _check_public_health(settings: Settings) -> str:
    document = _fetch_json(f"{settings.public_api_base_url.rstrip('/')}/api/health")
    if document != {"ok": True}:
        raise RuntimeError("public health response is not authoritative")
    return "public HTTPS health passed"


def _check_public_associations(
    settings: Settings,
    *,
    team_id: str | None,
    certificate_fingerprint: str | None,
) -> str:
    if team_id is None or certificate_fingerprint is None:
        raise ValueError("signed mobile identities are required")
    origin = _origin(settings.web_app_base_url)
    apple = _fetch_json(f"{origin}/.well-known/apple-app-site-association")
    android = _fetch_json(f"{origin}/.well-known/assetlinks.json")
    if not isinstance(apple, dict) or not isinstance(android, list):
        raise TypeError("association documents have the wrong JSON shape")
    validate_association_documents(
        apple,
        android,
        team_id=team_id,
        certificate_fingerprint=certificate_fingerprint,
    )
    return "AASA and assetlinks identities/paths passed"


def _fetch_json(url: str) -> Any:
    request = Request(url, headers={"User-Agent": "FeelMyRythm-Production-Preflight/1"})
    with urlopen(request, timeout=10) as response:  # noqa: S310 - production URL is validated HTTPS
        if response.status != 200:
            raise RuntimeError("public endpoint returned a non-200 response")
        payload = response.read(1_048_577)
    if len(payload) > 1_048_576:
        raise ValueError("public JSON document exceeds 1 MiB")
    return json.loads(payload)


def _origin(url: str) -> str:
    parsed = urlsplit(url)
    if parsed.scheme != "https" or not parsed.netloc:
        raise ValueError("public origin must use absolute HTTPS")
    return f"{parsed.scheme}://{parsed.netloc}"


def _normalize_fingerprint(value: str) -> str:
    compact = value.replace(":", "").replace(" ", "").upper()
    if len(compact) != 64 or any(character not in "0123456789ABCDEF" for character in compact):
        raise ValueError("certificate fingerprint must be a SHA-256 value")
    return compact


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", type=Path, default=Path(".env"))
    parser.add_argument("--ios-team-id", default=None)
    parser.add_argument("--android-cert-sha256", default=None)
    parser.add_argument("--skip-association", action="store_true")
    parser.add_argument(
        "--allow-database-behind",
        action="store_true",
        help=(
            "pre-migration check only; does not run migrations: allow a recorded "
            "Alembic head that is a known ancestor of the target head"
        ),
    )
    parser.add_argument(
        "--exercise-s3",
        action="store_true",
        help="explicitly create, verify, and delete one preflight/ canary object",
    )
    parser.add_argument(
        "--send-test-email",
        help="explicitly send one test message to this recipient after SMTP auth",
    )
    parser.add_argument("--pretty", action="store_true")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    arguments = [argument for argument in (sys.argv[1:] if argv is None else argv) if argument != "--"]
    args = build_parser().parse_args(arguments)
    results = run_preflight(args)
    output = {
        "passed": all(result.status in {"passed", "skipped"} for result in results),
        "checks": [asdict(result) for result in results],
    }
    print(json.dumps(output, ensure_ascii=False, indent=2 if args.pretty else None, sort_keys=True))
    return 0 if output["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
