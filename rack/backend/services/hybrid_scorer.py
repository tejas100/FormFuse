"""
hybrid_scorer.py
4-component weighted scoring engine for resume-to-JD matching.

Components:
  1. semantic_score     × 0.40  — FAISS cosine similarity (vector space)
  2. skill_overlap      × 0.30  — set intersection of normalized skills
  3. experience_overlap × 0.20  — years match + title similarity
  4. keyword_position   × 0.10  — section-weighted keyword hits

Why hybrid over pure cosine similarity:
  At 3-5 resumes, pure vector search has very little discriminative power.
  Cosine similarities cluster around 0.6-0.8 for any remotely relevant text.
  The structured components (skill overlap, experience) provide sharp signal
  that separates a 95% match from a 70% match.

  Example: Two resumes might both score 0.75 cosine sim to a Python/FastAPI JD,
  but one has Python+FastAPI+PostgreSQL (skill overlap = 0.9) while the other
  has Java+Spring+MySQL (skill overlap = 0.1). Hybrid scoring catches this.

Design decisions:
  - Weights are tunable and logged (optimize by tracking click-through later)
  - Each component normalized to 0-1 range before weighting
  - Semantic score is the average of top-K chunk similarities (not max)
    to reward resumes that are consistently relevant, not just one lucky chunk
  - Skill matching uses normalized canonical names (from shared SKILL_ALIASES)
"""

import re
from typing import Dict, List, Optional

# ═══════════════════════════════════════════════════════════════════
# SCORING WEIGHTS (tunable — log these to find optimal balance)
# ═══════════════════════════════════════════════════════════════════

WEIGHTS = {
    "semantic":   0.40,    # FAISS cosine similarity
    "skill":      0.30,    # Skill set intersection
    "experience": 0.20,    # Years + title match
    "keyword":    0.10,    # Section-weighted keyword hits
}

# Section weights for keyword_position scoring
SECTION_WEIGHTS = {
    "summary": 1.0,
    "skills": 1.0,
    "experience": 0.7,
    "projects": 0.5,
    "education": 0.3,
    "other": 0.2,
}


# ═══════════════════════════════════════════════════════════════════
# COMPONENT 1: SEMANTIC SCORE (FAISS cosine similarity)
# ═══════════════════════════════════════════════════════════════════

def _compute_semantic_score(faiss_results: List[Dict], top_k: int = 5) -> float:
    """
    Average cosine similarity of top-K FAISS results for this resume.

    Uses average (not max) to reward resumes that are consistently
    relevant across multiple chunks, not just one lucky match.

    Args:
        faiss_results: FAISS search results filtered for this resume
        top_k: Number of top chunks to average over

    Returns:
        Float 0-1 (cosine similarity, already normalized since vectors are L2-normalized)
    """
    if not faiss_results:
        return 0.0

    scores = sorted([r["score"] for r in faiss_results], reverse=True)[:top_k]

    # Cosine sim with normalized vectors is already in [-1, 1],
    # but practically for relevant text it's in [0, 1].
    # Clamp to [0, 1] for safety.
    avg = sum(max(0.0, min(1.0, s)) for s in scores) / len(scores)
    return avg


# ═══════════════════════════════════════════════════════════════════
# COMPONENT 2: SKILL OVERLAP (set intersection)
# ═══════════════════════════════════════════════════════════════════

def _compute_skill_overlap(
    jd_required: List[str],
    jd_preferred: List[str],
    resume_skills: List[str],
) -> Dict:
    """
    Compute skill overlap between JD requirements and resume skills.
    Both use normalized canonical names from SKILL_ALIASES.

    Scoring:
      - Required skills matched → full weight
      - Preferred skills matched → partial bonus
      - Final score = (required_matched / required_total) * 0.8
                    + (preferred_matched / preferred_total) * 0.2

    Returns:
        {
            "score": 0.85,
            "matched_skills": ["Python", "FastAPI"],
            "missing_skills": ["Kubernetes"],
            "matched_preferred": ["Redis"],
            "required_match_rate": 0.8,
            "preferred_match_rate": 0.5,
        }
    """
    resume_set = set(s.lower() for s in resume_skills)
    required_set = set(s.lower() for s in jd_required)
    preferred_set = set(s.lower() for s in jd_preferred)

    # Required skill matches
    required_matched = required_set & resume_set
    required_missing = required_set - resume_set
    required_rate = len(required_matched) / len(required_set) if required_set else 1.0

    # Preferred skill matches
    preferred_matched = preferred_set & resume_set
    preferred_rate = len(preferred_matched) / len(preferred_set) if preferred_set else 0.0

    # Weighted score: required matters more
    score = (required_rate * 0.80) + (preferred_rate * 0.20)

    # Map back to original casing for display
    def _original_case(lowered_set, source_lists):
        """Get original-cased version of matched skills."""
        lookup = {}
        for s_list in source_lists:
            for s in s_list:
                lookup[s.lower()] = s
        return [lookup.get(s, s) for s in sorted(lowered_set)]

    return {
        "score": round(score, 4),
        "matched_skills": _original_case(required_matched, [jd_required, resume_skills]),
        "missing_skills": _original_case(required_missing, [jd_required]),
        "matched_preferred": _original_case(preferred_matched, [jd_preferred, resume_skills]),
        "required_match_rate": round(required_rate, 4),
        "preferred_match_rate": round(preferred_rate, 4),
    }


# ═══════════════════════════════════════════════════════════════════
# COMPONENT 3: EXPERIENCE OVERLAP (years + title match)
# ═══════════════════════════════════════════════════════════════════

def _compute_experience_score(
    jd_min_years: Optional[int],
    jd_title: Optional[str],
    jd_domains: List[str],
    resume_years: Optional[float],
    resume_titles: List[str],
    resume_domains: List[str],
) -> Dict:
    """
    Score experience match between JD and resume.

    Sub-components:
      - Years match (0-1): 1.0 if resume >= JD requirement, scales down linearly
      - Title similarity (0-1): fuzzy keyword overlap between JD title and resume titles
      - Domain overlap (0-1): intersection of domain areas

    Final: (years * 0.4) + (title * 0.35) + (domain * 0.25)
    """
    # ── Years match ──
    if jd_min_years is not None and resume_years is not None:
        if resume_years >= jd_min_years:
            years_score = 1.0
        elif jd_min_years > 0:
            # Linear scale: if JD wants 5 and resume has 3, score = 3/5 = 0.6
            years_score = min(1.0, resume_years / jd_min_years)
        else:
            years_score = 1.0
    elif jd_min_years is None:
        # JD doesn't specify years → no penalty
        years_score = 0.7  # Neutral-ish score
    else:
        # Resume has no years info → slight penalty
        years_score = 0.3

    # ── Title similarity ──
    title_score = _title_similarity(jd_title, resume_titles)

    # ── Domain overlap ──
    if jd_domains and resume_domains:
        jd_domain_set = set(d.lower() for d in jd_domains)
        resume_domain_set = set(d.lower() for d in resume_domains)
        intersection = jd_domain_set & resume_domain_set
        domain_score = len(intersection) / len(jd_domain_set) if jd_domain_set else 0.0
    elif not jd_domains:
        domain_score = 0.5  # JD doesn't specify domain → neutral
    else:
        domain_score = 0.2  # Resume has no detected domains

    # Weighted combination
    score = (years_score * 0.40) + (title_score * 0.35) + (domain_score * 0.25)

    return {
        "score": round(score, 4),
        "years_score": round(years_score, 4),
        "title_score": round(title_score, 4),
        "domain_score": round(domain_score, 4),
    }


def _title_similarity(jd_title: Optional[str], resume_titles: List[str]) -> float:
    """
    Fuzzy keyword overlap between JD title and resume titles.
    E.g., JD: "Senior Backend Engineer" vs Resume: "Software Engineer", "Backend Developer"
    Shared keywords: "backend", "engineer" → 2/3 = 0.67
    """
    if not jd_title or not resume_titles:
        return 0.3  # Can't compare → neutral

    # Extract meaningful keywords (ignore common filler)
    stop_words = {"the", "a", "an", "and", "or", "of", "for", "in", "at", "to", "with", "-", "–", "/"}

    jd_words = set(
        w.lower() for w in re.split(r'[\s/\-–]+', jd_title)
        if w.lower() not in stop_words and len(w) > 1
    )

    resume_words = set()
    for title in resume_titles:
        for w in re.split(r'[\s/\-–]+', title):
            if w.lower() not in stop_words and len(w) > 1:
                resume_words.add(w.lower())

    if not jd_words:
        return 0.3

    overlap = jd_words & resume_words
    return len(overlap) / len(jd_words)


# ═══════════════════════════════════════════════════════════════════
# COMPONENT 4: KEYWORD POSITION (section-weighted hits)
# ═══════════════════════════════════════════════════════════════════

def _compute_keyword_position_score(
    jd_required_skills: List[str],
    faiss_results: List[Dict],
) -> float:
    """
    Score based on WHERE in the resume the JD keywords appear.

    Skills mentioned in the "skills" section (weight 1.0) score higher
    than skills mentioned only in "education" (weight 0.3).

    This captures resume structure: a candidate who lists Python in their
    Skills section is more confident in it than one who mentions it
    only in a course description.
    """
    if not jd_required_skills or not faiss_results:
        return 0.0

    jd_skills_lower = set(s.lower() for s in jd_required_skills)
    weighted_hits = 0.0
    total_possible = len(jd_skills_lower)

    if total_possible == 0:
        return 0.0

    # For each JD skill, find the highest-weighted section it appears in
    skill_best_weight = {}
    for result in faiss_results:
        text_lower = result["text"].lower()
        section_weight = SECTION_WEIGHTS.get(result.get("section", "other"), 0.2)

        for skill in jd_skills_lower:
            if skill in text_lower:
                current_best = skill_best_weight.get(skill, 0.0)
                skill_best_weight[skill] = max(current_best, section_weight)

    # Sum the best weights, normalize by total possible
    weighted_hits = sum(skill_best_weight.values())
    max_possible = total_possible * 1.0  # Max weight per skill is 1.0

    return min(1.0, weighted_hits / max_possible) if max_possible > 0 else 0.0


# ═══════════════════════════════════════════════════════════════════
# MAIN SCORING FUNCTION
# ═══════════════════════════════════════════════════════════════════

def score_resume(
    parsed_jd: Dict,
    resume_structured: Dict,
    faiss_results: List[Dict],
    weights: Optional[Dict] = None,
) -> Dict:
    """
    Compute the hybrid match score for a single resume against a parsed JD.

    Args:
        parsed_jd: Output from jd_parser.parse_jd()
        resume_structured: Structured data from resume ingestion
        faiss_results: FAISS search results filtered for this resume
        weights: Optional custom weights (defaults to WEIGHTS)

    Returns:
        {
            "final_score": 82,          # 0-100 integer for display
            "raw_score": 0.823,         # 0-1 float
            "components": {
                "semantic": {"score": 0.75, "weight": 0.40, "weighted": 0.30},
                "skill":   {"score": 0.90, "weight": 0.30, "weighted": 0.27, "details": {...}},
                "experience": {"score": 0.85, "weight": 0.20, "weighted": 0.17, "details": {...}},
                "keyword": {"score": 0.60, "weight": 0.10, "weighted": 0.06},
            },
            "matched_skills": ["Python", "FastAPI"],
            "missing_skills": ["Kubernetes"],
            "matched_preferred": ["Redis"],
        }
    """
    w = weights or WEIGHTS

    # Component 1: Semantic
    semantic = _compute_semantic_score(faiss_results)

    # Component 2: Skill overlap
    skill_result = _compute_skill_overlap(
        jd_required=parsed_jd.get("required_skills", []),
        jd_preferred=parsed_jd.get("preferred_skills", []),
        resume_skills=resume_structured.get("skills", []),
    )

    # Component 3: Experience
    exp_result = _compute_experience_score(
        jd_min_years=parsed_jd.get("min_years"),
        jd_title=parsed_jd.get("title"),
        jd_domains=parsed_jd.get("domains", []),
        resume_years=resume_structured.get("years_exp"),
        resume_titles=resume_structured.get("titles", []),
        resume_domains=resume_structured.get("domains", []),
    )

    # Component 4: Keyword position
    keyword = _compute_keyword_position_score(
        jd_required_skills=parsed_jd.get("required_skills", []),
        faiss_results=faiss_results,
    )

    # Weighted combination
    raw_score = (
        semantic        * w["semantic"]
        + skill_result["score"]  * w["skill"]
        + exp_result["score"]    * w["experience"]
        + keyword               * w["keyword"]
    )

    # Clamp to [0, 1]
    raw_score = max(0.0, min(1.0, raw_score))

    return {
        "final_score": round(raw_score * 100),  # 0-100 for display
        "raw_score": round(raw_score, 4),
        "components": {
            "semantic": {
                "score": round(semantic, 4),
                "weight": w["semantic"],
                "weighted": round(semantic * w["semantic"], 4),
            },
            "skill": {
                "score": skill_result["score"],
                "weight": w["skill"],
                "weighted": round(skill_result["score"] * w["skill"], 4),
                "details": {
                    "required_match_rate": skill_result["required_match_rate"],
                    "preferred_match_rate": skill_result["preferred_match_rate"],
                },
            },
            "experience": {
                "score": exp_result["score"],
                "weight": w["experience"],
                "weighted": round(exp_result["score"] * w["experience"], 4),
                "details": {
                    "years_score": exp_result["years_score"],
                    "title_score": exp_result["title_score"],
                    "domain_score": exp_result["domain_score"],
                },
            },
            "keyword": {
                "score": round(keyword, 4),
                "weight": w["keyword"],
                "weighted": round(keyword * w["keyword"], 4),
            },
        },
        "matched_skills": skill_result["matched_skills"],
        "missing_skills": skill_result["missing_skills"],
        "matched_preferred": skill_result["matched_preferred"],
    }