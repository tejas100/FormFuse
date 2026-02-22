"""
match.py — Router for job matching (placeholder)
Will be built after ingestion pipeline is working.
"""

from fastapi import APIRouter

router = APIRouter(prefix="/api/match", tags=["match"])


@router.post("")
async def match_resume(payload: dict = {}):
    """Placeholder — will implement hybrid scoring pipeline."""
    return {
        "status": "placeholder",
        "message": "Matching pipeline not yet implemented.",
        "results": [],
    }