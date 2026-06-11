/**
 * BatchApplyCard.jsx — Batch auto-apply progress card for the chat thread
 *
 * Rendered when the router returns start_batch_apply and a batch is created.
 * Shows each job in the batch walking the Phase 1 state machine:
 *   queued → filling → awaiting_review (or failed / job_removed)
 * and, after the user approves in the Review tab, Phase 2 states:
 *   approved → replaying → submitted (or needs_attention)
 *
 * Home.jsx owns the polling (GET /api/apply/batch/{id}) and feeds fresh
 * job rows down as props. This component is purely presentational except
 * for the Retry and Review buttons, which call back up.
 *
 * Props:
 *   jobs        — [{ id, job_title, company, status, error }] from batch status endpoint
 *   batchStatus — "pending" | "processing" | "awaiting_review" | "failed"
 *   jobCount    — total jobs in the batch
 *   onOpenReview — () => void — navigate to Tracking → Review tab
 *   onRetry      — (applyJobId) => void — re-queue a failed job
 */

const STATUS_META = {
  queued:          { label: 'Queued',                 color: 'var(--text-dim)', icon: 'dot'     },
  filling:         { label: 'Filling…',               color: 'var(--accent)',   icon: 'spinner' },
  awaiting_review: { label: 'Ready for review',       color: 'var(--accent)',   icon: '◎'       },
  approved:        { label: 'Submitting…',            color: 'var(--accent3)',  icon: 'spinner' },
  replaying:       { label: 'Submitting…',            color: 'var(--accent3)',  icon: 'spinner' },
  submitted:       { label: 'Submitted',              color: 'var(--accent3)',  icon: '✓'       },
  skipped:         { label: 'Skipped',                color: 'var(--text-dim)', icon: '–'       },
  failed:          { label: 'Failed',                 color: 'var(--danger)',   icon: '✗'       },
  job_removed:     { label: 'Job no longer available', color: '#fb923c',        icon: '⚠'       },
  needs_attention: { label: 'Needs attention',        color: '#fb923c',         icon: '⚠'       },
}

const IN_FLIGHT = new Set(['queued', 'filling'])

function StatusIcon({ status }) {
  const meta = STATUS_META[status] || STATUS_META.queued
  if (meta.icon === 'spinner') {
    return (
      <div style={{
        width: '9px', height: '9px', borderRadius: '50%',
        border: `2px solid ${meta.color}`,
        borderTopColor: 'transparent',
        animation: 'spin 0.7s linear infinite',
        flexShrink: 0,
      }} />
    )
  }
  if (meta.icon === 'dot') {
    return <div style={{ width: '6px', height: '6px', borderRadius: '50%', background: meta.color, opacity: 0.5, flexShrink: 0 }} />
  }
  return <span style={{ fontSize: '12px', color: meta.color, flexShrink: 0 }}>{meta.icon}</span>
}

export default function BatchApplyCard({ jobs, batchStatus, jobCount, onOpenReview, onRetry }) {
  const jobList   = jobs || []
  const total     = jobCount || jobList.length
  const readyN    = jobList.filter(j => j.status === 'awaiting_review').length
  const failedN   = jobList.filter(j => j.status === 'failed' || j.status === 'job_removed').length
  const doneAll   = batchStatus === 'awaiting_review' || batchStatus === 'failed'
  const running   = !doneAll
  const processed = jobList.filter(j => !IN_FLIGHT.has(j.status)).length

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
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '4px' }}>
        {running && (
          <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
            {[0, 1, 2].map(i => (
              <div key={i} style={{
                width: '5px', height: '5px', borderRadius: '50%',
                background: 'var(--accent)', opacity: 0.7,
                animation: `pulse 1.2s ease-in-out ${i * 0.2}s infinite`,
              }} />
            ))}
          </div>
        )}
        {doneAll && readyN > 0 && <span style={{ fontSize: '14px', color: 'var(--accent)' }}>◎</span>}
        {doneAll && readyN === 0 && <span style={{ fontSize: '14px', color: 'var(--danger)' }}>✗</span>}
        <span style={{ fontSize: '13px', color: 'var(--text)', fontWeight: 500 }}>
          {running
            ? 'Filling applications in the background'
            : readyN > 0
              ? `${readyN} application${readyN !== 1 ? 's' : ''} ready for your review`
              : 'Couldn\u2019t fill these applications'}
        </span>
      </div>

      {/* ── Subline ── */}
      <div style={{ fontSize: '12px', color: 'var(--text-dim)', fontWeight: 300, lineHeight: 1.5, marginBottom: '14px' }}>
        {running
          ? `${processed} of ${total} processed · you can close this tab — Rack keeps working and emails you when everything\u2019s ready.`
          : readyN > 0
            ? 'Nothing is submitted until you approve it. Jobs can close without warning, so reviewing today is safer than tomorrow.'
            : 'None of the selected jobs could be filled automatically. You can retry below or apply manually from Tracking.'}
      </div>

      {/* ── Job rows ── */}
      {jobList.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1px' }}>
          {jobList.map((j, i) => {
            const meta = STATUS_META[j.status] || STATUS_META.queued
            return (
              <div key={j.id || i} style={{
                display: 'flex', alignItems: 'center', gap: '10px',
                padding: '7px 0',
                borderBottom: i < jobList.length - 1 ? '1px solid var(--border)' : 'none',
              }}>
                <div style={{ width: '16px', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <StatusIcon status={j.status} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '13px', color: 'var(--text)', fontWeight: 400, lineHeight: 1.4, wordBreak: 'break-word' }}>
                    {j.job_title || 'Unknown role'}
                    {j.company && <span style={{ color: 'var(--text-dim)', fontWeight: 300 }}> · {j.company}</span>}
                  </div>
                  {(j.status === 'failed' || j.status === 'needs_attention') && j.error && (
                    <div style={{ fontSize: '11px', color: 'var(--text-dim)', fontWeight: 300, marginTop: '2px' }}>
                      {j.error}
                    </div>
                  )}
                </div>
                <span style={{ fontSize: '11px', fontWeight: 500, color: meta.color, flexShrink: 0 }}>
                  {meta.label}
                </span>
                {j.status === 'failed' && onRetry && (
                  <button
                    onClick={() => onRetry(j.id)}
                    style={{
                      padding: '3px 10px', borderRadius: '20px', flexShrink: 0,
                      border: '1px solid var(--border)', background: 'transparent',
                      color: 'var(--text-dim)', fontSize: '11px', fontWeight: 500,
                      cursor: 'pointer', fontFamily: 'inherit',
                    }}
                  >
                    Retry
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* ── Review CTA — once the batch lands ── */}
      {doneAll && readyN > 0 && (
        <button
          onClick={() => onOpenReview && onOpenReview()}
          style={{
            alignSelf: 'flex-start',
            marginTop: '14px',
            padding: '9px 18px',
            background: 'rgba(232,255,107,0.12)',
            border: '1px solid rgba(232,255,107,0.4)',
            borderRadius: '10px',
            cursor: 'pointer',
            fontSize: '12px', fontWeight: 600,
            color: 'var(--accent)',
            fontFamily: 'var(--font-display)',
            display: 'flex', alignItems: 'center', gap: '8px',
            transition: 'all 0.15s ease',
          }}
          onMouseEnter={e => { e.currentTarget.style.background = 'rgba(232,255,107,0.18)'; e.currentTarget.style.borderColor = 'rgba(232,255,107,0.55)' }}
          onMouseLeave={e => { e.currentTarget.style.background = 'rgba(232,255,107,0.12)'; e.currentTarget.style.borderColor = 'rgba(232,255,107,0.4)' }}
        >
          <span>Review &amp; approve</span>
          <span style={{ fontSize: '14px' }}>◎</span>
        </button>
      )}

      {failedN > 0 && doneAll && readyN > 0 && (
        <div style={{ fontSize: '11px', color: 'var(--text-dim)', fontWeight: 300, marginTop: '10px' }}>
          {failedN} application{failedN !== 1 ? 's' : ''} couldn&apos;t be filled automatically — you can retry or apply manually.
        </div>
      )}
    </div>
  )
}