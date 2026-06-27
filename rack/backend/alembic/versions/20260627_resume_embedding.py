"""Add resume_embedding vector(1536) to resumes table

Revision ID: 20260627_resume_embedding
Revises: 20260620_job_pool_jd_embedding
Create Date: 2026-06-27

One averaged embedding per resume, computed from all its chunks at upload time
in resumes.py. Used by instant_match.py (onboarding pipeline) to run a single
pgvector search per resume against job_pool.jd_embedding.

No HNSW index here — we always query in the direction
  job_pool.jd_embedding <=> :resume_embedding
so the HNSW index already on job_pool is what accelerates this search.

NULL for all existing rows until re-uploaded (acceptable — instant match only
fires for new users who upload during onboarding).

Run with:
  DATABASE_URL_DIRECT=postgresql+psycopg2://... alembic upgrade head
  (port 5432 session pooler)
"""

from alembic import op

revision      = "20260627_resume_embedding"
down_revision = "20260620_job_pool_jd_embedding"
branch_labels = None
depends_on    = None


def upgrade() -> None:
    op.execute("ALTER TABLE resumes ADD COLUMN resume_embedding vector(1536)")


def downgrade() -> None:
    op.execute("ALTER TABLE resumes DROP COLUMN IF EXISTS resume_embedding")