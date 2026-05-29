# Sync — `/api/sync` 명세

Spotify 사용자 데이터를 우리 DB로 한 번에 끌어오는 라우트. 모드 1(장르 탐색)과 모드 2(친족 큐레이션) 모두 이 데이터를 전제로 한다.

## Spotify 정책 변경: audio_features 단계 제거 (2024-11-27 이후)

Spotify가 `/v1/audio-features`, `/v1/audio-analysis`, `/v1/recommendations`,
related-artists 등을 신규 앱에 대해 비공개로 전환했다. 우리 앱은 정책 발효
이후 생성됐으므로 403을 받는다. **`enrichAudioFeatures` 단계를 sync에서
제거**하고, 시드 컨텍스트 구성 시 audio/tonal 필드는 항상 비운다. 이후 Spotify
정책이 다시 열리면 lib/spotify/sync/audio.ts를 살려서 단계만 다시 끼우면 된다
(스키마와 모듈은 보존).

영향:
- LLM에 audio features(energy/valence/tempo/...)와 tonal(key/mode/time_signature) 정보가 전달되지 않는다.
- 친족 추천은 Sonnet의 음악 지식만으로 동작 (멜로디·진행·창법 등 분석은 그대로).
- audio_features 테이블은 비어있는 채 유지된다 (FK 영향 없음).

## 결정

- **`POST /api/sync`** — 인증된 사용자 본인의 데이터를 동기화. 멱등(idempotent), 같은 시점 두 번 호출해도 결과 동일하거나 안전하게 누적.
- **단일 라우트 + 단일 트랜잭션 아님.** 각 소스(liked, top × 3, recently-played, audio features)는 독립 단계. 한 단계 실패해도 다른 단계는 진행.
- **요약 응답**: 각 단계의 success/fail + 적재 카운트. UI(설정 페이지)는 이걸 그대로 표시.
- **비동기 큐 없음.** MVP는 동기 처리. 처리 시간이 길어질 수 있지만(수천 곡 좋아요 + audio features), 1회성 작업이므로 허용.
- **반복 호출 시 increment**: `liked_tracks`는 upsert, `top_tracks`는 새 `snapshot_at`으로 누적, `plays`는 unique 인덱스로 dedupe, `audio_features`는 미수집 트랙만 보강.

## 흐름

```
1. 세션 검증
2. liked 동기화 (전체 페이지네이션)
3. top × 3 time_range 동기화 (각 50곡)
4. recently-played 동기화 (50곡, 새 plays만 INSERT)
5. audio_features 보강 (현재까지 적재된 trackId 중 audio_features 없는 것만)
6. 각 단계의 결과 집계 반환
```

각 단계는 자기 안에서 artists/tracks upsert를 먼저 한다 (FK 만족 위해).

## 단계별 세부

### A. `syncLikedTracks(userId)`

- 엔드포인트: `GET /v1/me/tracks?limit=50&offset=N`
- 전체 페이지 순회 (응답 `next`가 null일 때까지).
- 각 아이템: `{ added_at, track: { id, name, album, artists, ... } }`
- 처리:
  1. 등장한 모든 artist를 모아 unique → artists 테이블에 upsert (`spotify_genres`는 비워두고, Step C(top 동기화) 다음에 별도 fetch — Spotify Get Artist 호출 절약을 위해 모든 artist를 batch로 한 번 모아 처리. 자세한 건 D 참조).
  2. 등장한 모든 track upsert. `album_release_date`는 응답의 `album.release_date`에서 (`year`만 있으면 YYYY-01-01).
  3. `liked_tracks` upsert: `(userId, trackId)` PK, `liked_at = added_at`.
- 페이지네이션 페이스: 50/페이지, 응답에 `next` URL. 50 페이지(2500곡)까지는 무리 없음. 그 이상이면 wall-clock 길어질 수 있음.
- **반환**: `{ added: number, skipped: number, total: number }`

### B. `syncTopTracks(userId)`

3개 time_range 각각:
- 엔드포인트: `GET /v1/me/top/tracks?time_range=short_term&limit=50`
- 처리:
  1. 등장한 artists/tracks upsert.
  2. `top_tracks` INSERT — `snapshot_at = now()` (이번 호출의 단일 타임스탬프 공유), `rank`는 응답 순서대로 1..N.
  3. PK `(user_id, track_id, time_range, snapshot_at)`로 같은 호출 중 중복 없음.
- **반환**: `{ short_term: number, medium_term: number, long_term: number }`

### C. `syncRecentlyPlayed(userId)`

- 엔드포인트: `GET /v1/me/player/recently-played?limit=50`
- 처리:
  1. 등장한 artists/tracks upsert.
  2. `plays` INSERT — `played_at = item.played_at`.
  3. `(user_id, track_id, played_at)` UNIQUE 인덱스로 dedupe. 이미 있으면 INSERT 무시(`onConflictDoNothing`).
- **반환**: `{ inserted: number, duplicates: number }`

### D. `enrichArtistGenres(userId)`

A/B/C가 끝나면 `artists` 테이블에 `fetched_at`이 null이거나 24시간 이전인 행의 id 수집:
- 엔드포인트: `GET /v1/artists?ids=...` (최대 50개씩 batch)
- 응답: `artists: [{ id, name, genres: [...] }]`
- UPDATE: `spotify_genres = genres`, `fetched_at = now()`
- **반환**: `{ enriched: number }`

### E. `enrichAudioFeatures(userId)`

- 우리 DB의 모든 트랙 중 audio_features에 없는 trackId 수집 (현재 사용자 한정 안 함 — 카탈로그 데이터라 공유).
- 단, 이번 동기화에서 새로 들어온 트랙만 대상으로 좁힘 (전체 카탈로그 backfill은 별도 절차로 분리; MVP에선 동기화 호출 안에서 새 트랙만).
- 엔드포인트: `GET /v1/audio-features?ids=...` (최대 100개씩 batch)
- 응답 객체별로 `audio_features` 테이블 INSERT.
- 응답에서 일부 트랙이 `null`로 올 수 있음 (Spotify 미지원) — 그건 INSERT 안 함(다음 동기화에서 재시도 안 함, 그래야 함; 현재 MVP에선 단순화하여 그냥 스킵).
- **반환**: `{ enriched: number, missing: number }`

## 새로 들어온 트랙 식별

`A/B/C` 단계들이 `db.transaction` 안에서 작업하면서, 각 단계가 자기가 INSERT/UPSERT한 `trackId`를 메모리에 모아둠. 이걸 union 해서 `E` 단계의 후보로 전달.

(나중에 backfill 필요해지면 별도 admin 스크립트로.)

## 응답 형식

```ts
type SyncResponse =
  | {
      ok: true
      durationMs: number
      liked: { added: number; skipped: number; total: number }
      top: {
        short_term: number
        medium_term: number
        long_term: number
      }
      recently: { inserted: number; duplicates: number }
      artists: { enriched: number }
      // audio 필드는 정책 변경으로 제거됨 — 위 "정책 변경" 단락 참조
    }
  | {
      ok: false
      durationMs: number
      partial: {
        liked?: { added: number; skipped: number; total: number }
        top?: { short_term: number; medium_term: number; long_term: number }
        recently?: { inserted: number; duplicates: number }
        artists?: { enriched: number }
        audio?: { enriched: number; missing: number }
      }
      failedStages: string[]   // ['top', 'audio']
      errors: { stage: string; message: string }[]
    }
```

ok: true → 전 단계 성공. ok: false → 일부 실패하더라도 완료된 단계의 카운트와 실패 단계명을 반환. UI에서 "liked 2300곡 완료 / audio 보강 실패" 식으로 표시.

## Rate limit / 시간 예산

- 좋아요 2500곡 가정: liked 페이지네이션 50회 × ~300ms = 15초.
- top × 3 = 3회 호출 = <2초.
- recently = 1회 = <1초.
- artist enrich: 새 artist 200명 가정 = 4 batch × ~300ms = 1.5초.
- audio features: 새 트랙 2500곡 = 25 batch × ~300ms = 8초.
- **총 ~25-30초 worst case.** 사용자에게 "수십 초 걸려요" 안내 + 진행 상태 폴링은 v2 (현재는 한 번 호출 후 완료 응답).

429 처리는 `lib/spotify/client.ts`가 처리 (Retry-After 1회). 두 번째 429 → 그 단계만 실패 처리 후 다음 단계 진행.

## Idempotency

같은 사용자가 1분 안에 두 번 호출:
- liked: upsert이므로 중복 INSERT 없음.
- top: 새 `snapshot_at`(현재 시각)으로 새 행 누적 → 히스토리 데이터로 가치 있음. 사용자에게 "방금 동기화 됐어요. 1시간 후 다시 시도해주세요" 같은 throttle은 MVP에 안 넣음 (data-model.md의 top_tracks invariant 그대로 따름).
- recently: 같은 (user, track, played_at) UNIQUE → 중복 없음.
- audio: 이미 있는 trackId 제외 → 중복 작업 없음.

따라서 동기화는 안전하게 반복 호출 가능. (다만 사용자 입장에선 비싸므로 UI에서 버튼 연타 막는 정도 처리는 권장.)

## 보조: 설정 페이지

- `app/settings/page.tsx` 서버 컴포넌트로:
  - 마지막 동기화 시각 (가장 큰 `top_tracks.snapshot_at`)
  - 현재 카운트:
    - liked 곡 수
    - audio_features 보강된 곡 수 / 전체 트랙 수
    - 최근 plays 50건의 마지막 played_at
  - "지금 동기화" 버튼 → fetch POST `/api/sync` → 응답 표시
- UI는 Figma Make 디자인 들어오면 교체. 지금은 최소 마크업.

## 사용자 향 문자열

`lib/messages.ts`의 `sync` 그룹:
- `sync.title`: "설정"
- `sync.runButton`: "지금 동기화"
- `sync.running`: "동기화 중…"
- `sync.success(d)`: `liked 2300, top 150, recently 23, audio +2150 — ${dms}ms` 같은 요약
- `sync.partial(stages)`: `완료: ... / 실패: ${stages.join(', ')}`
- `sync.errors.notAuth`: "로그인이 필요해요."
- `sync.errors.unknown`: "동기화 중 오류가 발생했어요. 잠시 후 다시 시도해주세요."

## 향후

- v2: 백그라운드 큐 + 진행 상태 폴링 (수만 곡 사용자 위해)
- Extended Streaming History JSON 임포트 (별도 라우트)
- 전체 audio features backfill 별도 admin 스크립트
