/**
 * Time-formatting helpers.
 *
 * All visible timestamps are rendered in Asia/Seoul (KST). The DB stores
 * timestamptz, the server runs in UTC, and Spotify timestamps come in as UTC
 * — so every visible timestamp must go through one of these helpers. Never
 * call `.toISOString()` or `.toLocaleString()` without an explicit timeZone
 * for user-facing text; toISOString() in particular strips the timezone and
 * makes UTC look like local time.
 *
 * Convention:
 *   - formatAbsKst(d)        — "2026-05-29 12:27 KST"  for snapshots / footers
 *   - formatRelativeKo(d)    — "방금 전" / "12분 전" / "어제" / "2026-05-29"
 *                              for "last played", "recent diggings", etc.
 */

/**
 * LLM 생성 텍스트(lineage_notes/sonic_link)의 마크다운 강조 마커 제거 —
 * Sonnet이 볼드("별표 2개로 감싼 텍스트")를 섞으면 UI가 플레인 텍스트로
 * 렌더해 별표가 그대로 노출된다. 짝 지어진 강조 마커만 벗긴다(*NSYNC처럼
 * 홑 별표는 이름의 일부일 수 있어 보존). 생성 시점(kinship.ts)과 렌더
 * 시점 양쪽에서 사용 — 렌더 쪽은 이미 저장된 과거 행까지 정리하기 위함.
 */
export function stripMarkdownEmphasis(s: string): string {
  return s.replace(/\*{1,2}([^*]+)\*{1,2}/g, '$1')
}

const KST = 'Asia/Seoul'

const ABS_FORMAT = new Intl.DateTimeFormat('ko-KR', {
  timeZone: KST,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

const DATE_FORMAT = new Intl.DateTimeFormat('ko-KR', {
  timeZone: KST,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

/**
 * Render an absolute KST timestamp. Format: "2026-05-29 12:27 KST".
 */
export function formatAbsKst(d: Date | string | null | undefined): string {
  if (d === null || d === undefined) return ''
  const date = typeof d === 'string' ? new Date(d) : d
  if (Number.isNaN(date.getTime())) return ''
  // Intl returns "2026. 05. 29. 12:27" in ko-KR — normalize the dots/spaces
  // into the more conventional "YYYY-MM-DD HH:mm" form.
  const parts = ABS_FORMAT.formatToParts(date)
  const get = (t: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === t)?.value ?? ''
  const y = get('year')
  const m = get('month')
  const day = get('day')
  const h = get('hour') || '00'
  const min = get('minute') || '00'
  return `${y}-${m}-${day} ${h}:${min} KST`
}

/** Date-only KST. Used in compact list rows. */
export function formatDateKst(d: Date | string | null | undefined): string {
  if (d === null || d === undefined) return ''
  const date = typeof d === 'string' ? new Date(d) : d
  if (Number.isNaN(date.getTime())) return ''
  const parts = DATE_FORMAT.formatToParts(date)
  const get = (t: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === t)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

/**
 * Korean relative time. Falls back to a KST date when the gap is larger than
 * about a week, since "12일 전" stops being useful quickly. Accepts a Date or
 * an ISO string; null/undefined returns "".
 */
export function formatRelativeKo(
  d: Date | string | null | undefined,
  now: Date = new Date()
): string {
  if (d === null || d === undefined) return ''
  const date = typeof d === 'string' ? new Date(d) : d
  if (Number.isNaN(date.getTime())) return ''
  const diffMs = now.getTime() - date.getTime()
  const sec = Math.floor(diffMs / 1000)
  if (sec < 0) return '곧'
  if (sec < 60) return '방금 전'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}분 전`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}시간 전`
  const day = Math.floor(hr / 24)
  if (day === 1) return '어제'
  if (day < 7) return `${day}일 전`
  return formatDateKst(date)
}
