/**
 * scripts/report-pipeline-stats.ts — curations.pipeline_stats 읽기 전용 집계.
 *
 * 파이프라인 관측 데이터(verify 통과율·사유 분포, 카테고리별 수락률, 보충 실효,
 * leap 4값 분포 + dims 자기신고 분포, 타이밍 p50/p95)를 사람이 읽을 리포트로
 * 출력한다. leap Phase B(약도약 재분류) 결정과 verify 규칙 캘리브레이션의 근거.
 * 런타임 경로 무변경 — SELECT만 수행한다.
 *
 * Run:      pnpm tsx scripts/report-pipeline-stats.ts [--since=YYYY-MM-DD]
 *             [--calibration-only | --exclude-calibration]
 * Requires: DATABASE_URL (.env.local을 자체 로딩한다 — 셸에 이미 있으면 그쪽 우선)
 *
 * --since: chainNarrative 같은 프롬프트 변경의 도입 전/후 비교용 컷오프.
 * --calibration-only / --exclude-calibration: scripts/calibrate-pipeline.ts가
 *   query에 남기는 "[calibration]" 마커 기준 필터 — 능동 수집 표본과 유기
 *   사용 표본을 분리해 본다.
 */
import { and, gte, isNotNull } from 'drizzle-orm'
import { db } from '@/db/client'
import { curations } from '@/db/schema'
import type { PipelineStatsV1 } from '@/lib/pipelineStats'

// --- env ---------------------------------------------------------------------
// Node 20.12+. --env-file과 같은 의미론: 이미 설정된 변수는 덮어쓰지 않는다.
// 이 레포는 .env.local 또는 .env를 쓰므로 순서대로 시도한다.
for (const f of ['.env.local', '.env']) {
  try {
    process.loadEnvFile(f)
  } catch {
    // 파일이 없어도 됨 — 아래에서 DATABASE_URL 유무로 판정.
  }
}
if (!process.env.DATABASE_URL) {
  console.error(
    'DATABASE_URL이 없습니다. .env.local에 넣거나 셸에서 export 후 다시 실행하세요.\n' +
      '  pnpm tsx scripts/report-pipeline-stats.ts [--since=YYYY-MM-DD]'
  )
  process.exit(1)
}

// --- helpers -------------------------------------------------------------------

const LOW_SAMPLE_N = 20

function pct(num: number, den: number): string {
  if (den === 0) return '–'
  return `${((num / den) * 100).toFixed(1)}%`
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)
  )
  return sorted[idx]
}

function bump(map: Map<string, number>, key: string, by = 1): void {
  map.set(key, (map.get(key) ?? 0) + by)
}

function sortedEntries(map: Map<string, number>): [string, number][] {
  return [...map.entries()].sort((a, b) => b[1] - a[1])
}

function lowSampleTag(n: number): string {
  return n < LOW_SAMPLE_N ? '  ⚠ low sample' : ''
}

// --- aggregation ----------------------------------------------------------------

type Row = {
  id: number
  parent: number | null
  query: string | null
  createdAt: Date
  stats: PipelineStatsV1
}

/** 한 세그먼트(전체/루트/체인)의 집계. 키는 데이터에서 유도해 미래 확장에 견딘다.
 * Phase B 게이트 판정은 오독 방지를 위해 전체 세그먼트에서만 출력한다. */
function aggregate(rows: Row[], label: string, showGate = false): void {
  const n = rows.length
  console.log(`\n━━ ${label} (n=${n})${lowSampleTag(n)}`)
  if (n === 0) return

  // verify
  let proposed = 0
  let verified = 0
  let dup = 0
  let div = 0
  let infra = 0
  const byReason = new Map<string, number>()
  const byCat = new Map<string, { proposed: number; accepted: number }>()
  for (const r of rows) {
    const v = r.stats.verify
    proposed += v.proposed
    verified += v.verified
    dup += v.droppedAsDuplicate
    div += v.droppedByDiversity
    infra += v.droppedByInfra
    for (const [reason, cnt] of Object.entries(v.failuresByReason)) {
      if (cnt > 0) bump(byReason, reason, cnt)
    }
    for (const [cat, c] of Object.entries(v.byCategory)) {
      const cur = byCat.get(cat) ?? { proposed: 0, accepted: 0 }
      cur.proposed += c.proposed
      cur.accepted += c.accepted
      byCat.set(cat, cur)
    }
  }
  let canonAlbum = 0
  let canonYear = 0
  for (const r of rows) {
    canonAlbum += r.stats.verify.canonicalized?.album ?? 0
    canonYear += r.stats.verify.canonicalized?.year ?? 0
  }
  const failTotal = [...byReason.values()].reduce((a, b) => a + b, 0)
  console.log(
    `verify: proposed ${proposed} → verified ${verified} (통과율 ${pct(verified, proposed)}) · 중복 ${dup} · 다양성 ${div} · 인프라 ${infra}`
  )
  if (canonAlbum + canonYear > 0) {
    console.log(
      `  · canonicalized (verified에 포함, 자동 표기 보정): album ${canonAlbum} · year ${canonYear} — raw 통과율 ${pct(verified - canonAlbum - canonYear, proposed)}`
    )
  }
  for (const [reason, cnt] of sortedEntries(byReason)) {
    console.log(
      `  - ${reason}: ${cnt} (${pct(cnt, failTotal)} of failures, ${pct(cnt, proposed)} of proposed)`
    )
  }
  for (const [cat, c] of byCat.entries()) {
    console.log(
      `  · ${cat}: proposed ${c.proposed} → accepted ${c.accepted} (${pct(c.accepted, c.proposed)})`
    )
  }

  // supplement
  let attempted = 0
  let addedPositive = 0
  let addedSum = 0
  const skipped = new Map<string, number>()
  const deficitByCat = new Map<string, number>()
  for (const r of rows) {
    const s = r.stats.supplement
    if (s.attempted) {
      attempted++
      addedSum += s.added ?? 0
      if ((s.added ?? 0) > 0) addedPositive++
    } else {
      bump(skipped, s.skippedReason ?? 'unknown')
    }
    for (const d of s.deficits ?? []) bump(deficitByCat, d.category, d.want)
  }
  const requestedByCat = new Map<string, number>()
  for (const r of rows) {
    for (const d of r.stats.supplement.requested ?? []) {
      bump(requestedByCat, d.category, d.want)
    }
  }
  console.log(
    `supplement: 발동 ${attempted}/${n} (${pct(attempted, n)}) · added>0 ${addedPositive}/${attempted || 0} (${pct(addedPositive, attempted)}) · 평균 added ${attempted ? (addedSum / attempted).toFixed(1) : '–'}`
  )
  for (const [reason, cnt] of sortedEntries(skipped)) {
    console.log(`  - skipped(${reason}): ${cnt}`)
  }
  const outcomeCount = new Map<string, number>()
  for (const r of rows) {
    const o = r.stats.supplement.outcome
    if (o) bump(outcomeCount, o)
  }
  for (const [o, cnt] of sortedEntries(outcomeCount)) {
    console.log(`  - outcome(${o}): ${cnt}`)
  }
  for (const [cat, want] of sortedEntries(deficitByCat)) {
    const req = requestedByCat.get(cat)
    console.log(
      `  · 결핍 ${cat}: 총 ${want}곡${req !== undefined ? ` (과잉 요청 ${req})` : ''}`
    )
  }

  // temporal audit (log-only 관측)
  let tInfl = 0
  let tDesc = 0
  let tPeer = 0
  let tSkip = 0
  let tRows = 0
  for (const r of rows) {
    const t = r.stats.categoryTemporalAudit
    if (!t) continue
    tRows++
    tInfl += t.influenceAfterSeed
    tDesc += t.descendantBeforeSeed
    tPeer += t.peerOutOfEra
    tSkip += t.skippedUnknownYear
  }
  if (tRows > 0) {
    console.log(
      `temporal audit (n=${tRows}): influence-after ${tInfl} · descendant-before ${tDesc} · peer-out-of-era ${tPeer} · year불명 스킵 ${tSkip}`
    )
  }

  // leap
  const leapStatus = new Map<string, number>()
  const verdictCount = new Map<string, number>()
  const dimsByVerdict = new Map<string, Map<string, number>>()
  const weakOverlap = new Map<string, number>()
  let leapOkRows = 0
  let verdictTotal = 0
  for (const r of rows) {
    const l = r.stats.leap
    if (!l) continue
    bump(leapStatus, l.status)
    if (l.status !== 'ok') continue
    leapOkRows++
    for (const v of l.verdicts ?? []) {
      verdictTotal++
      bump(verdictCount, v.verdict)
      const dm = dimsByVerdict.get(v.verdict) ?? new Map<string, number>()
      for (const d of v.dims) bump(dm, d)
      dimsByVerdict.set(v.verdict, dm)
      if (v.verdict === 'weak_leap') {
        for (const o of v.overlap) bump(weakOverlap, o)
      }
    }
  }
  const leapRows = [...leapStatus.values()].reduce((a, b) => a + b, 0)
  console.log(
    `leap: 감사 대상 큐레이션 ${leapRows}/${n} · status ${[...leapStatus.entries()].map(([k, v]) => `${k}=${v}`).join(' ') || '–'}`
  )
  let phaseBRows = 0
  let phaseBWeak = 0
  for (const r of rows) {
    if (r.stats.phaseB) {
      phaseBRows++
      phaseBWeak += r.stats.phaseB.weakExcluded
    }
  }
  if (phaseBRows > 0) {
    console.log(
      `  phase-b 집행: ${phaseBRows}건 · weak floor-제외 총 ${phaseBWeak} (보충 추가 픽은 미감사 — supplementAudited=false)`
    )
  }
  console.log(
    `  판정 (n=${verdictTotal})${lowSampleTag(verdictTotal)}: ${
      sortedEntries(verdictCount)
        .map(([k, v]) => `${k}=${v} (${pct(v, verdictTotal)})`)
        .join(' · ') || '–'
    }`
  )
  for (const [verdict, dm] of dimsByVerdict.entries()) {
    console.log(
      `  dims@${verdict}: ${sortedEntries(dm)
        .map(([k, v]) => `${k}×${v}`)
        .join(', ')}`
    )
  }
  const topOverlap = sortedEntries(weakOverlap).slice(0, 10)
  if (topOverlap.length > 0) {
    console.log(
      `  weak_leap 중첩 상위: ${topOverlap.map(([k, v]) => `${k}×${v}`).join(', ')}`
    )
  }

  // timings
  const keys = ['seed', 'ctx', 'sonnet', 'verify'] as const
  const parts: string[] = []
  for (const k of keys) {
    const vals = rows.map((r) => r.stats.timings[k]).sort((a, b) => a - b)
    parts.push(
      `${k} p50=${percentile(vals, 50) ?? '–'}ms p95=${percentile(vals, 95) ?? '–'}ms`
    )
  }
  const totals = rows
    .map(
      (r) =>
        r.stats.timings.seed +
        r.stats.timings.ctx +
        r.stats.timings.sonnet +
        r.stats.timings.verify
    )
    .sort((a, b) => a - b)
  console.log(
    `timings (n=${n}): TOTAL p50=${percentile(totals, 50) ?? '–'}ms p95=${percentile(totals, 95) ?? '–'}ms · ${parts.join(' · ')}`
  )
  // verify 내부 분해 (optional — 있는 행만 집계)
  const detailKeys = [
    'verifyFirst',
    'supplementSonnet',
    'supplementVerify',
  ] as const
  const detailParts: string[] = []
  for (const k of detailKeys) {
    const vals = rows
      .map((r) => r.stats.timings[k])
      .filter((v): v is number => typeof v === 'number')
      .sort((a, b) => a - b)
    if (vals.length > 0) {
      detailParts.push(
        `${k} p50=${percentile(vals, 50)}ms p95=${percentile(vals, 95)}ms (n=${vals.length})`
      )
    }
  }
  if (detailParts.length > 0) {
    console.log(`  verify 분해: ${detailParts.join(' · ')}`)
  }

  // 탈락 표본 (failSamples — 12캡/행)
  const samples = rows.flatMap((r) => r.stats.verify.failSamples ?? [])
  if (samples.length > 0) {
    console.log(`탈락 표본 (총 ${samples.length}건, 상위 10):`)
    for (const s of samples.slice(0, 10)) {
      console.log(
        `  - [${s.pass}/${s.reason}/${s.category}] ${s.artist} — ${s.track} ("${s.album}", ${s.year})${
          s.nearest
            ? ` → 최근접${s.nearest.artist ? ` ${s.nearest.artist} —` : ''}${s.nearest.track ? ` ${s.nearest.track}` : ''} ("${s.nearest.album}"${s.nearest.year ? `, ${s.nearest.year}` : ''})`
            : ''
        }`
      )
    }
  }

  // Phase B gate — 전체 세그먼트에서만 판정 (세그먼트별 표본으로 오독 금지)
  if (showGate) {
    const gateMet = leapOkRows >= 30 || verdictTotal >= 100
    console.log(
      `Phase B 게이트: leap-ok 큐레이션 ${leapOkRows} (기준 30) · 판정 ${verdictTotal} (기준 100) → ${gateMet ? '표본 충족' : '표본 미달'} — 카나리아 양방향 각 5건 수동 확인 전 자동 재분류 금지`
    )
  }
}

// --- main -----------------------------------------------------------------------

async function main(): Promise<void> {
  const sinceArg = process.argv.find((a) => a.startsWith('--since='))
  const since = sinceArg ? new Date(sinceArg.slice('--since='.length)) : null
  if (since && Number.isNaN(since.getTime())) {
    console.error(`--since 값이 날짜가 아닙니다: ${sinceArg}`)
    process.exit(1)
  }
  const calOnly = process.argv.includes('--calibration-only')
  const calExclude = process.argv.includes('--exclude-calibration')
  if (calOnly && calExclude) {
    console.error('--calibration-only와 --exclude-calibration은 동시에 못 씁니다.')
    process.exit(1)
  }

  const base = isNotNull(curations.pipelineStats)
  const fetched = await db
    .select({
      id: curations.id,
      parent: curations.parentCurationId,
      query: curations.query,
      createdAt: curations.createdAt,
      stats: curations.pipelineStats,
    })
    .from(curations)
    .where(since ? and(base, gte(curations.createdAt, since)) : base)

  const isCalibration = (q: string | null) =>
    q?.startsWith('[calibration]') ?? false
  const rows = fetched.filter((r) =>
    calOnly ? isCalibration(r.query) : calExclude ? !isCalibration(r.query) : true
  )

  // 방어적 파싱: v:1이고 집계가 실제로 만지는 하위 구조까지 온전한 행만 정식
  // 집계. 하위 키가 빠진 v1 행이 aggregate()를 크래시시키거나 NaN을 만들면
  // 안 된다.
  const isRecord = (x: unknown): x is Record<string, unknown> =>
    x !== null && typeof x === 'object' && !Array.isArray(x)
  const isV1 = (s: unknown): s is PipelineStatsV1 => {
    if (!isRecord(s) || s.v !== 1) return false
    const verify = s.verify
    if (
      !isRecord(verify) ||
      typeof verify.proposed !== 'number' ||
      typeof verify.verified !== 'number' ||
      typeof verify.droppedAsDuplicate !== 'number' ||
      typeof verify.droppedByDiversity !== 'number' ||
      typeof verify.droppedByInfra !== 'number' ||
      !isRecord(verify.failuresByReason) ||
      !isRecord(verify.byCategory)
    ) {
      return false
    }
    // nested 값 타입까지 — 문자열 하나가 섞인 파손 행이 NaN 집계를 만들면 안 됨.
    if (
      !Object.values(verify.failuresByReason).every(
        (x) => typeof x === 'number'
      )
    ) {
      return false
    }
    if (
      !Object.values(verify.byCategory).every(
        (c) =>
          isRecord(c) &&
          typeof c.proposed === 'number' &&
          typeof c.accepted === 'number'
      )
    ) {
      return false
    }
    const sup = s.supplement
    if (!isRecord(sup) || typeof sup.attempted !== 'boolean') return false
    const isWantArr = (x: unknown) =>
      x === undefined ||
      (Array.isArray(x) &&
        x.every(
          (d) =>
            isRecord(d) &&
            typeof d.category === 'string' &&
            typeof d.want === 'number'
        ))
    if (!isWantArr(sup.deficits) || !isWantArr(sup.requested)) return false
    if (sup.added !== undefined && typeof sup.added !== 'number') return false
    if (
      sup.outcome !== undefined &&
      !(
        typeof sup.outcome === 'string' &&
        [
          'ok',
          'empty',
          'filtered_empty',
          'schema_miss',
          'timeout',
          'failed',
        ].includes(sup.outcome)
      )
    ) {
      return false
    }
    if (sup.rawReturned !== undefined && typeof sup.rawReturned !== 'number') {
      return false
    }
    const fs = verify.failSamples
    if (
      fs !== undefined &&
      !(Array.isArray(fs) && fs.every((x) => isRecord(x)))
    ) {
      return false
    }
    const ta = s.categoryTemporalAudit
    if (
      ta !== undefined &&
      !(
        isRecord(ta) &&
        typeof ta.influenceAfterSeed === 'number' &&
        typeof ta.descendantBeforeSeed === 'number' &&
        typeof ta.peerOutOfEra === 'number' &&
        typeof ta.skippedUnknownYear === 'number'
      )
    ) {
      return false
    }
    const t = s.timings
    return (
      isRecord(t) &&
      typeof t.seed === 'number' &&
      typeof t.ctx === 'number' &&
      typeof t.sonnet === 'number' &&
      typeof t.verify === 'number'
    )
  }

  const valid: Row[] = []
  let futureV = 0
  let malformed = 0
  for (const r of rows) {
    const s = r.stats as unknown
    if (isV1(s)) {
      valid.push({ ...r, stats: s })
    } else if (isRecord(s) && typeof s.v === 'number' && s.v !== 1) {
      futureV++
    } else {
      malformed++
    }
  }

  console.log(
    `pipeline_stats 리포트${since ? ` (since ${since.toISOString().slice(0, 10)})` : ''}${
      calOnly ? ' [calibration만]' : calExclude ? ' [calibration 제외]' : ''
    }`
  )
  console.log(
    `행: 전체 ${rows.length} · v1 집계 대상 ${valid.length} · 미래 v ${futureV} · 파손 ${malformed}`
  )

  aggregate(valid, '전체', true)
  aggregate(valid.filter((r) => r.parent === null), '루트 큐레이션')
  aggregate(valid.filter((r) => r.parent !== null), '디깅 체인')
}

main()
  .then(() => {
    // neon-serverless Pool(websocket)이 프로세스를 붙잡는다 — 명시 종료.
    process.exit(0)
  })
  .catch((err) => {
    console.error(
      `리포트 실패: ${err instanceof Error ? err.message : String(err)}`
    )
    process.exit(1)
  })
