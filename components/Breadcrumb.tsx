import Link from 'next/link'
import type { DisplayCrumb } from '@/lib/ancestry'

/**
 * Mono editorial breadcrumb for the digging chain.
 * The "current" segment is rendered emphasized (not a link).
 */
export function Breadcrumb({
  crumbs,
  currentLabel,
}: {
  crumbs: DisplayCrumb[]
  currentLabel: string
}) {
  if (crumbs.length === 0) return null
  return (
    <nav className="font-mono text-xs text-[color:var(--muted-foreground)] flex items-center gap-2 flex-wrap mb-8">
      {crumbs.map((c, i) => (
        <span key={i} className="flex items-center gap-2">
          {c.kind === 'gap' ? (
            <span className="text-[color:var(--muted-foreground)]/50">…</span>
          ) : (
            <Link
              href={`/curations/${c.curationId}`}
              className="hover:text-[color:var(--foreground)] transition-colors"
            >
              {c.seedLabel}
            </Link>
          )}
          <span className="text-[color:var(--muted-foreground)]/50">›</span>
        </span>
      ))}
      <span className="text-[color:var(--foreground)]">{currentLabel}</span>
    </nav>
  )
}
