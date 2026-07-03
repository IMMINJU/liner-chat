# API Contracts — 라우트 입출력 명세

라우트 단위 계약. 코드보다 이 문서를 먼저 본다. 변경 시 코드와 함께.
로그인 없는 단일 사용자 모드 기준의 **현행** 문서 — 과거의 auth/sync/playlist 라우트는
제거됐다 ([auth-flow.md](auth-flow.md)에 역사 기록).

| 라우트 | 메서드 | 인증 | 비고 |
|--------|--------|------|------|
| `/api/chat` | POST | 없음 (단일 익명 사용자) | 자연어 → 의도 분기 |
| `/api/curate` | POST | 없음 (단일 익명 사용자) | 친족 큐레이션 직접 호출 (디깅 체인) |

두 라우트 모두 `maxDuration = 120` (Fluid Compute). 각 페이지(서버 컴포넌트)는 별도 —
페이지는 자체 DB 조회.

## `POST /api/chat`

### Request

```ts
{ message: string }
```

`message`: 사용자 자연어 한 줄. 빈 문자열이면 400.

### Response (200)

`ChatResponse` discriminated union (`kind` 필드, `app/api/chat/route.ts`가 원본):

```ts
type ChatResponse =
  | ({ kind: 'kinship_curate' } & Omit<CurateOk, 'ok'>)   // 성공 큐레이션
  | { kind: 'kinship_curate_failed'; code: string; message: string }
  | { kind: 'small_talk'; notice: string }
  | { kind: 'error'; error: string }
```

`kinship_curate_failed.code`는 아래 `/api/curate`의 오류 코드와 동일 도메인
(`seed_not_found` | `llm_failed` | `all_dropped` | `unknown`).

### 오류

- 400 → `{ kind: 'error', error: '...' }` (JSON 파싱 실패, 빈 입력)
- 500 → `{ kind: 'error', error: '...' }` (예외)

### 흐름

1. `classifyIntent(message)` — Haiku, 8s 로컬 타임아웃, 실패 시 `small_talk` 폴백.
2. intent.kind 분기:
   - `kinship_curate` → `runCuration({ seed: intent.seed, query: message })` (110s race)
   - `small_talk` → guidance notice

## `POST /api/curate`

채팅 우회용. 디깅 체인에서 카드의 trackId를 직접 시드로 지정해 호출.

### Request

```ts
{
  seed:
    | { type: 'track_id'; track_id: string }       // 디깅 체인용 (Spotify track id)
    | { type: 'track_text'; track_query: string
        artist_hint?: string; track_hint?: string } // 경계 확실할 때만 — 필드필터 tier 활성화
  query?: string                                    // 자연어 원문 (optional)
  parent_curation_id?: number | null                // 디깅 체인
}
```

zod로 파싱하며, 스키마 위반은 400 + `{ ok: false, code: 'bad_request', message }`.
(과거의 `auto_top_recent`/`auto_dormant_liked` 시드는 라이브러리 폐지와 함께 제거.)

### Response (200)

```ts
type CurateResponse =
  | CurateOk                            // lib/curator.ts의 CurateOk 그대로
  | { ok: false; code: '...'; message: string }
```

`CurateOk`:

```ts
{
  ok: true
  curationId: number
  seed: { id, name, artist, album, year, spotifyUrl, previewUrl }
  lineage_notes: string
  categories: { influence: CurationTrackCard[]; peer: …; descendant: …; kinship: … }
  stats: {
    proposedByLLM: number        // 1차 + 보충 제안 총수
    verifiedOnSpotify: number    // Spotify 매치 규칙 통과 수
    droppedAsDuplicate: number   // 시드/중복/체인 아티스트 드랍
    droppedByDiversity: number   // 아티스트 다양성 캡 드랍
    droppedByInfra: number       // Spotify 인프라 실패(429/5xx/타임아웃, 재시도 후에도)
  }
}
```

`droppedByInfra`는 검증 인프라 장애를 메타데이터 미스매치와 분리해 계측하기 위한
필드다 — 이 값이 튀면 "LLM이 이상해졌다"가 아니라 Spotify 쪽 문제.

### 오류 코드

| code | 의미 | HTTP |
|------|------|------|
| `bad_request` | 요청 스키마 위반 | 400 |
| `seed_not_found` | 시드 해석 실패 (검색 무결과 / track_id 무효) | 200 (ok:false) |
| `llm_failed` | Sonnet 실패·절단·타임아웃·하드캡 | 200 (ok:false) |
| `all_dropped` | verify + 필터로 모든 트랙 드랍 | 200 (ok:false) |
| `unknown` | 기타 예외 | 500 |

ok:false는 원칙적으로 200으로 반환(클라이언트가 메시지 카드 표시). `bad_request`와
예외만 비-200. (`sync_required`는 auto seed 폐지와 함께 제거.)

## 공통 타입

### `TrackCard`

```ts
type TrackCard = {
  id: string
  name: string
  artist: string
  album: string | null
  year: number | null
  spotifyUrl: string | null
  previewUrl: string | null
}
```

### `CurationTrackCard`

TrackCard + 큐레이션 메타:

```ts
type CurationTrackCard = TrackCard & {
  category: 'influence' | 'peer' | 'descendant' | 'kinship'
  sonic_link: string
  link_dimensions: string[]
  coverUrl: string | null
}
```

### `SeedSummary`

```ts
type SeedSummary = {
  id: string
  name: string
  artist: string
  album: string | null
  year: number | null
  spotifyUrl: string | null
  previewUrl: string | null
}
```

## 페이지

### `/curations/[id]` (서버 컴포넌트)

- 세션/로그인 없음. id가 숫자가 아니거나, 존재하지 않거나, `LOCAL_USER` 소유가 아니면 404.
- DB에서 curation + curation_tracks + tracks/artists 조인 로드.
- 브레드크럼: `parent_curation_id` 체인을 따라 조상 표시.
- 카테고리별 섹션 (빈 카테고리는 렌더하지 않음 — peer는 보충 대상이 아니라 0이 될 수 있다).
- 각 카드에 `sonic_link`, `link_dimensions` 칩, Spotify 외부 링크, 미리듣기(임베드),
  디깅 버튼.

## 변경 정책

- 라우트 추가/변경 시 이 문서 먼저 갱신, 그 다음 코드.
- 응답 타입 변경은 클라이언트 컴포넌트에 영향. breaking change 신중히.
