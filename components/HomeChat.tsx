'use client'

import Link from 'next/link'
import { useRef, useState, type FormEvent } from 'react'
import type { ChatResponse } from '@/app/api/chat/route'
import { messages as m, pipelineErrorFor } from '@/lib/messages'

type SeedChip = { label: string; query: string }

// Chips trigger the curation flow. They're worded as plain "추천" requests so
// the intent classifier doesn't mistake them for a library listing question.
// We deliberately avoid the internal "친족 / kinship" jargon in user-facing
// copy — the value is what they hear, not how we labeled the category.
const SEED_CHIPS: SeedChip[] = [
  {
    label: '요즘 듣는 곡과 비슷한 음악 추천',
    query: '요즘 자주 듣는 곡과 비슷한 새로운 음악 추천해줘',
  },
  {
    label: '잊고 있던 곡 같은 음악 추천',
    query: '잊고 있던 좋아한 곡 같은 새로운 음악 추천해줘',
  },
  {
    label: '특정 곡 같은 거 추천',
    query: '',
  },
]

export function HomeChat({ displayName }: { displayName: string }) {
  const [query, setQuery] = useState('')
  const [response, setResponse] = useState<ChatResponse | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  async function send(text: string) {
    if (!text.trim() || busy) return
    setBusy(true)
    setError(null)
    setResponse(null)
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }),
      })
      const data = (await res.json()) as ChatResponse
      if (data.kind === 'error') {
        setError(data.error)
      } else {
        setResponse(data)
      }
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    void send(query)
  }

  return (
    <>
      <h1
        className="mb-8 font-display"
        style={{ fontSize: 'clamp(48px, 6vw, 72px)', lineHeight: '1.1' }}
      >
        Where do we dig today, {displayName}?
      </h1>

      <form onSubmit={onSubmit} className="space-y-6">
        <div className="relative">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="곡 이름과 아티스트를 적어줘 — e.g., Tame Impala 'Elephant'"
            // Focus underline switches to Spotify green to signal that
            // hitting Enter sends the question to Spotify-anchored flow.
            // That's one of the few places green is allowed off the
            // action buttons, per the design rule in CLAUDE.md.
            className="font-mono italic w-full bg-transparent border-b border-[color:var(--border)] pb-3 text-base text-[color:var(--foreground)] placeholder:text-[color:var(--muted-foreground)] focus:outline-none focus:border-[color:var(--spotify-green)] transition-colors"
            disabled={busy}
          />
          {busy ? (
            <div className="absolute right-0 top-1 font-mono text-xs text-[color:var(--muted-foreground)]">
              thinking…
            </div>
          ) : null}
        </div>

        <div className="flex gap-3 flex-wrap">
          {SEED_CHIPS.map((chip) => (
            <button
              key={chip.label}
              type="button"
              onClick={() => {
                // Empty query = "let me type the seed myself" chip — focus
                // the input instead of firing a no-op send.
                if (!chip.query) {
                  inputRef.current?.focus()
                  return
                }
                setQuery(chip.query)
                void send(chip.query)
              }}
              disabled={busy}
              className="font-korean-sans px-4 py-2 rounded-full border border-[color:var(--border)] text-xs hover:border-[color:var(--foreground)] transition-colors disabled:opacity-50"
            >
              {chip.label}
            </button>
          ))}
        </div>
      </form>

      {error ? (
        <div
          className="font-korean-sans mt-8 border-l-2 px-4 py-3 text-sm"
          style={{
            borderColor: 'var(--film-red)',
            backgroundColor: 'rgba(161, 52, 42, 0.1)',
            color: 'var(--foreground)',
          }}
        >
          {error}
        </div>
      ) : null}

      {response ? (
        <div className="pt-8 space-y-8">
          {response.kind === 'kinship_curate' ? (
            <div className="bg-[color:var(--card)] p-8 rounded border border-[color:var(--border)]">
              <blockquote
                className="font-korean-serif italic leading-relaxed mb-6"
                style={{
                  fontSize: '24px',
                  lineHeight: '1.55',
                  color: 'rgba(244, 239, 230, 0.9)',
                }}
              >
                {response.lineage_notes}
              </blockquote>
              <Link
                href={`/curations/${response.curationId}`}
                className="font-mono text-sm hover:text-[color:var(--accent)] transition-colors"
              >
                → 결과 보기
              </Link>
            </div>
          ) : null}

          {response.kind === 'kinship_curate_failed'
            ? (() => {
                const copy = pipelineErrorFor(response.code)
                // `altBody`/`actionHref` exist only on richer entries (e.g.
                // syncRequired). Cast in a narrowing way so TypeScript stays
                // happy without forcing every entry to share the same shape.
                const altBody = (copy as { altBody?: string }).altBody
                const actionHref = (copy as { actionHref?: string }).actionHref
                const actionLabel = (copy as { actionLabel?: string })
                  .actionLabel
                return (
                  <div
                    className="border-l-2 px-5 py-4 space-y-3"
                    style={{
                      borderColor: 'var(--film-red)',
                      backgroundColor: 'rgba(161, 52, 42, 0.08)',
                    }}
                  >
                    <div
                      className="font-korean-sans text-sm"
                      style={{ color: 'var(--foreground)' }}
                    >
                      {copy.title}
                    </div>
                    <p className="font-korean-sans text-sm leading-relaxed text-[color:var(--muted-foreground)]">
                      {copy.body}
                    </p>
                    {actionHref && actionLabel ? (
                      <Link
                        href={actionHref}
                        className="font-mono text-xs underline-offset-2 hover:underline"
                        style={{ color: 'var(--accent)' }}
                      >
                        → {actionLabel}
                      </Link>
                    ) : null}
                    {altBody ? (
                      <p className="font-korean-sans text-xs text-[color:var(--muted-foreground)] pt-1">
                        {altBody}
                      </p>
                    ) : null}
                  </div>
                )
              })()
            : null}

          {response.kind === 'library_filter' ? (
            <div className="space-y-6">
              <div className="flex items-baseline gap-4 flex-wrap">
                <span
                  className="font-serif italic"
                  style={{ fontSize: '18px' }}
                >
                  내 라이브러리 · {response.genres.join(', ')}
                </span>
                <span className="font-mono text-xs text-[color:var(--muted-foreground)]">
                  {m.library.countSummary(
                    response.count,
                    response.tracks.length,
                    response.computed
                  )}
                </span>
              </div>

              {response.notice ? (
                <div className="font-mono text-xs text-[color:var(--muted-foreground)]">
                  {response.notice}
                </div>
              ) : null}

              {response.tracks.length === 0 ? (
                <div className="font-serif italic text-[color:var(--muted-foreground)]">
                  {m.library.empty(response.genres)}
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {response.tracks.map((t) => (
                    <div
                      key={t.id}
                      className="p-4 bg-[color:var(--card)] rounded border border-[color:var(--border)] space-y-2"
                    >
                      <div
                        className="font-serif leading-tight"
                        style={{ fontSize: '18px' }}
                      >
                        {t.name}
                      </div>
                      <div className="font-mono text-xs uppercase tracking-wider text-[color:var(--muted-foreground)]">
                        {t.artist}
                      </div>
                      <div className="font-mono text-xs text-[color:var(--muted-foreground)]">
                        {t.album ?? '—'}
                        {t.year ? ` · ${t.year}` : ''}
                      </div>
                      {t.spotifyUrl ? (
                        <a
                          href={t.spotifyUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-mono text-xs text-[color:var(--foreground)] hover:text-[color:var(--accent)] transition-colors inline-block"
                          style={{ color: 'var(--spotify-green)' }}
                        >
                          Open in Spotify ↗
                        </a>
                      ) : null}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : null}

          {response.kind === 'list_top' ? (
            <div className="font-mono text-sm text-[color:var(--muted-foreground)]">
              {response.notice}
            </div>
          ) : null}

          {response.kind === 'small_talk' ? (
            <div className="font-korean-sans text-sm text-[color:var(--muted-foreground)]">
              {response.notice}
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  )
}
