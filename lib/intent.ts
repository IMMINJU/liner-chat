import { z } from 'zod'
import { anthropic, MODELS } from './anthropic'

/*
 * Login-less mode collapses the intent space. Mode 1 (library_filter) and
 * list_top both depended on a synced user library, which no longer exists, so
 * the classifier only distinguishes:
 *   - kinship_curate: "recommend music like <track>" → seed is free text
 *   - small_talk: anything else
 *
 * The seed is always track_text now (the auto_top_recent / auto_dormant_liked
 * seeds were library-derived and are gone). If the user doesn't name a track,
 * we fall back to small_talk and the UI nudges them to name one.
 */

export const IntentSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('kinship_curate'),
    seed: z.object({
      type: z.literal('track_text'),
      track_query: z.string().min(1),
      // 아티스트/곡 제목 경계가 **확실할 때만** 채워지는 구조화 힌트 —
      // 있으면 시드 해석이 필드필터 검색을 1차로 시도한다(미스 시 free-text
      // 폴백이라 오파싱 최악은 낭비 콜 1회). 불확실하면 생략이 규칙.
      artist_hint: z.string().min(1).optional(),
      track_hint: z.string().min(1).optional(),
    }),
    // 사용자가 **명시적으로** 깊이/대중성을 조향한 경우만 채워진다
    // ("더 유명한/입문용" → mainstream, "더 깊게/희귀한/딥컷" → deep).
    // 부재/파싱 실패 → librarySophistication은 기존 'mixed' 유지.
    // 라이브러리 추론이 아니라 명시 입력 신호라 규약 10과 충돌하지 않는다
    // (CLAUDE.md 규약 10 참조).
    depth: z.enum(['mainstream', 'balanced', 'deep']).optional(),
    // NOTE: a `size` field used to live here but was never read downstream —
    // track count is governed by the kinship schema floors + verify attrition.
    // Removed rather than pretending "20곡 추천해줘" changes anything. If
    // count control ever becomes a product feature, design it end-to-end
    // (max_tokens, floors, verify budget) instead of resurrecting the field.
  }),
  z.object({ kind: z.literal('small_talk') }),
])

export type Intent = z.infer<typeof IntentSchema>

const SYSTEM_PROMPT = `너는 음악 큐레이션 챗봇의 의도 분류기다. 사용자의 한 줄 자연어 입력을 받아 2가지 의도 중 하나로 분류한다.

의도 종류:

1. kinship_curate — "이런 곡 같은 거 추천해줘" / "비슷한 거" 같은 신곡 추천 요청. 사용자가 곡을 (또는 아티스트+곡을) 언급하면 이쪽이다.
   - seed.type 은 항상 'track_text'.
   - track_query 는 "<artist> <track>" 형식으로 묶는다. 아티스트가 없으면 곡 제목만이라도 넣는다.
   - 아티스트와 곡 제목의 **경계가 확실할 때만** artist_hint 와 track_hint 를 각각 넣어라 (예: "Tame Impala Elephant 같은 거" → artist_hint="Tame Impala", track_hint="Elephant"). 경계가 조금이라도 불확실하면 두 힌트 모두 생략하라 — 잘못 쪼개는 것이 안 쪼개는 것보다 해롭다.
   - depth 는 사용자가 **명시적으로** 깊이/대중성을 조향할 때만 넣는다: "더 유명한 걸로"/"입문용"/"대중적인" → 'mainstream', "더 깊게"/"희귀한"/"안 알려진"/"딥컷" → 'deep'. 그런 표현이 없으면 depth 자체를 생략하라 (추측 금지).

2. small_talk — 추천 대상 곡이 분명하지 않은 일반 대화/인사/도움 요청, 또는 곡을 특정하지 못한 모호한 추천 요청.

출력은 반드시 submit_intent tool 호출. 곡을 특정할 수 없으면 small_talk을 골라라.`

const INTENT_TOOL = {
  name: 'submit_intent',
  description: '분류된 의도를 제출한다.',
  input_schema: {
    type: 'object' as const,
    required: ['kind'],
    properties: {
      kind: {
        type: 'string',
        enum: ['kinship_curate', 'small_talk'],
      },
      seed: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['track_text'] },
          track_query: { type: 'string' },
          artist_hint: {
            type: 'string',
            description: '아티스트/곡 경계가 확실할 때만. 불확실하면 생략.',
          },
          track_hint: {
            type: 'string',
            description: '아티스트/곡 경계가 확실할 때만. 불확실하면 생략.',
          },
        },
        required: ['type', 'track_query'],
      },
      depth: {
        type: 'string',
        enum: ['mainstream', 'balanced', 'deep'],
        description:
          '사용자가 명시적으로 깊이/대중성을 조향한 경우만. 명시 없으면 생략.',
      },
    },
  },
}

// Haiku classification is normally 1-3s. Without a local cap, a wedged call
// rides the SDK's 90s backstop and eats the 110s chat budget before the
// curator even starts. 8s is generous for Haiku; on timeout we degrade to
// small_talk (the existing catch path) — the UI nudges the user to retry.
const INTENT_TIMEOUT_MS = 8_000

export async function classifyIntent(text: string): Promise<Intent> {
  const controller = new AbortController()
  const timeoutId = setTimeout(
    () => controller.abort(new Error('intent timeout')),
    INTENT_TIMEOUT_MS
  )
  try {
    const resp = await anthropic().messages.create(
      {
        model: MODELS.intent,
        max_tokens: 1000,
        temperature: 0,
        system: SYSTEM_PROMPT,
        tools: [INTENT_TOOL],
        tool_choice: { type: 'tool', name: INTENT_TOOL.name },
        messages: [{ role: 'user', content: `사용자 입력: "${text}"` }],
      },
      { signal: controller.signal }
    )

    const toolUse = resp.content.find((b) => b.type === 'tool_use')
    if (!toolUse || toolUse.type !== 'tool_use') {
      return { kind: 'small_talk' }
    }
    const parsed = IntentSchema.safeParse(toolUse.input)
    if (!parsed.success) return { kind: 'small_talk' }
    return parsed.data
  } catch {
    return { kind: 'small_talk' }
  } finally {
    clearTimeout(timeoutId)
  }
}
