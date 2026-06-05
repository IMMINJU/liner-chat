import { desc, eq } from 'drizzle-orm'
import Link from 'next/link'
import { db } from '@/db/client'
import { artists, curations, tracks } from '@/db/schema'
import { HomeChat } from '@/components/HomeChat'
import { formatRelativeKo } from '@/lib/format'
import { LOCAL_USER } from '@/lib/localUser'

export const dynamic = 'force-dynamic'

export default async function Home() {
  const recentCurations = await db
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
    .where(eq(curations.userId, LOCAL_USER))
    .orderBy(desc(curations.createdAt))
    .limit(5)

  return (
    <main className="min-h-screen px-8 py-8 max-w-[1440px] mx-auto">
      <div className="flex justify-between items-start mb-16">
        <div className="font-mono uppercase tracking-widest text-sm text-[color:var(--muted-foreground)]">
          LINER <span style={{ color: 'var(--spotify-green)' }}>·</span> CHAT
        </div>
      </div>

      <div className="max-w-4xl mx-auto space-y-12">
        <HomeChat />

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
