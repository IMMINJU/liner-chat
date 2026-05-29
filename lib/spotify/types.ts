/**
 * Minimal Spotify Web API response shapes we actually consume.
 * Only fields we read are typed; everything else is allowed via index signature.
 */

export type SpotifyArtistRef = {
  id: string
  name: string
}

export type SpotifyImage = {
  url: string
  width: number | null
  height: number | null
}

export type SpotifyAlbumRef = {
  id: string
  name: string
  release_date: string // YYYY | YYYY-MM | YYYY-MM-DD
  release_date_precision?: 'year' | 'month' | 'day'
  /** Spotify returns 3 sizes (640/300/64). We pick the middle one. */
  images?: SpotifyImage[]
}

export type SpotifyTrack = {
  id: string
  name: string
  duration_ms: number
  album: SpotifyAlbumRef
  artists: SpotifyArtistRef[]
  external_urls?: { spotify?: string }
  preview_url?: string | null
}

export type SpotifyPagedResponse<T> = {
  href: string
  items: T[]
  limit: number
  next: string | null
  offset: number
  previous: string | null
  total: number
}

export type SpotifySavedTrack = {
  added_at: string
  track: SpotifyTrack
}

export type SpotifyPlayHistory = {
  played_at: string
  track: SpotifyTrack
}

export type SpotifyArtistFull = {
  id: string
  name: string
  genres: string[]
}

export type SpotifyAudioFeatures = {
  id: string
  energy: number | null
  valence: number | null
  tempo: number | null
  acousticness: number | null
  danceability: number | null
  instrumentalness: number | null
  speechiness: number | null
  liveness: number | null
  // Tonal context; -1 (or absent) means undetected → store as null.
  key: number | null
  mode: number | null
  time_signature: number | null
}
