import { useState, useRef, useEffect } from 'react'

function scoreColor(score) {
  if (score >= 85) return 'linear-gradient(90deg,#e8ff6b,#a3e635)'
  if (score >= 65) return 'linear-gradient(90deg,#60a5fa,#818cf8)'
  return 'linear-gradient(90deg,#f87171,#fb923c)'
}

function recommendationStyle(rec) {
  switch (rec) {
    case 'Strong Match': return { color: 'var(--accent3)', bg: 'rgba(52,211,153,0.12)', border: 'rgba(52,211,153,0.25)' }
    case 'Good Match':   return { color: 'var(--accent)',  bg: 'rgba(232,255,107,0.10)', border: 'rgba(232,255,107,0.22)' }
    case 'Partial Match':return { color: '#fb923c',        bg: 'rgba(251,146,60,0.10)',  border: 'rgba(251,146,60,0.22)' }
    default:             return { color: 'var(--danger)',  bg: 'rgba(248,113,113,0.10)', border: 'rgba(248,113,113,0.22)' }
  }
}

function componentBar(label, value, color) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px' }}>
      <span style={{ color: 'var(--text-dim)', minWidth: '80px', fontWeight: 500 }}>{label}</span>
      <div style={{ flex: 1, height: '4px', background: 'rgba(255,255,255,0.06)', borderRadius: '4px', overflow: 'hidden' }}>
        <div style={{ height: '100%', borderRadius: '4px', background: color, width: `${Math.round(value)}%`, transition: 'width 0.8s cubic-bezier(0.22,1,0.36,1)' }} />
      </div>
      <span style={{ color: 'var(--text-dim)', minWidth: '28px', textAlign: 'right', fontFamily: 'var(--font-display)', fontWeight: 600 }}>{Math.round(value)}</span>
    </div>
  )
}

/* ══════════════════════════════════════════════════════════════════
   JD MATCH PIPELINE ANIMATION — updated with LLM stage
   ══════════════════════════════════════════════════════════════════ */
const JD_STAGES = [
  {
    id: "parse", label: "PARSING JD", icon: "◈",
    detail: "Extracting role, skills, experience requirements",
    ascii: [
      "┌──────────────────────────────────┐",
      "│  POST /api/match                 │",
      "│  body: { job_description, ... }  │",
      "│                                  │",
      "│  jd_parser.py                    │",
      "│    ├─ rule_extractor()           │",
      "│    └─ llm_extractor()  ← hybrid  │",
      "└──────────────────────────────────┘",
    ],
    logLines: [
      "→ received JD  (1,842 chars)",
      "→ cleaning: strip HTML / whitespace",
      "→ rule pass: title='Senior SWE'",
      "  min_years: 3  |  level: senior",
      "→ skills regex: 14 candidates",
      "  Python ✓  FastAPI ✓  Docker ✓",
      "  Kubernetes ✓  PostgreSQL ✓",
      "→ llm pass: confirming + filling gaps",
    ],
  },
  {
    id: "embed", label: "FAISS LOOKUP", icon: "◎",
    detail: "Encoding JD → 384-dim vector → cosine search",
    ascii: [
      "┌──────────────────────────────────┐",
      "│  model: all-MiniLM-L6-v2         │",
      "│  dim:   384                      │",
      "│                                  │",
      "│  JD text ──► tokenize            │",
      "│           ──► encode             │",
      "│           ──► vec[384]           │",
      "│  FAISS.search(vec, top_k=20)     │",
      "└──────────────────────────────────┘",
    ],
    logLines: [
      "→ tokenizing JD text...",
      "  tokens: 312  |  truncated: no",
      "→ encoding  [████████████████████]",
      "  vec[0..4]: [0.231,-0.087,0.412…]",
      "  vec norm:  0.9997",
      "→ FAISS index: 18 vectors loaded",
      "→ cosine search  top_k=20",
      "  top hit: 0.871 · resume_a chunk 2",
    ],
  },
  {
    id: "hybrid", label: "HYBRID SCORE", icon: "◆",
    detail: "4-component weighted scorer per resume",
    ascii: [
      "┌──────────────────────────────────┐",
      "│  semantic_sim  × 0.40  → 0.848  │",
      "│  skill_overlap × 0.30  → 0.733  │",
      "│  exp_match     × 0.20  → 0.800  │",
      "│  kw_position   × 0.10  → 0.690  │",
      "│  ────────────────────────────── │",
      "│  hybrid_score          → 0.791  │",
      "│  qualifies for Phase 2 ✓        │",
      "└──────────────────────────────────┘",
    ],
    logLines: [
      "→ resume_a: skill pass 1 (canonical)",
      "  ✓ Python  ✓ FastAPI  ✓ Docker",
      "  ✗ Terraform  ✗ Kubernetes",
      "→ skill pass 2 (text fallback scan)",
      "  'k8s' alias → Kubernetes ✓",
      "→ exp_match: 5yr vs 3yr req → 1.0",
      "→ hybrid_score: 79%",
      "  → Phase 2 LLM queue ✓",
    ],
  },
  {
    id: "llm", label: "LLM SCORING", icon: "✦",
    detail: "GPT-4o-mini deep scorer · holistic fit analysis",
    ascii: [
      "┌──────────────────────────────────┐",
      "│  model: gpt-4o-mini              │",
      "│  concurrency: 8 parallel calls   │",
      "│                                  │",
      "│  skills_fit:      85             │",
      "│  experience_fit:  72             │",
      "│  trajectory_fit:  65             │",
      "│  llm_score:  ──►  78            │",
      "└──────────────────────────────────┘",
    ],
    logLines: [
      "→ building JD + resume context",
      "  jd_summary: ~310 tokens",
      "  resume_summary: ~390 tokens",
      "→ calling gpt-4o-mini...",
      "  hybrid anchor: 79%",
      "→ response received (0.8s)",
      "  llm_score: 78  recommendation: Good Match",
      "✓ AI analysis complete",
    ],
  },
  {
    id: "rank", label: "RANKING", icon: "▲",
    detail: "Re-ranking by LLM score · building response",
    ascii: [
      "┌──────────────────────────────────┐",
      "│  ranked by llm_score (primary)   │",
      "│                                  │",
      "│  #1  llm: 78  resume_a  ← best  │",
      "│  #2  llm: 64  resume_c           │",
      "│  #3  llm: 51  resume_b           │",
      "│                                  │",
      "│  payload → UI  ✓                 │",
      "└──────────────────────────────────┘",
    ],
    logLines: [
      "→ ranked 3 resumes by llm_score",
      "  #1 resume_a  78%  Strong Match",
      "  #2 resume_c  64%  Partial Match",
      "  #3 resume_b  51%  Weak Match",
      "→ attaching AI analysis blocks...",
      "→ attaching hybrid baseline...",
      "→ serialising response payload",
      "✓ done · pipeline complete",
    ],
  },
];

const J_CURSOR  = ["█","▓","░"," "];
const J_SPINNER = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];
const J_PROGCH  = ["░","▒","▓","█"];

function JDPipelineAnimation() {
  const [stageIdx, setStageIdx]   = useState(0);
  const [logIdx,   setLogIdx]     = useState(0);
  const [cursor,   setCursor]     = useState(0);
  const [spinner,  setSpinner]    = useState(0);
  const [progress, setProgress]   = useState(0);
  const [asciiLine,setAsciiLine]  = useState(0);
  const [glitchCol,setGlitchCol]  = useState(-1);
  const [glitchRow,setGlitchRow]  = useState(-1);

  const totalStages = JD_STAGES.length;
  const safeIdx = Math.min(stageIdx, totalStages - 1);
  const stage   = JD_STAGES[safeIdx];

  useEffect(() => {
    const t = setInterval(() => setCursor(f => (f+1) % J_CURSOR.length), 520);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const t = setInterval(() => setSpinner(f => (f+1) % J_SPINNER.length), 75);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    setProgress(0); setLogIdx(0); setAsciiLine(0);
    const t = setInterval(() => {
      setProgress(p => {
        if (p >= 100) { clearInterval(t); return 100; }
        return Math.min(100, p + (Math.random() * 4.5 + 1.2));
      });
    }, 85);
    return () => clearInterval(t);
  }, [stageIdx]);

  useEffect(() => {
    if (progress >= 100 && stageIdx < totalStages - 1) {
      const t = setTimeout(() => setStageIdx(s => Math.min(s + 1, totalStages - 1)), 380);
      return () => clearTimeout(t);
    }
  }, [progress, stageIdx, totalStages]);

  useEffect(() => {
    setLogIdx(0);
    const lines = JD_STAGES[Math.min(stageIdx, totalStages-1)].logLines;
    const t = setInterval(() => {
      setLogIdx(i => {
        if (i >= lines.length - 1) { clearInterval(t); return i; }
        return i + 1;
      });
    }, 320);
    return () => clearInterval(t);
  }, [stageIdx]);

  useEffect(() => {
    setAsciiLine(0);
    const lines = JD_STAGES[Math.min(stageIdx, totalStages-1)].ascii;
    const t = setInterval(() => {
      setAsciiLine(l => {
        if (l >= lines.length - 1) { clearInterval(t); return l; }
        return l + 1;
      });
    }, 90);
    return () => clearInterval(t);
  }, [stageIdx]);

  useEffect(() => {
    const asciiLen = JD_STAGES[Math.min(stageIdx, totalStages-1)].ascii.length;
    const t = setInterval(() => {
      const row = Math.floor(Math.random() * asciiLen);
      const col = Math.floor(Math.random() * 36);
      setGlitchCol(col); setGlitchRow(row);
      setTimeout(() => { setGlitchCol(-1); setGlitchRow(-1); }, 75);
    }, 2200);
    return () => clearInterval(t);
  }, [stageIdx]);

  const pct     = Math.min(100, Math.round(progress));
  const barLen  = 26;
  const filled  = Math.round((pct/100) * barLen);
  const stageBar = Array.from({length: barLen}, (_, i) => {
    if (i < filled-1) return "█";
    if (i === filled-1) return J_PROGCH[2];
    if (i === filled)   return J_PROGCH[1];
    return "░";
  }).join("");

  const overallPct = Math.round(((stageIdx + pct/100) / totalStages) * 100);
  const oLen       = 50;
  const oFilled    = Math.round((overallPct/100) * oLen);
  const pipeBar    = Array.from({length: oLen}, (_, i) => i < oFilled ? "▪" : "·").join("");

  const mono = { fontFamily:"'JetBrains Mono','Fira Code','Courier New',monospace" };
  const acc  = "var(--accent)";
  const grn  = "#34d399";
  const dim  = "rgba(255,255,255,0.28)";
  const mid  = "rgba(255,255,255,0.55)";
  const red  = "#f87171";
  const ylw  = "rgba(232,255,107,0.82)";
  const isLLMStage = stage.id === "llm";

  return (
    <div style={{ width:"100%", maxWidth:"720px", margin:"0 auto", padding:"28px 0 8px", animation:"fadeUp 0.35s ease both" }}>

      {/* Stage strip */}
      <div style={{ display:"flex", gap:0, marginBottom:20, border:"1px solid var(--border)", borderRadius:10, overflow:"hidden" }}>
        {JD_STAGES.map((s,i) => {
          const done   = i < stageIdx;
          const active = i === stageIdx;
          const isLLM  = s.id === "llm";
          const activeColor = isLLM ? "#a78bfa" : acc;
          return (
            <div key={s.id} style={{
              flex:1, padding:"8px 2px", textAlign:"center",
              background: active ? (isLLM ? "rgba(167,139,250,0.06)" : "rgba(232,255,107,0.06)") : done ? "rgba(52,211,153,0.04)" : "transparent",
              borderRight: i < totalStages-1 ? "1px solid var(--border)" : "none",
              transition:"background 0.4s",
            }}>
              <div style={{ fontSize:14, marginBottom:2, color: done?grn : active?activeColor : dim, transition:"color 0.4s" }}>
                {done ? "✓" : active ? s.icon : "○"}
              </div>
              <div style={{ ...mono, fontSize:8, fontWeight:700, letterSpacing:"0.06em", color: done?grn : active?activeColor : dim, transition:"color 0.4s" }}>
                {s.id.toUpperCase()}
              </div>
            </div>
          );
        })}
      </div>

      {/* Terminal window */}
      <div style={{
        background:"#080808",
        border:`1px solid ${isLLMStage ? "rgba(167,139,250,0.2)" : "rgba(232,255,107,0.16)"}`,
        borderRadius:13, overflow:"hidden",
        boxShadow: isLLMStage
          ? "0 0 48px rgba(167,139,250,0.06), 0 16px 60px rgba(0,0,0,0.6)"
          : "0 0 48px rgba(232,255,107,0.04), 0 16px 60px rgba(0,0,0,0.6)",
        transition:"border-color 0.4s, box-shadow 0.4s",
      }}>

        {/* Title bar */}
        <div style={{ display:"flex", alignItems:"center", gap:6, padding:"9px 14px", background:"rgba(255,255,255,0.025)", borderBottom:"1px solid rgba(255,255,255,0.06)" }}>
          <div style={{ width:9, height:9, borderRadius:"50%", background:"#ff5f56" }}/>
          <div style={{ width:9, height:9, borderRadius:"50%", background:"#ffbd2e" }}/>
          <div style={{ width:9, height:9, borderRadius:"50%", background:"#27c93f" }}/>
          <div style={{ ...mono, fontSize:10, color:dim, marginLeft:8, letterSpacing:"0.05em" }}>rack-match-pipeline — bash</div>
          <div style={{ marginLeft:"auto", display:"flex", alignItems:"center", gap:6 }}>
            <span style={{ ...mono, fontSize:10, color: isLLMStage ? "#a78bfa" : acc }}>{J_SPINNER[spinner]}</span>
            <span style={{ ...mono, fontSize:10, color:dim }}>running</span>
          </div>
        </div>

        {/* Two-column body */}
        <div style={{ display:"flex", minHeight:220 }}>

          {/* Left — ASCII box art */}
          <div style={{ flex:"0 0 46%", padding:"16px 16px", borderRight:"1px solid rgba(255,255,255,0.05)" }}>
            <div style={{ ...mono, fontSize:9, color:dim, marginBottom:10, letterSpacing:"0.1em", textTransform:"uppercase" }}>
              {stage.icon}  {stage.label}
            </div>
            <div style={{ ...mono, fontSize:11, lineHeight:1.8 }}>
              {stage.ascii.map((line, li) => {
                const revealed = li <= asciiLine;
                const isCur    = li === asciiLine;
                const lineAcc  = isLLMStage ? "#a78bfa" : acc;
                const lineRevealedColor = isLLMStage ? "rgba(167,139,250,0.45)" : "rgba(232,255,107,0.45)";
                return (
                  <div key={li} style={{ color: revealed ? (isCur ? lineAcc : lineRevealedColor) : "transparent", transition:"color 0.12s", whiteSpace:"pre" }}>
                    {line.split("").map((ch, ci) => (
                      <span key={ci} style={{
                        color: (glitchCol===ci && glitchRow===li) ? red : undefined,
                        transition: "color 0.05s",
                      }}>{ch}</span>
                    ))}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Right — log stream */}
          <div style={{ flex:1, padding:"16px 16px", overflow:"hidden" }}>
            <div style={{ ...mono, fontSize:9, color:dim, marginBottom:10, letterSpacing:"0.1em" }}>▸ LOG STREAM</div>
            <div style={{ ...mono, fontSize:11, lineHeight:2.0 }}>
              {stage.logLines.map((line, li) => {
                const visible   = li <= logIdx;
                const isCurrent = li === logIdx;
                const isSkip    = line.includes("skip") || line.startsWith("  ✗");
                const isBright  = line.startsWith("✓") || line.startsWith("→") || line.includes("✓");
                const isIndent  = line.startsWith("  ");
                const lineColor = isSkip ? dim : isBright ? ylw : isIndent ? mid : "rgba(255,255,255,0.60)";
                const cursorColor = isLLMStage ? "#a78bfa" : acc;
                return (
                  <div key={`${stageIdx}-${li}`} style={{
                    opacity: visible ? 1 : 0, transition:"opacity 0.18s",
                    color: lineColor,
                    display:"flex", alignItems:"baseline", gap:5,
                  }}>
                    <span style={{ color:dim, userSelect:"none", fontSize:9, minWidth:16, flexShrink:0 }}>
                      {String(li+1).padStart(2,"0")}
                    </span>
                    <span style={{ whiteSpace:"pre" }}>{line}</span>
                    {isCurrent && visible && (
                      <span style={{ color:cursorColor, marginLeft:2, fontSize:13, lineHeight:1 }}>
                        {J_CURSOR[cursor]}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Progress bars */}
        <div style={{ padding:"12px 16px 14px", borderTop:"1px solid rgba(255,255,255,0.05)", background:"rgba(0,0,0,0.4)" }}>
          <div style={{ display:"flex", alignItems:"center", marginBottom:8 }}>
            <span style={{ ...mono, fontSize:10, color: isLLMStage ? "#a78bfa" : acc, letterSpacing:"0.03em" }}>
              {J_SPINNER[spinner]}&nbsp;&nbsp;{stage.detail}
            </span>
            <span style={{ ...mono, fontSize:10, color:dim, marginLeft:"auto" }}>
              stage {stageIdx+1}/{totalStages} · {overallPct}%
            </span>
          </div>

          <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:7 }}>
            <span style={{ ...mono, fontSize:12, color: isLLMStage ? "#a78bfa" : acc, whiteSpace:"pre", letterSpacing:"-0.01em",
              textShadow: isLLMStage ? "0 0 16px rgba(167,139,250,0.6)" : "0 0 16px rgba(232,255,107,0.6)" }}>
              [{stageBar}]
            </span>
            <span style={{ ...mono, fontSize:10, color: isLLMStage ? "#a78bfa" : acc, minWidth:30, textAlign:"right" }}>{pct}%</span>
          </div>

          <div style={{ ...mono, fontSize:9, color:"rgba(255,255,255,0.18)", whiteSpace:"pre", letterSpacing:"0.01em" }}>
            {"pipeline  "}{pipeBar}{"  "}{overallPct}%
          </div>
        </div>
      </div>
    </div>
  );
}

export default function Home() {
  const [jd, setJd] = useState('')
  const [loading, setLoading] = useState(false)
  const [results, setResults] = useState(null)
  const [jdParsed, setJdParsed] = useState(null)
  const [meta, setMeta] = useState(null)
  const [error, setError] = useState(null)
  const [expandedId, setExpandedId] = useState(null)

  const handleMatch = async () => {
    if (!jd.trim() || loading) return
    setLoading(true)
    setResults(null)
    setJdParsed(null)
    setMeta(null)
    setError(null)

    try {
      const res = await fetch('http://localhost:8000/api/match', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job_description: jd, use_llm: true }),
      })

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}))
        throw new Error(errData.detail || `Server error (${res.status})`)
      }

      const data = await res.json()
      setResults(data.results || [])
      setJdParsed(data.jd_parsed || null)
      setMeta(data.meta || null)
    } catch (err) {
      setError(err.message || 'Failed to connect to backend')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{
      position: 'absolute', inset: 0, display: 'flex',
      flexDirection: 'column', alignItems: 'center',
      justifyContent: 'flex-start',
      padding: '20px', paddingBottom: '40px', overflowY: 'auto',
      paddingTop: '100px',
      animation: 'fadeUp 0.4s ease both'
    }}>
      {!results && !error && (
        <div style={{ textAlign: 'center', marginBottom: '40px', animation: 'fadeUp 0.5s ease 0.1s both' }}>
          <div style={{
            fontSize: '11px', fontWeight: 500, letterSpacing: '0.18em',
            textTransform: 'uppercase', color: 'var(--accent)', marginBottom: '14px',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px'
          }}>
            <span style={{width:'30px',height:'1px',background:'var(--accent)',opacity:0.4,display:'inline-block'}}/>
            AI-Powered Matching
            <span style={{width:'30px',height:'1px',background:'var(--accent)',opacity:0.4,display:'inline-block'}}/>
          </div>
          <h1 style={{
            fontFamily: 'var(--font-display)', fontSize: 'clamp(36px,5vw,58px)',
            fontWeight: 800, letterSpacing: '-2px', lineHeight: 1.05,
            color: 'var(--text)', marginBottom: '12px'
          }}>
            Drop the JD.<br />
            <span style={{
              background: 'linear-gradient(135deg,#e8ff6b,#b8ff3a)',
              WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent'
            }}>We'll find your fit.</span>
          </h1>
          <p style={{ fontSize: '16px', color: 'var(--text-dim)', fontWeight: 300 }}>
            Paste any job description and instantly rank your resume versions with insights.
          </p>
        </div>
      )}

      {/* Input box */}
      <div style={{
        width: '100%', maxWidth: '720px',
        background: 'var(--surface)', border: '1px solid var(--border-bright)',
        borderRadius: 'var(--radius)', overflow: 'hidden',
        boxShadow: '0 24px 80px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.06)',
        animation: 'fadeUp 0.5s ease 0.2s both'
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: '10px',
          padding: '14px 18px', borderBottom: '1px solid var(--border)',
          background: 'rgba(255,255,255,0.02)'
        }}>
          {[['#ff5f57'],['#febc2e'],['#28c840']].map(([c], i) => (
            <div key={i} style={{ width:10,height:10,borderRadius:'50%',background:c }} />
          ))}
          <span style={{ marginLeft:'auto', fontSize:'11px', color:'var(--text-dim)', letterSpacing:'0.1em', textTransform:'uppercase' }}>
            Job Description
          </span>
        </div>

        <textarea
          style={{
            width: '100%', minHeight: results ? '80px' : '180px', maxHeight: '320px',
            background: 'transparent', border: 'none', outline: 'none',
            resize: 'none', color: 'var(--text)', fontFamily: 'var(--font-body)',
            fontSize: '15px', fontWeight: 300, lineHeight: 1.7,
            padding: '20px 22px', caretColor: 'var(--accent)',
            transition: 'min-height 0.3s ease',
          }}
          placeholder="Paste the job description here… (⌘+Enter to match)"
          value={jd}
          onChange={e => setJd(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleMatch() }}
        />

        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '12px 16px', borderTop: '1px solid var(--border)',
          background: 'rgba(255,255,255,0.015)'
        }}>
          <span style={{ fontSize: '12px', color: 'var(--text-dim)' }}>
            {jd.length > 0 ? `${jd.length} chars` : 'Empty'}
          </span>
          <button onClick={handleMatch} disabled={!jd.trim() || loading} style={{
            display: 'flex', alignItems: 'center', gap: '10px',
            padding: '12px 28px',
            background: !jd.trim() || loading ? 'rgba(255,255,255,0.08)' : 'var(--accent)',
            color: !jd.trim() || loading ? 'var(--text-dim)' : '#080808',
            border: 'none', borderRadius: '30px',
            fontFamily: 'var(--font-display)', fontSize: '14px', fontWeight: 700,
            cursor: !jd.trim() || loading ? 'not-allowed' : 'pointer',
            transition: 'all 0.2s ease'
          }}>
            {loading
              ? <><div style={{width:14,height:14,border:'2px solid rgba(0,0,0,0.3)',borderTopColor:'#080808',borderRadius:'50%',animation:'spin 0.7s linear infinite'}}/>Matching…</>
              : '✦ Match It'
            }
          </button>
        </div>
      </div>

      {/* Pipeline animation while loading */}
      {loading && <JDPipelineAnimation />}

      {/* Error state */}
      {error && (
        <div style={{
          width: '100%', maxWidth: '720px', marginTop: '20px',
          padding: '16px 20px', borderRadius: '12px',
          background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.2)',
          color: 'var(--danger)', fontSize: '14px', fontWeight: 400,
          animation: 'fadeUp 0.3s ease both',
        }}>
          {error}
        </div>
      )}

      {/* JD Parse Summary */}
      {jdParsed && results && (
        <div style={{
          width: '100%', maxWidth: '720px', marginTop: '20px',
          padding: '14px 18px', borderRadius: '12px',
          background: 'rgba(232,255,107,0.03)', border: '1px solid rgba(232,255,107,0.12)',
          animation: 'fadeUp 0.3s ease both',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
            <span style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--accent)' }}>
              JD Analysis
            </span>
            <span style={{
              fontSize: '10px', padding: '2px 8px', borderRadius: '10px',
              background: jdParsed.extraction_method === 'hybrid' ? 'rgba(52,211,153,0.12)' : 'rgba(255,255,255,0.06)',
              color: jdParsed.extraction_method === 'hybrid' ? 'var(--accent3)' : 'var(--text-dim)',
              border: `1px solid ${jdParsed.extraction_method === 'hybrid' ? 'rgba(52,211,153,0.2)' : 'rgba(255,255,255,0.08)'}`,
              fontWeight: 600,
            }}>
              {jdParsed.extraction_method === 'hybrid' ? 'Rule + LLM' : 'Rule-based'}
            </span>
            {meta?.llm_scored > 0 && (
              <span style={{
                fontSize: '10px', padding: '2px 8px', borderRadius: '10px',
                background: 'rgba(167,139,250,0.12)', color: '#a78bfa',
                border: '1px solid rgba(167,139,250,0.22)', fontWeight: 600,
              }}>
                ✦ {meta.llm_scored} AI-scored
              </span>
            )}
            {meta && (
              <span style={{ marginLeft: 'auto', fontSize: '11px', color: 'var(--text-dim)' }}>
                {meta.pipeline_time_ms}ms
              </span>
            )}
          </div>
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
            {jdParsed.title && (
              <span style={{ fontSize: '11px', fontWeight: 500, padding: '3px 10px', borderRadius: '20px', background: 'rgba(255,255,255,0.06)', color: 'var(--text)', border: '1px solid var(--border)' }}>
                {jdParsed.title}
              </span>
            )}
            {jdParsed.min_years && (
              <span style={{ fontSize: '11px', fontWeight: 500, padding: '3px 10px', borderRadius: '20px', background: 'rgba(255,255,255,0.06)', color: 'var(--text)', border: '1px solid var(--border)' }}>
                {jdParsed.min_years}+ yrs
              </span>
            )}
            {(jdParsed.required_skills || []).slice(0, 6).map(s => (
              <span key={s} style={{ fontSize: '11px', fontWeight: 500, padding: '3px 10px', borderRadius: '20px', background: 'rgba(232,255,107,0.06)', color: 'var(--accent)', border: '1px solid rgba(232,255,107,0.15)' }}>
                {s}
              </span>
            ))}
            {(jdParsed.required_skills || []).length > 6 && (
              <span style={{ fontSize: '11px', fontWeight: 500, padding: '3px 10px', color: 'var(--text-dim)' }}>
                +{jdParsed.required_skills.length - 6} more
              </span>
            )}
          </div>
        </div>
      )}

      {/* Results */}
      {results && results.length > 0 && (
        <div style={{ width: '100%', maxWidth: '720px', marginTop: '16px', animation: 'matchReveal 0.5s ease both' }}>
          <div style={{ fontFamily:'var(--font-display)', fontSize:'13px', fontWeight:600, letterSpacing:'0.1em', textTransform:'uppercase', color:'var(--text-dim)', marginBottom:'12px', paddingLeft:'4px' }}>
            Ranked Results — {results.length} resume{results.length !== 1 ? 's' : ''}
          </div>
          {results.map((r, i) => {
            const isExpanded = expandedId === r.resume_id
            const isLLM = r.scoring_method === 'llm+hybrid'
            const displayScore = r.llm_score ?? r.score ?? 0
            const rec = r.llm_recommendation
            const recStyle = rec ? recommendationStyle(rec) : null

            return (
              <div key={r.resume_id} style={{
                background: i === 0 ? 'rgba(232,255,107,0.04)' : 'var(--surface)',
                border: `1px solid ${i === 0 ? 'rgba(232,255,107,0.3)' : 'var(--border-bright)'}`,
                borderRadius: '14px', padding: '18px 22px', marginBottom: '10px',
                cursor: 'pointer', transition: 'all 0.2s ease',
                animation: `matchReveal 0.4s ease ${i * 0.07}s both`,
                boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
              }}
              onClick={() => setExpandedId(isExpanded ? null : r.resume_id)}
              >
                {/* Collapsed row */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '18px' }}>
                  <div style={{ fontFamily:'var(--font-display)', fontSize:'24px', fontWeight:800, color: i===0 ? 'var(--accent)' : 'rgba(255,255,255,0.15)', minWidth:'36px' }}>
                    #{i+1}
                  </div>
                  <div style={{ flex:1, minWidth:0 }}>
                    {/* Name + badges */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px', flexWrap: 'wrap' }}>
                      <span style={{ fontFamily:'var(--font-display)', fontSize:'16px', fontWeight:600, color:'var(--text)' }}>{r.name}</span>
                      <span style={{ fontSize: '10px', padding: '2px 6px', borderRadius: '6px', background: 'rgba(255,255,255,0.06)', color: 'var(--text-dim)', fontWeight: 500 }}>
                        {r.file_ext?.replace('.', '').toUpperCase()}
                      </span>
                      {isLLM && (
                        <span style={{ fontSize: '10px', padding: '2px 7px', borderRadius: '6px', background: 'rgba(167,139,250,0.12)', color: '#a78bfa', border: '1px solid rgba(167,139,250,0.22)', fontWeight: 700, letterSpacing: '0.04em' }}>
                          AI
                        </span>
                      )}
                      {rec && recStyle && (
                        <span style={{ fontSize: '10px', padding: '2px 9px', borderRadius: '20px', background: recStyle.bg, color: recStyle.color, border: `1px solid ${recStyle.border}`, fontWeight: 600 }}>
                          {rec}
                        </span>
                      )}
                    </div>
                    {/* Score bar */}
                    <div style={{ height:'4px', background:'rgba(255,255,255,0.08)', borderRadius:'4px', overflow:'hidden' }}>
                      <div style={{ height:'100%', borderRadius:'4px', background: scoreColor(displayScore), width:`${displayScore}%`, transition:'width 1s cubic-bezier(0.22,1,0.36,1)' }} />
                    </div>
                    {/* Skill pills */}
                    <div style={{ display:'flex', gap:'6px', marginTop:'8px', flexWrap:'wrap' }}>
                      {(r.matched_skills || []).slice(0,4).map(t => (
                        <span key={t} style={{ fontSize:'11px', fontWeight:500, padding:'3px 10px', borderRadius:'20px', background:'rgba(52,211,153,0.1)', color:'var(--accent3)', border:'1px solid rgba(52,211,153,0.2)' }}>✓ {t}</span>
                      ))}
                      {(r.missing_skills || []).slice(0,3).map(t => (
                        <span key={t} style={{ fontSize:'11px', fontWeight:500, padding:'3px 10px', borderRadius:'20px', background:'rgba(248,113,113,0.08)', color:'var(--danger)', border:'1px solid rgba(248,113,113,0.15)' }}>✗ {t}</span>
                      ))}
                    </div>
                  </div>
                  <div style={{ textAlign:'right', minWidth:'60px' }}>
                    <div style={{ fontFamily:'var(--font-display)', fontSize:'28px', fontWeight:800, letterSpacing:'-1px', color: i===0 ? 'var(--accent)' : 'var(--text)' }}>{displayScore}</div>
                    <div style={{ fontSize:'14px', color:'var(--text-dim)', fontWeight:300 }}>match</div>
                  </div>
                </div>

                {/* Expanded panel */}
                {isExpanded && (
                  <div style={{
                    marginTop: '16px', paddingTop: '16px',
                    borderTop: '1px solid var(--border)',
                    animation: 'fadeUp 0.25s ease both',
                  }}>

                    {/* AI Analysis block */}
                    {isLLM && r.llm_reasoning && (
                      <div style={{
                        marginBottom: '16px', padding: '14px 16px',
                        borderRadius: '10px',
                        background: 'rgba(167,139,250,0.05)',
                        borderLeft: '3px solid rgba(167,139,250,0.4)',
                      }}>
                        <div style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#a78bfa', marginBottom: '8px' }}>
                          ✦ AI Analysis
                        </div>
                        <p style={{ fontSize: '13px', color: 'var(--text-mid)', fontStyle: 'italic', lineHeight: 1.65, margin: '0 0 10px' }}>
                          {r.llm_reasoning}
                        </p>
                        {r.llm_key_strengths?.length > 0 && (
                          <div style={{ marginBottom: '8px' }}>
                            {r.llm_key_strengths.map((s, si) => (
                              <div key={si} style={{ display: 'flex', gap: '8px', fontSize: '12px', marginBottom: '4px' }}>
                                <span style={{ flexShrink: 0, color: 'var(--accent3)' }}>✓</span>
                                <span style={{ color: 'var(--text-mid)' }}>{s}</span>
                              </div>
                            ))}
                          </div>
                        )}
                        {r.llm_key_gaps?.length > 0 && (
                          <div>
                            {r.llm_key_gaps.map((g, gi) => (
                              <div key={gi} style={{ display: 'flex', gap: '8px', fontSize: '12px', marginBottom: '4px' }}>
                                <span style={{ flexShrink: 0, color: 'var(--danger)' }}>✗</span>
                                <span style={{ color: 'var(--text-mid)' }}>{g}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Score breakdown */}
                    <div style={{ marginBottom: '14px' }}>
                      <div style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-dim)', marginBottom: '8px' }}>
                        {isLLM ? 'AI Score Breakdown' : 'Score Breakdown'}
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                        {/* LLM 3-component bars (primary) */}
                        {isLLM && r.llm_components && Object.keys(r.llm_components).length > 0 && (
                          <>
                            {componentBar('Skills Fit',   r.llm_components.skills_fit      ?? 0, 'linear-gradient(90deg,#e8ff6b,#a3e635)')}
                            {componentBar('Experience',   r.llm_components.experience_fit  ?? 0, 'linear-gradient(90deg,#f59e0b,#f97316)')}
                            {componentBar('Trajectory',   r.llm_components.trajectory_fit  ?? 0, 'linear-gradient(90deg,#a78bfa,#c084fc)')}
                            {/* Hybrid baseline — dimmed */}
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', marginTop: '2px', opacity: 0.45 }}>
                              <span style={{ color: 'var(--text-dim)', minWidth: '80px', fontWeight: 500 }}>Keyword/Sem</span>
                              <div style={{ flex: 1, height: '3px', background: 'rgba(255,255,255,0.06)', borderRadius: '4px', overflow: 'hidden' }}>
                                <div style={{ height: '100%', borderRadius: '4px', background: 'rgba(255,255,255,0.2)', width: `${r.hybrid_score ?? 0}%` }} />
                              </div>
                              <span style={{ color: 'var(--text-dim)', minWidth: '28px', textAlign: 'right', fontFamily: 'var(--font-display)', fontWeight: 600 }}>{r.hybrid_score ?? 0}</span>
                            </div>
                          </>
                        )}
                        {/* Hybrid fallback 4-component bars */}
                        {!isLLM && r.components && (
                          <>
                            {componentBar('Semantic',   (r.components.semantic?.score   ?? 0) * 100, 'linear-gradient(90deg,#60a5fa,#818cf8)')}
                            {componentBar('Skills',     (r.components.skill?.score      ?? 0) * 100, 'linear-gradient(90deg,#e8ff6b,#a3e635)')}
                            {componentBar('Experience', (r.components.experience?.score ?? 0) * 100, 'linear-gradient(90deg,#f59e0b,#f97316)')}
                            {componentBar('Keywords',   (r.components.keyword?.score    ?? 0) * 100, 'linear-gradient(90deg,#a78bfa,#c084fc)')}
                          </>
                        )}
                      </div>
                    </div>

                    {/* Gap analysis */}
                    {r.gap_analysis && r.gap_analysis.gap_count > 0 && (
                      <div style={{ marginBottom: '12px' }}>
                        <div style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-dim)', marginBottom: '6px' }}>
                          Gaps ({r.gap_analysis.gap_count})
                        </div>
                        {r.gap_analysis.critical_gaps?.length > 0 && (
                          <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', marginBottom: '4px' }}>
                            {r.gap_analysis.critical_gaps.map(g => (
                              <span key={g} style={{ fontSize: '10px', fontWeight: 600, padding: '2px 8px', borderRadius: '10px', background: 'rgba(248,113,113,0.12)', color: '#f87171', border: '1px solid rgba(248,113,113,0.2)' }}>
                                ⚠ {g}
                              </span>
                            ))}
                          </div>
                        )}
                        <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>
                          Coverage: {Math.round((r.gap_analysis.coverage?.required || 0) * 100)}% required · {Math.round((r.gap_analysis.coverage?.preferred || 0) * 100)}% preferred
                        </div>
                      </div>
                    )}

                    {/* Resume meta */}
                    <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', fontSize: '11px', color: 'var(--text-dim)' }}>
                      {r.years_exp && <span>{r.years_exp} yrs exp</span>}
                      {r.titles?.length > 0 && <span>{r.titles[0]}</span>}
                      {r.domains?.length > 0 && <span>{r.domains.join(', ')}</span>}
                      <span>{r.chunk_count} chunks</span>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* No results */}
      {results && results.length === 0 && (
        <div style={{
          width: '100%', maxWidth: '720px', marginTop: '24px',
          textAlign: 'center', padding: '40px 20px',
          animation: 'fadeUp 0.3s ease both',
        }}>
          <div style={{ fontSize: '32px', marginBottom: '12px' }}>📄</div>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: '18px', fontWeight: 600, color: 'var(--text)', marginBottom: '8px' }}>
            No resumes to match against
          </div>
          <p style={{ fontSize: '14px', color: 'var(--text-dim)', fontWeight: 300 }}>
            Upload your resumes in the Resumes tab first, then come back to match.
          </p>
        </div>
      )}
    </div>
  )
}