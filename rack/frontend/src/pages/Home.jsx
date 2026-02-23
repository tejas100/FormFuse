import { useState, useRef } from 'react'

function scoreColor(score) {
  if (score >= 85) return 'linear-gradient(90deg,#e8ff6b,#a3e635)'
  if (score >= 65) return 'linear-gradient(90deg,#60a5fa,#818cf8)'
  return 'linear-gradient(90deg,#f87171,#fb923c)'
}

function componentBar(label, value, color) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px' }}>
      <span style={{ color: 'var(--text-dim)', minWidth: '70px', fontWeight: 500 }}>{label}</span>
      <div style={{ flex: 1, height: '4px', background: 'rgba(255,255,255,0.06)', borderRadius: '4px', overflow: 'hidden' }}>
        <div style={{ height: '100%', borderRadius: '4px', background: color, width: `${Math.round(value * 100)}%`, transition: 'width 0.8s cubic-bezier(0.22,1,0.36,1)' }} />
      </div>
      <span style={{ color: 'var(--text-dim)', minWidth: '28px', textAlign: 'right', fontFamily: 'var(--font-display)', fontWeight: 600 }}>{Math.round(value * 100)}</span>
    </div>
  )
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
                {/* Main row */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '18px' }}>
                  <div style={{ fontFamily:'var(--font-display)', fontSize:'24px', fontWeight:800, color: i===0 ? 'var(--accent)' : 'rgba(255,255,255,0.15)', minWidth:'36px' }}>
                    #{i+1}
                  </div>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
                      <span style={{ fontFamily:'var(--font-display)', fontSize:'16px', fontWeight:600, color:'var(--text)' }}>{r.name}</span>
                      <span style={{ fontSize: '10px', padding: '2px 6px', borderRadius: '6px', background: 'rgba(255,255,255,0.06)', color: 'var(--text-dim)', fontWeight: 500 }}>
                        {r.file_ext?.replace('.', '').toUpperCase()}
                      </span>
                    </div>
                    <div style={{ height:'4px', background:'rgba(255,255,255,0.08)', borderRadius:'4px', overflow:'hidden' }}>
                      <div style={{ height:'100%', borderRadius:'4px', background: scoreColor(r.score), width:`${r.score}%`, transition:'width 1s cubic-bezier(0.22,1,0.36,1)' }} />
                    </div>
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
                    <div style={{ fontFamily:'var(--font-display)', fontSize:'28px', fontWeight:800, letterSpacing:'-1px', color: i===0 ? 'var(--accent)' : 'var(--text)' }}>{r.score}</div>
                    <div style={{ fontSize:'14px', color:'var(--text-dim)', fontWeight:300 }}>match</div>
                  </div>
                </div>

                {/* Expanded detail panel */}
                {isExpanded && (
                  <div style={{
                    marginTop: '16px', paddingTop: '16px',
                    borderTop: '1px solid var(--border)',
                    animation: 'fadeUp 0.25s ease both',
                  }}>
                    {/* Score components */}
                    <div style={{ marginBottom: '14px' }}>
                      <div style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-dim)', marginBottom: '8px' }}>
                        Score Breakdown
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                        {r.components && (
                          <>
                            {componentBar('Semantic', r.components.semantic?.score || 0, 'linear-gradient(90deg,#60a5fa,#818cf8)')}
                            {componentBar('Skills', r.components.skill?.score || 0, 'linear-gradient(90deg,#e8ff6b,#a3e635)')}
                            {componentBar('Experience', r.components.experience?.score || 0, 'linear-gradient(90deg,#f59e0b,#f97316)')}
                            {componentBar('Keywords', r.components.keyword?.score || 0, 'linear-gradient(90deg,#a78bfa,#c084fc)')}
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

      {/* No results state */}
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