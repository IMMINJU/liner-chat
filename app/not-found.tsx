import Link from 'next/link'
import { messages as m } from '@/lib/messages'

export default function NotFound() {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center px-8 space-y-8">
      <h1
        className="font-display"
        style={{
          fontSize: 'clamp(120px, 15vw, 200px)',
          lineHeight: '1',
          letterSpacing: '-0.02em',
        }}
      >
        404
      </h1>

      <p className="font-korean-sans text-sm text-[color:var(--muted-foreground)]">
        {m.curation.notFound ?? '해당 페이지를 찾지 못했어요.'}
      </p>

      <Link
        href="/"
        className="font-mono text-sm text-[color:var(--foreground)] hover:text-[color:var(--accent)] transition-colors"
      >
        ← {m.app.title}
      </Link>
    </main>
  )
}
