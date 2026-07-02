"""
services/resume_renderer.py — Structured resume document → PDF

Uses fpdf2, NOT WeasyPrint. fpdf2 is pure Python — it draws the PDF
byte-by-byte itself, using its own built-in font metrics. No Pango, no
Cairo, no GDK-Pixbuf, nothing to apt-get install on Render. `pip install
fpdf2` is the entire dependency footprint. This trades away HTML/CSS-based
layout (WeasyPrint's approach) for direct imperative drawing calls — less
flexible, but there is no deployment risk category to manage: it either
imports or it doesn't, and if it imports, it renders, on any machine.

Bakes accepted patches + manual edits into the document first (same logic
as ResumeEditor.jsx's renderTarget/renderField and resume_optimizer.py's
apply_patch_to_text — mirrored here so the exported PDF exactly matches
what the user approved on screen), then draws it section by section.

Public entrypoint:
  render_resume_pdf(structured_doc, patches, decisions, manual_edits) -> bytes
"""

import logging
import unicodedata
from copy import deepcopy

from fpdf import FPDF

logger = logging.getLogger(__name__)

_PAGE_MARGIN = 18   # mm
_FONT        = "Helvetica"

# fpdf2's built-in core fonts (Helvetica, etc.) are Latin-1 only — no bundled
# Unicode TTF here (keeps the zero-system-dependency footprint fpdf2 was
# chosen for). Real resume text routinely contains smart quotes, em-dashes,
# and bullet characters (from PDF extraction or just how people write), so
# transliterate the common ones and drop anything else Latin-1 can't hold
# rather than crashing mid-render.
_CHAR_MAP = {
    "\u2022": "-", "\u25CF": "-", "\u25AA": "-",           # bullets
    "\u2013": "-", "\u2014": "-",                           # en/em dash
    "\u2018": "'", "\u2019": "'", "\u201C": '"', "\u201D": '"',  # smart quotes
    "\u2026": "...",                                        # ellipsis
}


def _sanitize(text: str) -> str:
    if not text:
        return ""
    for uni, ascii_eq in _CHAR_MAP.items():
        text = text.replace(uni, ascii_eq)
    # Belt-and-suspenders: anything still outside Latin-1 gets NFKD-normalized
    # (strips accents to closest ASCII) then any remaining stragglers dropped,
    # so a render can NEVER crash on unexpected input.
    try:
        text.encode("latin-1")
        return text
    except UnicodeEncodeError:
        normalized = unicodedata.normalize("NFKD", text)
        return normalized.encode("latin-1", "ignore").decode("latin-1")


# ── Patch application (mirrors resume_optimizer.apply_patch_to_text exactly) ──

def _apply_patch_to_text(text: str, patch: dict) -> str:
    if patch["operation"] == "replace_text":
        return text.replace(patch["before"], patch["after"], 1)
    position = patch.get("position", "end")
    if position.startswith("after:"):
        anchor = position.split("after:", 1)[1]
        idx = text.find(anchor)
        if idx == -1:
            return text + patch["text"]
        insert_at = idx + len(anchor)
        return text[:insert_at] + patch["text"] + text[insert_at:]
    return text + patch["text"]


def _final_text(target_id: str, original_text: str, patches_by_target: dict, decisions: dict, manual_edits: dict) -> str:
    if target_id in manual_edits:
        return manual_edits[target_id]
    text = original_text
    for p in patches_by_target.get(target_id, []):
        if decisions.get(p["id"]) != "rejected":
            text = _apply_patch_to_text(text, p)
    return text


# ── Bake edits into a plain (patch-free) document ───────────────────────────
# Identical to the WeasyPrint version's build_final_document — kept as its
# own function since the field-key scheme (header:name, exp:{id}:company,
# etc.) has to stay in lockstep with ResumeEditor.jsx regardless of which
# rendering backend draws the final page.

def build_final_document(structured_doc: dict, patches: list, decisions: dict, manual_edits: dict) -> dict:
    doc = deepcopy(structured_doc)
    patches_by_target: dict[str, list] = {}
    for p in patches:
        patches_by_target.setdefault(p["target_id"], []).append(p)

    def field(key, fallback):
        return manual_edits.get(key, fallback)

    h = doc.get("header", {}) or {}
    doc["header"] = {
        "name": field("header:name", h.get("name", "")),
        **{f: field(f"header:{f}", h.get(f, "")) for f in ["location", "email", "phone", "linkedin", "github", "website"]},
    }

    if doc.get("summary"):
        doc["summary"]["text"] = _final_text(
            doc["summary"]["id"], doc["summary"]["text"], patches_by_target, decisions, manual_edits
        )

    for g in doc.get("skills", []) or []:
        for item in g.get("items", []) or []:
            item["text"] = _final_text(item["id"], item["text"], patches_by_target, decisions, manual_edits)

    for exp in doc.get("experience", []) or []:
        cid = exp.get("company_id")
        exp["company"] = field(f"exp:{cid}:company", exp.get("company", ""))
        exp["title"]   = field(f"exp:{cid}:title", exp.get("title", ""))
        exp["dates"]   = field(f"exp:{cid}:dates", exp.get("dates", ""))
        for b in exp.get("bullets", []) or []:
            b["text"] = _final_text(b["id"], b["text"], patches_by_target, decisions, manual_edits)

    for proj in doc.get("projects", []) or []:
        pid = proj.get("project_id") or proj.get("id")
        proj["name"] = field(f"proj:{pid}:name", proj.get("name", proj.get("title", "")))
        for b in proj.get("bullets", []) or []:
            b["text"] = _final_text(b["id"], b["text"], patches_by_target, decisions, manual_edits)

    for e in doc.get("education", []) or []:
        e["school"] = field(f"edu:{e['id']}:school", e.get("school", ""))
        e["dates"]  = field(f"edu:{e['id']}:dates", e.get("dates", ""))

    return doc


# ── Drawing helpers ──────────────────────────────────────────────────────────

class _ResumePDF(FPDF):
    def section_title(self, title: str):
        self.set_font(_FONT, "B", 10)
        self.set_text_color(20, 20, 20)
        y = self.get_y() + 3
        self.set_xy(_PAGE_MARGIN, y)
        self.cell(0, 5.5, _sanitize(title.upper()), align="L")
        self.set_draw_color(20, 20, 20)
        self.set_line_width(0.3)
        line_y = y + 6
        self.line(_PAGE_MARGIN, line_y, self.w - _PAGE_MARGIN, line_y)
        self.set_xy(_PAGE_MARGIN, line_y + 2.5)

    def row(self, left: str, right: str = "", bold_left=True):
        """Left-bold / right-dim on the same line, like 'Company | Title' ... 'Dates'."""
        left, right = _sanitize(left), _sanitize(right)
        self.set_font(_FONT, "B" if bold_left else "", 10)
        self.set_text_color(20, 20, 20)
        avail = self.w - 2 * _PAGE_MARGIN
        right_w = self.get_string_width(right) + 2 if right else 0
        self.cell(avail - right_w, 5, left, align="L")
        if right:
            self.set_font(_FONT, "", 9)
            self.set_text_color(85, 83, 77)
            self.cell(right_w, 5, right, align="R")
        self.ln(5.5)

    def bullet(self, text: str):
        self.set_font(_FONT, "", 9.5)
        self.set_text_color(20, 20, 20)
        x0 = self.get_x()
        self.set_x(x0 + 4)
        self.multi_cell(self.w - 2 * _PAGE_MARGIN - 4, 4.6, f"- {_sanitize(text)}", align="L")

    def plain(self, text: str):
        self.set_font(_FONT, "", 9.5)
        self.set_text_color(20, 20, 20)
        self.multi_cell(self.w - 2 * _PAGE_MARGIN, 4.6, _sanitize(text), align="L")


def render_resume_pdf(structured_doc: dict, patches: list, decisions: dict, manual_edits: dict) -> bytes:
    """Bake edits into the document and draw it into a PDF, page by page (fpdf2 handles page breaks)."""
    final_doc = build_final_document(structured_doc, patches, decisions, manual_edits)
    h = final_doc.get("header", {}) or {}

    pdf = _ResumePDF(format="Letter", unit="mm")
    pdf.set_auto_page_break(auto=True, margin=_PAGE_MARGIN)
    pdf.set_margins(_PAGE_MARGIN, _PAGE_MARGIN, _PAGE_MARGIN)
    pdf.add_page()

    # Header
    pdf.set_font(_FONT, "B", 18)
    pdf.set_text_color(20, 20, 20)
    pdf.cell(0, 8, _sanitize(h.get("name", "")), align="C")
    pdf.ln(7)
    contact = "   |   ".join(v for v in [h.get(f) for f in ["location", "email", "phone", "linkedin", "github", "website"]] if v)
    pdf.set_font(_FONT, "", 9)
    pdf.set_text_color(85, 83, 77)
    pdf.multi_cell(0, 4.5, _sanitize(contact), align="C")
    pdf.ln(2)

    if final_doc.get("summary"):
        pdf.section_title("Summary")
        pdf.plain(final_doc["summary"]["text"])

    if final_doc.get("skills"):
        pdf.section_title("Skills")
        for g in final_doc["skills"]:
            items = ", ".join(i["text"] for i in g.get("items", []))
            pdf.set_font(_FONT, "B", 9.5)
            pdf.set_text_color(20, 20, 20)
            label = _sanitize(f"{g['group_label']}: ")
            label_w = pdf.get_string_width(label) + 1
            pdf.cell(label_w, 4.8, label)
            pdf.set_font(_FONT, "", 9.5)
            pdf.multi_cell(pdf.w - 2 * _PAGE_MARGIN - label_w, 4.8, _sanitize(items), align="L")

    if final_doc.get("experience"):
        pdf.section_title("Work Experience")
        for exp in final_doc["experience"]:
            title = f" | {exp['title']}" if exp.get("title") else ""
            pdf.row(f"{exp['company']}{title}", exp.get("dates", ""))
            for b in exp.get("bullets", []):
                pdf.bullet(b["text"])
            pdf.ln(1.5)

    if final_doc.get("projects"):
        pdf.section_title("Projects")
        for p in final_doc["projects"]:
            pdf.row(p.get("name", ""), p.get("dates", ""))
            for b in p.get("bullets", []):
                pdf.bullet(b["text"])
            pdf.ln(1.5)

    if final_doc.get("education"):
        pdf.section_title("Education")
        for e in final_doc["education"]:
            pdf.row(e.get("school", ""), e.get("dates", ""), bold_left=False)

    if final_doc.get("certifications"):
        pdf.section_title("Certifications")
        for c in final_doc["certifications"]:
            pdf.bullet(c["text"])

    return bytes(pdf.output())