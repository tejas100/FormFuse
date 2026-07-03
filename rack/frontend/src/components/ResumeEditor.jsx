import { useState, useMemo, useCallback, useRef, useLayoutEffect } from 'react'

/**
 * ResumeEditor.jsx — two-column resume review UI (v4)
 *
 * Fixes from v3:
 *   1. Read mode is now a genuinely CLEAN rendered document — accept/reject
 *      controls used to live inline next to every highlighted phrase, which
 *      made the "finished" view look just as form-like as edit mode. They
 *      now live in a "Suggested changes" list in the left panel instead.
 *      The document itself only ever shows green highlights, nothing else.
 *   2. Edit mode now has a persistent (not just hover) soft tint on every
 *      editable field, so the two modes read as visually distinct at a
 *      glance, not just on hover/focus.
 *   3. Height is now bounded to the viewport via the parent (Dashboard
 *      passes a flex:1/minHeight:0 wrapper) — this component fills that
 *      with height:'100%' and ONLY the center document column scrolls
 *      (overflowY:auto + minHeight:0). Left panel never scrolls.
 *
 * CONTRACT unchanged (matches services/resume_optimizer.py):
 *   structuredDoc, patches[], requirementClassification[], matchScore
 *   onApprove({decisions, manualEdits}), onDownload({decisions, manualEdits})
 */

// ── Design tokens ─────────────────────────────────────────────────────────
const COLORS = {
  bg: '#ffffff', panelBg: '#faf9f6', pageBg: '#ffffff', border: '#e8e6e0',
  text: '#141414', textDim: '#8a8880', accent: '#c8e824', accentInk: '#5b6b00',
  addedBg: 'rgba(94,196,110,0.16)', addedText: '#1f7a34', rejectRed: '#c14545',
  ok: '#2f9e52', miss: '#b8b6ae', focus: '#7c6cf0', focusBg: 'rgba(124,108,240,0.055)',
  focusBgHover: 'rgba(124,108,240,0.10)', editBanner: '#eef0ff', editBannerText: '#4b46c9',
}
const FONT_DISPLAY = "'Syne', sans-serif"
const FONT_BODY    = "'DM Sans', sans-serif"
const FONT_MONO    = "'Fira Code', monospace"
// The RESUME DOCUMENT gets its own neutral, document-grade typeface — the brand
// fonts above (Syne / DM Sans / Fira Code) belong to the app chrome only, never
// inside the rendered page. This is what makes the page read as a real résumé.
const FONT_DOC     = "'Helvetica Neue', Helvetica, Arial, sans-serif"

const PAGE_WIDTH  = 680
const PAGE_HEIGHT = Math.round(PAGE_WIDTH * (11 / 8.5))   // 880, real US-Letter ratio
const PAD_X = 46                                          // page horizontal padding (matches printed margin)
const PAD_Y = 40                                          // page vertical padding
const CONTENT_W = PAGE_WIDTH - PAD_X * 2                  // 588 — usable text width per page
const USABLE_H  = PAGE_HEIGHT - PAD_Y * 2                 // 800 — usable text height per page
const PAGE_GAP  = 24                                      // visual gap between stacked pages
const FIT_FONT_FLOOR = 7                                  // smallest font "fit to 1 page" may shrink to

// Vertical spacing baked into each flow item as padding-bottom (so it's included
// when we measure the item's footprint — margins are NOT captured by getBoundingClientRect).
const GAP_SECTION   = 14   // after the last item of a section
const GAP_EXP       = 10   // between two experience/project entries
const GAP_HEADER    = 14   // after the name/contact block
const GAP_SEC_TITLE = 6    // after a section title, before its first item
const GAP_SUBHEAD   = 4    // after an experience/project header row, before its bullets
const GAP_BULLET    = 3    // between bullets / skill lines / edu rows

// ── Mock data ────────────────────────────────────────────────────────────
const MOCK_DOC = {
  header: {
    name: 'Tejas Belakavadi Kemparaju', location: 'East Newark, New Jersey, United States',
    email: 'tejas55bk@gmail.com', phone: '(862) 214-0129',
    linkedin: 'linkedin.com/in/tejasbk', github: 'github.com/tejas100', website: '',
  },
  summary: null,
  skills: [{ group_id: 'skills_ai_llm', group_label: 'AI / LLM', items: [
    { id: 'sk_1', text: 'RAG' }, { id: 'sk_2', text: 'LangChain' }, { id: 'sk_3', text: 'Hugging Face Transformers' },
  ]}],
  experience: [{ company_id: 'exp_uber', company: 'Uber', title: 'AI Engineer', dates: 'Aug 2025 - Present', bullets: [
    { id: 'b_uber_1', text: 'Designed and deployed agentic AI workflows using LangChain/OpenAI to automate support operations and telemetry analysis.' },
    { id: 'b_uber_2', text: 'Built Spark/PySpark pipelines for large-scale telemetry and behavioral signal processing.' },
  ]}],
  projects: [],
  education: [{ id: 'edu_1', school: 'New Jersey Institute of Technology \u2014 Master\u2019s, Computer Science', degree: '', dates: 'Sep 2023 - May 2025' }],
  certifications: [],
}
const MOCK_PATCHES = [
  { id: 'chg_0_b_uber_1', operation: 'insert_phrase', target_id: 'b_uber_1', position: 'after:LangChain/OpenAI', text: ' and Databricks',
    reason: 'Matches required platform skill.', requirement_id: 'databricks', confidence: 0.93 },
  { id: 'chg_1_skills_ai_llm', operation: 'replace_text', target_id: 'sk_1', before: 'RAG', after: 'Agentic Workflows, RAG',
    reason: 'Matches AI workflow requirement.', requirement_id: 'agentic_workflows', confidence: 0.97 },
]
const MOCK_REQUIRED  = [
  { text: 'Python', met: true }, { text: 'PySpark', met: true }, { text: 'Databricks', met: true },
  { text: 'ELT/ETL processes', met: true }, { text: 'FAST API', met: true }, { text: 'Microservices', met: true }, { text: 'Kafka', met: true },
]
const MOCK_PREFERRED = [
  { text: 'Cloudera', met: true }, { text: 'AWS', met: true }, { text: 'Azure', met: true }, { text: 'GCP', met: true }, { text: 'Angular', met: false },
]
const MOCK_SCORE = { percent: 92, label: 'Excellent Match' }
const STEPS = ['Optimize', 'Resume', 'Generate', 'Cover Letter', 'Submit', 'Done']

// ── Patch application ────────────────────────────────────────────────────
function applyPatchToText(currentText, patch) {
  if (patch.operation === 'replace_text') return currentText.replace(patch.before, patch.after)
  const position = patch.position || 'end'
  if (position.startsWith('after:')) {
    const anchor = position.slice(6)
    const idx = currentText.indexOf(anchor)
    if (idx === -1) return currentText + patch.text
    const insertAt = idx + anchor.length
    return currentText.slice(0, insertAt) + patch.text + currentText.slice(insertAt)
  }
  return currentText + patch.text
}
function applyAcceptedPatches(text, targetPatches, decisions) {
  let out = text
  for (const p of targetPatches) if (decisions[p.id] !== 'rejected') out = applyPatchToText(out, p)
  return out
}

// Read-mode document rendering: ONLY highlights, no controls. Clean, final.
function HighlightedSegments({ originalText, patchesForTarget, decisions }) {
  const accepted = patchesForTarget.filter(p => decisions[p.id] !== 'rejected')
  if (accepted.length === 0) return <span>{originalText}</span>
  let segments = [{ text: originalText, added: false }]
  for (const p of accepted) {
    const next = []
    for (const seg of segments) {
      if (seg.added) { next.push(seg); continue }
      if (p.operation === 'replace_text' && seg.text.includes(p.before)) {
        const idx = seg.text.indexOf(p.before)
        if (idx > 0) next.push({ text: seg.text.slice(0, idx), added: false })
        next.push({ text: p.after, added: true })
        if (idx + p.before.length < seg.text.length) next.push({ text: seg.text.slice(idx + p.before.length), added: false })
      } else if (p.operation === 'insert_phrase') {
        const anchor = p.position.startsWith('after:') ? p.position.slice(6) : null
        const idx = anchor ? seg.text.indexOf(anchor) : seg.text.length
        if (idx === -1) { next.push(seg); continue }
        const cut = anchor ? idx + anchor.length : seg.text.length
        next.push({ text: seg.text.slice(0, cut), added: false })
        next.push({ text: p.text, added: true })
        if (cut < seg.text.length) next.push({ text: seg.text.slice(cut), added: false })
      } else next.push(seg)
    }
    segments = next
  }
  return <>{segments.map((seg, i) => seg.added
    ? <span key={i} style={{ background: COLORS.addedBg, color: COLORS.addedText, borderRadius: 3, padding: '1px 3px', fontWeight: 600 }}>{seg.text}</span>
    : <span key={i}>{seg.text}</span>)}</>
}

function pillStyle(color) {
  return { fontFamily: FONT_MONO, fontSize: 10, color, background: 'transparent', border: `1px solid ${color}55`, borderRadius: 20, padding: '1px 8px', cursor: 'pointer', lineHeight: 1.6, flexShrink: 0 }
}

// Editable field — used for EVERY field once editing=true. Persistent tint
// (not just hover) so edit mode reads as visually distinct from read mode.
function EditableSpan({ text, onCommit, block = false }) {
  return (
    <span
      contentEditable suppressContentEditableWarning
      onBlur={e => onCommit(e.target.textContent)}
      onClick={e => e.stopPropagation()}
      className="rk-editable-field"
      style={{ display: block ? 'block' : 'inline', outline: 'none', borderRadius: 3, padding: 0, margin: 0, cursor: 'text' }}
    >{text}</span>
  )
}

// ── Left panel pieces ─────────────────────────────────────────────────────
function Stepper({ currentStep }) {
  const idx = STEPS.indexOf(currentStep)
  return (
    <div style={{ display: 'flex', alignItems: 'center', padding: '14px 18px', borderBottom: `1px solid ${COLORS.border}`, flexShrink: 0 }}>
      {STEPS.map((s, i) => (
        <div key={s} style={{ display: 'flex', alignItems: 'center', flex: i < STEPS.length - 1 ? 1 : 'none' }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5, minWidth: 30 }}>
            <div style={{
              width: 20, height: 20, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 9.5, fontFamily: FONT_MONO, fontWeight: 700,
              background: i < idx ? COLORS.text : i === idx ? COLORS.bg : 'transparent',
              color: i < idx ? '#fff' : i === idx ? COLORS.text : COLORS.textDim,
              border: i === idx ? `2px solid ${COLORS.text}` : i < idx ? 'none' : `1.5px solid ${COLORS.border}`,
            }}>{i < idx ? '\u2713' : i === idx ? '\u25CF' : ''}</div>
            <span style={{ fontSize: 8.5, fontFamily: FONT_MONO, color: i <= idx ? COLORS.text : COLORS.textDim, whiteSpace: 'nowrap' }}>{s}</span>
          </div>
          {i < STEPS.length - 1 && <div style={{ flex: 1, height: 1, background: i < idx ? COLORS.text : COLORS.border, marginBottom: 13 }} />}
        </div>
      ))}
    </div>
  )
}

function ScoreRing({ percent, label }) {
  const r = 28, c = 2 * Math.PI * r
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 18px', flexShrink: 0 }}>
      <svg width={66} height={66} viewBox="0 0 66 66">
        <circle cx={33} cy={33} r={r} fill="none" stroke={COLORS.border} strokeWidth={6} />
        <circle cx={33} cy={33} r={r} fill="none" stroke={COLORS.accentInk} strokeWidth={6}
          strokeDasharray={c} strokeDashoffset={c - (percent / 100) * c} strokeLinecap="round" transform="rotate(-90 33 33)" />
        <text x={33} y={38} textAnchor="middle" fontFamily={FONT_DISPLAY} fontWeight={700} fontSize={16} fill={COLORS.text}>{percent}%</text>
      </svg>
      <div style={{ fontSize: 13, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: COLORS.ok, flexShrink: 0 }} />{label}
      </div>
    </div>
  )
}

function SkillChecklist({ title, items }) {
  const metCount = items.filter(i => i.met).length
  return (
    <div style={{ padding: '0 18px 14px', flexShrink: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 7 }}>
        <span style={{ fontFamily: FONT_MONO, fontSize: 10, letterSpacing: '0.06em', textTransform: 'uppercase', color: COLORS.textDim }}>{title}</span>
        <span style={{ fontFamily: FONT_MONO, fontSize: 10.5, color: COLORS.textDim }}>{metCount}/{items.length}</span>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
        {items.map((s, i) => (
          <span key={i} style={{
            display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, padding: '4px 9px', borderRadius: 20,
            background: s.met ? COLORS.addedBg : COLORS.panelBg, color: s.met ? COLORS.addedText : COLORS.miss,
            border: `1px solid ${s.met ? 'transparent' : COLORS.border}`,
          }}><span style={{ fontSize: 9.5 }}>{s.met ? '\u2713' : '\u2715'}</span>{s.text}</span>
        ))}
      </div>
    </div>
  )
}

// Patch review — lives in the left panel, NOT inline in the document, so the
// document itself always renders as a clean finished resume.
function SuggestedChanges({ patches, decisions, onAccept, onReject }) {
  if (!patches.length) return null
  const appliedCount = patches.filter(p => decisions[p.id] !== 'rejected').length
  return (
    <div style={{ padding: '0 18px 14px', flexShrink: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 7 }}>
        <span style={{ fontFamily: FONT_MONO, fontSize: 10, letterSpacing: '0.06em', textTransform: 'uppercase', color: COLORS.textDim }}>Suggested changes</span>
        <span style={{ fontFamily: FONT_MONO, fontSize: 10.5, color: COLORS.textDim }}>{appliedCount}/{patches.length} applied</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 168, overflowY: 'auto' }}>
        {patches.map(p => {
          const rejected = decisions[p.id] === 'rejected'
          const shownText = p.operation === 'replace_text' ? p.after : p.text.trim()
          return (
            <div key={p.id} style={{ border: `1px solid ${COLORS.border}`, borderRadius: 9, padding: '7px 9px', background: rejected ? 'transparent' : COLORS.bg }}>
              <div style={{ fontSize: 11, color: rejected ? COLORS.textDim : COLORS.text, textDecoration: rejected ? 'line-through' : 'none', marginBottom: 5 }}>
                {shownText}
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 9, color: COLORS.textDim, fontFamily: FONT_MONO }}>{p.requirement_id}</span>
                <button onClick={() => rejected ? onAccept(p.id) : onReject(p.id)} style={pillStyle(rejected ? COLORS.addedText : COLORS.rejectRed)}>
                  {rejected ? 'Restore' : 'Reject'}
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Right: floating vertical toolbar ────────────────────────────────────────
function DocToolbar({ fontSize, effFont, setFontSize, fitToPage, setFitToPage, align, setAlign, editing, onEditToggle }) {
  const btn = (active, disabled) => ({
    width: 30, height: 30, borderRadius: 8, border: `1px solid ${active ? COLORS.text : COLORS.border}`,
    background: active ? COLORS.text : 'transparent', color: active ? '#fff' : COLORS.text,
    fontFamily: FONT_MONO, fontSize: 11, cursor: disabled ? 'not-allowed' : 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: disabled ? 0.4 : 1,
  })
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, padding: '16px 10px', background: COLORS.panelBg, borderLeft: `1px solid ${COLORS.border}`, width: 56, flexShrink: 0 }}>
      <Label>FONT</Label>
      <button style={btn(false)} onClick={() => setFontSize(f => Math.min(f + 0.5, 17))}>A+</button>
      <span style={{ fontFamily: FONT_MONO, fontSize: 10, color: COLORS.textDim }}>{(fitToPage ? effFont : fontSize).toFixed(1)}</span>
      <button style={btn(false)} onClick={() => setFontSize(f => Math.max(f - 0.5, 10))}>A-</button>
      <Divider />
      <Label>FIT</Label>
      <button style={{ ...btn(fitToPage), fontSize: 9.5 }} onClick={() => setFitToPage(f => !f)} title="Shrink content to fit one page">1pg</button>
      <Divider />
      <Label>ALIGN</Label>
      <button style={btn(align === 'justify')} onClick={() => setAlign(a => a === 'justify' ? 'left' : 'justify')} title="Justify text">
        <svg width={13} height={13} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M2 3h12M2 7h12M2 11h12M2 15h8" /></svg>
      </button>
      <Divider />
      <Label>EDIT</Label>
      <button style={btn(editing)} onClick={onEditToggle} title="Edit text directly">
        <svg width={13} height={13} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M11 2l3 3-8 8-3.5 1 1-3.5 8-8z" /></svg>
      </button>
    </div>
  )
}
function Label({ children }) { return <span style={{ fontFamily: FONT_MONO, fontSize: 8.5, letterSpacing: '0.08em', color: COLORS.textDim }}>{children}</span> }
function Divider() { return <div style={{ width: 26, height: 1, background: COLORS.border }} /> }

// ── Main component ───────────────────────────────────────────────────────
export default function ResumeEditor({
  applyJobId = null, initialDoc = null, initialPatches = null, requirementClassification = null,
  matchScore = null, currentStep = 'Resume', onApprove = null, onDownload = null, onDecisionChange = null,
}) {
  const doc     = initialDoc || MOCK_DOC
  const patches = initialPatches || MOCK_PATCHES
  const score   = matchScore || MOCK_SCORE

  const classification = requirementClassification || []
  const required  = classification.length
    ? classification.filter(c => c.importance === 'required').map(c => ({ text: c.requirement, met: c.classification !== 'absent' }))
    : MOCK_REQUIRED
  const preferred = classification.length
    ? classification.filter(c => c.importance === 'preferred').map(c => ({ text: c.requirement, met: c.classification !== 'absent' }))
    : MOCK_PREFERRED

  const [decisions, setDecisions]     = useState(() => Object.fromEntries(patches.map(p => [p.id, 'accepted'])))
  const [manualEdits, setManualEdits] = useState({})
  const [editSnapshot, setEditSnapshot] = useState(null)
  const [approving, setApproving]     = useState(false)
  const [feedback, setFeedback]       = useState(null)
  const [fontSize, setFontSize]       = useState(11)
  const [align, setAlign]             = useState('left')
  const [editing, setEditing]         = useState(false)
  const [fitToPage, setFitToPage]     = useState(false)
  const [pages, setPages]             = useState(null)   // read-mode pagination: array of flow-item index arrays
  const [effFont, setEffFont]         = useState(11)     // effective font (fitToPage may shrink below fontSize)

  const measureRef = useRef(null)                        // hidden off-screen measurer

  const patchesByTarget = useMemo(() => {
    const map = {}
    for (const p of patches) (map[p.target_id] ||= []).push(p)
    return map
  }, [patches])

  const setDecision = useCallback((patchId, value) => {
    setDecisions(prev => { const next = { ...prev, [patchId]: value }; onDecisionChange?.(patchId, value); return next })
  }, [onDecisionChange])

  // ── Measurement-based pagination ─────────────────────────────────────────
  // Read mode renders as a stack of real US-Letter pages. We measure every flow
  // item off-screen at the true content width, then greedily pack items into
  // pages of USABLE_H. "Fit to 1 page" honestly shrinks the font (real reflow)
  // rather than visually scaling — so text re-wraps and fills the page width.
  useLayoutEffect(() => {
    if (editing) { setPages(null); setEffFont(fontSize); return }

    const run = () => {
      const container = measureRef.current
      if (!container) return
      const kids = () => Array.from(container.children)
      const totalAt = (f) => {
        container.style.fontSize = f + 'px'
        void container.offsetHeight   // force reflow
        return kids().reduce((sum, el) => sum + el.getBoundingClientRect().height, 0)
      }

      // 1. Decide the effective font.
      let eff = fontSize
      if (fitToPage) {
        if (totalAt(fontSize) <= USABLE_H) {
          eff = fontSize
        } else {
          let lo = FIT_FONT_FLOOR, hi = fontSize, best = FIT_FONT_FLOOR
          for (let i = 0; i < 14; i++) {
            const mid = (lo + hi) / 2
            if (totalAt(mid) <= USABLE_H) { best = mid; lo = mid } else { hi = mid }
          }
          eff = Math.max(FIT_FONT_FLOOR, Math.floor(best * 2) / 2)   // snap to 0.5px
        }
      }

      // 2. Measure each item's footprint at the effective font, then pack.
      container.style.fontSize = eff + 'px'
      void container.offsetHeight
      const heights = kids().map(el => el.getBoundingClientRect().height)

      const result = []
      let cur = [], used = 0
      for (let i = 0; i < heights.length; i++) {
        const h = heights[i]
        if (used + h > USABLE_H && cur.length > 0) { result.push(cur); cur = []; used = 0 }
        cur.push(i); used += h
      }
      if (cur.length) result.push(cur)

      // 3. Push orphaned headers (a section/sub header stranded at a page bottom)
      //    onto the next page so a heading never dangles with no content under it.
      for (let p = 0; p < result.length - 1; p++) {
        const page = result[p]
        while (page.length) {
          const t = flowItems[page[page.length - 1]]?.type
          if (t === 'section-header' || t === 'sub-header') result[p + 1].unshift(page.pop())
          else break
        }
      }
      const packed = result.filter(pg => pg.length)

      container.style.fontSize = fontSize + 'px'   // restore for next render
      setEffFont(eff)
      setPages(packed.length ? packed : [heights.map((_, i) => i)])
    }

    if (document.fonts && document.fonts.status !== 'loaded') {
      document.fonts.ready.then(run).catch(run)
    } else run()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, fontSize, align, fitToPage, decisions, manualEdits, doc, patches])

  const fieldText = (key, fallback) => manualEdits[key] !== undefined ? manualEdits[key] : fallback

  // Read mode: clean highlights only, no controls. Edit mode: contentEditable.
  const renderTarget = (id, originalText) => {
    const targetPatches = patchesByTarget[id] || []
    const baseline = applyAcceptedPatches(originalText, targetPatches, decisions)
    if (editing) {
      const current = fieldText(id, baseline)
      return <EditableSpan text={current} onCommit={t => setManualEdits(m => ({ ...m, [id]: t }))} />
    }
    if (manualEdits[id] !== undefined) return <span>{manualEdits[id]}</span>
    return <HighlightedSegments originalText={originalText} patchesForTarget={targetPatches} decisions={decisions} />
  }
  const renderField = (key, fallback) => {
    const current = fieldText(key, fallback)
    return editing ? <EditableSpan text={current} onCommit={t => setManualEdits(m => ({ ...m, [key]: t }))} /> : current
  }

  const enterEditMode = () => { setEditSnapshot(manualEdits); setEditing(true) }
  const handleSave    = () => { setEditSnapshot(null); setEditing(false) }
  const handleCancel  = () => { setManualEdits(editSnapshot || {}); setEditSnapshot(null); setEditing(false) }
  const handleToolbarEditToggle = () => { editing ? handleSave() : enterEditMode() }

  const handleApprove = async () => { setApproving(true); try { await onApprove?.({ decisions, manualEdits }) } finally { setApproving(false) } }
  const handleDownload = async () => { await onDownload?.({ decisions, manualEdits }) }

  const headerName      = renderField('header:name', doc.header.name)
  const headerFieldKeys = ['location', 'email', 'phone', 'linkedin', 'github'].filter(f => doc.header[f])

  // Flatten the document into an ordered list of atomic, individually-measurable
  // flow items. Spacing is expressed as padding-bottom (`gap`) so it's captured
  // when we measure each item's height. Font sizes use `em` so they scale with
  // the page's effective font (important for "fit to 1 page").
  const flowItems = (() => {
    const out = []
    const push = (id, type, node, gap) => out.push({ id, type, node, gap })
    const endSection = () => { if (out.length) out[out.length - 1].gap = GAP_SECTION }
    const sectionTitle = (title) => (
      <div style={{ fontWeight: 700, letterSpacing: '0.03em', textTransform: 'uppercase',
        color: COLORS.text, borderBottom: `1px solid ${COLORS.text}`, paddingBottom: 3 }}>{title}</div>
    )
    const bulletRow = (id, text) => (
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 7, paddingLeft: 3 }}>
        <span style={{ flexShrink: 0, lineHeight: 1.34 }}>{'\u2022'}</span>
        <div style={{ flex: 1, lineHeight: 1.34 }}>{renderTarget(id, text)}</div>
      </div>
    )

    // Header (name + contact line)
    push('__header', 'header', (
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontWeight: 700, fontSize: '1.95em', letterSpacing: '-0.01em', lineHeight: 1.14 }}>{headerName}</div>
        <div style={{ color: COLORS.textDim, fontSize: '0.88em', marginTop: 3, lineHeight: 1.4 }}>
          {headerFieldKeys.map((f, i) => (
            <span key={f}>{renderField(`header:${f}`, doc.header[f])}{i < headerFieldKeys.length - 1 ? '  |  ' : ''}</span>
          ))}
        </div>
      </div>
    ), GAP_HEADER)

    // Summary
    if (doc.summary) {
      push('__sec_summary', 'section-header', sectionTitle('Summary'), GAP_SEC_TITLE)
      push(doc.summary.id, 'body', <div>{renderTarget(doc.summary.id, doc.summary.text)}</div>, GAP_BULLET)
      endSection()
    }

    // Skills
    if (doc.skills && doc.skills.length > 0) {
      push('__sec_skills', 'section-header', sectionTitle('Skills'), GAP_SEC_TITLE)
      doc.skills.forEach(g => push(g.group_id, 'body', (
        <div><strong>{g.group_label}: </strong>
          {g.items.map((item, i) => (
            <span key={item.id}>{renderTarget(item.id, item.text)}{i < g.items.length - 1 ? ', ' : ''}</span>
          ))}
        </div>
      ), GAP_BULLET))
      endSection()
    }

    // Work Experience
    if (doc.experience && doc.experience.length > 0) {
      push('__sec_exp', 'section-header', sectionTitle('Work Experience'), GAP_SEC_TITLE)
      doc.experience.forEach(exp => {
        push(`${exp.company_id}__h`, 'sub-header', (
          <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700 }}>
            <span>
              {renderField(`exp:${exp.company_id}:company`, exp.company)}
              {exp.title && <> {'|'} {renderField(`exp:${exp.company_id}:title`, exp.title)}</>}
            </span>
            <span style={{ color: COLORS.textDim, fontWeight: 400, fontSize: '0.9em' }}>
              {renderField(`exp:${exp.company_id}:dates`, exp.dates)}
            </span>
          </div>
        ), GAP_SUBHEAD)
        exp.bullets.forEach((b, bi) =>
          push(b.id, 'bullet', bulletRow(b.id, b.text), bi === exp.bullets.length - 1 ? GAP_EXP : GAP_BULLET))
      })
      endSection()
    }

    // Projects
    if (doc.projects && doc.projects.length > 0) {
      push('__sec_proj', 'section-header', sectionTitle('Projects'), GAP_SEC_TITLE)
      doc.projects.forEach(p => {
        const pid = p.project_id || p.id
        const pname = p.name || p.title || ''
        const psub = p.subtitle || p.tech || ''
        const bullets = p.bullets || []
        push(`${pid}__h`, 'sub-header', (
          <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700 }}>
            <span>
              {renderField(`proj:${pid}:name`, pname)}
              {psub && <span style={{ fontWeight: 400, color: COLORS.textDim }}> {'\u2014'} {renderField(`proj:${pid}:subtitle`, psub)}</span>}
            </span>
            {p.dates && <span style={{ color: COLORS.textDim, fontWeight: 400, fontSize: '0.9em' }}>{renderField(`proj:${pid}:dates`, p.dates)}</span>}
          </div>
        ), GAP_SUBHEAD)
        bullets.forEach((b, bi) =>
          push(b.id, 'bullet', bulletRow(b.id, b.text), bi === bullets.length - 1 ? GAP_EXP : GAP_BULLET))
      })
      endSection()
    }

    // Education
    if (doc.education && doc.education.length > 0) {
      push('__sec_edu', 'section-header', sectionTitle('Education'), GAP_SEC_TITLE)
      doc.education.forEach(e => push(e.id, 'body', (
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span>{renderField(`edu:${e.id}:school`, e.school)}</span>
          <span style={{ color: COLORS.textDim, fontSize: '0.9em' }}>{renderField(`edu:${e.id}:dates`, e.dates)}</span>
        </div>
      ), GAP_BULLET))
      endSection()
    }

    if (out.length) out[out.length - 1].gap = 0   // no trailing gap on the very last item
    return out
  })()

  // Guard page indices against a doc that changed since the last measure.
  const safePages = pages
    ? pages.map(pg => pg.filter(i => i < flowItems.length)).filter(pg => pg.length)
    : null

  return (
    <div style={{ display: 'flex', fontFamily: FONT_BODY, background: COLORS.bg, color: COLORS.text, border: `1px solid ${COLORS.border}`, borderRadius: 16, overflow: 'hidden', height: '100%', minHeight: 0 }}>
      <style>{`
        .rk-editable-field { background: ${COLORS.focusBg}; box-shadow: inset 0 0 0 1px rgba(124,108,240,0.16); border-radius: 3px; transition: background 0.12s, box-shadow 0.12s; }
        .rk-editable-field:hover { background: ${COLORS.focusBgHover}; }
        .rk-editable-field:focus { background: #fff; box-shadow: 0 0 0 2px ${COLORS.focus}; outline: none; }
      `}</style>

      {/* ── LEFT (never scrolls) ── */}
      <div style={{ width: 320, flexShrink: 0, background: COLORS.panelBg, borderRight: `1px solid ${COLORS.border}`, display: 'flex', flexDirection: 'column', overflowY: 'auto' }}>
        <Stepper currentStep={currentStep} />

        <div style={{ display: 'flex', gap: 6, padding: '12px 18px 0', flexShrink: 0 }}>
          {['Resume', 'Cover letter', 'JD'].map(t => (
            <button key={t} disabled={t !== 'Resume'} style={{
              fontFamily: FONT_MONO, fontSize: 10.5, padding: '6px 11px', borderRadius: 9,
              border: `1px solid ${t === 'Resume' ? COLORS.text : COLORS.border}`,
              background: t === 'Resume' ? COLORS.bg : 'transparent', color: t === 'Resume' ? COLORS.text : COLORS.textDim,
              cursor: t === 'Resume' ? 'pointer' : 'not-allowed', opacity: t === 'Resume' ? 1 : 0.6,
            }}>{t}</button>
          ))}
        </div>

        <ScoreRing percent={score.percent} label={score.label} />
        <div style={{ padding: '0 18px 12px', fontFamily: FONT_MONO, fontSize: 10.5, color: COLORS.textDim, flexShrink: 0 }}>
          {required.filter(r => r.met).length} of {required.length + preferred.length} keywords matched
        </div>
        <SkillChecklist title="Required skills" items={required} />
        <SkillChecklist title="Preferred skills" items={preferred} />
        {!editing && <SuggestedChanges patches={patches} decisions={decisions}
          onAccept={pid => setDecision(pid, 'accepted')} onReject={pid => setDecision(pid, 'rejected')} />}

        <div style={{ flex: 1 }} />

        <div style={{ padding: '12px 18px', borderTop: `1px solid ${COLORS.border}`, flexShrink: 0 }}>
          {editing ? (
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={handleCancel} style={secondaryBtn(false)}>Cancel</button>
              <button onClick={handleSave} style={secondaryBtn(true)}>Save</button>
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                <span style={{ fontFamily: FONT_MONO, fontSize: 10.5, color: COLORS.textDim }}>How's this resume?</span>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button onClick={() => setFeedback('up')} style={feedbackBtn(feedback === 'up')}>{'\u{1F44D}'}</button>
                  <button onClick={() => setFeedback('down')} style={feedbackBtn(feedback === 'down')}>{'\u{1F44E}'}</button>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                <button onClick={enterEditMode} style={secondaryBtn(false)}>Edit</button>
                <button onClick={handleDownload} style={secondaryBtn(false)}>Download</button>
              </div>
              <button onClick={handleApprove} disabled={approving} style={{
                width: '100%', fontFamily: FONT_DISPLAY, fontWeight: 700, fontSize: 13,
                background: COLORS.accent, color: '#141414', border: 'none', borderRadius: 10,
                padding: '11px 0', cursor: approving ? 'default' : 'pointer', opacity: approving ? 0.6 : 1,
              }}>{approving ? 'Approving\u2026' : 'Approve Resume'}</button>
            </>
          )}
        </div>
      </div>

      {/* ── CENTER: document — the ONLY scrolling region ── */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', background: '#f0efe9', display: 'flex', flexDirection: 'column' }}>
        {editing && (
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '9px 28px',
            background: COLORS.editBanner, color: COLORS.editBannerText, borderBottom: `1px solid ${COLORS.border}`,
            fontFamily: FONT_MONO, fontSize: 11.5, flexShrink: 0, position: 'sticky', top: 0, zIndex: 2,
          }}>
            <span>{'\u270F\uFE0F Editing Mode'}</span>
            <span style={{ opacity: 0.75 }}>Click any field to edit</span>
          </div>
        )}
        {/* Off-screen measurer — one wrapper per flow item, at true content width. */}
        {!editing && (
          <div ref={measureRef} aria-hidden style={{
            position: 'absolute', left: -99999, top: 0, visibility: 'hidden', pointerEvents: 'none',
            width: CONTENT_W, fontFamily: FONT_DOC, fontSize, lineHeight: 1.34, textAlign: align, color: COLORS.text,
          }}>
            {flowItems.map(it => (
              <div key={it.id} style={{ paddingBottom: it.gap }}>{it.node}</div>
            ))}
          </div>
        )}

        {editing ? (
          // Edit mode: a single continuous page (grows with content) so caret
          // never jumps from a mid-edit re-pagination.
          <div style={{ padding: PAGE_GAP, display: 'flex', justifyContent: 'center' }}>
            <div style={{
              width: '100%', maxWidth: PAGE_WIDTH, minHeight: PAGE_HEIGHT, flexShrink: 0,
              background: COLORS.pageBg, borderRadius: 4,
              boxShadow: '0 1px 3px rgba(0,0,0,0.08), 0 8px 24px rgba(0,0,0,0.06)',
              padding: `${PAD_Y}px ${PAD_X}px`, fontFamily: FONT_DOC, fontSize, lineHeight: 1.34,
              textAlign: align, color: COLORS.text,
            }}>
              {flowItems.map(it => <div key={it.id} style={{ paddingBottom: it.gap }}>{it.node}</div>)}
            </div>
          </div>
        ) : (
          // Read mode: a stack of real US-Letter pages.
          <div style={{ padding: PAGE_GAP, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: PAGE_GAP }}>
            {(safePages || [flowItems.map((_, i) => i)]).map((idxs, pi) => (
              <div key={pi} style={{
                width: '100%', maxWidth: PAGE_WIDTH, height: PAGE_HEIGHT, flexShrink: 0, overflow: 'hidden',
                background: COLORS.pageBg, borderRadius: 4,
                boxShadow: '0 1px 3px rgba(0,0,0,0.08), 0 8px 24px rgba(0,0,0,0.06)',
                padding: `${PAD_Y}px ${PAD_X}px`, fontFamily: FONT_DOC, fontSize: effFont, lineHeight: 1.34,
                textAlign: align, color: COLORS.text,
              }}>
                {idxs.map(i => flowItems[i] && (
                  <div key={flowItems[i].id} style={{ paddingBottom: flowItems[i].gap }}>{flowItems[i].node}</div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── RIGHT: toolbar ── */}
      <DocToolbar fontSize={fontSize} effFont={effFont} setFontSize={setFontSize} fitToPage={fitToPage} setFitToPage={setFitToPage}
        align={align} setAlign={setAlign} editing={editing} onEditToggle={handleToolbarEditToggle} />
    </div>
  )
}

function feedbackBtn(active) {
  return { width: 26, height: 26, borderRadius: 7, border: `1px solid ${active ? COLORS.text : COLORS.border}`, background: active ? COLORS.panelBg : 'transparent', cursor: 'pointer', fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'center' }
}
function secondaryBtn(primary) {
  return { flex: 1, fontFamily: FONT_MONO, fontSize: 11.5, padding: '9px 0', borderRadius: 9, border: `1px solid ${COLORS.text}`, background: primary ? COLORS.text : 'transparent', color: primary ? '#fff' : COLORS.text, cursor: 'pointer' }
}