import { spotifyFetch } from './client'
import type {
  SpotifyArtistFull,
  SpotifyAudioFeatures,
  SpotifyPagedResponse,
  SpotifyTrack,
} from './types'
import { releaseDateToYmd, upsertArtistsFromTracks, upsertTracks } from './upsert'

/**
 * Catalog-level Spotify helpers shared by the kinship curator.
 * - Search a single track by free-text or artist/track pair.
 * - Get a single track (popularity + audio features).
 * - Verify a (artist, track, album, year) tuple against Spotify search results,
 *   returning the canonical Spotify track if it really exists.
 *
 * All of these auto-upsert the track/artist into our DB so downstream code can
 * reference DB rows.
 */

export type SpotifyTrackWithPopularity = SpotifyTrack & { popularity: number }

function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')      // strip combining marks
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
  userId: string,
  query: string
): Promise<SpotifyTrackWithPopularity | null> {
  const q = encodeURIComponent(query)
  const resp = await spotifyFetch<{
    tracks: SpotifyPagedResponse<SpotifyTrackWithPopularity>
  }>(userId, `/v1/search?q=${q}&type=track&limit=5`)
  if (!resp) return null
  const first = resp.tracks.items[0]
  if (!first) return null

  await upsertArtistsFromTracks([first])
  await upsertTracks([first])
  return first
}

/** Get a single track including popularity. */
export async function getTrack(
  userId: string,
  trackId: string
): Promise<SpotifyTrackWithPopularity | null> {
  const resp = await spotifyFetch<SpotifyTrackWithPopularity>(
    userId,
    `/v1/tracks/${trackId}`
  )
  return resp ?? null
}

/** Get audio features for a single track. */
export async function getAudioFeaturesOne(
  userId: string,
  trackId: string
): Promise<SpotifyAudioFeatures | null> {
  return spotifyFetch<SpotifyAudioFeatures>(
    userId,
    `/v1/audio-features/${trackId}`,
    { allow404: true }
  )
}

/** Get popularities for many tracks in batches of 50. Returns map id→popularity. */
export async function getTrackPopularities(
  userId: string,
  trackIds: string[]
): Promise<Map<string, number>> {
  // Fan the 50-track batches out in parallel. Sequentially this was up to
  // 40s for 200 tracks (4 batches × ~10s each) which alone could blow the
  // 60s function budget; in parallel it's bounded by the slowest batch.
  const batches: string[][] = []
  for (let i = 0; i < trackIds.length; i += 50) {
    batches.push(trackIds.slice(i, i + 50))
  }
  const responses = await Promise.all(
    batches.map((batch) =>
      spotifyFetch<{
        tracks: (SpotifyTrackWithPopularity | null)[]
      }>(userId, `/v1/tracks?ids=${batch.join(',')}`).catch(() => null)
    )
  )
  const out = new Map<string, number>()
  for (const resp of responses) {
    if (!resp) continue
    for (const t of resp.tracks) {
      if (t) out.set(t.id, t.popularity)
    }
  }
  return out
}

/** Get a single artist's profile (genres etc). */
export async function getArtist(
  userId: string,
  artistId: string
): Promise<SpotifyArtistFull | null> {
  return spotifyFetch<SpotifyArtistFull>(userId, `/v1/artists/${artistId}`)
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
  userId: string,
  target: VerifyTarget
): Promise<VerifiedTrack | null> {
  const q = `track:"${target.track}" artist:"${target.artist}"`
  const resp = await spotifyFetch<{
    tracks: SpotifyPagedResponse<SpotifyTrackWithPopularity>
  }>(userId, `/v1/search?q=${encodeURIComponent(q)}&type=track&limit=10`)
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

    // Match. Upsert and return.
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
    }
  }

  return null
}

/** Convert Spotify's pitch class integer to a human-readable name. */
const PITCH_CLASS = [
  'C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B',
]
export function pitchClassName(key: number | null | undefined): string | null {
  if (key === null || key === undefined || key < 0 || key > 11) return null
  return PITCH_CLASS[key]
}

/** Reserved for future calibration of release date precision. */
export { releaseDateToYmd }
