import { ImageResponse } from 'next/og'

/**
 * Default OG image — used by every page that doesn't override it.
 * Composition mirrors the home hero: large display-serif headline left-
 * aligned over the near-black canvas, with the wordmark in mono caps.
 *
 * 1200×630 is the Open Graph standard (Facebook / LinkedIn / Slack /
 * Discord all assume this aspect). Twitter's summary_large_image also
 * accepts it.
 */
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'
export const alt = 'Liner Chat — 시드 곡 한 곡으로 음악적 친족을 따라가는 큐레이션.'

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: '64px 80px',
          background: '#0B0B0E',
          color: '#F4EFE6',
          fontFamily: 'serif',
          position: 'relative',
        }}
      >
        <div
          style={{
            display: 'flex',
            fontSize: 18,
            fontFamily: 'monospace',
            letterSpacing: '0.22em',
            color: 'rgba(244, 239, 230, 0.6)',
          }}
        >
          LINER · CHAT
        </div>

        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            fontSize: 96,
            lineHeight: 1.05,
            letterSpacing: '-0.015em',
            marginTop: 'auto',
            marginBottom: 'auto',
          }}
        >
          <span>Follow the kinship.</span>
          <span style={{ color: 'rgba(244, 239, 230, 0.72)' }}>
            Across genre, era, country.
          </span>
        </div>

        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'baseline',
            fontSize: 16,
            fontFamily: 'monospace',
            color: 'rgba(244, 239, 230, 0.45)',
          }}
        >
          <span>liner-chat.vercel.app</span>
          <span>by minju</span>
        </div>
      </div>
    ),
    size
  )
}
