/**
 * ApplicationBoard.jsx — RACK paper / chalkboard Kanban
 * -----------------------------------------------------------------------------
 * A workshop-wall style board for tracking job applications across four stages.
 * Cards are "pinned" (tilted + taped), scribbled marker notes attach to any card,
 * and moving a card peels it off the board → opens a slot → settles with a wobble.
 *
 * INTEGRATION (wired into RACK)
 * -----------------------------
 * - Mounted by App.jsx when active === 'TrackApps' (the sidebar "Tracking" item).
 * - Lives in the shared Sidebar shell — `position: fixed; inset:0; display:flex`.
 * - Theme comes from useTheme() (global), auth from useAuth(); the header toggle
 *   flips the whole app theme, same as Dashboard.
 * - The two ".rkkb[data-theme=...]" token blocks in BOARD_CSS are kept on purpose:
 *   they are scoped to .rkkb and driven by the global theme, so the board stays
 *   self-contained (paper/chalk/ink tokens aren't in globals.css). Safe to keep.
 *
 * TODO for live data: replace SEED with `auto/refresh` + `GET /api/tracking` data
 * keyed by stage, and persist moves (moveJob / advance) via PATCH /api/tracking/{id}
 * { status }. Job shape: { id, job_title, company, location, score, posted_at,
 *   source, matched_skills[], url, notes[] }.
 */

import { useState, useRef, useEffect, useCallback } from 'react'
import Sidebar from '../components/Sidebar'
import { useAuth } from '../context/AuthContext'
import { useTheme } from '../App'

/* ─────────────────────────── stage model ─────────────────────────── */
const STAGES = [
  { id: 'applied',   label: 'Applied',                    hint: 'Submitted',      tone: 'kraft'  },
  { id: 'screen',    label: 'First round screening call', hint: 'Recruiter chat', tone: 'blue'   },
  { id: 'interview', label: 'Interviewing',               hint: 'In the loop',    tone: 'amber'  },
  { id: 'selected',  label: 'Selected',                   hint: 'Offer',          tone: 'win'    },
]
const STAGE_IDS = STAGES.map(s => s.id)

const INK = ['amber', 'blue', 'red', 'green', 'violet']  // marker colours, cycles in order

/* ─────────────────────────── seed data ─────────────────────────── */
const SEED = {
  applied: [
    { id: 'j1', job_title: 'Senior Frontend Engineer', company: 'Vercel', location: 'Remote · US',
      score: 91, posted_at: '2026-06-18', source: 'greenhouse', matched_skills: ['React', 'TypeScript', 'Edge'],
      notes: [{ id: 'n1', text: 'Referral from Sara ★', color: 'amber' }] },
    { id: 'j2', job_title: 'Product Engineer', company: 'Mercury', location: 'San Francisco',
      score: 78, posted_at: '2026-06-20', source: 'ashby', matched_skills: ['React', 'Postgres'], notes: [] },
    { id: 'j3', job_title: 'Full-Stack Engineer', company: 'Airtable', location: 'Remote · US',
      score: 66, posted_at: '2026-06-22', source: 'greenhouse', matched_skills: ['Node', 'React'], notes: [] },
  ],
  screen: [
    { id: 'j4', job_title: 'Software Engineer, Growth', company: 'Brex', location: 'New York',
      score: 84, posted_at: '2026-06-14', source: 'lever', matched_skills: ['React', 'A/B'],
      notes: [{ id: 'n2', text: 'Recruiter replied — fast!', color: 'green' }] },
    { id: 'j5', job_title: 'Frontend Engineer', company: 'Twilio', location: 'Remote · US',
      score: 72, posted_at: '2026-06-12', source: 'greenhouse', matched_skills: ['JS', 'CSS'], notes: [] },
  ],
  interview: [
    { id: 'j6', job_title: 'Senior SWE, Platform', company: 'Datadog', location: 'Boston',
      score: 88, posted_at: '2026-06-08', source: 'greenhouse', matched_skills: ['Go', 'K8s', 'React'],
      notes: [{ id: 'n3', text: 'Prep system design', color: 'red' }, { id: 'n4', text: 'Onsite 3rd', color: 'blue' }] },
  ],
  selected: [
    { id: 'j7', job_title: 'Founding Engineer', company: 'Anthropic', location: 'San Francisco',
      score: 95, posted_at: '2026-06-02', source: 'greenhouse', matched_skills: ['React', 'Python', 'LLMs'],
      notes: [{ id: 'n5', text: 'Said yes!! ✦', color: 'green' }] },
  ],
}

/* ─────────────────────────── helpers ─────────────────────────── */
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
// deterministic small tilt per card so the wall looks hand-stuck (not random each render)
function tiltFor(id) {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0
  return (((h % 100) / 100) * 4.4 - 2.2) // -2.2°..+2.2°
}
function fmtDate(iso) {
  try {
    const d = new Date(iso)
    return d.toLocaleDateString(undefined, { weekday: 'short', day: '2-digit', month: 'short' })
  } catch { return iso }
}
function daysAgo(iso) {
  const ms = Date.now() - new Date(iso).getTime()
  const d = Math.round(ms / 86400000)
  return d <= 0 ? 'today' : d === 1 ? '1d ago' : `${d}d ago`
}
function brand(company) {
  let h = 0
  for (let i = 0; i < company.length; i++) h = company.charCodeAt(i) + ((h << 5) - h)
  return `hsl(${h % 360} 52% 58%)`
}

/* ─────────────────────────── icons ─────────────────────────── */
const I = {
  clock: <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><circle cx="8" cy="8" r="6.2" /><path d="M8 4.6V8l2.4 1.6" /></svg>,
  plus:  <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round"><path d="M8 3v10M3 8h10" /></svg>,
  close: <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M4 4l8 8M12 4l-8 8" /></svg>,
  right: <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 4l4 4-4 4" /></svg>,
  left:  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 4L6 8l4 4" /></svg>,
  star:  <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1.6l1.8 4.1 4.5.4-3.4 3 1 4.4L8 11.2 4.1 13.5l1-4.4-3.4-3 4.5-.4z" /></svg>,
  grip:  <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" opacity="0.9"><circle cx="5" cy="4" r="1.15" /><circle cx="11" cy="4" r="1.15" /><circle cx="5" cy="8" r="1.15" /><circle cx="11" cy="8" r="1.15" /><circle cx="5" cy="12" r="1.15" /><circle cx="11" cy="12" r="1.15" /></svg>,
}

/* ─────────────────────────── scribble note ─────────────────────────── */
function Note({ note, editing, onEdit, onCommit, onRecolor, onDelete }) {
  const ref = useRef(null)
  useEffect(() => { if (editing && ref.current) { ref.current.focus(); ref.current.select?.() } }, [editing])
  const rot = tiltFor(note.id) * 1.4
  return (
    <span className="rkkb-note" data-ink={note.color} style={{ transform: `rotate(${rot}deg)` }}>
      <span className="rkkb-note-tape" />
      {editing ? (
        <input
          ref={ref}
          className="rkkb-note-input"
          value={note.text}
          placeholder="scribble…"
          onChange={e => onEdit(e.target.value)}
          onBlur={onCommit}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); onCommit() } if (e.key === 'Escape') onCommit() }}
        />
      ) : (
        <span className="rkkb-note-text">{note.text}</span>
      )}
      {!editing && (
        <span className="rkkb-note-tools">
          <button title="Recolour" onClick={onRecolor} className="rkkb-note-dot" />
          <button title="Remove note" onClick={onDelete} className="rkkb-note-x">{I.close}</button>
        </span>
      )}
    </span>
  )
}

/* ─────────────────────────── job card ─────────────────────────── */
function JobCard({
  job, colIndex, floating, dragging, landed, reduced,
  onPointerDown, onAddNote, onEditNote, onCommitNote, onRecolorNote, onDeleteNote, editingNote,
  onAdvance, onRetreat,
}) {
  const tilt = floating ? 0 : tiltFor(job.id)
  const tier = job.score >= 85 ? 'strong' : job.score >= 70 ? 'good' : job.score >= 55 ? 'mid' : 'weak'
  return (
    <article
      data-job={job.id}
      className={[
        'rkkb-card',
        floating ? 'is-floating' : '',
        dragging ? 'is-source' : '',
        landed ? 'is-landed' : '',
      ].join(' ')}
      style={{ ['--tilt']: `${tilt}deg` }}
      onPointerDown={floating ? undefined : onPointerDown}
    >
      <span className="rkkb-tape-strip" aria-hidden />
      <div className="rkkb-card-head">
        <span className="rkkb-logo" style={{ background: brand(job.company) }}>
          {job.company[0]}
        </span>
        <div className="rkkb-titles">
          <h3 title={job.job_title}>{job.job_title}</h3>
          <div className="rkkb-sub">{job.company} · {job.location}</div>
        </div>
        <span className="rkkb-grip" aria-hidden>{I.grip}</span>
      </div>

      <div className="rkkb-meta">
        <span className="rkkb-date">{I.clock}{fmtDate(job.posted_at)}</span>
        <span className={`rkkb-score t-${tier}`}>{Math.round(job.score)}<span>% fit</span></span>
      </div>

      {job.matched_skills?.length > 0 && (
        <div className="rkkb-skills">
          {job.matched_skills.slice(0, 4).map((s, i) => <span key={i} className="rkkb-skill">{s}</span>)}
        </div>
      )}

      {(job.notes?.length > 0) && (
        <div className="rkkb-notes">
          {job.notes.map(n => (
            <Note
              key={n.id}
              note={n}
              editing={editingNote === n.id}
              onEdit={txt => onEditNote(job.id, n.id, txt)}
              onCommit={() => onCommitNote(job.id, n.id)}
              onRecolor={() => onRecolorNote(job.id, n.id)}
              onDelete={() => onDeleteNote(job.id, n.id)}
            />
          ))}
        </div>
      )}

      <footer className="rkkb-foot">
        <button className="rkkb-addnote" onClick={() => onAddNote(job.id)}>{I.plus} note</button>
        <div className="rkkb-move">
          <button className="rkkb-mv" disabled={colIndex === 0} title="Move back a stage" onClick={() => onRetreat(job.id)}>{I.left}</button>
          <button className="rkkb-mv fwd" disabled={colIndex === STAGES.length - 1} title="Advance a stage" onClick={() => onAdvance(job.id)}>{I.right}</button>
        </div>
      </footer>
    </article>
  )
}

/* ─────────────────────────── column ─────────────────────────── */
function Column({ stage, index, jobs, colRef, isHover, hoverIndex, slotH, children }) {
  return (
    <section className={`rkkb-col tone-${stage.tone} ${isHover ? 'is-target' : ''}`} ref={colRef} data-col={stage.id}>
      <header className="rkkb-tape">
        <span className="rkkb-tape-label">
          {stage.label}{stage.tone === 'win' && <span className="rkkb-tape-star">{I.star}</span>}
        </span>
        <span className="rkkb-count">{jobs.length}</span>
        <span className="rkkb-tape-hint">{stage.hint}</span>
      </header>
      <div className="rkkb-stack">
        {jobs.map((node, i) => (
          <div key={node.key} className="rkkb-slot-wrap">
            {isHover && hoverIndex === i && <div className="rkkb-slot" style={{ height: slotH }} />}
            {node.el}
          </div>
        ))}
        {isHover && hoverIndex >= jobs.length && <div className="rkkb-slot" style={{ height: slotH }} />}
        {jobs.length === 0 && !isHover && (
          <div className="rkkb-empty">nothing here yet</div>
        )}
        {children}
      </div>
    </section>
  )
}

/* ─────────────────────────── board ─────────────────────────── */
export default function ApplicationBoard({ onNavigate }) {
  const { theme } = useTheme()
  const { user } = useAuth()
  const [cols, setCols] = useState(SEED)
  const [drag, setDrag] = useState(null)        // { jobId, fromCol, w, h, offX, offY, job }
  const [hover, setHover] = useState(null)       // { col, index }
  const [landed, setLanded] = useState(null)     // jobId that just settled
  const [editingNote, setEditingNote] = useState(null)

  const floatRef = useRef(null)
  const colNodes = useRef({})
  const raf = useRef(0)
  const last = useRef({ x: 0, t: 0, tilt: 0 })
  const ev = useRef(null)
  const reduced = useRef(false)

  useEffect(() => {
    reduced.current = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  }, [])

  /* ── job mutation helpers ── */
  const updateJob = useCallback((jobId, fn) => {
    setCols(prev => {
      const next = {}
      for (const k of STAGE_IDS) next[k] = prev[k].map(j => j.id === jobId ? fn({ ...j }) : j)
      return next
    })
  }, [])

  const moveJob = useCallback((jobId, toCol, toIndex) => {
    setCols(prev => {
      let job = null
      const next = {}
      for (const k of STAGE_IDS) {
        next[k] = prev[k].filter(j => { if (j.id === jobId) { job = j; return false } return true })
      }
      if (!job) return prev
      const idx = toIndex == null ? next[toCol].length : clamp(toIndex, 0, next[toCol].length)
      next[toCol].splice(idx, 0, job)
      return next
    })
    setLanded(jobId)
    setTimeout(() => setLanded(l => (l === jobId ? null : l)), 520)
  }, [])

  const advance = useCallback((jobId, dir) => {
    let from = null
    for (const k of STAGE_IDS) if (cols[k].some(j => j.id === jobId)) from = k
    if (!from) return
    const i = STAGE_IDS.indexOf(from)
    const t = clamp(i + dir, 0, STAGE_IDS.length - 1)
    if (t === i) return
    moveJob(jobId, STAGE_IDS[t], null)
  }, [cols, moveJob])

  /* ── notes ── */
  const addNote = useCallback((jobId) => {
    const id = 'n' + Math.random().toString(36).slice(2, 8)
    updateJob(jobId, j => {
      const used = (j.notes || []).length
      return { ...j, notes: [...(j.notes || []), { id, text: '', color: INK[used % INK.length] }] }
    })
    setEditingNote(id)
  }, [updateJob])
  const editNote = useCallback((jobId, noteId, text) =>
    updateJob(jobId, j => ({ ...j, notes: j.notes.map(n => n.id === noteId ? { ...n, text } : n) })), [updateJob])
  const commitNote = useCallback((jobId, noteId) => {
    updateJob(jobId, j => ({ ...j, notes: j.notes.filter(n => n.id !== noteId || n.text.trim() !== '') }))
    setEditingNote(null)
  }, [updateJob])
  const recolorNote = useCallback((jobId, noteId) =>
    updateJob(jobId, j => ({ ...j, notes: j.notes.map(n => n.id === noteId
      ? { ...n, color: INK[(INK.indexOf(n.color) + 1) % INK.length] } : n) })), [updateJob])
  const deleteNote = useCallback((jobId, noteId) =>
    updateJob(jobId, j => ({ ...j, notes: j.notes.filter(n => n.id !== noteId) })), [updateJob])

  /* ── add a blank application to Applied ── */
  const addApplication = () => {
    const id = 'j' + Math.random().toString(36).slice(2, 7)
    setCols(prev => ({
      ...prev,
      applied: [{
        id, job_title: 'New application', company: 'Company', location: 'Location',
        score: 60, posted_at: new Date().toISOString(), source: 'manual', matched_skills: [], notes: [],
      }, ...prev.applied],
    }))
    setLanded(id)
    setTimeout(() => setLanded(l => (l === id ? null : l)), 520)
  }

  /* ── drag engine (pointer-based, rAF-throttled) ── */
  const computeHover = (clientX, clientY) => {
    let target = null
    for (const k of STAGE_IDS) {
      const node = colNodes.current[k]
      if (!node) continue
      const r = node.getBoundingClientRect()
      if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom + 40) { target = k; break }
    }
    if (!target) return null
    const stack = colNodes.current[target].querySelector('.rkkb-stack')
    const cards = [...stack.querySelectorAll('[data-job]')].filter(c => c.dataset.job !== drag.jobId)
    let index = cards.length
    for (let i = 0; i < cards.length; i++) {
      const r = cards[i].getBoundingClientRect()
      if (clientY < r.top + r.height / 2) { index = i; break }
    }
    return { col: target, index }
  }

  const onMove = useCallback((e) => {
    ev.current = e
    if (raf.current) return
    raf.current = requestAnimationFrame(() => {
      raf.current = 0
      const cur = ev.current
      if (!cur || !drag) return
      const x = cur.clientX - drag.offX
      const y = cur.clientY - drag.offY
      const now = performance.now()
      const dt = now - last.current.t || 16
      const vx = (cur.clientX - last.current.x) / dt
      const tilt = reduced.current ? 0 : clamp(last.current.tilt * 0.6 + vx * 6, -8, 8)
      last.current = { x: cur.clientX, t: now, tilt }
      if (floatRef.current) {
        floatRef.current.style.transform =
          `translate3d(${x}px, ${y}px, 0) rotate(${tilt}deg) scale(1.045)`
      }
      const h = computeHover(cur.clientX, cur.clientY)
      setHover(prev => {
        if (!h && !prev) return prev
        if (h && prev && h.col === prev.col && h.index === prev.index) return prev
        return h
      })
    })
  }, [drag])

  const onUp = useCallback(() => {
    if (!drag) return
    if (hover) moveJob(drag.jobId, hover.col, hover.index)
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    document.body.style.userSelect = ''
    setDrag(null)
    setHover(null)
    if (raf.current) cancelAnimationFrame(raf.current), (raf.current = 0)
  }, [drag, hover, moveJob, onMove])

  useEffect(() => {
    if (!drag) return
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [drag, onMove, onUp])

  const startDrag = (e, job, fromCol) => {
    if (e.button != null && e.button !== 0) return
    if (e.target.closest('button, input, a, .rkkb-note')) return  // don't hijack interactive bits
    const card = e.currentTarget
    const r = card.getBoundingClientRect()
    e.preventDefault()
    document.body.style.userSelect = 'none'
    last.current = { x: e.clientX, t: performance.now(), tilt: 0 }
    setDrag({ jobId: job.id, fromCol, w: r.width, h: r.height, offX: e.clientX - r.left, offY: e.clientY - r.top, job })
    setHover({ col: fromCol, index: cols[fromCol].findIndex(j => j.id === job.id) })
    requestAnimationFrame(() => {
      if (floatRef.current) floatRef.current.style.transform =
        `translate3d(${r.left}px, ${r.top}px, 0) rotate(0deg) scale(1.045)`
    })
  }

  /* ── derived per-column render lists (dragged card filtered out) ── */
  const colsRender = STAGE_IDS.reduce((acc, k) => {
    acc[k] = cols[k]
      .filter(j => !(drag && j.id === drag.jobId))
      .map(j => ({
        key: j.id,
        el: (
          <JobCard
            job={j}
            colIndex={STAGE_IDS.indexOf(k)}
            dragging={false}
            landed={landed === j.id}
            reduced={reduced.current}
            editingNote={editingNote}
            onPointerDown={(e) => startDrag(e, j, k)}
            onAddNote={addNote}
            onEditNote={editNote}
            onCommitNote={commitNote}
            onRecolorNote={recolorNote}
            onDeleteNote={deleteNote}
            onAdvance={(id) => advance(id, +1)}
            onRetreat={(id) => advance(id, -1)}
          />
        ),
      }))
    return acc
  }, {})

  const total = STAGE_IDS.reduce((n, k) => n + cols[k].length, 0)

  // user display for the shared sidebar
  const fullName  = user?.user_metadata?.full_name || user?.user_metadata?.name || user?.email || 'You'
  const firstName = (fullName.split('@')[0].split(' ')[0]) || 'You'
  const initial   = (firstName[0] || 'U').toUpperCase()
  const handleNav = (tab) => onNavigate?.(tab)

  return (
    <div className="rkkb-shell">
      <style>{BOARD_CSS}</style>

      <Sidebar
        activeNav="TrackApps"
        onNavigate={handleNav}
        userName={firstName}
        userInitial={initial}
        userStat={`${total} application${total === 1 ? '' : 's'} on the wall`}
        badge={{ TrackApps: total }}
        theme={theme}
        onAskRack={() => handleNav('Home')}
      />

      <main className="rkkb" data-theme={theme}>
        {/* header */}
        <div className="rkkb-topbar">
          <div className="rkkb-brand">
            <div>
              <h1>Application board</h1>
              <p>{total} roles on the wall · drag a card forward as you progress</p>
            </div>
          </div>
          <div className="rkkb-actions">
            <button className="rkkb-add" onClick={addApplication}>{I.plus} Add application</button>
          </div>
        </div>

        {/* the wall */}
      <div className="rkkb-wall">
        <div className="rkkb-board">
          {STAGES.map((stage, i) => (
            <Column
              key={stage.id}
              stage={stage}
              index={i}
              jobs={colsRender[stage.id]}
              colRef={(n) => { colNodes.current[stage.id] = n }}
              isHover={!!drag && hover?.col === stage.id}
              hoverIndex={hover?.index ?? -1}
              slotH={drag ? drag.h : 0}
            />
          ))}
        </div>
      </div>

      {/* floating drag clone */}
      {drag && (
        <div ref={floatRef} className="rkkb-float" style={{ width: drag.w }}>
          <JobCard job={drag.job} colIndex={STAGE_IDS.indexOf(drag.fromCol)} floating
            onAddNote={() => {}} onEditNote={() => {}} onCommitNote={() => {}}
            onRecolorNote={() => {}} onDeleteNote={() => {}} onAdvance={() => {}} onRetreat={() => {}} />
        </div>
      )}
      </main>
    </div>
  )
}

/* ─────────────────────────── styles ─────────────────────────── */
const BOARD_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Caveat:wght@500;600;700&display=swap');

/* ===== STANDALONE TOKENS — delete the two blocks below when integrating into RACK
   (globals.css already provides --accent / --text / --surface / --font-*).
   KEEP the paper/chalk/ink tokens — they are new and board-specific. ===== */
.rkkb[data-theme="light"]{
  --accent:#e8ff6b; --accent-ink:#5f7611;
  --accent-soft:rgba(95,118,17,0.12); --accent-line:rgba(95,118,17,0.30);
  --accent-glow:0 6px 30px rgba(184,214,40,0.40);
  --font-sans:'Inter',system-ui,-apple-system,sans-serif;
  --font-mono:'SFMono-Regular',ui-monospace,monospace;
  /* paper */
  --board:#e9e1d1; --board-2:#efe8da; --board-grid:rgba(74,58,30,0.055);
  --card-paper:#fcf9f2; --card-paper-2:#f6f1e6; --card-edge:rgba(46,38,22,0.12);
  --card-shadow:0 1px 1px rgba(40,32,18,0.06), 0 8px 18px rgba(40,32,18,0.10);
  --card-shadow-lift:0 18px 40px rgba(40,32,18,0.22), 0 4px 10px rgba(40,32,18,0.12);
  --tape:rgba(214,201,170,0.78); --tape-edge:rgba(150,134,98,0.30);
  --ink:#4a4032; --tx:#2c2620; --tx-mid:#6b5f4c; --tx-dim:#998b73;
  --ink-amber:#bf8412; --ink-blue:#2f6fdb; --ink-red:#d8473f; --ink-green:#2f9d63; --ink-violet:#6d4ddb;
  --skill-bg:rgba(46,38,22,0.05); --skill-line:rgba(46,38,22,0.10);
}
.rkkb[data-theme="dark"]{
  --accent:#e8ff6b; --accent-ink:#e8ff6b;
  --accent-soft:rgba(232,255,107,0.13); --accent-line:rgba(232,255,107,0.34);
  --accent-glow:0 6px 34px rgba(232,255,107,0.30);
  --font-sans:'Inter',system-ui,-apple-system,sans-serif;
  --font-mono:'SFMono-Regular',ui-monospace,monospace;
  /* chalkboard */
  --board:#15191a; --board-2:#191e1f; --board-grid:rgba(255,255,255,0.028);
  --card-paper:#22252c; --card-paper-2:#1d2027; --card-edge:rgba(255,255,255,0.08);
  --card-shadow:0 1px 1px rgba(0,0,0,0.4), 0 10px 22px rgba(0,0,0,0.42);
  --card-shadow-lift:0 22px 46px rgba(0,0,0,0.62), 0 6px 14px rgba(0,0,0,0.5);
  --tape:rgba(120,128,120,0.16); --tape-edge:rgba(255,255,255,0.10);
  --ink:#cbd2cc; --tx:#eef0ee; --tx-mid:#a6ada6; --tx-dim:#6f766f;
  --ink-amber:#f5c451; --ink-blue:#6aa8ff; --ink-red:#ff7a72; --ink-green:#5fd896; --ink-violet:#a78bff;
  --skill-bg:rgba(255,255,255,0.05); --skill-line:rgba(255,255,255,0.09);
}
/* ===== end standalone tokens ===== */

.rkkb-shell{ position:fixed; inset:0; display:flex; }
.rkkb-shell:has(.rkkb[data-theme="dark"])  { --sidebar-bg:#0c0c0f; }
.rkkb-shell:has(.rkkb[data-theme="light"]) { --sidebar-bg:#EFEDE4; }

.rkkb{ position:relative; flex:1; min-width:0; min-height:0; height:100%;
  display:flex; flex-direction:column; background:var(--board);
  font-family:var(--font-sans); color:var(--tx); -webkit-font-smoothing:antialiased; }

/* ── top bar ── */
.rkkb-topbar{ display:flex; align-items:center; justify-content:space-between; gap:16px;
  padding:22px 28px 16px; flex-wrap:wrap; }
.rkkb-brand{ display:flex; align-items:center; gap:13px; }
.rkkb-brand h1{ font-size:19px; font-weight:700; letter-spacing:-0.02em; margin:0; line-height:1.15; }
.rkkb-brand p{ font-size:12.5px; color:var(--tx-dim); margin:2px 0 0; }
.rkkb-actions{ display:flex; align-items:center; gap:10px; }
.rkkb-add{ display:flex; align-items:center; gap:6px; padding:9px 14px; border-radius:10px; cursor:pointer;
  font-family:var(--font-sans); font-size:12.5px; font-weight:650; color:var(--accent-ink);
  background:var(--accent-soft); border:1px solid var(--accent-line); transition:transform .12s, background .15s; }
.rkkb-add:hover{ transform:translateY(-1px); }
/* ── wall / board ── */
.rkkb-wall{ flex:1; overflow:auto; padding:6px 28px 34px;
  background:
    radial-gradient(120% 80% at 50% -10%, var(--board-2), var(--board) 60%),
    var(--board);
  position:relative; }
.rkkb-wall::before{ /* faint workshop grid */
  content:''; position:absolute; inset:0; pointer-events:none;
  background-image:
    linear-gradient(var(--board-grid) 1px, transparent 1px),
    linear-gradient(90deg, var(--board-grid) 1px, transparent 1px);
  background-size:26px 26px; mask-image:radial-gradient(120% 90% at 50% 30%, #000 55%, transparent 100%); }
.rkkb-wall::after{ /* paper / chalk grain */
  content:''; position:absolute; inset:0; pointer-events:none; opacity:.5;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.035'/%3E%3C/svg%3E"); }

.rkkb-board{ display:flex; gap:18px; align-items:flex-start; min-width:min-content;
  position:relative; z-index:1; }

/* ── column ── */
.rkkb-col{ flex:1 1 0; min-width:262px; max-width:340px; display:flex; flex-direction:column;
  border-radius:14px; padding:8px 8px 14px;
  background:linear-gradient(180deg, rgba(255,255,255,0.018), transparent 30%);
  border:1px dashed transparent; transition:border-color .2s, background .2s; }
.rkkb-col.is-target{ border-color:var(--accent-line); background:var(--accent-soft); }

/* masking-tape header */
.rkkb-tape{ position:relative; align-self:flex-start; margin:6px 0 14px 8px; padding:7px 14px 7px 12px;
  display:flex; align-items:center; gap:8px; transform:rotate(-1.4deg);
  background:var(--tape); border-radius:3px;
  box-shadow:0 2px 6px rgba(0,0,0,0.10), inset 0 0 0 1px var(--tape-edge);
  -webkit-mask:linear-gradient(#000,#000); }
.rkkb-tape::before, .rkkb-tape::after{ content:''; position:absolute; top:0; bottom:0; width:7px;
  background:repeating-linear-gradient(135deg, transparent 0 2px, rgba(0,0,0,0.05) 2px 3px); }
.rkkb-tape::before{ left:-1px; } .rkkb-tape::after{ right:-1px; }
.rkkb-tape-label{ font-family:'Caveat',cursive; font-size:21px; font-weight:700; line-height:1; color:var(--ink);
  display:inline-flex; align-items:center; gap:5px; white-space:nowrap; }
.rkkb-tape-star{ color:var(--accent-ink); display:inline-flex; }
.rkkb-count{ font-family:var(--font-mono); font-size:11px; font-weight:700; color:var(--ink);
  background:rgba(0,0,0,0.07); border-radius:20px; padding:1px 8px; }
.rkkb-tape-hint{ font-family:'Caveat',cursive; font-size:14px; color:var(--ink); opacity:.62; white-space:nowrap; }
.tone-win .rkkb-tape{ background:var(--accent); box-shadow:var(--accent-glow), inset 0 0 0 1px rgba(0,0,0,0.10); }
.tone-win .rkkb-tape-label, .tone-win .rkkb-tape-hint, .tone-win .rkkb-count{ color:#3f4a16; }
.tone-win .rkkb-count{ background:rgba(0,0,0,0.12); }
.tone-blue  .rkkb-tape{ transform:rotate(1.1deg); }
.tone-amber .rkkb-tape{ transform:rotate(-0.7deg); }

.rkkb-stack{ display:flex; flex-direction:column; gap:14px; padding:2px 6px; min-height:60px; }

/* slot that opens to receive a card */
.rkkb-slot{ border-radius:13px; border:2px dashed var(--accent-line); background:var(--accent-soft);
  animation:rkkbSlot .18s cubic-bezier(.22,1,.36,1) both; }
@keyframes rkkbSlot{ from{ opacity:0; transform:scaleY(.7); } to{ opacity:1; transform:scaleY(1); } }
.rkkb-slot-wrap{ display:flex; flex-direction:column; gap:14px; }

.rkkb-empty{ font-family:'Caveat',cursive; font-size:16px; color:var(--tx-dim); text-align:center;
  padding:24px 8px; opacity:.7; }

/* ── card ── */
.rkkb-card{ position:relative; background:linear-gradient(180deg, var(--card-paper), var(--card-paper-2));
  border:1px solid var(--card-edge); border-radius:13px; padding:15px 15px 12px;
  box-shadow:var(--card-shadow); cursor:grab; touch-action:pan-y; user-select:none;
  transform:rotate(var(--tilt,0deg)); transform-origin:50% 0%;
  transition:transform .22s cubic-bezier(.22,1,.36,1), box-shadow .2s; will-change:transform; }
.rkkb-card:hover{ transform:rotate(calc(var(--tilt,0deg) * .4)) translateY(-3px); box-shadow:var(--card-shadow-lift); }
.rkkb-card:active{ cursor:grabbing; }
.rkkb-card.is-source{ display:none; }
.rkkb-card.is-landed{ animation:rkkbSettle .5s cubic-bezier(.34,1.56,.5,1) both; }
@keyframes rkkbSettle{
  0%{ transform:rotate(0deg) scale(1.05) translateY(-6px); box-shadow:var(--card-shadow-lift); }
  55%{ transform:rotate(calc(var(--tilt,0deg) * 1.5)) scale(1.005); }
  100%{ transform:rotate(var(--tilt,0deg)) scale(1); box-shadow:var(--card-shadow); }
}

/* tape strip pinning the card to the wall */
.rkkb-tape-strip{ position:absolute; top:-9px; left:50%; width:62px; height:18px; transform:translateX(-50%) rotate(-2deg);
  background:var(--tape); box-shadow:inset 0 0 0 1px var(--tape-edge); border-radius:2px; opacity:.9; }
.tone-win .rkkb-card .rkkb-tape-strip{ background:linear-gradient(90deg, var(--tape), rgba(232,255,107,0.4)); }

.rkkb-card-head{ display:flex; align-items:flex-start; gap:10px; }
.rkkb-logo{ width:30px; height:30px; border-radius:8px; flex-shrink:0; display:flex; align-items:center;
  justify-content:center; color:#fff; font-weight:800; font-size:14px; text-shadow:0 1px 2px rgba(0,0,0,0.25); }
.rkkb-titles{ flex:1; min-width:0; }
.rkkb-titles h3{ font-size:14px; font-weight:680; line-height:1.25; margin:0; color:var(--tx);
  letter-spacing:-0.01em; overflow:hidden; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; }
.rkkb-sub{ font-size:11.5px; color:var(--tx-mid); margin-top:3px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.rkkb-grip{ color:var(--tx-dim); opacity:.5; flex-shrink:0; margin-top:2px; }
.rkkb-card:hover .rkkb-grip{ opacity:.85; }

.rkkb-meta{ display:flex; align-items:center; justify-content:space-between; gap:8px; margin-top:12px; }
.rkkb-date{ display:inline-flex; align-items:center; gap:5px; font-size:11px; color:var(--tx-mid);
  font-family:var(--font-mono); }
.rkkb-score{ font-family:var(--font-mono); font-size:13px; font-weight:800; letter-spacing:-0.02em; }
.rkkb-score span{ font-size:9.5px; font-weight:600; opacity:.7; margin-left:1px; }
.rkkb-score.t-strong{ color:var(--ink-green); } .rkkb-score.t-good{ color:var(--accent-ink); }
.rkkb-score.t-mid{ color:var(--ink-amber); } .rkkb-score.t-weak{ color:var(--ink-red); }

.rkkb-skills{ display:flex; flex-wrap:wrap; gap:5px; margin-top:11px; }
.rkkb-skill{ font-size:10.5px; font-weight:550; color:var(--tx-mid); background:var(--skill-bg);
  border:1px solid var(--skill-line); padding:2px 8px; border-radius:6px; }

/* scribble notes */
.rkkb-notes{ display:flex; flex-wrap:wrap; gap:8px 12px; margin-top:13px; }
.rkkb-note{ position:relative; display:inline-flex; align-items:center; padding:3px 9px 4px;
  background:rgba(255,255,255,0.04); border-radius:4px; }
.rkkb-note-tape{ position:absolute; top:-6px; left:8px; width:22px; height:11px; transform:rotate(-8deg);
  background:var(--tape); box-shadow:inset 0 0 0 1px var(--tape-edge); border-radius:1px; }
.rkkb-note-text, .rkkb-note-input{ font-family:'Caveat',cursive; font-size:17px; font-weight:600; line-height:1.05;
  color:var(--note-ink); }
.rkkb-note[data-ink="amber"]{ --note-ink:var(--ink-amber); }
.rkkb-note[data-ink="blue"]{ --note-ink:var(--ink-blue); }
.rkkb-note[data-ink="red"]{ --note-ink:var(--ink-red); }
.rkkb-note[data-ink="green"]{ --note-ink:var(--ink-green); }
.rkkb-note[data-ink="violet"]{ --note-ink:var(--ink-violet); }
.rkkb-note-input{ border:none; outline:none; background:transparent; min-width:60px; width:auto; max-width:160px;
  padding:0; }
.rkkb-note-input::placeholder{ color:var(--note-ink); opacity:.4; }
.rkkb-note-tools{ display:none; align-items:center; gap:4px; margin-left:6px; }
.rkkb-note:hover .rkkb-note-tools{ display:inline-flex; }
.rkkb-note-dot{ width:11px; height:11px; border-radius:50%; padding:0; cursor:pointer; border:1.5px solid #fff3;
  background:var(--note-ink); box-shadow:0 0 0 1px rgba(0,0,0,0.15); }
.rkkb-note-x{ width:14px; height:14px; padding:0; border:none; background:transparent; cursor:pointer;
  color:var(--tx-dim); display:flex; align-items:center; justify-content:center; }
.rkkb-note-x:hover{ color:var(--ink-red); }

/* footer */
.rkkb-foot{ display:flex; align-items:center; justify-content:space-between; gap:8px; margin-top:13px;
  padding-top:11px; border-top:1px dashed var(--card-edge); }
.rkkb-addnote{ display:inline-flex; align-items:center; gap:4px; font-family:'Caveat',cursive; font-size:15px;
  font-weight:600; color:var(--tx-dim); background:transparent; border:none; cursor:pointer; padding:2px 2px;
  transition:color .15s; }
.rkkb-addnote:hover{ color:var(--accent-ink); }
.rkkb-move{ display:flex; gap:5px; }
.rkkb-mv{ width:26px; height:24px; border-radius:7px; cursor:pointer; display:flex; align-items:center;
  justify-content:center; color:var(--tx-mid); background:var(--skill-bg); border:1px solid var(--skill-line);
  transition:all .14s; }
.rkkb-mv:hover:not(:disabled){ color:var(--tx); transform:translateY(-1px); }
.rkkb-mv.fwd:hover:not(:disabled){ color:var(--accent-ink); background:var(--accent-soft); border-color:var(--accent-line); }
.rkkb-mv:disabled{ opacity:.3; cursor:default; }

/* floating drag clone */
.rkkb-float{ position:fixed; top:0; left:0; z-index:90; pointer-events:none; will-change:transform; }
.rkkb-float .rkkb-card{ box-shadow:var(--card-shadow-lift); cursor:grabbing; transition:none; }

/* scrollbars */
.rkkb-wall::-webkit-scrollbar{ height:11px; width:11px; }
.rkkb-wall::-webkit-scrollbar-thumb{ background:var(--card-edge); border-radius:20px; border:3px solid transparent;
  background-clip:padding-box; }

@media (prefers-reduced-motion: reduce){
  .rkkb-card, .rkkb-slot, .rkkb-card.is-landed{ animation:none !important; transition:none !important; }
}

/* responsive: stack sidebar chrome above the board; wall scrolls horizontally with snap */
@media (max-width: 767px){
  .rkkb-shell{ flex-direction:column; }
  .rkkb-topbar{ padding:16px 16px 12px; }
  .rkkb-wall{ padding:6px 16px 92px; scroll-snap-type:x mandatory; }  /* bottom clears fixed bottom nav */
  .rkkb-col{ min-width:84vw; max-width:84vw; scroll-snap-align:start; }
}
`