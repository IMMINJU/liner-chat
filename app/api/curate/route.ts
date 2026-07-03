import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import {
  runCuration,
  type CurateResult,
  type CurationSeedInput,
} from '@/lib/curator'

export const dynamic = 'force-dynamic'
// Fluid Compute raises the Hobby ceiling to 300s; 120s is plenty of headroom
// for the curator's full retry + supplement path while staying inside the cap.
// Keep this in lockstep with app/api/chat/route.ts.
export const maxDuration = 120

const SeedSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('track_id'), track_id: z.string().min(1) }),
  z.object({
    type: z.literal('track_text'),
    track_query: z.string().min(1),
    // 아티스트/제목 경계가 확실할 때만 — 시드 해석의 필드필터 tier 활성화.
    artist_hint: z.string().min(1).optional(),
    track_hint: z.string().min(1).optional(),
  }),
])

const RequestSchema = z.object({
  seed: SeedSchema,
  query: z.string().optional(),
  parent_curation_id: z.number().int().nullable().optional(),
})

export async function POST(req: NextRequest) {
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
