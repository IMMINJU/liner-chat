# API Contracts — 라우트 입출력 명세

라우트 단위 계약. 코드보다 이 문서를 먼저 본다. 변경 시 코드와 함께.

| 라우트 | 메서드 | 인증 | 비고 |
|--------|--------|------|------|
| `/api/auth/login` | GET | - | PKCE 흐름 시작 |
| `/api/auth/callback` | GET | - | Spotify OAuth callback |
| `/api/auth/logout` | POST | - | 세션 무효화 |
| `/api/sync` | POST | 세션 | 5단계 동기화 |
| `/api/chat` | POST | 세션 | 자연어 → 의도 분기 |
| `/api/curate` | POST | 세션 | 친족 큐레이션 (모드 2) |
| `/api/playlist/save` | POST | 세션 | Spotify 플레이리스트 생성 (Step 9에서 명세) |

각 페이지(서버 컴포넌트)는 별도. 페이지는 자체 fetch + DB 조회.

## `POST /api/chat`

### Request

```ts
{ message: string }
```

`message`: 사용자 자연어 한 줄. 길이 1~1000 권장.

### Response (200)

`ChatResponse` discriminated union (`kind` 필드):

```ts
type ChatResponse =
  | { kind: 'library_filter';
      genres: string[]; tracks: TrackCard[];
      count: number; computed: number; skipped: number;
      notice?: string }
  | { kind: 'kinship_curate';
      curationId: number;
      seed: SeedSummary;
      lineage_notes: string;
      categories: { influence: TrackCard[]; peer: TrackCard[];
                    descendant: TrackCard[]; kinship: TrackCard[] };
      stats: CurationStats }
  | { kind: 'list_top'; notice: string }            // Step 7 시점 placeholder
  | { kind: 'small_talk'; notice: string }
  | { kind: 'error'; error: string }
```

### 오류

- 401 → `{ kind: 'error', error: '로그인이 필요해요.' }`
- 400 → `{ kind: 'error', error: '...' }` (빈 입력 등)
- 500 → `{ kind: 'error', error: '...' }`

### 흐름

1. 세션 확인.
2. `classifyIntent(message)` 호출.
3. intent.kind 분기:
   - `library_filter` → `listLibraryByGenre()` 결과로 응답
   - `kinship_curate` → `runCuration({ seed: intent.seed, query: message })` 결과로 응답
   - `list_top` → placeholder notice
   - `small_talk` → guidance notice

## `POST /api/curate`

채팅 우회용. 디깅 체인이나 외부 트리거에서 직접 시드 트랙을 지정해 호출.

### Request

```ts
{
  seed:
    | { type: 'track_id'; track_id: string }       // 디깅 체인용 (이미 DB에 있는 트랙)
    | { type: 'track_text'; track_query: string }  // 일반 텍스트 검색
    | { type: 'auto_top_recent' }
    | { type: 'auto_dormant_liked' }
  query?: string                                    // 자연어 원문 (optional)
  parent_curation_id?: number                       // 디깅 체인
}
```

`track_id`는 우리 `tracks.id` (= Spotify track id). 디깅 체인에서 사용자가 카드의 "이걸로 더 파보기" 클릭 시 카드의 trackId 그대로 전달.

### Response (200)

```ts
type CurateResponse =
  | (CurateOk)                          // lib/curator.ts의 CurateOk 그대로
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
  stats: { proposedByLLM, verifiedOnSpotify, droppedAsDuplicate, droppedByDiversity }
}
```

### 오류 코드

| code | 의미 | HTTP |
|------|------|------|
| `seed_not_found` | track_text 검색 실패 | 200 (ok:false) |
| `sync_required` | auto seed 시드 후보 없음 | 200 (ok:false) |
| `llm_failed` | Sonnet 호출/검증 두 번 실패 | 200 (ok:false) |
| `all_dropped` | verify+필터로 모든 트랙 드랍 | 200 (ok:false) |
| `unknown` | 기타 예외 | 500 |
| - | 미인증 | 401 |

ok:false는 200으로 반환(클라이언트가 메시지 표시). 미인증/예외만 비-200.

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

- 세션 없으면 `/`로 redirect.
- DB에서 curation + curation_tracks + tracks/artists 조인 로드.
- 다른 사용자의 curation id면 404.
- 브레드크럼: `parent_curation_id` 있으면 부모 시드까지 한 단계 표시 (재귀 X, MVP는 한 단계만).
- 카테고리별 섹션 (한국어 라벨: 영향원/동시대 동료/후속/음악적 친족).
- 각 카드에 `sonic_link`, `link_dimensions` 칩, Spotify 외부 링크, 미리듣기 (Step 8 디깅 체인에서 "🔍 이걸로 더 파보기" 버튼 추가).
- 상단 "Spotify에 저장" 버튼 (Step 9에서 동작 연결).

이 페이지는 UI를 Figma Make로 갈 거라 MVP는 최소 마크업.

## 변경 정책

- 라우트 추가/변경 시 이 문서 먼저 갱신, 그 다음 코드.
- 응답 타입 변경은 클라이언트(현재 컴포넌트 + 향후 Figma Make 출력 모두)에 영향. breaking change 신중히.
