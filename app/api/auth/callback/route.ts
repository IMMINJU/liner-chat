import { NextRequest, NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { authTokens, users } from '@/db/schema'
import { exchangeCodeForTokens } from '@/lib/spotify/tokens'
import {
  clearOAuthSession,
  getOAuthSession,
  setUserSession,
} from '@/lib/session'

function redirectWithError(req: NextRequest, code: string) {
  return NextResponse.redirect(new URL(`/?auth_error=${code}`, req.url))
}

type SpotifyMe = {
  id: string
  display_name?: string | null
  email?: string | null
}

export async function GET(req: NextRequest) {
  const url = req.nextUrl
  const error = url.searchParams.get('error')
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')

  if (error) {
    await clearOAuthSession()
    return redirectWithError(req, error)
  }

  const oauth = await getOAuthSession()
  if (!oauth) return redirectWithError(req, 'session_expired')
  if (!state || state !== oauth.state) {
    await clearOAuthSession()
    return redirectWithError(req, 'state_mismatch')
  }
  if (!code) {
    await clearOAuthSession()
    return redirectWithError(req, 'missing_code')
  }

  let tokens
  try {
    tokens = await exchangeCodeForTokens({
      code,
      codeVerifier: oauth.codeVerifier,
    })
  } catch {
    await clearOAuthSession()
    return redirectWithError(req, 'token_exchange_failed')
  }

  // Fetch /me directly with the freshly-issued token (cannot use spotifyFetch
  // yet, since the user row hasn't been created).
  let me: SpotifyMe
  try {
    const meRes = await fetch('https://api.spotify.com/v1/me', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    })
    if (!meRes.ok) throw new Error(`status ${meRes.status}`)
    me = (await meRes.json()) as SpotifyMe
  } catch {
    await clearOAuthSession()
    return redirectWithError(req, 'me_lookup_failed')
  }

  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000)
  const refreshToken = tokens.refresh_token
  if (!refreshToken) {
    await clearOAuthSession()
    return redirectWithError(req, 'token_exchange_failed')
  }

  // Upsert user + auth_tokens
  await db.transaction(async (tx) => {
    await tx
      .insert(users)
      .values({ id: me.id, displayName: me.display_name ?? null })
      .onConflictDoUpdate({
        target: users.id,
        set: { displayName: me.display_name ?? null },
      })

    const existing = await tx
      .select({ userId: authTokens.userId })
      .from(authTokens)
      .where(eq(authTokens.userId, me.id))
      .limit(1)

    if (existing.length === 0) {
      await tx.insert(authTokens).values({
        userId: me.id,
        accessToken: tokens.access_token,
        refreshToken,
        expiresAt,
        scope: tokens.scope ?? null,
      })
    } else {
      await tx
        .update(authTokens)
        .set({
          accessToken: tokens.access_token,
          refreshToken,
          expiresAt,
          scope: tokens.scope ?? null,
        })
        .where(eq(authTokens.userId, me.id))
    }
  })

  await setUserSession({ userId: me.id })
  await clearOAuthSession()

  const target = oauth.redirectAfter && oauth.redirectAfter.startsWith('/')
    ? oauth.redirectAfter
    : '/'
  return NextResponse.redirect(new URL(target, req.url))
}
