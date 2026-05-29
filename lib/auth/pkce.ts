import { randomBytes, createHash } from 'node:crypto'

function base64url(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

export function generateCodeVerifier(): string {
  // 64 bytes → base64url ≈ 86 chars. PKCE spec: 43~128 chars high-entropy.
  return base64url(randomBytes(64))
}

export function generateCodeChallenge(verifier: string): string {
  return base64url(createHash('sha256').update(verifier).digest())
}

export function generateState(): string {
  return randomBytes(32).toString('hex')
}
