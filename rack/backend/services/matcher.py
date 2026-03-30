"""
matcher.py
Orchestrates the full matching pipeline.

pgvector edition (Session 16):
  - faiss_store replaced with vector_store (pgvector cosine similarity)
  - db (AsyncSession) is now a required parameter — no local index files
  - Authenticated users: resume metadata + chunks loaded from DB directly
  - Anonymous users: resume metadata + chunks loaded from local JSON (unchanged)
  - All FAISS cold-start rebuild logic removed

Session 19:
  - full_text now loaded from DB and included in resume dict
  - Flows through to llm_scorer._build_resume_summary() for accurate LLM scoring
"""

import logging
import time
from typing import Dict, List, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from services.jd_parser import parse_jd, _split_jd_sections
from services.embedder import embed_single
from services.vector_store import vector_search
from services.hybrid_scorer import score_resume
from services.gap_analyzer import analyze_gaps

logger = logging.getLogger(__name__)


def _build_semantic_query(parsed_jd: Dict, jd_text: str) -> str:
    """
    Build a focused semantic query for embedding.

    Instead of embedding the entire JD (which exceeds 256 tokens and gets
    truncated), we build a concentrated query from the parsed JD data +
    relevant sections. Dense with signal, no noise.
    """
    parts = []

    if parsed_jd.get("title"):
        parts.append(parsed_jd["title"])

    all_skills = parsed_jd.get("required_skills", []) + parsed_jd.get("preferred_skills", [])
    if all_skills:
        parts.append(", ".join(all_skills))

    if parsed_jd.get("domains"):
        parts.append(", ".join(parsed_jd["domains"]))

    sections = _split_jd_sections(jd_text)
    for key in ["responsibilities", "required"]:
        if key in sections:
            parts.append(sections[key][:500])

    query = ". ".join(parts)
    words = query.split()
    if len(words) > 180:
        query = " ".join(words[:180])

    return query


async def _load_resumes_from_db(user_id: str, db: AsyncSession) -> List[Dict]:
    """
    Load resume metadata + chunks from Supabase DB for an authenticated user.
    Returns a list of dicts in the same shape the rest of the pipeline expects.

    Session 19: full_text now included — read from resumes.full_text column.
    Resumes uploaded before the migration will have full_text=None; the LLM
    scorer handles this gracefully by falling back to the metadata summary.
    """
    from models.orm import Resume, ResumeChunk

    result = await db.execute(
        select(Resume)
        .where(Resume.user_id == user_id, Resume.status == "active")
    )
    resumes = result.scalars().all()

    resume_list = []
    for r in resumes:
        chunk_result = await db.execute(
            select(ResumeChunk)
            .where(ResumeChunk.resume_id == r.id)
            .order_by(ResumeChunk.chunk_index)
        )
        chunks = chunk_result.scalars().all()

        chunk_dicts = [
            {
                "text": c.chunk_text,
                "chunk_index": c.chunk_index,
                "section": "experience",  # not stored in DB, use default
                "weight": 1.0,
            }
            for c in chunks
        ]

        resume_list.append({
            "id": str(r.id),
            "name": r.display_name,
            "file_ext": r.file_ext,
            "skills": r.skills or [],
            "years_exp": r.years_exp,
            "titles": r.titles or [],
            "domains": r.domains or [],
            "chunk_count": r.chunk_count,
            "full_text": r.full_text,      # ← NEW: None for pre-migration resumes
            "structured": {
                "years_exp": r.years_exp,
                "titles": r.titles or [],
                "domains": r.domains or [],
                "skills": r.skills or [],
            },
            "chunks": chunk_dicts,
        })

    logger.info(f"[matcher] Loaded {len(resume_list)} resumes from DB for user={user_id}")
    return resume_list


async def match_resumes(
    jd_text: str,
    user_id: str = "default",
    top_k_chunks: int = 20,
    use_llm: bool = True,
    db: AsyncSession = None,
) -> Dict:
    """
    Full matching pipeline: JD → parsed → scored → ranked results.

    db: AsyncSession — required for authenticated users (pgvector search +
        DB resume loading). If None, returns empty with a clear message.
    """
    start_time = time.time()

    # ── Step 1: Parse JD ──
    parsed_jd = await parse_jd(jd_text, use_llm=use_llm)
    print(f"[matcher] JD parsed: {len(parsed_jd.get('required_skills', []))} required skills, "
          f"method={parsed_jd.get('extraction_method')}")

    # ── Step 2: Require db session ──
    if db is None:
        logger.warning(f"[matcher] No db session for user={user_id} — cannot search")
        return {
            "results": [],
            "jd_parsed": parsed_jd,
            "meta": {
                "total_resumes": 0,
                "pipeline_time_ms": _elapsed_ms(start_time),
                "message": "No database session available.",
            },
        }

    # ── Step 3: Build focused semantic query and embed ──
    semantic_query = _build_semantic_query(parsed_jd, jd_text)
    jd_embedding = embed_single(semantic_query)
    print(f"[matcher] Semantic query: {len(semantic_query.split())} words")

    # ── Step 4: pgvector search — scoped to this user ──
    import re as _re
    _UUID_RE = _re.compile(
        r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
        _re.IGNORECASE,
    )
    is_anon = not _UUID_RE.match(user_id)

    vector_results = await vector_search(
        query_embedding=jd_embedding,
        user_id=user_id,
        top_k=top_k_chunks,
        db=db,
    )
    print(f"[matcher] pgvector returned {len(vector_results)} chunks")

    # ── Step 5: Load resume metadata + chunks ──
    # Anonymous users: pgvector returns [] (non-UUID guard in vector_store.py).
    # Fall back to local disk store via ingestion.get_all_resumes(session_id).
    if is_anon:
        from services.ingestion import get_all_resumes as _get_all_resumes, get_resume_by_id as _get_resume_by_id
        raw_resumes = _get_all_resumes(session_id=user_id)

        # get_all_resumes() flattens structured fields to top-level and strips chunks.
        # Re-fetch full records (which include chunks + structured dict) so the
        # scorer has everything it needs. Fall back to the flat record if not found.
        all_resumes = []
        for r in raw_resumes:
            full = _get_resume_by_id(r["id"])
            if full:
                # Full record from metadata JSON has "structured" key and "chunks" list
                all_resumes.append(full)
            else:
                # Fallback: reconstruct structured dict from flat fields
                r.setdefault("structured", {
                    "years_exp": r.get("years_exp"),
                    "titles":    r.get("titles", []),
                    "domains":   r.get("domains", []),
                    "skills":    r.get("skills", []),
                })
                r.setdefault("chunks", [])
                all_resumes.append(r)

        logger.info(f"[matcher] Anonymous fallback: loaded {len(all_resumes)} resumes from local store for session={user_id}")

        # Build synthetic vector_results from chunk dicts so scoring has signal.
        # Similarity score is set to 0.5 (neutral) since we have no pgvector scores.
        if not vector_results and all_resumes:
            for resume in all_resumes:
                for chunk in resume.get("chunks", []):
                    vector_results.append({
                        "resume_id":   resume["id"],
                        "chunk_index": chunk.get("chunk_index", 0),
                        "text":        chunk.get("text", chunk.get("chunk_text", "")),
                        "score":       0.5,
                        "section":     chunk.get("section", "experience"),
                        "weight":      chunk.get("weight", 1.0),
                    })
    else:
        all_resumes = await _load_resumes_from_db(user_id, db)

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

    # ── Step 6: Group vector results by resume ──
    results_by_resume = {}
    for result in vector_results:
        rid = result["resume_id"]
        if rid not in results_by_resume:
            results_by_resume[rid] = []
        results_by_resume[rid].append(result)

    # ── Step 7: Score each resume ──
    scored_results = []
    for resume in all_resumes:
        resume_id = resume["id"]
        structured = resume["structured"]
        resume_chunks = resume["chunks"]
        resume_vector_hits = results_by_resume.get(resume_id, [])

        score_result = score_resume(
            parsed_jd=parsed_jd,
            resume_structured=structured,
            faiss_results=resume_vector_hits,
            resume_chunks=resume_chunks,
            use_llm=use_llm,
        )

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
            "full_text": resume.get("full_text"),   # ← NEW: flows through to LLM scorer
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
            "vector_chunks_searched": len(vector_results),
        },
    }


def _elapsed_ms(start: float) -> int:
    return round((time.time() - start) * 1000)