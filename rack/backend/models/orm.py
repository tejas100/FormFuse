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
Session 45: User.role + User.is_restricted added for admin control system.
            DailySlotLog added — tracks which jobs were served in each daily slot
            so the same roles don't repeat across days.
"""

import uuid
from datetime import date, datetime, timezone
from typing import Optional

from sqlalchemy import (
    Boolean,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    PrimaryKeyConstraint,
    String,
    Text,
    TIMESTAMP,
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

    # ── Admin / access control ─────────────────────────────────────────────────
    # role:          'free' | 'pro' | 'admin'
    #                admin  → full access + can see /admin dashboard
    #                pro    → paid features (auto matches, tailoring, tracking)
    #                free   → Home ranking only, 5-resume cap
    # is_restricted: admin override to hard-limit a specific user regardless of role
    #                (e.g. abusive free user, trial expired, suspicious activity)
    role: Mapped[str] = mapped_column(
        String(20), nullable=False, server_default="free", default="free"
    )
    is_restricted: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default="false", default=False
    )

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
    daily_slot_logs: Mapped[list["DailySlotLog"]] = relationship(
        "DailySlotLog", back_populates="user", cascade="all, delete-orphan"
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
    applied:    Mapped[bool]               = mapped_column(Boolean, default=False, server_default="false", nullable=False)
    applied_at: Mapped[Optional[datetime]] = mapped_column(TIMESTAMP(timezone=True), nullable=True)

    __table_args__ = (
        UniqueConstraint("user_id", "job_id", name="uq_auto_match_user_job"),
    )

    user: Mapped["User"] = relationship("User", back_populates="auto_match_results")


# ── Archived Job IDs ───────────────────────────────────────────────────────────
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


# ── Daily Slot Log ─────────────────────────────────────────────────────────────
# Tracks which job_ids were served in each user's daily slot.
#
# Purpose:
#   - Dedup: same job never re-appears in a daily slot for the same user
#   - Query: "what was shown today?" without re-running scoring logic
#   - Analytics: per-user engagement with daily surfaced jobs
#
# rank_reason: why this job was included in the slot
#   'score'   — top-ranked by AI score
#   'recency' — most recently posted
#
# slot_date: UTC date the slot was generated (DATE, not timestamp)
#   Allows "show me today's slots" queries: WHERE slot_date = CURRENT_DATE
#
# UNIQUE(user_id, job_id, slot_date): idempotent — re-calling /daily-slots
#   on the same day returns the same set without inserting duplicates.
class DailySlotLog(Base):
    __tablename__ = "daily_slot_log"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False, index=True
    )
    job_id: Mapped[str] = mapped_column(String(64), nullable=False)
    slot_date: Mapped[date] = mapped_column(Date(), nullable=False)
    rank_reason: Mapped[str] = mapped_column(String(20), nullable=False)  # 'score' | 'recency'
    score: Mapped[float | None] = mapped_column(Float, nullable=True)
    served_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )

    __table_args__ = (
        UniqueConstraint(
            "user_id", "job_id", "slot_date",
            name="uq_daily_slot_user_job_date"
        ),
    )

    user: Mapped["User"] = relationship("User", back_populates="daily_slot_logs")