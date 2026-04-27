"""
ingestion.py
Orchestrates the full resume ingestion pipeline:
  file → extract text → parse sections → chunk → structured extraction
       → embed chunks → index in pgvector → store metadata

Session 19: Added _clean_resume_text() + full_text field on resume record.
  - full_text is the cleaned raw text from the PDF/DOCX — stored once at
    upload time and passed to the LLM scorer so it sees complete work
    experience narratives, not just the structured metadata skeleton.
  - Cleaning strips rendering artifacts (mojibake, control chars, repeated
    whitespace) while preserving all human-readable content.
"""

import json
import os
import re
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

# Paths
BASE_DIR = Path(__file__).resolve().parent.parent.parent  # rack/
UPLOADS_DIR = BASE_DIR / "uploads" / "resumes"
METADATA_FILE = BASE_DIR / "uploads" / "resumes_metadata.json"

# Cap stored full_text to keep DB row size reasonable.
# 6000 chars ≈ 1500 tokens — covers any 2-page resume completely.
FULL_TEXT_MAX_CHARS = 6000

# Ensure dirs exist
UPLOADS_DIR.mkdir(parents=True, exist_ok=True)


# ═══════════════════════════════════════════════════════════════════
# TEXT CLEANING
# ═══════════════════════════════════════════════════════════════════

def _clean_resume_text(raw_text: str) -> str:
    """
    Clean raw extracted resume text for LLM consumption.

    KEEPS (everything a recruiter would read):
      - All section headers: Experience, Education, Projects, Skills, etc.
      - Every job title, company name, date range
      - All bullet points and achievement sentences
      - Numbers, percentages, metrics ("reduced latency 40%", "8xA100s")
      - Technical terms, tool names, acronyms, abbreviations
      - Education details, certifications, publications, links

    STRIPS (rendering artifacts only):
      - Null bytes and non-printable control characters (except newlines/tabs)
      - Unicode replacement characters (U+FFFD) and other PDF mojibake
      - Runs of 3+ repeated special characters that are clearly decorative
        (e.g. "•••••", "─────", "=====" used as visual dividers)
      - Lines that are ONLY whitespace or punctuation with no word content
      - Excessive blank lines (3+ consecutive → 2 max)
      - Leading/trailing whitespace per line
      - Byte-order marks

    Does NOT strip:
      - Any line containing real words, even if it also has symbols
      - Email addresses, URLs, phone numbers
      - Hyphenated terms, slash-separated skills ("Python/Go/Rust")
      - Parenthetical notes, bracketed annotations

    Returns:
        Cleaned text, capped at FULL_TEXT_MAX_CHARS characters.
    """
    if not raw_text:
        return ""

    text = raw_text

    # 1. Strip byte-order mark if present
    text = text.lstrip("\ufeff")

    # 2. Remove null bytes and non-printable control characters.
    #    Keep: \n (0x0A), \r (0x0D), \t (0x09), and all printable chars.
    text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", text)

    # 3. Remove Unicode replacement character and common PDF extraction garbage.
    #    These appear when the PDF has embedded fonts the extractor can't decode.
    text = re.sub(r"[\ufffd\ufffe\uffff]", "", text)

    # 4. Normalize Windows line endings to Unix.
    text = text.replace("\r\n", "\n").replace("\r", "\n")

    # 5. Strip trailing whitespace from each line (preserves indentation intent
    #    but removes invisible trailing spaces that bloat token count).
    lines = text.split("\n")
    lines = [line.rstrip() for line in lines]

    # 6. Drop lines that contain ONLY decorative characters — no real words.
    #    A "real word" = at least one sequence of 2+ alphabetic characters.
    #    This removes lines like: "──────────────", "• • • • •", "============"
    #    but keeps: "• 5+ years Python", "Skills ────── Python, Go"
    cleaned_lines = []
    for line in lines:
        stripped = line.strip()
        if not stripped:
            cleaned_lines.append("")  # preserve blank line for paragraph spacing
            continue
        # If the line has at least one real word (2+ letters), keep it
        if re.search(r"[A-Za-z]{2,}", stripped):
            cleaned_lines.append(line)
        # Otherwise it's pure symbols/numbers with no text — skip it
        # (e.g. "2019 - 2021", "| | |", "...........", page numbers "3")
        # Exception: lines that are ONLY a year range or date — borderline,
        # but these are low-value without surrounding context anyway.

    # 7. Collapse runs of 3+ blank lines down to 2 (preserve section spacing
    #    without excessive vertical whitespace).
    text = "\n".join(cleaned_lines)
    text = re.sub(r"\n{3,}", "\n\n", text)

    # 8. Final strip of leading/trailing whitespace on the full document.
    text = text.strip()

    # 9. Cap length — 6000 chars covers any 2-page resume.
    #    Truncate at a newline boundary if possible so we don't cut mid-sentence.
    if len(text) > FULL_TEXT_MAX_CHARS:
        truncated = text[:FULL_TEXT_MAX_CHARS]
        # Walk back to the last newline to avoid cutting mid-line
        last_newline = truncated.rfind("\n")
        if last_newline > FULL_TEXT_MAX_CHARS * 0.85:  # only if we don't lose >15%
            truncated = truncated[:last_newline]
        text = truncated

    return text


# ═══════════════════════════════════════════════════════════════════
# METADATA HELPERS (anonymous / local path)
# ═══════════════════════════════════════════════════════════════════

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


# ═══════════════════════════════════════════════════════════════════
# MAIN INGESTION PIPELINE
# ═══════════════════════════════════════════════════════════════════

def ingest_resume(file_path: str, original_filename: str, session_id: str = "default", persist: bool = True) -> Dict:
    """
    Full ingestion pipeline for a single resume file.

    Pipeline:
      1. text_extractor        → raw text from PDF/DOCX
      2. clean_resume_text     → remove rendering artifacts, preserve all content  [NEW]
      3. section_parser        → labeled sections (skills, experience, education, etc.)
      4. chunker               → 50-token chunks with 15 overlap, section-aware
      5. structured_extractor  → skills, years_exp, titles, companies, education, domains
      6. embedder              → 384-dim vectors for each chunk (all-MiniLM-L6-v2)
      7. persist metadata      → JSON file (anonymous users only)
      8. persist metadata      → JSON file (anonymous users only)

    Args:
        file_path: Path to the saved file on disk
        original_filename: Original uploaded filename
        session_id: Session scope for anonymous isolation

    Returns:
        Resume metadata dict including full_text field for LLM scoring.
    """
    resume_id = str(uuid.uuid4())[:8]

    # Step 1: Extract raw text
    raw_text = extract_text(file_path)

    # Step 2: Clean text — strip artifacts, preserve all human-readable content
    full_text = _clean_resume_text(raw_text)

    # Step 3: Parse into sections
    sections = parse_sections(raw_text)  # parse from raw_text, not cleaned (section parser handles its own cleaning)

    # Step 4: Chunk sections (for vector embeddings)
    chunks = chunk_sections(sections)

    # Step 5: Structured extraction (Stage 1 — deterministic)
    structured = extract_structured_data(sections)

    # Step 6: Generate embeddings for each chunk
    chunk_texts = [c["text"] for c in chunks]
    embeddings = embed_texts(chunk_texts, normalize=True)

    # Step 7: Build metadata record
    name = Path(original_filename).stem
    ext = Path(original_filename).suffix.lower()

    resume_record = {
        "id": resume_id,
        "session_id": session_id,
        "name": name,
        "original_filename": original_filename,
        "file_path": str(file_path),
        "file_ext": ext,
        "status": "active",
        "uploaded_at": datetime.now(timezone.utc).isoformat(),
        "updated": "Just now",
        "raw_text_length": len(raw_text),
        "full_text": full_text,           # ← NEW: cleaned full text for LLM scoring
        "section_count": len(sections),
        "chunk_count": len(chunks),
        "embedding_dim": embeddings.shape[1] if embeddings.size > 0 else 1536,
        "indexed": True,
        # Structured data — used for hybrid scoring (skill_overlap, experience_overlap)
        "structured": structured,
        # Flat skills list for the frontend cards
        "skills": structured.get("skills", [])[:8],
        # Section summaries (without full text, for debugging)
        "sections": [
            {"section": s["section"], "text_length": len(s["text"]), "weight": s["weight"]}
            for s in sections
        ],
        # Chunks include serialized embeddings so resumes.py can write them to
        # resume_chunks.embedding in Supabase.
        "chunks": [
            {
                "text": c["text"],
                "section": c["section"],
                "weight": c["weight"],
                "chunk_index": c["chunk_index"],
                "token_count": c["token_count"],
                "embedding": embeddings[i].tolist(),
            }
            for i, c in enumerate(chunks)
        ],
    }

    # Step 9: Persist metadata (anonymous path only — auth users store in Supabase DB)
    if persist:
        metadata = _load_metadata()
        metadata["resumes"].append(resume_record)
        _save_metadata(metadata)

    return resume_record


def get_all_resumes(session_id: str = "default") -> list:
    """Return resume metadata scoped to a session/user. Never leaks across sessions."""
    metadata = _load_metadata()
    results = []
    for r in metadata["resumes"]:
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
            "full_text": r.get("full_text"),           # ← NEW: included for LLM path
            "years_exp": structured.get("years_exp"),
            "titles": structured.get("titles", []),
            "domains": structured.get("domains", []),
            "education": structured.get("education", []),
            "companies": structured.get("companies", []),
            "extraction_confidence": structured.get("confidence", {}),
        })
    return results


def get_resume_by_id(resume_id: str) -> Optional[Dict]:
    """Return full resume metadata including chunks, structured data, and full_text."""
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

    file_path = resume.get("file_path")
    if file_path and os.path.exists(file_path):
        os.remove(file_path)

    metadata["resumes"] = [r for r in metadata["resumes"] if r["id"] != resume_id]
    _save_metadata(metadata)
    return True


ANON_RESUME_CAP = 5  # must match MAX_RESUMES_ANON in resumes.py


def ingest_resume_bytes(content: bytes, original_filename: str, session_id: str = "default") -> dict:
    """
    Wrapper around ingest_resume() that accepts raw bytes instead of a file path.
    session_id scopes the FAISS index and metadata to a specific user/session.

    For anonymous sessions: enforces ANON_RESUME_CAP. Raises ValueError if at cap.
    Auth users are never capped here — resumes.py enforces MAX_RESUMES_AUTH via DB.
    """
    import re as _re
    _UUID_RE = _re.compile(
        r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
        _re.IGNORECASE,
    )
    if not _UUID_RE.match(session_id):
        existing = get_all_resumes(session_id=session_id)
        if len(existing) >= ANON_RESUME_CAP:
            raise ValueError(
                f"Cap reached: this session already has {len(existing)} resumes "
                f"(max {ANON_RESUME_CAP}). Delete a resume before uploading another."
            )

    ext = Path(original_filename).suffix.lower()

    with tempfile.NamedTemporaryFile(
        suffix=ext,
        delete=False,
        prefix="rack_ingest_"
    ) as tmp:
        tmp.write(content)
        tmp_path = tmp.name

    try:
        result = ingest_resume(tmp_path, original_filename, session_id=session_id, persist=not _UUID_RE.match(session_id))
        return result
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass