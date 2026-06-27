import { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { getAuthHeaders } from "../utils/api";
import { useAuth } from "../context/AuthContext";
import { useTheme } from "../App";
import Sidebar from "../components/Sidebar";

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000'
const API = `${API_BASE}/api/tracking`;
const RESUMES_API = `${API_BASE}/api/resumes`;
const PROFILE_API = `${API_BASE}/api/account`;

/* ── helpers ───────────────────────────────────────────────────── */
function scoreColor(s) {
  if (s >= 70) return "var(--accent3)";
  if (s >= 50) return "var(--accent)";
  if (s >= 30) return "#fbbf24";
  return "var(--danger)";
}

function scoreGradient(s) {
  if (s >= 70) return "linear-gradient(90deg, #34d399, #6ee7b7)";
  if (s >= 50) return "linear-gradient(90deg, #e8ff6b, #a3e635)";
  if (s >= 30) return "linear-gradient(90deg, #fbbf24, #f59e0b)";
  return "linear-gradient(90deg, #f87171, #fb923c)";
}

function recommendationStyle(rec) {
  switch (rec) {
    case "Strong Match": return { background: "rgba(52,211,153,0.12)", color: "#34d399", border: "1px solid rgba(52,211,153,0.25)" };
    case "Good Match":   return { background: "rgba(232,255,107,0.1)", color: "var(--accent)", border: "1px solid rgba(232,255,107,0.22)" };
    case "Partial Match":return { background: "rgba(251,146,60,0.1)", color: "#fb923c", border: "1px solid rgba(251,146,60,0.22)" };
    default:             return { background: "rgba(248,113,113,0.1)", color: "var(--danger)", border: "1px solid rgba(248,113,113,0.22)" };
  }
}

function sourceBadge(source) {
  const map = {
    greenhouse: { c: "var(--accent3)", label: "GREENHOUSE" },
    lever: { c: "#60a5fa", label: "LEVER" },
    remotive: { c: "var(--accent2)", label: "REMOTIVE" },
  };
  const s = map[source] || { c: "var(--text-dim)", label: source?.toUpperCase() || "JOB" };
  return (
    <span style={{
      fontSize: 9, fontWeight: 700, padding: "3px 8px", borderRadius: 20,
      textTransform: "uppercase", letterSpacing: "0.1em",
      background: `${s.c}15`, color: s.c,
    }}>
      {s.label}
    </span>
  );
}

function timeAgo(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    const now = new Date();
    const mins = Math.floor((now - d) / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 7) return `${days}d ago`;
    return d.toLocaleDateString();
  } catch { return ""; }
}

/* ── Resume download helper ─────────────────────────────────────── */
async function downloadResume(resumeId, resumeName, fileExt) {
  if (!resumeId) return;
  try {
    // Step 1: ask backend for a signed URL (requires auth)
    const headers = await getAuthHeaders();
    const resp = await fetch(`${RESUMES_API}/${resumeId}/file`, { headers });
    if (!resp.ok) throw new Error(`Signed URL fetch failed: ${resp.status}`);

    const data = await resp.json();
    // Backend returns { signedURL: "https://..." } or { signed_url: "..." }
    const signedUrl = data.signedURL || data.signed_url || data.url;
    if (!signedUrl) throw new Error("No signed URL in response");

    // Step 2: fetch the actual file bytes from Supabase Storage
    // Pre-signed URLs don't need an auth header
    const fileResp = await fetch(signedUrl);
    if (!fileResp.ok) throw new Error(`File fetch failed: ${fileResp.status}`);

    const blob = await fileResp.blob();
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objectUrl;
    // Reconstruct filename: display_name already includes the extension in most cases,
    // but fall back to appending fileExt if it's not already there.
    const baseName = resumeName || "resume";
    const ext = fileExt ? `.${fileExt}` : "";
    const hasExt = fileExt && baseName.toLowerCase().endsWith(ext.toLowerCase());
    a.download = hasExt ? baseName : `${baseName}${ext}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(objectUrl);
  } catch (e) {
    console.error("Resume download error:", e);
  }
}

/* ══════════════════════════════════════════════════════════════════
   TAB BAR — subtle two-tab switcher
   ══════════════════════════════════════════════════════════════════ */
/* ══════════════════════════════════════════════════════════════════
   TAB SWITCHER — sidebar-integrated vertical nav
   ══════════════════════════════════════════════════════════════════ */
function TabSwitcher({ activeTab, onSwitch, autoCount, freshCount, customCount, appliedCount, reviewCount, isPowerUser }) {
  const allTabs = [
    { id: "auto",    label: "Auto Matches",  icon: <svg width={15} height={15} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="5" height="5" rx="1.4"/><rect x="9" y="2" width="5" height="5" rx="1.4"/><rect x="2" y="9" width="5" height="5" rx="1.4"/><rect x="9" y="9" width="5" height="5" rx="1.4"/></svg>, count: autoCount, power: false },
    { id: "review",  label: "Review",        icon: <svg width={15} height={15} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><circle cx="8" cy="8" r="6"/><path d="M8 5v3.5l2 1.5"/></svg>, count: reviewCount,  power: false },
    { id: "applied", label: "Applied",        icon: <svg width={15} height={15} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M3 8.5l3.5 3.5L13 4.5"/></svg>, count: appliedCount, power: false },
    { id: "fresh",   label: "Fresh Jobs",    icon: <svg width={15} height={15} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M8 2v2M8 12v2M2 8h2M12 8h2M4.2 4.2l1.4 1.4M10.4 10.4l1.4 1.4M4.2 11.8l1.4-1.4M10.4 5.6l1.4-1.4"/></svg>, count: freshCount,   power: true  },
    { id: "custom",  label: "Search",        icon: <svg width={15} height={15} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><circle cx="7" cy="7" r="5"/><path d="M11 11l3.5 3.5"/></svg>, count: customCount,  power: true  },
  ];
  const tabs = allTabs.filter(t => !t.power || isPowerUser);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {tabs.map((tab) => {
        const active = activeTab === tab.id;
        return (
          <SideTabItem
            key={tab.id}
            icon={tab.icon}
            label={tab.label}
            count={tab.count}
            active={active}
            onClick={() => onSwitch(tab.id)}
          />
        );
      })}
    </div>
  );
}

function SideTabItem({ icon, label, count, active, onClick }) {
  const [hov, setHov] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '9px 12px', borderRadius: 10, cursor: 'pointer',
        border: active ? '1px solid var(--accent-line)' : '1px solid transparent',
        background: active ? 'var(--accent-soft)' : hov ? 'var(--surface2)' : 'transparent',
        color: active ? 'var(--text)' : hov ? 'var(--text)' : 'var(--text-mid)',
        fontFamily: "'DM Sans', sans-serif", fontSize: 13, fontWeight: active ? 600 : 500,
        textAlign: 'left', width: '100%',
        transition: 'background 0.15s, color 0.12s, border-color 0.15s',
      }}
    >
      <span style={{ color: active ? 'var(--accent-ink)' : 'inherit', display: 'flex', flexShrink: 0 }}>
        {icon}
      </span>
      <span style={{ flex: 1 }}>{label}</span>
      {count > 0 && (
        <span style={{
          fontFamily: "'Fira Code', monospace", fontSize: 10, fontWeight: 600,
          color: active ? 'var(--accent-ink)' : 'var(--text-dim)',
          background: active ? 'var(--accent-soft)' : 'var(--chip-bg)',
          border: active ? '1px solid var(--accent-line)' : '1px solid transparent',
          padding: '1px 7px', borderRadius: 20, lineHeight: '16px',
        }}>{count}</span>
      )}
    </button>
  );
}

/* ══════════════════════════════════════════════════════════════════
   MATCH CARD — shared between both tabs
   ══════════════════════════════════════════════════════════════════ */
function MatchCard({ match, index, expanded, onToggle, isAuto, isApplied, onApply, isNew, isSaved, onSave }) {
  const displayScore = match.llm_score ?? match.score ?? 0;
  const sc = scoreColor(displayScore);
  const pct = Math.min(displayScore, 100);
  const [downloading, setDownloading] = useState(false);

  const handleDownload = async (e) => {
    e.stopPropagation();
    if (!match.resume_id || downloading) return;
    setDownloading(true);
    await downloadResume(match.resume_id, match.resume_name, match.file_ext);
    setDownloading(false);
  };

  return (
    <div
      onClick={onToggle}
      style={{
        background: "var(--surface)",
        border: isNew
          ? "1px solid rgba(232,255,107,0.22)"
          : expanded ? "1px solid var(--border-bright)" : "1px solid var(--border)",
        borderLeft: isNew ? "3px solid var(--accent)" : undefined,
        borderRadius: 16, padding: 0, marginBottom: 6, cursor: "pointer",
        transition: "border 0.2s", overflow: "hidden",
        opacity: 0,
        animation: `fadeUp 0.4s ease ${Math.min(index * 0.04, 0.3)}s forwards`,
      }}
    >
      {/* Score bar top accent */}
      <div style={{
        height: 3, background: scoreGradient(match.score),
        width: `${pct}%`, transition: "width 0.8s cubic-bezier(0.22,1,0.36,1)",
      }} />

      <div style={{ padding: "14px 18px" }}>
        {/* Row 1: Score | divider | title+meta | actions */}
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>

          {/* Score — primary focal point, no index badge, no scaleY */}
          <div style={{ flexShrink: 0, width: 52, textAlign: "left" }}>
            <div style={{
              fontFamily: "var(--font-display)", fontSize: 22, fontWeight: 500,
              color: "var(--text)", letterSpacing: "-0.02em", lineHeight: 1,
            }}>
              {match.llm_score ?? match.score}<span style={{ color: "var(--text-dim)", fontSize: 13, fontWeight: 400 }}>%</span>
            </div>
            {match.llm_recommendation === "Strong Match" && (
              <div style={{
                fontFamily: "var(--font-display)", fontSize: 9, fontWeight: 500, marginTop: 4,
                color: "var(--accent3)", letterSpacing: "0.1em", textTransform: "uppercase",
              }}>● strong</div>
            )}
          </div>

          {/* Vertical divider */}
          <div style={{ width: 1, alignSelf: "stretch", background: "var(--border)", flexShrink: 0 }} />

          {/* Title + meta */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{
              fontFamily: "var(--font-body)", fontSize: 15, fontWeight: 500,
              color: "var(--text)", letterSpacing: "-0.01em",
              display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
            }}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {match.job_title}
              </span>
              {isNew && (
                <span style={{
                  fontFamily: "var(--font-display)", fontSize: 9, fontWeight: 500,
                  color: "var(--accent)", letterSpacing: "0.12em", textTransform: "uppercase",
                  flexShrink: 0,
                }}>new</span>
              )}
              {isApplied && (
                <span style={{
                  fontFamily: "var(--font-display)", fontSize: 9, fontWeight: 500,
                  color: "var(--accent3)", letterSpacing: "0.12em", textTransform: "uppercase",
                  flexShrink: 0,
                }}>applied</span>
              )}
            </div>
            <div style={{
              fontFamily: "var(--font-display)", fontSize: 11, color: "var(--text-dim)",
              marginTop: 4, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap",
            }}>
              {match.company && (
                <span style={{ color: "var(--text-mid)" }}>
                  {match.company.charAt(0).toUpperCase() + match.company.slice(1)}
                </span>
              )}
              {match.location && match.location !== "Not specified" && (
                <><span>·</span><span>{match.location.length > 35 ? match.location.slice(0, 35) + "…" : match.location}</span></>
              )}
              {match.posted_at && (
                <><span>·</span><span>{timeAgo(match.posted_at)}</span></>
              )}
              {match.source && (
                <span style={{ marginLeft: "auto", opacity: 0.6, textTransform: "lowercase" }}>
                  via {match.source}
                </span>
              )}
            </div>
          </div>

          {/* Actions — star + apply, no lime on apply button */}
          <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
            {onSave && (
              <button
                onClick={onSave}
                title={isSaved ? "Saved" : "Save job"}
                style={{
                  width: 30, height: 30, borderRadius: 8, border: "none",
                  background: "transparent", cursor: "pointer",
                  color: isSaved ? "var(--accent)" : "var(--text-dim)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 14, transition: "color 0.15s",
                }}
              >
                {isSaved ? "★" : "☆"}
              </button>
            )}
            {!expanded && match.job_url && onApply && !isApplied && (
              <a
                href={match.job_url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => { e.stopPropagation(); if (onApply) onApply(); }}
                style={{
                  display: "inline-flex", alignItems: "center", gap: 4,
                  height: 30, padding: "0 12px", borderRadius: 8,
                  border: "1px solid var(--border-bright)",
                  background: "var(--surface2)",
                  color: "var(--text)",
                  fontFamily: "var(--font-display)", fontWeight: 500, fontSize: 11,
                  textDecoration: "none", transition: "all 0.15s",
                  letterSpacing: "0.02em",
                }}
              >
                apply
                <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M3 1h6v6M9 1L1 9" strokeLinecap="round"/>
                </svg>
              </a>
            )}
            {isApplied && (
              <span style={{
                height: 30, padding: "0 12px", borderRadius: 8,
                border: "1px solid var(--border)",
                display: "inline-flex", alignItems: "center",
                fontFamily: "var(--font-display)", fontSize: 11,
                color: "var(--text-dim)", letterSpacing: "0.02em",
              }}>applied</span>
            )}
          </div>
        </div>

        {/* Row 2: Skills pills — only when there's something meaningful */}
        {((match.matched_skills || []).length > 0 || (match.missing_skills || []).length > 0) && (
          <div style={{ display: "flex", gap: 4, marginTop: 10, paddingLeft: 68, flexWrap: "wrap" }}>
            {(match.matched_skills || []).slice(0, 3).map((s) => (
              <span key={s} style={{
                fontSize: 10, fontWeight: 500, padding: "2px 8px", borderRadius: 6,
                background: "rgba(52,211,153,0.08)", color: "var(--accent3)",
                fontFamily: "var(--font-display)",
              }}>
                {s}
              </span>
            ))}
            {(match.missing_skills || []).slice(0, 2).map((s) => (
              <span key={s} style={{
                fontSize: 10, fontWeight: 500, padding: "2px 8px", borderRadius: 6,
                background: "rgba(248,113,113,0.08)", color: "var(--danger)",
                fontFamily: "var(--font-display)",
              }}>
                − {s}
              </span>
            ))}
          </div>
        )}

        {/* Row 3: Best match resume download link */}
        {match.resume_name && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8, paddingLeft: 68 }}>
            <span style={{ fontSize: 11, color: "var(--text-dim)", fontFamily: "var(--font-display)" }}>best:</span>
            {match.resume_id ? (
              <button
                onClick={handleDownload}
                disabled={downloading}
                style={{
                  background: "none", border: "none", padding: 0,
                  cursor: "pointer",
                  fontFamily: "var(--font-display)",
                  fontSize: 11, color: "var(--accent)",
                  display: "inline-flex", alignItems: "center", gap: 3,
                  opacity: downloading ? 0.5 : 1,
                  textDecoration: "underline", textDecorationStyle: "dotted",
                  textUnderlineOffset: 2,
                }}
              >
                {downloading ? "Downloading…" : `${match.resume_name} ↓`}
              </button>
            ) : (
              <span style={{ fontFamily: "var(--font-display)", fontSize: 11, color: "var(--text-mid)" }}>{match.resume_name}</span>
            )}
          </div>
        )}

        {/* Expanded details */}
        {expanded && (
          <div style={{ marginTop: 16, paddingTop: 16, borderTop: "1px solid var(--border)", animation: "fadeUp 0.2s ease both" }}>

            {/* ── AI Analysis block ────────────────────────────── */}
            {match.scoring_method === "llm+hybrid" && match.llm_reasoning && (
              <div style={{
                marginBottom: 18,
                background: "var(--surface2)",
                border: "1px solid var(--border)",
                borderLeft: "3px solid var(--accent)",
                borderRadius: 10,
                padding: "14px 16px",
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10 }}>
                  <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--accent)", opacity: 0.8 }}>AI Analysis</span>
                  <span style={{
                    fontSize: 8, fontWeight: 700, padding: "1px 6px", borderRadius: 20,
                    background: "rgba(232,255,107,0.1)", color: "var(--accent)",
                    border: "1px solid rgba(232,255,107,0.2)", letterSpacing: "0.08em", textTransform: "uppercase",
                  }}>GPT-4o-mini</span>
                </div>

                {/* Reasoning */}
                <p style={{
                  fontSize: 12, color: "var(--text-mid)", fontStyle: "italic",
                  lineHeight: 1.65, marginBottom: 12, margin: "0 0 12px 0",
                }}>
                  "{match.llm_reasoning}"
                </p>

                {/* Strengths + gaps */}
                {((match.llm_key_strengths || []).length > 0 || (match.llm_key_gaps || []).length > 0) && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                    {(match.llm_key_strengths || []).map((s, i) => (
                      <div key={i} style={{ display: "flex", gap: 7, alignItems: "flex-start" }}>
                        <span style={{ color: "var(--accent3)", fontSize: 11, lineHeight: 1.5, flexShrink: 0 }}>✓</span>
                        <span style={{ fontSize: 11, color: "var(--text-mid)", lineHeight: 1.5 }}>{s}</span>
                      </div>
                    ))}
                    {(match.llm_key_gaps || []).map((g, i) => (
                      <div key={i} style={{ display: "flex", gap: 7, alignItems: "flex-start" }}>
                        <span style={{ color: "var(--danger)", fontSize: 11, lineHeight: 1.5, flexShrink: 0 }}>✗</span>
                        <span style={{ fontSize: 11, color: "var(--text-mid)", lineHeight: 1.5 }}>{g}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* ── LLM component score bars (primary) ──────────── */}
            {match.llm_components && match.scoring_method === "llm+hybrid" && (
              <div style={{ marginBottom: 18 }}>
                <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", color: "var(--text-dim)", marginBottom: 10 }}>
                  AI Score Breakdown
                </div>
                {[
                  { key: "skills_fit", label: "Skills Fit" },
                  { key: "experience_fit", label: "Experience Fit" },
                  { key: "trajectory_fit", label: "Career Trajectory" },
                ].map(({ key, label }) => {
                  const val = match.llm_components[key] ?? 0;
                  return (
                    <div key={key} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                      <span style={{ width: 110, fontSize: 11, color: "var(--text-dim)" }}>{label}</span>
                      <div style={{ flex: 1, height: 5, background: "var(--surface2)", borderRadius: 4, overflow: "hidden" }}>
                        <div style={{ width: `${Math.min(val, 100)}%`, height: "100%", background: scoreGradient(val), borderRadius: 4, transition: "width 0.7s cubic-bezier(0.22,1,0.36,1)" }} />
                      </div>
                      <span style={{ width: 26, fontSize: 11, color: "var(--text-mid)", textAlign: "right", fontFamily: "var(--font-display)", fontWeight: 700 }}>{val}</span>
                    </div>
                  );
                })}

                {/* Hybrid baseline — small, dim reference */}
                {match.hybrid_score != null && (
                  <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--border)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <span style={{ width: 110, fontSize: 10, color: "var(--text-dim)", opacity: 0.6 }}>Keyword/Semantic baseline</span>
                      <div style={{ flex: 1, height: 3, background: "var(--surface2)", borderRadius: 4, overflow: "hidden" }}>
                        <div style={{ width: `${Math.min(match.hybrid_score, 100)}%`, height: "100%", background: "var(--pill-bg)", borderRadius: 4 }} />
                      </div>
                      <span style={{ width: 26, fontSize: 10, color: "var(--text-dim)", textAlign: "right", fontFamily: "var(--font-display)", fontWeight: 600, opacity: 0.6 }}>{match.hybrid_score}</span>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ── Fallback: hybrid component bars (when no LLM) ── */}
            {(!match.llm_components || match.scoring_method !== "llm+hybrid") && match.components && Object.keys(match.components).length > 0 && (
              <div style={{ marginBottom: 18 }}>
                <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", color: "var(--text-dim)", marginBottom: 10 }}>
                  Score Breakdown
                </div>
                {Object.entries(match.components).map(([key, val]) => {
                  const pctVal = typeof val === "object" ? (val.score || val.weighted || 0) : val;
                  const display = Math.round(pctVal * 100);
                  return (
                    <div key={key} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 5 }}>
                      <span style={{ width: 110, fontSize: 11, color: "var(--text-dim)", textTransform: "capitalize" }}>{key.replace(/_/g, " ")}</span>
                      <div style={{ flex: 1, height: 4, background: "var(--surface2)", borderRadius: 4, overflow: "hidden" }}>
                        <div style={{ width: `${Math.min(display, 100)}%`, height: "100%", background: scoreColor(display), borderRadius: 4, transition: "width 0.6s ease" }} />
                      </div>
                      <span style={{ width: 26, fontSize: 11, color: "var(--text-mid)", textAlign: "right", fontFamily: "var(--font-display)", fontWeight: 600 }}>{display}</span>
                    </div>
                  );
                })}
              </div>
            )}

            {/* ── Coverage stats ───────────────────────────────── */}
            {match.coverage && (
              <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
                {[
                  { label: "Required", val: match.coverage.required },
                  { label: "Preferred", val: match.coverage.preferred },
                  { label: "Overall", val: match.coverage.overall },
                ].filter(x => x.val != null).map(({ label, val }) => (
                  <div key={label} style={{
                    padding: "6px 12px", borderRadius: 10, background: "var(--surface2)",
                    border: "1px solid var(--border)",
                  }}>
                    <div style={{ fontSize: 10, color: "var(--text-dim)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em" }}>{label}</div>
                    <div style={{ fontFamily: "var(--font-display)", fontSize: 16, fontWeight: 800, color: scoreColor(Math.round(val * 100)) }}>
                      {Math.round(val * 100)}%
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* ── Full skill match ─────────────────────────────── */}
            {((match.matched_skills || []).length > 4 || (match.missing_skills || []).length > 2) && (
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", color: "var(--text-dim)", marginBottom: 8 }}>
                  Full Skill Match
                </div>
                <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                  {(match.matched_skills || []).map((s) => (
                    <span key={s} style={{ fontSize: 10, fontWeight: 600, padding: "3px 9px", borderRadius: 20, background: "rgba(52,211,153,0.1)", color: "var(--accent3)" }}>
                      ✓ {s}
                    </span>
                  ))}
                  {(match.missing_skills || []).map((s) => (
                    <span key={s} style={{ fontSize: 10, fontWeight: 600, padding: "3px 9px", borderRadius: 20, background: "rgba(248,113,113,0.1)", color: "var(--danger)" }}>
                      ✗ {s}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* ── Critical gaps ────────────────────────────────── */}
            {match.critical_gaps && match.critical_gaps.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", color: "var(--danger)", marginBottom: 8 }}>
                  ⚠ Critical Gaps
                </div>
                <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                  {match.critical_gaps.map((g) => {
                    const label = typeof g === "string" ? g : g.skill || JSON.stringify(g);
                    return (
                      <span key={label} style={{ fontSize: 10, fontWeight: 600, padding: "4px 10px", borderRadius: 20, background: "rgba(248,113,113,0.08)", border: "1px solid rgba(248,113,113,0.2)", color: "var(--danger)" }}>
                        {label}
                      </span>
                    );
                  })}
                </div>
              </div>
            )}

            {/* ── Action row ───────────────────────────────────── */}
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              {match.job_url && (
                <a
                  href={match.job_url} target="_blank" rel="noopener noreferrer"
                  onClick={(e) => { e.stopPropagation(); if (onApply) onApply(); }}
                  style={{
                    display: "inline-flex", alignItems: "center", gap: 6,
                    padding: "10px 24px", borderRadius: 8,
                    background: isApplied ? "rgba(52,211,153,0.1)" : "var(--text)",
                    color: isApplied ? "#34d399" : "var(--bg)",
                    border: isApplied ? "1px solid rgba(52,211,153,0.3)" : "none",
                    fontFamily: "var(--font-display)", fontWeight: 500,
                    fontSize: 12, textDecoration: "none", letterSpacing: "0.02em",
                    transition: "all 0.2s",
                  }}
                >
                  {isApplied ? "applied" : "apply →"}
                </a>
              )}
              {match.resume_id && (
                <button
                  onClick={handleDownload}
                  disabled={downloading}
                  style={{
                    display: "inline-flex", alignItems: "center", gap: 6,
                    padding: "10px 20px", borderRadius: 8,
                    border: "1px solid var(--border)", background: "transparent",
                    color: "var(--text-dim)", fontFamily: "var(--font-display)", fontWeight: 500,
                    fontSize: 11, cursor: "pointer", transition: "all 0.2s",
                    letterSpacing: "0.02em",
                    opacity: downloading ? 0.5 : 1,
                  }}
                >
                  {downloading ? "Downloading…" : `↓ download resume`}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════
   PRESET CHIPS
   ══════════════════════════════════════════════════════════════════ */
function PresetChips({ presets, onAdd, loading }) {
  return (
    <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginBottom: 12 }}>
      {presets.map((p, i) => {
        const added = p.in_watchlist;
        return (
          <button
            key={`${p.company}-${p.source}`}
            onClick={() => !added && onAdd(p)}
            disabled={added || loading}
            style={{
              display: "flex", alignItems: "center", gap: 5,
              padding: "6px 14px", borderRadius: 30,
              border: added ? "1px solid var(--border)" : "1px solid rgba(232,255,107,0.3)",
              background: added ? "var(--surface2)" : "transparent",
              color: added ? "var(--text-dim)" : "var(--accent)",
              fontFamily: "var(--font-body)", fontSize: 12, fontWeight: 500,
              cursor: added ? "default" : "pointer",
              transition: "all 0.2s",
              animation: `fadeUp 0.3s ease ${i * 0.03}s both`,
            }}
          >
            {added ? "✓" : "+"} {p.label}
          </button>
        );
      })}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════
   AUTO MATCH LOADING — minimal ASCII pipeline status
   ══════════════════════════════════════════════════════════════════ */
const PIPELINE_STEPS = [
  { id: "fetch",  label: "Fetching job boards",         detail: "~80 Greenhouse boards · parallel fetch" },
  { id: "filter", label: "Filtering by role",           detail: "title overlap ≥ 0.60 · location match"  },
  { id: "embed",  label: "Embedding & FAISS search",    detail: "all-MiniLM-L6-v2 · 384-dim cosine"      },
  { id: "score",  label: "Hybrid scoring",              detail: "semantic + skills + experience + kw"    },
  { id: "rank",   label: "LLM deep score + ranking",    detail: "GPT-4o-mini · score×0.85 + recency×0.15"},
];

const SPINNER = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];

function AutoMatchLoadingAnimation() {
  const [stepIdx,  setStep]    = useState(0);
  const [spinner,  setSpinner] = useState(0);
  const [elapsed,  setElapsed] = useState(0);
  const [cursor,   setCursor]  = useState(true);

  // Spinner tick
  useEffect(() => {
    const t = setInterval(() => setSpinner(f => (f + 1) % SPINNER.length), 80);
    return () => clearInterval(t);
  }, []);

  // Cursor blink
  useEffect(() => {
    const t = setInterval(() => setCursor(c => !c), 530);
    return () => clearInterval(t);
  }, []);

  // Elapsed seconds counter
  useEffect(() => {
    const t = setInterval(() => setElapsed(e => e + 1), 1000);
    return () => clearInterval(t);
  }, []);

  // Step advances on a realistic cadence matching actual pipeline timing
  useEffect(() => {
    const STEP_DURATIONS = [6000, 3000, 5000, 8000, 12000]; // ms per step
    if (stepIdx >= PIPELINE_STEPS.length - 1) return;
    const t = setTimeout(() => setStep(s => s + 1), STEP_DURATIONS[stepIdx]);
    return () => clearTimeout(t);
  }, [stepIdx]);

  const mono = { fontFamily: "'JetBrains Mono','Fira Code','Courier New',monospace" };
  const acc  = "var(--accent)";
  const grn  = "var(--accent3)";
  const dim  = "var(--terminal-dim)";

  // ASCII progress bar: [████████░░░░]
  const BAR_LEN  = 24;
  const filled   = Math.round(((stepIdx + 0.5) / PIPELINE_STEPS.length) * BAR_LEN);
  const bar      = Array.from({ length: BAR_LEN }, (_, i) => i < filled ? "█" : "░").join("");
  const overallPct = Math.round(((stepIdx + 0.5) / PIPELINE_STEPS.length) * 100);

  return (
    <div style={{ padding: "28px 0 20px", animation: "fadeUp 0.3s ease both" }}>
      <div style={{
        background: "var(--terminal-bg)",
        border: "1px solid rgba(232,255,107,0.14)",
        borderRadius: 12,
        overflow: "hidden",
        maxWidth: 520,
        margin: "0 auto",
      }}>

        {/* Title bar */}
        <div style={{
          display: "flex", alignItems: "center", gap: 6,
          padding: "9px 14px",
          background: "var(--terminal-header-bg)",
          borderBottom: "1px solid var(--terminal-divider)",
        }}>
          <div style={{ width: 9, height: 9, borderRadius: "50%", background: "#ff5f56" }} />
          <div style={{ width: 9, height: 9, borderRadius: "50%", background: "#ffbd2e" }} />
          <div style={{ width: 9, height: 9, borderRadius: "50%", background: "#27c93f" }} />
          <span style={{ ...mono, fontSize: 10, color: dim, marginLeft: 8, letterSpacing: "0.05em" }}>
            rack-auto-pipeline
          </span>
          <span style={{ ...mono, fontSize: 10, color: acc, marginLeft: "auto" }}>
            {SPINNER[spinner]} {elapsed}s
          </span>
        </div>

        {/* Step list */}
        <div style={{ padding: "16px 20px 14px" }}>
          {PIPELINE_STEPS.map((step, i) => {
            const done    = i < stepIdx;
            const active  = i === stepIdx;
            const pending = i > stepIdx;
            return (
              <div key={step.id} style={{
                display: "flex", alignItems: "flex-start", gap: 12,
                padding: "7px 0",
                borderBottom: i < PIPELINE_STEPS.length - 1
                  ? "1px solid var(--terminal-divider)" : "none",
                opacity: pending ? 0.35 : 1,
                transition: "opacity 0.4s ease",
              }}>
                {/* Status glyph */}
                <span style={{
                  ...mono, fontSize: 12, lineHeight: "20px", minWidth: 14,
                  color: done ? grn : active ? acc : dim,
                }}>
                  {done ? "✓" : active ? SPINNER[spinner] : "·"}
                </span>

                {/* Label + detail */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    ...mono, fontSize: 12, fontWeight: 600,
                    color: done ? grn : active ? acc : dim,
                    marginBottom: 1,
                  }}>
                    {step.label}
                    {active && <span style={{ opacity: cursor ? 1 : 0, marginLeft: 4 }}>▌</span>}
                  </div>
                  <div style={{
                    ...mono, fontSize: 10,
                    color: done ? "rgba(52,211,153,0.45)" : active ? "rgba(232,255,107,0.45)" : "transparent",
                    transition: "color 0.3s",
                    whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                  }}>
                    {step.detail}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Progress bar footer */}
        <div style={{
          padding: "10px 20px 12px",
          borderTop: "1px solid var(--terminal-divider)",
          background: "var(--terminal-header-bg)",
        }}>
          <div style={{ ...mono, fontSize: 11, color: acc, whiteSpace: "pre", letterSpacing: "-0.01em" }}>
            [{bar}] {String(overallPct).padStart(3, " ")}%
          </div>
        </div>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════
   ARCHIVE HELPERS — localStorage-based, no backend needed
   ══════════════════════════════════════════════════════════════════ */
const ARCHIVE_KEY    = "rack_auto_archive";
const ARCHIVE_CAP    = 50;
const ARCHIVE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function loadArchive() {
  try { return JSON.parse(localStorage.getItem(ARCHIVE_KEY) || "[]"); }
  catch { return []; }
}
function saveArchive(items) {
  localStorage.setItem(ARCHIVE_KEY, JSON.stringify(items));
}
function archiveJobs(jobsToArchive, currentArchive) {
  const now = Date.now();
  let pruned = currentArchive.filter(j => (now - (j.archived_at || 0)) < ARCHIVE_TTL_MS);
  const existing = new Set(pruned.map(j => j.job_id));
  for (const job of jobsToArchive) {
    if (!existing.has(job.job_id) && pruned.length < ARCHIVE_CAP) {
      pruned.push({ ...job, archived_at: now, applied: false });
      existing.add(job.job_id);
    }
  }
  return pruned;
}

/* ══════════════════════════════════════════════════════════════════
   ARCHIVE MODAL
   ══════════════════════════════════════════════════════════════════ */
function ArchiveModal({ onClose }) {
  const [archive, setArchive]   = useState(() => loadArchive());
  const [selected, setSelected] = useState(new Set());
  const [autoClean, setAutoClean] = useState(
    () => localStorage.getItem("rack_archive_autoclean") === "true"
  );
  const [expandedId, setExpandedId] = useState(null);
  const [confirmApplied, setConfirmApplied] = useState(new Set()); // jobs pending "did you apply?" confirm
  const [downloading, setDownloading] = useState(null); // job_id being downloaded

  const toggleAutoClean = () => {
    const next = !autoClean;
    setAutoClean(next);
    localStorage.setItem("rack_archive_autoclean", String(next));
  };
  const toggleSelect  = (id) => setSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const selectAll     = () => setSelected(new Set(archive.map(j => j.job_id)));
  const deselectAll   = () => setSelected(new Set());

  const markApplied = (id) => {
    const u = archive.map(j => j.job_id === id ? { ...j, applied: true } : j);
    setArchive(u); saveArchive(u);
    setConfirmApplied(prev => { const n = new Set(prev); n.delete(id); return n; });
  };
  const toggleConfirmApplied = (id) => {
    setConfirmApplied(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  };
  const deleteSelected = () => {
    const u = archive.filter(j => !selected.has(j.job_id));
    setArchive(u); saveArchive(u); setSelected(new Set());
  };
  const deleteOne = (id) => {
    const u = archive.filter(j => j.job_id !== id);
    setArchive(u); saveArchive(u);
    setSelected(prev => { const n = new Set(prev); n.delete(id); return n; });
  };

  const now  = Date.now();
  const mono = { fontFamily: "'JetBrains Mono','Fira Code','Courier New',monospace" };

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 9999,
      background: "var(--modal-overlay)", backdropFilter: "blur(6px)",
      display: "flex", alignItems: "flex-start", justifyContent: "center",
      padding: "110px 16px 40px", overflowY: "auto",
    }} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{
        width: "100%", maxWidth: 700,
        background: "var(--bg)", border: "1px solid var(--border)",
        borderRadius: 18, overflow: "hidden", animation: "fadeUp 0.25s ease both",
        boxShadow: "var(--modal-shadow)",
      }}>
        {/* Header */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "18px 22px", borderBottom: "1px solid var(--border)",
          background: "var(--archive-header-bg)",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ ...mono, fontSize: 20, color: "var(--accent)", letterSpacing: -1 }}>╔═╗</span>
            <div>
              <div style={{ fontFamily: "var(--font-display)", fontSize: 16, fontWeight: 800, letterSpacing: "-0.4px" }}>Archive</div>
              <div style={{ fontSize: 11, color: "var(--text-dim)", ...mono }}>
                {archive.length}/{ARCHIVE_CAP} slots
                {archive.filter(j => j.applied).length > 0 && (
                  <span style={{ color: "#34d399", marginLeft: 8 }}>· {archive.filter(j => j.applied).length} applied</span>
                )}
              </div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={toggleAutoClean} title="Auto-remove jobs archived >7 days" style={{
              display: "flex", alignItems: "center", gap: 5, padding: "6px 12px", borderRadius: 20,
              border: `1px solid ${autoClean ? "rgba(232,255,107,0.3)" : "var(--border)"}`,
              background: autoClean ? "rgba(232,255,107,0.06)" : "transparent",
              color: autoClean ? "var(--accent)" : "var(--text-dim)",
              fontSize: 11, cursor: "pointer", ...mono,
            }}>{autoClean ? "■" : "□"} auto-clean 7d</button>
            <button onClick={onClose} style={{
              background: "none", border: "1px solid var(--border)", borderRadius: 8,
              color: "var(--text-dim)", cursor: "pointer", width: 30, height: 30,
              fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center",
            }}>✕</button>
          </div>
        </div>

        {/* Capacity bar */}
        <div style={{ padding: "10px 22px 0" }}>
          <div style={{ height: 3, background: "var(--surface2)", borderRadius: 3, overflow: "hidden" }}>
            <div style={{
              height: "100%", borderRadius: 3,
              width: `${(archive.length / ARCHIVE_CAP) * 100}%`,
              background: archive.length >= ARCHIVE_CAP
                ? "linear-gradient(90deg,#f87171,#fb923c)"
                : archive.length > ARCHIVE_CAP * 0.8
                ? "linear-gradient(90deg,#fbbf24,#f59e0b)"
                : "linear-gradient(90deg,#34d399,#6ee7b7)",
              transition: "width 0.5s ease",
            }} />
          </div>
          {archive.length >= ARCHIVE_CAP && (
            <div style={{ fontSize: 10, color: "var(--danger)", marginTop: 4, ...mono }}>⚠ archive full — delete to free space</div>
          )}
        </div>

        {/* Bulk bar */}
        {archive.length > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 22px", borderBottom: "1px solid var(--border)", flexWrap: "wrap" }}>
            <button onClick={selected.size === archive.length ? deselectAll : selectAll}
              style={{ ...mono, fontSize: 10, background: "none", border: "1px solid var(--border)", borderRadius: 6, padding: "4px 10px", color: "var(--text-dim)", cursor: "pointer" }}>
              {selected.size === archive.length ? "□ none" : "■ all"}
            </button>
            {selected.size > 0 && (
              <>
                <span style={{ fontSize: 11, color: "var(--text-dim)", ...mono }}>{selected.size} selected</span>
                <button onClick={deleteSelected} style={{
                  ...mono, fontSize: 10, background: "rgba(248,113,113,0.08)", border: "1px solid rgba(248,113,113,0.2)",
                  borderRadius: 6, padding: "4px 10px", color: "var(--danger)", cursor: "pointer",
                }}>␡ delete selected</button>
              </>
            )}
            <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--text-dim)", ...mono }}>{ARCHIVE_CAP - archive.length} slots free</span>
          </div>
        )}

        {/* List */}
        <div style={{ maxHeight: 480, overflowY: "auto", padding: "8px 22px 22px" }}>
          {archive.length === 0 ? (
            <div style={{ textAlign: "center", padding: "48px 20px", color: "var(--text-dim)" }}>
              <div style={{ ...mono, fontSize: 24, marginBottom: 12, opacity: 0.3 }}>[ empty ]</div>
              <div style={{ fontSize: 13 }}>No archived jobs yet.</div>
              <div style={{ fontSize: 12, marginTop: 4, opacity: 0.6 }}>Dismissed jobs will appear here for future reference.</div>
            </div>
          ) : archive.map((job) => {
            const isSelected = selected.has(job.job_id);
            const isExpanded = expandedId === job.job_id;
            const ageDays    = Math.floor((now - (job.archived_at || now)) / 86400000);
            const nearExpiry = ageDays >= 5;
            return (
              <div key={job.job_id} style={{
                border: `1px solid ${isSelected ? "rgba(232,255,107,0.25)" : "var(--border)"}`,
                borderRadius: 12, marginTop: 8, overflow: "hidden",
                background: isSelected ? "rgba(232,255,107,0.02)" : "var(--surface)",
                transition: "all 0.15s",
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 14px", cursor: "pointer" }}
                  onClick={() => setExpandedId(isExpanded ? null : job.job_id)}>
                  {/* Checkbox */}
                  <div onClick={e => { e.stopPropagation(); toggleSelect(job.job_id); }} style={{
                    width: 16, height: 16, borderRadius: 4, flexShrink: 0,
                    border: `1px solid ${isSelected ? "var(--accent)" : "var(--border)"}`,
                    background: isSelected ? "rgba(232,255,107,0.15)" : "transparent",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    cursor: "pointer", ...mono, fontSize: 10, color: "var(--accent)",
                  }}>{isSelected ? "✓" : ""}</div>
                  {/* Score */}
                  <div style={{ ...mono, fontSize: 13, fontWeight: 800, minWidth: 36, textAlign: "center", color: scoreColor(job.score || 0) }}>{job.score || 0}%</div>
                  {/* Title */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      fontSize: 13, fontWeight: 600, fontFamily: "var(--font-display)",
                      wordBreak: "break-word", overflowWrap: "break-word",
                      textDecoration: job.applied ? "line-through" : "none", opacity: job.applied ? 0.5 : 1,
                    }}>{job.job_title}</div>
                    <div style={{ fontSize: 11, color: "var(--text-dim)", display: "flex", gap: 6, marginTop: 2, flexWrap: "wrap" }}>
                      <span>{job.company?.charAt(0).toUpperCase()}{job.company?.slice(1)}</span>
                      {job.location && job.location !== "Not specified" && <span>· {job.location}</span>}
                      <span style={{ ...mono, fontSize: 10, color: nearExpiry ? "#fbbf24" : "var(--text-dim)" }}>
                        · archived {ageDays === 0 ? "today" : `${ageDays}d ago`}{nearExpiry ? " ⚠" : ""}
                      </span>
                    </div>
                  </div>
                  {job.applied && (
                    <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 7px", borderRadius: 20, background: "rgba(52,211,153,0.1)", color: "#34d399", border: "1px solid rgba(52,211,153,0.2)", ...mono }}>APPLIED</span>
                  )}
                  <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{isExpanded ? "▲" : "▼"}</span>
                </div>
                {isExpanded && (
                  <div style={{ padding: "10px 14px 14px", borderTop: "1px solid var(--border)", background: "var(--archive-expanded-bg)", animation: "fadeUp 0.15s ease both" }}>
                    {/* Skills */}
                    <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 10 }}>
                      {(job.matched_skills || []).slice(0, 5).map(s => (
                        <span key={s} style={{ fontSize: 9, padding: "2px 7px", borderRadius: 20, background: "rgba(52,211,153,0.1)", color: "#34d399", fontWeight: 600 }}>✓ {s}</span>
                      ))}
                      {(job.missing_skills || []).slice(0, 3).map(s => (
                        <span key={s} style={{ fontSize: 9, padding: "2px 7px", borderRadius: 20, background: "rgba(248,113,113,0.08)", color: "var(--danger)", fontWeight: 600 }}>✗ {s}</span>
                      ))}
                    </div>

                    {/* Resume matched */}
                    {job.resume_name && (
                      <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 10, display: "flex", alignItems: "center", gap: 6, ...mono }}>
                        <span style={{ opacity: 0.5 }}>matched resume:</span>
                        <button
                          disabled={downloading === job.job_id}
                          onClick={async () => {
                            if (!job.resume_id || downloading) return;
                            setDownloading(job.job_id);
                            await downloadResume(job.resume_id, job.resume_name, job.file_ext);
                            setDownloading(null);
                          }}
                          style={{
                            background: "none", border: "none", padding: "1px 6px",
                            borderRadius: 6, cursor: job.resume_id ? "pointer" : "default",
                            color: "var(--accent)", fontWeight: 600, fontSize: 11,
                            fontFamily: "var(--font-body)",
                            display: "inline-flex", alignItems: "center", gap: 4,
                            opacity: downloading === job.job_id ? 0.5 : 1,
                            textDecoration: job.resume_id ? "underline" : "none",
                            textDecorationStyle: "dotted", textUnderlineOffset: 2,
                          }}
                        >
                          {downloading === job.job_id ? "Downloading…" : `${job.resume_name}${job.resume_id ? " ↓" : ""}`}
                        </button>
                      </div>
                    )}

                    {/* "Did you apply?" confirmation row */}
                    {!job.applied && (
                      <div style={{
                        marginBottom: 10, padding: "8px 12px", borderRadius: 10,
                        background: confirmApplied.has(job.job_id) ? "rgba(52,211,153,0.06)" : "var(--archive-expanded-bg)",
                        border: `1px solid ${confirmApplied.has(job.job_id) ? "rgba(52,211,153,0.2)" : "var(--border)"}`,
                        display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
                        transition: "all 0.2s",
                      }}>
                        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", flex: 1 }}>
                          <div
                            onClick={() => toggleConfirmApplied(job.job_id)}
                            style={{
                              width: 16, height: 16, borderRadius: 4, flexShrink: 0,
                              border: `1px solid ${confirmApplied.has(job.job_id) ? "#34d399" : "var(--border)"}`,
                              background: confirmApplied.has(job.job_id) ? "rgba(52,211,153,0.2)" : "transparent",
                              display: "flex", alignItems: "center", justifyContent: "center",
                              cursor: "pointer", fontSize: 10, color: "#34d399", transition: "all 0.15s",
                            }}
                          >{confirmApplied.has(job.job_id) ? "✓" : ""}</div>
                          <span style={{ fontSize: 11, color: confirmApplied.has(job.job_id) ? "#34d399" : "var(--text-dim)", ...mono }}>
                            I applied for this job
                          </span>
                        </label>
                        {confirmApplied.has(job.job_id) && (
                          <button onClick={() => markApplied(job.job_id)} style={{
                            fontSize: 11, padding: "5px 14px", borderRadius: 20,
                            border: "1px solid rgba(52,211,153,0.4)", background: "rgba(52,211,153,0.12)",
                            color: "#34d399", cursor: "pointer", fontWeight: 700, ...mono,
                            animation: "fadeUp 0.15s ease both",
                          }}>✓ confirm applied</button>
                        )}
                      </div>
                    )}

                    {/* Action buttons */}
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      {job.job_url && (
                        <a href={job.job_url} target="_blank" rel="noopener noreferrer"
                          style={{ fontSize: 11, padding: "6px 14px", borderRadius: 8, background: "var(--text)", color: "var(--bg)", fontFamily: "var(--font-display)", fontWeight: 500, textDecoration: "none", letterSpacing: "0.02em" }}>
                          apply →
                        </a>
                      )}
                      <button onClick={() => deleteOne(job.job_id)} style={{
                        fontSize: 11, padding: "6px 14px", borderRadius: 20,
                        border: "1px solid rgba(248,113,113,0.2)", background: "rgba(248,113,113,0.05)",
                        color: "var(--danger)", cursor: "pointer", ...mono,
                      }}>␡ remove</button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}


/* ══════════════════════════════════════════════════════════════════
   FRESH JOBS TAB — recently posted scored jobs, sorted by posted_at
   ══════════════════════════════════════════════════════════════════ */
/* ══════════════════════════════════════════════════════════════════
   SMART PAGINATOR — ellipsis style, max ~9 buttons visible
   ══════════════════════════════════════════════════════════════════ */
function Paginator({ page, totalPages, onPage }) {
  if (totalPages <= 1) return null;
  const mono = { fontFamily: "'JetBrains Mono','Fira Code','Courier New',monospace" };

  // Build the page numbers to show: always first, last, and ±2 around current
  const pages = [];
  const delta = 2;
  const left  = Math.max(2, page - delta);
  const right = Math.min(totalPages - 1, page + delta);

  pages.push(1);
  if (left > 2) pages.push("...");
  for (let i = left; i <= right; i++) pages.push(i);
  if (right < totalPages - 1) pages.push("...");
  if (totalPages > 1) pages.push(totalPages);

  const btnBase = {
    height: 32, minWidth: 32, borderRadius: 8, fontSize: 12,
    border: "1px solid var(--border)", background: "transparent",
    cursor: "pointer", transition: "all 0.15s", ...mono,
    display: "flex", alignItems: "center", justifyContent: "center", padding: "0 8px",
  };

  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 5, marginTop: 20, flexWrap: "wrap" }}>
      <button
        onClick={() => onPage(Math.max(1, page - 1))}
        disabled={page === 1}
        style={{ ...btnBase, color: page === 1 ? "var(--text-dim)" : "var(--text)", opacity: page === 1 ? 0.35 : 1 }}
      >← prev</button>

      {pages.map((p, i) =>
        p === "..." ? (
          <span key={`ellipsis-${i}`} style={{ ...mono, fontSize: 12, color: "var(--text-dim)", padding: "0 2px" }}>…</span>
        ) : (
          <button
            key={p}
            onClick={() => onPage(p)}
            style={{
              ...btnBase,
              border: `1px solid ${p === page ? "var(--accent)" : "var(--border)"}`,
              background: p === page ? "rgba(232,255,107,0.1)" : "transparent",
              color: p === page ? "var(--accent)" : "var(--text-dim)",
              fontWeight: p === page ? 700 : 400,
            }}
          >{p}</button>
        )
      )}

      <button
        onClick={() => onPage(Math.min(totalPages, page + 1))}
        disabled={page === totalPages}
        style={{ ...btnBase, color: page === totalPages ? "var(--text-dim)" : "var(--text)", opacity: page === totalPages ? 0.35 : 1 }}
      >next →</button>
    </div>
  );
}

const FRESH_WINDOWS = [
  { label: "1h",  hours: 1   },
  { label: "3h",  hours: 3   },
  { label: "6h",  hours: 6   },
  { label: "12h", hours: 12  },
  { label: "24h", hours: 24  },
];

function FreshJobsTab() {
  const [jobs, setJobs]           = useState([]);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState(null);
  const [window, setWindow]       = useState(1); // hours — default 1h
  const [expandedId, setExpandedId] = useState(null);
  const [titleFilter, setTitleFilter] = useState("");
  const [sortOrder, setSortOrder]     = useState("recency"); // "recency" | "score"
  const [page, setPage]               = useState(1);
  const hasRun = useRef(false);

  const loadFresh = async (hours) => {
    setLoading(true); setError(null); setPage(1); setExpandedId(null);
    try {
      const headers = await getAuthHeaders();
      const r = await fetch(`${API}/auto/fresh?hours=${hours}`, { headers });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      setJobs(d.jobs || []);
    } catch (e) {
      setError("Failed to load fresh jobs: " + e.message);
    }
    setLoading(false);
  };

  // Auto-load on mount
  useEffect(() => {
    if (hasRun.current) return;
    hasRun.current = true;
    loadFresh(1);
  }, []);

  const handleWindowChange = (hours) => {
    setWindow(hours);
    loadFresh(hours);
  };

  const filtered = jobs.filter(m =>
    !titleFilter.trim() || m.job_title?.toLowerCase().includes(titleFilter.toLowerCase())
  );

  const sorted = [...filtered].sort((a, b) => {
    if (sortOrder === "score") {
      return (b.llm_score ?? b.score ?? 0) - (a.llm_score ?? a.score ?? 0);
    }
    // recency: newest posted_at first (default)
    return new Date(b.posted_at || 0) - new Date(a.posted_at || 0);
  });

  useEffect(() => { setPage(1); }, [titleFilter, sortOrder]);

  const PAGE_SIZE_F = 10;
  const totalPages  = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE_F));
  const paginated   = sorted.slice((page - 1) * PAGE_SIZE_F, page * PAGE_SIZE_F);

  const inputStyle = {
    padding: "8px 14px", borderRadius: 30,
    border: "1px solid var(--border)", background: "var(--surface)",
    color: "var(--text)", fontFamily: "var(--font-body)", fontSize: 12, outline: "none",
  };
  const mono = { fontFamily: "'JetBrains Mono','Fira Code','Courier New',monospace" };

  return (
    <div>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14, flexWrap: "wrap", gap: 10 }}>
        <div style={{ fontSize: 13, color: "var(--text-dim)" }}>
          {jobs.length > 0
            ? `${jobs.length} jobs posted in the last ${window}h · sorted by ${sortOrder === "score" ? "score ↓" : "recency"}`
            : "Jobs RACK has scored, filtered by how recently they were posted"}
        </div>
        <button
          onClick={() => loadFresh(window)}
          disabled={loading}
          style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 16px", borderRadius: 8, border: "1px solid var(--border-bright)", background: "transparent", color: "var(--text)", fontFamily: "var(--font-display)", fontWeight: 500, fontSize: 11, cursor: loading ? "default" : "pointer", opacity: loading ? 0.5 : 1, transition: "all 0.2s", letterSpacing: "0.02em" }}
        >
          {loading ? <><span style={{ display: "inline-block", animation: "spin 1s linear infinite" }}>⟳</span> Loading…</> : "⟳ Refresh"}
        </button>
      </div>

      {/* Time filter bar */}
      <div style={{ display: "flex", gap: 5, marginBottom: 16, flexWrap: "wrap" }}>
        {FRESH_WINDOWS.map(({ label, hours }) => {
          const active = window === hours;
          return (
            <button
              key={hours}
              onClick={() => handleWindowChange(hours)}
              disabled={loading}
              style={{
                padding: "6px 14px", borderRadius: 30, border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
                background: active ? "rgba(232,255,107,0.1)" : "transparent",
                color: active ? "var(--accent)" : "var(--text-dim)",
                fontFamily: "var(--font-body)", fontSize: 12, fontWeight: active ? 700 : 400,
                cursor: loading ? "default" : "pointer", transition: "all 0.18s",
                ...mono,
              }}
            >
              {label}
            </button>
          );
        })}
        <span style={{ fontSize: 11, color: "var(--text-dim)", alignSelf: "center", marginLeft: 4, ...mono }}>
          posted within
        </span>
      </div>

      {error && (
        <div style={{ background: "rgba(248,113,113,0.06)", border: "1px solid rgba(248,113,113,0.15)", borderRadius: 14, padding: "10px 16px", fontSize: 12, color: "var(--danger)", marginBottom: 14, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          {error}<button onClick={() => setError(null)} style={{ background: "none", border: "none", color: "var(--danger)", cursor: "pointer", fontSize: 13, padding: 0 }}>✕</button>
        </div>
      )}

      {/* Search filter + sort toggle */}
      {jobs.length > 0 && (
        <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
          <input type="text" value={titleFilter} onChange={e => setTitleFilter(e.target.value)} placeholder="Search by title…" style={{ ...inputStyle, flex: "1 1 180px" }} />
          <button
            onClick={() => setSortOrder(o => o === "recency" ? "score" : "recency")}
            style={{
              ...inputStyle,
              display: "flex", alignItems: "center", gap: 5,
              cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0,
              background: sortOrder === "score" ? "rgba(232,255,107,0.08)" : "var(--surface)",
              color: sortOrder === "score" ? "var(--accent)" : "var(--text-dim)",
              border: sortOrder === "score" ? "1px solid rgba(232,255,107,0.3)" : "1px solid var(--border)",
              transition: "all 0.18s",
            }}
          >
            {sortOrder === "recency" ? "↕ Sort: Recency" : "↕ Sort: Score"}
          </button>
          <span style={{ fontSize: 11, color: "var(--text-dim)", ...mono }}>{sorted.length} jobs · p.{page}/{totalPages}</span>
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div style={{ textAlign: "center", padding: "60px 20px", color: "var(--text-dim)", animation: "fadeUp 0.3s ease both" }}>
          <div style={{ width: 36, height: 36, border: "3px solid var(--spinner-track)", borderTopColor: "var(--accent)", borderRadius: "50%", animation: "spin 0.8s linear infinite", margin: "0 auto 14px" }} />
          <div style={{ fontSize: 13, color: "var(--accent)", fontFamily: "var(--font-display)", fontWeight: 700, marginBottom: 4 }}>Loading fresh jobs…</div>
          <div style={{ fontSize: 11 }}>Filtering matched jobs posted in the last {window}h</div>
        </div>
      )}

      {/* Empty state */}
      {!loading && jobs.length === 0 && !error && (
        <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 16, padding: "48px 24px", textAlign: "center", animation: "fadeUp 0.35s ease both" }}>
          <div style={{ fontFamily: "var(--font-display)", fontSize: 24, marginBottom: 14, color: "var(--accent)", opacity: 0.4 }}>[ no fresh jobs ]</div>
          <div style={{ fontFamily: "var(--font-display)", fontSize: 17, fontWeight: 700, marginBottom: 6, letterSpacing: "-0.3px" }}>Nothing posted in the last {window}h</div>
          <div style={{ fontSize: 13, color: "var(--text-dim)", maxWidth: 380, margin: "0 auto 20px", lineHeight: 1.6 }}>
            Try a wider time window, or run Auto Matches to score more jobs first.
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap" }}>
            {FRESH_WINDOWS.filter(w => w.hours > window).slice(0, 2).map(({ label, hours }) => (
              <button key={hours} onClick={() => handleWindowChange(hours)} style={{ padding: "9px 20px", borderRadius: 30, border: "1px solid rgba(232,255,107,0.3)", background: "transparent", color: "var(--accent)", fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 12, cursor: "pointer" }}>
                Try {label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Job cards */}
      {!loading && paginated.map((m, i) => (
        <MatchCard key={m.job_id} match={m} index={(page - 1) * PAGE_SIZE_F + i}
          expanded={expandedId === m.job_id}
          onToggle={() => setExpandedId(expandedId === m.job_id ? null : m.job_id)}
          isAuto={true} />
      ))}

      {/* Pagination */}
      {!loading && <Paginator page={page} totalPages={totalPages} onPage={p => { setPage(p); }} />}
      {!loading && sorted.length > 0 && (
        <div style={{ textAlign: "center", marginTop: 10, fontSize: 10, color: "var(--text-dim)", ...mono }}>
          showing {(page - 1) * PAGE_SIZE_F + 1}–{Math.min(page * PAGE_SIZE_F, sorted.length)} of {sorted.length} jobs
        </div>
      )}
    </div>
  );
}


/* ══════════════════════════════════════════════════════════════════
   APPLIED JOBS TAB — jobs the user has marked as applied
   ══════════════════════════════════════════════════════════════════ */
function AppliedJobsTab() {
  const [jobs, setJobs]               = useState([]);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState(null);
  const [expandedId, setExpandedId]   = useState(null);
  const [titleFilter, setTitleFilter] = useState("");
  const [sortBy, setSortBy]           = useState("applied_desc");
  const [page, setPage]               = useState(1);
  const PAGE_SIZE_A = 10;
  const mono = { fontFamily: "'JetBrains Mono','Fira Code','Courier New',monospace" };

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const headers = await getAuthHeaders();
        const r = await fetch(`${API}/auto/matches`, { headers });
        if (!r.ok) throw new Error("Failed to load matches");
        const d = await r.json();
        const all = Array.isArray(d) ? d : (d.matches || []);
        setJobs(all.filter(m => m.applied === true));
      } catch (e) {
        setError("Could not load applied jobs.");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const filtered = jobs.filter(m =>
    !titleFilter.trim() || m.job_title?.toLowerCase().includes(titleFilter.toLowerCase())
  );

  const sorted = [...filtered].sort((a, b) => {
    if (sortBy === "applied_desc") return new Date(b.applied_at || 0) - new Date(a.applied_at || 0);
    if (sortBy === "applied_asc")  return new Date(a.applied_at || 0) - new Date(b.applied_at || 0);
    if (sortBy === "score_desc")   return (b.llm_score ?? b.score ?? 0) - (a.llm_score ?? a.score ?? 0);
    return 0;
  });

  useEffect(() => { setPage(1); }, [titleFilter, sortBy]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE_A));
  const paginated  = sorted.slice((page - 1) * PAGE_SIZE_A, page * PAGE_SIZE_A);

  function formatAppliedAt(iso) {
    if (!iso) return null;
    try {
      const d = new Date(iso);
      return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) +
        " at " + d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    } catch { return null; }
  }

  const inputStyle = {
    background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8,
    padding: "7px 12px", fontSize: 12, color: "var(--text)", outline: "none",
    fontFamily: "'JetBrains Mono',monospace",
  };

  if (loading) {
    return (
      <div style={{ display: "flex", justifyContent: "center", padding: "60px 0" }}>
        <div style={{ width: 20, height: 20, border: "2px solid var(--border)", borderTopColor: "var(--accent3)", borderRadius: "50%", animation: "spin 0.7s linear infinite" }} />
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ background: "rgba(248,113,113,0.06)", border: "1px solid rgba(248,113,113,0.15)", borderRadius: 14, padding: "16px 20px", fontSize: 13, color: "var(--danger)" }}>
        {error}
      </div>
    );
  }

  if (jobs.length === 0) {
    return (
      <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10, padding: "48px 24px", textAlign: "center", animation: "fadeUp 0.35s ease both" }}>
        <div style={{ fontFamily: "var(--font-display)", fontSize: 10, letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--accent3)", opacity: 0.6, marginBottom: 16 }}>✓ applied</div>
        <div style={{ fontFamily: "var(--font-display)", fontSize: 16, fontWeight: 500, marginBottom: 8, letterSpacing: "-0.01em" }}>No applications yet</div>
        <div style={{ fontSize: 13, color: "var(--text-dim)", maxWidth: 360, margin: "0 auto", lineHeight: 1.6 }}>
          When you hit "apply" on a matched job, it will appear here with the date and time you applied.
        </div>
      </div>
    );
  }

  return (
    <div style={{ animation: "fadeUp 0.3s ease both" }}>

      {/* Summary bar */}
      <div style={{ marginBottom: 16, fontSize: 13, color: "var(--text-dim)", ...mono }}>
        <span style={{ color: "var(--accent3)", fontWeight: 500 }}>{jobs.length}</span>
        {" "}job{jobs.length !== 1 ? "s" : ""} applied
      </div>

      {/* Filters */}
      <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
        <input
          type="text"
          value={titleFilter}
          onChange={e => setTitleFilter(e.target.value)}
          placeholder="Search by title…"
          style={{ ...inputStyle, flex: "1 1 180px" }}
        />
        <div style={{ position: "relative", flexShrink: 0 }}>
          <select
            value={sortBy}
            onChange={e => setSortBy(e.target.value)}
            style={{ ...inputStyle, paddingRight: 32, appearance: "none", WebkitAppearance: "none", cursor: "pointer", minWidth: 200 }}
          >
            <option value="applied_desc">↓ Applied: Newest first</option>
            <option value="applied_asc">↑ Applied: Oldest first</option>
            <option value="score_desc">↓ Score: High → Low</option>
          </select>
          <span style={{ position: "absolute", right: 11, top: "50%", transform: "translateY(-50%)", pointerEvents: "none", fontSize: 10, color: "var(--text-dim)" }}>▾</span>
        </div>
        <span style={{ fontSize: 11, color: "var(--text-dim)", ...mono, flexShrink: 0 }}>
          {sorted.length} job{sorted.length !== 1 ? "s" : ""} · p.{page}/{totalPages}
        </span>
      </div>

      {/* No filtered results */}
      {sorted.length === 0 && (
        <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10, padding: "36px 24px", textAlign: "center" }}>
          <div style={{ fontSize: 13, color: "var(--text-dim)", marginBottom: 14 }}>No matches for the current filter.</div>
          <button onClick={() => setTitleFilter("")} style={{ padding: "7px 18px", borderRadius: 8, border: "1px solid var(--border-bright)", background: "transparent", color: "var(--text)", fontFamily: "var(--font-display)", fontSize: 11, cursor: "pointer" }}>
            clear filter
          </button>
        </div>
      )}

      {/* Job cards */}
      {paginated.map((m, i) => {
        const appliedAtStr  = formatAppliedAt(m.applied_at);
        const isExpanded    = expandedId === m.job_id;
        const displayScore  = m.llm_score ?? m.score ?? 0;

        return (
          <div
            key={m.job_id}
            onClick={() => setExpandedId(isExpanded ? null : m.job_id)}
            style={{
              background: "var(--surface)",
              border: isExpanded ? "1px solid var(--border-bright)" : "1px solid rgba(52,211,153,0.2)",
              borderLeft: "3px solid #34d399",
              borderRadius: 16, marginBottom: 6, cursor: "pointer",
              transition: "border 0.2s", overflow: "hidden",
              opacity: 0, animation: `fadeUp 0.4s ease ${Math.min(i * 0.04, 0.3)}s forwards`,
            }}
          >
            {/* Score bar */}
            <div style={{ height: 3, background: scoreGradient(displayScore), width: `${Math.min(displayScore, 100)}%`, transition: "width 0.8s cubic-bezier(0.22,1,0.36,1)" }} />

            <div style={{ padding: "14px 18px" }}>
              {/* Row 1 */}
              <div style={{ display: "flex", alignItems: "center", gap: 16 }}>

                {/* Score */}
                <div style={{ flexShrink: 0, width: 52, textAlign: "left" }}>
                  <div style={{ fontFamily: "var(--font-display)", fontSize: 22, fontWeight: 500, color: "var(--text)", letterSpacing: "-0.02em", lineHeight: 1 }}>
                    {displayScore}<span style={{ color: "var(--text-dim)", fontSize: 13, fontWeight: 400 }}>%</span>
                  </div>
                  {m.llm_recommendation === "Strong Match" && (
                    <div style={{ fontFamily: "var(--font-display)", fontSize: 9, fontWeight: 500, marginTop: 4, color: "var(--accent3)", letterSpacing: "0.1em", textTransform: "uppercase" }}>● strong</div>
                  )}
                </div>

                {/* Divider */}
                <div style={{ width: 1, alignSelf: "stretch", background: "var(--border)", flexShrink: 0 }} />

                {/* Title + meta */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: "var(--font-body)", fontSize: 15, fontWeight: 500, color: "var(--text)", letterSpacing: "-0.01em", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.job_title}</span>
                    <span style={{ fontFamily: "var(--font-display)", fontSize: 9, fontWeight: 500, color: "var(--accent3)", letterSpacing: "0.12em", textTransform: "uppercase", flexShrink: 0 }}>applied</span>
                  </div>
                  <div style={{ fontFamily: "var(--font-display)", fontSize: 11, color: "var(--text-dim)", marginTop: 4, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    {m.company && <span style={{ color: "var(--text-mid)" }}>{m.company.charAt(0).toUpperCase() + m.company.slice(1)}</span>}
                    {m.location && m.location !== "Not specified" && <><span>·</span><span>{m.location.length > 35 ? m.location.slice(0, 35) + "…" : m.location}</span></>}
                    {m.posted_at && <><span>·</span><span>posted {timeAgo(m.posted_at)}</span></>}
                    {m.source && <span style={{ marginLeft: "auto", opacity: 0.6, textTransform: "lowercase" }}>via {m.source}</span>}
                  </div>
                </div>

                {/* Applied-at badge */}
                <div style={{ flexShrink: 0, textAlign: "right" }}>
                  {appliedAtStr ? (
                    <div style={{ fontFamily: "var(--font-display)", fontSize: 10, color: "var(--accent3)", lineHeight: 1.5 }}>
                      <div style={{ opacity: 0.55, marginBottom: 1, letterSpacing: "0.06em" }}>applied</div>
                      <div style={{ fontWeight: 500 }}>{appliedAtStr}</div>
                    </div>
                  ) : (
                    <span style={{ height: 28, padding: "0 10px", borderRadius: 8, border: "1px solid rgba(52,211,153,0.3)", display: "inline-flex", alignItems: "center", fontFamily: "var(--font-display)", fontSize: 11, color: "var(--accent3)", background: "rgba(52,211,153,0.06)" }}>✓ applied</span>
                  )}
                </div>
              </div>

              {/* Skills pills */}
              {((m.matched_skills || []).length > 0 || (m.missing_skills || []).length > 0) && (
                <div style={{ display: "flex", gap: 4, marginTop: 10, paddingLeft: 68, flexWrap: "wrap" }}>
                  {(m.matched_skills || []).slice(0, 3).map(s => (
                    <span key={s} style={{ fontSize: 10, fontWeight: 500, padding: "2px 8px", borderRadius: 6, background: "rgba(52,211,153,0.08)", color: "var(--accent3)", fontFamily: "var(--font-display)" }}>{s}</span>
                  ))}
                  {(m.missing_skills || []).slice(0, 2).map(s => (
                    <span key={s} style={{ fontSize: 10, fontWeight: 500, padding: "2px 8px", borderRadius: 6, background: "rgba(248,113,113,0.08)", color: "var(--danger)", fontFamily: "var(--font-display)" }}>{s}</span>
                  ))}
                  {m.resume_name && (
                    <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 6, background: "var(--surface2)", color: "var(--text-dim)", fontFamily: "var(--font-display)", marginLeft: "auto" }}>
                      best: {m.resume_name} ↓
                    </span>
                  )}
                </div>
              )}

              {/* Expanded detail */}
              {isExpanded && (
                <div style={{ marginTop: 14, paddingLeft: 68, borderTop: "1px solid var(--border)", paddingTop: 14 }}>
                  {m.llm_recommendation && (
                    <span style={{ ...recommendationStyle(m.llm_recommendation), fontSize: 11, padding: "3px 10px", borderRadius: 20, fontFamily: "var(--font-display)", fontWeight: 500 }}>
                      {m.llm_recommendation}
                    </span>
                  )}
                  {m.llm_summary && (
                    <p style={{ fontSize: 13, color: "var(--text-dim)", lineHeight: 1.65, marginTop: 10, marginBottom: 0 }}>{m.llm_summary}</p>
                  )}
                  {m.job_url && (
                    <a href={m.job_url} target="_blank" rel="noopener noreferrer"
                      onClick={e => e.stopPropagation()}
                      style={{ display: "inline-flex", alignItems: "center", gap: 4, marginTop: 12, height: 28, padding: "0 12px", borderRadius: 8, border: "1px solid var(--border-bright)", background: "var(--surface2)", color: "var(--text)", fontFamily: "var(--font-display)", fontSize: 11, textDecoration: "none", letterSpacing: "0.02em" }}>
                      view job
                      <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 1h6v6M9 1L1 9" strokeLinecap="round"/></svg>
                    </a>
                  )}
                </div>
              )}
            </div>
          </div>
        );
      })}

      {/* Pagination */}
      {totalPages > 1 && (
        <div style={{ display: "flex", justifyContent: "center", gap: 6, marginTop: 16 }}>
          <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}
            style={{ padding: "5px 14px", borderRadius: 8, border: "1px solid var(--border)", background: "transparent", color: page === 1 ? "var(--text-dim)" : "var(--text)", cursor: page === 1 ? "default" : "pointer", fontFamily: "var(--font-display)", fontSize: 11 }}>
            ←
          </button>
          {Array.from({ length: totalPages }, (_, i) => i + 1).map(p => (
            <button key={p} onClick={() => setPage(p)}
              style={{ padding: "5px 10px", borderRadius: 8, border: p === page ? "1px solid var(--accent3)" : "1px solid var(--border)", background: p === page ? "rgba(52,211,153,0.1)" : "transparent", color: p === page ? "var(--accent3)" : "var(--text-dim)", cursor: "pointer", fontFamily: "var(--font-display)", fontSize: 11, minWidth: 30 }}>
              {p}
            </button>
          ))}
          <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages}
            style={{ padding: "5px 14px", borderRadius: 8, border: "1px solid var(--border)", background: "transparent", color: page === totalPages ? "var(--text-dim)" : "var(--text)", cursor: page === totalPages ? "default" : "pointer", fontFamily: "var(--font-display)", fontSize: 11 }}>
            →
          </button>
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
   AUTO MATCHES TAB
   ══════════════════════════════════════════════════════════════ */
/* ══════════════════════════════════════════════════════════════
   TRK MATCH RING — circular score ring (mirrors Dashboard)
   ══════════════════════════════════════════════════════════════ */
function TrkMatchRing({ score, size = 52, strokeW = 3.5 }) {
  const r    = (size / 2) - strokeW;
  const circ = 2 * Math.PI * r;
  const offset = circ * (1 - Math.min(score, 100) / 100);
  const ring = score >= 85 ? 'var(--accent3)'
             : score >= 70 ? 'var(--accent-ink)'
             : score >= 55 ? '#f5a623'
             : 'var(--danger)';
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ flexShrink: 0 }}>
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="var(--ring-track)" strokeWidth={strokeW}/>
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={ring} strokeWidth={strokeW}
        strokeLinecap="round"
        strokeDasharray={circ} strokeDashoffset={offset}
        style={{ transform: 'rotate(-90deg)', transformOrigin: 'center',
          transition: 'stroke-dashoffset 1.1s cubic-bezier(0.22,1,0.36,1)' }}
      />
      <text x={size/2} y={size/2 - 1} textAnchor="middle"
        style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: size * 0.25, fill: 'var(--text)' }}>
        {Math.round(score)}%
      </text>
      <text x={size/2} y={size/2 + size * 0.195} textAnchor="middle"
        style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, fontSize: size * 0.105, letterSpacing: '0.1em', fill: 'var(--text-dim)' }}>
        MATCH
      </text>
    </svg>
  );
}

/* ══════════════════════════════════════════════════════════════
   TRK JOB CARD — squarish card (matches Dashboard JobCard style)
   ══════════════════════════════════════════════════════════════ */
function trkBrandColor(company) {
  const palette = [
    '#635bff','#e0930f','#5b6472','#7c5cff','#7c3aed',
    '#1597c4','#e0492a','#1f6feb','#059669','#dc2626',
    '#0ea5e9','#8b5cf6','#f59e0b','#10b981','#3b82f6',
  ];
  let hash = 0;
  const s = company || '';
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) & 0xffffffff;
  return palette[Math.abs(hash) % palette.length];
}

function TrkJobCard({ match, index, isApplied, isSaved, isNew, onApply, onSave, onViewDetail }) {
  const [hovered, setHovered] = useState(false);

  const score    = Math.round(match.llm_score ?? match.score ?? 0);
  const company  = match.company || '';
  const title    = match.job_title || 'Untitled';
  const location = match.location && match.location !== 'Not specified' ? match.location : 'Remote';
  const posted   = match.posted_at || match.matched_at;
  const skills   = match.matched_skills || [];
  const source   = (match.source || 'greenhouse').toUpperCase();
  const brand    = trkBrandColor(company);
  const initial  = (company || '?').charAt(0).toUpperCase();
  const tierLabel = score >= 85 ? 'Strong match' : score >= 70 ? 'Good match' : score >= 55 ? 'Potential' : 'Weak fit';
  const tierColor = score >= 85 ? 'var(--accent3)' : score >= 70 ? 'var(--accent-ink)' : score >= 55 ? '#f5a623' : 'var(--danger)';
  const shownSkills = skills.slice(0, 2);
  const extraSkills = skills.length > 2 ? skills.length - 2 : 0;

  return (
    <div
      className="trk-job-card"
      onClick={() => onViewDetail && onViewDetail(match)}
      style={{
        borderRadius: 16,
        border: isNew ? '1px solid rgba(232,255,107,0.3)' : '1px solid var(--border)',
        background: 'var(--surface)',
        boxShadow: hovered ? 'var(--card-hover-shadow)' : 'var(--card-shadow)',
        padding: '14px 14px 12px',
        display: 'flex', flexDirection: 'column', gap: 9,
        position: 'relative', cursor: 'pointer', minWidth: 0,
        opacity: 0,
        animation: `fadeUp 0.4s ease ${Math.min(index * 0.04, 0.3)}s forwards`,
        transition: 'border-color 0.2s, box-shadow 0.22s, transform 0.2s',
        transform: hovered ? 'translateY(-3px)' : 'none',
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* New stripe */}
      {isNew && (
        <div style={{
          position: 'absolute', top: 0, left: 0, right: 0, height: 3,
          borderRadius: '16px 16px 0 0',
          background: 'linear-gradient(90deg, var(--accent), #a3e635)',
        }}/>
      )}

      {/* Top: company + ring */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <div style={{
            width: 30, height: 30, borderRadius: 8, flexShrink: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontWeight: 700, fontSize: 12, color: '#fff',
            background: brand, boxShadow: `0 3px 8px ${brand}4d`,
          }}>{initial}</div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 11.5, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: 'var(--text)' }}>
              {company || '—'}
            </div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 8.5, fontWeight: 600, letterSpacing: '0.1em', color: 'var(--text-dim)', marginTop: 1 }}>
              {source}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
          {onSave && (
            <button onClick={(e) => { e.stopPropagation(); onSave(); }} title={isSaved ? 'Saved' : 'Save'}
              style={{
                width: 22, height: 22, borderRadius: 6, border: 'none',
                background: 'transparent', cursor: 'pointer',
                color: isSaved ? 'var(--accent)' : 'var(--text-dim)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 12, transition: 'color 0.15s',
              }}>
              {isSaved ? '★' : '☆'}
            </button>
          )}
          <TrkMatchRing score={score} size={40} strokeW={3} />
        </div>
      </div>

      {/* Title */}
      <div style={{
        fontSize: 13, fontWeight: 600, lineHeight: 1.3, letterSpacing: '-0.01em',
        display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
        overflow: 'hidden', minHeight: 34,
      }}>
        {title}
        {isNew && <span style={{ marginLeft: 6, fontFamily: 'var(--font-mono)', fontSize: 8, fontWeight: 700, color: 'var(--accent)', letterSpacing: '0.12em', textTransform: 'uppercase', verticalAlign: 'middle' }}>new</span>}
        {isApplied && <span style={{ marginLeft: 6, fontFamily: 'var(--font-mono)', fontSize: 8, fontWeight: 700, color: 'var(--accent3)', letterSpacing: '0.12em', textTransform: 'uppercase', verticalAlign: 'middle' }}>applied</span>}
      </div>

      {/* Location + posted */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 11, color: 'var(--text-dim)' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 4, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
          <svg width={9} height={9} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ flexShrink: 0 }}><path d="M8 14s5-4.2 5-8a5 5 0 0 0-10 0c0 3.8 5 8 5 8z"/><circle cx="8" cy="6" r="1.8"/></svg>
          {location.length > 22 ? location.slice(0, 22) + '…' : location}
        </span>
        {posted && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <svg width={9} height={9} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ flexShrink: 0 }}><circle cx="8" cy="8" r="6.2"/><path d="M8 4.5V8l2.4 1.4"/></svg>
            {timeAgo(posted)}
          </span>
        )}
      </div>

      {/* Skills */}
      {shownSkills.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {shownSkills.map((sk, i) => (
            <span key={i} style={{
              fontFamily: 'var(--font-mono)', fontSize: 9.5, color: 'var(--text-mid)',
              background: 'var(--chip-bg)', border: '1px solid var(--chip-border)',
              padding: '2px 7px', borderRadius: 6,
              maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>{sk}</span>
          ))}
          {extraSkills > 0 && (
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, color: 'var(--text-dim)', padding: '2px 3px' }}>+{extraSkills}</span>
          )}
        </div>
      )}

      <div style={{ flex: 1 }}/>
      <div style={{ height: 1, background: 'var(--border)' }}/>

      {/* Footer */}
      {isApplied ? (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
          height: 30, borderRadius: 8,
          background: 'var(--accent-soft)', border: '1px solid var(--accent-line)',
          color: 'var(--accent-ink)', fontSize: 11, fontWeight: 600,
        }}>
          <svg width={12} height={12} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 8.5l3.5 3.5L13 4.5"/></svg>
          Applied
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10.5, fontWeight: 600, color: tierColor }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: tierColor, flexShrink: 0 }}/>
            {tierLabel}
          </span>
          {match.job_url && onApply && (
            <a
              href={match.job_url} target="_blank" rel="noopener noreferrer"
              onClick={(e) => { e.stopPropagation(); onApply(); }}
              style={{
                display: 'flex', alignItems: 'center', gap: 4,
                padding: '0 10px', height: 28, borderRadius: 7,
                border: 'none', background: 'var(--accent)',
                color: 'var(--accent-contrast)', fontFamily: 'var(--font-sans)',
                fontSize: 11.5, fontWeight: 600,
                boxShadow: 'var(--accent-glow)', textDecoration: 'none',
                transition: 'background 0.18s', flexShrink: 0,
              }}
              onMouseEnter={e => e.currentTarget.style.background = 'var(--accent-strong)'}
              onMouseLeave={e => e.currentTarget.style.background = 'var(--accent)'}
            >
              apply ↗
            </a>
          )}
        </div>
      )}
    </div>
  );
}

// ── Job Detail Modal ─────────────────────────────────────────────────────────

function TrkJobDetailModal({ match, onClose, onApply, isApplied, onSave, isSaved }) {
  const score     = Math.round(match.llm_score ?? match.score ?? 0);
  const company   = match.company || '';
  const title     = match.job_title || 'Untitled';
  const location  = match.location && match.location !== 'Not specified' ? match.location : '';
  const posted    = match.posted_at || match.matched_at;
  const skills    = match.matched_skills || [];
  const missing   = match.missing_skills || [];
  const source    = (match.source || 'greenhouse').toUpperCase();
  const brand     = trkBrandColor(company);
  const initial   = (company || '?').charAt(0).toUpperCase();
  const tierLabel = score >= 85 ? 'Strong match' : score >= 70 ? 'Good match' : score >= 55 ? 'Potential' : 'Weak fit';
  const tierColor = score >= 85 ? 'var(--accent3)' : score >= 70 ? 'var(--accent-ink)' : score >= 55 ? '#f5a623' : 'var(--danger)';
  const reasoning = match.llm_reasoning || match.llm_analysis || '';

  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  return createPortal(
    <>
      {/* Backdrop */}
      <div onClick={onClose} style={{
        position: 'fixed', inset: 0, background: 'rgba(4,4,6,0.62)',
        zIndex: 9000, animation: 'rkFadeIn 0.22s ease both',
        backdropFilter: 'blur(4px)',
      }}/>

      {/* Panel — bottom sheet on all screen sizes, matching Dashboard */}
      <div className="trk-detail-panel" style={{
        position: 'fixed', left: 0, right: 0, bottom: 0,
        width: '100%', maxWidth: 'min(760px, 100vw)',
        margin: '0 auto',
        maxHeight: '92dvh',
        background: 'var(--surface)',
        border: '1px solid var(--border-bright)',
        borderRadius: '22px 22px 0 0',
        boxShadow: '0 -16px 60px rgba(0,0,0,0.55)',
        zIndex: 9001, display: 'flex', flexDirection: 'column',
        animation: 'trkSlideUp 0.38s cubic-bezier(0.22,1,0.36,1) both',
        overflow: 'hidden',
        fontFamily: "'DM Sans', sans-serif",
        paddingBottom: 'env(safe-area-inset-bottom, 0px)',
      }}>
        {/* Drag handle */}
        <div style={{ display: 'flex', justifyContent: 'center', padding: '12px 0 4px', flexShrink: 0 }}>
          <div style={{ width: 36, height: 4, borderRadius: 4, background: 'var(--border-bright)' }}/>
        </div>
        {/* ── Header ── */}
        <div style={{ padding: '22px 26px 18px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          {/* Company row + close */}
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 14, marginBottom: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 13 }}>
              <div style={{
                width: 46, height: 46, borderRadius: 12, flexShrink: 0,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontWeight: 700, fontSize: 18, color: '#fff',
                background: brand, boxShadow: `0 6px 18px ${brand}55`,
              }}>{initial}</div>
              <div>
                <div style={{ fontSize: 14.5, fontWeight: 700, color: 'var(--text)' }}>{company}</div>
                <span style={{
                  fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 600,
                  letterSpacing: '0.1em', color: 'var(--text-dim)',
                  background: 'var(--chip-bg)', padding: '2px 7px', borderRadius: 5,
                  display: 'inline-block', marginTop: 3,
                }}>{source}</span>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {onSave && (
                <button onClick={onSave} title={isSaved ? 'Saved' : 'Save'}
                  style={{
                    width: 34, height: 34, borderRadius: 10,
                    border: `1px solid ${isSaved ? 'var(--accent-line)' : 'var(--border-bright)'}`,
                    background: isSaved ? 'var(--accent-soft)' : 'transparent',
                    cursor: 'pointer', color: isSaved ? 'var(--accent)' : 'var(--text-dim)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 16, transition: 'all 0.15s',
                  }}>
                  {isSaved ? '★' : '☆'}
                </button>
              )}
              <button onClick={onClose} style={{
                width: 34, height: 34, borderRadius: 10, border: '1px solid var(--border-bright)',
                background: 'transparent', cursor: 'pointer', color: 'var(--text-dim)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                transition: 'color 0.15s, border-color 0.15s',
              }}
                onMouseEnter={e => { e.currentTarget.style.color = 'var(--text)'; e.currentTarget.style.borderColor = 'var(--text-mid)'; }}
                onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-dim)'; e.currentTarget.style.borderColor = 'var(--border-bright)'; }}
              >
                <svg width={14} height={14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>
              </button>
            </div>
          </div>

          {/* Title */}
          <h2 style={{ fontSize: 20, fontWeight: 700, lineHeight: 1.25, letterSpacing: '-0.02em', margin: '0 0 14px', color: 'var(--text)' }}>
            {title}
          </h2>

          {/* Meta row */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '7px 18px', marginBottom: 14 }}>
            {location && (
              <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12.5, color: 'var(--text-mid)' }}>
                <svg width={12} height={12} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M8 14s5-4.2 5-8a5 5 0 0 0-10 0c0 3.8 5 8 5 8z"/><circle cx="8" cy="6" r="1.8"/></svg>
                {location}
              </span>
            )}
            {posted && (
              <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12.5, color: 'var(--text-dim)' }}>
                <svg width={12} height={12} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2" y="3" width="12" height="11" rx="1.5"/><path d="M11 1.5V4M5 1.5V4M2 7h12"/></svg>
                Posted {timeAgo(posted)}
              </span>
            )}
          </div>

          {/* Score + tier + skills */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <TrkMatchRing score={score} size={52} strokeW={3.5} />
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: tierColor, flexShrink: 0 }}/>
                <span style={{ fontSize: 13, fontWeight: 600, color: tierColor }}>{tierLabel}</span>
              </div>
              {(skills.length > 0 || missing.length > 0) && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                  {skills.slice(0, 5).map((s, i) => (
                    <span key={i} style={{ fontSize: 10, fontWeight: 600, padding: '2px 8px', borderRadius: 20, background: 'rgba(52,211,153,0.1)', color: 'var(--accent3)', border: '1px solid rgba(52,211,153,0.2)' }}>✓ {s}</span>
                  ))}
                  {missing.slice(0, 3).map((s, i) => (
                    <span key={i} style={{ fontSize: 10, fontWeight: 600, padding: '2px 8px', borderRadius: 20, background: 'rgba(248,113,113,0.08)', color: 'var(--danger)', border: '1px solid rgba(248,113,113,0.18)' }}>✗ {s}</span>
                  ))}
                  {skills.length > 5 && <span style={{ fontSize: 10, color: 'var(--text-dim)', padding: '2px 4px' }}>+{skills.length - 5} more</span>}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ── Scrollable body ── */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '22px 26px' }}>
          {/* AI reasoning */}
          {reasoning && (
            <div style={{ marginBottom: 24 }}>
              <h3 style={{
                fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase',
                color: 'var(--text-dim)', margin: '0 0 10px',
                paddingBottom: 7, borderBottom: '1px solid var(--border)',
              }}>RACK Analysis</h3>
              <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.7, color: 'var(--text-mid)', fontStyle: 'italic' }}>
                "{reasoning}"
              </p>
            </div>
          )}

          {/* LLM component scores */}
          {(match.llm_scores || match.component_scores) && (
            <div style={{ marginBottom: 24 }}>
              <h3 style={{
                fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase',
                color: 'var(--text-dim)', margin: '0 0 10px',
                paddingBottom: 7, borderBottom: '1px solid var(--border)',
              }}>Score Breakdown</h3>
              {Object.entries(match.llm_scores || match.component_scores || {}).map(([key, val]) => {
                const display = typeof val === 'object' ? (val.score || val.weighted || 0) : val;
                const pct = Math.min(Math.round(typeof display === 'number' && display <= 1 ? display * 100 : display), 100);
                const label = key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
                return (
                  <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                    <span style={{ fontSize: 12, color: 'var(--text-mid)', minWidth: 100 }}>{label}</span>
                    <div style={{ flex: 1, height: 6, borderRadius: 4, background: 'var(--surface3)', overflow: 'hidden' }}>
                      <div style={{ width: `${pct}%`, height: '100%', background: scoreGradient(pct), borderRadius: 4, transition: 'width 0.6s ease' }}/>
                    </div>
                    <span style={{ fontSize: 11, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)', minWidth: 28, textAlign: 'right' }}>{pct}</span>
                  </div>
                );
              })}
            </div>
          )}

          {/* All matched/missing skills */}
          {(skills.length > 0 || missing.length > 0) && (
            <div style={{ marginBottom: 24 }}>
              <h3 style={{
                fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase',
                color: 'var(--text-dim)', margin: '0 0 10px',
                paddingBottom: 7, borderBottom: '1px solid var(--border)',
              }}>Skills Match</h3>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {skills.map((s, i) => (
                  <span key={i} style={{ fontSize: 11, fontWeight: 600, padding: '3px 10px', borderRadius: 20, background: 'rgba(52,211,153,0.1)', color: 'var(--accent3)', border: '1px solid rgba(52,211,153,0.2)' }}>✓ {s}</span>
                ))}
                {missing.map((s, i) => (
                  <span key={i} style={{ fontSize: 11, fontWeight: 600, padding: '3px 10px', borderRadius: 20, background: 'rgba(248,113,113,0.08)', color: 'var(--danger)', border: '1px solid rgba(248,113,113,0.18)' }}>✗ {s}</span>
                ))}
              </div>
            </div>
          )}

          {/* Best resume */}
          {match.resume_name && (
            <div style={{ marginBottom: 24 }}>
              <h3 style={{
                fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase',
                color: 'var(--text-dim)', margin: '0 0 10px',
                paddingBottom: 7, borderBottom: '1px solid var(--border)',
              }}>Best Matching Resume</h3>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface2)' }}>
                <svg width={14} height={14} viewBox="0 0 16 16" fill="none" stroke="var(--accent-ink)" strokeWidth="1.5" strokeLinecap="round"><rect x="3" y="1.5" width="10" height="13" rx="1.6"/><path d="M6 5h4M6 8h4M6 11h2.5"/></svg>
                <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)' }}>{match.resume_name}</span>
                {match.hybrid_score != null && (
                  <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-dim)' }}>
                    hybrid: {match.hybrid_score}
                  </span>
                )}
              </div>
            </div>
          )}

          {/* No data fallback */}
          {!reasoning && !match.llm_scores && !match.component_scores && skills.length === 0 && (
            <div style={{ textAlign: 'center', padding: '40px 24px', color: 'var(--text-dim)', fontSize: 13 }}>
              Detailed analysis will appear here after the LLM scoring pass completes.
            </div>
          )}
        </div>

        {/* ── Footer ── */}
        <div style={{
          padding: '14px 26px 18px', borderTop: '1px solid var(--border)',
          flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
        }}>
          <div>
            {match.job_url && (
              <a href={match.job_url} target="_blank" rel="noopener noreferrer" style={{
                display: 'flex', alignItems: 'center', gap: 6, fontSize: 12,
                color: 'var(--text-dim)', textDecoration: 'none',
                padding: '7px 12px', borderRadius: 8,
                border: '1px solid var(--border-bright)', background: 'var(--surface2)',
                transition: 'color 0.15s',
              }}
                onMouseEnter={e => e.currentTarget.style.color = 'var(--text)'}
                onMouseLeave={e => e.currentTarget.style.color = 'var(--text-dim)'}
              >
                <svg width={11} height={11} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M7 3H3a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V9M10 2h4v4M8 8l6-6"/></svg>
                View original posting
              </a>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button onClick={onClose} style={{
              padding: '8px 16px', borderRadius: 9, cursor: 'pointer',
              border: '1px solid var(--border-bright)', background: 'transparent',
              color: 'var(--text-mid)', fontFamily: "'DM Sans', sans-serif", fontSize: 12.5, fontWeight: 500,
            }}>Close</button>
            {isApplied ? (
              <div style={{
                display: 'flex', alignItems: 'center', gap: 7,
                padding: '8px 16px', borderRadius: 9,
                background: 'var(--accent-soft)', border: '1px solid var(--accent-line)',
                color: 'var(--accent-ink)', fontSize: 12.5, fontWeight: 600,
              }}>
                <svg width={13} height={13} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 8.5l3.5 3.5L13 4.5"/></svg>
                Applied
              </div>
            ) : (
              match.job_url && (
                <a
                  href={match.job_url} target="_blank" rel="noopener noreferrer"
                  onClick={() => { onApply?.(); onClose(); }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 7,
                    padding: '8px 20px', borderRadius: 9,
                    border: 'none', background: 'var(--accent)',
                    color: 'var(--accent-contrast)', fontFamily: "'DM Sans', sans-serif",
                    fontSize: 13, fontWeight: 600, boxShadow: 'var(--accent-glow)',
                    textDecoration: 'none', transition: 'background 0.18s',
                  }}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--accent-strong)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'var(--accent)'}
                >
                  Apply ↗
                </a>
              )
            )}
          </div>
        </div>
      </div>
    </>,
    document.body
  );
}




const PAGE_SIZE = 10; // 2 rows × 5 cols per page

function AutoMatchesTab({ profile, isPowerUser }) {
  const [matches, setMatches]           = useState([]);
  const [loading, setLoading]           = useState(false);
  const [initializing, setInitializing] = useState(true); // true until first data fetch completes
  const [meta, setMeta]                 = useState(null);
  const [stats, setStats]               = useState(null);
  const [error, setError]               = useState(null);
  const [expandedId, setExpandedId]     = useState(null);
  const [titleFilter, setTitleFilter]   = useState("");
  const [sortBy, setSortBy]             = useState("score_desc");
  const [filterBy, setFilterBy]         = useState("all");
  const [page, setPage]                 = useState(1);
  const [showArchive, setShowArchive]   = useState(false);
  const [archiveCount, setArchiveCount] = useState(() => loadArchive().length);
  const [isSlotView, setIsSlotView]     = useState(false); // true = free user cumulative view
  const [newJobIds, setNewJobIds]       = useState(new Set()); // today's fresh picks
  const [appliedJobs, setAppliedJobs]   = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem("rack_applied_jobs") || "[]")); }
    catch { return new Set(); }
  });
  const [savedJobs, setSavedJobs]       = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem("rack_saved_jobs") || "[]")); }
    catch { return new Set(); }
  });
  const [applyPrompt, setApplyPrompt]   = useState(null); // { job_id, job_title }
  const [dailySlots, setDailySlots]     = useState([]);
  const [slotsIsFresh, setSlotsIsFresh] = useState(false);
  const [expandedSlotId, setExpandedSlotId] = useState(null);
  const [selectedMatch, setSelectedMatch] = useState(null); // for job detail modal
  const pendingApplyRef = useRef(null);
  const hasRun = useRef(false);

  const hasProfile = profile && (profile.target_roles || []).length > 0;
  const mono = { fontFamily: "'JetBrains Mono','Fira Code','Courier New',monospace" };

  const markApplied = async (job_id) => {
    // Optimistic update — immediate UI response
    setAppliedJobs(prev => {
      const next = new Set(prev);
      next.add(job_id);
      localStorage.setItem("rack_applied_jobs", JSON.stringify([...next]));
      return next;
    });
    setApplyPrompt(null);
    pendingApplyRef.current = null;

    // Persist to DB
    try {
      const headers = await getAuthHeaders();
      await fetch(`${API}/auto/${job_id}/applied`, {
        method: "PATCH",
        headers,
      });
    } catch (e) {
      console.warn("Failed to persist applied status to DB:", e);
      // localStorage already updated — user won't notice
    }
  };

  const handleApplyClick = (job_id, job_title) => {
    pendingApplyRef.current = { job_id, job_title };
    const onVisible = () => {
      if (document.visibilityState === "visible" && pendingApplyRef.current) {
        setApplyPrompt({ ...pendingApplyRef.current });
        document.removeEventListener("visibilitychange", onVisible);
      }
    };
    document.addEventListener("visibilitychange", onVisible);
  };

  const toggleSaved = (job_id) => {
    setSavedJobs(prev => {
      const next = new Set(prev);
      next.has(job_id) ? next.delete(job_id) : next.add(job_id);
      localStorage.setItem("rack_saved_jobs", JSON.stringify([...next]));
      return next;
    });
  };

  const loadMeta = useCallback(async () => {
    try {
      const headers = await getAuthHeaders();
      const r = await fetch(`${API}/auto/meta`, { headers });
      if (r.ok) setMeta(await r.json());
    } catch {}
  }, []);

  // Initial load — fires once profile is known (whether or not target roles are set).
  // hasRun.current ensures we only fire once even if profile re-renders.
  useEffect(() => {
    if (profile === null) return; // still loading profile from parent
    if (hasRun.current) return;
    hasRun.current = true;

    (async () => {
      await loadMeta();

      // First load matches (role-aware)
      let isSlot = false;
      try {
        const headers = await getAuthHeaders();
        const mr = await fetch(`${API}/auto/matches`, { headers });
        if (mr.ok) {
          const md = await mr.json();
          isSlot = !!md.is_slot_view;
          if (md.is_slot_view) {
            setIsSlotView(true);
            setMatches(md.matches || []);
            setNewJobIds(new Set((md.matches || []).filter(m => m.is_new).map(m => m.job_id)));
          } else {
            setIsSlotView(false);
            setMatches(Array.isArray(md) ? md : (md.matches || []));
          }
        }
      } catch {}

      // Done initializing — show content now regardless of match count
      setInitializing(false);

      // Daily slots + background refresh only for slot-view users (admin/pro with scheduler).
      // Instant-match users (new onboarding) already have their data — skip these calls.
      if (isSlot) {
        try {
          const headers = await getAuthHeaders();
          const sr = await fetch(`${API}/daily-slots`, { headers });
          if (sr.ok) {
            const sd = await sr.json();
            setDailySlots(sd.slots || []);
            setSlotsIsFresh(sd.is_fresh || false);

            if (sd.is_fresh && sd.slots.length > 0) {
              const headers2 = await getAuthHeaders();
              const mr2 = await fetch(`${API}/auto/matches`, { headers: headers2 });
              if (mr2.ok) {
                const md2 = await mr2.json();
                if (md2.is_slot_view) {
                  setMatches(md2.matches || []);
                  setNewJobIds(new Set((md2.matches || []).filter(m => m.is_new).map(m => m.job_id)));
                }
              }
            }
          }
        } catch {}

        // Silently run pipeline refresh in background (force=false uses cache)
        handleRefresh(false);
      }
    })();
  }, [profile]);

  const handleRefresh = async (force = true) => {
    // Silent background refresh (force=false) never shows the loading animation —
    // it just quietly updates matches in the background after initial data is shown.
    const showSpinner = force;
    if (showSpinner) { setLoading(true); setError(null); setStats(null); setPage(1); }
    try {
      const headers = await getAuthHeaders();
      const r = await fetch(`${API}/auto/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ force }),
      });
      const d = await r.json();

      // After pipeline runs, reload matches (role-aware endpoint)
      const mr = await fetch(`${API}/auto/matches`, { headers });
      const md = await mr.json();

      if (md.is_slot_view) {
        // Free user — cumulative slot view
        setIsSlotView(true);
        setMatches(md.matches || []);
        setNewJobIds(new Set((md.matches || []).filter(m => m.is_new).map(m => m.job_id)));
      } else {
        // Admin/Pro — full list
        setIsSlotView(false);
        setMatches(Array.isArray(md) ? md : (md.matches || []));
        setNewJobIds(new Set());
      }

      if (d.stats) setStats(d.stats);
      await loadMeta();
    } catch (e) { if (showSpinner) setError("Auto pipeline failed: " + e.message); }
    if (showSpinner) setLoading(false);
  };

  const filtered = matches.filter(m => {
    const titleMatch = !titleFilter.trim() || m.job_title?.toLowerCase().includes(titleFilter.toLowerCase());
    const score = m.llm_score ?? m.score ?? 0;
    const scoreMatch =
      filterBy === "all"          ? true :
      filterBy === "85"           ? score >= 85 :
      filterBy === "75"           ? score >= 75 :
      filterBy === "65"           ? score >= 65 :
      filterBy === "strong"       ? m.llm_recommendation === "Strong Match" :
      filterBy === "exceptional"  ? m.llm_recommendation === "Exceptional Fit" :
      filterBy === "saved"        ? savedJobs.has(m.job_id) :
      filterBy === "applied"      ? appliedJobs.has(m.job_id) :
      true;
    return titleMatch && scoreMatch;
  });

  const sorted = [...filtered].sort((a, b) => {
    const sa = a.llm_score ?? a.score ?? 0;
    const sb = b.llm_score ?? b.score ?? 0;
    if (sortBy === "score_desc") return sb - sa;
    if (sortBy === "score_asc")  return sa - sb;
    if (sortBy === "recent")     return new Date(b.posted_at || 0) - new Date(a.posted_at || 0);
    if (sortBy === "oldest")     return new Date(a.posted_at || 0) - new Date(b.posted_at || 0);
    return sb - sa;
  });

  // Reset page when filter/sort changes
  useEffect(() => { setPage(1); }, [titleFilter, sortBy, filterBy]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const paginated  = sorted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const inputStyle = {
    padding: "8px 14px", borderRadius: 30,
    border: "1px solid var(--border)", background: "var(--surface)",
    color: "var(--text)", fontFamily: "var(--font-body)", fontSize: 12, outline: "none",
  };

  // While we're still waiting for the first data fetch, show a single
  // clean loading state. This prevents the flash sequence:
  // "set target roles" → "finding matches" → jobs → loading animation.
  if (initializing) {
    return (
      <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10, padding: "48px 24px", textAlign: "center", animation: "fadeUp 0.35s ease both" }}>
        <div style={{ fontFamily: "var(--font-display)", fontSize: 10, letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--accent)", opacity: 0.7, marginBottom: 16 }}>● scanning</div>
        <div style={{ fontFamily: "var(--font-display)", fontSize: 16, fontWeight: 500, marginBottom: 8, letterSpacing: "-0.01em" }}>
          finding your matches
        </div>
        <div style={{ fontSize: 13, color: "var(--text-dim)", maxWidth: 380, margin: "0 auto", lineHeight: 1.6 }}>
          We're scanning top tech companies and scoring the best roles for your resumes. Your first picks will appear here soon — check back shortly.
        </div>
      </div>
    );
  }

  return (
    <div>
      {showArchive && <ArchiveModal onClose={() => { setShowArchive(false); setArchiveCount(loadArchive().length); }} />}

      {/* Apply confirmation modal — portal to body so it's always viewport-centered */}
      {applyPrompt && createPortal(
        <div
          onClick={(e) => { if (e.target === e.currentTarget) { setApplyPrompt(null); pendingApplyRef.current = null; } }}
          style={{
            position: "fixed", inset: 0, zIndex: 9999,
            background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)",
            display: "flex", alignItems: "center", justifyContent: "center",
            padding: "20px",
          }}
        >
          <div style={{
            background: "var(--surface)", border: "1px solid var(--border-bright)",
            borderRadius: 20, padding: "28px 28px 24px", maxWidth: 380, width: "100%",
            boxShadow: "0 24px 80px rgba(0,0,0,0.6)",
            animation: "fadeUp 0.22s cubic-bezier(0.22,1,0.36,1) both",
          }}>
            <div style={{ fontFamily: "var(--font-display)", fontSize: 10, letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--text-dim)", marginBottom: 14, textAlign: "center", opacity: 0.6 }}>confirm</div>
            <div style={{ fontSize: 16, fontFamily: "var(--font-display)", fontWeight: 800, marginBottom: 6, letterSpacing: "-0.3px", textAlign: "center" }}>
              Did you apply to this role?
            </div>
            <div style={{
              fontSize: 12, color: "var(--text-dim)", marginBottom: 22, lineHeight: 1.5,
              textAlign: "center", padding: "0 8px",
            }}>
              {applyPrompt.job_title}
            </div>
            <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
              <button
                onClick={() => markApplied(applyPrompt.job_id)}
                style={{
                  flex: 1, padding: "11px 0", borderRadius: 8, border: "none",
                  background: "var(--text)", color: "var(--bg)",
                  fontFamily: "var(--font-display)", fontWeight: 500, fontSize: 12,
                  cursor: "pointer", transition: "opacity 0.15s", letterSpacing: "0.02em",
                }}
              >confirmed applied</button>
              <button
                onClick={() => { setApplyPrompt(null); pendingApplyRef.current = null; }}
                style={{
                  flex: 1, padding: "11px 0", borderRadius: 8,
                  border: "1px solid var(--border)", background: "transparent",
                  color: "var(--text-dim)",
                  fontFamily: "var(--font-display)", fontWeight: 500, fontSize: 12,
                  cursor: "pointer", letterSpacing: "0.02em",
                }}
              >not yet</button>
            </div>
            <button
              onClick={() => { setApplyPrompt(null); pendingApplyRef.current = null; }}
              style={{
                width: "100%", padding: "8px 0", borderRadius: 30, border: "none",
                background: "transparent", color: "var(--text-dim)",
                fontFamily: "var(--font-body)", fontSize: 11,
                cursor: "pointer", opacity: 0.6,
              }}
            >Dismiss</button>
          </div>
        </div>
      , document.body)}

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14, flexWrap: "wrap", gap: 10 }}>
        <div>
          <div style={{ fontSize: 13, color: "var(--text-dim)" }}>
            {isSlotView
              ? matches.length > 0
                ? <>RACK is serving your matches daily · <span style={{ color: "var(--text)", fontWeight: 600 }}>{matches.length}</span> roles unlocked so far{newJobIds.size > 0 && <span style={{ color: "var(--accent)", fontWeight: 700 }}> · {newJobIds.size} new today ✦</span>}</>
                : "Your daily job picks will appear here — RACK serves fresh roles every day"
              : matches.length > 0
                ? <>RACK matched <span style={{ color: "var(--text)", fontWeight: 600 }}>{matches.length}</span> top job roles for your existing resumes{meta?.last_fetch_at && !loading && <span> · updated {timeAgo(meta.last_fetch_at)}</span>}</>
                : "Automatically finds and AI-scores your best-fit jobs from top tech companies"
            }
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button onClick={() => setShowArchive(true)} title="View archive"
            style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 14px", borderRadius: 30, border: "1px solid var(--border)", background: "transparent", color: "var(--text-dim)", cursor: "pointer", transition: "all 0.2s", fontFamily: "'JetBrains Mono','Fira Code','Courier New',monospace", fontSize: 13 }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = "rgba(232,255,107,0.3)"; e.currentTarget.style.color = "var(--accent)"; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.color = "var(--text-dim)"; }}>
            <span style={{ letterSpacing: -1 }}>╔═╗</span>
            {archiveCount > 0 && (
              <span style={{ fontSize: 9, fontWeight: 700, padding: "1px 5px", borderRadius: 10, background: "rgba(232,255,107,0.12)", color: "var(--accent)", border: "1px solid rgba(232,255,107,0.2)" }}>{archiveCount}</span>
            )}
          </button>
          {isPowerUser && (
            <button onClick={() => handleRefresh(true)} disabled={loading}
              title="Scan for new jobs"
              style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 16px", borderRadius: 8, border: "1px solid var(--border-bright)", background: "transparent", color: "var(--text)", fontFamily: "var(--font-display)", fontWeight: 500, fontSize: 11, cursor: loading ? "default" : "pointer", opacity: loading ? 0.5 : 1, transition: "all 0.2s", letterSpacing: "0.02em" }}>
              {loading ? <><span style={{ display: "inline-block", animation: "spin 1s linear infinite" }}>⟳</span> Scanning…</> : "⟳ Refresh"}
            </button>
          )}
        </div>
      </div>

      {/* ── Daily Slots Banner — only for slot-view users (admin/pro with scheduled pipeline) ── */}
      {isSlotView && dailySlots.length > 0 && slotsIsFresh && (
        <div style={{ marginBottom: 20, animation: "fadeUp 0.4s ease both" }}>
          <div style={{
            display: "flex", alignItems: "center", gap: 8, marginBottom: 12,
            padding: "9px 16px",
            background: "rgba(232,255,107,0.06)",
            border: "1px solid rgba(232,255,107,0.18)",
            borderRadius: 12,
          }}>
            <span style={{ fontFamily: "var(--font-display)", fontSize: 10, color: "var(--accent)", letterSpacing: "0.12em" }}>●</span>
            <span style={{ fontFamily: "var(--font-display)", fontSize: 12, fontWeight: 500, color: "var(--text)", letterSpacing: "-0.01em" }}>
              RACK found {dailySlots.length} new roles for you today
            </span>
            <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-dim)", ...mono }}>
              {new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" })}
            </span>
          </div>

          {dailySlots.map((slot, i) => {
            const m = slot.job_data || {};
            const score = slot.score ?? 0;
            const sc = scoreColor(score);
            const isScore   = slot.rank_reason === "score";
            const slotKey   = slot.job_id || i;
            const slotExpanded = expandedSlotId === slotKey;
            return (
              <div
                key={slotKey}
                onClick={() => setExpandedSlotId(slotExpanded ? null : slotKey)}
                style={{
                  background: "var(--surface)",
                  border: `1px solid ${isScore ? "rgba(232,255,107,0.25)" : "rgba(52,211,153,0.22)"}`,
                  borderLeft: `3px solid ${isScore ? "var(--accent)" : "var(--accent3)"}`,
                  borderRadius: 14, padding: 0, marginBottom: 8, cursor: "pointer",
                  transition: "all 0.2s", overflow: "hidden",
                  animation: `fadeUp 0.4s ease ${Math.min(i * 0.04, 0.2)}s forwards`,
                  opacity: 0,
                }}
              >
                {/* Score bar */}
                <div style={{ height: 2, background: scoreGradient(score), width: `${Math.min(score, 100)}%`, transition: "width 0.8s cubic-bezier(0.22,1,0.36,1)" }} />

                <div style={{ padding: "14px 18px" }}>
                  <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                    {/* NEW badge */}
                    <div style={{
                      flexShrink: 0, marginTop: 2,
                      fontSize: 8, fontWeight: 800, padding: "3px 7px", borderRadius: 20,
                      letterSpacing: "0.12em", textTransform: "uppercase",
                      background: isScore ? "rgba(232,255,107,0.12)" : "rgba(52,211,153,0.12)",
                      color: isScore ? "var(--accent)" : "var(--accent3)",
                      border: `1px solid ${isScore ? "rgba(232,255,107,0.25)" : "rgba(52,211,153,0.25)"}`,
                    }}>
                      {isScore ? "top" : "new"}
                    </div>

                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontFamily: "var(--font-display)", fontSize: 14, fontWeight: 700, color: "var(--text)", letterSpacing: "-0.3px", wordBreak: "break-word" }}>
                        {m.job_title || "Untitled"}
                      </div>
                      <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 3, display: "flex", gap: 6, flexWrap: "wrap" }}>
                        {m.company && <span style={{ fontWeight: 500 }}>{m.company.charAt(0).toUpperCase() + m.company.slice(1)}</span>}
                        {m.location && m.location !== "Not specified" && <span>· {m.location.length > 40 ? m.location.slice(0, 40) + "…" : m.location}</span>}
                        {m.posted_at && <span>· {timeAgo(m.posted_at)}</span>}
                      </div>
                    </div>

                    <div style={{ textAlign: "right", flexShrink: 0 }}>
                      <div style={{ fontFamily: "var(--font-display)", fontSize: 20, fontWeight: 800, color: sc, letterSpacing: "-1px", lineHeight: 1 }}>
                        {Math.round(score)}%
                      </div>
                      {sourceBadge(m.source)}
                    </div>
                  </div>

                  {/* Skills pills */}
                  {((m.matched_skills || []).length > 0 || (m.missing_skills || []).length > 0) && (
                    <div style={{ display: "flex", gap: 5, marginTop: 10, flexWrap: "wrap" }}>
                      {(m.matched_skills || []).slice(0, 3).map(s => (
                        <span key={s} style={{ fontSize: 10, fontWeight: 600, padding: "3px 9px", borderRadius: 20, background: "rgba(52,211,153,0.1)", color: "var(--accent3)" }}>✓ {s}</span>
                      ))}
                      {(m.missing_skills || []).slice(0, 2).map(s => (
                        <span key={s} style={{ fontSize: 10, fontWeight: 600, padding: "3px 9px", borderRadius: 20, background: "rgba(248,113,113,0.1)", color: "var(--danger)" }}>✗ {s}</span>
                      ))}
                    </div>
                  )}

                  {/* Expanded: apply link */}
                  {slotExpanded && m.url && (
                    <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--border)", animation: "fadeUp 0.2s ease both", display: "flex", gap: 10 }}>
                      <a
                        href={m.url} target="_blank" rel="noopener noreferrer"
                        onClick={e => { e.stopPropagation(); handleApplyClick(slot.job_id, m.job_title); }}
                        style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "7px 16px", borderRadius: 8, background: "var(--text)", color: "var(--bg)", fontFamily: "var(--font-display)", fontWeight: 500, fontSize: 11, textDecoration: "none", letterSpacing: "0.02em" }}
                      >
                        Apply ↗
                      </a>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {stats && !stats.from_cache && stats.new_processed > 0 && (
        <div style={{ background: "rgba(52,211,153,0.05)", border: "1px solid rgba(52,211,153,0.12)", borderRadius: 12, padding: "9px 16px", fontSize: 12, color: "var(--accent3)", marginBottom: 14, animation: "fadeUp 0.3s ease both", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span>✦</span>
          <span>{stats.total_pool} jobs fetched → {stats.role_matched} role-matched → {stats.new_processed} matched</span>
          {stats.llm_scored > 0 && (
            <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--accent)", background: "rgba(232,255,107,0.08)", border: "1px solid rgba(232,255,107,0.2)", borderRadius: 20, padding: "2px 9px", fontWeight: 600 }}>
              ✦ {stats.llm_scored} AI-scored
            </span>
          )}
        </div>
      )}
      {error && (
        <div style={{ background: "rgba(248,113,113,0.06)", border: "1px solid rgba(248,113,113,0.15)", borderRadius: 14, padding: "10px 16px", fontSize: 12, color: "var(--danger)", marginBottom: 14, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          {error}<button onClick={() => setError(null)} style={{ background: "none", border: "none", color: "var(--danger)", cursor: "pointer", fontSize: 13, padding: 0 }}>✕</button>
        </div>
      )}

      {matches.length > 0 && (
        <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
          {/* Search */}
          <input
            type="text"
            value={titleFilter}
            onChange={e => setTitleFilter(e.target.value)}
            placeholder="Search by title…"
            style={{ ...inputStyle, flex: "1 1 180px" }}
          />

          {/* Sort By dropdown */}
          <div style={{ position: "relative", flexShrink: 0 }}>
            <select
              value={sortBy}
              onChange={e => setSortBy(e.target.value)}
              style={{
                ...inputStyle,
                paddingRight: 32,
                appearance: "none",
                WebkitAppearance: "none",
                cursor: "pointer",
                background: sortBy !== "score_desc"
                  ? "rgba(232,255,107,0.06)"
                  : "var(--surface)",
                color: sortBy !== "score_desc"
                  ? "var(--accent)"
                  : "var(--text-dim)",
                border: sortBy !== "score_desc"
                  ? "1px solid rgba(232,255,107,0.28)"
                  : "1px solid var(--border)",
                transition: "all 0.18s",
                minWidth: 148,
              }}
            >
              <option value="score_desc">↓ Score: High → Low</option>
              <option value="score_asc">↑ Score: Low → High</option>
              <option value="recent">⏱ Recency: Newest first</option>
              <option value="oldest">⏱ Recency: Oldest first</option>
            </select>
            <span style={{
              position: "absolute", right: 11, top: "50%", transform: "translateY(-50%)",
              pointerEvents: "none", fontSize: 10,
              color: sortBy !== "score_desc" ? "var(--accent)" : "var(--text-dim)",
            }}>▾</span>
          </div>

          {/* Filter By dropdown */}
          <div style={{ position: "relative", flexShrink: 0 }}>
            <select
              value={filterBy}
              onChange={e => setFilterBy(e.target.value)}
              style={{
                ...inputStyle,
                paddingRight: 32,
                appearance: "none",
                WebkitAppearance: "none",
                cursor: "pointer",
                background: filterBy === "saved"
                  ? "rgba(232,255,107,0.07)"
                  : filterBy === "applied"
                  ? "rgba(52,211,153,0.07)"
                  : filterBy !== "all"
                  ? "rgba(52,211,153,0.06)"
                  : "var(--surface)",
                color: filterBy === "saved"
                  ? "var(--accent)"
                  : filterBy === "applied"
                  ? "#34d399"
                  : filterBy !== "all"
                  ? "#34d399"
                  : "var(--text-dim)",
                border: filterBy === "saved"
                  ? "1px solid rgba(232,255,107,0.28)"
                  : filterBy === "applied"
                  ? "1px solid rgba(52,211,153,0.3)"
                  : filterBy !== "all"
                  ? "1px solid rgba(52,211,153,0.28)"
                  : "1px solid var(--border)",
                transition: "all 0.18s",
                minWidth: 164,
              }}
            >
              <option value="all">⊙ All matches</option>
              <option value="saved">★ Saved</option>
              <option value="applied">✓ Applied</option>
              <option value="85">↑ 85%+ · Strong only</option>
              <option value="75">↑ 75%+ · Good &amp; above</option>
              <option value="65">↑ 65%+ · Partial &amp; above</option>
              <option value="strong">✦ Strong Match label</option>
              <option value="exceptional">⚡ Exceptional Fit label</option>
            </select>
            <span style={{
              position: "absolute", right: 11, top: "50%", transform: "translateY(-50%)",
              pointerEvents: "none", fontSize: 10,
              color: filterBy === "saved" ? "var(--accent)" : filterBy !== "all" ? "#34d399" : "var(--text-dim)",
            }}>▾</span>
          </div>

          <span style={{ fontSize: 11, color: "var(--text-dim)", fontFamily: "'JetBrains Mono',monospace", flexShrink: 0 }}>
            {sorted.length} jobs · p.{page}/{totalPages}
          </span>
        </div>
      )}

      {loading && <AutoMatchLoadingAnimation />}

      {!loading && matches.length > 0 && sorted.length === 0 && (
        <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10, padding: "36px 24px", textAlign: "center", animation: "fadeUp 0.25s ease both" }}>
          <div style={{ fontFamily: "var(--font-display)", fontSize: 10, letterSpacing: "0.18em", color: "var(--text-dim)", marginBottom: 10, opacity: 0.5 }}>[ no results ]</div>
          <div style={{ fontSize: 13, color: "var(--text-dim)", marginBottom: 14 }}>No matches for the current filters.</div>
          <button
            onClick={() => { setFilterBy("all"); setTitleFilter(""); }}
            style={{ padding: "7px 18px", borderRadius: 8, border: "1px solid var(--border-bright)", background: "transparent", color: "var(--text)", fontFamily: "var(--font-display)", fontWeight: 500, fontSize: 11, cursor: "pointer", letterSpacing: "0.02em" }}
          >
            clear filters
          </button>
        </div>
      )}

      {!loading && matches.length === 0 && (
        <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10, padding: "48px 24px", textAlign: "center", animation: "fadeUp 0.35s ease both" }}>
          {isPowerUser ? (
            <>
              <div style={{ fontFamily: "var(--font-display)", fontSize: 10, letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--text-dim)", marginBottom: 16, opacity: 0.6 }}>[ no matches ]</div>
              <div style={{ fontFamily: "var(--font-display)", fontSize: 16, fontWeight: 500, marginBottom: 8, letterSpacing: "-0.01em" }}>No matches yet</div>
              <div style={{ fontSize: 13, color: "var(--text-dim)", maxWidth: 380, margin: "0 auto 20px", lineHeight: 1.6 }}>
                Hit "Refresh" to scan top tech companies and surface your best-matched {profile?.target_roles?.[0] || "role"} openings.
              </div>
              <button onClick={() => handleRefresh(true)} disabled={loading}
                style={{ padding: "9px 22px", borderRadius: 8, border: "1px solid var(--border-bright)", background: "transparent", color: "var(--text)", fontFamily: "var(--font-display)", fontWeight: 500, fontSize: 11, cursor: "pointer", letterSpacing: "0.02em" }}>
                ⟳ refresh
              </button>
            </>
          ) : (
            <>
              <div style={{ fontFamily: "var(--font-display)", fontSize: 10, letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--accent)", opacity: 0.7, marginBottom: 16 }}>● scanning</div>
              <div style={{ fontFamily: "var(--font-display)", fontSize: 16, fontWeight: 500, marginBottom: 8, letterSpacing: "-0.01em" }}>
                finding your matches
              </div>
              <div style={{ fontSize: 13, color: "var(--text-dim)", maxWidth: 380, margin: "0 auto", lineHeight: 1.6 }}>
                We're scanning top tech companies and scoring the best roles for your resumes. Your first picks will appear here soon — check back shortly.
              </div>
            </>
          )}
        </div>
      )}

      {!loading && paginated.length > 0 && (
        <div className="trk-job-grid" style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(5, 1fr)',
          gap: 14,
          marginBottom: 8,
        }}>
          {paginated.map((m, i) => {
            const isNew = isSlotView && newJobIds.has(m.job_id);
            return (
              <TrkJobCard
                key={m.job_id}
                match={m}
                index={(page - 1) * PAGE_SIZE + i}
                isNew={isNew}
                isApplied={appliedJobs.has(m.job_id)}
                isSaved={savedJobs.has(m.job_id)}
                onApply={() => handleApplyClick(m.job_id, m.job_title)}
                onSave={() => toggleSaved(m.job_id)}
                onViewDetail={setSelectedMatch}
              />
            );
          })}
        </div>
      )}

      {/* Job Detail Modal */}
      {selectedMatch && (
        <TrkJobDetailModal
          match={selectedMatch}
          onClose={() => setSelectedMatch(null)}
          onApply={() => handleApplyClick(selectedMatch.job_id, selectedMatch.job_title)}
          isApplied={appliedJobs.has(selectedMatch.job_id)}
          onSave={() => toggleSaved(selectedMatch.job_id)}
          isSaved={savedJobs.has(selectedMatch.job_id)}
        />
      )}

      {!loading && <Paginator page={page} totalPages={totalPages} onPage={p => { setPage(p); setExpandedId(null); }} />}
      {!loading && sorted.length > 0 && (
        <div style={{ textAlign: "center", marginTop: 10, fontSize: 10, color: "var(--text-dim)", fontFamily: "'JetBrains Mono',monospace" }}>
          showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, sorted.length)} of {sorted.length} matches
          {filterBy !== "all" && <span style={{ color: "#34d399", marginLeft: 6 }}>· filtered</span>}
        </div>
      )}
    </div>
  );
}


/* ══════════════════════════════════════════════════════════════════
   CUSTOM SEARCH TAB (original watchlist flow)
   ══════════════════════════════════════════════════════════════════ */
function CustomSearchTab({ profile }) {
  const [stats, setStats] = useState({});
  const [presets, setPresets] = useState([]);
  const [watchlist, setWatchlist] = useState({ companies: [], settings: {} });
  const [matches, setMatches] = useState([]);
  const [expandedId, setExpandedId] = useState(null);

  const [refreshing, setRefreshing] = useState(false);
  const [loadingWl, setLoadingWl] = useState(false);
  const [error, setError] = useState(null);
  const [pipelineStats, setPipelineStats] = useState(null);
  const [showSettings, setShowSettings] = useState(false);

  const [titleFilter, setTitleFilter] = useState("");
  const [dateFilter, setDateFilter] = useState("all");
  const [companyFilter, setCompanyFilter] = useState("all");

  const [customToken, setCustomToken] = useState("");
  const [customSource, setCustomSource] = useState("greenhouse");

  const hasRun = useRef(false);

  const [matchesLoaded, setMatchesLoaded] = useState(false);

  const loadStats = useCallback(async () => {
    try { const r = await fetch(`${API}/stats`); if (r.ok) setStats(await r.json()); } catch {}
  }, []);
  const loadPresets = useCallback(async () => {
    try { const r = await fetch(`${API}/presets`); if (r.ok) setPresets(await r.json()); } catch {}
  }, []);
  const loadWatchlist = useCallback(async () => {
    try { const r = await fetch(`${API}/watchlist`); if (r.ok) setWatchlist(await r.json()); } catch {}
  }, []);
  const loadMatches = useCallback(async () => {
    try {
      const r = await fetch(`${API}/matches?limit=50`);
      if (r.ok) { const d = await r.json(); setMatches(Array.isArray(d) ? d : []); }
    } catch {}
    setMatchesLoaded(true); // Mark as loaded regardless of result
  }, []);

  useEffect(() => {
    loadStats(); loadPresets(); loadWatchlist(); loadMatches();
  }, []);

  // Auto-refresh only when: matches are confirmed loaded from backend AND still empty
  // This prevents firing on every remount because matchesLoaded starts false
  useEffect(() => {
    if (hasRun.current) return;
    if (!matchesLoaded) return; // Wait until we've actually checked backend
    const companies = watchlist.companies || [];
    if (companies.length > 0 && matches.length === 0 && !refreshing) {
      hasRun.current = true;
      handleRefresh(false);
    }
  }, [matchesLoaded, watchlist.companies?.length, matches.length]);

  const handleRefresh = async (force = true) => {
    setRefreshing(true); setError(null); setPipelineStats(null);
    try {
      const body = {
        limit: 20, force_fetch: force, use_profile: true,
        date_filter: dateFilter !== "all" ? dateFilter : null,
      };
      const r = await fetch(`${API}/refresh`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (d.matches) setMatches(d.matches);
      if (d.stats) setPipelineStats(d.stats);
      if (d.status === "no_companies") setError(d.message);
      await Promise.all([loadStats(), loadPresets()]);
    } catch (e) {
      setError("Pipeline failed: " + e.message);
    }
    setRefreshing(false);
  };

  const refresh = () => Promise.all([loadWatchlist(), loadPresets(), loadStats()]);

  const handleAdd = async (p) => {
    setLoadingWl(true); setError(null);
    try {
      const r = await fetch(`${API}/watchlist`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(p) });
      if (!r.ok) throw new Error("Failed to add");
      await refresh();
    } catch (e) { setError(e.message); }
    setLoadingWl(false);
  };

  const handleCustomAdd = (e) => {
    e.preventDefault();
    if (customToken.trim()) {
      handleAdd({ company: customToken.trim().toLowerCase(), source: customSource, label: customToken.trim() });
      setCustomToken("");
    }
  };

  const handleRemove = async (c) => {
    setLoadingWl(true);
    try {
      await fetch(`${API}/watchlist`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ company: c.company, source: c.source }) });
      await refresh();
    } catch (e) { setError(e.message); }
    setLoadingWl(false);
  };

  const filtered = matches.filter((m) => {
    if (titleFilter.trim() && !m.job_title?.toLowerCase().includes(titleFilter.toLowerCase())) return false;
    if (companyFilter !== "all" && m.company?.toLowerCase() !== companyFilter.toLowerCase()) return false;
    return true;
  });

  const hasCompanies = (watchlist.companies || []).length > 0;
  const hasProfile = profile && (profile.target_roles || []).length > 0;
  const companies = watchlist.companies || [];
  const uniqueCompanies = [...new Set(matches.map(m => m.company))];

  const inputStyle = {
    padding: "8px 14px", borderRadius: 30,
    border: "1px solid var(--border)", background: "var(--surface)",
    color: "var(--text)", fontFamily: "var(--font-body)", fontSize: 12, outline: "none",
  };

  return (
    <div>
      {/* Header row */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 14, gap: 10, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 13, color: "var(--text-dim)" }}>
            {matches.length > 0
              ? `${matches.length} matches from ${uniqueCompanies.length} ${uniqueCompanies.length === 1 ? "company" : "companies"}`
              : "Select companies and hit Refresh to match"
            }
            {pipelineStats?.fetched_fresh && (
              <span style={{ color: "var(--accent3)" }}> · Fresh data</span>
            )}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {/* Settings toggle */}
          <button
            onClick={() => setShowSettings(!showSettings)}
            style={{
              padding: "8px 16px", borderRadius: 30,
              border: "1px solid var(--border)", background: showSettings ? "var(--surface2)" : "transparent",
              color: "var(--text-dim)", fontFamily: "var(--font-body)", fontSize: 12,
              fontWeight: 500, cursor: "pointer", transition: "all 0.2s",
            }}
          >
            ⚙ {companies.length > 0 ? companies.length : ""} {companies.length === 1 ? "company" : "companies"}
          </button>
          {/* Refresh button */}
          <button
            onClick={() => handleRefresh(true)}
            disabled={refreshing || !hasCompanies}
            style={{
              display: "flex", alignItems: "center", gap: 6,
              padding: "8px 20px", borderRadius: 30, border: "none",
              background: hasCompanies ? "var(--accent)" : "var(--surface2)",
              color: hasCompanies ? "#000" : "var(--text-dim)",
              fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 13,
              cursor: hasCompanies ? "pointer" : "default",
              opacity: refreshing ? 0.6 : 1, transition: "all 0.2s", letterSpacing: "-0.01em",
            }}
          >
            {refreshing
              ? <><span style={{ display: "inline-block", animation: "spin 1s linear infinite" }}>⟳</span> Scanning…</>
              : "⟳ Refresh"
            }
          </button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div style={{
          background: "rgba(248,113,113,0.06)", border: "1px solid rgba(248,113,113,0.15)",
          borderRadius: 14, padding: "10px 16px", fontSize: 12, color: "var(--danger)",
          marginBottom: 14, display: "flex", justifyContent: "space-between", alignItems: "center",
          animation: "fadeUp 0.3s ease both",
        }}>
          {error}
          <button onClick={() => setError(null)} style={{ background: "none", border: "none", color: "var(--danger)", cursor: "pointer", fontSize: 13, padding: 0 }}>✕</button>
        </div>
      )}

      {/* Pipeline stats toast */}
      {pipelineStats && pipelineStats.new_processed > 0 && (
        <div style={{
          background: "rgba(52,211,153,0.05)", border: "1px solid rgba(52,211,153,0.12)",
          borderRadius: 12, padding: "9px 16px", fontSize: 12, color: "var(--accent3)",
          marginBottom: 14, animation: "fadeUp 0.3s ease both",
          display: "flex", alignItems: "center", gap: 8,
        }}>
          <span>✓</span>
          <span>
            {pipelineStats.total_fetched} fetched → {pipelineStats.after_profile} after filters → {pipelineStats.new_processed} scored
          </span>
          <span style={{ color: "var(--text-dim)", fontSize: 11 }}>
            · {pipelineStats.total_matches} total matches
          </span>
        </div>
      )}

      {/* Settings panel */}
      {showSettings && (
        <div style={{
          background: "var(--surface)", border: "1px solid var(--border)",
          borderRadius: 16, padding: "20px 22px", marginBottom: 18,
          animation: "fadeUp 0.25s ease both",
        }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
            <div style={{ fontFamily: "var(--font-display)", fontSize: 15, fontWeight: 700, letterSpacing: "-0.3px" }}>
              Watchlist
            </div>
            <div style={{
              display: "flex", alignItems: "center", gap: 6,
              padding: "4px 10px", borderRadius: 20,
              background: hasProfile ? "rgba(52,211,153,0.06)" : "rgba(248,113,113,0.06)",
              border: hasProfile ? "1px solid rgba(52,211,153,0.12)" : "1px solid rgba(248,113,113,0.12)",
            }}>
              <div style={{
                width: 6, height: 6, borderRadius: "50%", flexShrink: 0,
                background: hasProfile ? "var(--accent3)" : "var(--danger)",
                boxShadow: hasProfile ? "0 0 6px var(--accent3)" : "none",
              }} />
              <span style={{ fontSize: 10, fontWeight: 500, color: hasProfile ? "var(--accent3)" : "var(--text-dim)" }}>
                {hasProfile ? `${profile.target_roles.length} roles` : "No profile"}
              </span>
            </div>
          </div>

          <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 6 }}>Quick add:</div>
          <PresetChips presets={presets} onAdd={handleAdd} loading={loadingWl} />

          <form onSubmit={handleCustomAdd} style={{ display: "flex", gap: 7, marginBottom: 14, flexWrap: "wrap" }}>
            <input
              type="text" value={customToken}
              onChange={(e) => setCustomToken(e.target.value)}
              placeholder="Board token (e.g. openai)"
              style={{ ...inputStyle, flex: "1 1 140px" }}
            />
            <select value={customSource} onChange={(e) => setCustomSource(e.target.value)} style={inputStyle}>
              <option value="greenhouse">Greenhouse</option>
              <option value="lever">Lever</option>
            </select>
            <button
              type="submit" disabled={!customToken.trim() || loadingWl}
              style={{
                padding: "8px 16px", borderRadius: 30, border: "none",
                background: customToken.trim() ? "var(--accent)" : "var(--surface2)",
                color: customToken.trim() ? "#000" : "var(--text-dim)",
                fontWeight: 600, fontSize: 12, cursor: customToken.trim() ? "pointer" : "default",
                fontFamily: "var(--font-body)", transition: "all 0.2s",
              }}
            >Add</button>
          </form>

          {companies.length > 0 && (
            <div style={{ borderTop: "1px solid var(--border)", paddingTop: 10 }}>
              {companies.map((c, i) => (
                <div key={`${c.company}-${c.source}`} style={{
                  display: "flex", alignItems: "center", gap: 10, padding: "8px 0",
                  borderBottom: i < companies.length - 1 ? "1px solid var(--border)" : "none",
                }}>
                  <div style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--accent3)", boxShadow: "0 0 6px var(--accent3)", flexShrink: 0 }} />
                  <span style={{ flex: 1, fontSize: 13, fontWeight: 500, color: "var(--text)" }}>
                    {c.label || c.company}
                  </span>
                  {sourceBadge(c.source)}
                  <button onClick={() => handleRemove(c)} disabled={loadingWl} style={{
                    background: "none", border: "none", color: "var(--danger)",
                    cursor: "pointer", fontSize: 11, padding: "2px 6px",
                  }}>✕</button>
                </div>
              ))}
            </div>
          )}

          {companies.length === 0 && (
            <div style={{ textAlign: "center", padding: "18px 0", color: "var(--text-dim)", fontSize: 13 }}>
              Add companies above to start tracking job postings.
            </div>
          )}
        </div>
      )}

      {/* Filters bar */}
      {matches.length > 0 && (
        <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap", alignItems: "center", animation: "fadeUp 0.35s ease 0.05s both" }}>
          <select value={companyFilter} onChange={(e) => setCompanyFilter(e.target.value)} style={inputStyle}>
            <option value="all">All companies</option>
            {uniqueCompanies.map(c => (
              <option key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</option>
            ))}
          </select>
          <select value={dateFilter} onChange={(e) => setDateFilter(e.target.value)} style={inputStyle}>
            <option value="all">All dates</option>
            <option value="24h">Last 24h</option>
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
          </select>
          <input
            type="text" value={titleFilter}
            onChange={(e) => setTitleFilter(e.target.value)}
            placeholder="Search by title…"
            style={{ ...inputStyle, flex: "1 1 120px" }}
          />
          <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{filtered.length} of {matches.length}</span>
        </div>
      )}

      {/* Loading state */}
      {refreshing && (
        <div style={{ textAlign: "center", padding: "60px 20px", color: "var(--text-dim)", animation: "fadeUp 0.3s ease both" }}>
          <div style={{
            width: 40, height: 40, border: "3px solid var(--spinner-track)",
            borderTopColor: "var(--accent)", borderRadius: "50%",
            animation: "spin 0.8s linear infinite", margin: "0 auto 16px",
          }} />
          <div style={{ fontFamily: "var(--font-display)", fontSize: 15, fontWeight: 700, color: "var(--accent)", marginBottom: 4 }}>
            Scanning for matches…
          </div>
          <div style={{ fontSize: 12 }}>Fetching jobs → Filtering by profile → Running RACK pipeline</div>
        </div>
      )}

      {/* Empty states */}
      {!refreshing && matches.length === 0 && !hasCompanies && (
        <div style={{
          background: "var(--surface)", border: "1px solid var(--border)",
          borderRadius: 16, padding: "48px 24px", textAlign: "center",
          animation: "fadeUp 0.35s ease both",
        }}>
          <div style={{ fontFamily: "var(--font-display)", fontSize: 10, letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--text-dim)", marginBottom: 16, opacity: 0.6 }}>◇ no companies</div>
          <div style={{ fontFamily: "var(--font-display)", fontSize: 16, fontWeight: 500, marginBottom: 8, letterSpacing: "-0.01em" }}>
            Start tracking companies
          </div>
          <div style={{ fontSize: 13, color: "var(--text-dim)", maxWidth: 380, margin: "0 auto", lineHeight: 1.6 }}>
            Add companies you're interested in, and RACK will fetch their job postings, match against your resume, and show you the best opportunities.
          </div>
          <button
            onClick={() => setShowSettings(true)}
            style={{
              marginTop: 20, padding: "9px 22px", borderRadius: 8, border: "1px solid var(--border-bright)",
              background: "transparent", color: "var(--text)", fontFamily: "var(--font-display)",
              fontWeight: 500, fontSize: 11, cursor: "pointer", letterSpacing: "0.02em",
            }}
          >
            + add companies
          </button>
        </div>
      )}

      {!refreshing && matches.length === 0 && hasCompanies && (
        <div style={{
          background: "var(--surface)", border: "1px solid var(--border)",
          borderRadius: 10, padding: "48px 24px", textAlign: "center",
          animation: "fadeUp 0.35s ease both",
        }}>
          <div style={{ fontFamily: "var(--font-display)", fontSize: 10, letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--text-dim)", marginBottom: 16, opacity: 0.6 }}>◇ ready</div>
          <div style={{ fontFamily: "var(--font-display)", fontSize: 16, fontWeight: 500, marginBottom: 8, letterSpacing: "-0.01em" }}>
            Ready to scan
          </div>
          <div style={{ fontSize: 13, color: "var(--text-dim)", maxWidth: 380, margin: "0 auto", lineHeight: 1.6, marginBottom: 20 }}>
            You have {companies.length} {companies.length === 1 ? "company" : "companies"} tracked. Hit Refresh to fetch their latest postings and match against your resumes.
          </div>
          <button
            onClick={() => handleRefresh(true)}
            style={{
              padding: "9px 22px", borderRadius: 8, border: "1px solid var(--border-bright)",
              background: "transparent", color: "var(--text)", fontFamily: "var(--font-display)",
              fontWeight: 500, fontSize: 11, cursor: "pointer", letterSpacing: "0.02em",
            }}
          >
            ⟳ refresh now
          </button>
        </div>
      )}

      {!refreshing && filtered.length === 0 && matches.length > 0 && (
        <div style={{
          background: "var(--surface)", border: "1px solid var(--border)",
          borderRadius: 14, padding: "36px 20px", textAlign: "center",
          color: "var(--text-dim)", animation: "fadeUp 0.35s ease both",
        }}>
          <div style={{ fontFamily: "var(--font-display)", fontSize: 10, letterSpacing: "0.18em", color: "var(--text-dim)", marginBottom: 8, opacity: 0.5 }}>[ no results ]</div>
          <div style={{ fontSize: 13 }}>No matches for this filter. Try broadening your search.</div>
        </div>
      )}

      {/* Match cards */}
      {!refreshing && filtered.map((m, i) => (
        <MatchCard
          key={m.job_id}
          match={m}
          index={i}
          expanded={expandedId === m.job_id}
          onToggle={() => setExpandedId(expandedId === m.job_id ? null : m.job_id)}
          isAuto={false}
        />
      ))}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════
   MAIN PAGE
   ══════════════════════════════════════════════════════════════════ */
/* ══════════════════════════════════════════════════════════════════
   REVIEW TAB — batch auto-apply review queue
   Drafts captured by headless Phase 1, waiting for explicit approval.
   Nothing is EVER submitted without the user approving it here.
   ══════════════════════════════════════════════════════════════════ */

function ReviewTab({ onCountChange }) {
  const [jobs, setJobs]                   = useState([]);
  const [loading, setLoading]             = useState(true);
  const [error, setError]                 = useState(null);
  const [deciding, setDeciding]           = useState(new Set());  // job ids with in-flight decision POSTs
  const [editingId, setEditingId]         = useState(null);       // job id in per-field edit mode
  const [editValues, setEditValues]       = useState({});         // { field_label: value } while editing
  const [expandedAnswers, setExpandedAnswers] = useState(new Set());
  const [approvingAll, setApprovingAll]   = useState(false);
  const [recentlySubmitted, setRecentlySubmitted] = useState([]); // [{ id, job_title, company }]
  const [otpInputs, setOtpInputs]         = useState({});         // { job.id: code being typed }
  const [otpSubmitting, setOtpSubmitting] = useState(new Set());  // job ids with in-flight OTP POSTs
  const [needsValues, setNeedsValues]     = useState({});         // `${jobId}::${label}` -> user answer for a field Rack couldn't fill
  const pollRef         = useRef(null);
  const inFlightRef     = useRef(new Map()); // id → {job_title, company} for approved/replaying/awaiting_otp jobs

  const awaiting  = jobs.filter(j => j.status === "awaiting_review");
  const inFlight  = jobs.filter(j => j.status === "approved" || j.status === "replaying");
  const otpJobs   = jobs.filter(j => j.status === "awaiting_otp");
  const attention = jobs.filter(j => j.status === "needs_attention");

  const load = useCallback(async () => {
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(`${API_BASE}/api/apply/review`, { headers });
      if (!res.ok) throw new Error(`Server error (${res.status})`);
      const data = await res.json();
      const list = data.jobs || [];

      // Any job that was approved/replaying last poll and is now gone from the
      // queue has finished Phase 2 — surface it as submitted.
      const liveIds = new Set(list.map(j => j.id));
      const finished = [];
      inFlightRef.current.forEach((meta, id) => {
        if (!liveIds.has(id)) finished.push({ id, ...meta });
      });
      if (finished.length > 0) {
        setRecentlySubmitted(prev => [...prev, ...finished]);
      }
      inFlightRef.current = new Map(
        list.filter(j => j.status === "approved" || j.status === "replaying" || j.status === "awaiting_otp")
            .map(j => [j.id, { job_title: j.job_title, company: j.company }])
      );

      setJobs(list);
      setError(null);
    } catch (e) {
      setError(e.message || "Could not load the review queue.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Tab badge count — single source of truth, recomputed on every jobs change
  // (covers fresh loads, optimistic approve/skip, and poll updates).
  useEffect(() => {
    if (onCountChange) {
      onCountChange(jobs.filter(j =>
        j.status === "awaiting_review" || j.status === "needs_attention" || j.status === "awaiting_otp"
      ).length);
    }
  }, [jobs, onCountChange]);

  // Poll while anything is mid-Phase-2 so "Submitting…" resolves live.
  // 5s (not 8) — the security-code prompt needs to appear promptly, since
  // the emailed code expires and the user is actively waiting.
  useEffect(() => {
    const anyInFlight = jobs.some(j =>
      j.status === "approved" || j.status === "replaying" || j.status === "awaiting_otp"
    );
    if (anyInFlight && !pollRef.current) {
      pollRef.current = setInterval(load, 5000);
    } else if (!anyInFlight && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    };
  }, [jobs, load]);

  const decide = async (job, action, edits = null) => {
    setDeciding(prev => new Set(prev).add(job.id));
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(`${API_BASE}/api/apply/jobs/${job.id}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ action, ...(edits && edits.length > 0 ? { edits } : {}) }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.detail || `Server error (${res.status})`);
      }
      if (action === "approve") {
        // Optimistic: flip to approved so the spinner shows immediately;
        // the poll loop takes over from here.
        inFlightRef.current.set(job.id, { job_title: job.job_title, company: job.company });
        setJobs(prev => prev.map(j => j.id === job.id ? { ...j, status: "approved" } : j));
      } else if (action === "skip") {
        setJobs(prev => prev.filter(j => j.id !== job.id));
      }
      setEditingId(null);
      setEditValues({});
      return true;
    } catch (e) {
      setError(e.message || "Action failed — try again.");
      return false;
    } finally {
      setDeciding(prev => { const n = new Set(prev); n.delete(job.id); return n; });
    }
  };

  const approveAll = async () => {
    setApprovingAll(true);
    // Sequential on purpose — the backend serializes browser work anyway,
    // and sequential POSTs keep the optimistic UI updates orderly.
    for (const job of awaiting) {
      // Can't bulk-approve a job that still needs a required manual answer —
      // leave it for the user to complete individually.
      if (unansweredRequiredNeeds(job).length > 0) continue;
      // eslint-disable-next-line no-await-in-loop
      await decide(job, "approve", collectNeedsEdits(job));
    }
    setApprovingAll(false);
  };

  const startEditing = (job) => {
    const vals = {};
    (job.answers || []).forEach(a => { vals[a.label] = a.value; });
    setEditValues(vals);
    setEditingId(job.id);
  };

  // ── needs_user: required fields Rack couldn't answer ────────────────────
  // The user fills these in the card; their answers ride along as draft edits
  // (merged by field_label server-side, exactly like answer edits).
  const needsKey = (jobId, label) => `${jobId}::${label}`;

  const collectNeedsEdits = (job) => (job.needs_user || [])
    .map(f => {
      const v = (needsValues[needsKey(job.id, f.label)] || "").trim();
      return v ? { field_label: f.field_label || f.label, new_value: v } : null;
    })
    .filter(Boolean);

  const unansweredNeeds = (job) => (job.needs_user || [])
    .filter(f => !(needsValues[needsKey(job.id, f.label)] || "").trim());

  // Only REQUIRED unanswered fields block submit. Optional dropped fields are
  // offered for completeness but never gate the application.
  const unansweredRequiredNeeds = (job) => (job.needs_user || [])
    .filter(f => f.required && !(needsValues[needsKey(job.id, f.label)] || "").trim());

  const approveJob = async (job) => {
    await decide(job, "approve", collectNeedsEdits(job));
  };

  const approveWithEdits = async (job) => {
    const answerEdits = (job.answers || [])
      .filter(a => editValues[a.label] !== undefined && editValues[a.label] !== a.value)
      .map(a => ({ field_label: a.label, new_value: editValues[a.label] }));
    const edits = [...answerEdits, ...collectNeedsEdits(job)];
    await decide(job, "approve", edits);
  };

  const submitOtp = async (job) => {
    const code = (otpInputs[job.id] || "").replace(/[\s-]/g, "").trim();
    if (code.length < 4) return;
    setOtpSubmitting(prev => new Set(prev).add(job.id));
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(`${API_BASE}/api/apply/jobs/${job.id}/otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ code }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.detail || `Server error (${res.status})`);
      }
      // Agent is typing the code and clicking Submit — flip to "Submitting…"
      // immediately; the poll loop resolves the final state.
      inFlightRef.current.set(job.id, { job_title: job.job_title, company: job.company });
      setJobs(prev => prev.map(j => j.id === job.id ? { ...j, status: "replaying", error: null } : j));
      setOtpInputs(prev => { const n = { ...prev }; delete n[job.id]; return n; });
      setError(null);
    } catch (e) {
      setError(e.message || "Could not send the code — try again.");
      // A 409 means the session expired and the backend moved the job back to
      // awaiting_review — refresh so the card reflects reality.
      load();
    } finally {
      setOtpSubmitting(prev => { const n = new Set(prev); n.delete(job.id); return n; });
    }
  };

  /* ── Shared bits ─────────────────────────────────────────────── */

  const btn = (primary) => ({
    padding: "7px 16px", borderRadius: 20, cursor: "pointer", fontFamily: "inherit",
    fontSize: 12, fontWeight: primary ? 600 : 400,
    border: primary ? "1px solid rgba(232,255,107,0.4)" : "1px solid var(--border)",
    background: primary ? "rgba(232,255,107,0.12)" : "transparent",
    color: primary ? "var(--accent)" : "var(--text-dim)",
  });

  const renderAnswerList = (job) => {
    const answers  = job.answers || [];
    const isEditing = editingId === job.id;
    const expanded  = expandedAnswers.has(job.id);
    const shown     = isEditing || expanded ? answers : answers.slice(0, 6);
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
        {shown.map((a, i) => (
          <div key={i} style={{
            display: "flex", flexDirection: "column", gap: 3, padding: "8px 0",
            borderBottom: i < shown.length - 1 ? "1px solid var(--border)" : "none",
          }}>
            <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-dim)" }}>
              {a.label}
            </div>
            {isEditing ? (
              <textarea
                value={editValues[a.label] ?? a.value}
                onChange={e => setEditValues(prev => ({ ...prev, [a.label]: e.target.value }))}
                rows={Math.min(5, Math.max(1, Math.ceil((editValues[a.label] ?? a.value ?? "").length / 80)))}
                style={{
                  width: "100%", boxSizing: "border-box", resize: "vertical",
                  background: "var(--surface2)", border: "1px solid var(--border)",
                  borderRadius: 8, padding: "8px 10px", color: "var(--text)",
                  fontSize: 12, fontFamily: "inherit", lineHeight: 1.5,
                }}
              />
            ) : (
              <div style={{ fontSize: 12.5, color: "var(--text)", fontWeight: 300, lineHeight: 1.55, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                {a.value}
              </div>
            )}
          </div>
        ))}
        {!isEditing && answers.length > 6 && (
          <button
            onClick={() => setExpandedAnswers(prev => {
              const n = new Set(prev);
              n.has(job.id) ? n.delete(job.id) : n.add(job.id);
              return n;
            })}
            style={{
              alignSelf: "flex-start", marginTop: 8, padding: 0, border: "none",
              background: "transparent", color: "var(--accent)", fontSize: 12,
              fontWeight: 500, cursor: "pointer", fontFamily: "inherit",
            }}
          >
            {expanded ? "Show fewer answers" : `Show all ${answers.length} answers`}
          </button>
        )}
      </div>
    );
  };

  // Render function (NOT a nested component — a component identity would change
  // each render and the <input>/<select> would lose focus per keystroke).
  const renderNeedsUser = (job) => {
    const fields = job.needs_user || [];
    if (fields.length === 0) return null;
    const reqCount = fields.filter(f => f.required).length;
    const optCount = fields.length - reqCount;
    const hasReq   = reqCount > 0;
    // Orange/alarming only when something required is missing; otherwise neutral.
    const accent   = hasReq ? "#fb923c" : "var(--text-dim)";
    const header   = hasReq
      ? `Rack couldn't answer ${reqCount} required field${reqCount !== 1 ? "s" : ""} on this form. Please complete ${reqCount !== 1 ? "them" : "it"} before submitting.`
      : `Rack left ${optCount} optional field${optCount !== 1 ? "s" : ""} blank — add ${optCount !== 1 ? "them" : "it"} if you'd like.`;
    return (
      <div style={{
        display: "flex", flexDirection: "column", gap: 10,
        padding: 12, marginTop: 4,
        background: hasReq ? "rgba(251,146,60,0.06)" : "var(--surface2)",
        border: `1px solid ${hasReq ? "rgba(251,146,60,0.35)" : "var(--border)"}`,
        borderRadius: 10,
      }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: accent, lineHeight: 1.4 }}>
          {header}
        </div>
        {fields.map((f, i) => {
          const key     = needsKey(job.id, f.label);
          const val     = needsValues[key] ?? "";
          const hasOpts = Array.isArray(f.options) && f.options.length > 0;
          const inputStyle = {
            width: "100%", boxSizing: "border-box",
            background: "var(--surface2)", border: "1px solid var(--border)",
            borderRadius: 8, padding: "8px 10px", color: "var(--text)",
            fontSize: 12.5, fontFamily: "inherit",
          };
          return (
            <div key={i} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-dim)" }}>
                {f.label}{!f.required && <span style={{ textTransform: "none", letterSpacing: 0, fontWeight: 400, opacity: 0.7 }}> · optional</span>}
              </div>
              {hasOpts ? (
                <select
                  value={val}
                  onChange={e => setNeedsValues(prev => ({ ...prev, [key]: e.target.value }))}
                  style={inputStyle}
                >
                  <option value="">Select…</option>
                  {f.options.map((o, oi) => <option key={oi} value={o}>{o}</option>)}
                </select>
              ) : (
                <input
                  type="text"
                  value={val}
                  placeholder="Type your answer"
                  onChange={e => setNeedsValues(prev => ({ ...prev, [key]: e.target.value }))}
                  style={inputStyle}
                />
              )}
            </div>
          );
        })}
      </div>
    );
  };

  const renderReviewCard = (job) => {
    const isEditing  = editingId === job.id;
    const isDeciding = deciding.has(job.id);
    const isAttention = job.status === "needs_attention";
    const isInFlight  = job.status === "approved" || job.status === "replaying";
    const isOtp       = job.status === "awaiting_otp";
    // Required fields Rack couldn't fill, still unanswered by the user → block submit.
    // Optional dropped fields are offered but never block.
    const needsBlocked = unansweredRequiredNeeds(job).length > 0;
    // While replaying / waiting for the code, the presubmit screenshot is the
    // freshest truth — exactly what is about to be (or was just) submitted.
    const screenshot  = ((isOtp || isInFlight) && job.presubmit_screenshot)
      ? job.presubmit_screenshot
      : ((job.screenshots || [])[0] || job.presubmit_screenshot || job.confirmation_screenshot);

    return (
      <div style={{
        background: "var(--surface)",
        border: `1px solid ${isOtp ? "rgba(232,255,107,0.45)" : isAttention ? "rgba(251,146,60,0.3)" : "var(--border)"}`,
        borderRadius: 12, padding: "16px 18px",
        display: "flex", flexDirection: "column", gap: 12,
      }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 500, color: "var(--text)", lineHeight: 1.4, wordBreak: "break-word" }}>
              {job.job_title || "Unknown role"}
            </div>
            <div style={{ fontSize: 12, color: "var(--text-dim)", fontWeight: 300, marginTop: 2 }}>
              {job.company}
              {job.job_url && (
                <a href={job.job_url} target="_blank" rel="noopener noreferrer"
                   style={{ color: "var(--accent)", textDecoration: "none", marginLeft: 8, fontWeight: 500 }}>
                  View posting ↗
                </a>
              )}
            </div>
          </div>
          {isInFlight ? (
            <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, fontWeight: 600, color: "var(--accent3)", flexShrink: 0 }}>
              <span style={{
                width: 9, height: 9, borderRadius: "50%", display: "inline-block",
                border: "2px solid var(--accent3)", borderTopColor: "transparent",
                animation: "spin 0.7s linear infinite",
              }} />
              Submitting…
            </span>
          ) : isOtp ? (
            <span style={{
              fontSize: 9, fontWeight: 700, padding: "3px 10px", borderRadius: 20, flexShrink: 0,
              textTransform: "uppercase", letterSpacing: "0.1em",
              background: "rgba(232,255,107,0.16)", color: "var(--accent)",
              border: "1px solid rgba(232,255,107,0.4)",
              animation: "pulse 1.6s ease-in-out infinite",
            }}>
              ✉ Code needed
            </span>
          ) : (
            <span style={{
              fontSize: 9, fontWeight: 700, padding: "3px 10px", borderRadius: 20, flexShrink: 0,
              textTransform: "uppercase", letterSpacing: "0.1em",
              background: isAttention ? "rgba(251,146,60,0.12)" : "rgba(232,255,107,0.1)",
              color: isAttention ? "#fb923c" : "var(--accent)",
            }}>
              {isAttention ? "Needs attention" : "Awaiting review"}
            </span>
          )}
        </div>

        {/* needs_attention explainer */}
        {isAttention && (
          <div style={{ fontSize: 12.5, color: "var(--text)", fontWeight: 300, lineHeight: 1.6,
                        background: "rgba(251,146,60,0.06)", border: "1px solid rgba(251,146,60,0.18)",
                        borderRadius: 10, padding: "10px 12px" }}>
            ⚠ Rack clicked Submit but couldn't confirm the application went through.
            <strong style={{ fontWeight: 500 }}> Check the company's job portal before doing anything else</strong> —
            your application may already be in. Rack will never auto-retry this one.
            {job.error && <div style={{ color: "var(--text-dim)", fontSize: 11, marginTop: 6 }}>{job.error}</div>}
          </div>
        )}

        {/* Security code (OTP) entry — application is held open, waiting */}
        {isOtp && (
          <div style={{
            background: "rgba(232,255,107,0.05)", border: "1px solid rgba(232,255,107,0.25)",
            borderRadius: 12, padding: "14px 16px",
            display: "flex", flexDirection: "column", gap: 10,
          }}>
            <div style={{ fontSize: 13.5, fontWeight: 500, color: "var(--text)", display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 16 }}>✉</span> Check your email
            </div>
            <div style={{ fontSize: 12.5, color: "var(--text-dim)", fontWeight: 300, lineHeight: 1.6 }}>
              {job.company} sent a security code to{" "}
              <strong style={{ color: "var(--text)", fontWeight: 500 }}>
                {job.otp_email_hint || "your inbox"}
              </strong>
              . Enter it below — Rack is holding the application open and will submit
              the moment you do.
            </div>
            {job.error && (
              <div style={{ fontSize: 12, color: "#fb923c", lineHeight: 1.5 }}>
                ⚠ {job.error}
              </div>
            )}
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <input
                value={otpInputs[job.id] || ""}
                // Codes are CASE-SENSITIVE (Greenhouse issues mixed-case like
                // "JWtjgub7") — never transform the value, send exactly what
                // the email shows.
                onChange={e => setOtpInputs(prev => ({ ...prev, [job.id]: e.target.value }))}
                onKeyDown={e => { if (e.key === "Enter") submitOtp(job); }}
                placeholder="• • • • • • • •"
                maxLength={12}
                autoFocus
                autoComplete="one-time-code"
                spellCheck={false}
                style={{
                  flex: "0 1 220px", minWidth: 160, boxSizing: "border-box",
                  background: "var(--surface2)", border: "1px solid rgba(232,255,107,0.35)",
                  borderRadius: 10, padding: "10px 14px", color: "var(--text)",
                  fontSize: 16, fontFamily: "var(--font-mono, monospace)",
                  letterSpacing: "0.3em", textAlign: "center", outline: "none",
                }}
              />
              <button
                style={{ ...btn(true), padding: "10px 20px", opacity: ((otpInputs[job.id] || "").replace(/[\s-]/g, "").length < 4 || otpSubmitting.has(job.id)) ? 0.5 : 1 }}
                disabled={(otpInputs[job.id] || "").replace(/[\s-]/g, "").length < 4 || otpSubmitting.has(job.id)}
                onClick={() => submitOtp(job)}
              >
                {otpSubmitting.has(job.id) ? "Sending…" : "Submit code →"}
              </button>
            </div>
            <div style={{ fontSize: 11, color: "var(--text-dim)", fontWeight: 300 }}>
              Enter the code exactly as it appears in the email — it's case-sensitive.
              Codes expire quickly; if you got more than one email, use the newest.
            </div>
          </div>
        )}

        {/* Pre-approval notes on awaiting_review cards */}
        {!isAttention && !isOtp && !isInFlight && job.error && (
          <div style={{ fontSize: 12, color: "#fb923c", lineHeight: 1.6,
                        background: "rgba(251,146,60,0.06)", border: "1px solid rgba(251,146,60,0.18)",
                        borderRadius: 10, padding: "10px 12px" }}>
            ⚠ {job.error}
          </div>
        )}
        {!isAttention && !isOtp && !isInFlight && job.otp_expected && (
          <div style={{ fontSize: 12, color: "var(--text-dim)", lineHeight: 1.6,
                        background: "rgba(232,255,107,0.04)", border: "1px solid rgba(232,255,107,0.15)",
                        borderRadius: 10, padding: "10px 12px" }}>
            ✉ <strong style={{ color: "var(--text)", fontWeight: 500 }}>{job.company} verifies by email at submit time.</strong>{" "}
            After you approve, they'll send a security code to{" "}
            {job.otp_email_hint || "your inbox"} — Rack will pause here and ask you for it,
            so stay nearby for a minute.
          </div>
        )}

        {/* Screenshot */}
        {screenshot && (
          <img
            src={screenshot}
            alt={`Filled application — ${job.job_title}`}
            onClick={() => window.open(screenshot, "_blank", "noopener")}
            style={{
              width: "100%", maxHeight: 220, objectFit: "cover", objectPosition: "top",
              borderRadius: 10, border: "1px solid var(--border)", cursor: "zoom-in",
            }}
          />
        )}

        {/* Fill summary */}
        {!isAttention && (
          <div style={{ fontSize: 12, color: "var(--text-dim)", fontWeight: 300 }}>
            {job.filled_count || 0} field{(job.filled_count || 0) !== 1 ? "s" : ""} filled
            {job.validation_errors > 0 && (
              <span style={{ color: "#fb923c", marginLeft: 8 }}>
                ⚠ {job.validation_errors} validation warning{job.validation_errors !== 1 ? "s" : ""} — double-check the answers below
              </span>
            )}
          </div>
        )}

        {/* Q&A draft */}
        {(job.answers || []).length > 0 && !isAttention && renderAnswerList(job)}

        {/* Required fields Rack couldn't answer — user completes these inline */}
        {!isAttention && !isInFlight && !isOtp && renderNeedsUser(job)}

        {/* Actions — OTP cards have their own submit button in the code panel */}
        {!isInFlight && !isOtp && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {isAttention ? (
              <button style={btn(false)} disabled={isDeciding} onClick={() => decide(job, "skip")}>
                {isDeciding ? "…" : "Dismiss"}
              </button>
            ) : isEditing ? (
              <>
                <button style={btn(true)} disabled={isDeciding || needsBlocked} onClick={() => approveWithEdits(job)}>
                  {isDeciding ? "Submitting…" : "Approve with edits ✓"}
                </button>
                <button style={btn(false)} disabled={isDeciding}
                        onClick={() => { setEditingId(null); setEditValues({}); }}>
                  Cancel
                </button>
              </>
            ) : (
              <>
                <button style={btn(true)} disabled={isDeciding || needsBlocked} onClick={() => approveJob(job)}>
                  {isDeciding ? "Submitting…" : "Approve & submit ✓"}
                </button>
                {(job.answers || []).length > 0 && (
                  <button style={btn(false)} disabled={isDeciding} onClick={() => startEditing(job)}>
                    Edit answers
                  </button>
                )}
                <button style={btn(false)} disabled={isDeciding} onClick={() => decide(job, "skip")}>
                  Skip
                </button>
              </>
            )}
          </div>
        )}
        {needsBlocked && !isAttention && !isInFlight && !isOtp && (
          <div style={{ fontSize: 11.5, color: "#fb923c", marginTop: -2 }}>
            Answer the required field{unansweredRequiredNeeds(job).length !== 1 ? "s" : ""} above to enable submit.
          </div>
        )}
      </div>
    );
  };

  /* ── Render ──────────────────────────────────────────────────── */

  if (loading) {
    return (
      <div style={{ textAlign: "center", padding: "48px 0", color: "var(--text-dim)", fontSize: 13 }}>
        Loading your review queue…
      </div>
    );
  }

  const totalActionable = otpJobs.length + awaiting.length + attention.length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>

      {error && (
        <div style={{ background: "rgba(248,113,113,0.06)", border: "1px solid rgba(248,113,113,0.18)",
                      borderRadius: 10, padding: "10px 14px", fontSize: 12.5, color: "var(--danger)" }}>
          {error}
        </div>
      )}

      {/* Recently submitted toasts */}
      {recentlySubmitted.map(s => (
        <div key={s.id} style={{ background: "rgba(52,211,153,0.06)", border: "1px solid rgba(52,211,153,0.18)",
                                  borderRadius: 10, padding: "10px 14px", fontSize: 12.5, color: "var(--accent3)" }}>
          ✓ Submitted: {s.job_title} at {s.company} — confirmation saved, see the Applied tab.
        </div>
      ))}

      {totalActionable === 0 && inFlight.length === 0 ? (
        <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10,
                      padding: "48px 24px", textAlign: "center" }}>
          <div style={{ fontFamily: "var(--font-display)", fontSize: 16, fontWeight: 500, marginBottom: 8, letterSpacing: "-0.01em" }}>
            nothing waiting for review
          </div>
          <div style={{ fontSize: 13, color: "var(--text-dim)", maxWidth: 400, margin: "0 auto", lineHeight: 1.6 }}>
            Ask Rack to <em>"apply to my recently matched jobs"</em> in chat. It fills the applications
            in the background and they land here for your approval — nothing is submitted without you.
          </div>
        </div>
      ) : (
        <>
          {/* Honest urgency header — no fake deadlines */}
          {awaiting.length > 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <div style={{ flex: 1, minWidth: 220, fontSize: 12.5, color: "var(--text-dim)", lineHeight: 1.6 }}>
                Nothing is submitted until you approve it. Jobs can close without warning,
                so approving today is safer than tomorrow.
              </div>
              {awaiting.length > 1 && (
                <button style={{ ...btn(true), padding: "9px 20px" }} disabled={approvingAll} onClick={approveAll}>
                  {approvingAll ? "Approving…" : `Approve all ${awaiting.length} ✓`}
                </button>
              )}
            </div>
          )}

          {/* Code-needed cards first — the emailed code is expiring right now */}
          {otpJobs.map(job => <div key={job.id}>{renderReviewCard(job)}</div>)}
          {attention.map(job => <div key={job.id}>{renderReviewCard(job)}</div>)}
          {awaiting.map(job => <div key={job.id}>{renderReviewCard(job)}</div>)}
          {inFlight.map(job => <div key={job.id}>{renderReviewCard(job)}</div>)}
        </>
      )}
    </div>
  );
}


// ── Sidebar helpers (shared with Dashboard) ──────────────────────────────────

function brandColor(company) {
  const palette = ['#635bff','#e0930f','#5b6472','#7c5cff','#7c3aed','#1597c4','#e0492a','#1f6feb','#059669','#dc2626','#0ea5e9','#8b5cf6','#f59e0b','#10b981','#3b82f6']
  let hash = 0
  for (let i = 0; i < (company || '').length; i++) hash = (hash * 31 + company.charCodeAt(i)) & 0xffffffff
  return palette[Math.abs(hash) % palette.length]
}

export default function Tracking({ onNavigate }) {
  const { user } = useAuth()
  const { theme, toggleTheme } = useTheme()

  // Deep-link support: Home's BatchApplyCard sets rack_tracking_tab before
  // dispatching rack:navigate, so "Review & approve" lands directly here.
  const [activeTab, setActiveTab] = useState(() => {
    try {
      const t = sessionStorage.getItem("rack_tracking_tab");
      if (t) { sessionStorage.removeItem("rack_tracking_tab"); return t; }
    } catch { /* storage unavailable */ }
    return "auto";
  });
  const [profile, setProfile] = useState(null);
  const [userRole, setUserRole] = useState(null); // null = loading
  const [autoMatches, setAutoMatches] = useState([]);
  const [appliedCount, setAppliedCount] = useState(0);
  const [freshCount, setFreshCount] = useState(0);
  const [customMatches, setCustomMatches] = useState([]);
  const [reviewCount, setReviewCount] = useState(0);

  const isPowerUser = userRole === "admin" || userRole === "pro";

  const navigate = (tab) => { if (onNavigate) onNavigate(tab) }

  const displayName = user?.user_metadata?.full_name || user?.user_metadata?.name || user?.email?.split('@')[0] || 'there'
  const firstName = displayName.split(' ')[0]
  const userInitial = firstName.charAt(0).toUpperCase()

  // Load profile + role + cached counts for tab badges
  useEffect(() => {
    (async () => {
      try {
        const headers = await getAuthHeaders();
        const [pr, me, am, fr, cm, rv] = await Promise.all([
          fetch(`${PROFILE_API}/profile`, { headers }),
          fetch(`${API_BASE}/api/auth/me`, { headers }),
          fetch(`${API}/auto/matches`, { headers }),
          fetch(`${API}/auto/fresh?hours=1`, { headers }),
          fetch(`${API}/matches?limit=50`),
          fetch(`${API_BASE}/api/apply/review`, { headers }),
        ]);
        if (pr.ok) setProfile(await pr.json());
        if (me.ok) { const d = await me.json(); setUserRole(d.role || "free"); }
        else setUserRole("free");
        if (am.ok) {
          const d = await am.json();
          const allMatches = Array.isArray(d) ? d : (d.matches || []);
          setAutoMatches(allMatches);
          setAppliedCount(allMatches.filter(m => m.applied === true).length);
        }
        if (fr.ok) { const d = await fr.json(); setFreshCount(d.total || 0); }
        if (cm.ok) { const d = await cm.json(); setCustomMatches(Array.isArray(d) ? d : []); }
        if (rv.ok) {
          const d = await rv.json();
          setReviewCount((d.jobs || []).filter(j => j.status === "awaiting_review" || j.status === "needs_attention").length);
        }
      } catch { setUserRole("free"); }
    })();
  }, []);

  // Force tab back to "auto" if user is free and somehow on a power-only tab
  useEffect(() => {
    if (userRole && !isPowerUser && activeTab !== "auto" && activeTab !== "applied" && activeTab !== "review") {
      setActiveTab("auto");
    }
  }, [userRole]);

  // ── Sidebar nav items ─────────────────────────────────────────────────────

  return (
    <div
      data-trk-root
      data-theme={theme}
      style={{
        display: 'flex', height: '100dvh', width: '100%', overflow: 'hidden',
        background: 'var(--bg)', color: 'var(--text)',
        fontFamily: "'DM Sans', sans-serif",
        position: 'fixed', inset: 0, zIndex: 1,
      }}
    >
      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes fadeUp { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.55; } }
        @keyframes rkFadeIn { from{opacity:0} to{opacity:1} }
        @keyframes trkSlideUp { from{transform:translateY(100%)} to{transform:translateY(0)} }
        @keyframes rkScaleIn { from{opacity:0;transform:scale(.97)} to{opacity:1;transform:scale(1)} }
        @keyframes rkBeacon { 0%,100%{box-shadow:0 0 0 0 rgba(232,255,107,0.0)} 50%{box-shadow:0 0 0 5px rgba(232,255,107,0.16)} }
        .trk-root ::-webkit-scrollbar{width:8px;height:8px}
        .trk-root ::-webkit-scrollbar-thumb{background:var(--scrollbar-thumb);border-radius:6px}
        .trk-root ::-webkit-scrollbar-track{background:transparent}

        /* ── Main content padding (base = desktop) ── */
        .trk-main-content { padding: 30px 32px 60px; }

        /* ── Tablet: 768–1199px ── */
        @media (max-width: 1199px) {
          .trk-main-content { padding: 24px 22px 60px !important; }
        }

        @media (max-width: 767px) {
          [data-trk-root] { flex-direction: column !important; }
          .trk-root { flex: 1 !important; min-height: 0 !important; height: auto !important; }
          .trk-main-content { padding: 16px 14px calc(56px + env(safe-area-inset-bottom,0px) + 16px) !important; }
          .trk-header-actions { display: none !important; }
          .trk-page-title { font-size: 21px !important; }

          /* ── Compact job cards on mobile ── */
          .trk-job-card {
            padding: 10px 10px 9px !important;
            gap: 7px !important;
            border-radius: 12px !important;
          }

          /* ── Job grid: 2 columns on mobile ── */
          .trk-job-grid {
            grid-template-columns: 1fr 1fr !important;
            gap: 8px !important;
          }

        }
      `}</style>

      {/* ── SIDEBAR ── */}
      <Sidebar
        activeNav="Tracking"
        onNavigate={(id) => {
          if (id === 'Tracking') return
          navigate(id)
        }}
        userName={firstName}
        userInitial={userInitial}
        badge={{ Tracking: autoMatches.length || null }}
        onAskRack={() => navigate('Home')}
        extraNavLabel="VIEWS"
        extraNav={userRole !== null ? (
          <TabSwitcher
            activeTab={activeTab}
            onSwitch={setActiveTab}
            autoCount={autoMatches.length}
            appliedCount={appliedCount}
            reviewCount={reviewCount}
            freshCount={isPowerUser ? freshCount : 0}
            customCount={isPowerUser ? customMatches.length : 0}
            isPowerUser={isPowerUser}
          />
        ) : null}
        userStat={
          autoMatches.length > 0
            ? <><span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--accent-ink)' }}>{autoMatches.length}</span> jobs matched</>
            : 'Scanning…'
        }
        theme={theme}
        onToggleTheme={toggleTheme}
      />

      {/* ── MAIN CONTENT ── */}
      <main className="trk-root" style={{ flex: 1, height: '100%', overflowY: 'auto', position: 'relative' }}>
        {/* Ambient glow */}
        <div style={{ position: 'absolute', top: -160, left: -80, width: 520, height: 520, borderRadius: '50%', background: 'radial-gradient(circle, var(--glow-1), transparent 68%)', pointerEvents: 'none', zIndex: 0 }}/>
        <div style={{ position: 'absolute', top: 120, right: -140, width: 480, height: 480, borderRadius: '50%', background: 'radial-gradient(circle, var(--glow-2), transparent 70%)', pointerEvents: 'none', zIndex: 0 }}/>

        <div className="trk-main-content" style={{ position: 'relative', zIndex: 1 }}>

          {/* ── Page header — dynamic per active tab ── */}
          {(() => {
            const tabMeta = {
              auto:    { label: 'Auto Matches',  sub: autoMatches.length > 0 ? <><span style={{ color: 'var(--accent-ink)', fontFamily: "'Fira Code', monospace", fontWeight: 600 }}>{autoMatches.length}</span> total matches · ranked by fit + recency</> : 'AI-scored matches from 150+ company boards' },
              review:  { label: 'Review',         sub: 'Applications waiting for your approval' },
              applied: { label: 'Applied',         sub: appliedCount > 0 ? <><span style={{ color: 'var(--accent-ink)', fontFamily: "'Fira Code', monospace", fontWeight: 600 }}>{appliedCount}</span> applications submitted</> : 'Your submitted applications' },
              fresh:   { label: 'Fresh Jobs',      sub: 'New roles posted in the last hour' },
              custom:  { label: 'Search',          sub: 'Search all jobs in the pool' },
            }
            const meta = tabMeta[activeTab] || tabMeta.auto
            return (
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 20, marginBottom: 28 }}>
                <div>
                  <h1 className="trk-page-title" style={{ fontSize: 25, fontWeight: 600, letterSpacing: '-0.01em', margin: '0 0 5px' }}>{meta.label}</h1>
                  <p style={{ fontSize: 14, color: 'var(--text-mid)', margin: 0 }}>{meta.sub}</p>
                </div>
                <div className="trk-header-actions" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <button onClick={toggleTheme} title="Toggle theme"
                    style={{
                      width: 40, height: 40, borderRadius: 11, cursor: 'pointer',
                      border: '1px solid var(--border-bright)', background: 'var(--surface)',
                      color: 'var(--text-mid)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                      transition: 'border-color 0.18s, color 0.18s',
                    }}
                    onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--accent-line)'; e.currentTarget.style.color = 'var(--text)' }}
                    onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border-bright)'; e.currentTarget.style.color = 'var(--text-mid)' }}
                  >
                    {theme === 'dark'
                      ? <svg width={17} height={17} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="8" cy="8" r="3.2"/><path d="M8 1v1.6M8 13.4V15M15 8h-1.6M2.6 8H1M12.5 3.5l-1.1 1.1M4.6 11.4l-1.1 1.1M12.5 12.5l-1.1-1.1M4.6 4.6L3.5 3.5"/></svg>
                      : <svg width={17} height={17} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M13.5 9.2A5.6 5.6 0 0 1 6.8 2.5 5.6 5.6 0 1 0 13.5 9.2z"/></svg>
                    }
                  </button>
                  <div onClick={() => navigate('Account')}
                    style={{
                      width: 40, height: 40, borderRadius: 11, cursor: 'pointer',
                      background: 'linear-gradient(135deg, var(--accent2), var(--accent3))',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontWeight: 600, fontSize: 14, color: '#fff',
                    }}>
                    {userInitial}
                  </div>
                </div>
              </div>
            )
          })()}

          {/* ── Tab content ─────────────────────────────────────── */}
          {activeTab === "review" && userRole !== null && (
            <ReviewTab onCountChange={setReviewCount} />
          )}
          {activeTab === "auto" && userRole !== null && (
            <AutoMatchesTab profile={profile} isPowerUser={isPowerUser} />
          )}
          {activeTab === "auto" && userRole === null && (
            <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 14, padding: "48px 24px", textAlign: "center", animation: "fadeUp 0.35s ease both" }}>
              <div style={{ fontFamily: "'Fira Code', monospace", fontSize: 10, letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--accent)", opacity: 0.7, marginBottom: 16 }}>● scanning</div>
              <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8, letterSpacing: "-0.01em" }}>Finding your matches</div>
              <div style={{ fontSize: 13, color: "var(--text-dim)", maxWidth: 380, margin: "0 auto", lineHeight: 1.6 }}>
                We're scanning top tech companies and scoring the best roles for your resumes. Check back shortly.
              </div>
            </div>
          )}
          {activeTab === "applied" && userRole !== null && (
            <AppliedJobsTab />
          )}
          {activeTab === "fresh" && isPowerUser && (
            <FreshJobsTab />
          )}
          {activeTab === "custom" && isPowerUser && (
            <CustomSearchTab profile={profile} />
          )}

        </div>
      </main>
    </div>
  );
}