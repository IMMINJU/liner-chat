import { NextRequest, NextResponse } from 'next/server'
import { and, asc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/db/client'
import {
  artists,
  curationPlaylists,
  curationTracks,
  curations,
  tracks,
} from '@/db/schema'
import { messages as m } from '@/lib/messages'
import { getUserSession } from '@/lib/session'
import {
  createPlaylist,
  playlistUrl,
  replacePlaylistTracks,
  updatePlaylistDetails,
} from '@/lib/spotify/playlist'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const RequestSchema = z.object({
  curation_id: z.number().int().positive(),
})

const CATEGORY_ORDER = ['influence', 'peer', 'descendant', 'kinship'] as const
const CATEGORY_RANK: Record<string, number> = {
  influence: 0,
  peer: 1,
  descendant: 2,
  kinship: 3,
}

function clampDescription(s: string, max = 300): string {
  if (s.length <= max) return s
  return s.slice(0, max - 1) + '…'
}

function firstSentence(s: string): string {
  const m = s.match(/^[^.!?。]*[.!?。]?/)
  return (m?.[0] ?? s).trim()
}

export async function POST(req: NextRequest) {
  const session = await getUserSession()
  if (!session) {
    return NextResponse.json(
      { ok: false, code: 'unauth', message: m.chat.notAuth },
      { status: 401 }
    )
  }

  let body: z.infer<typeof RequestSchema>
  try {
    body = RequestSchema.parse(await req.json())
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        code: 'bad_request',
        message: err instanceof Error ? err.message : 'invalid request',
      },
      { status: 400 }
    )
  }

  // Load curation (owner-checked) + seed + recommended tracks in parallel.
  const [headRows, seedRowsFromCuration] = await Promise.all([
    db
      .select()
      .from(curations)
      .where(
        and(eq(curations.id, body.curation_id), eq(curations.userId, session.userId))
      )
      .limit(1),
    Promise.resolve(null), // placeholder slot
  ])
  void seedRowsFromCuration

  const curation = headRows[0]
  if (!curation) {
    return NextResponse.json({
      ok: false,
      code: 'not_found',
      message: m.playlist.errors.notFound,
    })
  }

  const [seedRows, recRows] = await Promise.all([
    db
      .select({
        id: tracks.id,
        name: tracks.name,
        artist: artists.name,
      })
      .from(tracks)
      .innerJoin(artists, eq(tracks.artistId, artists.id))
      .where(eq(tracks.id, curation.seedTrackId))
      .limit(1),
    db
      .select({
        trackId: tracks.id,
        category: curationTracks.category,
        position: curationTracks.position,
      })
      .from(curationTracks)
      .innerJoin(tracks, eq(curationTracks.trackId, tracks.id))
      .where(eq(curationTracks.curationId, body.curation_id))
      .orderBy(asc(curationTracks.position)),
  ])

  const seed = seedRows[0]
  if (!seed) {
    return NextResponse.json({
      ok: false,
      code: 'not_found',
      message: m.playlist.errors.notFound,
    })
  }

  // Order: seed first, then category-grouped, position-sorted within category.
  const ordered = [...recRows]
    .sort((a, b) => {
      const ar = CATEGORY_RANK[a.category] ?? 99
      const br = CATEGORY_RANK[b.category] ?? 99
      if (ar !== br) return ar - br
      return a.position - b.position
    })
    .map((r) => r.trackId)
  void CATEGORY_ORDER

  const trackIds = [seed.id, ...ordered]

  const name = `Kinship: ${seed.artist} — ${seed.name}`
  const lineage = curation.lineageNotes ?? ''
  const description = clampDescription(
    `${firstSentence(lineage)} · by liner-chat · seed: ${seed.artist} — ${seed.name}`
  )

  // Existing playlist?
  const existingRows = await db
    .select()
    .from(curationPlaylists)
    .where(eq(curationPlaylists.curationId, body.curation_id))
    .limit(1)
  const existing = existingRows[0]

  try {
    let playlistId: string
    let url: string
    let isReplace: boolean

    if (existing) {
      playlistId = existing.spotifyPlaylistId
      url = playlistUrl(playlistId)
      isReplace = true
      // Update metadata then replace tracks.
      await updatePlaylistDetails(session.userId, playlistId, {
        name,
        description,
      })
      await replacePlaylistTracks(session.userId, playlistId, trackIds)
      await db
        .update(curationPlaylists)
        .set({ savedAt: new Date() })
        .where(eq(curationPlaylists.curationId, body.curation_id))
    } else {
      const created = await createPlaylist(session.userId, { name, description })
      playlistId = created.playlistId
      url = created.spotifyUrl
      isReplace = false
      await replacePlaylistTracks(session.userId, playlistId, trackIds)
      await db.insert(curationPlaylists).values({
        curationId: body.curation_id,
        spotifyPlaylistId: playlistId,
        savedAt: new Date(),
      })
    }

    return NextResponse.json({
      ok: true,
      playlistId,
      spotifyUrl: url,
      isReplace,
      trackCount: trackIds.length,
    })
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        code: 'spotify_failed',
        message:
          m.playlist.errors.spotifyFailed +
          ' (' +
          (err instanceof Error ? err.message : String(err)) +
          ')',
      },
      { status: 500 }
    )
  }
}
