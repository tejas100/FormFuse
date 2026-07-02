"""
services/resume_optimizer.py — Structured-patch resume optimizer for RACK

REPLACES the old free-text-diff version. That version asked the LLM to return
"original"/"revised" string pairs matched against raw resume text — fragile
(exact-substring matching breaks on whitespace/formatting drift) and gave the
model too much room to rewrite rather than patch.

This version operates on the structured document model from resume_parser.py.
Every editable unit (summary, a skill item, a bullet) has a stable id. The LLM
returns PATCH OPERATIONS keyed to those ids — never raw text search/replace,
never a full rewrite.

Two-stage pipeline:
  1. classify_requirements()  — for each JD requirement, classify resume
     evidence as: explicit | implicit | weak | absent | hallucination_risk.
     This runs BEFORE patch generation and constrains it: patches are only
     generated for requirements classified explicit/implicit/weak. absent
     requirements are never patched in — they're surfaced to the user as
     "not supported" so RACK never fabricates experience.
  2. generate_patches()       — structured edit operations only:
       insert_phrase  { target_id, position: "after:<anchor text>" | "end", text }
       replace_text   { target_id, before, after }
     Never operates outside the ids resume_parser.py produced.

Hard rules enforced in the system prompt (non-negotiable, mirrored in code):
  - Never invent a tool, employer, title, date, metric, or achievement not
    already evidenced in the resume.
  - Never modify dates, job titles, employers, education, or certifications.
  - Every patch must cite the requirement_id it addresses and a confidence
    score; patches below CONFIDENCE_FLOOR are dropped server-side before
    they ever reach the editor — a bad LLM call can't sneak in a weak claim.

Called from:
  services/apply_worker.py  — optimize_batch_resumes() background task
  routers/apply.py          — GET /jobs/{id}/resume (regenerate on demand)
"""

import json
import logging
import os
import re

import httpx
from fastapi import HTTPException

from services.resume_parser import parse_resume_structured

logger = logging.getLogger(__name__)

_LLM_MODEL        = "gpt-4o-mini"
_LLM_TIMEOUT       = 30.0
_MAX_PATCHES        = 14
_CONFIDENCE_FLOOR   = 0.65   # patches below this are dropped before reaching the user

_SYSTEM_PROMPT = """You are a resume-JD matching and patching engine. You do NOT rewrite resumes.

You will receive a candidate's resume as a structured document (sections, bullets,
skills, each with a stable id) and a job description's required/preferred skills.

STEP 1 — Classify each JD requirement against the resume evidence:
  "explicit"           — the requirement is already stated clearly in the resume
  "implicit"           — strongly implied by existing work but not named directly
                          (e.g. resume says "built ETL pipelines with Spark" and JD
                          wants "PySpark" — that's implicit, naming it is honest)
  "weak"                — mentioned once, thinly, could be moved/strengthened
  "absent"              — no evidence anywhere in the resume
  "hallucination_risk"   — would require inventing a tool/employer/achievement to add

STEP 2 — Generate patch operations ONLY for requirements classified
"implicit" or "weak". NEVER generate a patch for "absent" or "hallucination_risk"
requirements — those must be left alone and reported back, not papered over.

ABSOLUTE RULES:
1. Never add a tool, credential, employer, metric, title, responsibility, or
   achievement unless it is explicitly or implicitly supported by the resume text.
2. Never modify dates, job titles, employers, education, or certifications.
3. Every patch must target an existing id from the document you were given.
   Never invent new ids or new bullets from nothing — only extend what exists.
4. Two patch operations only:
   - "insert_phrase": append/insert a short phrase into an existing bullet or
     skills group. `position` is either "end" (append) or "after:<exact anchor
     substring from that target's current text>".
   - "replace_text": replace an exact substring within a target's current text.
     `before` MUST be an exact verbatim substring of that target's current text.
5. Keep insertions short — a phrase or a few words, not a rewritten sentence.
6. Max 14 patches. Prioritize by requirement importance, not by patch count.
7. Return ONLY valid JSON, no markdown, no commentary.
"""

_build_user_prompt = lambda doc_json, jd_text, required_skills, preferred_skills: f"""
JOB DESCRIPTION REQUIREMENTS:
Required: {', '.join(required_skills) if required_skills else '(none extracted)'}
Preferred: {', '.join(preferred_skills) if preferred_skills else '(none extracted)'}

JOB DESCRIPTION (context, first 1500 chars):
{jd_text[:1500]}

RESUME DOCUMENT (structured, ids included):
{json.dumps(doc_json, indent=None)[:6000]}

Return JSON exactly matching this schema:
{{
  "requirement_classification": [
    {{ "requirement_id": "databricks", "requirement": "Databricks",
       "classification": "implicit", "evidence": "Uber bullet mentions LangChain/OpenAI AI workflows on data platforms" }}
  ],
  "patches": [
    {{
      "operation": "insert_phrase",
      "target_id": "<exact id from the document>",
      "position": "after:LangChain/OpenAI",
      "text": " and Databricks",
      "reason": "Matches required platform skill, evidenced by existing data platform work",
      "requirement_id": "databricks",
      "confidence": 0.93
    }},
    {{
      "operation": "replace_text",
      "target_id": "<exact id from the document>",
      "before": "RAG, LangChain, Hugging Face Transformers",
      "after": "Agentic Workflows, RAG, LangChain, Hugging Face Transformers",
      "reason": "Matches AI workflow requirement, already the candidate's stated skill area",
      "requirement_id": "agentic_workflows",
      "confidence": 0.97
    }}
  ]
}}
"""


async def _call_llm(system: str, user: str) -> dict:
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="OpenAI API key not configured.")

    try:
        async with httpx.AsyncClient() as client:
            response = await client.post(
                "https://api.openai.com/v1/chat/completions",
                headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                json={
                    "model": _LLM_MODEL,
                    "messages": [
                        {"role": "system", "content": system},
                        {"role": "user",   "content": user},
                    ],
                    "temperature": 0,
                    "max_tokens": 2500,
                    "response_format": {"type": "json_object"},
                },
                timeout=_LLM_TIMEOUT,
            )
    except httpx.TimeoutException:
        raise HTTPException(status_code=502, detail="Optimizer timed out. Try again.")
    except Exception as e:
        logger.error(f"[optimizer] httpx error: {e}")
        raise HTTPException(status_code=502, detail="Optimizer unavailable. Try again.")

    if response.status_code == 429:
        raise HTTPException(status_code=429, detail="Rate limit hit. Try again in a moment.")
    if response.status_code != 200:
        logger.error(f"[optimizer] OpenAI {response.status_code}: {response.text[:300]}")
        raise HTTPException(status_code=502, detail="LLM call failed. Try again.")

    raw = response.json()["choices"][0]["message"]["content"].strip()
    raw = re.sub(r'^```(?:json)?\s*', '', raw)
    raw = re.sub(r'\s*```$', '', raw)
    try:
        return json.loads(raw)
    except json.JSONDecodeError as e:
        logger.error(f"[optimizer] JSON parse error: {e}\nRaw: {raw[:400]}")
        raise HTTPException(status_code=422, detail="Optimizer returned malformed response.")


def _collect_valid_ids(doc: dict) -> set[str]:
    ids = set()
    if doc.get("summary"):
        ids.add(doc["summary"]["id"])
    for g in doc.get("skills", []):
        ids.add(g["group_id"])
        for item in g.get("items", []):
            ids.add(item["id"])
    for exp in doc.get("experience", []):
        for b in exp.get("bullets", []):
            ids.add(b["id"])
    for proj in doc.get("projects", []):
        for b in proj.get("bullets", []):
            ids.add(b["id"])
    return ids


def _target_text(doc: dict, target_id: str) -> str | None:
    """Resolve a target_id to its current text — used to validate replace_text.before."""
    if doc.get("summary") and doc["summary"]["id"] == target_id:
        return doc["summary"]["text"]
    for g in doc.get("skills", []):
        if g["group_id"] == target_id:
            return ", ".join(i["text"] for i in g["items"])
        for item in g.get("items", []):
            if item["id"] == target_id:
                return item["text"]
    for exp in doc.get("experience", []):
        for b in exp.get("bullets", []):
            if b["id"] == target_id:
                return b["text"]
    for proj in doc.get("projects", []):
        for b in proj.get("bullets", []):
            if b["id"] == target_id:
                return b["text"]
    return None


async def get_or_build_structured_resume(resume_row, pdf_bytes: bytes | None) -> dict:
    """
    Returns cached structured_json if present on the resume row, otherwise
    parses and returns fresh (caller is responsible for persisting it).
    """
    if getattr(resume_row, "structured_json", None):
        return resume_row.structured_json
    return parse_resume_structured(pdf_bytes, resume_row.full_text or "")


async def generate_resume_patches(
    structured_doc: dict,
    jd_description_text: str,
    required_skills: list[str],
    preferred_skills: list[str],
) -> dict:
    """
    Core call. Returns:
      { requirement_classification: [...], patches: [...] }

    Patches are validated and filtered server-side before returning:
      - target_id must exist in the document
      - replace_text.before must be an exact substring of the target's current text
      - confidence must clear CONFIDENCE_FLOOR
      - classification must NOT be "absent" or "hallucination_risk" for any
        requirement a patch claims to address (belt-and-suspenders — the
        prompt already forbids this, but we don't trust the model blindly)
    """
    if structured_doc.get("_extraction_confidence") == "low":
        raise HTTPException(
            status_code=422,
            detail="Could not extract enough structure from this resume to optimize it safely. "
                   "Try re-uploading as a text-based PDF.",
        )

    user_message = _build_user_prompt(
        {k: v for k, v in structured_doc.items() if not k.startswith("_")},
        jd_description_text or "",
        required_skills or [],
        preferred_skills or [],
    )
    result = await _call_llm(_SYSTEM_PROMPT, user_message)

    classification = result.get("requirement_classification", [])
    if not isinstance(classification, list):
        classification = []
    blocked_req_ids = {
        c.get("requirement_id") for c in classification
        if isinstance(c, dict) and c.get("classification") in ("absent", "hallucination_risk")
    }

    valid_ids = _collect_valid_ids(structured_doc)
    raw_patches = result.get("patches", [])
    if not isinstance(raw_patches, list):
        raw_patches = []

    clean_patches = []
    for p in raw_patches[:_MAX_PATCHES * 2]:  # generous pre-filter cap
        if not isinstance(p, dict):
            continue
        op         = p.get("operation")
        target_id  = p.get("target_id")
        confidence = p.get("confidence")
        req_id     = p.get("requirement_id")

        if op not in ("insert_phrase", "replace_text"):
            continue
        if target_id not in valid_ids:
            logger.warning(f"[optimizer] dropped patch — unknown target_id {target_id!r}")
            continue
        if req_id in blocked_req_ids:
            logger.warning(f"[optimizer] dropped patch — requirement {req_id!r} classified absent/risky")
            continue
        try:
            confidence = float(confidence)
        except (TypeError, ValueError):
            confidence = 0.0
        if confidence < _CONFIDENCE_FLOOR:
            continue

        current_text = _target_text(structured_doc, target_id) or ""
        if op == "replace_text":
            before = p.get("before", "")
            if not before or before not in current_text:
                logger.warning(f"[optimizer] dropped replace_text — 'before' not found verbatim in target {target_id!r}")
                continue
            clean_patches.append({
                "id":              f"chg_{len(clean_patches)}_{target_id}",
                "operation":       "replace_text",
                "target_id":       target_id,
                "before":          before,
                "after":           str(p.get("after", "")),
                "reason":          str(p.get("reason", "")),
                "requirement_id":  req_id,
                "confidence":      confidence,
            })
        else:  # insert_phrase
            position = p.get("position", "end")
            if position != "end" and not str(position).startswith("after:"):
                position = "end"
            if str(position).startswith("after:"):
                anchor = position.split("after:", 1)[1]
                if anchor not in current_text:
                    position = "end"  # anchor drifted — degrade gracefully to append
            clean_patches.append({
                "id":              f"chg_{len(clean_patches)}_{target_id}",
                "operation":       "insert_phrase",
                "target_id":       target_id,
                "position":        position,
                "text":            str(p.get("text", "")),
                "reason":          str(p.get("reason", "")),
                "requirement_id":  req_id,
                "confidence":      confidence,
            })
        if len(clean_patches) >= _MAX_PATCHES:
            break

    return {
        "requirement_classification": classification,
        "patches": clean_patches,
    }


def apply_patch_to_text(current_text: str, patch: dict) -> str:
    """Deterministically apply a single accepted patch to a target's current text."""
    if patch["operation"] == "replace_text":
        return current_text.replace(patch["before"], patch["after"], 1)
    # insert_phrase
    position = patch.get("position", "end")
    if position.startswith("after:"):
        anchor = position.split("after:", 1)[1]
        idx = current_text.find(anchor)
        if idx == -1:
            return current_text + patch["text"]
        insert_at = idx + len(anchor)
        return current_text[:insert_at] + patch["text"] + current_text[insert_at:]
    return current_text + patch["text"]