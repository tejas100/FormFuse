import { useState, useRef, useEffect } from 'react'

const API_BASE = 'http://localhost:8000'

export default function Resumes() {
  const [resumes, setResumes] = useState([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState(null)
  const [toast, setToast] = useState(null)
  const fileInputRef = useRef(null)

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3000)
  }

  // ── Fetch resumes on mount ──────────────────────────────────
  useEffect(() => {
    fetchResumes()
  }, [])

  const fetchResumes = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/resumes`)
      const data = await res.json()
      setResumes(data.resumes || [])
    } catch (err) {
      console.error('Failed to fetch resumes:', err)
      showToast('Failed to load resumes.', 'error')
    } finally {
      setLoading(false)
    }
  }

  // ── Upload ──────────────────────────────────────────────────
  const handleFileChange = async (e) => {
    const file = e.target.files[0]
    if (!file) return

    const allowed = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ]
    if (!allowed.includes(file.type)) {
      showToast('Only PDF or DOCX files are allowed.', 'error')
      return
    }

    setUploading(true)

    try {
      const formData = new FormData()
      formData.append('file', file)

      const res = await fetch(`${API_BASE}/api/resumes/upload`, {
        method: 'POST',
        body: formData,
      })

      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.detail || 'Upload failed')
      }

      const data = await res.json()
      showToast(`"${data.resume.name}" uploaded & processed! (${data.resume.chunk_count} chunks)`)

      // Refresh the list from backend
      await fetchResumes()
    } catch (err) {
      console.error('Upload error:', err)
      showToast(err.message || 'Upload failed.', 'error')
    } finally {
      setUploading(false)
      e.target.value = ''
    }
  }

  // ── Delete ──────────────────────────────────────────────────
  const handleDelete = async (id) => {
    try {
      const res = await fetch(`${API_BASE}/api/resumes/${id}`, {
        method: 'DELETE',
      })

      if (!res.ok) throw new Error('Delete failed')

      setResumes(prev => prev.filter(r => r.id !== id))
      setDeleteConfirm(null)
      showToast('Resume deleted.')
    } catch (err) {
      console.error('Delete error:', err)
      showToast('Failed to delete resume.', 'error')
      setDeleteConfirm(null)
    }
  }

  // ── View ────────────────────────────────────────────────────
  const handleView = (resume) => {
    window.open(`${API_BASE}/api/resumes/${resume.id}/file`, '_blank')
  }

  // ── Time formatting ─────────────────────────────────────────
  const formatTime = (isoString) => {
    if (!isoString) return ''
    // If it's a relative string like "Just now", pass through
    if (!isoString.includes('T')) return isoString

    const date = new Date(isoString)
    const now = new Date()
    const diffMs = now - date
    const diffMins = Math.floor(diffMs / 60000)
    const diffHours = Math.floor(diffMs / 3600000)
    const diffDays = Math.floor(diffMs / 86400000)

    if (diffMins < 1) return 'Just now'
    if (diffMins < 60) return `${diffMins}m ago`
    if (diffHours < 24) return `${diffHours}h ago`
    if (diffDays < 7) return `${diffDays}d ago`
    if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`
    return date.toLocaleDateString()
  }

  const activeCount = resumes.filter(r => r.status === 'active').length

  return (
    <div style={{
      position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'flex-start',
      padding: '20px 48px', paddingTop: '100px', paddingBottom: '40px',
      overflowY: 'auto', animation: 'fadeUp 0.4s ease both'
    }}>

      {/* Toast */}
      {toast && (
        <div style={{
          position: 'fixed', bottom: '32px', left: '50%', transform: 'translateX(-50%)',
          background: toast.type === 'error' ? 'rgba(248,113,113,0.15)' : 'rgba(52,211,153,0.15)',
          border: `1px solid ${toast.type === 'error' ? 'rgba(248,113,113,0.3)' : 'rgba(52,211,153,0.3)'}`,
          color: toast.type === 'error' ? '#f87171' : '#34d399',
          padding: '12px 24px', borderRadius: '30px', fontSize: '14px', fontWeight: 500,
          zIndex: 999, backdropFilter: 'blur(12px)', animation: 'fadeUp 0.3s ease both',
          boxShadow: '0 8px 32px rgba(0,0,0,0.4)'
        }}>
          {toast.type === 'error' ? '✗ ' : '✓ '}{toast.msg}
        </div>
      )}

      {/* Delete confirm modal */}
      {deleteConfirm && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px',
          zIndex: 500, backdropFilter: 'blur(8px)'
        }} onClick={() => setDeleteConfirm(null)}>
          <div style={{
            background: '#161616', border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: '20px', padding: '32px', maxWidth: '360px', width: '100%',
            boxShadow: '0 24px 80px rgba(0,0,0,0.6)', animation: 'fadeUp 0.25s ease both'
          }} onClick={e => e.stopPropagation()}>
            <div style={{ fontSize: '28px', marginBottom: '12px' }}>🗑️</div>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: '18px', fontWeight: 700, marginBottom: '8px' }}>
              Delete resume?
            </div>
            <div style={{ fontSize: '14px', color: 'rgba(255,255,255,0.5)', marginBottom: '24px' }}>
              "{resumes.find(r => r.id === deleteConfirm)?.name}" will be permanently removed.
            </div>
            <div style={{ display: 'flex', gap: '10px' }}>
              <button onClick={() => setDeleteConfirm(null)} style={{
                flex: 1, padding: '12px', background: 'rgba(255,255,255,0.06)',
                border: '1px solid rgba(255,255,255,0.1)', borderRadius: '12px',
                color: 'rgba(255,255,255,0.6)', fontSize: '14px', cursor: 'pointer',
                fontFamily: 'var(--font-body)'
              }}>Cancel</button>
              <button onClick={() => handleDelete(deleteConfirm)} style={{
                flex: 1, padding: '12px', background: 'rgba(248,113,113,0.15)',
                border: '1px solid rgba(248,113,113,0.3)', borderRadius: '12px',
                color: '#f87171', fontSize: '14px', fontWeight: 600, cursor: 'pointer',
                fontFamily: 'var(--font-body)'
              }}>Delete</button>
            </div>
          </div>
        </div>
      )}

      {/* Uploading overlay */}
      {uploading && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 600, backdropFilter: 'blur(4px)'
        }}>
          <div style={{
            background: '#161616', border: '1px solid rgba(232,255,107,0.2)',
            borderRadius: '20px', padding: '40px', textAlign: 'center',
            boxShadow: '0 24px 80px rgba(0,0,0,0.6)', animation: 'fadeUp 0.25s ease both'
          }}>
            <div style={{
              width: '40px', height: '40px', border: '3px solid rgba(232,255,107,0.2)',
              borderTopColor: '#e8ff6b', borderRadius: '50%',
              animation: 'spin 0.8s linear infinite',
              margin: '0 auto 16px'
            }} />
            <div style={{ fontFamily: 'var(--font-display)', fontSize: '16px', fontWeight: 700, color: '#e8ff6b' }}>
              Processing resume…
            </div>
            <div style={{ fontSize: '13px', color: 'rgba(255,255,255,0.4)', marginTop: '6px' }}>
              Extracting text, parsing sections, chunking
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <div style={{ width: '100%', maxWidth: '960px', marginBottom: '28px' }}>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: '32px', fontWeight: 800, letterSpacing: '-1px', marginBottom: '4px' }}>
          Your Resumes
        </div>
        <div style={{ fontSize: '14px', color: 'rgba(255,255,255,0.4)' }}>
          {loading ? 'Loading…' : `${resumes.length} version${resumes.length !== 1 ? 's' : ''} · ${activeCount} active`}
        </div>
      </div>

      {/* Grid */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
        gap: '14px',
        width: '100%',
        maxWidth: '960px'
      }}>
        {resumes.map((r, i) => (
          <div key={r.id} style={{
            background: 'var(--surface)',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: '16px', padding: '22px',
            transition: 'all 0.2s ease',
            animation: `fadeUp 0.4s ease ${i * 0.06}s both`,
            boxShadow: '0 4px 20px rgba(0,0,0,0.2)',
            position: 'relative', overflow: 'hidden',
          }}>
            {/* Top row: icon + badge + actions */}
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '14px' }}>
              <span style={{ fontSize: '26px' }}>📄</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span style={{
                  fontSize: '10px', fontWeight: 600, padding: '3px 8px',
                  borderRadius: '10px', textTransform: 'uppercase', letterSpacing: '0.08em',
                  background: r.status === 'active' ? 'rgba(52,211,153,0.15)' : 'rgba(255,255,255,0.06)',
                  color: r.status === 'active' ? '#34d399' : 'rgba(255,255,255,0.4)'
                }}>{r.status}</span>

                {/* View button */}
                <button
                  onClick={() => handleView(r)}
                  title="View resume"
                  style={{
                    width: '28px', height: '28px', borderRadius: '8px',
                    background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)',
                    color: 'rgba(255,255,255,0.5)', cursor: 'pointer',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: '13px', transition: 'all 0.2s'
                  }}
                >👁</button>

                {/* Delete button */}
                <button
                  onClick={() => setDeleteConfirm(r.id)}
                  title="Delete resume"
                  style={{
                    width: '28px', height: '28px', borderRadius: '8px',
                    background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.15)',
                    color: '#f87171', cursor: 'pointer',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: '13px', transition: 'all 0.2s'
                  }}
                >✕</button>
              </div>
            </div>

            <div style={{ fontFamily: 'var(--font-display)', fontSize: '15px', fontWeight: 700, color: 'var(--text)', marginBottom: '4px' }}>
              {r.name}
            </div>
            <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.35)', marginBottom: '12px' }}>
              {formatTime(r.uploaded_at)}
              {r.file_ext && <span style={{ marginLeft: '6px', color: 'rgba(232,255,107,0.6)' }}>· {r.file_ext.replace('.', '').toUpperCase()}</span>}
              {r.chunk_count > 0 && <span style={{ marginLeft: '6px', color: 'rgba(255,255,255,0.25)' }}>· {r.chunk_count} chunks</span>}
            </div>

            {r.skills && r.skills.length > 0 && (
              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                {r.skills.map(s => (
                  <span key={s} style={{
                    fontSize: '11px', fontWeight: 500, padding: '3px 10px',
                    borderRadius: '20px', background: 'rgba(255,255,255,0.06)',
                    color: 'rgba(255,255,255,0.4)', border: '1px solid rgba(255,255,255,0.08)'
                  }}>{s}</span>
                ))}
              </div>
            )}
          </div>
        ))}

        {/* Add Resume Card */}
        <button
          onClick={() => fileInputRef.current.click()}
          disabled={uploading}
          style={{
            background: 'transparent',
            border: '1px dashed rgba(232,255,107,0.25)',
            borderRadius: '16px', padding: '22px', cursor: uploading ? 'not-allowed' : 'pointer',
            display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center',
            gap: '10px', minHeight: '160px',
            color: 'rgba(255,255,255,0.35)',
            fontFamily: 'var(--font-body)', fontSize: '13px',
            transition: 'all 0.25s ease',
            opacity: uploading ? 0.4 : 1,
          }}
          onMouseEnter={e => {
            if (uploading) return
            e.currentTarget.style.borderColor = 'rgba(232,255,107,0.5)'
            e.currentTarget.style.background = 'rgba(232,255,107,0.03)'
            e.currentTarget.style.color = 'rgba(232,255,107,0.7)'
          }}
          onMouseLeave={e => {
            e.currentTarget.style.borderColor = 'rgba(232,255,107,0.25)'
            e.currentTarget.style.background = 'transparent'
            e.currentTarget.style.color = 'rgba(255,255,255,0.35)'
          }}
        >
          <span style={{ fontSize: '28px', opacity: 0.5 }}>+</span>
          <span>Upload resume</span>
          <span style={{ fontSize: '11px', opacity: 0.5 }}>PDF or DOCX</span>
        </button>
      </div>

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".pdf,.doc,.docx"
        style={{ display: 'none' }}
        onChange={handleFileChange}
      />

      {/* Spinner keyframe (injected once) */}
      <style>{`
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  )
}