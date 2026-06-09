import { spotifyFetch } from './client'
import type {
  SpotifyArtistFull,
  SpotifyPagedResponse,
  SpotifyTrack,
} from './types'
import { upsertArtistsFromTracks, upsertTracks } from './upsert'

/**
 * Catalog-level Spotify helpers shared by the kinship curator.
 * - Search a single track by free-text or artist/track pair.
 * - Get a single track.
 * - Verify a (artist, track, album, year) tuple against Spotify search results,
 *   returning the canonical Spotify track if it really exists.
 *
 * All calls use the app-level (Client Credentials) token — these are public
 * catalog endpoints, so no user login is involved. They auto-upsert the
 * track/artist into our DB so downstream code can reference DB rows.
 */

export type SpotifyTrackWithPopularity = SpotifyTrack & { popularity: number }

function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip combining marks
    .replace(/^(the|a) /i, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** "1968-11-22" | "1968-11" | "1968" → 1968 */
function yearOf(date: string | undefined | null): number | null {
  if (!date) return null
  const m = /^(\d{4})/.exec(date)
  return m ? Number(m[1]) : null
}

/** Search for a single track by free-form query. Returns the first hit, or null. */
export async function searchOneTrack(
  query: string
): Promise<SpotifyTrackWithPopularity | null> {
  const q = encodeURIComponent(query)
  const resp = await spotifyFetch<{
    tracks: SpotifyPagedResponse<SpotifyTrackWithPopularity>
  }>(`/v1/search?q=${q}&type=track&limit=5`)
  if (!resp) return null
  const first = resp.tracks.items[0]
  if (!first) return null

  await upsertArtistsFromTracks([first])
  await upsertTracks([first])
  return first
}

/** Get a single track including popularity. */
export async function getTrack(
  trackId: string
): Promise<SpotifyTrackWithPopularity | null> {
  const resp = await spotifyFetch<SpotifyTrackWithPopularity>(
    `/v1/tracks/${trackId}`
  )
  return resp ?? null
}

/** Get a single artist's profile (genres etc). */
export async function getArtist(
  artistId: string
): Promise<SpotifyArtistFull | null> {
  return spotifyFetch<SpotifyArtistFull>(`/v1/artists/${artistId}`)
}

export type VerifyTarget = {
  artist: string
  track: string
  album: string
  year: number
}

export type VerifiedTrack = {
  id: string
  name: string
  artistId: string
  artistName: string
  album: string
  year: number | null
  spotifyUrl: string | null
  previewUrl: string | null
  coverUrl: string | null
}

/**
 * Verify an LLM-proposed (artist, track, album, year) tuple actually exists on
 * Spotify. Match rule: artist name exact (after normalize), album name partial
 * contains (after normalize), release year within ±2.
 *
 * Returns the canonical Spotify track + upserts artist/track rows. Null if no
 * candidate matches (caller drops that recommendation silently).
 */
export async function verifyTrack(
  target: VerifyTarget
): Promise<VerifiedTrack | null> {
  const q = `track:"${target.track}" artist:"${target.artist}"`
  const resp = await spotifyFetch<{
    tracks: SpotifyPagedResponse<SpotifyTrackWithPopularity>
  }>(`/v1/search?q=${encodeURIComponent(q)}&type=track&limit=10`)
  if (!resp) return null

  const wantArtist = normalizeForMatch(target.artist)
  const wantAlbum = normalizeForMatch(target.album)

  for (const cand of resp.tracks.items) {
    const candArtist = normalizeForMatch(cand.artists[0]?.name ?? '')
    if (candArtist !== wantArtist) continue

    const candAlbum = normalizeForMatch(cand.album?.name ?? '')
    // partial contains in either direction (LLM may give shorter or longer)
    if (
      wantAlbum &&
      !candAlbum.includes(wantAlbum) &&
      !wantAlbum.includes(candAlbum)
    ) {
      continue
    }

    const candYear = yearOf(cand.album?.release_date)
    if (candYear !== null && Math.abs(candYear - target.year) > 2) continue

    // Match. Upsert artist BEFORE track — tracks.artist_id has a FK to
    // artists.id, so these two writes must stay ordered (parallelizing them
    // risks the track insert hitting the FK before the artist row commits).
    await upsertArtistsFromTracks([cand])
    await upsertTracks([cand])

    return {
      id: cand.id,
      name: cand.name,
      artistId: cand.artists[0]?.id ?? '',
      artistName: cand.artists[0]?.name ?? '',
      album: cand.album?.name ?? '',
      year: candYear,
      spotifyUrl: cand.external_urls?.spotify ?? null,
      previewUrl: cand.preview_url ?? null,
      // Same selection as upsert.ts: index 1 is ~300px (640/300/64), the right
      // size for small recommendation thumbnails without serving a giant 640.
      coverUrl:
        cand.album?.images?.[1]?.url ?? cand.album?.images?.[0]?.url ?? null,
    }
  }

  return null
}
