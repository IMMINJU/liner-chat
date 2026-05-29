# Intent Prompt — Haiku 4.5 의도 분류 명세

`lib/intent.ts`의 시스템 프롬프트, tool 정의, zod 검증, 사전 정규화 규칙. 사용자 자연어 한 줄을 받아 4종 의도 중 하나로 분류한다.

## 모델

- `claude-haiku-4-5`
- temperature: 0.0 (가능한 결정적으로)
- max_tokens: 1000
- tool_choice: 강제 (`submit_intent`)

## 의도 타입 (코드/문서/UI 공통)

```ts
type Intent =
  | {
      kind: 'library_filter'
      genres: string[]                          // 정규화된 키 (jazz, classical, ...)
      limit: number                              // 1~100, 기본 30
      min_score: number                          // 0.0~1.0, 기본 0.5
    }
  | {
      kind: 'kinship_curate'
      seed:
        | { type: 'track_text'; track_query: string }
        | { type: 'auto_top_recent' }
        | { type: 'auto_dormant_liked' }
      size: number                               // 1~20, 기본 12
    }
  | {
      kind: 'list_top'
      time_range: 'short_term' | 'medium_term' | 'long_term'
      limit: number
    }
  | { kind: 'small_talk' }
```

`small_talk`은 폴백/인사용. UI는 기본 안내 메시지로 응답.

## 사전 정규화 (LLM 호출 전)

`lib/genre-aliases.ts`의 한국어 별칭으로 입력을 영어 키 단서로 변환한 **보조 정보**를 LLM 입력에 함께 넣음 (원문은 보존, 단서는 추가).

예: "재즈한 곡 보여줘" → LLM 입력에 `[정규화 단서: genres=["jazz"]]` 추가.

LLM이 그걸 무시할 수도 있지만 도움말로는 충분.

## 시스템 프롬프트 (최종 본문)

> 너는 음악 큐레이션 챗봇의 의도 분류기다. 사용자의 한 줄 자연어 입력을 받아 4가지 의도 중 하나로 분류한다.
>
> **의도 종류:**
>
> 1. `library_filter` — "내 라이브러리에서 ... 장르 곡을 보여달라"는 요청.
>    - 예: "재즈 곡 뭐 있어?", "내 곡 중 록 좀 보여줘", "클래식한 거 30곡만"
>    - `genres` 배열에 영어 키로 넣는다 (`jazz`, `classical`, `rock`, `pop`, `electronic`, `hip_hop`, `r_n_b`, `folk`, `country`, `metal`, `punk`, `indie`, `soul`, `blues`, `funk`, `reggae`, `latin`, `world`, `ambient`, `experimental`).
>    - `limit`은 사용자가 명시한 숫자(없으면 30), `min_score`는 기본 0.5.
>    - 사용자가 "엄격하게"라고 하면 0.7로, "느슨하게"라고 하면 0.3으로.
>
> 2. `kinship_curate` — "이런 곡 같은 거 추천해줘" / "비슷한 거" / "이걸로 친족 추천" 같은 신곡 추천 요청.
>    - 시드를 어떻게 정할지 결정:
>      - 사용자가 곡명 언급 → `seed.type = 'track_text'`, `track_query = "<곡명 정보>"` (가능한 한 "<artist> <track>" 형식으로 묶음)
>      - "요즘 자주 듣는 거" → `seed.type = 'auto_top_recent'`
>      - "잊고 있던 좋아한 곡 / 한동안 안 들은 곡" → `seed.type = 'auto_dormant_liked'`
>    - `size`는 사용자가 명시한 숫자(없으면 12).
>
> 3. `list_top` — "내 top 곡", "요즘 자주 들은 거 보여줘"
>    - `time_range`: "이번 주" "최근" → short_term, "6개월" "올해" → medium_term, "역대" "평생" → long_term. 기본 short_term.
>    - `limit`은 사용자가 명시한 숫자(없으면 20).
>
> 4. `small_talk` — 위 3개에 안 맞는 일반 대화/인사/도움 요청.
>
> **출력은 반드시 `submit_intent` tool 호출.** 추측이 어려우면 `small_talk`을 골라라.
>
> 한국어 별칭이 입력에 있어 보조 단서가 함께 전달될 수 있다. 그건 참고용이고, 최종 판단은 너의 몫.

## User 메시지 템플릿

```
사용자 입력: "{text}"

{aliasHint ? `[정규화 단서: ${aliasHint}]` : ""}
```

`aliasHint`는 `genres=["jazz"]` 같은 짧은 문자열.

## Tool 정의

```ts
const INTENT_TOOL = {
  name: 'submit_intent',
  description: '분류된 의도를 제출한다.',
  input_schema: {
    type: 'object',
    required: ['kind'],
    properties: {
      kind: {
        type: 'string',
        enum: ['library_filter', 'kinship_curate', 'list_top', 'small_talk'],
      },
      // library_filter
      genres: {
        type: 'array',
        items: {
          type: 'string',
          enum: [
            'jazz','classical','rock','pop','electronic','hip_hop','r_n_b',
            'folk','country','metal','punk','indie','soul','blues','funk',
            'reggae','latin','world','ambient','experimental',
          ],
        },
      },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
      min_score: { type: 'number', minimum: 0, maximum: 1 },
      // kinship_curate
      seed: {
        type: 'object',
        required: ['type'],
        properties: {
          type: {
            type: 'string',
            enum: ['track_text', 'auto_top_recent', 'auto_dormant_liked'],
          },
          track_query: { type: 'string' },
        },
      },
      size: { type: 'integer', minimum: 1, maximum: 20 },
      // list_top
      time_range: {
        type: 'string',
        enum: ['short_term', 'medium_term', 'long_term'],
      },
    },
  },
}
```

`tool_choice: { type: 'tool', name: 'submit_intent' }`.

## zod 검증

discriminated union으로:

```ts
const IntentSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('library_filter'),
    genres: z.array(z.enum([...GENRE_KEYS])).min(1),
    limit: z.number().int().min(1).max(100).default(30),
    min_score: z.number().min(0).max(1).default(0.5),
  }),
  z.object({
    kind: z.literal('kinship_curate'),
    seed: z.discriminatedUnion('type', [
      z.object({ type: z.literal('track_text'), track_query: z.string().min(1) }),
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
```

검증 실패 → `{ kind: 'small_talk' }` 폴백 (intent 분류 자체로 실패하면 사용자에게 기본 안내).

## 테스트 케이스 (개발용)

| 입력 | 기대 |
|------|------|
| "재즈 곡 뭐 있어?" | library_filter, genres=[jazz], limit=30, min_score=0.5 |
| "내 곡 중 클래식 좀 50곡" | library_filter, genres=[classical], limit=50 |
| "Tame Impala Elephant 같은 거 추천해줘" | kinship_curate, seed.type=track_text, track_query≈"Tame Impala Elephant" |
| "요즘 자주 듣는 곡 기반으로 추천" | kinship_curate, seed.type=auto_top_recent |
| "잊고 있던 좋아한 곡으로 추천" | kinship_curate, seed.type=auto_dormant_liked |
| "이번 주 top 보여줘" | list_top, time_range=short_term |
| "안녕" | small_talk |
| "고마워" | small_talk |
