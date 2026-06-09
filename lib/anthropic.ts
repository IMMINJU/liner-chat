import Anthropic from '@anthropic-ai/sdk'
import { env } from './env'

let cached: Anthropic | null = null

/*
 * Anthropic's SDK defaults to a 10-minute timeout AND retries 2x on 5xx /
 * overloaded by default. The 10-minute default is far longer than any
 * function cap, and the 2x retry can stack two slow calls back-to-back, so we
 * still override both — but with Fluid Compute the function ceiling is now
 * 300s (was 60s on plain Hobby), so the per-request timeout no longer has to
 * be aggressively tight.
 *   - timeout: 90s per request. This is just the SDK-level backstop; the
 *     kinship path (lib/kinship.ts) wraps each call in its own, tighter
 *     AbortController, and intent (Haiku) is always fast. 90s only matters as
 *     the ceiling that keeps a wedged socket from hanging toward the platform
 *     cap.
 *   - maxRetries: 0 (one slow call is bad; two stacked is what used to bust
 *     the budget — keep retries off and let the curator decide on retries).
 */
const REQUEST_TIMEOUT_MS = 90_000

export function anthropic(): Anthropic {
  if (!cached) {
    cached = new Anthropic({
      apiKey: env.anthropicApiKey(),
      timeout: REQUEST_TIMEOUT_MS,
      maxRetries: 0,
    })
  }
  return cached
}

export const MODELS = {
  intent: 'claude-haiku-4-5',
  kinship: 'claude-sonnet-4-6',
} as const
