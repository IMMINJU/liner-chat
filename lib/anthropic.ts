import Anthropic from '@anthropic-ai/sdk'
import { env } from './env'

let cached: Anthropic | null = null

/*
 * Anthropic's SDK defaults to a 10-minute timeout AND retries 2x on 5xx /
 * overloaded by default. On Vercel Hobby (60s function cap) that combination
 * is catastrophic: a single slow Sonnet response can sit for the full 60s
 * before the platform 504s the function, and our typed-error catch never
 * gets to run. We compress both knobs:
 *   - timeout: 40s per request. The first pass at 25s was clipping live
 *     kinship calls — real Sonnet response time for the 4-category prompt
 *     hovers around 20-30s. 40s leaves the curator budget (resolve seed +
 *     context + verify + save ≈ 5-8s) inside 60s without flapping.
 *   - maxRetries: 0 (one slow call is bad; two is fatal).
 */
const REQUEST_TIMEOUT_MS = 40_000

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
