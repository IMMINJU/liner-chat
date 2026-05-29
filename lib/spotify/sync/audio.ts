import { inArray, isNull, notInArray } from 'drizzle-orm'
import { db } from '@/db/client'
import { audioFeatures, tracks } from '@/db/schema'
import { spotifyFetch } from '../client'
import type { SpotifyAudioFeatures } from '../types'

export type AudioResult = {
  enriched: number
  missing: number
}

function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/**
 * Backfill audio_features for tracks in `restrictTo` that don't have a row yet.
 * Spotify may return null for some ids (unsupported tracks) — those are
 * recorded as "missing" and not retried within this run.
 */
export async function enrichAudioFeatures(
  userId: string,
  restrictTo: Set<string>
): Promise<AudioResult> {
  if (restrictTo.size === 0) return { enriched: 0, missing: 0 }

  // Find which restrictTo ids are NOT yet in audio_features.
  const target = [...restrictTo]
  const existing = await db
    .select({ id: audioFeatures.trackId })
    .from(audioFeatures)
    .where(inArray(audioFeatures.trackId, target))
  const have = new Set(existing.map((r) => r.id))
  const need = target.filter((id) => !have.has(id))
  void tracks
  void isNull
  void notInArray

  if (need.length === 0) return { enriched: 0, missing: 0 }

  let enriched = 0
  let missing = 0
  for (const batch of chunked(need, 100)) {
    const resp = await spotifyFetch<{
      audio_features: (SpotifyAudioFeatures | null)[]
    }>(userId, `/v1/audio-features?ids=${batch.join(',')}`)
    if (!resp) continue

    const rows: {
      trackId: string
      energy: number | null
      valence: number | null
      tempo: number | null
      acousticness: number | null
      danceability: number | null
      instrumentalness: number | null
      speechiness: number | null
      liveness: number | null
      key: number | null
      mode: number | null
      timeSignature: number | null
      fetchedAt: Date
    }[] = []
    for (const f of resp.audio_features) {
      if (!f) {
        missing++
        continue
      }
      rows.push({
        trackId: f.id,
        energy: f.energy,
        valence: f.valence,
        tempo: f.tempo,
        acousticness: f.acousticness,
        danceability: f.danceability,
        instrumentalness: f.instrumentalness,
        speechiness: f.speechiness,
        liveness: f.liveness,
        // Spotify uses -1 to mean "undetected"; normalize to null.
        key: f.key === null || f.key === -1 ? null : f.key,
        mode: f.mode === null ? null : f.mode,
        timeSignature: f.time_signature ?? null,
        fetchedAt: new Date(),
      })
    }

    if (rows.length > 0) {
      await db.insert(audioFeatures).values(rows).onConflictDoNothing()
      enriched += rows.length
    }
  }

  return { enriched, missing }
}
