import { useState, useEffect, useCallback, useRef } from "react";

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
    const resp = await fetch(`${RESUMES_API}/${resumeId}/file`);
    if (!resp.ok) throw new Error("Download failed");
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${resumeName || "resume"}${fileExt ? `.${fileExt}` : ""}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (e) {
    console.error("Resume download error:", e);
  }
}

/* ══════════════════════════════════════════════════════════════════
   TAB BAR — subtle two-tab switcher
   ══════════════════════════════════════════════════════════════════ */
function TabSwitcher({ activeTab, onSwitch, autoCount, customCount }) {
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
      {[
        { id: "auto", label: "Auto Matches", icon: "✦", count: autoCount },
        { id: "custom", label: "Custom Search", icon: "⚙", count: customCount },
      ].map((tab) => {
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
function MatchCard({ match, index, expanded, onToggle, isAuto }) {
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
        border: expanded ? "1px solid var(--border-bright)" : "1px solid var(--border)",
        borderRadius: 16, padding: 0, marginBottom: 10, cursor: "pointer",
        transition: "all 0.2s", overflow: "hidden",
        animation: `fadeUp 0.4s ease ${index * 0.05}s both`,
      }}
    >
      {/* Score bar top accent */}
      <div style={{
        height: 3, background: scoreGradient(match.score),
        width: `${pct}%`, transition: "width 0.8s cubic-bezier(0.22,1,0.36,1)",
      }} />

      <div style={{ padding: "16px 20px" }}>
        {/* Row 1: Title + Score + Source */}
        <div style={{ display: "flex", alignItems: "flex-start", gap: 14 }}>
          <div style={{
            width: 36, height: 36, borderRadius: 10, flexShrink: 0,
            background: `${sc}12`, border: `1px solid ${sc}25`,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontFamily: "var(--font-display)", fontSize: 14, fontWeight: 800,
            color: sc,
          }}>
            {index + 1}
          </div>

          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{
              fontFamily: "var(--font-display)", fontSize: 15, fontWeight: 700,
              color: "var(--text)", letterSpacing: "-0.3px",
              whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
            }}>
              {match.job_title}
            </div>
            <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 3, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <span style={{ fontWeight: 500 }}>
                {match.company ? match.company.charAt(0).toUpperCase() + match.company.slice(1) : ""}
              </span>
              {match.location && match.location !== "Not specified" && (
                <span>· {match.location.length > 40 ? match.location.slice(0, 40) + "…" : match.location}</span>
              )}
              {match.posted_at && (
                <span>· {timeAgo(match.posted_at)}</span>
              )}
            </div>
          </div>

          <div style={{ textAlign: "right", flexShrink: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, justifyContent: "flex-end", marginBottom: 4 }}>
              {match.scoring_method === "llm+hybrid" && (
                <span style={{
                  fontSize: 8, fontWeight: 700, padding: "2px 6px", borderRadius: 20,
                  background: "rgba(232,255,107,0.12)", color: "var(--accent)",
                  border: "1px solid rgba(232,255,107,0.25)", letterSpacing: "0.08em", textTransform: "uppercase",
                }}>AI</span>
              )}
              <div style={{
                fontFamily: "var(--font-display)", fontSize: 22, fontWeight: 800,
                color: sc, letterSpacing: "-1px", lineHeight: 1,
              }}>
                {match.llm_score ?? match.score}%
              </div>
            </div>
            {match.llm_recommendation && match.scoring_method === "llm+hybrid" && (
              <div style={{ marginBottom: 4 }}>
                <span style={{
                  fontSize: 9, fontWeight: 700, padding: "2px 8px", borderRadius: 20,
                  letterSpacing: "0.06em", textTransform: "uppercase",
                  ...recommendationStyle(match.llm_recommendation),
                }}>
                  {match.llm_recommendation}
                </span>
              </div>
            )}
            <div>{sourceBadge(match.source)}</div>
          </div>
        </div>

        {/* Row 2: Skills pills */}
        <div style={{ display: "flex", gap: 5, marginTop: 12, flexWrap: "wrap" }}>
          {(match.matched_skills || []).slice(0, 4).map((s) => (
            <span key={s} style={{
              fontSize: 10, fontWeight: 600, padding: "3px 9px", borderRadius: 20,
              background: "rgba(52,211,153,0.1)", color: "var(--accent3)",
            }}>
              ✓ {s}
            </span>
          ))}
          {(match.missing_skills || []).slice(0, 2).map((s) => (
            <span key={s} style={{
              fontSize: 10, fontWeight: 600, padding: "3px 9px", borderRadius: 20,
              background: "rgba(248,113,113,0.1)", color: "var(--danger)",
            }}>
              ✗ {s}
            </span>
          ))}
          {((match.matched_skills || []).length > 4 || (match.missing_skills || []).length > 2) && (
            <span style={{
              fontSize: 10, fontWeight: 500, padding: "3px 9px", borderRadius: 20,
              background: "var(--surface2)", color: "var(--text-dim)",
            }}>
              +{Math.max(0, (match.matched_skills || []).length - 4 + (match.missing_skills || []).length - 2)} more
            </span>
          )}
        </div>

        {/* Best resume label — now clickable to download */}
        {match.resume_name && (
          <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 8, display: "flex", alignItems: "center", gap: 6 }}>
            Best match:{" "}
            {match.resume_id ? (
              <button
                onClick={handleDownload}
                disabled={downloading}
                title={`Download ${match.resume_name}`}
                style={{
                  background: "none", border: "none", padding: "1px 6px",
                  borderRadius: 6, cursor: "pointer",
                  color: "var(--accent)", fontWeight: 600, fontSize: 11,
                  fontFamily: "var(--font-body)",
                  display: "inline-flex", alignItems: "center", gap: 4,
                  opacity: downloading ? 0.5 : 1,
                  transition: "all 0.15s",
                  textDecoration: "underline", textDecorationStyle: "dotted",
                  textUnderlineOffset: 2,
                }}
              >
                {downloading ? "Downloading…" : `${match.resume_name} ↓`}
              </button>
            ) : (
              <span style={{ color: "var(--accent)", fontWeight: 600 }}>{match.resume_name}</span>
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
                        <div style={{ width: `${Math.min(match.hybrid_score, 100)}%`, height: "100%", background: "rgba(255,255,255,0.15)", borderRadius: 4 }} />
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
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    display: "inline-flex", alignItems: "center", gap: 6,
                    padding: "10px 24px", borderRadius: 30, background: "var(--accent)",
                    color: "#000", fontFamily: "var(--font-display)", fontWeight: 700,
                    fontSize: 13, textDecoration: "none", letterSpacing: "-0.01em",
                    transition: "all 0.2s",
                  }}
                >
                  Apply →
                </a>
              )}
              {match.resume_id && (
                <button
                  onClick={handleDownload}
                  disabled={downloading}
                  style={{
                    display: "inline-flex", alignItems: "center", gap: 6,
                    padding: "10px 20px", borderRadius: 30,
                    border: "1px solid var(--border)", background: "transparent",
                    color: "var(--text-dim)", fontFamily: "var(--font-display)", fontWeight: 600,
                    fontSize: 12, cursor: "pointer", transition: "all 0.2s",
                    opacity: downloading ? 0.5 : 1,
                  }}
                >
                  {downloading ? "Downloading…" : `↓ Download Resume`}
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
   AUTO MATCH LOADING — ASCII pixel-style pipeline animation
   ══════════════════════════════════════════════════════════════════ */
const PIPELINE_STAGES = [
  {
    id: "fetch", label: "FETCHING BOARDS", detail: "Connecting to Greenhouse API", icon: "◈",
    ascii: [
      "┌─────────────────────────────┐",
      "│  GET /boards/{token}/jobs   │",
      "│  ░░░░░░░░░░░░░░░░░░░░░░░░  │",
      "│  boards: 80 · parallel: 15  │",
      "└─────────────────────────────┘",
    ],
    logLines: [
      "→ anthropic       [████████] 43 jobs",
      "→ openai          [████████] 61 jobs",
      "→ stripe          [████████] 89 jobs",
      "→ figma           [███████░] 34 jobs",
      "→ vercel          [████████] 27 jobs",
      "→ supabase        [██████░░] 18 jobs",
      "→ datadog         [████████] 55 jobs",
      "→ cloudflare      [███████░] 72 jobs",
    ],
  },
  {
    id: "filter", label: "ROLE FILTERING", detail: "Matching titles to your target roles", icon: "◉",
    ascii: [
      "┌──────────────────────────────────┐",
      "│  pool: 3,847 jobs                │",
      "│  target_roles: [                 │",
      "│    'Software Engineer',          │",
      "│    'ML Engineer', ...            │",
      "│  ]                               │",
      "│  overlap_threshold: 0.60         │",
      "└──────────────────────────────────┘",
    ],
    logLines: [
      "✓ Senior Software Engineer @ stripe",
      "✓ ML Engineer, Inference @ openai",
      "✓ Backend Engineer @ anthropic",
      "✗ Marketing Manager @ notion  (skip)",
      "✓ Staff Engineer, Infra @ cloudflare",
      "✗ Sales Development Rep @ hubspot  (skip)",
      "✓ AI Engineer @ cohere",
      "✓ Software Engineer, Platform @ linear",
    ],
  },
  {
    id: "embed", label: "EMBEDDING JDs", detail: "Encoding job descriptions into vectors", icon: "⬡",
    ascii: [
      "┌───────────────────────────────────┐",
      "│  model: all-MiniLM-L6-v2          │",
      "│  dim:   384                        │",
      "│                                   │",
      "│  JD text ──► tokenize             │",
      "│            ──► encode             │",
      "│            ──► vec[384]           │",
      "└───────────────────────────────────┘",
    ],
    logLines: [
      "tokenizing: 'Senior Software Engineer...'",
      "tokens: 247  |  chunks: 3",
      "encoding chunk 1/3  ▓▓▓▓▓▓░░░░",
      "encoding chunk 2/3  ▓▓▓▓▓▓▓▓░░",
      "encoding chunk 3/3  ▓▓▓▓▓▓▓▓▓▓",
      "vec[0..5]: [0.231, -0.087, 0.412...]",
      "FAISS index: 2,341 vectors loaded",
      "cosine search: top_k=20 chunks",
    ],
  },
  {
    id: "score", label: "RACK SCORING", detail: "Running hybrid 4-component scorer", icon: "◎",
    ascii: [
      "┌──────────────────────────────────┐",
      "│  semantic_sim  ×0.40  → 0.731   │",
      "│  skill_overlap ×0.30  → 0.680   │",
      "│  exp_match     ×0.20  → 0.750   │",
      "│  kw_position   ×0.10  → 0.610   │",
      "│  ─────────────────────────────  │",
      "│  raw_score            → 0.714   │",
      "└──────────────────────────────────┘",
    ],
    logLines: [
      "pass 1: canonical skill match",
      "  matched: Python, FastAPI, Docker ✓",
      "  missing: Kubernetes, Terraform",
      "pass 2: text fallback scan",
      "  found 'k8s' → Kubernetes ✓",
      "pass 3: LLM semantic (off)",
      "gap_analysis: 1 critical gap",
      "rank_score = 0.714×0.85 + 0.91×0.15",
    ],
  },
  {
    id: "rank", label: "RANKING RESULTS", detail: "Sorting by score × recency", icon: "◆",
    ascii: [
      "┌──────────────────────────────────┐",
      "│  rank = score×0.85 + rec×0.15   │",
      "│                                  │",
      "│  #1  0.847  stripe · SWE        │",
      "│  #2  0.831  anthropic · BE      │",
      "│  #3  0.819  openai · ML Eng     │",
      "│  #4  0.802  vercel · Platform   │",
      "│  ...                            │",
      "└──────────────────────────────────┘",
    ],
    logLines: [
      "recency half-life: 7 days",
      "job posted 1d ago  → rec=0.906",
      "job posted 5d ago  → rec=0.612",
      "job posted 14d ago → rec=0.250",
      "merging with stored results...",
      "deduping seen_job_ids: 247 filtered",
      "top_50 saved → auto_match_results.json",
      "serving top_20 to UI ✓",
    ],
  },
];

const CURSOR_FRAMES  = ["█", "▓", "░", " "];
const SPINNER_FRAMES = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];
const PROGRESS_CHARS = ["░","▒","▓","█"];

function AutoMatchLoadingAnimation() {
  const [stageIdx, setStageIdx]    = useState(0);
  const [logIdx, setLogIdx]        = useState(0);
  const [cursorFrame, setCursor]   = useState(0);
  const [spinnerFrame, setSpinner] = useState(0);
  const [progressPct, setProgress] = useState(0);
  const [asciiLine, setAsciiLine]  = useState(0);
  const [glitchCol, setGlitchCol]  = useState(-1);

  const stage      = PIPELINE_STAGES[stageIdx];
  const totalStages = PIPELINE_STAGES.length;

  // Cursor blink
  useEffect(() => {
    const t = setInterval(() => setCursor(f => (f + 1) % CURSOR_FRAMES.length), 530);
    return () => clearInterval(t);
  }, []);

  // Spinner
  useEffect(() => {
    const t = setInterval(() => setSpinner(f => (f + 1) % SPINNER_FRAMES.length), 80);
    return () => clearInterval(t);
  }, []);

  // Progress fills up per stage, then advances
  useEffect(() => {
    setProgress(0); setLogIdx(0); setAsciiLine(0);
    const t = setInterval(() => {
      setProgress(p => { if (p >= 100) { clearInterval(t); return 100; } return p + (Math.random() * 4 + 1); });
    }, 90);
    return () => clearInterval(t);
  }, [stageIdx]);

  useEffect(() => {
    if (progressPct >= 100 && stageIdx < totalStages - 1) {
      const t = setTimeout(() => setStageIdx(s => s + 1), 420);
      return () => clearTimeout(t);
    }
  }, [progressPct]);

  // Log lines ticker
  useEffect(() => {
    const t = setInterval(() => {
      setLogIdx(i => Math.min(i + 1, stage.logLines.length - 1));
    }, 350);
    return () => clearInterval(t);
  }, [stageIdx]);

  // ASCII art line-by-line reveal
  useEffect(() => {
    setAsciiLine(0);
    const t = setInterval(() => {
      setAsciiLine(l => { if (l >= stage.ascii.length - 1) { clearInterval(t); return l; } return l + 1; });
    }, 95);
    return () => clearInterval(t);
  }, [stageIdx]);

  // Occasional random character glitch
  useEffect(() => {
    const t = setInterval(() => {
      setGlitchCol(Math.floor(Math.random() * 34));
      setTimeout(() => setGlitchCol(-1), 80);
    }, 2400);
    return () => clearInterval(t);
  }, []);

  const pct    = Math.min(100, Math.round(progressPct));
  const barLen = 28;
  const filled = Math.round((pct / 100) * barLen);
  const stageBar = Array.from({ length: barLen }, (_, i) => {
    if (i < filled - 1) return "█";
    if (i === filled - 1) return PROGRESS_CHARS[2];
    if (i === filled)     return PROGRESS_CHARS[1];
    return "░";
  }).join("");

  const overallPct = Math.round(((stageIdx + pct / 100) / totalStages) * 100);
  const oLen   = 60;
  const oFilled = Math.round((overallPct / 100) * oLen);
  const pipeBar = Array.from({ length: oLen }, (_, i) => i < oFilled ? "▪" : "·").join("");

  const mono = { fontFamily: "'JetBrains Mono','Fira Code','Courier New',monospace" };
  const acc  = "var(--accent)";
  const grn  = "#34d399";
  const dim  = "rgba(255,255,255,0.28)";
  const red  = "#f87171";

  return (
    <div style={{ padding: "32px 0 24px", animation: "fadeUp 0.35s ease both" }}>

      {/* Stage strip */}
      <div style={{ display: "flex", gap: 0, marginBottom: 24, border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
        {PIPELINE_STAGES.map((s, i) => {
          const done   = i < stageIdx;
          const active = i === stageIdx;
          return (
            <div key={s.id} style={{
              flex: 1, padding: "8px 4px", textAlign: "center",
              background: active ? "rgba(232,255,107,0.06)" : done ? "rgba(52,211,153,0.04)" : "transparent",
              borderRight: i < totalStages - 1 ? "1px solid var(--border)" : "none",
              transition: "background 0.4s",
            }}>
              <div style={{ fontSize: 15, marginBottom: 2, color: done ? grn : active ? acc : dim, transition: "color 0.4s" }}>
                {done ? "✓" : active ? s.icon : "○"}
              </div>
              <div style={{ ...mono, fontSize: 8, fontWeight: 700, letterSpacing: "0.08em", color: done ? grn : active ? acc : dim, transition: "color 0.4s" }}>
                {s.id.toUpperCase()}
              </div>
            </div>
          );
        })}
      </div>

      {/* Terminal window */}
      <div style={{ background: "#0a0a0a", border: "1px solid rgba(232,255,107,0.18)", borderRadius: 12, overflow: "hidden", boxShadow: "0 0 40px rgba(232,255,107,0.04)" }}>

        {/* Title bar */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "9px 14px", background: "rgba(255,255,255,0.03)", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
          <div style={{ width: 9, height: 9, borderRadius: "50%", background: "#ff5f56" }} />
          <div style={{ width: 9, height: 9, borderRadius: "50%", background: "#ffbd2e" }} />
          <div style={{ width: 9, height: 9, borderRadius: "50%", background: "#27c93f" }} />
          <div style={{ ...mono, fontSize: 10, color: dim, marginLeft: 8, letterSpacing: "0.05em" }}>rack-auto-pipeline — bash</div>
          <div style={{ marginLeft: "auto", ...mono, fontSize: 10, color: acc }}>{SPINNER_FRAMES[spinnerFrame]} running</div>
        </div>

        {/* Two-column body */}
        <div style={{ display: "flex", minHeight: 250 }}>

          {/* Left — ASCII box art */}
          <div style={{ flex: "0 0 44%", padding: "18px 16px", borderRight: "1px solid rgba(255,255,255,0.05)" }}>
            <div style={{ ...mono, fontSize: 10, color: dim, marginBottom: 10, letterSpacing: "0.1em" }}>{stage.icon} {stage.label}</div>
            <div style={{ ...mono, fontSize: 11, lineHeight: 1.75 }}>
              {stage.ascii.map((line, li) => (
                <div key={li} style={{ color: li <= asciiLine ? (li === asciiLine ? acc : "rgba(232,255,107,0.5)") : "transparent", transition: "color 0.15s", whiteSpace: "pre" }}>
                  {line.split("").map((ch, ci) => (
                    <span key={ci} style={{ color: glitchCol === ci && li === Math.floor(stage.ascii.length / 2) ? red : undefined }}>{ch}</span>
                  ))}
                </div>
              ))}
            </div>
          </div>

          {/* Right — scrolling log */}
          <div style={{ flex: 1, padding: "18px 16px", overflow: "hidden" }}>
            <div style={{ ...mono, fontSize: 10, color: dim, marginBottom: 10, letterSpacing: "0.1em" }}>▸ LOG STREAM</div>
            <div style={{ ...mono, fontSize: 11, lineHeight: 1.9 }}>
              {stage.logLines.map((line, li) => {
                const visible   = li <= logIdx;
                const isCurrent = li === logIdx;
                const isSkip    = line.includes("skip");
                const isMatch   = line.startsWith("✓") || line.startsWith("→");
                return (
                  <div key={`${stageIdx}-${li}`} style={{ opacity: visible ? 1 : 0, transition: "opacity 0.2s", color: isSkip ? dim : isMatch ? "rgba(232,255,107,0.8)" : "rgba(255,255,255,0.55)", display: "flex", alignItems: "baseline", gap: 5 }}>
                    <span style={{ color: dim, userSelect: "none", fontSize: 9, minWidth: 16 }}>{String(li + 1).padStart(2, "0")}</span>
                    <span>{line}</span>
                    {isCurrent && visible && <span style={{ color: acc, marginLeft: 2, fontSize: 13, lineHeight: 1 }}>{CURSOR_FRAMES[cursorFrame]}</span>}
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Bottom — progress bars */}
        <div style={{ padding: "12px 16px", borderTop: "1px solid rgba(255,255,255,0.05)", background: "rgba(0,0,0,0.35)" }}>
          {/* Stage info + percent */}
          <div style={{ display: "flex", alignItems: "center", marginBottom: 7 }}>
            <span style={{ ...mono, fontSize: 10, color: acc, letterSpacing: "0.04em" }}>{stage.detail}</span>
            <span style={{ ...mono, fontSize: 10, color: dim, marginLeft: "auto" }}>stage {stageIdx + 1}/{totalStages} · {overallPct}%</span>
          </div>

          {/* Chunky stage bar  [████████░░░░]  */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
            <span style={{ ...mono, fontSize: 13, color: acc, whiteSpace: "pre", letterSpacing: "-0.02em", textShadow: "0 0 14px rgba(232,255,107,0.55)" }}>
              [{stageBar}]
            </span>
            <span style={{ ...mono, fontSize: 10, color: acc, minWidth: 32, textAlign: "right" }}>{pct}%</span>
          </div>

          {/* Dotted overall pipeline bar  pipeline ▪▪▪▪···· 40%  */}
          <div style={{ ...mono, fontSize: 9, color: "rgba(255,255,255,0.2)", whiteSpace: "pre", letterSpacing: "0.01em" }}>
            {"pipeline  "}{pipeBar}{"  "}{overallPct}%
          </div>
        </div>
      </div>

      {/* Footer label */}
      <div style={{ textAlign: "center", marginTop: 14, ...mono, fontSize: 11, color: dim, letterSpacing: "0.1em" }}>
        {SPINNER_FRAMES[spinnerFrame]}&nbsp;&nbsp;
        <span style={{ color: acc }}>{stage.label}</span>
        &nbsp;—&nbsp;{stage.detail.toLowerCase()}
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
      background: "rgba(0,0,0,0.78)", backdropFilter: "blur(6px)",
      display: "flex", alignItems: "flex-start", justifyContent: "center",
      padding: "110px 16px 40px", overflowY: "auto",
    }} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{
        width: "100%", maxWidth: 700,
        background: "var(--bg)", border: "1px solid var(--border)",
        borderRadius: 18, overflow: "hidden", animation: "fadeUp 0.25s ease both",
        boxShadow: "0 32px 80px rgba(0,0,0,0.6)",
      }}>
        {/* Header */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "18px 22px", borderBottom: "1px solid var(--border)",
          background: "rgba(255,255,255,0.02)",
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
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 22px", borderBottom: "1px solid rgba(255,255,255,0.04)", flexWrap: "wrap" }}>
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
              <div style={{ fontSize: 12, marginTop: 4, opacity: 0.6 }}>Click "↓ Archive & Refresh" to save current matches before scanning for new ones.</div>
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
                      whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
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
                  <div style={{ padding: "10px 14px 14px", borderTop: "1px solid rgba(255,255,255,0.05)", background: "rgba(0,0,0,0.2)", animation: "fadeUp 0.15s ease both" }}>
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
                        background: confirmApplied.has(job.job_id) ? "rgba(52,211,153,0.06)" : "rgba(255,255,255,0.02)",
                        border: `1px solid ${confirmApplied.has(job.job_id) ? "rgba(52,211,153,0.2)" : "rgba(255,255,255,0.06)"}`,
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
                          style={{ fontSize: 11, padding: "6px 14px", borderRadius: 20, background: "var(--accent)", color: "#000", fontFamily: "var(--font-display)", fontWeight: 700, textDecoration: "none" }}>
                          Apply →
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
   AUTO MATCHES TAB
   ══════════════════════════════════════════════════════════════════ */
const PAGE_SIZE = 10;

function AutoMatchesTab({ profile }) {
  const [matches, setMatches]       = useState([]);
  const [loading, setLoading]       = useState(false);
  const [meta, setMeta]             = useState(null);
  const [stats, setStats]           = useState(null);
  const [error, setError]           = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const [titleFilter, setTitleFilter] = useState("");
  const [page, setPage]             = useState(1);
  const [showArchive, setShowArchive] = useState(false);
  const [archiveCount, setArchiveCount] = useState(() => loadArchive().length);
  const hasRun = useRef(false);

  const hasProfile = profile && (profile.target_roles || []).length > 0;
  const mono = { fontFamily: "'JetBrains Mono','Fira Code','Courier New',monospace" };

  const loadStoredMatches = useCallback(async () => {
    try {
      const [mr, me] = await Promise.all([fetch(`${API}/auto/matches`), fetch(`${API}/auto/meta`)]);
      if (mr.ok) setMatches(await mr.json());
      if (me.ok) setMeta(await me.json());
    } catch {}
  }, []);

  useEffect(() => {
    if (hasRun.current) return;
    hasRun.current = true;
    (async () => {
      await loadStoredMatches();
      if (hasProfile) handleRefresh(false);
    })();
  }, [hasProfile]);

  const handleRefreshWithArchive = async () => {
    if (matches.length > 0) {
      // 1. Save to localStorage archive (for UI display in the Archive modal)
      const updated = archiveJobs(matches, loadArchive());
      saveArchive(updated);
      setArchiveCount(updated.length);

      // 2. Tell the backend — these IDs will never resurface in Auto Matches,
      //    even after seen_job_ids resets. Fire-and-forget (don't block refresh).
      const jobIds = matches.map(m => m.job_id).filter(Boolean);
      if (jobIds.length > 0) {
        try {
          await fetch(`${API}/auto/archive`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ job_ids: jobIds }),
          });
        } catch (e) {
          console.warn("[Archive] Backend archive call failed — continuing with refresh", e);
        }
      }
    }
    handleRefresh(true);
  };

  const handleRefresh = async (force = true) => {
    setLoading(true); setError(null); setStats(null); setPage(1);
    try {
      const r = await fetch(`${API}/auto/refresh`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force }),
      });
      const d = await r.json();
      if (d.matches) setMatches(d.matches);
      if (d.stats) setStats(d.stats);
      await loadStoredMatches();
    } catch (e) { setError("Auto pipeline failed: " + e.message); }
    setLoading(false);
  };

  const filtered = matches.filter(m =>
    !titleFilter.trim() || m.job_title?.toLowerCase().includes(titleFilter.toLowerCase())
  );

  // Reset page when filter changes
  useEffect(() => { setPage(1); }, [titleFilter]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const paginated  = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const inputStyle = {
    padding: "8px 14px", borderRadius: 30,
    border: "1px solid var(--border)", background: "var(--surface)",
    color: "var(--text)", fontFamily: "var(--font-body)", fontSize: 12, outline: "none",
  };

  if (!hasProfile) {
    return (
      <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 16, padding: "48px 24px", textAlign: "center", animation: "fadeUp 0.35s ease both" }}>
        <div style={{ fontSize: 36, marginBottom: 14 }}>✦</div>
        <div style={{ fontFamily: "var(--font-display)", fontSize: 17, fontWeight: 700, marginBottom: 6, letterSpacing: "-0.3px" }}>Set your target roles first</div>
        <div style={{ fontSize: 13, color: "var(--text-dim)", maxWidth: 380, margin: "0 auto", lineHeight: 1.6 }}>
          Auto Matches uses your target roles from your Account profile to automatically find and score the best job postings.
        </div>
        <a href="#" onClick={e => { e.preventDefault(); document.querySelector('[data-tab="account"]')?.click(); }}
          style={{ display: "inline-block", marginTop: 20, padding: "10px 24px", borderRadius: 30, background: "var(--accent)", color: "#000", fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 13, textDecoration: "none" }}>
          Go to Account →
        </a>
      </div>
    );
  }

  return (
    <div>
      {showArchive && <ArchiveModal onClose={() => { setShowArchive(false); setArchiveCount(loadArchive().length); }} />}

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14, flexWrap: "wrap", gap: 10 }}>
        <div>
          <div style={{ fontSize: 13, color: "var(--text-dim)" }}>
            {matches.length > 0 ? `${matches.length} top matches · AI-scored by resume fit + recency` : "Automatically finds and AI-scores your best-fit jobs from top tech companies"}
            {meta?.last_fetch_at && !loading && <span> · updated {timeAgo(meta.last_fetch_at)}</span>}
          </div>
          {profile?.target_roles?.length > 0 && (
            <div style={{ display: "flex", gap: 5, marginTop: 6, flexWrap: "wrap" }}>
              {profile.target_roles.slice(0, 4).map(r => (
                <span key={r} style={{ fontSize: 10, padding: "2px 8px", borderRadius: 20, background: "rgba(232,255,107,0.08)", color: "var(--accent)", border: "1px solid rgba(232,255,107,0.15)", fontWeight: 500 }}>{r}</span>
              ))}
              {profile.target_roles.length > 4 && <span style={{ fontSize: 10, color: "var(--text-dim)", padding: "2px 0" }}>+{profile.target_roles.length - 4} more</span>}
            </div>
          )}
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
          <button onClick={handleRefreshWithArchive} disabled={loading}
            title={matches.length > 0 ? "Archive current matches, then scan for new jobs" : "Scan for new jobs"}
            style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 18px", borderRadius: 30, border: "none", background: "var(--accent)", color: "#000", fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 12, cursor: loading ? "default" : "pointer", opacity: loading ? 0.6 : 1, transition: "all 0.2s" }}>
            {loading ? <><span style={{ display: "inline-block", animation: "spin 1s linear infinite" }}>⟳</span> Scanning…</> : matches.length > 0 ? "↓ Archive & Refresh" : "⟳ Refresh Auto"}
          </button>
        </div>
      </div>

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
          <input type="text" value={titleFilter} onChange={e => setTitleFilter(e.target.value)} placeholder="Search by title…" style={{ ...inputStyle, flex: "1 1 180px" }} />
          <span style={{ fontSize: 11, color: "var(--text-dim)", fontFamily: "'JetBrains Mono',monospace" }}>{filtered.length} jobs · p.{page}/{totalPages}</span>
        </div>
      )}

      {loading && <AutoMatchLoadingAnimation />}

      {!loading && matches.length === 0 && (
        <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 16, padding: "48px 24px", textAlign: "center", animation: "fadeUp 0.35s ease both" }}>
          <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 24, marginBottom: 14, color: "var(--accent)", opacity: 0.4 }}>[ no matches ]</div>
          <div style={{ fontFamily: "var(--font-display)", fontSize: 17, fontWeight: 700, marginBottom: 6, letterSpacing: "-0.3px" }}>No matches yet</div>
          <div style={{ fontSize: 13, color: "var(--text-dim)", maxWidth: 380, margin: "0 auto 20px", lineHeight: 1.6 }}>
            Hit "Refresh Auto" to scan ~80 top tech companies and surface your best-matched {profile.target_roles?.[0] || "role"} openings.
          </div>
          <button onClick={() => handleRefresh(true)} disabled={loading}
            style={{ padding: "10px 24px", borderRadius: 30, border: "none", background: "var(--accent)", color: "#000", fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>
            ⟳ Refresh Auto
          </button>
        </div>
      )}

      {!loading && paginated.map((m, i) => (
        <MatchCard key={m.job_id} match={m} index={(page - 1) * PAGE_SIZE + i}
          expanded={expandedId === m.job_id}
          onToggle={() => setExpandedId(expandedId === m.job_id ? null : m.job_id)}
          isAuto={true} />
      ))}

      {!loading && totalPages > 1 && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6, marginTop: 20, fontFamily: "'JetBrains Mono',monospace" }}>
          <button onClick={() => { setPage(p => Math.max(1, p - 1)); setExpandedId(null); }} disabled={page === 1}
            style={{ padding: "7px 14px", borderRadius: 8, border: "1px solid var(--border)", background: "transparent", color: page === 1 ? "var(--text-dim)" : "var(--text)", cursor: page === 1 ? "default" : "pointer", fontSize: 12, opacity: page === 1 ? 0.4 : 1 }}>← prev</button>
          {Array.from({ length: totalPages }, (_, i) => i + 1).map(p => (
            <button key={p} onClick={() => { setPage(p); setExpandedId(null); }}
              style={{ width: 32, height: 32, borderRadius: 8, fontSize: 12, border: `1px solid ${p === page ? "var(--accent)" : "var(--border)"}`, background: p === page ? "rgba(232,255,107,0.1)" : "transparent", color: p === page ? "var(--accent)" : "var(--text-dim)", cursor: "pointer", fontWeight: p === page ? 700 : 400 }}>{p}</button>
          ))}
          <button onClick={() => { setPage(p => Math.min(totalPages, p + 1)); setExpandedId(null); }} disabled={page === totalPages}
            style={{ padding: "7px 14px", borderRadius: 8, border: "1px solid var(--border)", background: "transparent", color: page === totalPages ? "var(--text-dim)" : "var(--text)", cursor: page === totalPages ? "default" : "pointer", fontSize: 12, opacity: page === totalPages ? 0.4 : 1 }}>next →</button>
        </div>
      )}
      {!loading && filtered.length > 0 && (
        <div style={{ textAlign: "center", marginTop: 10, fontSize: 10, color: "var(--text-dim)", fontFamily: "'JetBrains Mono',monospace" }}>
          showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, filtered.length)} of {filtered.length} matches
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
            width: 40, height: 40, border: "3px solid rgba(232,255,107,0.15)",
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
          <div style={{ fontSize: 36, marginBottom: 14 }}>📡</div>
          <div style={{ fontFamily: "var(--font-display)", fontSize: 17, fontWeight: 700, marginBottom: 6, letterSpacing: "-0.3px" }}>
            Start tracking companies
          </div>
          <div style={{ fontSize: 13, color: "var(--text-dim)", maxWidth: 380, margin: "0 auto", lineHeight: 1.6 }}>
            Add companies you're interested in, and RACK will fetch their job postings, match against your resume, and show you the best opportunities.
          </div>
          <button
            onClick={() => setShowSettings(true)}
            style={{
              marginTop: 20, padding: "10px 24px", borderRadius: 30, border: "none",
              background: "var(--accent)", color: "#000", fontFamily: "var(--font-display)",
              fontWeight: 700, fontSize: 13, cursor: "pointer",
            }}
          >
            + Add Companies
          </button>
        </div>
      )}

      {!refreshing && matches.length === 0 && hasCompanies && (
        <div style={{
          background: "var(--surface)", border: "1px solid var(--border)",
          borderRadius: 16, padding: "48px 24px", textAlign: "center",
          animation: "fadeUp 0.35s ease both",
        }}>
          <div style={{ fontSize: 36, marginBottom: 14 }}>🎯</div>
          <div style={{ fontFamily: "var(--font-display)", fontSize: 17, fontWeight: 700, marginBottom: 6, letterSpacing: "-0.3px" }}>
            Ready to scan
          </div>
          <div style={{ fontSize: 13, color: "var(--text-dim)", maxWidth: 380, margin: "0 auto", lineHeight: 1.6, marginBottom: 20 }}>
            You have {companies.length} {companies.length === 1 ? "company" : "companies"} tracked. Hit Refresh to fetch their latest postings and match against your resumes.
          </div>
          <button
            onClick={() => handleRefresh(true)}
            style={{
              padding: "10px 24px", borderRadius: 30, border: "none",
              background: "var(--accent)", color: "#000", fontFamily: "var(--font-display)",
              fontWeight: 700, fontSize: 13, cursor: "pointer",
            }}
          >
            ⟳ Refresh Now
          </button>
        </div>
      )}

      {!refreshing && filtered.length === 0 && matches.length > 0 && (
        <div style={{
          background: "var(--surface)", border: "1px solid var(--border)",
          borderRadius: 14, padding: "36px 20px", textAlign: "center",
          color: "var(--text-dim)", animation: "fadeUp 0.35s ease both",
        }}>
          <div style={{ fontSize: 24, marginBottom: 8 }}>🔍</div>
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
  const [autoMatches, setAutoMatches] = useState([]);
  const [customMatches, setCustomMatches] = useState([]);

  // Load profile + cached counts for tab badges
  useEffect(() => {
    (async () => {
      try {
        const [pr, am, cm] = await Promise.all([
          fetch(`${PROFILE_API}/profile`),
          fetch(`${API}/auto/matches`),
          fetch(`${API}/matches?limit=50`),
        ]);
        if (pr.ok) setProfile(await pr.json());
        if (am.ok) setAutoMatches(await am.json());
        if (cm.ok) { const d = await cm.json(); setCustomMatches(Array.isArray(d) ? d : []); }
      } catch {}
    })();
  }, []);

  return (
    <div style={{
      position: "absolute", inset: 0, display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "flex-start",
      padding: "20px", paddingTop: 110, paddingBottom: 40, overflowY: "auto",
      animation: "fadeUp 0.4s ease both",
    }}>
      <div style={{ width: "100%", maxWidth: 760 }}>

        {/* ── Header ─────────────────────────────────────────── */}
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontFamily: "var(--font-display)", fontSize: 32, fontWeight: 800, letterSpacing: "-1px", marginBottom: 4 }}>
            Job Matches
          </div>
        </div>

        {/* ── Tab switcher ────────────────────────────────────── */}
        <TabSwitcher
          activeTab={activeTab}
          onSwitch={setActiveTab}
          autoCount={autoMatches.length}
          customCount={customMatches.length}
        />

        {/* ── Tab content ─────────────────────────────────────── */}
        {activeTab === "auto" && (
          <AutoMatchesTab profile={profile} />
        )}
        {activeTab === "custom" && (
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