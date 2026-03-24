"""
services/vector_store.py — pgvector-based semantic search for RACK.

Replaces faiss_store.py entirely. No local index files — all vectors
live in Supabase resume_chunks.embedding (vector(384) column).

Public API (same return shape as the old faiss_search()):
    await vector_search(query_embedding, user_id, top_k, db)
        → list of { resume_id, chunk_index, text, score, section, weight }

Per-resume retrieval — fetch ALL chunks (Session 18):
    For each resume the user owns, we retrieve EVERY stored chunk and its
    cosine similarity score against the JD query. No top_k cap per resume.

    Why fetch everything:
      - If a resume has 22 stored chunks, fetching only 20 leaves 2 chunks
        on the table for no reason — those 2 might contain the exact skill
        the JD is looking for.
      - The hybrid scorer uses ALL retrieved chunks for skill overlap,
        keyword matching, and experience scoring. More chunks = more signal.
      - Cost: a user has 1–5 resumes, each with ~20–40 chunks at the new
        chunk size. Fetching 100–200 rows from a single-user pgvector index
        is effectively instant — far cheaper than the LLM call in Phase 2.

    Old behavior (one global query, top_k=20 shared):
      5 resumes → ~4 chunks each, Resume A could hog 15 slots.
      A strong candidate scores 45% because the wrong 4 chunks were retrieved.

    New behavior (one query per resume, all chunks):
      5 resumes → every chunk for every resume, ranked by similarity.
      The hybrid scorer sees the complete picture of each resume.

Note: the chunk text key is "text" (not "chunk_text") to match the shape
expected by hybrid_scorer._compute_keyword_position_score().
"""

import logging
from typing import List, Dict

import numpy as np
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)


async def vector_search(
    query_embedding: np.ndarray,
    user_id: str,
    top_k: int,          # kept for API compatibility — ignored, all chunks fetched
    db: AsyncSession,
) -> List[Dict]:
    """
    Retrieve ALL resume chunks for a user, scored by cosine similarity to the query.
    One query per resume to guarantee complete coverage of every resume.

    Args:
        query_embedding: 1-D numpy array of shape (384,) — the JD query vector.
        user_id:         UUID string — scopes search to this user's chunks only.
        top_k:           Ignored. Kept for call-site compatibility. All chunks returned.
        db:              Active AsyncSession from FastAPI dependency.

    Returns:
        List of dicts sorted by score descending, each containing:
            resume_id   — UUID string of the owning resume
            chunk_index — position of this chunk within the resume
            text        — raw text of the chunk
            score       — cosine similarity 0.0–1.0 (higher = more similar)
            section     — "experience" (placeholder; section not stored in DB yet)
            weight      — 1.0 (placeholder)

        Empty list if the user has no indexed chunks.
    """
    vec_str = "[" + ",".join(str(float(x)) for x in query_embedding.tolist()) + "]"

    # ── Step 1: Get all distinct resume IDs for this user ─────────────────────
    resume_id_sql = text("""
        SELECT DISTINCT resume_id::text
        FROM resume_chunks
        WHERE user_id = :user_id ::uuid
          AND embedding IS NOT NULL
    """)

    try:
        id_result  = await db.execute(resume_id_sql, {"user_id": user_id})
        resume_ids = [row.resume_id for row in id_result.fetchall()]
    except Exception as e:
        logger.error(f"[vector_store] Failed to fetch resume IDs for user={user_id}: {e}")
        return []

    if not resume_ids:
        logger.debug(f"[vector_store] user={user_id} has no indexed chunks")
        return []

    # ── Step 2: Per-resume query — ALL chunks, scored by similarity ───────────
    # No LIMIT — we want every chunk this resume has.
    # ORDER BY keeps the highest-similarity chunks first so the hybrid scorer
    # naturally processes the best evidence first.

    per_resume_sql = text("""
        SELECT
            resume_id::text,
            chunk_index,
            chunk_text,
            1 - (embedding <=> :query_vec ::vector) AS score
        FROM resume_chunks
        WHERE user_id   = :user_id   ::uuid
          AND resume_id = :resume_id ::uuid
          AND embedding IS NOT NULL
        ORDER BY embedding <=> :query_vec ::vector
    """)

    all_hits: List[Dict] = []

    for resume_id in resume_ids:
        try:
            result = await db.execute(
                per_resume_sql,
                {
                    "query_vec": vec_str,
                    "user_id":   user_id,
                    "resume_id": resume_id,
                },
            )
            rows = result.fetchall()
        except Exception as e:
            logger.error(f"[vector_store] Query failed for resume={resume_id}: {e}")
            continue

        for row in rows:
            all_hits.append({
                "resume_id":   row.resume_id,
                "chunk_index": row.chunk_index,
                "text":        row.chunk_text,  # "text" not "chunk_text" — hybrid_scorer expects this
                "score":       float(row.score),
                "section":     "experience",    # placeholder — section not stored in DB
                "weight":      1.0,
            })

        if rows:
            best = float(rows[0].score)         # already sorted best-first by ORDER BY
            logger.debug(
                f"[vector_store] resume={resume_id[:8]} → {len(rows)} chunks fetched "
                f"(best score: {best:.3f})"
            )

    # Sort all chunks across all resumes by similarity score, best first
    all_hits.sort(key=lambda h: h["score"], reverse=True)

    logger.info(
        f"[vector_store] user={user_id} | {len(resume_ids)} resume(s) | "
        f"{len(all_hits)} total chunks fetched"
    )

    return all_hits