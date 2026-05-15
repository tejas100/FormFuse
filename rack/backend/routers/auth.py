"""
routers/auth.py — JWT verification + user dependency for FastAPI

Supabase now issues RS256 JWTs by default (verified via JWKS endpoint).
Falls back to legacy HS256 (SUPABASE_JWT_SECRET) for older sessions.

Every protected route uses:

    current_user: User = Depends(get_current_user)

This dependency:
1. Extracts Bearer token from Authorization header
2. Verifies signature — RS256 via JWKS first, HS256 legacy as fallback
3. Extracts user_id (sub claim) + email
4. Upserts a row in the users table (creates on first login)
5. Returns the User ORM object
"""

import os
import uuid
import asyncio
import logging

import httpx
import jwt as pyjwt
from jwt import PyJWKClient
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select, text
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from db.database import get_db
from models.orm import User

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/auth", tags=["auth"])

# ── JWT config ─────────────────────────────────────────────────────────────────
SUPABASE_URL        = os.getenv("SUPABASE_URL")
SUPABASE_JWT_SECRET = os.getenv("SUPABASE_JWT_SECRET")
RESEND_API_KEY      = os.getenv("RESEND_API_KEY")

if not SUPABASE_URL:
    raise RuntimeError("SUPABASE_URL is not set. Add it to your .env file.")
if not SUPABASE_JWT_SECRET:
    raise RuntimeError("SUPABASE_JWT_SECRET is not set. Add it to your .env file.")

# JWKS endpoint — Supabase RS256 public keys (new default format)
_JWKS_URL = f"{SUPABASE_URL}/auth/v1/.well-known/jwks.json"
_jwks_client = PyJWKClient(_JWKS_URL, cache_keys=True)

# HTTPBearer extracts the Authorization: Bearer <token> header automatically
_bearer_scheme = HTTPBearer(auto_error=True)


# ── Token verification ─────────────────────────────────────────────────────────
def _verify_token(token: str) -> dict:
    """
    Verify a Supabase JWT and return the decoded payload.

    Tries RS256 via JWKS first (new Supabase default since late 2024).
    Falls back to HS256 with the legacy secret for older sessions.
    Raises HTTPException 401 on any failure.
    """
    # ── Attempt 1: RS256 via JWKS (new Supabase format) ───────────────────────
    try:
        signing_key = _jwks_client.get_signing_key_from_jwt(token)
        payload = pyjwt.decode(
            token,
            signing_key.key,
            algorithms=["ES256"],
            options={"verify_aud": False},
        )
        return payload
    except pyjwt.ExpiredSignatureError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token has expired. Please sign in again.",
        )
    except Exception as e:
        logger.warning(f"RS256 attempt failed: {e}")
        pass  # Fall through to HS256 attempt

    # ── Attempt 2: HS256 via legacy secret ────────────────────────────────────
    try:
        payload = pyjwt.decode(
            token,
            SUPABASE_JWT_SECRET,
            algorithms=["HS256"],
            options={"verify_aud": False},
        )
        return payload
    except pyjwt.ExpiredSignatureError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token has expired. Please sign in again.",
        )
    except pyjwt.InvalidTokenError as e:
        logger.warning(f"Invalid JWT: {e}")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid authentication token.",
        )


# ── Welcome email ──────────────────────────────────────────────────────────────
def _build_welcome_html(display_name: str | None) -> str:
    first_name = (display_name or "").split()[0] if display_name else "there"
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Welcome to RACK</title>
</head>
<body bgcolor="#f5f4f0" style="margin:0;padding:0;background:#f5f4f0;font-family:Georgia,'Times New Roman',serif;">
<table width="100%" cellpadding="0" cellspacing="0" bgcolor="#f5f4f0" style="background:#f5f4f0;font-family:Georgia,'Times New Roman',serif;">
  <tr><td align="center" style="padding:48px 16px;">
    <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">

      <!-- Wordmark -->
      <tr><td align="center" style="padding-bottom:28px;">
        <a href="https://rackx.app" style="text-decoration:none;">
          <table cellpadding="0" cellspacing="0" align="center">
            <tr>
              <td style="background:#111;border-radius:8px;padding:10px 28px;">
                <span style="font-family:Georgia,serif;font-size:20px;font-weight:700;letter-spacing:6px;color:#c8f000;text-transform:uppercase;">RACK</span>
              </td>
            </tr>
          </table>
        </a>
      </td></tr>

      <!-- Main card -->
      <tr><td style="background:#ffffff;border:1px solid #e0ddd6;border-radius:8px;overflow:hidden;">
        <div style="height:4px;background:#c8f000;"></div>
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr><td style="padding:40px 40px 36px;">

            <p style="margin:0 0 8px;font-family:Georgia,serif;font-size:28px;font-weight:700;color:#111;line-height:1.2;letter-spacing:-0.5px;">
              Hey {first_name},<br/>welcome aboard.
            </p>
            <p style="margin:0 0 36px;font-family:Georgia,serif;font-size:15px;color:#777;line-height:1.7;font-style:italic;">
              Your AI job-matching engine is live and running.
            </p>

            <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:32px;">
              <tr><td style="border-top:1px solid #ece9e3;font-size:0;">&nbsp;</td></tr>
            </table>

            <!-- Feature 1 -->
            <table cellpadding="0" cellspacing="0" width="100%" style="margin-bottom:28px;">
              <tr>
                <td style="width:44px;vertical-align:top;padding-top:2px;">
                  <table cellpadding="0" cellspacing="0">
                    <tr><td style="width:34px;height:34px;background:#f5f4f0;border:1px solid #e5e2db;border-radius:6px;text-align:center;vertical-align:middle;font-size:16px;">&#x1F4C4;</td></tr>
                  </table>
                </td>
                <td style="padding-left:16px;vertical-align:top;">
                  <p style="margin:0 0 4px;font-family:Georgia,serif;font-size:14px;font-weight:700;color:#111;">Upload your resume once</p>
                  <p style="margin:0;font-family:Georgia,serif;font-size:13px;color:#888;line-height:1.65;font-style:italic;">RACK parses it, embeds it, and keeps it ready for matching. No reformatting ever needed.</p>
                </td>
              </tr>
            </table>

            <!-- Feature 2 -->
            <table cellpadding="0" cellspacing="0" width="100%" style="margin-bottom:28px;">
              <tr>
                <td style="width:44px;vertical-align:top;padding-top:2px;">
                  <table cellpadding="0" cellspacing="0">
                    <tr><td style="width:34px;height:34px;background:#f5f4f0;border:1px solid #e5e2db;border-radius:6px;text-align:center;vertical-align:middle;font-size:16px;">&#x26A1;</td></tr>
                  </table>
                </td>
                <td style="padding-left:16px;vertical-align:top;">
                  <p style="margin:0 0 4px;font-family:Georgia,serif;font-size:14px;font-weight:700;color:#111;">Auto-matched to 14,000+ jobs daily</p>
                  <p style="margin:0;font-family:Georgia,serif;font-size:13px;color:#888;line-height:1.65;font-style:italic;">RACK scans Greenhouse, Ashby, and Lever boards every few hours and scores every job against your resume with AI.</p>
                </td>
              </tr>
            </table>

            <!-- Feature 3 -->
            <table cellpadding="0" cellspacing="0" width="100%" style="margin-bottom:40px;">
              <tr>
                <td style="width:44px;vertical-align:top;padding-top:2px;">
                  <table cellpadding="0" cellspacing="0">
                    <tr><td style="width:34px;height:34px;background:#f5f4f0;border:1px solid #e5e2db;border-radius:6px;text-align:center;vertical-align:middle;font-size:16px;">&#x1F916;</td></tr>
                  </table>
                </td>
                <td style="padding-left:16px;vertical-align:top;">
                  <p style="margin:0 0 4px;font-family:Georgia,serif;font-size:14px;font-weight:700;color:#111;">One-click auto-apply</p>
                  <p style="margin:0;font-family:Georgia,serif;font-size:13px;color:#888;line-height:1.65;font-style:italic;">See a job you like? RACK's browser agent fills and submits the application for you. You just watch it happen live.</p>
                </td>
              </tr>
            </table>

            <!-- CTA -->
            <table cellpadding="0" cellspacing="0">
              <tr>
                <td style="background:#111;border-radius:8px;">
                  <a href="https://rackx.app" style="display:inline-block;background:#111;color:#c8f000;font-family:Georgia,serif;font-size:14px;font-weight:700;text-decoration:none;padding:14px 36px;border-radius:8px;letter-spacing:1.5px;text-transform:uppercase;">
                    Open RACK &rarr;
                  </a>
                </td>
              </tr>
            </table>

          </td></tr>
        </table>
      </td></tr>

      <!-- Footer -->
      <tr><td align="center" style="padding-top:28px;padding-bottom:8px;">
        <p style="margin:0 0 6px;font-family:Georgia,serif;font-size:12px;color:#aaa;">
          Sent by <a href="https://tejasbk.dev" style="color:#888;text-decoration:underline;">Tejas</a>, founder of RackX
        </p>
        <p style="margin:0;font-family:Georgia,serif;font-size:11px;color:#bbb;font-style:italic;line-height:1.7;">
          You are receiving this because you just created a RACK account.<br/>
          No marketing. Just this one welcome.
        </p>
      </td></tr>

    </table>
  </td></tr>
</table>
</body>
</html>"""


async def _send_welcome_email(email: str, display_name: str | None) -> None:
    """Fire-and-forget welcome email via Resend. Never raises — logged on failure."""
    if not RESEND_API_KEY:
        logger.warning("RESEND_API_KEY not set — skipping welcome email")
        return
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(
                "https://api.resend.com/emails",
                headers={
                    "Authorization": f"Bearer {RESEND_API_KEY}",
                    "Content-Type": "application/json",
                },
                json={
                    "from": "Tejas from RACK <tejas@rackx.app>",
                    "to": [email],
                    "subject": "Welcome to RACK, your job search just got automated 🤖",
                    "html": _build_welcome_html(display_name),
                },
            )
        if resp.status_code == 200:
            logger.info(f"Welcome email sent to {email}")
        else:
            logger.warning(f"Resend returned {resp.status_code} for {email}: {resp.text}")
    except Exception as e:
        logger.warning(f"Welcome email failed for {email}: {e}")


# ── User upsert ────────────────────────────────────────────────────────────────
async def _get_or_create_user(
    user_id: uuid.UUID,
    email: str,
    display_name: str | None,
    db: AsyncSession,
) -> User:
    """
    Fetch user from DB, creating them if this is their first login.
    Uses atomic INSERT ... ON CONFLICT DO NOTHING to prevent race conditions
    when multiple concurrent requests fire on first login simultaneously.
    """
    # Atomic upsert — only the first concurrent INSERT wins; others skip silently
    stmt = pg_insert(User).values(
        id=user_id,
        email=email,
        display_name=display_name,
    ).on_conflict_do_nothing(index_elements=["id"])

    result = await db.execute(stmt)
    is_new = result.rowcount == 1  # 1 = inserted, 0 = already existed

    await db.flush()

    if is_new:
        logger.info(f"Created new user: {user_id} ({email})")
        # Fire welcome email — non-blocking, never delays login response
        asyncio.create_task(_send_welcome_email(email, display_name))

    # Fetch the row (works whether we just inserted or it already existed)
    fetch_result = await db.execute(select(User).where(User.id == user_id))
    user = fetch_result.scalar_one()

    return user


# ── Main dependency ────────────────────────────────────────────────────────────
async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(_bearer_scheme),
    db: AsyncSession = Depends(get_db),
) -> User:
    """
    FastAPI dependency — verifies JWT and returns the current User ORM object.
    Inject this into any protected route.
    """
    payload = _verify_token(credentials.credentials)

    sub = payload.get("sub")
    if not sub:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token missing subject claim.",
        )

    try:
        user_id = uuid.UUID(sub)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid user ID in token.",
        )

    email = payload.get("email", "")
    user_metadata = payload.get("user_metadata", {}) or {}
    display_name = user_metadata.get("full_name") or user_metadata.get("name")

    user = await _get_or_create_user(user_id, email, display_name, db)

    if user.is_restricted:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Account restricted. Contact support.",
        )

    return user


# ── Routes ─────────────────────────────────────────────────────────────────────
@router.get("/me")
async def get_me(current_user: User = Depends(get_current_user)):
    """Return the current authenticated user's profile."""
    return {
        "id": str(current_user.id),
        "email": current_user.email,
        "display_name": current_user.display_name,
        "role": current_user.role or "free",
        "created_at": current_user.created_at.isoformat(),
    }