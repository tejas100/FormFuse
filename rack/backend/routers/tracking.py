"""
routers/tracking.py — Auto-match pipeline API endpoints.

Session 16 change: auto_refresh() passes db into run_auto_pipeline()
so the pgvector search has a live DB session. Everything else unchanged.
"""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from pydantic import BaseModel
from typing import Optional

from db.database import get_db
from models.orm import User
from routers.auth import get_current_user
from services.auto_match import (
    run_auto_pipeline,
    archive_jobs_for_user,
    _load_auto_results_for_user,
    _load_auto_meta_for_user,
    DISPLAY_CAP,
)

# Legacy watchlist/custom-search services (Custom Search tab — unchanged)
from services.watchlist import (
    get_watchlist,
    add_company,
    remove_company,
    update_settings,
    get_presets,
    fetch_watchlist_jobs,
    run_auto_match,
    refresh_pipeline,
    get_match_results,
    clear_match_history,
    get_watchlist_stats,
)

router = APIRouter(prefix="/api/tracking", tags=["tracking"])


# ── Default empty preferences ─────────────────────────────────────────
DEFAULT_PREFS = {
    "target_roles": [],
    "preferred_locations": [],
    "min_years": None,
    "max_years": None,
    "include_keywords": [],
    "exclude_keywords": [],
}


# ── Request models ────────────────────────────────────────────────────
class AutoRefreshRequest(BaseModel):
    force: bool = False


class AutoArchiveRequest(BaseModel):
    job_ids: list[str]


class AddCompanyRequest(BaseModel):
    company: str
    source: str = "greenhouse"
    label: str = ""


class RemoveCompanyRequest(BaseModel):
    company: str
    source: str = "greenhouse"


class MatchRequest(BaseModel):
    title_filter: Optional[str] = None
    company_filter: Optional[str] = None
    date_filter: Optional[str] = None
    use_profile: bool = True
    limit: int = 20


class RefreshRequest(BaseModel):
    date_filter: Optional[str] = None
    use_profile: bool = True
    limit: int = 20
    force_fetch: bool = False


class SettingsRequest(BaseModel):
    auto_match: Optional[bool] = None
    min_score_alert: Optional[int] = None
    match_use_llm: Optional[bool] = None


# ── Auto Matches — user-scoped ────────────────────────────────────────

@router.post("/auto/refresh")
async def auto_refresh(
    req: AutoRefreshRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Run the auto-match pipeline for the authenticated user.
    Reads their preferences from DB, scopes pgvector search to their user_id.
    """
    result = await db.execute(select(User).where(User.id == current_user.id))
    user = result.scalar_one_or_none()
    profile = {**DEFAULT_PREFS, **(user.preferences or {})} if user else DEFAULT_PREFS

    user_id = str(current_user.id)
    # ── KEY CHANGE: pass db so run_auto_pipeline can do pgvector search ──
    return await run_auto_pipeline(user_id=user_id, profile=profile, force=req.force, db=db)


@router.get("/auto/matches")
async def auto_matches(
    limit: int = DISPLAY_CAP,
    current_user: User = Depends(get_current_user),
):
    """Return stored auto match results for the authenticated user."""
    user_id = str(current_user.id)
    results = _load_auto_results_for_user(user_id)
    return results[:limit]


@router.get("/auto/meta")
async def auto_meta(
    current_user: User = Depends(get_current_user),
):
    """Return pipeline metadata (last_fetch_at, stats) for the authenticated user."""
    user_id = str(current_user.id)
    return _load_auto_meta_for_user(user_id)


@router.post("/auto/archive")
async def auto_archive(
    req: AutoArchiveRequest,
    current_user: User = Depends(get_current_user),
):
    """Permanently archive job IDs for the authenticated user."""
    if not req.job_ids:
        raise HTTPException(status_code=400, detail="job_ids list cannot be empty")
    user_id = str(current_user.id)
    return archive_jobs_for_user(user_id=user_id, job_ids=req.job_ids)


# ── Stats + Presets (shared, no auth needed) ──────────────────────────

@router.get("/stats")
async def stats():
    return get_watchlist_stats()


@router.get("/presets")
async def presets():
    return get_presets()


# ── Watchlist CRUD (Custom Search tab — unchanged) ────────────────────

@router.get("/watchlist")
async def watchlist():
    return get_watchlist()


@router.post("/watchlist")
async def add(req: AddCompanyRequest):
    return add_company(req.company, req.source, req.label)


@router.delete("/watchlist")
async def remove(req: RemoveCompanyRequest):
    return remove_company(req.company, req.source)


@router.put("/settings")
async def settings_update(req: SettingsRequest):
    updates = {k: v for k, v in req.dict().items() if v is not None}
    return update_settings(updates)


# ── Custom Search pipeline (unchanged) ───────────────────────────────

@router.post("/fetch")
async def fetch():
    return await fetch_watchlist_jobs(force=True)


@router.post("/refresh")
async def refresh(req: RefreshRequest):
    return await refresh_pipeline(
        date_filter=req.date_filter,
        use_profile=req.use_profile,
        limit=req.limit,
        force_fetch=req.force_fetch,
    )


@router.post("/match")
async def match(req: MatchRequest):
    return await run_auto_match(
        title_filter=req.title_filter,
        company_filter=req.company_filter,
        date_filter=req.date_filter,
        use_profile=req.use_profile,
        limit=req.limit,
    )


@router.get("/matches")
async def matches(
    company: Optional[str] = None,
    min_score: Optional[int] = None,
    limit: int = 50,
):
    return get_match_results(company=company, min_score=min_score, limit=limit)


@router.delete("/matches")
async def clear_matches():
    return clear_match_history()