import { and, asc, eq } from 'drizzle-orm'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { db } from '@/db/client'
import { artists, curationTracks, curations, tracks } from '@/db/schema'
import { Breadcrumb } from '@/components/Breadcrumb'
import { DiggingProvider } from '@/components/DiggingProvider'
import { TrackCard } from '@/components/TrackCard'
import { compressForBreadcrumb, loadAncestry } from '@/lib/ancestry'
import { formatAbsKst, stripMarkdownEmphasis } from '@/lib/format'
import { messages as m } from '@/lib/messages'
import { LOCAL_USER } from '@/lib/localUser'

export const dynamic = 'force-dynamic'

const CATEGORY_ORDER = ['influence', 'peer', 'descendant', 'kinship'] as const
type CategoryKey = (typeof CATEGORY_ORDER)[number]

type RecRow = {
  trackId: string
  trackName: string
  artist: string
  album: string | null
  release: string | null
  spotifyUrl: string | null
  previewUrl: string | null
  category: string
  sonicLink: string
  linkDimensions: string[]
  position: number
}

const CATEGORY_HEADERS_EN: Record<CategoryKey, string> = {
  influence: 'INFLUENCES',
  peer: 'CONTEMPORARIES',
  descendant: 'DESCENDANTS',
  kinship: 'KINSHIP',
}

function SectionRule() {
  return (
    <div
      className="h-px flex-1"
      style={{
        background:
          'linear-gradient(to right, var(--border), transparent)',
      }}
    />
  )
}

export default async function CurationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id: rawId } = await params
  const id = Number(rawId)
  if (!Number.isFinite(id)) notFound()

  const head = await db
    .select()
    .from(curations)
    .where(and(eq(curations.id, id), eq(curations.userId, LOCAL_USER)))
    .limit(1)
  const curation = head[0]
  if (!curation) notFound()

  const [seedRowsP, recRowsP, ancestorsP] = await Promise.all([
    db
      .select({
        id: tracks.id,
        name: tracks.name,
        artist: artists.name,
        album: tracks.album,
        release: tracks.albumReleaseDate,
        coverUrl: tracks.albumCoverUrl,
        spotifyUrl: tracks.spotifyUrl,
        previewUrl: tracks.previewUrl,
      })
      .from(tracks)
      .innerJoin(artists, eq(tracks.artistId, artists.id))
      .where(eq(tracks.id, curation.seedTrackId))
      .limit(1),
    db
      .select({
        trackId: tracks.id,
        trackName: tracks.name,
        artist: artists.name,
        album: tracks.album,
        release: tracks.albumReleaseDate,
        spotifyUrl: tracks.spotifyUrl,
        previewUrl: tracks.previewUrl,
        category: curationTracks.category,
        sonicLink: curationTracks.sonicLink,
        linkDimensions: curationTracks.linkDimensions,
        position: curationTracks.position,
      })
      .from(curationTracks)
      .innerJoin(tracks, eq(curationTracks.trackId, tracks.id))
      .innerJoin(artists, eq(tracks.artistId, artists.id))
      .where(eq(curationTracks.curationId, id))
      .orderBy(asc(curationTracks.position)),
    loadAncestry(id, LOCAL_USER),
  ])
  const seed = seedRowsP[0]
  const recRows: RecRow[] = recRowsP

  const grouped: Record<CategoryKey, RecRow[]> = {
    influence: [],
    peer: [],
    descendant: [],
    kinship: [],
  }
  for (const r of recRows) {
    if (r.category in grouped) grouped[r.category as CategoryKey].push(r)
  }

  const crumbs = compressForBreadcrumb(ancestorsP)
  const seedYear = seed?.release ? Number(seed.release.slice(0, 4)) : null

  return (
    <main className="min-h-screen px-8 py-8 max-w-[1200px] mx-auto">
      <div className="flex justify-between items-center gap-4 mb-12 flex-wrap">
        <Link
          href="/"
          className="font-mono text-sm text-[color:var(--muted-foreground)] hover:text-[color:var(--foreground)] transition-colors"
        >
          ← {m.app.title}
        </Link>
      </div>

      <Breadcrumb
        crumbs={crumbs}
        currentLabel={seed ? `${seed.artist} — ${seed.name}` : `#${id}`}
      />


      <DiggingProvider>
        {/* Seed hero — album cover (when present) + title block side by side.
            Falls back to a text-only hero when the cover URL is missing, so
            tracks added before the album_cover_url column existed still
            render gracefully. */}
        <section className="mb-16 space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-end gap-6">
            {seed?.coverUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={seed.coverUrl}
                alt={`${seed.album ?? seed.name} cover`}
                width={220}
                height={220}
                loading="eager"
                className="shrink-0 block"
                style={{
                  width: 'clamp(160px, 22vw, 220px)',
                  height: 'clamp(160px, 22vw, 220px)',
                  objectFit: 'cover',
                  boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
                }}
              />
            ) : null}
            <div className="min-w-0">
              <h1
                className="font-display mb-2"
                style={{
                  fontSize: 'clamp(48px, 5vw, 72px)',
                  lineHeight: '1.1',
                }}
              >
                {seed?.name ?? '—'}
              </h1>
              {seed ? (
                <>
                  <div className="font-mono uppercase tracking-widest text-sm text-[color:var(--muted-foreground)] mb-2">
                    {seed.artist}
                  </div>
                  <div className="font-mono text-xs text-[color:var(--muted-foreground)]">
                    {seed.album ?? '—'}
                    {seedYear ? ` · ${seedYear}` : ''}
                  </div>
                </>
              ) : null}
            </div>
          </div>

          {curation.lineageNotes ? (
            <blockquote
              className="font-korean-serif italic pl-6 border-l border-[color:var(--muted-foreground)]/30"
              style={{
                fontSize: '24px',
                lineHeight: '1.55',
                color: 'rgba(244, 239, 230, 0.85)',
                maxWidth: '800px',
              }}
            >
              {stripMarkdownEmphasis(curation.lineageNotes)}
            </blockquote>
          ) : null}
        </section>

        {/* Category sections */}
        <div className="space-y-16 mb-16">
          {CATEGORY_ORDER.map((cat) => {
            const items = grouped[cat]
            if (items.length === 0) return null
            const isKinship = cat === 'kinship'
            return (
              <section key={cat} className="space-y-8">
                <div className="space-y-2">
                  {isKinship ? (
                    <div
                      className="font-serif italic text-sm"
                      style={{ color: 'rgba(244, 239, 230, 0.7)' }}
                    >
                      the crossing
                    </div>
                  ) : null}
                  <div className="flex items-center gap-4">
                    <h2 className="font-mono uppercase tracking-widest text-xs text-[color:var(--muted-foreground)] whitespace-nowrap">
                      {m.curation.categories[cat]} ·{' '}
                      <span className="font-mono">
                        {CATEGORY_HEADERS_EN[cat]} {items.length}
                      </span>
                    </h2>
                    <SectionRule />
                  </div>
                </div>

                <div className="space-y-8">
                  {items.map((r) => (
                    <TrackCard
                      key={r.trackId}
                      id={r.trackId}
                      name={r.trackName}
                      artist={r.artist}
                      album={r.album}
                      year={r.release ? Number(r.release.slice(0, 4)) : null}
                      spotifyUrl={r.spotifyUrl}
                      previewUrl={r.previewUrl}
                      sonicLink={r.sonicLink}
                      linkDimensions={r.linkDimensions}
                      showDigDeeper
                      parentCurationId={id}
                    />
                  ))}
                </div>
              </section>
            )
          })}
        </div>
      </DiggingProvider>

      <footer className="font-mono text-xs text-[color:var(--muted-foreground)] text-center py-8 border-t border-[color:var(--border)]">
        curation #{curation.id} · {formatAbsKst(curation.createdAt)}
      </footer>
    </main>
  )
}
