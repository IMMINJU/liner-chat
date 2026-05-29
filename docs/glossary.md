# Glossary — 공유 어휘

코드/문서/UI 전반에 일관되게 쓰는 용어들. **새 동의어를 만들지 말 것.**

## 도메인

### kinship (음악적 친족)
장르·시대·국적·팬층이 달라도 음악적 정체성(분위기·창법·내러티브·텍스처·그루브·곡 구성)이 통하는 관계. 이 프로젝트의 **핵심 추천 카테고리**.

> 예: The Doors "L.A. Woman" ↔ Dire Straits "Sultans of Swing" — 미국/영국, 71/78, 사이키 블루스/록 컨트리 포크. 그러나 **롱폼 어쿠스틱 그루브 + 내러티브 보컬 + 도시 풍경**이 같다.

### sonic moment (음악적 순간)
한 트랙 안의 특정 구간/요소 — 보컬 톤, 편곡 디테일, 그루브 변화, 가사 화법. **추천의 단위는 곡 전체가 아니라 sonic moment의 매칭**이라는 의도가 깔려 있음.

### sonic_link
한 추천 트랙이 시드와 **어떤 sonic moment에서 만나는지** 1-2문장으로 설명한 한국어 텍스트. 데이터: `curation_tracks.sonic_link` (TEXT).

### link_dimensions
sonic_link의 연결이 일어나는 차원(들). **고정 8종 enum:**

| 값 | 의미 | 예 |
|-----|------|-----|
| `mood` | 분위기 | 도시적, 황홀, 우울, 긴장 |
| `structure` | 곡의 거시 구성 | 롱폼, 빌드업, 솔로 비중, 코다 페이드 |
| `texture` | 사운드 텍스처 | 어쿠스틱/일렉트릭 비율, 공간감, 드라이/웻 |
| `narrative` | 가사 화법 | 1인칭 관찰자, 묘사 디테일 |
| `groove` | 그루브감 | 스윙, 셔플, 록 직진, 폴리리듬 |
| `vocal_style` | 창법 | 읊조림, 내뱉기, 벨팅, 휘파람톤 |
| `melody` | 멜로디 라인 | 후렴 모티프, 보컬 멜로디 윤곽(상승/하강/도약), 멜로디 후크의 위치·반복 |
| `progression` | 화성·진행 방식 | 코드 진행 패턴(I-V-vi-IV 등), 모달 vs 토널, 브릿지/후렴 전환 방식, 키 모듈레이션 |

각 추천에 **1-3개** 부여. **신규 값 추가는 enum/zod/tool/문서/UI/메시지 동시 갱신 동반.**

`structure` vs `melody` vs `progression` 구분:
- 거시 구성(롱폼/빌드업/솔로 비중) → `structure`
- 보컬·악기 라인의 모양 → `melody`
- 코드 흐름·전조·모달리티 → `progression`
세 차원이 가까우면 2개 같이 선택 가능(예: `["melody","progression"]`).

### 디깅 체인 (digging chain)
한 큐레이션의 추천 결과 중 마음에 든 곡을 새 시드로 삼아 다시 큐레이션하는 행동. DB에서 `curations.parent_curation_id`로 부모를 가리키는 트리. UI에서는 브레드크럼으로 표시.

## 추천 카테고리 (`curation_tracks.category`)

4종 enum 고정. UI 표기는 한국어.

| 값 | UI 한국어 | 정의 |
|-----|-----------|------|
| `influence` | 영향원 | 시드 아티스트/곡이 영향받은 선배의 곡 |
| `peer` | 동시대 동료 | 시드와 같은 시기의 비슷한 정체성을 가진 곡 |
| `descendant` | 후속 | 시드의 사운드를 계승한 후배의 곡 |
| `kinship` | 음악적 친족 | 시대·장르·국적이 다르지만 음악 DNA가 통하는 곡 (**핵심**) |

## 데이터 소스

### Spotify 데이터 (사용자별)

- **liked tracks** — `/me/tracks`. 사용자가 좋아요한 곡 전체.
- **top tracks** — `/me/top/tracks?time_range=...`. Spotify가 집계한 사용자별 자주 듣는 곡 top 50.
- **time_range** — `short_term`(약 4주), `medium_term`(약 6개월), `long_term`(평생).
- **recently-played** — `/me/player/recently-played`. 최근 50곡 (이게 윈도우 상한).

### Spotify 카탈로그

- **Audio Features** — `/v1/audio-features/...`. 트랙별 energy, valence, tempo, acousticness 등 객관 지표.
- **Search** — `/v1/search`. 친족 추천의 **검증 단계**에서 사용. LLM이 만든 (artist, track, album, year)를 던져서 실제 카탈로그에서 찾음.

### Last.fm

- **track.getTopTags** — 트랙별 사용자 태그.
- **artist.getTopTags** — 아티스트별 사용자 태그.
- 모드 1(라이브러리 장르 분류)에서 Spotify 아티스트 장르의 부족분 보강.

## LLM 호출 종류

| 모듈 | 모델 | 역할 |
|------|------|------|
| `lib/intent.ts` | `claude-haiku-4-5` | 자연어 → `Intent` 객체 (library_filter / kinship_curate / list_top / small_talk) |
| `lib/kinship.ts` | `claude-sonnet-4-6` | 시드 컨텍스트 → 4 카테고리 트랙 추천 (tool use) |

tool use 응답은 모두 zod로 검증. 실패 시 1회 재시도, 그래도 실패면 에러.

## 시드 결정 모드

intent의 `seed.type`:

- `track_text` — 사용자가 명시한 곡명. Spotify Search로 트랙 id 확정.
- `auto_top_recent` — `top_tracks(short_term)`에서 1곡 자동 선정.
- `auto_dormant_liked` — `liked_tracks` 중 `plays`에 최근 90일 기록 없는 곡 1곡.

## 정규화 (normalize)

검증에서 문자열 비교 시:

1. 소문자
2. 공백 정규화 (`\s+` → 단일 공백)
3. 특수문자 제거 (`[^\p{L}\p{N}\s]` → 공백 후 트림)
4. 접두어 `the `, `a ` 제거 (양쪽 모두에서)

`artist`는 정확 일치, `album`은 정규화 후 부분 일치(`includes`).

## 검증 결과 (verifyTrack 반환)

`{ id, name, artist, album, releaseDate, durationMs, spotifyUrl, previewUrl } | null`

null이면 **그 추천은 조용히 드랍**. 사용자에게 노출 안 함.
