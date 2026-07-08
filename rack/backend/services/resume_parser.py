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
  "projects":  [ { "project_id": str, "name": str, "url": str,
                    "bullets": [ { "id": str, "text": str } ] } ],
  "education": [ { "id": str, "school": str, "degree": str, "dates": str } ],
  "certifications": [ { "id": str, "text": str } ],
  "publications": [ { "id": str, "text": str, "url": str } ]
}

`url` fields (header.github, header.website, projects[].url, publications[].url)
come from the PDF's real hyperlink annotations, not text matching — a resume
commonly shows a shortened anchor label ("github/user", "portfolio", a paper
title) whose visible text is not itself a URL, so no regex over the text
stream can ever recover the destination. Empty string if the PDF has no
matching annotation there.

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
_DEGREE_RE = re.compile(
    r"\b(bachelor|master|b\.?s\.?|m\.?s\.?|ph\.?d\.?|associate|mba|b\.?a\.?|m\.?a\.?)\b",
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

def _extract_link_annotations(doc) -> list[dict]:
    """
    Every clickable URI annotation in the PDF: [{"uri", "rect", "page"}].
    This is the ONLY way to recover a hyperlink's real destination when the
    visible anchor text is a shortened label ("portfolio", "github/user", a
    paper title) rather than the URL itself — the destination isn't in the
    text stream at all in that case, so no amount of regex tuning over
    extracted text can find it. PyMuPDF exposes it separately, per-page,
    keyed by the on-page rectangle the link is clickable within.
    """
    out = []
    for page_idx, page in enumerate(doc):
        try:
            for link in page.get_links():
                uri, rect = link.get("uri"), link.get("from")
                if uri and rect:
                    out.append({"uri": uri, "rect": tuple(rect), "page": page_idx})
        except Exception:
            continue
    return out


def _overlap_ratio(line_bbox: tuple, link_rect: tuple) -> float:
    """Fraction of the link's OWN area that falls inside line_bbox. Using the
    link's own area (not the line's) as the denominator matters when a line
    is much wider than the link inside it (e.g. a project title line where
    the link only covers one word) — a small link fully inside a big line
    should still score ~1.0, not get diluted by the line's extra width."""
    lx0, ly0, lx1, ly1 = line_bbox
    rx0, ry0, rx1, ry1 = link_rect
    ix0, iy0 = max(lx0, rx0), max(ly0, ry0)
    ix1, iy1 = min(lx1, rx1), min(ly1, ry1)
    if ix1 <= ix0 or iy1 <= iy0:
        return 0.0
    inter_area = (ix1 - ix0) * (iy1 - iy0)
    link_area = max((rx1 - rx0) * (ry1 - ry0), 1e-6)
    return inter_area / link_area


_MIN_LINK_OVERLAP = 0.5  # a link counts as "on this line" only if most of its own box is inside it


def _union_bbox(boxes: list[tuple]) -> tuple:
    return (min(b[0] for b in boxes), min(b[1] for b in boxes),
            max(b[2] for b in boxes), max(b[3] for b in boxes))


def _extract_blocks_pymupdf(pdf_bytes: bytes) -> Optional[list[dict]]:
    """
    Returns a flat list of {"text": str, "size": float, "bold": bool,
    "page": int, "link_uris": list[str]} in reading order, or None if
    PyMuPDF isn't available / extraction is too thin.
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

    link_annotations = _extract_link_annotations(doc)

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
                boxes = [s["bbox"] for s in spans if s.get("bbox")]
                link_uris = []
                if boxes:
                    line_bbox = _union_bbox(boxes)
                    link_uris = [a["uri"] for a in link_annotations
                                 if a["page"] == page_idx
                                 and _overlap_ratio(line_bbox, a["rect"]) >= _MIN_LINK_OVERLAP]
                lines.append({"text": text, "size": size, "bold": bold, "page": page_idx,
                              "link_uris": link_uris})

    doc.close()
    if len(lines) < 8:
        # Too thin — likely a scanned/image-only PDF, not worth trusting
        return None
    return lines


def _split_bullets(block_text: str) -> list[str]:
    """A bullet 'block' from the regex fallback may contain multiple bullets glued together."""
    parts = re.split(r"(?:^|\n)\s*[•▪●\-–\*]\s+", block_text)
    return [p.strip() for p in parts if p.strip()]


def _split_skill_items(text: str) -> list[str]:
    """
    Split a skills line on commas/semicolons — but never inside parentheses
    or brackets, so "Azure (AI Foundry, AI Search, OneLake)" stays one item
    instead of shattering into three. A naive re.split(",") has no concept
    of bracket depth; this walks the string tracking it directly.
    """
    items: list[str] = []
    buf: list[str] = []
    depth = 0
    for ch in text:
        if ch in "([":
            depth += 1
            buf.append(ch)
        elif ch in ")]":
            depth = max(0, depth - 1)
            buf.append(ch)
        elif ch in ",;" and depth == 0:
            items.append("".join(buf).strip())
            buf = []
        else:
            buf.append(ch)
    if buf:
        items.append("".join(buf).strip())
    # A trailing Oxford "and"/"or" survives the comma split as its own
    # fragment's prefix ("..., and Function Calling") — strip it, it's list
    # grammar, not part of the skill name.
    cleaned = [re.sub(r"^(?:and|or)\s+", "", i, flags=re.I).strip() for i in items]
    return [i for i in cleaned if i]


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
    header_line_dicts = []
    for i, ln in enumerate(lines[:12]):
        if _classify_header_section(ln["text"]):
            body_start = i
            break
        header_lines.append(ln["text"])
        header_line_dicts.append(ln)
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

    # Enrich/override from real hyperlink annotations. A header often shows
    # a shortened anchor label ("github/user" with no ".com", or just the
    # bare word "portfolio") — the regexes above can miss or under-resolve
    # those, but the PDF's actual link target is unambiguous when present,
    # so it wins over a text-regex guess (or fills in what the regex found
    # nothing for, for linkedin/email which the regex already handles well).
    header_uris = [u for hl in header_line_dicts for u in hl.get("link_uris", [])]
    for uri in header_uris:
        ul = uri.lower()
        if ul.startswith("mailto:"):
            continue
        elif "linkedin.com" in ul:
            doc["header"]["linkedin"] = doc["header"]["linkedin"] or uri
        elif "github.com" in ul:
            doc["header"]["github"] = uri
        elif not doc["header"]["website"]:
            doc["header"]["website"] = uri

    # Walk remaining lines, tracking current section
    current_section = None
    current_company = None      # dict ref into doc["experience"]
    current_project = None      # dict ref into doc["projects"]
    current_skills_group = None # dict ref into doc["skills"]
    current_skills_raw = ""     # un-split accumulated text for that group
    current_edu = None          # dict ref into doc["education"]
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
            current_skills_group = None
            current_skills_raw = ""
            current_edu = None
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
                group_id = _stable_id("skills", group_label)
                current_skills_group = {"group_id": group_id, "group_label": group_label, "items": []}
                current_skills_raw = m.group(2)
                doc["skills"].append(current_skills_group)
            elif current_skills_group is not None:
                # No "Label:" prefix, but a group is already open — the PDF
                # wrapped this group's item list onto a second visual line.
                # It can even split mid-term ("Agentic" / "RAG" → "Agentic
                # RAG"), which is exactly why this joins the RAW text and
                # re-splits the whole thing below, rather than appending a
                # separately-split item list.
                current_skills_raw += " " + text
            else:
                skills_group_counter += 1
                group_label = f"Skills {skills_group_counter}"
                group_id = _stable_id("skills", group_label)
                current_skills_group = {"group_id": group_id, "group_label": group_label, "items": []}
                current_skills_raw = text
                doc["skills"].append(current_skills_group)

            current_skills_group["items"] = [
                {"id": _stable_id(current_skills_group["group_id"], item, str(idx)), "text": item}
                for idx, item in enumerate(_split_skill_items(current_skills_raw))
            ]
            continue

        if current_section == "experience":
            has_marker = bool(re.match(r"^\s*[•▪●\-–\*]\s+", text))
            date_m = _DATE_RANGE_RE.search(text)
            is_date_only = bool(date_m) and not _DATE_RANGE_RE.sub("", text).strip(" |,-–")

            if has_marker:
                # An explicit new bullet.
                if current_company is None:
                    company_id = _stable_id("exp", "unlabeled", str(len(doc["experience"])))
                    current_company = {"company_id": company_id, "company": "", "title": "",
                                        "dates": "", "bullets": []}
                    doc["experience"].append(current_company)
                for b in _split_bullets(text) or [re.sub(r"^\s*[•▪●\-–\*]\s+", "", text)]:
                    bid = _stable_id(current_company["company_id"], "b", str(len(current_company["bullets"])))
                    current_company["bullets"].append({"id": bid, "text": b})

            elif is_date_only and current_company is not None \
                    and not current_company["bullets"] and not current_company["dates"]:
                # A standalone "MM/YYYY – Present" line right after a company/
                # title header with nothing else yet — PDF rendered the dates
                # as their own line (common when they're right-aligned).
                # This completes that same entry; it isn't a new job.
                current_company["dates"] = f"{date_m.group(1)} - {date_m.group(2)}"

            elif current_company is not None and not ln["bold"] and not date_m:
                # No marker, not a header — this is a PDF line-wrap. If a
                # bullet is already open, it's that bullet's second visual
                # line; otherwise it's the first (unmarked) bullet content.
                if current_company["bullets"]:
                    current_company["bullets"][-1]["text"] += " " + text
                else:
                    bid = _stable_id(current_company["company_id"], "b", "0")
                    current_company["bullets"].append({"id": bid, "text": text})

            else:
                # A genuine new company/title header.
                dates = f"{date_m.group(1)} - {date_m.group(2)}" if date_m else ""
                head = _DATE_RANGE_RE.sub("", text).strip(" |,-–")
                sep_m = re.search(r"\s[-–—]\s", head)
                if "|" in head:
                    company, _, title = head.partition("|")
                elif sep_m:
                    company, title = head[:sep_m.start()], head[sep_m.end():]
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
            continue

        if current_section == "projects":
            has_marker = bool(re.match(r"^\s*[•▪●\-–\*]\s+", text))
            line_uri = next((u for u in ln.get("link_uris", []) if not u.lower().startswith("mailto:")), None)

            if has_marker:
                if current_project is None:
                    pid = _stable_id("proj", "unlabeled", str(len(doc["projects"])))
                    current_project = {"project_id": pid, "name": "", "url": "", "bullets": []}
                    doc["projects"].append(current_project)
                for b in _split_bullets(text) or [re.sub(r"^\s*[•▪●\-–\*]\s+", "", text)]:
                    bid = _stable_id(current_project["project_id"], "b", str(len(current_project["bullets"])))
                    current_project["bullets"].append({"id": bid, "text": b})

            elif current_project is not None and not ln["bold"] and current_project["bullets"]:
                # No marker, not a header — the last bullet's PDF line wrapped.
                current_project["bullets"][-1]["text"] += " " + text

            elif current_project is not None and not ln["bold"] and not current_project["bullets"]:
                # No marker, no bullets yet — this continues the project's own
                # name/subtitle (e.g. a location line right under the title),
                # not a brand new project.
                current_project["name"] = (current_project["name"] + " · " + text).strip(" ·")

            else:
                # A genuine new project header (bold, or nothing open yet).
                pid = _stable_id("proj", text.strip(), str(len(doc["projects"])))
                current_project = {"project_id": pid, "name": text.strip()[:100], "url": "", "bullets": []}
                doc["projects"].append(current_project)

            if line_uri and current_project is not None and not current_project["url"]:
                current_project["url"] = line_uri
            continue

        if current_section == "education":
            dates_m = _DATE_RANGE_RE.search(text)
            if ln["bold"] or current_edu is None:
                # A new institution entry — bold lines are how this resume
                # (and most others) render the school name.
                eid = _stable_id("edu", text.strip(), str(len(doc["education"])))
                current_edu = {"id": eid, "school": text.strip()[:120], "degree": "", "dates": ""}
                doc["education"].append(current_edu)
                if dates_m:
                    current_edu["dates"] = f"{dates_m.group(1)} - {dates_m.group(2)}"
            elif dates_m:
                current_edu["dates"] = f"{dates_m.group(1)} - {dates_m.group(2)}"
            elif _DEGREE_RE.search(text) and not current_edu["degree"]:
                current_edu["degree"] = text.strip()[:120]
            else:
                # Location or other detail line under the same institution.
                current_edu["school"] = (current_edu["school"] + " — " + text.strip())[:160]
            continue

        if current_section == "certifications":
            # Same wrap-continuation pattern already used for publications below —
            # a bulleted line (or the section's first line) starts a new
            # certification; anything else continues the previous one.
            is_new = bool(re.match(r"^\s*[•▪●\-–\*]\s*", text)) or not doc["certifications"]
            cleaned = re.sub(r"^\s*[•▪●\-–\*]\s*", "", text).strip()
            if is_new:
                cid = _stable_id("cert", cleaned, str(len(doc["certifications"])))
                doc["certifications"].append({"id": cid, "text": cleaned[:200]})
            else:
                doc["certifications"][-1]["text"] = (doc["certifications"][-1]["text"] + " " + cleaned)[:200]
            continue

        if current_section == "publications":
            # A citation is often visually one line in the PDF but wraps
            # across two physical lines in extraction (title, then venue —
            # e.g. "...LGBMR" / "Published in IEEE"). Only a bulleted line
            # (or the very first line of the section) starts a new entry;
            # anything else is a continuation of the previous one.
            is_new = bool(re.match(r"^\s*[•▪●\-–\*]\s*", text)) or not doc["publications"]
            cleaned = re.sub(r"^\s*[•▪●\-–\*]\s*", "", text).strip()
            line_uri = next((u for u in ln.get("link_uris", []) if not u.lower().startswith("mailto:")), None)
            if is_new:
                pid = _stable_id("pub", cleaned, str(len(doc["publications"])))
                doc["publications"].append({"id": pid, "text": cleaned[:300], "url": ""})
            else:
                doc["publications"][-1]["text"] = (doc["publications"][-1]["text"] + " " + cleaned)[:300]
            if line_uri and doc["publications"] and not doc["publications"][-1]["url"]:
                doc["publications"][-1]["url"] = line_uri
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