import { getArtistTopTags } from './lastfm'
import { getArtistsBatch } from './spotify/catalog'

/*
 * Kinship-leap audit — Phase A: LOG-ONLY.
 *
 * kinship의 존재 이유는 "시대나 장르의 강을 건너는" 도약인데, 메타데이터로
 * 그 도약을 측정해 약한 픽(시드와 같은 시대 + 같은 장르권)을 잡아내는 감사기.
 * Phase A에서는 판정을 로그로만 남기고 카테고리를 절대 바꾸지 않는다 —
 * 규칙(|Δyear|<10 AND 비-generic 장르 중첩)이 제품이 공인한 예외형
 * (L.A. Woman ↔ La Grange: 동시대·동장르지만 groove/texture 비자명 축 친족)을
 * 오탐하는 것이 설계 단계에서 이미 확인됐기 때문이다. 실로그로 오탐률을
 * 캘리브레이션한 뒤에만 Phase B(peer 재분류 + weak_leap 보충 피드백)를 결정한다.
 *
 * 캘리브레이션 카나리아 (docs/curation-pipeline.md 참조):
 *   - 잡아야 함: NewJeans "Attention" 시드 ↔ 동시대 R&B (Jorja Smith 류)
 *   - 잡으면 안 됨(현 규칙상 잡힘 — 예외형): The Doors "L.A. Woman" ↔ ZZ Top "La Grange"
 *
 * 비용: Spotify 아티스트 배치 1콜 + 픽별 Last.fm 태그(6h 캐시, 각 5s 캡) 병렬.
 * 호출자(curator)가 전체를 5s race + 헤드룸 게이트로 감싼다.
 */

export type LeapVerdictValue =
  | 'leap_ok'
  /** 시대·장르 모두 근접 + 비자명 축 근거 없음 — 프롬프트 도약 기준 위반 후보 */
  | 'weak_leap'
  /** 시대·장르 근접하지만 link_dimensions가 전부 groove/texture — 프롬프트가
   * 공인한 예외형(L.A. Woman ↔ La Grange). weak_leap과 분리해 카나리아 모순 해소 */
  | 'exception_nonobvious'
  /** 판정에 필요한 정보(연도/장르)가 부족 — 보수적으로 판정 안 함 */
  | 'unknown'

// 비자명 축: 이 dims만으로 연결된 픽은 시대·장르가 겹쳐도 예외형으로 본다.
// (mood/vocal_style 같은 자명 축이 하나라도 섞이면 예외 아님 — 엄격 부분집합)
const NONOBVIOUS_DIMS = new Set(['groove', 'texture'])

export type LeapVerdict = {
  trackId: string
  artistName: string
  trackName: string
  verdict: LeapVerdictValue
  deltaYear: number | null
  /** 시드와 후보가 공유한 비-generic 장르/태그 구문 */
  overlap: string[]
  /** LLM이 자기신고한 link_dimensions 원본 (gaming 분포 검증용으로 함께 저장) */
  dims: string[]
  /** dims에 groove/texture 외 축이 하나라도 있는가 */
  hasObviousAxis: boolean
}

// 시대 근접 기준: 10년 미만이면 "같은 시대"로 본다 (프롬프트의 도약 기준이
// 요구하는 '시대의 강'에 못 미치는 거리).
const ERA_NEAR_YEARS = 10

// 장르 판정에서 제외하는 generic 구문 — 이걸 걸러야 "rock 겹침" 같은
// 무의미한 중첩이 도약 실패로 오판되지 않는다. 소문자 비교.
// 주의: 연대 태그(70s 등)는 시대 신호의 중복 계산이라 generic으로 취급.
const GENERIC_TERMS = new Set([
  'rock',
  'pop',
  'indie',
  'alternative',
  'alternative rock',
  'classic rock',
  'seen live',
  'favorites',
  'favourites',
  'favorite',
  'male vocalists',
  'male vocalist',
  'female vocalists',
  'female vocalist',
  // 주의: r&b/soul/hip hop 같은 "넓지만 실질적인" 장르는 일부러 generic에
  // 넣지 않는다 — 그게 바로 must-catch 카나리아(NewJeans↔동시대 R&B)의 중첩
  // 신호라서, generic 처리하면 감사기가 약도약을 못 본다. Phase A 로그가
  // 시끄러우면 그때 데이터 기준으로 재조정.
  'singer-songwriter',
  'american',
  'british',
  'uk',
  'usa',
  'oldies',
  'beautiful',
  'awesome',
  'chill',
  'mellow',
  'catchy',
  'love',
  '60s',
  '70s',
  '80s',
  '90s',
  '00s',
  '10s',
  '2000s',
  '2010s',
  '2020s',
])

/** "shoegaze(100)" → "shoegaze" (SeedContext의 가중치 표기 제거) + 소문자. */
function normalizeTerm(s: string): string {
  return s
    .replace(/\(\d+\)\s*$/, '')
    .trim()
    .toLowerCase()
}

function nonGenericVocab(terms: string[]): Set<string> {
  const out = new Set<string>()
  for (const t of terms) {
    const n = normalizeTerm(t)
    if (n && !GENERIC_TERMS.has(n)) out.add(n)
  }
  return out
}

export async function auditKinshipLeaps(args: {
  seedYear: number
  /** 시드 어휘: spotifyGenres ∪ Last.fm 태그 (가중치 표기 "name(N)" 허용) */
  seedVocab: string[]
  picks: {
    trackId: string
    artistId: string
    artistName: string
    trackName: string
    year: number | null
    /** 그 픽의 link_dimensions (LLM 자기신고 — 예외형 판별에 사용) */
    linkDimensions: string[]
  }[]
}): Promise<LeapVerdict[]> {
  const { seedYear, seedVocab, picks } = args
  if (picks.length === 0) return []

  const seedTerms = nonGenericVocab(seedVocab)

  // 아티스트 장르는 배치 1콜, Last.fm 태그는 픽별 병렬(캐시 히트가 대부분).
  // 어느 쪽이 실패해도 그 픽만 unknown으로 떨어진다.
  const [artistMap, tagLists] = await Promise.all([
    getArtistsBatch(picks.map((p) => p.artistId)).catch(
      () => new Map<string, { genres: string[] }>()
    ),
    Promise.all(
      picks.map((p) => getArtistTopTags(p.artistName).catch(() => []))
    ),
  ])

  return picks.map((p, i) => {
    const dims = p.linkDimensions
    const hasObviousAxis = dims.some((d) => !NONOBVIOUS_DIMS.has(d))
    const base = {
      trackId: p.trackId,
      artistName: p.artistName,
      trackName: p.trackName,
      dims,
      hasObviousAxis,
    }

    const deltaYear =
      p.year !== null && seedYear > 0 ? Math.abs(p.year - seedYear) : null
    const genres = artistMap.get(p.artistId)?.genres ?? []
    const tags = tagLists[i].map((t) => t.name)
    const candTerms = nonGenericVocab([...genres, ...tags])

    // 보수 원칙: 연도든 장르든 판정 재료가 비면 판정하지 않는다.
    if (deltaYear === null || seedTerms.size === 0 || candTerms.size === 0) {
      return { ...base, verdict: 'unknown' as const, deltaYear, overlap: [] }
    }

    const overlap = [...candTerms].filter((t) => seedTerms.has(t))
    const eraNear = deltaYear < ERA_NEAR_YEARS
    const genreNear = overlap.length > 0

    let verdict: LeapVerdictValue = 'leap_ok'
    if (eraNear && genreNear) {
      // 시대·장르가 모두 가깝다 = 도약 없음. 단 연결 축이 전부 비자명
      // (groove/texture)이면 프롬프트가 공인한 예외형으로 분리한다.
      verdict =
        dims.length > 0 && !hasObviousAxis ? 'exception_nonobvious' : 'weak_leap'
    }

    return { ...base, verdict, deltaYear, overlap }
  })
}
