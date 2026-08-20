"""add immutable portfolio SSO subject

Revision ID: f4c8d1a2b3e5
Revises: e3a1f6c9b2d4
Create Date: 2026-08-21
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "f4c8d1a2b3e5"
down_revision: str | None = "e3a1f6c9b2d4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Existing users remain deliberately unlinked. The first trusted edge
    # exchange links an exact, unique email match once; guessing a subject in a
    # data migration would make the stable identity binding unauditable.
    op.add_column(
        "users",
        sa.Column("sso_subject", sa.String(length=255), nullable=True),
    )
    op.create_index(
        op.f("ix_users_sso_subject"),
        "users",
        ["sso_subject"],
        unique=True,
    )
    connection = op.get_bind()
    if connection.dialect.name == "postgresql":
        op.execute(
            """
            CREATE FUNCTION fmr_reject_sso_subject_change() RETURNS trigger
            LANGUAGE plpgsql AS $$
            BEGIN
                IF OLD.sso_subject IS NOT NULL
                   AND NEW.sso_subject IS DISTINCT FROM OLD.sso_subject THEN
                    RAISE EXCEPTION 'sso_subject is immutable once linked';
                END IF;
                RETURN NEW;
            END;
            $$
            """
        )
        op.execute(
            """
            CREATE TRIGGER users_sso_subject_immutable
            BEFORE UPDATE OF sso_subject ON users
            FOR EACH ROW EXECUTE FUNCTION fmr_reject_sso_subject_change()
            """
        )
    elif connection.dialect.name == "sqlite":
        op.execute(
            """
            CREATE TRIGGER users_sso_subject_immutable
            BEFORE UPDATE OF sso_subject ON users
            FOR EACH ROW
            WHEN OLD.sso_subject IS NOT NULL AND NEW.sso_subject IS NOT OLD.sso_subject
            BEGIN
                SELECT RAISE(ABORT, 'sso_subject is immutable once linked');
            END
            """
        )
    else:
        raise RuntimeError("SSO subject migration supports only PostgreSQL and SQLite")


def downgrade() -> None:
    connection = op.get_bind()
    if connection.dialect.name == "postgresql":
        op.execute("DROP TRIGGER users_sso_subject_immutable ON users")
        op.execute("DROP FUNCTION fmr_reject_sso_subject_change()")
    elif connection.dialect.name == "sqlite":
        op.execute("DROP TRIGGER users_sso_subject_immutable")
    else:
        raise RuntimeError("SSO subject migration supports only PostgreSQL and SQLite")
    op.drop_index(op.f("ix_users_sso_subject"), table_name="users")
    op.drop_column("users", "sso_subject")
