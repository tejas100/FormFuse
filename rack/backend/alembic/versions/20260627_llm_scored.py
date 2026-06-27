"""Add llm_scored boolean to auto_match_results

Revision ID: 20260627_llm_scored
Revises: 20260627_resume_embedding
Create Date: 2026-06-27

llm_scored = FALSE  → result came from instant match (pgvector only, no LLM)
llm_scored = TRUE   → result came from full scheduled pipeline (LLM confirmed)

Dashboard and Tracking can surface this to show "Instant match · score may refine"
vs "Confirmed match" badges. The scheduled pipeline sets llm_scored=TRUE on its
UPSERT so instant-match rows get promoted automatically on the next scoring run.

DEFAULT false so all existing rows (which were LLM-scored before this column
existed) are correctly treated as unscored from the column's perspective. The
scheduled pipeline will overwrite them with TRUE on next run — this is fine.

If you want existing rows to be marked TRUE immediately, run after migration:
  UPDATE auto_match_results SET llm_scored = TRUE WHERE llm_scored = FALSE;
"""

from alembic import op

revision      = "20260627_llm_scored"
down_revision = "20260627_resume_embedding"
branch_labels = None
depends_on    = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE auto_match_results "
        "ADD COLUMN llm_scored boolean NOT NULL DEFAULT false"
    )


def downgrade() -> None:
    op.execute(
        "ALTER TABLE auto_match_results "
        "DROP COLUMN IF EXISTS llm_scored"
    )