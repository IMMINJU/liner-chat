import { spotifyFetch } from './client'
import type {
  SpotifyArtistFull,
  SpotifyPagedResponse,
  SpotifyTrack,
} from './types'
import { upsertArtistsFromTracks, upsertTracks } from './upsert'

/**
 * Catalog-level Spotify helpers shared by the kinship curator.
 * - Search a single track by free-text or artist/track pair.
 * - Get a single track.
 * - Verify a (artist, track, album, year) tuple against Spotify search results,
 *   returning the canonical Spotify track if it really exists.
 *
 * All calls use the app-level (Client Credentials) token — these are public
 * catalog endpoints, so no user login is involved. They auto-upsert the
 * track/artist into our DB so downstream code can reference DB rows.
 */

export type SpotifyTrackWithPopularity = SpotifyTrack & { popularity: number }

function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip combining marks
    .replace(/^(the|a) /i, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * &↔and 표기차 흡수용 **보조** 정규화. 기준 정규화 자체에 &→and를 넣으면
 * "Earth Wind Fire"↔"Earth, Wind & Fire"처럼 &-생략 표기(기존엔 매치)가
 * 회귀한다 — 그래서 기준은 그대로 두고, 비교 지점에서 base쌍 OR and쌍을
 * 나란히 본다(구 동작과 &↔and 수정의 엄격한 상위집합).
 * (+/×/x는 AC/DC·Charli XCX류 위양성 때문에 보류.)
 */
function normalizeForMatchAnd(s: string): string {
  return normalizeForMatch(s.replace(/&/g, ' and '))
}

/** 필드필터 쿼리 값 새니타이즈 — 값 안의 따옴표가 필드 문법을 깨고 400을 낸다. */
const dq = (s: string) => s.replace(/"/g, ' ').trim()

/** "1968-11-22" | "1968-11" | "1968" → 1968 */
function yearOf(date: string | undefined | null): number | null {
  if (!date) return null
  const m = /^(\d{4})/.exec(date)
  return m ? Number(m[1]) : null
}

// Karaoke/tribute factories pollute Spotify search for obscure queries — a
// seed resolved to "Ameritz Karaoke" poisons the whole curation downstream.
// Word patterns only (bare "cover" would false-positive on legit titles like
// "Undercover"). Checked against artist name, album name, and track name.
const SEED_NOISE_RE =
  /\bkaraoke\b|\btribute\b|\bmade famous\b|\bin the style of\b|\b8[- ]?bit\b|\blullaby\b|\bcover version\b|\boriginally performed\b/i

function isNoiseCandidate(c: SpotifyTrackWithPopularity): boolean {
  return (
    SEED_NOISE_RE.test(c.artists[0]?.name ?? '') ||
    SEED_NOISE_RE.test(c.album?.name ?? '') ||
    SEED_NOISE_RE.test(c.name)
  )
}

/**
 * Pick the best seed candidate instead of blindly taking Spotify's top hit:
 * 1. drop karaoke/tribute noise (unless that empties the pool),
 * 2. prefer candidates whose normalized title appears verbatim in the query
 *    (the intent classifier emits "<artist> <track>", so a real title match
 *    beats fuzzy relevance),
 * 3. within those, prefer candidates whose ARTIST also appears in the query —
 *    popularity alone would let a more famous artist's identically-titled
 *    song beat the artist the user actually named ("tame impala elephant"
 *    must not resolve to a bigger act's "Elephant"). Popularity only breaks
 *    ties inside the preferred set,
 * 4. otherwise keep Spotify's own relevance order (first item).
 */
function pickSeedCandidate(
  items: SpotifyTrackWithPopularity[],
  query: string
): SpotifyTrackWithPopularity | null {
  const clean = items.filter((c) => !isNoiseCandidate(c))
  const pool = clean.length > 0 ? clean : items
  const qn = normalizeForMatch(query)
  const qnAnd = normalizeForMatchAnd(query)
  const exact = pool.filter((c) => {
    const title = normalizeForMatch(c.name)
    const titleAnd = normalizeForMatchAnd(c.name)
    return (
      (title.length > 0 && qn.includes(title)) ||
      (titleAnd.length > 0 && qnAnd.includes(titleAnd))
    )
  })
  if (exact.length > 0) {
    // Artist evidence: the full artist phrase appears in the query, or (for
    // multi-word names) at least two substantial tokens do. A single common
    // word is NOT enough — that would misfire on generic-word artist names.
    const artistMatched = exact.filter((c) => {
      const artist = normalizeForMatch(c.artists[0]?.name ?? '')
      if (!artist) return false
      if (qn.includes(artist)) return true
      if (qnAnd.includes(normalizeForMatchAnd(c.artists[0]?.name ?? ''))) {
        return true
      }
      const tokens = artist.split(' ').filter((t) => t.length >= 3)
      return tokens.length >= 2 && tokens.every((t) => qn.includes(t))
    })
    const preferred = artistMatched.length > 0 ? artistMatched : exact
    return preferred.slice().sort((a, b) => b.popularity - a.popularity)[0]
  }
  return pool[0] ?? null
}

/**
 * Search for a single track (seed resolution). Returns the best candidate per
 * pickSeedCandidate, or null.
 *
 * Hint tier: intent가 아티스트/제목 경계를 확실히 안 경우에만 전달하는
 * artist_hint/track_hint가 **둘 다** 있으면 필드필터 검색을 1차로 시도한다
 * (정밀도↑; 픽 쿼리도 힌트 조합을 써서 제목 정확일치 우선순위를 보존).
 * 미스 시 현행 free-text로 폴백 — 오파싱의 최악은 낭비 콜 1회다.
 */
export async function searchOneTrack(
  query: string,
  hints?: { artistHint?: string; trackHint?: string }
): Promise<SpotifyTrackWithPopularity | null> {
  const accept = async (hit: SpotifyTrackWithPopularity) => {
    await upsertArtistsFromTracks([hit])
    await upsertTracks([hit])
    return hit
  }

  if (hints?.artistHint && hints?.trackHint) {
    const fq = `track:"${dq(hints.trackHint)}" artist:"${dq(hints.artistHint)}"`
    const resp = await spotifyFetch<{
      tracks: SpotifyPagedResponse<SpotifyTrackWithPopularity>
    }>(`/v1/search?q=${encodeURIComponent(fq)}&type=track&limit=10`)
    const hit = pickSeedCandidate(
      resp?.tracks.items ?? [],
      `${hints.artistHint} ${hints.trackHint}`
    )
    if (hit) return accept(hit)
    // miss → free-text 폴백
  }

  const q = encodeURIComponent(query)
  // limit 10 (was 5): pickSeedCandidate's noise filter + exact-title +
  // artist-evidence guards do the ranking, so a wider pool only helps —
  // obscure seeds whose canonical version sat at rank 6-10 now resolve.
  const resp = await spotifyFetch<{
    tracks: SpotifyPagedResponse<SpotifyTrackWithPopularity>
  }>(`/v1/search?q=${q}&type=track&limit=10`)
  if (!resp) return null
  const hit = pickSeedCandidate(resp.tracks.items, query)
  if (!hit) return null
  return accept(hit)
}

/** Get a single track including popularity. */
export async function getTrack(
  trackId: string
): Promise<SpotifyTrackWithPopularity | null> {
  const resp = await spotifyFetch<SpotifyTrackWithPopularity>(
    `/v1/tracks/${trackId}`
  )
  return resp ?? null
}

/** Get a single artist's profile (genres etc). */
export async function getArtist(
  artistId: string
): Promise<SpotifyArtistFull | null> {
  return spotifyFetch<SpotifyArtistFull>(`/v1/artists/${artistId}`)
}

/**
 * Batch artist lookup (≤50 ids, one call) — used by the kinship-leap audit to
 * fetch genres for all kinship picks at once. Unknown ids are just absent
 * from the map.
 */
export async function getArtistsBatch(
  artistIds: string[]
): Promise<Map<string, SpotifyArtistFull>> {
  const ids = [...new Set(artistIds)].filter(Boolean).slice(0, 50)
  const map = new Map<string, SpotifyArtistFull>()
  if (ids.length === 0) return map
  const resp = await spotifyFetch<{ artists: (SpotifyArtistFull | null)[] }>(
    `/v1/artists?ids=${ids.join(',')}`
  )
  for (const a of resp?.artists ?? []) {
    if (a) map.set(a.id, a)
  }
  return map
}

export type VerifyTarget = {
  artist: string
  track: string
  album: string
  year: number
}

export type VerifiedTrack = {
  id: string
  name: string
  /** The credit that exactly matched the LLM's claimed artist — not
   * necessarily the first credit. Diversity caps and display use this, so
   * they follow the artist the LLM meant. (tracks 테이블은 canonical하게
   * 첫 크레딧을 저장한다 — upsert.ts 불변.) */
  artistId: string
  artistName: string
  /** Every credited artist on the track — chain exclusion checks all of
   * them so a collab can't sneak past under a different credit's name. */
  allArtistIds: string[]
  album: string
  year: number | null
  spotifyUrl: string | null
  previewUrl: string | null
  coverUrl: string | null
}

/**
 * Why a proposed tuple failed verification. The curator feeds these back into
 * the supplement prompt so Sonnet can fix its metadata instead of repeating
 * the same mistake blind. `infra_failure` is assigned by the *caller* (the
 * curator) when the Spotify call itself failed — verifyTrack throws in that
 * case rather than misreporting a live track as nonexistent.
 */
// Const array + derived type so consumers (e.g. pipeline_stats' zeroed
// Record init) can enumerate every reason — adding a reason here makes any
// hand-rolled record miss a key at compile time instead of silently at runtime.
export const VERIFY_FAIL_REASONS = [
  'not_found',
  'title_mismatch',
  'album_mismatch',
  'year_mismatch',
] as const
export type VerifyFailReason = (typeof VERIFY_FAIL_REASONS)[number]

export type VerifyResult =
  | {
      ok: true
      track: VerifiedTrack
      /** 자동 표기 보정으로 수락됨 — album: 주장 앨범 대신 canonical 앨범,
       * year: 주장 연도 대신 canonical(더 이른) 연도. pipeline_stats 계측용. */
      canonicalized?: 'album' | 'year'
    }
  | {
      ok: false
      reason: VerifyFailReason
      /** Closest candidate on Spotify — what the supplement prompt needs to
       * tell a typo from a full hallucination. For artist-stage failures
       * (not_found) `artist` carries the credit that DOES have this exact
       * title (repair hint: e.g. "아이유" ↔ "IU" romanization mismatches);
       * for deeper failures the artist already matched so it's omitted. */
      nearest?: {
        artist?: string
        track?: string
        album: string
        year: number | null
      }
    }

// How deep a failed candidate got, so we report the most informative miss:
// year (artist+title+album matched) > album (artist+title) > title (artist
// only) > not_found (nobody matched the artist).
const FAIL_DEPTH: Record<VerifyFailReason, number> = {
  not_found: 0,
  title_mismatch: 1,
  album_mismatch: 2,
  year_mismatch: 3,
}

// --- Title gate -------------------------------------------------------------
// The relaxed tier-2 query doesn't constrain the title at all (and even the
// field-filtered tier is fuzzy), so without our own title check a hallucinated
// title could "verify" as a DIFFERENT real song from the same album/year and
// ship wearing the imagined song's sonic_link. Rule (deliberately strict):
// strip *trailing* version noise from both sides, normalize, then require
// exact equality — a loose contains would let "Run" pass as "Run Away" on the
// same album.

// Trailing decorations that mark the SAME recording (safe to strip from
// either side): remaster/mono/radio edit etc. are presentation variants of
// one recording.
// bare "mix"는 R5 분리 때 빠졌다가 복원(2차 배치 실측): Raw Power(1973)의
// 정규판 트랙명이 "Search and Destroy - Bowie Mix"라 제목 게이트에서 죽고
// 라이브판만 남아 year_mismatch로 위장됐다. "- Remix"는 VARIANT가 잡아
// 보존되므로(strippable = EQUIV && !VARIANT) 다른-녹음 방어는 유지된다.
const EQUIV_NOISE_RE =
  /\b(remaster(ed)?|mono|stereo|single|radio|edit|version|mix|deluxe|expanded|anniversary|reissue|feat\.?|featuring|bonus|\d{4})\b/i
// Markers of a DIFFERENT recording (live take, demo, remix, …). These are
// NEVER stripped: they stay in the normalized title, so "Creep - Live" only
// matches a target that also says live. Without this split, a deluxe
// edition's live/demo bonus track (album partial-matches, often same
// release_date) would verify as the studio original.
// re-recorded와 Taylor's Version은 정의상 다른 녹음 — EQUIV가 아니라 여기
// (초기 배치 오류를 정정: 연도 게이트 하나에 기대던 방어를 제목 게이트로 이중화).
// club/extended/dub/dance/12인치는 bare "mix" 복원(EQUIV)의 가드 — "Club Mix"
// 같은 다른-편집 꼬리가 원곡으로 접히지 않게 한다. VARIANT는 EQUIV와 겹치는
// 꼬리에서만 의미가 있으므로(strippable = EQUIV && !VARIANT) 이 토큰들을
// 넣어도 다른 제목엔 영향 없음.
const VARIANT_NOISE_RE =
  /\b(live|acoustic|demo|remix|instrumental|unplugged|session|take|rehearsal|alternate|a\s?cappella|karaoke|cover|re-?recorded|taylor'?s version|club|extended|dub|dance|12\s?(?:inch|"))\b/i

/**
 * Remove trailing SAME-recording decorations ("- Remastered 2009", "(Mono
 * Version)", "[2011 Remaster]") — and ONLY trailing ones: a leading
 * parenthetical like "(Don't Fear) The Reaper" is part of the title and must
 * survive. A segment is stripped only when it matches the equivalence
 * vocabulary AND carries no different-recording marker (a mixed "- Live /
 * Remastered" tail must survive so the live take can't pass as the studio
 * cut). The dash rule cuts from the first " - " separator so hyphenated
 * words inside the tail ("Re-Recorded") are still seen as one segment.
 */
function stripVersionNoise(raw: string): string {
  const strippable = (m: string) =>
    EQUIV_NOISE_RE.test(m) && !VARIANT_NOISE_RE.test(m)
  let s = raw
  for (let guard = 0; guard < 4; guard++) {
    const before = s
    s = s.replace(/\s+-\s+[^]*$/u, (m) => (strippable(m) ? '' : m))
    s = s.replace(/\s*[([][^)\]]*[)\]]\s*$/u, (m) => (strippable(m) ? '' : m))
    if (s === before) break
  }
  return s.trim() || raw
}

// --- Reissue year grace -----------------------------------------------------
// Some tracks exist on Spotify ONLY as a later remaster/deluxe whose album
// release_date is decades after the original year the LLM (correctly) wrote.
// Grace the ±2 rule only when every stronger gate (artist, title, album base
// name) has already passed, the album name explicitly says it's a reissue,
// and the candidate year is LATER than the claimed original. Compilations are
// excluded so a short album name contained in a comp title can't sneak in.
const REISSUE_ALBUM_RE = /remaster|deluxe|anniversary|reissue|expanded|legacy/i
const COMPILATION_ALBUM_RE =
  /best|greatest|hits|singles|collection|anthology|soundtrack|live/i

// --- Conservative canonicalization -------------------------------------------
// artist+title-exact까지 통과했는데 album 또는 year에서 떨어진 후보는, LLM이
// "곡은 맞고 표기만 틀린" 가능성이 높다. 조건을 좁게 걸어 후보의 canonical
// album/year로 자동 수락한다(추가 Spotify 콜 0 — 이미 받은 페이지 안에서 판단):
//   - album 구제: 후보 연도가 주장 ±2 안 + 앨범이 라이브/방송/트리뷰트 계열
//     아님 + 비컴필 후보만 + pool 내 재생시간이 한 클러스터(±10s)일 때 최조기.
//   - year 구제: album은 이미 부분일치 + 후보 연도가 주장보다 이른 경우만
//     (재녹음은 항상 나중이므로 이 방향은 구조적으로 안전) + Δ≤6.
// 위양성 잔여: 같은 아티스트가 근접 연도에 같은 제목의 다른 곡을 낸 케이스 —
// duration 클러스터 가드가 1차 방어, 실측은 pipeline_stats.canonicalized로.
const LIVEISH_ALBUM_RE =
  /live|concert|unplugged|sessions?|radio|bbc|mtv|karaoke|tribute|made famous/i
const REPAIR_DURATION_SPREAD_MS = 10_000

type RepairEntry = {
  cand: SpotifyTrackWithPopularity
  credit: { id: string; name: string }
  candYear: number
}

type RepairSink = { album: RepairEntry[]; year: RepairEntry[] }

/** 구제 풀에서 안전한 후보 하나를 고른다 — 실패 시 null(구제 포기). */
function chooseRepair(pool: RepairEntry[]): RepairEntry | null {
  const clean = pool.filter(
    (e) => !COMPILATION_ALBUM_RE.test(e.cand.album?.name ?? '')
  )
  if (clean.length === 0) return null
  const durations = clean.map((e) => e.cand.duration_ms)
  if (Math.max(...durations) - Math.min(...durations) > REPAIR_DURATION_SPREAD_MS) {
    // 재생시간이 갈라진다 = 동명이곡/다른 편집 가능성 — 자동 수락 금지.
    return null
  }
  return clean.slice().sort(
    (a, b) => a.candYear - b.candYear || b.cand.popularity - a.cand.popularity
  )[0]
}

type VerifyFail = Extract<VerifyResult, { ok: false }>

/** Token-boundary phrase containment on normalized (space-separated) strings:
 * "war" must NOT match inside "warchild", while "ok computer" still matches
 * "ok computer oknotok 1997 2017". */
function containsPhrase(hay: string, needle: string): boolean {
  if (!hay || !needle) return false
  return ` ${hay} `.includes(` ${needle} `)
}

/**
 * Apply the match rule to one page of search candidates. Pure; no upserts.
 * Gates in order: artist exact (against EVERY credit — a collab track whose
 * intended artist is the 2nd credit must not false-drop) → title exact
 * (version noise stripped) → album partial contains (token-boundary) →
 * year ±2 (with the reissue grace above).
 * `credit` is the matched credit (drives artistId/artistName downstream);
 * `displayYear` is the year the caller should surface: the candidate's own
 * album year normally, the LLM's claimed original year when a reissue was
 * graced (showing "1973" for a 2009 remaster of a 1973 song, not "2009").
 */
function matchCandidates(
  items: SpotifyTrackWithPopularity[],
  target: VerifyTarget,
  // canonicalization 후보 수집처 (호출자가 tier 전체에 걸쳐 누적) — 없으면 수집 안 함.
  repairSink?: RepairSink
):
  | {
      hit: SpotifyTrackWithPopularity
      credit: { id: string; name: string }
      displayYear: number | null
    }
  | VerifyFail {
  // 주장 artist의 표기 변형들 — 전부 **주장 측** 정규화이고 후보 크레딧은
  // 절대 안 건드린다(stripVersionNoise와 같은 철학). 어떤 변형이든 후보
  // 크레딧과 정확 일치해야 하므로 검증 완화가 아니다:
  //   1) 원형
  //   2) feat-꼬리 제거: "X feat. Y" → "X" ("with"는 실제 크레딧과, 단독
  //      "ft."는 지명 "Ft. Worth"와 충돌해 제외)
  //   3) 병기 스플릿: "조이 (Joy)" → "조이" / "Joy" — 3차 배치 실측(K-표기
  //      병기가 크레딧 "JOY"와 불일치해 not_found)의 구제. feat 계열 괄호는
  //      제외.
  const claimForms = new Set<string>([target.artist])
  const strippedClaim = target.artist.replace(
    /\s+(?:feat\.?|featuring)\s+.+$/i,
    ''
  )
  if (strippedClaim !== target.artist) claimForms.add(strippedClaim)
  for (const form of [...claimForms]) {
    // feat-꼬리가 남아있는 원형은 스플릿하지 않는다 — "X feat. Z (Y)"의
    // 괄호는 featured 크레딧 쪽 별칭일 수 있어 오확장 위험(codex 리뷰).
    // "X (Y) feat. Z"는 꼬리 제거형("X (Y)")이 스플릿을 받으므로 손실 없음.
    if (/\s+(?:feat\.?|featuring)\s+/i.test(form)) continue
    const m = form.match(/^(.+?)\s*[(（]([^)）]+)[)）]$/)
    if (m) {
      const outer = m[1].trim()
      const inner = m[2].trim()
      if (
        outer &&
        inner &&
        !/^(?:feat\.?|featuring|ft\.?|with)\b/i.test(inner)
      ) {
        claimForms.add(outer)
        claimForms.add(inner)
      }
    }
  }
  const baseWants = new Set([...claimForms].map(normalizeForMatch))
  const andWants = new Set([...claimForms].map(normalizeForMatchAnd))
  // 공백 접합 변형: 로마자 표기의 하이픈/띄어쓰기 분절 차("Lim Chang-jung" ↔
  // 크레딧 "Lim Changjung", 4차 배치 실측)를 흡수한다. 문자 시퀀스 전체가
  // 동일해야 하므로 정확 일치 원칙은 유지 — 아티스트 게이트에만 적용.
  // 가드(codex 리뷰): 1자 토큰이 있으면 접합하지 않는다 — "will.i.am"이
  // "will i am"→"william"으로 붕괴해 별개의 William 크레딧과 충돌하는
  // 클래스 차단. 대상 클래스(음절 분절 로마자)는 토큰이 전부 2자+다.
  const joined = (s: string) => normalizeForMatch(s).replace(/ /g, '')
  const joinable = (s: string) => {
    const tokens = normalizeForMatch(s).split(' ')
    return tokens.length >= 2 && tokens.every((t) => t.length >= 2)
  }
  const joinedWants = new Set(
    [...claimForms].filter(joinable).map(joined)
  )
  const wantTitle = normalizeForMatch(stripVersionNoise(target.track))
  const wantTitleAnd = normalizeForMatchAnd(stripVersionNoise(target.track))
  const wantAlbum = normalizeForMatch(target.album)
  const wantAlbumAnd = normalizeForMatchAnd(target.album)

  let bestFail: VerifyFail = { ok: false, reason: 'not_found' }
  const failAt = (
    reason: VerifyFailReason,
    cand: SpotifyTrackWithPopularity,
    candYear: number | null
  ) => {
    if (FAIL_DEPTH[reason] > FAIL_DEPTH[bestFail.reason]) {
      bestFail = {
        ok: false,
        reason,
        // artist도 항상 저장(2차 배치 판독 반영): 깊은 실패에서도 최근접
        // 후보의 크레딧을 알아야 "크레딧 변형 위장" 가설류를 사후 검증하고
        // 보충 피드백이 정확해진다.
        nearest: {
          artist: cand.artists[0]?.name,
          track: cand.name,
          album: cand.album?.name ?? '',
          year: candYear,
        },
      }
    }
  }

  // Repair-hint tracking: a candidate whose (noise-stripped) title exactly
  // matches but whose credits DON'T include the claimed artist usually means
  // the LLM mis-attributed or mis-spelled the artist (Korean↔romanized names
  // are the big class). Remember the best such candidate so a final
  // not_found can say "같은 제목이 X 명의로 존재". Karaoke/tribute noise is
  // excluded — suggesting "Ameritz Karaoke" would mislead the supplement.
  // Ranking: claimed-album phrase match first, then popularity.
  let hint: {
    artist: string
    track: string
    album: string
    year: number | null
    albumMatch: boolean
    popularity: number
  } | null = null

  for (const cand of items) {
    const credit = cand.artists.find(
      (a) =>
        baseWants.has(normalizeForMatch(a.name)) ||
        andWants.has(normalizeForMatchAnd(a.name)) ||
        (joinedWants.size > 0 && joinedWants.has(joined(a.name)))
    )
    if (!credit) {
      const candTitle = normalizeForMatch(stripVersionNoise(cand.name))
      const candTitleAnd = normalizeForMatchAnd(stripVersionNoise(cand.name))
      const firstArtist = cand.artists[0]?.name
      if (
        firstArtist &&
        wantTitle &&
        (candTitle === wantTitle || candTitleAnd === wantTitleAnd) &&
        !isNoiseCandidate(cand)
      ) {
        const candAlbum = normalizeForMatch(cand.album?.name ?? '')
        const albumMatch =
          !!wantAlbum &&
          (containsPhrase(candAlbum, wantAlbum) ||
            containsPhrase(wantAlbum, candAlbum))
        const better =
          hint === null ||
          (albumMatch && !hint.albumMatch) ||
          (albumMatch === hint.albumMatch && cand.popularity > hint.popularity)
        if (better) {
          hint = {
            artist: firstArtist,
            track: cand.name,
            album: cand.album?.name ?? '',
            year: yearOf(cand.album?.release_date),
            albumMatch,
            popularity: cand.popularity,
          }
        }
      }
      continue
    }

    const candYear = yearOf(cand.album?.release_date)

    const candTitle = normalizeForMatch(stripVersionNoise(cand.name))
    const candTitleAnd = normalizeForMatchAnd(stripVersionNoise(cand.name))
    if (wantTitle && candTitle !== wantTitle && candTitleAnd !== wantTitleAnd) {
      failAt('title_mismatch', cand, candYear)
      continue
    }

    const candAlbum = normalizeForMatch(cand.album?.name ?? '')
    const candAlbumAnd = normalizeForMatchAnd(cand.album?.name ?? '')
    const albumRaw = cand.album?.name ?? ''
    // partial contains in either direction (LLM may give shorter or longer),
    // but only at token boundaries — "war" ⊄ "warchild". &↔and는 변형쌍으로.
    if (
      wantAlbum &&
      !containsPhrase(candAlbum, wantAlbum) &&
      !containsPhrase(wantAlbum, candAlbum) &&
      !containsPhrase(candAlbumAnd, wantAlbumAnd) &&
      !containsPhrase(wantAlbumAnd, candAlbumAnd)
    ) {
      failAt('album_mismatch', cand, candYear)
      // album 구제 후보: artist+title은 맞고 연도도 ±2인데 앨범명만 다른 경우.
      if (
        repairSink &&
        candYear !== null &&
        Math.abs(candYear - target.year) <= 2 &&
        !LIVEISH_ALBUM_RE.test(albumRaw)
      ) {
        repairSink.album.push({ cand, credit, candYear })
      }
      continue
    }

    if (candYear !== null && Math.abs(candYear - target.year) > 2) {
      const graceableReissue =
        candYear > target.year &&
        REISSUE_ALBUM_RE.test(albumRaw) &&
        !COMPILATION_ALBUM_RE.test(albumRaw)
      if (!graceableReissue) {
        failAt('year_mismatch', cand, candYear)
        // year 구제 후보: album까지 맞고 후보 연도가 주장보다 이른 경우만
        // (재녹음은 항상 나중 — 이 방향은 구조적으로 안전) + Δ≤6.
        if (
          repairSink &&
          candYear < target.year &&
          target.year - candYear <= 6 &&
          !LIVEISH_ALBUM_RE.test(albumRaw)
        ) {
          repairSink.year.push({ cand, credit, candYear })
        }
        continue
      }
      return { hit: cand, credit, displayYear: target.year }
    }

    return { hit: cand, credit, displayYear: candYear }
  }

  // Attach the repair hint only when the failure IS artist-stage: a deeper
  // failure means the artist matched somewhere, so an alternate-artist hint
  // would be noise.
  if (bestFail.reason === 'not_found' && hint) {
    bestFail = {
      ok: false,
      reason: 'not_found',
      nearest: {
        artist: hint.artist,
        track: hint.track,
        album: hint.album,
        year: hint.year,
      },
    }
  }

  return bestFail
}

/**
 * Verify an LLM-proposed (artist, track, album, year) tuple actually exists on
 * Spotify. Match rule: artist name exact (after normalize), album name partial
 * contains (after normalize), release year within ±2.
 *
 * Two-tier search: the strict field-filtered query first; if it yields zero
 * candidates *by that artist* (field filters are brittle around punctuation
 * and parenthesized subtitles), one relaxed free-text query. The match rule
 * itself never relaxes — only candidate retrieval does.
 *
 * Returns the canonical Spotify track (+ upserts artist/track rows) on match,
 * a typed failure (with the nearest same-artist candidate when known) on
 * mismatch. Throws on Spotify infra errors (429/5xx/timeout) — the caller
 * distinguishes those from "track doesn't exist".
 */
export async function verifyTrack(
  target: VerifyTarget,
  opts?: {
    signal?: AbortSignal
    /** Absolute epoch-ms cap (the curator hard cap). The extra tiers
     * (relaxed query, album rescue) each cost up to one 10s request in the
     * worst case, so they only run while enough runway remains — a supplement
     * pass late in the budget degrades to single-tier verification instead of
     * blowing the cap. */
    deadlineMs?: number
  }
): Promise<VerifyResult> {
  const runway = (needMs: number) =>
    opts?.deadlineMs === undefined || opts.deadlineMs - Date.now() > needMs
  // Per-tier runway: one worst-case search (10s) + slack.
  const TIER_RUNWAY_MS = 12_000

  const searchCandidates = async (
    q: string
  ): Promise<SpotifyTrackWithPopularity[]> => {
    const resp = await spotifyFetch<{
      tracks: SpotifyPagedResponse<SpotifyTrackWithPopularity>
    }>(`/v1/search?q=${encodeURIComponent(q)}&type=track&limit=25`, {
      signal: opts?.signal,
    })
    return resp?.tracks.items ?? []
  }

  const acceptHit = async (
    cand: SpotifyTrackWithPopularity,
    credit: { id: string; name: string },
    displayYear: number | null,
    canonicalized?: 'album' | 'year'
  ): Promise<VerifyResult> => {
    // Match. Upsert artist BEFORE track — tracks.artist_id has a FK to
    // artists.id, so these two writes must stay ordered (parallelizing them
    // risks the track insert hitting the FK before the artist row commits).
    // NOTE: the DB stays canonical (tracks.artist_id = first credit via
    // upsert.ts); only the returned VerifiedTrack carries the matched credit.
    await upsertArtistsFromTracks([cand])
    await upsertTracks([cand])
    return {
      ok: true,
      ...(canonicalized ? { canonicalized } : {}),
      track: {
        id: cand.id,
        name: cand.name,
        artistId: credit.id,
        artistName: credit.name,
        allArtistIds: cand.artists.map((a) => a.id),
        album: cand.album?.name ?? '',
        year: displayYear,
        spotifyUrl: cand.external_urls?.spotify ?? null,
        previewUrl: cand.preview_url ?? null,
        // Same selection as upsert.ts: index 1 is ~300px (640/300/64), the
        // right size for small recommendation thumbnails without serving a
        // giant 640.
        coverUrl:
          cand.album?.images?.[1]?.url ?? cand.album?.images?.[0]?.url ?? null,
      },
    }
  }

  const queries = [
    `track:"${dq(target.track)}" artist:"${dq(target.artist)}"`,
    `${target.track} ${target.artist}`,
  ]

  let bestFail: VerifyFail = { ok: false, reason: 'not_found' }
  const keepDeeper = (res: VerifyFail) => {
    const d = FAIL_DEPTH[res.reason]
    const cur = FAIL_DEPTH[bestFail.reason]
    // Same depth: prefer the one carrying a nearest hint — tier 2 often finds
    // the repair hint that tier 1's stricter query couldn't surface.
    if (d > cur || (d === cur && !bestFail.nearest && res.nearest)) {
      bestFail = res
    }
  }

  // Canonicalization repair candidates accumulate across every tier so the
  // final decision sees the full pool (duration-cluster guard needs that).
  const repairSink: RepairSink = { album: [], year: [] }

  for (let tier = 0; tier < queries.length; tier++) {
    if (tier > 0 && !runway(TIER_RUNWAY_MS)) break
    const items = await searchCandidates(queries[tier])
    const res = matchCandidates(items, target, repairSink)
    if ('hit' in res) return acceptHit(res.hit, res.credit, res.displayYear)
    keepDeeper(res)

    // The relaxed tier only helps when the strict query couldn't surface the
    // right candidate at all — either nobody by this artist (query
    // brittleness) or only differently-titled tracks (the field filter's
    // fuzzy title notion missed the canonical version). If artist+title DID
    // match and album/year mismatched, tier 2 would return the same tracks.
    if (res.reason !== 'not_found' && res.reason !== 'title_mismatch') break
  }

  // Rescue tier: an album_mismatch means the artist+title exist but every
  // candidate carried the wrong album — typically compilations crowding out
  // the studio album in generic search ranking. One album-filtered query
  // surfaces the proper edition if it exists. Same match rule applies.
  if (bestFail.reason === 'album_mismatch' && runway(TIER_RUNWAY_MS)) {
    const items = await searchCandidates(
      `track:"${dq(target.track)}" artist:"${dq(target.artist)}" album:"${dq(target.album)}"`
    )
    const res = matchCandidates(items, target, repairSink)
    if ('hit' in res) return acceptHit(res.hit, res.credit, res.displayYear)
    keepDeeper(res)
  }

  // Conservative canonicalization — only after the claimed metadata failed
  // every tier (claimed-album rescue included), and only for the stage the
  // failure actually reached. displayYear는 canonical(후보) 연도.
  if (bestFail.reason === 'album_mismatch') {
    const pick = chooseRepair(repairSink.album)
    if (pick) return acceptHit(pick.cand, pick.credit, pick.candYear, 'album')
  } else if (bestFail.reason === 'year_mismatch') {
    const pick = chooseRepair(repairSink.year)
    if (pick) return acceptHit(pick.cand, pick.credit, pick.candYear, 'year')
  }

  return bestFail
}
