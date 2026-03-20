"""
services/vector_store.py — pgvector-based semantic search for RACK.

Replaces faiss_store.py entirely. No local index files — all vectors
live in Supabase resume_chunks.embedding (vector(384) column).

Public API (same return shape as the old faiss_search()):
    await vector_search(query_embedding, user_id, top_k, db)
        → list of { resume_id, chunk_index, text, score, section, weight }

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
    top_k: int,
    db: AsyncSession,
) -> List[Dict]:
    """
    Find the top_k most semantically similar resume chunks for a user.

    Args:
        query_embedding: 1-D numpy array of shape (384,) — the JD query vector.
        user_id:         UUID string — scopes search to this user's chunks only.
        top_k:           Number of chunks to return.
        db:              Active AsyncSession from FastAPI dependency.

    Returns:
        List of dicts, each containing:
            resume_id   — UUID string of the owning resume
            chunk_index — position of this chunk within the resume
            text        — raw text of the chunk (key is "text" for hybrid_scorer compat)
            score       — cosine similarity 0.0–1.0 (higher = more similar)
            section     — always "experience" (not stored in DB, defaulted)
            weight      — always 1.0 (not stored in DB, defaulted)

        Empty list if the user has no indexed chunks.
    """
    vec_str = "[" + ",".join(str(float(x)) for x in query_embedding.tolist()) + "]"

    sql = text("""
        SELECT
            resume_id::text,
            chunk_index,
            chunk_text,
            1 - (embedding <=> :query_vec ::vector) AS score
        FROM resume_chunks
        WHERE user_id = :user_id ::uuid
          AND embedding IS NOT NULL
        ORDER BY embedding <=> :query_vec ::vector
        LIMIT :top_k
    """)

    try:
        result = await db.execute(
            sql,
            {
                "query_vec": vec_str,
                "user_id":   user_id,
                "top_k":     top_k,
            },
        )
        rows = result.fetchall()
    except Exception as e:
        logger.error(f"[vector_store] pgvector search failed for user={user_id}: {e}")
        return []

    hits = []
    for row in rows:
        hits.append({
            "resume_id":   row.resume_id,
            "chunk_index": row.chunk_index,
            "text":        row.chunk_text,   # ← "text" not "chunk_text" — hybrid_scorer expects this key
            "score":       float(row.score),
            "section":     "experience",
            "weight":      1.0,
        })

    if hits:
        logger.debug(f"[vector_store] user={user_id} pgvector returned {len(hits)} chunks (top score: {hits[0]['score']:.3f})")
    else:
        logger.debug(f"[vector_store] user={user_id} pgvector returned 0 chunks")

    return hits