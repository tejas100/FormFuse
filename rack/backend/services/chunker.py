"""
chunker.py
Section-aware chunking: 50 tokens target, 15 overlap.

Design goals:
  - ~20 chunks for a typical 1-page resume (~400–500 words)
  - ~30–40 chunks for a 2-page resume
  - Each chunk covers ONE idea: a job role, a skill cluster, a project, a degree
  - Smaller chunks = sharper embeddings = pgvector retrieves the RIGHT passage
  - Section boundaries are never crossed — skills text never bleeds into education

Chunk size math (1-page resume, ~450 words):
  words_per_chunk  = 50 * 0.75 = ~37 words
  words_overlap    = 15 * 0.75 = ~11 words
  effective step   = 37 - 11   = ~26 words per slide
  450 words ÷ 26   ≈ 17–22 chunks  ✓

Why not larger chunks (e.g. 256 tokens)?
  - 256-token chunks on a 1-page resume ≈ 5–8 chunks total
  - pgvector returns a blob covering half the resume instead of one specific skill
  - A perfect candidate can score 45% because the wrong 4 chunks were retrieved
"""

from typing import Dict, List


# ── Tunables ──────────────────────────────────────────────────────────────────
CHUNK_SIZE    = 50   # tokens per chunk  (was 256 → 80 → 50)
CHUNK_OVERLAP = 15   # overlap tokens    (was 32  → 20 → 15)

# Minimum word count to bother creating a chunk.
# Prevents header-only chunks ("EDUCATION", "SKILLS") from polluting the index.
MIN_CHUNK_WORDS = 6


def chunk_sections(
    sections: List[Dict],
    chunk_size: int = CHUNK_SIZE,
    overlap: int = CHUNK_OVERLAP,
) -> List[Dict]:
    """
    Chunk each section independently to preserve section boundaries.

    Args:
        sections:   Output from section_parser.parse_sections()
        chunk_size: Max tokens per chunk
        overlap:    Token overlap between consecutive chunks

    Returns:
        List of chunk dicts:
        [
            {
                "text":        "chunk text...",
                "section":     "experience",
                "weight":      1.0,
                "chunk_index": 0,
                "token_count": 48,
            },
            ...
        ]

    Typical output sizes (50-token target):
        1-page resume  (~450 words):  ~17–22 chunks
        1.5-page resume (~650 words): ~25–30 chunks
        2-page resume  (~900 words):  ~32–42 chunks
    """
    all_chunks: List[Dict] = []

    # Approximate: 1 token ≈ 0.75 words for English prose.
    words_per_chunk = max(1, int(chunk_size * 0.75))    # ~37 words at default
    words_overlap   = max(0, int(overlap   * 0.75))     # ~11 words at default

    for section in sections:
        section_text   = section.get("text", "").strip()
        section_name   = section.get("section", "other")
        section_weight = section.get("weight", 1.0)

        words = section_text.split()
        if len(words) < MIN_CHUNK_WORDS:
            # Skip near-empty sections (just a heading, or a single line)
            continue

        if len(words) <= words_per_chunk:
            # Entire section fits in one chunk — no splitting needed
            all_chunks.append({
                "text":        section_text,
                "section":     section_name,
                "weight":      section_weight,
                "chunk_index": len(all_chunks),
                "token_count": _estimate_tokens(section_text),
            })
        else:
            # Sliding window across the section
            start = 0
            while start < len(words):
                end         = min(start + words_per_chunk, len(words))
                chunk_words = words[start:end]

                if len(chunk_words) >= MIN_CHUNK_WORDS:
                    chunk_text = " ".join(chunk_words)
                    all_chunks.append({
                        "text":        chunk_text,
                        "section":     section_name,
                        "weight":      section_weight,
                        "chunk_index": len(all_chunks),
                        "token_count": _estimate_tokens(chunk_text),
                    })

                start += words_per_chunk - words_overlap

                # Safety: prevent infinite loop if overlap >= chunk size
                if words_overlap >= words_per_chunk:
                    break

    return all_chunks


def _estimate_tokens(text: str) -> int:
    """Rough token estimate: ~1.33 tokens per word for English."""
    return int(len(text.split()) * 1.33)