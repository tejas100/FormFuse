"""
section_parser.py
Splits raw resume text into labeled sections:
  summary, skills, experience, projects, education, other

Uses regex heuristics to detect common resume headings.
Each section gets a weight used later in keyword_position scoring.
"""

import re
from typing import Dict, List, Tuple

# Section heading patterns (case-insensitive)
SECTION_PATTERNS = {
    "summary": r"(?:summary|objective|profile|about\s*me|professional\s*summary)",
    "skills": r"(?:skills|technical\s*skills|core\s*competencies|technologies|tools|proficiencies)",
    "experience": r"(?:experience|work\s*experience|employment|professional\s*experience|work\s*history)",
    "projects": r"(?:projects|personal\s*projects|key\s*projects|selected\s*projects|portfolio)",
    "education": r"(?:education|academic|degrees|certifications?|training|courses)",
}

# Weights for keyword_position scoring component
SECTION_WEIGHTS = {
    "summary": 1.0,
    "skills": 1.0,
    "experience": 0.7,
    "projects": 0.5,
    "education": 0.3,
    "other": 0.2,
}


def parse_sections(raw_text: str) -> List[Dict]:
    """
    Parse raw resume text into labeled sections.
    
    Returns:
        List of dicts: [{"section": "skills", "text": "...", "weight": 1.0}, ...]
    """
    if not raw_text or not raw_text.strip():
        return [{"section": "other", "text": raw_text or "", "weight": SECTION_WEIGHTS["other"]}]

    lines = raw_text.split("\n")
    sections: List[Dict] = []
    current_section = "summary"  # Default: text before any heading is treated as summary
    current_lines: List[str] = []

    for line in lines:
        stripped = line.strip()
        if not stripped:
            current_lines.append("")
            continue

        # Check if this line is a section heading
        detected = _detect_heading(stripped)
        if detected:
            # Save previous section
            if current_lines:
                text = "\n".join(current_lines).strip()
                if text:
                    sections.append({
                        "section": current_section,
                        "text": text,
                        "weight": SECTION_WEIGHTS.get(current_section, 0.2),
                    })
            current_section = detected
            current_lines = []
        else:
            current_lines.append(stripped)

    # Don't forget the last section
    if current_lines:
        text = "\n".join(current_lines).strip()
        if text:
            sections.append({
                "section": current_section,
                "text": text,
                "weight": SECTION_WEIGHTS.get(current_section, 0.2),
            })

    # If nothing was parsed, return entire text as "other"
    if not sections:
        sections.append({
            "section": "other",
            "text": raw_text.strip(),
            "weight": SECTION_WEIGHTS["other"],
        })

    return sections


def _detect_heading(line: str) -> str | None:
    """
    Check if a line looks like a section heading.
    Heuristics:
      - Short line (< 60 chars)
      - Matches a known section pattern
      - Often ALL CAPS or Title Case
    """
    # Too long to be a heading
    if len(line) > 60:
        return None

    # Strip common decorators
    cleaned = re.sub(r"^[\s\-=_*#|:]+|[\s\-=_*#|:]+$", "", line).strip()
    if not cleaned:
        return None

    for section_name, pattern in SECTION_PATTERNS.items():
        if re.match(pattern, cleaned, re.IGNORECASE):
            return section_name

    return None