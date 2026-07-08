/**
 * ResumeOptimizer.jsx — RACK resume-optimizer flow (Apply → Optimize → Review →
 * Cover letter → Submit → Done), ported 1:1 from the approved design prototype.
 *
 * Usage:
 *   import ResumeOptimizer from './components/ResumeOptimizer'
 *   <ResumeOptimizer defaultTheme="light" matchPercent={91} skipIntro={false} />
 *
 * The component is self-contained: theme CSS variables, keyframes, and the
 * DM Sans / Fira Code font links are injected on mount. It fills its parent
 * (root is height:100vh — change ROOT_HEIGHT below if you mount it inside a
 * flex layout instead of a full page).
 *
 * Wire-up points (replace the mock data with your API contract):
 *   initialDoc()  — structured_doc from GET /api/apply/jobs/{id}/resume
 *   PATCHES       — patches[] from resume_optimizer.py
 *   REQ_SKILLS / PREF_SKILLS / matchPercent — requirement_classification + score
 *   LETTER        — generated cover letter
 *   onDownload / startSubmit — hook to your endpoints
 */

import React from 'react'

const ROOT_HEIGHT = '100vh'

// ── page geometry ──────────────────────────────────────────────────────────
const PAGE_W = 700, PAGE_H = Math.round(700 * 11 / 8.5)
const PPI = PAGE_W / 8.5
const DEFAULT_MARGINS = { top: 0.55, right: 0.6, bottom: 0.55, left: 0.6 }
const FONT_DOC = "'Helvetica Neue', Helvetica, Arial, sans-serif"
const G_SEC = 13, G_ENTRY = 9, G_HEAD = 12, G_TITLE = 5, G_SUB = 3, G_LINE = 2.5

// ── inline-CSS helper: parses "a:b; c:d" strings into React style objects ──
const _sxCache = new Map()
function sx(str) {
  let o = _sxCache.get(str)
  if (o) return o
  o = {}
  for (const decl of str.split(';')) {
    const i = decl.indexOf(':')
    if (i < 0) continue
    const k = decl.slice(0, i).trim()
    if (!k) continue
    o[k.replace(/-([a-z])/g, (m, c) => c.toUpperCase())] = decl.slice(i + 1).trim()
  }
  _sxCache.set(str, o)
  return o
}
const sxd = (str) => { // dynamic (uncached) variant for interpolated strings
  const o = {}
  for (const decl of str.split(';')) {
    const i = decl.indexOf(':')
    if (i < 0) continue
    const k = decl.slice(0, i).trim()
    if (!k) continue
    o[k.replace(/-([a-z])/g, (m, c) => c.toUpperCase())] = decl.slice(i + 1).trim()
  }
  return o
}

// ── theme / keyframes / behavior CSS (injected once) ───────────────────────
const GLOBAL_CSS = `
  .rk-root[data-theme="dark"]{
    --bg:#0b0b0d; --surface:#141417; --surface2:#1b1b1f; --surface3:#242429;
    --border:rgba(255,255,255,0.07); --border-bright:rgba(255,255,255,0.12);
    --hairline:rgba(255,255,255,0.06);
    --text:#f2f2ef; --text-dim:rgba(255,255,255,0.40); --text-mid:rgba(255,255,255,0.66);
    --accent:#e8ff6b; --accent-strong:#d9f254; --accent-ink:#dcf45f; --accent-contrast:#0a0a0a;
    --accent-soft:rgba(232,255,107,0.07); --accent-line:rgba(232,255,107,0.24);
    --accent2:#a78bfa; --accent3:#34d399; --danger:#f08a8a;
    --ring-track:rgba(255,255,255,0.08); --chip-bg:rgba(255,255,255,0.04); --chip-border:rgba(255,255,255,0.08);
    --card-shadow:0 1px 2px rgba(0,0,0,0.28), 0 4px 14px rgba(0,0,0,0.22);
    --page-shadow:0 1px 3px rgba(0,0,0,0.5), 0 12px 34px rgba(0,0,0,0.45);
    --desk:#101012;
    --added-bg:rgba(94,196,110,0.20); --added-text:#7fd694;
    --scrollbar-thumb:rgba(255,255,255,0.12);
    --sidebar-bg:#0e0e10;
  }
  .rk-root[data-theme="light"]{
    --bg:#F5F3EC; --surface:#FFFFFF; --surface2:#F1EEE5; --surface3:#E7E3D8;
    --border:rgba(56,50,28,0.11); --border-bright:rgba(56,50,28,0.17);
    --hairline:rgba(56,50,28,0.08);
    --text:#1B1A15; --text-dim:rgba(34,30,18,0.44); --text-mid:rgba(28,25,15,0.64);
    --accent:#c2dd2f; --accent-strong:#b1cc1c; --accent-ink:#5f7611; --accent-contrast:#16180a;
    --accent-soft:rgba(120,150,0,0.10); --accent-line:rgba(120,150,0,0.28);
    --accent2:#7c3aed; --accent3:#059669; --danger:#dc2626;
    --ring-track:rgba(0,0,0,0.07); --chip-bg:rgba(40,34,16,0.045); --chip-border:rgba(56,50,28,0.10);
    --card-shadow:0 1px 2px rgba(60,52,30,0.05), 0 4px 14px rgba(60,52,30,0.06);
    --page-shadow:0 1px 3px rgba(60,52,30,0.10), 0 14px 40px rgba(60,52,30,0.13);
    --desk:#ECE9DF;
    --added-bg:rgba(94,196,110,0.18); --added-text:#1f7a34;
    --scrollbar-thumb:rgba(0,0,0,0.13);
    --sidebar-bg:#FBFAF4;
  }
  .rk-root{ --font-mono:"Fira Code", ui-monospace, Menlo, monospace; --font-sans:"DM Sans", sans-serif; --font-doc:"Helvetica Neue", Helvetica, Arial, sans-serif; --ease:cubic-bezier(0.4,0,0.2,1); }
  .rk-root *{ box-sizing:border-box; }
  .rk-root ::-webkit-scrollbar{ width:9px; height:9px; }
  .rk-root ::-webkit-scrollbar-thumb{ background:var(--scrollbar-thumb); border-radius:6px; border:2px solid transparent; background-clip:content-box; }
  .rk-root ::-webkit-scrollbar-track{ background:transparent; }
  @keyframes rkSpin { to { transform:rotate(360deg); } }
  @keyframes rkFadeUp { from { opacity:0; transform:translateY(7px); } to { opacity:1; transform:translateY(0); } }
  @keyframes rkPop { 0% { transform:scale(0.4); opacity:0; } 70% { transform:scale(1.08); } 100% { transform:scale(1); opacity:1; } }
  @keyframes rkBlink { 0%, 55% { opacity:1; } 56%, 100% { opacity:0; } }
  @keyframes rkPulse { 0%,100% { opacity:0.35; } 50% { opacity:0.9; } }
  @keyframes rkSweep { 0% { transform:translateX(-100%); } 100% { transform:translateX(260%); } }
  .rk-edit-field { background:rgba(124,108,240,0.055); box-shadow:inset 0 0 0 1px rgba(124,108,240,0.16); border-radius:3px; transition:background 0.12s, box-shadow 0.12s; }
  .rk-edit-field:hover { background:rgba(124,108,240,0.10); }
  .rk-edit-field:focus { background:#fff; box-shadow:0 0 0 2px #7c6cf0; outline:none; }
  .rk-page { transition: font-size 0.32s cubic-bezier(0.4,0,0.2,1), padding 0.32s cubic-bezier(0.4,0,0.2,1), line-height 0.32s cubic-bezier(0.4,0,0.2,1); }
  .rk-page .rk-fi { transition: padding-bottom 0.32s cubic-bezier(0.4,0,0.2,1); }
  .rk-page .rk-dragrow { transition: line-height 0.32s cubic-bezier(0.4,0,0.2,1); }
  .rk-selbar { transition:left 0.18s cubic-bezier(0.4,0,0.2,1), top 0.18s cubic-bezier(0.4,0,0.2,1); }
  .rk-hl { cursor:pointer; transition:box-shadow 0.12s; }
  .rk-hl:hover { box-shadow:0 0 0 2px var(--added-text); }
  .rk-handle { opacity:0; transition:opacity 0.12s; cursor:grab; }
  .rk-handle:active { cursor:grabbing; }
  .rk-dragrow { will-change:transform; }
  .rk-dragrow:hover > .rk-handle, .rk-dragrow:hover .rk-handle { opacity:0.55; }
  .rk-dragrow.rk-dragging { opacity:0.4; }
  .rk-flip { transition:transform 0.19s cubic-bezier(0.4,0,0.2,1); }
  .rk-hbtn:hover { background:var(--surface2) !important; }
  .rk-abtn:hover { background:var(--accent-strong) !important; }
  .rk-dbtn:hover { background:rgba(128,128,128,0.35) !important; }
  .rk-gbtn:hover { background:rgba(128,128,128,0.12) !important; }
`
const FONTS_HREF = 'https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600;9..40,700&family=Fira+Code:wght@400;500;600&display=swap'
function ensureGlobals() {
  if (!document.getElementById('rk-optimizer-css')) {
    const st = document.createElement('style')
    st.id = 'rk-optimizer-css'
    st.textContent = GLOBAL_CSS
    document.head.appendChild(st)
  }
  if (!document.querySelector(`link[href="${FONTS_HREF}"]`)) {
    const ln = document.createElement('link')
    ln.rel = 'stylesheet'
    ln.href = FONTS_HREF
    document.head.appendChild(ln)
  }
}

// ── mock data (replace with your API contract) ─────────────────────────────
function initialDoc() {
  return {
    header: {
      name: 'Tejas Belakavadi Kemparaju',
      contact: 'Applied AI Engineer | 862-214-0129 | tejas02bk@gmail.com | linkedin.com/in/tejasbk | github.com/tejas100',
    },
    sections: [
      { id: 'exp', title: 'Experience', kind: 'entries', entries: [
        { id: 'uber', head: 'Uber - AI Engineer', right: '08/2025 – Present', bullets: [
          { id: 'b_uber_1', text: 'Architected & deployed agentic AI workflows using Azure AI Foundry with OpenAI to automate support operations and telemetry analysis, reducing manual investigation time from 12 min to 3 min per interaction processing 10,000+ safety reports' },
          { id: 'b_uber_2', text: 'Built Spark/PySpark pipelines for large-scale telemetry, behavioral, and fraud-detection signals supporting AI-driven data curation, feature engineering, and production model development across high-volume marketplace systems' },
          { id: 'b_uber_3', text: 'Led the design of AI evaluation frameworks leveraging MLflow, RAGAS, LangSmith, and automated CI/CD validation pipelines, introducing regression testing, retrieval-quality benchmarking, and production guardrails for agentic AI pipelines' },
          { id: 'b_uber_4', text: 'Architected retrieval, evaluation, and deployment workflows across Azure AI Foundry, OpenAI services, and distributed telemetry pipelines, improving reliability and operational scalability of production AI systems' },
        ]},
        { id: 'dell', head: 'Dell Technologies - Machine Learning Engineer (Backend, Python)', right: '07/2022 – 09/2023', bullets: [
          { id: 'b_dell_1', text: 'Engineered large-scale ML training and deployment pipelines using PyTorch, Kubernetes, Docker, and GPU clusters, enabling delivery of 14 production-ready microservices for enterprise AI applications' },
          { id: 'b_dell_2', text: 'Built large-scale feature stores, data quality pipelines, and validation infrastructure across 28 enterprise data sources using Spark, SQL, Python, and Great Expectations, detecting 120+ data drift anomalies before model degradation' },
          { id: 'b_dell_3', text: 'Optimized production ML systems with TensorRT, TensorFlow, Kubeflow, CI/CD, and Optuna, reducing inference latency from 350ms to 45ms and cutting model release cycles from 15 days to 2 days' },
        ]},
        { id: 'wipro', head: 'Wipro - Project Engineer (Full Stack, Security)', right: '10/2021 – 07/2022', bullets: [
          { id: 'b_wipro_1', text: 'Built backend microservices and REST APIs on AWS using Java and Python, supporting scalable enterprise applications' },
          { id: 'b_wipro_2', text: 'Developed event-driven workflows with Kafka & RabbitMQ, for reliability & communication across distributed services' },
          { id: 'b_wipro_3', text: 'Reduced API latency by 40% through Redis caching, load balancing, and efficient request processing' },
        ]},
        { id: 'robo', head: 'Robosoft Technologies - Junior Data Scientist', right: '01/2020 – 10/2021', bullets: [
          { id: 'b_robo_1', text: 'Built regression and classification models using Python, Scikit-learn, and Random Forests to forecast mobile app traffic and categorize 1,000+ daily support tickets across production systems' },
          { id: 'b_robo_2', text: 'Developed scalable ETL & analytics workflows using SQL, Pandas, & NumPy, automating feature extraction & reducing manual data preparation by 12 hours per week while improving model validation & monitoring across 9 production ML models' },
        ]},
      ]},
      { id: 'proj', title: 'Projects', kind: 'entries', entries: [
        { id: 'rackx', head: 'Rackx.app - AI Career Assistant (RAG-based Conversational AI System)', right: 'New Jersey, USA', bullets: [
          { id: 'b_rackx_1', text: 'Built a production AI platform powered by agentic workflows and tool-calling orchestration, coordinating 7 autonomous workflow types across conversational AI, matching, application automation, and tracking systems' },
          { id: 'b_rackx_2', text: 'Engineered a distributed job-matching pipeline using GPT-4o-mini, pgvector, and asynchronous processing to rank 12K+ active postings across multiple job boards' },
          { id: 'b_rackx_3', text: 'Designed a hybrid retrieval and ranking system using pgvector similarity search, metadata filtering, and calibrated LLM re-ranking to improve match precision while reducing unnecessary inference cost and repeated processing' },
          { id: 'b_rackx_4', text: 'Built an autonomous application workflow using Steel browser sessions + Playwright CDP, enabling live progress streaming, dynamic form completion, resume upload handling, and stateless backend execution per application request' },
        ]},
        { id: 'tune', head: 'Instruction Tuning Dataset Generator for StarCoder2-15B | Python, LoRA, PEFT', right: 'New Jersey, USA', bullets: [
          { id: 'b_tune_1', text: 'Built synthetic data generation pipelines for LLM fine-tuning, using prompt orchestration, automated validation, and quality filtering to create high-quality instruction datasets at scale' },
          { id: 'b_tune_2', text: 'Fine-tuned open-source LLMs with LoRA/QLoRA, PEFT, and Hugging Face Transformers, reducing GPU memory usage by 70% while maintaining model performance and supporting scalable multi-language training workflows' },
        ]},
      ]},
      { id: 'skills', title: 'Technical Skills', kind: 'lines', lines: [
        { id: 'sk_llm', label: 'LLMs & Inference', text: 'OpenAI API, vLLM, ONNX, TensorRT, HF Transformers, LoRA/QLoRA, PEFT, Prompt Caching' },
        { id: 'sk_agentic', label: 'Agentic & RAG Systems', text: 'LangGraph, LangChain, Hybrid RAG (BM25 + pgvector), Cross-Encoder Reranking, Agentic RAG, RAGAS, LLM-as-Judge, Prompt Regression Testing, LangSmith, Tool Calling, and Function Calling' },
        { id: 'sk_ml', label: 'ML & Modeling', text: 'PyTorch, Scikit-learn, XGBoost, MLflow, Feature Engineering, Drift Monitoring, Model Evaluation' },
        { id: 'sk_cloud', label: 'Cloud', text: 'Azure (AI Foundry, AI Search, OneLake), AWS (SageMaker, Bedrock, S3), Docker, Kubernetes, Kafka, Spark/PySpark' },
        { id: 'sk_db', label: 'Databases & Retrieval', text: 'PostgreSQL (pgvector, HNSW indexing), Redis, MongoDB, Pinecone, FAISS' },
        { id: 'sk_lang', label: 'Languages & Frameworks', text: 'Python, TypeScript, SQL, Java · FastAPI, React/Next.js, Pandas, NumPy' },
      ]},
      { id: 'pubs', title: 'Publications', kind: 'lines', lines: [
        { id: 'pub_1', label: '', text: 'The prediction of CERN electron mass collision by using CATBoosting and LGBMR — Published in IEEE' },
        { id: 'pub_2', label: '', text: 'Detecting Diabetic Retinopathy using Deep Learning — Published' },
      ]},
      { id: 'edu', title: 'Education', kind: 'edu', rows: [
        { id: 'edu_1', school: 'New Jersey Institute of Technology', degree: "Master's in Computer Science", right: 'Newark, NJ', dates: '09/2023 – 05/2025' },
      ]},
    ],
  }
}

const PATCHES = [
  { id: 'p1', target: 'b_uber_2', op: 'insert', anchor: 'Spark/PySpark pipelines', text: ' on Databricks', req: 'Databricks', context: 'Uber · pipelines bullet', reason: 'Places the top required platform keyword where your experience already proves it.' },
  { id: 'p2', target: 'sk_cloud', op: 'replace', before: 'Docker, Kubernetes', after: 'Databricks, Cloudera, Docker, Kubernetes', shown: 'Databricks, Cloudera', req: 'Databricks · Cloudera', context: 'Skills · Cloud', reason: 'Adds the required platform plus a preferred one to your Cloud skill line.' },
  { id: 'p3', target: 'sk_cloud', op: 'replace', before: 'Bedrock, S3)', after: 'Bedrock, S3), GCP (Vertex AI)', shown: 'GCP (Vertex AI)', req: 'GCP', context: 'Skills · Cloud', reason: 'Covers the preferred multi-cloud requirement — you list GCP experience at Uber.' },
  { id: 'p4', target: 'b_robo_2', op: 'replace', before: 'ETL & analytics workflows', after: 'ELT/ETL & analytics workflows', shown: 'ELT/ETL', req: 'ELT/ETL processes', context: 'Robosoft · workflows bullet', reason: 'Mirrors the exact "ELT/ETL" phrasing the job description uses.' },
  { id: 'p5', target: 'b_wipro_1', op: 'replace', before: 'REST APIs', after: 'REST APIs and FastAPI microservices', shown: 'FastAPI microservices', req: 'FastAPI · Microservices', context: 'Wipro · backend bullet', reason: 'Names two required keywords using the stack you already describe.' },
]

const REQ_SKILLS = ['Python', 'PySpark', 'Databricks', 'ELT/ETL processes', 'FastAPI', 'Microservices', 'Kafka'].map(t => ({ text: t, met: true }))
const PREF_SKILLS = [{ text: 'Cloudera', met: true }, { text: 'AWS', met: true }, { text: 'Azure', met: true }, { text: 'GCP', met: true }, { text: 'Angular', met: false }]
const LOG_STEPS = [
  { text: 'Parsing job description', badge: '' },
  { text: 'Extracting key requirements', badge: '12 found' },
  { text: 'Scoring resume against requirements', badge: '' },
  { text: 'Inserting keyword optimizations', badge: '5 edits' },
  { text: 'Rendering optimized preview', badge: '' },
]
const SUBMIT_STEPS = [
  'Opening Databricks careers form',
  'Uploading optimized resume PDF',
  'Filling profile & contact fields',
  'Attaching cover letter',
  'Answering screening questions',
  'Final review & submit',
]
const LETTER = `Dear Databricks Hiring Team,

I'm writing to apply for the Systems PhD — Software Engineer role. I build the kind of systems this position describes: at Uber I architect agentic AI workflows and Spark/PySpark pipelines that process 10,000+ safety reports weekly, and at Dell I shipped 14 production microservices with feature stores and validation infrastructure spanning 28 enterprise data sources.

The lakehouse problems your Data Platform org works on map directly to my experience — large-scale ELT/ETL on Spark, streaming with Kafka, and production ML serving where I cut inference latency from 350ms to 45ms. I also build with FastAPI and pgvector daily on Rackx.app, my production AI platform that ranks 12,000+ live job postings with a hybrid retrieval and LLM re-ranking pipeline.

I'd love to bring that mix of systems rigor and applied AI experience to Databricks.`

const applyPatch = (text, p) => {
  if (p.op === 'replace') return text.replace(p.before, p.after)
  if (p.atEnd) return text + p.text
  const i = text.indexOf(p.anchor)
  return i === -1 ? text + p.text : text.slice(0, i + p.anchor.length) + p.text + text.slice(i + p.anchor.length)
}

// ── doc normalization ──────────────────────────────────────────────────────
// Real resume parsing often splits one bullet across several physical lines,
// so a single point arrives as multiple bullet objects ("…support operations
// and" / "telemetry analysis, reducing…"). That reads as broken fragments and
// makes text selection feel like it grabs a whole "line" (because each line is
// its own field). We coalesce continuation fragments back into whole bullets.
//
// Heuristic (conservative): merge bullet[i] into bullet[i-1] only when the
// fragment is clearly a wrapped continuation — it starts lowercase, or with a
// connective/punctuation that can't begin a real bullet. Genuine new bullets
// start with a capital letter or a number, so they are never merged.
const _CONT_RE = /^[a-z(,;:&/%\-–—]/   // lowercase or mid-sentence punctuation
const _isContinuation = (s) => {
  const t = (s || '').trimStart()
  if (!t) return false
  // Common lowercase openers are continuations; anything starting with a
  // capital, digit, or bullet glyph is treated as a fresh point.
  return _CONT_RE.test(t)
}
// Returns { doc, mergedMap } where mergedMap[droppedBulletId] = keptBulletId.
function normalizeDoc(doc) {
  if (!doc || !Array.isArray(doc.sections)) return { doc, mergedMap: {} }
  const mergedMap = {}
  const clone = JSON.parse(JSON.stringify(doc))
  for (const sec of clone.sections) {
    if (sec.kind !== 'entries' || !Array.isArray(sec.entries)) continue
    for (const ent of sec.entries) {
      if (!Array.isArray(ent.bullets) || ent.bullets.length < 2) continue
      const out = []
      for (const b of ent.bullets) {
        const prev = out[out.length - 1]
        if (prev && _isContinuation(b.text)) {
          // fold this fragment into the previous bullet
          const joiner = /\s$/.test(prev.text) ? '' : ' '
          prev.text = (prev.text + joiner + (b.text || '')).replace(/\s+/g, ' ').trim()
          mergedMap[b.id] = prev.id
        } else {
          out.push({ ...b })
        }
      }
      ent.bullets = out
    }
  }
  return { doc: clone, mergedMap }
}
// After coalescing, patches that targeted a folded-away fragment must point at
// the surviving bullet id. The fragment's text still lives inside the merged
// bullet, so the anchor/before strings still resolve for highlight + insertion.
function remapPatches(patches, mergedMap) {
  if (!Array.isArray(patches) || !mergedMap) return patches || []
  return patches.map(p => (p && mergedMap[p.target]) ? { ...p, target: mergedMap[p.target] } : p)
}

// ── shared SVG snippets ────────────────────────────────────────────────────
const Check = ({ size = 10, stroke, width = 2.6 }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke={stroke} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round"><path d="M2.5 8.5l3.5 3.5 7-8" /></svg>
)
const PencilIcon = ({ size = 11 }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M11 2l3 3-8 8-3.5 1 1-3.5 8-8z" /></svg>
)
const ArrowIcon = ({ size = 14, width = 2 }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={width} strokeLinecap="round" strokeLinejoin="round"><path d="M3 8h9M8.5 4l4 4-4 4" /></svg>
)
const Spinner = ({ size = 13, color = 'var(--accent-ink)' }) => (
  <span style={{ width: size, height: size, borderRadius: '50%', border: `2px solid ${color}`, borderTopColor: 'transparent', display: 'block', animation: 'rkSpin 0.8s linear infinite' }} />
)

// ═══════════════════════════════════════════════════════════════════════════
export default class ResumeOptimizer extends React.Component {
  constructor(props) {
    super(props)
    // Prop-seeded data with mock fallback — keeps the standalone prototype
    // working while letting Dashboard feed the live API contract.
    const _rawPatches = (props.patches    && props.patches.length)    ? props.patches    : PATCHES
    const _rawDoc     = props.initialDoc || initialDoc()
    // Coalesce line-wrapped bullet fragments into whole bullets, then retarget
    // any patches that pointed at a folded-away fragment.
    const { doc: _normDoc, mergedMap: _mergedMap } = normalizeDoc(_rawDoc)
    this.patches    = remapPatches(_rawPatches, _mergedMap)
    this.reqSkills  = (props.reqSkills   && props.reqSkills.length)  ? props.reqSkills  : REQ_SKILLS
    this.prefSkills = (props.prefSkills  && props.prefSkills.length) ? props.prefSkills : PREF_SKILLS
    this.letter     = props.coverLetter || LETTER
    const _theme = (props.theme === 'dark' || props.theme === 'light')
      ? props.theme
      : (props.defaultTheme === 'dark' ? 'dark' : 'light')
    this.state = {
      theme: _theme,
      stage: props.skipIntro ? 'resume' : 'optimizing',
      logStep: 0, score: 0,
      docTab: 'resume',
      fontSize: 10.5, align: 'left', editing: false, fit: false,
      decisions: {}, manualEdits: {}, editSnapshot: null,
      doc: _normDoc, drag: null, approving: false,
      pages: null, effFont: 10.5,
      coverChars: 0, coverActive: false, coverText: null, coverEditing: false, coverFont: 12.5,
      submitStep: -1,
      margins: { ...DEFAULT_MARGINS }, marginsOpen: false, hoverPatch: null,
      lineGap: 1.38, gapScale: 1.0, spacingOpen: false,
      selBar: null, linkMode: false, linkUrl: '', selPx: null,
      linkPop: null, linkEditVal: '', histLen: 0, redoLen: 0,
      popover: null, feedback: null, toast: null,
    }
    this.measureRef = React.createRef()
    this._timers = []
  }
  t(fn, ms) { this._timers.push(setTimeout(fn, ms)) }
  iv(fn, ms) { const i = setInterval(fn, ms); this._timers.push(i); return i }
  componentWillUnmount() {
    this._timers.forEach(x => { clearTimeout(x); clearInterval(x) })
    if (this._onSel) document.removeEventListener('selectionchange', this._onSel)
    if (this._onKey) document.removeEventListener('keydown', this._onKey)
  }
  componentDidMount() {
    ensureGlobals()
    if (this.state.stage === 'optimizing') this.runOptimizing()
    else this.countScore()
    this.scheduleMeasure()
    this._onSel = () => this.handleSelectionChange()
    document.addEventListener('selectionchange', this._onSel)
    this._hist = []
    this._onKey = e => {
      const S = this.state
      if (!(S.editing || S.coverEditing)) return
      if ((e.metaKey || e.ctrlKey) && ((e.shiftKey && (e.key === 'z' || e.key === 'Z')) || e.key === 'y')) {
        if (this._redo && this._redo.length) { e.preventDefault(); this.redo() }
        return
      }
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
        let native = false
        try { native = document.queryCommandEnabled('undo') } catch (err) {}
        if (native) return
        if (this._hist.length) { e.preventDefault(); this.undo() }
      }
    }
    document.addEventListener('keydown', this._onKey)
  }

  // ── undo / redo history ──
  snapshot() {
    return {
      manualEdits: { ...this.state.manualEdits },
      doc: JSON.parse(JSON.stringify(this.state.doc)),
      coverText: this.state.coverText,
    }
  }
  pushHist() {
    this._hist.push(this.snapshot())
    if (this._hist.length > 20) this._hist.shift()
    this._redo = []
    this.setState({ histLen: this._hist.length, redoLen: 0 })
  }
  undo() {
    const h = this._hist.pop()
    if (!h) return
    ;(this._redo = this._redo || []).push(this.snapshot())
    if (this._redo.length > 20) this._redo.shift()
    this.setState({ manualEdits: h.manualEdits, doc: h.doc, coverText: h.coverText, histLen: this._hist.length, redoLen: this._redo.length, selBar: null, linkPop: null })
  }
  redo() {
    const h = this._redo && this._redo.pop()
    if (!h) return
    this._hist.push(this.snapshot())
    this.setState({ manualEdits: h.manualEdits, doc: h.doc, coverText: h.coverText, histLen: this._hist.length, redoLen: this._redo.length, selBar: null, linkPop: null })
  }
  commitField(id, original, node) {
    const html = node.innerHTML
    const cur = this.state.manualEdits[id] !== undefined ? this.state.manualEdits[id]
      : String(this.baseText(id, original)).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    if (html === cur) return
    this.pushHist()
    this.setState(s => ({ manualEdits: { ...s.manualEdits, [id]: html } }))
  }
  commitFieldEl(fieldEl) {
    const fid = fieldEl.getAttribute('data-fid')
    if (!fid) return
    this.pushHist()
    this.setState(s => ({ manualEdits: { ...s.manualEdits, [fid]: fieldEl.innerHTML } }))
  }

  // ── selection format bubble ──
  handleSelectionChange() {
    if (this._selRaf) return
    this._selRaf = requestAnimationFrame(() => {
      this._selRaf = null
      const S = this.state
      if (!(S.editing || S.coverEditing)) { if (S.selBar) this.setState({ selBar: null, linkMode: false }); return }
      if (S.linkMode) return
      const sel = window.getSelection()
      console.log('[RACK selection]', {
        text: sel ? sel.toString() : null,
        length: sel ? sel.toString().length : 0,
        collapsed: sel ? sel.isCollapsed : null,
        rangeCount: sel ? sel.rangeCount : 0,
      })
      let bar = null, px = null
      if (sel && sel.rangeCount && !sel.isCollapsed) {
        const n = sel.anchorNode
        const elp = n && (n.nodeType === 1 ? n : n.parentElement)
        if (elp && elp.closest && elp.closest('.rk-edit-field')) {
          const r = sel.getRangeAt(0).getBoundingClientRect()
          if (r.width || r.height) {
            bar = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top) }
            px = Math.round(parseFloat(getComputedStyle(elp).fontSize) * 10) / 10
          }
        } else {
          console.log('[RACK selection] anchor node is NOT inside a .rk-edit-field', elp)
        }
      }
      const prev = S.selBar
      if ((!bar && prev) || (bar && (!prev || prev.x !== bar.x || prev.y !== bar.y || S.selPx !== px))) this.setState({ selBar: bar, selPx: px })
    })
  }
  fmt(cmd, val) { document.execCommand(cmd, false, val || null) }
  selFontDelta(delta) {
    const sel = window.getSelection()
    if (!sel || !sel.rangeCount || sel.isCollapsed) return
    const n = sel.anchorNode
    const anchorEl = n && (n.nodeType === 1 ? n : n.parentElement)
    const fieldEl = anchorEl && anchorEl.closest && anchorEl.closest('.rk-edit-field')
    if (!fieldEl) return
    const basePx = parseFloat(getComputedStyle(anchorEl).fontSize) || 11
    const newPx = Math.round(Math.min(28, Math.max(6, basePx + delta)) * 10) / 10
    document.execCommand('fontSize', false, '7')
    const spans = []
    Array.from(fieldEl.querySelectorAll('font[size="7"]')).forEach(f => {
      const s = document.createElement('span')
      s.style.fontSize = newPx + 'px'
      while (f.firstChild) s.appendChild(f.firstChild)
      f.parentNode.replaceChild(s, f)
      spans.push(s)
    })
    if (spans.length) {
      const r = document.createRange()
      r.setStart(spans[0], 0)
      const last = spans[spans.length - 1]
      r.setEnd(last, last.childNodes.length)
      sel.removeAllRanges()
      sel.addRange(r)
      this.setState({ selPx: newPx })
    }
  }
  applyLinkPop() {
    const a = this._linkEl
    let url = (this.state.linkEditVal || '').trim()
    if (a && url) {
      if (!/^https?:\/\//i.test(url)) url = 'https://' + url
      a.setAttribute('href', url)
      const fieldEl = a.closest('.rk-edit-field')
      if (fieldEl) this.commitFieldEl(fieldEl)
    }
    this.setState({ linkPop: null, linkEditVal: '' })
  }
  openLink() {
    const sel = window.getSelection()
    if (sel && sel.rangeCount) this._savedRange = sel.getRangeAt(0).cloneRange()
    this.setState({ linkMode: true, linkUrl: '' })
  }
  applyLink() {
    const sel = window.getSelection()
    if (this._savedRange) { sel.removeAllRanges(); sel.addRange(this._savedRange) }
    let url = (this.state.linkUrl || '').trim()
    if (url) {
      if (!/^https?:\/\//i.test(url)) url = 'https://' + url
      document.execCommand('createLink', false, url)
    }
    this._savedRange = null
    this.setState({ linkMode: false, linkUrl: '', selBar: null })
  }
  // FLIP: capture row positions right before a reorder commits.
  getSnapshotBeforeUpdate(prevProps, prevState) {
    if (prevState && prevState.doc !== this.state.doc && (this.state.editing || this.state.coverEditing)) {
      const map = {}
      document.querySelectorAll('.rk-dragrow[data-rowid]').forEach(n => {
        map[n.getAttribute('data-rowid')] = n.getBoundingClientRect().top
      })
      return map
    }
    return null
  }
  componentDidUpdate(prevProps, prevState, snapshot) {
    // Follow the app's theme when the parent controls it.
    if (prevProps && this.props.theme && this.props.theme !== prevProps.theme && this.props.theme !== this.state.theme) {
      this.setState({ theme: this.props.theme })
    }
    // Play the FLIP: translate each moved row from its old spot to its new one,
    // then release the transform on the next frame so it eases into place.
    if (snapshot) {
      const nodes = document.querySelectorAll('.rk-dragrow[data-rowid]')
      nodes.forEach(n => {
        const id = n.getAttribute('data-rowid')
        const prevTop = snapshot[id]
        if (prevTop == null) return
        const delta = prevTop - n.getBoundingClientRect().top
        if (!delta) return
        n.classList.remove('rk-flip')
        n.style.transform = `translateY(${delta}px)`
      })
      requestAnimationFrame(() => {
        nodes.forEach(n => {
          if (!n.style.transform) return
          n.classList.add('rk-flip')
          n.style.transform = ''
        })
      })
    }
    this.scheduleMeasure()
  }

  runOptimizing() {
    const iv = this.iv(() => {
      const n = this.state.logStep + 1
      if (n > LOG_STEPS.length) {
        clearInterval(iv)
        this.setState({ stage: 'resume' })
        this.countScore()
      } else this.setState({ logStep: n })
    }, 720)
  }
  countScore() {
    const target = this.props.matchPercent ?? 91
    const iv = this.iv(() => {
      const s = Math.min(this.state.score + 4, target)
      this.setState({ score: s })
      if (s >= target) clearInterval(iv)
    }, 28)
  }

  // ── measurement-based pagination (real reflow, no scale transforms) ──
  scheduleMeasure() {
    if (this._raf) return
    this._raf = requestAnimationFrame(() => { this._raf = null; this.measure() })
  }
  measure() {
    const c = this.measureRef.current
    if (!c || this.state.editing || this.state.docTab !== 'resume' || this.state.stage === 'optimizing') return
    const m = this.state.margins
    const USABLE_H = PAGE_H - (m.top + m.bottom) * PPI
    c.style.width = (PAGE_W - (m.left + m.right) * PPI) + 'px'
    const kids = () => Array.from(c.children)
    const totalAt = f => { c.style.fontSize = f + 'px'; void c.offsetHeight; return kids().reduce((s, el) => s + el.getBoundingClientRect().height, 0) }
    let eff = this.state.fontSize
    if (this.state.fit) {
      const FIT_MIN = 7
      if (totalAt(eff) > USABLE_H) {
        let lo = FIT_MIN, hi = eff, best = FIT_MIN
        for (let i = 0; i < 16; i++) { const mid = (lo + hi) / 2; if (totalAt(mid) <= USABLE_H) { best = mid; lo = mid } else hi = mid }
        eff = Math.max(FIT_MIN, Math.floor(best * 4) / 4)
        if (totalAt(eff) > USABLE_H) eff = Math.max(FIT_MIN, eff - 0.25)
      }
    }
    c.style.fontSize = eff + 'px'; void c.offsetHeight
    const hs = kids().map(el => el.getBoundingClientRect().height)
    const types = this._flowTypes || []
    const pages = []; let cur = [], used = 0
    for (let i = 0; i < hs.length; i++) {
      if (used + hs[i] > USABLE_H && cur.length) { pages.push(cur); cur = []; used = 0 }
      cur.push(i); used += hs[i]
    }
    if (cur.length) pages.push(cur)
    for (let p = 0; p < pages.length - 1; p++) {
      const pg = pages[p]
      while (pg.length) {
        const t = types[pg[pg.length - 1]]
        if (t === 'sec' || t === 'sub') pages[p + 1].unshift(pg.pop()); else break
      }
    }
    const packed = pages.filter(pg => pg.length)
    c.style.fontSize = this.state.fontSize + 'px'
    if (JSON.stringify(packed) !== JSON.stringify(this.state.pages) || eff !== this.state.effFont)
      this.setState({ pages: packed, effFont: eff })
  }

  // ── text derivation ──
  baseText(id, original) {
    const mine = this.patches.filter(p => p.target === id && this.state.decisions[p.id] !== 'rejected')
    let out = original
    for (const p of mine) out = applyPatch(out, p)
    return out
  }

  // ── drag reorder ──
  dragStart(e, info) {
    e.dataTransfer.setData('text/plain', '')
    e.dataTransfer.effectAllowed = 'move'
    this.pushHist()
    this.setState({ drag: info })
  }
  // Reorders so the dragged item lands at `target`'s slot. Shared by dragOver
  // (precise, midpoint-gated) and dragEnter (fallback for fast pointer moves).
  reorderTo(target) {
    const d = this.state.drag
    if (!d || d.id === target.id || d.kind !== target.kind) return
    const doc = JSON.parse(JSON.stringify(this.state.doc))
    const move = (arr) => {
      const from = arr.findIndex(x => x.id === d.id)
      const to = arr.findIndex(x => x.id === target.id)
      if (from === -1 || to === -1 || from === to) return false
      arr.splice(to, 0, arr.splice(from, 1)[0])
      return true
    }
    let ok = false
    if (d.kind === 'section') ok = move(doc.sections)
    else {
      const sec = doc.sections.find(s => s.id === target.parentSec)
      if (sec && d.parentSec === target.parentSec) {
        if (d.kind === 'entry') ok = move(sec.entries)
        else if (d.kind === 'line') ok = move(sec.lines || sec.rows)
        else if (d.kind === 'bullet') {
          const ent = sec.entries.find(en => en.id === target.parentEntry)
          if (ent && d.parentEntry === target.parentEntry) ok = move(ent.bullets)
        }
      }
    }
    if (ok) this.setState({ doc })
  }
  // Only swap once the pointer crosses the target row's vertical midpoint —
  // this removes the jitter/"snappy" back-and-forth of raw dragEnter swapping.
  dragOver(target, e) {
    const d = this.state.drag
    if (!d || d.id === target.id || d.kind !== target.kind) return
    const row = e.currentTarget
    if (!row || !row.getBoundingClientRect) return
    const r = row.getBoundingClientRect()
    const mid = r.top + r.height / 2
    const rows = Array.from(document.querySelectorAll('.rk-dragrow[data-rowid]'))
    const di = rows.findIndex(x => x.getAttribute('data-rowid') === d.id)
    const ti = rows.findIndex(x => x.getAttribute('data-rowid') === target.id)
    // Moving down: swap when pointer passes below the midpoint; moving up: above.
    if (di < ti && e.clientY < mid) return
    if (di > ti && e.clientY > mid) return
    this.reorderTo(target)
  }
  dragEnter(target) { this.reorderTo(target) }

  // ── document flow ──
  buildFlow() {
    const el = React.createElement
    const S = this.state
    const editing = S.editing
    const items = []
    const push = (id, type, node, gap) => items.push({ id, type, node, gap: Math.round(gap * S.gapScale * 10) / 10 })

    const escapeHtml = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const fieldHtml = (id, original) => {
      if (S.manualEdits[id] !== undefined) return S.manualEdits[id]
      return escapeHtml(this.baseText(id, original))
    }
    const editable = (id, original, block) => el('span', {
      contentEditable: true, suppressContentEditableWarning: true,
      className: 'rk-edit-field', 'data-fid': id,
      onBlur: e => this.commitField(id, original, e.target),
      onClick: e => {
        e.stopPropagation()
        const a = e.target && e.target.closest && e.target.closest('a')
        if (a) {
          e.preventDefault()
          this._linkEl = a
          const r = a.getBoundingClientRect()
          this.setState({ linkPop: { x: Math.round(r.left + r.width / 2), y: Math.round(r.bottom), href: a.getAttribute('href') || '', editing: false }, selBar: null })
        }
      },
      style: { display: block ? 'block' : 'inline', outline: 'none', borderRadius: 3, cursor: 'text' },
      dangerouslySetInnerHTML: { __html: fieldHtml(id, original) },
    })

    const highlighted = (id, original) => {
      if (S.manualEdits[id] !== undefined) return el('span', { dangerouslySetInnerHTML: { __html: S.manualEdits[id] } })
      const mine = this.patches.filter(p => p.target === id && S.decisions[p.id] !== 'rejected')
      if (!mine.length) return el('span', null, original)
      let segs = [{ text: original, added: null }]
      for (const p of mine) {
        if (p.op !== 'replace' && p.atEnd) {
          // True "append to end" — lands after everything built so far and
          // never re-searches inside existing segments. Searching by anchor
          // for an end-of-field insert is what caused duplicate/scrambled
          // text when two such patches targeted the same bullet.
          segs.push({ text: p.text, added: p })
          continue
        }
        const next = []
        for (const seg of segs) {
          if (seg.added) { next.push(seg); continue }
          const before = p.op === 'replace' ? p.before : p.anchor
          const idx = seg.text.indexOf(before)
          if (idx === -1) { next.push(seg); continue }
          if (p.op === 'replace') {
            if (idx > 0) next.push({ text: seg.text.slice(0, idx), added: null })
            next.push({ text: p.after, added: p })
            next.push({ text: seg.text.slice(idx + before.length), added: null })
          } else {
            next.push({ text: seg.text.slice(0, idx + before.length), added: null })
            next.push({ text: p.text, added: p })
            next.push({ text: seg.text.slice(idx + before.length), added: null })
          }
        }
        segs = next
      }
      return el('span', null, ...segs.map((seg, i) => seg.added
        ? el('span', {
            key: i, className: 'rk-hl',
            title: 'AI insertion — click to review',
            onClick: e => { e.stopPropagation(); this.setState({ popover: { id: seg.added.id, x: e.clientX, y: e.clientY } }) },
            style: { background: 'var(--added-bg)', color: 'var(--added-text)', borderRadius: 3, padding: '0 2px', fontWeight: 600,
              boxShadow: S.hoverPatch === seg.added.id ? '0 0 0 2px var(--added-text)' : undefined },
          }, seg.text)
        : el('span', { key: i }, seg.text)))
    }

    const target = (id, original) => editing ? editable(id, original) : highlighted(id, original)
    const field = (id, original) => editing ? editable(id, original) : el('span', { dangerouslySetInnerHTML: { __html: fieldHtml(id, original) } })

    const handle = (info, top) => editing ? el('span', {
      className: 'rk-handle', draggable: true,
      onDragStart: e => this.dragStart(e, info),
      onDragEnd: () => this.setState({ drag: null }),
      title: 'Drag to reorder',
      style: { position: 'absolute', left: -22, top: top || 0, width: 16, fontSize: 11, lineHeight: 1, color: '#8a8880', userSelect: 'none', textAlign: 'center' },
    }, '⠿') : null

    const dragRow = (info, style, ...children) => el('div', {
      className: 'rk-dragrow' + (S.drag && S.drag.id === info.id ? ' rk-dragging' : ''),
      'data-rowid': info.id,
      onDragOver: editing ? (e => { e.preventDefault(); this.dragOver(info, e) }) : undefined,
      onDragEnter: editing ? (() => this.dragEnter(info)) : undefined,
      style: { position: 'relative', ...style },
    }, handle(info), ...children)

    push('__header', 'head', el('div', { style: { textAlign: 'center' } },
      el('div', { style: { fontWeight: 700, fontSize: '1.85em', letterSpacing: '-0.01em', lineHeight: 1.15 } }, field('h_name', S.doc.header.name)),
      el('div', { style: { fontSize: '0.9em', marginTop: 3, lineHeight: 1.45, color: '#333' } }, field('h_contact', S.doc.header.contact)),
    ), G_HEAD)

    for (const sec of S.doc.sections) {
      const secInfo = { kind: 'section', id: sec.id }
      push('sec_' + sec.id, 'sec', dragRow(secInfo, {},
        el('div', { style: { fontWeight: 700, fontSize: '1.05em', borderBottom: '1px solid #141414', paddingBottom: 2, letterSpacing: '0.01em' } }, sec.title),
      ), G_TITLE)

      if (sec.kind === 'entries') {
        sec.entries.forEach((ent, ei) => {
          const entInfo = { kind: 'entry', id: ent.id, parentSec: sec.id }
          push(ent.id + '__h', 'sub', dragRow(entInfo, { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, fontWeight: 700 },
            el('span', { style: { minWidth: 0, flex: '1 1 auto', overflowWrap: 'break-word' } }, field('e:' + ent.id + ':head', ent.head)),
            el('span', { style: { fontWeight: 400, color: '#444', fontSize: '0.92em', whiteSpace: 'nowrap', flexShrink: 0 } }, field('e:' + ent.id + ':right', ent.right)),
          ), G_SUB)
          ent.bullets.forEach((b, bi) => {
            const bInfo = { kind: 'bullet', id: b.id, parentSec: sec.id, parentEntry: ent.id }
            push(b.id, 'bullet', dragRow(bInfo, { display: 'flex', alignItems: 'flex-start', gap: 6, paddingLeft: 4 },
              el('span', { style: { flexShrink: 0, lineHeight: S.lineGap } }, '•'),
              el('div', { style: { flex: 1, lineHeight: S.lineGap } }, target(b.id, b.text)),
            ), bi === ent.bullets.length - 1 ? (ei === sec.entries.length - 1 ? G_SEC : G_ENTRY) : G_LINE)
          })
        })
      } else if (sec.kind === 'lines') {
        sec.lines.forEach((ln, li) => {
          const lInfo = { kind: 'line', id: ln.id, parentSec: sec.id }
          push(ln.id, 'line', dragRow(lInfo, { lineHeight: S.lineGap },
            ln.label ? el('strong', null, field('l:' + ln.id + ':label', ln.label), ': ') : null,
            target(ln.id, ln.text),
          ), li === sec.lines.length - 1 ? G_SEC : G_LINE)
        })
      } else if (sec.kind === 'edu') {
        sec.rows.forEach((r, ri) => {
          const rInfo = { kind: 'line', id: r.id, parentSec: sec.id }
          push(r.id, 'line', dragRow(rInfo, {},
            el('div', { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, fontWeight: 700 } },
              el('span', { style: { minWidth: 0, flex: '1 1 auto', overflowWrap: 'break-word' } }, field('edu:' + r.id + ':school', r.school)),
              el('span', { style: { fontWeight: 400, color: '#444', fontSize: '0.92em', whiteSpace: 'nowrap', flexShrink: 0 } }, field('edu:' + r.id + ':right', r.right)),
            ),
            el('div', { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 } },
              el('span', { style: { minWidth: 0, flex: '1 1 auto', overflowWrap: 'break-word' } }, field('edu:' + r.id + ':degree', r.degree)),
              el('span', { style: { color: '#444', fontSize: '0.92em', whiteSpace: 'nowrap', flexShrink: 0 } }, field('edu:' + r.id + ':dates', r.dates)),
            ),
          ), ri === sec.rows.length - 1 ? 0 : G_LINE)
        })
      }
    }
    if (items.length) items[items.length - 1].gap = 0
    this._flowTypes = items.map(it => it.type)
    return items
  }

  buildResumeSurface() {
    const el = React.createElement
    const S = this.state
    const flow = this.buildFlow()
    const baseStyle = { fontFamily: FONT_DOC, lineHeight: S.lineGap, textAlign: S.align, color: '#141414' }
    const m = S.margins
    const padT = m.top * PPI, padR = m.right * PPI, padB = m.bottom * PPI, padL = m.left * PPI
    const pagePad = padT + 'px ' + padR + 'px ' + padB + 'px ' + padL + 'px'
    const contentW = PAGE_W - padL - padR

    const guideLabel = (val, pos) => el('span', { style: { position: 'absolute', ...pos, fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 600, color: 'var(--accent2)', background: '#ffffff', padding: '0 4px', borderRadius: 3, whiteSpace: 'nowrap' } }, val.toFixed(2) + '"')
    const guides = S.marginsOpen ? el('div', { style: { position: 'absolute', left: padL, right: padR, top: padT, bottom: padB, border: '1px dashed var(--accent2)', pointerEvents: 'none', zIndex: 1 } },
      guideLabel(m.top, { top: -7, left: '50%', transform: 'translate(-50%,-100%)' }),
      guideLabel(m.bottom, { bottom: -7, left: '50%', transform: 'translate(-50%,100%)' }),
      guideLabel(m.left, { left: -5, top: '50%', transform: 'translate(-100%,-50%)' }),
      guideLabel(m.right, { right: -5, top: '50%', transform: 'translate(100%,-50%)' }),
    ) : null

    const measurer = !S.editing ? el('div', {
      ref: this.measureRef, 'aria-hidden': true,
      style: { position: 'absolute', left: -99999, top: 0, visibility: 'hidden', pointerEvents: 'none', width: contentW, fontSize: S.fontSize, ...baseStyle },
    }, flow.map(it => el('div', { key: it.id, style: { paddingBottom: it.gap } }, it.node))) : null

    if (S.editing) {
      return el('div', { style: { padding: 28 } },
        el('div', { className: 'rk-page', style: { width: PAGE_W, margin: '0 auto', minHeight: PAGE_H, background: '#ffffff', borderRadius: 4, boxShadow: 'var(--page-shadow)', padding: pagePad, paddingLeft: padL + 6, fontSize: S.fontSize, position: 'relative', ...baseStyle } },
          guides,
          flow.map(it => el('div', { key: it.id, className: 'rk-fi', style: { paddingBottom: it.gap } }, it.node)),
        ),
      )
    }
    const pageIdxs = (S.pages && S.pages.length ? S.pages : [flow.map((_, i) => i)])
      .map(pg => pg.filter(i => i < flow.length)).filter(pg => pg.length)
    return el('div', { style: { padding: '28px 28px 20px' } },
      measurer,
      ...pageIdxs.map((idxs, pi) => el('div', { key: pi, className: 'rk-page', style: { width: PAGE_W, height: PAGE_H, margin: '0 auto 18px', overflow: 'hidden', background: '#ffffff', borderRadius: 4, boxShadow: 'var(--page-shadow)', padding: pagePad, fontSize: S.effFont, position: 'relative', ...baseStyle } },
        guides,
        idxs.map(i => flow[i] && el('div', { key: flow[i].id, className: 'rk-fi', style: { paddingBottom: flow[i].gap } }, flow[i].node)),
      )),
      el('div', { style: { fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-dim)', paddingBottom: 6, textAlign: 'center' } },
        pageIdxs.length + (pageIdxs.length === 1 ? ' page · US Letter' : ' pages · US Letter') + (S.fit ? ' · fitted at ' + S.effFont.toFixed(1) + 'pt' : '')),
    )
  }

  toast(msg) {
    this.setState({ toast: msg })
    this.t(() => this.setState({ toast: null }), 2200)
  }
  approveResume() {
    // Approving is what persists decisions + renders the PDF server-side.
    // Only advance to the cover-letter stage once the backend confirms.
    const payload = { decisions: this.state.decisions, manualEdits: this.state.manualEdits }
    if (this.props.onApprove) {
      this.setState({ approving: true })
      Promise.resolve(this.props.onApprove(payload))
        .then(() => { this.setState({ approving: false }); this.startCover() })
        .catch(err => { console.error('[ResumeOptimizer] approve failed:', err); this.setState({ approving: false }); this.toast('Approval failed — please retry') })
    } else {
      this.startCover()
    }
  }
  downloadResume() {
    const payload = { decisions: this.state.decisions, manualEdits: this.state.manualEdits }
    if (this.props.onDownload) Promise.resolve(this.props.onDownload(payload)).catch(e => console.error('[ResumeOptimizer] download failed:', e))
    else this.toast('Optimized resume saved as PDF')
  }
  startCover() {
    this.setState({ stage: 'cover', docTab: 'cover', coverChars: 0, coverActive: true, coverText: null, coverEditing: false, marginsOpen: false })
    const iv = this.iv(() => {
      const n = this.state.coverChars + 5
      if (n >= this.letter.length) { clearInterval(iv); this.setState({ coverChars: this.letter.length, coverActive: false }) }
      else this.setState({ coverChars: n })
    }, 16)
  }
  startSubmit() {
    this.setState({ stage: 'submitting', submitStep: 0 })
    const iv = this.iv(() => {
      const n = this.state.submitStep + 1
      if (n >= SUBMIT_STEPS.length) {
        clearInterval(iv)
        this.t(() => this.setState({ stage: 'done' }), 500)
      } else this.setState({ submitStep: n })
    }, 950)
  }

  // ── view model ──
  vals() {
    const S = this.state
    const stageIdx = { optimizing: 0, resume: 1, cover: 2, submitting: 3, done: 4 }[S.stage]
    const stepDefs = [
      { label: 'Optimize resume', sub: S.stage === 'optimizing' ? 'analyzing…' : '5 keywords inserted' },
      { label: 'Review resume', sub: stageIdx > 1 ? 'approved' : (stageIdx === 1 ? 'awaiting your approval' : '') },
      { label: 'Cover letter', sub: stageIdx > 2 ? 'approved' : (stageIdx === 2 ? 'generated for this role' : '') },
      { label: 'Submit application', sub: stageIdx === 3 ? 'auto-filling form…' : (stageIdx > 3 ? 'submitted' : '') },
      { label: 'Done', sub: stageIdx === 4 ? 'tracked in your pipeline' : '' },
    ]
    const steps = stepDefs.map((d, i) => {
      const done = i < stageIdx, active = i === stageIdx
      return {
        label: d.label, sub: d.sub || false, done, active,
        dotBg: done ? 'var(--text)' : (active ? 'var(--surface)' : 'transparent'),
        dotBorder: active ? '2px solid var(--text)' : (done ? '1px solid var(--text)' : '1.5px solid var(--border-bright)'),
        labelColor: done || active ? 'var(--text)' : 'var(--text-dim)',
        weight: active ? 700 : 500,
        lineBg: done ? 'var(--text)' : 'var(--border-bright)',
        hasLine: i < stepDefs.length - 1,
        padBottom: i < stepDefs.length - 1 ? 16 : 2,
      }
    })
    const chip = c => ({
      text: c.text, mark: c.met ? '✓' : '✕',
      bg: c.met ? 'var(--added-bg)' : 'var(--chip-bg)',
      color: c.met ? 'var(--added-text)' : 'var(--text-dim)',
      border: c.met ? 'transparent' : 'var(--chip-border)',
    })
    const patchList = this.patches.map(p => {
      const rejected = S.decisions[p.id] === 'rejected'
      return {
        id: p.id, shown: p.shown || p.text.trim(), context: p.context, req: p.req, rejected,
        onToggle: () => { const nd = rejected ? 'accepted' : 'rejected'; if (this.props.onDecisionChange) this.props.onDecisionChange(p.id, nd); this.setState(s => ({ decisions: { ...s.decisions, [p.id]: nd }, popover: null })) },
        onEnter: () => this.setState({ hoverPatch: p.id }),
        onLeave: () => this.setState(s => (s.hoverPatch === p.id ? { hoverPatch: null } : null)),
        onCardClick: () => this.setState({ hoverPatch: p.id, docTab: 'resume' }),
      }
    })
    const appliedCount = this.patches.filter(p => S.decisions[p.id] !== 'rejected').length
    const logLines = LOG_STEPS.map((l, i) => {
      const done = i < S.logStep, running = i === S.logStep
      return { text: l.text, badge: done && l.badge ? l.badge : false, done, running, idle: !done && !running }
    })
    const submitRows = SUBMIT_STEPS.map((t, i) => {
      const done = i < S.submitStep || S.stage === 'done', running = i === S.submitStep && S.stage === 'submitting'
      return { text: t, done, running, idle: !done && !running }
    })
    const tabDefs = [
      { key: 'resume', label: 'Resume', enabled: true },
      { key: 'cover', label: 'Cover letter', enabled: S.stage === 'cover' || stageIdx > 2 },
      { key: 'jd', label: 'Job description', enabled: true },
    ]
    const docTabs = tabDefs.map(t => ({
      key: t.key, label: t.label, disabled: !t.enabled, active: S.docTab === t.key, enabled: t.enabled,
      onClick: () => t.enabled && this.setState({ docTab: t.key, popover: null }),
    }))
    const popPatch = S.popover ? this.patches.find(p => p.id === S.popover.id) : null
    const statusByStage = {
      optimizing: ['Optimizing', 'var(--accent-strong)'],
      resume: ['Awaiting review', 'var(--accent-strong)'],
      cover: ['Cover letter', 'var(--accent-strong)'],
      submitting: ['Submitting', 'var(--accent2)'],
      done: ['Applied', 'var(--accent3)'],
    }
    const activeEditing = S.docTab === 'cover' ? S.coverEditing : S.editing
    return { S, stageIdx, steps, chip, patchList, appliedCount, logLines, submitRows, docTabs, popPatch, statusByStage, activeEditing }
  }

  render() {
    const v = this.vals()
    const S = this.state
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1200
    const vh = typeof window !== 'undefined' ? window.innerHeight : 800
    const coverDone = !S.coverActive && S.coverChars >= this.letter.length
    const activeE = v.activeEditing

    const smallBtn = (active) => sxd(`display:flex; align-items:center; gap:6px; height:29px; padding:0 11px; border-radius:8px; border:1px solid ${active ? 'var(--text)' : 'var(--border-bright)'}; background:${active ? 'var(--text)' : 'transparent'}; color:${active ? 'var(--bg)' : 'var(--text)'}; cursor:pointer; font-family:var(--font-mono); font-size:10.5px; font-weight:600;`)

    return (
      <div className="rk-root" data-theme={S.theme} style={sxd(`height:${this.props.rootHeight || ROOT_HEIGHT}; display:flex; flex-direction:column; background:var(--bg); color:var(--text); font-family:var(--font-sans); overflow:hidden; position:relative;`)} >
        {/* ════ HEADER ════ */}
        <div style={sx('display:flex; align-items:center; gap:14px; height:58px; padding:0 20px; border-bottom:1px solid var(--border); background:var(--surface); flex-shrink:0;')}>
          <button title="Back to matches" onClick={() => this.props.onClose ? this.props.onClose() : this.restart()} className="rk-hbtn" style={sx('width:32px; height:32px; border-radius:9px; border:1px solid var(--border-bright); background:transparent; color:var(--text-mid); cursor:pointer; display:flex; align-items:center; justify-content:center;')}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M10 3L5 8l5 5" /></svg>
          </button>
          <div style={sx('width:30px; height:30px; border-radius:9px; background:var(--surface2); border:1px solid var(--border); display:flex; align-items:center; justify-content:center; font-family:var(--font-mono); font-weight:600; font-size:13px; color:var(--text-mid); flex:none;')}>{(this.props.company || 'D').slice(0, 1).toUpperCase()}</div>
          <div style={sx('min-width:0;')}>
            <div style={sx('font-family:var(--font-mono); font-size:10px; font-weight:600; letter-spacing:0.12em; color:var(--text-dim); text-transform:uppercase;')}>{this.props.company || 'Databricks'}</div>
            <div style={sx('font-size:15px; font-weight:600; letter-spacing:-0.01em; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;')}>{this.props.role || 'Systems PhD — Software Engineer'}</div>
          </div>
          <div style={{ flex: 1 }} />
          <div style={sx('display:flex; align-items:center; gap:8px;')}>
            <span style={sx('display:flex; align-items:center; gap:7px; font-family:var(--font-mono); font-size:11px; color:var(--text-mid); background:var(--chip-bg); border:1px solid var(--chip-border); border-radius:20px; padding:5px 12px;')}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: v.statusByStage[S.stage][1], flex: 'none' }} />
              {v.statusByStage[S.stage][0]}
            </span>
            <button onClick={() => this.props.onToggleTheme ? this.props.onToggleTheme() : this.setState({ theme: S.theme === 'light' ? 'dark' : 'light' })} title="Toggle theme" className="rk-hbtn" style={sx('width:32px; height:32px; border-radius:9px; border:1px solid var(--border-bright); background:transparent; color:var(--text-mid); cursor:pointer; display:flex; align-items:center; justify-content:center;')}>
              {S.theme === 'light'
                ? <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><circle cx="8" cy="8" r="3.2" /><path d="M8 1.5v1.8M8 12.7v1.8M1.5 8h1.8M12.7 8h1.8M3.4 3.4l1.3 1.3M11.3 11.3l1.3 1.3M12.6 3.4l-1.3 1.3M4.7 11.3l-1.3 1.3" /></svg>
                : <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M13.5 9.5A6 6 0 0 1 6.5 2.5a6 6 0 1 0 7 7z" /></svg>}
            </button>
          </div>
        </div>

        <div style={sx('flex:1; display:flex; min-height:0;')}>
          {/* ════ LEFT RAIL ════ */}
          <div style={sx('width:300px; flex-shrink:0; background:var(--sidebar-bg); border-right:1px solid var(--border); display:flex; flex-direction:column; min-height:0;')}>
            <div style={sx('flex:1; overflow-y:auto; min-height:0; display:flex; flex-direction:column;')}>
              {/* Stepper */}
              <div style={sx('padding:18px 20px 14px; border-bottom:1px solid var(--hairline);')}>
                <div style={sx('display:flex; flex-direction:column;')}>
                  {v.steps.map((st, i) => (
                    <div key={i} style={sx('display:flex; gap:12px;')}>
                      <div style={sx('display:flex; flex-direction:column; align-items:center; width:22px; flex:none;')}>
                        <div style={{ width: 22, height: 22, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none', background: st.dotBg, border: st.dotBorder, transition: 'all 0.3s var(--ease)' }}>
                          {st.done && <Check stroke="var(--bg)" />}
                          {st.active && <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--accent)', display: 'block' }} />}
                        </div>
                        {st.hasLine && <div style={{ width: 2, flex: 1, minHeight: 14, margin: '3px 0', borderRadius: 2, background: st.lineBg, transition: 'background 0.3s' }} />}
                      </div>
                      <div style={{ paddingBottom: st.padBottom, paddingTop: 2, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: st.weight, color: st.labelColor, letterSpacing: '-0.01em' }}>{st.label}</div>
                        {st.sub && <div style={sx('font-family:var(--font-mono); font-size:10px; color:var(--text-dim); margin-top:2px;')}>{st.sub}</div>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Match score */}
              {S.stage !== 'optimizing' && (
                <div style={sx('padding:16px 20px 14px; border-bottom:1px solid var(--hairline);')}>
                  <div style={sx('display:flex; align-items:center; gap:14px;')}>
                    <div style={sx('position:relative; width:62px; height:62px; flex:none;')}>
                      <svg width="62" height="62" viewBox="0 0 62 62" style={{ display: 'block' }}>
                        <circle cx="31" cy="31" r="26" fill="none" stroke="var(--ring-track)" strokeWidth="5" />
                        <circle cx="31" cy="31" r="26" fill="none" stroke="var(--accent-strong)" strokeWidth="5" strokeLinecap="round" strokeDasharray="163.36" strokeDashoffset={163.36 * (1 - S.score / 100)} transform="rotate(-90 31 31)" style={{ transition: 'stroke-dashoffset 0.5s var(--ease)' }} />
                      </svg>
                      <div style={sx('position:absolute; inset:0; display:flex; align-items:center; justify-content:center; font-family:var(--font-mono); font-weight:700; font-size:14px; color:var(--text);')}>{S.score}%</div>
                    </div>
                    <div style={sx('min-width:0;')}>
                      <div style={sx('font-size:13.5px; font-weight:700; display:flex; align-items:center; gap:6px;')}>
                        <span style={sx('width:6px; height:6px; border-radius:50%; background:var(--accent3); flex:none;')} />
                        Excellent match
                      </div>
                      <div style={sx('font-family:var(--font-mono); font-size:10.5px; color:var(--text-dim); margin-top:3px;')}>{[...this.reqSkills, ...this.prefSkills].filter(s => s.met).length} of {this.reqSkills.length + this.prefSkills.length} keywords matched</div>
                    </div>
                  </div>
                  <div style={{ marginTop: 13 }}>
                    <div style={sx('display:flex; justify-content:space-between; align-items:baseline; margin-bottom:7px;')}>
                      <span style={sx('font-family:var(--font-mono); font-size:9.5px; font-weight:600; letter-spacing:0.1em; text-transform:uppercase; color:var(--text-dim);')}>Required</span>
                      <span style={sx('font-family:var(--font-mono); font-size:10px; color:var(--accent-ink); font-weight:600;')}>{this.reqSkills.filter(s => s.met).length}/{this.reqSkills.length}</span>
                    </div>
                    <div style={sx('display:flex; flex-wrap:wrap; gap:5px;')}>
                      {this.reqSkills.map(v.chip).map((c, i) => (
                        <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, padding: '3.5px 9px', borderRadius: 20, background: c.bg, color: c.color, border: `1px solid ${c.border}` }}><span style={{ fontSize: 9 }}>{c.mark}</span>{c.text}</span>
                      ))}
                    </div>
                    <div style={sx('display:flex; justify-content:space-between; align-items:baseline; margin:12px 0 7px;')}>
                      <span style={sx('font-family:var(--font-mono); font-size:9.5px; font-weight:600; letter-spacing:0.1em; text-transform:uppercase; color:var(--text-dim);')}>Preferred</span>
                      <span style={sx('font-family:var(--font-mono); font-size:10px; color:var(--text-dim); font-weight:600;')}>{this.prefSkills.filter(s => s.met).length}/{this.prefSkills.length}</span>
                    </div>
                    <div style={sx('display:flex; flex-wrap:wrap; gap:5px;')}>
                      {this.prefSkills.map(v.chip).map((c, i) => (
                        <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, padding: '3.5px 9px', borderRadius: 20, background: c.bg, color: c.color, border: `1px solid ${c.border}` }}><span style={{ fontSize: 9 }}>{c.mark}</span>{c.text}</span>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* Skeleton while optimizing */}
              {S.stage === 'optimizing' && (
                <div style={sx('padding:16px 20px; border-bottom:1px solid var(--hairline);')}>
                  <div style={sx('display:flex; align-items:center; gap:14px;')}>
                    <div style={{ width: 62, height: 62, borderRadius: '50%', border: '5px solid var(--ring-track)', flex: 'none', animation: 'rkPulse 1.6s ease-in-out infinite' }} />
                    <div style={{ flex: 1 }}>
                      <div style={{ height: 11, width: '80%', borderRadius: 5, background: 'var(--surface3)', animation: 'rkPulse 1.6s ease-in-out infinite' }} />
                      <div style={{ height: 9, width: '60%', borderRadius: 5, background: 'var(--surface3)', marginTop: 8, animation: 'rkPulse 1.6s ease-in-out infinite 0.2s' }} />
                    </div>
                  </div>
                </div>
              )}

              {/* AI insertions */}
              {S.stage === 'resume' && !S.editing && (
                <div style={sx('padding:15px 20px 16px;')}>
                  <div style={sx('display:flex; justify-content:space-between; align-items:baseline; margin-bottom:8px;')}>
                    <span style={sx('font-family:var(--font-mono); font-size:9.5px; font-weight:600; letter-spacing:0.1em; text-transform:uppercase; color:var(--text-dim);')}>AI insertions</span>
                    <span style={sx('font-family:var(--font-mono); font-size:10px; color:var(--text-dim);')}>{v.appliedCount}/{this.patches.length} applied</span>
                  </div>
                  <div style={sx('display:flex; flex-direction:column; gap:6px;')}>
                    {v.patchList.map(p => (
                      <div key={p.id} onMouseEnter={p.onEnter} onMouseLeave={p.onLeave} onClick={p.onCardClick}
                        style={{ border: `1px solid ${p.rejected ? 'var(--border)' : 'var(--border-bright)'}`, borderRadius: 10, padding: '8px 10px', background: p.rejected ? 'transparent' : 'var(--surface)', transition: 'border-color 0.15s, box-shadow 0.15s', cursor: 'default', boxShadow: S.hoverPatch === p.id && !p.rejected ? 'inset 0 0 0 1px var(--added-text)' : 'none' }}>
                        <div style={{ fontSize: 11.5, lineHeight: 1.45, color: p.rejected ? 'var(--text-dim)' : 'var(--text)', textDecoration: p.rejected ? 'line-through' : 'none' }}>
                          <span style={{ background: p.rejected ? 'transparent' : 'var(--added-bg)', color: p.rejected ? 'var(--text-dim)' : 'var(--added-text)', borderRadius: 3, padding: '0 3px', fontWeight: 600 }}>{p.shown}</span>
                          <span style={{ color: 'var(--text-dim)' }}> — {p.context}</span>
                        </div>
                        <div style={sx('display:flex; justify-content:space-between; align-items:center; margin-top:6px;')}>
                          <span style={sx('font-family:var(--font-mono); font-size:9px; color:var(--accent-ink); background:var(--accent-soft); border-radius:5px; padding:1px 6px;')}>{p.req}</span>
                          <button onClick={e => { e.stopPropagation(); p.onToggle() }} style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, color: p.rejected ? 'var(--added-text)' : 'var(--danger)', background: 'transparent', border: `1px solid ${p.rejected ? 'var(--accent-line)' : 'var(--border-bright)'}`, borderRadius: 20, padding: '2px 9px', cursor: 'pointer', lineHeight: 1.6 }}>{p.rejected ? 'Restore' : 'Undo'}</button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <div style={{ flex: 1 }} />
            </div>

            {/* Rail actions */}
            <div style={sx('padding:14px 20px 16px; border-top:1px solid var(--border); flex-shrink:0; background:var(--sidebar-bg);')}>
              {S.stage === 'resume' && S.editing && (
                <div style={sx('display:flex; gap:8px;')}>
                  <button className="rk-hbtn" onClick={() => this.setState({ editing: false, manualEdits: S.editSnapshot || {}, editSnapshot: null, drag: null, selBar: null, linkMode: false })} style={sx('flex:1; font-size:12.5px; font-weight:600; padding:10px 0; border-radius:10px; border:1px solid var(--border-bright); background:transparent; color:var(--text-mid); cursor:pointer;')}>Cancel</button>
                  <button onClick={() => this.setState({ editing: false, editSnapshot: null, selBar: null, linkMode: false })} style={sx('flex:1; font-size:12.5px; font-weight:600; padding:10px 0; border-radius:10px; border:none; background:var(--text); color:var(--bg); cursor:pointer;')}>Save changes</button>
                </div>
              )}
              {S.stage === 'resume' && !S.editing && (
                <>
                  <div style={sx('display:flex; align-items:center; justify-content:space-between; margin-bottom:11px;')}>
                    <span style={sx("font-family:var(--font-mono); font-size:10.5px; color:var(--text-dim);")}>How's this resume?</span>
                    <div style={sx('display:flex; gap:6px;')}>
                      {['up', 'down'].map(dir => (
                        <button key={dir} onClick={() => this.setState({ feedback: S.feedback === dir ? null : dir })}
                          style={{ width: 27, height: 27, borderRadius: 8, border: `1px solid ${S.feedback === dir ? 'var(--accent-line)' : 'var(--border-bright)'}`, background: S.feedback === dir ? 'var(--accent-soft)' : 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-mid)' }}>
                          <svg width="13" height="13" viewBox="0 0 16 16" fill={S.feedback === dir ? 'var(--accent)' : 'none'} stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" style={dir === 'down' ? { transform: 'rotate(180deg)' } : undefined}><path d="M4.5 7v7h-2a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h2zm0 0l3-5.5a1.5 1.5 0 0 1 1.4 1.9L8.3 6H13a1.5 1.5 0 0 1 1.4 2l-1.8 5a1.5 1.5 0 0 1-1.4 1H4.5" /></svg>
                        </button>
                      ))}
                    </div>
                  </div>
                  <div style={sx('display:flex; gap:8px; margin-bottom:9px;')}>
                    <button className="rk-hbtn" onClick={() => this.setState({ editing: true, editSnapshot: { ...S.manualEdits }, popover: null })} style={sx('flex:1; display:flex; align-items:center; justify-content:center; gap:7px; font-size:12.5px; font-weight:600; padding:10px 0; border-radius:10px; border:1px solid var(--border-bright); background:var(--surface); color:var(--text); cursor:pointer;')}>
                      <PencilIcon size={12} /> Edit
                    </button>
                    <button className="rk-hbtn" onClick={() => this.downloadResume()} style={sx('flex:1; display:flex; align-items:center; justify-content:center; gap:7px; font-size:12.5px; font-weight:600; padding:10px 0; border-radius:10px; border:1px solid var(--border-bright); background:var(--surface); color:var(--text); cursor:pointer;')}>
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M8 2v8m0 0l-3-3m3 3l3-3M2.5 13.5h11" /></svg>
                      PDF
                    </button>
                  </div>
                  <button className="rk-abtn" onClick={() => { if (!S.approving) this.approveResume() }} style={{ ...sx('width:100%; display:flex; align-items:center; justify-content:center; gap:8px; font-size:13.5px; font-weight:700; padding:12px 0; border-radius:11px; border:none; background:var(--accent); color:var(--accent-contrast); cursor:pointer; letter-spacing:-0.01em;'), opacity: S.approving ? 0.55 : 1 }}>
                    {S.approving ? 'Approving…' : <>Approve resume <ArrowIcon /></>}
                  </button>
                </>
              )}
              {S.stage === 'cover' && (
                <>
                  <div style={sx('display:flex; gap:8px; margin-bottom:9px;')}>
                    <button className="rk-hbtn" onClick={() => { if (!S.coverActive) this.startCover() }} style={{ ...sx('flex:1; display:flex; align-items:center; justify-content:center; gap:7px; font-size:12.5px; font-weight:600; padding:10px 0; border-radius:10px; border:1px solid var(--border-bright); background:var(--surface); color:var(--text); cursor:pointer;'), opacity: S.coverActive ? 0.45 : 1 }}>
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 1.5v3h-3" /></svg>
                      Regenerate
                    </button>
                    <button className="rk-hbtn" onClick={() => this.setState({ docTab: 'resume' })} style={sx('flex:1; font-size:12.5px; font-weight:600; padding:10px 0; border-radius:10px; border:1px solid var(--border-bright); background:var(--surface); color:var(--text); cursor:pointer;')}>Back to resume</button>
                  </div>
                  <button className="rk-abtn" onClick={() => { if (!S.coverActive) { if (this.props.onSubmit) this.props.onSubmit({ decisions: this.state.decisions, manualEdits: this.state.manualEdits }); this.startSubmit() } }} style={{ ...sx('width:100%; display:flex; align-items:center; justify-content:center; gap:8px; font-size:13.5px; font-weight:700; padding:12px 0; border-radius:11px; border:none; background:var(--accent); color:var(--accent-contrast); cursor:pointer; letter-spacing:-0.01em;'), opacity: S.coverActive ? 0.45 : 1 }}>
                    Approve &amp; submit <ArrowIcon />
                  </button>
                </>
              )}
              {S.stage === 'submitting' && (
                <button disabled style={sx('width:100%; display:flex; align-items:center; justify-content:center; gap:9px; font-size:13.5px; font-weight:700; padding:12px 0; border-radius:11px; border:none; background:var(--surface3); color:var(--text-mid); cursor:default;')}>
                  <Spinner size={12} color="var(--text-dim)" /> Submitting application…
                </button>
              )}
              {S.stage === 'done' && (
                <button onClick={() => this.props.onClose ? this.props.onClose() : this.restart()} style={sx('width:100%; font-size:13.5px; font-weight:700; padding:12px 0; border-radius:11px; border:none; background:var(--text); color:var(--bg); cursor:pointer;')}>Back to matches</button>
              )}
            </div>
          </div>

          {/* ════ CENTER STAGE ════ */}
          <div style={sx('flex:1; display:flex; flex-direction:column; min-width:0; min-height:0; background:var(--desk);')}>
            {S.stage === 'optimizing' && (
              <div style={sx('flex:1; display:flex; align-items:center; justify-content:center; padding:32px;')}>
                <div style={sx('width:420px; background:var(--surface); border:1px solid var(--border); border-radius:18px; box-shadow:var(--card-shadow); padding:30px 30px 26px; animation:rkFadeUp 0.4s var(--ease);')}>
                  <div style={sx('display:flex; align-items:center; gap:14px; margin-bottom:22px;')}>
                    <div style={sx('width:44px; height:44px; border-radius:12px; background:var(--accent-soft); border:1px solid var(--accent-line); display:flex; align-items:center; justify-content:center; flex:none; position:relative; overflow:hidden;')}>
                      <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="var(--accent-ink)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M9 1.5L3 9h4l-1 5.5L12 7H8l1-5.5z" /></svg>
                      <span style={{ position: 'absolute', inset: 0, background: 'linear-gradient(105deg, transparent 30%, rgba(255,255,255,0.35) 50%, transparent 70%)', animation: 'rkSweep 1.4s ease-in-out infinite' }} />
                    </div>
                    <div>
                      <div style={sx('font-size:16px; font-weight:700; letter-spacing:-0.01em;')}>Optimizing your resume</div>
                      <div style={sx('font-family:var(--font-mono); font-size:11px; color:var(--text-dim); margin-top:2px;')}>tailoring to this job description</div>
                    </div>
                  </div>
                  <div style={sx('display:flex; flex-direction:column; gap:11px;')}>
                    {v.logLines.map((ln, i) => (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 11, opacity: ln.idle ? 0.45 : 1, transition: 'opacity 0.35s' }}>
                        <span style={sx('width:18px; height:18px; display:flex; align-items:center; justify-content:center; flex:none;')}>
                          {ln.done && <span style={{ width: 18, height: 18, borderRadius: '50%', background: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', animation: 'rkPop 0.3s var(--ease)' }}><Check size={9} stroke="var(--accent-contrast)" /></span>}
                          {ln.running && <Spinner />}
                          {ln.idle && <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--border-bright)', display: 'block' }} />}
                        </span>
                        <span style={{ fontSize: 13, color: ln.idle ? 'var(--text-dim)' : 'var(--text)', fontWeight: ln.running ? 600 : 400 }}>{ln.text}</span>
                        {ln.badge && <span style={sx('margin-left:auto; font-family:var(--font-mono); font-size:10px; color:var(--accent-ink); background:var(--accent-soft); border-radius:5px; padding:1px 7px;')}>{ln.badge}</span>}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {(S.stage === 'resume' || S.stage === 'cover') && (
              <div style={sx('flex:1; display:flex; flex-direction:column; min-height:0;')}>
                {/* Doc top bar */}
                <div style={sx('display:flex; align-items:center; gap:8px; padding:10px 18px; border-bottom:1px solid var(--border); background:var(--surface); flex-shrink:0; position:relative; z-index:10;')}>
                  <div style={sx('display:flex; gap:4px; background:var(--surface2); border:1px solid var(--border); border-radius:11px; padding:3px;')}>
                    {v.docTabs.map(t => (
                      <button key={t.key} onClick={t.onClick} disabled={t.disabled}
                        style={{ fontSize: 12, fontWeight: 600, padding: '6px 14px', borderRadius: 8, border: 'none', cursor: t.enabled ? 'pointer' : 'not-allowed', background: t.active ? 'var(--surface)' : 'transparent', color: t.active ? 'var(--text)' : 'var(--text-mid)', opacity: t.enabled ? 1 : 0.45, transition: 'all 0.15s', fontFamily: 'var(--font-sans)' }}>{t.label}</button>
                    ))}
                  </div>
                  <div style={{ flex: 1 }} />
                  <div style={sx('display:flex; align-items:center; gap:5px;')}>
                    <button className="rk-hbtn" onClick={() => {
                      if (S.docTab === 'cover') return this.setState({ coverFont: Math.max(S.coverFont - 0.5, 10) })
                      this.setState({ fontSize: Math.max(S.fontSize - 0.5, 8) })
                    }} title="Smaller text" style={sx('width:29px; height:29px; border-radius:8px; border:1px solid var(--border-bright); background:transparent; color:var(--text); cursor:pointer; font-family:var(--font-mono); font-size:10px; display:flex; align-items:center; justify-content:center;')}>A−</button>
                    <span style={sx('font-family:var(--font-mono); font-size:10.5px; color:var(--text-dim); min-width:32px; text-align:center;')}>
                      {S.docTab === 'cover' ? S.coverFont.toFixed(1) : (S.fit && !S.editing ? S.effFont.toFixed(1) : S.fontSize.toFixed(1))}
                    </span>
                    <button className="rk-hbtn" onClick={() => {
                      if (S.docTab === 'cover') return this.setState({ coverFont: Math.min(S.coverFont + 0.5, 16) })
                      if (S.fit && !S.editing && S.effFont < S.fontSize) return this.toast('Page is full at ' + S.effFont.toFixed(1) + 'pt — tighten spacing or margins to grow further')
                      this.setState({ fontSize: Math.min(S.fontSize + 0.5, 14) })
                    }} title="Larger text" style={sx('width:29px; height:29px; border-radius:8px; border:1px solid var(--border-bright); background:transparent; color:var(--text); cursor:pointer; font-family:var(--font-mono); font-size:11px; display:flex; align-items:center; justify-content:center;')}>A+</button>
                  </div>
                  <div style={sx('width:1px; height:20px; background:var(--border); margin:0 5px;')} />
                  <button onClick={() => this.setState({ marginsOpen: !S.marginsOpen, spacingOpen: false })} title="Page margins" style={smallBtn(S.marginsOpen)}>
                    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"><rect x="1.5" y="1.5" width="13" height="13" rx="1" /><rect x="4.5" y="4.5" width="7" height="7" strokeDasharray="2 1.6" /></svg>
                    Margins
                  </button>
                  {S.docTab === 'resume' && (
                    <>
                      <button onClick={() => this.setState({ spacingOpen: !S.spacingOpen, marginsOpen: false })} title="Line & paragraph spacing" style={smallBtn(S.spacingOpen)}>
                        <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3h6M8 8h6M8 13h6M3.5 2v12M3.5 2L2 3.5M3.5 2L5 3.5M3.5 14L2 12.5M3.5 14L5 12.5" /></svg>
                        Spacing
                      </button>
                      <button onClick={() => this.setState({ fit: !S.fit })} title="Fit to one page (real reflow)" style={smallBtn(S.fit)}>
                        <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="2.5" y="1.5" width="11" height="13" rx="1" /><path d="M5.5 11l2.5-2.5L10.5 11M8 8.5v4" /></svg>
                        1 page
                      </button>
                      <button onClick={() => this.setState({ align: S.align === 'justify' ? 'left' : 'justify' })} title="Justify text" style={{ ...smallBtn(S.align === 'justify'), width: 29, padding: 0, justifyContent: 'center' }}>
                        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M2 3h12M2 6.3h12M2 9.6h12M2 13h8" /></svg>
                      </button>
                    </>
                  )}
                  <div style={sx('width:1px; height:20px; background:var(--border); margin:0 5px;')} />
                  <button onClick={() => {
                    if (S.docTab === 'cover') return this.setState({ coverEditing: !S.coverEditing, selBar: null, linkMode: false })
                    S.editing ? this.setState({ editing: false, editSnapshot: null, selBar: null, linkMode: false }) : this.setState({ editing: true, editSnapshot: { ...S.manualEdits }, popover: null })
                  }} title="Edit document" style={{ ...smallBtn(activeE), fontFamily: 'var(--font-sans)', fontSize: 11.5 }}>
                    <PencilIcon /> {activeE ? 'Done' : 'Edit'}
                  </button>

                  {/* Spacing panel */}
                  {S.spacingOpen && (
                    <div style={sx('position:absolute; right:16px; top:46px; z-index:30; width:252px; background:var(--surface); border:1px solid var(--border-bright); border-radius:13px; box-shadow:var(--card-shadow); padding:14px 15px; animation:rkFadeUp 0.18s var(--ease);')}>
                      <div style={sx('display:flex; justify-content:space-between; align-items:center; margin-bottom:13px;')}>
                        <span style={sx('font-family:var(--font-mono); font-size:9.5px; font-weight:600; letter-spacing:0.1em; text-transform:uppercase; color:var(--text-dim);')}>Spacing</span>
                        <button onClick={() => this.setState({ lineGap: 1.38, gapScale: 1.0 })} style={sx('font-family:var(--font-mono); font-size:9.5px; color:var(--text-mid); background:transparent; border:1px solid var(--border-bright); border-radius:20px; padding:2px 9px; cursor:pointer;')}>Reset</button>
                      </div>
                      <div style={sx('display:flex; justify-content:space-between; align-items:baseline; margin-bottom:6px;')}>
                        <span style={sx('font-size:12px; font-weight:600; color:var(--text-mid);')}>Line spacing</span>
                        <span style={sx('font-family:var(--font-mono); font-size:10.5px; color:var(--text);')}>{S.lineGap.toFixed(2)}</span>
                      </div>
                      <input type="range" min="1.12" max="1.75" step="0.02" value={S.lineGap} onChange={e => this.setState({ lineGap: parseFloat(e.target.value) })} style={sx('width:100%; accent-color:var(--accent-strong); cursor:pointer; margin:0 0 14px; display:block;')} />
                      <div style={sx('display:flex; justify-content:space-between; align-items:baseline; margin-bottom:6px;')}>
                        <span style={sx('font-size:12px; font-weight:600; color:var(--text-mid);')}>Paragraph &amp; section gaps</span>
                        <span style={sx('font-family:var(--font-mono); font-size:10.5px; color:var(--text);')}>{Math.round(S.gapScale * 100)}%</span>
                      </div>
                      <input type="range" min="0.5" max="2" step="0.05" value={S.gapScale} onChange={e => this.setState({ gapScale: parseFloat(e.target.value) })} style={sx('width:100%; accent-color:var(--accent-strong); cursor:pointer; margin:0; display:block;')} />
                      <div style={sx('font-family:var(--font-mono); font-size:9.5px; color:var(--text-dim); margin-top:12px; line-height:1.5;')}>Tighter spacing frees room — with 1 page on, the font can then grow larger.</div>
                    </div>
                  )}

                  {/* Margins panel */}
                  {S.marginsOpen && (
                    <div style={sx('position:absolute; right:16px; top:46px; z-index:30; width:228px; background:var(--surface); border:1px solid var(--border-bright); border-radius:13px; box-shadow:var(--card-shadow); padding:14px 15px; animation:rkFadeUp 0.18s var(--ease);')}>
                      <div style={sx('display:flex; justify-content:space-between; align-items:center; margin-bottom:11px;')}>
                        <span style={sx('font-family:var(--font-mono); font-size:9.5px; font-weight:600; letter-spacing:0.1em; text-transform:uppercase; color:var(--text-dim);')}>Page margins</span>
                        <button onClick={() => this.setState({ margins: { ...DEFAULT_MARGINS } })} style={sx('font-family:var(--font-mono); font-size:9.5px; color:var(--text-mid); background:transparent; border:1px solid var(--border-bright); border-radius:20px; padding:2px 9px; cursor:pointer;')}>Reset</button>
                      </div>
                      <div style={sx('display:flex; flex-direction:column; gap:8px;')}>
                        {['top', 'right', 'bottom', 'left'].map(k => (
                          <div key={k} style={sx('display:flex; align-items:center; gap:8px;')}>
                            <span style={sx('font-size:12px; font-weight:600; width:52px; color:var(--text-mid);')}>{k.charAt(0).toUpperCase() + k.slice(1)}</span>
                            <div style={{ flex: 1 }} />
                            <button className="rk-hbtn" onClick={() => this.setState(s => ({ margins: { ...s.margins, [k]: Math.max(Math.round((s.margins[k] - 0.05) * 100) / 100, 0.3) } }))} style={sx('width:26px; height:26px; border-radius:7px; border:1px solid var(--border-bright); background:transparent; color:var(--text); cursor:pointer; font-family:var(--font-mono); font-size:12px; display:flex; align-items:center; justify-content:center;')}>−</button>
                            <span style={sx('font-family:var(--font-mono); font-size:11.5px; min-width:46px; text-align:center;')}>{S.margins[k].toFixed(2)}"</span>
                            <button className="rk-hbtn" onClick={() => this.setState(s => ({ margins: { ...s.margins, [k]: Math.min(Math.round((s.margins[k] + 0.05) * 100) / 100, 1.25) } }))} style={sx('width:26px; height:26px; border-radius:7px; border:1px solid var(--border-bright); background:transparent; color:var(--text); cursor:pointer; font-family:var(--font-mono); font-size:12px; display:flex; align-items:center; justify-content:center;')}>+</button>
                          </div>
                        ))}
                      </div>
                      <div style={sx('font-family:var(--font-mono); font-size:9.5px; color:var(--text-dim); margin-top:11px; line-height:1.5;')}>Guides show live on the page. Content reflows &amp; repaginates as you adjust.</div>
                    </div>
                  )}
                </div>

                {/* Edit banner — single line: hint truncates, Undo/Redo pinned right */}
                {S.editing && (
                  <div style={sx('display:flex; align-items:center; flex-wrap:nowrap; gap:14px; padding:8px 18px; background:var(--accent-soft); border-bottom:1px solid var(--accent-line); font-family:var(--font-mono); font-size:11px; color:var(--accent-ink); flex-shrink:0; min-width:0;')}>
                    <span style={sx('display:flex; align-items:center; gap:7px; font-weight:600; white-space:nowrap; flex-shrink:0;')}><PencilIcon /> Editing mode</span>
                    <span style={sx('opacity:0.75; flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;')}>click any text to rewrite it · select text to format (bold, italic, link, size) · drag ⠿ to reorder</span>
                    <div style={sx('display:flex; align-items:center; gap:8px; flex-shrink:0;')}>
                      <button className="rk-gbtn" onClick={() => this.undo()} title="Undo last change (⌘Z)" style={{ ...sx('display:flex; align-items:center; gap:6px; height:24px; padding:0 11px; border-radius:20px; border:1px solid var(--accent-line); background:transparent; color:var(--accent-ink); cursor:pointer; font-family:var(--font-mono); font-size:10px; font-weight:600; white-space:nowrap;'), opacity: S.histLen ? 1 : 0.4 }}>
                        <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M6.5 3.5L3 7l3.5 3.5M3 7h7a3.5 3.5 0 0 1 0 7H8" /></svg>
                        Undo{S.histLen ? ' · ' + S.histLen : ''}
                      </button>
                      <button className="rk-gbtn" onClick={() => this.redo()} title="Redo (⇧⌘Z)" style={{ ...sx('display:flex; align-items:center; gap:6px; height:24px; padding:0 11px; border-radius:20px; border:1px solid var(--accent-line); background:transparent; color:var(--accent-ink); cursor:pointer; font-family:var(--font-mono); font-size:10px; font-weight:600; white-space:nowrap;'), opacity: S.redoLen ? 1 : 0.4 }}>
                        <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M9.5 3.5L13 7l-3.5 3.5M13 7H6a3.5 3.5 0 0 0 0 7h2" /></svg>
                        Redo{S.redoLen ? ' · ' + S.redoLen : ''}
                      </button>
                    </div>
                  </div>
                )}

                {/* Scrollable page desk */}
                <div style={sx('flex:1; overflow-y:auto; overflow-x:auto; min-height:0; position:relative;')}>
                  {S.docTab === 'resume' && this.buildResumeSurface()}
                  {S.docTab === 'cover' && (
                    <div style={{ padding: 28 }}>
                      <div className="rk-page" style={{ ...sx('width:700px; margin:0 auto; min-height:906px; background:#ffffff; border-radius:4px; box-shadow:var(--page-shadow); font-family:var(--font-doc); line-height:1.62; color:#141414; position:relative;'), padding: `${S.margins.top * PPI}px ${S.margins.right * PPI}px ${S.margins.bottom * PPI}px ${S.margins.left * PPI}px`, fontSize: S.coverFont }}>
                        {S.marginsOpen && <div style={{ position: 'absolute', left: S.margins.left * PPI, right: S.margins.right * PPI, top: S.margins.top * PPI, bottom: S.margins.bottom * PPI, border: '1px dashed var(--accent2)', pointerEvents: 'none', zIndex: 1 }} />}
                        <div style={sx('font-weight:700; font-size:1.5em; letter-spacing:-0.01em;')}>Tejas Belakavadi Kemparaju</div>
                        <div style={sx('color:#777; font-size:0.92em; margin-top:3px; padding-bottom:18px; border-bottom:1px solid #e4e2dc; margin-bottom:18px;')}>tejas02bk@gmail.com · 862-214-0129 · linkedin.com/in/tejasbk</div>
                        {S.coverText !== null
                          ? <div contentEditable={coverDone && S.coverEditing} suppressContentEditableWarning className={S.coverEditing ? 'rk-edit-field' : ''}
                              onBlur={e => { const html = e.target.innerHTML; if (html === S.coverText) return; this.pushHist(); this.setState({ coverText: html }) }}
                              style={{ whiteSpace: 'pre-wrap', outline: 'none', borderRadius: 4, cursor: S.coverEditing ? 'text' : 'default' }}
                              dangerouslySetInnerHTML={{ __html: S.coverText }} />
                          : <div contentEditable={coverDone && S.coverEditing} suppressContentEditableWarning className={S.coverEditing ? 'rk-edit-field' : ''}
                              onBlur={e => { const html = e.target.innerHTML; this.pushHist(); this.setState({ coverText: html }) }}
                              style={{ whiteSpace: 'pre-wrap', outline: 'none', borderRadius: 4, cursor: S.coverEditing ? 'text' : 'default' }}>
                              {this.letter.slice(0, S.coverChars)}
                              {S.coverActive && <span style={{ display: 'inline-block', width: 2, height: '1.1em', background: '#141414', verticalAlign: 'text-bottom', animation: 'rkBlink 0.9s step-end infinite' }} />}
                            </div>}
                        {coverDone && <div style={{ marginTop: 20 }}>Sincerely,<br />Tejas Belakavadi Kemparaju</div>}
                      </div>
                    </div>
                  )}
                  {S.docTab === 'jd' && (
                    <div style={sx('padding:28px; display:flex; justify-content:center;')}>
                      <div style={sx('width:100%; max-width:700px; background:var(--surface); border:1px solid var(--border); border-radius:14px; box-shadow:var(--card-shadow); padding:34px 38px; font-size:13px; line-height:1.6; color:var(--text-mid);')}>
                        <div style={sx('font-family:var(--font-mono); font-size:10px; font-weight:600; letter-spacing:0.12em; color:var(--text-dim); text-transform:uppercase;')}>Job description · Databricks</div>
                        <div style={sx('font-size:19px; font-weight:700; color:var(--text); letter-spacing:-0.01em; margin:6px 0 4px;')}>Systems PhD — Software Engineer</div>
                        <div style={sx('font-family:var(--font-mono); font-size:11px; color:var(--text-dim); margin-bottom:18px;')}>Remote · Full-time · Data Platform org</div>
                        <p style={{ margin: '0 0 14px' }}>Databricks is looking for a software engineer to build large-scale data processing and ML-platform services. You'll design ELT/ETL pipelines on the lakehouse, ship production microservices, and work across streaming and batch systems used by thousands of enterprise customers.</p>
                        <div style={sx('font-weight:700; color:var(--text); font-size:12.5px; margin-bottom:8px;')}>Required</div>
                        <ul style={sx('margin:0 0 16px; padding-left:20px; display:flex; flex-direction:column; gap:5px;')}>
                          {['5+ years with Python and PySpark on large-scale data systems', 'Hands-on Databricks lakehouse experience', 'Designing ELT/ETL processes for production workloads', 'Building microservices with FastAPI', 'Streaming systems experience with Kafka'].map((r, i) => <li key={i}>{r}</li>)}
                        </ul>
                        <div style={sx('font-weight:700; color:var(--text); font-size:12.5px; margin-bottom:8px;')}>Preferred</div>
                        <ul style={sx('margin:0; padding-left:20px; display:flex; flex-direction:column; gap:5px;')}>
                          {['Multi-cloud exposure — AWS, Azure, GCP or Cloudera', 'Frontend familiarity (Angular a plus)', 'Publications or PhD-level systems research'].map((r, i) => <li key={i}>{r}</li>)}
                        </ul>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {S.stage === 'submitting' && (
              <div style={sx('flex:1; display:flex; align-items:center; justify-content:center; padding:32px;')}>
                <div style={sx('width:440px; background:var(--surface); border:1px solid var(--border); border-radius:18px; box-shadow:var(--card-shadow); padding:30px 30px 26px; animation:rkFadeUp 0.4s var(--ease);')}>
                  <div style={sx('display:flex; align-items:center; gap:14px; margin-bottom:8px;')}>
                    <div style={sx('width:44px; height:44px; border-radius:12px; background:var(--accent-soft); border:1px solid var(--accent-line); display:flex; align-items:center; justify-content:center; flex:none;')}>
                      <svg width="19" height="19" viewBox="0 0 16 16" fill="none" stroke="var(--accent-ink)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M14.5 1.5L7 9M14.5 1.5l-4.5 13-2.5-5.5L2 6.5l12.5-5z" /></svg>
                    </div>
                    <div>
                      <div style={sx('font-size:16px; font-weight:700; letter-spacing:-0.01em;')}>Applying on Databricks careers</div>
                      <div style={sx('font-family:var(--font-mono); font-size:11px; color:var(--text-dim); margin-top:2px;')}>Rack is filling the application for you</div>
                    </div>
                  </div>
                  <div style={sx('height:5px; border-radius:4px; background:var(--ring-track); margin:16px 0 20px; overflow:hidden;')}>
                    <div style={{ height: '100%', borderRadius: 4, background: 'var(--accent)', width: Math.round(100 * Math.max(S.submitStep, 0) / SUBMIT_STEPS.length) + '%', transition: 'width 0.6s var(--ease)' }} />
                  </div>
                  <div style={sx('display:flex; flex-direction:column; gap:11px;')}>
                    {v.submitRows.map((ln, i) => (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 11, opacity: ln.idle ? 0.45 : 1, transition: 'opacity 0.35s' }}>
                        <span style={sx('width:18px; height:18px; display:flex; align-items:center; justify-content:center; flex:none;')}>
                          {ln.done && <span style={{ width: 18, height: 18, borderRadius: '50%', background: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', animation: 'rkPop 0.3s var(--ease)' }}><Check size={9} stroke="var(--accent-contrast)" /></span>}
                          {ln.running && <Spinner />}
                          {ln.idle && <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--border-bright)', display: 'block' }} />}
                        </span>
                        <span style={{ fontSize: 13, color: ln.idle ? 'var(--text-dim)' : 'var(--text)', fontWeight: ln.running ? 600 : 400 }}>{ln.text}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {S.stage === 'done' && (
              <div style={sx('flex:1; display:flex; align-items:center; justify-content:center; padding:32px;')}>
                <div style={sx('width:440px; background:var(--surface); border:1px solid var(--border); border-radius:18px; box-shadow:var(--card-shadow); padding:38px 34px 30px; text-align:center; animation:rkFadeUp 0.4s var(--ease);')}>
                  <div style={sx('width:58px; height:58px; border-radius:50%; background:var(--accent); display:flex; align-items:center; justify-content:center; margin:0 auto 18px; animation:rkPop 0.45s var(--ease);')}>
                    <Check size={26} stroke="var(--accent-contrast)" width={2.2} />
                  </div>
                  <div style={sx('font-size:19px; font-weight:700; letter-spacing:-0.01em;')}>Application submitted</div>
                  <div style={sx('font-size:13px; color:var(--text-mid); margin:7px 0 22px; line-height:1.55;')}>Your optimized resume and cover letter went to <b style={{ color: 'var(--text)' }}>Databricks</b>. We'll track the reply in your inbox and tracker.</div>
                  <div style={sx('display:grid; grid-template-columns:1fr 1fr 1fr; gap:8px; margin-bottom:22px;')}>
                    {[[S.score + '%', 'Match', 'var(--accent-ink)'], [String(v.appliedCount), 'Keywords', 'var(--text)'], ['18s', 'Fill time', 'var(--text)']].map(([val, lab, col], i) => (
                      <div key={i} style={sx('border:1px solid var(--border); border-radius:11px; padding:11px 8px; background:var(--surface2);')}>
                        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 16, fontWeight: 700, color: col }}>{val}</div>
                        <div style={sx('font-family:var(--font-mono); font-size:9px; color:var(--text-dim); letter-spacing:0.08em; text-transform:uppercase; margin-top:2px;')}>{lab}</div>
                      </div>
                    ))}
                  </div>
                  <div style={sx('display:flex; gap:8px;')}>
                    <button className="rk-hbtn" style={sx('flex:1; font-size:12.5px; font-weight:600; padding:11px 0; border-radius:10px; border:1px solid var(--border-bright); background:transparent; color:var(--text); cursor:pointer;')}>Open tracker</button>
                    <button onClick={() => this.restart()} style={sx('flex:1; font-size:12.5px; font-weight:700; padding:11px 0; border-radius:10px; border:none; background:var(--text); color:var(--bg); cursor:pointer;')}>Next match</button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Selection format bubble */}
        {!!S.selBar && (S.editing || S.coverEditing) && (
          <div className="rk-selbar" onMouseDown={e => { if (e.target && e.target.tagName === 'INPUT') return; e.preventDefault() }}
            style={{ ...sx('position:fixed; z-index:60; display:flex; align-items:center; gap:2px; background:var(--text); color:var(--bg); border-radius:11px; padding:5px 6px; box-shadow:0 4px 18px rgba(0,0,0,0.28); animation:rkFadeUp 0.15s var(--ease);'), left: S.selBar.x, top: Math.max(S.selBar.y, 70), transform: 'translate(-50%, calc(-100% - 10px))' }}>
            {!S.linkMode ? (
              <>
                <button className="rk-dbtn" onClick={() => this.fmt('bold')} title="Bold" style={sx('width:27px; height:27px; border-radius:8px; border:none; background:transparent; color:var(--bg); cursor:pointer; font-family:var(--font-doc); font-weight:800; font-size:13px;')}>B</button>
                <button className="rk-dbtn" onClick={() => this.fmt('italic')} title="Italic" style={sx('width:27px; height:27px; border-radius:8px; border:none; background:transparent; color:var(--bg); cursor:pointer; font-family:var(--font-doc); font-style:italic; font-weight:600; font-size:13px;')}>I</button>
                <button className="rk-dbtn" onClick={() => this.openLink()} title="Add link" style={sx('width:27px; height:27px; border-radius:8px; border:none; background:transparent; color:var(--bg); cursor:pointer; display:flex; align-items:center; justify-content:center;')}>
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M6.5 9.5a3 3 0 0 0 4.2.2l2-2a3 3 0 1 0-4.2-4.2l-1 1M9.5 6.5a3 3 0 0 0-4.2-.2l-2 2a3 3 0 1 0 4.2 4.2l1-1" /></svg>
                </button>
                <span style={sx('width:1px; height:16px; background:rgba(128,128,128,0.45); margin:0 3px;')} />
                <button className="rk-dbtn" onClick={() => this.selFontDelta(-0.5)} title="Shrink selected text" style={sx('height:27px; padding:0 8px; border-radius:8px; border:none; background:transparent; color:var(--bg); cursor:pointer; font-family:var(--font-mono); font-size:10px;')}>A−</button>
                <span title="Selection font size" style={sx('font-family:var(--font-mono); font-size:10px; min-width:34px; text-align:center; opacity:0.85;')}>{S.selPx ? S.selPx.toFixed(1) : ''}</span>
                <button className="rk-dbtn" onClick={() => this.selFontDelta(0.5)} title="Grow selected text" style={sx('height:27px; padding:0 8px; border-radius:8px; border:none; background:transparent; color:var(--bg); cursor:pointer; font-family:var(--font-mono); font-size:12px;')}>A+</button>
              </>
            ) : (
              <>
                <input value={S.linkUrl} onChange={e => this.setState({ linkUrl: e.target.value })}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); this.applyLink() } if (e.key === 'Escape') this.setState({ linkMode: false, linkUrl: '' }) }}
                  placeholder="Paste or type a URL…" autoFocus
                  style={sx('width:180px; height:25px; border:none; outline:none; background:transparent; color:var(--bg); font-family:var(--font-mono); font-size:11px; padding:0 6px;')} />
                <button onClick={() => this.applyLink()} title="Apply link" style={sx('height:25px; padding:0 10px; border-radius:7px; border:none; background:var(--accent); color:var(--accent-contrast); cursor:pointer; font-family:var(--font-mono); font-size:10px; font-weight:700;')}>Link</button>
                <button className="rk-dbtn" onClick={() => this.setState({ linkMode: false, linkUrl: '' })} title="Cancel" style={sx('width:25px; height:25px; border-radius:7px; border:none; background:transparent; color:var(--bg); cursor:pointer; font-size:12px;')}>✕</button>
              </>
            )}
          </div>
        )}

        {/* Link popover */}
        {!!S.linkPop && S.editing && (
          <>
            <div onClick={() => this.setState({ linkPop: null })} style={sx('position:fixed; inset:0; z-index:58;')} />
            <div style={{ ...sx('position:fixed; z-index:59; background:var(--surface); border:1px solid var(--border-bright); border-radius:12px; box-shadow:var(--card-shadow); padding:9px 10px; animation:rkFadeUp 0.15s var(--ease); display:flex; align-items:center; gap:8px; max-width:400px;'), left: S.linkPop.x, top: S.linkPop.y, transform: 'translate(-50%, 10px)' }}>
              {!S.linkPop.editing ? (
                <>
                  <a href={S.linkPop.href} target="_blank" rel="noreferrer" title={S.linkPop.href} style={sx('display:flex; align-items:center; gap:6px; font-family:var(--font-mono); font-size:10.5px; color:var(--accent-ink); text-decoration:none; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:200px;')}>
                    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ flex: 'none' }}><path d="M9 7l5-5m0 0h-3.5M14 2v3.5M12 9.5V13a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3.5" /></svg>
                    {S.linkPop.href.length > 36 ? S.linkPop.href.slice(0, 34) + '…' : S.linkPop.href}
                  </a>
                  <span style={sx('width:1px; height:16px; background:var(--border);')} />
                  <button className="rk-hbtn" onClick={() => this.setState({ linkPop: { ...S.linkPop, editing: true }, linkEditVal: S.linkPop.href })} style={sx('font-family:var(--font-mono); font-size:10px; font-weight:600; color:var(--text); background:transparent; border:1px solid var(--border-bright); border-radius:7px; padding:4px 10px; cursor:pointer;')}>Edit</button>
                  <button className="rk-hbtn" onClick={() => {
                    const a = this._linkEl
                    if (a && a.parentNode) {
                      const fieldEl = a.closest('.rk-edit-field')
                      while (a.firstChild) a.parentNode.insertBefore(a.firstChild, a)
                      a.remove()
                      if (fieldEl) this.commitFieldEl(fieldEl)
                    }
                    this.setState({ linkPop: null })
                  }} style={sx('font-family:var(--font-mono); font-size:10px; font-weight:600; color:var(--danger); background:transparent; border:1px solid var(--border-bright); border-radius:7px; padding:4px 10px; cursor:pointer;')}>Remove</button>
                </>
              ) : (
                <>
                  <input value={S.linkEditVal} onChange={e => this.setState({ linkEditVal: e.target.value })}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); this.applyLinkPop() } if (e.key === 'Escape') this.setState({ linkPop: null }) }}
                    autoFocus placeholder="https://…"
                    style={sx('width:210px; height:26px; border:1px solid var(--border-bright); border-radius:7px; outline:none; background:var(--surface2); color:var(--text); font-family:var(--font-mono); font-size:10.5px; padding:0 8px;')} />
                  <button onClick={() => this.applyLinkPop()} style={sx('height:26px; padding:0 11px; border-radius:7px; border:none; background:var(--text); color:var(--bg); cursor:pointer; font-family:var(--font-mono); font-size:10px; font-weight:700;')}>Save</button>
                  <button onClick={() => this.setState({ linkPop: null })} style={sx('width:26px; height:26px; border-radius:7px; border:1px solid var(--border-bright); background:transparent; color:var(--text-mid); cursor:pointer; font-size:11px;')}>✕</button>
                </>
              )}
            </div>
          </>
        )}

        {/* AI-insertion popover */}
        {!!(S.popover && v.popPatch) && (
          <>
            <div onClick={() => this.setState({ popover: null })} style={sx('position:fixed; inset:0; z-index:40;')} />
            <div style={{ ...sx('position:fixed; z-index:41; width:264px; background:var(--surface); border:1px solid var(--border-bright); border-radius:13px; box-shadow:var(--card-shadow); padding:13px 14px; animation:rkFadeUp 0.18s var(--ease);'), left: Math.min(S.popover.x, vw - 290), top: Math.min(S.popover.y + 14, vh - 220) }}>
              <div style={sx('font-family:var(--font-mono); font-size:9px; font-weight:600; letter-spacing:0.1em; text-transform:uppercase; color:var(--accent-ink); margin-bottom:6px;')}>AI insertion · {v.popPatch.req}</div>
              <div style={sx('font-size:12px; line-height:1.5; margin-bottom:4px;')}><span style={sx('background:var(--added-bg); color:var(--added-text); border-radius:3px; padding:0 3px; font-weight:600;')}>{v.popPatch.shown || v.popPatch.text.trim()}</span></div>
              <div style={sx('font-size:11px; color:var(--text-mid); line-height:1.5; margin-bottom:11px;')}>{v.popPatch.reason}</div>
              <div style={sx('display:flex; gap:7px;')}>
                <button onClick={() => { if (this.props.onDecisionChange) this.props.onDecisionChange(v.popPatch.id, 'rejected'); this.setState(s => ({ decisions: { ...s.decisions, [v.popPatch.id]: 'rejected' }, popover: null })) }} style={sx('flex:1; font-family:var(--font-mono); font-size:10.5px; padding:7px 0; border-radius:8px; border:1px solid var(--border-bright); background:transparent; color:var(--danger); cursor:pointer;')}>Remove</button>
                <button onClick={() => this.setState({ popover: null })} style={sx('flex:1; font-family:var(--font-mono); font-size:10.5px; font-weight:600; padding:7px 0; border-radius:8px; border:none; background:var(--text); color:var(--bg); cursor:pointer;')}>Keep</button>
              </div>
            </div>
          </>
        )}

        {/* Toast */}
        {!!S.toast && (
          <div style={sx('position:fixed; bottom:24px; left:50%; transform:translateX(-50%); z-index:50; display:flex; align-items:center; gap:9px; background:var(--text); color:var(--bg); border-radius:11px; padding:11px 18px; font-size:12.5px; font-weight:600; box-shadow:var(--card-shadow); animation:rkFadeUp 0.25s var(--ease);')}>
            <Check size={13} stroke="currentColor" width={2.2} />
            {S.toast}
          </div>
        )}
      </div>
    )
  }

  restart() {
    this._timers.forEach(x => { clearTimeout(x); clearInterval(x) })
    this._timers = []
    this.setState({ stage: 'optimizing', logStep: 0, score: 0, docTab: 'resume', decisions: {}, manualEdits: {}, editing: false, fit: false, pages: null, coverChars: 0, coverActive: false, submitStep: -1, popover: null })
    this.t(() => this.runOptimizing(), 60)
  }
}