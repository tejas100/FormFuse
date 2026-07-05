"""
services/resume_parser.py — Structured resume extraction for RACK

Converts an uploaded resume PDF into the shared document model used by the
optimizer, the editor (ResumeEditor.jsx), and the PDF renderer. This is the
foundation everything else builds on: patches target stable IDs from this
structure, never raw text offsets.

DOCUMENT MODEL (the contract — frontend and backend both key off this):
{
  "header":    { "name": str, "location": str, "email": str, "phone": str,
                 "linkedin": str, "github": str, "website": str },
  "summary":   { "id": "summary", "text": str } | null,
  "skills":    [ { "group_id": str, "group_label": str,
                    "items": [ { "id": str, "text": str } ] } ],
  "experience":[ { "company_id": str, "company": str, "title": str, "dates": str,
                    "bullets": [ { "id": str, "text": str } ] } ],
  "projects":  [ { "project_id": str, "name": str,
                    "bullets": [ { "id": str, "text": str } ] } ],
  "education": [ { "id": str, "school": str, "degree": str, "dates": str } ],
  "certifications": [ { "id": str, "text": str } ],
  "publications": [ { "id": str, "text": str } ]
}

Every leaf that can be individually patched (summary, a skill item, a bullet)
carries a stable `id`. IDs are deterministic (slug of company/section + index)
so re-parsing the same resume produces the same IDs — required for
`resumes.structured_json` caching to stay valid across optimize calls.

Extraction strategy:
  1. PyMuPDF (fitz) — primary. Pulls text blocks with font-size metadata,
     which is what lets us tell a section heading ("EXPERIENCE") apart from
     body text (font size / bold heuristic), without an LLM call.
  2. Heading-regex fallback — if PyMuPDF returns too few blocks (scanned
     image, broken text layer), fall back to segmenting the resume's
     existing plain-text `full_text` column using the same section-header
     keywords ingestion.py already recognizes. Lower fidelity (no bullet-
     level granularity guarantee) but never hard-fails.

Called from:
  services/resume_optimizer.py  — get_or_build_structured_resume()
  routers/apply.py              — resume review endpoint (re-renders on demand)
"""

import hashlib
import logging
import re
from typing import Optional

logger = logging.getLogger(__name__)

_SECTION_HEADERS = {
    "summary":        ("summary", "objective", "profile"),
    "skills":         ("skills", "technical skills", "technologies", "core competencies"),
    "experience":     ("experience", "work experience", "employment", "work history",
                        "professional experience"),
    "projects":       ("projects", "personal projects", "selected projects"),
    "education":      ("education",),
    "certifications": ("certifications", "certificates", "licenses"),
    "publications":   ("publications", "publication", "papers"),
}

_EMAIL_RE    = re.compile(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}")
_PHONE_RE    = re.compile(r"\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}")
_LINKEDIN_RE = re.compile(r"(?:https?://)?(?:www\.)?linkedin\.com/in/[\w-]+", re.I)
_GITHUB_RE   = re.compile(r"(?:https?://)?(?:www\.)?github\.com/[\w-]+", re.I)
_DATE_TOKEN = (
    r"(?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s*\d{4}"  # "August 2025" / "Aug. 2025"
    r"|\d{1,2}/\d{4}"                                                          # "08/2025"
    r"|\d{4})"                                                                 # "2025"
)
_DATE_RANGE_RE = re.compile(
    rf"({_DATE_TOKEN})\s*[-–—]\s*({_DATE_TOKEN}|Present|Current)",
    re.I,
)


def _slug(text: str, maxlen: int = 24) -> str:
    s = re.sub(r"[^a-z0-9]+", "_", (text or "").lower()).strip("_")
    return (s or "x")[:maxlen]


def _stable_id(*parts: str) -> str:
    """Deterministic short id — same input always yields same id (caching invariant)."""
    joined = "|".join(parts)
    h = hashlib.sha1(joined.encode("utf-8")).hexdigest()[:8]
    return f"{_slug(parts[0] if parts else 'x', 12)}_{h}"


def _classify_header_section(line: str) -> Optional[str]:
    ll = line.strip().lower().rstrip(":")
    if len(ll) > 40:
        return None
    for section, keywords in _SECTION_HEADERS.items():
        if ll in keywords or any(ll == kw for kw in keywords):
            return section
    return None


# ── PyMuPDF primary path ─────────────────────────────────────────────────────

def _extract_blocks_pymupdf(pdf_bytes: bytes) -> Optional[list[dict]]:
    """
    Returns a flat list of {"text": str, "size": float, "bold": bool, "page": int}
    in reading order, or None if PyMuPDF isn't available / extraction is too thin.
    """
    try:
        import fitz  # PyMuPDF
    except ImportError:
        logger.warning("[resume_parser] PyMuPDF not installed — falling back to plain text")
        return None

    try:
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    except Exception as e:
        logger.warning(f"[resume_parser] PyMuPDF failed to open PDF: {e}")
        return None

    lines: list[dict] = []
    for page_idx, page in enumerate(doc):
        try:
            raw = page.get_text("dict")
        except Exception:
            continue
        for block in raw.get("blocks", []):
            for line in block.get("lines", []):
                spans = line.get("spans", [])
                if not spans:
                    continue
                text = "".join(s.get("text", "") for s in spans).strip()
                if not text:
                    continue
                # Representative span for size/bold — the first non-empty one
                rep = next((s for s in spans if s.get("text", "").strip()), spans[0])
                size = round(rep.get("size", 10.0), 1)
                font = (rep.get("font") or "").lower()
                bold = "bold" in font or bool(rep.get("flags", 0) & 2**4)
                lines.append({"text": text, "size": size, "bold": bold, "page": page_idx})

    doc.close()
    if len(lines) < 8:
        # Too thin — likely a scanned/image-only PDF, not worth trusting
        return None
    return lines


def _split_bullets(block_text: str) -> list[str]:
    """A bullet 'block' from the regex fallback may contain multiple bullets glued together."""
    parts = re.split(r"(?:^|\n)\s*[•▪●\-–\*]\s+", block_text)
    return [p.strip() for p in parts if p.strip()]


# ── Structure builder — works from either extraction path ──────────────────

def _build_from_lines(lines: list[dict]) -> dict:
    """Segment size/bold-tagged lines into the document model."""
    doc = {
        "header": {"name": "", "location": "", "email": "", "phone": "",
                   "linkedin": "", "github": "", "website": ""},
        "summary": None,
        "skills": [],
        "experience": [],
        "projects": [],
        "education": [],
        "certifications": [],
        "publications": [],
    }

    # Header: first few lines before any recognized section heading
    body_start = 0
    header_lines = []
    for i, ln in enumerate(lines[:12]):
        if _classify_header_section(ln["text"]):
            body_start = i
            break
        header_lines.append(ln["text"])
        body_start = i + 1

    header_blob = " | ".join(header_lines)
    if header_lines:
        doc["header"]["name"] = header_lines[0][:80]
    em = _EMAIL_RE.search(header_blob)
    ph = _PHONE_RE.search(header_blob)
    li = _LINKEDIN_RE.search(header_blob)
    gh = _GITHUB_RE.search(header_blob)
    doc["header"]["email"]    = em.group(0) if em else ""
    doc["header"]["phone"]    = ph.group(0) if ph else ""
    doc["header"]["linkedin"] = li.group(0) if li else ""
    doc["header"]["github"]   = gh.group(0) if gh else ""

    # Walk remaining lines, tracking current section
    current_section = None
    current_company = None      # dict ref into doc["experience"]
    current_project = None
    skills_group_counter = 0

    for ln in lines[body_start:]:
        text = ln["text"].strip()
        if not text:
            continue

        sec = _classify_header_section(text)
        if sec:
            current_section = sec
            current_company = None
            current_project = None
            continue

        if current_section == "summary":
            if doc["summary"] is None:
                doc["summary"] = {"id": "summary", "text": text}
            else:
                doc["summary"]["text"] += " " + text
            continue

        if current_section == "skills":
            # Pattern: "Group Label: item1, item2, item3"
            m = re.match(r"^([A-Za-z /&]{2,30}):\s*(.+)$", text)
            if m:
                group_label = m.group(1).strip()
                items_text = m.group(2)
            else:
                skills_group_counter += 1
                group_label = f"Skills {skills_group_counter}"
                items_text = text
            group_id = _stable_id("skills", group_label)
            items = [i.strip() for i in re.split(r",|;", items_text) if i.strip()]
            doc["skills"].append({
                "group_id": group_id,
                "group_label": group_label,
                "items": [
                    {"id": _stable_id(group_id, item, str(idx)), "text": item}
                    for idx, item in enumerate(items)
                ],
            })
            continue

        if current_section == "experience":
            is_bullet = bool(re.match(r"^\s*[•▪●\-–\*]\s+", text)) or (
                current_company is not None and not _DATE_RANGE_RE.search(text) and not ln["bold"]
            )
            if not is_bullet or current_company is None:
                # New company/title line — bold lines or lines with a date range
                # that aren't clearly a bullet start a new experience entry
                dates_m = _DATE_RANGE_RE.search(text)
                dates = f"{dates_m.group(1)} - {dates_m.group(2)}" if dates_m else ""
                # "Company | Title" or "Title, Company" — best-effort split
                head = _DATE_RANGE_RE.sub("", text).strip(" |,-–")
                if "|" in head:
                    company, _, title = head.partition("|")
                else:
                    company, title = head, ""
                company_id = _stable_id("exp", company.strip(), str(len(doc["experience"])))
                current_company = {
                    "company_id": company_id,
                    "company": company.strip()[:80],
                    "title": title.strip()[:80],
                    "dates": dates,
                    "bullets": [],
                }
                doc["experience"].append(current_company)
            else:
                for b in _split_bullets(text) or [re.sub(r"^\s*[•▪●\-–\*]\s+", "", text)]:
                    bid = _stable_id(current_company["company_id"], "b", str(len(current_company["bullets"])))
                    current_company["bullets"].append({"id": bid, "text": b})
            continue

        if current_section == "projects":
            is_bullet = bool(re.match(r"^\s*[•▪●\-–\*]\s+", text))
            if not is_bullet or current_project is None:
                pid = _stable_id("proj", text.strip(), str(len(doc["projects"])))
                current_project = {"project_id": pid, "name": text.strip()[:100], "bullets": []}
                doc["projects"].append(current_project)
            else:
                for b in _split_bullets(text) or [re.sub(r"^\s*[•▪●\-–\*]\s+", "", text)]:
                    bid = _stable_id(current_project["project_id"], "b", str(len(current_project["bullets"])))
                    current_project["bullets"].append({"id": bid, "text": b})
            continue

        if current_section == "education":
            eid = _stable_id("edu", text.strip(), str(len(doc["education"])))
            dates_m = _DATE_RANGE_RE.search(text)
            dates = f"{dates_m.group(1)} - {dates_m.group(2)}" if dates_m else ""
            doc["education"].append({"id": eid, "school": text.strip()[:120], "degree": "", "dates": dates})
            continue

        if current_section == "certifications":
            cid = _stable_id("cert", text.strip(), str(len(doc["certifications"])))
            doc["certifications"].append({"id": cid, "text": text.strip()[:200]})
            continue

        if current_section == "publications":
            # A citation is often visually one line in the PDF but wraps
            # across two physical lines in extraction (title, then venue —
            # e.g. "...LGBMR" / "Published in IEEE"). Only a bulleted line
            # (or the very first line of the section) starts a new entry;
            # anything else is a continuation of the previous one.
            is_new = bool(re.match(r"^\s*[•▪●\-–\*]\s*", text)) or not doc["publications"]
            cleaned = re.sub(r"^\s*[•▪●\-–\*]\s*", "", text).strip()
            if is_new:
                pid = _stable_id("pub", cleaned, str(len(doc["publications"])))
                doc["publications"].append({"id": pid, "text": cleaned[:300]})
            else:
                doc["publications"][-1]["text"] = (doc["publications"][-1]["text"] + " " + cleaned)[:300]
            continue

    return doc


# ── Plain-text fallback (no PDF spans available) ────────────────────────────

def _build_from_plain_text(full_text: str) -> dict:
    """Lower-fidelity fallback: segment full_text by header keywords only."""
    pseudo_lines = []
    for raw_line in (full_text or "").split("\n"):
        t = raw_line.strip()
        if not t:
            continue
        pseudo_lines.append({"text": t, "size": 10.0, "bold": False, "page": 0})
    return _build_from_lines(pseudo_lines)


# ── Public entrypoint ────────────────────────────────────────────────────────

def parse_resume_structured(pdf_bytes: Optional[bytes], full_text: str) -> dict:
    """
    Build the structured document model for a resume.

    Tries PyMuPDF span extraction first (best section/bullet fidelity via
    font-size heuristics), falls back to plain-text heading segmentation.
    Never raises — worst case returns a minimal doc with everything dumped
    into a single "experience" bucket so the editor still has something to
    render rather than a hard failure.
    """
    lines = _extract_blocks_pymupdf(pdf_bytes) if pdf_bytes else None
    try:
        if lines:
            doc = _build_from_lines(lines)
        else:
            doc = _build_from_plain_text(full_text)
    except Exception as e:
        logger.error(f"[resume_parser] structure build failed, using minimal fallback: {e}", exc_info=True)
        doc = {
            "header": {"name": "", "location": "", "email": "", "phone": "",
                       "linkedin": "", "github": "", "website": ""},
            "summary": None,
            "skills": [],
            "experience": [{
                "company_id": "exp_fallback",
                "company": "", "title": "", "dates": "",
                "bullets": [{"id": f"fallback_{i}", "text": t.strip()}
                            for i, t in enumerate((full_text or "").split("\n")) if t.strip()][:40],
            }],
            "projects": [], "education": [], "certifications": [], "publications": [],
        }

    # Guard: if extraction produced essentially nothing usable, signal it
    # so the caller (resume_optimizer) can refuse gracefully rather than
    # silently optimizing against an empty document.
    total_bullets = sum(len(e["bullets"]) for e in doc["experience"]) + \
                    sum(len(p["bullets"]) for p in doc["projects"])
    doc["_extraction_confidence"] = "low" if total_bullets == 0 else ("medium" if not lines else "high")
    return doc