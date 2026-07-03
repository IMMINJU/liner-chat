# Liner Chat

> **한 곡의 liner notes(음악적 계보)를 따라가며 친족을 디깅하는 대화형 큐레이터.**
> 좋아하는 곡 하나를 알려주면 LLM이 시대·장르·국적이 달라도 sonic moment가 통하는
> 곡을 찾고, Spotify Search로 실존 검증한 뒤, "이걸로 더 파보기"로 음악 굴을 따라간다.
> 도메인: `liner-chat.vercel.app`.

Next.js 16 + Neon Postgres + Drizzle + Claude (Haiku 의도 / Sonnet 친족 추천) + Spotify Web API(앱 토큰) + Last.fm.
**로그인 없음** — 단일 익명 사용자 모드로 동작하며, Spotify는 공개 카탈로그만 읽는다.

## 왜

스트리밍 추천은 협업필터링 — "이 곡 들은 사람들이 또 들은 곡" — 이라 뻔하다.
Liner Chat은 반대편에 선다: **음악적 DNA로 연결되는 곡**을 찾는다.

- Tame Impala "Elephant" (2012, 호주 사이키 록) ↔ John Lennon "Well Well Well" (1970) — 거친 보컬·헤비 디스토션·펑크적 폭발
- The Doors "L.A. Woman" (1971) ↔ ZZ Top "La Grange" (1973) — 클린톤으로 굴러가는 부기 셔플 그루브

추천은 4 카테고리: **influence**(영향원) / **peer**(동시대) / **descendant**(후속) /
**kinship**(장르·시대·국적의 강을 건너는 메타-친족 — 이 프로젝트의 존재 이유).

원칙: 추천은 트랙 단위 · LLM의 모든 픽은 Spotify 검증 통과 후에만 노출(할루시네이션
차단) · Spotify Recommendations API 미사용 · 큐레이션마다 관측 데이터
(`pipeline_stats`)가 쌓여 다음 개선의 근거가 된다.

## Quick start

```bash
pnpm install
# .env.local에 아래 변수를 채운다
pnpm db:push                                # Neon에 스키마 적용
pnpm dev                                    # http://localhost:3000 — 바로 채팅
```

## 필요한 자격증명 / API 키

`.env.local`에:

| 변수 | 어디서 |
|------|--------|
| `DATABASE_URL` | https://neon.com → 새 프로젝트의 connection string |
| `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` | https://developer.spotify.com/dashboard → Create app (Client Credentials만 사용 — redirect URI 불필요) |
| `LASTFM_API_KEY` | https://www.last.fm/api/account/create |
| `ANTHROPIC_API_KEY` | https://console.anthropic.com |
| `LEAP_PHASE_B` | (선택, 기본 off) `1`이면 도약 감사가 약한 kinship 픽을 floor 계산에서 제외하고 보충을 유도 |

※ 과거의 Spotify OAuth 로그인(`SPOTIFY_REDIRECT_URI`/`SESSION_SECRET`)은 제거됐다 — [docs/auth-flow.md](docs/auth-flow.md)에 이력.

## 사용 흐름

1. `/` — 로그인 없이 바로 채팅: `"Tame Impala Elephant 같은 거 추천해줘"`
   (조향도 됨: `"...같은 건데 더 깊고 안 알려진 걸로"`)
2. 응답 — 큐레이터의 의도(lineage_notes) + 4 카테고리 트랙 카드(sonic_link, 연결 축 칩, 미리듣기)
3. `/curations/[id]` — 큐레이션 상세 + **"🔍 이걸로 더 파보기"**로 디깅 체인
   (체인 상위 아티스트는 하위에서 자동 제외, 직전 여정이 다음 큐레이션의 컨텍스트가 된다)

## 문서 (경량 SDD)

먼저 읽는다: [`CLAUDE.md`](CLAUDE.md) (불변 규약), [`AGENTS.md`](AGENTS.md) (Next.js 16 주의).

**현행:**

| 문서 | 무엇 |
|------|------|
| [docs/overview.md](docs/overview.md) | 왜/무엇 |
| [docs/glossary.md](docs/glossary.md) | kinship, link_dimensions(8종), 카테고리(4종) |
| [docs/curation-pipeline.md](docs/curation-pipeline.md) | 파이프라인 명세 — 검증 규칙·보충·도약 감사·관측·데이터 게이트 |
| [docs/kinship-prompt.md](docs/kinship-prompt.md) | Sonnet 큐레이터 프롬프트 본문 + 설계 이력 |
| [docs/intent-prompt.md](docs/intent-prompt.md) | Haiku 의도 분류 (depth/힌트 추출) |
| [docs/data-model.md](docs/data-model.md) | DB 테이블 invariants + pipeline_stats |
| [docs/api-contracts.md](docs/api-contracts.md) | 라우트 입출력 |
| [docs/digging-chain.md](docs/digging-chain.md) | 디깅 체인 |

**폐지/역사 기록** (로그인 제거로 무효 — 구현 가이드로 쓰지 말 것):
[docs/auth-flow.md](docs/auth-flow.md) · docs/sync.md · docs/genre-classification.md · docs/playlist-save.md

## 개발 명령

```bash
pnpm dev                     # 개발 서버
pnpm build                   # 프로덕션 빌드 + 타입체크
pnpm lint                    # ESLint

pnpm db:generate             # 스키마 변경 후 마이그레이션 SQL 생성
pnpm db:push                 # Neon에 스키마 적용 (개발용)
pnpm db:studio               # Drizzle Studio (브라우저)

# 관측 리포트 — 검증 통과율/탈락 사유·표본/타이밍 p50·p95/도약 감사/Phase B 게이트
pnpm tsx scripts/report-pipeline-stats.ts [--since=YYYY-MM-DD] [--calibration-only|--exclude-calibration]

# 캘리브레이션 러너 — 카논 시드로 실큐레이션 표본 축적 (⚠ 실비용, --yes 필수)
pnpm tsx scripts/calibrate-pipeline.ts --yes [--chain]

pnpm tsx scripts/test-kinship.ts   # 5개 시드로 LLM 단독 sanity
```

## 디렉터리

```
liner-chat/
├─ app/                      # Next.js App Router
│  ├─ page.tsx               # 메인 (로그인 없음, 바로 채팅)
│  ├─ curations/[id]/page.tsx # 큐레이션 상세 (4 카테고리 + 디깅 체인)
│  └─ api/
│     ├─ chat/route.ts       # 자연어 → 의도 분기 → 큐레이션
│     └─ curate/route.ts     # 디깅 체인 직접 호출
├─ components/               # UI (Spotify × A24 다크)
├─ lib/
│  ├─ spotify/               # 앱 토큰 클라이언트 + 검증 엔진 (catalog.ts)
│  ├─ intent.ts              # Haiku 의도 분류
│  ├─ kinship.ts             # Sonnet 친족 추천 (프롬프트 본문)
│  ├─ curator.ts             # 오케스트레이션 (검증→보충→감사→저장)
│  ├─ leap.ts                # kinship 도약 감사기
│  └─ pipelineStats.ts       # 관측 데이터 타입 (jsonb)
├─ db/                       # Drizzle 스키마 + 마이그레이션
├─ docs/                     # 경량 SDD 문서
└─ scripts/                  # 관측 리포트 / 캘리브레이션 러너
```

## 라이선스 / 기여

개인용 프로젝트. PR 환영하지 않음(메인테이너 = minju).
