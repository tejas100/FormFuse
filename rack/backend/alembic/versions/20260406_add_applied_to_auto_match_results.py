"""add applied columns to auto_match_results

Revision ID: 20260406_add_applied
Revises: 20260326_add_seen_job_ids
Create Date: 2026-04-06
"""
from alembic import op
import sqlalchemy as sa

revision = "20260406_add_applied"
down_revision = "20260326_seen_job_ids"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "auto_match_results",
        sa.Column("applied", sa.Boolean(), nullable=False, server_default="false"),
    )
    op.add_column(
        "auto_match_results",
        sa.Column("applied_at", sa.TIMESTAMP(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("auto_match_results", "applied_at")
    op.drop_column("auto_match_results", "applied")