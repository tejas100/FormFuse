"""Add recommended_resume_id uuid to auto_match_results

Revision ID: 20260627_recommended_resume_id
Revises: 20260627_llm_scored
Create Date: 2026-06-27

When multiple resumes are searched during instant match, the resume that produced
the highest semantic score for a given job wins that job slot. Its ID is stored
here so the UI can display "Apply with: Resume A" without any extra query.

Nullable — existing rows and jobs where resume can't be determined stay NULL.
No FK constraint — resumes can be deleted without orphaning match history.
"""

from alembic import op

revision      = "20260627_recommended_resume_id"
down_revision = "20260627_llm_scored"
branch_labels = None
depends_on    = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE auto_match_results "
        "ADD COLUMN recommended_resume_id uuid"
    )


def downgrade() -> None:
    op.execute(
        "ALTER TABLE auto_match_results "
        "DROP COLUMN IF EXISTS recommended_resume_id"
    )