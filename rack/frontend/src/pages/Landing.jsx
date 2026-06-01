import { useState, useEffect, useRef } from 'react'

// ── Companies shown in marquee + pills ──────────────────────────────────────
const COMPANIES = [
  'Anthropic', 'Stripe', 'Figma', 'Vercel', 'Datadog', 'Cloudflare',
  'MongoDB', 'Brex', 'Coinbase', 'Airtable', 'Temporal', 'Amplitude',
  'Together AI', 'Runway', 'Elastic', 'Twilio', 'Descript', 'Fivetran',
  'LaunchDarkly', 'Chime', 'Marqeta', 'Mercury', 'Robinhood',
  'CockroachLabs', 'Mixpanel', 'AssemblyAI',
]

const ACTIVE_PILLS = new Set(['Anthropic', 'Figma', 'Cloudflare', 'Airtable'])

// ── Score bar animated counter ───────────────────────────────────────────────
function useCountUp(target, started, duration = 1400) {
  const [val, setVal] = useState(0)
  useEffect(() => {
    if (!started) return
    let start = null
    const step = (ts) => {
      if (!start) start = ts
      const p = Math.min((ts - start) / duration, 1)
      // ease-out cubic
      const eased = 1 - Math.pow(1 - p, 3)
      setVal(Math.round(eased * target))
      if (p < 1) requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  }, [started, target, duration])
  return val
}

function ScoreDemo() {
  const ref = useRef(null)
  const [started, setStarted] = useState(false)

  useEffect(() => {
    const obs = new IntersectionObserver(
      ([e]) => { if (e.isIntersecting) { setStarted(true); obs.disconnect() } },
      { threshold: 0.4 }
    )
    if (ref.current) obs.observe(ref.current)
    return () => obs.disconnect()
  }, [])

  const sf = useCountUp(88, started)
  const ex = useCountUp(76, started, 1500)
  const tr = useCountUp(71, started, 1600)

  const rows = [
    { label: 'Skills fit',  val: sf, target: 88, color: 'var(--accent)'  },
    { label: 'Experience',  val: ex, target: 76, color: 'var(--accent2)' },
    { label: 'Trajectory',  val: tr, target: 71, color: 'var(--accent3)' },
  ]

  return (
    <div ref={ref} style={{ marginTop: 24, display: 'flex', flexDirection: 'column', gap: 10 }}>
      {rows.map(({ label, val, target, color }) => (
        <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 13, color: 'var(--text-mid)', width: 100, flexShrink: 0 }}>{label}</span>
          <div style={{ flex: 1, height: 6, background: 'rgba(255,255,255,0.07)', borderRadius: 3, overflow: 'hidden' }}>
            <div style={{
              height: '100%', borderRadius: 3, background: color,
              width: `${(val / 100) * 100}%`,
              transition: 'width 0.05s linear',
            }} />
          </div>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 500, width: 36, textAlign: 'right', color }}>
            {val}%
          </span>
        </div>
      ))}
    </div>
  )
}

// ── Scroll reveal hook ───────────────────────────────────────────────────────
function useReveal(threshold = 0.12) {
  const ref = useRef(null)
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const obs = new IntersectionObserver(
      ([e]) => { if (e.isIntersecting) { setVisible(true); obs.disconnect() } },
      { threshold }
    )
    if (ref.current) obs.observe(ref.current)
    return () => obs.disconnect()
  }, [threshold])
  return [ref, visible]
}

function Reveal({ children, delay = 0, threshold = 0.12 }) {
  const [ref, visible] = useReveal(threshold)
  return (
    <div ref={ref} style={{
      opacity: visible ? 1 : 0,
      transform: visible ? 'translateY(0)' : 'translateY(32px)',
      transition: `opacity 0.7s ease ${delay}s, transform 0.7s ease ${delay}s`,
    }}>
      {children}
    </div>
  )
}

// ── Match result row ─────────────────────────────────────────────────────────
function MatchRow({ rank, name, role, score, color, barColor, delay }) {
  return (
    <div className="ld-match-row" style={{ animationDelay: delay }}>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-dim)', width: 24, flexShrink: 0 }}>
        #{rank}
      </span>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 14, fontWeight: 500 }}>{name}</div>
        <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>{role}</div>
      </div>
      <div style={{ width: 60, height: 4, background: 'rgba(255,255,255,0.07)', borderRadius: 2, overflow: 'hidden' }}>
        <div className="ld-score-bar" style={{ background: barColor, animationDelay: delay }} />
      </div>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 14, fontWeight: 600, color }}>{score}%</span>
    </div>
  )
}

// ── Main component ───────────────────────────────────────────────────────────
export default function Landing({ onEnter, onSkip }) {
  const [modalOpen, setModalOpen] = useState(false)

  // Close modal on Escape
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') setModalOpen(false) }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // Lock body scroll when modal open
  useEffect(() => {
    document.body.style.overflow = modalOpen ? 'hidden' : ''
    return () => { document.body.style.overflow = '' }
  }, [modalOpen])

  const handleGoogleSignIn = () => {
    setModalOpen(false)
    onEnter?.()
  }

  const scrollTo = (id) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' })

  return (
    <>
      <style>{CSS}</style>

      {/* ── Atmosphere ── */}
      <div className="ld-atmo" aria-hidden="true">
        <div className="ld-blob ld-blob-1" />
        <div className="ld-blob ld-blob-2" />
        <div className="ld-blob ld-blob-3" />
        <div className="ld-blob ld-blob-accent" />
      </div>
      <div className="ld-grain" aria-hidden="true" />

      <div className="ld-root">

        {/* ── NAV ── */}
        <nav className="ld-nav">
          <a href="#" className="ld-logo" onClick={(e) => e.preventDefault()}>
            <span className="ld-logo-pill">RACK</span>
            <span className="ld-logo-sub">your job agent</span>
          </a>
          <ul className="ld-nav-links">
            <li><button onClick={() => scrollTo('ld-how')}>How it works</button></li>
            <li><button onClick={() => scrollTo('ld-features')}>Features</button></li>
            <li><button onClick={() => scrollTo('ld-apply')}>Auto-apply</button></li>
          </ul>
          <div className="ld-nav-cta">
            <button className="ld-btn-ghost" onClick={() => setModalOpen(true)}>Log in</button>
            <button className="ld-btn-accent" onClick={() => setModalOpen(true)}>Get started free</button>
          </div>
        </nav>

        {/* ── HERO ── */}
        <section className="ld-hero">
          <div className="ld-hero-badge">
            <span className="ld-badge-dot" aria-hidden="true" />
            Now live — scanning 150+ company job boards daily
          </div>

          <h1 className="ld-hero-headline">
            Your resume,<br />matched to the <span className="ld-accent-word">right role</span>
          </h1>

          <p className="ld-hero-sub">
            Rack scans hundreds of job boards, scores every posting against your exact resume,
            and surfaces only the roles you'll actually get callbacks for.
          </p>

          <div className="ld-hero-actions">
            <button className="ld-btn-hero" onClick={() => setModalOpen(true)}>
              <Arrow />
              Start matching for free
            </button>
            <button className="ld-btn-hero-ghost" onClick={() => scrollTo('ld-how')}>
              See how it works
            </button>
          </div>

          <p className="ld-hero-meta">No credit card &middot; Free during beta &middot; Cancel anytime</p>

          {/* Terminal preview */}
          <div className="ld-hero-visual">
            <div className="ld-terminal-card">
              <div className="ld-terminal-bar">
                <div className="ld-tdot ld-tdot-r" />
                <div className="ld-tdot ld-tdot-y" />
                <div className="ld-tdot ld-tdot-g" />
                <span className="ld-terminal-title">rack — pipeline run ✦ 3 resumes matched</span>
              </div>
              <div className="ld-terminal-body">
                <div className="ld-pipeline-row">
                  <PipeStep label="Input" val="Software Engineer JD" />
                  <PipeArrow />
                  <PipeStep label="Phase 1 — Vector" val="pgvector similarity" />
                  <PipeArrow />
                  <PipeStep label="Phase 2 — LLM" val="GPT-4o-mini scoring" />
                  <PipeArrow />
                  <PipeStep label="Output" val="Ranked matches" accent />
                </div>
                <div className="ld-match-results">
                  <MatchRow rank={1} name="Tejas Kulkarni" role="SWE · 4 yrs · Full-stack" score={92} color="var(--accent)"  barColor="var(--accent)"  delay="1.4s" />
                  <MatchRow rank={2} name="Jordan Park"    role="SWE · 3 yrs · Backend"    score={78} color="var(--accent2)" barColor="var(--accent2)" delay="1.6s" />
                  <MatchRow rank={3} name="Alex Rivera"    role="SWE · 2 yrs · Frontend"   score={65} color="var(--accent3)" barColor="var(--accent3)" delay="1.8s" />
                </div>
              </div>
            </div>
          </div>

          <div className="ld-scroll-hint" aria-hidden="true">
            <span>scroll</span>
            <div className="ld-scroll-arrow" />
          </div>
        </section>

        {/* ── MARQUEE ── */}
        <div className="ld-marquee-wrap" aria-hidden="true">
          <div className="ld-marquee-track">
            {[...COMPANIES, ...COMPANIES].map((c, i) => (
              <span key={i} className="ld-marquee-item">{c}</span>
            ))}
          </div>
        </div>

        {/* ── STATS ── */}
        <div className="ld-stats-strip">
          {[
            { num: '150+',   label: 'Company job boards scanned daily' },
            { num: '2-phase',label: 'AI scoring pipeline per match' },
            { num: '6×',     label: 'Daily fetch runs, fully automated' },
            { num: '∞',      label: 'Resume versions supported' },
          ].map(({ num, label }, i) => (
            <Reveal key={num} delay={i * 0.1}>
              <div className="ld-stat-item">
                <div className="ld-stat-num">{num}</div>
                <div className="ld-stat-label">{label}</div>
              </div>
            </Reveal>
          ))}
        </div>

        {/* ── HOW IT WORKS ── */}
        <section id="ld-how" className="ld-section">
          <div className="ld-section-inner">
            <Reveal>
              <div className="ld-section-tag">Process</div>
              <h2 className="ld-section-title">Three steps to your next job</h2>
              <p className="ld-section-sub">Rack runs a full matching pipeline every day — no daily login required.</p>
            </Reveal>
            <Reveal delay={0.15}>
              <div className="ld-steps-grid">
                {[
                  { n: '01', icon: '📄', title: 'Upload your resume', desc: 'Drop up to 5 resume versions. Each is chunked, embedded into vectors, and stored. Tailor one for product-focused roles, another for engineering IC roles — Rack knows which to send where.' },
                  { n: '02', icon: '🔍', title: 'We scan while you sleep', desc: 'Six times a day, Rack fetches fresh postings from 150+ Greenhouse, Ashby, and Lever boards. Every new job is vector-scored against your resume — only top matches move to LLM scoring.' },
                  { n: '03', icon: '⚡', title: 'See your ranked matches', desc: 'Wake up to a sorted list of the best-fit roles — scored on skills fit, experience alignment, and career trajectory. One click to apply, or let Rack auto-apply for you.' },
                ].map(({ n, icon, title, desc }) => (
                  <div key={n} className="ld-step-card">
                    <div className="ld-step-num">{n}</div>
                    <span className="ld-step-icon" aria-hidden="true">{icon}</span>
                    <div className="ld-step-title">{title}</div>
                    <p className="ld-step-desc">{desc}</p>
                  </div>
                ))}
              </div>
            </Reveal>
          </div>
        </section>

        {/* ── FEATURES BENTO ── */}
        <section id="ld-features" className="ld-section">
          <div className="ld-section-inner">
            <Reveal>
              <div className="ld-section-tag">Features</div>
              <h2 className="ld-section-title">Built for the serious job seeker</h2>
              <p className="ld-section-sub">Not just another job board aggregator. A full AI matching engine.</p>
            </Reveal>

            <div className="ld-bento-grid">
              {/* Wide — company coverage */}
              <Reveal delay={0.1}>
                <div className="ld-bento-card ld-bento-wide">
                  <div className="ld-bento-corner-glow" aria-hidden="true" />
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 24 }}>
                    <div>
                      <div className="ld-bento-label">Coverage</div>
                      <div className="ld-bento-title">150+ company boards,<br />one inbox</div>
                      <p className="ld-bento-desc">Direct Greenhouse, Ashby, and Lever integrations — plus YC batch company auto-discovery. No job board middlemen.</p>
                    </div>
                    <div className="ld-company-pills">
                      {COMPANIES.slice(0, 14).map(c => (
                        <span key={c} className={`ld-cpill${ACTIVE_PILLS.has(c) ? ' ld-cpill-active' : ''}`}>{c}</span>
                      ))}
                    </div>
                  </div>
                </div>
              </Reveal>

              {/* AI scoring */}
              <Reveal delay={0.15}>
                <div className="ld-bento-card ld-bento-tall">
                  <div className="ld-bento-icon" aria-hidden="true">🧠</div>
                  <div className="ld-bento-label">Intelligence</div>
                  <div className="ld-bento-title">Two-phase AI scoring</div>
                  <p className="ld-bento-desc">Phase 1: pgvector cosine similarity filters the job pool. Phase 2: GPT-4o-mini scores each job on three dimensions.</p>
                  <ScoreDemo />
                </div>
              </Reveal>

              {/* Multi-resume */}
              <Reveal delay={0.2}>
                <div className="ld-bento-card ld-bento-tall">
                  <div className="ld-bento-icon" aria-hidden="true">📋</div>
                  <div className="ld-bento-label">Multi-resume</div>
                  <div className="ld-bento-title">Send the right version every time</div>
                  <p className="ld-bento-desc">Upload up to 5 resume variants. Rack picks the best-matching version per job automatically.</p>
                  <div style={{ marginTop: 24, display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {[
                      { name: 'resume_swe_ic.pdf',       badge: 'ACTIVE', active: true },
                      { name: 'resume_pm_adjacent.pdf',  badge: '2nd',    active: false },
                      { name: 'resume_ml_focused.pdf',   badge: '3rd',    active: false },
                    ].map(({ name, badge, active }) => (
                      <div key={name} className={`ld-resume-row${active ? ' ld-resume-row-active' : ''}`}>
                        <span style={{ fontSize: 16 }}>📄</span>
                        <span style={{ fontSize: 13, flex: 1 }}>{name}</span>
                        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: active ? 'var(--accent)' : 'var(--text-dim)' }}>{badge}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </Reveal>
            </div>
          </div>
        </section>

        {/* ── AUTO-APPLY ── */}
        <section id="ld-apply" className="ld-auto-apply-section">
          <div className="ld-auto-apply-inner">
            <Reveal>
              <div className="ld-section-tag">Automation</div>
              <h2 className="ld-section-title">Apply while you sleep</h2>
              <p className="ld-section-sub" style={{ marginBottom: 28 }}>
                Rack's Steel-powered browser agent fills out and submits applications on
                Greenhouse, Ashby, and Lever — accurately and without shortcuts.
              </p>
              <ul className="ld-benefits-list">
                {[
                  'Reads the actual form fields — no brittle hardcoded selectors',
                  'Uploads the best-fit resume version per application',
                  'Tracks every submission in your pipeline board',
                  'You stay in control — review matches before they go out',
                ].map((item) => (
                  <li key={item}>
                    <span className="ld-check" aria-hidden="true">✓</span>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </Reveal>

            <Reveal delay={0.2}>
              <div className="ld-apply-visual">
                <div className="ld-apply-header">
                  <div className="ld-live-dot" aria-hidden="true" />
                  <span className="ld-apply-header-text">steel agent · applying · Anthropic</span>
                </div>
                <div className="ld-apply-body">
                  {[
                    { time: '12:04:01', icon: '→', cls: 'ld-log-accent', msg: 'Opening Greenhouse form...' },
                    { time: '12:04:02', icon: '✓', cls: 'ld-log-green',  msg: 'Page loaded · anthropic.com/jobs' },
                    { time: '12:04:03', icon: '→', cls: 'ld-log-accent', msg: 'Selecting resume variant #1' },
                    { time: '12:04:04', icon: '↑', cls: 'ld-log-purple', msg: 'Uploading resume_swe_ic.pdf' },
                    { time: '12:04:05', icon: '✓', cls: 'ld-log-green',  msg: 'Resume uploaded' },
                    { time: '12:04:06', icon: '→', cls: 'ld-log-accent', msg: 'Filling name, email, LinkedIn' },
                    { time: '12:04:08', icon: '→', cls: 'ld-log-accent', msg: 'Answering work authorization' },
                    { time: '12:04:09', icon: '✓', cls: 'ld-log-green',  msg: 'All fields complete' },
                  ].map(({ time, icon, cls, msg }) => (
                    <span key={time} className="ld-log-line">
                      <span className="ld-log-dim">{time}</span>{' '}
                      <span className={cls}>{icon}</span>{' '}
                      {msg}
                    </span>
                  ))}
                  <span className="ld-log-line">
                    <span className="ld-log-dim">12:04:10</span>{' '}
                    <span className="ld-log-accent">→</span>{' '}
                    Submitting application...<span className="ld-cursor" aria-hidden="true" />
                  </span>
                </div>
              </div>
            </Reveal>
          </div>
        </section>

        {/* ── CTA ── */}
        <section className="ld-cta-section">
          <div className="ld-cta-inner">
            <Reveal>
              <h2 className="ld-cta-headline">
                Stop applying.<br />Start <span style={{ color: 'var(--accent)' }}>matching</span>.
              </h2>
              <p className="ld-cta-sub">
                Join the waitlist — Rack is in beta, scanning hundreds of jobs for early users every single day.
              </p>
              <div className="ld-cta-actions">
                <button className="ld-btn-cta" onClick={() => setModalOpen(true)}>
                  <Arrow size={20} />
                  Get early access
                </button>
                <span className="ld-cta-note">
                  Free during beta &mdash; built by{' '}
                  <a href="https://tejasbk.dev" target="_blank" rel="noopener noreferrer" className="ld-cta-link">
                    Tejas
                  </a>
                </span>
                {onSkip && (
                  <button className="ld-btn-skip" onClick={onSkip}>
                    Continue without signing in →
                  </button>
                )}
              </div>
            </Reveal>
          </div>
        </section>

        {/* ── FOOTER ── */}
        <footer className="ld-footer">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="ld-logo-pill">RACK</span>
            <span className="ld-logo-sub">rackx.app</span>
          </div>
          <p className="ld-footer-note">
            Built by{' '}
            <a href="https://tejasbk.dev" target="_blank" rel="noopener noreferrer" className="ld-cta-link">
              Tejas
            </a>
            {' '}&middot; Scanning jobs so you don't have to.
          </p>
        </footer>

      </div>{/* ld-root */}

      {/* ── LOGIN MODAL ── */}
      {modalOpen && (
        <div
          className="ld-modal-overlay ld-modal-open"
          onClick={(e) => { if (e.target === e.currentTarget) setModalOpen(false) }}
          role="dialog"
          aria-modal="true"
          aria-label="Sign in to Rack"
        >
          <div className="ld-modal-box">
            <button className="ld-modal-close" onClick={() => setModalOpen(false)} aria-label="Close">×</button>
            <div style={{ marginBottom: 24 }}>
              <span className="ld-logo-pill" style={{ fontSize: 15, padding: '6px 14px' }}>RACK</span>
            </div>
            <h2 className="ld-modal-title">Sign in to Rack</h2>
            <p className="ld-modal-sub">
              Continue with Google to access your matched jobs, resume vault, and application pipeline.
            </p>
            <button className="ld-btn-google" onClick={handleGoogleSignIn}>
              <GoogleIcon />
              Continue with Google
            </button>
          </div>
        </div>
      )}
    </>
  )
}

// ── Small helper components ──────────────────────────────────────────────────
function PipeStep({ label, val, accent }) {
  return (
    <div className={`ld-pipe-step${accent ? ' ld-pipe-accent' : ''}`}>
      <div className="ld-pipe-step-label">{label}</div>
      <div className={`ld-pipe-step-val${accent ? ' ld-pipe-val-accent' : ''}`}>{val}</div>
    </div>
  )
}

function PipeArrow() {
  return <div className="ld-pipe-arrow" aria-hidden="true">→</div>
}

function Arrow({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true">
      <path d="M5 12h14M12 5l7 7-7 7" />
    </svg>
  )
}

function GoogleIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/>
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
    </svg>
  )
}

// ── All styles ── (scoped with ld- prefix to avoid collisions with app styles)
const CSS = `
  .ld-root {
    position: relative; z-index: 2;
    min-height: 100dvh;
    overflow-x: hidden;
    overflow-y: auto;
    scroll-behavior: smooth;
    font-family: var(--font-body);
  }

  /* Atmosphere */
  .ld-atmo {
    position: fixed; inset: 0; pointer-events: none; z-index: 0; overflow: hidden;
  }
  .ld-blob {
    position: absolute; border-radius: 50%;
    filter: blur(120px); opacity: 0.45;
    pointer-events: none;
  }
  .ld-blob-1      { width:700px;height:700px;background:#1a1a2e;top:-200px;left:-200px; }
  .ld-blob-2      { width:500px;height:500px;background:#0d1f0d;top:20%;right:-100px; }
  .ld-blob-3      { width:600px;height:600px;background:#1a0a2e;bottom:-100px;left:30%; }
  .ld-blob-accent { width:300px;height:300px;background:rgba(232,255,107,0.06);top:10%;left:40%;filter:blur(80px); }
  .ld-grain {
    position:fixed;inset:0;pointer-events:none;z-index:1;opacity:0.022;
    background-image:url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E");
    background-size:200px 200px;
  }

  /* Nav */
  .ld-nav {
    position: sticky; top: 0; left: 0; right: 0; z-index: 100;
    display: flex; align-items: center; justify-content: space-between;
    padding: 20px 48px;
    background: rgba(11,11,13,0.65);
    backdrop-filter: blur(20px);
    border-bottom: 1px solid var(--border);
  }
  .ld-logo { display:flex;align-items:center;gap:10px;text-decoration:none; }
  .ld-logo-pill {
    background: var(--accent); color: #000;
    font-family: var(--font-display); font-weight: 800;
    font-size: 13px; letter-spacing: 0.08em;
    padding: 4px 10px; border-radius: 6px;
  }
  .ld-logo-sub {
    font-family: var(--font-mono); font-size: 12px;
    color: var(--text-dim); letter-spacing: 0.04em;
  }
  .ld-nav-links {
    display:flex;align-items:center;gap:32px;list-style:none;
  }
  .ld-nav-links button {
    background:none;border:none;padding:0;
    font-family:var(--font-body);font-size:14px;
    color:var(--text-mid);cursor:pointer;
    transition:color 0.2s;
  }
  .ld-nav-links button:hover { color:var(--text); }
  .ld-nav-cta { display:flex;align-items:center;gap:12px; }
  .ld-btn-ghost {
    background:none;border:1px solid var(--border-bright);color:var(--text-mid);
    font-family:var(--font-body);font-size:14px;padding:8px 20px;border-radius:8px;
    cursor:pointer;transition:all 0.2s;
  }
  .ld-btn-ghost:hover { border-color:rgba(255,255,255,0.3);color:var(--text); }
  .ld-btn-accent {
    background:var(--accent);color:#000;font-family:var(--font-body);
    font-weight:600;font-size:14px;padding:9px 22px;border:none;border-radius:8px;
    cursor:pointer;transition:all 0.18s;
  }
  .ld-btn-accent:hover {
    background:#f0ff80;box-shadow:0 0 24px rgba(232,255,107,0.25);transform:translateY(-1px);
  }

  /* Hero */
  .ld-hero {
    position:relative;z-index:2;
    min-height:100dvh;
    display:flex;flex-direction:column;align-items:center;justify-content:center;
    text-align:center;padding:140px 24px 80px;overflow:hidden;
  }
  .ld-hero-badge {
    display:inline-flex;align-items:center;gap:8px;
    border:1px solid rgba(232,255,107,0.25);background:rgba(232,255,107,0.07);
    border-radius:100px;padding:6px 16px 6px 8px;
    font-size:13px;color:rgba(232,255,107,0.85);margin-bottom:40px;
    opacity:0;animation:ldFadeUp 0.7s 0.1s ease forwards;
  }
  .ld-badge-dot {
    width:6px;height:6px;background:var(--accent);border-radius:50%;
    box-shadow:0 0 8px var(--accent);animation:ldPulseDot 2s ease-in-out infinite;
  }
  .ld-hero-headline {
    font-family:var(--font-display);font-weight:800;
    font-size:clamp(52px,8vw,96px);line-height:0.95;letter-spacing:-0.03em;
    color:var(--text);max-width:900px;
    opacity:0;animation:ldFadeUp 0.8s 0.25s ease forwards;
  }
  .ld-accent-word {
    color:var(--accent);position:relative;display:inline-block;
  }
  .ld-accent-word::after {
    content:'';position:absolute;bottom:4px;left:0;right:0;
    height:3px;background:var(--accent);border-radius:2px;opacity:0.4;
    transform:scaleX(0);transform-origin:left;
    animation:ldUnderline 0.6s 1.2s ease forwards;
  }
  .ld-hero-sub {
    margin-top:28px;font-size:19px;line-height:1.6;color:var(--text-mid);
    max-width:560px;font-weight:300;
    opacity:0;animation:ldFadeUp 0.8s 0.4s ease forwards;
  }
  .ld-hero-actions {
    margin-top:44px;display:flex;align-items:center;gap:16px;
    flex-wrap:wrap;justify-content:center;
    opacity:0;animation:ldFadeUp 0.8s 0.55s ease forwards;
  }
  .ld-btn-hero {
    background:var(--accent);color:#000;font-family:var(--font-body);
    font-weight:600;font-size:16px;padding:14px 32px;border:none;border-radius:10px;
    cursor:pointer;transition:all 0.2s;display:flex;align-items:center;gap:8px;
  }
  .ld-btn-hero:hover { background:#f0ff80;box-shadow:0 0 40px rgba(232,255,107,0.3);transform:translateY(-2px); }
  .ld-btn-hero-ghost {
    background:none;border:1px solid var(--border-bright);color:var(--text-mid);
    font-family:var(--font-body);font-size:16px;padding:14px 28px;border-radius:10px;
    cursor:pointer;transition:all 0.2s;
  }
  .ld-btn-hero-ghost:hover { border-color:rgba(255,255,255,0.3);color:var(--text); }
  .ld-hero-meta {
    margin-top:28px;font-size:13px;color:var(--text-dim);
    opacity:0;animation:ldFadeUp 0.8s 0.7s ease forwards;
  }

  /* Terminal */
  .ld-hero-visual {
    position:relative;z-index:2;margin-top:72px;width:100%;max-width:860px;
    opacity:0;animation:ldFadeUp 1s 0.85s ease forwards;
  }
  .ld-terminal-card {
    background:var(--surface);border:1px solid var(--border-bright);border-radius:18px;
    overflow:hidden;box-shadow:0 40px 120px rgba(0,0,0,0.6),0 0 0 1px rgba(232,255,107,0.04);
  }
  .ld-terminal-bar {
    background:rgba(255,255,255,0.025);border-bottom:1px solid var(--border);
    padding:13px 18px;display:flex;align-items:center;gap:10px;
  }
  .ld-tdot { width:10px;height:10px;border-radius:50%; }
  .ld-tdot-r { background:#ff5f57; }
  .ld-tdot-y { background:#ffbd2e; }
  .ld-tdot-g { background:#28c840; }
  .ld-terminal-title {
    font-family:var(--font-mono);font-size:12px;color:var(--text-dim);
    margin-left:auto;margin-right:auto;transform:translateX(-20px);
  }
  .ld-terminal-body { padding:28px 32px; }
  .ld-pipeline-row { display:flex;align-items:center;gap:0;margin-bottom:12px; }
  .ld-pipe-step {
    flex:1;background:var(--surface2);border:1px solid var(--border-bright);
    border-radius:8px;padding:12px 16px;
  }
  .ld-pipe-step-label {
    font-family:var(--font-mono);font-size:11px;color:var(--text-dim);
    text-transform:uppercase;letter-spacing:0.08em;margin-bottom:4px;
  }
  .ld-pipe-step-val { font-size:14px;font-weight:500;color:var(--text); }
  .ld-pipe-accent {
    border-color:rgba(232,255,107,0.3);background:rgba(232,255,107,0.04);
  }
  .ld-pipe-val-accent { color:var(--accent); }
  .ld-pipe-arrow { width:32px;flex-shrink:0;text-align:center;color:var(--text-dim);font-size:16px; }
  .ld-match-results { margin-top:20px;display:flex;flex-direction:column;gap:8px; }
  .ld-match-row {
    display:flex;align-items:center;gap:14px;
    background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:11px 16px;
    opacity:0;animation:ldSlideIn 0.5s ease forwards;
  }
  .ld-score-bar {
    height:100%;border-radius:2px;
    animation:ldBarFill 1s ease forwards;
  }
  .ld-score-bar[style*="var(--accent)"]  { --bar-end:92%; animation-delay:1.5s; }
  .ld-score-bar[style*="var(--accent2)"] { --bar-end:78%; animation-delay:1.7s; }
  .ld-score-bar[style*="var(--accent3)"] { --bar-end:65%; animation-delay:1.9s; }

  /* Scroll hint */
  .ld-scroll-hint {
    position:absolute;bottom:40px;left:50%;transform:translateX(-50%);
    display:flex;flex-direction:column;align-items:center;gap:8px;
    color:var(--text-dim);font-size:12px;letter-spacing:0.08em;
    opacity:0;animation:ldFadeUp 1s 1.5s ease forwards;
  }
  .ld-scroll-arrow {
    width:20px;height:20px;
    border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;
    transform:rotate(45deg);animation:ldScrollBounce 1.6s ease-in-out infinite;
  }

  /* Marquee */
  .ld-marquee-wrap {
    overflow:hidden;position:relative;z-index:2;
    border-top:1px solid var(--border);border-bottom:1px solid var(--border);
    padding:20px 0;background:rgba(255,255,255,0.01);
  }
  .ld-marquee-track {
    display:flex;gap:48px;width:max-content;
    animation:ldMarquee 30s linear infinite;
  }
  .ld-marquee-item {
    font-family:var(--font-mono);font-size:12px;color:var(--text-dim);
    white-space:nowrap;display:flex;align-items:center;gap:12px;
  }
  .ld-marquee-item::before { content:'✦';color:var(--accent);opacity:0.5; }

  /* Stats */
  .ld-stats-strip {
    position:relative;z-index:2;
    border-top:1px solid var(--border);border-bottom:1px solid var(--border);
    background:rgba(255,255,255,0.016);
    padding:36px 48px;display:flex;align-items:stretch;justify-content:center;gap:0;
  }
  .ld-stat-item { flex:1;max-width:240px;text-align:center;padding:0 32px; }
  .ld-stat-item + .ld-stat-item { border-left:1px solid var(--border); }
  .ld-stat-num {
    font-family:var(--font-display);font-weight:800;font-size:40px;
    color:var(--accent);line-height:1;letter-spacing:-0.02em;
  }
  .ld-stat-label { margin-top:6px;font-size:13px;color:var(--text-dim); }

  /* Sections */
  .ld-section { position:relative;z-index:2; }
  .ld-section-inner { max-width:1100px;margin:0 auto;padding:96px 48px; }
  .ld-section-tag {
    display:inline-flex;align-items:center;gap:8px;
    font-family:var(--font-mono);font-size:12px;color:var(--accent);
    letter-spacing:0.1em;text-transform:uppercase;margin-bottom:20px;
  }
  .ld-section-tag::before { content:'';display:block;width:20px;height:1px;background:var(--accent); }
  .ld-section-title {
    font-family:var(--font-display);font-weight:700;
    font-size:clamp(34px,4vw,52px);line-height:1.1;letter-spacing:-0.02em;
    color:var(--text);max-width:600px;margin-bottom:16px;
  }
  .ld-section-sub {
    font-size:17px;color:var(--text-mid);max-width:500px;line-height:1.7;font-weight:300;
  }

  /* Steps */
  .ld-steps-grid { margin-top:60px;display:grid;grid-template-columns:repeat(3,1fr);gap:2px; }
  .ld-step-card {
    background:var(--surface);border:1px solid var(--border);
    padding:36px 32px;position:relative;overflow:hidden;transition:border-color 0.25s;
  }
  .ld-step-card:first-child { border-radius:12px 0 0 12px; }
  .ld-step-card:last-child  { border-radius:0 12px 12px 0; }
  .ld-step-card::before {
    content:'';position:absolute;top:0;left:0;right:0;height:1px;
    background:linear-gradient(90deg,transparent,rgba(232,255,107,0.12),transparent);
    opacity:0;transition:opacity 0.3s;
  }
  .ld-step-card:hover { border-color:rgba(232,255,107,0.18); }
  .ld-step-card:hover::before { opacity:1; }
  .ld-step-num { font-family:var(--font-mono);font-size:11px;color:var(--accent);letter-spacing:0.1em;margin-bottom:20px; }
  .ld-step-icon { font-size:28px;margin-bottom:16px;display:block; }
  .ld-step-title { font-family:var(--font-display);font-weight:700;font-size:20px;color:var(--text);margin-bottom:10px; }
  .ld-step-desc { font-size:14px;color:var(--text-mid);line-height:1.65; }

  /* Bento */
  .ld-bento-grid { margin-top:48px;display:grid;grid-template-columns:1fr 1fr;gap:16px; }
  .ld-bento-card {
    background:var(--surface);border:1px solid var(--border);border-radius:18px;
    padding:36px 32px;position:relative;overflow:hidden;
    transition:border-color 0.25s,transform 0.25s;
  }
  .ld-bento-card:hover { border-color:rgba(232,255,107,0.18);transform:translateY(-2px); }
  .ld-bento-wide { grid-column:1 / -1; }
  .ld-bento-tall { min-height:320px; }
  .ld-bento-corner-glow {
    position:absolute;bottom:-60px;right:-60px;width:200px;height:200px;border-radius:50%;
    background:radial-gradient(circle,rgba(232,255,107,0.08) 0%,transparent 70%);pointer-events:none;
  }
  .ld-bento-icon {
    width:44px;height:44px;border-radius:10px;
    background:rgba(232,255,107,0.1);border:1px solid rgba(232,255,107,0.2);
    display:flex;align-items:center;justify-content:center;font-size:20px;margin-bottom:20px;
  }
  .ld-bento-label {
    font-family:var(--font-mono);font-size:11px;color:var(--accent);
    letter-spacing:0.1em;text-transform:uppercase;margin-bottom:10px;
  }
  .ld-bento-title { font-family:var(--font-display);font-weight:700;font-size:22px;color:var(--text);margin-bottom:10px;line-height:1.2; }
  .ld-bento-desc { font-size:14px;color:var(--text-mid);line-height:1.65;max-width:380px; }
  .ld-company-pills { display:flex;flex-wrap:wrap;gap:8px;max-width:420px; }
  .ld-cpill {
    background:var(--surface2);border:1px solid var(--border-bright);border-radius:6px;
    padding:5px 12px;font-family:var(--font-mono);font-size:12px;color:var(--text-mid);transition:all 0.2s;
  }
  .ld-cpill:hover { border-color:rgba(232,255,107,0.3);color:var(--accent); }
  .ld-cpill-active { background:rgba(232,255,107,0.08);border-color:rgba(232,255,107,0.3);color:var(--accent); }
  .ld-resume-row {
    display:flex;align-items:center;gap:10px;background:var(--surface2);
    border:1px solid var(--border);border-radius:8px;padding:10px 14px;
  }
  .ld-resume-row-active { border-color:rgba(232,255,107,0.2); }

  /* Auto-apply */
  .ld-auto-apply-section {
    position:relative;z-index:2;
    background:linear-gradient(180deg,transparent 0%,rgba(232,255,107,0.025) 50%,transparent 100%);
    border-top:1px solid var(--border);border-bottom:1px solid var(--border);
  }
  .ld-auto-apply-inner {
    max-width:1100px;margin:0 auto;padding:96px 48px;
    display:grid;grid-template-columns:1fr 1fr;gap:80px;align-items:center;
  }
  .ld-benefits-list { list-style:none;display:flex;flex-direction:column;gap:14px; }
  .ld-benefits-list li { display:flex;align-items:flex-start;gap:12px; }
  .ld-check { color:var(--accent);margin-top:2px;flex-shrink:0; }
  .ld-benefits-list li > span:last-child { font-size:15px;color:var(--text-mid);line-height:1.5; }
  .ld-apply-visual {
    background:var(--surface);border:1px solid var(--border-bright);border-radius:18px;
    overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,0.4);
  }
  .ld-apply-header {
    background:rgba(255,255,255,0.025);border-bottom:1px solid var(--border);
    padding:12px 16px;display:flex;align-items:center;gap:8px;
  }
  .ld-live-dot {
    width:8px;height:8px;background:var(--accent3);border-radius:50%;
    box-shadow:0 0 8px var(--accent3);animation:ldPulseDot 1.5s ease-in-out infinite;
  }
  .ld-apply-header-text { font-family:var(--font-mono);font-size:12px;color:var(--text-mid); }
  .ld-apply-body {
    padding:20px;font-family:var(--font-mono);font-size:12px;line-height:2;
    color:var(--text-dim);display:flex;flex-direction:column;
  }
  .ld-log-line { display:block; }
  .ld-log-accent { color:var(--accent); }
  .ld-log-green  { color:var(--accent3); }
  .ld-log-purple { color:var(--accent2); }
  .ld-log-dim    { color:rgba(255,255,255,0.2); }
  .ld-cursor {
    display:inline-block;width:8px;height:14px;background:var(--accent);
    margin-left:2px;animation:ldBlink 1.1s step-end infinite;vertical-align:middle;
  }

  /* CTA */
  .ld-cta-section { position:relative;z-index:2;text-align:center; }
  .ld-cta-inner { max-width:720px;margin:0 auto;padding:120px 48px; }
  .ld-cta-headline {
    font-family:var(--font-display);font-weight:800;
    font-size:clamp(40px,5vw,64px);line-height:1.05;letter-spacing:-0.03em;
    color:var(--text);margin-bottom:20px;
  }
  .ld-cta-sub {
    font-size:17px;color:var(--text-mid);line-height:1.6;font-weight:300;
    max-width:460px;margin:0 auto 44px;
  }
  .ld-cta-actions { display:flex;flex-direction:column;align-items:center;gap:16px; }
  .ld-btn-cta {
    background:var(--accent);color:#000;font-family:var(--font-body);
    font-weight:700;font-size:17px;padding:16px 48px;border:none;border-radius:12px;
    cursor:pointer;transition:all 0.2s;display:flex;align-items:center;gap:10px;
  }
  .ld-btn-cta:hover { background:#f0ff80;box-shadow:0 0 60px rgba(232,255,107,0.4);transform:translateY(-3px); }
  .ld-cta-note { font-size:13px;color:var(--text-dim); }
  .ld-cta-link { color:var(--text-dim);text-decoration:none;transition:color 0.2s; }
  .ld-cta-link:hover { color:var(--accent); }
  .ld-btn-skip {
    background:none;border:none;font-family:var(--font-body);
    font-size:13px;color:var(--text-dim);cursor:pointer;
    transition:color 0.2s;padding:0;
  }
  .ld-btn-skip:hover { color:var(--text-mid); }

  /* Footer */
  .ld-footer {
    position:relative;z-index:2;border-top:1px solid var(--border);
    padding:40px 48px;display:flex;align-items:center;justify-content:space-between;
  }
  .ld-footer-note { font-size:13px;color:var(--text-dim); }

  /* Modal */
  .ld-modal-overlay {
    position:fixed;inset:0;z-index:999;background:rgba(0,0,0,0.75);
    backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;
    animation:ldFadeIn 0.2s ease;
  }
  .ld-modal-box {
    background:var(--surface);border:1px solid var(--border-bright);border-radius:20px;
    padding:48px 40px;max-width:420px;width:90%;text-align:center;position:relative;
    animation:ldModalIn 0.3s cubic-bezier(0.22,1,0.36,1);
  }
  .ld-modal-title { font-family:var(--font-display);font-weight:700;font-size:26px;color:var(--text);margin-bottom:10px; }
  .ld-modal-sub { font-size:14px;color:var(--text-dim);margin-bottom:32px;line-height:1.6; }
  .ld-modal-close {
    position:absolute;top:16px;right:16px;background:none;border:none;
    color:var(--text-dim);font-size:22px;cursor:pointer;line-height:1;
    padding:4px 8px;border-radius:6px;transition:all 0.2s;
  }
  .ld-modal-close:hover { color:var(--text);background:rgba(255,255,255,0.06); }
  .ld-btn-google {
    width:100%;display:flex;align-items:center;justify-content:center;gap:12px;
    background:#fff;color:#1a1a1a;font-family:var(--font-body);
    font-size:15px;font-weight:600;padding:14px 24px;
    border:none;border-radius:10px;cursor:pointer;transition:all 0.2s;
  }
  .ld-btn-google:hover { background:#f3f3f3;box-shadow:0 4px 20px rgba(0,0,0,0.3); }

  /* Keyframes */
  @keyframes ldFadeUp {
    from { opacity:0;transform:translateY(28px); }
    to   { opacity:1;transform:translateY(0); }
  }
  @keyframes ldFadeIn { from { opacity:0; } to { opacity:1; } }
  @keyframes ldModalIn {
    from { opacity:0;transform:translateY(20px) scale(0.97); }
    to   { opacity:1;transform:translateY(0) scale(1); }
  }
  @keyframes ldUnderline { to { transform:scaleX(1); } }
  @keyframes ldPulseDot {
    0%,100% { opacity:1;transform:scale(1); }
    50%     { opacity:0.6;transform:scale(0.75); }
  }
  @keyframes ldSlideIn {
    from { opacity:0;transform:translateX(-10px); }
    to   { opacity:1;transform:translateX(0); }
  }
  @keyframes ldBarFill { to { width:var(--bar-end,80%); } }
  @keyframes ldBlink { 0%,100%{opacity:1;} 50%{opacity:0;} }
  @keyframes ldScrollBounce {
    0%,100% { transform:rotate(45deg) translateY(0); }
    50%     { transform:rotate(45deg) translateY(4px); }
  }
  @keyframes ldMarquee {
    from { transform:translateX(0); }
    to   { transform:translateX(-50%); }
  }

  /* Responsive */
  @media (max-width:900px) {
    .ld-nav { padding:16px 24px; }
    .ld-nav-links { display:none; }
    .ld-section-inner { padding:72px 24px; }
    .ld-auto-apply-inner { grid-template-columns:1fr;gap:48px;padding:72px 24px; }
    .ld-steps-grid { grid-template-columns:1fr;gap:12px; }
    .ld-step-card { border-radius:12px !important; }
    .ld-bento-grid { grid-template-columns:1fr; }
    .ld-bento-wide { grid-column:1; }
    .ld-stats-strip { flex-direction:column;gap:0;padding:48px 24px; }
    .ld-stat-item { max-width:100%;padding:24px 0; }
    .ld-stat-item + .ld-stat-item { border-left:none;border-top:1px solid var(--border); }
    .ld-footer { flex-direction:column;gap:16px;text-align:center; }
    .ld-hero { padding:120px 24px 80px; }
    .ld-pipeline-row { flex-wrap:wrap;gap:8px; }
    .ld-pipe-arrow { display:none; }
    .ld-pipe-step { flex:1;min-width:40%; }
  }
`