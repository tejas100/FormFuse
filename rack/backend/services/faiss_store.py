"""
faiss_store.py
FAISS IVFFlat index for vector storage and similarity search.

Architecture:
  - IVFFlat (Inverted File with Flat quantization)
  - Uses inner product (= cosine similarity when vectors are L2-normalized)
  - nprobe=3 by default (tunable accuracy/speed tradeoff)
  - One index file per user (stored on disk, loaded into memory for search)
  - Metadata stored alongside in a JSON sidecar file

Why IVFFlat over Flat:
  - Flat index does exact search (O(n) per query) — fine for < 100 vectors
  - IVFFlat partitions vectors into Voronoi cells, searches only nprobe cells
  - At scale (1000+ vectors), IVFFlat is significantly faster
  - nprobe gives direct control over accuracy/speed tradeoff
  - For our current scale (3-5 resumes, ~30 chunks), we start with Flat
    and auto-switch to IVFFlat when vectors exceed the threshold


Design decisions:
  1. FAISS over ChromaDB — direct control over nprobe, no external server needed
  2. Inner product over L2 distance — with normalized vectors, IP = cosine sim
  3. Disk persistence — index saved/loaded per user, survives server restarts
  4. Metadata sidecar — chunk text, section, weight stored alongside vectors
  5. Auto index type — Flat for small collections, IVFFlat when vectors > threshold
"""

import json
import os
import numpy as np
import faiss
from pathlib import Path
from typing import Dict, List, Optional, Tuple

# ═══════════════════════════════════════════════════════════════════
# CONFIGURATION
# ═══════════════════════════════════════════════════════════════════

EMBEDDING_DIM = 384                # all-MiniLM-L6-v2 output dimension
IVFFLAT_THRESHOLD = 100            # Switch from Flat to IVFFlat above this many vectors
NPROBE_DEFAULT = 3                 # Cells to search at query time (accuracy/speed knob)
NLIST_FACTOR = 4                   # Number of cells = total_vectors / NLIST_FACTOR

# Storage paths
BASE_DIR = Path(__file__).resolve().parent.parent.parent  # rack/
FAISS_DIR = BASE_DIR / "uploads" / "faiss_indexes"
FAISS_DIR.mkdir(parents=True, exist_ok=True)


# ═══════════════════════════════════════════════════════════════════
# INDEX MANAGEMENT
# ═══════════════════════════════════════════════════════════════════

def _index_path(user_id: str = "default") -> Path:
    """Path to the FAISS index file for a user."""
    return FAISS_DIR / f"{user_id}.index"


def _metadata_path(user_id: str = "default") -> Path:
    """Path to the metadata sidecar JSON for a user."""
    return FAISS_DIR / f"{user_id}_metadata.json"


def _load_metadata(user_id: str = "default") -> Dict:
    """Load the metadata sidecar file."""
    path = _metadata_path(user_id)
    if path.exists():
        with open(path, "r") as f:
            return json.load(f)
    return {"chunks": [], "resume_ids": []}


def _save_metadata(metadata: Dict, user_id: str = "default"):
    """Save the metadata sidecar file."""
    with open(_metadata_path(user_id), "w") as f:
        json.dump(metadata, f, indent=2, default=str)


def _build_index(vectors: np.ndarray) -> faiss.Index:
    """
    Build a FAISS index from vectors.
    Auto-selects Flat or IVFFlat based on vector count.
    
    - Flat: exact search, O(n), best for small collections
    - IVFFlat: approximate search, sub-linear, best for larger collections
    """
    n_vectors, dim = vectors.shape

    if n_vectors < IVFFLAT_THRESHOLD:
        # Flat index — exact inner product search
        index = faiss.IndexFlatIP(dim)
        index.add(vectors)
        return index
    else:
        # IVFFlat — partitioned search
        nlist = max(2, n_vectors // NLIST_FACTOR)  # Number of Voronoi cells
        
        quantizer = faiss.IndexFlatIP(dim)
        index = faiss.IndexIVFFlat(quantizer, dim, nlist, faiss.METRIC_INNER_PRODUCT)
        
        # IVFFlat requires training on representative vectors
        index.train(vectors)
        index.add(vectors)
        index.nprobe = NPROBE_DEFAULT
        
        return index


# ═══════════════════════════════════════════════════════════════════
# PUBLIC API
# ═══════════════════════════════════════════════════════════════════

def add_resume_vectors(
    resume_id: str,
    chunks: List[Dict],
    embeddings: np.ndarray,
    user_id: str = "default"
) -> Dict:
    """
    Add a resume's chunk vectors to the FAISS index.
    
    Args:
        resume_id: Unique resume identifier
        chunks: List of chunk dicts (text, section, weight, etc.)
        embeddings: np.ndarray of shape (n_chunks, 384)
        user_id: User identifier for per-user indexes
    
    Returns:
        Dict with index stats
    """
    if len(chunks) != embeddings.shape[0]:
        raise ValueError(f"Chunk count ({len(chunks)}) != embedding count ({embeddings.shape[0]})")

    # Load existing metadata
    metadata = _load_metadata(user_id)
    
    # Track which resume IDs are in the index
    if resume_id not in metadata.get("resume_ids", []):
        metadata.setdefault("resume_ids", []).append(resume_id)
    
    # Store starting index for this batch
    start_idx = len(metadata["chunks"])
    
    # Add chunk metadata (without the embedding — that goes in FAISS)
    for i, chunk in enumerate(chunks):
        metadata["chunks"].append({
            "resume_id": resume_id,
            "text": chunk["text"],
            "section": chunk["section"],
            "weight": chunk["weight"],
            "chunk_index": chunk.get("chunk_index", i),
            "faiss_idx": start_idx + i,
        })
    
    # Rebuild the full index with all vectors
    # (For production at scale, you'd do incremental adds.
    #  At our scale of ~30 chunks per resume, rebuilding is fine.)
    all_embeddings = _collect_all_embeddings(metadata, embeddings, start_idx)
    index = _build_index(all_embeddings)
    
    # Save to disk
    faiss.write_index(index, str(_index_path(user_id)))
    _save_metadata(metadata, user_id)
    
    return {
        "resume_id": resume_id,
        "chunks_added": len(chunks),
        "total_vectors": len(metadata["chunks"]),
        "index_type": "IVFFlat" if len(metadata["chunks"]) >= IVFFLAT_THRESHOLD else "Flat",
    }


def _collect_all_embeddings(
    metadata: Dict,
    new_embeddings: np.ndarray,
    start_idx: int
) -> np.ndarray:
    """
    Collect all embeddings for index rebuild.
    For existing chunks, we need to re-embed or load from stored embeddings.
    For simplicity, we store embeddings in the metadata sidecar.
    """
    # If this is the first batch, just return the new embeddings
    if start_idx == 0:
        # Store embeddings in metadata for future rebuilds
        for i, chunk in enumerate(metadata["chunks"]):
            chunk["_embedding"] = new_embeddings[i].tolist()
        return new_embeddings
    
    # Otherwise, collect existing + new
    existing_vectors = []
    for chunk in metadata["chunks"][:start_idx]:
        if "_embedding" in chunk:
            existing_vectors.append(chunk["_embedding"])
        else:
            # This shouldn't happen, but handle gracefully
            existing_vectors.append(np.zeros(EMBEDDING_DIM).tolist())
    
    # Store new embeddings in metadata
    for i, chunk in enumerate(metadata["chunks"][start_idx:]):
        chunk["_embedding"] = new_embeddings[i].tolist()
    
    existing_array = np.array(existing_vectors, dtype=np.float32)
    all_vectors = np.vstack([existing_array, new_embeddings])
    return all_vectors


def search(
    query_embedding: np.ndarray,
    top_k: int = 5,
    user_id: str = "default",
    nprobe: Optional[int] = None,
    resume_id_filter: Optional[str] = None,
) -> List[Dict]:
    """
    Search the FAISS index for the top-K most similar chunks.
    
    Args:
        query_embedding: 384-dim query vector (e.g., embedded job description)
        top_k: Number of results to return
        user_id: User identifier
        nprobe: Override default nprobe (accuracy/speed tradeoff)
        resume_id_filter: Optional filter to search only one resume
    
    Returns:
        List of result dicts sorted by score descending:
        [
            {
                "text": "chunk text...",
                "section": "experience",
                "weight": 0.7,
                "resume_id": "abc123",
                "score": 0.87,       # cosine similarity (0-1)
                "faiss_idx": 3,
            },
            ...
        ]
    """
    index_file = _index_path(user_id)
    if not index_file.exists():
        return []
    
    # Load index
    index = faiss.read_index(str(index_file))
    metadata = _load_metadata(user_id)
    
    # Set nprobe if IVFFlat
    if nprobe and hasattr(index, 'nprobe'):
        index.nprobe = nprobe
    
    # Reshape query for FAISS (needs 2D array)
    if query_embedding.ndim == 1:
        query_embedding = query_embedding.reshape(1, -1)
    
    # Search — returns distances (= inner product = cosine sim for normalized vectors)
    # Fetch extra results if we need to filter by resume_id
    fetch_k = top_k * 3 if resume_id_filter else top_k
    fetch_k = min(fetch_k, len(metadata["chunks"]))  # Can't fetch more than we have
    
    if fetch_k == 0:
        return []
    
    scores, indices = index.search(query_embedding, fetch_k)
    
    # Build results
    results = []
    for score, idx in zip(scores[0], indices[0]):
        if idx < 0 or idx >= len(metadata["chunks"]):
            continue  # FAISS returns -1 for missing results
        
        chunk_meta = metadata["chunks"][idx]
        
        # Apply resume filter if specified
        if resume_id_filter and chunk_meta["resume_id"] != resume_id_filter:
            continue
        
        results.append({
            "text": chunk_meta["text"],
            "section": chunk_meta["section"],
            "weight": chunk_meta["weight"],
            "resume_id": chunk_meta["resume_id"],
            "chunk_index": chunk_meta.get("chunk_index", 0),
            "score": float(score),  # cosine similarity
            "faiss_idx": int(idx),
        })
        
        if len(results) >= top_k:
            break
    
    return results


def remove_resume_vectors(resume_id: str, user_id: str = "default") -> bool:
    """
    Remove all vectors for a specific resume and rebuild the index.
    
    Returns True if successful.
    """
    metadata = _load_metadata(user_id)
    
    # Filter out chunks belonging to this resume
    remaining_chunks = [c for c in metadata["chunks"] if c["resume_id"] != resume_id]
    
    if len(remaining_chunks) == len(metadata["chunks"]):
        return False  # Resume not found in index
    
    # Update metadata
    metadata["chunks"] = remaining_chunks
    metadata["resume_ids"] = [rid for rid in metadata.get("resume_ids", []) if rid != resume_id]
    
    # Re-index remaining vectors
    if remaining_chunks:
        vectors = np.array(
            [c["_embedding"] for c in remaining_chunks if "_embedding" in c],
            dtype=np.float32
        )
        
        if vectors.shape[0] > 0:
            # Update faiss_idx for remaining chunks
            for i, chunk in enumerate(remaining_chunks):
                chunk["faiss_idx"] = i
            
            index = _build_index(vectors)
            faiss.write_index(index, str(_index_path(user_id)))
        else:
            # No vectors left — remove index file
            index_path = _index_path(user_id)
            if index_path.exists():
                os.remove(str(index_path))
    else:
        # No chunks left — clean up files
        index_path = _index_path(user_id)
        if index_path.exists():
            os.remove(str(index_path))
    
    _save_metadata(metadata, user_id)
    return True


def get_index_stats(user_id: str = "default") -> Dict:
    """Return stats about the current FAISS index."""
    metadata = _load_metadata(user_id)
    index_file = _index_path(user_id)
    
    stats = {
        "total_vectors": len(metadata["chunks"]),
        "resume_count": len(metadata.get("resume_ids", [])),
        "resume_ids": metadata.get("resume_ids", []),
        "index_exists": index_file.exists(),
        "index_type": "IVFFlat" if len(metadata["chunks"]) >= IVFFLAT_THRESHOLD else "Flat",
        "embedding_dim": EMBEDDING_DIM,
        "nprobe": NPROBE_DEFAULT,
    }
    
    if index_file.exists():
        index = faiss.read_index(str(index_file))
        stats["index_ntotal"] = index.ntotal
    
    return stats