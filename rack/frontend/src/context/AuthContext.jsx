/**
 * context/AuthContext.jsx
 *
 * Provides:
 *   - user         → Supabase Auth user object (null = anonymous)
 *   - session      → full session (has session.access_token for API calls)
 *   - authLoading  → true while initial session is being resolved
 *   - signInWithGoogle()
 *   - signOut()
 *
 * On sign-in: triggers localStorage resume migration to DB automatically.
 *
 * Wrap your app:
 *   <AuthProvider><App /></AuthProvider>
 *
 * Consume anywhere:
 *   const { user, signInWithGoogle } = useAuth()
 */

import { createContext, useContext, useEffect, useState, useCallback } from 'react'
import { supabase } from '../lib/supabaseClient'
import { API_BASE } from '../utils/api'

const AuthContext = createContext(null)

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Migrate anonymous localStorage resumes to the user's DB account.
 * Called exactly once right after a new sign-in is detected.
 *
 * localStorage key: 'rack_resumes'
 * Shape: [{ id, name, fileBase64, fileExt, fileType, skills, ... }, ...]
 */
async function migrateLocalResumesToDB(accessToken) {
  const raw = localStorage.getItem('rack_resumes')
  if (!raw) return

  let resumes
  try {
    resumes = JSON.parse(raw)
  } catch {
    return
  }

  if (!Array.isArray(resumes) || resumes.length === 0) return

  console.log(`[Auth] Migrating ${resumes.length} local resume(s) to account...`)

  for (const resume of resumes) {
    try {
      // Convert base64 back to a Blob/File for upload
      const byteString = atob(resume.fileBase64)
      const ab = new ArrayBuffer(byteString.length)
      const ia = new Uint8Array(ab)
      for (let i = 0; i < byteString.length; i++) ia[i] = byteString.charCodeAt(i)
      const blob = new Blob([ab], { type: resume.fileType || 'application/pdf' })
      const file = new File([blob], resume.name, { type: resume.fileType || 'application/pdf' })

      const formData = new FormData()
      formData.append('file', file)

      await fetch(`${API_BASE}/api/resumes/upload`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
        body: formData,
      })
    } catch (err) {
      console.warn(`[Auth] Failed to migrate resume "${resume.name}":`, err)
    }
  }

  // Clear localStorage only after all uploads attempted
  localStorage.removeItem('rack_resumes')
  console.log('[Auth] Migration complete — local resumes cleared.')
}

// ── Provider ──────────────────────────────────────────────────────────────────

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [session, setSession] = useState(null)
  const [authLoading, setAuthLoading] = useState(true)
  // Track if we've already migrated for this session to avoid double-runs
  const [migrated, setMigrated] = useState(false)

  useEffect(() => {
    // 1. Resolve initial session on mount (handles page refresh + OAuth redirect)
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session)
      setUser(session?.user ?? null)
      setAuthLoading(false)
    })

    // 2. Listen for auth state changes (sign-in, sign-out, token refresh)
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event, session) => {
        setSession(session)
        setUser(session?.user ?? null)
        setAuthLoading(false)

        // Trigger migration on first sign-in if not already done
        if (
          (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') &&
          session?.access_token &&
          !migrated
        ) {
          setMigrated(true)
          await migrateLocalResumesToDB(session.access_token)
        }

        if (event === 'SIGNED_OUT') {
          setMigrated(false)
        }
      }
    )

    return () => subscription.unsubscribe()
  }, [migrated])

  const signInWithGoogle = useCallback(async () => {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        // After OAuth, Supabase redirects back to this URL
        redirectTo: window.location.origin,
      },
    })
    if (error) console.error('[Auth] Google sign-in error:', error.message)
  }, [])

  const signOut = useCallback(async () => {
    await supabase.auth.signOut()
  }, [])

  return (
    <AuthContext.Provider value={{ user, session, authLoading, signInWithGoogle, signOut }}>
      {children}
    </AuthContext.Provider>
  )
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}