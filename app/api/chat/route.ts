import { NextRequest, NextResponse } from 'next/server'
import { runCuration, type CurateOk, type CurateResult } from '@/lib/curator'
import { classifyIntent } from '@/lib/intent'
import { messages as m } from '@/lib/messages'

export const dynamic = 'force-dynamic'
// Fluid Compute raises the Hobby function ceiling from 60s to 300s. We don't
// need the full 300 — a healthy curation finishes in 25-40s — but the extra
// headroom lets the curator's retry + supplement passes run to completion
// instead of being guillotined mid-flight. 120s is a generous wall that's
// still well inside the platform cap, so a genuinely stuck call still gets a
// typed error rather than a raw 504.
export const maxDuration = 120

/**
 * Race envelope around runCuration. The curator has its own hard cap, but if
 * for any reason that cap doesn't fire (e.g. an unhandled SDK retry loop),
 * this guarantees /api/chat returns *something* before the platform function
 * timeout kicks in. Kept ~10s under maxDuration to leave room for intent
 * classification + JSON serialization on either side.
 */
const CHAT_HARD_CAP_MS = 110_000

async function withChatCap(work: Promise<CurateResult>): Promise<CurateResult> {
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
  | (Omit<CurateOk, 'ok'> & { kind: 'kinship_curate' })
  | { kind: 'kinship_curate_failed'; code: string; message: string }
  | { kind: 'small_talk'; notice: string }
  | { kind: 'error'; error: string }

export async function POST(req: NextRequest) {
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
      case 'kinship_curate': {
        console.log(`[chat] kinship_curate seed=${JSON.stringify(intent.seed)}`)
        const result = await withChatCap(
          runCuration({
            query: text,
            seed: intent.seed,
            depth: intent.depth,
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
