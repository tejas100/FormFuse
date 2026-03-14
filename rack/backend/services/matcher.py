"""
matcher.py
Orchestrates the full matching pipeline.

Key fixes in this version:
  1. Gap analyzer now receives resume_chunks for text-based fallback
  2. JD embedding uses a focused query (skills + title + key requirements)
     instead of the full JD text, staying within all-MiniLM-L6-v2's 256 token limit
  3. This dramatically improves semantic similarity scores
"""

import time
from typing import Dict, List, Optional

from services.jd_parser import parse_jd, _split_jd_sections
from services.embedder import embed_single
from services.faiss_store import search as faiss_search, get_index_stats
from services.ingestion import get_all_resumes, get_resume_by_id
from services.hybrid_scorer import score_resume
from services.gap_analyzer import analyze_gaps


def _build_semantic_query(parsed_jd: Dict, jd_text: str) -> str:
    """
    Build a focused semantic query for FAISS embedding.
    
    Instead of embedding the entire JD (which exceeds 256 tokens and gets
    truncated, losing key requirements), we build a concentrated query
    from the parsed JD data + relevant sections.
    
    This is like a search query — dense with signal, no noise.
    
    Example output:
      "Applied AI Engineer. Python, RAG, LLM, Fine-tuning, Docker, CI/CD.
       Build and deploy AI applications. LLM inference. RAG systems.
       Production ML systems. Backend infrastructure."
    """
    parts = []
    
    # Title
    if parsed_jd.get("title"):
        parts.append(parsed_jd["title"])
    
    # All skills as a dense list
    all_skills = parsed_jd.get("required_skills", []) + parsed_jd.get("preferred_skills", [])
    if all_skills:
        parts.append(", ".join(all_skills))
    
    # Domains
    if parsed_jd.get("domains"):
        parts.append(", ".join(parsed_jd["domains"]))
    
    # Extract key responsibility sentences (short, signal-dense)
    sections = _split_jd_sections(jd_text)
    for key in ["responsibilities", "required"]:
        if key in sections:
            # Take first ~500 chars of responsibilities/requirements
            text = sections[key][:500]
            parts.append(text)
    
    query = ". ".join(parts)
    
    # Keep under ~200 words to stay within 256 token limit
    words = query.split()
    if len(words) > 180:
        query = " ".join(words[:180])
    
    return query


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

    # ── Step 3: Build focused semantic query and embed ──
    semantic_query = _build_semantic_query(parsed_jd, jd_text)
    jd_embedding = embed_single(semantic_query)
    print(f"[matcher] Semantic query: {len(semantic_query.split())} words")

    # ── Step 4: FAISS search — scoped to this session/user ──
    faiss_results = faiss_search(
        query_embedding=jd_embedding,
        top_k=top_k_chunks,
        user_id=user_id,
    )
    print(f"[matcher] FAISS returned {len(faiss_results)} chunks")

    # ── Step 5: Load resume metadata — scoped to this session/user ──
    all_resumes = get_all_resumes(session_id=user_id)
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

        # Hybrid scoring — passes chunks for text-based skill matching
        score_result = score_resume(
            parsed_jd=parsed_jd,
            resume_structured=structured,
            faiss_results=resume_faiss,
            resume_chunks=resume_chunks,
            use_llm=use_llm,
        )

        # Gap analysis — same 3-pass matching for consistency
        gaps = analyze_gaps(parsed_jd, structured, resume_chunks=resume_chunks, use_llm=use_llm)

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