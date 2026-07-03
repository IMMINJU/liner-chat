/**
 * scripts/calibrate-pipeline.ts — 파이프라인 캘리브레이션 러너.
 *
 * 단일 사용자 앱은 유기적 트래픽만으로 leap Phase B 게이트(leap-ok ≥30 또는
 * 판정 ≥100)에 도달할 수 없다. 이 러너가 카논+확장 시드로 runCuration 전체를
 * 순차 실행해 curations.pipeline_stats 표본을 능동 축적한다. 부수 실측:
 * canonicalize 발동률, Last.fm wiki 커버리지(#5 채택 판단용 — 프롬프트에는
 * 아직 안 넣음).
 *
 * ⚠ 실행마다 실제 비용 발생: 시드당 Sonnet 1~2콜 + Spotify/Last.fm 수십 콜 +
 *   DB 행 생성. 그래서 --yes 없이는 계획만 출력하고 종료한다.
 *
 * Run:      pnpm tsx scripts/calibrate-pipeline.ts --yes [--chain]
 * Requires: DATABASE_URL, ANTHROPIC_API_KEY, SPOTIFY_CLIENT_ID/SECRET,
 *           LASTFM_API_KEY (.env.local/.env 자체 로딩)
 *
 * --chain: 각 루트 큐레이션 성공 시 첫 kinship 픽으로 1단계 디깅 체인도 실행
 *          (chainNarrative·축 힌트 경로 표본화).
 *
 * 저장되는 query에는 "[calibration]" 마커가 붙는다 — report 스크립트가
 * --calibration-only / --exclude-calibration으로 분리 집계하고, curator는
 * 마커를 스트립해 프롬프트(userNote)에 들어가지 않게 한다.
 */

import { runCuration } from '@/lib/curator'

// --- env (report 스크립트와 동일 패턴; 앱 모듈은 전부 lazy-init이라 import
// 시점엔 env를 안 읽는다 — 로딩을 여기서 해도 안전) ---------------------------
for (const f of ['.env.local', '.env']) {
  try {
    process.loadEnvFile(f)
  } catch {
    // 파일 없어도 됨
  }
}
const REQUIRED_ENV = [
  'DATABASE_URL',
  'ANTHROPIC_API_KEY',
  'SPOTIFY_CLIENT_ID',
  'SPOTIFY_CLIENT_SECRET',
  'LASTFM_API_KEY',
]
const missing = REQUIRED_ENV.filter((k) => !process.env[k])
if (missing.length > 0) {
  console.error(`환경변수 누락: ${missing.join(', ')} — .env.local 확인.`)
  process.exit(1)
}

/**
 * 시드 믹스 설계 (특정 장르 과적합 방지 — codex 지적 반영):
 * - 카논 5 (docs/kinship-prompt.md 테스트 시드와 동일 계열)
 * - leap 카나리아: NewJeans "Attention" (weak_leap이 잡혀야 함),
 *   The Doors "L.A. Woman" (La Grange류는 exception_nonobvious로 분리돼야 함)
 * - 한글↔로마자 표기 케이스: 아이유 (not_found 수리 힌트 실측)
 * - 일관형 시드: Placebo (여정형과 대비)
 */
const SEEDS: string[] = [
  'Tame Impala Elephant',
  'Sex Pistols God Save the Queen',
  'The Doors L.A. Woman',
  'Dire Straits Sultans of Swing',
  'Radiohead Creep',
  'NewJeans Attention',
  '아이유 좋은 날',
  "Placebo Without You I'm Nothing",
]

// 시드 사이 간격 — Anthropic/Spotify 배려 + 프롬프트 캐시(5분 TTL) 히트 유지.
const GAP_MS = 5_000

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// --- Last.fm wiki 커버리지 실측 (#5 채택 판단용 — 런타임 미주입) ----------------
async function probeWiki(
  artist: string,
  track: string
): Promise<{ hasWiki: boolean; summaryLen: number; listeners: number | null }> {
  try {
    const qs = new URLSearchParams({
      method: 'track.getInfo',
      artist,
      track,
      autocorrect: '1',
      api_key: process.env.LASTFM_API_KEY as string,
      format: 'json',
    })
    const res = await fetch(`https://ws.audioscrobbler.com/2.0/?${qs}`, {
      headers: { 'User-Agent': 'liner-chat/0.1 calibration' },
      signal: AbortSignal.timeout(5_000),
    })
    if (!res.ok) return { hasWiki: false, summaryLen: 0, listeners: null }
    const json = (await res.json()) as {
      track?: {
        wiki?: { summary?: string }
        listeners?: string
      }
    }
    const summary = json.track?.wiki?.summary ?? ''
    const listeners = json.track?.listeners
      ? Number(json.track.listeners)
      : null
    return {
      hasWiki: summary.trim().length > 0,
      summaryLen: summary.trim().length,
      listeners: Number.isFinite(listeners) ? listeners : null,
    }
  } catch {
    return { hasWiki: false, summaryLen: 0, listeners: null }
  }
}

async function main(): Promise<void> {
  const yes = process.argv.includes('--yes')
  const chain = process.argv.includes('--chain')

  const rootRuns = SEEDS.length
  const maxRuns = chain ? rootRuns * 2 : rootRuns
  console.log(
    `캘리브레이션 계획: 루트 ${rootRuns}건${chain ? ` + 체인 ≤${rootRuns}건` : ''} = 최대 ${maxRuns} 큐레이션`
  )
  console.log(
    `예상 비용: 큐레이션당 Sonnet 1~2콜(입력 대부분 캐시) + Spotify/Last.fm 수십 콜 · 간격 ${GAP_MS / 1000}s`
  )
  console.log(`시드: ${SEEDS.join(' | ')}`)
  if (!yes) {
    console.log('\n실행하려면 --yes를 붙이세요 (비용 확인용 가드).')
    process.exit(1)
  }

  let ok = 0
  let failed = 0
  for (const [i, seedQuery] of SEEDS.entries()) {
    console.log(`\n[${i + 1}/${SEEDS.length}] "${seedQuery}"`)
    try {
      const result = await runCuration({
        query: `[calibration] ${seedQuery}`,
        seed: { type: 'track_text', track_query: seedQuery },
      })
      if (!result.ok) {
        failed++
        console.log(`  ✗ ${result.code}: ${result.message}`)
      } else {
        ok++
        const total = Object.values(result.categories).reduce(
          (a, c) => a + c.length,
          0
        )
        console.log(
          `  ✓ curation #${result.curationId} · ${total}곡 (kinship ${result.categories.kinship.length}) · verify ${result.stats.verifiedOnSpotify}/${result.stats.proposedByLLM}`
        )
        // wiki 커버리지 실측 (해석된 시드 기준)
        const w = await probeWiki(result.seed.artist, result.seed.name)
        console.log(
          `  wiki: ${w.hasWiki ? `있음 (${w.summaryLen}자)` : '없음'}${w.listeners !== null ? ` · listeners ${w.listeners}` : ''}`
        )
        // 1단계 체인 (첫 kinship 픽 → 없으면 스킵)
        if (chain) {
          const dig = result.categories.kinship[0]
          if (dig) {
            await sleep(GAP_MS)
            console.log(`  ↳ chain: "${dig.artist} — ${dig.name}"`)
            const child = await runCuration({
              query: `[calibration] chain from #${result.curationId}`,
              seed: { type: 'track_id', track_id: dig.id },
              parentCurationId: result.curationId,
            })
            if (child.ok) {
              ok++
              console.log(`    ✓ curation #${child.curationId}`)
            } else {
              failed++
              console.log(`    ✗ ${child.code}: ${child.message}`)
            }
          } else {
            console.log('  ↳ chain 스킵 (kinship 픽 없음)')
          }
        }
      }
    } catch (err) {
      failed++
      console.log(
        `  ✗ 예외: ${err instanceof Error ? err.message : String(err)}`
      )
    }
    if (i < SEEDS.length - 1) await sleep(GAP_MS)
  }

  console.log(
    `\n완료: 성공 ${ok} · 실패 ${failed} — 이제 리포트를 보세요:\n  pnpm tsx scripts/report-pipeline-stats.ts --calibration-only`
  )
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(
      `러너 실패: ${err instanceof Error ? err.message : String(err)}`
    )
    process.exit(1)
  })
