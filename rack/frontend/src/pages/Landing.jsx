import { useState, useEffect, useRef, useCallback } from 'react'

// ── Companies for marquee ────────────────────────────────────────────────────
const COMPANIES = [
  'Anthropic', 'Stripe', 'Figma', 'Vercel', 'Datadog', 'Cloudflare',
  'MongoDB', 'Brex', 'Coinbase', 'Airtable', 'Temporal', 'Amplitude',
  'Together AI', 'Runway', 'Elastic', 'Twilio', 'Descript', 'Fivetran',
  'LaunchDarkly', 'Chime', 'Marqeta', 'Mercury', 'Robinhood',
  'CockroachLabs', 'Mixpanel', 'AssemblyAI',
]

// ── Scroll-triggered reveal hook ─────────────────────────────────────────────
function useInView(threshold = 0.15) {
  const ref = useRef(null)
  const [inView, setInView] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const obs = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) { setInView(true); obs.disconnect() } },
      { threshold }
    )
    obs.observe(el)
    return () => obs.disconnect()
  }, [threshold])
  return [ref, inView]
}

// ── Parallax hook ────────────────────────────────────────────────────────────
function useParallax(speed = 0.15) {
  const ref = useRef(null)
  const [offset, setOffset] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const update = () => {
      const rect = el.getBoundingClientRect()
      const center = rect.top + rect.height / 2 - window.innerHeight / 2
      setOffset(center * speed)
    }
    const scrollEl = el.closest('[data-scroll]') || window
    scrollEl.addEventListener('scroll', update, { passive: true })
    update()
    return () => scrollEl.removeEventListener('scroll', update)
  }, [speed])
  return [ref, offset]
}

// ── Count-up animation ───────────────────────────────────────────────────────
function useCountUp(target, started, duration = 1200) {
  const [val, setVal] = useState(0)
  useEffect(() => {
    if (!started) return
    let startTime = null
    const step = (ts) => {
      if (!startTime) startTime = ts
      const p = Math.min((ts - startTime) / duration, 1)
      const eased = 1 - Math.pow(1 - p, 3)
      setVal(Math.round(eased * target))
      if (p < 1) requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  }, [started, target, duration])
  return val
}

// ── Reveal wrapper ───────────────────────────────────────────────────────────
function Reveal({ children, delay = 0, y = 24, className = '' }) {
  const [ref, inView] = useInView(0.1)
  return (
    <div
      ref={ref}
      className={className}
      style={{
        opacity: inView ? 1 : 0,
        transform: inView ? 'translateY(0)' : `translateY(${y}px)`,
        transition: `opacity 0.75s cubic-bezier(0.16,1,0.3,1) ${delay}s, transform 0.75s cubic-bezier(0.16,1,0.3,1) ${delay}s`,
      }}
    >
      {children}
    </div>
  )
}

// ── Score bars widget ────────────────────────────────────────────────────────
function ScoreWidget() {
  const [ref, inView] = useInView(0.4)
  const sf = useCountUp(88, inView, 1000)
  const ex = useCountUp(76, inView, 1200)
  const tr = useCountUp(71, inView, 1400)

  const bars = [
    { label: 'Skills fit',   val: sf, end: 88, color: '#16a34a' },
    { label: 'Experience',   val: ex, end: 76, color: '#2563eb' },
    { label: 'Trajectory',   val: tr, end: 71, color: '#9333ea' },
  ]

  return (
    <div ref={ref} style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 20 }}>
      {bars.map(({ label, val, end, color }) => (
        <div key={label}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
            <span style={{ fontSize: 13, fontWeight: 500, color: '#374151' }}>{label}</span>
            <span style={{ fontSize: 13, fontWeight: 700, color, fontFamily: 'var(--ld-mono)' }}>{val}%</span>
          </div>
          <div style={{ height: 6, background: '#f3f4f6', borderRadius: 99, overflow: 'hidden' }}>
            <div style={{
              height: '100%',
              width: inView ? `${end}%` : '0%',
              background: color,
              borderRadius: 99,
              transition: 'width 1.2s cubic-bezier(0.16,1,0.3,1)',
            }} />
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Google icon ──────────────────────────────────────────────────────────────
function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/>
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
    </svg>
  )
}

// ── Main landing component ───────────────────────────────────────────────────
export default function Landing({ onEnter, onSkip }) {
  const [modalOpen, setModalOpen] = useState(false)
  const [scrollY, setScrollY] = useState(0)
  const scrollRef = useRef(null)

  // Track scroll for parallax + nav opacity
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => setScrollY(el.scrollTop)
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  // Escape key for modal
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') setModalOpen(false) }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // Lock page scroll when modal open
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.style.overflow = modalOpen ? 'hidden' : 'auto'
  }, [modalOpen])

  const openModal = () => setModalOpen(true)
  const closeModal = () => setModalOpen(false)
  const handleSignIn = () => { closeModal(); onEnter?.() }
  const scrollTo = (id) => {
    const el = document.getElementById(id)
    if (el && scrollRef.current) {
      scrollRef.current.scrollTo({ top: el.offsetTop - 64, behavior: 'smooth' })
    }
  }

  const navAlpha = Math.min(scrollY / 80, 1)
  const heroParallax = scrollY * 0.25

  return (
    <>
      <style>{CSS}</style>

      {/* ── Full-page scroll container — escapes App's overflow:clip ── */}
      <div ref={scrollRef} data-scroll className="ld-page" aria-label="Rack landing page">

        {/* ── NAV ── */}
        <nav
          className="ld-nav"
          style={{
            background: `rgba(255,255,255,${0.7 + navAlpha * 0.25})`,
            borderBottomColor: `rgba(0,0,0,${0.04 + navAlpha * 0.04})`,
            boxShadow: navAlpha > 0.3 ? `0 1px 0 rgba(0,0,0,${navAlpha * 0.06})` : 'none',
          }}
        >
          <div className="ld-nav-logo">
            <div className="ld-wordmark">rack</div>
          </div>
          <ul className="ld-nav-links">
            {['How it works', 'Features', 'Auto-apply'].map((label, i) => (
              <li key={label}>
                <button onClick={() => scrollTo(['ld-how', 'ld-features', 'ld-apply'][i])}>{label}</button>
              </li>
            ))}
          </ul>
          <div className="ld-nav-actions">
            <button className="ld-btn-text" onClick={openModal}>Log in</button>
            <button className="ld-btn-pill" onClick={openModal}>Get started</button>
          </div>
        </nav>

        {/* ── HERO ── */}
        <section className="ld-hero">
          {/* Geometric grid background */}
          <div className="ld-hero-grid" aria-hidden="true" style={{ transform: `translateY(${heroParallax * 0.3}px)` }} />
          <div className="ld-hero-glow" aria-hidden="true" style={{ transform: `translateY(${heroParallax * 0.15}px)` }} />

          <div className="ld-hero-inner">
            {/* Badge */}
            <div className="ld-badge" style={{ animation: 'ldFadeUp 0.6s 0.05s both' }}>
              <span className="ld-badge-pulse" aria-hidden="true" />
              <span>Now live — 150+ company job boards, scanned daily</span>
            </div>

            {/* Headline */}
            <h1 className="ld-hero-h1" style={{ animation: 'ldFadeUp 0.7s 0.15s both' }}>
              Your resume,<br />
              <span className="ld-gradient-text">matched perfectly</span>
            </h1>

            <p className="ld-hero-sub" style={{ animation: 'ldFadeUp 0.7s 0.28s both' }}>
              Rack scans every job board, scores each posting against your exact resume,
              and surfaces only the roles you'll actually hear back from.
            </p>

            {/* CTAs */}
            <div className="ld-hero-ctas" style={{ animation: 'ldFadeUp 0.7s 0.4s both' }}>
              <button className="ld-btn-primary" onClick={openModal}>
                Start matching for free
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
              </button>
              <button className="ld-btn-ghost" onClick={() => scrollTo('ld-how')}>
                See how it works
              </button>
            </div>

            <p className="ld-hero-note" style={{ animation: 'ldFadeUp 0.7s 0.52s both' }}>
              Free during beta · No credit card · Cancel anytime
            </p>

            {/* Hero product card */}
            <div className="ld-hero-card" style={{ animation: 'ldFadeUp 0.9s 0.65s both' }}>
              <div className="ld-card-top-bar">
                <div className="ld-dots">
                  <span className="ld-dot" style={{ background: '#ff5f57' }} />
                  <span className="ld-dot" style={{ background: '#ffbd2e' }} />
                  <span className="ld-dot" style={{ background: '#28c840' }} />
                </div>
                <span className="ld-card-label">rack · pipeline run · 3 matches</span>
                <span className="ld-card-status">
                  <span className="ld-status-dot" aria-hidden="true" />
                  live
                </span>
              </div>

              {/* Pipeline steps */}
              <div className="ld-pipeline">
                {[
                  { step: 'JD input', detail: 'Software Engineer' },
                  { step: 'pgvector', detail: 'Phase 1 similarity' },
                  { step: 'GPT-4o-mini', detail: 'Phase 2 scoring' },
                  { step: 'Ranked', detail: 'Top matches', accent: true },
                ].map((s, i) => (
                  <div key={i} className="ld-pipeline-row">
                    <div className={`ld-pipeline-chip${s.accent ? ' accent' : ''}`}>
                      <span className="ld-chip-step">{s.step}</span>
                      <span className="ld-chip-detail">{s.detail}</span>
                    </div>
                    {i < 3 && <div className="ld-pipe-arrow" aria-hidden="true">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
                    </div>}
                  </div>
                ))}
              </div>

              {/* Match results */}
              <div className="ld-results">
                {[
                  { rank: 1, name: 'resume_swe_ic.pdf',      role: '4 yrs · Full-stack',  score: 92, color: '#16a34a' },
                  { rank: 2, name: 'resume_pm_adjacent.pdf', role: '3 yrs · Backend',      score: 78, color: '#2563eb' },
                  { rank: 3, name: 'resume_ml_focused.pdf',  role: '2 yrs · ML Engineer', score: 65, color: '#9333ea' },
                ].map(({ rank, name, role, score, color }, i) => (
                  <div
                    key={rank}
                    className="ld-result-row"
                    style={{ animation: `ldSlideIn 0.5s ${1.4 + i * 0.15}s both` }}
                  >
                    <span className="ld-result-rank">#{rank}</span>
                    <div className="ld-result-meta">
                      <span className="ld-result-name">{name}</span>
                      <span className="ld-result-role">{role}</span>
                    </div>
                    <div className="ld-result-bar-wrap">
                      <div className="ld-result-bar" style={{ '--score': `${score}%`, '--color': color }} />
                    </div>
                    <span className="ld-result-score" style={{ color }}>{score}%</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* ── MARQUEE ── */}
        <div className="ld-marquee" aria-hidden="true">
          <div className="ld-marquee-inner">
            {[...COMPANIES, ...COMPANIES].map((c, i) => (
              <span key={i} className="ld-marquee-item">
                <span className="ld-marquee-dot" />
                {c}
              </span>
            ))}
          </div>
        </div>

        {/* ── STATS ── */}
        <div className="ld-stats">
          {[
            { value: '150+', label: 'Company job boards' },
            { value: '2×',   label: 'AI scoring phases' },
            { value: '6×',   label: 'Daily fetch runs' },
            { value: '5',    label: 'Resume versions supported' },
          ].map(({ value, label }, i) => (
            <Reveal key={label} delay={i * 0.08}>
              <div className="ld-stat">
                <span className="ld-stat-val">{value}</span>
                <span className="ld-stat-label">{label}</span>
              </div>
            </Reveal>
          ))}
        </div>

        {/* ── HOW IT WORKS ── */}
        <section id="ld-how" className="ld-section">
          <Reveal>
            <div className="ld-section-eyebrow">Process</div>
            <h2 className="ld-section-h2">Three steps to your next job</h2>
            <p className="ld-section-sub">Rack runs the full pipeline daily — no manual searching, no daily login.</p>
          </Reveal>

          <div className="ld-steps">
            {[
              {
                n: '01',
                title: 'Upload your resume',
                desc: 'Drop up to 5 tailored versions. Each is chunked into vectors and stored. Rack automatically routes the best-fit version to each application.',
                icon: (
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                    <polyline points="14 2 14 8 20 8"/>
                    <line x1="12" y1="18" x2="12" y2="12"/>
                    <line x1="9" y1="15" x2="15" y2="15"/>
                  </svg>
                ),
              },
              {
                n: '02',
                title: 'We scan while you sleep',
                desc: 'Six times a day, Rack fetches fresh postings from 150+ Greenhouse, Ashby, and Lever boards. Every job gets vector-scored. Only top matches move to GPT-4o-mini scoring.',
                icon: (
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
                  </svg>
                ),
              },
              {
                n: '03',
                title: 'See ranked matches, apply in one click',
                desc: 'Wake up to a sorted list scored on skills fit, experience alignment, and career trajectory. Click to apply manually — or let Rack auto-apply via its Steel browser agent.',
                icon: (
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
                  </svg>
                ),
              },
            ].map(({ n, title, desc, icon }, i) => (
              <Reveal key={n} delay={i * 0.1}>
                <div className="ld-step">
                  <div className="ld-step-num">{n}</div>
                  <div className="ld-step-icon">{icon}</div>
                  <h3 className="ld-step-title">{title}</h3>
                  <p className="ld-step-desc">{desc}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </section>

        {/* ── FEATURES ── */}
        <section id="ld-features" className="ld-section ld-section-alt">
          <Reveal>
            <div className="ld-section-eyebrow">Intelligence</div>
            <h2 className="ld-section-h2">Built for serious candidates</h2>
            <p className="ld-section-sub">Not a job board. A full AI matching and application engine.</p>
          </Reveal>

          <div className="ld-bento">
            {/* Wide — company coverage */}
            <Reveal delay={0.05} className="ld-bento-wide">
              <div className="ld-bento-card ld-bento-coverage">
                <div>
                  <div className="ld-bento-eyebrow">Coverage</div>
                  <h3 className="ld-bento-title">150+ company boards, one inbox</h3>
                  <p className="ld-bento-desc">Direct Greenhouse, Ashby, and Lever integrations — plus YC batch auto-discovery. No middlemen, no delays.</p>
                </div>
                <div className="ld-company-grid">
                  {COMPANIES.slice(0, 12).map((c) => (
                    <span key={c} className="ld-company-chip">{c}</span>
                  ))}
                  <span className="ld-company-chip ld-chip-more">+{COMPANIES.length - 12} more</span>
                </div>
              </div>
            </Reveal>

            {/* Scoring */}
            <Reveal delay={0.1} className="ld-bento-half">
              <div className="ld-bento-card">
                <div className="ld-bento-eyebrow">Scoring</div>
                <h3 className="ld-bento-title">Two-phase AI scoring</h3>
                <p className="ld-bento-desc">pgvector narrows the pool. GPT-4o-mini scores each match on three dimensions against your actual resume text.</p>
                <ScoreWidget />
              </div>
            </Reveal>

            {/* Multi-resume */}
            <Reveal delay={0.15} className="ld-bento-half">
              <div className="ld-bento-card">
                <div className="ld-bento-eyebrow">Multi-resume</div>
                <h3 className="ld-bento-title">Right version, every time</h3>
                <p className="ld-bento-desc">Upload up to 5 variants. Rack picks the best-matching version per job automatically.</p>
                <div className="ld-resume-list">
                  {[
                    { name: 'resume_swe_ic.pdf',      tag: 'Best fit', active: true },
                    { name: 'resume_pm_adjacent.pdf', tag: '2nd',      active: false },
                    { name: 'resume_ml_focused.pdf',  tag: '3rd',      active: false },
                  ].map(({ name, tag, active }) => (
                    <div key={name} className={`ld-resume-item${active ? ' active' : ''}`}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                      <span className="ld-resume-name">{name}</span>
                      <span className={`ld-resume-tag${active ? ' active' : ''}`}>{tag}</span>
                    </div>
                  ))}
                </div>
              </div>
            </Reveal>

            {/* Tracking */}
            <Reveal delay={0.08} className="ld-bento-third">
              <div className="ld-bento-card">
                <div className="ld-bento-eyebrow">Tracking</div>
                <h3 className="ld-bento-title">Full-funnel pipeline board</h3>
                <p className="ld-bento-desc">Star roles, mark applied, track to offer. Nothing falls through a spreadsheet.</p>
              </div>
            </Reveal>

            {/* Auto-apply */}
            <Reveal delay={0.12} className="ld-bento-third">
              <div className="ld-bento-card">
                <div className="ld-bento-eyebrow">Automation</div>
                <h3 className="ld-bento-title">Browser-level auto-apply</h3>
                <p className="ld-bento-desc">A Steel-powered agent fills Greenhouse, Ashby, and Lever forms — accurately, not with brittle selectors.</p>
              </div>
            </Reveal>

            {/* Voice */}
            <Reveal delay={0.16} className="ld-bento-third">
              <div className="ld-bento-card">
                <div className="ld-bento-eyebrow">Onboarding</div>
                <h3 className="ld-bento-title">Voice-first setup in 2 minutes</h3>
                <p className="ld-bento-desc">Just talk. Rack's AI extracts your profile, preferences, and target roles from the conversation.</p>
              </div>
            </Reveal>
          </div>
        </section>

        {/* ── AUTO-APPLY SECTION ── */}
        <section id="ld-apply" className="ld-apply-section">
          <div className="ld-apply-inner">
            <Reveal className="ld-apply-copy">
              <div className="ld-section-eyebrow">Automation</div>
              <h2 className="ld-section-h2" style={{ maxWidth: 480 }}>Apply while you sleep</h2>
              <p className="ld-section-sub">
                Rack's Steel browser agent fills out and submits applications on Greenhouse,
                Ashby, and Lever — no brittle scripts, no missed fields.
              </p>
              <ul className="ld-checklist">
                {[
                  'Reads actual form fields at runtime — adapts to any layout',
                  'Uploads the best-fit resume version per application',
                  'Handles EEO fields, work auth, custom dropdowns',
                  'You review and approve before anything goes out',
                ].map((item) => (
                  <li key={item}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </Reveal>

            <Reveal delay={0.15} className="ld-apply-visual">
              <div className="ld-terminal">
                <div className="ld-terminal-header">
                  <div className="ld-dots">
                    <span className="ld-dot" style={{ background: '#ff5f57' }} />
                    <span className="ld-dot" style={{ background: '#ffbd2e' }} />
                    <span className="ld-dot" style={{ background: '#28c840' }} />
                  </div>
                  <span className="ld-terminal-title">steel agent · Anthropic · Software Engineer</span>
                  <span className="ld-live-badge">
                    <span className="ld-live-dot" aria-hidden="true" />
                    live
                  </span>
                </div>
                <div className="ld-terminal-body">
                  {[
                    { t: '12:04:01', sym: '→', cls: 'sym-blue',   msg: 'Opening Greenhouse form...' },
                    { t: '12:04:02', sym: '✓', cls: 'sym-green',  msg: 'Page loaded · anthropic.com/jobs' },
                    { t: '12:04:03', sym: '→', cls: 'sym-blue',   msg: 'Selecting resume variant #1' },
                    { t: '12:04:04', sym: '↑', cls: 'sym-purple', msg: 'Uploading resume_swe_ic.pdf' },
                    { t: '12:04:05', sym: '✓', cls: 'sym-green',  msg: 'Resume uploaded successfully' },
                    { t: '12:04:06', sym: '→', cls: 'sym-blue',   msg: 'Filling name · email · LinkedIn' },
                    { t: '12:04:08', sym: '→', cls: 'sym-blue',   msg: 'Handling EEO + work authorization' },
                    { t: '12:04:09', sym: '✓', cls: 'sym-green',  msg: 'All 14 fields complete' },
                  ].map(({ t, sym, cls, msg }) => (
                    <div key={t} className="ld-log-row">
                      <span className="ld-log-time">{t}</span>
                      <span className={`ld-log-sym ${cls}`}>{sym}</span>
                      <span className="ld-log-msg">{msg}</span>
                    </div>
                  ))}
                  <div className="ld-log-row">
                    <span className="ld-log-time">12:04:10</span>
                    <span className="ld-log-sym sym-blue">→</span>
                    <span className="ld-log-msg">Submitting application<span className="ld-cursor" aria-hidden="true" /></span>
                  </div>
                </div>
              </div>
            </Reveal>
          </div>
        </section>

        {/* ── CTA ── */}
        <section className="ld-cta-section">
          <Reveal>
            <div className="ld-cta-inner">
              <div className="ld-cta-eyebrow">Early access</div>
              <h2 className="ld-cta-h2">
                Stop applying.<br />
                <span className="ld-gradient-text">Start matching.</span>
              </h2>
              <p className="ld-cta-sub">
                Join early users already getting matched to roles at Anthropic, Stripe, Figma, and 150+ companies — every single day.
              </p>
              <div className="ld-cta-actions">
                <button className="ld-btn-primary ld-btn-large" onClick={openModal}>
                  Get started for free
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
                </button>
                {onSkip && (
                  <button className="ld-btn-text ld-btn-skip" onClick={onSkip}>
                    Continue without signing in
                  </button>
                )}
              </div>
              <p className="ld-cta-note">Free during beta · Built by <a href="https://tejasbk.dev" target="_blank" rel="noopener noreferrer" className="ld-link">Tejas</a></p>
            </div>
          </Reveal>
        </section>

        {/* ── FOOTER ── */}
        <footer className="ld-footer">
          <div className="ld-footer-logo">
            <span className="ld-wordmark">rack</span>
            <span className="ld-footer-domain">rackx.app</span>
          </div>
          <p className="ld-footer-copy">Scanning jobs so you don't have to.</p>
        </footer>

      </div>{/* ld-page */}

      {/* ── MODAL ── */}
      {modalOpen && (
        <div
          className="ld-modal-backdrop"
          onClick={(e) => { if (e.target === e.currentTarget) closeModal() }}
          role="dialog"
          aria-modal="true"
          aria-label="Sign in to Rack"
        >
          <div className="ld-modal">
            <button className="ld-modal-close" onClick={closeModal} aria-label="Close">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
            <div className="ld-modal-logo">rack</div>
            <h2 className="ld-modal-title">Sign in to Rack</h2>
            <p className="ld-modal-sub">Access your matched jobs, resume vault, and full application pipeline.</p>
            <button className="ld-btn-google" onClick={handleSignIn}>
              <GoogleIcon />
              Continue with Google
            </button>
            <p className="ld-modal-note">Your email and resume data only — nothing sold or shared.</p>
          </div>
        </div>
      )}
    </>
  )
}

// ── Styles ───────────────────────────────────────────────────────────────────
const CSS = `
  /* ── Fonts ── */
  @import url('https://fonts.googleapis.com/css2?family=Geist:wght@300;400;500;600;700;800&family=Geist+Mono:wght@400;500&display=swap');

  :root {
    --ld-sans: 'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    --ld-mono: 'Geist Mono', 'SF Mono', 'Fira Code', monospace;
    --ld-ink:    #0a0a0b;
    --ld-ink-2:  #374151;
    --ld-ink-3:  #6b7280;
    --ld-ink-4:  #9ca3af;
    --ld-bg:     #ffffff;
    --ld-bg-2:   #f9fafb;
    --ld-bg-3:   #f3f4f6;
    --ld-border: rgba(0,0,0,0.08);
    --ld-border-strong: rgba(0,0,0,0.13);
    --ld-accent: #16a34a;
    --ld-radius: 14px;
  }

  /* ── Page container — fixed inset, own scroll context ── */
  .ld-page {
    position: fixed;
    inset: 0;
    overflow-y: auto;
    overflow-x: hidden;
    background: var(--ld-bg);
    font-family: var(--ld-sans);
    color: var(--ld-ink);
    -webkit-font-smoothing: antialiased;
    scroll-behavior: smooth;
    z-index: 900;
  }

  /* ── Nav ── */
  .ld-nav {
    position: sticky;
    top: 0;
    z-index: 200;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 40px;
    height: 64px;
    backdrop-filter: blur(16px);
    -webkit-backdrop-filter: blur(16px);
    border-bottom: 1px solid var(--ld-border);
    transition: background 0.2s, box-shadow 0.2s;
  }
  .ld-wordmark {
    font-family: var(--ld-sans);
    font-weight: 800;
    font-size: 20px;
    letter-spacing: -0.04em;
    color: var(--ld-ink);
    line-height: 1;
  }
  .ld-nav-links {
    display: flex;
    align-items: center;
    gap: 28px;
    list-style: none;
    margin: 0; padding: 0;
  }
  .ld-nav-links button {
    background: none;
    border: none;
    padding: 0;
    font-family: var(--ld-sans);
    font-size: 14px;
    font-weight: 450;
    color: var(--ld-ink-3);
    cursor: pointer;
    transition: color 0.15s;
  }
  .ld-nav-links button:hover { color: var(--ld-ink); }
  .ld-nav-actions { display: flex; align-items: center; gap: 10px; }
  .ld-btn-text {
    background: none; border: none;
    font-family: var(--ld-sans); font-size: 14px; font-weight: 500;
    color: var(--ld-ink-3); cursor: pointer;
    padding: 8px 14px; border-radius: 8px;
    transition: color 0.15s, background 0.15s;
  }
  .ld-btn-text:hover { color: var(--ld-ink); background: var(--ld-bg-3); }
  .ld-btn-pill {
    background: var(--ld-ink);
    color: #fff;
    border: none;
    font-family: var(--ld-sans);
    font-size: 14px;
    font-weight: 600;
    padding: 9px 20px;
    border-radius: 99px;
    cursor: pointer;
    transition: background 0.15s, transform 0.15s, box-shadow 0.15s;
    letter-spacing: -0.01em;
  }
  .ld-btn-pill:hover {
    background: #1f2937;
    box-shadow: 0 4px 16px rgba(0,0,0,0.18);
    transform: translateY(-1px);
  }

  /* ── Hero ── */
  .ld-hero {
    position: relative;
    min-height: calc(100svh - 64px);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 80px 24px 60px;
    overflow: hidden;
    text-align: center;
  }
  .ld-hero-grid {
    position: absolute;
    inset: 0;
    background-image:
      linear-gradient(rgba(0,0,0,0.04) 1px, transparent 1px),
      linear-gradient(90deg, rgba(0,0,0,0.04) 1px, transparent 1px);
    background-size: 60px 60px;
    mask-image: radial-gradient(ellipse 80% 70% at 50% 40%, black 30%, transparent 80%);
    -webkit-mask-image: radial-gradient(ellipse 80% 70% at 50% 40%, black 30%, transparent 80%);
  }
  .ld-hero-glow {
    position: absolute;
    top: -120px; left: 50%;
    transform: translateX(-50%);
    width: 700px; height: 500px;
    background: radial-gradient(ellipse at center, rgba(22,163,74,0.08) 0%, transparent 70%);
    pointer-events: none;
  }
  .ld-hero-inner {
    position: relative;
    z-index: 2;
    display: flex;
    flex-direction: column;
    align-items: center;
    max-width: 900px;
    width: 100%;
  }

  /* Badge */
  .ld-badge {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    background: #f0fdf4;
    border: 1px solid #bbf7d0;
    color: #15803d;
    font-size: 13px;
    font-weight: 500;
    padding: 6px 14px 6px 10px;
    border-radius: 99px;
    margin-bottom: 36px;
    letter-spacing: -0.01em;
  }
  .ld-badge-pulse {
    width: 7px; height: 7px;
    background: #16a34a;
    border-radius: 50%;
    animation: ldPulse 2s ease-in-out infinite;
    flex-shrink: 0;
  }
  @keyframes ldPulse {
    0%,100% { box-shadow: 0 0 0 0 rgba(22,163,74,0.4); }
    50%      { box-shadow: 0 0 0 5px rgba(22,163,74,0); }
  }

  /* Headline */
  .ld-hero-h1 {
    font-family: var(--ld-sans);
    font-weight: 800;
    font-size: clamp(48px, 7.5vw, 88px);
    line-height: 1.0;
    letter-spacing: -0.04em;
    color: var(--ld-ink);
    margin: 0 0 24px;
    max-width: 800px;
  }
  .ld-gradient-text {
    background: linear-gradient(135deg, #16a34a 0%, #059669 40%, #0d9488 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
  }
  .ld-hero-sub {
    font-size: clamp(16px, 2.2vw, 19px);
    line-height: 1.65;
    color: var(--ld-ink-3);
    max-width: 520px;
    margin: 0 0 36px;
    font-weight: 400;
  }

  /* CTAs */
  .ld-hero-ctas {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    justify-content: center;
    margin-bottom: 20px;
  }
  .ld-btn-primary {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    background: var(--ld-ink);
    color: #fff;
    border: none;
    font-family: var(--ld-sans);
    font-size: 15px;
    font-weight: 600;
    padding: 13px 28px;
    border-radius: 99px;
    cursor: pointer;
    transition: background 0.15s, transform 0.15s, box-shadow 0.15s;
    letter-spacing: -0.01em;
  }
  .ld-btn-primary:hover {
    background: #111827;
    box-shadow: 0 6px 24px rgba(0,0,0,0.22);
    transform: translateY(-2px);
  }
  .ld-btn-large { padding: 16px 36px; font-size: 16px; }
  .ld-btn-ghost {
    background: none;
    border: 1px solid var(--ld-border-strong);
    color: var(--ld-ink-2);
    font-family: var(--ld-sans);
    font-size: 15px;
    font-weight: 500;
    padding: 13px 26px;
    border-radius: 99px;
    cursor: pointer;
    transition: all 0.15s;
  }
  .ld-btn-ghost:hover { border-color: rgba(0,0,0,0.25); color: var(--ld-ink); background: var(--ld-bg-3); }
  .ld-hero-note {
    font-size: 13px;
    color: var(--ld-ink-4);
    margin: 0 0 56px;
  }

  /* Product card */
  .ld-hero-card {
    width: 100%;
    max-width: 760px;
    background: #fff;
    border: 1px solid var(--ld-border-strong);
    border-radius: 20px;
    overflow: hidden;
    box-shadow:
      0 0 0 1px rgba(0,0,0,0.04),
      0 8px 32px rgba(0,0,0,0.07),
      0 40px 80px rgba(0,0,0,0.06);
  }
  .ld-card-top-bar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 20px;
    border-bottom: 1px solid var(--ld-border);
    background: var(--ld-bg-2);
  }
  .ld-dots { display: flex; gap: 6px; }
  .ld-dot { width: 10px; height: 10px; border-radius: 50%; }
  .ld-card-label {
    font-family: var(--ld-mono);
    font-size: 12px;
    color: var(--ld-ink-4);
    margin-left: 4px;
    flex: 1;
    text-align: center;
  }
  .ld-card-status {
    display: flex;
    align-items: center;
    gap: 5px;
    font-family: var(--ld-mono);
    font-size: 11px;
    color: var(--ld-accent);
  }
  .ld-status-dot {
    width: 6px; height: 6px;
    background: var(--ld-accent);
    border-radius: 50%;
    animation: ldPulse 2s ease-in-out infinite;
  }

  /* Pipeline */
  .ld-pipeline {
    display: flex;
    align-items: center;
    gap: 0;
    padding: 20px 24px 16px;
    border-bottom: 1px solid var(--ld-border);
    overflow-x: auto;
  }
  .ld-pipeline-row { display: flex; align-items: center; gap: 0; }
  .ld-pipeline-chip {
    padding: 8px 14px;
    background: var(--ld-bg-2);
    border: 1px solid var(--ld-border);
    border-radius: 8px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    white-space: nowrap;
  }
  .ld-pipeline-chip.accent {
    background: #f0fdf4;
    border-color: #bbf7d0;
  }
  .ld-chip-step {
    font-family: var(--ld-mono);
    font-size: 10px;
    color: var(--ld-ink-4);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .ld-chip-detail {
    font-size: 13px;
    font-weight: 600;
    color: var(--ld-ink);
    letter-spacing: -0.01em;
  }
  .ld-pipeline-chip.accent .ld-chip-detail { color: var(--ld-accent); }
  .ld-pipe-arrow {
    color: var(--ld-ink-4);
    padding: 0 8px;
    flex-shrink: 0;
  }

  /* Results */
  .ld-results {
    display: flex;
    flex-direction: column;
    gap: 0;
    padding: 12px 16px 16px;
  }
  .ld-result-row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 8px;
    border-radius: 8px;
    transition: background 0.15s;
  }
  .ld-result-row:hover { background: var(--ld-bg-2); }
  .ld-result-rank {
    font-family: var(--ld-mono);
    font-size: 12px;
    color: var(--ld-ink-4);
    width: 24px;
    flex-shrink: 0;
  }
  .ld-result-meta { flex: 1; min-width: 0; }
  .ld-result-name {
    display: block;
    font-size: 13px;
    font-weight: 500;
    color: var(--ld-ink);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .ld-result-role {
    display: block;
    font-size: 12px;
    color: var(--ld-ink-4);
    margin-top: 1px;
  }
  .ld-result-bar-wrap {
    width: 80px;
    height: 4px;
    background: var(--ld-bg-3);
    border-radius: 99px;
    overflow: hidden;
    flex-shrink: 0;
  }
  .ld-result-bar {
    height: 100%;
    width: var(--score, 0%);
    background: var(--color, #16a34a);
    border-radius: 99px;
    animation: ldBarFill 1s cubic-bezier(0.16,1,0.3,1) both;
  }
  .ld-result-bar:nth-child(1) { animation-delay: 1.5s; }
  .ld-result-score {
    font-family: var(--ld-mono);
    font-size: 14px;
    font-weight: 700;
    width: 38px;
    text-align: right;
    flex-shrink: 0;
  }

  /* ── Marquee ── */
  .ld-marquee {
    overflow: hidden;
    border-top: 1px solid var(--ld-border);
    border-bottom: 1px solid var(--ld-border);
    background: var(--ld-bg-2);
    padding: 16px 0;
  }
  .ld-marquee-inner {
    display: flex;
    gap: 0;
    width: max-content;
    animation: ldMarquee 35s linear infinite;
  }
  .ld-marquee-item {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 0 32px;
    font-family: var(--ld-mono);
    font-size: 12px;
    color: var(--ld-ink-4);
    white-space: nowrap;
    border-right: 1px solid var(--ld-border);
  }
  .ld-marquee-dot {
    width: 4px; height: 4px;
    background: var(--ld-ink-4);
    border-radius: 50%;
    opacity: 0.4;
  }

  /* ── Stats ── */
  .ld-stats {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    border-bottom: 1px solid var(--ld-border);
  }
  .ld-stat {
    padding: 36px 32px;
    border-right: 1px solid var(--ld-border);
    text-align: center;
  }
  .ld-stat:last-child { border-right: none; }
  .ld-stat-val {
    display: block;
    font-family: var(--ld-sans);
    font-weight: 800;
    font-size: 36px;
    letter-spacing: -0.04em;
    color: var(--ld-ink);
    line-height: 1;
  }
  .ld-stat-label {
    display: block;
    font-size: 13px;
    color: var(--ld-ink-4);
    margin-top: 6px;
    font-weight: 400;
  }

  /* ── Sections ── */
  .ld-section {
    max-width: 1140px;
    margin: 0 auto;
    padding: 100px 48px;
  }
  .ld-section-alt {
    max-width: 100%;
    background: var(--ld-bg-2);
    border-top: 1px solid var(--ld-border);
    border-bottom: 1px solid var(--ld-border);
    padding: 0;
  }
  .ld-section-alt > * {
    max-width: 1140px;
    margin: 0 auto;
    padding: 100px 48px;
  }
  .ld-section-alt > div:first-child { padding-bottom: 0; }
  .ld-section-eyebrow {
    font-family: var(--ld-mono);
    font-size: 12px;
    font-weight: 500;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--ld-accent);
    margin-bottom: 16px;
  }
  .ld-section-h2 {
    font-family: var(--ld-sans);
    font-weight: 800;
    font-size: clamp(32px, 4vw, 48px);
    letter-spacing: -0.035em;
    line-height: 1.1;
    color: var(--ld-ink);
    margin: 0 0 16px;
  }
  .ld-section-sub {
    font-size: 17px;
    line-height: 1.65;
    color: var(--ld-ink-3);
    max-width: 500px;
    font-weight: 400;
    margin: 0;
  }

  /* ── Steps ── */
  .ld-steps {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 2px;
    margin-top: 60px;
    background: var(--ld-border);
    border-radius: 16px;
    overflow: hidden;
  }
  .ld-step {
    background: var(--ld-bg);
    padding: 36px 32px 40px;
    transition: background 0.2s;
  }
  .ld-step:hover { background: var(--ld-bg-2); }
  .ld-step-num {
    font-family: var(--ld-mono);
    font-size: 11px;
    color: var(--ld-accent);
    font-weight: 600;
    letter-spacing: 0.1em;
    margin-bottom: 20px;
  }
  .ld-step-icon {
    color: var(--ld-ink);
    margin-bottom: 16px;
    opacity: 0.75;
  }
  .ld-step-title {
    font-family: var(--ld-sans);
    font-weight: 700;
    font-size: 18px;
    letter-spacing: -0.02em;
    color: var(--ld-ink);
    margin: 0 0 10px;
    line-height: 1.25;
  }
  .ld-step-desc {
    font-size: 14px;
    line-height: 1.7;
    color: var(--ld-ink-3);
    margin: 0;
  }

  /* ── Bento ── */
  .ld-bento {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    grid-template-rows: auto auto auto;
    gap: 2px;
    background: var(--ld-border);
    border-radius: 0;
    overflow: hidden;
    margin-top: 60px;
    border-top: 1px solid var(--ld-border);
  }
  .ld-bento-wide { grid-column: 1 / -1; }
  .ld-bento-half { grid-column: span 1; }
  /* Make first two halves span equally */
  .ld-bento > .ld-bento-half:nth-child(2) { }
  .ld-bento > .ld-bento-half:nth-child(3) { }
  .ld-bento-third { grid-column: span 1; }
  .ld-bento-card {
    background: var(--ld-bg);
    padding: 36px 32px;
    transition: background 0.2s;
  }
  .ld-bento-card:hover { background: #fafafa; }
  .ld-bento-coverage {
    display: flex;
    gap: 48px;
    align-items: flex-start;
    flex-wrap: wrap;
  }
  .ld-bento-eyebrow {
    font-family: var(--ld-mono);
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--ld-ink-4);
    margin-bottom: 10px;
  }
  .ld-bento-title {
    font-family: var(--ld-sans);
    font-weight: 700;
    font-size: 20px;
    letter-spacing: -0.025em;
    color: var(--ld-ink);
    margin: 0 0 10px;
    line-height: 1.25;
  }
  .ld-bento-desc {
    font-size: 14px;
    line-height: 1.7;
    color: var(--ld-ink-3);
    margin: 0;
    max-width: 340px;
  }
  .ld-company-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-content: flex-start;
    flex: 1;
    min-width: 280px;
  }
  .ld-company-chip {
    background: var(--ld-bg-2);
    border: 1px solid var(--ld-border-strong);
    border-radius: 6px;
    padding: 5px 12px;
    font-family: var(--ld-mono);
    font-size: 12px;
    color: var(--ld-ink-3);
    transition: all 0.15s;
    white-space: nowrap;
  }
  .ld-company-chip:hover { border-color: rgba(22,163,74,0.4); color: var(--ld-accent); background: #f0fdf4; }
  .ld-chip-more { color: var(--ld-ink-4); }

  /* Resume list in bento */
  .ld-resume-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 20px;
  }
  .ld-resume-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 12px;
    background: var(--ld-bg-2);
    border: 1px solid var(--ld-border);
    border-radius: 8px;
    transition: border-color 0.15s;
    color: var(--ld-ink-3);
  }
  .ld-resume-item.active { border-color: #bbf7d0; background: #f0fdf4; color: var(--ld-ink); }
  .ld-resume-name {
    flex: 1;
    font-family: var(--ld-mono);
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ld-resume-tag {
    font-family: var(--ld-mono);
    font-size: 11px;
    color: var(--ld-ink-4);
    flex-shrink: 0;
  }
  .ld-resume-tag.active { color: var(--ld-accent); font-weight: 600; }

  /* ── Auto-apply section ── */
  .ld-apply-section {
    background: var(--ld-ink);
    color: #fff;
  }
  .ld-apply-inner {
    max-width: 1140px;
    margin: 0 auto;
    padding: 100px 48px;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 80px;
    align-items: center;
  }
  .ld-apply-section .ld-section-eyebrow { color: #4ade80; }
  .ld-apply-section .ld-section-h2 { color: #fff; max-width: 420px; }
  .ld-apply-section .ld-section-sub { color: rgba(255,255,255,0.6); }
  .ld-checklist {
    list-style: none;
    margin: 28px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .ld-checklist li {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    font-size: 15px;
    color: rgba(255,255,255,0.75);
    line-height: 1.5;
  }
  .ld-checklist svg { flex-shrink: 0; margin-top: 2px; }
  .ld-apply-visual { width: 100%; }

  /* Terminal */
  .ld-terminal {
    background: #0f1117;
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 16px;
    overflow: hidden;
    box-shadow: 0 32px 80px rgba(0,0,0,0.5);
  }
  .ld-terminal-header {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 18px;
    border-bottom: 1px solid rgba(255,255,255,0.07);
    background: rgba(255,255,255,0.03);
  }
  .ld-terminal-title {
    font-family: var(--ld-mono);
    font-size: 12px;
    color: rgba(255,255,255,0.35);
    flex: 1;
    text-align: center;
    margin: 0 4px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ld-live-badge {
    display: flex;
    align-items: center;
    gap: 5px;
    font-family: var(--ld-mono);
    font-size: 11px;
    color: #4ade80;
  }
  .ld-live-dot {
    width: 6px; height: 6px;
    background: #4ade80;
    border-radius: 50%;
    animation: ldPulse 2s ease-in-out infinite;
  }
  .ld-terminal-body {
    padding: 20px 22px 24px;
    display: flex;
    flex-direction: column;
    gap: 0;
  }
  .ld-log-row {
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 5px 0;
    border-bottom: 1px solid rgba(255,255,255,0.03);
  }
  .ld-log-row:last-child { border-bottom: none; }
  .ld-log-time {
    font-family: var(--ld-mono);
    font-size: 11px;
    color: rgba(255,255,255,0.2);
    flex-shrink: 0;
    width: 64px;
  }
  .ld-log-sym {
    font-family: var(--ld-mono);
    font-size: 13px;
    flex-shrink: 0;
    width: 16px;
  }
  .sym-green  { color: #4ade80; }
  .sym-blue   { color: #60a5fa; }
  .sym-purple { color: #c084fc; }
  .ld-log-msg {
    font-family: var(--ld-mono);
    font-size: 13px;
    color: rgba(255,255,255,0.65);
    line-height: 1.4;
  }
  .ld-cursor {
    display: inline-block;
    width: 8px; height: 14px;
    background: #60a5fa;
    margin-left: 2px;
    vertical-align: middle;
    animation: ldBlink 1.1s step-end infinite;
  }

  /* ── CTA section ── */
  .ld-cta-section {
    padding: 0;
    background: #f9fafb;
    border-top: 1px solid var(--ld-border);
  }
  .ld-cta-inner {
    max-width: 680px;
    margin: 0 auto;
    padding: 120px 48px;
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
  }
  .ld-cta-eyebrow {
    font-family: var(--ld-mono);
    font-size: 12px;
    font-weight: 500;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--ld-accent);
    margin-bottom: 16px;
  }
  .ld-cta-h2 {
    font-family: var(--ld-sans);
    font-weight: 800;
    font-size: clamp(40px, 6vw, 64px);
    letter-spacing: -0.04em;
    line-height: 1.05;
    color: var(--ld-ink);
    margin: 0 0 20px;
  }
  .ld-cta-sub {
    font-size: 17px;
    line-height: 1.65;
    color: var(--ld-ink-3);
    max-width: 480px;
    margin: 0 0 44px;
    font-weight: 400;
  }
  .ld-cta-actions {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 16px;
  }
  .ld-btn-skip {
    color: var(--ld-ink-4) !important;
    font-size: 13px !important;
    padding: 4px 8px !important;
  }
  .ld-btn-skip:hover { color: var(--ld-ink-3) !important; }
  .ld-cta-note {
    margin-top: 20px;
    font-size: 13px;
    color: var(--ld-ink-4);
  }
  .ld-link {
    color: var(--ld-ink-3);
    text-decoration: none;
    transition: color 0.15s;
  }
  .ld-link:hover { color: var(--ld-ink); }

  /* ── Footer ── */
  .ld-footer {
    border-top: 1px solid var(--ld-border);
    padding: 32px 48px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    background: var(--ld-bg);
  }
  .ld-footer-logo {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .ld-footer-domain {
    font-family: var(--ld-mono);
    font-size: 12px;
    color: var(--ld-ink-4);
  }
  .ld-footer-copy {
    font-size: 13px;
    color: var(--ld-ink-4);
    margin: 0;
  }

  /* ── Modal ── */
  .ld-modal-backdrop {
    position: fixed;
    inset: 0;
    z-index: 1000;
    background: rgba(0,0,0,0.45);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    display: flex;
    align-items: center;
    justify-content: center;
    animation: ldFadeIn 0.2s ease;
  }
  .ld-modal {
    background: #fff;
    border: 1px solid var(--ld-border-strong);
    border-radius: 20px;
    padding: 48px 40px;
    max-width: 400px;
    width: 90%;
    text-align: center;
    position: relative;
    animation: ldModalIn 0.3s cubic-bezier(0.16,1,0.3,1);
    box-shadow: 0 32px 80px rgba(0,0,0,0.2);
  }
  .ld-modal-close {
    position: absolute;
    top: 16px; right: 16px;
    background: none;
    border: none;
    color: var(--ld-ink-4);
    cursor: pointer;
    padding: 6px;
    border-radius: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.15s;
  }
  .ld-modal-close:hover { color: var(--ld-ink); background: var(--ld-bg-3); }
  .ld-modal-logo {
    font-family: var(--ld-sans);
    font-weight: 800;
    font-size: 22px;
    letter-spacing: -0.04em;
    color: var(--ld-ink);
    margin-bottom: 20px;
  }
  .ld-modal-title {
    font-family: var(--ld-sans);
    font-weight: 700;
    font-size: 22px;
    letter-spacing: -0.03em;
    color: var(--ld-ink);
    margin: 0 0 10px;
  }
  .ld-modal-sub {
    font-size: 14px;
    line-height: 1.6;
    color: var(--ld-ink-3);
    margin: 0 0 28px;
  }
  .ld-btn-google {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    background: var(--ld-ink);
    color: #fff;
    border: none;
    font-family: var(--ld-sans);
    font-size: 15px;
    font-weight: 600;
    padding: 14px 24px;
    border-radius: 99px;
    cursor: pointer;
    transition: all 0.15s;
    letter-spacing: -0.01em;
  }
  .ld-btn-google:hover {
    background: #111827;
    box-shadow: 0 4px 20px rgba(0,0,0,0.18);
    transform: translateY(-1px);
  }
  .ld-modal-note {
    margin-top: 18px;
    font-size: 12px;
    color: var(--ld-ink-4);
    line-height: 1.5;
  }

  /* ── Keyframes ── */
  @keyframes ldFadeUp {
    from { opacity: 0; transform: translateY(20px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  @keyframes ldFadeIn {
    from { opacity: 0; }
    to   { opacity: 1; }
  }
  @keyframes ldModalIn {
    from { opacity: 0; transform: translateY(16px) scale(0.98); }
    to   { opacity: 1; transform: translateY(0) scale(1); }
  }
  @keyframes ldSlideIn {
    from { opacity: 0; transform: translateX(-8px); }
    to   { opacity: 1; transform: translateX(0); }
  }
  @keyframes ldBarFill {
    from { width: 0; }
    to   { width: var(--score, 0%); }
  }
  @keyframes ldBlink {
    0%, 100% { opacity: 1; }
    50%       { opacity: 0; }
  }
  @keyframes ldMarquee {
    from { transform: translateX(0); }
    to   { transform: translateX(-50%); }
  }

  /* ── Responsive ── */
  @media (max-width: 960px) {
    .ld-nav { padding: 0 24px; }
    .ld-nav-links { display: none; }
    .ld-section { padding: 72px 24px; }
    .ld-steps { grid-template-columns: 1fr; }
    .ld-bento { grid-template-columns: 1fr; }
    .ld-bento-wide, .ld-bento-half, .ld-bento-third { grid-column: 1; }
    .ld-bento-coverage { flex-direction: column; gap: 24px; }
    .ld-stats { grid-template-columns: repeat(2,1fr); }
    .ld-stat:nth-child(2) { border-right: none; }
    .ld-apply-inner { grid-template-columns: 1fr; gap: 48px; padding: 72px 24px; }
    .ld-cta-inner { padding: 80px 24px; }
    .ld-footer { flex-direction: column; gap: 12px; text-align: center; padding: 28px 24px; }
    .ld-hero { padding: 60px 20px 40px; }
    .ld-pipeline { overflow-x: scroll; -webkit-overflow-scrolling: touch; }
    .ld-section-alt > * { padding: 72px 24px; }
    .ld-section-alt > div:first-child { padding-bottom: 0; }
  }

  @media (max-width: 600px) {
    .ld-stats { grid-template-columns: 1fr 1fr; }
    .ld-hero-card { border-radius: 14px; }
    .ld-bento { margin-top: 40px; }
    .ld-steps { margin-top: 40px; }
  }
`