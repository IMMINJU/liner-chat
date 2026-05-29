import { Pool, neonConfig } from '@neondatabase/serverless'
import { drizzle } from 'drizzle-orm/neon-serverless'
import ws from 'ws'
import * as schema from './schema'

// `neon-http` is stateless and rejects transactions. We use `neon-serverless`
// (WebSocket-backed) instead so `db.transaction(...)` works in /api/auth/callback
// and the curation save path. In serverless runtimes (Vercel Functions, etc.)
// Node has no built-in WebSocket, so we wire `ws` in.
if (typeof globalThis.WebSocket === 'undefined') {
  // The cast keeps the public WebSocket shape; ws is a runtime-compatible impl.
  neonConfig.webSocketConstructor = ws as unknown as typeof WebSocket
}

type DrizzleDb = ReturnType<typeof drizzle<typeof schema>>

let cachedDb: DrizzleDb | null = null

function build(): DrizzleDb {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL is not set. Configure it in .env.local or your hosting environment.'
    )
  }
  const pool = new Pool({ connectionString })
  return drizzle({ client: pool, schema })
}

/**
 * Lazy proxy: the connection is only opened on first use, not at module load.
 * This keeps `next build` page-data collection working without DATABASE_URL.
 */
export const db = new Proxy({} as DrizzleDb, {
  get(_target, prop, receiver) {
    if (!cachedDb) cachedDb = build()
    return Reflect.get(cachedDb as object, prop, receiver)
  },
}) as DrizzleDb

export { schema }
