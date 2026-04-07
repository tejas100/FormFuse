"""
main.py — FastAPI entry point for Rack backend
CORS configured for localhost:5173 (Vite dev server)
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

from routers import resumes, match, tracking, account, auth, chat

app = FastAPI(
    title="Rack — Career Intelligence API",
    version="0.1.0",
    description="AI-powered resume matching and career tracking",
)

# CORS — allow Vite dev server
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Routers
app.include_router(resumes.router)
app.include_router(match.router)
app.include_router(tracking.router)
app.include_router(account.router)
app.include_router(auth.router)
app.include_router(chat.router)


@app.get("/")
async def root():
    return {"status": "ok", "service": "rack-backend"}


@app.get("/health")
async def health():
    return {"status": "healthy"}