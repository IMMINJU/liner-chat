/**
 * Single source for user-facing strings.
 *
 * Why a flat object instead of t("auth.error.session_expired") style:
 * - No runtime lookup overhead, TypeScript catches typos.
 * - When we add i18n later, swap this module for a locale-keyed variant
 *   (`messages.ko.ts` / `messages.en.ts`) and a tiny `getMessages(locale)`
 *   accessor. Call sites stay identical.
 *
 * Rules:
 * - All strings shown to the user go here. No inline Korean in components/routes.
 * - Functions for dynamic strings (with placeholders) live here too.
 * - Keep keys grouped by feature.
 */

export const messages = {
  app: {
    title: 'Liner Chat',
    tagline: '시드 곡 한 곡으로 음악적 친족을 따라가는 큐레이션.',
  },

  // Categories surface in the curation UI; keep enum keys aligned with DB.
  curation: {
    categories: {
      influence: '영향원',
      peer: '동시대 동료',
      descendant: '후속',
      kinship: '음악적 친족',
    } as const,
    actions: {
      digDeeper: '🔍 이걸로 더 파보기',
      saveToSpotify: 'Spotify에 저장',
      openInSpotify: 'Spotify에서 열기',
      preview: '미리듣기',
    },
    seedLabel: '시드 곡',
    parentBreadcrumb: (artistTrack: string) => `← 이전 시드: ${artistTrack}`,
    notFound: '존재하지 않는 큐레이션이에요.',
    statsLine: (s: {
      proposedByLLM: number
      verifiedOnSpotify: number
      droppedAsDuplicate: number
      droppedByDiversity: number
    }) =>
      `LLM 제안 ${s.proposedByLLM} · Spotify 검증 ${s.verifiedOnSpotify} · 중복 제외 ${s.droppedAsDuplicate} · 다양성 ${s.droppedByDiversity}`,
    linkDimensionLabels: {
      mood: '분위기',
      structure: '구성',
      texture: '텍스처',
      narrative: '내러티브',
      groove: '그루브',
      vocal_style: '창법',
      melody: '멜로디',
      progression: '진행',
    } as const,
  },

  chat: {
    smallTalk:
      '음악 큐레이션을 도와드려요. "Tame Impala Elephant 같은 거 추천해줘"처럼 좋아하는 곡 하나를 알려주면 그 곡의 음악적 친족을 찾아드려요.',
    error: '응답 처리 중 오류가 났어요. 잠시 후 다시 시도해주세요.',
    emptyInput: '메시지를 입력해주세요.',
  },

  // Pipeline-level user-facing failures (see docs/curation-pipeline.md).
  // Each entry is structured so the UI can show a heading + body + optional
  // action button (href + label) instead of dumping a raw message.
  pipeline: {
    seedNotFound: {
      title: '그 곡을 못 찾았어요',
      body:
        '아티스트 이름과 곡 제목을 같이 적어주면 좋아요. 예: "Tame Impala Elephant 같은 거 추천해줘".',
    },
    llmFailed: {
      title: '추천을 만들지 못했어요',
      body: '잠시 후 다시 시도해주세요. 같은 시드로 한 번 더 보내봐도 좋아요.',
    },
    allDropped: {
      title: '확인된 추천이 없어요',
      body:
        '추천 후보들이 Spotify 검색에서 확인이 안 됐어요. 다른 시드 곡으로 시도해주세요.',
    },
    rateLimited: {
      title: '잠시 후 다시',
      body: 'Spotify 호출 한도에 닿았어요. 1-2분 뒤에 다시 시도해주세요.',
    },
    unknown: {
      title: '알 수 없는 오류',
      body: '잠시 후 다시 시도해주세요. 계속되면 알려주세요.',
    },
  },
} as const

/** Curator error code → structured user message. */
export type PipelineErrorKey = keyof typeof messages.pipeline
const PIPELINE_BY_CURATOR_CODE: Record<string, PipelineErrorKey> = {
  seed_not_found: 'seedNotFound',
  llm_failed: 'llmFailed',
  all_dropped: 'allDropped',
  unknown: 'unknown',
}
export function pipelineErrorFor(code: string) {
  const key = PIPELINE_BY_CURATOR_CODE[code] ?? 'unknown'
  return messages.pipeline[key]
}
