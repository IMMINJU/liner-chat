# Curation Pipeline — 친족 큐레이션 흐름 명세

사용자 입력 → 추천 카드 → 디깅 체인까지의 단계별 명세. 로그인 없는 단일 사용자 모드
(`LOCAL_USER`) 기준의 **현행** 문서다. 과거의 라이브러리 동기화/모드 1/플레이리스트
저장 흐름은 [auth-flow.md](auth-flow.md)에 역사 기록으로만 남아 있다.

```
[chat input] → [intent classify (Haiku)] → [seed resolve] → [seed context ∥ chain context]
   → [kinship LLM (Sonnet)] → [Spotify verify (tiered)] → [dedupe/diversify]
   → [보충 (조건부, Sonnet 1회)] → [save gate] → [DB save] → [client response] → [dig deeper]
```

## 타임아웃 계층 (Vercel Fluid Compute)

플랫폼 300s > 라우트 `maxDuration = 120` > chat race 110s > **큐레이터 하드캡 100s**
> Sonnet 1차 55s / 보충 30s > Spotify 요청당 10s (+429 Retry-After 5s cap) > Last.fm 5s
> intent(Haiku) 8s.

하드캡은 `Promise.race` + **AbortController**다: 캡이 발화하면 `llm_failed`를 반환하는
동시에 abort하고, signal이 Sonnet 호출·Spotify verify·보충까지 관통한다. 저장 직전의
save gate가 abort된 큐레이션의 DB 기록을 차단한다(응답으로는 에러를 봤는데 히스토리에
고아 큐레이션이 생기는 것 방지). `lib/curator.ts → runCuration`.

## 1. Intent classify (`lib/intent.ts`)

**입력**: `string` (사용자 자연어) · **출력**: `Intent` · **모델**: `claude-haiku-4-5` (tool use)

의도는 2종뿐: `kinship_curate`(seed는 항상 `track_text`, + optional
`depth: 'mainstream'|'balanced'|'deep'` — 사용자가 **명시적으로** 깊이를 조향한
경우만, 추측 금지) | `small_talk`. 과거의 `library_filter`/`list_top`/auto seed는
로그인 제거와 함께 폐지. `size` 필드도 제거됨(downstream에서 읽은 적 없는 죽은
필드였다 — 곡 수는 kinship 스키마 floor + 검증 attrition이 결정).

**실패 모드**: tool 미호출/스키마 미스/예외/8초 로컬 타임아웃 → 전부 `small_talk` 폴백
(UI가 곡명을 알려달라고 안내). 재시도 없음.

## 2. Seed resolve (`lib/curator.ts → resolveSeed`)

**입력**:
```ts
type CurationSeedInput =
  | { type: 'track_text'; track_query: string
      artist_hint?: string; track_hint?: string } // 채팅 경로 (힌트는 경계 확실할 때만)
  | { type: 'track_id'; track_id: string }        // 디깅 체인 경로
```
**출력**: `ResolvedSeed` (trackId, artist, album, year, popularity, url들)

| seed type | 동작 |
|-----------|------|
| `track_text` | intent가 아티스트/제목 경계를 확신해 `artist_hint`/`track_hint`를 **둘 다** 준 경우 `track:"T" artist:"A"` 필드필터 검색을 1차 tier로(미스 시 free-text 폴백 — 오파싱 최악은 낭비 콜 1회). 이후 Spotify Search(limit 10) 후 `pickSeedCandidate`: ① 카라오케/트리뷰트/"made famous by"류 노이즈 후보 제외 ② 정규화 제목이 쿼리에 그대로 들어있는 후보 우선 ③ 그 안에서 **아티스트 근거가 쿼리에 있는 후보 우선**(아티스트 구문 포함, 또는 3자+ 토큰 2개 이상 전부 포함 — "tame impala elephant"가 더 유명한 타 아티스트의 "Elephant"로 새지 않게), popularity는 그 안의 타이브레이커 ④ 없으면 Spotify 랭킹 1위. 결과 없으면 `seed_not_found`. |
| `track_id` | `GET /v1/tracks/{id}` 재조회 (popularity 최신화). |

시드 트랙은 fetch 시 artists/tracks에 upsert. audio_features는 정책 변경으로 채우지 않는다.

## 3. Seed context + chain context (병렬, `lib/curator.ts`)

**출력**: `SeedContext` (`lib/kinship.ts` 타입이 원본)

- `spotifyGenres`: 아티스트 단위.
- `lastfmTrackTags` / `lastfmArtistTags`: **가중치 포함 표기** `"shoegaze(100)"` —
  Last.fm count는 상대 가중치(top=100)라 Sonnet이 지배 신호와 꼬리 노이즈를 구분할 수 있다.
  실패/타임아웃 시 빈 배열로 진행.
- `audio`/`tonal`: 항상 `{}` (Spotify가 audio_features를 신규 앱에 비공개 전환).
  타입만 보존 — 정책 재오픈 시 복원 용이.
- `listenerProfile`: `librarySophistication`의 기본은 `'mixed'`(라이브러리 부재
  폴백)이나, **사용자가 명시 조향하면**(intent `depth`) mainstream/obscure로
  채워진다 — 명시 입력 신호라 정직한 폴백 원칙과 무충돌(CLAUDE.md 규약 10).
  `seedPopularity`만 시드 트랙에서 실측.
- `userNote?`: 사용자 채팅 원문(trim, ~200자 캡)이 조향 힌트로 프롬프트에
  들어간다 — "이 힌트가 시드·카테고리 구조·검증 규칙과 충돌하면 무시"가 명시된
  최하 우선순위 참고. 디깅은 query가 null이라 자연 생략, **캘리브레이션 실행
  (`[calibration]` 접두 쿼리)은 userNote 자체를 생략**(러너의 인공 문자열이
  조향 힌트로 오염되지 않게).
- `chainAxisHint?` (디깅 체인일 때만): 최근(≤3) 조상에서 2회 이상 쓰인
  link_dimensions 상위 3개("vocal_style(5), mood(3)") — "다른 축 우선, 단 현재
  시드의 최강 축이면 허용" 권고 1줄. 수락된 픽 기준(verify 탈락분 미포함).
- `chainAvoidArtists?` (디깅 체인일 때만): `collectChainContext`가 조상 큐레이션의
  추천/시드 아티스트 **ID**(사후 하드 드랍용)와 **이름**(프롬프트 사전 회피용)을 함께
  수집한다. 이름은 user message의 "추천 제외 아티스트" 섹션으로 들어가 Sonnet이
  애초에 슬롯을 낭비하지 않게 한다. 루트 시드 아티스트는 제외(체인 전체에서 계속
  등장 가능해야 함).
- `chainNarrative?` (디깅 체인일 때만): **직전 최대 2개** 조상의 "『시드명』 →
  lineage_notes 첫 문장(≤120자)". user message의 "디깅 체인 여정" 섹션으로 들어가
  연속 디깅에서 정조·방향이 그대로 반복되지 않게 하는 **참고 힌트** — 프롬프트가
  "현재 시드가 우선"을 명시한다. 항상 가장 가까운 조상 기준이라 체인이 3스텝
  이상이면 루트는 자연히 밀려난다(1-hop 체인에서는 부모=루트의 내러티브가 곧 직전
  스텝 — 의도된 동작). null/빈 lineage_notes는 스킵. system 프롬프트는 무변경이라
  ephemeral 캐시 프리픽스 유지, user message만 +100~200토큰.

## 4. Kinship LLM (`lib/kinship.ts`)

**입력**: `SeedContext` · **출력**: `KinshipResponse` (zod) · **모델**: `claude-sonnet-4-6`
(tool use 강제, temperature 0.6, max_tokens 2400(1차 — overshoot 실험; 보충은 1600), 55s 로컬 타임아웃 + SDK signal +
수동 race 백스톱)

- **시스템 프롬프트는 `cache_control: ephemeral`로 캐시**(~4.5k 토큰 정적, TTL 5분).
  스키마 재시도·보충 콜·연속 디깅이 캐시를 히트한다. tools 블록도 캐시 프리픽스에 포함.
- zod floor: **influence≥2, peer≥2, descendant≥1, kinship≥2** (총 7곡 최소,
  프롬프트상 12곡 최대). floor 이력: 3/3/2/3 → 2/2/2/3 → 2/2/1/2 (wall-clock 때문).
- `stop_reason === 'max_tokens'`면 명시적 에러("절단됨 — 곡 수를 줄여라")로 던진다.
  절단이 스키마 미스로 위장돼 원인 불명 재시도를 태우는 것 방지.
- 스키마 미스 시 재시도 1회(검증 메시지를 피드백으로) — 단 하드캡까지
  `RETRY_MIN_HEADROOM_MS`(55s+8s) 이상 남았을 때만, 그리고 abort 안 됐을 때만.

프롬프트 본문/설계 근거는 [kinship-prompt.md](kinship-prompt.md).

## 5. Spotify verify (`lib/spotify/catalog.ts → verifyTrack`)

**입력 (per track)**: `{ artist, track, album, year }` · **출력**: `VerifyResult`

```ts
type VerifyResult =
  | { ok: true; track: VerifiedTrack }
  | { ok: false
      reason: 'not_found' | 'title_mismatch' | 'album_mismatch' | 'year_mismatch'
      // nearest는 전 사유에서 canonical artist/track/album/year 포함(R8부터 —
      // 깊은 실패에서도 크레딧 표기를 사후 검증·보충 피드백에 쓰기 위해).
      // not_found일 땐 같은 제목의 다른-크레딧 최고 후보가 수리 힌트
      // ("아이유"↔"IU" 표기차 복구용).
      // 힌트 후보는 카라오케/트리뷰트 노이즈 제외, 주장 album 구문일치 우선,
      // popularity 타이브레이크. 재제출도 동일 artist-exact 게이트를 재통과
      // 해야 하므로 검증 완화가 아니다.
      nearest?: { artist?: string; track?: string; album: string; year: number | null } }
```

**표기 정규화** (매치 전, 양측 대칭): `&`↔"and" 표기차("Simon & Garfunkel"↔
"Simon and Garfunkel")는 **변형쌍 병행 비교**로 흡수한다 — 기준 정규화 자체를
바꾸면 &-생략 표기("Earth Wind Fire"↔"Earth, Wind & Fire", 기존 매치)가
회귀하므로, base쌍 OR and-치환쌍이 일치하면 매치(구 동작의 엄격한 상위집합.
+/×/x는 AC/DC류 위양성 때문에 보류). artist/title/album 게이트와 시드 픽에
적용. 주장 artist는 표기 변형 셋으로 매치를 시도한다 — ① 원형 ②
`feat./featuring` 꼬리 제거형("with"는 실제 크레딧과, 단독 "ft."는 지명
"Ft. Worth"류와 충돌해 제외) ③ **병기 스플릿**("조이 (Joy)" → "조이"/"Joy",
3차 배치의 K-표기 병기가 크레딧 "JOY"와 불일치하던 실측 구제; feat 계열
괄호는 제외) ④ **공백 접합 변형**("Lim Chang-jung" ↔ 크레딧 "Lim Changjung",
4차 배치 실측 — 로마자 하이픈/띄어쓰기 분절 차 흡수, 문자 시퀀스 전체 동일
요구라 정확 일치 유지, 아티스트 게이트만. 가드: 1자 토큰이 있으면 접합 안 함
— "will.i.am"→"william" 붕괴로 별개 William 크레딧과 충돌하는 클래스 차단).
주장 측만 변형 셋을 만들고, 후보 크레딧은 추가 변형 없이 **같은
normalize/접합 키로 비교만** 한다 — 어느 변형이든 크레딧과 **정확 일치**해야
하므로 검증 완화가 아니다.

**매치 규칙** (게이트 순서: artist → title → album → year):
- artist 정확 일치 (normalize 후) — **후보의 크레딧 전체 중** 정확 일치하는 크레딧을
  찾는다(첫 크레딧만이 아니라). 콜라보 곡에서 LLM이 의도한 아티스트가 2번째 크레딧일
  때의 false drop을 막고, 이후 다양성 캡·표시 아티스트는 **매치된 크레딧** 기준.
  체인 제외만은 **모든 크레딧**을 검사(콜라보가 다른 크레딧 명의로 체인 제외를
  우회하지 못하게). ※ 알려진 비대칭(수용됨): `tracks.artist_id`는 canonical하게 첫
  크레딧을 저장하므로, 2번째 크레딧 매치 픽은 즉시 응답(매치 크레딧)과 저장 후 상세
  페이지(첫 크레딧)의 아티스트 표기가 다를 수 있고, 과거 큐레이션의 그 픽은 체인
  셋에 첫 크레딧으로 들어간다.
- **곡 제목 일치**: 양쪽에서 **동일 녹음 표기의 꼬리 부제만** 제거("- Remastered
  2009"/"(Mono Version)"/"[2011 Remaster]"/"- Bowie Mix" — EQUIV 어휘에 걸리는
  꼬리만. bare "mix"는 2차 배치 실측으로 복원(Raw Power 정규판 트랙명이
  "- Bowie Mix"라 제목 게이트에서 죽어 year_mismatch로 위장됐음) — 단
  Remix/Club/Extended/Dub/Dance/12인치 꼬리는 VARIANT 가드로 계속 보존
  (다른-편집이 원곡으로 접히지 않게). "(Don't Fear) The Reaper"의 선행 괄호는 보존)하고
  normalize한 뒤 **정확 일치**.
  live/demo/acoustic/remix 같은 **다른 녹음(VARIANT) 표기는 절대 벗기지 않는다** —
  "Creep - Live"는 "creep live"로 남아 "Creep"과 불일치하므로, 디럭스판의 라이브
  보너스가 스튜디오 원곡으로 오검증되지 않는다. 느슨한 contains는 금지 — 같은
  앨범의 "Run"↔"Run Away"가 서로 통과해버린다. 이 게이트가 없으면 tier-2 비필터
  검색에서 할루시네이션 제목이 같은 앨범·연도의 **다른 실곡**으로 오검증될 수 있다.
- album 부분 일치 (양방향, **토큰 경계** phrase contains) — "war" ⊄ "warchild",
  "ok computer" ⊂ "ok computer oknotok"는 유지
- 발매연도 ±2, 단 **리이슈 연도 유예**: 앞 게이트를 전부 통과한 후보의 앨범명이
  `/remaster|deluxe|anniversary|reissue|expanded|legacy/i`이고 후보 연도가 주장
  연도보다 나중이면 통과 (컴필 방어: `/best|greatest|hits|singles|collection|anthology|soundtrack|live/i`
  앨범은 유예 불가). 유예된 매치의 **표시 연도는 LLM이 주장한 오리지널 연도**
  (2009 리마스터로 잡힌 1973년 곡이 "2009"로 표기되지 않게).

**보수적 canonicalize (전 tier 실패 후 최후 단계)**: artist+제목 정확 일치까지
갔는데 album/year 표기만 틀린 후보를 canonical 표기로 자동 수락 —
- album 구제: 후보 연도 ±2 이내 + 앨범이 라이브/방송/트리뷰트 계열
  (`/live|concert|unplugged|sessions?|radio|bbc|mtv|karaoke|tribute|made famous/i`)
  아님 + **비컴필 후보만** + 풀 내 재생시간이 한 클러스터(±10s — 동명이곡 방어)
  일 때 최조기 후보. 수락 표기는 후보의 canonical album/year.
- year 구제: album은 이미 부분일치 + 후보 연도가 주장보다 **이른 경우만**
  (재녹음은 항상 나중이라 이 방향은 구조적으로 안전) + Δ≤6.
- 계측: `pipeline_stats.verify.canonicalized{album,year}` (verified에 포함,
  리포트가 raw 통과율과 분리 표기). 잔여 위양성(같은 아티스트의 근접 연도
  동명이곡)은 duration 가드가 1차 방어 — 실측으로 재조정.
- 정규식 정정: `re-recorded`·`Taylor's Version`은 **다른 녹음**(VARIANT) —
  초기의 EQUIV 배치 오류를 정정해 연도 게이트 하나에 기대던 방어를 제목
  게이트로 이중화.

normalize는 [glossary.md](glossary.md).

**계층 검색 (후보 조회만 완화, 규칙은 그대로, 각 limit 25)**:
1. `track:"X" artist:"Y"` 필드 필터 쿼리 (따옴표는 새니타이즈 — 필드 문법 400 방지)
2. 1차가 `not_found`(그 아티스트 후보 없음) **또는** `title_mismatch`(필드 필터의
   퍼지 제목 매칭이 정규판을 놓침)일 때만 비필터 쿼리 `"X Y"`로 한 번 더.
   album/year 단계까지 갔으면 2차는 같은 결과라 건너뛴다.
3. **rescue tier**: 최종 실패가 `album_mismatch`면(컴필레이션이 검색 상위 점령 패턴)
   `track+artist+album` 3중 필드 필터 1콜로 정규 앨범판을 구제 시도.

탈락 시 `reason`과 최근접 후보의 정규 **artist/title/album/year**를 돌려준다(artist는
전 사유에 저장 — 2차 배치의 "크레딧 변형 위장" 가설류를 사후 검증하고, 보충 피드백이
주장과 다른 크레딧을 표기할 수 있게) → 보충 프롬프트 피드백 재료. **인프라 실패
(429/5xx/타임아웃)는 null이 아니라 throw** — 호출자가 "곡이 없다"와 구분해서 다룬다.

## 6. Verify 배치 + dedupe/다양성 (`lib/curator.ts → verifyBatch`)

- **동시성 4**로 제한한 풀에서 검증(과거 `Promise.all` 일괄 발사가 429 버스트 유발).
- **인프라 실패는 2초 백오프 후 그 트랙만 1회 재검증**, 그래도 실패면
  `droppedByInfra`로 별도 집계. 절대 "LLM 할루시네이션 드랍"과 섞지 않는다.
- dedupe 드랍: 시드 자신, 이번 큐레이션에서 이미 수락된 곡, LLM 중복 제안,
  (디깅 체인이면) 체인 상위 아티스트. **라이브러리 중복 제외는 폐지** (라이브러리 없음).
- 다양성 캡: 카테고리 내 같은 아티스트 1곡, 큐레이션 전체 2곡.
- 상태(`FilterState`)는 1차/보충 패스가 공유 — 보충이 1차 수락분과 중복될 수 없다.

## 7. 보충 (verify-gap supplement, `lib/curator.ts → verifyAndFilter` + `lib/kinship.ts → supplementKinship`)

verify 후 카테고리가 floor **미만**이면(비어있을 때만이 아니라) Sonnet 보충 1회:

- 트리거 대상: influence(→2), descendant(→1), kinship(→2). **peer는 단독
  트리거에서만 제외** (peer만 얇을 땐 왕복 비용이 아깝다는 제품 판단) — 단, 핵심
  카테고리가 이미 보충을 발동시키면 **peer 결핍(→2)도 같은 콜에 piggyback**한다
  (왕복 추가 0; 이걸 위해 보충 max_tokens 1200→1600). peer가 그래도 0이면 UI는
  그 카테고리를 렌더하지 않는다.
- 하드캡까지 38s(`SUPPLEMENT_MIN_HEADROOM_MS`) 미만 남았으면 건너뛰고 1차 결과로 출하.
- **과잉 요청**: 보충분도 verify에서 깎이므로 실제 요청량은 결핍+1(카테고리당
  상한 3). floor/게이트 판단은 원 결핍 기준이고, stats에는 `deficits`(원 결핍)와
  `requested`(요청량)를 **분리 저장** — 안 나누면 결핍 규모 분석이 부푼다.
- **outcome 계측**: 보충 콜의 결말을 `supplement.outcome`
  (ok/filtered_empty/schema_miss/timeout/failed) + `rawReturned`로 영속 —
  2차 배치 #43(29.8s 소모 후 빈 반환)의 원인이 구분 불가했던 공백을 메움.
  timeout 분류는 메시지 휴리스틱(abort/exceeded).
- 보충 프롬프트에는 ① 부족 카테고리와 수량 ② 1차 제안 전체(반복 금지)
  ③ **1차 탈락 곡 + 사유 + Spotify 최근접 title/album/year** — artist/track/
  album/year 표기만 고쳐 다시 내는 것을 명시적으로 허용(같은 실수 반복 방지).
  인프라 실패분은 LLM 잘못이 아니므로 피드백에 넣지 않는다. ④ (LEAP_PHASE_B=1)
  **weak_leap 판정 픽 목록** — "동시대·동장르에 머물지 말고 강을 건너는 픽으로"
  피드백 (§7.5).
- best-effort: 타임아웃(30s)/스키마 미스/abort 시 빈 결과로 1차분만 출하. 절대 throw 안 함.
- 반환 트랙은 같은 `FilterState`로 재검증·재필터.

## 7.5. Kinship-leap 감사 (Phase A: log-only, `lib/leap.ts`)

kinship 픽이 실제로 "시대나 장르의 강을 건넜는지"를 메타데이터로 감사한다.
**판정 규칙 (4값)**: 시대 근접(|Δyear| < 10) AND 장르 근접(시드 어휘와 후보 어휘의
비-generic 구문 중첩 ≥1)이면 —
- 그 픽의 `link_dimensions`가 비어있지 않고 **전부 ⊆ {groove, texture}** →
  `exception_nonobvious` (프롬프트가 공인한 비자명 축 예외형)
- 아니면(자명 축이 하나라도 섞임) → `weak_leap`

둘 다 아니면 `leap_ok`, 연도/장르 정보가 비면 `unknown`(판정 안 함). dims는 LLM
자기신고라 gaming 가능성이 있어 verdicts에 dims 원본 + `hasObviousAxis`를 같이
저장해 분포로 검증한다. structure는 예외 축에서 **보류**(외부 증거형 quiet/loud
케이스가 있으나, 열면 동시대 약도약도 빠져나감 — Phase A 데이터로 판단).

데이터: 시드 어휘는 기확보(spotifyGenres ∪ Last.fm 태그), 후보는 아티스트 배치
1콜(`getArtistsBatch`) + 픽별 Last.fm 태그(6h 캐시). 전체를 5s race + 8s 헤드룸
게이트로 감싸고, 실패는 삼킨다(감사 때문에 큐레이션이 죽지 않는다).

**Phase A에서는 로그(`[leap] …`)와 `pipeline_stats.leap` 저장만 하고 카테고리를
바꾸지 않는다.** 결과는 `{ status: 'ok'|'timeout'|'failed'|'skipped', verdicts }`로
영속화 — 타임아웃/스킵도 기록해 증거가 조용히 사라지지 않는다. 캘리브레이션 카나리아:
- `weak_leap`으로 잡혀야 함: NewJeans "Attention" ↔ 동시대 R&B (Jorja Smith 류,
  dims에 mood/vocal_style 예상)
- `exception_nonobvious`로 분리돼야 함: The Doors "L.A. Woman" ↔ ZZ Top
  "La Grange" (Δ2y·동장르권이지만 dims=[groove, texture] — 4값 도입으로 기존
  "규칙이 예외형을 오탐" 모순 해소)
- **1차 배치(n=8) 실측 주의**: 두 카나리아 모두 "미끼 미출현" — NewJeans는
  Sonnet이 Sade Δ30y·Portishead Δ28y로 제대로 도약했고(weak 미끼 없음, 프롬프트
  강화 효과), La Grange류는 **kinship이 아니라 peer 칸으로 배치**됐다(프롬프트의
  예외형 주석이 그렇게 조향). 감사는 kinship만 보므로 **exception_nonobvious
  경로는 예외형 픽이 실제로 kinship에 들어올 때만 검증 가능** — 이 경로는
  "미검증"으로 남아 있고, weak_leap 판정(1차 배치 6/17, 전부 규칙상 정당)이
  현재 유일하게 검증된 경로다.

축적된 `pipeline_stats.leap` 분포로 오탐률을 본 뒤에만 Phase B를 활성한다 —
**B0(구현됨, `LEAP_PHASE_B` flag off)는 floor 제외+보충**(아래 참조)이고, peer
재분류는 B1 후보로 보류.

**집계 리포트**: `pnpm tsx scripts/report-pipeline-stats.ts [--since=YYYY-MM-DD]
[--calibration-only|--exclude-calibration]` — v:1 행만 정식 집계(미래 v/파손 행은
카운트만), 루트 vs 체인 분리, 모든 수치에 n 병기, **총소요 p50/p95 + verify 내부
분해(verifyFirst/supplementSonnet/supplementVerify) + 탈락 표본(failSamples,
행당 12캡 — 사유 카운트만으론 못 하는 인과 분석용)**, Phase B 게이트(leap-ok
큐레이션 ≥30 또는 판정 ≥100) 판정 출력. read-only. `--since`는 프롬프트 변경의
도입 전/후 비교용, calibration 필터는 능동 수집 표본과 유기 표본의 분리용
(프로덕션 수동 배치는 마커가 없으므로 `--since`로 자른다).

**카테고리 시간축 감사 (log-only)**: 최종 recs에서 influence가 시드보다 뒤(+2 초과)
/ descendant가 앞(-2 미만) / peer |Δ|>10을 카운트해 `[audit]` 로그 +
`pipeline_stats.categoryTemporalAudit`에 저장. 집행 없음 — canonicalize된 연도
기준이라 원발매연도 오차가 남는 **품질 신호**다 (leap Phase A 패턴).

**데이터 게이트 대기 목록 (P3 — 캘리브레이션 결과로 채택 판정)**:
- ~~1차 콜 overshoot(총 9-10곡 명시)~~ → **실험 채택됨 (2026-07-03)**: 1차
  프로덕션 배치(n=8)에서 보충 발동률 87.5%(기준 >15%의 5.8배)로 발동률 조건
  압도. p95 여유 조건은 경계(총 p95 63.8s → 하드캡 잔여 36.2s < 보충 헤드룸
  38s)라 "게이트 통과 선언"이 아니라 **실험 프레임**: 프롬프트 9~10곡 목표 +
  max_tokens 2400 적용 후, 같은 방식의 프로덕션 배치로 전/후 비교(보충
  발동률·added·총 p50/p95). #34류(1차 재시도가 예산 잠식 → headroom 스킵)는
  overshoot가 못 고치는 클래스임을 명시.
- artist containment tier: `canonicalized:'artist'` 계측 동반 없이 채택 금지.
- 시드 컨텍스트 보강(wiki/label): 러너의 wiki 커버리지 실측 후. label은 Spotify
  획득 경로 확인 선행.
- 체인 시대/장르 힌트, B0 보충 kinship 2차 감사: 각 표본 후 판단.
- (최하위) lineage_notes/sonic_link 품질 감사: 평가 rubric·비용 불명 — 기록만.

**캘리브레이션 러너**: `pnpm tsx scripts/calibrate-pipeline.ts --yes [--chain]` —
단일 사용자 앱은 유기 트래픽으로 게이트에 못 가므로, 카논 5 + 카나리아
(NewJeans/L.A. Woman) + 한글 로마자 케이스(아이유) 시드로 실큐레이션을 순차
실행해 표본을 능동 축적. query에 `[calibration]` 마커를 저장하되 프롬프트/
userNote에는 아예 넣지 않는다(인공 문자열 오염 방지).
⚠ 실비용 발생 — `--yes` 없이는 계획만 출력. 부수 실측: wiki 커버리지(#5 채택
판단), canonicalize 발동률.

**Phase B(B0) — `LEAP_PHASE_B=1` (기본 off)**: 감사가 1차 verify 직후로 이동,
`weak_leap` 픽을 **kinship floor 계산에서만 제외**(카테고리 무변경·픽 유지 —
비파괴. peer 재분류는 B1로 보류) → 보충이 "강을 건너는" 픽을 추가. ok verdicts만
집행 근거(timeout/skip이면 제외 없음), 헤드룸 게이트 43s(감사 5s + 보충 38s 직렬).
알려진 트레이드오프: ① 보충 추가 kinship 픽은 미감사
(`pipeline_stats.phaseB.supplementAudited=false`로 기록), ② weak 픽이 kinship
라벨로 계속 노출되는 희석(리포트의 weakExcluded로 관측), ③ 총곡수 캡 없음 —
B0의 추가분은 kinship floor(2)로 유계. **캘리브레이션 리포트로 카나리아
(NewJeans↔동시대 R&B가 weak_leap / L.A. Woman↔La Grange가 exception_nonobvious)
확인 전에는 켜지 말 것.**

## 8. Save gate + DB save (`lib/curator.ts → saveCuration`)

저장 직전 `signal.aborted`면 저장을 건너뛰고 `llm_failed` 반환(고아 큐레이션 방지).
정상 경로는 트랜잭션:

```sql
INSERT INTO curations (user_id, query, seed_track_id, parent_curation_id, lineage_notes, pipeline_stats) RETURNING id;
INSERT INTO curation_tracks (curation_id, track_id, category, sonic_link, link_dimensions, position) VALUES ...;
```

`user_id`는 항상 `LOCAL_USER`. position은 카테고리 내 수락 순서. `pipeline_stats`는
verify 사유별/카테고리별 집계 + 보충 결과 + leap verdicts + 타이밍
(`lib/pipelineStats.ts`의 `PipelineStatsV1`, [data-model.md](data-model.md) 참조) —
API 응답에는 나가지 않는 DB 전용 관측 데이터.

## 9. Client response

`CurateOk` (lib/curator.ts가 원본, [api-contracts.md](api-contracts.md) 참조):
categories 4종 + `lineage_notes` + stats.

```ts
stats: {
  proposedByLLM: number        // 1차+보충 제안 총수
  verifiedOnSpotify: number    // 매치 규칙 통과 수
  droppedAsDuplicate: number   // 시드/중복/체인 드랍
  droppedByDiversity: number   // 아티스트 다양성 캡 드랍
  droppedByInfra: number       // Spotify 인프라 실패(재시도 후에도) — 미스매치와 별도
}
```

## 10. 분기: Dig deeper

추천 카드의 디깅 버튼 → `POST /api/curate { seed: { type: 'track_id', ... }, parent_curation_id }`
→ 파이프라인 처음부터. 체인 컨텍스트(3절)가 상위 아티스트를 프롬프트+필터 양쪽에서
제외한다. **플레이리스트 저장은 로그인 제거와 함께 폐지** ([auth-flow.md](auth-flow.md)).

## 지연 예상 (실측 기준)

건강한 큐레이션 25-40s. 지배 항은 Sonnet 1차(55s 캡)이고, verify는 동시성 4 기준
~10곡에 2-6s, 보충 발동 시 +30s 캡. `[curate] TOTAL` 로그가 단계별 breakdown을 찍는다
(seed/ctx/sonnet/verify/save).

## 실패 시 사용자 메시지

각 코드는 `lib/messages.ts`의 `pipeline.*` 엔트리로 매핑된다 (구조: `title` + `body` +
선택적 `actionHref`/`actionLabel`/`altBody`). UI는 헤더·본문·액션이 있는 카드로 렌더.

| 코드 | 카드 헤더 | 비고 |
|------|-----------|------|
| `seed_not_found` | "그 곡을 못 찾았어요" | 다시 입력 안내 |
| `llm_failed` | "추천을 만들지 못했어요" | 타임아웃/절단/하드캡 포함 |
| `all_dropped` | "확인된 추천이 없어요" | verify+필터 전멸 |
| `unknown` | "알 수 없는 오류" | |

(`sync_required`는 auto seed 폐지와 함께 제거됨.) 매핑은 `pipelineErrorFor(code)` 헬퍼로
단방향. 새 코드 추가 시 `lib/messages.ts` + 매핑 + 이 표를 동시에 갱신한다.
