import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../context/AuthContext'
import { API_BASE, getAuthHeaders } from '../utils/api'
import { useTheme } from '../App'
import Sidebar from '../components/Sidebar'

const API = `${API_BASE}/api/account`

/* ── Google Icon ─────────────────────────────────────────────────────────── */
function GoogleIcon({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none">
      <path d="M17.64 9.205c0-.639-.057-1.252-.164-1.841H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615Z" fill="#4285F4"/>
      <path d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18Z" fill="#34A853"/>
      <path d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332Z" fill="#FBBC05"/>
      <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58Z" fill="#EA4335"/>
    </svg>
  )
}

/* ── ChipInput ────────────────────────────────────────────────────────────── */
function ChipInput({ items, onUpdate, presets, placeholder, accent = 'var(--accent)' }) {
  const [input, setInput] = useState('')
  const [focused, setFocused] = useState(false)
  const add = (val) => { const t = val.trim(); if (t && !items.includes(t)) onUpdate([...items, t]); setInput('') }
  const remove = (val) => onUpdate(items.filter(i => i !== val))
  const handleKey = (e) => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(input) }
    if (e.key === 'Backspace' && !input && items.length) remove(items[items.length - 1])
  }
  const unused = presets ? presets.filter(p => !items.includes(p)) : []
  return (
    <div>
      {items.length > 0 && (
        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 10 }}>
          {items.map(item => (
            <span key={item} style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              padding: '3px 10px', borderRadius: 20,
              background: `${accent}12`, border: `1px solid ${accent}25`,
              color: accent, fontSize: 12, fontWeight: 500,
            }}>
              {item}
              <button onClick={() => remove(item)} style={{ background: 'none', border: 'none', color: accent, cursor: 'pointer', fontSize: 12, padding: 0, opacity: 0.5, lineHeight: 1 }}>✕</button>
            </span>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        <input type="text" value={input} onChange={e => setInput(e.target.value)} onKeyDown={handleKey}
          onFocus={() => setFocused(true)} onBlur={() => setTimeout(() => setFocused(false), 200)}
          placeholder={placeholder}
          style={{ flex: 1, padding: '8px 13px', borderRadius: 9, border: '1px solid var(--border)', background: 'var(--surface2)', color: 'var(--text)', fontFamily: 'var(--font-sans)', fontSize: 13, outline: 'none' }}
        />
        {input.trim() && (
          <button onClick={() => add(input)} style={{ padding: '8px 15px', borderRadius: 9, border: 'none', background: accent, color: '#000', fontWeight: 600, fontSize: 12, cursor: 'pointer' }}>Add</button>
        )}
      </div>
      {focused && unused.length > 0 && (
        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 8 }}>
          {unused.slice(0, 6).map(p => (
            <button key={p} onMouseDown={() => add(p)} style={{ padding: '3px 10px', borderRadius: 20, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-dim)', fontSize: 11, cursor: 'pointer', fontFamily: 'var(--font-sans)' }}>+ {p}</button>
          ))}
        </div>
      )}
    </div>
  )
}

/* ── FieldRow — label + right-aligned control ─────────────────────────────── */
function FieldRow({ label, sub, children, last }) {
  return (
    <div className="rk-acct-fieldrow" style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      gap: 16, padding: '14px 0',
      borderBottom: last ? 'none' : '1px solid var(--border)',
      flexWrap: 'wrap',
    }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 550, color: 'var(--text)', letterSpacing: '-0.01em' }}>{label}</div>
        {sub && <div style={{ fontSize: 11.5, color: 'var(--text-dim)', marginTop: 2, lineHeight: 1.4 }}>{sub}</div>}
      </div>
      <div className="rk-acct-fieldctrl" style={{ flexShrink: 0 }}>{children}</div>
    </div>
  )
}

/* ── SettingsCard — section wrapper ──────────────────────────────────────── */
function SettingsCard({ title, children, action }) {
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 16, overflow: 'hidden', marginBottom: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '15px 20px', borderBottom: '1px solid var(--border)' }}>
        <span style={{ fontSize: 13, fontWeight: 650, color: 'var(--text)', letterSpacing: '-0.01em' }}>{title}</span>
        {action}
      </div>
      <div style={{ padding: '0 20px' }}>
        {children}
      </div>
    </div>
  )
}

/* ── StyledInput ──────────────────────────────────────────────────────────── */
function StyledInput({ value, onChange, placeholder, type = 'text', width, align = 'left' }) {
  return (
    <input type={type} value={value || ''} onChange={onChange} placeholder={placeholder}
      className="rk-acct-input"
      style={{
        width: width || '100%', padding: '8px 13px', borderRadius: 9, boxSizing: 'border-box',
        border: '1px solid var(--border)', background: 'var(--surface2)',
        color: 'var(--text)', fontFamily: 'var(--font-sans)', fontSize: 13, outline: 'none',
        textAlign: align,
      }}
    />
  )
}

/* ── PillToggle — Yes / No selector ──────────────────────────────────────── */
function PillToggle({ value, onChange, options = ['yes', 'no'] }) {
  return (
    <div style={{ display: 'flex', gap: 5 }}>
      {options.map(opt => (
        <button key={opt} onClick={() => onChange(opt)} style={{
          padding: '6px 16px', borderRadius: 20, border: '1px solid var(--border)',
          background: value === opt ? 'var(--accent-soft)' : 'transparent',
          color: value === opt ? 'var(--accent-ink)' : 'var(--text-dim)',
          borderColor: value === opt ? 'var(--accent-line)' : 'var(--border)',
          fontFamily: 'var(--font-sans)', fontSize: 12, fontWeight: 600,
          cursor: 'pointer', textTransform: 'capitalize', transition: 'all 0.15s',
        }}>{opt}</button>
      ))}
    </div>
  )
}

/* ── ChipToggle — multi-option pill selector ─────────────────────────────── */
function ChipToggle({ value, onChange, options }) {
  return (
    <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
      {options.map(opt => (
        <button key={opt.value} onClick={() => onChange(opt.value)} style={{
          padding: '5px 12px', borderRadius: 20, cursor: 'pointer', transition: 'all 0.15s',
          fontFamily: 'var(--font-sans)', fontSize: 11, fontWeight: 500,
          border: '1px solid var(--border)',
          background: value === opt.value ? 'var(--accent-soft)' : 'transparent',
          color: value === opt.value ? 'var(--accent-ink)' : 'var(--text-dim)',
          borderColor: value === opt.value ? 'var(--accent-line)' : 'var(--border)',
        }}>{opt.label}</button>
      ))}
    </div>
  )
}

/* ── SectionLabel ─────────────────────────────────────────────────────────── */
function SectionLabel({ children }) {
  return (
    <div style={{
      fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em',
      color: 'var(--text-dim)', marginBottom: 12, marginTop: 28, paddingLeft: 2,
    }}>{children}</div>
  )
}

/* ══════════════════════════════════════════════════════════════════════════ */
export default function Account({ onNavigate }) {
  const { user, authLoading, signInWithGoogle, signOut } = useAuth()
  const { theme, toggleTheme } = useTheme()

  const navigate = (tab) => onNavigate?.(tab)

  if (authLoading) {
    return (
      <div style={{ position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)', color: 'var(--text-dim)' }}>
        <div style={{ width: 28, height: 28, border: '2px solid var(--surface2)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'rkSpin 0.8s linear infinite' }}/>
      </div>
    )
  }

  if (!user) {
    return <SignInPage onSignIn={signInWithGoogle} navigate={navigate} theme={theme} toggleTheme={toggleTheme} />
  }

  return <AccountDashboard user={user} onSignOut={signOut} navigate={navigate} theme={theme} toggleTheme={toggleTheme} />
}

/* ── Sign-in page — full sidebar layout ──────────────────────────────────── */
function SignInPage({ onSignIn, navigate, theme, toggleTheme }) {
  const displayName = ''
  const userInitial = ''
  return (
    <div className="rk-acct-root" data-theme={theme} style={{ display: 'flex', height: '100dvh', width: '100%', overflow: 'hidden', background: 'var(--bg)', color: 'var(--text)', fontFamily: 'var(--font-sans)', position: 'fixed', inset: 0, zIndex: 1 }}>
      <style>{`@keyframes rkSpin{to{transform:rotate(360deg)}} @keyframes rkFadeUp{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}
        @media (max-width: 767px){ .rk-acct-root{ flex-direction: column !important; } .rk-acct-main{ flex:1 !important; min-height:0 !important; height:auto !important; } }`}</style>
      <Sidebar activeNav="Account" onNavigate={navigate} userName="" userInitial="" theme={theme} onToggleTheme={toggleTheme} />
      <main className="rk-acct-main" style={{ flex: 1, height: '100%', overflowY: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '40px 24px' }}>
        <div style={{ width: '100%', maxWidth: 400, animation: 'rkFadeUp 0.4s ease both' }}>
          <div style={{ textAlign: 'center', marginBottom: 36 }}>
            <div style={{ width: 52, height: 52, borderRadius: 14, background: 'var(--accent-soft)', border: '1px solid var(--accent-line)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 20px' }}>
              <svg width={22} height={22} viewBox="0 0 16 16" fill="none" stroke="var(--accent-ink)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="8" cy="5" r="3"/><path d="M2.5 14c0-3 2.4-4.6 5.5-4.6S13.5 11 13.5 14"/></svg>
            </div>
            <div style={{ fontSize: 22, fontWeight: 650, letterSpacing: '-0.02em', marginBottom: 8 }}>Sign in to RACK</div>
            <div style={{ fontSize: 13.5, color: 'var(--text-dim)', lineHeight: 1.5 }}>AI-powered job matching that works<br/>while you're upskilling yourself.</div>
          </div>
          <button onClick={onSignIn} style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
            width: '100%', padding: '13px 24px', borderRadius: 12,
            border: '1px solid var(--border-bright)', background: 'var(--surface)',
            color: 'var(--text)', fontFamily: 'var(--font-sans)',
            fontSize: 14, fontWeight: 600, cursor: 'pointer', marginBottom: 16,
            transition: 'border-color 0.15s, background 0.15s',
          }}
          onMouseEnter={e => { e.currentTarget.style.background = 'var(--surface2)'; e.currentTarget.style.borderColor = 'var(--border-bright)' }}
          onMouseLeave={e => { e.currentTarget.style.background = 'var(--surface)'; e.currentTarget.style.borderColor = 'var(--border-bright)' }}>
            <GoogleIcon size={18} />
            Continue with Google
          </button>
          <div style={{ fontSize: 11.5, color: 'var(--text-dim)', textAlign: 'center', lineHeight: 1.6, opacity: 0.6 }}>
            We store your email and resume data only.<br/>Nothing is sold, shared, or used for advertising.
          </div>
        </div>
      </main>
    </div>
  )
}

/* ── UserAvatar — handles Google image with referrer fix + error fallback ──── */
function UserAvatar({ src, initials, size = 56 }) {
  const [error, setError] = useState(false)
  if (src && !error) {
    return (
      <img
        src={src}
        alt="avatar"
        referrerPolicy="no-referrer"
        onError={() => setError(true)}
        style={{ width: size, height: size, borderRadius: '50%', border: '2px solid var(--border-bright)', flexShrink: 0, objectFit: 'cover' }}
      />
    )
  }
  return (
    <div style={{ width: size, height: size, borderRadius: '50%', background: 'linear-gradient(135deg, var(--accent2,#7c5cff), var(--accent3,#34d399))', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: size * 0.35, color: '#fff', flexShrink: 0 }}>
      {initials}
    </div>
  )
}

/* ── Authenticated Account Dashboard ─────────────────────────────────────── */
function AccountDashboard({ user, onSignOut, navigate, theme, toggleTheme }) {
  const [profile, setProfile] = useState(null)
  const [presets, setPresets] = useState({ roles: [], locations: [] })
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [loading, setLoading] = useState(true)
  const [roleAliases, setRoleAliases] = useState({})
  const [fetchingAliases, setFetchingAliases] = useState(new Set())
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)
  const [activeTab, setActiveTab] = useState('profile')

  const displayName = user.user_metadata?.full_name || user.user_metadata?.name || user.email?.split('@')[0] || 'there'
  const firstName = displayName.split(' ')[0]
  const userInitial = firstName.charAt(0).toUpperCase()
  const avatarUrl = user.user_metadata?.avatar_url
  const initials = displayName.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2)

  const loadProfile = useCallback(async () => {
    try {
      const h = await getAuthHeaders()
      const r = await fetch(`${API}/profile`, { headers: h })
      if (r.ok) {
        const data = await r.json()
        setProfile(data)
        if (data.role_aliases && Object.keys(data.role_aliases).length > 0) setRoleAliases(data.role_aliases)
      }
    } catch {}
    setLoading(false)
  }, [])

  const loadPresets = useCallback(async () => {
    try {
      const r = await fetch(`${API}/presets`)
      if (r.ok) setPresets(await r.json())
    } catch {}
  }, [])

  useEffect(() => { loadProfile(); loadPresets() }, [loadProfile, loadPresets])

  const updateField = (field, value) => { setProfile(p => ({ ...p, [field]: value })); setSaved(false) }

  const saveProfile = async () => {
    setSaving(true); setSaved(false)
    try {
      const h = await getAuthHeaders()
      const r = await fetch(`${API}/profile`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...h },
        body: JSON.stringify({ ...profile, role_aliases: roleAliases }),
      })
      if (r.ok) { setProfile(await r.json()); setSaved(true); setTimeout(() => setSaved(false), 3000) }
    } catch {}
    setSaving(false)
  }

  const fetchAliasesForRole = useCallback(async (role) => {
    if (roleAliases[role]?.length > 0) return
    setFetchingAliases(prev => new Set([...prev, role]))
    try {
      const h = await getAuthHeaders()
      const r = await fetch(`${API}/role-aliases`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...h },
        body: JSON.stringify({ role }),
      })
      if (r.ok) { const d = await r.json(); setRoleAliases(prev => ({ ...prev, [role]: d.aliases })) }
    } catch {}
    setFetchingAliases(prev => { const n = new Set(prev); n.delete(role); return n })
  }, [roleAliases])

  const updateRoles = (newRoles) => {
    const currentRoles = profile?.target_roles || []
    const added = newRoles.filter(r => !currentRoles.includes(r))
    const removed = currentRoles.filter(r => !newRoles.includes(r))
    updateField('target_roles', newRoles)
    if (removed.length > 0) setRoleAliases(prev => { const n = { ...prev }; removed.forEach(r => delete n[r]); return n })
    added.forEach(r => fetchAliasesForRole(r))
  }

  const SIDEBAR_TABS = [
    { id: 'profile',     label: 'Profile',         icon: <svg width={15} height={15} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><circle cx="8" cy="5" r="3"/><path d="M2.5 14c0-3 2.4-4.6 5.5-4.6S13.5 11 13.5 14"/></svg> },
    { id: 'preferences', label: 'Job Preferences',  icon: <svg width={15} height={15} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M2 4h12M5 8h6M7 12h2"/></svg> },
    { id: 'identity',    label: 'Identity & EEO',   icon: <svg width={15} height={15} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M5 8h6M5 10.5h3"/></svg> },
    { id: 'appearance',  label: 'Appearance',        icon: <svg width={15} height={15} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><circle cx="8" cy="8" r="2.8"/><path d="M8 1.5v1.4M8 13.1v1.4M1.5 8h1.4M13.1 8h1.4M4 4l1 1M11 11l1 1M12 4l-1 1M5 11l-1 1"/></svg> },
  ]

  return (
    <div className="rk-acct-root" data-theme={theme} style={{ display: 'flex', height: '100dvh', width: '100%', overflow: 'hidden', background: 'var(--bg)', color: 'var(--text)', fontFamily: 'var(--font-sans)', position: 'fixed', inset: 0, zIndex: 1 }}>
      <style>{`
        @keyframes rkFadeUp { from{opacity:0;transform:translateY(16px)} to{opacity:1;transform:translateY(0)} }
        @keyframes rkSpin   { to{transform:rotate(360deg)} }
        @keyframes rkLogoutShimmer {
          0%   { background-position: -600px 0; }
          100% { background-position:  600px 0; }
        }
        .rk-acct-root ::-webkit-scrollbar { width: 6px }
        .rk-acct-root ::-webkit-scrollbar-thumb { background: var(--scrollbar-thumb); border-radius: 6px }
        .rk-acct-root ::-webkit-scrollbar-track { background: transparent }
        .rk-settings-tab { display:flex; align-items:center; gap:10px; padding:9px 12px; border-radius:10px; cursor:pointer; font-size:13px; font-weight:500; border:1px solid transparent; transition:background 0.15s, color 0.15s, border-color 0.15s; user-select:none; color:var(--text-mid); }
        .rk-settings-tab:hover { background:var(--surface2); color:var(--text); }
        .rk-settings-tab.active { background:var(--accent-soft); border-color:var(--accent-line); color:var(--text); font-weight:600; }
        .rk-settings-tab.active svg { color:var(--accent-ink); }
        .rk-field-input { width:100%; padding:8px 13px; border-radius:9px; border:1px solid var(--border); background:var(--surface2); color:var(--text); font-family:var(--font-sans); font-size:13px; outline:none; box-sizing:border-box; transition:border-color 0.15s; }
        .rk-field-input:focus { border-color:var(--accent-line); }

        .rk-acct-main { overflow-x: hidden; }
        .rk-acct-content { padding: 30px 32px 60px; }
        @media (max-width: 1199px) {
          .rk-acct-content { padding: 24px 24px 60px; }
        }
        /* Tablet/mobile: stack columns; turn the settings nav into a horizontal
           scroller instead of hiding it (so sections stay switchable). */
        @media (max-width: 900px) {
          .rk-acct-cols { flex-direction: column !important; align-items: stretch !important; }
          .rk-acct-settings-nav { width: 100% !important; position: static !important; }
          .rk-acct-settings-nav > div { display: flex !important; flex-direction: row !important; overflow-x: auto !important; gap: 6px; scrollbar-width: none; }
          .rk-acct-settings-nav > div::-webkit-scrollbar { display: none; }
          .rk-settings-tab { white-space: nowrap; flex-shrink: 0; }
        }
        @media (max-width: 767px) {
          .rk-acct-root { flex-direction: column !important; }
          .rk-acct-main { flex: 1 !important; min-height: 0 !important; height: auto !important; }
          .rk-acct-content { padding: 16px 14px calc(56px + env(safe-area-inset-bottom,0px) + 16px) !important; }
          .rk-acct-fieldrow { flex-direction: column !important; align-items: stretch !important; gap: 8px !important; }
          .rk-acct-fieldctrl { width: 100% !important; }
          .rk-acct-input { width: 100% !important; text-align: left !important; }
        }
      `}</style>

      {/* ── Logout overlay ── */}
      {loggingOut && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'var(--bg)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
          <div style={{ width: 36, height: 36, border: '3px solid var(--surface2)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'rkSpin 0.8s linear infinite' }}/>
          <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-dim)' }}>Signing out…</div>
        </div>
      )}

      {/* ── Logout confirm modal ── */}
      {showLogoutConfirm && (
        <div onClick={() => setShowLogoutConfirm(false)} style={{ position: 'fixed', inset: 0, zIndex: 9998, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, animation: 'rkFadeUp 0.2s ease both' }}>
          <div onClick={e => e.stopPropagation()} style={{ width: '100%', maxWidth: 360, background: 'var(--surface)', border: '1px solid var(--border-bright)', borderRadius: 20, padding: '32px 28px 24px', textAlign: 'center', animation: 'rkFadeUp 0.25s ease both' }}>
            <div style={{ fontSize: 19, fontWeight: 650, letterSpacing: '-0.02em', marginBottom: 10 }}>Sign out of RACK?</div>
            <div style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 24, lineHeight: 1.5 }}>Signed in as<br/><span style={{ color: 'var(--text-mid)', fontWeight: 500 }}>{user.email}</span></div>
            <button onClick={async () => { setShowLogoutConfirm(false); setLoggingOut(true); await onSignOut(); setTimeout(() => setLoggingOut(false), 1200) }}
              style={{ display: 'block', width: '100%', padding: '13px 24px', borderRadius: 11, border: 'none', background: 'rgba(248,113,113,0.15)', color: '#f87171', borderColor: 'rgba(248,113,113,0.3)', fontFamily: 'var(--font-sans)', fontWeight: 650, fontSize: 14, cursor: 'pointer', marginBottom: 8, transition: 'opacity 0.15s' }}>
              Sign out
            </button>
            <button onClick={() => setShowLogoutConfirm(false)} style={{ display: 'block', width: '100%', padding: '13px 24px', borderRadius: 11, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-dim)', fontFamily: 'var(--font-sans)', fontSize: 14, cursor: 'pointer', transition: 'background 0.15s' }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* ── Global sidebar ── */}
      <Sidebar
        activeNav="Account"
        onNavigate={(tab) => navigate(tab === 'Account' ? null : tab)}
        userName={firstName}
        userInitial={userInitial}
        userAvatarUrl={avatarUrl}
        onAskRack={() => navigate('Home')}
        theme={theme}
        onToggleTheme={toggleTheme}
      />

      {/* ── Main ── */}
      <main className="rk-acct-main" style={{ flex: 1, height: '100%', overflowY: 'auto', position: 'relative' }}>
        {/* Ambient glows */}
        <div style={{ position: 'absolute', top: -120, left: -60, width: 480, height: 480, borderRadius: '50%', background: 'radial-gradient(circle, var(--glow-1), transparent 68%)', pointerEvents: 'none', zIndex: 0 }}/>
        <div style={{ position: 'absolute', bottom: 80, right: -100, width: 380, height: 380, borderRadius: '50%', background: 'radial-gradient(circle, var(--glow-2), transparent 70%)', pointerEvents: 'none', zIndex: 0 }}/>

        <div className="rk-acct-content" style={{ position: 'relative', zIndex: 1, maxWidth: 1100, margin: '0 auto' }}>

          {/* ── Page header ── */}
          <div style={{ marginBottom: 32, animation: 'rkFadeUp 0.35s ease both' }}>
            <h1 style={{ fontSize: 24, fontWeight: 650, letterSpacing: '-0.02em', margin: '0 0 4px' }}>Account</h1>
            <p style={{ fontSize: 14, color: 'var(--text-mid)', margin: 0 }}>Manage your profile, preferences, and settings</p>
          </div>

          {/* ── User identity card ── */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 18, padding: '20px 24px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 16, marginBottom: 28, animation: 'rkFadeUp 0.38s ease both' }}>
            <UserAvatar src={avatarUrl} initials={initials} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 16, fontWeight: 650, letterSpacing: '-0.01em', marginBottom: 2 }}>{displayName}</div>
              <div style={{ fontSize: 12.5, color: 'var(--text-dim)' }}>{user.email}</div>
            </div>
            <button onClick={() => setShowLogoutConfirm(true)} style={{ padding: '7px 16px', borderRadius: 10, border: '1px solid rgba(248,113,113,0.25)', background: 'rgba(248,113,113,0.06)', color: '#f87171', fontFamily: 'var(--font-sans)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', flexShrink: 0, transition: 'background 0.15s' }}
              onMouseEnter={e => e.currentTarget.style.background = 'rgba(248,113,113,0.12)'}
              onMouseLeave={e => e.currentTarget.style.background = 'rgba(248,113,113,0.06)'}>
              Sign out
            </button>
          </div>

          {/* ── Two-column layout ── */}
          <div className="rk-acct-cols" style={{ display: 'flex', gap: 24, alignItems: 'flex-start' }}>

            {/* Left: settings nav */}
            <div className="rk-acct-settings-nav" style={{ width: 220, flexShrink: 0, position: 'sticky', top: 0 }}>
              <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: '8px', animation: 'rkFadeUp 0.4s ease both' }}>
                {SIDEBAR_TABS.map(tab => (
                  <div key={tab.id} className={`rk-settings-tab${activeTab === tab.id ? ' active' : ''}`} onClick={() => setActiveTab(tab.id)}>
                    <span style={{ display: 'flex', flexShrink: 0 }}>{tab.icon}</span>
                    {tab.label}
                  </div>
                ))}
              </div>
            </div>

            {/* Right: content panels */}
            <div style={{ flex: 1, minWidth: 0, animation: 'rkFadeUp 0.42s ease both' }}>

              {loading && (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '60px 0', gap: 12, color: 'var(--text-dim)' }}>
                  <div style={{ width: 22, height: 22, border: '2px solid var(--surface2)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'rkSpin 0.8s linear infinite' }}/>
                  Loading profile…
                </div>
              )}

              {!loading && profile && activeTab === 'profile' && (
                <>
                  <SettingsCard title="Personal information">
                    <FieldRow label="First name" sub="Used in auto-apply forms">
                      <StyledInput value={profile.first_name} onChange={e => updateField('first_name', e.target.value)} placeholder="First name" width={180} />
                    </FieldRow>
                    <FieldRow label="Middle name">
                      <StyledInput value={profile.middle_name} onChange={e => updateField('middle_name', e.target.value)} placeholder="optional" width={180} />
                    </FieldRow>
                    <FieldRow label="Last name">
                      <StyledInput value={profile.last_name} onChange={e => updateField('last_name', e.target.value)} placeholder="Last name" width={180} />
                    </FieldRow>
                    <FieldRow label="Phone number" sub="Used for application phone fields">
                      <StyledInput value={profile.phone} onChange={e => updateField('phone', e.target.value)} placeholder="+1 (555) 000-0000" type="tel" width={200} align="right" />
                    </FieldRow>
                    <FieldRow label="Current location" sub="City, State — filled into location fields" last>
                      <StyledInput value={profile.current_location} onChange={e => updateField('current_location', e.target.value)} placeholder="New York, NY" width={200} align="right" />
                    </FieldRow>
                  </SettingsCard>

                  <SettingsCard title="Online presence">
                    <FieldRow label="LinkedIn URL" sub="linkedin.com/in/yourhandle">
                      <StyledInput value={profile.linkedin} onChange={e => updateField('linkedin', e.target.value)} placeholder="linkedin.com/in/…" type="url" width={220} align="right" />
                    </FieldRow>
                    <FieldRow label="GitHub URL" sub="github.com/yourhandle">
                      <StyledInput value={profile.github} onChange={e => updateField('github', e.target.value)} placeholder="github.com/…" type="url" width={220} align="right" />
                    </FieldRow>
                    <FieldRow label="Portfolio / Website" sub="Personal site or portfolio URL" last>
                      <StyledInput value={profile.website} onChange={e => updateField('website', e.target.value)} placeholder="yoursite.com" type="url" width={220} align="right" />
                    </FieldRow>
                  </SettingsCard>

                  <SettingsCard title="Work authorization">
                    <FieldRow label="Authorized to work" sub="Legally authorized without sponsorship">
                      <PillToggle value={profile.work_auth} onChange={v => updateField('work_auth', v)} />
                    </FieldRow>
                    <FieldRow label="Requires sponsorship" sub="Need visa sponsorship now or in the future?" last>
                      <PillToggle value={profile.requires_sponsorship} onChange={v => updateField('requires_sponsorship', v)} />
                    </FieldRow>
                  </SettingsCard>
                </>
              )}

              {!loading && profile && activeTab === 'preferences' && (
                <>
                  <SettingsCard title="Target roles">
                    <div style={{ paddingTop: 16, paddingBottom: 16 }}>
                      <ChipInput items={profile.target_roles || []} onUpdate={updateRoles} presets={presets.roles} placeholder="Type a role and press Enter…" accent="var(--accent)" />
                      {(profile.target_roles || []).length > 0 && (
                        <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
                          {(profile.target_roles || []).map(role => {
                            const aliases = roleAliases[role] || []
                            const fetching = fetchingAliases.has(role)
                            return (
                              <div key={role} style={{ padding: '10px 14px', borderRadius: 10, background: 'var(--surface2)', border: '1px solid var(--border)' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: fetching || aliases.length > 0 ? 8 : 0 }}>
                                  <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent-ink)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{role}</span>
                                  <span style={{ fontSize: 10.5, color: 'var(--text-dim)' }}>also matches:</span>
                                  {fetching && <span style={{ fontSize: 10, color: 'var(--text-dim)', display: 'inline-flex', alignItems: 'center', gap: 4 }}><span style={{ display: 'inline-block', animation: 'rkSpin 1s linear infinite' }}>⟳</span> generating…</span>}
                                </div>
                                {!fetching && aliases.length > 0 && (
                                  <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                                    {aliases.map(alias => (
                                      <span key={alias} style={{ fontSize: 10, padding: '2px 8px', borderRadius: 20, background: 'rgba(232,255,107,0.06)', border: '1px solid rgba(232,255,107,0.12)', color: 'var(--text-dim)' }}>{alias}</span>
                                    ))}
                                  </div>
                                )}
                                {!fetching && aliases.length === 0 && (
                                  <button onClick={() => fetchAliasesForRole(role)} style={{ fontSize: 10, padding: '2px 10px', borderRadius: 20, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-dim)', cursor: 'pointer' }}>+ generate related titles</button>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  </SettingsCard>

                  <SettingsCard title="Preferred locations">
                    <div style={{ paddingTop: 16, paddingBottom: 16 }}>
                      <ChipInput items={profile.preferred_locations || []} onUpdate={v => updateField('preferred_locations', v)} presets={presets.locations} placeholder="Type a location and press Enter…" accent="var(--accent2)" />
                      <div style={{ marginTop: 10, padding: '9px 13px', borderRadius: 9, background: 'rgba(167,139,250,0.06)', border: '1px solid rgba(167,139,250,0.15)', fontSize: 11.5, color: 'var(--text-dim)', lineHeight: 1.6 }}>
                        <span style={{ color: 'var(--accent2)', fontWeight: 600 }}>Tip:</span> Use a country (e.g. "United States") to match all cities and remote jobs within it.
                      </div>
                    </div>
                  </SettingsCard>

                  <SettingsCard title="Experience level">
                    <div style={{ display: 'flex', gap: 14, alignItems: 'center', padding: '16px 0' }}>
                      {['min_years', 'max_years'].map((field, i) => (
                        <div key={field}>
                          <div style={{ fontSize: 10.5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-dim)', marginBottom: 6 }}>{i === 0 ? 'Min years' : 'Max years'}</div>
                          <input type="number" min={0} max={30} value={profile[field] ?? ''} onChange={e => updateField(field, e.target.value ? parseInt(e.target.value) : null)} placeholder={i === 0 ? '0' : '10'} style={{ width: 72, padding: '8px 10px', borderRadius: 9, textAlign: 'center', border: '1px solid var(--border)', background: 'var(--surface2)', color: 'var(--text)', fontFamily: 'var(--font-sans)', fontSize: 13, outline: 'none' }} />
                        </div>
                      ))}
                      <span style={{ color: 'var(--text-dim)', fontSize: 12, marginTop: 18 }}>years of experience</span>
                    </div>
                  </SettingsCard>

                  <SettingsCard title="Keywords">
                    <div style={{ paddingTop: 14, paddingBottom: 16 }}>
                      <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-dim)', marginBottom: 8 }}>Include</div>
                      <ChipInput items={profile.include_keywords || []} onUpdate={v => updateField('include_keywords', v)} presets={[]} placeholder="e.g. python, pytorch, rag…" accent="var(--accent3)" />
                      <div style={{ height: 1, background: 'var(--border)', margin: '16px 0' }}/>
                      <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-dim)', marginBottom: 8 }}>Exclude</div>
                      <ChipInput items={profile.exclude_keywords || []} onUpdate={v => updateField('exclude_keywords', v)} presets={[]} placeholder="e.g. senior, staff, director…" accent="var(--danger)" />
                    </div>
                  </SettingsCard>

                  <div style={{ padding: '12px 16px', borderRadius: 12, background: 'var(--surface)', border: '1px solid var(--border)', marginBottom: 20 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 5 }}>How filtering works</div>
                    <div style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.65 }}>Your preferences filter jobs <em>before</em> the RACK pipeline runs — narrowing to relevant roles before scoring.</div>
                    <div style={{ display: 'flex', gap: 5, marginTop: 10, flexWrap: 'wrap' }}>
                      {['4k+ fetched', '→ roles', '→ location', '→ ~20', '→ LLM', '→ RACK'].map((s, i) => (
                        <span key={s} style={{ fontSize: 10, fontWeight: 600, padding: '3px 9px', borderRadius: 20, background: i === 5 ? 'var(--accent-soft)' : 'var(--surface2)', color: i === 5 ? 'var(--accent-ink)' : 'var(--text-dim)', border: i === 5 ? '1px solid var(--accent-line)' : '1px solid var(--border)' }}>{s}</span>
                      ))}
                    </div>
                  </div>
                </>
              )}

              {!loading && profile && activeTab === 'identity' && (
                <>
                  <SettingsCard title="Voluntary Self-ID (EEO)"
                    action={<span style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>Used only for application forms</span>}>
                    <FieldRow label="Gender">
                      <ChipToggle value={profile.gender_eeo} onChange={v => updateField('gender_eeo', v)} options={[{label:'Male',value:'male'},{label:'Female',value:'female'},{label:'Non-binary',value:'non_binary'},{label:'Decline',value:'decline'}]} />
                    </FieldRow>
                    <FieldRow label="Veteran status">
                      <ChipToggle value={profile.veteran_status} onChange={v => updateField('veteran_status', v)} options={[{label:'Veteran',value:'protected_veteran'},{label:'Not a veteran',value:'not_a_veteran'},{label:'Decline',value:'decline'}]} />
                    </FieldRow>
                    <FieldRow label="Disability status">
                      <ChipToggle value={profile.disability_status} onChange={v => updateField('disability_status', v)} options={[{label:'Yes',value:'yes'},{label:'No',value:'no'},{label:'Decline',value:'decline'}]} />
                    </FieldRow>
                    <FieldRow label="Race / Ethnicity" last>
                      <ChipToggle value={profile.ethnicity_eeo} onChange={v => updateField('ethnicity_eeo', v)} options={[{label:'South Asian',value:'south_asian'},{label:'East Asian',value:'east_asian'},{label:'Black',value:'black'},{label:'Hispanic',value:'hispanic'},{label:'White',value:'white'},{label:'Two or more',value:'two_or_more'},{label:'Decline',value:'decline'}]} />
                    </FieldRow>
                  </SettingsCard>
                  <div style={{ padding: '12px 16px', borderRadius: 12, background: 'var(--surface)', border: '1px solid var(--border)', fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.65 }}>
                    Defaults to "Decline to self-identify" if not set. This information is <strong style={{ color: 'var(--text-mid)' }}>never used for matching</strong> — only pre-filled into application EEO forms on your behalf.
                  </div>
                </>
              )}

              {activeTab === 'appearance' && (
                <SettingsCard title="Appearance">
                  <FieldRow label={theme === 'dark' ? 'Dark mode' : 'Light mode'} sub={theme === 'dark' ? 'Switch to the cream light theme' : 'Switch to the dark theme'} last>
                    <button onClick={toggleTheme} style={{ width: 52, height: 28, borderRadius: 14, border: 'none', background: theme === 'dark' ? 'rgba(255,255,255,0.12)' : 'var(--accent)', position: 'relative', cursor: 'pointer', flexShrink: 0, transition: 'background 0.25s', padding: 0 }}>
                      <span style={{ position: 'absolute', top: 3, left: theme === 'dark' ? 3 : 25, width: 22, height: 22, borderRadius: '50%', background: theme === 'dark' ? 'rgba(255,255,255,0.6)' : '#000', transition: 'left 0.25s cubic-bezier(0.34,1.56,0.64,1)', display: 'block' }} />
                    </button>
                  </FieldRow>
                </SettingsCard>
              )}

              {/* ── Save button ── */}
              {!loading && profile && activeTab !== 'appearance' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 4 }}>
                  <button onClick={saveProfile} disabled={saving} style={{ padding: '11px 28px', borderRadius: 11, border: 'none', background: 'var(--accent)', color: 'var(--accent-contrast)', fontFamily: 'var(--font-sans)', fontWeight: 700, fontSize: 13.5, cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.65 : 1, transition: 'opacity 0.2s', letterSpacing: '-0.01em' }}>
                    {saving ? 'Saving…' : 'Save changes'}
                  </button>
                  {saved && (
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--accent3)', animation: 'rkFadeUp 0.3s ease both' }}>
                      <svg width={14} height={14} viewBox="0 0 14 14" fill="none"><path d="M2 7l3.5 3.5 6.5-6.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>
                      Saved
                    </span>
                  )}
                </div>
              )}

            </div>
          </div>
        </div>
      </main>
    </div>
  )
}