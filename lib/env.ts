function required(key: string): string {
  const v = process.env[key]
  if (!v) {
    throw new Error(
      `Environment variable ${key} is not set. Configure it in .env.local.`
    )
  }
  return v
}

export const env = {
  databaseUrl: () => required('DATABASE_URL'),
  spotify: {
    clientId: () => required('SPOTIFY_CLIENT_ID'),
    clientSecret: () => required('SPOTIFY_CLIENT_SECRET'),
    redirectUri: () => required('SPOTIFY_REDIRECT_URI'),
  },
  sessionSecret: () => required('SESSION_SECRET'),
  lastfmApiKey: () => required('LASTFM_API_KEY'),
  anthropicApiKey: () => required('ANTHROPIC_API_KEY'),
}

export const SPOTIFY_SCOPES = [
  'user-read-recently-played',
  'user-top-read',
  'user-library-read',
  'playlist-modify-private',
  'playlist-modify-public',
  'user-read-email',
  'user-read-private',
].join(' ')
