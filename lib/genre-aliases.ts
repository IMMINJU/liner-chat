import type { GenreKey } from './genre-dictionary'
import { GENRE_KEYS } from './genre-dictionary'

/**
 * Korean (or short-form) phrases that map to a canonical GenreKey.
 * Keep keys lowercase. Multi-word phrases allowed.
 */
const ALIASES: Record<string, GenreKey> = {
  // Korean
  '재즈': 'jazz',
  '클래식': 'classical',
  '클래시컬': 'classical',
  '록': 'rock',
  '락': 'rock',
  '록앤롤': 'rock',
  '팝': 'pop',
  '일렉': 'electronic',
  '일렉트로닉': 'electronic',
  '일렉트로니카': 'electronic',
  '힙합': 'hip_hop',
  '힙팝': 'hip_hop',
  '랩': 'hip_hop',
  '알엔비': 'r_n_b',
  '알앤비': 'r_n_b',
  'rnb': 'r_n_b',
  'r&b': 'r_n_b',
  '소울': 'soul',
  '포크': 'folk',
  '컨트리': 'country',
  '컨츄리': 'country',
  '메탈': 'metal',
  '펑크 록': 'punk',
  '펑크록': 'punk',
  '인디': 'indie',
  '블루스': 'blues',
  '훵크': 'funk',
  '펑키': 'funk',
  '레게': 'reggae',
  '라틴': 'latin',
  '월드': 'world',
  '월드뮤직': 'world',
  '앰비언트': 'ambient',
  '실험적': 'experimental',
  '아방가르드': 'experimental',
}

// Note: '펑크' alone is ambiguous (funk vs punk in Korean transliteration).
// We deliberately do NOT map bare '펑크' here — let context / LLM decide.

function normalize(s: string): string {
  return s.toLowerCase().trim()
}

/**
 * Scan free-form Korean (or English) text and extract any genre keys that
 * appear via alias matching or by literal English key occurrence.
 * Returns deduplicated, ordered by first appearance.
 */
export function extractGenresFromText(text: string): GenreKey[] {
  const n = normalize(text)
  const found: GenreKey[] = []
  const seen = new Set<GenreKey>()

  function maybeAdd(key: GenreKey) {
    if (!seen.has(key)) {
      found.push(key)
      seen.add(key)
    }
  }

  // Direct English key occurrence
  for (const k of GENRE_KEYS) {
    const needle = k.replace(/_/g, ' ')
    if (n.includes(needle)) maybeAdd(k)
  }
  // Korean / alt aliases
  for (const [alias, key] of Object.entries(ALIASES)) {
    if (n.includes(normalize(alias))) maybeAdd(key)
  }
  return found
}
