from __future__ import annotations

import os
from argparse import Namespace
from pathlib import Path
from types import SimpleNamespace
from typing import cast

import pytest
from alembic.config import Config
from alembic.script import ScriptDirectory

import scripts.production_preflight as production_preflight
from scripts.production_preflight import (
    build_parser,
    run_preflight,
    validate_association_documents,
    validate_database_revision_state,
    validate_s3_configuration,
)


def test_preflight_does_not_echo_invalid_secret_inputs(tmp_path: Path) -> None:
    secret = "do-not-print-this-database-password"
    env_file = tmp_path / "production.env"
    env_file.write_text(
        "\n".join(
            [
                "FMR_ENVIRONMENT=production",
                f"FMR_DATABASE_URL=postgresql+psycopg://user:{secret}@db/feelmyrythm",
                "FMR_JWT_SECRET=short",
            ]
        ),
        encoding="utf-8",
    )

    results = run_preflight(
        Namespace(
            env_file=env_file,
            send_test_email=None,
            exercise_s3=False,
            skip_association=True,
            allow_database_behind=False,
            ios_team_id=None,
            android_cert_sha256=None,
        )
    )

    assert results[0].status == "failed"
    assert secret not in results[0].detail


def test_managed_local_sso_preflight_skips_external_providers_and_checks_local_storage(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("PORTFOLIO_BRANCH", "main")
    monkeypatch.setenv("PORTFOLIO_AUTH_MODE", "sso")
    uploads = tmp_path / "uploads"
    uploads.mkdir()
    edge_secret_file = tmp_path / "fmr-edge-secret"
    edge_secret_file.write_text(
        "test-fmr-edge-secret-with-at-least-32-characters",
        encoding="ascii",
    )
    edge_secret_file.chmod(0o640)
    real_fstat = os.fstat

    def container_fstat(file_descriptor: int) -> os.stat_result:
        metadata = list(real_fstat(file_descriptor))
        metadata[4] = 0
        metadata[5] = 0
        return os.stat_result(metadata)

    monkeypatch.setattr("app.config.os.fstat", container_fstat)
    monkeypatch.setattr("app.config.os.getegid", lambda: 0)
    env_file = tmp_path / "production.env"
    env_file.write_text(
        "\n".join(
            [
                "FMR_ENVIRONMENT=production",
                "FMR_DEPLOYMENT_PROFILE=managed_local_sso",
                "FMR_SSO_ENABLED=true",
                f"FMR_SSO_EDGE_SECRET_FILE={edge_secret_file}",
                "FMR_DATABASE_URL=postgresql+psycopg://user:password@db/feelmyrythm",
                "FMR_AUTO_CREATE_SCHEMA=false",
                "FMR_JWT_SECRET=runtime-secret-with-at-least-32-characters",
                "FMR_WEB_APP_BASE_URL=https://bonifacio.work/feelmyrythm",
                "FMR_PUBLIC_API_BASE_URL=https://bonifacio.work/feelmyrythm",
                "FMR_REDIS_URL=redis://fmrRedis:6379/0",
                "FMR_STORAGE_BACKEND=local",
                f"FMR_LOCAL_UPLOADS_DIR={uploads}",
            ]
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(production_preflight, "_check_database", lambda *args, **kwargs: "ok")
    monkeypatch.setattr(production_preflight, "_check_redis", lambda *args, **kwargs: "ok")
    monkeypatch.setattr(production_preflight, "_check_public_health", lambda *args, **kwargs: "ok")

    results = run_preflight(
        Namespace(
            env_file=env_file,
            send_test_email=None,
            exercise_s3=False,
            skip_association=True,
            allow_database_behind=False,
            ios_team_id=None,
            android_cert_sha256=None,
        )
    )

    by_name = {result.name: result for result in results}
    assert by_name["configuration"].status == "passed"
    assert by_name["smtp"].status == "skipped"
    assert by_name["local-storage"].status == "passed"
    assert "s3" not in by_name


def test_database_preflight_only_allows_known_upgrade_ancestors() -> None:
    server_root = Path(__file__).resolve().parents[1]
    alembic_config = Config(str(server_root / "alembic.ini"))
    alembic_config.set_main_option("script_location", str(server_root / "alembic"))
    script = ScriptDirectory.from_config(alembic_config)
    expected = set(script.get_heads())

    assert (
        validate_database_revision_state(
            script,
            current=expected,
            expected=expected,
            allow_database_behind=False,
        )
        == 0
    )
    assert (
        validate_database_revision_state(
            script,
            current={"b44b9e7c2d10"},
            expected=expected,
            allow_database_behind=True,
        )
        == 3
    )
    assert (
        validate_database_revision_state(
            script,
            current={"c7f2a9d4e6b1"},
            expected=expected,
            allow_database_behind=True,
        )
        == 2
    )

    with pytest.raises(RuntimeError, match="not at the repository Alembic head"):
        validate_database_revision_state(
            script,
            current={"b44b9e7c2d10"},
            expected=expected,
            allow_database_behind=False,
        )
    with pytest.raises(RuntimeError, match="no recorded Alembic head"):
        validate_database_revision_state(
            script,
            current=set(),
            expected=expected,
            allow_database_behind=True,
        )
    with pytest.raises(RuntimeError, match="not on the target upgrade path"):
        validate_database_revision_state(
            script,
            current={"not-a-real-revision"},
            expected=expected,
            allow_database_behind=True,
        )
    with pytest.raises(RuntimeError, match="single recorded and target head"):
        validate_database_revision_state(
            script,
            current={"b44b9e7c2d10", "c7f2a9d4e6b1"},
            expected=expected,
            allow_database_behind=True,
        )

    class DivergentScript:
        def walk_revisions(self, *, base: str, head: str):
            assert base == "base"
            assert head == "target"
            return iter(
                [
                    SimpleNamespace(revision="target"),
                    SimpleNamespace(revision="base"),
                ]
            )

    with pytest.raises(RuntimeError, match="not on the target upgrade path"):
        validate_database_revision_state(
            cast(ScriptDirectory, DivergentScript()),
            current={"known-divergent"},
            expected={"target"},
            allow_database_behind=True,
        )
    with pytest.raises(RuntimeError, match="single recorded and target head"):
        validate_database_revision_state(
            script,
            current={"b44b9e7c2d10"},
            expected={"target-a", "target-b"},
            allow_database_behind=True,
        )


def test_database_preflight_parser_is_strict_by_default() -> None:
    assert build_parser().parse_args([]).allow_database_behind is False
    assert build_parser().parse_args(["--allow-database-behind"]).allow_database_behind is True


def test_s3_preflight_requires_browser_cors_and_staging_expiration() -> None:
    summary = validate_s3_configuration(
        {
            "CORSRules": [
                {
                    "AllowedOrigins": ["https://bonifacio.work"],
                    "AllowedMethods": ["GET", "POST"],
                    "AllowedHeaders": ["Content-Type"],
                }
            ]
        },
        {
            "Rules": [
                {
                    "Status": "Enabled",
                    "Filter": {"Prefix": "staging/"},
                    "Expiration": {"Days": 2},
                }
            ]
        },
        web_origin="https://bonifacio.work",
        minimum_staging_retention_seconds=24 * 60 * 60,
    )
    assert summary == {"corsRules": 1, "stagingLifecycleRules": 1}

    with pytest.raises(ValueError, match="GET and POST"):
        validate_s3_configuration(
            {
                "CORSRules": [
                    {
                        "AllowedOrigins": ["https://bonifacio.work"],
                        "AllowedMethods": ["GET"],
                        "AllowedHeaders": ["*"],
                    }
                ]
            },
            {"Rules": []},
            web_origin="https://bonifacio.work",
        )

    with pytest.raises(ValueError, match="GET and POST"):
        validate_s3_configuration(
            {
                "CORSRules": [
                    {
                        "AllowedOrigins": ["*"],
                        "AllowedMethods": ["GET", "POST"],
                        "AllowedHeaders": ["Content-Type"],
                    }
                ]
            },
            {"Rules": []},
            web_origin="https://bonifacio.work",
        )

    for unsafe_prefix in ("", "staging"):
        with pytest.raises(ValueError, match="exact staging"):
            validate_s3_configuration(
                {
                    "CORSRules": [
                        {
                            "AllowedOrigins": ["https://bonifacio.work"],
                            "AllowedMethods": ["GET", "POST"],
                            "AllowedHeaders": ["Content-Type"],
                        }
                    ]
                },
                {
                    "Rules": [
                        {
                            "Status": "Enabled",
                            "Filter": {"Prefix": unsafe_prefix},
                            "Expiration": {"Days": 2},
                        }
                    ]
                },
                web_origin="https://bonifacio.work",
                minimum_staging_retention_seconds=24 * 60 * 60,
            )

    with pytest.raises(ValueError, match="late-upload guard"):
        validate_s3_configuration(
            {
                "CORSRules": [
                    {
                        "AllowedOrigins": ["https://bonifacio.work"],
                        "AllowedMethods": ["GET", "POST"],
                        "AllowedHeaders": ["Content-Type"],
                    }
                ]
            },
            {
                "Rules": [
                    {
                        "Status": "Enabled",
                        "Filter": {"Prefix": "staging/"},
                        "Expiration": {"Days": 1},
                    }
                ]
            },
            web_origin="https://bonifacio.work",
            minimum_staging_retention_seconds=24 * 60 * 60,
        )


def test_association_preflight_rejects_broad_or_wrong_signed_delegations() -> None:
    fingerprint = "AA" * 32
    apple = {
        "applinks": {
            "details": [
                {
                    "appIDs": ["A1B2C3D4E5.work.bonifacio.feelmyrythm"],
                    "components": [
                        {"/": "/feelmyrythm/session/*"},
                        {"/": "/feelmyrythm/login"},
                        {"/": "/feelmyrythm/settings"},
                    ],
                }
            ]
        }
    }
    android = [
        {
            "relation": ["delegate_permission/common.handle_all_urls"],
            "target": {
                "namespace": "android_app",
                "package_name": "work.bonifacio.feelmyrythm",
                "sha256_cert_fingerprints": [fingerprint],
            },
        }
    ]
    validate_association_documents(
        apple,
        android,
        team_id="A1B2C3D4E5",
        certificate_fingerprint=fingerprint,
    )

    apple["applinks"]["details"][0]["components"].append({"/": "/feelmyrythm/*"})
    with pytest.raises(ValueError, match="broader"):
        validate_association_documents(
            apple,
            android,
            team_id="A1B2C3D4E5",
            certificate_fingerprint=fingerprint,
        )
