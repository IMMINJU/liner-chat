# Curation Pipeline — 모드 2 흐름 명세

사용자 입력 → 추천 카드 → Spotify 플레이리스트 저장까지의 단계별 명세.

```
[chat input] → [intent classify] → [seed resolve] → [seed context]
   → [kinship LLM] → [Spotify verify] → [library dedupe] → [DB save]
   → [client response] → [preview page] → [save playlist | dig deeper]
```

각 단계는 다음 절에서 단독 모듈로 정의. 입출력 타입과 실패 모드만 적는다.

## 1. Intent classify (`lib/intent.ts`)

**입력**: `string` (사용자 자연어)
**출력**: `Intent` (discriminated union, 세부는 [intent-prompt.md] (Step 5 진입 시 작성))
**모델**: `claude-haiku-4-5` (tool use)

`kind === "kinship_curate"` 인 경우만 이 파이프라인 진입.

**실패 모드**:
- LLM이 tool을 호출하지 않거나 schema 불일치 → zod 재시도 1회 → 그래도 실패면 사용자에 "이해 못함" 응답.

## 2. Seed resolve (`lib/curator.ts → resolveSeed`)

**입력**:
```ts
type SeedInput =
  | { type: "track_text"; track_query: string }
  | { type: "auto_top_recent" }
  | { type: "auto_dormant_liked" }
```
**출력**: `Track` (DB의 tracks 행에 대응되는 객체)

| seed type | 동작 |
|-----------|------|
| `track_text` | `q = track_query` 그대로 Spotify Search (type=track). 상위 1개를 시드로. 결과 없으면 사용자에 "그 곡 못 찾음" 응답. |
| `auto_top_recent` | DB의 `top_tracks(time_range='short_term')` 최신 스냅샷에서 `rank ≤ 5` 무작위 1곡. 빈 경우 → "동기화 먼저" 응답. |
| `auto_dormant_liked` | `liked_tracks` ∖ {최근 90일 내 plays}. 무작위 1곡. 빈 경우 → "동기화 먼저" 또는 "잠자는 곡 없음" 응답. |

시드 트랙은 DB에 없으면 fetch + upsert (artists, tracks). audio_features는 정책 변경으로 채우지 않는다.

## 3. Seed context (`lib/curator.ts → buildSeedContext`)

**입력**: `Track`
**출력**: `SeedContext`

```ts
type SeedContext = {
  track: { name: string; artist: string; album: string; year: number }
  spotifyGenres: string[]      // 아티스트 단위
  lastfmTrackTags: string[]    // top 10 tags from track.getTopTags
  lastfmArtistTags: string[]   // top 10 tags from artist.getTopTags
  // audio + tonal은 Spotify 정책 변경으로 현재 항상 비어 있다. 타입은
  // 보존하지만 실제 채워질 일이 없다. 정책 재오픈 시 sync의 audio 단계
  // 복원만으로 다시 채워진다.
  audio: {                     // 항상 {} (Spotify audio_features 비공개 전환)
    energy?: number
    valence?: number
    tempo?: number
    acousticness?: number
    danceability?: number
    instrumentalness?: number
  }
  tonal: {                     // 항상 {} (Spotify audio_features 비공개 전환)
    key?: string
    mode?: 'major' | 'minor'
    time_signature?: number
  }
  listenerProfile: {
    seedPopularity: number     // 0..100, Spotify Get Track의 popularity
    librarySophistication: 'mainstream' | 'mixed' | 'obscure'
    // 사용자의 liked/top 트랙 popularity 평균 P 기준:
    //   P >= 60 → 'mainstream'
    //   30 <= P < 60 → 'mixed'
    //   P < 30 → 'obscure'
    // 데이터 부족(트랙 < 20)이면 'mixed'로 폴백.
  }
}
```

병렬 호출: Spotify get artist + Last.fm track tags + Last.fm artist tags + DB audio_features lookup + 사용자 라이브러리 popularity 평균. 외부 호출 실패 시 그 필드 비우고 진행 (LLM은 부분 컨텍스트로도 답할 수 있음). `listenerProfile`은 DB만으로 계산되니 항상 채워진다 — 시드 popularity는 시드 trackId의 Spotify Get Track 응답에서.

**Listener sophistication 계산** (`lib/curator.ts`):

```ts
async function estimateLibrarySophistication(userId: string):
  Promise<'mainstream' | 'mixed' | 'obscure'>
```

- liked_tracks + top_tracks에서 최대 200개 sample (random or 최근).
- 각 트랙의 popularity 평균.
- 단, 우리 DB에 popularity가 없다(MVP에 저장 안 함). 두 가지 옵션:
  1. **그때그때 Spotify Get Several Tracks 호출**로 200개 popularity 받음 — 4 batch × ~300ms = ~1.2초.
  2. tracks 테이블에 `popularity` 컬럼 추가 + 동기화 시 채움. 매번 DB 조회로 끝.

  **MVP는 1번**: 단일 큐레이션 호출의 컨텍스트 구성 단계라 1.2초 추가 정도 무난. 캐시는 메모리(같은 세션 안)나 짧은 TTL로 (v2).

## 4. Kinship LLM (`lib/kinship.ts`)

**입력**: `SeedContext`
**출력**: `KinshipResponse` (zod 검증)
**모델**: `claude-sonnet-4-6` (tool use)

```ts
type KinshipResponse = {
  lineage_notes: string                  // 시드 분석 2-3문장
  tracks: Array<{
    category: "influence" | "peer" | "descendant" | "kinship"
    artist: string
    track: string
    album: string
    year: number
    sonic_link: string                   // 한국어 1-2문장
    link_dimensions: Array<
      | "mood" | "structure" | "texture" | "narrative"
      | "groove" | "vocal_style" | "melody" | "progression"
    >
  }>
}
```

zod 추가 검증:
- 카테고리별 최소: influences≥3, peers≥3, descendants≥2, kinship≥3
- 각 트랙 `link_dimensions.length ∈ [1,3]`
- `year` ∈ [1900, 현재 연도]

검증 실패 시 한 번 재시도 (LLM에 "위 조건 만족 못함, 다시" 메시지). 두 번째도 실패면 에러.

프롬프트 본문은 [kinship-prompt.md](kinship-prompt.md).

## 5. Spotify verify (`lib/spotify/catalog.ts → verifyTrack`)

**입력 (per track)**: `{ artist, track, album, year }`
**출력**: `Track | null`

알고리즘:

```
1. q = `track:"${track}" artist:"${artist}"`
2. GET /v1/search?q=...&type=track&limit=10
3. 결과 후보 순회:
     - normalize(candidate.artists[0].name) === normalize(artist)? (정확 일치)
     - normalize(candidate.album.name).includes(normalize(album))? (부분 일치)
     - |year(candidate.album.release_date) - year| ≤ 2?
4. 모두 만족하는 첫 후보 채택 → upsert artists/tracks → 반환
5. 만족하는 후보 없음 → null (드랍)
```

normalize는 [glossary.md](glossary.md) 참조.

병렬화: LLM이 준 트랙 12-15개를 `Promise.all` (Spotify 토큰당 rate limit는 분당 ~수천 호출이라 무해).

**실패 모드**:
- Spotify 5xx → 그 트랙만 드랍, 나머지 진행
- 토큰 만료 → 재발급 후 1회 재시도 (`lib/spotify/client.ts`가 처리)

## 6. Library dedupe + 다양성 (`lib/curator.ts → filterAndDiversify`)

**입력**: verify 통과한 트랙 배열
**출력**: 최종 추천 트랙 배열

순서:

1. **라이브러리 중복 제외** — `liked_tracks ∪ top_tracks ∪ plays` 어디라도 매치되는 track_id 드랍
2. **다양성**:
   - 카테고리 내 같은 아티스트 1곡까지
   - 큐레이션 전체에서 같은 아티스트 최대 2곡
   - 위반 시 LLM이 준 순서 기준 뒤쪽부터 드랍

각 카테고리에서 최소 개수 (influences≥3, peers≥3, descendants≥2, kinship≥3) 보장 못하면 보장 못한 카테고리만 명시적으로 노출 (UI에서 "이 카테고리 결과 적음" 안내). 재호출 안 함 (비용/지연 이유).

## 7. DB save (`lib/curator.ts → saveCuration`)

트랜잭션으로:

```sql
INSERT INTO curations (user_id, query, seed_track_id, parent_curation_id, lineage_notes)
RETURNING id;

INSERT INTO curation_tracks (curation_id, track_id, category, sonic_link, link_dimensions, position)
VALUES (...) -- 카테고리 × position 순으로
```

position은 카테고리 내 LLM 응답 순서.

## 8. Client response

```ts
type CurateResponse = {
  curation_id: number
  seed: TrackCard
  lineage_notes: string
  categories: {
    influences: TrackCard[]
    peers: TrackCard[]
    descendants: TrackCard[]
    kinship: TrackCard[]
  }
}

type TrackCard = {
  id: string                            // Spotify track id
  name: string
  artist: string
  album: string
  year: number
  spotifyUrl: string
  previewUrl: string | null
  sonic_link?: string                   // seed에는 없음
  link_dimensions?: string[]
}
```

라우트: `POST /api/curate` → 위 페이로드 반환.

## 9. Preview page (`/curations/[id]`)

서버 컴포넌트로 DB에서 직접 로드 (curations + curation_tracks + tracks 조인). 디깅 체인 부모 있으면 브레드크럼.

## 10. 분기: Save or Dig deeper

- **Save** → `POST /api/playlist/save { curation_id }` → Spotify 플레이리스트 생성 + curation_playlists INSERT. UI에 Spotify URL 표시.
- **Dig deeper** → 추천 카드 버튼 → `POST /api/curate { seed_track_id: <그 track id>, parent_curation_id: <현재 id> }` → 처음부터 다시. 새 `/curations/[new_id]`로 라우팅.

## 호출 비용 / 지연 예상 (MVP)

| 단계 | 외부 호출 | 예상 지연 |
|------|-----------|-----------|
| 1. intent | Haiku 1회 | <1초 |
| 2. seed resolve | Spotify Search 1회 + DB | <1초 |
| 3. seed context | Spotify Get Artist + Last.fm 2 + Audio Features | 1-2초 (병렬) |
| 4. kinship LLM | Sonnet 1회, ~3000 토큰 응답 | 5-10초 |
| 5. verify | Spotify Search × 12-15 (병렬) | 2-3초 |
| 6-7. dedupe + save | DB only | <500ms |

**총 ~10-15초**. 사용자에게 로딩 상태 표시 필요. v2에서 LLM 스트리밍.

## 실패 시 사용자 메시지

각 코드는 `lib/messages.ts`의 `pipeline.*` 엔트리로 매핑된다 (구조: `title` + `body` + 선택적 `actionHref`/`actionLabel`/`altBody`). UI는 단일 텍스트가 아니라 **헤더·본문·액션 버튼이 있는 카드**로 렌더한다.

| 코드 | 카드 헤더 | 액션 |
|------|-----------|------|
| `seed_not_found` | "그 곡을 못 찾았어요" | (없음, 다시 입력 안내) |
| `sync_required` | "먼저 라이브러리를 동기화해야 해요" | **`→ 설정 페이지로 이동`** + "또는 곡 이름을 직접 알려줘도 돼요" 보조 안내 |
| `llm_failed` | "추천을 만들지 못했어요" | (없음, 재시도 안내) |
| `all_dropped` | "확인된 추천이 없어요" | (없음, 다른 시드 안내) |
| `unknown` | "알 수 없는 오류" | (없음) |

매핑은 `pipelineErrorFor(code)` 헬퍼로 단방향. 새 코드 추가 시 `lib/messages.ts`의 `pipeline` 엔트리 + `PIPELINE_BY_CURATOR_CODE` 매핑 + 이 표를 동시에 갱신한다.
