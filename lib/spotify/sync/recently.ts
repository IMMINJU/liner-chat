import { db } from '@/db/client'
import { plays } from '@/db/schema'
import { spotifyFetch } from '../client'
import type {
  SpotifyPagedResponse,
  SpotifyPlayHistory,
} from '../types'
import { upsertArtistsFromTracks, upsertTracks } from '../upsert'

export type RecentlyResult = {
  inserted: number
  newTrackIds: Set<string>
}

export async function syncRecentlyPlayed(
  userId: string
): Promise<RecentlyResult> {
  const page = await spotifyFetch<SpotifyPagedResponse<SpotifyPlayHistory>>(
    userId,
    '/v1/me/player/recently-played?limit=50'
  )
  if (!page || page.items.length === 0) {
    return { inserted: 0, newTrackIds: new Set() }
  }

  const tracks = page.items.map((it) => it.track).filter(Boolean)
  await upsertArtistsFromTracks(tracks)
  const newTrackIds = await upsertTracks(tracks)

  const rows = page.items
    .filter((it) => it.track?.id)
    .map((it) => ({
      userId,
      trackId: it.track.id,
      playedAt: new Date(it.played_at),
    }))

  if (rows.length === 0) return { inserted: 0, newTrackIds }

  // ON CONFLICT against the (user_id, track_id, played_at) UNIQUE index.
  await db.insert(plays).values(rows).onConflictDoNothing()

  // drizzle-orm/neon-http doesn't expose rowCount reliably; we count rows we
  // attempted to insert. True "new" count = newTrackIds.size + some replays —
  // for UI summary the attempted count is good enough.
  return { inserted: rows.length, newTrackIds }
}
