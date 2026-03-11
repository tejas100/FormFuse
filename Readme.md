<div align="center">

# ⚡ RACK AI
### Resume-Aware Candidate Kernel

**The AI-powered job search platform that works both ways.**  
Find the right jobs for your resume. Send the right resume for every job.

<br/>

![Tech](https://img.shields.io/badge/React_19-20232A?style=for-the-badge&logo=react&logoColor=61DAFB)
![FastAPI](https://img.shields.io/badge/FastAPI-005571?style=for-the-badge&logo=fastapi)
![OpenAI](https://img.shields.io/badge/GPT--4o--mini-412991?style=for-the-badge&logo=openai&logoColor=white)
![License](https://img.shields.io/badge/license-Proprietary-red?style=for-the-badge)

</div>

---

## What is RACK?

Most job search tools solve one problem: *find jobs*. Most resume tools solve the other: *improve your resume*. RACK solves both — simultaneously, intelligently, and with the same AI pipeline.

RACK is a two-sided matching platform:

- **→ You paste a job description.** RACK ranks all your resumes by fit, explains exactly why each one scores the way it does, and tells you which to send.
- **← We fetch jobs for you.** RACK automatically pulls fresh postings from top tech companies and ranks them against your profile and all the uploaded resumes in your profile — so the best opportunities surface, not just the newest ones.

No more guesswork. No more spray-and-pray. No more wondering if your resume is landing.

---

## The Two-Sided Problem RACK Solves

```
Traditional approach:                RACK approach:
┌─────────────────────────┐          ┌──────────────────────────────────────────┐
│  Job Board → You apply  │          │  RACK fetches jobs → AI ranks by fit     │
│  with same resume every │    VS    │  You paste JD → AI ranks your resumes    │
│  time, hope for the best│          │  You always know the score, literally    │
└─────────────────────────┘          └──────────────────────────────────────────┘
```

---

## Core Features

### 🎯 Resume-to-JD Matching
Paste any job description. RACK instantly scores all your uploaded resumes against it using a multi-phase AI pipeline — semantic search to shortlist, then deep LLM analysis across three dimensions:

- **Skills Fit** — how well your technical skills align with requirements
- **Experience Fit** — seniority and domain depth match
- **Trajectory Fit** — career arc alignment with the role's growth path

Each result includes key strengths, gaps, and a direct hire recommendation. You see the AI work in real time.

### 🔄 Auto Matches
Set your profile once. RACK does the rest.

- Automatically scans top tech company job boards daily
- Ranks results by a blend of match quality and recency — freshness is a tiebreaker, not the gate
- Archive jobs permanently — they never resurface
- Curated signal, not firehose volume

### 📋 Job Tracking Board
- Unified view of Auto Matches and your saved Watchlist
- Archive, save, and organize postings
- Location-aware filtering

---

## AI Scoring

RACK uses a two-phase pipeline to balance speed and accuracy:

**Phase 1 — Semantic Shortlisting**
Vector search narrows the candidate pool to only genuinely relevant matches, fast.

**Phase 2 — LLM Deep Scoring**
GPT-4o-mini holistically evaluates each resume×job pair and returns structured scores, reasoning, and a recommendation tier.

**Recommendation tiers:**

| Score | Tier |
|-------|------|
| ≥ 85 | 🟢 Strong Match |
| ≥ 65 | 🔵 Good Match |
| ≥ 50 | 🟡 Partial Match |
| < 50 | 🔴 Poor Match |

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 19 + Vite + Tailwind CSS |
| Backend | FastAPI (Python) |
| Vector Search | FAISS + sentence embeddings |
| LLM Scoring | GPT-4o-mini (OpenAI) |
| Job Data | Curated tech company job boards |

---

## Mobile-First Design

RACK is built for real-world use — including on your phone.

- Smooth animations and gradient UI
- Full iOS viewport fix (no browser chrome clipping)
- Cards expand cleanly, titles never truncate
- Bottom safe-area padding for notched devices

---

## Getting Started

### Prerequisites
- Node.js 18+
- Python 3.10+
- OpenAI API key

### Frontend
```bash
cd rack/frontend
npm install
npm run dev
```

### Backend
```bash
cd rack/backend
pip install -r requirements.txt
uvicorn main:app --reload
```

### Environment Variables
```env
OPENAI_API_KEY=your_key_here
```

---

## Roadmap

- [ ] Outcome feedback loop — applied → interview → offer signals feed back into match ranking
- [ ] Expanded job sources
- [ ] Resume gap coaching based on match analysis
- [ ] Mobile polish across all pages

---

## Why RACK?

Recruiters have ATS systems that score resumes against job descriptions automatically. Candidates are flying blind. RACK gives you the same scoring intelligence — so you know before you apply whether your resume is a fit, and exactly which version to send.

**Resume-Aware Candidate Kernel** — the intelligent core that connects the right resume to the right job, every time.

---

## License

This software is proprietary and confidential. See [LICENSE](./LICENSE) for details.
Unauthorized use, copying, or distribution is strictly prohibited.

---

<div align="center">
  <sub>© 2026 Tejas B K · All Rights Reserved</sub>
</div>