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
3. For select/dropdown/combobox fields: value must be a display-friendly string the option list will contain.
   - Work authorization (authorized to work in US): if profile says yes → value="Yes", if no → value="No"
   - Sponsorship required: if profile says yes → value="Yes", if no → value="No"
   - Gender: use exact strings like "Male", "Female", "Non-Binary", "I don't wish to answer"
   - Veteran status: use "I am not a protected veteran" or "I am a protected veteran" or "I don't wish to answer"
   - Disability: use "No, I do not have a disability" or "Yes, I have a disability" or "I don't wish to answer"
   - NEVER return raw profile values like "yes"/"no"/"decline" for dropdown fields — always return the display text.
4. For checkboxes (e.g. "I agree to terms", consent checkboxes): value="check", skip=false.
5. For fields you cannot determine a value for: set skip=true.
6. Do NOT fabricate information not present in the profile.
7. For "How did you hear about us?" type fields: value="LinkedIn" unless profile says otherwise.
8. For salary fields: skip=true (leave for human).
9. For EEO questions (gender identity, transgender, sexual orientation, ethnicity): use the profile value if set,
   otherwise use the "decline/prefer not to answer" option — NEVER skip these, always fill them.
   CRITICAL: Only include EEO fields if they are ACTUALLY PRESENT in the DOM FIELD TABLE. Never invent
   EEO fields (gender, veteran status, disability) if they don't appear in the DOM table — many forms
   have no EEO section at all.
10. Keep values concise and factual.
11. For "current company" or "most recent company" fields: use the "Current/Most Recent Company" from the profile.
    If not available in the profile, look in the resume text for the most recent employer name. NEVER skip this field.
12. For privacy policy / consent dropdowns (e.g. "By selecting I agree..." or "I understand..."):
    These are REQUIRED dropdowns with options like "I agree" or "I agree to the terms". Always fill them with
    the affirmative option — set value="I agree" and skip=false. Never skip consent dropdowns.
13. For "By checking this box, I consent..." checkboxes: value="check", skip=false.
14. For transgender experience, sexual orientation, ethnicity dropdowns: if profile has no value,
    use the decline/prefer not to answer option. NEVER leave skip=true for required EEO dropdowns.
15. STRICT DOM GROUNDING: Every field you output MUST have a selector_hint that matches an id or name
    value from the DOM FIELD TABLE above. NEVER invent selector_hints or reuse the same selector_hint
    for multiple fields. If you cannot find a DOM element for a field, set skip=true."""

_FREE_TEXT_SYSTEM = """You are writing a job application answer on behalf of a real person.

Your job is to sound exactly like a sharp, self-aware engineer typing a quick honest answer — not like an AI, not like a cover letter, not like a LinkedIn post.

HARD RULES:
- No bullet points. No numbered lists. No hyphens as list separators. No dashes between clauses. Prose only.
- No filler: "passionate about", "excited to", "eager to", "strong background", "proven track record", "results-driven", "team player", "I believe in", "I am thrilled", "I would love to".
- No throat-clearing openers like "Great question" or "I am a software engineer with X years of experience".
- No em-dashes (—) used as sentence connectors. Use a period instead.
- Never fabricate projects, companies, metrics, or titles not in the resume.
- 2-4 sentences max. Every sentence must add something specific. Cut anything generic.
- First person only: "I built", "I noticed", "When I was at X".
- Pull one real, concrete thing from the resume — a project name, a specific problem solved, a number if it exists.
- Sound like a person who knows what they did and can say it plainly.

QUESTION TYPES:
- "What exceptional/notable work have you done?" → Pick the single best project from the resume. Name it. Say what problem it solved and what you actually built. One paragraph, 2-3 sentences.
- "Why do you want to work here?" → One specific thing about the company that connects to something real in the resume. No flattery.
- "Tell me about yourself" → Current focus + strongest relevant skill + one concrete thing you built. 2-3 sentences.
- "Tell me about a challenge/time..." → Situation in one sentence, what you did in one sentence, result in one sentence.

Output ONLY the answer. No preamble, no quotes, no explanation."""


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
    if profile.get("current_company"):      lines.append(f"Current/Most Recent Company: {profile['current_company']}")
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

async def detect_fields(raw_html: str, profile: dict, dom_snapshot: list[dict] | None = None) -> list[dict]:
    """
    Given raw page HTML, user profile, and optional DOM structural snapshot,
    return list of field fill instructions.
    Each item: { field_label, selector_hint, field_type, value, skip }

    dom_snapshot: list of dicts extracted by page.evaluate() in browser_agent.
    Each dict has: i, tag, type, id, name, placeholder, labelText, parentText,
    optionCount, firstOptions. When provided, a compact JSON table is prepended
    to the LLM prompt so it can produce accurate selector_hints even for deeply
    nested Greenhouse custom question fields.
    """
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        logger.error("[form_filler] OPENAI_API_KEY not set")
        return []

    form_html    = _extract_form_html(raw_html)
    profile_text = _build_profile_block(profile)

    # Build compact DOM table — filter to only fillable, named elements
    dom_table = ""
    if dom_snapshot:
        relevant = [
            el for el in dom_snapshot
            if (el.get("id") or el.get("name"))
            and el.get("type") not in ("hidden", "submit", "button", "reset", "image")
        ]
        if relevant:
            rows = []
            for el in relevant:
                label = el.get("labelText") or el.get("parentText", "")[:60]
                opts  = ", ".join(el.get("firstOptions", []))
                rows.append(
                    f'  {{"tag":"{el["tag"]}", "type":"{el.get("type","")}", '
                    f'"id":"{el.get("id","")}", "name":"{el.get("name","")}", '
                    f'"label":"{label}", "placeholder":"{el.get("placeholder","")}"'
                    + (f', "options":["{opts}"]' if opts else "")
                    + "}"
                )
            dom_table = "DOM FIELD TABLE (use the id or name value here verbatim as selector_hint):\n[\n" + ",\n".join(rows) + "\n]\n\n"

    user_msg = f"""CANDIDATE PROFILE:
{profile_text}

ATS CONTEXT: {profile.get('_ats_hint', 'Return the actual HTML id or name attribute as selector_hint.')}

{dom_table}FORM HTML:
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