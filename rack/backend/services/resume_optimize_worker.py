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
  3. Read the user's optimize_mode ("off"|"honest"|"aggressive", from
     users.preferences — see routers/account.py) once per batch
  4. Fetch JD text from job_pool (raw psycopg2 — job_pool is NEVER via ORM,
     per the standing architectural invariant) — skipped entirely for "off"
  5. ONE LLM call (skipped entirely for "off", which just uses empty
     patches and no score): resume_optimizer.rewrite_experience_projects().
     Replaces the earlier extract -> classify -> patch 3-call chain
     entirely — that chain, and the functions it called
     (extract_jd_requirements, classify_and_score_requirements,
     generate_resume_patches), still exist in resume_optimizer.py but are
     no longer called from here. They're left in place rather than deleted
     because routers/apply.py's module docstring flagged its own
     regenerate-on-demand endpoint as a possible caller of the old
     generate_resume_patches() path — confirmed this session by reading
     apply.py in full that it does NOT call any of the three directly (it
     only reads already-persisted ResumeOptimization row fields), but
     they're kept rather than deleted purely as a "known-safe, zero-risk"
     choice, not because anything still needs them.

     rewrite_experience_projects() sends the full, untruncated experience +
     projects JSON straight to GPT-4o (not mini — this needs holistic
     rewriting judgment, not keyword classification) along with the raw JD
     text, and gets back the same bullets with an inline "segments" array
     on any bullet it touched: small insertions/edits as "llm_suggested"
     segments anchored against the surrounding original text, or full
     sentence replacements as a single "rewritten" segment. Every
     "original"-typed segment is verified server-side against the real
     stored bullet text before anything is trusted — a segment that claims
     to be unchanged but doesn't match gets relabeled "llm_suggested"
     (never silently discarded) so the user still reviews it. The verified
     segments are then converted into the SAME insert_phrase/rewrite_bullet
     patch shape the old pipeline produced, so ResumeOptimization.patches
     keeps its existing shape and Dashboard.jsx / ResumeOptimizer.jsx /
     resume_renderer.py need no changes to consume it.

     No requirement classification and no match_score come out of this
     call — both are dropped for now (a deliberate simplification, not an
     oversight; see resume_optimizer.py's rewrite_experience_projects()
     docstring). ResumeOptimization.requirement_classification is stored as
     [] and match_score as None for jobs optimized this way.
  6. Persist a ResumeOptimization row. Flip ApplyJob.resume_status.
  7. Broadcast the status change to any open SSE stream for this batch

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
    from models.orm import ApplyBatch, ApplyJob, ResumeOptimization, User
    from services.resume_optimizer import rewrite_experience_projects

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

        # Read once per batch, not once per job — same user, same setting for
        # every job in this batch. From routers/account.py's ProfileUpdate:
        # optimize_mode is "off"|"honest"|"aggressive"; DEFAULT_PREFERENCES
        # doesn't include it, so a user who never touched onboarding step 6
        # has no key at all here — default to "honest", today's only real
        # behavior, rather than silently changing what un-configured users get.
        user_row = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
        optimize_mode = (user_row.preferences or {}).get("optimize_mode") if user_row else None
        if optimize_mode not in ("off", "honest", "aggressive"):
            optimize_mode = "honest"
        logger.info(f"[resume_optimize_worker] batch {batch_id} user={user_id} optimize_mode={optimize_mode!r}")

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

                if optimize_mode == "off":
                    # "Send your resume exactly as uploaded" — don't spend
                    # LLM calls computing edits that would just be discarded.
                    # Same ResumeOptimization row shape as the other two
                    # modes, just empty patches and no score, so the review
                    # panel and PDF renderer need no special-casing — an
                    # empty patch list already means "render the doc as-is"
                    # in both of those, unrelated to this change.
                    result = {"requirement_classification": [], "patches": [], "match_score": None}
                else:
                    jd = _fetch_job_description(job.job_id) if job.job_id else {}
                    jd_text = jd.get("description_text") or jd.get("description") or ""

                    # Single call — replaces the old extract -> classify ->
                    # patch chain. The model sees the full experience+
                    # projects JSON and the raw JD text directly (its own
                    # prompt does the requirement reading, no separate
                    # extraction step) and returns bullets with inline
                    # "segments" wherever it made a change, already
                    # converted to the same insert_phrase/rewrite_bullet
                    # patch shape the old pipeline produced — see
                    # resume_optimizer.py's rewrite_experience_projects()
                    # docstring for the full contract.
                    #
                    # requirement_classification / match_score are
                    # deliberately empty/None here — this pipeline doesn't
                    # compute either anymore (dropped along with the
                    # classify call). apply.py's GET /resume endpoint
                    # already has a graceful fallback via
                    # score_from_classification([]), which just reads as
                    # 0%/"Poor Match" rather than crashing — accurate for
                    # "no score was computed," not a bug. Scoring may come
                    # back later as a separate, cheap, non-LLM pass.
                    rewrite_result = await rewrite_experience_projects(
                        structured_doc, jd_text, mode=optimize_mode
                    )

                    result = {
                        "requirement_classification": [],
                        "patches": rewrite_result["patches"],
                        "match_score": None,
                    }

                opt = ResumeOptimization(
                    apply_job_id=job.id,
                    user_id=user_id,
                    source_resume_id=resume_row.id,
                    job_id=job.job_id,
                    structured_doc=structured_doc,
                    patches=result["patches"],
                    requirement_classification=result["requirement_classification"],
                    match_score=result["match_score"],
                    decisions={p["id"]: "accepted" for p in result["patches"]},
                    manual_edits={},
                    status="ready",
                )
                db.add(opt)
                await db.execute(sa_update(ApplyJob).where(ApplyJob.id == job.id).values(resume_status="ready"))
                await db.commit()
                await _broadcast(str(batch_id), {
                    "apply_job_id": str(job.id),
                    "resume_status": "ready",
                    "resume_name": resume_row.display_name,
                })

            except Exception as e:
                logger.error(f"[resume_optimize_worker] job {job.id} failed: {e}", exc_info=True)
                await db.execute(sa_update(ApplyJob).where(ApplyJob.id == job.id).values(resume_status="failed"))
                await db.commit()
                await _broadcast(str(batch_id), {"apply_job_id": str(job.id), "resume_status": "failed"})

    logger.info(f"[resume_optimize_worker] batch {batch_id} resume optimization pass complete")