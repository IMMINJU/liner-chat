import { ImageResponse } from 'next/og'

/**
 * Browser-tab favicon. Rendered at build time to a static asset.
 *
 * Liner Chat identity: a single display-serif `L` in warm off-white over
 * near-black, matching the page palette. The glyph stays legible down to
 * 16px in real browser chrome.
 */
export const size = { width: 32, height: 32 }
export const contentType = 'image/png'

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#0B0B0E',
          color: '#F4EFE6',
          fontFamily: 'serif',
          fontSize: 26,
          fontWeight: 400,
          // Optical centering — descenderless caps sit slightly low otherwise.
          paddingBottom: 2,
          letterSpacing: '-0.02em',
        }}
      >
        L
      </div>
    ),
    size
  )
}
