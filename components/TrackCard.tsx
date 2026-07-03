import { stripMarkdownEmphasis } from '@/lib/format'
import { messages as m } from '@/lib/messages'
import { DigDeeperButton } from './DigDeeperButton'

export type TrackCardProps = {
  id: string
  name: string
  artist: string
  album: string | null
  year: number | null
  spotifyUrl: string | null
  previewUrl: string | null
  sonicLink?: string
  linkDimensions?: string[]
  /** Render the "🔍 이걸로 더 파보기" button (digging chain) */
  showDigDeeper?: boolean
  /** Curation id of THIS card's containing page, becomes parent in the chain. */
  parentCurationId?: number
}

function dimensionLabel(d: string): string {
  return (
    m.curation.linkDimensionLabels[
      d as keyof typeof m.curation.linkDimensionLabels
    ] ?? d
  )
}

/**
 * Embedded Spotify player. Premium users get the full track, Free users get
 * the 30s preview. We use `theme=0` (dark) so the iframe blends with our
 * canvas instead of dropping a bright white widget into the editorial layout.
 * Lazy loading keeps Spotify's bundle off the critical path of curation
 * detail pages with 9+ cards.
 */
function SpotifyEmbed({ trackId }: { trackId: string }) {
  const src = `https://open.spotify.com/embed/track/${trackId}?utm_source=generator&theme=0`
  return (
    <iframe
      title={`Spotify player for track ${trackId}`}
      src={src}
      width="100%"
      height={80}
      style={{ border: 0, borderRadius: 8 }}
      allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
      loading="lazy"
    />
  )
}

export function TrackCard(props: TrackCardProps) {
  // previewUrl is preserved on the props for now (some flows may still pass it
  // for non-Spotify-embed contexts), but the canonical playback UI on this
  // page is the embedded player. Suppress the unused-prop warning explicitly.
  void props.previewUrl

  return (
    <article className="space-y-4 pb-8 border-b border-[color:var(--border)]/50 last:border-b-0">
      <header className="space-y-2">
        <h3
          className="font-serif leading-tight"
          style={{
            fontSize: 'clamp(22px, 2vw, 28px)',
            lineHeight: '1.2',
          }}
        >
          {props.name}
        </h3>
        <div className="font-mono uppercase tracking-widest text-xs text-[color:var(--muted-foreground)]">
          {props.artist}
        </div>
        <div className="font-mono text-xs text-[color:var(--muted-foreground)]">
          {props.album ?? '—'}
          {props.year ? ` · ${props.year}` : ''}
        </div>
      </header>

      {props.sonicLink ? (
        <p
          className="font-korean-serif italic leading-relaxed"
          style={{
            fontSize: 'clamp(15px, 1.5vw, 18px)',
            lineHeight: '1.55',
            color: 'rgba(201, 166, 93, 0.9)',
          }}
        >
          {stripMarkdownEmphasis(props.sonicLink)}
        </p>
      ) : null}

      {props.linkDimensions && props.linkDimensions.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {props.linkDimensions.map((d) => (
            <span
              key={d}
              className="font-korean-sans px-3 py-1.5 rounded-full border text-xs"
              style={{
                borderColor: 'rgba(59, 107, 115, 0.5)',
                color: 'rgba(244, 239, 230, 0.8)',
              }}
            >
              {dimensionLabel(d)}
            </span>
          ))}
        </div>
      ) : null}

      <SpotifyEmbed trackId={props.id} />

      <div className="flex items-center gap-4 pt-2 flex-wrap">
        {props.spotifyUrl ? (
          <a
            href={props.spotifyUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono text-xs transition-colors hover:opacity-80"
            style={{ color: 'var(--spotify-green)' }}
          >
            Open in Spotify ↗
          </a>
        ) : null}

        {props.showDigDeeper ? (
          <DigDeeperButton
            trackId={props.id}
            parentCurationId={props.parentCurationId}
          />
        ) : null}
      </div>
    </article>
  )
}
