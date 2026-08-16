"""add email verification and auth generation

Revision ID: 72d06f7d91c4
Revises: b881b6589baa
Create Date: 2026-08-15
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "72d06f7d91c4"
down_revision: str | None = "b881b6589baa"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("email_verified_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "users",
        sa.Column("email_verification_sent_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "users",
        sa.Column("auth_generation", sa.Integer(), server_default=sa.text("0"), nullable=False),
    )

    # Existing password-only rows cannot be trusted as verified because the old flow
    # never proved mailbox control. Existing Google identities were already checked
    # by Google's verified-email claim, so preserve them while removing any password
    # credential that could have originated from an earlier email preclaim.
    op.execute("UPDATE users SET auth_generation = 1")
    op.execute(
        "UPDATE users "
        "SET email_verified_at = created_at, password_hash = NULL "
        "WHERE google_subject IS NOT NULL"
    )
    # Old access JWTs have no matching generation claim; remove all server-held
    # refresh sessions too so the migration closes every pre-existing session path.
    op.execute("DELETE FROM refresh_sessions")


def downgrade() -> None:
    op.drop_column("users", "auth_generation")
    op.drop_column("users", "email_verification_sent_at")
    op.drop_column("users", "email_verified_at")
