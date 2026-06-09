import { env } from './env'

const BASE = 'https://ws.audioscrobbler.com/2.0/'

// Last.fm is a "nice to have" tag source; if it's slow we'd rather skip the
// hint and let Sonnet work without it than starve the function budget.
const LASTFM_TIMEOUT_MS = 5_000

// Tags for a given artist/track are effectively static, so cache them in
// module memory for the lifetime of the serverless instance. This is free
// latency back on the hot path that matters most here: walking a digging
// chain (same seed artist recurs) and re-curating the same seed. A cold
// start just re-fetches; correctness never depends on the cache. Bounded so
// a long-lived instance can't grow it without limit.
const TAG_CACHE_TTL_MS = 6 * 60 * 60 * 1000 // 6h
const TAG_CACHE_MAX = 500
const tagCache = new Map<string, { tags: LastfmTag[]; at: number }>()

function tagCacheGet(key: string): LastfmTag[] | null {
  const hit = tagCache.get(key)
  if (!hit) return null
  if (Date.now() - hit.at > TAG_CACHE_TTL_MS) {
    tagCache.delete(key)
    return null
  }
  return hit.tags
}

function tagCacheSet(key: string, tags: LastfmTag[]): void {
  // Crude FIFO bound: drop the oldest insertion when full. Map preserves
  // insertion order, so the first key is the oldest.
  if (tagCache.size >= TAG_CACHE_MAX) {
    const oldest = tagCache.keys().next().value
    if (oldest !== undefined) tagCache.delete(oldest)
  }
  tagCache.set(key, { tags, at: Date.now() })
}

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
  const key = `t:${artist.toLowerCase()} ${track.toLowerCase()}`
  const cached = tagCacheGet(key)
  if (cached) return cached
  const resp = await call({
    method: 'track.getTopTags',
    artist,
    track,
    autocorrect: '1',
  })
  const tags = toTagArray(resp)
  // Only cache a real hit. An empty result usually means a transient timeout
  // or Last.fm miss; caching it would poison the seed context for 6h, so we
  // let the next call retry instead.
  if (tags.length > 0) tagCacheSet(key, tags)
  return tags
}

export async function getArtistTopTags(artist: string): Promise<LastfmTag[]> {
  const key = `a:${artist.toLowerCase()}`
  const cached = tagCacheGet(key)
  if (cached) return cached
  const resp = await call({
    method: 'artist.getTopTags',
    artist,
    autocorrect: '1',
  })
  const tags = toTagArray(resp)
  // See getTrackTopTags: only cache a non-empty result.
  if (tags.length > 0) tagCacheSet(key, tags)
  return tags
}
