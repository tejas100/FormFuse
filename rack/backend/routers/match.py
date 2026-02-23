"""
match.py — Router for job matching
Wires POST /api/match to the full matching pipeline:
  JD text → parse → embed → FAISS search → hybrid score → ranked results
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional

from services.matcher import match_resumes

router = APIRouter(prefix="/api/match", tags=["match"])


class MatchRequest(BaseModel):
    job_description: str
    use_llm: bool = True  # Toggle LLM layer (set False for faster rule-only matching)


@router.post("")
async def match_resume(request: MatchRequest):
    """
    Match all indexed resumes against a job description.

    Request body:
        {
            "job_description": "We're looking for a Backend Engineer with 3+ years...",
            "use_llm": true
        }

    Returns ranked results with scores, matched/missing skills, and gap analysis.
    """
    if not request.job_description or not request.job_description.strip():
        raise HTTPException(status_code=400, detail="Job description cannot be empty")

    if len(request.job_description) > 15000:
        raise HTTPException(status_code=400, detail="Job description too long (max 15000 chars)")

    result = await match_resumes(
        jd_text=request.job_description,
        use_llm=request.use_llm,
    )

    return result