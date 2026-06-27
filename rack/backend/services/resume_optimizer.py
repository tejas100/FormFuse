"""
services/resume_optimizer.py — Surgical resume optimizer for RACK

Given a resume's full_text and a job's description_text, GPT-4o-mini
produces a list of targeted edits: which keywords to add and exactly
where/how to weave them into existing bullet points without rewriting.

The output is a structured diff — NOT a full rewrite. Each edit specifies:
  - section: which section the edit targets (e.g. "experience", "skills")
  - original: the exact phrase/sentence to find in the resume (or None for additions)
  - revised: the rewritten version with keywords naturally inserted
  - keywords_added: which JD keywords this edit injects
  - reason: one-line rationale for why this edit helps

This module is called from routers/resumes.py:
  POST /api/resumes/{resume_id}/optimize
  Body: { job_id: str }

Returns:
  {
    edits: [{ section, original, revised, keywords_added, reason }],
    summary: str,          # "Added 4 keywords across 5 bullet points"
    keyword_gaps: [str],   # Missing JD keywords not yet in resume
    keywords_already_present: [str],  # JD keywords already in the resume
  }

Design constraints:
  - Raw httpx only — openai SDK is NEVER installed
  - temperature=0, json_schema strict=true → deterministic output
  - Max 12 edits per call — surgical precision, not a rewrite
  - Never invents experience — only reframes what already exists
  - Graceful error handling — raises HTTPException with meaningful message
"""

import json
import logging
import os
import re

import httpx
from fastapi import HTTPException

logger = logging.getLogger(__name__)

_LLM_MODEL   = "gpt-4o-mini"
_LLM_TIMEOUT = 30.0
_MAX_EDITS   = 12

# ── Prompt ──────────────────────────────────────────────────────────────────────

_SYSTEM_PROMPT = """You are a professional resume editor specializing in ATS optimization.

Your job: given a resume and a job description, produce SURGICAL edits that insert
missing keywords into existing bullet points without rewriting the resume from scratch.

RULES — strictly follow these:
1. NEVER invent experience, titles, companies, metrics, or projects. Only edit what exists.
2. Only add keywords that CAN be naturally inferred from what the candidate already did.
   e.g. if they "built a data pipeline" you can add "ETL pipeline" or "data engineering"
   — you CANNOT add "Spark" if Spark was never mentioned.
3. Keep the same grammatical structure as the original bullet. Add keywords via:
   - Appending to a bullet: "...using REST APIs" → "...using REST APIs and GraphQL"
   - Inserting naturally mid-sentence: "Built a pipeline" → "Built an ETL pipeline"
   - Adding a parenthetical: "...with Python" → "...with Python (FastAPI, async)"
4. Prefer edits in the Experience section over Summary/Skills, as Experience
   carries more ATS weight.
5. If a keyword is already present in the resume, do NOT include it in keyword_gaps.
6. If an edit would make a bullet dishonest, skip it.
7. Aim for 4–8 edits max. Quality over quantity.
8. For the Skills section, additions are fine (adding a keyword to an existing skills list).

Return ONLY valid JSON. No markdown, no backticks, no explanation outside the JSON.
"""

_build_user_prompt = lambda resume_text, jd_text, missing_skills: f"""
JOB DESCRIPTION (first 2000 chars):
{jd_text[:2000]}

MISSING KEYWORDS (not found in resume, high priority to add if honest):
{', '.join(missing_skills[:20]) if missing_skills else 'none provided — infer from JD'}

RESUME FULL TEXT:
{resume_text[:5000]}

Produce surgical edits. Return JSON exactly matching this schema:
{{
  "edits": [
    {{
      "section": "experience",
      "original": "Built and deployed microservices using Python",
      "revised": "Built and deployed microservices using Python and FastAPI",
      "keywords_added": ["FastAPI"],
      "reason": "FastAPI is listed as required; candidate used Python microservices which implies FastAPI is compatible"
    }}
  ],
  "summary": "Added 3 keywords across 4 bullet points",
  "keyword_gaps": ["Kubernetes", "Terraform"],
  "keywords_already_present": ["Python", "REST APIs", "Docker"]
}}

Rules reminder:
- "original" must be an exact verbatim substring of the resume text (or null for pure additions to skills lists)
- "revised" replaces "original" in the final document
- Never set "original" to a full paragraph — target the specific sentence/bullet only
- keyword_gaps = keywords from JD that you COULD NOT honestly add anywhere
- keywords_already_present = keywords from JD already in the resume
"""


# ── Core call ────────────────────────────────────────────────────────────────────

async def generate_resume_edits(
    resume_full_text: str,
    jd_description_text: str,
    missing_skills: list[str],
) -> dict:
    """
    Call GPT-4o-mini to produce surgical resume edits.

    Args:
        resume_full_text: cleaned full resume text (from Resume.full_text)
        jd_description_text: raw JD description (from job_pool.description_text)
        missing_skills: list of JD keywords already identified as missing

    Returns:
        dict with keys: edits, summary, keyword_gaps, keywords_already_present

    Raises:
        HTTPException(502) if the LLM call fails
        HTTPException(422) if the response can't be parsed
    """
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="OpenAI API key not configured.")

    if not resume_full_text or not resume_full_text.strip():
        raise HTTPException(
            status_code=422,
            detail="Resume has no text content. Re-upload your resume to enable optimization.",
        )

    user_message = _build_user_prompt(
        resume_full_text.strip(),
        jd_description_text.strip() if jd_description_text else "",
        missing_skills or [],
    )

    try:
        async with httpx.AsyncClient() as client:
            response = await client.post(
                "https://api.openai.com/v1/chat/completions",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": _LLM_MODEL,
                    "messages": [
                        {"role": "system", "content": _SYSTEM_PROMPT},
                        {"role": "user",   "content": user_message},
                    ],
                    "temperature": 0,
                    "max_tokens": 2000,
                    "response_format": {"type": "json_object"},
                },
                timeout=_LLM_TIMEOUT,
            )
    except httpx.TimeoutException:
        logger.error("[optimizer] LLM call timed out")
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

    # Strip accidental markdown fences (belt-and-suspenders for json_object mode)
    raw = re.sub(r'^```(?:json)?\s*', '', raw)
    raw = re.sub(r'\s*```$', '', raw)

    try:
        result = json.loads(raw)
    except json.JSONDecodeError as e:
        logger.error(f"[optimizer] JSON parse error: {e}\nRaw: {raw[:400]}")
        raise HTTPException(status_code=422, detail="Optimizer returned malformed response.")

    # ── Validate and sanitise ────────────────────────────────────────────────────
    edits = result.get("edits", [])
    if not isinstance(edits, list):
        edits = []

    # Cap edits and ensure required keys exist on each
    clean_edits = []
    for edit in edits[:_MAX_EDITS]:
        if not isinstance(edit, dict):
            continue
        clean_edits.append({
            "section":          str(edit.get("section", "experience")),
            "original":         edit.get("original"),   # May be None for skills-list additions
            "revised":          str(edit.get("revised", "")),
            "keywords_added":   [str(k) for k in (edit.get("keywords_added") or [])],
            "reason":           str(edit.get("reason", "")),
        })

    return {
        "edits":                    clean_edits,
        "summary":                  str(result.get("summary", f"{len(clean_edits)} edits generated")),
        "keyword_gaps":             [str(k) for k in (result.get("keyword_gaps") or [])],
        "keywords_already_present": [str(k) for k in (result.get("keywords_already_present") or [])],
    }