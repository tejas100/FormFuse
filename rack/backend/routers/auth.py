"""
routers/auth.py — JWT verification + user dependency for FastAPI

Supabase issues JWTs signed with the Legacy HS256 secret.
Every protected route uses:

    current_user: User = Depends(get_current_user)

This dependency:
1. Extracts Bearer token from Authorization header
2. Verifies signature using SUPABASE_JWT_SECRET
3. Extracts user_id (sub claim) + email
4. Upserts a row in the users table (creates on first login)
5. Returns the User ORM object

Usage in a router:
    from routers.auth import get_current_user
    from models.orm import User

    @router.get("/me")
    async def get_me(current_user: User = Depends(get_current_user)):
        return {"id": str(current_user.id), "email": current_user.email}
"""

import os
import uuid
import logging

import jwt as pyjwt
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from db.database import get_db
from models.orm import User

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/auth", tags=["auth"])

# ── JWT config ─────────────────────────────────────────────────────────────────
SUPABASE_JWT_SECRET = os.getenv("SUPABASE_JWT_SECRET")

if not SUPABASE_JWT_SECRET:
    raise RuntimeError(
        "SUPABASE_JWT_SECRET is not set. Add it to your .env file."
    )

# HTTPBearer extracts the Authorization: Bearer <token> header automatically
_bearer_scheme = HTTPBearer(auto_error=True)


# ── Token verification ─────────────────────────────────────────────────────────
def _verify_token(token: str) -> dict:
    """
    Verify a Supabase JWT and return the decoded payload.
    Raises HTTPException 401 on any failure.
    """
    try:
        payload = pyjwt.decode(
            token,
            SUPABASE_JWT_SECRET,
            algorithms=["HS256"],
            options={"verify_aud": False},  # Supabase doesn't set aud by default
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
        # First login — create the user row
        user = User(
            id=user_id,
            email=email,
            display_name=display_name,
        )
        db.add(user)
        await db.flush()  # Get the row into the session without committing yet
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

    Example:
        @router.get("/resumes")
        async def list_resumes(current_user: User = Depends(get_current_user)):
            ...
    """
    payload = _verify_token(credentials.credentials)

    # Supabase puts the user UUID in the 'sub' claim
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
    # display_name may come from user_metadata
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