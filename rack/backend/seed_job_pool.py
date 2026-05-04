"""
seed_job_pool.py — One-time script to populate the Postgres job_pool table
from the existing local job_pool.json file.

Run from backend/ directory:
    python3 seed_job_pool.py

Safe to run multiple times — uses ON CONFLICT DO UPDATE (upsert).
"""

import json
import os
import sys
from datetime import datetime, timezone
from urllib.parse import urlparse, unquote

import psycopg2
from dotenv import load_dotenv

load_dotenv(".env")

POOL_PATH = "uploads/watchlist/job_pool.json"

def main():
    print(f"Reading {POOL_PATH}...")
    with open(POOL_PATH) as f:
        data = json.load(f)

    jobs = data.get("jobs", [])
    print(f"Loaded {len(jobs)} jobs from local file")

    db_url = os.environ["DATABASE_URL_DIRECT"]
    parsed   = urlparse(db_url.replace("postgresql+psycopg2://", "postgresql://"))
    password = unquote(parsed.password or "")

    print("Connecting to Postgres...")
    conn = psycopg2.connect(
        host=parsed.hostname,
        port=parsed.port or 5432,
        dbname=parsed.path.lstrip("/"),
        user=parsed.username,
        password=password,
        sslmode="require",
    )
    cur = conn.cursor()

    upsert_sql = """
        INSERT INTO job_pool (
            job_id, source, external_id, title, company, location, url,
            description_text, posted_at, department, commitment,
            board_token, fetched_at, is_active
        ) VALUES (
            %(job_id)s, %(source)s, %(external_id)s, %(title)s, %(company)s,
            %(location)s, %(url)s, %(description_text)s, %(posted_at)s,
            %(department)s, %(commitment)s, %(board_token)s, %(fetched_at)s, TRUE
        )
        ON CONFLICT (job_id) DO UPDATE SET
            title            = EXCLUDED.title,
            company          = EXCLUDED.company,
            location         = EXCLUDED.location,
            url              = EXCLUDED.url,
            description_text = EXCLUDED.description_text,
            posted_at        = EXCLUDED.posted_at,
            department       = EXCLUDED.department,
            commitment       = EXCLUDED.commitment,
            board_token      = EXCLUDED.board_token,
            fetched_at       = EXCLUDED.fetched_at,
            is_active        = TRUE
    """

    now = datetime.now(timezone.utc)
    rows = []
    skipped = 0

    for j in jobs:
        posted_raw = j.get("posted_at")
        try:
            posted_dt = datetime.fromisoformat(
                posted_raw.replace("Z", "+00:00")
            ) if posted_raw else None
        except Exception:
            posted_dt = None

        if not j.get("job_id") or not j.get("title"):
            skipped += 1
            continue

        rows.append({
            "job_id":           j["job_id"],
            "source":           j.get("source", ""),
            "external_id":      j.get("external_id", ""),
            "title":            j.get("title", ""),
            "company":          j.get("company", ""),
            "location":         j.get("location", "Not specified"),
            "url":              j.get("url", ""),
            "description_text": j.get("description_text", ""),
            "posted_at":        posted_dt,
            "department":       j.get("department", ""),
            "commitment":       j.get("commitment", ""),
            "board_token":      j.get("board_token", ""),
            "fetched_at":       now,
        })

    print(f"Upserting {len(rows)} rows (skipped {skipped} malformed)...")

    BATCH = 500
    for i in range(0, len(rows), BATCH):
        batch = rows[i:i+BATCH]
        cur.executemany(upsert_sql, batch)
        conn.commit()
        print(f"  {min(i+BATCH, len(rows))}/{len(rows)} rows committed")

    cur.execute("SELECT COUNT(*) FROM job_pool WHERE is_active = TRUE")
    count = cur.fetchone()[0]
    cur.close()
    conn.close()

    print(f"\nDone. job_pool table now has {count} active rows.")

if __name__ == "__main__":
    main()