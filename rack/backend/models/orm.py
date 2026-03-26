"""
models/orm.py — SQLAlchemy ORM models for RACK

Session 16: ResumeChunk.embedding changed from JSONB to pgvector Vector(384).
Session 19: Resume.full_text added — cleaned full resume text for LLM scoring.
Session 20: AutoMatchResult restructured — one snapshot per user per run_date (DATE).
            ArchivedJobId table added — global archive scoped per user.
"""

import uuid
from datetime import datetime, timezone, date

from sqlalchemy import (
    Date,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    PrimaryKeyConstraint,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship
from pgvector.sqlalchemy import Vector

from db.database import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


# ── Users ──────────────────────────────────────────────────────────────────────
class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    display_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )
    preferences: Mapped[dict | None] = mapped_column(JSONB, nullable=True, default=dict)

    resumes: Mapped[list["Resume"]] = relationship(
        "Resume", back_populates="user", cascade="all, delete-orphan"
    )
    tracked_jobs: Mapped[list["TrackedJob"]] = relationship(
        "TrackedJob", back_populates="user", cascade="all, delete-orphan"
    )
    auto_match_results: Mapped[list["AutoMatchResult"]] = relationship(
        "AutoMatchResult", back_populates="user", cascade="all, delete-orphan"
    )
    archived_job_ids: Mapped[list["ArchivedJobId"]] = relationship(
        "ArchivedJobId", back_populates="user", cascade="all, delete-orphan"
    )


# ── Resumes ────────────────────────────────────────────────────────────────────
class Resume(Base):
    __tablename__ = "resumes"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    filename: Mapped[str] = mapped_column(String(500), nullable=False)
    display_name: Mapped[str] = mapped_column(String(500), nullable=False)
    storage_path: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    file_ext: Mapped[str] = mapped_column(String(10), nullable=False)
    years_exp: Mapped[float | None] = mapped_column(Float, nullable=True)
    titles: Mapped[list[str] | None] = mapped_column(ARRAY(Text), nullable=True)
    domains: Mapped[list[str] | None] = mapped_column(ARRAY(Text), nullable=True)
    skills: Mapped[list[str] | None] = mapped_column(ARRAY(Text), nullable=True)
    chunk_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    section_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    status: Mapped[str] = mapped_column(String(50), default="active", nullable=False)
    uploaded_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )
    full_text: Mapped[str | None] = mapped_column(Text, nullable=True)

    user: Mapped["User"] = relationship("User", back_populates="resumes")
    chunks: Mapped[list["ResumeChunk"]] = relationship(
        "ResumeChunk", back_populates="resume", cascade="all, delete-orphan"
    )


# ── Resume Chunks ──────────────────────────────────────────────────────────────
class ResumeChunk(Base):
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
    embedding: Mapped[list | None] = mapped_column(Vector(384), nullable=True)

    __table_args__ = (
        UniqueConstraint("resume_id", "chunk_index", name="uq_resume_chunk_index"),
    )

    resume: Mapped["Resume"] = relationship("Resume", back_populates="chunks")


# ── Tracked Jobs ───────────────────────────────────────────────────────────────
class TrackedJob(Base):
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
    status: Mapped[str] = mapped_column(String(50), default="saved", nullable=False)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False
    )

    user: Mapped["User"] = relationship("User", back_populates="tracked_jobs")


# ── Auto Match Results ─────────────────────────────────────────────────────────
# One row per user per run_date. job_data stores the full array of up to 50
# matched job entries as JSONB. Re-running the pipeline on the same calendar
# day upserts (overwrites) the existing row via ON CONFLICT (user_id, run_date).
class AutoMatchResult(Base):
    __tablename__ = "auto_match_results"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # One snapshot per calendar day per user
    run_date: Mapped[date] = mapped_column(Date, nullable=False)
    # Full array of up to STORE_CAP matched jobs with all scoring fields
    job_data: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )

    __table_args__ = (
        UniqueConstraint("user_id", "run_date", name="uq_auto_match_user_run_date"),
    )

    user: Mapped["User"] = relationship("User", back_populates="auto_match_results")


# ── Archived Job IDs ───────────────────────────────────────────────────────────
# Global archive — a job dismissed from any snapshot is hidden across all
# snapshots for that user. Composite PK (user_id, job_id) enforces uniqueness.
class ArchivedJobId(Base):
    __tablename__ = "archived_job_ids"

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    job_id: Mapped[str] = mapped_column(String(64), nullable=False)
    archived_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )

    __table_args__ = (
        PrimaryKeyConstraint("user_id", "job_id", name="pk_archived_job_ids"),
    )

    user: Mapped["User"] = relationship("User", back_populates="archived_job_ids")