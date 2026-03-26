"""restructure_auto_match_results_add_archived_job_ids

Revision ID: 20260325_snapshot_archive
Revises: 20260324_add_full_text_to_resumes
Create Date: 2026-03-25

Changes:
  1. Drop old auto_match_results table (had per-job rows with a `score` float).
  2. Recreate auto_match_results with one-snapshot-per-day schema:
       id          uuid PK
       user_id     FK → users.id
       run_date    DATE  (+ unique constraint with user_id)
       job_data    JSONB  (full array of up to 50 matched jobs)
       created_at  timestamptz
  3. Create new archived_job_ids table:
       user_id     FK → users.id  (composite PK)
       job_id      text           (composite PK)
       archived_at timestamptz
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers
revision = "20260325_snapshot_archive"
down_revision = "add_full_text_resumes"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ── 1. Drop old auto_match_results ────────────────────────────────
    op.drop_table("auto_match_results")

    # ── 2. Recreate with snapshot schema ──────────────────────────────
    op.create_table(
        "auto_match_results",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("user_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("users.id", ondelete="CASCADE"),
                  nullable=False, index=True),
        sa.Column("run_date", sa.Date(), nullable=False),
        sa.Column("job_data", postgresql.JSONB(), nullable=False,
                  server_default=sa.text("'[]'::jsonb")),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.text("now()"), nullable=False),
        sa.UniqueConstraint("user_id", "run_date", name="uq_auto_match_user_run_date"),
    )

    # ── 3. Create archived_job_ids ────────────────────────────────────
    op.create_table(
        "archived_job_ids",
        sa.Column("user_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("job_id", sa.String(64), nullable=False),
        sa.Column("archived_at", sa.DateTime(timezone=True),
                  server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("user_id", "job_id", name="pk_archived_job_ids"),
    )


def downgrade() -> None:
    op.drop_table("archived_job_ids")
    op.drop_table("auto_match_results")

    # Restore original schema (per-job rows with score float)
    op.create_table(
        "auto_match_results",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("user_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("users.id", ondelete="CASCADE"),
                  nullable=False, index=True),
        sa.Column("job_data", postgresql.JSONB(), nullable=False),
        sa.Column("score", sa.Float(), nullable=False),
        sa.Column("fetched_at", sa.DateTime(timezone=True),
                  server_default=sa.text("now()"), nullable=False),
    )