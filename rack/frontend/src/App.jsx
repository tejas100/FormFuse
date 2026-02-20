import { useState } from 'react'
import TabBar from './components/TabBar'
import Home from './pages/Home'
import Resumes from './pages/Resumes'
import Tracking from './pages/Tracking'
import Account from './pages/Account'

const PAGE_MAP = { Home, Resumes, Tracking, Account }

export default function App() {
  const [active, setActive] = useState('Home')
  const [pageKey, setPageKey] = useState(0)

  const switchTab = (tab) => {
    setActive(tab)
    setPageKey(k => k + 1)
  }

  const ActivePage = PAGE_MAP[active]

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
      <ActivePage key={pageKey} />

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

        /* ── Motion lines ── */
        .motion-lines {
          position: fixed;
          inset: 0;
          width: 100vw;
          height: 100vh;
          pointer-events: none;
          z-index: 0;
          overflow: visible;
        }

        .ml {
          stroke: #e8ff6b;
          stroke-width: 0.6;
          fill: none;
          opacity: 0;
        }

        /* Diagonal lines — staggered fade+draw in */
        .ml-1  { animation: lineReveal 2.4s cubic-bezier(0.22,1,0.36,1) 0.2s forwards, linePulse 6s ease-in-out 2.6s infinite; stroke-dasharray: 1200; stroke-dashoffset: 1200; }
        .ml-2  { animation: lineReveal 2.4s cubic-bezier(0.22,1,0.36,1) 0.5s forwards, linePulse 6s ease-in-out 2.9s infinite; stroke-dasharray: 1400; stroke-dashoffset: 1400; }
        .ml-3  { animation: lineReveal 2.4s cubic-bezier(0.22,1,0.36,1) 0.8s forwards, linePulse 7s ease-in-out 3.2s infinite; stroke-dasharray: 1600; stroke-dashoffset: 1600; }
        .ml-4  { animation: lineReveal 2.4s cubic-bezier(0.22,1,0.36,1) 1.0s forwards, linePulse 8s ease-in-out 3.4s infinite; stroke-dasharray: 1400; stroke-dashoffset: 1400; }
        .ml-5  { animation: lineReveal 2.4s cubic-bezier(0.22,1,0.36,1) 1.2s forwards, linePulse 7s ease-in-out 3.6s infinite; stroke-dasharray: 1200; stroke-dashoffset: 1200; }

        /* Horizontal lines */
        .ml-h1 { stroke-width: 0.4; animation: lineReveal 2s ease 1.4s forwards, linePulse 9s ease-in-out 3.4s infinite; stroke-dasharray: 800; stroke-dashoffset: 800; }
        .ml-h2 { stroke-width: 0.4; animation: lineReveal 2s ease 1.6s forwards, linePulse 9s ease-in-out 3.6s infinite; stroke-dasharray: 900; stroke-dashoffset: 900; }

        /* Arcs */
        .ml-arc1 { stroke-width: 0.5; stroke-opacity: 0.5; animation: lineReveal 3s cubic-bezier(0.22,1,0.36,1) 0.4s forwards, linePulse 10s ease-in-out 3.4s infinite; stroke-dasharray: 1200; stroke-dashoffset: 1200; }
        .ml-arc2 { stroke-width: 0.5; stroke-opacity: 0.5; animation: lineReveal 3s cubic-bezier(0.22,1,0.36,1) 0.7s forwards, linePulse 10s ease-in-out 3.7s infinite; stroke-dasharray: 1200; stroke-dashoffset: 1200; }

        /* Dots */
        .ml-dot1 { fill: #e8ff6b; stroke: none; animation: dotPop 0.6s ease 1.8s forwards; }
        .ml-dot2 { fill: #e8ff6b; stroke: none; animation: dotPop 0.6s ease 2.0s forwards; }
        .ml-dot3 { fill: #e8ff6b; stroke: none; animation: dotPop 0.6s ease 2.2s forwards; }

        @keyframes lineReveal {
          to {
            stroke-dashoffset: 0;
            opacity: 0.60;
          }
        }
        @keyframes linePulse {
          0%, 100% { opacity: 0.60; }
          50%       { opacity: 0.08; }
        }
        @keyframes dotPop {
          0%   { opacity: 0; transform: scale(0); }
          60%  { opacity: 1; transform: scale(1.4); }
          100% { opacity: 0.5; transform: scale(1); }
        }

        /* ── Logo ── */
        .logo {
          position:fixed;top:32px;left:40px;
          font-family:var(--font-display);font-size:22px;font-weight:800;
          letter-spacing:-0.5px;color:var(--text);z-index:100;
          display:flex;align-items:center;gap:8px;
        }
        .logo-dot {
          width:8px;height:8px;background:var(--accent);
          border-radius:50%;animation:pulse-ring 2.5s ease infinite;
        }
      `}</style>
    </div>
  )
}