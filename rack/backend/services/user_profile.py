"""
user_profile.py — User profile management for RACK.

Stores:
  - Target roles (e.g. "Software Engineer", "ML Engineer", "Backend Developer")
  - Preferred locations (e.g. "Remote", "San Francisco, CA", "New York, NY")
  - Experience level (min/max years)
  - Any custom keywords to include/exclude

Used by watchlist.py to pre-filter fetched jobs BEFORE running the
expensive RACK matching pipeline, turning 100 jobs into 8-12 relevant ones.

Storage: uploads/user_profile.json
"""

import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

PROFILE_DIR = Path("uploads")
PROFILE_FILE = PROFILE_DIR / "user_profile.json"

# ── Preset role suggestions ─────────────────────────────────────────
ROLE_PRESETS = [
    "Software Engineer",
    "Backend Engineer",
    "Frontend Engineer",
    "Full Stack Developer",
    "ML Engineer",
    "AI Engineer",
    "Data Engineer",
    "Data Scientist",
    "DevOps Engineer",
    "Cloud Engineer",
    "Platform Engineer",
    "Site Reliability Engineer",
    "Research Engineer",
    "Applied Scientist",
    "Solutions Engineer",
    "Engineering Manager",
]

LOCATION_PRESETS = [
    "Remote",
    "San Francisco, CA",
    "New York, NY",
    "Seattle, WA",
    "Austin, TX",
    "Boston, MA",
    "Los Angeles, CA",
    "Chicago, IL",
    "Denver, CO",
    "London, UK",
    "Toronto, Canada",
]

DEFAULT_PROFILE = {
    "target_roles": [],          # ["Software Engineer", "ML Engineer", ...]
    "preferred_locations": [],   # ["Remote", "San Francisco, CA", ...]
    "min_years": None,           # minimum years of experience filter
    "max_years": None,           # maximum years of experience filter
    "include_keywords": [],      # additional keywords to match in titles
    "exclude_keywords": [],      # keywords to exclude (e.g. "Senior", "Staff", "Manager")
    "updated_at": None,
}


# ── File I/O ────────────────────────────────────────────────────────
def _load_profile() -> dict:
    PROFILE_DIR.mkdir(parents=True, exist_ok=True)
    if PROFILE_FILE.exists():
        try:
            with open(PROFILE_FILE, "r") as f:
                return json.load(f)
        except (json.JSONDecodeError, IOError) as e:
            logger.error(f"Failed to load profile: {e}")
    return DEFAULT_PROFILE.copy()


def _save_profile(data: dict):
    PROFILE_DIR.mkdir(parents=True, exist_ok=True)
    data["updated_at"] = datetime.now(timezone.utc).isoformat()
    with open(PROFILE_FILE, "w") as f:
        json.dump(data, f, indent=2, default=str)


# ── CRUD ────────────────────────────────────────────────────────────
def get_profile() -> dict:
    """Get the current user profile."""
    return _load_profile()


def update_profile(
    target_roles: Optional[list[str]] = None,
    preferred_locations: Optional[list[str]] = None,
    min_years: Optional[int] = None,
    max_years: Optional[int] = None,
    include_keywords: Optional[list[str]] = None,
    exclude_keywords: Optional[list[str]] = None,
) -> dict:
    """Update user profile fields. Only non-None fields are updated."""
    profile = _load_profile()

    if target_roles is not None:
        # Deduplicate and clean
        profile["target_roles"] = list(dict.fromkeys(r.strip() for r in target_roles if r.strip()))
    if preferred_locations is not None:
        profile["preferred_locations"] = list(dict.fromkeys(l.strip() for l in preferred_locations if l.strip()))
    if min_years is not None:
        profile["min_years"] = min_years
    if max_years is not None:
        profile["max_years"] = max_years
    if include_keywords is not None:
        profile["include_keywords"] = list(dict.fromkeys(k.strip().lower() for k in include_keywords if k.strip()))
    if exclude_keywords is not None:
        profile["exclude_keywords"] = list(dict.fromkeys(k.strip().lower() for k in exclude_keywords if k.strip()))

    _save_profile(profile)
    logger.info(f"Profile updated: {len(profile['target_roles'])} roles, {len(profile['preferred_locations'])} locations")
    return profile


def get_presets() -> dict:
    """Return preset options for the profile form."""
    return {
        "roles": ROLE_PRESETS,
        "locations": LOCATION_PRESETS,
    }


# ── Job filtering (used by watchlist.py) ────────────────────────────
def filter_jobs_by_profile(jobs: list[dict]) -> tuple[list[dict], dict]:
    """
    Filter a list of fetched jobs against the user profile.
    Returns (filtered_jobs, filter_stats).

    Filtering logic:
    1. If target_roles is set → job title must fuzzy-match at least one role
    2. If preferred_locations is set → job location must match at least one (or "Remote")
    3. If exclude_keywords is set → job title must NOT contain any
    4. If include_keywords is set → adds jobs matching these even if role doesn't match

    This runs BEFORE the RACK pipeline, reducing 100 jobs to ~10 relevant ones.
    """
    profile = _load_profile()
    target_roles = profile.get("target_roles", [])
    preferred_locations = profile.get("preferred_locations", [])
    include_kw = profile.get("include_keywords", [])
    exclude_kw = profile.get("exclude_keywords", [])

    # If no profile filters set, return all jobs
    if not target_roles and not preferred_locations and not exclude_kw:
        return jobs, {"total": len(jobs), "filtered": len(jobs), "reason": "no_profile_filters"}

    filtered = []
    stats = {"total": len(jobs), "role_matched": 0, "location_matched": 0, "excluded": 0, "keyword_added": 0}

    for job in jobs:
        title_lower = job.get("title", "").lower()
        location_lower = job.get("location", "").lower()

        # Step 1: Exclude keywords (highest priority — always filter out)
        if exclude_kw and any(kw in title_lower for kw in exclude_kw):
            stats["excluded"] += 1
            continue

        # Step 2: Role matching (fuzzy — check if any target role words appear in title)
        role_match = False
        if target_roles:
            for role in target_roles:
                role_words = role.lower().split()
                # Match if majority of role words appear in title
                # e.g. "Software Engineer" matches "Senior Software Engineer, Backend"
                hits = sum(1 for w in role_words if w in title_lower)
                if hits >= len(role_words) * 0.6:  # 60% word overlap threshold
                    role_match = True
                    break
        else:
            role_match = True  # no role filter = all roles match

        # Step 3: Location matching
        location_match = False
        if preferred_locations:
            for pref_loc in preferred_locations:
                pref_lower = pref_loc.lower()
                if pref_lower in location_lower or location_lower in pref_lower:
                    location_match = True
                    break
                # Also match "Remote" broadly
                if pref_lower == "remote" and ("remote" in location_lower or "anywhere" in location_lower):
                    location_match = True
                    break
        else:
            location_match = True  # no location filter = all locations match

        # Step 4: Include keywords (additive — adds jobs even without role match)
        keyword_match = False
        if include_kw:
            keyword_match = any(kw in title_lower for kw in include_kw)

        # Final decision: role AND location must match, OR keyword forces include
        if (role_match and location_match) or keyword_match:
            filtered.append(job)
            if role_match:
                stats["role_matched"] += 1
            if keyword_match and not role_match:
                stats["keyword_added"] += 1

    stats["filtered"] = len(filtered)
    logger.info(
        f"[ProfileFilter] {stats['total']} jobs → {stats['filtered']} after filtering "
        f"(role: {stats['role_matched']}, excluded: {stats['excluded']}, kw_added: {stats['keyword_added']})"
    )
    return filtered, stats