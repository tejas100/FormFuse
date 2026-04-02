"""
routers/tracking.py — Auto-match pipeline API endpoints.

Session 16: auto_refresh() passes db into run_auto_pipeline() for pgvector.
Session 20: DB-backed snapshot history.
Session 21: Normalized auto_match_results schema — one row per (user, job).
  - Removed GET /auto/run-dates  (snapshot history gone)
  - Removed run_date param from GET /auto/matches
  - Added recency_days param to GET /auto/matches (1 / 7 / 30 / None=all)
  - archive_jobs_for_user() now also deletes rows from auto_match_results
  - Imports updated: _load_snapshot_from_db/_get_run_dates_from_db removed
"""

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
    _load_results_from_db,
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
    force=True bypasses the results cache (re-checks for new jobs)
    but does NOT re-fetch the Greenhouse pool if it's still fresh.
    """
    result = await db.execute(select(User).where(User.id == current_user.id))
    user = result.scalar_one_or_none()
    profile = {**DEFAULT_PREFS, **(user.preferences or {})} if user else DEFAULT_PREFS

    user_id = str(current_user.id)
    return await run_auto_pipeline(user_id=user_id, profile=profile, force=req.force, db=db)


@router.get("/auto/matches")
async def auto_matches(
    limit: int = DISPLAY_CAP,
    recency_days: Optional[int] = Query(
        default=None,
        description="Filter by posting recency: 1, 7, or 30 days. Omit for all time."
    ),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Return scored auto-match results for the authenticated user.
    Results are ordered by score DESC.

    Optional recency_days filter:
      ?recency_days=1  → posted in last 24 hours
      ?recency_days=7  → posted in last 7 days
      ?recency_days=30 → posted in last 30 days
      (omit)           → all scored jobs, no recency filter
    """
    user_id = str(current_user.id)
    results = await _load_results_from_db(
        user_id=user_id,
        db=db,
        recency_days=recency_days,
        limit=limit,
    )
    return results


@router.get("/auto/meta")
async def auto_meta(
    current_user: User = Depends(get_current_user),
):
    """Return pipeline metadata (last_fetch_at) for the authenticated user."""
    user_id = str(current_user.id)
    return _load_auto_meta_for_user(user_id)


@router.get("/auto/fresh")
async def auto_fresh(
    hours: int = Query(default=24, ge=1, le=168, description="Return jobs posted within the last N hours. Max 168 (7 days)."),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Return recently posted jobs from auto_match_results, sorted by posted_at DESC.
    These are jobs RACK has already scored — filtered by how recently they were posted.

    ?hours=1   → posted in the last hour
    ?hours=6   → posted in the last 6 hours
    ?hours=24  → posted today (default)
    ?hours=168 → posted in the last 7 days
    """
    from models.orm import AutoMatchResult, ArchivedJobId
    from sqlalchemy import select as sa_select
    import uuid as _uuid
    from datetime import datetime, timezone, timedelta

    user_uuid = _uuid.UUID(str(current_user.id))
    cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)

    # Exclude archived jobs
    archived_stmt = sa_select(ArchivedJobId.job_id).where(
        ArchivedJobId.user_id == user_uuid
    )
    archived_result = await db.execute(archived_stmt)
    archived_ids = {r[0] for r in archived_result.fetchall()}

    stmt = (
        sa_select(AutoMatchResult)
        .where(AutoMatchResult.user_id == user_uuid)
        .where(AutoMatchResult.posted_at >= cutoff)
        .order_by(AutoMatchResult.posted_at.desc())
        .limit(100)
    )
    if archived_ids:
        stmt = stmt.where(AutoMatchResult.job_id.notin_(archived_ids))

    result = await db.execute(stmt)
    rows = result.scalars().all()
    jobs = [row.job_data for row in rows]

    return {"jobs": jobs, "total": len(jobs), "hours": hours}


@router.post("/auto/archive")
async def auto_archive(
    req: AutoArchiveRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Permanently archive job IDs for the authenticated user.
    Archived jobs are removed from auto_match_results immediately
    and excluded from all future pipeline runs.
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