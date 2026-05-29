# Digging Chain — 디깅 체인 명세

추천 트랙을 다시 시드로 삼아 음악 굴을 따라가는 핵심 인터랙션. AccuRadio의 "한 채널을 끝없이 듣는다" 감각을 우리 식으로 푼다.

## 결정

- **체인은 트리(다중 자식 가능), 한 노드의 부모는 하나.** `curations.parent_curation_id`로 표현.
- **한 단계가 아니라 전체 체인을 표시.** 브레드크럼은 루트→…→부모→현재. 길이 길어지면 중간 일부 생략(`Root → … → 2단계전 → 부모 → 현재`).
- **체인 내 본 아티스트는 다음 추천의 dedupe 풀에 자동 포함.** 같은 아티스트가 디깅 따라가다 또 나오면 의미 없는 발견. 사용자가 "아티스트 밴" 명시할 필요 없이 자동.
  - 단, **체인 루트의 시드 아티스트는 제외 안 함.** 시드 아티스트의 다른 곡이 합당한 추천일 수 있고 우리는 트랙 단위 추천이므로.
  - 정확히는: 체인의 모든 추천 트랙의 artistId 집합 + 모든 시드 artistId(루트 시드는 제외) → 다음 추천 verify+filter 단계에서 이 artistId 매치 시 드랍.
- **체인 깊이 제한 없음.** 사용자 의지대로. 단 매 노드는 새 LLM/Spotify 호출 비용 들어가니 사용자가 자기 페이스로 결정.
- **DigDeeperButton 로딩 강화.** 친족 큐레이션이 10-15초 걸림. 사용자가 같은 버튼을 두 번 누르거나 다른 카드 버튼을 동시에 누르면 안 되게 페이지 단위 락.

## 자료구조

### DB 변경 없음

`curations.parent_curation_id`는 이미 있음.

### 새 헬퍼 (`lib/curator.ts`)

```ts
async function collectChainContext(args: {
  userId: string
  parentCurationId: number
}): Promise<{
  chainArtistIds: Set<string>       // 체인의 모든 노드에서 등장한 artistId
  rootSeedArtistId: string | null   // 루트 시드의 artistId (얘만 제외 대상에서 빠짐)
  ancestry: { curationId: number; seedTrackId: string }[]
                                    // 루트→…→직전 부모 순서
}>
```

알고리즘 (반복형 traversal):

```
let curId = parentCurationId
let chain: Curation[] = []
while curId:
  load curation row (id, parent_curation_id, seed_track_id, user_id)
  if curation.user_id !== userId → abort (보안 가드)
  chain.unshift(curation)
  curId = curation.parent_curation_id
// chain[0] = root, chain[-1] = parent

// Collect all artistIds from chain's recommendation tracks
const allArtistIds = await loadArtistIdsByCurationIds(chain.map(c => c.id))

// Collect all seed artistIds in chain (Spotify Get Track 캐시된 DB tracks.artistId)
const seedArtistIds = await loadArtistIdsByTrackIds(chain.map(c => c.seedTrackId))

// rootSeedArtistId = chain[0].seed의 artistId
// chainArtistIds = (allArtistIds ∪ seedArtistIds) - {rootSeedArtistId}
```

루프는 안전을 위해 최대 50 hop (악의적 순환 데이터 방지). 정상 사용 시 도달 불가.

## curator 통합

`runCuration`이 `parentCurationId`가 있을 때:

1. 위 `collectChainContext` 호출 → `chainArtistIds`
2. `verifyAndFilter`에 추가 인자로 전달
3. dedupe 단계에서 `library.has(trackId)` 외에 `chainArtistIds.has(artistId)`도 드랍 조건에 포함

기존 dedupe 카운터는 그대로 (`droppedAsDuplicate`). 굳이 별도 카운터 안 만듦 — 사용자에 노출되는 가치 없음.

## 브레드크럼 (페이지)

`/curations/[id]/page.tsx`:

```ts
async function loadAncestry(curationId: number, userId: string):
  Promise<{ curationId: number; seedLabel: string }[]>
```

루트→…→부모 배열 반환. 현재 노드는 포함 안 함. 본인 소유 큐레이션만 traversal (다른 사용자 노드 만나면 abort).

UI:
- 길이 1: `← 이전: Artist — Track`
- 길이 2-4: `← Root → Mid → Parent` (각각 링크)
- 길이 5+: `← Root → … → 2단계전 → Parent` (중간 생략 표시, 루트와 끝 3개만)

각 칸 클릭 시 해당 큐레이션 페이지로 이동. 끝없는 디깅 트레일을 한눈에.

## DigDeeperButton 강화

- 페이지 컨텍스트에 `isDigging` boolean 공유.
- 한 페이지에서 어느 카드든 디깅 시작 시 모든 다른 카드 버튼 disable.
- 진행 표시는 작은 spinner + "🔍 …" (메시지 그대로 유지).
- 실패 시 inline 에러 표시 후 다시 활성화.

상태 공유 방식: 가장 단순한 React Context. 페이지가 서버 컴포넌트라 Context Provider는 클라이언트 컴포넌트로 래핑.

### 컴포넌트 분리

```
components/
├─ TrackCard.tsx              # 서버 OK (DigDeeperButton만 클라이언트)
├─ DigDeeperButton.tsx        # 클라이언트
├─ DiggingProvider.tsx        # 클라이언트 Context (isDigging + setIsDigging)
```

페이지에서 추천 영역을 `<DiggingProvider>` 안에 감쌈.

## 본 곡 vs 본 아티스트

이번 결정은 **아티스트 단위 dedupe**. 트랙 단위가 아닌 이유:

- 한 아티스트의 곡이 디깅 체인에서 연속으로 나오면 발견의 다양성이 줄어듦
- 같은 곡이 다시 나올 가능성은 verifyTrack의 결정성으로 이미 낮음 (LLM이 같은 시드면 비슷한 답)
- 사용자 라이브러리에 있는 곡은 별도로 처리(`liked/top/plays`), 그건 트랙 단위.

## 한계 / 향후

- 트리 시각화 (디깅 체인을 그래프로 보기) — v2
- "아티스트 밴" 명시적 토글 — 자동 dedupe로 충분하면 생략, 부족하면 도입
- 체인 분기 시 "이 브랜치 닫기" UX — 디깅을 다시 시작하려면 새 시드 입력으로 가는 게 자연스럽다 판단, MVP에서 별도 액션 없음
