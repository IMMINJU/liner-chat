import { env } from '../env'
import { SpotifyAuthError } from './errors'

const TOKEN_URL = 'https://accounts.spotify.com/api/token'

/*
 * Login-less mode: every Spotify call is a *public catalog* read (search,
 * tracks, artists), which the Client Credentials flow can serve. There is no
 * user, no refresh_token, and nothing to persist — the app authenticates as
 * itself with client_id/client_secret and gets a short-lived bearer token.
 *
 * We cache that token in module memory and re-request it when it's within the
 * safety margin of expiry. A serverless cold start just re-mints one; it's a
 * single extra round-trip, not a correctness issue.
 */

type ClientCredentialsResponse = {
  access_token: string
  token_type: 'Bearer'
  expires_in: number
}

function basicAuthHeader(): string {
  const id = env.spotify.clientId()
  const secret = env.spotify.clientSecret()
  return 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64')
}

// 60s safety margin so an in-flight request can't be issued with a token that
// expires mid-flight.
const EXPIRY_MARGIN_MS = 60_000

let cached: { token: string; expiresAt: number } | null = null
// Collapse concurrent first-callers onto a single token request.
let inflight: Promise<string> | null = null

async function requestAppToken(): Promise<string> {
  const body = new URLSearchParams({ grant_type: 'client_credentials' })

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
    signal: AbortSignal.timeout(10_000),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new SpotifyAuthError(
      `Client credentials token request failed: ${res.status} ${text}`
    )
  }
  const json = (await res.json()) as ClientCredentialsResponse
  cached = {
    token: json.access_token,
    expiresAt: Date.now() + json.expires_in * 1000,
  }
  return json.access_token
}

/**
 * Return a valid app-level (Client Credentials) access token, minting a new
 * one if the cache is empty or near expiry. Concurrent callers during a cold
 * start share one in-flight request.
 */
export async function getAppAccessToken(): Promise<string> {
  if (cached && cached.expiresAt - Date.now() > EXPIRY_MARGIN_MS) {
    return cached.token
  }
  if (inflight) return inflight
  inflight = requestAppToken().finally(() => {
    inflight = null
  })
  return inflight
}

/**
 * Drop the cached token. Called after an unexpected 401 so the next request
 * mints a fresh one.
 */
export function invalidateAppToken(): void {
  cached = null
}
