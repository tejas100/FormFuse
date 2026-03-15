"""
db/database.py — Async SQLAlchemy engine + session factory
Connects to Supabase Postgres via transaction pooler (asyncpg)

Usage:
    from db.database import get_db, engine
    # In FastAPI route:
    async def my_route(db: AsyncSession = Depends(get_db)):
        ...
"""

import os
from collections.abc import AsyncGenerator

from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase

# ── Base class for all ORM models ──────────────────────────────────────────────
class Base(DeclarativeBase):
    pass


# ── Engine ─────────────────────────────────────────────────────────────────────
DATABASE_URL = os.getenv("DATABASE_URL")

if not DATABASE_URL:
    raise RuntimeError(
        "DATABASE_URL is not set. "
        "Add it to your .env file pointing to Supabase transaction pooler."
    )

engine = create_async_engine(
    DATABASE_URL,
    # statement_cache_size=0 is required when using Supabase's transaction pooler
    # (pgbouncer in transaction mode). Without it, asyncpg caches prepared
    # statements that pgbouncer can't track across connections, causing
    # DuplicatePreparedStatementError on concurrent requests.
    connect_args={"statement_cache_size": 0},
    pool_pre_ping=True,
    pool_size=5,
    max_overflow=10,
    echo=False,  # Set True to log all SQL — useful for debugging
)

# ── Session factory ────────────────────────────────────────────────────────────
AsyncSessionLocal = async_sessionmaker(
    bind=engine,
    class_=AsyncSession,
    expire_on_commit=False,  # Keeps ORM objects usable after commit
    autoflush=False,
    autocommit=False,
)


# ── FastAPI dependency ─────────────────────────────────────────────────────────
async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """
    Yields an async DB session for use in FastAPI route dependencies.

    Example:
        @router.get("/items")
        async def list_items(db: AsyncSession = Depends(get_db)):
            result = await db.execute(select(Item))
            return result.scalars().all()
    """
    async with AsyncSessionLocal() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
        finally:
            await session.close()