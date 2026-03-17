"""
routers/account.py — API endpoints for user profile management.

Endpoints:
  GET  /api/account/profile     — Get current user's preferences from DB
  PUT  /api/account/profile     — Save current user's preferences to DB
  GET  /api/account/presets     — Get role/location presets for the form
"""

import logging
from typing import Optional
from fastapi import APIRouter, Depends
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
}


class ProfileUpdate(BaseModel):
    target_roles: Optional[list[str]] = None
    preferred_locations: Optional[list[str]] = None
    min_years: Optional[int] = None
    max_years: Optional[int] = None
    include_keywords: Optional[list[str]] = None
    exclude_keywords: Optional[list[str]] = None


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