const ROWS = [
  { icon:'🎨', label:'Theme',               value:'Dark (System)' },
  { icon:'🔔', label:'Notifications',        value:'Enabled'       },
  { icon:'🔑', label:'API Key',              value:'••••••••••••••' },
  { icon:'📦', label:'Plan',                 value:'Pro'           },
  { icon:'📊', label:'Matches this month',   value:'34'            },
]

export default function Account() {
  return (
    <div style={{ position:'absolute',inset:0,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'flex-start',padding:'20px',paddingTop:'200px',paddingBottom:'40px',overflowY:'auto',animation:'fadeUp 0.4s ease both' }}>
      <div style={{ width:80,height:80,borderRadius:'50%',background:'linear-gradient(135deg,#1a1a3e,#0d2a1f)',border:'2px solid var(--border-bright)',display:'flex',alignItems:'center',justifyContent:'center',fontFamily:'var(--font-display)',fontSize:'28px',fontWeight:800,marginBottom:'16px' }}>JD</div>
      <div style={{ fontFamily:'var(--font-display)',fontSize:'24px',fontWeight:800,letterSpacing:'-0.5px',marginBottom:'4px' }}>Jane Doe</div>
      <div style={{ fontSize:'14px',color:'var(--text-dim)',marginBottom:'32px' }}>jane.doe@example.com</div>
      <div style={{ width:'100%',maxWidth:'480px',background:'var(--surface)',border:'1px solid var(--border-bright)',borderRadius:'var(--radius)',overflow:'hidden',boxShadow:'0 8px 40px rgba(0,0,0,0.3)' }}>
        {ROWS.map((r, i) => (
          <div key={r.label} style={{ display:'flex',alignItems:'center',justifyContent:'space-between',padding:'18px 22px',borderBottom: i < ROWS.length-1 ? '1px solid var(--border)' : 'none',cursor:'pointer',transition:'background 0.2s' }}>
            <div style={{ fontSize:'14px',color:'var(--text-mid)',display:'flex',alignItems:'center',gap:'12px' }}>
              <span style={{ fontSize:'16px' }}>{r.icon}</span>
              {r.label}
            </div>
            <div style={{ fontSize:'13px',color:'var(--text-dim)' }}>{r.value}</div>
          </div>
        ))}
      </div>
      <button style={{ marginTop:'24px',padding:'12px 32px',background:'rgba(248,113,113,0.1)',border:'1px solid rgba(248,113,113,0.2)',color:'var(--danger)',borderRadius:'30px',fontFamily:'var(--font-body)',fontSize:'14px',fontWeight:500,cursor:'pointer',transition:'all 0.2s' }}>
        Sign out
      </button>
    </div>
  )
}