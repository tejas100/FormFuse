import { useState, useRef, useEffect } from 'react'
import { useAuth } from '../context/AuthContext'

const mobileCardStyles = `
  @keyframes smoothExpand {
    from { opacity: 0; transform: translateY(-6px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  @media (max-width: 600px) {
    /* Result cards */
    .rack-card-collapsed-skills { display: none !important; }
    .rack-card-rank { font-size: 16px !important; min-width: 28px !important; }
    .rack-card-name { font-size: 14px !important; }
    .rack-card-score-num { font-size: 22px !important; }
    .rack-card-score-label { font-size: 11px !important; }
    .rack-card-badges { gap: 5px !important; margin-bottom: 5px !important; }
    .rack-card-row { gap: 10px !important; }
    .rack-card-padding { padding: 13px 14px !important; border-radius: 12px !important; }

    /* Input box stretch: fills remaining height when no results */
    .rack-input-box-stretch {
      flex: 1 !important;
      display: flex !important;
      flex-direction: column !important;
      min-height: 0 !important;
      max-height: none !important;
    }

    /* Input box: completely hidden on mobile when results are present — MUST be after stretch rule */
    .rack-input-hide-mobile { display: none !important; }

    /* JD Analysis: single scrollable row of chips */
    .rack-jd-chips {
      flex-wrap: nowrap !important;
      overflow-x: auto !important;
      -webkit-overflow-scrolling: touch !important;
      scrollbar-width: none !important;
      padding-bottom: 2px !important;
    }
    .rack-jd-chips::-webkit-scrollbar { display: none !important; }
    .rack-jd-chip {
      font-size: 10px !important;
      padding: 2px 8px !important;
      white-space: nowrap !important;
      flex-shrink: 0 !important;
    }

    /* Desktop job title above JD block: hide on mobile (title pill handles it) */
    .rack-jd-desktop-title { display: none !important; }

    /* Page root: flex column so input can stretch */
    .rack-page-root { overflow-y: hidden !important; }
    .rack-page-root.rack-no-results {
      display: flex !important;
      flex-direction: column !important;
    }
    .rack-page-root.rack-has-results {
      overflow-y: auto !important;
    }
    .rack-hero-block { flex-shrink: 0; }
    .rack-textarea-stretch {
      flex: 1 !important;
      min-height: 0 !important;
      max-height: none !important;
      height: 100% !important;
    }
  }

  @media (min-width: 601px) {
    /* Mobile title pill: hidden on desktop */
    .rack-mobile-title-pill { display: none !important; }
    /* Legacy mobile header: hidden on desktop */
    .rack-input-job-header { display: none !important; }
  }

  /* Smooth expand panel */
  .rack-expand-panel {
    animation: smoothExpand 0.35s cubic-bezier(0.22, 1, 0.36, 1) both;
  }`

function scoreColor(score) {
  if (score >= 85) return 'linear-gradient(90deg,#e8ff6b,#a3e635)'
  if (score >= 65) return 'linear-gradient(90deg,#60a5fa,#818cf8)'
  return 'linear-gradient(90deg,#f87171,#fb923c)'
}

function recommendationStyle(rec) {
  switch (rec) {
    case 'Strong Match': return { color: 'var(--accent3)', bg: 'rgba(52,211,153,0.12)', border: 'rgba(52,211,153,0.25)' }
    case 'Good Match':   return { color: 'var(--accent)',  bg: 'rgba(232,255,107,0.10)', border: 'rgba(232,255,107,0.22)' }
    case 'Partial Match':return { color: '#fb923c',        bg: 'rgba(251,146,60,0.10)',  border: 'rgba(251,146,60,0.22)' }
    default:             return { color: 'var(--danger)',  bg: 'rgba(248,113,113,0.10)', border: 'rgba(248,113,113,0.22)' }
  }
}

function componentBar(label, value, color) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px' }}>
      <span style={{ color: 'var(--text-dim)', minWidth: '80px', fontWeight: 500 }}>{label}</span>
      <div style={{ flex: 1, height: '4px', background: 'rgba(255,255,255,0.06)', borderRadius: '4px', overflow: 'hidden' }}>
        <div style={{ height: '100%', borderRadius: '4px', background: color, width: `${Math.round(value)}%`, transition: 'width 0.8s cubic-bezier(0.22,1,0.36,1)' }} />
      </div>
      <span style={{ color: 'var(--text-dim)', minWidth: '28px', textAlign: 'right', fontFamily: 'var(--font-display)', fontWeight: 600 }}>{Math.round(value)}</span>
    </div>
  )
}

/* ══════════════════════════════════════════════════════════════════
   JD MATCH PIPELINE ANIMATION — minimal ASCII pipeline status
   ══════════════════════════════════════════════════════════════════ */
const JD_STEPS = [
  { id: "parse",  label: "Parsing job description",      detail: "rule extractor + LLM hybrid · jd_parser.py"    },
  { id: "embed",  label: "Embedding & FAISS search",     detail: "all-MiniLM-L6-v2 · 384-dim · top_k=20"         },
  { id: "hybrid", label: "Hybrid scoring",               detail: "semantic + skills + experience + kw · 4-component" },
  { id: "llm",    label: "LLM deep score",               detail: "GPT-4o-mini · skills_fit / exp_fit / trajectory" },
  { id: "rank",   label: "Ranking results",              detail: "re-rank by llm_score · building response"       },
];

const JD_SPINNER = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];
const JD_STEP_COLOR = { llm: "#a78bfa" };

// uploadQueue: [{ name: string, status: 'queued'|'processing'|'done'|'error' }]
// When empty (authenticated users / no uploads needed), renders only the match pipeline — unchanged behaviour.
function JDPipelineAnimation({ uploadQueue = [] }) {
  const [stepIdx, setStep]    = useState(0);
  const [spinner, setSpinner] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [cursor,  setCursor]  = useState(true);

  // Only start pipeline steps once all uploads are done (or if no uploads)
  const uploadsActive = uploadQueue.length > 0 && uploadQueue.some(f => f.status !== 'done' && f.status !== 'error');
  const uploadsAllDone = uploadQueue.length === 0 || uploadQueue.every(f => f.status === 'done' || f.status === 'error');

  // Spinner tick
  useEffect(() => {
    const t = setInterval(() => setSpinner(f => (f + 1) % JD_SPINNER.length), 75);
    return () => clearInterval(t);
  }, []);

  // Cursor blink
  useEffect(() => {
    const t = setInterval(() => setCursor(c => !c), 520);
    return () => clearInterval(t);
  }, []);

  // Elapsed seconds
  useEffect(() => {
    const t = setInterval(() => setElapsed(e => e + 1), 1000);
    return () => clearInterval(t);
  }, []);

  // Pipeline steps — only advance when uploads are done
  useEffect(() => {
    if (!uploadsAllDone) return;
    const STEP_MS = [2500, 3000, 3500, 8000, 1500];
    if (stepIdx >= JD_STEPS.length - 1) return;
    const t = setTimeout(() => setStep(s => s + 1), STEP_MS[stepIdx]);
    return () => clearTimeout(t);
  }, [stepIdx, uploadsAllDone]);

  const mono = { fontFamily: "'JetBrains Mono','Fira Code','Courier New',monospace" };
  const acc  = "var(--accent)";
  const grn  = "#34d399";
  const red  = "#f87171";
  const dim  = "rgba(255,255,255,0.28)";

  // Progress bar: upload slots + pipeline steps
  const totalSlots  = uploadQueue.length + JD_STEPS.length;
  const doneUploads = uploadQueue.filter(f => f.status === 'done').length;
  const BAR_LEN     = 24;
  const progressNumerator = uploadsAllDone
    ? uploadQueue.length + stepIdx + 0.5
    : doneUploads + (uploadQueue.findIndex(f => f.status === 'processing') >= 0 ? 0.5 : 0);
  const filled     = Math.round((progressNumerator / totalSlots) * BAR_LEN);
  const bar        = Array.from({ length: BAR_LEN }, (_, i) => i < filled ? "█" : "░").join("");
  const overallPct = Math.round((progressNumerator / totalSlots) * 100);

  return (
    <div style={{ width: "100%", maxWidth: "520px", margin: "0 auto", padding: "28px 0 8px", animation: "fadeUp 0.35s ease both" }}>
      <div style={{
        background: "#0a0a0a",
        border: "1px solid rgba(232,255,107,0.14)",
        borderRadius: 12,
        overflow: "hidden",
      }}>

        {/* Title bar */}
        <div style={{
          display: "flex", alignItems: "center", gap: 6,
          padding: "9px 14px",
          background: "rgba(255,255,255,0.025)",
          borderBottom: "1px solid rgba(255,255,255,0.06)",
        }}>
          <div style={{ width: 9, height: 9, borderRadius: "50%", background: "#ff5f56" }} />
          <div style={{ width: 9, height: 9, borderRadius: "50%", background: "#ffbd2e" }} />
          <div style={{ width: 9, height: 9, borderRadius: "50%", background: "#27c93f" }} />
          <span style={{ ...mono, fontSize: 10, color: dim, marginLeft: 8, letterSpacing: "0.05em" }}>
            rack-match-pipeline
          </span>
          <span style={{ ...mono, fontSize: 10, color: acc, marginLeft: "auto" }}>
            {JD_SPINNER[spinner]} {elapsed}s
          </span>
        </div>

        <div style={{ padding: "16px 20px 14px" }}>

          {/* ── Act 1: Upload phase (only when files were queued) ── */}
          {uploadQueue.length > 0 && (
            <>
              {/* Upload section header */}
              <div style={{
                ...mono, fontSize: 10, color: "rgba(255,255,255,0.22)",
                letterSpacing: "0.12em", textTransform: "uppercase",
                marginBottom: 8, paddingBottom: 6,
                borderBottom: "1px solid rgba(255,255,255,0.04)",
              }}>
                ingesting resumes
              </div>

              {uploadQueue.map((f, i) => {
                const isDone       = f.status === 'done';
                const isProcessing = f.status === 'processing';
                const isError      = f.status === 'error';
                const isQueued     = f.status === 'queued';

                // Progress bar fill per file
                const fileFill = isDone ? 100 : isProcessing ? 55 : 0;
                const fileColor = isDone ? grn : isError ? red : acc;

                return (
                  <div key={i} style={{
                    display: "flex", alignItems: "center", gap: 10,
                    padding: "6px 0",
                    borderBottom: "1px solid rgba(255,255,255,0.03)",
                    opacity: isQueued ? 0.38 : 1,
                    transition: "opacity 0.3s ease",
                  }}>
                    {/* Status glyph */}
                    <span style={{ ...mono, fontSize: 12, minWidth: 14, color: fileColor }}>
                      {isDone ? "✓" : isError ? "✗" : isProcessing ? JD_SPINNER[spinner] : "·"}
                    </span>

                    {/* Filename — truncated */}
                    <span style={{
                      ...mono, fontSize: 11, color: isDone ? grn : isError ? red : isProcessing ? acc : dim,
                      flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                      transition: "color 0.3s",
                    }}>
                      {f.name}
                    </span>

                    {/* Mini progress bar */}
                    <div style={{
                      width: 60, height: 3, background: "rgba(255,255,255,0.06)",
                      borderRadius: 3, overflow: "hidden", flexShrink: 0,
                    }}>
                      <div style={{
                        height: "100%", borderRadius: 3,
                        background: isDone
                          ? grn
                          : isError
                          ? red
                          : "linear-gradient(90deg, #e8ff6b, #a3e635)",
                        width: `${fileFill}%`,
                        transition: "width 0.6s cubic-bezier(0.22,1,0.36,1)",
                      }} />
                    </div>

                    {/* Status label */}
                    <span style={{
                      ...mono, fontSize: 9, color: isDone ? "rgba(52,211,153,0.5)" : isError ? "rgba(248,113,113,0.5)" : isProcessing ? "rgba(232,255,107,0.45)" : "transparent",
                      minWidth: 52, textAlign: "right", transition: "color 0.3s",
                    }}>
                      {isDone ? "done" : isError ? "error" : isProcessing ? "parsing…" : "queued"}
                    </span>
                  </div>
                );
              })}

              {/* Divider between acts */}
              <div style={{
                display: "flex", alignItems: "center", gap: 8,
                margin: "12px 0 10px",
                opacity: uploadsAllDone ? 1 : 0.25,
                transition: "opacity 0.5s ease 0.3s",
              }}>
                <div style={{ flex: 1, height: 1, background: "rgba(255,255,255,0.06)" }} />
                <span style={{ ...mono, fontSize: 9, color: "rgba(255,255,255,0.2)", letterSpacing: "0.1em", textTransform: "uppercase" }}>
                  matching pipeline
                </span>
                <div style={{ flex: 1, height: 1, background: "rgba(255,255,255,0.06)" }} />
              </div>
            </>
          )}

          {/* ── Act 2: Match pipeline (always shown) ── */}
          {JD_STEPS.map((step, i) => {
            const done    = uploadsAllDone && i < stepIdx;
            const active  = uploadsAllDone && i === stepIdx;
            const pending = !uploadsAllDone || i > stepIdx;
            const color   = JD_STEP_COLOR[step.id] || acc;
            return (
              <div key={step.id} style={{
                display: "flex", alignItems: "flex-start", gap: 12,
                padding: "7px 0",
                borderBottom: i < JD_STEPS.length - 1
                  ? "1px solid rgba(255,255,255,0.04)" : "none",
                opacity: pending ? 0.35 : 1,
                transition: "opacity 0.4s ease",
              }}>
                <span style={{
                  ...mono, fontSize: 12, lineHeight: "20px", minWidth: 14,
                  color: done ? grn : active ? color : dim,
                }}>
                  {done ? "✓" : active ? JD_SPINNER[spinner] : "·"}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    ...mono, fontSize: 12, fontWeight: 600,
                    color: done ? grn : active ? color : dim,
                    marginBottom: 1,
                  }}>
                    {step.label}
                    {active && <span style={{ opacity: cursor ? 1 : 0, marginLeft: 4 }}>▌</span>}
                  </div>
                  <div style={{
                    ...mono, fontSize: 10,
                    color: done
                      ? "rgba(52,211,153,0.45)"
                      : active
                        ? (JD_STEP_COLOR[step.id] ? "rgba(167,139,250,0.45)" : "rgba(232,255,107,0.45)")
                        : "transparent",
                    transition: "color 0.3s",
                    whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                  }}>
                    {step.detail}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Progress bar footer */}
        <div style={{
          padding: "10px 20px 12px",
          borderTop: "1px solid rgba(255,255,255,0.05)",
          background: "rgba(0,0,0,0.3)",
        }}>
          <div style={{ ...mono, fontSize: 11, color: acc, whiteSpace: "pre", letterSpacing: "-0.01em" }}>
            [{bar}] {String(overallPct).padStart(3, " ")}%
          </div>
        </div>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════
   VALUE PREVIEW CARD — post-match teaser for anonymous users
   ══════════════════════════════════════════════════════════════════ */
function ValuePreviewCard({ results, onSignIn }) {
  const [previews, setPreviews] = useState(null)
  const [fetching, setFetching] = useState(false)
  const [visible, setVisible]   = useState(false)

  useEffect(() => {
    if (!results || results.length === 0) return

    // Build resume list from match results — use whatever text we have
    const resumeInputs = results.map(r => ({
      id: r.resume_id,
      name: r.name,
      text: [
        r.titles?.join(' ') || '',
        r.domains?.join(' ') || '',
        (r.matched_skills || []).join(' '),
        r.llm_reasoning || '',
      ].join(' ').slice(0, 1200), // keep it lightweight
    }))

    const fetchPreviews = async () => {
      setFetching(true)
      try {
        const res = await fetch('http://localhost:8000/api/match/preview-jobs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ resumes: resumeInputs }),
        })
        if (!res.ok) return
        const data = await res.json()
        if (data.previews && data.previews.some(p => p.match_count > 0)) {
          setPreviews(data.previews)
          // Slight delay so results finish rendering before card slides in
          setTimeout(() => setVisible(true), 400)
        }
      } catch (err) {
        // Silently fail — this is purely a value-add teaser
        console.warn('Preview jobs fetch failed:', err)
      } finally {
        setFetching(false)
      }
    }

    fetchPreviews()
  }, [results])

  if (!previews || !visible) return null

  const totalJobs = previews.reduce((sum, p) => sum + p.match_count, 0)
  const topResume = previews[0]

  return (
    <div style={{
      width: '100%', maxWidth: '720px', marginTop: '16px',
      animation: 'previewSlideUp 0.55s cubic-bezier(0.22, 1, 0.36, 1) both',
    }}>
      <style>{`
        @keyframes previewSlideUp {
          from { opacity: 0; transform: translateY(20px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        .preview-card-cta:hover {
          background: rgba(232,255,107,0.18) !important;
          border-color: rgba(232,255,107,0.55) !important;
        }
      `}</style>

      <div style={{
        background: 'linear-gradient(135deg, rgba(232,255,107,0.04) 0%, rgba(167,139,250,0.04) 100%)',
        border: '1px solid rgba(232,255,107,0.2)',
        borderRadius: '16px', overflow: 'hidden',
        boxShadow: '0 8px 40px rgba(0,0,0,0.3)',
      }}>
        {/* Top accent bar */}
        <div style={{ height: '2px', background: 'linear-gradient(90deg, #e8ff6b 0%, #a78bfa 60%, transparent 100%)' }} />

        <div style={{ padding: '20px 22px' }}>
          {/* Header row */}
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px', marginBottom: '14px' }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                <span style={{ fontSize: '16px' }}>✦</span>
                <span style={{
                  fontSize: '11px', fontWeight: 700, letterSpacing: '0.1em',
                  textTransform: 'uppercase', color: 'var(--accent)',
                }}>
                  Auto-Match Preview
                </span>
              </div>
              <div style={{
                fontFamily: 'var(--font-display)', fontSize: '17px', fontWeight: 700,
                color: 'var(--text)', lineHeight: 1.2,
              }}>
                Found{' '}
                <span style={{ color: 'var(--accent)' }}>{totalJobs} live job{totalJobs !== 1 ? 's' : ''}</span>
                {' '}matching your resume{previews.length > 1 ? 's' : ''}
              </div>
            </div>

            {/* Lock icon */}
            <div style={{
              width: '40px', height: '40px', flexShrink: 0,
              background: 'rgba(232,255,107,0.08)', border: '1px solid rgba(232,255,107,0.2)',
              borderRadius: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: '18px',
            }}>🔒</div>
          </div>

          {/* Per-resume rows */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '16px' }}>
            {previews.filter(p => p.match_count > 0).slice(0, 3).map(p => (
              <div key={p.resume_id} style={{
                display: 'flex', alignItems: 'center', gap: '10px',
                padding: '9px 12px', borderRadius: '10px',
                background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)',
              }}>
                <span style={{ fontSize: '13px' }}>📄</span>
                <span style={{
                  fontSize: '13px', fontWeight: 500, color: 'var(--text)',
                  flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {p.resume_name}
                </span>
                <span style={{
                  fontSize: '12px', fontWeight: 700, padding: '3px 10px',
                  borderRadius: '20px', background: 'rgba(52,211,153,0.1)',
                  color: '#34d399', border: '1px solid rgba(52,211,153,0.2)',
                  flexShrink: 0,
                }}>
                  {p.match_count} match{p.match_count !== 1 ? 'es' : ''}
                </span>

                {/* Blurred top job names */}
                {p.top_jobs && p.top_jobs.length > 0 && (
                  <div style={{
                    display: 'flex', gap: '5px', flexShrink: 0,
                  }}>
                    {p.top_jobs.slice(0, 2).map((j, ji) => (
                      <span key={ji} style={{
                        fontSize: '11px', padding: '2px 8px', borderRadius: '8px',
                        background: 'rgba(255,255,255,0.05)', color: 'transparent',
                        border: '1px solid rgba(255,255,255,0.06)',
                        filter: 'blur(4px)', userSelect: 'none',
                        maxWidth: '90px', overflow: 'hidden',
                        whiteSpace: 'nowrap',
                      }}>
                        {j.title || 'Software Engineer'}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* CTA */}
          <button
            className="preview-card-cta"
            onClick={onSignIn}
            style={{
              width: '100%', padding: '14px',
              background: 'rgba(232,255,107,0.1)',
              border: '1px solid rgba(232,255,107,0.35)',
              borderRadius: '12px', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px',
              fontFamily: 'var(--font-display)', fontSize: '14px', fontWeight: 700,
              color: 'var(--accent)', transition: 'all 0.2s ease',
            }}
          >
            <span>Sign in to see all {totalJobs} matches and start applying</span>
            <span style={{ fontSize: '16px' }}>→</span>
          </button>

          <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.25)', textAlign: 'center', marginTop: '10px' }}>
            Daily auto-matching · application tracking · full AI analysis
          </div>
        </div>
      </div>
    </div>
  )
}

export default function Home() {
  const { user, signInWithGoogle } = useAuth()
  const isAuthed = !!user

  const [jd, setJd]               = useState('')
  const [loading, setLoading]     = useState(false)
  const [results, setResults]     = useState(null)
  const [jdParsed, setJdParsed]   = useState(null)
  const [meta, setMeta]           = useState(null)
  const [error, setError]         = useState(null)
  const [expandedId, setExpandedId] = useState(null)
  const [resumeCount, setResumeCount] = useState(null)
  const [resumeWarning, setResumeWarning] = useState(false)

  // ── Anonymous upload queue ──────────────────────────────────────
  // fileQueue: File[] staged before clicking Match It
  // uploadQueue: { name, status }[] — drives animation during processing
  const [fileQueue, setFileQueue]     = useState([])  // staged files
  const [uploadQueue, setUploadQueue] = useState([])  // live status for animation
  const fileInputRef = useRef(null)

  // ── Resume count ────────────────────────────────────────────────
  useEffect(() => {
    if (user) {
      fetch('http://localhost:8000/api/resumes')
        .then(r => r.ok ? r.json() : { resumes: [] })
        .then(data => setResumeCount((data.resumes || []).length))
        .catch(() => setResumeCount(0))
    } else {
      try {
        const ls = JSON.parse(localStorage.getItem('rack_resumes') || '[]')
        setResumeCount(ls.length)
      } catch { setResumeCount(0) }
    }
  }, [user])

  // ── File staging helpers ────────────────────────────────────────
  const ALLOWED_TYPES = [
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ]

  const ANON_CAP = 5

  const handleFileSelect = (e) => {
    const files = Array.from(e.target.files || [])
    const valid = files.filter(f => ALLOWED_TYPES.includes(f.type))

    setFileQueue(prev => {
      // Deduplicate by name against already-queued files
      const existingNames = new Set(prev.map(f => f.name))
      const fresh = valid.filter(f => !existingNames.has(f.name))

      // Enforce cap: slots remaining = ANON_CAP - already saved - already queued
      const saved = resumeCount || 0
      const slotsRemaining = Math.max(0, ANON_CAP - saved - prev.length)

      if (fresh.length > slotsRemaining) {
        const accepted = fresh.slice(0, slotsRemaining)
        const dropped  = fresh.length - accepted.length
        if (dropped > 0) {
          setResumeWarning(`cap:${dropped}`) // special flag — rendered below
        }
        return [...prev, ...accepted]
      }

      return [...prev, ...fresh]
    })

    e.target.value = ''
  }

  const removeFileFromQueue = (name) => {
    setFileQueue(prev => prev.filter(f => f.name !== name))
    setResumeWarning(false)
  }

  // ── base64 helper ───────────────────────────────────────────────
  const fileToBase64 = (file) => new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result.split(',')[1])
    r.onerror = () => reject(new Error('Read failed'))
    r.readAsDataURL(file)
  })

  // ── Match handler ───────────────────────────────────────────────
  const handleMatch = async () => {
    if (!jd.trim() || loading) return

    const hasExistingResumes = resumeCount > 0
    const hasQueuedFiles     = fileQueue.length > 0

    if (!hasExistingResumes && !hasQueuedFiles) {
      setResumeWarning(true)
      return
    }

    setLoading(true)
    setResults(null)
    setJdParsed(null)
    setMeta(null)
    setError(null)

    // ── Act 1: Upload queued files (anonymous only) ─────────────
    if (!isAuthed && hasQueuedFiles) {
      // Initialise upload queue state for animation
      const initialQueue = fileQueue.map(f => ({ name: f.name, status: 'queued' }))
      setUploadQueue(initialQueue)

      const lsResumes = (() => {
        try { return JSON.parse(localStorage.getItem('rack_resumes') || '[]') } catch { return [] }
      })()

      for (let i = 0; i < fileQueue.length; i++) {
        const file = fileQueue[i]

        // Mark as processing
        setUploadQueue(prev => prev.map((f, idx) => idx === i ? { ...f, status: 'processing' } : f))

        try {
          const formData = new FormData()
          formData.append('file', file)

          const res = await fetch('http://localhost:8000/api/resumes/upload', {
            method: 'POST',
            body: formData,
          })

          if (!res.ok) throw new Error('Upload failed')

          const data = await res.json()
          const resume = data.resume

          // Capture base64 for localStorage migration
          const b64 = await fileToBase64(file)
          lsResumes.push({ ...resume, fileBase64: b64, fileType: file.type })

          // Mark done
          setUploadQueue(prev => prev.map((f, idx) => idx === i ? { ...f, status: 'done' } : f))
        } catch (err) {
          console.error('Upload error for', file.name, err)
          setUploadQueue(prev => prev.map((f, idx) => idx === i ? { ...f, status: 'error' } : f))
        }
      }

      // Persist all to localStorage
      localStorage.setItem('rack_resumes', JSON.stringify(lsResumes))
      setResumeCount(lsResumes.length)
      setFileQueue([])
    }

    // ── Act 2: Run match ─────────────────────────────────────────
    try {
      const res = await fetch('http://localhost:8000/api/match', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job_description: jd, use_llm: true }),
      })

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}))
        throw new Error(errData.detail || `Server error (${res.status})`)
      }

      const data = await res.json()
      setResults(data.results || [])
      setJdParsed(data.jd_parsed || null)
      setMeta(data.meta || null)
    } catch (err) {
      setError(err.message || 'Failed to connect to backend')
    } finally {
      setLoading(false)
      setUploadQueue([])
    }
  }

  return (
    <div className={`rack-page-root${!results && !error ? ' rack-no-results' : ' rack-has-results'}`} style={{
      position: 'fixed', inset: 0,
      display: 'flex',
      flexDirection: 'column', alignItems: 'center',
      justifyContent: 'flex-start',
      padding: '20px',
      paddingTop: 'var(--page-padding-top)',
      paddingBottom: 'var(--page-padding-bottom)',
      overflowY: 'auto',
      animation: 'fadeUp 0.4s ease both',
      height: '100dvh',
    }}>
      <style>{mobileCardStyles}</style>
      {!results && !error && (
        <div className="rack-hero-block" style={{ textAlign: 'center', marginBottom: '40px', animation: 'fadeUp 0.5s ease 0.1s both' }}>
          <div style={{
            fontSize: '11px', fontWeight: 500, letterSpacing: '0.18em',
            textTransform: 'uppercase', color: 'var(--accent)', marginBottom: '14px',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px'
          }}>
            <span style={{width:'30px',height:'1px',background:'var(--accent)',opacity:0.4,display:'inline-block'}}/>
            AI-Powered Matching
            <span style={{width:'30px',height:'1px',background:'var(--accent)',opacity:0.4,display:'inline-block'}}/>
          </div>
          <h1 style={{
            fontFamily: 'var(--font-display)', fontSize: 'clamp(36px,5vw,58px)',
            fontWeight: 800, letterSpacing: '-2px', lineHeight: 1.05,
            color: 'var(--text)', marginBottom: '12px'
          }}>
            Drop the JD.<br />
            <span style={{
              background: 'linear-gradient(135deg,#e8ff6b,#b8ff3a)',
              WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent'
            }}>We'll find your fit.</span>
          </h1>
          <p style={{ fontSize: '16px', color: 'var(--text-dim)', fontWeight: 300 }}>
            Paste any job description and instantly rank your resume versions with insights.
          </p>
        </div>
      )}

      {/* Mobile: clean job title pill shown INSTEAD of input box after results load */}
      {results && jdParsed?.title && (
        <div className="rack-mobile-title-pill" style={{
          display: 'none', /* shown via CSS on mobile only */
          width: '100%', maxWidth: '720px',
          alignItems: 'center', justifyContent: 'space-between', gap: '10px',
          marginBottom: '4px',
          animation: 'fadeUp 0.3s ease both',
        }}>
          <span style={{
            fontFamily: 'var(--font-display)', fontSize: '18px', fontWeight: 800,
            color: 'var(--accent)', letterSpacing: '-0.5px',
            flex: 1, lineHeight: 1.2,
            wordBreak: 'break-word', overflowWrap: 'break-word',
          }}>
            {jdParsed.title}
          </span>
          <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexShrink: 0 }}>
            {jdParsed.min_years && (
              <span style={{
                fontSize: '11px', padding: '3px 9px', borderRadius: '20px',
                background: 'rgba(232,255,107,0.1)', color: 'var(--accent)',
                border: '1px solid rgba(232,255,107,0.25)', fontWeight: 600,
              }}>
                {jdParsed.min_years}+ yrs
              </span>
            )}
            <button onClick={() => { setResults(null); setJdParsed(null); setMeta(null) }} style={{
              fontSize: '10px', padding: '3px 9px', borderRadius: '20px',
              background: 'rgba(255,255,255,0.06)', color: 'var(--text-dim)',
              border: '1px solid var(--border)', fontWeight: 500, cursor: 'pointer',
            }}>
              ✕ new
            </button>
          </div>
        </div>
      )}

      {/* Input box — hidden on mobile when results are present */}
      <div className={`rack-input-box-stretch${results ? ' rack-input-hide-mobile' : ''}`} style={{
        width: '100%', maxWidth: '720px',
        background: 'var(--surface)', border: '1px solid var(--border-bright)',
        borderRadius: 'var(--radius)', overflow: 'hidden',
        boxShadow: '0 24px 80px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.06)',
        animation: 'fadeUp 0.5s ease 0.2s both'
      }}>
        {/* Desktop: macOS dots bar */}
        <div className="rack-input-dots-bar" style={{
          display: 'flex', alignItems: 'center', gap: '10px',
          padding: '14px 18px', borderBottom: '1px solid var(--border)',
          background: 'rgba(255,255,255,0.02)'
        }}>
          {[['#ff5f57'],['#febc2e'],['#28c840']].map(([c], i) => (
            <div key={i} style={{ width:10,height:10,borderRadius:'50%',background:c }} />
          ))}
          <span style={{ marginLeft:'auto', fontSize:'11px', color:'var(--text-dim)', letterSpacing:'0.1em', textTransform:'uppercase' }}>
            Job Description
          </span>
        </div>

        <textarea
          className="rack-textarea-stretch"
          style={{
            width: '100%', minHeight: results ? '80px' : '180px', maxHeight: '320px',
            background: 'transparent', border: 'none', outline: 'none',
            resize: 'none', color: 'var(--text)', fontFamily: 'var(--font-body)',
            fontSize: '15px', fontWeight: 300, lineHeight: 1.7,
            padding: '20px 22px', caretColor: 'var(--accent)',
            transition: 'min-height 0.3s ease',
          }}
          placeholder="Paste the job description here… (⌘+Enter to match)"
          value={jd}
          onChange={e => { setJd(e.target.value); setResumeWarning(false) }}
          onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleMatch() }}
        />

        {/* ── Anonymous upload zone (hidden for authed users) ── */}
        {!isAuthed && !results && (
          <div style={{
            borderTop: '1px solid var(--border)',
            padding: '10px 16px',
            background: 'rgba(255,255,255,0.01)',
          }}>
            {/* Staged file chips */}
            {fileQueue.length > 0 && (
              <div style={{
                display: 'flex', gap: '6px', flexWrap: 'wrap',
                marginBottom: '8px',
              }}>
                {fileQueue.map(f => (
                  <div key={f.name} style={{
                    display: 'flex', alignItems: 'center', gap: '5px',
                    padding: '3px 8px 3px 10px',
                    background: 'rgba(232,255,107,0.07)',
                    border: '1px solid rgba(232,255,107,0.2)',
                    borderRadius: '20px',
                    animation: 'fadeUp 0.2s ease both',
                  }}>
                    <span style={{ fontSize: '11px', color: 'rgba(232,255,107,0.8)', fontWeight: 500, maxWidth: '140px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      📄 {f.name}
                    </span>
                    <button
                      onClick={() => removeFileFromQueue(f.name)}
                      style={{
                        background: 'none', border: 'none', cursor: 'pointer',
                        color: 'rgba(232,255,107,0.4)', fontSize: '11px',
                        padding: '0 2px', lineHeight: 1,
                        display: 'flex', alignItems: 'center',
                      }}
                    >✕</button>
                  </div>
                ))}
              </div>
            )}

            {/* Upload trigger row */}
            {(() => {
              const saved = resumeCount || 0
              const atCap = saved + fileQueue.length >= ANON_CAP
              const slotsLeft = Math.max(0, ANON_CAP - saved - fileQueue.length)
              const capWarning = typeof resumeWarning === 'string' && resumeWarning.startsWith('cap:')
              const droppedCount = capWarning ? parseInt(resumeWarning.split(':')[1]) : 0

              return (
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <button
                    onClick={() => { if (!atCap) fileInputRef.current?.click() }}
                    disabled={atCap}
                    style={{
                      display: 'flex', alignItems: 'center', gap: '6px',
                      padding: '6px 12px',
                      background: 'transparent',
                      border: `1px dashed ${atCap ? 'rgba(255,255,255,0.1)' : 'rgba(232,255,107,0.25)'}`,
                      borderRadius: '20px',
                      cursor: atCap ? 'not-allowed' : 'pointer',
                      color: atCap ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.4)',
                      fontSize: '12px', fontFamily: 'var(--font-body)',
                      transition: 'all 0.2s ease',
                      opacity: atCap ? 0.6 : 1,
                    }}
                    onMouseEnter={e => {
                      if (atCap) return
                      e.currentTarget.style.borderColor = 'rgba(232,255,107,0.5)'
                      e.currentTarget.style.color = 'rgba(232,255,107,0.7)'
                    }}
                    onMouseLeave={e => {
                      if (atCap) return
                      e.currentTarget.style.borderColor = 'rgba(232,255,107,0.25)'
                      e.currentTarget.style.color = 'rgba(255,255,255,0.4)'
                    }}
                  >
                    <span style={{ fontSize: '14px' }}>+</span>
                    {atCap ? 'Limit reached' : fileQueue.length === 0 ? 'Attach resume(s)' : 'Add more'}
                  </button>

                  <span style={{
                    fontSize: '11px', transition: 'color 0.2s',
                    color: capWarning
                      ? '#fbbf24'
                      : resumeWarning === true
                      ? '#fbbf24'
                      : 'rgba(255,255,255,0.22)',
                  }}>
                    {capWarning
                      ? `⚠ ${droppedCount} file${droppedCount !== 1 ? 's' : ''} dropped — ${ANON_CAP}-resume limit`
                      : resumeWarning === true
                      ? '⚠ Attach at least one resume to match'
                      : atCap
                      ? `${ANON_CAP}/${ANON_CAP} · sign in to upload more`
                      : saved + fileQueue.length > 0
                      ? `${saved + fileQueue.length}/${ANON_CAP} · ${slotsLeft} slot${slotsLeft !== 1 ? 's' : ''} left`
                      : 'PDF or DOCX · multiple allowed'
                    }
                  </span>
                </div>
              )
            })()}
          </div>
        )}

        {/* Input footer — Match It button row */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '12px 16px', borderTop: '1px solid var(--border)',
          background: 'rgba(255,255,255,0.015)', flexWrap: 'wrap', gap: '8px'
        }}>
          <span style={{ fontSize: '12px', color: 'var(--text-dim)', transition: 'color 0.2s' }}>
            {jd.length > 0 ? `${jd.length} chars` : 'Empty'}
          </span>
          <button onClick={handleMatch} disabled={!jd.trim() || loading} style={{
            display: 'flex', alignItems: 'center', gap: '10px',
            padding: '12px 28px',
            background: !jd.trim() || loading ? 'rgba(255,255,255,0.08)' : 'var(--accent)',
            color: !jd.trim() || loading ? 'var(--text-dim)' : '#080808',
            border: 'none', borderRadius: '30px',
            fontFamily: 'var(--font-display)', fontSize: '14px', fontWeight: 700,
            cursor: !jd.trim() || loading ? 'not-allowed' : 'pointer',
            transition: 'all 0.2s ease'
          }}>
            {loading
              ? <><div style={{width:14,height:14,border:'2px solid rgba(0,0,0,0.3)',borderTopColor:'#080808',borderRadius:'50%',animation:'spin 0.7s linear infinite'}}/>Matching…</>
              : '✦ Match It'
            }
          </button>
        </div>

        {/* Hidden multi-file input */}
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,.doc,.docx"
          multiple
          style={{ display: 'none' }}
          onChange={handleFileSelect}
        />
      </div>

      {/* Pipeline animation while loading */}
      {loading && <JDPipelineAnimation uploadQueue={uploadQueue} />}

      {/* Error state */}
      {error && (
        <div style={{
          width: '100%', maxWidth: '720px', marginTop: '20px',
          padding: '16px 20px', borderRadius: '12px',
          background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.2)',
          color: 'var(--danger)', fontSize: '14px', fontWeight: 400,
          animation: 'fadeUp 0.3s ease both',
        }}>
          {error}
        </div>
      )}

      {/* JD Parse Summary */}
      {jdParsed && results && (
        <>
          {/* Desktop: job title above the JD analysis block */}
          {jdParsed.title && (
            <div className="rack-jd-desktop-title" style={{
              width: '100%', maxWidth: '720px', marginTop: '20px',
              display: 'flex', alignItems: 'baseline', gap: '10px',
            }}>
              <span style={{
                fontFamily: 'var(--font-display)', fontSize: '18px', fontWeight: 700,
                color: 'var(--text)', letterSpacing: '-0.3px',
              }}>
                {jdParsed.title}
              </span>
              {jdParsed.min_years && (
                <span style={{ fontSize: '12px', color: 'var(--text-dim)', fontWeight: 400 }}>
                  · {jdParsed.min_years}+ yrs exp required
                </span>
              )}
            </div>
          )}

          <div style={{
            width: '100%', maxWidth: '720px', marginTop: jdParsed.title ? '8px' : '20px',
            padding: '12px 16px', borderRadius: '12px',
            background: 'rgba(232,255,107,0.03)', border: '1px solid rgba(232,255,107,0.12)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
              <span style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--accent)' }}>
                JD Analysis
              </span>
              <span style={{
                fontSize: '10px', padding: '2px 8px', borderRadius: '10px',
                background: jdParsed.extraction_method === 'hybrid' ? 'rgba(52,211,153,0.12)' : 'rgba(255,255,255,0.06)',
                color: jdParsed.extraction_method === 'hybrid' ? 'var(--accent3)' : 'var(--text-dim)',
                border: `1px solid ${jdParsed.extraction_method === 'hybrid' ? 'rgba(52,211,153,0.2)' : 'rgba(255,255,255,0.08)'}`,
                fontWeight: 600,
              }}>
                {jdParsed.extraction_method === 'hybrid' ? 'Rule + LLM' : 'Rule-based'}
              </span>
              {meta?.llm_scored > 0 && (
                <span style={{
                  fontSize: '10px', padding: '2px 8px', borderRadius: '10px',
                  background: 'rgba(167,139,250,0.12)', color: '#a78bfa',
                  border: '1px solid rgba(167,139,250,0.22)', fontWeight: 600,
                }}>
                  ✦ {meta.llm_scored} AI-scored
                </span>
              )}
              {meta && (
                <span style={{ marginLeft: 'auto', fontSize: '11px', color: 'var(--text-dim)' }}>
                  {meta.pipeline_time_ms}ms
                </span>
              )}
            </div>
            {/* Chips row: wraps on desktop, scrolls horizontally on mobile */}
            <div className="rack-jd-chips" style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              {jdParsed.title && (
                <span className="rack-jd-chip" style={{ fontSize: '11px', fontWeight: 500, padding: '3px 10px', borderRadius: '20px', background: 'rgba(255,255,255,0.06)', color: 'var(--text)', border: '1px solid var(--border)', whiteSpace: 'nowrap' }}>
                  {jdParsed.title}
                </span>
              )}
              {jdParsed.min_years && (
                <span className="rack-jd-chip" style={{ fontSize: '11px', fontWeight: 500, padding: '3px 10px', borderRadius: '20px', background: 'rgba(255,255,255,0.06)', color: 'var(--text)', border: '1px solid var(--border)', whiteSpace: 'nowrap' }}>
                  {jdParsed.min_years}+ yrs
                </span>
              )}
              {(jdParsed.required_skills || []).slice(0, 6).map(s => (
                <span key={s} className="rack-jd-chip" style={{ fontSize: '11px', fontWeight: 500, padding: '3px 10px', borderRadius: '20px', background: 'rgba(232,255,107,0.06)', color: 'var(--accent)', border: '1px solid rgba(232,255,107,0.15)', whiteSpace: 'nowrap' }}>
                  {s}
                </span>
              ))}
              {(jdParsed.required_skills || []).length > 6 && (
                <span className="rack-jd-chip" style={{ fontSize: '11px', fontWeight: 500, padding: '3px 10px', color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>
                  +{jdParsed.required_skills.length - 6} more
                </span>
              )}
            </div>
          </div>
        </>
      )}

      {/* Results */}
      {results && results.length > 0 && (
        <div style={{ width: '100%', maxWidth: '720px', marginTop: '16px', animation: 'matchReveal 0.5s ease both' }}>
          <div style={{ fontFamily:'var(--font-display)', fontSize:'13px', fontWeight:600, letterSpacing:'0.1em', textTransform:'uppercase', color:'var(--text-dim)', marginBottom:'12px', paddingLeft:'4px' }}>
            Ranked Results — {results.length} resume{results.length !== 1 ? 's' : ''}
          </div>
          {results.map((r, i) => {
            const isExpanded = expandedId === r.resume_id
            const isLLM = r.scoring_method === 'llm+hybrid'
            const displayScore = r.llm_score ?? r.score ?? 0
            const rec = r.llm_recommendation
            const recStyle = rec ? recommendationStyle(rec) : null

            return (
              <div key={r.resume_id} className="rack-card-padding" style={{
                background: i === 0 ? 'rgba(232,255,107,0.04)' : 'var(--surface)',
                border: `1px solid ${i === 0 ? 'rgba(232,255,107,0.3)' : 'var(--border-bright)'}`,
                borderRadius: '14px', padding: '18px 22px', marginBottom: '10px',
                cursor: 'pointer', transition: 'all 0.2s ease',
                animation: `matchReveal 0.4s ease ${i * 0.07}s both`,
                boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
              }}
              onClick={() => setExpandedId(isExpanded ? null : r.resume_id)}
              >
                {/* Collapsed row */}
                <div className="rack-card-row" style={{ display: 'flex', alignItems: 'center', gap: '18px' }}>
                  <div className="rack-card-rank" style={{ fontFamily:'var(--font-display)', fontSize:'24px', fontWeight:800, color: i===0 ? 'var(--accent)' : 'rgba(255,255,255,0.15)', minWidth:'36px' }}>
                    #{i+1}
                  </div>
                  <div style={{ flex:1, minWidth:0 }}>
                    {/* Name + badges */}
                    <div className="rack-card-badges" style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px', flexWrap: 'wrap' }}>
                      <span className="rack-card-name" style={{ fontFamily:'var(--font-display)', fontSize:'16px', fontWeight:600, color:'var(--text)' }}>{r.name}</span>
                      <span style={{ fontSize: '10px', padding: '2px 6px', borderRadius: '6px', background: 'rgba(255,255,255,0.06)', color: 'var(--text-dim)', fontWeight: 500 }}>
                        {r.file_ext?.replace('.', '').toUpperCase()}
                      </span>
                      {isLLM && (
                        <span style={{ fontSize: '10px', padding: '2px 7px', borderRadius: '6px', background: 'rgba(167,139,250,0.12)', color: '#a78bfa', border: '1px solid rgba(167,139,250,0.22)', fontWeight: 700, letterSpacing: '0.04em' }}>
                          AI
                        </span>
                      )}
                      {rec && recStyle && (
                        <span style={{ fontSize: '10px', padding: '2px 9px', borderRadius: '20px', background: recStyle.bg, color: recStyle.color, border: `1px solid ${recStyle.border}`, fontWeight: 600 }}>
                          {rec}
                        </span>
                      )}
                    </div>
                    {/* Score bar */}
                    <div style={{ height:'4px', background:'rgba(255,255,255,0.08)', borderRadius:'4px', overflow:'hidden' }}>
                      <div style={{ height:'100%', borderRadius:'4px', background: scoreColor(displayScore), width:`${displayScore}%`, transition:'width 1s cubic-bezier(0.22,1,0.36,1)' }} />
                    </div>
                    {/* Skill pills — hidden on mobile in collapsed state */}
                    <div className="rack-card-collapsed-skills" style={{ display:'flex', gap:'6px', marginTop:'8px', flexWrap:'wrap' }}>
                      {(r.matched_skills || []).slice(0,4).map(t => (
                        <span key={t} style={{ fontSize:'11px', fontWeight:500, padding:'3px 10px', borderRadius:'20px', background:'rgba(52,211,153,0.1)', color:'var(--accent3)', border:'1px solid rgba(52,211,153,0.2)' }}>✓ {t}</span>
                      ))}
                      {(r.missing_skills || []).slice(0,3).map(t => (
                        <span key={t} style={{ fontSize:'11px', fontWeight:500, padding:'3px 10px', borderRadius:'20px', background:'rgba(248,113,113,0.08)', color:'var(--danger)', border:'1px solid rgba(248,113,113,0.15)' }}>✗ {t}</span>
                      ))}
                    </div>
                  </div>
                  <div style={{ textAlign:'right', minWidth:'60px' }}>
                    <div className="rack-card-score-num" style={{ fontFamily:'var(--font-display)', fontSize:'28px', fontWeight:800, letterSpacing:'-1px', color: i===0 ? 'var(--accent)' : 'var(--text)' }}>{displayScore}</div>
                    <div className="rack-card-score-label" style={{ fontSize:'14px', color:'var(--text-dim)', fontWeight:300 }}>match</div>
                  </div>
                </div>

                {/* Expanded panel */}
                {isExpanded && (
                  <div className="rack-expand-panel" style={{
                    marginTop: '16px', paddingTop: '16px',
                    borderTop: '1px solid var(--border)',
                  }}>

                    {/* AI Analysis block */}
                    {isLLM && r.llm_reasoning && (
                      <div style={{
                        marginBottom: '16px', padding: '14px 16px',
                        borderRadius: '10px',
                        background: 'rgba(167,139,250,0.05)',
                        borderLeft: '3px solid rgba(167,139,250,0.4)',
                      }}>
                        <div style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#a78bfa', marginBottom: '8px' }}>
                          ✦ AI Analysis
                        </div>
                        <p style={{ fontSize: '13px', color: 'var(--text-mid)', fontStyle: 'italic', lineHeight: 1.65, margin: '0 0 10px' }}>
                          {r.llm_reasoning}
                        </p>
                        {r.llm_key_strengths?.length > 0 && (
                          <div style={{ marginBottom: '8px' }}>
                            {r.llm_key_strengths.map((s, si) => (
                              <div key={si} style={{ display: 'flex', gap: '8px', fontSize: '12px', marginBottom: '4px' }}>
                                <span style={{ flexShrink: 0, color: 'var(--accent3)' }}>✓</span>
                                <span style={{ color: 'var(--text-mid)' }}>{s}</span>
                              </div>
                            ))}
                          </div>
                        )}
                        {r.llm_key_gaps?.length > 0 && (
                          <div>
                            {r.llm_key_gaps.map((g, gi) => (
                              <div key={gi} style={{ display: 'flex', gap: '8px', fontSize: '12px', marginBottom: '4px' }}>
                                <span style={{ flexShrink: 0, color: 'var(--danger)' }}>✗</span>
                                <span style={{ color: 'var(--text-mid)' }}>{g}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Score breakdown */}
                    <div style={{ marginBottom: '14px' }}>
                      <div style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-dim)', marginBottom: '8px' }}>
                        {isLLM ? 'AI Score Breakdown' : 'Score Breakdown'}
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                        {/* LLM 3-component bars (primary) */}
                        {isLLM && r.llm_components && Object.keys(r.llm_components).length > 0 && (
                          <>
                            {componentBar('Skills Fit',   r.llm_components.skills_fit      ?? 0, 'linear-gradient(90deg,#e8ff6b,#a3e635)')}
                            {componentBar('Experience',   r.llm_components.experience_fit  ?? 0, 'linear-gradient(90deg,#f59e0b,#f97316)')}
                            {componentBar('Trajectory',   r.llm_components.trajectory_fit  ?? 0, 'linear-gradient(90deg,#a78bfa,#c084fc)')}
                            {/* Hybrid baseline — dimmed */}
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', marginTop: '2px', opacity: 0.45 }}>
                              <span style={{ color: 'var(--text-dim)', minWidth: '80px', fontWeight: 500 }}>Keyword/Sem</span>
                              <div style={{ flex: 1, height: '3px', background: 'rgba(255,255,255,0.06)', borderRadius: '4px', overflow: 'hidden' }}>
                                <div style={{ height: '100%', borderRadius: '4px', background: 'rgba(255,255,255,0.2)', width: `${r.hybrid_score ?? 0}%` }} />
                              </div>
                              <span style={{ color: 'var(--text-dim)', minWidth: '28px', textAlign: 'right', fontFamily: 'var(--font-display)', fontWeight: 600 }}>{r.hybrid_score ?? 0}</span>
                            </div>
                          </>
                        )}
                        {/* Hybrid fallback 4-component bars */}
                        {!isLLM && r.components && (
                          <>
                            {componentBar('Semantic',   (r.components.semantic?.score   ?? 0) * 100, 'linear-gradient(90deg,#60a5fa,#818cf8)')}
                            {componentBar('Skills',     (r.components.skill?.score      ?? 0) * 100, 'linear-gradient(90deg,#e8ff6b,#a3e635)')}
                            {componentBar('Experience', (r.components.experience?.score ?? 0) * 100, 'linear-gradient(90deg,#f59e0b,#f97316)')}
                            {componentBar('Keywords',   (r.components.keyword?.score    ?? 0) * 100, 'linear-gradient(90deg,#a78bfa,#c084fc)')}
                          </>
                        )}
                      </div>
                    </div>

                    {/* Gap analysis */}
                    {r.gap_analysis && r.gap_analysis.gap_count > 0 && (
                      <div style={{ marginBottom: '12px' }}>
                        <div style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-dim)', marginBottom: '6px' }}>
                          Gaps ({r.gap_analysis.gap_count})
                        </div>
                        {r.gap_analysis.critical_gaps?.length > 0 && (
                          <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', marginBottom: '4px' }}>
                            {r.gap_analysis.critical_gaps.map(g => (
                              <span key={g} style={{ fontSize: '10px', fontWeight: 600, padding: '2px 8px', borderRadius: '10px', background: 'rgba(248,113,113,0.12)', color: '#f87171', border: '1px solid rgba(248,113,113,0.2)' }}>
                                ⚠ {g}
                              </span>
                            ))}
                          </div>
                        )}
                        <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>
                          Coverage: {Math.round((r.gap_analysis.coverage?.required || 0) * 100)}% required · {Math.round((r.gap_analysis.coverage?.preferred || 0) * 100)}% preferred
                        </div>
                      </div>
                    )}

                    {/* Resume meta */}
                    <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', fontSize: '11px', color: 'var(--text-dim)' }}>
                      {r.years_exp && <span>{r.years_exp} yrs exp</span>}
                      {r.titles?.length > 0 && <span>{r.titles[0]}</span>}
                      {r.domains?.length > 0 && <span>{r.domains.join(', ')}</span>}
                      <span>{r.chunk_count} chunks</span>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Value preview card — anonymous users only, after results render */}
      {results && results.length > 0 && !isAuthed && (
        <ValuePreviewCard results={results} onSignIn={signInWithGoogle} />
      )}

      {/* No results */}
      {results && results.length === 0 && (
        <div style={{
          width: '100%', maxWidth: '720px', marginTop: '24px',
          textAlign: 'center', padding: '40px 20px',
          animation: 'fadeUp 0.3s ease both',
        }}>
          <div style={{ fontSize: '32px', marginBottom: '12px' }}>📄</div>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: '18px', fontWeight: 600, color: 'var(--text)', marginBottom: '8px' }}>
            No resumes to match against
          </div>
          <p style={{ fontSize: '14px', color: 'var(--text-dim)', fontWeight: 300 }}>
            Upload your resumes in the Resumes tab first, then come back to match.
          </p>
        </div>
      )}
    </div>
  )
}