"""embedding column: JSONB → vector(384) + HNSW index

Revision ID: a1b2c3d4e5f6
Revises: 339c3d5d50ba
Create Date: 2026-03-20

Converts resume_chunks.embedding from JSONB to pgvector vector(384).
Existing float-list data in JSONB casts cleanly to vector — no data loss.
NULL JSONB becomes NULL vector — still skipped in similarity queries.

After applying this migration, re-upload any resumes that have NULL
embeddings (uploaded before Session 15 when embedding writes were added).
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = 'a1b2c3d4e5f6'
down_revision: Union[str, Sequence[str], None] = '339c3d5d50ba'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1. Ensure pgvector extension is enabled (idempotent — safe to run twice)
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")

    # 2. Cast JSONB → vector(384)
    #    The JSONB column stores a JSON array of 384 floats e.g. [0.023, -0.14, ...]
    #    Casting via ::text::vector works reliably for this shape.
    op.execute("""
        ALTER TABLE resume_chunks
        ALTER COLUMN embedding TYPE vector(384)
        USING embedding::text::vector
    """)

    # 3. Add HNSW index for fast cosine similarity search.
    #    HNSW chosen over IVFFlat: no training data required, better recall,
    #    works correctly for small datasets (< 1000 vectors).
    #    NULLs are automatically excluded from the index.
    op.execute("""
        CREATE INDEX ix_resume_chunks_embedding_hnsw
        ON resume_chunks
        USING hnsw (embedding vector_cosine_ops)
    """)


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_resume_chunks_embedding_hnsw")
    op.execute("""
        ALTER TABLE resume_chunks
        ALTER COLUMN embedding TYPE jsonb
        USING embedding::text::jsonb
    """)