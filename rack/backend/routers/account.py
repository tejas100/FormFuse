"""
routers/account.py — API endpoints for user profile management.

Endpoints:
  GET  /api/account/profile     — Get current profile
  PUT  /api/account/profile     — Update profile
  GET  /api/account/presets     — Get role/location presets for the form
"""

import logging
from typing import Optional
from fastapi import APIRouter
from pydantic import BaseModel

from services.user_profile import get_profile, update_profile, get_presets

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/account", tags=["account"])


class ProfileUpdate(BaseModel):
    target_roles: Optional[list[str]] = None
    preferred_locations: Optional[list[str]] = None
    min_years: Optional[int] = None
    max_years: Optional[int] = None
    include_keywords: Optional[list[str]] = None
    exclude_keywords: Optional[list[str]] = None


@router.get("/profile")
async def read_profile():
    """Get current user profile."""
    return get_profile()


@router.put("/profile")
async def save_profile(req: ProfileUpdate):
    """Update user profile."""
    return update_profile(
        target_roles=req.target_roles,
        preferred_locations=req.preferred_locations,
        min_years=req.min_years,
        max_years=req.max_years,
        include_keywords=req.include_keywords,
        exclude_keywords=req.exclude_keywords,
    )


@router.get("/presets")
async def profile_presets():
    """Get preset options for the profile form."""
    return get_presets()