"""
structured_extractor.py
Stage 1: Deterministic structured extraction from parsed resume sections.

Two-stage architecture:
  Stage 1 (this file) — Fast, rule-based, deterministic
    - Skill detection + normalization
    - Years of experience (explicit mentions + date-range math)
    - Role/title extraction (pattern-based)
    - Company extraction
    - Education (degree + field + institution)

  Stage 2 (future) — LLM refinement
    - Normalize ambiguous skills
    - Detect implicit skills ("built REST APIs" → ["REST", "API Design"])
    - Clean up role titles
    - Merge with Stage 1 output (rules = baseline truth, LLM = additive only)

Design decisions:
  - Pattern-based over list-based for roles/companies (resumes have infinite variation)
  - Case-insensitive skill matching with alias groups (not just 1:1 normalization)
  - Date-range math for years_exp (more accurate than "5+ years" regex alone)
  - Runs once at upload time, NOT on every query
"""

import json
import logging
import os
import re
from datetime import datetime
from typing import Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)


# ═══════════════════════════════════════════════════════════════════
# SKILL DETECTION + NORMALIZATION
# ═══════════════════════════════════════════════════════════════════

# Alias groups: first item is the canonical name, rest are variations
# Case-insensitive matching is applied automatically
SKILL_ALIASES = [
    # Languages
    ["Python", "python3", "python 3"],
    ["JavaScript", "js", "javascript", "ecmascript"],
    ["TypeScript", "ts", "typescript"],
    ["Java", "java"],
    ["Go", "golang"],
    ["Rust", "rust-lang"],
    ["C++", "cpp", "c plus plus"],
    ["C#", "csharp", "c sharp"],
    ["Ruby", "ruby"],
    ["PHP", "php"],
    ["Swift", "swift"],
    ["Kotlin", "kotlin"],
    ["Scala", "scala"],
    ["R", "r-lang"],
    ["SQL", "sql"],
    ["Bash", "bash", "shell", "zsh"],

    # Frontend
    ["React", "react.js", "reactjs", "react js"],
    ["Vue", "vue.js", "vuejs", "vue js", "vue 3"],
    ["Angular", "angular.js", "angularjs", "angular js"],
    ["Next.js", "nextjs", "next js", "next.js"],
    ["Svelte", "sveltejs", "svelte.js"],
    ["HTML", "html5", "html 5"],
    ["CSS", "css3", "css 3"],
    ["Tailwind", "tailwindcss", "tailwind css"],
    ["SASS", "scss"],
    ["Redux", "redux toolkit", "react-redux"],

    # Backend
    ["Node.js", "nodejs", "node js", "node"],
    ["FastAPI", "fastapi", "fast api"],
    ["Django", "django"],
    ["Flask", "flask"],
    ["Express", "express.js", "expressjs"],
    ["Spring Boot", "spring boot", "springboot", "spring"],
    ["Rails", "ruby on rails", "ror"],
    ["ASP.NET", "asp.net", "dotnet", ".net", ".net core"],
    ["GraphQL", "graphql", "graph ql"],
    ["REST", "rest api", "rest apis", "restful"],
    ["gRPC", "grpc"],

    # Databases
    ["PostgreSQL", "postgres", "postgresql", "psql", "pg"],
    ["MySQL", "mysql"],
    ["MongoDB", "mongo", "mongodb"],
    ["Redis", "redis"],
    ["SQLite", "sqlite"],
    ["Elasticsearch", "elastic", "elasticsearch", "elastic search"],
    ["DynamoDB", "dynamodb", "dynamo db"],
    ["Cassandra", "cassandra"],
    ["Neo4j", "neo4j"],

    # Cloud & Infra
    ["AWS", "amazon web services"],
    ["GCP", "google cloud", "google cloud platform"],
    ["Azure", "microsoft azure"],
    ["Docker", "docker"],
    ["Kubernetes", "k8s", "kubernetes"],
    ["Terraform", "terraform"],
    ["Ansible", "ansible"],
    ["Linux", "linux", "ubuntu", "centos", "debian"],
    ["Nginx", "nginx"],

    # Data & ML — Core frameworks
    ["PyTorch", "pytorch", "torch"],
    ["TensorFlow", "tensorflow", "tf"],
    ["scikit-learn", "sklearn", "scikit learn"],
    ["Pandas", "pandas"],
    ["NumPy", "numpy"],
    ["MLflow", "mlflow", "ml flow"],
    ["Spark", "apache spark", "pyspark"],
    ["Airflow", "apache airflow"],
    ["Kafka", "apache kafka"],
    ["Hadoop", "hadoop"],
    ["dbt", "dbt"],
    ["Snowflake", "snowflake"],
    ["BigQuery", "bigquery", "big query"],
    ["Hugging Face", "huggingface", "hugging face", "hf"],
    ["LangChain", "langchain", "lang chain"],
    ["FAISS", "faiss"],
    ["OpenAI", "openai", "open ai"],
    ["XGBoost", "xgboost", "xg boost"],

    # AI/ML Concepts & Techniques (critical for JD matching)
    ["RAG", "rag", "retrieval-augmented generation", "retrieval augmented generation"],
    ["LLM", "llm", "llms", "large language model", "large language models"],
    ["Transformers", "transformers", "transformer", "transformer models", "transformer architecture"],
    ["Deep Learning", "deep learning", "deep-learning", "dl"],
    ["NLP", "nlp", "natural language processing"],
    ["Computer Vision", "computer vision", "cv", "image recognition"],
    ["Fine-tuning", "fine-tuning", "fine tuning", "finetuning", "model fine-tuning"],
    ["Prompt Engineering", "prompt engineering", "prompt optimization", "prompt orchestration"],
    ["Embeddings", "embeddings", "embedding generation", "vector embeddings", "sentence-transformers"],
    ["Vector Search", "vector search", "vector indexing", "similarity search", "semantic search"],
    ["Model Evaluation", "model evaluation", "model assessment", "evaluation frameworks"],
    ["Feature Engineering", "feature engineering", "feature extraction", "feature pipelines"],
    ["Data Preprocessing", "data preprocessing", "data cleaning", "data preparation", "data wrangling"],
    ["MLOps", "mlops", "ml ops", "ml operations"],
    ["Model Deployment", "model deployment", "model serving", "model inference", "inference optimization"],
    ["Drift Monitoring", "drift monitoring", "model drift", "data drift", "concept drift"],
    ["A/B Testing", "a/b testing", "ab testing", "a/b test", "experimentation"],
    ["Hyperparameter Tuning", "hyperparameter tuning", "hyperparameter optimization", "hyperparam tuning"],
    ["Foundation Models", "foundation models", "foundation model"],
    ["vLLM", "vllm"],
    ["Neural Networks", "neural network", "neural networks", "nn", "cnn", "rnn", "lstm"],

    # DevOps & Tools
    ["Git", "git", "github", "gitlab", "bitbucket"],
    ["CI/CD", "ci/cd", "cicd", "ci cd", "continuous integration", "github actions"],
    ["Jenkins", "jenkins"],
    ["GitHub Actions", "github actions"],
    ["Jira", "jira"],
    ["Confluence", "confluence"],
    ["Figma", "figma"],
    ["Postman", "postman"],
    ["RabbitMQ", "rabbitmq", "rabbit mq"],
    ["Celery", "celery"],
]

# Build lookup: lowered_alias → canonical_name
_SKILL_LOOKUP: Dict[str, str] = {}
for group in SKILL_ALIASES:
    canonical = group[0]
    for alias in group:
        _SKILL_LOOKUP[alias.lower()] = canonical


def _extract_skills(text: str) -> List[str]:
    """
    Extract and normalize skills from text.
    Uses word-boundary matching to avoid false positives
    (e.g., "React" inside "Reactive" won't match).
    """
    found = set()
    text_lower = text.lower()

    for alias, canonical in _SKILL_LOOKUP.items():
        # Word boundary check to prevent substring false positives
        # For short aliases (≤ 2 chars like "R", "Go", "C#", "JS"),
        # require stricter context (comma-separated, bullet points, etc.)
        if len(alias) <= 2:
            # Match only if surrounded by non-alphanumeric chars
            pattern = r'(?<![a-zA-Z])' + re.escape(alias) + r'(?![a-zA-Z])'
            if re.search(pattern, text, re.IGNORECASE):
                found.add(canonical)
        else:
            # Standard word-boundary match for longer aliases
            pattern = r'\b' + re.escape(alias) + r'\b'
            if re.search(pattern, text_lower):
                found.add(canonical)

    return sorted(found)


# ═══════════════════════════════════════════════════════════════════
# YEARS OF EXPERIENCE
# ═══════════════════════════════════════════════════════════════════

def _extract_years_experience(sections: List[Dict]) -> Optional[float]:
    """
    Extract years of experience using two strategies:
    1. Explicit mentions: "5+ years", "3 yrs of experience"
    2. Date-range math: "Jan 2019 – Present", "2020 - 2024"

    Returns the higher of the two (date-range is usually more accurate).
    """
    full_text = " ".join(s["text"] for s in sections)

    # Strategy 1: Explicit mentions
    explicit_years = _years_from_explicit(full_text)

    # Strategy 2: Date-range math (only from experience/projects sections)
    experience_text = " ".join(
        s["text"] for s in sections
        if s["section"] in ("experience", "projects")
    )
    range_years = _years_from_date_ranges(experience_text)

    # Return the higher value (date ranges tend to be more accurate)
    candidates = [y for y in [explicit_years, range_years] if y is not None]
    return max(candidates) if candidates else None


def _years_from_explicit(text: str) -> Optional[float]:
    """Match patterns like '5+ years', '3 yrs experience', 'over 7 years'."""
    patterns = [
        r'(\d+)\+?\s*(?:years?|yrs?)(?:\s+of)?\s*(?:experience|exp)?',
        r'(?:over|more than|approximately|~)\s*(\d+)\s*(?:years?|yrs?)',
    ]
    all_matches = []
    for pattern in patterns:
        matches = re.findall(pattern, text.lower())
        all_matches.extend(int(m) for m in matches)

    return max(all_matches) if all_matches else None


# Month name → number mapping
_MONTHS = {
    "jan": 1, "january": 1, "feb": 2, "february": 2, "mar": 3, "march": 3,
    "apr": 4, "april": 4, "may": 5, "jun": 6, "june": 6,
    "jul": 7, "july": 7, "aug": 8, "august": 8, "sep": 9, "september": 9,
    "oct": 10, "october": 10, "nov": 11, "november": 11, "dec": 12, "december": 12,
}


def _years_from_date_ranges(text: str) -> Optional[float]:
    """
    Extract date ranges and compute total years.
    Matches patterns like:
      - "Jan 2019 – Dec 2022"
      - "2020 - Present"
      - "March 2018 – Current"
      - "06/2019 - 03/2023"
    """
    current_year = datetime.now().year
    current_month = datetime.now().month

    # Pattern: Month Year - Month Year (or Present/Current)
    date_range_pattern = r'(?:(' + '|'.join(_MONTHS.keys()) + r')\w*\.?\s+)?(\d{4})\s*[-–—to]+\s*(?:(' + '|'.join(_MONTHS.keys()) + r')\w*\.?\s+)?(\d{4}|present|current|now|ongoing)'

    # Pattern: MM/YYYY - MM/YYYY
    numeric_date_pattern = r'(\d{1,2})[/\-](\d{4})\s*[-–—to]+\s*(\d{1,2})[/\-](\d{4}|present|current|now|ongoing)'

    total_months = 0
    found_any = False

    # Match text-based date ranges
    for match in re.finditer(date_range_pattern, text.lower()):
        start_month_str, start_year_str, end_month_str, end_year_str = match.groups()

        start_month = _MONTHS.get(start_month_str, 1) if start_month_str else 1
        start_year = int(start_year_str)

        if end_year_str in ("present", "current", "now", "ongoing"):
            end_year = current_year
            end_month = current_month
        else:
            end_year = int(end_year_str)
            end_month = _MONTHS.get(end_month_str, 12) if end_month_str else 12

        months = (end_year - start_year) * 12 + (end_month - start_month)
        if 0 < months < 600:  # sanity check: less than 50 years
            total_months += months
            found_any = True

    # Match numeric date ranges (06/2019 - 03/2023)
    for match in re.finditer(numeric_date_pattern, text.lower()):
        s_month, s_year, e_month, e_year = match.groups()

        start_month = int(s_month)
        start_year = int(s_year)

        if e_year in ("present", "current", "now", "ongoing"):
            end_year = current_year
            end_month = current_month
        else:
            end_year = int(e_year)
            end_month = int(e_month)

        months = (end_year - start_year) * 12 + (end_month - start_month)
        if 0 < months < 600:
            total_months += months
            found_any = True

    if not found_any:
        return None

    return round(total_months / 12, 1)


# ═══════════════════════════════════════════════════════════════════
# ROLE / TITLE EXTRACTION (pattern-based, not list-based)
# ═══════════════════════════════════════════════════════════════════

# Title-specific keywords (narrower than before — "service", "data" etc. removed
# because they appear in bullet points too often and cause false positives)
_TITLE_KEYWORDS = [
    "engineer", "developer", "architect", "manager", "lead", "director",
    "analyst", "scientist", "designer", "consultant", "administrator",
    "coordinator", "specialist", "intern", "associate", "principal",
    "staff", "senior", "junior", "head of", "vp of", "chief",
    "devops", "sre", "qa", "full stack", "full-stack", "founder",
    "co-founder", "cto", "ceo", "coo",
]

# Resume role lines follow a consistent structure:
# "Company - Title - Location Date" or "Title at Company"
_ROLE_LINE_PATTERNS = [
    # "Exito Infynites - Software Developer - Bengaluru, India Jul 2022 – Aug 2023"
    # Company - Title - Location+Date (3-part dash split)
    r'^([^•\-\*·].+?)\s*[-–—]\s*(.+?)\s*[-–—]\s*(.+)$',
    # "Software Engineer at Google"
    r'^([^•\-\*·].+?)\s+(?:at|@)\s+(.+?)$',
]


def _is_bullet_line(line: str) -> bool:
    """Check if a line is a bullet point (description, not a header)."""
    stripped = line.strip()
    return stripped.startswith(("•", "–", "-", "*", "·", "▪", "►", "○", "●"))


def _has_concatenated_words(text: str) -> bool:
    """
    Detect pdfplumber artifacts where spaces are stripped.
    e.g., "scaledistributedbackendsystems" — a 30+ char word with no spaces.
    """
    words = text.split()
    return any(len(w) > 25 and w.isalpha() for w in words)


def _extract_roles_and_companies(sections: List[Dict]) -> Tuple[List[str], List[str]]:
    """
    Extract job titles and company names from experience sections.

    Key filters to avoid garbage:
    - Skip bullet-point lines (they describe work, not titles)
    - Skip lines with concatenated words (pdfplumber artifacts)
    - Only process lines from the experience section
    - Use the 3-part dash pattern common in resumes: Company - Title - Location Date
    """
    roles = []
    companies = []

    for section in sections:
        if section["section"] != "experience":
            continue

        lines = section["text"].split("\n")
        for line in lines:
            stripped = line.strip()
            if not stripped:
                continue

            # ── FILTER 1: Skip bullet points ──
            if _is_bullet_line(stripped):
                continue

            # ── FILTER 2: Skip concatenated-word artifacts ──
            if _has_concatenated_words(stripped):
                continue

            # ── FILTER 3: Skip long lines (real role lines are < 100 chars) ──
            if len(stripped) > 100:
                continue

            # ── FILTER 4: Must contain a title keyword ──
            line_lower = stripped.lower()
            has_title_keyword = any(
                re.search(r'\b' + re.escape(kw) + r'\b', line_lower)
                for kw in _TITLE_KEYWORDS
            )
            if not has_title_keyword:
                continue

            # ── Try 3-part pattern: "Company - Title - Location Date" ──
            three_part = re.match(
                r'^([^•].+?)\s*[-–—]\s*(.+?)\s*[-–—]\s*(.+)$',
                stripped
            )
            if three_part:
                company_raw = three_part.group(1).strip()
                title_raw = three_part.group(2).strip()
                _location_date = three_part.group(3).strip()  # discard

                # Validate: the title part should contain the keyword
                title_has_kw = any(
                    re.search(r'\b' + re.escape(kw) + r'\b', title_raw.lower())
                    for kw in _TITLE_KEYWORDS
                )
                if title_has_kw:
                    roles.append(_clean_title(title_raw))
                    companies.append(_clean_company(company_raw))
                else:
                    # Maybe it's reversed: Title - Company - Location
                    roles.append(_clean_title(company_raw))
                    companies.append(_clean_company(title_raw))
                continue

            # ── Try 2-part "at" pattern: "Software Engineer at Google" ──
            at_match = re.match(
                r'^([^•].+?)\s+(?:at|@)\s+(.+?)$',
                stripped
            )
            if at_match:
                part1, part2 = at_match.group(1).strip(), at_match.group(2).strip()
                p1_is_title = any(kw in part1.lower() for kw in _TITLE_KEYWORDS)
                if p1_is_title:
                    roles.append(_clean_title(part1))
                    companies.append(_clean_company(part2))
                else:
                    roles.append(_clean_title(part2))
                    companies.append(_clean_company(part1))
                continue

    # Deduplicate while preserving order
    roles = _dedupe(roles)
    companies = _dedupe(companies)

    return roles, companies


def _clean_title(title: str) -> str:
    """Clean up a job title string — strip dates, locations, trailing punctuation."""
    # Remove location + date suffix: "Bengaluru, India Jul 2022 – Aug 2023"
    title = re.sub(
        r'\s*[-–—,]\s*[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*,?\s*(?:[A-Z]{2})?\s*(?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+)?\d{4}\s*[-–—]\s*(?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+)?(?:\d{4}|Present|Current).*$',
        '', title, flags=re.IGNORECASE
    )
    # Remove standalone date ranges at end
    title = re.sub(r'\s*\(?\d{4}\s*[-–—]\s*(?:\d{4}|present|current)\)?\s*$', '', title, flags=re.IGNORECASE)
    # Remove trailing punctuation
    title = re.sub(r'[\s,|—\-]+$', '', title)
    return title.strip()


def _clean_company(company: str) -> str:
    """Clean up a company name string."""
    # Remove location + date suffix
    company = re.sub(
        r'\s*[-–—,]\s*[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*,?\s*(?:[A-Z]{2})?\s*(?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+)?\d{4}\s*[-–—]\s*(?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+)?(?:\d{4}|Present|Current).*$',
        '', company, flags=re.IGNORECASE
    )
    company = re.sub(r'\s*\(?\d{4}\s*[-–—]\s*(?:\d{4}|present|current)\)?\s*$', '', company, flags=re.IGNORECASE)
    company = re.sub(r'[\s,|—\-]+$', '', company)
    # Remove common suffixes
    company = re.sub(r'\s*(Inc\.?|LLC|Ltd\.?|Corp\.?|Co\.?)$', '', company, flags=re.IGNORECASE)
    return company.strip()


# ═══════════════════════════════════════════════════════════════════
# EDUCATION EXTRACTION
# ═══════════════════════════════════════════════════════════════════

# Degree patterns with canonical names
_DEGREE_PATTERNS = [
    (r"\b(?:ph\.?d|doctor(?:ate)?)\b", "PhD"),
    (r"\b(?:m\.?s\.?|master(?:'?s)?)\b", "Master's"),
    (r"\b(?:m\.?b\.?a\.?)\b", "MBA"),
    (r"\b(?:b\.?s\.?|bachelor(?:'?s)?|b\.?tech|b\.?e\.?)\b", "Bachelor's"),
    (r"\b(?:a\.?s\.?|associate(?:'?s)?)\b", "Associate's"),
]

# Common fields of study
_FIELD_PATTERNS = [
    "computer science", "software engineering", "information technology",
    "information systems", "data science", "machine learning",
    "artificial intelligence", "electrical engineering",
    "computer engineering", "mathematics", "statistics",
    "physics", "business administration", "economics",
    "mechanical engineering", "biomedical engineering",
    "cybersecurity", "information security",
]


def _extract_education(sections: List[Dict]) -> List[Dict]:
    """
    Extract education entries: degree, field, institution.
    Returns list of dicts: [{"degree": "Master's", "field": "Computer Science", "institution": "MIT"}, ...]
    """
    education_entries = []

    for section in sections:
        if section["section"] != "education":
            continue

        text = section["text"]
        lines = text.split("\n")

        # Process lines looking for degree mentions
        for i, line in enumerate(lines):
            stripped = line.strip()
            if not stripped:
                continue

            line_lower = stripped.lower()

            # Check for degree
            degree = None
            for pattern, degree_name in _DEGREE_PATTERNS:
                if re.search(pattern, line_lower):
                    degree = degree_name
                    break

            if not degree:
                continue

            # Look for field of study in same line or nearby lines
            field = None
            search_text = line_lower
            if i + 1 < len(lines):
                search_text += " " + lines[i + 1].lower()

            for f in _FIELD_PATTERNS:
                if f in search_text:
                    field = f.title()
                    break

            # Also try "in <field>" pattern
            if not field:
                in_match = re.search(r'(?:in|of)\s+([A-Za-z\s&]+?)(?:\s*[,\-|·(]|\s*$)', stripped)
                if in_match:
                    candidate = in_match.group(1).strip()
                    if 2 < len(candidate) < 50:
                        field = candidate

            # Institution: usually on same line or line before/after
            institution = _find_institution(lines, i)

            education_entries.append({
                "degree": degree,
                "field": field,
                "institution": institution,
            })

    return education_entries


def _find_institution(lines: List[str], degree_line_idx: int) -> Optional[str]:
    """
    Try to find the institution name near the degree line.
    Heuristic: look for a line that's short, title-cased, and
    doesn't contain degree keywords.
    """
    # Check surrounding lines (current, previous, next)
    candidates = []
    for offset in [0, -1, 1]:
        idx = degree_line_idx + offset
        if 0 <= idx < len(lines):
            candidates.append(lines[idx].strip())

    for candidate in candidates:
        if not candidate or len(candidate) > 80:
            continue

        # Skip if it's a degree line itself
        if any(re.search(p, candidate.lower()) for p, _ in _DEGREE_PATTERNS):
            # It's the degree line — try to extract institution from it
            # Pattern: "Master's in CS — Stanford University"
            parts = re.split(r'\s*[—\-|·,]\s*', candidate)
            for part in parts:
                part = part.strip()
                if part and not any(re.search(p, part.lower()) for p, _ in _DEGREE_PATTERNS):
                    if not any(f in part.lower() for f in _FIELD_PATTERNS):
                        if len(part) > 3:
                            return part
            continue

        # If it's a standalone line that looks like an institution name
        if candidate[0].isupper() and len(candidate.split()) <= 8:
            has_degree_word = any(w in candidate.lower() for w in ["bachelor", "master", "phd", "degree", "gpa"])
            if not has_degree_word:
                return candidate

    return None


# ═══════════════════════════════════════════════════════════════════
# DOMAIN DETECTION
# ═══════════════════════════════════════════════════════════════════

_DOMAIN_SIGNALS = {
    "backend": ["api", "rest", "graphql", "server", "microservice", "database", "sql", "fastapi", "django", "flask", "express"],
    "frontend": ["react", "vue", "angular", "css", "html", "ui", "ux", "responsive", "svelte", "tailwind", "next.js"],
    "fullstack": ["full stack", "full-stack", "fullstack"],
    "machine learning": ["machine learning", "ml", "deep learning", "neural", "pytorch", "tensorflow", "model training", "nlp", "computer vision"],
    "data engineering": ["etl", "pipeline", "spark", "airflow", "kafka", "data warehouse", "snowflake", "bigquery", "dbt"],
    "devops": ["ci/cd", "docker", "kubernetes", "terraform", "ansible", "jenkins", "deployment", "infrastructure"],
    "cloud": ["aws", "gcp", "azure", "cloud", "lambda", "s3", "ec2", "serverless"],
    "security": ["security", "penetration", "vulnerability", "encryption", "oauth", "authentication", "authorization"],
    "mobile": ["ios", "android", "react native", "flutter", "swift", "kotlin", "mobile app"],
}


def _detect_domains(text: str) -> List[str]:
    """Detect professional domains based on keyword signals."""
    text_lower = text.lower()
    domain_scores = {}

    for domain, signals in _DOMAIN_SIGNALS.items():
        score = sum(1 for signal in signals if signal in text_lower)
        if score >= 2:  # Need at least 2 signals to claim a domain
            domain_scores[domain] = score

    # Sort by score descending, return top domains
    sorted_domains = sorted(domain_scores.items(), key=lambda x: -x[1])
    return [d[0] for d in sorted_domains[:4]]


# ═══════════════════════════════════════════════════════════════════
# STAGE 2: LLM-BASED EXTRACTION (additive on top of rule-based)
# ═══════════════════════════════════════════════════════════════════

# Build canonical skill list for the LLM prompt
_CANONICAL_SKILLS = sorted(set(group[0] for group in SKILL_ALIASES))


def _llm_extract_structured(full_text: str, rule_based_result: Dict) -> Optional[Dict]:
    """
    Stage 2: Use GPT-4o-mini to extract structured data that rule-based missed.
    
    Key capabilities over regex:
      - Infers implicit skills (e.g., "deployed inference using vLLM" → Model Deployment, MLOps)
      - Understands conceptual equivalence (e.g., "evaluation workflows" → A/B Testing)
      - Catches skills described in context but never named explicitly
    
    Returns None if API key missing or call fails (graceful degradation).
    """
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        logger.info("No OPENAI_API_KEY — skipping LLM extraction (rule-based only)")
        return None

    # Build the prompt with canonical vocabulary
    rule_skills = rule_based_result.get("skills", [])
    rule_titles = rule_based_result.get("titles", [])
    rule_years = rule_based_result.get("years_exp")

    prompt = f"""You are an expert technical recruiter and resume analyst.

Analyze this resume text and extract structured information. Focus on identifying 
skills and technologies that are DEMONSTRATED or IMPLIED by the work described, 
even if not explicitly named.

CRITICAL INSTRUCTIONS:
1. Return ONLY skills from this canonical list (use exact spelling):
{json.dumps(_CANONICAL_SKILLS, indent=2)}

2. For each skill you identify, it must be either:
   - Explicitly mentioned in the resume, OR
   - Strongly implied by the described work (e.g., "deployed models to production with CI/CD pipelines" implies MLOps, Model Deployment, CI/CD)

3. Extract INFERRED skills that the candidate clearly has based on their work:
   Examples of inference:
   - "cross-validation, precision/recall tracking, evaluation workflows" → A/B Testing, Model Evaluation
   - "MLflow, drift monitoring, model deployment pipelines" → MLOps
   - "feature engineering, data processing, cleaning pipelines" → Data Preprocessing
   - "deployed inference using vLLM" → Model Deployment, vLLM
   - "fine-tuned StarCoder2" → Fine-tuning, LLM
   - "built RAG pipeline with FAISS" → RAG, Vector Search, FAISS, Embeddings

4. Also extract:
   - Job titles (standardized, e.g., "Software Engineer", "ML Engineer", "Founder")
   - Total years of professional experience (number)
   - Professional domains (from: backend, frontend, fullstack, machine learning, data engineering, devops, cloud, security, mobile)

5. Do NOT include skills the candidate does not demonstrate. Be accurate, not generous.

RESUME TEXT:
{full_text[:6000]}

Already found by rule-based extraction (for reference, do NOT limit yourself to these):
- Skills: {json.dumps(rule_skills)}
- Titles: {json.dumps(rule_titles)}
- Years: {rule_years}

Return ONLY valid JSON (no markdown, no backticks, no explanation):
{{
  "skills": ["Skill1", "Skill2", ...],
  "inferred_skills": {{"SkillName": "reasoning for inference", ...}},
  "titles": ["Title1", ...],
  "years_exp": <number or null>,
  "domains": ["domain1", ...]
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
                    {"role": "system", "content": "You are a precise resume analysis system. Return only valid JSON."},
                    {"role": "user", "content": prompt},
                ],
                "temperature": 0.1,
                "max_tokens": 1500,
            },
            timeout=15.0,
        )

        if response.status_code != 200:
            logger.warning(f"OpenAI API returned {response.status_code}: {response.text[:200]}")
            return None

        content = response.json()["choices"][0]["message"]["content"].strip()
        # Strip markdown fences if present
        content = re.sub(r'^```(?:json)?\s*', '', content)
        content = re.sub(r'\s*```$', '', content)

        result = json.loads(content)
        logger.info(
            f"LLM extraction: {len(result.get('skills', []))} skills "
            f"({len(result.get('inferred_skills', {}))} inferred)"
        )
        return result

    except json.JSONDecodeError as e:
        logger.warning(f"LLM returned invalid JSON: {e}")
        return None
    except Exception as e:
        logger.warning(f"LLM extraction failed: {e}")
        return None


def _merge_llm_results(rule_based: Dict, llm_result: Dict) -> Dict:
    """
    Merge LLM extraction into rule-based results.
    
    RULES:
      - LLM is ADDITIVE ONLY — never removes rule-based findings
      - Skills must be from canonical vocabulary (_CANONICAL_SKILLS)
      - Titles from LLM are added if not already present
      - years_exp: keep rule-based if available (date-range math is more precise)
      - Domains: union of both
      - Track which skills were inferred vs explicit for transparency
    """
    merged = {**rule_based}
    canonical_set = set(_CANONICAL_SKILLS)

    # ── Merge skills ──
    rule_skills = set(rule_based.get("skills", []))
    llm_skills_raw = llm_result.get("skills", [])
    inferred_map = llm_result.get("inferred_skills", {})

    # Filter LLM skills: must be canonical
    llm_skills_valid = set()
    for skill in llm_skills_raw:
        if skill in canonical_set:
            llm_skills_valid.add(skill)
        else:
            # Try case-insensitive lookup
            for canonical in canonical_set:
                if skill.lower() == canonical.lower():
                    llm_skills_valid.add(canonical)
                    break

    new_skills = llm_skills_valid - rule_skills
    merged["skills"] = sorted(rule_skills | llm_skills_valid)

    # Track what came from where
    merged["skills_rule_based"] = sorted(rule_skills)
    merged["skills_llm_added"] = sorted(new_skills)
    merged["skills_inferred"] = {
        k: v for k, v in inferred_map.items()
        if k in llm_skills_valid
    }

    logger.info(
        f"Skill merge: {len(rule_skills)} rule + {len(new_skills)} LLM-added "
        f"= {len(merged['skills'])} total"
    )

    # ── Merge titles ──
    rule_titles = set(t.lower() for t in rule_based.get("titles", []))
    llm_titles = llm_result.get("titles", [])
    for title in llm_titles:
        if title.lower() not in rule_titles:
            merged["titles"] = merged.get("titles", []) + [title]
            rule_titles.add(title.lower())

    # ── years_exp: prefer rule-based (date-range math is more precise) ──
    if merged.get("years_exp") is None and llm_result.get("years_exp"):
        merged["years_exp"] = llm_result["years_exp"]

    # ── Merge domains ──
    rule_domains = set(rule_based.get("domains", []))
    llm_domains = set(llm_result.get("domains", []))
    merged["domains"] = sorted(rule_domains | llm_domains)

    # ── Update extraction method ──
    merged["extraction_method"] = "hybrid"

    return merged


# ═══════════════════════════════════════════════════════════════════
# MAIN ENTRY POINT
# ═══════════════════════════════════════════════════════════════════

def extract_structured_data(sections: List[Dict], use_llm: bool = True) -> Dict:
    """
    Two-stage structured extraction from resume sections.

    Stage 1: Fast, rule-based, deterministic (always runs)
    Stage 2: LLM refinement via GPT-4o-mini (additive only, graceful fallback)

    The LLM layer catches implicit/inferred skills that regex can't detect:
      - "cross-validation, precision/recall tracking" → A/B Testing
      - "MLflow, drift monitoring" → MLOps  
      - "deployed inference using vLLM" → Model Deployment

    Args:
        sections: sections from section_parser.parse_sections()
        use_llm: whether to run Stage 2 (default True, set False for speed)

    Output: {
        "skills": ["Python", "FastAPI", "MLOps", ...],
        "skills_rule_based": [...],      # what Stage 1 found
        "skills_llm_added": [...],       # what Stage 2 added
        "skills_inferred": {...},        # reasoning for inferred skills
        "years_exp": 5.2,
        "titles": ["Software Engineer", "Backend Developer"],
        "companies": ["Google", "Stripe"],
        "education": [{"degree": "Master's", "field": "Computer Science", "institution": "MIT"}],
        "domains": ["backend", "cloud", "devops"],
        "extraction_method": "hybrid",   # or "rule_based" if LLM skipped/failed
        "confidence": { ... }
    }
    """
    full_text = " ".join(s["text"] for s in sections)

    # ── Stage 1: Rule-based (always runs) ──
    skills = _extract_skills(full_text)
    years_exp = _extract_years_experience(sections)
    titles, companies = _extract_roles_and_companies(sections)
    education = _extract_education(sections)
    domains = _detect_domains(full_text)

    confidence = {
        "skills": "high" if len(skills) >= 3 else "low",
        "years_exp": "high" if years_exp is not None else "low",
        "titles": "high" if len(titles) >= 1 else "low",
        "companies": "high" if len(companies) >= 1 else "low",
        "education": "high" if len(education) >= 1 else "low",
        "domains": "high" if len(domains) >= 1 else "low",
    }

    rule_based_result = {
        "skills": skills,
        "years_exp": years_exp,
        "titles": titles,
        "companies": companies,
        "education": education,
        "domains": domains,
        "extraction_method": "rule_based",
        "confidence": confidence,
    }

    logger.info(f"Stage 1 (rule-based): {len(skills)} skills, {years_exp} yrs, {len(titles)} titles")

    # ── Stage 2: LLM refinement (additive only) ──
    if use_llm:
        llm_result = _llm_extract_structured(full_text, rule_based_result)
        if llm_result:
            merged = _merge_llm_results(rule_based_result, llm_result)
            # Preserve fields LLM doesn't touch
            merged["companies"] = companies
            merged["education"] = education
            merged["confidence"] = confidence
            return merged

    # Fallback: rule-based only
    rule_based_result["skills_rule_based"] = skills
    rule_based_result["skills_llm_added"] = []
    rule_based_result["skills_inferred"] = {}
    return rule_based_result


# ═══════════════════════════════════════════════════════════════════
# UTILITIES
# ═══════════════════════════════════════════════════════════════════

def _dedupe(items: List[str]) -> List[str]:
    """Deduplicate list while preserving order."""
    seen = set()
    result = []
    for item in items:
        key = item.lower().strip()
        if key and key not in seen:
            seen.add(key)
            result.append(item)
    return result