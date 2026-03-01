"""
routers/tracking.py — API endpoints for the RACK Job Watchlist Pipeline.

UPDATED: Added date_filter and use_profile to auto-match endpoint.

Endpoints:
  GET  /api/tracking/stats          — Dashboard overview stats
  GET  /api/tracking/presets        — Preset companies for quick-add
  GET  /api/tracking/watchlist      — Current watchlist
  POST /api/tracking/watchlist      — Add company to watchlist
  DELETE /api/tracking/watchlist     — Remove company from watchlist
  PUT  /api/tracking/settings       — Update watchlist settings
  POST /api/tracking/fetch          — Fetch jobs from all watchlist companies
  GET  /api/tracking/jobs           — Get fetched jobs (with filters)
  POST /api/tracking/match          — Run auto-match (with profile + date filtering)
  GET  /api/tracking/matches        — Get stored match results
  DELETE /api/tracking/matches      — Clear match history
"""

import logging
from typing import Optional
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from services.watchlist import (
    get_watchlist,
    add_company,
    remove_company,
    update_settings,
    get_presets,
    fetch_watchlist_jobs,
    get_fetched_jobs,
    run_auto_match,
    get_match_results,
    clear_match_history,
    get_watchlist_stats,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/tracking", tags=["tracking"])


# ── Request schemas ─────────────────────────────────────────────────
class AddCompanyRequest(BaseModel):
    company: str
    source: str
    label: str = ""


class RemoveCompanyRequest(BaseModel):
    company: str
    source: str


class SettingsUpdate(BaseModel):
    auto_match: Optional[bool] = None
    min_score_alert: Optional[int] = None
    match_use_llm: Optional[bool] = None


class AutoMatchRequest(BaseModel):
    title_filter: Optional[str] = None
    company_filter: Optional[str] = None
    date_filter: Optional[str] = None      # "24h", "7d", "30d", or None
    use_profile: bool = True                # apply user profile filters
    limit: int = 20


# ── Stats / Dashboard ──────────────────────────────────────────────
@router.get("/stats")
async def stats():
    return get_watchlist_stats()


# ── Presets ─────────────────────────────────────────────────────────
@router.get("/presets")
async def presets():
    return get_presets()


# ── Watchlist CRUD ──────────────────────────────────────────────────
@router.get("/watchlist")
async def list_watchlist():
    return get_watchlist()


@router.post("/watchlist")
async def add_to_watchlist(req: AddCompanyRequest):
    if req.source not in ("greenhouse", "lever"):
        raise HTTPException(400, "Source must be 'greenhouse' or 'lever'")
    return add_company(req.company, req.source, req.label)


@router.delete("/watchlist")
async def remove_from_watchlist(req: RemoveCompanyRequest):
    return remove_company(req.company, req.source)


@router.put("/settings")
async def update_watchlist_settings(req: SettingsUpdate):
    updates = {k: v for k, v in req.dict().items() if v is not None}
    if not updates:
        raise HTTPException(400, "No settings to update")
    return update_settings(updates)


# ── Job Fetching ────────────────────────────────────────────────────
@router.post("/fetch")
async def fetch_jobs():
    try:
        result = await fetch_watchlist_jobs()
        return result
    except Exception as e:
        logger.error(f"Fetch failed: {e}")
        raise HTTPException(500, f"Failed to fetch jobs: {str(e)}")


@router.get("/jobs")
async def list_jobs(
    company: Optional[str] = Query(None),
    search: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=200),
):
    return get_fetched_jobs(company=company, title_search=search, limit=limit)


# ── Auto-Match (UPDATED) ───────────────────────────────────────────
@router.post("/match")
async def auto_match(req: AutoMatchRequest):
    """
    Run auto-match with profile-based and date-based pre-filtering.
    Pipeline: fetch → date filter → profile filter → RACK match → results
    """
    try:
        result = await run_auto_match(
            title_filter=req.title_filter,
            company_filter=req.company_filter,
            date_filter=req.date_filter,
            use_profile=req.use_profile,
            limit=req.limit,
        )
        return result
    except Exception as e:
        logger.error(f"Auto-match failed: {e}")
        raise HTTPException(500, f"Auto-match failed: {str(e)}")


@router.get("/matches")
async def list_matches(
    company: Optional[str] = Query(None),
    min_score: Optional[int] = Query(None, ge=0, le=100),
    limit: int = Query(50, ge=1, le=200),
):
    return get_match_results(company=company, min_score=min_score, limit=limit)


@router.delete("/matches")
async def clear_matches():
    return clear_match_history()