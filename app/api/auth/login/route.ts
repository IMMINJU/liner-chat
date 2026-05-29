import { NextRequest, NextResponse } from 'next/server'
import {
  generateCodeChallenge,
  generateCodeVerifier,
  generateState,
} from '@/lib/auth/pkce'
import { env, SPOTIFY_SCOPES } from '@/lib/env'
import { setOAuthSession } from '@/lib/session'

const AUTHORIZE_URL = 'https://accounts.spotify.com/authorize'

export async function GET(req: NextRequest) {
  const redirectAfter = req.nextUrl.searchParams.get('redirect') ?? undefined

  const codeVerifier = generateCodeVerifier()
  const codeChallenge = generateCodeChallenge(codeVerifier)
  const state = generateState()

  await setOAuthSession({ state, codeVerifier, redirectAfter })

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: env.spotify.clientId(),
    scope: SPOTIFY_SCOPES,
    redirect_uri: env.spotify.redirectUri(),
    state,
    code_challenge_method: 'S256',
    code_challenge: codeChallenge,
  })

  return NextResponse.redirect(`${AUTHORIZE_URL}?${params.toString()}`)
}
