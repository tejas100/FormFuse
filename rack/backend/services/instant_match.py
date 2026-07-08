"""
services/instant_match.py — Instant onboarding match pipeline

Called once, right after a new user uploads their resume(s) during onboarding.
Fills auto_match_results with top-50 jobs so the Dashboard has data the moment
the user lands there — no wait, no spinner.

Design constraints:
  - NO LLM calls. No httpx to OpenAI. Pure SQL + Python.
  - NO two-phase pipeline from auto_match.py. Completely independent.
  - N resumes → N pgvector queries (one per resume) → merge → dedup → top 50 → upsert.
  - Runs as a FastAPI BackgroundTask — caller returns immediately.
  - Results get promoted to llm_scored=TRUE automatically on next scheduled run.

Over-fetch formula (ensures merged pool always has ≥50 unique jobs after dedup):
  per_resume_cap = max(ceil(50 / n_resumes) + 25, 50)
  1 resume  → 75 candidates
  2 resumes → 50 per resume (floor — ceil(25)+25=50)
  3 resumes → 50 per resume (floor — ceil(16.7)+25=42, floored up to 50)
  5 resumes → 50 per resume (floor — ceil(10)+25=35, floored up to 50)
  In practice the floor dominates for every n≥2; only n=1 ever exceeds it.

Score in auto_match_results for instant-match rows:
  semantic_score (0–100) — 1 - cosine_distance, rescaled.
  No recency blending at this stage. Scheduled pipeline overwrites with its own
  full score on next run (llm_scored flips to TRUE then).

job_data shape (what Dashboard/Tracking expect — mirrors auto_match.py output):
  job_id, job_title, company, location, url, score, posted_at, matched_at,
  source, matched_skills, missing_skills, resume_id (recommended resume)
"""

import logging
import math
import os
import uuid
from datetime import datetime, timezone
from typing import Optional

logger = logging.getLogger(__name__)

# ── Tunables ──────────────────────────────────────────────────────────────────
INSTANT_TOP_N       = 50          # jobs to store in auto_match_results
MIN_SEMANTIC_SCORE  = 35          # discard jobs below this (0–100) — noise filter
_MIN_EMB_DIM        = 1536        # sanity-check against wrong-dim embeddings


def _per_resume_cap(n_resumes: int) -> int:
    """
    How many candidates to fetch per resume so the merged pool always has
    ≥ INSTANT_TOP_N unique jobs after cross-resume deduplication.
    """
    base = math.ceil(INSTANT_TOP_N / max(n_resumes, 1)) + 25
    return max(base, INSTANT_TOP_N)  # never fetch fewer than INSTANT_TOP_N per resume


async def run_instant_match(user_id: str, db) -> dict:
    """
    Main entry point.

    1. Load resume_embeddings for this user from the `resumes` table.
    2. For each resume: run one pgvector ANN query against job_pool.jd_embedding.
    3. Merge all candidate lists, dedup by job_id (keep highest score).
    4. Sort by score DESC, take top INSTANT_TOP_N.
    5. Upsert into auto_match_results (llm_scored=False).
    6. Return summary dict (for logging — caller ignores it).

    db: AsyncSession (passed from BackgroundTask context via a fresh session).
    """
    from sqlalchemy import text
    from sqlalchemy.dialects.postgresql import insert as pg_insert
    from models.orm import AutoMatchResult

    logger.info(f"[InstantMatch] Starting for user={user_id}")

    # ── Step 1: Load resume embeddings ───────────────────────────────────────
    try:
        user_uuid = uuid.UUID(user_id)
    except ValueError:
        logger.error(f"[InstantMatch] Invalid user_id={user_id!r} — aborting")
        return {"error": "invalid_user_id"}

    rows = await db.execute(
        text("""
            SELECT id, resume_embedding, display_name, skills, titles
            FROM resumes
            WHERE user_id = :uid
              AND status = 'active'
              AND resume_embedding IS NOT NULL
        """),
        {"uid": user_uuid},
    )
    resume_rows = rows.fetchall()

    if not resume_rows:
        logger.warning(f"[InstantMatch] No embeddings found for user={user_id} — aborting")
        return {"error": "no_resume_embeddings"}

    logger.info(f"[InstantMatch] user={user_id} Found {len(resume_rows)} resume(s) with embeddings")

    # ── Step 2: pgvector ANN query per resume ────────────────────────────────
    # Query job_pool.jd_embedding using cosine distance (<=>).
    # The HNSW index on job_pool.jd_embedding (added in Migration A) accelerates this.
    # We fetch per_cap candidates per resume so dedup still yields INSTANT_TOP_N.

    n_resumes   = len(resume_rows)
    per_cap     = _per_resume_cap(n_resumes)

    # job_id → {"score": float, "resume_id": str, "row": dict}
    # If same job appears from two resumes, keep the higher score.
    merged: dict[str, dict] = {}

    for resume_row in resume_rows:
        rid         = str(resume_row.id)
        emb         = resume_row.resume_embedding
        resume_name = resume_row.display_name or ""
        skills      = resume_row.skills or []

        # resume_embedding may come back as a string from raw SQL text() queries
        # (Postgres vector → Python string like "[-0.009,-0.007,...]").
        # Normalise to a plain Python list of floats before using it.
        if isinstance(emb, str):
            import json as _json_emb
            try:
                emb = _json_emb.loads(emb)
            except Exception:
                logger.warning(f"[InstantMatch] Resume {rid} embedding string parse failed — skipping")
                continue

        if not emb or len(emb) != _MIN_EMB_DIM:
            logger.warning(
                f"[InstantMatch] Resume {rid} has bad embedding "
                f"(len={len(emb) if emb else 0}) — skipping"
            )
            continue

        # pgvector expects the embedding as a literal vector string: '[0.1, 0.2, ...]'
        emb_literal = "[" + ",".join(str(x) for x in emb) + "]"

        # Cosine distance <=> gives 0 = identical, 2 = opposite.
        # score = (1 - distance) * 100 rescales to 0–100.
        # We filter at query time with HAVING to skip clear mismatches early.
        sql = text("""
            SELECT
                job_id,
                title,
                company,
                location,
                url,
                posted_at,
                source,
                description_text,
                department,
                (1.0 - (jd_embedding <=> CAST(:emb AS vector))) * 100 AS semantic_score
            FROM job_pool
            WHERE is_active = TRUE
              AND jd_embedding IS NOT NULL
            ORDER BY jd_embedding <=> CAST(:emb AS vector)
            LIMIT :cap
        """)

        try:
            result = await db.execute(sql, {"emb": emb_literal, "cap": per_cap})
            candidates = result.fetchall()
        except Exception as e:
            logger.error(f"[InstantMatch] pgvector query failed for resume {rid}: {e}")
            continue

        logger.debug(
            f"[InstantMatch] resume={rid} fetched {len(candidates)} candidates "
            f"(cap={per_cap})"
        )

        for c in candidates:
            score = float(c.semantic_score)
            if score < MIN_SEMANTIC_SCORE:
                continue  # noise — don't even add to merged pool

            job_id = c.job_id

            if job_id not in merged or score > merged[job_id]["score"]:
                merged[job_id] = {
                    "score":       score,
                    "resume_id":   rid,
                    "resume_name": resume_name,
                    "resume_skills": skills,
                    "title":       c.title or "",
                    "company":     c.company or "",
                    "location":    c.location or "",
                    "url":         c.url or "",
                    "posted_at":   c.posted_at,
                    "source":      c.source or "greenhouse",
                    "desc_snippet": (c.description_text or "")[:300],
                    "department":  c.department or "",
                }

    if not merged:
        logger.warning(f"[InstantMatch] user={user_id} No candidates survived dedup — aborting")
        return {"stored": 0, "reason": "no_candidates"}

    # ── Step 3: Sort and take top INSTANT_TOP_N ──────────────────────────────
    ranked = sorted(merged.items(), key=lambda kv: kv[1]["score"], reverse=True)
    top50  = ranked[:INSTANT_TOP_N]

    logger.info(
        f"[InstantMatch] user={user_id} Merged pool: {len(merged)} unique jobs → "
        f"top {len(top50)} selected"
    )

    # ── Step 4: Build job_data dicts (shape Dashboard expects) ───────────────
    now = datetime.now(timezone.utc)
    to_upsert = []

    for job_id, info in top50:
        score_int = round(info["score"])

        posted_at = info["posted_at"]
        if posted_at and hasattr(posted_at, "isoformat"):
            posted_at_dt = posted_at if posted_at.tzinfo else posted_at.replace(tzinfo=timezone.utc)
        else:
            posted_at_dt = None

        # job_data shape mirrors auto_match.py so Tracking/Dashboard render identically
        job_data = {
            "job_id":          job_id,
            "job_title":       info["title"],
            "company":         info["company"],
            "location":        info["location"],
            "url":             info["url"],
            "score":           score_int,
            "posted_at":       posted_at_dt.isoformat() if posted_at_dt else None,
            "matched_at":      now.isoformat(),
            "source":          info["source"],
            "department":      info["department"],
            "matched_skills":  [],    # no skill extraction at this stage
            "missing_skills":  [],
            "resume_id":       info["resume_id"],   # recommended resume
            "resume_name":     info["resume_name"],
            "llm_scored":      False,
            "scoring_method":  "instant_pgvector",
        }

        to_upsert.append({
            "job_id":                job_id,
            "job_data":              job_data,
            "score":                 float(score_int),
            "posted_at":             posted_at_dt,
            "resume_id":             uuid.UUID(info["resume_id"]),
        })

    # ── Step 5: Upsert into auto_match_results ───────────────────────────────
    # ON CONFLICT (user_id, job_id):
    #   - Only overwrite if existing row is NOT llm_scored
    #     (we never downgrade an LLM-confirmed result with a pgvector estimate).
    #   - If already llm_scored=TRUE, leave it alone.

    upserted = 0
    for entry in to_upsert:
        stmt = (
            pg_insert(AutoMatchResult)
            .values(
                id=uuid.uuid4(),
                user_id=user_uuid,
                job_id=entry["job_id"],
                job_data=entry["job_data"],
                score=entry["score"],
                posted_at=entry["posted_at"],
                matched_at=now,
                recommended_resume_id=entry["resume_id"],
                # llm_scored=False — instant match, no LLM
            )
            .on_conflict_do_update(
                constraint="uq_auto_match_user_job",
                set_={
                    "job_data":              entry["job_data"],
                    "score":                 entry["score"],
                    "posted_at":             entry["posted_at"],
                    "matched_at":            now,
                    "recommended_resume_id": entry["resume_id"],
                },
                # Only overwrite rows that haven't been LLM-scored yet.
                # Rows with llm_scored=TRUE came from the full pipeline and are
                # more accurate — never replace them with a pgvector estimate.
                where=(AutoMatchResult.llm_scored == False),  # noqa: E712
            )
        )
        try:
            await db.execute(stmt)
            upserted += 1
        except Exception as e:
            logger.warning(f"[InstantMatch] Upsert failed for job_id={entry['job_id']}: {e}")

    try:
        await db.commit()
    except Exception as e:
        logger.error(f"[InstantMatch] Commit failed for user={user_id}: {e}")
        await db.rollback()
        return {"error": "commit_failed"}

    logger.info(
        f"[InstantMatch] user={user_id} Complete: "
        f"{upserted}/{len(to_upsert)} rows upserted into auto_match_results"
    )
    return {
        "stored":   upserted,
        "total":    len(merged),
        "resumes":  n_resumes,
        "per_cap":  per_cap,
    }