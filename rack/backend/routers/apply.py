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

Email security-code (OTP) gate: some ATSes (Greenhouse) email the candidate a
code and disable Submit until it is entered. The agent emits "otp_required";
the code travels back via:
  POST /api/apply/otp/{session_id}      — live SSE flow (keyed by Steel session)
  POST /api/apply/jobs/{id}/otp         — batch Phase 2 flow (keyed by ApplyJob)

Profile is assembled from:
  1. users.preferences JSONB (name, phone, location, linkedin, github, work_auth)
  2. users.email (from JWT)
  3. resumes.full_text + resumes.skills/titles/years_exp (from DB)
"""

import asyncio
import json
import logging
import os
import re as _otp_re
import uuid as _uuid
from typing import Optional, AsyncGenerator

from fastapi import APIRouter, Depends, HTTPException, Security
from fastapi.responses import StreamingResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from db.database import get_db, AsyncSessionLocal
from routers.auth import get_current_user

logger = logging.getLogger(__name__)

# Stores asyncio.Events keyed by Steel session_id.
# browser_agent yields "review_required" then blocks on the event.
# POST /api/apply/confirm/{session_id} sets it, unblocking the agent.
_pending_reviews: dict[str, asyncio.Event] = {}

# Live-flow OTP gates keyed by Steel session_id (re-keyed from a temp stream
# key once the steel_session event arrives — same pattern as _pending_reviews).
# POST /api/apply/otp/{session_id} pushes the user's code onto the queue.
_pending_otp_live: dict[str, asyncio.Queue] = {}

router = APIRouter(prefix="/api/apply", tags=["apply"])

_optional_bearer = HTTPBearer(auto_error=False)


def _normalize_otp(code: str) -> str:
    """Strip whitespace/dashes; codes are short alphanumerics."""
    return _otp_re.sub(r"[\s-]", "", (code or "")).strip()


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

    # Resolve legal name — prefer explicit first/last from profile,
    # fall back to splitting the Google display_name if not set.
    _first = (prefs.get("first_name") or "").strip()
    _last  = (prefs.get("last_name")  or "").strip()
    _middle = (prefs.get("middle_name") or "").strip()
    if not _first and not _last:
        _google_name = current_user.display_name or ""
        _parts = _google_name.split(" ", 1)
        _first = _parts[0] if _parts else ""
        _last  = _parts[1] if len(_parts) > 1 else ""
    # full name for ATS forms that ask for a single name field
    _full_name = " ".join(p for p in [_first, _middle, _last] if p)

    profile = {
        "name":                _full_name or (current_user.display_name or ""),
        "first_name":          _first,
        "last_name":           _last,
        "middle_name":         _middle,
        "email":               current_user.email    or "",
        "phone":               prefs.get("phone")    or "",
        "location":            prefs.get("current_location") or prefs.get("location") or "",
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
        "ethnicity_eeo":       prefs.get("ethnicity_eeo")       or "decline",
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
        _otp_queue    = asyncio.Queue()
        _stream_key   = str(_uuid.uuid4())   # temp key until steel session_id arrives
        _pending_reviews[_stream_key]  = _review_event
        _pending_otp_live[_stream_key] = _otp_queue

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
                otp_queue    = _otp_queue,
            ):
                # When the Steel session ID arrives, re-key the pending review
                # so POST /api/apply/confirm/{session_id} can look it up.
                # Same re-key for the OTP gate (POST /api/apply/otp/{session_id}).
                if event.get("type") == "steel_session" and event.get("session_id"):
                    sid = event["session_id"]
                    _pending_reviews[sid] = _review_event
                    _pending_reviews.pop(_stream_key, None)
                    _pending_otp_live[sid] = _otp_queue
                    _pending_otp_live.pop(_stream_key, None)
                    logger.info(f"[apply] Review gate registered for session_id={sid}")

                # screenshot_png is raw bytes for in-process consumers — never
                # serialize it into the SSE stream.
                if "screenshot_png" in event:
                    event = {k: v for k, v in event.items() if k != "screenshot_png"}

                yield _sse(event)

                # Job posting no longer exists — delete from auto_match_results
                # AND insert into archived_job_ids so the scoring pipeline never
                # re-inserts this job for this user.
                if event.get("type") == "job_removed" and event.get("job_id"):
                    try:
                        from db.database import AsyncSessionLocal
                        from models.orm import ArchivedJobId
                        from sqlalchemy.dialects.postgresql import insert as pg_insert
                        _removed_job_id = event["job_id"]
                        async with AsyncSessionLocal() as rm_db:
                            # 1. Remove from matched results
                            await rm_db.execute(
                                sa_delete(AutoMatchResult).where(
                                    AutoMatchResult.user_id == current_user.id,
                                    AutoMatchResult.job_id  == _removed_job_id,
                                )
                            )
                            # 2. Permanently archive so run_matching.py never re-scores it
                            await rm_db.execute(
                                pg_insert(ArchivedJobId).values(
                                    user_id     = current_user.id,
                                    job_id      = _removed_job_id,
                                    archived_at = datetime.now(timezone.utc),
                                ).on_conflict_do_nothing(
                                    index_elements=["user_id", "job_id"]
                                )
                            )
                            await rm_db.commit()
                        logger.info(
                            f"[apply] Removed job {_removed_job_id} from auto_match_results "
                            f"and archived for user {current_user.email} (job no longer available)"
                        )
                    except Exception as db_err:
                        logger.warning(f"[apply] DB cleanup after job_removed failed: {db_err}")

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
            # Always clean up pending review + OTP entries when the stream ends
            _pending_reviews.pop(_stream_key, None)
            _pending_otp_live.pop(_stream_key, None)
            if "_review_event" in dir():
                # Find and remove any key pointing to this event
                stale = [k for k, v in list(_pending_reviews.items()) if v is _review_event]
                for k in stale:
                    _pending_reviews.pop(k, None)
            if "_otp_queue" in dir():
                stale_q = [k for k, v in list(_pending_otp_live.items()) if v is _otp_queue]
                for k in stale_q:
                    _pending_otp_live.pop(k, None)

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


# ── OTP (security code) endpoints ──────────────────────────────────────────────

class OtpRequest(BaseModel):
    code: str


@router.post("/otp/{session_id}")
async def submit_otp_live(
    session_id:  str,
    body:        OtpRequest,
    credentials: Optional[HTTPAuthorizationCredentials] = Security(_optional_bearer),
    db:          AsyncSession = Depends(get_db),
):
    """
    Live SSE flow: deliver the emailed security code to the agent paused at
    the OTP gate. session_id is the Steel session_id (same key as /confirm).
    """
    if not credentials or not credentials.credentials:
        raise HTTPException(status_code=401, detail="Authentication required.")
    try:
        await get_current_user(credentials=credentials, db=db)
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid token.")

    code = _normalize_otp(body.code)
    if not (4 <= len(code) <= 12) or not code.isalnum():
        raise HTTPException(status_code=400, detail="That doesn't look like a valid code — check the email and try again.")

    queue = _pending_otp_live.get(session_id)
    if queue is None:
        raise HTTPException(
            status_code=404,
            detail="No application is waiting for a code in this session — it may have timed out.",
        )

    queue.put_nowait(code)
    logger.info(f"[apply/otp] Security code delivered — session_id={session_id}")
    return {"ok": True, "message": "Code received — submitting your application now."}


# ═══════════════════════════════════════════════════════════════════════════════
# BATCH AUTO-APPLY — Phase 1 (Fill & Capture) + Phase 2 (Replay & Submit)
#
# POST /api/apply/batch              — create a batch from matched jobs, start Phase 1
# GET  /api/apply/review             — jobs awaiting review (drafts + signed screenshots)
# GET  /api/apply/batch/{batch_id}   — batch progress summary
# POST /api/apply/jobs/{id}/decision — approve (with optional edits) / skip / retry
# POST /api/apply/jobs/{id}/otp      — deliver the emailed security code (awaiting_otp)
# ═══════════════════════════════════════════════════════════════════════════════

from typing import List


async def _require_user(credentials, db):
    if not credentials or not credentials.credentials:
        raise HTTPException(status_code=401, detail="Authentication required.")
    try:
        return await get_current_user(credentials=credentials, db=db)
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid token.")


class BatchCreateRequest(BaseModel):
    job_ids:   Optional[List[str]] = None   # auto_match_results.job_id values; None = recent matches
    resume_id: Optional[str]       = None
    limit:     int                 = 7      # cap when auto-selecting


def _job_url_from_data(jd: dict) -> str:
    """job_data JSONB key names vary by source — probe the known ones."""
    return (
        jd.get("absolute_url") or jd.get("url") or jd.get("job_url")
        or jd.get("apply_url") or jd.get("applyUrl") or ""
    )


@router.post("/batch")
async def create_apply_batch(
    body:        BatchCreateRequest,
    credentials: Optional[HTTPAuthorizationCredentials] = Security(_optional_bearer),
    db:          AsyncSession = Depends(get_db),
):
    """
    Create an apply batch and start Phase 1 (autonomous headless fill & capture).
    Nothing is ever submitted in Phase 1 — every job stops at awaiting_review.
    """
    current_user = await _require_user(credentials, db)

    from models.orm import AutoMatchResult
    from models.orm import ApplyBatch, ApplyJob

    limit = max(1, min(body.limit or 7, 10))
    ACTIVE_STATUSES = ["queued", "filling", "awaiting_review", "approved", "replaying", "awaiting_otp"]

    # Resolve target jobs
    q = select(AutoMatchResult).where(
        AutoMatchResult.user_id == current_user.id,
        AutoMatchResult.applied.isnot(True),
    )
    if body.job_ids:
        q = q.where(AutoMatchResult.job_id.in_(body.job_ids))
    else:
        q = q.order_by(AutoMatchResult.matched_at.desc()).limit(limit)

    rows = list((await db.execute(q)).scalars())
    if not rows:
        # No un-applied match rows for this selection. Distinguish "already
        # applied" (idempotent — a harmless re-click on a finished job) from
        # "genuinely not a match for this user" (a real 404).
        if body.job_ids:
            already = list((await db.execute(
                select(AutoMatchResult.job_id).where(
                    AutoMatchResult.user_id == current_user.id,
                    AutoMatchResult.job_id.in_(body.job_ids),
                    AutoMatchResult.applied.is_(True),
                )
            )).scalars())
            if already:
                return {
                    "ok": True,
                    "already_applied": True,
                    "applied_job_ids": [j for j in already if j],
                    "job_count": 0,
                    "message": "You've already applied to this job.",
                }
        raise HTTPException(status_code=404, detail="No matched, un-applied jobs found to apply to.")

    # Exclude jobs already in an active batch pipeline
    active = list((await db.execute(
        select(ApplyJob.job_id).where(
            ApplyJob.user_id == current_user.id,
            ApplyJob.status.in_(ACTIVE_STATUSES),
        )
    )).scalars())
    active_set = {a for a in active if a}
    rows = [r for r in rows if r.job_id not in active_set]
    # Hard cap regardless of selection path. Auto-select is already bounded by
    # `limit`, but explicit job_ids could otherwise create an unbounded batch
    # ("apply to all of them" on a 20-row table → 20 sequential headless fills).
    rows = rows[:10]
    if not rows:
        # Every requested job is already queued in an active batch. Idempotent:
        # hand back the existing batch so a re-click just re-opens it, rather
        # than erroring with a 409 that the UI can't act on.
        existing_q = select(ApplyJob).where(
            ApplyJob.user_id == current_user.id,
            ApplyJob.status.in_(ACTIVE_STATUSES),
        )
        if body.job_ids:
            existing_q = existing_q.where(ApplyJob.job_id.in_(body.job_ids))
        existing = (await db.execute(
            existing_q.order_by(ApplyJob.created_at.desc())
        )).scalars().first()
        if existing:
            return {
                "ok": True,
                "already_active": True,
                "batch_id": str(existing.batch_id),
                "apply_job_id": str(existing.id),
                "job_count": 0,
                "message": "This application is already in progress.",
            }
        raise HTTPException(status_code=409, detail="All selected jobs are already in an active apply batch.")

    batch = ApplyBatch(
        user_id   = current_user.id,
        status    = "pending",
        job_count = len(rows),
        resume_id = _uuid.UUID(body.resume_id) if body.resume_id else None,
    )
    db.add(batch)
    await db.flush()

    skipped_no_url = 0
    created = []
    for r in rows:
        jd  = r.job_data or {}
        url = _job_url_from_data(jd)
        if not url:
            skipped_no_url += 1
            continue
        aj = ApplyJob(
            batch_id  = batch.id,
            user_id   = current_user.id,
            job_id    = r.job_id,
            job_url   = url,
            job_title = jd.get("title") or jd.get("job_title") or "",
            company   = jd.get("company") or jd.get("company_name") or "",
            status    = "queued",
        )
        db.add(aj)
        created.append(aj)

    if not created:
        raise HTTPException(status_code=422, detail="Selected jobs have no application URL in job_data.")
    batch.job_count = len(created)
    await db.commit()

    # Kick resume optimization in the background — survives this request ending.
    # Phase 1 fill no longer fires here; it now fires per-job from
    # POST /jobs/{id}/resume/approve once that job's optimized resume is approved.
    from services.resume_optimize_worker import optimize_batch_resumes
    asyncio.create_task(optimize_batch_resumes(batch.id))

    logger.info(f"[apply/batch] user={current_user.email} batch={batch.id} jobs={len(created)}")
    return {
        "ok":         True,
        "batch_id":   str(batch.id),
        "job_count":  len(created),
        "skipped_no_url": skipped_no_url,
        "message":    f"Rack is tailoring your resume for {len(created)} application(s). "
                      f"Review and approve each one to start applying.",
    }


@router.get("/batch/{batch_id}")
async def get_batch_status(
    batch_id:    str,
    credentials: Optional[HTTPAuthorizationCredentials] = Security(_optional_bearer),
    db:          AsyncSession = Depends(get_db),
):
    current_user = await _require_user(credentials, db)
    from models.orm import ApplyBatch, ApplyJob

    bres = await db.execute(select(ApplyBatch).where(
        ApplyBatch.id == _uuid.UUID(batch_id), ApplyBatch.user_id == current_user.id))
    batch = bres.scalar_one_or_none()
    if not batch:
        raise HTTPException(status_code=404, detail="Batch not found.")

    jrows = list((await db.execute(
        select(ApplyJob).where(ApplyJob.batch_id == batch.id).order_by(ApplyJob.created_at.asc())
    )).scalars())

    return {
        "batch_id":  str(batch.id),
        "status":    batch.status,
        "job_count": batch.job_count,
        "jobs": [
            {
                "id":                str(j.id),
                "job_id":            j.job_id,
                "job_title":         j.job_title,
                "company":           j.company,
                "status":            j.status,
                "filled_count":      j.filled_count,
                "validation_errors": j.validation_errors,
                "error":             j.error,
            } for j in jrows
        ],
    }


@router.get("/review")
async def list_review_queue(
    credentials: Optional[HTTPAuthorizationCredentials] = Security(_optional_bearer),
    db:          AsyncSession = Depends(get_db),
):
    """
    Everything the user needs to review: awaiting_review jobs with their draft
    (readable Q&A) and signed screenshot URLs, plus needs_attention items and
    jobs paused at the security-code gate (awaiting_otp).
    """
    current_user = await _require_user(credentials, db)
    from models.orm import ApplyJob, ResumeOptimization, Resume
    from services.apply_worker import signed_screenshot_url

    jrows = list((await db.execute(
        select(ApplyJob).where(
            ApplyJob.user_id == current_user.id,
            # "queued"/"filling" MUST be included — every application starts
            # in "queued" and stays there through resume optimization until
            # POST /jobs/{id}/resume/approve kicks Phase 1 fill. Excluding
            # them meant a page reload (or SSE disconnect) before that point
            # made the application invisible to the user even though it was
            # still live in the DB — the row simply never came back from this
            # endpoint, so "All applications" looked empty and re-clicking
            # Apply just handed back the same stuck batch.
            ApplyJob.status.in_([
                "queued", "filling",
                "awaiting_review", "needs_attention", "approved", "replaying", "awaiting_otp",
            ]),
        ).order_by(ApplyJob.created_at.asc())
    )).scalars())

    # Which resume was actually matched/optimized for each job — previously
    # never surfaced, so every row in "All applications" showed the generic
    # "Optimized" label instead of which resume that meant. Prefer the
    # rendered optimized_resume_id (set once approved); fall back to the
    # source resume used to generate the patches (set as soon as resume_status
    # reaches "ready", before approval).
    job_ids = [j.id for j in jrows]
    resume_name_by_job: dict = {}
    if job_ids:
        opt_rows = list((await db.execute(
            select(ResumeOptimization.apply_job_id,
                   ResumeOptimization.source_resume_id,
                   ResumeOptimization.optimized_resume_id)
            .where(ResumeOptimization.apply_job_id.in_(job_ids))
        )).all())
        wanted_resume_ids = {(o.optimized_resume_id or o.source_resume_id) for o in opt_rows}
        wanted_resume_ids.discard(None)
        name_by_resume_id = {}
        if wanted_resume_ids:
            res_rows = list((await db.execute(
                select(Resume.id, Resume.display_name).where(Resume.id.in_(wanted_resume_ids))
            )).all())
            name_by_resume_id = {r.id: r.display_name for r in res_rows}
        for o in opt_rows:
            rid = o.optimized_resume_id or o.source_resume_id
            resume_name_by_job[o.apply_job_id] = name_by_resume_id.get(rid)

    out = []
    for j in jrows:
        shots = []
        for p in (j.screenshot_paths or []):
            u = await signed_screenshot_url(p)
            if u:
                shots.append(u)
        confirm_url = None
        if j.confirmation_screenshot:
            confirm_url = await signed_screenshot_url(j.confirmation_screenshot)
        presubmit_url = None
        if j.presubmit_screenshot:
            presubmit_url = await signed_screenshot_url(j.presubmit_screenshot)
        out.append({
            "id":                 str(j.id),
            "batch_id":           str(j.batch_id),
            "job_id":             j.job_id,
            "job_title":          j.job_title,
            "company":            j.company,
            "job_url":            j.job_url,
            "status":             j.status,
            # Already a live column on ApplyJob (see resume/approve + the SSE
            # stream below) — just wasn't being surfaced here, so a reload
            # lost the "Optimizing…" / "Optimized" state the live SSE stream
            # showed. AllApplicationsStrip already reads app.resume_status,
            # no frontend change needed.
            "resume_status":      j.resume_status,
            "resume_name":        resume_name_by_job.get(j.id),
            "filled_count":       j.filled_count,
            # AppRow computes its timestamp as `app.updated_at || app.created_at`
            # — this endpoint never sent either, so every row rendered "just now"
            # regardless of true age. Needed now more than ever since queued/
            # filling rows (added above) can be genuinely old.
            "created_at":         j.created_at.isoformat() if j.created_at else None,
            "updated_at":         j.updated_at.isoformat() if getattr(j, "updated_at", None) else None,
            "validation_errors":  j.validation_errors,
            # Draft shown as readable Q&A — only what was actually filled
            "answers": [
                {"label": f.get("field_label", ""), "value": f.get("value", "")}
                for f in (j.draft or [])
                if not f.get("skip") and f.get("value") and not f.get("needs_user")
            ],
            # Required fields the agent could NOT answer. The user must complete
            # these before approving. `options` carries the live dropdown choices
            # when we managed to scrape them, so the UI can render a select rather
            # than a blind text box. This is the "give the user a chance" net for
            # any field that slipped detection/resolution (e.g. a numeric-id EEO
            # combobox whose options couldn't be scraped).
            "needs_user": [
                {
                    "label":         f.get("field_label", ""),
                    "field_label":   f.get("field_label", ""),
                    "selector_hint": f.get("selector_hint", ""),
                    "value":         f.get("value", ""),
                    "options":       f.get("options") or [],
                    "required":      bool(f.get("required", False)),
                }
                for f in (j.draft or [])
                if f.get("needs_user") and not (f.get("value") or "").strip()
            ],
            "screenshots":             shots,
            "confirmation_screenshot": confirm_url,
            # Security-code gate
            "otp_expected":            bool(getattr(j, "otp_expected", False)),
            "otp_email_hint":          j.otp_email_hint,
            "otp_requested_at":        j.otp_requested_at.isoformat() if j.otp_requested_at else None,
            "presubmit_screenshot":    presubmit_url,
            "error":                   j.error,
        })
    return {"jobs": out}


class DecisionRequest(BaseModel):
    action: str                            # "approve" | "skip" | "retry"
    edits:  Optional[List[dict]] = None    # [{field_label, new_value}]


@router.post("/jobs/{apply_job_id}/decision")
async def decide_apply_job(
    apply_job_id: str,
    body:         DecisionRequest,
    credentials:  Optional[HTTPAuthorizationCredentials] = Security(_optional_bearer),
    db:           AsyncSession = Depends(get_db),
):
    """
    approve — replay the (optionally edited) draft and submit. Phase 2 starts now.
    skip    — decline this application; nothing is submitted.
    retry   — re-queue a failed/recovered job for another Phase 1 pass.
    """
    current_user = await _require_user(credentials, db)
    from models.orm import ApplyJob
    from datetime import datetime, timezone

    jres = await db.execute(select(ApplyJob).where(
        ApplyJob.id == _uuid.UUID(apply_job_id), ApplyJob.user_id == current_user.id))
    job = jres.scalar_one_or_none()
    if not job:
        raise HTTPException(status_code=404, detail="Apply job not found.")

    if body.action == "approve":
        if job.status != "awaiting_review":
            raise HTTPException(status_code=409, detail=f"Job is not awaiting review (status={job.status}).")

        # Required fields the agent couldn't answer must be supplied by the user
        # before we submit. Apply the incoming edits, then verify nothing REQUIRED
        # is still blank — never submit a half-filled application silently. Optional
        # dropped fields (no '*') are offered in the UI but never block submit.
        _edit_vals = {
            (e.get("field_label") or "").strip().lower(): (e.get("new_value") or "").strip()
            for e in (body.edits or [])
        }
        _unanswered = [
            f.get("field_label", "")
            for f in (job.draft or [])
            if f.get("needs_user")
            and f.get("required")
            and not (f.get("value") or "").strip()
            and not _edit_vals.get((f.get("field_label") or "").strip().lower())
        ]
        if _unanswered:
            raise HTTPException(
                status_code=422,
                detail="Please answer the required field(s) before submitting: " + ", ".join(_unanswered),
            )

        job.status     = "approved"
        job.user_edits = body.edits or None
        job.updated_at = datetime.now(timezone.utc)
        await db.commit()

        from services.apply_worker import process_approval
        asyncio.create_task(process_approval(job.id))
        return {"ok": True, "message": f"Submitting your application to {job.company} now."}

    elif body.action == "skip":
        if job.status not in ("awaiting_review", "failed", "needs_attention"):
            raise HTTPException(status_code=409, detail=f"Job cannot be skipped (status={job.status}).")
        job.status     = "skipped"
        job.updated_at = datetime.now(timezone.utc)
        await db.commit()
        return {"ok": True, "message": "Application skipped — nothing was submitted."}

    elif body.action == "retry":
        if job.status not in ("failed", "queued"):
            raise HTTPException(status_code=409, detail=f"Job cannot be retried (status={job.status}).")
        job.status     = "queued"
        job.updated_at = datetime.now(timezone.utc)
        await db.commit()
        from services.apply_worker import process_batch
        asyncio.create_task(process_batch(job.batch_id))
        return {"ok": True, "message": "Retrying this application."}

    raise HTTPException(status_code=400, detail="action must be approve, skip, or retry.")


@router.post("/jobs/{apply_job_id}/otp")
async def submit_otp_batch(
    apply_job_id: str,
    body:         OtpRequest,
    credentials:  Optional[HTTPAuthorizationCredentials] = Security(_optional_bearer),
    db:           AsyncSession = Depends(get_db),
):
    """
    Batch Phase 2: deliver the emailed security code to the agent holding this
    application open at the OTP gate (status=awaiting_otp).
    """
    current_user = await _require_user(credentials, db)
    from models.orm import ApplyJob
    from datetime import datetime, timezone

    jres = await db.execute(select(ApplyJob).where(
        ApplyJob.id == _uuid.UUID(apply_job_id), ApplyJob.user_id == current_user.id))
    job = jres.scalar_one_or_none()
    if not job:
        raise HTTPException(status_code=404, detail="Apply job not found.")

    if job.status != "awaiting_otp":
        raise HTTPException(status_code=409, detail=f"This application is not waiting for a code (status={job.status}).")

    code = _normalize_otp(body.code)
    if not (4 <= len(code) <= 12) or not code.isalnum():
        raise HTTPException(status_code=400, detail="That doesn't look like a valid code — check the email and try again.")

    from services.apply_worker import submit_otp_code
    if not submit_otp_code(str(job.id), code):
        # The browser session is gone (server restarted / agent timed out).
        # recover_orphans or the timeout path already reset the status — but if
        # we're here the row still says awaiting_otp, so fix it now.
        job.status     = "awaiting_review"
        job.error      = "The browser session expired before the code arrived — approve again to retry."
        job.updated_at = datetime.now(timezone.utc)
        await db.commit()
        raise HTTPException(
            status_code=409,
            detail="That session expired — the application is back in your review queue. Approve it again to retry.",
        )

    # Agent resumes immediately — reflect that in the row so the UI flips to
    # "Submitting…" on the next poll.
    job.status     = "replaying"
    job.error      = None
    job.updated_at = datetime.now(timezone.utc)
    await db.commit()

    logger.info(f"[apply/otp] Security code delivered for apply_job={job.id} ({job.company})")
    return {"ok": True, "message": f"Code received — submitting your application to {job.company} now."}


# ── Resume optimization ─────────────────────────────────────────────────────────
# Runs after create_apply_batch(), before Phase 1 fill. See
# services/resume_optimize_worker.py for the background pipeline.

@router.get("/batch/{batch_id}/resume-stream")
async def resume_status_stream(
    batch_id:    str,
    credentials: Optional[HTTPAuthorizationCredentials] = Security(_optional_bearer),
    db:          AsyncSession = Depends(get_db),
):
    """
    SSE stream of resume_status changes for every job in this batch, so the
    Dashboard "All applications" table can flip Optimizing… -> Optimized
    live instead of polling. Same text/event-stream shape as POST /stream.
    """
    current_user = await _require_user(credentials, db)
    from models.orm import ApplyBatch
    from services import resume_optimize_worker

    bres = await db.execute(select(ApplyBatch).where(
        ApplyBatch.id == _uuid.UUID(batch_id), ApplyBatch.user_id == current_user.id))
    if not bres.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="Batch not found.")

    async def event_stream():
        from models.orm import ApplyJob

        # Send current state immediately on connect, so a client that
        # connects late (e.g. page refresh mid-optimization) isn't stuck
        # showing stale "Optimizing…" for jobs that already finished.
        async with AsyncSessionLocal() as sdb:
            current_jobs = list((await sdb.execute(
                select(ApplyJob).where(ApplyJob.batch_id == _uuid.UUID(batch_id))
            )).scalars())
        for j in current_jobs:
            yield _sse({"apply_job_id": str(j.id), "resume_status": j.resume_status})

        q = resume_optimize_worker.subscribe(batch_id)
        try:
            while True:
                try:
                    event = await asyncio.wait_for(q.get(), timeout=25)
                    yield _sse(event)
                except asyncio.TimeoutError:
                    yield _sse({"type": "ping"})
        finally:
            resume_optimize_worker.unsubscribe(batch_id, q)

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@router.get("/jobs/{apply_job_id}/resume")
async def get_resume_optimization(
    apply_job_id: str,
    credentials:  Optional[HTTPAuthorizationCredentials] = Security(_optional_bearer),
    db:           AsyncSession = Depends(get_db),
):
    """Everything ResumeEditor.jsx needs: structured doc, patches, classification, score."""
    current_user = await _require_user(credentials, db)
    from models.orm import ApplyJob, ResumeOptimization

    jres = await db.execute(select(ApplyJob).where(
        ApplyJob.id == _uuid.UUID(apply_job_id), ApplyJob.user_id == current_user.id))
    job = jres.scalar_one_or_none()
    if not job:
        raise HTTPException(status_code=404, detail="Application not found.")

    ores = await db.execute(select(ResumeOptimization).where(ResumeOptimization.apply_job_id == job.id))
    opt = ores.scalar_one_or_none()
    if not opt:
        raise HTTPException(status_code=404, detail="Resume optimization hasn't started for this application yet.")

    # score_from_classification is only reached here as a fallback — for
    # legacy rows that have a real requirement_classification but somehow
    # never got match_score stored (predates match_score being stored at
    # all). The common case reads opt.match_score straight off the row,
    # computed once by resume_optimizer.py at optimization time — not
    # recomputed here anymore. Was previously a second, inline copy of this
    # exact formula (plus a dead `required = [...]` line that filtered on an
    # importance field requirement_classification never actually had); both
    # retired in favor of importing the one real implementation.
    #
    # Guarded on a non-empty classification list — resume_optimize_worker.py's
    # segment-rewrite pipeline (optimize_mode "honest"/"aggressive" as of
    # this change) never computes a classification at all and stores
    # requirement_classification=[] deliberately, not as a gap to patch over.
    # score_from_classification([]) would happily compute 0 met / 1 total =
    # "0%, Poor Match" from that empty list — a fabricated-looking score
    # that reads as "we checked and it's a bad match" when the truth is
    # "nothing was scored." None is the honest value for "no score exists
    # yet"; the frontend should treat None as "hide the score chip", not
    # coerce it into a percentage.
    from services.resume_optimizer import score_from_classification

    match_score = opt.match_score
    if match_score is None and opt.requirement_classification:
        match_score = score_from_classification(opt.requirement_classification)

    return {
        "apply_job_id":              str(job.id),
        "resume_status":             job.resume_status,
        "structured_doc":            opt.structured_doc,
        "patches":                   opt.patches,
        "requirement_classification": opt.requirement_classification,
        "decisions":                 opt.decisions,
        "manual_edits":              opt.manual_edits,
        "match_score":               match_score,
        "status": opt.status,
    }


class PatchDecisionRequest(BaseModel):
    patch_id: str
    decision: str   # "accepted" | "rejected"


@router.post("/jobs/{apply_job_id}/resume/decision")
async def decide_resume_patch(
    apply_job_id: str,
    body:         PatchDecisionRequest,
    credentials:  Optional[HTTPAuthorizationCredentials] = Security(_optional_bearer),
    db:           AsyncSession = Depends(get_db),
):
    """Persist a single accept/reject decision — called as the user clicks in the sidebar list."""
    current_user = await _require_user(credentials, db)
    from models.orm import ApplyJob, ResumeOptimization

    if body.decision not in ("accepted", "rejected"):
        raise HTTPException(status_code=400, detail="decision must be 'accepted' or 'rejected'.")

    jres = await db.execute(select(ApplyJob).where(
        ApplyJob.id == _uuid.UUID(apply_job_id), ApplyJob.user_id == current_user.id))
    job = jres.scalar_one_or_none()
    if not job:
        raise HTTPException(status_code=404, detail="Application not found.")

    ores = await db.execute(select(ResumeOptimization).where(ResumeOptimization.apply_job_id == job.id))
    opt = ores.scalar_one_or_none()
    if not opt:
        raise HTTPException(status_code=404, detail="Resume optimization not found.")
    if opt.status == "approved":
        raise HTTPException(status_code=409, detail="This resume is already approved — can't change decisions now.")

    decisions = dict(opt.decisions or {})
    decisions[body.patch_id] = body.decision
    opt.decisions = decisions
    await db.commit()
    return {"ok": True, "decisions": opt.decisions}


class ResumeApproveRequest(BaseModel):
    decisions:    Optional[dict] = None   # {patch_id: "accepted"|"rejected"} — full overwrite if provided
    manual_edits: Optional[dict] = None   # {field_id: final_text} — full overwrite if provided


@router.post("/jobs/{apply_job_id}/resume/approve")
async def approve_resume_optimization(
    apply_job_id: str,
    body:         ResumeApproveRequest,
    credentials:  Optional[HTTPAuthorizationCredentials] = Security(_optional_bearer),
    db:           AsyncSession = Depends(get_db),
):
    """
    Bakes decisions + manual edits into the final document, renders a PDF,
    uploads it as a NEW resumes row (is_optimized=True) so browser_agent.py's
    existing storage_path lookup needs zero changes, then kicks Phase 1 fill
    for THIS job only via apply_worker.process_single_job().
    """
    current_user = await _require_user(credentials, db)
    from models.orm import ApplyJob, ResumeOptimization, Resume
    from services.resume_renderer import render_resume_pdf
    from datetime import datetime, timezone
    import uuid as _uuid2

    jres = await db.execute(select(ApplyJob).where(
        ApplyJob.id == _uuid.UUID(apply_job_id), ApplyJob.user_id == current_user.id))
    job = jres.scalar_one_or_none()
    if not job:
        raise HTTPException(status_code=404, detail="Application not found.")

    ores = await db.execute(select(ResumeOptimization).where(ResumeOptimization.apply_job_id == job.id))
    opt = ores.scalar_one_or_none()
    if not opt:
        raise HTTPException(status_code=404, detail="Resume optimization not found.")
    if opt.status != "ready":
        raise HTTPException(status_code=409, detail=f"Resume isn't ready to approve yet (status={opt.status}).")

    if body.decisions is not None:
        opt.decisions = body.decisions
    if body.manual_edits is not None:
        opt.manual_edits = body.manual_edits

    try:
        pdf_bytes = render_resume_pdf(opt.structured_doc, opt.patches, opt.decisions, opt.manual_edits)
    except Exception as e:
        logger.error(f"[apply/resume/approve] PDF render failed for job {job.id}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Couldn't generate the final resume file. Try again.")

    source_res = await db.execute(select(Resume).where(Resume.id == opt.source_resume_id))
    source_resume = source_res.scalar_one_or_none()
    filename = f"{(source_resume.filename.rsplit('.',1)[0] if source_resume else 'resume')}_optimized.pdf"

    new_resume_id = _uuid2.uuid4()
    storage_path = f"{current_user.id}/optimized/{job.id}.pdf"
    try:
        from routers.resumes import _get_supabase, STORAGE_BUCKET
        supabase = _get_supabase()
        supabase.storage.from_(STORAGE_BUCKET).upload(
            path=storage_path, file=pdf_bytes,
            file_options={"content-type": "application/pdf", "upsert": "true"},
        )
    except Exception as e:
        logger.error(f"[apply/resume/approve] Storage upload failed for job {job.id}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Couldn't save the final resume file. Try again.")

    optimized_resume = Resume(
        id=new_resume_id, user_id=current_user.id, filename=filename, display_name=filename,
        storage_path=storage_path, file_ext="pdf",
        years_exp=source_resume.years_exp if source_resume else None,
        titles=source_resume.titles if source_resume else None,
        domains=source_resume.domains if source_resume else None,
        skills=source_resume.skills if source_resume else None,
        status="active", is_optimized=True, source_resume_id=opt.source_resume_id,
    )
    db.add(optimized_resume)

    opt.optimized_resume_id = new_resume_id
    opt.status = "approved"
    opt.approved_at = datetime.now(timezone.utc)
    job.resume_status = "approved"
    await db.commit()

    # Phase 1 fill for THIS job only, using the newly-approved optimized resume.
    from services.apply_worker import process_single_job
    asyncio.create_task(process_single_job(str(job.id), str(new_resume_id)))

    logger.info(f"[apply/resume/approve] job={job.id} approved — optimized_resume={new_resume_id}")
    return {
        "ok": True,
        "optimized_resume_id": str(new_resume_id),
        "message": "Resume approved. Rack is filling out the application now.",
    }