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
    # Country-level (recommended — matches ALL cities + remote within that country)
    "United States",
    "United Kingdom",
    "Canada",
    "Germany",
    "France",
    "India",
    "Australia",
    "Singapore",
    # City / remote level
    "Remote",
    "San Francisco, CA",
    "New York, NY",
    "Seattle, WA",
    "Austin, TX",
    "Boston, MA",
    "Los Angeles, CA",
    "Chicago, IL",
    "London, UK",
    "Toronto, Canada",
    "Berlin, Germany",
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


# ── Location matching engine ─────────────────────────────────────────
#
# Core principle: "Remote" means remote-within-your-country.
# A remote job from a UK company is NOT a match for a US-based user.
# Remote jobs are filtered by country exactly the same as office jobs.
# The only exception: if the user sets NO location preferences at all,
# location filtering is skipped entirely (they've opted out).

# Canonical country names — all aliases normalize to these
COUNTRY_ALIASES: dict[str, str] = {
    # United States
    "united states":             "united states",
    "united states of america":  "united states",
    "usa":                       "united states",
    "u.s.a":                     "united states",
    "u.s.a.":                    "united states",
    "u.s.":                      "united states",
    "us":                        "united states",
    "america":                   "united states",
    # United Kingdom
    "united kingdom":            "united kingdom",
    "uk":                        "united kingdom",
    "u.k.":                      "united kingdom",
    "great britain":             "united kingdom",
    "britain":                   "united kingdom",
    "england":                   "united kingdom",
    "scotland":                  "united kingdom",
    "wales":                     "united kingdom",
    # Canada
    "canada":                    "canada",
    # Germany
    "germany":                   "germany",
    "deutschland":               "germany",
    # France
    "france":                    "france",
    # India
    "india":                     "india",
    # Australia
    "australia":                 "australia",
    # Singapore
    "singapore":                 "singapore",
    # Netherlands
    "netherlands":               "netherlands",
    "holland":                   "netherlands",
    # Ireland
    "ireland":                   "ireland",
    # Spain
    "spain":                     "spain",
    # Europe (broad)
    "europe":                    "europe",
    "eu":                        "europe",
}

# US state abbreviations used in job locations (", CA", ", NY", etc.)
US_STATE_ABBREVS: set[str] = {
    "al", "ak", "az", "ar", "ca", "co", "ct", "de", "fl", "ga",
    "hi", "id", "il", "in", "ia", "ks", "ky", "la", "me", "md",
    "ma", "mi", "mn", "ms", "mo", "mt", "ne", "nv", "nh", "nj",
    "nm", "ny", "nc", "nd", "oh", "ok", "or", "pa", "ri", "sc",
    "sd", "tn", "tx", "ut", "vt", "va", "wa", "wv", "wi", "wy", "dc",
}

# US city names that appear in job locations without a country label
US_CITY_SIGNALS: set[str] = {
    "san francisco", "new york", "new york city", "nyc", "seattle",
    "austin", "boston", "los angeles", "chicago", "denver", "atlanta",
    "miami", "portland", "dallas", "houston", "phoenix", "san jose",
    "san diego", "washington", "brooklyn", "bay area", "silicon valley",
    "palo alto", "menlo park", "mountain view", "sunnyvale", "bellevue",
}

# UK city names
UK_CITY_SIGNALS: set[str] = {
    "london", "manchester", "edinburgh", "cambridge", "oxford",
    "bristol", "birmingham", "glasgow", "leeds", "liverpool",
    "sheffield", "nottingham", "newcastle", "brighton",
}

# Canadian city/province signals
CA_SIGNALS: set[str] = {
    "toronto", "vancouver", "montreal", "calgary", "ottawa", "edmonton",
    "winnipeg", "quebec", ", on", ", bc", ", ab", ", qc", ", mb",
}

# German city signals
DE_SIGNALS: set[str] = {
    "berlin", "munich", "münchen", "hamburg", "frankfurt", "cologne",
    "köln", "düsseldorf", "stuttgart", "dresden", "leipzig",
}

# French city signals
FR_SIGNALS: set[str] = {
    "paris", "lyon", "marseille", "toulouse", "bordeaux", "nice", "nantes",
}

# European country/city signals (for broad "Europe" preference)
EU_SIGNALS: set[str] = {
    "europe", "amsterdam", "stockholm", "zurich", "dublin", "madrid",
    "barcelona", "rome", "milan", "lisbon", "copenhagen", "helsinki",
    "oslo", "warsaw", "prague", "vienna", "brussels", "rotterdam",
}


def _normalize_country(text: str) -> str | None:
    """Normalize a location string to a canonical country if it's a country-level term."""
    return COUNTRY_ALIASES.get(text.strip().lower().rstrip("."))


def location_matches(job_location: str, preferred_location: str) -> bool:
    """
    Return True if job_location satisfies preferred_location.

    "Remote" is NOT a free pass — remote jobs are matched by country exactly
    like office jobs. "Remote – USA" matches "United States". "Remote – UK"
    does NOT match "United States".

    Matching hierarchy:
      1. Direct substring match (city ↔ city, or exact pref in job location)
      2. Country-level: "United States" matches US cities, state abbrevs, USA suffixes
      3. "Remote" pref → treated as same country as any other pref in the list
         (handled by the caller, not here — this fn just matches one pref at a time)
    """
    job_loc  = job_location.lower().strip()
    pref_loc = preferred_location.lower().strip()

    # Strip leading "remote" / "remote –" / "remote -" from job location for country matching
    # e.g. "Remote – USA" → "usa", "Remote, San Francisco, CA" → "san francisco, ca"
    job_loc_stripped = job_loc
    for prefix in ("remote – ", "remote - ", "remote, ", "remote "):
        if job_loc_stripped.startswith(prefix):
            job_loc_stripped = job_loc_stripped[len(prefix):].strip()
            break
    # Also strip from the end: "San Francisco, CA (Remote)" → "san francisco, ca"
    job_loc_stripped = job_loc_stripped.replace("(remote)", "").replace("[remote]", "").strip().rstrip(",").strip()

    # ── 1. Direct substring match ────────────────────────────────────
    # Catches "San Francisco, CA" ↔ "San Francisco, CA", "London, UK" ↔ "UK", etc.
    if pref_loc in job_loc or pref_loc in job_loc_stripped:
        return True

    # ── 2. Country-level matching ────────────────────────────────────
    pref_country = _normalize_country(pref_loc)

    if pref_country == "united states":
        # Match US state abbreviations: ", CA", ", NY", etc.
        if any(f", {st}" in job_loc_stripped for st in US_STATE_ABBREVS):
            return True
        # Match "usa", "u.s.", "united states" anywhere in job location
        if any(s in job_loc for s in ("usa", "u.s.", "united states", "u.s.a")):
            return True
        # Match US city names (covers jobs like "San Francisco" with no state)
        if any(city in job_loc_stripped for city in US_CITY_SIGNALS):
            return True

    elif pref_country == "united kingdom":
        if any(s in job_loc for s in ("uk", "united kingdom", "great britain")):
            return True
        if any(city in job_loc_stripped for city in UK_CITY_SIGNALS):
            return True

    elif pref_country == "canada":
        if "canada" in job_loc:
            return True
        if any(sig in job_loc_stripped for sig in CA_SIGNALS):
            return True

    elif pref_country == "germany":
        if any(s in job_loc for s in ("germany", "deutschland")):
            return True
        if any(city in job_loc_stripped for city in DE_SIGNALS):
            return True

    elif pref_country == "france":
        if "france" in job_loc:
            return True
        if any(city in job_loc_stripped for city in FR_SIGNALS):
            return True

    elif pref_country == "europe":
        # Broad European match
        if any(sig in job_loc for sig in EU_SIGNALS):
            return True
        if any(sig in job_loc for sig in ("uk", "germany", "france", "netherlands",
                                           "spain", "italy", "sweden", "norway",
                                           "denmark", "switzerland", "ireland",
                                           "poland", "portugal", "belgium")):
            return True

    elif pref_country is not None:
        # Generic country — check if canonical name appears in job location
        if pref_country in job_loc:
            return True

    # ── 3. State/city pref: "San Francisco, CA" or "CA" ────────────
    # Already handled by direct substring above for full city names.
    # Handle bare state abbrev as pref: "CA" → match jobs with ", CA"
    if len(pref_loc) == 2 and pref_loc in US_STATE_ABBREVS:
        if f", {pref_loc}" in job_loc:
            return True

    return False


def matches_any_preferred_location(job_location: str, preferred_locations: list[str]) -> bool:
    """
    Return True if job_location matches ANY of the user's preferred locations.

    Key rules:
    - "Remote" in preferred_locations means remote-within-your-country.
      It does NOT open up worldwide remote. Instead, we treat it as:
      "match remote jobs that also match one of my other country/city prefs."
    - If preferred_locations is empty → caller should skip filtering entirely.
    - If ALL prefs are "remote" with no country → pass all remote jobs through
      (user has expressed no country constraint at all).
    """
    if not preferred_locations:
        return True  # no filter

    job_loc = job_location.lower().strip()
    is_remote_job = any(kw in job_loc for kw in ("remote", "anywhere", "distributed", "work from home"))

    # Separate "Remote" pref from country/city prefs
    country_city_prefs = [p for p in preferred_locations if p.lower().strip() != "remote"]
    has_remote_pref    = len(country_city_prefs) < len(preferred_locations)  # "Remote" was in list

    # ── Case 1: No country/city prefs, only "Remote" ─────────────────
    # User has zero geographic constraint — only care about remote.
    if not country_city_prefs:
        return is_remote_job

    # ── Case 2: Has country/city prefs (with or without "Remote") ────
    # All jobs (remote or not) must match a country/city pref.
    # "Remote" in the list doesn't loosen the country constraint —
    # it just signals the user is open to remote work in their country.
    _ = has_remote_pref  # acknowledged but doesn't change logic
    return any(location_matches(job_location, pref) for pref in country_city_prefs)


# ── Job filtering (used by watchlist.py and auto_match.py) ──────────
def filter_jobs_by_profile(jobs: list[dict]) -> tuple[list[dict], dict]:
    """
    Filter a list of fetched jobs against the user profile.
    Returns (filtered_jobs, filter_stats).

    Filtering logic:
    1. exclude_keywords — job title must NOT contain any (hard exclude)
    2. target_roles     — job title must fuzzy-match at least one role
    3. preferred_locations — job location must match (country-aware, no remote free pass)
    4. include_keywords — additive: force-include even if role doesn't match

    If no profile filters are set at all, all jobs are returned unchanged.
    """
    profile = _load_profile()
    target_roles        = profile.get("target_roles", [])
    preferred_locations = profile.get("preferred_locations", [])
    include_kw          = profile.get("include_keywords", [])
    exclude_kw          = profile.get("exclude_keywords", [])

    # If no filters set, return everything
    if not target_roles and not preferred_locations and not exclude_kw:
        return jobs, {"total": len(jobs), "filtered": len(jobs), "reason": "no_profile_filters"}

    filtered = []
    stats = {"total": len(jobs), "role_matched": 0, "location_matched": 0, "excluded": 0, "keyword_added": 0}

    for job in jobs:
        title_lower = job.get("title", "").lower()

        # Step 1: Exclude keywords (highest priority — always filter out)
        if exclude_kw and any(kw in title_lower for kw in exclude_kw):
            stats["excluded"] += 1
            continue

        # Step 2: Role matching (fuzzy word overlap)
        role_match = False
        if target_roles:
            for role in target_roles:
                role_words = role.lower().split()
                hits = sum(1 for w in role_words if w in title_lower)
                if hits >= len(role_words) * 0.6:
                    role_match = True
                    break
        else:
            role_match = True  # no role filter = all roles pass

        # Step 3: Location matching — country-aware, no remote free pass
        if preferred_locations:
            location_match = matches_any_preferred_location(
                job.get("location", ""), preferred_locations
            )
        else:
            location_match = True  # no location filter = all locations pass

        # Step 4: Include keywords (additive override)
        keyword_match = bool(include_kw) and any(kw in title_lower for kw in include_kw)

        # Final: role AND location must both match; OR keyword forces include
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