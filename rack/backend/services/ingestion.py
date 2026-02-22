"""
ingestion.py
Orchestrates the resume ingestion pipeline:
  file → extract text → parse sections → chunk → structured extraction → store metadata

This runs synchronously on upload. In production, this would be
an async Celery/RQ task to avoid blocking the upload response.
"""

import json
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Optional

from services.text_extractor import extract_text
from services.section_parser import parse_sections
from services.chunker import chunk_sections
from services.structured_extractor import extract_structured_data

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


def ingest_resume(file_path: str, original_filename: str) -> Dict:
    """
    Full ingestion pipeline for a single resume file.

    Pipeline:
      1. text_extractor   → raw text from PDF/DOCX
      2. section_parser   → labeled sections (skills, experience, education, etc.)
      3. chunker          → 256-token chunks with 32 overlap, section-aware
      4. structured_extractor → skills, years_exp, titles, companies, education, domains
      5. persist metadata  → JSON file (will move to Postgres later)

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

    # Step 3: Chunk sections (for vector embeddings later)
    chunks = chunk_sections(sections)

    # Step 4: Structured extraction (Stage 1 — deterministic)
    structured = extract_structured_data(sections)

    # Step 5: Build metadata record
    name = Path(original_filename).stem
    ext = Path(original_filename).suffix.lower()

    resume_record = {
        "id": resume_id,
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
        # Structured data — used for hybrid scoring (skill_overlap, experience_overlap)
        "structured": structured,
        # Flat skills list for the frontend cards
        "skills": structured.get("skills", [])[:8],
        # Section summaries (without full text, for debugging)
        "sections": [
            {"section": s["section"], "text_length": len(s["text"]), "weight": s["weight"]}
            for s in sections
        ],
        # Full chunks stored here for now; will move to FAISS after embedder is built
        "chunks": chunks,
    }

    # Step 6: Persist metadata
    metadata = _load_metadata()
    metadata["resumes"].append(resume_record)
    _save_metadata(metadata)

    return resume_record


def get_all_resumes() -> list:
    """Return all resume metadata (without full chunk text for list view)."""
    metadata = _load_metadata()
    results = []
    for r in metadata["resumes"]:
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


def delete_resume(resume_id: str) -> bool:
    """Delete resume file and metadata."""
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

    # Remove from metadata
    metadata["resumes"] = [r for r in metadata["resumes"] if r["id"] != resume_id]
    _save_metadata(metadata)
    return True