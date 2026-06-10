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
    "not_a_veteran":     "No military service",  # neutral phrase — LLM/vision maps to ATS-specific option
    "decline":           "I don't wish to answer",
}
_GH_DISABILITY_MAP = {
    "yes":     "Yes, I have a disability, or have had one in the past",
    "no":      "No, I do not have a disability and have not had one in the past",
    "decline": "I don't wish to answer",
}
# Ethnicity — maps profile value to a human display string.
# ATS options vary widely; the LLM text mapper picks the closest match from the live scraped list.
_GH_ETHNICITY_MAP = {
    "south_asian": "South Asian",
    "east_asian":  "East Asian",
    "black":       "Black or African American",
    "hispanic":    "Hispanic or Latinx",
    "white":       "White",
    "two_or_more": "Two or more races",
    "decline":     "I don't wish to answer",
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
    "ethnicity":           (_GH_ETHNICITY_MAP,    "ethnicity_eeo"),
    "race":                (_GH_ETHNICITY_MAP,    "ethnicity_eeo"),
    "ethnicities":         (_GH_ETHNICITY_MAP,    "ethnicity_eeo"),
}

# Standard "prefer not to answer" phrasings across ATSes — the universal fallback
# for any EEO field when the profile says decline or no specific option matches.
_EEO_DECLINE_CANDIDATES = [
    "Decline To Self Identify", "Decline to self identify",
    "I don't wish to answer", "I do not wish to answer",
    "Prefer not to say", "Prefer not to answer", "Prefer not to disclose",
    "Decline to answer", "I prefer not to answer", "Don't wish to answer",
]


def _match_eeo_option(options: list[str], candidates: list[str]) -> str | None:
    """
    Find the option that best matches any candidate phrase, in priority order:
      1. exact (normalized, case-insensitive)
      2. prefix (option starts with candidate, or candidate starts with option)
      3. substring (candidate in option, or option in candidate)
    Word-normalized so "No*" / "  No " / "NO" all match "no". Returns the original
    option string (verbatim, for the click), or None.
    """
    if not options:
        return None
    def _norm(s: str) -> str:
        return " ".join((s or "").lower().replace("*", " ").split())
    norm = [(o, _norm(o)) for o in options]
    cands = [_norm(c) for c in candidates if c and c.strip()]
    # 1. exact
    for c in cands:
        for o, ol in norm:
            if ol == c:
                return o
    # 2. prefix (guard tiny candidates so "no" only prefix-matches "no..." like "not hispanic")
    for c in cands:
        if len(c) < 2:
            continue
        for o, ol in norm:
            if ol.startswith(c) or (len(ol) >= 3 and c.startswith(ol)):
                return o
    # 3. substring
    for c in cands:
        if len(c) < 3:
            continue
        for o, ol in norm:
            if c in ol or ol in c:
                return o
    return None


def _eeo_field_kind(label: str, options: list[str]) -> str | None:
    """
    Classify an EEO/demographic field from BOTH its label and its option contents.
    Option contents are authoritative — a form may mislabel the field, but the
    option set (e.g. Asian/White/Black, or Hispanic/Not Hispanic) is ground truth.
    Returns: "race" | "hispanic" | "gender" | "veteran" | "disability" | None.
    """
    ll = (label or "").lower()
    blob = " | ".join((o or "").lower() for o in (options or []))

    # Race picker — real racial categories present in the options.
    race_signals = (
        "black or african", "native hawaiian", "american indian", "alaska native",
        "two or more races", "pacific islander",
    )
    has_race_options = any(s in blob for s in race_signals) or ("asian" in blob and "white" in blob)
    label_says_race  = any(k in ll for k in ("ethnicit", "race", "racial"))

    if has_race_options:
        return "race"
    # Label mentions race/ethnicity but options are a Hispanic Yes/No set → hispanic.
    if label_says_race and ("hispanic" in blob or "latino" in blob):
        return "hispanic"
    if label_says_race:
        return "race"
    if any(k in ll for k in ("hispanic", "latino")) or "hispanic" in blob or "latino" in blob:
        return "hispanic"
    if "gender" in ll or ll.strip() in ("sex", "what is your sex"):
        return "gender"
    if "veteran" in ll or "military" in ll or "protected veteran" in blob:
        return "veteran"
    if "disab" in ll or "disability" in blob:
        return "disability"
    return None


def _resolve_eeo_combobox(label: str, options: list[str], profile: dict) -> str | None:
    """
    Deterministically pick the correct option for an EEO/demographic combobox from
    the user's profile, matched against the LIVE scraped options. Returns the exact
    option string to click, or None if this isn't an EEO field (caller falls back
    to the generic LLM picker).

    This is the single source of truth for EEO answers and runs in every place a
    combobox is resolved (post-detect loop, fill loop, dynamic post-fill scan).
    """
    kind = _eeo_field_kind(label, options)
    if not kind:
        return None

    eth = (profile.get("ethnicity_eeo") or "decline")
    _decline = lambda: _match_eeo_option(options, _EEO_DECLINE_CANDIDATES)

    if kind == "hispanic":
        if eth == "hispanic":
            return (_match_eeo_option(options, ["Yes", "Hispanic or Latino", "Hispanic/Latino", "Yes, Hispanic or Latino"])
                    or _decline())
        # Not Hispanic — note "No" prefix-matches "Not Hispanic or Latino"
        return (_match_eeo_option(options, [
                    "No", "Not Hispanic or Latino", "Not Hispanic/Latino", "Not Hispanic",
                    "I am not Hispanic or Latino", "No, not Hispanic or Latino",
                ]) or _decline())

    if kind == "race":
        disp = _GH_ETHNICITY_MAP.get(eth, "I don't wish to answer")
        if eth == "decline":
            return _decline()
        cands = [disp]
        if eth in ("south_asian", "east_asian"):
            # Most ATSes collapse to a single "Asian" bucket.
            cands += ["Asian", "Asian (Not Hispanic or Latino)", "Asian American", "Asian/Pacific Islander"]
        elif eth == "black":
            cands += ["Black or African American", "Black", "African American"]
        elif eth == "white":
            cands += ["White", "White (Not Hispanic or Latino)", "Caucasian"]
        elif eth == "two_or_more":
            cands += ["Two or More Races", "Two or more races", "Multiracial"]
        return (_match_eeo_option(options, cands) or _decline())

    if kind == "gender":
        g = (profile.get("gender_eeo") or "decline")
        disp = _GH_GENDER_MAP.get(g, "I don't wish to answer")
        return (_match_eeo_option(options, [disp, g.replace("_", " ").title(), g.title()]) or _decline())

    if kind == "veteran":
        v = (profile.get("veteran_status") or "decline")
        disp = _GH_VETERAN_MAP.get(v, "I don't wish to answer")
        cands = [disp]
        if v == "not_a_veteran":
            cands += ["I am not a protected veteran", "Not a protected veteran",
                      "I am not a veteran", "No military service", "No"]
        elif v == "protected_veteran":
            cands += ["I am a protected veteran", "I identify as one or more of the classifications of protected veteran"]
        return (_match_eeo_option(options, cands) or _decline())

    if kind == "disability":
        d = (profile.get("disability_status") or "decline")
        disp = _GH_DISABILITY_MAP.get(d, "I don't wish to answer")
        cands = [disp]
        if d == "no":
            cands += ["No, I do not have a disability and have not had one in the past",
                      "No, I do not have a disability", "No", "I do not have a disability"]
        elif d == "yes":
            cands += ["Yes, I have a disability, or have had one in the past",
                      "Yes, I have a disability", "Yes"]
        return (_match_eeo_option(options, cands) or _decline())

    return None


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


async def _fill_react_combobox(page, selector_hint: str, label: str, value: str, profile: dict | None = None) -> bool:
    """
    Fill a React combobox (class='select__input') — used by Reddit, newer Greenhouse, etc.

    Core strategy:
      1. Find the combobox input by ID from DOM snapshot (hint = id attribute)
      2. Click its GRANDPARENT container to open the dropdown (the container div,
         not the input itself, is what triggers the open state)
      3. Clear the search box, then try three search strategies:
         a) No search — click "open all options" and look for exact match
         b) Short unique prefix (2-3 chars) to avoid substring false matches
         c) Full value typed in case search is needed
      4. Click the option that contains the display value as EXACT text (not substring)
         — uses JS text comparison to avoid "Male" matching "Female"
      5. Escape and return False if nothing found — never leaves dropdown open
    """
    _NORMALIZE = {
        "yes": "Yes", "no": "No",
        "true": "Yes", "false": "No",
    }
    display_value = _NORMALIZE.get(value.lower().strip(), value)

    async def _try_click_option(page, display_value: str) -> bool:
        """
        Click the option whose visible text EXACTLY matches display_value.
        Falls back to starts-with match, then contains match.
        Uses JS to compare text content — avoids has-text() substring issues.
        """
        try:
            # JS exact match first — most reliable, avoids "Male" matching "Female"
            clicked = await page.evaluate(
                """([target]) => {
                    const normalize = s => s.toLowerCase().replace(/[*\s]+/g, ' ').trim();
                    const t = normalize(target);
                    const candidates = [
                        ...document.querySelectorAll('[class*="option"]'),
                        ...document.querySelectorAll('[role="option"]'),
                        ...document.querySelectorAll('li'),
                    ];
                    // 1. Exact match
                    for (const el of candidates) {
                        const txt = normalize(el.textContent || '');
                        if (txt === t && el.offsetParent !== null) { el.click(); return 'exact:' + txt; }
                    }
                    // 2. Starts-with match
                    for (const el of candidates) {
                        const txt = normalize(el.textContent || '');
                        if (txt.startsWith(t.slice(0,12)) && el.offsetParent !== null) { el.click(); return 'starts:' + txt; }
                    }
                    // 3. Contains match — last resort
                    for (const el of candidates) {
                        const txt = normalize(el.textContent || '');
                        if (txt.includes(t) && el.offsetParent !== null) { el.click(); return 'contains:' + txt; }
                    }
                    return null;
                }""",
                [display_value]
            )
            if clicked:
                logger.debug(f"[react_combobox] JS click matched '{display_value}' via {clicked}")
                await asyncio.sleep(0.3)
                return True
        except Exception as _je:
            logger.debug(f"[react_combobox] JS click failed: {_je}")
        return False

    try:
        hint = (selector_hint or "").strip()

        # ── Step 1: Locate the combobox input ────────────────────────────────
        combobox = None
        for sel in [
            f'input.select__input[id="{hint}"]',
            f'input[class*="select__input"][id="{hint}"]',
        ]:
            loc = page.locator(sel).first
            if await loc.count() > 0:
                combobox = loc
                break

        # Fallback: find by label text proximity
        if not combobox:
            all_cb = page.locator('input.select__input')
            count = await all_cb.count()
            label_words = [w for w in label.lower().split() if len(w) > 3]
            for i in range(count):
                cb = all_cb.nth(i)
                try:
                    nearby = await page.evaluate(
                        """el => {
                            let node = el;
                            for (let i = 0; i < 7; i++) {
                                if (!node.parentElement) break;
                                node = node.parentElement;
                                const t = node.textContent || '';
                                if (t.length > 10 && t.length < 600) return t.toLowerCase();
                            }
                            return '';
                        }""",
                        await cb.element_handle()
                    )
                    if sum(1 for w in label_words[:4] if w in nearby) >= 2:
                        combobox = all_cb.nth(i)
                        break
                except Exception:
                    continue

        if not combobox:
            logger.warning(f"[react_combobox] Could not locate combobox for '{label}'")
            return False

        # ── Step 2: Click the container to open the dropdown ─────────────────
        # Try grandparent first (the outer container div that React listens on)
        opened = False
        for ancestor in ["xpath=../../..", "xpath=../..", "xpath=.."]:
            try:
                container = combobox.locator(ancestor).first
                await container.click(timeout=2000)
                await asyncio.sleep(0.5)
                # Check if any option is now visible
                vis = await page.evaluate(
                    """() => document.querySelectorAll('[class*="option"],[role="option"]').length"""
                )
                if vis > 0:
                    opened = True
                    break
            except Exception:
                continue

        if not opened:
            # Direct click on the input itself as last resort
            try:
                await combobox.click(timeout=2000)
                await asyncio.sleep(0.5)
            except Exception:
                pass

        # ── Step 3: Scrape options immediately while dropdown is open ────────
        # Use getBoundingClientRect() for visibility — NOT offsetParent.
        # React portals (position:fixed / CSS transform) have offsetParent===null
        # even when fully visible on screen. getBoundingClientRect().width > 0
        # is the correct cross-portal visibility check.
        _scraped_options = []
        try:
            _scraped_options = await page.evaluate(
                """() => {
                    const isVisible = el => {
                        const r = el.getBoundingClientRect();
                        return r.width > 0 && r.height > 0;
                    };
                    const MENU_SELECTORS = [
                        '[role="listbox"]',
                        '[class*="menu"]',
                        '[class*="listbox"]',
                        '[class*="dropdown-menu"]',
                        '[class*="options-container"]',
                    ];
                    let menuEl = null;
                    for (const sel of MENU_SELECTORS) {
                        for (const el of document.querySelectorAll(sel)) {
                            if (isVisible(el) && el.children.length > 0) {
                                menuEl = el; break;
                            }
                        }
                        if (menuEl) break;
                    }
                    const source = menuEl
                        ? menuEl.querySelectorAll('[class*="option"], [role="option"], li')
                        : document.querySelectorAll('[class*="option"], [role="option"]');
                    const seen = new Set();
                    const results = [];
                    for (const el of source) {
                        const t = (el.textContent || '').trim();
                        if (t && t.length >= 2 && t.length <= 80 && isVisible(el) && !seen.has(t)) {
                            seen.add(t);
                            results.push(t);
                        }
                    }
                    return results.slice(0, 40);
                }"""
            )
            if _scraped_options:
                logger.info(f"[react_combobox] Dropdown options for '{label}': {_scraped_options}")
        except Exception as _se:
            logger.debug(f"[react_combobox] Option scrape failed: {_se}")

        # ── Step 3-EEO: deterministic EEO resolution against the REAL options ──
        # Demographic fields (race, hispanic, gender, veteran, disability) must be
        # answered from the user's profile, never by the generic LLM picker (which
        # defaults sensitive questions to "Decline"). Detected from the option set
        # itself, so it works even when the form's label is vague. This runs before
        # any generic matching so it always wins for EEO fields.
        if profile and _scraped_options:
            try:
                _eeo_pick = _resolve_eeo_combobox(label, _scraped_options, profile)
                if _eeo_pick:
                    logger.info(f"[react_combobox] EEO resolver picked '{_eeo_pick}' for '{label}'")
                    if await _try_click_option(page, _eeo_pick):
                        return True
            except Exception as _eeoe:
                logger.debug(f"[react_combobox] EEO resolve failed: {_eeoe}")

        # ── Step 3-vision: Screenshot fallback when DOM scrape returns empty ──
        # Some dropdowns (especially EEO/demographic ones) render options in a
        # CSS-transformed portal that offsetParent checks miss. When DOM scrape
        # returns nothing, take a screenshot and ask GPT-4o-mini vision to read
        # the visible options and pick the best match for our intent.
        _vision_best_option = None
        if not _scraped_options:
            try:
                import base64 as _b64, os as _os3, httpx as _hx3
                _api_key_v = _os3.environ.get("OPENAI_API_KEY", "")
                if _api_key_v:
                    # Scroll the combobox into view before screenshotting so the
                    # open dropdown portal is fully visible in the viewport
                    try:
                        await combobox.scroll_into_view_if_needed(timeout=1000)
                        await asyncio.sleep(0.3)
                    except Exception:
                        pass
                    _screenshot_bytes = await page.screenshot(full_page=False)
                    _img_b64 = _b64.b64encode(_screenshot_bytes).decode("utf-8")
                    _vision_prompt = (
                        f"This is a screenshot of a job application form with a dropdown menu open.\n"
                        f"The open dropdown is for the question: \"{label}\"\n"
                        f"The dropdown options are listed/visible in the screenshot right now.\n"
                        f"The candidate wants to convey: \"{display_value}\"\n\n"
                        f"IMPORTANT: Look ONLY at the dropdown list options visible in the screenshot "
                        f"(not any already-selected value shown in the field box). "
                        f"From those listed options, pick the single one that best matches what the "
                        f"candidate wants to convey. Reply with ONLY that exact option text verbatim. "
                        f"Do not explain. If no dropdown options are visible, reply: NONE"
                    )
                    async with _hx3.AsyncClient() as _hcv:
                        _vresp = await _hcv.post(
                            "https://api.openai.com/v1/chat/completions",
                            headers={"Authorization": f"Bearer {_api_key_v}", "Content-Type": "application/json"},
                            json={
                                "model": "gpt-4o-mini",
                                "messages": [{
                                    "role": "user",
                                    "content": [
                                        {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{_img_b64}", "detail": "low"}},
                                        {"type": "text", "text": _vision_prompt},
                                    ]
                                }],
                                "temperature": 0.0,
                                "max_tokens": 60,
                            },
                            timeout=15.0,
                        )
                    _vision_option = _vresp.json()["choices"][0]["message"]["content"].strip().strip('"').strip("'")
                    if _vision_option and _vision_option.upper() != "NONE":
                        logger.info(f"[react_combobox] Vision LLM picked '{_vision_option}' for '{label}' (display_value='{display_value}')")
                        # Inject the vision-picked option into scraped_options so the
                        # normal LLM + click flow below can use it
                        _scraped_options = [_vision_option]
                        _vision_best_option = _vision_option
                    else:
                        logger.warning(f"[react_combobox] Vision LLM returned NONE for '{label}'")
            except Exception as _ve:
                logger.warning(f"[react_combobox] Vision screenshot fallback failed: {_ve}")

        # ── Step 3a: Direct click if display_value matches a scraped option ───
        # Now that we have the real options, first try direct click (no typing).
        # If the vision path ran, the dropdown may have closed during the screenshot.
        # Re-open by clicking the container before attempting to click the option.
        if _scraped_options:
            # Ensure dropdown is open (vision path may have closed it)
            try:
                vis = await page.evaluate(
                    """() => document.querySelectorAll('[class*="option"],[role="option"]').length"""
                )
                if vis == 0:
                    for ancestor in ["xpath=../../..", "xpath=../..", "xpath=.."]:
                        try:
                            container = combobox.locator(ancestor).first
                            await container.click(timeout=2000)
                            await asyncio.sleep(0.4)
                            vis2 = await page.evaluate(
                                """() => document.querySelectorAll('[class*="option"],[role="option"]').length"""
                            )
                            if vis2 > 0:
                                break
                        except Exception:
                            continue
            except Exception:
                pass
        if await _try_click_option(page, display_value):
            return True

        # ── Step 3b: LLM picks the best option from the real scraped list ─────
        # If display_value isn't an exact option (e.g. "I am not a protected
        # veteran" vs actual option "No military service"), ask the LLM to map.
        # Skip this call when vision already returned a single authoritative option.
        _best_option = _vision_best_option if _vision_best_option else None
        if _scraped_options and not _vision_best_option:
            import httpx as _hx2, os as _os2
            _api_key = _os2.environ.get("OPENAI_API_KEY", "")
            if _api_key:
                _options_str = "\n".join(f"- {o}" for o in _scraped_options)
                _prompt = (
                    f"A job application dropdown for the question \"{label}\" has these options:\n"
                    f"{_options_str}\n\n"
                    f"The candidate wants to convey: \"{display_value}\"\n"
                    "Which single option from the list best matches what the candidate wants? "
                    "Reply with ONLY the exact option text copied verbatim. "
                    "If truly none fit, reply with the option that is most neutral or decline-to-answer."
                )
                try:
                    async with _hx2.AsyncClient() as _hc:
                        _resp = await _hc.post(
                            "https://api.openai.com/v1/chat/completions",
                            headers={"Authorization": f"Bearer {_api_key}", "Content-Type": "application/json"},
                            json={"model": "gpt-4o-mini",
                                  "messages": [{"role": "user", "content": _prompt}],
                                  "temperature": 0.0, "max_tokens": 80},
                            timeout=10.0,
                        )
                    _best_option = _resp.json()["choices"][0]["message"]["content"].strip().strip('"').strip("'")
                    logger.info(f"[react_combobox] LLM mapped '{display_value}' → '{_best_option}'")
                except Exception as _le:
                    logger.debug(f"[react_combobox] LLM option pick failed: {_le}")

        if _best_option and await _try_click_option(page, _best_option):
            return True

        # ── Step 3c: Type 3-char prefix of the LLM-chosen option and retry ────
        # Some dropdowns need a search term to filter before options are clickable.
        _search_target = _best_option or display_value
        short_prefix = _search_target[:3]
        try:
            await combobox.fill("", timeout=2000)
            await asyncio.sleep(0.2)
            await combobox.type(short_prefix, timeout=2000)
            await asyncio.sleep(0.5)
        except Exception:
            pass
        if await _try_click_option(page, _search_target):
            return True

        # ── Step 3d: Type more chars and try once more ────────────────────────
        try:
            await combobox.fill("", timeout=2000)
            await asyncio.sleep(0.2)
            await combobox.type(_search_target[:12], timeout=2000)
            await asyncio.sleep(0.5)
        except Exception:
            pass
        if await _try_click_option(page, _search_target):
            return True

        # ── Step 3e: Heuristic fallback on scraped options ────────────────────
        # No LLM, or LLM returned something that still didn't click — scan the
        # scraped options for common semantic patterns.
        if _scraped_options:
            _dl = display_value.lower()
            _HEURISTICS = [
                # veteran / military
                (["no military", "not a veteran", "not veteran", "none"], ["veteran", "military", "served"]),
                # disability
                (["no disability", "no, i do not", "not have a disability"], ["disability", "disabled", "ada"]),
                # decline / prefer not to answer
                (["prefer not", "decline", "don't wish", "not wish", "no answer"], []),
            ]
            for _matches, _triggers in _HEURISTICS:
                _triggered = not _triggers or any(t in _dl for t in _triggers)
                if _triggered:
                    for _opt in _scraped_options:
                        if any(k in _opt.lower() for k in _matches):
                            # Clear search and try clicking this option directly
                            try:
                                await combobox.fill("", timeout=2000)
                                await asyncio.sleep(0.3)
                            except Exception:
                                pass
                            if await _try_click_option(page, _opt):
                                logger.info(f"[react_combobox] Heuristic matched '{_opt}' for '{display_value}'")
                                return True

        # ── Close and give up ─────────────────────────────────────────────────
        try:
            await page.keyboard.press("Escape")
            await asyncio.sleep(0.2)
        except Exception:
            pass
        logger.warning(f"[react_combobox] No option matched '{display_value}' for '{label}'")
        return False

    except Exception as e:
        logger.warning(f"[react_combobox] Outer error for '{label}': {e}")
        try:
            await page.keyboard.press("Escape")
        except Exception:
            pass
        return False



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
    # Open-ended achievement / work questions
    "exceptional work", "what work", "proud of", "most proud",
    "notable", "significant", "impact", "contribution", "project",
    "built", "created", "solved", "improved",
]

# Questions where a fixed short answer beats LLM generation
_FIXED_ANSWERS = {
    "hear about":       "RACK — an AI job matching tool",
    "how did you find": "RACK — an AI job matching tool",
    "referred by":      "",   # skip — no referrer
    "how did you hear": "RACK — an AI job matching tool",
}

# Privacy/consent dropdown answer map — keyed by label substring.
# These comboboxes always have an "I agree" style option as the only valid choice.
_CONSENT_DROPDOWN_PHRASES = [
    "i agree",
    "i understand",
    "candidate privacy",
    "privacy policy",
    "data processing",
    "consent to",
    "by selecting",
]
_CONSENT_OPTION_CANDIDATES = [
    "I agree",
    "I Agree",
    "I agree to the terms",
    "I agree.",
    "I understand",
    "Yes",
]

async def _scrape_combobox_options(page, selector_hint: str) -> list[str]:
    """
    Open a React combobox, scrape its visible options, then close it.
    Returns a list of option strings (may be empty on failure).

    Strategy:
    1. Scroll the element into view first (critical — off-screen elements don't respond to JS click)
    2. Click the grandparent container via Playwright locator (more reliable than pure JS click)
    3. Wait for dropdown to render, then scrape visible options
    4. Close with Escape
    """
    try:
        # Step 1: Scroll element into view
        await page.evaluate(
            "(hint) => { const el = document.getElementById(hint); if (el) el.scrollIntoView({block:'center', behavior:'instant'}); }",
            selector_hint,
        )
        await asyncio.sleep(0.3)

        # Step 2: Click the grandparent container to open the dropdown
        # Try Playwright locator first (respects visibility), fall back to JS click
        _opened = False
        try:
            _loc = page.locator(f"#{selector_hint}").locator("xpath=../..").first
            if await _loc.count() > 0:
                await _loc.click(timeout=3000)
                _opened = True
        except Exception:
            pass

        if not _opened:
            # JS fallback
            await page.evaluate(
                "(hint) => { const el = document.getElementById(hint); const gp = el?.parentElement?.parentElement; if (gp) gp.click(); }",
                selector_hint,
            )

        await asyncio.sleep(0.6)

        # Step 3: Scrape visible options
        options = await page.evaluate("""() => {
            const candidates = [
                ...document.querySelectorAll('[class*="option"]'),
                ...document.querySelectorAll('[role="option"]'),
            ];
            const visible = candidates.filter(el => el.offsetParent !== null);
            return [...new Set(visible.map(el => el.textContent?.trim()).filter(Boolean))];
        }""")

        # Step 4: Close dropdown
        await page.keyboard.press("Escape")
        await asyncio.sleep(0.3)
        return options or []
    except Exception:
        try:
            await page.keyboard.press("Escape")
        except Exception:
            pass
        return []


async def _pick_safe_combobox_answer(question: str, options: list[str], profile: dict) -> str | None:
    """
    Given a question label and its available options, use GPT-4o-mini to pick
    the safest, most neutral answer for a job applicant.

    Returns the exact option string to select, or None if truly unanswerable.
    """
    if not options:
        return None

    import httpx, os, json, re as _re
    api_key = os.environ.get("OPENAI_API_KEY", "")

    # Build minimal profile context (no PII bulk)
    ctx_parts = []
    if profile.get("work_auth"):
        ctx_parts.append(f"US work authorized: {profile['work_auth']}")
    if profile.get("requires_sponsorship") is not None:
        ctx_parts.append(f"Needs sponsorship: {profile['requires_sponsorship']}")
    ctx = "; ".join(ctx_parts) if ctx_parts else "Standard job applicant, no special background."

    prompt = f"""You are helping a job applicant fill out an application form dropdown.

Question: {question}
Available options:
{chr(10).join(f'  - {o}' for o in options)}

Applicant context: {ctx}

Rules:
1. Pick the single best option for a typical software engineer applicant with no military/government/security clearance background.
2. For conflict-of-interest or government employment questions: choose "No" or the most negative/neutral option.
3. For clearance questions: choose "None" or "No" or the equivalent that means the applicant has no current clearance.
4. For "have you worked here before" questions: choose "No".
5. For eligibility questions: choose the option that best fits a civilian software engineer.
6. Return ONLY the exact option text from the list above. Nothing else."""

    try:
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                "https://api.openai.com/v1/chat/completions",
                headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                json={
                    "model": "gpt-4o-mini",
                    "messages": [{"role": "user", "content": prompt}],
                    "temperature": 0.0,
                    "max_tokens": 60,
                },
                timeout=10.0,
            )
        raw = resp.json()["choices"][0]["message"]["content"].strip()
        # Validate response is actually one of the options (fuzzy)
        raw_lower = raw.lower()
        for opt in options:
            if opt.lower() == raw_lower or opt.lower().startswith(raw_lower[:20]):
                return opt
        # Return raw if it looks reasonable
        return raw if len(raw) < 120 else None
    except Exception as _e:
        logger.warning(f"[browser_agent] _pick_safe_combobox_answer LLM failed: {_e}")
        return None


def _is_free_text_question(label: str) -> bool:
    ll = label.lower()
    return any(s in ll for s in _FREE_TEXT_SIGNALS)


# -- Main agent generator -----------------------------------------------------

async def run_apply_agent(
    job_url:      str,
    job_title:    str,
    company:      str,
    resume_text:  str,
    profile:      dict,
    job_id:       str | None           = None,
    resume_id:    str | None           = None,
    user_id:      str | None           = None,
    review_event: asyncio.Event | None = None,  # set by /api/apply/confirm endpoint
) -> AsyncGenerator[dict, None]:
    """
    Async generator yielding SSE-ready step dicts.

    review_event: if provided, the agent pauses before clicking Submit and
    waits for this Event to be set (by the /api/apply/confirm endpoint).
    Times out after 90 seconds — yields review_timeout and aborts.
    """
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

            # -- DOM structural snapshot — extract every form element with full
            # context: id, name, label text, parent question text, select options.
            # Passed to detect_fields() as a second representation alongside the
            # raw HTML — LLM uses the clean field table to produce accurate selector_hints.
            dom_snapshot = []
            try:
                dom_snapshot = await page.evaluate("""() => {
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
                for el in dom_snapshot:
                    logger.info(f"[dom_dump] {el}")
                logger.info(f"[browser_agent] DOM snapshot: {len(dom_snapshot)} elements captured")
            except Exception as _de:
                logger.warning(f"[dom_dump] failed: {_de}")

            # -- LLM field detection ------------------------------------------
            yield _step("ok", "Analysing form fields...")

            augmented_profile = dict(profile)
            augmented_profile["_ats_hint"] = ats_hint
            fields = await detect_fields(raw_html, augmented_profile, dom_snapshot=dom_snapshot)

            if not fields:
                yield {"type": "error", "text": "Could not detect form fields. This ATS may require manual application."}
                return

            # Also handle Greenhouse's "Full Name" -> split into first/last
            expanded = []
            for f in fields:
                lbl = (f.get("field_label") or "").lower()
                if "full name" in lbl and "greenhouse.io" in job_url:
                    # Prefer explicit first_name/last_name from profile (legal name)
                    # over splitting the Google display name
                    _fname = profile.get("first_name") or ""
                    _lname = profile.get("last_name") or ""
                    if not _fname and not _lname:
                        name_parts = (f.get("value") or "").split(" ", 1)
                        _fname = name_parts[0] if name_parts else ""
                        _lname = name_parts[1] if len(name_parts) > 1 else ""
                    expanded.append({**f, "field_label": "First Name",
                                     "selector_hint": "first_name",
                                     "value": _fname})
                    expanded.append({**f, "field_label": "Last Name",
                                     "selector_hint": "last_name",
                                     "value": _lname})
                else:
                    expanded.append(f)
            fields = expanded

            # -- DOM-grounding filter -----------------------------------------
            # Drop any field whose selector_hint doesn't match an actual id or
            # name in the DOM snapshot. This prevents form_filler hallucinating
            # EEO fields (gender, veteran, disability) on forms that don't have
            # them, which causes noisy "Could not locate" errors in the fill loop.
            _dom_ids   = {str(el.get("id",   "")) for el in dom_snapshot if el.get("id")}
            _dom_names = {str(el.get("name", "")) for el in dom_snapshot if el.get("name")}
            _dom_hints = _dom_ids | _dom_names
            # Always-valid hints: standard top-level fields Greenhouse uses by convention
            _ALWAYS_VALID = {"first_name", "last_name", "email", "phone", "resume", "cover_letter"}
            _before_filter = len(fields)
            fields_grounded = []
            for _gf in fields:
                _hint = _gf.get("selector_hint", "")
                _ftype = _gf.get("field_type", "")
                # Keep if: hint in DOM, hint is always-valid, field is a file type,
                # or hint is empty (edge case — let fill loop handle it)
                if (
                    not _hint
                    or _hint in _dom_hints
                    or _hint in _ALWAYS_VALID
                    or _ftype == "file"
                ):
                    fields_grounded.append(_gf)
                else:
                    logger.info(
                        f"[browser_agent] DOM-filter dropped hallucinated field: "
                        f"{_gf.get('field_label')!r} (hint={_hint!r})"
                    )
            fields = fields_grounded
            if len(fields) < _before_filter:
                logger.info(
                    f"[browser_agent] DOM-filter: {_before_filter - len(fields)} field(s) removed"
                )

            fillable = [f for f in fields if not f.get("skip")]
            yield _step("ok", "Found " + str(len(fillable)) + " fields to fill")
            # Debug: log every detected field so we can see what LLM returned
            for _dbg in fields:
                logger.info(f"[field_debug] label={_dbg.get('field_label')!r} "
                            f"type={_dbg.get('field_type')!r} "
                            f"hint={_dbg.get('selector_hint')!r} "
                            f"skip={_dbg.get('skip')} "
                            f"value={str(_dbg.get('value',''))[:40]!r}")

            # -- Build sets of known field types from DOM snapshot -----------
            # select__input → React combobox widget (open/type/click pattern)
            # type=checkbox  → standard checkbox (direct .check() — never route to select2)
            _react_combobox_ids = set()
            _checkbox_ids = set()
            for _el in dom_snapshot:
                if 'select__input' in _el.get('classes', '') and _el.get('id'):
                    _react_combobox_ids.add(str(_el['id']))
                if _el.get('type') == 'checkbox' and _el.get('id'):
                    _checkbox_ids.add(str(_el['id']))
                if _el.get('type') == 'checkbox' and _el.get('name'):
                    _checkbox_ids.add(str(_el['name']))
            if _react_combobox_ids:
                logger.info(f"[browser_agent] React combobox IDs: {_react_combobox_ids}")
            if _checkbox_ids:
                logger.info(f"[browser_agent] Checkbox IDs: {_checkbox_ids}")

            # -- Post-detect pass: resolve skipped/missing React combobox fields --
            # Handles two cases:
            #   A) fields with skip=True (form_filler had no profile value)
            #   B) comboboxes in _react_combobox_ids that form_filler omitted entirely
            #      (e.g. hispanic_ethnicity dropped by non-deterministic LLM output)
            # For each, scroll into view, scrape live options, LLM-pick a safe answer.
            _FILE_LABELS = {"resume", "attach", "cover letter", "cover_letter", "cv"}

            # Build set of selector_hints already in fields list
            _fields_hints = {f.get("selector_hint", "") for f in fields}

            # Case A: skip=True fields that are React comboboxes
            _resolve_targets = []
            for _sf in fields:
                if not _sf.get("skip"):
                    continue
                _sf_hint  = _sf.get("selector_hint", "")
                _sf_label = _sf.get("field_label", "")
                _sf_type  = _sf.get("field_type", "")
                if _sf_hint not in _react_combobox_ids:
                    continue
                if _sf_type == "file" or any(fl in _sf_label.lower() for fl in _FILE_LABELS):
                    continue
                _resolve_targets.append(("field", _sf, _sf_hint, _sf_label))

            # Case B: comboboxes in DOM that form_filler dropped entirely
            for _dom_el in dom_snapshot:
                _dom_id = str(_dom_el.get("id", ""))
                if not _dom_id or _dom_id not in _react_combobox_ids:
                    continue
                if _dom_id in _fields_hints:
                    continue  # already handled above
                _dom_label = _dom_el.get("labelText") or _dom_el.get("parentText", "")[:80]
                if any(fl in _dom_label.lower() for fl in _FILE_LABELS):
                    continue
                # Synthesise a new field entry for this orphaned combobox
                _new_field = {
                    "field_label":    _dom_label,
                    "selector_hint":  _dom_id,
                    "field_type":     "text",
                    "value":          "",
                    "skip":           True,
                }
                fields.append(_new_field)
                _resolve_targets.append(("field", _new_field, _dom_id, _dom_label))
                logger.info(f"[browser_agent] Orphaned combobox added to resolve targets: {_dom_label!r} (id={_dom_id})")

            for (_, _sf, _sf_hint, _sf_label) in _resolve_targets:
                try:
                    logger.info(f"[browser_agent] Resolving combobox: {_sf_label!r}")
                    _opts = await _scrape_combobox_options(page, _sf_hint)
                    if not _opts:
                        logger.warning(f"[browser_agent] No options scraped for {_sf_label!r} — leaving skipped")
                        continue
                    logger.info(f"[browser_agent] Combobox options for {_sf_label!r}: {_opts}")

                    # ── Profile-aware EEO resolution before the generic LLM ─────
                    # Race / hispanic / gender / veteran / disability are answered
                    # deterministically from the profile, matched against the live
                    # scraped options. Detected from the options themselves, so a
                    # vague label (e.g. "Self-Identification") still resolves right.
                    _picked = _resolve_eeo_combobox(_sf_label, _opts, profile)
                    if _picked:
                        logger.info(f"[browser_agent] EEO override: {_sf_label!r} → {_picked!r}")
                        _sf["_eeo_resolved"] = True

                    # Fall back to LLM if no profile override matched
                    if not _picked:
                        _picked = await _pick_safe_combobox_answer(_sf_label, _opts, profile)

                    if _picked:
                        _sf["skip"]  = False
                        _sf["value"] = _picked
                        logger.info(f"[browser_agent] Resolved {_sf_label!r} → {_picked!r}")
                    else:
                        logger.warning(f"[browser_agent] LLM could not pick for {_sf_label!r} — leaving skipped")
                except Exception as _rse:
                    logger.warning(f"[browser_agent] Post-detect resolve failed for {_sf_label!r}: {_rse}")

            # Recount fillable after post-detect resolution
            fillable_after = [f for f in fields if not f.get("skip")]
            _newly_resolved = len(fillable_after) - len(fillable)
            if _newly_resolved > 0:
                yield _step("ok", f"Resolved {_newly_resolved} additional fields")

            # -- Fill loop ----------------------------------------------------
            filled_count = 0

            for field in fields:
                label      = field.get("field_label", "Unknown")
                selector   = field.get("selector_hint", "")
                field_type = field.get("field_type", "text")
                value      = field.get("value", "")
                skip       = field.get("skip", False)

                # ── Pre-skip rescue: un-skip fields we can handle regardless ──
                # form_filler sets skip=True when it has no profile value.
                # But some field types we handle ourselves — rescue them here
                # before the skip guard fires.
                if skip:
                    _label_lower_rescue = label.lower()
                    # Rescue 1: free-text textareas — write_free_text() handles these
                    if field_type == "textarea" and _is_free_text_question(label):
                        skip = False
                        value = ""  # write_free_text path below will generate the answer
                    # Rescue 2: native language name fields — we fill from profile
                    elif "native language" in _label_lower_rescue or "native script" in _label_lower_rescue:
                        _legal = profile.get("name") or (
                            (profile.get("first_name", "") + " " + profile.get("last_name", "")).strip()
                        )
                        if _legal:
                            skip  = False
                            value = _legal

                if skip:
                    yield _step("skip", "Skipping: " + label)
                    await asyncio.sleep(0.1)
                    continue

                # ── Override name fields with legal name from profile ──────────
                # The LLM field detector may set value from profile["name"] (Google display name).
                # If the user has set explicit first_name/last_name in their profile, use those instead.
                if selector == "first_name" or (label.lower().strip().rstrip("*").strip() == "first name"):
                    if profile.get("first_name"):
                        value = profile["first_name"]
                elif selector == "last_name" or (label.lower().strip().rstrip("*").strip() == "last name"):
                    if profile.get("last_name"):
                        value = profile["last_name"]

                # ── Native language name — use legal name for Latin-script users ──
                # xAI and some others ask for name in native script (Chinese, Cyrillic, etc).
                # If the user's name is already Latin script, just repeat the full legal name.
                _label_lower_native = label.lower()
                if "native language" in _label_lower_native or "native script" in _label_lower_native:
                    _legal = profile.get("name") or (
                        (profile.get("first_name", "") + " " + profile.get("last_name", "")).strip()
                    )
                    if _legal:
                        value = _legal

                # ── Override ethnicity / hispanic-latino fields ────────────────
                # Skip if the post-detect resolve loop already picked the exact
                # option (matched against live options) — don't clobber it with a
                # generic value. This only pre-sets an intent for fields that never
                # went through the resolve loop; _fill_react_combobox re-resolves
                # EEO fields against the real options anyway (Step 3-EEO).
                if not field.get("_eeo_resolved"):
                    _label_lower_eth = label.lower()
                    if any(k in _label_lower_eth for k in ("hispanic", "latino")):
                        # Yes/No question about Hispanic/Latino identity, NOT a race picker.
                        _eth_raw = profile.get("ethnicity_eeo") or "decline"
                        value = "Yes" if _eth_raw == "hispanic" else "No"
                    elif any(k in _label_lower_eth for k in ("ethnicit", "race", "racial")):
                        # Race/ethnicity picker — map to display string; combobox maps to option.
                        _eth_raw = profile.get("ethnicity_eeo") or "decline"
                        value = _GH_ETHNICITY_MAP.get(_eth_raw, "I don't wish to answer")

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
                    # Last-chance: if this is a React combobox, scrape options and resolve
                    if selector in _react_combobox_ids:
                        try:
                            _lc_opts = await _scrape_combobox_options(page, selector)
                            if _lc_opts:
                                _lc_val = await _pick_safe_combobox_answer(label, _lc_opts, profile)
                                if _lc_val:
                                    value = _lc_val
                                    logger.info(f"[browser_agent] Last-chance resolved {label!r} → {_lc_val!r}")
                        except Exception as _lce:
                            logger.warning(f"[browser_agent] Last-chance resolve failed for {label!r}: {_lce}")
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

                # ── Standard checkboxes — direct .check(), no select2/combobox ──
                # DOM snapshot confirmed type=checkbox — always use _fill_by_css
                # with checkbox semantics. This must come FIRST so GH select2
                # routing never intercepts checkboxes on non-Greenhouse forms.
                is_real_checkbox = (
                    field_type == "checkbox"
                    and (selector in _checkbox_ids or "checkbox" in field_type)
                    and value == "check"
                )
                if is_real_checkbox or (field_type == "checkbox" and value == "check"):
                    _cb_ok = await _fill_by_css(page, selector, value, "checkbox")
                    if not _cb_ok:
                        # Fallback: try by name attribute and by label-adjacent selector
                        for _cb_sel in [
                            f'input[type="checkbox"][id="{selector}"]',
                            f'input[type="checkbox"][name="{selector}"]',
                            f'input[type="checkbox"]',   # last resort: first checkbox on page
                        ]:
                            _loc = page.locator(_cb_sel).first
                            if await _loc.count() > 0:
                                if not await _loc.is_checked():
                                    await _loc.check(timeout=3000)
                                _cb_ok = True
                                break
                    if _cb_ok:
                        filled_count += 1
                        yield _step("ok", 'Checked: "' + label[:60] + '"')
                    else:
                        yield _step("error", 'Could not check: "' + label[:60] + '"')
                    await asyncio.sleep(0.3)
                    continue

                # ── Privacy/consent dropdowns — always select "I agree" ──────
                # These comboboxes (e.g. Reddit's candidate privacy policy dropdown)
                # have only one valid option. We detect by label phrase and force
                # the affirmative option, bypassing the LLM value entirely.
                label_lower_consent = label.lower()
                is_consent_dropdown = (
                    selector in _react_combobox_ids
                    and any(p in label_lower_consent for p in _CONSENT_DROPDOWN_PHRASES)
                )
                if is_consent_dropdown:
                    _consent_ok = False
                    for _copt in _CONSENT_OPTION_CANDIDATES:
                        _consent_ok = await _fill_react_combobox(page, selector, label, _copt)
                        if _consent_ok:
                            break
                    if _consent_ok:
                        filled_count += 1
                        yield _step("ok", 'Agreed: "' + label[:60] + '"')
                    else:
                        yield _step("error", 'Could not agree to: "' + label[:60] + '"')
                    await asyncio.sleep(0.4)
                    continue

                # ── React combobox (select__input class) — ATS-agnostic ──────
                # Detected from DOM snapshot: any input.select__input by ID.
                # Covers Reddit, newer Greenhouse forms, and any other ATS using
                # React-Select or similar. Must come BEFORE GH select2 routing
                # so these don't get misrouted to _fill_gh_select2.
                if selector in _react_combobox_ids:
                    ok = await _fill_react_combobox(page, selector, label, value, profile=profile)
                    if ok:
                        filled_count += 1
                        yield _step("ok", 'Filled "' + label + '" -> ' + str(value)[:50])
                    else:
                        yield _step("error", 'Could not fill dropdown "' + label + '"')
                    await asyncio.sleep(0.4)
                    continue

                # ── Greenhouse select2 dropdowns ──────────────────────────────
                # Route: known select2 labels, OR type='checkbox'/'select' on GH.
                # Only fires on greenhouse.io URLs — not Reddit or other ATS.
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
            # The LLM marks file fields as skip=True. We resolve the resume_id
            # (from the request, or the best-match resume picked by apply.py),
            # download the bytes from Supabase Storage, then attach the file
            # using the Steel-native CDP pattern.
            #
            # Two-tier attachment strategy:
            #
            #   PRIMARY  — Steel session file upload + CDP DOM.setFileInputFiles
            #              Upload bytes into the Steel VM filesystem first, then
            #              bind the VM-side path to the <input type="file"> node
            #              via CDP. This is what Steel's docs recommend because
            #              Playwright's buffer-based set_input_files() over a
            #              remote CDP connection can silently desync — the
            #              change event fires but no real file exists on the VM
            #              filesystem at submit time.
            #
            #   FALLBACK — JS unhide → Playwright set_input_files(buffer=...)
            #              → dispatch change/input → re-hide. The legacy path,
            #              kept as safety net because the CDP path is new and
            #              auto-apply is unattended. If primary fails, we still
            #              try the legacy path before giving up.
            #
            # We specifically target input[type="file"][id="resume"] so we
            # never accidentally hit the cover_letter input.
            #
            # DOM probe, NOT LLM-derived: the LLM that builds `fields` is
            # non-deterministic and has been observed silently dropping the
            # skip=True file entries (form_filler returned 19 fields instead
            # of 21, omitting both Attach inputs). The DOM is ground truth.
            # If a resume file input exists on the page, attach. End of story.
            try:
                _has_file_input = await page.evaluate("""() => {
                    const el = document.querySelector('input[type="file"]#resume')
                            || document.querySelector('input[type="file"]');
                    return !!el;
                }""")
            except Exception:
                _has_file_input = False

            # Keep `resume_file_field` for compatibility with later log lines,
            # but it's now a boolean sourced from the DOM rather than from the
            # LLM's field inventory.
            resume_file_field = _has_file_input

            # resolve resume_id: prefer explicit param, fall back to profile dict
            _effective_resume_id = resume_id or profile.get("_resume_id") or ""

            logger.info(
                f"[browser_agent] resume upload preflight: "
                f"has_file_input={_has_file_input} "
                f"effective_resume_id={_effective_resume_id!r} "
                f"user_id={user_id!r}"
            )

            if resume_file_field and _effective_resume_id and user_id:
                import os as _os, httpx as _httpx
                try:
                    from db.database import AsyncSessionLocal as _ASL
                    from models.orm import Resume as _ResumeORM
                    from sqlalchemy import select as _select
                    import uuid as _uuid2
                    async with _ASL() as _rdb:
                        _res = await _rdb.execute(
                            _select(_ResumeORM).where(
                                _ResumeORM.id == _uuid2.UUID(_effective_resume_id),
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
                        _signed_resp = _sb.storage.from_("resumes").create_signed_url(
                            _resume_row.storage_path, 120
                        )
                        # supabase-py v2 returns a Pydantic model with .signed_url,
                        # NOT a plain dict — probe both forms for compatibility.
                        _signed_url = (
                            getattr(_signed_resp, "signed_url", None)
                            or getattr(_signed_resp, "signedURL", None)
                            or (isinstance(_signed_resp, dict) and (
                                _signed_resp.get("signedURL")
                                or _signed_resp.get("signedUrl")
                                or _signed_resp.get("signed_url")
                            ))
                            or ""
                        )
                        if _signed_url:
                            yield _step("ok", "Downloading resume for upload...")
                            async with _httpx.AsyncClient() as _hx:
                                _r = await _hx.get(_signed_url, timeout=20)
                            _ext  = (_resume_row.file_ext or "pdf").lstrip(".")
                            _fname = (_resume_row.filename or f"resume.{_ext}")
                            _mime  = "application/pdf" if _ext == "pdf" else "application/octet-stream"
                            _resume_bytes = _r.content

                            # Confirm a file input exists on the page (used by
                            # both primary and fallback paths).
                            _resume_inp = page.locator('input[type="file"]#resume')
                            if await _resume_inp.count() == 0:
                                _resume_inp = page.locator('input[type="file"]').first

                            if await _resume_inp.count() == 0:
                                yield _step("skip", "No file input found on page")
                            else:
                                _attached = False
                                _attach_method = None

                                # ── PRIMARY: Steel VM upload + CDP setFileInputFiles ──
                                # Per Steel docs (https://docs.steel.dev/overview/files-api/overview):
                                # upload bytes into the Steel VM, then point
                                # the input at the VM-side path via CDP.
                                try:
                                    from services.steel_client import upload_session_file
                                    _vm_path = await upload_session_file(
                                        session_id=steel_session_id,
                                        file_bytes=_resume_bytes,
                                        filename=_fname,
                                        mime_type=_mime,
                                    )
                                    if _vm_path:
                                        # Open a CDP session on the page and bind the
                                        # uploaded VM-side file path to the input node.
                                        _cdp = await context.new_cdp_session(page)
                                        try:
                                            _doc = await _cdp.send("DOM.getDocument")
                                            _root_id = _doc["root"]["nodeId"]

                                            # Try #resume first, then any file input.
                                            _node = await _cdp.send("DOM.querySelector", {
                                                "nodeId":   _root_id,
                                                "selector": 'input[type="file"]#resume',
                                            })
                                            _node_id = _node.get("nodeId", 0)
                                            if not _node_id:
                                                _node = await _cdp.send("DOM.querySelector", {
                                                    "nodeId":   _root_id,
                                                    "selector": 'input[type="file"]',
                                                })
                                                _node_id = _node.get("nodeId", 0)

                                            if _node_id:
                                                await _cdp.send("DOM.setFileInputFiles", {
                                                    "files":  [_vm_path],
                                                    "nodeId": _node_id,
                                                })
                                                # Greenhouse/React listens on the
                                                # synthetic change event — CDP sets
                                                # the file property but doesn't
                                                # always fire the listener chain.
                                                await page.evaluate("""
                                                    const inp = document.querySelector('input[type="file"]#resume')
                                                              || document.querySelector('input[type="file"]');
                                                    if (inp) {
                                                        inp.dispatchEvent(new Event('change', { bubbles: true }));
                                                        inp.dispatchEvent(new Event('input',  { bubbles: true }));
                                                    }
                                                """)
                                                await asyncio.sleep(0.3)
                                                _attached = True
                                                _attach_method = "steel_cdp"
                                                logger.info(
                                                    f"[browser_agent] resume attached via Steel CDP "
                                                    f"vm_path={_vm_path!r} node_id={_node_id}"
                                                )
                                            else:
                                                logger.warning(
                                                    "[browser_agent] CDP DOM.querySelector returned no nodeId for file input"
                                                )
                                        finally:
                                            try:
                                                await _cdp.detach()
                                            except Exception:
                                                pass
                                    else:
                                        logger.warning(
                                            "[browser_agent] Steel session file upload returned no path"
                                        )
                                except Exception as _pe:
                                    logger.warning(
                                        f"[browser_agent] Steel CDP attach failed: {_pe}",
                                        exc_info=True,
                                    )

                                # ── FALLBACK: legacy unhide + buffer-based set_input_files ──
                                # Only runs if the CDP path didn't succeed. This is
                                # the pre-Session-79 behaviour, kept as safety net.
                                if not _attached:
                                    try:
                                        yield _step("ok", "Retrying resume attach via fallback...")
                                        await page.evaluate("""
                                            const inp = document.querySelector('input[type="file"]#resume')
                                                      || document.querySelector('input[type="file"]');
                                            if (inp) {
                                                inp._rack_prev_style = inp.getAttribute('style') || '';
                                                inp.style.cssText = 'position:fixed;top:0;left:0;width:100px;height:40px;opacity:1;z-index:99999;pointer-events:all;';
                                                inp.classList.remove('visually-hidden','sr-only','hidden');
                                            }
                                        """)
                                        await asyncio.sleep(0.15)

                                        await _resume_inp.set_input_files(files=[{
                                            "name":     _fname,
                                            "mimeType": _mime,
                                            "buffer":   _resume_bytes,
                                        }])

                                        await page.evaluate("""
                                            const inp = document.querySelector('input[type="file"]#resume')
                                                      || document.querySelector('input[type="file"]');
                                            if (inp) {
                                                inp.dispatchEvent(new Event('change', { bubbles: true }));
                                                inp.dispatchEvent(new Event('input',  { bubbles: true }));
                                                inp.setAttribute('style', inp._rack_prev_style || '');
                                            }
                                        """)
                                        await asyncio.sleep(0.3)
                                        _attached = True
                                        _attach_method = "playwright_buffer"
                                        logger.info(
                                            "[browser_agent] resume attached via Playwright buffer fallback"
                                        )
                                    except Exception as _fbe:
                                        logger.warning(
                                            f"[browser_agent] Playwright fallback also failed: {_fbe}",
                                            exc_info=True,
                                        )

                                if _attached:
                                    filled_count += 1
                                    yield _step(
                                        "ok",
                                        f'Attached resume: {_fname} (via {_attach_method})',
                                    )
                                else:
                                    yield _step("error", "Could not attach resume — both Steel CDP and fallback failed")
                        else:
                            yield _step("skip", f"Could not get resume download URL (resp type={type(_signed_resp).__name__})")
                    else:
                        yield _step("skip", "Resume storage path not found in DB")
                except Exception as _fe:
                    logger.warning(f"[browser_agent] Resume upload failed: {_fe}", exc_info=True)
                    yield _step("skip", f"Resume attach failed: {str(_fe)[:120]}")
            elif resume_file_field:
                yield _step("skip", "Skipping resume upload: no resume_id resolved")

            # -- Dynamic field scan (post-fill) ----------------------------------
            # Some forms reveal new fields after earlier answers are selected.
            # Example: Anduril shows "Please identify your race" only AFTER
            # "Are you Hispanic/Latino?" is answered.
            # Re-snapshot the DOM, find any select__input comboboxes that are
            # now visible but were NOT in the original snapshot, and fill them.
            try:
                _post_snapshot = await page.evaluate(
                    """() => {
                        const results = [];
                        document.querySelectorAll('input.select__input').forEach((el) => {
                            if (!el.id) return;
                            const lbl = document.querySelector('label[for="' + el.id + '"]');
                            const parent = el.closest('.field, .form-field, .application-field, .field-row');
                            const parentText = parent ? parent.textContent.trim().slice(0, 120) : '';
                            results.push({
                                id: el.id,
                                labelText: lbl ? lbl.textContent.trim() : '',
                                parentText: parentText
                            });
                        });
                        return results;
                    }"""
                )
                _known_ids = {str(_el.get('id','')) for _el in dom_snapshot if _el.get('id')}
                _new_fields = [f for f in _post_snapshot if f.get('id') and f['id'] not in _known_ids]
                if _new_fields:
                    logger.info(f"[browser_agent] Dynamic scan found {len(_new_fields)} new field(s): {[f['id'] for f in _new_fields]}")
                    for _nf in _new_fields:
                        _nf_id    = _nf['id']
                        _nf_label = _nf.get('labelText') or _nf.get('parentText', '')[:80]
                        try:
                            _nf_opts = await _scrape_combobox_options(page, _nf_id)
                            if not _nf_opts:
                                logger.warning(f"[browser_agent] Dynamic field {_nf_label!r}: no options scraped")
                                continue
                            logger.info(f"[browser_agent] Dynamic field {_nf_label!r} options: {_nf_opts}")
                            # EEO fields (e.g. the race picker that appears after the
                            # Hispanic answer) must be resolved from the profile, not
                            # the generic safe-picker which would choose "Decline".
                            _nf_val = _resolve_eeo_combobox(_nf_label, _nf_opts, profile)
                            if not _nf_val:
                                _nf_val = await _pick_safe_combobox_answer(_nf_label, _nf_opts, profile)
                            if _nf_val:
                                ok = await _fill_react_combobox(page, _nf_id, _nf_label, _nf_val, profile=profile)
                                if ok:
                                    filled_count += 1
                                    yield _step("ok", f'Filled "{_nf_label}" -> {_nf_val}')
                                    logger.info(f"[browser_agent] Dynamic field {_nf_label!r} filled → {_nf_val!r}")
                                else:
                                    yield _step("error", f'Could not fill dynamic field "{_nf_label}"')
                            else:
                                logger.warning(f"[browser_agent] No answer for dynamic field {_nf_label!r}")
                        except Exception as _nfe:
                            logger.warning(f"[browser_agent] Dynamic field fill failed for {_nf_label!r}: {_nfe}")
            except Exception as _dse:
                logger.warning(f"[browser_agent] Dynamic field scan failed: {_dse}")

            # -- Pre-submit scroll & validation ----------------------------------
            await asyncio.sleep(0.4)

            # Scroll to bottom so all fields are visible and validation triggers
            try:
                await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
                await asyncio.sleep(0.6)
            except Exception:
                pass

            # Check for visible validation errors
            validation_errors = 0
            try:
                error_locs = page.locator(
                    '.error-message:visible, .field-error:visible, '
                    '[aria-invalid="true"]:visible, .invalid-feedback:visible'
                )
                validation_errors = await error_locs.count()
            except Exception:
                pass

            # -- Human review gate -------------------------------------------
            # Always pause here and wait for explicit user confirmation before
            # clicking Submit. The frontend renders a "Review & Submit" button.
            # If review_event is not provided (e.g. tests), proceed automatically.
            _REVIEW_TIMEOUT = 120  # seconds — user has 2 minutes to confirm

            yield {
                "type":              "review_required",
                "filled_count":      filled_count,
                "validation_errors": validation_errors,
                "timeout_seconds":   _REVIEW_TIMEOUT,
                "text":              (
                    f"{filled_count} field(s) filled"
                    + (f" — {validation_errors} validation warning(s) detected" if validation_errors else "")
                    + " — review and confirm to submit"
                ),
            }
            logger.info(f"[browser_agent] Review gate reached — waiting for user confirmation (timeout={_REVIEW_TIMEOUT}s)")

            if review_event is not None:
                try:
                    confirmed = await asyncio.wait_for(review_event.wait(), timeout=_REVIEW_TIMEOUT)
                except asyncio.TimeoutError:
                    yield _step("error", "Review timed out — application was not submitted")
                    yield {
                        "type":    "review_timeout",
                        "text":    "No confirmation received within 2 minutes. The form was filled but not submitted.",
                        "job_url": job_url,
                    }
                    return
            # else: no event provided — fall through immediately (test/debug mode)

            yield _step("ok", "Confirmed — submitting application...")
            await asyncio.sleep(0.3)

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