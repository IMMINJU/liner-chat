import { spotifyFetch } from './client'

type SpotifyPlaylist = {
  id: string
  name: string
  external_urls?: { spotify?: string }
}

/**
 * Create a private playlist on the user's account. Returns the new playlist's
 * id and Spotify URL.
 */
export async function createPlaylist(
  userId: string,
  args: { name: string; description: string }
): Promise<{ playlistId: string; spotifyUrl: string }> {
  const resp = await spotifyFetch<SpotifyPlaylist>(
    userId,
    `/v1/users/${encodeURIComponent(userId)}/playlists`,
    {
      method: 'POST',
      body: JSON.stringify({
        name: args.name,
        description: args.description,
        public: false,
        collaborative: false,
      }),
    }
  )
  if (!resp) throw new Error('Spotify create playlist returned no body')
  return {
    playlistId: resp.id,
    spotifyUrl:
      resp.external_urls?.spotify ??
      `https://open.spotify.com/playlist/${resp.id}`,
  }
}

/**
 * Replace all tracks in a playlist. `trackIds` are Spotify track ids (not URIs).
 * Internally we PUT URIs in batches of 100. The PUT semantics REPLACE existing
 * tracks, giving us idempotent saves for re-clicking "Save to Spotify".
 */
export async function replacePlaylistTracks(
  userId: string,
  playlistId: string,
  trackIds: string[]
): Promise<void> {
  const uris = trackIds.map((id) => `spotify:track:${id}`)
  // First batch via PUT (replace), subsequent batches via POST (append).
  const first = uris.slice(0, 100)
  await spotifyFetch(
    userId,
    `/v1/playlists/${encodeURIComponent(playlistId)}/tracks`,
    {
      method: 'PUT',
      body: JSON.stringify({ uris: first }),
    }
  )
  for (let i = 100; i < uris.length; i += 100) {
    const batch = uris.slice(i, i + 100)
    await spotifyFetch(
      userId,
      `/v1/playlists/${encodeURIComponent(playlistId)}/tracks`,
      {
        method: 'POST',
        body: JSON.stringify({ uris: batch }),
      }
    )
  }
}

/** Update a playlist's name and description. */
export async function updatePlaylistDetails(
  userId: string,
  playlistId: string,
  args: { name: string; description: string }
): Promise<void> {
  await spotifyFetch(
    userId,
    `/v1/playlists/${encodeURIComponent(playlistId)}`,
    {
      method: 'PUT',
      body: JSON.stringify({
        name: args.name,
        description: args.description,
      }),
    }
  )
}

/** Stable public-URL builder for a playlist id. */
export function playlistUrl(playlistId: string): string {
  return `https://open.spotify.com/playlist/${playlistId}`
}
