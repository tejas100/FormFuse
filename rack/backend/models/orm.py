"""
models/orm.py — SQLAlchemy ORM models for RACK

Session 16: ResumeChunk.embedding changed from JSONB to pgvector Vector(384).
Session 19: Resume.full_text added — cleaned full resume text for LLM scoring.
Session 20: AutoMatchResult restructured — one snapshot per user per run_date (DATE).
            ArchivedJobId table added — global archive scoped per user.
Session 21: AutoMatchResult restructured — normalized rows, one per (user, job).
            Removed run_date snapshot model. UNIQUE(user_id, job_id) replaces
            UNIQUE(user_id, run_date). Promoted score + posted_at as real columns
            for indexed sorting/filtering. job_data JSONB holds full payload.
Session 22: SeenJobId table added — tracks every job_id ever fetched for a user,
            regardless of whether it passed Phase 1 or Phase 2 scoring.
            Used as the skip filter for truly_new jobs (replaces already_scored_ids).
            Also used as the pool for new-resume rescoring (future feature).
"""

import uuid
from datetime import datetime, timezone

from sqlalchemy import (
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
    seen_job_ids: Mapped[list["SeenJobId"]] = relationship(
        "SeenJobId", back_populates="user", cascade="all, delete-orphan"
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
# One row per (user, job). Upserted each time a job is scored for a user.
# UNIQUE(user_id, job_id) ensures no duplicate scores per user per job, ever.
#
# Promoted columns (real DB columns with indexes):
#   score     — llm_score (0–100), indexed for ORDER BY score DESC
#   posted_at — job posting date, indexed for recency filters (last 7d, 30d)
#
# job_data JSONB holds the complete scored payload (all pipeline fields).
# This schema scales to 10k+ users and 5+ years without modification.
class AutoMatchResult(Base):
    __tablename__ = "auto_match_results"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    job_id: Mapped[str] = mapped_column(String(64), nullable=False)
    job_data: Mapped[dict] = mapped_column(JSONB, nullable=False)
    score: Mapped[float] = mapped_column(Float, nullable=False)
    posted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    matched_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )

    __table_args__ = (
        UniqueConstraint("user_id", "job_id", name="uq_auto_match_user_job"),
    )

    user: Mapped["User"] = relationship("User", back_populates="auto_match_results")


# ── Archived Job IDs ───────────────────────────────────────────────────────────
# Global archive — a job dismissed by a user is hidden from all future results.
# Composite PK (user_id, job_id) enforces uniqueness.
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


# ── Seen Job IDs ───────────────────────────────────────────────────────────────
# One row per (user, job_id) — inserted the moment a job enters Phase 1 scoring,
# regardless of whether it passes Phase 1 or Phase 2.
#
# Purpose 1 (current): Skip filter for truly_new jobs.
#   truly_new = [j for j in role_matched if j["job_id"] not in seen_job_ids_set]
#   This ensures a job that scored 25 (below MIN_SCORE) is never re-attempted on
#   the next run — unlike the old already_scored_ids which only tracked jobs that
#   made it into auto_match_results.
#
# Purpose 2 (future — new resume upload):
#   When a user uploads resume #N, we query seen_job_ids to get the full pool of
#   jobs ever fetched for this user, then run Phase 1 + Phase 2 against resume #N
#   only. This re-uses the existing pool without re-fetching Greenhouse.
#
# Composite PK (user_id, job_id) enforces uniqueness — no duplication possible.
class SeenJobId(Base):
    __tablename__ = "seen_job_ids"

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    job_id: Mapped[str] = mapped_column(String(64), nullable=False)
    first_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )

    __table_args__ = (
        PrimaryKeyConstraint("user_id", "job_id", name="pk_seen_job_ids"),
    )

    user: Mapped["User"] = relationship("User", back_populates="seen_job_ids")