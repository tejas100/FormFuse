"""
services/browser_agent.py -- Playwright-based auto-apply agent

Strategy:
  1. Navigate to job URL
  2. Extract form HTML and pass to LLM for field detection
  3. LLM returns field list with selector hints (id, name, aria-label)
  4. Fill each field using multiple selector strategies
  5. For free-text questions, call LLM to write an answer
  6. Yield SSE steps throughout -- never clicks Submit
"""

import asyncio
import logging
from typing import AsyncGenerator

logger = logging.getLogger(__name__)

# -- ATS-specific selector knowledge ------------------------------------------
# Known field id/name patterns for each ATS. Tried BEFORE the LLM-generated hint.
# This is the fast path that handles 90% of standard fields.

_GH_SELECTORS = {
    # label          : (css_selector, field_type)
    "first name"     : ("#first_name",           "text"),
    "last name"      : ("#last_name",             "text"),
    "full name"      : ("#first_name",            "text"),   # fill first_name; last_name handled separately
    "email"          : ("#email",                 "email"),
    "email address"  : ("#email",                 "email"),
    "phone"          : ("#phone",                 "text"),
    "phone number"   : ("#phone",                 "text"),
    "linkedin"       : ("#job_application_answers_attributes_0_text_value, input[name*='linkedin']", "text"),
    "website"        : ("input[name*='website'], input[name*='portfolio']", "text"),
    "location"       : ("#job_application_answers_attributes_0_text_value, input[name*='location']", "text"),
}

_ASHBY_SELECTORS = {
    "first name"     : ("input[name='firstName'], input[placeholder*='First']", "text"),
    "last name"      : ("input[name='lastName'], input[placeholder*='Last']",   "text"),
    "full name"      : ("input[name='name'], input[placeholder*='Name']",       "text"),
    "email"          : ("input[name='email'], input[type='email']",              "email"),
    "phone"          : ("input[name='phone'], input[type='tel']",                "text"),
    "linkedin"       : ("input[name='linkedIn'], input[placeholder*='LinkedIn']","text"),
}

_LEVER_SELECTORS = {
    "full name"      : ("input[name='name']",     "text"),
    "first name"     : ("input[name='name']",     "text"),
    "email"          : ("input[name='email']",    "email"),
    "email address"  : ("input[name='email']",    "email"),
    "phone"          : ("input[name='phone']",    "text"),
    "linkedin"       : ("input[name='urls[LinkedIn]'], input[name*='linkedin']", "text"),
    "additional info": ("textarea[name='comments']", "textarea"),
    "why"            : ("textarea[name='comments']", "textarea"),
}

def _get_ats_selectors(url: str) -> dict:
    if "greenhouse.io" in url:
        return _GH_SELECTORS
    if "ashbyhq.com" in url or "ashby" in url:
        return _ASHBY_SELECTORS
    if "lever.co" in url:
        return _LEVER_SELECTORS
    return {}

def _get_ats_hint(url: str) -> str:
    if "greenhouse.io" in url:
        return (
            "This is a Greenhouse ATS form. Known field IDs: "
            "#first_name, #last_name, #email, #phone. "
            "For each field, return the exact HTML id or name attribute as selector_hint. "
            "Custom questions use textarea elements. Resume upload: skip=true."
        )
    if "ashbyhq.com" in url:
        return (
            "This is an Ashby ATS form (React-based). "
            "Fields use name attributes: firstName, lastName, email, phone, linkedIn. "
            "Return the name attribute value as selector_hint."
        )
    if "lever.co" in url:
        return (
            "This is a Lever ATS form. "
            "Known field names: name, email, phone, urls[LinkedIn], comments. "
            "Return the name attribute as selector_hint."
        )
    return "Return the HTML id or name attribute as selector_hint for each field."


# -- Fill helpers -------------------------------------------------------------

async def _fill_by_css(page, css: str, value: str, field_type: str) -> bool:
    """Try multiple comma-separated selectors from a css string."""
    selectors = [s.strip() for s in css.split(",")]
    for sel in selectors:
        try:
            loc = page.locator(sel).first
            if await loc.count() > 0:
                if field_type == "select":
                    await loc.select_option(label=value, timeout=3000)
                elif field_type == "checkbox":
                    if not await loc.is_checked():
                        await loc.check(timeout=3000)
                else:
                    await loc.fill(value, timeout=3000)
                return True
        except Exception:
            continue
    return False


async def _fill_field(page, label: str, selector_hint: str, value: str,
                      field_type: str, ats_selectors: dict) -> bool:
    """
    Fill a field using three strategies in order:
    1. ATS-specific known selector (fastest, most reliable)
    2. LLM-returned selector hint (id, name, aria-label, placeholder)
    3. Broad fallback by field type + label keyword
    """
    label_lower = label.lower().strip()

    # Strategy 1 -- ATS known selectors
    for key, (css, ftype) in ats_selectors.items():
        if key in label_lower or label_lower in key:
            if await _fill_by_css(page, css, value, field_type):
                return True

    # Strategy 2 -- LLM-returned selector hint
    if selector_hint:
        hint = selector_hint.strip()
        candidates = [
            hint,                                          # might already be a full selector
            "#" + hint,                                    # as id
            '[name="' + hint + '"]',                      # as name attr
            '[id="' + hint + '"]',                        # explicit id
            '[aria-label="' + hint + '"]',                # aria-label exact
            '[placeholder*="' + hint[:30] + '"]',         # placeholder contains
            'input[name*="' + hint.lower().replace(" ","_") + '"]',
            'textarea[name*="' + hint.lower().replace(" ","_") + '"]',
        ]
        for sel in candidates:
            try:
                loc = page.locator(sel).first
                if await loc.count() > 0:
                    if field_type == "select":
                        await loc.select_option(label=value, timeout=3000)
                    elif field_type == "checkbox":
                        if not await loc.is_checked():
                            await loc.check(timeout=3000)
                    elif field_type == "textarea":
                        await loc.fill(value, timeout=3000)
                    else:
                        await loc.fill(value, timeout=3000)
                    return True
            except Exception:
                continue

    # Strategy 3 -- Broad fallback: find label text in DOM, then fill sibling input
    try:
        # Find label element containing the field name
        label_loc = page.get_by_text(label, exact=False).first
        if await label_loc.count() > 0:
            # Try to find a nearby input
            parent = label_loc.locator("xpath=..")
            inp = parent.locator("input, textarea, select").first
            if await inp.count() > 0:
                if field_type == "select":
                    await inp.select_option(label=value, timeout=3000)
                else:
                    await inp.fill(value, timeout=3000)
                return True
    except Exception:
        pass

    return False


# -- Free-text detection ------------------------------------------------------

_FREE_TEXT_SIGNALS = [
    "why", "describe", "tell us", "tell me", "how did", "what excites",
    "what interests", "additional information", "cover letter", "anything else",
    "motivat", "passion", "background", "experience with", "accomplish",
    "challeng", "strength", "weakness", "goal", "comments",
]

def _is_free_text_question(label: str) -> bool:
    ll = label.lower()
    return any(s in ll for s in _FREE_TEXT_SIGNALS)


# -- Main agent generator -----------------------------------------------------

async def run_apply_agent(
    job_url:     str,
    job_title:   str,
    company:     str,
    resume_text: str,
    profile:     dict,
) -> AsyncGenerator[dict, None]:
    """Async generator yielding SSE-ready step dicts."""
    from services.form_filler import detect_fields, write_free_text

    def _step(status: str, text: str) -> dict:
        return {"type": "step", "status": status, "text": text}

    try:
        from playwright.async_api import async_playwright
    except ImportError:
        yield {"type": "error", "text": "Playwright not installed. Run: pip install playwright && playwright install chromium"}
        return

    ats_selectors = _get_ats_selectors(job_url)
    ats_hint      = _get_ats_hint(job_url)

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-dev-shm-usage",
                  "--disable-blink-features=AutomationControlled"],
        )
        context = await browser.new_context(
            user_agent=(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/120.0.0.0 Safari/537.36"
            ),
            viewport={"width": 1280, "height": 900},
        )
        page = await context.new_page()

        try:
            # -- Navigate -----------------------------------------------------
            yield _step("ok", "Opening " + company + " application page...")
            try:
                await page.goto(job_url, wait_until="networkidle", timeout=20000)
            except Exception:
                try:
                    await page.goto(job_url, wait_until="domcontentloaded", timeout=15000)
                except Exception as e:
                    yield {"type": "error", "text": "Could not load page: " + str(e)[:120]}
                    return

            await asyncio.sleep(2)
            yield _step("ok", "Navigated to " + company + " application")

            # -- DOM snapshot -------------------------------------------------
            raw_html = await page.content()

            # -- LLM field detection ------------------------------------------
            yield _step("ok", "Analysing form fields...")

            augmented_profile = dict(profile)
            augmented_profile["_ats_hint"] = ats_hint
            fields = await detect_fields(raw_html, augmented_profile)

            if not fields:
                yield {"type": "error", "text": "Could not detect form fields. This ATS may require manual application."}
                return

            # Also handle Greenhouse's "Full Name" -> split into first/last
            expanded = []
            for f in fields:
                lbl = (f.get("field_label") or "").lower()
                if "full name" in lbl and "greenhouse.io" in job_url:
                    name_parts = (f.get("value") or "").split(" ", 1)
                    expanded.append({**f, "field_label": "First Name",
                                     "selector_hint": "first_name",
                                     "value": name_parts[0] if name_parts else ""})
                    expanded.append({**f, "field_label": "Last Name",
                                     "selector_hint": "last_name",
                                     "value": name_parts[1] if len(name_parts) > 1 else ""})
                else:
                    expanded.append(f)
            fields = expanded

            fillable = [f for f in fields if not f.get("skip")]
            yield _step("ok", "Found " + str(len(fillable)) + " fields to fill")

            # -- Fill loop ----------------------------------------------------
            filled_count = 0

            for field in fields:
                label      = field.get("field_label", "Unknown")
                selector   = field.get("selector_hint", "")
                field_type = field.get("field_type", "text")
                value      = field.get("value", "")
                skip       = field.get("skip", False)

                if skip:
                    yield _step("skip", "Skipping: " + label)
                    await asyncio.sleep(0.1)
                    continue

                # Free-text question -- write with LLM
                if field_type == "textarea" and _is_free_text_question(label):
                    yield _step("writing", "Writing answer for: " + label + "...")
                    answer = await write_free_text(
                        question=label, company=company, job_title=job_title,
                        resume_text=resume_text, profile=profile,
                    )
                    if answer:
                        ok = await _fill_field(page, label, selector, answer,
                                               "textarea", ats_selectors)
                        if ok:
                            filled_count += 1
                            yield _step("ok", "Wrote answer for: " + label +
                                        " (" + str(len(answer)) + " chars)")
                        else:
                            yield _step("error", "Could not fill: " + label)
                    else:
                        yield _step("error", "LLM failed to write answer for: " + label)
                    await asyncio.sleep(0.3)
                    continue

                if not value:
                    yield _step("skip", "No value for: " + label)
                    continue

                ok = await _fill_field(page, label, selector, value,
                                       field_type, ats_selectors)
                if ok:
                    filled_count += 1
                    display_val = str(value)[:50]
                    yield _step("ok", 'Filled "' + label + '" -> ' + display_val)
                else:
                    yield _step("error", 'Could not locate "' + label + '" - skipping')

                await asyncio.sleep(0.35)

            # -- Done ---------------------------------------------------------
            skipped = len(fields) - filled_count
            yield _step("ok", str(filled_count) + " field(s) filled, " +
                        str(skipped) + " skipped")
            yield {
                "type":         "done",
                "text":         "Form filled for " + job_title + " at " + company,
                "filled_count": filled_count,
                "job_url":      job_url,
            }

        except Exception as e:
            logger.error("[browser_agent] Error: " + str(e), exc_info=True)
            yield {"type": "error", "text": "Agent error: " + str(e)[:200]}
        finally:
            await context.close()
            await browser.close()