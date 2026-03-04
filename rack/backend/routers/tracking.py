"""
routers/tracking.py — Job watchlist & auto-match API endpoints.

UPDATED v4: New /refresh endpoint for fully automated pipeline.
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional

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


# ── Request models ──────────────────────────────────────────────────
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


# ── Stats ───────────────────────────────────────────────────────────
@router.get("/stats")
async def stats():
    return get_watchlist_stats()


# ── Presets ─────────────────────────────────────────────────────────
@router.get("/presets")
async def presets():
    return get_presets()


# ── Watchlist CRUD ──────────────────────────────────────────────────
@router.get("/watchlist")
async def watchlist():
    return get_watchlist()


@router.post("/watchlist")
async def add(req: AddCompanyRequest):
    result = add_company(req.company, req.source, req.label)
    return result


@router.delete("/watchlist")
async def remove(req: RemoveCompanyRequest):
    result = remove_company(req.company, req.source)
    return result


@router.put("/settings")
async def settings_update(req: SettingsRequest):
    updates = {k: v for k, v in req.dict().items() if v is not None}
    return update_settings(updates)


# ── Fetch jobs ──────────────────────────────────────────────────────
@router.post("/fetch")
async def fetch():
    return await fetch_watchlist_jobs(force=True)


# ── NEW: Refresh pipeline (fetch + filter + match in ONE call) ──────
@router.post("/refresh")
async def refresh(req: RefreshRequest):
    """
    The primary endpoint for the Tracking page.
    Does everything: fetch (if stale) → filter → match → return top jobs.
    """
    return await refresh_pipeline(
        date_filter=req.date_filter,
        use_profile=req.use_profile,
        limit=req.limit,
        force_fetch=req.force_fetch,
    )


# ── Legacy auto-match (backward compat) ────────────────────────────
@router.post("/match")
async def match(req: MatchRequest):
    return await run_auto_match(
        title_filter=req.title_filter,
        company_filter=req.company_filter,
        date_filter=req.date_filter,
        use_profile=req.use_profile,
        limit=req.limit,
    )


# ── Match results ──────────────────────────────────────────────────
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