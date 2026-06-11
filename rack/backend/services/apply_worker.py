"""
services/apply_worker.py — Batch auto-apply orchestrator

Phase 1 (Fill & Capture) — autonomous, headless, no Steel:
  For each queued ApplyJob: run the existing browser agent in headless mode
  with stop_before_submit=True. Persist the draft + full-page screenshot,
  set status=awaiting_review, close the browser. When the whole batch is
  captured, send ONE Resend email asking the user to review.

Phase 2 (Replay & Submit) — on user approval:
  New headless session, replay the saved draft verbatim (precomputed_fields),
  auto-submit (review_event=None), capture the confirmation screenshot,
  mark auto_match_results.applied=True.

Concurrency: a single module-level asyncio.Lock serializes ALL browser work.
Exactly one Chromium at a time — required on Render free tier (512MB) and
polite to the ATSes.

Crash safety: every state transition is a DB write. recover_orphans() runs
at startup and resets rows stuck in transient states (filling → queued,
replaying → approved) so a Render restart resumes cleanly.

NOTE: requires the `apply-screenshots` PRIVATE bucket in Supabase Storage.
"""

import asyncio
import logging
import os
import uuid as _uuid
from datetime import datetime, timezone

import httpx
from sqlalchemy import select, update as sa_update

from db.database import AsyncSessionLocal
from models.orm import ApplyBatch, ApplyJob

logger = logging.getLogger(__name__)

# One browser at a time — Phase 1 and Phase 2 both acquire this.
_browser_lock = asyncio.Lock()

_SCREENSHOT_BUCKET = "apply-screenshots"
_MAX_ATTEMPTS      = 2      # per job, per phase
_APP_BASE_URL      = os.environ.get("APP_BASE_URL", "https://rackx.app")


def _utcnow():
    return datetime.now(timezone.utc)


# ── Supabase Storage helpers (sync SDK — run in thread) ───────────────────────

def _sb_client():
    from supabase import create_client
    return create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_KEY"])


def _upload_png_sync(path: str, png_bytes: bytes) -> str | None:
    try:
        sb = _sb_client()
        sb.storage.from_(_SCREENSHOT_BUCKET).upload(
            path, png_bytes, {"content-type": "image/png", "upsert": "true"}
        )
        return path
    except Exception as e:
        logger.warning(f"[apply_worker] screenshot upload failed for {path!r}: {e}")
        return None


async def _upload_png(path: str, png_bytes: bytes) -> str | None:
    """Upload PNG bytes to the apply-screenshots bucket without blocking the loop."""
    if not png_bytes:
        return None
    return await asyncio.to_thread(_upload_png_sync, path, png_bytes)


def _signed_url_sync(path: str, expires: int = 3600) -> str | None:
    try:
        sb = _sb_client()
        resp = sb.storage.from_(_SCREENSHOT_BUCKET).create_signed_url(path, expires)
        return (
            getattr(resp, "signed_url", None)
            or getattr(resp, "signedURL", None)
            or (isinstance(resp, dict) and (
                resp.get("signedURL") or resp.get("signedUrl") or resp.get("signed_url")
            ))
            or None
        )
    except Exception as e:
        logger.warning(f"[apply_worker] signed url failed for {path!r}: {e}")
        return None


async def signed_screenshot_url(path: str, expires: int = 3600) -> str | None:
    return await asyncio.to_thread(_signed_url_sync, path, expires)


# ── Resend email ───────────────────────────────────────────────────────────────

async def _send_review_email(to_email: str, display_name: str, ready: int, failed: int):
    """One email per batch when Phase 1 completes. Honest urgency, no fake deadlines."""
    api_key = os.environ.get("RESEND_API_KEY")
    if not api_key or not to_email:
        return
    name = (display_name or "there").split(" ")[0]
    failed_line = (
        f"<p style='color:#888'>{failed} application(s) couldn't be filled automatically "
        f"and may need a manual pass.</p>" if failed else ""
    )
    html = f"""
    <div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:520px">
      <h2 style="margin-bottom:4px">Rack filled {ready} application{'s' if ready != 1 else ''} for you</h2>
      <p>Hey {name}, your applications are filled and waiting for your approval.
      Nothing is submitted until you review it.</p>
      <p>Jobs can close without warning, so reviewing today is safer than tomorrow.</p>
      <p><a href="{_APP_BASE_URL}"
            style="display:inline-block;background:#e8ff6b;color:#111;padding:10px 18px;
                   border-radius:8px;text-decoration:none;font-weight:600">
        Review &amp; approve →</a></p>
      {failed_line}
      <p style="color:#888;font-size:12px">— Rack · rackx.app</p>
    </div>"""
    try:
        async with httpx.AsyncClient() as client:
            await client.post(
                "https://api.resend.com/emails",
                headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                json={
                    "from":    "Rack <tejas@rackx.app>",
                    "to":      [to_email],
                    "subject": f"{ready} application{'s' if ready != 1 else ''} ready for your review",
                    "html":    html,
                },
                timeout=15.0,
            )
        logger.info(f"[apply_worker] review email sent to {to_email}")
    except Exception as e:
        logger.warning(f"[apply_worker] review email failed: {e}")


async def _send_submitted_email(to_email: str, display_name: str, job_title: str, company: str):
    api_key = os.environ.get("RESEND_API_KEY")
    if not api_key or not to_email:
        return
    name = (display_name or "there").split(" ")[0]
    html = f"""
    <div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:520px">
      <h2 style="margin-bottom:4px">Application submitted ✓</h2>
      <p>Hey {name}, Rack submitted your application for
      <strong>{job_title}</strong> at <strong>{company}</strong>.
      The confirmation screenshot is saved in your Tracking board.</p>
      <p style="color:#888;font-size:12px">— Rack · rackx.app</p>
    </div>"""
    try:
        async with httpx.AsyncClient() as client:
            await client.post(
                "https://api.resend.com/emails",
                headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                json={
                    "from":    "Rack <tejas@rackx.app>",
                    "to":      [to_email],
                    "subject": f"Submitted: {job_title} at {company}",
                    "html":    html,
                },
                timeout=15.0,
            )
    except Exception as e:
        logger.warning(f"[apply_worker] submitted email failed: {e}")


# ── DB helpers ─────────────────────────────────────────────────────────────────

async def _set_job(job_pk, **values):
    values["updated_at"] = _utcnow()
    async with AsyncSessionLocal() as db:
        await db.execute(sa_update(ApplyJob).where(ApplyJob.id == job_pk).values(**values))
        await db.commit()


async def _load_user(user_id):
    from models.orm import User
    async with AsyncSessionLocal() as db:
        res = await db.execute(select(User).where(User.id == user_id))
        return res.scalar_one_or_none()


# ── Phase 1: Fill & Capture ────────────────────────────────────────────────────

async def _capture_one(job: ApplyJob, profile: dict, resume_id: str | None, user_id: str):
    """Run the headless fill on one job. Returns the terminal status string."""
    from services.browser_agent import run_apply_agent

    captured = None
    job_removed = False
    err_text = None

    async for event in run_apply_agent(
        job_url             = job.job_url,
        job_title           = job.job_title,
        company             = job.company,
        resume_text         = profile.get("resume_text", ""),
        profile             = profile,
        job_id              = job.job_id,
        resume_id           = resume_id,
        user_id             = user_id,
        review_event        = None,
        mode                = "headless",
        stop_before_submit  = True,
        capture_screenshots = True,
    ):
        etype = event.get("type")
        if etype == "captured":
            captured = event
        elif etype == "job_removed":
            job_removed = True
            err_text = event.get("text")
        elif etype == "error":
            err_text = event.get("text")

    if job_removed:
        await _set_job(job.id, status="job_removed", error=err_text)
        await _archive_removed_job(job)
        return "job_removed"

    if not captured:
        await _set_job(job.id, status="failed", error=err_text or "Fill did not complete")
        return "failed"

    # Persist screenshot
    paths = []
    png = captured.get("screenshot_png")
    if png:
        path = f"{job.user_id}/{job.id}/filled.png"
        stored = await _upload_png(path, png)
        if stored:
            paths.append(stored)

    await _set_job(
        job.id,
        status            = "awaiting_review",
        draft             = captured.get("draft"),
        screenshot_paths  = paths or None,
        filled_count      = captured.get("filled_count", 0),
        validation_errors = captured.get("validation_errors", 0),
        error             = None,
    )
    return "awaiting_review"


async def _archive_removed_job(job: ApplyJob):
    """Same cleanup the live apply path does: drop from matches, archive forever."""
    if not job.job_id:
        return
    try:
        from models.orm import AutoMatchResult, ArchivedJobId
        from sqlalchemy import delete as sa_delete
        from sqlalchemy.dialects.postgresql import insert as pg_insert
        async with AsyncSessionLocal() as db:
            await db.execute(sa_delete(AutoMatchResult).where(
                AutoMatchResult.user_id == job.user_id,
                AutoMatchResult.job_id  == job.job_id,
            ))
            await db.execute(
                pg_insert(ArchivedJobId).values(
                    user_id=job.user_id, job_id=job.job_id, archived_at=_utcnow(),
                ).on_conflict_do_nothing(index_elements=["user_id", "job_id"])
            )
            await db.commit()
    except Exception as e:
        logger.warning(f"[apply_worker] archive cleanup failed: {e}")


async def process_batch(batch_id):
    """Phase 1 driver. Safe to fire with asyncio.create_task()."""
    async with AsyncSessionLocal() as db:
        res = await db.execute(select(ApplyBatch).where(ApplyBatch.id == batch_id))
        batch = res.scalar_one_or_none()
        if not batch:
            logger.error(f"[apply_worker] batch {batch_id} not found")
            return
        jobs_res = await db.execute(
            select(ApplyJob)
            .where(ApplyJob.batch_id == batch_id, ApplyJob.status == "queued")
            .order_by(ApplyJob.created_at.asc())
        )
        jobs = list(jobs_res.scalars())
        await db.execute(sa_update(ApplyBatch).where(ApplyBatch.id == batch_id)
                         .values(status="processing"))
        await db.commit()

    user = await _load_user(batch.user_id)
    if not user:
        logger.error(f"[apply_worker] user {batch.user_id} not found for batch {batch_id}")
        return

    # Deferred import — avoids circular import at module load
    from routers.apply import _build_profile
    async with AsyncSessionLocal() as db:
        profile = await _build_profile(user, str(batch.resume_id) if batch.resume_id else None, db)
    resume_id = profile.get("_resume_id")

    ready = failed = 0
    for job in jobs:
        async with _browser_lock:
            await _set_job(job.id, status="filling", attempts=job.attempts + 1)
            try:
                outcome = await _capture_one(job, profile, resume_id, str(batch.user_id))
            except Exception as e:
                logger.error(f"[apply_worker] capture crashed for job {job.id}: {e}", exc_info=True)
                await _set_job(job.id, status="failed", error=str(e)[:300])
                outcome = "failed"
        if outcome == "awaiting_review":
            ready += 1
        elif outcome in ("failed", "job_removed"):
            failed += 1
        # Politeness gap between applications
        await asyncio.sleep(5)

    # Batch terminal state + one review email
    async with AsyncSessionLocal() as db:
        await db.execute(sa_update(ApplyBatch).where(ApplyBatch.id == batch_id).values(
            status       = "awaiting_review" if ready else "failed",
            completed_at = _utcnow(),
            notified_at  = _utcnow() if ready else None,
        ))
        await db.commit()

    if ready:
        await _send_review_email(user.email, user.display_name, ready, failed)
    logger.info(f"[apply_worker] batch {batch_id} Phase 1 done — ready={ready} failed={failed}")


# ── Phase 2: Replay & Submit ───────────────────────────────────────────────────

def _apply_edits(draft: list, edits: list | None) -> list:
    """Merge user edits ({field_label, new_value}) into the draft by label."""
    if not edits:
        return draft
    by_label = { (e.get("field_label") or "").strip().lower(): e.get("new_value", "")
                 for e in edits if e.get("field_label") }
    out = []
    for f in draft:
        lbl = (f.get("field_label") or "").strip().lower()
        if lbl in by_label:
            f = {**f, "value": by_label[lbl], "skip": False}
        out.append(f)
    return out


async def process_approval(apply_job_id):
    """Phase 2 driver for one approved job. Fire with asyncio.create_task()."""
    async with AsyncSessionLocal() as db:
        res = await db.execute(select(ApplyJob).where(ApplyJob.id == apply_job_id))
        job = res.scalar_one_or_none()
    if not job or job.status != "approved":
        logger.warning(f"[apply_worker] approval skipped — job {apply_job_id} status={getattr(job, 'status', None)}")
        return
    if not job.draft:
        await _set_job(job.id, status="failed", error="No saved draft to replay")
        return

    user = await _load_user(job.user_id)
    from routers.apply import _build_profile
    async with AsyncSessionLocal() as db:
        # Batch resume_id travels on the batch row; re-resolve from there
        bres = await db.execute(select(ApplyBatch).where(ApplyBatch.id == job.batch_id))
        batch = bres.scalar_one_or_none()
        profile = await _build_profile(user, str(batch.resume_id) if (batch and batch.resume_id) else None, db)

    draft = _apply_edits(list(job.draft), job.user_edits)

    from services.browser_agent import run_apply_agent

    async with _browser_lock:
        await _set_job(job.id, status="replaying", attempts=job.attempts + 1)
        submitted = done_unconfirmed = job_removed = False
        confirmation = None
        confirm_png = None
        err_text = None
        try:
            async for event in run_apply_agent(
                job_url             = job.job_url,
                job_title           = job.job_title,
                company             = job.company,
                resume_text         = profile.get("resume_text", ""),
                profile             = profile,
                job_id              = job.job_id,
                resume_id           = profile.get("_resume_id"),
                user_id             = str(job.user_id),
                review_event        = None,            # auto-submit after fill
                mode                = "headless",
                precomputed_fields  = draft,
                capture_screenshots = True,
            ):
                etype = event.get("type")
                if etype == "submitted":
                    submitted = True
                    confirmation = event.get("confirmation")
                    confirm_png = event.get("screenshot_png")
                elif etype == "done":
                    done_unconfirmed = True
                    confirm_png = event.get("screenshot_png")
                elif etype == "job_removed":
                    job_removed = True
                    err_text = event.get("text")
                elif etype == "error":
                    err_text = event.get("text")
        except Exception as e:
            logger.error(f"[apply_worker] replay crashed for job {job.id}: {e}", exc_info=True)
            err_text = str(e)[:300]

    confirm_path = None
    if confirm_png:
        confirm_path = await _upload_png(f"{job.user_id}/{job.id}/confirmation.png", confirm_png)

    if submitted:
        await _set_job(job.id, status="submitted", confirmation_screenshot=confirm_path,
                       confirmation_text=confirmation, error=None)
        # Mark applied in auto_match_results (same as live flow)
        if job.job_id:
            try:
                from models.orm import AutoMatchResult
                async with AsyncSessionLocal() as db:
                    await db.execute(sa_update(AutoMatchResult).where(
                        AutoMatchResult.user_id == job.user_id,
                        AutoMatchResult.job_id  == job.job_id,
                    ).values(applied=True, applied_at=_utcnow()))
                    await db.commit()
            except Exception as e:
                logger.warning(f"[apply_worker] applied flag update failed: {e}")
        if user:
            await _send_submitted_email(user.email, user.display_name, job.job_title, job.company)
    elif job_removed:
        await _set_job(job.id, status="job_removed", error=err_text)
        await _archive_removed_job(job)
    elif done_unconfirmed:
        # Submit clicked but no confirmation detected. Do NOT retry automatically —
        # the application may have gone through. Human must check the ATS.
        await _set_job(job.id, status="needs_attention",
                       confirmation_screenshot=confirm_path,
                       error="Submit clicked but confirmation page not detected — check the ATS before retrying")
    else:
        await _set_job(job.id, status="failed", error=err_text or "Replay did not complete")


# ── Startup recovery ───────────────────────────────────────────────────────────

async def recover_orphans():
    """Reset rows stuck in transient states after a process restart."""
    async with AsyncSessionLocal() as db:
        r1 = await db.execute(sa_update(ApplyJob).where(ApplyJob.status == "filling")
                              .values(status="queued", updated_at=_utcnow()))
        r2 = await db.execute(sa_update(ApplyJob).where(ApplyJob.status == "replaying")
                              .values(status="approved", updated_at=_utcnow()))
        await db.commit()
    n1 = getattr(r1, "rowcount", 0) or 0
    n2 = getattr(r2, "rowcount", 0) or 0
    if n1 or n2:
        logger.info(f"[apply_worker] recovered orphans — filling→queued: {n1}, replaying→approved: {n2}")
    # NOTE: recovered rows are NOT auto-restarted. A "Retry" action in the
    # review UI (or re-creating the batch) picks them up — deliberate, so a
    # crash loop can't silently hammer an ATS.