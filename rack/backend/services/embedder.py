"""
embedder.py
Generates 384-dimensional embeddings using sentence-transformers all-MiniLM-L6-v2.

This model:
  - 384 output dimensions
  - ~22M parameters (lightweight, fast inference on CPU)
  - Trained on 1B+ sentence pairs
  - Uses GeLU activation in transformer layers
  - Max sequence length: 256 tokens (matches our chunk size by design)

Design decisions:
  - Model loaded once as a singleton (not per-request)
  - Batch encoding for efficiency (all chunks at once)
  - Normalized embeddings (unit vectors) so cosine similarity = dot product
  - Same model used for both resume chunks AND job description queries
    (critical: query and document must share the same embedding space)

"""

import numpy as np
from typing import List, Optional

# Lazy-loaded singleton — avoids loading the model on import
_model = None


def _get_model():
    """Load the sentence-transformer model (singleton, loaded once)."""
    global _model
    if _model is None:
        from sentence_transformers import SentenceTransformer
        _model = SentenceTransformer("all-MiniLM-L6-v2")
        print(f"[embedder] Loaded all-MiniLM-L6-v2 (dim={_model.get_sentence_embedding_dimension()})")
    return _model


# ═══════════════════════════════════════════════════════════════════
# PUBLIC API
# ═══════════════════════════════════════════════════════════════════

def embed_texts(texts: List[str], normalize: bool = True) -> np.ndarray:
    """
    Embed a list of text strings into 384-dim vectors.
    
    Args:
        texts: List of text strings to embed
        normalize: If True, L2-normalize vectors (recommended for cosine similarity)
    
    Returns:
        np.ndarray of shape (len(texts), 384), dtype float32
    """
    if not texts:
        return np.array([], dtype=np.float32).reshape(0, 384)
    
    model = _get_model()
    
    # Batch encode — much faster than encoding one at a time
    embeddings = model.encode(
        texts,
        batch_size=32,
        show_progress_bar=False,
        normalize_embeddings=normalize,  # L2 normalize → cosine sim = dot product
        convert_to_numpy=True,
    )
    
    return embeddings.astype(np.float32)


def embed_single(text: str, normalize: bool = True) -> np.ndarray:
    """
    Embed a single text string.
    Convenience wrapper for query-time embedding (e.g., job description).
    
    Returns:
        np.ndarray of shape (384,), dtype float32
    """
    result = embed_texts([text], normalize=normalize)
    return result[0]


def get_embedding_dimension() -> int:
    """Return the embedding dimension (384 for all-MiniLM-L6-v2)."""
    return _get_model().get_sentence_embedding_dimension()


def embed_chunks(chunks: List[dict], normalize: bool = True) -> List[dict]:
    """
    Embed a list of chunk dicts (from chunker.py output).
    Adds an 'embedding' field to each chunk.
    
    Args:
        chunks: List of chunk dicts with at least a 'text' field
        normalize: If True, L2-normalize
    
    Returns:
        Same chunks list with 'embedding' field added (as list, JSON-serializable)
    """
    if not chunks:
        return chunks
    
    texts = [c["text"] for c in chunks]
    embeddings = embed_texts(texts, normalize=normalize)
    
    for chunk, embedding in zip(chunks, embeddings):
        chunk["embedding"] = embedding.tolist()  # Convert to list for JSON storage
    
    return chunks