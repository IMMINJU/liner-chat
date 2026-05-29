import { NextRequest, NextResponse } from 'next/server'
import { runCuration, type CurateOk, type CurateResult } from '@/lib/curator'
import { classifyIntent } from '@/lib/intent'
import { listLibraryByGenre, type TrackCard } from '@/lib/library'
import { messages as m } from '@/lib/messages'
import { getUserSession } from '@/lib/session'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * Race envelope around runCuration. The curator has its own 45s hard cap,
 * but if for any reason that cap doesn't fire (e.g. an unhandled SDK retry
 * loop), this guarantees /api/chat returns *something* before Vercel's 60s
 * function timeout kicks in. The 50s budget leaves a little headroom for the
 * intent + JSON serialization on either side.
 */
const CHAT_HARD_CAP_MS = 50_000

async function withChatCap(
  work: Promise<CurateResult>
): Promise<CurateResult> {
  const cap = new Promise<CurateResult>((resolve) =>
    setTimeout(
      () =>
        resolve({
          ok: false,
          code: 'llm_failed',
          message: `chat exceeded ${CHAT_HARD_CAP_MS}ms (route cap)`,
        }),
      CHAT_HARD_CAP_MS
    )
  )
  return Promise.race([work, cap])
}

type ChatRequest = { message: string }

export type ChatResponse =
  | {
      kind: 'library_filter'
      genres: string[]
      tracks: TrackCard[]
      count: number
      computed: number
      skipped: number
      notice?: string
    }
  | (Omit<CurateOk, 'ok'> & { kind: 'kinship_curate' })
  | { kind: 'kinship_curate_failed'; code: string; message: string }
  | { kind: 'list_top'; notice: string }
  | { kind: 'small_talk'; notice: string }
  | { kind: 'error'; error: string }

export async function POST(req: NextRequest) {
  const session = await getUserSession()
  if (!session) {
    return NextResponse.json<ChatResponse>(
      { kind: 'error', error: m.chat.notAuth },
      { status: 401 }
    )
  }

  let body: ChatRequest
  try {
    body = (await req.json()) as ChatRequest
  } catch {
    return NextResponse.json<ChatResponse>(
      { kind: 'error', error: m.chat.error },
      { status: 400 }
    )
  }

  const text = (body.message ?? '').trim()
  if (!text) {
    return NextResponse.json<ChatResponse>(
      { kind: 'error', error: m.chat.emptyInput },
      { status: 400 }
    )
  }

  try {
    const tIntent = Date.now()
    const intent = await classifyIntent(text)
    console.log(
      `[chat] classifyIntent ${Date.now() - tIntent}ms kind=${intent.kind}`
    )

    switch (intent.kind) {
      case 'library_filter': {
        const result = await listLibraryByGenre({
          userId: session.userId,
          genres: intent.genres,
          minScore: intent.min_score,
          limit: intent.limit,
        })
        const notice =
          result.skipped > 0 ? m.library.partial(result.skipped) : undefined
        return NextResponse.json<ChatResponse>({
          kind: 'library_filter',
          genres: intent.genres,
          tracks: result.tracks,
          count: result.count,
          computed: result.computed,
          skipped: result.skipped,
          notice,
        })
      }
      case 'kinship_curate': {
        console.log(
          `[chat] kinship_curate seed=${JSON.stringify(intent.seed)}`
        )
        const result = await withChatCap(
          runCuration({
            userId: session.userId,
            query: text,
            seed: intent.seed,
          })
        )
        if (!result.ok) {
          return NextResponse.json<ChatResponse>({
            kind: 'kinship_curate_failed',
            code: result.code,
            message: result.message,
          })
        }
        const { ok: _ok, ...rest } = result
        void _ok
        return NextResponse.json<ChatResponse>({
          kind: 'kinship_curate',
          ...rest,
        })
      }
      case 'list_top':
        return NextResponse.json<ChatResponse>({
          kind: 'list_top',
          notice: m.chat.listTopNotice,
        })
      case 'small_talk':
      default:
        return NextResponse.json<ChatResponse>({
          kind: 'small_talk',
          notice: m.chat.smallTalk,
        })
    }
  } catch (err) {
    return NextResponse.json<ChatResponse>(
      {
        kind: 'error',
        error:
          m.chat.error +
          ' (' +
          (err instanceof Error ? err.message : String(err)) +
          ')',
      },
      { status: 500 }
    )
  }
}
