# Data Model — 테이블 + Invariants

권위 있는 정의는 [`db/schema.ts`](../db/schema.ts). 이 문서는 **불변 조건(invariant)과 의도**를 적는다. 스키마 변경 시 이 문서도 함께 수정.

## 카탈로그 (사용자 무관)

### `artists`
| 컬럼 | 비고 |
|-----|------|
| `id` PK | Spotify artist id |
| `name` | |
| `spotify_genres` text[] | Spotify Get Artist의 genres 배열 (아티스트 단위) |
| `fetched_at` | 마지막 조회 시각. 캐시 키 |

**Invariants:**
- 모든 `tracks.artist_id`는 이 테이블에 존재.
- `fetched_at`이 24시간 이내면 재조회 안 함 (Spotify 호출 절약).

### `tracks`
| 컬럼 | 비고 |
|-----|------|
| `id` PK | Spotify track id |
| `name` | |
| `artist_id` FK→artists | |
| `album` | 검증용. NULL 허용 (legacy 데이터) |
| `album_release_date` | YYYY-MM-DD. **친족 추천 검증에서 ±2년 매치에 사용** |
| `duration_ms` | |
| `spotify_url`, `preview_url` | UI 표시용 |

**Invariants:**
- 트랙 INSERT 전에 그 artist가 `artists`에 있어야 함. 없으면 먼저 fetch + upsert.
- `album_release_date`는 Spotify 응답에서 가능한 한 정확히 채움 (`year` 정밀도여도 YYYY-01-01로).

### `audio_features`
| 컬럼 | 비고 |
|-----|------|
| `track_id` PK FK→tracks | |
| energy/valence/tempo/acousticness/danceability/instrumentalness/speechiness/liveness | 0~1 실수 또는 BPM(tempo). 모두 nullable |
| **`key` int** | 0~11 (0=C, 1=C♯/D♭, …). `-1`이면 미감지. nullable |
| **`mode` int** | 1=major, 0=minor. nullable |
| **`time_signature` int** | 3·4·5·6·7. nullable |
| `fetched_at` | |

**Invariants:**
- **현재 비활성.** Spotify가 `/v1/audio-features`를 신규 앱에 비공개로 전환(2024-11-27 이후 신규 앱 403). 우리 앱은 정책 발효 후 생성됐으므로 이 단계가 sync에서 제거됐고, 테이블은 빈 상태로 유지된다. 정책이 다시 열리면 lib/spotify/sync/audio.ts를 살려서 sync에 다시 끼우면 된다.
- (정책 활성 시 동작) 트랙 100개씩 batch로 `/v1/audio-features?ids=...` 호출, energy/valence/key/mode/tempo 등을 시드 컨텍스트의 토널 단서로 LLM에 전달. 친족 추천 verify 단계에서 약한 가드(시드와 energy/valence 차이 ≥0.8이면 드랍)로만 사용.

## 사용자별 컬렉션

### `users`
| 컬럼 |
|-----|
| `id` PK (Spotify user id) |
| `display_name` |
| `created_at` |

### `liked_tracks`
| 컬럼 |
|-----|
| `user_id` FK |
| `track_id` FK |
| `liked_at` (Spotify의 added_at) |
| PK = (user_id, track_id) |

**Invariants:**
- 동기화 시 페이지네이션으로 전부 가져옴 (수천 곡 가능).
- 친족 추천 결과에서 **이 테이블에 있는 트랙은 제외**.

### `top_tracks`
| 컬럼 |
|-----|
| `user_id` |
| `track_id` |
| `time_range` ∈ {short_term, medium_term, long_term} |
| `rank` |
| `snapshot_at` |
| PK = (user_id, track_id, time_range, snapshot_at) |

**Invariants:**
- 매 동기화마다 `snapshot_at`이 새 값. 즉 **히스토리가 누적된다.** 같은 곡이 여러 스냅샷에 반복 등장 OK.
- "최신 top"은 `time_range × user_id`별로 가장 큰 `snapshot_at`을 선택.
- 친족 추천 시드 `auto_top_recent`는 가장 최신 `short_term` 스냅샷의 `rank=1..5` 중 1곡 무작위.

### `plays`
| 컬럼 |
|-----|
| `id` serial |
| `user_id`, `track_id` |
| `played_at` |
| UNIQUE (user_id, track_id, played_at) |

**Invariants:**
- `/me/player/recently-played`의 50곡 윈도우. 매 동기화마다 신규만 INSERT.
- `auto_dormant_liked` 시드 선정에 사용 (`liked` ∧ ¬`plays(최근 90일)`).

## 모드 1 — 장르 분류

### `genre_signals`
| 컬럼 |
|-----|
| `track_id` PK |
| `scores` jsonb `{"jazz":0.8,"rock":0.1,...}` |
| `raw_tags` jsonb `{"spotify_artist":[...],"lastfm_track":[...],"lastfm_artist":[...]}` |
| `computed_at` |

**Invariants:**
- `scores`는 0.0~1.0. 한 트랙이 여러 장르에 점수 가질 수 있음.
- 0.5 이상이 기본 임계. `library_filter` intent의 `min_score`로 조정 가능.
- 자세한 계산식은 `docs/genre-classification.md` (Step 5 진입 시 작성).

## 모드 2 — 친족 큐레이션

### `curations`
| 컬럼 |
|-----|
| `id` serial PK |
| `user_id` |
| `query` text NULL — 자연어 입력 (디깅 체인은 null 가능) |
| `seed_track_id` FK→tracks |
| `parent_curation_id` FK→curations NULL — 디깅 체인 부모 |
| `lineage_notes` text — Sonnet의 시드 전체 분석 2-3문장 |
| `pipeline_stats` jsonb NULL — 파이프라인 관측 데이터 (아래) |
| `created_at` |

`pipeline_stats`는 `lib/pipelineStats.ts`의 `PipelineStatsV1`(스키마 버전 `v: 1` 포함)이
단일 진실원이다: verify 사유별 탈락(`failuresByReason`)·카테고리별 제안/수락, 보충 콜
attempted/skippedReason/deficits/added, leap 감사 결과(`status` + verdicts — timeout도
기록해 증거가 조용히 사라지지 않게), 단계별 타이밍. **API 응답 계약(CurateOk.stats)과
무관한 DB 전용 관측 데이터**로, leap Phase B 결정과 verify 규칙 캘리브레이션의 근거다.
과거 행은 NULL (마이그레이션 `0003_blue_may_parker.sql`).

**Invariants:**
- 한 큐레이션은 **정확히 한 시드**. 다중 시드는 v2.
- `parent_curation_id`가 NULL이 아니면 그 부모의 추천 결과에서 파생된 디깅 체인.
- 체인 루트로의 traversal은 SQL 재귀 CTE 또는 앱 레벨 반복.
- `pipeline_stats.v`로 shape 분기 — shape 변경 시 v를 올리고 소비 코드가 분기.

### `curation_tracks`
| 컬럼 |
|-----|
| `curation_id` FK |
| `track_id` FK |
| `category` ∈ {influence, peer, descendant, kinship} |
| `sonic_link` text (한국어 1-2문장) |
| `link_dimensions` text[] ⊆ 8 enum (mood/structure/texture/narrative/groove/vocal_style/melody/progression) |
| `position` int — 한 카테고리 내 정렬 |
| PK = (curation_id, track_id) |

**Invariants:**
- 같은 (curation, track)은 한 행만. 한 트랙이 두 카테고리에 동시 등장 금지.
- 한 카테고리당 같은 아티스트 1곡, 한 큐레이션 전체에서 같은 아티스트 최대 2곡 (다양성).
- `link_dimensions` 길이 1~3. 비어있으면 INSERT 거부 (응용 레이어 검증).
- INSERT는 verify 통과한 트랙만.

### `curation_playlists`
| 컬럼 |
|-----|
| `curation_id` PK FK |
| `spotify_playlist_id` |
| `saved_at` |

**Invariants:**
- 한 큐레이션당 최대 한 번 저장. 재저장 요청 시 기존 행 업데이트(REPLACE).

## 인증

### `auth_tokens`
| 컬럼 |
|-----|
| `user_id` PK FK→users |
| `access_token`, `refresh_token` (DB 저장. 추후 암호화 고려) |
| `expires_at` |
| `scope` |

**Invariants:**
- `expires_at` 5분 전부터 갱신 (안전 마진).
- `lib/spotify/client.ts`가 매 호출 전 만료 체크 + 자동 갱신.

## 마이그레이션 정책

- 스키마 변경 시: `pnpm db:generate` → 생성된 `db/migrations/*.sql` 검토 → 커밋.
- 운영 환경 적용: `pnpm db:push` 수동 실행 또는 별도 절차.
- **컬럼 drop / type 변경은 별도 마이그레이션 + 데이터 보존 절차** 필요. 자동 push 금지.

## 외래키 카스케이드

전부 **NO ACTION** (기본). 사용자 삭제 같은 시나리오는 MVP에 없음. 추후 cascade 정책 필요해지면 별도 마이그레이션.
