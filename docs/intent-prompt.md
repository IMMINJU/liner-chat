# Intent Prompt — Haiku 4.5 의도 분류 명세

`lib/intent.ts`의 시스템 프롬프트, tool 정의, zod 검증. 사용자 자연어 한 줄을 받아
**2종 의도** 중 하나로 분류한다. 로그인 없는 단일 사용자 모드 기준의 **현행** 문서 —
과거의 4종 의도(`library_filter`/`list_top`/auto seed)와 장르 별칭 사전 정규화는
라이브러리 폐지와 함께 제거됐다 ([auth-flow.md](auth-flow.md)).

## 모델 / 호출 정책

- `claude-haiku-4-5`
- temperature: 0.0 (가능한 결정적으로)
- max_tokens: 1000
- tool_choice: 강제 (`submit_intent`)
- **8초 로컬 타임아웃** (AbortController). Haiku는 정상적으로 1-3s인데, 로컬 캡이
  없으면 SDK 90s 백스톱까지 매달려 110s chat 예산을 큐레이터가 쓰기 전에 잠식한다.
  타임아웃 포함 모든 실패는 `small_talk` 폴백.

## 의도 타입 (코드/문서/UI 공통)

```ts
type Intent =
  | {
      kind: 'kinship_curate'
      seed: {
        type: 'track_text'
        track_query: string
        artist_hint?: string   // 경계 확실할 때만
        track_hint?: string    // 경계 확실할 때만
      }
      depth?: 'mainstream' | 'balanced' | 'deep'
    }
  | { kind: 'small_talk' }
```

`artist_hint`/`track_hint`는 아티스트/곡 제목 **경계가 확실할 때만** 채운다 —
있으면 시드 해석이 `track:"T" artist:"A"` 필드필터 검색을 1차로 시도(미스 시
free-text 폴백이라 오파싱의 최악은 낭비 콜 1회). 불확실하면 둘 다 생략이 규칙
(잘못 쪼개기 > 안 쪼개기).

`depth`는 사용자가 **명시적으로** 깊이/대중성을 조향할 때만 채워진다("더 유명한
걸로/입문용"→mainstream, "더 깊게/희귀한/딥컷"→deep). 부재/파싱 실패 →
librarySophistication은 'mixed' 유지. 명시 입력 신호라 규약 10의 정직한 폴백
원칙과 충돌하지 않는다 (curator가 mainstream→mainstream, deep→obscure로 매핑).

`small_talk`은 폴백/인사용 — UI는 곡명을 알려달라는 기본 안내로 응답.
`size` 필드는 제거됨: downstream에서 읽은 적 없는 죽은 필드였다. 곡 수는 kinship
스키마 floor(2/2/1/2) + 검증 attrition이 결정한다. 수량 제어가 제품 요구가 되면
max_tokens/floor/verify 예산까지 엮어 별도 설계할 것.

## 시스템 프롬프트 (최종 본문)

> 너는 음악 큐레이션 챗봇의 의도 분류기다. 사용자의 한 줄 자연어 입력을 받아 2가지 의도 중 하나로 분류한다.
>
> 의도 종류:
>
> 1. kinship_curate — "이런 곡 같은 거 추천해줘" / "비슷한 거" 같은 신곡 추천 요청. 사용자가 곡을 (또는 아티스트+곡을) 언급하면 이쪽이다.
>    - seed.type 은 항상 'track_text'.
>    - track_query 는 "<artist> <track>" 형식으로 묶는다. 아티스트가 없으면 곡 제목만이라도 넣는다.
>    - depth 는 사용자가 **명시적으로** 깊이/대중성을 조향할 때만 넣는다: "더 유명한 걸로"/"입문용"/"대중적인" → 'mainstream', "더 깊게"/"희귀한"/"안 알려진"/"딥컷" → 'deep'. 그런 표현이 없으면 depth 자체를 생략하라 (추측 금지).
>
> 2. small_talk — 추천 대상 곡이 분명하지 않은 일반 대화/인사/도움 요청, 또는 곡을 특정하지 못한 모호한 추천 요청.
>
> 출력은 반드시 submit_intent tool 호출. 곡을 특정할 수 없으면 small_talk을 골라라.

## User 메시지 템플릿

```
사용자 입력: "{text}"
```

(과거의 `[정규화 단서: ...]` 별칭 힌트는 장르 필터 폐지와 함께 제거.)

## Tool 정의

```ts
const INTENT_TOOL = {
  name: 'submit_intent',
  description: '분류된 의도를 제출한다.',
  input_schema: {
    type: 'object',
    required: ['kind'],
    properties: {
      kind: { type: 'string', enum: ['kinship_curate', 'small_talk'] },
      seed: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['track_text'] },
          track_query: { type: 'string' },
        },
        required: ['type', 'track_query'],
      },
      depth: {
        type: 'string',
        enum: ['mainstream', 'balanced', 'deep'],
        description: '사용자가 명시적으로 깊이/대중성을 조향한 경우만. 명시 없으면 생략.',
      },
    },
  },
}
```

`tool_choice: { type: 'tool', name: 'submit_intent' }`.

## zod 검증

```ts
const IntentSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('kinship_curate'),
    seed: z.object({
      type: z.literal('track_text'),
      track_query: z.string().min(1),
    }),
    depth: z.enum(['mainstream', 'balanced', 'deep']).optional(),
  }),
  z.object({ kind: z.literal('small_talk') }),
])
```

tool 미호출 / 스키마 미스 / 예외 / 타임아웃 → 전부 `{ kind: 'small_talk' }` 폴백.
재시도 없음 (의도 분류가 애매하면 사용자에게 곡명을 다시 묻는 게 빠르다).

## 테스트 케이스 (개발용)

| 입력 | 기대 |
|------|------|
| "Tame Impala Elephant 같은 거 추천해줘" | kinship_curate, track_query≈"Tame Impala Elephant" |
| "Placebo의 Without You I'm Nothing 같은 앨범 단위 우울함" | kinship_curate, track_query≈"Placebo Without You I'm Nothing" |
| "뭔가 비 오는 날 들을 만한 거" (곡 특정 없음) | small_talk |
| "안녕" / "고마워" | small_talk |
| "20곡 추천해줘, Creep 같은 걸로" | kinship_curate (수량은 무시된다 — size 필드 없음) |
| "Creep 같은 건데 더 안 알려진 걸로" | kinship_curate, depth='deep' |
| "Creep 같은 곡, 입문하기 좋은 걸로" | kinship_curate, depth='mainstream' |
