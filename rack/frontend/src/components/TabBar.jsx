import { useEffect, useState } from 'react'

const TABS = ['Home', 'Resumes', 'Tracking', 'Account']
const TAB_ICONS = { Home: '⌂', Resumes: '📋', Tracking: '📍', Account: '◎' }

export default function TabBar({ active, onSwitch }) {
  const [settled, setSettled] = useState(false)

  useEffect(() => {
    const t = setTimeout(() => setSettled(true), 100)
    return () => clearTimeout(t)
  }, [])

  return (
    <>
      <style>{`
        /* ── Desktop: floating pill at top (unchanged) ── */
        .tabbar-wrap {
          position: fixed;
          left: 50%;
          transform: translateX(-50%);
          z-index: 200;
          transition: top 0.9s cubic-bezier(0.34, 1.56, 0.64, 1);
        }
        .tabbar-wrap.start  { top: 44%; }
        .tabbar-wrap.settled { top: 28px; }

        .tabbar {
          display: flex;
          align-items: center;
          gap: 4px;
          background: rgba(255,255,255,0.06);
          border: 1px solid rgba(255,255,255,0.14);
          border-radius: 40px;
          padding: 6px;
          backdrop-filter: blur(28px);
          -webkit-backdrop-filter: blur(28px);
          box-shadow: 0 8px 40px rgba(0,0,0,0.6),
                      inset 0 1px 0 rgba(255,255,255,0.1),
                      0 0 0 1px rgba(232,255,107,0.04);
          transition: box-shadow 0.9s ease;
        }
        .tabbar-wrap.settled .tabbar {
          box-shadow: 0 4px 24px rgba(0,0,0,0.5),
                      inset 0 1px 0 rgba(255,255,255,0.08),
                      0 0 20px rgba(232,255,107,0.06);
        }

        .tab-btn {
          display: flex;
          align-items: center;
          gap: 7px;
          padding: 10px 22px;
          border-radius: 30px;
          border: none;
          background: transparent;
          color: rgba(255,255,255,0.4);
          font-family: var(--font-body);
          font-size: 14px;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.25s ease;
          white-space: nowrap;
          letter-spacing: 0.01em;
        }
        .tab-btn:hover { color: rgba(255,255,255,0.7); }
        .tab-btn.active {
          background: rgba(255,255,255,0.1);
          color: #f0f0f0;
          box-shadow: 0 2px 12px rgba(0,0,0,0.3),
                      inset 0 1px 0 rgba(255,255,255,0.12);
        }

        /* ── Mobile: bottom tab bar ── */
        @media (max-width: 600px) {
          /* Hide the floating pill entirely */
          .tabbar-wrap {
            display: none;
          }

          /* Bottom bar container */
          .tabbar-mobile {
            display: flex !important;
          }
        }

        /* Hidden on desktop */
        .tabbar-mobile {
          display: none;
          position: fixed;
          bottom: 0;
          left: 0;
          right: 0;
          z-index: 200;
          background: rgba(14,14,14,0.92);
          border-top: 1px solid rgba(255,255,255,0.1);
          backdrop-filter: blur(24px);
          -webkit-backdrop-filter: blur(24px);
          padding: 0;
          padding-bottom: env(safe-area-inset-bottom, 0px);
          box-shadow: 0 -8px 32px rgba(0,0,0,0.5),
                      0 -1px 0 rgba(232,255,107,0.06);
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
          color: rgba(255,255,255,0.35);
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

        .tab-btn-mobile.active {
          color: var(--accent);
        }

        .tab-btn-mobile.active .mob-icon {
          transform: translateY(-2px) scale(1.15);
        }

        /* Active indicator dot */
        .tab-btn-mobile.active::before {
          content: '';
          position: absolute;
          top: 0;
          left: 50%;
          transform: translateX(-50%);
          width: 24px;
          height: 2px;
          background: var(--accent);
          border-radius: 0 0 4px 4px;
        }
      `}</style>

      {/* Desktop: floating pill (existing behavior, untouched) */}
      <div className={`tabbar-wrap ${settled ? 'settled' : 'start'}`}>
        <div className="tabbar">
          {TABS.map(tab => (
            <button
              key={tab}
              className={`tab-btn ${active === tab ? 'active' : ''}`}
              onClick={() => onSwitch(tab)}
            >
              <span>{TAB_ICONS[tab]}</span>
              {tab}
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