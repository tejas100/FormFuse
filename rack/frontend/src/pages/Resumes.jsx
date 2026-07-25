import { useState, useRef, useEffect } from 'react'
import { useAuth } from '../context/AuthContext'
import { getAuthHeaders } from '../utils/api'
import { useTheme } from '../App'
import Sidebar from '../components/Sidebar'

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000'
const LS_KEY   = 'rack_resumes'
const ANON_CAP = 5
const AUTH_CAP = 5

// ── localStorage helpers ──────────────────────────────────────────────────────
function lsRead()       { try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]') } catch { return [] } }
function lsWrite(arr)   { try { localStorage.setItem(LS_KEY, JSON.stringify(arr)) } catch {} }
function lsDelete(id)   { const a = lsRead().filter(r => r.id !== id); lsWrite(a); return a }
function getSessionId() {
  let sid = localStorage.getItem('rack_session_id')
  if (!sid) { sid = 'anon_' + Math.random().toString(36).slice(2,10) + '_' + Math.random().toString(36).slice(2,10); localStorage.setItem('rack_session_id', sid) }
  return sid
}
function fileToBase64(file) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result.split(',')[1]); r.onerror = () => rej(new Error('Read failed')); r.readAsDataURL(file) })
}
function base64ToBlobUrl(b64, mime) {
  const bin = atob(b64); const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return URL.createObjectURL(new Blob([bytes], { type: mime }))
}
function formatTime(iso) {
  if (!iso) return ''
  if (!iso.includes('T')) return iso
  const d = new Date(iso), now = new Date(), ms = now - d
  const mins = Math.floor(ms/60000), hrs = Math.floor(ms/3600000), days = Math.floor(ms/86400000)
  if (mins < 1) return 'Just now'; if (mins < 60) return `${mins}m ago`
  if (hrs  < 24) return `${hrs}h ago`; if (days < 7) return `${days}d ago`
  if (days < 30) return `${Math.floor(days/7)}w ago`
  return d.toLocaleDateString()
}

// ── Resume card ───────────────────────────────────────────────────────────────
function ResumeCard({ r, index, isAuthed, onDownload, onView, onDelete, onNavigate }) {
  const [hov, setHov] = useState(false)
  const isActive = r.status === 'active'

  return (
    <div
      className="rk-res-card"
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      onClick={onView}
      style={{
        borderRadius: 16,
        border: hov ? '1px solid var(--border-bright)' : '1px solid var(--border)',
        background: 'var(--surface)',
        boxShadow: hov ? 'var(--card-hover-shadow)' : 'var(--card-shadow)',
        padding: '14px 14px 12px', display: 'flex', flexDirection: 'column', gap: 10,
        opacity: 0, animation: `rkFadeUp 0.42s cubic-bezier(0.22,1,0.36,1) ${Math.min(index * 0.06, 0.35)}s forwards`,
        transition: 'border-color 0.2s, box-shadow 0.25s, transform 0.22s',
        position: 'relative', cursor: 'pointer', minWidth: 0,
      }}
    >
      {/* Top row — file icon + action buttons */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <div className="rk-res-card-icon" style={{
          width: 32, height: 32, borderRadius: 9, flexShrink: 0,
          background: 'var(--surface2)', border: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <svg width={15} height={15} viewBox="0 0 16 16" fill="none" stroke="var(--text-dim)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 2H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V6z"/>
            <path d="M9 2v4h4"/>
          </svg>
        </div>

        <div className="rk-res-card-actions" style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <span className="rk-res-card-badge" style={{
            fontSize: 9, fontWeight: 700, padding: '2px 7px', borderRadius: 20,
            textTransform: 'uppercase', letterSpacing: '0.08em',
            background: isActive ? 'rgba(52,211,153,0.12)' : 'var(--chip-bg)',
            color: isActive ? '#34d399' : 'var(--text-dim)',
            border: isActive ? '1px solid rgba(52,211,153,0.2)' : '1px solid var(--border)',
          }}>{r.status || 'active'}</span>

          <button className="rk-res-card-btn" onClick={e => { e.stopPropagation(); onDownload() }} title="Download"
            style={{ width: 26, height: 26, borderRadius: 7, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-dim)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'border-color 0.15s, color 0.15s' }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--border-bright)'; e.currentTarget.style.color = 'var(--text)' }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--text-dim)' }}>
            <svg width={11} height={11} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M7 1v8M4 6l3 3 3-3"/><path d="M1 11h12"/></svg>
          </button>

          <button className="rk-res-card-btn" onClick={e => { e.stopPropagation(); onView() }} title="View"
            style={{ width: 26, height: 26, borderRadius: 7, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-dim)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'border-color 0.15s, color 0.15s' }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--border-bright)'; e.currentTarget.style.color = 'var(--text)' }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--text-dim)' }}>
            <svg width={11} height={11} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><ellipse cx="8" cy="8" rx="6" ry="4"/><circle cx="8" cy="8" r="1.8"/></svg>
          </button>

          <button className="rk-res-card-btn" onClick={e => { e.stopPropagation(); onDelete() }} title="Delete"
            style={{ width: 26, height: 26, borderRadius: 7, border: '1px solid rgba(248,113,113,0.18)', background: 'rgba(248,113,113,0.06)', color: '#f87171', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'background 0.15s, border-color 0.15s' }}
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(248,113,113,0.14)'; e.currentTarget.style.borderColor = 'rgba(248,113,113,0.35)' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'rgba(248,113,113,0.06)'; e.currentTarget.style.borderColor = 'rgba(248,113,113,0.18)' }}>
            <svg width={10} height={10} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round"><path d="M2 2l8 8M10 2l-8 8"/></svg>
          </button>
        </div>
      </div>

      <h3 className="rk-res-card-name" style={{
        fontSize: 13.5, fontWeight: 600, color: 'var(--text)', letterSpacing: '-0.01em',
        margin: 0, lineHeight: 1.3,
        display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
      }}>
        {r.name}
      </h3>

      <div className="rk-res-card-meta" style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-dim)', flexWrap: 'wrap' }}>
        <span>{formatTime(r.uploaded_at)}</span>
        {r.file_ext && (
          <><span style={{ opacity: 0.35 }}>·</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, fontWeight: 600, color: 'var(--accent-ink)', opacity: 0.75 }}>
            {r.file_ext.replace('.', '').toUpperCase()}
          </span></>
        )}
        {r.chunk_count > 0 && (
          <><span style={{ opacity: 0.35 }}>·</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5 }}>{r.chunk_count} chunks</span></>
        )}
      </div>

      <div className="rk-res-card-divider" style={{ height: 1, background: 'var(--border)' }}/>

      {r.skills && r.skills.length > 0 ? (
        <div className="rk-res-card-skills" style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {r.skills.slice(0, 4).map(s => (
            <span key={s} style={{
              fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-mid)',
              background: 'var(--chip-bg)', border: '1px solid var(--chip-border)',
              padding: '2px 7px', borderRadius: 6,
              maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>{s}</span>
          ))}
          {r.skills.length > 4 && (
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-dim)', padding: '2px 3px' }}>+{r.skills.length - 4}</span>
          )}
        </div>
      ) : (
        <div className="rk-res-card-skills" style={{ fontSize: 11, color: 'var(--text-dim)', opacity: 0.5 }}>No skills extracted</div>
      )}
    </div>
  )
}

// ── Upload Card ────────────────────────────────────────────────────────────────
function UploadCard({ atCap, uploading, isAuthed, onClick }) {
  const [hov, setHov] = useState(false)
  return (
    <button className="rk-res-upload-card" onClick={onClick} disabled={uploading || atCap}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{
        borderRadius: 16,
        border: `1px dashed ${atCap ? 'var(--border)' : hov ? 'rgba(232,255,107,0.5)' : 'var(--border-bright)'}`,
        background: atCap ? 'transparent' : hov ? 'rgba(232,255,107,0.03)' : 'transparent',
        padding: '14px 14px 12px', display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: 8,
        minHeight: 160, cursor: atCap || uploading ? 'not-allowed' : 'pointer',
        color: atCap ? 'var(--text-dim)' : hov ? 'var(--accent)' : 'var(--text-mid)',
        transition: 'all 0.2s', opacity: uploading ? 0.4 : 1,
        fontFamily: 'var(--font-sans)',
      }}>
      <div className="rk-res-upload-card-icon" style={{
        width: 32, height: 32, borderRadius: 9,
        border: `1.5px dashed ${atCap ? 'var(--border)' : hov ? 'rgba(232,255,107,0.5)' : 'var(--border-bright)'}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        transition: 'all 0.2s',
      }}>
        <svg width={14} height={14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          {atCap
            ? <path d="M3 8h10M8 3v10"/>
            : <><path d="M8 2v8"/><path d="M5 5l3-3 3 3"/><path d="M2 13h12"/></>
          }
        </svg>
      </div>
      <div style={{ textAlign: 'center' }}>
        <div className="rk-res-upload-card-label" style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 2 }}>
          {atCap ? 'Limit reached' : 'Upload resume'}
        </div>
        <div className="rk-res-upload-card-sub" style={{ fontSize: 11, opacity: 0.55 }}>
          {atCap
            ? (isAuthed ? 'Pro tier coming soon' : 'Sign in to add more')
            : 'PDF or DOCX · up to 10MB'}
        </div>
      </div>
    </button>
  )
}

// ── Skeleton Card ─────────────────────────────────────────────────────────────
function SkeletonCard() {
  return (
    <div style={{
      borderRadius: 18, border: '1px solid var(--border)', background: 'var(--surface)',
      padding: '20px', minHeight: 180, overflow: 'hidden', position: 'relative',
    }}>
      <div style={{
        position: 'absolute', inset: 0,
        background: 'linear-gradient(90deg, transparent, var(--chip-bg), transparent)',
        backgroundSize: '420px 100%', animation: 'rkShimmer 1.4s linear infinite',
      }}/>
      <div style={{ width: 38, height: 38, borderRadius: 10, background: 'var(--surface2)', marginBottom: 14 }}/>
      <div style={{ width: '65%', height: 13, borderRadius: 4, background: 'var(--surface2)', marginBottom: 8 }}/>
      <div style={{ width: '40%', height: 10, borderRadius: 4, background: 'var(--surface2)', marginBottom: 16 }}/>
      <div style={{ display: 'flex', gap: 6 }}>
        {[52, 68, 44].map((w, i) => <div key={i} style={{ width: w, height: 22, borderRadius: 7, background: 'var(--surface2)' }}/>)}
      </div>
    </div>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function Resumes({ onNavigate }) {
  const { user, session, authLoading } = useAuth()
  const { theme, toggleTheme } = useTheme()
  const isAuthed = !!user

  const [resumes, setResumes]             = useState([])
  const [loading, setLoading]             = useState(true)
  const [uploading, setUploading]         = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState(null)
  const [toast, setToast]                 = useState(null)
  const [viewerResume, setViewerResume]   = useState(null)   // resume object being previewed
  const [viewerUrl, setViewerUrl]         = useState(null)   // blob/signed URL for the iframe

  const fileInputRef = useRef(null)
  const blobUrlsRef  = useRef({})

  const navigate = (tab) => onNavigate?.(tab)

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3200)
  }

  // ── Load ────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (authLoading) return
    if (isAuthed) { loadFromDB() } else { setResumes(lsRead()); setLoading(false) }
  }, [isAuthed, authLoading])

  useEffect(() => () => { Object.values(blobUrlsRef.current).forEach(u => URL.revokeObjectURL(u)) }, [])

  const loadFromDB = async () => {
    setLoading(true)
    try {
      const h = await getAuthHeaders()
      const r = await fetch(`${API_BASE}/api/resumes`, { headers: h })
      if (!r.ok) throw new Error('Failed to load')
      const d = await r.json()
      setResumes(d.resumes || [])
    } catch (e) { showToast('Failed to load resumes.', 'error') }
    finally { setLoading(false) }
  }

  // ── Upload ──────────────────────────────────────────────────────────────────
  const handleFileChange = async (e) => {
    const file = e.target.files[0]; if (!file) return
    const allowed = ['application/pdf','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document']
    if (!allowed.includes(file.type)) { showToast('Only PDF or DOCX files are allowed.', 'error'); e.target.value = ''; return }
    if (!isAuthed && resumes.length >= ANON_CAP) { showToast(`Anonymous limit is ${ANON_CAP}. Sign in to upload more.`, 'error'); e.target.value = ''; return }
    setUploading(true)
    try {
      const fd = new FormData(); fd.append('file', file)
      const h = await getAuthHeaders()
      const r = await fetch(`${API_BASE}/api/resumes/upload`, { method: 'POST', headers: h, body: fd })
      if (!r.ok) { const err = await r.json(); throw new Error(err.detail || 'Upload failed') }
      const data = await r.json(); const resume = data.resume
      if (isAuthed) {
        await loadFromDB()
        showToast(`"${resume.name}" uploaded — ${resume.chunk_count} chunks ready`)
      } else {
        const b64 = await fileToBase64(file)
        const entry = { ...resume, fileBase64: b64, fileType: file.type }
        const updated = [...lsRead(), entry]; lsWrite(updated); setResumes(updated)
        showToast(`"${resume.name}" uploaded — ${resume.chunk_count} chunks ready`)
      }
    } catch (e) { showToast(e.message || 'Upload failed.', 'error') }
    finally { setUploading(false); e.target.value = '' }
  }

  // ── Delete ──────────────────────────────────────────────────────────────────
  const handleDelete = async (id) => {
    try {
      if (isAuthed) {
        const h = await getAuthHeaders()
        const r = await fetch(`${API_BASE}/api/resumes/${id}`, { method: 'DELETE', headers: h })
        if (!r.ok) throw new Error('Delete failed')
        setResumes(p => p.filter(r => r.id !== id))
      } else {
        const sid = getSessionId()
        const r = await fetch(`${API_BASE}/api/resumes/${id}`, { method: 'DELETE', headers: { 'X-Session-ID': sid } })
        if (!r.ok) throw new Error('Delete failed')
        const updated = lsDelete(id); setResumes(updated)
        if (blobUrlsRef.current[id]) { URL.revokeObjectURL(blobUrlsRef.current[id]); delete blobUrlsRef.current[id] }
      }
      setDeleteConfirm(null); showToast('Resume deleted.')
    } catch (e) { showToast('Failed to delete.', 'error'); setDeleteConfirm(null) }
  }

  // ── View / Download ─────────────────────────────────────────────────────────
  const handleView = async (resume) => {
    setViewerResume(resume)
    setViewerUrl(null)   // show loading state in sheet immediately
    try {
      let url
      if (isAuthed) {
        const h = await getAuthHeaders()
        const r = await fetch(`${API_BASE}/api/resumes/${resume.id}/file`, { headers: h })
        if (!r.ok) throw new Error()
        const d = await r.json()
        url = d.url
      } else {
        if (!resume.fileBase64) throw new Error('No file data')
        if (!blobUrlsRef.current[resume.id]) {
          blobUrlsRef.current[resume.id] = base64ToBlobUrl(resume.fileBase64, resume.fileType || 'application/pdf')
        }
        url = blobUrlsRef.current[resume.id]
      }
      setViewerUrl(url)
    } catch {
      setViewerResume(null)
      setViewerUrl(null)
      showToast('Could not open file.', 'error')
    }
  }

  const handleCloseViewer = () => { setViewerResume(null); setViewerUrl(null) }

  const handleDownload = async (resume) => {
    try {
      if (isAuthed) {
        const h = await getAuthHeaders(); const r = await fetch(`${API_BASE}/api/resumes/${resume.id}/file`, { headers: h }); if (!r.ok) throw new Error(); const d = await r.json()
        const fr = await fetch(d.url); const blob = await fr.blob(); const url = URL.createObjectURL(blob)
        const a = document.createElement('a'); a.href = url; a.download = resume.name || 'resume'; document.body.appendChild(a); a.click(); document.body.removeChild(a); setTimeout(() => URL.revokeObjectURL(url), 10000)
      } else {
        if (!resume.fileBase64) { showToast('File unavailable.', 'error'); return }
        if (!blobUrlsRef.current[resume.id]) blobUrlsRef.current[resume.id] = base64ToBlobUrl(resume.fileBase64, resume.fileType || 'application/pdf')
        const a = document.createElement('a'); a.href = blobUrlsRef.current[resume.id]; a.download = resume.name || 'resume'; document.body.appendChild(a); a.click(); document.body.removeChild(a)
      }
    } catch { showToast('Could not download file.', 'error') }
  }

  // ── Derived ─────────────────────────────────────────────────────────────────
  const activeCount = resumes.filter(r => r.status === 'active').length
  const cap   = isAuthed ? AUTH_CAP : ANON_CAP
  const atCap = resumes.length >= cap

  const displayName = user?.user_metadata?.full_name || user?.user_metadata?.name || user?.email?.split('@')[0] || 'there'
  const firstName   = displayName.split(' ')[0]
  const userInitial = firstName.charAt(0).toUpperCase()
  const avatarUrl   = user?.user_metadata?.avatar_url || null

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <div className="rk-root" data-theme={theme}
      style={{ display: 'flex', height: '100dvh', width: '100%', overflow: 'hidden',
        background: 'var(--bg)', color: 'var(--text)', fontFamily: 'var(--font-sans)',
        position: 'fixed', inset: 0, zIndex: 1 }}>

      <style>{`
        @keyframes rkFadeUp  { from{opacity:0;transform:translateY(20px)} to{opacity:1;transform:translateY(0)} }
        @keyframes rkShimmer { 0%{background-position:-420px 0} 100%{background-position:420px 0} }
        @keyframes rkSpin    { to{transform:rotate(360deg)} }
        @keyframes rkViewerIn { from{opacity:0;transform:translateY(100%)} to{opacity:1;transform:translateY(0)} }
        .rk-root ::-webkit-scrollbar{width:8px} .rk-root ::-webkit-scrollbar-thumb{background:var(--scrollbar-thumb);border-radius:6px} .rk-root ::-webkit-scrollbar-track{background:transparent}

        .rk-res-main { overflow-x: hidden; }
        .rk-res-content { padding: 30px 40px 60px; }
        @media (max-width: 1199px) {
          .rk-res-content { padding: 24px 24px 60px; }
          .rk-res-grid { grid-template-columns: repeat(3, 1fr) !important; }
        }
        @media (max-width: 767px) {
          .rk-root { flex-direction: column !important; }
          .rk-res-main { flex: 1 !important; min-height: 0 !important; height: auto !important; }
          .rk-res-content { padding: 14px 12px calc(56px + env(safe-area-inset-bottom,0px) + 16px) !important; padding-top: calc(52px + 14px) !important; }
          .rk-res-grid { grid-template-columns: 1fr 1fr !important; gap: 8px !important; }
          /* Header */
          .rk-res-header { margin-bottom: 14px !important; }
          .rk-res-header h1 { font-size: 20px !important; margin-bottom: 2px !important; }
          .rk-res-header p  { font-size: 12px !important; }
          .rk-res-upload-btn { display: none !important; }
          /* Card — compact everything */
          .rk-res-card { padding: 10px 10px 9px !important; gap: 7px !important; border-radius: 12px !important; }
          .rk-res-card-icon { width: 26px !important; height: 26px !important; border-radius: 7px !important; }
          .rk-res-card-icon svg { width: 12px !important; height: 12px !important; }
          .rk-res-card-actions { gap: 3px !important; }
          .rk-res-card-badge { font-size: 7.5px !important; padding: 2px 5px !important; }
          .rk-res-card-btn { width: 22px !important; height: 22px !important; border-radius: 6px !important; }
          .rk-res-card-btn svg { width: 9px !important; height: 9px !important; }
          .rk-res-card-name { font-size: 12px !important; -webkit-line-clamp: 2 !important; }
          .rk-res-card-meta { font-size: 10px !important; gap: 4px !important; }
          .rk-res-card-skills { display: none !important; }
          .rk-res-card-divider { display: none !important; }
          /* Upload card */
          .rk-res-upload-card { min-height: 120px !important; padding: 10px !important; gap: 6px !important; border-radius: 12px !important; }
          .rk-res-upload-card-icon { width: 26px !important; height: 26px !important; border-radius: 7px !important; }
          .rk-res-upload-card-label { font-size: 11.5px !important; }
          .rk-res-upload-card-sub { display: none !important; }
        }
        @media (max-width: 420px) {
          .rk-res-content { padding-top: calc(52px + 12px) !important; }
          .rk-res-grid { gap: 7px !important; }
        }
      `}</style>

      {/* ── SIDEBAR ── */}
      <Sidebar
        activeNav="Resumes"
        onNavigate={(tab) => navigate(tab === 'Resumes' ? null : tab)}
        userName={firstName}
        userInitial={userInitial}
        userAvatarUrl={avatarUrl}
        userStat={`${resumes.length} / ${cap} resume${cap !== 1 ? 's' : ''} used`}
        onAskRack={() => navigate('Home')}
        theme={theme}
        onToggleTheme={toggleTheme}
      />

      {/* ── MAIN ── */}
      <main className="rk-res-main" style={{ flex: 1, height: '100%', overflowY: 'auto', position: 'relative' }}>
        {/* Ambient glows */}
        <div style={{ position: 'absolute', top: -160, left: -80, width: 520, height: 520, borderRadius: '50%', background: 'radial-gradient(circle, var(--glow-1), transparent 68%)', pointerEvents: 'none', zIndex: 0 }}/>
        <div style={{ position: 'absolute', top: 200, right: -140, width: 400, height: 400, borderRadius: '50%', background: 'radial-gradient(circle, var(--glow-2), transparent 70%)', pointerEvents: 'none', zIndex: 0 }}/>

        <div className="rk-res-content" style={{ position: 'relative', zIndex: 1 }}>

          {/* Page header — matches Dashboard rk-header-row pattern */}
          <div className="rk-res-header" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 20, marginBottom: 28 }}>
            <div>
              <h1 style={{ fontSize: 25, fontWeight: 600, letterSpacing: '-0.01em', margin: '0 0 5px', color: 'var(--text)' }}>Resumes</h1>
              <p style={{ fontSize: 14, color: 'var(--text-mid)', margin: 0 }}>
                {loading ? 'Loading…' : (
                  <>
                    <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--accent-ink)' }}>{resumes.length}</span>
                    {' '}version{resumes.length !== 1 ? 's' : ''} · {activeCount} active
                  </>
                )}
              </p>
            </div>
            {/* Upload shortcut button — desktop only, matches Dashboard's header-actions */}
            {!atCap && (
              <button
                className="rk-res-upload-btn"
                onClick={() => !uploading && fileInputRef.current?.click()}
                disabled={uploading}
                style={{
                  display: 'flex', alignItems: 'center', gap: 7,
                  padding: '9px 16px', borderRadius: 12, cursor: 'pointer',
                  border: '1px solid var(--accent-line)', background: 'var(--accent-soft)',
                  color: 'var(--accent-ink)', fontFamily: 'var(--font-sans)',
                  fontSize: 13, fontWeight: 600, flexShrink: 0,
                  transition: 'background 0.15s, border-color 0.15s',
                  opacity: uploading ? 0.5 : 1,
                }}
                onMouseEnter={e => { e.currentTarget.style.background = 'rgba(232,255,107,0.12)'; e.currentTarget.style.borderColor = 'rgba(232,255,107,0.4)' }}
                onMouseLeave={e => { e.currentTarget.style.background = 'var(--accent-soft)'; e.currentTarget.style.borderColor = 'var(--accent-line)' }}
              >
                <svg width={13} height={13} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M8 2v8"/><path d="M5 5l3-3 3 3"/><path d="M2 13h12"/>
                </svg>
                Upload
              </button>
            )}
          </div>

          {/* Cap warning */}
          {atCap && (
            <div style={{
              marginBottom: 20, padding: '12px 18px', borderRadius: 14,
              background: 'rgba(251,191,36,0.06)', border: '1px solid rgba(251,191,36,0.2)',
              display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', animation: 'rkFadeUp 0.3s ease both',
            }}>
              <svg width={16} height={16} viewBox="0 0 16 16" fill="none" stroke="#fbbf24" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M8 2L1.5 13h13z"/><path d="M8 6v4M8 11.5v.5"/></svg>
              <span style={{ fontSize: 13, color: 'rgba(251,191,36,0.85)', flex: 1 }}>
                {isAuthed ? `You've reached the ${AUTH_CAP}-resume beta limit.` : `Anonymous limit reached (${ANON_CAP} resumes).`}
              </span>
              <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>
                {isAuthed ? 'Unlimited slots coming in Pro.' : 'Sign in to upload more.'}
              </span>
            </div>
          )}

          {/* Card grid */}
          <div className="rk-res-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16 }}>
            {loading
              ? [0,1,2].map(i => <SkeletonCard key={i}/>)
              : <>
                  {resumes.map((r, i) => (
                    <ResumeCard key={r.id} r={r} index={i} isAuthed={isAuthed}
                      onDownload={() => handleDownload(r)}
                      onView={() => handleView(r)}
                      onDelete={() => setDeleteConfirm(r.id)}
                      onNavigate={navigate}
                    />
                  ))}
                  <UploadCard atCap={atCap} uploading={uploading} isAuthed={isAuthed}
                    onClick={() => !atCap && fileInputRef.current?.click()} />
                </>
            }
          </div>

        </div>
      </main>

      {/* Hidden inputs */}
      <input ref={fileInputRef} type="file" accept=".pdf,.doc,.docx" style={{ display: 'none' }} onChange={handleFileChange}/>

      {/* Delete confirm modal */}
      {deleteConfirm && (
        <div style={{ position: 'fixed', inset: 0, background: 'var(--modal-overlay)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999 }}
          onClick={e => e.target === e.currentTarget && setDeleteConfirm(null)}>
          <div style={{ background: 'var(--bg)', border: '1px solid var(--border-bright)', borderRadius: 20, padding: '28px 32px', width: 340, maxWidth: '90vw', animation: 'rkFadeUp 0.25s ease both', boxShadow: 'var(--modal-shadow)' }}>
            <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>Delete resume?</div>
            <div style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 22, lineHeight: 1.6 }}>
              This will permanently remove the resume and its embeddings. This cannot be undone.
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setDeleteConfirm(null)}
                style={{ padding: '8px 18px', borderRadius: 10, border: '1px solid var(--border-bright)', background: 'transparent', color: 'var(--text)', fontFamily: 'var(--font-sans)', fontSize: 13, cursor: 'pointer' }}>
                Cancel
              </button>
              <button onClick={() => handleDelete(deleteConfirm)}
                style={{ padding: '8px 18px', borderRadius: 10, border: '1px solid rgba(248,113,113,0.3)', background: 'rgba(248,113,113,0.1)', color: '#f87171', fontFamily: 'var(--font-sans)', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Uploading overlay */}
      {uploading && (
        <div style={{ position: 'fixed', inset: 0, background: 'var(--modal-overlay)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9998 }}>
          <div style={{ background: 'var(--bg)', border: '1px solid rgba(232,255,107,0.2)', borderRadius: 20, padding: '40px', textAlign: 'center', animation: 'rkFadeUp 0.25s ease both', boxShadow: 'var(--modal-shadow)' }}>
            <div style={{ width: 40, height: 40, border: '3px solid var(--surface2)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'rkSpin 0.8s linear infinite', margin: '0 auto 16px' }}/>
            <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--accent-ink)', marginBottom: 5 }}>Processing resume…</div>
            <div style={{ fontSize: 12.5, color: 'var(--text-dim)' }}>Extracting text · parsing sections · chunking</div>
          </div>
        </div>
      )}

      {/* ── Resume Viewer ── */}
      {viewerResume && (
        <div
          onClick={handleCloseViewer}
          style={{
            position: 'fixed', inset: 0, zIndex: 10000,
            background: 'rgba(0,0,0,0.65)',
            backdropFilter: 'blur(6px)',
            display: 'flex', alignItems: 'flex-end',
            animation: 'rkFadeUp 0.2s ease both',
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              width: '100%', height: '94dvh',
              background: 'var(--bg)',
              borderRadius: '20px 20px 0 0',
              border: '1px solid var(--border-bright)',
              borderBottom: 'none',
              display: 'flex', flexDirection: 'column',
              overflow: 'hidden',
              animation: 'rkViewerIn 0.38s cubic-bezier(0.22,1,0.36,1) both',
              boxShadow: '0 -16px 60px rgba(0,0,0,0.45)',
            }}
          >
            {/* Handle bar */}
            <div style={{ display: 'flex', justifyContent: 'center', padding: '10px 0 4px', flexShrink: 0 }}>
              <div style={{ width: 36, height: 4, borderRadius: 2, background: 'var(--border-bright)' }}/>
            </div>

            {/* Header */}
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '8px 16px 12px', flexShrink: 0,
              borderBottom: '1px solid var(--border)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                <div style={{
                  width: 30, height: 30, borderRadius: 8, flexShrink: 0,
                  background: 'var(--surface2)', border: '1px solid var(--border)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  <svg width={13} height={13} viewBox="0 0 16 16" fill="none" stroke="var(--text-dim)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M9 2H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V6z"/><path d="M9 2v4h4"/>
                  </svg>
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {viewerResume.name}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 1 }}>
                    {viewerResume.file_ext?.replace('.','').toUpperCase()} · {viewerResume.chunk_count} chunks
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexShrink: 0 }}>
                {/* Download */}
                <button
                  onClick={() => handleDownload(viewerResume)}
                  title="Download"
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6,
                    padding: '7px 12px', borderRadius: 9, cursor: 'pointer',
                    border: '1px solid var(--border-bright)', background: 'var(--surface)',
                    color: 'var(--text)', fontFamily: 'var(--font-sans)',
                    fontSize: 12, fontWeight: 500, flexShrink: 0,
                  }}
                >
                  <svg width={12} height={12} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M7 1v8M4 6l3 3 3-3"/><path d="M1 11h12"/></svg>
                  Download
                </button>
                {/* Close */}
                <button
                  onClick={handleCloseViewer}
                  style={{
                    width: 32, height: 32, borderRadius: 9, cursor: 'pointer',
                    border: '1px solid var(--border)', background: 'transparent',
                    color: 'var(--text-dim)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}
                >
                  <svg width={12} height={12} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round"><path d="M2 2l8 8M10 2l-8 8"/></svg>
                </button>
              </div>
            </div>

            {/* Content — iframe or loading */}
            <div style={{ flex: 1, position: 'relative', background: 'var(--surface)' }}>
              {!viewerUrl ? (
                <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14 }}>
                  <div style={{ width: 36, height: 36, border: '3px solid var(--surface2)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'rkSpin 0.8s linear infinite' }}/>
                  <div style={{ fontSize: 13, color: 'var(--text-dim)' }}>Loading resume…</div>
                </div>
              ) : (
                <iframe
                  src={viewerUrl}
                  title={viewerResume.name}
                  style={{ width: '100%', height: '100%', border: 'none', display: 'block' }}
                />
              )}
            </div>
          </div>
        </div>
      )}


      {/* Toast */}
      {toast && (
        <div style={{
          position: 'fixed', bottom: 32, left: '50%', transform: 'translateX(-50%)',
          background: toast.type === 'error' ? 'rgba(248,113,113,0.15)' : 'rgba(52,211,153,0.15)',
          border: `1px solid ${toast.type === 'error' ? 'rgba(248,113,113,0.3)' : 'rgba(52,211,153,0.3)'}`,
          color: toast.type === 'error' ? '#f87171' : '#34d399',
          padding: '11px 22px', borderRadius: 30, fontSize: 13.5, fontWeight: 500,
          zIndex: 99999, backdropFilter: 'blur(12px)', animation: 'rkFadeUp 0.3s ease both',
          boxShadow: '0 8px 32px rgba(0,0,0,0.4)', whiteSpace: 'nowrap',
        }}>
          {toast.type === 'error' ? '✗ ' : '✓ '}{toast.msg}
        </div>
      )}
    </div>
  )
}