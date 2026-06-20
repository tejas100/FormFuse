"""
job_fetcher.py — Multi-source job fetcher + pool storage for RACK.

Fetches jobs from:
  - Greenhouse Job Board API (OpenAI, Stripe, Notion, Anthropic, Ramp, etc.)
  - Ashby Job Board API (OpenAI, Linear, Wiz, etc.)
  - Lever Postings API (Netflix, etc.)
  - YC auto-discovery (probes hiring YC companies not in hardcoded lists)

All results normalized to a common schema via _normalize_job().

Storage (moved from auto_match.py — fetch and store belong together):
  - upsert_pool_to_db(pool)  — bulk INSERT ... ON CONFLICT upsert to Postgres job_pool table
  - _prune_stale_pool(conn)  — delete jobs older than 35 days (called inside upsert)
  - refresh_job_pool()       — single entry point: fetch → normalize → upsert → prune
                               Called by run_fetching.py via launchd every 2 hours.
                               Completely independent of users and scoring.
"""

import asyncio
import json
import logging
import os
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
        # description_html intentionally omitted — plain text sufficient for all scoring paths.
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
    logger.debug(f"[Greenhouse] Fetching: {board_token}")

    try:
        async with httpx.AsyncClient(timeout=FETCH_TIMEOUT) as client:
            resp = await client.get(url)
            if resp.status_code == 404:
                logger.debug(f"[Greenhouse] 404 (dead slug): {board_token}")
                return []
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

        if jobs:
            logger.debug(f"[Greenhouse] {board_token}: {len(jobs)} jobs")
        return jobs

    except httpx.HTTPStatusError as e:
        logger.debug(f"[Greenhouse] {board_token} HTTP {e.response.status_code}")
        return []
    except Exception as e:
        logger.warning(f"[Greenhouse] {board_token} error: {e}")
        return []


# ── Lever ───────────────────────────────────────────────────────────
async def fetch_lever(company: str) -> list[dict]:
    """
    Fetch jobs from Lever Postings API.
    GET https://api.lever.co/v0/postings/{company}
    """
    url = f"https://api.lever.co/v0/postings/{company}"
    logger.debug(f"[Lever] Fetching: {company}")

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

        if jobs:
            logger.debug(f"[Lever] {company}: {len(jobs)} jobs")
        return jobs

    except httpx.HTTPStatusError as e:
        logger.debug(f"[Lever] {company} HTTP {e.response.status_code}")
        return []
    except Exception as e:
        logger.warning(f"[Lever] {company} error: {e}")
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
    logger.debug(f"[Ashby] Fetching: {slug}")

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

        if jobs:
            logger.debug(f"[Ashby] {slug}: {len(jobs)} jobs")
        return jobs

    except httpx.HTTPStatusError as e:
        logger.debug(f"[Ashby] {slug} HTTP {e.response.status_code}")
        return []
    except Exception as e:
        logger.warning(f"[Ashby] {slug} error: {e}")
        return []


# ── Unified auto fetch ─────────────────────────────────────────
async def fetch_all_jobs(semaphore: asyncio.Semaphore) -> list[dict]:
    """
    Fetch all jobs across Greenhouse + Ashby + Lever + YC auto-discovery.
    Single entry point for all job board fetching — completely independent
    of users, resumes, and scoring.

    Returns flat list of all normalized jobs.
    """
    async def _guarded(coro):
        async with semaphore:
            return await coro

    gh_count   = len(GREENHOUSE_COMPANIES)
    ashby_count = len(ASHBY_COMPANIES)
    lever_count = len(LEVER_COMPANIES)
    total_companies = gh_count + ashby_count + lever_count

    gh_tasks    = [_guarded(fetch_greenhouse(token)) for token in GREENHOUSE_COMPANIES]
    ashby_tasks = [_guarded(fetch_ashby(slug))       for slug   in ASHBY_COMPANIES]
    lever_tasks = [_guarded(fetch_lever(company))    for company in LEVER_COMPANIES]

    all_tasks = gh_tasks + ashby_tasks + lever_tasks
    results = await asyncio.gather(*all_tasks, return_exceptions=True)

    all_jobs = []
    dead_gh, dead_ashby, dead_lever = [], [], []
    alive_sources = 0

    for i, r in enumerate(results):
        if isinstance(r, Exception):
            # Classify which source this was
            if i < gh_count:
                dead_gh.append(GREENHOUSE_COMPANIES[i])
            elif i < gh_count + ashby_count:
                dead_ashby.append(ASHBY_COMPANIES[i - gh_count])
            else:
                dead_lever.append(LEVER_COMPANIES[i - gh_count - ashby_count])
        elif isinstance(r, list):
            if r:
                alive_sources += 1
            all_jobs.extend(r)

    # Dead slugs returned empty lists (404s) — those aren't exceptions, just 0 jobs.
    # Count sources that actually returned jobs vs those that returned nothing.
    empty_sources = total_companies - alive_sources - (len(dead_gh) + len(dead_ashby) + len(dead_lever))

    logger.info(
        f"[JobFetcher] Pool fetch: {len(all_jobs)} jobs · "
        f"{alive_sources}/{total_companies} sources live · "
        f"{empty_sources} returned 0 jobs · "
        f"{len(dead_gh) + len(dead_ashby) + len(dead_lever)} errored"
    )
    if dead_gh:
        logger.warning(f"[JobFetcher] Dead GH slugs ({len(dead_gh)}): {', '.join(dead_gh)}")
    if dead_ashby:
        logger.warning(f"[JobFetcher] Dead Ashby slugs ({len(dead_ashby)}): {', '.join(dead_ashby)}")

    # YC auto-discovery: probe hiring YC companies not in hardcoded lists
    # Runs concurrently with the main fetch but logged separately
    try:
        yc_jobs = await fetch_yc_discovered_jobs(semaphore)
        all_jobs.extend(yc_jobs)
    except Exception as e:
        logger.warning(f"[YC-Discovery] Failed (non-fatal): {e}")

    logger.info(
        f"[JobFetcher] Pool fetch complete: {len(all_jobs)} jobs from "
        f"{total_companies - len(dead_gh) - len(dead_ashby) - len(dead_lever)}/{total_companies} sources ({len(dead_gh) + len(dead_ashby) + len(dead_lever)} failed)"
    )
    return all_jobs


# ── YC Auto-Discovery ────────────────────────────────────────────────
# Fetches YC's public "currently hiring" company list, probes each company's
# slug against Greenhouse and Ashby, and returns all jobs found.
# No scraping — only hits public ATS APIs that are already used by the pipeline.
#
# Strategy:
#   1. GET https://yc-oss.github.io/api/companies/hiring.json  (~1400 hiring companies)
#   2. For each company slug, probe GH + Ashby concurrently (semaphore-limited)
#   3. Deduplicate against GREENHOUSE_COMPANIES + ASHBY_COMPANIES (already fetched)
#   4. Return normalized jobs from any new boards found
#
# This runs in addition to the hardcoded lists, not instead of them.
# It auto-discovers new YC companies that joined Greenhouse/Ashby since
# the last manual audit.

YC_HIRING_API = "https://yc-oss.github.io/api/companies/hiring.json"
YC_AI_TAGS_API = "https://yc-oss.github.io/api/tags/ai.json"

# Tags we care about — company must match at least one
YC_TARGET_TAGS = {
    "artificial-intelligence", "machine-learning", "generative-ai",
    "ai", "nlp", "computer-vision", "developer-tools", "developer-tool",
    "infrastructure", "api", "b2b", "saas", "fintech",
}


async def _probe_yc_company(
    client: httpx.AsyncClient,
    slug: str,
    existing_gh: set,
    existing_ashby: set,
) -> list[dict]:
    """
    Probe a single YC company slug against GH and Ashby.
    Returns normalized jobs if the board exists and isn't already in our lists.
    """
    jobs = []

    # Greenhouse probe (skip if already in hardcoded list)
    if slug not in existing_gh:
        try:
            r = await client.get(
                f"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs",
                timeout=10.0,
            )
            if r.status_code == 200:
                raw = r.json().get("jobs", [])
                if raw:
                    logger.info(f"[YC-Discovery] Found GH board: {slug} ({len(raw)} jobs)")
                    for j in raw:
                        loc = j.get("location", {}).get("name", "") if isinstance(j.get("location"), dict) else ""
                        dept = ""
                        departments = j.get("departments", [])
                        if departments and isinstance(departments[0], dict):
                            dept = departments[0].get("name", "")
                        jobs.append(_normalize_job(
                            source="greenhouse",
                            external_id=j["id"],
                            title=j.get("title", "Unknown"),
                            company=slug,
                            location=loc,
                            url=j.get("absolute_url", ""),
                            description_html=j.get("content", ""),
                            posted_at=j.get("updated_at") or j.get("created_at"),
                            department=dept,
                        ))
        except Exception:
            pass

    # Ashby probe (skip if already in hardcoded list)
    if slug not in existing_ashby:
        try:
            r = await client.get(
                f"https://api.ashbyhq.com/posting-api/job-board/{slug}",
                timeout=10.0,
            )
            if r.status_code == 200:
                raw = r.json().get("jobPostings", [])
                if raw:
                    logger.info(f"[YC-Discovery] Found Ashby board: {slug} ({len(raw)} jobs)")
                    for j in raw:
                        jobs.append(_normalize_job(
                            source="ashby",
                            external_id=j.get("id", j.get("jobId", "")),
                            title=j.get("title", "Unknown"),
                            company=slug,
                            location=j.get("locationName", "") or j.get("location", ""),
                            url=j.get("jobUrl", "") or j.get("applyUrl", ""),
                            description_html=j.get("descriptionHtml", ""),
                            description_text=j.get("descriptionPlain", ""),
                            posted_at=j.get("publishedAt") or j.get("updatedAt"),
                            department=j.get("departmentName", ""),
                        ))
        except Exception:
            pass

    return jobs


async def fetch_yc_discovered_jobs(semaphore: asyncio.Semaphore) -> list[dict]:
    """
    Auto-discover YC companies on Greenhouse/Ashby that aren't in our hardcoded lists.

    Uses the yc-oss public API (GitHub Pages, no auth) to get hiring companies,
    filters to AI/dev-tools/infra tags, then probes each slug against GH + Ashby.

    Called by fetch_all_jobs() — runs concurrently with the main fetches.
    """
    existing_gh    = set(GREENHOUSE_COMPANIES)
    existing_ashby = set(ASHBY_COMPANIES)

    # Fetch YC hiring list
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            r = await client.get(YC_HIRING_API)
            r.raise_for_status()
            companies = r.json()
    except Exception as e:
        logger.warning(f"[YC-Discovery] Failed to fetch YC hiring list: {e}")
        return []

    # Filter to companies with relevant tags and active hiring status
    # Also exclude acquired/dead companies
    candidates = []
    for co in companies:
        if co.get("status") not in ("Active", ""):
            continue
        tags = {t.lower().replace(" ", "-") for t in co.get("tags", [])}
        if not tags.intersection(YC_TARGET_TAGS):
            continue
        slug = co.get("slug", "").strip().lower()
        if not slug:
            continue
        # Skip if already in both lists (will be fetched by main pipeline)
        if slug in existing_gh and slug in existing_ashby:
            continue
        candidates.append(slug)

    logger.info(f"[YC-Discovery] {len(candidates)} candidate slugs to probe (from {len(companies)} hiring YC companies)")

    # Probe all candidates concurrently, semaphore-limited
    all_jobs = []
    async def _guarded_probe(slug):
        async with semaphore:
            async with httpx.AsyncClient(timeout=10.0) as client:
                return await _probe_yc_company(client, slug, existing_gh, existing_ashby)

    results = await asyncio.gather(
        *[_guarded_probe(slug) for slug in candidates],
        return_exceptions=True,
    )

    for r in results:
        if isinstance(r, list):
            all_jobs.extend(r)

    logger.info(f"[YC-Discovery] Found {len(all_jobs)} jobs from auto-discovered YC boards")
    return all_jobs


async def fetch_all_watchlist(watchlist_entries: list[dict]) -> list[dict]:
    """
    Fetch jobs for all companies in the watchlist.

    watchlist_entries: [{"company": "openai", "source": "greenhouse"}, ...]
    Returns: flat list of all normalized jobs.
    """
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


# ── Pool storage ─────────────────────────────────────────────────────
# These functions own the full write path: fetch → normalize → upsert → prune.
# Nothing in auto_match.py or any user-facing code should call these directly.
# Entry point for callers: refresh_job_pool() below.

# Disk fallback constants — mirror what auto_match.py reads from POOL_CACHE_PATH
_WATCHLIST_DIR  = os.path.join("uploads", "watchlist")
_POOL_CACHE_PATH = os.path.join(_WATCHLIST_DIR, "job_pool.json")


def _prune_stale_pool(conn) -> None:
    """
    Delete job listings older than 35 days from job_pool.

    Two passes:
      1. Jobs with a known posted_at older than 35 days — clearly dead listings.
      2. Jobs with NULL posted_at whose fetched_at is also older than 35 days —
         boards (mostly Lever/Ashby) that don't expose a posting date; use fetch
         time as the proxy so they don't accumulate indefinitely.

    seen_job_ids rows are intentionally NOT touched — they are a permanent
    deduplication guard and must survive pool pruning.

    Called inside upsert_pool_to_db() after the upsert commits, as a separate
    transaction so a prune failure never rolls back the upsert.
    """
    PRUNE_DAYS = 40
    try:
        cur = conn.cursor()

        # Pass 1 — dated jobs older than 40 days
        cur.execute(
            "DELETE FROM job_pool WHERE posted_at < NOW() - INTERVAL '%s days'",
            (PRUNE_DAYS,)
        )
        dated_pruned = cur.rowcount

        # Pass 2 — undated jobs whose fetched_at is also older than 40 days
        cur.execute(
            "DELETE FROM job_pool "
            "WHERE posted_at IS NULL AND fetched_at < NOW() - INTERVAL '%s days'",
            (PRUNE_DAYS,)
        )
        undated_pruned = cur.rowcount

        # Pass 3 — inactive jobs (not seen in last fetch, definitively taken down)
        cur.execute("DELETE FROM job_pool WHERE is_active = FALSE")
        inactive_pruned = cur.rowcount

        conn.commit()
        cur.close()
        total = dated_pruned + undated_pruned + inactive_pruned
        logger.info(
            f"[JobFetcher] Pool pruned: {dated_pruned} dated + {undated_pruned} undated "
            f"+ {inactive_pruned} inactive = {total} stale jobs removed"
        )
    except Exception as e:
        logger.warning(f"[JobFetcher] Pool prune failed (non-fatal): {e}")
        try:
            conn.rollback()
        except Exception:
            pass


def upsert_pool_to_db(pool: list) -> None:
    """
    Bulk-upsert a normalized job pool into the Postgres job_pool table.

    Strategy:
      1. INSERT ... ON CONFLICT (job_id) DO UPDATE — idempotent, safe to call
         on every fetch run. Existing jobs get their metadata refreshed; new
         jobs are inserted.
      2. Mark any job not touched by this fetch as is_active=False — these are
         roles that have been taken down from the board since the last run.
      3. Prune stale listings (>35 days) in a separate transaction so a prune
         failure never rolls back the upsert.

    Falls back to a local disk write (job_pool.json) if the DB is unreachable,
    so the scheduler never aborts on a transient Supabase outage.

    Uses the session pooler (port 5432 / psycopg2) — same as Alembic.
    Never call this from an async context without running in a thread executor;
    psycopg2 is synchronous.
    """
    import psycopg2
    from urllib.parse import urlparse, unquote

    now = datetime.now(timezone.utc)

    # ── Primary: Postgres job_pool table ─────────────────────────────
    try:
        db_url = os.environ["DATABASE_URL_DIRECT"]
        parsed   = urlparse(db_url.replace("postgresql+psycopg2://", "postgresql://"))
        password = unquote(parsed.password or "")
        conn = psycopg2.connect(
            host=parsed.hostname,
            port=parsed.port or 5432,
            dbname=parsed.path.lstrip("/"),
            user=parsed.username,
            password=password,
            sslmode="require",
        )
        cur = conn.cursor()

        upsert_sql = """
            INSERT INTO job_pool (
                job_id, source, external_id, title, company, location, url,
                description_text, posted_at, department, commitment,
                board_token, fetched_at, is_active
            ) VALUES (
                %(job_id)s, %(source)s, %(external_id)s, %(title)s, %(company)s,
                %(location)s, %(url)s, %(description_text)s, %(posted_at)s,
                %(department)s, %(commitment)s, %(board_token)s, %(fetched_at)s, TRUE
            )
            ON CONFLICT (job_id) DO UPDATE SET
                title            = EXCLUDED.title,
                company          = EXCLUDED.company,
                location         = EXCLUDED.location,
                url              = EXCLUDED.url,
                description_text = EXCLUDED.description_text,
                posted_at        = EXCLUDED.posted_at,
                department       = EXCLUDED.department,
                commitment       = EXCLUDED.commitment,
                board_token      = EXCLUDED.board_token,
                fetched_at       = EXCLUDED.fetched_at,
                is_active        = TRUE
        """

        rows = []
        for j in pool:
            posted_raw = j.get("posted_at")
            try:
                posted_dt = datetime.fromisoformat(
                    posted_raw.replace("Z", "+00:00")
                ) if posted_raw else None
            except Exception:
                posted_dt = None

            rows.append({
                "job_id":           j["job_id"],
                "source":           j.get("source", ""),
                "external_id":      j.get("external_id", ""),
                "title":            j.get("title", ""),
                "company":          j.get("company", ""),
                "location":         j.get("location", "Not specified"),
                "url":              j.get("url", ""),
                "description_text": j.get("description_text", ""),
                "posted_at":        posted_dt,
                "department":       j.get("department", ""),
                "commitment":       j.get("commitment", ""),
                "board_token":      j.get("board_token", ""),
                "fetched_at":       now,
            })

        cur.executemany(upsert_sql, rows)

        # Mark jobs not seen in this fetch run as inactive
        cur.execute(
            "UPDATE job_pool SET is_active = FALSE "
            "WHERE fetched_at < %s AND is_active = TRUE",
            (now,)
        )

        conn.commit()
        cur.close()
        logger.info(f"[JobFetcher] Pool upserted to Postgres: {len(pool)} jobs")

        # Prune stale listings — separate transaction inside same connection
        _prune_stale_pool(conn)
        conn.close()
        return

    except Exception as e:
        logger.warning(f"[JobFetcher] Postgres upsert failed ({e}) — falling back to disk")

    # ── Fallback: local disk ──────────────────────────────────────────
    try:
        payload = {
            "fetched_at": now.isoformat(),
            "job_count":  len(pool),
            "jobs":       pool,
        }
        os.makedirs(_WATCHLIST_DIR, exist_ok=True)
        with open(_POOL_CACHE_PATH, "w") as f:
            f.write(json.dumps(payload))
        logger.info(f"[JobFetcher] Pool written to disk (fallback): {len(pool)} jobs")
    except Exception as e2:
        logger.error(f"[JobFetcher] Disk fallback also failed: {e2}")


async def refresh_job_pool() -> int:
    """
    Single entry point for the job-fetch scheduler (run_fetching.py / launchd).

    Does exactly three things, in order:
      1. Hit all job board APIs concurrently → normalized job list
      2. Upsert the list into Postgres job_pool table (mark removed jobs inactive)
      3. Prune listings older than 35 days

    Returns the number of jobs fetched (used by run_fetching.py for the
    macOS notification subtitle).

    This function has NO knowledge of users, scoring, or matching.
    It is safe to call at any frequency — 10,000 users signing up does not
    change when or how often this runs. It is driven purely by launchd schedule.
    """
    logger.info("[JobFetcher] Pool refresh started…")
    t0 = datetime.now(timezone.utc)

    try:
        semaphore = asyncio.Semaphore(15)
        raw_pool = await fetch_all_jobs(semaphore)
        logger.info(f"[JobFetcher] Fetched {len(raw_pool)} jobs from all boards")
        upsert_pool_to_db(raw_pool)
    except Exception as e:
        logger.error(f"[JobFetcher] Pool refresh failed: {e}")
        return 0

    elapsed = round((datetime.now(timezone.utc) - t0).total_seconds())
    logger.info(f"[JobFetcher] ✓ Pool refresh complete in {elapsed}s — {len(raw_pool)} jobs upserted")
    return len(raw_pool)