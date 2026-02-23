"""
matcher.py
Orchestrates the full matching pipeline:

  JD text
    → jd_parser.parse_jd()           Parse + extract JD requirements (rule-based + LLM)
    → embedder.embed_single()        Embed JD text into same vector space as resumes
    → faiss_store.search()           Top-K chunk retrieval across all resumes
    → Load all resume structured data from metadata
    → hybrid_scorer.score_resume()   Score each resume (4-component hybrid)
    → gap_analyzer.analyze_gaps()    Missing skills per resume
    → Sort by score, return ranked results

This runs synchronously per match request. At current scale (3-5 resumes,
~30 chunks total), the entire pipeline takes < 500ms after model warm-up.

For production at scale:
  - Cache JD embeddings (same JD re-matched → skip embedding)
  - Async FAISS search with batch queries
  - Pre-compute resume structured data in Postgres (currently in JSON)
"""

import time
from typing import Dict, List, Optional

from services.jd_parser import parse_jd
from services.embedder import embed_single
from services.faiss_store import search as faiss_search, get_index_stats
from services.ingestion import get_all_resumes, get_resume_by_id
from services.hybrid_scorer import score_resume
from services.gap_analyzer import analyze_gaps


async def match_resumes(
    jd_text: str,
    user_id: str = "default",
    top_k_chunks: int = 20,
    use_llm: bool = True,
) -> Dict:
    """
    Full matching pipeline: JD → parsed → scored → ranked results.

    Args:
        jd_text: Raw job description text
        user_id: User ID for FAISS index (per-user indexes)
        top_k_chunks: Number of FAISS chunks to retrieve
        use_llm: Whether to use LLM for JD parsing

    Returns:
        {
            "results": [
                {
                    "resume_id": "abc123",
                    "name": "Software Engineer v3",
                    "score": 87,
                    "raw_score": 0.873,
                    "matched_skills": ["Python", "FastAPI"],
                    "missing_skills": ["Kubernetes"],
                    "matched_preferred": ["Redis"],
                    "components": { ... },
                    "gap_analysis": { ... },
                },
                ...
            ],
            "jd_parsed": { ... },
            "meta": {
                "total_resumes": 3,
                "pipeline_time_ms": 450,
                "faiss_chunks_searched": 20,
            },
        }
    """
    start_time = time.time()

    # ── Step 1: Parse JD ──
    parsed_jd = await parse_jd(jd_text, use_llm=use_llm)
    print(f"[matcher] JD parsed: {len(parsed_jd.get('required_skills', []))} required skills, "
          f"method={parsed_jd.get('extraction_method')}")

    # ── Step 2: Check if we have any resumes indexed ──
    index_stats = get_index_stats(user_id)
    if index_stats["total_vectors"] == 0:
        return {
            "results": [],
            "jd_parsed": parsed_jd,
            "meta": {
                "total_resumes": 0,
                "pipeline_time_ms": _elapsed_ms(start_time),
                "message": "No resumes indexed. Upload resumes first.",
            },
        }

    # ── Step 3: Embed JD for semantic search ──
    # Use the full JD text (not just skills) for embedding
    # This captures semantic meaning beyond just skill keywords
    jd_embedding = embed_single(jd_text)

    # ── Step 4: FAISS search — retrieve top chunks across ALL resumes ──
    faiss_results = faiss_search(
        query_embedding=jd_embedding,
        top_k=top_k_chunks,
        user_id=user_id,
    )
    print(f"[matcher] FAISS returned {len(faiss_results)} chunks")

    # ── Step 5: Load all resume metadata ──
    all_resumes = get_all_resumes()
    if not all_resumes:
        return {
            "results": [],
            "jd_parsed": parsed_jd,
            "meta": {
                "total_resumes": 0,
                "pipeline_time_ms": _elapsed_ms(start_time),
                "message": "No resume metadata found.",
            },
        }

    # ── Step 6: Group FAISS results by resume ──
    results_by_resume = {}
    for result in faiss_results:
        rid = result["resume_id"]
        if rid not in results_by_resume:
            results_by_resume[rid] = []
        results_by_resume[rid].append(result)

    # ── Step 7: Score each resume ──
    scored_results = []
    for resume in all_resumes:
        resume_id = resume["id"]

        # Get full resume data (with structured extraction)
        full_resume = get_resume_by_id(resume_id)
        if not full_resume:
            continue

        structured = full_resume.get("structured", {})

        # FAISS results for this resume (may be empty if no chunks matched)
        resume_faiss = results_by_resume.get(resume_id, [])

        # Hybrid scoring
        score_result = score_resume(
            parsed_jd=parsed_jd,
            resume_structured=structured,
            faiss_results=resume_faiss,
        )

        # Gap analysis
        gaps = analyze_gaps(parsed_jd, structured)

        scored_results.append({
            "resume_id": resume_id,
            "name": resume.get("name", "Unknown"),
            "file_ext": resume.get("file_ext", ""),
            "score": score_result["final_score"],
            "raw_score": score_result["raw_score"],
            "matched_skills": score_result["matched_skills"],
            "missing_skills": score_result["missing_skills"],
            "matched_preferred": score_result["matched_preferred"],
            "components": score_result["components"],
            "gap_analysis": gaps,
            # Resume metadata for display
            "skills": resume.get("skills", []),
            "years_exp": structured.get("years_exp"),
            "titles": structured.get("titles", []),
            "domains": structured.get("domains", []),
            "chunk_count": resume.get("chunk_count", 0),
        })

    # ── Step 8: Sort by score descending ──
    scored_results.sort(key=lambda x: x["raw_score"], reverse=True)

    pipeline_time = _elapsed_ms(start_time)
    print(f"[matcher] Pipeline complete: {len(scored_results)} resumes scored in {pipeline_time}ms")

    return {
        "results": scored_results,
        "jd_parsed": parsed_jd,
        "meta": {
            "total_resumes": len(scored_results),
            "pipeline_time_ms": pipeline_time,
            "faiss_chunks_searched": len(faiss_results),
            "index_stats": index_stats,
        },
    }


def _elapsed_ms(start: float) -> int:
    """Return elapsed milliseconds since start."""
    return round((time.time() - start) * 1000)