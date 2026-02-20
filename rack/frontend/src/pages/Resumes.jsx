const MOCK_RESUMES = [
  { id:1, name:'Software Engineer v3',  updated:'2 days ago',  status:'active', skills:['React','Node','Python'] },
  { id:2, name:'Full Stack — Startup',  updated:'1 week ago',  status:'active', skills:['Vue','FastAPI','AWS'] },
  { id:3, name:'Backend Specialist',    updated:'2 weeks ago', status:'draft',  skills:['Go','PostgreSQL','Docker'] },
  { id:4, name:'ML Engineer Focus',     updated:'1 month ago', status:'draft',  skills:['Python','PyTorch','MLflow'] },
]

export default function Resumes() {
  return (
    <div style={{ position:'absolute',inset:0,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'flex-start',padding:'20px',paddingTop:'200px',paddingBottom:'40px',overflowY:'auto',animation:'fadeUp 0.4s ease both' }}>
      <div style={{ width:'100%', maxWidth:'800px' }}>
        <div style={{ fontFamily:'var(--font-display)',fontSize:'32px',fontWeight:800,letterSpacing:'-1px',marginBottom:'6px' }}>Your Resumes</div>
        <div style={{ fontSize:'14px',color:'var(--text-dim)',marginBottom:'32px' }}>{MOCK_RESUMES.length} versions · 2 active</div>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(220px,1fr))', gap:'14px' }}>
          {MOCK_RESUMES.map((r, i) => (
            <div key={r.id} style={{
              background:'var(--surface)', border:'1px solid var(--border-bright)',
              borderRadius:'16px', padding:'22px', cursor:'pointer',
              transition:'all 0.2s ease', animation:`fadeUp 0.4s ease ${i*0.07}s both`,
              boxShadow:'0 4px 20px rgba(0,0,0,0.2)', position:'relative', overflow:'hidden'
            }}>
              <span style={{ fontSize:'28px', marginBottom:'14px', display:'block' }}>📄</span>
              <span style={{
                position:'absolute', top:'14px', right:'14px',
                fontSize:'10px', fontWeight:600, padding:'3px 8px', borderRadius:'10px',
                textTransform:'uppercase', letterSpacing:'0.08em',
                background: r.status==='active' ? 'rgba(52,211,153,0.15)' : 'rgba(255,255,255,0.06)',
                color: r.status==='active' ? 'var(--accent3)' : 'var(--text-dim)'
              }}>{r.status}</span>
              <div style={{ fontFamily:'var(--font-display)',fontSize:'15px',fontWeight:700,color:'var(--text)',marginBottom:'4px' }}>{r.name}</div>
              <div style={{ fontSize:'12px',color:'var(--text-dim)',marginBottom:'10px' }}>Updated {r.updated}</div>
              <div style={{ display:'flex',gap:'6px',flexWrap:'wrap' }}>
                {r.skills.map(s => (
                  <span key={s} style={{ fontSize:'11px',fontWeight:500,padding:'3px 10px',borderRadius:'20px',background:'rgba(255,255,255,0.06)',color:'var(--text-dim)',border:'1px solid var(--border)' }}>{s}</span>
                ))}
              </div>
            </div>
          ))}
          <button style={{
            background:'transparent', border:'1px dashed rgba(255,255,255,0.15)',
            borderRadius:'16px', padding:'22px', cursor:'pointer',
            display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center',
            gap:'8px', minHeight:'130px', color:'var(--text-dim)',
            fontFamily:'var(--font-body)', fontSize:'13px', transition:'all 0.2s ease'
          }}>
            <span style={{ fontSize:'24px', color:'rgba(255,255,255,0.2)' }}>+</span>
            Add resume
          </button>
        </div>
      </div>
    </div>
  )
}