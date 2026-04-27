"""
routers/voice.py — RACK voice onboarding endpoints

Endpoints:
  POST /api/voice/chat  — First-turn greeting. No audio in. Returns opening line + base64 MP3.
  POST /api/voice/turn  — Every subsequent turn. Audio → single round trip →
                          reply text + base64 MP3 + extracted fields + done flag.
  POST /api/voice/speak — Direct TTS. Kept for standalone needs.

Architecture — mode-based prompt system:
  Each turn the backend determines a conversation MODE based on turn number and
  which fields are still missing. GPT receives a purpose-built prompt for that
  exact mode — not a single general prompt with appended steering notes.
  GPT always follows its PRIMARY instruction, so the primary instruction must be
  the right thing for this exact moment.

  Modes:
    FREE     turns 1-2  — Build rapport. No collection pressure.
    COLLECT  turns 3-6  — One reaction sentence + one mandatory question toward
                          the highest-priority missing field. Not optional.
    CLOSE    turn 7+    — Wrap up. Ask anything still missing directly, then end.

  Field detection uses TWO layers:
    Layer 1 — fast regex scan on raw history. Runs synchronously before the
              prompt is built. Zero latency, zero cost. Catches whether the user
              has clearly mentioned roles / location / YOE in their own words.
              Used for mode decisions — always reflects current state.
    Layer 2 — GPT extraction. Runs in parallel with TTS via asyncio.gather.
              Accurate, handles natural language. Used for the final structured
              output saved to preferences. Has a one-turn lag (result comes back
              in the response for turn N, frontend sends it on turn N+1) — which
              is fine for preferences saving but NOT reliable for mode decisions.

All OpenAI calls use raw httpx — no openai SDK.
"""

import asyncio
import base64
import json
import logging
import os
import re
from datetime import datetime, timezone
from enum import Enum
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import httpx
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel

from routers.auth import get_current_user

logger = logging.getLogger(__name__)
router = APIRouter()

OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")


# ─────────────────────────────────────────────────────────────────────────────
# Conversation mode
# ─────────────────────────────────────────────────────────────────────────────

class ConvMode(str, Enum):
    FREE    = "free"
    COLLECT = "collect"
    CLOSE   = "close"


def _get_mode(turn_number: int, missing: list[str]) -> ConvMode:
    """
    Pure state machine — no heuristics.
    turn 1-2 → FREE   always (let the conversation open)
    turn 3-6 → COLLECT if fields missing, else CLOSE early
    turn 7+  → CLOSE  always (hard deadline)
    """
    if turn_number <= 2:
        return ConvMode.FREE
    if turn_number >= 7:
        return ConvMode.CLOSE
    if not missing:
        return ConvMode.CLOSE
    return ConvMode.COLLECT


# ─────────────────────────────────────────────────────────────────────────────
# Fast in-process field detection (Layer 1)
#
# Scans only USER turns in raw history text using regex.
# Runs synchronously before the prompt is built — always reflects current turn.
# RACK asking about a field does NOT count as the field being collected.
# ─────────────────────────────────────────────────────────────────────────────

_RE_ROLES = re.compile(
    r'\b(engineer|developer|scientist|researcher|manager|designer|analyst|'
    r'architect|lead|director|vp|product|data\s+scientist|ml|ai\s+engineer|'
    r'llm|software|backend|frontend|fullstack|full.stack|devops|platform|'
    r'applied scientist|research engineer|founding engineer|'
    r'machine learning|artificial intelligence)\b',
    re.IGNORECASE,
)

_RE_LOCATION = re.compile(
    r'\b(remote|hybrid|san francisco|new york|seattle|austin|boston|chicago|'
    r'los angeles|london|toronto|bangalore|nyc|sf|bay area|relocat|'
    r'anywhere|fully remote|on.?site|in.?office|open to)\b',
    re.IGNORECASE,
)

_RE_YOE = re.compile(
    r'\b\d+\s*(?:to\s*\d+\s*)?years?\b|'
    r'\b(?:one|two|three|four|five|six|seven|eight|nine|ten)\s+years?\b|'
    r'\bsince\s+20\d{2}\b|'
    r'\bjust\s+(?:under|over)\s+\d+\s*years?\b',
    re.IGNORECASE,
)


def _scan_history(history: list[dict]) -> dict[str, bool]:
    """
    Regex scan of user turns only.
    Returns {has_roles, has_location, has_yoe} — used for mode decisions.
    """
    user_text = " ".join(
        m["content"] for m in history if m.get("role") == "user"
    )
    return {
        "has_roles":    bool(_RE_ROLES.search(user_text)),
        "has_location": bool(_RE_LOCATION.search(user_text)),
        "has_yoe":      bool(_RE_YOE.search(user_text)),
    }


def _get_missing(scan: dict[str, bool]) -> list[str]:
    """
    Return missing field names in priority order based on regex scan.
    These names map to _FIELD_INSTRUCTIONS below.
    """
    missing = []
    if not scan["has_roles"]:
        missing.append("target_roles")
    if not scan["has_location"]:
        missing.append("preferred_locations")
    if not scan["has_yoe"]:
        missing.append("years_experience")
    return missing


# ─────────────────────────────────────────────────────────────────────────────
# Prompts — one per mode, each is the complete primary instruction
# ─────────────────────────────────────────────────────────────────────────────

# Tone rules only — no behavioral instructions.
# Behavioral instructions live exclusively in each mode prompt.
# This prevents _IDENTITY from conflicting with mode-specific behavior.
_TONE = """You are RACK — a job-matching assistant that talks with candidates before finding them work.

Spoken audio rules — follow these exactly:
- 2 sentences per turn maximum. Never 3.
- Contractions always. Short sentences.
- Never open with "Great!", "Absolutely!", "Of course!", "Sure!", "Perfect!", "Totally!"
- No markdown, asterisks, bullet points, or lists of any kind.
- Do not formally summarise what they said back to them.
"""

# FREE — turns 1-2. Build rapport. No collection pressure.
_FREE_PROMPT = _TONE + """
YOUR ONLY JOB THIS TURN: React to what they said, then ask ONE open question that keeps them talking.

How to react:
- Company or role mentioned → ask about it specifically. "What happened there?"
- Frustration described → name it back precisely. E.g. "Seven rounds and then silence — that's broken process, not a reflection on you."
- Vague answer → push gently. "You said open to anything — is there something you'd actually get excited about?"
- Defeated tone → sit with it a moment before moving on.

The question at the end must be open — keep them talking about their search.
Do NOT yet ask about specific job titles, locations, or years of experience.
"""

# COLLECT — turns 3-6. Structured: one reaction, one mandatory question. No deviation.
_COLLECT_PROMPT = _TONE + """
YOUR ONLY JOB THIS TURN: Say exactly two things, in this order:

SENTENCE 1 — React to what they just said. One sentence. Be specific — reference something they actually mentioned. No question in this sentence.

SENTENCE 2 — Ask the PRIORITY QUESTION listed below. This is mandatory. Word it naturally for this conversation. Do not replace it with a different question. Do not skip it. This sentence ends your reply.

Nothing else. No third sentence. No new topics. No follow-up on what they said beyond sentence 1.
If they already answered the priority question, move to the next missing field listed under PRIORITY QUESTION.
"""

# CLOSE — turn 7+, or when all fields are collected. End it now.
_CLOSE_PROMPT = _TONE + """
YOUR ONLY JOB THIS TURN: Close this conversation.

Do not open new topics. Do not continue the conversation.
If fields are still missing (listed below as STILL MISSING), ask for them in one direct sentence. Then close immediately.
If nothing is missing, close immediately.

Your reply MUST end with one of these exact phrases:
  "drop your resume below and I'll start matching you"
  OR
  "drop your resume below and we'll get started"

Closing examples:
  All collected: "I've got a clear picture — drop your resume below and I'll start matching you, even one version is enough."
  One missing: "One quick thing — are you set on a city or open to remote? Then drop your resume below and I'll start matching you."
"""

# ─────────────────────────────────────────────────────────────────────────────
# Priority field instructions — appended to COLLECT_PROMPT
# ─────────────────────────────────────────────────────────────────────────────

_FIELD_PRIORITY = ["target_roles", "preferred_locations", "years_experience"]

_FIELD_INSTRUCTIONS = {
    "target_roles": (
        "PRIORITY QUESTION: Ask what roles they're targeting.\n"
        "You need specific job titles. Word it naturally for this conversation.\n"
        "Example phrasings:\n"
        "  'What kind of roles are you actually going after?'\n"
        "  'What does the right role look like for you, title-wise?'"
    ),
    "preferred_locations": (
        "PRIORITY QUESTION: Ask where they want to work.\n"
        "You need city / region / remote / hybrid / open to relocation.\n"
        "Example phrasings:\n"
        "  'Are you set on a particular city, or is remote on the table?'\n"
        "  'Where are you looking — tied to a location or flexible?'"
    ),
    "years_experience": (
        "PRIORITY QUESTION: Ask how much experience they have.\n"
        "You need years in the field, or enough context to infer a number.\n"
        "Example phrasings:\n"
        "  'How long have you been working in this space?'\n"
        "  'How many years are you bringing into these roles?'"
    ),
}


def _get_priority_field(missing: list[str]) -> str | None:
    for field in _FIELD_PRIORITY:
        if field in missing:
            return field
    return None


# ─────────────────────────────────────────────────────────────────────────────
# Prompt builder — single function owns all prompt construction
# ─────────────────────────────────────────────────────────────────────────────

def _build_prompt(
    mode: ConvMode,
    history: list[dict],
    user_text: str,
    missing: list[str],
    greeting_ctx: str | None = None,
) -> list[dict]:
    if mode == ConvMode.FREE:
        system = _FREE_PROMPT

    elif mode == ConvMode.COLLECT:
        priority_field = _get_priority_field(missing)
        field_instr    = _FIELD_INSTRUCTIONS.get(priority_field, "")
        system = _COLLECT_PROMPT + "\n\n" + field_instr

    else:  # CLOSE
        _labels = {
            "target_roles":        "what roles they're targeting",
            "preferred_locations": "where they want to work",
            "years_experience":    "how much experience they have",
        }
        if missing:
            missing_str = ", ".join(_labels[f] for f in missing if f in _labels)
            system = _CLOSE_PROMPT + f"\n\nSTILL MISSING: {missing_str}. Ask directly, then close."
        else:
            system = _CLOSE_PROMPT + "\n\nAll fields collected. Close directly — no questions needed."

    messages = [{"role": "system", "content": system}]
    if greeting_ctx:
        messages.append({"role": "system", "content": greeting_ctx})
    for msg in history:
        messages.append({"role": msg["role"], "content": msg["content"]})
    messages.append({"role": "user", "content": user_text})
    return messages


def _get_conv_temperature(mode):
    return {ConvMode.FREE: 0.85, ConvMode.COLLECT: 0.4, ConvMode.CLOSE: 0.3}[mode]


# ─────────────────────────────────────────────────────────────────────────────
# GPT extraction (Layer 2) — runs in parallel with TTS, never affects conversation
# ─────────────────────────────────────────────────────────────────────────────

_EXTRACT_SYSTEM = """You are a data extraction assistant. Given a job search conversation, extract preferences.

Return ONLY valid JSON — no prose, no markdown:
{
  "target_roles": ["role1", "role2"] or null,
  "preferred_locations": ["city or remote"] or null,
  "years_experience": 4 or null
}

Rules:
- target_roles: specific job titles mentioned. Include anything, even vague. List all.
- preferred_locations: cities, regions, "remote", "hybrid", "open to relocation". null if not mentioned.
- years_experience: integer. Infer from context ("since 2019" ≈ 6, "just under 5" = 4). null if unknown.
- Do not guess. null means genuinely not mentioned.
"""

# ─────────────────────────────────────────────────────────────────────────────
# Done detection
# ─────────────────────────────────────────────────────────────────────────────

_DONE_PHRASES = [
    "drop your resume below and i'll start matching you",
    "drop your resume below and we'll get started",
    "drop your resume",
    "start matching you",
    "i'll start matching",
    "upload your resume",
]

def _is_done(reply: str) -> bool:
    lower = reply.lower()
    return any(p in lower for p in _DONE_PHRASES)


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def _strip_markdown(text: str) -> str:
    text = re.sub(r'\*\*?(.+?)\*\*?', r'\1', text)
    text = re.sub(r'`(.+?)`', r'\1', text)
    text = re.sub(r'#+\s', '', text)
    return text.strip()


def _get_greeting_context(display_name: str | None, email: str | None) -> str:
    first_name = None
    if display_name:
        first_name = display_name.strip().split()[0]
    elif email:
        first_name = email.split("@")[0].split(".")[0].capitalize()

    try:
        now = datetime.now(ZoneInfo("America/New_York"))
    except (ZoneInfoNotFoundError, Exception):
        now = datetime.now(timezone.utc)

    hour = now.hour
    time_of_day = (
        "morning"   if hour < 12 else
        "afternoon" if hour < 17 else
        "evening"   if hour < 21 else
        "night"
    )
    name_part = (
        f"The user's first name is {first_name}."
        if first_name else
        "The user's name is unknown — don't use a name."
    )
    return (
        f"It is {time_of_day} for the user. {name_part} "
        f"Open with a warm natural greeting that feels spontaneous, not scripted."
    )


# ─────────────────────────────────────────────────────────────────────────────
# OpenAI call helpers
# ─────────────────────────────────────────────────────────────────────────────

async def _call_conv(messages: list[dict], client: httpx.AsyncClient, temperature: float = 0.85) -> str:
    """Conversation call — plain text, no JSON mode."""
    response = await client.post(
        "https://api.openai.com/v1/chat/completions",
        headers={
            "Authorization": f"Bearer {OPENAI_API_KEY}",
            "Content-Type": "application/json",
        },
        json={
            "model": "gpt-4o-mini",
            "messages": messages,
            "temperature": temperature,
            "max_tokens": 120,
        },
    )
    if response.status_code != 200:
        logger.error(f"[voice] conv GPT error {response.status_code}: {response.text[:200]}")
        raise HTTPException(status_code=502, detail="RACK conversation unavailable")
    return response.json()["choices"][0]["message"]["content"].strip()


async def _call_extract(convo_text: str, client: httpx.AsyncClient) -> dict:
    """Extraction call — runs parallel with TTS, best-effort, returns {} on failure."""
    try:
        response = await client.post(
            "https://api.openai.com/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {OPENAI_API_KEY}",
                "Content-Type": "application/json",
            },
            json={
                "model": "gpt-4o-mini",
                "messages": [
                    {"role": "system", "content": _EXTRACT_SYSTEM},
                    {"role": "user",   "content": convo_text},
                ],
                "temperature": 0.0,
                "max_tokens": 150,
                "response_format": {"type": "json_object"},
            },
        )
        if response.status_code != 200:
            return {}
        return json.loads(response.json()["choices"][0]["message"]["content"].strip())
    except Exception as e:
        logger.warning(f"[voice/extract] failed: {e}")
        return {}


async def _call_tts(text: str, client: httpx.AsyncClient) -> bytes:
    """TTS call — returns raw MP3 bytes."""
    response = await client.post(
        "https://api.openai.com/v1/audio/speech",
        headers={
            "Authorization": f"Bearer {OPENAI_API_KEY}",
            "Content-Type": "application/json",
        },
        json={
            "model": "tts-1",
            "voice": "nova",
            "input": _strip_markdown(text)[:4096],
            "response_format": "mp3",
            "speed": 1.0,
        },
    )
    if response.status_code != 200:
        logger.error(f"[voice/tts] error {response.status_code}: {response.text[:200]}")
        raise HTTPException(status_code=502, detail="TTS failed")
    return response.content


# ─────────────────────────────────────────────────────────────────────────────
# /api/voice/chat — greeting (called once on mount, no audio)
# ─────────────────────────────────────────────────────────────────────────────

class GreetingRequest(BaseModel):
    is_first_turn: bool = True


@router.post("/api/voice/chat")
async def voice_chat_greeting(
    req: GreetingRequest,
    current_user=Depends(get_current_user),
):
    """
    Generates RACK's opening line + MP3. Called once when VoiceOnboarding mounts.
    Uses FREE mode — just get the user talking.
    All subsequent turns go to /api/voice/turn.
    """
    greeting_ctx = _get_greeting_context(current_user.display_name, current_user.email)
    messages = _build_prompt(
        mode=ConvMode.FREE,
        history=[],
        user_text=".",
        missing=list(_FIELD_PRIORITY),
        greeting_ctx=greeting_ctx,
    )

    async with httpx.AsyncClient(timeout=35.0) as client:
        reply     = await _call_conv(messages, client)
        mp3_bytes = await _call_tts(reply, client)

    audio_b64 = base64.b64encode(mp3_bytes).decode("utf-8")
    logger.info(f"[voice/chat] greeting user={current_user.id} reply='{reply[:60]}'")

    return {
        "reply_text": reply,
        "audio_b64":  audio_b64,
        "reply":      reply,   # legacy alias
        "extracted":  {},
        "done":       False,
    }


# ─────────────────────────────────────────────────────────────────────────────
# /api/voice/turn — main conversation endpoint
# ─────────────────────────────────────────────────────────────────────────────

@router.post("/api/voice/turn")
async def voice_turn(
    audio:          UploadFile = File(...),
    history_json:   str        = Form(...),
    extracted_json: str        = Form("{}"),   # accumulated GPT extraction from frontend
    is_first_turn:  str        = Form("false"),
    current_user=Depends(get_current_user),
):
    """
    Single round-trip per voice turn.

    Pipeline:
      1. Whisper     — transcribe audio blob
      2. Regex scan  — detect which fields user has mentioned (fast, current-turn accurate)
      3. Mode        — FREE / COLLECT / CLOSE based on turn number + missing fields
      4. GPT conv    — generate reply using mode-specific prompt
      5. Parallel    — asyncio.gather(TTS, GPT extraction)
      6. Return      — reply_text + audio_b64 + extracted + done

    Field detection for mode uses regex (Step 2), not the GPT extraction result
    from the previous turn. This eliminates the one-turn lag that caused RACK to
    keep asking for fields the user had already answered.
    """
    audio_bytes = await audio.read()
    if len(audio_bytes) < 1000:
        return {"too_short": True, "reply_text": "", "audio_b64": "", "extracted": {}, "done": False}

    try:
        history = json.loads(history_json)
    except json.JSONDecodeError:
        history = []

    try:
        already_extracted = json.loads(extracted_json)
    except json.JSONDecodeError:
        already_extracted = {}

    async with httpx.AsyncClient(timeout=35.0) as client:

        # ── Step 1: Whisper ───────────────────────────────────────────────────
        filename = audio.filename or "audio.webm"
        whisper_res = await client.post(
            "https://api.openai.com/v1/audio/transcriptions",
            headers={"Authorization": f"Bearer {OPENAI_API_KEY}"},
            files={"file": (filename, audio_bytes, audio.content_type or "audio/webm")},
            data={"model": "whisper-1", "language": "en"},
        )
        if whisper_res.status_code != 200:
            logger.error(f"[voice/turn] Whisper error {whisper_res.status_code}")
            raise HTTPException(status_code=502, detail="Transcription failed")

        user_text = whisper_res.json().get("text", "").strip()
        if not user_text:
            return {"too_short": True, "reply_text": "", "audio_b64": "", "extracted": {}, "done": False}

        # ── Step 2: Regex scan — what has the user mentioned so far? ──────────
        # Include the current user_text in the scan so mode reflects THIS turn.
        full_user_history = history + [{"role": "user", "content": user_text}]
        scan    = _scan_history(full_user_history)
        missing = _get_missing(scan)

        # ── Step 3: Determine mode ────────────────────────────────────────────
        turn_number = len(history) // 2 + 1  # 1-indexed completed turns
        mode        = _get_mode(turn_number, missing)

        logger.info(
            f"[voice/turn] user={current_user.id} turn={turn_number} "
            f"mode={mode} missing={missing} scan={scan} "
            f"transcript='{user_text[:70]}'"
        )

        # ── Step 4: GPT conversation reply ────────────────────────────────────
        messages = _build_prompt(
            mode=mode,
            history=history,
            user_text=user_text,
            missing=missing,
        )
        reply = await _call_conv(messages, client, temperature=_get_conv_temperature(mode))
        done  = _is_done(reply)

        # ── Step 5: TTS + Extraction in parallel ──────────────────────────────
        full_history = history + [
            {"role": "user",      "content": user_text},
            {"role": "assistant", "content": reply},
        ]
        convo_text = "\n".join(
            f"{m['role'].upper()}: {m['content']}" for m in full_history
        )

        mp3_bytes, new_extracted = await asyncio.gather(
            _call_tts(reply, client),
            _call_extract(convo_text, client),
        )

        audio_b64 = base64.b64encode(mp3_bytes).decode("utf-8")

        logger.info(
            f"[voice/turn] user={current_user.id} done={done} "
            f"reply='{reply[:70]}'"
        )

        return {
            "too_short":  False,
            "transcript": user_text,
            "reply_text": reply,
            "audio_b64":  audio_b64,
            "extracted":  new_extracted,
            "done":       done,
        }


# ─────────────────────────────────────────────────────────────────────────────
# /api/voice/speak — direct TTS, kept for standalone needs
# ─────────────────────────────────────────────────────────────────────────────

class SpeakRequest(BaseModel):
    text: str


@router.post("/api/voice/speak")
async def speak(
    req: SpeakRequest,
    current_user=Depends(get_current_user),
):
    text = req.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="No text provided")

    async with httpx.AsyncClient(timeout=30.0) as client:
        mp3_bytes = await _call_tts(text, client)

    return Response(
        content=mp3_bytes,
        media_type="audio/mpeg",
        headers={"Cache-Control": "no-cache"},
    )