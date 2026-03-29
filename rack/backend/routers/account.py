"""
routers/account.py — API endpoints for user profile management.

Endpoints:
  GET  /api/account/profile     — Get current user's preferences from DB
  PUT  /api/account/profile     — Save current user's preferences to DB
  GET  /api/account/presets     — Get role/location presets for the form
"""

import logging
import os
import json
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, update
from pydantic import BaseModel
from openai import AsyncOpenAI

from db.database import get_db
from models.orm import User
from routers.auth import get_current_user
from services.user_profile import get_presets

_openai = AsyncOpenAI(api_key=os.getenv("OPENAI_API_KEY"))

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
    target_roles: Optional[list[str]] = None
    preferred_locations: Optional[list[str]] = None
    min_years: Optional[int] = None
    max_years: Optional[int] = None
    include_keywords: Optional[list[str]] = None
    exclude_keywords: Optional[list[str]] = None
    role_aliases: Optional[dict[str, list[str]]] = None


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
    new_prefs = {
        "target_roles": req.target_roles or [],
        "preferred_locations": req.preferred_locations or [],
        "min_years": req.min_years,
        "max_years": req.max_years,
        "include_keywords": req.include_keywords or [],
        "exclude_keywords": req.exclude_keywords or [],
        "role_aliases": req.role_aliases or {},
    }

    await db.execute(
        update(User)
        .where(User.id == current_user.id)
        .values(preferences=new_prefs)
    )
    await db.commit()

    logger.info(f"Preferences saved for user {current_user.id}")
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
    target role. Returns a list of lowercase title strings that Filter A can
    match against the job pool.
    """
    role = req.role.strip()
    if not role:
        raise HTTPException(status_code=400, detail="role is required")

    prompt = f"""You are a job market expert. For the target role "{role}", list all closely related job titles that a recruiter might use when posting that same type of position.

Rules:
- Return ONLY a JSON array of strings, no other text
- 15 to 20 items
- All lowercase
- Include common variants, abbreviations, and synonym titles
- Include both senior and non-senior variants if the base role is mid-level
- Do NOT include roles from entirely different fields
- Do NOT include management or director roles unless the input is already senior

Example for "ML Engineer":
["machine learning engineer", "ml engineer", "machine learning software engineer", "ai/ml engineer", "ml platform engineer", "ml infrastructure engineer", "applied ml engineer", "mlops engineer", "ml research engineer", "senior ml engineer", "staff ml engineer", "machine learning developer", "deep learning engineer", "ai engineer", "machine learning scientist"]

Now return the array for: "{role}" """

    try:
        response = await _openai.chat.completions.create(
            model="gpt-4o-mini",
            messages=[{"role": "user", "content": prompt}],
            temperature=0.3,
            max_tokens=400,
        )
        raw = response.choices[0].message.content.strip()
        # Strip markdown fences if present
        if raw.startswith("```"):
            raw = raw.split("```")[1]
            if raw.startswith("json"):
                raw = raw[4:]
        aliases = json.loads(raw.strip())
        if not isinstance(aliases, list):
            raise ValueError("expected a list")
        # Normalise: lowercase, deduplicate, cap at 20
        aliases = list(dict.fromkeys(a.lower().strip() for a in aliases if isinstance(a, str) and a.strip()))[:20]
        logger.info(f"Generated {len(aliases)} aliases for '{role}'")
        return {"role": role, "aliases": aliases}
    except Exception as e:
        logger.error(f"Role alias generation failed for '{role}': {e}")
        raise HTTPException(status_code=500, detail=f"Alias generation failed: {str(e)}")