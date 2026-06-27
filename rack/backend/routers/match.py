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
        # Deferred imports — avoids circular import at module load time
        from services.llm_scorer import _score_job_multi_resume, rerank_by_llm_score, LLM_CONCURRENCY
        import asyncio as _asyncio
        import httpx as _httpx_match

        parsed_jd = result.get("jd_parsed", {})

        job_ctx = {
            "job_title":        parsed_jd.get("title", ""),
            "company":          "",
            "description_text": request.job_description,
        }

        # Cap full_text per resume for the grouped Home call.
        # llm_scorer._build_resume_summary() caps at 6000 chars (fine for single-pair calls),
        # but with 5 resumes in one prompt that's ~30k chars → ReadTimeout.
        # 2500 chars (~625 tokens) covers a full single-page resume and keeps the
        # grouped prompt under ~15k chars total — well within gpt-4o-mini's window.
        _HOME_FULL_TEXT_CAP = 2500

        resume_entries = []
        for match in result["results"]:
            hybrid_score = match.get("score", 0)
            if isinstance(hybrid_score, float) and hybrid_score <= 1.0:
                hybrid_score = round(hybrid_score * 100)
            else:
                hybrid_score = int(hybrid_score)

            full_text = match.get("full_text")

            # Fallback for anonymous users
            if not full_text:
                local = _get_full_resume(match["resume_id"])
                if local:
                    full_text = local.get("full_text")

            # Cap per-resume full_text so the grouped prompt doesn't timeout
            if full_text and len(full_text) > _HOME_FULL_TEXT_CAP:
                full_text = full_text[:_HOME_FULL_TEXT_CAP]

            resume_dict = {
                "id":        match["resume_id"],
                "name":      match.get("name", ""),
                "file_ext":  match.get("file_ext", ""),
                "skills":    match.get("skills", []),
                "years_exp": match.get("years_exp"),
                "titles":    match.get("titles", []),
                "domains":   match.get("domains", []),
                "full_text": full_text,
                "structured": {
                    "years_exp": match.get("years_exp"),
                    "titles":    match.get("titles", []),
                    "domains":   match.get("domains", []),
                    "skills":    match.get("skills", []),
                },
            }

            resume_entries.append({
                **match,
                "hybrid_score":      hybrid_score,
                "hybrid_components": match.get("components", {}),
                "job":               job_ctx,
                "resume":            resume_dict,
                "parsed_jd":         parsed_jd,
            })

        if resume_entries:
            # Single grouped LLM call — all resumes scored together in one prompt.
            # Grouped scoring forces the model to differentiate rather than anchor
            # to the same score for every resume (the flat-72 / flat-51 bug).
            # Timeout bumped to 45s — single call replacing N concurrent calls,
            # gpt-4o-mini needs more time to process the larger combined prompt.
            semaphore = _asyncio.Semaphore(LLM_CONCURRENCY)
            import logging as _logging_match
            _match_log = _logging_match.getLogger(__name__)
            enriched = None
            for _attempt in range(2):
                try:
                    async with _httpx_match.AsyncClient(timeout=60.0) as _client:
                        enriched = await _score_job_multi_resume(
                            job_id="home",
                            job=job_ctx,
                            resume_entries=resume_entries,
                            client=_client,
                            semaphore=semaphore,
                        )
                    break
                except Exception as _llm_err:
                    if _attempt == 0:
                        _match_log.warning(f"[match] LLM scorer attempt 1 failed ({_llm_err}), retrying…")
                    else:
                        _match_log.warning(f"[match] LLM scorer attempt 2 failed ({_llm_err}), falling back to hybrid scores")
            if enriched is None:
                enriched = resume_entries

            enriched = rerank_by_llm_score(enriched)

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
    #        "route_to_apply" | "start_batch_apply"
    #
    # start_batch_apply — auth'd imperative apply intent. params carries the job
    # selection hints ({apply_all, job_indices, limit}); the frontend resolves
    # them against its visible job table and calls POST /api/apply/batch.
    tool: str
    intent: str                         # legacy alias for tool — kept for backward compat
    params: Optional[dict] = None       # tool-specific params (jd_text, modification_hint, etc.)
    reply: Optional[str] = None         # populated for answer_career_question and route_off_topic
    jobs: Optional[list] = None         # populated for show_matched_jobs
    filter_label: Optional[str] = None  # human-readable label for the job table header
    apply_jobs: Optional[list] = None   # populated for route_to_apply — jobs to apply to
    resumes: Optional[list] = None      # populated for show_user_resumes
    sort_by: Optional[str] = None       # "recent" | "score" — initial sort for show_matched_jobs toggle


# ── Unified router system prompt ──────────────────────────────────────────────
_ROUTER_SYSTEM = """You are RACK's input router. RACK is an AI-powered resume matching platform.
Your ONLY job is to call exactly ONE routing tool based on the user's message and conversation context.

ROUTING RULES — read these carefully:

route_to_rank: User pasted a job description (has requirements, responsibilities, role title) OR a job board URL. Use this for any structured JD content.

route_to_tailor: User wants a tailored PDF resume for a job. Triggers on: "tailor", "customize", "optimize", "generate a pdf", "make a version for this role", "fit my resume to this", "push my score". IMPORTANT: if the previous message was a rank result and user is asking to tailor for that same role — extract jd_text from the rank context and pass it here.

route_to_refine: User wants to refine/modify a PREVIOUSLY TAILORED resume. Only fires when the immediately prior message was a tailor result. Triggers on follow-up instructions like "make it more concise", "add X to the experience section", "remove Y", "focus more on Z".

answer_career_question: User asked a career-related question (about their resumes, job search strategy, interview prep, skills gaps, salary, matched jobs). NOT a routing decision — you'll use DB tools to answer.

show_user_resumes: User wants to SEE their uploaded resumes as a list/gallery. Triggers on "show me my resumes", "show my resumes", "list my resumes", "what resumes do I have", "my uploaded resumes", "view my resumes", "which resumes have I uploaded", "show all my resumes", "my active resumes". Distinct from answer_career_question — use this when the user just wants to see/browse their resumes, not ask a question about them.

show_matched_jobs: User wants to SEE their matched jobs as a list/table. Triggers on "show me my matches", "what jobs did you find", "top jobs for me", "85%+ matches". Distinct from answer_career_question which gives a text answer.
  RECENCY — when the user says "recent", "recently matched", "latest", "new matches", "past few days", "yesterday", "jobs from today", "newly matched", "what's new" → set sort_by="recent". Also set hours based on time frame: "today" or "yesterday" → hours=48, "past 3 days" → hours=72, "past week" → hours=168, "recently" with no specific time → hours=72. Always combine sort_by="recent" with the appropriate hours value.
  SCORE — when the user says "top", "best", "highest", "85%+", "75%+" → set sort_by="score" with appropriate min_score.

route_off_topic: Anything not related to jobs, careers, resumes, or professional development. This includes pure greetings ("hi", "hello", "hey", "what's up", "how are you"), small talk, and genuinely off-topic topics. Route greetings here — the LLM will generate a warm, natural response.

route_to_apply: User wants RACK to apply to jobs FOR them. Triggers on imperative commands: "apply to my recently matched jobs", "apply to these", "apply to the first two", "start applying", "apply to all of them", "fill out my applications", "submit my application". Set apply_all=true when they say "all"/"all of them". Set job_indices when they reference specific positions in a job list they were just shown ("the first one" → [0], "the top 3" → [0,1,2]). Set limit when they give a count without referencing visible jobs ("apply to 5 jobs" → limit=5). CRITICAL: Questions like "how do I apply?", "how can I apply?", "how should I apply?", "what's the process to apply?", "how do these apply buttons work?" are CAREER QUESTIONS — route those to answer_career_question, NOT route_to_apply. Only use route_to_apply for clear imperative commands to take action, not informational questions about applying.

MODE HINT: If a mode_hint is provided ("tailor" or "rank"), treat it as a strong signal toward that routing tool but the message content still matters."""


# ── Career assistant system prompt ───────────────────────────────────────────
_CAREER_SYSTEM = """You are RACK's personal job search assistant — sharp, direct, and genuinely helpful.
RACK is an AI-powered resume matching platform. You have access to the user's real resume data and matched jobs via tools.

When answering questions about the user's resumes, skills, or matched jobs — ALWAYS call the relevant tool first to get their actual data. Never guess or give generic answers when you can fetch real data.

RESUME COMPARISON RULE — CRITICAL: If the user asks which resume is strongest/best/most powerful for a role or skill set (e.g. "which resume is best for AI Engineer", "which is strongest for ML", "rank my resumes for data science"):
1. Call ONLY get_user_resumes — do NOT call get_matched_jobs. Job match data is irrelevant for comparing resumes against each other.
2. Read each resume's titles, skills, domains, and content_preview carefully.
3. Pick a clear winner and explain WHY it's strongest for that specific role — reference specific skills or experience from that resume.
4. Briefly note what the runner-up is missing or could improve.
5. Never say "no matched jobs available" — that's irrelevant to this question.

CRITICAL RULE — Apply questions: If the user asks HOW to apply, WHERE to apply, or anything about the process of applying ("how do I apply", "how can I apply for these", "how do I submit", "where do I apply", "what's the process to apply", "how do I apply for these jobs") — do NOT write generic step-by-step advice. Instead respond with EXACTLY this token and nothing else:
REDIRECT_TO_TRACKING

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
            "name": "show_user_resumes",
            "description": "User wants to see their uploaded resumes as a visual list. Use when they say 'show my resumes', 'list my resumes', 'what resumes do I have', 'my active resumes', 'view my resumes'.",
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
            "description": "User wants RACK to auto-apply to matched jobs for them. Triggers on imperative commands: 'apply', 'apply to my recently matched jobs', 'fill the form', 'start applying', 'apply to all', 'apply to these jobs', 'submit my application'. Works whether or not specific jobs are visible — RACK can auto-select their recent matches.",
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
                        "description": "0-based indices of the specific jobs the user wants to apply to (e.g. [0] for the first job, [0,1,2] for first three). Empty if apply_all=true or no visible list referenced.",
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Number of jobs to apply to when the user gives a count without referencing a visible list ('apply to 5 jobs' → 5). Omit otherwise.",
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
                "id": str(r.id),
                "name": r.display_name,
                "file_ext": r.file_ext or "pdf",
                "years_experience": r.years_exp,
                "titles": (r.titles or [])[:5],
                "skills": (r.skills or [])[:20],
                "domains": (r.domains or [])[:5],
                "uploaded_at": r.uploaded_at.isoformat() if r.uploaded_at else None,
                # First 800 chars of full text gives LLM enough context to differentiate
                # resumes when answering "which is most powerful for X role" questions.
                "content_preview": (r.full_text or "")[:800] if r.full_text else None,
            }
            for r in resumes
        ],
    }


async def _tool_get_matched_jobs(user_uuid, db, min_score: int = 0, limit: int = 5, sort_by: str = "score", hours: int = 0) -> dict:
    from datetime import datetime, timezone, timedelta as _timedelta
    from sqlalchemy import func as _func
    from models.orm import ArchivedJobId as _ArchivedJobId
    limit = min(max(1, limit), 20)
    conditions = [_AutoMatchResult.user_id == user_uuid, _AutoMatchResult.score >= min_score]

    # "Newest" = most recently POSTED. matched_at reflects when our pipeline last
    # scored the job, which can lag the actual posting by weeks (the scorer runs in
    # batches), so sorting/filtering by matched_at makes genuinely-old postings look
    # "recent" and silently drops fresh ones. posted_at is the canonical recency
    # signal used everywhere else (/auto/fresh, daily_slots). Coalesce to matched_at
    # only as a fallback for the rare row with no posted_at.
    _recency_col = _func.coalesce(_AutoMatchResult.posted_at, _AutoMatchResult.matched_at)

    if hours and hours > 0:
        cutoff = datetime.now(timezone.utc) - _timedelta(hours=hours)
        conditions.append(_recency_col >= cutoff)

    # Exclude jobs the user already archived/removed — keeps the chat list in sync
    # with what Tracking shows (Tracking's /auto/fresh applies the same exclusion).
    _archived_subq = _select(_ArchivedJobId.job_id).where(_ArchivedJobId.user_id == user_uuid)
    conditions.append(_AutoMatchResult.job_id.notin_(_archived_subq))

    query = _select(_AutoMatchResult).where(*conditions)
    query = query.order_by(
        _recency_col.desc().nullslast()
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
                "matched_at":         r.matched_at.isoformat() if r.matched_at else None,
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

        # ══ Deterministic routing intercepts ══════════════════════════════════
        # The router LLM is the default, but a few high-stakes routing decisions
        # are corrected deterministically so identical requests always behave the
        # same way. These run in priority order BEFORE the log line so params are
        # already corrected when logged.
        _txt_lower = text.lower()

        # ── Intercept 1: apply HOW-TO questions (highest priority, returns early) ─
        # Any message asking HOW/WHERE to apply always gets the Tracking redirect,
        # regardless of which tool the router picked. NOTE: imperative commands
        # ("apply to these jobs") must NOT be in this list — those are real apply
        # intent and flow to the batch path via route_to_apply below.
        _apply_kws = [
            'how do i apply', 'how can i apply', 'how should i apply',
            'how to apply', 'where do i apply', 'where can i apply',
            'how do i submit', 'process to apply', 'steps to apply',
            'how do i apply for',
            'how do you apply', 'how would i apply', 'how do we apply',
        ]
        if any(kw in _txt_lower for kw in _apply_kws):
            return ChatResponse(tool="route_to_apply", intent="APPLY", apply_jobs=[])

        # ── Intercept 2: show-matched-jobs ─────────────────────────────────────
        # The router occasionally misclassifies "show me my recently matched jobs"
        # as answer_career_question — which renders a plain-text answer instead of
        # the structured job-table tiles. A job listing must ALWAYS render as tiles
        # (score, badges, Apply button), never as text, so we correct it here.
        # Length guard: a pasted JD is long; a "show me my matches" request is short.
        # This prevents capturing a JD that happens to contain the word "matched".
        _show_jobs_kws = [
            'matched jobs', 'my matches', 'jobs that are matched', 'jobs matched',
            'recently matched', 'newly matched', 'matched recently', 'new matches',
            'all matched', 'all the jobs', 'my matched', 'jobs you found',
            'jobs you matched', 'top jobs for me', 'best matches',
            'show me jobs', 'show jobs', 'show me my matches', 'see my matches',
            'view my matches', 'list my matches', 'list of all the jobs',
        ]
        if (len(text) < 200
                and selected_tool not in ("route_to_rank", "show_matched_jobs")
                and any(kw in _txt_lower for kw in _show_jobs_kws)):
            _chat_log.info(f"[chat] Show-jobs intercept: router picked {selected_tool}, forcing show_matched_jobs")
            selected_tool = "show_matched_jobs"

        # ── Intercept 3: sort resolution ───────────────────────────────────────
        # Runs AFTER the show-jobs intercept so a forced selection is caught too.
        # Default sort for the matched-jobs view is RECENCY (newest first), to match
        # the Tracking page default. Score sort is opt-in: it only kicks in when the
        # user explicitly asks for the best/top/highest matches or a score threshold.
        # Without this, "give me all my matched jobs" sorts by score and surfaces
        # high-scoring-but-stale postings (e.g. a 60-day-old 88% match) at the top.
        _RECENCY_KEYWORDS = [
            'recently matched', 'recent match', 'recent jobs', 'recent ones',
            'recently', 'latest jobs', 'latest matches', 'latest ones', 'new matches',
            'new jobs', 'newly matched', "what's new", 'whats new',
            'newest', 'most recent', 'sort by date', 'sort them', 'fresh',
            'past few days', 'past 3 days', 'past three days', 'last 3 days',
            'past week', 'last week', 'past 7 days',
            'yesterday', 'today', 'jobs from today', 'jobs from yesterday',
            'matched today', 'matched yesterday', 'matched recently',
        ]
        # Explicit score intent — the only thing that overrides the recency default.
        _SCORE_KEYWORDS = [
            'top ', 'best ', 'highest', 'strongest', 'top-scoring', 'top scoring',
            'highest scoring', 'best match', 'best matches', 'best fit', 'best ranked',
            'strong match', 'high score', 'high-score',
            '85%', '85 %', '85+', '75%', '75 %', '75+', '90%', '90+', '80%', '80+',
        ]
        if selected_tool == "show_matched_jobs":
            _has_recency = any(kw in _txt_lower for kw in _RECENCY_KEYWORDS)
            _has_score   = any(kw in _txt_lower for kw in _SCORE_KEYWORDS)

            if _has_recency:
                # Explicit recency. Apply a hard time-window only when the user gives
                # a concrete timeframe; a bare "recently/newest" means "all, newest first".
                if 'week' in _txt_lower or '7 day' in _txt_lower:
                    _hours = 168
                elif 'yesterday' in _txt_lower or 'today' in _txt_lower:
                    _hours = 48
                elif '3 day' in _txt_lower or 'three day' in _txt_lower or 'few day' in _txt_lower:
                    _hours = 72
                else:
                    _hours = 0
                tool_params = {**tool_params, "sort_by": "recent", "hours": _hours}
            elif _has_score:
                # Explicit "top/best/85%+" → score sort (best matches first).
                tool_params = {**tool_params, "sort_by": "score", "hours": 0}
            else:
                # DEFAULT: newest first, no window — mirrors the Tracking page default.
                tool_params = {**tool_params, "sort_by": "recent", "hours": 0}

        # ── Honor "all" — bump the limit so the full set is shown (capped at 20) ─
        # Applies to both score-sorted ("all matched jobs") and recency-sorted
        # ("all the recently matched jobs") requests. The frontend caps display at
        # 20 and links out to Tracking for the rest.
        if selected_tool == "show_matched_jobs" and any(
            w in _txt_lower for w in ('all ', 'every', 'everything', 'full list', 'complete list')
        ):
            tool_params = {**tool_params, "limit": 20}

        _chat_log.info(f"[chat] Router selected: {selected_tool} | user={user_id} | params={tool_params}")

        # ── Step 2: Execute routing decision ──────────────────────────────────


        # Pure routing — no extra work needed
        if selected_tool == "route_to_rank":
            return ChatResponse(tool="route_to_rank", intent="JD")

        if selected_tool == "route_to_tailor":
            # Generate a short, intent-confirming reply so the user sees RACK
            # understood them before the tailor pipeline starts.
            # One extra LLM call (~100ms) is worth the UX clarity.
            _tailor_reply = "On it — generating your tailored resume now."
            try:
                _reply_res = await client.post(
                    "https://api.openai.com/v1/chat/completions",
                    headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                    json={
                        "model": "gpt-4o-mini",
                        "messages": [
                            {
                                "role": "system",
                                "content": (
                                    "You are RACK's job search assistant. The user just asked you to tailor their resume. "
                                    "Write a single short sentence (max 15 words) confirming you understood their request. "
                                    "Be specific — if they mentioned a target score, reference it. "
                                    "If they mentioned a specific role or company, reference it. "
                                    "Sound like a sharp, friendly recruiter, not a bot. "
                                    "Examples: "
                                    "'On it — I'll tailor your resume to push past 90 for this role.' "
                                    "'Got it — generating a version targeted at the Meta Research Engineer role.' "
                                    "'Sure — I'll optimize your resume for a stronger match on this one.' "
                                    "Return ONLY the sentence. No quotes, no preamble."
                                ),
                            },
                            {"role": "user", "content": text[:300]},
                        ],
                        "temperature": 0.4,
                        "max_tokens": 40,
                    },
                    timeout=6.0,
                )
                _tailor_reply = _reply_res.json()["choices"][0]["message"]["content"].strip().strip('"')
            except Exception:
                pass  # fallback reply already set above

            return ChatResponse(
                tool="route_to_tailor", intent="JD",
                params={"jd_text": tool_params.get("jd_text") or None},
                reply=_tailor_reply,
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
            # Imperative apply intent → BATCH auto-apply (headless Phase 1).
            # The frontend resolves WHICH jobs — mapping job_indices against the
            # job table it is currently displaying, or letting the server pick
            # recent matches — then calls POST /api/apply/batch. That endpoint
            # is the single entry point for batch creation; no logic duplicated
            # here. Steel watch mode remains exclusive to the per-job Apply
            # button in the chat job table.
            # Anonymous users have no matched jobs to batch → Tracking CTA
            # (which sign-in gates them).
            _is_uuid_user = False
            if user_id:
                try:
                    import uuid as _uuid_chk
                    _uuid_chk.UUID(user_id)
                    _is_uuid_user = True
                except (ValueError, AttributeError, TypeError):
                    pass
            if _is_uuid_user:
                _b_limit = tool_params.get("limit")
                try:
                    _b_limit = max(1, min(int(_b_limit), 10)) if _b_limit else None
                except (TypeError, ValueError):
                    _b_limit = None
                return ChatResponse(
                    tool="start_batch_apply", intent="APPLY",
                    params={
                        "apply_all":   bool(tool_params.get("apply_all", False)),
                        "job_indices": tool_params.get("job_indices") or [],
                        "limit":       _b_limit,
                    },
                )
            return ChatResponse(tool="route_to_apply", intent="APPLY", apply_jobs=[])

        if selected_tool == "route_off_topic":
            # Generate a warm, natural reply using the LLM instead of a hardcoded string.
            # This lets casual greetings ("hey", "what's up") get a personal response
            # and redirects off-topic questions conversationally, not robotically.
            _off_topic_reply = "Hey! I'm RACK — here to help you land your next job. Paste a job description and I'll rank your resumes against it, or ask me anything about your job search."
            try:
                _ot_res = await client.post(
                    "https://api.openai.com/v1/chat/completions",
                    headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                    json={
                        "model": "gpt-4o-mini",
                        "messages": [
                            {
                                "role": "system",
                                "content": (
                                    "You are RACK, an AI-powered resume matching and job search assistant. "
                                    "The user sent you a casual message or something off-topic. "
                                    "Respond naturally and warmly in 1-2 sentences. "
                                    "If it's a greeting, greet them back and briefly mention what you can do for them. "
                                    "If it's genuinely off-topic (weather, cooking, etc.), gently redirect to how you can help with their job search. "
                                    "Sound like a friendly, sharp recruiter — not a bot reciting a script. "
                                    "Never start with 'Certainly!', 'Great!', or similar filler. "
                                    "Return ONLY the response text, no quotes, no preamble."
                                ),
                            },
                            {"role": "user", "content": text[:300]},
                        ],
                        "temperature": 0.6,
                        "max_tokens": 80,
                    },
                    timeout=8.0,
                )
                _ot_text = _ot_res.json()["choices"][0]["message"]["content"].strip().strip('"')
                if _ot_text:
                    _off_topic_reply = _ot_text
            except Exception:
                pass  # fallback reply already set above

            return ChatResponse(
                tool="route_off_topic", intent="OFF_TOPIC",
                reply=_off_topic_reply,
            )

        # show_user_resumes — fetch resume list and return structured cards
        if selected_tool == "show_user_resumes":
            resumes_data = await _execute_tool("get_user_resumes", {}, user_id, db)
            resumes_parsed = _json.loads(resumes_data)
            resumes_list = resumes_parsed.get("resumes", [])
            if resumes_list:
                return ChatResponse(
                    tool="show_user_resumes", intent="RESUME_LIST",
                    resumes=resumes_list,
                    reply=f"You have {len(resumes_list)} resume{'s' if len(resumes_list) != 1 else ''} uploaded.",
                )
            # No resumes — fall through to career question so LLM can guide them
            selected_tool = "answer_career_question"

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

            # Fetch user's display_name for personalized greeting
            _display_name = None
            if user_id:
                try:
                    from models.orm import User as _User
                    import uuid as _uuid_m
                    _u = await db.execute(_select(_User).where(_User.id == _uuid_m.UUID(user_id)))
                    _user_row = _u.scalar_one_or_none()
                    if _user_row:
                        _display_name = (_user_row.display_name or "").split()[0] or None
                except Exception:
                    pass

            if jobs_list:
                # Label reflects what the user asked for, not the internal sort.
                # (The view defaults to recency under the hood, but a bare "all
                # matched jobs" should still read "All matched jobs", while an
                # explicit "recently matched" reads "Newly matched jobs".)
                _explicit_recency = any(kw in _txt_lower for kw in _RECENCY_KEYWORDS)
                if hours > 0:
                    label = (f"Jobs matched in the past hour" if hours == 1
                             else f"Jobs matched in the past {hours}h" if hours <= 24
                             else f"Jobs matched in the past {hours // 24} day{'s' if hours // 24 != 1 else ''}")
                elif sort_by == "recent" and _explicit_recency:
                    label = "Newly matched jobs"
                elif min_score >= 85:
                    label = "85%+ match jobs"
                elif min_score >= 75:
                    label = "75%+ match jobs"
                elif min_score > 0:
                    label = f"{min_score}%+ match jobs"
                else:
                    label = f"Top {limit} matched jobs" if limit < 20 else "All matched jobs"

                # Build the intro shown above the job table.
                # A deterministic fallback is set FIRST so there is ALWAYS an intro
                # line, even if the LLM enhancement below fails or times out. The LLM
                # call overwrites it with a warmer, personalized version on success.
                top_job = jobs_list[0] if jobs_list else None
                _nm = f" {_display_name}" if _display_name else ""
                if top_job:
                    if sort_by == "recent" or hours > 0:
                        _intro_reply = (
                            f"Sure{_nm} — here are your matched jobs, newest first. "
                            f"The most recent is {top_job['job_title']} at {top_job['company']}, a {top_job['score']}% match."
                        )
                    else:
                        _intro_reply = (
                            f"Sure{_nm} — here are your strongest matches by score. "
                            f"Top of the list is {top_job['job_title']} at {top_job['company']}, a {top_job['score']}% match."
                        )
                else:
                    _intro_reply = f"Here are your matched jobs{_nm}."
                try:
                    from datetime import datetime as _dt, timezone as _tz, timedelta as _td

                    # Find fresh jobs (posted within last 48h) regardless of sort mode.
                    # Urgency is about the POSTING being active, so key off posted_at
                    # (matched_at only as fallback) — same recency signal as the sort.
                    _now = _dt.now(_tz.utc)
                    _fresh_jobs = []
                    for _j in jobs_list:
                        _mat = _j.get("posted_at") or _j.get("matched_at")
                        if _mat:
                            try:
                                _mat_dt = _dt.fromisoformat(_mat.replace("Z", "+00:00"))
                                if (_now - _mat_dt) <= _td(hours=48):
                                    _fresh_jobs.append(_j)
                            except Exception:
                                pass

                    _has_fresh = len(_fresh_jobs) > 0
                    _sorted_recent = sort_by == "recent" or hours > 0

                    if _sorted_recent and _has_fresh:
                        # Newest-first AND there are genuinely fresh postings → urgency is real.
                        _newest = _fresh_jobs[0]
                        _top_part = (
                            f" The newest is **{_newest['job_title']} at {_newest['company']}** ({_newest['score']}% match) — {len(_fresh_jobs)} of these went up in the last 48 hours, so apply soon while they're live."
                        )
                        _window_phrase = f"from the past {hours}h" if hours and hours > 0 else "newest first"
                        _context_hint = (
                            f"The user is viewing their matched jobs sorted by posting date ({_window_phrase}). "
                            f"{len(_fresh_jobs)} were posted in the last 48 hours. Emphasize that these are fresh and worth applying to soon."
                        )
                    elif _sorted_recent:
                        # Newest-first but nothing is brand new → present honestly, no fake urgency.
                        _top_part = (
                            f" The most recently posted is **{top_job['job_title']} at {top_job['company']}** ({top_job['score']}% match)."
                            if top_job else ""
                        )
                        _window_phrase = f"posted within the past {hours}h" if hours and hours > 0 else "ordered newest first"
                        _context_hint = (
                            f"The user is viewing their matched jobs {_window_phrase}. "
                            f"Nothing was posted in the last 48 hours, so do NOT claim these are brand new or urgent. "
                            f"Just introduce them warmly as their most recent matches and mention the top one."
                        )
                    else:
                        # Score-sorted — best matches first.
                        _top_part = (
                            f" The top pick is **{top_job['job_title']} at {top_job['company']}** ({top_job['score']}% match) — it lines up really well with your profile."
                            if top_job else ""
                        )
                        _context_hint = "The user asked for their best/top matched jobs (sorted by score). Mention the top match and express genuine enthusiasm. Do not imply these are new postings."

                    _intro_prompt = (
                        f"You are RACK's job search assistant. {_context_hint} "
                        f"I found {len(jobs_list)} job{'s' if len(jobs_list) != 1 else ''} for them. "
                        f"{_top_part} "
                        f"Write 1-2 warm, personal sentences to introduce these results. "
                        f"Address them by first name if available: {_display_name or 'not available'}. "
                        f"Sound like a recruiter friend, not a bot. No hyphens or dashes between sentences. "
                        f"Return ONLY the sentences, no preamble, no quotes."
                    )
                    _intro_res = await client.post(
                        "https://api.openai.com/v1/chat/completions",
                        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                        json={
                            "model": "gpt-4o-mini",
                            "messages": [{"role": "user", "content": _intro_prompt}],
                            "temperature": 0.6,
                            "max_tokens": 80,
                        },
                        timeout=6.0,
                    )
                    _llm_intro = _intro_res.json()["choices"][0]["message"]["content"].strip().strip('"').replace("**", "")
                    if _llm_intro:
                        _intro_reply = _llm_intro
                except Exception:
                    pass

                return ChatResponse(
                    tool="show_matched_jobs", intent="FILTER_RESULT",
                    jobs=jobs_list, filter_label=label,
                    reply=_intro_reply,  # personal intro shown above the job table
                    sort_by=("recent" if (sort_by == "recent" or hours > 0) else "score"),
                )
            # No rows — fall through to career question answering so LLM can explain
            selected_tool = "answer_career_question"

        # answer_career_question — tool-calling loop with DB tools
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

        # If the career LLM returned the apply-redirect token, surface the Tracking CTA
        if reply.strip().startswith("REDIRECT_TO_TRACKING"):
            return ChatResponse(tool="route_to_apply", intent="APPLY", apply_jobs=[])

        return ChatResponse(tool="answer_career_question", intent="CAREER_QUESTION", reply=reply)


# ══════════════════════════════════════════════════════════════════════════════
# POST /api/match/onboarding — Instant match trigger (fire-and-forget)
#
# Called by Onboarding.jsx right after resume upload fires.
# Runs run_instant_match() as a FastAPI BackgroundTask so this endpoint
# returns { status: "queued" } immediately (< 50ms).
#
# The actual pgvector search runs in the background (~5–15s).
# Dashboard fetches auto_match_results on mount — results will be ready.
#
# Auth: required (authenticated users only — instant match needs DB resumes).
# ══════════════════════════════════════════════════════════════════════════════

from fastapi import BackgroundTasks
from fastapi.security import HTTPBearer as _OBBearer, HTTPAuthorizationCredentials as _OBCreds
from typing import Optional as _Opt

_ob_bearer = _OBBearer(auto_error=False)

import logging as _ob_log
_onboarding_log = _ob_log.getLogger(__name__)


async def _run_instant_match_bg(user_id: str) -> None:
    """
    BackgroundTask wrapper: opens its own DB session and calls run_instant_match.
    Isolated from the request session so the response can return before this finishes.
    """
    from db.database import AsyncSessionLocal
    from services.instant_match import run_instant_match

    _onboarding_log.info(f"[OnboardingMatch] Background task started for user={user_id}")
    try:
        async with AsyncSessionLocal() as bg_db:
            result = await run_instant_match(user_id=user_id, db=bg_db)
        _onboarding_log.info(f"[OnboardingMatch] Complete for user={user_id}: {result}")
    except Exception as e:
        _onboarding_log.error(f"[OnboardingMatch] Failed for user={user_id}: {e}", exc_info=True)


@router.post("/onboarding")
async def trigger_onboarding_match(
    background_tasks: BackgroundTasks,
    credentials: _Opt[_OBCreds] = Depends(_ob_bearer),
    db: AsyncSession = Depends(get_db),
):
    """
    Kick off instant match for a newly onboarded user.

    Returns immediately with { status: "queued" }.
    The actual pgvector search runs as a background task.

    Frontend (Onboarding.jsx) calls this right after resume upload fires.
    Dashboard picks up the results when it mounts — they'll be ready.
    """
    from routers.auth import get_current_user as _get_current_user

    # Require a valid JWT — instant match only works for authenticated users
    # (needs resume_embedding from the DB resumes table).
    if not credentials or not credentials.credentials:
        raise HTTPException(status_code=401, detail="Authentication required.")

    try:
        current_user = await _get_current_user(credentials=credentials, db=db)
    except HTTPException:
        raise HTTPException(status_code=401, detail="Invalid or expired token.")

    user_id = str(current_user.id)
    background_tasks.add_task(_run_instant_match_bg, user_id)

    _onboarding_log.info(f"[OnboardingMatch] Queued for user={user_id}")
    return {"status": "queued", "user_id": user_id}