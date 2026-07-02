"""
models/orm.py — SQLAlchemy ORM models for RACK

Session 16: ResumeChunk.embedding changed from JSONB to pgvector Vector(384).
Session 55: ResumeChunk.embedding updated to Vector(1536) — OpenAI text-embedding-3-small.
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

    # ── Command Center ──────────────────────────────────────────────────────────
    # last_seen_at: advanced by GET /api/chat/command-center on each Home load.
    # "New matches since your last visit" diffs matched_at against the PREVIOUS
    # value of this column. NULL = user has never loaded the command center.
    last_seen_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

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
    chat_messages: Mapped[list["ChatMessage"]] = relationship(
        "ChatMessage", back_populates="user", cascade="all, delete-orphan"
    )
    apply_batches: Mapped[list["ApplyBatch"]] = relationship(
        "ApplyBatch", back_populates="user", cascade="all, delete-orphan"
    )
    apply_jobs: Mapped[list["ApplyJob"]] = relationship(
        "ApplyJob", back_populates="user", cascade="all, delete-orphan"
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

    # Added Migration B (2026-06-27): averaged chunk embedding for instant match
    resume_embedding: Mapped[list | None] = mapped_column(Vector(1536), nullable=True)

    # Added — resume optimizer document model (services/resume_parser.py).
    # Cached on first optimize call so repeat applies against the same base
    # resume skip re-parsing. Shape: see resume_parser.py module docstring.
    structured_json: Mapped[dict | None] = mapped_column(JSONB, nullable=True)

    # Added — optimizer output rows. An "optimized" resume is a REAL row in
    # this same table (so browser_agent.py's file-upload lookup needs zero
    # changes — it already resolves any resume_id -> storage_path), flagged
    # so it's excluded from the user's manual 5-resume cap and from
    # Home/Dashboard matching. source_resume_id points at the original.
    is_optimized: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    source_resume_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("resumes.id"), nullable=True
    )

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
    embedding: Mapped[list | None] = mapped_column(Vector(1536), nullable=True)

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

    # Added Migration C (2026-06-27): False = instant pgvector match, True = LLM confirmed
    llm_scored: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false", nullable=False)

    # Added Migration D (2026-06-27): which resume produced the best score for this job
    recommended_resume_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)

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

# ── Chat Messages ──────────────────────────────────────────────────────────────
# Durable chat history — one row per persisted Home.jsx message payload.
#
# Sync model: full-replace (last-write-wins). The frontend mirrors its capped
# localStorage message list via PUT /api/chat/history, which deletes all rows
# for the user and re-inserts in order. `position` defines ordering; row ids
# are ephemeral and never referenced by the client.
#
# payload: the exact message object Home.jsx renders (rank results, filter
# tables, apply results, etc.) — stored as-is so rehydration is a straight
# setMessages(payloads) with no transformation layer to drift.
class ChatMessage(Base):
    __tablename__ = "chat_messages"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False, index=True
    )
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    payload: Mapped[dict] = mapped_column(JSONB, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )

    user: Mapped["User"] = relationship("User", back_populates="chat_messages")

# ── Batch Auto-Apply ───────────────────────────────────────────────────────────
# Session: batch apply system — Phase 1 (Fill & Capture) / Phase 2 (Replay & Submit).
#
# ApplyJob.status state machine:
#   queued → filling → awaiting_review → approved → replaying → submitted
#                   ↘ failed / job_removed              ↘ failed / needs_attention
#   awaiting_review → skipped (user declined)
#
#   needs_attention = Submit was clicked but no confirmation page detected.
#   NEVER auto-retried — the application may have gone through; a human must
#   check the ATS first.
#
# draft: the contract between agent and user — the exact list of
#   {field_label, selector_hint, field_type, value, skip} entries the headless
#   agent filled in Phase 1. Phase 2 replays it verbatim (plus user_edits).
class ApplyBatch(Base):
    __tablename__ = "apply_batches"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False, index=True
    )
    # pending → processing → awaiting_review → completed | failed
    status: Mapped[str] = mapped_column(
        String(32), nullable=False, default="pending", server_default="pending"
    )
    job_count: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    resume_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    notified_at:  Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    user: Mapped["User"] = relationship("User", back_populates="apply_batches")
    jobs: Mapped[list["ApplyJob"]] = relationship(
        "ApplyJob", back_populates="batch", cascade="all, delete-orphan"
    )


class ApplyJob(Base):
    __tablename__ = "apply_jobs"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    batch_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("apply_batches.id", ondelete="CASCADE"),
        nullable=False, index=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False, index=True
    )

    job_id:    Mapped[str | None] = mapped_column(String(64), nullable=True)  # auto_match_results.job_id
    job_url:   Mapped[str]        = mapped_column(Text, nullable=False)
    job_title: Mapped[str]        = mapped_column(Text, nullable=False, default="", server_default="")
    company:   Mapped[str]        = mapped_column(Text, nullable=False, default="", server_default="")

    # queued → filling → awaiting_review → approved → replaying
    #   → (awaiting_otp → replaying)* → submitted | needs_attention
    # | failed | skipped | job_removed
    status: Mapped[str] = mapped_column(
        String(32), nullable=False, default="queued", server_default="queued", index=True
    )

    # Separate lifecycle from `status` above — gates WHEN Phase 1 filling is
    # allowed to start. create_apply_batch() no longer fires process_batch()
    # immediately; it fires optimize_batch_resumes() instead, and Phase 1
    # for a given job only runs after that job's resume_status hits
    # "approved" (see POST /jobs/{id}/resume/approve).
    #   pending → optimizing → ready → approved | failed
    resume_status: Mapped[str] = mapped_column(
        String(20), nullable=False, default="pending", server_default="pending"
    )

    # Phase 1 artifacts — what the user reviews
    draft:             Mapped[list | None]      = mapped_column(JSONB, nullable=True)
    screenshot_paths:  Mapped[list[str] | None] = mapped_column(ARRAY(Text), nullable=True)
    filled_count:      Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    validation_errors: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")

    # Phase 2 artifacts
    user_edits:              Mapped[list | None] = mapped_column(JSONB, nullable=True)  # [{field_label, new_value}]
    confirmation_screenshot: Mapped[str | None]  = mapped_column(Text, nullable=True)
    confirmation_text:       Mapped[str | None]  = mapped_column(Text, nullable=True)

    # Email security-code (OTP) gate — Greenhouse emails an 8-char code and
    # disables Submit until it is entered. Phase 1 detects the section
    # (otp_expected); Phase 2 pauses at status=awaiting_otp until the user
    # enters the code via POST /api/apply/jobs/{id}/otp.
    otp_expected:         Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    otp_email_hint:       Mapped[str | None]      = mapped_column(Text, nullable=True)
    otp_requested_at:     Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    presubmit_screenshot: Mapped[str | None]      = mapped_column(Text, nullable=True)

    error:    Mapped[str | None] = mapped_column(Text, nullable=True)
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False
    )

    user:  Mapped["User"]       = relationship("User", back_populates="apply_jobs")
    batch: Mapped["ApplyBatch"] = relationship("ApplyBatch", back_populates="jobs")


# ── Resume Optimizations ────────────────────────────────────────────────────────
# One row per (apply_job) — the surgical-patch optimizer's output for that
# specific application, plus the user's accept/reject/manual-edit decisions.
# UNIQUE(apply_job_id): exactly one optimization run per application.
#
# structured_doc: snapshot of the parsed document AT OPTIMIZE TIME (not a
#   live reference to resumes.structured_json) — the GET /resume endpoint
#   reads this row alone, no join/re-derivation needed, and it stays
#   correct even if the base resume is re-parsed later for a different job.
# patches: services/resume_optimizer.py's validated patch list, verbatim.
# decisions: {patch_id: "accepted" | "rejected"} — starts all-accepted.
# manual_edits: {field_id: final_text} — freehand overrides from the editor,
#   same key scheme the frontend uses ("header:name", "b_uber_1",
#   "exp:{company_id}:company", etc.)
# optimized_resume_id: set on approve — points at the NEW `resumes` row
#   (is_optimized=True) holding the rendered PDF that actually gets
#   uploaded to the ATS. NULL until approved.
class ResumeOptimization(Base):
    __tablename__ = "resume_optimizations"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    apply_job_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("apply_jobs.id", ondelete="CASCADE"),
        nullable=False, unique=True, index=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    source_resume_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("resumes.id"), nullable=False
    )
    optimized_resume_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("resumes.id"), nullable=True
    )
    job_id: Mapped[str | None] = mapped_column(String(64), nullable=True)

    structured_doc:              Mapped[dict] = mapped_column(JSONB, nullable=False)
    patches:                     Mapped[list] = mapped_column(JSONB, nullable=False, default=list, server_default="[]")
    requirement_classification:  Mapped[list] = mapped_column(JSONB, nullable=False, default=list, server_default="[]")
    decisions:                   Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict, server_default="{}")
    manual_edits:                Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict, server_default="{}")
    match_score:                 Mapped[dict | None] = mapped_column(JSONB, nullable=True)

    # optimizing → ready → approved | failed
    status: Mapped[str] = mapped_column(
        String(20), nullable=False, default="optimizing", server_default="optimizing"
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)