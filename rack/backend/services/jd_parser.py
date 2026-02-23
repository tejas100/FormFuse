"""
jd_parser.py
Two-layer job description parser:
  Layer 1: Rule-based (deterministic) — reuses SKILL_ALIASES from structured_extractor.py
  Layer 2: LLM refinement (GPT-4o-mini) — catches implicit skills regex misses

Design decisions:
  - Same skill vocabulary as resume extraction (SKILL_ALIASES + _SKILL_LOOKUP)
    This is critical: if the resume says "FastAPI" and the JD says "fast api",
    both normalize to "FastAPI" → skill_overlap scoring works correctly.
  - LLM is additive only — it can add skills the rules missed, never removes.
  - LLM uses structured JSON output for reliable parsing.
  - Graceful degradation: if LLM call fails, rule-based results still returned.
  - Distinguishes required vs preferred skills (JD sections matter).
  - Runs once per match request, not cached (JDs are unique per query).
"""

import os
import re
import json
from typing import Dict, List, Optional, Tuple

# ═══════════════════════════════════════════════════════════════════
# REUSE SKILL VOCABULARY FROM STRUCTURED EXTRACTOR
# ═══════════════════════════════════════════════════════════════════
from services.structured_extractor import (
    SKILL_ALIASES,
    _SKILL_LOOKUP,
    _DOMAIN_SIGNALS,
    _TITLE_KEYWORDS,
)


# ═══════════════════════════════════════════════════════════════════
# JD SECTION SPLITTING
# ═══════════════════════════════════════════════════════════════════

# JDs have different headings than resumes
_JD_SECTION_PATTERNS = {
    "required": r"(?:required|requirements|must\s*have|qualifications|minimum\s*qualifications|what\s*you.?(?:ll)?\s*need|what\s*we.?(?:re)?\s*looking\s*for)",
    "preferred": r"(?:preferred|nice\s*to\s*have|bonus|desired|plus|good\s*to\s*have|additional|ideal(?:ly)?)",
    "responsibilities": r"(?:responsibilities|what\s*you.?(?:ll)?\s*do|role|duties|about\s*the\s*role|the\s*role|job\s*description|overview)",
    "about": r"(?:about\s*(?:us|the\s*company|the\s*team)|who\s*we\s*are|company|our\s*(?:mission|team))",
    "benefits": r"(?:benefits|perks|compensation|salary|what\s*we\s*offer|we\s*offer)",
}


def _split_jd_sections(text: str) -> Dict[str, str]:
    """
    Split JD text into labeled sections.
    Returns dict: {"required": "...", "preferred": "...", "responsibilities": "...", ...}
    If no sections detected, entire text goes under "general".
    """
    lines = text.split("\n")
    sections = {}
    current_section = "general"
    current_lines = []

    for line in lines:
        stripped = line.strip()
        if not stripped:
            current_lines.append("")
            continue

        # Check if this line is a JD section heading
        detected = None
        if len(stripped) < 80:
            cleaned = re.sub(r'^[\s\-=_*#|:•]+|[\s\-=_*#|:•]+$', '', stripped).strip()
            if cleaned:
                for section_name, pattern in _JD_SECTION_PATTERNS.items():
                    if re.search(pattern, cleaned, re.IGNORECASE):
                        detected = section_name
                        break

        if detected:
            # Save previous section
            if current_lines:
                text_block = "\n".join(current_lines).strip()
                if text_block:
                    sections[current_section] = sections.get(current_section, "") + "\n" + text_block
            current_section = detected
            current_lines = []
        else:
            current_lines.append(stripped)

    # Don't forget the last section
    if current_lines:
        text_block = "\n".join(current_lines).strip()
        if text_block:
            sections[current_section] = sections.get(current_section, "") + "\n" + text_block

    # Clean up leading/trailing whitespace
    return {k: v.strip() for k, v in sections.items() if v.strip()}


# ═══════════════════════════════════════════════════════════════════
# LAYER 1: RULE-BASED EXTRACTION
# ═══════════════════════════════════════════════════════════════════

def _extract_skills_from_text(text: str) -> List[str]:
    """
    Extract and normalize skills from text using the same
    SKILL_ALIASES vocabulary as resume extraction.
    """
    found = set()
    text_lower = text.lower()

    for alias, canonical in _SKILL_LOOKUP.items():
        if len(alias) <= 2:
            pattern = r'(?<![a-zA-Z])' + re.escape(alias) + r'(?![a-zA-Z])'
            if re.search(pattern, text, re.IGNORECASE):
                found.add(canonical)
        else:
            pattern = r'\b' + re.escape(alias) + r'\b'
            if re.search(pattern, text_lower):
                found.add(canonical)

    return sorted(found)


def _extract_years_required(text: str) -> Optional[int]:
    """
    Extract minimum years of experience from JD text.
    Matches patterns like:
      - "3+ years of experience"
      - "minimum 5 years"
      - "at least 2 years"
      - "3-5 years of experience"  → takes the minimum (3)
    """
    patterns = [
        # "3+ years", "5+ yrs of experience"
        r'(\d+)\+?\s*(?:years?|yrs?)(?:\s+of)?\s*(?:experience|exp|professional)',
        # "minimum 3 years", "at least 5 years"
        r'(?:minimum|at\s*least|min\.?)\s*(\d+)\s*(?:years?|yrs?)',
        # "3-5 years" → capture the lower bound
        r'(\d+)\s*[-–—to]+\s*\d+\s*(?:years?|yrs?)(?:\s+of)?\s*(?:experience|exp)?',
        # "X years" in requirements context
        r'(\d+)\s*(?:years?|yrs?)\s+(?:of\s+)?(?:hands-on|relevant|industry|professional|proven|solid|strong)',
    ]

    all_years = []
    text_lower = text.lower()
    for pattern in patterns:
        matches = re.findall(pattern, text_lower)
        all_years.extend(int(m) for m in matches)

    # Return the most common/minimum sensible value
    if not all_years:
        return None

    # Filter out unreasonable values (> 20 years in a JD is unusual)
    reasonable = [y for y in all_years if 0 < y <= 20]
    return min(reasonable) if reasonable else None


def _extract_title_from_jd(text: str) -> Optional[str]:
    """
    Extract the job title from JD text.
    Usually appears in the first few lines or after "Role:" / "Position:"
    """
    lines = text.strip().split("\n")

    # Strategy 1: Look for explicit "Title:" or "Position:" or "Role:" prefix
    for line in lines[:10]:
        stripped = line.strip()
        title_match = re.match(
            r'(?:job\s*title|position|role)\s*[:\-–]\s*(.+)',
            stripped, re.IGNORECASE
        )
        if title_match:
            title = title_match.group(1).strip()
            if 3 < len(title) < 80:
                return title

    # Strategy 2: First short line that contains a title keyword
    for line in lines[:5]:
        stripped = line.strip()
        if not stripped or len(stripped) > 80:
            continue
        line_lower = stripped.lower()
        has_title_kw = any(
            re.search(r'\b' + re.escape(kw) + r'\b', line_lower)
            for kw in _TITLE_KEYWORDS
        )
        if has_title_kw:
            # Clean it up
            cleaned = re.sub(r'\s*[-–—|]\s*(?:remote|hybrid|on-?site|full-?time|part-?time|contract).*$', '', stripped, flags=re.IGNORECASE)
            cleaned = re.sub(r'\s*\(.*?\)\s*$', '', cleaned)
            if 3 < len(cleaned.strip()) < 80:
                return cleaned.strip()

    return None


def _detect_jd_domains(text: str) -> List[str]:
    """Detect domains from JD text, reusing _DOMAIN_SIGNALS."""
    text_lower = text.lower()
    domain_scores = {}

    for domain, signals in _DOMAIN_SIGNALS.items():
        score = sum(1 for signal in signals if signal in text_lower)
        if score >= 2:
            domain_scores[domain] = score

    sorted_domains = sorted(domain_scores.items(), key=lambda x: -x[1])
    return [d[0] for d in sorted_domains[:4]]


def _rule_based_parse(jd_text: str) -> Dict:
    """
    Layer 1: Full rule-based JD parsing.
    Uses the same skill vocabulary as resume extraction.
    """
    sections = _split_jd_sections(jd_text)

    # Extract skills from different JD sections
    required_text = sections.get("required", "") + "\n" + sections.get("responsibilities", "") + "\n" + sections.get("general", "")
    preferred_text = sections.get("preferred", "")

    all_skills = _extract_skills_from_text(jd_text)
    required_skills = _extract_skills_from_text(required_text)
    preferred_skills = _extract_skills_from_text(preferred_text)

    # Skills found in preferred section but NOT in required → preferred
    # Skills found in required section (or general text) → required
    # If no section structure detected, all skills are "required"
    if preferred_text.strip():
        preferred_only = [s for s in preferred_skills if s not in required_skills]
        # Any remaining skills not in either category go to required
        for s in all_skills:
            if s not in required_skills and s not in preferred_only:
                required_skills.append(s)
        required_skills = sorted(set(required_skills))
        preferred_skills = sorted(set(preferred_only))
    else:
        required_skills = all_skills
        preferred_skills = []

    # Years, title, domains
    min_years = _extract_years_required(jd_text)
    title = _extract_title_from_jd(jd_text)
    domains = _detect_jd_domains(jd_text)

    return {
        "required_skills": required_skills,
        "preferred_skills": preferred_skills,
        "min_years": min_years,
        "title": title,
        "domains": domains,
        "sections_detected": list(sections.keys()),
    }


# ═══════════════════════════════════════════════════════════════════
# LAYER 2: LLM REFINEMENT (GPT-4o-mini)
# ═══════════════════════════════════════════════════════════════════

_LLM_SYSTEM_PROMPT = """You are a job description parser. Extract structured data from the given job description.

Return ONLY valid JSON with this exact structure (no markdown, no backticks, no explanation):
{
    "required_skills": ["skill1", "skill2"],
    "preferred_skills": ["skill3", "skill4"],
    "min_years": 3,
    "title": "Backend Engineer",
    "domains": ["backend", "cloud"],
    "implicit_skills": ["skill5"]
}

Rules:
- required_skills: Technologies, tools, and frameworks explicitly required
- preferred_skills: Nice-to-have skills mentioned as "preferred", "bonus", etc.
- min_years: Minimum years of experience (integer, null if not mentioned)
- title: The job title being hired for
- domains: Areas like "backend", "frontend", "fullstack", "machine learning", "data engineering", "devops", "cloud", "security", "mobile"
- implicit_skills: Skills not explicitly listed but clearly implied by the responsibilities (e.g., "build REST APIs" implies "REST" and "API Design", "deploy to production" implies "CI/CD")

Use canonical skill names: "Python" not "python3", "PostgreSQL" not "postgres", "Kubernetes" not "k8s", "JavaScript" not "js".
Return null for fields you can't determine. Keep arrays empty [] if nothing found."""


async def _llm_parse(jd_text: str) -> Optional[Dict]:
    """
    Layer 2: LLM-based JD parsing using GPT-4o-mini.
    Returns parsed dict or None if LLM call fails.
    """
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        print("[jd_parser] No OPENAI_API_KEY found, skipping LLM layer")
        return None

    try:
        import httpx

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
                        {"role": "system", "content": _LLM_SYSTEM_PROMPT},
                        {"role": "user", "content": f"Parse this job description:\n\n{jd_text[:4000]}"},  # Truncate to avoid token limits
                    ],
                    "temperature": 0.1,  # Low temperature for consistent structured output
                    "max_tokens": 800,
                },
            )

            if response.status_code != 200:
                print(f"[jd_parser] LLM API error: {response.status_code}")
                return None

            data = response.json()
            content = data["choices"][0]["message"]["content"].strip()

            # Strip markdown backticks if present
            content = re.sub(r'^```(?:json)?\s*', '', content)
            content = re.sub(r'\s*```$', '', content)

            parsed = json.loads(content)
            return parsed

    except Exception as e:
        print(f"[jd_parser] LLM parsing failed: {e}")
        return None


# ═══════════════════════════════════════════════════════════════════
# MERGE LAYER: COMBINE RULE-BASED + LLM RESULTS
# ═══════════════════════════════════════════════════════════════════

def _normalize_skill(skill: str) -> str:
    """
    Normalize a skill name using the shared SKILL_LOOKUP.
    If not found in aliases, return title-cased version.
    """
    lookup_key = skill.lower().strip()
    if lookup_key in _SKILL_LOOKUP:
        return _SKILL_LOOKUP[lookup_key]
    return skill.strip()


def _merge_results(rule_based: Dict, llm_result: Optional[Dict]) -> Dict:
    """
    Merge rule-based and LLM results.
    LLM is additive only — adds skills/data the rules missed.
    Rule-based results are the baseline truth.
    """
    if llm_result is None:
        return {
            **rule_based,
            "extraction_method": "rule_based",
        }

    # Merge required skills (normalize LLM skills through shared vocabulary)
    required_set = set(rule_based["required_skills"])
    for skill in llm_result.get("required_skills", []):
        normalized = _normalize_skill(skill)
        required_set.add(normalized)

    # Add implicit skills the LLM detected
    for skill in llm_result.get("implicit_skills", []):
        normalized = _normalize_skill(skill)
        required_set.add(normalized)

    # Merge preferred skills
    preferred_set = set(rule_based["preferred_skills"])
    for skill in llm_result.get("preferred_skills", []):
        normalized = _normalize_skill(skill)
        if normalized not in required_set:  # Don't duplicate into preferred if already required
            preferred_set.add(normalized)

    # Title: prefer LLM if rule-based didn't find one
    title = rule_based["title"] or llm_result.get("title")

    # Years: prefer rule-based (more reliable for exact numbers), fallback to LLM
    min_years = rule_based["min_years"]
    if min_years is None and llm_result.get("min_years") is not None:
        min_years = llm_result["min_years"]

    # Domains: union
    domains_set = set(rule_based["domains"])
    for d in llm_result.get("domains", []):
        domains_set.add(d.lower())

    return {
        "required_skills": sorted(required_set),
        "preferred_skills": sorted(preferred_set),
        "min_years": min_years,
        "title": title,
        "domains": sorted(domains_set),
        "sections_detected": rule_based["sections_detected"],
        "extraction_method": "hybrid",
        "llm_additions": {
            "skills_added": len(required_set) - len(rule_based["required_skills"]),
            "implicit_skills": llm_result.get("implicit_skills", []),
        },
    }


# ═══════════════════════════════════════════════════════════════════
# PUBLIC API
# ═══════════════════════════════════════════════════════════════════

async def parse_jd(jd_text: str, use_llm: bool = True) -> Dict:
    """
    Parse a job description using two-layer extraction.

    Layer 1: Rule-based (always runs) — same skill vocabulary as resume extraction
    Layer 2: LLM refinement (optional) — catches implicit skills, contextual requirements

    Args:
        jd_text: Raw job description text
        use_llm: Whether to run LLM layer (default True)

    Returns:
        {
            "required_skills": ["Python", "FastAPI", "PostgreSQL"],
            "preferred_skills": ["Kubernetes", "Redis"],
            "min_years": 3,
            "title": "Backend Engineer",
            "domains": ["backend", "cloud"],
            "extraction_method": "hybrid" | "rule_based",
            "sections_detected": ["required", "preferred", "responsibilities"],
            "llm_additions": {...}  # only present if LLM ran
        }
    """
    if not jd_text or not jd_text.strip():
        return {
            "required_skills": [],
            "preferred_skills": [],
            "min_years": None,
            "title": None,
            "domains": [],
            "extraction_method": "rule_based",
            "sections_detected": [],
        }

    # Layer 1: Rule-based (always runs)
    rule_based = _rule_based_parse(jd_text)

    # Layer 2: LLM refinement (optional, additive only)
    llm_result = None
    if use_llm:
        llm_result = await _llm_parse(jd_text)

    # Merge results
    result = _merge_results(rule_based, llm_result)

    print(f"[jd_parser] Extracted: {len(result['required_skills'])} required skills, "
          f"{len(result['preferred_skills'])} preferred skills, "
          f"min_years={result['min_years']}, method={result['extraction_method']}")

    return result


def parse_jd_sync(jd_text: str) -> Dict:
    """
    Synchronous version — rule-based only (no LLM).
    Useful for testing or when LLM is not needed.
    """
    if not jd_text or not jd_text.strip():
        return {
            "required_skills": [],
            "preferred_skills": [],
            "min_years": None,
            "title": None,
            "domains": [],
            "extraction_method": "rule_based",
            "sections_detected": [],
        }

    rule_based = _rule_based_parse(jd_text)
    return {
        **rule_based,
        "extraction_method": "rule_based",
    }