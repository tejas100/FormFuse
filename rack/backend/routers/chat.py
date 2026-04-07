"""
routers/chat.py — Agentic chat router for RACK

Endpoints:
  POST /api/chat/tailor   — Tailored resume PDF generation (auth required)

Flow for /tailor:
  1. Receive { text } — raw JD text OR a job URL
  2. URL detection via regex → fetch_job_description() if URL
  3. Run match pipeline → rank user's resumes
  4. Take #1 ranked resume → fetch full_text
  5. GPT-4o-mini writes complete tailored HTML
  6. WeasyPrint → PDF bytes
  7. Upload to Supabase Storage → signed URL
  8. Return result with download_url + match metadata

Auth: JWT required — anonymous users get 401.
"""

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Security, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from db.database import get_db
from routers.auth import get_current_user

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/chat", tags=["chat"])

_bearer = HTTPBearer(auto_error=True)  # hard-require auth for all chat/agent endpoints


# ── Request / Response models ─────────────────────────────────────────────────

class TailorRequest(BaseModel):
    text: str   # raw JD text OR a job URL


class TailorResponse(BaseModel):
    status:             str
    resume_id:          str
    resume_name:        str
    match_score:        int
    llm_recommendation: str
    llm_reasoning:      str
    key_strengths:      list
    key_gaps:           list
    download_url:       str
    jd_title:           str


# ── /tailor endpoint ──────────────────────────────────────────────────────────

@router.post("/tailor", response_model=TailorResponse)
async def tailor_resume(
    request: TailorRequest,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Generate a tailored resume PDF for the authenticated user.

    - Accepts raw JD text or a job URL (https://...)
    - Runs the full match pipeline to find the best-fit resume
    - GPT rewrites the resume HTML tailored to the JD
    - WeasyPrint converts HTML → PDF
    - Returns a signed Supabase Storage URL for download

    Requires authentication — anonymous users cannot use this endpoint.
    """
    text = request.text.strip()

    if not text:
        raise HTTPException(status_code=400, detail="Job description or URL cannot be empty.")

    if len(text) > 20000:
        raise HTTPException(status_code=400, detail="Input too long (max 20000 chars).")

    user_id = current_user.id  # UUID from get_current_user

    try:
        from services.tailor import run_tailor_pipeline
        result = await run_tailor_pipeline(
            jd_input=text,
            user_id=user_id,
            db=db,
        )
    except ValueError as e:
        # Known user-facing errors (no resumes, URL fetch failure, etc.)
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        logger.error(f"[chat/tailor] Unexpected error for user={user_id}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Tailoring failed. Please try again.")

    return TailorResponse(**result)