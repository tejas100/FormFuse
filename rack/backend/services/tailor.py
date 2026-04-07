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

# ── GPT JSON prompt — content/ordering decisions only, zero layout ────────────
_TAILOR_JSON_PROMPT = """You are an expert resume writer and ATS optimization specialist.

Given a candidate's resume and a job description, return a JSON object that
re-orders bullet points within each job/project for maximum relevance to this role.

OUTPUT: Return ONLY valid JSON. No explanation, no markdown fences, no preamble.

Schema:
{
  "name": "Full Name",
  "contact": "Title | phone | email | linkedin | github",
  "experience": [
    {
      "company": "exact company name from resume",
      "role": "exact job title from resume",
      "period": "exact date range from resume",
      "bullets": ["full bullet text", ...]
    }
  ],
  "projects": [
    {
      "name": "exact project name from resume",
      "tech": "exact tech stack string from resume",
      "location": "location string or empty string",
      "bullets": ["full bullet text", ...]
    }
  ],
  "publications": [
    { "title": "exact title", "venue": "Published in IEEE / etc", "note": "achievement note" }
  ],
  "skills": [
    { "category": "AI / LLM", "items": "comma-separated skills verbatim" }
  ]
}

STRICT RULES:
1. Copy EVERY bullet VERBATIM — exact wording, exact metrics, exact punctuation.
   Do NOT paraphrase, shorten, combine, or summarize any bullet under any circumstance.
2. Reorder bullets WITHIN each job/project so the most JD-relevant come first.
   That is the ONLY permitted change to bullet content.
3. Keep ALL company names, job titles, dates, degree names, institution names exactly
   as they appear in the source resume.
4. Include ALL jobs, ALL projects, ALL publications, ALL skill categories — nothing omitted.
5. Skills items: copy verbatim. Only reorder the categories (most JD-relevant first).
6. Strip any leading bullet character (•, -, *) from bullet text strings.
   The renderer adds its own bullet markers.
7. Ignore any trailing lines that are just bullet characters (•) with no text.
   These are PDF extraction artifacts — do not include them as bullets.
8. publications array may be [] if source has none.
"""


# ── Python HTML renderer — all layout is here, GPT never touches CSS ─────────

def _render_html(data: dict) -> str:
    """
    Build pixel-perfect resume HTML from structured JSON.
    All spacing, fonts, and layout are controlled here — GPT makes zero layout decisions.
    """
    import html as _html

    def _clean(text: str) -> str:
        """Strip leading bullet chars, collapse whitespace, HTML-escape."""
        t = str(text).strip()
        # Strip leading bullet/dash chars that GPT or PDF extraction left
        t = re.sub(r'^[\u2022\-\*\·]+\s*', '', t).strip()
        # Skip lines that are ONLY a bullet char (PDF extraction artifacts)
        if re.fullmatch(r'[\u2022\s]+', t):
            return ''
        # Collapse any internal runs of whitespace (including &nbsp; artifacts)
        t = re.sub(r'\s+', ' ', t).strip()
        return _html.escape(t)

    def _bold_metrics(text: str) -> str:
        """Bold numeric metrics after HTML-escaping."""
        # Patterns: 40%, 70%, 30%, sub-200ms, 50K+, 99%, etc.
        text = re.sub(r'(\b\d+[KkMm]?\+?\s*users?\b)', r'<strong>\1</strong>', text)
        text = re.sub(r'(\bsub-\d+\w+\b)', r'<strong>\1</strong>', text)
        text = re.sub(r'(\b\d+(?:\.\d+)?%)', r'<strong>\1</strong>', text)
        return text

    name            = _clean(data.get("name", "Candidate"))
    contact_escaped = _html.escape(data.get("contact", "").strip())

    # ── Experience ────────────────────────────────────────────────────────────
    exp_html = ""
    for job in data.get("experience", []):
        bullets = [_clean(b) for b in job.get("bullets", []) if _clean(b)]
        bullets_html = "".join(f'<li>{_bold_metrics(b)}</li>' for b in bullets)
        exp_html += (
            f'<div style="margin-bottom:4px;">'
            f'<div style="display:flex;justify-content:space-between;align-items:baseline;">'
            f'<span style="font-size:10.5px;font-weight:700;color:#111;">'
            f'{_html.escape(job.get("company",""))}'
            f'</span>'
            f'<span style="font-size:9px;color:#555;">{_html.escape(job.get("period",""))}</span>'
            f'</div>'
            f'<div style="font-size:9.5px;color:#555;font-style:italic;margin-bottom:1px;">'
            f'{_html.escape(job.get("role",""))}</div>'
            f'<ul style="margin:0;padding-left:12px;">{bullets_html}</ul>'
            f'</div>'
        )

    # ── Projects ──────────────────────────────────────────────────────────────
    proj_html = ""
    for proj in data.get("projects", []):
        loc     = proj.get("location", "").strip()
        loc_span = (
            f'<span style="font-size:9px;color:#555;margin-left:6px;">{_html.escape(loc)}</span>'
            if loc else ""
        )
        bullets = [_clean(b) for b in proj.get("bullets", []) if _clean(b)]
        bullets_html = "".join(f'<li>{_bold_metrics(b)}</li>' for b in bullets)
        proj_html += (
            f'<div style="margin-bottom:4px;">'
            f'<div style="display:flex;justify-content:space-between;align-items:baseline;">'
            f'<span>'
            f'<span style="font-size:10px;font-weight:700;color:#111;">'
            f'{_html.escape(proj.get("name",""))}</span>'
            f'<span style="font-size:9px;color:#1a7a6e;font-style:italic;margin-left:5px;">'
            f'{_html.escape(proj.get("tech",""))}</span>'
            f'</span>'
            f'{loc_span}'
            f'</div>'
            f'<ul style="margin:1px 0 0;padding-left:12px;">{bullets_html}</ul>'
            f'</div>'
        )

    # ── Publications ──────────────────────────────────────────────────────────
    pub_html = ""
    for pub in data.get("publications", []):
        note = _clean(pub.get("note", ""))
        if not note:
            continue
        pub_html += (
            f'<div style="margin-bottom:3px;">'
            f'<span style="font-size:9.5px;font-weight:600;color:#111;">'
            f'{_html.escape(pub.get("title",""))}</span>'
            f'<span style="font-size:9px;color:#1a7a6e;margin-left:6px;">'
            f'{_html.escape(pub.get("venue",""))}</span>'
            f'<div style="font-size:9px;color:#333;padding-left:12px;">'
            f'&bull;&nbsp;{_bold_metrics(note)}</div>'
            f'</div>'
        )
    pub_section = (
        f'<div class="st">Publications</div>{pub_html}' if pub_html else ""
    )

    # ── Skills ────────────────────────────────────────────────────────────────
    skills_html = "".join(
        f'<div style="font-size:9.5px;color:#333;margin-bottom:1px;">'
        f'<span style="font-weight:700;color:#111;">{_html.escape(sk.get("category",""))}:</span>'
        f'&nbsp;{_html.escape(sk.get("items",""))}'
        f'</div>'
        for sk in data.get("skills", [])
    )

    return f"""<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
* {{ margin:0; padding:0; box-sizing:border-box; }}
body {{
  font-family: -apple-system, 'Segoe UI', Arial, sans-serif;
  font-size: 10px;
  line-height: 1.32;
  color: #222;
  background: #fff;
  padding: 0.27in 0.34in;
}}
.st {{
  font-size: 9.5px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: #1a7a6e;
  border-bottom: 0.7px solid #bbb;
  padding-bottom: 1px;
  margin-top: 6px;
  margin-bottom: 3px;
}}
ul {{ list-style: disc; }}
ul li {{
  font-size: 9.5px;
  color: #222;
  margin-bottom: 0.5px;
  line-height: 1.32;
  text-align: left;
  orphans: 3;
  widows: 3;
}}
@media print {{
  body {{ -webkit-print-color-adjust: exact; print-color-adjust: exact; }}
  @page {{ margin: 0; }}
}}
</style>
</head>
<body>

<div style="text-align:center;margin-bottom:3px;">
  <div style="font-size:19px;font-weight:700;color:#111;letter-spacing:-0.02em;">{name}</div>
  <div style="font-size:9px;color:#444;margin-top:1px;">{contact_escaped}</div>
</div>
<div style="height:1.5px;background:linear-gradient(to right,#1a7a6e,#6b35c4);margin:3px 0;"></div>

<div class="st">Education</div>
<div style="display:flex;justify-content:space-between;align-items:baseline;">
  <span style="font-size:10px;font-weight:700;color:#111;">New Jersey Institute of Technology</span>
  <span style="font-size:9px;color:#555;">Newark, NJ</span>
</div>
<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:2px;">
  <span style="font-size:9.5px;font-style:italic;color:#444;">Master&rsquo;s in Computer Science</span>
  <span style="font-size:9px;color:#555;">10/2023 &ndash; 05/2025</span>
</div>
<div style="display:flex;justify-content:space-between;align-items:baseline;">
  <span style="font-size:10px;font-weight:700;color:#111;">Visvesvaraya Technological University</span>
  <span style="font-size:9px;color:#555;">Mysuru, India</span>
</div>
<div style="display:flex;justify-content:space-between;align-items:baseline;">
  <span style="font-size:9.5px;font-style:italic;color:#444;">Bachelor&rsquo;s in Computer Science</span>
  <span style="font-size:9px;color:#555;">08/2017 &ndash; 08/2021</span>
</div>

<div class="st">Experience</div>
{exp_html}
<div class="st">Projects</div>
{proj_html}
{pub_section}
<div class="st">Technical Skills</div>
{skills_html}

</body>
</html>"""


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
            # Ashby API returned nothing (private board 401 or empty).
            # Fall through to Playwright — it can render the React SPA and read the DOM.
            logger.info(f"[tailor] Ashby API empty — falling through to Playwright browser")

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

        # ── Generic HTML scrape with Playwright fallback ──────────────────
        # First try a fast httpx GET (works for SSR boards like Microsoft Careers).
        # If that returns <100 chars (SPA shell), fall back to Playwright headless browser
        # which executes the JS and reads the fully-rendered DOM — same approach Claude Code uses.
        logger.info(f"[tailor] Generic HTML scrape for {url}")
        raw_text = ""
        try:
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
                        t = el.get_text(separator="\n", strip=True)
                        if len(t) > 200:
                            raw_text = "\n".join(l.strip() for l in t.splitlines() if l.strip())
                            break
                if not raw_text:
                    t = soup.get_text(separator="\n", strip=True)
                    raw_text = "\n".join(l.strip() for l in t.splitlines() if l.strip())
            except ImportError:
                t = re.sub(r"<[^>]+>", " ", html_content)
                raw_text = re.sub(r"\s+", " ", t).strip()

        except httpx.HTTPError as e:
            logger.warning(f"[tailor] httpx scrape failed: {e}")

        if len(raw_text) >= 200:
            return raw_text[:8000]

        # httpx got a SPA shell — try Playwright headless browser
        logger.info(f"[tailor] httpx returned short content ({len(raw_text)} chars), trying Playwright")
        try:
            from playwright.async_api import async_playwright
            async with async_playwright() as pw:
                browser = await pw.chromium.launch(headless=True)
                page    = await browser.new_page()
                await page.goto(url, wait_until="networkidle", timeout=20000)
                # Wait for any main content selector to appear
                for selector in ["main", '[role="main"]', "article", ".job-description", "#content"]:
                    try:
                        await page.wait_for_selector(selector, timeout=3000)
                        break
                    except Exception:
                        continue
                html_content = await page.content()
                await browser.close()

            from bs4 import BeautifulSoup
            soup = BeautifulSoup(html_content, "html.parser")
            for tag in soup(["script", "style", "nav", "header", "footer", "aside", "noscript", "iframe"]):
                tag.decompose()
            raw_text = soup.get_text(separator="\n", strip=True)
            raw_text = "\n".join(l.strip() for l in raw_text.splitlines() if l.strip())
            logger.info(f"[tailor] Playwright got {len(raw_text)} chars from {url}")

            if len(raw_text) >= 100:
                return raw_text[:8000]

        except ImportError:
            logger.warning("[tailor] Playwright not installed — skipping browser fallback")
        except Exception as e:
            logger.warning(f"[tailor] Playwright failed: {e}")

        # Both methods failed — tell user to paste
        raise ValueError(
            "Couldn't fetch this job posting automatically (the page requires a browser to load). "
            "Copy the job description text and paste it directly instead of the URL."
        )

    except httpx.HTTPError as e:
        logger.warning(f"[tailor] URL fetch failed for {url}: {e}")
        raise ValueError(f"Could not fetch job URL: {e}")
    except ValueError:
        raise
    except Exception as e:
        logger.warning(f"[tailor] Unexpected fetch error for {url}: {e}")
        raise ValueError(f"Failed to load job URL: {e}")


# ── GPT call + Python render ──────────────────────────────────────────────────

async def _generate_tailored_html(resume_full_text: str, jd_text: str) -> str:
    """
    Two-step pipeline:
      Step 1 — GPT returns structured JSON (ordering only, verbatim bullets)
      Step 2 — Python renders HTML with hardcoded CSS (no GPT layout decisions)
    """
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise ValueError("OPENAI_API_KEY not configured")

    user_message = (
        f"SOURCE RESUME:\n{resume_full_text[:6000]}\n\n"
        f"===\n\n"
        f"JOB DESCRIPTION:\n{jd_text[:4000]}\n\n"
        f"Return the JSON object. Copy every bullet VERBATIM — only reorder within each job/project. "
        f"Ignore any trailing lines that are just bullet characters with no text."
    )

    async with httpx.AsyncClient() as client:
        response = await client.post(
            "https://api.openai.com/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model":       LLM_MODEL,
                "messages":    [
                    {"role": "system", "content": _TAILOR_JSON_PROMPT},
                    {"role": "user",   "content": user_message},
                ],
                "temperature": 0.1,
                "max_tokens":  3000,
            },
            timeout=LLM_TIMEOUT,
        )

    if response.status_code != 200:
        raise ValueError(f"LLM API error {response.status_code}: {response.text[:200]}")

    raw = response.json()["choices"][0]["message"]["content"].strip()
    raw = re.sub(r"^```(?:json)?\s*", "", raw)
    raw = re.sub(r"\s*```$",          "", raw)

    try:
        resume_data = json.loads(raw)
    except json.JSONDecodeError as e:
        logger.error(f"[tailor] JSON parse failed: {e}\nRaw snippet: {raw[:400]}")
        raise ValueError("LLM returned invalid JSON. Please try again.")

    return _render_html(resume_data)


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


# ── Streaming entry point (SSE) ───────────────────────────────────────────────

async def run_tailor_pipeline_streaming(
    jd_input: str,
    user_id: uuid.UUID,
    db: AsyncSession,
):
    """
    Same pipeline as run_tailor_pipeline but yields SSE-ready dicts at each step.

    Yields dicts:
      {"type": "step", "step": "<id>", "status": "start"|"done"|"error", "label": "<human label>"}
      {"type": "result", ...full result fields...}   <- on success
      {"type": "error",  "detail": "..."}            <- on failure
    """

    def _step(step: str, status: str, label: str) -> dict:
        return {"type": "step", "step": step, "status": status, "label": label}

    try:
        # ── Step 1: Resolve JD text ──────────────────────────────────────────
        url_pattern = re.compile(r"^https?://", re.IGNORECASE)
        is_url = bool(url_pattern.match(jd_input.strip()))

        yield _step("fetch_jd", "start", "Fetching job description" if is_url else "Reading job description")

        if is_url:
            logger.info(f"[tailor] Fetching JD from URL: {jd_input.strip()}")
            jd_text = await fetch_job_description(jd_input.strip())
        else:
            jd_text = jd_input.strip()

        if len(jd_text) < 50:
            yield _step("fetch_jd", "error", "Fetching job description")
            yield {"type": "error", "detail": "Job description too short to process."}
            return

        yield _step("fetch_jd", "done", "Fetching job description" if is_url else "Reading job description")

        # ── Step 2: Run match pipeline to rank resumes ───────────────────────
        yield _step("match_resumes", "start", "Finding your best-fit resume")

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
            yield _step("match_resumes", "error", "Finding your best-fit resume")
            yield {"type": "error", "detail": "No resumes found. Upload at least one resume first."}
            return

        parsed_jd = match_result.get("jd_parsed", {})
        jd_title  = parsed_jd.get("title", "this role")

        yield _step("match_resumes", "done", "Finding your best-fit resume")

        # ── Step 3: LLM-score all resumes, take #1 ──────────────────────────
        yield _step("score_resumes", "start", "Scoring resumes with AI")

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

        yield _step("score_resumes", "done", "Scoring resumes with AI")

        # ── Step 4: Get full_text for the top resume ─────────────────────────
        full_text = top.get("full_text")
        if not full_text:
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
            yield {"type": "error", "detail": f"Resume '{top_resume_name}' has no full text. Please re-upload it to enable tailoring."}
            return

        # ── Step 5: Generate tailored HTML via GPT ───────────────────────────
        yield _step("generate_resume", "start", "Tailoring resume for this role")

        logger.info(f"[tailor] Generating tailored HTML for resume={top_resume_id} × job={jd_title}")
        tailored_html = await _generate_tailored_html(full_text, jd_text)

        yield _step("generate_resume", "done", "Tailoring resume for this role")

        # ── Step 6: HTML → PDF ───────────────────────────────────────────────
        yield _step("generate_pdf", "start", "Generating PDF")

        logger.info(f"[tailor] Converting HTML to PDF")
        pdf_bytes = _html_to_pdf(tailored_html)

        # ── Step 7: Upload to Supabase Storage ───────────────────────────────
        logger.info(f"[tailor] Uploading PDF to Supabase Storage")
        storage_path, download_url = _upload_pdf_to_storage(user_id, top_resume_id, pdf_bytes)

        yield _step("generate_pdf", "done", "Generating PDF")

        logger.info(
            f"[tailor] Done — resume={top_resume_name}, score={match_score}, "
            f"path={storage_path}"
        )

        # ── Final result event ───────────────────────────────────────────────
        yield {
            "type":               "result",
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

    except ValueError as e:
        yield {"type": "error", "detail": str(e)}
    except Exception as e:
        logger.error(f"[tailor] Unexpected error in streaming pipeline for user={user_id}: {e}", exc_info=True)
        yield {"type": "error", "detail": "Tailoring failed. Please try again."}