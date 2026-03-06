"""
services/auto_match.py — Fully automatic job discovery + matching pipeline.

Powers the "Auto Matches" tab on the Tracking page.

Job source: Greenhouse Job Board API (~80 curated tech companies)
  - Free, no API key required
  - Full job descriptions (critical for RACK scoring quality)
  - Real companies users actually want to work at
  - Fan out ~80 boards in parallel with asyncio semaphore

Design decisions:
  - NO hard 24h filter — goal is always 20 good matches, not "20 from today"
  - Recency as tiebreaker (15% of rank) — quality first, freshness nudges
  - seen_job_ids rolling dedup — never re-show a job once scored
  - Daily pool refresh (STALE_HOURS=24) — re-fetch once/day
  - LLM off for bulk speed — marginal gain vs latency not worth it

Ranking formula:
  rank_score = (raw_score × SCORE_WEIGHT) + (recency_score × RECENCY_WEIGHT)
  recency_score = 2^(-age_days / RECENCY_HALF_LIFE_DAYS)
  → Today = 1.0, 7 days ago = 0.5, 30 days ago ≈ 0.09

Pipeline steps:
  1. Load uploads/user_profile.json → get target_roles
  2. If pool stale or force=True → fan out ~80 Greenhouse boards in parallel
     - asyncio.gather with semaphore=MAX_CONCURRENT
     - Save raw pool → auto_job_pool.json
  3. Filter pool by target_role (ROLE_MATCH_RATIO word-overlap)
  4. Remove seen_job_ids
  5. If all seen → reset seen list (user gets fresh results automatically)
  6. Sort unseen by posted_at descending (score freshest first)
  7. Score each: match_resumes(desc, use_llm=False) → pick best resume
  8. Compute rank_score
  9. Merge with existing, sort by rank_score, keep top STORE_CAP
  10. Save → auto_match_results.json, update seen_job_ids in meta
  11. Return top DISPLAY_CAP
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

logger = logging.getLogger(__name__)

# ── Storage ──────────────────────────────────────────────────────────
WATCHLIST_DIR = os.path.join("uploads", "watchlist")
AUTO_RESULTS_PATH = os.path.join(WATCHLIST_DIR, "auto_match_results.json")
AUTO_META_PATH    = os.path.join(WATCHLIST_DIR, "auto_match_meta.json")
AUTO_POOL_PATH    = os.path.join(WATCHLIST_DIR, "auto_job_pool.json")

# ── Tunables ─────────────────────────────────────────────────────────
DISPLAY_CAP             = 20    # Jobs shown to user
STORE_CAP               = 50    # Jobs persisted in results file
SCORE_WEIGHT            = 0.85  # RACK match score weight in rank formula
RECENCY_WEIGHT          = 0.15  # Recency weight in rank formula
RECENCY_HALF_LIFE_DAYS  = 7     # Recency decay: 7 days → score halved
MIN_SCORE               = 30    # Min match % to surface a job
MIN_DESC_LEN            = 100   # Skip jobs with short descriptions
STALE_HOURS             = 24    # Pool refresh interval
MAX_CONCURRENT          = 15    # Parallel Greenhouse requests (semaphore)
SEEN_ID_CAP             = 2000  # Rolling cap on seen_job_ids list
ROLE_MATCH_RATIO        = 0.6   # Word overlap threshold for role filtering
FETCH_TIMEOUT           = 15.0  # Seconds per Greenhouse request

# ── Greenhouse company board tokens ──────────────────────────────────
# These are the URL tokens used in:
# https://boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true
# Curated ~80 real tech companies that use Greenhouse.
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
    """
    Check if a job title matches any of the user's target roles.
    Uses word-overlap ratio >= ROLE_MATCH_RATIO.
    """
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
    """
    Exponential decay: score = 2^(-age_days / half_life)
    Today = 1.0, 7 days ago = 0.5, 30 days ago ≈ 0.09
    No posted_at → 0.1 (neutral-low)
    """
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


# ── Storage helpers ───────────────────────────────────────────────────
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


def _load_auto_results() -> list:
    try:
        with open(AUTO_RESULTS_PATH) as f:
            return json.load(f)
    except Exception:
        return []


def _save_auto_results(results: list):
    os.makedirs(WATCHLIST_DIR, exist_ok=True)
    with open(AUTO_RESULTS_PATH, "w") as f:
        json.dump(results, f, indent=2)


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
    """For cache serving — are stored match results still fresh?"""
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


# ── Main pipeline ─────────────────────────────────────────────────────
async def run_auto_pipeline(force: bool = False) -> dict:
    """
    Main entry point for the Auto Matches tab.

    Returns:
        {
          "matches":    list of match entries (up to DISPLAY_CAP),
          "stats":      pipeline stats for UI toast,
          "from_cache": bool,
        }
    """
    from services.matcher import match_resumes

    # ── Load user profile ─────────────────────────────────────────────
    _profile_path = os.path.join("uploads", "user_profile.json")
    try:
        with open(_profile_path) as _f:
            profile = json.load(_f)
    except Exception:
        profile = {}

    meta = _load_auto_meta()

    # ── Serve cache if fresh and not forced ───────────────────────────
    if not force and not _is_results_stale(meta):
        logger.info("[AutoMatch] Cache fresh — returning stored results")
        stored = _load_auto_results()
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

    logger.info(f"[AutoMatch] Starting pipeline for roles: {target_roles}")

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
    logger.info(f"[AutoMatch] {len(role_matched)} jobs matched target roles from pool of {len(raw_pool)}")

    # ── Step 3: Remove already-seen jobs ─────────────────────────────
    seen_ids = set(meta.get("seen_job_ids", []))
    unseen = [j for j in role_matched if j["job_id"] not in seen_ids]
    logger.info(f"[AutoMatch] {len(unseen)} unseen jobs (filtered {len(role_matched) - len(unseen)} seen)")

    # If everything has been seen, reset so user gets fresh results
    if len(role_matched) > 0 and len(unseen) == 0:
        logger.info("[AutoMatch] All jobs seen — resetting seen_job_ids for fresh results")
        seen_ids = set()
        unseen = role_matched
        meta["seen_job_ids"] = []

    if not unseen:
        # No role-matched jobs at all in the pool
        existing = _load_auto_results()
        meta["last_fetch_at"] = datetime.now(timezone.utc).isoformat()
        _save_auto_meta(meta)
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

    # ── Step 4: Sort by recency (score freshest first) ────────────────
    def _posted_sort_key(j):
        try:
            dt = datetime.fromisoformat((j.get("posted_at") or "").replace("Z", "+00:00"))
            return dt
        except Exception:
            return datetime.min.replace(tzinfo=timezone.utc)

    unseen_sorted = sorted(unseen, key=_posted_sort_key, reverse=True)

    # ── Step 5: Score each candidate ─────────────────────────────────
    new_entries = []
    scored_count = 0

    for job in unseen_sorted:
        desc = job.get("description_text", "").strip()
        if len(desc) < MIN_DESC_LEN:
            continue

        try:
            result = await match_resumes(jd_text=desc, use_llm=False)
        except Exception as e:
            logger.error(f"[AutoMatch] Scoring error for '{job.get('title')}': {e}")
            continue

        scored_count += 1
        matches = result.get("results", [])
        if not matches:
            seen_ids.add(job["job_id"])  # mark seen even if no resume match
            continue

        best = max(matches, key=lambda m: m.get("raw_score", 0))
        raw_score = best.get("raw_score", 0)
        score_pct = round(raw_score * 100)

        if score_pct < MIN_SCORE:
            seen_ids.add(job["job_id"])
            continue

        # Compute recency-weighted rank score
        rec = _recency_score(job.get("posted_at"))
        rank_score = (raw_score * SCORE_WEIGHT) + (rec * RECENCY_WEIGHT)

        new_entries.append({
            "job_id":           job["job_id"],
            "source":           job["source"],
            "board_token":      job.get("board_token", ""),
            "job_title":        job["title"],
            "company":          job["company"],
            "location":         job.get("location", "Not specified"),
            "job_url":          job.get("url", ""),
            "posted_at":        job.get("posted_at"),
            "department":       job.get("department", ""),
            # Best resume
            "resume_id":        best.get("resume_id", ""),
            "resume_name":      best.get("name", ""),
            "file_ext":         best.get("file_ext", ""),
            # Scores
            "score":            score_pct,
            "raw_score":        raw_score,
            "rank_score":       round(rank_score, 6),
            "recency_score":    round(rec, 4),
            "components":       best.get("components", {}),
            "matched_skills":   best.get("matched_skills", []),
            "missing_skills":   best.get("missing_skills", []),
            "matched_preferred": best.get("matched_preferred", []),
            "coverage":         best.get("gap_analysis", {}).get("coverage", {}),
            "critical_gaps":    best.get("gap_analysis", {}).get("critical_gaps", []),
            # Meta
            "auto_matched":     True,
            "matched_at":       datetime.now(timezone.utc).isoformat(),
        })
        seen_ids.add(job["job_id"])

    logger.info(f"[AutoMatch] Scored {scored_count} jobs → {len(new_entries)} above {MIN_SCORE}% threshold")

    # ── Step 6: Merge with existing, sort by rank_score, keep top STORE_CAP ──
    existing = _load_auto_results()
    merged = {r["job_id"]: r for r in existing}
    for e in new_entries:
        merged[e["job_id"]] = e

    final = sorted(merged.values(), key=lambda x: x.get("rank_score", x.get("raw_score", 0)), reverse=True)
    final = final[:STORE_CAP]
    _save_auto_results(final)

    # ── Step 7: Persist meta ──────────────────────────────────────────
    # Cap seen_ids to avoid unbounded growth
    seen_list = list(seen_ids)
    if len(seen_list) > SEEN_ID_CAP:
        seen_list = seen_list[-SEEN_ID_CAP:]
    meta["seen_job_ids"] = seen_list
    meta["last_fetch_at"] = datetime.now(timezone.utc).isoformat()
    _save_auto_meta(meta)

    logger.info(f"[AutoMatch] Complete: {len(new_entries)} new, {len(final)} total stored, showing top {DISPLAY_CAP}")

    return {
        "matches": final[:DISPLAY_CAP],
        "stats": {
            "from_cache":    False,
            "total_pool":    len(raw_pool),
            "role_matched":  len(role_matched),
            "total_scored":  scored_count,
            "new_processed": len(new_entries),
            "total_shown":   len(final[:DISPLAY_CAP]),
            "target_roles":  target_roles,
        },
        "from_cache": False,
    }