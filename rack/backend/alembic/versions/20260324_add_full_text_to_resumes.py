"""add full_text to resumes

Revision ID: add_full_text_resumes
Revises: a1b2c3d4e5f6
Create Date: 2026-03-24

Adds a `full_text` TEXT column to the `resumes` table.
Nullable — existing rows will be NULL until re-uploaded.
No index needed: this column is read, never searched.
"""

from alembic import op
import sqlalchemy as sa

# revision identifiers
revision = "add_full_text_resumes"
down_revision = "a1b2c3d4e5f6"   # ← your current head; adjust if different
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "resumes",
        sa.Column("full_text", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("resumes", "full_text")