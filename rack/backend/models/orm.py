"""
models/orm.py — SQLAlchemy ORM models for RACK

Tables:
    users             — mirrors Supabase Auth users (synced on first login)
    resumes           — uploaded resume metadata
    resume_chunks     — chunked text + embeddings (pgvector-ready)
    tracked_jobs      — user's job tracking board
    auto_match_results — cached auto-match pipeline results
"""

import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    BigInteger,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from db.database import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


# ── Users ──────────────────────────────────────────────────────────────────────
class User(Base):
    """
    Mirrors Supabase Auth users table.
    Created automatically on first login via JWT middleware.
    id = Supabase Auth UUID (same UUID they issue in the JWT).
    """
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    display_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )

    # Relationships
    resumes: Mapped[list["Resume"]] = relationship(
        "Resume", back_populates="user", cascade="all, delete-orphan"
    )
    tracked_jobs: Mapped[list["TrackedJob"]] = relationship(
        "TrackedJob", back_populates="user", cascade="all, delete-orphan"
    )
    auto_match_results: Mapped[list["AutoMatchResult"]] = relationship(
        "AutoMatchResult", back_populates="user", cascade="all, delete-orphan"
    )


# ── Resumes ────────────────────────────────────────────────────────────────────
class Resume(Base):
    """
    Resume metadata. Actual PDF stored in Supabase Storage.
    chunks relationship gives access to all text chunks + embeddings.
    """
    __tablename__ = "resumes"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )

    # File metadata
    filename: Mapped[str] = mapped_column(String(500), nullable=False)        # original filename
    display_name: Mapped[str] = mapped_column(String(500), nullable=False)    # user-facing name
    storage_path: Mapped[str | None] = mapped_column(String(1000), nullable=True)  # Supabase Storage path
    file_ext: Mapped[str] = mapped_column(String(10), nullable=False)

    # Parsed metadata
    years_exp: Mapped[float | None] = mapped_column(Float, nullable=True)
    titles: Mapped[list[str] | None] = mapped_column(ARRAY(Text), nullable=True)
    domains: Mapped[list[str] | None] = mapped_column(ARRAY(Text), nullable=True)
    skills: Mapped[list[str] | None] = mapped_column(ARRAY(Text), nullable=True)

    # Ingestion stats
    chunk_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    section_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    status: Mapped[str] = mapped_column(String(50), default="active", nullable=False)

    uploaded_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )

    # Relationships
    user: Mapped["User"] = relationship("User", back_populates="resumes")
    chunks: Mapped[list["ResumeChunk"]] = relationship(
        "ResumeChunk", back_populates="resume", cascade="all, delete-orphan"
    )


# ── Resume Chunks ──────────────────────────────────────────────────────────────
class ResumeChunk(Base):
    """
    Chunked resume text with embeddings.
    user_id is denormalized here for fast per-user FAISS index rebuilds.
    embedding stored as JSON array for now (pgvector migration in Phase 3).
    """
    __tablename__ = "resume_chunks"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    resume_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("resumes.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )

    chunk_index: Mapped[int] = mapped_column(Integer, nullable=False)
    chunk_text: Mapped[str] = mapped_column(Text, nullable=False)

    # Embedding stored as JSONB array of floats (384-dim all-MiniLM-L6-v2)
    # Phase 3: migrate to pgvector column type
    embedding: Mapped[list | None] = mapped_column(JSONB, nullable=True)

    __table_args__ = (
        UniqueConstraint("resume_id", "chunk_index", name="uq_resume_chunk_index"),
    )

    # Relationships
    resume: Mapped["Resume"] = relationship("Resume", back_populates="chunks")


# ── Tracked Jobs ───────────────────────────────────────────────────────────────
class TrackedJob(Base):
    """
    User's job tracking board entries.
    status follows the existing Kanban board statuses from Tracking.jsx.
    """
    __tablename__ = "tracked_jobs"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )

    job_title: Mapped[str] = mapped_column(String(500), nullable=False)
    company: Mapped[str | None] = mapped_column(String(500), nullable=True)
    url: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(
        String(50), default="saved", nullable=False
    )  # saved | applied | interviewing | offer | rejected
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False
    )

    # Relationships
    user: Mapped["User"] = relationship("User", back_populates="tracked_jobs")


# ── Auto Match Results ─────────────────────────────────────────────────────────
class AutoMatchResult(Base):
    """
    Cached results from the auto-match pipeline.
    job_data is the full match payload (jsonb) — same shape as current JSON files.
    Replaces auto_match_results.json on disk.
    """
    __tablename__ = "auto_match_results"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )

    job_data: Mapped[dict] = mapped_column(JSONB, nullable=False)
    score: Mapped[float] = mapped_column(Float, nullable=False)
    fetched_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )

    # Relationships
    user: Mapped["User"] = relationship("User", back_populates="auto_match_results")