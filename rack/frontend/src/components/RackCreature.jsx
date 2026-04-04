/**
 * RackCreature — Mametchi-style pixel art mascot.
 * Redesigned to match the uploaded Mametchi reference more closely,
 * while preserving the existing mood / bubble / walk behavior.
 */
import { useState, useEffect, useRef } from 'react'

const PX   = 2.5
const COLS = 16
const ROWS = 20

const PAL = {
  _: null,
  B: '#0a0a0a',
  W: '#f2f2f2',
  G: '#c0c0c0',
}

// ─── Sprite grids: 16 cols × 20 rows ─────────────────────────────────────────
// Row layout:
//   0-1  : cat ears (two 3-wide black blocks, inner grey pixel)
//   2    : head top — connects ears
//   3-11 : round head, widest at rows 4-5, tapers heart-shape from row 10
//   6-7  : eyes — 2×2 B squares at cols 3-4 (L) and 10-11 (R)  ← set by withMoodFace
//   9    : mouth — 3-cell dash at cols 6-8                       ← set by withMoodFace
//   12-13: narrow heart lobe / body transition
//   14-17: two short stubby legs poke out from bottom lobes
//   18-19: clearance

// IDLE / WALK frame A — legs spread
const MAME_IDLE_A = [
  '_,_,B,B,B,_,_,_,_,_,B,B,B,_,_,_'.split(','), // 0  ears
  '_,_,B,G,B,_,_,_,_,_,B,G,B,_,_,_'.split(','), // 1  inner ear grey
  '_,_,B,B,B,B,B,B,B,B,B,B,B,_,_,_'.split(','), // 2  head top
  '_,B,W,W,W,W,W,W,W,W,W,W,W,B,_,_'.split(','), // 3
  'B,W,W,W,W,W,W,W,W,W,W,W,W,W,B,_'.split(','), // 4  widest
  'B,W,W,W,W,W,W,W,W,W,W,W,W,W,B,_'.split(','), // 5
  'B,W,W,B,B,W,W,W,W,W,B,B,W,W,B,_'.split(','), // 6  eyes row 1
  'B,W,W,B,B,W,W,W,W,W,B,B,W,W,B,_'.split(','), // 7  eyes row 2
  'B,W,W,W,W,W,W,W,W,W,W,W,W,W,B,_'.split(','), // 8
  'B,W,W,W,W,W,B,B,B,W,W,W,W,W,B,_'.split(','), // 9  mouth
  'B,W,W,W,W,W,W,W,W,W,W,W,W,W,B,_'.split(','), // 10
  '_,B,W,W,W,W,W,W,W,W,W,W,W,B,_,_'.split(','), // 11 curves in
  '_,_,B,W,W,W,W,W,W,W,W,W,B,_,_,_'.split(','), // 12 tapers
  '_,_,_,B,W,W,W,W,W,W,W,B,_,_,_,_'.split(','), // 13 heart lobe top
  '_,_,_,B,W,W,B,_,_,B,W,W,B,_,_,_'.split(','), // 14 leg tops
  '_,_,_,B,W,B,_,_,_,_,B,W,B,_,_,_'.split(','), // 15 legs
  '_,_,_,B,W,B,_,_,_,_,B,W,B,_,_,_'.split(','), // 16 shins
  '_,_,_,B,B,_,_,_,_,_,_,B,B,_,_,_'.split(','), // 17 feet
  '_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_'.split(','), // 18
  '_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_'.split(','), // 19
]

// WALK frame B — legs stepped slightly inward
const MAME_IDLE_B = [
  '_,_,B,B,B,_,_,_,_,_,B,B,B,_,_,_'.split(','),
  '_,_,B,G,B,_,_,_,_,_,B,G,B,_,_,_'.split(','),
  '_,_,B,B,B,B,B,B,B,B,B,B,B,_,_,_'.split(','),
  '_,B,W,W,W,W,W,W,W,W,W,W,W,B,_,_'.split(','),
  'B,W,W,W,W,W,W,W,W,W,W,W,W,W,B,_'.split(','),
  'B,W,W,W,W,W,W,W,W,W,W,W,W,W,B,_'.split(','),
  'B,W,W,B,B,W,W,W,W,W,B,B,W,W,B,_'.split(','),
  'B,W,W,B,B,W,W,W,W,W,B,B,W,W,B,_'.split(','),
  'B,W,W,W,W,W,W,W,W,W,W,W,W,W,B,_'.split(','),
  'B,W,W,W,W,W,B,B,B,W,W,W,W,W,B,_'.split(','),
  'B,W,W,W,W,W,W,W,W,W,W,W,W,W,B,_'.split(','),
  '_,B,W,W,W,W,W,W,W,W,W,W,W,B,_,_'.split(','),
  '_,_,B,W,W,W,W,W,W,W,W,W,B,_,_,_'.split(','),
  '_,_,_,B,W,W,W,W,W,W,W,B,_,_,_,_'.split(','),
  '_,_,_,B,W,W,B,_,_,B,W,W,B,_,_,_'.split(','),
  '_,_,_,_,B,W,B,_,_,_,B,W,B,_,_,_'.split(','), // legs inward
  '_,_,_,_,B,W,B,_,_,_,B,W,B,_,_,_'.split(','),
  '_,_,_,_,B,B,_,_,_,_,_,B,B,_,_,_'.split(','), // feet closer
  '_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_'.split(','),
  '_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_'.split(','),
]

// HAPPY — arms out wide (extra pixels on sides rows 14)
const MAME_HAPPY_A = [
  '_,_,B,B,B,_,_,_,_,_,B,B,B,_,_,_'.split(','),
  '_,_,B,G,B,_,_,_,_,_,B,G,B,_,_,_'.split(','),
  '_,_,B,B,B,B,B,B,B,B,B,B,B,_,_,_'.split(','),
  '_,B,W,W,W,W,W,W,W,W,W,W,W,B,_,_'.split(','),
  'B,W,W,W,W,W,W,W,W,W,W,W,W,W,B,_'.split(','),
  'B,W,W,W,W,W,W,W,W,W,W,W,W,W,B,_'.split(','),
  'B,W,W,B,B,W,W,W,W,W,B,B,W,W,B,_'.split(','),
  'B,W,W,B,B,W,W,W,W,W,B,B,W,W,B,_'.split(','),
  'B,W,W,W,W,W,W,W,W,W,W,W,W,W,B,_'.split(','),
  'B,W,W,W,W,B,B,B,B,B,W,W,W,W,B,_'.split(','), // big smile
  'B,W,W,W,W,W,W,W,W,W,W,W,W,W,B,_'.split(','),
  '_,B,W,W,W,W,W,W,W,W,W,W,W,B,_,_'.split(','),
  '_,_,B,W,W,W,W,W,W,W,W,W,B,_,_,_'.split(','),
  'B,B,_,B,W,W,W,W,W,W,W,B,_,B,B,_'.split(','), // arms out!
  'B,_,_,B,W,W,B,_,_,B,W,W,B,_,_,B'.split(','),
  '_,_,_,B,W,B,_,_,_,_,B,W,B,_,_,_'.split(','),
  '_,_,_,B,W,B,_,_,_,_,B,W,B,_,_,_'.split(','),
  '_,_,_,B,B,_,_,_,_,_,_,B,B,_,_,_'.split(','),
  '_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_'.split(','),
  '_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_'.split(','),
]

const MAME_HAPPY_B = [
  '_,_,B,B,B,_,_,_,_,_,B,B,B,_,_,_'.split(','),
  '_,_,B,G,B,_,_,_,_,_,B,G,B,_,_,_'.split(','),
  '_,_,B,B,B,B,B,B,B,B,B,B,B,_,_,_'.split(','),
  '_,B,W,W,W,W,W,W,W,W,W,W,W,B,_,_'.split(','),
  'B,W,W,W,W,W,W,W,W,W,W,W,W,W,B,_'.split(','),
  'B,W,W,W,W,W,W,W,W,W,W,W,W,W,B,_'.split(','),
  'B,W,W,B,B,W,W,W,W,W,B,B,W,W,B,_'.split(','),
  'B,W,W,B,B,W,W,W,W,W,B,B,W,W,B,_'.split(','),
  'B,W,W,W,W,W,W,W,W,W,W,W,W,W,B,_'.split(','),
  'B,W,W,W,W,B,B,B,B,B,W,W,W,W,B,_'.split(','),
  'B,W,W,W,W,W,W,W,W,W,W,W,W,W,B,_'.split(','),
  '_,B,W,W,W,W,W,W,W,W,W,W,W,B,_,_'.split(','),
  '_,_,B,W,W,W,W,W,W,W,W,W,B,_,_,_'.split(','),
  'B,B,_,B,W,W,W,W,W,W,W,B,_,B,B,_'.split(','),
  'B,_,_,B,W,W,B,_,_,B,W,W,B,_,_,B'.split(','),
  '_,_,_,_,B,W,B,_,_,_,B,W,B,_,_,_'.split(','), // legs inward
  '_,_,_,_,B,W,B,_,_,_,B,W,B,_,_,_'.split(','),
  '_,_,_,_,B,B,_,_,_,_,_,B,B,_,_,_'.split(','),
  '_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_'.split(','),
  '_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_'.split(','),
]

// THINKING — one arm up, squint one eye, off-centre mouth
const MAME_THINK_A = [
  '_,_,B,B,B,_,_,_,_,_,B,B,B,_,_,_'.split(','),
  '_,_,B,G,B,_,_,_,_,_,B,G,B,_,_,_'.split(','),
  '_,_,B,B,B,B,B,B,B,B,B,B,B,_,_,_'.split(','),
  '_,B,W,W,W,W,W,W,W,W,W,W,W,B,_,_'.split(','),
  'B,W,W,W,W,W,W,W,W,W,W,W,W,W,B,_'.split(','),
  'B,W,W,W,W,W,W,W,W,W,W,W,W,W,B,_'.split(','),
  'B,W,W,B,B,W,W,W,W,W,B,B,W,W,B,_'.split(','),
  'B,W,W,B,B,W,W,W,W,W,B,B,W,W,B,_'.split(','),
  'B,W,W,W,W,W,W,W,W,W,W,W,W,W,B,_'.split(','),
  'B,W,W,W,W,W,B,B,B,W,W,W,W,W,B,_'.split(','),
  'B,W,W,W,W,W,W,W,W,W,W,W,W,W,B,_'.split(','),
  '_,B,W,W,W,W,W,W,W,W,W,W,W,B,_,_'.split(','),
  '_,_,B,W,W,W,W,W,W,W,W,W,B,_,_,_'.split(','),
  '_,_,_,B,W,W,W,W,W,W,W,B,_,B,B,_'.split(','), // right arm up
  '_,_,_,B,W,W,B,_,_,B,W,W,B,_,B,_'.split(','),
  '_,_,_,B,W,B,_,_,_,_,B,W,B,_,_,_'.split(','),
  '_,_,_,B,W,B,_,_,_,_,B,W,B,_,_,_'.split(','),
  '_,_,_,B,B,_,_,_,_,_,_,B,B,_,_,_'.split(','),
  '_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_'.split(','),
  '_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_'.split(','),
]

const MAME_THINK_B = [
  '_,_,B,B,B,_,_,_,_,_,B,B,B,_,_,_'.split(','),
  '_,_,B,G,B,_,_,_,_,_,B,G,B,_,_,_'.split(','),
  '_,_,B,B,B,B,B,B,B,B,B,B,B,_,_,_'.split(','),
  '_,B,W,W,W,W,W,W,W,W,W,W,W,B,_,_'.split(','),
  'B,W,W,W,W,W,W,W,W,W,W,W,W,W,B,_'.split(','),
  'B,W,W,W,W,W,W,W,W,W,W,W,W,W,B,_'.split(','),
  'B,W,W,B,B,W,W,W,W,W,B,B,W,W,B,_'.split(','),
  'B,W,W,B,B,W,W,W,W,W,B,B,W,W,B,_'.split(','),
  'B,W,W,W,W,W,W,W,W,W,W,W,W,W,B,_'.split(','),
  'B,W,W,W,W,W,B,B,B,W,W,W,W,W,B,_'.split(','),
  'B,W,W,W,W,W,W,W,W,W,W,W,W,W,B,_'.split(','),
  '_,B,W,W,W,W,W,W,W,W,W,W,W,B,_,_'.split(','),
  '_,_,B,W,W,W,W,W,W,W,W,W,B,_,_,_'.split(','),
  '_,_,_,B,W,W,W,W,W,W,W,B,_,B,B,_'.split(','),
  '_,_,_,B,W,W,B,_,_,B,W,W,B,B,_,_'.split(','),
  '_,_,_,_,B,W,B,_,_,_,B,W,B,_,_,_'.split(','),
  '_,_,_,_,B,W,B,_,_,_,B,W,B,_,_,_'.split(','),
  '_,_,_,_,B,B,_,_,_,_,_,B,B,_,_,_'.split(','),
  '_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_'.split(','),
  '_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_'.split(','),
]

// SLEEPING — eyes closed (dashes), feet together
const MAME_SLEEP = [
  '_,_,B,B,B,_,_,_,_,_,B,B,B,_,_,_'.split(','),
  '_,_,B,G,B,_,_,_,_,_,B,G,B,_,_,_'.split(','),
  '_,_,B,B,B,B,B,B,B,B,B,B,B,_,_,_'.split(','),
  '_,B,W,W,W,W,W,W,W,W,W,W,W,B,_,_'.split(','),
  'B,W,W,W,W,W,W,W,W,W,W,W,W,W,B,_'.split(','),
  'B,W,W,W,W,W,W,W,W,W,W,W,W,W,B,_'.split(','),
  'B,W,W,W,W,W,W,W,W,W,W,W,W,W,B,_'.split(','), // eyes closed — just dash row below
  'B,W,W,B,B,W,W,W,W,W,B,B,W,W,B,_'.split(','), // lid lines
  'B,W,W,W,W,W,W,W,W,W,W,W,W,W,B,_'.split(','),
  'B,W,W,W,W,W,W,B,B,W,W,W,W,W,B,_'.split(','), // small mouth
  'B,W,W,W,W,W,W,W,W,W,W,W,W,W,B,_'.split(','),
  '_,B,W,W,W,W,W,W,W,W,W,W,W,B,_,_'.split(','),
  '_,_,B,W,W,W,W,W,W,W,W,W,B,_,_,_'.split(','),
  '_,_,_,B,W,W,W,W,W,W,W,B,_,_,_,_'.split(','),
  '_,_,_,B,W,W,B,_,_,B,W,W,B,_,_,_'.split(','),
  '_,_,_,_,B,W,B,_,_,B,W,B,_,_,_,_'.split(','), // feet together
  '_,_,_,_,B,W,B,_,_,B,W,B,_,_,_,_'.split(','),
  '_,_,_,_,B,B,_,_,_,B,B,_,_,_,_,_'.split(','),
  '_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_'.split(','),
  '_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_'.split(','),
]

const SPRITES = {
  idle:     [MAME_IDLE_A,  MAME_IDLE_B],
  typing:   [MAME_IDLE_A,  MAME_IDLE_B],
  happy:    [MAME_HAPPY_A, MAME_HAPPY_B],
  thinking: [MAME_THINK_A, MAME_THINK_B],
  sleeping: [MAME_SLEEP,   MAME_SLEEP],
}

function cloneGrid(grid) {
  return grid.map(row => [...row])
}

function paint(grid, points, value) {
  points.forEach(([r, c]) => {
    if (grid[r] && grid[r][c] !== undefined) grid[r][c] = value
  })
}

// Eye positions in the new 16-col grid:
//   Left eye:  rows 6-7, cols 3-4
//   Right eye: rows 6-7, cols 10-11
// Mouth: row 9, cols 6-8
function withMoodFace(base, mood) {
  const g = cloneGrid(base)

  // Wipe the eye+mouth zone to white
  for (let r = 6; r <= 9; r++) {
    for (let c = 3; c <= 11; c++) {
      if (g[r] && g[r][c] === 'B') g[r][c] = 'W'
    }
  }

  if (mood === 'sleeping') {
    // closed lids = single horizontal dash per eye
    paint(g, [[7,3],[7,4],[7,10],[7,11]], 'B')
    // tiny mouth
    paint(g, [[9,7],[9,8]], 'B')
    return g
  }

  if (mood === 'happy') {
    // 2×2 square eyes
    paint(g, [[6,3],[6,4],[7,3],[7,4],[6,10],[6,11],[7,10],[7,11]], 'B')
    // wide smile
    paint(g, [[9,5],[9,6],[9,7],[9,8],[9,9],[9,10]], 'B')
    return g
  }

  if (mood === 'thinking') {
    // left eye squint (one row only), right eye square
    paint(g, [[7,3],[7,4]], 'B')
    paint(g, [[6,10],[6,11],[7,10],[7,11]], 'B')
    // off-centre mouth
    paint(g, [[9,6],[9,7],[9,8]], 'B')
    return g
  }

  // idle / typing — standard 2×2 eyes + dash mouth
  paint(g, [[6,3],[6,4],[7,3],[7,4],[6,10],[6,11],[7,10],[7,11]], 'B')
  paint(g, [[9,6],[9,7],[9,8]], 'B')
  return g
}

function blinkify(base) {
  const g = cloneGrid(base)
  // clear eye rows
  for (let r = 6; r <= 7; r++) {
    for (let c = 3; c <= 11; c++) {
      if (g[r] && g[r][c] === 'B') g[r][c] = 'W'
    }
  }
  // single-row shut lids
  paint(g, [[7,3],[7,4],[7,10],[7,11]], 'B')
  return g
}

function usePixelCanvas(grid, flip, scale = PX) {
  const ref = useRef(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas || !grid) return

    const dpr = window.devicePixelRatio || 1
    const w = COLS * scale
    const h = ROWS * scale

    canvas.width = w * dpr
    canvas.height = h * dpr
    canvas.style.width = w + 'px'
    canvas.style.height = h + 'px'

    const ctx = canvas.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    ctx.imageSmoothingEnabled = false

    if (flip) {
      ctx.save()
      ctx.translate(w, 0)
      ctx.scale(-1, 1)
    }

    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const key = grid[r]?.[c]?.trim()
        const color = PAL[key]
        if (!color) continue
        ctx.fillStyle = color
        ctx.fillRect(c * scale, r * scale, scale, scale)
      }
    }

    if (flip) ctx.restore()
  }, [grid, flip, scale])

  return ref
}

function PixelCanvas({ grid, flip, glow }) {
  const ref = usePixelCanvas(grid, flip)
  return (
    <canvas
      ref={ref}
      style={{
        display: 'block',
        imageRendering: 'pixelated',
        filter: glow
          ? 'drop-shadow(0 0 8px rgba(212,240,74,0.55)) drop-shadow(0 2px 0 rgba(0,0,0,0.25))'
          : 'drop-shadow(0 2px 0 rgba(0,0,0,0.22))',
        transition: 'filter 0.25s ease',
      }}
    />
  )
}

const MESSAGES = {
  idle: ['find ur fit!', 'hire me plz', 'u got this!', '*yawn*', 'checking JDs', 'resume go brr', '...', 'hello fren'],
  typing: ['ooh!', 'tell me more', 'interesting!', 'paste it!', 'on it!', 'i see u!', '!!', 'let\'s go!!'],
  thinking: ['. . .', 'hmm...', 'thinking...', 'crunching!', 'almost!', 'big brain', 'computing', '🧠'],
  happy: ['found it!!', 'great match!', 'yay!!! :D', 'hired!!', 'boom!!', 'LETS GO!!', 'ur so good', '★★★'],
  sleeping: ['zzz...', 'zz~', '💤', '*snore*', 'dreaming~'],
}

function pickMessage(mood) {
  const list = MESSAGES[mood] || MESSAGES.idle
  return list[Math.floor(Math.random() * list.length)]
}

function Bubble({ text, color }) {
  return (
    <div
      style={{
        position: 'absolute',
        bottom: ROWS * PX + 8,
        left: '50%',
        transform: 'translateX(-50%)',
        background: '#0c0c0c',
        border: `2px solid ${color}`,
        borderRadius: 4,
        padding: '3px 8px',
        fontSize: 10,
        fontFamily: '"Courier New", Courier, monospace',
        fontWeight: 900,
        color,
        whiteSpace: 'nowrap',
        letterSpacing: '0.06em',
        pointerEvents: 'none',
        boxShadow: `0 0 10px ${color}66`,
        animation: 'rackPop 0.15s steps(3) both',
        zIndex: 30,
      }}
    >
      {text}
      <div
        style={{
          position: 'absolute',
          bottom: -7,
          left: '50%',
          transform: 'translateX(-50%)',
          width: 0,
          height: 0,
          borderLeft: '5px solid transparent',
          borderRight: '5px solid transparent',
          borderTop: `7px solid ${color}`,
        }}
      />
    </div>
  )
}

function ZZZ() {
  return ['z', 'z', 'Z'].map((c, i) => (
    <div
      key={i}
      style={{
        position: 'absolute',
        bottom: ROWS * PX + 4 + i * 10,
        left: COLS * PX * 0.56 + i * 6,
        fontSize: 9 + i * 3,
        fontWeight: 900,
        fontFamily: 'monospace',
        color: '#93c5fd',
        animation: `rackZzz 1.9s ease-out ${i * 0.6}s infinite`,
        opacity: 0,
        pointerEvents: 'none',
      }}
    >
      {c}
    </div>
  ))
}

export default function RackCreature({ mood = 'idle' }) {
  const wrapRef = useRef(null)
  const [maxX, setMaxX] = useState(0)

  useEffect(() => {
    const parent = wrapRef.current?.parentElement
    if (!parent) return
    const W = COLS * PX + 16
    const measure = () => setMaxX(Math.max(0, parent.getBoundingClientRect().width - W))
    measure()
    const obs = new ResizeObserver(measure)
    obs.observe(parent)
    return () => obs.disconnect()
  }, [])

  const [x, setX] = useState(0)
  const [flip, setFlip] = useState(false)
  const [frame, setFrame] = useState(0)
  const [blink, setBlink] = useState(false)
  const [bubble, setBubble] = useState(null)
  const [offsetY, setOffY] = useState(0)
  const [grid, setGrid] = useState(() => withMoodFace(MAME_IDLE_A, 'idle'))

  const xRef = useRef(0)
  const dirRef = useRef(1)
  const moodRef = useRef(mood)
  const rafRef = useRef(null)
  const tsRef = useRef(null)
  const frameRef = useRef(0)

  useEffect(() => {
    moodRef.current = mood
  }, [mood])

  useEffect(() => {
    const base = SPRITES[mood]?.[frame] ?? MAME_IDLE_A
    setGrid(blink ? blinkify(base) : withMoodFace(base, mood))
  }, [mood, frame, blink])

  const prevMood = useRef(mood)
  useEffect(() => {
    if (mood === prevMood.current) return
    prevMood.current = mood
    const colors = {
      happy: '#d4f04a',
      thinking: '#c4b5fd',
      sleeping: '#93c5fd',
      typing: '#d4f04a',
      idle: 'rgba(255,255,255,0.7)',
    }
    setBubble({ text: pickMessage(mood), color: colors[mood] || '#d4f04a' })
    const t = setTimeout(() => setBubble(null), 2400)
    return () => clearTimeout(t)
  }, [mood])

  useEffect(() => {
    if (mood !== 'idle') return
    const go = () => {
      setBubble({ text: pickMessage('idle'), color: 'rgba(255,255,255,0.65)' })
      setTimeout(() => setBubble(null), 2200)
    }
    const t = setInterval(go, 8000 + Math.random() * 6000)
    return () => clearInterval(t)
  }, [mood])

  useEffect(() => {
    let t
    const go = () => {
      t = setTimeout(() => {
        setBlink(true)
        setTimeout(() => {
          setBlink(false)
          go()
        }, 120)
      }, 1800 + Math.random() * 3200)
    }
    go()
    return () => clearTimeout(t)
  }, [])

  useEffect(() => {
    if (maxX <= 0) return
    const SPEED = { idle: 0.38, typing: 0.9, thinking: 0, happy: 1.3, sleeping: 0 }
    const STEP = { idle: 320, typing: 150, thinking: 9999, happy: 105, sleeping: 9999 }
    let lastStep = 0

    const tick = (ts) => {
      if (!tsRef.current) tsRef.current = ts
      const dt = Math.min(ts - tsRef.current, 50)
      tsRef.current = ts
      const m = moodRef.current
      const spd = SPEED[m] ?? 0.38

      if (spd > 0) {
        let nx = xRef.current + spd * (dt / 16.67) * dirRef.current
        if (nx >= maxX) {
          nx = maxX
          dirRef.current = -1
          setFlip(true)
        } else if (nx < 0) {
          nx = 0
          dirRef.current = 1
          setFlip(false)
        }
        xRef.current = nx
        setX(nx)
        if (ts - lastStep > (STEP[m] ?? 320)) {
          frameRef.current = 1 - frameRef.current
          setFrame(frameRef.current)
          lastStep = ts
        }
      }

      rafRef.current = requestAnimationFrame(tick)
    }

    rafRef.current = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(rafRef.current)
      tsRef.current = null
    }
  }, [maxX])

  useEffect(() => {
    if (mood === 'happy') {
      let pos = 0
      let dir = -1
      const iv = setInterval(() => {
        pos += dir * 1.8
        if (pos <= -8) dir = 1
        if (pos >= 0) dir = -1
        setOffY(Math.max(-8, Math.min(0, pos)))
      }, 28)
      return () => {
        clearInterval(iv)
        setOffY(0)
      }
    }

    if (mood === 'sleeping') {
      let pos = 0
      let dir = 1
      const iv = setInterval(() => {
        pos += dir * 0.2
        if (pos >= 2) dir = -1
        if (pos <= 0) dir = 1
        setOffY(pos)
      }, 90)
      return () => {
        clearInterval(iv)
        setOffY(0)
      }
    }

    setOffY(0)
  }, [mood])

  const SH = ROWS * PX
  const SW = COLS * PX

  return (
    <>
      <style>{`
        @keyframes rackPop {
          0%  { opacity: 0; transform: translateX(-50%) scale(0.4); }
          60% { transform: translateX(-50%) scale(1.08); }
          100% { opacity: 1; transform: translateX(-50%) scale(1); }
        }
        @keyframes rackZzz {
          0%  { opacity: 0; transform: translateY(0); }
          25% { opacity: 1; }
          100% { opacity: 0; transform: translateY(-22px); }
        }
      `}</style>

      <div
        ref={wrapRef}
        style={{
          position: 'absolute',
          top: -(SH + 2),
          left: 0,
          right: 0,
          height: SH,
          pointerEvents: 'none',
          overflow: 'visible',
          zIndex: 10,
        }}
      >
        <div
          style={{
            position: 'absolute',
            left: 8 + x,
            bottom: 0,
            width: SW,
            transform: `translateY(${offsetY}px)`,
          }}
        >
          {bubble && <Bubble text={bubble.text} color={bubble.color} />}
          {mood === 'sleeping' && <ZZZ />}
          <PixelCanvas grid={grid} flip={flip} glow={mood === 'happy'} />
        </div>
      </div>
    </>
  )
}