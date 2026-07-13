"""
services/resume_optimizer.py — Structured-patch resume optimizer for RACK

REPLACES the old free-text-diff version. That version asked the LLM to return
"original"/"revised" string pairs matched against raw resume text — fragile
(exact-substring matching breaks on whitespace/formatting drift) and gave the
model too much room to rewrite rather than patch.

This version operates on the structured document model from resume_parser.py.
Every editable unit (summary, a skill item, a bullet) has a stable id. The LLM
returns PATCH OPERATIONS keyed to those ids — never raw text search/replace,
never an unconstrained rewrite.

Three optimization modes (from users.preferences.optimize_mode, chosen at
onboarding — see routers/account.py):
  "off"       — resume_optimize_worker.py skips this module entirely, no LLM
                call. Not handled here.
  "honest"    — light-touch: short phrase insertions/substring replacements
                only, never a full bullet rewrite, never a new bullet.
  "aggressive"— substantially rewrite existing bullets in the JD's language,
                and add new bullets under existing jobs/projects when there's
                real (even thin) evidence elsewhere in the resume. Still never
                fabricates a claim with zero evidence anywhere in the resume —
                that's a hard floor common to both modes, not something
                "aggressive" loosens. What aggressive changes is how much of
                the TRUE, evidenced content the model may restructure, not
                whether it's allowed to invent things.

Two-stage pipeline, same shape in both modes:
  1. classify_requirements()  — for each JD requirement, classify resume
     evidence as: explicit | implicit | weak | absent | hallucination_risk.
     This runs BEFORE patch generation and constrains it: patches are only
     generated for requirements classified explicit/implicit/weak. absent
     requirements are never patched in — they're surfaced to the user as
     "not supported" so RACK never fabricates experience.
  2. generate_patches()       — structured edit operations only:
       insert_phrase  { target_id, position: "after:<anchor text>" | "end", text }
       replace_text   { target_id, before, after }
       rewrite_bullet { target_id, text }                    — aggressive only
       add_bullet     { target_id (a company_id/project_id), text }  — aggressive only
     Never operates outside the ids resume_parser.py produced (rewrite_bullet
     still targets a real existing bullet id; add_bullet still targets a real
     existing job/project container — neither can invent a new employer).

Hard rules enforced in the system prompt (non-negotiable, mirrored in code,
identical in both modes):
  - Never invent a tool, employer, title, date, metric, or achievement not
    already evidenced in the resume.
  - Never modify dates, job titles, employers, education, or certifications.
  - Every patch must cite the requirement_id it addresses and a confidence
    score; patches below CONFIDENCE_FLOOR are dropped server-side before
    they ever reach the editor — a bad LLM call can't sneak in a weak claim.

--- Classify/score split (new) ----------------------------------------------
generate_resume_patches() still classifies AND patches in one LLM call if
you call it the old way (no `precomputed_classification` arg — see its
docstring). That path is UNCHANGED, on purpose: I can't see routers/apply.py's
regenerate-on-demand call site this session, so I can't tell what would break
there if this function's contract moved. Preserving it exactly is the safe
default until that file is in hand.

The new, preferred path splits classification out into its own call:
  classify_and_score_requirements() — Call 1. Resume-evidence-aware, JD-aware,
    no patches yet. Assigns req_<slug>/pref_<slug> ids to required_skills/
    preferred_skills IN PYTHON before the LLM ever sees them, so `importance`
    on the returned classification is a deterministic prefix check, never a
    field the model has to remember to report — closing the actual gap that
    left requirement_classification without an importance field before this
    change (apply.py/Dashboard.jsx/ResumeOptimizer.jsx all filtered on a key
    that never existed and silently fell back to mock data). Also returns a
    deterministic match_score (percent + label), computed the same formula
    apply.py's get_resume_optimization already uses, so there's one scoring
    formula, not two that can drift apart — apply.py should read match_score
    off the stored row once it's updated to do so, rather than recompute it.
  generate_resume_patches(precomputed_classification=...) — Call 2. Given an
    already-computed classification, generates patches only — same 4 ops,
    same validation, same absolute rules as the legacy path.

Cost note: resume_optimize_worker.py now makes 3 LLM calls per job instead of
the 2 this was meant to land on (extract_jd_requirements, then
classify_and_score_requirements, then generate_resume_patches). The 3rd is
temporary — extract_jd_requirements' output is exactly what Call 1 needs, so
once apply.py's real call site is visible, extraction can be folded directly
into classify_and_score_requirements and this drops back to 2. Not done yet
because I can't safely change extract_jd_requirements' role without knowing
what else might call it.

Called from:
  services/resume_optimize_worker.py  — optimize_batch_resumes() background
    task. Uses the new path: extract_jd_requirements() →
    classify_and_score_requirements() → generate_resume_patches(mode=...,
    precomputed_classification=...).
  routers/apply.py                    — GET /jobs/{id}/resume (regenerate on
    demand). Not reviewed this session — presumed to still call this the old
    way, which is exactly why that way still works unchanged.
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
_CONFIDENCE_FLOOR   = 0.65   # patches below this are dropped before reaching the user

# Off skips the LLM entirely (see resume_optimize_worker.py) — no cap needed.
# Aggressive gets a higher ceiling since rewrite_bullet/add_bullet cover more
# ground per patch than a phrase-append does; Honest is unchanged from before.
_MAX_PATCHES_BY_MODE = {"honest": 14, "aggressive": 22}

# Match-score label ladder. Confirmed directly against apply.py's own
# get_resume_optimization fallback (routers/apply.py, read in full this
# session) rather than inferred — that endpoint already computes labels
# with this exact wording and these exact cutoffs, and a real screenshot
# (6/11 = 0.545 -> "Partial Match") matches it. No separate "Poor Match"
# tier exists in the live wording — anything under 0.65 reads "Partial
# Match" regardless of how low. Kept as the same three tiers here rather
# than inventing a fourth, so the two formulas actually agree.
_MATCH_SCORE_THRESHOLDS = [
    (0.85, "Excellent Match"),
    (0.65, "Good Match"),
    (0.0,  "Partial Match"),
]

_SYSTEM_PROMPT_HONEST = """You are a resume-JD matching and patching engine. You do NOT rewrite resumes.

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

_SYSTEM_PROMPT_AGGRESSIVE = """You are a resume-JD matching and patching engine, running in
AGGRESSIVE mode. The user explicitly asked for a substantially closer match to
this job description and will review every change before anything is sent
anywhere. "Aggressive" controls how much of their TRUE, evidenced experience
you may restructure and expand — it does NOT permit inventing anything the
candidate didn't actually do. That line does not move in this mode.

You will receive a candidate's resume as a structured document (sections, bullets,
skills, each with a stable id) and a job description's required/preferred skills.

STEP 1 — Classify each JD requirement against the resume evidence:
  "explicit"           — the requirement is already stated clearly in the resume
  "implicit"           — the resume shows the underlying skill, behavior, or
                          environment in substance, even if the JD's exact term
                          never appears. Be generous here: e.g. resume mentions
                          "sprint planning" or "stand-ups" anywhere → an "agile"
                          requirement is implicit, not absent. Resume mentions
                          Spark → "PySpark" is implicit. Look across the WHOLE
                          resume for this, not just the one bullet you're editing.
  "weak"                — mentioned once, thinly, could be moved/strengthened
                          into its own bullet
  "absent"              — no evidence anywhere in the resume, of any strength
  "hallucination_risk"   — would require inventing a tool/employer/achievement to add

STEP 2 — Generate patch operations for requirements classified "explicit" (to
sharpen/re-emphasize in the JD's language), "implicit", or "weak". Exactly as
in standard mode: NEVER generate a patch for "absent" or "hallucination_risk"
requirements — those must be left alone and reported back, not papered over.
This is the one rule aggressive mode does not relax.

FOUR patch operations (two more than standard mode):
  - "insert_phrase" / "replace_text": same as standard mode, small targeted edits.
  - "rewrite_bullet": replace an ENTIRE existing bullet's text with a
    substantially reworded version in the JD's own vocabulary and framing.
    Must describe the exact same underlying work — same company, same real
    accomplishment, same real scale/metric — only reframed and restructured,
    never changing what was actually built or for whom.
  - "add_bullet": add ONE genuinely new bullet under an EXISTING job or
    project. `target_id` is that job's/project's container id (company_id or
    project_id), NOT a bullet id — this creates a new bullet, it doesn't edit
    one. Only use this for requirements classified "implicit" or "weak" where
    you can point to real evidence elsewhere in the resume for what the new
    bullet claims. Keep it to one line, like every other bullet on the resume.

ABSOLUTE RULES (identical to standard mode — aggressive changes SCOPE of
rewriting, not the honesty floor):
1. Never add a tool, credential, employer, metric, title, responsibility, or
   achievement unless it is explicitly or implicitly supported by the resume
   text somewhere.
2. Never modify dates, job titles, employers, education, or certifications.
3. Every patch must target a real id from the document you were given —
   an existing bullet id for insert_phrase/replace_text/rewrite_bullet, or an
   existing company_id/project_id for add_bullet. Never invent an id.
4. Max 22 patches. Prioritize by requirement importance, not by patch count.
5. Return ONLY valid JSON, no markdown, no commentary.
"""

_AGGRESSIVE_SCHEMA_EXTRA = """,
    {{
      "operation": "rewrite_bullet",
      "target_id": "<exact bullet id from the document>",
      "text": "Full rewritten bullet text in the JD's own vocabulary, describing the same real work",
      "reason": "Reframes existing Spark/PySpark pipeline work in the JD's 'large-scale data infrastructure' language",
      "requirement_id": "data_infrastructure",
      "confidence": 0.88
    }},
    {{
      "operation": "add_bullet",
      "target_id": "<exact company_id or project_id — a container, not a bullet id>",
      "text": "One new line describing real work, evidenced elsewhere in the resume",
      "reason": "Resume mentions stand-ups and sprint retros in the Robosoft role — evidence for this JD's agile requirement",
      "requirement_id": "agile",
      "confidence": 0.71
    }}"""

def _build_user_prompt(doc_json, jd_text, required_skills, preferred_skills, mode="honest"):
    schema_extra = _AGGRESSIVE_SCHEMA_EXTRA if mode == "aggressive" else ""
    return f"""
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
    }}{schema_extra}
  ]
}}
"""


# ── Call 2 (new): patch generation only, given an already-computed
# classification from classify_and_score_requirements(). Trimmed versions of
# the two prompts above — STEP 1/classification removed since it's already
# done; STEP 2/patch-generation and the absolute rules are unchanged.
_PATCH_SYSTEM_PROMPT_HONEST = """You are a resume-JD patching engine. You do NOT rewrite resumes and you do
NOT classify requirements — classification has already been done; you will
receive it as input. Generate patch operations ONLY for requirements already
classified "implicit" or "weak" in the classification you're given. NEVER
generate a patch for a requirement classified "absent", "hallucination_risk",
or "explicit" — those must be left alone.

ABSOLUTE RULES:
1. Never add a tool, credential, employer, metric, title, responsibility, or
   achievement unless it is explicitly or implicitly supported by the resume text.
2. Never modify dates, job titles, employers, education, or certifications.
3. Every patch must target an existing id from the document you were given.
   Never invent new ids or new bullets from nothing — only extend what exists.
4. If a requirement's text contains an "e.g." example ("CI/CD tooling (e.g.
   CircleCI)"), you may write patch text about the BROAD category ("CI/CD
   tooling", "automated deployment pipelines") if that's what the evidence
   supports — but NEVER write the specific named example itself ("CircleCI")
   unless that exact term is independently present in the evidence_ids
   bullet's own text. A candidate can be asked in an interview to speak to
   anything you write onto their resume; a specific tool name they never
   used is exactly the kind of claim they can't defend. This is not a
   hypothetical — a real job had "CircleCI" inserted this way with zero
   evidence anywhere in the resume.
5. Two patch operations only:
   - "insert_phrase": append/insert a short phrase into an existing bullet or
     skills group. `position` is either "end" (append) or "after:<exact anchor
     substring from that target's current text>".
   - "replace_text": replace an exact substring within a target's current text.
     `before` MUST be an exact verbatim substring of that target's current text.
6. Keep insertions short — a phrase or a few words, not a rewritten sentence.
7. Each classified requirement carries an `evidence_ids` list — the specific
   bullet(s) that justified its classification in the first place. Target one
   of THOSE ids, not a different bullet, even if the different bullet also
   mentions related work. If two requirements share the same evidence_ids
   bullet, it's fine for both patches to land there; don't consolidate
   unrelated requirements onto one bullet just because it reads conveniently.
8. Max 14 patches. Prioritize requirements with importance "required" over
   "preferred", and higher-confidence matches over lower.
9. Return ONLY valid JSON, no markdown, no commentary.
"""

_PATCH_SYSTEM_PROMPT_AGGRESSIVE = """You are a resume-JD patching engine, running in AGGRESSIVE mode. You do NOT
classify requirements — classification has already been done; you will
receive it as input. The user explicitly asked for a substantially closer
match to this job description and will review every change before anything
is sent anywhere. "Aggressive" controls how much of their TRUE, evidenced
experience you may restructure and expand — it does NOT permit inventing
anything the candidate didn't actually do. That line does not move.

Generate patch operations for requirements already classified "explicit" (to
sharpen/re-emphasize in the JD's language), "implicit", or "weak" in the
classification you're given. NEVER generate a patch for a requirement
classified "absent" or "hallucination_risk" — those must be left alone. This
is the one rule aggressive mode does not relax.

FOUR patch operations (two more than standard mode):
  - "insert_phrase" / "replace_text": same as standard mode, small targeted edits.
  - "rewrite_bullet": replace an ENTIRE existing bullet's text with a
    substantially reworded version in the JD's own vocabulary and framing.
    Must describe the exact same underlying work — same company, same real
    accomplishment, same real scale/metric — only reframed and restructured,
    never changing what was actually built or for whom.
  - "add_bullet": add ONE genuinely new bullet under an EXISTING job or
    project. `target_id` is that job's/project's container id (company_id or
    project_id), NOT a bullet id. Only use this for requirements classified
    "implicit" or "weak" where the given classification's evidence points to
    something real elsewhere in the resume. Keep it to one line.

ABSOLUTE RULES (identical to standard mode — aggressive changes SCOPE of
rewriting, not the honesty floor):
1. Never add a tool, credential, employer, metric, title, responsibility, or
   achievement unless it is explicitly or implicitly supported by the resume
   text somewhere.
2. Never modify dates, job titles, employers, education, or certifications.
3. Every patch must target a real id from the document you were given —
   an existing bullet id for insert_phrase/replace_text/rewrite_bullet, or an
   existing company_id/project_id for add_bullet. Never invent an id.
4. If a requirement's text contains an "e.g." example ("CI/CD tooling (e.g.
   CircleCI)"), you may write patch text about the BROAD category ("CI/CD
   tooling", "automated deployment pipelines") if that's what the evidence
   supports — but NEVER write the specific named example itself ("CircleCI")
   unless that exact term is independently present in the evidence_ids
   bullet's own text. A candidate can be asked in an interview to speak to
   anything you write onto their resume; a specific tool name they never used
   is exactly the kind of claim they can't defend. This is not a
   hypothetical — a real job had "CircleCI" inserted this way with zero
   evidence anywhere in the resume.
5. Each classified requirement carries an `evidence_ids` list — the specific
   bullet(s) that justified its classification in the first place. For
   insert_phrase/replace_text/rewrite_bullet, target one of THOSE ids, not a
   different bullet, even if the different bullet also mentions related work.
   For add_bullet, place the new bullet under the job/project that CONTAINS
   the evidence_ids bullet, not an unrelated one. Don't consolidate unrelated
   requirements onto one bullet just because it reads conveniently.
6. Max 22 patches. Prioritize requirements with importance "required" over
   "preferred", and higher-confidence matches over lower.
7. Return ONLY valid JSON, no markdown, no commentary.
"""


def _build_patch_user_prompt(doc_json, classification: list[dict], mode: str = "honest") -> str:
    schema_extra = _AGGRESSIVE_SCHEMA_EXTRA if mode == "aggressive" else ""
    # Only hand the model requirements it's actually allowed to patch — same
    # effect as the server-side blocked_req_ids filter below, just applied
    # before the call too so the model isn't even tempted by a blocked one.
    patchable = [c for c in classification if c.get("classification") not in ("absent", "hallucination_risk")]
    return f"""
CLASSIFIED REQUIREMENTS (only patch what's listed here, respecting each one's classification and importance):
{json.dumps(patchable, indent=None)}

Each requirement above lists its own evidence_ids — target one of those bullet
ids for that requirement's patch, not a different bullet that happens to read
conveniently.

RESUME DOCUMENT (structured, ids included):
{json.dumps(doc_json, indent=None)[:6000]}

Return JSON exactly matching this schema:
{{
  "patches": [
    {{
      "operation": "insert_phrase",
      "target_id": "<exact id from the document>",
      "position": "after:LangChain/OpenAI",
      "text": " and Databricks",
      "reason": "Matches required platform skill, evidenced by existing data platform work",
      "requirement_id": "req_databricks",
      "confidence": 0.93
    }}{schema_extra}
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


_EXTRACT_SYSTEM_PROMPT = """You extract structured skill requirements from a job description.
Return ONLY valid JSON, no markdown, no commentary, matching exactly:
{
  "required_skills": ["skill1", "skill2", ...],
  "preferred_skills": ["skill1", "skill2", ...]
}

Rules:
- required_skills: skills/tools/technologies stated as required, must-have, or minimum qualifications.
- preferred_skills: skills stated as nice-to-have, preferred, bonus, or "a plus".
- Use short skill names as they'd appear on a resume (e.g. "PySpark", not "experience with PySpark").
- Only classify as required if the JD language is unambiguous ("must have", "required", "X+ years of").
  If genuinely ambiguous, prefer preferred over required.
- Do not invent skills that aren't mentioned in the text.
- Cap each list at 12 items. Prioritize specific technical skills over generic ones
  (e.g. skip "communication skills", keep "Kubernetes").
- DISJUNCTIVE REQUIREMENTS: if the JD lists several acceptable options for ONE
  requirement ("one or more of Python, Go, Rust, C++", "experience with Java
  or Kotlin", "familiarity with any of: Spark, Flink, Beam"), emit ONE entry
  covering the whole set (e.g. "Python/Go/Rust/C++ (one of)") — never split it
  into separate entries per option. A candidate who has ONE of the listed
  options fully satisfies the requirement; splitting it into N separate
  skills makes the other N-1 look like unmet gaps nobody was asked to have.
  This is the likely mechanism behind a real production bug (skills patched
  into a resume with zero evidence, because each option in a "pick one" list
  was being tracked as its own independent, apparently-unmet requirement).
- ILLUSTRATIVE EXAMPLES: if the JD names ONE specific tool only as an example
  of a broader category ("CI/CD tooling (CircleCI)", "a modern frontend
  framework such as React", "cloud platforms like AWS"), keep the BROAD
  category as the requirement and mark the example explicitly as illustrative
  using "e.g." — write "CI/CD tooling (e.g. CircleCI)", never "CI/CD tooling
  (CircleCI)" with no "e.g.". This distinction is load-bearing downstream: an
  "e.g." example must never be claimed on a resume unless it's independently
  evidenced, even when the broader category is — confirmed on a real job
  where "CircleCI" ended up literally inserted into a resume with zero
  evidence anywhere, because the extracted requirement text gave no signal
  that CircleCI was just the JD's example, not an actual ask.
"""


async def extract_jd_requirements(jd_text: str) -> dict:
    """
    Call-time extraction of required/preferred skills from raw JD text.

    job_pool has no required_skills/preferred_skills columns, so
    generate_resume_patches() has no per-job signal to work from unless
    something recovers it first. This is that step — one LLM call per
    apply-click, reusing _call_llm so it shares the same httpx/JSON-cleanup
    path as generate_resume_patches(). Fails soft: any LLM error returns
    empty lists rather than raising, so a flaky extraction call degrades to
    today's behavior (generic patches) instead of failing the whole job.
    """
    if not jd_text or not jd_text.strip():
        return {"required_skills": [], "preferred_skills": []}

    user_message = f"JOB DESCRIPTION:\n{jd_text[:4000]}"

    try:
        result = await _call_llm(_EXTRACT_SYSTEM_PROMPT, user_message)
    except HTTPException as e:
        logger.warning(f"[optimizer] requirement extraction failed, continuing with empty lists: {e.detail}")
        return {"required_skills": [], "preferred_skills": []}

    required = result.get("required_skills", [])
    preferred = result.get("preferred_skills", [])
    if not isinstance(required, list):
        required = []
    if not isinstance(preferred, list):
        preferred = []

    required = [str(s).strip() for s in required if str(s).strip()][:12]
    preferred = [str(s).strip() for s in preferred if str(s).strip()][:12]

    return {"required_skills": required, "preferred_skills": preferred}


# ── Call 0: deterministic preprocessing, no LLM ──────────────────────────────

_BR_TAG_RE = re.compile(r"<br\s*/?>", re.IGNORECASE)
_BLOCK_CLOSE_TAG_RE = re.compile(r"</(p|div|li|h[1-6]|tr)\s*>", re.IGNORECASE)
_HTML_TAG_RE = re.compile(r"<[^>]+>")
_WHITESPACE_RE = re.compile(r"[ \t]+")
_BLANKLINES_RE = re.compile(r"\n{3,}")
# Boilerplate paragraphs that eat character budget without adding matchable
# signal. Matched by a starting phrase; deliberately conservative — phrase
# families, not a general "legal-sounding text" heuristic — so it
# under-removes rather than risks cutting a real requirement.
_BOILERPLATE_STARTS = [
    r"(is|are) an equal opportunity employer",
    r"(does|do) not discriminate",
    r"e-?verify",
    r"pursuant to the .{0,40}fair chance",
    r"salary range for this (position|role)",
    r"base pay range",
    r"total compensation package",
    r"benefits (package |offered )?includes?",
    r"(is|are) committed to providing reasonable accommodation",
    r"applicant privacy notice",
    r"your personal (data|information) (will|may) be",
]
# Bounded to same-"line" trailing context only (<=220 chars, roughly a
# sentence) — does NOT reach into a following line/paragraph even when one
# exists nearby. Two earlier versions were both caught by testing, not by
# re-reading the regex: v1 matched "to the next blank line or end of
# string", which on JD HTML with no real paragraph breaks (inline markup
# only, no <p>/<br>) ran straight through to end-of-string, deleting every
# real requirement after the first boilerplate phrase. v2 bounded the
# same-line span but then greedily consumed up to 3 MORE full lines after
# it "just in case a disclaimer spans several lines" — which meant it ate
# the very next real paragraph too whenever one immediately followed a
# boilerplate one (a completely normal JD layout: EEO paragraph, then
# requirements paragraph, back to back). Dropping the multi-line extension
# entirely means a boilerplate block longer than ~220 chars or spanning
# multiple lines only gets partially scrubbed — an acceptable under-removal,
# not a risk of cutting real content, which is the direction this is
# supposed to err in.
_BOILERPLATE_RE = re.compile(
    r"(?:^|\n)[^\n]{0,120}(" + "|".join(_BOILERPLATE_STARTS) + r")[^\n]{0,220}",
    re.IGNORECASE,
)


def clean_job_description(jd_text: str) -> str:
    """
    Deterministic JD cleanup — no LLM call. Converts block-level HTML breaks
    (<br>, </p>, </div>, </li>, </h1-6>, </tr>) to newlines BEFORE stripping
    remaining tags, so paragraph structure survives for the boilerplate
    matcher below; collapses whitespace; drops common boilerplate paragraphs
    (EEO/comp-disclosure/privacy-notice) that eat character budget without
    adding classifiable signal.

    Regex-based heuristic, not a guaranteed-complete cleaner — under-removes
    by design. jd_parser.py (used by the auto-match pipeline) may already do
    JD structuring/cleaning that overlaps with this; that file hasn't been
    reviewed this session, so this doesn't reuse it yet and may be
    duplicating logic that already exists elsewhere. Worth checking before
    this drifts into a second JD parser.
    """
    if not jd_text:
        return ""
    text = _BR_TAG_RE.sub("\n", jd_text)
    text = _BLOCK_CLOSE_TAG_RE.sub("\n", text)
    text = _HTML_TAG_RE.sub(" ", text)
    text = (text.replace("&nbsp;", " ").replace("&amp;", "&")
                .replace("&lt;", "<").replace("&gt;", ">"))
    text = _BOILERPLATE_RE.sub("\n", text)
    text = _WHITESPACE_RE.sub(" ", text)
    text = _BLANKLINES_RE.sub("\n\n", text)
    return text.strip()


def build_evidence_index(doc: dict) -> list[dict]:
    """
    Compact {id, type, text} list of every citable unit in the structured
    resume — summary, skills, experience/project bullets, education,
    certifications, publications.

    Replaces handing the LLM a blind json.dumps(doc)[:6000] truncation of
    the whole document for classification purposes. That cutoff is a real,
    live risk on a resume with enough content — this project's own test
    resume (4 companies/2 projects/19 bullets/7 skill groups) could
    plausibly brush against it on a more verbose one — and a truncation cut
    drops content with zero signal that anything was lost. No length cap of
    its own: a dropped bullet here isn't "the prompt got shorter", it's "the
    model can never cite that bullet as evidence again, silently, for the
    rest of the call." If token budget becomes a real problem in practice,
    the right fix is trimming by section relevance, not chopping the JSON
    string at a fixed offset.

    education/certifications/publications were missing entirely from the
    first version of this function — confirmed as a real regression against
    live data, not a hypothetical: a candidate with "Master's in Computer
    Science" on their resume got classified "absent" for a "Computer
    Science" preferred requirement, evidence="", because the classify call
    had literally no way to see the Education section at all. The legacy
    combined-call path (still the fallback when precomputed_classification
    isn't given) doesn't have this gap since it dumps the whole doc; this
    purpose-built index recreated the gap by only covering 4 of the 7
    sections a resume can have.
    """
    index: list[dict] = []
    if doc.get("summary"):
        index.append({"id": doc["summary"]["id"], "type": "summary", "text": doc["summary"]["text"]})
    for g in doc.get("skills", []):
        for item in g.get("items", []):
            index.append({"id": item["id"], "type": "skill", "text": item["text"]})
    for exp in doc.get("experience", []):
        company = exp.get("company", "")
        for b in exp.get("bullets", []):
            index.append({"id": b["id"], "type": "experience_bullet", "text": b["text"], "company": company})
    for proj in doc.get("projects", []):
        name = proj.get("name") or proj.get("title", "")
        for b in proj.get("bullets", []):
            index.append({"id": b["id"], "type": "project_bullet", "text": b["text"], "project": name})
    for i, edu in enumerate(doc.get("education", [])):
        text = ", ".join(filter(None, [edu.get("degree"), edu.get("school")]))
        if text:
            index.append({"id": edu.get("id") or f"edu_{i}", "type": "education", "text": text})
    for i, cert in enumerate(doc.get("certifications", [])):
        text = (cert.get("text") or cert.get("name")) if isinstance(cert, dict) else str(cert)
        cid = (cert.get("id") if isinstance(cert, dict) else None) or f"cert_{i}"
        if text:
            index.append({"id": cid, "type": "certification", "text": text})
    for i, pub in enumerate(doc.get("publications", [])):
        text = (pub.get("text") or pub.get("name")) if isinstance(pub, dict) else str(pub)
        pid = (pub.get("id") if isinstance(pub, dict) else None) or f"pub_{i}"
        if text:
            index.append({"id": pid, "type": "publication", "text": text})
    return index


def _slugify(text: str, prefix: str, seen: set) -> str:
    """
    req_/pref_-prefixed, collision-safe id for a required/preferred skill
    string. Deterministic and Python-controlled on purpose: the classify
    call judges against ids WE hand it, so `importance` downstream is a
    prefix check on a real dict key, never a field the model has to
    remember to fill in — which is exactly what went missing before
    (requirement_classification never had an importance field, so every
    downstream consumer that filtered on it silently got an empty list and
    fell back to mock data).
    """
    slug = re.sub(r"[^a-z0-9]+", "_", text.strip().lower()).strip("_")[:40] or "skill"
    candidate = f"{prefix}_{slug}"
    n = 2
    while candidate in seen:
        candidate = f"{prefix}_{slug}_{n}"
        n += 1
    seen.add(candidate)
    return candidate


def score_from_classification(classification: list[dict]) -> dict:
    """
    Deterministic percent + label from a requirement_classification list.
    Public (no leading underscore) — routers/apply.py's get_resume_optimization
    imports this directly for its own fallback (when a row predates match_score
    being stored, or optimize_mode was "off") instead of keeping a second copy
    of the same formula that could silently drift from this one. Confirmed
    against apply.py's real pre-existing fallback logic: 6/11 non-absent of 11
    total = round(100*6/11) = 55, labeled "Partial Match" — matches a real
    screenshot exactly.

    Counts anything not classified "absent" as met — that includes
    "hallucination_risk", matching apply.py's original behavior exactly.
    Worth a second look: hallucination_risk arguably shouldn't count as met
    any more than absent does, since neither has real support. Kept as-is
    here for continuity rather than silently changing what the number means
    — flag if you want that changed.
    """
    total = len(classification) or 1
    met = sum(1 for c in classification if isinstance(c, dict) and c.get("classification") != "absent")
    percent = round(100 * met / total)
    ratio = met / total
    label = "Poor Match"
    for cutoff, name in _MATCH_SCORE_THRESHOLDS:
        if ratio >= cutoff:
            label = name
            break
    return {"percent": percent, "label": label}


_CLASSIFY_SYSTEM_PROMPT_HONEST = """You are a resume-evidence classifier. You do NOT rewrite anything and you
do NOT generate patches — this call only judges how well a candidate's
resume supports a job's requirements.

You will receive a list of requirements, each with a stable id already
assigned ("req_..." = required by the JD, "pref_..." = preferred/nice-to-have
— do not use these prefixes to guess importance, just classify each id on its
own merits; importance is handled separately from your output), and an
evidence index: a flat list of citable resume units (summary, skills,
experience bullets, project bullets), each with its own stable id.

For EVERY requirement id you are given, classify it exactly once as:
  "explicit"           — the requirement is already stated clearly in the resume
  "implicit"           — strongly implied by existing work but not named directly
                          (e.g. an evidence item says "built ETL pipelines with
                          Spark" and the requirement is "PySpark" — that's
                          implicit, naming it is honest)
  "weak"                — mentioned once, thinly, could be moved/strengthened
  "absent"              — no evidence anywhere in the evidence index
  "hallucination_risk"   — would require inventing a tool/employer/achievement to add

Rules:
1. Classify against the evidence index ONLY — never assume something is true
   of the candidate just because the requirement mentions it.
2. If a requirement's text lists multiple acceptable options (e.g. "Python/Go/
   Rust/C++ (one of)"), it is satisfied if evidence supports ANY ONE of the
   listed options — do not classify it "absent" or "hallucination_risk" just
   because some of the listed options are unsupported.
3. If a requirement's text contains an "e.g." example ("CI/CD tooling (e.g.
   CircleCI)"), classify against the BROAD category, not the specific example
   — generic CI/CD pipeline evidence can make this "implicit" even with zero
   mention of CircleCI by name. But your `evidence` field must describe what
   actually supports the broad category (e.g. "automated CI/CD validation
   pipelines"), and must NEVER claim the specific "e.g." example itself was
   found unless that exact term is independently present in the evidence
   index. This matters even though this call doesn't write the resume text —
   the patch call downstream trusts your evidence description.
4. Every classification must cite which evidence_index id(s), if any,
   support it, in evidence_ids. If none, evidence_ids is an empty list — do
   not invent one.
5. Classify every id you were given. Do not skip any, do not add new ones.
6. Return ONLY valid JSON, no markdown, no commentary.
"""

_CLASSIFY_SYSTEM_PROMPT_AGGRESSIVE = """You are a resume-evidence classifier, running in AGGRESSIVE mode. You do
NOT rewrite anything and you do NOT generate patches — this call only judges
how well a candidate's resume supports a job's requirements. "Aggressive"
means being more generous about what counts as implicit support; it does NOT
mean inventing support that isn't there.

You will receive a list of requirements, each with a stable id already
assigned ("req_..." = required by the JD, "pref_..." = preferred/nice-to-have
— do not use these prefixes to guess importance, just classify each id on its
own merits), and an evidence index: a flat list of citable resume units
(summary, skills, experience bullets, project bullets), each with its own
stable id.

For EVERY requirement id you are given, classify it exactly once as:
  "explicit"           — the requirement is already stated clearly in the resume
  "implicit"           — the evidence index shows the underlying skill,
                          behavior, or environment in substance, even if the
                          requirement's exact term never appears. Be generous:
                          e.g. an evidence item mentions "sprint planning" or
                          "stand-ups" anywhere → an "agile" requirement is
                          implicit, not absent. An item mentions Spark →
                          "PySpark" is implicit. Look across the WHOLE
                          evidence index for this, not just one item.
  "weak"                — mentioned once, thinly, could be moved/strengthened
                          into its own bullet
  "absent"              — no evidence anywhere in the evidence index, of any strength
  "hallucination_risk"   — would require inventing a tool/employer/achievement to add

Rules:
1. Classify against the evidence index ONLY — never assume something is true
   of the candidate just because the requirement mentions it. Generosity
   applies to how loosely you interpret existing evidence, never to
   accepting zero evidence.
2. If a requirement's text lists multiple acceptable options (e.g. "Python/Go/
   Rust/C++ (one of)"), it is satisfied if evidence supports ANY ONE of the
   listed options — do not classify it "absent" or "hallucination_risk" just
   because some of the listed options are unsupported.
3. If a requirement's text contains an "e.g." example ("CI/CD tooling (e.g.
   CircleCI)"), classify against the BROAD category, not the specific example
   — generic CI/CD pipeline evidence can make this "implicit" even with zero
   mention of CircleCI by name. But your `evidence` field must describe what
   actually supports the broad category, and must NEVER claim the specific
   "e.g." example itself was found unless that exact term is independently
   present in the evidence index. This matters even though this call doesn't
   write the resume text — the patch call downstream trusts your evidence
   description.
4. Every classification must cite which evidence_index id(s), if any,
   support it, in evidence_ids. If none, evidence_ids is an empty list — do
   not invent one.
5. Classify every id you were given. Do not skip any, do not add new ones.
6. Return ONLY valid JSON, no markdown, no commentary.
"""


def _build_classify_user_prompt(evidence_index: list[dict], requirements: list[dict], jd_text_clean: str) -> str:
    return f"""
JOB DESCRIPTION (cleaned, for context):
{jd_text_clean[:2500]}

REQUIREMENTS TO CLASSIFY (id, text):
{json.dumps([{"id": r["id"], "text": r["text"]} for r in requirements], indent=None)}

EVIDENCE INDEX (id, type, text):
{json.dumps(evidence_index, indent=None)}

Return JSON exactly matching this schema:
{{
  "requirement_classification": [
    {{ "requirement_id": "req_databricks", "requirement": "Databricks",
       "classification": "implicit", "evidence": "Uber bullet mentions AI workflows on data platforms",
       "evidence_ids": ["exp_1_b2"] }}
  ]
}}
"""


async def classify_and_score_requirements(
    structured_doc: dict,
    jd_description_text: str,
    required_skills: list[str],
    preferred_skills: list[str],
    mode: str = "honest",
) -> dict:
    """
    Call 1 — classification + score, no patches. New function; nothing
    existing calls this yet, so there's no backward-compatibility surface to
    preserve here (unlike generate_resume_patches below).

    required_skills/preferred_skills come from extract_jd_requirements()
    (unchanged). This function assigns them deterministic req_/pref_ ids IN
    PYTHON before the LLM call, so `importance` on the returned
    classification is a prefix check, not a model-reported field. Any
    requirement id the model fails to return is defaulted to "absent" — the
    conservative direction — and logged, rather than silently treated as
    satisfied.

    Returns:
      { requirement_classification: [ {requirement_id, requirement,
          classification, evidence, evidence_ids, importance}, ... ],
        match_score: {percent, label},
        evidence_index: [...] }
    """
    if structured_doc.get("_extraction_confidence") == "low":
        raise HTTPException(
            status_code=422,
            detail="Could not extract enough structure from this resume to optimize it safely. "
                   "Try re-uploading as a text-based PDF.",
        )
    if mode not in ("honest", "aggressive"):
        mode = "honest"

    seen_ids: set = set()
    requirements = (
        [{"id": _slugify(s, "req", seen_ids), "text": s, "importance": "required"} for s in (required_skills or [])]
        + [{"id": _slugify(s, "pref", seen_ids), "text": s, "importance": "preferred"} for s in (preferred_skills or [])]
    )
    evidence_index = build_evidence_index(structured_doc)

    if not requirements:
        # Nothing to classify against — extraction returned nothing, or
        # there was no JD text. Return a valid empty result instead of
        # making an LLM call with nothing to classify.
        return {
            "requirement_classification": [],
            "match_score": score_from_classification([]),
            "evidence_index": evidence_index,
        }

    importance_by_id = {r["id"]: r["importance"] for r in requirements}
    jd_clean = clean_job_description(jd_description_text or "")
    system_prompt = _CLASSIFY_SYSTEM_PROMPT_AGGRESSIVE if mode == "aggressive" else _CLASSIFY_SYSTEM_PROMPT_HONEST
    user_message = _build_classify_user_prompt(evidence_index, requirements, jd_clean)

    result = await _call_llm(system_prompt, user_message)
    raw_classification = result.get("requirement_classification", [])
    if not isinstance(raw_classification, list):
        raw_classification = []

    by_id = {}
    for c in raw_classification:
        if isinstance(c, dict) and c.get("requirement_id") in importance_by_id:
            by_id[c["requirement_id"]] = c
        # else: unknown id (model invented one, or malformed) — ignored
        # rather than trusted; the requirement it was meant to cover still
        # gets classified "absent" below via the omitted-id path.

    classification = []
    for r in requirements:
        c = by_id.get(r["id"])
        if c is None:
            logger.warning(f"[optimizer] classify call omitted {r['id']!r} — defaulting to absent")
        classification.append({
            "requirement_id": r["id"],
            "requirement": r["text"],
            "classification": (c.get("classification") if c else None) or "absent",
            "evidence": str(c.get("evidence", "")) if c else "",
            "evidence_ids": c.get("evidence_ids", []) if c and isinstance(c.get("evidence_ids"), list) else [],
            "importance": r["importance"],   # from OUR list membership — never from the model
        })

    tiers = {}
    for c in classification:
        tiers[c["classification"]] = tiers.get(c["classification"], 0) + 1
    score = score_from_classification(classification)
    n_req = sum(1 for r in requirements if r["importance"] == "required")
    n_pref = sum(1 for r in requirements if r["importance"] == "preferred")
    # Always logged, not just on anomaly — this was the actual gap: nothing
    # printed on a clean run, so a run that behaved correctly and a run that
    # silently classified everything wrong looked identical in the logs.
    logger.info(
        f"[optimizer] classify_and_score: {len(requirements)} requirements "
        f"({n_req} required, {n_pref} preferred) -> tiers={tiers} "
        f"-- score {score['percent']}% ({score['label']})"
    )
    for c in classification:
        logger.debug(
            f"[optimizer]   {c['requirement_id']} [{c['importance']}] {c['classification']!r} "
            f"— {c['evidence'][:120]!r}"
        )

    return {
        "requirement_classification": classification,
        "match_score": score,
        "evidence_index": evidence_index,
    }


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


def _collect_container_ids(doc: dict) -> set[str]:
    """company_id/project_id values — valid add_bullet targets. Separate set
    from _collect_valid_ids() on purpose: a container id is never a valid
    target for insert_phrase/replace_text/rewrite_bullet (those edit text
    that already exists), and a bullet id is never a valid add_bullet target
    (that operation creates a new bullet, it doesn't edit one)."""
    ids = set()
    for exp in doc.get("experience", []):
        if exp.get("company_id"):
            ids.add(exp["company_id"])
    for proj in doc.get("projects", []):
        pid = proj.get("project_id") or proj.get("id")
        if pid:
            ids.add(pid)
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


def _blocked_requirement_ids(classification: list[dict]) -> set:
    return {
        c.get("requirement_id") for c in classification
        if isinstance(c, dict) and c.get("classification") in ("absent", "hallucination_risk")
    }


def _evidence_ids_by_requirement(classification: list[dict]) -> dict:
    """requirement_id -> its own evidence_ids, for the placement check below.
    Only meaningful for insert_phrase/replace_text/rewrite_bullet, where
    target_id is directly comparable to an evidence bullet id — add_bullet's
    target_id is a container (company_id/project_id), a different kind of
    id, so it's excluded from this check rather than compared incorrectly."""
    return {
        c.get("requirement_id"): c.get("evidence_ids") or []
        for c in classification if isinstance(c, dict) and c.get("evidence_ids")
    }


# Matches a capitalized short term in parens, with or without an "e.g."
# marker — "(e.g. CircleCI)" or the pre-fix "(CircleCI)" form (older
# extractions won't have "e.g." yet, and the heuristic still needs to catch
# those). Requires the term to start uppercase so generic parentheticals
# like "(one of)", "(required)", "(3+ years)" don't match.
_ILLUSTRATIVE_TERM_RE = re.compile(r"\((?:e\.g\.?,?\s*)?([A-Z][\w./+\-]{1,30})\)")


def _illustrative_example_terms(classification: list[dict]) -> dict:
    """requirement_id -> the specific example term named in its own
    requirement text, if any. Heuristic regex, not a reliable extractor —
    used only for the non-blocking fabrication-risk warning below, a
    visibility signal rather than a filter."""
    out = {}
    for c in classification:
        if not isinstance(c, dict):
            continue
        m = _ILLUSTRATIVE_TERM_RE.search(c.get("requirement", "") or "")
        if m:
            out[c.get("requirement_id")] = m.group(1)
    return out


def _validate_and_clean_patches(raw_patches, structured_doc: dict, mode: str, blocked_req_ids: set,
                                 evidence_ids_by_req: dict = None,
                                 illustrative_terms_by_req: dict = None) -> list[dict]:
    """
    Shared by both the legacy combined call and the new patch-only call —
    this is the exact validation loop that used to be inline in
    generate_resume_patches(), pulled out unchanged so both paths get
    identical enforcement: target_id must be real, replace_text's `before`
    must be an exact substring, confidence must clear CONFIDENCE_FLOOR, the
    addressed requirement must not be blocked, and rewrite_bullet/add_bullet
    are dropped outright in honest mode even if returned anyway.

    evidence_ids_by_req is NOT a hard filter — a patch that targets a bullet
    other than its requirement's own evidence_ids only gets a warning, not a
    drop. Confirmed against real data that the model doesn't reliably place a
    patch on the bullet that actually earned the classification (both patches
    on a real job landed on the resume's first bullet even though one
    requirement's evidence was a completely different bullet) — annoying for
    read quality, not a fabrication risk, so this stays a visible warning
    rather than discarding an otherwise-legitimate patch over placement.

    illustrative_terms_by_req is ALSO not a hard filter, for a different
    reason: the heuristic that finds these terms (a capitalized word in
    parens on the requirement text) can't reliably tell "the JD's example,
    unevidenced" from "the JD's actual ask, genuinely evidenced under a
    slightly different phrasing" — false positives are real. But confirmed
    against real data that this failure mode is real too: "CircleCI" was
    inserted into an actual resume with zero evidence anywhere, because it
    appeared in the requirement text as an example ("CI/CD tooling
    (CircleCI)") and got treated as claimable. This is a fabrication-risk
    warning, not a placement one — logged loudly, still not blocking, because
    the review step (a human approving the resume) is the real backstop for
    a heuristic this imprecise, not a hard-coded regex.
    """
    evidence_ids_by_req = evidence_ids_by_req or {}
    illustrative_terms_by_req = illustrative_terms_by_req or {}
    evidence_blob = " ".join(e.get("text", "") for e in build_evidence_index(structured_doc)).lower()
    max_patches = _MAX_PATCHES_BY_MODE[mode]
    allowed_ops = ("insert_phrase", "replace_text", "rewrite_bullet", "add_bullet") \
        if mode == "aggressive" else ("insert_phrase", "replace_text")

    valid_ids = _collect_valid_ids(structured_doc)
    container_ids = _collect_container_ids(structured_doc) if mode == "aggressive" else set()
    if not isinstance(raw_patches, list):
        raw_patches = []

    clean_patches = []
    for p in raw_patches[:max_patches * 2]:  # generous pre-filter cap
        if not isinstance(p, dict):
            continue
        op         = p.get("operation")
        target_id  = p.get("target_id")
        confidence = p.get("confidence")
        req_id     = p.get("requirement_id")

        if op not in allowed_ops:
            logger.warning(f"[optimizer] dropped patch — operation {op!r} not allowed in {mode!r} mode")
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

        if op != "add_bullet":
            expected_ids = evidence_ids_by_req.get(req_id)
            if expected_ids and target_id not in expected_ids:
                logger.warning(
                    f"[optimizer] patch for {req_id!r} targets {target_id!r}, but its own "
                    f"evidence_ids were {expected_ids!r} — kept (placement quality issue, "
                    f"not a fabrication risk), but likely landed on the wrong bullet."
                )

        term = illustrative_terms_by_req.get(req_id)
        if term:
            new_text = str(p.get("text") or p.get("after") or "")
            if term.lower() in new_text.lower() and term.lower() not in evidence_blob:
                logger.warning(
                    f"[optimizer] POSSIBLE FABRICATION — patch for {req_id!r} inserts "
                    f"{term!r}, which was only an example in the requirement text and does "
                    f"NOT appear anywhere in the resume's evidence. Kept (this check is a "
                    f"heuristic, not a hard filter — false positives are possible), but this "
                    f"needs a human look before approval, not an automated one."
                )

        if op == "add_bullet":
            if target_id not in container_ids:
                logger.warning(f"[optimizer] dropped add_bullet — unknown container_id {target_id!r}")
                continue
            text = str(p.get("text", "")).strip()
            if not text:
                continue
            clean_patches.append({
                "id":              f"chg_{len(clean_patches)}_{target_id}",
                "operation":       "add_bullet",
                "target_id":       target_id,
                "text":            text,
                "reason":          str(p.get("reason", "")),
                "requirement_id":  req_id,
                "confidence":      confidence,
            })
            if len(clean_patches) >= max_patches:
                break
            continue

        # Every other operation targets a real existing bullet/skill/summary id.
        if target_id not in valid_ids:
            logger.warning(f"[optimizer] dropped patch — unknown target_id {target_id!r}")
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
        elif op == "rewrite_bullet":
            text = str(p.get("text", "")).strip()
            if not text:
                continue
            clean_patches.append({
                "id":              f"chg_{len(clean_patches)}_{target_id}",
                "operation":       "rewrite_bullet",
                "target_id":       target_id,
                "text":            text,
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
        if len(clean_patches) >= max_patches:
            break

    return clean_patches


async def generate_resume_patches(
    structured_doc: dict,
    jd_description_text: str,
    required_skills: list[str],
    preferred_skills: list[str],
    mode: str = "honest",
    precomputed_classification: list[dict] | None = None,
) -> dict:
    """
    Returns: { requirement_classification: [...], patches: [...] }

    `mode` is "honest" or "aggressive" (never "off" — resume_optimize_worker.py
    doesn't call this function at all for "off", see that file). Unrecognized
    values fall back to "honest" — the safer default wins on bad input rather
    than silently getting the more permissive prompt.

    Two paths, chosen by `precomputed_classification`:

    - None (default) — LEGACY, behavior byte-for-byte unchanged from before
      this session. One LLM call does classification AND patch generation
      together. This is what keeps this function's signature and behavior
      identical for any existing caller — routers/apply.py's regenerate-on-
      demand endpoint per this module's docstring — that hasn't been
      reviewed this session and so can't be safely repointed at the new path.
    - a classification list (from classify_and_score_requirements(), Call 1)
      — NEW path. Skips classification entirely, makes one LLM call for
      patches only, informed by the given classification. This is Call 2 of
      the new split pipeline; resume_optimize_worker.py uses this path.

    Patch validation is identical either way — see _validate_and_clean_patches,
    the exact loop this function used to run inline:
      - target_id must exist in the document (a real bullet/skill/summary id
        for insert_phrase/replace_text/rewrite_bullet, a real company_id/
        project_id for add_bullet)
      - replace_text.before must be an exact substring of the target's current text
      - confidence must clear CONFIDENCE_FLOOR
      - classification must NOT be "absent" or "hallucination_risk" for any
        requirement a patch claims to address (belt-and-suspenders — the
        prompt already forbids this, but we don't trust the model blindly)
      - rewrite_bullet/add_bullet are dropped outright in honest mode even if
        the model returns them
    """
    if structured_doc.get("_extraction_confidence") == "low":
        raise HTTPException(
            status_code=422,
            detail="Could not extract enough structure from this resume to optimize it safely. "
                   "Try re-uploading as a text-based PDF.",
        )

    if mode not in ("honest", "aggressive"):
        mode = "honest"

    if precomputed_classification is not None:
        classification = precomputed_classification if isinstance(precomputed_classification, list) else []
        system_prompt = _PATCH_SYSTEM_PROMPT_AGGRESSIVE if mode == "aggressive" else _PATCH_SYSTEM_PROMPT_HONEST
        user_message = _build_patch_user_prompt(
            {k: v for k, v in structured_doc.items() if not k.startswith("_")},
            classification,
            mode=mode,
        )
        result = await _call_llm(system_prompt, user_message)
        raw_patches = result.get("patches", [])
    else:
        system_prompt = _SYSTEM_PROMPT_AGGRESSIVE if mode == "aggressive" else _SYSTEM_PROMPT_HONEST
        user_message = _build_user_prompt(
            {k: v for k, v in structured_doc.items() if not k.startswith("_")},
            jd_description_text or "",
            required_skills or [],
            preferred_skills or [],
            mode=mode,
        )
        result = await _call_llm(system_prompt, user_message)
        classification = result.get("requirement_classification", [])
        if not isinstance(classification, list):
            classification = []
        raw_patches = result.get("patches", [])

    blocked_req_ids = _blocked_requirement_ids(classification)
    evidence_ids_by_req = _evidence_ids_by_requirement(classification)
    illustrative_terms_by_req = _illustrative_example_terms(classification)
    clean_patches = _validate_and_clean_patches(
        raw_patches, structured_doc, mode, blocked_req_ids, evidence_ids_by_req, illustrative_terms_by_req
    )

    n_raw = len(raw_patches) if isinstance(raw_patches, list) else 0
    op_counts = {}
    for p in clean_patches:
        op_counts[p["operation"]] = op_counts.get(p["operation"], 0) + 1
    path = "patch-only (Call 2)" if precomputed_classification is not None else "legacy combined call"
    # Always logged — the individual logger.warning() calls above already
    # explain EACH dropped patch, but there was no single line saying how
    # many survived out of how many the model proposed, so "the model
    # proposed 2 and both passed" and "the model proposed 9 and only 2
    # passed" looked identical unless you scrolled back through every
    # warning and counted by hand.
    logger.info(
        f"[optimizer] generate_resume_patches ({mode}, {path}): "
        f"LLM proposed {n_raw} patch(es) -> {len(clean_patches)} survived validation, ops={op_counts}"
    )

    return {
        "requirement_classification": classification,
        "patches": clean_patches,
    }


def apply_patch_to_text(current_text: str, patch: dict) -> str:
    """
    Deterministically apply a single accepted patch to a target's current text.
    Only for operations that MODIFY an existing target's text — add_bullet
    creates a whole new bullet dict rather than mutating one, so it's handled
    separately at the document-assembly level (see resume_renderer.py's
    build_final_document(), which mirrors this function for the other three).
    """
    if patch["operation"] == "replace_text":
        return current_text.replace(patch["before"], patch["after"], 1)
    if patch["operation"] == "rewrite_bullet":
        return patch["text"]
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
