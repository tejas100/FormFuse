/**
 * Sidebar.jsx — RACK shared sidebar component
 *
 * Props:
 *   activeNav    {string}   — currently active nav item id
 *   onNavigate   {fn}       — (tabId: string) => void — called on nav click
 *   userName     {string}   — first name for user card
 *   userInitial  {string}   — single letter for mobile avatar
 *   badge        {object}   — { BrowseAll: number, … } optional per-item badge overrides
 *   extraNav     {array}    — optional extra nav items to render below the divider (e.g. Tracking sub-views)
 *   extraNavLabel {string}  — label shown above extraNav (default "VIEWS")
 *   onAskRack    {fn}       — if provided, renders Ask Rack button and calls this on click
 *   userStats    {node}     — optional custom node rendered in place of the default user card bottom area
 *   theme        {string}   — 'dark' | 'light'
 *   onToggleTheme {fn}      — called when theme toggle clicked
 */

import { useState } from 'react'

// ── Icons (shared) ─────────────────────────────────────────────────────────────

const ICONS = {
  Matches:   <svg width={17} height={17} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="5" height="5" rx="1.4"/><rect x="9" y="2" width="5" height="5" rx="1.4"/><rect x="2" y="9" width="5" height="5" rx="1.4"/><rect x="9" y="9" width="5" height="5" rx="1.4"/></svg>,
  BrowseAll: <svg width={17} height={17} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M2 4h12M2 8h7M2 12h4"/><circle cx="12" cy="11.5" r="2.4"/><path d="M13.7 13.2L15 14.5"/></svg>,
  Home:      <svg width={17} height={17} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"/></svg>,
  Resumes:   <svg width={17} height={17} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="1.5" width="10" height="13" rx="1.6"/><path d="M6 5h4M6 8h4M6 11h2.5"/></svg>,
  Tracking:  <svg width={17} height={17} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M5 6h6M5 9h4"/></svg>,
  Account:   <svg width={17} height={17} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><circle cx="8" cy="5" r="3"/><path d="M2.5 14c0-3 2.4-4.6 5.5-4.6S13.5 11 13.5 14"/></svg>,
  Logo:      <svg width={17} height={17} viewBox="0 0 16 16" fill="none" stroke="var(--accent-contrast)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 11V5l6-3 6 3v6l-6 3z"/><path d="M8 8l6-3M8 8v6M8 8L2 5"/></svg>,
  Sun:       <svg width={17} height={17} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="8" cy="8" r="3.2"/><path d="M8 1v1.6M8 13.4V15M15 8h-1.6M2.6 8H1M12.5 3.5l-1.1 1.1M4.6 11.4l-1.1 1.1M12.5 12.5l-1.1-1.1M4.6 4.6L3.5 3.5"/></svg>,
  Moon:      <svg width={17} height={17} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M13.5 9.2A5.6 5.6 0 0 1 6.8 2.5 5.6 5.6 0 1 0 13.5 9.2z"/></svg>,
  Chevron:   (flipped) => <svg width={12} height={12} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ transform: flipped ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}><path d="M10 4l-4 4 4 4"/></svg>,
  Hamburger: <svg width={16} height={16} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M2 4h12M2 8h12M2 12h12"/></svg>,
  Close:     <svg width={14} height={14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>,
  Star:      <svg width={13} height={13} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M8 1.5l1.8 4.2 4.7.4-3.6 3 1.1 4.6L8 11.3 4 13.7l1.1-4.6-3.6-3 4.7-.4z"/></svg>,
  Ask:       <svg width={16} height={16} viewBox="0 0 16 16" fill="none" stroke="var(--accent-ink)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"/></svg>,
}

// ── Default top-level nav items ────────────────────────────────────────────────

export const DEFAULT_NAV = [
  { id: 'Dashboard', label: 'Matches',        icon: ICONS.Matches   },
  { id: 'Tracking',  label: 'Browse all jobs', icon: ICONS.BrowseAll },
  { id: 'Home',      label: 'Chat assistant',  icon: ICONS.Home      },
  { id: 'Resumes',   label: 'Resumes',         icon: ICONS.Resumes   },
  { id: 'Account',   label: 'Account',         icon: ICONS.Account   },
]

// ── NavItem ────────────────────────────────────────────────────────────────────

function NavItem({ icon, label, active, badge, onClick, collapsed }) {
  const [hovered, setHovered] = useState(false)
  return (
    <div
      title={collapsed ? label : undefined}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex', alignItems: 'center',
        gap: collapsed ? 0 : 12,
        padding: collapsed ? '11px 0' : '11px 13px',
        justifyContent: collapsed ? 'center' : 'flex-start',
        borderRadius: 11, cursor: 'pointer', fontSize: 14,
        fontWeight: active ? 600 : 500,
        border: active ? '1px solid var(--accent-line)' : '1px solid transparent',
        background: active ? 'var(--accent-soft)' : hovered ? 'var(--surface2)' : 'transparent',
        color: active ? 'var(--text)' : hovered ? 'var(--text)' : 'var(--text-mid)',
        transition: 'background 0.18s, color 0.15s, border-color 0.18s',
        userSelect: 'none', position: 'relative',
      }}>
      <span style={{ color: active ? 'var(--accent-ink)' : 'inherit', display: 'flex', flexShrink: 0 }}>
        {icon}
      </span>
      {!collapsed && <span style={{ overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{label}</span>}
      {!collapsed && badge != null && badge > 0 && (
        <span style={{
          marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 600,
          color: active ? 'var(--accent-ink)' : 'var(--text-dim)',
          background: active ? 'var(--accent-soft)' : 'var(--chip-bg)',
          padding: '2px 7px', borderRadius: 20, flexShrink: 0,
          border: active ? '1px solid var(--accent-line)' : 'none',
        }}>{badge}</span>
      )}
      {collapsed && active && (
        <span style={{
          position: 'absolute', left: 2, top: '50%', transform: 'translateY(-50%)',
          width: 3, height: 18, borderRadius: 3, background: 'var(--accent)',
        }}/>
      )}
    </div>
  )
}

// ── Logo ───────────────────────────────────────────────────────────────────────

function Logo({ collapsed, size = 32 }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 6px 22px', overflow: 'hidden' }}>
      <div style={{
        width: size, height: size, borderRadius: 9, flexShrink: 0,
        background: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center',
        boxShadow: 'var(--accent-glow)',
      }}>
        {ICONS.Logo}
      </div>
      <span style={{
        fontFamily: 'var(--font-mono)', fontWeight: 600, fontSize: 18, letterSpacing: '0.02em',
        opacity: collapsed ? 0 : 1, maxWidth: collapsed ? 0 : 120,
        overflow: 'hidden', whiteSpace: 'nowrap',
        transition: 'opacity 0.15s, max-width 0.2s',
      }}>
        RACK
      </span>
    </div>
  )
}

// ── AskRackBtn ─────────────────────────────────────────────────────────────────

function AskRackBtn({ onClick }) {
  const [hov, setHov] = useState(false)
  return (
    <button onClick={onClick}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 12, padding: 13,
        borderRadius: 13, cursor: 'pointer', width: '100%', textAlign: 'left',
        border: `1px solid ${hov ? 'var(--accent-line)' : 'var(--border-bright)'}`,
        background: 'linear-gradient(135deg, var(--surface2), var(--surface))',
        color: 'var(--text)', fontFamily: 'var(--font-sans)',
        fontSize: 13.5, fontWeight: 600,
        transition: 'border-color 0.18s',
      }}>
      <span style={{
        width: 30, height: 30, borderRadius: 9, background: 'var(--accent-soft)',
        border: '1px solid var(--accent-line)', flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        animation: 'rkBeacon 3s ease-in-out infinite',
      }}>
        {ICONS.Ask}
      </span>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        Ask Rack
        <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--text-dim)' }}>Refine, ask, auto-apply</span>
      </span>
    </button>
  )
}

// ── UserCard ───────────────────────────────────────────────────────────────────

function UserCard({ name, stat, onUpgrade }) {
  const [hov, setHov] = useState(false)
  return (
    <div style={{
      border: '1px solid var(--border)', background: 'var(--surface)',
      borderRadius: 15, padding: 15, boxShadow: 'var(--card-shadow)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>{name}</span>
        <span style={{
          fontSize: 10, fontWeight: 600, color: 'var(--text-dim)',
          textTransform: 'uppercase', letterSpacing: '0.08em',
          background: 'var(--chip-bg)', padding: '2px 7px', borderRadius: 6,
        }}>Free</span>
      </div>
      {stat ? (
        <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 10 }}>{stat}</div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, margin: '6px 0 8px' }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 22, fontWeight: 600, color: 'var(--accent-ink)' }}>∞</span>
          <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>match scans</span>
        </div>
      )}
      <div style={{ height: 4, borderRadius: 4, background: 'var(--surface3)', overflow: 'hidden', marginBottom: 12 }}>
        <div style={{ height: '100%', width: '38%', borderRadius: 4, background: 'var(--accent)' }}/>
      </div>
      <button onClick={onUpgrade}
        onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
        style={{
          width: '100%', padding: 9, borderRadius: 10, border: 'none', cursor: 'pointer',
          background: hov ? 'var(--accent-strong)' : 'var(--accent)',
          color: 'var(--accent-contrast)', fontFamily: 'var(--font-sans)',
          fontSize: 12.5, fontWeight: 600, boxShadow: 'var(--accent-glow)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
          transition: 'background 0.18s',
        }}>
        {ICONS.Star}
        Upgrade plan
      </button>
    </div>
  )
}

// ── CSS (injected once) ────────────────────────────────────────────────────────

const SIDEBAR_CSS = `
  @keyframes rkBeacon { 0%,100%{box-shadow:0 0 0 0 rgba(232,255,107,0.0)} 50%{box-shadow:0 0 0 5px rgba(232,255,107,0.16)} }
  @keyframes rkFadeIn { from{opacity:0} to{opacity:1} }
  @keyframes rkSideIn { from{transform:translateX(-100%)} to{transform:translateX(0)} }

  /* ── Desktop sidebar ── */
  .rk-sidebar {
    width: 252px; flex-shrink: 0; height: 100%;
    background: var(--sidebar-bg); border-right: 1px solid var(--border);
    display: flex; flex-direction: column; padding: 22px 16px 16px;
    position: relative; z-index: 5;
    transition: width 0.22s cubic-bezier(0.22,1,0.36,1), padding 0.22s cubic-bezier(0.22,1,0.36,1);
  }
  .rk-sidebar.collapsed { width: 68px; padding: 22px 10px 16px; }
  .rk-sidebar.collapsed .rk-sb-user { display: none; }
  .rk-sidebar.collapsed .rk-sb-ask  { display: none; }

  /* ── Collapse toggle ── */
  .rk-collapse-toggle {
    position: absolute; top: 20px; right: -13px;
    width: 26px; height: 26px; border-radius: 50%;
    border: 1px solid var(--border-bright); background: var(--surface);
    cursor: pointer; display: flex; align-items: center; justify-content: center;
    color: var(--text-dim); z-index: 6;
    transition: background 0.15s, color 0.15s;
    box-shadow: 0 2px 8px rgba(0,0,0,0.18);
  }
  .rk-collapse-toggle:hover { background: var(--surface2); color: var(--text); }

  /* ── Mobile top bar ── */
  .rk-mobile-topbar {
    display: none;
    align-items: center; justify-content: space-between;
    padding: 0 14px; height: 52px; flex-shrink: 0;
    border-bottom: 1px solid var(--border);
    background: var(--sidebar-bg); z-index: 10;
  }

  /* ── Mobile overlay ── */
  .rk-sidebar-overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,0.55);
    z-index: 49; animation: rkFadeIn 0.2s ease both;
  }
  .rk-sidebar-mobile {
    position: fixed; top: 0; left: 0; height: 100dvh; width: 272px;
    background: var(--sidebar-bg); border-right: 1px solid var(--border);
    display: flex; flex-direction: column; padding: 20px 14px 20px;
    z-index: 50; box-shadow: 12px 0 40px rgba(0,0,0,0.4);
    animation: rkSideIn 0.3s cubic-bezier(0.22,1,0.36,1) both;
    overflow-y: auto;
  }

  /* ── Mobile bottom nav ── */
  .rk-mobile-bottomnav {
    display: none;
    position: fixed; bottom: 0; left: 0; right: 0;
    height: calc(56px + env(safe-area-inset-bottom, 0px));
    padding-bottom: env(safe-area-inset-bottom, 0px);
    background: var(--sidebar-bg); border-top: 1px solid var(--border);
    z-index: 20; align-items: stretch; justify-content: space-around;
  }
  .rk-mobile-bottomnav-item {
    flex: 1; display: flex; flex-direction: column; align-items: center;
    justify-content: center; gap: 3px; cursor: pointer;
    color: var(--text-dim); font-size: 10px; font-weight: 500;
    padding: 0 4px 2px; border: none; background: transparent;
    transition: color 0.15s; font-family: var(--font-sans);
  }
  .rk-mobile-bottomnav-item.active { color: var(--accent-ink); }

  /* ── Tablet: 768–1199px ── */
  @media (max-width: 1199px) {
    .rk-sidebar { width: 68px !important; padding: 22px 10px 16px !important; }
    .rk-sidebar .rk-sb-user { display: none !important; }
    .rk-sidebar .rk-sb-ask  { display: none !important; }
    .rk-collapse-toggle { display: none !important; }
  }

  /* ── Mobile: < 768px ── */
  @media (max-width: 767px) {
    .rk-sidebar      { display: none !important; }
    .rk-mobile-topbar { display: flex !important; }
    .rk-mobile-bottomnav { display: flex !important; }
  }
`

// ── Sidebar (main export) ──────────────────────────────────────────────────────

export default function Sidebar({
  activeNav,
  onNavigate,
  userName = '',
  userInitial = '',
  badge = {},
  extraNav = null,
  extraNavLabel = 'VIEWS',
  onAskRack,
  userStat,
  theme,
  onToggleTheme,
}) {
  const [collapsed, setCollapsed]   = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)

  const nav = (id) => {
    setMobileOpen(false)
    onNavigate?.(id)
  }

  // Build nav items with badge overrides applied
  const navItems = DEFAULT_NAV.map(item => ({
    ...item,
    badge: badge[item.id] ?? null,
    active: item.id === activeNav,
  }))

  // Bottom nav items for mobile (5 key destinations)
  const bottomNavItems = [
    { id: 'Dashboard', label: 'Matches',  icon: ICONS.Matches   },
    { id: 'Tracking',  label: 'Browse',   icon: ICONS.BrowseAll },
    { id: 'Resumes',   label: 'Resumes',  icon: ICONS.Resumes   },
    { id: 'Tracking',  label: 'Tracker',  icon: ICONS.Tracking  },
    { id: 'Account',   label: 'Account',  icon: ICONS.Account   },
  ]

  return (
    <>
      <style>{SIDEBAR_CSS}</style>

      {/* ── MOBILE TOP BAR ── */}
      <div className="rk-mobile-topbar">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button onClick={() => setMobileOpen(true)} style={{
            width: 36, height: 36, borderRadius: 9, border: '1px solid var(--border-bright)',
            background: 'transparent', cursor: 'pointer', color: 'var(--text-dim)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            {ICONS.Hamburger}
          </button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ width: 26, height: 26, borderRadius: 7, background: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {ICONS.Logo}
            </div>
            <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, fontSize: 15 }}>RACK</span>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {onToggleTheme && (
            <button onClick={onToggleTheme} style={{
              width: 36, height: 36, borderRadius: 10, cursor: 'pointer',
              border: '1px solid var(--border-bright)', background: 'var(--surface)',
              color: 'var(--text-mid)', display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              {theme === 'dark' ? ICONS.Sun : ICONS.Moon}
            </button>
          )}
          {userInitial && (
            <div onClick={() => nav('Account')}
              style={{
                width: 36, height: 36, borderRadius: 10, cursor: 'pointer',
                background: 'linear-gradient(135deg, var(--accent2,#7c5cff), var(--accent3,#34d399))',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontWeight: 600, fontSize: 14, color: '#fff',
              }}>
              {userInitial}
            </div>
          )}
        </div>
      </div>

      {/* ── MOBILE OVERLAY SIDEBAR ── */}
      {mobileOpen && (
        <>
          <div className="rk-sidebar-overlay" onClick={() => setMobileOpen(false)}/>
          <div className="rk-sidebar-mobile">
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 22 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ width: 30, height: 30, borderRadius: 8, background: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: 'var(--accent-glow)' }}>
                  {ICONS.Logo}
                </div>
                <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, fontSize: 17 }}>RACK</span>
              </div>
              <button onClick={() => setMobileOpen(false)} style={{
                width: 30, height: 30, borderRadius: 8, border: '1px solid var(--border)',
                background: 'transparent', cursor: 'pointer', color: 'var(--text-dim)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                {ICONS.Close}
              </button>
            </div>

            {/* Nav */}
            <nav style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              {navItems.map(item => (
                <NavItem key={item.id} icon={item.icon} label={item.label}
                  active={item.active} badge={item.badge}
                  onClick={() => nav(item.id)}
                />
              ))}
            </nav>

            {/* Extra nav (e.g. Tracking sub-views) */}
            {extraNav && (
              <>
                <div style={{ height: 1, background: 'var(--border)', margin: '12px 6px' }}/>
                <div style={{
                  fontFamily: 'var(--font-mono)', fontSize: 9.5, fontWeight: 600,
                  letterSpacing: '0.12em', textTransform: 'uppercase',
                  color: 'var(--text-dim)', padding: '0 10px', marginBottom: 6,
                }}>
                  {extraNavLabel}
                </div>
                {extraNav}
              </>
            )}

            <div style={{ flex: 1 }}/>
            {userName && (
              <div className="rk-sb-user">
                <UserCard name={userName} stat={userStat} onUpgrade={() => nav('Account')} />
              </div>
            )}
          </div>
        </>
      )}

      {/* ── DESKTOP / TABLET SIDEBAR ── */}
      <aside className={`rk-sidebar${collapsed ? ' collapsed' : ''}`}>
        {/* Collapse toggle */}
        <button className="rk-collapse-toggle" onClick={() => setCollapsed(p => !p)}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
          {ICONS.Chevron(collapsed)}
        </button>

        <Logo collapsed={collapsed} />

        {/* Top nav */}
        <nav style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          {navItems.map(item => (
            <NavItem key={item.id} icon={item.icon} label={item.label}
              active={item.active} badge={collapsed ? null : item.badge}
              collapsed={collapsed} onClick={() => nav(item.id)}
            />
          ))}
        </nav>

        {/* Extra sub-nav (e.g. Tracking "VIEWS") */}
        {extraNav && !collapsed && (
          <>
            <div style={{ height: 1, background: 'var(--border)', margin: '14px 6px 12px' }}/>
            <div style={{
              fontFamily: 'var(--font-mono)', fontSize: 9.5, fontWeight: 600,
              letterSpacing: '0.12em', textTransform: 'uppercase',
              color: 'var(--text-dim)', padding: '0 12px', marginBottom: 6,
            }}>
              {extraNavLabel}
            </div>
            {extraNav}
          </>
        )}

        {/* Ask Rack */}
        {onAskRack && !collapsed && (
          <>
            <div style={{ height: 1, background: 'var(--border)', margin: '18px 6px' }}/>
            <div className="rk-sb-ask">
              <AskRackBtn onClick={onAskRack} />
            </div>
          </>
        )}

        <div style={{ flex: 1 }}/>

        {/* User card */}
        {userName && (
          <div className="rk-sb-user">
            <UserCard name={userName} stat={userStat} onUpgrade={() => nav('Account')} />
          </div>
        )}
      </aside>

      {/* ── MOBILE BOTTOM NAV ── */}
      <nav className="rk-mobile-bottomnav">
        {bottomNavItems.map((item, i) => (
          <button key={i} className={`rk-mobile-bottomnav-item${item.id === activeNav ? ' active' : ''}`}
            onClick={() => nav(item.id)}>
            {item.icon}
            <span>{item.label}</span>
          </button>
        ))}
      </nav>
    </>
  )
}