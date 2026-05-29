import { enrichArtistGenres } from './artists'
import { syncLikedTracks } from './liked'
import { syncRecentlyPlayed } from './recently'
import { syncTopTracks } from './top'

/*
 * The original spec had five sync stages; the fifth was
 * `enrichAudioFeatures`, which fanned out across `/v1/audio-features`. As of
 * 2024-11-27 Spotify made that endpoint (and audio-analysis / recommendations
 * / related-artists) private to *new* apps. Our app was created after the
 * cut-off, so calls return 403 and the stage is effectively dead. We keep
 * lib/spotify/sync/audio.ts on disk so a future restoration is just a re-
 * import + a single line added back here.
 *
 * Docs: docs/sync.md (정책 변경 단락), docs/data-model.md (audio_features
 * 비활성), docs/kinship-prompt.md (LLM에 토널 메타데이터 없음 명시).
 */

export type SyncSuccess = {
  ok: true
  durationMs: number
  liked: { added: number; total: number }
  top: { short_term: number; medium_term: number; long_term: number }
  recently: { inserted: number }
  artists: { enriched: number }
}

export type SyncFailure = {
  ok: false
  durationMs: number
  partial: Partial<{
    liked: { added: number; total: number }
    top: { short_term: number; medium_term: number; long_term: number }
    recently: { inserted: number }
    artists: { enriched: number }
  }>
  failedStages: string[]
  errors: { stage: string; message: string }[]
}

export type SyncResult = SyncSuccess | SyncFailure

type StageName = 'liked' | 'top' | 'recently' | 'artists'

async function safe<T>(
  stage: StageName,
  fn: () => Promise<T>,
  failed: string[],
  errors: { stage: string; message: string }[]
): Promise<T | null> {
  try {
    return await fn()
  } catch (err) {
    failed.push(stage)
    errors.push({
      stage,
      message: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

/**
 * Orchestrates the four active sync stages. Each stage runs independently;
 * a failure in one only marks that stage as failed and does not abort the
 * others. Stage order matters: artist enrichment depends on the upstream
 * stages having upserted track rows first.
 */
export async function runSync(userId: string): Promise<SyncResult> {
  const start = Date.now()
  const failed: string[] = []
  const errors: { stage: string; message: string }[] = []

  const liked = await safe('liked', () => syncLikedTracks(userId), failed, errors)
  const top = await safe('top', () => syncTopTracks(userId), failed, errors)
  const recently = await safe(
    'recently',
    () => syncRecentlyPlayed(userId),
    failed,
    errors
  )
  const artists = await safe(
    'artists',
    () => enrichArtistGenres(userId),
    failed,
    errors
  )

  const durationMs = Date.now() - start

  if (failed.length === 0 && liked && top && recently && artists) {
    return {
      ok: true,
      durationMs,
      liked: { added: liked.added, total: liked.total },
      top: {
        short_term: top.short_term,
        medium_term: top.medium_term,
        long_term: top.long_term,
      },
      recently: { inserted: recently.inserted },
      artists: { enriched: artists.enriched },
    }
  }

  return {
    ok: false,
    durationMs,
    partial: {
      ...(liked ? { liked: { added: liked.added, total: liked.total } } : {}),
      ...(top
        ? {
            top: {
              short_term: top.short_term,
              medium_term: top.medium_term,
              long_term: top.long_term,
            },
          }
        : {}),
      ...(recently ? { recently: { inserted: recently.inserted } } : {}),
      ...(artists ? { artists: { enriched: artists.enriched } } : {}),
    },
    failedStages: failed,
    errors,
  }
}
