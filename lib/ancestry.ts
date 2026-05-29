import { eq, inArray } from 'drizzle-orm'
import { db } from '@/db/client'
import { artists, curations, tracks } from '@/db/schema'

export type AncestorNode = {
  curationId: number
  seedLabel: string // "Artist — Track"
}

const MAX_HOPS = 50

/**
 * Returns the chain root → … → direct parent of `curationId`. Does NOT
 * include `curationId` itself. Aborts if any ancestor is owned by a
 * different user (security guard). Empty when no parent.
 */
export async function loadAncestry(
  curationId: number,
  userId: string
): Promise<AncestorNode[]> {
  // First get the parent of the starting node.
  const startRow = await db
    .select({ parentId: curations.parentCurationId, userId: curations.userId })
    .from(curations)
    .where(eq(curations.id, curationId))
    .limit(1)
  const start = startRow[0]
  if (!start || start.userId !== userId || start.parentId === null) return []

  type AncestorRow = {
    id: number
    seedTrackId: string
    parentId: number | null
    userId: string
  }
  const chain: { id: number; seedTrackId: string }[] = []
  let curId: number | null = start.parentId
  let hops = 0
  while (curId !== null && hops < MAX_HOPS) {
    const row: AncestorRow[] = await db
      .select({
        id: curations.id,
        seedTrackId: curations.seedTrackId,
        parentId: curations.parentCurationId,
        userId: curations.userId,
      })
      .from(curations)
      .where(eq(curations.id, curId))
      .limit(1)
    const r: AncestorRow | undefined = row[0]
    if (!r || r.userId !== userId) break
    chain.unshift({ id: r.id, seedTrackId: r.seedTrackId })
    curId = r.parentId ?? null
    hops++
  }
  if (chain.length === 0) return []

  // Resolve seed labels in one go.
  const trackIds = chain.map((c) => c.seedTrackId)
  const seedRows = await db
    .select({
      trackId: tracks.id,
      track: tracks.name,
      artist: artists.name,
    })
    .from(tracks)
    .innerJoin(artists, eq(tracks.artistId, artists.id))
    .where(
      trackIds.length === 1
        ? eq(tracks.id, trackIds[0])
        : inArray(tracks.id, trackIds)
    )
  const labelByTrack = new Map(
    seedRows.map((r) => [r.trackId, `${r.artist} — ${r.track}`])
  )

  return chain.map((c) => ({
    curationId: c.id,
    seedLabel: labelByTrack.get(c.seedTrackId) ?? '?',
  }))
}

/**
 * Compress an ancestry list for breadcrumb display:
 *   - length ≤ 4 → return as-is
 *   - length ≥ 5 → keep root + last 3, mark a gap between them.
 */
export type DisplayCrumb =
  | { kind: 'node'; curationId: number; seedLabel: string }
  | { kind: 'gap' }

export function compressForBreadcrumb(
  ancestors: AncestorNode[]
): DisplayCrumb[] {
  if (ancestors.length <= 4) {
    return ancestors.map((a) => ({
      kind: 'node',
      curationId: a.curationId,
      seedLabel: a.seedLabel,
    }))
  }
  const root = ancestors[0]
  const tail = ancestors.slice(-3)
  return [
    { kind: 'node', curationId: root.curationId, seedLabel: root.seedLabel },
    { kind: 'gap' },
    ...tail.map((a) => ({
      kind: 'node' as const,
      curationId: a.curationId,
      seedLabel: a.seedLabel,
    })),
  ]
}
