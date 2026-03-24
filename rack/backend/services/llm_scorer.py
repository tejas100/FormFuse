"""
llm_scorer.py — Phase 2 LLM Deep Scorer for RACK.

Architecture:
  Phase 1 (existing): FAISS + hybrid scorer → shortlist (job × resume) pairs above threshold
  Phase 2 (this file): LLM holistic scorer → re-rank shortlist with full reasoning

Design decisions:
  - One LLM call per (job × resume) pair — NOT per skill  [Home page path]
  - One LLM call per job with ALL qualifying resumes bundled — [Auto Matches path]
  - Condensed context: signal-dense JD summary + resume summary (~1200 tokens per call)
  - Structured JSON response: score + 3 components + reasoning + recommendation
  - Hybrid score passed as context anchor to reduce LLM score hallucination
  - Concurrent calls with semaphore (max 8 at a time) for speed
  - Graceful fallback: if LLM call fails, hybrid score is kept as-is

Auto Matches grouped scorer (llm_score_jobs_grouped):
  - Receives a dict of { job_id → [resume_entry, ...] } instead of flat pairs list
  - Fires ONE LLM call per job containing all qualifying resumes in a single prompt
  - GPT scores each resume independently and returns a JSON array
  - Result: N jobs × M resumes = N API calls (not N×M)
  - Falls back to hybrid_only per resume if the call fails or parse errors

Output fields added to each match entry:
  llm_score          int 0-100   — primary display score
  llm_components     dict        — skills_fit, experience_fit, trajectory_fit (0-100 each)
  llm_reasoning      str         — 2-3 sentence holistic explanation
  llm_recommendation str         — "Strong Match" | "Good Match" | "Partial Match" | "Weak Match"
  llm_key_strengths  list[str]   — 2-3 bullet strengths
  llm_key_gaps       list[str]   — 1-2 bullet gaps
  hybrid_score       int         — original Phase 1 score (kept for reference)
  scoring_method     str         — "llm+hybrid" | "hybrid_only"
"""

import asyncio
import json
import logging
import os
import re
from typing import Dict, List, Optional, Tuple

import httpx

logger = logging.getLogger(__name__)

# ── Concurrency control ─────────────────────────────────────────────
LLM_CONCURRENCY = 8       # max parallel LLM calls
LLM_TIMEOUT     = 20.0    # seconds per call
LLM_MODEL       = "gpt-4o-mini"

# ── Phase 2 threshold — only pairs above this go to LLM ────────────
PHASE2_THRESHOLD = 40     # hybrid score % — keep in sync with auto_match.py
                          # At 45%: ~2500 pairs on first run (too many)
                          # At 55%: ~30-80 pairs (fast + affordable)


# ═══════════════════════════════════════════════════════════════════
# CONTEXT BUILDERS — condense JD + resume into signal-dense summaries
# ═══════════════════════════════════════════════════════════════════

def _build_jd_summary(job: Dict, parsed_jd: Dict) -> str:
    """
    Build a condensed JD summary for the LLM prompt.
    Focuses on signal: title, company, requirements, key responsibilities.
    Target: ~300 tokens.
    """
    parts = []

    title = job.get("job_title") or job.get("title") or parsed_jd.get("title", "Unknown Role")
    company = job.get("company", "")
    parts.append(f"ROLE: {title} at {company}")

    if parsed_jd.get("min_years"):
        parts.append(f"EXPERIENCE REQUIRED: {parsed_jd['min_years']}+ years")

    req_skills = parsed_jd.get("required_skills", [])
    if req_skills:
        parts.append(f"REQUIRED SKILLS: {', '.join(req_skills[:15])}")

    pref_skills = parsed_jd.get("preferred_skills", [])
    if pref_skills:
        parts.append(f"PREFERRED SKILLS: {', '.join(pref_skills[:8])}")

    domains = parsed_jd.get("domains", [])
    if domains:
        parts.append(f"DOMAINS: {', '.join(domains)}")

    # Pull key sentences from raw JD description (first 600 chars of requirements section)
    raw_desc = job.get("description_text", "")
    if raw_desc:
        # Extract the most signal-dense part — first 500 chars after stripping boilerplate
        condensed = _extract_key_sentences(raw_desc, max_chars=500)
        if condensed:
            parts.append(f"KEY REQUIREMENTS EXCERPT:\n{condensed}")

    return "\n".join(parts)
# ─────────────────────────────────────────────────────────────────
# Patch for build resume
# ─────────────────────────────────────────────────────────────────
 
def _build_resume_summary(resume: Dict) -> str:
    """
    Build a resume summary for the LLM prompt.
 
    Priority order:
      1. full_text — the complete cleaned resume text stored at upload time.
         This is the gold path: the LLM sees everything a recruiter would see.
         Capped at 3000 chars in the prompt to keep token budget reasonable
         (~750 tokens), but that covers any single-page resume completely.
 
      2. Fallback (full_text is None — resume uploaded before Session 19 migration):
         Reconstruct a structured summary from metadata fields. This is the
         old behavior — less accurate but still functional.
 
    The full_text path is expected to be the norm after users re-upload their
    resumes post-migration. The fallback exists so old resumes don't break.
    """
    parts = []
    structured = resume.get("structured", {})
    name = resume.get("name", "Candidate")
    parts.append(f"CANDIDATE: {name}")
 
    # ── Always include metadata header regardless of path ─────────────────────
    years = structured.get("years_exp")
    if years:
        parts.append(f"EXPERIENCE: {years} years")
 
    titles = structured.get("titles", [])
    if titles:
        parts.append(f"ROLES HELD: {', '.join(titles[:4])}")
 
    companies = structured.get("companies", [])
    if companies:
        parts.append(f"COMPANIES: {', '.join(companies[:4])}")
 
    skills = structured.get("skills", [])
    if skills:
        parts.append(f"SKILLS: {', '.join(skills[:25])}")
 
    domains = structured.get("domains", [])
    if domains:
        parts.append(f"DOMAINS: {', '.join(domains)}")
 
    education = structured.get("education", [])
    if education:
        edu_strs = []
        for e in education[:2]:
            degree = e.get("degree", "")
            field = e.get("field", "")
            inst = e.get("institution", "")
            edu_strs.append(" ".join(filter(None, [degree, field, f"@ {inst}" if inst else ""])))
        if edu_strs:
            parts.append(f"EDUCATION: {'; '.join(edu_strs)}")
 
    # ── Path 1: full_text available (post-migration upload) ───────────────────
    full_text = resume.get("full_text")
    if full_text and full_text.strip():
        # Cap at 3000 chars — ~750 tokens, covers any 1-page resume fully,
        # most of a 2-pager. Truncate at a newline boundary when possible.
        cap = 3000
        if len(full_text) > cap:
            truncated = full_text[:cap]
            last_newline = truncated.rfind("\n")
            if last_newline > cap * 0.85:
                truncated = truncated[:last_newline]
            full_text_excerpt = truncated
        else:
            full_text_excerpt = full_text
        parts.append(f"FULL RESUME TEXT:\n{full_text_excerpt}")
        return "\n".join(parts)
 
    # ── Path 2: fallback — no full_text (pre-migration resume) ────────────────
    # Attempt to reconstruct from chunks. The section == "experience" filter
    # was unreliable (section not stored in DB), so we take any chunks available.
    chunks = resume.get("chunks", [])
    if chunks:
        # Sort by chunk_index if available, otherwise take as-is
        sorted_chunks = sorted(chunks, key=lambda c: c.get("chunk_index", 0))
        # Take up to 6 chunks, 250 chars each — approximates the top third
        # of resume content without the section filter that previously returned zero
        excerpt_parts = []
        for c in sorted_chunks[:6]:
            text = c.get("text", "").strip()
            if text:
                excerpt_parts.append(text[:250])
        if excerpt_parts:
            parts.append(f"EXPERIENCE EXCERPTS (partial — re-upload resume for full scoring):\n"
                         + " | ".join(excerpt_parts))
 
    return "\n".join(parts)
 
 
# ─────────────────────────────────────────────────────────────────
# END OF PATCH
#

def _extract_key_sentences(text: str, max_chars: int = 500) -> str:
    """Extract the most signal-dense part of a JD description."""
    # Find requirements-like section
    markers = ["requirements", "qualifications", "what you", "looking for", "you have", "you'll need"]
    text_lower = text.lower()

    best_start = 0
    for marker in markers:
        idx = text_lower.find(marker)
        if idx != -1:
            best_start = idx
            break

    excerpt = text[best_start:best_start + max_chars]
    # Clean up whitespace
    excerpt = re.sub(r'\s+', ' ', excerpt).strip()
    return excerpt


# ═══════════════════════════════════════════════════════════════════
# LLM PROMPT
# ═══════════════════════════════════════════════════════════════════

_SCORER_SYSTEM_PROMPT = """You are an expert technical recruiter scoring resume-to-job fit.

You will receive a job description summary and a candidate resume summary.
Score the match honestly and specifically.

SCORING RUBRIC:
- 85-100: Exceptional fit — candidate has almost everything, including domain-specific depth
- 70-84:  Strong fit — most requirements met, minor gaps only
- 55-69:  Good fit — core skills present, some meaningful gaps
- 40-54:  Partial fit — foundational match but significant gaps
- 0-39:   Weak fit — missing too many critical requirements

COMPONENT SCORES (each 0-100):
- skills_fit: How well do the candidate's technical skills match the JD requirements?
- experience_fit: Is the seniority, domain, and years of experience appropriate?
- trajectory_fit: Does the candidate's career trajectory point toward this role?

RULES:
1. Be honest and specific — vague high scores help nobody
2. A candidate with adjacent skills but missing core domain knowledge should score 45-60, not 75
3. Consider career trajectory — a backend engineer applying to ML roles needs evidence of ML work
4. Key strengths and gaps must be SPECIFIC (name actual skills/experiences, not generic phrases)
5. Recommendation must match the score range

Return ONLY valid JSON (no markdown, no backticks):
{
  "llm_score": 72,
  "components": {
    "skills_fit": 80,
    "experience_fit": 70,
    "trajectory_fit": 65
  },
  "reasoning": "2-3 sentence holistic explanation of the match. Be specific about what aligns and what doesn't.",
  "recommendation": "Good Match",
  "key_strengths": [
    "Specific strength 1 with evidence from resume",
    "Specific strength 2"
  ],
  "key_gaps": [
    "Specific gap 1 — what's missing and why it matters for this role",
    "Specific gap 2 (if any)"
  ]
}"""


# ═══════════════════════════════════════════════════════════════════
# SINGLE PAIR SCORER
# ═══════════════════════════════════════════════════════════════════

async def _score_single_pair(
    job: Dict,
    resume: Dict,
    parsed_jd: Dict,
    hybrid_score: int,
    client: httpx.AsyncClient,
    semaphore: asyncio.Semaphore,
) -> Optional[Dict]:
    """
    Score a single (job × resume) pair with the LLM.
    Returns the LLM result dict, or None if the call failed.
    """
    async with semaphore:
        jd_summary = _build_jd_summary(job, parsed_jd)
        resume_summary = _build_resume_summary(resume)

        user_message = f"""INITIAL HYBRID SCORE (keyword/semantic match): {hybrid_score}%
Use this as a rough anchor — your holistic assessment may differ.

JOB DESCRIPTION:
{jd_summary}

---

CANDIDATE RESUME:
{resume_summary}

Score this match."""

        try:
            api_key = os.environ.get("OPENAI_API_KEY")
            if not api_key:
                return None

            response = await client.post(
                "https://api.openai.com/v1/chat/completions",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": LLM_MODEL,
                    "messages": [
                        {"role": "system", "content": _SCORER_SYSTEM_PROMPT},
                        {"role": "user", "content": user_message},
                    ],
                    "temperature": 0.1,
                    "max_tokens": 600,
                },
                timeout=LLM_TIMEOUT,
            )

            if response.status_code != 200:
                logger.warning(f"[LLMScorer] API {response.status_code} for {resume.get('name')} × {job.get('job_title')}")
                return None

            content = response.json()["choices"][0]["message"]["content"].strip()
            content = re.sub(r'^```(?:json)?\s*', '', content)
            content = re.sub(r'\s*```$', '', content)

            result = json.loads(content)

            # Validate required fields
            if "llm_score" not in result:
                return None

            # Clamp score to 0-100
            result["llm_score"] = max(0, min(100, int(result["llm_score"])))

            # Clamp component scores
            components = result.get("components", {})
            for key in ["skills_fit", "experience_fit", "trajectory_fit"]:
                if key in components:
                    components[key] = max(0, min(100, int(components[key])))

            logger.info(
                f"[LLMScorer] {resume.get('name')} × {job.get('job_title', job.get('title'))}: "
                f"hybrid={hybrid_score} → llm={result['llm_score']} ({result.get('recommendation', '?')})"
            )
            return result

        except json.JSONDecodeError as e:
            logger.warning(f"[LLMScorer] Invalid JSON response: {e}")
            return None
        except Exception as e:
            logger.warning(f"[LLMScorer] Call failed for {resume.get('name')}: {e}")
            return None


# ═══════════════════════════════════════════════════════════════════
# BATCH SCORER — processes all (job × resume) pairs concurrently
# ═══════════════════════════════════════════════════════════════════

async def llm_score_batch(
    pairs: List[Dict],
) -> List[Dict]:
    """
    Run LLM deep scoring on a batch of (job × resume) pairs.

    Each pair dict must contain:
      - job:          normalized job dict (from auto_match or watchlist)
      - resume:       full resume dict (from get_resume_by_id)
      - parsed_jd:    already-parsed JD dict
      - hybrid_score: int — Phase 1 hybrid score (0-100)
      - (all other fields from the match entry — passed through unchanged)

    Returns the same list with LLM fields added to each entry.
    Pairs where LLM fails keep their hybrid score and get scoring_method="hybrid_only".
    """
    if not pairs:
        return []

    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        logger.warning("[LLMScorer] No OPENAI_API_KEY — skipping Phase 2, using hybrid scores")
        for pair in pairs:
            pair["scoring_method"] = "hybrid_only"
            pair["llm_score"] = pair.get("hybrid_score", pair.get("score", 0))
        return pairs

    semaphore = asyncio.Semaphore(LLM_CONCURRENCY)

    async with httpx.AsyncClient() as client:
        tasks = []
        for pair in pairs:
            task = _score_single_pair(
                job=pair["job"],
                resume=pair["resume"],
                parsed_jd=pair["parsed_jd"],
                hybrid_score=pair.get("hybrid_score", 0),
                client=client,
                semaphore=semaphore,
            )
            tasks.append(task)

        results = await asyncio.gather(*tasks, return_exceptions=True)

    # Merge LLM results back into pairs
    enriched = []
    llm_success = 0
    llm_failed = 0

    for pair, llm_result in zip(pairs, results):
        entry = {k: v for k, v in pair.items() if k not in ("job", "resume", "parsed_jd")}

        if isinstance(llm_result, Exception) or llm_result is None:
            # LLM failed — keep hybrid score
            entry["llm_score"] = entry.get("hybrid_score", entry.get("score", 0))
            entry["llm_components"] = {}
            entry["llm_reasoning"] = ""
            entry["llm_recommendation"] = _score_to_recommendation(entry["llm_score"])
            entry["llm_key_strengths"] = []
            entry["llm_key_gaps"] = []
            entry["scoring_method"] = "hybrid_only"
            llm_failed += 1
        else:
            entry["llm_score"] = llm_result.get("llm_score", entry.get("hybrid_score", 0))
            entry["llm_components"] = llm_result.get("components", {})
            entry["llm_reasoning"] = llm_result.get("reasoning", "")
            entry["llm_recommendation"] = llm_result.get("recommendation", _score_to_recommendation(entry["llm_score"]))
            entry["llm_key_strengths"] = llm_result.get("key_strengths", [])
            entry["llm_key_gaps"] = llm_result.get("key_gaps", [])
            entry["scoring_method"] = "llm+hybrid"
            llm_success += 1

        enriched.append(entry)

    logger.info(f"[LLMScorer] Batch complete: {llm_success} LLM scored, {llm_failed} hybrid fallback")
    return enriched


# ═══════════════════════════════════════════════════════════════════
# PIPELINE INTEGRATION HELPERS
# ═══════════════════════════════════════════════════════════════════

def build_pairs_from_matches(
    matches: List[Dict],
    resume_lookup: Dict[str, Dict],
    parsed_jd_lookup: Dict[str, Dict],
    threshold: int = PHASE2_THRESHOLD,
) -> Tuple[List[Dict], List[Dict]]:
    """
    From a list of hybrid-scored match entries, build (job × resume) pairs
    for Phase 2 LLM scoring.

    Only includes pairs where hybrid_score >= threshold.
    Pairs below threshold are returned separately (they skip Phase 2).

    Args:
        matches:          list of match entries from hybrid scorer
        resume_lookup:    dict of resume_id → full resume dict
        parsed_jd_lookup: dict of job_id → parsed_jd dict
        threshold:        minimum hybrid score to qualify for Phase 2

    Returns:
        (pairs_for_llm, pairs_below_threshold)
    """
    pairs_for_llm = []
    pairs_below = []

    for match in matches:
        hybrid_score = match.get("score", match.get("raw_score", 0))
        # Normalize to 0-100 int
        if isinstance(hybrid_score, float) and hybrid_score <= 1.0:
            hybrid_score = round(hybrid_score * 100)
        else:
            hybrid_score = int(hybrid_score)

        resume_id = match.get("resume_id", "")
        resume = resume_lookup.get(resume_id)
        job_id = match.get("job_id", "")
        parsed_jd = parsed_jd_lookup.get(job_id, {})

        if resume is None:
            pairs_below.append({**match, "hybrid_score": hybrid_score, "scoring_method": "hybrid_only", "llm_score": hybrid_score})
            continue

        pair = {
            **match,
            "hybrid_score": hybrid_score,
            "job": match,          # job context lives in the match entry itself
            "resume": resume,
            "parsed_jd": parsed_jd,
        }

        if hybrid_score >= threshold:
            pairs_for_llm.append(pair)
        else:
            pairs_below.append({
                **match,
                "hybrid_score": hybrid_score,
                "llm_score": hybrid_score,
                "llm_components": {},
                "llm_reasoning": "",
                "llm_recommendation": _score_to_recommendation(hybrid_score),
                "llm_key_strengths": [],
                "llm_key_gaps": [],
                "scoring_method": "hybrid_only",
            })

    return pairs_for_llm, pairs_below


def _score_to_recommendation(score: int) -> str:
    """Map a score to a recommendation label."""
    if score >= 85:
        return "Strong Match"
    elif score >= 70:
        return "Good Match"
    elif score >= 55:
        return "Partial Match"
    else:
        return "Weak Match"


def rerank_by_llm_score(entries: List[Dict]) -> List[Dict]:
    """Sort entries by llm_score descending, then hybrid_score as tiebreaker."""
    return sorted(
        entries,
        key=lambda x: (x.get("llm_score", 0), x.get("hybrid_score", 0)),
        reverse=True,
    )


# ═══════════════════════════════════════════════════════════════════
# GROUPED SCORER — one LLM call per job, all resumes bundled
# Used by Auto Matches pipeline only. Home page uses llm_score_batch.
# ═══════════════════════════════════════════════════════════════════

_GROUPED_SCORER_SYSTEM_PROMPT = """You are an expert technical recruiter scoring candidate resumes against a job description.

You will receive one job description and a numbered list of candidate resumes.
Score EACH resume independently against the job — do not rank them relative to each other.
A strong resume should score high even if all other resumes are weak, and vice versa.

SCORING RUBRIC:
- 85-100: Exceptional fit — candidate has almost everything, including domain-specific depth
- 70-84:  Strong fit — most requirements met, minor gaps only
- 55-69:  Good fit — core skills present, some meaningful gaps
- 40-54:  Partial fit — foundational match but significant gaps
- 0-39:   Weak fit — missing too many critical requirements

COMPONENT SCORES (each 0-100):
- skills_fit: How well do the candidate's technical skills match the JD requirements?
- experience_fit: Is the seniority, domain, and years of experience appropriate?
- trajectory_fit: Does the candidate's career trajectory point toward this role?

RULES:
1. Score each resume independently — treat each as if it were the only one
2. Be honest and specific — vague high scores help nobody
3. Key strengths and gaps must be SPECIFIC (name actual skills/experiences)
4. Recommendation must match the score range

Return ONLY a valid JSON array — one object per resume, in the same order as input.
No markdown, no backticks, no preamble. Example for 2 resumes:
[
  {
    "resume_index": 0,
    "llm_score": 82,
    "components": { "skills_fit": 85, "experience_fit": 80, "trajectory_fit": 78 },
    "reasoning": "Specific 2-3 sentence explanation of fit.",
    "recommendation": "Good Match",
    "key_strengths": ["Strength 1 with evidence", "Strength 2"],
    "key_gaps": ["Gap 1 — why it matters", "Gap 2 if any"]
  },
  {
    "resume_index": 1,
    "llm_score": 61,
    ...
  }
]"""


async def _score_job_multi_resume(
    job_id: str,
    job: Dict,
    resume_entries: List[Dict],
    client: httpx.AsyncClient,
    semaphore: asyncio.Semaphore,
) -> List[Dict]:
    """
    Score one job against all its qualifying resumes in a single LLM call.

    Args:
        job_id:         The job's ID (for logging)
        job:            Full job dict (has job_title, description_text, company, etc.)
        resume_entries: List of phase1 pair entries for this job — each has
                        "resume", "parsed_jd", "hybrid_score", and all job/resume metadata
        client:         Shared httpx client
        semaphore:      Concurrency limiter

    Returns:
        List of enriched pair entries (same as input but with llm_* fields added).
        On failure, all entries get scoring_method="hybrid_only".
    """
    async with semaphore:
        # Build the JD summary once (shared across all resumes for this job)
        parsed_jd = resume_entries[0].get("parsed_jd", {})
        jd_summary = _build_jd_summary(job, parsed_jd)

        # Build resume summaries — numbered so GPT can reference by index
        resume_blocks = []
        for i, entry in enumerate(resume_entries):
            resume_summary = _build_resume_summary(entry["resume"])
            hybrid = entry.get("hybrid_score", 0)
            resume_blocks.append(
                f"CANDIDATE {i} (initial hybrid score: {hybrid}%):\n{resume_summary}"
            )

        resumes_text = "\n\n---\n\n".join(resume_blocks)

        user_message = (
            f"JOB DESCRIPTION:\n{jd_summary}\n\n"
            f"{'=' * 60}\n\n"
            f"CANDIDATES TO SCORE ({len(resume_entries)} total):\n\n"
            f"{resumes_text}\n\n"
            f"Score each candidate independently against this job. "
            f"Return a JSON array with {len(resume_entries)} entries."
        )

        try:
            api_key = os.environ.get("OPENAI_API_KEY")
            if not api_key:
                raise ValueError("No OPENAI_API_KEY")

            response = await client.post(
                "https://api.openai.com/v1/chat/completions",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": LLM_MODEL,
                    "messages": [
                        {"role": "system", "content": _GROUPED_SCORER_SYSTEM_PROMPT},
                        {"role": "user", "content": user_message},
                    ],
                    "temperature": 0.1,
                    # ~600 tokens per resume + overhead — scale with resume count
                    "max_tokens": 600 * len(resume_entries) + 200,
                },
                timeout=LLM_TIMEOUT + (5 * len(resume_entries)),  # extra time per resume
            )

            if response.status_code != 200:
                logger.warning(
                    f"[LLMScorer][grouped] API {response.status_code} for job {job_id}"
                )
                raise ValueError(f"API error {response.status_code}")

            content = response.json()["choices"][0]["message"]["content"].strip()
            content = re.sub(r'^```(?:json)?\s*', '', content)
            content = re.sub(r'\s*```$', '', content)

            scored_list = json.loads(content)

            if not isinstance(scored_list, list):
                raise ValueError("Response is not a JSON array")

            # Build a lookup by resume_index for safe merging
            scores_by_index = {}
            for item in scored_list:
                idx = item.get("resume_index")
                if idx is not None and 0 <= idx < len(resume_entries):
                    scores_by_index[idx] = item

            # Merge LLM results back into the entry dicts
            enriched = []
            for i, entry in enumerate(resume_entries):
                # Strip internal-only keys before building the output entry
                base = {k: v for k, v in entry.items() if k not in ("job", "resume", "parsed_jd")}

                llm_result = scores_by_index.get(i)
                if llm_result is None:
                    # GPT didn't return a score for this index — fall back
                    logger.warning(
                        f"[LLMScorer][grouped] Missing score for index {i} in job {job_id}"
                    )
                    base["llm_score"] = base.get("hybrid_score", 0)
                    base["llm_components"] = {}
                    base["llm_reasoning"] = ""
                    base["llm_recommendation"] = _score_to_recommendation(base["llm_score"])
                    base["llm_key_strengths"] = []
                    base["llm_key_gaps"] = []
                    base["scoring_method"] = "hybrid_only"
                else:
                    score = max(0, min(100, int(llm_result.get("llm_score", 0))))
                    components = llm_result.get("components", {})
                    for key in ["skills_fit", "experience_fit", "trajectory_fit"]:
                        if key in components:
                            components[key] = max(0, min(100, int(components[key])))

                    base["llm_score"] = score
                    base["llm_components"] = components
                    base["llm_reasoning"] = llm_result.get("reasoning", "")
                    base["llm_recommendation"] = llm_result.get(
                        "recommendation", _score_to_recommendation(score)
                    )
                    base["llm_key_strengths"] = llm_result.get("key_strengths", [])
                    base["llm_key_gaps"] = llm_result.get("key_gaps", [])
                    base["scoring_method"] = "llm+hybrid"

                    logger.info(
                        f"[LLMScorer][grouped] {base.get('resume_name')} × "
                        f"{job.get('title', job_id)}: "
                        f"hybrid={base.get('hybrid_score')} → llm={score} "
                        f"({base['llm_recommendation']})"
                    )

                enriched.append(base)

            return enriched

        except (json.JSONDecodeError, ValueError) as e:
            logger.warning(f"[LLMScorer][grouped] Parse/call failed for job {job_id}: {e}")
        except Exception as e:
            logger.warning(f"[LLMScorer][grouped] Unexpected error for job {job_id}: {e}")

    # Fallback — return all entries with hybrid scores
    fallback = []
    for entry in resume_entries:
        base = {k: v for k, v in entry.items() if k not in ("job", "resume", "parsed_jd")}
        base["llm_score"] = base.get("hybrid_score", 0)
        base["llm_components"] = {}
        base["llm_reasoning"] = ""
        base["llm_recommendation"] = _score_to_recommendation(base["llm_score"])
        base["llm_key_strengths"] = []
        base["llm_key_gaps"] = []
        base["scoring_method"] = "hybrid_only"
        fallback.append(base)
    return fallback


async def llm_score_jobs_grouped(
    phase1_groups: Dict[str, List[Dict]],
) -> Dict[str, List[Dict]]:
    """
    Auto Matches Phase 2: score all jobs concurrently, each job's resumes in one LLM call.

    Args:
        phase1_groups: { job_id → [pair_entry, ...] }
                       Each pair_entry must have: "job", "resume", "parsed_jd",
                       "hybrid_score", and all job/resume metadata fields.

    Returns:
        { job_id → [enriched_pair_entry, ...] }
        Each entry has llm_score, llm_components, llm_reasoning, etc. added.
        Entries where LLM failed get scoring_method="hybrid_only".
    """
    if not phase1_groups:
        return {}

    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        logger.warning("[LLMScorer][grouped] No OPENAI_API_KEY — returning hybrid scores")
        result = {}
        for job_id, entries in phase1_groups.items():
            fallback = []
            for entry in entries:
                base = {k: v for k, v in entry.items() if k not in ("job", "resume", "parsed_jd")}
                base["llm_score"] = base.get("hybrid_score", 0)
                base["llm_components"] = {}
                base["llm_reasoning"] = ""
                base["llm_recommendation"] = _score_to_recommendation(base["llm_score"])
                base["llm_key_strengths"] = []
                base["llm_key_gaps"] = []
                base["scoring_method"] = "hybrid_only"
                fallback.append(base)
            result[job_id] = fallback
        return result

    total_jobs = len(phase1_groups)
    total_resumes = sum(len(v) for v in phase1_groups.values())
    logger.info(
        f"[LLMScorer][grouped] Scoring {total_jobs} jobs × "
        f"{total_resumes} resume pairs → {total_jobs} LLM calls"
    )

    semaphore = asyncio.Semaphore(LLM_CONCURRENCY)

    async with httpx.AsyncClient() as client:
        tasks = {}
        for job_id, entries in phase1_groups.items():
            # The job dict lives inside each entry — grab from first entry
            job = entries[0].get("job", {})
            tasks[job_id] = asyncio.create_task(
                _score_job_multi_resume(job_id, job, entries, client, semaphore)
            )

        job_ids = list(tasks.keys())
        results_list = await asyncio.gather(*tasks.values(), return_exceptions=True)

    enriched_groups: Dict[str, List[Dict]] = {}
    llm_success = 0
    llm_failed = 0

    for job_id, result in zip(job_ids, results_list):
        if isinstance(result, Exception):
            logger.warning(f"[LLMScorer][grouped] Task exception for {job_id}: {result}")
            # Fall back to hybrid for all entries in this job
            entries = phase1_groups[job_id]
            fallback = []
            for entry in entries:
                base = {k: v for k, v in entry.items() if k not in ("job", "resume", "parsed_jd")}
                base["llm_score"] = base.get("hybrid_score", 0)
                base["llm_components"] = {}
                base["llm_reasoning"] = ""
                base["llm_recommendation"] = _score_to_recommendation(base["llm_score"])
                base["llm_key_strengths"] = []
                base["llm_key_gaps"] = []
                base["scoring_method"] = "hybrid_only"
                fallback.append(base)
            enriched_groups[job_id] = fallback
            llm_failed += 1
        else:
            enriched_groups[job_id] = result
            if any(e.get("scoring_method") == "llm+hybrid" for e in result):
                llm_success += 1
            else:
                llm_failed += 1

    logger.info(
        f"[LLMScorer][grouped] Complete: {llm_success} jobs LLM-scored, "
        f"{llm_failed} hybrid fallback"
    )
    return enriched_groups