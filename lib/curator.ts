import { eq, inArray } from 'drizzle-orm'
import { db } from '@/db/client'
import { artists, curationTracks, curations, tracks } from '@/db/schema'
import { getArtistTopTags, getTrackTopTags } from './lastfm'
import { auditKinshipLeaps } from './leap'
import { LOCAL_USER, ensureLocalUser } from './localUser'
import type { PipelineStatsV1 } from './pipelineStats'
import {
  CATEGORIES,
  recommendKinship,
  supplementKinship,
  type Category,
  type KinshipResponse,
  type SeedContext,
  type SupplementVerifyFailure,
  type TrackRec,
} from './kinship'
import {
  getArtist,
  getTrack,
  searchOneTrack,
  verifyTrack,
  VERIFY_FAIL_REASONS,
  type VerifiedTrack,
} from './spotify/catalog'
import {
  SpotifyAuthError,
  SpotifyClientError,
  SpotifyRateLimitError,
  SpotifyServerError,
} from './spotify/errors'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CurationSeedInput =
  | { type: 'track_id'; track_id: string }
  | {
      type: 'track_text'
      track_query: string
      /** intent가 아티스트/제목 경계를 확실히 안 경우만 — 시드 해석의
       * 필드필터 tier를 활성화 (미스 시 free-text 폴백). */
      artist_hint?: string
      track_hint?: string
    }

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
    // Spotify infra failures (429/5xx/timeout, after one retry) — tracked
    // separately so a rate-limit burst never reads as "the LLM hallucinated".
    droppedByInfra: number
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
    const hit = await searchOneTrack(input.track_query, {
      artistHint: input.artist_hint,
      trackHint: input.track_hint,
    })
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

  // "shoegaze(100), dream pop(85)" — Last.fm counts are relative weights
  // (top tag = 100). Passing them lets Sonnet tell a seed's dominant signal
  // from tail noise instead of reading all tags as equal.
  const withWeight = (t: { name: string; count: number }) =>
    t.count > 0 ? `${t.name}(${t.count})` : t.name

  return {
    track: {
      name: seed.name,
      artist: seed.artistName,
      album: seed.album,
      year: seed.year,
    },
    spotifyGenres: artist?.genres ?? [],
    lastfmTrackTags: trackTags.map(withWeight),
    lastfmArtistTags: artistTags.map(withWeight),
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
async function collectChainContext(parentCurationId: number): Promise<{
  chainArtistIds: Set<string>
  chainArtistNames: string[]
  /** 직전(최대 2개) 조상의 "『시드명』 → lineage_notes 첫 문장" — 여정 연속성
   * 힌트로 프롬프트에 들어간다. 항상 가장 가까운 조상 기준이므로 체인이
   * 3스텝 이상이면 루트는 자연히 밀려난다 (1-hop 체인에서는 부모가 곧
   * 루트라 그 내러티브가 정확히 직전 스텝이다 — 의도된 동작). */
  chainNarrative: string[]
  /** 최근(≤3) 조상에서 과다 사용된 link_dimensions — "vocal_style(5), mood(3)"
   * 형태. 프롬프트 1줄 권고용(금지 아님). 수락된 픽 기준이라 verify 탈락분은
   * 안 보임 — 목적이 "사용자에게 보인 체인의 반복감 완화"라 accepted-only가 맞다. */
  chainAxisHint: string | null
  ancestorIds: number[]
}> {
  type AncestorRow = {
    id: number
    seedTrackId: string
    parentId: number | null
    userId: string
    lineageNotes: string | null
  }
  const chain: {
    id: number
    seedTrackId: string
    lineageNotes: string | null
  }[] = []
  let curId: number | null = parentCurationId
  let hops = 0
  while (curId !== null && hops < 50) {
    const row: AncestorRow[] = await db
      .select({
        id: curations.id,
        seedTrackId: curations.seedTrackId,
        parentId: curations.parentCurationId,
        userId: curations.userId,
        lineageNotes: curations.lineageNotes,
      })
      .from(curations)
      .where(eq(curations.id, curId))
      .limit(1)
    const r: AncestorRow | undefined = row[0]
    if (!r) break
    if (r.userId !== LOCAL_USER) break // security guard
    chain.unshift({
      id: r.id,
      seedTrackId: r.seedTrackId,
      lineageNotes: r.lineageNotes,
    })
    curId = r.parentId ?? null
    hops++
  }
  if (chain.length === 0) {
    return {
      chainArtistIds: new Set(),
      chainArtistNames: [],
      chainNarrative: [],
      chainAxisHint: null,
      ancestorIds: [],
    }
  }

  const curationIds = chain.map((c) => c.id)
  const seedTrackIds = chain.map((c) => c.seedTrackId)

  const [recArtistRows, seedArtistRows] = await Promise.all([
    db
      .select({
        artistId: tracks.artistId,
        curationId: curationTracks.curationId,
        linkDimensions: curationTracks.linkDimensions,
      })
      .from(curationTracks)
      .innerJoin(tracks, eq(curationTracks.trackId, tracks.id))
      .where(inArray(curationTracks.curationId, curationIds)),
    db
      .select({ id: tracks.id, artistId: tracks.artistId, name: tracks.name })
      .from(tracks)
      .where(inArray(tracks.id, seedTrackIds)),
  ])

  const seedRowMap = new Map(seedArtistRows.map((r) => [r.id, r]))
  const rootSeedArtistId =
    seedRowMap.get(chain[0].seedTrackId)?.artistId ?? null

  const chainArtistIds = new Set<string>()
  for (const r of recArtistRows) chainArtistIds.add(r.artistId)
  for (const seedTrackId of seedTrackIds) {
    const aid = seedRowMap.get(seedTrackId)?.artistId
    if (aid) chainArtistIds.add(aid)
  }
  if (rootSeedArtistId) chainArtistIds.delete(rootSeedArtistId)

  // Journey narrative: last (up to) 2 ancestors, "『seed』 → first sentence of
  // its lineage_notes" hard-truncated. Null/empty notes are skipped.
  const firstSentence = (s: string): string => {
    const line = s.split('\n')[0] ?? ''
    const m = line.match(/^.*?[.!?。…]/)
    const sent = (m ? m[0] : line).trim()
    return sent.length > 120 ? `${sent.slice(0, 117)}…` : sent
  }
  const chainNarrative = chain.slice(-2).flatMap((c) => {
    const seedName = seedRowMap.get(c.seedTrackId)?.name
    const notes = c.lineageNotes?.trim()
    return seedName && notes
      ? [`『${seedName}』 → ${firstSentence(notes)}`]
      : []
  })

  // Axis distribution over the recent (≤3) ancestors — same recency logic as
  // the narrative (short chains may include the root; intended). Only axes
  // used twice or more count as "overused"; top 3 shown.
  const recentIds = new Set(curationIds.slice(-3))
  const axisCount = new Map<string, number>()
  for (const r of recArtistRows) {
    if (!recentIds.has(r.curationId)) continue
    for (const d of r.linkDimensions) {
      axisCount.set(d, (axisCount.get(d) ?? 0) + 1)
    }
  }
  const overused = [...axisCount.entries()]
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
  const chainAxisHint =
    overused.length > 0
      ? overused.map(([d, c]) => `${d}(${c})`).join(', ')
      : null

  // Names too: IDs are for the post-verify hard drop, names go into the
  // Sonnet prompt so it stops proposing chain artists in the first place
  // (each such proposal used to waste a recommendation slot). Every chain
  // artistId has an artists row (tracks.artist_id is a FK).
  const nameRows =
    chainArtistIds.size > 0
      ? await db
          .select({ name: artists.name })
          .from(artists)
          .where(inArray(artists.id, [...chainArtistIds]))
      : []
  const chainArtistNames = nameRows.map((r) => r.name)

  return {
    chainArtistIds,
    chainArtistNames,
    chainNarrative,
    chainAxisHint,
    ancestorIds: curationIds,
  }
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

// Cap concurrent Spotify verify searches. Promise.all over 7-12 recs used to
// fire them all at once (twice per curation when the supplement pass runs) —
// exactly the burst shape that trips 429s. 4 keeps the batch gentle while
// still finishing ~10 verifies in 3 waves.
const VERIFY_CONCURRENCY = 4
// One short backoff before retrying a verify whose *infrastructure* failed
// (429/5xx/timeout). Metadata mismatches never retry.
const VERIFY_INFRA_RETRY_DELAY_MS = 2_000

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Run `fn` over items with bounded concurrency, preserving result order. */
async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (true) {
        const i = next++
        if (i >= items.length) return
        results[i] = await fn(items[i])
      }
    }
  )
  await Promise.all(workers)
  return results
}

// Retryable = the Spotify call itself failed transiently (rate limit / 5xx /
// per-request timeout / network). Auth and 4xx errors are deterministic —
// retrying them just burns budget.
function isRetryableInfra(err: unknown): boolean {
  if (err instanceof SpotifyRateLimitError) return true
  if (err instanceof SpotifyServerError) return true
  if (err instanceof TypeError) return true // fetch network failure
  if (err instanceof DOMException) {
    return err.name === 'TimeoutError' || err.name === 'AbortError'
  }
  return false
}

type VerifyOutcome =
  | { llm: TrackRec; v: VerifiedTrack; canonicalized?: 'album' | 'year' }
  | { llm: TrackRec; fail: SupplementVerifyFailure }
  | { llm: TrackRec; infra: true }

type FailSample = NonNullable<
  PipelineStatsV1['verify']['failSamples']
>[number]

/**
 * Verify a batch of LLM track recs against Spotify, then dedupe + diversify
 * against the shared `state` (which accumulates across passes). Returns the
 * accepted recs, the per-track verify failures (fed to the supplement prompt
 * so Sonnet can fix its metadata), and per-pass stats. `state` is mutated in
 * place.
 *
 * Infra failures (429/5xx/timeout) are retried once after a short backoff and
 * counted separately — a rate-limit burst must never read as "the LLM made
 * this track up".
 *
 * Dedupe drops: the seed itself, anything already accepted this curation, a
 * track the LLM proposed twice, and (on a digging-chain step) artists already
 * surfaced higher in the chain. Diversity caps: 1 per artist per category,
 * 2 per artist overall. No user library to exclude against in login-less mode.
 */
// Per-pass observability aggregates, persisted (merged across passes) into
// curations.pipeline_stats. Zero-initialized over the full key space so a new
// reason/category can't be silently missing from stored data.
type VerifyBreakdown = {
  failuresByReason: PipelineStatsV1['verify']['failuresByReason']
  byCategory: PipelineStatsV1['verify']['byCategory']
  canonicalized: { album: number; year: number }
}

function newVerifyBreakdown(): VerifyBreakdown {
  return {
    failuresByReason: Object.fromEntries(
      VERIFY_FAIL_REASONS.map((r) => [r, 0])
    ) as VerifyBreakdown['failuresByReason'],
    byCategory: Object.fromEntries(
      CATEGORIES.map((c) => [c, { proposed: 0, accepted: 0 }])
    ) as VerifyBreakdown['byCategory'],
    canonicalized: { album: 0, year: 0 },
  }
}

function mergeVerifyBreakdown(into: VerifyBreakdown, from: VerifyBreakdown) {
  for (const r of VERIFY_FAIL_REASONS) {
    into.failuresByReason[r] += from.failuresByReason[r]
  }
  for (const c of CATEGORIES) {
    into.byCategory[c].proposed += from.byCategory[c].proposed
    into.byCategory[c].accepted += from.byCategory[c].accepted
  }
  into.canonicalized.album += from.canonicalized.album
  into.canonicalized.year += from.canonicalized.year
}

async function verifyBatch(
  recs: TrackRec[],
  state: FilterState,
  chainArtistIds: Set<string>,
  signal?: AbortSignal,
  deadlineMs?: number,
  // failSamples의 pass 라벨 — 1차인지 보충 재검증인지 사후 분석에서 구분.
  pass: 'first' | 'supplement' = 'first'
): Promise<{
  accepted: RecWithVerified[]
  failures: SupplementVerifyFailure[]
  failSamples: FailSample[]
  breakdown: VerifyBreakdown
  proposed: number
  verified: number
  droppedAsDuplicate: number
  droppedByDiversity: number
  droppedByInfra: number
}> {
  const outcomes = await mapPool(
    recs,
    VERIFY_CONCURRENCY,
    async (t): Promise<VerifyOutcome> => {
      const attempt = () =>
        verifyTrack(
          { artist: t.artist, track: t.track, album: t.album, year: t.year },
          { signal, deadlineMs }
        )
      const asFail = (r: {
        reason: SupplementVerifyFailure['reason']
        nearest?: SupplementVerifyFailure['nearest']
      }): VerifyOutcome => ({
        llm: t,
        fail: {
          artist: t.artist,
          track: t.track,
          reason: r.reason,
          nearest: r.nearest,
        },
      })
      try {
        const r = await attempt()
        return r.ok
          ? { llm: t, v: r.track, canonicalized: r.canonicalized }
          : asFail(r)
      } catch (err) {
        // Auth failure is systemic (bad credentials) — every track would
        // "infra-drop" and the curation would masquerade as all_dropped.
        // Fail the whole curation honestly instead (caught as `unknown`).
        if (err instanceof SpotifyAuthError) throw err
        // A 4xx is deterministic for this one query (e.g. a track title that
        // breaks the field-filter syntax) — retrying won't help, but it's not
        // a Spotify outage either. Treat as "couldn't verify this track" so
        // the supplement gets a chance to replace it.
        if (err instanceof SpotifyClientError) {
          return asFail({ reason: 'not_found' })
        }
        // A full retry can cost up to another multi-tier verify — only spend
        // it when the budget clearly allows (15s = backoff + one worst-case
        // request + slack).
        const retryRunway =
          deadlineMs === undefined || deadlineMs - Date.now() > 15_000
        if (!signal?.aborted && retryRunway && isRetryableInfra(err)) {
          await sleep(VERIFY_INFRA_RETRY_DELAY_MS)
          if (!signal?.aborted) {
            try {
              const r = await attempt()
              return r.ok
                ? { llm: t, v: r.track, canonicalized: r.canonicalized }
                : asFail(r)
            } catch {
              // fall through to infra
            }
          }
        }
        return { llm: t, infra: true }
      }
    }
  )

  const verified = outcomes.filter(
    (o): o is { llm: TrackRec; v: VerifiedTrack } => 'v' in o
  )
  const failures = outcomes.flatMap((o) => ('fail' in o ? [o.fail] : []))
  // 탈락 표본: 주장 튜플(LLM 원문) + 사유 + 최근접 — pipeline_stats로 영속.
  const failSamples: FailSample[] = outcomes.flatMap((o) =>
    'fail' in o
      ? [
          {
            pass,
            category: o.llm.category,
            artist: o.llm.artist,
            track: o.llm.track,
            album: o.llm.album,
            year: o.llm.year,
            reason: o.fail.reason,
            ...(o.fail.nearest ? { nearest: o.fail.nearest } : {}),
          },
        ]
      : []
  )
  const droppedByInfra = outcomes.filter((o) => 'infra' in o).length

  const breakdown = newVerifyBreakdown()
  for (const t of recs) breakdown.byCategory[t.category].proposed++
  for (const f of failures) breakdown.failuresByReason[f.reason]++
  for (const o of outcomes) {
    if ('v' in o && o.canonicalized) breakdown.canonicalized[o.canonicalized]++
  }

  const accepted: RecWithVerified[] = []
  let droppedAsDuplicate = 0
  let droppedByDiversity = 0

  for (const r of verified) {
    // Chain exclusion checks EVERY credit, not just the matched one — a
    // collab whose first credit is a chain artist must not sneak back in
    // under its second credit's name. Diversity caps below stay on the
    // matched credit (the artist the LLM meant).
    const inChain = r.v.allArtistIds.some((id) => chainArtistIds.has(id))
    if (state.seenIds.has(r.v.id) || inChain) {
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
    breakdown.byCategory[cat].accepted++
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
    failures,
    failSamples,
    breakdown,
    proposed: recs.length,
    verified: verified.length,
    droppedAsDuplicate,
    droppedByDiversity,
    droppedByInfra,
  }
}

// Categories we top up when verify leaves them BELOW their schema floor (not
// just at zero — see verifyAndFilter). `want` mirrors KinshipResponseSchema's
// per-category floor so a curation never ships under it:
//   - influence anchors the lineage
//   - descendant is the seed's forward generation (was previously not topped
//     up at all, which let it ship at 0)
//   - kinship is the whole product and the one most often thinned by verify
//     drops landing it at 1 (under its floor of 2) — the case the old
//     `=== 0` trigger silently missed.
// peer is excluded as a STANDALONE trigger only: a thin peer isn't worth a
// second round-trip. But when the core categories already force a supplement
// call, peer's shortfall piggybacks on it for free (see verifyAndFilter).
// `want` here must stay in lockstep with the zod floor.
const SUPPLEMENT_TARGET_CATEGORIES: { category: Category; want: number }[] = [
  { category: 'influence', want: 2 },
  { category: 'descendant', want: 1 },
  { category: 'kinship', want: 2 },
]
// peer's zod floor — used only for the piggyback top-up above.
const PEER_FLOOR = 2

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
  deadlineMs: number,
  signal?: AbortSignal
): Promise<{
  recs: RecWithVerified[]
  proposedByLLM: number
  verifiedOnSpotify: number
  droppedAsDuplicate: number
  droppedByDiversity: number
  droppedByInfra: number
  supplemented: boolean
  /** Observability detail persisted into curations.pipeline_stats — the flat
   * fields above stay the (unchanged) API contract. */
  pipeline: {
    verify: PipelineStatsV1['verify']
    supplement: PipelineStatsV1['supplement']
    /** LEAP_PHASE_B=1일 때만: 1차 verify 직후 감사 결과 (플래그 off면 감사가
     * runCurationInner의 최종 recs 단계에서 돌므로 여기 없음). */
    leap?: PipelineStatsV1['leap']
    phaseB?: PipelineStatsV1['phaseB']
  }
  /** verifyAndFilter 내부 단계 분해 — timings의 optional 키로 저장된다. */
  timingBreakdown: {
    verifyFirst: number
    supplementSonnet?: number
    supplementVerify?: number
  }
}> {
  const state = newFilterState(seedTrackId)
  const tFirst = Date.now()
  const first = await verifyBatch(
    llm.tracks,
    state,
    chainArtistIds,
    signal,
    deadlineMs,
    'first'
  )
  const timingBreakdown: {
    verifyFirst: number
    supplementSonnet?: number
    supplementVerify?: number
  } = { verifyFirst: Date.now() - tFirst }
  const failSamplesAll: FailSample[] = [...first.failSamples]
  const recs = [...first.accepted]
  const stats = {
    proposedByLLM: first.proposed,
    verifiedOnSpotify: first.verified,
    droppedAsDuplicate: first.droppedAsDuplicate,
    droppedByDiversity: first.droppedByDiversity,
    droppedByInfra: first.droppedByInfra,
    supplemented: false,
  }
  // Mutated in place if a supplement pass merges in.
  const breakdown = first.breakdown
  let firstPassLeap: PipelineStatsV1['leap']
  let phaseB: PipelineStatsV1['phaseB']
  const mkPipeline = (supplement: PipelineStatsV1['supplement']) => ({
    verify: {
      proposed: stats.proposedByLLM,
      verified: stats.verifiedOnSpotify,
      failuresByReason: breakdown.failuresByReason,
      droppedAsDuplicate: stats.droppedAsDuplicate,
      droppedByDiversity: stats.droppedByDiversity,
      droppedByInfra: stats.droppedByInfra,
      byCategory: breakdown.byCategory,
      canonicalized: breakdown.canonicalized,
      ...(failSamplesAll.length > 0
        ? { failSamples: failSamplesAll.slice(0, 12) }
        : {}),
    },
    supplement,
    ...(firstPassLeap ? { leap: firstPassLeap } : {}),
    ...(phaseB ? { phaseB } : {}),
  })

  // leap Phase B(B0): 1차 verify 직후 kinship 픽을 감사해 weak_leap을
  // floor 계산에서만 제외한다(픽 유지 — 비파괴). 감사 실패/타임아웃/스킵이면
  // 제외 없이 기존 계산으로 진행 (ok verdicts만 집행 근거).
  // 총곡수 정책: 캡 없음 — B0의 추가분은 kinship floor(2)로 유계 (docs §7.5).
  const weakTrackIds = new Set<string>()
  const weakLeapNotes: string[] = []
  if (isLeapPhaseBEnabled()) {
    firstPassLeap = await runLeapAudit({
      seedYear: ctx.track.year,
      seedVocab: [
        ...ctx.spotifyGenres,
        ...ctx.lastfmTrackTags,
        ...ctx.lastfmArtistTags,
      ],
      picks: recs.filter((r) => r.category === 'kinship'),
      headroomMs: deadlineMs - Date.now(),
      minHeadroomMs: PHASE_B_AUDIT_MIN_HEADROOM_MS,
      signal,
    })
    if (firstPassLeap?.status === 'ok') {
      for (const v of firstPassLeap.verdicts ?? []) {
        if (v.verdict === 'weak_leap') {
          weakTrackIds.add(v.trackId)
          weakLeapNotes.push(`${v.artistName} — ${v.trackName}`)
        }
      }
      if (weakTrackIds.size > 0) {
        phaseB = { weakExcluded: weakTrackIds.size, supplementAudited: false }
        console.log(
          `[leap] phase-b: ${weakTrackIds.size} weak kinship pick(s) excluded from floor`
        )
      }
    }
  }

  // Which high-value categories ended up BELOW their floor after verify?
  // (Not just empty: a kinship that landed 1 verified track is still under
  // its floor of 2 and must be topped up — the old `=== 0` check missed this
  // and let under-floor curations ship.) `want` carries how many MORE we need.
  // B0에서는 weak_leap 픽이 kinship 유효 수에서 빠진다 (픽 자체는 recs에 유지).
  const countByCat = (cat: Category) =>
    recs.filter(
      (r) =>
        r.category === cat &&
        !(cat === 'kinship' && weakTrackIds.has(r.trackId))
    ).length
  const deficits = SUPPLEMENT_TARGET_CATEGORIES.map((t) => ({
    category: t.category,
    want: t.want - countByCat(t.category),
  })).filter((d) => d.want > 0)
  if (deficits.length === 0) {
    return {
      recs,
      ...stats,
      pipeline: mkPipeline({ attempted: false, skippedReason: 'no_deficit' }),
      timingBreakdown,
    }
  }

  // Peer piggyback: a peer-only shortfall never triggers a supplement, but
  // since the core categories are already forcing this round-trip, topping
  // peer up in the SAME call costs nothing extra (max_tokens was raised to
  // 1600 in kinship.ts to fit the worst case).
  const peerShort = PEER_FLOOR - countByCat('peer')
  if (peerShort > 0) {
    deficits.push({ category: 'peer', want: peerShort })
  }

  const deficitLabel = deficits
    .map((d) => `${d.category}(-${d.want})`)
    .join('+')

  // Only spend the second Sonnet call if there's headroom before the hard cap.
  const remaining = deadlineMs - Date.now()
  if (remaining < SUPPLEMENT_MIN_HEADROOM_MS) {
    console.log(
      `[curate] verify-gap: ${deficitLabel} under floor but only ${remaining}ms left — skipping supplement`
    )
    return {
      recs,
      ...stats,
      pipeline: mkPipeline({
        attempted: false,
        skippedReason: 'headroom',
        deficits,
      }),
      timingBreakdown,
    }
  }
  console.log(`[curate] verify-gap: ${deficitLabel} under floor — supplementing`)

  // 과잉 요청: 보충분도 verify에서 깎이므로 결핍보다 1곡 여유(상한 3)를
  // 요청한다. floor/게이트/라벨 판단은 원 deficits, 프롬프트·stats.requested만
  // 이 값 — 분리하지 않으면 결핍 규모 분석이 부푼다.
  const requested = deficits.map((d) => ({
    category: d.category,
    want: Math.min(d.want + 1, 3),
  }))

  const tSup = Date.now()
  const supplement = await supplementKinship({
    ctx,
    deficits: requested,
    avoid: llm.tracks.map((t) => ({ artist: t.artist, track: t.track })),
    // First-pass drop reasons: lets Sonnet correct album/year typos (those
    // re-submissions are allowed through the avoid list) instead of guessing
    // blind. Infra failures are deliberately NOT in here.
    verifyFailures: first.failures,
    ...(weakLeapNotes.length > 0 ? { weakLeapNotes } : {}),
    signal,
  })
  timingBreakdown.supplementSonnet = Date.now() - tSup
  if (supplement.tracks.length === 0) {
    return {
      recs,
      ...stats,
      pipeline: mkPipeline({
        attempted: true,
        deficits,
        requested,
        added: 0,
        outcome: supplement.outcome,
        rawReturned: supplement.rawReturned,
      }),
      timingBreakdown,
    }
  }

  const tSupVerify = Date.now()
  const second = await verifyBatch(
    supplement.tracks,
    state,
    chainArtistIds,
    signal,
    deadlineMs,
    'supplement'
  )
  timingBreakdown.supplementVerify = Date.now() - tSupVerify
  failSamplesAll.push(...second.failSamples)
  recs.push(...second.accepted)
  stats.proposedByLLM += second.proposed
  stats.verifiedOnSpotify += second.verified
  stats.droppedAsDuplicate += second.droppedAsDuplicate
  stats.droppedByDiversity += second.droppedByDiversity
  stats.droppedByInfra += second.droppedByInfra
  stats.supplemented = second.accepted.length > 0
  mergeVerifyBreakdown(breakdown, second.breakdown)

  return {
    recs,
    ...stats,
    pipeline: mkPipeline({
      attempted: true,
      deficits,
      requested,
      added: second.accepted.length,
      outcome: supplement.outcome,
      rawReturned: supplement.rawReturned,
    }),
    timingBreakdown,
  }
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
  pipelineStats: PipelineStatsV1
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
        pipelineStats: args.pipelineStats,
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

// Kinship-leap audit (Phase A, log-only) budget: hard 5s race so the audit
// can never delay the save meaningfully, and it only runs at all when at
// least 8s remain before the curation hard cap.
const LEAP_AUDIT_TIMEOUT_MS = 5_000
const LEAP_AUDIT_MIN_HEADROOM_MS = 8_000

// leap Phase B(B0): default-off. LEAP_PHASE_B=1이면 감사가 1차 verify 직후로
// 이동하고, weak_leap 픽이 kinship floor 계산에서만 제외된다(카테고리 무변경 —
// 비파괴. peer 재분류는 B1로 보류). 보충이 추가한 kinship 픽은 미감사
// (pipeline_stats.phaseB.supplementAudited=false로 명시 기록). 캘리브레이션
// 리포트로 카나리아를 확인하기 전에는 켜지 말 것 (docs §7.5).
// 함수인 이유: 모듈 상수로 두면 스크립트(러너)의 정적 import가 호이스팅되어
// process.loadEnvFile('.env.local')보다 먼저 평가되고, .env.local의
// LEAP_PHASE_B가 영영 무시된다.
const isLeapPhaseBEnabled = () => process.env.LEAP_PHASE_B === '1'
// B0 감사(≤5s)가 보충 헤드룸(38s)과 직렬이 되므로 합산 게이트.
const PHASE_B_AUDIT_MIN_HEADROOM_MS = 43_000

/**
 * Shared leap-audit wrapper: Phase A(플래그 off — 최종 recs 대상)와 B0(플래그
 * on — 1차 verify 직후 대상)가 같은 로직을 쓴다. Budget-gated + 5s race,
 * 절대 throw하지 않으며, 감사할 픽이 없으면 undefined(leap 필드 생략).
 */
async function runLeapAudit(args: {
  seedYear: number
  seedVocab: string[]
  picks: RecWithVerified[]
  headroomMs: number
  minHeadroomMs: number
  signal?: AbortSignal
}): Promise<PipelineStatsV1['leap']> {
  const { seedYear, seedVocab, picks, headroomMs, minHeadroomMs, signal } = args
  if (picks.length === 0) return undefined
  if (signal?.aborted || headroomMs <= minHeadroomMs) {
    return { status: 'skipped' }
  }
  const tLeap = Date.now()
  try {
    const verdicts = await Promise.race([
      auditKinshipLeaps({
        seedYear,
        seedVocab,
        picks: picks.map((r) => ({
          trackId: r.trackId,
          artistId: r.artistId,
          artistName: r.artistName,
          trackName: r.trackName,
          year: r.year,
          linkDimensions: r.link_dimensions,
        })),
      }),
      sleep(LEAP_AUDIT_TIMEOUT_MS).then(() => null),
    ])
    if (!verdicts) {
      console.log(
        `[leap] audit timed out after ${Date.now() - tLeap}ms — skipped`
      )
      return { status: 'timeout' }
    }
    for (const v of verdicts) {
      console.log(
        `[leap] kinship "${v.artistName} — ${v.trackName}" Δyear=${
          v.deltaYear ?? '?'
        } overlap=[${v.overlap.join(', ')}] dims=[${v.dims.join(', ')}] → ${
          v.verdict
        } (${Date.now() - tLeap}ms)`
      )
    }
    return { status: 'ok', verdicts }
  } catch (err) {
    console.log(
      `[leap] audit failed — skipped (${
        err instanceof Error ? err.message : String(err)
      })`
    )
    return { status: 'failed' }
  }
}

export async function runCuration(args: {
  query: string | null
  seed: CurationSeedInput
  parentCurationId?: number | null
  /** 사용자가 명시적으로 조향한 깊이 (intent.depth). 부재 → mixed 유지. */
  depth?: 'mainstream' | 'balanced' | 'deep'
}): Promise<CurateResult> {
  const start = Date.now()
  // The race alone never *cancelled* anything: after the cap resolved
  // llm_failed, the inner work kept running — more Sonnet/Spotify calls and
  // eventually a DB save the user never saw (an orphan curation in history).
  // Now the cap also aborts, and the signal reaches every downstream call
  // plus a gate in front of saveCuration.
  const controller = new AbortController()
  let capTimer: ReturnType<typeof setTimeout> | undefined
  const hardCap = new Promise<CurateResult>((resolve) => {
    capTimer = setTimeout(() => {
      controller.abort(
        new Error(`curation exceeded ${RUN_CURATION_HARD_CAP_MS}ms (hard cap)`)
      )
      resolve({
        ok: false,
        code: 'llm_failed',
        message: `curation exceeded ${RUN_CURATION_HARD_CAP_MS}ms (hard cap)`,
      })
    }, RUN_CURATION_HARD_CAP_MS)
  })
  const work = runCurationInner(args, start, controller.signal)
  try {
    return await Promise.race([work, hardCap])
  } finally {
    clearTimeout(capTimer)
  }
}

async function runCurationInner(
  args: {
    query: string | null
    seed: CurationSeedInput
    parentCurationId?: number | null
    depth?: 'mainstream' | 'balanced' | 'deep'
  },
  t0: number,
  signal: AbortSignal
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
            chainArtistNames: [] as string[],
            chainNarrative: [] as string[],
            chainAxisHint: null as string | null,
            ancestorIds: [] as number[],
          }),
    ])
    // Chain artists go into the prompt as a hard avoid-list (they'd be
    // dropped in verify anyway — don't let Sonnet waste slots on them).
    if (chainCtx.chainArtistNames.length > 0) {
      ctx.chainAvoidArtists = chainCtx.chainArtistNames
    }
    // Journey narrative from the immediate ancestors — continuity hint only,
    // the current seed always wins (the prompt says so explicitly).
    if (chainCtx.chainNarrative.length > 0) {
      ctx.chainNarrative = chainCtx.chainNarrative
    }
    // Overused-axis advisory from the recent chain (accepted picks only).
    if (chainCtx.chainAxisHint) {
      ctx.chainAxisHint = chainCtx.chainAxisHint
    }
    // User's raw chat text as a steering hint. Digging passes query=null so
    // this naturally drops out. Calibration runs ("[calibration]"-prefixed
    // query) omit userNote ENTIRELY — 마커만 벗겨 넣으면 러너의 인공 문자열
    // ("chain from #N", 시드 반복)이 조향 힌트로 오염된다.
    const isCalibrationRun = args.query?.startsWith('[calibration]') ?? false
    const note = isCalibrationRun ? undefined : args.query?.trim()
    if (note) {
      ctx.userNote = note.length > 200 ? `${note.slice(0, 199)}…` : note
    }
    // Explicit user depth steering (intent.depth) — an EXPLICIT input signal,
    // not a library inference, so it may override the login-less 'mixed'
    // fallback (CLAUDE.md 규약 10). Absent/balanced keeps 'mixed'.
    if (args.depth === 'mainstream') {
      ctx.listenerProfile.librarySophistication = 'mainstream'
    } else if (args.depth === 'deep') {
      ctx.listenerProfile.librarySophistication = 'obscure'
    }
    lap('buildSeedContext+chain (parallel)', tCtx)

    let llm: KinshipResponse
    const tLlm = Date.now()
    try {
      llm = await recommendKinship(ctx, t0 + RUN_CURATION_HARD_CAP_MS, signal)
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
    const { recs, supplemented, pipeline, timingBreakdown, ...stats } =
      await verifyAndFilter(
      llm,
      ctx,
      seed.trackId,
      chainCtx.chainArtistIds,
      t0 + RUN_CURATION_HARD_CAP_MS,
      signal
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

    // Kinship-leap audit — 플래그 off(Phase A): 보충까지 끝난 최종 recs 전체를
    // 감사(log-only, 관측 커버리지 최대). 플래그 on(B0): verifyAndFilter가
    // 1차 verify 직후 이미 감사·집행했으므로 그 결과를 그대로 쓰고 여기서
    // 다시 돌지 않는다 — 보충 추가 kinship 픽 미감사는 B0의 명시적
    // 블라인드스팟(pipeline_stats.phaseB.supplementAudited=false).
    let leapStats: PipelineStatsV1['leap'] = pipeline.leap
    if (!isLeapPhaseBEnabled()) {
      leapStats = await runLeapAudit({
        seedYear: seed.year,
        seedVocab: [
          ...ctx.spotifyGenres,
          ...ctx.lastfmTrackTags,
          ...ctx.lastfmArtistTags,
        ],
        picks: recs.filter((r) => r.category === 'kinship'),
        headroomMs: t0 + RUN_CURATION_HARD_CAP_MS - Date.now(),
        minHeadroomMs: LEAP_AUDIT_MIN_HEADROOM_MS,
        signal,
      })
    }

    // Save gate: if the hard cap already fired, the user has been shown an
    // error — writing the curation now would create an orphan row that
    // appears in history as a ghost. Drop the work instead.
    if (signal.aborted) {
      console.log(
        `[curate] aborted before save (${Date.now() - t0}ms) — skipping DB write`
      )
      return {
        ok: false,
        code: 'llm_failed',
        message: 'curation aborted at save gate (hard cap)',
      }
    }

    // 카테고리 시간축 감사 (log-only, 집행 없음 — leap Phase A 패턴):
    // influence는 시드보다 앞, descendant는 뒤가 정상(±2 슬랙), peer는
    // |Δ|>10만 관측. 순수 인메모리 — 실패할 수 없다.
    let temporalAudit: PipelineStatsV1['categoryTemporalAudit']
    if (seed.year > 0) {
      const t = {
        influenceAfterSeed: 0,
        descendantBeforeSeed: 0,
        peerOutOfEra: 0,
        skippedUnknownYear: 0,
      }
      for (const r of recs) {
        if (r.year === null) {
          t.skippedUnknownYear++
          continue
        }
        if (r.category === 'influence' && r.year > seed.year + 2) {
          t.influenceAfterSeed++
        } else if (r.category === 'descendant' && r.year < seed.year - 2) {
          t.descendantBeforeSeed++
        } else if (r.category === 'peer' && Math.abs(r.year - seed.year) > 10) {
          t.peerOutOfEra++
        }
      }
      temporalAudit = t
      const flagged =
        t.influenceAfterSeed + t.descendantBeforeSeed + t.peerOutOfEra
      if (flagged > 0) {
        console.log(
          `[audit] temporal: influence-after=${t.influenceAfterSeed} descendant-before=${t.descendantBeforeSeed} peer-out-of-era=${t.peerOutOfEra}`
        )
      }
    }

    // Observability payload for curations.pipeline_stats — assembled from
    // material that is all complete by now (verify/supplement detail, leap
    // outcome, phase timings). Pure in-memory work; cannot fail the save.
    const pipelineStats: PipelineStatsV1 = {
      v: 1,
      verify: pipeline.verify,
      supplement: pipeline.supplement,
      ...(leapStats ? { leap: leapStats } : {}),
      ...(temporalAudit ? { categoryTemporalAudit: temporalAudit } : {}),
      ...(pipeline.phaseB ? { phaseB: pipeline.phaseB } : {}),
      timings: {
        seed: dur['resolveSeed'] ?? 0,
        ctx: dur['buildSeedContext+chain (parallel)'] ?? 0,
        sonnet: dur['recommendKinship (Sonnet)'] ?? 0,
        verify: dur['verifyAndFilter'] ?? 0,
        ...timingBreakdown,
      },
    }

    const tSave = Date.now()
    const curationId = await saveCuration({
      query: args.query,
      seedTrackId: seed.trackId,
      parentCurationId: args.parentCurationId ?? null,
      lineageNotes: llm.lineage_notes,
      recs,
      pipelineStats,
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
