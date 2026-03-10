import { useState, useEffect, useCallback } from "react";

const API = "http://localhost:8000/api/account";

/* ── Chip input (compact, inline) ──────────────────────────────── */
function ChipInput({ items, onUpdate, presets, placeholder, accent = "var(--accent)" }) {
  const [input, setInput] = useState("");
  const [focused, setFocused] = useState(false);

  const add = (val) => {
    const t = val.trim();
    if (t && !items.includes(t)) onUpdate([...items, t]);
    setInput("");
  };
  const remove = (val) => onUpdate(items.filter((i) => i !== val));

  const handleKey = (e) => {
    if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(input); }
    if (e.key === "Backspace" && !input && items.length) remove(items[items.length - 1]);
  };

  const unused = presets ? presets.filter((p) => !items.includes(p)) : [];

  return (
    <div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: items.length ? 10 : 0 }}>
        {items.map((item, i) => (
          <span
            key={item}
            style={{
              display: "inline-flex", alignItems: "center", gap: 5,
              padding: "4px 11px", borderRadius: 20,
              background: `${accent}12`, border: `1px solid ${accent}25`,
              color: accent, fontSize: 12, fontWeight: 500,
              animation: `fadeUp 0.2s ease ${i * 0.03}s both`,
            }}
          >
            {item}
            <button onClick={() => remove(item)} style={{
              background: "none", border: "none", color: accent,
              cursor: "pointer", fontSize: 12, padding: 0, opacity: 0.5, lineHeight: 1,
            }}>✕</button>
          </span>
        ))}
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        <input
          type="text" value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKey}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 200)}
          placeholder={placeholder}
          style={{
            flex: 1, padding: "8px 14px", borderRadius: 30,
            border: "1px solid var(--border)", background: "var(--bg)",
            color: "var(--text)", fontFamily: "var(--font-body)",
            fontSize: 13, outline: "none",
          }}
        />
        {input.trim() && (
          <button onClick={() => add(input)} style={{
            padding: "8px 16px", borderRadius: 30, border: "none",
            background: accent, color: "#000", fontWeight: 600, fontSize: 12,
            cursor: "pointer",
          }}>Add</button>
        )}
      </div>

      {focused && unused.length > 0 && (
        <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginTop: 8 }}>
          {unused.slice(0, 6).map((p) => (
            <button key={p} onMouseDown={() => add(p)} style={{
              padding: "4px 10px", borderRadius: 20,
              border: "1px solid var(--border)", background: "transparent",
              color: "var(--text-dim)", fontSize: 11, cursor: "pointer",
              fontFamily: "var(--font-body)", transition: "all 0.15s",
            }}>+ {p}</button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════ */
export default function Account() {
  const [profile, setProfile] = useState(null);
  const [presets, setPresets] = useState({ roles: [], locations: [] });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [activeSection, setActiveSection] = useState(null);

  const loadProfile = useCallback(async () => {
    try { const r = await fetch(`${API}/profile`); if (r.ok) setProfile(await r.json()); } catch {}
    setLoading(false);
  }, []);

  const loadPresets = useCallback(async () => {
    try { const r = await fetch(`${API}/presets`); if (r.ok) setPresets(await r.json()); } catch {}
  }, []);

  useEffect(() => { loadProfile(); loadPresets(); }, [loadProfile, loadPresets]);

  const saveProfile = async () => {
    setSaving(true); setSaved(false);
    try {
      const r = await fetch(`${API}/profile`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(profile),
      });
      if (r.ok) { setProfile(await r.json()); setSaved(true); setTimeout(() => setSaved(false), 3000); }
    } catch {}
    setSaving(false);
  };

  const updateField = (field, value) => { setProfile((p) => ({ ...p, [field]: value })); setSaved(false); };

  if (loading || !profile) {
    return (
      <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)", animation: "fadeUp 0.4s ease both" }}>
        <span style={{ display: "inline-block", animation: "spin 1.2s linear infinite", marginRight: 10 }}>⟳</span>
        Loading profile…
      </div>
    );
  }

  const roleCount = (profile.target_roles || []).length;
  const locCount = (profile.preferred_locations || []).length;
  const hasProfile = roleCount > 0;

  /* helper: collapsible section */
  const Section = ({ id, icon, title, subtitle, children, delay = 0 }) => {
    const open = activeSection === id;
    return (
      <div
        style={{
          background: "var(--surface)",
          border: open ? "1px solid var(--border-bright)" : "1px solid var(--border)",
          borderRadius: "var(--radius)",
          overflow: "hidden",
          marginBottom: 10,
          transition: "border-color 0.2s",
          animation: `fadeUp 0.4s ease ${delay}s both`,
        }}
      >
        <div
          onClick={() => setActiveSection(open ? null : id)}
          style={{
            display: "flex", alignItems: "center", gap: 14,
            padding: "18px 22px", cursor: "pointer", transition: "background 0.2s",
          }}
        >
          <span style={{ fontSize: 18, width: 24, textAlign: "center" }}>{icon}</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: "var(--font-display)", fontSize: 14, fontWeight: 600, color: "var(--text)", letterSpacing: "-0.2px" }}>
              {title}
            </div>
            <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 1 }}>{subtitle}</div>
          </div>
          <span style={{
            fontSize: 12, color: "var(--text-dim)",
            transform: open ? "rotate(90deg)" : "rotate(0deg)",
            transition: "transform 0.2s ease",
          }}>▸</span>
        </div>
        {open && (
          <div style={{ padding: "0 22px 20px", animation: "fadeUp 0.2s ease both" }}>
            {children}
          </div>
        )}
      </div>
    );
  };

  return (
    <div style={{
      position: "absolute", inset: 0, display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "flex-start",
      padding: 20, paddingTop: "var(--page-padding-top)", paddingBottom: "var(--page-padding-bottom)", overflowY: "auto",
      animation: "fadeUp 0.4s ease both",
    }}>
      <div style={{ width: "100%", maxWidth: 520 }}>

        {/* ── Avatar + Name ────────────────────────────────────── */}
        <div style={{ textAlign: "center", marginBottom: 28, animation: "fadeUp 0.4s ease both" }}>
          <div style={{
            width: 80, height: 80, borderRadius: "50%",
            background: "linear-gradient(135deg, #1a1a3e, #0d2a1f)",
            border: "2px solid var(--border-bright)",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontFamily: "var(--font-display)", fontSize: 28, fontWeight: 800,
            margin: "0 auto 16px",
            boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
          }}>
            TB
          </div>
          <div style={{ fontFamily: "var(--font-display)", fontSize: 24, fontWeight: 800, letterSpacing: "-0.5px", marginBottom: 4 }}>
            Tejas B K
          </div>
          <div style={{ fontSize: 14, color: "var(--text-dim)", marginBottom: 6 }}>
            tejas.bk@example.com
          </div>

          {/* Profile status badge */}
          <div style={{
            display: "inline-flex", alignItems: "center", gap: 6,
            padding: "5px 14px", borderRadius: 20, marginTop: 4,
            background: hasProfile ? "rgba(52,211,153,0.08)" : "rgba(255,255,255,0.04)",
            border: hasProfile ? "1px solid rgba(52,211,153,0.15)" : "1px solid var(--border)",
          }}>
            <div style={{
              width: 6, height: 6, borderRadius: "50%",
              background: hasProfile ? "var(--accent3)" : "var(--text-dim)",
              boxShadow: hasProfile ? "0 0 6px var(--accent3)" : "none",
            }} />
            <span style={{ fontSize: 11, fontWeight: 500, color: hasProfile ? "var(--accent3)" : "var(--text-dim)" }}>
              {hasProfile ? `${roleCount} roles · ${locCount} locations` : "No preferences set"}
            </span>
          </div>
        </div>

        {/* ── Settings Card (static, like original) ────────────── */}
        <div style={{
          background: "var(--surface)", border: "1px solid var(--border-bright)",
          borderRadius: "var(--radius)", overflow: "hidden",
          boxShadow: "0 8px 40px rgba(0,0,0,0.3)",
          marginBottom: 20, animation: "fadeUp 0.4s ease 0.05s both",
        }}>
          {[
            { icon: "🎨", label: "Theme", value: "Dark (System)" },
            { icon: "🔔", label: "Notifications", value: "Enabled" },
            { icon: "🔑", label: "API Key", value: "••••••••••••" },
            { icon: "📦", label: "Plan", value: "Pro" },
          ].map((row, i, arr) => (
            <div key={row.label} style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              padding: "16px 22px",
              borderBottom: i < arr.length - 1 ? "1px solid var(--border)" : "none",
              cursor: "pointer", transition: "background 0.2s",
            }}>
              <div style={{ fontSize: 14, color: "var(--text-mid)", display: "flex", alignItems: "center", gap: 12 }}>
                <span style={{ fontSize: 16 }}>{row.icon}</span>{row.label}
              </div>
              <div style={{ fontSize: 13, color: "var(--text-dim)" }}>{row.value}</div>
            </div>
          ))}
        </div>

        {/* ── Job Preferences Header ───────────────────────────── */}
        <div style={{
          fontFamily: "var(--font-display)", fontSize: 13, fontWeight: 700,
          textTransform: "uppercase", letterSpacing: "0.1em",
          color: "var(--text-dim)", marginBottom: 12, marginTop: 8,
          paddingLeft: 4, animation: "fadeUp 0.4s ease 0.1s both",
        }}>
          Job Preferences
        </div>

        {/* ── Collapsible Sections ─────────────────────────────── */}
        <Section
          id="roles" icon="🎯" delay={0.12}
          title="Target Roles"
          subtitle={roleCount ? `${roleCount} roles configured` : "Not set — all jobs will be matched"}
        >
          <ChipInput
            items={profile.target_roles || []}
            onUpdate={(v) => updateField("target_roles", v)}
            presets={presets.roles}
            placeholder="Type a role and press Enter…"
            accent="var(--accent)"
          />
        </Section>

        <Section
          id="locations" icon="📍" delay={0.15}
          title="Preferred Locations"
          subtitle={locCount ? `${locCount} locations set` : "Not set — all locations included"}
        >
          <ChipInput
            items={profile.preferred_locations || []}
            onUpdate={(v) => updateField("preferred_locations", v)}
            presets={presets.locations}
            placeholder="Type a location and press Enter…"
            accent="var(--accent2)"
          />
          <div style={{
            marginTop: 10, padding: "9px 13px", borderRadius: 10,
            background: "rgba(167,139,250,0.06)", border: "1px solid rgba(167,139,250,0.15)",
            fontSize: 11, color: "var(--text-dim)", lineHeight: 1.6,
          }}>
            <span style={{ color: "var(--accent2)", fontWeight: 600 }}>💡 Tip:</span>{" "}
            Use a <strong style={{ color: "var(--text-mid)" }}>country</strong> (e.g. "United States") to match all cities
            and remote jobs within that country. Adding "Remote" alone only shows remote jobs
            in countries you've already added.
          </div>
        </Section>

        <Section
          id="experience" icon="📊" delay={0.18}
          title="Experience Level"
          subtitle={profile.min_years != null || profile.max_years != null
            ? `${profile.min_years ?? 0}–${profile.max_years ?? "∞"} years`
            : "Not set"}
        >
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <div>
              <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-dim)", marginBottom: 6 }}>Min</div>
              <input
                type="number" min={0} max={30}
                value={profile.min_years ?? ""}
                onChange={(e) => updateField("min_years", e.target.value ? parseInt(e.target.value) : null)}
                placeholder="0"
                style={{
                  width: 64, padding: "8px 10px", borderRadius: 30, textAlign: "center",
                  border: "1px solid var(--border)", background: "var(--bg)",
                  color: "var(--text)", fontFamily: "var(--font-body)", fontSize: 13, outline: "none",
                }}
              />
            </div>
            <span style={{ color: "var(--text-dim)", marginTop: 18, fontSize: 13 }}>to</span>
            <div>
              <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-dim)", marginBottom: 6 }}>Max</div>
              <input
                type="number" min={0} max={30}
                value={profile.max_years ?? ""}
                onChange={(e) => updateField("max_years", e.target.value ? parseInt(e.target.value) : null)}
                placeholder="10"
                style={{
                  width: 64, padding: "8px 10px", borderRadius: 30, textAlign: "center",
                  border: "1px solid var(--border)", background: "var(--bg)",
                  color: "var(--text)", fontFamily: "var(--font-body)", fontSize: 13, outline: "none",
                }}
              />
            </div>
          </div>
        </Section>

        <Section
          id="keywords" icon="🔖" delay={0.21}
          title="Keywords"
          subtitle="Include or exclude terms from job titles"
        >
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-dim)", marginBottom: 8 }}>
              Include (catch extra jobs)
            </div>
            <ChipInput
              items={profile.include_keywords || []}
              onUpdate={(v) => updateField("include_keywords", v)}
              presets={[]}
              placeholder="e.g. python, pytorch, rag…"
              accent="var(--accent3)"
            />
          </div>
          <div>
            <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-dim)", marginBottom: 8 }}>
              Exclude (hide these)
            </div>
            <ChipInput
              items={profile.exclude_keywords || []}
              onUpdate={(v) => updateField("exclude_keywords", v)}
              presets={[]}
              placeholder="e.g. senior, staff, director…"
              accent="var(--danger)"
            />
          </div>
        </Section>

        {/* ── Save ─────────────────────────────────────────────── */}
        <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 6, animation: "fadeUp 0.4s ease 0.24s both" }}>
          <button
            onClick={saveProfile} disabled={saving}
            style={{
              padding: "12px 32px", borderRadius: 30, border: "none",
              background: "var(--accent)", color: "#000",
              fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 14,
              cursor: "pointer", opacity: saving ? 0.6 : 1,
              transition: "all 0.2s", letterSpacing: "-0.01em",
            }}
          >
            {saving ? "Saving…" : "Save Preferences"}
          </button>
          {saved && (
            <span style={{ fontSize: 13, color: "var(--accent3)", animation: "fadeUp 0.3s ease both" }}>
              ✓ Saved
            </span>
          )}
        </div>

        {/* ── How it works ─────────────────────────────────────── */}
        <div style={{
          marginTop: 28, padding: "16px 20px", borderRadius: 14,
          background: "var(--surface)", border: "1px solid var(--border)",
          animation: "fadeUp 0.4s ease 0.28s both",
        }}>
          <div style={{ fontFamily: "var(--font-display)", fontSize: 13, fontWeight: 700, color: "var(--text)", marginBottom: 6, letterSpacing: "-0.2px" }}>
            How filtering works
          </div>
          <div style={{ fontSize: 12, color: "var(--text-dim)", lineHeight: 1.7 }}>
            Your preferences filter jobs <em>before</em> the RACK pipeline runs.
            Instead of scoring 100+ jobs, we narrow to only relevant roles — faster results, less noise.
          </div>
          <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
            {["4k+ fetched", "→ roles", "→ location", "→ ~20", "→ LLM", "→ RACK"].map((s, i) => (
              <span key={s} style={{
                fontSize: 10, fontWeight: 600, padding: "3px 9px", borderRadius: 20,
                background: i === 5 ? "rgba(232,255,107,0.12)" : "var(--surface2)",
                color: i === 5 ? "var(--accent)" : "var(--text-dim)",
                border: i === 5 ? "1px solid rgba(232,255,107,0.2)" : "1px solid var(--border)",
              }}>{s}</span>
            ))}
          </div>
        </div>

        {/* ── Sign out ─────────────────────────────────────────── */}
        <div style={{ textAlign: "center", marginTop: 28, animation: "fadeUp 0.4s ease 0.32s both" }}>
          <button style={{
            padding: "12px 32px", borderRadius: 30,
            background: "rgba(248,113,113,0.1)", border: "1px solid rgba(248,113,113,0.2)",
            color: "var(--danger)", fontFamily: "var(--font-body)",
            fontSize: 14, fontWeight: 500, cursor: "pointer", transition: "all 0.2s",
          }}>
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}