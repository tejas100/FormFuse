"""
match.py — Router for job matching
Wires POST /api/match to the full matching pipeline:
  JD text → parse → embed → FAISS search → hybrid score → LLM deep score → ranked results

Two-phase architecture (mirrors auto_match.py / watchlist.py):
  Phase 1: matcher.py  — FAISS + hybrid scorer (fast, use_llm=False)
  Phase 2: llm_scorer  — GPT-4o-mini deep score on ALL results (no threshold filter,
                          small set so every resume gets the full LLM treatment)
"""

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from typing import Optional
from sqlalchemy.ext.asyncio import AsyncSession

from db.database import get_db
from services.matcher import match_resumes

router = APIRouter(prefix="/api/match", tags=["match"])

# Header name the frontend sends for anonymous session scoping
_SESSION_HEADER = "X-Session-ID"
_DEFAULT_SESSION = "default"

def _get_session_id(request: Request) -> str:
    """Extract session ID from header. Falls back to 'default' if absent."""
    return request.headers.get(_SESSION_HEADER, _DEFAULT_SESSION) or _DEFAULT_SESSION


class MatchRequest(BaseModel):
    job_description: str
    use_llm: bool = True  # Toggle LLM layer (set False for faster rule-only matching)


@router.post("")
async def match_resume(
    request: MatchRequest,
    http_request: Request,
    db: AsyncSession = Depends(get_db),
):
    """
    Match all indexed resumes against a job description.
    Session-scoped: only resumes uploaded by this session are matched.
    """
    session_id = _get_session_id(http_request)

    if not request.job_description or not request.job_description.strip():
        raise HTTPException(status_code=400, detail="Job description cannot be empty")

    if len(request.job_description) > 15000:
        raise HTTPException(status_code=400, detail="Job description too long (max 15000 chars)")

    # ── Phase 1: Hybrid scoring — scoped to session ──
    result = await match_resumes(
        jd_text=request.job_description,
        user_id=session_id,
        use_llm=False,
        db=db,      # enables FAISS rebuild from Supabase on cold start
    )

    # ── Phase 2: LLM deep scoring (if enabled and resumes exist) ──
    if request.use_llm and result.get("results"):
        # Deferred import — avoids circular import at module load time
        from services.llm_scorer import llm_score_batch, rerank_by_llm_score

        parsed_jd = result.get("jd_parsed", {})

        # Build a job-like dict for the LLM context builder
        # _build_jd_summary() reads job.get("job_title") and job.get("description_text")
        job_ctx = {
            "job_title":        parsed_jd.get("title", ""),
            "company":          "",              # not available on Home page (no company)
            "description_text": request.job_description,
        }

        # Build pairs — ALL results go to LLM (no threshold: small set, every resume counts)
        pairs = []
        for match in result["results"]:
            hybrid_score = match.get("score", 0)
            # score from matcher is already 0-100 int
            if isinstance(hybrid_score, float) and hybrid_score <= 1.0:
                hybrid_score = round(hybrid_score * 100)
            else:
                hybrid_score = int(hybrid_score)

            # Session 19: build resume dict directly from match result.
            # match already contains full_text + structured (from matcher.py/_load_resumes_from_db).
            # _get_full_resume() reads local JSON only — returns None for DB-backed (auth) resumes,
            # which previously caused all authenticated pairs to be silently dropped.
            resume_dict = {
                "id":        match["resume_id"],
                "name":      match.get("name", ""),
                "file_ext":  match.get("file_ext", ""),
                "skills":    match.get("skills", []),
                "years_exp": match.get("years_exp"),
                "titles":    match.get("titles", []),
                "domains":   match.get("domains", []),
                "full_text": match.get("full_text"),   # populated for resumes uploaded post-Session-19
                "structured": {
                    "years_exp": match.get("years_exp"),
                    "titles":    match.get("titles", []),
                    "domains":   match.get("domains", []),
                    "skills":    match.get("skills", []),
                },
            }

            # Fallback for anonymous users: if full_text not present, try local JSON
            if not resume_dict["full_text"]:
                local = _get_full_resume(match["resume_id"])
                if local:
                    resume_dict["full_text"] = local.get("full_text")
                    resume_dict["structured"] = local.get("structured", resume_dict["structured"])

            pairs.append({
                **match,
                "hybrid_score":      hybrid_score,
                "hybrid_components": match.get("components", {}),
                "job":               job_ctx,
                "resume":            resume_dict,
                "parsed_jd":         parsed_jd,
            })

        if pairs:
            # Run LLM scoring concurrently
            enriched = await llm_score_batch(pairs)

            # Re-rank by llm_score (primary) then hybrid_score (tiebreaker)
            enriched = rerank_by_llm_score(enriched)

            # Set score = llm_score so existing frontend code using r.score still works
            for entry in enriched:
                entry["score"] = entry.get("llm_score", entry.get("hybrid_score", 0))

            result["results"] = enriched
            result["meta"]["llm_scored"] = sum(
                1 for e in enriched if e.get("scoring_method") == "llm+hybrid"
            )

    return result


def _get_full_resume(resume_id: str):
    """Load full resume dict (with chunks + structured) for LLM context building."""
    try:
        from services.ingestion import get_resume_by_id
        return get_resume_by_id(resume_id)
    except Exception:
        return None

# ══════════════════════════════════════════════════════════════════════════════
# POST /api/match/chat — Input triage + tool-calling career assistant
#
# Flow:
#   1. Classify input → JD | CAREER_QUESTION | OFF_TOPIC
#   2. JD         → return intent="JD", frontend runs /api/match as normal
#   3. OFF_TOPIC  → instant redirect message, no further LLM call
#   4. CAREER_QUESTION →
#        a. Send question to LLM with 4 tools it can invoke
#        b. LLM requests tool(s) it needs (or none if question is generic)
#        c. We execute those tools against the real DB for this user
#        d. Feed results back to LLM
#        e. LLM answers with actual user data
#
# Auth: optional — authenticated users get real DB data, anonymous users get
# generic career advice (tools return empty for non-UUID user_ids).
# ══════════════════════════════════════════════════════════════════════════════

import httpx as _httpx
import json as _json
import os as _os
import logging as _logging

from fastapi import Security
from fastapi.security import HTTPBearer as _HTTPBearer, HTTPAuthorizationCredentials as _HTTPAuthCreds
from models.orm import Resume as _Resume, AutoMatchResult as _AutoMatchResult
from sqlalchemy import select as _select

_chat_log = _logging.getLogger(__name__)
_optional_bearer = _HTTPBearer(auto_error=False)


class ChatRequest(BaseModel):
    text: str
    context: Optional[list] = None      # serialized recent messages for routing context
    mode_hint: Optional[str] = None     # "tailor" | "rank" | None — slash command hint

class ChatResponse(BaseModel):
    # Routing tool selected by the LLM — the single source of truth for frontend routing
    # tool: "route_to_rank" | "route_to_tailor" | "route_to_refine" |
    #        "answer_career_question" | "show_matched_jobs" | "route_off_topic" |
    #        "route_to_apply"
    tool: str
    intent: str                         # legacy alias for tool — kept for backward compat
    params: Optional[dict] = None       # tool-specific params (jd_text, modification_hint, etc.)
    reply: Optional[str] = None         # populated for answer_career_question and route_off_topic
    jobs: Optional[list] = None         # populated for show_matched_jobs
    filter_label: Optional[str] = None  # human-readable label for the job table header
    apply_jobs: Optional[list] = None   # populated for route_to_apply — jobs to apply to


# ── Unified router system prompt ──────────────────────────────────────────────
_ROUTER_SYSTEM = """You are RACK's input router. RACK is an AI-powered resume matching platform.
Your ONLY job is to call exactly ONE routing tool based on the user's message and conversation context.

ROUTING RULES — read these carefully:

route_to_rank: User pasted a job description (has requirements, responsibilities, role title) OR a job board URL. Use this for any structured JD content.

route_to_tailor: User wants a tailored PDF resume for a job. Triggers on: "tailor", "customize", "optimize", "generate a pdf", "make a version for this role", "fit my resume to this", "push my score". IMPORTANT: if the previous message was a rank result and user is asking to tailor for that same role — extract jd_text from the rank context and pass it here.

route_to_refine: User wants to refine/modify a PREVIOUSLY TAILORED resume. Only fires when the immediately prior message was a tailor result. Triggers on follow-up instructions like "make it more concise", "add X to the experience section", "remove Y", "focus more on Z".

answer_career_question: User asked a career-related question (about their resumes, job search strategy, interview prep, skills gaps, salary, matched jobs). NOT a routing decision — you'll use DB tools to answer.

show_matched_jobs: User wants to SEE their matched jobs as a list/table. Triggers on "show me my matches", "what jobs did you find", "top jobs for me", "85%+ matches". Distinct from answer_career_question which gives a text answer.

route_off_topic: Anything not related to jobs, careers, resumes, or professional development. Greetings alone ("hi", "hello") should be route_off_topic unless combined with a career request.

route_to_apply: User wants to auto-fill and submit job applications. Triggers on: "apply", "fill the form", "start applying", "apply to all", "apply to these jobs", "submit my application". Only use when jobs have already been shown in the conversation. Extract apply_all and job_indices from context.

MODE HINT: If a mode_hint is provided ("tailor" or "rank"), treat it as a strong signal toward that routing tool but the message content still matters."""


# ── Career assistant system prompt ───────────────────────────────────────────
_CAREER_SYSTEM = """You are RACK's personal job search assistant — sharp, direct, and genuinely helpful.
RACK is an AI-powered resume matching platform. You have access to the user's real resume data and matched jobs via tools.

When answering questions about the user's resumes, skills, or matched jobs — ALWAYS call the relevant tool first to get their actual data. Never guess or give generic answers when you can fetch real data.

Rules:
- Only answer questions related to careers, job searching, resumes, and professional development
- If asked something off-topic, warmly redirect to how you can help with their job search
- Be specific and actionable. Use the user's actual data from tools whenever relevant
- Keep replies concise — 2 to 5 sentences for simple questions, structured lists for job/skill results
- Never start with filler phrases like "Great question!" or "Certainly!"
- Speak like a sharp, knowledgeable recruiter who is genuinely on the user's side
- If a tool returns no data, tell the user honestly and suggest what to do next"""


# ── Router tool definitions (the 6 routing actions the LLM must pick from) ────
_ROUTER_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "route_to_rank",
            "description": "User pasted a job description or job board URL to rank their resumes against.",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "route_to_tailor",
            "description": "User wants a tailored PDF resume for a specific job. Provide the resolved JD text if available from context (e.g. if the previous turn was a rank result, extract its jd_text).",
            "parameters": {
                "type": "object",
                "properties": {
                    "jd_text": {
                        "type": "string",
                        "description": "The job description text to tailor against. If the previous turn was a rank result, extract the stored JD text from context. Otherwise leave empty.",
                    },
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "route_to_refine",
            "description": "User wants to refine or modify the most recently tailored resume. Only use when the prior turn was a tailor result.",
            "parameters": {
                "type": "object",
                "properties": {
                    "modification_hint": {
                        "type": "string",
                        "description": "The user's refinement instruction (e.g. 'make it more concise', 'add Python to skills section').",
                    },
                    "jd_text": {
                        "type": "string",
                        "description": "The JD context from the original tailor turn, for continuity.",
                    },
                },
                "required": ["modification_hint"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "answer_career_question",
            "description": "User asked a career-related question. Will use DB tools to answer with real user data.",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "show_matched_jobs",
            "description": "User wants to see their matched jobs as a table/list. Use when they ask to 'show', 'list', or 'view' their matches.",
            "parameters": {
                "type": "object",
                "properties": {
                    "min_score": {"type": "integer", "description": "Minimum match score 0-100. Use 85 for top matches, 75 for good matches, 0 for all."},
                    "limit":     {"type": "integer", "description": "Number of jobs to return. Default 5, max 20."},
                    "sort_by":   {"type": "string", "enum": ["score", "recent"], "description": "Sort by best score or most recently posted."},
                    "hours":     {"type": "integer", "description": "Only return jobs matched within the last N hours."},
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "route_to_apply",
            "description": "User wants to auto-apply to one or more matched jobs. Triggers on: 'apply', 'fill the form', 'start applying', 'apply to all', 'apply to these jobs', 'submit my application'. Only use when the user is referencing specific jobs they have already seen in matched results.",
            "parameters": {
                "type": "object",
                "properties": {
                    "apply_all": {
                        "type": "boolean",
                        "description": "True if the user said 'all', 'all of them', or similar. False if they named/selected specific jobs.",
                    },
                    "job_indices": {
                        "type": "array",
                        "items": {"type": "integer"},
                        "description": "0-based indices of the specific jobs the user wants to apply to (e.g. [0] for the first job, [0,1,2] for first three). Empty if apply_all=true.",
                    },
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "route_off_topic",
            "description": "Input is not related to jobs, careers, resumes, or professional development.",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
]


# ── Tool definitions (OpenAI function calling format) ─────────────────────────
_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "get_user_resumes",
            "description": "Fetch the user's uploaded resumes including their skills, experience, job titles, and domains. Use this when the user asks about their resumes, skills, background, or what roles they are qualified for.",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_matched_jobs",
            "description": "Fetch auto-matched jobs for the user from the database, sorted by match score. Use this when the user asks about their matched jobs, top job recommendations, recent matches, or wants to see roles that fit their profile.",
            "parameters": {
                "type": "object",
                "properties": {
                    "min_score": {
                        "type": "integer",
                        "description": "Minimum match score 0-100. Use 85 for top matches, 75 for good matches, 0 for all.",
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Number of jobs to return. Default 5, max 20.",
                    },
                    "sort_by": {
                        "type": "string",
                        "enum": ["score", "recent"],
                        "description": "Sort by best score or most recently posted.",
                    },
                    "hours": {
                        "type": "integer",
                        "description": "Only return jobs matched within the last N hours. Use 1 for 'past hour', 24 for 'today', 168 for 'past week'. Omit for no time filter.",
                    },
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_role_suggestions",
            "description": "Analyze the user's top matched jobs and resumes to suggest the best role categories they should target. Use this when the user asks what roles to apply for, what jobs suit them, or wants career direction based on their profile.",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_match_stats",
            "description": "Return aggregate statistics about the user's job matches — total matched, average score, score distribution, top companies. Use this when the user asks how strong their profile is, how many matches they have, or wants an overview.",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
]


# ── Tool executors — each queries the real DB ─────────────────────────────────

async def _tool_get_user_resumes(user_uuid, db) -> dict:
    result = await db.execute(
        _select(_Resume)
        .where(_Resume.user_id == user_uuid, _Resume.status == "active")
        .order_by(_Resume.uploaded_at.desc())
    )
    resumes = result.scalars().all()
    if not resumes:
        return {"resumes": [], "count": 0, "message": "No resumes uploaded yet."}
    return {
        "count": len(resumes),
        "resumes": [
            {
                "name": r.display_name,
                "years_experience": r.years_exp,
                "titles": (r.titles or [])[:5],
                "skills": (r.skills or [])[:20],
                "domains": (r.domains or [])[:5],
                "uploaded_at": r.uploaded_at.isoformat() if r.uploaded_at else None,
            }
            for r in resumes
        ],
    }


async def _tool_get_matched_jobs(user_uuid, db, min_score: int = 0, limit: int = 5, sort_by: str = "score", hours: int = 0) -> dict:
    from datetime import datetime, timezone, timedelta as _timedelta
    limit = min(max(1, limit), 20)
    conditions = [_AutoMatchResult.user_id == user_uuid, _AutoMatchResult.score >= min_score]
    if hours and hours > 0:
        cutoff = datetime.now(timezone.utc) - _timedelta(hours=hours)
        conditions.append(_AutoMatchResult.matched_at >= cutoff)
    query = _select(_AutoMatchResult).where(*conditions)
    query = query.order_by(
        _AutoMatchResult.matched_at.desc().nullslast()
        if sort_by == "recent" or hours
        else _AutoMatchResult.score.desc()
    )
    result = await db.execute(query.limit(limit))
    rows = result.scalars().all()

    if not rows:
        return {"jobs": [], "count": 0, "message": "No matched jobs found. Run Auto Matches in the Tracking tab first."}

    return {
        "count": len(rows),
        "jobs": [
            {
                "job_title":          (r.job_data or {}).get("job_title", "Unknown"),
                "company":            (r.job_data or {}).get("company", "Unknown"),
                "score":              round(r.score),
                "llm_recommendation": (r.job_data or {}).get("llm_recommendation", ""),
                "matched_skills":     ((r.job_data or {}).get("matched_skills") or [])[:6],
                "missing_skills":     ((r.job_data or {}).get("missing_skills") or [])[:4],
                "posted_at":          r.posted_at.isoformat() if r.posted_at else None,
                # job_url is the canonical key written by auto_match; fall back to url
                "url":                (r.job_data or {}).get("job_url") or (r.job_data or {}).get("url", ""),
                "job_id":             r.job_id,
                "scoring_method":     (r.job_data or {}).get("scoring_method", ""),
                "resume_name":        (r.job_data or {}).get("best_resume_name", None),
                "resume_id":          (r.job_data or {}).get("best_resume_id", None),
            }
            for r in rows
        ],
    }


async def _tool_get_role_suggestions(user_uuid, db) -> dict:
    from collections import Counter as _Counter

    r1 = await db.execute(
        _select(_AutoMatchResult)
        .where(_AutoMatchResult.user_id == user_uuid, _AutoMatchResult.score >= 60)
        .order_by(_AutoMatchResult.score.desc())
        .limit(20)
    )
    rows = r1.scalars().all()

    r2 = await db.execute(
        _select(_Resume).where(_Resume.user_id == user_uuid, _Resume.status == "active")
    )
    resumes = r2.scalars().all()

    if not rows and not resumes:
        return {"suggestions": [], "message": "No data yet. Upload your resumes and run Auto Matches first."}

    title_counts = _Counter()
    company_set = set()
    for r in rows:
        jd = r.job_data or {}
        if jd.get("job_title"):
            title_counts[jd["job_title"].strip()] += 1
        if jd.get("company"):
            company_set.add(jd["company"].capitalize())

    resume_titles = []
    resume_skills = []
    for res in resumes:
        resume_titles.extend(res.titles or [])
        resume_skills.extend((res.skills or [])[:10])

    return {
        "top_matched_roles": [{"title": t, "match_count": c} for t, c in title_counts.most_common(8)],
        "your_resume_titles": list(set(resume_titles))[:6],
        "your_top_skills": list(set(resume_skills))[:15],
        "companies_with_matches": sorted(list(company_set))[:8],
        "total_qualifying_matches": len(rows),
    }


async def _tool_get_match_stats(user_uuid, db) -> dict:
    result = await db.execute(
        _select(_AutoMatchResult).where(_AutoMatchResult.user_id == user_uuid)
    )
    rows = result.scalars().all()

    if not rows:
        return {"total_matches": 0, "message": "No matches yet. Run Auto Matches in the Tracking tab."}

    scores = [r.score for r in rows]
    companies = {}
    for r in rows:
        c = (r.job_data or {}).get("company", "")
        if c:
            companies[c] = companies.get(c, 0) + 1

    return {
        "total_matches": len(rows),
        "average_score": round(sum(scores) / len(scores), 1),
        "score_breakdown": {
            "strong_85_plus":  sum(1 for s in scores if s >= 85),
            "good_75_to_84":   sum(1 for s in scores if 75 <= s < 85),
            "partial_60_to_74":sum(1 for s in scores if 60 <= s < 75),
            "low_below_60":    sum(1 for s in scores if s < 60),
        },
        "top_companies": [
            {"company": c.capitalize(), "matches": n}
            for c, n in sorted(companies.items(), key=lambda x: -x[1])[:5]
        ],
    }


# ── Tool dispatcher ───────────────────────────────────────────────────────────

async def _execute_tool(name: str, args: dict, user_id: Optional[str], db) -> str:
    if not user_id or not db:
        return _json.dumps({"error": "User not authenticated — no personal data available."})
    try:
        import uuid as _uuid_mod
        user_uuid = _uuid_mod.UUID(user_id)
    except (ValueError, AttributeError):
        return _json.dumps({"error": "Cannot fetch personal data for anonymous users."})

    try:
        if name == "get_user_resumes":
            data = await _tool_get_user_resumes(user_uuid, db)
        elif name == "get_matched_jobs":
            data = await _tool_get_matched_jobs(
                user_uuid, db,
                min_score=int(args.get("min_score", 0)),
                limit=int(args.get("limit", 5)),
                sort_by=args.get("sort_by", "score"),
                hours=int(args.get("hours", 0)),
            )
        elif name == "get_role_suggestions":
            data = await _tool_get_role_suggestions(user_uuid, db)
        elif name == "get_match_stats":
            data = await _tool_get_match_stats(user_uuid, db)
        else:
            data = {"error": f"Unknown tool: {name}"}
    except Exception as e:
        _chat_log.warning(f"[chat] Tool {name} failed: {e}")
        data = {"error": f"Tool execution failed: {str(e)}"}

    return _json.dumps(data)


# ── Endpoint ──────────────────────────────────────────────────────────────────

@router.post("/chat", response_model=ChatResponse)
async def chat(
    request: ChatRequest,
    http_request: Request,
    credentials: Optional[_HTTPAuthCreds] = Security(_optional_bearer),
    db: AsyncSession = Depends(get_db),
):
    """
    Unified LLM router: classify + route user input in a single tool-calling pass.
    The LLM picks one of 6 routing tools. The frontend executes whatever comes back.
    Auth'd users get data-driven answers for career questions. Anonymous users get generic advice.
    """
    text = request.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Text cannot be empty")

    api_key = _os.environ.get("OPENAI_API_KEY")
    if not api_key:
        # Fallback: treat as JD so match pipeline still runs
        return ChatResponse(tool="route_to_rank", intent="JD")

    # Resolve user_id from JWT if present
    user_id: Optional[str] = None
    if credentials and credentials.credentials:
        try:
            from routers.auth import _verify_token
            payload = _verify_token(credentials.credentials)
            user_id = payload.get("sub")
        except Exception:
            pass

    # ── Build conversation context string for the router ──────────────────────
    context_parts = []
    if request.context:
        for msg in request.context[-5:]:
            msg_type = msg.get("type", "")
            if msg_type == "tailor":
                context_parts.append(f"[Previous turn: TAILOR RESULT] {msg.get('content', '')} | jd: {msg.get('jd', '')} | jd_text available: {bool(msg.get('jd_text'))}")
            elif msg_type == "match":
                jd_text_preview = (msg.get('jd_text') or '')[:200]
                context_parts.append(f"[Previous turn: RANK RESULT] {msg.get('content', '')} | jd_text: {jd_text_preview}")
            elif msg_type == "filter":
                context_parts.append(f"[Previous turn: FILTER RESULT] {msg.get('content', '')}")
            elif msg_type == "reply":
                context_parts.append(f"[Previous turn: ASSISTANT REPLY] {msg.get('content', '')[:200]}")

    context_block = "\n".join(context_parts) if context_parts else "No prior conversation."
    mode_hint_str = f"\nMode hint (user's slash command): {request.mode_hint}" if request.mode_hint else ""

    router_user_msg = f"""Conversation context (most recent last):
{context_block}
{mode_hint_str}

User's new message:
{text[:1000]}

Call exactly ONE routing tool now."""

    async with _httpx.AsyncClient() as client:

        # ── Step 1: Single routing call — LLM picks one of 6 tools ───────────
        try:
            route_res = await client.post(
                "https://api.openai.com/v1/chat/completions",
                headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                json={
                    "model": "gpt-4o-mini",
                    "messages": [
                        {"role": "system", "content": _ROUTER_SYSTEM},
                        {"role": "user",   "content": router_user_msg},
                    ],
                    "tools":       _ROUTER_TOOLS,
                    "tool_choice": "required",   # must pick a tool — no free-text escape
                    "max_tokens":  200,
                    "temperature": 0.0,
                },
                timeout=10.0,
            )
            route_data   = route_res.json()
            route_msg    = route_data["choices"][0]["message"]
            route_calls  = route_msg.get("tool_calls") or []
            if not route_calls:
                raise ValueError("Router returned no tool call")
            selected_tool = route_calls[0]["function"]["name"]
            try:
                tool_params = _json.loads(route_calls[0]["function"].get("arguments", "{}"))
            except _json.JSONDecodeError:
                tool_params = {}
        except Exception as e:
            _chat_log.warning(f"[chat] Router call failed: {e}")
            # Fallback: assume JD so match pipeline runs
            return ChatResponse(tool="route_to_rank", intent="JD")

        _chat_log.info(f"[chat] Router selected: {selected_tool} | user={user_id} | params={tool_params}")

        # ── Step 2: Execute routing decision ──────────────────────────────────

        # Pure routing — no extra work needed
        if selected_tool == "route_to_rank":
            return ChatResponse(tool="route_to_rank", intent="JD")

        if selected_tool == "route_to_tailor":
            return ChatResponse(
                tool="route_to_tailor", intent="JD",
                params={"jd_text": tool_params.get("jd_text") or None},
            )

        if selected_tool == "route_to_refine":
            return ChatResponse(
                tool="route_to_refine", intent="JD",
                params={
                    "modification_hint": tool_params.get("modification_hint", text),
                    "jd_text":           tool_params.get("jd_text") or None,
                },
            )

        if selected_tool == "route_to_apply":
            apply_all   = bool(tool_params.get("apply_all", False))
            job_indices = tool_params.get("job_indices", [])

            jobs_data = await _execute_tool(
                "get_matched_jobs",
                {"min_score": 0, "limit": 20, "sort_by": "score"},
                user_id, db,
            )
            all_jobs = _json.loads(jobs_data).get("jobs", [])

            if apply_all:
                apply_jobs = all_jobs[:5]
            elif job_indices:
                apply_jobs = [all_jobs[i] for i in job_indices if i < len(all_jobs)]
            else:
                apply_jobs = all_jobs[:1]

            if not apply_jobs:
                return ChatResponse(
                    tool="route_to_apply", intent="APPLY",
                    reply="No matched jobs found to apply to. Run Auto Matches in the Tracking tab first.",
                )

            return ChatResponse(
                tool="route_to_apply", intent="APPLY",
                apply_jobs=apply_jobs,
            )

        if selected_tool == "route_off_topic":
            return ChatResponse(
                tool="route_off_topic", intent="OFF_TOPIC",
                reply="I'm built to help you land your next job — paste a job description and I'll instantly rank your resumes against it, or ask me anything about your job search, resume, or interview prep.",
            )

        # show_matched_jobs — run the DB tool and return structured rows
        if selected_tool == "show_matched_jobs":
            min_score = int(tool_params.get("min_score", 0))
            limit     = int(tool_params.get("limit", 5))
            sort_by   = tool_params.get("sort_by", "score")
            hours     = int(tool_params.get("hours", 0))
            jobs_data = await _execute_tool(
                "get_matched_jobs",
                {"min_score": min_score, "limit": limit, "sort_by": sort_by, "hours": hours},
                user_id, db,
            )
            jobs_parsed = _json.loads(jobs_data)
            jobs_list   = jobs_parsed.get("jobs", [])
            if jobs_list:
                # Build label the same way the old FILTER_RESULT path did
                if hours > 0:
                    label = (f"Jobs matched in the past hour" if hours == 1
                             else f"Jobs matched in the past {hours}h" if hours <= 24
                             else f"Jobs matched in the past {hours // 24} day{'s' if hours // 24 != 1 else ''}")
                elif sort_by == "recent":
                    label = "Newly matched jobs"
                elif min_score >= 85:
                    label = "85%+ match jobs"
                elif min_score >= 75:
                    label = "75%+ match jobs"
                elif min_score > 0:
                    label = f"{min_score}%+ match jobs"
                else:
                    label = f"Top {limit} matched jobs" if limit < 20 else "All matched jobs"
                return ChatResponse(tool="show_matched_jobs", intent="FILTER_RESULT", jobs=jobs_list, filter_label=label)
            # No rows — fall through to career question answering so LLM can explain
            selected_tool = "answer_career_question"

        # answer_career_question — tool-calling loop with DB tools
        # (same logic as before, now reached only for genuine career questions)
        career_messages = [
            {"role": "system", "content": _CAREER_SYSTEM},
            {"role": "user",   "content": text},
        ]

        try:
            first_res = await client.post(
                "https://api.openai.com/v1/chat/completions",
                headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                json={
                    "model": "gpt-4o-mini",
                    "messages":    career_messages,
                    "tools":       _TOOLS,
                    "tool_choice": "auto",
                    "max_tokens":  500,
                    "temperature": 0.4,
                },
                timeout=15.0,
            )
            first_data    = first_res.json()
            assistant_msg = first_data["choices"][0]["message"]
            tool_calls    = assistant_msg.get("tool_calls") or []
        except Exception as e:
            _chat_log.warning(f"[chat] Career LLM call failed: {e}")
            return ChatResponse(tool="answer_career_question", intent="CAREER_QUESTION", reply="I ran into an issue. Try again in a moment.")

        if tool_calls:
            career_messages.append({
                "role": "assistant",
                "content": assistant_msg.get("content"),
                "tool_calls": tool_calls,
            })

            tool_results_map = {}
            for tc in tool_calls:
                fn_name = tc["function"]["name"]
                try:
                    fn_args = _json.loads(tc["function"].get("arguments", "{}"))
                except _json.JSONDecodeError:
                    fn_args = {}

                tool_result_str = await _execute_tool(fn_name, fn_args, user_id, db)
                _chat_log.info(f"[chat] DB tool {fn_name} called for user={user_id}")
                tool_results_map[fn_name] = _json.loads(tool_result_str)

                career_messages.append({
                    "role": "tool",
                    "tool_call_id": tc["id"],
                    "content": tool_result_str,
                })

            try:
                second_res = await client.post(
                    "https://api.openai.com/v1/chat/completions",
                    headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                    json={
                        "model": "gpt-4o-mini",
                        "messages": career_messages,
                        "max_tokens": 600,
                        "temperature": 0.4,
                    },
                    timeout=15.0,
                )
                reply = second_res.json()["choices"][0]["message"]["content"].strip()
            except Exception as e:
                _chat_log.warning(f"[chat] Career round-2 LLM call failed: {e}")
                reply = "I ran into an issue fetching your data. Try again in a moment."
        else:
            reply = assistant_msg.get("content", "").strip()
            if not reply:
                reply = "Ask me anything about your job search, resume strategy, or interview prep."

        return ChatResponse(tool="answer_career_question", intent="CAREER_QUESTION", reply=reply)