export class SpotifyAuthError extends Error {
  constructor(message: string, public cause?: unknown) {
    super(message)
    this.name = 'SpotifyAuthError'
  }
}

export class SpotifyRateLimitError extends Error {
  constructor(public retryAfterSeconds: number) {
    super(`Spotify rate limit (retry after ${retryAfterSeconds}s)`)
    this.name = 'SpotifyRateLimitError'
  }
}

export class SpotifyServerError extends Error {
  constructor(public status: number, public body: string) {
    super(`Spotify server error ${status}`)
    this.name = 'SpotifyServerError'
  }
}

export class SpotifyClientError extends Error {
  constructor(public status: number, public body: string) {
    super(`Spotify client error ${status}: ${body}`)
    this.name = 'SpotifyClientError'
  }
}
