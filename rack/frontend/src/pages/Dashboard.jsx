import { useState, useEffect, useRef, useCallback } from 'react'
import { useAuth } from '../context/AuthContext'
import { getAuthHeaders } from '../utils/api'
import { useTheme } from '../App'

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000'

// ── Helpers ────────────────────────────────────────────────────────────────────

function daysAgoLabel(dateStr) {
  if (!dateStr) return null
  const diff = Math.max(0, Math.round((Date.now() - new Date(dateStr).getTime()) / 86400000))
  if (diff === 0) return 'today'
  if (diff === 1) return '1d ago'
  return `${diff}d ago`
}

function tierMeta(score) {
  if (score >= 85) return { label: 'Strong match', color: 'var(--accent3)', ring: 'var(--accent3)' }
  if (score >= 70) return { label: 'Good match',   color: 'var(--accent-ink)', ring: 'var(--accent-ink)' }
  if (score >= 55) return { label: 'Potential',    color: '#f5a623', ring: '#f5a623' }
  return                    { label: 'Weak fit',   color: 'var(--danger)', ring: 'var(--danger)' }
}

function brandColor(company) {
  // Deterministic color from company name
  const palette = [
    '#635bff','#e0930f','#5b6472','#7c5cff','#7c3aed',
    '#1597c4','#e0492a','#1f6feb','#059669','#dc2626',
    '#0ea5e9','#8b5cf6','#f59e0b','#10b981','#3b82f6',
  ]
  let hash = 0
  for (let i = 0; i < company.length; i++) hash = (hash * 31 + company.charCodeAt(i)) & 0xffffffff
  return palette[Math.abs(hash) % palette.length]
}

function statusMeta(status) {
  switch (status) {
    case 'submitted': return { label: 'Submitted', color: 'var(--accent3)',  bg: 'rgba(52,211,153,0.12)' }
    case 'inflight':  return { label: 'In flight', color: '#60a5fa',         bg: 'rgba(96,165,250,0.12)' }
    case 'needsyou':  return { label: 'Needs you', color: '#f5a623',         bg: 'rgba(245,166,35,0.12)' }
    case 'failed':    return { label: 'Failed',    color: 'var(--danger)',    bg: 'rgba(248,113,113,0.12)' }
    default:          return { label: status,      color: 'var(--text-dim)', bg: 'var(--chip-bg)' }
  }
}

// ── Sub-components ──────────────────────────────────────────────────────────────

function NavItem({ icon, label, active, badge, onClick }) {
  const [hovered, setHovered] = useState(false)
  const style = {
    display: 'flex', alignItems: 'center', gap: 12, padding: '11px 13px',
    borderRadius: 11, cursor: 'pointer', fontSize: 14, fontWeight: active ? 600 : 500,
    border: active ? '1px solid var(--accent-line)' : '1px solid transparent',
    background: active ? 'var(--accent-soft)' : hovered ? 'var(--surface2)' : 'transparent',
    color: active ? 'var(--text)' : hovered ? 'var(--text)' : 'var(--text-mid)',
    transition: 'background 0.18s, color 0.15s, border-color 0.18s',
    userSelect: 'none',
  }
  return (
    <div style={style} onClick={onClick}
      onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
      <span style={{ color: active ? 'var(--accent-ink)' : 'inherit', display: 'flex' }}>{icon}</span>
      {label}
      {badge != null && (
        <span style={{
          marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 600,
          color: active ? 'var(--accent-ink)' : 'var(--text-dim)',
          background: active ? 'var(--accent-soft)' : 'var(--chip-bg)',
          padding: '2px 7px', borderRadius: 20,
          border: active ? '1px solid var(--accent-line)' : 'none',
        }}>{badge}</span>
      )}
    </div>
  )
}

function MatchRing({ score, size = 52, strokeW = 3.5 }) {
  const r = (size / 2) - strokeW
  const circ = 2 * Math.PI * r
  const offset = circ * (1 - Math.min(score, 100) / 100)
  const { color: _, ring } = tierMeta(score)
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ flexShrink: 0 }}>
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="var(--ring-track)" strokeWidth={strokeW}/>
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={ring} strokeWidth={strokeW}
        strokeLinecap="round"
        strokeDasharray={circ} strokeDashoffset={offset}
        style={{ transform: 'rotate(-90deg)', transformOrigin: 'center',
          transition: 'stroke-dashoffset 1.1s cubic-bezier(0.22,1,0.36,1)' }}
      />
      <text x={size/2} y={size/2 - 1} textAnchor="middle"
        style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: size * 0.25, fill: 'var(--text)' }}>
        {Math.round(score)}%
      </text>
      <text x={size/2} y={size/2 + size * 0.195} textAnchor="middle"
        style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, fontSize: size * 0.105, letterSpacing: '0.1em', fill: 'var(--text-dim)' }}>
        MATCH
      </text>
    </svg>
  )
}

function SkeletonCard() {
  return (
    <div style={{
      height: 224, borderRadius: 18, border: '1px solid var(--border)',
      background: 'var(--surface)', overflow: 'hidden', position: 'relative',
    }}>
      <div style={{
        position: 'absolute', inset: 0,
        background: 'linear-gradient(90deg, transparent, var(--chip-bg), transparent)',
        backgroundSize: '420px 100%',
        animation: 'rkShimmer 1.4s linear infinite',
      }}/>
    </div>
  )
}

function JobCard({ job, appliedIds, passedIds, onApply, onPass, revealed }) {
  const [hovered, setHovered] = useState(false)
  const jd       = job.job_data || {}
  const title    = job.job_title  || jd.title || jd.job_title || 'Untitled'
  const company  = job.company    || jd.company || ''
  const location = job.location   || jd.location || 'Remote'
  const score    = Math.round(job.score ?? 0)
  const posted   = job.posted_at  || job.matched_at
  const skills   = job.matched_skills || jd.skills || []
  const source   = (job.source || jd.source || 'greenhouse').toUpperCase()
  const jobId    = job.job_id || job.id
  const isApplied = appliedIds.has(jobId)
  const isPassed  = passedIds.has(jobId)
  const brand  = brandColor(company)
  const initial = (company || '?').charAt(0).toUpperCase()
  const { label: tierLabel, color: tierColor } = tierMeta(score)
  const shownSkills = skills.slice(0, 3)
  const extraSkills = skills.length > 3 ? skills.length - 3 : 0

  if (isPassed) return null

  return (
    <div
      style={{
        borderRadius: 18, border: '1px solid var(--border)',
        background: 'var(--surface)',
        boxShadow: hovered ? 'var(--card-hover-shadow)' : 'var(--card-shadow)',
        padding: 18, display: 'flex', flexDirection: 'column', gap: 13,
        position: 'relative',
        opacity: revealed ? 1 : 0,
        transform: revealed ? 'translateY(0)' : 'translateY(18px)',
        transition: 'opacity 0.45s cubic-bezier(0.22,1,0.36,1), transform 0.45s cubic-bezier(0.22,1,0.36,1), border-color 0.22s ease, box-shadow 0.28s ease',
        cursor: 'default',
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Top row — company logo + match ring */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, minWidth: 0 }}>
          <div style={{
            width: 40, height: 40, borderRadius: 11, flexShrink: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontWeight: 700, fontSize: 16, color: '#fff',
            background: brand, boxShadow: `0 4px 12px ${brand}4d`,
          }}>{initial}</div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {company || '—'}
            </div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, fontWeight: 600, letterSpacing: '0.1em', color: 'var(--text-dim)', marginTop: 2 }}>
              {source}
            </div>
          </div>
        </div>
        <MatchRing score={score} />
      </div>

      {/* Title */}
      <h3 style={{ fontSize: 16, fontWeight: 600, lineHeight: 1.3, letterSpacing: '-0.01em', margin: 0, minHeight: 42 }}>
        {title}
      </h3>

      {/* Meta row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, fontSize: 12, color: 'var(--text-mid)' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <svg width={12} height={12} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M8 14s5-4.2 5-8a5 5 0 0 0-10 0c0 3.8 5 8 5 8z"/><circle cx="8" cy="6" r="1.8"/></svg>
          {location}
        </span>
        {posted && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <svg width={12} height={12} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="8" cy="8" r="6.2"/><path d="M8 4.5V8l2.4 1.4"/></svg>
            {daysAgoLabel(posted)}
          </span>
        )}
      </div>

      {/* Skills */}
      {shownSkills.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {shownSkills.map((sk, i) => (
            <span key={i} style={{
              fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-mid)',
              background: 'var(--chip-bg)', border: '1px solid var(--chip-border)',
              padding: '3px 9px', borderRadius: 7,
            }}>{sk}</span>
          ))}
          {extraSkills > 0 && (
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-dim)', padding: '3px 4px' }}>
              +{extraSkills}
            </span>
          )}
        </div>
      )}

      <div style={{ height: 1, background: 'var(--border)', margin: '1px 0' }}/>

      {/* Footer */}
      {isApplied ? (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
          height: 38, borderRadius: 10,
          background: 'var(--accent-soft)', border: '1px solid var(--accent-line)',
          color: 'var(--accent-ink)', fontSize: 13, fontWeight: 600,
          animation: 'rkScaleIn 0.35s cubic-bezier(0.22,1,0.36,1) both',
        }}>
          <svg width={15} height={15} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 8.5l3.5 3.5L13 4.5"/></svg>
          Queued to auto-apply
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, fontWeight: 600, color: tierColor }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: tierColor, flexShrink: 0 }}/>
            {tierLabel}
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <PassBtn onClick={() => onPass(jobId)} />
            <ApplyBtn onClick={() => onApply(job)} />
          </div>
        </div>
      )}
    </div>
  )
}

function PassBtn({ onClick }) {
  const [hov, setHov] = useState(false)
  return (
    <button onClick={onClick} title="Pass"
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{
        width: 36, height: 36, borderRadius: 10, cursor: 'pointer',
        border: `1px solid ${hov ? 'var(--danger)' : 'var(--border-bright)'}`,
        background: 'transparent',
        color: hov ? 'var(--danger)' : 'var(--text-dim)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        transition: 'color 0.18s, border-color 0.18s',
      }}>
      <svg width={15} height={15} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>
    </button>
  )
}

function ApplyBtn({ onClick }) {
  const [hov, setHov] = useState(false)
  return (
    <button onClick={onClick}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '0 16px', height: 36, borderRadius: 10, cursor: 'pointer',
        border: 'none', background: hov ? 'var(--accent-strong)' : 'var(--accent)',
        color: 'var(--accent-contrast)', fontFamily: 'var(--font-sans)',
        fontSize: 13, fontWeight: 600, boxShadow: 'var(--accent-glow)',
        transition: 'background 0.18s',
      }}>
      Apply
      <svg width={13} height={13} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 8h9M8.5 4l4 4-4 4"/></svg>
    </button>
  )
}

function ScanningOverlay({ step, total, pct }) {
  const steps = [
    'Reading your resume',
    'Embedding against the live job pool',
    'Scoring semantic + skill fit',
    'Ranking your top matches',
  ]
  return (
    <div style={{ position: 'relative', minHeight: 440 }}>
      {/* Blurred skeleton grid behind */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
        gap: 18, opacity: 0.35, filter: 'blur(1px)',
      }}>
        {[0,1,2,3,4,5].map(i => <SkeletonCard key={i}/>)}
      </div>
      {/* Central scanner panel */}
      <div style={{
        position: 'absolute', top: '50%', left: '50%',
        transform: 'translate(-50%, -50%)',
        width: 430, maxWidth: '90%',
        background: 'var(--surface)', border: '1px solid var(--border-bright)',
        borderRadius: 20, padding: '26px 26px 24px',
        boxShadow: 'var(--card-hover-shadow)',
        animation: 'rkScaleIn 0.4s cubic-bezier(0.22,1,0.36,1) both',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 20 }}>
          <div style={{ width: 44, height: 44, flexShrink: 0, position: 'relative' }}>
            <svg width={44} height={44} viewBox="0 0 44 44" style={{ animation: 'rkSpin 1.05s linear infinite' }}>
              <circle cx={22} cy={22} r={18} fill="none" stroke="var(--ring-track)" strokeWidth="3.5"/>
              <circle cx={22} cy={22} r={18} fill="none" stroke="var(--accent)" strokeWidth="3.5"
                strokeLinecap="round" strokeDasharray="30 200"/>
            </svg>
          </div>
          <div>
            <div style={{ fontSize: 15.5, fontWeight: 600 }}>Finding your matches</div>
            <div style={{ fontSize: 12.5, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}>
              scoring against live roles
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 11, marginBottom: 18 }}>
          {steps.map((label, i) => {
            const done   = step > i
            const active = step === i
            return (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 11, fontSize: 13,
                color: done || active ? 'var(--text)' : 'var(--text-dim)',
                fontWeight: done || active ? 600 : 500 }}>
                <span style={{
                  width: 18, height: 18, borderRadius: '50%', flexShrink: 0,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  border: `1.5px solid ${done ? 'var(--accent)' : active ? 'var(--accent-line)' : 'var(--border-bright)'}`,
                  background: done ? 'var(--accent)' : 'transparent',
                }}>
                  {done && <svg width={10} height={10} viewBox="0 0 16 16" fill="none" stroke="var(--accent-contrast)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M3 8.5l3.5 3.5L13 4.5"/></svg>}
                  {active && <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--accent)', animation: 'rkPulse .8s ease-in-out infinite' }}/>}
                </span>
                {label}
              </div>
            )
          })}
        </div>
        <div style={{ height: 6, borderRadius: 5, background: 'var(--surface3)', overflow: 'hidden' }}>
          <div style={{
            height: '100%', borderRadius: 5,
            background: 'linear-gradient(90deg, var(--accent), var(--accent3))',
            width: `${pct}%`, transition: 'width 0.7s cubic-bezier(0.22,1,0.36,1)',
          }}/>
        </div>
      </div>
    </div>
  )
}

function EmptyState({ onRefresh, loading }) {
  const [hov, setHov] = useState(false)
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      minHeight: 360, gap: 16, animation: 'rkFadeIn 0.4s ease both',
    }}>
      <div style={{
        width: 56, height: 56, borderRadius: 16,
        background: 'var(--accent-soft)', border: '1px solid var(--accent-line)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <svg width={24} height={24} viewBox="0 0 16 16" fill="none" stroke="var(--accent-ink)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx={7} cy={7} r={5}/><path d="M11 11l3.5 3.5"/>
        </svg>
      </div>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 6 }}>No matches yet</div>
        <div style={{ fontSize: 13, color: 'var(--text-dim)', maxWidth: 320, lineHeight: 1.6 }}>
          The pipeline runs twice daily. Trigger a manual scan to see your first results now.
        </div>
      </div>
      <button onClick={onRefresh} disabled={loading}
        onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '11px 22px',
          borderRadius: 11, cursor: loading ? 'not-allowed' : 'pointer', border: 'none',
          background: hov && !loading ? 'var(--accent-strong)' : 'var(--accent)',
          color: 'var(--accent-contrast)', fontFamily: 'var(--font-sans)',
          fontSize: 13.5, fontWeight: 600, boxShadow: 'var(--accent-glow)',
          opacity: loading ? 0.6 : 1, transition: 'background 0.18s, opacity 0.18s',
        }}>
        {loading ? 'Scanning…' : 'Run match scan'}
      </button>
    </div>
  )
}

// ── Ask Rack Drawer ─────────────────────────────────────────────────────────────

function AskRackDrawer({ open, onClose, userName, onNavigate }) {
  const [input, setInput] = useState('')
  const [messages, setMessages] = useState([
    {
      from: 'rack',
      text: `Hi ${userName || 'there'} — I've scored your top matches. Want me to apply to the strongest ones, or should we tighten the filters first?`,
    }
  ])
  const [typing, setTyping] = useState(false)
  const bottomRef = useRef(null)
  const inputRef = useRef(null)

  useEffect(() => {
    if (open) { setTimeout(() => inputRef.current?.focus(), 340) }
  }, [open])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, typing])

  const send = async () => {
    const text = input.trim()
    if (!text) return
    setInput('')
    setMessages(prev => [...prev, { from: 'user', text }])
    setTyping(true)
    // Simulate a smart reply — in production this would hit a real endpoint
    await new Promise(r => setTimeout(r, 900))
    setTyping(false)
    const lower = text.toLowerCase()
    let reply = "I can help with that. Try the filter chips in the dashboard to narrow by score threshold, or open Tracking to manage your pipeline directly."
    if (lower.includes('apply')) reply = "Tap the yellow Apply button on any card to queue a job, or hit 'Apply to all' to batch-queue your top matches. I'll auto-fill the forms."
    else if (lower.includes('remote')) reply = "Filtering to remote-only roles: I'll flag any cards where location shows 'Remote'. Open Tracking for advanced location filters."
    else if (lower.includes('track') || lower.includes('status')) { reply = "Opening your Tracker…"; setTimeout(() => onNavigate('Tracking'), 600) }
    setMessages(prev => [...prev, { from: 'rack', text: reply }])
  }

  const handleKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
  }

  if (!open) return null
  return (
    <>
      {/* Backdrop */}
      <div onClick={onClose} style={{
        position: 'fixed', inset: 0, background: 'rgba(4,4,6,0.5)',
        zIndex: 40, animation: 'rkFadeIn 0.25s ease both',
      }}/>
      {/* Drawer */}
      <div style={{
        position: 'fixed', top: 0, right: 0, height: '100vh',
        width: 392, maxWidth: '92vw',
        background: 'var(--surface)', borderLeft: '1px solid var(--border-bright)',
        zIndex: 41, display: 'flex', flexDirection: 'column',
        boxShadow: '-20px 0 60px rgba(0,0,0,0.4)',
        animation: 'rkDrawer 0.42s cubic-bezier(0.22,1,0.36,1) both',
      }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 20px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
            <span style={{
              width: 32, height: 32, borderRadius: 9,
              background: 'var(--accent-soft)', border: '1px solid var(--accent-line)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <svg width={16} height={16} viewBox="0 0 16 16" fill="none" stroke="var(--accent-ink)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"/></svg>
            </span>
            <div>
              <div style={{ fontSize: 14, fontWeight: 600 }}>Ask Rack</div>
              <div style={{ fontSize: 11, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}>your matching assistant</div>
            </div>
          </div>
          <button onClick={onClose} style={{
            width: 32, height: 32, borderRadius: 9, border: '1px solid var(--border)',
            background: 'transparent', cursor: 'pointer', color: 'var(--text-dim)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <svg width={15} height={15} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>
          </button>
        </div>

        {/* Messages */}
        <div style={{ flex: 1, overflowY: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {messages.map((m, i) => (
            <div key={i} style={{
              alignSelf: m.from === 'user' ? 'flex-end' : 'flex-start',
              maxWidth: '85%',
              background: m.from === 'user' ? 'var(--accent-soft)' : 'var(--surface2)',
              border: `1px solid ${m.from === 'user' ? 'var(--accent-line)' : 'var(--border)'}`,
              borderRadius: m.from === 'user' ? '14px 14px 4px 14px' : '14px 14px 14px 4px',
              padding: '12px 14px', fontSize: 13.5, lineHeight: 1.5,
              color: m.from === 'user' ? 'var(--text)' : 'var(--text-mid)',
            }}>{m.text}</div>
          ))}
          {typing && (
            <div style={{ alignSelf: 'flex-start', display: 'flex', gap: 5, padding: '4px 2px' }}>
              {[0, 0.2, 0.4].map((delay, i) => (
                <span key={i} style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--text-dim)', animation: `rkPulse 1s ease-in-out ${delay}s infinite` }}/>
              ))}
            </div>
          )}
          <div ref={bottomRef}/>
        </div>

        {/* Input */}
        <div style={{ padding: '16px 18px', borderTop: '1px solid var(--border)' }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '6px 6px 6px 16px', borderRadius: 13,
            border: '1px solid var(--border-bright)', background: 'var(--bg)',
          }}>
            <input
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKey}
              placeholder="Ask Rack to refine or apply…"
              style={{
                flex: 1, border: 'none', outline: 'none', background: 'transparent',
                fontFamily: 'var(--font-sans)', fontSize: 13.5, color: 'var(--text)',
              }}
            />
            <button onClick={send} style={{
              width: 34, height: 34, borderRadius: 10, border: 'none',
              cursor: 'pointer', background: 'var(--accent)', color: 'var(--accent-contrast)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: 'var(--accent-glow)',
            }}>
              <svg width={15} height={15} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 8h10M8 4l4 4-4 4"/></svg>
            </button>
          </div>
        </div>
      </div>
    </>
  )
}

// ── Search bar ──────────────────────────────────────────────────────────────────

function SearchBar({ value, onChange }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '0 18px', height: 52, borderRadius: 14,
      border: '1px solid var(--border-bright)', background: 'var(--surface)',
      boxShadow: 'var(--card-shadow)', marginBottom: 14,
    }}>
      <svg width={18} height={18} viewBox="0 0 16 16" fill="none" stroke="var(--text-dim)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><circle cx={7} cy={7} r={5}/><path d="M11 11l3.5 3.5"/></svg>
      <input
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder="Search by title, company, or skill…"
        style={{
          flex: 1, border: 'none', outline: 'none', background: 'transparent',
          fontFamily: 'var(--font-sans)', fontSize: 14.5, color: 'var(--text)',
        }}
      />
      <kbd style={{
        fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-dim)',
        border: '1px solid var(--border)', borderRadius: 6,
        padding: '3px 7px', background: 'var(--chip-bg)',
      }}>⌘K</kbd>
    </div>
  )
}

// ── Filter chips ────────────────────────────────────────────────────────────────

// ── Dropdown filter bar — matches design reference ─────────────────────────────

const DROPDOWN_FILTERS = [
  { id: 'date',      label: 'Date' },
  { id: 'location',  label: 'Location' },
  { id: 'workplace', label: 'Workplace' },
  { id: 'role',      label: 'Role' },
  { id: 'salary',    label: 'Salary' },
  { id: 'jobtype',   label: 'Job type' },
  { id: 'more',      label: 'More' },
]

// Options per filter — used to derive the active filter state for job display
const FILTER_OPTIONS = {
  date:      [{ id: 'all', label: 'Any time' }, { id: 'today', label: 'Today' }, { id: '3d', label: 'Last 3 days' }, { id: '7d', label: 'Last 7 days' }, { id: '30d', label: 'Last 30 days' }],
  location:  [{ id: 'all', label: 'Any location' }, { id: 'remote', label: 'Remote' }, { id: 'us', label: 'United States' }, { id: 'nyc', label: 'New York' }, { id: 'sf', label: 'San Francisco' }],
  workplace: [{ id: 'all', label: 'Any' }, { id: 'remote', label: 'Remote' }, { id: 'hybrid', label: 'Hybrid' }, { id: 'onsite', label: 'On-site' }],
  role:      [{ id: 'all', label: 'Any role' }, { id: 'engineer', label: 'Engineer' }, { id: 'ml', label: 'ML / AI' }, { id: 'data', label: 'Data' }, { id: 'pm', label: 'Product' }],
  salary:    [{ id: 'all', label: 'Any salary' }, { id: '100k', label: '$100k+' }, { id: '150k', label: '$150k+' }, { id: '200k', label: '$200k+' }],
  jobtype:   [{ id: 'all', label: 'Any type' }, { id: 'fulltime', label: 'Full-time' }, { id: 'contract', label: 'Contract' }, { id: 'parttime', label: 'Part-time' }],
  more:      [{ id: 'all', label: 'Any' }, { id: '85', label: '85%+ match' }, { id: '75', label: '75%+ match' }, { id: '65', label: '65%+ match' }, { id: 'new', label: 'New today' }],
}

function FilterBar({ activeFilters, onFilterChange, onClearAll }) {
  const [openId, setOpenId] = useState(null)
  const barRef = useRef(null)

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e) => { if (barRef.current && !barRef.current.contains(e.target)) setOpenId(null) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const hasAnyActive = Object.values(activeFilters).some(v => v !== 'all')

  return (
    <div ref={barRef} style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 28, alignItems: 'center' }}>
      {DROPDOWN_FILTERS.map(f => {
        const currentVal = activeFilters[f.id] || 'all'
        const isActive   = currentVal !== 'all'
        const isOpen     = openId === f.id
        const options    = FILTER_OPTIONS[f.id] || []
        const activeLabel = options.find(o => o.id === currentVal)?.label

        return (
          <div key={f.id} style={{ position: 'relative' }}>
            <DropdownChip
              label={isActive ? `${f.label}: ${activeLabel}` : f.label}
              active={isActive}
              open={isOpen}
              onClick={() => setOpenId(isOpen ? null : f.id)}
            />
            {isOpen && (
              <div style={{
                position: 'absolute', top: 'calc(100% + 6px)', left: 0,
                minWidth: 172, background: 'var(--surface)',
                border: '1px solid var(--border-bright)', borderRadius: 12,
                boxShadow: 'var(--card-hover-shadow)', zIndex: 50,
                padding: '5px', animation: 'rkScaleIn 0.18s cubic-bezier(0.22,1,0.36,1) both',
                transformOrigin: 'top left',
              }}>
                {options.map(opt => (
                  <DropdownOption
                    key={opt.id}
                    label={opt.label}
                    selected={currentVal === opt.id}
                    onClick={() => { onFilterChange(f.id, opt.id); setOpenId(null) }}
                  />
                ))}
              </div>
            )}
          </div>
        )
      })}

      {hasAnyActive && (
        <button onClick={onClearAll} style={{
          padding: '8px 12px', borderRadius: 10, cursor: 'pointer',
          fontFamily: 'var(--font-sans)', fontSize: 12, fontWeight: 500,
          background: 'transparent', color: 'var(--text-dim)',
          border: '1px solid transparent',
          transition: 'color 0.15s',
        }}
          onMouseEnter={e => e.currentTarget.style.color = 'var(--danger)'}
          onMouseLeave={e => e.currentTarget.style.color = 'var(--text-dim)'}
        >
          Clear all ×
        </button>
      )}
    </div>
  )
}

function DropdownChip({ label, active, open, onClick }) {
  const [hov, setHov] = useState(false)
  return (
    <button onClick={onClick}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '8px 13px', borderRadius: 10, cursor: 'pointer',
        fontFamily: 'var(--font-sans)', fontSize: 13, fontWeight: 500,
        background: active ? 'var(--accent-soft)' : hov || open ? 'var(--surface2)' : 'var(--surface)',
        color: active ? 'var(--text)' : hov || open ? 'var(--text)' : 'var(--text-mid)',
        border: `1px solid ${active ? 'var(--accent-line)' : 'var(--border-bright)'}`,
        transition: 'background 0.15s, color 0.12s, border-color 0.15s',
        whiteSpace: 'nowrap',
      }}>
      {label}
      {active && (
        <span style={{
          fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700,
          background: 'var(--accent)', color: 'var(--accent-contrast)',
          borderRadius: 20, padding: '1px 6px', lineHeight: '14px',
        }}>1</span>
      )}
      <svg width={11} height={11} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8"
        strokeLinecap="round" strokeLinejoin="round"
        style={{ opacity: 0.55, transform: open ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.18s' }}>
        <path d="M4 6l4 4 4-4"/>
      </svg>
    </button>
  )
}

function DropdownOption({ label, selected, onClick }) {
  const [hov, setHov] = useState(false)
  return (
    <button onClick={onClick}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 8,
        width: '100%', padding: '8px 10px', borderRadius: 8,
        border: 'none', cursor: 'pointer', textAlign: 'left',
        fontFamily: 'var(--font-sans)', fontSize: 13, fontWeight: selected ? 600 : 400,
        background: hov ? 'var(--surface2)' : 'transparent',
        color: selected ? 'var(--text)' : 'var(--text-mid)',
        transition: 'background 0.12s, color 0.12s',
      }}>
      <span style={{
        width: 14, height: 14, borderRadius: '50%', flexShrink: 0,
        border: `1.5px solid ${selected ? 'var(--accent)' : 'var(--border-bright)'}`,
        background: selected ? 'var(--accent)' : 'transparent',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        {selected && <svg width={8} height={8} viewBox="0 0 16 16" fill="none" stroke="var(--accent-contrast)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3 8.5l3.5 3.5L13 4.5"/></svg>}
      </span>
      {label}
    </button>
  )
}

// ── Main Dashboard ─────────────────────────────────────────────────────────────

export default function Dashboard({ onNavigate }) {
  const { user, session } = useAuth()
  const { theme, toggleTheme } = useTheme()

  // ── Data state ──────────────────────────────────────────────────────────────
  const [phase, setPhase]           = useState('loading') // 'loading' | 'scanning' | 'ready' | 'error'
  const [allJobs, setAllJobs]       = useState([])
  const [appliedIds, setAppliedIds] = useState(new Set())
  const [passedIds, setPassedIds]   = useState(new Set())
  const [revealCount, setRevealCount] = useState(0)
  const [scanStep, setScanStep]     = useState(0)
  const [scanPct, setScanPct]       = useState(0)
  const [errorMsg, setErrorMsg]     = useState(null)
  const revealTimers = useRef([])

  // ── UI state ────────────────────────────────────────────────────────────────
  const [activeNav, setActiveNav]           = useState('Matches')
  const [assistantOpen, setAssistantOpen]   = useState(false)
  const [searchQuery, setSearchQuery]       = useState('')
  const [activeFilters, setActiveFilters]   = useState({})   // { date: 'all', location: 'remote', … }
  const [appsTab, setAppsTab]               = useState('all')
  const [appsData, setAppsData]             = useState([])

  // ── Derived user info ────────────────────────────────────────────────────────
  const displayName = user?.user_metadata?.full_name
    || user?.user_metadata?.name
    || user?.email?.split('@')[0]
    || 'there'
  const firstName = displayName.split(' ')[0]
  const userInitial = firstName.charAt(0).toUpperCase()
  const greeting = (() => {
    const h = new Date().getHours()
    if (h < 12) return 'Good morning'
    if (h < 17) return 'Good afternoon'
    return 'Good evening'
  })()

  // ── Fetch matches ────────────────────────────────────────────────────────────
  const fetchMatches = useCallback(async (force = false) => {
    if (!session?.access_token) return
    try {
      setPhase('scanning')
      setScanStep(0)
      setScanPct(0)
      setRevealCount(0)

      // Animate scan steps while request is in-flight
      const steps = 4
      const stepDelay = 780
      const stepTimers = []
      for (let i = 1; i <= steps; i++) {
        stepTimers.push(setTimeout(() => {
          setScanStep(i)
          setScanPct(Math.round((i / steps) * 100))
        }, i * stepDelay))
      }

      const headers = await getAuthHeaders()
      const res = await fetch(`${API_BASE}/api/tracking/auto/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ force }),
      })

      stepTimers.forEach(clearTimeout)

      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      const matches = (data.matches || [])

      setScanStep(steps)
      setScanPct(100)

      // Small pause then switch to ready
      await new Promise(r => setTimeout(r, 480))
      setAllJobs(matches)
      setPhase('ready')
      startReveal(matches.length)

      // Also pull tracked jobs for the applications strip
      fetchTrackedJobs()
    } catch (err) {
      console.error('[Dashboard] fetch error', err)
      setPhase('error')
      setErrorMsg('Could not load matches. The pipeline may still be running.')
    }
  }, [session]) // eslint-disable-line

  const fetchTrackedJobs = useCallback(async () => {
    if (!session?.access_token) return
    try {
      const headers = await getAuthHeaders()
      const res = await fetch(`${API_BASE}/api/tracking`, { headers })
      if (res.ok) {
        const data = await res.json()
        setAppsData(data.jobs || [])
      }
    } catch (_) {}
  }, [session]) // eslint-disable-line

  useEffect(() => {
    if (session?.access_token && phase === 'loading') {
      fetchMatches(false)
    }
  }, [session]) // eslint-disable-line

  const startReveal = (count) => {
    revealTimers.current.forEach(clearTimeout)
    revealTimers.current = []
    setRevealCount(0)
    for (let i = 1; i <= count; i++) {
      revealTimers.current.push(setTimeout(() => setRevealCount(i), 65 * i))
    }
  }

  useEffect(() => () => revealTimers.current.forEach(clearTimeout), [])

  // ── Filter + search ─────────────────────────────────────────────────────────
  const filteredJobs = (() => {
    let jobs = allJobs.filter(j => !passedIds.has(j.job_id || j.id))

    // Date filter
    const dateF = activeFilters.date || 'all'
    if (dateF !== 'all') {
      const cutoffMs = { today: 86400000, '3d': 86400000*3, '7d': 86400000*7, '30d': 86400000*30 }[dateF]
      if (cutoffMs) jobs = jobs.filter(j => {
        const d = new Date(j.posted_at || j.matched_at || 0)
        return (Date.now() - d.getTime()) <= cutoffMs
      })
    }

    // Location / workplace filter (both map to location field)
    const locF  = activeFilters.location  || 'all'
    const workF = activeFilters.workplace || 'all'
    if (locF === 'remote' || workF === 'remote') {
      jobs = jobs.filter(j => (j.location || j.job_data?.location || '').toLowerCase().includes('remote'))
    } else if (locF === 'nyc') {
      jobs = jobs.filter(j => (j.location || j.job_data?.location || '').toLowerCase().match(/new york|nyc/))
    } else if (locF === 'sf') {
      jobs = jobs.filter(j => (j.location || j.job_data?.location || '').toLowerCase().match(/san francisco|sf\b/))
    } else if (workF === 'hybrid') {
      jobs = jobs.filter(j => (j.location || j.job_data?.location || '').toLowerCase().includes('hybrid'))
    } else if (workF === 'onsite') {
      jobs = jobs.filter(j => {
        const loc = (j.location || j.job_data?.location || '').toLowerCase()
        return !loc.includes('remote') && !loc.includes('hybrid')
      })
    }

    // Role filter
    const roleF = activeFilters.role || 'all'
    if (roleF === 'ml') {
      jobs = jobs.filter(j => (j.job_title || '').toLowerCase().match(/ml|machine learn|ai\b|nlp|llm/))
    } else if (roleF === 'data') {
      jobs = jobs.filter(j => (j.job_title || '').toLowerCase().match(/data|analytics|scientist/))
    } else if (roleF === 'engineer') {
      jobs = jobs.filter(j => (j.job_title || '').toLowerCase().includes('engineer'))
    } else if (roleF === 'pm') {
      jobs = jobs.filter(j => (j.job_title || '').toLowerCase().match(/product|program manager/))
    }

    // More filter (score threshold / new)
    const moreF = activeFilters.more || 'all'
    if (moreF === '85')  jobs = jobs.filter(j => (j.score ?? 0) >= 85)
    else if (moreF === '75') jobs = jobs.filter(j => (j.score ?? 0) >= 75)
    else if (moreF === '65') jobs = jobs.filter(j => (j.score ?? 0) >= 65)
    else if (moreF === 'new') {
      jobs = [...jobs].sort((a, b) => {
        const ta = new Date(a.posted_at || a.matched_at || 0).getTime()
        const tb = new Date(b.posted_at || b.matched_at || 0).getTime()
        return tb - ta
      })
    }

    // Text search
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      jobs = jobs.filter(j => {
        const jd = j.job_data || {}
        const title  = (j.job_title || jd.title || '').toLowerCase()
        const co     = (j.company   || jd.company || '').toLowerCase()
        const skills = (j.matched_skills || []).join(' ').toLowerCase()
        return title.includes(q) || co.includes(q) || skills.includes(q)
      })
    }

    return jobs
  })()

  const DASHBOARD_JOB_CAP = 10   // dashboard shows top 10; "Browse all" → Tracking

  const freshCount = allJobs.filter(j => {
    const d = new Date(j.matched_at || j.posted_at || 0)
    return (Date.now() - d.getTime()) < 86400000 * 2
  }).length

  // Cap what the dashboard grid shows
  const visibleJobs = filteredJobs.slice(0, DASHBOARD_JOB_CAP)

  const handleApply = (job) => {
    const id = job.job_id || job.id
    setAppliedIds(prev => new Set([...prev, id]))
  }
  const handlePass = (id) => setPassedIds(prev => new Set([...prev, id]))

  const allApplied = visibleJobs.length > 0 && visibleJobs.every(j => appliedIds.has(j.job_id || j.id))

  const handleApplyAll = () => {
    const ids = visibleJobs.map(j => j.job_id || j.id)
    setAppliedIds(prev => new Set([...prev, ...ids]))
  }

  // ── Navigate externally (to Tracking, Resumes, etc.) ────────────────────────
  const navigate = (tab) => {
    if (onNavigate) onNavigate(tab)
  }

  // ── Sidebar nav config ───────────────────────────────────────────────────────
  const navItems = [
    {
      id: 'Matches', label: 'Matches',
      badge: allJobs.length > 0 ? allJobs.length : null,
      icon: <svg width={17} height={17} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="5" height="5" rx="1.4"/><rect x="9" y="2" width="5" height="5" rx="1.4"/><rect x="2" y="9" width="5" height="5" rx="1.4"/><rect x="9" y="9" width="5" height="5" rx="1.4"/></svg>,
    },
    {
      id: 'BrowseAll', label: 'Browse all jobs',
      badge: allJobs.length > 0 ? allJobs.length : null,
      icon: <svg width={17} height={17} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M2 4h12M2 8h7M2 12h4"/><circle cx="12" cy="11.5" r="2.4"/><path d="M13.7 13.2L15 14.5"/></svg>,
    },
    {
      id: 'Home', label: 'Chat assistant',
      icon: <svg width={17} height={17} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"/></svg>,
    },
    {
      id: 'Resumes', label: 'Resumes',
      icon: <svg width={17} height={17} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="1.5" width="10" height="13" rx="1.6"/><path d="M6 5h4M6 8h4M6 11h2.5"/></svg>,
    },
    {
      id: 'Tracking', label: 'Tracker',
      badge: appsData.filter(j => j.status === 'applied').length || null,
      icon: <svg width={17} height={17} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M5 6h6M5 9h4"/></svg>,
    },
    {
      id: 'Account', label: 'Account',
      icon: <svg width={17} height={17} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><circle cx="8" cy="5" r="3"/><path d="M2.5 14c0-3 2.4-4.6 5.5-4.6S13.5 11 13.5 14"/></svg>,
    },
  ]

  // ── Apps strip tab config ───────────────────────────────────────────────────
  const appTabDefs = [
    { id: 'all', label: 'All' },
    { id: 'applied', label: 'Applied' },
    { id: 'interviewing', label: 'Interviewing' },
    { id: 'offered', label: 'Offered' },
    { id: 'rejected', label: 'Rejected' },
  ]

  const filteredApps = appsTab === 'all'
    ? appsData
    : appsData.filter(a => a.status === appsTab)

  // ── Search ⌘K shortcut ──────────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        document.querySelector('[data-rk-search]')?.focus()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <div
      className="rk-root"
      data-theme={theme}
      style={{
        display: 'flex', height: '100vh', width: '100%', overflow: 'hidden',
        background: 'var(--bg)', color: 'var(--text)', fontFamily: 'var(--font-sans)',
        position: 'fixed', inset: 0, zIndex: 1,
      }}
    >
      <style>{`
        @keyframes rkFadeUp  { from{opacity:0;transform:translateY(22px)} to{opacity:1;transform:translateY(0)} }
        @keyframes rkFadeIn  { from{opacity:0} to{opacity:1} }
        @keyframes rkScaleIn { from{opacity:0;transform:scale(.97)} to{opacity:1;transform:scale(1)} }
        @keyframes rkDrawer  { from{transform:translateX(102%)} to{transform:translateX(0)} }
        @keyframes rkSpin    { to{transform:rotate(360deg)} }
        @keyframes rkPulse   { 0%,100%{opacity:.35} 50%{opacity:.9} }
        @keyframes rkShimmer { 0%{background-position:-420px 0} 100%{background-position:420px 0} }
        @keyframes rkBeacon  { 0%,100%{box-shadow:0 0 0 0 rgba(232,255,107,0.0)} 50%{box-shadow:0 0 0 5px rgba(232,255,107,0.16)} }
        .rk-root ::-webkit-scrollbar{width:8px;height:8px}
        .rk-root ::-webkit-scrollbar-thumb{background:var(--scrollbar-thumb);border-radius:6px}
        .rk-root ::-webkit-scrollbar-track{background:transparent}
        .rk-job-card:hover { transform: translateY(-4px) !important; border-color: var(--border-bright) !important; box-shadow: var(--card-hover-shadow) !important; }
        .rk-nav-item:hover { background: var(--surface2) !important; color: var(--text) !important; }
        .rk-app-row:hover { background: var(--surface2) !important; }
      `}</style>

      {/* ── SIDEBAR ── */}
      <aside style={{
        width: 252, flexShrink: 0, height: '100%',
        background: 'var(--sidebar-bg)', borderRight: '1px solid var(--border)',
        display: 'flex', flexDirection: 'column', padding: '22px 16px 16px',
        position: 'relative', zIndex: 5,
      }}>
        {/* Logo */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '4px 8px 22px' }}>
          <div style={{
            width: 32, height: 32, borderRadius: 9,
            background: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: 'var(--accent-glow)', flexShrink: 0,
          }}>
            <svg width={17} height={17} viewBox="0 0 16 16" fill="none" stroke="var(--accent-contrast)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 11V5l6-3 6 3v6l-6 3z"/><path d="M8 8l6-3M8 8v6M8 8L2 5"/></svg>
          </div>
          <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, fontSize: 18, letterSpacing: '0.02em' }}>
            RACK
          </span>
        </div>

        {/* Nav */}
        <nav style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          {navItems.map(item => (
            <NavItem
              key={item.id}
              icon={item.icon}
              label={item.label}
              active={activeNav === item.id}
              badge={item.badge}
              onClick={() => {
                if (item.id === 'Matches') {
                  setActiveNav('Matches')
                } else if (item.id === 'BrowseAll') {
                  navigate('Tracking')
                } else {
                  navigate(item.id)
                }
              }}
            />
          ))}
        </nav>

        <div style={{ height: 1, background: 'var(--border)', margin: '18px 8px' }}/>

        {/* Ask Rack button */}
        <AskRackButton onClick={() => setAssistantOpen(true)} />

        <div style={{ flex: 1 }}/>

        {/* User / usage card */}
        <UserCard name={firstName} onUpgrade={() => navigate('Account')} />
      </aside>

      {/* ── MAIN ── */}
      <main style={{ flex: 1, height: '100%', overflowY: 'auto', position: 'relative' }}>
        {/* Ambient glows */}
        <div style={{ position: 'absolute', top: -160, left: -80, width: 520, height: 520, borderRadius: '50%', background: 'radial-gradient(circle, var(--glow-1), transparent 68%)', pointerEvents: 'none', zIndex: 0 }}/>
        <div style={{ position: 'absolute', top: 120, right: -140, width: 480, height: 480, borderRadius: '50%', background: 'radial-gradient(circle, var(--glow-2), transparent 70%)', pointerEvents: 'none', zIndex: 0 }}/>

        <div style={{ position: 'relative', zIndex: 1, maxWidth: 1240, margin: '0 auto', padding: '30px 40px 60px' }}>

          {/* Header row */}
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 20, marginBottom: 24 }}>
            <div>
              <h1 style={{ fontSize: 25, fontWeight: 600, letterSpacing: '-0.01em', margin: '0 0 5px' }}>
                {greeting}, {firstName}
              </h1>
              <p style={{ fontSize: 14, color: 'var(--text-mid)', margin: 0 }}>
                {phase === 'ready' && allJobs.length > 0 ? (
                  <>
                    <span style={{ color: 'var(--accent-ink)', fontFamily: 'var(--font-mono)', fontWeight: 600 }}>
                      {allJobs.length}
                    </span>
                    {' '}matches scored for you · ranked by fit
                  </>
                ) : phase === 'scanning' ? (
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-dim)' }}>
                    Scanning job pool…
                  </span>
                ) : (
                  'Your personalised job matches'
                )}
              </p>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <ThemeToggle theme={theme} onToggle={toggleTheme} />
              <UserAvatar initial={userInitial} onClick={() => navigate('Account')} />
            </div>
          </div>

          {/* Search */}
          <div style={{ position: 'relative' }}>
            <input
              data-rk-search
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Search by title, company, or skill…"
              style={{
                width: '100%', boxSizing: 'border-box',
                display: 'flex', alignItems: 'center',
                padding: '0 18px 0 48px', height: 52, borderRadius: 14,
                border: '1px solid var(--border-bright)', background: 'var(--surface)',
                boxShadow: 'var(--card-shadow)', marginBottom: 14,
                fontFamily: 'var(--font-sans)', fontSize: 14.5, color: 'var(--text)',
                outline: 'none',
              }}
            />
            <svg style={{ position: 'absolute', left: 18, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', marginTop: -7 }}
              width={18} height={18} viewBox="0 0 16 16" fill="none" stroke="var(--text-dim)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <circle cx={7} cy={7} r={5}/><path d="M11 11l3.5 3.5"/>
            </svg>
            <kbd style={{
              position: 'absolute', right: 16, top: '50%', transform: 'translateY(-50%)', marginTop: -7,
              fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-dim)',
              border: '1px solid var(--border)', borderRadius: 6, padding: '3px 7px',
              background: 'var(--chip-bg)', pointerEvents: 'none',
            }}>⌘K</kbd>
          </div>

          {/* Filter bar */}
          <FilterBar
            activeFilters={activeFilters}
            onFilterChange={(filterId, val) => setActiveFilters(prev => ({ ...prev, [filterId]: val }))}
            onClearAll={() => setActiveFilters({})}
          />

          {/* Section header */}
          {phase === 'ready' && allJobs.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, marginBottom: 18 }}>
              <div>
                <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0, display: 'flex', alignItems: 'center', gap: 9 }}>
                  Top matches
                  <span style={{
                    fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 500,
                    color: 'var(--text-dim)', background: 'var(--chip-bg)',
                    padding: '2px 9px', borderRadius: 20,
                  }}>
                    {visibleJobs.length} shown
                  </span>
                  {filteredJobs.length > DASHBOARD_JOB_CAP && (
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-dim)' }}>
                      of {filteredJobs.length}
                    </span>
                  )}
                </h2>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <SecondaryBtn onClick={() => navigate('Tracking')} icon={
                  <svg width={14} height={14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M2 4h12M2 8h7M2 12h4"/><circle cx="12" cy="11.5" r="2.4"/></svg>
                }>
                  Browse all jobs
                </SecondaryBtn>
                <ApplyAllBtn
                  label={allApplied ? 'All queued ✓' : `Apply to all ${visibleJobs.filter(j => !appliedIds.has(j.job_id || j.id)).length}`}
                  done={allApplied}
                  onClick={handleApplyAll}
                />
              </div>
            </div>
          )}

          {/* ── States ── */}
          {(phase === 'loading' || phase === 'scanning') && (
            <ScanningOverlay step={scanStep} total={4} pct={scanPct} />
          )}

          {phase === 'error' && (
            <EmptyState onRefresh={() => fetchMatches(true)} loading={false} />
          )}

          {phase === 'ready' && allJobs.length === 0 && (
            <EmptyState onRefresh={() => fetchMatches(true)} loading={false} />
          )}

          {phase === 'ready' && allJobs.length > 0 && (
            <>
              {filteredJobs.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '48px 24px', color: 'var(--text-dim)', fontSize: 14 }}>
                  No jobs match this filter.{' '}
                  <button onClick={() => setActiveFilters({})}
                    style={{ background: 'none', border: 'none', color: 'var(--accent-ink)', cursor: 'pointer', fontSize: 14, fontWeight: 600, padding: 0 }}>
                    Clear filters
                  </button>
                </div>
              ) : (
                <>
                  <div style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
                    gap: 18,
                  }}>
                    {visibleJobs.map((job, i) => (
                      <JobCard
                        key={job.job_id || job.id || i}
                        job={job}
                        appliedIds={appliedIds}
                        passedIds={passedIds}
                        onApply={handleApply}
                        onPass={handlePass}
                        revealed={i < revealCount}
                      />
                    ))}
                  </div>

                  {/* Browse All CTA — shown when there are more jobs than the cap */}
                  {filteredJobs.length > DASHBOARD_JOB_CAP && (
                    <BrowseAllCTA
                      total={filteredJobs.length}
                      shown={visibleJobs.length}
                      onClick={() => navigate('Tracking')}
                    />
                  )}
                </>
              )}

              {/* Applications strip */}
              {appsData.length > 0 && (
                <ApplicationsStrip
                  apps={filteredApps}
                  allApps={appsData}
                  activeTab={appsTab}
                  tabDefs={appTabDefs}
                  onTabChange={setAppsTab}
                  onOpenTracker={() => navigate('Tracking')}
                />
              )}
            </>
          )}
        </div>
      </main>

      {/* ── Ask Rack Drawer ── */}
      <AskRackDrawer
        open={assistantOpen}
        onClose={() => setAssistantOpen(false)}
        userName={firstName}
        onNavigate={navigate}
      />
    </div>
  )
}

// ── Small reusable components ─────────────────────────────────────────────────

function ThemeToggle({ theme, onToggle }) {
  const [hov, setHov] = useState(false)
  return (
    <button onClick={onToggle} title="Toggle theme"
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{
        width: 40, height: 40, borderRadius: 11, cursor: 'pointer',
        border: `1px solid ${hov ? 'var(--accent-line)' : 'var(--border-bright)'}`,
        background: 'var(--surface)', color: hov ? 'var(--text)' : 'var(--text-mid)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        transition: 'color 0.18s, border-color 0.18s',
      }}>
      {theme === 'dark'
        ? <svg width={17} height={17} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="8" cy="8" r="3.2"/><path d="M8 1v1.6M8 13.4V15M15 8h-1.6M2.6 8H1M12.5 3.5l-1.1 1.1M4.6 11.4l-1.1 1.1M12.5 12.5l-1.1-1.1M4.6 4.6L3.5 3.5"/></svg>
        : <svg width={17} height={17} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M13.5 9.2A5.6 5.6 0 0 1 6.8 2.5 5.6 5.6 0 1 0 13.5 9.2z"/></svg>
      }
    </button>
  )
}

function UserAvatar({ initial, onClick }) {
  const [hov, setHov] = useState(false)
  return (
    <div onClick={onClick}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{
        width: 40, height: 40, borderRadius: 11, cursor: 'pointer',
        background: 'linear-gradient(135deg, var(--accent2), var(--accent3))',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontWeight: 600, fontSize: 14, color: '#fff',
        opacity: hov ? 0.85 : 1, transition: 'opacity 0.18s',
      }}>
      {initial}
    </div>
  )
}

function AskRackButton({ onClick }) {
  const [hov, setHov] = useState(false)
  return (
    <button onClick={onClick}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 12, padding: 13,
        borderRadius: 13, cursor: 'pointer',
        border: `1px solid ${hov ? 'var(--accent-line)' : 'var(--border-bright)'}`,
        background: `linear-gradient(135deg, var(--surface2), var(--surface))`,
        color: 'var(--text)', fontFamily: 'var(--font-sans)', fontSize: 13.5,
        fontWeight: 600, textAlign: 'left', width: '100%',
        transition: 'border-color 0.18s',
      }}>
      <span style={{
        width: 30, height: 30, borderRadius: 9, background: 'var(--accent-soft)',
        border: '1px solid var(--accent-line)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        animation: 'rkBeacon 3s ease-in-out infinite',
      }}>
        <svg width={16} height={16} viewBox="0 0 16 16" fill="none" stroke="var(--accent-ink)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"/></svg>
      </span>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        Ask Rack
        <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--text-dim)' }}>Refine, ask, auto-apply</span>
      </span>
    </button>
  )
}

function UserCard({ name, onUpgrade }) {
  return (
    <div style={{
      border: '1px solid var(--border)', background: 'var(--surface)',
      borderRadius: 15, padding: 15, boxShadow: 'var(--card-shadow)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 3 }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>{name}</span>
        <span style={{
          fontSize: 10, fontWeight: 600, color: 'var(--text-dim)',
          textTransform: 'uppercase', letterSpacing: '0.08em',
          background: 'var(--chip-bg)', padding: '2px 7px', borderRadius: 6,
        }}>Free</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, margin: '10px 0 8px' }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 24, fontWeight: 600, color: 'var(--accent-ink)' }}>∞</span>
        <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>match scans</span>
      </div>
      <div style={{ height: 5, borderRadius: 4, background: 'var(--surface3)', overflow: 'hidden', marginBottom: 13 }}>
        <div style={{ height: '100%', width: '38%', borderRadius: 4, background: 'var(--accent)' }}/>
      </div>
      <UpgradeBtn onClick={onUpgrade} />
    </div>
  )
}

function UpgradeBtn({ onClick }) {
  const [hov, setHov] = useState(false)
  return (
    <button onClick={onClick}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{
        width: '100%', padding: 9, borderRadius: 10, border: 'none',
        cursor: 'pointer', background: hov ? 'var(--accent-strong)' : 'var(--accent)',
        color: 'var(--accent-contrast)', fontFamily: 'var(--font-sans)',
        fontSize: 12.5, fontWeight: 600, boxShadow: 'var(--accent-glow)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
        transition: 'background 0.18s',
      }}>
      <svg width={13} height={13} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M8 1.5l1.8 4.2 4.7.4-3.6 3 1.1 4.6L8 11.3 4 13.7l1.1-4.6-3.6-3 4.7-.4z"/></svg>
      Upgrade plan
    </button>
  )
}

function SecondaryBtn({ onClick, icon, children }) {
  const [hov, setHov] = useState(false)
  return (
    <button onClick={onClick}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 7, padding: '10px 15px',
        borderRadius: 11, cursor: 'pointer',
        border: `1px solid ${hov ? 'var(--accent-line)' : 'var(--border-bright)'}`,
        background: 'var(--surface)', color: hov ? 'var(--text)' : 'var(--text-mid)',
        fontFamily: 'var(--font-sans)', fontSize: 13, fontWeight: 600,
        transition: 'color 0.18s, border-color 0.18s',
      }}>
      {icon}{children}
    </button>
  )
}

function ApplyAllBtn({ label, done, onClick }) {
  const [hov, setHov] = useState(false)
  return (
    <button onClick={onClick}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '10px 17px',
        borderRadius: 11, cursor: done ? 'default' : 'pointer', border: 'none',
        background: done ? 'var(--surface2)' : hov ? 'var(--accent-strong)' : 'var(--accent)',
        color: done ? 'var(--text-dim)' : 'var(--accent-contrast)',
        fontFamily: 'var(--font-sans)', fontSize: 13.5, fontWeight: 600,
        boxShadow: done ? 'none' : 'var(--accent-glow)',
        transition: 'background 0.18s',
      }}>
      {!done && <svg width={15} height={15} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M8 1.5l1.8 4.2 4.7.4-3.6 3 1.1 4.6L8 11.3 4 13.7l1.1-4.6-3.6-3 4.7-.4z"/></svg>}
      {label}
    </button>
  )
}

function BrowseAllCTA({ total, shown, onClick }) {
  const [hov, setHov] = useState(false)
  return (
    <div style={{
      marginTop: 24,
      padding: '20px 24px',
      borderRadius: 16,
      border: '1px solid var(--border-bright)',
      background: 'linear-gradient(135deg, var(--surface) 0%, var(--surface2) 100%)',
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16,
      boxShadow: 'var(--card-shadow)',
    }}>
      <div>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 3 }}>
          Showing top {shown} of{' '}
          <span style={{ color: 'var(--accent-ink)', fontFamily: 'var(--font-mono)', fontWeight: 700 }}>
            {total}
          </span>{' '}
          matched jobs
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--text-dim)', lineHeight: 1.5 }}>
          Browse the full list with pagination, advanced filters, and apply tracking.
        </div>
      </div>
      <button
        onClick={onClick}
        onMouseEnter={() => setHov(true)}
        onMouseLeave={() => setHov(false)}
        style={{
          flexShrink: 0,
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '11px 20px', borderRadius: 11, border: 'none',
          background: hov ? 'var(--accent-strong)' : 'var(--accent)',
          color: 'var(--accent-contrast)', fontFamily: 'var(--font-sans)',
          fontSize: 13.5, fontWeight: 600, cursor: 'pointer',
          boxShadow: 'var(--accent-glow)', transition: 'background 0.18s',
          whiteSpace: 'nowrap',
        }}>
        Browse all {total} jobs
        <svg width={14} height={14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 8h9M8.5 4l4 4-4 4"/></svg>
      </button>
    </div>
  )
}

function ApplicationsStrip({ apps, allApps, activeTab, tabDefs, onTabChange, onOpenTracker }) {
  return (
    <div style={{ marginTop: 40 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, marginBottom: 16 }}>
        <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>Recent applications</h2>
        <SecondaryBtn onClick={onOpenTracker} icon={
          <svg width={13} height={13} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 8h9M8.5 4l4 4-4 4"/></svg>
        }>
          Open tracker
        </SecondaryBtn>
      </div>

      <div style={{ border: '1px solid var(--border)', background: 'var(--surface)', borderRadius: 16, boxShadow: 'var(--card-shadow)', overflow: 'hidden' }}>
        {/* Tabs */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '13px 16px', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
          {tabDefs.map(t => {
            const count = t.id === 'all' ? allApps.length : allApps.filter(a => a.status === t.id).length
            const active = activeTab === t.id
            return (
              <AppTabBtn key={t.id} label={t.label} count={count} active={active} onClick={() => onTabChange(t.id)} />
            )
          })}
        </div>
        {/* Table header */}
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1.4fr 1.1fr 1fr', gap: 14, padding: '11px 18px', borderBottom: '1px solid var(--border)' }}>
          {['Company / Role', 'Resume', 'Status', 'Applied'].map((h, i) => (
            <span key={h} style={{
              fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 600,
              letterSpacing: '0.1em', color: 'var(--text-dim)', textTransform: 'uppercase',
              textAlign: i === 3 ? 'right' : 'left',
            }}>{h}</span>
          ))}
        </div>
        {/* Rows */}
        {apps.length === 0 ? (
          <div style={{ padding: '34px', textAlign: 'center', color: 'var(--text-dim)', fontSize: 13 }}>
            No applications match this filter.
          </div>
        ) : apps.map((a, i) => (
          <AppRow key={i} app={a} last={i === apps.length - 1} />
        ))}
      </div>
    </div>
  )
}

function AppTabBtn({ label, count, active, onClick }) {
  const [hov, setHov] = useState(false)
  return (
    <button onClick={onClick}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 7, padding: '6px 12px',
        borderRadius: 9, cursor: 'pointer', fontFamily: 'var(--font-sans)',
        fontSize: 12.5, fontWeight: 600,
        border: `1px solid ${active ? 'var(--accent-line)' : hov ? 'var(--border-bright)' : 'var(--border)'}`,
        background: active ? 'var(--accent-soft)' : 'transparent',
        color: active ? 'var(--text)' : 'var(--text-mid)',
        transition: 'background 0.18s, color 0.15s, border-color 0.18s',
      }}>
      {label}
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, background: 'var(--chip-bg)', padding: '1px 6px', borderRadius: 20, color: 'var(--text-dim)' }}>
        {count}
      </span>
    </button>
  )
}

function AppRow({ app, last }) {
  const [hov, setHov] = useState(false)
  const brand  = brandColor(app.company || '')
  const initial = (app.company || '?').charAt(0).toUpperCase()
  const st = statusMeta(app.status)
  const title = app.job_title || app.title || 'Role'
  const posted = app.updated_at || app.created_at
  const daysLabel = posted ? daysAgoLabel(posted) : '—'
  return (
    <div
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{
        display: 'grid', gridTemplateColumns: '2fr 1.4fr 1.1fr 1fr', gap: 14,
        padding: '14px 18px', borderBottom: last ? 'none' : '1px solid var(--border)',
        alignItems: 'center', background: hov ? 'var(--surface2)' : 'transparent',
        transition: 'background 0.18s',
      }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 11, minWidth: 0 }}>
        <div style={{
          width: 32, height: 32, borderRadius: 9, flexShrink: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontWeight: 700, fontSize: 13, color: '#fff', background: brand,
        }}>{initial}</div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</div>
          <div style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>{app.company}</div>
        </div>
      </div>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--text-mid)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {app.resume_name || '—'}
      </span>
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        fontSize: 11.5, fontWeight: 600, color: st.color,
        background: st.bg, padding: '4px 10px', borderRadius: 20,
        whiteSpace: 'nowrap', justifySelf: 'start',
      }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: st.color, flexShrink: 0 }}/>
        {st.label}
      </span>
      <span style={{ fontSize: 12, color: 'var(--text-dim)', textAlign: 'right' }}>{daysLabel}</span>
    </div>
  )
}