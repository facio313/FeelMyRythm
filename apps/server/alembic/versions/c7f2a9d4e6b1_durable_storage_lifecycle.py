"""durable storage lifecycle

Revision ID: c7f2a9d4e6b1
Revises: b44b9e7c2d10
Create Date: 2026-08-15
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "c7f2a9d4e6b1"
down_revision: str | None = "b44b9e7c2d10"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "scores",
        sa.Column("staging_key", sa.String(length=512), nullable=True),
    )
    op.add_column(
        "scores",
        sa.Column("upload_expires_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index(
        "ix_scores_staging_key",
        "scores",
        ["staging_key"],
        unique=True,
    )
    op.create_table(
        "storage_deletion_jobs",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("storage_key", sa.String(length=512), nullable=False),
        sa.Column("reason", sa.String(length=32), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("attempt_count", sa.Integer(), nullable=False),
        sa.Column("next_attempt_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("lease_owner", sa.String(length=36), nullable=True),
        sa.Column("lease_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_error", sa.String(length=160), nullable=True),
        sa.Column("guard_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "status IN ('pending', 'leased', 'completed')",
            name="ck_storage_deletion_jobs_status",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("storage_key"),
    )
    op.create_index(
        "ix_storage_deletion_jobs_due",
        "storage_deletion_jobs",
        ["status", "next_attempt_at", "lease_expires_at"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(
        "ix_storage_deletion_jobs_due",
        table_name="storage_deletion_jobs",
    )
    op.drop_table("storage_deletion_jobs")
    op.drop_index("ix_scores_staging_key", table_name="scores")
    op.drop_column("scores", "upload_expires_at")
    op.drop_column("scores", "staging_key")
