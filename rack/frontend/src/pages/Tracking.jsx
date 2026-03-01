import { useState, useEffect, useCallback } from "react";

const API = "http://localhost:8000/api/tracking";
const PROFILE_API = "http://localhost:8000/api/account";

/* ── helpers ───────────────────────────────────────────────────── */
function scoreColor(s) {
  if (s >= 70) return "var(--accent3)";
  if (s >= 50) return "var(--accent)";
  if (s >= 30) return "#fbbf24";
  return "var(--danger)";
}

function sourceBadge(source) {
  const map = {
    greenhouse: { c: "var(--accent3)", label: "Greenhouse" },
    lever: { c: "#60a5fa", label: "Lever" },
    remotive: { c: "var(--accent2)", label: "Remotive" },
  };
  const s = map[source] || { c: "var(--text-dim)", label: source };
  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 600,
        padding: "3px 10px",
        borderRadius: 20,
        textTransform: "uppercase",
        letterSpacing: "0.08em",
        background: `${s.c}18`,
        color: s.c,
      }}
    >
      {s.label}
    </span>
  );
}

/* ── StatsRow ──────────────────────────────────────────────────── */
function StatsRow({ stats }) {
  const items = [
    { label: "Tracking", value: stats.companies_tracked || 0, accent: "var(--accent)" },
    { label: "Jobs Found", value: stats.total_jobs_fetched || 0, accent: "var(--accent2)" },
    { label: "Matches", value: stats.total_matches || 0, accent: "var(--accent3)" },
    { label: "Strong (60+)", value: stats.high_score_matches || 0, accent: "var(--accent)" },
  ];
  return (
    <div style={{ display: "flex", gap: 10, marginBottom: 28, flexWrap: "wrap" }}>
      {items.map((it, i) => (
        <div
          key={it.label}
          style={{
            flex: "1 1 120px",
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 14,
            padding: "16px 18px",
            animation: `fadeUp 0.4s ease ${i * 0.06}s both`,
          }}
        >
          <div
            style={{
              fontFamily: "var(--font-display)",
              fontSize: 26,
              fontWeight: 800,
              color: it.accent,
              letterSpacing: "-1px",
            }}
          >
            {it.value}
          </div>
          <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 2 }}>
            {it.label}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ── Preset chips ──────────────────────────────────────────────── */
function PresetChips({ presets, onAdd, loading }) {
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
      {presets.map((p, i) => {
        const added = p.in_watchlist;
        return (
          <button
            key={`${p.company}-${p.source}`}
            onClick={() => !added && onAdd(p)}
            disabled={added || loading}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "7px 16px",
              borderRadius: 30,
              border: added ? "1px solid var(--border)" : "1px solid rgba(232,255,107,0.35)",
              background: added ? "var(--surface)" : "transparent",
              color: added ? "var(--text-dim)" : "var(--accent)",
              fontFamily: "var(--font-body)",
              fontSize: 13,
              fontWeight: 500,
              cursor: added ? "default" : "pointer",
              transition: "all 0.25s ease",
              letterSpacing: "0.01em",
              animation: `fadeUp 0.3s ease ${i * 0.04}s both`,
            }}
          >
            {added ? "✓" : "+"} {p.label}
          </button>
        );
      })}
    </div>
  );
}

/* ── Watchlist table ───────────────────────────────────────────── */
function WatchlistTable({ companies, onRemove, loading }) {
  if (!companies.length) {
    return (
      <div style={{ color: "var(--text-dim)", padding: "24px 0", textAlign: "center", fontSize: 14 }}>
        No companies yet — add some above to start tracking.
      </div>
    );
  }
  return (
    <div>
      {companies.map((c, i) => (
        <div
          key={`${c.company}-${c.source}`}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 14,
            padding: "12px 0",
            borderBottom: "1px solid var(--border)",
            animation: `fadeUp 0.35s ease ${i * 0.05}s both`,
          }}
        >
          <div
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: "var(--accent3)",
              boxShadow: "0 0 8px var(--accent3)",
              flexShrink: 0,
            }}
          />
          <div style={{ flex: 1 }}>
            <span style={{ fontFamily: "var(--font-display)", fontSize: 14, fontWeight: 600, color: "var(--text)" }}>
              {c.label || c.company}
            </span>
          </div>
          {sourceBadge(c.source)}
          <span style={{ fontSize: 12, color: "var(--text-dim)", minWidth: 70 }}>
            {c.added_at ? new Date(c.added_at).toLocaleDateString() : "—"}
          </span>
          <button
            onClick={() => onRemove(c)}
            disabled={loading}
            style={{
              background: "transparent",
              border: "1px solid rgba(248,113,113,0.2)",
              color: "var(--danger)",
              padding: "4px 12px",
              borderRadius: 20,
              cursor: "pointer",
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: "0.04em",
              transition: "all 0.2s",
            }}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

/* ── Custom add form ───────────────────────────────────────────── */
function CustomAddForm({ onAdd, loading }) {
  const [company, setCompany] = useState("");
  const [source, setSource] = useState("greenhouse");

  const submit = (e) => {
    e.preventDefault();
    if (company.trim()) {
      onAdd({ company: company.trim().toLowerCase(), source, label: company.trim() });
      setCompany("");
    }
  };

  const inputStyle = {
    padding: "9px 14px",
    borderRadius: 30,
    border: "1px solid var(--border-bright)",
    background: "var(--surface)",
    color: "var(--text)",
    fontFamily: "var(--font-body)",
    fontSize: 13,
    outline: "none",
    transition: "border-color 0.2s",
  };

  return (
    <form onSubmit={submit} style={{ display: "flex", gap: 8, marginBottom: 18, flexWrap: "wrap" }}>
      <input
        type="text"
        value={company}
        onChange={(e) => setCompany(e.target.value)}
        placeholder="Board token (e.g. openai)"
        style={{ ...inputStyle, flex: "1 1 180px" }}
      />
      <select value={source} onChange={(e) => setSource(e.target.value)} style={inputStyle}>
        <option value="greenhouse">Greenhouse</option>
        <option value="lever">Lever</option>
      </select>
      <button
        type="submit"
        disabled={!company.trim() || loading}
        style={{
          padding: "9px 20px",
          borderRadius: 30,
          border: "none",
          background: company.trim() ? "var(--accent)" : "var(--surface2)",
          color: company.trim() ? "#000" : "var(--text-dim)",
          fontFamily: "var(--font-body)",
          fontWeight: 600,
          fontSize: 13,
          cursor: company.trim() ? "pointer" : "default",
          transition: "all 0.2s",
        }}
      >
        Add
      </button>
    </form>
  );
}

/* ── Match card ────────────────────────────────────────────────── */
function MatchCard({ match, index, expanded, onToggle }) {
  const sc = scoreColor(match.score);

  return (
    <div
      onClick={onToggle}
      style={{
        background: "var(--surface)",
        border: expanded ? "1px solid var(--border-bright)" : "1px solid var(--border)",
        borderRadius: 14,
        padding: "18px 22px",
        marginBottom: 10,
        cursor: "pointer",
        transition: "all 0.2s",
        animation: `fadeUp 0.4s ease ${index * 0.07}s both`,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <div
          style={{
            width: 10, height: 10, borderRadius: "50%", flexShrink: 0,
            background: sc, boxShadow: `0 0 8px ${sc}`,
          }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontFamily: "var(--font-display)", fontSize: 15, fontWeight: 600, color: "var(--text)",
              whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
            }}
          >
            {match.job_title}
          </div>
          <div style={{ fontSize: 13, color: "var(--text-dim)", marginTop: 2 }}>
            {match.company.charAt(0).toUpperCase() + match.company.slice(1)}
            {match.location && match.location !== "Not specified" ? ` · ${match.location}` : ""}
            {match.department ? ` · ${match.department}` : ""}
          </div>
        </div>
        <div style={{ fontFamily: "var(--font-display)", fontSize: 20, fontWeight: 800, color: sc, flexShrink: 0 }}>
          {match.score}%
        </div>
        {sourceBadge(match.source)}
      </div>

      <div style={{ display: "flex", gap: 6, marginTop: 12, flexWrap: "wrap" }}>
        {(match.matched_skills || []).slice(0, 5).map((s) => (
          <span key={s} style={{ fontSize: 11, fontWeight: 500, padding: "3px 9px", borderRadius: 20, background: "rgba(52,211,153,0.12)", color: "var(--accent3)" }}>
            ✓ {s}
          </span>
        ))}
        {(match.missing_skills || []).slice(0, 3).map((s) => (
          <span key={s} style={{ fontSize: 11, fontWeight: 500, padding: "3px 9px", borderRadius: 20, background: "rgba(248,113,113,0.12)", color: "var(--danger)" }}>
            ✗ {s}
          </span>
        ))}
      </div>

      {expanded && (
        <div style={{ marginTop: 18, paddingTop: 18, borderTop: "1px solid var(--border)", animation: "fadeUp 0.25s ease both" }}>
          {match.score_breakdown && Object.keys(match.score_breakdown).length > 0 && (
            <div style={{ marginBottom: 18 }}>
              <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-dim)", marginBottom: 10 }}>
                Score Breakdown
              </div>
              {Object.entries(match.score_breakdown).map(([key, val]) => {
                const pct = Math.min(val.score || 0, 100);
                return (
                  <div key={key} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                    <span style={{ width: 80, fontSize: 12, color: "var(--text-dim)", textTransform: "capitalize" }}>{key}</span>
                    <div style={{ flex: 1, height: 5, background: "var(--surface2)", borderRadius: 4, overflow: "hidden" }}>
                      <div style={{ width: `${pct}%`, height: "100%", background: scoreColor(pct), borderRadius: 4, transition: "width 0.6s ease" }} />
                    </div>
                    <span style={{ width: 28, fontSize: 12, color: "var(--text-mid)", textAlign: "right" }}>{Math.round(pct)}</span>
                  </div>
                );
              })}
            </div>
          )}

          {match.critical_gaps && match.critical_gaps.length > 0 && (
            <div style={{ marginBottom: 18 }}>
              <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--danger)", marginBottom: 8 }}>
                ⚠ Critical Gaps
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {match.critical_gaps.map((g) => {
                  const label = typeof g === "string" ? g : g.skill || JSON.stringify(g);
                  return (
                    <span key={label} style={{ fontSize: 11, fontWeight: 600, padding: "4px 11px", borderRadius: 20, background: "rgba(248,113,113,0.1)", border: "1px solid rgba(248,113,113,0.2)", color: "var(--danger)" }}>
                      {label}
                    </span>
                  );
                })}
              </div>
            </div>
          )}

          {match.job_url && (
            <a
              href={match.job_url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              style={{
                display: "inline-flex", alignItems: "center", gap: 6,
                padding: "9px 22px", borderRadius: 30, background: "var(--accent)",
                color: "#000", fontFamily: "var(--font-display)", fontWeight: 700,
                fontSize: 13, textDecoration: "none", letterSpacing: "-0.01em",
              }}
            >
              Apply →
            </a>
          )}
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════
   MAIN PAGE
   ══════════════════════════════════════════════════════════════════ */
export default function Tracking() {
  const [stats, setStats] = useState({});
  const [presets, setPresets] = useState([]);
  const [watchlist, setWatchlist] = useState({ companies: [], settings: {} });
  const [matches, setMatches] = useState([]);
  const [expandedId, setExpandedId] = useState(null);
  const [profile, setProfile] = useState(null);

  const [loadingWl, setLoadingWl] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [matching, setMatching] = useState(false);
  const [fetchResult, setFetchResult] = useState(null);
  const [matchResult, setMatchResult] = useState(null);
  const [error, setError] = useState(null);

  const [titleFilter, setTitleFilter] = useState("");
  const [dateFilter, setDateFilter] = useState("all");

  /* ── loaders ─────────────────────────────────────────────────── */
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
      const r = await fetch(`${API}/matches?limit=100`);
      if (r.ok) { const d = await r.json(); setMatches(Array.isArray(d) ? d : []); }
    } catch {}
  }, []);
  const loadProfile = useCallback(async () => {
    try { const r = await fetch(`${PROFILE_API}/profile`); if (r.ok) setProfile(await r.json()); } catch {}
  }, []);

  useEffect(() => {
    loadStats(); loadPresets(); loadWatchlist(); loadMatches(); loadProfile();
  }, [loadStats, loadPresets, loadWatchlist, loadMatches, loadProfile]);

  /* ── actions ─────────────────────────────────────────────────── */
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

  const handleRemove = async (c) => {
    setLoadingWl(true);
    try {
      await fetch(`${API}/watchlist`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ company: c.company, source: c.source }) });
      await refresh();
    } catch (e) { setError(e.message); }
    setLoadingWl(false);
  };

  const handleFetch = async () => {
    setFetching(true); setFetchResult(null); setError(null);
    try {
      const r = await fetch(`${API}/fetch`, { method: "POST" });
      const d = await r.json();
      setFetchResult(d);
      await loadStats();
    } catch (e) { setError("Fetch failed: " + e.message); }
    setFetching(false);
  };

  const handleMatch = async () => {
    setMatching(true); setMatchResult(null); setError(null);
    try {
      const body = { limit: 20, date_filter: dateFilter !== "all" ? dateFilter : null, use_profile: true };
      if (titleFilter.trim()) body.title_filter = titleFilter.trim();
      const r = await fetch(`${API}/match`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const d = await r.json();
      setMatchResult(d);
      if (d.matches) setMatches(d.matches);
      await Promise.all([loadStats(), loadMatches()]);
    } catch (e) { setError("Match failed: " + e.message); }
    setMatching(false);
  };

  /* ── helpers ─────────────────────────────────────────────────── */
  const shown = titleFilter.trim()
    ? matches.filter((m) => m.job_title.toLowerCase().includes(titleFilter.toLowerCase()))
    : matches;

  const hasCompanies = (watchlist.companies || []).length > 0;
  const hasProfile = profile && (profile.target_roles || []).length > 0;

  const selectStyle = {
    padding: "9px 14px",
    borderRadius: 30,
    border: "1px solid var(--border-bright)",
    background: "var(--surface)",
    color: "var(--text)",
    fontFamily: "var(--font-body)",
    fontSize: 13,
    outline: "none",
  };

  /* ── render ──────────────────────────────────────────────────── */
  return (
    <div
      style={{
        position: "absolute", inset: 0, display: "flex", flexDirection: "column",
        alignItems: "center", justifyContent: "flex-start",
        padding: 20, paddingTop: 110, paddingBottom: 40, overflowY: "auto",
        animation: "fadeUp 0.4s ease both",
      }}
    >
      <div style={{ width: "100%", maxWidth: 720 }}>
        {/* header */}
        <div style={{ fontFamily: "var(--font-display)", fontSize: 32, fontWeight: 800, letterSpacing: "-1px", marginBottom: 6 }}>
          Job Watchlist
        </div>
        <div style={{ fontSize: 14, color: "var(--text-dim)", marginBottom: 28 }}>
          Track companies · Auto-fetch postings · Match against your resume
        </div>

        <StatsRow stats={stats} />

        {/* profile indicator */}
        <div
          style={{
            display: "flex", alignItems: "center", gap: 10, marginBottom: 20,
            padding: "10px 16px", borderRadius: 14,
            background: hasProfile ? "rgba(52,211,153,0.06)" : "rgba(248,113,113,0.06)",
            border: hasProfile ? "1px solid rgba(52,211,153,0.15)" : "1px solid rgba(248,113,113,0.15)",
            animation: "fadeUp 0.35s ease 0.08s both",
          }}
        >
          <div style={{
            width: 8, height: 8, borderRadius: "50%", flexShrink: 0,
            background: hasProfile ? "var(--accent3)" : "var(--danger)",
            boxShadow: hasProfile ? "0 0 8px var(--accent3)" : "0 0 8px var(--danger)",
          }} />
          <div style={{ flex: 1, fontSize: 13, color: hasProfile ? "var(--accent3)" : "var(--text-dim)" }}>
            {hasProfile
              ? `Profile active · ${profile.target_roles.length} roles · ${(profile.preferred_locations || []).length} locations`
              : "No profile set — all jobs will be processed. Set up your profile in the Account tab to filter."}
          </div>
          {hasProfile && (
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
              {profile.target_roles.slice(0, 3).map((r) => (
                <span key={r} style={{ fontSize: 10, padding: "2px 8px", borderRadius: 20, background: "rgba(52,211,153,0.12)", color: "var(--accent3)" }}>
                  {r}
                </span>
              ))}
              {profile.target_roles.length > 3 && (
                <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 20, background: "rgba(52,211,153,0.12)", color: "var(--accent3)" }}>
                  +{profile.target_roles.length - 3}
                </span>
              )}
            </div>
          )}
        </div>

        {/* error */}
        {error && (
          <div style={{
            background: "rgba(248,113,113,0.08)", border: "1px solid rgba(248,113,113,0.2)",
            borderRadius: 14, padding: "12px 18px", fontSize: 13, color: "var(--danger)",
            marginBottom: 16, display: "flex", justifyContent: "space-between", alignItems: "center",
            animation: "fadeUp 0.3s ease both",
          }}>
            {error}
            <button onClick={() => setError(null)} style={{ background: "none", border: "none", color: "var(--danger)", cursor: "pointer", fontSize: 14, padding: 0 }}>✕</button>
          </div>
        )}

        {/* ── companies card ─────────────────────────────────────── */}
        <div style={{
          background: "var(--surface)", border: "1px solid var(--border)",
          borderRadius: "var(--radius)", padding: "22px 24px", marginBottom: 24,
          animation: "fadeUp 0.4s ease 0.05s both",
        }}>
          <div style={{ fontFamily: "var(--font-display)", fontSize: 16, fontWeight: 700, color: "var(--text)", marginBottom: 14, letterSpacing: "-0.3px" }}>
            Companies
          </div>
          <div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 8 }}>Quick add:</div>
          <PresetChips presets={presets} onAdd={handleAdd} loading={loadingWl} />
          <CustomAddForm onAdd={handleAdd} loading={loadingWl} />
          <WatchlistTable companies={watchlist.companies || []} onRemove={handleRemove} loading={loadingWl} />
        </div>

        {/* ── action bar ─────────────────────────────────────────── */}
        <div style={{
          display: "flex", gap: 10, marginBottom: 22, flexWrap: "wrap", alignItems: "center",
          animation: "fadeUp 0.4s ease 0.1s both",
        }}>
          <button
            onClick={handleFetch}
            disabled={fetching || !hasCompanies}
            style={{
              display: "flex", alignItems: "center", gap: 7,
              padding: "10px 22px", borderRadius: 30, border: "none",
              background: hasCompanies ? "var(--accent)" : "var(--surface2)",
              color: hasCompanies ? "#000" : "var(--text-dim)",
              fontFamily: "var(--font-body)", fontWeight: 600, fontSize: 14,
              cursor: hasCompanies ? "pointer" : "default",
              opacity: fetching ? 0.6 : 1, transition: "all 0.25s ease", letterSpacing: "0.01em",
            }}
          >
            {fetching ? (<><span style={{ display: "inline-block", animation: "spin 1s linear infinite" }}>⟳</span> Fetching…</>) : "📡 Fetch Jobs"}
          </button>

          <button
            onClick={handleMatch}
            disabled={matching || !stats.total_jobs_fetched}
            style={{
              display: "flex", alignItems: "center", gap: 7,
              padding: "10px 22px", borderRadius: 30,
              border: stats.total_jobs_fetched ? "1px solid rgba(232,255,107,0.35)" : "1px solid var(--border)",
              background: "transparent",
              color: stats.total_jobs_fetched ? "var(--accent)" : "var(--text-dim)",
              fontFamily: "var(--font-body)", fontWeight: 600, fontSize: 14,
              cursor: stats.total_jobs_fetched ? "pointer" : "default",
              opacity: matching ? 0.6 : 1, transition: "all 0.25s ease", letterSpacing: "0.01em",
            }}
          >
            {matching ? (<><span style={{ display: "inline-block", animation: "spin 1s linear infinite" }}>⟳</span> Matching…</>) : "🎯 Auto-Match"}
          </button>

          {/* Date filter */}
          <select value={dateFilter} onChange={(e) => setDateFilter(e.target.value)} style={selectStyle}>
            <option value="all">All dates</option>
            <option value="24h">Last 24 hours</option>
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
          </select>

          {/* Title filter */}
          <input
            type="text"
            value={titleFilter}
            onChange={(e) => setTitleFilter(e.target.value)}
            placeholder="Filter by title…"
            style={{
              flex: "1 1 140px", padding: "9px 16px", borderRadius: 30,
              border: "1px solid var(--border-bright)", background: "var(--surface)",
              color: "var(--text)", fontFamily: "var(--font-body)", fontSize: 13, outline: "none",
            }}
          />
        </div>

        {/* fetch toast */}
        {fetchResult && (
          <div style={{
            background: "rgba(232,255,107,0.06)", border: "1px solid rgba(232,255,107,0.18)",
            borderRadius: 14, padding: "11px 18px", fontSize: 13, color: "var(--accent)",
            marginBottom: 14, animation: "fadeUp 0.3s ease both",
          }}>
            ✓ Fetched <strong>{fetchResult.jobs_count || 0}</strong> jobs
            {fetchResult.by_company && ` — ${Object.entries(fetchResult.by_company).map(([k, v]) => `${k}: ${v}`).join(", ")}`}
          </div>
        )}

        {/* match result toast with filter pipeline stats */}
        {matchResult && matchResult.status === "matched" && (
          <div style={{
            background: "rgba(52,211,153,0.06)", border: "1px solid rgba(52,211,153,0.18)",
            borderRadius: 14, padding: "11px 18px", fontSize: 13, color: "var(--accent3)",
            marginBottom: 14, animation: "fadeUp 0.3s ease both",
          }}>
            ✓ Processed <strong>{matchResult.new_jobs_processed}</strong> jobs · <strong>{matchResult.above_threshold}</strong> above {matchResult.min_score_threshold}%
            {matchResult.filter_stats && (
              <span style={{ color: "var(--text-dim)", fontSize: 12 }}>
                {" "}· Pipeline: {matchResult.filter_stats.total_fetched} fetched → {matchResult.filter_stats.after_date_filter} after date → {matchResult.filter_stats.after_profile_filter} after profile → {matchResult.filter_stats.processed} processed
              </span>
            )}
          </div>
        )}

        {matchResult && matchResult.status === "no_matching_jobs" && (
          <div style={{
            background: "rgba(251,191,36,0.06)", border: "1px solid rgba(251,191,36,0.18)",
            borderRadius: 14, padding: "11px 18px", fontSize: 13, color: "#fbbf24",
            marginBottom: 14, animation: "fadeUp 0.3s ease both",
          }}>
            ⚠ {matchResult.message}
          </div>
        )}

        {/* ── matches ────────────────────────────────────────────── */}
        <div style={{ fontFamily: "var(--font-display)", fontSize: 16, fontWeight: 700, letterSpacing: "-0.3px", marginBottom: 14 }}>
          {shown.length > 0 ? `Matches · ${shown.length}` : "Matches"}
        </div>

        {matching && (
          <div style={{ textAlign: "center", padding: "48px 20px", color: "var(--text-dim)", animation: "fadeUp 0.3s ease both" }}>
            <div style={{ display: "inline-block", fontSize: 22, animation: "spin 1.2s linear infinite", marginBottom: 12 }}>⟳</div>
            <div style={{ fontSize: 14 }}>Running RACK pipeline on filtered jobs…</div>
            <div style={{ fontSize: 12, marginTop: 4, color: "var(--text-dim)" }}>Profile + date filter → Parse → Score → Gap analysis</div>
          </div>
        )}

        {!matching && shown.length === 0 && (
          <div style={{
            background: "var(--surface)", border: "1px solid var(--border)",
            borderRadius: 14, padding: "48px 20px", textAlign: "center",
            color: "var(--text-dim)", animation: "fadeUp 0.35s ease both",
          }}>
            <div style={{ fontSize: 28, marginBottom: 10 }}>🎯</div>
            <div style={{ fontSize: 14 }}>No matches yet. Add companies → Fetch Jobs → Auto-Match</div>
          </div>
        )}

        {!matching && shown.map((m, i) => (
          <MatchCard
            key={m.job_id + (m.resume_id || "")}
            match={m}
            index={i}
            expanded={expandedId === m.job_id}
            onToggle={() => setExpandedId(expandedId === m.job_id ? null : m.job_id)}
          />
        ))}
      </div>
    </div>
  );
}