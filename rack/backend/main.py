from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from routers import match, resumes

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],  # Vite dev port
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(match.router,   prefix="/api")
app.include_router(resumes.router, prefix="/api")