"""
alembic/env.py — Alembic migration environment
Wired for async SQLAlchemy with RACK's ORM models.

Run migrations with:
    alembic upgrade head          # apply all pending migrations
    alembic revision --autogenerate -m "description"  # generate new migration
"""

import os
import sys
from logging.config import fileConfig
from pathlib import Path

from dotenv import load_dotenv
from sqlalchemy import pool

from alembic import context

# ── Make sure backend/ is on the path so models import cleanly ───────────────
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

load_dotenv()

# ── Alembic config ────────────────────────────────────────────────────────────
config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# ── Import all models so Alembic can detect them ──────────────────────────────
from db.database import Base
import models.orm  # noqa: F401 — registers User, Resume, ResumeChunk, etc. with Base

target_metadata = Base.metadata

# ── Override sqlalchemy.url with our env var ──────────────────────────────────
# Alembic uses the DIRECT connection (not pooler) for migrations
DATABASE_URL_DIRECT = os.getenv("DATABASE_URL_DIRECT") or os.getenv("DATABASE_URL")

# Alembic needs a sync URL — strip +asyncpg and swap in psycopg2
sync_url = DATABASE_URL_DIRECT
if sync_url and "+asyncpg" in sync_url:
    sync_url = sync_url.replace("+asyncpg", "+psycopg2")
if sync_url and "asyncpg" in sync_url and "+asyncpg" not in sync_url:
    sync_url = sync_url.replace("asyncpg", "psycopg2")

# configparser uses % for interpolation — escape all % as %% to avoid ValueError
config.set_main_option("sqlalchemy.url", sync_url.replace("%", "%%"))


# ── Offline mode (generates SQL without connecting) ───────────────────────────
def run_migrations_offline() -> None:
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


# ── Online mode (connects and applies migrations) ─────────────────────────────
def run_migrations_online() -> None:
    from sqlalchemy import engine_from_config

    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()