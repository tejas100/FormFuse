/**
 * RackMail — Gmail-style inbox for Rack's auto-applied jobs.
 *
 * Self-contained React component. No external deps beyond React.
 * Drop into your Vite app and render <RackMail /> in the "Emails" route.
 *
 *   import RackMail from "./RackMail.jsx";
 *   <RackMail userName="Tejas" inboxAddress="tejas.apply@rackmail.app" theme="dark" />
 *
 * Props (all optional):
 *   userName       string   — greeting + avatar initial          (default "Tejas")
 *   inboxAddress   string   — the Rack-owned address shown as "to" (default "tejas.apply@rackmail.app")
 *   theme          "dark"|"light"  — initial theme                (default "dark")
 *   emails         Email[]  — override the demo data (see EMAILS shape below)
 */

import React, { useMemo, useState, useEffect } from "react";
import Sidebar from "../components/Sidebar";
import { useTheme } from "../App";

/* ────────────────────────────────────────────────────────────
   Theme tokens. Mirrors the Rack dashboard design system.
   Injected once, scoped to .rk-mail-root via data-theme.
──────────────────────────────────────────────────────────── */
const THEME_CSS = `
.rk-mail-root[data-theme="dark"]{
  --bg:#0b0b0d; --surface:#141417; --surface2:#1b1b1f; --surface3:#242429;
  --border:rgba(255,255,255,0.07); --border-bright:rgba(255,255,255,0.12);
  --hairline:rgba(255,255,255,0.06);
  --text:#f2f2ef; --text-dim:rgba(255,255,255,0.40); --text-mid:rgba(255,255,255,0.66);
  --accent:#e8ff6b; --accent-strong:#d9f254; --accent-ink:#dcf45f; --accent-contrast:#0a0a0a;
  --accent-soft:rgba(232,255,107,0.07); --accent-line:rgba(232,255,107,0.24);
  --accent2:#a78bfa; --accent3:#34d399; --danger:#f08a8a; --info:#60a5fa;
  --ring-track:rgba(255,255,255,0.08); --chip-bg:rgba(255,255,255,0.04); --chip-border:rgba(255,255,255,0.08);
  --card-shadow:0 1px 2px rgba(0,0,0,0.28), 0 4px 14px rgba(0,0,0,0.22);
  --header-bg:rgba(11,11,13,0.72);
  --scrollbar-thumb:rgba(255,255,255,0.12);
  --sidebar-bg:#0e0e10; --read-bg:#101013; --unread-bg:rgba(232,255,107,0.035);
  --mobile-bar-bg:rgba(11,11,13,0.96);
}
.rk-mail-root[data-theme="light"]{
  --bg:#F5F3EC; --surface:#FFFFFF; --surface2:#F1EEE5; --surface3:#E7E3D8;
  --border:rgba(56,50,28,0.11); --border-bright:rgba(56,50,28,0.17);
  --hairline:rgba(56,50,28,0.08);
  --text:#1B1A15; --text-dim:rgba(34,30,18,0.44); --text-mid:rgba(28,25,15,0.64);
  --accent:#c2dd2f; --accent-strong:#b1cc1c; --accent-ink:#5f7611; --accent-contrast:#16180a;
  --accent-soft:rgba(120,150,0,0.10); --accent-line:rgba(120,150,0,0.28);
  --accent2:#7c3aed; --accent3:#059669; --danger:#dc2626; --info:#2563eb;
  --ring-track:rgba(0,0,0,0.07); --chip-bg:rgba(40,34,16,0.045); --chip-border:rgba(56,50,28,0.10);
  --card-shadow:0 1px 2px rgba(60,52,30,0.05), 0 4px 14px rgba(60,52,30,0.06);
  --header-bg:rgba(245,243,236,0.78);
  --scrollbar-thumb:rgba(0,0,0,0.13);
  --sidebar-bg:#EFEDE4; --read-bg:#FBFAF4; --unread-bg:rgba(120,150,0,0.05);
  --mobile-bar-bg:rgba(245,243,236,0.96);
}
.rk-mail-root{ --font-mono:"Fira Code", ui-monospace, Menlo, monospace; --font-sans:"DM Sans", system-ui, sans-serif; --ease:cubic-bezier(0.4,0,0.2,1); }
.rk-mail-root *{ box-sizing:border-box; }
.rk-mail-root button, .rk-mail-root a, .rk-mail-root input{ transition: box-shadow .2s var(--ease), background-color .2s var(--ease), border-color .2s var(--ease), color .18s var(--ease); }
.rk-mail-root ::-webkit-scrollbar{ width:9px; height:9px; }
.rk-mail-root ::-webkit-scrollbar-thumb{ background:var(--scrollbar-thumb); border-radius:6px; border:2px solid transparent; background-clip:padding-box; }
.rk-mail-root ::-webkit-scrollbar-track{ background:transparent; }
.rk-mail-row:hover{ background:var(--surface2) !important; }
.rk-mail-nav:hover{ background:var(--surface2) !important; }
.rk-mail-icobtn:hover{ background:var(--surface2) !important; color:var(--text) !important; }
.rk-mail-slot:hover{ border-color:var(--info) !important; background:var(--surface2) !important; }
.rk-mail-accentbtn:hover{ background:var(--accent-strong) !important; }

/* ─── Mobile responsive layout ─── */
/* Mobile top bar */
.rk-mob-topbar{
  display:none;
  align-items:center;
  gap:10px;
  padding:0 16px;
  height:56px;
  flex:none;
  background:var(--mobile-bar-bg);
  backdrop-filter:blur(20px) saturate(140%);
  -webkit-backdrop-filter:blur(20px) saturate(140%);
  border-bottom:1px solid var(--border);
  position:sticky;
  top:0;
  z-index:10;
}
.rk-mob-back{
  width:36px; height:36px; border-radius:10px; border:1px solid var(--border-bright);
  background:var(--surface); cursor:pointer; color:var(--text-mid);
  display:flex; align-items:center; justify-content:center; flex:none;
}
.rk-mob-back:hover{ background:var(--surface2) !important; color:var(--text) !important; }
.rk-mob-compose{
  width:36px; height:36px; border-radius:10px; border:none;
  background:var(--accent); cursor:pointer; color:var(--accent-contrast);
  display:flex; align-items:center; justify-content:center; flex:none;
}
/* Mobile bottom nav bar */
.rk-mob-bottomnav{
  display:none;
  align-items:stretch;
  height:calc(56px + env(safe-area-inset-bottom, 0px));
  padding-bottom:env(safe-area-inset-bottom, 0px);
  flex:none;
  background:var(--mobile-bar-bg);
  backdrop-filter:blur(20px) saturate(140%);
  -webkit-backdrop-filter:blur(20px) saturate(140%);
  border-top:1px solid var(--border);
  position:sticky;
  bottom:0;
  z-index:10;
}
.rk-mob-navbtn{
  flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center;
  gap:4px; border:none; background:transparent; cursor:pointer;
  font-family:var(--font-sans); font-size:10px; font-weight:500;
  color:var(--text-dim); padding:0;
}
.rk-mob-navbtn.active{ color:var(--accent-ink); }
.rk-mob-navbtn.active svg{ stroke:var(--accent-ink); }

@media (max-width: 768px){
  /* Hide the shared Rack sidebar entirely on mobile */
  .rk-mail-root > aside,
  .rk-mail-root > div:first-child:not(.rk-mail-layout){ display:none !important; }

  /* Main layout container */
  .rk-mail-layout{ flex-direction:column !important; }

  /* Show mobile bars */
  .rk-mob-topbar{ display:flex; }
  .rk-mob-bottomnav{ display:flex; }

  /* All three panels become full-width */
  .rk-mail-folder-rail{
    width:100% !important;
    height:auto !important;
    flex:1 !important;
    border-right:none !important;
    overflow-y:auto;
    padding:16px !important;
  }
  .rk-mail-list-panel{
    width:100% !important;
    height:auto !important;
    flex:1 !important;
    border-right:none !important;
    overflow-y:auto;
  }
  .rk-mail-reading-pane{
    width:100% !important;
    height:auto !important;
    flex:1 !important;
    overflow-y:auto;
  }

  /* Three-panel row adapts to full-height column slot */
  .rk-mail-layout > div:first-child > div:nth-child(2){
    flex:1;
    overflow:hidden;
    min-height:0;
  }

  /* Hide list panel header (search+title) on mobile — top bar handles this */
  .rk-list-header{ display:none !important; }

  /* Show mobile search + filter controls */
  .rk-mob-list-controls{ display:flex !important; }

  /* Hide reading pane sticky toolbar on mobile — top bar handles navigation */
  .rk-reading-toolbar{ display:none !important; }

  /* List scroll area: padding for bottom nav */
  .rk-mail-list-panel > div:last-child{
    padding-bottom:8px !important;
  }

  /* Email cards: slightly more touch-friendly */
  .rk-mail-row{ padding:14px 10px !important; }

  /* Reading pane: padding for bottom nav */
  .rk-email-body{
    padding:20px 18px 80px !important;
    max-width:100% !important;
  }
  .rk-email-body h1{ font-size:19px !important; }

  /* Application snapshot grid: stack on mobile */
  .rk-snapshot-grid{
    grid-template-columns:1fr !important;
    gap:12px !important;
  }

  /* Compose window: full-screen on mobile */
@keyframes rk-compose-in{
  from{ transform:translateY(100%); opacity:0; }
  to{   transform:translateY(0);    opacity:1; }
}
@keyframes rk-compose-in-desktop{
  from{ transform:translateY(32px); opacity:0; }
  to{   transform:translateY(0);    opacity:1; }
}
.rk-compose-window{
  animation: rk-compose-in-desktop 0.28s cubic-bezier(0.32,0.72,0,1) both;
}

  .rk-compose-window{
    right:0 !important; left:0 !important;
    width:100% !important;
    max-width:100% !important;
    border-radius:20px 20px 0 0 !important;
    animation: rk-compose-in 0.36s cubic-bezier(0.32,0.72,0,1) both !important;
  }

  /* Reply dock edge-to-edge */
  .rk-reply-dock{ border-radius:0 !important; border-left:none !important; border-right:none !important; }

  /* Offer stats wrap tighter */
  .rk-offer-stats{ gap:16px !important; }

  /* Hide desktop search bar shortcut key */
  .rk-search-shortcut{ display:none !important; }
}

/* Panel visibility on mobile — controlled by data-panel on rk-mail-layout */
@media (max-width: 768px){
  .rk-mail-layout[data-panel="folders"] .rk-mail-list-panel,
  .rk-mail-layout[data-panel="folders"] .rk-mail-reading-pane{ display:none !important; }
  .rk-mail-layout[data-panel="folders"] .rk-mail-folder-rail{ display:flex !important; }

  .rk-mail-layout[data-panel="list"] .rk-mail-folder-rail,
  .rk-mail-layout[data-panel="list"] .rk-mail-reading-pane{ display:none !important; }
  .rk-mail-layout[data-panel="list"] .rk-mail-list-panel{ display:flex !important; }

  .rk-mail-layout[data-panel="reading"] .rk-mail-folder-rail,
  .rk-mail-layout[data-panel="reading"] .rk-mail-list-panel{ display:none !important; }
  .rk-mail-layout[data-panel="reading"] .rk-mail-reading-pane{ display:block !important; }
}

/* Tablet: hide folder rail, give list less width */
@media (min-width: 769px) and (max-width: 1100px){
  .rk-mail-folder-rail{ display:none !important; }
  .rk-mail-list-panel{ width:300px !important; }
}
`;

/* ────────────────────────────────────────────────────────────
   Demo data — every auto-applied job lands here as an email.
──────────────────────────────────────────────────────────── */
const EMAILS = [
  { id:"m1", company:"Pinterest", mono:"P", brand:"#e60023",
    fromName:"Pinterest Talent", fromEmail:"no-reply@greenhouse.io", via:"GREENHOUSE",
    subject:"Application received — Software Engineer II, Backend",
    snippet:"Thanks for your interest. We've received your application and our team is reviewing it.",
    time:"9:24 AM", fullTime:"Today at 9:24 AM", kind:"confirmation",
    role:"Software Engineer II, Backend", location:"San Francisco, CA · Hybrid",
    appliedDate:"Today, 9:24 AM", resume:"Backend_2026.pdf", unread:true, starred:true, attachment:false,
    paragraphs:[
      "Thank you for applying to the <strong>Software Engineer II, Backend</strong> role at Pinterest. This note confirms that your application was received successfully and is now in our review queue.",
      "Our recruiting team carefully reviews every application. If your background is a match for what we're looking for, a recruiter will reach out to schedule an initial conversation.",
    ],
    closing:"You can expect to hear from us within <strong>5–7 business days</strong>. No action is needed from you in the meantime.",
    signoff:"— The Pinterest Talent Team" },

  { id:"m2", company:"Reddit", mono:"R", brand:"#ff4500",
    fromName:"Reddit Recruiting", fromEmail:"careers@reddit.com", via:"GREENHOUSE",
    subject:"Thanks for applying to Reddit",
    snippet:"We've got your application for Senior Staff Software Engineer, Indexing & Retrieval.",
    time:"9:21 AM", fullTime:"Today at 9:21 AM", kind:"confirmation",
    role:"Senior Staff Software Engineer", location:"Remote — United States",
    appliedDate:"Today, 9:21 AM", resume:"Platform_Infra.pdf", unread:true, starred:false, attachment:false,
    paragraphs:[
      "We've received your application for the <strong>Senior Staff Software Engineer, Indexing &amp; Retrieval Platform</strong> position. Thanks for taking the time to apply.",
      "A member of our talent team will review your experience against the needs of the role and follow up if there's a fit.",
    ],
    closing:"We appreciate your patience during the review process and will be in touch soon.",
    signoff:"— Reddit Talent Acquisition" },

  { id:"m3", company:"Stripe", mono:"S", brand:"#635bff",
    fromName:"Maya Chen", fromEmail:"maya.chen@stripe.com", via:"ASHBY",
    subject:"Let's schedule your first interview",
    snippet:"Your background stood out — we'd love to set up a 30-minute intro call this week.",
    time:"8:10 AM", fullTime:"Today at 8:10 AM", kind:"interview",
    role:"Senior Machine Learning Engineer", location:"San Francisco, CA",
    appliedDate:"2 days ago", resume:"ML_Engineer_2026.pdf", unread:true, starred:false, attachment:false,
    paragraphs:[
      "Thanks for applying to Stripe — your experience with distributed ML systems really stood out to our hiring team for the <strong>Senior Machine Learning Engineer</strong> role.",
      "I'd love to set up a 30-minute introductory call to tell you more about the team and learn about what you're looking for. Pick whichever time works best below and I'll send a calendar invite.",
    ],
    slots:["Thu, Jun 26 · 11:00 AM PT", "Fri, Jun 27 · 2:30 PM PT", "Mon, Jun 30 · 9:00 AM PT"],
    closing:"Looking forward to connecting. Let me know if none of these work and I'll find more options.",
    signoff:"— Maya Chen, Technical Recruiter at Stripe" },

  { id:"m4", company:"Linear", mono:"L", brand:"#5e6ad2",
    fromName:"Linear People", fromEmail:"people@linear.app", via:"ASHBY",
    subject:"Offer of employment — Product Engineer",
    snippet:"We're thrilled to extend you an offer to join Linear as a Product Engineer.",
    time:"Mon", fullTime:"Mon, Jun 23 at 4:02 PM", kind:"offer",
    role:"Product Engineer", location:"Remote — Global",
    appliedDate:"2 weeks ago", resume:"Frontend_AI.pdf", unread:false, starred:true, attachment:true,
    paragraphs:[
      "On behalf of the entire team, we're thrilled to extend you an offer to join <strong>Linear</strong> as a Product Engineer. Everyone you met was impressed by your craft and the way you think about product.",
      "The full offer details and equity breakdown are attached as a PDF. Here's a quick summary:",
    ],
    offerStats:[ { value:"$232K", label:"Base salary" }, { value:"0.12%", label:"Equity" }, { value:"$25K", label:"Signing bonus" } ],
    closing:"This offer is open for <strong>10 days</strong>. We'd be delighted to have you — let us know if you'd like to talk anything through.",
    signoff:"— The Linear Team" },

  { id:"m5", company:"Notion", mono:"N", brand:"#5b6472",
    fromName:"Notion Recruiting", fromEmail:"talent@notion.so", via:"LEVER",
    subject:"Next steps in your application",
    snippet:"We'd like to move you forward to a technical screen for the Staff AI Infra role.",
    time:"Tue", fullTime:"Tue, Jun 24 at 1:15 PM", kind:"interview",
    role:"Staff AI Infrastructure Engineer", location:"Remote · US",
    appliedDate:"4 days ago", resume:"Platform_Infra.pdf", unread:false, starred:false, attachment:false,
    paragraphs:[
      "Good news — we've reviewed your application for the <strong>Staff AI Infrastructure Engineer</strong> role and we'd like to move you forward to a 60-minute technical screen.",
      "Please choose a time below. You'll meet with two engineers from the AI platform team.",
    ],
    slots:["Wed, Jun 25 · 3:00 PM ET", "Thu, Jun 26 · 10:00 AM ET"],
    closing:"Come ready to talk through a system design problem — nothing to prepare in advance.",
    signoff:"— Notion Talent" },

  { id:"m6", company:"Ramp", mono:"R", brand:"#c97a13",
    fromName:"Ramp Careers", fromEmail:"no-reply@ashbyhq.com", via:"ASHBY",
    subject:"Your application to Ramp",
    snippet:"This confirms we received your application for AI Application Engineer.",
    time:"Tue", fullTime:"Tue, Jun 24 at 11:48 AM", kind:"confirmation",
    role:"AI Application Engineer", location:"New York, NY",
    appliedDate:"Yesterday", resume:"Frontend_AI.pdf", unread:false, starred:false, attachment:false,
    paragraphs:[
      "This is a confirmation that we've received your application for the <strong>AI Application Engineer</strong> position at Ramp.",
      "We're reviewing applications on a rolling basis and will reach out if your profile aligns with the role.",
    ],
    closing:"Thanks for your interest in building with us.",
    signoff:"— Ramp Recruiting" },

  { id:"m7", company:"Vanta", mono:"V", brand:"#7c5cff",
    fromName:"Vanta Talent", fromEmail:"no-reply@greenhouse.io", via:"GREENHOUSE",
    subject:"Application submitted successfully",
    snippet:"We've received your application for the AI Automation Engineer role.",
    time:"Mon", fullTime:"Mon, Jun 23 at 9:30 AM", kind:"confirmation",
    role:"AI Automation Engineer", location:"Remote",
    appliedDate:"2 days ago", resume:"ML_Engineer_2026.pdf", unread:false, starred:false, attachment:false,
    paragraphs:[
      "Your application for the <strong>AI Automation Engineer</strong> role at Vanta has been submitted successfully and is now under review.",
      "Our team will be in touch should there be a match.",
    ],
    closing:"Thank you for considering a career at Vanta.",
    signoff:"— Vanta People Team" },

  { id:"m8", company:"Datadog", mono:"D", brand:"#7c3aed",
    fromName:"Datadog Recruiting", fromEmail:"no-reply@greenhouse.io", via:"GREENHOUSE",
    subject:"Update on your application",
    snippet:"After careful review we won't be moving forward at this time.",
    time:"Sun", fullTime:"Sun, Jun 22 at 5:40 PM", kind:"rejected",
    role:"Principal AI Engineer — Agent Ops", location:"Charlotte, NC",
    appliedDate:"5 days ago", resume:"Platform_Infra.pdf", unread:false, starred:false, attachment:false,
    paragraphs:[
      "Thank you for your interest in the <strong>Principal AI Engineer — Agent Ops</strong> role and for the time you invested in applying.",
      "After careful consideration, we've decided not to move forward with your application at this time. This was a competitive role and the decision was a difficult one.",
    ],
    closing:"We genuinely encourage you to apply for future openings that match your experience — your background is strong.",
    signoff:"— Datadog Talent Acquisition" },
];

/* ────────────────────────────────────────────────────────────
   Helpers
──────────────────────────────────────────────────────────── */
function labelMeta(kind) {
  switch (kind) {
    case "interview": return { text:"Interview", color:"var(--info)", bg:"rgba(96,165,250,0.10)", border:"rgba(96,165,250,0.26)", dot:"var(--info)" };
    case "offer":     return { text:"Offer", color:"var(--accent-ink)", bg:"var(--accent-soft)", border:"var(--accent-line)", dot:"var(--accent)" };
    case "rejected":  return { text:"Closed", color:"var(--danger)", bg:"rgba(240,138,138,0.10)", border:"rgba(240,138,138,0.24)", dot:"var(--danger)" };
    default:          return { text:"Confirmed", color:"var(--accent3)", bg:"rgba(52,211,153,0.10)", border:"rgba(52,211,153,0.24)", dot:"var(--accent3)" };
  }
}
const Svg = ({ d, size = 16, sw = 1.6, fill = "none", children }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill={fill} stroke="currentColor"
       strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round">
    {d ? <path d={d} /> : children}
  </svg>
);
const FOLDER_ICONS = {
  inbox:      <Svg size={17}><rect x="2" y="3" width="12" height="10" rx="1.8" /><path d="M2.6 4l5.4 4 5.4-4" /></Svg>,
  starred:    <Svg size={17} sw={1.5}><path d="M8 1.6l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.4 4.2 13.4l.7-4.3-3.1-3 4.3-.6z" /></Svg>,
  interviews: <Svg size={17}><circle cx="8" cy="8" r="6.3" /><path d="M5.2 8.2l1.9 1.9L11 6.2" /></Svg>,
  sent:       <Svg size={17} sw={1.5}><path d="M14 2L7 9M14 2l-4.5 12-2.5-5L2 6.5 14 2z" /></Svg>,
  archive:    <Svg size={17} sw={1.5}><rect x="2" y="4.5" width="12" height="9" rx="1.5" /><path d="M2 4.5L3.2 2h9.6L14 4.5M6.5 8h3" /></Svg>,
};

/* ────────────────────────────────────────────────────────────
   Component
──────────────────────────────────────────────────────────── */
export default function RackMail({
  userName = "Tejas",
  inboxAddress = "tejas.apply@rackmail.app",
  theme: themeProp = "dark",
  emails = EMAILS,
  onNavigate,
}) {
  const { theme: globalTheme, toggleTheme } = useTheme();
  const [theme, setTheme] = useState(themeProp === "light" ? "light" : "dark");
  // Stay in sync with the global app theme (toggle in header affects whole app)
  useEffect(() => { setTheme(globalTheme); }, [globalTheme]);
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeMin, setComposeMin] = useState(false);
  const [folder, setFolder] = useState("inbox");
  const [tab, setTab] = useState("all");
  const [openId, setOpenId] = useState(emails[0]?.id);
  const [read, setRead] = useState({});
  const [stars, setStars] = useState(() => {
    const s = {}; emails.forEach((e) => { if (e.starred) s[e.id] = true; }); return s;
  });

  // Mobile panel navigation: 'folders' | 'list' | 'reading'
  const [mobilePanel, setMobilePanel] = useState("list");
  const [isMobile, setIsMobile] = useState(() => typeof window !== "undefined" && window.innerWidth <= 768);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 768px)");
    const handler = (e) => setIsMobile(e.matches);
    mq.addEventListener("change", handler);
    setIsMobile(mq.matches);
    return () => mq.removeEventListener("change", handler);
  }, []);

  const isUnread = (e) => e.unread && !read[e.id];
  const openEmail = (id) => {
    setOpenId(id);
    setRead((r) => ({ ...r, [id]: true }));
    if (isMobile) setMobilePanel("reading");
  };
  const toggleStar = (id) => setStars((s) => ({ ...s, [id]: !s[id] }));
  const selectFolder = (folderId) => {
    setFolder(folderId);
    setTab("all");
    if (isMobile) setMobilePanel("list");
  };

  const decorated = useMemo(
    () => emails.map((e) => ({ e, lm: labelMeta(e.kind), unread: isUnread(e), starred: !!stars[e.id] })),
    [emails, read, stars]
  );

  const counts = useMemo(() => ({
    starred: decorated.filter((d) => d.starred).length,
    interviews: decorated.filter((d) => d.e.kind === "interview" || d.e.kind === "offer").length,
    archive: decorated.filter((d) => d.e.kind === "rejected").length,
    unread: decorated.filter((d) => d.unread).length,
  }), [decorated]);

  const byFolder = decorated.filter(({ e, starred }) => {
    switch (folder) {
      case "starred":    return starred;
      case "interviews": return e.kind === "interview" || e.kind === "offer";
      case "archive":    return e.kind === "rejected";
      case "sent":       return false;
      default:           return true;
    }
  });
  const visible = byFolder.filter(({ unread }) => (tab === "unread" ? unread : true));

  const folderTitle = { inbox:"Inbox", starred:"Starred", interviews:"Interviews & offers", sent:"Sent", archive:"Archive" }[folder];

  const folderDefs = [
    { id:"inbox", label:"Inbox", count:counts.unread, accent:true },
    { id:"starred", label:"Starred", count:counts.starred },
    { id:"interviews", label:"Interviews & offers", count:counts.interviews },
    { id:"sent", label:"Sent", count:0, hideZero:true },
    { id:"archive", label:"Archive", count:counts.archive },
  ];
  const labelDefs = [
    { kind:"confirmation", label:"Confirmations" },
    { kind:"interview", label:"Interviews" },
    { kind:"offer", label:"Offers" },
    { kind:"rejected", label:"Closed" },
  ];

  const oe = emails.find((x) => x.id === openId) || null;
  const olm = oe ? labelMeta(oe.kind) : null;
  const starOn = oe ? !!stars[oe.id] : false;
  const initial = (userName || "U").charAt(0).toUpperCase();

  const mono = "var(--font-mono)";

  return (
    <div className="rk-mail-root" data-theme={theme}
         style={{ display:"flex", height:"100vh", width:"100%", overflow:"hidden",
                  background:"var(--bg)", color:"var(--text)", fontFamily:"var(--font-sans)",
                  letterSpacing:"-0.005em", position:"fixed", inset:0, zIndex:200 }}>
      <style>{THEME_CSS}</style>

      {/* ════ RACK SHARED SIDEBAR — desktop only ════ */}
      {!isMobile && (
        <Sidebar
          activeNav="Emails"
          onNavigate={onNavigate}
          userName={userName}
          userInitial={(userName || "U").charAt(0).toUpperCase()}
          theme={theme}
          onToggleTheme={toggleTheme}
        />
      )}

      {/* ════ MAIL LAYOUT (folder rail + list + reading) ════ */}
      <div className="rk-mail-layout" data-panel={mobilePanel}
           style={{ display:"flex", flex:1, height:"100%", overflow:"hidden", minWidth:0 }}>

        {/* Column wrapper: mobile top bar + panels row + mobile bottom nav */}
        <div style={{ display:"flex", flexDirection:"column", flex:1, minWidth:0, height:"100%", overflow:"hidden" }}>

        {/* ── Mobile top bar ── */}
        <div className="rk-mob-topbar">
          {/* Back always exits to Dashboard from folders or list; reading goes back to list */}
          {(mobilePanel === "folders" || mobilePanel === "list") && (
            <button className="rk-mob-back" onClick={() => onNavigate?.("Dashboard")} title="Back to Dashboard">
              <Svg size={16} sw={1.8}><path d="M10 4l-4 4 4 4" /></Svg>
            </button>
          )}
          {mobilePanel === "reading" && (
            <button className="rk-mob-back" onClick={() => setMobilePanel("list")} title="Back to inbox">
              <Svg size={16} sw={1.8}><path d="M10 4l-4 4 4 4" /></Svg>
            </button>
          )}

          <div style={{ flex:1, display:"flex", alignItems:"center", gap:8 }}>
            <div style={{ width:24, height:24, borderRadius:7, background:"var(--accent)", display:"flex", alignItems:"center", justifyContent:"center", color:"var(--accent-contrast)", flex:"none" }}>
              <Svg size={13} sw={1.7}><rect x="2" y="3" width="12" height="10" rx="1.8" /><path d="M2.6 4l5.4 4 5.4-4" /></Svg>
            </div>
            <span style={{ fontSize:14, fontWeight:600 }}>
              {mobilePanel === "folders" ? "Rack Mail" : mobilePanel === "list" ? folderTitle : (oe?.company ?? "Rack Mail")}
            </span>
            {mobilePanel === "list" && counts.unread > 0 && (
              <span style={{ fontFamily:mono, fontSize:10, fontWeight:600, color:"var(--accent-ink)", background:"var(--accent-soft)", border:"1px solid var(--accent-line)", padding:"1px 6px", borderRadius:5 }}>{counts.unread}</span>
            )}
          </div>

          {mobilePanel !== "reading" && (
            <button className="rk-mob-compose" onClick={() => { setComposeOpen(true); setComposeMin(false); }} title="Compose">
              <Svg size={15} sw={2}><path d="M8 3v10M3 8h10" /></Svg>
            </button>
          )}
          {mobilePanel === "reading" && oe && (
            <button onClick={() => toggleStar(oe.id)} title="Star"
                    style={{ width:36, height:36, borderRadius:10, border:`1px solid ${starOn ? "var(--accent-line)" : "var(--border-bright)"}`, background:starOn ? "var(--accent-soft)" : "var(--surface)", cursor:"pointer", color:starOn ? "var(--accent-ink)" : "var(--text-mid)", display:"flex", alignItems:"center", justifyContent:"center", flex:"none" }}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill={starOn ? "var(--accent)" : "none"} stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"><path d="M8 1.6l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.4 4.2 13.4l.7-4.3-3.1-3 4.3-.6z" /></svg>
            </button>
          )}
        </div>

        {/* ── Three-panel content area (row) ── */}
        <div style={{ display:"flex", flex:1, overflow:"hidden", minWidth:0 }}>

      {/* ════ FOLDER RAIL ════ */}
      <div className="rk-mail-folder-rail" style={{ width:222, flex:"none", height:"100%", background:"var(--sidebar-bg)", borderRight:"1px solid var(--border)", display:"flex", flexDirection:"column", padding:"20px 14px" }}>
        <div className="rk-folder-header" style={{ display:"flex", alignItems:"center", gap:10, padding:"0 6px 18px" }}>
          <div style={{ width:30, height:30, borderRadius:9, background:"var(--accent)", display:"flex", alignItems:"center", justifyContent:"center", flex:"none", color:"var(--accent-contrast)" }}>
            <Svg sw={1.7}><rect x="2" y="3" width="12" height="10" rx="1.8" /><path d="M2.6 4l5.4 4 5.4-4" /></Svg>
          </div>
          <div style={{ lineHeight:1.1 }}>
            <div style={{ fontSize:14.5, fontWeight:600 }}>Rack Mail</div>
            <div style={{ fontFamily:mono, fontSize:9.5, color:"var(--accent-ink)", letterSpacing:"0.04em", marginTop:2 }}>AUTO-MANAGED INBOX</div>
          </div>
        </div>

        <button className="rk-mail-accentbtn rk-folder-compose" onClick={() => { setComposeOpen(true); setComposeMin(false); }} style={{ display:"flex", alignItems:"center", justifyContent:"center", gap:9, padding:11, borderRadius:12, cursor:"pointer", border:"none", background:"var(--accent)", color:"var(--accent-contrast)", fontFamily:"var(--font-sans)", fontSize:13.5, fontWeight:600, marginBottom:18 }}>
          <Svg size={15} sw={2}><path d="M8 3v10M3 8h10" /></Svg>
          Compose
        </button>

        <nav style={{ display:"flex", flexDirection:"column", gap:2 }}>
          {folderDefs.map((f) => {
            const active = folder === f.id;
            const showCount = !(f.hideZero && f.count === 0) && f.count > 0;
            return (
              <button key={f.id} className="rk-mail-nav" onClick={() => selectFolder(f.id)}
                      style={{ display:"flex", alignItems:"center", gap:11, padding:"9px 11px", borderRadius:9, cursor:"pointer", fontFamily:"var(--font-sans)", fontSize:13.5, fontWeight:active ? 600 : 500, textAlign:"left", width:"100%", background:active ? "var(--accent-soft)" : "transparent", color:active ? "var(--text)" : "var(--text-mid)", border:`1px solid ${active ? "var(--accent-line)" : "transparent"}` }}>
                <span style={{ width:17, height:17, display:"flex", flex:"none", color:active ? "var(--accent-ink)" : "var(--text-mid)" }}>{FOLDER_ICONS[f.id]}</span>
                {f.label}
                {showCount && <span style={{ marginLeft:"auto", fontFamily:mono, fontSize:10.5, fontWeight:600, color:f.accent ? "var(--accent-ink)" : "var(--text-dim)" }}>{f.count}</span>}
              </button>
            );
          })}
        </nav>

        <div style={{ height:1, background:"var(--hairline)", margin:"16px 8px" }} />
        <NavLabel style={{ padding:"0 9px 10px" }}>LABELS</NavLabel>
        <nav style={{ display:"flex", flexDirection:"column", gap:2 }}>
          {labelDefs.map((l) => {
            const m = labelMeta(l.kind);
            const c = decorated.filter((d) => d.e.kind === l.kind).length;
            return (
              <button key={l.kind} className="rk-mail-nav" style={{ display:"flex", alignItems:"center", gap:11, padding:"8px 11px", borderRadius:9, cursor:"pointer", fontFamily:"var(--font-sans)", fontSize:13, fontWeight:500, textAlign:"left", width:"100%", background:"transparent", color:"var(--text-mid)", border:"1px solid transparent" }}>
                <span style={{ width:9, height:9, borderRadius:3, flex:"none", background:m.dot }} />
                {l.label}
                <span style={{ marginLeft:"auto", fontFamily:mono, fontSize:10.5, color:"var(--text-dim)" }}>{c}</span>
              </button>
            );
          })}
        </nav>

        <div style={{ flex:1 }} />
        <div style={{ border:"1px solid var(--accent-line)", background:"var(--accent-soft)", borderRadius:12, padding:13 }}>
          <div style={{ display:"flex", alignItems:"center", gap:8, fontSize:12, fontWeight:600, color:"var(--accent-ink)", marginBottom:5 }}>
            <Svg size={13} sw={1.7}><circle cx="8" cy="8" r="6" /><path d="M8 5.2v3.2l2 1.4" /></Svg>
            Sync active
          </div>
          <div style={{ fontSize:11.5, color:"var(--text-mid)", lineHeight:1.5 }}>Rack files every reply automatically. Last sync 2 min ago.</div>
        </div>
      </div>

      {/* ════ MAIL LIST ════ */}
      <div className="rk-mail-list-panel" style={{ width:404, flex:"none", height:"100%", borderRight:"1px solid var(--border)", display:"flex", flexDirection:"column", background:"var(--bg)" }}>

        {/* Mobile-only compact search + filter row */}
        <div className="rk-mob-list-controls" style={{ display:"none", padding:"10px 14px 10px", flex:"none", gap:8, flexDirection:"column" }}>
          <div style={{ display:"flex", alignItems:"center", gap:10, padding:"0 12px", height:40, borderRadius:10, border:"1px solid var(--border-bright)", background:"var(--surface)" }}>
            <span style={{ color:"var(--text-dim)", display:"flex", flex:"none" }}><Svg size={15}><circle cx="7" cy="7" r="5" /><path d="M11 11l3.5 3.5" /></Svg></span>
            <input placeholder="Search mail" style={{ flex:1, border:"none", outline:"none", background:"transparent", fontFamily:"var(--font-sans)", fontSize:14, color:"var(--text)" }} />
          </div>
          <div style={{ display:"flex", gap:6 }}>
            {[{ id:"all", label:"All" }, { id:"unread", label:"Unread" }].map((t) => {
              const active = tab === t.id;
              return (
                <button key={t.id} onClick={() => setTab(t.id)} style={{ padding:"5px 14px", borderRadius:8, cursor:"pointer", fontFamily:"var(--font-sans)", fontSize:12.5, fontWeight:600, background:active ? "var(--accent-soft)" : "var(--surface)", color:active ? "var(--text)" : "var(--text-mid)", border:`1px solid ${active ? "var(--accent-line)" : "var(--border-bright)"}` }}>{t.label}</button>
              );
            })}
          </div>
        </div>

        <div className="rk-list-header" style={{ padding:"18px 18px 0", flex:"none" }}>
          <div style={{ display:"flex", alignItems:"center", gap:12, padding:"0 14px", height:44, borderRadius:12, border:"1px solid var(--border-bright)", background:"var(--surface)" }}>
            <span style={{ color:"var(--text-dim)", display:"flex" }}><Svg><circle cx="7" cy="7" r="5" /><path d="M11 11l3.5 3.5" /></Svg></span>
            <input placeholder="Search mail" style={{ flex:1, border:"none", outline:"none", background:"transparent", fontFamily:"var(--font-sans)", fontSize:13.5, color:"var(--text)" }} />
            <kbd className="rk-search-shortcut" style={{ fontFamily:mono, fontSize:10.5, color:"var(--text-dim)", border:"1px solid var(--border)", borderRadius:6, padding:"2px 6px", background:"var(--chip-bg)" }}>/</kbd>
          </div>
          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"16px 4px 12px" }}>
            <div style={{ display:"flex", alignItems:"baseline", gap:9 }}>
              <h2 style={{ fontSize:16, fontWeight:600, margin:0, letterSpacing:"-0.01em" }}>{folderTitle}</h2>
              <span style={{ fontFamily:mono, fontSize:11, color:"var(--text-dim)" }}>{visible.length} {visible.length === 1 ? "message" : "messages"}</span>
            </div>
            <div style={{ display:"flex", gap:4 }}>
              {[{ id:"all", label:"All" }, { id:"unread", label:"Unread" }].map((t) => {
                const active = tab === t.id;
                return (
                  <button key={t.id} onClick={() => setTab(t.id)} style={{ padding:"5px 11px", borderRadius:8, cursor:"pointer", fontFamily:"var(--font-sans)", fontSize:12, fontWeight:600, background:active ? "var(--accent-soft)" : "var(--surface)", color:active ? "var(--text)" : "var(--text-mid)", border:`1px solid ${active ? "var(--accent-line)" : "var(--border-bright)"}` }}>{t.label}</button>
                );
              })}
            </div>
          </div>
        </div>

        <div style={{ flex:1, overflowY:"auto", padding:"6px 12px 16px" }}>
          {visible.map(({ e, lm, unread }) => {
            const selected = openId === e.id;
            return (
              <div key={e.id} className="rk-mail-row" onClick={() => openEmail(e.id)}
                   style={{ display:"flex", gap:12, padding:"13px 12px", borderRadius:12, cursor:"pointer", marginBottom:3, position:"relative", background:selected ? "var(--surface2)" : unread ? "var(--unread-bg)" : "transparent", border:`1px solid ${selected ? "var(--border-bright)" : "transparent"}` }}>
                {selected && <span style={{ position:"absolute", left:0, top:14, bottom:14, width:3, borderRadius:"0 3px 3px 0", background:"var(--accent)" }} />}
                <div style={{ width:38, height:38, borderRadius:11, flex:"none", display:"flex", alignItems:"center", justifyContent:"center", fontWeight:700, fontSize:15, color:"#fff", background:e.brand }}>{e.mono}</div>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                    <span style={{ fontSize:13.5, fontWeight:unread ? 700 : 600, color:"var(--text)", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{e.company}</span>
                    {unread && <span style={{ width:7, height:7, borderRadius:"50%", flex:"none", background:"var(--accent)" }} />}
                    <span style={{ marginLeft:"auto", fontFamily:mono, fontSize:10.5, color:"var(--text-dim)", flex:"none" }}>{e.time}</span>
                  </div>
                  <div style={{ fontSize:13, fontWeight:unread ? 600 : 500, color:unread ? "var(--text)" : "var(--text-mid)", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis", margin:"3px 0 2px" }}>{e.subject}</div>
                  <div style={{ display:"flex", alignItems:"center", gap:7 }}>
                    <span style={{ fontSize:12, color:"var(--text-dim)", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis", flex:1 }}>{e.snippet}</span>
                    {e.attachment && <span style={{ color:"var(--text-dim)", display:"flex", flex:"none" }}><Svg size={12} sw={1.5}><path d="M13 7l-5.5 5.5a3 3 0 0 1-4.2-4.2L8.8 2.8a2 2 0 0 1 2.8 2.8L6 11.2a1 1 0 0 1-1.4-1.4L9.5 5" /></Svg></span>}
                  </div>
                  <div style={{ display:"flex", alignItems:"center", gap:6, marginTop:8 }}>
                    <span style={{ display:"inline-flex", alignItems:"center", gap:5, fontSize:10.5, fontWeight:600, color:lm.color, background:lm.bg, padding:"2px 8px", borderRadius:6, border:`1px solid ${lm.border}` }}>
                      <span style={{ width:5, height:5, borderRadius:"50%", background:lm.color }} />{lm.text}
                    </span>
                    <span style={{ fontFamily:mono, fontSize:9.5, fontWeight:600, letterSpacing:"0.06em", color:"var(--text-dim)", border:"1px solid var(--chip-border)", padding:"2px 6px", borderRadius:6 }}>{e.via}</span>
                  </div>
                </div>
              </div>
            );
          })}
          {visible.length === 0 && <div style={{ padding:"48px 20px", textAlign:"center", color:"var(--text-dim)", fontSize:13 }}>Nothing here yet.</div>}
        </div>
      </div>

      {/* ════ READING PANE ════ */}
      <main className="rk-mail-reading-pane" style={{ flex:1, height:"100%", overflowY:"auto", background:"var(--read-bg)", minWidth:0 }}>
        {oe ? (
          <div style={{ minHeight:"100%", display:"flex", flexDirection:"column" }}>
            <div className="rk-reading-toolbar" style={{ position:"sticky", top:0, zIndex:4, background:"var(--header-bg)", backdropFilter:"blur(20px) saturate(140%)", WebkitBackdropFilter:"blur(20px) saturate(140%)", borderBottom:"1px solid var(--border)", padding:"13px 26px", display:"flex", alignItems:"center", gap:8 }}>
              <ToolBtn title="Archive"><Svg size={15}><rect x="2" y="4.5" width="12" height="9" rx="1.5" /><path d="M2 4.5L3.2 2h9.6L14 4.5M6.5 8h3" /></Svg></ToolBtn>
              <ToolBtn title="Delete" danger><Svg size={15}><path d="M3 4.5h10M6 4.5V3a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5M4.5 4.5l.7 8a1 1 0 0 0 1 .9h3.6a1 1 0 0 0 1-.9l.7-8" /></Svg></ToolBtn>
              <ToolBtn title="Mark unread"><Svg size={15}><rect x="2" y="3" width="12" height="10" rx="1.8" /><path d="M2.6 4l5.4 4 5.4-4" /></Svg></ToolBtn>
              <ToolBtn title="Snooze"><Svg size={15}><circle cx="8" cy="8.5" r="5.4" /><path d="M8 5.6v3l2 1.2M5.4 1.6l-2.4 2M10.6 1.6l2.4 2" /></Svg></ToolBtn>
              <div className="rk-tool-spacer" style={{ flex:1 }} />
              <button onClick={() => toggleStar(oe.id)} title="Star"
                      style={{ width:36, height:36, borderRadius:10, border:`1px solid ${starOn ? "var(--accent-line)" : "var(--border-bright)"}`, background:starOn ? "var(--accent-soft)" : "var(--surface)", cursor:"pointer", color:starOn ? "var(--accent-ink)" : "var(--text-mid)", display:"flex", alignItems:"center", justifyContent:"center" }}>
                <svg width="16" height="16" viewBox="0 0 16 16" fill={starOn ? "var(--accent)" : "none"} stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"><path d="M8 1.6l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.4 4.2 13.4l.7-4.3-3.1-3 4.3-.6z" /></svg>
              </button>
              <button className="rk-mail-accentbtn" style={{ display:"flex", alignItems:"center", gap:7, padding:"0 16px", height:36, borderRadius:10, cursor:"pointer", border:"none", background:"var(--accent)", color:"var(--accent-contrast)", fontFamily:"var(--font-sans)", fontSize:13, fontWeight:600 }}>
                <Svg size={14} sw={1.8}><path d="M7 4L3 8l4 4M3 8h7a3 3 0 0 1 3 3v1" /></Svg>
                Reply
              </button>
            </div>

            <div className="rk-email-body" style={{ maxWidth:760, width:"100%", margin:"0 auto", padding:"30px 40px 60px" }}>
              <div style={{ display:"flex", alignItems:"flex-start", gap:14, marginBottom:22 }}>
                <h1 style={{ flex:1, fontSize:24, fontWeight:600, lineHeight:1.3, letterSpacing:"-0.02em", margin:0 }}>{oe.subject}</h1>
                <span style={{ flex:"none", marginTop:4, display:"inline-flex", alignItems:"center", gap:6, fontSize:11.5, fontWeight:600, color:olm.color, background:olm.bg, padding:"5px 12px", borderRadius:8, border:`1px solid ${olm.border}` }}>
                  <span style={{ width:6, height:6, borderRadius:"50%", background:olm.color }} />{olm.text}
                </span>
              </div>

              <div style={{ display:"flex", alignItems:"center", gap:14, paddingBottom:22, borderBottom:"1px solid var(--hairline)", marginBottom:26 }}>
                <div style={{ width:46, height:46, borderRadius:13, flex:"none", display:"flex", alignItems:"center", justifyContent:"center", fontWeight:700, fontSize:18, color:"#fff", background:oe.brand }}>{oe.mono}</div>
                <div style={{ minWidth:0, flex:1 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" }}>
                    <span style={{ fontSize:14.5, fontWeight:600 }}>{oe.fromName}</span>
                    <span style={{ fontFamily:mono, fontSize:11.5, color:"var(--text-dim)" }}>{oe.fromEmail}</span>
                  </div>
                  <div style={{ fontSize:12.5, color:"var(--text-dim)", marginTop:3 }}>to <span style={{ color:"var(--text-mid)" }}>{inboxAddress}</span> · {oe.fullTime}</div>
                </div>
                <span style={{ flex:"none", fontFamily:mono, fontSize:10, fontWeight:600, letterSpacing:"0.08em", color:"var(--text-dim)", border:"1px solid var(--chip-border)", padding:"4px 9px", borderRadius:7 }}>VIA {oe.via}</span>
              </div>

              {/* snapshot */}
              <div style={{ border:"1px solid var(--border)", background:"var(--surface)", borderRadius:16, padding:"20px 22px", marginBottom:26, boxShadow:"var(--card-shadow)" }}>
                <div style={{ fontFamily:mono, fontSize:10, fontWeight:600, letterSpacing:"0.12em", color:"var(--text-dim)", marginBottom:14 }}>APPLICATION SNAPSHOT</div>
                <div className="rk-snapshot-grid" style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"16px 24px" }}>
                  <Field label="Role" value={oe.role} />
                  <Field label="Location" value={oe.location} />
                  <Field label="Applied via Rack" value={oe.appliedDate} />
                  <div>
                    <div style={{ fontSize:11, color:"var(--text-dim)", marginBottom:4 }}>Resume used</div>
                    <div style={{ display:"flex", alignItems:"center", gap:7, fontSize:13.5, fontWeight:600, color:"var(--accent-ink)" }}>
                      <Svg size={13} sw={1.5}><path d="M9 1.5H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5.5z" /><path d="M9 1.5V5.5h4" /></Svg>
                      {oe.resume}
                    </div>
                  </div>
                </div>
              </div>

              {/* letter */}
              <div style={{ fontSize:14.5, lineHeight:1.72, color:"var(--text-mid)" }}>
                <p style={{ margin:"0 0 16px" }}>Hi {userName},</p>
                {oe.paragraphs.map((p, i) => (
                  <p key={i} style={{ margin:"0 0 16px" }} dangerouslySetInnerHTML={{ __html: bold(p) }} />
                ))}

                {oe.kind === "interview" && (
                  <div style={{ border:"1px solid var(--info)", background:"rgba(96,165,250,0.08)", borderRadius:14, padding:"18px 20px", margin:"6px 0 20px" }}>
                    <div style={{ display:"flex", alignItems:"center", gap:9, fontSize:13.5, fontWeight:600, color:"var(--info)", marginBottom:12 }}>
                      <Svg size={15}><rect x="2" y="3" width="12" height="11" rx="1.8" /><path d="M2 6h12M5 1.5v3M11 1.5v3" /></Svg>
                      Proposed interview times
                    </div>
                    <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
                      {(oe.slots || []).map((s, i) => (
                        <button key={i} className="rk-mail-slot" style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"11px 14px", borderRadius:10, cursor:"pointer", border:"1px solid var(--border-bright)", background:"var(--surface)", color:"var(--text)", fontFamily:"var(--font-sans)", fontSize:13.5, fontWeight:600, textAlign:"left" }}>
                          {s}
                          <span style={{ color:"var(--info)", display:"flex" }}><Svg size={14} sw={1.8}><path d="M3 8h9M8.5 4l4 4-4 4" /></Svg></span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {oe.kind === "offer" && (
                  <div style={{ border:"1px solid var(--accent-line)", background:"var(--accent-soft)", borderRadius:14, padding:20, margin:"6px 0 20px" }}>
                    <div style={{ fontFamily:mono, fontSize:10, fontWeight:600, letterSpacing:"0.12em", color:"var(--accent-ink)", marginBottom:12 }}>OFFER SUMMARY</div>
                    <div className="rk-offer-stats" style={{ display:"flex", gap:28, flexWrap:"wrap" }}>
                      {(oe.offerStats || []).map((o, i) => (
                        <div key={i}>
                          <div style={{ fontFamily:mono, fontSize:22, fontWeight:600, color:"var(--text)", letterSpacing:"-0.02em" }}>{o.value}</div>
                          <div style={{ fontSize:11.5, color:"var(--text-mid)", marginTop:2 }}>{o.label}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <p style={{ margin:"0 0 16px" }} dangerouslySetInnerHTML={{ __html: bold(oe.closing) }} />
                <p style={{ margin:0 }}>{oe.signoff}</p>
              </div>

              {/* reply dock */}
              <div className="rk-reply-dock" style={{ marginTop:34, border:"1px solid var(--border-bright)", background:"var(--surface)", borderRadius:16, overflow:"hidden", boxShadow:"var(--card-shadow)" }}>
                <div style={{ display:"flex", alignItems:"center", gap:8, padding:"14px 18px", borderBottom:"1px solid var(--hairline)" }}>
                  <span style={{ width:24, height:24, borderRadius:7, background:"var(--accent-soft)", border:"1px solid var(--accent-line)", display:"flex", alignItems:"center", justifyContent:"center", flex:"none", color:"var(--accent-ink)" }}>
                    <Svg size={13}><path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" /></Svg>
                  </span>
                  <span style={{ fontSize:12.5, color:"var(--text-mid)" }}>Rack can draft a reply for you</span>
                  <button style={{ marginLeft:"auto", padding:"6px 13px", borderRadius:8, cursor:"pointer", border:"1px solid var(--accent-line)", background:"var(--accent-soft)", color:"var(--accent-ink)", fontFamily:"var(--font-sans)", fontSize:12, fontWeight:600 }}>Draft reply</button>
                </div>
                <div style={{ padding:"14px 18px" }}>
                  <input placeholder={`Reply to ${oe.company}…`} style={{ width:"100%", border:"none", outline:"none", background:"transparent", fontFamily:"var(--font-sans)", fontSize:13.5, color:"var(--text)" }} />
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div style={{ height:"100%", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", color:"var(--text-dim)", gap:14 }}>
            <Svg size={44} sw={1.2}><rect x="2" y="3" width="12" height="10" rx="1.8" /><path d="M2.6 4l5.4 4 5.4-4" /></Svg>
            <span style={{ fontSize:14 }}>Select an email to read</span>
          </div>
        )}
      </main>

      {/* ════ COMPOSE WINDOW ════ */}
      {composeOpen && (
        <div className="rk-compose-window" style={{ position:"fixed", right:28, bottom:0, width:552, maxWidth:"calc(100vw - 56px)", background:"var(--surface)", border:"1px solid var(--border-bright)", borderBottom:"none", borderRadius:"14px 14px 0 0", boxShadow:"0 -2px 12px rgba(0,0,0,0.18), 0 24px 60px rgba(0,0,0,0.40)", zIndex:50, display:"flex", flexDirection:"column", overflow:"hidden" }}>
          <div onClick={() => setComposeMin((m) => !m)} style={{ display:"flex", alignItems:"center", gap:10, padding:"12px 16px", background:"var(--sidebar-bg)", borderBottom:"1px solid var(--hairline)", cursor:"pointer" }}>
            <span style={{ width:8, height:8, borderRadius:"50%", background:"var(--accent)", flex:"none" }} />
            <span style={{ fontSize:13.5, fontWeight:600 }}>New message</span>
            <span style={{ fontFamily:mono, fontSize:10, fontWeight:600, letterSpacing:"0.06em", color:"var(--accent-ink)", background:"var(--accent-soft)", border:"1px solid var(--accent-line)", padding:"2px 7px", borderRadius:6 }}>RACK MAIL</span>
            <div style={{ marginLeft:"auto", display:"flex", alignItems:"center", gap:4 }}>
              <button className="rk-mail-icobtn" onClick={(e) => { e.stopPropagation(); setComposeMin((m) => !m); }} title="Minimize" style={{ width:28, height:28, borderRadius:7, border:"none", background:"transparent", cursor:"pointer", color:"var(--text-dim)", display:"flex", alignItems:"center", justifyContent:"center" }}>
                <Svg size={14} sw={1.8}><path d="M4 8h8" /></Svg>
              </button>
              <button className="rk-mail-icobtn" onClick={(e) => { e.stopPropagation(); setComposeOpen(false); }} title="Close" style={{ width:28, height:28, borderRadius:7, border:"none", background:"transparent", cursor:"pointer", color:"var(--text-dim)", display:"flex", alignItems:"center", justifyContent:"center" }}>
                <Svg size={14} sw={1.8}><path d="M4 4l8 8M12 4l-8 8" /></Svg>
              </button>
            </div>
          </div>

          {!composeMin && (
            <div style={{ display:"flex", flexDirection:"column" }}>
              <div style={{ display:"flex", alignItems:"center", gap:10, padding:"11px 16px", borderBottom:"1px solid var(--hairline)" }}>
                <span style={{ fontSize:12.5, color:"var(--text-dim)", width:42, flex:"none" }}>From</span>
                <span style={{ fontSize:13, color:"var(--text-mid)" }}>{inboxAddress}</span>
                <span style={{ marginLeft:"auto", fontFamily:mono, fontSize:10, color:"var(--text-dim)", border:"1px solid var(--chip-border)", padding:"2px 7px", borderRadius:6 }}>VERIFIED</span>
              </div>
              <div style={{ display:"flex", alignItems:"center", gap:10, padding:"11px 16px", borderBottom:"1px solid var(--hairline)" }}>
                <span style={{ fontSize:12.5, color:"var(--text-dim)", width:42, flex:"none" }}>To</span>
                <input placeholder="Add recipients" style={{ flex:1, border:"none", outline:"none", background:"transparent", fontFamily:"var(--font-sans)", fontSize:13.5, color:"var(--text)" }} />
              </div>
              <div style={{ display:"flex", alignItems:"center", gap:10, padding:"11px 16px", borderBottom:"1px solid var(--hairline)" }}>
                <span style={{ fontSize:12.5, color:"var(--text-dim)", width:42, flex:"none" }}>Subject</span>
                <input placeholder="Subject" style={{ flex:1, border:"none", outline:"none", background:"transparent", fontFamily:"var(--font-sans)", fontSize:13.5, fontWeight:600, color:"var(--text)" }} />
              </div>
              <textarea placeholder="Write your message…  or let Rack draft it for you." style={{ border:"none", outline:"none", resize:"none", background:"transparent", fontFamily:"var(--font-sans)", fontSize:13.5, lineHeight:1.6, color:"var(--text)", padding:16, minHeight:188 }} />

              <div style={{ display:"flex", alignItems:"center", gap:9, margin:"0 16px 4px", padding:"10px 12px", borderRadius:10, border:"1px solid var(--accent-line)", background:"var(--accent-soft)" }}>
                <span style={{ width:24, height:24, borderRadius:7, background:"var(--surface)", border:"1px solid var(--accent-line)", display:"flex", alignItems:"center", justifyContent:"center", flex:"none", color:"var(--accent-ink)" }}>
                  <Svg size={13}><path d="M8 1.5l1.6 3.4 3.4.4-2.5 2.3.6 3.4L8 9.8 4.9 11.4l.6-3.4L3 5.7l3.4-.4z" /></Svg>
                </span>
                <span style={{ fontSize:12.5, color:"var(--text-mid)" }}>Reply in your voice — Rack learns from your past messages.</span>
                <button className="rk-mail-accentbtn" style={{ marginLeft:"auto", padding:"6px 12px", borderRadius:8, cursor:"pointer", border:"none", background:"var(--accent)", color:"var(--accent-contrast)", fontFamily:"var(--font-sans)", fontSize:12, fontWeight:600, flex:"none" }}>Draft with Rack</button>
              </div>

              <div style={{ display:"flex", alignItems:"center", gap:10, padding:"13px 16px" }}>
                <button className="rk-mail-accentbtn" style={{ display:"flex", alignItems:"center", gap:8, padding:"0 18px", height:38, borderRadius:10, cursor:"pointer", border:"none", background:"var(--accent)", color:"var(--accent-contrast)", fontFamily:"var(--font-sans)", fontSize:13.5, fontWeight:600 }}>
                  Send
                  <Svg size={14} sw={1.8}><path d="M14 2L7 9M14 2l-4.5 12-2.5-5L2 6.5 14 2z" /></Svg>
                </button>
                <button className="rk-mail-icobtn" title="Attach" style={{ width:38, height:38, borderRadius:10, cursor:"pointer", border:"1px solid var(--border-bright)", background:"transparent", color:"var(--text-mid)", display:"flex", alignItems:"center", justifyContent:"center" }}>
                  <Svg size={15} sw={1.5}><path d="M13 7l-5.5 5.5a3 3 0 0 1-4.2-4.2L8.8 2.8a2 2 0 0 1 2.8 2.8L6 11.2a1 1 0 0 1-1.4-1.4L9.5 5" /></Svg>
                </button>
                <div style={{ flex:1 }} />
                <button className="rk-mail-icobtn" onClick={() => setComposeOpen(false)} title="Discard" style={{ width:38, height:38, borderRadius:10, cursor:"pointer", border:"1px solid var(--border-bright)", background:"transparent", color:"var(--text-dim)", display:"flex", alignItems:"center", justifyContent:"center" }}>
                  <Svg size={15}><path d="M3 4.5h10M6 4.5V3a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5M4.5 4.5l.7 8a1 1 0 0 0 1 .9h3.6a1 1 0 0 0 1-.9l.7-8" /></Svg>
                </button>
              </div>
            </div>
          )}
        </div>
      )}

        </div>{/* end three-panel content area */}

        {/* ── Mobile bottom nav bar ── */}
        <nav className="rk-mob-bottomnav">
          {[
            { id:"inbox",      label:"Inbox",      icon:<Svg size={20} sw={1.5}><rect x="2" y="3" width="12" height="10" rx="1.8" /><path d="M2.6 4l5.4 4 5.4-4" /></Svg> },
            { id:"starred",    label:"Starred",    icon:<Svg size={20} sw={1.4}><path d="M8 1.6l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.4 4.2 13.4l.7-4.3-3.1-3 4.3-.6z" /></Svg> },
            { id:"interviews", label:"Interviews", icon:<Svg size={20} sw={1.4}><circle cx="8" cy="8" r="6.3" /><path d="M5.2 8.2l1.9 1.9L11 6.2" /></Svg> },
            { id:"archive",    label:"Archive",    icon:<Svg size={20} sw={1.4}><rect x="2" y="4.5" width="12" height="9" rx="1.5" /><path d="M2 4.5L3.2 2h9.6L14 4.5M6.5 8h3" /></Svg> },
          ].map((f) => (
            <button key={f.id} className={`rk-mob-navbtn${folder === f.id ? " active" : ""}`}
                    onClick={() => { selectFolder(f.id); if (mobilePanel === "reading") setMobilePanel("list"); }}>
              {f.icon}
              <span>{f.label}</span>
            </button>
          ))}
        </nav>

        </div>{/* end column wrapper */}
      </div>{/* end rk-mail-layout */}
    </div>
  );
}

/* ── small presentational helpers ─────────────────────────── */
function NavLabel({ children, style }) {
  return <div style={{ fontFamily:"var(--font-mono)", fontSize:10, fontWeight:600, letterSpacing:"0.14em", color:"var(--text-dim)", padding:"0 9px 9px", ...style }}>{children}</div>;
}
function ToolBtn({ title, danger, children }) {
  return (
    <button className="rk-mail-icobtn" title={title}
            style={{ width:36, height:36, borderRadius:10, border:"1px solid var(--border-bright)", background:"var(--surface)", cursor:"pointer", color:"var(--text-mid)", display:"flex", alignItems:"center", justifyContent:"center" }}
            onMouseEnter={danger ? (ev) => { ev.currentTarget.style.color = "var(--danger)"; } : undefined}
            onMouseLeave={danger ? (ev) => { ev.currentTarget.style.color = "var(--text-mid)"; } : undefined}>
      {children}
    </button>
  );
}
function Field({ label, value }) {
  return (
    <div>
      <div style={{ fontSize:11, color:"var(--text-dim)", marginBottom:4 }}>{label}</div>
      <div style={{ fontSize:14, fontWeight:600 }}>{value}</div>
    </div>
  );
}
// Renders the limited inline markup used in email bodies (<strong>) safely.
// Content is author-controlled demo copy; if you wire real email HTML, sanitize first.
function bold(html) { return html; }