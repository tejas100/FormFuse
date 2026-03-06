"""
services/auto_match.py — Fully automatic job discovery + matching pipeline.

Powers the "Auto Matches" tab on the Tracking page.

Job source: The Muse API (api.muse.io)
  - Free, no API key required for public access
  - Global jobs: onsite, hybrid, remote — NOT remote-only like Remotive
  - Supports category filtering + client-side keyword relevance
  - Paginated: 20 jobs/page, batched up to BATCH_SIZE

Flow:
  1. Load user's target_roles from profile
  2. For each role → search The Muse by category (paginated, up to BATCH_SIZE)
  3. Client-side title filter to keep only relevant results
  4. Date-filter to last 24h, dedup, cap at ROLE_MATCH_CAP
  5. Run RACK scoring pipeline (LLM off for bulk speed)
  6. Store in uploads/watchlist/auto_match_results.json (rolling 48h window)
  7. Return top DISPLAY_CAP by score

Cache: re-fetches only if last_auto_fetch > 24h ago.
force=True bypasses the cache for the manual "Refresh Auto" button.
"""

import json
import logging
import os
import hashlib
import re
import httpx
from datetime import datetime, timezone, timedelta
from typing import Optional

logger = logging.getLogger(__name__)

# ── Storage ──────────────────────────────────────────────────────────
WATCHLIST_DIR = os.path.join("uploads", "watchlist")
AUTO_RESULTS_PATH = os.path.join(WATCHLIST_DIR, "auto_match_results.json")
AUTO_META_PATH = os.path.join(WATCHLIST_DIR, "auto_match_meta.json")

# ── Tunables ─────────────────────────────────────────────────────────
BATCH_SIZE = 200
ROLE_MATCH_CAP = 50
DISPLAY_CAP = 20
STALE_HOURS = 24
MIN_SCORE_DISPLAY = 30
FETCH_TIMEOUT = 15.0
MUSE_PAGE_SIZE = 20

MUSE_BASE = "https://www.themuse.com/api/public/jobs"

# The Muse category slugs that map to common target role keywords
_MUSE_CATEGORY_MAP = [
    # (keyword_in_role_lower, muse_category)
    ("machine learning", "Data Science"),
    ("ml engineer", "Data Science"),
    ("data scientist", "Data Science"),
    ("data engineer", "Data Science"),
    ("data analyst", "Data Science"),
    ("ai engineer", "Data Science"),
    ("nlp", "Data Science"),
    ("deep learning", "Data Science"),
    ("devops", "IT"),
    ("platform engineer", "IT"),
    ("site reliability", "IT"),
    ("sre", "IT"),
    ("infrastructure", "IT"),
    ("cloud engineer", "IT"),
    ("product manager", "Product"),
    ("product management", "Product"),
    ("designer", "Design"),
    ("ux", "Design"),
    ("ui ", "Design"),
    # All software / backend / frontend / fullstack → Software Engineer
    ("software", "Software Engineer"),
    ("backend", "Software Engineer"),
    ("frontend", "Software Engineer"),
    ("fullstack", "Software Engineer"),
    ("full stack", "Software Engineer"),
    ("full-stack", "Software Engineer"),
    ("engineer", "Software Engineer"),
]


def _role_to_muse_category(role: str) -> Optional[str]:
    role_lower = role.lower()
    for keyword, category in _MUSE_CATEGORY_MAP:
        if keyword in role_lower:
            return category
    return None


def _make_job_id(external_id: str) -> str:
    raw = f"muse:{external_id}"
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def _strip_html(html: str) -> str:
    text = re.sub(r"<[^>]+>", " ", html)
    return re.sub(r"\s+", " ", text).strip()


def _normalize_muse_job(j: dict) -> dict:
    locations = j.get("locations", [])
    location = ", ".join(
        loc.get("name", "") for loc in locations if loc.get("name")
    ) or "Not specified"

    desc_html = j.get("contents", "")
    desc_text = _strip_html(desc_html)

    company_obj = j.get("company", {})
    company_name = company_obj.get("name", "Unknown") if isinstance(company_obj, dict) else "Unknown"

    cats = j.get("categories", [])
    department = cats[0].get("name", "") if cats and isinstance(cats[0], dict) else ""

    refs = j.get("refs", {})
    job_url = refs.get("landing_page", "")

    type_obj = j.get("type")
    commitment = type_obj.get("name", "") if isinstance(type_obj, dict) else ""

    external_id = str(j.get("id", ""))

    return {
        "job_id": _make_job_id(external_id),
        "source": "muse",
        "external_id": external_id,
        "title": j.get("name", "Unknown").strip(),
        "company": company_name.strip(),
        "location": location,
        "url": job_url,
        "description_text": desc_text,
        "description_html": desc_html,
        "posted_at": j.get("publication_date"),
        "department": department,
        "commitment": commitment,
        "fetched_at": datetime.now(timezone.utc).isoformat(),
    }


async def _fetch_muse_for_role(role: str, max_jobs: int = BATCH_SIZE) -> list[dict]:
    """
    Fetch jobs from The Muse for a given target role.
    Uses category filter + client-side title relevance check.
    Paginates until max_jobs reached or pages exhausted.
    """
    category = _role_to_muse_category(role)
    role_keywords = [kw for kw in role.lower().split() if len(kw) > 2]
    collected = []
    page = 0
    max_pages = (max_jobs // MUSE_PAGE_SIZE) + 3  # some buffer

    while len(collected) < max_jobs and page < max_pages:
        params = {"page": page, "descending": "true"}
        if category:
            params["category"] = category

        try:
            async with httpx.AsyncClient(timeout=FETCH_TIMEOUT) as client:
                resp = await client.get(MUSE_BASE, params=params)
                resp.raise_for_status()
                data = resp.json()
        except Exception as e:
            logger.error(f"[Muse] Page {page} fetch error for '{role}': {e}")
            break

        results = data.get("results", [])
        if not results:
            break

        # Client-side relevance: at least one role keyword must appear in the title
        for j in results:
            title_lower = j.get("name", "").lower()
            if any(kw in title_lower for kw in role_keywords):
                collected.append(_normalize_muse_job(j))

        total_pages = data.get("page_count", 1)
        page += 1
        if page >= total_pages:
            break

    logger.info(f"[Muse] '{role}' (category={category}): {len(collected)} relevant jobs over {page} pages")
    return collected[:max_jobs]


# ── Storage helpers ───────────────────────────────────────────────────
def _load_auto_meta() -> dict:
    try:
        with open(AUTO_META_PATH) as f:
            return json.load(f)
    except Exception:
        return {"last_fetch_at": None, "seen_job_ids": []}


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


def _is_stale(meta: dict) -> bool:
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


def _is_within_24h(posted_at: Optional[str]) -> bool:
    if not posted_at:
        return False
    try:
        dt = datetime.fromisoformat(posted_at.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return (datetime.now(timezone.utc) - dt) <= timedelta(hours=24)
    except Exception:
        return False


# ── Main entry point ──────────────────────────────────────────────────
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

    # Load profile directly from disk — avoids depending on user_profile's
    # internal function name (which varies). Same file user_profile.py reads.
    _profile_path = os.path.join("uploads", "user_profile.json")
    try:
        with open(_profile_path) as _f:
            profile = json.load(_f)
    except Exception:
        profile = {}

    meta = _load_auto_meta()

    # ── Serve cache if still fresh ────────────────────────────────────
    if not force and not _is_stale(meta):
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

    # ── Load target roles ─────────────────────────────────────────────
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
    seen_ids = set(meta.get("seen_job_ids", []))
    candidate_jobs = []

    # ── Fetch from The Muse per role ──────────────────────────────────
    for role in target_roles:
        if len(candidate_jobs) >= ROLE_MATCH_CAP:
            break

        fetched = await _fetch_muse_for_role(
            role,
            max_jobs=min(BATCH_SIZE, (ROLE_MATCH_CAP - len(candidate_jobs)) * 4),
        )

        # Keep only: last 24h + not already seen
        fresh = [
            j for j in fetched
            if _is_within_24h(j.get("posted_at")) and j.get("job_id") not in seen_ids
        ]
        logger.info(f"[AutoMatch] '{role}': {len(fetched)} fetched → {len(fresh)} new in last 24h")
        candidate_jobs.extend(fresh)

    # Dedup across roles, hard cap
    deduped: dict[str, dict] = {}
    for j in candidate_jobs:
        deduped.setdefault(j["job_id"], j)
    candidate_jobs = list(deduped.values())[:ROLE_MATCH_CAP]

    total_candidates = len(candidate_jobs)
    logger.info(f"[AutoMatch] {total_candidates} unique candidates to score")

    if total_candidates == 0:
        meta["last_fetch_at"] = datetime.now(timezone.utc).isoformat()
        _save_auto_meta(meta)
        existing = _load_auto_results()
        return {
            "matches": existing[:DISPLAY_CAP],
            "stats": {
                "from_cache": False,
                "total_fetched": 0,
                "new_processed": 0,
                "message": "No new matching jobs posted in the last 24h. Showing previous results.",
            },
            "from_cache": False,
        }

    # ── Score each candidate ──────────────────────────────────────────
    new_entries = []

    for job in candidate_jobs:
        desc = job.get("description_text", "").strip()
        if len(desc) < 50:
            continue

        try:
            result = await match_resumes(jd_text=desc, use_llm=False)
        except Exception as e:
            logger.error(f"[AutoMatch] Scoring error for '{job.get('title')}': {e}")
            continue

        matches = result.get("results", [])
        if not matches:
            continue

        best = max(matches, key=lambda m: m.get("raw_score", 0))
        score_pct = round(best.get("raw_score", 0) * 100)

        if score_pct < MIN_SCORE_DISPLAY:
            continue

        new_entries.append({
            "job_id": job["job_id"],
            "source": job["source"],
            "job_title": job["title"],
            "company": job["company"],
            "location": job.get("location", "Not specified"),
            "job_url": job.get("url", ""),
            "posted_at": job.get("posted_at"),
            "department": job.get("department", ""),
            # Best resume
            "resume_id": best.get("resume_id", ""),
            "resume_name": best.get("name", ""),
            "file_ext": best.get("file_ext", ""),
            # Scores
            "score": score_pct,
            "raw_score": best.get("raw_score", 0),
            "components": best.get("components", {}),
            "matched_skills": best.get("matched_skills", []),
            "missing_skills": best.get("missing_skills", []),
            "matched_preferred": best.get("matched_preferred", []),
            "coverage": best.get("gap_analysis", {}).get("coverage", {}),
            "critical_gaps": best.get("gap_analysis", {}).get("critical_gaps", []),
            # Meta
            "auto_matched": True,
            "matched_at": datetime.now(timezone.utc).isoformat(),
        })
        seen_ids.add(job["job_id"])

    logger.info(f"[AutoMatch] {len(new_entries)} entries above {MIN_SCORE_DISPLAY}% threshold")

    # ── Merge into rolling 48h window ────────────────────────────────
    existing = _load_auto_results()
    cutoff_48h = datetime.now(timezone.utc) - timedelta(hours=48)

    fresh_existing = []
    for r in existing:
        try:
            dt = datetime.fromisoformat(r.get("matched_at", ""))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            if dt > cutoff_48h:
                fresh_existing.append(r)
        except Exception:
            pass

    merged = {r["job_id"]: r for r in fresh_existing}
    for e in new_entries:
        merged[e["job_id"]] = e

    final = sorted(merged.values(), key=lambda x: x["raw_score"], reverse=True)
    _save_auto_results(final)

    meta["last_fetch_at"] = datetime.now(timezone.utc).isoformat()
    meta["seen_job_ids"] = list(seen_ids)[-500:]
    _save_auto_meta(meta)

    logger.info(f"[AutoMatch] Complete: {len(new_entries)} new, {len(final)} total stored")

    return {
        "matches": final[:DISPLAY_CAP],
        "stats": {
            "from_cache": False,
            "total_fetched": total_candidates,
            "new_processed": len(new_entries),
            "total_shown": len(final[:DISPLAY_CAP]),
            "target_roles": target_roles,
        },
        "from_cache": False,
    }