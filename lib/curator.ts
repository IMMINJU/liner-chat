import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { db } from '@/db/client'
import {
  artists,
  curationTracks,
  curations,
  likedTracks,
  plays,
  topTracks,
  tracks,
} from '@/db/schema'
import { getArtistTopTags, getTrackTopTags } from './lastfm'
import {
  recommendKinship,
  type Category,
  type KinshipResponse,
  type SeedContext,
} from './kinship'
import {
  getArtist,
  getTrack,
  getTrackPopularities,
  searchOneTrack,
  verifyTrack,
  type VerifiedTrack,
} from './spotify/catalog'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CurationSeedInput =
  | { type: 'track_id'; track_id: string }
  | { type: 'track_text'; track_query: string }
  | { type: 'auto_top_recent' }
  | { type: 'auto_dormant_liked' }

export type CurationTrackCard = {
  id: string
  name: string
  artist: string
  album: string | null
  year: number | null
  spotifyUrl: string | null
  previewUrl: string | null
  category: Category
  sonic_link: string
  link_dimensions: string[]
}

export type CurateOk = {
  ok: true
  curationId: number
  seed: {
    id: string
    name: string
    artist: string
    album: string | null
    year: number | null
    spotifyUrl: string | null
    previewUrl: string | null
  }
  lineage_notes: string
  categories: {
    influence: CurationTrackCard[]
    peer: CurationTrackCard[]
    descendant: CurationTrackCard[]
    kinship: CurationTrackCard[]
  }
  stats: {
    proposedByLLM: number
    verifiedOnSpotify: number
    droppedAsDuplicate: number
    droppedByDiversity: number
  }
}

export type CurateError = {
  ok: false
  code:
    | 'seed_not_found'
    | 'sync_required'
    | 'llm_failed'
    | 'all_dropped'
    | 'unknown'
  message: string
}

export type CurateResult = CurateOk | CurateError

// ---------------------------------------------------------------------------
// Seed resolution
// ---------------------------------------------------------------------------

/** Return the trackId set the user "has" — liked ∪ top ∪ played. */
async function loadUserLibrary(userId: string): Promise<Set<string>> {
  const [liked, top, played] = await Promise.all([
    db
      .select({ id: likedTracks.trackId })
      .from(likedTracks)
      .where(eq(likedTracks.userId, userId)),
    db
      .select({ id: topTracks.trackId })
      .from(topTracks)
      .where(eq(topTracks.userId, userId)),
    db
      .select({ id: plays.trackId })
      .from(plays)
      .where(eq(plays.userId, userId)),
  ])
  const out = new Set<string>()
  for (const r of liked) out.add(r.id)
  for (const r of top) out.add(r.id)
  for (const r of played) out.add(r.id)
  return out
}

/** Auto seed: pick from the most recent short_term top_tracks snapshot. */
async function pickAutoTopRecent(userId: string): Promise<string | null> {
  const latest = await db
    .select({ snapshotAt: topTracks.snapshotAt })
    .from(topTracks)
    .where(
      and(eq(topTracks.userId, userId), eq(topTracks.timeRange, 'short_term'))
    )
    .orderBy(desc(topTracks.snapshotAt))
    .limit(1)
  const snap = latest[0]?.snapshotAt
  if (!snap) return null

  const rows = await db
    .select({ trackId: topTracks.trackId, rank: topTracks.rank })
    .from(topTracks)
    .where(
      and(
        eq(topTracks.userId, userId),
        eq(topTracks.timeRange, 'short_term'),
        eq(topTracks.snapshotAt, snap)
      )
    )
    .orderBy(topTracks.rank)
    .limit(10)
  if (rows.length === 0) return null
  const pick = rows[Math.floor(Math.random() * Math.min(5, rows.length))]
  return pick.trackId
}

/** Auto seed: a liked track not played in the past 90 days. */
async function pickAutoDormantLiked(userId: string): Promise<string | null> {
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
  const recentPlays = await db
    .select({ id: plays.trackId })
    .from(plays)
    .where(and(eq(plays.userId, userId), sql`${plays.playedAt} >= ${ninetyDaysAgo}`))
  const recentSet = new Set(recentPlays.map((r) => r.id))

  const liked = await db
    .select({ id: likedTracks.trackId })
    .from(likedTracks)
    .where(eq(likedTracks.userId, userId))
  const dormant = liked.map((r) => r.id).filter((id) => !recentSet.has(id))
  if (dormant.length === 0) return null
  return dormant[Math.floor(Math.random() * dormant.length)]
}

type ResolvedSeed = {
  trackId: string
  name: string
  artistId: string
  artistName: string
  album: string
  year: number
  popularity: number
  spotifyUrl: string | null
  previewUrl: string | null
}

async function resolveSeed(
  userId: string,
  input: CurationSeedInput
): Promise<ResolvedSeed | null> {
  let trackId: string | null = null

  if (input.type === 'track_text') {
    const hit = await searchOneTrack(userId, input.track_query)
    if (!hit) return null
    return {
      trackId: hit.id,
      name: hit.name,
      artistId: hit.artists[0]?.id ?? '',
      artistName: hit.artists[0]?.name ?? '',
      album: hit.album?.name ?? '',
      year: Number((hit.album?.release_date ?? '').slice(0, 4)) || 0,
      popularity: hit.popularity,
      spotifyUrl: hit.external_urls?.spotify ?? null,
      previewUrl: hit.preview_url ?? null,
    }
  }

  if (input.type === 'track_id') {
    trackId = input.track_id
  } else if (input.type === 'auto_top_recent') {
    trackId = await pickAutoTopRecent(userId)
  } else {
    trackId = await pickAutoDormantLiked(userId)
  }
  if (!trackId) return null

  const fresh = await getTrack(userId, trackId)
  if (!fresh) return null
  return {
    trackId: fresh.id,
    name: fresh.name,
    artistId: fresh.artists[0]?.id ?? '',
    artistName: fresh.artists[0]?.name ?? '',
    album: fresh.album?.name ?? '',
    year: Number((fresh.album?.release_date ?? '').slice(0, 4)) || 0,
    popularity: fresh.popularity,
    spotifyUrl: fresh.external_urls?.spotify ?? null,
    previewUrl: fresh.preview_url ?? null,
  }
}

// ---------------------------------------------------------------------------
// Listener profile
// ---------------------------------------------------------------------------

/**
 * Average Spotify popularity across up to 200 liked/top tracks → bucket.
 * Data-poor (<20 tracks) defaults to 'mixed'.
 */
async function estimateLibrarySophistication(
  userId: string
): Promise<'mainstream' | 'mixed' | 'obscure'> {
  const [liked, top] = await Promise.all([
    db
      .select({ id: likedTracks.trackId })
      .from(likedTracks)
      .where(eq(likedTracks.userId, userId))
      .limit(200),
    db
      .select({ id: topTracks.trackId })
      .from(topTracks)
      .where(eq(topTracks.userId, userId))
      .limit(200),
  ])
  const ids = new Set<string>()
  for (const r of liked) ids.add(r.id)
  for (const r of top) ids.add(r.id)
  const sample = [...ids].slice(0, 200)
  if (sample.length < 20) return 'mixed'

  const pops = await getTrackPopularities(userId, sample)
  if (pops.size < 20) return 'mixed'
  let sum = 0
  for (const v of pops.values()) sum += v
  const avg = sum / pops.size
  if (avg >= 60) return 'mainstream'
  if (avg >= 30) return 'mixed'
  return 'obscure'
}

// ---------------------------------------------------------------------------
// Seed context
// ---------------------------------------------------------------------------

async function buildSeedContext(
  userId: string,
  seed: ResolvedSeed
): Promise<SeedContext> {
  const [artist, trackTags, artistTags, sophistication] = await Promise.all([
    seed.artistId ? getArtist(userId, seed.artistId) : Promise.resolve(null),
    getTrackTopTags(seed.artistName, seed.name).catch(() => []),
    getArtistTopTags(seed.artistName).catch(() => []),
    estimateLibrarySophistication(userId),
  ])

  // Spotify made /v1/audio-features private to apps created after 2024-11-27.
  // We were created after the cut-off, so audio/tonal are always empty; the
  // sync stage that would have populated them is disabled in runSync. The
  // shape is preserved so the kinship prompt template doesn't need to branch.
  const audio: SeedContext['audio'] = {}
  const tonal: SeedContext['tonal'] = {}

  return {
    track: {
      name: seed.name,
      artist: seed.artistName,
      album: seed.album,
      year: seed.year,
    },
    spotifyGenres: artist?.genres ?? [],
    lastfmTrackTags: trackTags.map((t) => t.name),
    lastfmArtistTags: artistTags.map((t) => t.name),
    audio,
    tonal,
    listenerProfile: {
      seedPopularity: seed.popularity,
      librarySophistication: sophistication,
    },
  }
}

// ---------------------------------------------------------------------------
// Verify + filter + diversify
// ---------------------------------------------------------------------------

type RecWithVerified = {
  category: Category
  artistId: string
  artistName: string
  trackId: string
  trackName: string
  album: string | null
  year: number | null
  spotifyUrl: string | null
  previewUrl: string | null
  sonic_link: string
  link_dimensions: string[]
}

/**
 * Walk up the curation parent chain (max 50 hops as a safety net) and collect:
 *   - artistIds from every recommendation track in every ancestor
 *   - artistIds from every ancestor's seed track (except the chain root)
 *
 * The root seed's artist is intentionally excluded so the user's original
 * seed artist can keep surfacing across the chain (we recommend per-track,
 * not per-artist). Aborts if any ancestor is owned by a different user.
 */
async function collectChainContext(args: {
  userId: string
  parentCurationId: number
}): Promise<{ chainArtistIds: Set<string>; ancestorIds: number[] }> {
  type AncestorRow = {
    id: number
    seedTrackId: string
    parentId: number | null
    userId: string
  }
  const chain: { id: number; seedTrackId: string }[] = []
  let curId: number | null = args.parentCurationId
  let hops = 0
  while (curId !== null && hops < 50) {
    const row: AncestorRow[] = await db
      .select({
        id: curations.id,
        seedTrackId: curations.seedTrackId,
        parentId: curations.parentCurationId,
        userId: curations.userId,
      })
      .from(curations)
      .where(eq(curations.id, curId))
      .limit(1)
    const r: AncestorRow | undefined = row[0]
    if (!r) break
    if (r.userId !== args.userId) break // security guard
    chain.unshift({ id: r.id, seedTrackId: r.seedTrackId })
    curId = r.parentId ?? null
    hops++
  }
  if (chain.length === 0) {
    return { chainArtistIds: new Set(), ancestorIds: [] }
  }

  const curationIds = chain.map((c) => c.id)
  const seedTrackIds = chain.map((c) => c.seedTrackId)

  const [recArtistRows, seedArtistRows] = await Promise.all([
    db
      .select({ artistId: tracks.artistId })
      .from(curationTracks)
      .innerJoin(tracks, eq(curationTracks.trackId, tracks.id))
      .where(inArray(curationTracks.curationId, curationIds)),
    db
      .select({ id: tracks.id, artistId: tracks.artistId })
      .from(tracks)
      .where(inArray(tracks.id, seedTrackIds)),
  ])

  const seedArtistMap = new Map(seedArtistRows.map((r) => [r.id, r.artistId]))
  const rootSeedArtistId = seedArtistMap.get(chain[0].seedTrackId) ?? null

  const chainArtistIds = new Set<string>()
  for (const r of recArtistRows) chainArtistIds.add(r.artistId)
  for (const seedTrackId of seedTrackIds) {
    const aid = seedArtistMap.get(seedTrackId)
    if (aid) chainArtistIds.add(aid)
  }
  if (rootSeedArtistId) chainArtistIds.delete(rootSeedArtistId)

  return { chainArtistIds, ancestorIds: curationIds }
}

async function verifyAndFilter(
  userId: string,
  llm: KinshipResponse,
  library: Set<string>,
  seedTrackId: string,
  chainArtistIds: Set<string>
): Promise<{
  recs: RecWithVerified[]
  proposedByLLM: number
  verifiedOnSpotify: number
  droppedAsDuplicate: number
  droppedByDiversity: number
}> {
  // Run verifyTrack in parallel.
  const verifiedResults = await Promise.all(
    llm.tracks.map(async (t) => {
      const v = await verifyTrack(userId, {
        artist: t.artist,
        track: t.track,
        album: t.album,
        year: t.year,
      }).catch(() => null)
      return v ? { llm: t, v } : null
    })
  )
  const verified = verifiedResults.filter(
    (r): r is { llm: (typeof llm.tracks)[number]; v: VerifiedTrack } => r !== null
  )

  // Dedupe vs library + seed itself + chain artists (digging chain).
  const seenIds = new Set<string>([seedTrackId])
  const afterDedupe: typeof verified = []
  let droppedAsDuplicate = 0
  for (const r of verified) {
    if (
      library.has(r.v.id) ||
      seenIds.has(r.v.id) ||
      chainArtistIds.has(r.v.artistId)
    ) {
      droppedAsDuplicate++
      continue
    }
    seenIds.add(r.v.id)
    afterDedupe.push(r)
  }

  // Diversity: per-category 1 per artist, overall 2 per artist max.
  const perCategoryArtist = new Map<string, Set<string>>()
  const overallArtistCount = new Map<string, number>()
  const final: RecWithVerified[] = []
  let droppedByDiversity = 0

  for (const r of afterDedupe) {
    const cat = r.llm.category
    const artistId = r.v.artistId
    const inCat = perCategoryArtist.get(cat) ?? new Set<string>()
    const overall = overallArtistCount.get(artistId) ?? 0
    if (inCat.has(artistId) || overall >= 2) {
      droppedByDiversity++
      continue
    }
    inCat.add(artistId)
    perCategoryArtist.set(cat, inCat)
    overallArtistCount.set(artistId, overall + 1)
    final.push({
      category: cat,
      artistId,
      artistName: r.v.artistName,
      trackId: r.v.id,
      trackName: r.v.name,
      album: r.v.album,
      year: r.v.year,
      spotifyUrl: r.v.spotifyUrl,
      previewUrl: r.v.previewUrl,
      sonic_link: r.llm.sonic_link,
      link_dimensions: r.llm.link_dimensions,
    })
  }

  return {
    recs: final,
    proposedByLLM: llm.tracks.length,
    verifiedOnSpotify: verified.length,
    droppedAsDuplicate,
    droppedByDiversity,
  }
}

// ---------------------------------------------------------------------------
// Persist
// ---------------------------------------------------------------------------

async function saveCuration(args: {
  userId: string
  query: string | null
  seedTrackId: string
  parentCurationId: number | null
  lineageNotes: string
  recs: RecWithVerified[]
}): Promise<number> {
  return await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(curations)
      .values({
        userId: args.userId,
        query: args.query,
        seedTrackId: args.seedTrackId,
        parentCurationId: args.parentCurationId,
        lineageNotes: args.lineageNotes,
      })
      .returning({ id: curations.id })
    const curationId = inserted[0].id

    if (args.recs.length > 0) {
      // Assign position per category in input order.
      const counters = new Map<Category, number>()
      const rows = args.recs.map((r) => {
        const c = counters.get(r.category) ?? 0
        counters.set(r.category, c + 1)
        return {
          curationId,
          trackId: r.trackId,
          category: r.category,
          sonicLink: r.sonic_link,
          linkDimensions: r.link_dimensions,
          position: c,
        }
      })
      await tx.insert(curationTracks).values(rows)
    }

    return curationId
  })
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Total wall-clock cap on a single curation. We've seen Sonnet's per-call
 * timeout get swallowed by the SDK on Vercel, so this outer race is the
 * final safety net before the platform itself kills the function at 60s.
 * Anything that's still running when this fires gets reported as
 * `llm_failed` (the most common cause) so the chat UI shows a typed error
 * instead of a generic 504.
 */
const RUN_CURATION_HARD_CAP_MS = 45_000

export async function runCuration(args: {
  userId: string
  query: string | null
  seed: CurationSeedInput
  parentCurationId?: number | null
}): Promise<CurateResult> {
  const start = Date.now()
  const hardCap = new Promise<CurateResult>((resolve) =>
    setTimeout(
      () =>
        resolve({
          ok: false,
          code: 'llm_failed',
          message: `curation exceeded ${RUN_CURATION_HARD_CAP_MS}ms (hard cap)`,
        }),
      RUN_CURATION_HARD_CAP_MS
    )
  )
  const work = runCurationInner(args, start)
  return Promise.race([work, hardCap])
}

async function runCurationInner(
  args: {
    userId: string
    query: string | null
    seed: CurationSeedInput
    parentCurationId?: number | null
  },
  t0: number
): Promise<CurateResult> {
  const lap = (name: string, start: number) =>
    console.log(`[curate] ${name} ${Date.now() - start}ms`)

  try {
    const tSeed = Date.now()
    const seed = await resolveSeed(args.userId, args.seed)
    lap('resolveSeed', tSeed)
    if (!seed) {
      const code =
        args.seed.type === 'track_text' ? 'seed_not_found' : 'sync_required'
      return {
        ok: false,
        code,
        message:
          code === 'seed_not_found'
            ? '시드 곡을 찾지 못했어요.'
            : '동기화된 데이터가 부족해서 시드를 고를 수 없어요.',
      }
    }

    const tCtx = Date.now()
    const [library, ctx, chainCtx] = await Promise.all([
      loadUserLibrary(args.userId),
      buildSeedContext(args.userId, seed),
      args.parentCurationId
        ? collectChainContext({
            userId: args.userId,
            parentCurationId: args.parentCurationId,
          })
        : Promise.resolve({
            chainArtistIds: new Set<string>(),
            ancestorIds: [],
          }),
    ])
    lap('library+context+chain (parallel)', tCtx)

    let llm: KinshipResponse
    const tLlm = Date.now()
    try {
      llm = await recommendKinship(ctx)
      lap('recommendKinship (Sonnet)', tLlm)
    } catch (err) {
      lap('recommendKinship FAILED', tLlm)
      return {
        ok: false,
        code: 'llm_failed',
        message:
          err instanceof Error ? err.message : 'LLM 호출이 실패했습니다.',
      }
    }

    const tVerify = Date.now()
    const { recs, ...stats } = await verifyAndFilter(
      args.userId,
      llm,
      library,
      seed.trackId,
      chainCtx.chainArtistIds
    )
    lap('verifyAndFilter', tVerify)

    if (recs.length === 0) {
      return {
        ok: false,
        code: 'all_dropped',
        message: '추천 후보가 모두 검증/필터에서 제외됐어요.',
      }
    }

    const tSave = Date.now()
    const curationId = await saveCuration({
      userId: args.userId,
      query: args.query,
      seedTrackId: seed.trackId,
      parentCurationId: args.parentCurationId ?? null,
      lineageNotes: llm.lineage_notes,
      recs,
    })
    lap('saveCuration', tSave)
    console.log(`[curate] TOTAL ${Date.now() - t0}ms`)

    const byCat: CurateOk['categories'] = {
      influence: [],
      peer: [],
      descendant: [],
      kinship: [],
    }
    for (const r of recs) {
      byCat[r.category].push({
        id: r.trackId,
        name: r.trackName,
        artist: r.artistName,
        album: r.album,
        year: r.year,
        spotifyUrl: r.spotifyUrl,
        previewUrl: r.previewUrl,
        category: r.category,
        sonic_link: r.sonic_link,
        link_dimensions: r.link_dimensions,
      })
    }

    return {
      ok: true,
      curationId,
      seed: {
        id: seed.trackId,
        name: seed.name,
        artist: seed.artistName,
        album: seed.album,
        year: seed.year,
        spotifyUrl: seed.spotifyUrl,
        previewUrl: seed.previewUrl,
      },
      lineage_notes: llm.lineage_notes,
      categories: byCat,
      stats,
    }
  } catch (err) {
    console.log(
      `[curate] CATCH after ${Date.now() - t0}ms: ${
        err instanceof Error ? err.message : String(err)
      }`
    )
    return {
      ok: false,
      code: 'unknown',
      message: err instanceof Error ? err.message : String(err),
    }
  }
}

// Silence unused-import warnings on reserved helpers.
void artists
void tracks
void isNull
void inArray
