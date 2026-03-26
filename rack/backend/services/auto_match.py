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
  - force=True bypasses results cache but does NOT re-fetch Greenhouse pool
"""

import asyncio
import json
import logging
import os
import hashlib
import re
import math
import httpx
from datetime import datetime, timezone, timedelta
from typing import Optional

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert

logger = logging.getLogger(__name__)

# ── Storage ──────────────────────────────────────────────────────────
WATCHLIST_DIR  = os.path.join("uploads", "watchlist")
AUTO_META_PATH = os.path.join(WATCHLIST_DIR, "auto_match_meta.json")
AUTO_POOL_PATH = os.path.join(WATCHLIST_DIR, "auto_job_pool.json")

# ── Tunables ─────────────────────────────────────────────────────────
DISPLAY_CAP            = 50
STORE_CAP              = 90
SCORE_WEIGHT           = 0.85
RECENCY_WEIGHT         = 0.15
RECENCY_HALF_LIFE_DAYS = 7
MIN_SCORE              = 30
PHASE2_THRESHOLD       = 40
PHASE1_JOB_CAP         = 100
MIN_DESC_LEN           = 100
STALE_HOURS            = 24
MAX_CONCURRENT         = 15
ROLE_MATCH_RATIO       = 0.6
FETCH_TIMEOUT          = 15.0

# ── Greenhouse company board tokens ──────────────────────────────────
GREENHOUSE_COMPANIES = [
    # AI / ML
    "anthropic", "openai", "cohere", "mistral", "perplexity-ai",
    "scale-ai", "weightsandbiases", "huggingface", "pinecone", "weaviate",
    "modal", "anyscale", "togetherai", "langchain", "deepgram",
    "assemblyai", "elevenlabs", "runwayml", "characterai", "adept",
    "cognition",
    # Fintech
    "stripe", "ramp", "brex", "plaid", "coinbase",
    "robinhood", "rippling", "mercury", "chime", "marqeta",
    # DevTools / Productivity
    "figma", "notion", "linear", "vercel", "supabase",
    "retool", "replit", "sentry", "posthog", "launchdarkly",
    "statsig", "grafana", "hashicorp", "temporal", "neon",
    "render",
    # Data / Analytics
    "datadog", "snowflake", "dbt-labs", "airbyte", "fivetran",
    "dagster", "prefect", "amplitude", "mixpanel", "hex",
    "cockroachlabs",
    # Cloud / Infra
    "cloudflare", "elastic", "mongodb",
    # Other tech
    "shopify", "twilio", "sendgrid", "segment", "snyk",
    "lacework", "wiz", "benchling", "census", "eppo",
    "descript", "loom", "coda", "airtable", "miro",
]


# ── Job ID helpers ────────────────────────────────────────────────────
def _make_job_id(board_token: str, external_id: str) -> str:
    raw = f"greenhouse:{board_token}:{external_id}"
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def _strip_html(html: str) -> str:
    text = re.sub(r"<[^>]+>", " ", html)
    return re.sub(r"\s+", " ", text).strip()


# ── Greenhouse fetcher ────────────────────────────────────────────────
async def _fetch_greenhouse(board_token: str, semaphore: asyncio.Semaphore) -> list[dict]:
    """Fetch all open jobs from a single Greenhouse board."""
    url = f"https://boards-api.greenhouse.io/v1/boards/{board_token}/jobs?content=true"
    async with semaphore:
        try:
            async with httpx.AsyncClient(timeout=FETCH_TIMEOUT) as client:
                resp = await client.get(url)
                if resp.status_code == 404:
                    logger.debug(f"[Greenhouse] 404 for board: {board_token}")
                    return []
                resp.raise_for_status()
                data = resp.json()
        except httpx.HTTPStatusError as e:
            logger.warning(f"[Greenhouse] {board_token} HTTP {e.response.status_code}")
            return []
        except Exception as e:
            logger.warning(f"[Greenhouse] {board_token} error: {e}")
            return []

    jobs = []
    for j in data.get("jobs", []):
        desc_html = j.get("content", "")
        desc_text = _strip_html(desc_html)

        loc = ""
        loc_obj = j.get("location", {})
        if isinstance(loc_obj, dict):
            loc = loc_obj.get("name", "")

        dept = ""
        depts = j.get("departments", [])
        if depts and isinstance(depts[0], dict):
            dept = depts[0].get("name", "")

        posted = j.get("updated_at") or j.get("created_at")

        jobs.append({
            "job_id":           _make_job_id(board_token, str(j["id"])),
            "source":           "greenhouse",
            "external_id":      str(j["id"]),
            "board_token":      board_token,
            "title":            j.get("title", "Unknown").strip(),
            "company":          board_token,
            "location":         loc or "Not specified",
            "url":              j.get("absolute_url", ""),
            "description_text": desc_text,
            "posted_at":        posted,
            "department":       dept,
            "fetched_at":       datetime.now(timezone.utc).isoformat(),
        })

    logger.info(f"[Greenhouse] {board_token}: {len(jobs)} jobs")
    return jobs


# ── Role matching ─────────────────────────────────────────────────────
def _role_matches_title(title: str, target_roles: list[str]) -> bool:
    title_words = set(re.split(r"[\s\-/,]+", title.lower()))
    title_words = {w for w in title_words if len(w) > 1}

    for role in target_roles:
        role_words = set(re.split(r"[\s\-/,]+", role.lower()))
        role_words = {w for w in role_words if len(w) > 1}
        if not role_words:
            continue
        overlap = len(title_words & role_words) / len(role_words)
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


# ── Shared meta helpers (pool staleness on disk) ──────────────────────
def _load_auto_meta() -> dict:
    try:
        with open(AUTO_META_PATH) as f:
            return json.load(f)
    except Exception:
        return {"last_fetch_at": None, "last_pool_fetch_at": None}


def _save_auto_meta(meta: dict):
    os.makedirs(WATCHLIST_DIR, exist_ok=True)
    with open(AUTO_META_PATH, "w") as f:
        json.dump(meta, f, indent=2)


def _load_job_pool() -> list:
    try:
        with open(AUTO_POOL_PATH) as f:
            return json.load(f)
    except Exception:
        return []


def _save_job_pool(pool: list):
    os.makedirs(WATCHLIST_DIR, exist_ok=True)
    with open(AUTO_POOL_PATH, "w") as f:
        json.dump(pool, f, indent=2)


def _is_pool_stale(meta: dict) -> bool:
    last = meta.get("last_pool_fetch_at")
    if not last:
        return True
    try:
        last_dt = datetime.fromisoformat(last)
        if last_dt.tzinfo is None:
            last_dt = last_dt.replace(tzinfo=timezone.utc)
        return (datetime.now(timezone.utc) - last_dt) > timedelta(hours=STALE_HOURS)
    except Exception:
        return True


def _is_results_stale(meta: dict) -> bool:
    last = meta.get("last_fetch_at")
    if not last:
        return True
    try:
        last_dt = datetime.fromisoformat(last)
        if last_dt.tzinfo is None:
            last_dt = last_dt.replace(tzinfo=timezone.utc)
        return (datetime.now(timezone.utc) - last_dt) > timedelta(hours=STALE_HOURS)
    except Exception:
        return True


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
    if not force and not _is_results_stale(meta):
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

    # ── Step 1: Refresh job pool only if stale (≥24h) ────────────────
    # force=True does NOT trigger a pool re-fetch — only staleness does.
    if _is_pool_stale(meta):
        logger.info(f"[AutoMatch] Fetching job pool from {len(GREENHOUSE_COMPANIES)} Greenhouse boards…")
        semaphore = asyncio.Semaphore(MAX_CONCURRENT)
        tasks = [_fetch_greenhouse(token, semaphore) for token in GREENHOUSE_COMPANIES]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        raw_pool = []
        failed = 0
        for r in results:
            if isinstance(r, Exception):
                failed += 1
            elif isinstance(r, list):
                raw_pool.extend(r)

        logger.info(f"[AutoMatch] Pool: {len(raw_pool)} jobs fetched ({failed} boards failed)")
        _save_job_pool(raw_pool)
        meta["last_pool_fetch_at"] = datetime.now(timezone.utc).isoformat()
    else:
        logger.info("[AutoMatch] Pool fresh — loading from disk cache")
        raw_pool = _load_job_pool()

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
    role_matched = [
        j for j in raw_pool
        if _role_matches_title(j["title"], target_roles)
    ]
    logger.info(
        f"[AutoMatch] user={user_id} {len(role_matched)} jobs matched target roles "
        f"from pool of {len(raw_pool)}"
    )

    # ── Step 4: Location filter ───────────────────────────────────────
    preferred_locations = profile.get("preferred_locations", [])
    if preferred_locations:
        from services.user_profile import matches_any_preferred_location
        before = len(role_matched)
        role_matched = [
            j for j in role_matched
            if matches_any_preferred_location(j.get("location", ""), preferred_locations)
        ]
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

    # ── Step 6: Sort new jobs by recency, cap to PHASE1_JOB_CAP ──────
    def _posted_sort_key(j):
        try:
            return datetime.fromisoformat((j.get("posted_at") or "").replace("Z", "+00:00"))
        except Exception:
            return datetime.min.replace(tzinfo=timezone.utc)

    new_sorted = sorted(truly_new, key=_posted_sort_key, reverse=True)

    if len(new_sorted) > PHASE1_JOB_CAP:
        logger.info(
            f"[AutoMatch] Capping Phase 1 to {PHASE1_JOB_CAP} most-recent new jobs "
            f"({len(new_sorted) - PHASE1_JOB_CAP} deferred to next run)"
        )
        new_sorted = new_sorted[:PHASE1_JOB_CAP]

    # ── Mark all new_sorted jobs as seen BEFORE Phase 1 ──────────────
    # Insert now — not after scoring — so jobs that fail Phase 1 or score
    # below MIN_SCORE are still recorded and never retried on future runs.
    await _mark_jobs_seen(user_uuid, [j["job_id"] for j in new_sorted], db)

    # ── Step 7: Phase 1 — pgvector + Hybrid scoring ───────────────────
    phase1_groups: dict[str, list] = {}
    parsed_jd_cache: dict[str, dict] = {}
    scored_count = 0

    logger.info(f"[AutoMatch] user={user_id} Phase 1: scoring {len(new_sorted)} new jobs…")

    for job in new_sorted:
        desc = job.get("description_text", "").strip()
        if len(desc) < MIN_DESC_LEN:
            continue

        try:
            result = await match_resumes(
                jd_text=desc,
                user_id=user_id,
                use_llm=False,
                db=db,
            )
        except Exception as e:
            logger.error(f"[AutoMatch] Phase 1 error for '{job.get('title')}': {e}")
            continue

        scored_count += 1
        matches = result.get("results", [])
        parsed_jd = result.get("jd_parsed", {})
        parsed_jd_cache[job["job_id"]] = parsed_jd

        if not matches:
            continue

        qualifying = [
            m for m in matches
            if round(m.get("raw_score", 0) * 100) >= PHASE2_THRESHOLD
        ]
        if not qualifying:
            continue

        job_entries = []
        for resume_match in qualifying:
            hybrid_score = round(resume_match.get("raw_score", 0) * 100)
            resume_id = resume_match.get("resume_id", "")

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

        if job_entries:
            phase1_groups[job["job_id"]] = job_entries

    total_pairs = sum(len(v) for v in phase1_groups.values())
    logger.info(
        f"[AutoMatch] user={user_id} Phase 1 complete: {scored_count} scored → "
        f"{len(phase1_groups)} qualifying jobs ({total_pairs} pairs)"
    )

    # ── Step 8: Phase 2 — LLM deep scoring ───────────────────────────
    logger.info(f"[AutoMatch] user={user_id} Phase 2: LLM scoring {len(phase1_groups)} jobs…")
    llm_scored_groups = await llm_score_jobs_grouped(phase1_groups)

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
            "phase1_jobs":   len(phase1_groups),
            "phase1_pairs":  total_pairs,
            "llm_scored":    llm_count,
            "new_processed": len(new_entries),
            "total_shown":   len(final[:DISPLAY_CAP]),
            "target_roles":  target_roles,
        },
        "from_cache": False,
    }