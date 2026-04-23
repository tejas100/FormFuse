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
Session 50: run_auto_pipeline() now requires job_pool parameter.
  - auto_refresh() loads cached pool from disk or fetches fresh — never calls
    job board APIs blindly. Consistent with two-phase scheduler architecture.
"""

from typing import Optional
from datetime import datetime, timezone
import logging

logger = logging.getLogger(__name__)

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, update
from pydantic import BaseModel

from db.database import get_db
from models.orm import User
from routers.auth import get_current_user
from services.auto_match import (
    run_auto_pipeline,
    archive_jobs_for_user,
    _load_auto_meta_for_user,
    _load_results_from_db,
    _is_pool_cache_fresh,
    _load_pool_from_disk,
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
    Admin/Pro: Run the auto-match pipeline. force=True bypasses staleness cache.
    Free users: Return their cumulative daily_slot_log immediately — no pipeline trigger.
    """
    user_role = getattr(current_user, "role", "free") or "free"
    user_id   = str(current_user.id)

    # Free users never trigger the pipeline — return their slot view instantly
    if user_role not in ("admin", "pro"):
        from models.orm import AutoMatchResult, DailySlotLog
        import uuid as _uuid
        from datetime import date

        user_uuid = _uuid.UUID(user_id)
        today = date.today()

        slots_stmt = (
            select(DailySlotLog)
            .where(DailySlotLog.user_id == user_uuid)
            .order_by(DailySlotLog.slot_date.desc(), DailySlotLog.served_at.desc())
        )
        slots_result = await db.execute(slots_stmt)
        slots = slots_result.scalars().all()

        served_job_ids = [s.job_id for s in slots]
        matches = []
        if served_job_ids:
            from sqlalchemy import select as sa_select
            jobs_stmt = (
                sa_select(AutoMatchResult)
                .where(AutoMatchResult.user_id == user_uuid)
                .where(AutoMatchResult.job_id.in_(served_job_ids))
            )
            jobs_result = await db.execute(jobs_stmt)
            job_rows = {r.job_id: r for r in jobs_result.scalars().all()}
            for slot in slots:
                row = job_rows.get(slot.job_id)
                if row:
                    job = dict(row.job_data or {})
                    job["score"]       = slot.score
                    job["rank_reason"] = slot.rank_reason
                    job["is_new"]      = (slot.slot_date == today)
                    matches.append(job)

        return {
            "matches": matches,
            "stats":   {"from_cache": True, "is_slot_view": True},
            "from_cache": True,
            "is_slot_view": True,
        }

    # Admin/Pro — run scoring pipeline against cached pool only.
    # NEVER fetch from job boards here — that is exclusively the scheduler's job.
    # If the pool is stale (e.g. after Render restart), serve DB results immediately.
    # The scheduler will replenish the pool and score new jobs within 60 minutes.
    result = await db.execute(select(User).where(User.id == current_user.id))
    user   = result.scalar_one_or_none()
    profile = {**DEFAULT_PREFS, **(user.preferences or {})} if user else DEFAULT_PREFS

    if _is_pool_cache_fresh():
        job_pool = _load_pool_from_disk()
        logger.info(f"[auto_refresh] Using cached pool: {len(job_pool)} jobs")
        return await run_auto_pipeline(
            user_id=user_id,
            profile=profile,
            job_pool=job_pool,
            force=req.force,
            db=db,
        )
    else:
        logger.info(f"[auto_refresh] Pool stale — serving DB results for user={user_id} (scheduler will refresh)")
        matches = await _load_results_from_db(user_id=user_id, db=db, limit=DISPLAY_CAP)
        return {
            "matches":    matches.get("matches", []),
            "stats":      {"from_cache": True, "pool_stale": True},
            "from_cache": True,
        }


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

    Admin/Pro: full auto_match_results, ordered by score DESC.
    Free: cumulative daily_slot_log results only (grows day by day),
          with is_new=True on today's picks.
    """
    user_id = str(current_user.id)
    user_role = getattr(current_user, "role", "free") or "free"

    # Admin and pro users get the full list — unchanged behavior
    if user_role in ("admin", "pro"):
        results = await _load_results_from_db(
            user_id=user_id,
            db=db,
            recency_days=recency_days,
            limit=limit,
        )
        return results

    # Free users: return cumulative served jobs from daily_slot_log
    from models.orm import AutoMatchResult, DailySlotLog
    import uuid as _uuid
    from datetime import date

    user_uuid = _uuid.UUID(user_id)
    today = date.today()

    # All slots ever served for this user, newest batch first
    slots_stmt = (
        select(DailySlotLog)
        .where(DailySlotLog.user_id == user_uuid)
        .order_by(DailySlotLog.slot_date.desc(), DailySlotLog.served_at.desc())
    )
    slots_result = await db.execute(slots_stmt)
    slots = slots_result.scalars().all()

    if not slots:
        return {"matches": [], "total": 0, "is_slot_view": True}

    # Fetch full job_data for each served slot
    served_job_ids = [s.job_id for s in slots]
    jobs_stmt = (
        select(AutoMatchResult)
        .where(AutoMatchResult.user_id == user_uuid)
        .where(AutoMatchResult.job_id.in_(served_job_ids))
    )
    jobs_result = await db.execute(jobs_stmt)
    job_rows = {r.job_id: r for r in jobs_result.scalars().all()}

    matches = []
    for slot in slots:
        row = job_rows.get(slot.job_id)
        if not row:
            continue
        job = dict(row.job_data or {})
        job["score"]       = slot.score
        job["rank_reason"] = slot.rank_reason
        job["is_new"]      = (slot.slot_date == today)
        job["served_at"]   = slot.served_at.isoformat() if slot.served_at else None
        matches.append(job)

    return {"matches": matches, "total": len(matches), "is_slot_view": True}


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


@router.patch("/auto/{job_id}/applied")
async def mark_job_applied(
    job_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Mark a specific auto-match job as applied for the authenticated user.
    Sets applied=True and records applied_at timestamp.
    Idempotent — safe to call multiple times.
    """
    from models.orm import AutoMatchResult
    import uuid as _uuid

    user_uuid = _uuid.UUID(str(current_user.id))

    # Verify the row exists for this user
    stmt = select(AutoMatchResult).where(
        AutoMatchResult.user_id == user_uuid,
        AutoMatchResult.job_id == job_id,
    )
    result = await db.execute(stmt)
    row = result.scalar_one_or_none()

    if not row:
        raise HTTPException(status_code=404, detail="Job not found in your matches")

    # Idempotent: only update if not already applied
    if not row.applied:
        upd = (
            update(AutoMatchResult)
            .where(
                AutoMatchResult.user_id == user_uuid,
                AutoMatchResult.job_id == job_id,
            )
            .values(applied=True, applied_at=datetime.now(timezone.utc))
        )
        await db.execute(upd)
        await db.commit()

    return {"job_id": job_id, "applied": True, "applied_at": row.applied_at or datetime.now(timezone.utc)}


@router.get("/daily-slots")
async def daily_slots(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Return today's daily slot recommendations (6-8 jobs).
    - Top 4 by score DESC (rank_reason='score')
    - Top 4 by posted_at DESC (rank_reason='recency'), deduped against score picks
    - Cached in daily_slot_log — same set returned all day, regenerated at midnight UTC
    """
    from models.orm import AutoMatchResult, ArchivedJobId, DailySlotLog
    import uuid as _uuid
    from datetime import date

    user_uuid = _uuid.UUID(str(current_user.id))
    today = date.today()  # UTC date

    # --- Check if we already served slots today ---
    existing_stmt = (
        select(DailySlotLog)
        .where(DailySlotLog.user_id == user_uuid)
        .where(DailySlotLog.slot_date == today)
        .order_by(DailySlotLog.served_at.asc())
    )
    existing_result = await db.execute(existing_stmt)
    existing_slots = existing_result.scalars().all()

    if existing_slots:
        # Already served today — return cached set
        job_ids = [s.job_id for s in existing_slots]
        # Fetch the full job_data for each cached slot
        job_stmt = (
            select(AutoMatchResult)
            .where(AutoMatchResult.user_id == user_uuid)
            .where(AutoMatchResult.job_id.in_(job_ids))
        )
        job_result = await db.execute(job_stmt)
        job_rows = {r.job_id: r for r in job_result.scalars().all()}
        slots = []
        for s in existing_slots:
            row = job_rows.get(s.job_id)
            if row:
                slots.append({
                    "job_id": s.job_id,
                    "job_data": row.job_data,
                    "score": s.score,
                    "rank_reason": s.rank_reason,
                    "is_new": False,
                    "served_at": s.served_at.isoformat() if s.served_at else None,
                })
        return {"slots": slots, "slot_date": today.isoformat(), "is_fresh": False}

    # --- Fresh serve — pick from UNSERVED pool only (never repeat) ---
    # Exclude archived jobs
    archived_stmt = select(ArchivedJobId.job_id).where(ArchivedJobId.user_id == user_uuid)
    archived_result = await db.execute(archived_stmt)
    archived_ids = {r[0] for r in archived_result.fetchall()}

    # Exclude ALL previously served jobs (not just today — never repeat)
    ever_served_stmt = select(DailySlotLog.job_id).where(DailySlotLog.user_id == user_uuid)
    ever_served_result = await db.execute(ever_served_stmt)
    ever_served_ids = {r[0] for r in ever_served_result.fetchall()}

    excluded_ids = archived_ids | ever_served_ids

    base_stmt = (
        select(AutoMatchResult)
        .where(AutoMatchResult.user_id == user_uuid)
    )
    if excluded_ids:
        base_stmt = base_stmt.where(AutoMatchResult.job_id.notin_(excluded_ids))

    # Top 4 by score from unserved pool
    score_stmt = base_stmt.order_by(AutoMatchResult.score.desc()).limit(4)
    score_result = await db.execute(score_stmt)
    score_rows = score_result.scalars().all()

    picked_ids = {r.job_id for r in score_rows}

    # Top 4 by recency from unserved pool, deduped against score picks
    recency_stmt = base_stmt.order_by(AutoMatchResult.posted_at.desc()).limit(8)
    recency_result = await db.execute(recency_stmt)
    recency_rows = [r for r in recency_result.scalars().all() if r.job_id not in picked_ids][:4]

    # Build slot list
    all_slot_rows = (
        [(r, "score")   for r in score_rows] +
        [(r, "recency") for r in recency_rows]
    )

    if not all_slot_rows:
        return {"slots": [], "slot_date": today.isoformat(), "is_fresh": True}

    # Upsert into daily_slot_log (idempotent — ON CONFLICT DO NOTHING)
    from sqlalchemy.dialects.postgresql import insert as pg_insert
    import uuid as _uuid2

    now_utc = datetime.now(timezone.utc)
    for row, reason in all_slot_rows:
        stmt = pg_insert(DailySlotLog).values(
            id=_uuid2.uuid4(),
            user_id=user_uuid,
            job_id=row.job_id,
            slot_date=today,
            rank_reason=reason,
            score=row.score,
            served_at=now_utc,
        ).on_conflict_do_nothing(index_elements=["user_id", "job_id", "slot_date"])
        await db.execute(stmt)

    await db.commit()

    slots = [
        {
            "job_id": row.job_id,
            "job_data": row.job_data,
            "score": row.score,
            "rank_reason": reason,
            "is_new": True,
            "served_at": now_utc.isoformat(),
        }
        for row, reason in all_slot_rows
    ]
    return {"slots": slots, "slot_date": today.isoformat(), "is_fresh": True}


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