import { env } from './env'

const BASE = 'https://ws.audioscrobbler.com/2.0/'

// Last.fm is a "nice to have" tag source; if it's slow we'd rather skip the
// hint and let Sonnet work without it than starve the function budget.
const LASTFM_TIMEOUT_MS = 5_000

export type LastfmTag = { name: string; count: number }

type LastfmTopTagsResponse = {
  toptags?: {
    tag?: { name: string; count: number }[] | { name: string; count: number }
  }
  error?: number
  message?: string
}

async function call(params: Record<string, string>): Promise<LastfmTopTagsResponse | null> {
  const qs = new URLSearchParams({
    ...params,
    api_key: env.lastfmApiKey(),
    format: 'json',
  })
  try {
    const res = await fetch(`${BASE}?${qs.toString()}`, {
      headers: { 'User-Agent': 'liner-chat/0.1' },
      signal: AbortSignal.timeout(LASTFM_TIMEOUT_MS),
    })
    if (!res.ok) return null
    return (await res.json()) as LastfmTopTagsResponse
  } catch {
    // Network/timeout/parse — treat as "no tags" so the curator keeps going.
    return null
  }
}

function toTagArray(resp: LastfmTopTagsResponse | null): LastfmTag[] {
  if (!resp || resp.error) return []
  const tag = resp.toptags?.tag
  if (!tag) return []
  const arr = Array.isArray(tag) ? tag : [tag]
  return arr.map((t) => ({ name: String(t.name), count: Number(t.count) || 0 }))
}

export async function getTrackTopTags(
  artist: string,
  track: string
): Promise<LastfmTag[]> {
  const resp = await call({
    method: 'track.getTopTags',
    artist,
    track,
    autocorrect: '1',
  })
  return toTagArray(resp)
}

export async function getArtistTopTags(artist: string): Promise<LastfmTag[]> {
  const resp = await call({
    method: 'artist.getTopTags',
    artist,
    autocorrect: '1',
  })
  return toTagArray(resp)
}
