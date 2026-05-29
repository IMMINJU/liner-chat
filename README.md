# Liner Chat

> **내 Spotify 라이브러리 위에서, 한 곡의 liner notes(음악적 계보)를 따라가며 친족을 디깅하는 대화형 큐레이터.**
> 시대·장르·국적이 달라도 sonic moment가 통하는 곡을 LLM이 찾고, Spotify Search로 검증한 뒤, "이걸로 더 파보기"로 음악 굴을 따라간다.
> 도메인: `liner-chat.vercel.app`.

Next.js 16 + Neon Postgres + Drizzle + Claude (Haiku 의도 / Sonnet 친족 추천) + Spotify Web API + Last.fm.

## Quick start

```bash
pnpm install
cp .env.local.example .env.local           # 채워야 동작
pnpm db:push                                # Neon에 스키마 적용
pnpm dev                                    # http://localhost:3000
```

## 필요한 자격증명 / API 키

`.env.local`에 다음 모두 필요:

| 변수 | 어디서 |
|------|--------|
| `DATABASE_URL` | https://neon.com → 새 프로젝트의 connection string |
| `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` | https://developer.spotify.com/dashboard → Create app |
| `SPOTIFY_REDIRECT_URI` | `http://localhost:3000/api/auth/callback` (Spotify 앱 설정에도 동일 등록) |
| `LASTFM_API_KEY` | https://www.last.fm/api/account/create |
| `ANTHROPIC_API_KEY` | https://console.anthropic.com |
| `SESSION_SECRET` | `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |

자세한 OAuth 흐름은 [docs/auth-flow.md](docs/auth-flow.md).

## 사용 흐름

1. `/` → "Spotify로 시작하기" 로그인
2. `/settings` → "지금 동기화" — liked + top(3 time_range) + recently-played + audio features 일괄 적재 (수십 초)
3. 채팅(현재는 `/api/chat` 직접 호출, UI는 Figma Make 디자인 들어오면 교체):
   - 모드 1: `"내 곡 중 재즈 뭐 있어?"` → 라이브러리 장르 답변
   - 모드 2: `"Tame Impala Elephant 같은 거 추천해줘"` → 친족 큐레이션
4. `/curations/[id]` → 4 카테고리(영향원/동시대/후속/친족) + 트랙별 sonic_link + "🔍 이걸로 더 파보기" (디깅 체인) + "Spotify에 저장"

## 문서 (경량 SDD)

먼저 읽는다: [`CLAUDE.md`](CLAUDE.md) (불변 규약), [`AGENTS.md`](AGENTS.md) (Next.js 16 주의).

| 문서 | 무엇 |
|------|------|
| [docs/overview.md](docs/overview.md) | 왜/무엇 |
| [docs/glossary.md](docs/glossary.md) | kinship, link_dimensions(8종), 카테고리(4종) |
| [docs/data-model.md](docs/data-model.md) | 12 테이블 invariants |
| [docs/api-contracts.md](docs/api-contracts.md) | 라우트 입출력 |
| [docs/auth-flow.md](docs/auth-flow.md) | Spotify PKCE |
| [docs/sync.md](docs/sync.md) | 동기화 단계 |
| [docs/genre-classification.md](docs/genre-classification.md) | 모드 1 점수 |
| [docs/intent-prompt.md](docs/intent-prompt.md) | Haiku 의도 분류 |
| [docs/curation-pipeline.md](docs/curation-pipeline.md) | 모드 2 파이프라인 |
| [docs/kinship-prompt.md](docs/kinship-prompt.md) | Sonnet 친족 프롬프트 본문 |
| [docs/digging-chain.md](docs/digging-chain.md) | 디깅 체인 |
| [docs/playlist-save.md](docs/playlist-save.md) | Spotify 저장 |

## 개발 명령

```bash
pnpm dev                     # 개발 서버
pnpm build                   # 프로덕션 빌드 + 타입체크
pnpm lint                    # ESLint

pnpm db:generate             # 스키마 변경 후 마이그레이션 SQL 생성
pnpm db:push                 # Neon에 스키마 적용 (개발용)
pnpm db:studio               # Drizzle Studio (브라우저)

pnpm tsx scripts/test-kinship.ts   # 5개 시드로 LLM 단독 sanity
```

## 디렉터리

```
spotify/
├─ app/                      # Next.js App Router
│  ├─ page.tsx               # 메인 (로그인/허브)
│  ├─ settings/page.tsx      # 동기화 + 통계
│  ├─ curations/[id]/page.tsx # 큐레이션 상세 (4 카테고리 + 디깅 + 저장)
│  └─ api/
│     ├─ auth/{login,callback,logout}/route.ts
│     ├─ sync/route.ts
│     ├─ chat/route.ts       # 의도 분기
│     ├─ curate/route.ts     # 친족 큐레이션 직접 호출
│     └─ playlist/save/route.ts
├─ components/               # 클라이언트/서버 컴포넌트
├─ lib/                      # 외부 API 래퍼 + 도메인 로직
├─ db/                       # Drizzle 스키마 + 마이그레이션
├─ docs/                     # 경량 SDD 문서
└─ scripts/                  # 단독 실행 sanity 스크립트
```

## UI

채팅·큐레이션 카드 UI는 **Figma Make 디자인 핸드오프 예정**. 현재 페이지들은 동작 검증용 최소 마크업이다. 디자인이 들어오면 `components/` 하위 컴포넌트를 교체하고 라우트 응답 계약([api-contracts.md](docs/api-contracts.md))은 유지한다.

## 라이선스 / 기여

개인용 프로젝트. PR 환영하지 않음(메인테이너 = minju).
