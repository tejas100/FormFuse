"""
routers/admin.py — RACK Admin Dashboard

SECURITY MODEL:
  - HTTP Basic Auth with a secret password from ADMIN_SECRET env var
  - Middleware blocks all non-localhost requests at the IP level BEFORE auth
  - Server-rendered HTML — zero JS bundle exposure, nothing in the React app
  - No JWT, no Supabase session — completely independent auth surface
  - Access: http://localhost:8000/admin only (never exposed to public internet)

FEATURES:
  - User list: email, role, is_restricted, resume count, match count, joined date
  - Role control: promote to pro/admin, demote to free
  - Restrict/unrestrict: hard-limit a user regardless of their role
  - Stats: total users, total resumes, total matches today
  - Your account (ADMIN_USER_ID) is permanently admin — cannot be demoted via UI

SETUP:
  Add to backend/.env:
    ADMIN_SECRET=choose_a_strong_password_here
    ADMIN_USER_ID=de66f6db-4081-4bf3-a646-1ba6acb0e134

  Then visit: http://localhost:8000/admin
  Username: admin
  Password: whatever you set in ADMIN_SECRET
"""

import os
import secrets
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Form, HTTPException, Request, Response
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.security import HTTPBasic, HTTPBasicCredentials
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from db.database import get_db
from models.orm import AutoMatchResult, Resume, User

router = APIRouter(prefix="/admin", tags=["admin"])
security = HTTPBasic()

# ── Constants ─────────────────────────────────────────────────────────────────
ADMIN_SECRET = os.getenv("ADMIN_SECRET", "")
ADMIN_USER_ID = os.getenv("ADMIN_USER_ID", "de66f6db-4081-4bf3-a646-1ba6acb0e134")

# Roles available — order matters (displayed in dropdowns)
ROLES = ["free", "pro", "admin"]

# ── Security helpers ──────────────────────────────────────────────────────────

def _check_localhost(request: Request) -> None:
    """Block all non-localhost requests before any auth is checked."""
    client_host = request.client.host if request.client else ""
    allowed = {"127.0.0.1", "::1", "localhost"}
    if client_host not in allowed:
        # Return 404 — don't even hint that this route exists
        raise HTTPException(status_code=404, detail="Not found")


def _check_auth(credentials: HTTPBasicCredentials = Depends(security)) -> None:
    """Verify HTTP Basic Auth password against ADMIN_SECRET."""
    if not ADMIN_SECRET:
        raise HTTPException(
            status_code=503,
            detail="Admin panel not configured. Set ADMIN_SECRET in .env",
        )
    # Use secrets.compare_digest to prevent timing attacks
    correct_user = secrets.compare_digest(credentials.username.encode(), b"admin")
    correct_pass = secrets.compare_digest(
        credentials.password.encode(), ADMIN_SECRET.encode()
    )
    if not (correct_user and correct_pass):
        raise HTTPException(
            status_code=401,
            detail="Incorrect credentials",
            headers={"WWW-Authenticate": "Basic realm='RACK Admin'"},
        )


# Combined dependency — runs localhost check THEN auth
def _admin_deps(request: Request, _: None = Depends(_check_auth)) -> None:
    _check_localhost(request)


# ── HTML shell ────────────────────────────────────────────────────────────────

def _html_page(title: str, body: str) -> str:
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>RACK Admin — {title}</title>
  <style>
    *, *::before, *::after {{ box-sizing: border-box; margin: 0; padding: 0; }}

    :root {{
      --bg:       #0d0d0d;
      --surface:  #161616;
      --border:   #2a2a2a;
      --text:     #e8e8e8;
      --muted:    #666;
      --accent:   #e8ff6b;
      --red:      #ff5f5f;
      --green:    #5fff8a;
      --blue:     #5fb3ff;
    }}

    body {{
      background: var(--bg);
      color: var(--text);
      font-family: 'SF Mono', 'Fira Code', monospace;
      font-size: 13px;
      line-height: 1.6;
      padding: 32px;
    }}

    h1 {{
      font-size: 22px;
      font-weight: 700;
      color: var(--accent);
      margin-bottom: 4px;
      letter-spacing: -0.5px;
    }}

    .subtitle {{
      color: var(--muted);
      font-size: 11px;
      margin-bottom: 32px;
    }}

    .stats-row {{
      display: flex;
      gap: 16px;
      margin-bottom: 32px;
      flex-wrap: wrap;
    }}

    .stat-card {{
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 16px 24px;
      min-width: 140px;
    }}

    .stat-card .num {{
      font-size: 28px;
      font-weight: 700;
      color: var(--accent);
      display: block;
    }}

    .stat-card .label {{
      font-size: 11px;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }}

    table {{
      width: 100%;
      border-collapse: collapse;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      overflow: hidden;
    }}

    th {{
      background: #1e1e1e;
      color: var(--muted);
      text-transform: uppercase;
      font-size: 10px;
      letter-spacing: 0.8px;
      padding: 10px 14px;
      text-align: left;
      border-bottom: 1px solid var(--border);
    }}

    td {{
      padding: 10px 14px;
      border-bottom: 1px solid #1a1a1a;
      vertical-align: middle;
    }}

    tr:last-child td {{ border-bottom: none; }}
    tr:hover td {{ background: #1a1a1a; }}

    .badge {{
      display: inline-block;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.5px;
      text-transform: uppercase;
    }}

    .badge-admin   {{ background: #2a1f00; color: var(--accent); border: 1px solid #4a3800; }}
    .badge-pro     {{ background: #001f2a; color: var(--blue);   border: 1px solid #00384a; }}
    .badge-free    {{ background: #1a1a1a; color: var(--muted);  border: 1px solid var(--border); }}
    .badge-locked  {{ background: #2a0000; color: var(--red);    border: 1px solid #4a0000; }}
    .badge-you     {{ background: #1a2a00; color: var(--green);  border: 1px solid #2a4a00; }}

    select {{
      background: #1e1e1e;
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 4px 8px;
      font-family: inherit;
      font-size: 12px;
      cursor: pointer;
    }}

    select:focus {{ outline: 1px solid var(--accent); }}

    button, .btn {{
      background: transparent;
      border: 1px solid var(--border);
      color: var(--text);
      padding: 4px 12px;
      border-radius: 4px;
      font-family: inherit;
      font-size: 12px;
      cursor: pointer;
      transition: all 0.15s;
    }}

    button:hover {{ border-color: var(--accent); color: var(--accent); }}

    .btn-danger {{ border-color: #4a0000; color: var(--red); }}
    .btn-danger:hover {{ background: #2a0000; }}

    .btn-safe {{ border-color: #004a00; color: var(--green); }}
    .btn-safe:hover {{ background: #002a00; }}

    .btn-primary {{
      background: var(--accent);
      color: #000;
      border-color: var(--accent);
      font-weight: 700;
    }}
    .btn-primary:hover {{ opacity: 0.85; }}

    form {{ display: inline; }}

    .flash {{
      background: #1a2a00;
      border: 1px solid #2a4a00;
      color: var(--green);
      padding: 10px 16px;
      border-radius: 6px;
      margin-bottom: 24px;
      font-size: 12px;
    }}

    .flash.error {{
      background: #2a0000;
      border-color: #4a0000;
      color: var(--red);
    }}

    .email {{ color: var(--text); max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }}
    .muted  {{ color: var(--muted); }}
    .mono   {{ font-family: 'SF Mono', monospace; font-size: 11px; color: var(--muted); }}
    .section-title {{
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.8px;
      color: var(--muted);
      margin-bottom: 12px;
    }}

    /* ── Scoring audit page ─────────────────────── */
    .audit-filters {{
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      margin-bottom: 20px;
      align-items: center;
    }}
    .audit-filters input[type="text"] {{
      background: #1e1e1e;
      border: 1px solid var(--border);
      border-radius: 4px;
      color: var(--text);
      font-family: inherit;
      font-size: 12px;
      padding: 5px 10px;
      width: 260px;
    }}
    .audit-filters input[type="text"]:focus {{ outline: 1px solid var(--accent); }}
    .score-cell {{ text-align: right; font-variant-numeric: tabular-nums; }}
    .bar-wrap {{ display: flex; align-items: center; gap: 6px; justify-content: flex-end; }}
    .bar {{ height: 3px; border-radius: 2px; min-width: 2px; }}
    .pill-strong {{ color: var(--green);  font-size: 10px; font-weight: 700; }}
    .pill-good   {{ color: var(--blue);   font-size: 10px; font-weight: 700; }}
    .pill-partial {{ color: #ffaa33;      font-size: 10px; font-weight: 700; }}
    .pill-weak   {{ color: var(--red);    font-size: 10px; font-weight: 700; }}
    .mgmt-flag   {{ color: #ff88cc; font-size: 10px; margin-left: 4px; }}
    .dropped-row td {{ opacity: 0.45; }}
    details summary {{ cursor: pointer; list-style: none; }}
    details summary::-webkit-details-marker {{ display: none; }}
    .reasoning-box {{
      background: #111;
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 10px 14px;
      font-size: 11px;
      line-height: 1.7;
      color: #aaa;
      margin-top: 6px;
      max-width: 700px;
    }}
    .comp-row {{ display: flex; gap: 16px; margin-top: 6px; font-size: 11px; }}
    .comp-item span:first-child {{ color: var(--muted); }}
    .alert-banner {{
      background: #2a1000;
      border: 1px solid #7a3000;
      border-radius: 6px;
      color: #ffaa33;
      font-size: 12px;
      padding: 10px 16px;
      margin-bottom: 20px;
    }}
  </style>
</head>
<body>
  <h1>⚡ RACK Admin</h1>
  <p class="subtitle">localhost only · {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}</p>
  <nav style="margin-bottom:24px;display:flex;gap:12px;font-size:11px;">
    <a href="/admin" style="color:var(--accent);text-decoration:none;">Dashboard</a>
    <span style="color:var(--muted);">·</span>
    <a href="/admin/scoring-audit" style="color:var(--muted);text-decoration:none;">Scoring Audit</a>
  </nav>
  {body}
</body>
</html>"""


# ── Stats query ───────────────────────────────────────────────────────────────

async def _get_stats(db: AsyncSession) -> dict:
    total_users   = (await db.execute(select(func.count()).select_from(User))).scalar() or 0
    total_resumes = (await db.execute(select(func.count()).select_from(Resume))).scalar() or 0
    total_matches = (await db.execute(select(func.count()).select_from(AutoMatchResult))).scalar() or 0
    pro_count     = (await db.execute(
        select(func.count()).select_from(User).where(User.role == "pro")
    )).scalar() or 0
    admin_count   = (await db.execute(
        select(func.count()).select_from(User).where(User.role == "admin")
    )).scalar() or 0
    restricted    = (await db.execute(
        select(func.count()).select_from(User).where(User.is_restricted == True)
    )).scalar() or 0

    return {
        "total_users":   total_users,
        "total_resumes": total_resumes,
        "total_matches": total_matches,
        "pro_count":     pro_count,
        "admin_count":   admin_count,
        "restricted":    restricted,
    }


async def _get_users(db: AsyncSession) -> list[dict]:
    """Return all users with resume + match counts."""
    rows = await db.execute(
        text("""
            SELECT
                u.id::text,
                u.email,
                u.display_name,
                u.role,
                u.is_restricted,
                u.created_at,
                COUNT(DISTINCT r.id)   AS resume_count,
                COUNT(DISTINCT a.id)   AS match_count
            FROM users u
            LEFT JOIN resumes r           ON r.user_id = u.id
            LEFT JOIN auto_match_results a ON a.user_id = u.id
            GROUP BY u.id, u.email, u.display_name, u.role, u.is_restricted, u.created_at
            ORDER BY u.created_at DESC
        """)
    )
    return [dict(r._mapping) for r in rows]


# ── Routes ─────────────────────────────────────────────────────────────────────

@router.get("", response_class=HTMLResponse)
@router.get("/", response_class=HTMLResponse)
async def admin_dashboard(
    request: Request,
    db: AsyncSession = Depends(get_db),
    _: None = Depends(_check_auth),
    msg: str = "",
    err: str = "",
):
    _check_localhost(request)

    stats = await _get_stats(db)
    users = await _get_users(db)

    stats_html = f"""
    <div class="stats-row">
      <div class="stat-card">
        <span class="num">{stats['total_users']}</span>
        <span class="label">Total Users</span>
      </div>
      <div class="stat-card">
        <span class="num">{stats['pro_count']}</span>
        <span class="label">Pro</span>
      </div>
      <div class="stat-card">
        <span class="num">{stats['admin_count']}</span>
        <span class="label">Admins</span>
      </div>
      <div class="stat-card">
        <span class="num">{stats['total_resumes']}</span>
        <span class="label">Resumes</span>
      </div>
      <div class="stat-card">
        <span class="num">{stats['total_matches']}</span>
        <span class="label">Total Matches</span>
      </div>
      <div class="stat-card">
        <span class="num" style="color: {'var(--red)' if stats['restricted'] else 'var(--muted)'}">{stats['restricted']}</span>
        <span class="label">Restricted</span>
      </div>
    </div>
    """

    flash = ""
    if msg:
        flash = f'<div class="flash">✓ {msg}</div>'
    if err:
        flash = f'<div class="flash error">✗ {err}</div>'

    rows_html = ""
    for u in users:
        uid       = u["id"]
        email     = u["email"] or "—"
        name      = u["display_name"] or "—"
        role      = u["role"] or "free"
        restricted = u["is_restricted"]
        joined    = u["created_at"].strftime("%Y-%m-%d") if u["created_at"] else "—"
        resumes   = u["resume_count"]
        matches   = u["match_count"]
        is_you    = uid == ADMIN_USER_ID

        role_badge = f'<span class="badge badge-{role}">{role}</span>'
        if is_you:
            role_badge += ' <span class="badge badge-you">YOU</span>'
        if restricted:
            role_badge += ' <span class="badge badge-locked">🔒 restricted</span>'

        # Role selector — disabled for your own account (can't demote yourself)
        role_options = "".join(
            f'<option value="{r}" {"selected" if r == role else ""}>{r}</option>'
            for r in ROLES
        )
        if is_you:
            role_ctrl = f'<span class="muted" title="Cannot change your own role">admin (you)</span>'
        else:
            role_ctrl = f"""
            <form method="POST" action="/admin/users/{uid}/role">
              <select name="role" onchange="this.form.submit()" title="Change role">
                {role_options}
              </select>
            </form>"""

        # Restrict / Unrestrict button — disabled for your own account
        if is_you:
            restrict_ctrl = '<span class="muted">—</span>'
        elif restricted:
            restrict_ctrl = f"""
            <form method="POST" action="/admin/users/{uid}/unrestrict">
              <button class="btn-safe" title="Remove restriction">Unrestrict</button>
            </form>"""
        else:
            restrict_ctrl = f"""
            <form method="POST" action="/admin/users/{uid}/restrict">
              <button class="btn-danger" title="Hard-limit this user">Restrict</button>
            </form>"""

        rows_html += f"""
        <tr>
          <td>
            <div class="email" title="{email}">{email}</div>
            <div class="muted" style="font-size:11px">{name}</div>
          </td>
          <td>{role_badge}</td>
          <td>{role_ctrl}</td>
          <td>{restrict_ctrl}</td>
          <td class="muted">{resumes}</td>
          <td class="muted">{matches}</td>
          <td class="mono">{joined}</td>
          <td class="mono" style="font-size:10px; color:#444" title="{uid}">{uid[:8]}…</td>
        </tr>"""

    table_html = f"""
    <p class="section-title">Users ({len(users)})</p>
    <table>
      <thead>
        <tr>
          <th>Email / Name</th>
          <th>Role</th>
          <th>Change Role</th>
          <th>Restrict</th>
          <th>Resumes</th>
          <th>Matches</th>
          <th>Joined</th>
          <th>ID</th>
        </tr>
      </thead>
      <tbody>
        {rows_html}
      </tbody>
    </table>"""

    body = stats_html + flash + table_html
    return HTMLResponse(_html_page("Dashboard", body))


@router.post("/users/{user_id}/role", response_class=RedirectResponse)
async def set_user_role(
    request: Request,
    user_id: str,
    role: str = Form(...),
    db: AsyncSession = Depends(get_db),
    _: None = Depends(_check_auth),
):
    _check_localhost(request)

    if role not in ROLES:
        return RedirectResponse(url="/admin?err=Invalid+role", status_code=303)

    # Prevent self-demotion
    if user_id == ADMIN_USER_ID:
        return RedirectResponse(url="/admin?err=Cannot+change+your+own+role", status_code=303)

    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        return RedirectResponse(url="/admin?err=User+not+found", status_code=303)

    user.role = role
    await db.commit()

    email_short = (user.email or user_id)[:30]
    return RedirectResponse(
        url=f"/admin?msg={email_short}+set+to+{role}",
        status_code=303,
    )


@router.post("/users/{user_id}/restrict", response_class=RedirectResponse)
async def restrict_user(
    request: Request,
    user_id: str,
    db: AsyncSession = Depends(get_db),
    _: None = Depends(_check_auth),
):
    _check_localhost(request)

    if user_id == ADMIN_USER_ID:
        return RedirectResponse(url="/admin?err=Cannot+restrict+yourself", status_code=303)

    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        return RedirectResponse(url="/admin?err=User+not+found", status_code=303)

    user.is_restricted = True
    await db.commit()
    return RedirectResponse(url=f"/admin?msg={user.email}+restricted", status_code=303)


@router.post("/users/{user_id}/unrestrict", response_class=RedirectResponse)
async def unrestrict_user(
    request: Request,
    user_id: str,
    db: AsyncSession = Depends(get_db),
    _: None = Depends(_check_auth),
):
    _check_localhost(request)

    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        return RedirectResponse(url="/admin?err=User+not+found", status_code=303)

    user.is_restricted = False
    await db.commit()
    return RedirectResponse(url=f"/admin?msg={user.email}+unrestricted", status_code=303)


# ── Scoring Audit ──────────────────────────────────────────────────────────────

def _score_bar_html(score) -> str:
    """Render a score as a number + mini color bar for the audit table."""
    if score is None:
        return '<span class="muted">—</span>'
    score = int(score)
    pct = min(100, max(0, score))
    if pct >= 80:
        color = "var(--green)"
    elif pct >= 65:
        color = "var(--blue)"
    elif pct >= 50:
        color = "#ffaa33"
    else:
        color = "var(--red)"
    return (
        f'<div class="bar-wrap">'
        f'<span>{score}</span>'
        f'<div class="bar" style="width:{max(4, pct // 2)}px;background:{color};"></div>'
        f'</div>'
    )


def _rec_pill_html(rec: str) -> str:
    if rec == "Strong Match":
        return f'<span class="pill-strong">strong</span>'
    if rec == "Good Match":
        return f'<span class="pill-good">good</span>'
    if rec == "Partial Match":
        return f'<span class="pill-partial">partial</span>'
    return f'<span class="pill-weak">weak</span>'


_MGMT_TOKENS = {
    "manager", "tpm", "program manager", "product manager",
    "director", "vp ", "head of",
}


def _is_mgmt_role(title: str) -> bool:
    t = title.lower()
    return any(tok in t for tok in _MGMT_TOKENS)


@router.get("/scoring-audit", response_class=HTMLResponse)
async def scoring_audit_page(
    request: Request,
    user_id: str = ADMIN_USER_ID,
    limit: int = 300,
    filter: str = "",         # "mgmt_high" | "dropped" | ""
    _: None = Depends(_check_auth),
):
    """
    Scoring audit page — shows every LLM-scored job from the last pipeline run
    for a given user, with phase 1 / phase 2 scores, component scores, and
    the LLM's reasoning. Helps diagnose why Manager/PM/TPM roles are scoring high.

    Query params:
      user_id  — UUID of the user to inspect (defaults to ADMIN_USER_ID)
      limit    — max records to load (default 300, newest first)
      filter   — "mgmt_high" shows only mgmt roles ≥70; "dropped" shows only
                 jobs that didn't pass MIN_SCORE; "" shows all
    """
    _check_localhost(request)

    from services.auto_match import get_scoring_audit

    records = get_scoring_audit(user_id, limit=limit)

    # ── Summary stats ──────────────────────────────────────────────────
    total        = len(records)
    passed       = sum(1 for r in records if r.get("passed_min_score"))
    dropped      = total - passed
    avg_p2       = round(sum(r.get("phase2_score", 0) for r in records) / total) if total else 0
    mgmt_high    = [r for r in records if _is_mgmt_role(r.get("job_title", "")) and (r.get("phase2_score") or 0) >= 70]

    # ── Apply filter ───────────────────────────────────────────────────
    if filter == "mgmt_high":
        view_records = mgmt_high
        filter_label = f"management / leadership roles scored ≥ 70 ({len(view_records)})"
    elif filter == "dropped":
        view_records = [r for r in records if not r.get("passed_min_score")]
        filter_label = f"dropped (below MIN_SCORE) ({len(view_records)})"
    else:
        view_records = records
        filter_label = f"all scored jobs ({total})"

    # ── Alert banner ───────────────────────────────────────────────────
    alert_html = ""
    if mgmt_high:
        alert_html = (
            f'<div class="alert-banner">'
            f'⚠  {len(mgmt_high)} management / leadership role(s) scored ≥ 70 — '
            f'these may be false positives. '
            f'<a href="/admin/scoring-audit?user_id={user_id}&filter=mgmt_high" '
            f'style="color:inherit;text-decoration:underline;">View only these →</a>'
            f'</div>'
        )

    # ── Filter bar ─────────────────────────────────────────────────────
    def _flink(label, f):
        active = "color:var(--accent);" if f == filter else ""
        return f'<a href="/admin/scoring-audit?user_id={user_id}&filter={f}" style="color:var(--muted);text-decoration:none;{active}">{label}</a>'

    filter_bar = (
        f'<div class="audit-filters">'
        f'{_flink("All", "")} &nbsp;·&nbsp; '
        f'{_flink("⚠ Mgmt ≥70", "mgmt_high")} &nbsp;·&nbsp; '
        f'{_flink("Dropped", "dropped")}'
        f'<span style="margin-left:auto;color:var(--muted);font-size:11px;">showing {filter_label}</span>'
        f'</div>'
    )

    # ── Stats row ──────────────────────────────────────────────────────
    stats_html = f"""
    <div class="stats-row">
      <div class="stat-card">
        <span class="num">{total}</span>
        <span class="label">Total scored</span>
      </div>
      <div class="stat-card">
        <span class="num" style="color:var(--green)">{passed}</span>
        <span class="label">Passed MIN_SCORE</span>
      </div>
      <div class="stat-card">
        <span class="num" style="color:var(--muted)">{dropped}</span>
        <span class="label">Dropped</span>
      </div>
      <div class="stat-card">
        <span class="num">{avg_p2}</span>
        <span class="label">Avg LLM score</span>
      </div>
      <div class="stat-card" style="{'border-color:#7a3000;' if mgmt_high else ''}">
        <span class="num" style="color:{'#ffaa33' if mgmt_high else 'var(--muted)'}">{len(mgmt_high)}</span>
        <span class="label">Mgmt roles ≥70 ⚠</span>
      </div>
    </div>"""

    # ── User switcher ──────────────────────────────────────────────────
    user_switcher = f"""
    <form method="GET" action="/admin/scoring-audit"
          style="display:flex;gap:8px;align-items:center;margin-bottom:20px;">
      <label style="font-size:11px;color:var(--muted);">User ID</label>
      <input type="text" name="user_id" value="{user_id}"
             style="background:#1e1e1e;border:1px solid var(--border);border-radius:4px;
                    color:var(--text);font-family:inherit;font-size:12px;padding:5px 10px;width:320px;" />
      <input type="hidden" name="limit" value="{limit}" />
      <button type="submit" class="btn-primary">Load</button>
      <span style="font-size:11px;color:var(--muted);">· newest {limit} records</span>
    </form>"""

    # ── Table rows ─────────────────────────────────────────────────────
    if not view_records:
        table_html = '<p class="muted" style="padding:20px 0;">No records match this filter.</p>'
    else:
        rows_html = ""
        for r in view_records:
            title    = r.get("job_title", "—")
            company  = r.get("company", "")
            location = r.get("location", "")
            p1       = r.get("phase1_score")
            p2       = r.get("phase2_score")
            sf       = r.get("skills_fit")
            ef       = r.get("experience_fit")
            evf      = r.get("evidence_fit")
            rec      = r.get("llm_recommendation", "")
            passed_r = r.get("passed_min_score", False)
            method   = r.get("scoring_method", "")
            resume   = r.get("resume_name", "")
            run_at   = r.get("run_at", "")
            reasoning = r.get("llm_reasoning", "").replace("<", "&lt;").replace(">", "&gt;")
            strengths = r.get("key_strengths", [])
            gaps      = r.get("key_gaps", [])
            mgmt_flag = '<span class="mgmt-flag">mgmt</span>' if _is_mgmt_role(title) else ""
            row_class = "" if passed_r else "dropped-row"

            # Expand details via <details>/<summary>
            strengths_html = "".join(f"<li>{s}</li>" for s in strengths) if strengths else ""
            gaps_html      = "".join(f"<li>{g}</li>" for g in gaps) if gaps else ""
            detail_inner   = ""
            if reasoning:
                detail_inner += f'<div class="reasoning-box">{reasoning}</div>'
            if strengths_html or gaps_html:
                detail_inner += f'<div class="comp-row" style="margin-top:8px;">'
                if strengths_html:
                    detail_inner += f'<div><span style="color:var(--green);">+ strengths</span><ul style="margin:4px 0 0 14px;font-size:11px;color:#aaa;">{strengths_html}</ul></div>'
                if gaps_html:
                    detail_inner += f'<div><span style="color:var(--red);">– gaps</span><ul style="margin:4px 0 0 14px;font-size:11px;color:#aaa;">{gaps_html}</ul></div>'
                detail_inner += '</div>'

            detail_html = (
                f'<details><summary style="font-size:10px;color:var(--muted);user-select:none;">'
                f'▶ reasoning</summary>{detail_inner}</details>'
            ) if detail_inner else ""

            run_short = run_at[11:16] + " · " + run_at[:10] if len(run_at) >= 16 else run_at

            rows_html += f"""
            <tr class="{row_class}">
              <td class="mono" style="white-space:nowrap;font-size:10px;">{run_short}</td>
              <td>
                <div>{title}{mgmt_flag}</div>
                <div class="muted" style="font-size:11px;">{company}{' · ' + location if location else ''}</div>
                {detail_html}
              </td>
              <td class="score-cell">{_score_bar_html(p1)}</td>
              <td class="score-cell">{_score_bar_html(p2)}</td>
              <td class="score-cell">{_score_bar_html(sf)}</td>
              <td class="score-cell">{_score_bar_html(ef)}</td>
              <td class="score-cell">{_score_bar_html(evf)}</td>
              <td>{_rec_pill_html(rec)}</td>
              <td style="text-align:center;font-size:14px;">{'<span style="color:var(--green)">✓</span>' if passed_r else '<span style="color:var(--muted)">✗</span>'}</td>
              <td class="muted" style="font-size:10px;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">{resume}</td>
            </tr>"""

        table_html = f"""
        <p class="section-title">Scored jobs — {filter_label}</p>
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Job</th>
              <th>P1</th>
              <th>P2 (LLM)</th>
              <th>Skills</th>
              <th>Exp fit</th>
              <th>Evidence</th>
              <th>Verdict</th>
              <th>Stored</th>
              <th>Resume</th>
            </tr>
          </thead>
          <tbody>{rows_html}</tbody>
        </table>"""

    body = stats_html + alert_html + user_switcher + filter_bar + table_html
    return HTMLResponse(_html_page("Scoring Audit", body))