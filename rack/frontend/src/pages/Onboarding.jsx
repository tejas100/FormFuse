/**
 * pages/Onboarding.jsx — RACK new-user onboarding wizard
 *
 * Replaces the voice/chat onboarding for new users.
 *
 * Architecture:
 *  - Step 0: Upload resume(s)       — pre-step, no progress bar yet
 *  - Step 1: Location               — where do you live?
 *  - Step 2: Contact                — phone + LinkedIn
 *  - Step 3: Work status            — auth + sponsorship
 *  - Step 4: Checklist + EEO        — preferences + diversity
 *  - Step 5: App password           — for Workday/iCIMS/Oracle
 *  - Step 6: Apply settings         — resume optimization mode
 *
 * Left panel: live "ingestion terminal" showing resume parse events.
 * Right panel: form steps.
 *
 * Data model: all fields go to PUT /api/account/profile (preferences JSONB).
 * On finish: sets preferences.onboarding_complete = true → App.jsx switches to Home.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { API_BASE, getAuthHeaders } from '../utils/api'

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const TOTAL_STEPS = 6   // steps 1–6 after the upload pre-step

const WORK_STATUS_OPTIONS = [
  'US Citizen', 'Permanent Resident', 'H-1B',
  'F-1 (Student)', 'OPT', 'CPT',
  'J-1', 'L-1', 'O-1',
  'TN', 'E-3', 'Other',
]

const GENDER_OPTIONS = [
  { value: 'male',          label: 'Male' },
  { value: 'female',        label: 'Female' },
  { value: 'non_binary',    label: 'Non-binary' },
  { value: 'decline',       label: 'Prefer not to say' },
]

const ETHNICITY_OPTIONS = [
  { value: 'asian',          label: 'Asian' },
  { value: 'black',          label: 'Black or African American' },
  { value: 'hispanic',       label: 'Hispanic or Latino' },
  { value: 'white',          label: 'White' },
  { value: 'two_or_more',    label: 'Two or more races' },
  { value: 'native',         label: 'Native American or Alaska Native' },
  { value: 'pacific',        label: 'Native Hawaiian or Pacific Islander' },
  { value: 'decline',        label: 'Prefer not to say' },
]

const VETERAN_OPTIONS = [
  { value: 'protected_veteran', label: 'Protected Veteran' },
  { value: 'not_a_veteran',     label: 'Not a Veteran' },
  { value: 'decline',           label: 'Prefer not to say' },
]

const DISABILITY_OPTIONS = [
  { value: 'yes',     label: 'Yes' },
  { value: 'no',      label: 'No' },
  { value: 'decline', label: 'Prefer not to say' },
]

const OPTIMIZE_OPTIONS = [
  { value: 'off',        label: 'Off',        desc: 'Send your resume exactly as uploaded.' },
  { value: 'honest',     label: 'Honest',     desc: 'Reorder and emphasize experience that\'s relevant to each job.' },
  { value: 'aggressive', label: 'Aggressive', desc: 'Rewrite content to match the job description closely.' },
]

// Terminal log lines shown while resume processes
const TERMINAL_PHASES = [
  { delay: 0,     text: 'upload',     label: 'uploading to secure storage',          done: false },
  { delay: 900,   text: 'extract',    label: 'extracting text from PDF',             done: false },
  { delay: 2400,  text: 'parse',      label: 'parsing experience · skills · dates',  done: false },
  { delay: 4200,  text: 'chunk',      label: 'chunking into semantic units',         done: false },
  { delay: 6500,  text: 'embed',      label: 'embedding via text-embedding-3-small', done: false },
  { delay: 9500,  text: 'index',      label: 'writing to pgvector index',            done: false },
  { delay: 12000, text: 'match',      label: 'pre-matching against 14k+ job pool',   done: false },
  { delay: 16000, text: 'done',       label: 'ready · matches queued',               done: true  },
]

// ─────────────────────────────────────────────────────────────────────────────
// Tiny helpers
// ─────────────────────────────────────────────────────────────────────────────

function YesNo({ value, onChange, options = ['Yes', 'No'] }) {
  return (
    <div style={{ display: 'flex', gap: 8 }}>
      {options.map(opt => {
        const val = opt.toLowerCase()
        const active = value === val
        return (
          <button
            key={opt}
            onClick={() => onChange(active ? null : val)}
            style={{
              padding: '8px 20px',
              borderRadius: 8,
              border: `1px solid ${active ? 'var(--accent-line)' : 'var(--border-bright)'}`,
              background: active ? 'var(--accent-soft)' : 'var(--surface2)',
              color: active ? 'var(--accent-ink)' : 'var(--text-mid)',
              fontSize: 13, fontWeight: active ? 600 : 400,
              cursor: 'pointer', transition: 'all 0.15s',
              fontFamily: 'var(--font-body)',
            }}
          >{opt}</button>
        )
      })}
    </div>
  )
}

function FieldLabel({ children, optional }) {
  return (
    <div style={{
      fontSize: 11, fontWeight: 600, letterSpacing: '0.1em',
      textTransform: 'uppercase', color: 'var(--text-dim)',
      fontFamily: 'var(--font-display)', marginBottom: 8,
      display: 'flex', alignItems: 'center', gap: 8,
    }}>
      {children}
      {optional && (
        <span style={{ fontWeight: 400, letterSpacing: 0, textTransform: 'none', fontSize: 11, opacity: 0.6 }}>
          · optional
        </span>
      )}
    </div>
  )
}

function StyledInput({ value, onChange, placeholder, type = 'text', disabled }) {
  return (
    <input
      type={type}
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      disabled={disabled}
      style={{
        width: '100%', padding: '12px 14px',
        background: 'var(--surface2)', border: '1px solid var(--border-bright)',
        borderRadius: 10, color: 'var(--text)', fontSize: 14,
        fontFamily: 'var(--font-body)', outline: 'none',
        transition: 'border-color 0.15s',
        opacity: disabled ? 0.5 : 1,
      }}
      onFocus={e => { e.target.style.borderColor = 'var(--accent-line)' }}
      onBlur={e => { e.target.style.borderColor = 'var(--border-bright)' }}
    />
  )
}

function NativeSelect({ value, onChange, options, placeholder }) {
  return (
    <div style={{ position: 'relative' }}>
      <select
        value={value || ''}
        onChange={e => onChange(e.target.value || null)}
        style={{
          width: '100%', padding: '12px 36px 12px 14px',
          background: 'var(--surface2)', border: '1px solid var(--border-bright)',
          borderRadius: 10, color: value ? 'var(--text)' : 'var(--text-dim)',
          fontSize: 14, fontFamily: 'var(--font-body)', outline: 'none',
          appearance: 'none', cursor: 'pointer',
          transition: 'border-color 0.15s',
        }}
        onFocus={e => { e.target.style.borderColor = 'var(--accent-line)' }}
        onBlur={e => { e.target.style.borderColor = 'var(--border-bright)' }}
      >
        <option value="">{placeholder}</option>
        {options.map(o => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      {/* Chevron */}
      <svg style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', color: 'var(--text-dim)' }} width="14" height="14" viewBox="0 0 16 16" fill="none">
        <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Left panel — resume ingestion terminal
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Left panel — resume ingestion terminal
// ─────────────────────────────────────────────────────────────────────────────

function IngestionTerminal({ uploadedFiles, uploadStarted }) {
  const [activeIdx, setActiveIdx] = useState(-1)
  const [completedIdxs, setCompletedIdxs] = useState(new Set())
  const [cursor, setCursor] = useState(true)

  // Blink cursor
  useEffect(() => {
    const iv = setInterval(() => setCursor(c => !c), 530)
    return () => clearInterval(iv)
  }, [])

  // Drive phase rows on upload start
  useEffect(() => {
    if (!uploadStarted) return
    setActiveIdx(-1)
    setCompletedIdxs(new Set())

    const timers = []
    TERMINAL_PHASES.forEach(({ delay }, i) => {
      // Activate row
      timers.push(setTimeout(() => {
        setActiveIdx(i)
      }, delay))
      // Mark previous as complete when next starts
      if (i > 0) {
        timers.push(setTimeout(() => {
          setCompletedIdxs(prev => { const s = new Set(prev); s.add(i - 1); return s })
        }, delay))
      }
    })
    // Mark last as complete after a beat
    timers.push(setTimeout(() => {
      setCompletedIdxs(prev => {
        const s = new Set(prev)
        s.add(TERMINAL_PHASES.length - 1)
        return s
      })
      setActiveIdx(TERMINAL_PHASES.length)  // past last = all done
    }, TERMINAL_PHASES[TERMINAL_PHASES.length - 1].delay + 1200))

    return () => timers.forEach(clearTimeout)
  }, [uploadStarted])

  const isDone = activeIdx >= TERMINAL_PHASES.length

  return (
    <div style={{
      background: 'var(--terminal-bg, #0a0a0c)',
      border: '1px solid var(--border)',
      borderRadius: 12, overflow: 'hidden',
      flexShrink: 0,
    }}>
      {/* Terminal header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 7,
        padding: '10px 14px',
        borderBottom: '1px solid var(--terminal-divider, rgba(255,255,255,0.06))',
        background: 'var(--terminal-header-bg, rgba(255,255,255,0.025))',
      }}>
        <div style={{ width: 9, height: 9, borderRadius: '50%', background: 'rgba(255,80,80,0.4)' }} />
        <div style={{ width: 9, height: 9, borderRadius: '50%', background: 'rgba(255,190,50,0.4)' }} />
        <div style={{ width: 9, height: 9, borderRadius: '50%', background: isDone ? 'rgba(52,211,153,0.7)' : 'rgba(50,200,100,0.3)', transition: 'background 0.5s' }} />
        <span style={{
          marginLeft: 8, fontSize: 10, color: 'var(--terminal-dim, rgba(255,255,255,0.3))',
          fontFamily: 'var(--font-display)', letterSpacing: '0.06em',
        }}>rack · ingestion</span>
        {isDone && (
          <span style={{
            marginLeft: 'auto', fontSize: 10, color: 'rgba(52,211,153,0.7)',
            fontFamily: 'var(--font-display)', letterSpacing: '0.04em',
            animation: 'termFadeIn 0.4s ease both',
          }}>✓ complete</span>
        )}
      </div>

      {/* Phase rows */}
      <div style={{ padding: '12px 0' }}>
        {!uploadStarted ? (
          <div style={{ padding: '8px 16px' }}>
            <span style={{ fontSize: 11, color: 'var(--terminal-dim, rgba(255,255,255,0.3))', fontFamily: 'var(--font-display)' }}>
              awaiting upload
              <span style={{ opacity: cursor ? 1 : 0 }}> ▌</span>
            </span>
          </div>
        ) : TERMINAL_PHASES.map(({ text, label, done: isDonePhase }, i) => {
          const isComplete = completedIdxs.has(i)
          const isActive   = activeIdx === i
          const isPending  = activeIdx < i

          return (
            <div
              key={text}
              style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '6px 16px',
                opacity: isPending ? 0.25 : 1,
                transition: 'opacity 0.35s ease',
                animation: isActive ? 'termRowIn 0.25s ease both' : 'none',
              }}
            >
              {/* Status icon */}
              <div style={{ width: 16, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {isComplete ? (
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={{ animation: 'termCheckIn 0.2s ease both' }}>
                    <circle cx="6" cy="6" r="5.5" stroke="rgba(52,211,153,0.5)" strokeWidth="1" />
                    <path d="M3.5 6l1.8 1.8L8.5 4.5" stroke="rgba(52,211,153,0.9)" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                ) : isActive ? (
                  <div style={{
                    width: 8, height: 8, borderRadius: '50%',
                    border: '1.5px solid rgba(232,255,107,0.3)',
                    borderTopColor: 'var(--accent)',
                    animation: 'obSpin 0.7s linear infinite',
                  }} />
                ) : (
                  <div style={{
                    width: 5, height: 5, borderRadius: '50%',
                    background: 'rgba(255,255,255,0.15)',
                  }} />
                )}
              </div>

              {/* Label */}
              <span style={{
                fontSize: 11, lineHeight: 1.4,
                fontFamily: 'var(--font-display)',
                color: isComplete
                  ? isDonePhase ? 'rgba(52,211,153,0.9)' : 'rgba(255,255,255,0.45)'
                  : isActive
                    ? 'rgba(255,255,255,0.85)'
                    : 'rgba(255,255,255,0.2)',
                transition: 'color 0.3s ease',
                letterSpacing: '0.01em',
              }}>
                {isDonePhase && isComplete ? '✓ ' : ''}{label}
              </span>

              {/* Active pulse */}
              {isActive && (
                <span style={{
                  fontSize: 10, color: 'var(--terminal-dim, rgba(255,255,255,0.25))',
                  fontFamily: 'var(--font-display)',
                  opacity: cursor ? 1 : 0, transition: 'opacity 0.1s',
                }}>▌</span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// Left panel — full sidebar
function LeftPanel({ step, uploadedFiles, uploadStarted }) {
  const isUploadStep = step === 0

  // Steps for the animated progress display (steps 1–6 of wizard)
  const WIZARD_STEPS = [
    { key: 'location',  label: 'Location' },
    { key: 'contact',   label: 'Contact' },
    { key: 'work',      label: 'Work Status' },
    { key: 'checklist', label: 'Checklist' },
    { key: 'password',  label: 'Password' },
    { key: 'settings',  label: 'Apply Settings' },
  ]
  // step 1 = index 0, step 6 = index 5
  const wizardIdx = step - 1  // -1 when step=0

  return (
    <div style={{
      width: 260, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 20,
      paddingTop: isUploadStep ? 0 : 8,
    }}>
      {/* "Getting started" card */}
      <div style={{
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 14, padding: '18px 18px 16px', overflow: 'hidden',
      }}>
        <div style={{
          fontSize: 10, fontWeight: 600, letterSpacing: '0.12em',
          textTransform: 'uppercase', color: 'var(--text-dim)',
          fontFamily: 'var(--font-display)', marginBottom: 14,
        }}>Getting started</div>

        {!isUploadStep ? (
          <>
            {/* Resume status row */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
              <div style={{ position: 'relative', width: 20, height: 20, flexShrink: 0 }}>
                {/* Spinning progress ring */}
                <svg width="20" height="20" viewBox="0 0 20 20" style={{ position: 'absolute', inset: 0 }}>
                  <circle cx="10" cy="10" r="7.5" fill="none" stroke="rgba(232,255,107,0.1)" strokeWidth="2" />
                  <circle
                    cx="10" cy="10" r="7.5"
                    fill="none"
                    stroke="var(--accent)"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeDasharray="12 35"
                    style={{
                      transformOrigin: '10px 10px',
                      animation: uploadedFiles.length > 0 ? 'obSpin 1.4s linear infinite' : 'none',
                      opacity: uploadedFiles.length > 0 ? 1 : 0,
                      transition: 'opacity 0.4s',
                    }}
                  />
                </svg>
                {/* Center dot */}
                <div style={{
                  position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  <div style={{
                    width: 6, height: 6, borderRadius: '50%',
                    background: uploadedFiles.length > 0 ? 'var(--accent)' : 'rgba(255,255,255,0.2)',
                    transition: 'background 0.4s',
                    boxShadow: uploadedFiles.length > 0 ? '0 0 5px rgba(232,255,107,0.5)' : 'none',
                  }} />
                </div>
              </div>
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-mid)', fontFamily: 'var(--font-display)', lineHeight: 1 }}>
                  {uploadedFiles.length > 0 ? 'resume · processing' : 'resume · pending'}
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 3 }}>
                  {uploadedFiles.length > 0 ? 'parsing in background' : 'upload to begin'}
                </div>
              </div>
            </div>

            {/* Wizard step list */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
              {WIZARD_STEPS.map(({ key, label }, i) => {
                const isDone   = i < wizardIdx
                const isActive = i === wizardIdx
                const isPending = i > wizardIdx
                return (
                  <div
                    key={key}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10,
                      padding: '7px 0',
                      borderBottom: i < WIZARD_STEPS.length - 1 ? '1px solid var(--border)' : 'none',
                    }}
                  >
                    {/* Icon */}
                    <div style={{ width: 18, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      {isDone ? (
                        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ animation: 'termCheckIn 0.2s ease both' }}>
                          <circle cx="7" cy="7" r="6.5" fill="rgba(52,211,153,0.1)" stroke="rgba(52,211,153,0.4)" strokeWidth="1" />
                          <path d="M4 7l2 2 4-4" stroke="rgba(52,211,153,0.9)" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      ) : isActive ? (
                        <div style={{
                          width: 8, height: 8, borderRadius: '50%',
                          background: 'var(--accent)',
                          boxShadow: '0 0 6px rgba(232,255,107,0.5)',
                          animation: 'pulse-ring 2.5s ease infinite',
                        }} />
                      ) : (
                        <div style={{
                          width: 5, height: 5, borderRadius: '50%',
                          background: 'rgba(255,255,255,0.12)',
                        }} />
                      )}
                    </div>
                    <span style={{
                      fontSize: 12,
                      fontFamily: 'var(--font-display)',
                      color: isDone
                        ? 'rgba(52,211,153,0.7)'
                        : isActive
                          ? 'var(--text)'
                          : 'var(--text-dim)',
                      fontWeight: isActive ? 600 : 400,
                      transition: 'color 0.3s ease, font-weight 0.3s ease',
                      letterSpacing: '0.01em',
                    }}>{label}</span>
                  </div>
                )
              })}
            </div>

            {/* Why we ask */}
            <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12, marginTop: 12 }}>
              <p style={{ fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.6, margin: 0 }}>
                Answer once here — we fill the forms on every application.
              </p>
            </div>
          </>
        ) : (
          <>
            <p style={{ fontSize: 13, color: 'var(--text-dim)', lineHeight: 1.65, marginBottom: 14 }}>
              Upload your resume and we'll extract your profile, draft a cover letter, and queue jobs for you — usually in under a minute.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
              {[
                'AI pulls your skills, roles, and dates straight from the PDF.',
                'A first-pass cover letter is written from your experience.',
                'Personalized matches ready by the time you finish setup.',
              ].map((item, i) => (
                <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                  <svg style={{ marginTop: 2, flexShrink: 0, color: 'var(--accent3, #34d399)' }} width="13" height="13" viewBox="0 0 16 16" fill="none">
                    <path d="M3 8l3.5 3.5L13 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  <span style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.6 }}>{item}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Terminal — only shown after upload step */}
      {!isUploadStep && (
        <IngestionTerminal uploadedFiles={uploadedFiles} uploadStarted={uploadStarted} />
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 0 — Upload resume(s)
// ─────────────────────────────────────────────────────────────────────────────

function StepUpload({ files, onFilesChange, onContinue, uploading }) {
  const inputRef = useRef(null)
  const [dragOver, setDragOver] = useState(false)
  const MAX = 5

  const addFiles = (newFiles) => {
    const allowed = ['application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document']
    const valid = Array.from(newFiles)
      .filter(f => allowed.includes(f.type))
      .slice(0, MAX - files.length)
    if (valid.length) onFilesChange([...files, ...valid])
  }

  const removeFile = (idx) => {
    onFilesChange(files.filter((_, i) => i !== idx))
  }

  return (
    <div style={{ animation: 'obFadeUp 0.35s ease both' }}>
      <div style={{
        fontSize: 10, fontWeight: 600, letterSpacing: '0.12em',
        textTransform: 'uppercase', color: 'var(--text-dim)',
        fontFamily: 'var(--font-display)', marginBottom: 12,
      }}>Resume</div>

      <h1 style={{
        fontSize: 'clamp(26px, 4vw, 36px)', fontWeight: 700,
        color: 'var(--text)', letterSpacing: '-0.6px', lineHeight: 1.15,
        marginBottom: 12, fontFamily: 'var(--font-display)',
      }}>Upload your resume.</h1>

      <p style={{
        fontSize: 14, color: 'var(--text-dim)', lineHeight: 1.65, marginBottom: 32,
        maxWidth: 480,
      }}>
        PDF only, under 10MB. We parse it, draft a cover letter, and have matches waiting by the time you finish setup.
      </p>

      {/* Drop zone */}
      {files.length === 0 ? (
        <div
          onClick={() => inputRef.current?.click()}
          onDragOver={e => { e.preventDefault(); setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
          onDrop={e => {
            e.preventDefault(); setDragOver(false)
            addFiles(e.dataTransfer.files)
          }}
          style={{
            border: `1.5px dashed ${dragOver ? 'var(--accent-line)' : 'var(--upload-border)'}`,
            borderRadius: 14, padding: '48px 32px',
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12,
            cursor: 'pointer', transition: 'all 0.2s',
            background: dragOver ? 'var(--accent-soft)' : 'transparent',
            marginBottom: 24,
          }}
        >
          <svg width="32" height="32" viewBox="0 0 32 32" fill="none" style={{ color: 'var(--text-dim)' }}>
            <path d="M16 20V12M16 12l-4 4M16 12l4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M6 22a6 6 0 0 1 0-12 8 8 0 0 1 16 0 6 6 0 0 1 0 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
          <div style={{ textAlign: 'center' }}>
            <span style={{ fontSize: 14, color: 'var(--text-mid)' }}>Drop your PDF here, or </span>
            <span style={{ fontSize: 14, color: 'var(--accent-ink)', textDecoration: 'underline', cursor: 'pointer' }}>browse</span>
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>Up to 5 resumes · PDF only · 10MB each</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 24 }}>
          {files.map((f, i) => (
            <div key={i} style={{
              display: 'flex', alignItems: 'center', gap: 14,
              padding: '13px 16px', borderRadius: 12,
              border: '1px solid var(--border-bright)', background: 'var(--surface)',
              animation: 'obFadeUp 0.2s ease both',
            }}>
              {/* PDF icon */}
              <div style={{
                width: 34, height: 34, borderRadius: 8,
                background: 'rgba(52,211,153,0.07)',
                border: '1px solid rgba(52,211,153,0.2)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                flexShrink: 0,
              }}>
                <svg width="16" height="16" viewBox="0 0 20 20" fill="none" style={{ color: 'rgba(52,211,153,0.8)' }}>
                  <path d="M5 2h8l4 4v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Z" stroke="currentColor" strokeWidth="1.3" />
                  <path d="M13 2v5h4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                </svg>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.name}</div>
                <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 2 }}>{(f.size / 1024 / 1024).toFixed(2)} MB</div>
              </div>
              <button onClick={() => removeFile(i)} style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: 'var(--text-dim)', padding: 4, borderRadius: 6,
                display: 'flex', alignItems: 'center', flexShrink: 0,
              }}>
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                  <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </button>
            </div>
          ))}

          {files.length < MAX && (
            <button
              onClick={() => inputRef.current?.click()}
              style={{
                padding: '10px 16px', borderRadius: 10,
                border: '1px dashed var(--border-bright)',
                background: 'transparent', color: 'var(--text-dim)',
                fontSize: 13, cursor: 'pointer', textAlign: 'left',
                fontFamily: 'var(--font-body)',
              }}
            >
              + Add another resume ({files.length}/{MAX})
            </button>
          )}
        </div>
      )}

      <input
        ref={inputRef}
        type="file"
        accept=".pdf,.doc,.docx"
        multiple
        style={{ display: 'none' }}
        onChange={e => { addFiles(e.target.files); e.target.value = '' }}
      />

      {/* CTA */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 4 }}>
        <button
          onClick={onContinue}
          disabled={files.length === 0 || uploading}
          style={{
            padding: '12px 24px', borderRadius: 8,
            background: files.length > 0 ? 'var(--accent)' : 'var(--surface2)',
            border: 'none',
            color: files.length > 0 ? 'var(--accent-contrast)' : 'var(--text-dim)',
            fontSize: 14, fontWeight: 700, cursor: files.length > 0 ? 'pointer' : 'default',
            fontFamily: 'var(--font-body)', transition: 'all 0.2s',
            display: 'flex', alignItems: 'center', gap: 10,
            boxShadow: files.length > 0 ? 'var(--accent-glow)' : 'none',
          }}
          onMouseEnter={e => { if (files.length > 0) e.currentTarget.style.background = 'var(--accent-strong)' }}
          onMouseLeave={e => { if (files.length > 0) e.currentTarget.style.background = 'var(--accent)' }}
        >
          {uploading ? (
            <>
              <span style={{ width: 14, height: 14, borderRadius: '50%', border: '2px solid rgba(0,0,0,0.2)', borderTopColor: 'var(--accent-contrast)', animation: 'obSpin 0.7s linear infinite', display: 'inline-block' }} />
              Uploading...
            </>
          ) : (
            <>
              Continue
              <span style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                padding: '2px 6px', borderRadius: 4,
                background: 'rgba(0,0,0,0.18)',
                fontSize: 10, fontFamily: 'var(--font-display)',
                color: files.length > 0 ? 'rgba(0,0,0,0.5)' : 'var(--text-dim)',
                letterSpacing: '0.04em', lineHeight: 1.4,
                fontWeight: 600,
              }}>↵</span>
            </>
          )}
        </button>
        <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>Takes about 30 seconds</span>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 1 — Location
// ─────────────────────────────────────────────────────────────────────────────

function StepLocation({ data, onChange }) {
  const [suggestions, setSuggestions]     = useState([])
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [searchVal, setSearchVal]         = useState(data.street || '')
  const [loading, setLoading]             = useState(false)
  const [activeIdx, setActiveIdx]         = useState(-1)   // keyboard-nav index
  const debounceRef   = useRef(null)
  const abortRef      = useRef(null)      // cancel in-flight fetch on new keystroke
  const wrapperRef    = useRef(null)
  const listRef       = useRef(null)

  // Close on outside click
  useEffect(() => {
    const h = (e) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target))
        setShowSuggestions(false)
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])

  // Build a clean one-line label from Nominatim's structured address object.
  // Nominatim returns display_name as comma-joined raw tokens — parsing that
  // directly gives broken fragments. Instead we compose from known fields.
  const buildLabel = (place) => {
    const a   = place.address || {}
    const num  = a.house_number || ''
    const road = a.road || a.pedestrian || a.path || ''
    const city = a.city || a.town || a.village || a.suburb || ''
    const st   = a.state || ''
    const cty  = a.country_code === 'us' ? (a.state || '') : (a.country || '')

    // Primary: "123 Main St" or just "Main St"
    const primary = [num, road].filter(Boolean).join(' ') || place.display_name.split(',')[0].trim()
    // Secondary: "Brooklyn, NY" or "San Jose, CA"
    const secondary = [city, cty].filter(Boolean).join(', ')
    return { primary, secondary }
  }

  const fetchSuggestions = (q) => {
    clearTimeout(debounceRef.current)
    if (!q || q.trim().length < 3) {
      setSuggestions([])
      setShowSuggestions(false)
      setLoading(false)
      return
    }

    setLoading(true)

    debounceRef.current = setTimeout(async () => {
      // Cancel previous in-flight request
      if (abortRef.current) abortRef.current.abort()
      abortRef.current = new AbortController()

      try {
        const url = new URL('https://nominatim.openstreetmap.org/search')
        url.searchParams.set('format', 'json')
        url.searchParams.set('addressdetails', '1')
        url.searchParams.set('limit', '6')
        url.searchParams.set('q', q)
        // Bias toward US results but don't exclude international
        url.searchParams.set('countrycodes', 'us,ca,gb,in,au,de,fr')

        const res = await fetch(url.toString(), {
          headers: { 'Accept-Language': 'en-US,en' },
          signal: abortRef.current.signal,
        })
        const raw = await res.json()

        // Deduplicate by primary label — Nominatim often returns near-identical rows
        const seen = new Set()
        const deduped = raw.filter(p => {
          const { primary } = buildLabel(p)
          if (!primary || seen.has(primary.toLowerCase())) return false
          seen.add(primary.toLowerCase())
          return true
        }).slice(0, 5)

        setSuggestions(deduped)
        setShowSuggestions(deduped.length > 0)
        setActiveIdx(-1)
      } catch (e) {
        if (e.name !== 'AbortError') setSuggestions([])
      } finally {
        setLoading(false)
      }
    }, 280)   // 280ms feels snappy; Nominatim needs ~200ms anyway
  }

  const commitSelection = (place) => {
    const a      = place.address || {}
    const num    = a.house_number || ''
    const road   = a.road || a.pedestrian || a.path || ''
    const street = [num, road].filter(Boolean).join(' ') || place.display_name.split(',')[0].trim()
    const city   = a.city || a.town || a.village || a.suburb || ''
    const state  = a.state || ''
    const zip    = a.postcode || ''
    const country = a.country || ''
    const county  = a.county || ''

    setSearchVal(street)
    setShowSuggestions(false)
    setSuggestions([])
    setActiveIdx(-1)
    onChange({ ...data, street, city, state, zip, country, county })
  }

  const handleStreetChange = (v) => {
    setSearchVal(v)
    onChange({ ...data, street: v })
    fetchSuggestions(v)
  }

  const handleKeyDown = (e) => {
    if (!showSuggestions || suggestions.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIdx(i => Math.min(i + 1, suggestions.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIdx(i => Math.max(i - 1, 0))
    } else if (e.key === 'Enter' && activeIdx >= 0) {
      e.preventDefault()   // block the wizard's global Enter handler
      e.stopPropagation()
      commitSelection(suggestions[activeIdx])
    } else if (e.key === 'Escape') {
      setShowSuggestions(false)
      setActiveIdx(-1)
    }
  }

  const open = showSuggestions && suggestions.length > 0

  return (
    <div style={{ animation: 'obFadeUp 0.3s ease both' }}>
      <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--text-dim)', fontFamily: 'var(--font-display)', marginBottom: 12 }}>Location</div>
      <h2 style={{ fontSize: 'clamp(22px, 3vw, 30px)', fontWeight: 700, color: 'var(--text)', letterSpacing: '-0.5px', lineHeight: 1.2, marginBottom: 10, fontFamily: 'var(--font-display)' }}>
        Where do you live?
      </h2>
      <p style={{ fontSize: 13, color: 'var(--text-dim)', lineHeight: 1.65, marginBottom: 28 }}>
        Most job sites need a full address. We'll fill it in automatically from here.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 520 }}>

        {/* ── Street address with autocomplete ── */}
        <div ref={wrapperRef} style={{ position: 'relative' }}>
          <FieldLabel>Street Address</FieldLabel>

          {/* Input + inline loading spinner */}
          <div style={{ position: 'relative' }}>
            <input
              type="text"
              value={searchVal}
              onChange={e => handleStreetChange(e.target.value)}
              onKeyDown={handleKeyDown}
              onFocus={e => {
                e.target.style.borderColor = 'var(--accent-line)'
                if (suggestions.length > 0) setShowSuggestions(true)
              }}
              onBlur={e => {
                // Delay so onMouseDown on a suggestion can fire first
                setTimeout(() => {
                  e.target.style.borderColor = 'var(--border-bright)'
                  setShowSuggestions(false)
                }, 180)
              }}
              placeholder="Start typing your address..."
              autoComplete="off"
              style={{
                width: '100%', padding: '12px 38px 12px 14px',
                background: 'var(--surface2)',
                border: `1px solid ${open ? 'var(--accent-line)' : 'var(--border-bright)'}`,
                borderRadius: open ? '10px 10px 0 0' : 10,
                color: 'var(--text)', fontSize: 14,
                fontFamily: 'var(--font-body)', outline: 'none',
                transition: 'border-color 0.15s, border-radius 0.15s',
              }}
            />
            {/* Spinner or search icon */}
            <div style={{
              position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)',
              pointerEvents: 'none', display: 'flex', alignItems: 'center',
            }}>
              {loading ? (
                <div style={{
                  width: 14, height: 14, borderRadius: '50%',
                  border: '1.5px solid var(--border-bright)',
                  borderTopColor: 'var(--accent)',
                  animation: 'obSpin 0.65s linear infinite',
                }} />
              ) : (
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={{ color: 'var(--text-dim)', opacity: 0.5 }}>
                  <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.3" />
                  <path d="M11 11l2.5 2.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                </svg>
              )}
            </div>
          </div>

          {/* ── Suggestion dropdown ── */}
          <div style={{
            position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 200,
            background: 'var(--surface)',
            border: open ? '1px solid var(--accent-line)' : '1px solid transparent',
            borderTop: 'none',
            borderRadius: '0 0 12px 12px',
            overflow: 'hidden',
            boxShadow: open ? '0 12px 32px rgba(0,0,0,0.35), 0 2px 8px rgba(0,0,0,0.2)' : 'none',
            maxHeight: open ? 320 : 0,
            // CSS transition for smooth open/close — no layout jank
            transition: 'max-height 0.18s cubic-bezier(0.4,0,0.2,1), box-shadow 0.18s ease, border-color 0.18s ease',
          }}>
            <div ref={listRef}>
              {suggestions.map((s, i) => {
                const { primary, secondary } = buildLabel(s)
                const isActive = i === activeIdx
                return (
                  <div
                    key={s.place_id}
                    onMouseDown={(e) => { e.preventDefault(); commitSelection(s) }}
                    onMouseEnter={() => setActiveIdx(i)}
                    style={{
                      display: 'flex', alignItems: 'flex-start', gap: 10,
                      padding: '11px 14px',
                      background: isActive ? 'var(--surface2)' : 'transparent',
                      borderBottom: i < suggestions.length - 1 ? '1px solid var(--border)' : 'none',
                      cursor: 'pointer',
                      transition: 'background 0.1s',
                    }}
                  >
                    {/* Pin icon */}
                    <svg width="13" height="13" viewBox="0 0 16 16" fill="none"
                      style={{ color: isActive ? 'var(--accent-ink)' : 'var(--text-dim)', flexShrink: 0, marginTop: 2, transition: 'color 0.1s' }}>
                      <path d="M8 1.5a4 4 0 0 1 4 4c0 2.8-4 9-4 9S4 8.3 4 5.5a4 4 0 0 1 4-4Z"
                        stroke="currentColor" strokeWidth="1.3" />
                      <circle cx="8" cy="5.5" r="1.5" stroke="currentColor" strokeWidth="1.2" />
                    </svg>
                    <div style={{ minWidth: 0 }}>
                      <div style={{
                        fontSize: 13, fontWeight: 500,
                        color: isActive ? 'var(--text)' : 'var(--text-mid)',
                        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                        transition: 'color 0.1s',
                      }}>
                        {primary}
                      </div>
                      {secondary && (
                        <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 1 }}>
                          {secondary}
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>

        {/* ── Remaining fields — pre-filled when a suggestion is picked ── */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          <div>
            <FieldLabel>City</FieldLabel>
            <StyledInput
              placeholder="San Francisco"
              value={data.city || ''}
              onChange={v => onChange({ ...data, city: v })}
            />
          </div>
          <div>
            <FieldLabel>ZIP</FieldLabel>
            <StyledInput
              placeholder="94103"
              value={data.zip || ''}
              onChange={v => onChange({ ...data, zip: v })}
            />
          </div>
        </div>

        <div>
          <FieldLabel>County / District</FieldLabel>
          <StyledInput
            placeholder="Auto-filled from your address"
            value={data.county || ''}
            onChange={v => onChange({ ...data, county: v })}
          />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          <div>
            <FieldLabel>Country</FieldLabel>
            <StyledInput
              placeholder="United States"
              value={data.country || ''}
              onChange={v => onChange({ ...data, country: v })}
            />
          </div>
          <div>
            <FieldLabel>State</FieldLabel>
            <StyledInput
              placeholder="California"
              value={data.state || ''}
              onChange={v => onChange({ ...data, state: v })}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 2 — Contact
// ─────────────────────────────────────────────────────────────────────────────

function StepContact({ data, onChange }) {
  return (
    <div style={{ animation: 'obFadeUp 0.3s ease both' }}>
      <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--text-dim)', fontFamily: 'var(--font-display)', marginBottom: 12 }}>Contact</div>
      <h2 style={{ fontSize: 'clamp(22px, 3vw, 30px)', fontWeight: 700, color: 'var(--text)', letterSpacing: '-0.5px', lineHeight: 1.2, marginBottom: 10, fontFamily: 'var(--font-display)' }}>
        How should we reach out?
      </h2>
      <p style={{ fontSize: 13, color: 'var(--text-dim)', lineHeight: 1.65, marginBottom: 28 }}>
        Phone and LinkedIn show up on most applications. Skip and we'll use whatever the resume parser finds.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 20, maxWidth: 520 }}>
        <div>
          <FieldLabel>Phone</FieldLabel>
          <StyledInput
            placeholder="Enter phone number starting with + and country code"
            value={data.phone || ''}
            onChange={v => onChange({ ...data, phone: v })}
            type="tel"
          />
          <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 6 }}>
            Example: +1 for US/Canada, +91 for India, etc.
          </div>
        </div>

        <div>
          <FieldLabel>LinkedIn</FieldLabel>
          <StyledInput
            placeholder="https://linkedin.com/in/yourhandle"
            value={data.linkedin || ''}
            onChange={v => onChange({ ...data, linkedin: v })}
            type="url"
          />
          <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 6 }}>
            Asked on basically every Workday / Greenhouse application.
          </div>
        </div>

        <div>
          <FieldLabel>GitHub</FieldLabel>
          <StyledInput
            placeholder="https://github.com/yourhandle"
            value={data.github || ''}
            onChange={v => onChange({ ...data, github: v })}
            type="url"
          />
        </div>

        <div>
          <FieldLabel>Personal Website</FieldLabel>
          <StyledInput
            placeholder="https://yoursite.com"
            value={data.website || ''}
            onChange={v => onChange({ ...data, website: v })}
            type="url"
          />
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 3 — Work status
// ─────────────────────────────────────────────────────────────────────────────

function StepWorkStatus({ data, onChange }) {
  return (
    <div style={{ animation: 'obFadeUp 0.3s ease both' }}>
      <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--text-dim)', fontFamily: 'var(--font-display)', marginBottom: 12 }}>Work Eligibility</div>
      <h2 style={{ fontSize: 'clamp(22px, 3vw, 30px)', fontWeight: 700, color: 'var(--text)', letterSpacing: '-0.5px', lineHeight: 1.2, marginBottom: 10, fontFamily: 'var(--font-display)' }}>
        What's your work status?
      </h2>
      <p style={{ fontSize: 13, color: 'var(--text-dim)', lineHeight: 1.65, marginBottom: 28 }}>
        We use this to filter out jobs you can't apply to. Pick the closest one.
      </p>

      {/* Status grid */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10,
        marginBottom: 28, maxWidth: 520,
      }}>
        {WORK_STATUS_OPTIONS.map(opt => {
          const active = data.work_auth_type === opt
          return (
            <button
              key={opt}
              onClick={() => onChange({ ...data, work_auth_type: active ? null : opt })}
              style={{
                padding: '12px 8px', borderRadius: 10, textAlign: 'center',
                border: `1px solid ${active ? 'var(--accent-line)' : 'var(--border-bright)'}`,
                background: active ? 'var(--accent-soft)' : 'var(--surface2)',
                color: active ? 'var(--accent-ink)' : 'var(--text-mid)',
                fontSize: 13, fontWeight: active ? 600 : 400,
                cursor: 'pointer', transition: 'all 0.15s',
                fontFamily: 'var(--font-body)',
              }}
            >{opt}</button>
          )
        })}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 520 }}>
        {/* Authorized */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '14px 18px', borderRadius: 10, border: '1px solid var(--border)',
          background: 'var(--surface)',
        }}>
          <span style={{ fontSize: 13, color: 'var(--text-mid)' }}>
            Are you legally authorized to work in the US?
          </span>
          <YesNo value={data.work_auth} onChange={v => onChange({ ...data, work_auth: v })} />
        </div>

        {/* Sponsorship */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '14px 18px', borderRadius: 10, border: '1px solid var(--border)',
          background: 'var(--surface)',
        }}>
          <span style={{ fontSize: 13, color: 'var(--text-mid)', maxWidth: 280 }}>
            Will you now, or in the future, require sponsorship?
          </span>
          <YesNo value={data.requires_sponsorship} onChange={v => onChange({ ...data, requires_sponsorship: v })} />
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 4 — Quick checklist + EEO
// ─────────────────────────────────────────────────────────────────────────────

function StepChecklist({ data, onChange }) {
  const Row = ({ label, sub, field, options }) => (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '13px 16px', borderBottom: '1px solid var(--border)',
    }}>
      <div>
        <div style={{ fontSize: 13, color: 'var(--text)' }}>{label}</div>
        {sub && <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 2 }}>{sub}</div>}
      </div>
      {options ? (
        <YesNo
          value={data[field]}
          onChange={v => onChange({ ...data, [field]: v })}
          options={options}
        />
      ) : (
        <YesNo value={data[field]} onChange={v => onChange({ ...data, [field]: v })} />
      )}
    </div>
  )

  return (
    <div style={{ animation: 'obFadeUp 0.3s ease both' }}>
      <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--text-dim)', fontFamily: 'var(--font-display)', marginBottom: 12 }}>Quick Checklist</div>
      <h2 style={{ fontSize: 'clamp(22px, 3vw, 30px)', fontWeight: 700, color: 'var(--text)', letterSpacing: '-0.5px', lineHeight: 1.2, marginBottom: 10, fontFamily: 'var(--font-display)' }}>
        A few last questions.
      </h2>
      <p style={{ fontSize: 13, color: 'var(--text-dim)', lineHeight: 1.65, marginBottom: 28 }}>
        Tap through. Defaults work for most people — only change what applies.
      </p>

      <div style={{ maxWidth: 560 }}>
        {/* Preferences */}
        <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-dim)', fontFamily: 'var(--font-display)', marginBottom: 2 }}>Preferences</div>
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden', marginBottom: 18 }}>
          <Row label="Open to in-person work?"    field="open_to_inperson" />
          <Row label="Willing to relocate?"       field="willing_to_relocate" />
          <Row label="Can start immediately?"     field="can_start_immediately" />
          <Row label="Reliable transportation?"   field="reliable_transportation" />
          <Row label="Need workplace accommodations?" sub="Disability, religious, or other." field="needs_accommodation" options={['Yes', 'No', 'Prefer not']} />
        </div>

        {/* Background */}
        <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-dim)', fontFamily: 'var(--font-display)', marginBottom: 2 }}>Background</div>
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden', marginBottom: 18 }}>
          <Row label="Active government clearance?" field="gov_clearance" />
          <Row label="Family ties to foreign governments?" sub="Employers are required to ask." field="family_ties_foreign_gov" />
        </div>

        {/* Diversity & Inclusion */}
        <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-dim)', fontFamily: 'var(--font-display)', marginBottom: 2 }}>Diversity & Inclusion <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0, fontSize: 11, opacity: 0.6 }}>(optional)</span></div>
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden', marginBottom: 0 }}>
          <div style={{ padding: '13px 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 13, color: 'var(--text)' }}>Gender</span>
            <NativeSelect value={data.gender_eeo} onChange={v => onChange({ ...data, gender_eeo: v })} options={GENDER_OPTIONS} placeholder="Select..." />
          </div>
          <div style={{ padding: '13px 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 13, color: 'var(--text)' }}>Race / Ethnicity</span>
            <NativeSelect value={data.ethnicity_eeo} onChange={v => onChange({ ...data, ethnicity_eeo: v })} options={ETHNICITY_OPTIONS} placeholder="Select..." />
          </div>
          <div style={{ padding: '13px 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 13, color: 'var(--text)' }}>Veteran status</span>
            <NativeSelect value={data.veteran_status} onChange={v => onChange({ ...data, veteran_status: v })} options={VETERAN_OPTIONS} placeholder="Select..." />
          </div>
          <div style={{ padding: '13px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <div style={{ fontSize: 13, color: 'var(--text)' }}>Disability status</div>
              <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 2 }}>Employers must report this in aggregate.</div>
            </div>
            <NativeSelect value={data.disability_status} onChange={v => onChange({ ...data, disability_status: v })} options={DISABILITY_OPTIONS} placeholder="Select..." />
          </div>
        </div>

        {/* Additional info */}
        <div style={{ marginTop: 18 }}>
          <FieldLabel optional>Anything else we should know when filling applications?</FieldLabel>
          <textarea
            placeholder='e.g. "Notice period 15 days", "Willing to travel up to 50%"'
            value={data.additional_info || ''}
            onChange={e => onChange({ ...data, additional_info: e.target.value })}
            rows={3}
            style={{
              width: '100%', padding: '12px 14px',
              background: 'var(--surface2)', border: '1px solid var(--border-bright)',
              borderRadius: 10, color: 'var(--text)', fontSize: 13,
              fontFamily: 'var(--font-body)', outline: 'none', resize: 'vertical',
              transition: 'border-color 0.15s',
            }}
            onFocus={e => { e.target.style.borderColor = 'var(--accent-line)' }}
            onBlur={e => { e.target.style.borderColor = 'var(--border-bright)' }}
          />
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 5 — Application password
// ─────────────────────────────────────────────────────────────────────────────

function StepPassword({ data, onChange }) {
  const [show, setShow] = useState(false)
  const [generated, setGenerated] = useState(false)

  const generatePassword = () => {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*'
    let pwd = ''
    // Ensure at least one of each required type
    const lower = 'abcdefghijklmnopqrstuvwxyz'
    const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
    const nums  = '0123456789'
    const special = '!@#$%^&*'
    pwd += lower[Math.floor(Math.random() * lower.length)]
    pwd += upper[Math.floor(Math.random() * upper.length)]
    pwd += nums[Math.floor(Math.random() * nums.length)]
    pwd += special[Math.floor(Math.random() * special.length)]
    for (let i = 4; i < 16; i++) pwd += chars[Math.floor(Math.random() * chars.length)]
    // Shuffle
    pwd = pwd.split('').sort(() => Math.random() - 0.5).join('')
    onChange({ ...data, app_password: pwd })
    setGenerated(true)
  }

  const checks = [
    { label: 'At least 12 characters', ok: (data.app_password || '').length >= 12 },
    { label: 'At least one lowercase letter', ok: /[a-z]/.test(data.app_password || '') },
    { label: 'At least one uppercase letter', ok: /[A-Z]/.test(data.app_password || '') },
    { label: 'At least one number', ok: /[0-9]/.test(data.app_password || '') },
    { label: 'At least one special character', ok: /[^a-zA-Z0-9]/.test(data.app_password || '') },
  ]

  return (
    <div style={{ animation: 'obFadeUp 0.3s ease both' }}>
      <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--text-dim)', fontFamily: 'var(--font-display)', marginBottom: 12 }}>Application Password</div>
      <h2 style={{ fontSize: 'clamp(22px, 3vw, 30px)', fontWeight: 700, color: 'var(--text)', letterSpacing: '-0.5px', lineHeight: 1.2, marginBottom: 10, fontFamily: 'var(--font-display)' }}>
        Set a password for sites that ask
      </h2>
      <p style={{ fontSize: 13, color: 'var(--text-dim)', lineHeight: 1.65, marginBottom: 8 }}>
        Some applications (Workday, iCIMS, Oracle) require you to create an account mid-flow. We use this to sign you up automatically.
      </p>

      {/* Platform pills */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 28 }}>
        {['Workday', 'iCIMS', 'Oracle', '+ more'].map(p => (
          <span key={p} style={{
            padding: '4px 12px', borderRadius: 20,
            border: '1px solid var(--border-bright)',
            background: 'var(--surface2)',
            fontSize: 12, color: 'var(--text-dim)',
          }}>{p}</span>
        ))}
      </div>

      <div style={{ maxWidth: 520 }}>
        <div style={{
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 14, padding: '20px', marginBottom: 16,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
            <FieldLabel>Password</FieldLabel>
            <button
              onClick={generatePassword}
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: 'var(--accent-ink)', fontSize: 12, fontWeight: 600,
                fontFamily: 'var(--font-body)', padding: 0,
                textDecoration: 'underline', textUnderlineOffset: 3,
              }}
            >Generate strong password</button>
          </div>

          {/* Password input */}
          <div style={{ position: 'relative', marginBottom: 16 }}>
            <input
              type={show ? 'text' : 'password'}
              value={data.app_password || ''}
              onChange={e => { onChange({ ...data, app_password: e.target.value }); setGenerated(false) }}
              placeholder="Enter your application password"
              style={{
                width: '100%', padding: '12px 44px 12px 14px',
                background: 'var(--surface2)', border: '1px solid var(--border-bright)',
                borderRadius: 10, color: 'var(--text)', fontSize: 14,
                fontFamily: 'var(--font-body)', outline: 'none',
                transition: 'border-color 0.15s',
              }}
              onFocus={e => { e.target.style.borderColor = 'var(--accent-line)' }}
              onBlur={e => { e.target.style.borderColor = 'var(--border-bright)' }}
            />
            <button
              onClick={() => setShow(s => !s)}
              style={{
                position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)',
                background: 'none', border: 'none', cursor: 'pointer',
                color: 'var(--text-dim)', display: 'flex', alignItems: 'center',
              }}
            >
              {show ? (
                <svg width="16" height="16" viewBox="0 0 20 20" fill="none"><path d="M17.94 10A9.85 9.85 0 0 1 10 17c-3.87 0-7.2-2.14-9-5.25A9.86 9.86 0 0 1 10 6.5c2.88 0 5.46 1.22 7.29 3.17" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /><circle cx="10" cy="10" r="2.5" stroke="currentColor" strokeWidth="1.4" /><path d="M2.5 2.5l15 15" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 20 20" fill="none"><path d="M1 10S4 4 10 4s9 6 9 6-3 6-9 6S1 10 1 10Z" stroke="currentColor" strokeWidth="1.4" /><circle cx="10" cy="10" r="2.5" stroke="currentColor" strokeWidth="1.4" /></svg>
              )}
            </button>
          </div>

          {/* Checks */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            {checks.map(({ label, ok }) => (
              <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{
                  width: 14, height: 14, borderRadius: '50%', flexShrink: 0,
                  border: `1.5px solid ${ok ? 'var(--accent3, #34d399)' : 'var(--border-bright)'}`,
                  background: ok ? 'rgba(52,211,153,0.12)' : 'transparent',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  transition: 'all 0.2s',
                }}>
                  {ok && <svg width="8" height="8" viewBox="0 0 10 10" fill="none"><path d="M2 5l2 2 4-4" stroke="rgba(52,211,153,0.9)" strokeWidth="1.4" strokeLinecap="round" /></svg>}
                </div>
                <span style={{ fontSize: 12, color: ok ? 'var(--text-mid)' : 'var(--text-dim)' }}>{label}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Encryption note */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <div style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--accent3, #34d399)', flexShrink: 0 }} />
          <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>
            Encryption coming soon — stored securely in your profile
          </span>
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 6 — Apply settings
// ─────────────────────────────────────────────────────────────────────────────

function StepApplySettings({ data, onChange }) {
  return (
    <div style={{ animation: 'obFadeUp 0.3s ease both' }}>
      <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--text-dim)', fontFamily: 'var(--font-display)', marginBottom: 12 }}>Application Settings</div>
      <h2 style={{ fontSize: 'clamp(22px, 3vw, 30px)', fontWeight: 700, color: 'var(--text)', letterSpacing: '-0.5px', lineHeight: 1.2, marginBottom: 10, fontFamily: 'var(--font-display)' }}>
        How should we apply?
      </h2>
      <p style={{ fontSize: 13, color: 'var(--text-dim)', lineHeight: 1.65, marginBottom: 28 }}>
        You can change these anytime from settings.
      </p>

      <div style={{ maxWidth: 520 }}>
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, overflow: 'hidden', marginBottom: 20 }}>
          <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border)' }}>
            <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-dim)', fontFamily: 'var(--font-display)', marginBottom: 14 }}>Resume Optimization</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
              {OPTIMIZE_OPTIONS.map(({ value, label, desc }) => {
                const active = (data.optimize_mode || 'honest') === value
                return (
                  <label
                    key={value}
                    onClick={() => onChange({ ...data, optimize_mode: value })}
                    style={{
                      display: 'flex', alignItems: 'flex-start', gap: 14,
                      padding: '13px 0',
                      borderBottom: value !== 'aggressive' ? '1px solid var(--border)' : 'none',
                      cursor: 'pointer',
                      background: active ? 'transparent' : 'transparent',
                    }}
                  >
                    {/* Radio button */}
                    <div style={{
                      width: 18, height: 18, borderRadius: '50%', flexShrink: 0, marginTop: 1,
                      border: `2px solid ${active ? 'var(--accent-ink)' : 'var(--border-bright)'}`,
                      background: active ? 'var(--accent-soft)' : 'transparent',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      transition: 'all 0.15s',
                    }}>
                      {active && <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--accent-ink)' }} />}
                    </div>
                    <div>
                      <div style={{ fontSize: 14, fontWeight: active ? 600 : 400, color: active ? 'var(--text)' : 'var(--text-mid)', marginBottom: 3 }}>{label}</div>
                      <div style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.5 }}>{desc}</div>
                    </div>
                  </label>
                )
              })}
            </div>
          </div>

          {/* Auto-approve */}
          <div style={{ padding: '14px 18px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <div style={{ fontSize: 13, color: 'var(--text)', marginBottom: 3 }}>Auto-approve edits?</div>
              <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>Skip the preview step and send optimized files straight through.</div>
            </div>
            <YesNo value={data.auto_approve || 'no'} onChange={v => onChange({ ...data, auto_approve: v })} />
          </div>
        </div>

        {/* Finish note */}
        <div style={{
          padding: '14px 16px', borderRadius: 10,
          background: 'var(--accent-soft)', border: '1px solid var(--accent-line)',
        }}>
          <div style={{ fontSize: 13, color: 'var(--accent-ink)', lineHeight: 1.6 }}>
            🎉 You're all set. Click <strong>Finish Setup</strong> and we'll take you to your personalized job dashboard.
          </div>
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Onboarding component
// ─────────────────────────────────────────────────────────────────────────────

export default function Onboarding({ user, onComplete }) {
  const [step, setStep] = useState(0)       // 0 = upload pre-step, 1–6 = wizard
  const [uploadedFiles, setUploadedFiles]   = useState([])
  const [uploading, setUploading]           = useState(false)
  const [uploadStarted, setUploadStarted]   = useState(false)
  const [saving, setSaving]                 = useState(false)
  const [saveError, setSaveError]           = useState(null)

  // Per-step form data — flat object, all goes to PUT /api/account/profile
  const [locationData, setLocationData]   = useState({})
  const [contactData, setContactData]     = useState({})
  const [workData, setWorkData]           = useState({})
  const [checklistData, setChecklistData] = useState({
    open_to_inperson: 'yes', willing_to_relocate: 'yes',
    can_start_immediately: 'yes', reliable_transportation: 'yes',
  })
  const [passwordData, setPasswordData]   = useState({})
  const [settingsData, setSettingsData]   = useState({ optimize_mode: 'honest', auto_approve: 'no' })

  // ── Upload resumes ──────────────────────────────────────────────────────────
  const uploadResumes = useCallback(async (files) => {
    setUploading(true)
    setUploadStarted(true)
    try {
      const headers = await getAuthHeaders()
      for (const file of files) {
        const fd = new FormData()
        fd.append('file', file)
        await fetch(`${API_BASE}/api/resumes/upload`, {
          method: 'POST',
          headers,
          body: fd,
        })
      }
    } catch (err) {
      console.error('[Onboarding] upload error:', err)
    } finally {
      setUploading(false)
    }
  }, [])

  // ── Save current step's data to backend ─────────────────────────────────────
  const saveStepData = useCallback(async (stepNum) => {
    let payload = {}

    if (stepNum === 1) {
      // Build current_location from parts
      const parts = [locationData.street, locationData.city, locationData.state, locationData.zip, locationData.country].filter(Boolean)
      payload = { current_location: parts.join(', ') }
    } else if (stepNum === 2) {
      payload = {
        phone:   contactData.phone   || null,
        linkedin: contactData.linkedin || null,
        github:  contactData.github  || null,
        website: contactData.website || null,
      }
    } else if (stepNum === 3) {
      payload = {
        work_auth:            workData.work_auth            || null,
        requires_sponsorship: workData.requires_sponsorship || null,
        work_auth_type:       workData.work_auth_type       || null,
      }
    } else if (stepNum === 4) {
      payload = {
        gender_eeo:              checklistData.gender_eeo        || null,
        ethnicity_eeo:           checklistData.ethnicity_eeo     || null,
        veteran_status:          checklistData.veteran_status    || null,
        disability_status:       checklistData.disability_status || null,
        open_to_inperson:        checklistData.open_to_inperson        || null,
        willing_to_relocate:     checklistData.willing_to_relocate     || null,
        can_start_immediately:   checklistData.can_start_immediately   || null,
        reliable_transportation: checklistData.reliable_transportation || null,
        needs_accommodation:     checklistData.needs_accommodation     || null,
        gov_clearance:           checklistData.gov_clearance           || null,
        family_ties_foreign_gov: checklistData.family_ties_foreign_gov || null,
        additional_info:         checklistData.additional_info         || null,
      }
    } else if (stepNum === 5) {
      payload = { app_password: passwordData.app_password || null }
    } else if (stepNum === 6) {
      payload = {
        optimize_mode: settingsData.optimize_mode || 'honest',
        auto_approve:  settingsData.auto_approve  || 'no',
        onboarding_complete: true,
      }
    }

    // Strip null values to avoid overwriting real data
    const clean = Object.fromEntries(Object.entries(payload).filter(([, v]) => v !== null && v !== undefined))
    if (!Object.keys(clean).length) return

    try {
      const headers = await getAuthHeaders()
      const res = await fetch(`${API_BASE}/api/account/profile`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(clean),
      })
      if (!res.ok) throw new Error('Save failed')
    } catch (err) {
      console.error(`[Onboarding] save step ${stepNum} error:`, err)
      throw err
    }
  }, [locationData, contactData, workData, checklistData, passwordData, settingsData])

  // ── Navigation ──────────────────────────────────────────────────────────────
  const handleUploadContinue = () => {
    // Kick off uploads in the background — don't await.
    // Terminal animation starts immediately; user advances to step 1 right away.
    // After uploads settle, also trigger instant match (fire-and-forget).
    uploadResumes(uploadedFiles).then(async () => {
      try {
        const headers = await getAuthHeaders()
        await fetch(`${API_BASE}/api/match/onboarding`, {
          method: 'POST',
          headers,
        })
      } catch (err) {
        // Non-fatal — scheduler will cover it on next run
        console.warn('[Onboarding] instant match trigger failed:', err)
      }
    })
    setStep(1)
  }

  const handleNext = async () => {
    setSaveError(null)
    setSaving(true)
    try {
      await saveStepData(step)
      if (step === TOTAL_STEPS) {
        onComplete()
      } else {
        setStep(s => s + 1)
      }
    } catch {
      setSaveError('Failed to save — check your connection and try again.')
    } finally {
      setSaving(false)
    }
  }

  const handleBack = () => {
    if (step > 1) setStep(s => s - 1)
  }

  // ── Keyboard shortcuts ────────────────────────────────────────────────────────
  // Enter = next step (triggers button press animation), Shift+Tab = previous step.
  // Guard: only fire when no input/select is focused.
  // Exception: when the dropdown is open on StepLocation (Enter picks suggestion — handled there with stopPropagation).
  useEffect(() => {
    const onKey = (e) => {
      const tag = document.activeElement?.tagName?.toLowerCase()
      const isTyping = tag === 'input' || tag === 'textarea' || tag === 'select'

      if (e.key === 'Enter' && !isTyping && !e.shiftKey) {
        e.preventDefault()

        // Animate the Continue button press
        const btn = document.getElementById('ob-continue-btn')
        if (btn && !saving) {
          btn.style.transform = 'scale(0.96)'
          btn.style.boxShadow = 'none'
          setTimeout(() => {
            btn.style.transform = ''
            btn.style.boxShadow = 'var(--accent-glow)'
          }, 100)
        }

        if (step === 0 && uploadedFiles.length > 0 && !uploading) {
          handleUploadContinue()
        } else if (step >= 1 && !saving) {
          handleNext()
        }
      }

      if (e.key === 'Tab' && e.shiftKey && !isTyping && step > 1) {
        e.preventDefault()
        handleBack()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [step, saving, uploading, uploadedFiles]) // eslint-disable-line

  // ── Render current step content ─────────────────────────────────────────────
  const renderStep = () => {
    switch (step) {
      case 0: return (
        <StepUpload
          files={uploadedFiles}
          onFilesChange={setUploadedFiles}
          onContinue={handleUploadContinue}
          uploading={uploading}
        />
      )
      case 1: return <StepLocation    data={locationData}  onChange={setLocationData}  />
      case 2: return <StepContact     data={contactData}   onChange={setContactData}   />
      case 3: return <StepWorkStatus  data={workData}      onChange={setWorkData}      />
      case 4: return <StepChecklist   data={checklistData} onChange={setChecklistData} />
      case 5: return <StepPassword    data={passwordData}  onChange={setPasswordData}  />
      case 6: return <StepApplySettings data={settingsData} onChange={setSettingsData} />
      default: return null
    }
  }

  const isWizardStep = step >= 1
  const stepLabel = isWizardStep ? `Step ${step} of ${TOTAL_STEPS}` : null
  const progress  = isWizardStep ? (step / TOTAL_STEPS) * 100 : 0

  return (
    <div style={{
      position: 'fixed', inset: 0,
      background: 'var(--bg)',
      display: 'flex', flexDirection: 'column',
      overflow: 'hidden',
      zIndex: 500,
    }}>
      {/* ── Top bar ── */}
      <div style={{
        height: 48, flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '0 32px',
        borderBottom: '1px solid var(--border)',
        position: 'relative',
      }}>
        {/* Logo */}
        <div style={{
          fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 700,
          color: 'var(--text)', display: 'flex', alignItems: 'center', gap: 7,
          letterSpacing: '-0.3px',
        }}>
          <div style={{
            width: 7, height: 7, borderRadius: '50%', background: 'var(--accent)',
            animation: 'pulse-ring 2.5s ease infinite',
          }} />
          Rack
        </div>

        {/* Back link */}
        {isWizardStep && step > 1 ? (
          <button
            onClick={handleBack}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: 'var(--text-dim)', fontSize: 13, display: 'flex', alignItems: 'center', gap: 6,
              fontFamily: 'var(--font-body)', padding: 0,
            }}
            onMouseEnter={e => e.currentTarget.style.color = 'var(--text-mid)'}
            onMouseLeave={e => e.currentTarget.style.color = 'var(--text-dim)'}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M10 4L6 8l4 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Back
          </button>
        ) : <div style={{ width: 60 }} />}
      </div>

      {/* ── Body ── */}
      <div style={{
        flex: 1, overflowY: 'auto', overflowX: 'hidden',
        display: 'flex', justifyContent: 'center',
        padding: '0 32px',
      }}>
        <div style={{
          width: '100%', maxWidth: 880,
          display: 'flex', gap: 48, padding: '48px 0 120px',
          alignItems: 'flex-start',
        }}>
          {/* Left panel */}
          <LeftPanel
            step={step}
            uploadedFiles={uploadedFiles}
            uploadStarted={uploadStarted}
          />

          {/* Right — step content */}
          <div style={{ flex: 1, minWidth: 0 }}>
            {/* Scoped step counter + progress bar — only for wizard steps */}
            {isWizardStep && (
              <div style={{ marginBottom: 32 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                  <span style={{
                    fontSize: 11, color: 'var(--text-dim)', fontFamily: 'var(--font-display)',
                    letterSpacing: '0.08em', textTransform: 'uppercase',
                  }}>{stepLabel}</span>
                  <span style={{
                    fontSize: 11, color: 'var(--accent-ink)', fontFamily: 'var(--font-display)',
                    fontWeight: 600, letterSpacing: '0.04em',
                  }}>{Math.round(progress)}%</span>
                </div>
                {/* Progress track */}
                <div style={{
                  height: 3, background: 'var(--border)',
                  borderRadius: 4, overflow: 'hidden',
                }}>
                  <div style={{
                    height: '100%',
                    background: 'var(--accent)',
                    width: `${progress}%`,
                    borderRadius: 4,
                    transition: 'width 0.5s cubic-bezier(0.4, 0, 0.2, 1)',
                    boxShadow: '0 0 8px rgba(232,255,107,0.4)',
                  }} />
                </div>
              </div>
            )}

            {renderStep()}

            {/* ── Step navigation footer (wizard steps only) ── */}
            {isWizardStep && (
              <div style={{ marginTop: 40, display: 'flex', alignItems: 'center', gap: 14 }}>
                {saveError && (
                  <span style={{ fontSize: 12, color: 'var(--danger)' }}>{saveError}</span>
                )}
                <button
                  id="ob-continue-btn"
                  onClick={handleNext}
                  disabled={saving}
                  style={{
                    padding: '12px 24px', borderRadius: 8,
                    background: 'var(--accent)', border: 'none',
                    color: 'var(--accent-contrast)', fontSize: 14, fontWeight: 700,
                    cursor: saving ? 'default' : 'pointer',
                    fontFamily: 'var(--font-body)', display: 'flex', alignItems: 'center', gap: 10,
                    boxShadow: 'var(--accent-glow)', transition: 'background 0.15s, transform 0.08s',
                    opacity: saving ? 0.7 : 1,
                  }}
                  onMouseEnter={e => { if (!saving) e.currentTarget.style.background = 'var(--accent-strong)' }}
                  onMouseLeave={e => { if (!saving) e.currentTarget.style.background = 'var(--accent)' }}
                >
                  {saving ? (
                    <>
                      <span style={{ width: 14, height: 14, borderRadius: '50%', border: '2px solid rgba(0,0,0,0.2)', borderTopColor: 'var(--accent-contrast)', animation: 'obSpin 0.7s linear infinite', display: 'inline-block' }} />
                      Saving...
                    </>
                  ) : step === TOTAL_STEPS ? (
                    <>
                      Finish Setup
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                        <path d="M3 8l3.5 3.5L13 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </>
                  ) : (
                    <>
                      Continue
                      <span style={{
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        padding: '2px 6px', borderRadius: 4,
                        background: 'rgba(0,0,0,0.18)',
                        fontSize: 10, fontFamily: 'var(--font-display)',
                        color: 'rgba(0,0,0,0.5)',
                        letterSpacing: '0.04em', lineHeight: 1.4,
                        fontWeight: 600,
                      }}>↵</span>
                    </>
                  )}
                </button>

                {/* Keyboard hint */}
                {step > 1 && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                    <kbd style={{ padding: '2px 6px', borderRadius: 4, border: '1px solid var(--border-bright)', background: 'var(--surface2)', fontSize: 10, color: 'var(--text-dim)', fontFamily: 'var(--font-display)' }}>⇧ Tab</kbd>
                    <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>Back</span>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Keyframes */}
      <style>{`
        @keyframes obFadeUp {
          from { opacity: 0; transform: translateY(16px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes obSpin {
          from { transform: rotate(0deg); }
          to   { transform: rotate(360deg); }
        }
        @keyframes termRowIn {
          from { opacity: 0; transform: translateX(-6px); }
          to   { opacity: 1; transform: translateX(0); }
        }
        @keyframes termCheckIn {
          from { opacity: 0; transform: scale(0.6); }
          to   { opacity: 1; transform: scale(1); }
        }
        @keyframes termFadeIn {
          from { opacity: 0; }
          to   { opacity: 1; }
        }
        @keyframes progressSpin {
          from { transform: rotate(-90deg); }
          to   { transform: rotate(270deg); }
        }
        @keyframes pulse-ring {
          0%   { box-shadow: 0 0 0 0 rgba(232,255,107,0.4); }
          70%  { box-shadow: 0 0 0 5px rgba(232,255,107,0); }
          100% { box-shadow: 0 0 0 0 rgba(232,255,107,0); }
        }
        #ob-continue-btn {
          transition: background 0.15s, transform 0.08s cubic-bezier(0.34,1.56,0.64,1), box-shadow 0.15s;
        }
      `}</style>
    </div>
  )
}
