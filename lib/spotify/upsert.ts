import { inArray, sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { artists, tracks } from '@/db/schema'
import type { SpotifyTrack } from './types'

/**
 * Convert Spotify release_date (YYYY | YYYY-MM | YYYY-MM-DD) to a DB-safe
 * YYYY-MM-DD string. Missing parts default to 01.
 */
export function releaseDateToYmd(
  raw: string | undefined | null,
  precision?: 'year' | 'month' | 'day'
): string | null {
  if (!raw) return null
  const parts = raw.split('-')
  const year = parts[0]
  const month = parts[1] ?? '01'
  const day = parts[2] ?? '01'
  if (!/^\d{4}$/.test(year)) return null
  // precision unused in this MVP, but kept for future calibration.
  void precision
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
}

/**
 * Upsert artists referenced by a batch of tracks. Sets genres to [] if new;
 * existing rows leave genres/fetched_at untouched (filled later by enrich step).
 */
export async function upsertArtistsFromTracks(
  rows: SpotifyTrack[]
): Promise<Set<string>> {
  const seen = new Map<string, string>() // id → name
  for (const t of rows) {
    for (const a of t.artists) {
      if (!seen.has(a.id)) seen.set(a.id, a.name)
    }
  }
  if (seen.size === 0) return new Set()

  const values = [...seen.entries()].map(([id, name]) => ({
    id,
    name,
    spotifyGenres: [] as string[],
  }))

  await db
    .insert(artists)
    .values(values)
    .onConflictDoUpdate({
      target: artists.id,
      // keep name fresh in case Spotify updated it; never overwrite genres here.
      set: { name: sql`excluded.name` },
    })

  return new Set(seen.keys())
}

/**
 * Upsert tracks. Returns the set of trackIds that were newly inserted (for
 * downstream audio_features backfill).
 */
export async function upsertTracks(
  rows: SpotifyTrack[]
): Promise<Set<string>> {
  if (rows.length === 0) return new Set()

  // Deduplicate within this batch.
  const byId = new Map<string, SpotifyTrack>()
  for (const t of rows) byId.set(t.id, t)
  const unique = [...byId.values()]

  const values = unique.map((t) => ({
    id: t.id,
    name: t.name,
    artistId: t.artists[0]?.id ?? '',
    album: t.album?.name ?? null,
    albumReleaseDate: releaseDateToYmd(
      t.album?.release_date,
      t.album?.release_date_precision
    ),
    // Spotify returns 640/300/64. Index 1 is ~300px — the right size for
    // the seed hero (180-240px rendered) and the recent-diggings thumbs
    // (40-48px) without serving a giant 640.
    albumCoverUrl: t.album?.images?.[1]?.url ?? t.album?.images?.[0]?.url ?? null,
    durationMs: t.duration_ms,
    spotifyUrl: t.external_urls?.spotify ?? null,
    previewUrl: t.preview_url ?? null,
  }))

  // Track which ids existed BEFORE this insert, so we can tell which are new.
  const ids = values.map((v) => v.id)
  const existing =
    ids.length === 0
      ? []
      : await db
          .select({ id: tracks.id })
          .from(tracks)
          .where(inArray(tracks.id, ids))
  const existingIds = new Set(existing.map((r) => r.id))

  await db
    .insert(tracks)
    .values(values)
    .onConflictDoUpdate({
      target: tracks.id,
      set: {
        name: sql`excluded.name`,
        album: sql`excluded.album`,
        albumReleaseDate: sql`excluded.album_release_date`,
        albumCoverUrl: sql`excluded.album_cover_url`,
        durationMs: sql`excluded.duration_ms`,
        spotifyUrl: sql`excluded.spotify_url`,
        previewUrl: sql`excluded.preview_url`,
      },
    })

  const newIds = new Set<string>()
  for (const v of values) if (!existingIds.has(v.id)) newIds.add(v.id)
  return newIds
}
