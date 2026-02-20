import { useEffect, useState } from 'react'

const TABS = ['Home', 'Resumes', 'Tracking', 'Account']
const TAB_ICONS = { Home: '⌂', Resumes: '📋', Tracking: '📍', Account: '◎' }

export default function TabBar({ active, onSwitch }) {
  const [settled, setSettled] = useState(false)

  useEffect(() => {
    // Small delay so the animation is visible on load
    const t = setTimeout(() => setSettled(true), 100)
    return () => clearTimeout(t)
  }, [])

  return (
    <>
      <style>{`
        .tabbar-wrap {
          position: fixed;
          left: 50%;
          transform: translateX(-50%);
          z-index: 200;
          transition: top 0.9s cubic-bezier(0.34, 1.56, 0.64, 1);
        }
        .tabbar-wrap.start { top: 44%; }
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
      `}</style>

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
    </>
  )
}