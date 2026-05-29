import { NextResponse } from 'next/server'
import { runSync } from '@/lib/spotify/sync/runSync'
import { messages } from '@/lib/messages'
import { getUserSession } from '@/lib/session'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function POST() {
  const session = await getUserSession()
  if (!session) {
    return NextResponse.json(
      { ok: false, error: messages.sync.errors.notAuth },
      { status: 401 }
    )
  }

  try {
    const result = await runSync(session.userId)
    return NextResponse.json(result, { status: result.ok ? 200 : 207 })
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: messages.sync.errors.unknown,
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 500 }
    )
  }
}
