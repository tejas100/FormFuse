"""
job_fetcher.py — Multi-source job fetcher for RACK watchlist pipeline.

Fetches jobs from:
  - Greenhouse Job Board API (OpenAI, Stripe, Notion, Anthropic, Ramp, etc.)
  - Lever Postings API (Netflix, etc.)
  - Remotive Public API (remote jobs)

All results normalized to a common JobListing schema.
"""

import asyncio
import logging
import httpx
import hashlib
from datetime import datetime, timezone
from typing import Optional

logger = logging.getLogger(__name__)

# ── Timeout & limits ────────────────────────────────────────────────
FETCH_TIMEOUT = 15.0  # seconds per API call
MAX_JOBS_PER_SOURCE = 100  # cap per company/source to avoid huge payloads

# ── Company lists — imported by auto_match.py ───────────────────────
GREENHOUSE_COMPANIES = [
    # AI / ML
    "anthropic", "cohere", "deepgram", "assemblyai", "elevenlabs",
    "runwayml", "adept", "cognition", "togetherai", "anyscale",
    "modal", "weightsandbiases", "pinecone", "weaviate", "langchain",
    # Fintech
    "stripe", "ramp", "brex", "plaid", "coinbase",
    "robinhood", "rippling", "mercury", "chime", "marqeta",
    # DevTools / Productivity
    "figma", "notion", "vercel", "supabase",
    "retool", "replit", "sentry", "posthog", "launchdarkly",
    "statsig", "grafana", "hashicorp", "temporal", "neon", "render",
    # Data / Analytics
    "datadog", "snowflake", "dbt-labs", "airbyte", "fivetran",
    "dagster", "prefect", "amplitude", "mixpanel", "hex",
    "cockroachlabs",
    # Cloud / Infra
    "cloudflare", "elastic", "mongodb",
    # Other tech
    "shopify", "twilio", "snyk", "lacework", "wiz",
    "benchling", "census", "eppo", "descript", "coda", "airtable", "miro",
]

ASHBY_COMPANIES = [
    # AI / ML — most live here
    "openai", "perplexity", "mistral",
    "linear", "arc",
    "together", "groq", "cartesia", "hedra",
    "sierra", "mem", "dust", "fixie",
    "coframe", "ema", "baseten",
    "vectara", "trieve", "contextual",
    # Infra / DevTools
    "turso", "trigger", "inngest", "depot",
    "zed", "highlight",
    # Fintech
    "mercury", "increase", "column",
]

LEVER_COMPANIES = [
    "netflix", "reddit", "lyft", "affirm",
    "duolingo", "eventbrite", "thumbtack",
]


# ── Normalized job schema ───────────────────────────────────────────
def _make_job_id(source: str, external_id: str) -> str:
    """Deterministic internal job ID from source + external ID."""
    raw = f"{source}:{external_id}"
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def _normalize_job(
    source: str,
    external_id: str,
    title: str,
    company: str,
    location: str,
    url: str,
    description_html: str = "",
    description_text: str = "",
    posted_at: Optional[str] = None,
    department: str = "",
    commitment: str = "",  # full-time, part-time, etc.
) -> dict:
    """Normalize a job listing from any source into a common schema."""
    # Strip HTML tags for plain text if only HTML provided
    if description_html and not description_text:
        import re
        description_text = re.sub(r"<[^>]+>", " ", description_html)
        description_text = re.sub(r"\s+", " ", description_text).strip()

    return {
        "job_id": _make_job_id(source, str(external_id)),
        "source": source,
        "external_id": str(external_id),
        "title": title.strip(),
        "company": company.strip(),
        "location": location.strip() if location else "Not specified",
        "url": url.strip(),
        "description_text": description_text,
        "description_html": description_html,
        "posted_at": posted_at,
        "department": department,
        "commitment": commitment,
        "fetched_at": datetime.now(timezone.utc).isoformat(),
    }


# ── Greenhouse ──────────────────────────────────────────────────────
async def fetch_greenhouse(board_token: str) -> list[dict]:
    """
    Fetch jobs from Greenhouse Job Board API.
    GET https://boards-api.greenhouse.io/v1/boards/{board_token}/jobs?content=true

    board_token examples: openai, stripe, notion, anthropic, ramp
    """
    url = f"https://boards-api.greenhouse.io/v1/boards/{board_token}/jobs?content=true"
    logger.info(f"[Greenhouse] Fetching jobs from: {board_token}")

    try:
        async with httpx.AsyncClient(timeout=FETCH_TIMEOUT) as client:
            resp = await client.get(url)
            resp.raise_for_status()
            data = resp.json()

        jobs_raw = data.get("jobs", [])[:MAX_JOBS_PER_SOURCE]
        jobs = []

        for j in jobs_raw:
            # Location: Greenhouse nests it in location.name
            loc = j.get("location", {}).get("name", "") if isinstance(j.get("location"), dict) else ""

            # Department
            dept = ""
            departments = j.get("departments", [])
            if departments and isinstance(departments[0], dict):
                dept = departments[0].get("name", "")

            # Posted date
            posted = j.get("updated_at") or j.get("created_at")

            jobs.append(_normalize_job(
                source="greenhouse",
                external_id=j["id"],
                title=j.get("title", "Unknown"),
                company=board_token,
                location=loc,
                url=j.get("absolute_url", ""),
                description_html=j.get("content", ""),
                posted_at=posted,
                department=dept,
            ))

        logger.info(f"[Greenhouse] {board_token}: {len(jobs)} jobs fetched")
        return jobs

    except httpx.HTTPStatusError as e:
        logger.error(f"[Greenhouse] {board_token} HTTP {e.response.status_code}: {e}")
        return []
    except Exception as e:
        logger.error(f"[Greenhouse] {board_token} error: {e}")
        return []


# ── Lever ───────────────────────────────────────────────────────────
async def fetch_lever(company: str) -> list[dict]:
    """
    Fetch jobs from Lever Postings API.
    GET https://api.lever.co/v0/postings/{company}
    """
    url = f"https://api.lever.co/v0/postings/{company}"
    logger.info(f"[Lever] Fetching jobs from: {company}")

    try:
        async with httpx.AsyncClient(timeout=FETCH_TIMEOUT) as client:
            resp = await client.get(url)
            resp.raise_for_status()
            jobs_raw = resp.json()

        if not isinstance(jobs_raw, list):
            logger.warning(f"[Lever] {company}: unexpected response format")
            return []

        jobs_raw = jobs_raw[:MAX_JOBS_PER_SOURCE]
        jobs = []

        for j in jobs_raw:
            # Lever has a 'categories' object with team, location, commitment
            cats = j.get("categories", {})

            # Description: Lever returns 'descriptionPlain' and lists of sections
            desc_text = j.get("descriptionPlain", "")
            # Also concat the additional lists (requirements, responsibilities)
            for section in j.get("lists", []):
                desc_text += "\n" + section.get("text", "") + "\n"
                desc_text += "\n".join(
                    item.get("content", "") if isinstance(item, dict) else str(item)
                    for item in section.get("items", [])
                )

            jobs.append(_normalize_job(
                source="lever",
                external_id=j["id"],
                title=j.get("text", "Unknown"),
                company=company,
                location=cats.get("location", ""),
                url=j.get("hostedUrl", ""),
                description_text=desc_text,
                posted_at=None,  # Lever timestamps are in ms epoch, handle if needed
                department=cats.get("team", ""),
                commitment=cats.get("commitment", ""),
            ))

        logger.info(f"[Lever] {company}: {len(jobs)} jobs fetched")
        return jobs

    except httpx.HTTPStatusError as e:
        logger.error(f"[Lever] {company} HTTP {e.response.status_code}: {e}")
        return []
    except Exception as e:
        logger.error(f"[Lever] {company} error: {e}")
        return []


# ── Remotive ────────────────────────────────────────────────────────
async def fetch_remotive(category: str = "", search: str = "", limit: int = 50) -> list[dict]:
    """
    Fetch remote jobs from Remotive API.
    GET https://remotive.com/api/remote-jobs?category=software-dev&search=python&limit=50

    Categories: software-dev, data, devops, machine-learning, etc.
    """
    params = {}
    if category:
        params["category"] = category
    if search:
        params["search"] = search
    if limit:
        params["limit"] = min(limit, MAX_JOBS_PER_SOURCE)

    url = "https://remotive.com/api/remote-jobs"
    logger.info(f"[Remotive] Fetching jobs (category={category}, search={search})")

    try:
        async with httpx.AsyncClient(timeout=FETCH_TIMEOUT) as client:
            resp = await client.get(url, params=params)
            resp.raise_for_status()
            data = resp.json()

        jobs_raw = data.get("jobs", [])[:MAX_JOBS_PER_SOURCE]
        jobs = []

        for j in jobs_raw:
            jobs.append(_normalize_job(
                source="remotive",
                external_id=j["id"],
                title=j.get("title", "Unknown"),
                company=j.get("company_name", "Unknown"),
                location=j.get("candidate_required_location", "Remote"),
                url=j.get("url", ""),
                description_html=j.get("description", ""),
                posted_at=j.get("publication_date"),
                department=j.get("category", ""),
                commitment=j.get("job_type", ""),
            ))

        logger.info(f"[Remotive] {len(jobs)} jobs fetched")
        return jobs

    except Exception as e:
        logger.error(f"[Remotive] error: {e}")
        return []


# ── Unified fetch ───────────────────────────────────────────────────
async def fetch_jobs_for_company(company: str, source: str) -> list[dict]:
    """Route to the correct fetcher based on source."""
    if source == "greenhouse":
        return await fetch_greenhouse(company)
    elif source == "lever":
        return await fetch_lever(company)
    else:
        logger.warning(f"Unknown source: {source}")
        return []


# ── Ashby ───────────────────────────────────────────────────────────
async def fetch_ashby(slug: str) -> list[dict]:
    """
    Fetch jobs from Ashby Job Board API.
    GET https://api.ashbyhq.com/posting-api/job-board/{slug}
    Returns {"jobPostings": [...]}

    slug examples: openai, perplexity, linear, groq
    """
    url = f"https://api.ashbyhq.com/posting-api/job-board/{slug}"
    logger.info(f"[Ashby] Fetching jobs from: {slug}")

    try:
        async with httpx.AsyncClient(timeout=FETCH_TIMEOUT) as client:
            resp = await client.get(url)
            if resp.status_code == 404:
                logger.debug(f"[Ashby] 404 for board: {slug}")
                return []
            resp.raise_for_status()
            data = resp.json()

        jobs_raw = data.get("jobPostings", [])[:MAX_JOBS_PER_SOURCE]
        jobs = []

        for j in jobs_raw:
            # Location: Ashby has locationName at top level
            loc = j.get("locationName", "") or j.get("location", "")

            # Department
            dept = j.get("departmentName", "")

            # Description: Ashby provides descriptionHtml and descriptionPlain
            desc_html = j.get("descriptionHtml", "")
            desc_text = j.get("descriptionPlain", "")

            # Posted date: publishedAt is ISO string
            posted = j.get("publishedAt") or j.get("updatedAt")

            # Apply URL
            url_apply = j.get("jobUrl", "") or j.get("applyUrl", "")

            jobs.append(_normalize_job(
                source="ashby",
                external_id=j.get("id", j.get("jobId", "")),
                title=j.get("title", "Unknown"),
                company=slug,
                location=loc,
                url=url_apply,
                description_html=desc_html,
                description_text=desc_text,
                posted_at=posted,
                department=dept,
            ))

        logger.info(f"[Ashby] {slug}: {len(jobs)} jobs fetched")
        return jobs

    except httpx.HTTPStatusError as e:
        logger.error(f"[Ashby] {slug} HTTP {e.response.status_code}: {e}")
        return []
    except Exception as e:
        logger.error(f"[Ashby] {slug} error: {e}")
        return []


# ── Unified auto-match fetch ─────────────────────────────────────────
async def fetch_all_auto_match(semaphore: asyncio.Semaphore) -> list[dict]:
    """
    Fetch all jobs across Greenhouse + Ashby + Lever for the auto-match pipeline.
    Called by auto_match.py — replaces the old inline _fetch_greenhouse() loop.

    Returns flat list of all normalized jobs.
    """
    async def _guarded(coro):
        async with semaphore:
            return await coro

    tasks = (
        [_guarded(fetch_greenhouse(token)) for token in GREENHOUSE_COMPANIES]
        + [_guarded(fetch_ashby(slug))     for slug   in ASHBY_COMPANIES]
        + [_guarded(fetch_lever(company))  for company in LEVER_COMPANIES]
    )
    results = await asyncio.gather(*tasks, return_exceptions=True)

    all_jobs = []
    total_companies = len(GREENHOUSE_COMPANIES) + len(ASHBY_COMPANIES) + len(LEVER_COMPANIES)
    failed = 0
    for r in results:
        if isinstance(r, Exception):
            failed += 1
        elif isinstance(r, list):
            all_jobs.extend(r)

    logger.info(
        f"[AutoMatch] Pool fetch complete: {len(all_jobs)} jobs from "
        f"{total_companies - failed}/{total_companies} sources ({failed} failed)"
    )
    return all_jobs


async def fetch_all_watchlist(watchlist_entries: list[dict]) -> list[dict]:
    """
    Fetch jobs for all companies in the watchlist.

    watchlist_entries: [{"company": "openai", "source": "greenhouse"}, ...]
    Returns: flat list of all normalized jobs.
    """
    import asyncio

    tasks = []
    for entry in watchlist_entries:
        tasks.append(fetch_jobs_for_company(entry["company"], entry["source"]))

    results = await asyncio.gather(*tasks, return_exceptions=True)

    all_jobs = []
    for i, result in enumerate(results):
        if isinstance(result, Exception):
            logger.error(f"Fetch failed for {watchlist_entries[i]}: {result}")
        elif isinstance(result, list):
            all_jobs.extend(result)

    logger.info(f"[Watchlist] Total jobs fetched: {len(all_jobs)} from {len(watchlist_entries)} sources")
    return all_jobs