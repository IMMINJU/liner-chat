/**
 * The fixed enum of genre keys our scoring & queries use. Adding a new key
 * requires touching: this file, intent-prompt tool enum, intent zod schema,
 * messages, and (optionally) UI labels.
 */
export const GENRE_KEYS = [
  'jazz',
  'classical',
  'rock',
  'pop',
  'electronic',
  'hip_hop',
  'r_n_b',
  'folk',
  'country',
  'metal',
  'punk',
  'indie',
  'soul',
  'blues',
  'funk',
  'reggae',
  'latin',
  'world',
  'ambient',
  'experimental',
] as const

export type GenreKey = (typeof GENRE_KEYS)[number]

/**
 * Raw-tag patterns (lowercased) that count as that genre when seen in either
 * Spotify artist genres or Last.fm tags. Match is exact OR includes — see
 * matchesGenre() below. Recall over precision; raw_tags are stored for
 * debugging.
 */
export const GENRE_TAG_PATTERNS: Record<GenreKey, string[]> = {
  jazz: [
    'jazz', 'jazz fusion', 'vocal jazz', 'bebop', 'swing', 'cool jazz',
    'smooth jazz', 'modal jazz', 'free jazz', 'hard bop', 'big band',
    'jazz piano', 'jazz vocal', 'nu jazz', 'jazz funk', 'spiritual jazz',
    'contemporary jazz', 'crossover jazz', 'avant-garde jazz',
    'acid jazz', 'jazz rap',
  ],
  classical: [
    'classical', 'baroque', 'romantic', 'opera', 'classical piano',
    'orchestral', 'contemporary classical', 'minimalism', 'symphony',
    'string quartet', 'chamber music', 'choral', 'classical crossover',
    'neo-classical', 'art music', 'piano sonata',
  ],
  rock: [
    'rock', 'classic rock', 'hard rock', 'soft rock', 'psychedelic rock',
    'progressive rock', 'art rock', 'garage rock', 'alternative rock',
    'indie rock', 'glam rock', 'southern rock', 'roots rock',
    'rock and roll', "rock 'n' roll",
  ],
  pop: [
    'pop', 'art pop', 'dream pop', 'synth pop', 'electropop', 'indie pop',
    'k-pop', 'j-pop', 'dance pop', 'baroque pop', 'chamber pop', 'noise pop',
    'twee pop',
  ],
  electronic: [
    'electronic', 'electronica', 'idm', 'techno', 'house', 'deep house',
    'tech house', 'trance', 'edm', 'dubstep', 'drum and bass', 'dnb',
    'glitch', 'downtempo', 'trip-hop', 'trip hop', 'breakbeat',
    'big beat', 'minimal techno',
  ],
  hip_hop: [
    'hip hop', 'hip-hop', 'rap', 'trap', 'boom bap', 'conscious hip hop',
    'east coast hip hop', 'west coast hip hop', 'underground hip hop',
    'gangsta rap', 'g-funk', 'crunk', 'drill', 'cloud rap', 'mumble rap',
  ],
  r_n_b: [
    'r&b', 'rnb', 'r and b', 'rhythm and blues', 'neo soul', 'neo-soul',
    'contemporary r&b', 'alternative r&b', 'pbr&b',
  ],
  folk: [
    'folk', 'indie folk', 'folk rock', 'contemporary folk',
    'traditional folk', 'singer-songwriter', 'acoustic',
    'americana', 'freak folk', 'anti-folk',
  ],
  country: [
    'country', 'classic country', 'country rock', 'alt country',
    'alternative country', 'outlaw country', 'country folk', 'bluegrass',
    'honky tonk', 'nashville sound', 'country pop',
  ],
  metal: [
    'metal', 'heavy metal', 'thrash metal', 'death metal', 'black metal',
    'doom metal', 'power metal', 'progressive metal', 'nu metal',
    'metalcore', 'sludge metal', 'stoner metal',
  ],
  punk: [
    'punk', 'punk rock', 'post-punk', 'hardcore punk', 'pop punk',
    'art punk', 'proto-punk', 'anarcho-punk', 'no wave',
  ],
  indie: [
    'indie', 'indie rock', 'indie pop', 'indie folk', 'indietronica',
    'lo-fi', 'lo fi', 'bedroom pop',
  ],
  soul: [
    'soul', 'classic soul', 'northern soul', 'southern soul', 'deep soul',
    'philadelphia soul', 'memphis soul', 'blue-eyed soul', 'psychedelic soul',
  ],
  blues: [
    'blues', 'electric blues', 'delta blues', 'chicago blues',
    'blues rock', 'rhythm blues', 'piedmont blues', 'jump blues',
  ],
  funk: [
    'funk', 'p-funk', 'g-funk', 'funk rock', 'jazz funk', 'electro funk',
    'acid funk', 'soul funk',
  ],
  reggae: [
    'reggae', 'roots reggae', 'dub', 'dancehall', 'ska', 'rocksteady',
    'reggaeton',
  ],
  latin: [
    'latin', 'latin pop', 'latin rock', 'latin jazz', 'salsa', 'bossa nova',
    'samba', 'mpb', 'cumbia', 'tango', 'merengue', 'bachata',
  ],
  world: [
    'world', 'world music', 'afrobeat', 'afrobeats', 'gqom', 'amapiano',
    'k-trad', 'gugak', 'qawwali', 'flamenco', 'fado', 'celtic',
    'highlife', 'soukous',
  ],
  ambient: [
    'ambient', 'dark ambient', 'drone', 'ambient electronic',
    'space ambient', 'new age', 'environmental',
  ],
  experimental: [
    'experimental', 'avant-garde', 'avant garde', 'noise',
    'sound collage', 'musique concrete', 'free improvisation',
  ],
}

function normalize(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, ' ')
}

/**
 * Does a raw tag string match the given genre? Match is "exact" OR "contains"
 * against one of the genre's patterns. Recall first.
 */
export function tagMatchesGenre(rawTag: string, genre: GenreKey): boolean {
  const n = normalize(rawTag)
  const patterns = GENRE_TAG_PATTERNS[genre]
  for (const p of patterns) {
    const np = normalize(p)
    if (n === np || n.includes(np)) return true
  }
  return false
}
