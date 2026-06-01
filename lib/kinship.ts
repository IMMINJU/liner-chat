import { z } from 'zod'
import { anthropic, MODELS } from './anthropic'

export const CATEGORIES = [
  'influence',
  'peer',
  'descendant',
  'kinship',
] as const
export type Category = (typeof CATEGORIES)[number]

export const LINK_DIMENSIONS = [
  'mood',
  'structure',
  'texture',
  'narrative',
  'groove',
  'vocal_style',
  'melody',
  'progression',
] as const
export type LinkDimension = (typeof LINK_DIMENSIONS)[number]

const TrackRecSchema = z.object({
  category: z.enum(CATEGORIES),
  artist: z.string().min(1),
  track: z.string().min(1),
  album: z.string().min(1),
  year: z.number().int().min(1900).max(2100),
  sonic_link: z.string().min(1),
  link_dimensions: z.array(z.enum(LINK_DIMENSIONS)).min(1).max(3),
})

export const KinshipResponseSchema = z
  .object({
    lineage_notes: z.string().min(20),
    tracks: z.array(TrackRecSchema),
  })
  .refine(
    (r) => {
      const byCat = (cat: Category) =>
        r.tracks.filter((t) => t.category === cat).length
      // Second relaxation pass after Sonnet was still hitting wall-clock
      // caps in production: 2/2/2/3 → 2/2/1/2 = 7 tracks minimum (down
      // from 9). Kinship still has the higher floor since it's the
      // category that justifies the whole product, but each supporting
      // category only needs to land one or two strong picks. The prompt
      // body further down was updated in lockstep.
      return (
        byCat('influence') >= 2 &&
        byCat('peer') >= 2 &&
        byCat('descendant') >= 1 &&
        byCat('kinship') >= 2
      )
    },
    { message: '카테고리별 최소 개수 미달 (influence≥2, peer≥2, descendant≥1, kinship≥2)' }
  )

export type KinshipResponse = z.infer<typeof KinshipResponseSchema>
export type TrackRec = z.infer<typeof TrackRecSchema>

export type SeedContext = {
  track: { name: string; artist: string; album: string; year: number }
  spotifyGenres: string[]
  lastfmTrackTags: string[]
  lastfmArtistTags: string[]
  audio: Partial<{
    energy: number
    valence: number
    tempo: number
    acousticness: number
    danceability: number
    instrumentalness: number
  }>
  tonal: Partial<{
    key: string
    mode: 'major' | 'minor'
    time_signature: number
  }>
  listenerProfile: {
    seedPopularity: number
    librarySophistication: 'mainstream' | 'mixed' | 'obscure'
  }
}

const SYSTEM_PROMPT = `너는 음악 평론가이자 큐레이터다. 사용자가 좋아한다고 알려주는 시드 곡 1곡을 받고, 두 층위로 분석한다:

(1) 전체 정조(overarching register) — 곡 전체를 처음부터 끝까지 관통하는 정서적·음향적 색. "이 곡은 어떤 방인가?" 예: Placebo "Without You I'm Nothing"은 시작부터 끝까지 자기혐오적 음울함이 한 색으로 일관된다. The Doors "L.A. Woman"은 한 색이 아니라 질주에서 명상으로 이동하는 여정이다.

(2) 음악적 순간(sonic moment) — 곡 안의 특정 구간/요소(보컬 톤, 편곡, 그루브, 에너지 곡선, 가사 화법, 절정의 폭발 등).

그리고 시드가 "일관형"인지 "여정형"인지 스스로 판단한 뒤 추천 전략을 바꾼다:

- 일관형 시드 (Placebo처럼 곡 전체가 한 정조) → 추천곡도 그 정조를 곡 전체에 두른 곡을 골라라. "밝게 시작해 어두워지는" 식으로 부분적으로만 시드의 색에 닿는 곡은 피한다. 큐레이션 전체가 하나의 일관된 방이 되도록.
- 여정형 시드 (L.A. Woman처럼 전환·여정이 있는 곡) → 전체 정조보다 sonic moment의 가로지름을 우선한다. 시대·장르를 넘는 친족을 적극 찾아라.

이 판단을 lineage_notes 첫머리에 한 줄로 밝혀라.

핵심(사용자 피드백): "곡들은 잘 뽑혔는데 이음새가 없다. 원곡은 처음부터 일관되게 비참한데 다른 곡들은 부분적으로만 동참한다. 큐레이션 전체에 맥락이 있었으면 좋겠다." 일관형 시드일수록 개별 곡이 시드와 점으로 닿는 데 그치지 말고, 추천된 곡들이 서로서로도 한 정조로 묶여 면을 이루도록 하라.

반드시 지켜야 할 사고 원칙:

1. 트랙 단위로 답한다. "이 아티스트 좋을 거예요" 같은 추천 금지. 특정 곡(앨범+연도까지) 명시.

2. 아티스트의 잘 알려진 곡일 필요 없다. 그 아티스트의 곡 중 시드와 가장 잘 맞는 것을 골라라. 예: Sex Pistols 시드라면 Beatles "Hey Jude"가 아니라 "Birthday" (White Album)의 중간부 펑크 폭발. 단 일관형 시드일 때는 곡의 한 순간만 맞는 곡(예: Bowie "Rock 'n' Roll Suicide"는 어쿠스틱하게 시작해 절정에서만 폭발 — Placebo의 시종일관 음울함과는 전체 정조가 다르다)을 고르지 말고, 곡 전체가 시드의 정조와 같은 온도인 곡을 우선하라.

3. 음악적 느낌은 시대/장르가 달라져도 일관되게 나온다. 70년대 펑크 시드라면 1968년의 비틀즈 곡 안에 있는 펑크적 순간도 답이 된다.

4. 메타-친족(kinship)을 적극적으로 찾아라. 장르·시대·국적·팬층이 모두 달라도 음악적 DNA가 통하는 곡들. 다음은 사용자가 직접 든 친족 예시이며, 이 종류의 연결을 만들어내는 것이 이 프로젝트의 핵심이다:
   - Tame Impala "Elephant" (2012, 호주, 사이키 록) ↔ John Lennon "Well Well Well" (1970, 영국, 록) — 거친 보컬·헤비 디스토션·펑크적 폭발
   - Sex Pistols "God Save the Queen" (1977, 영국, 펑크) ↔ The Beatles "Birthday" (1968, 영국, 록앤롤) — 중간부 펑크 폭발 그루브
   - The Doors "L.A. Woman" (1971, 미국, 사이키/블루스 록) ↔ Dire Straits "Sultans of Swing" (1978, 영국, 록 컨트리 포크) — 롱폼 어쿠스틱 그루브·내러티브 보컬·도시 풍경
   - Dire Straits "Sultans of Swing" ↔ Bob Dylan "Things Have Changed" (2000, 미국, 포크 록) — 블루지 톤·읊조리는 창법·내러티브

5. 창법(vocal_style)은 가장 강력한 친족 신호 중 하나다. Jim Morrison · Mark Knopfler · Bob Dylan처럼 노래를 '부른다'기보다 읊조리거나 내뱉는 보컬은 시대·장르·국적을 가로지르는 연결고리다. 보컬 톤·억양·화법을 적극 활용하라.

6. 멜로디(melody)와 화성 진행(progression)을 적극 분석하라. 후렴 모티프, 보컬 멜로디의 윤곽(상승/하강/도약), 멜로디 후크의 위치·반복 패턴은 시대를 넘는 친족 신호다. 코드 진행 패턴(I-V-vi-IV 류 매크로 진행), 모달 vs 토널, 브릿지/후렴 전환 방식, 키 모듈레이션도 마찬가지. 예: Beatles "Birthday" 중간 8마디의 반음계적 진행이 Sex Pistols 시드의 직진성과 통하는 식. (참고: Spotify가 audio_features/audio_analysis를 신규 앱에 비공개 전환했으므로 key/mode/tempo 같은 토널 메타데이터는 컨텍스트에 들어오지 않는다. 너의 음악 지식만으로 판단하라.)

7. 추천 신호의 우선순위:
   (1) External evidence (외부 사실) — 시드 아티스트와 추천 아티스트 사이의 직접 증거: 공동작/featuring, 투어 오프닝/헤드라이너, 인터뷰에서 직접 영향원으로 언급, 트리뷰트 앨범 참여, 같은 슈퍼그룹 멤버. 이게 잡힐 때는 무조건 표면화하고 sonic_link에 그 사실을 명시한다. (예: "Tame Impala가 Lennon 트리뷰트 무대에서 직접 연주", "Dire Straits의 Knopfler가 Dylan의 'Slow Train Coming'에 기타 연주").
   (2) Lineage (계보) — 영향원/동시대/후속. 시대·장르·국적의 일관성.
   (3) Production identity (프로덕션 정체성) — 같은 프로듀서(예: Brian Eno, Rick Rubin), 같은 엔지니어, 같은 레이블의 음향 색깔(Motown, Stax, ECM, 4AD 등).
   (4) Sonic identity (소닉 정체성) — 위에 정의된 8개 link_dimensions.
   (1)이 잡히는 추천을 우선 채워라. 못 찾으면 (2)→(3)→(4)로 내려간다. 모든 추천이 (1)일 필요는 없다(추천 풀의 다양성을 위해 섞는다).
   모르면 만들지 마라. 외부 사실을 sonic_link에 쓰려면 확실한 것만. 추측이면 쓰지 말고 다른 차원(계보/소닉)으로 가라.

8. 청취자 친숙도 조정 (Listener accessibility tuning): 시드 컨텍스트에 listenerProfile이 전달된다.
   - librarySophistication: "mainstream" | "mixed" | "obscure" — 사용자 라이브러리 평균 popularity 기반.
   - seedPopularity: 0~100 — 시드 곡 자체의 popularity.
   조정 원칙:
   - obscure 청취자 + 시드도 deep cut → 더 깊이 파고든다. 잘 알려진 곡(예: "Creep")은 추천 풀에서 배제. 4AD/Kranky/Drag City 류, 미발매·EP·세션 트랙, 평론가의 '잊힌 보물' 류를 우선.
   - mainstream 청취자 + 시드도 hit → 추천이 너무 deep으로 가면 청취자가 못 따라온다. 인접 장르의 입문급 곡, 대중적 히트지만 음악적 친족인 곡을 우선. 예: "Creep"을 좋아하는 K-인디·발라드 청취자에게는 루시드폴·Coldplay·Snow Patrol 류의 멜로디적 다리.
   - mixed → 양 끝을 섞되 약간의 발견(±1단계) 쪽으로 기울인다.
   - 시드가 hit인데 청취자는 obscure → 청취자가 그 hit를 "guilty pleasure"로 듣는 케이스. deep cut만 추천하지 말고 시드의 정체성을 가진 다른 hit도 일부 포함.
   이 조정은 추천 풀의 선별 기준이지 카테고리 추가가 아니다. 4 카테고리(influence/peer/descendant/kinship)는 그대로 유지.

9. 협업필터링 식 추천 금지. "이 곡 들은 사람들이 또 들은 곡"이 아니라 음악적 정체성이 통하는 곡.

카테고리별 최소 개수:
- influences (≥2): 시드가 영향받은 선배 아티스트의 곡
- peers (≥2): 같은 시기 비슷한 정체성의 곡
- descendants (≥1): 시드의 사운드를 계승한 후배 곡
- kinship (≥2, 이게 핵심): 장르·시대·국적이 다르지만 음악적 친족인 곡

총 7곡 최소. 적게 보여도 강한 추천이 길고 약한 추천보다 낫다. sonic_link는 반드시 한 문장(또는 짧은 두 문장)으로 끝내라 — 응답이 길수록 사용자가 못 본다.

각 곡마다 채워야 할 필드:
- artist, track, album, year — 검증에 사용되므로 정확하게.
- sonic_link: 한국어 1-2문장. 그 곡의 어떤 요소/구간(예: "2분 30초 무렵의 디스토션 솔로", "마지막 후렴의 비명에 가까운 보컬")이 시드의 어떤 sonic moment와 어떻게 연결되는지 구체적으로. 외부 사실이 확실하면 그 사실을 명시.
- link_dimensions: 연결이 일어나는 차원. 8종 중 1~3개. 이 enum에 없는 값 사용 금지.
  - mood: 분위기 (도시적·우울·황홀·긴장 등)
  - structure: 곡의 거시 구성 (롱폼·빌드업·솔로 비중·코다 페이드)
  - texture: 사운드 텍스처 (어쿠스틱/일렉트릭 비율·공간감·드라이/웻·왜곡 정도)
  - narrative: 가사 화법 (1인칭 관찰자·묘사적·서사적)
  - groove: 그루브감 (스윙·셔플·록 직진·폴리리듬)
  - vocal_style: 창법 (읊조림·내뱉기·벨팅·휘파람 톤·내레이션)
  - melody: 멜로디 라인 (후렴 모티프·보컬 멜로디 윤곽·멜로디 후크의 위치·반복 패턴)
  - progression: 화성·진행 방식 (코드 진행 패턴·모달 vs 토널·브릿지/후렴 전환·키 모듈레이션)

lineage_notes (큐레이터의 의도): 2-3문장 한국어. AccuRadio의 채널 헤더처럼, 이 큐레이션이 어떤 테마/방향인지 한눈에 알 수 있게. 첫 문장은 시드가 일관형인지 여정형인지 + 이 큐레이션 전체가 어떤 "방"인지(어떤 정조로 묶이는지)를 밝혀라. 그다음 시드의 무엇을 들었고 어떤 발견을 하게 하려는지, 청취자 프로파일 조정 결과를 녹인다. 단순히 "비슷한 곡을 모았다"가 아니라 "이 곡들이 함께 어떤 정서적 공간을 만드는지"를 규정해야 한다.

예시 — 시드 Radiohead "Creep", listenerProfile=obscure:
"Creep을 거치지 않은 청취자는 적지만, 이 큐레이션은 그 곡의 '갇힌 자기혐오'와 quiet/loud 다이내믹을 더 어둡고 비주류로 파고든다. 90s shoegaze·slowcore의 자기 파괴적 미학을 시드의 헤드/심장 부위에서 잇는다."

예시 — 시드 Radiohead "Creep", listenerProfile=mainstream:
"Creep의 멜랑콜리한 후렴과 멜로디적 진심을 다리로, 인디·발라드 청취자에게 영국 록의 깊은 정서적 영역을 소개한다. 더 어둡거나 실험적인 길은 다음 단계에 남겨둔다."`

const KINSHIP_TOOL = {
  name: 'submit_kinship_curation',
  description: '분석한 lineage_notes와 4 카테고리 트랙 추천을 제출한다.',
  input_schema: {
    type: 'object' as const,
    required: ['lineage_notes', 'tracks'],
    properties: {
      lineage_notes: {
        type: 'string',
        description: '시드 분석 + 큐레이션 의도 2-3문장 한국어',
      },
      tracks: {
        type: 'array',
        items: {
          type: 'object',
          required: [
            'category',
            'artist',
            'track',
            'album',
            'year',
            'sonic_link',
            'link_dimensions',
          ],
          properties: {
            category: { type: 'string', enum: [...CATEGORIES] },
            artist: { type: 'string' },
            track: { type: 'string' },
            album: { type: 'string' },
            year: { type: 'integer', minimum: 1900, maximum: 2100 },
            sonic_link: { type: 'string' },
            link_dimensions: {
              type: 'array',
              minItems: 1,
              maxItems: 3,
              items: { type: 'string', enum: [...LINK_DIMENSIONS] },
            },
          },
        },
      },
    },
  },
}

function renderUserMessage(ctx: SeedContext): string {
  const audioLines: string[] = []
  const a = ctx.audio
  if (a.energy !== undefined) audioLines.push(`- energy: ${a.energy.toFixed(2)}`)
  if (a.valence !== undefined) audioLines.push(`- valence: ${a.valence.toFixed(2)}`)
  if (a.tempo !== undefined) audioLines.push(`- tempo: ${a.tempo.toFixed(0)} BPM`)
  if (a.acousticness !== undefined) audioLines.push(`- acousticness: ${a.acousticness.toFixed(2)}`)
  if (a.danceability !== undefined) audioLines.push(`- danceability: ${a.danceability.toFixed(2)}`)
  if (a.instrumentalness !== undefined) audioLines.push(`- instrumentalness: ${a.instrumentalness.toFixed(2)}`)

  const tonalLines: string[] = []
  const t = ctx.tonal
  if (t.key) tonalLines.push(`- key: ${t.key}`)
  if (t.mode) tonalLines.push(`- mode: ${t.mode}`)
  if (t.time_signature) tonalLines.push(`- time_signature: ${t.time_signature}`)

  return [
    `시드 곡:`,
    `- "${ctx.track.name}" by ${ctx.track.artist}`,
    `- 앨범: ${ctx.track.album} (${ctx.track.year})`,
    ``,
    `Spotify 아티스트 장르: ${ctx.spotifyGenres.length ? ctx.spotifyGenres.join(', ') : '정보 없음'}`,
    `Last.fm 트랙 태그: ${ctx.lastfmTrackTags.length ? ctx.lastfmTrackTags.slice(0, 10).join(', ') : '정보 없음'}`,
    `Last.fm 아티스트 태그: ${ctx.lastfmArtistTags.length ? ctx.lastfmArtistTags.slice(0, 10).join(', ') : '정보 없음'}`,
    audioLines.length ? `Audio features:\n${audioLines.join('\n')}` : `Audio features: 정보 없음`,
    tonalLines.length ? `토널 정보:\n${tonalLines.join('\n')}` : ``,
    ``,
    `청취자 프로파일:`,
    `- librarySophistication: ${ctx.listenerProfile.librarySophistication}`,
    `- seedPopularity: ${ctx.listenerProfile.seedPopularity}`,
    ``,
    `이 시드의 sonic moment를 분석하고, 8개 link_dimensions와 4 카테고리에 맞게 트랙을 추천해줘. 신호 우선순위(외부 사실 → 계보 → 프로덕션 → 소닉)와 청취자 친숙도 조정 원칙을 반드시 적용해라. lineage_notes는 큐레이터의 의도가 드러나도록 써라.`,
  ].filter(Boolean).join('\n')
}

export class KinshipLLMError extends Error {
  constructor(message: string, public details?: unknown) {
    super(message)
    this.name = 'KinshipLLMError'
  }
}

// Hard wall-clock cap on a Sonnet call. The SDK's own `timeout` option was
// not being honored in production — a kinship call that hit it just kept
// running until Vercel killed the whole function at 60s with no log line in
// between. We belt-and-suspender it now: pass a fresh AbortController via
// `signal` (which the SDK does respect) AND race against a manual setTimeout
// so if even the signal is dropped, we still throw before the platform does.
const SONNET_CALL_TIMEOUT_MS = 35_000

/**
 * Call Sonnet with the seed context. Forces the submit_kinship_curation tool.
 * Validates with zod; on validation failure, retries once with feedback.
 */
export async function recommendKinship(
  ctx: SeedContext
): Promise<KinshipResponse> {
  const userMessage = renderUserMessage(ctx)

  async function callOnce(extraNote?: string): Promise<KinshipResponse> {
    const tStart = Date.now()
    const controller = new AbortController()
    const timeoutId = setTimeout(
      () => controller.abort(new Error('local timeout')),
      SONNET_CALL_TIMEOUT_MS
    )

    let resp
    try {
      const apiCall = anthropic().messages.create(
        {
          model: MODELS.kinship,
          // Second budget cut after 3000 was still letting Sonnet write
          // past the 35s SDK timeout. 2000 covers ~7 tracks of
          // (artist+track+album+year+short sonic_link+link_dimensions)
          // plus a 3-line lineage_notes. The "shorter sonic_link" rule
          // in the system prompt does most of the work — this is the
          // hard cap that backs it.
          max_tokens: 2000,
          // 0.6 is the sweet spot for this product: low enough that song
          // titles and artists don't drift into hallucination (which would
          // get dropped by Spotify verify and force a retry, costing us
          // wall-clock), high enough that the kinship category keeps
          // surfacing the non-obvious cross-genre picks that justify the
          // whole product. We briefly tried 0.4 thinking it would shave
          // time — no measurable effect, just safer recs.
          temperature: 0.6,
          system: SYSTEM_PROMPT,
          tools: [KINSHIP_TOOL],
          tool_choice: { type: 'tool', name: KINSHIP_TOOL.name },
          messages: [
            {
              role: 'user',
              content: extraNote
                ? `${userMessage}\n\n[재시도 메모: ${extraNote}]`
                : userMessage,
            },
          ],
        },
        { signal: controller.signal }
      )

      // Backstop race: if the SDK swallows the abort signal for any reason
      // (it has in the past on some Vercel runtimes), this still throws and
      // lets the curator's catch turn it into an `llm_failed`.
      const localTimeout = new Promise<never>((_, reject) => {
        setTimeout(
          () =>
            reject(
              new KinshipLLMError(
                `Sonnet call exceeded ${SONNET_CALL_TIMEOUT_MS}ms (local race)`
              )
            ),
          SONNET_CALL_TIMEOUT_MS + 1_000
        )
      })

      resp = await Promise.race([apiCall, localTimeout])
      console.log(`[kinship] sonnet call ${Date.now() - tStart}ms`)
    } catch (err) {
      console.log(
        `[kinship] sonnet FAILED after ${Date.now() - tStart}ms: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
      if (err instanceof KinshipLLMError) throw err
      throw new KinshipLLMError(
        `Sonnet call failed: ${err instanceof Error ? err.message : String(err)}`,
        err
      )
    } finally {
      clearTimeout(timeoutId)
    }

    const toolUse = resp.content.find((b) => b.type === 'tool_use')
    if (!toolUse || toolUse.type !== 'tool_use') {
      throw new KinshipLLMError('Sonnet이 tool을 호출하지 않았습니다.')
    }
    const parsed = KinshipResponseSchema.safeParse(toolUse.input)
    if (!parsed.success) {
      throw new KinshipLLMError(
        'Sonnet 응답이 스키마를 만족하지 못함',
        parsed.error.flatten()
      )
    }
    return parsed.data
  }

  try {
    return await callOnce()
  } catch (err) {
    if (err instanceof KinshipLLMError) {
      // One retry with the validation message as feedback.
      return await callOnce(err.message)
    }
    throw err
  }
}
