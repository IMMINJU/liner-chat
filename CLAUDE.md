# Claude Code 작업 규약 — Liner Chat

이 문서는 매 세션 자동 로드된다. 작업 시작 전에 반드시 한 번 훑고 시작.

## 프로젝트 한 줄

> **"큰 스키마 속의 음악적 친족(kinship)을 찾아주는 큐레이션 챗봇."**
> 사용자가 좋아하는 시드 곡 1곡 → LLM이 영향원·동료·후속·**친족(kinship, 핵심)** 카테고리로 트랙 추천 → Spotify 검증 → 디깅 체인으로 따라가기 → Spotify 플레이리스트 저장.

세부는 [docs/overview.md](docs/overview.md) 참조.

## 두 가지 모드

| 모드 | 트리거 예 | 흐름 |
|------|-----------|------|
| **모드 1 (보조)** 라이브러리 탐색 | "내 곡 중 재즈 뭐 있어?" | intent=library_filter → genre_signals 쿼리 → 트랙 목록 |
| **모드 2 (핵심)** 친족 큐레이션 | "Tame Impala Elephant 같은 거" | intent=kinship_curate → Sonnet 4.6 → Spotify verify → 4 카테고리 응답 |

## 항상 지켜야 할 것

1. **추천은 트랙 단위.** 아티스트 단위 추천 금지. LLM은 곡명+앨범+연도까지 명시해야 한다.
2. **LLM 응답은 반드시 Spotify Search로 검증.** artist 정확 매치 + album 부분 일치 + release year ±2. 미매치 트랙은 조용히 드랍. **할루시네이션 노출 절대 금지.**
3. **사용자 라이브러리에 이미 있는 트랙은 추천 결과에서 제외.** liked/top/plays 어디든.
4. **kinship 카테고리는 메타-친족이 핵심.** 장르·시대·국적이 다르지만 음악적 DNA로 연결되는 곡. 자세한 철학은 [docs/kinship-prompt.md](docs/kinship-prompt.md).
5. **link_dimensions는 8종 enum 고정**: `mood`, `structure`, `texture`, `narrative`, `groove`, `vocal_style`, `melody`, `progression`. 새로 추가하려면 enum/zod/tool/문서/UI/메시지 동시 갱신.
6. **Spotify Recommendations API는 절대 사용하지 않는다.** 협업필터링이 사용자가 거부한 "뻔한 추천"의 원인.
7. **LLM 모델 분리 유지**: 의도 분류=Haiku 4.5(`claude-haiku-4-5`), 친족 추천=Sonnet 4.6(`claude-sonnet-4-6`). 한 쪽에서 모델을 임의로 바꾸지 말 것.
8. **DB 스키마 변경은 반드시 `pnpm db:generate`로 마이그레이션 생성.** 직접 SQL 수정 금지.
9. **추천 신호 우선순위**: 외부 사실(콜라보/투어/직접 언급) → 계보(영향원/동시대/후속) → 프로덕션(프로듀서/레이블) → 소닉(link_dimensions 8종). 외부 사실은 잡힐 때 무조건 표면화하고 sonic_link에 명시. 단 LLM이 모르면 만들지 말 것.
10. **청취자 친숙도 조정**: `listenerProfile`(mainstream/mixed/obscure + seedPopularity)을 시드 컨텍스트에 항상 포함. obscure 청취자에게 "Creep" 같은 mainstream 트랙은 추천 풀에서 배제 등.
11. **lineage_notes는 큐레이터의 의도**(AccuRadio 채널 헤더 스타일). 단순 "이 곡의 친족"이 아니라 "어떤 청취자에게 어떤 발견을 시키는 큐레이션인지" 명시.

## 디렉터리 지도

```
spotify/
├─ CLAUDE.md                     # ← 지금 보는 파일
├─ AGENTS.md                     # Next.js 16 변경사항 경고 (필독)
├─ docs/                         # 경량 SDD 문서들 (아래 색인 참조)
├─ db/
│  ├─ schema.ts                  # Drizzle 스키마 (12 테이블)
│  ├─ client.ts                  # drizzle(neon(...)) 인스턴스
│  └─ migrations/                # pnpm db:generate로 생성
├─ app/                          # Next.js App Router
│  ├─ page.tsx                   # 메인 (로그인/채팅)
│  ├─ settings/page.tsx
│  ├─ curations/[id]/page.tsx
│  └─ api/                       # 라우트 핸들러
├─ components/                   # React 컴포넌트
├─ lib/
│  ├─ spotify/                   # Spotify API 래퍼
│  ├─ intent.ts                  # Haiku 의도 분류
│  ├─ kinship.ts                 # Sonnet 친족 추천
│  ├─ curator.ts                 # 모드 2 오케스트레이션
│  └─ genre.ts                   # 모드 1 점수
└─ .claude/
   └─ commands/                  # /sync, /curate 등 슬래시 커맨드
```

## docs 색인

- [docs/overview.md](docs/overview.md) — 무엇/왜
- [docs/glossary.md](docs/glossary.md) — kinship, sonic_link, 디깅 체인 등 용어 정의
- [docs/data-model.md](docs/data-model.md) — DB 테이블 + invariants
- [docs/curation-pipeline.md](docs/curation-pipeline.md) — 모드 2 파이프라인 단계별 명세
- [docs/kinship-prompt.md](docs/kinship-prompt.md) — Sonnet 시스템 프롬프트 본문 + 5개 테스트 시드
- (이후 Step 진입 시 추가될 문서: intent-prompt / genre-classification / auth-flow / api-contracts)

## 자주 쓰는 명령

```bash
pnpm dev              # 개발 서버
pnpm build            # 프로덕션 빌드 + 타입 체크
pnpm lint             # ESLint

pnpm db:generate      # 스키마 변경 후 마이그레이션 SQL 생성
pnpm db:push          # Neon에 스키마 적용 (개발용)
pnpm db:studio        # Drizzle Studio (브라우저 GUI)
```

DB 작업 시 `DATABASE_URL`이 `.env.local`에 있어야 한다. drizzle.config.ts는 `process.env.DATABASE_URL`을 읽음.

## Next.js 16 주의

`AGENTS.md`에 명시된 대로, 이 프로젝트는 **Next.js 16.2.6**이다. 학습 데이터의 Next.js 13/14/15 패턴이 깨질 수 있다:

- App Router 기본
- Route handler 시그니처, 동적 라우트 params, 캐시 동작 등이 14↔15↔16 사이 변경된 게 있음
- 새 패턴을 작성하기 전 `node_modules/next/dist/docs/` 의 해당 가이드를 한 번 확인할 것

## 디자인 규약 (Spotify × A24)

- **다크 모드 only.** 라이트 모드 자동 적용 금지. `prefers-color-scheme` 무시.
- **팔레트**: BG `#0B0B0E`/`#15151A`, FG `#F4EFE6`, teal `#3B6B73`, mustard `#C9A65D`, film-red `#A1342A`, Spotify green `#1DB954`.
- **Spotify green은 ‘Spotify와 직접 연결되는 액션’ 한정**: Save to Spotify 버튼, Open in Spotify 링크, 미리듣기 재생 중 상태, **메인 채팅 입력의 focus underline** (질문이 Spotify-anchored flow로 흘러간다는 신호), **워드마크의 가운데 점** (브랜드 액센트, 정적). 다른 곳(칩·헤딩·body·border) 사용 금지.
- **폰트 변수**: `--font-display`(DM Serif Display), `--font-serif`(Playfair Display), `--font-sans`(Inter), `--font-mono`(JetBrains Mono), `--font-korean-serif`(Noto Serif KR), `--font-korean-sans`(Noto Sans KR). 새 폰트 추가 금지.
- **사용 규칙**: 헤드라인·hero·lineage_notes 인용은 display/serif. 메타·날짜·ID·breadcrumb·칩 라벨은 mono. 한국어 본문(lineage_notes, sonic_link)은 `--font-korean-serif`. 한국어 chrome/버튼은 `--font-korean-sans`.
- **필름 그레인**은 `body::before`에 fixed로 깔린 SVG. 추가 그레인/노이즈 합성 금지.
- 칩은 transparent fill + 1px line. 채워진 칩 금지.
- 에러는 모달 X. film-red 얇은 가로 스트립 + mono 한국어.

## 스타일/관행

- TypeScript strict. `any` 금지, 불가피하면 `unknown` 후 좁히기.
- 외부 API 응답은 **zod 스키마로 파싱**해서 들어옴. 모든 LLM tool use 응답도 zod로 검증.
- DB 트랜잭션은 Drizzle `db.transaction`을 사용. upsert가 필요하면 `onConflictDoUpdate`.
- 한국어/영어 코멘트는 자유. 사용자 향 메시지는 한국어.
- **모든 사용자 향 문자열은 `lib/messages.ts`에 모은다.** 컴포넌트/라우트에 인라인 한국어 쓰지 말 것. i18n 도입 시 이 모듈만 교체하면 되도록.
- 시간 값은 `timestamptz` (DB), 코드에선 `Date` 객체로 다룸.
- **외부 호출은 반드시 timeout을 박는다.** Vercel Hobby의 함수 wall-clock이 60초라 한 호출이 매달리면 전체가 504로 죽는다. Spotify 호출(`lib/spotify/client.ts`)은 요청당 10초 + 429 Retry-After 5초 cap, Last.fm(`lib/lastfm.ts`)은 5초, Anthropic SDK(`lib/anthropic.ts`)는 30초. 새 외부 호출 추가 시 같은 패턴(AbortSignal.timeout 또는 SDK timeout 옵션).
- **사용자에게 보이는 시각은 항상 `lib/format.ts`의 `formatAbsKst` / `formatDateKst` / `formatRelativeKo`** 를 거친다. `.toISOString()` / `.toLocaleString()` 직접 호출 금지 (전자는 UTC를 그대로 찍어 한국시간으로 오인됨). 기본은 절대 시각, "마지막 재생"·"recent diggings"처럼 흐름감이 필요한 곳만 상대.

## 작업 시작 시 체크리스트

새 기능을 시작하기 전:

1. [docs/overview.md](docs/overview.md) 와 이 CLAUDE.md를 머릿속에 둔다.
2. 해당 기능에 대응하는 docs 문서가 있는지 확인. 없으면 **작성 후 코드 진입** (경량 SDD).
3. 영향받는 DB 테이블 / API 라우트 / lib 모듈을 미리 파악.
4. 의문점은 minju에게 묻고, 가정하지 말 것.

## 작업 완료 시 체크리스트

기능 구현 후 끝내기 전:

1. `pnpm build`로 타입체크 + 빌드 통과.
2. 변경된 데이터 모델/계약이 docs에 반영됐는지.
3. 새로 만든 외부 API 호출에 에러 처리 / 재시도가 있는지.
4. LLM 응답 시 검증 단계가 누락되지 않았는지.
