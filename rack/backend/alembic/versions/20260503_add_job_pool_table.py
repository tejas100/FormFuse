"""
20260503_add_job_pool_table.py
Creates the job_pool table — replaces the flat job_pool.json file in
Supabase Storage. The scheduler upserts rows on every fetch cycle;
_load_pool_from_disk() reads active rows instead of downloading a JSON blob.

Revision ID: 20260503_add_job_pool_table
Revises: 20260423_embedding_1536
Create Date: 2026-05-03
"""

revision      = "20260503_add_job_pool_table"
down_revision = "20260423_embedding_1536"
branch_labels = None
depends_on    = None

from alembic import op
import sqlalchemy as sa


def upgrade() -> None:
    op.create_table(
        "job_pool",
        sa.Column("job_id",           sa.String(64),   primary_key=True),
        sa.Column("source",           sa.String(32),   nullable=False),
        sa.Column("external_id",      sa.String(128),  nullable=False),
        sa.Column("title",            sa.Text(),        nullable=False),
        sa.Column("company",          sa.Text(),        nullable=False),
        sa.Column("location",         sa.Text(),        nullable=False, server_default="Not specified"),
        sa.Column("url",              sa.Text(),        nullable=False),
        sa.Column("description_text", sa.Text(),        nullable=True),
        sa.Column("posted_at",        sa.TIMESTAMP(timezone=True), nullable=True),
        sa.Column("department",       sa.Text(),        nullable=False, server_default=""),
        sa.Column("commitment",       sa.String(64),   nullable=False, server_default=""),
        sa.Column("board_token",      sa.String(128),  nullable=False, server_default=""),
        sa.Column("fetched_at",       sa.TIMESTAMP(timezone=True), nullable=False),
        sa.Column("is_active",        sa.Boolean(),    nullable=False, server_default=sa.true()),
    )

    # Filter indexes — used by _load_pool_from_disk() and scheduler staleness sweep
    op.create_index("ix_job_pool_is_active",  "job_pool", ["is_active"])
    op.create_index("ix_job_pool_source",     "job_pool", ["source"])
    op.create_index("ix_job_pool_fetched_at", "job_pool", ["fetched_at"])
    op.create_index("ix_job_pool_posted_at",  "job_pool", ["posted_at"])


def downgrade() -> None:
    op.drop_index("ix_job_pool_posted_at",  table_name="job_pool")
    op.drop_index("ix_job_pool_fetched_at", table_name="job_pool")
    op.drop_index("ix_job_pool_source",     table_name="job_pool")
    op.drop_index("ix_job_pool_is_active",  table_name="job_pool")
    op.drop_table("job_pool")