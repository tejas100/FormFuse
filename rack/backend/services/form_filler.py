"""
services/form_filler.py — LLM-powered form field detection and answer writer

Two responsibilities:
  1. detect_fields()    — given a DOM snapshot, identify every fillable field
                          and what value from the user profile to fill in
  2. write_free_text()  — given an open-ended question, write a compelling answer
                          from the user's resume + profile

Uses gpt-4o-mini via raw httpx (no openai SDK — never install it).
"""

import json
import logging
import os
import re

import httpx

logger = logging.getLogger(__name__)

LLM_MODEL   = "gpt-4o-mini"
LLM_TIMEOUT = 30.0

# ── System prompts ─────────────────────────────────────────────────────────────

_FIELD_DETECT_SYSTEM = """You are an expert at reading job application form HTML and determining what to fill in for a candidate.

Given a cleaned HTML snippet of a job application form and the candidate's profile, return a JSON array of field fill instructions.

OUTPUT: Return ONLY a valid JSON array. No explanation, no markdown, no preamble.

Schema per item:
{
  "field_label": "Human-readable label (e.g. 'First Name', 'LinkedIn URL')",
  "selector_hint": "The EXACT id or name attribute value from the HTML element. Look at the HTML and copy the actual id= or name= value verbatim (e.g. 'first_name', 'email', 'phone', 'job_application[answers_attributes][0][text_value]'). Do NOT use the human-readable label text as the selector.",
  "field_type": "text | email | phone | textarea | select | checkbox | file | url",
  "value": "Exact value to fill in",
  "skip": false
}

RULES:
1. Cover ALL visible input fields, textareas, and select elements.
2. For file upload fields (resume/CV): set skip=true — we handle those separately.
3. For select fields: value must be one of the visible option texts, pick the best match.
4. For checkboxes (e.g. "I agree to terms"): value="check".
5. For fields you cannot determine a value for: set skip=true.
6. Do NOT fabricate information not present in the profile.
7. For "How did you hear about us?" type fields: value="LinkedIn" unless profile says otherwise.
8. For salary fields: skip=true (leave for human).
9. For "Require sponsorship?" or work authorization: answer based on profile.
10. Keep values concise and factual."""

_FREE_TEXT_SYSTEM = """You are an expert job application writer helping a candidate auto-apply to jobs.

Given the candidate's resume, their profile, and a specific application question, write a compelling answer.

CRITICAL STYLE RULES — read carefully:
- Write like a real person typing a thoughtful paragraph, NOT like a cover letter template.
- Use plain sentences. Never use bullet points, hyphens as list markers, or numbered lists.
- Never use hollow filler phrases: "passionate about", "excited to", "eager to", "strong background in",
  "proven track record", "team player", "results-driven", "I believe in your mission".
- Be specific — pull real project names, technologies, or outcomes from the resume.
- Be concise — 2-4 sentences is ideal. Do not pad with generalities.
- Write in first person ("I built...", "At my last role I...").
- Match the register of the question: casual question → casual answer, formal → formal.
- For "Why do you want to work here?" — connect ONE specific thing about the company
  (product, technical approach, domain) to ONE concrete thing from the candidate's background.
- For "Tell me about a time..." — one quick STAR paragraph, no headers, no sub-bullets.
- For generic "Tell us about yourself" — 2-3 sentences: current focus, best relevant skill, why this role.
- Do NOT fabricate companies, titles, metrics, or projects not in the resume.
- Output ONLY the answer text. No preamble, no explanation, no quotes around the answer."""


# ── Helper: strip HTML to a clean form-focused excerpt ────────────────────────

def _extract_form_html(raw_html: str) -> str:
    """
    Strip scripts, styles, nav, footer — keep only form-relevant HTML.
    Limits to 6000 chars so we don't blow the token budget.
    """
    # Remove script and style blocks entirely
    html = re.sub(r'<script[^>]*>.*?</script>', '', raw_html, flags=re.DOTALL | re.IGNORECASE)
    html = re.sub(r'<style[^>]*>.*?</style>',  '', html,     flags=re.DOTALL | re.IGNORECASE)
    html = re.sub(r'<nav[^>]*>.*?</nav>',       '', html,     flags=re.DOTALL | re.IGNORECASE)
    html = re.sub(r'<footer[^>]*>.*?</footer>', '', html,     flags=re.DOTALL | re.IGNORECASE)
    html = re.sub(r'<header[^>]*>.*?</header>', '', html,     flags=re.DOTALL | re.IGNORECASE)

    # Collapse whitespace
    html = re.sub(r'\s+', ' ', html).strip()

    # Take a generous excerpt — enough to capture all form fields
    return html[:6000]


def _build_profile_block(profile: dict) -> str:
    """
    Flatten the user profile dict into a readable text block for the LLM.
    profile keys: name, email, phone, location, linkedin, github, website,
                  years_exp, titles, skills, resume_text (truncated)
    """
    lines = []
    if profile.get("name"):        lines.append(f"Full Name: {profile['name']}")
    if profile.get("email"):       lines.append(f"Email: {profile['email']}")
    if profile.get("phone"):       lines.append(f"Phone: {profile.get('phone', 'not provided')}")
    if profile.get("location"):    lines.append(f"Location: {profile['location']}")
    if profile.get("linkedin"):    lines.append(f"LinkedIn: {profile['linkedin']}")
    if profile.get("github"):      lines.append(f"GitHub: {profile['github']}")
    if profile.get("website"):     lines.append(f"Website: {profile['website']}")
    if profile.get("years_exp"):   lines.append(f"Years of Experience: {profile['years_exp']}")
    if profile.get("titles"):      lines.append(f"Job Titles: {', '.join(profile['titles'][:5])}")
    if profile.get("skills"):      lines.append(f"Skills: {', '.join(profile['skills'][:20])}")
    if profile.get("work_auth"):            lines.append(f"Work Authorization: {profile['work_auth']}")
    if profile.get("requires_sponsorship"): lines.append(f"Requires Sponsorship: {profile['requires_sponsorship']}")
    # EEO voluntary self-ID
    eeo_gender   = profile.get("gender_eeo")       or "decline"
    eeo_veteran  = profile.get("veteran_status")   or "decline"
    eeo_disab    = profile.get("disability_status") or "decline"
    # Map internal values to form-friendly display strings
    _gender_map  = {"male": "Male", "female": "Female", "non_binary": "Non-binary / Non-conforming", "decline": "Decline to self-identify"}
    _veteran_map = {"protected_veteran": "I am a protected veteran", "not_a_veteran": "I am not a protected veteran", "decline": "I don't wish to answer"}
    _disab_map   = {"yes": "Yes, I have a disability", "no": "No, I do not have a disability", "decline": "I don't wish to answer"}
    _decline_eeo = "Decline to self-identify"
    _decline_vet = "I don't wish to answer"
    lines.append(f"Gender (EEO): {_gender_map.get(eeo_gender, _decline_eeo)}")
    lines.append(f"Veteran Status (EEO): {_veteran_map.get(eeo_veteran, _decline_vet)}")
    lines.append(f"Disability Status (EEO): {_disab_map.get(eeo_disab, _decline_vet)}")
    return "\n".join(lines)


# ── Main API ───────────────────────────────────────────────────────────────────

async def detect_fields(raw_html: str, profile: dict) -> list[dict]:
    """
    Given raw page HTML and user profile, return list of field fill instructions.
    Each item: { field_label, selector_hint, field_type, value, skip }
    """
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        logger.error("[form_filler] OPENAI_API_KEY not set")
        return []

    form_html    = _extract_form_html(raw_html)
    profile_text = _build_profile_block(profile)

    user_msg = f"""CANDIDATE PROFILE:
{profile_text}

ATS CONTEXT: {profile.get('_ats_hint', 'Return the actual HTML id or name attribute as selector_hint.')}

FORM HTML:
{form_html}

Return the JSON array of fill instructions now."""

    try:
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                "https://api.openai.com/v1/chat/completions",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model":       LLM_MODEL,
                    "messages":    [
                        {"role": "system", "content": _FIELD_DETECT_SYSTEM},
                        {"role": "user",   "content": user_msg},
                    ],
                    "temperature": 0.0,
                    "max_tokens":  1200,
                },
                timeout=LLM_TIMEOUT,
            )

        raw = resp.json()["choices"][0]["message"]["content"].strip()
        # Strip markdown fences if present
        raw = re.sub(r'^```(?:json)?\s*', '', raw)
        raw = re.sub(r'\s*```$',          '', raw)
        fields = json.loads(raw.strip())

        if not isinstance(fields, list):
            logger.warning("[form_filler] detect_fields returned non-list — wrapping")
            fields = []

        logger.info(f"[form_filler] Detected {len(fields)} fields ({sum(1 for f in fields if not f.get('skip'))} fillable)")
        return fields

    except json.JSONDecodeError as e:
        logger.warning(f"[form_filler] JSON parse error in detect_fields: {e}")
        return []
    except Exception as e:
        logger.error(f"[form_filler] detect_fields failed: {e}", exc_info=True)
        return []


async def write_free_text(
    question:    str,
    company:     str,
    job_title:   str,
    resume_text: str,
    profile:     dict,
) -> str:
    """
    Write a compelling answer to a free-text application question.
    Returns the answer string, or empty string on failure.
    """
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        return ""

    profile_text = _build_profile_block(profile)
    resume_excerpt = resume_text[:4000] if resume_text else "(no resume text available)"

    user_msg = f"""COMPANY: {company}
ROLE: {job_title}

CANDIDATE PROFILE:
{profile_text}

CANDIDATE RESUME (excerpt):
{resume_excerpt}

APPLICATION QUESTION:
{question}

Write the answer now."""

    try:
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                "https://api.openai.com/v1/chat/completions",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model":       LLM_MODEL,
                    "messages":    [
                        {"role": "system", "content": _FREE_TEXT_SYSTEM},
                        {"role": "user",   "content": user_msg},
                    ],
                    "temperature": 0.4,
                    "max_tokens":  400,
                },
                timeout=LLM_TIMEOUT,
            )

        answer = resp.json()["choices"][0]["message"]["content"].strip()
        logger.info(f"[form_filler] Wrote {len(answer)}-char answer for: {question[:60]}")
        return answer

    except Exception as e:
        logger.error(f"[form_filler] write_free_text failed: {e}", exc_info=True)
        return ""