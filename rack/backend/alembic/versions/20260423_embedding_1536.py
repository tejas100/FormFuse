"""
20260423_embedding_1536.py

Alters resume_chunks.embedding from vector(384) to vector(1536).

Reason: switching from sentence-transformers/all-MiniLM-L6-v2 (384-dim)
to OpenAI text-embedding-3-small (1536-dim). All existing embeddings must
be re-generated after this migration runs — see re_embed_all.py script.

Run:
    alembic upgrade head

Then re-embed all existing resumes:
    python re_embed_all.py
"""

from alembic import op
import sqlalchemy as sa

revision = "20260423_embedding_1536"
down_revision = "20260410_admin_role_daily"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Step 1: Drop the old embedding column (can't ALTER vector dimensions in-place)
    op.drop_column("resume_chunks", "embedding")

    # Step 2: Add it back as vector(1536)
    op.execute("""
        ALTER TABLE resume_chunks
        ADD COLUMN embedding vector(1536)
    """)

    # Step 3: Recreate the cosine similarity index for the new dimension
    # Drop old index first if it exists
    op.execute("DROP INDEX IF EXISTS ix_resume_chunks_embedding")
    op.execute("""
        CREATE INDEX ix_resume_chunks_embedding
        ON resume_chunks
        USING ivfflat (embedding vector_cosine_ops)
        WITH (lists = 100)
    """)


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_resume_chunks_embedding")
    op.drop_column("resume_chunks", "embedding")
    op.execute("""
        ALTER TABLE resume_chunks
        ADD COLUMN embedding vector(384)
    """)