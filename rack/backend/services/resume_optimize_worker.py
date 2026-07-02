"""
services/resume_optimize_worker.py — Resume optimization background pipeline

Runs BEFORE Phase 1 form-filling. routers/apply.py's create_apply_batch()
now kicks THIS instead of apply_worker.process_batch() directly. Phase 1
fill for a given job only fires after that job's resume is approved — see
POST /api/apply/jobs/{id}/resume/approve in routers/apply.py, which calls
apply_worker.process_single_job() for just that one job.

Flow per job in the batch:
  1. Resolve resume: AutoMatchResult.recommended_resume_id (per-job best fit)
     > batch.resume_id > most-recent active resume
  2. Parse (or reuse resumes.structured_json cache) the structured document
  3. Fetch JD text from job_pool (raw psycopg2 — job_pool is NEVER via ORM,
     per the standing architectural invariant)
  4. Call resume_optimizer.generate_resume_patches()
  5. Persist a ResumeOptimization row, flip ApplyJob.resume_status
  6. Broadcast the status change to any open SSE stream for this batch

This is a NEW file rather than an edit to apply_worker.py — that file
already runs the tested Phase 1/Phase 2 pipeline and I didn't want to touch
its working code paths for an unrelated pre-stage. process_single_job()
(the one addition apply_worker.py DOES need) is added separately, additively.
"""

import asyncio
import logging
import uuid as _uuid

from sqlalchemy import select, update as sa_update

from db.database import AsyncSessionLocal

logger = logging.getLogger(__name__)

# In-memory pub/sub for the resume-status SSE stream, keyed by batch_id.
# Same pattern as _pending_reviews in routers/apply.py. Single-process only
# — fine today (one Render instance); would need Redis pub/sub to scale
# past that, same caveat as the existing _pending_reviews/_pending_otp_live.
_resume_stream_queues: dict[str, list] = {}


def subscribe(batch_id: str) -> "asyncio.Queue":
    q = asyncio.Queue()
    _resume_stream_queues.setdefault(batch_id, []).append(q)
    return q


def unsubscribe(batch_id: str, q) -> None:
    subs = _resume_stream_queues.get(batch_id, [])
    if q in subs:
        subs.remove(q)


async def _broadcast(batch_id: str, event: dict) -> None:
    for q in list(_resume_stream_queues.get(batch_id, [])):
        await q.put(event)


def _fetch_job_description(job_id: str) -> dict:
    """job_pool is NEVER accessed via ORM — raw psycopg2 on DATABASE_URL_DIRECT."""
    import os
    import psycopg2
    import psycopg2.extras

    dsn = os.environ["DATABASE_URL_DIRECT"].replace("postgresql+psycopg2", "postgresql")
    conn = psycopg2.connect(dsn)
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT * FROM job_pool WHERE job_id = %s LIMIT 1", (job_id,))
            row = cur.fetchone()
            return dict(row) if row else {}
    finally:
        conn.close()


async def _resolve_resume_row(user_id, job_id: str | None, batch_resume_id: str | None, db):
    from models.orm import AutoMatchResult, Resume

    candidate_id = None
    if job_id:
        res = await db.execute(
            select(AutoMatchResult).where(AutoMatchResult.user_id == user_id, AutoMatchResult.job_id == job_id)
        )
        amr = res.scalar_one_or_none()
        if amr and getattr(amr, "recommended_resume_id", None):
            candidate_id = str(amr.recommended_resume_id)
    if not candidate_id and batch_resume_id:
        candidate_id = batch_resume_id

    resume_row = None
    if candidate_id:
        res = await db.execute(
            select(Resume).where(
                Resume.id == _uuid.UUID(candidate_id), Resume.user_id == user_id, Resume.status == "active"
            )
        )
        resume_row = res.scalar_one_or_none()

    if not resume_row:
        res = await db.execute(
            select(Resume)
            .where(Resume.user_id == user_id, Resume.status == "active", Resume.is_optimized.is_(False))
            .order_by(Resume.uploaded_at.desc())
            .limit(1)
        )
        resume_row = res.scalar_one_or_none()

    return resume_row


async def _get_structured_doc(resume_row, db) -> dict:
    """Cached on resumes.structured_json — parsed once per base resume, reused across applications."""
    if resume_row.structured_json:
        return resume_row.structured_json

    from services.resume_parser import parse_resume_structured

    pdf_bytes = None
    if resume_row.storage_path:
        try:
            from routers.resumes import _get_supabase, STORAGE_BUCKET
            import httpx

            sb = _get_supabase()
            signed = sb.storage.from_(STORAGE_BUCKET).create_signed_url(resume_row.storage_path, 60)
            url = (
                getattr(signed, "signed_url", None)
                or getattr(signed, "signedURL", None)
                or (isinstance(signed, dict) and (signed.get("signedURL") or signed.get("signedUrl") or signed.get("signed_url")))
                or ""
            )
            if url:
                async with httpx.AsyncClient() as hx:
                    r = await hx.get(url, timeout=15)
                    pdf_bytes = r.content
        except Exception as e:
            logger.warning(f"[resume_optimize_worker] could not fetch PDF bytes for resume {resume_row.id}, "
                            f"falling back to full_text only: {e}")

    structured_doc = parse_resume_structured(pdf_bytes, resume_row.full_text or "")
    resume_row.structured_json = structured_doc
    await db.commit()
    return structured_doc


async def optimize_batch_resumes(batch_id) -> None:
    """Background task — kicked from routers/apply.py's create_apply_batch() via asyncio.create_task()."""
    from models.orm import ApplyBatch, ApplyJob, ResumeOptimization
    from services.resume_optimizer import generate_resume_patches

    async with AsyncSessionLocal() as db:
        batch = (await db.execute(select(ApplyBatch).where(ApplyBatch.id == batch_id))).scalar_one_or_none()
        if not batch:
            logger.error(f"[resume_optimize_worker] batch {batch_id} not found")
            return
        jobs = list((await db.execute(
            select(ApplyJob).where(ApplyJob.batch_id == batch_id).order_by(ApplyJob.created_at.asc())
        )).scalars())
        user_id = batch.user_id
        batch_resume_id = str(batch.resume_id) if batch.resume_id else None

    for job in jobs:
        async with AsyncSessionLocal() as db:
            try:
                await db.execute(sa_update(ApplyJob).where(ApplyJob.id == job.id).values(resume_status="optimizing"))
                await db.commit()
                await _broadcast(str(batch_id), {"apply_job_id": str(job.id), "resume_status": "optimizing"})

                resume_row = await _resolve_resume_row(user_id, job.job_id, batch_resume_id, db)
                if not resume_row:
                    logger.warning(f"[resume_optimize_worker] no active resume found for job {job.id}")
                    await db.execute(sa_update(ApplyJob).where(ApplyJob.id == job.id).values(resume_status="failed"))
                    await db.commit()
                    await _broadcast(str(batch_id), {"apply_job_id": str(job.id), "resume_status": "failed"})
                    continue

                structured_doc = await _get_structured_doc(resume_row, db)

                jd = _fetch_job_description(job.job_id) if job.job_id else {}
                jd_text = jd.get("description_text") or jd.get("description") or ""
                required_skills = jd.get("required_skills") or []
                preferred_skills = jd.get("preferred_skills") or []

                result = await generate_resume_patches(structured_doc, jd_text, required_skills, preferred_skills)

                opt = ResumeOptimization(
                    apply_job_id=job.id,
                    user_id=user_id,
                    source_resume_id=resume_row.id,
                    job_id=job.job_id,
                    structured_doc=structured_doc,
                    patches=result["patches"],
                    requirement_classification=result["requirement_classification"],
                    decisions={p["id"]: "accepted" for p in result["patches"]},
                    manual_edits={},
                    status="ready",
                )
                db.add(opt)
                await db.execute(sa_update(ApplyJob).where(ApplyJob.id == job.id).values(resume_status="ready"))
                await db.commit()
                await _broadcast(str(batch_id), {"apply_job_id": str(job.id), "resume_status": "ready"})

            except Exception as e:
                logger.error(f"[resume_optimize_worker] job {job.id} failed: {e}", exc_info=True)
                await db.execute(sa_update(ApplyJob).where(ApplyJob.id == job.id).values(resume_status="failed"))
                await db.commit()
                await _broadcast(str(batch_id), {"apply_job_id": str(job.id), "resume_status": "failed"})

    logger.info(f"[resume_optimize_worker] batch {batch_id} resume optimization pass complete")