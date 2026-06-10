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


# ── Suppress noisy third-party loggers ───────────────────────────────────────
# httpx logs every single HTTP request at INFO — kills readability
# sentence_transformers + huggingface_hub log model load chatter + HF pings
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)
logging.getLogger("sentence_transformers").setLevel(logging.WARNING)
logging.getLogger("huggingface_hub").setLevel(logging.WARNING)
logging.getLogger("huggingface_hub.utils._http").setLevel(logging.ERROR)
logging.getLogger("faiss.loader").setLevel(logging.WARNING)
# ─────────────────────────────────────────────────────────────────────────────

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager

from routers import resumes, match, tracking, account, auth, chat, admin, apply, voice, command_center




@asynccontextmanager
async def lifespan(app: FastAPI):
    # Job board fetching and user scoring both run on MacBook via launchd.
    # run_fetching.py  — every 2 hours  (com.rack.fetching.plist)
    # run_matching.py  — 8am/1pm/8pm    (com.rack.matching.plist)
    # Render is a pure API server — no background jobs.
    yield


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
    allow_origins=[
        "http://localhost:5173",
        "https://rackx.app",
        "https://www.rackx.app",
        "https://rack-frontend.vercel.app",
        ],
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
app.include_router(apply.router)
app.include_router(voice.router)
app.include_router(command_center.router)  # /api/chat/command-center + /api/chat/history

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