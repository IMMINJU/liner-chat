import { desc, eq, inArray, sql } from 'drizzle-orm'
import { db } from '@/db/client'
import {
  artists,
  genreSignals,
  likedTracks,
  plays,
  topTracks,
  tracks,
} from '@/db/schema'
import { computeAndSaveGenreSignals } from './genre'
import type { GenreKey } from './genre-dictionary'

export type TrackCard = {
  id: string
  name: string
  artist: string
  album: string | null
  year: number | null
  spotifyUrl: string | null
  previewUrl: string | null
}

const LAZY_BUDGET = 200 // max tracks scored in one library_filter call

/**
 * Resolve the set of track ids the user "has" in their library.
 * Liked ∪ top (any time_range) ∪ plays.
 */
async function userLibraryTrackIds(userId: string): Promise<string[]> {
  const [liked, top, played] = await Promise.all([
    db
      .select({ id: likedTracks.trackId })
      .from(likedTracks)
      .where(eq(likedTracks.userId, userId)),
    db
      .select({ id: topTracks.trackId })
      .from(topTracks)
      .where(eq(topTracks.userId, userId)),
    db
      .select({ id: plays.trackId })
      .from(plays)
      .where(eq(plays.userId, userId)),
  ])
  const set = new Set<string>()
  for (const r of liked) set.add(r.id)
  for (const r of top) set.add(r.id)
  for (const r of played) set.add(r.id)
  return [...set]
}

export type LibraryFilterResult = {
  tracks: TrackCard[]
  count: number
  computed: number
  skipped: number
}

/**
 * Mode 1 query: return the user's library tracks that score >= minScore for
 * any of the given genres. Lazily computes genre_signals for up to LAZY_BUDGET
 * tracks that don't have signals yet.
 */
export async function listLibraryByGenre(args: {
  userId: string
  genres: GenreKey[]
  minScore: number
  limit: number
}): Promise<LibraryFilterResult> {
  const libIds = await userLibraryTrackIds(args.userId)
  if (libIds.length === 0) {
    return { tracks: [], count: 0, computed: 0, skipped: 0 }
  }

  // Find which library tracks DON'T have signals yet.
  const haveSignals = await db
    .select({ id: genreSignals.trackId })
    .from(genreSignals)
    .where(inArray(genreSignals.trackId, libIds))
  const haveSet = new Set(haveSignals.map((r) => r.id))
  const missing = libIds.filter((id) => !haveSet.has(id))

  const toCompute = missing.slice(0, LAZY_BUDGET)
  const skipped = missing.length - toCompute.length

  const { computed } = await computeAndSaveGenreSignals(toCompute)

  // Now query: for each genre, score >= minScore. Use SQL JSONB path.
  // Build OR clauses dynamically.
  const sumExpr = sql<number>`(${sql.join(
    args.genres.map(
      (g) =>
        sql`COALESCE((${genreSignals.scores} ->> ${g})::float, 0)`
    ),
    sql` + `
  )})`

  const orClauses = sql.join(
    args.genres.map(
      (g) =>
        sql`COALESCE((${genreSignals.scores} ->> ${g})::float, 0) >= ${args.minScore}`
    ),
    sql` OR `
  )

  const rows = await db
    .select({
      id: tracks.id,
      name: tracks.name,
      artist: artists.name,
      album: tracks.album,
      release: tracks.albumReleaseDate,
      spotifyUrl: tracks.spotifyUrl,
      previewUrl: tracks.previewUrl,
      score: sumExpr,
      likedAt: likedTracks.likedAt,
    })
    .from(genreSignals)
    .innerJoin(tracks, eq(genreSignals.trackId, tracks.id))
    .innerJoin(artists, eq(tracks.artistId, artists.id))
    .leftJoin(
      likedTracks,
      sql`${likedTracks.userId} = ${args.userId} AND ${likedTracks.trackId} = ${tracks.id}`
    )
    .where(
      sql`${inArray(genreSignals.trackId, libIds)} AND (${orClauses})`
    )
    .orderBy(desc(sumExpr), desc(likedTracks.likedAt))
    .limit(args.limit)

  const totalRows = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(genreSignals)
    .where(sql`${inArray(genreSignals.trackId, libIds)} AND (${orClauses})`)

  const count = totalRows[0]?.c ?? 0

  const cards: TrackCard[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    artist: r.artist,
    album: r.album,
    year: r.release ? Number(r.release.slice(0, 4)) : null,
    spotifyUrl: r.spotifyUrl,
    previewUrl: r.previewUrl,
  }))

  return { tracks: cards, count, computed, skipped }
}
