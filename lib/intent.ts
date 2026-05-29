import { z } from 'zod'
import { anthropic, MODELS } from './anthropic'
import { extractGenresFromText } from './genre-aliases'
import { GENRE_KEYS, type GenreKey } from './genre-dictionary'

const GenreEnum = z.enum(
  GENRE_KEYS as unknown as readonly [GenreKey, ...GenreKey[]]
)

export const IntentSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('library_filter'),
    genres: z.array(GenreEnum).min(1),
    limit: z.number().int().min(1).max(100).default(30),
    min_score: z.number().min(0).max(1).default(0.5),
  }),
  z.object({
    kind: z.literal('kinship_curate'),
    seed: z.discriminatedUnion('type', [
      z.object({
        type: z.literal('track_text'),
        track_query: z.string().min(1),
      }),
      z.object({ type: z.literal('auto_top_recent') }),
      z.object({ type: z.literal('auto_dormant_liked') }),
    ]),
    size: z.number().int().min(1).max(20).default(12),
  }),
  z.object({
    kind: z.literal('list_top'),
    time_range: z.enum(['short_term', 'medium_term', 'long_term']),
    limit: z.number().int().min(1).max(100).default(20),
  }),
  z.object({ kind: z.literal('small_talk') }),
])

export type Intent = z.infer<typeof IntentSchema>

const SYSTEM_PROMPT = `너는 음악 큐레이션 챗봇의 의도 분류기다. 사용자의 한 줄 자연어 입력을 받아 4가지 의도 중 하나로 분류한다.

의도 종류:

1. library_filter — 내 라이브러리에서 특정 장르 곡을 보여달라는 요청.
   - 예: "재즈 곡 뭐 있어?", "내 곡 중 록 좀 보여줘", "클래식한 거 30곡만"
   - genres 배열에 영어 키로 넣는다 (jazz, classical, rock, pop, electronic, hip_hop, r_n_b, folk, country, metal, punk, indie, soul, blues, funk, reggae, latin, world, ambient, experimental).
   - limit은 사용자가 명시한 숫자(없으면 30), min_score는 기본 0.5.
   - 사용자가 "엄격하게"라고 하면 0.7로, "느슨하게"라고 하면 0.3으로.

2. kinship_curate — "이런 곡 같은 거 추천해줘" / "비슷한 거" 같은 신곡 추천 요청.
   - 시드 결정:
     - 사용자가 곡명 언급 → seed.type='track_text', track_query="<artist> <track>" 형식으로 묶음
     - "요즘 자주 듣는 거" → seed.type='auto_top_recent'
     - "잊고 있던 좋아한 곡 / 한동안 안 들은 곡" → seed.type='auto_dormant_liked'
   - size는 사용자가 명시한 숫자(없으면 12).

3. list_top — "내 top 곡", "요즘 자주 들은 거 보여줘"
   - time_range: 이번 주/최근 → short_term, 6개월/올해 → medium_term, 역대/평생 → long_term. 기본 short_term.
   - limit은 사용자가 명시한 숫자(없으면 20).

4. small_talk — 위 3개에 안 맞는 일반 대화/인사/도움 요청.

출력은 반드시 submit_intent tool 호출. 추측이 어려우면 small_talk을 골라라.

한국어 별칭이 입력에 있어 보조 단서가 함께 전달될 수 있다. 그건 참고용이고, 최종 판단은 너의 몫.`

const INTENT_TOOL = {
  name: 'submit_intent',
  description: '분류된 의도를 제출한다.',
  input_schema: {
    type: 'object' as const,
    required: ['kind'],
    properties: {
      kind: {
        type: 'string',
        enum: ['library_filter', 'kinship_curate', 'list_top', 'small_talk'],
      },
      genres: {
        type: 'array',
        items: { type: 'string', enum: [...GENRE_KEYS] },
      },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
      min_score: { type: 'number', minimum: 0, maximum: 1 },
      seed: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['track_text', 'auto_top_recent', 'auto_dormant_liked'],
          },
          track_query: { type: 'string' },
        },
        required: ['type'],
      },
      size: { type: 'integer', minimum: 1, maximum: 20 },
      time_range: {
        type: 'string',
        enum: ['short_term', 'medium_term', 'long_term'],
      },
    },
  },
}

export async function classifyIntent(text: string): Promise<Intent> {
  const aliasGenres = extractGenresFromText(text)
  const aliasHint =
    aliasGenres.length > 0 ? `genres=${JSON.stringify(aliasGenres)}` : ''

  const userMessage = aliasHint
    ? `사용자 입력: "${text}"\n\n[정규화 단서: ${aliasHint}]`
    : `사용자 입력: "${text}"`

  try {
    const resp = await anthropic().messages.create({
      model: MODELS.intent,
      max_tokens: 1000,
      temperature: 0,
      system: SYSTEM_PROMPT,
      tools: [INTENT_TOOL],
      tool_choice: { type: 'tool', name: INTENT_TOOL.name },
      messages: [{ role: 'user', content: userMessage }],
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
