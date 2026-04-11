
# down_revision = "20260326_add_seen_job_ids"  # ← replace with your actual latest revision id


"""
20260410_admin_role_and_daily_slots.py

Adds:
  1. users.role         — VARCHAR(20), default 'free'. Values: 'free' | 'pro' | 'admin'
  2. users.is_restricted — BOOLEAN, default false. Admin can flip to hard-limit a user.
  3. daily_slot_log     — tracks which job_ids were served in each user's daily slot,
                          so the same jobs don't repeat across days and we can query
                          "what was shown today" without re-computing on every request.

Revision identifiers — paste these into alembic/versions/ and run:
    alembic upgrade head
"""

from alembic import op
import sqlalchemy as sa

revision = "20260410_admin_role_daily"
down_revision = "20260406_add_applied"   # ← update to your actual latest revision id
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ── 1. Add role + is_restricted to users ─────────────────────────────────
    op.add_column(
        "users",
        sa.Column(
            "role",
            sa.String(20),
            nullable=False,
            server_default="free",
        ),
    )
    op.add_column(
        "users",
        sa.Column(
            "is_restricted",
            sa.Boolean(),
            nullable=False,
            server_default="false",
        ),
    )

    # ── 2. Bootstrap: set your account to admin immediately ──────────────────
    # Your user ID — this runs at migration time, safe to hardcode here.
    op.execute(
        """
        UPDATE users
        SET role = 'admin', is_restricted = false
        WHERE id = 'de66f6db-4081-4bf3-a646-1ba6acb0e134'
        """
    )

    # ── 3. Create daily_slot_log ──────────────────────────────────────────────
    op.create_table(
        "daily_slot_log",
        sa.Column("id", sa.dialects.postgresql.UUID(as_uuid=True),
                  primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("user_id", sa.dialects.postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("users.id", ondelete="CASCADE"),
                  nullable=False, index=True),
        sa.Column("job_id", sa.String(64), nullable=False),
        sa.Column("slot_date", sa.Date(), nullable=False),        # UTC date the slot was generated
        sa.Column("rank_reason", sa.String(20), nullable=False),  # 'score' | 'recency'
        sa.Column("score", sa.Float(), nullable=True),
        sa.Column("served_at", sa.DateTime(timezone=True),
                  server_default=sa.text("NOW()"), nullable=False),
    )

    # Unique: one entry per (user, job, date) — idempotent re-serves don't dupe
    op.create_unique_constraint(
        "uq_daily_slot_user_job_date",
        "daily_slot_log",
        ["user_id", "job_id", "slot_date"],
    )

    # Index for fast "give me today's slots for user X" query
    op.create_index(
        "ix_daily_slot_log_user_date",
        "daily_slot_log",
        ["user_id", "slot_date"],
    )


def downgrade() -> None:
    op.drop_index("ix_daily_slot_log_user_date", table_name="daily_slot_log")
    op.drop_constraint("uq_daily_slot_user_job_date", "daily_slot_log")
    op.drop_table("daily_slot_log")
    op.drop_column("users", "is_restricted")
    op.drop_column("users", "role")