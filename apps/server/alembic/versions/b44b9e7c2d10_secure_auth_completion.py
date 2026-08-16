"""secure registration completion and recovery attempts

Revision ID: b44b9e7c2d10
Revises: 72d06f7d91c4
Create Date: 2026-08-15
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "b44b9e7c2d10"
down_revision: str | None = "72d06f7d91c4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("password_reset_sent_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "users",
        sa.Column("account_delete_sent_at", sa.DateTime(timezone=True), nullable=True),
    )

    # A pre-verification password from the legacy registration flow did not prove
    # mailbox ownership. Remove it and any sessions defensively; the mailbox owner
    # chooses a fresh password only while completing a signed email challenge.
    op.execute(
        "DELETE FROM refresh_sessions WHERE user_id IN (SELECT id FROM users WHERE email_verified_at IS NULL)"
    )
    op.execute(
        "UPDATE users "
        "SET password_hash = NULL, auth_generation = auth_generation + 1 "
        "WHERE email_verified_at IS NULL"
    )


def downgrade() -> None:
    op.drop_column("users", "account_delete_sent_at")
    op.drop_column("users", "password_reset_sent_at")
