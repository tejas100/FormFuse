"""
chunker.py
Section-aware chunking: 256 tokens, 32 overlap.

Key design decision: chunks stay within their section boundary.
Skills text never bleeds into Education in vector space.
This improves retrieval quality for hybrid scoring.
"""

from typing import Dict, List


# Tunable parameters — logged to find optimal balance
CHUNK_SIZE = 256      # tokens per chunk
CHUNK_OVERLAP = 32    # overlap between consecutive chunks


def chunk_sections(sections: List[Dict], chunk_size: int = CHUNK_SIZE, overlap: int = CHUNK_OVERLAP) -> List[Dict]:
    """
    Chunk each section independently to preserve section boundaries.
    
    Args:
        sections: Output from section_parser.parse_sections()
        chunk_size: Max tokens per chunk
        overlap: Token overlap between chunks
    
    Returns:
        List of chunk dicts:
        [
            {
                "text": "chunk text...",
                "section": "skills",
                "weight": 1.0,
                "chunk_index": 0,
                "token_count": 245
            },
            ...
        ]
    """
    all_chunks = []

    for section in sections:
        section_text = section["text"]
        section_name = section["section"]
        section_weight = section["weight"]

        words = section_text.split()
        if not words:
            continue

        # Approximate: 1 token ≈ 0.75 words (conservative for English)
        # We use word-level splitting as a proxy for token splitting
        # For production, swap to tiktoken or the model's actual tokenizer
        words_per_chunk = int(chunk_size * 0.75)
        words_overlap = int(overlap * 0.75)

        if len(words) <= words_per_chunk:
            # Entire section fits in one chunk
            all_chunks.append({
                "text": section_text,
                "section": section_name,
                "weight": section_weight,
                "chunk_index": len(all_chunks),
                "token_count": _estimate_tokens(section_text),
            })
        else:
            # Slide window across the section
            start = 0
            while start < len(words):
                end = min(start + words_per_chunk, len(words))
                chunk_text = " ".join(words[start:end])

                all_chunks.append({
                    "text": chunk_text,
                    "section": section_name,
                    "weight": section_weight,
                    "chunk_index": len(all_chunks),
                    "token_count": _estimate_tokens(chunk_text),
                })

                # Move window forward
                start += words_per_chunk - words_overlap

                # Prevent infinite loop on tiny overlap
                if start >= len(words):
                    break

    return all_chunks


def _estimate_tokens(text: str) -> int:
    """Rough token estimate: ~1.33 tokens per word for English."""
    return int(len(text.split()) * 1.33)