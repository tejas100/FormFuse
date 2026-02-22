"""
main.py — FastAPI entry point for Rack backend
CORS configured for localhost:5173 (Vite dev server)
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from routers import resumes, match

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


@app.get("/")
async def root():
    return {"status": "ok", "service": "rack-backend"}


@app.get("/health")
async def health():
    return {"status": "healthy"}