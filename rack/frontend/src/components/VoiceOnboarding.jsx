/**
 * VoiceOnboarding.jsx — RACK voice onboarding
 *
 * Fixes in this version:
 *  1. Mic tracks stopped on done (stopAll releases browser mic indicator)
 *  2. hasStartedRef guard prevents React StrictMode double-start
 *  3. Canvas oversized (500px) so atmospheric glow bleeds freely — no square crop
 *  4. TTS audio element wired into AudioContext analyser so blob reacts while RACK speaks
 *  5. Richer blob: 16 control points, 3-layer organic noise, particle field, specular
 */

import { useState, useRef, useEffect, useCallback } from 'react'

// ── Constants ─────────────────────────────────────────────────────────────────
const SILENCE_THRESHOLD   = 0.012
const SILENCE_DURATION_MS = 1800
const MIN_SPEECH_MS       = 400
const FFT_SIZE            = 1024   // larger for better frequency resolution

// ── VAD helper ────────────────────────────────────────────────────────────────
function getRMS(analyser, buf) {
  analyser.getByteTimeDomainData(buf)
  let s = 0
  for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; s += v * v }
  return Math.sqrt(s / buf.length)
}

// ── BlobOrb — the living organism ─────────────────────────────────────────────
function BlobOrb({ phase, volumeLevel, audioCtxRef, analyserRef }) {
  const canvasRef     = useRef(null)
  const rafRef        = useRef(null)
  const tRef          = useRef(0)
  const ptsRef        = useRef(null)           // blob control points
  const particlesRef  = useRef(null)           // ambient particles
  const smoothVolRef  = useRef(0)              // smoothed volume for blob

  // Refs so rAF always reads latest without re-creating the loop
  const phaseRef  = useRef(phase)
  const volRef    = useRef(volumeLevel)
  useEffect(() => { phaseRef.current = phase },       [phase])
  useEffect(() => { volRef.current   = volumeLevel }, [volumeLevel])

  // Wire TTS audio element to AudioContext so blob reacts while RACK speaks
  // Called from playNovaAudio in the parent via the speakerSourceRef
  // We just need audioCtxRef + analyserRef to be the same context

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const DPR  = Math.min(window.devicePixelRatio || 1, 2)
    const SIZE = 500   // ← oversized: glow bleeds to edges, no square crop
    canvas.width  = SIZE * DPR
    canvas.height = SIZE * DPR
    canvas.style.width  = SIZE + 'px'
    canvas.style.height = SIZE + 'px'
    const ctx = canvas.getContext('2d')
    ctx.scale(DPR, DPR)
    const cx = SIZE / 2, cy = SIZE / 2

    const N = 16  // control points — smoother, more organic than 12

    // Each point: 3 independent sine layers → complex non-repeating motion
    if (!ptsRef.current) {
      ptsRef.current = Array.from({ length: N }, (_, i) => ({
        angle:  (i / N) * Math.PI * 2,
        r:      0,  // will lerp to base
        // layer 1: slow global breathe
        f1: 0.18 + Math.random() * 0.12,  ph1: Math.random() * Math.PI * 2,
        // layer 2: medium organic wobble
        f2: 0.45 + Math.random() * 0.30,  ph2: Math.random() * Math.PI * 2,
        // layer 3: fast micro-tremor
        f3: 1.10 + Math.random() * 0.50,  ph3: Math.random() * Math.PI * 2,
        // layer 4: very slow drift
        f4: 0.06 + Math.random() * 0.04,  ph4: Math.random() * Math.PI * 2,
      }))
      // init r
      ptsRef.current.forEach(p => { p.r = 98 })
    }

    // Ambient particles — drift outward slowly, fade, respawn
    if (!particlesRef.current) {
      particlesRef.current = Array.from({ length: 16 }, () => mkParticle(cx, cy))
    }

    function mkParticle(cx, cy) {
      const angle = Math.random() * Math.PI * 2
      const r     = 55 + Math.random() * 70
      return {
        x: cx + Math.cos(angle) * r,
        y: cy + Math.sin(angle) * r,
        vx: (Math.random() - 0.5) * 0.18,
        vy: (Math.random() - 0.5) * 0.18,
        life: Math.random(),
        decay: 0.0015 + Math.random() * 0.0020,
        size: 1.0 + Math.random() * 1.4,
        brightness: 0.18 + Math.random() * 0.28,
      }
    }

    // Smooth closed bezier (Catmull-Rom → bezier)
    function drawBlob(pts) {
      const n = pts.length
      ctx.beginPath()
      for (let i = 0; i < n; i++) {
        const p0 = pts[(i - 1 + n) % n]
        const p1 = pts[i]
        const p2 = pts[(i + 1) % n]
        const p3 = pts[(i + 2) % n]
        const cp1x = p1.x + (p2.x - p0.x) / 6
        const cp1y = p1.y + (p2.y - p0.y) / 6
        const cp2x = p2.x - (p3.x - p1.x) / 6
        const cp2y = p2.y - (p3.y - p1.y) / 6
        if (i === 0) ctx.moveTo(p1.x, p1.y)
        ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y)
      }
      ctx.closePath()
    }

    // Pre-allocate ONCE — avoids ~60k GC allocations/sec that caused the flicker
    const liveBuf = new Uint8Array(FFT_SIZE)

    function getLiveVolume() {
      const analyser = analyserRef?.current
      if (!analyser) return 0
      return getRMS(analyser, liveBuf)
    }

    function frame() {
      rafRef.current = requestAnimationFrame(frame)
      tRef.current += 0.011
      const t   = tRef.current
      const p   = phaseRef.current

      const rawVol = p === 'listening' || p === 'speaking'
        ? Math.min(1, getLiveVolume() * 14)
        : 0

      // Heavily smoothed — slow attack + slow decay = blob moves with weight, not jitter
      smoothVolRef.current = rawVol > smoothVolRef.current
        ? smoothVolRef.current + (rawVol - smoothVolRef.current) * 0.16
        : smoothVolRef.current + (rawVol - smoothVolRef.current) * 0.05
      const vol = smoothVolRef.current

      ctx.clearRect(0, 0, SIZE, SIZE)

      // ── Phase-based blob parameters ──────────────────────────────────────
      const baseR = p === 'speaking'   ?  97 + vol * 16
                  : p === 'listening'  ?  89 + vol * 20
                  : p === 'processing' ?  83
                  :                       81

      const amp   = p === 'speaking'   ? 15 + vol * 9
                  : p === 'listening'  ? 11 + vol * 12
                  : p === 'processing' ?  6
                  :                        5

      const speed = p === 'speaking'   ? 1.2 + vol * 0.4
                  : p === 'listening'  ? 0.95 + vol * 0.3
                  : p === 'processing' ? 0.52
                  : 0.36

      // ── Update blob control points ────────────────────────────────────────
      const cartesian = ptsRef.current.map(pt => {
        const wave =
            Math.sin(t * speed * pt.f1 + pt.ph1)
          + 0.50 * Math.sin(t * speed * pt.f2 + pt.ph2)
          + 0.22 * Math.sin(t * speed * pt.f3 + pt.ph3)
          + 0.12 * Math.sin(t * speed * pt.f4 + pt.ph4)

        // Uniform swell with volume — no per-angle chaos
        pt.r += (baseR + wave * amp + vol * 8 - pt.r) * 0.07

        return { x: cx + Math.cos(pt.angle) * pt.r, y: cy + Math.sin(pt.angle) * pt.r }
      })

      // ── Single soft halo — one radial gradient, no stacked rings ─────────
      const haloA = p === 'speaking'   ? 0.08 + vol * 0.05
                  : p === 'listening'  ? 0.055 + vol * 0.07
                  : p === 'processing' ? 0.032
                  : 0.026
      const hg = ctx.createRadialGradient(cx, cy, baseR * 0.25, cx, cy, 228)
      hg.addColorStop(0,   `rgba(215,255,72,${haloA * 3.0})`)
      hg.addColorStop(0.38,`rgba(195,248,58,${haloA})`)
      hg.addColorStop(1,   'rgba(148,232,38,0)')
      ctx.beginPath(); ctx.arc(cx, cy, 228, 0, Math.PI * 2)
      ctx.fillStyle = hg; ctx.fill()

      // Pulse rings removed — single halo is cleaner and more professional

      if (p === 'processing') {
        [[baseR + 20, 0.45, 0.07, 4, 20], [baseR + 35, -0.26, 0.04, 3, 28]].forEach(
          ([r, spd, a, dash, gap]) => {
            ctx.save(); ctx.translate(cx, cy); ctx.rotate(t * spd)
            ctx.setLineDash([dash, gap])
            ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2)
            ctx.strokeStyle = `rgba(210,255,95,${a})`
            ctx.lineWidth = 1.0; ctx.stroke()
            ctx.restore()
          }
        )
        ctx.setLineDash([])
      }

      // ── Ambient particles ─────────────────────────────────────────────────
      const parts = particlesRef.current
      parts.forEach((pt, i) => {
        pt.x += pt.vx * (1 + vol * 0.8)
        pt.y += pt.vy * (1 + vol * 0.8)
        pt.life -= pt.decay * (p === 'speaking' ? 1.3 : p === 'listening' ? 1.1 : 0.6)
        if (pt.life <= 0) parts[i] = mkParticle(cx, cy)
        const a = pt.life * pt.brightness * (p === 'loading' ? 0.25 : 0.55)
        ctx.beginPath()
        ctx.arc(pt.x, pt.y, pt.size * pt.life, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(215,255,95,${a})`
        ctx.fill()
      })

      // ── Core blob fill ────────────────────────────────────────────────────
      drawBlob(cartesian)
      const fill = ctx.createRadialGradient(
        cx - baseR * 0.22, cy - baseR * 0.30, 0,
        cx, cy, baseR * 1.12
      )
      if (p === 'speaking') {
        fill.addColorStop(0,    'rgba(255,255,215,0.92)')
        fill.addColorStop(0.28, 'rgba(245,255,140,0.70)')
        fill.addColorStop(0.60, 'rgba(210,255,90, 0.32)')
        fill.addColorStop(1,    'rgba(150,230,50, 0.04)')
      } else if (p === 'listening') {
        const v = vol
        fill.addColorStop(0,    `rgba(255,255,210,${0.58 + v * 0.28})`)
        fill.addColorStop(0.32, `rgba(240,255,120,${0.42 + v * 0.22})`)
        fill.addColorStop(0.65, `rgba(200,255,80, ${0.18 + v * 0.14})`)
        fill.addColorStop(1,    'rgba(140,220,50, 0.02)')
      } else if (p === 'processing') {
        fill.addColorStop(0,    'rgba(232,255,107,0.42)')
        fill.addColorStop(0.55, 'rgba(180,230,70, 0.18)')
        fill.addColorStop(1,    'rgba(100,170,40, 0.02)')
      } else {
        const b = 0.38 + 0.20 * Math.sin(t * 0.95)
        fill.addColorStop(0,    `rgba(232,255,107,${b})`)
        fill.addColorStop(0.58, `rgba(180,225,65, ${b * 0.40})`)
        fill.addColorStop(1,    'rgba(100,165,40, 0.01)')
      }
      ctx.fillStyle = fill; ctx.fill()

      // ── Edge stroke ───────────────────────────────────────────────────────
      drawBlob(cartesian)
      ctx.strokeStyle = p === 'speaking'
        ? `rgba(238,255,120,${0.45 + vol * 0.28})`
        : p === 'listening'
        ? `rgba(232,255,107,${0.24 + vol * 0.44})`
        : 'rgba(215,255,100,0.14)'
      ctx.lineWidth = 1.6; ctx.stroke()

      // ── Specular highlight — top-left gleam (clipped inside blob) ─────────
      drawBlob(cartesian)
      ctx.save(); ctx.clip()
      const hlX = cx - baseR * 0.30, hlY = cy - baseR * 0.36
      const hlG = ctx.createRadialGradient(hlX, hlY, 0, hlX, hlY, baseR * 0.55)
      hlG.addColorStop(0, 'rgba(255,255,255,0.22)')
      hlG.addColorStop(1, 'rgba(255,255,255,0)')
      ctx.beginPath(); ctx.arc(hlX, hlY, baseR * 0.55, 0, Math.PI * 2)
      ctx.fillStyle = hlG; ctx.fill()
      ctx.restore()

      // ── Secondary inner luminescence (bottom-right, warm) ─────────────────
      if (p === 'speaking' || p === 'listening') {
        drawBlob(cartesian)
        ctx.save(); ctx.clip()
        const lx = cx + baseR * 0.28, ly = cy + baseR * 0.24
        const lg = ctx.createRadialGradient(lx, ly, 0, lx, ly, baseR * 0.45)
        lg.addColorStop(0, `rgba(180,255,80,${0.08 + vol * 0.08})`)
        lg.addColorStop(1, 'rgba(180,255,80,0)')
        ctx.beginPath(); ctx.arc(lx, ly, baseR * 0.45, 0, Math.PI * 2)
        ctx.fillStyle = lg; ctx.fill()
        ctx.restore()
      }
    }

    frame()
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current) }
  }, []) // intentional: all live values read via refs

  return (
    <canvas
      ref={canvasRef}
      style={{ display: 'block', pointerEvents: 'none' }}
    />
  )
}

// ── Main component ────────────────────────────────────────────────────────────
export default function VoiceOnboarding({ user, onComplete, onSwitchToText, apiBase, getAuthHeaders }) {

  const [phase, setPhase]             = useState('loading')
  const [statusLine, setStatusLine]   = useState('')
  const [volumeLevel, setVolumeLevel] = useState(0)
  const [extracted, setExtracted]     = useState({})
  const [history, setHistory]         = useState([])
  const [errorMsg, setErrorMsg]       = useState(null)
  const [novaText, setNovaText]       = useState('')
  const [transcript, setTranscript]   = useState('')

  const audioCtxRef        = useRef(null)
  const analyserRef        = useRef(null)   // shared — switched between mic and speaker source
  const streamRef          = useRef(null)
  const recorderRef        = useRef(null)
  const chunksRef          = useRef([])
  const vadIntervalRef     = useRef(null)
  const silenceStartRef    = useRef(null)
  const speechStartRef     = useRef(null)
  const isListeningRef     = useRef(false)
  const phaseRef           = useRef('loading')
  const currentAudioRef    = useRef(null)
  const historyRef         = useRef([])
  const hasStartedRef      = useRef(false)  // StrictMode guard
  const micSourceRef       = useRef(null)   // AudioContext source for mic
  const speakerSourceRef   = useRef(null)   // AudioContext source for TTS audio element

  useEffect(() => { phaseRef.current = phase },     [phase])
  useEffect(() => { historyRef.current = history }, [history])

  // ── stopAll ───────────────────────────────────────────────────────────────
  const stopAll = useCallback(() => {
    clearInterval(vadIntervalRef.current)
    if (recorderRef.current?.state === 'recording') {
      try { recorderRef.current.stop() } catch (_) {}
    }
    if (currentAudioRef.current) {
      currentAudioRef.current.pause()
      currentAudioRef.current = null
    }
    if (speakerSourceRef.current) {
      try { speakerSourceRef.current.disconnect() } catch (_) {}
      speakerSourceRef.current = null
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop())
      streamRef.current = null
    }
    if (audioCtxRef.current?.state !== 'closed') {
      audioCtxRef.current?.close().catch(() => {})
      audioCtxRef.current = null
    }
    analyserRef.current    = null
    isListeningRef.current = false
  }, [])

  // ── playNovaAudio ─────────────────────────────────────────────────────────
  // Accepts base64-encoded MP3 string (from /api/voice/turn or /api/voice/chat).
  // No fetch — audio is already in hand, zero extra round trip.
  // isDone=true → stopAll after audio instead of restarting VAD.
  const playNovaAudio = useCallback(async (text, audioB64, isDone = false) => {
    if (!audioB64) { if (!isDone) startListening(); return }
    setNovaText(text)
    setPhase('speaking')

    try {
      // Decode base64 → Blob → object URL
      const binary = atob(audioB64)
      const bytes  = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      const blob = new Blob([bytes], { type: 'audio/mpeg' })
      const url  = URL.createObjectURL(blob)
      const audio = new Audio(url)
      currentAudioRef.current = audio

      // Wire TTS audio into AudioContext so analyser picks up its volume
      // This is what makes the blob react when RACK is speaking
      if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
        try {
          if (speakerSourceRef.current) {
            speakerSourceRef.current.disconnect()
            speakerSourceRef.current = null
          }
          const src = audioCtxRef.current.createMediaElementSource(audio)
          src.connect(analyserRef.current)
          src.connect(audioCtxRef.current.destination)
          speakerSourceRef.current = src
        } catch (e) {
          console.warn('[VoiceOnboarding] speaker analyser wiring failed:', e)
        }
      }

      await new Promise(resolve => {
        audio.onended = resolve
        audio.onerror = resolve
        audio.play().catch(resolve)
      })

      URL.revokeObjectURL(url)
      currentAudioRef.current = null
      if (speakerSourceRef.current) {
        try { speakerSourceRef.current.disconnect() } catch (_) {}
        speakerSourceRef.current = null
      }

    } catch (err) {
      console.error('[VoiceOnboarding] audio playback error:', err)
    }

    if (isDone || phaseRef.current === 'done') {
      stopAll(); return
    }
    startListening()
  }, [stopAll]) // eslint-disable-line

  // ── processAudio ──────────────────────────────────────────────────────────
  // Single round trip to /api/voice/turn — Whisper + GPT + TTS + extraction
  // all happen server-side. Browser makes one HTTP call and gets back everything.
  const processAudio = useCallback(async (audioBlob) => {
    setPhase('processing')
    setStatusLine('')
    setVolumeLevel(0)

    try {
      const headers = await getAuthHeaders()

      const fd = new FormData()
      fd.append('audio', audioBlob, 'recording.webm')
      fd.append('history_json', JSON.stringify(historyRef.current))
      fd.append('extracted_json', JSON.stringify(extracted))  // lets backend steer without re-running extraction
      fd.append('is_first_turn', 'false')

      const res = await fetch(`${apiBase}/api/voice/turn`, {
        method: 'POST',
        headers,   // no Content-Type — browser sets multipart boundary automatically
        body: fd,
      })
      if (!res.ok) throw new Error('Turn failed')

      const { too_short, transcript: userText, reply_text, audio_b64, extracted: newEx, done } = await res.json()

      if (too_short || !userText) { setStatusLine(''); startListening(); return }

      setTranscript(userText)

      // Update history with user message + RACK reply
      const newHist = [
        ...historyRef.current,
        { role: 'user', content: userText },
        { role: 'assistant', content: reply_text },
      ]
      setHistory(newHist); historyRef.current = newHist

      // Merge extracted fields — only overwrite if new value is non-null
      const merged = { ...extracted }
      if (newEx.target_roles)             merged.target_roles        = newEx.target_roles
      if (newEx.preferred_locations)      merged.preferred_locations = newEx.preferred_locations
      if (newEx.years_experience != null) merged.years_experience    = newEx.years_experience
      setExtracted(merged)

      if (done) {
        setPhase('done')
        await playNovaAudio(reply_text, audio_b64, true)
        await savePreferences(merged, headers)
        onComplete(merged)
        return
      }
      await playNovaAudio(reply_text, audio_b64, false)

    } catch (err) {
      console.error('[VoiceOnboarding] processAudio error:', err)
      setStatusLine("Something went wrong — let's try again")
      setTimeout(() => { setStatusLine(''); startListening() }, 2000)
    }
  }, [apiBase, getAuthHeaders, extracted, onComplete, playNovaAudio]) // eslint-disable-line

  // ── savePreferences ────────────────────────────────────────────────────────
  const savePreferences = async (prefs, headers) => {
    try {
      const body = {}
      if (prefs.target_roles)            body.target_roles        = prefs.target_roles
      if (prefs.preferred_locations)     body.preferred_locations = prefs.preferred_locations
      if (prefs.years_experience != null) { body.min_years = prefs.years_experience; body.max_years = prefs.years_experience + 2 }
      if (!Object.keys(body).length) return
      await fetch(`${apiBase}/api/account/preferences`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      })
    } catch (err) { console.warn('[VoiceOnboarding] prefs save failed:', err) }
  }

  // ── startListening ─────────────────────────────────────────────────────────
  const startListening = useCallback(() => {
    if (phaseRef.current === 'done') return
    if (isListeningRef.current) return
    if (!streamRef.current) return

    isListeningRef.current  = true
    chunksRef.current       = []
    silenceStartRef.current = null
    speechStartRef.current  = null
    setPhase('listening'); setStatusLine(''); setTranscript('')

    // Re-point analyser back to mic source for VAD
    if (audioCtxRef.current && micSourceRef.current && analyserRef.current) {
      try { micSourceRef.current.connect(analyserRef.current) } catch (_) {}
    }

    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus'
               : MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/ogg'
    const rec  = new MediaRecorder(streamRef.current, { mimeType: mime })
    recorderRef.current = rec

    rec.ondataavailable = e => { if (e.data.size > 0) chunksRef.current.push(e.data) }
    rec.onstop = () => {
      isListeningRef.current = false
      processAudio(new Blob(chunksRef.current, { type: mime }))
    }
    rec.start(100)

    const analyser  = analyserRef.current
    const dataBuf   = new Uint8Array(analyser.fftSize)

    vadIntervalRef.current = setInterval(() => {
      if (!isListeningRef.current) return
      const rms = getRMS(analyser, dataBuf)
      setVolumeLevel(Math.min(1, rms * 13))

      const now = Date.now()
      if (rms > SILENCE_THRESHOLD) {
        if (!speechStartRef.current) speechStartRef.current = now
        silenceStartRef.current = null
      } else {
        if (!silenceStartRef.current) silenceStartRef.current = now
        const sil = now - (silenceStartRef.current || now)
        const spk = speechStartRef.current ? now - speechStartRef.current : 0
        if (sil >= SILENCE_DURATION_MS && spk >= MIN_SPEECH_MS) {
          clearInterval(vadIntervalRef.current); rec.stop()
        } else if (sil >= SILENCE_DURATION_MS * 3 && spk < MIN_SPEECH_MS) {
          clearInterval(vadIntervalRef.current)
          rec.onstop = null; try { rec.stop() } catch (_) {}
          isListeningRef.current = false; chunksRef.current = []
          setVolumeLevel(0); setTimeout(() => startListening(), 300)
        }
      }
    }, 50)
  }, [processAudio]) // eslint-disable-line

  // ── startVoiceSession ─────────────────────────────────────────────────────
  const startVoiceSession = useCallback(async () => {
    setPhase('loading'); setStatusLine(''); setErrorMsg(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 16000 },
      })
      streamRef.current = stream

      const audioCtx = new AudioContext()
      audioCtxRef.current = audioCtx
      const analyser = audioCtx.createAnalyser()
      analyser.fftSize = FFT_SIZE
      analyserRef.current = analyser

      const micSrc = audioCtx.createMediaStreamSource(stream)
      micSrc.connect(analyser)
      micSourceRef.current = micSrc
      // Note: mic source NOT connected to destination — no feedback

      const headers = await getAuthHeaders()
      const cRes = await fetch(`${apiBase}/api/voice/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ is_first_turn: true }),
      })
      if (!cRes.ok) throw new Error('RACK unavailable')
      const { reply_text, audio_b64 } = await cRes.json()

      const opening = [{ role: 'assistant', content: reply_text }]
      setHistory(opening); historyRef.current = opening
      setStatusLine('')
      await playNovaAudio(reply_text, audio_b64, false)

    } catch (err) {
      console.error('[VoiceOnboarding] init error:', err)
      hasStartedRef.current = false
      setErrorMsg(err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError'
        ? 'Microphone access was denied. Allow access and try again, or switch to text mode.'
        : "Couldn't start voice mode. Try again or switch to text.")
    }
  }, [apiBase, getAuthHeaders, playNovaAudio])

  // StrictMode-safe single start
  useEffect(() => {
    if (hasStartedRef.current) return
    hasStartedRef.current = true
    startVoiceSession()
  }, [startVoiceSession])

  useEffect(() => () => stopAll(), [stopAll])

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={styles.root}>

      {/* Full-page atmospheric bloom — behind everything, no overflow:hidden on root */}
      <div style={{
        ...styles.bloom,
        opacity: phase === 'speaking' ? 1 : phase === 'listening' ? 0.7 : 0.35,
        transition: 'opacity 1.6s ease',
      }} />

      {/* Header */}
      <div style={styles.header}>
        <span style={styles.dot} />
        <span style={styles.headerLabel}>rack · voice setup</span>
      </div>

      {/* Blob — canvas is 500px, no surrounding box constrains it */}
      <div style={styles.orbWrap}>
        <BlobOrb
          phase={phase}
          volumeLevel={volumeLevel}
          audioCtxRef={audioCtxRef}
          analyserRef={analyserRef}
        />
      </div>

      {/* Status row */}
      <div style={styles.statusRow}>
        {phase === 'loading' && (
          <span className="rack-dots" style={styles.dots}>
            <span /><span /><span />
          </span>
        )}
        {phase === 'listening' && (
          <div style={styles.micRow}>
            <div style={{
              ...styles.micDot,
              transform: `scale(${1 + volumeLevel * 1.4})`,
              opacity: 0.5 + volumeLevel * 0.5,
            }} />
            <span style={styles.stateLabel}>listening...</span>
          </div>
        )}
        {phase === 'processing' && (
          <div style={styles.micRow}>
            <div style={styles.spinDot} />
            <span style={styles.stateLabel}>thinking...</span>
          </div>
        )}
        {statusLine ? <div style={styles.statusSmall}>{statusLine}</div> : null}
        {errorMsg   ? <div style={styles.errorBox}>{errorMsg}</div> : null}
      </div>

      {/* Text fallback */}
      {phase !== 'done' && (
        <button
          style={styles.textFallback}
          onClick={() => { stopAll(); onSwitchToText() }}
          onMouseEnter={e => { e.currentTarget.style.color = 'rgba(255,255,255,0.5)' }}
          onMouseLeave={e => { e.currentTarget.style.color = 'rgba(255,255,255,0.2)' }}
        >
          I can't talk right now — let me text instead
        </button>
      )}

      <style>{css}</style>
    </div>
  )
}

// ── Styles ────────────────────────────────────────────────────────────────────
const styles = {
  root: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: '100%',
    padding: '40px 24px 80px',
    // No overflow:hidden — lets canvas halo bleed into page background naturally
  },

  bloom: {
    position: 'fixed',   // fixed not absolute — spans full viewport regardless of parent
    inset: 0,
    background: 'radial-gradient(ellipse 50% 40% at 50% 46%, rgba(200,255,60,0.06) 0%, rgba(160,240,40,0.02) 50%, transparent 72%)',
    pointerEvents: 'none',
    zIndex: 0,
  },

  header: {
    position: 'absolute',
    top: '24px',
    left: '50%',
    transform: 'translateX(-50%)',
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    zIndex: 2,
  },

  dot: {
    display: 'inline-block',
    width: '6px', height: '6px',
    borderRadius: '50%',
    background: 'var(--accent, #e8ff6b)',
    boxShadow: '0 0 8px var(--accent, #e8ff6b)',
  },

  headerLabel: {
    fontFamily: 'var(--font-mono, monospace)',
    fontSize: '11px',
    letterSpacing: '0.12em',
    textTransform: 'uppercase',
    color: 'rgba(255,255,255,0.28)',
  },

  orbWrap: {
    // No width/height constraint — canvas itself is 500px and bleeds freely
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1,
    // Negative margin to visually tighten since canvas has lots of transparent padding
    margin: '-60px 0',
  },

  statusRow: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '10px',
    zIndex: 2,
    minHeight: '28px',
  },

  micRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },

  micDot: {
    width: '7px', height: '7px',
    borderRadius: '50%',
    background: 'var(--accent, #e8ff6b)',
    boxShadow: '0 0 8px var(--accent, #e8ff6b)',
    transition: 'transform 0.05s, opacity 0.05s',
  },

  spinDot: {
    width: '7px', height: '7px',
    borderRadius: '50%',
    background: 'rgba(232,255,107,0.5)',
    animation: 'rackSpin 1.2s linear infinite',
  },

  stateLabel: {
    fontSize: '12px',
    color: 'rgba(255,255,255,0.3)',
    fontFamily: 'var(--font-mono, monospace)',
    letterSpacing: '0.1em',
  },

  statusSmall: {
    fontSize: '12px',
    color: 'rgba(255,255,255,0.25)',
    fontFamily: 'var(--font-mono, monospace)',
    letterSpacing: '0.08em',
  },

  dots: { display: 'inline-flex', gap: '7px' },

  errorBox: {
    padding: '12px 16px',
    borderRadius: '10px',
    background: 'rgba(255,80,80,0.08)',
    border: '1px solid rgba(255,80,80,0.2)',
    color: 'rgba(255,130,130,0.9)',
    fontSize: '13px',
    maxWidth: '340px',
    textAlign: 'center',
    lineHeight: 1.5,
  },

  textFallback: {
    position: 'absolute',
    bottom: '32px',
    left: '50%',
    transform: 'translateX(-50%)',
    background: 'none', border: 'none',
    color: 'rgba(255,255,255,0.2)',
    fontSize: '12px',
    fontFamily: 'var(--font-body, sans-serif)',
    cursor: 'pointer',
    textDecoration: 'underline',
    textUnderlineOffset: '3px',
    textDecorationColor: 'rgba(255,255,255,0.08)',
    whiteSpace: 'nowrap',
    padding: '8px',
    transition: 'color 0.2s',
    zIndex: 2,
  },
}

// ── Keyframes ─────────────────────────────────────────────────────────────────
const css = `
  @keyframes rackSpin {
    from { transform: rotate(0deg); }
    to   { transform: rotate(360deg); }
  }
  .rack-dots span {
    display: inline-block;
    width: 5px; height: 5px; border-radius: 50%;
    background: rgba(232,255,107,0.4);
    animation: rackDot 1.3s ease-in-out infinite;
  }
  .rack-dots span:nth-child(2) { animation-delay: 0.22s; }
  .rack-dots span:nth-child(3) { animation-delay: 0.44s; }
  @keyframes rackDot {
    0%, 100% { opacity: 0.2; transform: scale(0.75); }
    50%       { opacity: 1;   transform: scale(1.2); }
  }
`