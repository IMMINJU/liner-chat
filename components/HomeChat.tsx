'use client'

import Link from 'next/link'
import { useRef, useState, type FormEvent } from 'react'
import type { ChatResponse } from '@/app/api/chat/route'
import { messages as m, pipelineErrorFor } from '@/lib/messages'

// Category render order for the recommendation thumbnails in the summary card.
// kinship last because it's "the crossing" payoff. Matches the detail page.
const CATEGORY_ORDER = ['influence', 'peer', 'descendant', 'kinship'] as const

type SeedChip = { label: string; query: string }

// Chips pre-fill the input with example seeds. Login-less mode only supports
// track-seeded curation (no library), so every chip names a concrete song.
// We deliberately avoid the internal "친족 / kinship" jargon in user-facing
// copy — the value is what they hear, not how we labeled the category.
const SEED_CHIPS: SeedChip[] = [
  {
    label: "Tame Impala 'Elephant' 같은 거",
    query: "Tame Impala Elephant 같은 거 추천해줘",
  },
  {
    label: "The Doors 'L.A. Woman' 같은 거",
    query: "The Doors L.A. Woman 같은 거 추천해줘",
  },
  {
    label: '직접 곡 적기',
    query: '',
  },
]

export function HomeChat() {
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
        Where do we dig today?
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

              <div className="space-y-6 mb-8">
                {CATEGORY_ORDER.map((cat) => {
                  const items = response.categories[cat]
                  if (!items || items.length === 0) return null
                  return (
                    <div key={cat} className="space-y-2">
                      <div className="font-mono uppercase tracking-widest text-[10px] text-[color:var(--muted-foreground)]">
                        {m.curation.categories[cat]}
                      </div>
                      <div className="space-y-2">
                        {items.map((t) => (
                          <div key={t.id} className="flex items-center gap-3">
                            {t.coverUrl ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                src={t.coverUrl}
                                alt=""
                                width={44}
                                height={44}
                                loading="lazy"
                                className="shrink-0 block"
                                style={{
                                  width: 44,
                                  height: 44,
                                  objectFit: 'cover',
                                }}
                              />
                            ) : (
                              <div
                                className="shrink-0"
                                style={{
                                  width: 44,
                                  height: 44,
                                  background: 'rgba(244,239,230,0.05)',
                                }}
                              />
                            )}
                            <div className="flex items-baseline gap-3 min-w-0">
                              <span
                                className="font-serif truncate"
                                style={{ fontSize: '16px' }}
                              >
                                {t.name}
                              </span>
                              <span className="font-mono text-xs text-[color:var(--muted-foreground)] truncate">
                                {t.artist}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )
                })}
              </div>

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
