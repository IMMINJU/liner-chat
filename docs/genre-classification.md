# Genre Classification — 모드 1 점수 산출

라이브러리 트랙별로 장르 신호(`scores`)를 계산해 `genre_signals` 테이블에 저장한다. 모드 1("내 곡 중 재즈 뭐 있어?")은 이 테이블을 기준으로 필터링한다.

## 결정

- 점수는 **두 소스의 가중합**: Spotify 아티스트 장르 + Last.fm 트랙/아티스트 태그.
- **트랙 장르 자체가 Spotify에 없다.** 아티스트 장르가 곡 정체성과 다른 경우(예: 사이키 록 아티스트의 어쿠스틱 발라드)를 Last.fm 트랙 태그가 보정.
- **장르 집합은 고정 enum.** UI 노출/검색용. 동의어와 하위 장르는 `genre-dictionary.ts`의 매핑으로 흡수.
- **점수는 0.0~1.0 클램프**, **임계값 0.5**가 기본 "그 장르로 분류" 기준.
- **계산은 동기화 직후가 아니라 별도 단계.** 동기화는 Spotify 데이터만 채우고, genre_signals는 lazy하게 또는 명시적인 다른 트리거로 계산. MVP는 **lazy on-demand**: 모드 1 쿼리 들어왔을 때 사용자 라이브러리에서 신호 없는 트랙만 계산.

## 장르 집합 (`lib/genre-dictionary.ts`)

핵심 장르 키 (UI/쿼리/스코어 컬럼 키로 그대로 사용):

```
jazz, classical, rock, pop, electronic, hip_hop, r_n_b, folk, country,
metal, punk, indie, soul, blues, funk, reggae, latin, world, ambient, experimental
```

각 키마다 **매칭되는 raw 태그 사전** (소문자, normalize 후 비교):

```ts
{
  jazz: [
    'jazz', 'jazz fusion', 'vocal jazz', 'bebop', 'swing', 'cool jazz',
    'smooth jazz', 'modal jazz', 'free jazz', 'hard bop', 'big band',
    'jazz piano', 'jazz vocal', 'nu jazz', 'jazz funk', 'spiritual jazz',
    'contemporary jazz', 'crossover jazz', 'avant-garde jazz',
  ],
  classical: [
    'classical', 'baroque', 'romantic', 'opera', 'classical piano',
    'orchestral', 'contemporary classical', 'minimalism', 'symphony',
    'string quartet', 'chamber music', 'choral',
  ],
  // ...
}
```

**원칙**: 사전은 너무 좁히지 않는다. 잡음(false positive)이 약간 있어도 recall이 우선. 사용자가 "왜 이게 재즈로 분류됐냐"라고 물으면 `raw_tags`를 보여줘 디버깅 가능.

## 점수 공식

각 장르 G에 대해:

```
score(G) =
  + 0.6   if Spotify 아티스트 장르 중 G 사전과 매칭되는 게 1개 이상
  + 0.4   if Last.fm 트랙 태그 top 5 안에 G 사전 매칭이 있음
  + 0.2   if Last.fm 트랙 태그 top 5 밖이지만 있긴 함
  + 0.3   if Last.fm 아티스트 태그 top 5 안에 G 사전 매칭이 있음
  + 0.1   if Last.fm 아티스트 태그 top 5 밖이지만 있긴 함
```

합산 후 `min(score, 1.0)`.

- 가중치 우선순위: **Spotify > Last.fm 트랙 > Last.fm 아티스트**. Spotify가 신뢰도 높지만 트랙 정체성을 못 잡으므로 Last.fm 트랙 태그를 보강.
- 한 트랙이 여러 장르에 0.5+ 점수를 가질 수 있음 (예: jazz funk 곡 → jazz 0.7, funk 0.6).

## 데이터 형식 (`genre_signals.scores`)

```json
{
  "jazz": 0.8,
  "classical": 0.1,
  "rock": 0.0,
  ...
}
```

- **모든 장르 키 포함** (0.0이어도). 검색/필터 SQL이 단순해짐.
- `raw_tags`도 함께 저장:
  ```json
  {
    "spotify_artist": ["vocal jazz", "jazz vocal"],
    "lastfm_track": ["jazz", "vocal jazz", "smooth", "evening", "chillout"],
    "lastfm_artist": ["jazz", "female vocalists", "vocal jazz", "smooth jazz"]
  }
  ```
- `computed_at`: 계산 시각. 24h 이상 지난 신호는 stale로 간주(현재는 갱신 안 하고 그대로 사용).

## Last.fm API

`lib/lastfm.ts`:

```ts
async function getTrackTopTags(artist: string, track: string): Promise<LastfmTag[]>
async function getArtistTopTags(artist: string): Promise<LastfmTag[]>

type LastfmTag = { name: string; count: number } // count: 0~100 정규화
```

- 엔드포인트: `https://ws.audioscrobbler.com/2.0/?method=...&format=json`
- API 키 1개, 인증 없음.
- **rate limit**: 공식 명시 없음. 안전하게 트랙 단위 250ms throttle. 한 사용자의 라이브러리 2500곡 = 트랙+아티스트 각 1콜 = 5000콜 × 250ms = 20분. 너무 김.
- **대안**: 아티스트 단위는 **artist id별 캐시** (한 아티스트당 1콜) → 50곡 좋아한 같은 아티스트라도 1번. 트랙 콜만 곡 수만큼.
- 더 단순한 MVP: **모드 1 쿼리 시점에 호출량 제한**. 사용자가 "재즈 곡 뭐 있어?"라고 물으면 점수 없는 곡 최대 200개에 대해서만 lazy 계산 + 응답. 나머지는 백그라운드 폴리시 미정(MVP에선 안 함).

## 한국어 별칭 (`lib/genre-aliases.ts`)

사용자 자연어 → 장르 키:

```ts
{
  '재즈': 'jazz',
  '클래식': 'classical',
  '클래시컬': 'classical',
  '록': 'rock',
  '락': 'rock',
  '팝': 'pop',
  '일렉': 'electronic',
  '일렉트로니카': 'electronic',
  '힙합': 'hip_hop',
  '힙팝': 'hip_hop',
  '알엔비': 'r_n_b',
  'rnb': 'r_n_b',
  '소울': 'soul',
  '포크': 'folk',
  '컨트리': 'country',
  '컨츄리': 'country',
  '메탈': 'metal',
  '펑크': 'punk',
  '인디': 'indie',
  '블루스': 'blues',
  '훵크': 'funk', '펑크 음악': 'funk', // 'funk'는 'punk'와 혼동되니 한국어 표기 주의
  '레게': 'reggae',
  '라틴': 'latin',
  '월드': 'world',
  '앰비언트': 'ambient',
  '실험적': 'experimental',
}
```

영어 키도 그대로 인식 (`jazz` → `jazz`). 매칭 안 되면 LLM 단계에서 처리.

## Intent: `library_filter`

스키마 (`lib/intent.ts` Step 5 동시 작성):

```ts
{
  kind: 'library_filter',
  genres: string[],         // 정규화된 장르 키 배열. 예: ['jazz']
  limit: number,            // 기본 30, 최대 100
  min_score: number,        // 기본 0.5
}
```

- 사용자: "재즈 곡 뭐 있어?" → `{ genres: ['jazz'], limit: 30, min_score: 0.5 }`
- 사용자: "차분한 재즈 30곡만" → 같음 (감성형 단어 무시. MVP에서 mood 필터는 미지원)
- 사용자: "재즈랑 클래식" → `{ genres: ['jazz', 'classical'], ... }`

## Intent 분류 (Haiku 4.5)

`lib/intent.ts`:

```ts
async function classifyIntent(text: string): Promise<Intent>
```

- 모델: `claude-haiku-4-5`
- 사전 정규화: 한국어 별칭 사전으로 입력을 영어 키로 치환한 보조 정보 함께 전달.
- tool use로 응답 강제. zod로 검증.
- 실패 시 `{ kind: 'small_talk' }`로 폴백.

상세 프롬프트는 [intent-prompt.md] (Step 5에서 함께 작성).

## 쿼리 (`/api/chat` 모드 1 분기)

```ts
async function listLibraryByGenre(args: {
  userId: string
  genres: string[]
  minScore: number
  limit: number
}): Promise<TrackCard[]>
```

흐름:

1. `liked_tracks` ∪ `top_tracks` ∪ `plays`의 trackId 모음 (사용자 라이브러리).
2. 그 중 `genre_signals.scores[G] >= minScore` (G ∈ genres) 어디 하나라도 만족하는 트랙.
3. **lazy 계산**: 1번 목록 중 `genre_signals`에 없는 트랙 최대 200개에 대해 즉시 계산 + INSERT (Last.fm 호출 포함).
4. 결과 정렬: 매칭 장르 점수 합 내림차순, 동률은 `liked_at` 최신 우선.
5. `limit`만큼 자른 후 TrackCard[] 반환.

응답 페이로드:

```ts
type LibraryFilterResponse = {
  intent: 'library_filter'
  genres: string[]
  count: number              // 매칭 총 개수 (limit 적용 전)
  tracks: TrackCard[]
  computed: number           // 이번 호출에서 lazy 계산된 곡 수
  skipped: number            // 시간/한도 제약으로 계산 못한 곡 수 (다음 호출에 처리)
}
```

## 사용자 향 문자열 (`messages.library`)

- `library.title`: "내 라이브러리"
- `library.empty(genres)`: "${genres.join(', ')} 곡이 라이브러리에 없어요."
- `library.computing(n)`: "${n}곡 분석 중…"
- `library.partial(skipped)`: "${skipped}곡은 다음 요청에서 계속 분석할게요."
- `library.error.notSynced`: "먼저 설정에서 동기화를 해주세요."

## 향후

- 백그라운드 lazy 계산 큐 (전체 라이브러리 미리 계산)
- mood/period 필터 (slow/upbeat, 60s/80s 등)
- 다중 장르 AND/OR 토글
- Last.fm 외 추가 소스 (MusicBrainz?)
