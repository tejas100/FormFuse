"""
services/auto_match.py — Fully automatic job discovery + matching pipeline.

Powers the "Auto Matches" tab on the Tracking page.

Job source: Greenhouse Job Board API (~80 curated tech companies)
  - Free, no API key required
  - Full job descriptions (critical for RACK scoring quality)
  - Real companies users actually want to work at
  - Fan out ~80 boards in parallel with asyncio semaphore

Two-phase scoring pipeline:
  Phase 1 — FAISS + Hybrid scorer (existing, fast, use_llm=False)
    → Filters 150-200 Greenhouse jobs down to qualifying (job × resume) pairs
    → All resumes scored per job, pairs above PHASE2_THRESHOLD kept
    → Fast: no LLM calls, runs in seconds

  Phase 2 — LLM Deep Scorer (new, accurate, concurrent)
    → Each qualifying (job × resume) pair sent to GPT-4o-mini
    → Holistic scoring: skills_fit + experience_fit + trajectory_fit
    → Returns reasoning + recommendation + key strengths/gaps
    → Concurrent: up to 8 calls at once, ~25-40s for 30-50 pairs
    → Graceful fallback: if LLM fails, hybrid score kept

Ranking formula (post Phase 2):
  rank_score = (llm_score × SCORE_WEIGHT) + (recency_score × RECENCY_WEIGHT)
  recency_score = 2^(-age_days / RECENCY_HALF_LIFE_DAYS)
  → Today = 1.0, 7 days ago = 0.5, 30 days ago ≈ 0.09

Pipeline steps:
  1.  Load uploads/user_profile.json → get target_roles
  2.  If pool stale or force=True → fan out ~80 Greenhouse boards in parallel
  3.  Filter pool by target_role (ROLE_MATCH_RATIO word-overlap on title)
  4.  Remove seen_job_ids
  5.  If all seen → reset seen list
  6.  Sort unseen by posted_at descending
  7.  Phase 1: match_resumes(desc, use_llm=False) for each job → collect ALL
      resumes above PHASE2_THRESHOLD per job (not just the best one)
  8.  Phase 2: LLM deep score all qualifying (job × resume) pairs concurrently
  9.  Per job: pick best LLM-scored resume as the display entry
  10. Compute rank_score using llm_score
  11. Merge with existing, sort by rank_score, keep top STORE_CAP
  12. Save → auto_match_results.json, update seen_job_ids in meta
  13. Return top DISPLAY_CAP
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
SCORE_WEIGHT            = 0.85  # LLM score weight in rank formula
RECENCY_WEIGHT          = 0.15  # Recency weight in rank formula
RECENCY_HALF_LIFE_DAYS  = 7     # Recency decay: 7 days → score halved
MIN_SCORE               = 30    # Min hybrid % to even attempt LLM scoring
PHASE2_THRESHOLD        = 60    # Min hybrid % to qualify for Phase 2 LLM scoring
                                 # 45% → ~2500 pairs (way too many)
                                 # 55% → ~165 pairs (still scores weak matches)
                                 # 60% → ~40-80 pairs (only genuine candidates)
PHASE1_JOB_CAP          = 100   # Max jobs scored per refresh. Prevents 580-job blowouts
                                 # on first run. Sorted by recency — newest jobs first.
                                 # Remaining jobs are picked up on next refresh.
MIN_DESC_LEN            = 100   # Skip jobs with short descriptions
STALE_HOURS             = 24    # Pool refresh interval
MAX_CONCURRENT          = 15    # Parallel Greenhouse requests (semaphore)
SEEN_ID_CAP             = 2000  # Rolling cap on seen_job_ids list
ROLE_MATCH_RATIO        = 0.6   # Word overlap threshold for role filtering
FETCH_TIMEOUT           = 15.0  # Seconds per Greenhouse request

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
    from services.ingestion import get_resume_by_id
    from services.llm_scorer import llm_score_batch, rerank_by_llm_score

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

    if len(role_matched) > 0 and len(unseen) == 0:
        logger.info("[AutoMatch] All jobs seen — resetting seen_job_ids for fresh results")
        seen_ids = set()
        unseen = role_matched
        meta["seen_job_ids"] = []

    if not unseen:
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

    # ── Step 4: Sort by recency ───────────────────────────────────────
    def _posted_sort_key(j):
        try:
            dt = datetime.fromisoformat((j.get("posted_at") or "").replace("Z", "+00:00"))
            return dt
        except Exception:
            return datetime.min.replace(tzinfo=timezone.utc)

    unseen_sorted = sorted(unseen, key=_posted_sort_key, reverse=True)

    # Cap Phase 1 to newest N jobs — prevents first-run / reset from scoring
    # 500+ jobs at once and generating thousands of LLM pairs.
    if len(unseen_sorted) > PHASE1_JOB_CAP:
        logger.info(
            f"[AutoMatch] Capping Phase 1 to {PHASE1_JOB_CAP} most-recent jobs "
            f"({len(unseen_sorted) - PHASE1_JOB_CAP} deferred to next run)"
        )
        unseen_sorted = unseen_sorted[:PHASE1_JOB_CAP]

    # ── Step 5: Phase 1 — FAISS + Hybrid scoring ─────────────────────
    # Score ALL resumes per job, collect pairs above PHASE2_THRESHOLD
    phase1_pairs = []    # (job × resume) pairs qualifying for Phase 2
    scored_count  = 0
    parsed_jd_cache = {}  # job_id → parsed_jd (reused in Phase 2)

    logger.info(f"[AutoMatch] Phase 1: scoring {len(unseen_sorted)} jobs with hybrid scorer…")

    for job in unseen_sorted:
        desc = job.get("description_text", "").strip()
        if len(desc) < MIN_DESC_LEN:
            seen_ids.add(job["job_id"])
            continue

        try:
            result = await match_resumes(jd_text=desc, use_llm=False)
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

        # Collect ALL resumes above PHASE2_THRESHOLD for this job
        qualifying = [
            m for m in matches
            if round(m.get("raw_score", 0) * 100) >= PHASE2_THRESHOLD
        ]

        if not qualifying:
            # Best resume still below threshold — skip job entirely
            seen_ids.add(job["job_id"])
            continue

        # Build pair entries for Phase 2
        for resume_match in qualifying:
            hybrid_score = round(resume_match.get("raw_score", 0) * 100)
            resume_id = resume_match.get("resume_id", "")
            full_resume = get_resume_by_id(resume_id)
            if not full_resume:
                continue

            phase1_pairs.append({
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
                "resume":          full_resume,
                "parsed_jd":       parsed_jd,
            })

        seen_ids.add(job["job_id"])

    logger.info(f"[AutoMatch] Phase 1 complete: {scored_count} jobs scored → {len(phase1_pairs)} pairs qualify for Phase 2")

    # ── Step 6: Phase 2 — LLM deep scoring ───────────────────────────
    logger.info(f"[AutoMatch] Phase 2: LLM scoring {len(phase1_pairs)} (job × resume) pairs…")

    llm_scored_pairs = await llm_score_batch(phase1_pairs)

    # ── Step 7: Per job, pick best LLM-scored resume ──────────────────
    # Group by job_id, pick the pair with highest llm_score
    by_job: dict[str, dict] = {}
    for pair in llm_scored_pairs:
        jid = pair["job_id"]
        if jid not in by_job or pair.get("llm_score", 0) > by_job[jid].get("llm_score", 0):
            by_job[jid] = pair

    # ── Step 8: Build final entries with rank_score ───────────────────
    new_entries = []
    for jid, pair in by_job.items():
        llm_score = pair.get("llm_score", pair.get("hybrid_score", 0))

        # Guard: if llm_score is still below MIN_SCORE, skip
        if llm_score < MIN_SCORE:
            continue

        rec = _recency_score(pair.get("posted_at"))
        rank_score = (llm_score / 100 * SCORE_WEIGHT) + (rec * RECENCY_WEIGHT)

        new_entries.append({
            # Job info
            "job_id":          pair["job_id"],
            "source":          pair["source"],
            "board_token":     pair.get("board_token", ""),
            "job_title":       pair["job_title"],
            "company":         pair["company"],
            "location":        pair["location"],
            "job_url":         pair["job_url"],
            "posted_at":       pair.get("posted_at"),
            "department":      pair.get("department", ""),
            # Best resume
            "resume_id":       pair["resume_id"],
            "resume_name":     pair["resume_name"],
            "file_ext":        pair.get("file_ext", ""),
            # Primary score — LLM (what the UI shows prominently)
            "score":           llm_score,
            "llm_score":       llm_score,
            "llm_components":  pair.get("llm_components", {}),
            "llm_reasoning":   pair.get("llm_reasoning", ""),
            "llm_recommendation": pair.get("llm_recommendation", ""),
            "llm_key_strengths": pair.get("llm_key_strengths", []),
            "llm_key_gaps":    pair.get("llm_key_gaps", []),
            "scoring_method":  pair.get("scoring_method", "hybrid_only"),
            # Hybrid score — kept for reference (shown minimally in UI)
            "hybrid_score":    pair.get("hybrid_score", 0),
            "hybrid_components": pair.get("hybrid_components", {}),
            # Skill signals from hybrid (still useful for UI pills)
            "matched_skills":  pair.get("matched_skills", []),
            "missing_skills":  pair.get("missing_skills", []),
            "matched_preferred": pair.get("matched_preferred", []),
            "coverage":        pair.get("coverage", {}),
            "critical_gaps":   pair.get("critical_gaps", []),
            # Ranking
            "rank_score":      round(rank_score, 6),
            "recency_score":   round(rec, 4),
            # Meta
            "auto_matched":    True,
            "matched_at":      datetime.now(timezone.utc).isoformat(),
        })

    logger.info(f"[AutoMatch] Phase 2 complete: {len(new_entries)} final entries after LLM scoring")

    # ── Step 9: Merge with existing, sort, keep top STORE_CAP ─────────
    existing = _load_auto_results()
    merged = {r["job_id"]: r for r in existing}
    for e in new_entries:
        merged[e["job_id"]] = e

    final = sorted(merged.values(), key=lambda x: x.get("rank_score", 0), reverse=True)
    final = final[:STORE_CAP]
    _save_auto_results(final)

    # ── Step 10: Persist meta ─────────────────────────────────────────
    seen_list = list(seen_ids)
    if len(seen_list) > SEEN_ID_CAP:
        seen_list = seen_list[-SEEN_ID_CAP:]
    meta["seen_job_ids"] = seen_list
    meta["last_fetch_at"] = datetime.now(timezone.utc).isoformat()
    _save_auto_meta(meta)

    llm_count = sum(1 for e in new_entries if e.get("scoring_method") == "llm+hybrid")
    logger.info(
        f"[AutoMatch] Complete: {len(new_entries)} new entries "
        f"({llm_count} LLM-scored), {len(final)} total stored, showing top {DISPLAY_CAP}"
    )

    return {
        "matches": final[:DISPLAY_CAP],
        "stats": {
            "from_cache":       False,
            "total_pool":       len(raw_pool),
            "role_matched":     len(role_matched),
            "phase1_pairs":     len(phase1_pairs),
            "llm_scored":       llm_count,
            "new_processed":    len(new_entries),
            "total_shown":      len(final[:DISPLAY_CAP]),
            "target_roles":     target_roles,
        },
        "from_cache": False,
    }