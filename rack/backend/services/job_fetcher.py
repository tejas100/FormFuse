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
# No MAX_JOBS_PER_SOURCE cap — fetch all jobs a company posts.
# The role filter in auto_match.py handles reduction downstream.

# ── Company lists — imported by auto_match.py ───────────────────────
GREENHOUSE_COMPANIES = [
    # ── AI / ML ──────────────────────────────────────────────────────
    # Confirmed alive from live run (2026-04-02)
    "anthropic",          # 432 jobs
    "assemblyai",         # 6 jobs
    "runwayml",           # 36 jobs
    "togetherai",         # 47 jobs
    "scaleai",            # 168 jobs
    "nanonets",           # 22 jobs
    "profluent",          # 8 jobs
    "hebbia",             # 29 jobs
    # Confirmed alive from web search (job-boards.greenhouse.io/{slug})
    "xai",                # xAI (Elon Musk's AI lab)
    "netskope",           # Netskope — AI-powered SASE/security
    "stackav",            # Stack AV — autonomous trucking AI

    # ── Fintech ───────────────────────────────────────────────────────
    # Confirmed alive from live run
    "stripe",             # 494 jobs
    "brex",               # 248 jobs
    "coinbase",           # 193 jobs
    "robinhood",          # 152 jobs
    "mercury",            # 53 jobs
    "chime",              # 60 jobs
    "marqeta",            # 27 jobs
    "gusto",              # 77 jobs
    "checkr",             # 57 jobs
    "toast",              # 307 jobs
    "affirm",             # 154 jobs
    "upstart",            # 69 jobs
    "fireblocks",         # 63 jobs
    "alchemy",            # 17 jobs — Web3 infra
    "ziprecruiter",       # 33 jobs
    # Confirmed alive from web search
    "klaviyo",            # Email/SMS marketing platform — large eng org
    "dbtlabsinc",         # dbt Labs — analytics engineering
    "pagerduty",          # PagerDuty — incident management
    "lithic",             # Lithic — card issuing infrastructure
    "carta",              # Carta — equity management
    "brex",               # already above, deduped by runtime

    # ── DevTools / Productivity ───────────────────────────────────────
    # Confirmed alive from live run
    "figma",              # 157 jobs
    "vercel",             # 77 jobs
    "launchdarkly",       # 40 jobs
    "temporal",           # board alive (0 jobs currently)
    "merge",              # 24 jobs
    "postman",            # 106 jobs
    "circleci",           # 12 jobs
    "gitlab",             # 173 jobs
    "tailscale",          # 47 jobs
    "tines",              # 34 jobs
    "airtable",           # 58 jobs
    "descript",           # 24 jobs
    "taskrabbit",         # 19 jobs
    "dropbox",            # 94 jobs
    "instacart",          # 137 jobs
    "pinterest",          # 132 jobs
    "qualtrics",          # 80 jobs
    # Confirmed alive from web search
    "asana",              # Asana — work management
    "northbeam",          # Northbeam — marketing attribution
    "tekion",             # Tekion — automotive SaaS
    "gongio",             # Gong — revenue intelligence (slug: gongio)
    "buildkite",          # Buildkite — CI/CD
    "honeycomb",          # Honeycomb.io — observability
    "pendo",              # Pendo — product analytics
    "contentful",         # Contentful — headless CMS
    "webflow",            # Webflow — no-code web builder
    "lattice",            # Lattice — people management platform

    # ── Data / Analytics ─────────────────────────────────────────────
    # Confirmed alive from live run
    "datadog",            # 447 jobs
    "fivetran",           # 164 jobs
    "amplitude",          # 45 jobs
    "mixpanel",           # 47 jobs
    "cockroachlabs",      # 29 jobs
    "clickhouse",         # 166 jobs
    "databricks",         # 837 jobs
    # Confirmed alive from web search
    "starburst",          # Starburst — distributed SQL (Trino)
    "imply",              # Imply — Apache Druid analytics

    # ── Cloud / Infra / Security ──────────────────────────────────────
    # Confirmed alive from live run
    "cloudflare",         # 526 jobs
    "elastic",            # 230 jobs
    "mongodb",            # 431 jobs
    "fastly",             # 55 jobs
    "abnormalsecurity",   # 98 jobs
    "okta",               # 377 jobs
    "samsara",            # 397 jobs
    # Confirmed alive from web search
    "netskope",           # already above (AI/Security)
    "orca",               # Orca Security — cloud security
    "axonius",            # Axonius — asset management
    "torq",               # Torq — security automation

    # ── Big Tech Adjacent / Consumer Tech ─────────────────────────────
    # Confirmed alive from live run
    "twilio",             # 139 jobs
    "braze",              # 176 jobs
    "intercom",           # 191 jobs
    "airbnb",             # 260 jobs
    "lyft",               # 161 jobs
    "reddit",             # 169 jobs
    "headway",            # 78 jobs — mental health platform
    "oscar",              # 279 jobs — Oscar Health
    # Confirmed alive from web search
    "klaviyo",            # already above, deduped by runtime
    "sendbird",           # Sendbird — in-app messaging

    # ── Defense / Deep Tech ───────────────────────────────────────────
    # Confirmed alive from live run
    "planetlabs",         # 121 jobs
    "motive",             # 4 jobs — fleet mgmt
    "jumio",              # 24 jobs — identity verification
    # Confirmed alive from web search
    "andurilindustries",  # Anduril — defense AI (slug: andurilindustries)

    # ── Other High-Signal Tech ────────────────────────────────────────
    # Confirmed alive from live run
    "liftoff",            # 19 jobs
    "maintainx",          # 149 jobs
    "metropolis",         # 111 jobs
    # Confirmed alive from web search
    "tekion",             # already above
    "northbeam",          # already above
]

# Deduplicate while preserving order (Python 3.7+ dicts maintain insertion order)
GREENHOUSE_COMPANIES = list(dict.fromkeys(GREENHOUSE_COMPANIES))

ASHBY_COMPANIES = [
    # ── AI / ML ───────────────────────────────────────────────────────
    # Confirmed alive from live run (returned 200, even if 0 jobs)
    "openai",             # OpenAI
    "cartesia",           # Cartesia — real-time audio AI
    "hedra",              # Hedra — AI video
    "sierra",             # Sierra — AI customer agents
    "mem",                # Mem — AI notes
    "dust",               # Dust — AI assistants for teams
    "coframe",            # Coframe — AI web optimization
    "ema",                # Ema — AI employee
    "baseten",            # Baseten — ML model serving
    "contextual",         # Contextual AI — RAG platform
    "synthesia",          # Synthesia — AI video avatars
    # Additional high-confidence Ashby AI companies
    "perplexity",         # Perplexity AI
    "pika",               # Pika — AI video generation
    "cohere",             # Cohere — enterprise LLMs
    "modal",              # Modal — serverless ML

    # ── DevTools / Infra ─────────────────────────────────────────────
    # Confirmed alive from live run
    "linear",             # Linear — issue tracking
    "inngest",            # Inngest — event-driven functions
    "zed",                # Zed — code editor
    # Additional high-confidence Ashby DevTools
    "neon",               # Neon — serverless Postgres
    "resend",             # Resend — transactional email
    "railway",            # Railway — app deployment

    # ── Fintech ───────────────────────────────────────────────────────
    # Confirmed alive from live run
    "column",             # Column — national bank for builders
    # Additional
    "ramp",               # Ramp — spend management

    # ── Security ──────────────────────────────────────────────────────
    "wiz",                # Wiz — cloud security unicorn
]

# Deduplicate while preserving order
ASHBY_COMPANIES = list(dict.fromkeys(ASHBY_COMPANIES))

LEVER_COMPANIES = [
    # Almost all Lever slugs are dead as of 2026-04-02.
    # Only netflix returned 200 (0 jobs). Keeping for coverage.
    # Research new Lever companies before expanding — most have migrated to Ashby/Greenhouse.
    "netflix",
    # A few additional worth trying — may have migrated to Lever recently
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

        jobs_raw = data.get("jobs", [])
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
        params["limit"] = limit

    url = "https://remotive.com/api/remote-jobs"
    logger.info(f"[Remotive] Fetching jobs (category={category}, search={search})")

    try:
        async with httpx.AsyncClient(timeout=FETCH_TIMEOUT) as client:
            resp = await client.get(url, params=params)
            resp.raise_for_status()
            data = resp.json()

        jobs_raw = data.get("jobs", [])
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

        jobs_raw = data.get("jobPostings", [])
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