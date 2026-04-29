import { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useAuth } from '../context/AuthContext'
import { getAuthHeaders } from '../utils/api'
import RackCreature from '../components/RackCreature'
import VoiceOnboarding from '../components/VoiceOnboarding'
import ApplyAgentCard from '../components/ApplyAgentCard'

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000'

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
  @keyframes cursorBlink {
    0%, 100% { opacity: 1; }
    50%       { opacity: 0; }
  }
  @keyframes toastIn {
    from { opacity: 0; transform: translateX(-50%) translateY(10px) scale(0.97); }
    to   { opacity: 1; transform: translateX(-50%) translateY(0)    scale(1);    }
  }
  @keyframes toastOut {
    from { opacity: 1; transform: translateX(-50%) translateY(0); }
    to   { opacity: 0; transform: translateX(-50%) translateY(-8px); }
  }
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
  .rack-toast {
    position: fixed; top: 72px; left: 50%; transform: translateX(-50%);
    z-index: 9999;
    background: var(--surface);
    border: 1px solid rgba(232,255,107,0.35);
    border-radius: 24px; padding: 9px 20px;
    font-size: 13px; font-weight: 500; color: var(--text);
    font-family: var(--font-body);
    box-shadow: 0 4px 24px rgba(0,0,0,0.4);
    pointer-events: none; white-space: nowrap;
    animation: toastIn 0.35s cubic-bezier(0.22,1,0.36,1) both;
  }
  .rack-toast.out { animation: toastOut 0.3s ease forwards; }
  .rack-toast-dot {
    display: inline-block; width: 6px; height: 6px; border-radius: 50%;
    background: var(--accent); margin-right: 7px;
    vertical-align: middle; position: relative; top: -1px;
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
    flex-direction: row;   /* changed: row so steel panel sits alongside chat */
    height: 100dvh;
    overflow: hidden;
  }

  /* Chat column — narrows when steel panel is open */
  .rack-chat-col {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
    transition: flex 0.3s cubic-bezier(0.22,1,0.36,1);
  }

  /* Steel live panel — slides in from right */
  .rack-steel-panel {
    width: 0;
    flex-shrink: 0;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    height: 100%;
    background: #0a0a0a;
    border-left: 1px solid rgba(255,255,255,0.07);
    transition: width 0.3s cubic-bezier(0.22,1,0.36,1);
  }
  .rack-steel-panel.open {
    width: min(55vw, 780px);
  }
  @media (max-width: 900px) {
    .rack-steel-panel.open { width: 100vw; }
    .rack-chat-col.panel-open { display: none; }
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
  .rack-chat-scroll::-webkit-scrollbar-thumb { background: var(--scrollbar-thumb); border-radius: 4px; }

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
    font-family: var(--font-display);
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--text-dim);
    margin-bottom: 16px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
  }
  .rack-greeting-title {
    font-family: var(--font-body);
    font-size: clamp(28px, 4vw, 44px);
    font-weight: 500;
    letter-spacing: -0.03em;
    line-height: 1.08;
    color: var(--text);
    margin: 0 0 14px;
  }
  .rack-suggestion-sub {
    font-size: 14px;
    color: var(--text-mid);
    font-weight: 400;
    line-height: 1.55;
    margin: 0 0 28px;
  }
  .rack-greeting-sub {
    font-size: 14px;
    color: var(--text-mid);
    font-weight: 400;
    margin: 0;
    line-height: 1.55;
  }
  .rack-suggestion-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    justify-content: center;
    max-width: 560px;
  }
  .rack-suggestion-chip {
    padding: 7px 14px;
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 8px;
    font-size: 11px;
    font-weight: 500;
    color: var(--text-mid);
    cursor: pointer;
    transition: all 0.15s ease;
    font-family: var(--font-display);
    letter-spacing: 0.02em;
  }
  .rack-suggestion-chip:hover {
    border-color: var(--border-bright);
    color: var(--text);
    background: var(--surface2);
  }

  /* Message bubbles */
  .rack-msg-container {
    width: min(55%, 900px);
    max-width: 900px;
    margin: 0 auto;
  }
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
    background: var(--surface);
    border: 1px solid var(--border-bright);
    border-radius: 20px;
    padding: 14px 14px 14px 20px;
    transition: border-color 0.2s ease;
    box-shadow: var(--card-shadow);
  }
  .rack-chat-input-inner:focus-within {
    border-color: rgba(232,255,107,0.35);
    box-shadow: var(--card-shadow);
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
  .rack-chat-textarea::placeholder { color: var(--text-dim); }

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
    border: 1px dashed var(--border-bright);
    border-radius: 8px;
    cursor: pointer;
    font-size: 14px;
    color: var(--text-dim);
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
    background: var(--pill-bg);
    color: var(--text-dim);
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
    color: var(--text-dim);
    padding: 0 4px;
  }

  @media (max-width: 600px) {
    .rack-chat-scroll { padding: 16px 12px 12px; padding-top: calc(var(--page-padding-top, 68px) + 12px); }
    .rack-greeting-title { font-size: clamp(24px, 7vw, 36px); letter-spacing: -1px; }
    .rack-greeting-sub { font-size: 14px; }
    .rack-bubble-user { max-width: 85%; font-size: 13px; }
    .rack-bubble-rack { max-width: 100%; }
    .rack-msg-container { width: 100% !important; max-width: 100% !important; }
    .rack-chat-input-bar { padding: 10px 16px 12px; padding-bottom: calc(12px + env(safe-area-inset-bottom, 0px)); }
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
    background: var(--icon-btn-bg) !important;
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
      <div style={{ flex: 1, height: '4px', background: 'var(--pill-bg)', borderRadius: '4px', overflow: 'hidden' }}>
        <div style={{ height: '100%', borderRadius: '4px', background: color, width: `${Math.round(value)}%`, transition: 'width 0.8s cubic-bezier(0.22,1,0.36,1)' }} />
      </div>
      <span style={{ color: 'var(--text-dim)', minWidth: '28px', textAlign: 'right', fontFamily: 'var(--font-display)', fontWeight: 600 }}>{Math.round(value)}</span>
    </div>
  )
}



/* ══════════════════════════════════════════════════════════════════
   TAILOR STEPS CARD — live SSE checkpoint display during tailoring
   ══════════════════════════════════════════════════════════════════ */

const TAILOR_STEP_DEFS = [
  { id: 'fetch_jd',       label: 'Fetching job description'     },
  { id: 'match_resumes',  label: 'Finding your best-fit resume' },
  { id: 'score_resumes',  label: 'Scoring resumes with AI'      },
  { id: 'generate_resume',label: 'Tailoring resume for this role'},
  { id: 'generate_pdf',   label: 'Generating PDF'               },
]

function TailorStepsCard({ steps }) {
  // steps: [{ step, status, label }] — accumulated from SSE events
  const statusOf = (id) => {
    const match = [...steps].reverse().find(s => s.step === id)
    return match?.status || 'pending'
  }

  // Find the currently active step (last one with status=start)
  const activeIdx = (() => {
    for (let i = TAILOR_STEP_DEFS.length - 1; i >= 0; i--) {
      if (statusOf(TAILOR_STEP_DEFS[i].id) === 'start') return i
    }
    return -1
  })()

  return (
    <div style={{
      padding: '18px 20px', borderRadius: '14px',
      background: 'var(--surface)', border: '1px solid rgba(232,255,107,0.18)',
      display: 'flex', flexDirection: 'column', gap: '0',
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '14px' }}>
        <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
          {[0,1,2].map(i => (
            <div key={i} style={{
              width: '5px', height: '5px', borderRadius: '50%',
              background: 'var(--accent)', opacity: 0.7,
              animation: `pulse 1.2s ease-in-out ${i * 0.2}s infinite`,
            }} />
          ))}
        </div>
        <span style={{ fontSize: '13px', color: 'var(--text-dim)', fontWeight: 300 }}>Tailoring your resume…</span>
      </div>

      {/* Step rows */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
        {TAILOR_STEP_DEFS.map((def, i) => {
          const status = statusOf(def.id)
          const isDone    = status === 'done'
          const isActive  = status === 'start'
          const isError   = status === 'error'
          const isPending = status === 'pending'

          return (
            <div key={def.id} style={{
              display: 'flex', alignItems: 'center', gap: '10px',
              padding: '6px 0',
              opacity: isPending ? 0.35 : 1,
              transition: 'opacity 0.4s ease',
              borderBottom: i < TAILOR_STEP_DEFS.length - 1 ? '1px solid var(--border)' : 'none',
            }}>
              {/* Status icon */}
              <div style={{ width: '16px', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {isDone ? (
                  <span style={{ fontSize: '12px', color: 'var(--accent3)' }}>✓</span>
                ) : isError ? (
                  <span style={{ fontSize: '12px', color: 'var(--danger)' }}>✗</span>
                ) : isActive ? (
                  <div style={{
                    width: '8px', height: '8px', borderRadius: '50%',
                    border: '2px solid var(--accent)',
                    borderTopColor: 'transparent',
                    animation: 'spin 0.7s linear infinite',
                    flexShrink: 0,
                  }} />
                ) : (
                  <div style={{ width: '5px', height: '5px', borderRadius: '50%', background: 'var(--border-bright)' }} />
                )}
              </div>

              {/* Label */}
              <span style={{
                fontSize: '13px',
                fontWeight: isDone || isActive ? 500 : 300,
                color: isDone ? 'var(--accent3)' : isActive ? 'var(--text)' : isError ? 'var(--danger)' : 'var(--text-dim)',
                transition: 'color 0.3s ease',
              }}>
                {def.label}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
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
            background: 'var(--surface)',
            border: '1px solid rgba(232,255,107,0.35)',
            borderRadius: '40px', cursor: 'pointer',
            boxShadow: 'var(--card-shadow)',
            backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)',
          }}
        >
          <span style={{ fontSize: '14px' }}>✦</span>
          <span style={{ fontFamily: 'var(--font-display)', fontSize: '13px', fontWeight: 700, color: 'var(--accent)' }}>
            {totalJobs.toLocaleString()} jobs matched
          </span>
          <span style={{ fontSize: '11px', color: 'var(--text-dim)' }}>tap to view →</span>
        </button>
      </div>,
      document.body
    )
  }

  // ── Full floating panel ─────────────────────────────────────────
  return createPortal(
    <div className="preview-floating-panel">
      <div style={{
        background: 'var(--surface)',
        border: '1px solid rgba(232,255,107,0.22)',
        borderRadius: '20px', overflow: 'hidden',
        boxShadow: 'var(--modal-shadow)',
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
                  background: 'var(--icon-btn-bg)', border: '1px solid var(--icon-btn-border)',
                  borderRadius: '8px', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: '14px', color: 'var(--icon-btn-color)',
                  transition: 'background 0.15s ease',
                }}
              >−</button>
              <button
                className="preview-dismiss-btn"
                onClick={() => setDismissed(true)}
                title="Dismiss"
                style={{
                  width: '26px', height: '26px',
                  background: 'var(--icon-btn-bg)', border: '1px solid var(--icon-btn-border)',
                  borderRadius: '8px', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: '12px', color: 'var(--icon-btn-color)',
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
                  background: 'var(--surface2)', border: '1px solid var(--border)',
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

          <div style={{ fontSize: '10px', color: 'var(--text-dim)', textAlign: 'center', marginTop: '10px', letterSpacing: '0.02em' }}>
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

  // ── Login toast ───────────────────────────────────────────────────
  const [toast, setToast]     = useState(null)
  const prevUserRef            = useRef(null)
  useEffect(() => {
    const wasNull  = prevUserRef.current === null
    const isNowSet = !!user
    if (wasNull && isNowSet) {
      const name = user?.user_metadata?.full_name?.split(' ')[0]
        || user?.email?.split('@')[0] || 'back'
      setToast({ msg: `Welcome, ${name}! 👋`, out: true })
      const t1 = setTimeout(() => setToast(t => t ? { ...t, out: true } : null), 2800)
      const t2 = setTimeout(() => setToast(null), 3200)
      return () => { clearTimeout(t1); clearTimeout(t2) }
    }
    prevUserRef.current = user
  }, [user])

  // ── Typewriter engine ─────────────────────────────────────────────
  const [typewriterText, setTypewriterText]   = useState('')
  const [typewriterMsgId, setTypewriterMsgId] = useState(null)
  const typewriterRef = useRef(null)

  const startTypewriter = (msgId, fullText, onComplete) => {
    setTypewriterMsgId(msgId)
    setTypewriterText('')
    let i = 0
    const tick = () => {
      i++
      setTypewriterText(fullText.slice(0, i))
      if (i < fullText.length) {
        typewriterRef.current = setTimeout(tick, 16)
      } else {
        // Persist into the correct field depending on message type.
        // isAssistantReply messages render from msg.replyText;
        // onboarding/chat messages render from msg.text.
        setMessages(prev => prev.map(m => {
          if (m.id !== msgId) return m
          return m.isAssistantReply
            ? { ...m, replyText: fullText }
            : { ...m, text: fullText }
        }))
        setTypewriterMsgId(null)
        setTypewriterText('')
        if (onComplete) onComplete()
      }
    }
    typewriterRef.current = setTimeout(tick, 16)
  }
  useEffect(() => () => clearTimeout(typewriterRef.current), [])

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
  // ── Persistent chat history — survives page reloads ─────────────
  // Key is scoped to the user (auth'd: user UUID, anon: session ID)
  // so different users on the same device don't share history.
  const _chatHistoryKey = isAuthed
    ? `rack_chat_${user?.id || 'auth'}`
    : `rack_chat_${sessionId}`

  const [messages, setMessages]   = useState(() => {
    // Rehydrate from localStorage on first mount
    try {
      const stored = localStorage.getItem(_chatHistoryKey)
      if (stored) {
        const parsed = JSON.parse(stored)
        // Strip transient fields that shouldn't survive a reload:
        // loading spinners, thinking placeholders, upload status chips
        return parsed.filter(m =>
          !m.isThinkingPlaceholder &&
          !m.isUploadStatus &&
          !m.loading
        ).map(m => ({ ...m, loading: false }))
      }
    } catch { /* storage unavailable or corrupted — start fresh */ }
    return []
  })
  const [loading, setLoading]     = useState(false)
  const [filterLoading, setFilterLoading] = useState(false)
  const [expandedIds, setExpandedIds] = useState(new Set()) // per-card key: `${msg.id}-${resume_id}`
  const [resumeCount, setResumeCount] = useState(null)
  const [resumeWarning, setResumeWarning] = useState(false)

  // ── Onboarding state machine ────────────────────────────────────
  // Steps: null → 'roles' → 'location' → 'yoe' → 'resume' → 'done'
  // null = not yet determined (waiting for authChecked + prefs fetch)
  // 'done' = onboarding complete, normal Home behavior resumes
  const [onboardingStep, setOnboardingStep]       = useState(null)
  const [userPreferences, setUserPreferences]     = useState(null)  // fetched from /api/account/profile
  const [onboardingLoading, setOnboardingLoading] = useState(false) // LLM extracting answer
  // voice onboarding mode: null = choice screen not shown yet, "voice" = Nova active, "text" = text fallback chosen
  const [voiceMode, setVoiceMode]                 = useState(null)

  // ── Slash command / tool mode ────────────────────────────────────
  const [activeMode, setActiveMode]       = useState(null)   // null | 'tailor'
  const [slashMenuOpen, setSlashMenuOpen] = useState(false)
  const [tailorLoading, setTailorLoading] = useState(false)
  const [applyLoading, setApplyLoading]   = useState(false)
  // Steel live browser viewer — null when no session active
  // { liveViewUrl, sessionId, isOpen }
  const [steelViewer, setSteelViewer]     = useState(null)

  // Derived: last completed message's results (for ValuePreviewCard)
  const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null
  const lastResults = lastMsg?.results ?? null
  const hasConversation = messages.length > 0

  // ── Anonymous upload queue ──────────────────────────────────────
  // fileQueue: File[] staged before clicking Match It
  // uploadQueue: { name, status }[] — drives animation during processing
  const [fileQueue, setFileQueue]     = useState([])  // staged files
  const [uploadQueue, setUploadQueue] = useState([])  // live status for animation
  const fileInputRef   = useRef(null)
  const chatScrollRef  = useRef(null)
  const textareaRef    = useRef(null)

  // ── Creature mood — derived from app state ──────────────────────
  const [creatureMood, setCreatureMood] = useState('idle')
  const [startleCount, setStartleCount] = useState(0)

  // Mood transitions
  useEffect(() => {
    if (loading || filterLoading) {
      setCreatureMood('thinking')
      return
    }
    if (lastResults && lastResults.length > 0) {
      setCreatureMood('happy')
      const t = setTimeout(() => setCreatureMood('idle'), 4000)
      return () => clearTimeout(t)
    }
    if (jd.length > 0) {
      setCreatureMood('typing')
      return
    }
    setCreatureMood('idle')
  }, [loading, filterLoading, jd, lastResults])

  // Real idle detection — sleep only after genuine inactivity
  const lastActivityRef = useRef(Date.now())
  const IDLE_SLEEP_MS = 90_000   // 90s of zero interaction → sleep

  useEffect(() => {
    const bump = () => { lastActivityRef.current = Date.now() }
    window.addEventListener('pointermove', bump, { passive: true })
    window.addEventListener('keydown', bump, { passive: true })
    window.addEventListener('pointerdown', bump, { passive: true })
    return () => {
      window.removeEventListener('pointermove', bump)
      window.removeEventListener('keydown', bump)
      window.removeEventListener('pointerdown', bump)
    }
  }, [])

  useEffect(() => {
    // Only arm the sleep timer when creature is idle
    if (creatureMood !== 'idle') return
    const iv = setInterval(() => {
      if (Date.now() - lastActivityRef.current >= IDLE_SLEEP_MS) {
        setCreatureMood('sleeping')
      }
    }, 5000) // poll every 5s — low overhead
    return () => clearInterval(iv)
  }, [creatureMood])

  // ── Resume count + preferences + onboarding detection ──────────
  // Clean state machine — no localStorage flags.
  // The DB is the only source of truth: hasRoles comes from /api/account/profile.
  // Three-way branch: 'done' | 'resume' | 'roles'. Nothing else.
  // Catch defaults to 'done' so a backend error never traps users in onboarding.
  useEffect(() => {
    if (!user) {
      // Anonymous user — read localStorage resume count, skip onboarding entirely
      try {
        const ls = JSON.parse(localStorage.getItem('rack_resumes') || '[]')
        setResumeCount(ls.length)
      } catch { setResumeCount(0) }
      setOnboardingStep('done')
      return
    }

    // Authenticated user — fetch prefs + resume count in parallel
    getAuthHeaders().then(async headers => {
      const [resumeRes, profileRes] = await Promise.all([
        fetch(`${API_BASE}/api/resumes`, { headers }),
        fetch(`${API_BASE}/api/account/profile`, { headers }),
      ])
      const resumeData  = resumeRes.ok  ? await resumeRes.json()  : { resumes: [] }
      const profileData = profileRes.ok ? await profileRes.json() : {}

      const count    = (resumeData.resumes || []).length
      const prefs    = profileData  // /api/account/profile returns flat prefs at top level
      const hasRoles = (prefs.target_roles || []).length > 0

      setResumeCount(count)
      setUserPreferences(prefs)

      // Single source of truth — DB state drives everything:
      // hasRoles + hasResumes → fully set up returning user → 'done'
      // hasRoles, no resumes → completed setup but hasn't uploaded yet → 'resume'
      // no roles             → brand new user, start from the beginning → 'roles'
      if (hasRoles && count > 0) {
        setOnboardingStep('done')
      } else if (hasRoles && count === 0) {
        setOnboardingStep('resume')
      } else {
        setOnboardingStep('roles')
      }
    }).catch(() => {
      // Network error — fail open so normal home is shown, don't trap users
      console.error('[Home] Failed to load profile — defaulting to done')
      setResumeCount(0)
      setOnboardingStep('done')
    })
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

  // ── Sync chat history to localStorage on every messages change ──
  // Debounced 300ms so rapid typewriter updates don't hammer storage.
  // Only persist when there's something worth keeping.
  useEffect(() => {
    if (messages.length === 0) return
    const t = setTimeout(() => {
      try {
        // Only persist stable, completed messages — skip transient states
        const toStore = messages.filter(m =>
          !m.isThinkingPlaceholder &&
          !m.isUploadStatus &&
          !m.loading
        )
        if (toStore.length > 0) {
          // Cap at last 40 messages to keep storage size reasonable
          const capped = toStore.slice(-40)
          localStorage.setItem(_chatHistoryKey, JSON.stringify(capped))
        }
      } catch { /* storage quota exceeded or unavailable — fail silently */ }
    }, 300)
    return () => clearTimeout(t)
  }, [messages, _chatHistoryKey])

  // ── Auto-scroll chat area to bottom when new messages arrive ──
  // typewriterText included so scroll tracks content growing during typewriter animation
  useEffect(() => {
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTo({ top: chatScrollRef.current.scrollHeight, behavior: 'smooth' })
    }
  }, [messages, loading, typewriterText])

  // ── Auth users: upload files immediately on selection ──────────
  // Anonymous users: files stay in fileQueue until they click send (Act 1 in handleMatch).
  // Auth'd users: upload as soon as files are staged so resumeCount increments right away,
  // which triggers the onboarding Turn 5 detection without requiring a JD send.
  const authUploadingRef = useRef(false)
  // Tracks the transient "uploading…" message ID shown in chat during onboarding upload
  const uploadStatusMsgRef = useRef(null)

  useEffect(() => {
    if (!isAuthed || fileQueue.length === 0 || authUploadingRef.current) return

    // Capture the full queue immediately — subsequent selections during upload
    // will update fileQueue again and re-trigger this effect once the lock clears.
    const filesToUpload = [...fileQueue]
    const isOnboardingResume = onboardingStep === 'resume'

    const uploadAll = async () => {
      authUploadingRef.current = true
      // Clear the queue up front so new selections can be staged independently
      setFileQueue([])

      // During onboarding resume step: inject a status message into the chat
      // so the user can see their files being processed
      if (isOnboardingResume) {
        const statusId = Date.now()
        uploadStatusMsgRef.current = statusId
        const fileNames = filesToUpload.map(f => f.name).join(', ')
        setMessages(prev => [...prev, {
          id: statusId,
          isRackMessage: true,
          isOnboarding: true,
          isUploadStatus: true,
          text: `Uploading ${filesToUpload.length === 1 ? filesToUpload[0].name : `${filesToUpload.length} resumes (${fileNames})`}…`,
        }])
      }

      try {
        const headers = await getAuthHeaders()
        let uploadedCount = 0
        for (const file of filesToUpload) {
          try {
            const formData = new FormData()
            formData.append('file', file)
            const res = await fetch(`${API_BASE}/api/resumes/upload`, {
              method: 'POST',
              headers,   // Authorization header only — browser sets multipart boundary
              body: formData,
            })
            if (res.ok) uploadedCount++
            else console.error('Auth upload failed for', file.name, res.status)
          } catch (err) {
            console.error('Auth upload error:', file.name, err)
          }
        }

        // Refresh the resume count
        const countRes = await fetch(`${API_BASE}/api/resumes`, { headers })
        const finalCount = countRes.ok
          ? ((await countRes.json()).resumes || []).length
          : uploadedCount

        // Fire Turn 5 directly from here — deterministic, no useEffect race.
        // The resumeCount useEffect approach had a race: the poll interval may have
        // already set resumeCount to the same value (from its own checkResumes call),
        // so React sees no change and Turn 5 never fires a second time.
        if (isOnboardingResume && uploadStatusMsgRef.current) {
          const chipId  = uploadStatusMsgRef.current
          uploadStatusMsgRef.current = null
          const plural  = uploadedCount !== 1
          const plural2 = finalCount !== 1
          const slotsLeft = Math.max(0, 5 - finalCount)

          const doneId   = Date.now()
          const doneText = `You're all set! 🎯

I've got your ${finalCount} resume${plural2 ? 's' : ''} — you can add up to ${slotsLeft} more anytime in the **Resumes tab**.

I'm now hunting for roles that match your profile across hundreds of companies. This runs automatically every 60 minutes in the background.

Check the **Tracking tab** in a couple of minutes for your first matches — or paste a job description or a job URL below and I'll rank your resumes against it right now.`
          const doneMsg  = {
            id: doneId,
            isRackMessage: true,
            isOnboarding: true,
            onboardingTurn: 'done',
            isThinking: false,
            text: '',
          }

          // Single batched update: chip → done, append Turn 5 message
          setMessages(prev => [
            ...prev.map(m =>
              m.id === chipId
                ? { ...m, text: `✓ ${uploadedCount} resume${plural ? 's' : ''} uploaded successfully`, isDone: true }
                : m
            ),
            doneMsg,
          ])
          setResumeCount(finalCount)
          setOnboardingStep('done')
          startTypewriter(doneId, doneText)
        } else {
          // Non-onboarding upload (normal resume management) — just update count
          setResumeCount(finalCount)
        }
      } finally {
        authUploadingRef.current = false
      }
    }

    uploadAll()
  }, [isAuthed, fileQueue, onboardingStep])  // eslint-disable-line

  // ── Auto-resize textarea ─────────────────────────────────────────
  useEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = Math.min(ta.scrollHeight, 160) + 'px'
  }, [jd])

  // ── Onboarding: auto-inject Turn 1 when step resolves to 'roles' (text mode only) ──
  useEffect(() => {
    if (!isAuthed || !authChecked || onboardingStep !== 'roles') return
    if (voiceMode !== 'text') return   // voice mode handles its own onboarding
    if (messages.length > 0) return

    const firstName = user?.user_metadata?.full_name?.split(' ')[0]
      || user?.email?.split('@')[0] || 'there'

    const fullText = `Hey ${firstName}! 👋 I'm RACK — I automatically match your resumes to the best open roles across hundreds of companies.\n\nLet's get you set up in a minute.\n\nFirst: **what kinds of roles are you targeting?** You can describe them however feels natural — job titles, areas of interest, whatever. I'll handle the rest.`
    const msgId = Date.now()

    // Step 1: show thinking dots
    setMessages([{ id: msgId, isRackMessage: true, isOnboarding: true, isThinking: true, onboardingTurn: 'roles' }])

    // Step 2: after 900ms swap to typewriter
    const t = setTimeout(() => {
      setMessages(prev => prev.map(m => m.id === msgId ? { ...m, isThinking: false, text: '' } : m))
      startTypewriter(msgId, fullText)
    }, 900)
    return () => clearTimeout(t)
  }, [isAuthed, authChecked, onboardingStep, voiceMode])  // eslint-disable-line

    // ── Onboarding reply handler ────────────────────────────────────
  // Intercepts user sends during active onboarding steps.
  // Calls backend LLM to extract structured data, saves to DB, advances step.
  const handleOnboardingReply = async () => {
    const userText = jd.trim()
    if (!userText || onboardingLoading) return

    setJd('')
    setOnboardingLoading(true)

    // Append user bubble immediately so it feels responsive
    const userBubble = {
      id: Date.now(),
      isUserBubble: true,
      isOnboarding: true,
      text: userText,
    }
    setMessages(prev => [...prev, userBubble])

    // Show RACK thinking dots
    const thinkingId = Date.now() + 1
    setMessages(prev => [...prev, { id: thinkingId, isRackMessage: true, isOnboarding: true, isThinking: true }])

    try {
      const headers = await getAuthHeaders()

      if (onboardingStep === 'roles') {
        // ── Extract roles via LLM + save to DB ─────────────────────
        const extractRes = await fetch(`${API_BASE}/api/account/onboarding/extract-roles`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify({ text: userText }),
        })
        const extractData = extractRes.ok ? await extractRes.json() : {}
        const roles = extractData.target_roles || []

        // Save preferences
        if (roles.length > 0) {
          await fetch(`${API_BASE}/api/account/preferences`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', ...headers },
            body: JSON.stringify({ target_roles: roles }),
          })
          setUserPreferences(prev => ({ ...(prev || {}), target_roles: roles }))
        }

        const rolesList = roles.length > 0
          ? roles.map(r => `**${r}**`).join(', ')
          : `**${userText.slice(0, 60)}**`

        const locId = Date.now()
        const locText = `Got it — I'll scan for ${rolesList} roles${extractData.alias_count > 0 ? ` (and ${extractData.alias_count} related titles)` : ''} across our job sources.\n\nNext: **where are you open to working?** Remote, a specific city, or both?`
        const locMsg = { id: locId, isRackMessage: true, isOnboarding: true, onboardingTurn: 'location', isThinking: false, text: '' }
        setMessages(prev => prev.filter(m => m.id !== thinkingId).concat(locMsg))
        setOnboardingStep('location')
        startTypewriter(locId, locText)

      } else if (onboardingStep === 'location') {
        // ── Extract + save location via LLM ────────────────────────
        // Raw text goes to backend for LLM extraction — never store the
        // raw sentence directly (e.g. "I am open to SF, NYC, or remote")
        const locRes = await fetch(`${API_BASE}/api/account/onboarding/extract-location`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify({ text: userText }),
        })
        const locData = locRes.ok ? await locRes.json() : {}
        const cleanedLocations = locData.preferred_locations || [userText]
        setUserPreferences(prev => ({ ...(prev || {}), preferred_locations: cleanedLocations }))

        // Summarise what was parsed for the confirmation echo
        const locSummary = cleanedLocations.length > 0
          ? cleanedLocations.join(', ')
          : userText

        const yoeId = Date.now()
        const yoeText = `Noted — **${locSummary}**.\n\nOne more: **how many years of experience do you have?** This helps me calibrate match scores so you're not competing against junior or senior roles you're not targeting.`
        const yoeMsg = { id: yoeId, isRackMessage: true, isOnboarding: true, onboardingTurn: 'yoe', isThinking: false, text: '' }
        setMessages(prev => prev.filter(m => m.id !== thinkingId).concat(yoeMsg))
        setOnboardingStep('yoe')
        startTypewriter(yoeId, yoeText)

      } else if (onboardingStep === 'yoe') {
        // ── Extract YOE via LLM — handles written numbers + ranges ──
        // Replaces the old digit-only regex which broke on "three to four years"
        const yoeRes = await fetch(`${API_BASE}/api/account/onboarding/extract-yoe`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify({ text: userText }),
        })
        const yoeData = yoeRes.ok ? await yoeRes.json() : {}
        const minYears = yoeData.min_years ?? null
        const maxYears = yoeData.max_years ?? null
        setUserPreferences(prev => ({ ...(prev || {}), min_years: minYears, max_years: maxYears }))

        // Build a human-readable confirmation for the chat echo
        const yearsLabel = minYears !== null
          ? (maxYears !== null ? `${minYears}–${maxYears} years` : `${minYears} year${minYears !== 1 ? 's' : ''}`)
          : null

        const resId = Date.now()
        const resText = `${yearsLabel ? `${yearsLabel} of experience — perfect.` : 'Got it.'}\n\nNow the most important step — **upload your resume(s)**. Click the 📎 button below, or drag files into this window. I support PDF and DOCX.\n\nEven if you only have one version right now, you can always upload up to 5 resume variants in the **Resumes tab** later — different versions tailored for different roles.`
        const resMsg = { id: resId, isRackMessage: true, isOnboarding: true, onboardingTurn: 'resume', isThinking: false, text: '' }
        setMessages(prev => prev.filter(m => m.id !== thinkingId).concat(resMsg))
        setOnboardingStep('resume')
        startTypewriter(resId, resText)
      }
    } catch (err) {
      // On error, remove thinking bubble and let user try again
      setMessages(prev => prev.filter(m => m.id !== thinkingId))
      console.error('Onboarding reply error:', err)
    }

    setOnboardingLoading(false)
  }

  // ── Onboarding: poll for resume upload during 'resume' step ────
  // Covers two paths: (a) user attaches via Home 📎 — our auth upload effect
  // already refreshes resumeCount; (b) user goes to the Resumes tab and uploads
  // there — resumeCount on Home stays stale unless we poll.
  // Poll every 3s while the step is active; stop as soon as a resume lands.
  const resumePollRef = useRef(null)
  useEffect(() => {
    if (onboardingStep !== 'resume') {
      clearInterval(resumePollRef.current)
      return
    }

    const checkResumes = async () => {
      try {
        const headers = await getAuthHeaders()
        const res = await fetch(`${API_BASE}/api/resumes`, { headers })
        if (!res.ok) return
        const data = await res.json()
        const count = (data.resumes || []).length
        if (count > 0) {
          clearInterval(resumePollRef.current)
          setResumeCount(count)
        }
      } catch { /* silent — will retry next interval */ }
    }

    checkResumes()
    resumePollRef.current = setInterval(checkResumes, 3000)
    return () => clearInterval(resumePollRef.current)
  }, [onboardingStep]) // eslint-disable-line

  // ── Auto-match filter chips (auth'd greeting state) ──────────────
  const handleAutoMatchFilter = async (action) => {
    if (filterLoading) return
    setFilterLoading(true)

    try {
      const headers = await getAuthHeaders()
      // Correct endpoint — same one Tracking.jsx uses
      const res = await fetch(`${API_BASE}/api/tracking/auto/refresh`, {
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
        jd: label,             // chip label is the user's "message"
        filterLabel: label,    // table header
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
      const res = await fetch(`${API_BASE}/api/resumes/${resumeId}/file`, { headers })
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

  // ── Input triage — sends to unified LLM router, gets back { tool, params, ... } ──
  // The backend LLM is the single source of truth for routing.
  // mode_hint carries the active slash command as a soft nudge (not a hard bypass).
  const triageInput = async (text, contextMessages = [], modeHint = null) => {
    try {
      const headers = isAuthed
        ? await getAuthHeaders()
        : { 'X-Session-ID': sessionId }

      // Serialize last N messages with richer context so the router can detect
      // cross-tool intents (e.g. rank→tailor handoff needs the stored jdText)
      const context = contextMessages.slice(-5).map(m => {
        if (m.isTailorResult) return {
          role: 'rack', type: 'tailor',
          content: m.tailorData
            ? `Tailored resume "${m.tailorData.resume_name}" for "${m.tailorData.jd_title}" — score ${m.tailorData.match_score}`
            : 'Tailoring in progress',
          jd: m.jd,
          jd_text: m.tailorData?.jd_title || m.jd || '',
        }
        if (m.isFilterResult) return {
          role: 'rack', type: 'filter',
          content: `Showed ${m.filterJobs?.length ?? 0} matched jobs (${m.filterLabel || ''})`,
          jd: m.jd,
        }
        if (m.isAssistantReply) return {
          role: 'rack', type: 'reply',
          content: m.replyText || '',
        }
        if (m.results) return {
          role: 'rack', type: 'match',
          content: `Ranked ${m.results.length} resumes against JD: "${m.jd?.slice(0, 120)}"`,
          topScore: m.results[0]?.llm_score ?? m.results[0]?.score ?? null,
          jd_text: m.jdText || '',     // ← critical for rank→tailor handoff
        }
        return null
      }).filter(Boolean)

      const res = await fetch(`${API_BASE}/api/match/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ text, context, mode_hint: modeHint }),
      })
      if (!res.ok) throw new Error('Triage failed')
      return await res.json()  // { tool, params, intent, reply, jobs, filter_label }
    } catch {
      // Backend unreachable — assume rank so the match pipeline still runs
      return { tool: 'route_to_rank', intent: 'JD', params: null }
    }
  }

  // ── Tailor follow-up handler — refinement chaining ────────────────
  // fullJdText: the complete original JD — needed by the rescore loop in tailor.py.
  // jdInput: short title used only for the tailor card title display.
  const handleTailorFollowUp = async (hint, prevTailorData, jdInput, fullJdText = null) => {
    if (tailorLoading) return

    const capturedHint = hint.trim()
    const msgId        = Date.now()

    setTailorLoading(true)
    setJd('')

    // User bubble shows the chain signal so they know RACK understood the context
    const userBubbleLabel = `🔗 Refining previous resume · ${capturedHint}`

    setMessages(prev => [...prev, {
      id: msgId,
      jd: userBubbleLabel,          // shown in the user bubble
      isTailorResult: true,
      tailorData: null,
      tailorSteps: [],
      loading: true,
      error: null,
      isRefinement: true,
    }])

    try {
      const headers = await getAuthHeaders()
      const res = await fetch(`${API_BASE}/api/chat/tailor`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({
          text:                 jdInput,                              // job title — for display context
          resume_override_text: prevTailorData.tailored_full_text,   // chain anchor
          modification_hint:    capturedHint,                        // what the user wants changed
          prev_match_score:     prevTailorData.match_score ?? null,  // carry forward score
          full_jd_text:         fullJdText || null,                  // full JD for rescore loop
        }),
      })

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}))
        throw new Error(errData.detail || `Server error (${res.status})`)
      }

      const reader  = res.body.getReader()
      const decoder = new TextDecoder()
      let   buffer  = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const parts = buffer.split('\n\n')
        buffer = parts.pop()

        for (const part of parts) {
          const line = part.trim()
          if (!line.startsWith('data:')) continue
          let event
          try { event = JSON.parse(line.slice(5).trim()) } catch { continue }

          if (event.type === 'step') {
            setMessages(prev => prev.map(m => {
              if (m.id !== msgId) return m
              return { ...m, tailorSteps: [...(m.tailorSteps || []), event] }
            }))
          } else if (event.type === 'result') {
            const { type, ...tailorData } = event
            setMessages(prev => prev.map(m =>
              m.id === msgId ? { ...m, tailorData, loading: false } : m
            ))
          } else if (event.type === 'error') {
            setMessages(prev => prev.map(m =>
              m.id === msgId ? { ...m, error: event.detail, loading: false } : m
            ))
          }
        }
      }
    } catch (err) {
      setMessages(prev => prev.map(m =>
        m.id === msgId
          ? { ...m, error: err.message || 'Refinement failed. Please try again.', loading: false }
          : m
      ))
    } finally {
      setTailorLoading(false)
    }
  }

  // ── JD fingerprint — deterministic duplicate detection, no LLM needed ──────
  // Normalizes whitespace and lowercases, then takes the first 300 chars.
  // Two JDs are "the same" if their fingerprints match — catches copy-paste repeats
  // even if the user adds/removes a trailing newline or leading space.
  const _jdFingerprint = (text) =>
    text.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 300)

  // ── Match handler — LLM router is the single truth, flat switch executes ───
  // No heuristics. No regex. No refs. The backend LLM picks the tool; we execute.
  const handleMatch = async () => {
    if (!jd.trim() || loading || tailorLoading) return

    // ── Onboarding intercept — active steps consume the send ───────
    if (isAuthed && onboardingStep && onboardingStep !== 'done' && onboardingStep !== 'resume') {
      handleOnboardingReply()
      return
    }

    const capturedJd  = jd.trim()
    const msgId       = Date.now()
    const thinkingId  = msgId + 1   // unique id for the ephemeral thinking bubble
    const modeHint    = activeMode   // pass slash command as soft hint to router

    // ── Duplicate JD intercept — deterministic, zero LLM cost ──────────────
    // If this exact JD was already ranked in this conversation thread, RACK asks
    // what the user wants instead of guessing (which risks mis-routing to tailor).
    // Only fires when there's no active slash command (mode_hint bypasses this —
    // if the user explicitly typed /tailor or /rank they know what they want).
    if (!modeHint) {
      const fingerprint = _jdFingerprint(capturedJd)
      const alreadyRanked = messages.some(
        m => m.results?.length > 0 && _jdFingerprint(m.jd || '') === fingerprint
      )

      if (alreadyRanked) {
        setJd('')
        // Show user bubble + typewriter clarification — no triage call, no loading state
        const clarifyId = Date.now()
        const clarifyText = "Looks like you've already ranked your resumes against this role in our conversation.\n\nDid you want me to **re-rank** them (handy if you've uploaded a new resume since then), or would you rather I **tailor your top resume** for this position?"
        setMessages(prev => [...prev, {
          id: clarifyId,
          jd: capturedJd,
          isAssistantReply: true,
          replyText: '',            // typewriter fills this in
          loading: false,
          isClarification: true,   // suppresses the "Ready to match?" nudge below
        }])
        startTypewriter(clarifyId, clarifyText)
        return
      }
    }

    setLoading(true)
    setJd('')
    if (activeMode) setActiveMode(null)

    // ── Push combined user+thinking message immediately so UI feels live ──
    // Single message with jd=capturedJd renders the user bubble (via msg.jd)
    // AND the thinking dots (via isThinkingPlaceholder) in one block.
    setMessages(prev => [...prev,
      { id: thinkingId, jd: capturedJd, isAssistantReply: true, replyText: '', loading: true, isThinkingPlaceholder: true },
    ])

    // ── Single triage call — backend LLM routes ─────────────────────────────
    const triage = await triageInput(capturedJd, messages, modeHint)
    const tool   = triage.tool || 'route_to_rank'   // safe fallback

    // ── route_to_tailor — LLM detected tailor intent ────────────────────────
    // May include jd_text from a previous rank result (rank→tailor handoff).
    if (tool === 'route_to_tailor') {
      setLoading(false)
      const jdInput = triage.params?.jd_text?.trim() || capturedJd
      const replyFull = triage.reply || 'On it — generating your tailored resume now.'

      // Show the acknowledgment reply through the existing thinking placeholder,
      // then kick off the tailor pipeline after the typewriter finishes.
      setMessages(prev => prev.map(m =>
        m.id === thinkingId ? { ...m, isThinkingPlaceholder: false, replyText: '', loading: false, jd: capturedJd, error: null } : m
      ))
      startTypewriter(thinkingId, replyFull, () => {
        // Small gap so the user can read the reply before the tailor card appears
        setTimeout(() => handleTailorWithText(jdInput), 600)
      })
      return
    }

    // ── route_to_refine — LLM detected refinement after a tailor result ─────
    if (tool === 'route_to_refine') {
      setLoading(false)
      setMessages(prev => prev.filter(m => m.id !== thinkingId))
      const lastTailorMsg = (() => {
        for (let i = messages.length - 1; i >= 0; i--) {
          const m = messages[i]
          if (m.isTailorResult && m.tailorData?.tailored_full_text) return m
          if (!m.loading) break
        }
        return null
      })()
      if (lastTailorMsg) {
        const hint = triage.params?.modification_hint || capturedJd

        // Walk all messages to find the full JD text from the rank result.
        // The router only gives us the job title in params.jd_text.
        const fullJdText = (() => {
          for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].jdText) return messages[i].jdText
          }
          return null
        })()

        // jdCtx = short title for the card header display only
        const jdCtx = lastTailorMsg.tailorData.jd_title
          || triage.params?.jd_text
          || lastTailorMsg.jd
          || capturedJd

        handleTailorFollowUp(hint, lastTailorMsg.tailorData, jdCtx, fullJdText)
      } else {
        setLoading(true)
      }
      if (lastTailorMsg) return
    }

    // ── route_off_topic — warm redirect ────────────────────────────────────
    if (tool === 'route_off_topic') {
      const replyFull = triage.reply || "I'm built to help you land your next job, paste a job description and I'll instantly rank your resumes against it, or ask me anything about your job search, resume, or interview prep."
      setMessages(prev => prev.map(m =>
        m.id === thinkingId ? { ...m, isThinkingPlaceholder: false, replyText: '', loading: false, jd: capturedJd, error: null } : m
      ))
      startTypewriter(thinkingId, replyFull)
      setLoading(false)
      return
    }

    // ── answer_career_question — backend already answered ──────────────────
    if (tool === 'answer_career_question') {
      const replyFull = triage.reply || "Ask me anything about your job search, resume strategy, or interview prep."
      setMessages(prev => prev.map(m =>
        m.id === thinkingId ? { ...m, isThinkingPlaceholder: false, replyText: '', loading: false, jd: capturedJd, error: null } : m
      ))
      startTypewriter(thinkingId, replyFull)
      setLoading(false)
      return
    }

    // ── show_matched_jobs — structured job table ────────────────────────────
    if (tool === 'show_matched_jobs') {
      const jobs  = triage.jobs || []
      const label = triage.filter_label || 'Matched jobs'
      const introReply = triage.reply || null   // personalized intro from backend LLM

      // If the backend generated a personal intro message, show it first as a RACK reply,
      // then immediately append the job table as a second message so they feel connected.
      const tableMsg = {
        id: msgId,
        jd: capturedJd,
        filterLabel: label,
        isFilterResult: true,
        filterJobs: jobs,
        results: null,
        loading: false,
        error: jobs.length === 0
          ? 'No jobs matched that filter. Try running Auto Matches in the Tracking tab first.'
          : null,
      }

      // Single bubble: attach intro text to the table message so renderer shows both together
      const finalMsg = (introReply && jobs.length > 0)
        ? { ...tableMsg, filterIntro: introReply }
        : tableMsg
      setMessages(prev => prev.filter(m => m.id !== thinkingId).concat([finalMsg]))
      setLoading(false)
      return
    }

    // ── route_to_apply — redirect to Tracking tab ──────────────────────────
    // The auto-apply agent is experimental. For now, any apply intent gets
    // a warm redirect to Tracking where the user can review and apply manually.
    // This also catches "how do I apply?" questions that slip past the router.
    if (tool === 'route_to_apply') {
      setLoading(false)
      const redirectMsg = {
        id: msgId,
        jd: capturedJd,
        isApplyRedirect: true,   // renders a special Tracking CTA card
        results: null,
        loading: false,
        error: null,
      }
      setMessages(prev => prev.filter(m => m.id !== thinkingId).concat([redirectMsg]))
      return
    }

    // ── route_to_rank (default) — full match pipeline ──────────────────────
    const hasExistingResumes = resumeCount > 0
    const hasQueuedFiles     = fileQueue.length > 0

    if (!hasExistingResumes && !hasQueuedFiles) {
      const replyFull = "You'll need at least one resume uploaded to match against. Head to the Resumes tab to add yours — it only takes a moment."
      setMessages(prev => prev.map(m =>
        m.id === thinkingId ? { ...m, isThinkingPlaceholder: false, replyText: '', loading: false, jd: capturedJd, error: null } : m
      ))
      startTypewriter(thinkingId, replyFull)
      setLoading(false)
      return
    }

    // Remove thinking bubble — the match loading card takes over
    setMessages(prev => prev.filter(m => m.id !== thinkingId))

    // ── Resolve post-clarification context early (needed for loading placeholder label) ──
    const _lastRankMsg = (() => {
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].results?.length > 0 && messages[i].jdText) return messages[i]
      }
      return null
    })()
    const _priorClarification = messages.some(m => m.isClarification)
    const _isPostClarificationRerank =
      _priorClarification && _lastRankMsg && capturedJd.length < 80

    // Append loading placeholder
    setMessages(prev => [...prev, {
      id: msgId,
      jd: _isPostClarificationRerank ? (_lastRankMsg.jd || capturedJd) : capturedJd,
      results: null,
      jdParsed: null,
      meta: null,
      loading: true,
      error: null,
    }])

    // ── Act 1: Upload queued files (anonymous only) ─────────────
    if (!isAuthed && hasQueuedFiles) {
      const initialQueue = fileQueue.map(f => ({ name: f.name, status: 'queued' }))
      setUploadQueue(initialQueue)

      const lsResumes = (() => {
        try { return JSON.parse(localStorage.getItem('rack_resumes') || '[]') } catch { return [] }
      })()

      for (let i = 0; i < fileQueue.length; i++) {
        const file = fileQueue[i]
        setUploadQueue(prev => prev.map((f, idx) => idx === i ? { ...f, status: 'processing' } : f))

        try {
          const formData = new FormData()
          formData.append('file', file)
          const res = await fetch(`${API_BASE}/api/resumes/upload`, {
            method: 'POST',
            headers: { 'X-Session-ID': sessionId },
            body: formData,
          })
          if (!res.ok) throw new Error('Upload failed')
          const data   = await res.json()
          const resume = data.resume
          const b64    = await fileToBase64(file)
          lsResumes.push({ ...resume, fileBase64: b64, fileType: file.type })
          setUploadQueue(prev => prev.map((f, idx) => idx === i ? { ...f, status: 'done' } : f))
        } catch (err) {
          console.error('Upload error for', file.name, err)
          setUploadQueue(prev => prev.map((f, idx) => idx === i ? { ...f, status: 'error' } : f))
        }
      }

      localStorage.setItem('rack_resumes', JSON.stringify(lsResumes))
      setResumeCount(lsResumes.length)
      setFileQueue([])
    }

    // ── Act 2: Resolve JD text — fetch URL if needed ────────────────
    // If the prior turn was a clarification (user replied "yes re rank" / "tailor it"),
    // capturedJd is just the user's conversational reply — not a real JD.
    // Recover the original full JD from the most recent rank result in the thread.
    // (_lastRankMsg / _priorClarification / _isPostClarificationRerank declared above)

    let jdText = _isPostClarificationRerank ? _lastRankMsg.jdText : capturedJd
    const isJdUrl    = /^https?:\/\//i.test(capturedJd)
    if (isJdUrl) {
      try {
        const fetchRes = await fetch(`${API_BASE}/api/chat/fetch-jd`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: capturedJd }),
        })
        if (fetchRes.ok) {
          const fetchData = await fetchRes.json()
          jdText = fetchData.jd_text || capturedJd
        } else {
          const errData = await fetchRes.json().catch(() => ({}))
          throw new Error(errData.detail || 'Could not fetch job description from this URL. Try pasting the JD text directly.')
        }
      } catch (err) {
        setMessages(prev => prev.map(m => m.id === msgId
          ? { ...m, error: err.message, loading: false }
          : m
        ))
        setLoading(false)
        setUploadQueue([])
        return
      }
    }

    // ── Act 3: Run match ─────────────────────────────────────────
    try {
      const res = await fetch(`${API_BASE}/api/match`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-ID': isAuthed ? (user?.id || 'default') : sessionId,
        },
        body: JSON.stringify({ job_description: jdText, use_llm: true }),
      })

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}))
        throw new Error(errData.detail || `Server error (${res.status})`)
      }

      const data        = await res.json()
      const parsedTitle = data.jd_parsed?.title
      setMessages(prev => prev.map(m => m.id === msgId
        ? {
            ...m,
            jd: (isJdUrl && parsedTitle) ? parsedTitle
              : _isPostClarificationRerank ? (_lastRankMsg.jd || capturedJd)
              : capturedJd,
            jdText,           // stored so triage context can include it for rank→tailor handoff
            results: data.results || [],
            jdParsed: data.jd_parsed || null,
            meta: data.meta || null,
            loading: false,
          }
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


  // ── Auto-apply handler — SSE streaming ──────────────────────────
  // Called when router returns route_to_apply with a list of jobs.
  // Fires one SSE stream per job sequentially, each gets its own
  // message card in the conversation thread.
  const handleApply = async (applyJobs) => {
    if (!applyJobs || applyJobs.length === 0) return
    if (!isAuthed) return   // apply router requires auth — enforced server-side too

    setApplyLoading(true)

    // Show warning shimmer once per browser session before any apply fires
    const hasShownWarning = sessionStorage.getItem('rack_apply_warned')
    if (!hasShownWarning) {
      const warnId = Date.now()
      setMessages(prev => [...prev, {
        id: warnId,
        isApplyWarning: true,
        loading: false,
      }])
      sessionStorage.setItem('rack_apply_warned', '1')
      await new Promise(r => setTimeout(r, 2200))
    }

    for (const job of applyJobs) {
      const msgId    = Date.now() + Math.random()
      const jobTitle = job.job_title || 'Unknown Role'
      const company  = job.company   || 'Unknown Company'
      const jobUrl   = job.url       || ''
      const resumeId = job.resume_id || null

      // Append a loading placeholder for this job
      setMessages(prev => [...prev, {
        id:           msgId,
        jd:           `${jobTitle} · ${company}`,
        isApplyResult: true,
        applySteps:   [],
        applyDone:    null,
        applyError:   null,
        applyJobTitle: jobTitle,
        applyCompany:  company,
        loading:       true,
        error:         null,
      }])

      if (!jobUrl) {
        setMessages(prev => prev.map(m => m.id === msgId
          ? { ...m, applyError: 'No application URL available for this job.', loading: false }
          : m
        ))
        continue
      }

      try {
        const headers = await getAuthHeaders()
        const res = await fetch(`${API_BASE}/api/apply/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify({
            job_url:   jobUrl,
            job_title: jobTitle,
            company:   company,
            resume_id: resumeId,
            job_id:    job.job_id || null,
          }),
        })

        if (!res.ok) {
          const errData = await res.json().catch(() => ({}))
          throw new Error(errData.detail || `Server error (${res.status})`)
        }

        // Read SSE stream
        const reader  = res.body.getReader()
        const decoder = new TextDecoder()
        let   buffer  = ''

        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          const parts = buffer.split('\n\n')
          buffer = parts.pop()

          for (const part of parts) {
            const line = part.trim()
            if (!line.startsWith('data:')) continue

            let event
            try { event = JSON.parse(line.slice(5).trim()) }
            catch { continue }

            if (event.type === 'steel_session') {
              // Steel remote browser is ready — slide in the live panel
              setSteelViewer({
                liveViewUrl: event.live_view_url,
                sessionId:   event.session_id,
              })
            } else if (event.type === 'step') {
              setMessages(prev => prev.map(m => m.id === msgId
                ? { ...m, applySteps: [...(m.applySteps || []), event] }
                : m
              ))
            } else if (event.type === 'submitted') {
              const { type, ...submittedData } = event
              setMessages(prev => prev.map(m => m.id === msgId
                ? { ...m, applySubmitted: submittedData, loading: false }
                : m
              ))
            } else if (event.type === 'done') {
              const { type, ...doneData } = event
              setMessages(prev => prev.map(m => m.id === msgId
                ? { ...m, applyDone: doneData, loading: false }
                : m
              ))
            } else if (event.type === 'error') {
              setMessages(prev => prev.map(m => m.id === msgId
                ? { ...m, applyError: event.text, loading: false }
                : m
              ))
            }
          }
        }
      } catch (err) {
        setMessages(prev => prev.map(m => m.id === msgId
          ? { ...m, applyError: err.message || 'Apply agent failed.', loading: false }
          : m
        ))
      }

      // Small gap between jobs when applying to multiple
      if (applyJobs.length > 1) await new Promise(r => setTimeout(r, 800))
    }

    // Dismiss the Steel viewer pill/modal — agent is done
    setSteelViewer(null)
    setApplyLoading(false)
  }


  // ── Slash command handler ───────────────────────────────────────
  // Available tools shown in the dropdown when user types '/'
  const SLASH_TOOLS = [
    {
      id: 'tailor',
      label: '/tailor',
      description: 'Generate a tailored PDF resume for a job',
      placeholder: 'Paste a job URL or JD to tailor your top resume…',
      icon: '✦',
      authRequired: true,
    },
    {
      id: 'rank',
      label: '/rank',
      description: 'Rank all your resumes against a job description',
      placeholder: 'Paste a job description to rank your resumes…',
      icon: '◈',
      authRequired: false,
    },
  ]

  const handleSlashInput = (e) => {
    const val = e.target.value
    // Open slash menu when '/' is the entire input
    if (val === '/') {
      setSlashMenuOpen(true)
      setJd(val)
      setResumeWarning(false)
      return
    }
    // Close menu if user keeps typing and it's no longer just '/'
    if (slashMenuOpen && !val.startsWith('/')) {
      setSlashMenuOpen(false)
    }
    setJd(val)
    setResumeWarning(false)
  }

  const selectSlashTool = (tool) => {
    setActiveMode(tool.id)
    setSlashMenuOpen(false)
    setJd('')                    // clear the '/' char
    setTimeout(() => textareaRef.current?.focus(), 50)
  }

  const clearActiveMode = () => {
    setActiveMode(null)
    setSlashMenuOpen(false)
    setJd('')
    textareaRef.current?.focus()
  }

  // ── Tailor pipeline handler — SSE streaming ─────────────────────
  const handleTailor = async () => {
    if (!jd.trim() || tailorLoading) return

    // Auth guard — tailor requires stored resumes with full_text
    if (!isAuthed) {
      const msgId      = Date.now()
      const thinkId    = msgId + 1
      const replyFull  = "Tailoring requires a signed-in account so I can access your saved resumes. Sign in and I'll generate a custom PDF for you in seconds."
      setMessages(prev => [...prev,
        { id: msgId - 1, isUserBubble: true, text: jd.trim() },
        { id: thinkId, isAssistantReply: true, replyText: '', loading: true, isThinkingPlaceholder: true, jd: jd.trim(), error: null },
      ])
      setJd('')
      // brief pause so the thinking dots are visible before typewriter fires
      setTimeout(() => {
        setMessages(prev => prev.map(m =>
          m.id === thinkId ? { ...m, isThinkingPlaceholder: false, loading: false } : m
        ))
        startTypewriter(thinkId, replyFull)
      }, 400)
      return
    }

    const capturedJd = jd.trim()
    const msgId      = Date.now()

    setTailorLoading(true)
    setJd('')

    // Append loading placeholder — tailorSteps accumulates SSE step events
    setMessages(prev => [...prev, {
      id: msgId,
      jd: capturedJd,
      isTailorResult: true,
      tailorData: null,
      tailorSteps: [],
      loading: true,
      error: null,
    }])

    try {
      const headers = await getAuthHeaders()
      const res = await fetch(`${API_BASE}/api/chat/tailor`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ text: capturedJd }),
      })

      if (!res.ok) {
        // Non-streaming error (400/401 before stream opens)
        const errData = await res.json().catch(() => ({}))
        throw new Error(errData.detail || `Server error (${res.status})`)
      }

      // Read the SSE stream line by line
      const reader  = res.body.getReader()
      const decoder = new TextDecoder()
      let   buffer  = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })

        // SSE lines end with \n\n — split on that
        const parts = buffer.split('\n\n')
        buffer = parts.pop() // keep the incomplete tail

        for (const part of parts) {
          const line = part.trim()
          if (!line.startsWith('data:')) continue

          let event
          try {
            event = JSON.parse(line.slice(5).trim())
          } catch {
            continue
          }

          if (event.type === 'step') {
            // Append/update this step in tailorSteps
            setMessages(prev => prev.map(m => {
              if (m.id !== msgId) return m
              const existing = m.tailorSteps || []
              // Append — card reads latest status per step id
              return { ...m, tailorSteps: [...existing, event] }
            }))
          } else if (event.type === 'result') {
            // Final success — store tailorData, clear loading
            const { type, ...tailorData } = event
            setMessages(prev => prev.map(m =>
              m.id === msgId ? { ...m, tailorData, loading: false } : m
            ))
          } else if (event.type === 'error') {
            setMessages(prev => prev.map(m =>
              m.id === msgId ? { ...m, error: event.detail, loading: false } : m
            ))
          }
        }
      }
    } catch (err) {
      setMessages(prev => prev.map(m =>
        m.id === msgId
          ? { ...m, error: err.message || 'Tailoring failed. Please try again.', loading: false }
          : m
      ))
    } finally {
      setTailorLoading(false)
      setActiveMode(null)
    }
  }

  // ── Tailor with explicit text — used by rank→tailor handoff ────────
  // Identical to handleTailor but accepts jdInput directly instead of
  // reading from the `jd` state variable. Avoids stale closure issues
  // when called from handleMatch after state has already been cleared.
  const handleTailorWithText = async (jdInput) => {
    if (!jdInput?.trim() || tailorLoading) return

    if (!isAuthed) {
      const msgId     = Date.now()
      const thinkId   = msgId + 1
      const replyFull = "Tailoring requires a signed-in account so I can access your saved resumes. Sign in and I'll generate a custom PDF for you in seconds."
      setMessages(prev => [...prev,
        { id: thinkId, isAssistantReply: true, replyText: '', loading: true, isThinkingPlaceholder: true, jd: jdInput.slice(0, 120), error: null },
      ])
      setTimeout(() => {
        setMessages(prev => prev.map(m =>
          m.id === thinkId ? { ...m, isThinkingPlaceholder: false, loading: false } : m
        ))
        startTypewriter(thinkId, replyFull)
      }, 400)
      return
    }

    const capturedJd = jdInput.trim()
    const msgId      = Date.now()

    setTailorLoading(true)
    setJd('')
    setActiveMode(null)

    setMessages(prev => [...prev, {
      id: msgId,
      jd: (() => {
          const firstLine = capturedJd.split('\n')[0].trim()
          return firstLine.length > 0 && firstLine.length < 80 ? firstLine : capturedJd.slice(0, 80) + '…'
          })(),
      isTailorResult: true,
      tailorData: null,
      tailorSteps: [],
      loading: true,
      error: null,
    }])

    try {
      const headers = await getAuthHeaders()
      const res = await fetch(`${API_BASE}/api/chat/tailor`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ text: capturedJd }),
      })

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}))
        throw new Error(errData.detail || `Server error (${res.status})`)
      }

      const reader  = res.body.getReader()
      const decoder = new TextDecoder()
      let   buffer  = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const parts = buffer.split('\n\n')
        buffer = parts.pop()

        for (const part of parts) {
          const line = part.trim()
          if (!line.startsWith('data:')) continue
          let event
          try { event = JSON.parse(line.slice(5).trim()) } catch { continue }

          if (event.type === 'step') {
            setMessages(prev => prev.map(m => {
              if (m.id !== msgId) return m
              return { ...m, tailorSteps: [...(m.tailorSteps || []), event] }
            }))
          } else if (event.type === 'result') {
            const { type, ...tailorData } = event
            setMessages(prev => prev.map(m =>
              m.id === msgId ? { ...m, tailorData, loading: false } : m
            ))
          } else if (event.type === 'error') {
            setMessages(prev => prev.map(m =>
              m.id === msgId ? { ...m, error: event.detail, loading: false } : m
            ))
          }
        }
      }
    } catch (err) {
      setMessages(prev => prev.map(m =>
        m.id === msgId
          ? { ...m, error: err.message || 'Tailoring failed. Please try again.', loading: false }
          : m
      ))
    } finally {
      setTailorLoading(false)
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

    {/* ══ Chat root — full-viewport flex row ══ */}
    <div className="rack-chat-root">

    {/* ── Chat column — shrinks when steel panel is open ── */}
    <div className={`rack-chat-col${steelViewer ? ' panel-open' : ''}`}>

      {/* ── Scrollable chat area — full bleed, content flows under floating nav ── */}
      <div className="rack-chat-scroll" ref={chatScrollRef}>

        {/* "new chat" pill — floats top-right inside scroll area when a convo is active */}
        {hasConversation && (
          <button
            onClick={() => { setMessages([]); setJd(''); setExpandedIds(new Set()); localStorage.removeItem(_chatHistoryKey) }}
            style={{
              position: 'sticky', top: '0px', alignSelf: 'flex-end',
              fontSize: '11px', padding: '5px 12px', borderRadius: '20px',
              background: 'var(--icon-btn-bg)', color: 'var(--text-dim)',
              border: '1px solid var(--icon-btn-border)', fontWeight: 500, cursor: 'pointer',
              fontFamily: 'var(--font-body)', marginBottom: '12px',
              transition: 'all 0.15s ease', zIndex: 10,
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--pill-bg)'; e.currentTarget.style.color = 'var(--text)' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'var(--icon-btn-bg)'; e.currentTarget.style.color = 'var(--text-dim)' }}
          >
            ✕ new chat
          </button>
        )}

        {/* ── Greeting state (no conversation yet) ── */}
        {/* Gate on onboardingStep !== null: while the profile fetch is in-flight,
            render nothing rather than the bare hero with no chips (looks broken).
            Once resolved: 'done' shows hero + chips; 'roles'/'resume' auto-injects
            a message via the Turn 1 effect so hasConversation becomes true and
            this block is hidden anyway. */}
        {/* ── Voice onboarding — full-screen Nova session ── */}
        {onboardingStep === 'roles' && voiceMode === 'voice' && (
          <VoiceOnboarding
            user={user}
            apiBase={API_BASE}
            getAuthHeaders={getAuthHeaders}
            onComplete={(prefs) => {
              // Voice collected all prefs — advance to resume upload step (text)
              setVoiceMode('text')
              setOnboardingStep('resume')
              // Inject Turn 5 resume upload message into text thread
              const resId   = Date.now()
              const resText = `Okay, last thing I need from you — drop your resume below. Even one version works, you can always add more later in the **Resumes tab**!`
              const resMsg  = { id: resId, isRackMessage: true, isOnboarding: true, onboardingTurn: 'resume', isThinking: false, text: '' }
              setMessages([resMsg])
              startTypewriter(resId, resText)
            }}
            onSwitchToText={() => {
              setVoiceMode('text')
              // Turn 1 useEffect will fire now that voiceMode === 'text'
            }}
          />
        )}

        {/* ── Voice/text choice screen — shown when onboarding starts ── */}
        {onboardingStep === 'roles' && voiceMode === null && (
          <div style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center',
            justifyContent: 'center', minHeight: '60vh', gap: '32px',
            animation: 'greetingFade 0.5s ease both',
          }}>
            <div style={{ textAlign: 'center', maxWidth: '400px' }}>
              <h2 style={{
                fontSize: 'clamp(22px, 5vw, 28px)', fontWeight: 600,
                color: 'var(--text)', lineHeight: 1.3, marginBottom: '12px',
                fontFamily: 'var(--font-display)',
              }}>
                {user?.user_metadata?.full_name?.split(' ')[0]
                  ? `Hey ${user.user_metadata.full_name.split(' ')[0]}, let's get you set up.`
                  : `Let's get you set up.`}
              </h2>
              <p style={{
                fontSize: '15px', color: 'rgba(255,255,255,0.45)',
                fontFamily: 'var(--font-body)', lineHeight: 1.6,
              }}>
                RACK will ask you a few quick questions to find your best-fit roles.
              </p>
            </div>
            <button
              onClick={() => setVoiceMode('voice')}
              style={{
                padding: '14px 40px', borderRadius: '40px',
                border: '1px solid var(--accent)', background: 'transparent',
                color: 'var(--accent)', fontSize: '15px', fontWeight: 500,
                fontFamily: 'var(--font-body)', letterSpacing: '0.04em',
                cursor: 'pointer', transition: 'background 0.15s, color 0.15s',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--accent)'; e.currentTarget.style.color = '#000' }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--accent)' }}
            >
              talk to rack →
            </button>
            <button
              onClick={() => setVoiceMode('text')}
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: 'rgba(255,255,255,0.25)', fontSize: '13px',
                fontFamily: 'var(--font-body)', textDecoration: 'underline',
                textUnderlineOffset: '3px', textDecorationColor: 'rgba(255,255,255,0.12)',
                padding: '4px 8px', transition: 'color 0.15s',
              }}
              onMouseEnter={e => { e.currentTarget.style.color = 'rgba(255,255,255,0.5)' }}
              onMouseLeave={e => { e.currentTarget.style.color = 'rgba(255,255,255,0.25)' }}
            >
              I can't talk right now — let me text instead
            </button>
          </div>
        )}

        {/* ── Normal greeting (done state) + text-mode onboarding conversation ── */}
        {!hasConversation && !loading && onboardingStep !== null && onboardingStep !== 'roles' || (onboardingStep === 'roles' && voiceMode === 'text' && !hasConversation && !loading) ? (
          <div className="rack-greeting" style={{ display: (onboardingStep === 'roles' && voiceMode === null) || (onboardingStep === 'roles' && voiceMode === 'voice') ? 'none' : undefined }}>
            <div className="rack-greeting-hero">
              <div className="rack-greeting-eyebrow">
                <span style={{width:4,height:4,borderRadius:'50%',background:'var(--accent)',display:'inline-block',boxShadow:'0 0 6px var(--accent)'}}/>
                scanning 152 boards
              </div>
              <h1 className="rack-greeting-title">
                Drop the JD.<br />
                <span style={{ color: 'var(--accent)', fontStyle: 'italic', fontWeight: 400 }}>
                  We'll find your fit.
                </span>
              </h1>
              <p className="rack-greeting-sub">
                Paste any job description below and instantly rank your resume versions.
              </p>
            </div>

            {/* Suggestion chips — context-aware; hidden during onboarding */}
            {onboardingStep === 'done' && (
              <div className="rack-suggestion-chips">
                {isAuthed ? (
                  // Auth'd users: quick-filters into their auto-match results
                  [
                    { label: 'view all matched jobs',   action: 'filter:all' },
                    { label: '85%+ match jobs',         action: 'filter:85'  },
                    { label: '75%+ match jobs',         action: 'filter:75'  },
                    { label: 'newly matched jobs',      action: 'filter:new' },
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
                    'paste a job description',
                    'try an ML Engineer role',
                    'Software Engineer — Senior',
                    'Data Scientist position',
                  ].map(chip => (
                    <button
                      key={chip}
                      className="rack-suggestion-chip"
                      onClick={() => handleSuggestion(chip)}
                    >
                      {chip}
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
        ) : null}

        {/* ── Conversation thread — multi-turn, one entry per submitted JD ── */}
        {messages.map((msg) => {
          // ── Onboarding message type ───────────────────────────────
          if (msg.isOnboarding) {
            if (msg.isThinking) {
              return (
                <div key={msg.id} className='rack-msg-container' style={{ margin: '0 auto' }}>
                  <div className="rack-msg-row rack" style={{ marginBottom: 16 }}>
                    <div className="rack-bubble-rack">
                      <div className="rack-bubble-rack-label">
                        <span className="rack-bubble-rack-label-dot" />
                        RACK
                      </div>
                      <div style={{ display: 'flex', gap: 5, alignItems: 'center', paddingTop: 2 }}>
                        {[0,1,2].map(i => (
                          <span key={i} style={{
                            width: 7, height: 7, borderRadius: '50%',
                            background: 'var(--accent)', opacity: 0.6,
                            animation: 'pulse 1.2s ease-in-out infinite',
                            animationDelay: `${i * 0.18}s`,
                          }} />
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              )
            }
            if (msg.isUserBubble) {
              return (
                <div key={msg.id} className='rack-msg-container' style={{ margin: '0 auto' }}>
                  <div className="rack-msg-row user" style={{ marginBottom: 8 }}>
                    <div className="rack-bubble-user">
                      <div className="rack-bubble-user-label">You</div>
                      {msg.text}
                    </div>
                  </div>
                </div>
              )
            }
            // Upload status chip — shown inline during auth resume upload
            if (msg.isUploadStatus) {
              return (
                <div key={msg.id} className='rack-msg-container' style={{ margin: '0 auto' }}>
                  <div className="rack-msg-row rack" style={{ marginBottom: 12 }}>
                    <div className="rack-bubble-rack">
                      <div style={{
                        display: 'inline-flex', alignItems: 'center', gap: 8,
                        padding: '7px 14px',
                        background: msg.isDone ? 'rgba(52,211,153,0.08)' : 'rgba(232,255,107,0.06)',
                        border: `1px solid ${msg.isDone ? 'rgba(52,211,153,0.25)' : 'rgba(232,255,107,0.18)'}`,
                        borderRadius: 20,
                        fontSize: 13, fontWeight: 500,
                        color: msg.isDone ? 'var(--accent3)' : 'var(--text-mid)',
                        animation: 'bubbleIn 0.25s ease both',
                      }}>
                        {!msg.isDone && (
                          <div style={{
                            width: 10, height: 10, borderRadius: '50%',
                            border: '2px solid rgba(232,255,107,0.5)',
                            borderTopColor: 'var(--accent)',
                            animation: 'spin 0.7s linear infinite',
                            flexShrink: 0,
                          }} />
                        )}
                        {msg.text}
                      </div>
                    </div>
                  </div>
                </div>
              )
            }

            // RACK onboarding message — render markdown-lite (bold via **)
            const renderOnboardingText = (text) => {
              const parts = text.split(/(\*\*[^*]+\*\*)/g)
              return parts.map((part, i) =>
                part.startsWith('**') && part.endsWith('**')
                  ? <strong key={i} style={{ color: 'var(--accent)', fontWeight: 700 }}>{part.slice(2, -2)}</strong>
                  : part.split('\n').map((line, j, arr) => (
                      <span key={`${i}-${j}`}>{line}{j < arr.length - 1 ? <br /> : null}</span>
                    ))
              )
            }
            const displayText = typewriterMsgId === msg.id ? typewriterText : msg.text
            const isActivelyTyping = typewriterMsgId === msg.id
            return (
              <div key={msg.id} className='rack-msg-container' style={{ margin: '0 auto' }}>
                <div className="rack-msg-row rack" style={{ marginBottom: 16 }}>
                  <div className="rack-bubble-rack" style={{ lineHeight: 1.65, fontSize: 14 }}>
                    <div className="rack-bubble-rack-label">
                      <span className="rack-bubble-rack-label-dot" />
                      RACK
                    </div>
                    {renderOnboardingText(displayText)}
                    {isActivelyTyping && (
                      <span style={{
                        display: 'inline-block', width: 2, height: '1em',
                        background: 'var(--accent)', marginLeft: 2,
                        verticalAlign: 'text-bottom', opacity: 0.8,
                        animation: 'pulse 0.8s ease-in-out infinite',
                      }} />
                    )}
                  </div>
                </div>
              </div>
            )
          }

          // ── Apply warning — early return before msg.jd access ──────────────
          if (msg.isApplyWarning) {
            return (
              <div key={msg.id} className='rack-msg-container' style={{ margin: '0 auto', paddingBottom: 8 }}>
                <div style={{
                  padding: '13px 17px', borderRadius: '12px',
                  background: 'rgba(232,255,107,0.04)',
                  border: '1px solid rgba(232,255,107,0.18)',
                  animation: 'bubbleIn 0.4s ease both',
                }}>
                  <span style={{ fontSize: '13px', color: 'var(--text-dim)', lineHeight: 1.6 }}>
                    ⚡ RACK is applying on your behalf — it will fill every field using your resume and profile, write answers to any custom questions, and submit. You won't need to do anything.
                  </span>
                </div>
              </div>
            )
          }

          // ── Apply redirect — send user to Tracking tab ──────────────────────
          if (msg.isApplyRedirect) {
            return (
              <div key={msg.id} className='rack-msg-container' style={{ margin: '0 auto', paddingBottom: 8 }}>
                <div className="rack-msg-row rack">
                  <div className="rack-bubble-rack">
                    <div className="rack-bubble-rack-label">
                      <span className="rack-bubble-rack-label-dot" />
                      Rack
                    </div>
                    <div style={{
                      padding: '18px 20px', borderRadius: '14px',
                      background: 'var(--surface)', border: '1px solid var(--border-bright)',
                      animation: 'bubbleIn 0.35s ease both',
                      display: 'flex', flexDirection: 'column', gap: '14px',
                    }}>
                      <p style={{ margin: 0, fontSize: '14px', color: 'var(--text)', lineHeight: 1.65 }}>
                        The best way to apply is through the <strong style={{ color: 'var(--accent)' }}>Tracking tab</strong> — all your matched jobs are there with one-click Apply buttons. You can review each role, see your match score, and apply with your tailored resume.
                      </p>
                      <button
                        onClick={() => {
                          // Find the TabBar setTab function — navigate to Tracking
                          // We fire a custom event that App.jsx listens for
                          window.dispatchEvent(new CustomEvent('rack:navigate', { detail: { tab: 'Tracking' } }))
                        }}
                        style={{
                          alignSelf: 'flex-start',
                          padding: '10px 20px',
                          background: 'rgba(232,255,107,0.1)',
                          border: '1px solid rgba(232,255,107,0.35)',
                          borderRadius: '10px',
                          cursor: 'pointer',
                          fontSize: '13px', fontWeight: 700,
                          color: 'var(--accent)',
                          fontFamily: 'var(--font-display)',
                          transition: 'all 0.15s ease',
                          display: 'flex', alignItems: 'center', gap: '8px',
                        }}
                        onMouseEnter={e => { e.currentTarget.style.background = 'rgba(232,255,107,0.18)'; e.currentTarget.style.borderColor = 'rgba(232,255,107,0.55)' }}
                        onMouseLeave={e => { e.currentTarget.style.background = 'rgba(232,255,107,0.1)'; e.currentTarget.style.borderColor = 'rgba(232,255,107,0.35)' }}
                      >
                        <span>Open Tracking</span>
                        <span style={{ fontSize: '15px' }}>✦</span>
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )
          }

          const msgJdPreview = msg.jd.length > 220 ? msg.jd.slice(0, 220).trimEnd() + '…' : msg.jd

          return (
            <div key={msg.id} className='rack-msg-container' style={{ display: 'flex', flexDirection: 'column', gap: 0, margin: '0 auto' }}>

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

                  {/* Loading indicator while this turn is processing — JD turns only */}
                  {msg.loading && !msg.isAssistantReply && !msg.isTailorResult && (
                    <div style={{
                      padding: '20px 22px', borderRadius: '14px',
                      background: 'var(--surface)', border: '1px solid var(--border-bright)',
                      display: 'flex', flexDirection: 'column', gap: '14px',
                      marginBottom: '8px',
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                        <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                          {[0,1,2].map(i => (
                            <div key={i} style={{
                              width: '5px', height: '5px', borderRadius: '50%',
                              background: 'var(--accent)', opacity: 0.7,
                              animation: `pulse 1.2s ease-in-out ${i * 0.2}s infinite`,
                            }} />
                          ))}
                        </div>
                        <span style={{ fontSize: '13px', color: 'var(--text-dim)', fontWeight: 300 }}>Matching your resume…</span>
                      </div>
                      <div style={{ fontSize: '12px', color: 'var(--text-dim)', fontWeight: 300, lineHeight: 1.6, borderLeft: '2px solid rgba(232,255,107,0.2)', paddingLeft: '12px' }}>
                        {uploadQueue.length > 0
                          ? 'Uploading resumes → embedding → scoring against JD → ranking'
                          : 'Embedding JD → scoring resumes → ranking by fit'
                        }
                      </div>
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

                        {/* ── Personal intro text (above the table) ── */}
                        {msg.filterIntro && (
                          <p style={{
                            margin: '0 0 16px',
                            fontSize: '14px',
                            color: 'var(--text)',
                            lineHeight: 1.65,
                            fontWeight: 400,
                          }}>
                            {msg.filterIntro}
                          </p>
                        )}

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
                          borderBottom: '1px solid var(--border)',
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
                                      color: globalIdx === 0 ? 'var(--accent)' : 'var(--text-dim)',
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

                                  {/* Bottom row: resume download + Apply button */}
                                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '10px', gap: '8px' }}>

                                    {/* Resume download */}
                                    {job.resume_name ? (
                                      <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>
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
                                    ) : <div />}

                                    {/* ⚡ Apply button — only for auth'd users with a URL */}
                                    {isAuthed && job.url && (
                                      <button
                                        onClick={() => handleApply([job])}
                                        disabled={applyLoading}
                                        style={{
                                          display: 'flex', alignItems: 'center', gap: '4px',
                                          padding: '4px 12px', borderRadius: '20px',
                                          fontSize: '11px', fontWeight: 700,
                                          fontFamily: 'var(--font-body)',
                                          background: applyLoading
                                            ? 'rgba(232,255,107,0.04)'
                                            : 'rgba(232,255,107,0.1)',
                                          border: '1px solid rgba(232,255,107,0.25)',
                                          color: applyLoading ? 'var(--text-dim)' : 'var(--accent)',
                                          cursor: applyLoading ? 'not-allowed' : 'pointer',
                                          transition: 'all 0.15s ease',
                                          flexShrink: 0,
                                        }}
                                        onMouseEnter={e => { if (!applyLoading) e.currentTarget.style.background = 'rgba(232,255,107,0.18)' }}
                                        onMouseLeave={e => { if (!applyLoading) e.currentTarget.style.background = 'rgba(232,255,107,0.1)' }}
                                      >
                                        ⚡ Apply
                                      </button>
                                    )}
                                  </div>
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
                                background: fPage <= 1 ? 'var(--surface2)' : 'var(--icon-btn-bg)',
                                border: '1px solid var(--border)',
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
                                    border: p === fPage ? 'none' : '1px solid var(--border)',
                                    color: p === fPage ? 'var(--accent-contrast)' : 'var(--text-dim)',
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
                                background: fPage >= totalPages ? 'var(--surface2)' : 'var(--icon-btn-bg)',
                                border: '1px solid var(--border)',
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
                  {msg.isAssistantReply && (() => {
                    const isTyping      = typewriterMsgId === msg.id
                    const displayReply  = isTyping ? typewriterText : msg.replyText
                    const renderReply = (text) => {
                      if (!text) return null
                      const parts = text.split(/(\*\*[^*]+\*\*)/g)
                      return parts.map((part, i) =>
                        part.startsWith("**") && part.endsWith("**")
                          ? <strong key={i} style={{ color: "var(--accent)", fontWeight: 600 }}>{part.slice(2, -2)}</strong>
                          : part.split('\n').map((line, j, arr) => (
                              <span key={i+"-"+j}>{line}{j < arr.length - 1 ? <br /> : null}</span>
                            ))
                      )
                    }
                    return (
                    <div style={{ animation: 'bubbleIn 0.25s ease both' }}>
                      {msg.loading ? (
                        // Thinking indicator — shown while triage LLM is running
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
                          fontWeight: 300,
                        }}>
                          {renderReply(displayReply)}
                          {/* Blinking cursor while typewriter is active */}
                          {isTyping && (
                            <span style={{
                              display: 'inline-block', width: '2px', height: '1em',
                              background: 'var(--accent)', marginLeft: '2px',
                              verticalAlign: 'text-bottom', borderRadius: '1px',
                              animation: 'cursorBlink 0.7s step-end infinite',
                            }} />
                          )}
                          {/* Soft nudge to paste a JD — only shown once typing is complete.
                              Suppressed for clarification messages — user is mid-dialogue. */}
                          {!isTyping && displayReply && displayReply.length > 60 && !msg.isClarification && (
                            <div style={{
                              marginTop: '14px', paddingTop: '12px',
                              borderTop: '1px solid var(--border)',
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
                    )
                  })()}

                  {/* ── Tailor result card ── */}
                  {/* ── Apply agent live feed card ── */}
                  {msg.isApplyResult && (
                    <div style={{ animation: 'bubbleIn 0.4s ease both' }}>
                      <ApplyAgentCard
                        steps={msg.applySteps || []}
                        loading={msg.loading}
                        error={msg.applyError || null}
                        done={msg.applyDone || null}
                        submitted={msg.applySubmitted || null}
                        jobTitle={msg.applyJobTitle}
                        company={msg.applyCompany}
                      />
                    </div>
                  )}

                  {msg.isTailorResult && (
                    <div style={{ animation: 'bubbleIn 0.4s ease both' }}>
                      {msg.loading ? (
                        // Live SSE checkpoint display
                        <TailorStepsCard steps={msg.tailorSteps || []} />
                      ) : msg.error ? (
                        <div style={{
                          padding: '14px 18px', borderRadius: '12px',
                          background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.2)',
                          color: 'var(--danger)', fontSize: '14px',
                        }}>
                          {msg.error}
                        </div>
                      ) : msg.tailorData && (
                        <div style={{
                          borderRadius: '16px', overflow: 'hidden',
                          background: 'var(--surface)', border: '1px solid rgba(232,255,107,0.25)',
                          boxShadow: 'var(--card-shadow)',
                        }}>
                          {/* Accent bar */}
                          <div style={{ height: '2px', background: 'linear-gradient(90deg, #e8ff6b 0%, #a78bfa 65%, transparent 100%)' }} />

                          <div style={{ padding: '20px 22px' }}>
                            {/* Header */}
                            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px', marginBottom: '16px' }}>
                              <div>
                                <div style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--accent)', marginBottom: '5px' }}>
                                  ✦ Tailored Resume Ready
                                </div>
                                <div style={{ fontFamily: 'var(--font-display)', fontSize: '16px', fontWeight: 800, color: 'var(--text)', lineHeight: 1.25 }}>
                                  {msg.tailorData.jd_title}
                                </div>
                              </div>
                              {/* Score badge */}
                              <div style={{ textAlign: 'right', flexShrink: 0 }}>
                                <div style={{ fontFamily: 'var(--font-display)', fontSize: '32px', fontWeight: 800, letterSpacing: '-1px', color: msg.tailorData.match_score >= 75 ? 'var(--accent)' : msg.tailorData.match_score >= 55 ? '#60a5fa' : '#fb923c', lineHeight: 1 }}>
                                  {msg.tailorData.match_score}
                                </div>
                                <div style={{ fontSize: '11px', color: 'var(--text-dim)', fontWeight: 300 }}>match score</div>
                              </div>
                            </div>

                            {/* Source resume + recommendation */}
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '14px', padding: '10px 14px', borderRadius: '10px', background: 'rgba(232,255,107,0.04)', border: '1px solid rgba(232,255,107,0.1)' }}>
                              <span style={{ fontSize: '13px' }}>📄</span>
                              <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text)', flex: 1 }}>{msg.tailorData.resume_name}</span>
                              <span style={{
                                fontSize: '10px', fontWeight: 700, padding: '2px 9px', borderRadius: '20px',
                                background: msg.tailorData.llm_recommendation === 'Strong Match' ? 'rgba(52,211,153,0.12)' : msg.tailorData.llm_recommendation === 'Good Match' ? 'rgba(232,255,107,0.1)' : 'rgba(251,146,60,0.1)',
                                color: msg.tailorData.llm_recommendation === 'Strong Match' ? 'var(--accent3)' : msg.tailorData.llm_recommendation === 'Good Match' ? 'var(--accent)' : '#fb923c',
                                border: '1px solid rgba(232,255,107,0.2)',
                              }}>
                                {msg.tailorData.llm_recommendation}
                              </span>
                            </div>

                            {/* AI reasoning */}
                            {msg.tailorData.llm_reasoning && (
                              <div style={{ marginBottom: '14px', padding: '12px 14px', borderRadius: '10px', background: 'rgba(167,139,250,0.05)', borderLeft: '3px solid rgba(167,139,250,0.35)' }}>
                                <div style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#a78bfa', marginBottom: '6px' }}>✦ AI Analysis</div>
                                <p style={{ fontSize: '13px', color: 'var(--text-mid)', fontStyle: 'italic', lineHeight: 1.6, margin: 0 }}>{msg.tailorData.llm_reasoning}</p>
                              </div>
                            )}

                            {/* Strengths + gaps */}
                            {(msg.tailorData.key_strengths?.length > 0 || msg.tailorData.key_gaps?.length > 0) && (
                              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '18px' }}>
                                {msg.tailorData.key_strengths?.length > 0 && (
                                  <div>
                                    <div style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--accent3)', marginBottom: '6px' }}>Strengths</div>
                                    {msg.tailorData.key_strengths.slice(0,3).map((s,i) => (
                                      <div key={i} style={{ display: 'flex', gap: '6px', fontSize: '12px', marginBottom: '4px', color: 'var(--text-mid)' }}>
                                        <span style={{ color: 'var(--accent3)', flexShrink: 0 }}>✓</span>{s}
                                      </div>
                                    ))}
                                  </div>
                                )}
                                {msg.tailorData.key_gaps?.length > 0 && (
                                  <div>
                                    <div style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--danger)', marginBottom: '6px' }}>Gaps</div>
                                    {msg.tailorData.key_gaps.slice(0,2).map((g,i) => (
                                      <div key={i} style={{ display: 'flex', gap: '6px', fontSize: '12px', marginBottom: '4px', color: 'var(--text-mid)' }}>
                                        <span style={{ color: 'var(--danger)', flexShrink: 0 }}>✗</span>{g}
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            )}

                            {/* Download button */}
                            <a
                              href={msg.tailorData.download_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              style={{
                                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px',
                                width: '100%', padding: '14px 18px',
                                background: 'rgba(232,255,107,0.1)', border: '1px solid rgba(232,255,107,0.38)',
                                borderRadius: '13px', cursor: 'pointer',
                                fontFamily: 'var(--font-display)', fontSize: '14px', fontWeight: 700,
                                color: 'var(--accent)', textDecoration: 'none',
                                transition: 'all 0.2s ease',
                              }}
                              onMouseEnter={e => { e.currentTarget.style.background = 'rgba(232,255,107,0.18)'; e.currentTarget.style.borderColor = 'rgba(232,255,107,0.55)' }}
                              onMouseLeave={e => { e.currentTarget.style.background = 'rgba(232,255,107,0.1)'; e.currentTarget.style.borderColor = 'rgba(232,255,107,0.38)' }}
                            >
                              <span>↓</span>
                              <span>Download Tailored Resume</span>
                            </a>
                            <div style={{ fontSize: '10px', color: 'var(--text-dim)', textAlign: 'center', marginTop: '8px', letterSpacing: '0.02em' }}>
                              PDF · valid for 1 hour · tailored specifically for this role
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Results */}
                  {!msg.isFilterResult && !msg.isAssistantReply && !msg.isTailorResult && msg.results && msg.results.length === 0 && (
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

                  {!msg.isFilterResult && !msg.isAssistantReply && !msg.isTailorResult && msg.results && msg.results.length > 0 && (
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
                              background: msg.jdParsed.extraction_method === 'hybrid' ? 'rgba(52,211,153,0.12)' : 'var(--pill-bg)',
                              color: msg.jdParsed.extraction_method === 'hybrid' ? 'var(--accent3)' : 'var(--text-dim)',
                              border: `1px solid ${msg.jdParsed.extraction_method === 'hybrid' ? 'rgba(52,211,153,0.2)' : 'var(--pill-border)'}`,
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
                            boxShadow: 'var(--card-shadow)',
                          }}
                          onClick={() => setExpandedIds(prev => {
                            const next = new Set(prev)
                            next.has(cardKey) ? next.delete(cardKey) : next.add(cardKey)
                            return next
                          })}
                          >
                            {/* Collapsed row */}
                            <div className="rack-card-row" style={{ display: 'flex', alignItems: 'center', gap: '18px' }}>
                              <div className="rack-card-rank" style={{ fontFamily:'var(--font-display)', fontSize:'24px', fontWeight:800, color: i===0 ? 'var(--accent)' : 'var(--text-dim)', minWidth:'36px' }}>
                                #{i+1}
                              </div>
                              <div style={{ flex:1, minWidth:0 }}>
                                <div className="rack-card-badges" style={{ display:'flex', alignItems:'center', gap:'8px', marginBottom:'6px', flexWrap:'wrap' }}>
                                  <span className="rack-card-name" style={{ fontFamily:'var(--font-display)', fontSize:'16px', fontWeight:600, color:'var(--text)' }}>{r.name}</span>
                                  <span style={{ fontSize:'10px', padding:'2px 6px', borderRadius:'6px', background:'var(--pill-bg)', color:'var(--text-dim)', fontWeight:500 }}>
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
                                <div style={{ height:'4px', background:'var(--pill-bg)', borderRadius:'4px', overflow:'hidden' }}>
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
                                    background: 'var(--icon-btn-bg)',
                                    border: '1px solid var(--icon-btn-border)',
                                    borderRadius: '8px',
                                    padding: '4px 8px',
                                    cursor: 'pointer',
                                    fontSize: '11px',
                                    color: 'var(--icon-btn-color)',
                                    display: 'flex', alignItems: 'center', gap: '4px',
                                    transition: 'all 0.15s ease',
                                    fontFamily: 'var(--font-body)',
                                  }}
                                  onMouseEnter={e => { e.currentTarget.style.background='rgba(232,255,107,0.08)'; e.currentTarget.style.borderColor='rgba(232,255,107,0.25)'; e.currentTarget.style.color='var(--accent)' }}
                                  onMouseLeave={e => { e.currentTarget.style.background='var(--icon-btn-bg)'; e.currentTarget.style.borderColor='var(--icon-btn-border)'; e.currentTarget.style.color='var(--icon-btn-color)' }}
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
                                          <div style={{ flex:1, height:'3px', background:'var(--pill-bg)', borderRadius:'4px', overflow:'hidden' }}>
                                            <div style={{ height:'100%', borderRadius:'4px', background:'var(--border-bright)', width:`${r.hybrid_score ?? 0}%` }} />
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

        {/* Staged file chips (all users — clears after auth upload completes) */}
        {fileQueue.length > 0 && (
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
        {/* position:relative so the creature can absolute-position on top of it */}
        <div className="rack-chat-input-inner" onClick={() => textareaRef.current?.focus()} style={{ cursor: 'text', position: 'relative' }}>

          {/* ── Slash command dropdown ── */}
          {slashMenuOpen && (
            <div style={{
              position: 'absolute', bottom: '100%', left: 0, marginBottom: '6px',
              width: 'max-content', minWidth: '220px', maxWidth: '320px',
              background: 'var(--surface)', border: '1px solid var(--border-bright)',
              borderRadius: '12px', overflow: 'hidden', zIndex: 50,
              boxShadow: 'var(--modal-shadow)',
              animation: 'bubbleIn 0.15s ease both',
            }}>
              <div style={{ padding: '6px 12px 5px', fontSize: '9px', fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--text-dim)', borderBottom: '1px solid var(--border)' }}>
                Tools
              </div>
              {SLASH_TOOLS.map(tool => (
                <button
                  key={tool.id}
                  onClick={() => selectSlashTool(tool)}
                  style={{
                    width: '100%', display: 'flex', alignItems: 'center', gap: '10px',
                    padding: '8px 12px', background: 'transparent', border: 'none',
                    cursor: 'pointer', textAlign: 'left', transition: 'background 0.12s ease',
                  }}
                  onMouseEnter={e => e.currentTarget.style.background = 'rgba(232,255,107,0.06)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                >
                  <span style={{ fontSize: '13px', flexShrink: 0, opacity: 0.8 }}>{tool.icon}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text)' }}>{tool.label}</span>
                      {tool.authRequired && (
                        <span style={{ fontSize: '8px', fontWeight: 700, padding: '1px 5px', borderRadius: '20px', background: 'rgba(232,255,107,0.1)', color: 'var(--accent)', border: '1px solid rgba(232,255,107,0.2)', letterSpacing: '0.06em', flexShrink: 0 }}>AUTH</span>
                      )}
                    </div>
                    <div style={{ fontSize: '11px', color: 'var(--text-dim)', fontWeight: 300, marginTop: '1px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{tool.description}</div>
                  </div>
                </button>
              ))}
            </div>
          )}

          {/* ── Active mode pill ── */}
          {activeMode && (() => {
            const tool = SLASH_TOOLS.find(t => t.id === activeMode)
            if (!tool) return null
            return (
              <div style={{
                display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0,
                padding: '4px 10px 4px 8px',
                background: 'rgba(232,255,107,0.1)', border: '1px solid rgba(232,255,107,0.3)',
                borderRadius: '20px',
              }}>
                <span style={{ fontSize: '11px' }}>{tool.icon}</span>
                <span style={{ fontFamily: 'var(--font-display)', fontSize: '12px', fontWeight: 700, color: 'var(--accent)', whiteSpace: 'nowrap' }}>{tool.label}</span>
                <button
                  onClick={clearActiveMode}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(232,255,107,0.5)', fontSize: '12px', padding: '0 0 0 2px', lineHeight: 1, display: 'flex', alignItems: 'center' }}
                >✕</button>
              </div>
            )
          })()}

          {/* Creature walks along the top edge of this box */}
          <RackCreature mood={creatureMood} startle={startleCount} />
          <textarea
            ref={textareaRef}
            className="rack-chat-textarea"
            placeholder={
              onboardingStep === 'roles'    ? 'e.g. "ML Engineer, Backend Engineer" or "I want to work in AI research"…' :
              onboardingStep === 'location' ? 'e.g. "Remote", "New York", "Open to anywhere"…' :
              onboardingStep === 'yoe'      ? 'e.g. "3 years", "I graduated last year", "About 5 years"…' :
              onboardingStep === 'resume'   ? 'Upload your resume with 📎 above, then paste a JD to match it…' :
              activeMode === 'tailor'       ? 'Paste a job URL or JD to tailor your top resume…' :
              activeMode === 'rank'         ? 'Paste a job description to rank your resumes…' :
              'Paste a job description or type / for tools…'
            }
            value={jd}
            rows={1}
            autoFocus
            onChange={handleSlashInput}
            onPaste={e => {
              const text = e.clipboardData?.getData('text') || ''
              if (text.length >= 200) {
                setStartleCount(c => c + 1)
              }
            }}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                handleMatch()
              }
            }}
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
              disabled={!jd.trim() || loading || tailorLoading || onboardingLoading}
              title={activeMode === 'tailor' ? 'Tailor resume (⌘+Enter)' : activeMode === 'rank' ? 'Rank resumes (⌘+Enter)' : 'Match (⌘+Enter)'}
            >
              {loading
                ? <div style={{ width:14, height:14, border:'2px solid rgba(0,0,0,0.25)', borderTopColor:'var(--accent-contrast)', borderRadius:'50%', animation:'spin 0.7s linear infinite' }} />
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
    </div>{/* end rack-chat-col */}

    {/* ── Steel live panel — slides in alongside chat, no modal/overlay ── */}
    {(() => {
      const applyMsg = messages.find(m => m.isApplyResult && (m.loading || (m.applySteps && m.applySteps.length > 0)))
      const steps = applyMsg?.applySteps || []
      const hasLiveView = !!steelViewer?.liveViewUrl
      return (
        <div className={`rack-steel-panel${steelViewer ? ' open' : ''}`}>
          {steelViewer && (<>

            {/* Panel header */}
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '10px 14px',
              borderBottom: '1px solid rgba(255,255,255,0.07)',
              background: '#080808',
              flexShrink: 0,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                <span style={{
                  width: 7, height: 7, borderRadius: '50%',
                  background: '#e8ff6b', boxShadow: '0 0 7px #e8ff6b',
                  animation: 'pulse 2s ease-in-out infinite', flexShrink: 0,
                }} />
                <span style={{
                  fontSize: 11, fontWeight: 600,
                  color: 'rgba(232,255,107,0.85)',
                  fontFamily: 'var(--font-display)',
                  letterSpacing: '0.08em', textTransform: 'uppercase',
                }}>Live Application</span>
                <span style={{ fontSize: 11, color: 'var(--text-dim)', fontFamily: 'var(--font-body)' }}>
                  — watching form fill in real time
                </span>
              </div>
              <button
                onClick={() => setSteelViewer(null)}
                style={{
                  background: 'none', border: 'none',
                  color: 'rgba(255,255,255,0.3)', fontSize: 18,
                  cursor: 'pointer', lineHeight: 1, padding: '2px 4px',
                  display: 'flex', alignItems: 'center',
                }}
                title="Close"
              >×</button>
            </div>

            {/* Panel body — iframe + step sidebar */}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'row', overflow: 'hidden', minHeight: 0 }}>

              {/* Live browser iframe */}
              <div style={{ flex: 1, position: 'relative', background: '#000', borderRight: '1px solid rgba(255,255,255,0.06)' }}>
                {hasLiveView ? (
                  <iframe
                    src={`${steelViewer.liveViewUrl}?interactive=false`}
                    style={{ width: '100%', height: '100%', border: 'none', display: 'block' }}
                    title="Live browser session"
                    allow="autoplay"
                  />
                ) : (
                  <div style={{
                    width: '100%', height: '100%',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    flexDirection: 'column', gap: 12,
                    color: 'rgba(255,255,255,0.15)', fontSize: 13, fontFamily: 'var(--font-body)',
                  }}>
                    <div style={{
                      width: 28, height: 28,
                      border: '2px solid rgba(232,255,107,0.15)',
                      borderTopColor: '#e8ff6b', borderRadius: '50%',
                      animation: 'spin 0.8s linear infinite',
                    }} />
                    Connecting to browser…
                  </div>
                )}
              </div>

              {/* Step feed sidebar */}
              <div style={{
                width: 220, flexShrink: 0,
                display: 'flex', flexDirection: 'column',
                overflowY: 'auto', padding: '12px 10px', gap: 3,
                background: '#0a0a0a',
              }}>
                {/* Status line */}
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 7,
                  marginBottom: 8, paddingBottom: 8,
                  borderBottom: '1px solid rgba(255,255,255,0.06)', flexShrink: 0,
                }}>
                  <div style={{
                    width: 16, height: 16, flexShrink: 0,
                    border: '2px solid rgba(232,255,107,0.2)',
                    borderTopColor: steps.length === 0 ? '#e8ff6b' : 'transparent',
                    borderRadius: '50%',
                    animation: steps.length === 0 ? 'spin 0.8s linear infinite' : 'none',
                  }} />
                  <span style={{ fontSize: 11, color: 'var(--text-dim)', fontFamily: 'var(--font-body)' }}>
                    {steps.length === 0
                      ? 'Connecting…'
                      : `${steps.filter(s => s.status === 'ok').length} field${steps.filter(s => s.status === 'ok').length !== 1 ? 's' : ''} filled`
                    }
                  </span>
                </div>
                {/* Steps */}
                {steps.map((step, i) => {
                  const icon  = step.status === 'ok' ? '✓' : step.status === 'skip' ? '–' : step.status === 'error' ? '✕' : step.status === 'writing' ? '✎' : '·'
                  const color = step.status === 'ok' ? '#a3e635' : step.status === 'skip' ? 'rgba(255,255,255,0.2)' : step.status === 'error' ? '#f87171' : step.status === 'writing' ? '#e8ff6b' : 'var(--text-dim)'
                  return (
                    <div key={i} style={{
                      display: 'flex', alignItems: 'flex-start', gap: 6,
                      padding: '4px 6px', borderRadius: 5,
                      background: i === steps.length - 1 ? 'rgba(232,255,107,0.04)' : 'transparent',
                    }}>
                      <span style={{ fontSize: 10, fontWeight: 700, color, flexShrink: 0, width: 11, textAlign: 'center', marginTop: 2, fontFamily: 'monospace' }}>{icon}</span>
                      <span style={{ fontSize: 11, color: step.status === 'skip' ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.7)', fontFamily: 'var(--font-body)', lineHeight: 1.4, wordBreak: 'break-word' }}>{step.text}</span>
                    </div>
                  )
                })}
                {applyMsg?.loading && steps.length > 0 && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 6px' }}>
                    <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#e8ff6b', animation: 'pulse 1.2s ease-in-out infinite', flexShrink: 0, marginLeft: 3 }} />
                    <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.22)', fontFamily: 'var(--font-body)' }}>working…</span>
                  </div>
                )}
                {steps.length === 0 && (
                  <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(255,255,255,0.12)', fontSize: 11, fontFamily: 'var(--font-body)', textAlign: 'center', padding: '16px 6px' }}>
                    Steps appear here as the agent works
                  </div>
                )}
              </div>
            </div>

            {/* Panel footer */}
            <div style={{
              padding: '7px 14px',
              borderTop: '1px solid rgba(255,255,255,0.05)',
              background: '#080808', flexShrink: 0,
            }}>
              <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.25)', fontFamily: 'var(--font-body)' }}>
                Close this panel anytime — the agent keeps running in the background.
              </span>
            </div>

          </>)}
        </div>
      )
    })()}

    </div>{/* end chat-root */}

    {/* Value preview overlay — portal, always above everything */}
    {lastResults && lastResults.length > 0 && authChecked && !isAuthed && (
      <ValuePreviewCard results={lastResults} onSignIn={signInWithGoogle} />
    )}

    {/* ── Login toast ── */}
    {toast && (
      <div className={`rack-toast${toast.out ? ' out' : ''}`}>
        <span className="rack-toast-dot" />
        {toast.msg}
      </div>
    )}
    </>
  )
}