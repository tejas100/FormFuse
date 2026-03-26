"""
routers/tracking.py — Auto-match pipeline API endpoints.

Session 16: auto_refresh() passes db into run_auto_pipeline() for pgvector.
Session 20: DB-backed snapshot history.
  - GET /auto/run-dates   → list of dates that have snapshots for this user
  - GET /auto/matches     → now accepts optional ?date=YYYY-MM-DD param
  - POST /auto/archive    → writes to archived_job_ids DB table (global archive)
"""

from datetime import date as date_type
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from pydantic import BaseModel

from db.database import get_db
from models.orm import User
from routers.auth import get_current_user
from services.auto_match import (
    run_auto_pipeline,
    archive_jobs_for_user,
    _load_auto_meta_for_user,
    _load_snapshot_from_db,
    _get_run_dates_from_db,
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
    """Run the auto-match pipeline for the authenticated user."""
    result = await db.execute(select(User).where(User.id == current_user.id))
    user = result.scalar_one_or_none()
    profile = {**DEFAULT_PREFS, **(user.preferences or {})} if user else DEFAULT_PREFS

    user_id = str(current_user.id)
    return await run_auto_pipeline(user_id=user_id, profile=profile, force=req.force, db=db)


@router.get("/auto/run-dates")
async def auto_run_dates(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Return all dates that have a stored snapshot for this user, newest first.
    Response: ["2026-03-25", "2026-03-24", ...]
    """
    user_id = str(current_user.id)
    dates = await _get_run_dates_from_db(user_id, db)
    return {"dates": dates}


@router.get("/auto/matches")
async def auto_matches(
    limit: int = DISPLAY_CAP,
    run_date: Optional[str] = Query(default=None, description="YYYY-MM-DD — fetch a specific snapshot. Omit for most recent."),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Return stored auto match results for the authenticated user.
    Pass ?run_date=YYYY-MM-DD to retrieve a historical snapshot.
    Omit run_date to get the most recent snapshot.
    Archived job IDs are filtered out automatically.
    """
    user_id = str(current_user.id)

    parsed_date = None
    if run_date:
        try:
            parsed_date = date_type.fromisoformat(run_date)
        except ValueError:
            raise HTTPException(status_code=400, detail=f"Invalid date format: {run_date!r}. Use YYYY-MM-DD.")

    results = await _load_snapshot_from_db(user_id, db, run_date=parsed_date)
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
    db: AsyncSession = Depends(get_db),
):
    """
    Permanently archive job IDs for the authenticated user.
    These IDs will be filtered from ALL snapshots going forward.
    """
    if not req.job_ids:
        raise HTTPException(status_code=400, detail="job_ids list cannot be empty")
    user_id = str(current_user.id)
    return await archive_jobs_for_user(user_id=user_id, job_ids=req.job_ids, db=db)


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