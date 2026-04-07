"""
routers/chat.py — Agentic chat router for RACK

Endpoints:
  POST /api/chat/tailor   — Tailored resume PDF generation (auth required)
                            Streams SSE progress events, final result as last event.

SSE event format:
  data: {"type": "step", "step": "fetch_jd",  "status": "start"|"done"|"error", "label": "..."}
  data: {"type": "result", ...full result dict...}
  data: {"type": "error", "detail": "..."}

Auth: JWT required — anonymous users get 401.
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
    text: str   # raw JD text OR a job URL


# ── SSE helper ────────────────────────────────────────────────────────────────

def _sse(payload: dict) -> str:
    """Format a dict as a single SSE data line."""
    return f"data: {json.dumps(payload)}\n\n"


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