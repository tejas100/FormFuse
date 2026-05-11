/**
 * RackCreature — Enhanced v2
 * New effects vs v1:
 *  - Squash-and-stretch on mood change, tickle, startle, bonk, and happy jump landing
 *  - Wall-bonk reaction (squash + bubble + particle burst)
 *  - Chromatic aberration drop-shadow on startle
 *  - Mood-specific glow auras (animated radial gradient behind the sprite)
 *  - Motion ghost trail for fast moods (happy / typing)
 *  - Particle system: tickle heart bursts + bonk star explosions
 *  - ★ floaties for happy mood
 *  - Scanline overlay on the canvas (CRT texture)
 *  - Breathing idle (subtle scale inhale/exhale)
 *  - Typing & thinking now have their own sway animations
 *  - Bubble has shake variant for bonk
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

// ─── Sprite grids ─────────────────────────────────────────────────────────────
const MAME_IDLE_A = [
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
  '_,_,_,B,W,B,_,_,_,_,B,W,B,_,_,_'.split(','),
  '_,_,_,B,W,B,_,_,_,_,B,W,B,_,_,_'.split(','),
  '_,_,_,B,B,_,_,_,_,_,_,B,B,_,_,_'.split(','),
  '_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_'.split(','),
  '_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_'.split(','),
]
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
  '_,_,_,_,B,W,B,_,_,_,B,W,B,_,_,_'.split(','),
  '_,_,_,_,B,W,B,_,_,_,B,W,B,_,_,_'.split(','),
  '_,_,_,_,B,B,_,_,_,_,_,B,B,_,_,_'.split(','),
  '_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_'.split(','),
  '_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_'.split(','),
]
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
  'B,W,W,W,W,B,B,B,B,B,W,W,W,W,B,_'.split(','),
  'B,W,W,W,W,W,W,W,W,W,W,W,W,W,B,_'.split(','),
  '_,B,W,W,W,W,W,W,W,W,W,W,W,B,_,_'.split(','),
  '_,_,B,W,W,W,W,W,W,W,W,W,B,_,_,_'.split(','),
  'W,W,_,B,W,W,W,W,W,W,W,B,_,W,W,_'.split(','),
  'W,_,_,B,W,W,B,_,_,B,W,W,B,_,_,W'.split(','),
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
  'W,W,_,B,W,W,W,W,W,W,W,B,_,W,W,_'.split(','),
  'W,_,_,B,W,W,B,_,_,B,W,W,B,_,_,W'.split(','),
  '_,_,_,_,B,W,B,_,_,_,B,W,B,_,_,_'.split(','),
  '_,_,_,_,B,W,B,_,_,_,B,W,B,_,_,_'.split(','),
  '_,_,_,_,B,B,_,_,_,_,_,B,B,_,_,_'.split(','),
  '_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_'.split(','),
  '_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_'.split(','),
]
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
  '_,_,_,B,W,W,W,W,W,W,W,B,_,W,W,_'.split(','),
  '_,_,_,B,W,W,B,_,_,B,W,W,B,_,W,_'.split(','),
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
  '_,_,_,B,W,W,W,W,W,W,W,B,_,W,W,_'.split(','),
  '_,_,_,B,W,W,B,_,_,B,W,W,B,W,_,_'.split(','),
  '_,_,_,_,B,W,B,_,_,_,B,W,B,_,_,_'.split(','),
  '_,_,_,_,B,W,B,_,_,_,B,W,B,_,_,_'.split(','),
  '_,_,_,_,B,B,_,_,_,_,_,B,B,_,_,_'.split(','),
  '_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_'.split(','),
  '_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_'.split(','),
]
const MAME_SLEEP = [
  '_,_,B,B,B,_,_,_,_,_,B,B,B,_,_,_'.split(','),
  '_,_,B,G,B,_,_,_,_,_,B,G,B,_,_,_'.split(','),
  '_,_,B,B,B,B,B,B,B,B,B,B,B,_,_,_'.split(','),
  '_,B,W,W,W,W,W,W,W,W,W,W,W,B,_,_'.split(','),
  'B,W,W,W,W,W,W,W,W,W,W,W,W,W,B,_'.split(','),
  'B,W,W,W,W,W,W,W,W,W,W,W,W,W,B,_'.split(','),
  'B,W,W,W,W,W,W,W,W,W,W,W,W,W,B,_'.split(','),
  'B,W,W,B,B,W,W,W,W,W,B,B,W,W,B,_'.split(','),
  'B,W,W,W,W,W,W,W,W,W,W,W,W,W,B,_'.split(','),
  'B,W,W,W,W,W,W,B,B,W,W,W,W,W,B,_'.split(','),
  'B,W,W,W,W,W,W,W,W,W,W,W,W,W,B,_'.split(','),
  '_,B,W,W,W,W,W,W,W,W,W,W,W,B,_,_'.split(','),
  '_,_,B,W,W,W,W,W,W,W,W,W,B,_,_,_'.split(','),
  '_,_,_,B,W,W,W,W,W,W,W,B,_,_,_,_'.split(','),
  '_,_,_,B,W,W,B,_,_,B,W,W,B,_,_,_'.split(','),
  '_,_,_,_,B,W,B,_,_,B,W,B,_,_,_,_'.split(','),
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

function cloneGrid(g) { return g.map(r => [...r]) }
function paint(g, pts, v) { pts.forEach(([r, c]) => { if (g[r] && g[r][c] !== undefined) g[r][c] = v }) }

function withMoodFace(base, mood) {
  const g = cloneGrid(base)
  for (let r = 6; r <= 9; r++)
    for (let c = 3; c <= 11; c++)
      if (g[r] && g[r][c] === 'B') g[r][c] = 'W'
  if (mood === 'sleeping') {
    paint(g, [[7,3],[7,4],[7,10],[7,11]], 'B'); paint(g, [[9,7],[9,8]], 'B'); return g
  }
  if (mood === 'happy') {
    paint(g, [[6,3],[6,4],[7,3],[7,4],[6,10],[6,11],[7,10],[7,11]], 'B')
    paint(g, [[9,5],[9,6],[9,7],[9,8],[9,9],[9,10]], 'B'); return g
  }
  if (mood === 'thinking') {
    paint(g, [[7,3],[7,4]], 'B'); paint(g, [[6,10],[6,11],[7,10],[7,11]], 'B')
    paint(g, [[9,6],[9,7],[9,8]], 'B'); return g
  }
  paint(g, [[6,3],[6,4],[7,3],[7,4],[6,10],[6,11],[7,10],[7,11]], 'B')
  paint(g, [[9,6],[9,7],[9,8]], 'B'); return g
}

function blinkify(base) {
  const g = cloneGrid(base)
  for (let r = 6; r <= 7; r++)
    for (let c = 3; c <= 11; c++)
      if (g[r] && g[r][c] === 'B') g[r][c] = 'W'
  paint(g, [[7,3],[7,4],[7,10],[7,11]], 'B'); return g
}

// ─── Yawn face overlay ────────────────────────────────────────────────────────
// phase 0→1→0 : mouth goes dash → small oval → wide open oval, eyes squint
// Mouth row 9, cols 5–10 is the pixel budget.
// Eye zone: L=[6-7,3-4]  R=[6-7,10-11]
function withYawnFace(base, phase) {
  const g = cloneGrid(base)

  // Wipe face zone to white first
  for (let r = 6; r <= 10; r++)
    for (let c = 3; c <= 11; c++)
      if (g[r] && g[r][c] === 'B') g[r][c] = 'W'

  // Eyes: squint proportionally — at phase 0 full 2×2, at phase 1 just bottom row
  if (phase < 0.4) {
    // Full open eyes
    paint(g, [[6,3],[6,4],[7,3],[7,4],[6,10],[6,11],[7,10],[7,11]], 'B')
  } else if (phase < 0.75) {
    // Half-squint: only bottom row of each eye
    paint(g, [[7,3],[7,4],[7,10],[7,11]], 'B')
  } else {
    // Nearly shut: single pixel each eye (very cute sleepy squint)
    paint(g, [[7,3],[7,10]], 'B')
  }

  // Mouth: 5 stages of opening
  if (phase < 0.12) {
    // Tiny — normal dash
    paint(g, [[9,6],[9,7],[9,8]], 'B')
  } else if (phase < 0.3) {
    // Slightly open — wider dash
    paint(g, [[9,5],[9,6],[9,7],[9,8],[9,9]], 'B')
  } else if (phase < 0.55) {
    // Small oval — 2-row mouth with interior
    paint(g, [[9,5],[9,6],[9,7],[9,8],[9,9],[10,6],[10,7],[10,8]], 'B')
    // interior dark (already black from paint)
  } else if (phase < 0.8) {
    // Wide oval — 2 rows, 6 wide, dark interior
    paint(g, [[9,5],[9,6],[9,7],[9,8],[9,9],[9,10]], 'B')
    paint(g, [[10,5],[10,6],[10,7],[10,8],[10,9],[10,10]], 'B')
    // Interior pixels are W by default — paint them as a dark cavity colour
    // We use G (grey) to suggest the inside of the open mouth
    paint(g, [[9,6],[9,7],[9,8],[9,9],[10,6],[10,7],[10,8],[10,9]], 'G')
    // Re-outline the border
    paint(g, [[9,5],[9,10],[10,5],[10,10]], 'B')
  } else {
    // Full yawn — tallest 3-row oval, wide open
    paint(g, [[9,5],[9,6],[9,7],[9,8],[9,9],[9,10]], 'B')
    paint(g, [[10,5],[10,10]], 'B')
    paint(g, [[10,6],[10,7],[10,8],[10,9]], 'G')  // mouth cavity
    // row 11 — bottom lip
    if (g[11]) paint(g, [[11,6],[11,7],[11,8],[11,9]], 'B')
  }

  return g
}

// ─── Canvas ───────────────────────────────────────────────────────────────────
function usePixelCanvas(grid, flip, scale = PX) {
  const ref = useRef(null)
  useEffect(() => {
    const canvas = ref.current; if (!canvas || !grid) return
    const dpr = window.devicePixelRatio || 1
    const w = COLS * scale, h = ROWS * scale
    canvas.width = w * dpr; canvas.height = h * dpr
    canvas.style.width = w + 'px'; canvas.style.height = h + 'px'
    const ctx = canvas.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h); ctx.imageSmoothingEnabled = false
    if (flip) { ctx.save(); ctx.translate(w, 0); ctx.scale(-1, 1) }
    for (let r = 0; r < ROWS; r++)
      for (let c = 0; c < COLS; c++) {
        const color = PAL[grid[r]?.[c]?.trim()]; if (!color) continue
        ctx.fillStyle = color; ctx.fillRect(c * scale, r * scale, scale, scale)
      }
    if (flip) ctx.restore()
  }, [grid, flip, scale])
  return ref
}

function PixelCanvas({ grid, flip, mood, tickleGlow, startleGlow, bonking, sprinting }) {
  const ref = usePixelCanvas(grid, flip)
  const aura = { happy:'rgba(232,255,107,0.6)', thinking:'rgba(196,181,253,0.5)', sleeping:'rgba(147,197,253,0.4)', typing:'rgba(232,255,107,0.35)', idle:'rgba(255,255,255,0.15)' }[mood] || 'rgba(255,255,255,0.15)'
  let filter = `drop-shadow(0 2px 0 rgba(0,0,0,0.25))`
  if (startleGlow) filter = `drop-shadow(-3px 0 0 rgba(255,40,40,0.7)) drop-shadow(3px 0 0 rgba(0,200,255,0.7)) drop-shadow(0 0 16px rgba(251,146,60,0.95)) drop-shadow(0 2px 0 rgba(0,0,0,0.3))`
  else if (tickleGlow) filter = `drop-shadow(0 0 14px rgba(249,168,212,0.95)) drop-shadow(0 0 6px rgba(249,168,212,0.5)) drop-shadow(0 2px 0 rgba(0,0,0,0.25))`
  else if (bonking) filter = `drop-shadow(0 0 12px rgba(255,220,50,0.95)) drop-shadow(0 2px 0 rgba(0,0,0,0.25))`
  else filter = `drop-shadow(0 0 ${sprinting ? 8 : 5}px ${aura}) drop-shadow(0 2px 0 rgba(0,0,0,0.22))`
  return (
    <canvas ref={ref} style={{ display: 'block', imageRendering: 'pixelated', filter, transition: startleGlow || tickleGlow ? 'none' : 'filter 0.4s ease' }} />
  )
}

// ─── Particle system ──────────────────────────────────────────────────────────
let _pid = 0
function Particles({ burst, cx, cy, type }) {
  const [ps, setPs] = useState([])
  const prev = useRef(0)
  useEffect(() => {
    if (burst === 0 || burst === prev.current) return
    prev.current = burst
    const COLS_MAP = {
      tickle:    ['#f9a8d4','#fb7185','#fda4af','#fbbf24','#fff','#e8ff6b'],
      bonk:      ['#fbbf24','#fde68a','#fff','#fb923c'],
      happy:     ['#e8ff6b','#a3e635','#fff','#fbbf24'],
      rejection: ['#fb923c','#f87171','#fbbf24','#fff','#ef4444'],
      game:      ['#e8ff6b','#a3e635','#93c5fd','#f9a8d4','#fff'],
      checkin:   ['#93c5fd','#bfdbfe','#fff','#e8ff6b'],
    }
    const cols = COLS_MAP[type] || ['#e8ff6b']
    const count = type === 'tickle' ? 14 : type === 'rejection' ? 18 : type === 'game' ? 16 : 10
    const chars = type === 'tickle'    ? ['♥','★','!','~','♡','✦']
                : type === 'rejection' ? ['✕','!','!!','→','NEXT','💢','★']
                : type === 'game'      ? ['★','✦','♥','!','~','✧','♡']
                : ['★','✦','!','✧']
    const newPs = Array.from({ length: count }, () => {
      const angle = Math.random() * Math.PI * 2
      const spd = 2.5 + Math.random() * 4
      const useChar = Math.random() > 0.45
      return {
        id: _pid++, x: cx, y: cy,
        vx: Math.cos(angle) * spd, vy: Math.sin(angle) * spd - 2.5,
        life: 1, decay: 0.045 + Math.random() * 0.04,
        size: useChar ? 8 + Math.random() * 8 : 3 + Math.random() * 5,
        color: cols[Math.floor(Math.random() * cols.length)],
        char: useChar ? chars[Math.floor(Math.random() * chars.length)] : null,
        rot: Math.random() * 360, rotV: (Math.random() - 0.5) * 20,
      }
    })
    setPs(prev2 => [...prev2, ...newPs])
  }, [burst])

  useEffect(() => {
    if (ps.length === 0) return
    const raf = requestAnimationFrame(() => {
      setPs(prev2 => prev2
        .map(p => ({ ...p, x: p.x + p.vx, y: p.y + p.vy, vy: p.vy + 0.18, life: p.life - p.decay, rot: p.rot + p.rotV }))
        .filter(p => p.life > 0))
    })
    return () => cancelAnimationFrame(raf)
  }, [ps])

  if (ps.length === 0) return null
  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'visible', zIndex: 25 }}>
      {ps.map(p => (
        <div key={p.id} style={{
          position: 'absolute',
          left: p.x, bottom: -p.y,
          opacity: p.life,
          transform: `translate(-50%, 50%) rotate(${p.rot}deg)`,
          color: p.color,
          fontSize: p.size,
          width: p.char ? 'auto' : p.size,
          height: p.char ? 'auto' : p.size,
          background: p.char ? 'none' : p.color,
          borderRadius: p.char ? 0 : '50%',
          fontFamily: 'monospace',
          fontWeight: 900,
          lineHeight: 1,
          textShadow: p.char ? `0 0 8px ${p.color}` : 'none',
          pointerEvents: 'none',
        }}>{p.char || ''}</div>
      ))}
    </div>
  )
}

// ─── Motion ghost trail ───────────────────────────────────────────────────────
function Trail({ positions, active }) {
  if (!active || positions.length < 2) return null
  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'visible' }}>
      {positions.map((p, i) => {
        const a = (i / positions.length) * 0.35
        const s = 0.3 + i * 0.12
        return (
          <div key={i} style={{
            position: 'absolute',
            left: 8 + p.x,
            bottom: -2,
            width: COLS * PX,
            height: ROWS * PX * 0.5,
            background: `radial-gradient(ellipse at 50% 90%, rgba(232,255,107,${a}) 0%, transparent 70%)`,
            transform: `scaleX(${s}) scaleY(${s * 0.5})`,
            transformOrigin: 'bottom center',
            borderRadius: '50%',
            pointerEvents: 'none',
          }} />
        )
      })}
    </div>
  )
}

// ─── Decorative floaties for happy ───────────────────────────────────────────
function Stars({ active }) {
  if (!active) return null
  const items = ['★','✦','✧','★']
  return items.map((s, i) => (
    <div key={i} style={{
      position: 'absolute',
      top: -6 + (i % 2) * 3,
      left: i < 2 ? -10 - i * 7 : COLS * PX + 4 + (i - 2) * 7,
      fontSize: 8 + (i % 2) * 5,
      color: '#e8ff6b',
      textShadow: '0 0 10px #e8ff6b, 0 0 4px #e8ff6b',
      animation: `rackStar ${0.75 + i * 0.18}s ease-in-out ${i * 0.22}s infinite alternate`,
      pointerEvents: 'none',
    }}>{s}</div>
  ))
}

// ─── Speech bubble ────────────────────────────────────────────────────────────
const MESSAGES = {
  idle:      ['find ur fit!','hire me plz','u got this!','*yawn*','checking JDs','resume go brr','...','hello fren'],
  typing:    ['ooh!','tell me more','interesting!','paste it!','on it!','i see u!','!!','let\'s go!!'],
  thinking:  ['. . .','hmm...','thinking...','crunching!','almost!','big brain','computing','🧠'],
  happy:     ['found it!!','great match!','yay!!! :D','hired!!','boom!!','LETS GO!!','ur so good','★★★'],
  sleeping:  ['zzz...','zz~','💤','*snore*','dreaming~'],
  tickle:    ['hehe!!','stop it!!','hehehe :3','nO tickles!','*giggle*','quit it!!','heHEHE!!','i cant!!','haha omg','staaahp!!'],
  startle:   ['woah!!','big one!!','👀!!','thats a lot!','omg omg!!','so many words','😱!!','hold on!!'],
  sleepHover:["don't. you. dare.",'i sense u...','go away...','im warning u...','not now fren','...i can hear u','leave me alone','shhhhhh!!','im SLEEPING','😤 zz'],
  bonk:      ['OW!!','BONK!','*crash*','oof!','💥','MY HEAD!!','wall!!'],
  yawn:      ['*yaaawn*','so sleepy~','haAAHH~','mmMMhh~','yawn~','zzz soon...','so tired~'],
  checkin:   ['hey. you okay?','take a breath fren','ur doing great actually','still here with u','proud of u fr','u got this, i promise','how u holding up?','remember to drink water','this is hard. u r doing it.','u r not alone in this','one step at a time fren','the right job is out there'],
  rejection: ["their loss!!","NEXT!!","they don't deserve u","onward!!","more for someone better","not ur team anyway","their bad!!","u dodged a bullet","on to better things!!","NEXT NEXT NEXT","honestly? good riddance","u r too good for them"],
  affirmation: ['today could be the day','you built something real','the right one is reading ur resume rn','every application is practice','ur more qualified than u think','someone out there needs exactly u','keep going. seriously.','ur resume is better than u think','belief is part of the strategy','ur effort is not invisible'],
  gameCatch:   ['gotcha!!','too slow!!','hehe found me','u win this round','nice reflexes!!','okay okay u got me','♥ u found me','peek-a-boo!!'],
  gameMiss:    ['missed me!!','too fast for u!!','try again fren','bzzzt! nope!!','hehe!!','so close tho!!'],
  timeNight:   ['why r u awake rn','go to sleep fren','no good emails after midnight','rest is productive too','ur brain needs sleep','seriously go to bed','the jobs will still be there tomorrow','ur eyes r tired, i can tell'],
  timeMorning: ['early bird!!','fresh start energy','morning fren!!','new day new opportunity','i believe in ur morning','the early applicant gets the job... maybe','rise and grind fren','good morning!! let\'s go!!'],
  timeAfternoon: ['afternoon grind!!','peak hours fren','recruiters r online rn','good time to apply!!','keeping u company','how many apps today?','u r in the zone','afternoon energy!!'],
  timeFriday:  ['nobody\'s hiring today lol... but also u never know','it\'s friday!! apply anyway','friday energy different','weekend soon!! but first: apply','TGIF but also apply','friday apps hit different'],
  timeWeekend: ['job hunting on a weekend??','ur dedicated fr','even weekends count','hustle mode activated','rest is valid too fren','sunday scaries?? i got u'],
}
function pickMsg(mood) { const l = MESSAGES[mood] || MESSAGES.idle; return l[Math.floor(Math.random() * l.length)] }

// ─── Time-aware greeting ──────────────────────────────────────────────────────
function getTimeMsg() {
  const now = new Date()
  const h = now.getHours()
  const day = now.getDay() // 0=Sun, 6=Sat
  const isFri = day === 5
  const isWeekend = day === 0 || day === 6
  if (isWeekend) return { key: 'timeWeekend', color: '#c4b5fd' }
  if (isFri && h >= 12) return { key: 'timeFriday', color: '#fbbf24' }
  if (h >= 22 || h < 5)  return { key: 'timeNight',   color: '#93c5fd' }
  if (h >= 5  && h < 11) return { key: 'timeMorning', color: '#d4f04a' }
  return { key: 'timeAfternoon', color: 'rgba(255,255,255,0.75)' }
}

// Particle color palette for rejection
const REJECTION_COLS = ['#fb923c','#f87171','#fbbf24','#fff','#ef4444']

function Bubble({ text, color, shake }) {
  return (
    <div style={{
      position: 'absolute', bottom: ROWS * PX + 10, left: '50%',
      background: '#050505', border: `2px solid ${color}`, borderRadius: 4,
      padding: '3px 8px', fontSize: 10,
      fontFamily: '"Courier New", Courier, monospace', fontWeight: 900,
      color, whiteSpace: 'nowrap', letterSpacing: '0.06em',
      pointerEvents: 'none',
      boxShadow: `0 0 16px ${color}99, 0 0 5px ${color}55`,
      animation: `rackPop 0.15s steps(3) both${shake ? ', rackShake 0.32s ease both' : ''}`,
      zIndex: 30,
    }}>
      {text}
      <div style={{
        position: 'absolute', bottom: -7, left: '50%', transform: 'translateX(-50%)',
        width: 0, height: 0, borderLeft: '5px solid transparent',
        borderRight: '5px solid transparent', borderTop: `7px solid ${color}`,
      }} />
    </div>
  )
}

function ZZZ() {
  return ['z','z','Z'].map((c, i) => (
    <div key={i} style={{
      position: 'absolute', bottom: ROWS * PX + 4 + i * 11,
      left: COLS * PX * 0.56 + i * 7, fontSize: 9 + i * 3, fontWeight: 900,
      fontFamily: 'monospace', color: '#93c5fd',
      textShadow: '0 0 8px #93c5fd99',
      animation: `rackZzz 2.1s ease-out ${i * 0.65}s infinite`,
      opacity: 0, pointerEvents: 'none',
    }}>{c}</div>
  ))
}

// Scanline CRT overlay
function Scanlines() {
  return <div style={{
    position: 'absolute', inset: 0, pointerEvents: 'none',
    background: 'repeating-linear-gradient(0deg, transparent, transparent 1.5px, rgba(0,0,0,0.07) 1.5px, rgba(0,0,0,0.07) 3px)',
    borderRadius: 2,
  }} />
}

// ─── Main ─────────────────────────────────────────────────────────────────────
export default function RackCreature({ mood = 'idle', startle = 0, forceBubble = null, rejection = 0, onGameScore = null }) {
  const wrapRef = useRef(null)
  const [maxX, setMaxX] = useState(0)
  useEffect(() => {
    const parent = wrapRef.current?.parentElement; if (!parent) return
    const W = COLS * PX + 16
    const measure = () => setMaxX(Math.max(0, parent.getBoundingClientRect().width - W))
    measure()
    const obs = new ResizeObserver(measure); obs.observe(parent)
    return () => obs.disconnect()
  }, [])

  const [x, setX]           = useState(0)
  const [flip, setFlip]     = useState(false)
  const [frame, setFrame]   = useState(0)
  const [blink, setBlink]   = useState(false)
  const [bubble, setBubble] = useState(null)
  const [offY, setOffY]     = useState(0)
  const [sx, setSx]         = useState(1)  // scaleX
  const [sy, setSy]         = useState(1)  // scaleY
  const [grid, setGrid]     = useState(() => withMoodFace(MAME_IDLE_A, 'idle'))
  const [tickled, setTickled]   = useState(false)
  const [startled, setStartled] = useState(false)
  const [bonking, setBonking]   = useState(false)
  const [sprinting, setSprinting] = useState(false)
  const [sleepHov, setSleepHov]   = useState(false)
  const [trail, setTrail]         = useState([])
  const [burst, setBurst]         = useState(0)
  const [burstType, setBurstType] = useState('tickle')
  const [burstPos, setBurstPos]   = useState({ x: 20, y: 20 })
  // Yawn animation
  const [yawnPhase, setYawnPhase] = useState(0)  // 0=closed, 1=wide open
  const [yawning, setYawning]     = useState(false)
  const yawnRafRef   = useRef(null)
  const yawnTimerRef = useRef(null)
  const yawnBubbleFiredRef = useRef(false)

  // Feature: daily affirmation (once per session)
  const affirmationDoneRef = useRef(false)

  // Feature: idle check-in
  const lastActivityRef   = useRef(Date.now())
  const checkinTimerRef   = useRef(null)
  const checkinDoneRef    = useRef(false)   // one check-in per idle stretch

  // Feature: mini catch game
  const [gameActive, setGameActive]     = useState(false)
  const [gameTarget, setGameTarget]     = useState(null)   // { x, y } creature position to catch
  const [gameScore, setGameScore]       = useState(0)
  const [showGameScore, setShowGameScore] = useState(false)
  const gameTimerRef  = useRef(null)
  const gameRoundRef  = useRef(0)
  const clickCountRef = useRef(0)         // rapid clicks to trigger game

  // Feature: rejection ritual
  const prevRejection = useRef(0)

  const tickleRef  = useRef(null)
  const startleRef = useRef(null)
  const bonkRef    = useRef(null)
  const hoverRef   = useRef(null)
  const forceRef   = useRef(null)
  const xRef       = useRef(0)
  const dirRef     = useRef(1)
  const moodRef    = useRef(mood)
  const rafRef     = useRef(null)
  const tsRef      = useRef(null)
  const frameRef   = useRef(0)
  const bonkDirRef = useRef(0)

  useEffect(() => { moodRef.current = mood }, [mood])

  // Squash helper
  const squash = (sx1, sy1, sx2, sy2, t2, sx3, sy3, t3) => {
    setSx(sx1); setSy(sy1)
    setTimeout(() => { setSx(sx2); setSy(sy2) }, t2)
    setTimeout(() => { setSx(sx3 ?? 1); setSy(sy3 ?? 1) }, t3)
  }

  // Breathing idle
  const breathRef = useRef(0); const breathDirRef = useRef(1)
  useEffect(() => {
    if (mood !== 'idle' && mood !== 'sleeping') return
    const iv = setInterval(() => {
      breathRef.current += breathDirRef.current * 0.005
      if (breathRef.current > 1) breathDirRef.current = -1
      if (breathRef.current < 0) breathDirRef.current = 1
      const t = breathRef.current
      setSy(1 + Math.sin(t * Math.PI) * 0.028)
      setSx(1 - Math.sin(t * Math.PI) * 0.016)
    }, 40)
    return () => { clearInterval(iv); setSx(1); setSy(1) }
  }, [mood])

  // Startle
  const prevStartle = useRef(0)
  useEffect(() => {
    if (startle === 0 || startle === prevStartle.current) return
    prevStartle.current = startle
    if (startleRef.current) clearTimeout(startleRef.current)
    setStartled(true)
    squash(1.25, 0.7, 0.88, 1.18, 80, 1, 1, 300)
    setBubble({ text: pickMsg('startle'), color: '#fb923c' })
    startleRef.current = setTimeout(() => { setStartled(false); setBubble(null) }, 1000)
  }, [startle])

  // Force bubble
  useEffect(() => {
    if (!forceBubble || tickled) return
    clearTimeout(forceRef.current)
    setBubble({ text: forceBubble.text, color: forceBubble.color || '#d4f04a' })
    forceRef.current = setTimeout(() => setBubble(null), forceBubble.duration || 3200)
    return () => clearTimeout(forceRef.current)
  }, [forceBubble])

  const handleSleepHoverEnter = () => {
    if (mood !== 'sleeping' || tickled) return
    setSleepHov(true)
    setBubble({ text: pickMsg('sleepHover'), color: '#fbbf24' })
  }
  const handleSleepHoverLeave = () => {
    if (!sleepHov) return
    setSleepHov(false)
    hoverRef.current = setTimeout(() => setBubble(null), 600)
  }

  const effectiveMood = (startled || tickled || gameActive) ? (gameActive ? 'happy' : 'happy') : mood
  useEffect(() => {
    const base = SPRITES[effectiveMood]?.[frame] ?? MAME_IDLE_A
    if (yawning && effectiveMood === 'idle') {
      setGrid(withYawnFace(base, yawnPhase))
    } else {
      setGrid(blink ? blinkify(base) : withMoodFace(base, effectiveMood))
    }
  }, [effectiveMood, frame, blink, yawning, yawnPhase])

  const prevMood = useRef(mood)
  useEffect(() => {
    if (mood === prevMood.current) return
    prevMood.current = mood
    if (sleepHov) setSleepHov(false)
    const colors = { happy:'#d4f04a', thinking:'#c4b5fd', sleeping:'#93c5fd', typing:'#d4f04a', idle:'rgba(255,255,255,0.7)' }
    setBubble({ text: pickMsg(mood), color: colors[mood] || '#d4f04a' })
    squash(0.9, 1.14, 1.06, 0.94, 100, 1, 1, 230)
    const t = setTimeout(() => setBubble(null), 2400); return () => clearTimeout(t)
  }, [mood])

  useEffect(() => {
    if (mood !== 'idle') return
    const go = () => { setBubble({ text: pickMsg('idle'), color: 'rgba(255,255,255,0.65)' }); setTimeout(() => setBubble(null), 2200) }
    const t = setInterval(go, 8000 + Math.random() * 6000); return () => clearInterval(t)
  }, [mood])

  useEffect(() => {
    let t
    const go = () => { t = setTimeout(() => { setBlink(true); setTimeout(() => { setBlink(false); go() }, 120) }, 1800 + Math.random() * 3200) }
    go(); return () => clearTimeout(t)
  }, [])

  // Yawn — fires randomly during idle only
  // Curve: ease-in to peak (0→1 over 1.4s), hold 0.5s, ease-out (1→0 over 1.0s)
  const YAWN_IN  = 1400   // ms to open
  const YAWN_HOLD = 500   // ms held open
  const YAWN_OUT  = 1000  // ms to close
  useEffect(() => {
    if (mood !== 'idle') {
      // Cancel any in-progress yawn when mood changes
      cancelAnimationFrame(yawnRafRef.current)
      clearTimeout(yawnTimerRef.current)
      setYawning(false); setYawnPhase(0)
      return
    }
    const schedule = () => {
      yawnTimerRef.current = setTimeout(() => {
        // Don't yawn if already doing something exciting
        if (tickleRef.current || startleRef.current || bonkRef.current) { schedule(); return }
        yawnBubbleFiredRef.current = false
        setYawning(true)
        const startTs = performance.now()
        const animate = (now) => {
          const elapsed = now - startTs
          let phase
          if (elapsed < YAWN_IN) {
            // ease-in-out open
            const t = elapsed / YAWN_IN
            phase = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t
          } else if (elapsed < YAWN_IN + YAWN_HOLD) {
            phase = 1
          } else {
            const t = Math.min(1, (elapsed - YAWN_IN - YAWN_HOLD) / YAWN_OUT)
            phase = 1 - (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t)
          }
          setYawnPhase(phase)

          // Fire bubble once when mouth starts opening
          if (!yawnBubbleFiredRef.current && elapsed > 200) {
            yawnBubbleFiredRef.current = true
            setBubble({ text: pickMsg('yawn'), color: '#93c5fd' })
            setTimeout(() => setBubble(null), YAWN_IN + YAWN_HOLD)
          }

          // Subtle stretch at peak — scaleY handled via yawnPhase → body scaleY below
          if (elapsed < YAWN_IN + YAWN_HOLD + YAWN_OUT) {
            yawnRafRef.current = requestAnimationFrame(animate)
          } else {
            setYawnPhase(0); setYawning(false)
            schedule()  // schedule the next one
          }
        }
        yawnRafRef.current = requestAnimationFrame(animate)
      }, 14000 + Math.random() * 12000)
    }
    schedule()
    return () => {
      cancelAnimationFrame(yawnRafRef.current)
      clearTimeout(yawnTimerRef.current)
    }
  }, [mood]) // eslint-disable-line

  // ── Feature 1: Daily affirmation — fires once per session, 1.5s after mount ──
  useEffect(() => {
    const t = setTimeout(() => {
      if (affirmationDoneRef.current) return
      affirmationDoneRef.current = true
      // Time-aware greeting first, then affirmation
      const { key, color } = getTimeMsg()
      setBubble({ text: pickMsg(key), color })
      setTimeout(() => {
        setBubble(null)
        setTimeout(() => {
          setBubble({ text: pickMsg('affirmation'), color: '#e8ff6b' })
          squash(0.92, 1.1, 1.04, 0.97, 100, 1, 1, 220)
          setTimeout(() => setBubble(null), 3800)
        }, 600)
      }, 2800)
    }, 1500)
    return () => clearTimeout(t)
  }, []) // eslint-disable-line

  // ── Feature 2: Idle check-in — fires after 3 min of no activity ──
  // Track activity: reset timer on any user event
  useEffect(() => {
    const bump = () => {
      lastActivityRef.current = Date.now()
      checkinDoneRef.current = false   // reset so next idle stretch can check in again
    }
    window.addEventListener('mousemove', bump, { passive: true })
    window.addEventListener('keydown', bump, { passive: true })
    window.addEventListener('click', bump, { passive: true })
    return () => {
      window.removeEventListener('mousemove', bump)
      window.removeEventListener('keydown', bump)
      window.removeEventListener('click', bump)
    }
  }, [])

  useEffect(() => {
    const CHECKIN_MS = 3 * 60 * 1000  // 3 minutes
    const poll = () => {
      checkinTimerRef.current = setTimeout(() => {
        const idle = Date.now() - lastActivityRef.current
        if (idle >= CHECKIN_MS && !checkinDoneRef.current && mood === 'idle') {
          checkinDoneRef.current = true
          // Walk to center, stop, deliver message
          const centerX = Math.max(0, (maxX / 2))
          xRef.current = centerX; setX(centerX)
          dirRef.current = 1; setFlip(false)
          setTimeout(() => {
            setBubble({ text: pickMsg('checkin'), color: '#93c5fd' })
            squash(0.96, 1.06, 1.02, 0.98, 120, 1, 1, 280)
            setBurstType('checkin')
            setBurstPos({ x: (COLS * PX) / 2, y: ROWS * PX * 0.7 })
            setBurst(n => n + 1)
            setTimeout(() => setBubble(null), 4000)
          }, 400)
        }
        poll()  // reschedule
      }, 30000)  // check every 30s
    }
    poll()
    return () => clearTimeout(checkinTimerRef.current)
  }, [mood, maxX]) // eslint-disable-line

  // ── Feature 3: Rejection ritual ──
  useEffect(() => {
    if (rejection === 0 || rejection === prevRejection.current) return
    prevRejection.current = rejection
    // Rage shake + particles + bubble
    setStartled(false)  // clear any existing
    if (startleRef.current) clearTimeout(startleRef.current)
    // Custom rage animation: violent shake using squash sequence
    squash(1.18, 0.78, 0.82, 1.22, 60, 1.14, 0.86, 130)
    setTimeout(() => squash(0.88, 1.14, 1.06, 0.95, 80, 1, 1, 200), 220)
    setBubble({ text: pickMsg('rejection'), color: '#fb923c' })
    setBurstType('rejection')
    setBurstPos({ x: (COLS * PX) / 2, y: ROWS * PX * 0.4 })
    setBurst(n => n + 1)
    // Second burst slightly offset
    setTimeout(() => {
      setBurstPos({ x: (COLS * PX) * 0.3, y: ROWS * PX * 0.6 })
      setBurst(n => n + 1)
    }, 180)
    startleRef.current = setTimeout(() => {
      setBubble(null)
      // Follow-up comfort message after the rage
      setTimeout(() => {
        setBubble({ text: pickMsg('checkin'), color: '#93c5fd' })
        setTimeout(() => setBubble(null), 2800)
      }, 400)
    }, 2200)
  }, [rejection]) // eslint-disable-line

  // ── Feature 4: Mini catch game ──
  // Triggered by 3 rapid clicks (within 1.2s)
  const lastClickRef = useRef(0)
  const handleTickle = () => {
    if (tickleRef.current) clearTimeout(tickleRef.current)
    if (hoverRef.current) clearTimeout(hoverRef.current)

    // Rapid click counter for game trigger
    const now = Date.now()
    if (now - lastClickRef.current < 1200) {
      clickCountRef.current += 1
    } else {
      clickCountRef.current = 1
    }
    lastClickRef.current = now

    if (clickCountRef.current >= 3 && !gameActive && mood === 'idle') {
      clickCountRef.current = 0
      startGame()
      return
    }

    // Check if this click catches the creature during game
    if (gameActive) {
      handleGameCatch()
      return
    }

    setSleepHov(false); setTickled(true)
    squash(1.12, 0.82, 0.92, 1.1, 80, 1, 1, 220)
    setBubble({ text: pickMsg('tickle'), color: '#f9a8d4' })
    setBurstType('tickle'); setBurstPos({ x: (COLS * PX) / 2, y: (ROWS * PX) / 2 }); setBurst(n => n + 1)
    tickleRef.current = setTimeout(() => { setTickled(false); setBubble(null) }, 900)
  }

  const startGame = () => {
    setGameActive(true)
    setGameScore(0)
    gameRoundRef.current = 0
    setBubble({ text: 'CATCH ME if u can!! 🏃', color: '#e8ff6b' })
    squash(0.85, 1.18, 1.08, 0.94, 90, 1, 1, 220)
    setTimeout(() => { setBubble(null); runGameRound() }, 1400)
  }

  const runGameRound = () => {
    if (gameRoundRef.current >= 5) { endGame(); return }
    gameRoundRef.current += 1
    // Teleport to a random position
    const newX = Math.floor(Math.random() * Math.max(1, maxX))
    xRef.current = newX; setX(newX)
    setFlip(Math.random() > 0.5)
    setGameTarget({ x: newX })
    // Wiggle to announce location
    squash(1.15, 0.85, 0.9, 1.12, 70, 1, 1, 180)
    // Auto-miss timer: if not caught in 2s, move again
    clearTimeout(gameTimerRef.current)
    gameTimerRef.current = setTimeout(() => {
      if (gameActive) {
        setBubble({ text: pickMsg('gameMiss'), color: '#fb923c' })
        squash(1.0, 1.0, 1.0, 1.0, 50, 1, 1, 100) // tiny taunt shake via tickle
        setTimeout(() => { setBubble(null); runGameRound() }, 800)
      }
    }, 2200)
  }

  const handleGameCatch = () => {
    clearTimeout(gameTimerRef.current)
    setGameScore(s => s + 1)
    setBubble({ text: pickMsg('gameCatch'), color: '#e8ff6b' })
    setBurstType('game')
    setBurstPos({ x: (COLS * PX) / 2, y: (ROWS * PX) / 2 })
    setBurst(n => n + 1)
    squash(0.8, 1.2, 1.1, 0.9, 70, 1, 1, 200)
    setTimeout(() => { setBubble(null); runGameRound() }, 900)
  }

  const endGame = () => {
    setGameActive(false)
    setGameTarget(null)
    clearTimeout(gameTimerRef.current)
    const score = gameScore
    setShowGameScore(true)
    const finalMsg = score >= 4 ? `${score}/5 u r incredible!!`
                   : score >= 2 ? `${score}/5 not bad fren!!`
                   : `${score}/5 ...i let u win a little`
    setBubble({ text: finalMsg, color: '#e8ff6b' })
    squash(0.88, 1.15, 1.06, 0.96, 100, 1, 1, 240)
    setBurstType('game')
    setBurstPos({ x: (COLS * PX) / 2, y: (ROWS * PX) / 2 })
    setBurst(n => n + 1)
    if (onGameScore) onGameScore(score)
    setTimeout(() => { setBubble(null); setShowGameScore(false) }, 3000)
  }

  // Movement
  useEffect(() => {
    if (maxX <= 0) return
    const SPEED = { idle: 0.38, typing: 0.95, thinking: 0, happy: 1.55, sleeping: 0 }
    const STEP  = { idle: 320, typing: 140, thinking: 9999, happy: 90, sleeping: 9999 }
    let lastStep = 0, trailHist = []
    const tick = (ts) => {
      if (!tsRef.current) tsRef.current = ts
      const dt = Math.min(ts - tsRef.current, 50); tsRef.current = ts
      const m = moodRef.current, spd = SPEED[m] ?? 0.38
      const isSprinting = spd >= 1.5
      if (spd > 0) {
        let nx = xRef.current + spd * (dt / 16.67) * dirRef.current
        // Wall bonk
        const hitWall = (nx >= maxX && bonkDirRef.current !== 1) || (nx <= 0 && bonkDirRef.current !== -1)
        if (nx >= maxX) { nx = maxX; dirRef.current = -1; setFlip(true); bonkDirRef.current = 1 }
        else if (nx <= 0) { nx = 0; dirRef.current = 1; setFlip(false); bonkDirRef.current = -1 }
        else bonkDirRef.current = 0
        if (hitWall && !bonkRef.current) {
          setBonking(true)
          setBubble({ text: pickMsg('bonk'), color: '#fbbf24' })
          squash(0.6, 1.35, 1.12, 0.88, 70, 1, 1, 220)
          if (isSprinting) {
            setBurstType('bonk')
            setBurstPos({ x: nx >= maxX ? COLS * PX : 0, y: ROWS * PX * 0.5 })
            setBurst(n => n + 1)
          }
          bonkRef.current = setTimeout(() => { setBonking(false); setBubble(null); bonkRef.current = null }, 650)
        }
        xRef.current = nx; setX(nx); setSprinting(isSprinting)
        if (isSprinting) {
          trailHist = [{ x: nx }, ...trailHist.slice(0, 5)]; setTrail([...trailHist])
        } else { trailHist = []; setTrail([]) }
        if (ts - lastStep > (STEP[m] ?? 320)) { frameRef.current = 1 - frameRef.current; setFrame(frameRef.current); lastStep = ts }
      } else { setSprinting(false); setTrail([]) }
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => { cancelAnimationFrame(rafRef.current); tsRef.current = null }
  }, [maxX])

  // Vertical animations per mood
  useEffect(() => {
    if (mood === 'happy') {
      let pos = 0, dir = -1
      const iv = setInterval(() => {
        pos += dir * 2.4
        if (pos <= -11) { dir = 1; squash(0.9, 1.12, 1, 1, 80) }
        if (pos >= 0) dir = -1
        setOffY(Math.max(-11, Math.min(0, pos)))
      }, 20)
      return () => { clearInterval(iv); setOffY(0) }
    }
    if (mood === 'sleeping') {
      let pos = 0, dir = 1
      const iv = setInterval(() => {
        pos += dir * 0.16; if (pos >= 2.5) dir = -1; if (pos <= 0) dir = 1; setOffY(pos)
      }, 95)
      return () => { clearInterval(iv); setOffY(0) }
    }
    if (mood === 'thinking') {
      let t = 0
      const iv = setInterval(() => { t += 0.055; setOffY(Math.sin(t) * 1.4) }, 30)
      return () => { clearInterval(iv); setOffY(0) }
    }
    if (mood === 'typing') {
      let t = 0
      const iv = setInterval(() => { t += 0.2; setOffY(Math.sin(t) * 1.8) }, 26)
      return () => { clearInterval(iv); setOffY(0) }
    }
    setOffY(0)
  }, [mood])

  const SH = ROWS * PX, SW = COLS * PX

  return (
    <>
      <style>{`
        @keyframes rackPop {
          0%  { opacity:0; transform:translateX(-50%) scale(0.35); }
          60% { transform:translateX(-50%) scale(1.12); }
          100%{ opacity:1; transform:translateX(-50%) scale(1); }
        }
        @keyframes rackShake {
          0%,100%{ transform:translateX(-50%) rotate(0deg); }
          20%{ transform:translateX(calc(-50% - 2px)) rotate(-5deg); }
          40%{ transform:translateX(calc(-50% + 2px)) rotate(5deg); }
          60%{ transform:translateX(calc(-50% - 1px)) rotate(-2deg); }
          80%{ transform:translateX(calc(-50% + 1px)) rotate(2deg); }
        }
        @keyframes rackZzz {
          0%  { opacity:0; transform:translateY(0) scale(0.7); }
          20% { opacity:0.9; transform:translateY(-4px) scale(1); }
          80% { opacity:0.7; }
          100%{ opacity:0; transform:translateY(-28px) scale(0.75); }
        }
        @keyframes rackJump {
          0%  { transform:translateY(0)    scaleX(1)    scaleY(1);    }
          15% { transform:translateY(-6px) scaleX(0.82) scaleY(1.18); }
          35% { transform:translateY(-22px)scaleX(0.78) scaleY(1.22); }
          55% { transform:translateY(-8px) scaleX(1.12) scaleY(0.88); }
          70% { transform:translateY(-2px) scaleX(1.04) scaleY(0.97); }
          85% { transform:translateY(0)    scaleX(0.97) scaleY(1.04); }
          100%{ transform:translateY(0)    scaleX(1)    scaleY(1);    }
        }
        @keyframes rackTickle {
          0%  { transform:rotate(0deg)   translateY(0)   scaleX(1);    }
          12% { transform:rotate(-11deg) translateY(-5px)scaleX(0.88); }
          25% { transform:rotate(11deg)  translateY(-7px)scaleX(1.12); }
          37% { transform:rotate(-8deg)  translateY(-4px)scaleX(0.92); }
          50% { transform:rotate(8deg)   translateY(-3px)scaleX(1.08); }
          65% { transform:rotate(-4deg)  translateY(-1px)scaleX(0.97); }
          80% { transform:rotate(4deg)   translateY(0)   scaleX(1.03); }
          100%{ transform:rotate(0deg)   translateY(0)   scaleX(1);    }
        }
        @keyframes rackStar {
          0%  { transform:scale(0.75) rotate(-12deg); opacity:0.55; }
          100%{ transform:scale(1.25) rotate(12deg);  opacity:1;    }
        }
        @keyframes rackAura {
          0%,100%{ opacity:0.5; transform:scale(1); }
          50%    { opacity:0.9; transform:scale(1.1); }
        }
        @keyframes rackAuraSlow {
          0%,100%{ opacity:0.3; }
          50%    { opacity:0.65; }
        }
        @keyframes rackGameRing {
          0%  { opacity:0.5; transform:scale(1);    box-shadow:0 0 8px #e8ff6b66; }
          100%{ opacity:1;   transform:scale(1.06); box-shadow:0 0 18px #e8ff6baa; }
        }
      `}</style>

      <div ref={wrapRef} style={{ position:'absolute', top:-(SH+2), left:0, right:0, height:SH, pointerEvents:'none', overflow:'visible', zIndex:10 }}>

        {/* Motion trail */}
        <Trail positions={trail} active={sprinting} />

        {/* Mood auras */}
        {effectiveMood === 'happy' && (
          <div style={{ position:'absolute', left:8+x-12, bottom:-6, width:SW+24, height:SH*0.65,
            background:'radial-gradient(ellipse at 50% 85%, rgba(232,255,107,0.3) 0%, transparent 68%)',
            animation:'rackAura 0.75s ease-in-out infinite', pointerEvents:'none' }} />
        )}
        {effectiveMood === 'thinking' && (
          <div style={{ position:'absolute', left:8+x-6, bottom:-2, width:SW+12, height:SH*0.75,
            background:'radial-gradient(ellipse at 50% 60%, rgba(196,181,253,0.22) 0%, transparent 65%)',
            animation:'rackAuraSlow 1.5s ease-in-out infinite', pointerEvents:'none' }} />
        )}
        {effectiveMood === 'sleeping' && (
          <div style={{ position:'absolute', left:8+x-4, bottom:-2, width:SW+8, height:SH*0.6,
            background:'radial-gradient(ellipse at 50% 70%, rgba(147,197,253,0.2) 0%, transparent 70%)',
            animation:'rackAuraSlow 2.8s ease-in-out infinite', pointerEvents:'none' }} />
        )}

        {/* Particle origin (follows creature) */}
        <div style={{ position:'absolute', left:8+x, bottom:0, width:SW, height:SH, pointerEvents:'none' }}>
          <Particles burst={burst} cx={burstPos.x} cy={burstPos.y} type={burstType} />
        </div>

        {/* Creature */}
        <div
          onClick={handleTickle}
          onMouseEnter={handleSleepHoverEnter}
          onMouseLeave={handleSleepHoverLeave}
          style={{
            position:'absolute', left:8+x, bottom:0, width:SW,
            transform:`translateY(${offY + (yawning ? -yawnPhase * 3 : 0)}px) scaleX(${flip ? -(sx * (yawning ? 1 - yawnPhase * 0.04 : 1)) : sx * (yawning ? 1 - yawnPhase * 0.04 : 1)}) scaleY(${sy * (yawning ? 1 + yawnPhase * 0.06 : 1)})`,
            transformOrigin:'bottom center',
            pointerEvents:'auto',
            cursor: gameActive ? 'crosshair' : mood === 'sleeping' ? 'default' : 'pointer',
            animation: startled ? 'rackJump 0.6s cubic-bezier(0.36,0.07,0.19,0.97) both'
              : tickled ? 'rackTickle 0.55s ease both' : 'none',
            willChange:'transform',
          }}
        >
          <Stars active={effectiveMood === 'happy' && !startled && !tickled} />
          {/* Game mode: pulsing catch ring around creature */}
          {gameActive && (
            <div style={{
              position: 'absolute',
              top: -6, left: -6, right: -6, bottom: -6,
              border: '2px solid #e8ff6b',
              borderRadius: 4,
              animation: 'rackGameRing 0.55s ease-in-out infinite alternate',
              pointerEvents: 'none',
              boxShadow: '0 0 14px #e8ff6b88, inset 0 0 8px #e8ff6b22',
            }} />
          )}
          {/* Game score badge */}
          {showGameScore && (
            <div style={{
              position: 'absolute', top: -28, left: '50%', transform: 'translateX(-50%)',
              background: '#e8ff6b', color: '#0a0a0a', borderRadius: 3,
              padding: '1px 6px', fontSize: 9, fontWeight: 900,
              fontFamily: '"Courier New", monospace', whiteSpace: 'nowrap',
              animation: 'rackPop 0.15s steps(3) both',
            }}>score: {gameScore}/5</div>
          )}
          {bubble && <Bubble text={bubble.text} color={bubble.color} shake={bonking} />}
          {mood === 'sleeping' && !tickled && !startled && <ZZZ />}
          <div style={{ position:'relative', width:SW, height:SH }}>
            <PixelCanvas grid={grid} flip={false} mood={effectiveMood} tickleGlow={tickled} startleGlow={startled} bonking={bonking} sprinting={sprinting} />
            <Scanlines />
          </div>
        </div>
      </div>
    </>
  )
}