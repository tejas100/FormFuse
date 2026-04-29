"""
services/steel_client.py — Steel browser-as-a-service session management

Creates and releases Steel-hosted browser sessions using the official steel-sdk.

Key facts:
  - Use AsyncSteel from steel-sdk (pip install steel-sdk) — NOT raw httpx.
    Raw httpx field names ("sessionTimeout", wsUrl) are wrong and caused failures.
  - session.websocket_url  → CDP endpoint for Playwright
  - session.session_viewer_url → Steel's own dashboard (https://app.steel.dev/sessions/...)
    This URL REQUIRES the user to authenticate with Steel. It is NOT embeddable
    in an iframe on the free tier. We intentionally return live_view_url="" to
    prevent the frontend from trying to render it.
  - Release: await client.sessions.release(session_id)
"""

import logging
import os

logger = logging.getLogger(__name__)

# 15 minutes in ms
SESSION_TIMEOUT_MS = 900_000


def _api_key() -> str:
    key = os.environ.get("STEEL_API_KEY", "")
    if not key:
        raise RuntimeError("STEEL_API_KEY not set in environment")
    return key


async def create_session() -> dict:
    """
    Create a Steel browser session via steel-sdk.

    Returns dict with:
        session_id    — Steel session UUID string
        ws_url        — CDP WebSocket endpoint for Playwright
        live_view_url — always "" on free tier (Steel dashboard is not embeddable)
    """
    from steel import AsyncSteel

    api_key = _api_key()
    client = AsyncSteel(steel_api_key=api_key)
    session = await client.sessions.create(timeout=SESSION_TIMEOUT_MS)

    session_id = str(session.id)

    # The SDK's session.websocket_url omits the apiKey query param, causing a 502.
    # Always construct the CDP URL manually — this is the correct Steel format.
    ws_url = f"wss://connect.steel.dev?apiKey={api_key}&sessionId={session_id}"

    # session.debug_url is the embeddable live viewer URL (WebRTC, 25fps, no auth required).
    # Works on all plans including free. Embed with ?interactive=false for read-only watch mode.
    # DO NOT use session.session_viewer_url — that requires Steel dashboard login.
    debug_url = str(session.debug_url) if session.debug_url else ""
    logger.info(f"[steel] Session created — id={session_id} debug_url={debug_url}")

    return {
        "session_id":    session_id,
        "ws_url":        ws_url,
        "live_view_url": debug_url,
    }


async def release_session(session_id: str) -> None:
    """
    Release a Steel session when the agent is done.
    Frees browser-hour quota immediately rather than waiting for timeout.
    """
    from steel import AsyncSteel

    try:
        client = AsyncSteel(steel_api_key=_api_key())
        await client.sessions.release(session_id)
        logger.info(f"[steel] Session {session_id} released")
    except Exception as e:
        # Non-fatal — session will timeout on its own after SESSION_TIMEOUT_MS
        logger.warning(f"[steel] Could not release session {session_id}: {e}")