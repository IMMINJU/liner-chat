'use client'

import { useState } from 'react'
import { messages as m } from '@/lib/messages'
import type { SyncResult } from '@/lib/spotify/sync/runSync'

const STAGE_LABEL: Record<string, string> = {
  liked: 'Liked tracks',
  top: 'Top tracks',
  recently: 'Recently played',
  artists: 'Artist genres',
}

export function SyncButton() {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<SyncResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function run() {
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const res = await fetch('/api/sync', { method: 'POST' })
      const data = await res.json()
      if (res.status === 401) {
        setError(m.sync.errors.notAuth)
      } else if (!res.ok && data && 'ok' in data && data.ok === false) {
        setResult(data as SyncResult)
      } else if (data?.error) {
        setError(data.error)
      } else {
        setResult(data as SyncResult)
      }
    } catch (e) {
      setError(m.sync.errors.unknown + ' (' + String(e) + ')')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <button
        type="button"
        onClick={run}
        disabled={busy}
        className="font-mono px-6 py-2.5 rounded-full text-sm transition-all hover:opacity-90 disabled:opacity-50"
        style={{ backgroundColor: 'var(--spotify-green)', color: '#000' }}
      >
        {busy ? m.sync.running : m.sync.runButton}
      </button>

      {busy ? (
        <div className="font-mono text-sm text-[color:var(--muted-foreground)]">
          Syncing… (~25s)
        </div>
      ) : null}

      {error ? (
        <div
          className="font-korean-sans border-l-2 px-4 py-3 text-sm"
          style={{
            borderColor: 'var(--film-red)',
            backgroundColor: 'rgba(161, 52, 42, 0.1)',
            color: 'var(--foreground)',
          }}
        >
          {error}
        </div>
      ) : null}

      {result && result.ok ? (
        <div className="font-mono text-sm text-[color:var(--foreground)] space-y-1">
          <div>
            ✓ Liked tracks synced ·{' '}
            <span className="text-[color:var(--muted-foreground)]">
              +{result.liked.added} / {result.liked.total}
            </span>
          </div>
          <div>
            ✓ Top tracks synced ·{' '}
            <span className="text-[color:var(--muted-foreground)]">
              {result.top.short_term +
                result.top.medium_term +
                result.top.long_term}
            </span>
          </div>
          <div>
            ✓ Recently played ·{' '}
            <span className="text-[color:var(--muted-foreground)]">
              +{result.recently.inserted}
            </span>
          </div>
          <div>
            ✓ Artist genres ·{' '}
            <span className="text-[color:var(--muted-foreground)]">
              +{result.artists.enriched}
            </span>
          </div>
          <div className="text-[color:var(--muted-foreground)] text-xs pt-1">
            {result.durationMs}ms
          </div>
        </div>
      ) : null}

      {result && !result.ok ? (
        <div
          className="border-l-2 px-4 py-3 font-mono text-sm space-y-1"
          style={{
            borderColor: 'var(--film-red)',
            backgroundColor: 'rgba(161, 52, 42, 0.1)',
          }}
        >
          {(['liked', 'top', 'recently', 'artists'] as const).map(
            (stage) => {
              const ok = stage in (result.partial as object)
              const failed = result.failedStages.includes(stage)
              if (!ok && !failed) return null
              return (
                <div
                  key={stage}
                  style={{
                    color: failed
                      ? 'var(--film-red)'
                      : 'var(--foreground)',
                  }}
                >
                  {failed ? '✗' : '✓'} {STAGE_LABEL[stage]}
                </div>
              )
            }
          )}
          {result.errors.length > 0 ? (
            <div className="pt-2 text-xs text-[color:var(--muted-foreground)] font-korean-sans">
              {result.errors.map((e, i) => (
                <div key={i}>
                  {e.stage}: {e.message}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
