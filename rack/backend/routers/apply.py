"""
routers/apply.py — Auto-apply SSE endpoint

POST /api/apply/stream
  Auth:    required (Bearer JWT)
  Body:    { job_url, job_title, company, job_id, resume_id }
  Returns: text/event-stream — SSE steps from browser_agent

Each SSE event is:
  data: {"type": "step",  "status": "ok"|"skip"|"error"|"writing", "text": "..."}
  data: {"type": "done",  "text": "...", "filled_count": N, "job_url": "..."}
  data: {"type": "error", "text": "..."}

The agent fills everything but does NOT click Submit.
The frontend shows a live feed — user can verify the browser did what they expected.

Profile is assembled from:
  1. users.preferences JSONB (name, phone, location, linkedin, github, work_auth)
  2. users.email (from JWT)
  3. resumes.full_text + resumes.skills/titles/years_exp (from DB)
"""

import json
import logging
import os
import uuid as _uuid
from typing import Optional, AsyncGenerator

from fastapi import APIRouter, Depends, HTTPException, Security
from fastapi.responses import StreamingResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from db.database import get_db
from routers.auth import get_current_user

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/apply", tags=["apply"])

_optional_bearer = HTTPBearer(auto_error=False)


# ── Request schema ─────────────────────────────────────────────────────────────

class ApplyRequest(BaseModel):
    job_url:   str
    job_title: str
    company:   str
    job_id:    Optional[str] = None    # auto_match_results.job_id (for logging)
    resume_id: Optional[str] = None   # specific resume to use — None = use best


# ── Profile builder — assembles everything the agent needs ────────────────────

async def _build_profile(current_user, resume_id: Optional[str], db: AsyncSession) -> dict:
    """
    Assemble the full profile dict for the form filler.
    Pulls from: users row (email, preferences JSONB) + resumes row (full_text, skills, etc.)
    """
    from models.orm import Resume as ResumeORM

    prefs = current_user.preferences or {}

    profile = {
        "name":                prefs.get("name")     or (current_user.display_name or ""),
        "email":               current_user.email    or "",
        "phone":               prefs.get("phone")    or "",
        "location":            prefs.get("location") or "",
        "linkedin":            prefs.get("linkedin") or "",
        "github":              prefs.get("github")   or "",
        "website":             prefs.get("website")  or "",
        # work_auth / sponsorship — stored as "yes"/"no" in preferences
        "work_auth":           "yes" if prefs.get("work_auth") == "yes" else "no",
        "requires_sponsorship":"yes" if prefs.get("requires_sponsorship") == "yes" else "no",
        # EEO voluntary self-ID — default to "decline" if not set
        "gender_eeo":          prefs.get("gender_eeo")          or "decline",
        "veteran_status":      prefs.get("veteran_status")      or "decline",
        "disability_status":   prefs.get("disability_status")   or "decline",
    }

    # Fetch resume — specific one if requested, otherwise most recent active
    resume_row = None
    try:
        if resume_id:
            result = await db.execute(
                select(ResumeORM).where(
                    ResumeORM.id      == _uuid.UUID(resume_id),
                    ResumeORM.user_id == current_user.id,
                    ResumeORM.status  == "active",
                )
            )
            resume_row = result.scalar_one_or_none()

        if not resume_row:
            # Fall back to most recently uploaded active resume
            result = await db.execute(
                select(ResumeORM)
                .where(ResumeORM.user_id == current_user.id, ResumeORM.status == "active")
                .order_by(ResumeORM.uploaded_at.desc())
                .limit(1)
            )
            resume_row = result.scalar_one_or_none()
    except Exception as e:
        logger.warning(f"[apply] Could not fetch resume: {e}")

    if resume_row:
        profile["years_exp"]   = resume_row.years_exp
        profile["titles"]      = resume_row.titles  or []
        profile["skills"]      = resume_row.skills  or []
        profile["resume_text"] = resume_row.full_text or ""
        profile["resume_name"] = resume_row.display_name or resume_row.filename or ""

    return profile


# ── SSE event formatter ────────────────────────────────────────────────────────

def _sse(data: dict) -> str:
    """Format a dict as an SSE data line."""
    return f"data: {json.dumps(data)}\n\n"


# ── Streaming endpoint ─────────────────────────────────────────────────────────

@router.post("/stream")
async def apply_stream(
    request:     ApplyRequest,
    credentials: Optional[HTTPAuthorizationCredentials] = Security(_optional_bearer),
    db:          AsyncSession = Depends(get_db),
):
    """
    SSE stream — auto-fills a job application form.
    Auth required. Returns text/event-stream.
    """
    # ── Auth ──────────────────────────────────────────────────────────────────
    if not credentials or not credentials.credentials:
        raise HTTPException(status_code=401, detail="Authentication required to auto-apply.")

    try:
        current_user = await get_current_user(credentials=credentials, db=db)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=401, detail="Invalid token.")

    if not request.job_url or not request.job_url.startswith("http"):
        raise HTTPException(status_code=400, detail="Valid job URL is required.")

    # ── Assemble profile ─────────────────────────────────────────────────────
    try:
        profile = await _build_profile(current_user, request.resume_id, db)
    except Exception as e:
        logger.error(f"[apply] Profile build failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Could not load user profile.")

    if not profile.get("email"):
        raise HTTPException(status_code=400, detail="Email not found in your profile. Please update your Account settings.")

    logger.info(
        f"[apply] Starting agent — user={current_user.email} "
        f"job={request.job_title} at {request.company} url={request.job_url}"
    )

    # ── Stream generator ──────────────────────────────────────────────────────
    async def event_stream() -> AsyncGenerator[str, None]:
        from services.browser_agent import run_apply_agent
        from datetime import datetime, timezone
        from models.orm import AutoMatchResult
        from sqlalchemy import update as sa_update

        try:
            async for event in run_apply_agent(
                job_url     = request.job_url,
                job_title   = request.job_title,
                company     = request.company,
                resume_text = profile.get("resume_text", ""),
                profile     = profile,
                job_id      = request.job_id,
            ):
                yield _sse(event)

                # On successful submit — mark applied in DB
                if event.get("type") == "submitted" and event.get("job_id"):
                    try:
                        async with __import__("db.database", fromlist=["AsyncSessionLocal"]).AsyncSessionLocal() as apply_db:
                            await apply_db.execute(
                                sa_update(AutoMatchResult)
                                .where(
                                    AutoMatchResult.user_id == current_user.id,
                                    AutoMatchResult.job_id  == event["job_id"],
                                )
                                .values(
                                    applied    = True,
                                    applied_at = datetime.now(timezone.utc),
                                )
                            )
                            await apply_db.commit()
                        logger.info(f"[apply] Marked job {event['job_id']} as applied for user {current_user.email}")
                    except Exception as db_err:
                        logger.warning(f"[apply] DB update after submit failed: {db_err}")

        except Exception as e:
            logger.error(f"[apply] Stream error: {e}", exc_info=True)
            yield _sse({"type": "error", "text": "Agent failed unexpectedly. Please try again."})

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control":               "no-cache",
            "X-Accel-Buffering":           "no",
            "Access-Control-Allow-Origin": "*",
        },
    )