# Overview — Liner Chat

## 한 줄

> 사용자가 좋아한 시드 곡 1곡으로부터, **음악적 친족(kinship)** 카테고리를 포함한 4축 추천을 만들고, 디깅 체인으로 음악을 따라가게 하는 챗봇.

## 왜 만드는가

Spotify의 디스커버 위클리/Radio/Recommendations API는 **협업필터링**(이 곡 들은 사람들이 또 들은 곡)을 기반으로 한다. 결과는 종종 **동시대의 유사 곡**에 치우쳐서 "뻔하다."

사용자(minju)가 원하는 추천은 음악 평론가가 떠올리는 식:

- Tame Impala "Elephant" → John Lennon "Well Well Well" (Plastic Ono Band, 1970)
- Sex Pistols "God Save the Queen" → The Beatles "Birthday" (White Album, 1968)
- The Doors "L.A. Woman" → Dire Straits "Sultans of Swing" → Bob Dylan "Things Have Changed"

위 사슬들의 공통점: **장르·시대·국적이 다르지만 음악적 정체성(보컬 톤·내러티브·텍스처·그루브)이 통한다.** 협업필터링이 절대 못 잡는 연결이고, **LLM의 음악적 추론이 본질적으로 필요한 영역**이다.

## 두 모드

### 모드 1 — 라이브러리 탐색 (보조)

> "내 곡 중에 재즈 뭐 있어?"

자기 라이브러리에서 장르 신호로 필터링. 외부 API 호출 없음. 자기 발견용.

### 모드 2 — 친족 큐레이션 (메인)

> "Tame Impala Elephant 같은 거 추천해줘"

LLM이 영향원/동료/후속/**친족(kinship)** 카테고리로 트랙 추천 → Spotify Search로 검증 → 라이브러리 중복 제외 → 웹 프리뷰(설명 첨부) → 사용자가 검토 후 Spotify 플레이리스트에 저장 → 마음에 든 곡으로 **디깅 체인** 시작.

자세한 흐름은 [curation-pipeline.md](curation-pipeline.md).

## 차별점

1. **트랙 단위** — 아티스트가 아니라 그 곡 안의 특정 음악적 순간 매칭
2. **장르/시대 가로지름** — kinship 카테고리가 핵심 가치
3. **연결고리 명시** — 각 추천에 `link_dimensions` 칩 (분위기/창법/내러티브 등)
4. **할루시네이션 차단** — Spotify Search로 (artist+album+year) 검증, 미매치 드랍
5. **디깅 체인** — 추천 → 마음에 든 곡 → 새 시드 → 또 추천 → 끝없이 따라가기
6. **사용자 검토 단계** — Spotify에 자동 저장 아님. 웹 프리뷰에서 보고 누른 사람만 저장.

## 비-목표 (Non-goals)

- **Spotify 추천 알고리즘 의존 금지.** Recommendations API 사용 안 함.
- **자동 플레이리스트 생성 금지.** 사용자가 명시적으로 "저장" 클릭해야 만들어짐.
- **여러 사용자 동시 서비스 아님.** 개인용 도구 스케일.
- **MVP에 Extended Streaming History zip 임포트 포함 안 함.** v2.

## 기술 스택 요약

- **Next.js 16.2.6** App Router + TypeScript + Tailwind 4
- **Neon Postgres + Drizzle ORM** (`@neondatabase/serverless`, `drizzle-orm/neon-http`)
- **Anthropic SDK** — `claude-haiku-4-5` (의도), `claude-sonnet-4-6` (친족 추천), tool use로 응답 강제
- **Spotify Web API** — Auth Code + PKCE, Search/Audio Features/Artist/Playlist
- **Last.fm API** — 모드 1 장르 분류 보조
- **iron-session** — 쿠키 기반 세션
- **zod** — 모든 외부/LLM 응답 검증

## MVP 범위

- Spotify 로그인 (PKCE)
- 동기화: liked + top(3 time_range) + recently-played(50) + audio features
- 모드 1: 자연어 장르 필터 답변
- 모드 2: 단일 시드 → 4 카테고리 추천 → 프리뷰 페이지
- 디깅 체인: 추천 카드에서 새 시드로 분기
- Spotify에 플레이리스트로 저장

## 향후 (v2+)

- Extended Streaming History zip 임포트
- 시드 다중 (2-3곡 평균)
- 피드백 학습 (좋음/별로)
- 디깅 체인 트리 시각화
- LLM 응답 스트리밍
- Apple Music/Tidal 링크
