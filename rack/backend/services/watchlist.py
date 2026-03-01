"""
watchlist.py — Watchlist management + auto-match pipeline for RACK.

Handles:
  - Company watchlist CRUD (add/remove/list companies to monitor)
  - Job storage (fetched jobs persisted to JSON)
  - Auto-match pipeline: fetched JDs → PROFILE FILTER → jd_parser → matcher → ranked alerts
  - Match history tracking (avoid re-alerting on same jobs)

UPDATED: Profile-based pre-filtering + date filtering.
Jobs are filtered BEFORE the RACK pipeline, turning 100 jobs into ~10 relevant ones.

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
            # If no posted_at, include it (don't exclude unknowns)
            filtered.append(job)
            continue
        try:
            # Handle various date formats from APIs
            if isinstance(posted, str):
                # Try ISO format first
                posted_dt = datetime.fromisoformat(posted.replace("Z", "+00:00"))
            elif isinstance(posted, (int, float)):
                # Epoch milliseconds (Lever)
                posted_dt = datetime.fromtimestamp(posted / 1000, tz=timezone.utc)
            else:
                filtered.append(job)
                continue

            if posted_dt >= cutoff:
                filtered.append(job)
        except (ValueError, TypeError):
            # Can't parse date, include the job
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


# ── Auto-match pipeline (UPDATED: profile + date filtering) ────────
async def run_auto_match(
    title_filter: Optional[str] = None,
    company_filter: Optional[str] = None,
    date_filter: Optional[str] = None,
    use_profile: bool = True,
    limit: int = 20,
) -> dict:
    """
    Run the full auto-match pipeline with pre-filtering:
    1. Get fetched jobs (optionally filtered by company/title)
    2. Apply DATE filter (24h, 7d, 30d)
    3. Apply PROFILE filter (target roles, locations, exclude keywords)
    4. Only filtered jobs go through the expensive RACK pipeline
    5. Store results, return sorted matches

    This is the key optimization: 100 fetched jobs → ~10 relevant → RACK pipeline.
    """
    wl = get_watchlist()
    settings = wl.get("settings", DEFAULT_WATCHLIST["settings"])
    min_score = settings.get("min_score_alert", 25)
    use_llm = settings.get("match_use_llm", True)

    # Step 1: Get all fetched jobs (with basic company/title filter)
    store = _load_json(JOBS_FILE, DEFAULT_JOBS_STORE)
    all_jobs = store.get("jobs", [])

    if not all_jobs:
        return {"status": "no_jobs", "message": "No fetched jobs. Click Fetch Jobs first.", "matches": []}

    # Apply basic filters
    jobs = all_jobs
    if company_filter:
        jobs = [j for j in jobs if j["company"].lower() == company_filter.lower()]
    if title_filter:
        tf = title_filter.lower()
        jobs = [j for j in jobs if tf in j["title"].lower()]

    total_before_filters = len(jobs)

    # Step 2: Date filter
    jobs = _filter_by_date(jobs, date_filter)
    after_date = len(jobs)

    # Step 3: Profile filter (the big optimization)
    profile_stats = None
    if use_profile:
        jobs, profile_stats = filter_jobs_by_profile(jobs)
    after_profile = len(jobs)

    # Cap at limit
    jobs = jobs[:limit]

    if not jobs:
        return {
            "status": "no_matching_jobs",
            "message": f"No jobs match your filters. {total_before_filters} total → {after_date} after date → {after_profile} after profile filter.",
            "matches": [],
            "filter_stats": {
                "total_fetched": total_before_filters,
                "after_date_filter": after_date,
                "after_profile_filter": after_profile,
                "date_filter": date_filter,
                "profile_applied": use_profile,
                "profile_stats": profile_stats,
            },
        }

    # Step 4: Dedup against already-processed jobs
    match_store = _load_json(MATCHES_FILE, DEFAULT_MATCHES_STORE)
    seen_ids = set(match_store.get("seen_job_ids", []))

    new_jobs = [j for j in jobs if j["job_id"] not in seen_ids]
    if not new_jobs:
        existing = match_store.get("matches", [])
        # Apply current filters to show relevant cached results
        if company_filter:
            existing = [m for m in existing if m["company"].lower() == company_filter.lower()]
        if title_filter:
            tf = title_filter.lower()
            existing = [m for m in existing if tf in m["job_title"].lower()]
        return {
            "status": "no_new_jobs",
            "message": f"All {len(jobs)} filtered jobs already processed. Showing cached results.",
            "matches": sorted(existing, key=lambda x: x["score"], reverse=True),
            "total_processed": len(seen_ids),
            "filter_stats": {
                "total_fetched": total_before_filters,
                "after_date_filter": after_date,
                "after_profile_filter": after_profile,
                "processing": len(jobs),
            },
        }

    logger.info(
        f"[AutoMatch] Pipeline: {total_before_filters} total → {after_date} after date "
        f"→ {after_profile} after profile → {len(new_jobs)} new to process"
    )

    # Step 5: Run RACK pipeline on each filtered job
    new_matches = []
    errors = 0

    for job in new_jobs:
        try:
            jd_text = job.get("description_text", "")
            if not jd_text or len(jd_text.strip()) < 50:
                logger.warning(f"[AutoMatch] Skipping {job['job_id']} — description too short")
                seen_ids.add(job["job_id"])
                continue

            result = await match_resumes(jd_text, use_llm=use_llm)

            matches = result.get("results", [])
            jd_parsed = result.get("jd_parsed", {})
            pipeline_time = result.get("meta", {}).get("pipeline_time_seconds", 0)

            for match in matches:
                match_entry = {
                    "job_id": job["job_id"],
                    "job_title": job["title"],
                    "company": job["company"],
                    "location": job["location"],
                    "job_url": job["url"],
                    "source": job["source"],
                    "posted_at": job.get("posted_at"),
                    "department": job.get("department", ""),
                    "resume_name": match.get("resume_name", ""),
                    "resume_id": match.get("resume_id", ""),
                    "score": match.get("final_score", 0),
                    "score_breakdown": match.get("score_breakdown", {}),
                    "matched_skills": match.get("matched_skills", []),
                    "missing_skills": match.get("missing_skills", []),
                    "gap_summary": match.get("gap_analysis", {}).get("summary", ""),
                    "critical_gaps": match.get("gap_analysis", {}).get("critical_gaps", []),
                    "jd_skills": jd_parsed.get("skills", []),
                    "jd_title": jd_parsed.get("title", ""),
                    "matched_at": datetime.now(timezone.utc).isoformat(),
                    "pipeline_time": pipeline_time,
                }
                new_matches.append(match_entry)

            seen_ids.add(job["job_id"])

        except Exception as e:
            logger.error(f"[AutoMatch] Error processing job {job.get('title', '?')}: {e}")
            errors += 1
            seen_ids.add(job["job_id"])

    # Save results
    all_matches = match_store.get("matches", []) + new_matches
    match_store = {
        "matches": all_matches,
        "seen_job_ids": list(seen_ids),
        "last_matched_at": datetime.now(timezone.utc).isoformat(),
    }
    _save_json(MATCHES_FILE, match_store)

    # Sort and return
    all_sorted = sorted(new_matches, key=lambda x: x["score"], reverse=True)
    above = [m for m in all_sorted if m["score"] >= min_score]

    return {
        "status": "matched",
        "new_jobs_processed": len(new_jobs),
        "new_matches_found": len(new_matches),
        "above_threshold": len(above),
        "min_score_threshold": min_score,
        "errors": errors,
        "matches": all_sorted,
        "filter_stats": {
            "total_fetched": total_before_filters,
            "after_date_filter": after_date,
            "after_profile_filter": after_profile,
            "processed": len(new_jobs),
            "date_filter": date_filter,
            "profile_applied": use_profile,
            "profile_stats": profile_stats,
        },
    }


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
        matches = [m for m in matches if m["score"] >= min_score]

    matches.sort(key=lambda x: x["score"], reverse=True)
    return matches[:limit]


def clear_match_history() -> dict:
    _save_json(MATCHES_FILE, DEFAULT_MATCHES_STORE.copy())
    return {"status": "cleared"}


def get_watchlist_stats() -> dict:
    wl = get_watchlist()
    jobs_store = _load_json(JOBS_FILE, DEFAULT_JOBS_STORE)
    match_store = _load_json(MATCHES_FILE, DEFAULT_MATCHES_STORE)

    matches = match_store.get("matches", [])
    high_matches = [m for m in matches if m["score"] >= 60]

    return {
        "companies_tracked": len(wl["companies"]),
        "total_jobs_fetched": len(jobs_store.get("jobs", [])),
        "total_matches": len(matches),
        "high_score_matches": len(high_matches),
        "last_fetch": wl.get("last_fetch_at"),
        "last_match": match_store.get("last_matched_at"),
        "settings": wl.get("settings", {}),
    }