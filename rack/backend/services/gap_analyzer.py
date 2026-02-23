"""
gap_analyzer.py
Analyzes gaps between JD requirements and resume capabilities.

Two layers (matching the project's hybrid architecture):
  Layer 1: Set difference — fast, deterministic
  Layer 2: LLM context — adds actionable advice for each gap (optional)

Design decisions:
  - Set difference uses normalized skill names (same SKILL_ALIASES vocabulary)
  - Gaps are categorized by severity: critical (required + high-signal) vs minor
  - LLM adds learning recommendations and skill adjacency hints
    (e.g., "You know FastAPI → Flask is a quick learn")
"""

import os
import re
import json
from typing import Dict, List, Optional


# ═══════════════════════════════════════════════════════════════════
# LAYER 1: DETERMINISTIC GAP ANALYSIS
# ═══════════════════════════════════════════════════════════════════

def analyze_gaps(
    parsed_jd: Dict,
    resume_structured: Dict,
) -> Dict:
    """
    Compute skill gaps between JD and resume.

    Args:
        parsed_jd: Output from jd_parser.parse_jd()
        resume_structured: Structured data from resume ingestion

    Returns:
        {
            "missing_required": ["Kubernetes", "Terraform"],
            "missing_preferred": ["Redis"],
            "gap_count": 3,
            "critical_gaps": ["Kubernetes"],     # high-signal missing required skills
            "coverage": {
                "required": 0.75,                # 6 of 8 required skills matched
                "preferred": 0.50,               # 2 of 4 preferred matched
                "overall": 0.70,
            },
            "experience_gaps": {
                "years_short": 2,                # null if meets requirement
                "domain_gaps": ["devops"],        # JD domains not in resume
            },
        }
    """
    resume_skills = set(s.lower() for s in resume_structured.get("skills", []))
    jd_required = set(s.lower() for s in parsed_jd.get("required_skills", []))
    jd_preferred = set(s.lower() for s in parsed_jd.get("preferred_skills", []))

    # Skill gaps
    missing_required = jd_required - resume_skills
    missing_preferred = jd_preferred - resume_skills

    # Coverage rates
    req_coverage = 1.0 - (len(missing_required) / len(jd_required)) if jd_required else 1.0
    pref_coverage = 1.0 - (len(missing_preferred) / len(jd_preferred)) if jd_preferred else 1.0
    total_jd = len(jd_required) + len(jd_preferred)
    total_missing = len(missing_required) + len(missing_preferred)
    overall_coverage = 1.0 - (total_missing / total_jd) if total_jd > 0 else 1.0

    # Critical gaps: required skills that are high-signal
    # (appear in the title, or are core tech like languages/frameworks)
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


def _identify_critical_gaps(
    missing_skills: set,
    jd_title: Optional[str],
    jd_domains: List[str],
) -> set:
    """
    Identify which missing skills are critical (vs nice-to-have).
    A skill is critical if:
      - It appears in the job title (e.g., "Python Developer" → Python is critical)
      - It's a primary language/framework for the domain
    """
    critical = set()

    # Skills that appear in the job title
    if jd_title:
        title_lower = jd_title.lower()
        for skill in missing_skills:
            if skill in title_lower:
                critical.add(skill)

    # Core skills per domain
    _DOMAIN_CORE_SKILLS = {
        "backend": {"python", "java", "go", "node.js", "fastapi", "django", "flask", "express", "spring boot", "rest", "graphql", "postgresql", "mysql", "mongodb"},
        "frontend": {"javascript", "typescript", "react", "vue", "angular", "next.js", "html", "css"},
        "machine learning": {"python", "pytorch", "tensorflow", "scikit-learn", "pandas", "numpy"},
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


def _experience_gaps(parsed_jd: Dict, resume_structured: Dict) -> Dict:
    """Compute experience-level gaps."""
    result = {
        "years_short": None,
        "domain_gaps": [],
    }

    # Years gap
    jd_years = parsed_jd.get("min_years")
    resume_years = resume_structured.get("years_exp")
    if jd_years is not None and resume_years is not None:
        if resume_years < jd_years:
            result["years_short"] = round(jd_years - resume_years, 1)

    # Domain gaps
    jd_domains = set(d.lower() for d in parsed_jd.get("domains", []))
    resume_domains = set(d.lower() for d in resume_structured.get("domains", []))
    domain_gaps = jd_domains - resume_domains
    result["domain_gaps"] = sorted(domain_gaps)

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
            "advice": "You already know Docker, so Kubernetes concepts will feel familiar. Focus on Deployments, Services, and kubectl basics."
        }
    ]
}"""


async def analyze_gaps_with_llm(
    parsed_jd: Dict,
    resume_structured: Dict,
) -> Dict:
    """
    Full gap analysis: deterministic + LLM advice.
    Falls back to deterministic-only if LLM fails.
    """
    # Layer 1: deterministic
    gaps = analyze_gaps(parsed_jd, resume_structured)

    # Layer 2: LLM advice (only if there are gaps worth advising on)
    if gaps["gap_count"] > 0:
        llm_advice = await _get_llm_gap_advice(
            missing_skills=gaps["missing_required"] + gaps["missing_preferred"],
            resume_skills=resume_structured.get("skills", []),
            jd_title=parsed_jd.get("title", "Unknown Role"),
        )
        if llm_advice:
            gaps["llm_advice"] = llm_advice

    return gaps


async def _get_llm_gap_advice(
    missing_skills: List[str],
    resume_skills: List[str],
    jd_title: str,
) -> Optional[List[Dict]]:
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