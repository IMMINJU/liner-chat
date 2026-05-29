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
  auth: {
    errors: {
      access_denied: 'Spotify 권한 동의가 취소됐어요. 다시 시도해주세요.',
      session_expired: '인증 세션이 만료됐어요. 다시 로그인해주세요.',
      state_mismatch: '보안 검증 실패. 새로 로그인해주세요.',
      missing_code: '인증 응답에 문제가 있었어요. 다시 시도해주세요.',
      token_exchange_failed:
        'Spotify 인증 서버에서 토큰을 못 받았어요. 잠시 후 다시.',
      me_lookup_failed: '사용자 정보를 가져오지 못했어요. 다시 시도해주세요.',
      unknown: '알 수 없는 오류. 다시 시도해주세요.',
    } as const,
    actions: {
      start: 'Spotify로 시작하기',
      hint: '첫 로그인 시 Spotify 동의 화면이 한 번 뜹니다.',
      logout: '로그아웃',
      loggedInAs: (name: string) => `로그인됨: ${name}`,
    },
  },

  app: {
    title: 'Liner Chat',
    tagline: '시드 곡 한 곡으로 음악적 친족을 따라가는 큐레이션.',
    chatPlaceholderNotice:
      '(채팅 UI는 Figma Make에서 제작 예정. 현재는 로그인 흐름만.)',
    nav: {
      settings: '설정',
    },
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

  sync: {
    title: '설정',
    runButton: '지금 동기화',
    running: '동기화 중…',
    lastSyncAt: (iso: string) => `마지막 동기화: ${iso}`,
    neverSynced: '아직 동기화한 적 없어요.',
    stats: (args: {
      liked: number
      tracks: number
      lastPlayedAt: string | null
    }) =>
      `좋아요 ${args.liked}곡 · 트랙 ${args.tracks}개` +
      (args.lastPlayedAt ? ` · 마지막 재생 ${args.lastPlayedAt}` : ''),
    success: (args: {
      liked: number
      topTotal: number
      recentlyInserted: number
      artistsEnriched: number
      durationMs: number
    }) =>
      `liked ${args.liked} · top ${args.topTotal} · recently +${args.recentlyInserted} · artists +${args.artistsEnriched} (${args.durationMs}ms)`,
    partial: (failed: string[]) =>
      `일부 단계 실패: ${failed.join(', ')}. 완료된 데이터는 저장됐어요.`,
    errors: {
      notAuth: '로그인이 필요해요.',
      unknown: '동기화 중 오류가 발생했어요. 잠시 후 다시 시도해주세요.',
    },
    recentCurationsTitle: '최근 큐레이션',
  },

  library: {
    title: '내 라이브러리',
    empty: (genres: string[]) =>
      `${genres.join(', ')} 곡이 라이브러리에 없어요.`,
    notSynced: '먼저 설정에서 동기화를 해주세요.',
    partial: (skipped: number) =>
      `${skipped}곡은 다음 요청에서 계속 분석할게요.`,
    countSummary: (count: number, shown: number, computed: number) =>
      `${count}곡 매칭 · ${shown}곡 표시 · 이번에 분석 ${computed}곡`,
  },

  playlist: {
    actions: {
      save: 'Spotify에 저장',
      saving: '저장 중…',
      savedOpen: '저장됨 · Spotify에서 열기',
      replaced: '플레이리스트를 새 결과로 갱신했어요.',
    },
    errors: {
      notFound: '큐레이션을 찾지 못했어요.',
      spotifyFailed: 'Spotify 호출에 실패했어요. 잠시 후 다시 시도해주세요.',
      unknown: '저장 중 오류. 잠시 후 다시.',
    },
  },

  chat: {
    smallTalk:
      '음악 큐레이션을 도와드려요. "재즈 곡 뭐 있어?" 또는 "Tame Impala Elephant 같은 거 추천해줘" 같이 물어봐요.',
    listTopNotice: 'top 트랙 조회는 아직 준비 중이에요. 곧 추가할게요.',
    kinshipNotice: '친족 큐레이션은 곧 추가될 거예요.',
    error: '응답 처리 중 오류가 났어요. 잠시 후 다시 시도해주세요.',
    notAuth: '로그인이 필요해요.',
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
    syncRequired: {
      title: '먼저 라이브러리를 동기화해야 해요',
      body:
        '"요즘 자주 듣는 곡"이나 "잊고 있던 좋아한 곡"으로 추천을 받으려면 너의 좋아요·top·최근 재생 데이터가 필요해요. 설정에서 한 번만 눌러두면 그 다음부터는 바로 동작해요.',
      actionHref: '/settings',
      actionLabel: '설정 페이지로 이동',
      altBody:
        '또는 곡 이름을 직접 알려줘도 돼요. 예: "Radiohead Creep 같은 거".',
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
  sync_required: 'syncRequired',
  llm_failed: 'llmFailed',
  all_dropped: 'allDropped',
  unknown: 'unknown',
}
export function pipelineErrorFor(code: string) {
  const key = PIPELINE_BY_CURATOR_CODE[code] ?? 'unknown'
  return messages.pipeline[key]
}

export type AuthErrorCode = keyof typeof messages.auth.errors

export function authErrorMessage(code: string | null | undefined): string | null {
  if (!code) return null
  return (
    messages.auth.errors[code as AuthErrorCode] ?? messages.auth.errors.unknown
  )
}
