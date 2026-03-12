// ─── Central API base — never hardcode localhost again ───────────────────────
// In dev: falls back to localhost:8000
// In prod: set VITE_API_URL in your deployment environment
export const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000'

/**
 * getAuthHeaders()
 *
 * Returns an Authorization header with the current user's JWT if signed in,
 * or an empty object if anonymous. Import and spread into any fetch call.
 *
 * Usage:
 *   import { API_BASE, getAuthHeaders } from '../utils/api'
 *
 *   const res = await fetch(`${API_BASE}/api/resumes`, {
 *     headers: { ...await getAuthHeaders() }
 *   })
 *
 * Anonymous users get no Authorization header — routes that use
 * Optional auth (like /api/resumes for anonymous) will still work.
 * Routes that require auth (Tracking, Auto Matches) will return 401.
 */
export async function getAuthHeaders() {
  try {
    // Lazy import to avoid circular deps — supabaseClient is only needed here
    const { supabase } = await import('../lib/supabaseClient')
    const { data: { session } } = await supabase.auth.getSession()
    if (session?.access_token) {
      return { Authorization: `Bearer ${session.access_token}` }
    }
  } catch {
    // Supabase not available or no session — return empty, anonymous mode
  }
  return {}
}