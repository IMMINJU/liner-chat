import { eq, inArray } from 'drizzle-orm'
import { db } from '@/db/client'
import { curationTracks, curations, tracks } from '@/db/schema'
import { getArtistTopTags, getTrackTopTags } from './lastfm'
import { LOCAL_USER, ensureLocalUser } from './localUser'
import {
  recommendKinship,
  supplementKinship,
  type Category,
  type KinshipResponse,
  type SeedContext,
  type TrackRec,
} from './kinship'
import {
  getArtist,
  getTrack,
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

export type CurationTrackCard = {
  id: string
  name: string
  artist: string
  album: string | null
  year: number | null
  spotifyUrl: string | null
  previewUrl: string | null
  coverUrl: string | null
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
  code: 'seed_not_found' | 'llm_failed' | 'all_dropped' | 'unknown'
  message: string
}

export type CurateResult = CurateOk | CurateError

// ---------------------------------------------------------------------------
// Seed resolution
// ---------------------------------------------------------------------------

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
  input: CurationSeedInput
): Promise<ResolvedSeed | null> {
  if (input.type === 'track_text') {
    const hit = await searchOneTrack(input.track_query)
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

  const fresh = await getTrack(input.track_id)
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
// Seed context
// ---------------------------------------------------------------------------

async function buildSeedContext(seed: ResolvedSeed): Promise<SeedContext> {
  const [artist, trackTags, artistTags] = await Promise.all([
    seed.artistId ? getArtist(seed.artistId) : Promise.resolve(null),
    getTrackTopTags(seed.artistName, seed.name).catch(() => []),
    getArtistTopTags(seed.artistName).catch(() => []),
  ])

  // Spotify made /v1/audio-features private to apps created after 2024-11-27.
  // We were created after the cut-off, so audio/tonal are always empty; the
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
    // Login-less mode: there's no user library to profile, so accessibility
    // tuning falls back to 'mixed' (balanced). The seed track's *own*
    // popularity is still a real signal and is passed through.
    listenerProfile: {
      seedPopularity: seed.popularity,
      librarySophistication: 'mixed',
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
  coverUrl: string | null
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
async function collectChainContext(
  parentCurationId: number
): Promise<{ chainArtistIds: Set<string>; ancestorIds: number[] }> {
  type AncestorRow = {
    id: number
    seedTrackId: string
    parentId: number | null
    userId: string
  }
  const chain: { id: number; seedTrackId: string }[] = []
  let curId: number | null = parentCurationId
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
    if (r.userId !== LOCAL_USER) break // security guard
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

// Mutable accumulator threaded through verify passes so a follow-up supplement
// pass dedupes/diversifies against everything the first pass already accepted.
type FilterState = {
  seenIds: Set<string>
  perCategoryArtist: Map<string, Set<string>>
  overallArtistCount: Map<string, number>
}

function newFilterState(seedTrackId: string): FilterState {
  return {
    seenIds: new Set<string>([seedTrackId]),
    perCategoryArtist: new Map(),
    overallArtistCount: new Map(),
  }
}

/**
 * Verify a batch of LLM track recs against Spotify, then dedupe + diversify
 * against the shared `state` (which accumulates across passes). Returns the
 * accepted recs and per-pass stats. `state` is mutated in place.
 *
 * Dedupe drops: the seed itself, anything already accepted this curation, a
 * track the LLM proposed twice, and (on a digging-chain step) artists already
 * surfaced higher in the chain. Diversity caps: 1 per artist per category,
 * 2 per artist overall. No user library to exclude against in login-less mode.
 */
async function verifyBatch(
  recs: TrackRec[],
  state: FilterState,
  chainArtistIds: Set<string>
): Promise<{
  accepted: RecWithVerified[]
  proposed: number
  verified: number
  droppedAsDuplicate: number
  droppedByDiversity: number
}> {
  const verifiedResults = await Promise.all(
    recs.map(async (t) => {
      const v = await verifyTrack({
        artist: t.artist,
        track: t.track,
        album: t.album,
        year: t.year,
      }).catch(() => null)
      return v ? { llm: t, v } : null
    })
  )
  const verified = verifiedResults.filter(
    (r): r is { llm: TrackRec; v: VerifiedTrack } => r !== null
  )

  const accepted: RecWithVerified[] = []
  let droppedAsDuplicate = 0
  let droppedByDiversity = 0

  for (const r of verified) {
    if (state.seenIds.has(r.v.id) || chainArtistIds.has(r.v.artistId)) {
      droppedAsDuplicate++
      continue
    }
    const cat = r.llm.category
    const artistId = r.v.artistId
    const inCat = state.perCategoryArtist.get(cat) ?? new Set<string>()
    const overall = state.overallArtistCount.get(artistId) ?? 0
    if (inCat.has(artistId) || overall >= 2) {
      droppedByDiversity++
      continue
    }
    state.seenIds.add(r.v.id)
    inCat.add(artistId)
    state.perCategoryArtist.set(cat, inCat)
    state.overallArtistCount.set(artistId, overall + 1)
    accepted.push({
      category: cat,
      artistId,
      artistName: r.v.artistName,
      trackId: r.v.id,
      trackName: r.v.name,
      album: r.v.album,
      year: r.v.year,
      spotifyUrl: r.v.spotifyUrl,
      previewUrl: r.v.previewUrl,
      coverUrl: r.v.coverUrl,
      sonic_link: r.llm.sonic_link,
      link_dimensions: r.llm.link_dimensions,
    })
  }

  return {
    accepted,
    proposed: recs.length,
    verified: verified.length,
    droppedAsDuplicate,
    droppedByDiversity,
  }
}

// Categories that hurt most when verify empties them: influence anchors the
// lineage and kinship is the whole product. If either lands zero verified
// tracks we spend one extra Sonnet call trying to refill it. peer/descendant
// going thin is tolerated (they already have low floors) and not worth a
// second round-trip against the curator's 45s hard cap.
const SUPPLEMENT_TARGET_CATEGORIES: { category: Category; want: number }[] = [
  { category: 'influence', want: 2 },
  { category: 'kinship', want: 2 },
]

/**
 * Run first-pass verify, then — if a high-value category came back empty —
 * one supplement Sonnet call to refill it, re-verified against the same state.
 * The supplement is best-effort: if it times out or finds nothing, we ship the
 * first-pass result. Returns the merged recs + combined stats.
 */
// Headroom the supplement pass needs before the curator hard cap (100s): its
// own 30s Sonnet budget + ~8s to re-verify the returned tracks on Spotify. If
// less than this remains we skip the supplement and ship the first pass — a
// curation missing one category beats a timeout that loses everything.
const SUPPLEMENT_MIN_HEADROOM_MS = 38_000

async function verifyAndFilter(
  llm: KinshipResponse,
  ctx: SeedContext,
  seedTrackId: string,
  chainArtistIds: Set<string>,
  deadlineMs: number
): Promise<{
  recs: RecWithVerified[]
  proposedByLLM: number
  verifiedOnSpotify: number
  droppedAsDuplicate: number
  droppedByDiversity: number
  supplemented: boolean
}> {
  const state = newFilterState(seedTrackId)
  const first = await verifyBatch(llm.tracks, state, chainArtistIds)
  const recs = [...first.accepted]
  const stats = {
    proposedByLLM: first.proposed,
    verifiedOnSpotify: first.verified,
    droppedAsDuplicate: first.droppedAsDuplicate,
    droppedByDiversity: first.droppedByDiversity,
    supplemented: false,
  }

  // Which high-value categories ended up empty after verify?
  const countByCat = (cat: Category) =>
    recs.filter((r) => r.category === cat).length
  const deficits = SUPPLEMENT_TARGET_CATEGORIES.filter(
    (t) => countByCat(t.category) === 0
  )
  if (deficits.length === 0) {
    return { recs, ...stats }
  }

  // Only spend the second Sonnet call if there's headroom before the hard cap.
  const remaining = deadlineMs - Date.now()
  if (remaining < SUPPLEMENT_MIN_HEADROOM_MS) {
    console.log(
      `[curate] verify-gap: ${deficits
        .map((d) => d.category)
        .join('+')} empty but only ${remaining}ms left — skipping supplement`
    )
    return { recs, ...stats }
  }
  console.log(
    `[curate] verify-gap: ${deficits
      .map((d) => d.category)
      .join('+')} empty — supplementing`
  )

  const supplement = await supplementKinship({
    ctx,
    deficits,
    avoid: llm.tracks.map((t) => ({ artist: t.artist, track: t.track })),
  })
  if (supplement.tracks.length === 0) {
    return { recs, ...stats }
  }

  const second = await verifyBatch(supplement.tracks, state, chainArtistIds)
  recs.push(...second.accepted)
  stats.proposedByLLM += second.proposed
  stats.verifiedOnSpotify += second.verified
  stats.droppedAsDuplicate += second.droppedAsDuplicate
  stats.droppedByDiversity += second.droppedByDiversity
  stats.supplemented = second.accepted.length > 0

  return { recs, ...stats }
}

// ---------------------------------------------------------------------------
// Persist
// ---------------------------------------------------------------------------

async function saveCuration(args: {
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
        userId: LOCAL_USER,
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
 * final safety net before the platform itself kills the function. With Fluid
 * Compute the platform cap is 300s and the chat route caps at 110s, so this
 * sits at 100s — comfortably inside both, while giving the full
 * first-call + schema-retry + supplement path room to finish instead of being
 * cut off mid-flight (the old 45s cap was the real cause of the 1-minute
 * timeouts: a normal 30s Sonnet call + one retry already blew past it).
 * Anything still running when this fires is reported as `llm_failed` (the most
 * common cause) so the chat UI shows a typed error instead of a generic 504.
 */
const RUN_CURATION_HARD_CAP_MS = 100_000

export async function runCuration(args: {
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
    query: string | null
    seed: CurationSeedInput
    parentCurationId?: number | null
  },
  t0: number
): Promise<CurateResult> {
  // Capture each phase's duration so the TOTAL line can print a single
  // breakdown (seed/ctx/sonnet/verify/save) — the fastest way to read, in
  // production logs, exactly which phase dominates a slow curation. Sonnet is
  // expected to be the bulk; the breakdown makes any surprise (e.g. verify
  // ballooning on a rate-limit) obvious without grepping separate lines.
  const dur: Record<string, number> = {}
  const lap = (name: string, start: number) => {
    const ms = Date.now() - start
    dur[name] = ms
    console.log(`[curate] ${name} ${ms}ms`)
  }

  try {
    await ensureLocalUser()

    const tSeed = Date.now()
    const seed = await resolveSeed(args.seed)
    lap('resolveSeed', tSeed)
    if (!seed) {
      return {
        ok: false,
        code: 'seed_not_found',
        message: '시드 곡을 찾지 못했어요.',
      }
    }

    const tCtx = Date.now()
    const [ctx, chainCtx] = await Promise.all([
      buildSeedContext(seed),
      args.parentCurationId
        ? collectChainContext(args.parentCurationId)
        : Promise.resolve({
            chainArtistIds: new Set<string>(),
            ancestorIds: [],
          }),
    ])
    lap('buildSeedContext+chain (parallel)', tCtx)

    let llm: KinshipResponse
    const tLlm = Date.now()
    try {
      llm = await recommendKinship(ctx, t0 + RUN_CURATION_HARD_CAP_MS)
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
    const { recs, supplemented, ...stats } = await verifyAndFilter(
      llm,
      ctx,
      seed.trackId,
      chainCtx.chainArtistIds,
      t0 + RUN_CURATION_HARD_CAP_MS
    )
    lap('verifyAndFilter', tVerify)
    if (supplemented) console.log('[curate] supplement added tracks')

    if (recs.length === 0) {
      return {
        ok: false,
        code: 'all_dropped',
        message: '추천 후보가 모두 검증/필터에서 제외됐어요.',
      }
    }

    const tSave = Date.now()
    const curationId = await saveCuration({
      query: args.query,
      seedTrackId: seed.trackId,
      parentCurationId: args.parentCurationId ?? null,
      lineageNotes: llm.lineage_notes,
      recs,
    })
    lap('saveCuration', tSave)
    const total = Date.now() - t0
    const sonnetMs = dur['recommendKinship (Sonnet)'] ?? 0
    const sonnetPct = total > 0 ? Math.round((sonnetMs / total) * 100) : 0
    console.log(
      `[curate] TOTAL ${total}ms ` +
        `[seed=${dur['resolveSeed'] ?? 0} ` +
        `ctx=${dur['buildSeedContext+chain (parallel)'] ?? 0} ` +
        `sonnet=${sonnetMs}(${sonnetPct}%) ` +
        `verify=${dur['verifyAndFilter'] ?? 0} ` +
        `save=${dur['saveCuration'] ?? 0}]`
    )

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
        coverUrl: r.coverUrl,
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
