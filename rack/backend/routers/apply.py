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

import asyncio
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

# Stores asyncio.Events keyed by Steel session_id.
# browser_agent yields "review_required" then blocks on the event.
# POST /api/apply/confirm/{session_id} sets it, unblocking the agent.
_pending_reviews: dict[str, asyncio.Event] = {}

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
        profile["years_exp"]    = resume_row.years_exp
        profile["titles"]       = resume_row.titles  or []
        profile["skills"]       = resume_row.skills  or []
        profile["resume_text"]  = resume_row.full_text or ""
        profile["resume_name"]  = resume_row.display_name or resume_row.filename or ""
        profile["_resume_id"]   = str(resume_row.id)   # resolved resume ID for file upload

        # Best-effort: extract most recent company name from resume text.
        # Used to answer "current/most recent company" fields without hallucinating.
        # Best-effort: extract most recent company from resume text.
        # Looks for a capitalized line following an "Experience" section header.
        _company = ""
        _rtext = resume_row.full_text or ""
        if _rtext:
            import re as _bre
            _lines = _rtext.split("\n")
            _in_exp = False
            for _ln in _lines:
                _lnl = _ln.strip().lower()
                if any(h in _lnl for h in ("experience", "employment", "work history")):
                    _in_exp = True
                    continue
                if _in_exp and _ln.strip() and len(_ln.strip()) > 2:
                    # First non-empty line after the section header is likely the company
                    _candidate = _ln.strip()
                    if _candidate[0].isupper() and len(_candidate.split()) <= 8:
                        _company = _candidate
                        break
        profile["current_company"] = _company

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
        from sqlalchemy import update as sa_update, delete as sa_delete

        # Create the review gate event upfront.
        # Keyed by a placeholder until the agent emits steel_session with real session_id.
        # Once "steel_session" arrives we re-key it so the confirm endpoint can find it.
        _review_event = asyncio.Event()
        _stream_key   = str(_uuid.uuid4())   # temp key until steel session_id arrives
        _pending_reviews[_stream_key] = _review_event

        try:
            # Use resolved resume_id from profile builder — always set even when
            # request.resume_id is None (profile builder picks best/most-recent).
            _resolved_resume_id = profile.get("_resume_id") or request.resume_id

            async for event in run_apply_agent(
                job_url      = request.job_url,
                job_title    = request.job_title,
                company      = request.company,
                resume_text  = profile.get("resume_text", ""),
                profile      = profile,
                job_id       = request.job_id,
                resume_id    = _resolved_resume_id,
                user_id      = str(current_user.id),
                review_event = _review_event,
            ):
                # When the Steel session ID arrives, re-key the pending review
                # so POST /api/apply/confirm/{session_id} can look it up.
                if event.get("type") == "steel_session" and event.get("session_id"):
                    sid = event["session_id"]
                    _pending_reviews[sid] = _review_event
                    _pending_reviews.pop(_stream_key, None)
                    logger.info(f"[apply] Review gate registered for session_id={sid}")

                yield _sse(event)

                # Job posting no longer exists — delete from auto_match_results
                # so it never surfaces again for this user.
                if event.get("type") == "job_removed" and event.get("job_id"):
                    try:
                        from db.database import AsyncSessionLocal
                        async with AsyncSessionLocal() as rm_db:
                            await rm_db.execute(
                                sa_delete(AutoMatchResult).where(
                                    AutoMatchResult.user_id == current_user.id,
                                    AutoMatchResult.job_id  == event["job_id"],
                                )
                            )
                            await rm_db.commit()
                        logger.info(
                            f"[apply] Deleted removed job {event['job_id']} "
                            f"from auto_match_results for user {current_user.email}"
                        )
                    except Exception as db_err:
                        logger.warning(f"[apply] DB delete after job_removed failed: {db_err}")

                # On successful submit — mark applied in DB
                if event.get("type") == "submitted" and event.get("job_id"):
                    try:
                        from db.database import AsyncSessionLocal
                        async with AsyncSessionLocal() as apply_db:
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
        finally:
            # Always clean up pending review entries when the stream ends
            _pending_reviews.pop(_stream_key, None)
            if "_review_event" in dir():
                # Find and remove any key pointing to this event
                stale = [k for k, v in list(_pending_reviews.items()) if v is _review_event]
                for k in stale:
                    _pending_reviews.pop(k, None)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control":               "no-cache",
            "X-Accel-Buffering":           "no",
            "Access-Control-Allow-Origin": "*",
        },
    )


# ── Review confirmation endpoint ───────────────────────────────────────────────

class ConfirmRequest(BaseModel):
    action: str = "submit"   # "submit" | "cancel"


@router.post("/confirm/{session_id}")
async def confirm_review(
    session_id:  str,
    body:        ConfirmRequest,
    credentials: Optional[HTTPAuthorizationCredentials] = Security(_optional_bearer),
    db:          AsyncSession = Depends(get_db),
):
    """
    Unblock the review gate in a running apply stream.

    Called by the frontend when the user clicks "Confirm & Submit" or "Cancel"
    in ApplyAgentCard after reviewing the filled form in the Steel panel.

    session_id: the Steel session_id emitted in the "steel_session" SSE event.
    body.action: "submit" (proceed) | "cancel" (abort — not yet implemented,
                 treated as timeout on the agent side).
    """
    if not credentials or not credentials.credentials:
        raise HTTPException(status_code=401, detail="Authentication required.")
    try:
        await get_current_user(credentials=credentials, db=db)
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid token.")

    event = _pending_reviews.get(session_id)
    if not event:
        logger.warning(f"[apply/confirm] No pending review for session_id={session_id!r}")
        raise HTTPException(
            status_code=404,
            detail="No pending review found for this session. It may have already been confirmed or timed out.",
        )

    if body.action == "submit":
        event.set()
        logger.info(f"[apply/confirm] Review confirmed — session_id={session_id}")
        return {"ok": True, "message": "Application will be submitted now."}
    else:
        # Cancel: don't set the event — it will time out naturally
        # and yield "review_timeout" to the frontend.
        _pending_reviews.pop(session_id, None)
        logger.info(f"[apply/confirm] Review cancelled — session_id={session_id}")
        return {"ok": True, "message": "Application cancelled."}