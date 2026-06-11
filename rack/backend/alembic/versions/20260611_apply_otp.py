"""Add email security-code (OTP) gate columns to apply_jobs

Revision ID: 20260611_apply_otp
Revises: <SET_ME — run `alembic heads` and paste the current head revision id>
Create Date: 2026-06-11

New columns on apply_jobs:
  otp_expected          — Phase 1 detected a security-code section on the form
  otp_email_hint        — the email address Greenhouse says the code was sent to
  otp_requested_at      — when Phase 2 paused at the OTP gate
  presubmit_screenshot  — storage path of the final-form screenshot taken right
                          before the Submit click (Phase 2 replay proof)

Equivalent raw SQL (Supabase SQL editor), if you'd rather skip Alembic:

  ALTER TABLE apply_jobs
    ADD COLUMN IF NOT EXISTS otp_expected boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS otp_email_hint text,
    ADD COLUMN IF NOT EXISTS otp_requested_at timestamptz,
    ADD COLUMN IF NOT EXISTS presubmit_screenshot text;
"""

from alembic import op
import sqlalchemy as sa

revision      = "20260611_apply_otp"
down_revision = "20260610_apply_batches"   # ← current head from `alembic heads`
branch_labels = None
depends_on    = None


def upgrade() -> None:
    op.add_column("apply_jobs", sa.Column(
        "otp_expected", sa.Boolean(), nullable=False, server_default="false"))
    op.add_column("apply_jobs", sa.Column(
        "otp_email_hint", sa.Text(), nullable=True))
    op.add_column("apply_jobs", sa.Column(
        "otp_requested_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("apply_jobs", sa.Column(
        "presubmit_screenshot", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("apply_jobs", "presubmit_screenshot")
    op.drop_column("apply_jobs", "otp_requested_at")
    op.drop_column("apply_jobs", "otp_email_hint")
    op.drop_column("apply_jobs", "otp_expected")