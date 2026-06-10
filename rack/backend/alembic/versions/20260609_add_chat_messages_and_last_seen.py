"""Add chat_messages table + users.last_seen_at for Command Center

Revision ID: 20260609_chat_cc
Create Date: 2026-06-09

⚠ ONE EDIT REQUIRED BEFORE RUNNING ⚠
Set `down_revision` below to your current head. Get it with:

    cd rack/backend && alembic heads

That prints something like `20260503_job_pool (head)` — paste the ID part
(everything before the space) into down_revision. It's the `revision = "..."`
value inside your newest migration file, NOT the filename.
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "20260609_chat_cc"
down_revision = "20260503_add_job_pool_table"  # ← run `alembic heads`, paste ID
branch_labels = None
depends_on = None


def upgrade():
    # users.last_seen_at — advanced by GET /api/chat/command-center.
    # Nullable: NULL means the user has never loaded the command center,
    # so their first visit shows new_matches=0 (nothing to diff against).
    op.add_column(
        "users",
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=True),
    )

    # chat_messages — durable mirror of the Home.jsx message list.
    # Full-replace sync: delete-all + bulk-insert per user, ordered by position.
    op.create_table(
        "chat_messages",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("position", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("payload", postgresql.JSONB(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
    )
    op.create_index("ix_chat_messages_user_id", "chat_messages", ["user_id"])


def downgrade():
    op.drop_index("ix_chat_messages_user_id", table_name="chat_messages")
    op.drop_table("chat_messages")
    op.drop_column("users", "last_seen_at")