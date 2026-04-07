"""
routers/chat.py — Agentic chat router for RACK

Endpoints:
  POST /api/chat/tailor    — Tailored resume PDF generation (auth required)
                             Streams SSE progress events, final result as last event.
  POST /api/chat/fetch-jd  — Fetch and return JD text from a job board URL (no auth required)

SSE event format:
  data: {"type": "step", "step": "fetch_jd",  "status": "start"|"done"|"error", "label": "..."}
  data: {"type": "result", ...full result dict...}
  data: {"type": "error", "detail": "..."}

Auth: /tailor requires JWT. /fetch-jd is unauthenticated.
"""

import json
import logging
from typing import AsyncIterator

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from fastapi.security import HTTPBearer
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from db.database import get_db
from routers.auth import get_current_user

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/chat", tags=["chat"])

_bearer = HTTPBearer(auto_error=True)


# ── Request model ─────────────────────────────────────────────────────────────

class TailorRequest(BaseModel):
    text: str                                    # raw JD text OR a job URL
    resume_override_text: str | None = None      # tailored_full_text from a previous result (follow-up chaining)
    modification_hint:    str | None = None      # e.g. "make it more dense", "emphasize ML projects"
    prev_match_score:     int | None = None      # score from previous tailor card — carried forward on refinements


# ── SSE helper ────────────────────────────────────────────────────────────────

def _sse(payload: dict) -> str:
    """Format a dict as a single SSE data line."""
    return f"data: {json.dumps(payload)}\n\n"


# ── /fetch-jd endpoint — lightweight URL → JD text (no auth required) ──────────

class FetchJdRequest(BaseModel):
    url: str


@router.post("/fetch-jd")
async def fetch_jd(request: FetchJdRequest):
    """
    Fetch a job board URL and return the raw JD text.
    Used by the /rank flow in Home.jsx so the match API receives text, not a URL.
    No auth required — public job postings only.
    """
    url = request.url.strip()
    if not url:
        from fastapi import HTTPException
        raise HTTPException(status_code=400, detail="URL cannot be empty.")
    if not url.startswith(("http://", "https://")):
        from fastapi import HTTPException
        raise HTTPException(status_code=400, detail="Must be a valid http/https URL.")

    try:
        from services.tailor import fetch_job_description
        jd_text = await fetch_job_description(url)
        if len(jd_text) < 50:
            from fastapi import HTTPException
            raise HTTPException(status_code=422, detail="Could not extract job description from this URL. Try pasting the JD text directly.")
        return {"jd_text": jd_text, "char_count": len(jd_text)}
    except Exception as e:
        logger.error(f"[chat/fetch-jd] Failed to fetch {url}: {e}")
        from fastapi import HTTPException
        raise HTTPException(status_code=422, detail="Could not fetch job description. Please paste the JD text directly.")


# ── /tailor endpoint — SSE streaming ─────────────────────────────────────────

@router.post("/tailor")
async def tailor_resume(
    request: TailorRequest,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Stream tailored resume generation as SSE events.

    Events emitted (in order):
      {type: "step", step: "fetch_jd",       status: "start"|"done"|"error"}
      {type: "step", step: "match_resumes",   status: "start"|"done"|"error"}
      {type: "step", step: "score_resumes",   status: "start"|"done"|"error"}
      {type: "step", step: "generate_resume", status: "start"|"done"|"error"}
      {type: "step", step: "generate_pdf",    status: "start"|"done"|"error"}
      {type: "result", ...full result fields...}   <- final event on success
      {type: "error",  detail: "..."}              <- final event on failure
    """
    text    = request.text.strip()
    user_id = current_user.id

    if not text:
        from fastapi import HTTPException
        raise HTTPException(status_code=400, detail="Job description or URL cannot be empty.")

    if len(text) > 20000:
        from fastapi import HTTPException
        raise HTTPException(status_code=400, detail="Input too long (max 20000 chars).")

    async def event_stream() -> AsyncIterator[str]:
        try:
            from services.tailor import run_tailor_pipeline_streaming
            async for event in run_tailor_pipeline_streaming(
                jd_input=text,
                user_id=user_id,
                db=db,
                resume_override_text=request.resume_override_text or None,
                modification_hint=request.modification_hint or None,
                prev_match_score=request.prev_match_score,
            ):
                yield _sse(event)
        except Exception as e:
            logger.error(
                f"[chat/tailor] Unexpected streaming error for user={user_id}: {e}",
                exc_info=True,
            )
            yield _sse({"type": "error", "detail": "Tailoring failed. Please try again."})

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",  # disable nginx buffering if behind proxy
        },
    )