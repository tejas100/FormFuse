"""
ingestion.py
Orchestrates the full resume ingestion pipeline:
  file → extract text → parse sections → chunk → structured extraction
       → embed chunks → index in FAISS → store metadata

This runs synchronously on upload. In production, this would be
an async Celery/RQ task to avoid blocking the upload response.

Pipeline timing (typical, single resume on CPU):
  text_extractor:        ~50ms
  section_parser:        ~5ms
  chunker:               ~2ms
  structured_extractor:  ~10ms
  embedder:              ~200-500ms  (model loads once, cached after)
  faiss_store:           ~5ms
  Total first upload:    ~2-3s (includes model load)
  Subsequent uploads:    ~300-600ms
"""

import json
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Optional
import tempfile

from services.text_extractor import extract_text
from services.section_parser import parse_sections
from services.chunker import chunk_sections
from services.structured_extractor import extract_structured_data
from services.embedder import embed_texts
from services.faiss_store import add_resume_vectors, remove_resume_vectors

# Paths
BASE_DIR = Path(__file__).resolve().parent.parent.parent  # rack/
UPLOADS_DIR = BASE_DIR / "uploads" / "resumes"
METADATA_FILE = BASE_DIR / "uploads" / "resumes_metadata.json"

# Ensure dirs exist
UPLOADS_DIR.mkdir(parents=True, exist_ok=True)


def _load_metadata() -> Dict:
    """Load the metadata JSON file."""
    if METADATA_FILE.exists():
        with open(METADATA_FILE, "r") as f:
            return json.load(f)
    return {"resumes": []}


def _save_metadata(data: Dict):
    """Save the metadata JSON file."""
    with open(METADATA_FILE, "w") as f:
        json.dump(data, f, indent=2, default=str)


def ingest_resume(file_path: str, original_filename: str, session_id: str = "default") -> Dict:
    """
    Full ingestion pipeline for a single resume file.

    Pipeline:
      1. text_extractor        → raw text from PDF/DOCX
      2. section_parser        → labeled sections (skills, experience, education, etc.)
      3. chunker               → 256-token chunks with 32 overlap, section-aware
      4. structured_extractor  → skills, years_exp, titles, companies, education, domains
      5. embedder              → 384-dim vectors for each chunk (all-MiniLM-L6-v2)
      6. faiss_store           → index vectors for similarity search
      7. persist metadata      → JSON file (will move to Postgres later)

    Args:
        file_path: Path to the saved file on disk
        original_filename: Original uploaded filename

    Returns:
        Resume metadata dict with id, name, chunks, structured data, etc.
    """
    resume_id = str(uuid.uuid4())[:8]

    # Step 1: Extract raw text
    raw_text = extract_text(file_path)

    # Step 2: Parse into sections
    sections = parse_sections(raw_text)

    # Step 3: Chunk sections (for vector embeddings)
    chunks = chunk_sections(sections)

    # Step 4: Structured extraction (Stage 1 — deterministic)
    structured = extract_structured_data(sections)

    # Step 5: Generate embeddings for each chunk
    chunk_texts = [c["text"] for c in chunks]
    embeddings = embed_texts(chunk_texts, normalize=True)

    # Step 6: Index vectors in FAISS — scoped to session_id
    index_result = add_resume_vectors(
        resume_id=resume_id,
        chunks=chunks,
        embeddings=embeddings,
        user_id=session_id,
    )

    # Step 7: Build metadata record
    name = Path(original_filename).stem
    ext = Path(original_filename).suffix.lower()

    resume_record = {
        "id": resume_id,
        "session_id": session_id,          # ← scope key for anonymous isolation
        "name": name,
        "original_filename": original_filename,
        "file_path": str(file_path),
        "file_ext": ext,
        "status": "active",
        "uploaded_at": datetime.now(timezone.utc).isoformat(),
        "updated": "Just now",
        "raw_text_length": len(raw_text),
        "section_count": len(sections),
        "chunk_count": len(chunks),
        "embedding_dim": embeddings.shape[1] if embeddings.size > 0 else 384,
        "indexed": True,
        "index_stats": index_result,
        # Structured data — used for hybrid scoring (skill_overlap, experience_overlap)
        "structured": structured,
        # Flat skills list for the frontend cards
        "skills": structured.get("skills", [])[:8],
        # Section summaries (without full text, for debugging)
        "sections": [
            {"section": s["section"], "text_length": len(s["text"]), "weight": s["weight"]}
            for s in sections
        ],
        # Chunks stored without embeddings (those are in FAISS now)
        "chunks": [
            {
                "text": c["text"],
                "section": c["section"],
                "weight": c["weight"],
                "chunk_index": c["chunk_index"],
                "token_count": c["token_count"],
            }
            for c in chunks
        ],
    }

    # Step 8: Persist metadata
    metadata = _load_metadata()
    metadata["resumes"].append(resume_record)
    _save_metadata(metadata)

    return resume_record


def get_all_resumes(session_id: str = "default") -> list:
    """Return resume metadata scoped to a session/user. Never leaks across sessions."""
    metadata = _load_metadata()
    results = []
    for r in metadata["resumes"]:
        # Filter: only return resumes belonging to this session
        if r.get("session_id", "default") != session_id:
            continue
        structured = r.get("structured", {})
        results.append({
            "id": r["id"],
            "name": r["name"],
            "original_filename": r["original_filename"],
            "file_ext": r["file_ext"],
            "status": r["status"],
            "uploaded_at": r["uploaded_at"],
            "updated": r.get("updated", r["uploaded_at"]),
            "skills": r.get("skills", []),
            "chunk_count": r.get("chunk_count", 0),
            "section_count": r.get("section_count", 0),
            "indexed": r.get("indexed", False),
            # Structured summary for frontend
            "years_exp": structured.get("years_exp"),
            "titles": structured.get("titles", []),
            "domains": structured.get("domains", []),
            "education": structured.get("education", []),
            "companies": structured.get("companies", []),
            "extraction_confidence": structured.get("confidence", {}),
        })
    return results


def get_resume_by_id(resume_id: str) -> Optional[Dict]:
    """Return full resume metadata including chunks and structured data."""
    metadata = _load_metadata()
    for r in metadata["resumes"]:
        if r["id"] == resume_id:
            return r
    return None


def delete_resume(resume_id: str, session_id: str = "default") -> bool:
    """Delete resume file, FAISS vectors, and metadata."""
    metadata = _load_metadata()
    resume = None
    for r in metadata["resumes"]:
        if r["id"] == resume_id:
            resume = r
            break

    if not resume:
        return False

    # Delete file from disk
    file_path = resume.get("file_path")
    if file_path and os.path.exists(file_path):
        os.remove(file_path)

    # Remove vectors from FAISS index — use stored session_id if available
    effective_session = resume.get("session_id", session_id)
    remove_resume_vectors(resume_id, user_id=effective_session)

    # Remove from metadata
    metadata["resumes"] = [r for r in metadata["resumes"] if r["id"] != resume_id]
    _save_metadata(metadata)
    return True


def ingest_resume_bytes(content: bytes, original_filename: str, session_id: str = "default") -> dict:
    """
    Wrapper around ingest_resume() that accepts raw bytes instead of a file path.
    session_id scopes the FAISS index and metadata to a specific user/session.
    """
    ext = Path(original_filename).suffix.lower()
    
    with tempfile.NamedTemporaryFile(
        suffix=ext,
        delete=False,
        prefix="rack_ingest_"
    ) as tmp:
        tmp.write(content)
        tmp_path = tmp.name
    
    try:
        result = ingest_resume(tmp_path, original_filename, session_id=session_id)
        return result
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass