# Auth Flow — Spotify OAuth (PKCE) + 세션

`lib/spotify/client.ts`, `lib/session.ts`, `app/api/auth/*` 라우트의 단일 진실원.

## 결정

- **Authorization Code + PKCE.** `client_secret`은 **callback의 토큰 교환에만** 서버에서 사용. 인증 시작 시점에는 PKCE의 code_verifier/code_challenge로 보호. PKCE는 추가 방어 (탈취된 code 재사용 차단).
- **세션 = iron-session 암호화 쿠키.** 서버사이드만 읽음. 쿠키에는 `spotifyUserId`만 저장. 토큰은 DB의 `auth_tokens` 테이블에 보관.
- **로그인 직후 토큰을 DB에 upsert**하고 쿠키에 `userId`만 심는다.
- **토큰 갱신**은 `lib/spotify/client.ts`의 fetch 래퍼가 매 호출 직전 `expires_at`를 확인해 자동 처리.

## 스코프

```
user-read-recently-played
user-top-read
user-library-read
playlist-modify-private
playlist-modify-public
user-read-email           # users.id 식별용 (Spotify user id가 email-like 아님, 그래도 안정 식별)
user-read-private         # display_name 등
```

스코프 변경 시 사용자 재인증 필요 (Spotify가 새 스코프 동의를 요구).

## 환경 변수

```
SPOTIFY_CLIENT_ID=
SPOTIFY_CLIENT_SECRET=
SPOTIFY_REDIRECT_URI=http://localhost:3000/api/auth/callback
SESSION_SECRET=    # 최소 32바이트. iron-session 암호화 키.
```

`SPOTIFY_REDIRECT_URI`는 **Spotify Developer Dashboard에 등록된 값과 정확히 일치**해야 함 (스킴/포트/경로 포함).

## PKCE 핵심값 생성

`lib/auth/pkce.ts`:

```ts
function generateCodeVerifier(): string
  // 43~128자 high-entropy. crypto.randomBytes(64) → base64url

function generateCodeChallenge(verifier: string): string
  // SHA-256(verifier) → base64url
```

base64url 인코딩: `+→-`, `/→_`, `=` 제거.

## State

CSRF 방어용 임의 토큰. `crypto.randomBytes(32).toString('hex')`. 인증 시작 시 만들어 임시 쿠키에 저장. 콜백에서 일치 검증.

## 임시 쿠키 (인증 진행 중 only)

`lib/session.ts`가 두 가지 세션 객체를 다룬다:

| 이름 | 쿠키 키 | 수명 | 페이로드 |
|------|---------|------|---------|
| oauth_state | `kc_oauth` | 10분 | `{ state, codeVerifier, redirectAfter? }` |
| user | `kc_session` | 30일 | `{ userId }` |

둘 다 iron-session으로 암호화. 다른 도메인 쿠키 같이 보이지만 분리 보관.

## 라우트

### `GET /api/auth/login`

쿼리: `redirect=/some/path` (선택, 로그인 후 돌아갈 곳)

1. `state` 생성, `codeVerifier` 생성, `codeChallenge = SHA-256(verifier)`
2. `kc_oauth` 쿠키에 `{ state, codeVerifier, redirectAfter }` 저장 (max-age 600초)
3. Spotify authorize URL 구성:
   ```
   https://accounts.spotify.com/authorize?
     response_type=code
     &client_id=$CLIENT_ID
     &scope=...
     &redirect_uri=$REDIRECT_URI
     &state=$state
     &code_challenge_method=S256
     &code_challenge=$codeChallenge
   ```
4. 302 redirect

### `GET /api/auth/callback`

쿼리: `code`, `state`, `error?`

실패 처리 순서:

1. `error` 있으면 → `/?auth_error=<error>` 로 redirect (사용자에 한국어 안내)
2. `kc_oauth` 쿠키 부재 → `/?auth_error=session_expired`
3. 쿠키의 `state` ≠ 쿼리 `state` → `/?auth_error=state_mismatch`
4. `code` 부재 → `/?auth_error=missing_code`

성공 경로:

5. POST `https://accounts.spotify.com/api/token`:
   ```
   grant_type=authorization_code
   code=$code
   redirect_uri=$REDIRECT_URI
   client_id=$CLIENT_ID
   code_verifier=$codeVerifier
   ```
   Authorization 헤더: `Basic base64(client_id:client_secret)`
   응답: `{ access_token, refresh_token, expires_in, scope, token_type }`
6. `GET /v1/me` (Bearer access_token) → `{ id, display_name, ... }`
7. 트랜잭션:
   - upsert `users (id, display_name)`
   - upsert `auth_tokens (user_id, access_token, refresh_token, expires_at = now + expires_in, scope)`
8. `kc_session` 쿠키에 `{ userId }` 저장, `kc_oauth` 쿠키 삭제
9. redirect to `redirectAfter || "/"`

### `POST /api/auth/logout`

- `kc_session` 쿠키 삭제
- (선택) `auth_tokens` 행 삭제 — MVP에서는 **남겨둠** (재로그인 시 동의 화면 한 번 더 안 봐도 됨)
- 응답 `{ ok: true }` 후 클라이언트가 `/`로 리다이렉트

## 토큰 갱신 (`lib/spotify/client.ts`)

자동 갱신 fetch 래퍼:

```ts
async function spotifyFetch(
  userId: string,
  path: string,                  // "/v1/me/tracks"
  init?: RequestInit
): Promise<Response>
```

내부:

1. DB에서 `auth_tokens` 조회.
2. `expires_at - now < 60초`면 갱신:
   - POST `accounts.spotify.com/api/token` `grant_type=refresh_token&refresh_token=...`
   - 응답이 새 `refresh_token`을 줄 수도 있고 안 줄 수도 있음. 새 값 오면 교체, 없으면 기존 유지.
   - `auth_tokens` UPDATE.
3. `fetch(\`https://api.spotify.com\${path}\`, { ...init, headers: { Authorization: \`Bearer ${access_token}\`, ...init.headers } })`
4. 401 응답이면 갱신을 1회 강제 후 재시도. 다시 401이면 throw `SpotifyAuthError`.
5. 429(rate limit) 응답: `Retry-After` 헤더의 초만큼 대기 후 1회 재시도. 두 번째도 429면 throw `SpotifyRateLimitError` (호출자가 처리).
6. 5xx: 즉시 throw `SpotifyServerError` (호출자가 재시도 정책 결정).

## 세션 헬퍼

`lib/session.ts`:

```ts
type UserSession = { userId: string }

async function getUserSession(): Promise<UserSession | null>
  // app/api/* 라우트와 서버 컴포넌트에서 사용. iron-session으로 kc_session 읽어옴.

async function setUserSession(s: UserSession): Promise<void>
async function clearUserSession(): Promise<void>

type OAuthSession = { state: string; codeVerifier: string; redirectAfter?: string }

async function setOAuthSession(s: OAuthSession): Promise<void>
async function getOAuthSession(): Promise<OAuthSession | null>
async function clearOAuthSession(): Promise<void>
```

Next.js 16 App Router의 cookies()는 비동기 (Promise). 그에 맞춰 모두 async.

## 보호 라우트 패턴

```ts
// app/api/sync/route.ts
export async function POST() {
  const session = await getUserSession()
  if (!session) return new Response("unauthorized", { status: 401 })
  // ... 진행
}
```

서버 컴포넌트는:

```tsx
const session = await getUserSession()
if (!session) redirect("/")
```

## 에러 코드 (UI 안내 메시지 매핑)

`/?auth_error=<code>` 의 code별 한국어 안내:

| code | 메시지 |
|------|------|
| `access_denied` | "Spotify 권한 동의가 취소됐어요. 다시 시도해주세요." |
| `session_expired` | "인증 세션이 만료됐어요. 다시 로그인해주세요." |
| `state_mismatch` | "보안 검증 실패. 새로 로그인해주세요." |
| `missing_code` | "인증 응답에 문제가 있었어요. 다시 시도해주세요." |
| `token_exchange_failed` | "Spotify 인증 서버에서 토큰을 못 받았어요. 잠시 후 다시." |
| `me_lookup_failed` | "사용자 정보를 가져오지 못했어요. 다시 시도해주세요." |
| `unknown` | "알 수 없는 오류. 다시 시도해주세요." |

## 보안 메모

- `access_token`, `refresh_token`은 DB에 **평문 저장**. MVP에서는 그대로. 운영 데이터로 가면 envelope encryption 고려.
- iron-session 쿠키 옵션: `httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production"`
- `SESSION_SECRET`는 환경변수로만. 절대 코드에 하드코딩 금지.

## Spotify Developer 앱 등록 (사용자가 직접 해야 함)

1. https://developer.spotify.com/dashboard 접속 → "Create app"
2. 앱 이름/설명 임의
3. **Redirect URIs**에 `http://localhost:3000/api/auth/callback` 추가 (정확히)
4. APIs used: Web API
5. 생성 후 Client ID / Client Secret을 `.env.local`에 복사
