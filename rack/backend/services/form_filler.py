"""
services/form_filler.py — LLM-powered form field detection and answer writer

Two responsibilities:
  1. detect_fields()    — given a DOM snapshot, identify every fillable field
                          and what value from the user profile to fill in
  2. write_free_text()  — given an open-ended question, write a compelling answer
                          from the user's resume + profile

Uses gpt-4o-mini via raw httpx (no openai SDK — never install it).
"""

import asyncio
import json
import logging
import os
import re

import httpx

logger = logging.getLogger(__name__)

LLM_MODEL = "gpt-4o-mini"
# Generous read timeout — a 28-element DOM table + 6KB of form HTML is a big
# prompt, and one slow OpenAI response must not kill an entire application
# (httpx.ReadTimeout here failed both Pinterest and Anduril in one batch).
LLM_TIMEOUT  = httpx.Timeout(connect=10.0, read=60.0, write=10.0, pool=10.0)
LLM_RETRIES  = 3
LLM_BACKOFFS = (2.0, 5.0)   # sleep before attempt 2, attempt 3


async def _llm_post(payload: dict, *, what: str) -> dict | None:
    """
    POST to OpenAI chat completions with retries. Retries on timeouts,
    transport errors, 408/429 and 5xx; gives up immediately on other 4xx
    (bad key / bad request won't get better). Returns parsed JSON or None.
    """
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        logger.error("[form_filler] OPENAI_API_KEY not set")
        return None

    for attempt in range(1, LLM_RETRIES + 1):
        try:
            async with httpx.AsyncClient() as client:
                resp = await client.post(
                    "https://api.openai.com/v1/chat/completions",
                    headers={
                        "Authorization": f"Bearer {api_key}",
                        "Content-Type":  "application/json",
                    },
                    json=payload,
                    timeout=LLM_TIMEOUT,
                )
            if resp.status_code == 200:
                return resp.json()
            retryable = resp.status_code in (408, 429) or resp.status_code >= 500
            logger.warning(f"[form_filler] {what} HTTP {resp.status_code} "
                           f"(attempt {attempt}/{LLM_RETRIES}, retryable={retryable})")
            if not retryable:
                return None
        except (httpx.TimeoutException, httpx.TransportError) as e:
            logger.warning(f"[form_filler] {what} attempt {attempt}/{LLM_RETRIES} "
                           f"failed: {type(e).__name__}")
        except Exception as e:
            logger.error(f"[form_filler] {what} unexpected error: {e}", exc_info=True)
            return None

        if attempt < LLM_RETRIES:
            await asyncio.sleep(LLM_BACKOFFS[min(attempt - 1, len(LLM_BACKOFFS) - 1)])

    logger.error(f"[form_filler] {what} failed after {LLM_RETRIES} attempts")
    return None


def _norm_label(s: str) -> str:
    """Normalize a label for comparison: lowercase, collapse whitespace, drop asterisks."""
    return " ".join((s or "").lower().replace("*", " ").split())

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


# Ref-anchored prompt (primary path). The model never sees or reproduces element
# ids — it anchors each field to a small integer "ref" from the DOM FIELD TABLE,
# and code resolves ref → the real DOM id. This makes a hallucinated/swapped id
# structurally impossible (the id never passes through the model). See BUG E.
_FIELD_DETECT_SYSTEM_REF = """You are an expert at reading job application form fields and deciding what a candidate should fill in.

You are given a DOM FIELD TABLE: a numbered list of the form's real fields. Each entry has an integer "ref", plus its label, type, placeholder, and (for dropdowns) some option text. You are also given the candidate's profile.

OUTPUT: Return ONLY a JSON object of the form {"fields": [ ... ]}. No markdown, no preamble, no explanation.

Schema per item in "fields":
{
  "ref": 7,                       // the integer "ref" of the DOM field you are filling — copy it exactly from the table
  "field_label": "First Name",    // human-readable label for review
  "field_type": "text | email | phone | textarea | select | checkbox | file | url | number",
  "value": "Exact value to fill in (use \"\" when skipping)",
  "skip": false
}

ANCHORING RULES (most important):
- Anchor EVERY field by its "ref" from the DOM FIELD TABLE. The ref is a small integer — copy it exactly.
- Emit at most ONE item per ref. Never reuse a ref for two different fields.
- Only emit fields that exist in the table. If a field you expected (e.g. an EEO question) is not in the table, do NOT emit it — many forms have no such section.
- If you cannot decide a value for a real field, still emit it with skip=true and value="" so it can be surfaced for the user.

VALUE RULES:
1. File upload fields (resume/CV): skip=true — handled separately.
2. Dropdown/select/combobox fields: value must be a display-friendly string the option list would contain.
   - Authorized to work in US: yes -> "Yes", no -> "No". Sponsorship required: yes -> "Yes", no -> "No".
   - Gender: "Male", "Female", "Non-Binary", "I don't wish to answer". Veteran: "I am not a protected veteran" / "I am a protected veteran" / "I don't wish to answer". Disability: "No, I do not have a disability" / "Yes, I have a disability" / "I don't wish to answer".
   - NEVER return raw values like "yes"/"no"/"decline" for dropdowns — return the display text.
3. Consent dropdowns ("By selecting I agree...", "I understand...") are REQUIRED: value="I agree", skip=false.
4. Consent / agreement checkboxes: value="check", skip=false.
5. EEO questions (gender identity, transgender experience, sexual orientation, ethnicity, veteran, disability): use the profile value if set, otherwise the decline/prefer-not-to-answer option. NEVER skip an EEO field that IS in the table.
6. "How did you hear about us?": value="LinkedIn" unless profile says otherwise.
7. Salary fields: skip=true (leave for human).
8. "Current/most recent company": use the profile's Current/Most Recent Company; else the most recent employer in the resume. Do not skip.
9. LinkedIn / GitHub / Website / Portfolio / Education / University: fill from the profile when present. Do not skip when the profile has a value.
10. Never fabricate information not present in the profile or resume. Keep values concise and factual."""


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


# ── Deterministic grounding & profile fills ───────────────────────────────────
# The LLM is best-effort; the DOM snapshot is ground truth. Everything below
# runs in code, every time, regardless of what the LLM returned — this is what
# kills the run-to-run whack-a-mole where Education/Website flip between
# "dropped", "skip=True", and "hallucinated id".

_ALWAYS_VALID_HINTS = {"first_name", "last_name", "email", "phone", "resume", "cover_letter"}
_SKIP_CLASS_HINTS   = ("visually-hidden", "requiredinput", "recaptcha", "iti__search")
_FILE_LABEL_WORDS   = ("resume", "attach", "cover letter", "cover_letter", "cv")
_TEXTLIKE_TYPES     = {"text", "email", "tel", "url", "number", "textarea", ""}

_SCHOOL_RE = re.compile(
    r"((?:[A-Z][A-Za-z&.'\-]+ ){0,4}"
    r"(?:University|Institute|College|Polytechnic)"
    r"(?: of [A-Z][A-Za-z&.'\- ]{2,40})?)"   # no comma in class — stop at ', MS ...'
)


def _school_from_resume(resume_text: str) -> str:
    """Best-effort extraction of the candidate's university from resume text."""
    if not resume_text:
        return ""
    m = _SCHOOL_RE.search(resume_text[:6000])
    return m.group(1).strip(" ,.-") if m else ""


def _profile_value_for_label(label: str, profile: dict) -> str | None:
    """
    Deterministic answer for a known text-question label, straight from the
    profile — no LLM involved. Returns None when no rule matches the label,
    '' when a rule matches but the profile has no data for it.
    """
    l = _norm_label(label)
    if not l:
        return None
    if "linkedin" in l:
        return profile.get("linkedin") or ""
    if "github" in l:
        return profile.get("github") or ""
    if "website" in l or "portfolio" in l or "personal site" in l:
        return profile.get("website") or profile.get("github") or ""
    if any(k in l for k in ("employer", "current company", "most recent company",
                            "current/previous", "company name")):
        return profile.get("current_company") or ""
    if any(k in l for k in ("university", "education", "college", "school")):
        return profile.get("school") or _school_from_resume(profile.get("resume_text", ""))
    return None


def _split_name(profile: dict) -> tuple[str, str]:
    first = profile.get("first_name") or ""
    last  = profile.get("last_name") or ""
    if not first and not last:
        parts = (profile.get("name") or "").split(" ", 1)
        first = parts[0] if parts else ""
        last  = parts[1] if len(parts) > 1 else ""
    return first, last


def _normalize_fields(fields) -> list[dict]:
    """Coerce LLM output into the canonical field schema; drop garbage entries."""
    out = []
    for f in fields if isinstance(fields, list) else []:
        if not isinstance(f, dict):
            continue
        out.append({
            "field_label":   str(f.get("field_label") or "").strip(),
            "selector_hint": str(f.get("selector_hint") or "").strip(),
            "field_type":    str(f.get("field_type") or "text").strip().lower(),
            "value":         "" if f.get("value") is None else str(f.get("value")),
            "skip":          bool(f.get("skip", False)),
        })
    return out


def _parse_llm_json(data: dict | None):
    """
    Extract and parse the JSON body of a chat-completions response. Returns a
    dict/list on success or None. Tolerates stray markdown fences (json_object /
    json_schema modes don't emit them, but the legacy free-form path can).
    """
    if not data:
        return None
    try:
        raw = data["choices"][0]["message"]["content"].strip()
    except (KeyError, IndexError, TypeError) as e:
        logger.warning(f"[form_filler] detect_fields bad response shape: {e}")
        return None
    raw = re.sub(r'^```(?:json)?\s*', '', raw)
    raw = re.sub(r'\s*```$',          '', raw)
    try:
        return json.loads(raw.strip())
    except json.JSONDecodeError as e:
        logger.warning(f"[form_filler] could not parse detect_fields JSON: {e}")
        return None


def _build_dom_table(dom_snapshot: list[dict] | None):
    """
    Build the numbered DOM FIELD TABLE the LLM anchors to, plus a ref→element
    map for code-side resolution.

    Returns (relevant, table_str, ref_map):
      - relevant : ordered list of fillable, named elements (ref == list index)
      - table_str: compact JSON text prepended to the prompt — carries ONLY
                   ref/label/type/placeholder/options, never the raw id. The id
                   is deliberately withheld so the model cannot echo (and corrupt)
                   it; it anchors purely by the integer ref.
      - ref_map  : {ref_int: element} for deterministic ref → real-id resolution
    """
    if not dom_snapshot:
        return [], "", {}
    relevant = [
        el for el in dom_snapshot
        if (el.get("id") or el.get("name"))
        and el.get("type") not in ("hidden", "submit", "button", "reset", "image")
    ]
    if not relevant:
        return [], "", {}

    ref_map, rows = {}, []
    for idx, el in enumerate(relevant):
        ref_map[idx] = el
        label = el.get("labelText") or (el.get("parentText") or "")[:60]
        opts  = ", ".join(el.get("firstOptions", []))
        rows.append(
            f'  {{"ref":{idx}, "tag":"{el.get("tag","")}", "type":"{el.get("type","")}", '
            f'"label":"{label}", "placeholder":"{el.get("placeholder","")}"'
            + (f', "options":["{opts}"]' if opts else "")
            + "}"
        )
    table = ("DOM FIELD TABLE — anchor every output field by its integer \"ref\":\n"
             "[\n" + ",\n".join(rows) + "\n]\n\n")
    return relevant, table, ref_map


def _resolve_refs(parsed_fields, ref_map: dict) -> list[dict]:
    """
    Convert ref-anchored LLM output into canonical fields whose selector_hint is
    the REAL id/name from the snapshot. This is the structural fix for BUG E:
    the id never passed through the model, so it cannot be hallucinated or
    swapped. An out-of-range / non-integer ref is dropped here; a valid ref
    always resolves to a real DOM element. Duplicate refs collapse (first wins).
    """
    out, seen = [], set()
    for f in parsed_fields if isinstance(parsed_fields, list) else []:
        if not isinstance(f, dict):
            continue
        ref = f.get("ref")
        # Tolerate stringified ints ("7") from non-strict JSON modes.
        if isinstance(ref, str) and ref.strip().lstrip("-").isdigit():
            ref = int(ref.strip())
        if not isinstance(ref, int) or isinstance(ref, bool) or ref not in ref_map:
            logger.info(f"[form_filler] dropped field with invalid ref={f.get('ref')!r} "
                        f"({f.get('field_label')!r})")
            continue
        if ref in seen:
            logger.info(f"[form_filler] deduped duplicate ref={ref} ({f.get('field_label')!r})")
            continue
        seen.add(ref)
        el   = ref_map[ref]
        hint = str(el.get("id") or el.get("name") or "").strip()
        if not hint:
            continue
        out.append({
            "field_label":   str(f.get("field_label") or el.get("labelText") or "").strip(),
            "selector_hint": hint,
            "field_type":    str(f.get("field_type") or "text").strip().lower(),
            "value":         "" if f.get("value") is None else str(f.get("value")),
            "skip":          bool(f.get("skip", False)),
        })
    return out


def _ground_fields(fields: list[dict], dom_snapshot: list[dict]) -> list[dict]:
    """
    Enforce DOM grounding in code (prompt rule 15 is advisory only):
      - a selector_hint that matches no DOM id/name is REPAIRED by label match
        against the snapshot (e.g. hallucinated 'question_38046698' → real
        'question_38046598' via label 'Website') instead of being dropped later
        by browser_agent's filter, which loses the field entirely;
      - unrepairable fields are dropped here, loudly;
      - duplicate selector_hints are deduped (first entry wins).
    """
    dom_hints = set()
    by_label  = {}
    for el in dom_snapshot:
        _id, _nm = str(el.get("id", "")), str(el.get("name", ""))
        if _id:
            dom_hints.add(_id)
        if _nm:
            dom_hints.add(_nm)
        _lbl = _norm_label(el.get("labelText", ""))
        if _id and _lbl and _lbl not in by_label:
            by_label[_lbl] = _id

    out, seen = [], set()
    for f in fields:
        hint = f.get("selector_hint", "")
        valid = (
            not hint
            or hint in dom_hints
            or hint in _ALWAYS_VALID_HINTS
            or f.get("field_type") == "file"
        )
        if not valid:
            lbl = _norm_label(f.get("field_label"))
            repaired = by_label.get(lbl)
            if not repaired and lbl:
                partial = {i for l, i in by_label.items() if lbl in l or l in lbl}
                if len(partial) == 1:
                    repaired = partial.pop()
            if repaired:
                logger.info(f"[form_filler] repaired hallucinated hint "
                            f"{hint!r} → {repaired!r} for {f.get('field_label')!r}")
                f = {**f, "selector_hint": repaired}
            else:
                logger.info(f"[form_filler] dropped ungroundable field "
                            f"{f.get('field_label')!r} (hint={hint!r})")
                continue
        h = f.get("selector_hint")
        if h and h not in _ALWAYS_VALID_HINTS and f.get("field_type") != "file":
            if h in seen:
                logger.info(f"[form_filler] deduped duplicate hint {h!r} "
                            f"({f.get('field_label')!r})")
                continue
            seen.add(h)
        out.append(f)
    return out


def _deterministic_overlay(fields: list[dict], dom_snapshot: list[dict], profile: dict) -> list[dict]:
    """
    Code-level pass that runs after (or instead of) the LLM:
      1. Standard Greenhouse fields (first/last name, email, phone) are
         guaranteed present and filled from the profile.
      2. Detected text fields left skip=True/empty get deterministic profile
         fills when the label is a known question (LinkedIn, GitHub, Website,
         Employer, Education) — BUG D's Education case.
      3. Eligible labeled text inputs missing from `fields` entirely are
         appended — filled when a profile rule matches, otherwise left to
         browser_agent's needs_user nets.
    Makes detection deterministic AND lets the apply degrade gracefully when
    OpenAI is down (fields is then just []).
    """
    by_hint = {f.get("selector_hint"): f for f in fields if f.get("selector_hint")}
    dom_by_id = {str(el.get("id", "")): el for el in dom_snapshot if el.get("id")}

    # 1 — standard fields, straight from profile
    first, last = _split_name(profile)
    for hint, label, value, ftype in (
        ("first_name", "First Name", first,                      "text"),
        ("last_name",  "Last Name",  last,                       "text"),
        ("email",      "Email",      profile.get("email") or "", "email"),
        ("phone",      "Phone",      profile.get("phone") or "", "phone"),
    ):
        if value and hint not in by_hint and (hint in dom_by_id or True):
            # always-valid hints — Greenhouse uses these ids by convention
            entry = {"field_label": label, "selector_hint": hint,
                     "field_type": ftype, "value": value, "skip": False}
            fields.append(entry)
            by_hint[hint] = entry

    # 2 — profile-fill detected-but-empty text fields
    for f in fields:
        if (f.get("value") or "").strip() or f.get("field_type") == "file":
            continue
        el = dom_by_id.get(f.get("selector_hint", ""))
        if el and "select__input" in (el.get("classes") or ""):
            continue   # combobox — browser_agent resolves those against live options
        pv = _profile_value_for_label(f.get("field_label", ""), profile)
        if pv:
            f["value"] = pv
            f["skip"]  = False
            logger.info(f"[form_filler] profile-filled {f.get('field_label')!r} → {pv!r}")

    # 3 — append eligible DOM text inputs the LLM missed
    for el in dom_snapshot:
        _id = str(el.get("id", ""))
        if not _id or _id in by_hint:
            continue
        classes = (el.get("classes") or "").lower()
        tag     = (el.get("tag") or "").lower()
        etype   = (el.get("type") or "").lower()
        label   = (el.get("labelText") or "").strip()
        if "select__input" in classes:
            continue                                   # comboboxes → browser_agent
        if tag != "textarea" and etype not in _TEXTLIKE_TYPES:
            continue
        if not label or any(h in classes for h in _SKIP_CLASS_HINTS):
            continue
        if any(w in label.lower() for w in _FILE_LABEL_WORDS):
            continue
        pv = _profile_value_for_label(label, profile)
        if pv:
            entry = {"field_label": label, "selector_hint": _id,
                     "field_type": "textarea" if tag == "textarea" else "text",
                     "value": pv, "skip": False}
            fields.append(entry)
            by_hint[_id] = entry
            logger.info(f"[form_filler] appended missed field {label!r} (id={_id}) → {pv!r}")

    return fields



# ── Main API ───────────────────────────────────────────────────────────────────

async def detect_fields(raw_html: str, profile: dict, dom_snapshot: list[dict] | None = None) -> list[dict]:
    """
    Given raw page HTML, user profile, and optional DOM structural snapshot,
    return list of field fill instructions.
    Each item: { field_label, selector_hint, field_type, value, skip }

    dom_snapshot: list of dicts extracted by page.evaluate() in browser_agent.
    Each dict has: i, tag, type, id, name, placeholder, labelText, parentText,
    optionCount, firstOptions. When provided, a numbered DOM FIELD TABLE is
    prepended to the prompt and the LLM anchors each field to an integer "ref";
    code resolves ref → the real DOM id afterwards. The id never passes through
    the model, so a hallucinated/swapped selector_hint is impossible (BUG E).
    With no snapshot, falls back to the legacy free-form selector_hint path.
    """
    form_html    = _extract_form_html(raw_html)
    profile_text = _build_profile_block(profile)

    relevant, dom_table, ref_map = _build_dom_table(dom_snapshot)
    fields: list[dict] = []

    if relevant:
        # ── Primary path: ref-anchored detection with structured output ──
        # The model anchors each field to an integer ref; code resolves ref →
        # real id. No id ever passes through the model ⇒ no hallucinated ids.
        user_msg = f"""CANDIDATE PROFILE:
{profile_text}

ATS CONTEXT: {profile.get('_ats_hint', 'Anchor every field by its integer ref from the table below.')}

{dom_table}Return the JSON object of fill instructions now."""

        valid_refs = list(ref_map.keys())
        item_schema = {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "ref":         {"type": "integer", "enum": valid_refs},
                "field_label": {"type": "string"},
                "field_type":  {"type": "string", "enum": [
                    "text", "email", "phone", "textarea", "select",
                    "checkbox", "file", "url", "number"]},
                "value":       {"type": "string"},
                "skip":        {"type": "boolean"},
            },
            "required": ["ref", "field_label", "field_type", "value", "skip"],
        }
        schema = {
            "type": "object",
            "additionalProperties": False,
            "properties": {"fields": {"type": "array", "items": item_schema}},
            "required": ["fields"],
        }
        base_payload = {
            "model":    LLM_MODEL,
            "messages": [
                {"role": "system", "content": _FIELD_DETECT_SYSTEM_REF},
                {"role": "user",   "content": user_msg},
            ],
            "temperature": 0.0,
            "max_tokens":  1500,
        }
        # Attempt 1: strict json_schema — ref is constrained to the valid-index
        # enum AT DECODE TIME, so an out-of-table id can't even be generated.
        data = await _llm_post(
            {**base_payload, "response_format": {
                "type": "json_schema",
                "json_schema": {"name": "form_fields", "strict": True, "schema": schema},
            }},
            what="detect_fields(json_schema)",
        )
        # Attempt 2: plain json_object, if the schema request was rejected
        # (older model snapshot etc.). _resolve_refs still post-validates refs.
        if not data:
            data = await _llm_post(
                {**base_payload, "response_format": {"type": "json_object"}},
                what="detect_fields(json_object)",
            )

        parsed = _parse_llm_json(data)
        items  = parsed.get("fields") if isinstance(parsed, dict) else None
        if items is None and isinstance(parsed, list):
            items = parsed                      # tolerate a bare array
        fields = _resolve_refs(items or [], ref_map)

    else:
        # ── Legacy path: no usable DOM snapshot — free-form selector_hint ──
        user_msg = f"""CANDIDATE PROFILE:
{profile_text}

ATS CONTEXT: {profile.get('_ats_hint', 'Return the actual HTML id or name attribute as selector_hint.')}

FORM HTML:
{form_html}

Return the JSON array of fill instructions now."""

        data = await _llm_post(
            {
                "model":    LLM_MODEL,
                "messages": [
                    {"role": "system", "content": _FIELD_DETECT_SYSTEM},
                    {"role": "user",   "content": user_msg},
                ],
                "temperature": 0.0,
                "max_tokens":  1200,
            },
            what="detect_fields(legacy)",
        )
        parsed = _parse_llm_json(data)
        if isinstance(parsed, list):
            fields = _normalize_fields(parsed)
        elif isinstance(parsed, dict) and isinstance(parsed.get("fields"), list):
            fields = _normalize_fields(parsed["fields"])
        elif data is not None:
            logger.warning("[form_filler] legacy detect_fields returned non-list — discarding")

    # Deterministic passes — DOM is ground truth, the LLM is best-effort.
    # These also let an apply proceed when OpenAI is down entirely: standard
    # + profile-known fields fill from code, comboboxes resolve later in
    # browser_agent against live options, the rest surfaces as needs_user.
    if dom_snapshot:
        if fields:
            fields = _ground_fields(fields, dom_snapshot)
        else:
            logger.warning("[form_filler] LLM detection unavailable — "
                           "building fields deterministically from DOM snapshot")
        fields = _deterministic_overlay(fields, dom_snapshot, profile)

    logger.info(f"[form_filler] Detected {len(fields)} fields "
                f"({sum(1 for f in fields if not f.get('skip'))} fillable)")
    return fields


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

    data = await _llm_post(
        {
            "model":    LLM_MODEL,
            "messages": [
                {"role": "system", "content": _FREE_TEXT_SYSTEM},
                {"role": "user",   "content": user_msg},
            ],
            "temperature": 0.4,
            "max_tokens":  400,
        },
        what="write_free_text",
    )
    if not data:
        return ""
    try:
        answer = data["choices"][0]["message"]["content"].strip()
    except (KeyError, IndexError, TypeError) as e:
        logger.error(f"[form_filler] write_free_text bad response shape: {e}")
        return ""
    logger.info(f"[form_filler] Wrote {len(answer)}-char answer for: {question[:60]}")
    return answer