'use client'

import { useState } from 'react'
import { messages as m } from '@/lib/messages'

type Saved = {
  playlistId: string
  spotifyUrl: string
  isReplace: boolean
  trackCount: number
}

export function SavePlaylistButton({
  curationId,
  initialSaved,
}: {
  curationId: number
  initialSaved?: { spotifyUrl: string } | null
}) {
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState<Saved | null>(
    initialSaved
      ? {
          playlistId: '',
          spotifyUrl: initialSaved.spotifyUrl,
          isReplace: true,
          trackCount: 0,
        }
      : null
  )
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  async function run() {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const res = await fetch('/api/playlist/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ curation_id: curationId }),
      })
      const data = (await res.json()) as
        | (Saved & { ok: true })
        | { ok: false; code: string; message: string }
      if (!data.ok) {
        setError(data.message)
        return
      }
      setSaved({
        playlistId: data.playlistId,
        spotifyUrl: data.spotifyUrl,
        isReplace: data.isReplace,
        trackCount: data.trackCount,
      })
      if (data.isReplace) setNotice(m.playlist.actions.replaced)
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  if (saved) {
    return (
      <div className="flex flex-col items-end gap-1">
        <div className="font-mono text-xs text-[color:var(--muted-foreground)]">
          Saved ·{' '}
          <a
            href={saved.spotifyUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="transition-colors hover:opacity-80"
            style={{ color: 'var(--spotify-green)' }}
          >
            Open in Spotify ↗
          </a>
        </div>
        <button
          type="button"
          onClick={run}
          disabled={busy}
          className="font-mono text-[10px] text-[color:var(--muted-foreground)] hover:text-[color:var(--foreground)] disabled:opacity-50"
        >
          {busy ? m.playlist.actions.saving : 'resync playlist'}
        </button>
        {notice ? (
          <span className="font-korean-sans text-[10px] text-[color:var(--muted-foreground)]">
            {notice}
          </span>
        ) : null}
        {error ? (
          <span
            className="font-korean-sans text-[10px]"
            style={{ color: 'var(--film-red)' }}
          >
            {error}
          </span>
        ) : null}
      </div>
    )
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={run}
        disabled={busy}
        className="font-mono px-6 py-2.5 rounded-full text-sm transition-all hover:opacity-90 disabled:opacity-50"
        style={{
          backgroundColor: 'var(--spotify-green)',
          color: '#000',
        }}
      >
        {busy ? m.playlist.actions.saving : m.playlist.actions.save}
      </button>
      {error ? (
        <span
          className="font-korean-sans text-[10px]"
          style={{ color: 'var(--film-red)' }}
        >
          {error}
        </span>
      ) : null}
    </div>
  )
}
