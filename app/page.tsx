import { desc, eq } from 'drizzle-orm'
import Link from 'next/link'
import { db } from '@/db/client'
import { artists, curations, tracks, users } from '@/db/schema'
import { HomeChat } from '@/components/HomeChat'
import { formatRelativeKo } from '@/lib/format'
import { authErrorMessage, messages as m } from '@/lib/messages'
import { getUserSession } from '@/lib/session'

export const dynamic = 'force-dynamic'

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ auth_error?: string }>
}) {
  const params = await searchParams
  const errorMessage = authErrorMessage(params.auth_error)

  const session = await getUserSession()

  if (!session) {
    return (
      <main className="min-h-screen flex flex-col items-center justify-center px-8 relative">
        <div className="absolute top-8 left-8 font-mono uppercase tracking-widest text-sm text-[color:var(--muted-foreground)]">
          LINER <span style={{ color: 'var(--spotify-green)' }}>·</span> CHAT
        </div>

        {errorMessage ? (
          <div
            className="font-korean-sans absolute top-20 left-8 right-8 max-w-md mx-auto border-l-2 px-4 py-3 text-sm"
            style={{
              borderColor: 'var(--film-red)',
              backgroundColor: 'rgba(161, 52, 42, 0.1)',
              color: 'var(--foreground)',
            }}
          >
            {errorMessage}
          </div>
        ) : null}

        <div className="max-w-3xl w-full text-center space-y-8">
          <h1
            className="font-display"
            style={{
              fontSize: 'clamp(56px, 8vw, 80px)',
              lineHeight: '1.1',
            }}
          >
            Follow the kinship.
            <br />
            Across genre, era, country.
          </h1>

          <div className="flex justify-center">
            <a
              href="/api/auth/login"
              className="font-mono px-8 py-3 rounded-full text-sm transition-all hover:opacity-90"
              style={{
                backgroundColor: 'var(--spotify-green)',
                color: '#000',
              }}
            >
              Continue with Spotify
            </a>
          </div>
        </div>

        <div
          className="absolute left-8 font-mono text-xs text-[color:var(--muted-foreground)]"
          style={{ bottom: 'max(2rem, env(safe-area-inset-bottom))' }}
        >
          {m.auth.actions.hint}
        </div>
      </main>
    )
  }

  const [displayNameRow, recentCurations] = await Promise.all([
    db
      .select({ name: users.displayName })
      .from(users)
      .where(eq(users.id, session.userId))
      .limit(1),
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
  const displayName = displayNameRow[0]?.name ?? session.userId

  return (
    <main className="min-h-screen px-8 py-8 max-w-[1440px] mx-auto">
      <div className="flex justify-between items-start mb-16">
        <div className="font-mono uppercase tracking-widest text-sm text-[color:var(--muted-foreground)]">
          LINER <span style={{ color: 'var(--spotify-green)' }}>·</span> CHAT
        </div>
        <div className="font-mono text-sm flex items-center gap-4">
          <Link
            href="/settings"
            className="text-[color:var(--muted-foreground)] hover:text-[color:var(--foreground)] transition-colors"
          >
            settings
          </Link>
          <span className="text-[color:var(--muted-foreground)]">{displayName}</span>
          <form action="/api/auth/logout" method="post" className="contents">
            <button
              type="submit"
              className="text-[color:var(--foreground)] hover:text-[color:var(--muted-foreground)] transition-colors"
            >
              logout
            </button>
          </form>
        </div>
      </div>

      {errorMessage ? (
        <div
          className="font-korean-sans mb-12 border-l-2 px-4 py-3 text-sm max-w-4xl mx-auto"
          style={{
            borderColor: 'var(--film-red)',
            backgroundColor: 'rgba(161, 52, 42, 0.1)',
            color: 'var(--foreground)',
          }}
        >
          {errorMessage}
        </div>
      ) : null}

      <div className="max-w-4xl mx-auto space-y-12">
        <HomeChat displayName={displayName} />

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
