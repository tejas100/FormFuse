"""resume_optimizer_tables

Revision ID: 20260701_resume_optimizer_tables
Revises: 20260627_recommended_resume_id
Create Date: 2026-07-01
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision = "20260701_resume_optimizer_tables"
down_revision = "20260627_recommended_resume_id"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("resumes", sa.Column("structured_json", postgresql.JSONB(), nullable=True))
    op.add_column("resumes", sa.Column("is_optimized", sa.Boolean(), nullable=False, server_default="false"))
    op.add_column(
        "resumes",
        sa.Column("source_resume_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("resumes.id"), nullable=True),
    )
    op.create_index("idx_resumes_source_resume_id", "resumes", ["source_resume_id"])

    op.add_column(
        "apply_jobs",
        sa.Column("resume_status", sa.String(length=20), nullable=False, server_default="pending"),
    )

    op.create_table(
        "resume_optimizations",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column(
            "apply_job_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("apply_jobs.id", ondelete="CASCADE"),
            nullable=False,
            unique=True,
        ),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("source_resume_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("resumes.id"), nullable=False),
        sa.Column("optimized_resume_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("resumes.id"), nullable=True),
        sa.Column("job_id", sa.String(length=64), nullable=True),
        sa.Column("structured_doc", postgresql.JSONB(), nullable=False),
        sa.Column("patches", postgresql.JSONB(), nullable=False, server_default="[]"),
        sa.Column("requirement_classification", postgresql.JSONB(), nullable=False, server_default="[]"),
        sa.Column("decisions", postgresql.JSONB(), nullable=False, server_default="{}"),
        sa.Column("manual_edits", postgresql.JSONB(), nullable=False, server_default="{}"),
        sa.Column("match_score", postgresql.JSONB(), nullable=True),
        sa.Column("status", sa.String(length=20), nullable=False, server_default="optimizing"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("approved_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("idx_resume_optimizations_user_id", "resume_optimizations", ["user_id"])


def downgrade():
    op.drop_index("idx_resume_optimizations_user_id", table_name="resume_optimizations")
    op.drop_table("resume_optimizations")
    op.drop_column("apply_jobs", "resume_status")
    op.drop_index("idx_resumes_source_resume_id", table_name="resumes")
    op.drop_column("resumes", "source_resume_id")
    op.drop_column("resumes", "is_optimized")
    op.drop_column("resumes", "structured_json")