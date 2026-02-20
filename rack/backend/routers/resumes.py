from fastapi import APIRouter

router = APIRouter()

@router.get("/resumes")
async def get_resumes():
    return {"resumes": []}