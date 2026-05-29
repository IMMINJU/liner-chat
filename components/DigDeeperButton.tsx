'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { messages as m } from '@/lib/messages'
import { useDigging } from './DiggingProvider'

/**
 * Triggers a new curation seeded with the given trackId and navigates to its
 * detail page. Uses the page-level DiggingProvider context so only one card
 * in the page can be actively digging at a time.
 */
export function DigDeeperButton({
  trackId,
  parentCurationId,
}: {
  trackId: string
  parentCurationId?: number
}) {
  const router = useRouter()
  const { busyTrackId, begin, end } = useDigging()
  const [error, setError] = useState<string | null>(null)

  const myBusy = busyTrackId === trackId
  const lockedByOther = busyTrackId !== null && busyTrackId !== trackId

  async function run() {
    setError(null)
    begin(trackId)
    try {
      const res = await fetch('/api/curate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          seed: { type: 'track_id', track_id: trackId },
          parent_curation_id: parentCurationId ?? null,
        }),
      })
      const data = (await res.json()) as
        | { ok: true; curationId: number }
        | { ok: false; code: string; message: string }
      if (!('ok' in data) || data.ok === false) {
        setError('message' in data ? data.message : '실패')
        end()
        return
      }
      router.push(`/curations/${data.curationId}`)
    } catch (e) {
      setError(String(e))
      end()
    }
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={run}
        disabled={myBusy || lockedByOther}
        className="font-mono px-4 py-2 rounded-full border border-[color:var(--border)] text-xs transition-all hover:border-[color:var(--foreground)] disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:border-[color:var(--border)]"
        title={lockedByOther ? '다른 카드 진행 중' : undefined}
      >
        {myBusy ? 'DIGGING…' : m.curation.actions.digDeeper}
      </button>
      {error ? (
        <span className="font-korean-sans text-[10px]" style={{ color: 'var(--film-red)' }}>
          {error}
        </span>
      ) : null}
    </div>
  )
}
