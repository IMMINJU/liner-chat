import {
  SpotifyAuthError,
  SpotifyClientError,
  SpotifyRateLimitError,
  SpotifyServerError,
} from './errors'
import { getAppAccessToken, invalidateAppToken } from './tokens'

const API_BASE = 'https://api.spotify.com'

/*
 * Vercel Hobby caps function wall-clock at 60s. A single Spotify request
 * has no business taking more than a few seconds, so we cap every request
 * with an AbortSignal and clamp the 429 backoff. Without this, a single
 * slow upstream call (or a 30s Retry-After from Spotify) eats the whole
 * function budget and the platform terminates the request with a 504
 * before our own catch can return a typed error.
 */
const PER_REQUEST_TIMEOUT_MS = 10_000
const RATE_LIMIT_CAP_SECONDS = 5

export type SpotifyFetchInit = RequestInit & {
  /** If true, treat 404 as success and return null body. */
  allow404?: boolean
}

/**
 * Authenticated fetch against the Spotify Web API using an app-level
 * (Client Credentials) token. Login-less: there is no per-user token, so this
 * only reaches public catalog endpoints (search / tracks / artists).
 *
 * - Mints/refreshes the app token transparently.
 * - On a 401, drops the cached token and retries once.
 * - Honors Retry-After on 429 (single retry).
 * - Throws typed errors for callers to differentiate.
 *
 * Returns the parsed JSON body, or `null` for 204 / allow404.
 */
export async function spotifyFetch<T = unknown>(
  path: string,
  init: SpotifyFetchInit = {}
): Promise<T | null> {
  const url = path.startsWith('http') ? path : `${API_BASE}${path}`

  const doRequest = async (token: string): Promise<Response> => {
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${token}`)
    if (init.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json')
    }
    // Hard cap per-request wall-clock so a single slow Spotify call can't
    // burn the whole function budget. AbortSignal.timeout is broadly
    // supported in the Vercel Node runtime.
    const signal = init.signal ?? AbortSignal.timeout(PER_REQUEST_TIMEOUT_MS)
    return fetch(url, { ...init, headers, signal })
  }

  let accessToken = await getAppAccessToken()
  let res = await doRequest(accessToken)

  if (res.status === 401) {
    // App token unexpectedly rejected — drop the cache and mint a fresh one.
    invalidateAppToken()
    accessToken = await getAppAccessToken()
    res = await doRequest(accessToken)
    if (res.status === 401) {
      throw new SpotifyAuthError('App token still invalid after refresh')
    }
  }

  if (res.status === 429) {
    const advertised = Number(res.headers.get('Retry-After') ?? '1')
    // Spotify occasionally returns 30+ second Retry-After values. Respecting
    // them serially blows the function budget, so cap the wait. If the next
    // attempt still hits 429, the caller decides how to handle a partial
    // failure (usually: drop the one verifyTrack call, keep the rest).
    const retryAfter = Math.min(
      Number.isFinite(advertised) ? advertised : 1,
      RATE_LIMIT_CAP_SECONDS
    )
    await new Promise((r) => setTimeout(r, retryAfter * 1000))
    res = await doRequest(accessToken)
    if (res.status === 429) {
      throw new SpotifyRateLimitError(advertised)
    }
  }

  if (res.status === 404 && init.allow404) return null
  if (res.status === 204) return null

  if (res.status >= 500) {
    throw new SpotifyServerError(res.status, await res.text())
  }
  if (!res.ok) {
    throw new SpotifyClientError(res.status, await res.text())
  }

  return (await res.json()) as T
}
