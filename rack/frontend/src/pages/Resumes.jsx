import { useState, useRef } from 'react'

const INITIAL_RESUMES = [
  { id: 1, name: 'Software Engineer v3',  updated: '2 days ago',  status: 'active', skills: ['React','Node','Python'],  file: null },
  { id: 2, name: 'Full Stack — Startup',  updated: '1 week ago',  status: 'active', skills: ['Vue','FastAPI','AWS'],    file: null },
  { id: 3, name: 'Backend Specialist',    updated: '2 weeks ago', status: 'draft',  skills: ['Go','PostgreSQL','Docker'],file: null },
  { id: 4, name: 'ML Engineer Focus',     updated: '1 month ago', status: 'draft',  skills: ['Python','PyTorch','MLflow'],file: null },
]

export default function Resumes() {
  const [resumes, setResumes] = useState(INITIAL_RESUMES)
  const [deleteConfirm, setDeleteConfirm] = useState(null) // id to confirm delete
  const [toast, setToast] = useState(null)
  const fileInputRef = useRef(null)

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3000)
  }

  // ── Upload ──────────────────────────────────────────────────────
  const handleFileChange = (e) => {
    const file = e.target.files[0]
    if (!file) return

    const allowed = ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']
    if (!allowed.includes(file.type)) {
      showToast('Only PDF or DOCX files are allowed.', 'error')
      return
    }

    const name = file.name.replace(/\.[^/.]+$/, '') // strip extension
    const newResume = {
      id: Date.now(),
      name,
      updated: 'Just now',
      status: 'draft',
      skills: [],
      file,
      fileURL: URL.createObjectURL(file),
      fileType: file.type,
    }

    setResumes(prev => [...prev, newResume])
    showToast(`"${name}" uploaded successfully!`)
    e.target.value = '' // reset input
  }

  // ── Delete ──────────────────────────────────────────────────────
  const handleDelete = (id) => {
    setResumes(prev => prev.filter(r => r.id !== id))
    setDeleteConfirm(null)
    showToast('Resume deleted.')
  }

  // ── View ────────────────────────────────────────────────────────
  const handleView = (resume) => {
    if (resume.fileURL) {
      window.open(resume.fileURL, '_blank')
    } else {
      showToast('No file attached to this resume.', 'error')
    }
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

      {/* Header */}
      <div style={{ width: '100%', maxWidth: '960px', marginBottom: '28px' }}>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: '32px', fontWeight: 800, letterSpacing: '-1px', marginBottom: '4px' }}>
          Your Resumes
        </div>
        <div style={{ fontSize: '14px', color: 'rgba(255,255,255,0.4)' }}>
          {resumes.length} versions · {activeCount} active
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
                    color: 'rgba(255,255,255,0.5)', cursor: r.fileURL ? 'pointer' : 'not-allowed',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: '13px', transition: 'all 0.2s', opacity: r.fileURL ? 1 : 0.4
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
              Updated {r.updated}
              {r.file && <span style={{ marginLeft: '6px', color: 'rgba(232,255,107,0.6)' }}>· {r.file.name.split('.').pop().toUpperCase()}</span>}
            </div>

            {r.skills.length > 0 && (
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
          style={{
            background: 'transparent',
            border: '1px dashed rgba(232,255,107,0.25)',
            borderRadius: '16px', padding: '22px', cursor: 'pointer',
            display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center',
            gap: '10px', minHeight: '160px',
            color: 'rgba(255,255,255,0.35)',
            fontFamily: 'var(--font-body)', fontSize: '13px',
            transition: 'all 0.25s ease',
          }}
          onMouseEnter={e => {
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
    </div>
  )
}