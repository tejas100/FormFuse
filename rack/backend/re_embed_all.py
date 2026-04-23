"""
re_embed_all.py
One-time script to re-embed all existing resume chunks in Supabase
using OpenAI text-embedding-3-small (1536-dim).

Run AFTER the Alembic migration 20260423_embedding_1536 has been applied.

Usage:
    cd rack/backend
    python re_embed_all.py

What it does:
  1. Loads all resume_chunks rows that have embedding IS NULL
     (the migration dropped + re-added the column so all existing rows are NULL)
  2. Batches chunk texts and calls OpenAI embeddings API
  3. Updates each row with the new 1536-dim embedding vector
  4. Prints progress as it goes
"""

import asyncio
import os
import sys
from pathlib import Path

# Make sure backend modules are importable
sys.path.insert(0, str(Path(__file__).parent))

import httpx
import numpy as np
from dotenv import load_dotenv

load_dotenv()

DATABASE_URL = os.environ["DATABASE_URL"]
OPENAI_API_KEY = os.environ["OPENAI_API_KEY"]
BATCH_SIZE = 50  # chunks per OpenAI API call


async def get_all_null_chunks(conn):
    """Fetch all chunk IDs + texts where embedding is NULL."""
    result = await conn.execute(
        "SELECT id::text, chunk_text FROM resume_chunks WHERE embedding IS NULL ORDER BY id"
    )
    return result.fetchall()


async def embed_batch(texts: list) -> list:
    """Call OpenAI embeddings API for a batch of texts."""
    async with httpx.AsyncClient() as client:
        response = await client.post(
            "https://api.openai.com/v1/embeddings",
            headers={
                "Authorization": f"Bearer {OPENAI_API_KEY}",
                "Content-Type": "application/json",
            },
            json={
                "model": "text-embedding-3-small",
                "input": texts,
            },
            timeout=60.0,
        )
    response.raise_for_status()
    data = response.json()
    items = sorted(data["data"], key=lambda x: x["index"])
    return [item["embedding"] for item in items]


async def main():
    from sqlalchemy.ext.asyncio import create_async_engine
    from sqlalchemy import text

    engine = create_async_engine(DATABASE_URL, echo=False)

    async with engine.connect() as conn:
        print("[re_embed] Fetching chunks with NULL embeddings...")
        rows = await conn.execute(
            text("SELECT id::text, chunk_text FROM resume_chunks WHERE embedding IS NULL ORDER BY id")
        )
        chunks = rows.fetchall()

        if not chunks:
            print("[re_embed] No NULL embeddings found — nothing to do.")
            return

        print(f"[re_embed] Found {len(chunks)} chunks to re-embed.")

        total = len(chunks)
        done = 0

        for i in range(0, total, BATCH_SIZE):
            batch = chunks[i:i + BATCH_SIZE]
            ids = [row[0] for row in batch]
            texts = [row[1] for row in batch]

            print(f"[re_embed] Embedding batch {i//BATCH_SIZE + 1} ({len(batch)} chunks)...")
            embeddings = await embed_batch(texts)

            # Normalize
            arr = np.array(embeddings, dtype=np.float32)
            norms = np.linalg.norm(arr, axis=1, keepdims=True)
            norms = np.where(norms == 0, 1, norms)
            arr = arr / norms

            # Update each row
            for chunk_id, embedding in zip(ids, arr.tolist()):
                vec_str = "[" + ",".join(str(x) for x in embedding) + "]"
                await conn.execute(
                    text("UPDATE resume_chunks SET embedding = :vec ::vector WHERE id = :id ::uuid"),
                    {"vec": vec_str, "id": chunk_id}
                )

            await conn.commit()
            done += len(batch)
            print(f"[re_embed] Progress: {done}/{total} chunks updated.")

        print(f"[re_embed] Done. {total} chunks re-embedded with text-embedding-3-small (1536-dim).")

    await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())