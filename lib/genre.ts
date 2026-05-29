import { eq, inArray } from 'drizzle-orm'
import { db } from '@/db/client'
import { artists, audioFeatures, genreSignals, tracks } from '@/db/schema'
import { GENRE_KEYS, type GenreKey, tagMatchesGenre } from './genre-dictionary'
import { getArtistTopTags, getTrackTopTags, type LastfmTag } from './lastfm'

export type GenreScores = Record<GenreKey, number>

export type RawTagSources = {
  spotify_artist: string[]
  lastfm_track: string[]
  lastfm_artist: string[]
}

function emptyScores(): GenreScores {
  return Object.fromEntries(GENRE_KEYS.map((k) => [k, 0])) as GenreScores
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n))
}

/**
 * Pure scoring: given the three tag sources, compute the final per-genre scores.
 * Weights match docs/genre-classification.md.
 */
export function computeScores(sources: {
  spotifyArtistGenres: string[]
  lastfmTrackTags: LastfmTag[]   // assumed already sorted desc by count
  lastfmArtistTags: LastfmTag[]
}): GenreScores {
  const scores = emptyScores()
  const topNTrack = sources.lastfmTrackTags.slice(0, 5)
  const restTrack = sources.lastfmTrackTags.slice(5)
  const topNArtist = sources.lastfmArtistTags.slice(0, 5)
  const restArtist = sources.lastfmArtistTags.slice(5)

  for (const g of GENRE_KEYS) {
    let s = 0
    if (sources.spotifyArtistGenres.some((t) => tagMatchesGenre(t, g))) {
      s += 0.6
    }
    if (topNTrack.some((t) => tagMatchesGenre(t.name, g))) {
      s += 0.4
    } else if (restTrack.some((t) => tagMatchesGenre(t.name, g))) {
      s += 0.2
    }
    if (topNArtist.some((t) => tagMatchesGenre(t.name, g))) {
      s += 0.3
    } else if (restArtist.some((t) => tagMatchesGenre(t.name, g))) {
      s += 0.1
    }
    scores[g] = clamp01(s)
  }
  return scores
}

type TrackContext = {
  trackId: string
  trackName: string
  artistId: string
  artistName: string
  spotifyArtistGenres: string[]
}

/**
 * Load the context needed to score a batch of tracks. Joins tracks ↔ artists.
 * Returns one row per track.
 */
async function loadTrackContexts(
  trackIds: string[]
): Promise<TrackContext[]> {
  if (trackIds.length === 0) return []
  const rows = await db
    .select({
      trackId: tracks.id,
      trackName: tracks.name,
      artistId: tracks.artistId,
      artistName: artists.name,
      spotifyGenres: artists.spotifyGenres,
    })
    .from(tracks)
    .innerJoin(artists, eq(tracks.artistId, artists.id))
    .where(inArray(tracks.id, trackIds))
  return rows.map((r) => ({
    trackId: r.trackId,
    trackName: r.trackName,
    artistId: r.artistId,
    artistName: r.artistName,
    spotifyArtistGenres: r.spotifyGenres ?? [],
  }))
}

type ArtistTagCache = Map<string, LastfmTag[]> // artistId → tags

/**
 * Compute & persist genre_signals for the given tracks.
 * - Skips tracks that already have signals (idempotent).
 * - Caches Last.fm artist tags within this call to amortize repeats.
 *
 * Returns count of tracks computed + count of tracks skipped (already had).
 */
export async function computeAndSaveGenreSignals(
  trackIds: string[]
): Promise<{ computed: number; skipped: number }> {
  if (trackIds.length === 0) return { computed: 0, skipped: 0 }

  // Filter out tracks that already have signals
  const existing = await db
    .select({ trackId: genreSignals.trackId })
    .from(genreSignals)
    .where(inArray(genreSignals.trackId, trackIds))
  const haveIds = new Set(existing.map((r) => r.trackId))
  const need = trackIds.filter((id) => !haveIds.has(id))

  if (need.length === 0) return { computed: 0, skipped: trackIds.length }

  const ctxs = await loadTrackContexts(need)
  const artistTagCache: ArtistTagCache = new Map()

  let computed = 0
  for (const ctx of ctxs) {
    let artistTags = artistTagCache.get(ctx.artistId)
    if (!artistTags) {
      artistTags = await getArtistTopTags(ctx.artistName)
      artistTagCache.set(ctx.artistId, artistTags)
    }
    const trackTags = await getTrackTopTags(ctx.artistName, ctx.trackName)

    const scores = computeScores({
      spotifyArtistGenres: ctx.spotifyArtistGenres,
      lastfmTrackTags: trackTags,
      lastfmArtistTags: artistTags,
    })

    const raw: RawTagSources = {
      spotify_artist: ctx.spotifyArtistGenres,
      lastfm_track: trackTags.map((t) => t.name),
      lastfm_artist: artistTags.map((t) => t.name),
    }

    await db
      .insert(genreSignals)
      .values({
        trackId: ctx.trackId,
        scores,
        rawTags: raw,
        computedAt: new Date(),
      })
      .onConflictDoNothing()
    computed++
  }

  void audioFeatures // reserved for future audio-driven adjustments

  return { computed, skipped: trackIds.length - need.length }
}
