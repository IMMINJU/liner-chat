import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import {
  runCuration,
  type CurateResult,
  type CurationSeedInput,
} from '@/lib/curator'
import { messages as m } from '@/lib/messages'
import { getUserSession } from '@/lib/session'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const SeedSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('track_id'), track_id: z.string().min(1) }),
  z.object({ type: z.literal('track_text'), track_query: z.string().min(1) }),
  z.object({ type: z.literal('auto_top_recent') }),
  z.object({ type: z.literal('auto_dormant_liked') }),
])

const RequestSchema = z.object({
  seed: SeedSchema,
  query: z.string().optional(),
  parent_curation_id: z.number().int().nullable().optional(),
})

export async function POST(req: NextRequest) {
  const session = await getUserSession()
  if (!session) {
    return NextResponse.json(
      { ok: false, code: 'unauth', message: m.chat.notAuth },
      { status: 401 }
    )
  }

  let body: z.infer<typeof RequestSchema>
  try {
    body = RequestSchema.parse(await req.json())
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        code: 'bad_request',
        message: err instanceof Error ? err.message : 'invalid request',
      },
      { status: 400 }
    )
  }

  try {
    const result: CurateResult = await runCuration({
      userId: session.userId,
      query: body.query ?? null,
      seed: body.seed as CurationSeedInput,
      parentCurationId: body.parent_curation_id ?? null,
    })
    return NextResponse.json(result, { status: 200 })
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        code: 'unknown',
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 }
    )
  }
}
