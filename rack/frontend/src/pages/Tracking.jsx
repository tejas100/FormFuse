const TRACKS = [
  { id:1, role:'Senior Frontend Engineer', company:'Stripe',   date:'Feb 14', match:92, status:'screen'   },
  { id:2, role:'Full Stack Developer',     company:'Linear',   date:'Feb 10', match:87, status:'applied'  },
  { id:3, role:'Software Engineer II',     company:'Vercel',   date:'Feb 5',  match:79, status:'offer'    },
  { id:4, role:'Backend Engineer',         company:'Supabase', date:'Jan 28', match:64, status:'rejected' },
]

const STATUS = {
  applied:  { color:'#a78bfa', label:'Applied'   },
  screen:   { color:'#60a5fa', label:'Screening' },
  offer:    { color:'#34d399', label:'Offer 🎉'  },
  rejected: { color:'#f87171', label:'Rejected'  },
}

export default function Tracking() {
  return (
    <div style={{ position:'absolute',inset:0,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'flex-start',padding:'20px',paddingTop:'200px',paddingBottom:'40px',overflowY:'auto',animation:'fadeUp 0.4s ease both' }}>
      <div style={{ width:'100%', maxWidth:'720px' }}>
        <div style={{ fontFamily:'var(--font-display)',fontSize:'32px',fontWeight:800,letterSpacing:'-1px',marginBottom:'6px' }}>Application Tracker</div>
        <div style={{ fontSize:'14px',color:'var(--text-dim)',marginBottom:'32px' }}>{TRACKS.length} applications · 1 offer pending</div>
        {TRACKS.map((t, i) => (
          <div key={t.id} style={{
            background:'var(--surface)', border:'1px solid var(--border-bright)',
            borderRadius:'14px', padding:'18px 22px', marginBottom:'10px',
            display:'flex', alignItems:'center', gap:'16px',
            animation:`fadeUp 0.4s ease ${i*0.07}s both`, transition:'all 0.2s'
          }}>
            <div style={{ width:10,height:10,borderRadius:'50%',flexShrink:0, background:STATUS[t.status].color, boxShadow:`0 0 8px ${STATUS[t.status].color}` }} />
            <div style={{ flex:1 }}>
              <div style={{ fontFamily:'var(--font-display)',fontSize:'15px',fontWeight:600,color:'var(--text)' }}>{t.role}</div>
              <div style={{ fontSize:'13px',color:'var(--text-dim)',marginTop:'2px' }}>{t.company} · Applied {t.date}</div>
            </div>
            <div style={{ fontFamily:'var(--font-display)',fontSize:'20px',fontWeight:800,color:'var(--accent)' }}>{t.match}%</div>
            <span style={{ fontSize:'11px',fontWeight:600,padding:'4px 10px',borderRadius:'20px',textTransform:'uppercase',letterSpacing:'0.08em', background:`${STATUS[t.status].color}18`, color:STATUS[t.status].color }}>
              {STATUS[t.status].label}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}