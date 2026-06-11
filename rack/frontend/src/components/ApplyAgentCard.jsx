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
 *   otpRequired — { email_hint, invalid, text, submitting } | null —
 *                 agent is paused at the email security-code gate
 *   onSubmitOtp — async (code) => { ok, error } — delivers the code
 */

import { useState } from 'react'

export default function ApplyAgentCard({ steps, loading, error, done, submitted, jobRemoved, sessionEnded, jobTitle, company, reviewRequired, onConfirmSubmit, otpRequired, onSubmitOtp, sessionId }) {

  const [otpCode, setOtpCode]             = useState('')
  const [otpSending, setOtpSending]       = useState(false)
  const [otpLocalError, setOtpLocalError] = useState(null)

  const otpCleaned = otpCode.replace(/[\s-]/g, '').trim()
  const otpReady   = otpCleaned.length >= 4 && !otpSending && !otpRequired?.submitting

  const handleOtpSend = async () => {
    if (!otpReady || !onSubmitOtp) return
    setOtpSending(true)
    setOtpLocalError(null)
    const result = await onSubmitOtp(otpCleaned)
    if (result && !result.ok) {
      setOtpLocalError(result.error || 'Could not send the code — try again.')
    } else {
      setOtpCode('')
    }
    setOtpSending(false)
  }

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

  // Filter out "writing" steps that have already been resolved by a
  // subsequent "ok" step for the same label. Without this, both the
  // spinner and the checkmark render simultaneously.
  const rawSteps = steps || []
  const allSteps = rawSteps.filter((step, i) => {
    if (step.status !== 'writing') return true
    // Extract the label from the writing step text:
    // "Writing answer for: Some Label..." → "Some Label"
    const writingLabel = step.text.replace(/^Writing answer for:\s*/i, '').replace(/\.\.\.$/, '').trim()
    // Check if any later step has status "ok" and text that contains this label
    return !rawSteps.slice(i + 1).some(later =>
      later.status === 'ok' &&
      later.text.toLowerCase().includes(writingLabel.toLowerCase().slice(0, 30))
    )
  })

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
        {loading && !otpRequired && (
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
        {otpRequired && !submitted && (
          <span style={{ fontSize: '14px', color: 'var(--accent)', animation: 'pulse 1.6s ease-in-out infinite' }}>✉</span>
        )}
        {(submitted || done) && !loading && (
          <span style={{ fontSize: '14px', color: 'var(--accent3)' }}>✓</span>
        )}
        {reviewRequired && !loading && (
          <span style={{ fontSize: '14px', color: 'var(--accent)' }}>◎</span>
        )}
        {(error || jobRemoved) && !loading && (
          <span style={{ fontSize: '14px', color: 'var(--danger)' }}>✗</span>
        )}
        {sessionEnded && !loading && (
          <span style={{ fontSize: '14px', color: 'rgba(251,146,60,0.9)' }}>⏱</span>
        )}
        <div>
          <span style={{ fontSize: '13px', color: 'var(--text)', fontWeight: 500 }}>
            {submitted ? 'Submitted' : done ? 'Application filled' : jobRemoved ? 'Job no longer available' : sessionEnded ? 'Session ended' : otpRequired ? 'Security code needed' : reviewRequired ? 'Review before submitting' : loading ? 'Auto-applying…' : 'Apply agent'}
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
          marginBottom: (done || error || reviewRequired || otpRequired) ? '14px' : '0',
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

      {/* ── Review required state ── */}
      {reviewRequired && !loading && !submitted && (
        <div style={{
          padding: '14px 16px',
          borderRadius: '10px',
          background: 'rgba(232,255,107,0.05)',
          border: '1px solid rgba(232,255,107,0.25)',
          display: 'flex',
          flexDirection: 'column',
          gap: '10px',
        }}>
          <div style={{ fontSize: '13px', color: 'var(--text)', fontWeight: 500, lineHeight: 1.5 }}>
            {reviewRequired.filled_count} field{reviewRequired.filled_count !== 1 ? 's' : ''} filled.
            {reviewRequired.validation_errors > 0 && (
              <span style={{ color: '#fb923c', marginLeft: '6px' }}>
                ⚠ {reviewRequired.validation_errors} validation warning{reviewRequired.validation_errors !== 1 ? 's' : ''} detected — check the form.
              </span>
            )}
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text-dim)', fontWeight: 300, lineHeight: 1.5 }}>
            Review the filled form in the panel on the right, then confirm to submit.
          </div>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <button
              onClick={() => onConfirmSubmit && onConfirmSubmit('submit')}
              style={{
                padding: '7px 16px',
                borderRadius: '20px',
                border: '1px solid rgba(232,255,107,0.4)',
                background: 'rgba(232,255,107,0.12)',
                color: 'var(--accent)',
                fontSize: '12px',
                fontWeight: 600,
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              Confirm &amp; Submit ↗
            </button>
            <button
              onClick={() => onConfirmSubmit && onConfirmSubmit('cancel')}
              style={{
                padding: '7px 14px',
                borderRadius: '20px',
                border: '1px solid var(--border)',
                background: 'transparent',
                color: 'var(--text-dim)',
                fontSize: '12px',
                fontWeight: 400,
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* ── Security code (OTP) state ── */}
      {otpRequired && !submitted && !error && (
        <div style={{
          padding: '14px 16px',
          borderRadius: '10px',
          background: 'rgba(232,255,107,0.05)',
          border: '1px solid rgba(232,255,107,0.25)',
          display: 'flex',
          flexDirection: 'column',
          gap: '10px',
        }}>
          <div style={{ fontSize: '13px', color: 'var(--text)', fontWeight: 500, display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '15px' }}>✉</span> Check your email
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text-dim)', fontWeight: 300, lineHeight: 1.6 }}>
            {company || 'The company'} sent a security code to{' '}
            <strong style={{ color: 'var(--text)', fontWeight: 500 }}>
              {otpRequired.email_hint || 'your inbox'}
            </strong>
            . Enter it below — Rack is holding the application open and will submit
            the moment you do.
          </div>
          {otpRequired.invalid && (
            <div style={{ fontSize: '12px', color: '#fb923c', lineHeight: 1.5 }}>
              ⚠ {otpRequired.text || "That code didn't work — it may have expired. Use the newest email."}
            </div>
          )}
          {otpLocalError && (
            <div style={{ fontSize: '12px', color: 'var(--danger)', lineHeight: 1.5 }}>
              ⚠ {otpLocalError}
            </div>
          )}
          {otpRequired.submitting ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: 'var(--accent3)', fontWeight: 500 }}>
              <div style={{
                width: '9px', height: '9px', borderRadius: '50%',
                border: '2px solid var(--accent3)', borderTopColor: 'transparent',
                animation: 'spin 0.7s linear infinite',
              }} />
              Code received — submitting your application…
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                <input
                  value={otpCode}
                  onChange={e => setOtpCode(e.target.value.toUpperCase())}
                  onKeyDown={e => { if (e.key === 'Enter') handleOtpSend() }}
                  placeholder="• • • • • • • •"
                  maxLength={12}
                  autoFocus
                  autoComplete="one-time-code"
                  spellCheck={false}
                  style={{
                    flex: '0 1 200px', minWidth: 150, boxSizing: 'border-box',
                    background: 'var(--surface2)', border: '1px solid rgba(232,255,107,0.35)',
                    borderRadius: '10px', padding: '9px 12px', color: 'var(--text)',
                    fontSize: '15px', fontFamily: 'var(--font-mono, monospace)',
                    letterSpacing: '0.3em', textAlign: 'center', outline: 'none',
                  }}
                />
                <button
                  onClick={handleOtpSend}
                  disabled={!otpReady}
                  style={{
                    padding: '9px 18px',
                    borderRadius: '20px',
                    border: '1px solid rgba(232,255,107,0.4)',
                    background: 'rgba(232,255,107,0.12)',
                    color: 'var(--accent)',
                    fontSize: '12px',
                    fontWeight: 600,
                    cursor: otpReady ? 'pointer' : 'default',
                    opacity: otpReady ? 1 : 0.5,
                    fontFamily: 'inherit',
                  }}
                >
                  {otpSending ? 'Sending…' : 'Submit code →'}
                </button>
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text-dim)', fontWeight: 300 }}>
                Codes expire quickly — if you got more than one email, use the newest.
              </div>
            </>
          )}
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

      {/* ── Session ended state ── */}
      {sessionEnded && !loading && (
        <div style={{
          padding: '14px 16px',
          borderRadius: '10px',
          background: 'rgba(251,146,60,0.06)',
          border: '1px solid rgba(251,146,60,0.2)',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}>
          <div style={{ fontSize: '13px', color: 'rgba(251,146,60,0.9)', fontWeight: 500 }}>
            ⏱ Review session expired
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text-dim)', fontWeight: 300, lineHeight: 1.6 }}>
            The 2-minute review window closed before submission. The form was filled but not submitted.
            You can start a new session anytime.
          </div>
        </div>
      )}

      {/* ── Job removed state ── */}
      {jobRemoved && !loading && (
        <div style={{
          padding: '12px 14px',
          borderRadius: '10px',
          background: 'rgba(251,146,60,0.06)',
          border: '1px solid rgba(251,146,60,0.2)',
          display: 'flex',
          flexDirection: 'column',
          gap: '6px',
        }}>
          <div style={{ fontSize: '13px', color: '#fb923c', fontWeight: 500 }}>
            ⚠ This job posting is no longer available
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text-dim)', fontWeight: 300, lineHeight: 1.5 }}>
            {typeof jobRemoved === 'string' ? jobRemoved : 'The posting may have been filled or removed. It has been cleared from your matches.'}
          </div>
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