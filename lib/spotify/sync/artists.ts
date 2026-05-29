import { inArray, sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { artists } from '@/db/schema'
import { spotifyFetch } from '../client'
import type { SpotifyArtistFull } from '../types'

const STALE_HOURS = 24

export type ArtistsResult = {
  enriched: number
}

function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/**
 * For artists referenced by recently-touched tracks, fetch genres if missing or
 * stale (>24h). Pass `restrictTo` to limit to artists from this sync run.
 */
export async function enrichArtistGenres(
  userId: string,
  restrictTo?: Set<string>
): Promise<ArtistsResult> {
  // Find stale or unfetched artists; optionally narrow to a subset.
  const rows = await db
    .select({ id: artists.id, fetchedAt: artists.fetchedAt })
    .from(artists)

  const staleCutoff = new Date(Date.now() - STALE_HOURS * 60 * 60 * 1000)
  const ids = rows
    .filter((r) => !r.fetchedAt || r.fetchedAt < staleCutoff)
    .map((r) => r.id)
    .filter((id) => (restrictTo ? restrictTo.has(id) : true))

  if (ids.length === 0) return { enriched: 0 }

  let enriched = 0
  for (const batch of chunked(ids, 50)) {
    const resp = await spotifyFetch<{ artists: SpotifyArtistFull[] }>(
      userId,
      `/v1/artists?ids=${batch.join(',')}`
    )
    if (!resp) continue

    // Update each artist's genres + fetched_at.
    for (const a of resp.artists) {
      if (!a) continue
      await db
        .update(artists)
        .set({
          name: a.name,
          spotifyGenres: a.genres ?? [],
          fetchedAt: new Date(),
        })
        .where(inArray(artists.id, [a.id]))
      enriched++
    }
    void sql // silence unused import lint on slow paths
  }

  return { enriched }
}
