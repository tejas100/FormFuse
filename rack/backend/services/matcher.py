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

Key optimization: We embed only the relevant JD sections (requirements,
responsibilities) — NOT the company description, benefits, salary, or
location sections. This dramatically improves semantic similarity scores
because the embedding captures what the job *needs*, not noise about perks.
"""

import time
from typing import Dict, List, Optional

from services.jd_parser import parse_jd, _split_jd_sections
from services.embedder import embed_single
from services.faiss_store import search as faiss_search, get_index_stats
from services.ingestion import get_all_resumes, get_resume_by_id
from services.hybrid_scorer import score_resume
from services.gap_analyzer import analyze_gaps


def _extract_relevant_jd_text(jd_text: str) -> str:
    """
    Extract only the relevant sections of a JD for embedding.
    Removes company description, benefits, salary, location noise.
    
    This is critical: embedding "competitive salary + 401k + dental"
    dilutes the semantic signal for actual job requirements.
    """
    sections = _split_jd_sections(jd_text)
    
    relevant_keys = ["required", "preferred", "responsibilities", "general"]
    irrelevant_keys = ["about", "benefits"]
    
    relevant_parts = []
    for key in relevant_keys:
        if key in sections:
            relevant_parts.append(sections[key])
    
    # If we couldn't parse sections, fall back to full text
    # but truncate to first ~2000 chars (skip the tail which is usually benefits)
    if not relevant_parts:
        return jd_text[:2000]
    
    return "\n".join(relevant_parts)


async def match_resumes(
    jd_text: str,
    user_id: str = "default",
    top_k_chunks: int = 20,
    use_llm: bool = True,
) -> Dict:
    """
    Full matching pipeline: JD → parsed → scored → ranked results.
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

    # ── Step 3: Embed ONLY relevant JD sections ──
    # Don't embed salary, benefits, company description — it dilutes semantic signal
    relevant_jd_text = _extract_relevant_jd_text(jd_text)
    jd_embedding = embed_single(relevant_jd_text)

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

        full_resume = get_resume_by_id(resume_id)
        if not full_resume:
            continue

        structured = full_resume.get("structured", {})
        resume_chunks = full_resume.get("chunks", [])

        # FAISS results for this resume
        resume_faiss = results_by_resume.get(resume_id, [])

        # Hybrid scoring — now passes chunks for text-based skill matching
        score_result = score_resume(
            parsed_jd=parsed_jd,
            resume_structured=structured,
            faiss_results=resume_faiss,
            resume_chunks=resume_chunks,
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
    return round((time.time() - start) * 1000)