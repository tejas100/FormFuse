import { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { getAuthHeaders } from "../utils/api";

const API = "http://localhost:8000/api/tracking";
const RESUMES_API = "http://localhost:8000/api/resumes";
const PROFILE_API = "http://localhost:8000/api/account";

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
function TabSwitcher({ activeTab, onSwitch, autoCount, freshCount, customCount, isPowerUser }) {
  const allTabs = [
    { id: "auto",   label: "Auto Matches", icon: "✦", count: autoCount,   power: false },
    { id: "fresh",  label: "Fresh Jobs",   icon: "◈", count: freshCount,  power: true  },
    { id: "custom", label: "Custom Search", icon: "⚙", count: customCount, power: true  },
  ];
  const tabs = allTabs.filter(t => !t.power || isPowerUser);
  return (
    <div style={{
      display: "inline-flex",
      background: "var(--surface)",
      border: "1px solid var(--border)",
      borderRadius: 12,
      padding: 3,
      gap: 2,
      marginBottom: 20,
    }}>
      {tabs.map((tab) => {
        const active = activeTab === tab.id;
        return (
          <button
            key={tab.id}
            onClick={() => onSwitch(tab.id)}
            style={{
              display: "flex", alignItems: "center", gap: 6,
              padding: "7px 16px", borderRadius: 9, border: "none",
              background: active ? "var(--surface2)" : "transparent",
              color: active ? "var(--text)" : "var(--text-dim)",
              fontFamily: "var(--font-body)", fontSize: 12, fontWeight: active ? 600 : 400,
              cursor: "pointer", transition: "all 0.18s",
              boxShadow: active ? "0 1px 4px rgba(0,0,0,0.2)" : "none",
            }}
          >
            <span style={{
              fontSize: 9,
              color: active ? "var(--accent)" : "var(--text-dim)",
              transition: "color 0.18s",
            }}>{tab.icon}</span>
            {tab.label}
            {tab.count > 0 && (
              <span style={{
                fontSize: 9, fontWeight: 700, padding: "1px 6px", borderRadius: 20,
                background: active ? "rgba(232,255,107,0.15)" : "var(--surface2)",
                color: active ? "var(--accent)" : "var(--text-dim)",
                minWidth: 18, textAlign: "center",
              }}>
                {tab.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
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
      {!loading && <Paginator page={page} totalPages={totalPages} onPage={p => { setPage(p); setExpandedId(null); }} />}
      {!loading && sorted.length > 0 && (
        <div style={{ textAlign: "center", marginTop: 10, fontSize: 10, color: "var(--text-dim)", ...mono }}>
          showing {(page - 1) * PAGE_SIZE_F + 1}–{Math.min(page * PAGE_SIZE_F, sorted.length)} of {sorted.length} jobs
        </div>
      )}
    </div>
  );
}


/* ══════════════════════════════════════════════════════════════════
   AUTO MATCHES TAB
   ══════════════════════════════════════════════════════════════════ */
const PAGE_SIZE = 10;

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

    if (!hasProfile) {
      // Profile loaded but no roles set — nothing to fetch, stop initializing
      setInitializing(false);
      return;
    }

    (async () => {
      await loadMeta();

      // First load matches (role-aware)
      try {
        const headers = await getAuthHeaders();
        const mr = await fetch(`${API}/auto/matches`, { headers });
        if (mr.ok) {
          const md = await mr.json();
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

      // For free users: trigger daily slot generation (picks today's batch if not yet done)
      // For admin/pro: fetch daily slots for the banner only
      try {
        const headers = await getAuthHeaders();
        const sr = await fetch(`${API}/daily-slots`, { headers });
        if (sr.ok) {
          const sd = await sr.json();
          setDailySlots(sd.slots || []);
          setSlotsIsFresh(sd.is_fresh || false);

          // For free users: if fresh slots were just generated, reload matches to include them
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

  // Profile not set — only shown after initializing completes (so no flash)
  if (!hasProfile) {
    return (
      <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10, padding: "48px 24px", textAlign: "center", animation: "fadeUp 0.35s ease both" }}>
        <div style={{ fontFamily: "var(--font-display)", fontSize: 10, letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--text-dim)", marginBottom: 16 }}>◇ setup needed</div>
        <div style={{ fontFamily: "var(--font-display)", fontSize: 16, fontWeight: 500, marginBottom: 8, letterSpacing: "-0.01em" }}>Set your target roles first</div>
        <div style={{ fontSize: 13, color: "var(--text-dim)", maxWidth: 380, margin: "0 auto", lineHeight: 1.6 }}>
          Auto Matches uses your target roles from your Account profile to automatically find and score the best job postings.
        </div>
        <a href="#" onClick={e => { e.preventDefault(); document.querySelector('[data-tab="account"]')?.click(); }}
          style={{ display: "inline-block", marginTop: 20, padding: "9px 22px", borderRadius: 8, background: "var(--text)", color: "var(--bg)", fontFamily: "var(--font-display)", fontWeight: 500, fontSize: 12, textDecoration: "none", letterSpacing: "0.02em" }}>
          go to account →
        </a>
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

      {/* ── Daily Slots Banner ─────────────────────────────────────── */}
      {dailySlots.length > 0 && slotsIsFresh && (
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

      {!loading && paginated.map((m, i) => {
        const isNew = isSlotView && newJobIds.has(m.job_id);
        return (
          <MatchCard key={m.job_id} match={m} index={(page - 1) * PAGE_SIZE + i}
            expanded={expandedId === m.job_id}
            onToggle={() => setExpandedId(expandedId === m.job_id ? null : m.job_id)}
            isAuto={true}
            isNew={isNew}
            isApplied={appliedJobs.has(m.job_id)}
            onApply={() => handleApplyClick(m.job_id, m.job_title)}
            isSaved={savedJobs.has(m.job_id)}
            onSave={(e) => { e.stopPropagation(); toggleSaved(m.job_id); }} />
        );
      })}

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
export default function Tracking() {
  const [activeTab, setActiveTab] = useState("auto");
  const [profile, setProfile] = useState(null);
  const [userRole, setUserRole] = useState(null); // null = loading
  const [autoMatches, setAutoMatches] = useState([]);
  const [freshCount, setFreshCount] = useState(0);
  const [customMatches, setCustomMatches] = useState([]);

  const isPowerUser = userRole === "admin" || userRole === "pro";

  // Load profile + role + cached counts for tab badges
  useEffect(() => {
    (async () => {
      try {
        const headers = await getAuthHeaders();
        const [pr, me, am, fr, cm] = await Promise.all([
          fetch(`${PROFILE_API}/profile`, { headers }),
          fetch(`http://localhost:8000/api/auth/me`, { headers }),
          fetch(`${API}/auto/matches`, { headers }),
          fetch(`${API}/auto/fresh?hours=1`, { headers }),
          fetch(`${API}/matches?limit=50`),
        ]);
        if (pr.ok) setProfile(await pr.json());
        if (me.ok) { const d = await me.json(); setUserRole(d.role || "free"); }
        else setUserRole("free");
        if (am.ok) {
          const d = await am.json();
          setAutoMatches(Array.isArray(d) ? d : (d.matches || []));
        }
        if (fr.ok) { const d = await fr.json(); setFreshCount(d.total || 0); }
        if (cm.ok) { const d = await cm.json(); setCustomMatches(Array.isArray(d) ? d : []); }
      } catch { setUserRole("free"); }
    })();
  }, []);

  // Force tab back to "auto" if user is free and somehow on a gated tab
  useEffect(() => {
    if (userRole && !isPowerUser && activeTab !== "auto") {
      setActiveTab("auto");
    }
  }, [userRole]);

  return (
    <div style={{
      position: "absolute", inset: 0, display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "flex-start",
      padding: "20px", paddingTop: "var(--page-padding-top)", paddingBottom: "var(--page-padding-bottom)", overflowY: "auto",
      animation: "fadeUp 0.4s ease both",
    }}>
      <div style={{ width: "100%", maxWidth: 760 }}>

        {/* ── Header ─────────────────────────────────────────── */}
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontFamily: "var(--font-display)", fontSize: 22, fontWeight: 500, letterSpacing: "-0.02em", marginBottom: 4 }}>
            matches
          </div>
        </div>

        {/* ── Tab switcher — power users only. Free users see no tab bar. */}
        {isPowerUser && (
          <TabSwitcher
            activeTab={activeTab}
            onSwitch={setActiveTab}
            autoCount={autoMatches.length}
            freshCount={isPowerUser ? freshCount : 0}
            customCount={isPowerUser ? customMatches.length : 0}
            isPowerUser={isPowerUser}
          />
        )}

        {/* ── Tab content ─────────────────────────────────────── */}
        {activeTab === "auto" && userRole !== null && (
          <AutoMatchesTab profile={profile} isPowerUser={isPowerUser} />
        )}
        {activeTab === "auto" && userRole === null && (
          <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10, padding: "48px 24px", textAlign: "center" }}>
            <div style={{ fontFamily: "var(--font-display)", fontSize: 10, letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--accent)", opacity: 0.7, marginBottom: 16 }}>● scanning</div>
            <div style={{ fontFamily: "var(--font-display)", fontSize: 16, fontWeight: 500, marginBottom: 8, letterSpacing: "-0.01em" }}>
              finding your matches
            </div>
            <div style={{ fontSize: 13, color: "var(--text-dim)", maxWidth: 380, margin: "0 auto", lineHeight: 1.6 }}>
              We're scanning top tech companies and scoring the best roles for your resumes. Your first picks will appear here soon — check back shortly.
            </div>
          </div>
        )}
        {activeTab === "fresh" && isPowerUser && (
          <FreshJobsTab />
        )}
        {activeTab === "custom" && isPowerUser && (
          <CustomSearchTab profile={profile} />
        )}

      </div>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes fadeUp {
          from { opacity: 0; transform: translateY(8px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}