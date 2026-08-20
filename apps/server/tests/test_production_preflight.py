from __future__ import annotations

from argparse import Namespace
from pathlib import Path
from types import SimpleNamespace
from typing import cast

import pytest
from alembic.config import Config
from alembic.script import ScriptDirectory

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
        == 2
    )
    assert (
        validate_database_revision_state(
            script,
            current={"c7f2a9d4e6b1"},
            expected=expected,
            allow_database_behind=True,
        )
        == 1
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
