import { useState, useEffect, useRef } from 'react'

// ── Companies for marquee / coverage ─────────────────────────────────────────
const COMPANIES = [
  'Anthropic', 'Stripe', 'Figma', 'Vercel', 'Datadog', 'Cloudflare',
  'MongoDB', 'Brex', 'Coinbase', 'Airtable', 'Temporal', 'Amplitude',
  'Together AI', 'Runway', 'Elastic', 'Twilio', 'Descript', 'Fivetran',
  'LaunchDarkly', 'Chime', 'Marqeta', 'Mercury', 'Robinhood',
  'CockroachLabs', 'Mixpanel', 'AssemblyAI',
]

// ── FAQ ───────────────────────────────────────────────────────────────────────
const FAQ = [
  {
    q: 'How is this different from a job board?',
    a: 'Rack never asks you to search. It scans 150+ company boards six times a day, scores every fresh posting against your actual resume text, and surfaces only the roles worth your time, already ranked.',
  },
  {
    q: 'What does the two-phase scoring actually do?',
    a: 'Phase one uses pgvector similarity to narrow thousands of postings to a shortlist in milliseconds. Phase two sends only that shortlist to our Rack AI, which scores each role on skills fit, experience alignment, and career trajectory against your resume.',
  },
  {
    q: 'Can I upload more than one resume?',
    a: 'Yes, up to five tailored versions. Rack automatically routes the best-matching variant to each application, so the SWE version goes to engineering roles and the PM-adjacent one goes elsewhere.',
  },
  {
    q: 'Is the auto-apply safe? Will it apply without me?',
    a: 'Never without your approval. The Steel browser agent fills Greenhouse, Ashby, and Lever forms, including EEO and work-authorization fields, then pauses for you to review before anything is submitted.',
  },
  {
    q: 'How do I get set up?',
    a: 'Just talk. Rack’s voice onboarding extracts your profile, preferences, and target roles from a two-minute conversation, no long forms to fill out.',
  },
]

// ── Scroll-triggered reveal hook ─────────────────────────────────────────────
function useInView(threshold = 0.15, once = true) {
  const ref = useRef(null)
  const [inView, setInView] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const obs = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) { setInView(true); if (once) obs.disconnect() }
        else if (!once) setInView(false)
      },
      { threshold, rootMargin: '0px 0px -40px 0px' }
    )
    obs.observe(el)
    // Safety net: never leave content hidden if the observer never fires
    const fallback = setTimeout(() => setInView(true), 900)
    return () => { obs.disconnect(); clearTimeout(fallback) }
  }, [threshold, once])
  return [ref, inView]
}

// ── Count-up animation ───────────────────────────────────────────────────────
function useCountUp(target, started, duration = 1200) {
  const [val, setVal] = useState(0)
  useEffect(() => {
    if (!started) return
    let raf, startTime = null
    const step = (ts) => {
      if (!startTime) startTime = ts
      const p = Math.min((ts - startTime) / duration, 1)
      const eased = 1 - Math.pow(1 - p, 3)
      setVal(eased * target)
      if (p < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    // Safety net: land on the final value even if rAF is throttled
    const fallback = setTimeout(() => setVal(target), duration + 400)
    return () => { cancelAnimationFrame(raf); clearTimeout(fallback) }
  }, [started, target, duration])
  return val
}

function fmt(n) { return Math.round(n).toLocaleString('en-US') }

// ── Reveal wrapper ───────────────────────────────────────────────────────────
function Reveal({ children, delay = 0, y = 28, className = '', style = {} }) {
  const [ref, inView] = useInView(0.08)
  return (
    <div
      ref={ref}
      className={className}
      style={{
        ...style,
        transform: inView ? 'translateY(0px)' : `translateY(${y}px)`,
        transition: inView
          ? `transform 0.9s cubic-bezier(0.16,1,0.3,1) ${delay}s`
          : 'none',
        willChange: 'transform',
      }}
    >
      {children}
    </div>
  )
}

// ── Section header ───────────────────────────────────────────────────────────
function SectionHead({ eyebrow, title, sub, light = false, center = false, maxTitle }) {
  return (
    <div className={`ld-head${center ? ' ld-head-center' : ''}${light ? ' ld-head-light' : ''}`}>
      <div className="ld-eyebrow">
        <span className="ld-eyebrow-tick" aria-hidden="true" />
        {eyebrow}
      </div>
      <h2 className="ld-h2" style={maxTitle ? { maxWidth: maxTitle } : undefined}>{title}</h2>
      {sub && <p className="ld-sub">{sub}</p>}
    </div>
  )
}

// ── Arrow glyph ──────────────────────────────────────────────────────────────
function Arrow({ size = 16, w = 2.4 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={w} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14M12 5l7 7-7 7" /></svg>
  )
}

// ── Score bars widget (two-phase scoring dimensions) ──────────────────────────
function ScoreBars() {
  const [ref, inView] = useInView(0.4)
  const sf = useCountUp(94, inView, 1000)
  const ex = useCountUp(81, inView, 1200)
  const tr = useCountUp(73, inView, 1400)
  const bars = [
    { label: 'Skills fit', val: sf, end: 94, color: 'var(--em)' },
    { label: 'Experience alignment', val: ex, end: 81, color: 'var(--teal)' },
    { label: 'Career trajectory', val: tr, end: 73, color: '#0891b2' },
  ]
  return (
    <div ref={ref} className="ld-scorebars">
      {bars.map(({ label, val, end, color }) => (
        <div key={label} className="ld-scorebar">
          <div className="ld-scorebar-top">
            <span className="ld-scorebar-label">{label}</span>
            <span className="ld-scorebar-val" style={{ color }}>{Math.round(val)}</span>
          </div>
          <div className="ld-scorebar-track">
            <div className="ld-scorebar-fill" style={{ width: `${val}%`, background: color }} />
          </div>
        </div>
      ))}
    </div>
  )
}

// ── HERO flow: Upload → Match → Apply ─────────────────────────────────────────
function HeroFlow() {
  const [ref, inView] = useInView(0.25)
  const matched = useCountUp(12, inView, 1400)
  return (
    <div ref={ref} className="ld-flow">
      <div className="ld-flow-bar">
        <div className="ld-dots">
          <span className="ld-dot" style={{ background: '#ff5f57' }} />
          <span className="ld-dot" style={{ background: '#febc2e' }} />
          <span className="ld-dot" style={{ background: '#28c840' }} />
        </div>
        <span className="ld-flow-title">rack · live pipeline</span>
        <span className="ld-flow-live"><span className="ld-live-dot" aria-hidden="true" />running</span>
      </div>

      <div className="ld-flow-grid">
        {/* Stage 1 — Upload */}
        <div className="ld-stage" style={{ animationDelay: '0.1s' }}>
          <div className="ld-stage-cap">01 · Resumes</div>
          {[
            { n: 'swe_ic.pdf', t: 'Best fit', on: true },
            { n: 'pm_adjacent.pdf', t: '', on: false },
            { n: 'ml_focused.pdf', t: '', on: false },
          ].map(({ n, t, on }) => (
            <div key={n} className={`ld-mini-file${on ? ' on' : ''}`}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></svg>
              <span className="ld-mini-file-n">{n}</span>
              {t && <span className="ld-mini-tag">{t}</span>}
            </div>
          ))}
        </div>

        <div className="ld-flow-conn" aria-hidden="true"><span className="ld-flow-pulse" /></div>

        {/* Stage 2 — Match engine */}
        <div className="ld-stage" style={{ animationDelay: '0.25s' }}>
          <div className="ld-stage-cap">02 · Match engine</div>
          <div className="ld-engine-badges">
            <span className="ld-engine-badge">pgvector</span>
            <span className="ld-engine-arrow"><Arrow size={11} w={2.6} /></span>
            <span className="ld-engine-badge accent">Rack AI</span>
          </div>
          <ScoreBars />
        </div>

        <div className="ld-flow-conn" aria-hidden="true"><span className="ld-flow-pulse" style={{ animationDelay: '0.6s' }} /></div>

        {/* Stage 3 — Ranked + apply */}
        <div className="ld-stage" style={{ animationDelay: '0.4s' }}>
          <div className="ld-stage-cap">03 · Ranked <span className="ld-stage-count">{fmt(matched)} matches</span></div>
          {[
            { r: 1, c: 'Anthropic', s: 94, st: 'applied' },
            { r: 2, c: 'Stripe', s: 88, st: 'applying' },
            { r: 3, c: 'Figma', s: 81, st: 'queued' },
          ].map(({ r, c, s, st }, i) => (
            <div key={c} className="ld-rank-row">
              <span className="ld-rank-n">#{r}</span>
              <span className="ld-rank-co">{c}</span>
              <span className="ld-rank-score">{s}</span>
              <span className={`ld-rank-st ld-st-${st}`}>{st}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Daily scan infographic ────────────────────────────────────────────────────
function ScanWidget() {
  const [ref, inView] = useInView(0.35)
  const postings = useCountUp(1284, inView, 1600)
  const tiles = COMPANIES.slice(0, 24)
  return (
    <div ref={ref} className="ld-card ld-scan">
      <div className="ld-scan-head">
        <div>
          <div className="ld-scan-count">{fmt(postings)}</div>
          <div className="ld-scan-count-l">new postings fetched today</div>
        </div>
        <div className="ld-cycle">
          <svg viewBox="0 0 44 44" width="44" height="44" aria-hidden="true">
            <circle cx="22" cy="22" r="18" fill="none" stroke="var(--line)" strokeWidth="3" />
            <circle cx="22" cy="22" r="18" fill="none" stroke="var(--em)" strokeWidth="3" strokeLinecap="round" strokeDasharray="113" strokeDashoffset={28} style={{ transform: 'rotate(-90deg)', transformOrigin: 'center' }} />
          </svg>
          <span className="ld-cycle-n">6×</span>
        </div>
      </div>
      <div className="ld-scan-grid">
        <span className="ld-scan-beam" aria-hidden="true" />
        {tiles.map((c, i) => (
          <span key={c} className="ld-scan-tile" style={{ animationDelay: `${(i % 6) * 0.12 + Math.floor(i / 6) * 0.05}s` }}>{c}</span>
        ))}
      </div>
      <div className="ld-scan-foot">
        <span><span className="ld-foot-dot" />Greenhouse</span>
        <span><span className="ld-foot-dot" />Ashby</span>
        <span><span className="ld-foot-dot" />Lever</span>
        <span className="ld-scan-foot-r">+ YC batch auto-discovery</span>
      </div>
    </div>
  )
}

// ── Two-phase scoring funnel ──────────────────────────────────────────────────
function FunnelWidget() {
  const [ref, inView] = useInView(0.4)
  const a = useCountUp(12480, inView, 1500)
  const b = useCountUp(240, inView, 1700)
  const c = useCountUp(12, inView, 1900)
  const rows = [
    { w: 100, label: 'Fresh postings', val: fmt(a), tag: 'all boards', tone: 'mute' },
    { w: 56, label: 'pgvector shortlist', val: fmt(b), tag: 'phase 1 · similarity', tone: 'teal' },
    { w: 24, label: 'Strong matches', val: fmt(c), tag: 'phase 2 · Rack AI', tone: 'em' },
  ]
  return (
    <div ref={ref} className="ld-card ld-funnel">
      {rows.map((r) => (
        <div key={r.label} className="ld-funnel-row">
          <div className="ld-funnel-track">
            <div className={`ld-funnel-bar tone-${r.tone}`} style={{ width: `${r.w}%` }}>
              <span className="ld-funnel-val">{r.val}</span>
            </div>
          </div>
          <div className="ld-funnel-meta">
            <span className="ld-funnel-label">{r.label}</span>
            <span className="ld-funnel-tag">{r.tag}</span>
          </div>
        </div>
      ))}
      <div className="ld-funnel-note">Only the shortlist hits the LLM, fast where it can be, smart where it counts.</div>
    </div>
  )
}

// ── Multi-resume router ───────────────────────────────────────────────────────
function RouterWidget() {
  const variants = [
    { n: 'swe_ic.pdf', on: true },
    { n: 'pm_adjacent.pdf', on: false },
    { n: 'ml_focused.pdf', on: false },
  ]
  return (
    <div className="ld-card ld-router">
      <div className="ld-router-col">
        {variants.map(({ n, on }) => (
          <div key={n} className={`ld-router-chip${on ? ' on' : ''}`}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></svg>
            {n}
          </div>
        ))}
      </div>
      <svg className="ld-router-wires" viewBox="0 0 120 160" preserveAspectRatio="none" aria-hidden="true">
        <path d="M0 26 C60 26 60 80 120 80" fill="none" stroke="var(--em)" strokeWidth="2" className="ld-wire on" />
        <path d="M0 80 C60 80 60 80 120 80" fill="none" stroke="var(--line-strong)" strokeWidth="1.5" className="ld-wire" />
        <path d="M0 134 C60 134 60 80 120 80" fill="none" stroke="var(--line-strong)" strokeWidth="1.5" className="ld-wire" />
      </svg>
      <div className="ld-router-job">
        <div className="ld-router-job-co">Anthropic</div>
        <div className="ld-router-job-role">Software Engineer, Product</div>
        <div className="ld-router-pick"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12" /></svg>routed swe_ic.pdf</div>
      </div>
    </div>
  )
}

// ── Auto-apply terminal ───────────────────────────────────────────────────────
function Terminal() {
  const lines = [
    { t: '12:04:01', sym: '→', cls: 'sym-blue', msg: 'Opening Greenhouse form…' },
    { t: '12:04:02', sym: '✓', cls: 'sym-green', msg: 'Page loaded · anthropic.com/jobs' },
    { t: '12:04:03', sym: '→', cls: 'sym-blue', msg: 'Selecting resume variant #1' },
    { t: '12:04:04', sym: '↑', cls: 'sym-teal', msg: 'Uploading resume_swe_ic.pdf' },
    { t: '12:04:05', sym: '✓', cls: 'sym-green', msg: 'Resume uploaded successfully' },
    { t: '12:04:06', sym: '→', cls: 'sym-blue', msg: 'Filling name · email · LinkedIn' },
    { t: '12:04:08', sym: '→', cls: 'sym-blue', msg: 'Handling EEO + work authorization' },
    { t: '12:04:09', sym: '✓', cls: 'sym-green', msg: 'All 14 fields complete' },
  ]
  return (
    <div className="ld-terminal">
      <div className="ld-terminal-head">
        <div className="ld-dots">
          <span className="ld-dot" style={{ background: '#ff5f57' }} />
          <span className="ld-dot" style={{ background: '#febc2e' }} />
          <span className="ld-dot" style={{ background: '#28c840' }} />
        </div>
        <span className="ld-terminal-t">steel agent · Anthropic · Software Engineer</span>
        <span className="ld-terminal-live"><span className="ld-live-dot" aria-hidden="true" />live</span>
      </div>
      <div className="ld-terminal-body">
        {lines.map(({ t, sym, cls, msg }) => (
          <div key={t} className="ld-log">
            <span className="ld-log-t">{t}</span>
            <span className={`ld-log-s ${cls}`}>{sym}</span>
            <span className="ld-log-m">{msg}</span>
          </div>
        ))}
        <div className="ld-log">
          <span className="ld-log-t">12:04:10</span>
          <span className="ld-log-s sym-blue">→</span>
          <span className="ld-log-m">Paused for your review<span className="ld-cursor" aria-hidden="true" /></span>
        </div>
      </div>
    </div>
  )
}

// ── Pipeline funnel board ─────────────────────────────────────────────────────
function PipelineBoard() {
  const cols = [
    { k: 'Matched', n: 24, items: ['Anthropic', 'Stripe', 'Vercel'] },
    { k: 'Applied', n: 11, items: ['Figma', 'Brex'] },
    { k: 'Interview', n: 3, items: ['Mercury'] },
    { k: 'Offer', n: 1, items: ['Linear'], hot: true },
  ]
  return (
    <div className="ld-board">
      {cols.map(({ k, n, items, hot }) => (
        <div key={k} className={`ld-board-col${hot ? ' hot' : ''}`}>
          <div className="ld-board-head"><span>{k}</span><span className="ld-board-n">{n}</span></div>
          <div className="ld-board-items">
            {items.map((it) => <div key={it} className="ld-board-card">{it}</div>)}
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Voice onboarding ──────────────────────────────────────────────────────────
function VoiceWidget() {
  const [ref, inView] = useInView(0.4)
  const fields = [
    { k: 'Role', v: 'Software Engineer' },
    { k: 'Level', v: '4 yrs · IC' },
    { k: 'Locations', v: 'SF · Remote (US)' },
    { k: 'Comp target', v: '$180k+' },
  ]
  return (
    <div ref={ref} className="ld-card ld-voice">
      <div className="ld-voice-wave">
        {Array.from({ length: 28 }).map((_, i) => (
          <span key={i} className="ld-voice-bar" style={{ animationDelay: `${i * 0.06}s`, height: `${26 + Math.round(Math.abs(Math.sin(i * 0.7)) * 58)}%` }} />
        ))}
      </div>
      <div className="ld-voice-quote">“I’m a software engineer with about four years, looking in SF or remote, ideally above 180…”</div>
      <div className="ld-voice-fields">
        {fields.map(({ k, v }, i) => (
          <div key={k} className="ld-voice-field">
            <span className="ld-voice-k">{k}</span>
            <span className="ld-voice-v">{v}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── FAQ accordion ─────────────────────────────────────────────────────────────
function FaqItem({ q, a, open, onToggle }) {
  return (
    <div className={`ld-faq-item${open ? ' open' : ''}`}>
      <button className="ld-faq-q" onClick={onToggle} aria-expanded={open}>
        <span>{q}</span>
        <span className="ld-faq-icon" aria-hidden="true"><span /><span /></span>
      </button>
      <div className="ld-faq-a-wrap">
        <div className="ld-faq-a">{a}</div>
      </div>
    </div>
  )
}

// ── Google icon ───────────────────────────────────────────────────────────────
function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
    </svg>
  )
}

// ── Main landing component ────────────────────────────────────────────────────
export default function Landing({ onEnter, onSkip }) {
  const [modalOpen, setModalOpen] = useState(false)
  const [scrollY, setScrollY] = useState(0)
  const [faqOpen, setFaqOpen] = useState(0)
  const [mounted, setMounted] = useState(false)
  const scrollRef = useRef(null)

  useEffect(() => { const t = setTimeout(() => setMounted(true), 40); return () => clearTimeout(t) }, [])
  const hv = (d) => ({
    transform: mounted ? 'translateY(0)' : 'translateY(16px)',
    transition: `transform .85s cubic-bezier(0.16,1,0.3,1) ${d}s`,
    willChange: 'transform',
  })

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => setScrollY(el.scrollTop)
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') setModalOpen(false) }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.style.overflow = modalOpen ? 'hidden' : 'auto'
  }, [modalOpen])

  const openModal = () => setModalOpen(true)
  const closeModal = () => setModalOpen(false)
  const handleSignIn = () => { closeModal(); onEnter?.() }

  // Fluid transition — overlay lives in App.jsx, just call onSkip
  const handleTryIt = () => { onSkip?.() }
  const scrollTo = (id) => {
    const el = document.getElementById(id)
    if (el && scrollRef.current) scrollRef.current.scrollTo({ top: el.offsetTop - 70, behavior: 'smooth' })
  }

  const navAlpha = Math.min(scrollY / 80, 1)
  const heroPar = scrollY * 0.22

  return (
    <>
      <style>{CSS}</style>

      <div ref={scrollRef} data-scroll className="ld-page" aria-label="Rack landing page">

        {/* ── NAV ── */}
        <nav className="ld-nav" style={{
          background: `rgba(255,255,255,${0.55 + navAlpha * 0.35})`,
          borderBottomColor: `rgba(6,30,20,${0.03 + navAlpha * 0.05})`,
        }}>
          <div className="ld-nav-l">
            <span className="ld-wordmark">rack.</span>
            <a href="https://tejasbk.dev"
    target="_blank"
    rel="noopener noreferrer"
    style={{ textDecoration: 'none', display: 'inline-block' }}
  >
            <span className="ld-byline">/ by tejasbk</span></a>
          </div>
          <ul className="ld-nav-links">
            {['How it works', 'Capabilities', 'Auto-apply', 'FAQ'].map((label, i) => (
              <li key={label}><button onClick={() => scrollTo(['ld-how', 'ld-cap', 'ld-apply', 'ld-faq'][i])}>{label}</button></li>
            ))}
          </ul>
          <div className="ld-nav-actions">
            <button className="ld-btn-text" onClick={openModal}>Log in</button>
            <button className="ld-btn-pill" onClick={openModal}>Get started<Arrow size={14} /></button>
          </div>
        </nav>

        {/* ── HERO ── */}
        <section className="ld-hero">
          <div className="ld-hero-dots" aria-hidden="true" style={{ transform: `translateY(${heroPar * 0.3}px)` }} />
          <div className="ld-hero-glow" aria-hidden="true" />
          <div className="ld-hero-inner">
            <div className="ld-badge" style={hv(0.05)}>
              <span className="ld-badge-pulse" aria-hidden="true" />
              150+ company boards, scanned six times a day
            </div>
            <h1 className="ld-hero-h1" style={hv(0.13)}>
              Your next job finds you.<br />
              <span className="ld-grad">Rack handles the rest.</span>
            </h1>
            <p className="ld-hero-sub" style={hv(0.24)}>
              Rack scans every company board, scores each posting against your exact resume, and
              applies to jobs on your behalf. You wake up to ranked matches, not another search bar.
            </p>
            <div className="ld-hero-ctas" style={hv(0.34)}>
              <button className="ld-btn-primary" onClick={openModal}>Get started free<Arrow size={16} /></button>
              <button className="ld-btn-try" onClick={handleTryIt}>Try it now for free<Arrow size={14} /></button>
            </div>
            <p className="ld-hero-note" style={hv(0.44)}>Free during beta · No credit card · Cancel anytime</p>
            <div className="ld-hero-visual" style={hv(0.55)}>
              <HeroFlow />
            </div>
          </div>
        </section>

        {/* ── MARQUEE ── */}
        <div className="ld-marquee-wrap">
          <div className="ld-marquee-label">Matching candidates to roles at</div>
          <div className="ld-marquee" aria-hidden="true">
            <div className="ld-marquee-track">
              {[...COMPANIES, ...COMPANIES].map((c, i) => (
                <span key={i} className="ld-marquee-item"><span className="ld-marquee-dot" />{c}</span>
              ))}
            </div>
            <div className="ld-marquee-fade ld-fade-l" />
            <div className="ld-marquee-fade ld-fade-r" />
          </div>
        </div>

        {/* ── BIG STAT ── */}
        <BigStat />

        {/* ── HOW IT WORKS ── */}
        <section id="ld-how" className="ld-section">
          <Reveal><SectionHead eyebrow="How it works" title="Three steps. Then it runs itself." sub="Set it up once. Rack runs the full pipeline every day, no manual searching, no daily login." center /></Reveal>
          <div className="ld-steps">
            {[
              { n: '01', title: 'Upload your resumes', desc: 'Drop up to five tailored versions. Each is chunked into vectors so Rack can route the best-fit one to every application.', icon: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z|14 2 14 8 20 8|M12 18v-6|M9 15h6' },
              { n: '02', title: 'Rack scans while you sleep', desc: 'Six times a day it fetches fresh postings from 150+ Greenhouse, Ashby, and Lever boards, then vector-scores every one.', icon: 'circle:11 11 8|m21 21-4.35-4.35' },
              { n: '03', title: 'Wake up to ranked matches', desc: 'A sorted list scored on skills, experience, and trajectory. Apply in one click, or let the agent apply for you.', icon: 'polyline:22 12 18 12 15 21 9 3 6 12 2 12' },
            ].map(({ n, title, desc, icon }, i, arr) => (
              <Reveal key={n} delay={i * 0.1}>
                <div className={`ld-step${i === arr.length - 1 ? ' last' : ''}`}>
                  <div className="ld-step-top"><span className="ld-step-n">{n}</span><span className="ld-step-ico"><StepIcon spec={icon} /></span></div>
                  <h3 className="ld-step-title">{title}</h3>
                  <p className="ld-step-desc">{desc}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </section>

        {/* ── CAPABILITIES — alternating infographic panels ── */}
        <section id="ld-cap" className="ld-cap">
          <div className="ld-cap-inner">
            <Reveal><SectionHead eyebrow="Capabilities" title="A full matching engine, not a job board." sub="Every part of the pipeline, built to do the work you’d otherwise do by hand." /></Reveal>

            <Panel
              eyebrow="Coverage"
              title="150+ company boards, one quiet inbox"
              desc="Direct Greenhouse, Ashby, and Lever integrations plus YC-batch auto-discovery. Six fetch runs a day means you see roles the morning they go live."
              points={['No middlemen, no stale aggregator delays', 'Fresh postings scored within minutes of posting']}
              visual={<ScanWidget />}
            />
            <Panel reverse
              eyebrow="Scoring"
              title="Two-phase scoring against your real resume"
              desc="pgvector narrows thousands of postings to a shortlist in milliseconds. Only that shortlist reaches Rack AI, which scores each role on three dimensions."
              points={['Fast vector pass keeps it cheap at scale', 'LLM judgement where it actually matters']}
              visual={<FunnelWidget />}
            />
            <Panel
              eyebrow="Multi-resume"
              title="The right version, routed automatically"
              desc="Upload up to five variants. Rack matches each job to the resume most likely to land an interview, no manual swapping, no wrong file attached."
              points={['Best-fit variant chosen per application', 'Keep specialized resumes for adjacent roles']}
              visual={<RouterWidget />}
            />
          </div>
        </section>

        {/* ── AUTO-APPLY (dark) ── */}
        <section id="ld-apply" className="ld-dark">
          <div className="ld-dark-dots" aria-hidden="true" />
          <div className="ld-dark-inner">
            <Reveal><SectionHead light eyebrow="Automation" title="It applies while you sleep." sub="A Steel-powered browser agent fills and submits applications on Greenhouse, Ashby, and Lever, reading real form fields at runtime, never brittle scripts." /></Reveal>
            <div className="ld-dark-grid">
              <Reveal className="ld-dark-visual"><Terminal /></Reveal>
              <Reveal delay={0.12} className="ld-dark-copy">
                <ul className="ld-check">
                  {[
                    'Reads actual fields at runtime, adapts to any layout',
                    'Uploads the best-fit resume version per application',
                    'Handles EEO fields, work authorization, custom dropdowns',
                    'Pauses for your review before anything is submitted',
                  ].map((t) => (
                    <li key={t}><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#34d399" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12" /></svg><span>{t}</span></li>
                  ))}
                </ul>
                <div className="ld-board-cap">Then every application lands on your pipeline board.</div>
                <PipelineBoard />
              </Reveal>
            </div>
          </div>
        </section>

        {/* ── VOICE ONBOARDING ── */}
        <section className="ld-section ld-voice-sec">
          <Panel reverse
            eyebrow="Onboarding"
            title="Set up by just talking"
            desc="No long forms. Rack’s voice onboarding listens for two minutes and extracts your profile, preferences, and target roles, structured and ready before you finish your coffee."
            points={['Under two minutes, start to first matches', 'Edit anything it captured with one tap']}
            visual={<VoiceWidget />}
          />
        </section>

        {/* ── FAQ ── */}
        <section id="ld-faq" className="ld-faq-sec">
          <div className="ld-faq-inner">
            <Reveal><SectionHead eyebrow="FAQ" title="Questions, answered." center /></Reveal>
            <Reveal delay={0.08}>
              <div className="ld-faq-list">
                {FAQ.map((f, i) => (
                  <FaqItem key={f.q} q={f.q} a={f.a} open={faqOpen === i} onToggle={() => setFaqOpen(faqOpen === i ? -1 : i)} />
                ))}
              </div>
            </Reveal>
          </div>
        </section>

        {/* ── CTA ── */}
        <section className="ld-cta">
          <div className="ld-cta-dots" aria-hidden="true" />
          <Reveal>
            <div className="ld-cta-inner">
              <div className="ld-eyebrow ld-eyebrow-c"><span className="ld-eyebrow-tick" aria-hidden="true" />Early access</div>
              <h2 className="ld-cta-h2">Stop applying.<br /><span className="ld-grad">Start matching.</span></h2>
              <p className="ld-cta-sub">Join early users getting matched to roles at Anthropic, Stripe, Figma and 150+ companies, every single day.</p>
              <div className="ld-cta-actions">
                <button className="ld-btn-primary ld-btn-lg" onClick={openModal}>Get started for free<Arrow size={18} /></button>
                {onSkip && <button className="ld-btn-text ld-btn-skip" onClick={onSkip}>Continue without signing in</button>}
              </div>
              <p className="ld-cta-note">Free during beta · Built by <a href="https://tejasbk.dev" target="_blank" rel="noopener noreferrer" className="ld-link">Tejas</a></p>
            </div>
          </Reveal>
        </section>

        {/* ── FOOTER ── */}
        <footer className="ld-footer">
          <div className="ld-footer-l"><span className="ld-wordmark">rack.</span><span className="ld-footer-dom">rackx.app</span></div>
          <p className="ld-footer-copy">Scanning jobs so you don’t have to.</p>
        </footer>
      </div>

      {/* ── MODAL ── */}
      {modalOpen && (
        <div className="ld-modal-bd" onClick={(e) => { if (e.target === e.currentTarget) closeModal() }} role="dialog" aria-modal="true" aria-label="Sign in to Rack">
          <div className="ld-modal">
            <button className="ld-modal-x" onClick={closeModal} aria-label="Close"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg></button>
            <div className="ld-modal-logo">rack</div>
            <h2 className="ld-modal-title">Sign in to Rack</h2>
            <p className="ld-modal-sub">Access your matched jobs, resume vault, and full application pipeline.</p>
            <button className="ld-btn-google" onClick={handleSignIn}><GoogleIcon />Continue with Google</button>
            <p className="ld-modal-note">Your email and resume data only, nothing sold or shared.</p>
          </div>
        </div>
      )}
    </>
  )
}

// ── Big stat moment ────────────────────────────────────────────────────────────
function BigStat() {
  const [ref, inView] = useInView(0.4)
  const scanned = useCountUp(8420000, inView, 1800)
  return (
    <section className="ld-bigstat" ref={ref}>
      <div className="ld-bigstat-dots" aria-hidden="true" />
      <div className="ld-bigstat-inner">
        <div className="ld-bigstat-over">Since launch, Rack has scanned over</div>
        <div className="ld-bigstat-num">{fmt(scanned)}</div>
        <div className="ld-bigstat-l">job postings, so its users never had to.</div>
        <div className="ld-bigstat-row">
          {[
            { v: '150+', l: 'Company boards' },
            { v: '6×', l: 'Daily fetch runs' },
            { v: '2', l: 'AI scoring phases' },
            { v: '5', l: 'Resume versions' },
          ].map(({ v, l }) => (
            <div key={l} className="ld-bigstat-cell"><span className="ld-bigstat-v">{v}</span><span className="ld-bigstat-cl">{l}</span></div>
          ))}
        </div>
      </div>
    </section>
  )
}

// ── Step icon renderer ──────────────────────────────────────────────────────────
function StepIcon({ spec }) {
  const parts = spec.split('|')
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {parts.map((p, i) => {
        if (p.startsWith('circle:')) { const [cx, cy, r] = p.slice(7).split(' '); return <circle key={i} cx={cx} cy={cy} r={r} /> }
        if (p.startsWith('polyline:')) return <polyline key={i} points={p.slice(9)} />
        if (p.startsWith('14 2 14 8')) return <polyline key={i} points={p} />
        return <path key={i} d={p} />
      })}
    </svg>
  )
}

// ── Infographic panel (alternating row) ──────────────────────────────────────────
function Panel({ eyebrow, title, desc, points = [], visual, reverse = false }) {
  return (
    <Reveal>
      <div className={`ld-panel${reverse ? ' reverse' : ''}`}>
        <div className="ld-panel-copy">
          <div className="ld-eyebrow"><span className="ld-eyebrow-tick" aria-hidden="true" />{eyebrow}</div>
          <h3 className="ld-panel-title">{title}</h3>
          <p className="ld-panel-desc">{desc}</p>
          {points.length > 0 && (
            <ul className="ld-panel-points">
              {points.map((p) => (
                <li key={p}><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--em)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12" /></svg>{p}</li>
              ))}
            </ul>
          )}
        </div>
        <div className="ld-panel-visual">{visual}</div>
      </div>
    </Reveal>
  )
}

// ── Styles ────────────────────────────────────────────────────────────────────
const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Geist:wght@300;400;500;600;700;800&family=Geist+Mono:wght@400;500&display=swap');

  :root {
    --sans: 'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    --mono: 'Geist Mono', 'SF Mono', 'Fira Code', monospace;
    --ink:   #06140e;
    --ink2:  #2c3a33;
    --ink3:  #5d6b63;
    --ink4:  #94a39a;
    --bg:    #ffffff;
    --paper: #f6f8f5;
    --bg2:   #f1f5f1;
    --bg3:   #e9efe9;
    --line:        rgba(6,40,24,0.08);
    --line-strong: rgba(6,40,24,0.14);
    --em:      #059669;
    --em-deep: #047857;
    --em-dark: #064e3b;
    --teal:    #0d9488;
    --mint:    #10b981;
    --tint:    #ecfdf5;
    --tint2:   #d1fae5;
    --tint-b:  #a7f3d0;
    --grad: linear-gradient(120deg, #059669 0%, #0d9488 55%, #0891b2 100%);
    --dotc: rgba(6,60,40,0.07);
    --radius: 16px;
    --shadow-card: 0 1px 2px rgba(6,40,24,0.04), 0 8px 24px rgba(6,40,24,0.06), 0 30px 60px rgba(6,40,24,0.05);
  }

  .ld-page {
    position: fixed; inset: 0;
    overflow-y: auto; overflow-x: hidden;
    background: var(--bg);
    font-family: var(--sans); color: var(--ink);
    -webkit-font-smoothing: antialiased;
    z-index: 900;
  }
  .ld-page * { box-sizing: border-box; }

  /* ── Nav ── */
  .ld-nav {
    position: sticky; top: 0; z-index: 200;
    display: grid; grid-template-columns: 1fr auto 1fr; align-items: center;
    padding: 0 40px; height: 66px;
    backdrop-filter: blur(18px) saturate(1.4); -webkit-backdrop-filter: blur(18px) saturate(1.4);
    border-bottom: 1px solid var(--line);
    transition: background .25s, border-color .25s;
  }
  .ld-nav-l { justify-self: start; display: flex; flex-direction: column; gap: 2px; }
  .ld-nav-actions { justify-self: end; display: flex; align-items: center; gap: 8px; }
  .ld-wordmark { font-weight: 800; font-size: 30px; letter-spacing: -0.05em; color: var(--ink); line-height: 1; }
  .ld-byline {
    font-family: var(--mono); font-size: 10px; letter-spacing: -0.05em;
    font-weight: 500; line-height: 1;
    background: linear-gradient(90deg,
      var(--ink4) 0%,
      var(--ink4) 30%,
      var(--em-deep) 48%,
      #0d9488 54%,
      var(--ink4) 72%,
      var(--ink4) 100%
    );
    background-size: 220% 100%;
    -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;
    animation: ldBylineShimmer 3.6s ease-in-out infinite;
  }
  @keyframes ldBylineShimmer {
    0%   { background-position: 100% 0; }
    50%  { background-position: 0% 0; }
    100% { background-position: 100% 0; }
  }
  .ld-nav-links { display: flex; align-items: center; gap: 30px; list-style: none; margin: 0; padding: 0; }
  .ld-nav-links button { background: none; border: none; padding: 0; font-family: var(--sans); font-size: 14px; font-weight: 450; color: var(--ink3); cursor: pointer; transition: color .15s; }
  .ld-nav-links button:hover { color: var(--ink); }
  .ld-btn-text { background: none; border: none; font-family: var(--sans); font-size: 14px; font-weight: 500; color: var(--ink3); cursor: pointer; padding: 8px 14px; border-radius: 8px; transition: color .15s, background .15s; }
  .ld-btn-text:hover { color: var(--ink); background: var(--bg2); }
  .ld-btn-pill { display: inline-flex; align-items: center; gap: 6px; background: var(--ink); color: #fff; border: none; font-family: var(--sans); font-size: 14px; font-weight: 600; padding: 9px 18px; border-radius: 99px; cursor: pointer; transition: background .15s, transform .15s, box-shadow .15s; letter-spacing: -0.01em; }
  .ld-btn-pill:hover { background: var(--em-dark); box-shadow: 0 6px 20px rgba(6,78,59,0.28); transform: translateY(-1px); }

  /* ── Buttons (shared) ── */
  .ld-btn-primary { display: inline-flex; align-items: center; gap: 8px; background: var(--ink); color: #fff; border: none; font-family: var(--sans); font-size: 15px; font-weight: 600; padding: 13px 26px; border-radius: 99px; cursor: pointer; transition: background .15s, transform .15s, box-shadow .15s; letter-spacing: -0.01em; }
  .ld-btn-primary:hover { background: var(--em-dark); box-shadow: 0 10px 30px rgba(6,78,59,0.3); transform: translateY(-2px); }
  .ld-btn-lg { padding: 16px 34px; font-size: 16px; }
  .ld-btn-ghost { background: #fff; border: 1px solid var(--line-strong); color: var(--ink2); font-family: var(--sans); font-size: 15px; font-weight: 500; padding: 12px 24px; border-radius: 99px; cursor: pointer; transition: all .15s; }
  .ld-btn-ghost:hover { border-color: var(--tint-b); color: var(--em-deep); background: var(--tint); }
  .ld-btn-try { display: inline-flex; align-items: center; gap: 8px; background: transparent; border: 1.5px solid var(--line-strong); color: var(--ink2); font-family: var(--sans); font-size: 15px; font-weight: 500; padding: 12px 24px; border-radius: 99px; cursor: pointer; transition: all .22s cubic-bezier(0.16,1,0.3,1); letter-spacing: -0.01em; }
  .ld-btn-try:hover { border-color: var(--em); color: var(--em-deep); background: var(--tint); transform: translateY(-1px); box-shadow: 0 6px 20px rgba(5,150,105,0.14); }
  .ld-btn-try:active { transform: translateY(0); }

  /* ── Hero ── */
  .ld-hero { position: relative; padding: 96px 24px 64px; overflow: hidden; text-align: center; display: flex; flex-direction: column; align-items: center; }
  .ld-hero-dots { position: absolute; inset: -10% 0 0 0; background-image: radial-gradient(var(--dotc) 1.3px, transparent 1.4px); background-size: 26px 26px; mask-image: radial-gradient(ellipse 70% 60% at 50% 30%, #000 25%, transparent 78%); -webkit-mask-image: radial-gradient(ellipse 70% 60% at 50% 30%, #000 25%, transparent 78%); }
  .ld-hero-glow { position: absolute; top: -160px; left: 50%; transform: translateX(-50%); width: 820px; height: 560px; background: radial-gradient(ellipse at center, rgba(13,148,136,0.12) 0%, rgba(5,150,105,0.05) 40%, transparent 72%); pointer-events: none; }
  .ld-hero-inner { position: relative; z-index: 2; display: flex; flex-direction: column; align-items: center; max-width: 1080px; width: 100%; }
  .ld-badge { display: inline-flex; align-items: center; gap: 8px; background: var(--tint); border: 1px solid var(--tint-b); color: var(--em-deep); font-size: 13px; font-weight: 500; padding: 6px 15px 6px 11px; border-radius: 99px; margin-bottom: 32px; letter-spacing: -0.01em; }
  .ld-badge-pulse { width: 7px; height: 7px; background: var(--em); border-radius: 50%; animation: ldPulse 2s ease-in-out infinite; flex-shrink: 0; }
  .ld-hero-h1 { font-weight: 800; font-size: clamp(46px, 7vw, 84px); line-height: 1.0; letter-spacing: -0.045em; color: var(--ink); margin: 0 0 22px; }
  .ld-grad { background: var(--grad); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; }
  .ld-hero-sub { font-size: clamp(16px, 2.1vw, 19px); line-height: 1.65; color: var(--ink3); max-width: 580px; margin: 0 0 34px; font-weight: 400; text-wrap: pretty; }
  .ld-hero-ctas { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; justify-content: center; margin-bottom: 18px; }
  .ld-hero-note { font-size: 13px; color: var(--ink4); margin: 0 0 56px; }
  .ld-hero-visual { width: 100%; max-width: 940px; }

  /* ── Hero flow card ── */
  .ld-flow { background: #fff; border: 1px solid var(--line-strong); border-radius: 20px; overflow: hidden; box-shadow: var(--shadow-card); text-align: left; }
  .ld-flow-bar { display: flex; align-items: center; gap: 10px; padding: 12px 18px; border-bottom: 1px solid var(--line); background: var(--paper); }
  .ld-dots { display: flex; gap: 6px; }
  .ld-dot { width: 10px; height: 10px; border-radius: 50%; }
  .ld-flow-title { font-family: var(--mono); font-size: 12px; color: var(--ink4); flex: 1; text-align: center; }
  .ld-flow-live, .ld-terminal-live { display: inline-flex; align-items: center; gap: 5px; font-family: var(--mono); font-size: 11px; color: var(--em); }
  .ld-live-dot { width: 6px; height: 6px; background: currentColor; border-radius: 50%; animation: ldPulse 2s ease-in-out infinite; }
  .ld-flow-grid { display: grid; grid-template-columns: 1fr auto 1.25fr auto 1fr; align-items: stretch; gap: 0; padding: 22px; }
  .ld-stage { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
  .ld-stage-cap { font-family: var(--mono); font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink4); margin-bottom: 4px; display: flex; justify-content: space-between; align-items: center; }
  .ld-stage-count { color: var(--em); font-weight: 500; }
  .ld-mini-file { display: flex; align-items: center; gap: 8px; padding: 9px 11px; border: 1px solid var(--line); border-radius: 9px; background: var(--paper); color: var(--ink3); font-family: var(--mono); font-size: 12px; }
  .ld-mini-file.on { border-color: var(--tint-b); background: var(--tint); color: var(--ink); }
  .ld-mini-file svg { color: var(--ink4); flex-shrink: 0; }
  .ld-mini-file.on svg { color: var(--em); }
  .ld-mini-file-n { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ld-mini-tag { font-size: 10px; font-weight: 600; color: var(--em); background: #fff; border: 1px solid var(--tint-b); border-radius: 5px; padding: 1px 6px; }
  .ld-flow-conn { position: relative; width: 34px; align-self: center; height: 2px; background: var(--line-strong); margin: 0 2px; }
  .ld-flow-pulse { position: absolute; top: -2px; left: 0; width: 12px; height: 6px; border-radius: 4px; background: var(--em); filter: blur(1px); animation: ldConn 2.4s linear infinite; }
  .ld-engine-badges { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
  .ld-engine-badge { font-family: var(--mono); font-size: 11px; padding: 4px 9px; border-radius: 6px; background: var(--bg2); border: 1px solid var(--line); color: var(--ink3); }
  .ld-engine-badge.accent { background: var(--tint); border-color: var(--tint-b); color: var(--em-deep); }
  .ld-engine-arrow { color: var(--ink4); display: flex; }
  .ld-rank-row { display: flex; align-items: center; gap: 8px; padding: 8px 9px; border-radius: 8px; background: var(--paper); border: 1px solid var(--line); }
  .ld-rank-n { font-family: var(--mono); font-size: 11px; color: var(--ink4); }
  .ld-rank-co { flex: 1; font-size: 13px; font-weight: 600; letter-spacing: -0.01em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ld-rank-score { font-family: var(--mono); font-size: 13px; font-weight: 700; color: var(--em); }
  .ld-rank-st { font-family: var(--mono); font-size: 9px; text-transform: uppercase; letter-spacing: 0.06em; padding: 2px 6px; border-radius: 4px; }
  .ld-st-applied { background: var(--tint); color: var(--em-deep); }
  .ld-st-applying { background: #fff7ed; color: #c2410c; }
  .ld-st-queued { background: var(--bg2); color: var(--ink4); }

  /* ── Score bars ── */
  .ld-scorebars { display: flex; flex-direction: column; gap: 11px; margin-top: 4px; }
  .ld-scorebar-top { display: flex; justify-content: space-between; margin-bottom: 5px; }
  .ld-scorebar-label { font-size: 12px; font-weight: 500; color: var(--ink2); }
  .ld-scorebar-val { font-size: 12px; font-weight: 700; font-family: var(--mono); }
  .ld-scorebar-track { height: 6px; background: var(--bg2); border-radius: 99px; overflow: hidden; }
  .ld-scorebar-fill { height: 100%; border-radius: 99px; transition: width 1.3s cubic-bezier(0.16,1,0.3,1); }

  /* ── Marquee ── */
  .ld-marquee-wrap { border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); background: var(--paper); padding: 22px 0 24px; }
  .ld-marquee-label { text-align: center; font-family: var(--mono); font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink4); margin-bottom: 16px; }
  .ld-marquee { position: relative; overflow: hidden; }
  .ld-marquee-track { display: flex; width: max-content; animation: ldMarquee 42s linear infinite; }
  .ld-marquee-item { display: inline-flex; align-items: center; gap: 9px; padding: 0 30px; font-family: var(--mono); font-size: 13px; color: var(--ink3); white-space: nowrap; }
  .ld-marquee-dot { width: 4px; height: 4px; background: var(--em); border-radius: 50%; opacity: 0.55; }
  .ld-marquee-fade { position: absolute; top: 0; bottom: 0; width: 140px; pointer-events: none; z-index: 2; }
  .ld-fade-l { left: 0; background: linear-gradient(90deg, var(--paper), transparent); }
  .ld-fade-r { right: 0; background: linear-gradient(270deg, var(--paper), transparent); }

  /* ── Big stat ── */
  .ld-bigstat { position: relative; background: var(--ink); color: #fff; overflow: hidden; }
  .ld-bigstat-dots { position: absolute; inset: 0; background-image: radial-gradient(rgba(52,211,153,0.14) 1.2px, transparent 1.3px); background-size: 28px 28px; mask-image: radial-gradient(ellipse 60% 70% at 50% 50%, #000 15%, transparent 75%); -webkit-mask-image: radial-gradient(ellipse 60% 70% at 50% 50%, #000 15%, transparent 75%); }
  .ld-bigstat-inner { position: relative; max-width: 1000px; margin: 0 auto; padding: 96px 48px; text-align: center; }
  .ld-bigstat-over { font-size: 15px; color: rgba(255,255,255,0.55); margin-bottom: 12px; letter-spacing: -0.01em; }
  .ld-bigstat-num { font-weight: 800; font-size: clamp(56px, 11vw, 132px); line-height: 0.95; letter-spacing: -0.05em; background: linear-gradient(120deg, #6ee7b7, #34d399 50%, #2dd4bf); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; font-variant-numeric: tabular-nums; }
  .ld-bigstat-l { font-size: 16px; color: rgba(255,255,255,0.62); margin-top: 14px; }
  .ld-bigstat-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0; margin-top: 56px; border: 1px solid rgba(255,255,255,0.1); border-radius: 14px; overflow: hidden; }
  .ld-bigstat-cell { padding: 26px 16px; border-right: 1px solid rgba(255,255,255,0.1); }
  .ld-bigstat-cell:last-child { border-right: none; }
  .ld-bigstat-v { display: block; font-weight: 800; font-size: 32px; letter-spacing: -0.04em; color: #fff; }
  .ld-bigstat-cl { display: block; font-size: 12px; color: rgba(255,255,255,0.5); margin-top: 5px; }

  /* ── Sections / heads ── */
  .ld-section { max-width: 1160px; margin: 0 auto; padding: 104px 48px; }
  .ld-head { max-width: 620px; }
  .ld-head-center { margin: 0 auto; text-align: center; }
  .ld-eyebrow { display: inline-flex; align-items: center; gap: 8px; font-family: var(--mono); font-size: 12px; font-weight: 500; letter-spacing: 0.1em; text-transform: uppercase; color: var(--em-deep); margin-bottom: 16px; }
  .ld-head-center .ld-eyebrow { justify-content: center; }
  .ld-eyebrow-tick { width: 16px; height: 1px; background: var(--em); display: inline-block; }
  .ld-head-light .ld-eyebrow { color: #34d399; }
  .ld-h2 { font-weight: 800; font-size: clamp(30px, 4vw, 46px); letter-spacing: -0.04em; line-height: 1.08; color: var(--ink); margin: 0 0 16px; text-wrap: balance; }
  .ld-head-light .ld-h2 { color: #fff; }
  .ld-sub { font-size: 17px; line-height: 1.6; color: var(--ink3); max-width: 560px; font-weight: 400; margin: 0; text-wrap: pretty; }
  .ld-head-center .ld-sub { margin: 0 auto; }
  .ld-head-light .ld-sub { color: rgba(255,255,255,0.6); }

  /* ── Steps ── */
  .ld-steps { display: grid; grid-template-columns: repeat(3, 1fr); margin-top: 56px; border: 1px solid var(--line); border-radius: 18px; overflow: hidden; background: #fff; }
  .ld-steps > div { display: contents; }
  .ld-step { padding: 40px 34px 44px; border-right: 1px solid var(--line); transition: background .2s; }
  .ld-step:hover { background: var(--paper); }
  .ld-step.last { border-right: none; }
  .ld-step-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 22px; }
  .ld-step-n { font-family: var(--mono); font-size: 12px; color: var(--em); font-weight: 600; letter-spacing: 0.1em; }
  .ld-step-ico { width: 42px; height: 42px; border-radius: 11px; background: var(--tint); border: 1px solid var(--tint-b); display: flex; align-items: center; justify-content: center; color: var(--em-deep); }
  .ld-step-title { font-weight: 700; font-size: 18px; letter-spacing: -0.025em; color: var(--ink); margin: 0 0 10px; line-height: 1.25; }
  .ld-step-desc { font-size: 14px; line-height: 1.7; color: var(--ink3); margin: 0; }

  /* ── Capabilities / panels ── */
  .ld-cap { background: var(--paper); border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); position: relative; }
  .ld-cap::before { content: ''; position: absolute; inset: 0; background-image: radial-gradient(var(--dotc) 1.1px, transparent 1.2px); background-size: 24px 24px; opacity: 0.6; pointer-events: none; }
  .ld-cap-inner { position: relative; max-width: 1160px; margin: 0 auto; padding: 104px 48px; }
  .ld-panel { display: grid; grid-template-columns: 1fr 1.05fr; gap: 64px; align-items: center; padding: 56px 0; border-top: 1px solid var(--line); }
  .ld-cap-inner > .ld-head + * .ld-panel, .ld-panel:first-of-type { }
  .ld-panel.reverse { direction: rtl; }
  .ld-panel.reverse > * { direction: ltr; }
  .ld-panel-title { font-weight: 700; font-size: clamp(22px, 2.6vw, 30px); letter-spacing: -0.03em; line-height: 1.15; color: var(--ink); margin: 0 0 14px; }
  .ld-panel-desc { font-size: 16px; line-height: 1.65; color: var(--ink3); margin: 0; max-width: 460px; text-wrap: pretty; }
  .ld-panel-points { list-style: none; margin: 20px 0 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
  .ld-panel-points li { display: flex; align-items: flex-start; gap: 10px; font-size: 14px; color: var(--ink2); line-height: 1.5; }
  .ld-panel-points svg { flex-shrink: 0; margin-top: 2px; }
  .ld-panel-visual { min-width: 0; }

  /* ── Card base ── */
  .ld-card { background: #fff; border: 1px solid var(--line-strong); border-radius: var(--radius); box-shadow: var(--shadow-card); overflow: hidden; }

  /* ── Scan widget ── */
  .ld-scan { padding: 0; }
  .ld-scan-head { display: flex; align-items: center; justify-content: space-between; padding: 20px 22px 16px; border-bottom: 1px solid var(--line); }
  .ld-scan-count { font-weight: 800; font-size: 34px; letter-spacing: -0.04em; color: var(--ink); font-variant-numeric: tabular-nums; line-height: 1; }
  .ld-scan-count-l { font-size: 12px; color: var(--ink4); margin-top: 5px; }
  .ld-cycle { position: relative; display: flex; align-items: center; justify-content: center; }
  .ld-cycle-n { position: absolute; font-family: var(--mono); font-size: 12px; font-weight: 600; color: var(--em-deep); }
  .ld-scan-grid { position: relative; display: grid; grid-template-columns: repeat(6, 1fr); gap: 5px; padding: 18px 22px; overflow: hidden; }
  .ld-scan-beam { position: absolute; top: 0; left: -30%; width: 30%; height: 100%; background: linear-gradient(90deg, transparent, rgba(13,148,136,0.16), transparent); animation: ldBeam 3.4s ease-in-out infinite; pointer-events: none; }
  .ld-scan-tile { font-family: var(--mono); font-size: 9.5px; color: var(--ink3); background: var(--paper); border: 1px solid var(--line); border-radius: 5px; padding: 6px 4px; text-align: center; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ld-scan-foot { display: flex; align-items: center; gap: 16px; padding: 13px 22px; border-top: 1px solid var(--line); background: var(--paper); font-family: var(--mono); font-size: 11px; color: var(--ink3); }
  .ld-scan-foot span { display: inline-flex; align-items: center; gap: 6px; }
  .ld-foot-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--em); }
  .ld-scan-foot-r { margin-left: auto; color: var(--ink4); }

  /* ── Funnel ── */
  .ld-funnel { padding: 26px 24px; display: flex; flex-direction: column; gap: 16px; }
  .ld-funnel-row { display: grid; grid-template-columns: 1fr 148px; align-items: center; gap: 16px; }
  .ld-funnel-track { width: 100%; min-width: 0; }
  .ld-funnel-bar { height: 52px; border-radius: 10px; display: flex; align-items: center; padding: 0 16px; min-width: 70px; }
  .ld-funnel-bar.tone-mute { background: var(--bg2); border: 1px solid var(--line); }
  .ld-funnel-bar.tone-teal { background: linear-gradient(120deg, #99f6e4, #5eead4); }
  .ld-funnel-bar.tone-em { background: var(--grad); }
  .ld-funnel-val { font-weight: 800; font-size: 19px; letter-spacing: -0.03em; font-variant-numeric: tabular-nums; }
  .ld-funnel-bar.tone-mute .ld-funnel-val { color: var(--ink2); }
  .ld-funnel-bar.tone-teal .ld-funnel-val { color: #0f766e; }
  .ld-funnel-bar.tone-em .ld-funnel-val { color: #fff; }
  .ld-funnel-meta { display: flex; flex-direction: column; gap: 2px; }
  .ld-funnel-label { font-size: 13px; font-weight: 600; color: var(--ink); letter-spacing: -0.01em; }
  .ld-funnel-tag { font-family: var(--mono); font-size: 10.5px; color: var(--ink4); }
  .ld-funnel-note { font-size: 12.5px; color: var(--ink4); border-top: 1px dashed var(--line-strong); padding-top: 14px; margin-top: 2px; line-height: 1.5; }

  /* ── Router ── */
  .ld-router { padding: 26px; display: grid; grid-template-columns: 1fr 120px 1fr; align-items: center; gap: 0; }
  .ld-router-col { display: flex; flex-direction: column; gap: 9px; }
  .ld-router-chip { display: flex; align-items: center; gap: 7px; font-family: var(--mono); font-size: 11px; color: var(--ink4); background: var(--paper); border: 1px solid var(--line); border-radius: 8px; padding: 9px 10px; opacity: 0.6; }
  .ld-router-chip svg { flex-shrink: 0; }
  .ld-router-chip.on { opacity: 1; color: var(--ink); border-color: var(--tint-b); background: var(--tint); }
  .ld-router-chip.on svg { color: var(--em); }
  .ld-router-wires { width: 120px; height: 160px; align-self: center; }
  .ld-wire { opacity: 0.25; }
  .ld-wire.on { opacity: 1; stroke-dasharray: 4 5; animation: ldDash 1s linear infinite; }
  .ld-router-job { background: #fff; border: 1.5px solid var(--em); border-radius: 12px; padding: 16px; box-shadow: 0 8px 24px rgba(5,150,105,0.14); }
  .ld-router-job-co { font-weight: 700; font-size: 15px; letter-spacing: -0.02em; }
  .ld-router-job-role { font-size: 12px; color: var(--ink3); margin: 3px 0 12px; }
  .ld-router-pick { display: inline-flex; align-items: center; gap: 6px; font-family: var(--mono); font-size: 11px; color: var(--em-deep); background: var(--tint); border: 1px solid var(--tint-b); border-radius: 6px; padding: 5px 9px; }

  /* ── Dark automation ── */
  .ld-dark { position: relative; background: var(--ink); color: #fff; overflow: hidden; }
  .ld-dark-dots { position: absolute; inset: 0; background-image: radial-gradient(rgba(52,211,153,0.1) 1.1px, transparent 1.2px); background-size: 26px 26px; mask-image: radial-gradient(ellipse 80% 60% at 70% 30%, #000, transparent 75%); -webkit-mask-image: radial-gradient(ellipse 80% 60% at 70% 30%, #000, transparent 75%); }
  .ld-dark-inner { position: relative; max-width: 1160px; margin: 0 auto; padding: 104px 48px; }
  .ld-dark-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 56px; align-items: start; margin-top: 52px; }
  .ld-dark-visual { width: 100%; }
  .ld-check { list-style: none; margin: 0 0 28px; padding: 0; display: flex; flex-direction: column; gap: 13px; }
  .ld-check li { display: flex; align-items: flex-start; gap: 11px; font-size: 15px; color: rgba(255,255,255,0.76); line-height: 1.5; }
  .ld-check svg { flex-shrink: 0; margin-top: 2px; }
  .ld-board-cap { font-size: 13px; color: rgba(255,255,255,0.5); margin-bottom: 14px; font-family: var(--mono); letter-spacing: -0.01em; }

  /* ── Terminal ── */
  .ld-terminal { background: #0a1410; border: 1px solid rgba(255,255,255,0.1); border-radius: var(--radius); overflow: hidden; box-shadow: 0 32px 80px rgba(0,0,0,0.5); }
  .ld-terminal-head { display: flex; align-items: center; gap: 10px; padding: 12px 18px; border-bottom: 1px solid rgba(255,255,255,0.07); background: rgba(255,255,255,0.03); }
  .ld-terminal-t { font-family: var(--mono); font-size: 12px; color: rgba(255,255,255,0.35); flex: 1; text-align: center; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ld-terminal-live { color: #34d399; }
  .ld-terminal-body { padding: 18px 20px 22px; }
  .ld-log { display: flex; align-items: baseline; gap: 10px; padding: 5px 0; border-bottom: 1px solid rgba(255,255,255,0.04); }
  .ld-log:last-child { border-bottom: none; }
  .ld-log-t { font-family: var(--mono); font-size: 11px; color: rgba(255,255,255,0.22); flex-shrink: 0; width: 60px; }
  .ld-log-s { font-family: var(--mono); font-size: 13px; flex-shrink: 0; width: 14px; }
  .sym-green { color: #34d399; } .sym-blue { color: #60a5fa; } .sym-teal { color: #2dd4bf; }
  .ld-log-m { font-family: var(--mono); font-size: 12.5px; color: rgba(255,255,255,0.66); line-height: 1.4; }
  .ld-cursor { display: inline-block; width: 7px; height: 13px; background: #34d399; margin-left: 3px; vertical-align: middle; animation: ldBlink 1.1s step-end infinite; }

  /* ── Pipeline board ── */
  .ld-board { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
  .ld-board-col { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); border-radius: 11px; padding: 11px 9px; }
  .ld-board-col.hot { border-color: rgba(52,211,153,0.4); background: rgba(52,211,153,0.08); }
  .ld-board-head { display: flex; align-items: center; justify-content: space-between; font-size: 11px; font-weight: 600; color: rgba(255,255,255,0.7); margin-bottom: 9px; letter-spacing: -0.01em; }
  .ld-board-col.hot .ld-board-head { color: #6ee7b7; }
  .ld-board-n { font-family: var(--mono); font-size: 11px; color: rgba(255,255,255,0.4); }
  .ld-board-col.hot .ld-board-n { color: #34d399; }
  .ld-board-items { display: flex; flex-direction: column; gap: 5px; }
  .ld-board-card { font-size: 11px; color: rgba(255,255,255,0.7); background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.07); border-radius: 6px; padding: 6px 8px; }
  .ld-board-col.hot .ld-board-card { background: rgba(52,211,153,0.12); border-color: rgba(52,211,153,0.25); color: #d1fae5; }

  /* ── Voice ── */
  .ld-voice-sec { padding-top: 0; }
  .ld-voice { padding: 26px 24px; }
  .ld-voice-wave { display: flex; align-items: center; justify-content: center; gap: 3px; height: 64px; }
  .ld-voice-bar { width: 4px; border-radius: 99px; background: var(--grad); transform-origin: bottom; animation: ldWave 1.4s ease-in-out infinite; }
  .ld-voice-quote { font-size: 13px; color: var(--ink3); font-style: italic; text-align: center; margin: 18px auto 20px; max-width: 380px; line-height: 1.55; }
  .ld-voice-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .ld-voice-field { display: flex; flex-direction: column; gap: 3px; background: var(--paper); border: 1px solid var(--line); border-radius: 10px; padding: 11px 13px; }
  .ld-voice-k { font-family: var(--mono); font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--ink4); }
  .ld-voice-v { font-size: 14px; font-weight: 600; color: var(--ink); letter-spacing: -0.01em; }

  /* ── FAQ ── */
  .ld-faq-sec { background: var(--paper); border-top: 1px solid var(--line); }
  .ld-faq-inner { max-width: 800px; margin: 0 auto; padding: 104px 48px; }
  .ld-faq-list { margin-top: 44px; border-top: 1px solid var(--line-strong); }
  .ld-faq-item { border-bottom: 1px solid var(--line-strong); }
  .ld-faq-q { width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 20px; background: none; border: none; cursor: pointer; padding: 22px 4px; text-align: left; font-family: var(--sans); font-size: 17px; font-weight: 600; letter-spacing: -0.02em; color: var(--ink); transition: color .15s; }
  .ld-faq-q:hover { color: var(--em-deep); }
  .ld-faq-icon { position: relative; width: 14px; height: 14px; flex-shrink: 0; }
  .ld-faq-icon span { position: absolute; background: var(--em); border-radius: 2px; transition: transform .3s cubic-bezier(0.16,1,0.3,1), opacity .3s; }
  .ld-faq-icon span:first-child { top: 6px; left: 0; width: 14px; height: 2px; }
  .ld-faq-icon span:last-child { top: 0; left: 6px; width: 2px; height: 14px; }
  .ld-faq-item.open .ld-faq-icon span:last-child { transform: scaleY(0); opacity: 0; }
  .ld-faq-a-wrap { display: grid; grid-template-rows: 0fr; transition: grid-template-rows 0.48s cubic-bezier(0.16,1,0.3,1); }
  .ld-faq-item.open .ld-faq-a-wrap { grid-template-rows: 1fr; }
  .ld-faq-a { overflow: hidden; padding-top: 0; font-size: 15px; line-height: 1.7; color: var(--ink3); opacity: 0; transform: translateY(-6px); transition: opacity 0.35s ease 0.08s, transform 0.42s cubic-bezier(0.16,1,0.3,1) 0.06s; }
  .ld-faq-a > * { padding: 0 4px 24px; max-width: 660px; }
  .ld-faq-item.open .ld-faq-a { opacity: 1; transform: translateY(0); }

  /* ── CTA ── */
  .ld-cta { position: relative; background: var(--bg); border-top: 1px solid var(--line); overflow: hidden; }
  .ld-cta-dots { position: absolute; inset: 0; background-image: radial-gradient(var(--dotc) 1.2px, transparent 1.3px); background-size: 26px 26px; mask-image: radial-gradient(ellipse 60% 80% at 50% 50%, #000 10%, transparent 70%); -webkit-mask-image: radial-gradient(ellipse 60% 80% at 50% 50%, #000 10%, transparent 70%); }
  .ld-cta-inner { position: relative; max-width: 680px; margin: 0 auto; padding: 116px 48px; text-align: center; display: flex; flex-direction: column; align-items: center; }
  .ld-eyebrow-c { justify-content: center; }
  .ld-cta-h2 { font-weight: 800; font-size: clamp(40px, 6vw, 64px); letter-spacing: -0.045em; line-height: 1.04; color: var(--ink); margin: 0 0 18px; }
  .ld-cta-sub { font-size: 17px; line-height: 1.6; color: var(--ink3); max-width: 460px; margin: 0 0 40px; }
  .ld-cta-actions { display: flex; flex-direction: column; align-items: center; gap: 14px; }
  .ld-btn-skip { color: var(--ink4) !important; font-size: 13px !important; padding: 4px 8px !important; }
  .ld-btn-skip:hover { color: var(--ink3) !important; background: none !important; }
  .ld-cta-note { margin-top: 22px; font-size: 13px; color: var(--ink4); }
  .ld-link { color: var(--em-deep); text-decoration: none; border-bottom: 1px solid var(--tint-b); transition: color .15s; }
  .ld-link:hover { color: var(--em-dark); }

  /* ── Footer ── */
  .ld-footer { border-top: 1px solid var(--line); padding: 34px 48px; display: flex; align-items: center; justify-content: space-between; background: var(--bg); }
  .ld-footer-l { display: flex; align-items: center; gap: 10px; }
  .ld-footer-dom { font-family: var(--mono); font-size: 12px; color: var(--ink4); }
  .ld-footer-copy { font-size: 13px; color: var(--ink4); margin: 0; }

  /* ── Modal ── */
  .ld-modal-bd { position: fixed; inset: 0; z-index: 1000; background: rgba(6,20,14,0.5); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); display: flex; align-items: center; justify-content: center; animation: ldFadeIn .2s ease; }
  .ld-modal { background: #fff; border: 1px solid var(--line-strong); border-radius: 20px; padding: 46px 40px; max-width: 400px; width: 90%; text-align: center; position: relative; animation: ldModalIn .3s cubic-bezier(0.16,1,0.3,1); box-shadow: 0 32px 80px rgba(6,40,24,0.25); }
  .ld-modal-x { position: absolute; top: 16px; right: 16px; background: none; border: none; color: var(--ink4); cursor: pointer; padding: 6px; border-radius: 6px; display: flex; transition: all .15s; }
  .ld-modal-x:hover { color: var(--ink); background: var(--bg2); }
  .ld-modal-logo { font-weight: 800; font-size: 22px; letter-spacing: -0.05em; color: var(--ink); margin-bottom: 20px; }
  .ld-modal-title { font-weight: 700; font-size: 22px; letter-spacing: -0.03em; color: var(--ink); margin: 0 0 10px; }
  .ld-modal-sub { font-size: 14px; line-height: 1.6; color: var(--ink3); margin: 0 0 26px; }
  .ld-btn-google { width: 100%; display: flex; align-items: center; justify-content: center; gap: 12px; background: var(--ink); color: #fff; border: none; font-family: var(--sans); font-size: 15px; font-weight: 600; padding: 14px 24px; border-radius: 99px; cursor: pointer; transition: all .15s; }
  .ld-btn-google:hover { background: var(--em-dark); box-shadow: 0 6px 20px rgba(6,78,59,0.25); transform: translateY(-1px); }
  .ld-modal-note { margin-top: 18px; font-size: 12px; color: var(--ink4); line-height: 1.5; }

  /* ── Keyframes ── */
  @keyframes ldFadeUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes ldFadeIn { from { opacity: 0; } to { opacity: 1; } }
  @keyframes ldModalIn { from { opacity: 0; transform: translateY(16px) scale(0.98); } to { opacity: 1; transform: translateY(0) scale(1); } }
  @keyframes ldSlideIn { from { opacity: 0; transform: translateX(-8px); } to { opacity: 1; transform: translateX(0); } }
  @keyframes ldBlink { 0%,100% { opacity: 1; } 50% { opacity: 0; } }
  @keyframes ldMarquee { from { transform: translateX(0); } to { transform: translateX(-50%); } }
  @keyframes ldPulse { 0%,100% { box-shadow: 0 0 0 0 rgba(5,150,105,0.4); } 50% { box-shadow: 0 0 0 5px rgba(5,150,105,0); } }
  @keyframes ldBeam { 0% { left: -30%; } 55%,100% { left: 110%; } }
  @keyframes ldTilePop { from { opacity: 0; transform: scale(0.94); } to { opacity: 1; transform: scale(1); } }
  @keyframes ldWave { 0%,100% { transform: scaleY(0.45); } 50% { transform: scaleY(1); } }
  @keyframes ldConn { 0% { left: 0; opacity: 0; } 20% { opacity: 1; } 80% { opacity: 1; } 100% { left: 100%; opacity: 0; } }
  @keyframes ldDash { to { stroke-dashoffset: -18; } }

  @media (prefers-reduced-motion: reduce) {
    .ld-voice-bar, .ld-scan-beam, .ld-flow-pulse, .ld-wire.on, .ld-marquee-track { animation: none !important; }
  }

  /* ── Responsive ── */
  @media (max-width: 980px) {
    .ld-nav { padding: 0 22px; }
    .ld-nav-links { display: none; }
    .ld-section, .ld-cap-inner, .ld-dark-inner, .ld-faq-inner { padding: 76px 24px; }
    .ld-flow-grid { grid-template-columns: 1fr; gap: 16px; }
    .ld-flow-conn { display: none; }
    .ld-panel, .ld-panel.reverse { grid-template-columns: 1fr; gap: 32px; direction: ltr; padding: 44px 0; }
    .ld-dark-grid { grid-template-columns: 1fr; gap: 40px; }
    .ld-steps { grid-template-columns: 1fr; }
    .ld-step { border-right: none; border-bottom: 1px solid var(--line); }
    .ld-step.last { border-bottom: none; }
    .ld-bigstat-row { grid-template-columns: repeat(2, 1fr); }
    .ld-bigstat-cell:nth-child(2) { border-right: none; }
    .ld-bigstat-cell:nth-child(1), .ld-bigstat-cell:nth-child(2) { border-bottom: 1px solid rgba(255,255,255,0.1); }
    .ld-cta-inner { padding: 84px 24px; }
    .ld-footer { flex-direction: column; gap: 12px; text-align: center; padding: 28px 24px; }
    .ld-hero { padding: 64px 20px 44px; }
  }
  @media (max-width: 560px) {
    .ld-bigstat-row { grid-template-columns: 1fr 1fr; }
    .ld-board { grid-template-columns: 1fr 1fr; }
    .ld-scan-grid { grid-template-columns: repeat(4, 1fr); }
    .ld-router { grid-template-columns: 1fr; gap: 16px; }
    .ld-router-wires { display: none; }
    .ld-voice-fields { grid-template-columns: 1fr; }
  }
`