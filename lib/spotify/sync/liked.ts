import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { likedTracks } from '@/db/schema'
import { spotifyFetch } from '../client'
import type {
  SpotifyPagedResponse,
  SpotifySavedTrack,
} from '../types'
import { upsertArtistsFromTracks, upsertTracks } from '../upsert'

export type LikedResult = {
  added: number
  total: number
  newTrackIds: Set<string>
}

const PAGE_LIMIT = 50

export async function syncLikedTracks(userId: string): Promise<LikedResult> {
  const allNewTrackIds = new Set<string>()
  let added = 0
  let total = 0
  let offset = 0

  while (true) {
    const page = await spotifyFetch<SpotifyPagedResponse<SpotifySavedTrack>>(
      userId,
      `/v1/me/tracks?limit=${PAGE_LIMIT}&offset=${offset}`
    )
    if (!page) break
    total = page.total

    const tracks = page.items.map((it) => it.track).filter(Boolean)
    if (tracks.length > 0) {
      await upsertArtistsFromTracks(tracks)
      const newIds = await upsertTracks(tracks)
      for (const id of newIds) allNewTrackIds.add(id)

      const rows = page.items
        .filter((it) => it.track?.id)
        .map((it) => ({
          userId,
          trackId: it.track.id,
          likedAt: new Date(it.added_at),
        }))

      if (rows.length > 0) {
        const result = await db
          .insert(likedTracks)
          .values(rows)
          .onConflictDoUpdate({
            target: [likedTracks.userId, likedTracks.trackId],
            set: { likedAt: sql`excluded.liked_at` },
          })
        // drizzle-orm/neon-http doesn't return rowCount for upsert; we just
        // approximate added by counting input rows.
        added += rows.length
        void result
      }
    }

    if (!page.next) break
    offset += page.items.length || PAGE_LIMIT
    if (page.items.length === 0) break
  }

  return { added, total, newTrackIds: allNewTrackIds }
}
