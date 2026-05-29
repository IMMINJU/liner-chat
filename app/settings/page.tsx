import { count, desc, eq } from 'drizzle-orm'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { db } from '@/db/client'
import {
  artists,
  curations,
  likedTracks,
  plays,
  topTracks,
  tracks,
} from '@/db/schema'
import { SyncButton } from '@/components/SyncButton'
import { formatAbsKst, formatRelativeKo } from '@/lib/format'
import { messages as m } from '@/lib/messages'
import { getUserSession } from '@/lib/session'

export const dynamic = 'force-dynamic'

export default async function SettingsPage() {
  const session = await getUserSession()
  if (!session) redirect('/')

  const [
    likedCount,
    tracksCount,
    lastSnapshot,
    lastPlay,
    recentCurations,
  ] = await Promise.all([
    db
      .select({ c: count() })
      .from(likedTracks)
      .where(eq(likedTracks.userId, session.userId))
      .then((r) => r[0]?.c ?? 0),
    db
      .select({ c: count() })
      .from(tracks)
      .then((r) => r[0]?.c ?? 0),
    db
      .select({ snapshotAt: topTracks.snapshotAt })
      .from(topTracks)
      .where(eq(topTracks.userId, session.userId))
      .orderBy(desc(topTracks.snapshotAt))
      .limit(1)
      .then((r) => r[0]?.snapshotAt ?? null),
    db
      .select({ playedAt: plays.playedAt })
      .from(plays)
      .where(eq(plays.userId, session.userId))
      .orderBy(desc(plays.playedAt))
      .limit(1)
      .then((r) => r[0]?.playedAt ?? null),
    db
      .select({
        id: curations.id,
        createdAt: curations.createdAt,
        trackName: tracks.name,
        artistName: artists.name,
        coverUrl: tracks.albumCoverUrl,
      })
      .from(curations)
      .innerJoin(tracks, eq(curations.seedTrackId, tracks.id))
      .innerJoin(artists, eq(tracks.artistId, artists.id))
      .where(eq(curations.userId, session.userId))
      .orderBy(desc(curations.createdAt))
      .limit(5),
  ])

  return (
    <main className="min-h-screen px-8 py-8 max-w-[1200px] mx-auto">
      <div className="mb-16">
        <Link
          href="/"
          className="font-mono text-sm text-[color:var(--muted-foreground)] hover:text-[color:var(--foreground)] transition-colors"
        >
          ← {m.app.title}
        </Link>
      </div>

      <div className="max-w-3xl space-y-12">
        <h1
          className="font-serif"
          style={{
            fontSize: 'clamp(36px, 4vw, 48px)',
            lineHeight: '1.2',
          }}
        >
          Library
        </h1>

        <div className="space-y-6">
          <div className="font-mono text-sm text-[color:var(--muted-foreground)]">
            Last sync:{' '}
            {lastSnapshot ? formatAbsKst(lastSnapshot) : 'Never synced.'}
          </div>

          <div className="font-mono text-sm text-[color:var(--foreground)] space-x-4">
            <span>liked {likedCount.toLocaleString()}</span>
            <span className="text-[color:var(--muted-foreground)]">·</span>
            <span>tracks {tracksCount.toLocaleString()}</span>
            {lastPlay ? (
              <>
                <span className="text-[color:var(--muted-foreground)]">·</span>
                <span>last played {formatRelativeKo(lastPlay)}</span>
              </>
            ) : null}
          </div>

          <SyncButton />
        </div>

        {recentCurations.length > 0 ? (
          <div className="pt-8 border-t border-[color:var(--border)]">
            <h3 className="font-mono uppercase tracking-wider text-xs text-[color:var(--muted-foreground)] mb-6">
              Recent diggings
            </h3>
            <div className="space-y-3">
              {recentCurations.map((c) => (
                <Link
                  key={c.id}
                  href={`/curations/${c.id}`}
                  className="flex items-center justify-between gap-4 hover:text-[color:var(--accent)] transition-colors group"
                >
                  <div className="flex items-center gap-4 min-w-0">
                    {c.coverUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={c.coverUrl}
                        alt=""
                        width={40}
                        height={40}
                        loading="lazy"
                        className="shrink-0 block"
                        style={{
                          width: 40,
                          height: 40,
                          objectFit: 'cover',
                        }}
                      />
                    ) : (
                      <div
                        className="shrink-0"
                        style={{
                          width: 40,
                          height: 40,
                          background: 'rgba(244,239,230,0.05)',
                        }}
                      />
                    )}
                    <div className="flex items-baseline gap-4 min-w-0">
                      <span
                        className="font-serif group-hover:text-[color:var(--accent)] transition-colors truncate"
                        style={{ fontSize: '18px' }}
                      >
                        {c.trackName}
                      </span>
                      <span className="font-mono text-xs text-[color:var(--muted-foreground)] truncate">
                        {c.artistName}
                      </span>
                    </div>
                  </div>
                  <span className="font-mono text-xs text-[color:var(--muted-foreground)] shrink-0">
                    {formatRelativeKo(c.createdAt)}
                  </span>
                </Link>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </main>
  )
}
