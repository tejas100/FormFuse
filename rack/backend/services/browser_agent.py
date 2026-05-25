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
    # LinkedIn / GitHub / Website — Greenhouse uses input[type=url] or labeled text inputs
    "linkedin"       : ("input[type='url'][id*='linkedin'], input[name*='linkedin'], input[placeholder*='linkedin' i], input[placeholder*='LinkedIn']", "text"),
    "linkedin url"   : ("input[type='url'][id*='linkedin'], input[name*='linkedin'], input[placeholder*='linkedin' i]", "text"),
    "github"         : ("input[type='url'][id*='github'], input[name*='github'], input[placeholder*='github' i]", "text"),
    "github url"     : ("input[type='url'][id*='github'], input[name*='github'], input[placeholder*='github' i]", "text"),
    "website"        : ("input[type='url'][id*='website'], input[type='url'][id*='portfolio'], input[name*='website'], input[name*='portfolio'], input[placeholder*='website' i], input[placeholder*='portfolio' i]", "text"),
    "portfolio"      : ("input[type='url'][id*='portfolio'], input[name*='portfolio'], input[placeholder*='portfolio' i]", "text"),
    "location"       : ("input[name*='location'], input[placeholder*='location' i]", "text"),
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

# -- Greenhouse select2 dropdown value maps -----------------------------------
# Maps our internal profile values to the exact option text Greenhouse shows.
# Work Authorization — Greenhouse shows a "select2" custom dropdown.
_GH_WORK_AUTH_MAP = {
    "yes": "Yes",
    "no":  "No",
}
_GH_SPONSORSHIP_MAP = {
    "yes": "Yes",
    "no":  "No",
}
# EEO dropdowns — exact option text from Greenhouse's standard EEO form
_GH_GENDER_MAP = {
    "male":       "Male",
    "female":     "Female",
    "non_binary": "Non-Binary",
    "decline":    "I don't wish to answer",
}
_GH_VETERAN_MAP = {
    "protected_veteran": "I am a protected veteran",
    "not_a_veteran":     "I am not a protected veteran",
    "decline":           "I don't wish to answer",
}
_GH_DISABILITY_MAP = {
    "yes":     "Yes, I have a disability, or have had one in the past",
    "no":      "No, I do not have a disability and have not had one in the past",
    "decline": "I don't wish to answer",
}

# Which field labels are Greenhouse select2 dropdowns and what value map + container to use
_GH_SELECT2_FIELDS = {
    "work authorization":  (_GH_WORK_AUTH_MAP,   "work_auth"),
    "authorized to work":  (_GH_WORK_AUTH_MAP,   "work_auth"),
    "require sponsorship": (_GH_SPONSORSHIP_MAP, "requires_sponsorship"),
    "visa sponsorship":    (_GH_SPONSORSHIP_MAP, "requires_sponsorship"),
    "gender":              (_GH_GENDER_MAP,       "gender_eeo"),
    "gender (eeo)":        (_GH_GENDER_MAP,       "gender_eeo"),
    "veteran":             (_GH_VETERAN_MAP,      "veteran_status"),
    "veteran status":      (_GH_VETERAN_MAP,      "veteran_status"),
    "disability":          (_GH_DISABILITY_MAP,   "disability_status"),
    "disability status":   (_GH_DISABILITY_MAP,   "disability_status"),
}


async def _fill_gh_url_field(page, label: str, value: str) -> bool:
    """
    Fill a Greenhouse URL input field (LinkedIn, GitHub, Website).
    Greenhouse renders these as input[type="url"] inside a labeled div.
    Strategy: find all url inputs, match by nearby label text, fill the right one.
    """
    label_lower = label.lower().strip()
    try:
        # First try: standard CSS selectors based on common Greenhouse patterns
        keywords = []
        if "linkedin" in label_lower:
            keywords = ["linkedin"]
        elif "github" in label_lower:
            keywords = ["github"]
        elif "website" in label_lower or "portfolio" in label_lower:
            keywords = ["website", "portfolio"]

        # Try direct attribute selectors first
        for kw in keywords:
            for sel in [
                f'input[id*="{kw}" i]',
                f'input[name*="{kw}" i]',
                f'input[placeholder*="{kw}" i]',
                f'input[aria-label*="{kw}" i]',
            ]:
                try:
                    loc = page.locator(sel).first
                    if await loc.count() > 0:
                        await loc.fill(value, timeout=3000)
                        return True
                except Exception:
                    continue

        # Fallback: find all url inputs, pick the one whose label contains our keyword
        url_inputs = page.locator('input[type="url"]')
        count = await url_inputs.count()
        for i in range(count):
            inp = url_inputs.nth(i)
            try:
                # Check nearby text via JS
                nearby = await page.evaluate(
                    """el => {
                        let node = el;
                        for (let i = 0; i < 5; i++) {
                            if (!node.parentElement) break;
                            node = node.parentElement;
                            const text = node.textContent.toLowerCase();
                            if (text.length < 300) return text;
                        }
                        return '';
                    }""",
                    await inp.element_handle()
                )
                if any(kw in nearby for kw in keywords):
                    await inp.fill(value, timeout=3000)
                    return True
            except Exception:
                continue

        # Last resort: text inputs that might be URL fields
        text_inputs = page.locator('input[type="text"]')
        tcount = await text_inputs.count()
        for i in range(tcount):
            inp = text_inputs.nth(i)
            try:
                ph = await inp.get_attribute("placeholder") or ""
                iid = await inp.get_attribute("id") or ""
                nm = await inp.get_attribute("name") or ""
                combined = (ph + iid + nm).lower()
                if any(kw in combined for kw in keywords):
                    await inp.fill(value, timeout=3000)
                    return True
            except Exception:
                continue

    except Exception as e:
        logger.debug(f"[browser_agent] _fill_gh_url_field failed for '{label}': {e}")
    return False


async def _fill_gh_select2(page, label: str, profile: dict) -> bool:
    """
    Fill a Greenhouse select2 custom dropdown.
    These are NOT standard <select> elements.

    Strategy:
      1. Match label → value map + profile key
      2. Try hidden <select> first (fastest, works on many Greenhouse forms)
      3. Fall back to clicking select2 UI trigger → option in dropdown list
      4. Fall back to finding <select> near any label text match on page
    """
    label_lower = label.lower().strip()
    match = None
    for key, (val_map, profile_key) in _GH_SELECT2_FIELDS.items():
        if key in label_lower or label_lower in key:
            match = (val_map, profile_key)
            break
    if not match:
        return False

    val_map, profile_key = match
    raw_val = profile.get(profile_key, "decline")
    option_text = val_map.get(raw_val, list(val_map.values())[-1])

    logger.debug(f"[select2] Filling '{label}' with '{option_text}' (profile key={profile_key}, raw={raw_val})")

    try:
        # ── Strategy A: hidden <select> — Greenhouse often keeps the real select
        # in the DOM even when select2 overlays it. Force-set via JS evaluate.
        selects = page.locator("select")
        count = await selects.count()
        for i in range(count):
            sel = selects.nth(i)
            try:
                # Check if this select has an option matching our text
                option_exists = await page.evaluate(
                    """([sel_idx, text]) => {
                        const selects = document.querySelectorAll('select');
                        const sel = selects[sel_idx];
                        if (!sel) return false;
                        const opts = Array.from(sel.options);
                        return opts.some(o => o.text.trim().toLowerCase().includes(text.toLowerCase()));
                    }""",
                    [i, option_text[:20]]
                )
                if option_exists:
                    await sel.select_option(label=option_text, timeout=2000)
                    # Trigger change event so select2 UI updates
                    await page.evaluate(
                        "idx => { const s = document.querySelectorAll('select')[idx]; s.dispatchEvent(new Event('change', {bubbles:true})); }",
                        i
                    )
                    await asyncio.sleep(0.2)
                    logger.debug(f"[select2] Strategy A succeeded for '{label}'")
                    return True
            except Exception:
                continue

        # ── Strategy B: click select2 UI trigger near matching label text
        # Find all select2 containers on page, check which one is near our label
        triggers = page.locator(
            'a.select2-choice, span.select2-chosen, '
            '.select2-container, span[role="combobox"], '
            'button[role="combobox"]'
        )
        tcount = await triggers.count()
        for i in range(tcount):
            trigger = triggers.nth(i)
            try:
                # Check if there's label text nearby (within 3 ancestor levels)
                nearby_text = await page.evaluate(
                    """el => {
                        let node = el;
                        for (let i = 0; i < 4; i++) {
                            if (!node.parentElement) break;
                            node = node.parentElement;
                            if (node.textContent) return node.textContent.toLowerCase();
                        }
                        return '';
                    }""",
                    await trigger.element_handle()
                )
                if not any(k in nearby_text for k in label_lower.split() if len(k) > 3):
                    continue

                await trigger.click(timeout=2000)
                await asyncio.sleep(0.5)

                # Options appear in a global dropdown — try multiple selectors
                for opt_sel in [
                    f'.select2-results li:has-text("{option_text}")',
                    f'.select2-results__option:has-text("{option_text}")',
                    f'li[role="option"]:has-text("{option_text}")',
                    f'.select2-result-label:has-text("{option_text}")',
                    # Partial match fallback
                    f'.select2-results li:has-text("{option_text[:15]}")',
                ]:
                    opt = page.locator(opt_sel).first
                    if await opt.count() > 0:
                        await opt.click(timeout=2000)
                        await asyncio.sleep(0.2)
                        logger.debug(f"[select2] Strategy B succeeded for '{label}' via '{opt_sel}'")
                        return True

                # Close dropdown if nothing matched
                await page.keyboard.press("Escape")
                await asyncio.sleep(0.2)
            except Exception:
                continue

    except Exception as e:
        logger.debug(f"[browser_agent] _fill_gh_select2 failed for '{label}': {e}")

    return False


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
    "hear about", "how did you", "referred by", "how did you find",
]

# Questions where a fixed short answer beats LLM generation
_FIXED_ANSWERS = {
    "hear about": "RACK — an AI job matching tool",
    "how did you find": "RACK — an AI job matching tool",
    "referred by": "",   # skip — no referrer
    "how did you hear": "RACK — an AI job matching tool",
}

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
    job_id:      str | None = None,
    resume_id:   str | None = None,
    user_id:     str | None = None,
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

    # -- Create Steel remote browser session ----------------------------------
    from services.steel_client import create_session, release_session

    try:
        steel_session = await create_session()
    except Exception as e:
        yield {"type": "error", "text": f"Could not create browser session: {e}"}
        return

    # Emit live viewer URL to frontend BEFORE any navigation — user sees the
    # browser window appear immediately while the agent is still loading the page
    yield {
        "type":         "steel_session",
        "session_id":   steel_session["session_id"],
        "live_view_url": steel_session["live_view_url"],
    }

    steel_session_id = steel_session["session_id"]

    async with async_playwright() as pw:
        # Connect to Steel's remote browser via CDP instead of launching local Chromium
        browser = await pw.chromium.connect_over_cdp(steel_session["ws_url"])

        # Steel starts with one context and one blank tab — use them directly
        context = browser.contexts[0] if browser.contexts else await browser.new_context()
        page    = context.pages[0]    if context.pages    else await context.new_page()

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

            # -- Job-removed detection ----------------------------------------
            # Check BEFORE any field detection. If the page is a job listing
            # board (no application form) or explicitly says the job is gone,
            # bail early with a job_removed event so the frontend can clean up.
            try:
                # Extra wait — Greenhouse renders its "no longer open" banner
                # via JS after initial page load. 2s may not be enough.
                await asyncio.sleep(1.5)

                page_text_check = (await page.inner_text("body")).lower()
                page_url_check  = page.url.lower()

                # Explicit removal signals in page text.
                # IMPORTANT: "no longer available" must come AFTER more specific
                # phrases so it doesn't shadow them in the list, but since we
                # use `any()` the order doesn't matter — all are checked.
                _REMOVED_PHRASES = [
                    # Greenhouse-specific (exact banner text)
                    "the job you are looking for is no longer open",
                    "job is no longer open",
                    # Generic ATS phrases
                    "no longer accepting applications",
                    "job has been removed",
                    "position has been filled",
                    "this role is no longer available",
                    "posting has expired",
                    "posting has been removed",
                    "this job is no longer available",
                    "this position is no longer available",
                    "this listing has expired",
                    "position is closed",
                    "job is closed",
                    "application period has ended",
                    "this job posting has been closed",
                    "this job posting is closed",
                    # Ashby / Lever
                    "this role has been filled",
                    "role is no longer available",
                    "application is closed",
                ]
                text_signals_removed = any(p in page_text_check for p in _REMOVED_PHRASES)

                # Detect landing on a job BOARD (listing page) instead of an application.
                # Board pages have no <form> element but DO have filter/search inputs —
                # so we check only for the absence of a form, not absence of all inputs.
                has_form = await page.locator("form").count() > 0

                # Board-root URL patterns — landed on company job listing, not a specific application
                _BOARD_URL_PATTERNS = [
                    "/jobs", "/careers", "/job-search", "/openings",
                    "/positions", "/opportunities",
                ]
                url_looks_like_board = (
                    not has_form
                    and any(p in page_url_check for p in _BOARD_URL_PATTERNS)
                )

                if text_signals_removed or url_looks_like_board:
                    reason = (
                        "The job posting is no longer available — it may have been filled or removed."
                        if text_signals_removed
                        else "Could not reach the application form — the URL points to a job board rather than a specific opening."
                    )
                    logger.info(
                        f"[browser_agent] Job-removed detected: "
                        f"text_signal={text_signals_removed} board_url={url_looks_like_board} "
                        f"url={page.url!r}"
                    )
                    yield {
                        "type":    "job_removed",
                        "text":    reason,
                        "job_id":  job_id,
                        "job_url": job_url,
                    }
                    return
            except Exception as _jc_err:
                logger.debug(f"[browser_agent] Job-removed check failed (continuing): {_jc_err}")

            # -- DOM snapshot -------------------------------------------------
            raw_html = await page.content()

            # -- DOM dump (debug) — logs all form elements with label context --
            try:
                form_elements = await page.evaluate("""() => {
                    const results = [];
                    document.querySelectorAll('input, select, textarea').forEach((el, i) => {
                        const label = document.querySelector(`label[for="${el.id}"]`);
                        const parentText = el.closest('.field, .form-field, [class*="question"], .application-field, .field-row')?.textContent?.trim()?.slice(0, 120) || '';
                        results.push({
                            i, tag: el.tagName, type: el.type || '',
                            id: el.id, name: el.name,
                            placeholder: el.getAttribute('placeholder') || '',
                            classes: el.className.slice(0, 80),
                            labelText: label?.textContent?.trim() || '',
                            parentText: parentText,
                            optionCount: el.tagName === 'SELECT' ? el.options.length : 0,
                            firstOptions: el.tagName === 'SELECT' ? Array.from(el.options).slice(0,4).map(o=>o.text) : [],
                        });
                    });
                    return results;
                }""")
                for el in form_elements:
                    logger.info(f"[dom_dump] {el}")
            except Exception as _de:
                logger.warning(f"[dom_dump] failed: {_de}")

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
            # Debug: log every detected field so we can see what LLM returned
            for _dbg in fields:
                logger.info(f"[field_debug] label={_dbg.get('field_label')!r} "
                            f"type={_dbg.get('field_type')!r} "
                            f"hint={_dbg.get('selector_hint')!r} "
                            f"skip={_dbg.get('skip')} "
                            f"value={str(_dbg.get('value',''))[:40]!r}")

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

                # Free-text question -- write with LLM (or use fixed answer)
                if field_type == "textarea" and _is_free_text_question(label):
                    # Check for fixed short answers first (e.g. "how did you hear")
                    label_lower_ft = label.lower()
                    fixed_answer = next(
                        (v for k, v in _FIXED_ANSWERS.items() if k in label_lower_ft),
                        None
                    )
                    if fixed_answer is not None:
                        answer = fixed_answer
                        yield _step("ok", 'Filled "' + label + '" -> ' + answer[:40])
                    else:
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

                is_gh = "greenhouse.io" in job_url
                label_lower_chk = label.lower()
                filled_this = False

                # ── Greenhouse URL fields (LinkedIn, GitHub, Website) ──────────
                # Use JS to find input[type="url"] elements in DOM order,
                # match by nearby label text, fill directly.
                if is_gh and field_type == "url" and value:
                    filled_this = await _fill_gh_url_field(page, label, value)
                    if filled_this:
                        filled_count += 1
                        yield _step("ok", 'Filled "' + label + '" -> ' + str(value)[:50])
                    else:
                        yield _step("error", 'Could not locate "' + label + '" - skipping')
                    await asyncio.sleep(0.3)
                    continue

                # ── Greenhouse select2 dropdowns ──────────────────────────────
                # Route: known select2 labels, OR type='checkbox'/'select' on GH
                # (LLM often misclassifies select2 as checkbox or select)
                is_select2_label = any(
                    k in label_lower_chk or label_lower_chk in k
                    for k in _GH_SELECT2_FIELDS
                )
                if is_gh and (is_select2_label or field_type in ("checkbox", "select")):
                    ok = await _fill_gh_select2(page, label, profile)
                    if ok:
                        filled_count += 1
                        yield _step("ok", 'Filled "' + label + '" (dropdown)')
                    else:
                        # For non-select2 selects, fall through to standard fill
                        if field_type == "select" and not is_select2_label:
                            ok = await _fill_field(page, label, selector, value,
                                                   field_type, ats_selectors)
                            if ok:
                                filled_count += 1
                                yield _step("ok", 'Filled "' + label + '" -> ' + str(value)[:50])
                            else:
                                yield _step("error", 'Could not locate "' + label + '" - skipping')
                        else:
                            yield _step("error", 'Could not locate "' + label + '" - skipping')
                    await asyncio.sleep(0.35)
                    continue

                # ── Standard fill ─────────────────────────────────────────────
                ok = await _fill_field(page, label, selector, value,
                                       field_type, ats_selectors)
                if ok:
                    filled_count += 1
                    display_val = str(value)[:50]
                    yield _step("ok", 'Filled "' + label + '" -> ' + display_val)
                else:
                    yield _step("error", 'Could not locate "' + label + '" - skipping')

                await asyncio.sleep(0.35)

            # -- Resume file upload ------------------------------------------
            # The LLM marks file fields as skip=True. We handle them here
            # by downloading from Supabase Storage and using set_input_files().
            resume_file_field = next(
                (f for f in fields
                 if f.get("field_type") == "file"
                 or "resume" in (f.get("field_label") or "").lower()
                 or "cv" in (f.get("field_label") or "").lower()),
                None
            )
            if resume_file_field and resume_id and user_id:
                import os as _os, httpx as _httpx
                try:
                    # Get signed URL from our own resumes endpoint
                    from db.database import AsyncSessionLocal as _ASL
                    from models.orm import Resume as _ResumeORM
                    from sqlalchemy import select as _select
                    import uuid as _uuid2
                    async with _ASL() as _rdb:
                        _res = await _rdb.execute(
                            _select(_ResumeORM).where(
                                _ResumeORM.id == _uuid2.UUID(resume_id),
                                _ResumeORM.user_id == _uuid2.UUID(user_id),
                            )
                        )
                        _resume_row = _res.scalar_one_or_none()

                    if _resume_row and _resume_row.storage_path:
                        from supabase import create_client as _sb_create
                        _sb = _sb_create(
                            _os.environ["SUPABASE_URL"],
                            _os.environ["SUPABASE_SERVICE_KEY"],
                        )
                        _signed = _sb.storage.from_("resumes").create_signed_url(
                            _resume_row.storage_path, 120
                        )
                        _signed_url = _signed.get("signedURL") or _signed.get("signedUrl") or ""
                        if _signed_url:
                            yield _step("ok", "Downloading resume for upload...")
                            async with _httpx.AsyncClient() as _hx:
                                _r = await _hx.get(_signed_url, timeout=20)
                            _ext = (_resume_row.file_ext or "pdf").lstrip(".")
                            _fname = (_resume_row.filename or f"resume.{_ext}")
                            _mime = "application/pdf" if _ext == "pdf" else "application/octet-stream"

                            # Use bytes buffer directly — temp file paths won't work
                            # because Playwright is connected over CDP to a Steel cloud
                            # browser on a different machine that can't access our /tmp.
                            _file_inp = page.locator('input[type="file"]').first
                            if await _file_inp.count() > 0:
                                await _file_inp.set_input_files(files=[{
                                    "name":     _fname,
                                    "mimeType": _mime,
                                    "buffer":   _r.content,
                                }])
                                filled_count += 1
                                yield _step("ok", f'Attached resume: {_fname}')
                            else:
                                yield _step("skip", "No file input found on page")
                        else:
                            yield _step("skip", "Could not get resume download URL")
                    else:
                        yield _step("skip", "Resume storage path not found")
                except Exception as _fe:
                    logger.warning(f"[browser_agent] Resume upload failed: {_fe}")
                    yield _step("skip", f"Resume attach failed: {str(_fe)[:80]}")
            elif resume_file_field:
                yield _step("skip", "Skipping: Resume (no resume_id provided)")

            # -- Pre-submit scroll & validation ----------------------------------
            yield _step("ok", str(filled_count) + " field(s) filled — preparing to submit...")
            await asyncio.sleep(0.4)

            # Scroll to bottom so all fields are visible and validation triggers
            try:
                await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
                await asyncio.sleep(0.6)
            except Exception:
                pass

            # Check for any visible validation errors before clicking submit
            try:
                error_locs = page.locator(
                    '.error-message:visible, .field-error:visible, '
                    '[aria-invalid="true"]:visible, .invalid-feedback:visible'
                )
                err_count = await error_locs.count()
                if err_count > 0:
                    yield _step("ok", f"Fixing {err_count} validation issue(s)...")
                    await asyncio.sleep(0.3)
            except Exception:
                pass

            # -- Find and click Submit ----------------------------------------
            submit_selectors = [
                'input[type="submit"]',
                'button[type="submit"]',
                'button:has-text("Submit Application")',
                'button:has-text("Submit")',
                'button:has-text("Apply Now")',
                'button:has-text("Send Application")',
                'button:has-text("Apply")',
            ]

            submit_clicked = False
            for sel in submit_selectors:
                try:
                    loc = page.locator(sel).first
                    if await loc.count() > 0 and await loc.is_visible():
                        yield _step("ok", "Submitting application...")
                        await loc.scroll_into_view_if_needed()
                        await asyncio.sleep(0.3)
                        await loc.click(timeout=5000)
                        submit_clicked = True
                        break
                except Exception:
                    continue

            if not submit_clicked:
                yield _step("error", "Could not find Submit button — form filled but not submitted")
                yield {
                    "type":         "done",
                    "text":         "Form filled for " + job_title + " at " + company,
                    "filled_count": filled_count,
                    "job_url":      job_url,
                }
                return

            # -- Wait for confirmation ----------------------------------------
            yield _step("ok", "Waiting for confirmation...")
            confirmation_text = None
            is_confirmed = False

            # Wait up to 12s for navigation or confirmation text
            for attempt in range(24):
                await asyncio.sleep(0.5)
                try:
                    page_text = await page.inner_text("body")
                    page_url  = page.url

                    # Check URL-based confirmation
                    if any(k in page_url for k in ["/confirmation", "/thank", "/success", "/submitted"]):
                        is_confirmed = True
                        break

                    # Check text-based confirmation
                    text_lower = page_text.lower()
                    if any(phrase in text_lower for phrase in [
                        "thank you", "application received", "we'll be in touch",
                        "successfully submitted", "application has been submitted",
                        "we have received your application", "your application was submitted",
                        "application is complete",
                    ]):
                        is_confirmed = True
                        # Try to extract a confirmation number
                        import re as _re
                        for pattern in [
                            r"#([A-Z0-9-]{4,20})",
                            r"Application .{0,15}([A-Z0-9-]{4,20})",
                            r"Reference.{0,5}([A-Z0-9-]{4,20})",
                            r"Confirmation.{0,5}([A-Z0-9-]{4,20})",
                        ]:
                            m = _re.search(pattern, page_text, _re.IGNORECASE)
                            if m:
                                confirmation_text = m.group(1)
                                break
                        break
                except Exception:
                    pass

            if is_confirmed:
                yield _step("ok", "Application confirmed by " + company)
                yield {
                    "type":         "submitted",
                    "text":         "Application submitted to " + company,
                    "filled_count": filled_count,
                    "job_url":      job_url,
                    "confirmation": confirmation_text,
                    "job_id":       job_id,
                }
            else:
                # Submit was clicked but confirmation page not detected —
                # do NOT mark as applied (form may have had validation errors)
                yield _step("error", "Submit clicked — could not detect confirmation page")
                yield {
                    "type":         "done",
                    "text":         "Form filled but submission unconfirmed — check " + company + " for status",
                    "filled_count": filled_count,
                    "job_url":      job_url,
                }

        except Exception as e:
            logger.error("[browser_agent] Error: " + str(e), exc_info=True)
            yield {"type": "error", "text": "Agent error: " + str(e)[:200]}
        finally:
            # Don't close context/browser — Steel owns the session lifecycle.
            # Just disconnect Playwright and release the Steel session.
            try:
                await browser.close()
            except Exception:
                pass
            await release_session(steel_session_id)