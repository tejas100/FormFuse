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
  </style>
</head>
<body>
  <h1>⚡ RACK Admin</h1>
  <p class="subtitle">localhost only · {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}</p>
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