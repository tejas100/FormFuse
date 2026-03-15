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
import logging

import jwt as pyjwt
from jwt import PyJWKClient
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from db.database import get_db
from models.orm import User

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/auth", tags=["auth"])

# ── JWT config ─────────────────────────────────────────────────────────────────
SUPABASE_URL        = os.getenv("SUPABASE_URL")
SUPABASE_JWT_SECRET = os.getenv("SUPABASE_JWT_SECRET")

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


# ── User upsert ────────────────────────────────────────────────────────────────
async def _get_or_create_user(
    user_id: uuid.UUID,
    email: str,
    display_name: str | None,
    db: AsyncSession,
) -> User:
    """
    Fetch user from DB, creating them if this is their first login.
    This is the only place we write to the users table from auth.
    """
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()

    if user is None:
        user = User(
            id=user_id,
            email=email,
            display_name=display_name,
        )
        db.add(user)
        await db.flush()
        logger.info(f"Created new user: {user_id} ({email})")

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
    return user


# ── Routes ─────────────────────────────────────────────────────────────────────
@router.get("/me")
async def get_me(current_user: User = Depends(get_current_user)):
    """Return the current authenticated user's profile."""
    return {
        "id": str(current_user.id),
        "email": current_user.email,
        "display_name": current_user.display_name,
        "created_at": current_user.created_at.isoformat(),
    }