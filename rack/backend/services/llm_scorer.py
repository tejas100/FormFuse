"""
llm_scorer.py — Phase 2 LLM Deep Scorer for RACK.

Architecture:
  Phase 1 (existing): FAISS + hybrid scorer → shortlist (job × resume) pairs above threshold
  Phase 2 (this file): LLM holistic scorer → re-rank shortlist with full reasoning

Design decisions:
  - One LLM call per (job × resume) pair — NOT per skill
  - Condensed context: signal-dense JD summary + resume summary (~1200 tokens per call)
  - Structured JSON response: score + 3 components + reasoning + recommendation
  - Hybrid score passed as context anchor to reduce LLM score hallucination
  - Concurrent calls with semaphore (max 8 at a time) for speed
  - Graceful fallback: if LLM call fails, hybrid score is kept as-is

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
PHASE2_THRESHOLD = 75     # hybrid score % — keep in sync with auto_match.py
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


def _build_resume_summary(resume: Dict) -> str:
    """
    Build a condensed resume summary for the LLM prompt.
    Focuses on: titles, years, skills, top experience excerpts.
    Target: ~400 tokens.
    """
    parts = []
    structured = resume.get("structured", {})

    name = resume.get("name", "Candidate")
    parts.append(f"CANDIDATE: {name}")

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

    # Add 2-3 most relevant experience chunks (from resume chunks)
    chunks = resume.get("chunks", [])
    exp_chunks = [c for c in chunks if c.get("section") == "experience"][:3]
    if exp_chunks:
        excerpt = " | ".join(c["text"][:200] for c in exp_chunks)
        parts.append(f"EXPERIENCE EXCERPTS:\n{excerpt[:600]}")

    return "\n".join(parts)


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