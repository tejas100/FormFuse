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

class ChatResponse(BaseModel):
    intent: str                         # "JD" | "CAREER_QUESTION" | "OFF_TOPIC" | "FILTER_RESULT"
    reply: Optional[str] = None         # populated for CAREER_QUESTION and OFF_TOPIC
    jobs: Optional[list] = None         # populated for FILTER_RESULT
    filter_label: Optional[str] = None  # human-readable label for the table header


# ── Classifier prompt ─────────────────────────────────────────────────────────
_CLASSIFIER_SYSTEM = """You classify user input for a job search assistant app called RACK.
Reply with ONLY one word — exactly one of: JD, CAREER_QUESTION, or OFF_TOPIC. Nothing else.

JD = a job description or job posting (has role title, responsibilities, requirements — typically structured job content)
CAREER_QUESTION = a question or request about careers, resumes, job searching, interviews, skills, salary, or professional development
OFF_TOPIC = anything not related to jobs, careers, or resumes (greetings, random text, general trivia, gibberish, nonsense)"""


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


async def _tool_get_matched_jobs(user_uuid, db, min_score: int = 0, limit: int = 5, sort_by: str = "score") -> dict:
    limit = min(max(1, limit), 20)
    query = (
        _select(_AutoMatchResult)
        .where(_AutoMatchResult.user_id == user_uuid, _AutoMatchResult.score >= min_score)
    )
    query = query.order_by(
        _AutoMatchResult.posted_at.desc().nullslast()
        if sort_by == "recent"
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
                "url":                (r.job_data or {}).get("url", ""),
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
    Triage user input, then answer career questions using real DB data via tools.
    Auth'd users get data-driven answers. Anonymous users get generic advice.
    """
    text = request.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Text cannot be empty")

    api_key = _os.environ.get("OPENAI_API_KEY")
    if not api_key:
        return ChatResponse(intent="JD", reply=None)

    # Resolve user_id from JWT if present
    user_id: Optional[str] = None
    if credentials and credentials.credentials:
        try:
            from routers.auth import _verify_token
            payload = _verify_token(credentials.credentials)
            user_id = payload.get("sub")
        except Exception:
            pass

    async with _httpx.AsyncClient() as client:

        # Step 1: Classify
        try:
            clf_res = await client.post(
                "https://api.openai.com/v1/chat/completions",
                headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                json={
                    "model": "gpt-4o-mini",
                    "messages": [
                        {"role": "system", "content": _CLASSIFIER_SYSTEM},
                        {"role": "user",   "content": f"Classify this input:\n\n{text[:1000]}"},
                    ],
                    "max_tokens": 5,
                    "temperature": 0.0,
                },
                timeout=10.0,
            )
            raw = clf_res.json()["choices"][0]["message"]["content"].strip().upper()
            intent = "CAREER_QUESTION" if "CAREER" in raw else "OFF_TOPIC" if ("OFF" in raw or "TOPIC" in raw) else "JD"
        except Exception:
            intent = "JD"

        # Step 2: OFF_TOPIC — instant redirect
        if intent == "OFF_TOPIC":
            return ChatResponse(
                intent="OFF_TOPIC",
                reply="I'm built to help you land your next job — paste a job description and I'll instantly rank your resumes, or ask me anything about your job search, resume, or interview prep.",
            )

        # Step 3: JD — tell frontend to run the match pipeline
        if intent == "JD":
            return ChatResponse(intent="JD", reply=None)

        # Step 4: CAREER_QUESTION — tool-calling loop
        messages = [
            {"role": "system", "content": _CAREER_SYSTEM},
            {"role": "user",   "content": text},
        ]

        # Round 1: LLM decides which tools it needs
        try:
            first_res = await client.post(
                "https://api.openai.com/v1/chat/completions",
                headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                json={
                    "model": "gpt-4o-mini",
                    "messages": messages,
                    "tools": _TOOLS,
                    "tool_choice": "auto",
                    "max_tokens": 500,
                    "temperature": 0.4,
                },
                timeout=15.0,
            )
            first_data = first_res.json()
            assistant_msg = first_data["choices"][0]["message"]
            tool_calls = assistant_msg.get("tool_calls") or []
        except Exception as e:
            _chat_log.warning(f"[chat] First LLM call failed: {e}")
            return ChatResponse(intent="CAREER_QUESTION", reply="I ran into an issue. Try again in a moment.")

        if tool_calls:
            # Append assistant turn with tool_calls
            messages.append({
                "role": "assistant",
                "content": assistant_msg.get("content"),
                "tool_calls": tool_calls,
            })

            # Execute each requested tool and feed results back
            tool_results_map = {}  # fn_name → parsed result dict
            for tc in tool_calls:
                fn_name = tc["function"]["name"]
                try:
                    fn_args = _json.loads(tc["function"].get("arguments", "{}"))
                except _json.JSONDecodeError:
                    fn_args = {}

                tool_result_str = await _execute_tool(fn_name, fn_args, user_id, db)
                _chat_log.info(f"[chat] Tool {fn_name} called for user={user_id}")
                tool_results_map[fn_name] = _json.loads(tool_result_str)

                messages.append({
                    "role": "tool",
                    "tool_call_id": tc["id"],
                    "content": tool_result_str,
                })

            # ── FILTER_RESULT shortcut ────────────────────────────────────────
            # If get_matched_jobs was called and returned rows, skip Round 2 —
            # return structured data so the frontend renders the paginated table.
            if "get_matched_jobs" in tool_results_map:
                jobs_data = tool_results_map["get_matched_jobs"]
                jobs_list = jobs_data.get("jobs", [])
                if jobs_list:
                    jobs_tc_args = {}
                    for tc in tool_calls:
                        if tc["function"]["name"] == "get_matched_jobs":
                            try:
                                jobs_tc_args = _json.loads(tc["function"].get("arguments", "{}"))
                            except _json.JSONDecodeError:
                                pass
                    min_score = int(jobs_tc_args.get("min_score", 0))
                    limit     = int(jobs_tc_args.get("limit", 5))
                    sort_by   = jobs_tc_args.get("sort_by", "score")
                    if sort_by == "recent":
                        label = "Newly matched jobs"
                    elif min_score >= 85:
                        label = "85%+ match jobs"
                    elif min_score >= 75:
                        label = "75%+ match jobs"
                    elif min_score > 0:
                        label = f"{min_score}%+ match jobs"
                    else:
                        label = f"Top {limit} matched jobs" if limit < 20 else "All matched jobs"
                    return ChatResponse(intent="FILTER_RESULT", jobs=jobs_list, filter_label=label)
                # No rows → fall through to Round 2 so LLM explains why

            # Round 2: LLM answers with the real data
            try:
                second_res = await client.post(
                    "https://api.openai.com/v1/chat/completions",
                    headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                    json={
                        "model": "gpt-4o-mini",
                        "messages": messages,
                        "max_tokens": 600,
                        "temperature": 0.4,
                    },
                    timeout=15.0,
                )
                reply = second_res.json()["choices"][0]["message"]["content"].strip()
            except Exception as e:
                _chat_log.warning(f"[chat] Second LLM call failed: {e}")
                reply = "I ran into an issue fetching your data. Try again in a moment."
        else:
            # No tools needed — LLM answered directly (generic career advice)
            reply = assistant_msg.get("content", "").strip()
            if not reply:
                reply = "Ask me anything about your job search, resume strategy, or interview prep."

        return ChatResponse(intent="CAREER_QUESTION", reply=reply)