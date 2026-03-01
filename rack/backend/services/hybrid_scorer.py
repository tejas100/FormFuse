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

Design decisions:
  - Weights are tunable and logged (optimize by tracking click-through later)
  - Each component normalized to 0-1 range before weighting
  - Semantic score is the average of top-K chunk similarities (not max)
    to reward resumes that are consistently relevant, not just one lucky chunk
  - Skill matching uses normalized canonical names (from shared SKILL_ALIASES)
  - For LLM-extracted skills not in SKILL_ALIASES, falls back to text search
    in resume raw text/chunks to avoid false negatives
"""

import json
import logging
import os
import re
from typing import Dict, List, Optional, Set

logger = logging.getLogger(__name__)

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
# COMPONENT 2: SKILL OVERLAP (set intersection + text fallback)
# ═══════════════════════════════════════════════════════════════════

def _compute_skill_overlap(
    jd_required: List[str],
    jd_preferred: List[str],
    resume_skills: List[str],
    resume_chunks: List[Dict] = None,
    resume_structured: Dict = None,
    use_llm: bool = True,
) -> Dict:
    """
    Compute skill overlap between JD requirements and resume skills.

    Three-pass matching:
      Pass 1: Canonical skill name matching (SKILL_ALIASES vocabulary)
      Pass 2: Text-based search in resume chunks for skills missed by Pass 1
      Pass 3: LLM semantic matching for skills still unmatched — understands
              that "instruction-tuning" = "Fine-tuning", etc.

    This 3-pass approach is domain-agnostic: works for AI, biomedical,
    mechanical engineering, or any field without hardcoding domain knowledge.
    """
    resume_set = set(s.lower() for s in resume_skills)
    required_set = set(s.lower() for s in jd_required)
    preferred_set = set(s.lower() for s in jd_preferred)

    # Pass 1: Direct canonical matching
    required_matched = required_set & resume_set
    required_missing = required_set - resume_set
    preferred_matched = preferred_set & resume_set
    preferred_missing = preferred_set - resume_set

    # Pass 2: Text-based fallback for still-missing skills
    resume_full_text = ""
    if resume_chunks or resume_structured:
        resume_full_text = _build_resume_text(resume_chunks, resume_structured)
        
        text_matched_required = set()
        for skill in list(required_missing):
            if _skill_in_text(skill, resume_full_text):
                text_matched_required.add(skill)
        
        required_matched |= text_matched_required
        required_missing -= text_matched_required

        text_matched_preferred = set()
        for skill in list(preferred_missing):
            if _skill_in_text(skill, resume_full_text):
                text_matched_preferred.add(skill)

        preferred_matched |= text_matched_preferred
        preferred_missing -= text_matched_preferred

    # Pass 3: LLM semantic matching for remaining unmatched skills
    llm_matched_skills = set()
    if use_llm and (required_missing or preferred_missing):
        all_unmatched = required_missing | preferred_missing
        if resume_full_text:
            llm_matched_skills = _llm_skill_match(
                unmatched_skills=all_unmatched,
                resume_text=resume_full_text,
                resume_skills=resume_skills,
            )

        llm_matched_req = required_missing & llm_matched_skills
        required_matched |= llm_matched_req
        required_missing -= llm_matched_req

        llm_matched_pref = preferred_missing & llm_matched_skills
        preferred_matched |= llm_matched_pref
        preferred_missing -= llm_matched_pref

    # Coverage rates
    required_rate = len(required_matched) / len(required_set) if required_set else 1.0
    preferred_rate = len(preferred_matched) / len(preferred_set) if preferred_set else 0.0

    # Weighted score: required matters more
    score = (required_rate * 0.80) + (preferred_rate * 0.20)

    # Map back to original casing for display
    def _original_case(lowered_set, source_lists):
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


def _build_resume_text(chunks: List[Dict] = None, structured: Dict = None) -> str:
    """Build full resume text from chunks and structured data for text search."""
    parts = []
    
    if chunks:
        for chunk in chunks:
            text = chunk.get("text", "")
            if text:
                parts.append(text)
    
    if structured:
        # Add titles, companies, etc. as searchable text
        for title in structured.get("titles", []):
            parts.append(title)
        for skill in structured.get("skills", []):
            parts.append(skill)
    
    return " ".join(parts).lower()


def _skill_in_text(skill: str, text: str) -> bool:
    """
    Check if a skill concept appears in the resume text.
    Handles multi-word skills and common variations.
    
    Examples:
      "feature engineering" → searches for "feature engineering"
      "RAG" → searches with word boundaries
      "data preprocessing" → also matches "data pre-processing", "preprocessing"
      "fine-tuning" → also matches "fine tuning", "finetuning"
    """
    skill_lower = skill.lower().strip()
    
    # Direct match
    if skill_lower in text:
        return True
    
    # Handle hyphenated variants: "fine-tuning" ↔ "fine tuning" ↔ "finetuning"
    dehyphenated = skill_lower.replace("-", " ")
    if dehyphenated != skill_lower and dehyphenated in text:
        return True
    
    collapsed = skill_lower.replace("-", "").replace(" ", "")
    # Search for collapsed form with word boundary
    if len(collapsed) > 3:
        pattern = r'\b' + re.escape(collapsed) + r'\b'
        if re.search(pattern, text.replace("-", "").replace(" ", "")):
            return True
    
    # For short acronyms (RAG, LLM, NLP), use word-boundary matching
    if len(skill_lower) <= 4 and skill_lower.upper() == skill_lower.upper():
        pattern = r'\b' + re.escape(skill_lower) + r'\b'
        if re.search(pattern, text):
            return True
    
    # Check individual significant words for multi-word skills
    # e.g., "end-to-end ML development" → check if "end-to-end" AND "ml" appear
    words = re.split(r'[\s\-]+', skill_lower)
    significant_words = [w for w in words if len(w) > 2 and w not in {"and", "the", "for", "with", "end"}]
    if len(significant_words) >= 2:
        matches = sum(1 for w in significant_words if w in text)
        if matches >= len(significant_words) * 0.7:  # 70% of significant words found
            return True
    
    return False


# ═══════════════════════════════════════════════════════════════════
# PASS 3: LLM SEMANTIC SKILL MATCHING
# ═══════════════════════════════════════════════════════════════════

def _llm_skill_match(
    unmatched_skills: Set[str],
    resume_text: str,
    resume_skills: List[str],
) -> Set[str]:
    """
    Pass 3: Use GPT-4o-mini to determine if the resume demonstrates skills
    that Pass 1 (canonical) and Pass 2 (text search) missed.

    This is the key to domain-agnostic matching. The LLM understands that:
      - "instruction-tuning pipeline for StarCoder2" → Fine-tuning
      - "cross-validation, precision/recall tracking" → A/B Testing / Experimentation
      - "MLflow, drift monitoring, deployed inference" → MLOps
      - "gel electrophoresis, PCR" → wet lab experience (for biomedical JDs)

    Only fires for skills still unmatched after Pass 1+2 (typically 2-5 skills).
    One LLM call per match request. Cost: ~$0.0001-0.0002.

    Returns: set of skill names (lowercased) that the LLM confirmed are present.
    """
    if not unmatched_skills:
        return set()

    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        return set()

    # Truncate resume text to fit context (keep most relevant parts)
    truncated_resume = resume_text[:4000]

    skills_list = sorted(unmatched_skills)

    prompt = f"""You are a precise resume skill matcher. Given a resume and a list of skills from a job description that were NOT found by keyword matching, determine which skills the candidate actually demonstrates through their work experience, projects, or education — even if they never use the exact term.

RULES:
1. A skill is MATCHED if the resume shows clear evidence of that competency, even using different terminology.
2. Be STRICT — the evidence must be strong, not a vague stretch.
3. Return ONLY skills that have clear supporting evidence.

Examples of valid inference:
- "instruction-tuning pipeline for StarCoder2" → demonstrates "Fine-tuning" ✓
- "cross-validation, hyperparameter tuning, precision/recall tracking, evaluation workflows" → demonstrates "A/B Testing" ✓
- "MLflow, drift monitoring, model deployment pipelines, CI/CD for models" → demonstrates "MLOps" ✓
- "data processing, feature engineering, cleaning pipelines" → demonstrates "Data Preprocessing" ✓
- "deployed inference using vLLM on GPU instances" → demonstrates "Model Deployment" ✓

Examples of INVALID inference (too much of a stretch):
- "used Python" → demonstrates "Machine Learning" ✗ (Python alone doesn't prove ML)
- "built a website" → demonstrates "React" ✗ (could be any framework)

RESUME TEXT:
{truncated_resume}

CANDIDATE'S KNOWN SKILLS: {', '.join(resume_skills[:20])}

UNMATCHED SKILLS TO CHECK:
{json.dumps(skills_list)}

Return ONLY valid JSON (no markdown, no backticks):
{{
  "matched": [
    {{"skill": "Fine-tuning", "evidence": "built instruction-tuning pipeline for StarCoder2-15B"}},
  ],
  "not_matched": ["SkillX", "SkillY"]
}}"""

    try:
        import httpx

        response = httpx.post(
            "https://api.openai.com/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": "gpt-4o-mini",
                "messages": [
                    {"role": "system", "content": "You are a precise skill matching system. Return only valid JSON."},
                    {"role": "user", "content": prompt},
                ],
                "temperature": 0.1,
                "max_tokens": 500,
            },
            timeout=10.0,
        )

        if response.status_code != 200:
            logger.warning(f"LLM skill match API error: {response.status_code}")
            return set()

        content = response.json()["choices"][0]["message"]["content"].strip()
        content = re.sub(r'^```(?:json)?\s*', '', content)
        content = re.sub(r'\s*```$', '', content)

        result = json.loads(content)
        matched_skills = set()
        for item in result.get("matched", []):
            skill_name = item.get("skill", "") if isinstance(item, dict) else str(item)
            matched_skills.add(skill_name.lower().strip())
            evidence = item.get("evidence", "") if isinstance(item, dict) else ""
            logger.info(f"Pass 3 LLM matched: '{skill_name}' — {evidence}")

        logger.info(
            f"Pass 3 LLM: {len(matched_skills)} matched out of {len(unmatched_skills)} checked"
        )
        return matched_skills

    except json.JSONDecodeError as e:
        logger.warning(f"LLM skill match returned invalid JSON: {e}")
        return set()
    except Exception as e:
        logger.warning(f"LLM skill match failed: {e}")
        return set()


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
            years_score = min(1.0, resume_years / jd_min_years)
        else:
            years_score = 1.0
    elif jd_min_years is None:
        years_score = 0.7
    else:
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
        domain_score = 0.5
    else:
        domain_score = 0.2

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
    """
    if not jd_title or not resume_titles:
        return 0.3

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
    Skills in "skills" section (weight 1.0) score higher than "education" (0.3).
    """
    if not jd_required_skills or not faiss_results:
        return 0.0

    jd_skills_lower = set(s.lower() for s in jd_required_skills)
    total_possible = len(jd_skills_lower)

    if total_possible == 0:
        return 0.0

    skill_best_weight = {}
    for result in faiss_results:
        text_lower = result["text"].lower()
        section_weight = SECTION_WEIGHTS.get(result.get("section", "other"), 0.2)

        for skill in jd_skills_lower:
            if skill in text_lower:
                current_best = skill_best_weight.get(skill, 0.0)
                skill_best_weight[skill] = max(current_best, section_weight)

    weighted_hits = sum(skill_best_weight.values())
    max_possible = total_possible * 1.0

    return min(1.0, weighted_hits / max_possible) if max_possible > 0 else 0.0


# ═══════════════════════════════════════════════════════════════════
# MAIN SCORING FUNCTION
# ═══════════════════════════════════════════════════════════════════

def score_resume(
    parsed_jd: Dict,
    resume_structured: Dict,
    faiss_results: List[Dict],
    resume_chunks: List[Dict] = None,
    weights: Optional[Dict] = None,
    use_llm: bool = True,
) -> Dict:
    """
    Compute the hybrid match score for a single resume against a parsed JD.

    Args:
        parsed_jd: Output from jd_parser.parse_jd()
        resume_structured: Structured data from resume ingestion
        faiss_results: FAISS search results filtered for this resume
        resume_chunks: Resume chunk dicts (for text-based skill fallback)
        weights: Optional custom weights (defaults to WEIGHTS)
        use_llm: Whether to use LLM Pass 3 for semantic skill matching

    Returns:
        {
            "final_score": 82,
            "raw_score": 0.823,
            "components": { ... },
            "matched_skills": [...],
            "missing_skills": [...],
            "matched_preferred": [...],
        }
    """
    w = weights or WEIGHTS

    # Component 1: Semantic
    semantic = _compute_semantic_score(faiss_results)

    # Component 2: Skill overlap (with text fallback + LLM Pass 3)
    skill_result = _compute_skill_overlap(
        jd_required=parsed_jd.get("required_skills", []),
        jd_preferred=parsed_jd.get("preferred_skills", []),
        resume_skills=resume_structured.get("skills", []),
        resume_chunks=resume_chunks,
        resume_structured=resume_structured,
        use_llm=use_llm,
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

    raw_score = max(0.0, min(1.0, raw_score))

    return {
        "final_score": round(raw_score * 100),
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