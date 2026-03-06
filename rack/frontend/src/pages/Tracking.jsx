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
  const sc = scoreColor(match.score);
  const pct = Math.min(match.score, 100);
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
            <div style={{
              fontFamily: "var(--font-display)", fontSize: 22, fontWeight: 800,
              color: sc, letterSpacing: "-1px", lineHeight: 1,
            }}>
              {match.score}%
            </div>
            <div style={{ marginTop: 4 }}>{sourceBadge(match.source)}</div>
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

            {/* Component scores */}
            {match.components && Object.keys(match.components).length > 0 && (
              <div style={{ marginBottom: 18 }}>
                <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", color: "var(--text-dim)", marginBottom: 10 }}>
                  Score Breakdown
                </div>
                {Object.entries(match.components).map(([key, val]) => {
                  const pctVal = typeof val === "object" ? (val.score || val.weighted || 0) : val;
                  const display = Math.round(pctVal * 100);
                  return (
                    <div key={key} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 5 }}>
                      <span style={{ width: 75, fontSize: 11, color: "var(--text-dim)", textTransform: "capitalize" }}>{key}</span>
                      <div style={{ flex: 1, height: 4, background: "var(--surface2)", borderRadius: 4, overflow: "hidden" }}>
                        <div style={{ width: `${Math.min(display, 100)}%`, height: "100%", background: scoreColor(display), borderRadius: 4, transition: "width 0.6s ease" }} />
                      </div>
                      <span style={{ width: 26, fontSize: 11, color: "var(--text-mid)", textAlign: "right", fontFamily: "var(--font-display)", fontWeight: 600 }}>{display}</span>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Coverage */}
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

            {/* All skills */}
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

            {/* Critical gaps */}
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

            {/* Action row: Apply button + Download resume */}
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
   AUTO MATCHES TAB
   ══════════════════════════════════════════════════════════════════ */
function AutoMatchesTab({ profile }) {
  const [matches, setMatches] = useState([]);
  const [loading, setLoading] = useState(false);
  const [meta, setMeta] = useState(null);
  const [stats, setStats] = useState(null);
  const [error, setError] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const [titleFilter, setTitleFilter] = useState("");
  const hasRun = useRef(false);

  const hasProfile = profile && (profile.target_roles || []).length > 0;

  const loadStoredMatches = useCallback(async () => {
    try {
      const [mr, me] = await Promise.all([
        fetch(`${API}/auto/matches`),
        fetch(`${API}/auto/meta`),
      ]);
      if (mr.ok) setMatches(await mr.json());
      if (me.ok) setMeta(await me.json());
    } catch {}
  }, []);

  // On mount: load stored, then auto-refresh if stale
  useEffect(() => {
    if (hasRun.current) return;
    hasRun.current = true;
    (async () => {
      await loadStoredMatches();
      // Trigger a background refresh (stale check is server-side, returns cache if fresh)
      if (hasProfile) {
        handleRefresh(false);
      }
    })();
  }, [hasProfile]);

  const handleRefresh = async (force = true) => {
    setLoading(true); setError(null); setStats(null);
    try {
      const r = await fetch(`${API}/auto/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force }),
      });
      const d = await r.json();
      if (d.matches) setMatches(d.matches);
      if (d.stats) setStats(d.stats);
      await loadStoredMatches(); // refresh meta
    } catch (e) {
      setError("Auto pipeline failed: " + e.message);
    }
    setLoading(false);
  };

  const filtered = matches.filter(m =>
    !titleFilter.trim() || m.job_title?.toLowerCase().includes(titleFilter.toLowerCase())
  );

  const inputStyle = {
    padding: "8px 14px", borderRadius: 30,
    border: "1px solid var(--border)", background: "var(--surface)",
    color: "var(--text)", fontFamily: "var(--font-body)", fontSize: 12, outline: "none",
  };

  if (!hasProfile) {
    return (
      <div style={{
        background: "var(--surface)", border: "1px solid var(--border)",
        borderRadius: 16, padding: "48px 24px", textAlign: "center",
        animation: "fadeUp 0.35s ease both",
      }}>
        <div style={{ fontSize: 36, marginBottom: 14 }}>✦</div>
        <div style={{ fontFamily: "var(--font-display)", fontSize: 17, fontWeight: 700, marginBottom: 6, letterSpacing: "-0.3px" }}>
          Set your target roles first
        </div>
        <div style={{ fontSize: 13, color: "var(--text-dim)", maxWidth: 380, margin: "0 auto", lineHeight: 1.6 }}>
          Auto Matches uses your target roles from your Account profile to automatically find and score the best job postings from the last 24 hours.
        </div>
        <a
          href="#"
          onClick={(e) => { e.preventDefault(); document.querySelector('[data-tab="account"]')?.click(); }}
          style={{
            display: "inline-block", marginTop: 20, padding: "10px 24px", borderRadius: 30,
            background: "var(--accent)", color: "#000", fontFamily: "var(--font-display)",
            fontWeight: 700, fontSize: 13, textDecoration: "none",
          }}
        >
          Go to Account →
        </a>
      </div>
    );
  }

  return (
    <div>
      {/* Auto tab header row */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14, flexWrap: "wrap", gap: 10 }}>
        <div>
          <div style={{ fontSize: 13, color: "var(--text-dim)" }}>
            {matches.length > 0
              ? `${matches.length} matches · filtered from last 24h postings`
              : "Finds matching jobs from the last 24 hours automatically"
            }
            {meta?.last_fetch_at && !loading && (
              <span style={{ color: "var(--text-dim)" }}> · updated {timeAgo(meta.last_fetch_at)}</span>
            )}
          </div>
          {profile?.target_roles?.length > 0 && (
            <div style={{ display: "flex", gap: 5, marginTop: 6, flexWrap: "wrap" }}>
              {profile.target_roles.slice(0, 4).map(r => (
                <span key={r} style={{
                  fontSize: 10, padding: "2px 8px", borderRadius: 20,
                  background: "rgba(232,255,107,0.08)", color: "var(--accent)",
                  border: "1px solid rgba(232,255,107,0.15)", fontWeight: 500,
                }}>
                  {r}
                </span>
              ))}
              {profile.target_roles.length > 4 && (
                <span style={{ fontSize: 10, color: "var(--text-dim)", padding: "2px 0" }}>+{profile.target_roles.length - 4} more</span>
              )}
            </div>
          )}
        </div>
        <button
          onClick={() => handleRefresh(true)}
          disabled={loading}
          style={{
            display: "flex", alignItems: "center", gap: 6,
            padding: "8px 18px", borderRadius: 30, border: "none",
            background: "var(--accent)", color: "#000",
            fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 12,
            cursor: loading ? "default" : "pointer",
            opacity: loading ? 0.6 : 1, transition: "all 0.2s",
          }}
        >
          {loading
            ? <><span style={{ display: "inline-block", animation: "spin 1s linear infinite" }}>⟳</span> Scanning…</>
            : "⟳ Refresh Auto"
          }
        </button>
      </div>

      {/* Pipeline stats toast */}
      {stats && !stats.from_cache && stats.new_processed > 0 && (
        <div style={{
          background: "rgba(52,211,153,0.05)", border: "1px solid rgba(52,211,153,0.12)",
          borderRadius: 12, padding: "9px 16px", fontSize: 12, color: "var(--accent3)",
          marginBottom: 14, animation: "fadeUp 0.3s ease both",
          display: "flex", alignItems: "center", gap: 8,
        }}>
          <span>✦</span>
          <span>
            {stats.total_fetched} jobs fetched → {stats.new_processed} matched your profile
          </span>
        </div>
      )}

      {stats?.stats?.error === "no_profile" && (
        <div style={{
          background: "rgba(248,113,113,0.06)", border: "1px solid rgba(248,113,113,0.15)",
          borderRadius: 12, padding: "10px 16px", fontSize: 12, color: "var(--danger)",
          marginBottom: 14,
        }}>
          {stats.stats.message}
        </div>
      )}

      {error && (
        <div style={{
          background: "rgba(248,113,113,0.06)", border: "1px solid rgba(248,113,113,0.15)",
          borderRadius: 14, padding: "10px 16px", fontSize: 12, color: "var(--danger)",
          marginBottom: 14, display: "flex", justifyContent: "space-between", alignItems: "center",
        }}>
          {error}
          <button onClick={() => setError(null)} style={{ background: "none", border: "none", color: "var(--danger)", cursor: "pointer", fontSize: 13, padding: 0 }}>✕</button>
        </div>
      )}

      {/* Filters */}
      {matches.length > 0 && (
        <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
          <input
            type="text" value={titleFilter}
            onChange={(e) => setTitleFilter(e.target.value)}
            placeholder="Search by title…"
            style={{ ...inputStyle, flex: "1 1 180px" }}
          />
          <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{filtered.length} of {matches.length}</span>
        </div>
      )}

      {/* Loading state */}
      {loading && (
        <div style={{
          textAlign: "center", padding: "60px 20px", color: "var(--text-dim)",
          animation: "fadeUp 0.3s ease both",
        }}>
          <div style={{
            width: 40, height: 40, border: "3px solid rgba(232,255,107,0.15)",
            borderTopColor: "var(--accent)", borderRadius: "50%",
            animation: "spin 0.8s linear infinite", margin: "0 auto 16px",
          }} />
          <div style={{ fontFamily: "var(--font-display)", fontSize: 15, fontWeight: 700, color: "var(--accent)", marginBottom: 4 }}>
            Scanning job boards…
          </div>
          <div style={{ fontSize: 12 }}>
            Fetching last 24h postings → Filtering by target roles → Scoring against your resumes
          </div>
        </div>
      )}

      {/* Empty state */}
      {!loading && matches.length === 0 && (
        <div style={{
          background: "var(--surface)", border: "1px solid var(--border)",
          borderRadius: 16, padding: "48px 24px", textAlign: "center",
          animation: "fadeUp 0.35s ease both",
        }}>
          <div style={{ fontSize: 32, marginBottom: 14 }}>✦</div>
          <div style={{ fontFamily: "var(--font-display)", fontSize: 17, fontWeight: 700, marginBottom: 6, letterSpacing: "-0.3px" }}>
            No matches yet
          </div>
          <div style={{ fontSize: 13, color: "var(--text-dim)", maxWidth: 380, margin: "0 auto 20px", lineHeight: 1.6 }}>
            Hit "Refresh Auto" to scan for the latest {profile.target_roles?.[0] || "role"} postings from the last 24 hours.
          </div>
          <button
            onClick={() => handleRefresh(true)}
            disabled={loading}
            style={{
              padding: "10px 24px", borderRadius: 30, border: "none",
              background: "var(--accent)", color: "#000", fontFamily: "var(--font-display)",
              fontWeight: 700, fontSize: 13, cursor: "pointer",
            }}
          >
            ⟳ Refresh Auto
          </button>
        </div>
      )}

      {/* Match cards */}
      {!loading && filtered.map((m, i) => (
        <MatchCard
          key={m.job_id}
          match={m}
          index={i}
          expanded={expandedId === m.job_id}
          onToggle={() => setExpandedId(expandedId === m.job_id ? null : m.job_id)}
          isAuto={true}
        />
      ))}
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