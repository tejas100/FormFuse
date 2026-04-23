"""
embedder.py
Generates 1536-dimensional embeddings using OpenAI text-embedding-3-small.

Switched from sentence-transformers/all-MiniLM-L6-v2 (384-dim, ~400MB RAM)
to OpenAI's hosted embedding API (1536-dim, ~0MB RAM on server).

Why:
  - sentence-transformers loads ~400MB of torch + model weights into server RAM
    on the first embedding call, pushing a 512MB Render instance into OOM.
  - OpenAI's API runs the model on their servers — our server sends text,
    receives a vector. Zero model weights in our RAM.
  - text-embedding-3-small produces 1536-dim vectors vs 384-dim, giving
    richer semantic signal for resume-to-JD matching.
  - Cost: ~$0.00002 per 1K tokens. A full match request costs < $0.0001.

Design decisions:
  - Same public API as before: embed_texts(), embed_single(), embed_chunks()
  - Synchronous for ingestion.py compatibility (called from sync ingest_resume)
  - Async variant embed_texts_async() for use in matcher.py (async context)
  - Batch size: 100 texts per API call (OpenAI limit is 2048, 100 is safe)
  - Normalized embeddings (unit vectors) so cosine similarity = dot product
  - Same model used for both resume chunks AND JD queries (critical: must
    share the same embedding space)
"""

import os
import logging
import numpy as np
import httpx
from typing import List

logger = logging.getLogger(__name__)

OPENAI_EMBEDDING_MODEL = "text-embedding-3-small"
EMBEDDING_DIM = 1536
BATCH_SIZE = 100  # texts per API call


def _get_api_key() -> str:
    key = os.environ.get("OPENAI_API_KEY")
    if not key:
        raise RuntimeError("[embedder] OPENAI_API_KEY not set in environment")
    return key


def _call_openai_embedding(texts: List[str]) -> List[List[float]]:
    """
    Synchronous OpenAI embedding call via httpx.
    Returns list of 1536-dim float lists, one per input text.
    """
    api_key = _get_api_key()
    response = httpx.post(
        "https://api.openai.com/v1/embeddings",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        json={
            "model": OPENAI_EMBEDDING_MODEL,
            "input": texts,
        },
        timeout=30.0,
    )
    response.raise_for_status()
    data = response.json()
    # Sort by index to preserve input order (OpenAI doesn't guarantee order)
    items = sorted(data["data"], key=lambda x: x["index"])
    return [item["embedding"] for item in items]


async def _call_openai_embedding_async(texts: List[str]) -> List[List[float]]:
    """
    Async OpenAI embedding call via httpx.AsyncClient.
    Used from async contexts (matcher.py).
    """
    api_key = _get_api_key()
    async with httpx.AsyncClient() as client:
        response = await client.post(
            "https://api.openai.com/v1/embeddings",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": OPENAI_EMBEDDING_MODEL,
                "input": texts,
            },
            timeout=30.0,
        )
    response.raise_for_status()
    data = response.json()
    items = sorted(data["data"], key=lambda x: x["index"])
    return [item["embedding"] for item in items]


# ═══════════════════════════════════════════════════════════════════
# PUBLIC API — same interface as before, drop-in replacement
# ═══════════════════════════════════════════════════════════════════

def embed_texts(texts: List[str], normalize: bool = True) -> np.ndarray:
    """
    Embed a list of text strings into 1536-dim vectors.
    Synchronous — safe to call from non-async code (ingestion.py).

    Args:
        texts:     List of text strings to embed
        normalize: If True, L2-normalize vectors (cosine sim = dot product)

    Returns:
        np.ndarray of shape (len(texts), 1536), dtype float32
    """
    if not texts:
        return np.array([], dtype=np.float32).reshape(0, EMBEDDING_DIM)

    all_embeddings = []
    for i in range(0, len(texts), BATCH_SIZE):
        batch = texts[i:i + BATCH_SIZE]
        vecs = _call_openai_embedding(batch)
        all_embeddings.extend(vecs)
        logger.debug(f"[embedder] Embedded batch {i//BATCH_SIZE + 1}: {len(batch)} texts")

    arr = np.array(all_embeddings, dtype=np.float32)

    if normalize:
        norms = np.linalg.norm(arr, axis=1, keepdims=True)
        norms = np.where(norms == 0, 1, norms)
        arr = arr / norms

    logger.info(f"[embedder] embed_texts: {len(texts)} texts → shape {arr.shape}")
    return arr


async def embed_texts_async(texts: List[str], normalize: bool = True) -> np.ndarray:
    """
    Async version of embed_texts. Use from async contexts (matcher.py).

    Returns:
        np.ndarray of shape (len(texts), 1536), dtype float32
    """
    if not texts:
        return np.array([], dtype=np.float32).reshape(0, EMBEDDING_DIM)

    all_embeddings = []
    for i in range(0, len(texts), BATCH_SIZE):
        batch = texts[i:i + BATCH_SIZE]
        vecs = await _call_openai_embedding_async(batch)
        all_embeddings.extend(vecs)

    arr = np.array(all_embeddings, dtype=np.float32)

    if normalize:
        norms = np.linalg.norm(arr, axis=1, keepdims=True)
        norms = np.where(norms == 0, 1, norms)
        arr = arr / norms

    return arr


def embed_single(text: str, normalize: bool = True) -> np.ndarray:
    """
    Embed a single text string. Synchronous.
    Returns np.ndarray of shape (1536,), dtype float32.
    """
    result = embed_texts([text], normalize=normalize)
    return result[0]


async def embed_single_async(text: str, normalize: bool = True) -> np.ndarray:
    """
    Embed a single text string. Async.
    Returns np.ndarray of shape (1536,), dtype float32.
    """
    result = await embed_texts_async([text], normalize=normalize)
    return result[0]


def get_embedding_dimension() -> int:
    """Return the embedding dimension (1536 for text-embedding-3-small)."""
    return EMBEDDING_DIM


def embed_chunks(chunks: List[dict], normalize: bool = True) -> List[dict]:
    """
    Embed a list of chunk dicts (from chunker.py output).
    Adds an 'embedding' field to each chunk in-place.

    Args:
        chunks:    List of chunk dicts with at least a 'text' field
        normalize: If True, L2-normalize

    Returns:
        Same chunks list with 'embedding' field added (as list, JSON-serializable)
    """
    if not chunks:
        return chunks

    texts = [c["text"] for c in chunks]
    embeddings = embed_texts(texts, normalize=normalize)

    for chunk, embedding in zip(chunks, embeddings):
        chunk["embedding"] = embedding.tolist()

    return chunks