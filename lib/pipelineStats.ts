import type { Category } from './kinship'
import type { LeapVerdict } from './leap'
import type { VerifyFailReason } from './spotify/catalog'

/*
 * curations.pipeline_stats (jsonb)에 저장되는 관측 데이터의 타입.
 *
 * 목적: leap 감사 Phase B(약도약 재분류) 결정과 verify 규칙 캘리브레이션에
 * 필요한 관측 데이터를 큐레이션 단위로 영속화한다. API 응답의 stats 계약
 * (CurateOk.stats)은 이 타입과 무관하게 현행 유지 — 상세는 DB에만 쌓인다.
 *
 * 이 파일은 **순수 타입 전용**이다. db/schema.ts가 이 타입을 $type으로
 * 참조하므로, 여기에 런타임 코드를 추가하면 drizzle-kit 컴파일 그래프에
 * 런타임 의존이 끌려 들어간다. import type만 쓸 것 (kinship/leap/catalog의
 * 런타임 의존은 type-only import라 컴파일 시 지워진다 — 순환 없음).
 *
 * shape을 바꿀 때는 v를 올리고 소비 코드가 v로 분기하게 한다.
 */

export type PipelineStatsV1 = {
  v: 1
  verify: {
    /** 1차 + 보충 합산 제안 수 */
    proposed: number
    /** 매치 규칙 통과 수 (합산) */
    verified: number
    /** 사유별 탈락 (infra 제외 — infra는 droppedByInfra로 별도) */
    failuresByReason: Record<VerifyFailReason, number>
    droppedAsDuplicate: number
    droppedByDiversity: number
    droppedByInfra: number
    /** 카테고리별 제안/수락 (1차 + 보충 합산) */
    byCategory: Record<Category, { proposed: number; accepted: number }>
    /** 자동 표기 보정으로 수락된 수 (verified에 포함됨 — 분리 계측용).
     * optional-additive라 v는 그대로 1 (v2는 output contract가 바뀔 때만). */
    canonicalized?: { album: number; year: number }
    /** 탈락 표본 (12캡): 어떤 곡의 어떤 표기가 왜 떨어졌는지 사후 분석용 —
     * 사유 카운트만으론 "무표기 리이슈 vs LLM 연도 오기" 같은 인과 구분이
     * 불가능해서 추가(1차 캘리브레이션 판독의 관측 공백). 주장 튜플은 LLM
     * 원문, nearest는 Spotify 최근접. infra_failure는 여기 안 들어간다. */
    failSamples?: {
      pass: 'first' | 'supplement'
      category: Category
      artist: string
      track: string
      album: string
      year: number
      reason: VerifyFailReason
      nearest?: {
        artist?: string
        track?: string
        album: string
        year: number | null
      }
    }[]
  }
  supplement: {
    /** 보충 Sonnet 콜이 실제로 나갔는가 */
    attempted: boolean
    /** attempted=false일 때만: 왜 안 나갔는가 */
    skippedReason?: 'no_deficit' | 'headroom'
    /** attempted=true일 때: 콜의 실제 결말 — 2차 배치 #43(29.8s 소모 후 빈
     * 반환)의 원인이 timeout/schema_miss/필터전멸 중 뭔지 구분 불가했던
     * 공백을 메운다. ok=곡 반환, empty=스키마 유효하나 0곡, filtered_empty=
     * 반환은 있었으나 요청 카테고리 필터 후 0곡, timeout/schema_miss/failed=
     * 콜 자체 실패 형태. */
    outcome?:
      | 'ok'
      | 'empty'
      | 'filtered_empty'
      | 'schema_miss'
      | 'timeout'
      | 'failed'
    /** 카테고리 필터 전 Sonnet이 반환한 곡 수 */
    rawReturned?: number
    /** 원 결핍 (peer piggyback 포함) — floor/게이트 판단의 근거는 항상 이쪽 */
    deficits?: { category: Category; want: number }[]
    /** 실제 요청량 = 결핍 +1(카테고리당 상한 3) — verify attrition 여유분.
     * deficits와 분리 저장해야 결핍 규모 분석이 안 부푼다. */
    requested?: { category: Category; want: number }[]
    /** 보충에서 최종 수락된 트랙 수 */
    added?: number
  }
  /** kinship-leap 감사 (Phase A log-only). kinship 픽이 없으면 필드 자체 생략 */
  leap?: {
    /** timeout = 5s race 패배(검증 증거가 조용히 사라지지 않게 기록),
     * skipped = 헤드룸 부족/abort로 시작 안 함, failed = 감사 자체 예외 */
    status: 'ok' | 'timeout' | 'failed' | 'skipped'
    verdicts?: LeapVerdict[]
  }
  /** 카테고리 시간축 감사 (log-only, 집행 없음): influence는 시드보다 앞,
   * descendant는 뒤가 정상(±2 슬랙). peer는 |Δ|>10만 관측. canonicalize된
   * 연도 기준이라 원발매연도 오차가 남을 수 있는 **품질 신호**이지 집행
   * 근거가 아니다. seedYear를 모르면 필드 생략. optional-additive — v 유지. */
  categoryTemporalAudit?: {
    influenceAfterSeed: number
    descendantBeforeSeed: number
    peerOutOfEra: number
    skippedUnknownYear: number
  }
  /** leap Phase B(B0, LEAP_PHASE_B=1일 때만): 집행 흔적. weak_leap 픽은
   * 카테고리를 바꾸지 않고 kinship floor 계산에서만 제외된다(비파괴).
   * 이때 감사는 1차 verify 직후라 보충 추가 kinship 픽은 미감사 —
   * supplementAudited: false가 그 블라인드스팟의 명시적 기록. */
  phaseB?: {
    weakExcluded: number
    supplementAudited: false
  }
  /** 단계별 소요(ms) — [curate] TOTAL 로그와 같은 재료.
   * verify는 verifyAndFilter 총합(1차 검증+보충 Sonnet+보충 검증 포함 —
   * 하위호환 유지). 아래 optional 3종이 그 내부를 분해한다: "보충 왕복이
   * 주범"류 인과를 단정하려면 이 분리가 필요(1차 배치 판독에서 확인). */
  timings: {
    seed: number
    ctx: number
    sonnet: number
    verify: number
    verifyFirst?: number
    supplementSonnet?: number
    supplementVerify?: number
  }
}

export type PipelineStats = PipelineStatsV1
