"""
routers/resumes.py — Resume CRUD, dual-mode (anonymous + authenticated)

Anonymous mode  (no JWT):
  - Upload runs ingestion pipeline in-memory
  - Returns resume data + base64 file for localStorage storage on frontend
  - No DB writes, no Storage uploads

Authenticated mode (valid JWT):
  - Upload saves PDF to Supabase Storage
  - Writes Resume + ResumeChunk rows to Postgres
  - All endpoints scoped to current_user.id

Endpoints:
  POST   /api/resumes/upload          → upload + ingest (anon or auth)
  GET    /api/resumes                 → list resumes (auth only)
  GET    /api/resumes/{id}            → single resume detail (auth only)
  DELETE /api/resumes/{id}            → delete resume + storage file (auth only)
  GET    /api/resumes/{id}/file       → serve file (auth only, signed URL)
  POST   /api/resumes/migrate         → bulk migrate localStorage resumes on sign-in
"""

import base64
import logging
import os
import uuid
from pathlib import Path
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from db.database import get_db
from models.orm import Resume, ResumeChunk
from routers.auth import get_current_user
from services.ingestion import ingest_resume_bytes

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/resumes", tags=["resumes"])

ALLOWED_EXTENSIONS = {".pdf", ".doc", ".docx"}
MAX_RESUMES_ANON = 5
MAX_RESUMES_AUTH = 5

# Supabase Storage config
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY")
STORAGE_BUCKET = "resumes"

# Optional bearer — won't error if missing (anonymous users)
_optional_bearer = HTTPBearer(auto_error=False)


# ── Supabase Storage helpers ──────────────────────────────────────────────────

async def _upload_to_storage(user_id: uuid.UUID, filename: str, content: bytes, content_type: str) -> str:
    """
    Upload a file to Supabase Storage.
    Returns the storage path (e.g. 'user-uuid/filename.pdf').
    """
    storage_path = f"{user_id}/{filename}"
    url = f"{SUPABASE_URL}/storage/v1/object/{STORAGE_BUCKET}/{storage_path}"

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            url,
            content=content,
            headers={
                "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
                "Content-Type": content_type,
                "x-upsert": "true",  # overwrite if same filename
            },
        )
        if resp.status_code not in (200, 201):
            logger.error(f"Storage upload failed: {resp.status_code} {resp.text}")
            raise HTTPException(status_code=500, detail="Failed to upload file to storage.")

    return storage_path


async def _get_signed_url(storage_path: str, expires_in: int = 3600) -> str:
    """
    Generate a signed URL for a private storage file.
    expires_in: seconds until URL expires (default 1 hour).
    """
    url = f"{SUPABASE_URL}/storage/v1/object/sign/{STORAGE_BUCKET}/{storage_path}"

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            url,
            json={"expiresIn": expires_in},
            headers={
                "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
                "Content-Type": "application/json",
            },
        )
        if resp.status_code != 200:
            raise HTTPException(status_code=500, detail="Failed to generate signed URL.")
        data = resp.json()
        return f"{SUPABASE_URL}/storage/v1{data['signedURL']}"


async def _delete_from_storage(storage_path: str) -> None:
    """Delete a file from Supabase Storage."""
    url = f"{SUPABASE_URL}/storage/v1/object/{STORAGE_BUCKET}/{storage_path}"

    async with httpx.AsyncClient() as client:
        await client.delete(
            url,
            headers={"Authorization": f"Bearer {SUPABASE_SERVICE_KEY}"},
        )


# ── Anonymous upload ──────────────────────────────────────────────────────────

@router.post("/upload")
async def upload_resume(
    file: UploadFile = File(...),
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(_optional_bearer),
    db: AsyncSession = Depends(get_db),
):
    """
    Upload and ingest a resume.

    - Anonymous: ingest in-memory, return data + base64 file for localStorage.
    - Authenticated: ingest, save to Supabase Storage, write to DB.
    """
    ext = Path(file.filename).suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"File type '{ext}' not allowed. Use PDF or DOCX.",
        )

    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="Uploaded file is empty.")

    # ── Try to get authenticated user (optional) ──────────────────────────
    current_user = None
    if credentials and credentials.credentials:
        try:
            from routers.auth import get_current_user as _get_user
            # Build a minimal dependency manually since we're in a conditional path
            from fastapi.security import HTTPAuthorizationCredentials as Creds
            current_user = await _get_user(credentials=credentials, db=db)
        except HTTPException:
            current_user = None  # Token invalid — treat as anonymous

    # ── Run ingestion pipeline ────────────────────────────────────────────
    # ingest_resume_bytes() is the same pipeline as before but takes bytes
    # instead of a file path. See services/ingestion.py for the signature.
    try:
        resume_data = ingest_resume_bytes(content, file.filename)
    except Exception as e:
        logger.error(f"Ingestion failed for {file.filename}: {e}")
        raise HTTPException(status_code=500, detail=f"Ingestion failed: {str(e)}")

    content_type_map = {
        ".pdf": "application/pdf",
        ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ".doc": "application/msword",
    }
    content_type = content_type_map.get(ext, "application/octet-stream")

    # ── Anonymous path ────────────────────────────────────────────────────
    if current_user is None:
        file_b64 = base64.b64encode(content).decode("utf-8")
        return {
            "status": "success",
            "mode": "anonymous",
            "message": f"Resume '{resume_data['name']}' processed. Sign in to save permanently.",
            "resume": {
                "id": resume_data["id"],
                "name": resume_data["name"],
                "original_filename": file.filename,
                "file_ext": ext,
                "status": resume_data.get("status", "active"),
                "uploaded_at": resume_data.get("uploaded_at"),
                "skills": resume_data.get("skills", []),
                "chunk_count": resume_data.get("chunk_count", 0),
                "section_count": resume_data.get("section_count", 0),
                "years_exp": resume_data.get("years_exp"),
                "titles": resume_data.get("titles", []),
                "domains": resume_data.get("domains", []),
                # base64 file stored in localStorage for session handoff on sign-in
                "fileBase64": file_b64,
                "fileType": content_type,
            },
        }

    # ── Authenticated path ────────────────────────────────────────────────

    # Check resume cap
    result = await db.execute(
        select(Resume).where(
            Resume.user_id == current_user.id,
            Resume.status == "active",
        )
    )
    existing = result.scalars().all()
    if len(existing) >= MAX_RESUMES_AUTH:
        raise HTTPException(
            status_code=400,
            detail=f"You've reached the maximum of {MAX_RESUMES_AUTH} resumes. Delete one to upload another.",
        )

    # Upload to Supabase Storage
    unique_filename = f"{uuid.uuid4().hex[:8]}_{file.filename}"
    storage_path = await _upload_to_storage(
        current_user.id, unique_filename, content, content_type
    )

    # Write Resume row
    resume_id = uuid.UUID(resume_data["id"]) if isinstance(resume_data["id"], str) else resume_data["id"]
    db_resume = Resume(
        id=resume_id,
        user_id=current_user.id,
        filename=file.filename,
        display_name=resume_data["name"],
        storage_path=storage_path,
        file_ext=ext,
        years_exp=resume_data.get("years_exp"),
        titles=resume_data.get("titles", []),
        domains=resume_data.get("domains", []),
        skills=resume_data.get("skills", []),
        chunk_count=resume_data.get("chunk_count", 0),
        section_count=resume_data.get("section_count", 0),
        status="active",
    )
    db.add(db_resume)

    # Write ResumeChunk rows
    chunks = resume_data.get("chunks", [])
    for chunk in chunks:
        db_chunk = ResumeChunk(
            resume_id=resume_id,
            user_id=current_user.id,
            chunk_index=chunk["chunk_index"],
            chunk_text=chunk["chunk_text"],
            embedding=chunk.get("embedding"),  # list of floats or None
        )
        db.add(db_chunk)

    await db.flush()

    logger.info(
        f"Resume '{file.filename}' uploaded for user {current_user.id} "
        f"({len(chunks)} chunks, storage: {storage_path})"
    )

    return {
        "status": "success",
        "mode": "authenticated",
        "message": f"Resume '{resume_data['name']}' uploaded and saved to your account.",
        "resume": {
            "id": str(resume_id),
            "name": resume_data["name"],
            "original_filename": file.filename,
            "file_ext": ext,
            "status": "active",
            "uploaded_at": db_resume.uploaded_at.isoformat(),
            "skills": resume_data.get("skills", []),
            "chunk_count": resume_data.get("chunk_count", 0),
            "section_count": resume_data.get("section_count", 0),
            "years_exp": resume_data.get("years_exp"),
            "titles": resume_data.get("titles", []),
            "domains": resume_data.get("domains", []),
        },
    }


# ── List resumes (auth only) ──────────────────────────────────────────────────

@router.get("")
async def list_resumes(
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """List all resumes for the authenticated user."""
    result = await db.execute(
        select(Resume)
        .where(Resume.user_id == current_user.id, Resume.status == "active")
        .order_by(Resume.uploaded_at.desc())
    )
    resumes = result.scalars().all()

    return {
        "resumes": [
            {
                "id": str(r.id),
                "name": r.display_name,
                "original_filename": r.filename,
                "file_ext": r.file_ext,
                "status": r.status,
                "uploaded_at": r.uploaded_at.isoformat(),
                "skills": r.skills or [],
                "chunk_count": r.chunk_count,
                "section_count": r.section_count,
                "years_exp": r.years_exp,
                "titles": r.titles or [],
                "domains": r.domains or [],
            }
            for r in resumes
        ]
    }


# ── Get single resume (auth only) ─────────────────────────────────────────────

@router.get("/{resume_id}")
async def get_resume(
    resume_id: str,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Get full resume details for the authenticated user."""
    try:
        rid = uuid.UUID(resume_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid resume ID.")

    result = await db.execute(
        select(Resume).where(Resume.id == rid, Resume.user_id == current_user.id)
    )
    resume = result.scalar_one_or_none()
    if not resume:
        raise HTTPException(status_code=404, detail="Resume not found.")

    return {
        "resume": {
            "id": str(resume.id),
            "name": resume.display_name,
            "original_filename": resume.filename,
            "file_ext": resume.file_ext,
            "status": resume.status,
            "uploaded_at": resume.uploaded_at.isoformat(),
            "skills": resume.skills or [],
            "chunk_count": resume.chunk_count,
            "section_count": resume.section_count,
            "years_exp": resume.years_exp,
            "titles": resume.titles or [],
            "domains": resume.domains or [],
        }
    }


# ── Delete resume (auth only) ─────────────────────────────────────────────────

@router.delete("/{resume_id}")
async def delete_resume(
    resume_id: str,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Delete a resume, its chunks, and its storage file."""
    try:
        rid = uuid.UUID(resume_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid resume ID.")

    result = await db.execute(
        select(Resume).where(Resume.id == rid, Resume.user_id == current_user.id)
    )
    resume = result.scalar_one_or_none()
    if not resume:
        raise HTTPException(status_code=404, detail="Resume not found.")

    # Delete from Supabase Storage (best-effort, don't fail if missing)
    if resume.storage_path:
        try:
            await _delete_from_storage(resume.storage_path)
        except Exception as e:
            logger.warning(f"Storage delete failed for {resume.storage_path}: {e}")

    # Delete DB row (cascades to resume_chunks)
    await db.delete(resume)
    await db.flush()

    logger.info(f"Resume {rid} deleted for user {current_user.id}")
    return {"status": "success", "message": "Resume deleted."}


# ── Serve file as signed URL (auth only) ──────────────────────────────────────

@router.get("/{resume_id}/file")
async def serve_resume_file(
    resume_id: str,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Return a short-lived signed URL to the resume file in Supabase Storage.
    Frontend can redirect to this URL or open it in a new tab.
    """
    try:
        rid = uuid.UUID(resume_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid resume ID.")

    result = await db.execute(
        select(Resume).where(Resume.id == rid, Resume.user_id == current_user.id)
    )
    resume = result.scalar_one_or_none()
    if not resume or not resume.storage_path:
        raise HTTPException(status_code=404, detail="File not found.")

    signed_url = await _get_signed_url(resume.storage_path)
    return {"url": signed_url, "filename": resume.filename}