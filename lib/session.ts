import { cookies } from 'next/headers'
import { getIronSession, type SessionOptions } from 'iron-session'
import { env } from './env'

export type UserSession = { userId: string }

export type OAuthSession = {
  state: string
  codeVerifier: string
  redirectAfter?: string
}

const isProd = process.env.NODE_ENV === 'production'

function userOptions(): SessionOptions {
  return {
    password: env.sessionSecret(),
    cookieName: 'kc_session',
    cookieOptions: {
      httpOnly: true,
      sameSite: 'lax',
      secure: isProd,
      maxAge: 60 * 60 * 24 * 30, // 30d
      path: '/',
    },
  }
}

function oauthOptions(): SessionOptions {
  return {
    password: env.sessionSecret(),
    cookieName: 'kc_oauth',
    cookieOptions: {
      httpOnly: true,
      sameSite: 'lax',
      secure: isProd,
      maxAge: 60 * 10, // 10m
      path: '/',
    },
  }
}

export async function getUserSession(): Promise<UserSession | null> {
  const store = await cookies()
  const session = await getIronSession<UserSession>(store, userOptions())
  return session.userId ? { userId: session.userId } : null
}

export async function setUserSession(s: UserSession): Promise<void> {
  const store = await cookies()
  const session = await getIronSession<UserSession>(store, userOptions())
  session.userId = s.userId
  await session.save()
}

export async function clearUserSession(): Promise<void> {
  const store = await cookies()
  const session = await getIronSession<UserSession>(store, userOptions())
  session.destroy()
}

export async function getOAuthSession(): Promise<OAuthSession | null> {
  const store = await cookies()
  const session = await getIronSession<OAuthSession>(store, oauthOptions())
  return session.state && session.codeVerifier
    ? {
        state: session.state,
        codeVerifier: session.codeVerifier,
        redirectAfter: session.redirectAfter,
      }
    : null
}

export async function setOAuthSession(s: OAuthSession): Promise<void> {
  const store = await cookies()
  const session = await getIronSession<OAuthSession>(store, oauthOptions())
  session.state = s.state
  session.codeVerifier = s.codeVerifier
  if (s.redirectAfter) session.redirectAfter = s.redirectAfter
  await session.save()
}

export async function clearOAuthSession(): Promise<void> {
  const store = await cookies()
  const session = await getIronSession<OAuthSession>(store, oauthOptions())
  session.destroy()
}
