"""restructure auto_match_results — normalized rows

Revision ID: 20260326_restructure_amr
Revises: 20260325_snapshot_archive
Create Date: 2026-03-26

Changes:
  - DROP   auto_match_results (old schema: id, user_id, run_date, job_data JSONB, created_at)
  - CREATE auto_match_results (new schema: normalized rows, one per user+job)
  - UNIQUE(user_id, job_id) replaces UNIQUE(user_id, run_date)
  - Promoted columns: score FLOAT, posted_at TIMESTAMPTZ, matched_at TIMESTAMPTZ
  - job_data JSONB kept for full payload storage
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers
revision = "20260326_restructure_amr"
down_revision = "20260325_snapshot_archive"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Drop the old snapshot-based table entirely
    op.drop_table("auto_match_results")

    # Create the new normalized table
    op.create_table(
        "auto_match_results",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("job_id", sa.String(64), nullable=False),
        sa.Column("job_data", postgresql.JSONB(), nullable=False),
        sa.Column("score", sa.Float(), nullable=False),
        sa.Column("posted_at", sa.TIMESTAMP(timezone=True), nullable=True),
        sa.Column(
            "matched_at",
            sa.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "job_id", name="uq_auto_match_user_job"),
    )

    # Index on score for fast ORDER BY score DESC
    op.create_index(
        "ix_auto_match_results_user_score",
        "auto_match_results",
        ["user_id", sa.text("score DESC")],
    )

    # Index on posted_at for recency filters
    op.create_index(
        "ix_auto_match_results_user_posted",
        "auto_match_results",
        ["user_id", sa.text("posted_at DESC")],
    )


def downgrade() -> None:
    op.drop_table("auto_match_results")

    # Restore old snapshot table
    op.create_table(
        "auto_match_results",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("run_date", sa.Date(), nullable=False),
        sa.Column("job_data", postgresql.JSONB(), nullable=True),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "run_date", name="uq_auto_match_user_run_date"),
    )