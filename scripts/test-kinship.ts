/**
 * scripts/test-kinship.ts — call recommendKinship() directly for the 5
 * canonical seeds. Bypasses Spotify auth / library lookup / verify. Only
 * exercises the LLM path so we can sanity-check the prompt + schema.
 *
 * Run with:  pnpm tsx scripts/test-kinship.ts
 * Requires:  ANTHROPIC_API_KEY
 */
import { recommendKinship, type SeedContext } from '@/lib/kinship'

const SEEDS: SeedContext[] = [
  {
    track: { name: 'Elephant', artist: 'Tame Impala', album: 'Lonerism', year: 2012 },
    spotifyGenres: ['psychedelic rock', 'neo-psychedelia'],
    lastfmTrackTags: ['psychedelic', 'rock', 'indie', 'tame impala'],
    lastfmArtistTags: ['psychedelic rock', 'indie', 'neo-psychedelia', 'australian'],
    audio: { energy: 0.84, valence: 0.32, tempo: 100, acousticness: 0.02 },
    tonal: { key: 'A', mode: 'major', time_signature: 4 },
    listenerProfile: { seedPopularity: 65, librarySophistication: 'mixed' },
  },
  {
    track: { name: 'God Save the Queen', artist: 'Sex Pistols', album: 'Never Mind the Bollocks', year: 1977 },
    spotifyGenres: ['punk', 'punk rock'],
    lastfmTrackTags: ['punk', 'punk rock', '70s'],
    lastfmArtistTags: ['punk', 'punk rock', '70s', 'british'],
    audio: { energy: 0.9, valence: 0.5, tempo: 168 },
    tonal: { key: 'A', mode: 'major', time_signature: 4 },
    listenerProfile: { seedPopularity: 60, librarySophistication: 'mixed' },
  },
  {
    track: { name: 'L.A. Woman', artist: 'The Doors', album: 'L.A. Woman', year: 1971 },
    spotifyGenres: ['psychedelic rock', 'classic rock', 'blues rock'],
    lastfmTrackTags: ['classic rock', 'rock', '70s'],
    lastfmArtistTags: ['classic rock', 'psychedelic rock', '60s', 'rock'],
    audio: { energy: 0.85, valence: 0.6, tempo: 117 },
    tonal: { key: 'A', mode: 'minor', time_signature: 4 },
    listenerProfile: { seedPopularity: 70, librarySophistication: 'mixed' },
  },
  {
    track: { name: 'Sultans of Swing', artist: 'Dire Straits', album: 'Dire Straits', year: 1978 },
    spotifyGenres: ['rock', 'classic rock'],
    lastfmTrackTags: ['classic rock', 'rock', '70s', 'guitar'],
    lastfmArtistTags: ['classic rock', 'rock', '70s', 'british'],
    audio: { energy: 0.6, valence: 0.55, tempo: 147 },
    tonal: { key: 'D', mode: 'minor', time_signature: 4 },
    listenerProfile: { seedPopularity: 75, librarySophistication: 'mixed' },
  },
  {
    track: { name: 'Creep', artist: 'Radiohead', album: 'Pablo Honey', year: 1993 },
    spotifyGenres: ['alternative rock', 'rock'],
    lastfmTrackTags: ['alternative', 'rock', '90s', 'radiohead'],
    lastfmArtistTags: ['alternative rock', 'rock', 'experimental', 'british'],
    audio: { energy: 0.5, valence: 0.1, tempo: 92 },
    tonal: { key: 'G', mode: 'major', time_signature: 4 },
    listenerProfile: { seedPopularity: 88, librarySophistication: 'obscure' },
  },
]

async function main() {
  for (const ctx of SEEDS) {
    console.log('\n========================================')
    console.log(`SEED: "${ctx.track.name}" by ${ctx.track.artist} (${ctx.track.year})`)
    console.log(`listener: ${ctx.listenerProfile.librarySophistication} / seedPop ${ctx.listenerProfile.seedPopularity}`)
    console.log('========================================')
    try {
      const resp = await recommendKinship(ctx)
      console.log('\nlineage_notes:', resp.lineage_notes)
      const byCat: Record<string, typeof resp.tracks> = {
        influence: [],
        peer: [],
        descendant: [],
        kinship: [],
      }
      for (const t of resp.tracks) byCat[t.category].push(t)
      for (const cat of ['influence', 'peer', 'descendant', 'kinship'] as const) {
        console.log(`\n[${cat}] (${byCat[cat].length})`)
        for (const t of byCat[cat]) {
          console.log(
            `  - ${t.artist} "${t.track}" (${t.album}, ${t.year}) [${t.link_dimensions.join('/')}]`
          )
          console.log(`      ${t.sonic_link}`)
        }
      }
    } catch (err) {
      console.error('FAILED:', err)
    }
  }
}

void main()
