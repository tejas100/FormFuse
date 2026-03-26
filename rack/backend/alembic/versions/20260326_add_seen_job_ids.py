"""add seen_job_ids table

Revision ID: 20260326_seen_job_ids
Revises: 20260326_restructure_auto_match_results
Create Date: 2026-03-26

Adds seen_job_ids table — one row per (user_id, job_id).
Inserted the moment a job enters Phase 1 scoring, regardless of whether
it passes Phase 1 or Phase 2.

Replaces already_scored_ids (which only tracked jobs in auto_match_results)
as the skip filter for truly_new jobs in run_auto_pipeline().

Also serves as the pool for new-resume rescoring (future feature):
when a user uploads a new resume, query seen_job_ids to get all jobs
ever fetched for that user, then run Phase 1+2 against the new resume only.
"""

from alembic import op
import sqlalchemy as sa

# revision identifiers
revision = "20260326_seen_job_ids"
down_revision = "20260326_restructure_amr"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "seen_job_ids",
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("job_id", sa.String(64), nullable=False),
        sa.Column(
            "first_seen_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"],
            ondelete="CASCADE",
            name="fk_seen_job_ids_user",
        ),
        sa.PrimaryKeyConstraint("user_id", "job_id", name="pk_seen_job_ids"),
    )

    # Index on user_id for fast per-user lookups (set load at pipeline start)
    op.create_index(
        "ix_seen_job_ids_user_id",
        "seen_job_ids",
        ["user_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_seen_job_ids_user_id", table_name="seen_job_ids")
    op.drop_table("seen_job_ids")