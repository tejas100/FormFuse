"""
services/auto_match.py — Fully automatic job discovery + matching pipeline.

Powers the "Auto Matches" tab on the Tracking page.

Session 16: run_auto_pipeline() accepts db (AsyncSession) for pgvector search.
Session 20: Results and archive now stored in Supabase DB instead of JSON files.
  - _save_auto_results_for_user()  → upserts one snapshot row per run_date
  - _load_auto_results_for_user()  → reads most-recent snapshot from DB
  - archive_jobs_for_user()        → writes to archived_job_ids table
  - seen_job_ids still uses {user_id}_meta.json (low-stakes, migrate later)
"""

import asyncio
import json
import logging
import os
import hashlib
import re
import math
import httpx
from datetime import datetime, timezone, timedelta, date
from typing import Optional

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, delete, text
from sqlalchemy.dialects.postgresql import insert as pg_insert

logger = logging.getLogger(__name__)

# ── Storage ──────────────────────────────────────────────────────────
WATCHLIST_DIR = os.path.join("uploads", "watchlist")
AUTO_META_PATH    = os.path.join(WATCHLIST_DIR, "auto_match_meta.json")
AUTO_POOL_PATH    = os.path.join(WATCHLIST_DIR, "auto_job_pool.json")

# ── Tunables ─────────────────────────────────────────────────────────
DISPLAY_CAP             = 20
STORE_CAP               = 50
SCORE_WEIGHT            = 0.85
RECENCY_WEIGHT          = 0.15
RECENCY_HALF_LIFE_DAYS  = 7
MIN_SCORE               = 30
PHASE2_THRESHOLD        = 40
PHASE1_JOB_CAP          = 100
MIN_DESC_LEN            = 100
STALE_HOURS             = 24
MAX_CONCURRENT          = 15
SEEN_ID_CAP             = 2000
ROLE_MATCH_RATIO        = 0.6
FETCH_TIMEOUT           = 15.0

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


# ── Shared meta helpers (seen_ids still on disk — low stakes) ─────────
def _load_auto_meta() -> dict:
    try:
        with open(AUTO_META_PATH) as f:
            return json.load(f)
    except Exception:
        return {"last_fetch_at": None, "seen_job_ids": [], "last_pool_fetch_at": None}


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


# ── Per-user meta helpers (seen_ids on disk) ──────────────────────────
def _user_meta_path(user_id: str) -> str:
    return os.path.join(WATCHLIST_DIR, f"{user_id}_meta.json")


def _load_auto_meta_for_user(user_id: str) -> dict:
    try:
        with open(_user_meta_path(user_id)) as f:
            return json.load(f)
    except Exception:
        return {"last_fetch_at": None, "seen_job_ids": [], "last_pool_fetch_at": None}


def _save_auto_meta_for_user(user_id: str, meta: dict):
    os.makedirs(WATCHLIST_DIR, exist_ok=True)
    with open(_user_meta_path(user_id), "w") as f:
        json.dump(meta, f, indent=2)


# ── DB-backed result helpers ──────────────────────────────────────────

async def _save_snapshot_to_db(user_id: str, results: list, db: AsyncSession) -> None:
    """
    Upsert one snapshot row for today's date.
    ON CONFLICT (user_id, run_date) → update job_data in place.
    This means running the pipeline twice on the same day overwrites,
    not duplicates.
    """
    from models.orm import AutoMatchResult
    import uuid as _uuid

    today = date.today()
    user_uuid = _uuid.UUID(user_id)

    stmt = (
        pg_insert(AutoMatchResult)
        .values(
            id=_uuid.uuid4(),
            user_id=user_uuid,
            run_date=today,
            job_data=results,
            created_at=datetime.now(timezone.utc),
        )
        .on_conflict_do_update(
            constraint="uq_auto_match_user_run_date",
            set_={"job_data": results, "created_at": datetime.now(timezone.utc)},
        )
    )
    await db.execute(stmt)
    await db.commit()
    logger.info(f"[AutoMatch] user={user_id} Snapshot saved to DB for {today} ({len(results)} jobs)")


async def _load_snapshot_from_db(
    user_id: str,
    db: AsyncSession,
    run_date: Optional[date] = None,
) -> list:
    """
    Load job_data from a snapshot row.
    If run_date is None, returns the most recent snapshot.
    Archived job IDs are filtered out before returning.
    """
    from models.orm import AutoMatchResult, ArchivedJobId
    import uuid as _uuid

    user_uuid = _uuid.UUID(user_id)

    if run_date is not None:
        stmt = select(AutoMatchResult).where(
            AutoMatchResult.user_id == user_uuid,
            AutoMatchResult.run_date == run_date,
        )
    else:
        stmt = (
            select(AutoMatchResult)
            .where(AutoMatchResult.user_id == user_uuid)
            .order_by(AutoMatchResult.run_date.desc())
            .limit(1)
        )

    result = await db.execute(stmt)
    row = result.scalar_one_or_none()
    if row is None:
        return []

    # Filter out globally archived job IDs
    archived_stmt = select(ArchivedJobId.job_id).where(
        ArchivedJobId.user_id == user_uuid
    )
    archived_result = await db.execute(archived_stmt)
    archived_ids = {r[0] for r in archived_result.fetchall()}

    jobs = row.job_data or []
    return [j for j in jobs if j.get("job_id") not in archived_ids]


async def _get_run_dates_from_db(user_id: str, db: AsyncSession) -> list[str]:
    """Return all run_date values for this user, descending (newest first)."""
    from models.orm import AutoMatchResult
    import uuid as _uuid

    user_uuid = _uuid.UUID(user_id)
    stmt = (
        select(AutoMatchResult.run_date)
        .where(AutoMatchResult.user_id == user_uuid)
        .order_by(AutoMatchResult.run_date.desc())
    )
    result = await db.execute(stmt)
    return [str(row[0]) for row in result.fetchall()]


async def archive_jobs_for_user(
    user_id: str,
    job_ids: list[str],
    db: AsyncSession,
) -> dict:
    """
    Write job_ids to the archived_job_ids DB table.
    These IDs will be filtered from all future snapshot reads.
    """
    from models.orm import ArchivedJobId
    import uuid as _uuid

    if not job_ids:
        return {"archived": 0}

    user_uuid = _uuid.UUID(user_id)
    now = datetime.now(timezone.utc)

    # INSERT … ON CONFLICT DO NOTHING (idempotent)
    for jid in job_ids:
        stmt = (
            pg_insert(ArchivedJobId)
            .values(user_id=user_uuid, job_id=jid, archived_at=now)
            .on_conflict_do_nothing(constraint="pk_archived_job_ids")
        )
        await db.execute(stmt)

    await db.commit()
    logger.info(f"[AutoMatch] user={user_id} Archived {len(job_ids)} job(s) to DB")
    return {"archived": len(job_ids)}


# ── Compatibility shim — kept for any callers that haven't been updated ─
# These are the old JSON-file versions. They still work for non-DB flows.
def _load_auto_results_for_user(user_id: str) -> list:
    """Legacy JSON read — used only by old tracking.py endpoints still on disk."""
    results_path = os.path.join(WATCHLIST_DIR, f"{user_id}_results.json")
    try:
        with open(results_path) as f:
            return json.load(f)
    except Exception:
        return []


# ── Job pool helpers (unchanged) ──────────────────────────────────────
def _load_archived_ids_for_user(user_id: str) -> set:
    """Legacy — reads archived IDs from meta JSON. Used during pipeline only."""
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
    Main entry point for the Auto Matches tab.

    Args:
        user_id:  Authenticated user's UUID (scopes vector search + storage).
        profile:  User's preferences dict from DB (target_roles, etc.)
        force:    If True, bypass cache and re-run the full pipeline.
        db:       AsyncSession — required for pgvector search AND result storage.
    """
    from services.matcher import match_resumes
    from services.llm_scorer import llm_score_jobs_grouped

    meta = _load_auto_meta_for_user(user_id)

    # ── Serve cache if fresh and not forced ───────────────────────────
    if not force and not _is_results_stale(meta):
        logger.info(f"[AutoMatch] user={user_id} Cache fresh — returning stored results")
        stored = await _load_snapshot_from_db(user_id, db)
        return {
            "matches": stored[:DISPLAY_CAP],
            "stats": {
                "from_cache": True,
                "last_fetch_at": meta.get("last_fetch_at"),
                "total_shown": len(stored[:DISPLAY_CAP]),
            },
            "from_cache": True,
        }

    # ── Validate profile ──────────────────────────────────────────────
    target_roles = profile.get("target_roles", [])
    if not target_roles:
        return {
            "matches": [],
            "stats": {
                "error": "no_profile",
                "message": "Set target roles in Account → Profile to enable Auto Matches.",
            },
            "from_cache": False,
        }

    logger.info(f"[AutoMatch] user={user_id} Starting pipeline for roles: {target_roles}")

    # ── Step 1: Refresh job pool if stale or forced ───────────────────
    if force or _is_pool_stale(meta):
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

        logger.info(f"[AutoMatch] Pool: {len(raw_pool)} jobs from {len(GREENHOUSE_COMPANIES) - failed} boards ({failed} failed)")
        _save_job_pool(raw_pool)
        meta["last_pool_fetch_at"] = datetime.now(timezone.utc).isoformat()
    else:
        logger.info("[AutoMatch] Pool fresh — loading from cache")
        raw_pool = _load_job_pool()

    # ── Step 2: Filter by target role ────────────────────────────────
    role_matched = [
        j for j in raw_pool
        if _role_matches_title(j["title"], target_roles)
    ]
    logger.info(f"[AutoMatch] user={user_id} {len(role_matched)} jobs matched target roles from pool of {len(raw_pool)}")

    # ── Step 2b: Filter by preferred locations ───────────────────────
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
            f"({before - len(role_matched)} excluded) "
            f"prefs={preferred_locations}"
        )

    # ── Step 3: Remove already-seen and permanently-archived jobs ────
    # seen_ids: still from meta JSON (fine — just a display optimization)
    # archived_ids: now from DB
    seen_ids = set(meta.get("seen_job_ids", []))

    # Load archived IDs from DB
    from models.orm import ArchivedJobId
    import uuid as _uuid
    user_uuid = _uuid.UUID(user_id)
    archived_stmt = select(ArchivedJobId.job_id).where(
        ArchivedJobId.user_id == user_uuid
    )
    archived_result = await db.execute(archived_stmt)
    archived_ids = {r[0] for r in archived_result.fetchall()}

    non_archived = [j for j in role_matched if j["job_id"] not in archived_ids]
    unseen       = [j for j in non_archived  if j["job_id"] not in seen_ids]

    logger.info(
        f"[AutoMatch] user={user_id} {len(unseen)} unseen jobs "
        f"(filtered {len(role_matched) - len(non_archived)} archived, "
        f"{len(non_archived) - len(unseen)} seen)"
    )

    if len(non_archived) > 0 and len(unseen) == 0:
        logger.info(f"[AutoMatch] user={user_id} All non-archived jobs seen — resetting seen_job_ids for fresh cycle")
        seen_ids = set()
        unseen = non_archived
        meta["seen_job_ids"] = []

    if not unseen:
        existing = await _load_snapshot_from_db(user_id, db)
        meta["last_fetch_at"] = datetime.now(timezone.utc).isoformat()
        _save_auto_meta_for_user(user_id, meta)
        return {
            "matches": existing[:DISPLAY_CAP],
            "stats": {
                "from_cache": False,
                "total_pool": len(raw_pool),
                "role_matched": len(role_matched),
                "new_processed": 0,
                "message": "No matching jobs found in pool. Try broadening your target roles.",
            },
            "from_cache": False,
        }

    # ── Step 4: Sort by recency ───────────────────────────────────────
    def _posted_sort_key(j):
        try:
            dt = datetime.fromisoformat((j.get("posted_at") or "").replace("Z", "+00:00"))
            return dt
        except Exception:
            return datetime.min.replace(tzinfo=timezone.utc)

    unseen_sorted = sorted(unseen, key=_posted_sort_key, reverse=True)

    if len(unseen_sorted) > PHASE1_JOB_CAP:
        logger.info(
            f"[AutoMatch] Capping Phase 1 to {PHASE1_JOB_CAP} most-recent jobs "
            f"({len(unseen_sorted) - PHASE1_JOB_CAP} deferred to next run)"
        )
        unseen_sorted = unseen_sorted[:PHASE1_JOB_CAP]

    # ── Step 5: Phase 1 — pgvector + Hybrid scoring ───────────────────
    phase1_groups: dict[str, list] = {}
    scored_count  = 0
    parsed_jd_cache = {}

    logger.info(f"[AutoMatch] user={user_id} Phase 1: scoring {len(unseen_sorted)} jobs with hybrid scorer…")

    for job in unseen_sorted:
        desc = job.get("description_text", "").strip()
        if len(desc) < MIN_DESC_LEN:
            seen_ids.add(job["job_id"])
            continue

        try:
            result = await match_resumes(
                jd_text=desc,
                user_id=user_id,
                use_llm=False,
                db=db,
            )
        except Exception as e:
            logger.error(f"[AutoMatch] Phase 1 scoring error for '{job.get('title')}': {e}")
            continue

        scored_count += 1
        matches = result.get("results", [])
        parsed_jd = result.get("jd_parsed", {})
        parsed_jd_cache[job["job_id"]] = parsed_jd

        if not matches:
            seen_ids.add(job["job_id"])
            continue

        qualifying = [
            m for m in matches
            if round(m.get("raw_score", 0) * 100) >= PHASE2_THRESHOLD
        ]

        if not qualifying:
            seen_ids.add(job["job_id"])
            continue

        job_entries = []
        for resume_match in qualifying:
            hybrid_score = round(resume_match.get("raw_score", 0) * 100)
            resume_id = resume_match.get("resume_id", "")

            job_entries.append({
                # Job context
                "job_id":          job["job_id"],
                "job_title":       job["title"],
                "company":         job["company"],
                "location":        job.get("location", "Not specified"),
                "job_url":         job.get("url", ""),
                "source":          job["source"],
                "board_token":     job.get("board_token", ""),
                "posted_at":       job.get("posted_at"),
                "department":      job.get("department", ""),
                # Resume context
                "resume_id":       resume_id,
                "resume_name":     resume_match.get("name", ""),
                "file_ext":        resume_match.get("file_ext", ""),
                # Hybrid scores (Phase 1)
                "hybrid_score":    hybrid_score,
                "hybrid_raw":      resume_match.get("raw_score", 0),
                "hybrid_components": resume_match.get("components", {}),
                "matched_skills":  resume_match.get("matched_skills", []),
                "missing_skills":  resume_match.get("missing_skills", []),
                "matched_preferred": resume_match.get("matched_preferred", []),
                "coverage":        resume_match.get("gap_analysis", {}).get("coverage", {}),
                "critical_gaps":   resume_match.get("gap_analysis", {}).get("critical_gaps", []),
                # Phase 2 inputs
                "job":             job,
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
                "parsed_jd":       parsed_jd,
            })

        if job_entries:
            phase1_groups[job["job_id"]] = job_entries

        seen_ids.add(job["job_id"])

    total_pairs = sum(len(v) for v in phase1_groups.values())
    logger.info(
        f"[AutoMatch] user={user_id} Phase 1 complete: {scored_count} jobs scored → "
        f"{len(phase1_groups)} jobs with qualifying resumes ({total_pairs} pairs total)"
    )

    # ── Step 6: Phase 2 — LLM deep scoring ───────────────────────────
    logger.info(
        f"[AutoMatch] user={user_id} Phase 2: LLM scoring {len(phase1_groups)} jobs "
        f"({total_pairs} resume pairs)"
    )

    llm_scored_groups = await llm_score_jobs_grouped(phase1_groups)

    # ── Step 7: Per job, pick best LLM-scored resume ──────────────────
    by_job: dict[str, dict] = {}
    for job_id, entries in llm_scored_groups.items():
        best = max(entries, key=lambda e: e.get("llm_score", 0))
        by_job[job_id] = best

    # ── Step 8: Build final entries with rank_score ───────────────────
    new_entries = []
    for jid, pair in by_job.items():
        llm_score = pair.get("llm_score", pair.get("hybrid_score", 0))

        if llm_score < MIN_SCORE:
            continue

        rec = _recency_score(pair.get("posted_at"))
        rank_score = (llm_score / 100 * SCORE_WEIGHT) + (rec * RECENCY_WEIGHT)

        new_entries.append({
            "job_id":          pair["job_id"],
            "source":          pair["source"],
            "board_token":     pair.get("board_token", ""),
            "job_title":       pair["job_title"],
            "company":         pair["company"],
            "location":        pair["location"],
            "job_url":         pair["job_url"],
            "posted_at":       pair.get("posted_at"),
            "department":      pair.get("department", ""),
            "resume_id":       pair["resume_id"],
            "resume_name":     pair["resume_name"],
            "file_ext":        pair.get("file_ext", ""),
            "score":           llm_score,
            "llm_score":       llm_score,
            "llm_components":  pair.get("llm_components", {}),
            "llm_reasoning":   pair.get("llm_reasoning", ""),
            "llm_recommendation": pair.get("llm_recommendation", ""),
            "llm_key_strengths": pair.get("llm_key_strengths", []),
            "llm_key_gaps":    pair.get("llm_key_gaps", []),
            "scoring_method":  pair.get("scoring_method", "hybrid_only"),
            "hybrid_score":    pair.get("hybrid_score", 0),
            "hybrid_components": pair.get("hybrid_components", {}),
            "matched_skills":  pair.get("matched_skills", []),
            "missing_skills":  pair.get("missing_skills", []),
            "matched_preferred": pair.get("matched_preferred", []),
            "coverage":        pair.get("coverage", {}),
            "critical_gaps":   pair.get("critical_gaps", []),
            "rank_score":      round(rank_score, 6),
            "recency_score":   round(rec, 4),
            "auto_matched":    True,
            "matched_at":      datetime.now(timezone.utc).isoformat(),
        })

    logger.info(f"[AutoMatch] user={user_id} Phase 2 complete: {len(new_entries)} final entries after LLM scoring")

    # ── Step 9: Merge with most-recent snapshot, sort, keep top STORE_CAP ──
    existing = await _load_snapshot_from_db(user_id, db)
    merged = {r["job_id"]: r for r in existing}
    for e in new_entries:
        merged[e["job_id"]] = e

    final = sorted(merged.values(), key=lambda x: x.get("rank_score", 0), reverse=True)
    final = final[:STORE_CAP]

    # Save to DB (upsert today's snapshot)
    await _save_snapshot_to_db(user_id, final, db)

    # ── Step 10: Persist meta ─────────────────────────────────────────
    seen_list = list(seen_ids)
    if len(seen_list) > SEEN_ID_CAP:
        seen_list = seen_list[-SEEN_ID_CAP:]
    meta["seen_job_ids"] = seen_list
    meta["last_fetch_at"] = datetime.now(timezone.utc).isoformat()
    _save_auto_meta_for_user(user_id, meta)

    llm_count = sum(1 for e in new_entries if e.get("scoring_method") == "llm+hybrid")
    logger.info(
        f"[AutoMatch] user={user_id} Complete: {len(new_entries)} new entries "
        f"({llm_count} LLM-scored), {len(final)} total stored, showing top {DISPLAY_CAP}"
    )

    return {
        "matches": final[:DISPLAY_CAP],
        "stats": {
            "from_cache":       False,
            "total_pool":       len(raw_pool),
            "role_matched":     len(role_matched),
            "phase1_jobs":      len(phase1_groups),
            "phase1_pairs":     total_pairs,
            "llm_scored":       llm_count,
            "new_processed":    len(new_entries),
            "total_shown":      len(final[:DISPLAY_CAP]),
            "target_roles":     target_roles,
        },
        "from_cache": False,
    }