"""
routers/tracking.py — Job watchlist & auto-match API endpoints.

UPDATED v5:
  - /auto/refresh  → fully automatic pipeline (Remotive by target_roles)
  - /auto/matches  → load stored auto match results
  - /auto/meta     → last fetch time + stats
  All previous endpoints unchanged.
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
from services.auto_match import (
    run_auto_pipeline,
    archive_jobs,
    _load_auto_results,
    _load_auto_meta,
    DISPLAY_CAP,
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


class AutoRefreshRequest(BaseModel):
    force: bool = False


class AutoArchiveRequest(BaseModel):
    job_ids: list[str]


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


# ── Custom: Refresh pipeline (fetch + filter + match in ONE call) ───
@router.post("/refresh")
async def refresh(req: RefreshRequest):
    """
    Custom Search tab: fetch watchlist companies → filter → match → return top jobs.
    """
    return await refresh_pipeline(
        date_filter=req.date_filter,
        use_profile=req.use_profile,
        limit=req.limit,
        force_fetch=req.force_fetch,
    )


# ── Auto Matches: fully automatic pipeline ──────────────────────────
@router.post("/auto/refresh")
async def auto_refresh(req: AutoRefreshRequest):
    """
    Auto Matches tab: Remotive search by target_roles → filter 24h → score → return.
    Long-running: ~30-120s depending on number of target roles and jobs to score.
    """
    return await run_auto_pipeline(force=req.force)


@router.get("/auto/matches")
async def auto_matches(limit: int = DISPLAY_CAP):
    """Return stored auto match results without re-fetching."""
    results = _load_auto_results()
    return results[:limit]


@router.get("/auto/meta")
async def auto_meta():
    """Return metadata about the last auto fetch (last_fetch_at, seen count, etc.)."""
    return _load_auto_meta()


@router.post("/auto/archive")
async def auto_archive(req: AutoArchiveRequest):
    """
    Permanently archive job IDs — they will never resurface in Auto Matches,
    even after seen_job_ids resets. Also removes them from stored results immediately.
    """
    if not req.job_ids:
        raise HTTPException(status_code=400, detail="job_ids list cannot be empty")
    return archive_jobs(req.job_ids)


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


# ── Match results (Custom tab) ──────────────────────────────────────
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