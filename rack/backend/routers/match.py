"""
match.py — Router for job matching
Wires POST /api/match to the full matching pipeline:
  JD text → parse → embed → FAISS search → hybrid score → LLM deep score → ranked results

Two-phase architecture (mirrors auto_match.py / watchlist.py):
  Phase 1: matcher.py  — FAISS + hybrid scorer (fast, use_llm=False)
  Phase 2: llm_scorer  — GPT-4o-mini deep score on ALL results (no threshold filter,
                          small set so every resume gets the full LLM treatment)
"""

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from typing import Optional

from services.matcher import match_resumes

router = APIRouter(prefix="/api/match", tags=["match"])

# Header name the frontend sends for anonymous session scoping
_SESSION_HEADER = "X-Session-ID"
_DEFAULT_SESSION = "default"

def _get_session_id(request: Request) -> str:
    """Extract session ID from header. Falls back to 'default' if absent."""
    return request.headers.get(_SESSION_HEADER, _DEFAULT_SESSION) or _DEFAULT_SESSION


class MatchRequest(BaseModel):
    job_description: str
    use_llm: bool = True  # Toggle LLM layer (set False for faster rule-only matching)


@router.post("")
async def match_resume(request: MatchRequest, http_request: Request):
    """
    Match all indexed resumes against a job description.
    Session-scoped: only resumes uploaded by this session are matched.
    """
    session_id = _get_session_id(http_request)

    if not request.job_description or not request.job_description.strip():
        raise HTTPException(status_code=400, detail="Job description cannot be empty")

    if len(request.job_description) > 15000:
        raise HTTPException(status_code=400, detail="Job description too long (max 15000 chars)")

    # ── Phase 1: Hybrid scoring — scoped to session ──
    result = await match_resumes(
        jd_text=request.job_description,
        user_id=session_id,
        use_llm=False,
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