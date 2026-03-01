"""
gap_analyzer.py
Analyzes gaps between JD requirements and resume capabilities.

Three layers (matching the project's hybrid architecture):
  Pass 1: Canonical set intersection — fast, deterministic
  Pass 2: Text-based fallback — catches literal mentions regex missed
  Pass 3: LLM semantic matching — understands conceptual equivalence
  Layer 2: LLM context — adds actionable advice for each gap (optional)

Uses same 3-pass matching as hybrid_scorer to ensure gap display
is consistent with the score calculation.
"""

import os
import re
import json
import logging
from typing import Dict, List, Optional

logger = logging.getLogger(__name__)

# Import LLM Pass 3 from hybrid_scorer (single source of truth)
from services.hybrid_scorer import _llm_skill_match


# ═══════════════════════════════════════════════════════════════════
# TEXT-BASED SKILL MATCHING (shared logic with hybrid_scorer)
# ═══════════════════════════════════════════════════════════════════

def _skill_in_text(skill: str, text: str) -> bool:
    """Check if a skill concept appears in text (handles variations)."""
    skill_lower = skill.lower().strip()
    
    if skill_lower in text:
        return True
    
    dehyphenated = skill_lower.replace("-", " ")
    if dehyphenated != skill_lower and dehyphenated in text:
        return True
    
    collapsed = skill_lower.replace("-", "").replace(" ", "")
    if len(collapsed) > 3:
        pattern = r'\b' + re.escape(collapsed) + r'\b'
        if re.search(pattern, text.replace("-", "").replace(" ", "")):
            return True
    
    if len(skill_lower) <= 4:
        pattern = r'\b' + re.escape(skill_lower) + r'\b'
        if re.search(pattern, text):
            return True
    
    words = re.split(r'[\s\-]+', skill_lower)
    significant_words = [w for w in words if len(w) > 2 and w not in {"and", "the", "for", "with", "end"}]
    if len(significant_words) >= 2:
        matches = sum(1 for w in significant_words if w in text)
        if matches >= len(significant_words) * 0.7:
            return True
    
    return False


def _build_resume_text(resume_structured: Dict, resume_chunks: List[Dict] = None) -> str:
    """Build searchable text from resume data."""
    parts = []
    if resume_chunks:
        for chunk in resume_chunks:
            parts.append(chunk.get("text", ""))
    for skill in resume_structured.get("skills", []):
        parts.append(skill)
    for title in resume_structured.get("titles", []):
        parts.append(title)
    return " ".join(parts).lower()


# ═══════════════════════════════════════════════════════════════════
# LAYER 1: DETERMINISTIC GAP ANALYSIS
# ═══════════════════════════════════════════════════════════════════

def analyze_gaps(
    parsed_jd: Dict,
    resume_structured: Dict,
    resume_chunks: List[Dict] = None,
    use_llm: bool = True,
) -> Dict:
    """
    Compute skill gaps between JD and resume.
    Uses 3-pass matching: canonical → text fallback → LLM semantic.
    """
    resume_skills = set(s.lower() for s in resume_structured.get("skills", []))
    jd_required = set(s.lower() for s in parsed_jd.get("required_skills", []))
    jd_preferred = set(s.lower() for s in parsed_jd.get("preferred_skills", []))

    # Pass 1: Canonical matching
    missing_required = jd_required - resume_skills
    missing_preferred = jd_preferred - resume_skills

    # Pass 2: Text-based fallback for still-missing skills
    resume_text = _build_resume_text(resume_structured, resume_chunks)
    
    text_matched_req = set()
    for skill in list(missing_required):
        if _skill_in_text(skill, resume_text):
            text_matched_req.add(skill)
    missing_required -= text_matched_req

    text_matched_pref = set()
    for skill in list(missing_preferred):
        if _skill_in_text(skill, resume_text):
            text_matched_pref.add(skill)
    missing_preferred -= text_matched_pref

    # Pass 3: LLM semantic matching for remaining unmatched skills
    if use_llm and (missing_required or missing_preferred):
        all_unmatched = missing_required | missing_preferred
        llm_matched = _llm_skill_match(
            unmatched_skills=all_unmatched,
            resume_text=resume_text,
            resume_skills=list(resume_structured.get("skills", [])),
        )
        missing_required -= llm_matched
        missing_preferred -= llm_matched

    # Coverage rates
    req_total = len(jd_required)
    pref_total = len(jd_preferred)
    req_coverage = 1.0 - (len(missing_required) / req_total) if req_total > 0 else 1.0
    pref_coverage = 1.0 - (len(missing_preferred) / pref_total) if pref_total > 0 else 1.0
    total_jd = req_total + pref_total
    total_missing = len(missing_required) + len(missing_preferred)
    overall_coverage = 1.0 - (total_missing / total_jd) if total_jd > 0 else 1.0

    # Critical gaps
    critical_gaps = _identify_critical_gaps(
        missing_required, parsed_jd.get("title", ""), parsed_jd.get("domains", [])
    )

    # Experience gaps
    experience_gaps = _experience_gaps(parsed_jd, resume_structured)

    # Map back to original casing
    req_lookup = {s.lower(): s for s in parsed_jd.get("required_skills", [])}
    pref_lookup = {s.lower(): s for s in parsed_jd.get("preferred_skills", [])}

    return {
        "missing_required": sorted([req_lookup.get(s, s) for s in missing_required]),
        "missing_preferred": sorted([pref_lookup.get(s, s) for s in missing_preferred]),
        "gap_count": len(missing_required) + len(missing_preferred),
        "critical_gaps": sorted([req_lookup.get(s, s) for s in critical_gaps]),
        "coverage": {
            "required": round(req_coverage, 4),
            "preferred": round(pref_coverage, 4),
            "overall": round(overall_coverage, 4),
        },
        "experience_gaps": experience_gaps,
    }


def _identify_critical_gaps(missing_skills, jd_title, jd_domains):
    """Identify which missing skills are critical."""
    critical = set()

    if jd_title:
        title_lower = jd_title.lower()
        for skill in missing_skills:
            if skill in title_lower:
                critical.add(skill)

    _DOMAIN_CORE_SKILLS = {
        "backend": {"python", "java", "go", "node.js", "fastapi", "django", "flask", "express", "spring boot", "rest", "graphql", "postgresql", "mysql", "mongodb"},
        "frontend": {"javascript", "typescript", "react", "vue", "angular", "next.js", "html", "css"},
        "machine learning": {"python", "pytorch", "tensorflow", "scikit-learn", "pandas", "numpy", "deep learning", "llm", "transformers"},
        "data engineering": {"python", "sql", "spark", "airflow", "kafka", "snowflake", "bigquery", "dbt"},
        "devops": {"docker", "kubernetes", "terraform", "ci/cd", "aws", "gcp", "azure", "jenkins"},
        "cloud": {"aws", "gcp", "azure", "docker", "kubernetes", "terraform"},
        "mobile": {"swift", "kotlin", "react"},
    }

    for domain in jd_domains:
        core = _DOMAIN_CORE_SKILLS.get(domain.lower(), set())
        for skill in missing_skills:
            if skill in core:
                critical.add(skill)

    return critical


def _experience_gaps(parsed_jd, resume_structured):
    """Compute experience-level gaps."""
    result = {"years_short": None, "domain_gaps": []}

    jd_years = parsed_jd.get("min_years")
    resume_years = resume_structured.get("years_exp")
    if jd_years is not None and resume_years is not None:
        if resume_years < jd_years:
            result["years_short"] = round(jd_years - resume_years, 1)

    jd_domains = set(d.lower() for d in parsed_jd.get("domains", []))
    resume_domains = set(d.lower() for d in resume_structured.get("domains", []))
    result["domain_gaps"] = sorted(jd_domains - resume_domains)

    return result


# ═══════════════════════════════════════════════════════════════════
# LAYER 2: LLM-ENHANCED GAP ANALYSIS (optional)
# ═══════════════════════════════════════════════════════════════════

_GAP_LLM_PROMPT = """You are a career advisor analyzing skill gaps between a job description and a resume.

Given these missing skills, provide brief, actionable advice for each.
For each skill, mention:
1. How critical it is for the role (critical/moderate/low)
2. If the candidate has adjacent skills that make it easier to learn
3. Estimated learning time (days/weeks)

Return ONLY valid JSON (no markdown, no backticks):
{
    "gap_advice": [
        {
            "skill": "Kubernetes",
            "severity": "critical",
            "adjacent_skills": ["Docker"],
            "learning_estimate": "2-3 weeks",
            "advice": "You already know Docker, so Kubernetes concepts will feel familiar."
        }
    ]
}"""


async def analyze_gaps_with_llm(parsed_jd, resume_structured, resume_chunks=None):
    """Full gap analysis: deterministic + LLM advice."""
    gaps = analyze_gaps(parsed_jd, resume_structured, resume_chunks)

    if gaps["gap_count"] > 0:
        llm_advice = await _get_llm_gap_advice(
            missing_skills=gaps["missing_required"] + gaps["missing_preferred"],
            resume_skills=resume_structured.get("skills", []),
            jd_title=parsed_jd.get("title", "Unknown Role"),
        )
        if llm_advice:
            gaps["llm_advice"] = llm_advice

    return gaps


async def _get_llm_gap_advice(missing_skills, resume_skills, jd_title):
    """Get LLM-powered advice for each skill gap."""
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        return None

    try:
        import httpx

        user_msg = (
            f"Role: {jd_title}\n"
            f"Candidate's existing skills: {', '.join(resume_skills[:15])}\n"
            f"Missing skills to analyze: {', '.join(missing_skills[:10])}"
        )

        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.post(
                "https://api.openai.com/v1/chat/completions",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": "gpt-4o-mini",
                    "messages": [
                        {"role": "system", "content": _GAP_LLM_PROMPT},
                        {"role": "user", "content": user_msg},
                    ],
                    "temperature": 0.3,
                    "max_tokens": 600,
                },
            )

            if response.status_code != 200:
                return None

            data = response.json()
            content = data["choices"][0]["message"]["content"].strip()
            content = re.sub(r'^```(?:json)?\s*', '', content)
            content = re.sub(r'\s*```$', '', content)

            parsed = json.loads(content)
            return parsed.get("gap_advice", [])

    except Exception as e:
        print(f"[gap_analyzer] LLM advice failed: {e}")
        return None