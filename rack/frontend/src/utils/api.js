// ─── Central API base — never hardcode localhost again ───────────────────────
// In dev: falls back to localhost:8000
// In prod: set VITE_API_URL in your deployment environment
export const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000'