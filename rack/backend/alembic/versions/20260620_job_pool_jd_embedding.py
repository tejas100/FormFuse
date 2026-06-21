"""Add jd_embedding vector(1536) + HNSW index to job_pool

Revision ID: 20260620_job_pool_jd_embedding
Revises: 20260611_apply_otp
Create Date: 2026-06-20

New column on job_pool:
  jd_embedding  vector(1536)  — pre-computed OpenAI text-embedding-3-small embedding
                                 for the job title + company + first 400 chars of
                                 description_text. Computed once at upsert time in
                                 job_fetcher.py. NULL until backfill_embeddings.py runs
                                 for existing rows.

New index:
  job_pool_jd_embedding_hnsw  — HNSW index on jd_embedding using cosine distance.
                                  Enables fast ANN search in the instant-match SQL query
                                  (Decision 4 from v88 architecture session).

Equivalent raw SQL (Supabase SQL editor), if you'd rather skip Alembic:

  ALTER TABLE job_pool ADD COLUMN jd_embedding vector(1536);
  CREATE INDEX job_pool_jd_embedding_hnsw
    ON job_pool USING hnsw (jd_embedding vector_cosine_ops);

Run with:
  DATABASE_URL_DIRECT=postgresql+psycopg2://... alembic upgrade head
  (must use port 5432 session pooler — same as all Alembic migrations)
"""

from alembic import op

revision      = "20260620_job_pool_jd_embedding"
down_revision = "20260611_apply_otp"
branch_labels = None
depends_on    = None


def upgrade() -> None:
    # Add the embedding column — nullable so existing rows aren't blocked
    op.execute("ALTER TABLE job_pool ADD COLUMN jd_embedding vector(1536)")

    # HNSW index for fast ANN cosine-distance search
    # m=16, ef_construction=64 are pgvector defaults — good starting point;
    # tune ef_search at query time if recall needs improvement.
    op.execute(
        "CREATE INDEX job_pool_jd_embedding_hnsw "
        "ON job_pool USING hnsw (jd_embedding vector_cosine_ops)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS job_pool_jd_embedding_hnsw")
    op.execute("ALTER TABLE job_pool DROP COLUMN IF EXISTS jd_embedding")