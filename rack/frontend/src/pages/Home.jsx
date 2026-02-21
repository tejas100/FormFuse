import { useState, useRef } from 'react'

const MOCK_RESUMES = [
  { id: 1, name: 'Software Engineer v3',  skills: ['React','Node','Python'] },
  { id: 2, name: 'Full Stack — Startup',  skills: ['Vue','FastAPI','AWS'] },
  { id: 3, name: 'Backend Specialist',    skills: ['Go','PostgreSQL','Docker'] },
  { id: 4, name: 'ML Engineer Focus',     skills: ['Python','PyTorch','MLflow'] },
]

function scoreColor(score) {
  if (score >= 85) return 'linear-gradient(90deg,#e8ff6b,#a3e635)'
  if (score >= 65) return 'linear-gradient(90deg,#60a5fa,#818cf8)'
  return 'linear-gradient(90deg,#f87171,#fb923c)'
}

async function runMatch(jd) {
  return new Promise(res => setTimeout(() => {
    res(MOCK_RESUMES.map(r => {
      const score = Math.min(99, Math.floor(Math.random() * 40) + 55)
      const matched = r.skills.filter(() => Math.random() > 0.4)
      const missing = ['CI/CD','TypeScript','Redis','k8s'].filter(() => Math.random() > 0.6)
      return { ...r, score, matched, missing }
    }).sort((a, b) => b.score - a.score))
  }, 2200))
}

export default function Home() {
  const [jd, setJd] = useState('')
  const [loading, setLoading] = useState(false)
  const [results, setResults] = useState(null)

  const handleMatch = async () => {
    if (!jd.trim() || loading) return
    setLoading(true)
    setResults(null)
    const res = await runMatch(jd)
    setResults(res)
    setLoading(false)
  }

  return (
    <div style={{
      position: 'absolute', inset: 0, display: 'flex',
      flexDirection: 'column', alignItems: 'center',
      justifyContent: 'flex-start',
      padding: '20px', paddingTop: results ? '200px' : '0',
      paddingBottom: '40px', overflowY: 'auto',
      paddingTop: results ? '100px' : '100px',
      animation: 'fadeUp 0.4s ease both'
    }}>
      {!results && (
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
            Paste any job description and instantly rank your resume versions.
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
            width: '100%', minHeight: '180px', maxHeight: '320px',
            background: 'transparent', border: 'none', outline: 'none',
            resize: 'none', color: 'var(--text)', fontFamily: 'var(--font-body)',
            fontSize: '15px', fontWeight: 300, lineHeight: 1.7,
            padding: '20px 22px', caretColor: 'var(--accent)'
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

      {/* Results */}
      {results && (
        <div style={{ width: '100%', maxWidth: '720px', marginTop: '24px', animation: 'matchReveal 0.5s ease both' }}>
          <div style={{ fontFamily:'var(--font-display)', fontSize:'13px', fontWeight:600, letterSpacing:'0.1em', textTransform:'uppercase', color:'var(--text-dim)', marginBottom:'12px', paddingLeft:'4px' }}>
            Ranked Results — {results.length} resumes
          </div>
          {results.map((r, i) => (
            <div key={r.id} style={{
              background: i === 0 ? 'rgba(232,255,107,0.04)' : 'var(--surface)',
              border: `1px solid ${i === 0 ? 'rgba(232,255,107,0.3)' : 'var(--border-bright)'}`,
              borderRadius: '14px', padding: '18px 22px', marginBottom: '10px',
              display: 'flex', alignItems: 'center', gap: '18px',
              cursor: 'pointer', transition: 'all 0.2s ease',
              animation: `matchReveal 0.4s ease ${i * 0.07}s both`,
              boxShadow: '0 4px 20px rgba(0,0,0,0.3)'
            }}>
              <div style={{ fontFamily:'var(--font-display)', fontSize:'24px', fontWeight:800, color: i===0 ? 'var(--accent)' : 'rgba(255,255,255,0.15)', minWidth:'36px' }}>
                #{i+1}
              </div>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontFamily:'var(--font-display)', fontSize:'16px', fontWeight:600, color:'var(--text)', marginBottom:'6px' }}>{r.name}</div>
                <div style={{ height:'4px', background:'rgba(255,255,255,0.08)', borderRadius:'4px', overflow:'hidden' }}>
                  <div style={{ height:'100%', borderRadius:'4px', background: scoreColor(r.score), width:`${r.score}%`, transition:'width 1s cubic-bezier(0.22,1,0.36,1)' }} />
                </div>
                <div style={{ display:'flex', gap:'6px', marginTop:'8px', flexWrap:'wrap' }}>
                  {r.matched.slice(0,3).map(t => (
                    <span key={t} style={{ fontSize:'11px', fontWeight:500, padding:'3px 10px', borderRadius:'20px', background:'rgba(52,211,153,0.1)', color:'var(--accent3)', border:'1px solid rgba(52,211,153,0.2)' }}>✓ {t}</span>
                  ))}
                  {r.missing.slice(0,2).map(t => (
                    <span key={t} style={{ fontSize:'11px', fontWeight:500, padding:'3px 10px', borderRadius:'20px', background:'rgba(248,113,113,0.08)', color:'var(--danger)', border:'1px solid rgba(248,113,113,0.15)' }}>✗ {t}</span>
                  ))}
                </div>
              </div>
              <div style={{ textAlign:'right', minWidth:'60px' }}>
                <div style={{ fontFamily:'var(--font-display)', fontSize:'28px', fontWeight:800, letterSpacing:'-1px', color: i===0 ? 'var(--accent)' : 'var(--text)' }}>{r.score}</div>
                <div style={{ fontSize:'14px', color:'var(--text-dim)', fontWeight:300 }}>match</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}