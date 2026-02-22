"""
resumes.py — Router for resume CRUD operations

POST   /api/resumes/upload   → upload file, run ingestion pipeline
GET    /api/resumes           → list all resumes
GET    /api/resumes/{id}      → get single resume with full details
DELETE /api/resumes/{id}      → delete resume + file
GET    /api/resumes/{id}/file → serve the original file for viewing
"""

import os
import shutil
import uuid
from pathlib import Path

from fastapi import APIRouter, UploadFile, File, HTTPException
from fastapi.responses import FileResponse

from services.ingestion import (
    ingest_resume,
    get_all_resumes,
    get_resume_by_id,
    delete_resume,
    UPLOADS_DIR,
)

router = APIRouter(prefix="/api/resumes", tags=["resumes"])

ALLOWED_EXTENSIONS = {".pdf", ".doc", ".docx"}


@router.post("/upload")
async def upload_resume(file: UploadFile = File(...)):
    """Upload a resume file, save to disk, and run ingestion pipeline."""
    
    # Validate file extension
    ext = Path(file.filename).suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=400, detail=f"File type {ext} not allowed. Use PDF or DOCX.")
    
    # Generate unique filename to avoid collisions
    unique_name = f"{uuid.uuid4().hex[:12]}_{file.filename}"
    file_path = UPLOADS_DIR / unique_name
    
    # Save file to disk
    try:
        with open(file_path, "wb") as buffer:
            content = await file.read()
            buffer.write(content)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to save file: {str(e)}")
    
    # Run ingestion pipeline
    try:
        resume_record = ingest_resume(str(file_path), file.filename)
    except Exception as e:
        # Clean up file if ingestion fails
        if file_path.exists():
            os.remove(file_path)
        raise HTTPException(status_code=500, detail=f"Ingestion failed: {str(e)}")
    
    return {
        "status": "success",
        "message": f"Resume '{resume_record['name']}' uploaded and processed.",
        "resume": {
            "id": resume_record["id"],
            "name": resume_record["name"],
            "original_filename": resume_record["original_filename"],
            "file_ext": resume_record["file_ext"],
            "status": resume_record["status"],
            "uploaded_at": resume_record["uploaded_at"],
            "skills": resume_record["skills"],
            "chunk_count": resume_record["chunk_count"],
            "section_count": resume_record["section_count"],
        },
    }


@router.get("")
async def list_resumes():
    """List all uploaded resumes (metadata only)."""
    resumes = get_all_resumes()
    return {"resumes": resumes}


@router.get("/{resume_id}")
async def get_resume(resume_id: str):
    """Get full resume details including chunks."""
    resume = get_resume_by_id(resume_id)
    if not resume:
        raise HTTPException(status_code=404, detail="Resume not found")
    return {"resume": resume}


@router.delete("/{resume_id}")
async def remove_resume(resume_id: str):
    """Delete a resume and its file."""
    success = delete_resume(resume_id)
    if not success:
        raise HTTPException(status_code=404, detail="Resume not found")
    return {"status": "success", "message": "Resume deleted."}


@router.get("/{resume_id}/file")
async def serve_resume_file(resume_id: str):
    """Serve the original resume file for viewing/download."""
    resume = get_resume_by_id(resume_id)
    if not resume:
        raise HTTPException(status_code=404, detail="Resume not found")
    
    file_path = resume.get("file_path")
    if not file_path or not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="File not found on disk")
    
    # Determine media type
    ext = resume.get("file_ext", ".pdf")
    media_types = {
        ".pdf": "application/pdf",
        ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ".doc": "application/msword",
    }
    media_type = media_types.get(ext, "application/octet-stream")
    
    return FileResponse(
        path=file_path,
        filename=resume["original_filename"],
        media_type=media_type,
    )