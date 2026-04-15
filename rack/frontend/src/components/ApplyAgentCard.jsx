/**
 * ApplyAgentCard.jsx — Live SSE feed for auto-apply agent
 *
 * Mirrors the visual language of TailorStepsCard but is built for
 * a dynamic, unbounded step list (we don't know how many fields
 * there are until the agent analyses the form).
 *
 * Props:
 *   steps   — array of { type, status, text } events from SSE stream
 *   loading — bool — true while stream is open
 *   error   — string | null — terminal error message
 *   done    — object | null — the final "done" event payload
 *   jobTitle — string — shown in header
 *   company  — string — shown in header
 */

export default function ApplyAgentCard({ steps, loading, error, done, submitted, jobTitle, company }) {

  const statusIcon = (status) => {
    if (status === 'ok')      return <span style={{ fontSize: '12px', color: 'var(--accent3)' }}>✓</span>
    if (status === 'error')   return <span style={{ fontSize: '12px', color: 'var(--danger)'  }}>✗</span>
    if (status === 'skip')    return <span style={{ fontSize: '12px', color: 'var(--text-dim)' }}>–</span>
    if (status === 'writing') return (
      <div style={{
        width: '8px', height: '8px', borderRadius: '50%',
        border: '2px solid var(--accent)',
        borderTopColor: 'transparent',
        animation: 'spin 0.7s linear infinite',
        flexShrink: 0,
      }} />
    )
    // active / unknown
    return (
      <div style={{
        width: '8px', height: '8px', borderRadius: '50%',
        border: '2px solid var(--accent)',
        borderTopColor: 'transparent',
        animation: 'spin 0.7s linear infinite',
        flexShrink: 0,
      }} />
    )
  }

  const stepColor = (status) => {
    if (status === 'ok')      return 'var(--accent3)'
    if (status === 'error')   return 'var(--danger)'
    if (status === 'skip')    return 'var(--text-dim)'
    if (status === 'writing') return 'var(--text)'
    return 'var(--text)'
  }

  // Separate structural steps from field-fill steps
  const structuralStatuses = new Set(['ok'])
  const allSteps = steps || []

  return (
    <div style={{
      padding: '18px 20px',
      borderRadius: '14px',
      background: 'var(--surface)',
      border: '1px solid rgba(232,255,107,0.18)',
      display: 'flex',
      flexDirection: 'column',
      gap: '0',
    }}>

      {/* ── Header ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '14px' }}>
        {loading && (
          <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
            {[0,1,2].map(i => (
              <div key={i} style={{
                width: '5px', height: '5px', borderRadius: '50%',
                background: 'var(--accent)', opacity: 0.7,
                animation: `pulse 1.2s ease-in-out ${i * 0.2}s infinite`,
              }} />
            ))}
          </div>
        )}
        {(submitted || done) && !loading && (
          <span style={{ fontSize: '14px', color: 'var(--accent3)' }}>✓</span>
        )}
        {error && !loading && (
          <span style={{ fontSize: '14px', color: 'var(--danger)' }}>✗</span>
        )}
        <div>
          <span style={{ fontSize: '13px', color: 'var(--text)', fontWeight: 500 }}>
            {submitted ? 'Submitted' : done ? 'Application filled' : loading ? 'Auto-applying…' : 'Apply agent'}
          </span>
          {(jobTitle || company) && (
            <span style={{ fontSize: '12px', color: 'var(--text-dim)', fontWeight: 300, marginLeft: '6px' }}>
              {jobTitle}{company ? ` · ${company}` : ''}
            </span>
          )}
        </div>
      </div>

      {/* ── Step list ── */}
      {allSteps.length > 0 && (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '1px',
          maxHeight: '320px',
          overflowY: 'auto',
          marginBottom: done || error ? '14px' : '0',
        }}>
          {allSteps.map((step, i) => (
            <div key={i} style={{
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              padding: '5px 0',
              borderBottom: i < allSteps.length - 1 ? '1px solid var(--border)' : 'none',
            }}>
              {/* Icon */}
              <div style={{ width: '16px', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {statusIcon(step.status)}
              </div>

              {/* Text */}
              <span style={{
                fontSize: '13px',
                fontWeight: step.status === 'writing' ? 500 : 300,
                color: stepColor(step.status),
                transition: 'color 0.3s ease',
                lineHeight: 1.4,
              }}>
                {step.text}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* ── Submitted state ── */}
      {submitted && !loading && (
        <div style={{
          padding: '12px 14px',
          borderRadius: '10px',
          background: 'rgba(52,211,153,0.06)',
          border: '1px solid rgba(52,211,153,0.18)',
          display: 'flex',
          flexDirection: 'column',
          gap: '6px',
        }}>
          <div style={{ fontSize: '13px', color: 'var(--accent3)', fontWeight: 500 }}>
            ✓ Applied to {company || 'this company'}
          </div>
          {submitted.confirmation && (
            <div style={{ fontSize: '11px', color: 'var(--text-dim)', fontWeight: 300 }}>
              Confirmation: {submitted.confirmation}
            </div>
          )}
          <div style={{ fontSize: '11px', color: 'var(--text-dim)', fontWeight: 300 }}>
            Marked as applied in your Tracking tab.
          </div>
        </div>
      )}

      {/* ── Done state (filled but submit not confirmed) ── */}
      {done && !submitted && !loading && (
        <div style={{
          padding: '12px 14px',
          borderRadius: '10px',
          background: 'rgba(52,211,153,0.06)',
          border: '1px solid rgba(52,211,153,0.18)',
          display: 'flex',
          flexDirection: 'column',
          gap: '8px',
        }}>
          <div style={{ fontSize: '13px', color: 'var(--accent3)', fontWeight: 500 }}>
            ✓ {done.filled_count} field{done.filled_count !== 1 ? 's' : ''} filled — form is ready
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text-dim)', fontWeight: 300 }}>
            Review the application in the Tracking tab before submitting.
          </div>
          {done.job_url && (
            <a
              href={done.job_url}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '5px',
                fontSize: '12px',
                fontWeight: 600,
                color: 'var(--accent)',
                textDecoration: 'none',
                padding: '5px 12px',
                borderRadius: '20px',
                background: 'rgba(232,255,107,0.08)',
                border: '1px solid rgba(232,255,107,0.2)',
                alignSelf: 'flex-start',
                marginTop: '2px',
              }}
            >
              Open application ↗
            </a>
          )}
        </div>
      )}

      {/* ── Error state ── */}
      {error && !loading && (
        <div style={{
          padding: '12px 14px',
          borderRadius: '10px',
          background: 'rgba(248,113,113,0.06)',
          border: '1px solid rgba(248,113,113,0.18)',
          fontSize: '13px',
          color: 'var(--danger)',
          fontWeight: 300,
        }}>
          {error}
        </div>
      )}
    </div>
  )
}