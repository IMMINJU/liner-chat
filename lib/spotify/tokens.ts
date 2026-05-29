import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { authTokens } from '@/db/schema'
import { env } from '../env'
import { SpotifyAuthError } from './errors'

const TOKEN_URL = 'https://accounts.spotify.com/api/token'

type SpotifyTokenResponse = {
  access_token: string
  token_type: 'Bearer'
  scope?: string
  expires_in: number
  refresh_token?: string
}

function basicAuthHeader(): string {
  const id = env.spotify.clientId()
  const secret = env.spotify.clientSecret()
  return 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64')
}

/**
 * Exchange authorization code (after Spotify callback) for tokens.
 * Used by /api/auth/callback only.
 */
export async function exchangeCodeForTokens(args: {
  code: string
  codeVerifier: string
}): Promise<SpotifyTokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: args.code,
    redirect_uri: env.spotify.redirectUri(),
    client_id: env.spotify.clientId(),
    code_verifier: args.codeVerifier,
  })

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  })

  if (!res.ok) {
    const text = await res.text()
    throw new SpotifyAuthError(`Token exchange failed: ${res.status} ${text}`)
  }
  return (await res.json()) as SpotifyTokenResponse
}

/**
 * Refresh access token using stored refresh_token.
 * Returns the new token response (may or may not include a new refresh_token).
 */
export async function refreshAccessToken(
  refreshToken: string
): Promise<SpotifyTokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: env.spotify.clientId(),
  })

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  })

  if (!res.ok) {
    const text = await res.text()
    throw new SpotifyAuthError(`Token refresh failed: ${res.status} ${text}`)
  }
  return (await res.json()) as SpotifyTokenResponse
}

type StoredToken = {
  accessToken: string
  refreshToken: string
  expiresAt: Date
  scope: string | null
}

async function loadToken(userId: string): Promise<StoredToken> {
  const rows = await db
    .select()
    .from(authTokens)
    .where(eq(authTokens.userId, userId))
    .limit(1)
  const row = rows[0]
  if (!row) throw new SpotifyAuthError(`No auth token for user ${userId}`)
  return {
    accessToken: row.accessToken,
    refreshToken: row.refreshToken,
    expiresAt: row.expiresAt,
    scope: row.scope,
  }
}

async function saveToken(
  userId: string,
  resp: SpotifyTokenResponse,
  fallbackRefreshToken: string
): Promise<StoredToken> {
  const expiresAt = new Date(Date.now() + resp.expires_in * 1000)
  const refreshToken = resp.refresh_token ?? fallbackRefreshToken
  await db
    .update(authTokens)
    .set({
      accessToken: resp.access_token,
      refreshToken,
      expiresAt,
      scope: resp.scope ?? null,
    })
    .where(eq(authTokens.userId, userId))
  return {
    accessToken: resp.access_token,
    refreshToken,
    expiresAt,
    scope: resp.scope ?? null,
  }
}

/**
 * Get a valid (non-expired) access token for the user, refreshing if needed.
 * 60s safety margin.
 */
export async function getValidAccessToken(userId: string): Promise<string> {
  const token = await loadToken(userId)
  const msToExpiry = token.expiresAt.getTime() - Date.now()
  if (msToExpiry > 60_000) return token.accessToken

  const refreshed = await refreshAccessToken(token.refreshToken)
  const updated = await saveToken(userId, refreshed, token.refreshToken)
  return updated.accessToken
}

/**
 * Force a refresh (used when a 401 comes back unexpectedly).
 */
export async function forceRefreshAccessToken(userId: string): Promise<string> {
  const token = await loadToken(userId)
  const refreshed = await refreshAccessToken(token.refreshToken)
  const updated = await saveToken(userId, refreshed, token.refreshToken)
  return updated.accessToken
}
