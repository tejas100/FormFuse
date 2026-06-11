"""Add apply_batches and apply_jobs tables for batch auto-apply

Revision ID: 20260610_apply_batches
Revises: <SET_ME — run `alembic heads` and paste the current head revision here>
Create Date: 2026-06-10

NOTE: also add nothing extra in alembic/env.py — these models now live in
models/orm.py which env.py already imports, so autogenerate sees them
automatically.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision      = "20260610_apply_batches"
down_revision = "20260609_chat_cc"
branch_labels = None
depends_on    = None


def upgrade():
    op.create_table(
        "apply_batches",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False, index=True),
        sa.Column("status", sa.String(32), nullable=False, server_default="pending"),
        sa.Column("job_count", sa.Integer, nullable=False, server_default="0"),
        sa.Column("resume_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("notified_at", sa.DateTime(timezone=True), nullable=True),
    )

    op.create_table(
        "apply_jobs",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("batch_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("apply_batches.id"), nullable=False, index=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False, index=True),
        sa.Column("job_id", sa.String(64), nullable=True),
        sa.Column("job_url", sa.Text, nullable=False),
        sa.Column("job_title", sa.Text, nullable=False, server_default=""),
        sa.Column("company", sa.Text, nullable=False, server_default=""),
        sa.Column("status", sa.String(32), nullable=False, server_default="queued", index=True),
        sa.Column("draft", postgresql.JSONB, nullable=True),
        sa.Column("screenshot_paths", postgresql.ARRAY(sa.Text), nullable=True),
        sa.Column("filled_count", sa.Integer, nullable=False, server_default="0"),
        sa.Column("validation_errors", sa.Integer, nullable=False, server_default="0"),
        sa.Column("user_edits", postgresql.JSONB, nullable=True),
        sa.Column("confirmation_screenshot", sa.Text, nullable=True),
        sa.Column("confirmation_text", sa.Text, nullable=True),
        sa.Column("error", sa.Text, nullable=True),
        sa.Column("attempts", sa.Integer, nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
    )


def downgrade():
    op.drop_table("apply_jobs")
    op.drop_table("apply_batches")