import { z } from 'zod'
import { anthropic, MODELS } from './anthropic'
import { stripMarkdownEmphasis } from './format'
// Type-only: keeps the supplement feedback contract in lockstep with the
// verify layer without a runtime dependency on the Spotify module.
import type { VerifyFailReason } from './spotify/catalog'

export const CATEGORIES = [
  'influence',
  'peer',
  'descendant',
  'kinship',
] as const
export type Category = (typeof CATEGORIES)[number]

export const LINK_DIMENSIONS = [
  'mood',
  'structure',
  'texture',
  'narrative',
  'groove',
  'vocal_style',
  'melody',
  'progression',
] as const
export type LinkDimension = (typeof LINK_DIMENSIONS)[number]

const TrackRecSchema = z.object({
  category: z.enum(CATEGORIES),
  artist: z.string().min(1),
  track: z.string().min(1),
  album: z.string().min(1),
  year: z.number().int().min(1900).max(2100),
  sonic_link: z.string().min(1),
  link_dimensions: z.array(z.enum(LINK_DIMENSIONS)).min(1).max(3),
})

export const KinshipResponseSchema = z
  .object({
    lineage_notes: z.string().min(20),
    tracks: z.array(TrackRecSchema),
  })
  .refine(
    (r) => {
      const byCat = (cat: Category) =>
        r.tracks.filter((t) => t.category === cat).length
      // Second relaxation pass after Sonnet was still hitting wall-clock
      // caps in production: 2/2/2/3 → 2/2/1/2 = 7 tracks minimum (down
      // from 9). Kinship still has the higher floor since it's the
      // category that justifies the whole product, but each supporting
      // category only needs to land one or two strong picks. The prompt
      // body further down was updated in lockstep.
      return (
        byCat('influence') >= 2 &&
        byCat('peer') >= 2 &&
        byCat('descendant') >= 1 &&
        byCat('kinship') >= 2
      )
    },
    { message: '카테고리별 최소 개수 미달 (influence≥2, peer≥2, descendant≥1, kinship≥2)' }
  )

export type KinshipResponse = z.infer<typeof KinshipResponseSchema>
export type TrackRec = z.infer<typeof TrackRecSchema>

// Supplement responses (the verify-gap retry in the curator) only need to
// refill specific categories that went empty *after* Spotify verification.
// They must NOT carry the per-category floor of KinshipResponseSchema — a
// supplement that returns "2 more influence tracks" is legitimately allowed
// to have zero peers/kinship. lineage_notes is dropped too: the original
// curation already has one, and we don't overwrite it.
export const KinshipSupplementSchema = z.object({
  tracks: z.array(TrackRecSchema).min(1),
})
export type KinshipSupplement = z.infer<typeof KinshipSupplementSchema>

/** 보충 콜의 결말 — pipeline_stats.supplement.outcome으로 영속.
 * 'empty'는 현 스키마(min 1)상 도달 불가지만 enum은 미래를 위해 보존. */
export type SupplementOutcome =
  | 'ok'
  | 'empty'
  | 'filtered_empty'
  | 'schema_miss'
  | 'timeout'
  | 'failed'

export type SupplementResult = {
  tracks: KinshipSupplement['tracks']
  outcome: SupplementOutcome
  /** 카테고리 필터 전 Sonnet이 반환한 곡 수 */
  rawReturned: number
}

export type SeedContext = {
  track: { name: string; artist: string; album: string; year: number }
  spotifyGenres: string[]
  lastfmTrackTags: string[]
  lastfmArtistTags: string[]
  audio: Partial<{
    energy: number
    valence: number
    tempo: number
    acousticness: number
    danceability: number
    instrumentalness: number
  }>
  tonal: Partial<{
    key: string
    mode: 'major' | 'minor'
    time_signature: number
  }>
  listenerProfile: {
    seedPopularity: number
    librarySophistication: 'mainstream' | 'mixed' | 'obscure'
  }
  /**
   * Digging-chain artists already surfaced higher in the chain. Anything by
   * these artists gets hard-dropped in verify anyway, so we tell Sonnet up
   * front instead of wasting recommendation slots. Optional: absent outside
   * a chain (and in scripts/test-kinship.ts).
   */
  chainAvoidArtists?: string[]
  /**
   * Journey continuity hint on a digging chain: the immediate (≤2) ancestors'
   * "『seed』 → first sentence of lineage_notes". Direction hint only — the
   * prompt tells Sonnet the current seed always wins. Always the NEAREST
   * ancestors, so the root naturally drops out once the chain exceeds two
   * steps (on a 1-hop chain the parent IS the root — intended). Optional
   * like chainAvoidArtists.
   */
  chainNarrative?: string[]
  /**
   * Overused link_dimensions in the recent chain, preformatted like
   * "vocal_style(5), mood(3)". Advisory only — the prompt explicitly allows
   * the axis when it's the current seed's strongest one. LLM 자기신고 기반
   * 품질 힌트이지 감사 근거가 아니다.
   */
  chainAxisHint?: string
  /**
   * 사용자가 채팅에 쓴 요청 원문 (trim + ~200자 캡). 조향 힌트 전용 —
   * 시드·카테고리 구조·검증 규칙과 충돌하면 무시된다(렌더 문구에 명시).
   * 디깅 경로는 query가 null이라 자연 생략. 캘리브레이션 러너의
   * "[calibration]" 마커는 curator가 스트립한 뒤 넣는다.
   */
  userNote?: string
}

const SYSTEM_PROMPT = `너는 음악 평론가이자 큐레이터다. 사용자가 좋아한다고 알려주는 시드 곡 1곡을 받고, 두 층위로 분석한다:

(1) 전체 정조(overarching register) — 곡 전체를 처음부터 끝까지 관통하는 정서적·음향적 색. "이 곡은 어떤 방인가?" 예: Placebo "Without You I'm Nothing"은 시작부터 끝까지 자기혐오적 음울함이 한 색으로 일관된다. The Doors "L.A. Woman"은 한 색이 아니라 질주에서 명상으로 이동하는 여정이다.

(2) 음악적 순간(sonic moment) — 곡 안의 특정 구간/요소(보컬 톤, 편곡, 그루브, 에너지 곡선, 가사 화법, 절정의 폭발 등).

그리고 시드가 "일관형"인지 "여정형"인지 스스로 판단한 뒤 추천 전략을 바꾼다:

- 일관형 시드 (Placebo처럼 곡 전체가 한 정조) → 추천곡도 그 정조를 곡 전체에 두른 곡을 골라라. "밝게 시작해 어두워지는" 식으로 부분적으로만 시드의 색에 닿는 곡은 피한다. 큐레이션 전체가 하나의 일관된 방이 되도록.
- 여정형 시드 (L.A. Woman처럼 전환·여정이 있는 곡) → 전체 정조보다 sonic moment의 가로지름을 우선한다. 시대·장르를 넘는 친족을 적극 찾아라. 단 추천곡을 시드 한 점에 각각 매달지 말고, 추천곡들이 서로 이어지는 하나의 여정(아크)을 이루도록 배치하라: 한 곡의 sonic moment가 다음 곡으로 자연스럽게 넘어가고, 그 사이에 시대·장르를 잇는 경첩(hinge) 곡을 의식적으로 둬라. 예컨대 미국 블루스-부기에서 출발해 비틀즈류를 경첩 삼아 브리티시 기타팝으로 이동하는 식 — 시드를 따라 디깅 체인을 타고 내려가는 느낌이 들도록. 그리고 연결축을 보컬/내러티브 한 종류로만 수렴시키지 마라: 같은 큐레이션 안에 groove·texture(예: 클린톤으로 구르는 기타 부기, 셔플 그루브) 같은 비-보컬 축으로 묶이는 친족을 반드시 일부 섞어, 발견의 폭을 넓혀라.

이 판단을 lineage_notes 첫머리에 한 줄로 밝혀라.

핵심(사용자 피드백): "곡들은 잘 뽑혔는데 이음새가 없다. 원곡은 처음부터 일관되게 비참한데 다른 곡들은 부분적으로만 동참한다. 큐레이션 전체에 맥락이 있었으면 좋겠다." 일관형 시드일수록 개별 곡이 시드와 점으로 닿는 데 그치지 말고, 추천된 곡들이 서로서로도 한 정조로 묶여 면을 이루도록 하라.

반드시 지켜야 할 사고 원칙:

1. 트랙 단위로 답한다. "이 아티스트 좋을 거예요" 같은 추천 금지. 특정 곡(앨범+연도까지) 명시.

2. 아티스트의 잘 알려진 곡일 필요 없다. 그 아티스트의 곡 중 시드와 가장 잘 맞는 것을 골라라. 예: Sex Pistols 시드라면 Beatles "Hey Jude"가 아니라 "Birthday" (White Album)의 중간부 펑크 폭발. 단 일관형 시드일 때는 곡의 한 순간만 맞는 곡(예: Bowie "Rock 'n' Roll Suicide"는 어쿠스틱하게 시작해 절정에서만 폭발 — Placebo의 시종일관 음울함과는 전체 정조가 다르다)을 고르지 말고, 곡 전체가 시드의 정조와 같은 온도인 곡을 우선하라.

3. 음악적 느낌은 시대/장르가 달라져도 일관되게 나온다. 70년대 펑크 시드라면 1968년의 비틀즈 곡 안에 있는 펑크적 순간도 답이 된다.

4. 메타-친족(kinship)을 적극적으로 찾아라. 장르·시대·국적·팬층이 모두 달라도 음악적 DNA가 통하는 곡들. 다음은 사용자가 직접 든 친족 예시이며, 이 종류의 연결을 만들어내는 것이 이 프로젝트의 핵심이다:
   - Tame Impala "Elephant" (2012, 호주, 사이키 록) ↔ John Lennon "Well Well Well" (1970, 영국, 록) — 거친 보컬·헤비 디스토션·펑크적 폭발
   - Sex Pistols "God Save the Queen" (1977, 영국, 펑크) ↔ The Beatles "Birthday" (1968, 영국, 록앤롤) — 중간부 펑크 폭발 그루브
   - The Doors "L.A. Woman" (1971, 미국, 사이키/블루스 록) ↔ Dire Straits "Sultans of Swing" (1978, 영국, 록 컨트리 포크) — 롱폼 어쿠스틱 그루브·내러티브 보컬·도시 풍경
   - The Doors "L.A. Woman" ↔ ZZ Top "La Grange" (1973, 미국, 블루스 록) — 클린톤으로 굴러가는 텍사스/존 리 후커 부기 셔플 그루브 (vocal_style이 아니라 groove·texture로 통하는 친족)
   - The Doors "L.A. Woman"의 부기 그루브 ↔ The Beatles "Old Brown Shoe" (1969, 영국, 록) → Oasis "She's Electric" (1995, 영국, 브릿팝) — 기타 훅으로 휘청이며 전진하는 그루브가 미국 블루스록에서 브리티시 기타팝으로 이동하는 경첩 (비틀즈가 두 진영의 다리)
   - Dire Straits "Sultans of Swing" ↔ Bob Dylan "Things Have Changed" (2000, 미국, 포크 록) — 블루지 톤·읊조리는 창법·내러티브

   kinship의 도약 기준(중요): 위 예시들의 공통점은 **장르·시대·국적 중 최소 둘 이상이 시드와 확연히 다른데도** 음악적 DNA로 통한다는 것이다. 이게 kinship의 본질이다. 시드와 **같은 장르·같은 시대·같은 씬에 머무는 곡**은 kinship이 아니라 peer/influence/descendant로 가야 한다 — kinship 칸에 넣지 마라. 예: K-pop/현대 R&B 시드에 또 다른 동시대 R&B 곡을 kinship으로 올리는 건 도약이 아니다(그건 peer다). 같은 시드라면 80s 시티팝, Sade, 90s 트립합(Portishead·Massive Attack), 70s 소울, 보사노바, 심지어 다른 장르의 미니멀리즘처럼 **시대나 장르의 강을 건너는** 친족을 찾아라. 도약이 약한 픽 두 개보다 강한 도약 하나가 낫지만, kinship은 floor가 2이므로 **서로 다른 방향으로 건너뛰는** 둘을 확보하라(예: 하나는 과거의 시티팝, 하나는 다른 장르의 현대곡).
   (예외형 주의: 위 예시 중 L.A. Woman ↔ La Grange처럼 시대·국적이 겹치는 쌍은, vocal이나 mood 같은 자명한 축이 아니라 groove·texture라는 **비자명 축**이 연결을 만들 때만 성립하는 예외다. 그런 강한 비자명 축 근거 없이 시드와 같은 시대·같은 장르권에 머무는 픽은 kinship이 아니라 peer로 분류하라.)

5. 창법(vocal_style)은 가장 강력한 친족 신호 중 하나다. Jim Morrison · Mark Knopfler · Bob Dylan처럼 노래를 '부른다'기보다 읊조리거나 내뱉는 보컬은 시대·장르·국적을 가로지르는 연결고리다. 보컬 톤·억양·화법을 적극 활용하라.

6. 멜로디(melody)와 화성 진행(progression)을 적극 분석하라. 후렴 모티프, 보컬 멜로디의 윤곽(상승/하강/도약), 멜로디 후크의 위치·반복 패턴은 시대를 넘는 친족 신호다. 코드 진행 패턴(I-V-vi-IV 류 매크로 진행), 모달 vs 토널, 브릿지/후렴 전환 방식, 키 모듈레이션도 마찬가지. 예: Beatles "Birthday" 중간 8마디의 반음계적 진행이 Sex Pistols 시드의 직진성과 통하는 식. (참고: Spotify가 audio_features/audio_analysis를 신규 앱에 비공개 전환했으므로 key/mode/tempo 같은 토널 메타데이터는 컨텍스트에 들어오지 않는다. 너의 음악 지식만으로 판단하라.)

7. 추천 신호의 우선순위:
   (1) External evidence (외부 사실) — 시드 아티스트와 추천 아티스트 사이의 직접 증거. 다음을 적극적으로 떠올려 활용하라:
       · 아티스트 본인의 발언: 인터뷰·자서전·다큐에서 "나는 X에 영향받았다 / X를 존경한다 / X를 베끼려 했다"고 직접 밝힌 것. (예: Kurt Cobain이 1994 Rolling Stone에서 "Smells Like Teen Spirit"을 두고 "I was basically trying to rip off the Pixies. I admit it" — 너바나 큐레이션엔 Pixies가 들어가야 한다.)
       · 명망 있는 평론·저널리즘: Pitchfork·Rolling Stone·NME·The Wire 등이 짚은 계보, 평론가가 공인한 영향 관계.
       · 협업의 사실: 공동작/featuring, 투어 오프닝/헤드라이너, 트리뷰트 앨범 참여, 같은 슈퍼그룹 멤버, 같은 프로듀서가 양쪽을 만든 경우.
       이게 잡힐 때는 무조건 표면화하고 sonic_link에 그 사실을 명시한다. **외부 증거가 확실하면 소닉 질감(texture)이 시드와 달라도 추천에 넣어라** — 오히려 그게 kinship의 가장 강력한 형태다. 너바나(거친 그런지)와 픽시스(더 마른 인디록)는 질감이 다르지만, 코베인이 직접 밝힌 영향이라는 사실이 질감 차이를 압도한다. 이때 link_dimensions는 소닉이 약해도 그 곡들이 실제로 공유하는 축(예: structure의 quiet/loud 다이내믹)을 잡되, sonic_link 본문은 "코베인이 직접 ~라고 밝혔다"는 사실을 앞세운다.
   (2) Lineage (계보) — 영향원/동시대/후속. 시대·장르·국적의 일관성.
   (3) Production identity (프로덕션 정체성) — 같은 프로듀서(예: Brian Eno, Rick Rubin), 같은 엔지니어, 같은 레이블의 음향 색깔(Motown, Stax, ECM, 4AD 등).
   (4) Sonic identity (소닉 정체성) — 위에 정의된 8개 link_dimensions.
   (1)이 잡히는 추천을 우선 채워라. 못 찾으면 (2)→(3)→(4)로 내려간다. 모든 추천이 (1)일 필요는 없다(추천 풀의 다양성을 위해 섞는다).
   **할루시네이션 절대 금지 (중요):** 외부 사실을 sonic_link에 단정으로 쓰려면 — "X가 인터뷰에서 Y를 직접 언급했다", "X가 Y의 트리뷰트에 참여했다" 류 — 너가 **확실히 아는 유명한 사실**일 때만. 위 Cobain–Pixies처럼 널리 알려진 것은 좋지만, 긴가민가한 발언이나 "아마 영향받았을 것"을 사실처럼 적지 마라. 특히 잘 모르는 최근 아티스트(예: K-pop 프로듀서의 특정 레퍼런스 언급)를 "직접 언급했다"고 단정하는 것은 금지 — 그건 검증 불가능한 할루시네이션이다. 확신이 없으면 그 곡을 빼거나, 외부 사실 주장 없이 순수 소닉/계보 차원(2~4)으로만 sonic_link를 써라. 사실을 지어내느니 "음악적으로 통한다"고만 쓰는 게 낫다.

8. 청취자 친숙도 조정 (Listener accessibility tuning): 시드 컨텍스트에 listenerProfile이 전달된다.
   - librarySophistication: "mainstream" | "mixed" | "obscure" — 기본은 mixed이고, 사용자가 명시적으로 깊이를 조향한 요청("더 유명한 걸로"/"더 깊게")이면 그 신호로 설정돼 들어온다.
   - seedPopularity: 0~100 — 시드 곡 자체의 popularity.
   조정 원칙:
   - obscure 청취자 + 시드도 deep cut → 더 깊이 파고든다. 잘 알려진 곡(예: "Creep")은 추천 풀에서 배제. 4AD/Kranky/Drag City 류, 미발매·EP·세션 트랙, 평론가의 '잊힌 보물' 류를 우선.
   - mainstream 청취자 + 시드도 hit → 추천이 너무 deep으로 가면 청취자가 못 따라온다. 인접 장르의 입문급 곡, 대중적 히트지만 음악적 친족인 곡을 우선. 예: "Creep"을 좋아하는 K-인디·발라드 청취자에게는 루시드폴·Coldplay·Snow Patrol 류의 멜로디적 다리.
   - mixed → 양 끝을 섞되 약간의 발견(±1단계) 쪽으로 기울인다.
   - 시드가 hit인데 청취자는 obscure → 청취자가 그 hit를 "guilty pleasure"로 듣는 케이스. deep cut만 추천하지 말고 시드의 정체성을 가진 다른 hit도 일부 포함.
   이 조정은 추천 풀의 선별 기준이지 카테고리 추가가 아니다. 4 카테고리(influence/peer/descendant/kinship)는 그대로 유지.

9. 협업필터링 식 추천 금지. "이 곡 들은 사람들이 또 들은 곡"이 아니라 음악적 정체성이 통하는 곡.

10. 검증 통과 (중요 — 추천이 사용자에게 보이려면 필수): 네가 제출한 모든 곡은 Spotify Search로 자동 검증된 뒤에야 사용자에게 노출된다. 검증 규칙은 **artist 정확 일치(크레딧 중) + 곡 제목 일치(리마스터 류 동일-녹음 부제는 자동 무시 — 단 라이브/데모/어쿠스틱/리믹스는 다른 녹음으로 취급되므로, 그 버전을 의도한 게 아니면 본 제목만 써라) + album 부분 일치 + 발매연도 ±2(명백한 리마스터/리이슈 앨범은 연도 유예)**이며, 하나라도 어긋나면 그 곡은 조용히 버려진다(아무리 좋은 친족이어도 사용자는 못 본다).
   먼저 분명히 해둘 것 — 이 규칙은 **선곡을 바꾸지 않는다.** 여전히 deep cut을 골라라(원칙 2: 히트일 필요 없다, "Hey Jude"가 아니라 "Birthday"의 묻힌 순간). 바뀌는 건 고른 곡을 **어떻게 표기하느냐**뿐이다. deep cut도 정규 앨범에 정확히 실려 있으면 검증을 통과한다 — 드랍의 원인은 곡이 묻혀서가 아니라 표기가 틀려서다. 그러니 곡은 자유롭게 깊이 파되, 그 곡의 메타데이터만 Spotify 정규판 기준으로 정확히 적어라:
   - **track**: Spotify에 실제로 검색되는 표기로. 리마스터/리이슈 부제("- Remastered 2009", "- Mono Version")는 떼고 본 제목만. feat. 표기는 track이 아니라 실제 협연이면 메인 아티스트 기준으로 판단.
   - **artist**: 그 곡의 **메인(첫 번째) 크레딧 아티스트** 한 명을 우선하되, 콜라보에서 네가 의도한 아티스트가 뒤 크레딧이면 그 이름 한 명만 적어도 된다(검증은 크레딧 전체에서 정확 일치를 찾는다). "X feat. Y"처럼 합쳐 쓰면 어떤 크레딧과도 일치하지 않아 드랍된다. 컴필레이션/사운드트랙에 실린 곡이라도 원 아티스트로. **한국/일본 등 비영어권 아티스트는 Spotify 크레딧이 로마자인 경우가 많다** — 박정현이 아니라 "Lena Park", 竹内まりや가 아니라 "Mariya Takeuchi". Spotify에서 통용되는 로마자 표기를 안다면 그쪽을 써라(모르면 원어 그대로 — 검증이 최근접 크레딧을 피드백해준다).
   - **album**: 그 곡이 **처음 실린 정규 스튜디오 앨범명**. 베스트/그레이티스트 히트/컴필레이션/"Singles" 모음명을 쓰지 마라 — 싱글로만 나온 곡이라도 그 곡이 수록된 정규 앨범(있다면)을 우선. 디럭스/리마스터 에디션이면 핵심 앨범명만(부분 일치라 "OK Computer"는 "OK Computer OKNOTOK"에도 매치된다).
   - **year**: 그 곡의 **오리지널 발매연도**. Spotify에 리마스터판만 있어도 오리지널 연도를 적어라(검증이 ±2를 허용하므로 리마스터 연도로 적으면 수십 년 차로 드랍된다). 확실치 않으면 가장 신뢰할 만한 오리지널 발매연도로.
   확신이 없는 곡(앨범/연도가 헷갈리는 희귀 트랙)이라면, 같은 아티스트의 검증 가능한 다른 곡으로 바꾸는 게 드랍당하는 것보다 낫다 — 단 이건 표기가 불확실할 때의 최후 수단이지, deep cut을 피하라는 뜻이 아니다.

카테고리별 최소 개수:
- influences (≥2): 시드가 영향받은 선배 아티스트의 곡
- peers (≥2): 같은 시기 비슷한 정체성의 곡
- descendants (≥1): 시드의 사운드를 계승한 후배 곡
- kinship (≥2, 이게 핵심): 장르·시대·국적이 다르지만 음악적 친족인 곡

총 9~10곡을 목표로 하라 (최소 7, 최대 12). 목표를 최소보다 높게 두는 이유: 네 제출곡 일부는 Spotify 검증에서 깎이므로, 깎인 뒤에도 카테고리 최소가 유지되도록 여유를 두는 것이다. 단 억지로 채우지 마라 — 약한 픽으로 수를 채우느니 강한 픽 9곡이 낫다. 12곡을 넘기면 응답이 잘려서 전부 버려진다. sonic_link는 반드시 한 문장(또는 짧은 두 문장)으로 끝내라 — 응답이 길수록 사용자가 못 본다.

각 곡마다 채워야 할 필드:
- artist, track, album, year — 아래 "검증 통과" 규칙대로 정확하게.
- sonic_link: 한국어 1-2문장, **플레인 텍스트만** — 마크다운 서식(볼드 ** 등) 금지, UI가 서식을 렌더하지 않는다. 그 곡의 어떤 요소/구간(예: "2분 30초 무렵의 디스토션 솔로", "마지막 후렴의 비명에 가까운 보컬")이 시드의 어떤 sonic moment와 어떻게 연결되는지 구체적으로. **외부 사실(원칙 7-(1))이 확실하면 그 사실을 문장 앞에 명시** (예: "커트 코베인이 직접 픽시스를 베끼려 했다고 밝힌 곡으로, …"). 단 확실하지 않은 인터뷰/협업 주장은 절대 적지 마라 — 모르면 소닉/계보 묘사만.
- link_dimensions: 연결이 일어나는 차원. 8종 중 1~3개. 이 enum에 없는 값 사용 금지.
  - mood: 분위기 (도시적·우울·황홀·긴장 등)
  - structure: 곡의 거시 구성 (롱폼·빌드업·솔로 비중·코다 페이드)
  - texture: 사운드 텍스처 (어쿠스틱/일렉트릭 비율·공간감·드라이/웻·왜곡 정도)
  - narrative: 가사 화법 (1인칭 관찰자·묘사적·서사적)
  - groove: 그루브감 (스윙·셔플·록 직진·폴리리듬)
  - vocal_style: 창법 (읊조림·내뱉기·벨팅·휘파람 톤·내레이션)
  - melody: 멜로디 라인 (후렴 모티프·보컬 멜로디 윤곽·멜로디 후크의 위치·반복 패턴)
  - progression: 화성·진행 방식 (코드 진행 패턴·모달 vs 토널·브릿지/후렴 전환·키 모듈레이션)

lineage_notes (큐레이터의 의도): 2-3문장 한국어, **플레인 텍스트만**(마크다운 볼드/이탤릭/리스트 마커 금지 — UI가 서식을 렌더하지 않아 별표가 그대로 노출된다). AccuRadio의 채널 헤더처럼, 이 큐레이션이 어떤 테마/방향인지 한눈에 알 수 있게. 첫 문장은 시드가 일관형인지 여정형인지 + 이 큐레이션 전체가 어떤 "방"인지(어떤 정조로 묶이는지)를 밝혀라. 그다음 시드의 무엇을 들었고 어떤 발견을 하게 하려는지, 청취자 프로파일 조정 결과를 녹인다. 단순히 "비슷한 곡을 모았다"가 아니라 "이 곡들이 함께 어떤 정서적 공간을 만드는지"를 규정해야 한다.

예시 — 시드 Radiohead "Creep", listenerProfile=obscure:
"Creep을 거치지 않은 청취자는 적지만, 이 큐레이션은 그 곡의 '갇힌 자기혐오'와 quiet/loud 다이내믹을 더 어둡고 비주류로 파고든다. 90s shoegaze·slowcore의 자기 파괴적 미학을 시드의 헤드/심장 부위에서 잇는다."

예시 — 시드 Radiohead "Creep", listenerProfile=mainstream:
"Creep의 멜랑콜리한 후렴과 멜로디적 진심을 다리로, 인디·발라드 청취자에게 영국 록의 깊은 정서적 영역을 소개한다. 더 어둡거나 실험적인 길은 다음 단계에 남겨둔다."`

const KINSHIP_TOOL = {
  name: 'submit_kinship_curation',
  description: '분석한 lineage_notes와 4 카테고리 트랙 추천을 제출한다.',
  input_schema: {
    type: 'object' as const,
    required: ['lineage_notes', 'tracks'],
    properties: {
      lineage_notes: {
        type: 'string',
        description: '시드 분석 + 큐레이션 의도 2-3문장 한국어',
      },
      tracks: {
        type: 'array',
        items: {
          type: 'object',
          required: [
            'category',
            'artist',
            'track',
            'album',
            'year',
            'sonic_link',
            'link_dimensions',
          ],
          properties: {
            category: { type: 'string', enum: [...CATEGORIES] },
            artist: { type: 'string' },
            track: { type: 'string' },
            album: { type: 'string' },
            year: { type: 'integer', minimum: 1900, maximum: 2100 },
            sonic_link: { type: 'string' },
            link_dimensions: {
              type: 'array',
              minItems: 1,
              maxItems: 3,
              items: { type: 'string', enum: [...LINK_DIMENSIONS] },
            },
          },
        },
      },
    },
  },
}

function renderUserMessage(ctx: SeedContext): string {
  const audioLines: string[] = []
  const a = ctx.audio
  if (a.energy !== undefined) audioLines.push(`- energy: ${a.energy.toFixed(2)}`)
  if (a.valence !== undefined) audioLines.push(`- valence: ${a.valence.toFixed(2)}`)
  if (a.tempo !== undefined) audioLines.push(`- tempo: ${a.tempo.toFixed(0)} BPM`)
  if (a.acousticness !== undefined) audioLines.push(`- acousticness: ${a.acousticness.toFixed(2)}`)
  if (a.danceability !== undefined) audioLines.push(`- danceability: ${a.danceability.toFixed(2)}`)
  if (a.instrumentalness !== undefined) audioLines.push(`- instrumentalness: ${a.instrumentalness.toFixed(2)}`)

  const tonalLines: string[] = []
  const t = ctx.tonal
  if (t.key) tonalLines.push(`- key: ${t.key}`)
  if (t.mode) tonalLines.push(`- mode: ${t.mode}`)
  if (t.time_signature) tonalLines.push(`- time_signature: ${t.time_signature}`)

  return [
    `시드 곡:`,
    `- "${ctx.track.name}" by ${ctx.track.artist}`,
    `- 앨범: ${ctx.track.album} (${ctx.track.year})`,
    ``,
    `Spotify 아티스트 장르: ${ctx.spotifyGenres.length ? ctx.spotifyGenres.join(', ') : '정보 없음'}`,
    `Last.fm 트랙 태그: ${ctx.lastfmTrackTags.length ? ctx.lastfmTrackTags.slice(0, 10).join(', ') : '정보 없음'}`,
    `Last.fm 아티스트 태그: ${ctx.lastfmArtistTags.length ? ctx.lastfmArtistTags.slice(0, 10).join(', ') : '정보 없음'}`,
    audioLines.length ? `Audio features:\n${audioLines.join('\n')}` : `Audio features: 정보 없음`,
    tonalLines.length ? `토널 정보:\n${tonalLines.join('\n')}` : ``,
    ``,
    `청취자 프로파일:`,
    `- librarySophistication: ${ctx.listenerProfile.librarySophistication}`,
    `- seedPopularity: ${ctx.listenerProfile.seedPopularity}`,
    ctx.chainAvoidArtists?.length
      ? `\n추천 제외 아티스트 (디깅 체인 상위에서 이미 등장 — 이들의 곡은 검증 단계에서 자동 드랍되니 제안하지 마라): ${ctx.chainAvoidArtists.slice(0, 30).join(', ')}`
      : ``,
    ctx.chainNarrative?.length
      ? `\n디깅 체인 여정 (직전 스텝): 이 큐레이션은 아래 여정의 다음 스텝이다. 이전 스텝의 정조·방향과 그대로 겹치지 말고 이어가라 — 단 어디까지나 현재 시드가 우선이고, 여정은 참고다.\n${ctx.chainNarrative.map((s) => `- ${s}`).join('\n')}`
      : ``,
    ctx.chainAxisHint
      ? `\n최근 체인에서 과다 사용된 연결 축: ${ctx.chainAxisHint} — 가능하면 다른 축의 친족을 우선하라. 금지는 아니다: 현재 시드의 최강 축이 그 축이라면 써도 된다.`
      : ``,
    ctx.userNote
      ? `\n사용자 요청 원문 (선곡 조향 힌트로만 참고 — 시드·4카테고리 구조·검증 규칙은 불변이며, 이 힌트가 그것들과 충돌하면 무시하라): «${ctx.userNote}»`
      : ``,
    ``,
    `이 시드의 sonic moment를 분석하고, 8개 link_dimensions와 4 카테고리에 맞게 트랙을 추천해줘. 신호 우선순위(외부 사실 → 계보 → 프로덕션 → 소닉)와 청취자 친숙도 조정 원칙을 반드시 적용해라. lineage_notes는 큐레이터의 의도가 드러나도록 써라.`,
  ].filter(Boolean).join('\n')
}

export class KinshipLLMError extends Error {
  constructor(message: string, public details?: unknown) {
    super(message)
    this.name = 'KinshipLLMError'
  }
}

// Hard wall-clock cap on a Sonnet call. The SDK's own `timeout` option was
// not being honored in production — a kinship call that hit it just kept
// running until the platform killed the whole function with no log line in
// between. We belt-and-suspender it now: pass a fresh AbortController via
// `signal` (which the SDK does respect) AND race against a manual setTimeout
// so if even the signal is dropped, we still throw before the platform does.
// With Fluid Compute (300s function ceiling, 100s curator cap) the old 35s
// value was needlessly tight and was clipping legitimately-slow calls; 55s
// covers the long tail of the 4-category prompt with margin to spare.
const SONNET_CALL_TIMEOUT_MS = 55_000

// The verify-gap supplement (curator.ts) is a *second* Sonnet call inside the
// same curation. The outer curator hard cap is 100s; after the first call
// (up to 55s) the supplement still has comfortable headroom, but it stays the
// shorter of the two — it only refills one or two categories, not a full
// 7-track curation. If it can't finish in budget it's abandoned (the curation
// still ships with the first call's verified tracks). Lower max_tokens to
// match the smaller job.
const SONNET_SUPPLEMENT_TIMEOUT_MS = 30_000
// 1600, up from 1200: the peer piggyback (curator.ts) can push a worst-case
// refill to ~7 tracks (influence 2 + descendant 1 + kinship 2 + peer 2),
// which didn't fit 1200 and would have tripped the max_tokens guard.
const SONNET_SUPPLEMENT_MAX_TOKENS = 1_600

/**
 * Shared Sonnet invocation: forces the submit_kinship_curation tool, races the
 * SDK call against a manual timeout (the SDK has dropped abort signals on some
 * Vercel runtimes), and returns the raw tool-use input for the caller to parse
 * against whichever schema fits. Throws KinshipLLMError on timeout / no
 * tool_use.
 */
async function callSonnet(args: {
  userContent: string
  timeoutMs: number
  maxTokens: number
  tag: string
  /** Outer abort (the curator's hard cap) — merged with the local timeout so
   * a curation that's already been reported as failed stops burning tokens. */
  signal?: AbortSignal
}): Promise<unknown> {
  const { userContent, timeoutMs, maxTokens, tag, signal: outerSignal } = args
  const tStart = Date.now()
  const controller = new AbortController()
  const timeoutId = setTimeout(
    () => controller.abort(new Error('local timeout')),
    timeoutMs
  )
  const signal = outerSignal
    ? AbortSignal.any([outerSignal, controller.signal])
    : controller.signal

  let resp
  try {
    const apiCall = anthropic().messages.create(
      {
        model: MODELS.kinship,
        // First call passes 2400 (~10 tracks of artist+track+album+year+short
        // sonic_link+link_dimensions plus a 3-line lineage_notes — the
        // overshoot experiment's 9-10 track target). The "shorter sonic_link"
        // rule in the system prompt does most of the work — this is the hard
        // cap that backs it. Supplement calls pass a lower value.
        max_tokens: maxTokens,
        // 0.6 is the sweet spot for this product: low enough that song titles
        // and artists don't drift into hallucination (which would get dropped
        // by Spotify verify and force a retry, costing us wall-clock), high
        // enough that the kinship category keeps surfacing the non-obvious
        // cross-genre picks that justify the whole product. We briefly tried
        // 0.4 thinking it would shave time — no measurable effect, just safer
        // recs.
        temperature: 0.6,
        // The ~4.5k-token system prompt is static; ephemeral caching (5min
        // TTL) makes retry/supplement calls and digging-chain follow-ups hit
        // the cache instead of re-processing it (input cost -90%, TTFT down).
        // The tools block above it is part of the cached prefix too.
        system: [
          {
            type: 'text' as const,
            text: SYSTEM_PROMPT,
            cache_control: { type: 'ephemeral' as const },
          },
        ],
        tools: [KINSHIP_TOOL],
        tool_choice: { type: 'tool', name: KINSHIP_TOOL.name },
        messages: [{ role: 'user', content: userContent }],
      },
      { signal }
    )

    // Backstop race: if the SDK swallows the abort signal for any reason
    // (it has in the past on some Vercel runtimes), this still throws and
    // lets the caller turn it into an `llm_failed` / abandon the supplement.
    let backstopId: ReturnType<typeof setTimeout> | undefined
    const localTimeout = new Promise<never>((_, reject) => {
      backstopId = setTimeout(
        () =>
          reject(
            new KinshipLLMError(
              `Sonnet call exceeded ${timeoutMs}ms (local race)`
            )
          ),
        timeoutMs + 1_000
      )
    })

    try {
      resp = await Promise.race([apiCall, localTimeout])
    } finally {
      clearTimeout(backstopId)
    }
    // Log output_tokens alongside elapsed: Sonnet wall-clock is ~linear in
    // output token count, so this is the single number that tells us whether
    // a max_tokens / sonic_link diet would actually buy time and how much.
    // (e.g. "sonnet curate 24800ms out=1180tok" → ~21ms/tok.)
    const out = resp.usage?.output_tokens
    const elapsed = Date.now() - tStart
    console.log(
      `[kinship] sonnet ${tag} ${elapsed}ms` +
        (out !== undefined
          ? ` out=${out}tok (${(elapsed / out).toFixed(1)}ms/tok)`
          : '')
    )
  } catch (err) {
    console.log(
      `[kinship] sonnet ${tag} FAILED after ${Date.now() - tStart}ms: ${
        err instanceof Error ? err.message : String(err)
      }`
    )
    if (err instanceof KinshipLLMError) throw err
    throw new KinshipLLMError(
      `Sonnet call failed: ${err instanceof Error ? err.message : String(err)}`,
      err
    )
  } finally {
    clearTimeout(timeoutId)
  }

  // A response clipped by max_tokens leaves the tool JSON truncated, which
  // used to masquerade as "no tool call" / a schema miss and burn a full
  // retry without telling anyone why. Name the real cause so the retry
  // feedback tells Sonnet to shrink the track count.
  if (resp.stop_reason === 'max_tokens') {
    throw new KinshipLLMError(
      `Sonnet 응답이 max_tokens(${maxTokens})에서 절단됨 — 곡 수를 줄이고 sonic_link를 더 짧게 써서 다시 제출하라`
    )
  }

  const toolUse = resp.content.find((b) => b.type === 'tool_use')
  if (!toolUse || toolUse.type !== 'tool_use') {
    throw new KinshipLLMError('Sonnet이 tool을 호출하지 않았습니다.')
  }
  return toolUse.input
}

// A schema-retry needs at least one more full Sonnet call to be worth
// starting. If less than this remains before the curator's hard cap, the
// retry would just get guillotined mid-flight (and was a real contributor to
// the 1-minute timeouts), so we surface the first failure instead. Budget =
// one Sonnet call + a little slack for parse/verify afterward.
const RETRY_MIN_HEADROOM_MS = SONNET_CALL_TIMEOUT_MS + 8_000

/**
 * Call Sonnet with the seed context. Forces the submit_kinship_curation tool.
 * Validates with zod; on validation failure, retries once with feedback —
 * but only if there's enough wall-clock left before `deadlineMs` for another
 * full call. `deadlineMs` is the absolute epoch-ms cap from the curator; when
 * omitted (e.g. the test-kinship skill calling directly) the retry always
 * fires.
 */
export async function recommendKinship(
  ctx: SeedContext,
  deadlineMs?: number,
  signal?: AbortSignal
): Promise<KinshipResponse> {
  const userMessage = renderUserMessage(ctx)

  async function callOnce(extraNote?: string): Promise<KinshipResponse> {
    const input = await callSonnet({
      userContent: extraNote
        ? `${userMessage}\n\n[재시도 메모: ${extraNote}]`
        : userMessage,
      timeoutMs: SONNET_CALL_TIMEOUT_MS,
      // 2400 (was 2000): overshoot 실험 — 프롬프트가 9~10곡을 목표로 하므로
      // 10곡 + lineage_notes가 절단 없이 들어갈 여유. 출력 ~21ms/tok 기준
      // +400tok ≈ 최악 +8s는 55s 콜 캡 안. 전/후 비교는 캘리브레이션 배치로
      // (docs §7.5 overshoot 게이트).
      maxTokens: 2400,
      tag: 'curate',
      signal,
    })
    const parsed = KinshipResponseSchema.safeParse(input)
    if (!parsed.success) {
      // zod issue 요약을 message에 실어야 재시도 노트(callOnce의 extraNote)로
      // 전달된다 — "스키마 불만족"만으론 Sonnet이 뭘 고칠지 모른다. 핵심은
      // refine의 floor 미달 메시지. 중복 제거 + 300자 캡(긴 노트는 오히려
      // 순응도를 해침). flatten은 details로 보존(로그/디버그용).
      const issueSummary = [
        ...new Set(parsed.error.issues.map((i) => i.message)),
      ]
        .join('; ')
        .slice(0, 300)
      throw new KinshipLLMError(
        `Sonnet 응답이 스키마를 만족하지 못함: ${issueSummary}`,
        parsed.error.flatten()
      )
    }
    // Sonnet이 프롬프트 금지에도 마크다운 볼드를 섞는 경우가 있어 생성
    // 시점에 강조 마커를 벗긴다 (UI는 플레인 텍스트 렌더 — "**일관형**"
    // 별표 노출 방지).
    return {
      lineage_notes: stripMarkdownEmphasis(parsed.data.lineage_notes),
      tracks: parsed.data.tracks.map((t) => ({
        ...t,
        sonic_link: stripMarkdownEmphasis(t.sonic_link),
      })),
    }
  }

  try {
    return await callOnce()
  } catch (err) {
    if (err instanceof KinshipLLMError) {
      // No retry if the curation has already been aborted (hard cap fired) or
      // there's no room for a second full call before the hard cap.
      if (signal?.aborted) throw err
      const remaining =
        deadlineMs === undefined ? Infinity : deadlineMs - Date.now()
      if (remaining < RETRY_MIN_HEADROOM_MS) {
        console.log(
          `[kinship] schema miss but only ${remaining}ms left — skipping retry`
        )
        throw err
      }
      // One retry with the validation message as feedback.
      return await callOnce(err.message)
    }
    throw err
  }
}

/**
 * Verify-gap supplement: after the curator runs Spotify verification, a
 * category can fall BELOW its schema floor even though the original response
 * satisfied it (some of the LLM's picks failed verify — e.g. a single-only
 * track whose album/year can't be matched, leaving kinship at 1 under a floor
 * of 2). This asks Sonnet to refill ONLY the deficient categories by the
 * shortfall amount, steering it toward verify-friendly picks (tracks on a
 * proper studio album) and away from anything it already proposed.
 *
 * Best-effort: on any failure (timeout, no tool_use, schema miss) it returns an
 * empty track list so the curation still ships with whatever the first call
 * verified. Never throws.
 */
// Reuses catalog.ts's VerifyFailReason (type-only import, lockstep enforced
// by the compiler). infra_failure never appears here — an infra failure is
// not the LLM's fault; the curator retries it instead of asking Sonnet to
// "fix" anything.
export type SupplementVerifyFailure = {
  artist: string
  track: string
  reason: VerifyFailReason
  nearest?: {
    artist?: string
    track?: string
    album: string
    year: number | null
  }
}

function renderFailureLine(f: SupplementVerifyFailure): string {
  // 최근접 후보의 크레딧이 주장과 다르면 표기 — "The Stooges"로 냈는데
  // Spotify 크레딧이 다른 형태인 클래스를 Sonnet이 고칠 수 있게.
  const credit =
    f.nearest?.artist &&
    f.nearest.artist.trim().toLowerCase() !== f.artist.trim().toLowerCase()
      ? ` — 크레딧 "${f.nearest.artist}"`
      : ''
  switch (f.reason) {
    case 'not_found':
      return `- ${f.artist} — ${f.track}: Spotify에서 이 아티스트의 이 곡을 찾지 못함${
        f.nearest?.artist
          ? ` (같은 제목이 "${f.nearest.artist}" 명의로 존재${
              f.nearest.album
                ? ` — "${f.nearest.album}"${f.nearest.year ? `, ${f.nearest.year}` : ''}`
                : ''
            }. 같은 곡이라 단정할 수는 없으니, 그 아티스트가 네가 의도한 곡의 실제 크레딧이면 artist 표기를 고쳐 재제출하고, 아니면 다른 곡으로)`
          : ' (표기 오류이거나 존재하지 않는 곡 — 다른 곡으로 대체하라)'
      }`
    case 'title_mismatch':
      return `- ${f.artist} — ${f.track}: 곡 제목 불일치${
        f.nearest?.track
          ? ` (Spotify에서 그 아티스트의 최근접 곡: "${f.nearest.track}" — 이 제목이 맞다면 표기를 고쳐 다시 내고, 아니면 다른 곡으로)`
          : ' (제목 표기를 고치거나 다른 곡으로)'
      }`
    case 'album_mismatch':
      return `- ${f.artist} — ${f.track}: album 불일치${
        f.nearest ? ` (Spotify에서 확인된 최근접 수록: "${f.nearest.album}"${f.nearest.year ? `, ${f.nearest.year}` : ''}${credit})` : ''
      }`
    case 'year_mismatch':
      return `- ${f.artist} — ${f.track}: 발매연도 불일치${
        f.nearest ? ` (Spotify 기준: "${f.nearest.album}" = ${f.nearest.year}년${credit})` : ''
      }`
  }
}

export async function supplementKinship(args: {
  ctx: SeedContext
  // category → how many more verified tracks we'd like (a soft target)
  deficits: { category: Category; want: number }[]
  // (artist, track) pairs already proposed — don't repeat these
  avoid: { artist: string; track: string }[]
  // first-pass verify failures, so Sonnet fixes metadata instead of guessing
  verifyFailures?: SupplementVerifyFailure[]
  // leap Phase B(B0): 1차 kinship 픽 중 도약이 약하다고 감사된 곡들 —
  // 픽 자체는 유지되지만 floor에서 제외됐으니 "강을 건너는" 픽으로 채우라는
  // 피드백. "artist — track" 형태의 라인들.
  weakLeapNotes?: string[]
  signal?: AbortSignal
}): Promise<SupplementResult> {
  const { ctx, deficits, avoid, verifyFailures, weakLeapNotes, signal } = args
  if (deficits.length === 0) {
    return { tracks: [], outcome: 'empty', rawReturned: 0 }
  }

  const deficitLines = deficits
    .map((d) => `- ${d.category}: ${d.want}곡 더`)
    .join('\n')
  const avoidLines = avoid
    .slice(0, 40)
    .map((a) => `- ${a.artist} — ${a.track}`)
    .join('\n')
  const failureLines = (verifyFailures ?? [])
    .slice(0, 12)
    .map(renderFailureLine)
    .join('\n')

  const userContent = [
    renderUserMessage(ctx),
    ``,
    `[보충 요청] 위 시드에 대한 1차 추천 중 일부 카테고리가 Spotify 검증에서 탈락해 최소 개수에 못 미친다. 아래 카테고리만 부족한 만큼 추가로 채워라:`,
    deficitLines,
    ``,
    ...(failureLines
      ? [
          `1차 탈락 곡과 사유 (같은 실수를 반복하지 마라 — album/year 불일치는 해당 곡을 Spotify 정규판 표기로 고쳐 다시 내도 된다):`,
          failureLines,
          ``,
        ]
      : []),
    ...(weakLeapNotes?.length
      ? [
          `도약 감사에서 약하다고 판정된 1차 kinship 픽 (곡 자체는 유지되지만 kinship 최소 개수 계산에서 제외됐다 — 아래 곡들처럼 시드와 동시대·동장르에 머물지 말고, 시대나 장르의 강을 확실히 건너는 픽으로 채워라):`,
          ...weakLeapNotes.map((w) => `- ${w}`),
          ``,
        ]
      : []),
    `반드시 지켜라:`,
    `- 위에 나열된 카테고리의 곡만 제출한다. 다른 카테고리는 비워도 된다. 표기된 수만큼 제출하라 — 부족분보다 1곡 여유가 이미 반영돼 있고, 노출은 검증 통과분만 되니 초과를 걱정할 필요 없다.`,
    `- 검증 친화적인 곡을 골라라: 컴필레이션/베스트앨범/싱글 표기 대신, 그 곡이 처음 실린 정규 스튜디오 앨범명과 발매연도를 정확히 적어라. 검증은 artist 정확매치(크레딧 중) + 곡 제목 일치(리마스터 류 부제만 무시 — 라이브/데모는 다른 곡 취급) + album 부분일치 + 발매연도 ±2로 이뤄진다.`,
    `- 아래 곡들은 1차에서 이미 제안됐으니 반복하지 마라 (단, 위 "탈락 곡"을 artist/track/album/year 표기만 고쳐 다시 내는 것은 허용 — 곡 자체를 바꾸지 않고 메타데이터를 교정하는 재제출이다):`,
    avoidLines || '- (없음)',
  ].join('\n')

  try {
    const input = await callSonnet({
      userContent,
      timeoutMs: SONNET_SUPPLEMENT_TIMEOUT_MS,
      maxTokens: SONNET_SUPPLEMENT_MAX_TOKENS,
      tag: 'supplement',
      signal,
    })
    const parsed = KinshipSupplementSchema.safeParse(input)
    if (!parsed.success) {
      console.log('[kinship] supplement schema miss — shipping without it')
      return { tracks: [], outcome: 'schema_miss', rawReturned: 0 }
    }
    // Keep only the categories we actually asked for; Sonnet sometimes throws
    // in an extra kinship pick "for free" which would skew the curation.
    const wanted = new Set(deficits.map((d) => d.category))
    const tracks = parsed.data.tracks
      .filter((t) => wanted.has(t.category))
      .map((t) => ({ ...t, sonic_link: stripMarkdownEmphasis(t.sonic_link) }))
    return {
      tracks,
      outcome:
        tracks.length > 0
          ? 'ok'
          : // 반환은 있었는데 요청 카테고리 필터가 전부 걸러낸 케이스
            'filtered_empty',
      rawReturned: parsed.data.tracks.length,
    }
  } catch (err) {
    console.log('[kinship] supplement failed — shipping without it')
    // timeout vs 기타 실패 구분은 메시지 휴리스틱: 로컬 타임아웃은 abort
    // ("aborted") 또는 백스톱 race("exceeded")로 표면화된다. outer 하드캡
    // abort도 예산 소진이므로 timeout으로 분류.
    const msg = err instanceof Error ? err.message : String(err)
    return {
      tracks: [],
      outcome: /timeout|exceeded|abort/i.test(msg) ? 'timeout' : 'failed',
      rawReturned: 0,
    }
  }
}
