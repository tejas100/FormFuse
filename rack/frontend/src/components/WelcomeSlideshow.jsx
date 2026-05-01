import { useState, useEffect, useRef } from 'react'

const SLIDES = [
  {
    id: 'boards',
    tag: '01 / DISCOVERY',
    headline: '152 job boards.\nScanned every hour.',
    body: 'Greenhouse, Ashby, and Lever, checked on the hour, every hour. New roles land in your feed before most applicants even open LinkedIn.',
    visual: 'boards',
  },
  {
    id: 'ai',
    tag: '02 / SCORING',
    headline: 'Two-stage AI ranks\nyour actual fit.',
    body: 'Phase 1 filters by semantic similarity. Phase 2 sends your real resume text to Rack AI, scoring Skills Fit, Experience, and Trajectory separately.',
    visual: 'pipeline',
  },
  {
    id: 'creature',
    tag: '03 / YOUR AGENT',
    headline: 'Meet your\nRack agent.',
    body: 'Drop a JD. Get ranked matches. Ask career questions. Your Rack agent lives right in the chat, always ready, never asleep for long.',
    visual: 'creature',
  },
  {
    id: 'apply',
    tag: '04 / AUTO-APPLY',
    headline: 'One click.\nApplication sent.',
    body: 'Rack fills and submits Greenhouse, Ashby, and Lever applications for you, live browser stream so you can watch every field get filled.',
    visual: 'apply',
  },
]

const STORAGE_KEY = 'rack_welcomed_v1'

export function useFirstVisit() {
  const [show, setShow] = useState(false)
  const [checked, setChecked] = useState(false)

  useEffect(() => {
    const seen = localStorage.getItem(STORAGE_KEY)
    if (!seen) setShow(true)
    setChecked(true)
  }, [])

  const dismiss = () => {
    localStorage.setItem(STORAGE_KEY, '1')
    setShow(false)
  }

  return { show: checked && show, dismiss }
}

// ── Board scan visual ────────────────────────────────────────────────────────
function BoardsVisual() {
  const rows = [
    { name: 'Anthropic', score: 94, delay: 0 },
    { name: 'Stripe', score: 88, delay: 80 },
    { name: 'Figma', score: 81, delay: 160 },
    { name: 'Vercel', score: 76, delay: 240 },
    { name: 'Datadog', score: 71, delay: 320 },
  ]
  return (
    <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 6 }}>
      {rows.map(({ name, score, delay }) => (
        <div key={name} style={{
          display: 'flex', alignItems: 'center', gap: 10,
          background: 'rgba(255,255,255,0.03)',
          border: '1px solid rgba(255,255,255,0.06)',
          borderRadius: 8, padding: '8px 12px',
          animation: `slideRowIn 0.4s ease both`,
          animationDelay: `${delay}ms`,
        }}>
          <div style={{
            width: 6, height: 6, borderRadius: '50%',
            background: '#E8FF6B',
            boxShadow: '0 0 6px rgba(232,255,107,0.6)',
            flexShrink: 0,
          }} />
          <span style={{ flex: 1, fontFamily: 'var(--font-body)', fontSize: 12, color: 'rgba(255,255,255,0.75)', letterSpacing: '0.2px' }}>
            {name}
          </span>
          <span style={{
            fontFamily: 'var(--font-mono, monospace)', fontSize: 11,
            color: score >= 85 ? '#E8FF6B' : score >= 75 ? 'rgba(232,255,107,0.6)' : 'rgba(255,255,255,0.35)',
            fontWeight: 700,
          }}>
            {score}%
          </span>
        </div>
      ))}
      <div style={{
        textAlign: 'center', marginTop: 4,
        fontFamily: 'var(--font-mono, monospace)',
        fontSize: 10, color: 'rgba(255,255,255,0.2)',
        letterSpacing: '0.5px',
      }}>
        + 147 more boards
      </div>
    </div>
  )
}

// ── Pipeline visual ──────────────────────────────────────────────────────────
function PipelineVisual() {
  const phases = [
    { label: 'PHASE 1', sub: 'Semantic search', icon: '◈', done: true },
    { label: 'PHASE 2', sub: 'Rack scoring', icon: '◉', done: true },
    { label: 'RANKED', sub: 'Skills · Exp · Fit', icon: '✦', done: true, accent: true },
  ]
  return (
    <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 8 }}>
      {phases.map(({ label, sub, icon, done, accent }, i) => (
        <div key={label}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 12,
            background: accent ? 'rgba(232,255,107,0.05)' : 'rgba(255,255,255,0.03)',
            border: `1px solid ${accent ? 'rgba(232,255,107,0.2)' : 'rgba(255,255,255,0.06)'}`,
            borderRadius: 8, padding: '10px 14px',
            animation: `slideRowIn 0.4s ease both`,
            animationDelay: `${i * 100}ms`,
          }}>
            <span style={{ fontSize: 14, color: accent ? '#E8FF6B' : 'rgba(255,255,255,0.4)' }}>{icon}</span>
            <div style={{ flex: 1 }}>
              <div style={{
                fontFamily: 'var(--font-mono, monospace)', fontSize: 9,
                color: accent ? 'rgba(232,255,107,0.7)' : 'rgba(255,255,255,0.3)',
                letterSpacing: '1px', marginBottom: 1,
              }}>{label}</div>
              <div style={{
                fontFamily: 'var(--font-body)', fontSize: 12,
                color: accent ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.55)',
              }}>{sub}</div>
            </div>
            {done && (
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <circle cx="7" cy="7" r="6.5" stroke={accent ? 'rgba(232,255,107,0.5)' : 'rgba(255,255,255,0.15)'} />
                <path d="M4.5 7l2 2 3-3" stroke={accent ? '#E8FF6B' : 'rgba(255,255,255,0.35)'} strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            )}
          </div>
          {i < phases.length - 1 && (
            <div style={{
              width: 1, height: 8, background: 'rgba(255,255,255,0.08)',
              margin: '0 auto',
            }} />
          )}
        </div>
      ))}
    </div>
  )
}

// ── Creature visual ──────────────────────────────────────────────────────────
function CreatureVisual() {
  return (
    <div style={{ width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
      {/* Creature GIF */}
      <div style={{
        width: 80, height: 80,
        background: 'rgba(255,255,255,0.03)',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 16,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        position: 'relative',
        overflow: 'hidden',
      }}>
        {/* Pixel creature inline SVG — matches RackCreature style */}
        <svg width="44" height="44" viewBox="0 0 44 44" fill="none" style={{ imageRendering: 'pixelated' }}>
          {/* Body */}
          <rect x="10" y="14" width="24" height="20" rx="3" fill="rgba(255,255,255,0.85)" />
          {/* Eyes */}
          <rect x="15" y="20" width="5" height="5" rx="1" fill="#0a0a0a" />
          <rect x="24" y="20" width="5" height="5" rx="1" fill="#0a0a0a" />
          {/* Pupils */}
          <rect x="17" y="22" width="2" height="2" fill="white" />
          <rect x="26" y="22" width="2" height="2" fill="white" />
          {/* Mouth */}
          <rect x="18" y="28" width="8" height="2" rx="1" fill="#0a0a0a" />
          {/* Antenna */}
          <rect x="21" y="8" width="2" height="6" fill="rgba(255,255,255,0.85)" />
          <circle cx="22" cy="7" r="2.5" fill="#E8FF6B" />
          {/* Feet */}
          <rect x="13" y="32" width="6" height="4" rx="1" fill="rgba(255,255,255,0.85)" />
          <rect x="25" y="32" width="6" height="4" rx="1" fill="rgba(255,255,255,0.85)" />
        </svg>
        {/* Glow */}
        <div style={{
          position: 'absolute', inset: 0,
          background: 'radial-gradient(ellipse at center, rgba(232,255,107,0.08) 0%, transparent 70%)',
          pointerEvents: 'none',
        }} />
      </div>

      {/* Chat bubble */}
      <div style={{
        background: 'rgba(255,255,255,0.04)',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 10,
        padding: '10px 14px',
        width: '100%',
        animation: 'slideRowIn 0.4s 0.15s ease both',
      }}>
        <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'rgba(255,255,255,0.7)', lineHeight: 1.55 }}>
          "Drop the JD from Stripe. I'll rank your resumes and tell you exactly where you're short."
        </div>
      </div>

      {/* Input pill */}
      <div style={{
        background: 'rgba(255,255,255,0.03)',
        border: '1px solid rgba(255,255,255,0.07)',
        borderRadius: 8, padding: '8px 12px',
        width: '100%', display: 'flex', alignItems: 'center', gap: 8,
        animation: 'slideRowIn 0.4s 0.25s ease both',
      }}>
        <span style={{ flex: 1, fontFamily: 'var(--font-body)', fontSize: 11, color: 'rgba(255,255,255,0.2)' }}>
          Paste a job description or type / for tools…
        </span>
        <div style={{
          width: 22, height: 22, borderRadius: 6,
          background: 'rgba(232,255,107,0.15)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <path d="M5 8V2M2 5l3-3 3 3" stroke="#E8FF6B" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </div>
      </div>
    </div>
  )
}

// ── Apply visual ─────────────────────────────────────────────────────────────
function ApplyVisual() {
  const steps = [
    { status: 'done', text: 'Navigated to Stripe application' },
    { status: 'done', text: 'Filled name, email, phone' },
    { status: 'done', text: 'Attached resume.pdf' },
    { status: 'active', text: 'Submitting application…' },
  ]
  const icons = { done: '✓', active: '–' }
  const colors = { done: 'rgba(232,255,107,0.7)', active: 'rgba(255,255,255,0.4)' }

  return (
    <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 6 }}>
      {/* Live browser pill */}
      <div style={{
        background: 'rgba(232,255,107,0.05)',
        border: '1px solid rgba(232,255,107,0.15)',
        borderRadius: 8, padding: '8px 12px',
        display: 'flex', alignItems: 'center', gap: 8,
        marginBottom: 2,
      }}>
        <div style={{
          width: 6, height: 6, borderRadius: '50%',
          background: '#E8FF6B',
          boxShadow: '0 0 6px rgba(232,255,107,0.8)',
          animation: 'livePulse 1.5s ease-in-out infinite',
          flexShrink: 0,
        }} />
        <span style={{
          fontFamily: 'var(--font-mono, monospace)', fontSize: 9,
          color: 'rgba(232,255,107,0.7)', letterSpacing: '1px',
        }}>RACK · LIVE APPLICATION</span>
      </div>

      {steps.map(({ status, text }, i) => (
        <div key={i} style={{
          display: 'flex', alignItems: 'center', gap: 10,
          background: 'rgba(255,255,255,0.02)',
          border: '1px solid rgba(255,255,255,0.05)',
          borderRadius: 7, padding: '7px 10px',
          animation: `slideRowIn 0.35s ease both`,
          animationDelay: `${i * 80}ms`,
        }}>
          <span style={{
            fontFamily: 'var(--font-mono, monospace)', fontSize: 11,
            color: colors[status], width: 12, textAlign: 'center',
          }}>{icons[status]}</span>
          <span style={{
            fontFamily: 'var(--font-body)', fontSize: 11,
            color: status === 'active' ? 'rgba(255,255,255,0.6)' : 'rgba(255,255,255,0.4)',
          }}>{text}</span>
        </div>
      ))}
    </div>
  )
}

const VISUALS = {
  boards: BoardsVisual,
  pipeline: PipelineVisual,
  creature: CreatureVisual,
  apply: ApplyVisual,
}

// ── Main slideshow ───────────────────────────────────────────────────────────
export default function WelcomeSlideshow({ onDismiss }) {
  const [slide, setSlide] = useState(0)
  const [dir, setDir] = useState(1)    // 1 = forward, -1 = back
  const [animKey, setAnimKey] = useState(0)
  const isLast = slide === SLIDES.length - 1
  const total = SLIDES.length

  const go = (nextIdx, direction) => {
    setDir(direction)
    setAnimKey(k => k + 1)
    setSlide(nextIdx)
  }

  const next = () => {
    if (isLast) { onDismiss(); return }
    go(slide + 1, 1)
  }
  const prev = () => {
    if (slide === 0) return
    go(slide - 1, -1)
  }

  const Visual = VISUALS[SLIDES[slide].visual]
  const { tag, headline, body } = SLIDES[slide]

  // Keyboard nav
  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'ArrowRight' || e.key === 'Enter') next()
      if (e.key === 'ArrowLeft') prev()
      if (e.key === 'Escape') onDismiss()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [slide])

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9000,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(6,6,6,0.55)',
      backdropFilter: 'blur(5px) saturate(0.8)',
      WebkitBackdropFilter: 'blur(18px) saturate(0.8)',
      animation: 'wsOverlayIn 0.3s ease both',
      padding: '20px',
    }}>
      <style>{`
        @keyframes wsOverlayIn {
          from { opacity: 0; }
          to   { opacity: 1; }
        }
        @keyframes wsCardIn {
          from { opacity: 0; transform: translateY(16px) scale(0.97); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes wsSlideForward {
          from { opacity: 0; transform: translateX(32px); }
          to   { opacity: 1; transform: translateX(0); }
        }
        @keyframes wsSlideBack {
          from { opacity: 0; transform: translateX(-32px); }
          to   { opacity: 1; transform: translateX(0); }
        }
        @keyframes slideRowIn {
          from { opacity: 0; transform: translateY(6px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes livePulse {
          0%, 100% { opacity: 1; }
          50%       { opacity: 0.4; }
        }
        @keyframes wsTagIn {
          from { opacity: 0; letter-spacing: 3px; }
          to   { opacity: 1; letter-spacing: 1px; }
        }

        .ws-card {
          width: 100%;
          max-width: 480px;
          background: rgba(12,12,12,0.98);
          border: 1px solid rgba(255,255,255,0.09);
          border-radius: 16px;
          overflow: hidden;
          animation: wsCardIn 0.35s cubic-bezier(0.22,1,0.36,1) both;
          box-shadow:
            0 0 0 1px rgba(255,255,255,0.04) inset,
            0 40px 80px rgba(0,0,0,0.7),
            0 0 60px rgba(232,255,107,0.04);
        }

        .ws-content-anim-fwd {
          animation: wsSlideForward 0.32s cubic-bezier(0.22,1,0.36,1) both;
        }
        .ws-content-anim-back {
          animation: wsSlideBack 0.32s cubic-bezier(0.22,1,0.36,1) both;
        }

        .ws-next-btn {
          display: flex; align-items: center; justify-content: center; gap: 7px;
          width: 100%; padding: 13px 20px;
          border-radius: 9px;
          border: none;
          background: #E8FF6B;
          color: #0a0a0a;
          font-family: var(--font-body);
          font-size: 13px; font-weight: 700;
          cursor: pointer; letter-spacing: 0.1px;
          transition: opacity 0.15s, transform 0.15s;
        }
        .ws-next-btn:hover { opacity: 0.88; transform: scale(0.99); }
        .ws-next-btn:active { transform: scale(0.97); }

        .ws-launch-btn {
          background: #E8FF6B;
          box-shadow: 0 0 24px rgba(232,255,107,0.25);
        }

        .ws-skip-btn {
          background: none; border: none;
          font-family: var(--font-body); font-size: 11px;
          color: rgba(255,255,255,0.2); cursor: pointer;
          padding: 4px 8px; border-radius: 4px;
          transition: color 0.15s;
        }
        .ws-skip-btn:hover { color: rgba(255,255,255,0.45); }

        .ws-dot {
          width: 5px; height: 5px; border-radius: 50%;
          background: rgba(255,255,255,0.15);
          transition: background 0.25s, transform 0.25s;
          cursor: pointer;
        }
        .ws-dot.active {
          background: #E8FF6B;
          transform: scale(1.3);
        }
      `}</style>

      <div className="ws-card">

        {/* ── Top bar ── */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '16px 20px 0',
        }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 7,
          }}>
            <div style={{
              width: 6, height: 6, borderRadius: '50%',
              background: '#E8FF6B',
              boxShadow: '0 0 6px rgba(232,255,107,0.6)',
            }} />
            <span style={{
              fontFamily: 'var(--font-mono, monospace)',
              fontSize: 10, fontWeight: 600,
              color: 'rgba(232,255,107,0.6)',
              letterSpacing: '1px',
            }}>RACK</span>
          </div>
          <button className="ws-skip-btn" onClick={onDismiss}>
            Skip
          </button>
        </div>

        {/* ── Slide content ── */}
        <div
          key={animKey}
          className={dir >= 0 ? 'ws-content-anim-fwd' : 'ws-content-anim-back'}
          style={{ padding: '20px 20px 0' }}
        >
          {/* Tag */}
          <div style={{
            fontFamily: 'var(--font-mono, monospace)',
            fontSize: 9, fontWeight: 600,
            color: 'rgba(255,255,255,0.2)',
            letterSpacing: '1px',
            marginBottom: 12,
            animation: 'wsTagIn 0.4s ease both',
          }}>
            {tag}
          </div>

          {/* Headline */}
          <div style={{
            fontFamily: 'var(--font-display)',
            fontSize: 24, fontWeight: 800,
            color: '#fff',
            letterSpacing: '-0.6px', lineHeight: 1.18,
            marginBottom: 10,
            whiteSpace: 'pre-line',
          }}>
            {headline}
          </div>

          {/* Body */}
          <div style={{
            fontFamily: 'var(--font-body)',
            fontSize: 13, color: 'rgba(255,255,255,0.45)',
            lineHeight: 1.65,
            marginBottom: 20,
          }}>
            {body}
          </div>

          {/* Visual area */}
          <div style={{
            background: 'rgba(255,255,255,0.02)',
            border: '1px solid rgba(255,255,255,0.05)',
            borderRadius: 10,
            padding: '16px',
            marginBottom: 20,
            minHeight: 160,
          }}>
            <Visual />
          </div>
        </div>

        {/* ── Footer ── */}
        <div style={{
          padding: '0 20px 20px',
          display: 'flex', flexDirection: 'column', gap: 12,
        }}>
          {/* Dots + back */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            {/* Back */}
            <button
              onClick={prev}
              style={{
                background: 'none', border: 'none', cursor: slide === 0 ? 'default' : 'pointer',
                opacity: slide === 0 ? 0 : 1,
                transition: 'opacity 0.2s',
                padding: '4px 8px', borderRadius: 6,
                fontFamily: 'var(--font-body)', fontSize: 11,
                color: 'rgba(255,255,255,0.3)',
                display: 'flex', alignItems: 'center', gap: 4,
              }}
              disabled={slide === 0}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M7.5 9L4.5 6l3-3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              Back
            </button>

            {/* Dots */}
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              {SLIDES.map((_, i) => (
                <div
                  key={i}
                  className={`ws-dot${i === slide ? ' active' : ''}`}
                  onClick={() => go(i, i > slide ? 1 : -1)}
                />
              ))}
            </div>

            {/* Spacer to balance back button */}
            <div style={{ width: 48 }} />
          </div>

          {/* Next / Launch button */}
          <button
            className={`ws-next-btn${isLast ? ' ws-launch-btn' : ''}`}
            onClick={next}
          >
            {isLast ? (
              <>
                Launch Rack
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path d="M3 7h8M7.5 3.5 11 7l-3.5 3.5" stroke="#0a0a0a" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </>
            ) : (
              <>
                Next
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <path d="M2.5 6h7M6.5 3l3 3-3 3" stroke="#0a0a0a" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </>
            )}
          </button>
        </div>

      </div>
    </div>
  )
}