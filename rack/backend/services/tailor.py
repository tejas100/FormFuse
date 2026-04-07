"""
services/tailor.py — Tailored resume PDF generation for RACK

Pipeline:
  1. Parse JD text (reuses jd_parser.py)
  2. Run existing match pipeline → get ranked resumes
  3. Take results[0] — best matching resume
  4. Fetch resume.full_text from DB
  5. Call GPT-4o-mini → writes complete tailored HTML resume
  6. WeasyPrint → PDF bytes
  7. Upload to Supabase Storage: {user_id}/tailored/{resume_id}_{timestamp}.pdf
  8. Return signed URL + match metadata

Auth: authenticated users only (requires full_text in DB)
"""

import logging
import os
import re
import json
import uuid
from datetime import datetime, timezone
from typing import Optional

import httpx
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

logger = logging.getLogger(__name__)

LLM_MODEL   = "gpt-4o-mini"
LLM_TIMEOUT = 60.0  # longer timeout — HTML generation is a big output

# Supabase Storage config
STORAGE_BUCKET = "resumes"

# ── HTML Resume Template ──────────────────────────────────────────────────────
# Embedded template — GPT writes content into this structure.
# Design: Space Grotesk headers, DM Sans body, teal/purple accent (same as career-ops).
# Web-safe font fallbacks so WeasyPrint renders correctly without woff2 files.

_HTML_TEMPLATE_STRUCTURE = """
The HTML document must follow this exact structure and styling. 
Use inline CSS only. No external fonts (use system font stack).

DOCTYPE and head:
  <meta charset="UTF-8">
  body font: font-family: -apple-system, 'Segoe UI', Arial, sans-serif; font-size: 11px; 
  line-height: 1.5; color: #1a1a2e; background: #ffffff; padding: 0.55in; margin: 0;

Header section:
  - Candidate full name: font-size 24px, font-weight 700, color #1a1a2e, letter-spacing -0.02em
  - Gradient divider line: height 2px, background linear-gradient(to right, #1a7a6e, #6b35c4), margin 6px 0
  - Contact row: font-size 10px, color #555, flex wrap, gap 16px, separator "|"

Section structure (repeat for each section):
  - Section title: font-size 12px, font-weight 700, text-transform uppercase, 
    letter-spacing 0.06em, color #1a7a6e, border-bottom 1px solid #e5e5e5, 
    padding-bottom 3px, margin-bottom 8px, margin-top 14px
  
  Sections in order: Professional Summary, Core Competencies, Work Experience, 
  Projects, Education, Skills

Competency tags (Core Competencies section):
  - display flex, flex-wrap wrap, gap 6px
  - Each tag: font-size 10px, color #1a7a6e, background #f0faf9, 
    padding 3px 10px, border-radius 3px, border 1px solid #c5e8e4

Work experience entries:
  - Company name: font-size 12px, font-weight 600, color #6b35c4
  - Period: font-size 10px, color #777, float right
  - Role title: font-size 11px, font-weight 500, color #444, margin-bottom 3px
  - Bullet list: padding-left 16px, font-size 10.5px, color #333, line-height 1.5
  - Bold key metrics and achievements inline

Project entries:
  - Project name: font-size 11px, font-weight 600, color #6b35c4
  - Tech badge: font-size 9px, color #1a7a6e, background #f0faf9, 
    padding 1px 6px, border-radius 2px, margin-left 6px
  - Description: font-size 10.5px, color #444, margin-top 2px
  - Tech stack line: font-size 9.5px, color #888, margin-top 2px

Education entries:
  - Degree + institution inline, font-size 11px
  - Institution name in color #6b35c4, font-weight 500
  - Year: font-size 10px, color #777, float right

Skills section:
  - font-size 10.5px, color #444, line-height 1.8
  - Category labels: font-weight 600, color #333

Print CSS:
  @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }

Page target: fit on ONE page. Be aggressive with spacing if needed.
"""

_TAILOR_SYSTEM_PROMPT = f"""You are an expert resume writer and ATS optimization specialist.

Given a candidate's source resume and a job description, rewrite the resume as a 
complete, single-page, ATS-optimized HTML document tailored specifically for this role.

RULES — follow these exactly:
1. Use ONLY facts from the source resume — never invent experience, metrics, or skills
2. Reorder bullet points to lead with the most relevant content for this specific JD
3. Reframe existing bullet points using JD keywords naturally (do not keyword-stuff)
4. Rewrite the Professional Summary to speak directly to this role's needs
5. Select Core Competency tags from the JD's required/preferred skills that the candidate genuinely has
6. Lead work experience with the most relevant role for this JD
7. Trim or compress less-relevant content to keep to ONE page
8. Bold key metrics, outcomes, and role-critical achievements inline
9. Keep all dates, company names, and education exactly as in the source resume

HTML STRUCTURE REQUIREMENTS:
{_HTML_TEMPLATE_STRUCTURE}

Return ONLY the complete HTML document. No explanation, no markdown, no backticks.
Start with <!DOCTYPE html> and end with </html>.
"""


# ── Known job board API patterns ─────────────────────────────────────────────
# Ashby, Greenhouse, and Lever are React SPAs — their HTML is an empty shell.
# We detect the URL pattern and call their public JSON APIs directly.

_ASHBY_JOB_RE      = re.compile(r"jobs\.ashbyhq\.com/([^/?]+)/([0-9a-f-]{36})", re.IGNORECASE)
_GREENHOUSE_JOB_RE = re.compile(r"boards\.greenhouse\.io/[^/]+/jobs/(\d+)", re.IGNORECASE)
_LEVER_JOB_RE      = re.compile(r"jobs\.lever\.co/[^/]+/([0-9a-f-]{36})", re.IGNORECASE)


async def _fetch_ashby_api(job_id: str, company_slug: str = "") -> str:
    if company_slug:
        api_url = f"https://api.ashbyhq.com/posting-api/job-posting/{company_slug}/{job_id}"
    else:
        api_url = f"https://api.ashbyhq.com/posting-api/job-posting/{job_id}"
    async with httpx.AsyncClient(follow_redirects=True, timeout=15.0) as client:
        r = await client.get(api_url, headers={"User-Agent": "Mozilla/5.0"})
        if r.status_code == 401:
            # Private board — API requires auth we don't have. Return empty to fall through.
            logger.info(f"[tailor] Ashby API 401 for {company_slug}/{job_id} — board is private, falling through")
            return ""
        r.raise_for_status()
        data = r.json()

    parts = []
    if data.get("title"):
        parts.append(f"Role: {data['title']}")
    if data.get("locationName"):
        parts.append(f"Location: {data['locationName']}")
    if data.get("employmentType"):
        parts.append(f"Type: {data['employmentType']}")

    # Try plain text first, fall back to stripping HTML
    desc = data.get("descriptionPlain") or ""
    if not desc:
        html = data.get("descriptionHtml") or ""
        try:
            from bs4 import BeautifulSoup
            desc = BeautifulSoup(html, "html.parser").get_text(separator="\n", strip=True)
        except ImportError:
            desc = re.sub(r"<[^>]+>", " ", html)
    if desc:
        parts.append(desc)

    # Some Ashby postings put requirements in descriptionSections list
    sections = data.get("descriptionSections") or []
    for section in sections:
        if isinstance(section, dict):
            s_html = section.get("descriptionHtml") or section.get("description") or ""
            if s_html:
                try:
                    from bs4 import BeautifulSoup
                    parts.append(BeautifulSoup(s_html, "html.parser").get_text(separator="\n", strip=True))
                except ImportError:
                    parts.append(re.sub(r"<[^>]+>", " ", s_html))

    return "\n\n".join(p.strip() for p in parts if p.strip())[:8000]


async def _fetch_greenhouse_api(job_id: str, board_slug: str = "") -> str:
    if board_slug:
        api_url = f"https://boards-api.greenhouse.io/v1/boards/{board_slug}/jobs/{job_id}"
    else:
        api_url = f"https://boards-api.greenhouse.io/v1/boards/jobs/{job_id}"
    async with httpx.AsyncClient(follow_redirects=True, timeout=15.0) as client:
        r = await client.get(api_url, headers={"User-Agent": "Mozilla/5.0"})
        r.raise_for_status()
        data = r.json()

    parts = []
    if data.get("title"):
        parts.append(f"Role: {data['title']}")
    if data.get("location", {}).get("name"):
        parts.append(f"Location: {data['location']['name']}")
    html = data.get("content") or ""
    if html:
        try:
            from bs4 import BeautifulSoup
            parts.append(BeautifulSoup(html, "html.parser").get_text(separator="\n", strip=True))
        except ImportError:
            parts.append(re.sub(r"<[^>]+>", " ", html))
    return "\n\n".join(p.strip() for p in parts if p.strip())[:8000]


async def _fetch_lever_api(job_id: str) -> str:
    api_url = f"https://api.lever.co/v0/postings/{job_id}"
    async with httpx.AsyncClient(follow_redirects=True, timeout=15.0) as client:
        r = await client.get(api_url, headers={"User-Agent": "Mozilla/5.0"})
        r.raise_for_status()
        data = r.json()

    parts = []
    if data.get("text"):
        parts.append(f"Role: {data['text']}")
    if data.get("categories", {}).get("location"):
        parts.append(f"Location: {data['categories']['location']}")
    for section in data.get("lists") or []:
        label = section.get("text", "")
        content_html = section.get("content", "")
        try:
            from bs4 import BeautifulSoup
            content_text = BeautifulSoup(content_html, "html.parser").get_text(separator="\n", strip=True)
        except ImportError:
            content_text = re.sub(r"<[^>]+>", " ", content_html)
        parts.append(f"{label}:\n{content_text}" if label else content_text)
    desc_html = data.get("descriptionPlain") or data.get("description") or ""
    if desc_html:
        try:
            from bs4 import BeautifulSoup
            parts.append(BeautifulSoup(desc_html, "html.parser").get_text(separator="\n", strip=True))
        except ImportError:
            parts.append(re.sub(r"<[^>]+>", " ", desc_html))
    return "\n\n".join(p.strip() for p in parts if p.strip())[:8000]


async def fetch_job_description(url: str) -> str:
    """
    Fetch a job posting URL and return cleaned JD text.

    Ashby / Greenhouse / Lever are React SPAs — their page HTML is an empty
    shell that loads content via JS. We detect the URL pattern and call their
    public JSON APIs directly, which always returns full job content.

    For any other job board we fall back to a BeautifulSoup HTML scrape.
    """
    try:
        # ── Ashby ──────────────────────────────────────────────────────────
        m = _ASHBY_JOB_RE.search(url)
        if m:
            company_slug = m.group(1)
            job_id = m.group(2)
            logger.info(f"[tailor] Ashby URL detected — calling posting API for {company_slug}/{job_id}")
            text = await _fetch_ashby_api(job_id, company_slug)
            if len(text) >= 50:
                return text
            logger.warning("[tailor] Ashby API returned short content, falling through")

        # ── Greenhouse ─────────────────────────────────────────────────────
        m = _GREENHOUSE_JOB_RE.search(url)
        if m:
            # Extract board slug from URL: boards.greenhouse.io/{slug}/jobs/{id}
            slug_match = re.search(r"boards\.greenhouse\.io/([^/]+)/jobs", url, re.I)
            board_slug = slug_match.group(1) if slug_match else ""
            logger.info(f"[tailor] Greenhouse URL detected — calling boards API for {m.group(1)}")
            try:
                text = await _fetch_greenhouse_api(m.group(1), board_slug)
                if len(text) >= 50:
                    return text
            except Exception as e:
                logger.warning(f"[tailor] Greenhouse API failed: {e} — falling through")

        # ── Lever ──────────────────────────────────────────────────────────
        m = _LEVER_JOB_RE.search(url)
        if m:
            logger.info(f"[tailor] Lever URL detected — calling posting API for {m.group(1)}")
            try:
                text = await _fetch_lever_api(m.group(1))
                if len(text) >= 50:
                    return text
            except Exception as e:
                logger.warning(f"[tailor] Lever API failed: {e} — falling through")

        # ── Generic HTML scrape (all other job boards + SPA fallback) ────────
        logger.info(f"[tailor] Generic HTML scrape for {url}")
        async with httpx.AsyncClient(follow_redirects=True, timeout=15.0) as client:
            response = await client.get(
                url,
                headers={
                    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                    "Accept-Language": "en-US,en;q=0.9",
                },
            )
            response.raise_for_status()
            html_content = response.text

        try:
            from bs4 import BeautifulSoup
            soup = BeautifulSoup(html_content, "html.parser")
            for tag in soup(["script", "style", "nav", "header", "footer", "aside", "noscript", "iframe"]):
                tag.decompose()
            for attrs in [{"role": "main"}, {"id": "content"}, {"class": "job-description"}]:
                el = soup.find(attrs=attrs)
                if el:
                    text = el.get_text(separator="\n", strip=True)
                    if len(text) > 200:
                        return "\n".join(l.strip() for l in text.splitlines() if l.strip())[:8000]
            text = soup.get_text(separator="\n", strip=True)
            lines = [l.strip() for l in text.splitlines() if l.strip()]
            text = "\n".join(lines)
            if len(text) < 100:
                # SPA with no server-rendered content — guide user to paste JD directly
                raise ValueError(
                    "This job board loads content dynamically and can't be scraped automatically. "
                    "Please copy and paste the job description text directly instead of the URL."
                )
            return text[:8000]
        except ImportError:
            text = re.sub(r"<[^>]+>", " ", html_content)
            text = re.sub(r"\s+", " ", text).strip()
            if len(text) < 100:
                raise ValueError(
                    "This job board loads content dynamically and can't be scraped automatically. "
                    "Please copy and paste the job description text directly instead of the URL."
                )
            return text[:8000]

    except httpx.HTTPError as e:
        logger.warning(f"[tailor] URL fetch failed for {url}: {e}")
        raise ValueError(f"Could not fetch job URL: {e}")
    except ValueError:
        raise
    except Exception as e:
        logger.warning(f"[tailor] Unexpected fetch error for {url}: {e}")
        raise ValueError(f"Failed to load job URL: {e}")


# ── GPT HTML Generation ───────────────────────────────────────────────────────

async def _generate_tailored_html(resume_full_text: str, jd_text: str) -> str:
    """
    Call GPT-4o-mini to generate a complete tailored HTML resume.
    Returns the HTML string.
    """
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise ValueError("OPENAI_API_KEY not configured")

    user_message = f"""SOURCE RESUME:
{resume_full_text[:6000]}

===

JOB DESCRIPTION:
{jd_text[:4000]}

Generate the complete tailored HTML resume for this role."""

    async with httpx.AsyncClient() as client:
        response = await client.post(
            "https://api.openai.com/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": LLM_MODEL,
                "messages": [
                    {"role": "system", "content": _TAILOR_SYSTEM_PROMPT},
                    {"role": "user",   "content": user_message},
                ],
                "temperature": 0.3,
                "max_tokens": 4000,
            },
            timeout=LLM_TIMEOUT,
        )

    if response.status_code != 200:
        raise ValueError(f"LLM API error {response.status_code}: {response.text[:200]}")

    content = response.json()["choices"][0]["message"]["content"].strip()

    # Strip markdown fences if model wrapped the HTML
    content = re.sub(r"^```(?:html)?\s*", "", content)
    content = re.sub(r"\s*```$", "", content)

    if not content.startswith("<!DOCTYPE") and not content.startswith("<html"):
        raise ValueError("LLM did not return valid HTML")

    return content


# ── HTML → PDF ────────────────────────────────────────────────────────────────

def _html_to_pdf(html_content: str) -> bytes:
    """
    Convert HTML string to PDF bytes using WeasyPrint.
    """
    try:
        from weasyprint import HTML
        pdf_bytes = HTML(string=html_content).write_pdf()
        return pdf_bytes
    except ImportError:
        raise ValueError("WeasyPrint not installed. Run: pip install weasyprint")
    except Exception as e:
        logger.error(f"[tailor] WeasyPrint PDF generation failed: {e}")
        raise ValueError(f"PDF generation failed: {e}")


# ── Supabase Storage upload ───────────────────────────────────────────────────

def _upload_pdf_to_storage(
    user_id: uuid.UUID,
    resume_id: str,
    pdf_bytes: bytes,
) -> tuple[str, str]:
    """
    Upload tailored PDF to Supabase Storage.
    Returns (storage_path, signed_url).
    """
    from supabase import create_client

    supabase_url = os.getenv("SUPABASE_URL")
    service_key  = os.getenv("SUPABASE_SERVICE_KEY")
    supabase     = create_client(supabase_url, service_key)

    timestamp    = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    filename     = f"tailored_{resume_id[:8]}_{timestamp}.pdf"
    storage_path = f"{user_id}/tailored/{filename}"

    try:
        supabase.storage.from_(STORAGE_BUCKET).upload(
            path=storage_path,
            file=pdf_bytes,
            file_options={"content-type": "application/pdf", "upsert": "true"},
        )
    except Exception as e:
        logger.error(f"[tailor] Storage upload failed: {e}")
        raise ValueError(f"Failed to upload PDF to storage: {e}")

    try:
        result = supabase.storage.from_(STORAGE_BUCKET).create_signed_url(
            path=storage_path,
            expires_in=3600,  # 1 hour
        )
        signed_url = result.get("signedURL") or result.get("signedUrl", "")
    except Exception as e:
        logger.error(f"[tailor] Signed URL generation failed: {e}")
        raise ValueError(f"Failed to generate download URL: {e}")

    return storage_path, signed_url


# ── Main entry point ──────────────────────────────────────────────────────────

async def run_tailor_pipeline(
    jd_input: str,          # raw JD text OR a URL (https://...)
    user_id: uuid.UUID,
    db: AsyncSession,
) -> dict:
    """
    Full tailor pipeline. Returns a result dict:
    {
        "status": "ok",
        "resume_id": str,
        "resume_name": str,
        "match_score": int,
        "llm_recommendation": str,
        "llm_reasoning": str,
        "key_strengths": list,
        "key_gaps": list,
        "download_url": str,
        "jd_title": str,
    }
    """
    # ── Step 1: Resolve JD text ──────────────────────────────────────────────
    url_pattern = re.compile(r"^https?://", re.IGNORECASE)
    if url_pattern.match(jd_input.strip()):
        logger.info(f"[tailor] Fetching JD from URL: {jd_input.strip()}")
        jd_text = await fetch_job_description(jd_input.strip())
    else:
        jd_text = jd_input.strip()

    if len(jd_text) < 50:
        raise ValueError("Job description too short to process.")

    # ── Step 2: Run match pipeline to rank resumes ───────────────────────────
    from services.matcher import match_resumes
    from services.llm_scorer import llm_score_batch, rerank_by_llm_score
    from services.jd_parser import parse_jd

    match_result = await match_resumes(
        jd_text=jd_text,
        user_id=str(user_id),
        use_llm=False,
        db=db,
    )

    if not match_result.get("results"):
        raise ValueError("No resumes found. Upload at least one resume first.")

    parsed_jd = match_result.get("jd_parsed", {})
    jd_title  = parsed_jd.get("title", "this role")

    # ── Step 3: LLM-score all resumes, take #1 ──────────────────────────────
    job_ctx = {
        "job_title":        jd_title,
        "company":          "",
        "description_text": jd_text,
    }

    pairs = []
    for match in match_result["results"]:
        hybrid_score = match.get("score", 0)
        if isinstance(hybrid_score, float) and hybrid_score <= 1.0:
            hybrid_score = round(hybrid_score * 100)
        else:
            hybrid_score = int(hybrid_score)

        resume_dict = {
            "id":        match["resume_id"],
            "name":      match.get("name", ""),
            "full_text": match.get("full_text"),
            "structured": {
                "years_exp": match.get("years_exp"),
                "titles":    match.get("titles", []),
                "domains":   match.get("domains", []),
                "skills":    match.get("skills", []),
            },
        }

        pairs.append({
            **match,
            "hybrid_score": hybrid_score,
            "job":          job_ctx,
            "resume":       resume_dict,
            "parsed_jd":    parsed_jd,
        })

    enriched = await llm_score_batch(pairs)
    enriched = rerank_by_llm_score(enriched)
    top       = enriched[0]

    top_resume_id   = top.get("resume_id", "")
    top_resume_name = top.get("name", "resume")
    match_score     = top.get("llm_score", top.get("hybrid_score", 0))

    # ── Step 4: Get full_text for the top resume ─────────────────────────────
    full_text = top.get("full_text")
    if not full_text:
        # Fetch from DB directly
        from models.orm import Resume as ResumeORM
        result = await db.execute(
            select(ResumeORM).where(
                ResumeORM.id == uuid.UUID(top_resume_id),
                ResumeORM.user_id == user_id,
            )
        )
        resume_row = result.scalar_one_or_none()
        if resume_row:
            full_text = resume_row.full_text

    if not full_text:
        raise ValueError(
            f"Resume '{top_resume_name}' has no full text. "
            "Please re-upload it to enable tailoring."
        )

    # ── Step 5: Generate tailored HTML via GPT ───────────────────────────────
    logger.info(f"[tailor] Generating tailored HTML for resume={top_resume_id} × job={jd_title}")
    tailored_html = await _generate_tailored_html(full_text, jd_text)

    # ── Step 6: HTML → PDF ───────────────────────────────────────────────────
    logger.info(f"[tailor] Converting HTML to PDF")
    pdf_bytes = _html_to_pdf(tailored_html)

    # ── Step 7: Upload to Supabase Storage ───────────────────────────────────
    logger.info(f"[tailor] Uploading PDF to Supabase Storage")
    storage_path, download_url = _upload_pdf_to_storage(user_id, top_resume_id, pdf_bytes)

    logger.info(
        f"[tailor] Done — resume={top_resume_name}, score={match_score}, "
        f"path={storage_path}"
    )

    return {
        "status":             "ok",
        "resume_id":          top_resume_id,
        "resume_name":        top_resume_name,
        "match_score":        match_score,
        "llm_recommendation": top.get("llm_recommendation", ""),
        "llm_reasoning":      top.get("llm_reasoning", ""),
        "key_strengths":      top.get("llm_key_strengths", []),
        "key_gaps":           top.get("llm_key_gaps", []),
        "download_url":       download_url,
        "jd_title":           jd_title,
    }