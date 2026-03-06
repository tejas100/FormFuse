"""
watchlist.py — Watchlist management + auto-match pipeline for RACK.

UPDATED v4: Fully automated pipeline.
  - refresh_pipeline() = fetch + filter + match in ONE call
  - Returns TOP JOBS (best resume per job), not all resume×job combos
  - Deduplicates: one card per job, showing the highest-scoring resume
  - Profile + date filtering BEFORE expensive RACK pipeline

Storage: uploads/watchlist/ (JSON files)
"""

import json
import logging
import os
import asyncio
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional

from services.job_fetcher import fetch_all_watchlist, fetch_jobs_for_company, fetch_remotive
from services.jd_parser import parse_jd
from services.matcher import match_resumes
from services.user_profile import filter_jobs_by_profile

logger = logging.getLogger(__name__)

# ── Storage paths ───────────────────────────────────────────────────
WATCHLIST_DIR = Path("uploads/watchlist")
WATCHLIST_FILE = WATCHLIST_DIR / "watchlist.json"
JOBS_FILE = WATCHLIST_DIR / "fetched_jobs.json"
MATCHES_FILE = WATCHLIST_DIR / "match_results.json"

# ── Default data structures ─────────────────────────────────────────
DEFAULT_WATCHLIST = {
    "companies": [],
    "settings": {
        "auto_match": True,
        "min_score_alert": 25,
        "match_use_llm": True,
    },
    "last_fetch_at": None,
}

DEFAULT_JOBS_STORE = {
    "jobs": [],
    "last_updated": None,
}

DEFAULT_MATCHES_STORE = {
    "matches": [],
    "seen_job_ids": [],
    "last_matched_at": None,
}


# ── Preset companies for quick-add ──────────────────────────────────
PRESET_COMPANIES = [
    {"company": "openai", "source": "greenhouse", "label": "OpenAI"},
    {"company": "anthropic", "source": "greenhouse", "label": "Anthropic"},
    {"company": "stripe", "source": "greenhouse", "label": "Stripe"},
    {"company": "notion", "source": "greenhouse", "label": "Notion"},
    {"company": "ramp", "source": "greenhouse", "label": "Ramp"},
    {"company": "figma", "source": "greenhouse", "label": "Figma"},
    {"company": "datadog", "source": "greenhouse", "label": "Datadog"},
    {"company": "netflix", "source": "lever", "label": "Netflix"},
    {"company": "cloudflare", "source": "greenhouse", "label": "Cloudflare"},
]


# ── File I/O helpers ────────────────────────────────────────────────
def _ensure_dir():
    WATCHLIST_DIR.mkdir(parents=True, exist_ok=True)


def _load_json(filepath: Path, default: dict) -> dict:
    _ensure_dir()
    if filepath.exists():
        try:
            with open(filepath, "r") as f:
                return json.load(f)
        except (json.JSONDecodeError, IOError) as e:
            logger.error(f"Failed to load {filepath}: {e}")
    return default.copy()


def _save_json(filepath: Path, data: dict):
    _ensure_dir()
    with open(filepath, "w") as f:
        json.dump(data, f, indent=2, default=str)


# ── Date filtering helper ───────────────────────────────────────────
def _filter_by_date(jobs: list[dict], date_filter: Optional[str]) -> list[dict]:
    """
    Filter jobs by posted date.
    date_filter: "24h", "7d", "30d", or None (no filter).
    """
    if not date_filter or date_filter == "all":
        return jobs

    now = datetime.now(timezone.utc)
    delta_map = {
        "24h": timedelta(hours=24),
        "7d": timedelta(days=7),
        "30d": timedelta(days=30),
    }
    delta = delta_map.get(date_filter)
    if not delta:
        return jobs

    cutoff = now - delta
    filtered = []
    for job in jobs:
        posted = job.get("posted_at")
        if not posted:
            filtered.append(job)
            continue
        try:
            if isinstance(posted, str):
                posted_dt = datetime.fromisoformat(posted.replace("Z", "+00:00"))
            elif isinstance(posted, (int, float)):
                posted_dt = datetime.fromtimestamp(posted / 1000, tz=timezone.utc)
            else:
                filtered.append(job)
                continue

            if posted_dt >= cutoff:
                filtered.append(job)
        except (ValueError, TypeError):
            filtered.append(job)

    logger.info(f"[DateFilter] {date_filter}: {len(jobs)} → {len(filtered)} jobs")
    return filtered


# ── Watchlist CRUD ──────────────────────────────────────────────────
def get_watchlist() -> dict:
    return _load_json(WATCHLIST_FILE, DEFAULT_WATCHLIST)


def add_company(company: str, source: str, label: str = "", filters: dict = None) -> dict:
    wl = get_watchlist()
    existing = [c for c in wl["companies"] if c["company"] == company and c["source"] == source]
    if existing:
        logger.info(f"Company already in watchlist: {company} ({source})")
        return {"status": "exists", "watchlist": wl}

    entry = {
        "company": company,
        "source": source,
        "label": label or company.title(),
        "filters": filters or {},
        "added_at": datetime.now(timezone.utc).isoformat(),
    }
    wl["companies"].append(entry)
    _save_json(WATCHLIST_FILE, wl)
    logger.info(f"Added to watchlist: {company} ({source})")
    return {"status": "added", "watchlist": wl}


def remove_company(company: str, source: str) -> dict:
    wl = get_watchlist()
    before = len(wl["companies"])
    wl["companies"] = [
        c for c in wl["companies"]
        if not (c["company"] == company and c["source"] == source)
    ]
    _save_json(WATCHLIST_FILE, wl)
    removed = before - len(wl["companies"])
    logger.info(f"Removed {removed} entries for {company} ({source})")
    return {"status": "removed", "removed": removed, "watchlist": wl}


def update_settings(settings: dict) -> dict:
    wl = get_watchlist()
    wl["settings"].update(settings)
    _save_json(WATCHLIST_FILE, wl)
    return {"status": "updated", "watchlist": wl}


def get_presets() -> list[dict]:
    wl = get_watchlist()
    current = {(c["company"], c["source"]) for c in wl["companies"]}
    return [
        {**p, "in_watchlist": (p["company"], p["source"]) in current}
        for p in PRESET_COMPANIES
    ]


# ── Job fetching ────────────────────────────────────────────────────
async def fetch_watchlist_jobs(force: bool = False) -> dict:
    """
    Fetch jobs for all companies in the watchlist.
    Stores ALL raw results (filtering happens at match time).
    """
    wl = get_watchlist()
    if not wl["companies"]:
        return {"status": "empty", "message": "No companies in watchlist", "jobs_count": 0}

    jobs = await fetch_all_watchlist(wl["companies"])

    store = {
        "jobs": jobs,
        "last_updated": datetime.now(timezone.utc).isoformat(),
    }
    _save_json(JOBS_FILE, store)

    wl["last_fetch_at"] = store["last_updated"]
    _save_json(WATCHLIST_FILE, wl)

    by_company = {}
    for j in jobs:
        key = j["company"]
        by_company[key] = by_company.get(key, 0) + 1

    return {
        "status": "fetched",
        "jobs_count": len(jobs),
        "by_company": by_company,
        "fetched_at": store["last_updated"],
    }


def get_fetched_jobs(
    company: Optional[str] = None,
    title_search: Optional[str] = None,
    limit: int = 50,
) -> list[dict]:
    store = _load_json(JOBS_FILE, DEFAULT_JOBS_STORE)
    jobs = store.get("jobs", [])

    if company:
        jobs = [j for j in jobs if j["company"].lower() == company.lower()]
    if title_search:
        search_lower = title_search.lower()
        jobs = [j for j in jobs if search_lower in j["title"].lower()]

    return jobs[:limit]


# ═══════════════════════════════════════════════════════════════════
# REFRESH PIPELINE — fetch + filter + match in ONE call
# ═══════════════════════════════════════════════════════════════════

async def refresh_pipeline(
    date_filter: Optional[str] = None,
    use_profile: bool = True,
    limit: int = 20,
    force_fetch: bool = False,
) -> dict:
    """
    Full automated pipeline:
      1. Fetch jobs from all watchlisted companies (or use cached if recent)
      2. Apply date filter
      3. Apply profile filter (roles, locations, keywords)
      4. Run RACK pipeline on filtered jobs
      5. Deduplicate: best resume per job
      6. Return top N jobs sorted by score

    This is the ONE endpoint the Tracking page calls.
    """
    import time
    pipeline_start = time.time()

    wl = get_watchlist()
    settings = wl.get("settings", DEFAULT_WATCHLIST["settings"])
    use_llm = settings.get("match_use_llm", True)

    if not wl["companies"]:
        return {
            "status": "no_companies",
            "message": "Add companies to your watchlist first.",
            "matches": [],
            "stats": {},
        }

    # ── Step 1: Fetch (or use cached) ─────────────────────────────
    store = _load_json(JOBS_FILE, DEFAULT_JOBS_STORE)
    last_updated = store.get("last_updated")
    cache_stale = True

    if last_updated and not force_fetch:
        try:
            last_dt = datetime.fromisoformat(last_updated.replace("Z", "+00:00"))
            age_hours = (datetime.now(timezone.utc) - last_dt).total_seconds() / 3600
            cache_stale = age_hours > 6  # Consider stale after 6 hours
        except:
            cache_stale = True

    fetch_stats = None
    if cache_stale or force_fetch or not store.get("jobs"):
        logger.info("[Refresh] Fetching fresh jobs from APIs...")
        fetch_stats = await fetch_watchlist_jobs()
        store = _load_json(JOBS_FILE, DEFAULT_JOBS_STORE)
    else:
        logger.info(f"[Refresh] Using cached jobs ({len(store.get('jobs', []))} jobs, updated {last_updated})")

    all_jobs = store.get("jobs", [])
    if not all_jobs:
        return {
            "status": "no_jobs",
            "message": "No jobs found from your watchlisted companies.",
            "matches": [],
            "stats": {"total_fetched": 0},
        }

    total_fetched = len(all_jobs)

    # ── Step 2: Date filter ───────────────────────────────────────
    jobs = _filter_by_date(all_jobs, date_filter)
    after_date = len(jobs)

    # ── Step 3: Profile filter ────────────────────────────────────
    profile_stats = None
    if use_profile:
        jobs, profile_stats = filter_jobs_by_profile(jobs)
    after_profile = len(jobs)

    if not jobs:
        return {
            "status": "no_matching_jobs",
            "message": f"No jobs match your filters. {total_fetched} fetched → {after_date} after date → {after_profile} after profile.",
            "matches": [],
            "stats": {
                "total_fetched": total_fetched,
                "after_date": after_date,
                "after_profile": after_profile,
                "processed": 0,
            },
        }

    # ── Step 4: Dedup against already-processed ───────────────────
    match_store = _load_json(MATCHES_FILE, DEFAULT_MATCHES_STORE)
    seen_ids = set(match_store.get("seen_job_ids", []))

    new_jobs = [j for j in jobs if j["job_id"] not in seen_ids]

    # Cap new jobs to process (the expensive RACK pipeline)
    new_jobs = new_jobs[:limit]

    logger.info(
        f"[Refresh] Pipeline: {total_fetched} total → {after_date} after date "
        f"→ {after_profile} after profile → {len(new_jobs)} new to process"
    )

    # ── Step 5: Run RACK pipeline on new jobs ─────────────────────
    new_matches = []
    errors = 0

    for job in new_jobs:
        try:
            jd_text = job.get("description_text", "")
            if not jd_text or len(jd_text.strip()) < 50:
                logger.warning(f"[Refresh] Skipping {job['job_id']} — description too short")
                seen_ids.add(job["job_id"])
                continue

            result = await match_resumes(jd_text, use_llm=use_llm)

            matches = result.get("results", [])
            jd_parsed = result.get("jd_parsed", {})

            # ── KEY CHANGE: pick BEST resume for this job ─────────
            if matches:
                # Sort by raw_score descending, take the best one
                best = max(matches, key=lambda m: m.get("raw_score", 0))

                match_entry = {
                    "job_id": job["job_id"],
                    "job_title": job["title"],
                    "company": job["company"],
                    "location": job["location"],
                    "job_url": job["url"],
                    "source": job["source"],
                    "posted_at": job.get("posted_at"),
                    "department": job.get("department", ""),
                    # Best resume info
                    "resume_name": best.get("name", ""),
                    "resume_id": best.get("resume_id", ""),
                    "file_ext": best.get("file_ext", ""),
                    "score": best.get("score", 0),
                    "raw_score": best.get("raw_score", 0),
                    "components": best.get("components", {}),
                    "matched_skills": best.get("matched_skills", []),
                    "missing_skills": best.get("missing_skills", []),
                    "matched_preferred": best.get("matched_preferred", []),
                    "gap_analysis": best.get("gap_analysis", {}),
                    "critical_gaps": best.get("gap_analysis", {}).get("critical_gaps", []),
                    "coverage": best.get("gap_analysis", {}).get("coverage", {}),
                    # JD parsed info
                    "jd_title": jd_parsed.get("title", ""),
                    "jd_required_skills": jd_parsed.get("required_skills", []),
                    "jd_preferred_skills": jd_parsed.get("preferred_skills", []),
                    "jd_domains": jd_parsed.get("domains", []),
                    "jd_min_years": jd_parsed.get("min_years"),
                    # Meta
                    "matched_at": datetime.now(timezone.utc).isoformat(),
                    "total_resumes_scored": len(matches),
                }
                new_matches.append(match_entry)

            seen_ids.add(job["job_id"])

        except Exception as e:
            logger.error(f"[Refresh] Error processing job {job.get('title', '?')}: {e}")
            errors += 1
            seen_ids.add(job["job_id"])

    # ── Step 6: Merge with existing and save ──────────────────────
    existing_matches = match_store.get("matches", [])
    all_matches = existing_matches + new_matches

    match_store = {
        "matches": all_matches,
        "seen_job_ids": list(seen_ids),
        "last_matched_at": datetime.now(timezone.utc).isoformat(),
    }
    _save_json(MATCHES_FILE, match_store)

    # ── Step 7: Return top matches (all, sorted by score) ─────────
    # Apply profile filter to cached matches too (re-filter on title)
    all_sorted = sorted(all_matches, key=lambda x: x.get("score", 0), reverse=True)

    pipeline_time = round(time.time() - pipeline_start, 1)

    return {
        "status": "ok",
        "matches": all_sorted[:50],  # Top 50 for the UI
        "new_processed": len(new_jobs),
        "new_matches": len(new_matches),
        "errors": errors,
        "pipeline_time_seconds": pipeline_time,
        "stats": {
            "total_fetched": total_fetched,
            "after_date": after_date,
            "after_profile": after_profile,
            "new_processed": len(new_jobs),
            "cached_matches": len(existing_matches),
            "total_matches": len(all_sorted),
            "fetched_fresh": fetch_stats is not None,
        },
    }


# ── Legacy auto-match (kept for backward compat) ───────────────────
async def run_auto_match(
    title_filter: Optional[str] = None,
    company_filter: Optional[str] = None,
    date_filter: Optional[str] = None,
    use_profile: bool = True,
    limit: int = 20,
) -> dict:
    """Legacy endpoint — now wraps refresh_pipeline."""
    return await refresh_pipeline(
        date_filter=date_filter,
        use_profile=use_profile,
        limit=limit,
        force_fetch=False,
    )


def get_match_results(
    company: Optional[str] = None,
    min_score: Optional[int] = None,
    limit: int = 50,
) -> list[dict]:
    store = _load_json(MATCHES_FILE, DEFAULT_MATCHES_STORE)
    matches = store.get("matches", [])

    if company:
        matches = [m for m in matches if m["company"].lower() == company.lower()]
    if min_score is not None:
        matches = [m for m in matches if m.get("score", 0) >= min_score]

    matches.sort(key=lambda x: x.get("score", 0), reverse=True)
    return matches[:limit]


def clear_match_history() -> dict:
    _save_json(MATCHES_FILE, DEFAULT_MATCHES_STORE.copy())
    return {"status": "cleared"}


def get_watchlist_stats() -> dict:
    wl = get_watchlist()
    jobs_store = _load_json(JOBS_FILE, DEFAULT_JOBS_STORE)
    match_store = _load_json(MATCHES_FILE, DEFAULT_MATCHES_STORE)

    matches = match_store.get("matches", [])
    high_matches = [m for m in matches if m.get("score", 0) >= 60]

    return {
        "companies_tracked": len(wl["companies"]),
        "total_jobs_fetched": len(jobs_store.get("jobs", [])),
        "total_matches": len(matches),
        "high_score_matches": len(high_matches),
        "last_fetch": wl.get("last_fetch_at"),
        "last_match": match_store.get("last_matched_at"),
        "settings": wl.get("settings", {}),
    }