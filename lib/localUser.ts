import { db } from '@/db/client'
import { users } from '@/db/schema'

/**
 * Single-tenant, login-less mode.
 *
 * The app no longer has Spotify OAuth, so there is no per-user identity. Every
 * curation / digging chain is owned by one fixed pseudo-user. The DB schema
 * still carries `user_id` columns (curations, and the now-dormant
 * liked/top/plays tables) so we keep a stable id rather than ripping the FK
 * axis out of the schema — that makes restoring multi-user later a smaller
 * change, and keeps the existing owner-scoped queries (`eq(..., LOCAL_USER)`)
 * working untouched.
 */
export const LOCAL_USER = 'local'

let ensured = false

/**
 * Make sure the single `users` row exists before anything inserts a curation
 * that references it. Idempotent and cheap: after the first successful upsert
 * in a given server process we skip the round-trip entirely.
 */
export async function ensureLocalUser(): Promise<void> {
  if (ensured) return
  await db
    .insert(users)
    .values({ id: LOCAL_USER, displayName: null })
    .onConflictDoNothing({ target: users.id })
  ensured = true
}
