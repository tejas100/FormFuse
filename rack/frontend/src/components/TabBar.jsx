import { useEffect, useState, useRef } from 'react'

const TABS = ['Home', 'Resumes', 'Tracking', 'Account']

// Monochrome SVG icons — stroke-based, consistent weight
const TAB_ICONS = {
  Home: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 6.5L8 2l6 4.5V14a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6.5z"/>
      <path d="M6 15v-5h4v5"/>
    </svg>
  ),
  Resumes: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="1" width="10" height="14" rx="1.5"/>
      <path d="M6 5h4M6 8h4M6 11h2"/>
    </svg>
  ),
  Tracking: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 4h12M2 8h8M2 12h5"/>
      <circle cx="12.5" cy="11.5" r="2.5"/>
      <path d="M14.5 13.5L16 15" strokeWidth="1.5"/>
    </svg>
  ),
  Account: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="5" r="3"/>
      <path d="M2 14c0-3.314 2.686-5 6-5s6 1.686 6 5"/>
    </svg>
  ),
}

// ── Mobile hamburger dropdown ─────────────────────────────────────────────────
export function MobileMenu({ active, onSwitch }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  // Close on outside click
  useEffect(() => {
    if (!open) return
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    document.addEventListener('touchstart', handler)
    return () => {
      document.removeEventListener('mousedown', handler)
      document.removeEventListener('touchstart', handler)
    }
  }, [open])

  return (
    <>
      <style>{`
        .mob-menu-wrap {
          position: relative;
          z-index: 300;
        }
        .mob-hamburger {
          width: 38px; height: 38px;
          border-radius: 12px;
          border: 1px solid var(--border-bright);
          background: var(--surface2);
          backdrop-filter: blur(12px);
          -webkit-backdrop-filter: blur(12px);
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 5px;
          cursor: pointer;
          -webkit-tap-highlight-color: transparent;
          transition: background 0.2s, border-color 0.2s;
        }
        .mob-hamburger.is-open {
          background: var(--accent-soft);
          border-color: var(--accent-line);
        }
        .mob-hamburger span {
          display: block;
          width: 16px;
          height: 1.5px;
          background: var(--text);
          border-radius: 2px;
          transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
          transform-origin: center;
        }
        .mob-hamburger.is-open span:nth-child(1) {
          transform: translateY(6.5px) rotate(45deg);
        }
        .mob-hamburger.is-open span:nth-child(2) {
          opacity: 0; transform: scaleX(0);
        }
        .mob-hamburger.is-open span:nth-child(3) {
          transform: translateY(-6.5px) rotate(-45deg);
        }

        .mob-dropdown {
          position: absolute;
          top: calc(100% + 10px);
          left: 0;
          min-width: 180px;
          background: var(--surface);
          border: 1px solid var(--border-bright);
          border-radius: 16px;
          padding: 6px;
          backdrop-filter: blur(28px);
          -webkit-backdrop-filter: blur(28px);
          box-shadow: var(--modal-shadow);
          animation: dropdownIn 0.18s cubic-bezier(0.34, 1.4, 0.64, 1) both;
          transform-origin: top left;
        }
        @keyframes dropdownIn {
          from { opacity: 0; transform: scale(0.92) translateY(-6px); }
          to   { opacity: 1; transform: scale(1) translateY(0); }
        }

        .mob-dropdown-item {
          display: flex;
          align-items: center;
          gap: 12px;
          width: 100%;
          padding: 11px 14px;
          border-radius: 10px;
          border: none;
          background: transparent;
          color: var(--text-mid);
          font-family: var(--font-body);
          font-size: 14px;
          font-weight: 500;
          cursor: pointer;
          text-align: left;
          transition: background 0.15s, color 0.15s;
          -webkit-tap-highlight-color: transparent;
          letter-spacing: 0.01em;
        }
        .mob-dropdown-item:hover,
        .mob-dropdown-item:active {
          background: var(--surface2);
          color: var(--text);
        }
        .mob-dropdown-item.active {
          background: var(--accent-soft);
          color: var(--accent-ink);
        }
        .mob-dropdown-item.active .mob-dd-icon {
          color: var(--accent-ink);
        }
        .mob-dd-icon {
          font-size: 16px;
          width: 20px;
          text-align: center;
          color: var(--text-dim);
          transition: color 0.15s;
        }
        .mob-dropdown-divider {
          height: 1px;
          background: var(--border);
          margin: 4px 6px;
        }
      `}</style>

      <div className="mob-menu-wrap" ref={ref}>
        <button
          className={`mob-hamburger ${open ? 'is-open' : ''}`}
          onClick={() => setOpen(o => !o)}
          aria-label="Open navigation menu"
        >
          <span /><span /><span />
        </button>

        {open && (
          <div className="mob-dropdown">
            {TABS.map((tab, i) => (
              <>
                {i === TABS.length - 1 && <div key="divider" className="mob-dropdown-divider" />}
                <button
                  key={tab}
                  className={`mob-dropdown-item ${active === tab ? 'active' : ''}`}
                  onClick={() => { onSwitch(tab); setOpen(false) }}
                >
                  <span className="mob-dd-icon" style={{ display: 'flex', alignItems: 'center' }}>{TAB_ICONS[tab]}</span>
                  {tab}
                  {active === tab && <span style={{ marginLeft: 'auto', fontSize: 10, opacity: 0.6 }}>●</span>}
                </button>
              </>
            ))}
          </div>
        )}
      </div>
    </>
  )
}

export default function TabBar({ active, onSwitch, steelOpen = false }) {
  const [settled, setSettled] = useState(false)

  useEffect(() => {
    const t = setTimeout(() => setSettled(true), 100)
    return () => clearTimeout(t)
  }, [])

  return (
    <>
      <style>{`
        /* ── Desktop: floating pill ── */
        .tabbar-wrap {
          position: fixed;
          z-index: 200;
          /* Default: horizontally centred at top */
          left: 50%;
          top: 28px;
          transform: translateX(-50%);
          transition:
            top          0.55s cubic-bezier(0.22, 1, 0.36, 1),
            left         0.55s cubic-bezier(0.22, 1, 0.36, 1),
            transform    0.55s cubic-bezier(0.22, 1, 0.36, 1);
        }
        .tabbar-wrap.start   { top: 44%; }
        .tabbar-wrap.settled { top: 28px; }

        /* Steel open: move pill to vertical strip anchored to left edge, vertically centred */
        .tabbar-wrap.steel-open {
          left: 0;
          top: 50%;
          transform: translate(0, -50%);
        }

        /* The pill container — horizontal by default, vertical when steel is open */
        .tabbar {
          display: flex;
          flex-direction: row;
          align-items: center;
          gap: 4px;
          background: var(--tabbar-bg);
          border: 1px solid var(--tabbar-border);
          border-radius: 40px;
          padding: 6px;
          backdrop-filter: blur(28px);
          -webkit-backdrop-filter: blur(28px);
          box-shadow: var(--tabbar-shadow);
          transition:
            flex-direction 0s,
            border-radius  0.45s cubic-bezier(0.22, 1, 0.36, 1),
            padding        0.45s cubic-bezier(0.22, 1, 0.36, 1),
            box-shadow     0.9s ease;
        }
        .tabbar-wrap.settled .tabbar {
          box-shadow: var(--tabbar-settled-shadow);
        }
        /* Go vertical: pill becomes a slim left column */
        .steel-open .tabbar {
          flex-direction: column;
          border-radius: 0 16px 16px 0;
          padding: 10px 5px;
          gap: 2px;
        }

        /* Tab label — collapses away when steel is open */
        .tab-label {
          display: inline-block;
          max-width: 80px;
          overflow: hidden;
          white-space: nowrap;
          opacity: 1;
          transition:
            max-width    0.35s cubic-bezier(0.22, 1, 0.36, 1),
            opacity      0.2s  ease,
            margin-left  0.35s cubic-bezier(0.22, 1, 0.36, 1);
        }
        .steel-open .tab-label {
          max-width: 0;
          opacity: 0;
          margin-left: 0;
        }

        .tab-btn {
          display: flex;
          align-items: center;
          gap: 7px;
          padding: 10px 16px;
          border-radius: 30px;
          border: none;
          background: transparent;
          color: var(--tab-inactive);
          font-family: var(--font-body);
          font-size: 14px;
          font-weight: 500;
          cursor: pointer;
          transition:
            all         0.25s ease,
            padding     0.35s cubic-bezier(0.22, 1, 0.36, 1),
            border-radius 0.35s cubic-bezier(0.22, 1, 0.36, 1);
          white-space: nowrap;
          letter-spacing: 0.01em;
        }
        /* Icon-only vertical buttons — square, centred icon */
        .steel-open .tab-btn {
          padding: 11px;
          border-radius: 12px;
          justify-content: center;
          gap: 0;
        }
        .tab-btn:hover { color: var(--tab-inactive-hover); }
        .tab-btn.active {
          background: var(--tab-active-bg);
          color: var(--tab-active-color);
          box-shadow: var(--tab-active-shadow);
        }

        /* ── Mobile: hide pill ── */
        @media (max-width: 600px) {
          .tabbar-wrap { display: none; }
          .tabbar-mobile { display: none !important; }
        }

        /* Hidden on desktop */
        .tabbar-mobile {
          display: none;
          position: fixed;
          bottom: 0; left: 0; right: 0;
          z-index: 200;
          background: var(--mobile-bar-bg);
          border-top: 1px solid var(--mobile-bar-border);
          backdrop-filter: blur(24px);
          -webkit-backdrop-filter: blur(24px);
          padding: 0;
          padding-bottom: env(safe-area-inset-bottom, 0px);
          box-shadow: var(--mobile-bar-shadow);
        }

        .tab-btn-mobile {
          flex: 1;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 5px;
          padding: 10px 4px 10px;
          border: none;
          background: transparent;
          color: var(--mobile-tab-inactive);
          font-family: var(--font-body);
          font-size: 10px;
          font-weight: 500;
          cursor: pointer;
          transition: color 0.2s ease;
          letter-spacing: 0.04em;
          text-transform: uppercase;
          -webkit-tap-highlight-color: transparent;
          position: relative;
        }
        .tab-btn-mobile .mob-icon {
          font-size: 20px;
          line-height: 1;
          transition: transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1);
        }
        .tab-btn-mobile.active { color: var(--accent); }
        .tab-btn-mobile.active .mob-icon { transform: translateY(-2px) scale(1.15); }
        .tab-btn-mobile.active::before {
          content: '';
          position: absolute;
          top: 0; left: 50%;
          transform: translateX(-50%);
          width: 24px; height: 2px;
          background: var(--accent);
          border-radius: 0 0 4px 4px;
        }
      `}</style>

      {/* Desktop: floating pill */}
      <div className={[
        'tabbar-wrap',
        settled ? 'settled' : 'start',
        steelOpen ? 'steel-open' : '',
      ].filter(Boolean).join(' ')}>
        <div className="tabbar">
          {TABS.map(tab => (
            <button
              key={tab}
              className={`tab-btn ${active === tab ? 'active' : ''}`}
              onClick={() => onSwitch(tab)}
              title={tab}
            >
              <span style={{ flexShrink: 0 }}>{TAB_ICONS[tab]}</span>
              <span className="tab-label">{tab}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Mobile: bottom tab bar */}
      <div className="tabbar-mobile">
        {TABS.map(tab => (
          <button
            key={tab}
            className={`tab-btn-mobile ${active === tab ? 'active' : ''}`}
            onClick={() => onSwitch(tab)}
          >
            <span className="mob-icon">{TAB_ICONS[tab]}</span>
            {tab}
          </button>
        ))}
      </div>
    </>
  )
}