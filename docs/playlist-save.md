# Playlist Save — `/api/playlist/save` 명세

큐레이션 결과를 Spotify에 실제 플레이리스트로 만든다.

## 결정

- **한 큐레이션당 1개 플레이리스트.** 멱등: 이미 저장된 큐레이션을 다시 저장하면 **기존 Spotify 플레이리스트의 트랙을 교체**한다(이름·설명도 갱신). 새 플레이리스트는 안 만든다.
- **사용자 검토 후에만 저장.** 자동 저장 없음. 큐레이션 상세 페이지 "Spotify에 저장" 버튼만 트리거.
- **기본 visibility = private**. 사용자 토글로 public 가능(MVP는 토글 미노출, 기본 private만).
- **트랙 순서**: 카테고리 영향원 → 동시대 → 후속 → 친족, 카테고리 내 `position` 오름차순.
- **시드는 첫 트랙으로 포함.** "이 큐레이션이 어떤 곡에서 출발했나"를 듣는 사람이 한 곡으로 본다.

## Request

```ts
POST /api/playlist/save
{
  curation_id: number
}
```

## Response

```ts
type SaveResponse =
  | {
      ok: true
      playlistId: string                // Spotify playlist id
      spotifyUrl: string                // https://open.spotify.com/playlist/...
      isReplace: boolean                // false = newly created, true = replaced existing
      trackCount: number
    }
  | {
      ok: false
      code: 'unauth' | 'not_found' | 'forbidden' | 'spotify_failed' | 'unknown'
      message: string
    }
```

- 401 미인증
- 404 큐레이션 없음 또는 본인 소유 아님 → `not_found`/`forbidden` 구분 안 함, `not_found`로 통일 (정보 노출 방지)
- 500 Spotify 호출 실패

## 플레이리스트 메타

### 이름
`Kinship: <Artist> — <Track>`

### 설명
`lineage_notes` 첫 문장 + `"by liner-chat · seed: <Artist> — <Track>"`. 최대 300자 (Spotify 한도 안전 마진).

### Privacy
`public: false`, `collaborative: false`.

## Spotify API 호출

```
1) GET /v1/me  → user id (세션 검증과 별개로 신선한 user id 확보)
   ※ 우리는 이미 users.id를 가지고 있으므로 호출 안 함. session.userId 사용.

2) 신규 저장:
   POST /v1/users/{user_id}/playlists
     body: { name, description, public: false }
   응답: { id, external_urls.spotify, ... }

3) 트랙 추가:
   PUT /v1/playlists/{playlist_id}/tracks
     body: { uris: ["spotify:track:..."] }
   ※ 한 번에 최대 100개. 우리는 12~15개라 1회 호출로 충분.
   ※ PUT은 트랙 전체를 교체. POST는 append. 우리는 멱등 위해 PUT.

4) 재저장(이미 있음):
   PUT /v1/playlists/{playlist_id}  (이름/설명 갱신)
     body: { name, description }
   PUT /v1/playlists/{playlist_id}/tracks  (트랙 교체)
     body: { uris: [...] }
```

`PUT /v1/playlists/{id}/tracks`는 기존 트랙을 모두 교체. 큐레이션 결과가 그대로 반영된다.

## DB 동작

```sql
SELECT * FROM curation_playlists WHERE curation_id = ?;
```

- 행 없음 → 신규 저장 흐름 → 새 행 INSERT
- 행 있음 → 기존 playlistId 사용 → 트랙 교체 흐름 → `saved_at` UPDATE

## 흐름

```
1. 세션 검증
2. curation_id 검증 (본인 소유? 안 그러면 not_found)
3. 큐레이션 + 시드 트랙 + 카테고리별 순서대로 추천 트랙 로드
4. URI 목록 생성: ["spotify:track:<seedId>", ...추천 트랙 ids]
5. curation_playlists 조회
6a. 없음 → 새 플레이리스트 생성 → 트랙 추가 → INSERT curation_playlists
6b. 있음 → 메타 + 트랙 PUT → UPDATE saved_at
7. 응답
```

## 멱등성 / 동시성

- 동일 큐레이션에 대해 같은 사용자가 빠르게 두 번 클릭 → 두 번 다 같은 playlistId로 작업. 두 번째는 첫 번째 결과를 덮어씀. 사용자에게 노출되는 차이 없음.
- 다른 사용자의 동시 호출은 영향 없음(서로 다른 plays.userId)

## 권한 스코프 확인

`auth-flow.md`에 등록된 스코프에 `playlist-modify-private`가 포함되어 있어야 함. 기존 스코프 리스트 점검 — 포함됨.

기존 사용자가 새 스코프 추가 전에 로그인한 경우 갱신된 동의 필요. MVP는 "로그아웃 후 다시 로그인" 안내로 충분.

## 사용자 향 문자열 (`messages.playlist`)

- `playlist.actions.save`: "Spotify에 저장" (이미 messages.curation.actions.saveToSpotify)
- `playlist.actions.saving`: "저장 중…"
- `playlist.actions.saved`: "저장됨 · Spotify에서 열기"
- `playlist.errors.notFound`: "큐레이션을 찾지 못했어요."
- `playlist.errors.spotifyFailed`: "Spotify 호출에 실패했어요. 잠시 후 다시 시도해주세요."
- `playlist.errors.unknown`: "저장 중 오류. 잠시 후 다시."

## 향후

- public 토글
- 사용자가 플레이리스트 이름/설명 편집 후 저장
- 디깅 체인 전체를 한 플레이리스트로 합치는 옵션
