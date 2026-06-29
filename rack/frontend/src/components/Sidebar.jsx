/**
 * Sidebar.jsx — RACK shared sidebar component
 *
 * Props:
 *   activeNav     {string}  — currently active nav item id
 *   onNavigate    {fn}      — (tabId: string) => void
 *   userName      {string}  — first name for user card
 *   userInitial   {string}  — single letter for mobile avatar
 *   badge         {object}  — { itemId: number } optional badge counts
 *   extraNav      {node}    — optional extra nav items below main nav
 *   extraNavLabel {string}  — label for extraNav section (default "VIEWS")
 *   onAskRack     {fn}      — if provided, renders Ask Rack button
 *   userStat      {string}  — stat line in user card
 *   theme         {string}  — 'dark' | 'light'
 *   onToggleTheme {fn}      — theme toggle callback
 */

import { useState } from 'react'

// ── Icons ──────────────────────────────────────────────────────────────────────
const ICONS = {
  Matches:   <svg width={16} height={16} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="5" height="5" rx="1.4"/><rect x="9" y="2" width="5" height="5" rx="1.4"/><rect x="2" y="9" width="5" height="5" rx="1.4"/><rect x="9" y="9" width="5" height="5" rx="1.4"/></svg>,
  BrowseAll: <svg width={16} height={16} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round"><path d="M2 4h12M2 8h7M2 12h4"/><circle cx="12" cy="11.5" r="2.4"/><path d="M13.7 13.2L15 14.5"/></svg>,
  Resumes:   <svg width={16} height={16} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="1.5" width="10" height="13" rx="1.6"/><path d="M6 5h4M6 8h4M6 11h2.5"/></svg>,
  Tracking:  <svg width={16} height={16} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M5 6h6M5 9h4"/></svg>,
  Emails:    <svg width={16} height={16} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round"><rect x="1.5" y="3.5" width="13" height="9" rx="1.5"/><path d="M1.5 5.5l6.5 4.5 6.5-4.5"/></svg>,
  Account:   <svg width={16} height={16} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round"><circle cx="8" cy="5" r="3"/><path d="M2.5 14c0-3 2.4-4.6 5.5-4.6S13.5 11 13.5 14"/></svg>,
  Logo:      <svg width={16} height={16} viewBox="0 0 16 16" fill="none" stroke="var(--accent-contrast)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 11V5l6-3 6 3v6l-6 3z"/><path d="M8 8l6-3M8 8v6M8 8L2 5"/></svg>,
  Sun:       <svg width={16} height={16} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="8" cy="8" r="3.2"/><path d="M8 1v1.6M8 13.4V15M15 8h-1.6M2.6 8H1M12.5 3.5l-1.1 1.1M4.6 11.4l-1.1 1.1M12.5 12.5l-1.1-1.1M4.6 4.6L3.5 3.5"/></svg>,
  Moon:      <svg width={16} height={16} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M13.5 9.2A5.6 5.6 0 0 1 6.8 2.5 5.6 5.6 0 1 0 13.5 9.2z"/></svg>,
  Chevron:   (flipped) => <svg width={11} height={11} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ transform: flipped ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}><path d="M10 4l-4 4 4 4"/></svg>,
  Hamburger: <svg width={16} height={16} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M2 4h12M2 8h12M2 12h12"/></svg>,
  Close:     <svg width={14} height={14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>,
  Star:      <svg width={12} height={12} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M8 1.5l1.8 4.2 4.7.4-3.6 3 1.1 4.6L8 11.3 4 13.7l1.1-4.6-3.6-3 4.7-.4z"/></svg>,
  Ask:       <svg width={15} height={15} viewBox="0 0 16 16" fill="none" stroke="var(--accent-ink)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"/></svg>,
  Chat:      <svg width={16} height={16} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round"><path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"/></svg>,
}

// ── Nav structure — groups replace hard dividers ───────────────────────────────
// group: 'main' = top section, 'tools' = middle, 'account' = bottom (pushed down)
export const DEFAULT_NAV = [
  { id: 'Dashboard', label: 'Matches',        icon: ICONS.Matches,   group: 'main'    },
  { id: 'Home',      label: 'Chat assistant', icon: ICONS.Chat,      group: 'main'    },
  { id: 'Tracking',  label: 'Browse all jobs', icon: ICONS.BrowseAll, group: 'main'    },
  { id: 'Resumes',   label: 'Resumes',         icon: ICONS.Resumes,   group: 'main'    },
  { id: 'TrackApps', label: 'Tracking',        icon: ICONS.Tracking,  group: 'tools'                          },
  { id: 'Emails',    label: 'Emails',          icon: ICONS.Emails,    group: 'tools'                          },
  { id: 'Account',   label: 'Account',         icon: ICONS.Account,   group: 'account' },
]

// ── NavItem ────────────────────────────────────────────────────────────────────
function NavItem({ icon, label, active, badge, onClick, collapsed, comingSoon, dim }) {
  const [hovered, setHovered] = useState(false)
  const isDisabled = comingSoon
  return (
    <div
      title={collapsed ? label : undefined}
      onClick={onClick}
      onMouseEnter={() => !isDisabled && setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex', alignItems: 'center',
        gap: collapsed ? 0 : 10,
        padding: collapsed ? '10px 0' : '9px 12px',
        justifyContent: collapsed ? 'center' : 'flex-start',
        borderRadius: 10,
        cursor: isDisabled ? 'default' : 'pointer',
        fontSize: 13.5,
        fontWeight: active ? 600 : 450,
        border: active ? '1px solid var(--accent-line)' : '1px solid transparent',
        background: active ? 'var(--accent-soft)' : hovered ? 'var(--surface2)' : 'transparent',
        color: active ? 'var(--text)' : dim || isDisabled ? 'var(--text-dim)' : hovered ? 'var(--text)' : 'var(--text-mid)',
        transition: 'background 0.15s, color 0.14s',
        userSelect: 'none', position: 'relative',
        opacity: isDisabled ? 0.45 : 1,
        letterSpacing: '-0.01em',
      }}>
      <span style={{ color: active ? 'var(--accent-ink)' : 'inherit', display: 'flex', flexShrink: 0 }}>
        {icon}
      </span>
      {!collapsed && (
        <span style={{ overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', flex: 1 }}>
          {label}
        </span>
      )}
      {!collapsed && comingSoon && (
        <span style={{
          fontSize: 8.5, fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase',
          color: 'var(--text-dim)', background: 'transparent',
          border: '1px solid var(--border)', padding: '1px 5px', borderRadius: 4,
          marginLeft: 'auto', flexShrink: 0,
        }}>soon</span>
      )}
      {!collapsed && !comingSoon && badge != null && badge > 0 && (
        <span style={{
          marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: 10.5, fontWeight: 600,
          color: active ? 'var(--accent-ink)' : 'var(--text-dim)',
          background: active ? 'var(--accent-soft)' : 'var(--surface2)',
          padding: '1px 7px', borderRadius: 20, flexShrink: 0,
          border: active ? '1px solid var(--accent-line)' : '1px solid var(--border)',
        }}>{badge}</span>
      )}
      {collapsed && active && (
        <span style={{
          position: 'absolute', left: 1, top: '50%', transform: 'translateY(-50%)',
          width: 3, height: 16, borderRadius: 2, background: 'var(--accent)',
        }}/>
      )}
    </div>
  )
}

// ── Section label (replaces hard dividers) ─────────────────────────────────────
function NavLabel({ children }) {
  return (
    <div style={{
      fontSize: 9.5, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase',
      color: 'var(--text-dim)', padding: '0 12px', marginBottom: 3, opacity: 0.55,
      userSelect: 'none',
    }}>{children}</div>
  )
}

// ── Logo + byline ──────────────────────────────────────────────────────────────
function Logo({ collapsed }) {
  return (
    <div style={{ padding: '2px 6px 20px', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{
          width: 32, height: 32, borderRadius: 9, flexShrink: 0,
          background: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: 'var(--accent-glow)',
        }}>
          {ICONS.Logo}
        </div>
        <div style={{
          opacity: collapsed ? 0 : 1,
          maxWidth: collapsed ? 0 : 160,
          overflow: 'hidden', whiteSpace: 'nowrap',
          transition: 'opacity 0.15s, max-width 0.2s',
          display: 'flex', flexDirection: 'column', gap: 1,
        }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: 16, letterSpacing: '0.06em', lineHeight: 1 }}>RACK</span>
          <a
            href="https://tejasbk.dev"
            target="_blank"
            rel="noopener noreferrer"
            className="rk-byline"
            onClick={e => e.stopPropagation()}
          >
            built by Tejas BK
          </a>
        </div>
      </div>
    </div>
  )
}

// ── Ask Rack button ────────────────────────────────────────────────────────────
function AskRackBtn({ onClick }) {
  const [hov, setHov] = useState(false)
  return (
    <button onClick={onClick}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '11px 13px',
        borderRadius: 12, cursor: 'pointer', width: '100%', textAlign: 'left',
        border: `1px solid ${hov ? 'var(--accent-line)' : 'var(--border)'}`,
        background: hov ? 'var(--accent-soft)' : 'var(--surface2)',
        color: 'var(--text)', fontFamily: 'var(--font-sans)',
        fontSize: 13, fontWeight: 600, transition: 'all 0.18s',
      }}>
      <span style={{
        width: 28, height: 28, borderRadius: 8,
        background: 'var(--accent-soft)', border: '1px solid var(--accent-line)',
        flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
        animation: 'rkBeacon 3s ease-in-out infinite',
      }}>
        {ICONS.Ask}
      </span>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
        <span>Ask Rack</span>
        <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--text-dim)', lineHeight: 1.3 }}>Refine, ask, auto-apply</span>
      </span>
    </button>
  )
}

// ── User card ──────────────────────────────────────────────────────────────────
function UserCard({ name, stat, onUpgrade }) {
  const [hov, setHov] = useState(false)
  return (
    <div style={{
      border: '1px solid var(--border)', background: 'var(--surface)',
      borderRadius: 14, padding: '13px 14px', boxShadow: 'var(--card-shadow)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>{name || 'You'}</span>
        <span style={{
          fontSize: 9, fontWeight: 700, color: 'var(--text-dim)',
          textTransform: 'uppercase', letterSpacing: '0.1em',
          background: 'var(--surface2)', padding: '2px 7px', borderRadius: 5,
          border: '1px solid var(--border)',
        }}>Free</span>
      </div>
      {stat ? (
        <div style={{ fontSize: 11.5, color: 'var(--text-dim)', marginBottom: 10, lineHeight: 1.4 }}>{stat}</div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 5, margin: '4px 0 8px' }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 20, fontWeight: 700, color: 'var(--accent-ink)' }}>∞</span>
          <span style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>match scans</span>
        </div>
      )}
      <div style={{ height: 3, borderRadius: 3, background: 'var(--surface3,var(--surface2))', overflow: 'hidden', marginBottom: 10 }}>
        <div style={{ height: '100%', width: '38%', borderRadius: 3, background: 'linear-gradient(90deg, var(--accent), var(--accent3,#34d399))' }}/>
      </div>
      <button onClick={onUpgrade}
        onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
        style={{
          width: '100%', padding: '8px', borderRadius: 9, border: 'none', cursor: 'pointer',
          background: hov ? 'var(--accent-strong,var(--accent))' : 'var(--accent)',
          color: 'var(--accent-contrast)', fontFamily: 'var(--font-sans)',
          fontSize: 12, fontWeight: 700, boxShadow: 'var(--accent-glow)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
          transition: 'background 0.15s, transform 0.1s',
          transform: hov ? 'scale(1.01)' : 'scale(1)',
          letterSpacing: '-0.01em',
        }}>
        {ICONS.Star}
        Upgrade plan
      </button>
    </div>
  )
}

// ── CSS ────────────────────────────────────────────────────────────────────────
const SIDEBAR_CSS = `
  /* Dark-mode default — without this the mobile drawer / top bar / bottom nav
     render transparent (only the light theme defined --sidebar-bg before). */
  :root { --sidebar-bg: #0e0e12; }

  [data-theme="light"] {
    --sidebar-bg: #EFEDE4;
    --surface:    #FFFFFF;
    --surface2:   #E8E6DC;
    --border:     rgba(0,0,0,0.08);
    --border-bright: rgba(0,0,0,0.14);
    --accent-soft: rgba(95,118,17,0.08);
    --accent-line: rgba(95,118,17,0.22);
  }

  @keyframes rkBeacon   { 0%,100%{box-shadow:0 0 0 0 rgba(232,255,107,0.0)} 50%{box-shadow:0 0 0 5px rgba(232,255,107,0.16)} }
  @keyframes rkFadeIn   { from{opacity:0} to{opacity:1} }
  @keyframes rkSideIn   { from{transform:translateX(-100%)} to{transform:translateX(0)} }
  @keyframes rkByline   { 0%{background-position:-200px 0} 100%{background-position:200px 0} }

  .rk-byline {
    font-size: 9.5px; font-weight: 500; letter-spacing: 0.02em;
    text-decoration: none; line-height: 1; cursor: pointer;
    background: linear-gradient(
      90deg,
      rgba(232,255,107,0.2) 0%,
      rgba(232,255,107,0.85) 40%,
      rgba(232,255,107,0.2) 80%
    );
    background-size: 200px 100%;
    -webkit-background-clip: text; background-clip: text;
    -webkit-text-fill-color: transparent;
    animation: rkByline 5s ease-in-out infinite;
    display: inline-block;
  }
  .rk-byline:hover { animation-play-state: paused; opacity: 1; }
  [data-theme="light"] .rk-byline {
    background: none;
    -webkit-text-fill-color: var(--text-dim);
    color: var(--text-dim);
    animation: none;
  }

  /* ── Desktop sidebar ── */
  .rk-sidebar {
    width: 240px; flex-shrink: 0; height: 100%;
    background: var(--sidebar-bg); border-right: 1px solid var(--border);
    display: flex; flex-direction: column; padding: 20px 12px 14px;
    position: relative; z-index: 5;
    transition: width 0.22s cubic-bezier(0.22,1,0.36,1), padding 0.22s cubic-bezier(0.22,1,0.36,1);
  }
  .rk-sidebar.collapsed { width: 64px; padding: 20px 8px 14px; }
  .rk-sidebar.collapsed .rk-sb-user { display: none; }
  .rk-sidebar.collapsed .rk-sb-ask  { display: none; }

  /* ── Collapse toggle ── */
  .rk-collapse-toggle {
    position: absolute; top: 22px; right: -12px;
    width: 24px; height: 24px; border-radius: 50%;
    border: 1px solid var(--border-bright); background: var(--sidebar-bg);
    cursor: pointer; display: flex; align-items: center; justify-content: center;
    color: var(--text-dim); z-index: 6;
    transition: background 0.15s, color 0.15s;
    box-shadow: 0 2px 10px rgba(0,0,0,0.12);
  }
  [data-theme="light"] .rk-collapse-toggle {
    box-shadow: 0 2px 10px rgba(0,0,0,0.07);
  }
  .rk-collapse-toggle:hover { background: var(--surface2); color: var(--text); }

  /* ── Mobile top bar ── */
  .rk-mobile-topbar {
    display: none;
    align-items: center; justify-content: space-between;
    padding: 0 14px; height: 52px; flex-shrink: 0; position: relative;
    border-bottom: 1px solid var(--border);
    background: var(--sidebar-bg); z-index: 10;
  }

  /* ── Mobile: < 768px ── */
  @media (max-width: 767px) {
    .rk-mobile-topbar {
      position: fixed !important;
      top: 0; left: 0; right: 0;
      z-index: 100;
    }
  }

  /* ── Mobile overlay ── */
  .rk-sidebar-overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,0.55);
    z-index: 49; animation: rkFadeIn 0.2s ease both;
  }
  .rk-sidebar-mobile {
    position: fixed; top: 0; left: 0; height: 100dvh; width: 268px;
    background: var(--sidebar-bg); border-right: 1px solid var(--border);
    display: flex; flex-direction: column; padding: 20px 12px 20px;
    z-index: 50; box-shadow: 16px 0 48px rgba(0,0,0,0.45);
    animation: rkSideIn 0.28s cubic-bezier(0.22,1,0.36,1) both;
    overflow-y: auto;
  }
  [data-theme="light"] .rk-sidebar-mobile {
    box-shadow: 16px 0 48px rgba(0,0,0,0.10);
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

  /* ── Tablet: 768–1199px — icon-rail ── */
  @media (max-width: 1199px) {
    .rk-sidebar { width: 64px !important; padding: 20px 8px 14px !important; }
    .rk-sidebar .rk-sb-user { display: none !important; }
    .rk-sidebar .rk-sb-ask  { display: none !important; }
    .rk-collapse-toggle { display: none !important; }
  }

  /* ── Mobile: < 768px — show/hide rules ── */
  @media (max-width: 767px) {
    .rk-sidebar       { display: none !important; }
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
  userAvatarUrl = null,
  badge = {},
  extraNav = null,
  extraNavLabel = 'VIEWS',
  onAskRack,
  userStat,
  theme,
  onToggleTheme,
}) {
  const [collapsed, setCollapsed] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [avatarImgError, setAvatarImgError] = useState(false)

  const nav = (id) => {
    setMobileOpen(false)
    onNavigate?.(id)
  }

  // Build items with active state + badge
  const navItems = DEFAULT_NAV.map(item => ({
    ...item,
    badge:  badge[item.id] ?? null,
    active: item.id === activeNav || (item.navTarget === activeNav),
  }))

  const mainItems    = navItems.filter(i => i.group === 'main')
  const toolItems    = navItems.filter(i => i.group === 'tools')
  const accountItems = navItems.filter(i => i.group === 'account')

  // Render a group of NavItems
  const renderGroup = (items, isCollapsed = false) =>
    items.map(item => (
      <NavItem
        key={item.id}
        icon={item.icon}
        label={item.label}
        active={item.active}
        badge={isCollapsed ? null : item.badge}
        collapsed={isCollapsed}
        comingSoon={item.comingSoon}
        onClick={() => !item.comingSoon && nav(item.navTarget || item.id)}
      />
    ))

  // Full nav column — used in both desktop sidebar and mobile overlay
  const renderFullNav = (isCollapsed = false) => (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
      {/* Main group */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        {!isCollapsed && <NavLabel>Discover</NavLabel>}
        {renderGroup(mainItems, isCollapsed)}
      </div>

      {/* Tools group */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 1, marginTop: 20 }}>
        {!isCollapsed && <NavLabel>Manage</NavLabel>}
        {renderGroup(toolItems, isCollapsed)}
      </div>

      {/* extraNav slot (Tracking sub-views etc.) */}
      {extraNav && !isCollapsed && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 1, marginTop: 20 }}>
          <NavLabel>{extraNavLabel}</NavLabel>
          {extraNav}
        </div>
      )}

      {/* Spacer — pushes Account + user card to bottom */}
      <div style={{ flex: 1 }}/>

      {/* Account group — separated by visual breathing room, no hard line */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 1, marginBottom: 14 }}>
        {renderGroup(accountItems, isCollapsed)}
      </div>

      {/* Ask Rack */}
      {onAskRack && !isCollapsed && (
        <div className="rk-sb-ask" style={{ marginBottom: 14 }}>
          <AskRackBtn onClick={onAskRack} />
        </div>
      )}

      {/* User card */}
      {userName && (
        <div className="rk-sb-user">
          <UserCard name={userName} stat={userStat} onUpgrade={() => nav('Account')} />
        </div>
      )}
    </div>
  )

  const bottomNavItems = [
    { id: 'Dashboard', label: 'Matches', icon: ICONS.Matches   },
    { id: 'Home',      label: 'Chat',    icon: ICONS.Chat       },
    { id: 'Resumes',   label: 'Resumes', icon: ICONS.Resumes   },
    { id: 'Account',   label: 'Account', icon: ICONS.Account   },
  ]

  return (
    <>
      <style>{SIDEBAR_CSS}</style>

      {/* ── MOBILE TOP BAR ── */}
      <div className="rk-mobile-topbar">
        <button onClick={() => setMobileOpen(true)} style={{
          width: 36, height: 36, borderRadius: 9, border: '1px solid var(--border-bright)',
          background: 'transparent', cursor: 'pointer', color: 'var(--text-dim)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        }}>
          {ICONS.Hamburger}
        </button>

        {/* Centered brand — absolutely positioned so it's truly centered
            regardless of the differing widths of the left/right groups */}
        <div style={{
          position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)',
          display: 'flex', alignItems: 'center', gap: 8, pointerEvents: 'none',
        }}>
          <div style={{ width: 26, height: 26, borderRadius: 7, background: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            {ICONS.Logo}
          </div>
          <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: 15, letterSpacing: '0.04em' }}>RACK</span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          {onToggleTheme && (
            <button onClick={onToggleTheme} style={{
              width: 34, height: 34, borderRadius: 9, cursor: 'pointer',
              border: '1px solid var(--border-bright)', background: 'var(--surface)',
              color: 'var(--text-mid)', display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              {theme === 'dark' ? ICONS.Sun : ICONS.Moon}
            </button>
          )}
          {userInitial && (
            <div onClick={() => nav('Account')} style={{
              width: 34, height: 34, borderRadius: 9, cursor: 'pointer',
              background: userAvatarUrl && !avatarImgError
                ? 'transparent'
                : 'linear-gradient(135deg, var(--accent2,#7c5cff), var(--accent3,#34d399))',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontWeight: 700, fontSize: 13, color: '#fff',
              overflow: 'hidden', flexShrink: 0,
            }}>
              {userAvatarUrl && !avatarImgError ? (
                <img
                  src={userAvatarUrl}
                  alt={userInitial}
                  onError={() => setAvatarImgError(true)}
                  style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                />
              ) : userInitial}
            </div>
          )}
        </div>
      </div>

      {/* ── MOBILE OVERLAY SIDEBAR ── */}
      {mobileOpen && (
        <>
          <div className="rk-sidebar-overlay" onClick={() => setMobileOpen(false)}/>
          <div className="rk-sidebar-mobile">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                <div style={{ width: 30, height: 30, borderRadius: 8, background: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: 'var(--accent-glow)' }}>
                  {ICONS.Logo}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: 15, letterSpacing: '0.04em' }}>RACK</span>
                  <a href="https://tejasbk.dev" target="_blank" rel="noopener noreferrer" className="rk-byline" onClick={e => e.stopPropagation()}>built by Tejas BK</a>
                </div>
              </div>
              <button onClick={() => setMobileOpen(false)} style={{
                width: 30, height: 30, borderRadius: 8, border: '1px solid var(--border)',
                background: 'transparent', cursor: 'pointer', color: 'var(--text-dim)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                {ICONS.Close}
              </button>
            </div>
            {renderFullNav(false)}
          </div>
        </>
      )}

      {/* ── DESKTOP / TABLET SIDEBAR ── */}
      <aside className={`rk-sidebar${collapsed ? ' collapsed' : ''}`}>
        <button className="rk-collapse-toggle" onClick={() => setCollapsed(p => !p)}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
          {ICONS.Chevron(collapsed)}
        </button>

        <Logo collapsed={collapsed} />

        {renderFullNav(collapsed)}
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