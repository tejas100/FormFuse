/**
 * supabaseClient.js — singleton Supabase client for the frontend
 *
 * Import this wherever you need auth or storage:
 *   import { supabase } from '@/lib/supabaseClient'
 *
 * Env vars required in frontend/.env:
 *   VITE_SUPABASE_URL=https://lgtgtibpdbfkurfgiraq.supabase.co
 *   VITE_SUPABASE_ANON_KEY=sb_publishable_...
 */

import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    'Missing Supabase env vars. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to frontend/.env'
  )
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    // Store session in localStorage so it survives page refreshes
    persistSession: true,
    // Auto-refresh tokens before they expire
    autoRefreshToken: true,
    // Detect OAuth redirects (hash fragment from Supabase callback)
    detectSessionInUrl: true,
  },
})