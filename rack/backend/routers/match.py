"""
match.py — Router for job matching
Wires POST /api/match to the full matching pipeline:
  JD text → parse → embed → FAISS search → hybrid score → LLM deep score → ranked results

Two-phase architecture (mirrors auto_match.py / watchlist.py):
  Phase 1: matcher.py  — FAISS + hybrid scorer (fast, use_llm=False)
  Phase 2: llm_scorer  — GPT-4o-mini deep score on ALL results (no threshold filter,
                          small set so every resume gets the full LLM treatment)
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
import json
from typing import Optional, List
from pathlib import Path

from services.matcher import match_resumes

router = APIRouter(prefix="/api/match", tags=["match"])


class MatchRequest(BaseModel):
    job_description: str
    use_llm: bool = True  # Toggle LLM layer (set False for faster rule-only matching)


@router.post("")
async def match_resume(request: MatchRequest):
    """
    Match all indexed resumes against a job description.

    Phase 1: Hybrid scoring (FAISS + rule scorer, always use_llm=False)
    Phase 2: LLM deep scoring on all results (if use_llm=True and OPENAI_API_KEY set)

    Request body:
        {
            "job_description": "We're looking for a Backend Engineer with 3+ years...",
            "use_llm": true
        }

    Returns ranked results with hybrid + LLM scores, AI analysis, matched/missing skills.
    """
    if not request.job_description or not request.job_description.strip():
        raise HTTPException(status_code=400, detail="Job description cannot be empty")

    if len(request.job_description) > 15000:
        raise HTTPException(status_code=400, detail="Job description too long (max 15000 chars)")

    # ── Phase 1: Hybrid scoring (always use_llm=False — avoids Pass 3 penalty bug) ──
    result = await match_resumes(
        jd_text=request.job_description,
        use_llm=False,   # Phase 1 always rule-based — consistent with auto_match + watchlist
    )

    # ── Phase 2: LLM deep scoring (if enabled and resumes exist) ──
    if request.use_llm and result.get("results"):
        # Deferred import — avoids circular import at module load time
        from services.llm_scorer import llm_score_batch, rerank_by_llm_score

        parsed_jd = result.get("jd_parsed", {})

        # Build a job-like dict for the LLM context builder
        # _build_jd_summary() reads job.get("job_title") and job.get("description_text")
        job_ctx = {
            "job_title":        parsed_jd.get("title", ""),
            "company":          "",              # not available on Home page (no company)
            "description_text": request.job_description,
        }

        # Build pairs — ALL results go to LLM (no threshold: small set, every resume counts)
        pairs = []
        for match in result["results"]:
            hybrid_score = match.get("score", 0)
            # score from matcher is already 0-100 int
            if isinstance(hybrid_score, float) and hybrid_score <= 1.0:
                hybrid_score = round(hybrid_score * 100)
            else:
                hybrid_score = int(hybrid_score)

            full_resume = _get_full_resume(match["resume_id"])
            if full_resume is None:
                continue

            pairs.append({
                **match,
                "hybrid_score":      hybrid_score,
                "hybrid_components": match.get("components", {}),  # preserve old 4-component data
                "job":               job_ctx,
                "resume":            full_resume,
                "parsed_jd":         parsed_jd,
            })

        if pairs:
            # Run LLM scoring concurrently
            enriched = await llm_score_batch(pairs)

            # Re-rank by llm_score (primary) then hybrid_score (tiebreaker)
            enriched = rerank_by_llm_score(enriched)

            # Set score = llm_score so existing frontend code using r.score still works
            for entry in enriched:
                entry["score"] = entry.get("llm_score", entry.get("hybrid_score", 0))

            result["results"] = enriched
            result["meta"]["llm_scored"] = sum(
                1 for e in enriched if e.get("scoring_method") == "llm+hybrid"
            )

    return result


def _get_full_resume(resume_id: str):
    """Load full resume dict (with chunks + structured) for LLM context building."""
    try:
        from services.ingestion import get_resume_by_id
        return get_resume_by_id(resume_id)
    except Exception:
        return None
    

# ── Paste this block into match.py ──────
 
PREVIEW_MIN_SCORE = 0.45   # ~45% — lower threshold for preview (show more matches)
PREVIEW_TOP_JOBS = 3       # How many job titles to preview per resume
PREVIEW_MAX_DISPLAY = 20   # Cap on match count shown (even if more match)
 
# Path to the cached job pool (same file auto_match.py uses)
_JOB_POOL_PATH = Path(__file__).parent.parent / "data" / "auto_job_pool.json"
 
 
class PreviewResume(BaseModel):
    id: str
    name: str
    text: str   # raw resume text extracted on the frontend or sent from Home
 
 
class PreviewJobsRequest(BaseModel):
    resumes: List[PreviewResume]
 
 
@router.post("/preview-jobs")
async def preview_jobs(body: PreviewJobsRequest):
    """
    Score anonymous resumes against the cached job pool.
    No auth required. Used for the post-match sign-in prompt on Home.
    """
    if not _JOB_POOL_PATH.exists():
        # Job pool not yet populated — return empty gracefully
        return {"previews": []}
 
    try:
        with open(_JOB_POOL_PATH, "r") as f:
            job_pool = json.load(f)
    except Exception:
        return {"previews": []}
 
    if not job_pool:
        return {"previews": []}
 
    previews = []
 
    for resume in body.resumes:
        if not resume.text or not resume.text.strip():
            continue
 
        try:
            # Use existing hybrid scorer with use_llm=False (fast, no OpenAI cost)
            from services.hybrid_scorer import score_resume_against_jobs
 
            matches = score_resume_against_jobs(
                resume_text=resume.text,
                jobs=job_pool,
                use_llm=False,
                min_score=PREVIEW_MIN_SCORE,
            )
 
            # Sort by score descending
            matches.sort(key=lambda m: m.get("score", 0), reverse=True)
 
            match_count = min(len(matches), PREVIEW_MAX_DISPLAY)
            top_jobs = [
                {
                    "title": m.get("job_title", "Software Engineer"),
                    "company": m.get("company", ""),
                }
                for m in matches[:PREVIEW_TOP_JOBS]
            ]
 
            previews.append({
                "resume_id": resume.id,
                "resume_name": resume.name,
                "match_count": match_count,
                "top_jobs": top_jobs,
            })
 
        except Exception as e:
            import logging
            logging.getLogger(__name__).warning(
                f"Preview scoring failed for resume '{resume.name}': {e}"
            )
            # Return a graceful fallback for this resume
            previews.append({
                "resume_id": resume.id,
                "resume_name": resume.name,
                "match_count": 0,
                "top_jobs": [],
            })
 
    return {"previews": previews}