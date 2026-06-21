"""
routers/account.py — API endpoints for user profile management.

Endpoints:
  GET  /api/account/profile     — Get current user's preferences from DB
  PUT  /api/account/profile     — Save current user's preferences to DB
  GET  /api/account/presets     — Get role/location presets for the form
"""

import json
import logging
import os
import re
from typing import Optional, List

import httpx
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, update
from pydantic import BaseModel

from db.database import get_db
from models.orm import User
from routers.auth import get_current_user
from services.user_profile import get_presets

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/account", tags=["account"])


# ── Default empty profile shape ───────────────────────────────────────────────
DEFAULT_PREFERENCES = {
    "target_roles": [],
    "preferred_locations": [],
    "min_years": None,
    "max_years": None,
    "include_keywords": [],
    "exclude_keywords": [],
    "role_aliases": {},   # {"AI Engineer": ["machine learning engineer", ...], ...}
}


class ProfileUpdate(BaseModel):
    # Legal name — used for auto-apply forms (not display name from Google)
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    middle_name: Optional[str] = None
    # Job preferences
    target_roles: Optional[list[str]] = None
    preferred_locations: Optional[list[str]] = None
    min_years: Optional[int] = None
    max_years: Optional[int] = None
    include_keywords: Optional[list[str]] = None
    exclude_keywords: Optional[list[str]] = None
    role_aliases: Optional[dict[str, list[str]]] = None
    # Application profile
    phone: Optional[str] = None
    linkedin: Optional[str] = None
    github: Optional[str] = None
    website: Optional[str] = None
    work_auth: Optional[str] = None               # "yes" | "no"
    requires_sponsorship: Optional[str] = None    # "yes" | "no"
    current_location: Optional[str] = None        # "City, State" — filled into location fields
    gender_eeo: Optional[str] = None              # "male"|"female"|"non_binary"|"decline"
    veteran_status: Optional[str] = None          # "protected_veteran"|"not_a_veteran"|"decline"
    disability_status: Optional[str] = None       # "yes"|"no"|"decline"
    ethnicity_eeo: Optional[str] = None           # "asian"|"black"|"hispanic"|"white"|"two_or_more"|"decline"
    # Work eligibility detail (visa type selection)
    work_auth_type: Optional[str] = None          # "US Citizen"|"H-1B"|"F-1 (Student)"|"OPT"|etc.
    # Checklist — quick-fire preferences filled during onboarding
    open_to_inperson: Optional[str] = None        # "yes"|"no"
    willing_to_relocate: Optional[str] = None     # "yes"|"no"
    can_start_immediately: Optional[str] = None   # "yes"|"no"
    reliable_transportation: Optional[str] = None # "yes"|"no"
    needs_accommodation: Optional[str] = None     # "yes"|"no"|"prefer not"
    gov_clearance: Optional[str] = None           # "yes"|"no"
    family_ties_foreign_gov: Optional[str] = None # "yes"|"no"
    additional_info: Optional[str] = None         # free-text notes for form-filling
    # Application password — used by auto-apply for Workday/iCIMS/Oracle account creation
    app_password: Optional[str] = None            # plaintext for now; encryption TODO
    # Resume optimization mode chosen during onboarding
    optimize_mode: Optional[str] = None           # "off"|"honest"|"aggressive"
    auto_approve: Optional[str] = None            # "yes"|"no" — skip review step
    # Onboarding completion flag — App.jsx checks this to skip the wizard on return visits
    onboarding_complete: Optional[bool] = None


class RoleAliasRequest(BaseModel):
    role: str


# ── GET /api/account/profile ──────────────────────────────────────────────────
@router.get("/profile")
async def read_profile(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Return the current user's saved preferences from DB."""
    result = await db.execute(select(User).where(User.id == current_user.id))
    user = result.scalar_one_or_none()

    # Merge stored prefs over defaults so new fields always have a value
    prefs = {**DEFAULT_PREFERENCES, **(user.preferences or {})}
    return prefs


# ── PUT /api/account/profile ──────────────────────────────────────────────────
@router.put("/profile")
async def save_profile(
    req: ProfileUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Persist the current user's preferences to the DB."""
    # Read existing prefs so we never wipe keys we don't know about
    result = await db.execute(select(User).where(User.id == current_user.id))
    user_row = result.scalar_one_or_none()
    existing = user_row.preferences or {}

    # Build update dict — only overwrite keys that were explicitly sent
    updates = {}
    # Job preferences
    if req.target_roles        is not None: updates["target_roles"]        = req.target_roles
    if req.preferred_locations is not None: updates["preferred_locations"]  = req.preferred_locations
    if req.min_years           is not None: updates["min_years"]            = req.min_years
    if req.max_years           is not None: updates["max_years"]            = req.max_years
    if req.include_keywords    is not None: updates["include_keywords"]     = req.include_keywords
    if req.exclude_keywords    is not None: updates["exclude_keywords"]     = req.exclude_keywords
    if req.role_aliases        is not None: updates["role_aliases"]         = req.role_aliases
    # Legal name fields — allow empty string to clear
    if req.first_name          is not None: updates["first_name"]           = req.first_name
    if req.last_name           is not None: updates["last_name"]            = req.last_name
    if req.middle_name         is not None: updates["middle_name"]          = req.middle_name
    # Application profile — allow empty string to clear a field
    if req.phone               is not None: updates["phone"]                = req.phone
    if req.linkedin            is not None: updates["linkedin"]             = req.linkedin
    if req.github              is not None: updates["github"]               = req.github
    if req.website             is not None: updates["website"]              = req.website
    if req.current_location    is not None: updates["current_location"]     = req.current_location
    if req.work_auth           is not None: updates["work_auth"]            = req.work_auth
    if req.requires_sponsorship is not None: updates["requires_sponsorship"] = req.requires_sponsorship
    if req.gender_eeo          is not None: updates["gender_eeo"]           = req.gender_eeo
    if req.veteran_status      is not None: updates["veteran_status"]       = req.veteran_status
    if req.disability_status   is not None: updates["disability_status"]    = req.disability_status
    if req.ethnicity_eeo       is not None: updates["ethnicity_eeo"]        = req.ethnicity_eeo
    # Onboarding wizard fields
    if req.work_auth_type          is not None: updates["work_auth_type"]          = req.work_auth_type
    if req.open_to_inperson        is not None: updates["open_to_inperson"]        = req.open_to_inperson
    if req.willing_to_relocate     is not None: updates["willing_to_relocate"]     = req.willing_to_relocate
    if req.can_start_immediately   is not None: updates["can_start_immediately"]   = req.can_start_immediately
    if req.reliable_transportation is not None: updates["reliable_transportation"] = req.reliable_transportation
    if req.needs_accommodation     is not None: updates["needs_accommodation"]     = req.needs_accommodation
    if req.gov_clearance           is not None: updates["gov_clearance"]           = req.gov_clearance
    if req.family_ties_foreign_gov is not None: updates["family_ties_foreign_gov"] = req.family_ties_foreign_gov
    if req.additional_info         is not None: updates["additional_info"]         = req.additional_info
    if req.app_password            is not None: updates["app_password"]            = req.app_password
    if req.optimize_mode           is not None: updates["optimize_mode"]           = req.optimize_mode
    if req.auto_approve            is not None: updates["auto_approve"]            = req.auto_approve
    if req.onboarding_complete     is not None: updates["onboarding_complete"]     = req.onboarding_complete

    new_prefs = {**existing, **updates}

    await db.execute(
        update(User)
        .where(User.id == current_user.id)
        .values(preferences=new_prefs)
    )
    await db.commit()

    logger.info(f"Preferences saved for user {current_user.id}: {list(updates.keys())}")
    return new_prefs


# ── GET /api/account/presets ──────────────────────────────────────────────────
@router.get("/presets")
async def profile_presets():
    """Get preset options for the profile form (roles, locations)."""
    return get_presets()


# ── POST /api/account/role-aliases ───────────────────────────────────────────
@router.post("/role-aliases")
async def generate_role_aliases(
    req: RoleAliasRequest,
    current_user: User = Depends(get_current_user),
):
    """
    Call GPT-4o-mini to generate 15-20 related job title variants for a given
    target role. Uses raw httpx — same pattern as llm_scorer.py.
    """
    role = req.role.strip()
    if not role:
        raise HTTPException(status_code=400, detail="role is required")

    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY not configured")

    prompt = (
        f'You are a job market expert. For the target role "{role}", list all closely '
        f"related job titles that a recruiter might use when posting that same type of position.\n\n"
        f"Rules:\n"
        f"- Return ONLY a JSON array of strings, no other text, no markdown fences\n"
        f"- 15 to 20 items\n"
        f"- All lowercase\n"
        f"- Include common variants, abbreviations, and synonym titles\n"
        f"- Include both senior and non-senior variants if the base role is mid-level\n"
        f"- Do NOT include roles from entirely different fields\n"
        f"- Do NOT include management or director roles unless the input is already senior\n\n"
        f'Now return the JSON array for: "{role}"'
    )

    try:
        async with httpx.AsyncClient() as client:
            response = await client.post(
                "https://api.openai.com/v1/chat/completions",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": "gpt-4o-mini",
                    "messages": [{"role": "user", "content": prompt}],
                    "temperature": 0.3,
                    "max_tokens": 400,
                },
                timeout=20.0,
            )

        if response.status_code != 200:
            logger.warning(f"[RoleAliases] OpenAI {response.status_code} for '{role}'")
            raise HTTPException(status_code=502, detail="OpenAI request failed")

        raw = response.json()["choices"][0]["message"]["content"].strip()
        # Strip markdown fences if present — same pattern as llm_scorer.py
        raw = re.sub(r'^```(?:json)?\s*', '', raw)
        raw = re.sub(r'\s*```$', '', raw)

        aliases = json.loads(raw.strip())
        if not isinstance(aliases, list):
            raise ValueError("expected a list")

        # Normalise: lowercase, deduplicate, cap at 20
        aliases = list(dict.fromkeys(
            a.lower().strip() for a in aliases if isinstance(a, str) and a.strip()
        ))[:20]

        logger.info(f"[RoleAliases] Generated {len(aliases)} aliases for '{role}'")
        return {"role": role, "aliases": aliases}

    except json.JSONDecodeError as e:
        logger.error(f"[RoleAliases] JSON parse error for '{role}': {e}")
        raise HTTPException(status_code=500, detail="Failed to parse alias response")
    except Exception as e:
        logger.error(f"[RoleAliases] Failed for '{role}': {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ── PATCH /api/account/preferences ───────────────────────────────────────────
# Merge-safe partial update — called by onboarding flow (one field at a time).
# Unlike PUT /profile which overwrites entirely, this merges into existing prefs.

class PreferencesUpdate(BaseModel):
    target_roles: Optional[List[str]]       = None
    preferred_locations: Optional[List[str]] = None  # onboarding maps location str → list
    min_years: Optional[int]                = None
    max_years: Optional[int]                = None

@router.patch("/preferences")
async def patch_preferences(
    body: PreferencesUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Partial merge update for user preferences. Safe to call with any subset of fields."""
    result = await db.execute(select(User).where(User.id == current_user.id))
    user = result.scalar_one_or_none()

    existing = {**DEFAULT_PREFERENCES, **(user.preferences or {})}

    # Only overwrite fields that were explicitly sent
    updates = body.dict(exclude_none=True)
    merged  = {**existing, **updates}

    await db.execute(
        update(User)
        .where(User.id == current_user.id)
        .values(preferences=merged)
    )
    await db.commit()

    logger.info(f"[Preferences] Partial update for user {current_user.id}: {list(updates.keys())}")
    return {"ok": True, "preferences": merged}


# ── POST /api/account/onboarding/extract-location ───────────────────────────
# Extracts clean location list from free-form onboarding text via LLM.
# Saves preferred_locations to DB and returns the cleaned list.

class ExtractLocationRequest(BaseModel):
    text: str

@router.post("/onboarding/extract-location")
async def extract_location_from_onboarding(
    body: ExtractLocationRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Parse free-form location preference, extract clean location tokens.
    Saves to users.preferences.preferred_locations immediately.
    Returns: { preferred_locations: [...] }
    """
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY not configured")

    prompt = (
        f'The user described where they are open to working:\n\n'
        f'"{body.text}"\n\n'
        f'Extract a clean list of location tokens. Rules:\n'
        f'- Return ONLY a JSON array of strings, no other text, no markdown\n'
        f'- Each item is a short, canonical location string\n'
        f'- If they mention "remote" or "anywhere" → include "Remote"\n'
        f'- For US cities/states → format as "City, State" e.g. "San Francisco, CA"\n'
        f'- For whole states → "Texas", "New York" etc\n'
        f'- If they say "anywhere in the US" or "all over the US" → ["Remote", "United States"]\n'
        f'- Deduplicate — do not repeat the same location twice\n'
        f'- Max 10 items\n'
        f'- Do NOT include long sentences, explanations, or punctuation\n\n'
        f'Example input: "I am open to remote, NYC, or San Francisco"\n'
        f'Example output: ["Remote", "New York, NY", "San Francisco, CA"]\n\n'
        f'Now extract locations from the user text above.'
    )

    try:
        async with httpx.AsyncClient() as client:
            response = await client.post(
                "https://api.openai.com/v1/chat/completions",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": "gpt-4o-mini",
                    "messages": [{"role": "user", "content": prompt}],
                    "temperature": 0.1,
                    "max_tokens": 200,
                },
                timeout=20.0,
            )

        if response.status_code != 200:
            logger.warning(f"[ExtractLocation] OpenAI {response.status_code}")
            raise HTTPException(status_code=502, detail="OpenAI request failed")

        raw = response.json()["choices"][0]["message"]["content"].strip()
        raw = re.sub(r'^```(?:json)?\s*', '', raw)
        raw = re.sub(r'\s*```$', '', raw)
        locations = json.loads(raw.strip())

        if not isinstance(locations, list):
            raise ValueError("expected a list")

        # Normalise: strip, deduplicate, cap at 10
        locations = list(dict.fromkeys(
            loc.strip() for loc in locations if isinstance(loc, str) and loc.strip()
        ))[:10]

    except (json.JSONDecodeError, ValueError) as e:
        logger.error(f"[ExtractLocation] Parse error: {e} — falling back to raw text")
        # Graceful fallback: store the raw input trimmed, better than losing data
        locations = [body.text.strip()[:120]]

    # Merge into existing preferences
    result = await db.execute(select(User).where(User.id == current_user.id))
    user   = result.scalar_one_or_none()
    existing = {**DEFAULT_PREFERENCES, **(user.preferences or {})}
    merged   = {**existing, "preferred_locations": locations}

    await db.execute(
        update(User)
        .where(User.id == current_user.id)
        .values(preferences=merged)
    )
    await db.commit()

    logger.info(f"[ExtractLocation] user={current_user.id} → {locations}")
    return {"preferred_locations": locations}


# ── POST /api/account/onboarding/extract-yoe ─────────────────────────────────
# Extracts years of experience from free-form text via LLM.
# Handles written numbers ("three to four years"), ranges, and vague expressions.
# Saves min_years (and optionally max_years) to DB and returns both.

class ExtractYoeRequest(BaseModel):
    text: str

@router.post("/onboarding/extract-yoe")
async def extract_yoe_from_onboarding(
    body: ExtractYoeRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Parse free-form YOE description, extract min_years and max_years integers.
    Saves to users.preferences immediately.
    Returns: { min_years, max_years }
    """
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY not configured")

    prompt = (
        f'The user described their years of professional experience:\n\n'
        f'"{body.text}"\n\n'
        f'Extract the years of experience as integers. Rules:\n'
        f'- Return ONLY valid JSON, no markdown, no other text\n'
        f'- Convert written numbers to digits: "three" → 3, "five" → 5\n'
        f'- For ranges ("3 to 5 years"): min_years=3, max_years=5\n'
        f'- For single values ("4 years"): min_years=4, max_years=null\n'
        f'- For "around X" or "about X": min_years=X, max_years=null\n'
        f'- For "just graduated" or "fresh grad": min_years=0, max_years=1\n'
        f'- For "10+" or "over 10": min_years=10, max_years=null\n'
        f'- If completely unclear: min_years=null, max_years=null\n\n'
        f'Respond with exactly this shape:\n'
        f'{{"min_years": <int or null>, "max_years": <int or null>}}'
    )

    try:
        async with httpx.AsyncClient() as client:
            response = await client.post(
                "https://api.openai.com/v1/chat/completions",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": "gpt-4o-mini",
                    "messages": [{"role": "user", "content": prompt}],
                    "temperature": 0.0,
                    "max_tokens": 60,
                },
                timeout=20.0,
            )

        if response.status_code != 200:
            logger.warning(f"[ExtractYoe] OpenAI {response.status_code}")
            raise HTTPException(status_code=502, detail="OpenAI request failed")

        raw = response.json()["choices"][0]["message"]["content"].strip()
        raw = re.sub(r'^```(?:json)?\s*', '', raw)
        raw = re.sub(r'\s*```$', '', raw)
        parsed = json.loads(raw.strip())

        min_years = parsed.get("min_years")
        max_years = parsed.get("max_years")

        # Validate types — must be int or None
        if min_years is not None:
            min_years = int(min_years)
        if max_years is not None:
            max_years = int(max_years)

    except (json.JSONDecodeError, ValueError, KeyError) as e:
        logger.error(f"[ExtractYoe] Parse error: {e} — storing null")
        min_years = None
        max_years = None

    # Merge into existing preferences
    result = await db.execute(select(User).where(User.id == current_user.id))
    user   = result.scalar_one_or_none()
    existing = {**DEFAULT_PREFERENCES, **(user.preferences or {})}
    merged   = {**existing, "min_years": min_years, "max_years": max_years}

    await db.execute(
        update(User)
        .where(User.id == current_user.id)
        .values(preferences=merged)
    )
    await db.commit()

    logger.info(f"[ExtractYoe] user={current_user.id} → min={min_years}, max={max_years}")
    return {"min_years": min_years, "max_years": max_years}


# ── POST /api/account/onboarding/extract-roles ───────────────────────────────
# Extracts structured target_roles from free-form onboarding text.
# Generates aliases for each role in one LLM call (vs one call per role in /role-aliases).
# Saves target_roles + role_aliases to DB atomically before returning.

class ExtractRolesRequest(BaseModel):
    text: str

@router.post("/onboarding/extract-roles")
async def extract_roles_from_onboarding(
    body: ExtractRolesRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Parse free-form role description, extract clean role titles, generate aliases.
    Saves to users.preferences immediately so the pipeline can use them.
    Returns: { target_roles, alias_count }
    """
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY not configured")

    prompt = (
        f'''The user is setting up their job search profile. They described their target roles:

"{body.text}"

Extract the distinct job role CATEGORIES they are targeting.

Rules:
- Normalize to clean, common job title format (Title Case, no slashes)
- Max 5 roles
- Strip seniority level (senior/junior/lead) from role name — just the core category
- If text is vague, infer best guess
- For each role, list 12–18 related job titles a recruiter might use (lowercase, common variants)

Respond ONLY with valid JSON, no preamble, no markdown:
{{
  "target_roles": ["Role 1", "Role 2"],
  "role_aliases": {{
    "Role 1": ["alias a", "alias b", "alias c"],
    "Role 2": ["alias a", "alias b"]
  }}
}}'''
    )

    try:
        async with httpx.AsyncClient() as client:
            response = await client.post(
                "https://api.openai.com/v1/chat/completions",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": "gpt-4o-mini",
                    "messages": [{"role": "user", "content": prompt}],
                    "temperature": 0.2,
                    "max_tokens": 600,
                },
                timeout=20.0,
            )

        if response.status_code != 200:
            logger.warning(f"[ExtractRoles] OpenAI {response.status_code}")
            raise HTTPException(status_code=502, detail="OpenAI request failed")

        raw = response.json()["choices"][0]["message"]["content"].strip()
        raw = re.sub(r'^```(?:json)?\s*', '', raw)
        raw = re.sub(r'\s*```$', '', raw)
        parsed = json.loads(raw.strip())

    except (json.JSONDecodeError, KeyError) as e:
        logger.error(f"[ExtractRoles] Parse error: {e}")
        raise HTTPException(status_code=500, detail="Failed to parse LLM response")

    target_roles = parsed.get("target_roles", [])
    role_aliases = parsed.get("role_aliases", {})

    # Normalise aliases: lowercase, deduplicate, cap at 20 per role
    for role in list(role_aliases.keys()):
        aliases = list(dict.fromkeys(
            a.lower().strip() for a in role_aliases[role]
            if isinstance(a, str) and a.strip()
        ))[:20]
        role_aliases[role] = aliases

    alias_count = sum(len(v) for v in role_aliases.values())

    # Merge into existing preferences atomically
    result = await db.execute(select(User).where(User.id == current_user.id))
    user   = result.scalar_one_or_none()
    existing = {**DEFAULT_PREFERENCES, **(user.preferences or {})}
    merged   = {
        **existing,
        "target_roles": target_roles,
        "role_aliases": role_aliases,
    }

    await db.execute(
        update(User)
        .where(User.id == current_user.id)
        .values(preferences=merged)
    )
    await db.commit()

    logger.info(
        f"[ExtractRoles] user={current_user.id} → {len(target_roles)} roles, "
        f"{alias_count} total aliases"
    )
    return {
        "target_roles": target_roles,
        "alias_count": alias_count,
    }