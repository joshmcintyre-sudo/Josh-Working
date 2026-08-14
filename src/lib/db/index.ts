/**
 * Repository selection.
 *
 * Supabase when it is configured and there is a signed-in user, the local store
 * otherwise. The app never branches on this — it asks for a repository and
 * gets one that works.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { LocalLoomRepository } from './local-repository'
import type { LoomRepository } from './repository'
import { SupabaseLoomRepository } from './supabase-repository'

export * from './repository'
export * from './mappers'
export { LocalLoomRepository } from './local-repository'
export { SupabaseLoomRepository } from './supabase-repository'

let cachedClient: SupabaseClient | null | undefined

export function supabaseClient(): SupabaseClient | null {
  if (cachedClient !== undefined) return cachedClient
  const url = import.meta.env?.VITE_SUPABASE_URL
  const key = import.meta.env?.VITE_SUPABASE_ANON_KEY
  cachedClient = url && key ? createClient(url, key) : null
  return cachedClient
}

export function isSupabaseConfigured(): boolean {
  return supabaseClient() !== null
}

let cachedRepo: LoomRepository | null = null

export async function getRepository(): Promise<LoomRepository> {
  if (cachedRepo) return cachedRepo
  const db = supabaseClient()
  if (db) {
    const { data } = await db.auth.getUser()
    if (data.user) {
      cachedRepo = new SupabaseLoomRepository(db, data.user.id)
      return cachedRepo
    }
  }
  cachedRepo = new LocalLoomRepository()
  return cachedRepo
}

/** Drop the cached repository, e.g. after sign-in or sign-out. */
export function resetRepository(): void {
  cachedRepo = null
}
