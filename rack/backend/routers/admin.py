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

import asyncio
import collections as _collections
import logging as _logging
import os
import secrets
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, Depends, Form, HTTPException, Request, Response
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.security import HTTPBasic, HTTPBasicCredentials
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from db.database import get_db
from models.orm import AutoMatchResult, Resume, User

# ── Log file paths (MacBook local only) ───────────────────────────────────────
_BACKEND_DIR = Path(__file__).resolve().parent.parent
_LOG_DIR = _BACKEND_DIR / "logs"
_LOG_FILES = {
    "fetching_stdout": _LOG_DIR / "fetching_stdout.log",
    "fetching_stderr": _LOG_DIR / "fetching_stderr.log",
    "matching_stdout": _LOG_DIR / "matching_stdout.log",
    "matching_stderr": _LOG_DIR / "matching_stderr.log",
}

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

def _html_page(title: str, body: str, page: str = "dashboard") -> str:
    def _nav_link(label: str, href: str, key: str) -> str:
        active = key == page
        color  = "var(--accent)" if active else "var(--muted)"
        weight = "font-weight:700;" if active else ""
        return f'<a href="{href}" style="color:{color};text-decoration:none;{weight}">{label}</a>'

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

    /* ── User detail page ───────────────────── */
    .detail-grid {{
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
      margin-bottom: 28px;
    }}
    .detail-card {{
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 16px 18px;
    }}
    .detail-card h3 {{
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.8px;
      color: var(--muted);
      margin-bottom: 12px;
    }}
    .kv {{ display: flex; justify-content: space-between; padding: 3px 0; border-bottom: 1px solid #1a1a1a; font-size: 12px; }}
    .kv:last-child {{ border-bottom: none; }}
    .kv .k {{ color: var(--muted); }}
    .kv .v {{ color: var(--text); text-align: right; max-width: 55%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }}
    .score-hist {{ display: flex; gap: 10px; align-items: flex-end; height: 60px; padding: 8px 0; }}
    .hist-bar-wrap {{ display: flex; flex-direction: column; align-items: center; gap: 4px; flex: 1; }}
    .hist-bar {{ width: 100%; border-radius: 3px 3px 0 0; min-height: 3px; }}
    .hist-label {{ font-size: 9px; color: var(--muted); }}
    .hist-count {{ font-size: 10px; font-weight: 700; }}
    .tag-list {{ display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }}
    .tag {{ background: #1e1e1e; border: 1px solid var(--border); border-radius: 4px; padding: 2px 8px; font-size: 11px; color: var(--text); }}
    .tag.missing {{ border-color: #4a0000; color: var(--red); font-style: italic; }}

    /* ── Email compose panel ────────────────── */
    .compose-panel {{
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 18px;
      margin-top: 16px;
    }}
    .compose-panel label {{ font-size: 11px; color: var(--muted); display: block; margin-bottom: 4px; margin-top: 10px; }}
    .compose-panel input[type=text],
    .compose-panel textarea {{
      width: 100%;
      background: #111;
      border: 1px solid var(--border);
      border-radius: 4px;
      color: var(--text);
      font-family: inherit;
      font-size: 12px;
      padding: 8px 10px;
    }}
    .compose-panel textarea {{ min-height: 100px; resize: vertical; line-height: 1.6; }}
    .compose-panel input:focus,
    .compose-panel textarea:focus {{ outline: 1px solid var(--accent); }}

    /* ── Log viewer ─────────────────────────── */
    .log-wrap {{
      background: #050505;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 14px 16px;
      overflow-x: auto;
      margin-bottom: 20px;
      max-height: 460px;
      overflow-y: auto;
    }}
    .log-line {{ font-size: 11px; line-height: 1.7; white-space: pre-wrap; word-break: break-all; }}
    .log-error   {{ color: #ff6b6b; }}
    .log-warn    {{ color: #ffcc55; }}
    .log-info    {{ color: #8be8a0; }}
    .log-debug   {{ color: #556677; }}
    .log-default {{ color: #888; }}
    .log-tabs {{ display: flex; gap: 0; margin-bottom: 0; }}
    .log-tab {{
      padding: 6px 16px;
      font-size: 11px;
      cursor: pointer;
      border: 1px solid var(--border);
      border-bottom: none;
      border-radius: 6px 6px 0 0;
      color: var(--muted);
      text-decoration: none;
      background: #0d0d0d;
      margin-right: 2px;
    }}
    .log-tab.active {{ background: #050505; color: var(--accent); border-bottom: 1px solid #050505; }}
    .log-controls {{ display: flex; gap: 10px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }}

    /* ── Pool page ──────────────────────────── */
    .pool-source-row {{ display: flex; align-items: center; gap: 10px; padding: 6px 0; border-bottom: 1px solid #1a1a1a; font-size: 12px; }}
    .pool-source-row:last-child {{ border-bottom: none; }}
    .pool-bar-bg {{ flex: 1; background: #1a1a1a; border-radius: 3px; height: 6px; }}
    .pool-bar-fill {{ height: 6px; border-radius: 3px; background: var(--accent); }}
    .stale-warn {{ color: #ffaa33; }}
  </style>
</head>
<body>
  <h1>⚡ RACK Admin</h1>
  <p class="subtitle">localhost only · {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}</p>
  <nav style="margin-bottom:24px;display:flex;gap:12px;font-size:11px;flex-wrap:wrap;">
    {_nav_link("Dashboard",     "/admin",               "dashboard")}
    <span style="color:var(--muted);">·</span>
    {_nav_link("Scoring Audit", "/admin/scoring-audit", "scoring-audit")}
    <span style="color:var(--muted);">·</span>
    {_nav_link("Job Pool",      "/admin/pool",          "pool")}
    <span style="color:var(--muted);">·</span>
    {_nav_link("Cron Logs",     "/admin/logs",          "logs")}
    <span style="color:var(--muted);">·</span>
    {_nav_link("▶ Run Matching", "/admin/run-matching",  "run-matching")}
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
        <tr style="cursor:pointer;" onclick="location.href='/admin/users/{uid}'">
          <td>
            <div class="email" title="{email}">{email}</div>
            <div class="muted" style="font-size:11px">{name}</div>
          </td>
          <td>{role_badge}</td>
          <td onclick="event.stopPropagation();">{role_ctrl}</td>
          <td onclick="event.stopPropagation();">{restrict_ctrl}</td>
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
    return HTMLResponse(_html_page("Dashboard", body, page="dashboard"))


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



# ── User Detail Page ──────────────────────────────────────────────────────────

@router.get("/users/{user_id}", response_class=HTMLResponse)
async def user_detail(
    request: Request,
    user_id: str,
    db: AsyncSession = Depends(get_db),
    _: None = Depends(_check_auth),
    msg: str = "",
    err: str = "",
):
    _check_localhost(request)

    # Fetch user row
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        return RedirectResponse(url="/admin?err=User+not+found", status_code=303)

    prefs = user.preferences or {}

    # Fetch resumes
    res_rows = await db.execute(
        select(Resume).where(Resume.user_id == user_id).order_by(Resume.uploaded_at.desc())
    )
    resumes = res_rows.scalars().all()

    # Fetch match stats from DB
    match_stats_row = await db.execute(text("""
        SELECT
            COUNT(*)                                                     AS total,
            COUNT(*) FILTER (WHERE score >= 85)                         AS strong,
            COUNT(*) FILTER (WHERE score >= 75 AND score < 85)          AS good,
            COUNT(*) FILTER (WHERE score >= 55 AND score < 75)          AS partial,
            COUNT(*) FILTER (WHERE score < 55)                          AS weak,
            AVG(score)                                                   AS avg_score,
            MAX(matched_at)                                              AS last_matched,
            COUNT(*) FILTER (WHERE applied = true)                      AS applied_count
        FROM auto_match_results
        WHERE user_id = :uid
    """), {"uid": user_id})
    ms = dict(match_stats_row.mappings().one())

    total_m      = ms["total"] or 0
    strong_m     = ms["strong"] or 0
    good_m       = ms["good"] or 0
    partial_m    = ms["partial"] or 0
    weak_m       = ms["weak"] or 0
    avg_score    = round(ms["avg_score"]) if ms["avg_score"] else 0
    last_matched = ms["last_matched"]
    applied_cnt  = ms["applied_count"] or 0

    # Pipeline status
    if last_matched:
        last_matched_str = last_matched.strftime("%Y-%m-%d %H:%M UTC")
        hours_ago = (datetime.now(timezone.utc) - last_matched.replace(tzinfo=timezone.utc)).total_seconds() / 3600
        if hours_ago < 6:
            pipeline_status = f'<span style="color:var(--green)">✓ ran {int(hours_ago)}h ago</span>'
        elif hours_ago < 24:
            pipeline_status = f'<span style="color:#ffaa33">⚠ {int(hours_ago)}h ago</span>'
        else:
            pipeline_status = f'<span style="color:var(--red)">✗ {int(hours_ago / 24)}d ago — stale</span>'
    else:
        last_matched_str = "never"
        pipeline_status = '<span style="color:var(--red)">✗ pipeline has never run</span>'

    # Score histogram bars
    hist_max = max(strong_m, good_m, partial_m, weak_m, 1)
    def _hist_bar(count, color, label):
        pct = int((count / hist_max) * 50)
        return f"""
        <div class="hist-bar-wrap">
          <span class="hist-count" style="color:{color}">{count}</span>
          <div class="hist-bar" style="height:{max(pct,3)}px;background:{color};"></div>
          <span class="hist-label">{label}</span>
        </div>"""

    hist_html = (
        f'<div class="score-hist">'
        + _hist_bar(strong_m,  "var(--green)", "≥85")
        + _hist_bar(good_m,    "var(--blue)",  "75–84")
        + _hist_bar(partial_m, "#ffaa33",      "55–74")
        + _hist_bar(weak_m,    "var(--red)",   "<55")
        + f'</div>'
    )

    # Profile completeness
    def _field(label, val, required=False):
        if val and val != [] and val != "":
            display = ", ".join(val) if isinstance(val, list) else str(val)
            return f'<div class="kv"><span class="k">{label}</span><span class="v" title="{display}">{display}</span></div>'
        cls = "missing" if required else ""
        return f'<div class="kv"><span class="k">{label}</span><span class="v {cls}" style="color:{"var(--red)" if required else "var(--muted)"}">{"⚠ missing" if required else "—"}</span></div>'

    profile_html = (
        _field("target_roles", prefs.get("target_roles", []), required=True)
        + _field("preferred_locations", prefs.get("preferred_locations", []))
        + _field("experience_level", prefs.get("experience_level", ""))
        + _field("current_location", prefs.get("current_location", ""))
        + _field("keywords_include", prefs.get("keywords_include", []))
        + _field("keywords_exclude", prefs.get("keywords_exclude", []))
        + _field("work_authorization", "✓" if prefs.get("authorized_to_work") else "")
        + _field("require_sponsorship", "yes" if prefs.get("require_sponsorship") else "no")
        + _field("linkedin_url", prefs.get("linkedin_url", ""))
        + _field("github_url", prefs.get("github_url", ""))
    )

    # Resume rows
    resume_rows = ""
    for r in resumes:
        skills_preview = ", ".join((r.skills or [])[:6])
        uploaded = r.uploaded_at.strftime("%Y-%m-%d") if r.uploaded_at else "—"
        resume_rows += f"""
        <div class="kv">
          <span class="k" style="max-width:55%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="{r.display_name or r.filename}">{r.display_name or r.filename}</span>
          <span class="v" style="color:var(--muted);font-size:10px;">{r.years_exp or '?'}yr · {uploaded} · {skills_preview or '—'}</span>
        </div>"""
    if not resume_rows:
        resume_rows = '<div class="kv"><span class="k" style="color:var(--red)">⚠ no resumes uploaded</span><span class="v">—</span></div>'

    flash = ""
    if msg:
        flash = f'<div class="flash">✓ {msg}</div>'
    if err:
        flash = f'<div class="flash error">✗ {err}</div>'

    # Email compose form
    email_form = f"""
    <div class="compose-panel">
      <p style="font-size:11px;color:var(--muted);margin-bottom:8px;">Send custom email to <strong style="color:var(--text)">{user.email}</strong> via Resend</p>
      <form method="POST" action="/admin/users/{user_id}/send-email">
        <label>Subject</label>
        <input type="text" name="subject" value="A note from RACK" />
        <label>Body (plain text — supports line breaks)</label>
        <textarea name="body" placeholder="Write your message here..."></textarea>
        <div style="margin-top:10px;">
          <button type="submit" class="btn-primary">Send Email</button>
        </div>
      </form>
    </div>"""

    # Pipeline trigger form
    pipeline_form = f"""
    <form method="POST" action="/admin/users/{user_id}/run-pipeline" style="margin-top:12px;">
      <button type="submit" class="btn-safe">▶ Run Pipeline Now</button>
      <span style="font-size:11px;color:var(--muted);margin-left:8px;">fires in background — refresh in ~60s to see results</span>
    </form>"""

    # Audit shortcut
    audit_link = f'<a href="/admin/scoring-audit?user_id={user_id}" style="color:var(--blue);text-decoration:none;font-size:11px;">→ View full scoring audit for this user</a>'

    body = f"""
    {flash}
    <div style="margin-bottom:20px;display:flex;align-items:baseline;gap:16px;flex-wrap:wrap;">
      <div>
        <div style="font-size:18px;font-weight:700;">{user.display_name or '—'}</div>
        <div style="color:var(--muted);font-size:12px;">{user.email} · <span class="badge badge-{user.role or 'free'}">{user.role or 'free'}</span>
        {'<span class="badge badge-locked" style="margin-left:4px;">restricted</span>' if user.is_restricted else ''}
        </div>
        <div style="font-size:11px;color:var(--muted);margin-top:4px;">joined {user.created_at.strftime('%Y-%m-%d') if user.created_at else '—'} · id: <span class="mono">{user_id}</span></div>
      </div>
      <div style="margin-left:auto;text-align:right;">
        <div style="font-size:11px;color:var(--muted);">pipeline</div>
        <div>{pipeline_status}</div>
        <div style="font-size:10px;color:var(--muted);">{last_matched_str}</div>
      </div>
    </div>

    <div class="detail-grid">
      <div class="detail-card">
        <h3>Match stats</h3>
        <div class="kv"><span class="k">total results</span><span class="v">{total_m}</span></div>
        <div class="kv"><span class="k">avg score</span><span class="v">{avg_score}</span></div>
        <div class="kv"><span class="k">applied</span><span class="v">{applied_cnt}</span></div>
        <div class="kv"><span class="k">score distribution</span><span class="v"></span></div>
        {hist_html}
        <div style="margin-top:12px;display:flex;gap:16px;flex-wrap:wrap;">
          {audit_link}
          <a href="/admin/users/{user_id}/funnel" style="color:var(--accent);text-decoration:none;font-size:11px;font-weight:700;">→ Pipeline funnel breakdown</a>
        </div>
      </div>

      <div class="detail-card">
        <h3>Profile</h3>
        {profile_html}
      </div>

      <div class="detail-card">
        <h3>Resumes ({len(resumes)})</h3>
        {resume_rows}
      </div>

      <div class="detail-card">
        <h3>Pipeline control</h3>
        <div class="kv"><span class="k">last run</span><span class="v">{last_matched_str}</span></div>
        <div class="kv"><span class="k">status</span><span class="v">{pipeline_status}</span></div>
        {pipeline_form}
      </div>
    </div>

    <p class="section-title" style="margin-bottom:8px;">Send email</p>
    {email_form}

    <div style="margin-top:20px;">
      <a href="/admin" style="color:var(--muted);font-size:11px;text-decoration:none;">← Back to dashboard</a>
    </div>
    """

    return HTMLResponse(_html_page(f"User — {user.email}", body, page="dashboard"))


# ── Manual pipeline trigger ───────────────────────────────────────────────────

@router.post("/users/{user_id}/run-pipeline", response_class=RedirectResponse)
async def trigger_pipeline(
    request: Request,
    user_id: str,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    _: None = Depends(_check_auth),
):
    _check_localhost(request)

    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        return RedirectResponse(url=f"/admin/users/{user_id}?err=User+not+found", status_code=303)

    async def _run():
        from services.auto_match import run_pipeline_for_new_user
        await run_pipeline_for_new_user(user_id, force_pool=True)

    background_tasks.add_task(_run)

    email_short = (user.email or user_id)[:40].replace(" ", "+")
    return RedirectResponse(
        url=f"/admin/users/{user_id}?msg=Pipeline+triggered+for+{email_short}+—+refresh+in+60s",
        status_code=303,
    )


# ── Manual email send ─────────────────────────────────────────────────────────

@router.post("/users/{user_id}/send-email", response_class=RedirectResponse)
async def send_admin_email(
    request: Request,
    user_id: str,
    subject: str = Form(...),
    body: str = Form(...),
    db: AsyncSession = Depends(get_db),
    _: None = Depends(_check_auth),
):
    _check_localhost(request)

    import httpx

    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user or not user.email:
        return RedirectResponse(url=f"/admin/users/{user_id}?err=User+not+found+or+no+email", status_code=303)

    RESEND_API_KEY = os.getenv("RESEND_API_KEY", "")
    if not RESEND_API_KEY:
        return RedirectResponse(url=f"/admin/users/{user_id}?err=RESEND_API_KEY+not+set", status_code=303)

    # Convert plain newlines to <br> for HTML email
    body_html = body.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\n", "<br>")

    html_email = f"""
    <div style="background:#0d0d0d;color:#e8e8e8;font-family:Georgia,serif;padding:40px 32px;max-width:560px;margin:0 auto;">
      <div style="color:#e8ff6b;font-size:18px;font-weight:700;margin-bottom:24px;">⚡ RACK</div>
      <div style="font-size:15px;line-height:1.8;color:#d0d0d0;">{body_html}</div>
      <div style="margin-top:36px;font-size:12px;color:#555;border-top:1px solid #222;padding-top:16px;">
        Sent by <a href="https://tejasbk.dev" style="color:#888;text-decoration:none;">Tejas</a>, founder of RACK
      </div>
    </div>"""

    try:
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                "https://api.resend.com/emails",
                headers={"Authorization": f"Bearer {RESEND_API_KEY}", "Content-Type": "application/json"},
                json={
                    "from": "Tejas from RACK <tejas@rackx.app>",
                    "to": [user.email],
                    "subject": subject,
                    "html": html_email,
                    "text": body,
                },
                timeout=10.0,
            )
        if resp.status_code in (200, 201):
            return RedirectResponse(url=f"/admin/users/{user_id}?msg=Email+sent+to+{user.email.replace('@', '%40')}", status_code=303)
        else:
            err_short = resp.text[:80].replace(" ", "+")
            return RedirectResponse(url=f"/admin/users/{user_id}?err=Resend+error:+{err_short}", status_code=303)
    except Exception as e:
        return RedirectResponse(url=f"/admin/users/{user_id}?err={str(e)[:80].replace(' ', '+')}", status_code=303)


# ── Job Pool Health Page ──────────────────────────────────────────────────────

@router.get("/pool", response_class=HTMLResponse)
async def pool_page(
    request: Request,
    db: AsyncSession = Depends(get_db),
    _: None = Depends(_check_auth),
):
    _check_localhost(request)

    try:
        ov_row = await db.execute(text("""
            SELECT
                COUNT(*)                                   AS total,
                COUNT(*) FILTER (WHERE is_active = TRUE)  AS active,
                COUNT(*) FILTER (WHERE is_active = FALSE) AS inactive,
                MAX(fetched_at)                            AS newest_fetch,
                COUNT(DISTINCT source)                     AS sources
            FROM job_pool
        """))
        ov = dict(ov_row.mappings().one())

        src_rows = await db.execute(text("""
            SELECT source,
                   COUNT(*) AS cnt,
                   MAX(fetched_at) AS last_fetch,
                   COUNT(*) FILTER (WHERE posted_at IS NOT NULL) AS dated,
                   AVG(EXTRACT(EPOCH FROM (NOW() - posted_at))/86400)
                       FILTER (WHERE posted_at IS NOT NULL) AS avg_age_days
            FROM job_pool
            WHERE is_active = TRUE
            GROUP BY source
            ORDER BY cnt DESC
        """))
        sources = [dict(r) for r in src_rows.mappings().all()]

        newest_fetch = ov.get("newest_fetch")
        if newest_fetch:
            if newest_fetch.tzinfo is None:
                newest_fetch = newest_fetch.replace(tzinfo=timezone.utc)
            minutes_stale = (datetime.now(timezone.utc) - newest_fetch).total_seconds() / 60
        else:
            minutes_stale = 9999

        error_html = ""
    except Exception as e:
        ov = {}
        sources = []
        minutes_stale = 9999
        error_html = f'<div class="flash error">✗ DB error: {e}</div>'

    total_active = ov.get("active", 0) or 0
    newest_str   = ov.get("newest_fetch", "—")
    if hasattr(newest_str, "strftime"):
        newest_str = newest_str.strftime("%Y-%m-%d %H:%M UTC")

    stale_class = "stale-warn" if minutes_stale > 120 else ""
    stale_label = (
        f'<span class="{stale_class}">{int(minutes_stale)}m ago</span>'
        if minutes_stale < 9999 else
        '<span class="stale-warn">never fetched</span>'
    )

    stats_html = f"""
    <div class="stats-row">
      <div class="stat-card"><span class="num">{ov.get('total',0)}</span><span class="label">Total jobs</span></div>
      <div class="stat-card"><span class="num" style="color:var(--green)">{total_active}</span><span class="label">Active</span></div>
      <div class="stat-card"><span class="num" style="color:var(--muted)">{ov.get('inactive',0)}</span><span class="label">Inactive</span></div>
      <div class="stat-card"><span class="num">{ov.get('sources',0)}</span><span class="label">Sources</span></div>
      <div class="stat-card"><span class="num" style="font-size:14px;">{stale_label}</span><span class="label">Last fetch</span></div>
    </div>"""

    source_rows = ""
    for s in sources:
        cnt      = s["cnt"]
        src      = s["source"] or "unknown"
        last_f   = s["last_fetch"]
        last_str = last_f.strftime("%Y-%m-%d %H:%M") if hasattr(last_f, "strftime") else "—"
        avg_age  = f'{int(s["avg_age_days"])}d' if s.get("avg_age_days") else "—"
        dated_pct = int(s["dated"] / cnt * 100) if cnt else 0
        bar_w    = int(cnt / max(total_active, 1) * 240)

        source_rows += f"""
        <div class="pool-source-row">
          <span style="width:100px;color:var(--text);">{src}</span>
          <div class="pool-bar-bg" style="width:260px;flex:none;">
            <div class="pool-bar-fill" style="width:{bar_w}px;"></div>
          </div>
          <span style="width:50px;text-align:right;font-weight:700;">{cnt}</span>
          <span style="width:50px;text-align:right;color:var(--muted);font-size:11px;">{dated_pct}% dated</span>
          <span style="width:60px;text-align:right;color:var(--muted);font-size:11px;">avg {avg_age}</span>
          <span style="color:var(--muted);font-size:10px;margin-left:auto;">{last_str}</span>
        </div>"""

    pool_card = f"""
    <div class="detail-card" style="max-width:700px;">
      <h3>Active jobs by source</h3>
      {source_rows or '<span class="muted">No data</span>'}
    </div>"""

    body = error_html + stats_html + pool_card
    return HTMLResponse(_html_page("Job Pool", body, page="pool"))


# ── Cron Logs Page ────────────────────────────────────────────────────────────

@router.get("/logs", response_class=HTMLResponse)
async def logs_page(
    request: Request,
    file: str = "fetching_stdout",
    lines: int = 25,
    _: None = Depends(_check_auth),
):
    _check_localhost(request)

    import re as _re

    log_path  = _LOG_FILES.get(file)
    all_lines: list = []
    log_error = ""

    if not log_path:
        log_error = f"Unknown log file: {file}"
    elif not log_path.exists():
        log_error = f"Log file not found: {log_path}"
    else:
        try:
            all_lines = log_path.read_text(errors="replace").splitlines()
        except Exception as e:
            log_error = str(e)

    _ts_full_re  = _re.compile(r"^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})")    # 2026-05-16 12:00:42
    _ts_millis_re = _re.compile(r"^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}),\d+") # 2026-05-16 12:00:42,993
    _ts_time_re  = _re.compile(r"^(\d{2}:\d{2}:\d{2})\s+\[")                   # 08:03:05 [INFO]

    # For time-only logs use the log file's modification date as the base date
    _base_date = None
    if log_path and log_path.exists():
        _base_date = datetime.fromtimestamp(log_path.stat().st_mtime).date()

    # Markers that always mean "a new pipeline run is starting"
    _run_start_re = _re.compile(
        r"Starting (pipeline|auto.?match|matching|fetching)|"
        r"\[Scheduler\].*Pool fetch|"
        r"run_fetching.*\[Fetching\]|"
        r"run_matching.*\[Matching\]|"
        r"\[AutoMatch\] Starting",
        _re.I,
    )

    def _extract_ts(line):
        # Full datetime with millis
        m = _ts_millis_re.match(line)
        if m:
            try:
                return datetime.strptime(m.group(1), "%Y-%m-%d %H:%M:%S")
            except ValueError:
                pass
        # Full datetime without millis
        m = _ts_full_re.match(line)
        if m:
            try:
                return datetime.strptime(m.group(1), "%Y-%m-%d %H:%M:%S")
            except ValueError:
                pass
        # Time-only HH:MM:SS [INFO] — anchor to log file's mtime date
        m = _ts_time_re.match(line)
        if m and _base_date:
            try:
                t = datetime.strptime(m.group(1), "%H:%M:%S")
                return datetime(_base_date.year, _base_date.month, _base_date.day,
                                t.hour, t.minute, t.second)
            except ValueError:
                pass
        return None

    def _colorize_line(line):
        esc = line.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        low = line.lower()
        if any(k in low for k in ("error", "exception", "traceback", "critical")):
            return f'<div class="log-line log-error">{esc}</div>'
        if any(k in low for k in ("warning", "warn")):
            return f'<div class="log-line log-warn">{esc}</div>'
        if "complete in" in low or "upserted" in low or "pool fetch complete" in low or "✓" in line:
            return f'<div class="log-line log-info" style="color:#a8f0be;">{esc}</div>'
        if "[info]" in low:
            return f'<div class="log-line log-info">{esc}</div>'
        if "[debug]" in low:
            return f'<div class="log-line log-debug">{esc}</div>'
        return f'<div class="log-line log-default">{esc}</div>'

    # Detect whether this log has timestamps at all
    has_timestamps = any(_extract_ts(l) for l in all_lines[:50])

    runs = []
    current = None
    prev_ts = None

    if has_timestamps:
        # Primary split: >90s gap between consecutive timestamped lines
        for raw_line in all_lines:
            ts  = _extract_ts(raw_line)
            gap = (ts - prev_ts).total_seconds() if (ts and prev_ts) else 0
            is_new = (gap > 90) or (current is None) or _run_start_re.search(raw_line)

            if is_new:
                if current and current["lines"]:
                    runs.append(current)
                current = {"start_ts": ts, "end_ts": ts, "lines": [],
                           "errors": 0, "warnings": 0,
                           "jobs_upserted": None, "jobs_pruned": None, "duration": None}

            if current:
                current["lines"].append(raw_line)
                if ts:
                    current["end_ts"] = ts
                low = raw_line.lower()
                if any(k in low for k in ("error", "exception", "traceback", "critical")):
                    current["errors"] += 1
                if any(k in low for k in ("warning", "warn")):
                    current["warnings"] += 1
                m_ups   = _re.search(r"(\d[\d,]*)\s+jobs?\s+upserted", raw_line, _re.I)
                m_prune = _re.search(r"(\d[\d,]*)\s+stale\s+jobs?\s+removed", raw_line, _re.I)
                m_dur   = _re.search(r"complete\s+in\s+(\d+)s", raw_line, _re.I)
                if m_ups:   current["jobs_upserted"] = int(m_ups.group(1).replace(",", ""))
                if m_prune: current["jobs_pruned"]   = int(m_prune.group(1).replace(",", ""))
                if m_dur:   current["duration"]       = int(m_dur.group(1))
            if ts:
                prev_ts = ts
    else:
        # No timestamps — split on blank lines OR explicit run-start markers
        # Each blank-line-separated block = one pipeline invocation
        for raw_line in all_lines:
            is_blank   = raw_line.strip() == ""
            is_marker  = _run_start_re.search(raw_line) is not None

            if is_blank or is_marker or current is None:
                if current and current["lines"]:
                    runs.append(current)
                if is_blank:
                    current = None
                    continue
                current = {"start_ts": None, "end_ts": None, "lines": [],
                           "errors": 0, "warnings": 0,
                           "jobs_upserted": None, "jobs_pruned": None, "duration": None}

            if current:
                current["lines"].append(raw_line)
                low = raw_line.lower()
                if any(k in low for k in ("error", "exception", "traceback", "critical")):
                    current["errors"] += 1
                if any(k in low for k in ("warning", "warn")):
                    current["warnings"] += 1
                m_ups  = _re.search(r"(\d[\d,]*)\s+(?:resumes?\s+scored|jobs?\s+upserted)", raw_line, _re.I)
                m_dur  = _re.search(r"(?:scored|complete)\s+in\s+(\d+)(?:ms|s)", raw_line, _re.I)
                m_ms   = _re.search(r"in\s+(\d+)ms", raw_line, _re.I)
                if m_ups: current["jobs_upserted"] = int(m_ups.group(1).replace(",", ""))
                if m_ms:  current["duration_ms"] = int(m_ms.group(1))

        # For no-timestamp logs, group consecutive non-blank blocks into
        # runs of ~reasonable size (matching fires per user per job batch)
        # Re-merge tiny single-line blocks into groups of ≤30 lines
        merged = []
        bucket = None
        for r in runs:
            if bucket is None:
                bucket = dict(r)
            else:
                bucket["lines"].extend(r["lines"])
                bucket["errors"]   += r["errors"]
                bucket["warnings"] += r["warnings"]
                if r.get("jobs_upserted"): bucket["jobs_upserted"] = r["jobs_upserted"]
                if r.get("duration_ms"):   bucket["duration_ms"]   = r.get("duration_ms")
                if len(bucket["lines"]) >= 20:
                    merged.append(bucket)
                    bucket = None
        if bucket and bucket["lines"]:
            merged.append(bucket)
        runs = merged

    if current and current["lines"]:
        runs.append(current)

    runs = list(reversed(runs))[:lines]

    def _run_card(run, idx):
        start     = run["start_ts"]
        start_str = start.strftime("%Y-%m-%d  %H:%M:%S") if start else f"{len(run['lines'])} lines (no timestamp)"
        dur_s = run.get("duration")
        dur_ms = run.get("duration_ms")
        if dur_s:
            dur_str = f"{dur_s}s"
        elif dur_ms:
            dur_str = f"{dur_ms}ms"
        elif run.get("start_ts") and run.get("end_ts") and run["start_ts"] != run["end_ts"]:
            dur_str = f"{int((run['end_ts']-run['start_ts']).total_seconds())}s"
        else:
            dur_str = "—"
        errors, warnings = run["errors"], run["warnings"]
        upserted, pruned = run["jobs_upserted"], run["jobs_pruned"]

        if errors:
            badge = f'<span style="background:#4a0000;color:#ff6b6b;border-radius:4px;padding:1px 7px;font-size:10px;">✗ {errors} error{"s" if errors>1 else ""}</span>'
        elif upserted is not None:
            badge = '<span style="background:#0d2a0d;color:#5fff8a;border-radius:4px;padding:1px 7px;font-size:10px;">✓ ok</span>'
        else:
            badge = '<span style="background:#1a1a1a;color:#666;border-radius:4px;padding:1px 7px;font-size:10px;">—</span>'

        parts = []
        if upserted is not None: parts.append(f'<span style="color:#5fff8a;">{upserted:,} upserted</span>')
        if pruned   is not None: parts.append(f'<span style="color:#ffaa33;">{pruned:,} pruned</span>')
        if warnings:              parts.append(f'<span style="color:#ffcc55;">{warnings} warn</span>')
        stats = " · ".join(parts) if parts else '<span style="color:#444;">no summary data</span>'

        body_html = "".join(_colorize_line(l) for l in run["lines"])
        cid = f"run-{idx}"
        return f"""
        <div style="border:1px solid var(--border);border-radius:8px;margin-bottom:10px;overflow:hidden;">
          <div onclick="toggleRun('{cid}')" id="{cid}-hdr"
               style="display:flex;align-items:center;gap:14px;padding:10px 16px;
                      background:var(--surface);cursor:pointer;user-select:none;border-bottom:1px solid transparent;">
            <span style="color:var(--muted);font-size:10px;width:16px;" id="{cid}-arrow">▶</span>
            <span style="font-weight:700;font-size:12px;white-space:nowrap;">{start_str}</span>
            <span style="color:var(--muted);font-size:11px;">{dur_str}</span>
            {badge}
            <span style="margin-left:8px;font-size:11px;">{stats}</span>
            <span style="margin-left:auto;color:#444;font-size:10px;">{len(run['lines'])} lines</span>
          </div>
          <div id="{cid}" style="display:none;">
            <div class="log-wrap" style="border:none;border-radius:0;margin:0;max-height:500px;">{body_html}</div>
          </div>
        </div>"""

    if not runs:
        warn_msg = f"⚠ {log_error}" if log_error else "Log is empty or no runs found."
        log_html = f'<div class="log-wrap"><span class="log-warn">{warn_msg}</span></div>'
    else:
        log_html = "\n".join(_run_card(r, i) for i, r in enumerate(runs))

    def _tab(key, label):
        active = "active" if key == file else ""
        return f'<a class="log-tab {active}" href="/admin/logs?file={key}&lines={lines}">{label}</a>'

    tabs = (f'<div class="log-tabs">'
            + _tab("fetching_stdout", "fetch · stdout")
            + _tab("fetching_stderr", "fetch · stderr")
            + _tab("matching_stdout", "match · stdout")
            + _tab("matching_stderr", "match · stderr")
            + '</div>')

    run_opts = "".join(
        f'<option value="{n}" {"selected" if n == lines else ""}>{n} runs</option>'
        for n in [10, 25, 50, 100])
    path_exists = log_path and log_path.exists()
    controls = f"""
    <div style="border:1px solid var(--border);border-top:none;border-radius:0 0 6px 6px;
         padding:8px 14px;background:#0d0d0d;margin-bottom:16px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
      <label style="font-size:11px;color:var(--muted);">Show</label>
      <select onchange="location.href='/admin/logs?file={file}&lines='+this.value"
              style="font-size:11px;padding:2px 6px;">{run_opts}</select>
      <span style="color:var(--muted);font-size:10px;">runs</span>
      <span style="margin-left:auto;color:{'#5fff8a' if path_exists else 'var(--red)'};font-size:10px;">
        {log_path} ({'exists' if path_exists else 'NOT FOUND'})
      </span>
    </div>"""

    total_errors = sum(r["errors"] for r in runs)
    total_ups    = sum(r["jobs_upserted"] or 0 for r in runs)
    summary = f"""
    <div style="display:flex;gap:16px;margin-bottom:16px;flex-wrap:wrap;">
      <div class="stat-card" style="padding:10px 18px;min-width:0;">
        <span class="num" style="font-size:18px;">{len(runs)}</span><span class="label">runs shown</span></div>
      <div class="stat-card" style="padding:10px 18px;min-width:0;">
        <span class="num" style="font-size:18px;color:{'var(--red)' if total_errors else 'var(--green)'};">{total_errors}</span>
        <span class="label">total errors</span></div>
      <div class="stat-card" style="padding:10px 18px;min-width:0;">
        <span class="num" style="font-size:18px;">{total_ups:,}</span><span class="label">jobs upserted</span></div>
    </div>"""

    toggle_js = """<script>
    function toggleRun(id) {
      var el=document.getElementById(id), arr=document.getElementById(id+'-arrow'), hdr=document.getElementById(id+'-hdr');
      if(el.style.display==='none'){
        el.style.display='block'; arr.textContent='▼'; hdr.style.borderBottomColor='var(--border)';
        var w=el.querySelector('.log-wrap'); if(w) w.scrollTop=w.scrollHeight;
      } else { el.style.display='none'; arr.textContent='▶'; hdr.style.borderBottomColor='transparent'; }
    }
    window.addEventListener('DOMContentLoaded',function(){ if(document.getElementById('run-0')) toggleRun('run-0'); });
    </script>"""

    body = tabs + controls + summary + log_html + toggle_js
    return HTMLResponse(_html_page("Cron Logs", body, page="logs"))


# ── Add user links to dashboard table ─────────────────────────────────────────

# ── Global run state (in-process, single-server local only) ───────────────────
import threading as _threading

# ── In-memory ring buffer — captures auto_match live log output ───────────────
class _RingBufferHandler(_logging.Handler):
    def __init__(self, maxlen: int = 2000):
        super().__init__()
        self.records: _collections.deque = _collections.deque(maxlen=maxlen)
        self.setFormatter(_logging.Formatter(
            "%(asctime)s [%(levelname)s] %(name)s — %(message)s",
            datefmt="%H:%M:%S",
        ))

    def emit(self, record: _logging.LogRecord):
        try:
            self.records.append(self.format(record))
        except Exception:
            pass

    def snapshot(self) -> list:
        return list(self.records)

    def clear(self):
        self.records.clear()


_ring = _RingBufferHandler(maxlen=2000)
_ring.setLevel(_logging.DEBUG)
for _ln in ("services.auto_match", "services.matcher", "services.llm_scorer",
            "services.vector_store", "run_matching"):
    _logging.getLogger(_ln).addHandler(_ring)
_active_run  = {"running": False, "started_at": None, "user_filter": None}


# ── Manual Run Page ───────────────────────────────────────────────────────────

@router.get("/run-matching", response_class=HTMLResponse)
async def run_matching_page(
    request: Request,
    db: AsyncSession = Depends(get_db),
    _: None = Depends(_check_auth),
    msg: str = "",
):
    _check_localhost(request)

    # Fetch all users with preferences so we can show a user picker
    result = await db.execute(
        select(User).order_by(User.created_at.desc())
    )
    users = result.scalars().all()

    user_opts = '<option value="">— All users with target roles —</option>'
    for u in users:
        prefs = u.preferences or {}
        roles = prefs.get("target_roles", [])
        role_preview = (", ".join(roles[:2]) + ("…" if len(roles) > 2 else "")) if roles else "no roles set"
        warn = " ⚠" if not roles else ""
        user_opts += f'<option value="{u.id}">{u.email}{warn} ({role_preview})</option>'

    is_running = _active_run["running"]
    started_at = _active_run.get("started_at")
    started_str = started_at.strftime("%H:%M:%S") if started_at else "—"
    user_filter = _active_run.get("user_filter") or "all users"

    status_color = "var(--red)" if is_running else "var(--muted)"
    status_dot   = f'<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:{status_color};margin-right:6px;{"animation:pulse 1s infinite;" if is_running else ""}"></span>'
    status_label = f"Running since {started_str} · {user_filter}" if is_running else "Idle"

    flash = f'<div class="flash">✓ {msg}</div>' if msg else ""

    # Log file path indicator
    log_path = _LOG_FILES.get("matching_stdout")
    log_exists = log_path and log_path.exists()

    body = f"""
    {flash}
    <div style="display:flex;align-items:baseline;gap:20px;margin-bottom:24px;flex-wrap:wrap;">
      <div>
        <div style="font-size:18px;font-weight:700;">Manual Match Run</div>
        <div style="font-size:11px;color:var(--muted);margin-top:2px;">
          Triggers the full scoring pipeline · streams live from <code style="color:#888;">services.auto_match</code> logger in real-time
        </div>
      </div>
      <div style="margin-left:auto;display:flex;align-items:center;font-size:12px;">
        {status_dot}<span id="status-label">{status_label}</span>
      </div>
    </div>

    <!-- Trigger form -->
    <div class="detail-card" style="max-width:560px;margin-bottom:24px;">
      <h3>Pipeline trigger</h3>
      <form method="POST" action="/admin/run-matching/start" id="trigger-form"
            style="display:flex;flex-direction:column;gap:12px;margin-top:12px;">
        <div>
          <label style="font-size:11px;color:var(--muted);display:block;margin-bottom:4px;">Target user</label>
          <select name="user_id" style="width:100%;font-size:12px;padding:6px 8px;background:#111;
                  border:1px solid var(--border);border-radius:4px;color:var(--text);">
            {user_opts}
          </select>
        </div>
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
          <button type="submit" class="btn-primary" id="run-btn"
                  {"disabled" if is_running else ""}
                  style="{"opacity:0.5;cursor:not-allowed;" if is_running else ""}">
            {"⏳ Pipeline running…" if is_running else "▶ Run Matching Now"}
          </button>
          <label style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--muted);cursor:pointer;">
            <input type="checkbox" name="force_rescore" value="1"
                   style="accent-color:var(--accent);width:13px;height:13px;" />
            Force re-score (ignore cache)
          </label>
          <span style="font-size:11px;color:var(--muted);">· starts in background · live log appears below</span>
        </div>
      </form>
    </div>

    <!-- Live log terminal -->
    <div style="margin-bottom:8px;display:flex;align-items:center;gap:12px;">
      <span style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.6px;color:var(--muted);">Live log</span>
      <span id="stream-status" style="font-size:10px;color:var(--muted);">
        {"● connecting…" if is_running else "○ waiting for run"}
      </span>
      <button onclick="clearLog()" style="margin-left:auto;font-size:10px;padding:2px 8px;background:transparent;
              border:1px solid var(--border);border-radius:4px;color:var(--muted);cursor:pointer;">Clear</button>
      <button onclick="scrollBottom()" style="font-size:10px;padding:2px 8px;background:transparent;
              border:1px solid var(--border);border-radius:4px;color:var(--muted);cursor:pointer;">↓ Bottom</button>
    </div>
    <div id="log-terminal" style="
      background:#020408;
      border:1px solid #1a2a1a;
      border-radius:8px;
      padding:16px;
      height:520px;
      overflow-y:auto;
      font-family:'SF Mono','Fira Code',monospace;
      font-size:11px;
      line-height:1.7;
      box-shadow: inset 0 0 40px rgba(0,255,80,0.02);
    ">
      <div id="log-lines" style="min-height:100%;"></div>
      <div id="cursor" style="display:inline-block;width:8px;height:13px;background:#4aff7a;
           opacity:0.7;vertical-align:middle;animation:blink 1s step-end infinite;margin-left:2px;"></div>
    </div>

    <style>
      @keyframes blink {{ 0%,100%{{opacity:0.7}} 50%{{opacity:0}} }}
      @keyframes pulse {{ 0%,100%{{opacity:1}} 50%{{opacity:0.3}} }}
      @keyframes fadein {{ from{{opacity:0;transform:translateY(2px)}} to{{opacity:1;transform:none}} }}
      .ll {{ animation: fadein 0.15s ease; }}
      .ll-error   {{ color: #ff6b6b; }}
      .ll-warn    {{ color: #ffcc55; }}
      .ll-ok      {{ color: #7aff9e; }}
      .ll-info    {{ color: #8ab8d4; }}
      .ll-dim     {{ color: #3a5a4a; }}
      .ll-default {{ color: #556655; }}
      .ll-phase   {{ color: #e8ff6b; font-weight: 700; }}
      .ll-user    {{ color: #c8a0ff; }}
    </style>

    <script>
    var es = null;
    var autoScroll = true;
    var logEl = document.getElementById('log-terminal');
    var linesEl = document.getElementById('log-lines');
    var streamStatus = document.getElementById('stream-status');

    logEl.addEventListener('scroll', function() {{
      autoScroll = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 40;
    }});

    function scrollBottom() {{
      logEl.scrollTop = logEl.scrollHeight;
      autoScroll = true;
    }}

    function clearLog() {{
      linesEl.innerHTML = '';
    }}

    function classifyLine(line) {{
      var low = line.toLowerCase();
      if (low.includes('error') || low.includes('exception') || low.includes('traceback') || low.includes('critical') || low.includes('[error]'))
        return 'll-error';
      if (low.includes('warning') || low.includes('warn') || low.includes('[warning]') || low.includes('skipping') || low.includes('stale'))
        return 'll-warn';
      if (line.includes('✓') || low.includes('pipeline complete for') || low.includes('complete in') || low.includes('stored') || low.includes('upserted'))
        return 'll-ok';
      if (low.includes('starting pipeline') || low.includes('run started') || low.includes('pool loaded') || low.includes('on-demand'))
        return 'll-phase';
      if (low.includes('user=') || low.includes('@gmail') || low.includes('@njit') || low.includes('tejas'))
        return 'll-user';
      if (low.includes('phase 1') || low.includes('phase 2') || low.includes('llm') || low.includes('scored') || low.includes('score') || low.includes('[info]') || low.includes('pool size'))
        return 'll-info';
      if (low.includes('no new jobs') || low.includes('returning') || low.includes('existing results') || low.includes('pgvector') || low.includes('[debug]'))
        return 'll-dim';
      return 'll-default';
    }}

    function appendLine(text) {{
      var esc = text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      var cls = classifyLine(text);
      var div = document.createElement('div');
      div.className = 'll ' + cls;
      div.innerHTML = esc;
      linesEl.appendChild(div);
      if (autoScroll) scrollBottom();
    }}

    function startStream() {{
      if (es) {{ es.close(); es = null; }}
      streamStatus.textContent = '● connecting…';
      streamStatus.style.color = '#ffcc55';

      es = new EventSource('/admin/run-matching/stream');

      es.addEventListener('line', function(e) {{
        appendLine(e.data);
      }});

      es.addEventListener('status', function(e) {{
        streamStatus.textContent = e.data;
        streamStatus.style.color = e.data.includes('Complete') || e.data.includes('finished') ? '#7aff9e' :
                                   e.data.includes('error')    ? '#ff6b6b' : '#ffcc55';
      }});

      es.addEventListener('done', function(e) {{
        streamStatus.textContent = '✓ ' + e.data;
        streamStatus.style.color = '#7aff9e';
        document.getElementById('cursor').style.animation = 'none';
        document.getElementById('cursor').style.opacity = '0';
        var btn = document.getElementById('run-btn');
        if (btn) {{ btn.disabled = false; btn.textContent = '▶ Run Matching Now'; btn.style.opacity = '1'; btn.style.cursor = 'pointer'; }}
        document.getElementById('status-label').textContent = 'Idle';
        es.close(); es = null;
      }});

      es.onerror = function() {{
        streamStatus.textContent = '○ stream closed';
        streamStatus.style.color = 'var(--muted)';
        if (es) {{ es.close(); es = null; }}
      }};
    }}

    // Auto-start stream if pipeline is already running
    {"startStream();" if is_running else ""}

    // After form submit, start stream
    document.getElementById('trigger-form').addEventListener('submit', function() {{
      var btn = document.getElementById('run-btn');
      btn.disabled = true;
      btn.textContent = '⏳ Pipeline running…';
      btn.style.opacity = '0.5';
      document.getElementById('status-label').textContent = 'Starting…';
      clearLog();
      appendLine('▶ Triggering pipeline…');
      setTimeout(startStream, 100);
    }});
    </script>
    """

    return HTMLResponse(_html_page("Run Matching", body, page="run-matching"))


# ── Trigger endpoint ──────────────────────────────────────────────────────────

@router.post("/run-matching/start", response_class=RedirectResponse)
async def start_matching(
    request: Request,
    background_tasks: BackgroundTasks,
    user_id: str = Form(default=""),
    force_rescore: str = Form(default=""),
    db: AsyncSession = Depends(get_db),
    _: None = Depends(_check_auth),
):
    _check_localhost(request)

    if _active_run["running"]:
        return RedirectResponse(url="/admin/run-matching?msg=Already+running", status_code=303)
    _ring.clear()
    _active_run["running"]     = True
    _active_run["started_at"] = datetime.now(timezone.utc)
    _active_run["user_filter"] = user_id or "all"

    uid   = user_id.strip() or None
    force = force_rescore == "1"

    async def _do_run():
        try:
            from services.auto_match import run_pipeline_for_new_user
            if uid:
                await run_pipeline_for_new_user(uid, force_pool=True, force=force)
            else:
                try:
                    from services.auto_match import run_pipeline_for_all_users
                    await run_pipeline_for_all_users()
                except ImportError:
                    from db.database import AsyncSessionLocal
                    from models.orm import User as _User
                    from sqlalchemy import select as _sel
                    async with AsyncSessionLocal() as session:
                        rows = await session.execute(_sel(_User))
                        users = rows.scalars().all()
                    for u in users:
                        prefs = u.preferences or {}
                        if prefs.get("target_roles"):
                            await run_pipeline_for_new_user(str(u.id), force_pool=True, force=force)
        except Exception:
            import traceback, logging
            logging.getLogger("admin").error("Manual run failed:\n" + traceback.format_exc())
        finally:
            _active_run["running"]     = False
            _active_run["started_at"] = None
            _active_run["user_filter"] = None

    background_tasks.add_task(_do_run)
    return RedirectResponse(url="/admin/run-matching", status_code=303)


# ── SSE log stream ────────────────────────────────────────────────────────────

@router.get("/run-matching/stream")
async def stream_matching_log(
    request: Request,
    _: None = Depends(_check_auth),
):
    _check_localhost(request)

    from fastapi.responses import StreamingResponse

    log_path = _LOG_FILES.get("matching_stdout")

    async def _event_generator():
        import asyncio

        sent_index = 0   # how many ring buffer lines we've already sent

        yield f"event: status\ndata: ● pipeline running — streaming live from auto_match logger\n\n"

        idle_ticks  = 0
        max_idle    = 240   # 120s timeout
        done_marker = False

        while True:
            if await request.is_disconnected():
                break

            snap = _ring.snapshot()
            new_lines = snap[sent_index:]

            if new_lines:
                idle_ticks = 0
                for line in new_lines:
                    safe = line.replace("\n", " ")
                    yield f"event: line\ndata: {safe}\n\n"
                    low = line.lower()
                    if ("pipeline complete for user" in low or
                        "✓ complete" in line or
                        "complete in" in low and "newuser" in low):
                        done_marker = True
                sent_index = len(snap)
            else:
                idle_ticks += 1

            # Done marker seen + 1.5s quiet
            if done_marker and idle_ticks >= 3:
                yield f"event: done\ndata: ✓ Complete — {sent_index} log lines captured\n\n"
                break

            # Pipeline flag cleared + quiet for 2s
            if not _active_run["running"] and idle_ticks >= 4:
                if sent_index == 0:
                    yield f"event: line\ndata: (no log output captured — pipeline may have exited early)\n\n"
                yield f"event: done\ndata: ✓ Pipeline finished — {sent_index} log lines\n\n"
                break

            if idle_ticks >= max_idle:
                yield f"event: done\ndata: Timed out\n\n"
                break

            await asyncio.sleep(0.5)

    return StreamingResponse(
        _event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


# ── Pipeline Funnel Diagnostic ────────────────────────────────────────────────

@router.get("/users/{user_id}/funnel", response_class=HTMLResponse)
async def funnel_page(
    request: Request,
    user_id: str,
    db: AsyncSession = Depends(get_db),
    _: None = Depends(_check_auth),
):
    _check_localhost(request)
    import re as _re

    # ── Load user ──────────────────────────────────────────────────────
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        return RedirectResponse(url="/admin?err=User+not+found", status_code=303)

    prefs        = user.preferences or {}
    target_roles = prefs.get("target_roles", [])
    role_aliases = prefs.get("role_aliases", {})
    pref_locs    = prefs.get("preferred_locations", [])

    if not target_roles:
        body = f'<div class="flash error">✗ User has no target_roles set — funnel cannot run.</div>'
        return HTMLResponse(_html_page(f"Funnel — {user.email}", body, page="dashboard"))

    # ── Stage 0: Full pool size ────────────────────────────────────────
    total_row = await db.execute(text("SELECT COUNT(*) FROM job_pool WHERE is_active = TRUE"))
    total_pool = total_row.scalar()

    # ── Stage 1: SQL ILIKE keyword pre-filter ─────────────────────────
    from services.auto_match import _build_title_keywords, _role_matches_title
    keywords = _build_title_keywords(target_roles, role_aliases)

    if keywords:
        ilike_clauses = " OR ".join(["title ILIKE :kw" + str(i) for i in range(len(keywords))])
        kw_params = {f"kw{i}": f"%{kw}%" for i, kw in enumerate(keywords)}
        sql1_count = await db.execute(
            text(f"SELECT COUNT(*) FROM job_pool WHERE is_active = TRUE AND ({ilike_clauses})"),
            kw_params,
        )
        after_sql = sql1_count.scalar()

        # Pull sample jobs that passed SQL filter
        sql1_sample = await db.execute(
            text(f"SELECT job_id, title, company, location, source FROM job_pool WHERE is_active = TRUE AND ({ilike_clauses}) ORDER BY fetched_at DESC LIMIT 200"),
            kw_params,
        )
        sql_jobs = [dict(r._mapping) for r in sql1_sample.fetchall()]
    else:
        after_sql = total_pool
        sql_jobs  = []

    # ── Stage 2: Role title word-overlap filter ────────────────────────
    role_matched = [j for j in sql_jobs if _role_matches_title(j["title"], target_roles, role_aliases)]
    after_role   = len(role_matched)

    # Jobs DROPPED by role filter — sample
    role_dropped = [j for j in sql_jobs if not _role_matches_title(j["title"], target_roles, role_aliases)]

    # ── Stage 3: Location filter ───────────────────────────────────────
    if pref_locs:
        from services.user_profile import matches_any_preferred_location
        loc_passed, loc_dropped = [], []
        for j in role_matched:
            loc = j.get("location", "").strip()
            if not loc or loc.lower() in ("not specified", "n/a", "tbd", ""):
                loc_passed.append(j)
            elif matches_any_preferred_location(loc, pref_locs):
                loc_passed.append(j)
            else:
                loc_dropped.append(j)
        after_loc = len(loc_passed)
    else:
        loc_passed  = role_matched
        loc_dropped = []
        after_loc   = after_role

    # ── Stage 4: seen_job_ids ─────────────────────────────────────────
    seen_result = await db.execute(
        text("SELECT job_id FROM seen_job_ids WHERE user_id = :uid"), {"uid": user_id}
    )
    seen_ids = {r[0] for r in seen_result.fetchall()}

    archived_result = await db.execute(
        text("SELECT job_id FROM archived_job_ids WHERE user_id = :uid"), {"uid": user_id}
    )
    archived_ids = {r[0] for r in archived_result.fetchall()}

    truly_new   = [j for j in loc_passed if j["job_id"] not in seen_ids and j["job_id"] not in archived_ids]
    after_new   = len(truly_new)
    already_seen = len(loc_passed) - after_new

    # ── Stage 5: stored results ────────────────────────────────────────
    stored_row = await db.execute(
        text("SELECT COUNT(*) FROM auto_match_results WHERE user_id = :uid"), {"uid": user_id}
    )
    stored_count = stored_row.scalar()

    score_dist = await db.execute(text("""
        SELECT
            COUNT(*) FILTER (WHERE score >= 85) AS strong,
            COUNT(*) FILTER (WHERE score >= 75 AND score < 85) AS good,
            COUNT(*) FILTER (WHERE score >= 55 AND score < 75) AS partial,
            AVG(score) AS avg_score,
            MAX(score) AS max_score,
            MIN(score) AS min_score
        FROM auto_match_results WHERE user_id = :uid
    """), {"uid": user_id})
    sd = dict(score_dist.mappings().one())

    # ── Build funnel visualization ─────────────────────────────────────
    def _funnel_row(label, count, prev, color, detail=""):
        pct     = int(count / max(prev, 1) * 100)
        dropped = prev - count
        bar_w   = int(count / max(total_pool, 1) * 500)
        drop_html = f'<span style="color:var(--red);font-size:11px;">−{dropped:,} dropped ({100-pct}%)</span>' if dropped > 0 else ""
        return f"""
        <div style="margin-bottom:16px;">
          <div style="display:flex;align-items:baseline;gap:12px;margin-bottom:4px;flex-wrap:wrap;">
            <span style="font-size:11px;color:var(--muted);width:240px;flex-shrink:0;">{label}</span>
            <span style="font-size:20px;font-weight:700;color:{color};">{count:,}</span>
            <span style="font-size:11px;color:var(--muted);">{pct}% of prev</span>
            {drop_html}
          </div>
          <div style="background:#1a1a1a;border-radius:3px;height:8px;width:520px;max-width:100%;">
            <div style="height:8px;border-radius:3px;background:{color};width:{min(bar_w,500)}px;transition:width 0.3s;"></div>
          </div>
          {"<div style='font-size:10px;color:#555;margin-top:3px;'>"+detail+"</div>" if detail else ""}
        </div>"""

    funnel_html = (
        _funnel_row("Total active jobs in pool", total_pool, total_pool, "#444",
                    "All jobs across all sources in job_pool table")
        + _funnel_row("After SQL keyword filter (ILIKE)", after_sql, total_pool, "#6688aa",
                    f"Keywords: {', '.join(keywords) if keywords else 'none'}")
        + _funnel_row("After role title match (60% word overlap)", after_role, after_sql, "#8899cc",
                    f"Roles: {', '.join(target_roles)}")
        + _funnel_row("After location filter", after_loc, after_role, "#aabbdd",
                    f"Preferred: {', '.join(pref_locs) if pref_locs else 'none set — all locations pass'}")
        + _funnel_row("Truly new (not in seen_job_ids)", after_new, after_loc, "#ffcc55",
                    f"{already_seen:,} already seen, {len(archived_ids):,} archived")
        + _funnel_row("Stored results (passed Phase 1+2 + MIN_SCORE≥55)", stored_count, after_loc, "var(--green)",
                    f"avg score {round(sd['avg_score'] or 0)} · max {round(sd['max_score'] or 0)} · min {round(sd['min_score'] or 0)}")
    )

    # ── Sample dropped jobs ────────────────────────────────────────────
    def _job_table(jobs, title, color, limit=15):
        if not jobs:
            return f'<p style="color:var(--muted);font-size:11px;">No jobs in this category.</p>'
        rows = ""
        for j in jobs[:limit]:
            rows += f"""<tr>
              <td style="color:var(--text);max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"
                  title="{j['title']}">{j['title']}</td>
              <td style="color:var(--muted);">{j.get('company','')}</td>
              <td style="color:var(--muted);font-size:10px;">{j.get('location','')[:30]}</td>
              <td style="color:var(--muted);font-size:10px;">{j.get('source','')}</td>
            </tr>"""
        more = f'<tr><td colspan="4" style="color:#555;font-size:10px;">…and {len(jobs)-limit} more</td></tr>' if len(jobs) > limit else ""
        return f"""
        <p style="font-size:11px;font-weight:700;color:{color};margin-bottom:6px;">{title} ({len(jobs):,})</p>
        <table style="width:100%;border-collapse:collapse;font-size:11px;">
          <thead><tr>
            <th style="text-align:left;color:var(--muted);padding-bottom:4px;">Title</th>
            <th style="text-align:left;color:var(--muted);">Company</th>
            <th style="text-align:left;color:var(--muted);">Location</th>
            <th style="text-align:left;color:var(--muted);">Source</th>
          </tr></thead>
          <tbody>{rows}{more}</tbody>
        </table>"""

    samples_html = f"""
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:24px;">
      <div class="detail-card">
        <h3>Jobs passing role filter ✓</h3>
        {_job_table(role_matched[:15], "Sample matched titles", "var(--green)")}
      </div>
      <div class="detail-card">
        <h3>Jobs dropped by role filter ✗</h3>
        {_job_table(role_dropped, "Dropped — title didn't match 60% word overlap", "var(--red)")}
      </div>
      {"<div class='detail-card'><h3>Jobs dropped by location filter ✗</h3>" + _job_table(loc_dropped, "Location excluded", "#ffaa33") + "</div>" if loc_dropped else ""}
    </div>"""

    body = f"""
    <div style="margin-bottom:20px;display:flex;align-items:baseline;gap:16px;flex-wrap:wrap;">
      <div>
        <div style="font-size:18px;font-weight:700;">Pipeline Funnel — {user.display_name or user.email}</div>
        <div style="font-size:11px;color:var(--muted);">
          {user.email} · roles: {', '.join(target_roles)} · locations: {', '.join(pref_locs) if pref_locs else 'any'}
        </div>
      </div>
      <a href="/admin/users/{user_id}" style="margin-left:auto;font-size:11px;color:var(--muted);text-decoration:none;">← Back to user</a>
    </div>

    <div class="detail-card" style="max-width:700px;margin-bottom:24px;">
      <h3>Where the {total_pool:,} jobs go</h3>
      <div style="margin-top:16px;">{funnel_html}</div>
    </div>

    {samples_html}
    """

    return HTMLResponse(_html_page(f"Funnel — {user.email}", body, page="dashboard"))


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
    return HTMLResponse(_html_page("Scoring Audit", body, page="scoring-audit"))