from pydantic import BaseModel

class MatchRequest(BaseModel):
    job_description: str

class MatchResponse(BaseModel):
    resume_id: int
    score: float
    matched_skills: list[str]
    missing_skills: list[str]