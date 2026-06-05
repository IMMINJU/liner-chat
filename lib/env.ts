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
    // Login-less: only the Client Credentials flow is used, which needs just
    // the app's id/secret. No redirect URI, no user scopes.
    clientId: () => required('SPOTIFY_CLIENT_ID'),
    clientSecret: () => required('SPOTIFY_CLIENT_SECRET'),
  },
  lastfmApiKey: () => required('LASTFM_API_KEY'),
  anthropicApiKey: () => required('ANTHROPIC_API_KEY'),
}
