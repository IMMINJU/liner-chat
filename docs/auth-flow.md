# Auth Flow — 제거됨 (로그인 없는 단일 사용자 모드)

> **이 문서는 더 이상 유효하지 않다.** Spotify OAuth(PKCE) 로그인은 전면 제거됐다.
> 아래는 무엇이 바뀌었는지에 대한 기록이다.

## 무엇이 바뀌었나

- **로그인/세션 전면 제거.** `app/api/auth/*`, `lib/session.ts`, `lib/auth/pkce.ts`, iron-session 의존성 모두 삭제.
- **Spotify 호출은 이제 Client Credentials(앱 토큰)만 사용.** 사용자 OAuth 토큰이 없으므로 공개 카탈로그 엔드포인트(`/v1/search`, `/v1/tracks`, `/v1/artists`)만 호출한다. 토큰 발급/캐시는 `lib/spotify/tokens.ts`의 `getAppAccessToken()`, fetch 래퍼는 `lib/spotify/client.ts`(userId 인자 없음).
- **단일 익명 사용자.** 모든 큐레이션은 `lib/localUser.ts`의 고정 id `LOCAL_USER='local'`이 소유한다. `ensureLocalUser()`가 첫 큐레이션 전에 `users` 행을 보장한다.
- **DB 스키마는 그대로 박제.** `users`, `auth_tokens`, `liked_tracks`, `top_tracks`, `plays`, `genre_signals` 테이블은 삭제하지 않고 미사용 상태로 둔다(나중에 멀티유저 복원을 쉽게 하기 위함). 따라서 마이그레이션 없음.

## 같이 사라진 기능

- 라이브러리 동기화(`/api/sync`, `lib/spotify/sync/*`)
- 모드 1 라이브러리 장르 탐색(`lib/library.ts`, `lib/genre*.ts`)
- 라이브러리 기반 중복 제외 / `listenerProfile`의 `librarySophistication`(이제 항상 `'mixed'`, `seedPopularity`만 시드에서 실측)
- Spotify 플레이리스트 저장(`/api/playlist/save`, `lib/spotify/playlist.ts`)
- 라이브러리 기반 auto-seed(`auto_top_recent` / `auto_dormant_liked`) — 시드는 이제 `track_text` / `track_id`만

## 그대로 남은 것

- 모드 2 친족 큐레이션(Sonnet) + Spotify 검증(할루시네이션 차단)
- 미리듣기 재생 = `open.spotify.com/embed` iframe (로그인 불필요, 원래도 `preview_url` 미사용)
- 디깅 체인(`collectChainContext` + `parent_curation_id`)
