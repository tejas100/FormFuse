import { useState, useEffect, createContext, useContext } from 'react'

// ── Theme context ──────────────────────────────────────────────────────────────
export const ThemeContext = createContext({ theme: 'dark', toggleTheme: () => {} })
export function useTheme() { return useContext(ThemeContext) }

function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(() => {
    return localStorage.getItem('rack_theme') || 'dark'
  })

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('rack_theme', theme)
  }, [theme])

  const toggleTheme = () => setTheme(t => t === 'dark' ? 'light' : 'dark')

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  )
}
import { AuthProvider, useAuth } from './context/AuthContext'
import WelcomeSlideshow, { useFirstVisit } from './components/WelcomeSlideshow'
import TabBar, { MobileMenu } from './components/TabBar'
import Home from './pages/Home'
import Resumes from './pages/Resumes'
import Tracking from './pages/Tracking'
import Account from './pages/Account'

// 1. Import at the top
import Landing from './pages/Landing'
import Onboarding from './pages/Onboarding'
import Dashboard from './pages/Dashboard'
import ApplicationBoard from './pages/ApplicationBoard'
import RackMail from './pages/RackMail'



const PAGE_MAP = { Home, Resumes, Tracking, Account }

// Tabs that require authentication
const AUTH_REQUIRED_TABS = ['Tracking', 'TrackApps']

// ── Inner app — has access to AuthContext ─────────────────────────────────────
function AppInner() {
  const [active, setActive] = useState('Home')
  const [pageKey, setPageKey] = useState(0)
  const [steelPanelOpen, setSteelPanelOpen] = useState(false)
  // showLanding: null = waiting for auth to resolve, true = show landing, false = skip to app
  const [showLanding, setShowLanding] = useState(null)
  const [skipping, setSkipping] = useState(false)
  // showOnboarding: null = resolving, true = show wizard, false = already complete
  const [showOnboarding, setShowOnboarding] = useState(null)
  // showDashboard: authenticated users land on Dashboard; set false to eject to classic tab layout
  const [showDashboard, setShowDashboard] = useState(true)
  const { user, session, authLoading, signInWithGoogle } = useAuth()
  const { theme } = useTheme()
  const { show: showWelcome, dismiss: dismissWelcome } = useFirstVisit()

  // ── Landing gate: decide once auth resolves ──────────────────────────────
  useEffect(() => {
    if (authLoading) return           // still resolving — wait
    if (user) {
      setShowLanding(false)           // logged in → skip landing entirely
    } else if (showLanding === null) {
      setShowLanding(true)            // first resolution, no user → show landing
      setShowOnboarding(false)        // no user → no onboarding
    }
    // If showLanding is already false (user clicked "Skip"), don't reset it
  }, [authLoading, user]) // eslint-disable-line

  // ── Onboarding gate: check if new user needs wizard ─────────────────────
  // Fires once per sign-in. Reads preferences.onboarding_complete from DB.
  // If not set → show the wizard. If already done → skip straight to Dashboard.
  useEffect(() => {
    if (!user || !session?.access_token) return
    // Only check once (null = not checked yet)
    if (showOnboarding !== null) return

    fetch(`${import.meta.env.VITE_API_URL || 'http://localhost:8000'}/api/account/profile`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
      .then(r => r.ok ? r.json() : {})
      .then(prefs => {
        // Skip wizard if: explicitly completed, OR already has roles (pre-wizard account)
        const alreadySetUp = prefs.onboarding_complete || (prefs.target_roles || []).length > 0
        setShowOnboarding(!alreadySetUp)
      })
      .catch(() => {
        // Network error — fail open, don't trap user in onboarding check
        setShowOnboarding(false)
      })
  }, [user, session]) // eslint-disable-line

  const switchTab = (tab) => {
    setActive(tab)
    setPageKey(k => k + 1)
  }

  // Fluid landing → home transition — rack wordmark zooms to fill screen
  const handleSkip = () => {
    setSkipping(true)
    setTimeout(() => setShowLanding(false), 320)   // Home mounts under overlay
    setTimeout(() => setSkipping(false), 960)      // Overlay gone, Home visible
  }

  // ── rack:navigate — fired by Home.jsx "Open Tracking ✦" buttons ──
  useEffect(() => {
    const handler = (e) => {
      const tab = e.detail?.tab
      if (tab && PAGE_MAP[tab]) switchTab(tab)
    }
    window.addEventListener('rack:navigate', handler)
    return () => window.removeEventListener('rack:navigate', handler)
  }, []) // eslint-disable-line

  // ── rack:steel-panel — fired by Home.jsx when Steel viewer opens/closes ──
  useEffect(() => {
    const handler = (e) => setSteelPanelOpen(!!e.detail?.open)
    window.addEventListener('rack:steel-panel', handler)
    return () => window.removeEventListener('rack:steel-panel', handler)
  }, [])

  const ActivePage = PAGE_MAP[active]

  // Is this tab gated and the user is not signed in?
  const isGated = AUTH_REQUIRED_TABS.includes(active) && !user && !authLoading

  // ── Still resolving auth — render nothing to avoid flash ────────────────
  if (authLoading && showLanding === null) return null

  // ── Onboarding wizard — new authenticated users only ────────────────────
  // showOnboarding === null means we're still fetching their profile.
  // We show nothing (null) rather than flashing the app underneath.
  if (user && showOnboarding === null) return null
  if (user && showOnboarding === true) {
    return (
      <Onboarding
        user={user}
        onComplete={() => setShowOnboarding(false)}
      />
    )
  }

  // ── Dashboard — all authenticated users after onboarding ─────────────────
  // Full-screen layout with its own sidebar — bypasses TabBar/blobs/logo.
  // onNavigate('Tracking') etc. ejects into the classic tab layout for those pages.
  if (user && showOnboarding === false && showDashboard) {
    return (
      <Dashboard
        onNavigate={(tab) => {
          if (tab === 'Dashboard') return  // already here
          setShowDashboard(false)
          setActive(tab)
          setPageKey(k => k + 1)
        }}
      />
    )
  }

  // Overlay — white flash + "rack" wordmark zooms to fill screen, then fades
  const overlay = skipping ? (
    <div aria-hidden="true" style={{
      position: "fixed", inset: 0, zIndex: 9999,
      background: "#ffffff",
      display: "flex", alignItems: "center", justifyContent: "center",
      pointerEvents: "all",
      animation: "rackOverlayFadeIn 0.28s cubic-bezier(0.4,0,0.2,1) both",
    }}>
      <span style={{
        fontFamily: "'Geist', -apple-system, BlinkMacSystemFont, sans-serif",
        fontWeight: 800,
        letterSpacing: "-0.05em",
        color: "#06140e",
        fontSize: "clamp(40px, 8vw, 72px)",
        animation: "rackWordmarkZoom 0.72s cubic-bezier(0.16,1,0.3,1) 0.18s both",
        display: "inline-block",
        transformOrigin: "center center",
        willChange: "transform, opacity",
      }}>rack</span>
      <style>{`
        @keyframes rackOverlayFadeIn {
          from { opacity: 0; }
          to   { opacity: 1; }
        }
        @keyframes rackWordmarkZoom {
          0%   { transform: scale(1);    opacity: 1; }
          60%  { transform: scale(5);    opacity: 1; }
          100% { transform: scale(12);   opacity: 0; }
        }
      `}</style>
    </div>
  ) : null

  // ── Landing page ─────────────────────────────────────────────────────────
  if (showLanding) {
    return (
      <>
        <Landing
          onEnter={signInWithGoogle}
          onSkip={handleSkip}
        />
        {overlay}
      </>
    )
  }

  // ── Application board — job-application tracker, shares the sidebar shell ──
  if (active === 'TrackApps' && !isGated) {
    return (
      <>
        {overlay}
        <ApplicationBoard onNavigate={(tab) => {
          if (tab === 'Dashboard') { setShowDashboard(true) }
          else { switchTab(tab) }
        }} />
      </>
    )
  }

  // ── Tracking — renders its own full-screen sidebar layout, no shell needed ──
  if (active === 'Tracking' && !isGated) {
    return (
      <>
        {overlay}
        <Tracking onNavigate={(tab) => {
          if (tab === 'Dashboard') { setShowDashboard(true) }
          else { switchTab(tab) }
        }} />
      </>
    )
  }

  // ── Emails (RackMail) — full-screen sidebar layout, same pattern as Tracking ──
  if (active === 'Emails') {
    return (
      <>
        {overlay}
        <RackMail
          onNavigate={(tab) => {
            if (tab === 'Dashboard') { setShowDashboard(true) }
            else { switchTab(tab) }
          }}
          userName={user?.user_metadata?.full_name?.split(' ')[0] || 'You'}
        />
      </>
    )
  }

  if (active === 'Resumes' && !isGated) {
    return (
      <>
        {overlay}
        <Resumes onNavigate={(tab) => {
          if (tab === 'Dashboard') { setShowDashboard(true) }
          else { switchTab(tab) }
        }} />
      </>
    )
  }

  if (active === 'Account' && !isGated) {
    return (
      <>
        {overlay}
        <Account onNavigate={(tab) => {
          if (tab === 'Dashboard') { setShowDashboard(true) }
          else { switchTab(tab) }
        }} />
      </>
    )
  }

  return (
    <>
    {overlay}
    <div className="app">
      <div className="blob blob-1" />
      <div className="blob blob-2" />
      <div className="blob blob-3" />
      <div className="grain" />

      <div className="logo">
        <div className="logo-dot" />
        Rack
      </div>
      <a
        href="https://tejasbk.dev"
        target="_blank"
        rel="noopener noreferrer"
        className="byline-link"
      >
         / by Tejas BK
      </a>

      <TabBar active={active} onSwitch={switchTab} steelOpen={steelPanelOpen} />

      {isGated ? (
        <GateScreen tab={active} onSignIn={signInWithGoogle} />
      ) : (
        <ActivePage key={pageKey} />
      )}

      <style>{`
        .app {
          width: 100vw; height: 100vh;
          display: flex; flex-direction: column;
          align-items: center; position: relative; overflow: clip;
        }

        /* ── Blobs ── */
        .blob {
          position: fixed; border-radius: 50%;
          filter: blur(80px); opacity: 0.35;
          pointer-events: none;
          animation: noiseDrift 12s ease-in-out infinite;
        }
        .blob-1 { width:500px;height:500px;background:var(--blob-1);top:-100px;left:-100px; }
        .blob-2 { width:400px;height:400px;background:var(--blob-2);bottom:-80px;right:-80px;animation-delay:-6s; }
        .blob-3 { width:300px;height:300px;background:var(--blob-3);top:40%;left:30%;animation-delay:-3s; }

        /* ── Grain ── */
        .grain {
          position:fixed;inset:0;pointer-events:none;opacity:0.04;
          background-image:url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E");
          background-size:128px;
        }

        /* ── Byline ── */
        @keyframes byline-shimmer {
          0%   { background-position: -200px 0; }
          100% { background-position:  200px 0; }
        }
        .byline-link {
          position: fixed;
          top: 58px;
          left: 45px;
          font-size: 10px;
          font-weight: 500;
          letter-spacing: 0.3px;
          text-decoration: none;
          z-index: 100;
          background: linear-gradient(
            90deg,
            rgba(232,255,107,0.25) 0%,
            rgba(232,255,107,0.9) 40%,
            rgba(232,255,107,0.25) 80%
          );
          background-size: 200px 100%;
          -webkit-background-clip: text;
          background-clip: text;
          -webkit-text-fill-color: transparent;
          animation: byline-shimmer 8.0s ease-in-out infinite;
          cursor: pointer;
        }
        .byline-link:hover {
          animation-play-state: paused;
          background: linear-gradient(
            90deg,
            rgba(232,255,107,0.9) 0%,
            rgba(232,255,107,0.9) 100%
          );
          -webkit-background-clip: text;
          background-clip: text;
        }
        /* Light: lime shimmer is illegible on paper — fall back to a clean ink byline */
        [data-theme="light"] .byline-link,
        [data-theme="light"] .byline-link:hover {
          background: none;
          -webkit-text-fill-color: var(--text-dim);
          color: var(--text-dim);
          animation: none;
        }
        [data-theme="light"] .byline-link:hover { -webkit-text-fill-color: var(--text-mid); color: var(--text-mid); }
        @media (max-width: 600px) {
          .byline-link {
            position: fixed;
            top: 48px;
            left: 54%;
            transform: translateX(-50%);
            z-index: 201;
            font-size: 9px;
          }
        }

        /* ── Logo ── */
        .logo {
          position: fixed;
          top: 32px;
          left: 40px;
          font-family: var(--font-display);
          font-size: 22px;
          font-weight: 800;
          letter-spacing: -0.5px;
          color: var(--text);
          z-index: 100;
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .logo-dot {
          width: 8px; height: 8px;
          background: var(--accent);
          border-radius: 50%;
          animation: pulse-ring 2.5s ease infinite;
        }

        /* ── Mobile overrides ── */
        @media (max-width: 600px) {
          .logo { display: none; }
          .mobile-header { display: grid !important; }
        }

        /* Mobile top bar */
        .mobile-header {
          display: none;
          position: fixed;
          top: 0; left: 0; right: 0;
          z-index: 200;
          height: 65px;
          grid-template-columns: 54px 1fr 54px;
          align-items: center;
          padding: 0 16px;
          background: linear-gradient(
            to bottom,
            var(--mobile-header-bg-start) 0%,
            var(--mobile-header-bg-mid) 60%,
            var(--mobile-header-bg-end) 80%,
            rgba(0,0,0,0.0) 130%
          );
        }
        .mobile-header-left {
          display: flex;
          align-items: center;
          justify-content: flex-start;
        }
        .mobile-header::after {
          content: '';
          position: absolute;
          top: 100%;
          left: 0; right: 0;
          height: 28px;
          background: linear-gradient(
            to bottom,
            var(--mobile-header-bg-end) 0%,
            rgba(0,0,0,0.0) 100%
          );
          pointer-events: none;
        }
        .mobile-header-logo {
          font-family: var(--font-display);
          font-size: 32px;
          font-weight: 800;
          letter-spacing: -0.5px;
          color: var(--text);
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 7px;
        }
        .mobile-header-dot {
          width: 7px; height: 7px;
          background: var(--accent);
          border-radius: 50%;
          animation: pulse-ring 2.5s ease infinite;
        }

        /* ── Gate screen ── */
        .gate-screen {
          position: absolute;
          inset: 0;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: flex-start;
          padding: 40px 24px;
          padding-top: calc(var(--page-padding-top, 100px) + 40px);
          overflow-y: auto;
          overflow-x: hidden;
          -webkit-overflow-scrolling: touch;
          animation: fadeUp 0.4s ease both;
          z-index: 10;
        }
        @media (max-width: 600px) {
          .gate-screen {
            padding: 16px 16px calc(24px + env(safe-area-inset-bottom, 0px));
            padding-top: calc(65px + 40px);
            justify-content: flex-start;
          }
        }
        .gate-card {
          width: 100%;
          max-width: 400px;
          background: var(--surface);
          border: 1px solid var(--border-bright);
          border-radius: var(--radius);
          padding: 36px 32px;
          text-align: center;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 0;
        }
        .gate-icon {
          font-size: 36px;
          margin-bottom: 16px;
        }
        .gate-title {
          font-family: var(--font-display);
          font-size: 20px;
          font-weight: 700;
          color: var(--text);
          letter-spacing: -0.3px;
          margin-bottom: 10px;
        }
        .gate-subtitle {
          font-size: 13px;
          color: var(--text-dim);
          line-height: 1.6;
          margin-bottom: 28px;
          max-width: 300px;
        }
        .gate-btn-google {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 13px 28px;
          border-radius: 30px;
          border: 1px solid var(--border-bright);
          background: var(--surface2);
          color: var(--text);
          font-family: var(--font-body);
          font-size: 14px;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.2s;
          width: 100%;
          justify-content: center;
          margin-bottom: 12px;
        }
        .gate-btn-google:hover {
          background: var(--surface2);
          border-color: var(--border-bright);
        }
        .gate-perks {
          display: flex;
          flex-direction: column;
          gap: 8px;
          margin-top: 20px;
          width: 100%;
          text-align: left;
        }
        .gate-perk {
          display: flex;
          align-items: center;
          gap: 10px;
          font-size: 12px;
          color: var(--text-dim);
        }
        .gate-perk-dot {
          width: 5px;
          height: 5px;
          border-radius: 50%;
          background: var(--accent);
          flex-shrink: 0;
        }
      `}</style>

      <div className="mobile-header">
        <div className="mobile-header-left">
          <MobileMenu active={active} onSwitch={switchTab} />
        </div>
        <div className="mobile-header-logo">
          <div className="mobile-header-dot" />
          Rack
        </div>
        <div style={{ width: 54 }} />
      </div>

      {showWelcome && <WelcomeSlideshow onDismiss={dismissWelcome} />}
    </div>
    </>
  )
}

// ── Gate screen — shown for auth-required tabs when signed out ────────────────
// ─────────────────────────────────────────────────────────────────────────────
// INSTRUCTIONS: In App.jsx, find `function GateScreen` and replace the
// ENTIRE function (from `function GateScreen` through its closing `}`) with
// the code below. Everything else in App.jsx stays exactly the same.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// INSTRUCTIONS: In App.jsx, find `function GateScreen` and replace the
// ENTIRE function (from `function GateScreen` through its closing `}`) with
// the code below. Everything else in App.jsx stays exactly the same.
// ─────────────────────────────────────────────────────────────────────────────

function GateScreen({ tab, onSignIn }) {

  const icons = {
    scan: (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
        <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.2"/>
        <path d="M8 4.5V8l2 2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
      </svg>
    ),
    rank: (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
        <path d="M2 3h12M2 7h8M2 11h5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
        <circle cx="13" cy="11" r="2.5" stroke="currentColor" strokeWidth="1.2"/>
      </svg>
    ),
    funnel: (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
        <path d="M2 3h12l-4.5 5v5l-3-1.5V8L2 3Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
      </svg>
    ),
  }

  const gateContent = {
    Tracking: {
      title: 'Your matched jobs,\ntracked end-to-end.',
      subtitle: 'RACK surfaces roles from 150+ company boards every hour. This is where you work them.',
      perks: [
        {
          icon: 'scan',
          title: 'Auto-surfaced from 150+ boards',
          sub: 'Greenhouse, Ashby, and Lever, checked hourly. New roles land here before most applicants see them.',
        },
        {
          icon: 'rank',
          title: 'AI-ranked against your actual resume',
          sub: 'Every match is scored by Rack on your real resume text. Score reflects true fit, not keyword overlap.',
        },
        {
          icon: 'funnel',
          title: 'Full funnel in one view',
          sub: 'Star a role, mark applied, track to offer. Nothing falls through a spreadsheet crack.',
        },
      ],
    },
  }

  const content = gateContent[tab] || {
    title: 'Sign in to continue',
    subtitle: 'This feature requires an account.',
    perks: [],
  }

  const titleLines = content.title.split('\n')

  return (
    <div style={{
      position: 'absolute', inset: 0,
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-start',
      padding: '24px 20px',
      paddingTop: 'calc(var(--page-padding-top, 100px) + 40px)',
      paddingBottom: 'calc(24px + env(safe-area-inset-bottom, 0px))',
      overflowY: 'auto',
      overflowX: 'hidden',
      WebkitOverflowScrolling: 'touch',
    }}>
      <div style={{ width: '100%', maxWidth: 400, animation: 'fadeUp 0.35s ease both' }}>

        {/* ── Icon ── */}
        <div style={{
          width: 44, height: 44, borderRadius: 11,
          background: 'rgba(232,255,107,0.06)',
          border: '1px solid rgba(232,255,107,0.12)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          marginBottom: 20, margin: '0 auto 20px',
        }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
            <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"
              stroke="rgba(232,255,107,0.75)" strokeWidth="1.5" strokeLinecap="round"/>
            <rect x="9" y="3" width="6" height="4" rx="1"
              stroke="rgba(232,255,107,0.75)" strokeWidth="1.5"/>
            <path d="M9 12h6M9 16h4"
              stroke="rgba(232,255,107,0.75)" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
        </div>

        {/* ── Title + subtitle ── */}
        <div style={{
          fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 700,
          color: 'var(--text)', letterSpacing: '-0.5px', lineHeight: 1.2,
          marginBottom: 10, textAlign: 'center',
        }}>
          {titleLines.map((line, i) => (
            <span key={i}>{line}{i < titleLines.length - 1 && <br />}</span>
          ))}
        </div>
        <div style={{
          fontSize: 13, color: 'var(--text-dim)', lineHeight: 1.65, marginBottom: 24, textAlign: 'center',
        }}>
          {content.subtitle}
        </div>

        {/* ── Feature rows ── */}
        {content.perks.length > 0 && (
          <div style={{
            background: 'var(--surface)', border: '1px solid var(--border)',
            borderRadius: 14, overflow: 'hidden', marginBottom: 20,
          }}>
            {content.perks.map(({ icon, title, sub }, i) => (
              <div key={i} style={{
                display: 'flex', gap: 14, padding: '14px 18px',
                borderBottom: i < content.perks.length - 1
                  ? '1px solid var(--border)' : 'none',
              }}>
                {/* Icon pill */}
                <div style={{
                  width: 28, height: 28, flexShrink: 0, borderRadius: 8,
                  background: 'rgba(232,255,107,0.06)',
                  border: '1px solid rgba(232,255,107,0.12)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: 'rgba(232,255,107,0.7)', marginTop: 1,
                }}>
                  {icons[icon]}
                </div>
                {/* Text */}
                <div>
                  <div style={{
                    fontSize: 13, fontWeight: 600, color: 'var(--text)',
                    marginBottom: 3, letterSpacing: '-0.1px',
                  }}>
                    {title}
                  </div>
                  <div style={{
                    fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.55,
                  }}>
                    {sub}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ── Google sign-in button ── */}
        <button
          onClick={onSignIn}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
            width: '100%', padding: '14px 24px', borderRadius: 30,
            border: '1px solid var(--border-bright)',
            background: 'var(--surface)',
            color: 'var(--text)', fontFamily: 'var(--font-body)',
            fontSize: 14, fontWeight: 600, cursor: 'pointer',
            transition: 'background 0.18s',
          }}
          onMouseEnter={e => e.currentTarget.style.background = 'var(--surface2)'}
          onMouseLeave={e => e.currentTarget.style.background = 'var(--surface)'}
        >
          <GoogleIcon size={18} />
          Continue with Google
        </button>

        {/* ── Privacy note ── */}
        <div style={{
          textAlign: 'center', marginTop: 14,
          fontSize: 11, color: 'var(--text-dim)', opacity: 0.5, lineHeight: 1.6,
        }}>
          We store your email and resume data only.<br />
          Nothing is sold, shared, or used for advertising.
        </div>

      </div>
    </div>
  )
}

// ── Google SVG icon ───────────────────────────────────────────────────────────
function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
      <path d="M17.64 9.205c0-.639-.057-1.252-.164-1.841H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615Z" fill="#4285F4"/>
      <path d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18Z" fill="#34A853"/>
      <path d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332Z" fill="#FBBC05"/>
      <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58Z" fill="#EA4335"/>
    </svg>
  )
}

// ── Root export — wraps everything in AuthProvider ────────────────────────────
export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <AppInner />
      </AuthProvider>
    </ThemeProvider>
  )
}