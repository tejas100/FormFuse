import { useState } from 'react'
import { AuthProvider, useAuth } from './context/AuthContext'
import TabBar from './components/TabBar'
import Home from './pages/Home'
import Resumes from './pages/Resumes'
import Tracking from './pages/Tracking'
import Account from './pages/Account'

const PAGE_MAP = { Home, Resumes, Tracking, Account }

// Tabs that require authentication
const AUTH_REQUIRED_TABS = ['Tracking']

// ── Inner app — has access to AuthContext ─────────────────────────────────────
function AppInner() {
  const [active, setActive] = useState('Home')
  const [pageKey, setPageKey] = useState(0)
  const { user, authLoading, signInWithGoogle } = useAuth()

  const switchTab = (tab) => {
    setActive(tab)
    setPageKey(k => k + 1)
  }

  const ActivePage = PAGE_MAP[active]

  // Is this tab gated and the user is not signed in?
  const isGated = AUTH_REQUIRED_TABS.includes(active) && !user && !authLoading

  return (
    <div className="app">
      <div className="blob blob-1" />
      <div className="blob blob-2" />
      <div className="blob blob-3" />
      <div className="grain" />

      <div className="logo">
        <div className="logo-dot" />
        Rack
      </div>

      <TabBar active={active} onSwitch={switchTab} />

      {isGated ? (
        <GateScreen tab={active} onSignIn={signInWithGoogle} />
      ) : (
        <ActivePage key={pageKey} />
      )}

      <style>{`
        .app {
          width: 100vw; height: 100vh;
          display: flex; flex-direction: column;
          align-items: center; position: relative; overflow: hidden;
        }

        /* ── Blobs ── */
        .blob {
          position: fixed; border-radius: 50%;
          filter: blur(80px); opacity: 0.35;
          pointer-events: none;
          animation: noiseDrift 12s ease-in-out infinite;
        }
        .blob-1 { width:500px;height:500px;background:#1a1a2e;top:-100px;left:-100px; }
        .blob-2 { width:400px;height:400px;background:#0d1f0d;bottom:-80px;right:-80px;animation-delay:-6s; }
        .blob-3 { width:300px;height:300px;background:#1a0a2e;top:40%;left:30%;animation-delay:-3s; }

        /* ── Grain ── */
        .grain {
          position:fixed;inset:0;pointer-events:none;opacity:0.04;
          background-image:url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E");
          background-size:128px;
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
          .mobile-header { display: flex !important; }
        }

        /* Mobile top bar */
        .mobile-header {
          display: none;
          position: fixed;
          top: 0; left: 0; right: 0;
          z-index: 200;
          height: 52px;
          align-items: center;
          justify-content: center;
          background: linear-gradient(
            to bottom,
            rgba(8,8,8,0.96) 0%,
            rgba(8,8,8,0.85) 60%,
            rgba(8,8,8,0.0) 100%
          );
        }
        .mobile-header::after {
          content: '';
          position: absolute;
          top: 100%;
          left: 0; right: 0;
          height: 28px;
          background: linear-gradient(
            to bottom,
            rgba(8,8,8,0.25) 0%,
            rgba(8,8,8,0.0) 100%
          );
          pointer-events: none;
        }
        .mobile-header-logo {
          font-family: var(--font-display);
          font-size: 20px;
          font-weight: 800;
          letter-spacing: -0.5px;
          color: var(--text);
          display: flex;
          align-items: center;
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
          justify-content: center;
          padding: 40px 24px;
          animation: fadeUp 0.4s ease both;
          z-index: 10;
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
          background: rgba(255,255,255,0.07);
          border-color: rgba(255,255,255,0.2);
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
        <div className="mobile-header-logo">
          <div className="mobile-header-dot" />
          Rack
        </div>
      </div>
    </div>
  )
}

// ── Gate screen — shown for auth-required tabs when signed out ────────────────
function GateScreen({ tab, onSignIn }) {
  const gateContent = {
    Tracking: {
      icon: '📋',
      title: 'Track your applications',
      subtitle: 'Sign in to save jobs, track your application status, and never lose track of an opportunity.',
      perks: [
        'Save jobs from Auto Matches with one click',
        'Track status: Applied → Interview → Offer',
        'Notes and reminders per application',
      ],
    },
  }

  const content = gateContent[tab] || {
    icon: '🔒',
    title: 'Sign in to continue',
    subtitle: 'This feature requires an account.',
    perks: [],
  }

  return (
    <div className="gate-screen">
      <div className="gate-card">
        <div className="gate-icon">{content.icon}</div>
        <div className="gate-title">{content.title}</div>
        <div className="gate-subtitle">{content.subtitle}</div>

        <button className="gate-btn-google" onClick={onSignIn}>
          <GoogleIcon />
          Continue with Google
        </button>

        {content.perks.length > 0 && (
          <div className="gate-perks">
            {content.perks.map(p => (
              <div key={p} className="gate-perk">
                <div className="gate-perk-dot" />
                {p}
              </div>
            ))}
          </div>
        )}
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
    <AuthProvider>
      <AppInner />
    </AuthProvider>
  )
}