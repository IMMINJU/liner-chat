import type { Metadata, Viewport } from 'next'
import {
  DM_Serif_Display,
  Inter,
  JetBrains_Mono,
  Noto_Sans_KR,
  Noto_Serif_KR,
  Playfair_Display,
} from 'next/font/google'
import './globals.css'

/*
 * next/font emits each `--font-*` variable as a single family name plus a
 * generic. The `fallback` option only inserts plain strings — they have to
 * already exist on the user's OS, so writing `fallback: ['Noto Sans KR']`
 * is a dead reference: the browser doesn't know that name maps to the
 * font we actually loaded via Noto_Sans_KR(), since next/font uses a
 * hashed family name. Hangul therefore fell through to the OS default
 * (Malgun Gothic on Windows = the rounded face).
 *
 * The fix: in the inline style block further down (the `:root` override)
 * we set `--font-mono` / `--font-sans` / etc to a chain that includes the
 * *real* hashed names from the Korean next/font objects (`.style.fontFamily`).
 * That makes the chained Korean family resolve to a font the browser
 * actually has loaded.
 */
const display = DM_Serif_Display({
  variable: '--font-display',
  weight: '400',
  subsets: ['latin'],
  display: 'swap',
})
const serif = Playfair_Display({
  variable: '--font-serif',
  weight: ['400'],
  style: ['normal', 'italic'],
  subsets: ['latin'],
  display: 'swap',
})
const sans = Inter({
  variable: '--font-sans',
  weight: ['400', '500', '600'],
  subsets: ['latin'],
  display: 'swap',
})
const mono = JetBrains_Mono({
  variable: '--font-mono',
  weight: ['400', '500'],
  subsets: ['latin'],
  display: 'swap',
})
const koreanSerif = Noto_Serif_KR({
  variable: '--font-korean-serif',
  weight: ['400', '500'],
  subsets: ['latin'],
  display: 'swap',
})
const koreanSans = Noto_Sans_KR({
  variable: '--font-korean-sans',
  weight: ['400'],
  subsets: ['latin'],
  display: 'swap',
})

const SITE = {
  title: 'Liner Chat',
  description:
    '내 Spotify 라이브러리 위에서 한 곡의 음악적 계보(liner notes)를 따라가며 친족을 디깅하는 대화형 큐레이터.',
  url: 'https://liner-chat.vercel.app',
} as const

export const metadata: Metadata = {
  // metadataBase resolves relative URLs in openGraph.images / twitter.images
  // so the dynamically-generated /opengraph-image.png gets an absolute URL
  // when crawlers fetch it.
  metadataBase: new URL(SITE.url),
  title: {
    default: SITE.title,
    template: '%s · Liner Chat',
  },
  description: SITE.description,
  applicationName: SITE.title,
  authors: [{ name: 'minju' }],
  keywords: [
    'Spotify',
    'music curation',
    'kinship',
    'liner notes',
    'digging',
    'recommendation',
    '큐레이션',
    '음악',
  ],
  openGraph: {
    type: 'website',
    siteName: SITE.title,
    title: SITE.title,
    description: SITE.description,
    url: SITE.url,
    locale: 'ko_KR',
    // opengraph-image.tsx is picked up automatically; no explicit images entry
    // needed, but keeping a fallback alt for crawlers that ignore the file:
  },
  twitter: {
    card: 'summary_large_image',
    title: SITE.title,
    description: SITE.description,
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-image-preview': 'large',
      'max-snippet': -1,
    },
  },
  alternates: {
    canonical: SITE.url,
  },
  formatDetection: {
    telephone: false,
    address: false,
    email: false,
  },
}

// `viewportFit: 'cover'` lets the page paint behind iOS notches; combined
// with the safe-area paddings in globals.css and the dvh-based min-heights,
// the address bar collapsing/expanding on mobile no longer clips content.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#0B0B0E',
}

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // Override each --font-* variable with a chain that puts the Latin family
  // first and the *real* hashed Korean family second. `.style.fontFamily`
  // gives us the actual loaded name (e.g. `__Noto_Sans_KR_335abd86`), which
  // is what the browser knows about. Generic fallback (serif/sans/monospace)
  // closes the chain. Inline style avoids editing globals.css to reference
  // values that only exist at module evaluation time.
  const fontOverrides = `:root {
    --font-display: ${display.style.fontFamily}, ${koreanSerif.style.fontFamily}, serif;
    --font-serif: ${serif.style.fontFamily}, ${koreanSerif.style.fontFamily}, serif;
    --font-sans: ${sans.style.fontFamily}, ${koreanSans.style.fontFamily}, sans-serif;
    --font-mono: ${mono.style.fontFamily}, ${koreanSans.style.fontFamily}, monospace;
    --font-korean-serif: ${koreanSerif.style.fontFamily}, serif;
    --font-korean-sans: ${koreanSans.style.fontFamily}, sans-serif;
  }`

  return (
    <html
      lang="ko"
      className={[
        display.variable,
        serif.variable,
        sans.variable,
        mono.variable,
        koreanSerif.variable,
        koreanSans.variable,
        'h-full antialiased',
      ].join(' ')}
    >
      <head>
        <style dangerouslySetInnerHTML={{ __html: fontOverrides }} />
      </head>
      <body className="min-h-full">{children}</body>
    </html>
  )
}
