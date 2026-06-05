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
    }),
    size: z.number().int().min(1).max(20).default(12),
  }),
  z.object({ kind: z.literal('small_talk') }),
])

export type Intent = z.infer<typeof IntentSchema>

const SYSTEM_PROMPT = `너는 음악 큐레이션 챗봇의 의도 분류기다. 사용자의 한 줄 자연어 입력을 받아 2가지 의도 중 하나로 분류한다.

의도 종류:

1. kinship_curate — "이런 곡 같은 거 추천해줘" / "비슷한 거" 같은 신곡 추천 요청. 사용자가 곡을 (또는 아티스트+곡을) 언급하면 이쪽이다.
   - seed.type 은 항상 'track_text'.
   - track_query 는 "<artist> <track>" 형식으로 묶는다. 아티스트가 없으면 곡 제목만이라도 넣는다.
   - size 는 사용자가 명시한 숫자(없으면 12).

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
        },
        required: ['type', 'track_query'],
      },
      size: { type: 'integer', minimum: 1, maximum: 20 },
    },
  },
}

export async function classifyIntent(text: string): Promise<Intent> {
  try {
    const resp = await anthropic().messages.create({
      model: MODELS.intent,
      max_tokens: 1000,
      temperature: 0,
      system: SYSTEM_PROMPT,
      tools: [INTENT_TOOL],
      tool_choice: { type: 'tool', name: INTENT_TOOL.name },
      messages: [{ role: 'user', content: `사용자 입력: "${text}"` }],
    })

    const toolUse = resp.content.find((b) => b.type === 'tool_use')
    if (!toolUse || toolUse.type !== 'tool_use') {
      return { kind: 'small_talk' }
    }
    const parsed = IntentSchema.safeParse(toolUse.input)
    if (!parsed.success) return { kind: 'small_talk' }
    return parsed.data
  } catch {
    return { kind: 'small_talk' }
  }
}
