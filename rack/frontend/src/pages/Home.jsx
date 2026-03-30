import { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useAuth } from '../context/AuthContext'
import { getAuthHeaders } from '../utils/api'

const mobileCardStyles = `
  /* ── Keyframes ── */
  @keyframes smoothExpand {
    from { opacity: 0; transform: translateY(-6px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  @keyframes bubbleIn {
    from { opacity: 0; transform: translateY(10px) scale(0.98); }
    to   { opacity: 1; transform: translateY(0) scale(1); }
  }
  @keyframes greetingFade {
    from { opacity: 0; transform: translateY(16px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  @keyframes shimmer {
    0%   { background-position: -400px 0; }
    100% { background-position:  400px 0; }
  }
  @keyframes pulse {
    0%, 100% { opacity: 0.3; transform: scale(0.85); }
    50%       { opacity: 1;   transform: scale(1.15); }
  }
  .rack-tracking-cta {
    display: inline-flex; align-items: center; gap: 6px;
    font-size: 12px; font-weight: 600; font-family: var(--font-body);
    color: var(--accent); text-decoration: none; cursor: pointer;
    background: linear-gradient(90deg,
      rgba(232,255,107,0.0) 0%,
      rgba(232,255,107,0.25) 40%,
      rgba(232,255,107,0.5) 50%,
      rgba(232,255,107,0.25) 60%,
      rgba(232,255,107,0.0) 100%
    );
    background-size: 400px 100%;
    background-clip: text; -webkit-background-clip: text;
    animation: shimmer 2.2s ease-in-out infinite;
    letter-spacing: 0.01em;
  }
  .rack-tracking-cta:hover { opacity: 0.8; }

  /* ── Chat layout ── */
  .rack-chat-root {
    position: fixed;
    inset: 0;
    display: flex;
    flex-direction: column;
    height: 100dvh;
    overflow: hidden;
  }

  /* Scrollable message area — goes full bleed, flows under the floating nav */
  .rack-chat-scroll {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    display: flex;
    flex-direction: column;
    padding: 24px 20px 16px;
    padding-top: calc(var(--page-padding-top, 68px) + 16px);
    gap: 0;
    scroll-behavior: smooth;
    -webkit-overflow-scrolling: touch;
  }
  .rack-chat-scroll::-webkit-scrollbar { width: 4px; }
  .rack-chat-scroll::-webkit-scrollbar-track { background: transparent; }
  .rack-chat-scroll::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 4px; }

  /* Greeting state */
  .rack-greeting {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    flex: 1;
    padding: 20px 0 32px;
    gap: 24px;
    animation: greetingFade 0.5s cubic-bezier(0.22,1,0.36,1) both;
  }
  .rack-greeting-hero {
    text-align: center;
  }
  .rack-greeting-eyebrow {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--accent);
    margin-bottom: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
  }
  .rack-greeting-title {
    font-family: var(--font-display);
    font-size: clamp(30px, 4.5vw, 52px);
    font-weight: 800;
    letter-spacing: -2px;
    line-height: 1.05;
    color: var(--text);
    margin: 0 0 12px;
  }
  .rack-greeting-sub {
    font-size: 15px;
    color: var(--text-dim);
    font-weight: 300;
    margin: 0;
  }
  .rack-suggestion-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    justify-content: center;
    max-width: 560px;
  }
  .rack-suggestion-chip {
    padding: 8px 16px;
    background: var(--surface);
    border: 1px solid var(--border-bright);
    border-radius: 20px;
    font-size: 13px;
    font-weight: 500;
    color: var(--text-mid);
    cursor: pointer;
    transition: all 0.18s ease;
    font-family: var(--font-body);
  }
  .rack-suggestion-chip:hover {
    background: rgba(232,255,107,0.06);
    border-color: rgba(232,255,107,0.3);
    color: var(--accent);
  }

  /* Message bubbles */
  .rack-msg-row {
    display: flex;
    margin-bottom: 18px;
    animation: bubbleIn 0.35s cubic-bezier(0.22,1,0.36,1) both;
  }
  .rack-msg-row.user { justify-content: flex-end; }
  .rack-msg-row.rack { justify-content: flex-start; }

  /* User bubble — right side */
  .rack-bubble-user {
    max-width: min(72%, 520px);
    padding: 12px 16px;
    background: rgba(232,255,107,0.08);
    border: 1px solid rgba(232,255,107,0.18);
    border-radius: 18px 18px 4px 18px;
    font-size: 14px;
    font-weight: 400;
    color: var(--text);
    line-height: 1.55;
    word-break: break-word;
  }
  .rack-bubble-user-label {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: rgba(232,255,107,0.5);
    margin-bottom: 5px;
  }

  /* RACK reply bubble — left side */
  .rack-bubble-rack {
    max-width: min(96%, 860px);
    width: 100%;
  }
  .rack-bubble-rack-label {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--text-dim);
    margin-bottom: 10px;
    padding-left: 2px;
  }
  .rack-bubble-rack-label-dot {
    width: 5px; height: 5px;
    border-radius: 50%;
    background: var(--accent);
  }

  /* Result cards inside RACK bubble */
  .rack-card-collapsed-skills { }
  .rack-card-rank { }
  .rack-card-name { }
  .rack-card-score-num { }
  .rack-card-score-label { }
  .rack-card-badges { }
  .rack-card-row { }
  .rack-card-padding { }

  /* JD Analysis: single scrollable row of chips */
  .rack-jd-chips {
    flex-wrap: wrap;
  }
  .rack-jd-chip { }

  /* Smooth expand panel */
  .rack-expand-panel {
    animation: smoothExpand 0.35s cubic-bezier(0.22, 1, 0.36, 1) both;
  }

  /* ── Bottom chat input bar — floats on the background, no dark box ── */
  .rack-chat-input-bar {
    flex-shrink: 0;
    padding: 12px 24px 20px;
    padding-bottom: calc(20px + env(safe-area-inset-bottom, 0px));
    background: transparent;
    position: relative;
  }
  .rack-chat-input-inner {
    display: flex;
    align-items: flex-end;
    gap: 10px;
    max-width: 820px;
    margin: 0 auto;
    background: rgba(30,30,30,0.95);
    border: 1px solid rgba(255,255,255,0.12);
    border-radius: 20px;
    padding: 14px 14px 14px 20px;
    transition: border-color 0.2s ease;
    box-shadow: 0 4px 24px rgba(0,0,0,0.5), 0 1px 0 rgba(255,255,255,0.04) inset;
  }
  .rack-chat-input-inner:focus-within {
    border-color: rgba(232,255,107,0.35);
    box-shadow: 0 4px 32px rgba(0,0,0,0.6), 0 0 0 1px rgba(232,255,107,0.08), 0 1px 0 rgba(255,255,255,0.04) inset;
  }
  .rack-chat-textarea {
    flex: 1;
    background: transparent;
    border: none;
    outline: none;
    resize: none;
    color: var(--text);
    font-family: var(--font-body);
    font-size: 15px;
    font-weight: 300;
    // line-height: 1.6;
    max-height: 180px;
    min-height: 28px;
    caret-color: var(--accent);
    overflow-y: auto;
    scrollbar-width: none;
  }
  .rack-chat-textarea::-webkit-scrollbar { display: none; }
  .rack-chat-textarea::placeholder { color: rgba(255,255,255,0.25); }

  /* Attach + send button row inside input */
  .rack-chat-input-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }
  .rack-chat-attach-btn {
    width: 32px; height: 32px;
    display: flex; align-items: center; justify-content: center;
    background: transparent;
    border: 1px dashed rgba(255,255,255,0.15);
    border-radius: 8px;
    cursor: pointer;
    font-size: 14px;
    color: rgba(255,255,255,0.35);
    transition: all 0.18s ease;
    flex-shrink: 0;
  }
  .rack-chat-attach-btn:hover {
    border-color: rgba(232,255,107,0.4);
    color: rgba(232,255,107,0.7);
    background: rgba(232,255,107,0.04);
  }
  .rack-chat-attach-btn:disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }
  .rack-chat-send-btn {
    width: 40px; height: 40px;
    display: flex; align-items: center; justify-content: center;
    background: var(--accent);
    border: none;
    border-radius: 12px;
    cursor: pointer;
    font-size: 18px;
    color: #080808;
    font-weight: 800;
    transition: all 0.18s ease;
    flex-shrink: 0;
  }
  .rack-chat-send-btn:disabled {
    background: rgba(255,255,255,0.1);
    color: rgba(255,255,255,0.25);
    cursor: not-allowed;
  }
  .rack-chat-send-btn:not(:disabled):hover {
    background: #d4f032;
    transform: scale(1.06);
  }

  /* Staged file chips above input */
  .rack-staged-files {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    max-width: 820px;
    margin: 0 auto 8px;
  }

  /* Input meta row (char count, warning) */
  .rack-input-meta {
    display: flex;
    align-items: center;
    gap: 8px;
    max-width: 820px;
    margin: 8px auto 0;
    font-size: 11px;
    color: rgba(255,255,255,0.22);
    padding: 0 4px;
  }

  @media (max-width: 600px) {
    .rack-chat-scroll { padding: 16px 12px 12px; padding-top: calc(var(--page-padding-top, 68px) + 12px); }
    .rack-greeting-title { font-size: clamp(24px, 7vw, 36px); letter-spacing: -1px; }
    .rack-greeting-sub { font-size: 14px; }
    .rack-bubble-user { max-width: 85%; font-size: 13px; }
    .rack-bubble-rack { max-width: 100%; }
    .rack-chat-input-bar { padding: 10px 16px 14px; padding-bottom: calc(75px + env(safe-area-inset-bottom, 0px)); }
    .rack-chat-input-inner { padding: 10px 10px 10px 16px; border-radius: 16px; }
    .rack-chat-textarea { font-size: 16px; /* prevent iOS zoom */ }
    .rack-suggestion-chips { gap: 6px; }
    .rack-suggestion-chip { font-size: 12px; padding: 7px 13px; }

    /* Result cards — mobile sizing */
    .rack-card-collapsed-skills { display: none !important; }
    .rack-card-rank { font-size: 16px !important; min-width: 28px !important; }
    .rack-card-name { font-size: 14px !important; }
    .rack-card-score-num { font-size: 22px !important; }
    .rack-card-score-label { font-size: 11px !important; }
    .rack-card-badges { gap: 5px !important; margin-bottom: 5px !important; }
    .rack-card-row { gap: 10px !important; }
    .rack-card-padding { padding: 13px 14px !important; border-radius: 12px !important; }

    /* JD chips: horizontal scroll on mobile */
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
  }

  /* ── Value Preview Overlay ── */
  @keyframes previewSlideUp {
    from { opacity: 0; transform: translateY(28px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  @keyframes previewSlideRight {
    from { opacity: 0; transform: translateX(28px); }
    to   { opacity: 1; transform: translateX(0); }
  }
  @keyframes teaserPop {
    from { opacity: 0; transform: scale(0.82) translateY(8px); }
    to   { opacity: 1; transform: scale(1)    translateY(0); }
  }

  .preview-floating-panel {
    position: fixed;
    bottom: 28px; right: 28px;
    width: 420px;
    z-index: 201;
    animation: previewSlideRight 0.5s cubic-bezier(0.22, 1, 0.36, 1) both;
    pointer-events: all;
  }
  @media (max-width: 600px) {
    .preview-floating-panel {
      bottom: calc(72px + env(safe-area-inset-bottom, 0px));
      right: 0; left: 0;
      width: 100%;
      padding: 0 10px;
      animation: previewSlideUp 0.5s cubic-bezier(0.22, 1, 0.36, 1) both;
    }
    .preview-resume-chips { display: none !important; }
  }
  .preview-teaser-badge {
    position: fixed;
    bottom: 28px; right: 28px;
    z-index: 201;
    animation: teaserPop 0.32s cubic-bezier(0.22, 1, 0.36, 1) both;
    pointer-events: all;
  }
  @media (max-width: 600px) {
    .preview-teaser-badge {
      bottom: calc(80px + env(safe-area-inset-bottom, 0px));
      right: 14px;
    }
  }
  .preview-card-cta:hover {
    background: rgba(232,255,107,0.2) !important;
    border-color: rgba(232,255,107,0.6) !important;
  }
  .preview-resume-row:hover {
    background: rgba(232,255,107,0.05) !important;
    border-color: rgba(232,255,107,0.18) !important;
    cursor: pointer;
  }
  .preview-dismiss-btn:hover {
    background: rgba(255,255,255,0.14) !important;
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
   Fixed overlay: desktop bottom-right panel, mobile bottom sheet.
   Never buried under result tiles — always immediately visible.
   ══════════════════════════════════════════════════════════════════ */

const APPROX_JOB_POOL_SIZE = 4204

function _estimateJobMatches(score) {
  const s = Math.max(0, Math.min(100, score))
  let rate
  if      (s >= 70) rate = 0.08 + (s - 70) / 30 * 0.06
  else if (s >= 60) rate = 0.04 + (s - 60) / 10 * 0.04
  else if (s >= 50) rate = 0.02 + (s - 50) / 10 * 0.02
  else              rate = 0.005 + (s / 50)  * 0.015
  const jitter = ((s * 17) % 7) - 3
  return Math.max(1, Math.round(APPROX_JOB_POOL_SIZE * rate) + jitter)
}

function ValuePreviewCard({ results, onSignIn }) {
  const [visible,   setVisible]   = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [collapsed, setCollapsed] = useState(false)

  // Delay slightly so card feels earned after results land
  useEffect(() => {
    if (!results || results.length === 0) return
    const t = setTimeout(() => setVisible(true), 600)
    return () => clearTimeout(t)
  }, [results])

  // Reset on every new result set
  useEffect(() => {
    setDismissed(false)
    setCollapsed(false)
    setVisible(false)
  }, [results])

  if (!results || results.length === 0 || !visible) return null

  const previews = results
    .filter(r => (r.score || r.llm_score || 0) >= 45)
    .slice(0, 3)
    .map(r => ({
      name: r.name || r.resume_name || 'Resume',
      score: r.score || r.llm_score || 0,
      matchCount: _estimateJobMatches(r.score || r.llm_score || 0),
    }))

  if (previews.length === 0) return null

  const totalJobs = previews.reduce((sum, p) => sum + p.matchCount, 0)

  // ── Collapsed teaser pill ───────────────────────────────────────
  if (dismissed || collapsed) {
    return createPortal(
      <div className="preview-teaser-badge">
        <button
          onClick={() => { setDismissed(false); setCollapsed(false) }}
          style={{
            display: 'flex', alignItems: 'center', gap: '8px',
            padding: '10px 18px',
            background: 'linear-gradient(135deg, rgba(14,14,14,0.97), rgba(10,10,10,0.99))',
            border: '1px solid rgba(232,255,107,0.35)',
            borderRadius: '40px', cursor: 'pointer',
            boxShadow: '0 8px 32px rgba(0,0,0,0.55)',
            backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)',
          }}
        >
          <span style={{ fontSize: '14px' }}>✦</span>
          <span style={{ fontFamily: 'var(--font-display)', fontSize: '13px', fontWeight: 700, color: 'var(--accent)' }}>
            {totalJobs.toLocaleString()} jobs matched
          </span>
          <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.35)' }}>tap to view →</span>
        </button>
      </div>,
      document.body
    )
  }

  // ── Full floating panel ─────────────────────────────────────────
  return createPortal(
    <div className="preview-floating-panel">
      <div style={{
        background: 'linear-gradient(160deg, rgba(16,16,16,0.98) 0%, rgba(11,11,11,0.99) 100%)',
        border: '1px solid rgba(232,255,107,0.22)',
        borderRadius: '20px', overflow: 'hidden',
        boxShadow: '0 32px 80px rgba(0,0,0,0.65), 0 0 0 1px rgba(255,255,255,0.04)',
        backdropFilter: 'blur(24px)', WebkitBackdropFilter: 'blur(24px)',
      }}>

        {/* Gradient accent bar */}
        <div style={{ height: '2px', background: 'linear-gradient(90deg, #e8ff6b 0%, #a78bfa 65%, transparent 100%)' }} />

        <div style={{ padding: '20px 22px 22px' }}>

          {/* ── Header row ── */}
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px', marginBottom: '16px' }}>

            {/* Lock icon */}
            <div style={{
              width: '42px', height: '42px', flexShrink: 0,
              background: 'rgba(232,255,107,0.08)', border: '1px solid rgba(232,255,107,0.18)',
              borderRadius: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: '18px',
            }}>🔒</div>

            {/* Title */}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
                <span style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--accent)' }}>
                  ✦ Auto-Match Preview
                </span>
              </div>
              <div style={{ fontFamily: 'var(--font-display)', fontSize: '17px', fontWeight: 800, color: 'var(--text)', lineHeight: 1.2 }}>
                Found{' '}
                <span style={{ color: 'var(--accent)' }}>{totalJobs.toLocaleString()} live jobs</span>
                {' '}matching for your resume{previews.length > 1 ? 's' : ''}
              </div>
            </div>

            {/* Minimise + close */}
            <div style={{ display: 'flex', gap: '5px', flexShrink: 0 }}>
              <button
                className="preview-dismiss-btn"
                onClick={() => setCollapsed(true)}
                title="Minimise"
                style={{
                  width: '26px', height: '26px',
                  background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: '8px', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: '14px', color: 'rgba(255,255,255,0.45)',
                  transition: 'background 0.15s ease',
                }}
              >−</button>
              <button
                className="preview-dismiss-btn"
                onClick={() => setDismissed(true)}
                title="Dismiss"
                style={{
                  width: '26px', height: '26px',
                  background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: '8px', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: '12px', color: 'rgba(255,255,255,0.45)',
                  transition: 'background 0.15s ease',
                }}
              >✕</button>
            </div>
          </div>

          {/* ── Per-resume rows — each row clicks to sign in ── */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '16px' }}>
            {previews.map((p, i) => (
              <div
                key={i}
                className="preview-resume-row"
                onClick={onSignIn}
                style={{
                  display: 'flex', alignItems: 'center', gap: '10px',
                  padding: '11px 14px', borderRadius: '12px',
                  background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)',
                  cursor: 'pointer', transition: 'background 0.18s ease, border-color 0.18s ease',
                }}
              >
                {/* Icon */}
                <span style={{ fontSize: '14px', flexShrink: 0 }}>📄</span>

                {/* Resume name — full remaining width */}
                <span style={{
                  fontSize: '13px', fontWeight: 600, color: 'var(--text)',
                  flex: 1, minWidth: 0,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }} title={p.name}>
                  {p.name}
                </span>

                {/* Match count badge */}
                <span style={{
                  fontSize: '12px', fontWeight: 700, padding: '4px 11px', flexShrink: 0,
                  borderRadius: '20px', background: 'rgba(52,211,153,0.1)',
                  color: '#34d399', border: '1px solid rgba(52,211,153,0.22)',
                  whiteSpace: 'nowrap',
                }}>
                  {p.matchCount} match{p.matchCount !== 1 ? 'es' : ''}
                </span>

                {/* Arrow hint */}
                <span style={{ fontSize: '13px', color: 'rgba(232,255,107,0.4)', flexShrink: 0 }}>→</span>
              </div>
            ))}
          </div>

          {/* ── Primary CTA ── */}
          <button
            className="preview-card-cta"
            onClick={onSignIn}
            style={{
              width: '100%', padding: '14px 18px',
              background: 'rgba(232,255,107,0.1)',
              border: '1px solid rgba(232,255,107,0.38)',
              borderRadius: '13px', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px',
              fontFamily: 'var(--font-display)', fontSize: '14px', fontWeight: 700,
              color: 'var(--accent)', transition: 'all 0.2s ease',
            }}
          >
            <span>Sign in to unlock all {totalJobs.toLocaleString()} matches</span>
            <span style={{ fontSize: '16px' }}>→</span>
          </button>

          <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.22)', textAlign: 'center', marginTop: '10px', letterSpacing: '0.02em' }}>
            Daily auto-matching · application tracking · full AI analysis
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}

export default function Home() {
  const { user, signInWithGoogle } = useAuth()
  const isAuthed = !!user

  // Guard: don't render ValuePreviewCard until auth state has been checked.
  // This prevents the card from briefly flashing for authenticated users on
  // page load before Supabase's onAuthStateChange fires.
  const [authChecked, setAuthChecked] = useState(false)
  useEffect(() => {
    // Give Supabase one tick to resolve the session from storage
    const t = setTimeout(() => setAuthChecked(true), 50)
    return () => clearTimeout(t)
  }, [])

  // ── Anonymous session ID — scopes FAISS index so only THIS session's
  //    resumes get matched. Generated once, persisted in localStorage.
  const sessionId = (() => {
    try {
      let sid = localStorage.getItem('rack_session_id')
      if (!sid) {
        sid = 'anon_' + Math.random().toString(36).slice(2, 11) + '_' + Date.now().toString(36)
        localStorage.setItem('rack_session_id', sid)
      }
      return sid
    } catch { return 'anon_default' }
  })()

  const [jd, setJd]               = useState('')
  const [messages, setMessages]   = useState([])        // multi-turn conversation thread
  const [loading, setLoading]     = useState(false)
  const [filterLoading, setFilterLoading] = useState(false)
  const [expandedIds, setExpandedIds] = useState(new Set()) // per-card key: `${msg.id}-${resume_id}`
  const [resumeCount, setResumeCount] = useState(null)
  const [resumeWarning, setResumeWarning] = useState(false)

  // Derived: last completed message's results (for ValuePreviewCard)
  const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null
  const lastResults = lastMsg?.results ?? null
  const hasConversation = messages.length > 0

  // ── Anonymous upload queue ──────────────────────────────────────
  // fileQueue: File[] staged before clicking Match It
  // uploadQueue: { name, status }[] — drives animation during processing
  const [fileQueue, setFileQueue]     = useState([])  // staged files
  const [uploadQueue, setUploadQueue] = useState([])  // live status for animation
  const fileInputRef = useRef(null)
  const chatScrollRef = useRef(null)
  const textareaRef   = useRef(null)

  // ── Resume count ────────────────────────────────────────────────
  useEffect(() => {
    if (user) {
      getAuthHeaders()
        .then(headers => fetch('http://localhost:8000/api/resumes', { headers }))
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
  const AUTH_CAP = 5   // matches MAX_RESUMES_AUTH in resumes.py
  const effectiveCap  = isAuthed ? AUTH_CAP : ANON_CAP
  const savedCount    = resumeCount || 0
  const slotsLeft     = Math.max(0, effectiveCap - savedCount - fileQueue.length)
  const atCap         = savedCount + fileQueue.length >= effectiveCap

  const handleFileSelect = (e) => {
    const files = Array.from(e.target.files || [])
    const valid = files.filter(f => ALLOWED_TYPES.includes(f.type))

    setFileQueue(prev => {
      // Deduplicate by name against already-queued files
      const existingNames = new Set(prev.map(f => f.name))
      const fresh = valid.filter(f => !existingNames.has(f.name))

      // Enforce cap: slots remaining = effectiveCap - already saved - already queued
      const slotsRemaining = Math.max(0, effectiveCap - (resumeCount || 0) - prev.length)

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

  // ── Auto-scroll chat area to bottom when new messages arrive ──
  useEffect(() => {
    if (messages.length > 0 && chatScrollRef.current) {
      setTimeout(() => {
        chatScrollRef.current?.scrollTo({ top: chatScrollRef.current.scrollHeight, behavior: 'smooth' })
      }, 100)
    }
  }, [messages, loading])

  // ── Auto-resize textarea ─────────────────────────────────────────
  useEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = Math.min(ta.scrollHeight, 160) + 'px'
  }, [jd])

  // ── Auto-match filter chips (auth'd greeting state) ──────────────
  const handleAutoMatchFilter = async (action) => {
    if (filterLoading) return
    setFilterLoading(true)

    try {
      const headers = await getAuthHeaders()
      // Correct endpoint — same one Tracking.jsx uses
      const res = await fetch('http://localhost:8000/api/tracking/auto/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ force: false }),
      })
      if (!res.ok) throw new Error('Failed to load matches')
      const data = await res.json()
      let jobs = data.matches || []

      // Apply filter — server already sorts by score*0.85 + recency*0.15
      if      (action === 'filter:85')  jobs = jobs.filter(j => (j.score ?? 0) >= 85)
      else if (action === 'filter:75')  jobs = jobs.filter(j => (j.score ?? 0) >= 75)
      else if (action === 'filter:new') {
        // Sort by posted_at descending — most recently posted first
        jobs = [...jobs].sort((a, b) => {
          const ta = new Date(a.posted_at || a.matched_at || 0).getTime()
          const tb = new Date(b.posted_at || b.matched_at || 0).getTime()
          return tb - ta
        })
      }
      // 'filter:all' — keep default server sort (score + recency)

      const label = {
        'filter:all': `All matched jobs`,
        'filter:85':  `85%+ match jobs`,
        'filter:75':  `75%+ match jobs`,
        'filter:new': `Newly matched jobs`,
      }[action] || 'Matched jobs'

      const msgId = Date.now()
      setMessages(prev => [...prev, {
        id: msgId,
        jd: label,
        isFilterResult: true,
        filterAction: action,
        filterJobs: jobs,
        results: null,
        loading: false,
        error: jobs.length === 0 ? 'No jobs found for this filter. Try refreshing Auto Matches in the Tracking tab.' : null,
      }])
    } catch (err) {
      console.error('Filter error:', err)
      const msgId = Date.now()
      setMessages(prev => [...prev, {
        id: msgId,
        jd: 'Auto-match filter',
        isFilterResult: true,
        filterJobs: [],
        results: null,
        loading: false,
        error: 'Could not load matched jobs. Make sure you have run Auto Matches in the Tracking tab first.',
      }])
    } finally {
      setFilterLoading(false)
    }
  }

  // ── Download a resume file ──────────────────────────────────────
  const handleDownload = async (e, resumeId, resumeName) => {
    e.stopPropagation() // don't expand the card
    try {
      const headers = isAuthed ? await getAuthHeaders() : { 'X-Session-ID': sessionId }
      // Step 1: get the signed URL from the backend
      const res = await fetch(`http://localhost:8000/api/resumes/${resumeId}/file`, { headers })
      if (!res.ok) throw new Error('Failed to fetch download URL')
      const data = await res.json()

      // Step 2: fetch the file as a blob — the Supabase URL never appears in the address bar
      const fileRes = await fetch(data.url)
      if (!fileRes.ok) throw new Error('Failed to fetch file')
      const blob = await fileRes.blob()

      // Step 3: create a local object URL and trigger download silently
      const objectUrl = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = objectUrl
      link.download = resumeName || 'resume'
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      // Release memory
      setTimeout(() => URL.revokeObjectURL(objectUrl), 10000)
    } catch (err) {
      console.error('Download failed:', err)
    }
  }

  // ── Input triage — asks backend to classify before touching the match pipeline ──
  // Returns: { intent: 'JD' | 'CAREER_QUESTION' | 'OFF_TOPIC', reply: string | null }
  const triageInput = async (text) => {
    try {
      const headers = isAuthed
        ? await getAuthHeaders()
        : { 'X-Session-ID': sessionId }
      const res = await fetch('http://localhost:8000/api/match/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ text }),
      })
      if (!res.ok) throw new Error('Triage failed')
      return await res.json()  // { intent, reply }
    } catch {
      // Backend unreachable — assume JD so the match pipeline still runs
      return { intent: 'JD', reply: null }
    }
  }

  // ── Match handler ───────────────────────────────────────────────
  const handleMatch = async () => {
    if (!jd.trim() || loading) return

    const capturedJd = jd.trim()
    const msgId = Date.now()

    setLoading(true)
    setJd('')  // clear textarea immediately so it feels responsive

    // ── Step 0: Triage — classify input before touching the match pipeline ──
    const triage = await triageInput(capturedJd)
    const intent = triage.intent

    // OFF_TOPIC — warm redirect, no backend match call
    if (intent === 'OFF_TOPIC') {
      setMessages(prev => [...prev, {
        id: msgId,
        jd: capturedJd,
        isAssistantReply: true,
        replyText: "I'm built to help you land your next job — paste a job description and I'll instantly rank your resumes against it, or ask me anything about your job search, resume, or interview prep.",
        loading: false,
        error: null,
      }])
      setLoading(false)
      return
    }

    // CAREER_QUESTION — reply already came back from the backend, render it directly
    if (intent === 'CAREER_QUESTION') {
      setMessages(prev => [...prev, {
        id: msgId,
        jd: capturedJd,
        isAssistantReply: true,
        replyText: triage.reply,
        loading: false,
        error: null,
      }])
      setLoading(false)
      return
    }

    // FILTER_RESULT — backend ran get_matched_jobs and returned structured rows.
    // Render through the same paginated table as the filter chips — no new code needed.
    if (intent === 'FILTER_RESULT') {
      const jobs = triage.jobs || []
      const label = triage.filter_label || 'Matched jobs'
      setMessages(prev => [...prev, {
        id: msgId,
        jd: label,
        isFilterResult: true,
        filterJobs: jobs,
        results: null,
        loading: false,
        error: jobs.length === 0
          ? 'No jobs matched that filter. Try running Auto Matches in the Tracking tab first.'
          : null,
      }])
      setLoading(false)
      return
    }

    // JD — run the full matching pipeline below
    const hasExistingResumes = resumeCount > 0
    const hasQueuedFiles     = fileQueue.length > 0

    if (!hasExistingResumes && !hasQueuedFiles) {
      setMessages(prev => [...prev, {
        id: msgId,
        jd: capturedJd,
        isAssistantReply: true,
        replyText: "You'll need at least one resume uploaded to match against. Head to the Resumes tab to add yours — it only takes a moment.",
        loading: false,
        error: null,
      }])
      setLoading(false)
      return
    }

    // Append loading placeholder for this turn
    setMessages(prev => [...prev, {
      id: msgId,
      jd: capturedJd,
      results: null,
      jdParsed: null,
      meta: null,
      loading: true,
      error: null,
    }])

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
            headers: { 'X-Session-ID': sessionId },
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
        headers: {
          'Content-Type': 'application/json',
          'X-Session-ID': isAuthed ? (user?.id || 'default') : sessionId,
        },
        body: JSON.stringify({ job_description: capturedJd, use_llm: true }),
      })

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}))
        throw new Error(errData.detail || `Server error (${res.status})`)
      }

      const data = await res.json()
      setMessages(prev => prev.map(m => m.id === msgId
        ? { ...m, results: data.results || [], jdParsed: data.jd_parsed || null, meta: data.meta || null, loading: false }
        : m
      ))
    } catch (err) {
      setMessages(prev => prev.map(m => m.id === msgId
        ? { ...m, error: err.message || 'Failed to connect to backend', loading: false }
        : m
      ))
    } finally {
      setLoading(false)
      setUploadQueue([])
    }
  }


  // ── Suggestion chip handler ──────────────────────────────────────
  const handleSuggestion = (text) => {
    setJd(text)
    textareaRef.current?.focus()
  }

  const capWarning    = typeof resumeWarning === 'string' && resumeWarning.startsWith('cap:')
  const droppedCount  = capWarning ? parseInt(resumeWarning.split(':')[1]) : 0

  // jdPreview is now per-message — computed inline in the render loop

  return (
    <>
    <style>{mobileCardStyles}</style>

    {/* ══ Chat root — full-viewport flex column ══ */}
    <div className="rack-chat-root">

      {/* ── Scrollable chat area — full bleed, content flows under floating nav ── */}
      <div className="rack-chat-scroll" ref={chatScrollRef}>

        {/* "new chat" pill — floats top-right inside scroll area when a convo is active */}
        {hasConversation && (
          <button
            onClick={() => { setMessages([]); setJd(''); setExpandedIds(new Set()) }}
            style={{
              position: 'sticky', top: '0px', alignSelf: 'flex-end',
              fontSize: '11px', padding: '5px 12px', borderRadius: '20px',
              background: 'rgba(255,255,255,0.07)', color: 'var(--text-dim)',
              border: '1px solid rgba(255,255,255,0.1)', fontWeight: 500, cursor: 'pointer',
              fontFamily: 'var(--font-body)', marginBottom: '12px',
              transition: 'all 0.15s ease', zIndex: 10,
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.12)'; e.currentTarget.style.color = 'var(--text)' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.07)'; e.currentTarget.style.color = 'var(--text-dim)' }}
          >
            ✕ new chat
          </button>
        )}

        {/* ── Greeting state (no conversation yet) ── */}
        {!hasConversation && !loading && (
          <div className="rack-greeting">
            <div className="rack-greeting-hero">
              <div className="rack-greeting-eyebrow">
                <span style={{width:'24px',height:'1px',background:'var(--accent)',opacity:0.5,display:'inline-block'}}/>
                AI-Powered Matching
                <span style={{width:'24px',height:'1px',background:'var(--accent)',opacity:0.5,display:'inline-block'}}/>
              </div>
              <h1 className="rack-greeting-title">
                Drop the JD.<br />
                <span style={{ background:'linear-gradient(135deg,#e8ff6b,#b8ff3a)', WebkitBackgroundClip:'text', WebkitTextFillColor:'transparent' }}>
                  We'll find your fit.
                </span>
              </h1>
              <p className="rack-greeting-sub">
                Paste any job description below and instantly rank your resume versions.
              </p>
            </div>

            {/* Suggestion chips — context-aware */}
            <div className="rack-suggestion-chips">
              {isAuthed ? (
                // Auth'd users: quick-filters into their auto-match results
                [
                  { label: '⚡ View all matched jobs',        action: 'filter:all' },
                  { label: '🏆 85%+ match jobs',              action: 'filter:85'  },
                  { label: '✅ 75%+ match jobs',              action: 'filter:75'  },
                  { label: '🆕 View newly matched jobs',      action: 'filter:new' },
                ].map(chip => (
                  <button
                    key={chip.action}
                    className="rack-suggestion-chip"
                    onClick={() => handleAutoMatchFilter(chip.action)}
                  >
                    {chip.label}
                  </button>
                ))
              ) : (
                // Anon users: sample JD starters
                [
                  '🔍 Paste a job description',
                  '🤖 Try an ML Engineer role',
                  '💼 Software Engineer — Senior',
                  '📊 Data Scientist position',
                ].map(chip => (
                  <button
                    key={chip}
                    className="rack-suggestion-chip"
                    onClick={() => handleSuggestion(chip.replace(/^[\p{Emoji}\s]+/u, ''))}
                  >
                    {chip}
                  </button>
                ))
              )}
            </div>
          </div>
        )}

        {/* ── Conversation thread — multi-turn, one entry per submitted JD ── */}
        {messages.map((msg) => {
          const msgJdPreview = msg.jd.length > 220 ? msg.jd.slice(0, 220).trimEnd() + '…' : msg.jd

          return (
            <div key={msg.id} style={{ display: 'flex', flexDirection: 'column', gap: 0, width: '100%', maxWidth: '900px', margin: '0 auto' }}>

              {/* User bubble — the JD they sent */}
              <div className="rack-msg-row user">
                <div className="rack-bubble-user">
                  <div className="rack-bubble-user-label">You</div>
                  {msgJdPreview}
                </div>
              </div>

              {/* RACK reply bubble */}
              <div className="rack-msg-row rack">
                <div className="rack-bubble-rack">
                  <div className="rack-bubble-rack-label">
                    <span className="rack-bubble-rack-label-dot" />
                    Rack
                  </div>

                  {/* Pipeline animation while this turn is loading — JD turns only */}
                  {msg.loading && !msg.isAssistantReply && (
                    <div style={{ marginBottom: '8px' }}>
                      <JDPipelineAnimation uploadQueue={uploadQueue} />
                    </div>
                  )}

                  {/* Error */}
                  {msg.error && (
                    <div style={{
                      padding: '14px 18px', borderRadius: '12px',
                      background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.2)',
                      color: 'var(--danger)', fontSize: '14px',
                      animation: 'bubbleIn 0.3s ease both',
                    }}>
                      {msg.error}
                    </div>
                  )}

                  {/* Filter results — auto-match chip queries, paginated 5/page */}
                  {msg.isFilterResult && !msg.error && (() => {
                    const PAGE_SIZE_F = 5
                    const allJobs     = msg.filterJobs || []
                    const totalJobs   = allJobs.length
                    const fPage       = msg.filterPage || 1
                    const totalPages  = Math.max(1, Math.ceil(Math.min(totalJobs, 20) / PAGE_SIZE_F))
                    const pageJobs    = allJobs.slice((fPage - 1) * PAGE_SIZE_F, fPage * PAGE_SIZE_F)
                    const setFPage    = (p) => setMessages(prev => prev.map(m => m.id === msg.id ? { ...m, filterPage: p } : m))

                    return (
                      <div style={{ animation: 'bubbleIn 0.4s ease both' }}>

                        {/* ── Header bar ── */}
                        <div style={{
                          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                          marginBottom: '12px', padding: '0 2px',
                        }}>
                          <span style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-dim)' }}>
                            {Math.min(totalJobs, 20)} job{totalJobs !== 1 ? 's' : ''} · page {fPage}/{totalPages}
                          </span>
                          {totalJobs > 20 && (
                            <span className="rack-tracking-cta" onClick={() => {}}>
                              ✦ See all {totalJobs} in Tracking →
                            </span>
                          )}
                        </div>

                        {/* ── Table header row ── */}
                        <div style={{
                          display: 'grid',
                          gridTemplateColumns: '40px 1fr 56px',
                          gap: '0 12px',
                          padding: '6px 14px',
                          marginBottom: '4px',
                          borderBottom: '1px solid rgba(255,255,255,0.06)',
                        }}>
                          <span style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-dim)' }}>#</span>
                          <span style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-dim)' }}>Role · Company</span>
                          <span style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-dim)', textAlign: 'right' }}>Score</span>
                        </div>

                        {/* ── Job rows ── */}
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                          {pageJobs.map((job, ji) => {
                            const globalIdx = (fPage - 1) * PAGE_SIZE_F + ji
                            const jScore    = Math.round(job.score ?? 0)
                            const sc        = jScore >= 85 ? 'var(--accent)' : jScore >= 65 ? '#60a5fa' : '#fb923c'
                            const gradient  = jScore >= 85
                              ? 'linear-gradient(90deg,#e8ff6b,#a3e635)'
                              : jScore >= 65
                              ? 'linear-gradient(90deg,#60a5fa,#818cf8)'
                              : 'linear-gradient(90deg,#fb923c,#f87171)'
                            const title     = job.job_title || 'Untitled'
                            const company   = job.company
                              ? job.company.charAt(0).toUpperCase() + job.company.slice(1)
                              : '—'
                            const posted    = job.posted_at || job.matched_at
                            const daysAgo   = posted
                              ? Math.max(0, Math.round((Date.now() - new Date(posted).getTime()) / 86400000))
                              : null
                            const isAI      = job.scoring_method === 'llm+hybrid'
                            const rec       = job.llm_recommendation

                            return (
                              <div key={globalIdx} style={{
                                borderRadius: '10px', overflow: 'hidden',
                                background: 'var(--surface)', border: '1px solid var(--border-bright)',
                                animation: `bubbleIn 0.25s ease ${ji * 0.04}s both`,
                              }}>
                                {/* Score accent bar */}
                                <div style={{ height: '2px', background: gradient, width: `${jScore}%`, transition: 'width 0.8s cubic-bezier(0.22,1,0.36,1)' }} />

                                <div style={{ padding: '14px 16px 12px' }}>
                                  {/* Main row: rank · content · score */}
                                  <div style={{ display: 'grid', gridTemplateColumns: '28px 1fr 52px', gap: '0 12px', alignItems: 'start' }}>

                                    {/* Rank number */}
                                    <div style={{
                                      fontFamily: 'var(--font-display)', fontSize: '15px', fontWeight: 800,
                                      color: globalIdx === 0 ? 'var(--accent)' : 'rgba(255,255,255,0.18)',
                                      lineHeight: '20px', paddingTop: '1px',
                                    }}>
                                      #{globalIdx + 1}
                                    </div>

                                    {/* Title + company + time */}
                                    <div style={{ minWidth: 0 }}>
                                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', marginBottom: '3px' }}>
                                        <span style={{ fontFamily: 'var(--font-display)', fontSize: '14px', fontWeight: 700, color: 'var(--text)', wordBreak: 'break-word', lineHeight: 1.3 }}>
                                          {title}
                                        </span>
                                        {isAI && (
                                          <span style={{ fontSize: '8px', fontWeight: 700, padding: '1px 5px', borderRadius: '20px', background: 'rgba(232,255,107,0.1)', color: 'var(--accent)', border: '1px solid rgba(232,255,107,0.2)', letterSpacing: '0.08em', flexShrink: 0 }}>AI</span>
                                        )}
                                        {rec && (
                                          <span style={{
                                            fontSize: '9px', fontWeight: 700, padding: '1px 7px', borderRadius: '20px', flexShrink: 0,
                                            background: rec === 'Strong Match' ? 'rgba(52,211,153,0.12)' : rec === 'Good Match' ? 'rgba(232,255,107,0.1)' : 'rgba(251,146,60,0.1)',
                                            color:      rec === 'Strong Match' ? 'var(--accent3)'        : rec === 'Good Match' ? 'var(--accent)'        : '#fb923c',
                                            border: `1px solid ${rec === 'Strong Match' ? 'rgba(52,211,153,0.25)' : rec === 'Good Match' ? 'rgba(232,255,107,0.22)' : 'rgba(251,146,60,0.22)'}`,
                                          }}>
                                            {rec}
                                          </span>
                                        )}
                                      </div>
                                      <div style={{ fontSize: '12px', color: 'var(--text-dim)', display: 'flex', alignItems: 'center', gap: '5px' }}>
                                        <span style={{ fontWeight: 500 }}>{company}</span>
                                        {daysAgo !== null && <span>· {daysAgo === 0 ? 'today' : daysAgo === 1 ? 'yesterday' : `${daysAgo}d ago`}</span>}
                                      </div>
                                    </div>

                                    {/* Score */}
                                    <div style={{ textAlign: 'right' }}>
                                      <div style={{ fontFamily: 'var(--font-display)', fontSize: '22px', fontWeight: 800, color: sc, lineHeight: 1 }}>{jScore}</div>
                                      <div style={{ fontSize: '10px', color: 'var(--text-dim)', fontWeight: 300, marginTop: '2px' }}>match</div>
                                    </div>
                                  </div>

                                  {/* Skill pills */}
                                  {((job.matched_skills || []).length > 0 || (job.missing_skills || []).length > 0) && (
                                    <div style={{ display: 'flex', gap: '5px', marginTop: '10px', flexWrap: 'wrap' }}>
                                      {(job.matched_skills || []).slice(0, 3).map(s => (
                                        <span key={s} style={{ fontSize: '10px', fontWeight: 600, padding: '2px 8px', borderRadius: '20px', background: 'rgba(52,211,153,0.1)', color: 'var(--accent3)' }}>✓ {s}</span>
                                      ))}
                                      {(job.missing_skills || []).slice(0, 2).map(s => (
                                        <span key={s} style={{ fontSize: '10px', fontWeight: 600, padding: '2px 8px', borderRadius: '20px', background: 'rgba(248,113,113,0.08)', color: 'var(--danger)' }}>✗ {s}</span>
                                      ))}
                                    </div>
                                  )}

                                  {/* Resume download — no Apply button (use Tracking for that) */}
                                  {job.resume_name && (
                                    <div style={{ marginTop: '8px', fontSize: '11px', color: 'var(--text-dim)' }}>
                                      Best resume:{' '}
                                      {job.resume_id ? (
                                        <button
                                          onClick={(e) => handleDownload(e, job.resume_id, job.resume_name)}
                                          style={{
                                            background: 'none', border: 'none', padding: '0 2px',
                                            cursor: 'pointer', color: 'var(--accent)', fontWeight: 600,
                                            fontSize: '11px', fontFamily: 'var(--font-body)',
                                            textDecoration: 'underline', textDecorationStyle: 'dotted',
                                            textUnderlineOffset: '2px',
                                          }}
                                        >
                                          {job.resume_name} ↓
                                        </button>
                                      ) : (
                                        <span style={{ color: 'var(--accent)', fontWeight: 600 }}>{job.resume_name}</span>
                                      )}
                                    </div>
                                  )}
                                </div>
                              </div>
                            )
                          })}
                        </div>

                        {/* ── Pagination controls ── */}
                        {totalPages > 1 && (
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '14px', padding: '0 2px' }}>
                            <button
                              onClick={() => setFPage(Math.max(1, fPage - 1))}
                              disabled={fPage <= 1}
                              style={{
                                padding: '6px 16px', borderRadius: '20px', fontSize: '12px', fontWeight: 600,
                                background: fPage <= 1 ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.08)',
                                border: '1px solid rgba(255,255,255,0.1)',
                                color: fPage <= 1 ? 'var(--text-dim)' : 'var(--text)',
                                cursor: fPage <= 1 ? 'not-allowed' : 'pointer',
                                fontFamily: 'var(--font-body)', transition: 'all 0.15s ease',
                              }}
                            >← Prev</button>

                            <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                              {Array.from({ length: totalPages }, (_, i) => i + 1).map(p => (
                                <button
                                  key={p}
                                  onClick={() => setFPage(p)}
                                  style={{
                                    width: '28px', height: '28px', borderRadius: '50%',
                                    background: p === fPage ? 'var(--accent)' : 'transparent',
                                    border: p === fPage ? 'none' : '1px solid rgba(255,255,255,0.12)',
                                    color: p === fPage ? '#080808' : 'var(--text-dim)',
                                    fontFamily: 'var(--font-display)', fontSize: '12px', fontWeight: 700,
                                    cursor: 'pointer', transition: 'all 0.15s ease',
                                  }}
                                >{p}</button>
                              ))}
                            </div>

                            <button
                              onClick={() => setFPage(Math.min(totalPages, fPage + 1))}
                              disabled={fPage >= totalPages}
                              style={{
                                padding: '6px 16px', borderRadius: '20px', fontSize: '12px', fontWeight: 600,
                                background: fPage >= totalPages ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.08)',
                                border: '1px solid rgba(255,255,255,0.1)',
                                color: fPage >= totalPages ? 'var(--text-dim)' : 'var(--text)',
                                cursor: fPage >= totalPages ? 'not-allowed' : 'pointer',
                                fontFamily: 'var(--font-body)', transition: 'all 0.15s ease',
                              }}
                            >Next →</button>
                          </div>
                        )}

                        {/* ── Shimmer CTA — always shown at bottom ── */}
                        <div style={{ marginTop: '16px', padding: '12px 16px', borderRadius: '10px', background: 'rgba(232,255,107,0.03)', border: '1px solid rgba(232,255,107,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                          <span style={{ fontSize: '12px', color: 'var(--text-dim)', fontWeight: 400 }}>
                            Want to apply, filter by company, or see all {totalJobs} jobs?
                          </span>
                          <span className="rack-tracking-cta">
                            Open Tracking ✦
                          </span>
                        </div>
                      </div>
                    )
                  })()}

                  {/* ── Assistant reply bubble (career question or off-topic redirect) ── */}
                  {msg.isAssistantReply && (
                    <div style={{ animation: 'bubbleIn 0.35s ease both' }}>
                      {msg.loading ? (
                        // Thinking indicator
                        <div style={{
                          display: 'flex', alignItems: 'center', gap: '10px',
                          padding: '16px 20px', borderRadius: '14px',
                          background: 'var(--surface)', border: '1px solid var(--border-bright)',
                        }}>
                          <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                            {[0, 1, 2].map(i => (
                              <div key={i} style={{
                                width: '5px', height: '5px', borderRadius: '50%',
                                background: 'var(--accent)', opacity: 0.7,
                                animation: `pulse 1.2s ease-in-out ${i * 0.2}s infinite`,
                              }} />
                            ))}
                          </div>
                          <span style={{ fontSize: '13px', color: 'var(--text-dim)', fontWeight: 300 }}>Thinking…</span>
                        </div>
                      ) : (
                        <div style={{
                          padding: '16px 20px', borderRadius: '14px',
                          background: 'var(--surface)', border: '1px solid var(--border-bright)',
                          fontSize: '14px', lineHeight: '1.65', color: 'var(--text)',
                          fontWeight: 300, whiteSpace: 'pre-wrap',
                        }}>
                          {msg.replyText}
                          {/* Soft nudge to paste a JD — only shown for career questions, not off-topic */}
                          {msg.replyText && msg.replyText.length > 60 && (
                            <div style={{
                              marginTop: '14px', paddingTop: '12px',
                              borderTop: '1px solid rgba(255,255,255,0.06)',
                              display: 'flex', alignItems: 'center', gap: '8px',
                            }}>
                              <span style={{ fontSize: '11px', color: 'var(--text-dim)' }}>
                                Ready to match?
                              </span>
                              <button
                                onClick={() => textareaRef.current?.focus()}
                                style={{
                                  fontSize: '11px', fontWeight: 600, padding: '3px 12px',
                                  borderRadius: '20px', cursor: 'pointer', fontFamily: 'var(--font-body)',
                                  background: 'rgba(232,255,107,0.08)', border: '1px solid rgba(232,255,107,0.25)',
                                  color: 'var(--accent)', transition: 'all 0.15s ease',
                                }}
                                onMouseEnter={e => { e.currentTarget.style.background = 'rgba(232,255,107,0.15)' }}
                                onMouseLeave={e => { e.currentTarget.style.background = 'rgba(232,255,107,0.08)' }}
                              >
                                Paste a JD ↑
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Results */}
                  {!msg.isFilterResult && !msg.isAssistantReply && msg.results && msg.results.length === 0 && (
                    <div style={{
                      padding: '28px 24px', borderRadius: '14px',
                      background: 'var(--surface)', border: '1px solid var(--border-bright)',
                      textAlign: 'center', animation: 'bubbleIn 0.35s ease both',
                    }}>
                      <div style={{ fontSize: '28px', marginBottom: '10px' }}>📄</div>
                      <div style={{ fontFamily: 'var(--font-display)', fontSize: '16px', fontWeight: 600, color: 'var(--text)', marginBottom: '6px' }}>
                        No resumes to match against
                      </div>
                      <p style={{ fontSize: '13px', color: 'var(--text-dim)', fontWeight: 300, margin: 0 }}>
                        Upload your resumes in the Resumes tab first, then come back to match.
                      </p>
                    </div>
                  )}

                  {!msg.isFilterResult && !msg.isAssistantReply && msg.results && msg.results.length > 0 && (
                    <div style={{ animation: 'bubbleIn 0.4s ease both' }}>
                      {/* JD Parse Summary */}
                      {msg.jdParsed && (
                        <div style={{
                          marginBottom: '14px', padding: '10px 14px', borderRadius: '10px',
                          background: 'rgba(232,255,107,0.03)', border: '1px solid rgba(232,255,107,0.1)',
                        }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px', flexWrap: 'wrap' }}>
                            {msg.jdParsed.title && (
                              <span style={{ fontFamily: 'var(--font-display)', fontSize: '14px', fontWeight: 700, color: 'var(--text)' }}>
                                {msg.jdParsed.title}
                              </span>
                            )}
                            {msg.jdParsed.min_years && (
                              <span style={{ fontSize: '11px', color: 'var(--text-dim)' }}>
                                · {msg.jdParsed.min_years}+ yrs
                              </span>
                            )}
                            <span style={{
                              fontSize: '10px', padding: '2px 8px', borderRadius: '10px', marginLeft: 'auto',
                              background: msg.jdParsed.extraction_method === 'hybrid' ? 'rgba(52,211,153,0.12)' : 'rgba(255,255,255,0.06)',
                              color: msg.jdParsed.extraction_method === 'hybrid' ? 'var(--accent3)' : 'var(--text-dim)',
                              border: `1px solid ${msg.jdParsed.extraction_method === 'hybrid' ? 'rgba(52,211,153,0.2)' : 'rgba(255,255,255,0.08)'}`,
                              fontWeight: 600,
                            }}>
                              {msg.jdParsed.extraction_method === 'hybrid' ? 'Rule + LLM' : 'Rule-based'}
                            </span>
                            {msg.meta?.llm_scored > 0 && (
                              <span style={{ fontSize: '10px', padding: '2px 8px', borderRadius: '10px', background: 'rgba(167,139,250,0.12)', color: '#a78bfa', border: '1px solid rgba(167,139,250,0.22)', fontWeight: 600 }}>
                                ✦ {msg.meta.llm_scored} AI-scored
                              </span>
                            )}
                            {msg.meta && (
                              <span style={{ fontSize: '11px', color: 'var(--text-dim)' }}>{msg.meta.pipeline_time_ms}ms</span>
                            )}
                          </div>
                          <div className="rack-jd-chips" style={{ display: 'flex', gap: '5px', flexWrap: 'wrap' }}>
                            {(msg.jdParsed.required_skills || []).slice(0, 7).map(s => (
                              <span key={s} className="rack-jd-chip" style={{ fontSize: '11px', fontWeight: 500, padding: '2px 9px', borderRadius: '20px', background: 'rgba(232,255,107,0.06)', color: 'var(--accent)', border: '1px solid rgba(232,255,107,0.15)', whiteSpace: 'nowrap' }}>
                                {s}
                              </span>
                            ))}
                            {(msg.jdParsed.required_skills || []).length > 7 && (
                              <span className="rack-jd-chip" style={{ fontSize: '11px', padding: '2px 9px', color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>
                                +{msg.jdParsed.required_skills.length - 7} more
                              </span>
                            )}
                          </div>
                        </div>
                      )}

                      {/* Ranked result header */}
                      <div style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-dim)', marginBottom: '10px', paddingLeft: '2px' }}>
                        Ranked Results — {msg.results.length} resume{msg.results.length !== 1 ? 's' : ''}
                      </div>

                      {/* Result cards */}
                      {msg.results.map((r, i) => {
                        const cardKey     = `${msg.id}-${r.resume_id}`
                        const isExpanded  = expandedIds.has(cardKey)
                        const isLLM       = r.scoring_method === 'llm+hybrid'
                        const displayScore = r.llm_score ?? r.score ?? 0
                        const rec         = r.llm_recommendation
                        const recStyle    = rec ? recommendationStyle(rec) : null

                        return (
                          <div key={cardKey} className="rack-card-padding" style={{
                            background: i === 0 ? 'rgba(232,255,107,0.04)' : 'var(--surface)',
                            border: `1px solid ${i === 0 ? 'rgba(232,255,107,0.3)' : 'var(--border-bright)'}`,
                            borderRadius: '14px', padding: '18px 22px', marginBottom: '10px',
                            cursor: 'pointer', transition: 'all 0.2s ease',
                            animation: `bubbleIn 0.4s ease ${i * 0.07}s both`,
                            boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
                          }}
                          onClick={() => setExpandedIds(prev => {
                            const next = new Set(prev)
                            next.has(cardKey) ? next.delete(cardKey) : next.add(cardKey)
                            return next
                          })}
                          >
                            {/* Collapsed row */}
                            <div className="rack-card-row" style={{ display: 'flex', alignItems: 'center', gap: '18px' }}>
                              <div className="rack-card-rank" style={{ fontFamily:'var(--font-display)', fontSize:'24px', fontWeight:800, color: i===0 ? 'var(--accent)' : 'rgba(255,255,255,0.15)', minWidth:'36px' }}>
                                #{i+1}
                              </div>
                              <div style={{ flex:1, minWidth:0 }}>
                                <div className="rack-card-badges" style={{ display:'flex', alignItems:'center', gap:'8px', marginBottom:'6px', flexWrap:'wrap' }}>
                                  <span className="rack-card-name" style={{ fontFamily:'var(--font-display)', fontSize:'16px', fontWeight:600, color:'var(--text)' }}>{r.name}</span>
                                  <span style={{ fontSize:'10px', padding:'2px 6px', borderRadius:'6px', background:'rgba(255,255,255,0.06)', color:'var(--text-dim)', fontWeight:500 }}>
                                    {r.file_ext?.replace('.','').toUpperCase()}
                                  </span>
                                  {isLLM && (
                                    <span style={{ fontSize:'10px', padding:'2px 7px', borderRadius:'6px', background:'rgba(167,139,250,0.12)', color:'#a78bfa', border:'1px solid rgba(167,139,250,0.22)', fontWeight:700, letterSpacing:'0.04em' }}>AI</span>
                                  )}
                                  {rec && recStyle && (
                                    <span style={{ fontSize:'10px', padding:'2px 9px', borderRadius:'20px', background:recStyle.bg, color:recStyle.color, border:`1px solid ${recStyle.border}`, fontWeight:600 }}>
                                      {rec}
                                    </span>
                                  )}
                                </div>
                                {/* Score bar */}
                                <div style={{ height:'4px', background:'rgba(255,255,255,0.08)', borderRadius:'4px', overflow:'hidden' }}>
                                  <div style={{ height:'100%', borderRadius:'4px', background:scoreColor(displayScore), width:`${displayScore}%`, transition:'width 1s cubic-bezier(0.22,1,0.36,1)' }} />
                                </div>
                                {/* Skill pills */}
                                <div className="rack-card-collapsed-skills" style={{ display:'flex', gap:'6px', marginTop:'8px', flexWrap:'wrap' }}>
                                  {(r.matched_skills||[]).slice(0,4).map(t => (
                                    <span key={t} style={{ fontSize:'11px', fontWeight:500, padding:'3px 10px', borderRadius:'20px', background:'rgba(52,211,153,0.1)', color:'var(--accent3)', border:'1px solid rgba(52,211,153,0.2)' }}>✓ {t}</span>
                                  ))}
                                  {(r.missing_skills||[]).slice(0,3).map(t => (
                                    <span key={t} style={{ fontSize:'11px', fontWeight:500, padding:'3px 10px', borderRadius:'20px', background:'rgba(248,113,113,0.08)', color:'var(--danger)', border:'1px solid rgba(248,113,113,0.15)' }}>✗ {t}</span>
                                  ))}
                                </div>
                              </div>
                              <div style={{ textAlign:'right', minWidth:'60px', display:'flex', flexDirection:'column', alignItems:'flex-end', gap:'6px' }}>
                                <div className="rack-card-score-num" style={{ fontFamily:'var(--font-display)', fontSize:'28px', fontWeight:800, letterSpacing:'-1px', color: i===0 ? 'var(--accent)' : 'var(--text)' }}>{displayScore}</div>
                                <div className="rack-card-score-label" style={{ fontSize:'14px', color:'var(--text-dim)', fontWeight:300 }}>match</div>
                                <button
                                  onClick={(e) => handleDownload(e, r.resume_id, r.name)}
                                  title="Download resume"
                                  style={{
                                    background: 'rgba(255,255,255,0.06)',
                                    border: '1px solid rgba(255,255,255,0.1)',
                                    borderRadius: '8px',
                                    padding: '4px 8px',
                                    cursor: 'pointer',
                                    fontSize: '11px',
                                    color: 'var(--text-dim)',
                                    display: 'flex', alignItems: 'center', gap: '4px',
                                    transition: 'all 0.15s ease',
                                    fontFamily: 'var(--font-body)',
                                  }}
                                  onMouseEnter={e => { e.currentTarget.style.background='rgba(232,255,107,0.08)'; e.currentTarget.style.borderColor='rgba(232,255,107,0.25)'; e.currentTarget.style.color='var(--accent)' }}
                                  onMouseLeave={e => { e.currentTarget.style.background='rgba(255,255,255,0.06)'; e.currentTarget.style.borderColor='rgba(255,255,255,0.1)'; e.currentTarget.style.color='var(--text-dim)' }}
                                >
                                  ↓
                                </button>
                              </div>
                            </div>

                            {/* Expanded panel */}
                            {isExpanded && (
                              <div className="rack-expand-panel" style={{ marginTop:'16px', paddingTop:'16px', borderTop:'1px solid var(--border)' }}>
                                {/* AI Analysis */}
                                {isLLM && r.llm_reasoning && (
                                  <div style={{ marginBottom:'16px', padding:'14px 16px', borderRadius:'10px', background:'rgba(167,139,250,0.05)', borderLeft:'3px solid rgba(167,139,250,0.4)' }}>
                                    <div style={{ fontSize:'11px', fontWeight:700, letterSpacing:'0.08em', textTransform:'uppercase', color:'#a78bfa', marginBottom:'8px' }}>✦ AI Analysis</div>
                                    <p style={{ fontSize:'13px', color:'var(--text-mid)', fontStyle:'italic', lineHeight:1.65, margin:'0 0 10px' }}>{r.llm_reasoning}</p>
                                    {r.llm_key_strengths?.length > 0 && (
                                      <div style={{ marginBottom:'8px' }}>
                                        {r.llm_key_strengths.map((s,si) => (
                                          <div key={si} style={{ display:'flex', gap:'8px', fontSize:'12px', marginBottom:'4px' }}>
                                            <span style={{ flexShrink:0, color:'var(--accent3)' }}>✓</span>
                                            <span style={{ color:'var(--text-mid)' }}>{s}</span>
                                          </div>
                                        ))}
                                      </div>
                                    )}
                                    {r.llm_key_gaps?.length > 0 && (
                                      <div>
                                        {r.llm_key_gaps.map((g,gi) => (
                                          <div key={gi} style={{ display:'flex', gap:'8px', fontSize:'12px', marginBottom:'4px' }}>
                                            <span style={{ flexShrink:0, color:'var(--danger)' }}>✗</span>
                                            <span style={{ color:'var(--text-mid)' }}>{g}</span>
                                          </div>
                                        ))}
                                      </div>
                                    )}
                                  </div>
                                )}
                                {/* Score breakdown */}
                                <div style={{ marginBottom:'14px' }}>
                                  <div style={{ fontSize:'11px', fontWeight:600, letterSpacing:'0.08em', textTransform:'uppercase', color:'var(--text-dim)', marginBottom:'8px' }}>
                                    {isLLM ? 'AI Score Breakdown' : 'Score Breakdown'}
                                  </div>
                                  <div style={{ display:'flex', flexDirection:'column', gap:'6px' }}>
                                    {isLLM && r.llm_components && Object.keys(r.llm_components).length > 0 && (
                                      <>
                                        {componentBar('Skills Fit',  r.llm_components.skills_fit     ?? 0, 'linear-gradient(90deg,#e8ff6b,#a3e635)')}
                                        {componentBar('Experience',  r.llm_components.experience_fit ?? 0, 'linear-gradient(90deg,#f59e0b,#f97316)')}
                                        {componentBar('Trajectory',  r.llm_components.trajectory_fit ?? 0, 'linear-gradient(90deg,#a78bfa,#c084fc)')}
                                        <div style={{ display:'flex', alignItems:'center', gap:'8px', fontSize:'11px', marginTop:'2px', opacity:0.45 }}>
                                          <span style={{ color:'var(--text-dim)', minWidth:'80px', fontWeight:500 }}>Keyword/Sem</span>
                                          <div style={{ flex:1, height:'3px', background:'rgba(255,255,255,0.06)', borderRadius:'4px', overflow:'hidden' }}>
                                            <div style={{ height:'100%', borderRadius:'4px', background:'rgba(255,255,255,0.2)', width:`${r.hybrid_score ?? 0}%` }} />
                                          </div>
                                          <span style={{ color:'var(--text-dim)', minWidth:'28px', textAlign:'right', fontFamily:'var(--font-display)', fontWeight:600 }}>{r.hybrid_score ?? 0}</span>
                                        </div>
                                      </>
                                    )}
                                    {!isLLM && r.components && (
                                      <>
                                        {componentBar('Semantic',   (r.components.semantic?.score   ?? 0)*100, 'linear-gradient(90deg,#60a5fa,#818cf8)')}
                                        {componentBar('Skills',     (r.components.skill?.score      ?? 0)*100, 'linear-gradient(90deg,#e8ff6b,#a3e635)')}
                                        {componentBar('Experience', (r.components.experience?.score ?? 0)*100, 'linear-gradient(90deg,#f59e0b,#f97316)')}
                                        {componentBar('Keywords',   (r.components.keyword?.score    ?? 0)*100, 'linear-gradient(90deg,#a78bfa,#c084fc)')}
                                      </>
                                    )}
                                  </div>
                                </div>
                                {/* Gap analysis */}
                                {r.gap_analysis && r.gap_analysis.gap_count > 0 && (
                                  <div style={{ marginBottom:'12px' }}>
                                    <div style={{ fontSize:'11px', fontWeight:600, letterSpacing:'0.08em', textTransform:'uppercase', color:'var(--text-dim)', marginBottom:'6px' }}>Gaps ({r.gap_analysis.gap_count})</div>
                                    {r.gap_analysis.critical_gaps?.length > 0 && (
                                      <div style={{ display:'flex', gap:'4px', flexWrap:'wrap', marginBottom:'4px' }}>
                                        {r.gap_analysis.critical_gaps.map(g => (
                                          <span key={g} style={{ fontSize:'10px', fontWeight:600, padding:'2px 8px', borderRadius:'10px', background:'rgba(248,113,113,0.12)', color:'#f87171', border:'1px solid rgba(248,113,113,0.15)' }}>⚠ {g}</span>
                                        ))}
                                      </div>
                                    )}
                                    <div style={{ fontSize:'11px', color:'var(--text-dim)' }}>
                                      Coverage: {Math.round((r.gap_analysis.coverage?.required||0)*100)}% required · {Math.round((r.gap_analysis.coverage?.preferred||0)*100)}% preferred
                                    </div>
                                  </div>
                                )}
                                {/* Resume meta */}
                                <div style={{ display:'flex', gap:'12px', flexWrap:'wrap', fontSize:'11px', color:'var(--text-dim)' }}>
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
                </div>
              </div>
            </div>
          )
        })}
      </div>{/* end chat-scroll */}

      {/* ── Bottom input bar ── */}
      <div className="rack-chat-input-bar">

        {/* Staged file chips (anonymous only) */}
        {!isAuthed && fileQueue.length > 0 && (
          <div className="rack-staged-files">
            {fileQueue.map(f => (
              <div key={f.name} style={{
                display:'flex', alignItems:'center', gap:'5px',
                padding:'3px 8px 3px 10px',
                background:'rgba(232,255,107,0.07)',
                border:'1px solid rgba(232,255,107,0.2)',
                borderRadius:'20px',
                animation:'bubbleIn 0.2s ease both',
              }}>
                <span style={{ fontSize:'11px', color:'rgba(232,255,107,0.8)', fontWeight:500, maxWidth:'140px', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                  📄 {f.name}
                </span>
                <button onClick={() => removeFileFromQueue(f.name)} style={{ background:'none', border:'none', cursor:'pointer', color:'rgba(232,255,107,0.4)', fontSize:'11px', padding:'0 2px', lineHeight:1, display:'flex', alignItems:'center' }}>✕</button>
              </div>
            ))}
          </div>
        )}

        {/* Main input row — clicking anywhere in the box focuses the textarea */}
        <div className="rack-chat-input-inner" onClick={() => textareaRef.current?.focus()} style={{ cursor: 'text' }}>
          <textarea
            ref={textareaRef}
            className="rack-chat-textarea"
            placeholder="Paste a job description…"
            value={jd}
            rows={1}
            autoFocus
            onChange={e => { setJd(e.target.value); setResumeWarning(false) }}
            onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleMatch() }}
          />

          <div className="rack-chat-input-actions">
            {/* Attach button — all users, capped at effectiveCap */}
            <button
              className="rack-chat-attach-btn"
              onClick={() => { if (!atCap) fileInputRef.current?.click() }}
              disabled={atCap}
              title={atCap ? `${effectiveCap}-resume limit reached` : 'Attach resume(s)'}
            >
              📎
            </button>

            {/* Send button */}
            <button
              className="rack-chat-send-btn"
              onClick={handleMatch}
              disabled={!jd.trim() || loading}
              title="Match (⌘+Enter)"
            >
              {loading
                ? <div style={{ width:14, height:14, border:'2px solid rgba(0,0,0,0.3)', borderTopColor:'#080808', borderRadius:'50%', animation:'spin 0.7s linear infinite' }} />
                : '↑'
              }
            </button>
          </div>
        </div>

        {/* Input meta: warnings + char count */}
        <div className="rack-input-meta">
          {capWarning && (
            <span style={{ color:'#fbbf24' }}>⚠ {droppedCount} file{droppedCount !== 1 ? 's' : ''} dropped — {effectiveCap}-resume limit</span>
          )}
          {resumeWarning === true && (
            <span style={{ color:'#fbbf24' }}>⚠ Attach at least one resume to match</span>
          )}
          {!capWarning && resumeWarning !== true && (
            <span>
              {atCap
                ? `${effectiveCap}/${effectiveCap} · ${isAuthed ? 'manage in Resumes tab' : 'sign in to upload more'}`
                : savedCount + fileQueue.length > 0
                ? `${savedCount + fileQueue.length}/${effectiveCap} · ${slotsLeft} slot${slotsLeft !== 1 ? 's' : ''} left`
                : 'PDF or DOCX · attach up to 5 resumes'
              }
            </span>
          )}
          {jd.length > 0 && (
            <span style={{ marginLeft:'auto' }}>{jd.length} chars</span>
          )}
        </div>
      </div>

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".pdf,.doc,.docx"
        multiple
        style={{ display:'none' }}
        onChange={handleFileSelect}
      />
    </div>{/* end chat-root */}

    {/* Value preview overlay — portal, always above everything */}
    {lastResults && lastResults.length > 0 && authChecked && !isAuthed && (
      <ValuePreviewCard results={lastResults} onSignIn={signInWithGoogle} />
    )}
    </>
  )
}