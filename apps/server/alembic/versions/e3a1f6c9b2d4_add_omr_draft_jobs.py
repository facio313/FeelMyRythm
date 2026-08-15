"""add persistent OMR draft jobs

Revision ID: e3a1f6c9b2d4
Revises: c7f2a9d4e6b1
Create Date: 2026-08-15
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "e3a1f6c9b2d4"
down_revision: str | None = "c7f2a9d4e6b1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "omr_draft_jobs",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("score_id", sa.String(length=36), nullable=False),
        sa.Column("requested_by_id", sa.String(length=36), nullable=False),
        sa.Column("expected_measure_map_revision", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("regions", sa.JSON(), nullable=False),
        sa.Column("warnings", sa.JSON(), nullable=False),
        sa.Column("error", sa.String(length=500), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "status IN ('pending', 'running', 'succeeded', 'failed')",
            name="ck_omr_draft_jobs_status",
        ),
        sa.ForeignKeyConstraint(["requested_by_id"], ["users.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["score_id"], ["scores.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_omr_draft_jobs_score_created",
        "omr_draft_jobs",
        ["score_id", "created_at"],
        unique=False,
    )
    op.create_index(
        op.f("ix_omr_draft_jobs_score_id"),
        "omr_draft_jobs",
        ["score_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_omr_draft_jobs_score_id"), table_name="omr_draft_jobs")
    op.drop_index("ix_omr_draft_jobs_score_created", table_name="omr_draft_jobs")
    op.drop_table("omr_draft_jobs")
