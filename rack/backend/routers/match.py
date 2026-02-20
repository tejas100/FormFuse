from fastapi import APIRouter
from models.schemas import MatchRequest, MatchResponse

router = APIRouter()

@router.post("/match")
async def match_resume(payload: MatchRequest):
    # placeholder — we'll wire real logic here soon
    return {"message": "match endpoint working", "jd_length": len(payload.job_description)}