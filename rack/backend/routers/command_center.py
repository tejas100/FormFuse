"""
routers/command_center.py — Command Center + durable chat history.

Two responsibilities:

1. GET /api/chat/command-center
   The "what happened while you were gone" payload for the Home greeting:
   new matches since last visit, fresh postings (48h), applied count,
   top match, and profile completeness. Reads users.last_seen_at, then
   advances it — so "new since last visit" is computed against the
   PREVIOUS visit, exactly once per load.

2. /api/chat/history  (GET / PUT / DELETE)
   Durable, cross-device chat memory in Supabase. The frontend keeps
   localStorage as the fast cache and mirrors the same capped message
   list here. Sync model is full-replace (last-write-wins), mirroring
   localStorage semantics — no per-message merge logic, no drift bugs.
   Max 40 rows per user, debounced client-side, so write volume is tiny.

Session: Command Center v1.
"""

import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from db.database import get_db
from models.orm import AutoMatchResult, ChatMessage, User
from routers.auth import get_current_user

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/chat", tags=["chat"])

# ── Tunables ──────────────────────────────────────────────────────────
HISTORY_CAP = 40          # max persisted messages per user (matches frontend cap)
FRESH_WINDOW_HOURS = 48   # "fresh posting" window for the urgency chip

# Profile keys that gate auto-apply quality. Booleans count as filled if
# the key is PRESENT (False is a valid answer for requires_sponsorship).
_PROFILE_BOOL_KEYS = {"requires_sponsorship"}
_PROFILE_CORE_KEYS = [
    "first_name",
    "last_name",
    "phone",
    "current_location",
    "work_auth",
    "requires_sponsorship",
    "linkedin",
    "target_roles",
]
_PROFILE_LABELS = {
    "first_name":           "first name",
    "last_name":            "last name",
    "phone":                "phone number",
    "current_location":     "location",
    "work_auth":            "work authorization",
    "requires_sponsorship": "sponsorship status",
    "linkedin":             "LinkedIn URL",
    "target_roles":         "target roles",
}


def _profile_completeness(preferences: Optional[dict]) -> dict:
    prefs = preferences or {}
    missing = []
    for key in _PROFILE_CORE_KEYS:
        if key in _PROFILE_BOOL_KEYS:
            filled = key in prefs and prefs[key] is not None
        else:
            val = prefs.get(key)
            filled = bool(val) if not isinstance(val, list) else len(val) > 0
        if not filled:
            missing.append(_PROFILE_LABELS.get(key, key))
    total = len(_PROFILE_CORE_KEYS)
    return {
        "filled":  total - len(missing),
        "total":   total,
        "missing": missing,
        "percent": round(100 * (total - len(missing)) / total),
    }


def _parse_ts(value: Any) -> Optional[datetime]:
    """Parse an ISO timestamp from job_data, tolerating Z suffix and naivety."""
    if not value:
        return None
    if isinstance(value, datetime):
        dt = value
    else:
        try:
            dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        except (ValueError, TypeError):
            return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


# ══════════════════════════════════════════════════════════════════════
# GET /api/chat/command-center
# ══════════════════════════════════════════════════════════════════════

@router.get("/command-center")
async def command_center(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    now = datetime.now(timezone.utc)
    last_seen = current_user.last_seen_at
    if last_seen is not None and last_seen.tzinfo is None:
        last_seen = last_seen.replace(tzinfo=timezone.utc)

    result = await db.execute(
        select(AutoMatchResult)
        .where(AutoMatchResult.user_id == current_user.id)
        .order_by(AutoMatchResult.score.desc())
    )
    rows = result.scalars().all()

    new_matches = 0
    fresh_jobs = 0
    applied_count = 0
    fresh_cutoff = now - timedelta(hours=FRESH_WINDOW_HOURS)

    for r in rows:
        if r.applied:
            applied_count += 1

        matched_at = _parse_ts(r.matched_at)
        if last_seen is not None and matched_at is not None and matched_at > last_seen:
            new_matches += 1

        posted_at = _parse_ts(r.posted_at) or _parse_ts((r.job_data or {}).get("posted_at"))
        if posted_at is not None and posted_at >= fresh_cutoff:
            fresh_jobs += 1

    top_match = None
    if rows:
        top = rows[0]  # already ordered by score desc
        jd = top.job_data or {}
        top_match = {
            "job_id":    top.job_id,
            "job_title": jd.get("job_title", ""),
            "company":   (jd.get("company") or "").capitalize(),
            "score":     round(top.score or 0),
        }

    # Advance last_seen AFTER computing — next visit diffs against now.
    await db.execute(
        update(User).where(User.id == current_user.id).values(last_seen_at=now)
    )

    return {
        "display_name":  current_user.display_name,
        "last_seen_at":  last_seen.isoformat() if last_seen else None,
        "first_visit":   last_seen is None,
        "new_matches":   new_matches,
        "fresh_jobs":    fresh_jobs,
        "total_matches": len(rows),
        "applied_count": applied_count,
        "top_match":     top_match,
        "profile":       _profile_completeness(current_user.preferences),
    }


# ══════════════════════════════════════════════════════════════════════
# Chat history — durable mirror of the frontend message list
# ══════════════════════════════════════════════════════════════════════

class HistorySyncRequest(BaseModel):
    messages: list[dict]  # the same capped, completed-only list the frontend stores locally


@router.get("/history")
async def get_history(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(ChatMessage)
        .where(ChatMessage.user_id == current_user.id)
        .order_by(ChatMessage.position.asc())
        .limit(HISTORY_CAP)
    )
    rows = result.scalars().all()
    return {
        "messages":  [r.payload for r in rows],
        "updated_at": max((r.created_at for r in rows), default=None),
    }


@router.put("/history")
async def sync_history(
    req: HistorySyncRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Full-replace sync. The client is the source of truth for ordering and
    content (same semantics as its localStorage write). Delete + bulk insert
    inside one transaction; get_db commits on success, rolls back on error.
    """
    msgs = (req.messages or [])[-HISTORY_CAP:]

    await db.execute(
        delete(ChatMessage).where(ChatMessage.user_id == current_user.id)
    )
    for i, payload in enumerate(msgs):
        if not isinstance(payload, dict):
            continue
        db.add(ChatMessage(user_id=current_user.id, position=i, payload=payload))

    return {"ok": True, "stored": len(msgs)}


@router.delete("/history")
async def clear_history(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await db.execute(
        delete(ChatMessage).where(ChatMessage.user_id == current_user.id)
    )
    return {"ok": True}