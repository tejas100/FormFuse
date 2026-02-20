# FormFuse — Source of Truth (Persistent Project Context)

> This document is the authoritative source of truth for FormFuse.
> If there is a conflict with prior conversation or Codex assumptions,
> this document takes precedence.

## Purpose
FormFuse is a lightweight Chrome extension that helps users autofill job application forms by storing stable personal information once and filling it on demand.

Users click a Fill action from the extension UI; FormFuse scans the current page and fills matching fields.

## Core Principles
- Store once -> fill on demand.
- Privacy-first: local-only storage, no backend, no external API calls.
- User-in-control: never auto-submit; do not override user-entered values.
- Simple, readable, effective: no over-engineering, no AI in v1.
- Skip if uncertain: if no confident match, do nothing.

## Scope
### FormFuse DOES
- Provide a clean popup UI to collect stable data once.
- Save data in `chrome.storage.sync`.
- Provide a `Fill Application` action that:
  - Scans DOM inputs.
  - Matches fields using rule-based heuristics.
  - Autofills only stable fields.

### FormFuse MUST NEVER
- Auto-submit forms.
- Store or infer work experience, skills, tech stack, salary, cover letters, or other job-specific data.
- Guess answers when not confident.
- Modify behavior of first name and last name mapping when adding full-name logic.

## Data Model — Stored Fields (Source of Truth)
### Identity
- First name
- Last name
- Full name (added later; used for `Full Name` or `Name` fields)
- Email
- Phone number

### Address
- Street
- City
- State
- ZIP code
- Country (default: United States)

### Work Authorization / Eligibility
- Eligible to work in the US? (Yes/No)
- Requires sponsorship? (Yes/No)

### Demographics / EEO (user-controlled; optional)
- Gender (e.g., Man/Male + allow `Prefer not to say`)
- Ethnicity / Race
- Disability status
- Veteran status
- Are you Hispanic or Latinx? (added later)
- Do you identify as transgender? (added later; Yes/No/I do not wish to answer)

### Professional Links
- LinkedIn
- GitHub
- Portfolio
- Personal website

### Additional Fields Added
- Pronouns:
  - She/Her/Hers
  - He/Him/His
  - They/Them/Theirs
  - Prefer not to answer
- Have you worked here before?
  - Intended default is `No`, but kept empty so user can choose.
- Education:
  - School name (for searchable dropdowns)
  - Degree (dropdown; include Bachelor's, Master's, etc.)
- In-person preference (added later):
  - A user option for whether they want to work in-person (used to answer `in-person NYC 5 days a week` style questions with Yes/No)

## Data Explicitly NOT Stored
- Work experience
- Skills / tech stack
- Years of experience
- Salary expectations
- Cover letters
- Role-specific answers
- Custom job questions (unless explicitly added as stable fields above)

## Autofill Behavior — Required Capabilities
### Field Matching Strategy (v1)
Rule-based only. Use:
- `<label>` text
- `aria-label`
- `placeholder`
- `name` attribute

If no confident match -> skip.

### Filling Rules
- Do not override user-entered values.
- Support filling:
  - Text inputs
  - Textareas
  - Radio buttons
  - Select dropdowns (required for EEO fields)
  - Searchable dropdowns (Education School)

## Fixes & Enhancements That Must Be True
### Fix Set A (after initial MVP)
- Add Full Name field and fill it on forms that ask for full name.
- Ensure sponsorship question (Yes/No) is selectable (radio/select).
- Ensure `Authorized to work in the US` is selectable (dropdown/select).
- Fix demographic selection behavior:
  - Gender should select user's choice (not `Decline to self-identify`)
  - Veteran status should select `Not a veteran`
  - Disability status should select `No`
- Relocation dropdown:
  - If question exists (`open to relocate`), select user's intended answer (Yes).

### Fix #1 (Name vs Full Name)
- If the application field is labeled `Name` (not `Full Name`), FormFuse should still fill Full Name.
- Do not modify first name / last name behavior.

### Fix #2 (EEO wrong defaults)
Prevent selecting wrong defaults like:
- Gender: `Decline to self-identify` when user selected `Man/Male`
- Race: selecting `White` when user selected `Asian`

Must correctly select based on stored values.

### Fix #3 (Phone country code dropdown)
If phone inputs include a dropdown for country/country code:
- Automatically select `United States (+1)`.

### Education Fixes
- Degree selection works based on user input.
- School selection must work for searchable dropdowns:
  - Type the saved school name
  - Select the matched school option
- `No bugs` expectation: education school selection should be reliable.

### Dropdown Support Fix (Big)
If gender/race/veteran/disability are presented as dropdowns, FormFuse must select the correct option based on stored data (not only radio buttons).

This is a required capability, not optional.

## UI / UX Requirements
- Popup UI should be beautiful and easy to use.
- `Fill Application` must be accessible at the top of the extension UI (so user doesn't have to scroll).
- Remove/avoid the global floating `Fill with FormFuse` button that appears on all pages/tabs.
- Filling should be initiated from extension popup (button visible immediately).

## Architecture Constraints
- Chrome Extension Manifest V3.
- Expected files:
  - `manifest.json`
  - `popup.html`, `popup.js`
  - `content.js`
  - `core/fieldMatcher.js`
  - `core/schema.js`
  - `styles.css`
  - `README.md`
- Storage:
  - `chrome.storage.sync`
  - No remote storage
  - No backend
  - No external API calls

## Future (Not Implement Now)
Optional LLM-assisted label classification:
- Only send field label text (never personal data)
- LLM used only to classify, not answer
- Feature-flagged and off by default

## Contributor Rules
- If a change conflicts with this document, this document wins.
- Do not expand scope (experience/skills/salary/etc.) unless explicitly requested.
