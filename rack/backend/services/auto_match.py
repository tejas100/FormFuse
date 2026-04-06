"""
services/auto_match.py — Fully automatic job discovery + matching pipeline.

Powers the "Auto Matches" tab on the Tracking page.

Session 16: run_auto_pipeline() accepts db (AsyncSession) for pgvector search.
Session 20: Results and archive now stored in Supabase DB instead of JSON files.
Session 21: Normalized DB schema — one row per (user, job) in auto_match_results.
  - Removed _save_snapshot_to_db() and _load_snapshot_from_db() (snapshot model gone)
  - Removed _get_run_dates_from_db() (no more date history)
  - Added _save_results_to_db()  — upserts individual job rows
  - Added _load_results_from_db() — loads all scored jobs for a user, sorted by score
  - run_auto_pipeline() now incremental: only scores jobs not already in DB
  - force=True bypasses results cache but does NOT re-fetch pool if still fresh
Session 31: Multi-source expansion + batched Phase 1.
  - Replaced inline _fetch_greenhouse() with job_fetcher.fetch_all_auto_match()
  - Added Ashby + Lever fetching via job_fetcher.py
  - Removed PHASE1_JOB_CAP — Phase 1 now processes all new jobs in batches of BATCH_SIZE
  - Pool staleness reduced from 24h to 0.5h (30 min)
  - Removed auto_job_pool.json disk cache — pool fetched fresh every cycle
"""

import asyncio
import json
import logging
import os
import re
import math
from datetime import datetime, timezone, timedelta
from typing import Optional

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert

logger = logging.getLogger(__name__)

# ── Storage ──────────────────────────────────────────────────────────
WATCHLIST_DIR = os.path.join("uploads", "watchlist")

# ── Tunables ─────────────────────────────────────────────────────────
DISPLAY_CAP            = 300
STORE_CAP              = 300
SCORE_WEIGHT           = 0.85
RECENCY_WEIGHT         = 0.15
RECENCY_HALF_LIFE_DAYS = 7
MIN_SCORE              = 55   # LLM score floor — anything below is noise, never stored
PHASE2_THRESHOLD       = 35   # Phase 1 pre-filter only — LLM is the real judge. 35% filters clearly irrelevant roles while passing ambiguous matches to GPT-4o-mini.
BATCH_SIZE             = 50
MIN_DESC_LEN           = 100
STALE_HOURS            = 0.5
MAX_CONCURRENT         = 15
ROLE_MATCH_RATIO       = 0.60  # Word overlap ratio for title matching — 0.60 balances precision vs recall


# ── Role matching ─────────────────────────────────────────────────────
def _role_matches_title(title: str, target_roles: list[str], role_aliases: dict | None = None) -> bool:
    """
    Returns True if the job title matches any target role or any of its aliases.

    Matching order:
      1. Word-overlap against each target role (e.g. "AI Engineer" matches "Senior AI Engineer")
      2. Word-overlap against every alias for that role (e.g. "machine learning engineer" alias
         matches "Principal Machine Learning Engineer")

    role_aliases: {"AI Engineer": ["machine learning engineer", "mlops engineer", ...], ...}
    """
    title_words = set(re.split(r"[\s\-/,]+", title.lower()))
    title_words = {w for w in title_words if len(w) > 1}
    aliases = role_aliases or {}

    for role in target_roles:
        # Primary role word-overlap
        role_words = set(re.split(r"[\s\-/,]+", role.lower()))
        role_words = {w for w in role_words if len(w) > 1}
        if role_words:
            overlap = len(title_words & role_words) / len(role_words)
            if overlap >= ROLE_MATCH_RATIO:
                return True

        # Alias word-overlap — uses every alias generated for this role
        for alias in aliases.get(role, []):
            alias_words = set(re.split(r"[\s\-/,]+", alias.lower()))
            alias_words = {w for w in alias_words if len(w) > 1}
            if not alias_words:
                continue
            overlap = len(title_words & alias_words) / len(alias_words)
            if overlap >= ROLE_MATCH_RATIO:
                return True

    return False


# ── Recency scoring ───────────────────────────────────────────────────
def _recency_score(posted_at: Optional[str]) -> float:
    if not posted_at:
        return 0.1
    try:
        dt = datetime.fromisoformat(posted_at.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        age_days = (datetime.now(timezone.utc) - dt).total_seconds() / 86400
        age_days = max(0, age_days)
        return math.pow(2, -age_days / RECENCY_HALF_LIFE_DAYS)
    except Exception:
        return 0.1


# ── Per-user meta helpers (last_fetch_at + pool staleness on disk) ────
def _user_meta_path(user_id: str) -> str:
    return os.path.join(WATCHLIST_DIR, f"{user_id}_meta.json")


def _load_auto_meta_for_user(user_id: str) -> dict:
    try:
        with open(_user_meta_path(user_id)) as f:
            return json.load(f)
    except Exception:
        return {"last_fetch_at": None, "last_pool_fetch_at": None}


def _save_auto_meta_for_user(user_id: str, meta: dict):
    os.makedirs(WATCHLIST_DIR, exist_ok=True)
    with open(_user_meta_path(user_id), "w") as f:
        json.dump(meta, f, indent=2)


# ── DB-backed result helpers ──────────────────────────────────────────

async def _save_results_to_db(
    user_id: str,
    entries: list,
    db: AsyncSession,
) -> None:
    """
    Upsert one row per (user_id, job_id).
    ON CONFLICT (user_id, job_id) → update score, job_data, matched_at.
    Running the pipeline again for the same job overwrites the score — never duplicates.
    """
    from models.orm import AutoMatchResult
    import uuid as _uuid

    if not entries:
        return

    user_uuid = _uuid.UUID(user_id)
    now = datetime.now(timezone.utc)

    for entry in entries:
        posted_at = None
        raw_posted = entry.get("posted_at")
        if raw_posted:
            try:
                posted_at = datetime.fromisoformat(raw_posted.replace("Z", "+00:00"))
            except Exception:
                pass

        score = float(entry.get("llm_score", entry.get("score", 0)))

        stmt = (
            pg_insert(AutoMatchResult)
            .values(
                id=_uuid.uuid4(),
                user_id=user_uuid,
                job_id=entry["job_id"],
                job_data=entry,
                score=score,
                posted_at=posted_at,
                matched_at=now,
            )
            .on_conflict_do_update(
                constraint="uq_auto_match_user_job",
                set_={
                    "job_data":   entry,
                    "score":      score,
                    "posted_at":  posted_at,
                    "matched_at": now,
                },
            )
        )
        await db.execute(stmt)

    await db.commit()
    logger.info(f"[AutoMatch] user={user_id} Upserted {len(entries)} job rows to DB")


async def _load_results_from_db(
    user_id: str,
    db: AsyncSession,
    recency_days: Optional[int] = None,
    limit: int = STORE_CAP,
) -> list:
    """
    Load all scored jobs for this user, ordered by score DESC.
    Filters out globally archived job IDs.
    Optional recency_days: only return jobs posted within N days.
    """
    from models.orm import AutoMatchResult, ArchivedJobId
    import uuid as _uuid

    user_uuid = _uuid.UUID(user_id)

    # Load archived IDs first — used as exclusion filter
    archived_stmt = select(ArchivedJobId.job_id).where(
        ArchivedJobId.user_id == user_uuid
    )
    archived_result = await db.execute(archived_stmt)
    archived_ids = {r[0] for r in archived_result.fetchall()}

    # Build main query
    stmt = (
        select(AutoMatchResult)
        .where(AutoMatchResult.user_id == user_uuid)
        .order_by(AutoMatchResult.score.desc())
        .limit(limit)
    )

    # Exclude archived jobs at DB level if any exist
    if archived_ids:
        stmt = stmt.where(AutoMatchResult.job_id.notin_(archived_ids))

    # Optional recency filter at DB level
    if recency_days is not None:
        cutoff = datetime.now(timezone.utc) - timedelta(days=recency_days)
        stmt = stmt.where(AutoMatchResult.posted_at >= cutoff)

    result = await db.execute(stmt)
    rows = result.scalars().all()
    return [row.job_data for row in rows]


async def archive_jobs_for_user(
    user_id: str,
    job_ids: list[str],
    db: AsyncSession,
) -> dict:
    """
    Write job_ids to the archived_job_ids DB table.
    Also deletes those job rows from auto_match_results so they
    disappear immediately without needing a re-load.
    """
    from models.orm import ArchivedJobId, AutoMatchResult
    import uuid as _uuid

    if not job_ids:
        return {"archived": 0}

    user_uuid = _uuid.UUID(user_id)
    now = datetime.now(timezone.utc)

    # Insert into archived_job_ids — ON CONFLICT DO NOTHING (idempotent)
    for jid in job_ids:
        stmt = (
            pg_insert(ArchivedJobId)
            .values(user_id=user_uuid, job_id=jid, archived_at=now)
            .on_conflict_do_nothing(constraint="pk_archived_job_ids")
        )
        await db.execute(stmt)

    # Also remove from auto_match_results immediately so the user
    # doesn't see them again until next load
    from sqlalchemy import delete as sa_delete
    del_stmt = (
        sa_delete(AutoMatchResult)
        .where(AutoMatchResult.user_id == user_uuid)
        .where(AutoMatchResult.job_id.in_(job_ids))
    )
    await db.execute(del_stmt)

    await db.commit()
    logger.info(f"[AutoMatch] user={user_id} Archived {len(job_ids)} job(s) to DB")
    return {"archived": len(job_ids)}


async def _mark_jobs_seen(
    user_uuid,  # uuid.UUID — already converted by caller
    job_ids: list[str],
    db: AsyncSession,
) -> None:
    """
    Bulk-insert job_ids into seen_job_ids for this user.
    ON CONFLICT DO NOTHING — idempotent, safe to call multiple times.
    Called BEFORE Phase 1 starts so jobs that fail Phase 1 or score below
    MIN_SCORE are still recorded and never retried on future runs.
    """
    from models.orm import SeenJobId

    if not job_ids:
        return

    now = datetime.now(timezone.utc)
    for jid in job_ids:
        stmt = (
            pg_insert(SeenJobId)
            .values(user_id=user_uuid, job_id=jid, first_seen_at=now)
            .on_conflict_do_nothing(constraint="pk_seen_job_ids")
        )
        await db.execute(stmt)

    await db.commit()
    logger.info(f"[AutoMatch] Marked {len(job_ids)} job(s) as seen in DB")


# ── Legacy shim — kept for watchlist/custom-search callers ───────────
def _load_auto_results_for_user(user_id: str) -> list:
    """Legacy JSON read — used only by old custom-search endpoints."""
    results_path = os.path.join(WATCHLIST_DIR, f"{user_id}_results.json")
    try:
        with open(results_path) as f:
            return json.load(f)
    except Exception:
        return []


def _load_archived_ids_for_user(user_id: str) -> set:
    """Legacy — reads archived IDs from meta JSON. No longer used by main pipeline."""
    meta = _load_auto_meta_for_user(user_id)
    return set(meta.get("archived_job_ids", []))


# ── Main pipeline ─────────────────────────────────────────────────────
async def run_auto_pipeline(
    user_id: str,
    profile: dict,
    force: bool = False,
    db: AsyncSession = None,
) -> dict:
    """
    Incremental auto-matching pipeline.

    Each run:
      1. Loads the job pool (re-fetches Greenhouse only if pool is stale, ≥24h)
      2. Loads already-scored job_ids from DB — O(1) set lookup per job
      3. Scores ONLY jobs not yet in the DB (truly new jobs)
      4. Upserts new scores — existing scores untouched
      5. Returns full result set from DB, sorted by score DESC

    force=True: bypasses the results staleness check (re-runs scoring for new jobs)
                but does NOT re-fetch the Greenhouse pool if it's still fresh.
    """
    from services.matcher import match_resumes
    from services.llm_scorer import llm_score_jobs_grouped

    meta = _load_auto_meta_for_user(user_id)

    # ── Serve from DB cache if fresh and not forced ───────────────────
    _last_fetch = meta.get("last_fetch_at")
    _results_stale = True
    if _last_fetch:
        try:
            _last_dt = datetime.fromisoformat(_last_fetch)
            if _last_dt.tzinfo is None:
                _last_dt = _last_dt.replace(tzinfo=timezone.utc)
            _results_stale = (datetime.now(timezone.utc) - _last_dt) > timedelta(hours=STALE_HOURS)
        except Exception:
            pass

    if not force and not _results_stale:
        logger.info(f"[AutoMatch] user={user_id} Cache fresh — returning stored results")
        stored = await _load_results_from_db(user_id, db)
        return {
            "matches": stored[:DISPLAY_CAP],
            "stats": {
                "from_cache":   True,
                "last_fetch_at": meta.get("last_fetch_at"),
                "total_shown":  len(stored[:DISPLAY_CAP]),
            },
            "from_cache": True,
        }

    # ── Validate profile ──────────────────────────────────────────────
    target_roles = profile.get("target_roles", [])
    if not target_roles:
        return {
            "matches": [],
            "stats": {
                "error":   "no_profile",
                "message": "Set target roles in Account → Profile to enable Auto Matches.",
            },
            "from_cache": False,
        }

    logger.info(f"[AutoMatch] user={user_id} Starting pipeline for roles: {target_roles}")

    # ── Step 1: Fetch job pool (re-fetches every 30 min) ─────────────
    # Pool is always fetched fresh — no disk cache. force=True does NOT
    # change this behaviour; staleness is the only trigger.
    last_pool = meta.get("last_pool_fetch_at")
    pool_stale = True
    if last_pool:
        try:
            last_dt = datetime.fromisoformat(last_pool)
            if last_dt.tzinfo is None:
                last_dt = last_dt.replace(tzinfo=timezone.utc)
            pool_stale = (datetime.now(timezone.utc) - last_dt) > timedelta(hours=STALE_HOURS)
        except Exception:
            pass

    from services.job_fetcher import fetch_all_auto_match
    if pool_stale:
        logger.info("[AutoMatch] Pool stale — fetching from Greenhouse + Ashby + Lever…")
        semaphore = asyncio.Semaphore(MAX_CONCURRENT)
        raw_pool = await fetch_all_auto_match(semaphore)
        meta["last_pool_fetch_at"] = datetime.now(timezone.utc).isoformat()
    else:
        logger.info("[AutoMatch] Pool fresh (< 30 min) — skipping fetch, re-using in-memory pool")
        # On a fresh run within the window we still fetch — no disk cache exists.
        # The "fresh" case only applies when run_auto_pipeline is called multiple
        # times within the same server process (e.g. two users, or forced refresh).
        # For simplicity, always fetch; the semaphore keeps it bounded.
        semaphore = asyncio.Semaphore(MAX_CONCURRENT)
        raw_pool = await fetch_all_auto_match(semaphore)
        # Do NOT update last_pool_fetch_at — preserve the original timestamp

    # ── Step 2: Load seen + archived job IDs from DB ─────────────────
    # seen_job_ids: every job ever sent to Phase 1 for this user, regardless
    # of whether it passed Phase 1 or Phase 2. This is the correct skip filter —
    # unlike auto_match_results which only holds jobs that cleared MIN_SCORE.
    # Build sets once — O(1) lookup per job in the filter below.
    from models.orm import ArchivedJobId, SeenJobId
    import uuid as _uuid
    user_uuid = _uuid.UUID(user_id)

    seen_stmt = select(SeenJobId.job_id).where(
        SeenJobId.user_id == user_uuid
    )
    seen_result = await db.execute(seen_stmt)
    seen_job_ids_set: set[str] = {r[0] for r in seen_result.fetchall()}

    # Load archived IDs — excluded from scoring and display
    archived_stmt = select(ArchivedJobId.job_id).where(
        ArchivedJobId.user_id == user_uuid
    )
    archived_result = await db.execute(archived_stmt)
    archived_ids: set[str] = {r[0] for r in archived_result.fetchall()}

    logger.info(
        f"[AutoMatch] user={user_id} DB state: "
        f"{len(seen_job_ids_set)} already seen, {len(archived_ids)} archived"
    )

    # ── Step 3: Role filter ───────────────────────────────────────────
    # Pull aliases from profile so _role_matches_title can use them.
    # role_aliases: {"AI Engineer": ["machine learning engineer", ...], ...}
    role_aliases: dict = profile.get("role_aliases", {})

    role_matched = [
        j for j in raw_pool
        if _role_matches_title(j["title"], target_roles, role_aliases)
    ]
    logger.info(
        f"[AutoMatch] user={user_id} {len(role_matched)} jobs matched target roles "
        f"from pool of {len(raw_pool)}"
    )

    # ── Step 4: Location filter ───────────────────────────────────────
    # Soft-fail: jobs with no/unknown location are passed through rather than
    # dropped — they'll be scored normally and the LLM description will reveal
    # whether the role is actually based somewhere incompatible.
    preferred_locations = profile.get("preferred_locations", [])
    if preferred_locations:
        from services.user_profile import matches_any_preferred_location
        before = len(role_matched)
        location_filtered = []
        for j in role_matched:
            loc = j.get("location", "").strip()
            # Empty / unspecified location → soft pass (don't drop blindly)
            if not loc or loc.lower() in ("not specified", "n/a", "tbd", ""):
                location_filtered.append(j)
                continue
            if matches_any_preferred_location(loc, preferred_locations):
                location_filtered.append(j)
        role_matched = location_filtered
        logger.info(
            f"[AutoMatch] user={user_id} {len(role_matched)} jobs after location filter "
            f"({before - len(role_matched)} excluded)"
        )

    # ── Step 5: Find truly new jobs ───────────────────────────────────
    # A job is "new" if it has never been seen before for this user (not in
    # seen_job_ids) AND is not archived. seen_job_ids covers both jobs that
    # passed scoring AND jobs that failed Phase 1/2 — nothing gets retried.
    # Set lookup is O(1) — safe at 20k+ jobs.
    truly_new = [
        j for j in role_matched
        if j["job_id"] not in archived_ids
        and j["job_id"] not in seen_job_ids_set
    ]

    logger.info(
        f"[AutoMatch] user={user_id} {len(truly_new)} new jobs to score "
        f"({len(role_matched) - len(truly_new)} already seen or archived — skipped)"
    )

    if not truly_new:
        # Nothing new — load and return existing DB results
        existing = await _load_results_from_db(user_id, db)
        meta["last_fetch_at"] = datetime.now(timezone.utc).isoformat()
        _save_auto_meta_for_user(user_id, meta)
        logger.info(f"[AutoMatch] user={user_id} No new jobs — returning {len(existing)} existing results")
        return {
            "matches": existing[:DISPLAY_CAP],
            "stats": {
                "from_cache":    False,
                "total_pool":    len(raw_pool),
                "role_matched":  len(role_matched),
                "new_processed": 0,
                "total_shown":   len(existing[:DISPLAY_CAP]),
                "message":       "No new jobs since last run.",
            },
            "from_cache": False,
        }

    # ── Step 6: Sort new jobs by recency ─────────────────────────────
    def _posted_sort_key(j):
        try:
            return datetime.fromisoformat((j.get("posted_at") or "").replace("Z", "+00:00"))
        except Exception:
            return datetime.min.replace(tzinfo=timezone.utc)

    new_sorted = sorted(truly_new, key=_posted_sort_key, reverse=True)
    # No cap — all new jobs are processed in batches of BATCH_SIZE

    # ── Mark all new_sorted jobs as seen BEFORE Phase 1 ──────────────
    # Insert now — not after scoring — so jobs that fail Phase 1 or score
    # below MIN_SCORE are still recorded and never retried on future runs.
    await _mark_jobs_seen(user_uuid, [j["job_id"] for j in new_sorted], db)

    # ── Step 7: Phase 1 — pgvector + Hybrid scoring (concurrent) ───────
    # All jobs scored concurrently via asyncio.gather, throttled by semaphore.
    # PHASE1_CONCURRENCY controls max simultaneous pgvector + embed calls.
    # 20 is safe for Supabase pooler; raise to 30 if you upgrade connection limits.
    PHASE1_CONCURRENCY = 20
    phase1_sem = asyncio.Semaphore(PHASE1_CONCURRENCY)

    phase1_groups: dict[str, list] = {}
    parsed_jd_cache: dict[str, dict] = {}
    scored_count = 0
    _score_lock = asyncio.Lock()  # protects shared dicts from concurrent writes

    total_new = len(new_sorted)
    num_batches = math.ceil(total_new / BATCH_SIZE)  # kept for stats only
    logger.info(
        f"[AutoMatch] user={user_id} Phase 1: scoring {total_new} new jobs "
        f"concurrently (max {PHASE1_CONCURRENCY} at a time)…"
    )

    async def _score_one_job(job: dict) -> None:
        nonlocal scored_count
        desc = job.get("description_text", "").strip()
        if len(desc) < MIN_DESC_LEN:
            return

        result = None
        async with phase1_sem:
            # Each concurrent task gets its own DB session.
            # The outer `db` session is NOT concurrency-safe — sharing it across
            # asyncio.gather tasks causes "session is provisioning a new connection;
            # concurrent operations are not permitted" on all but the first task.
            from db.database import AsyncSessionLocal
            async with AsyncSessionLocal() as task_db:
                try:
                    result = await match_resumes(
                        jd_text=desc,
                        user_id=user_id,
                        use_llm=False,
                        db=task_db,
                    )
                except Exception as e:
                    logger.error(f"[AutoMatch] Phase 1 error for '{job.get('title')}': {e}")
                    return

        if result is None:
            return
        matches   = result.get("results", [])
        parsed_jd = result.get("jd_parsed", {})

        qualifying = [
            m for m in matches
            if round(m.get("raw_score", 0) * 100) >= PHASE2_THRESHOLD
        ]

        job_entries = []
        for resume_match in qualifying:
            hybrid_score = round(resume_match.get("raw_score", 0) * 100)
            resume_id    = resume_match.get("resume_id", "")
            job_entries.append({
                # Job context
                "job_id":            job["job_id"],
                "job_title":         job["title"],
                "company":           job["company"],
                "location":          job.get("location", "Not specified"),
                "job_url":           job.get("url", ""),
                "source":            job["source"],
                "board_token":       job.get("board_token", ""),
                "posted_at":         job.get("posted_at"),
                "department":        job.get("department", ""),
                # Resume context
                "resume_id":         resume_id,
                "resume_name":       resume_match.get("name", ""),
                "file_ext":          resume_match.get("file_ext", ""),
                # Hybrid scores (Phase 1)
                "hybrid_score":      hybrid_score,
                "hybrid_raw":        resume_match.get("raw_score", 0),
                "hybrid_components": resume_match.get("components", {}),
                "matched_skills":    resume_match.get("matched_skills", []),
                "missing_skills":    resume_match.get("missing_skills", []),
                "matched_preferred": resume_match.get("matched_preferred", []),
                "coverage":          resume_match.get("gap_analysis", {}).get("coverage", {}),
                "critical_gaps":     resume_match.get("gap_analysis", {}).get("critical_gaps", []),
                # Phase 2 inputs
                "job": job,
                "resume": {
                    "id":        resume_id,
                    "name":      resume_match.get("name", ""),
                    "file_ext":  resume_match.get("file_ext", ""),
                    "skills":    resume_match.get("skills", []),
                    "years_exp": resume_match.get("years_exp"),
                    "titles":    resume_match.get("titles", []),
                    "domains":   resume_match.get("domains", []),
                    "full_text": resume_match.get("full_text"),
                    "structured": {
                        "years_exp": resume_match.get("years_exp"),
                        "titles":    resume_match.get("titles", []),
                        "domains":   resume_match.get("domains", []),
                        "skills":    resume_match.get("skills", []),
                    },
                },
                "parsed_jd": parsed_jd,
            })

        async with _score_lock:
            scored_count += 1
            parsed_jd_cache[job["job_id"]] = parsed_jd
            if job_entries:
                phase1_groups[job["job_id"]] = job_entries

    # Fire all jobs concurrently — semaphore limits actual parallelism
    await asyncio.gather(*[_score_one_job(job) for job in new_sorted])

    total_pairs = sum(len(v) for v in phase1_groups.values())
    logger.info(
        f"[AutoMatch] user={user_id} Phase 1 complete: {scored_count} scored → "
        f"{len(phase1_groups)} qualifying jobs ({total_pairs} pairs)"
    )

    # ── Step 8: Phase 2 — LLM deep scoring ───────────────────────────
    # Before sending to LLM, cap each job to its top 3 resumes by hybrid score.
    # Step 9 picks the single best resume per job anyway — scoring resumes 4 & 5
    # wastes tokens and latency without changing the outcome.
    MAX_RESUMES_PER_JOB = 3
    phase1_groups_trimmed = {
        job_id: sorted(entries, key=lambda e: e.get("hybrid_score", 0), reverse=True)[:MAX_RESUMES_PER_JOB]
        for job_id, entries in phase1_groups.items()
    }
    trimmed_pairs = sum(len(v) for v in phase1_groups_trimmed.values())
    logger.info(
        f"[AutoMatch] user={user_id} Phase 2: LLM scoring {len(phase1_groups_trimmed)} jobs "
        f"({trimmed_pairs} pairs after capping to top {MAX_RESUMES_PER_JOB} resumes/job)…"
    )
    llm_scored_groups = await llm_score_jobs_grouped(phase1_groups_trimmed)

    # ── Step 9: Per job, pick best LLM-scored resume ──────────────────
    by_job: dict[str, dict] = {}
    for job_id, entries in llm_scored_groups.items():
        best = max(entries, key=lambda e: e.get("llm_score", 0))
        by_job[job_id] = best

    # ── Step 10: Build final entries ──────────────────────────────────
    new_entries = []
    for jid, pair in by_job.items():
        llm_score = pair.get("llm_score", pair.get("hybrid_score", 0))
        if llm_score < MIN_SCORE:
            continue

        rec = _recency_score(pair.get("posted_at"))
        rank_score = (llm_score / 100 * SCORE_WEIGHT) + (rec * RECENCY_WEIGHT)

        new_entries.append({
            "job_id":             pair["job_id"],
            "source":             pair["source"],
            "board_token":        pair.get("board_token", ""),
            "job_title":          pair["job_title"],
            "company":            pair["company"],
            "location":           pair["location"],
            "job_url":            pair["job_url"],
            "posted_at":          pair.get("posted_at"),
            "department":         pair.get("department", ""),
            "resume_id":          pair["resume_id"],
            "resume_name":        pair["resume_name"],
            "file_ext":           pair.get("file_ext", ""),
            "score":              llm_score,
            "llm_score":          llm_score,
            "llm_components":     pair.get("llm_components", {}),
            "llm_reasoning":      pair.get("llm_reasoning", ""),
            "llm_recommendation": pair.get("llm_recommendation", ""),
            "llm_key_strengths":  pair.get("llm_key_strengths", []),
            "llm_key_gaps":       pair.get("llm_key_gaps", []),
            "scoring_method":     pair.get("scoring_method", "hybrid_only"),
            "hybrid_score":       pair.get("hybrid_score", 0),
            "hybrid_components":  pair.get("hybrid_components", {}),
            "matched_skills":     pair.get("matched_skills", []),
            "missing_skills":     pair.get("missing_skills", []),
            "matched_preferred":  pair.get("matched_preferred", []),
            "coverage":           pair.get("coverage", {}),
            "critical_gaps":      pair.get("critical_gaps", []),
            "rank_score":         round(rank_score, 6),
            "recency_score":      round(rec, 4),
            "auto_matched":       True,
            "matched_at":         datetime.now(timezone.utc).isoformat(),
        })

    logger.info(f"[AutoMatch] user={user_id} {len(new_entries)} new entries after LLM scoring")

    # ── Step 11: Upsert new scored entries to DB ──────────────────────
    # Existing scored jobs are untouched in DB — only new jobs are written.
    await _save_results_to_db(user_id, new_entries, db)

    # ── Step 12: Load full result set from DB for response ────────────
    final = await _load_results_from_db(user_id, db, limit=STORE_CAP)

    # ── Step 13: Persist meta ─────────────────────────────────────────
    meta["last_fetch_at"] = datetime.now(timezone.utc).isoformat()
    _save_auto_meta_for_user(user_id, meta)

    llm_count = sum(1 for e in new_entries if e.get("scoring_method") == "llm+hybrid")
    logger.info(
        f"[AutoMatch] user={user_id} Complete: {len(new_entries)} new scored, "
        f"{len(final)} total in DB, showing top {DISPLAY_CAP}"
    )

    return {
        "matches": final[:DISPLAY_CAP],
        "stats": {
            "from_cache":    False,
            "total_pool":    len(raw_pool),
            "role_matched":  len(role_matched),
            "new_jobs":      len(truly_new),
            "batches":       num_batches,
            "phase1_jobs":   len(phase1_groups),
            "phase1_pairs":  total_pairs,
            "llm_scored":    llm_count,
            "new_processed": len(new_entries),
            "total_shown":   len(final[:DISPLAY_CAP]),
            "target_roles":  target_roles,
        },
        "from_cache": False,
    }