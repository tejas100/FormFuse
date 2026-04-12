"""
main.py — FastAPI entry point for Rack backend
CORS configured for localhost:5173 (Vite dev server)

Admin dashboard: http://localhost:8000/admin
  - HTTP Basic Auth (username: admin, password: ADMIN_SECRET from .env)
  - Localhost-only — blocked for any external IP
"""

from dotenv import load_dotenv
load_dotenv()

import logging
logging.basicConfig(level=logging.INFO)

# ── File logging ──────────────────────────────────────────────────────────────
file_handler = logging.FileHandler("rack.log", mode="a")
file_handler.setLevel(logging.DEBUG)
file_handler.setFormatter(logging.Formatter(
    "%(asctime)s %(levelname)s %(name)s: %(message)s"
))
logging.getLogger().addHandler(file_handler)
# ─────────────────────────────────────────────────────────────────────────────

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager

from routers import resumes, match, tracking, account, auth, chat, admin


# ── Scheduler setup ───────────────────────────────────────────────────────────
async def _start_scheduler():
    try:
        from apscheduler.schedulers.asyncio import AsyncIOScheduler
        from services.auto_match import run_pipeline_for_all_users

        scheduler = AsyncIOScheduler(timezone="UTC")
        scheduler.add_job(
            run_pipeline_for_all_users,
            trigger="interval",
            minutes=60,
            id="auto_pipeline",
            replace_existing=True,
            max_instances=1,          # Never run two scheduler jobs concurrently
            misfire_grace_time=120,   # If server was down, skip missed fires > 2 min late
        )
        scheduler.start()

        # Fire once immediately on startup so users don't wait 30 min for first run
        import asyncio
        asyncio.create_task(run_pipeline_for_all_users())

        logging.getLogger(__name__).info("[Scheduler] APScheduler started — 60-min pipeline interval")
        return scheduler
    except ImportError:
        logging.getLogger(__name__).warning(
            "[Scheduler] APScheduler not installed — background pipeline disabled. "
            "Run: pip install apscheduler"
        )
        return None


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    scheduler = await _start_scheduler()
    yield
    # Shutdown
    if scheduler:
        scheduler.shutdown(wait=False)


app = FastAPI(
    title="Rack — Career Intelligence API",
    version="0.1.0",
    description="AI-powered resume matching and career tracking",
    lifespan=lifespan,
)

# CORS — allow Vite dev server only
# Admin dashboard is server-rendered at /admin — no CORS needed for it
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Public API routers ────────────────────────────────────────────────────────
app.include_router(resumes.router)
app.include_router(match.router)
app.include_router(tracking.router)
app.include_router(account.router)
app.include_router(auth.router)
app.include_router(chat.router)

# ── Admin dashboard — localhost only, HTTP Basic Auth ─────────────────────────
# Accessible at: http://localhost:8000/admin
# Never expose port 8000 publicly — keep it 127.0.0.1 bound in production
app.include_router(admin.router)


@app.get("/")
async def root():
    return {"status": "ok", "service": "rack-backend"}


@app.get("/health")
async def health():
    return {"status": "healthy"}