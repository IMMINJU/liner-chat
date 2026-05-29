import { db } from '@/db/client'
import { topTracks } from '@/db/schema'
import { spotifyFetch } from '../client'
import type {
  SpotifyPagedResponse,
  SpotifyTrack,
} from '../types'
import { upsertArtistsFromTracks, upsertTracks } from '../upsert'

const TIME_RANGES = ['short_term', 'medium_term', 'long_term'] as const
type TimeRange = (typeof TIME_RANGES)[number]

export type TopResult = {
  short_term: number
  medium_term: number
  long_term: number
  newTrackIds: Set<string>
}

export async function syncTopTracks(userId: string): Promise<TopResult> {
  const snapshotAt = new Date()
  const counts: Record<TimeRange, number> = {
    short_term: 0,
    medium_term: 0,
    long_term: 0,
  }
  const newTrackIds = new Set<string>()

  for (const range of TIME_RANGES) {
    const page = await spotifyFetch<SpotifyPagedResponse<SpotifyTrack>>(
      userId,
      `/v1/me/top/tracks?time_range=${range}&limit=50`
    )
    if (!page || page.items.length === 0) continue

    await upsertArtistsFromTracks(page.items)
    const ids = await upsertTracks(page.items)
    for (const id of ids) newTrackIds.add(id)

    const rows = page.items.map((t, i) => ({
      userId,
      trackId: t.id,
      timeRange: range,
      rank: i + 1,
      snapshotAt,
    }))
    if (rows.length > 0) {
      await db.insert(topTracks).values(rows).onConflictDoNothing()
      counts[range] = rows.length
    }
  }

  return { ...counts, newTrackIds }
}
