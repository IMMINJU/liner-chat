import { ImageResponse } from 'next/og'

/**
 * Apple touch icon — iOS home screen, Safari pinned tab, share sheets.
 * Same composition as the favicon at 180px so the glyph reads as a poster
 * frame rather than a tiny tab marker.
 */
export const size = { width: 180, height: 180 }
export const contentType = 'image/png'

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#0B0B0E',
          color: '#F4EFE6',
          fontFamily: 'serif',
          letterSpacing: '-0.02em',
          position: 'relative',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 130,
            fontWeight: 400,
            lineHeight: 1,
            paddingBottom: 6,
          }}
        >
          L
        </div>
        <div
          style={{
            position: 'absolute',
            bottom: 18,
            display: 'flex',
            fontSize: 11,
            fontFamily: 'monospace',
            letterSpacing: '0.18em',
            color: 'rgba(244, 239, 230, 0.55)',
          }}
        >
          LINER · CHAT
        </div>
      </div>
    ),
    size
  )
}
