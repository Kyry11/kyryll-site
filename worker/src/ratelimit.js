/**
 * Rate limiting, backed by Workers KV.
 *
 * What this replaces: a `Map` in an Azure Function's process memory. That was
 * lost on every cold start and was never shared between instances, so the real
 * ceiling was (limit x live instances) and it reset whenever Azure recycled the
 * host. Its own documentation was candid that it stopped nothing but somebody
 * leaning on the Send button.
 *
 * KV is a genuine improvement — state survives isolate recycling and is shared
 * across colos — but it is emphatically not a distributed lock, and the honest
 * limits are:
 *
 *   - Reads are eventually consistent. A write in one colo can take up to about
 *     a minute to be visible in another, so a sender hitting several colos at
 *     once can exceed the limit for roughly that long.
 *   - Read-modify-write is not atomic. Two simultaneous requests can both read
 *     the same count and both write count+1, losing one.
 *   - It fails open. If KV is unavailable, or the account's daily write quota
 *     is exhausted, submissions are allowed rather than refused — a contact
 *     form that rejects everyone because a counter is down is a worse failure
 *     than one that briefly stops counting.
 *
 * The exact answer is a Cloudflare rate-limiting rule at the zone level, which
 * is enforced at the edge before the Worker runs and is not subject to any of
 * the above. This is the cheap in-Worker layer beneath it, not a substitute.
 */

const WINDOW_MS = 60 * 60 * 1000
const MAX_IN_WINDOW = 5

/*
 * KV rounds TTLs up to a 60-second floor. The window is an hour, so the entry
 * is given the window plus a minute: long enough that a key never expires while
 * timestamps inside it are still live.
 */
const TTL_SECONDS = Math.ceil(WINDOW_MS / 1000) + 60

/**
 * Records an attempt and reports whether it should be refused.
 *
 * @param {KVNamespace | undefined} kv
 * @param {string} ip
 * @param {number} now
 * @returns {Promise<{ limited: boolean, degraded: boolean }>}
 */
export async function rateLimited(kv, ip, now = Date.now()) {
  // No binding at all — local `wrangler dev` without KV configured, or a test
  // that does not care. Behave as though the limiter is simply absent.
  if (!kv) return { limited: false, degraded: true }

  const key = `rl:${ip}`

  let times = []
  try {
    const stored = await kv.get(key, { type: 'json' })
    if (Array.isArray(stored)) times = stored.filter((t) => typeof t === 'number')
  } catch {
    // Read failed. Fail open, and do not attempt the write either — if KV is
    // unhealthy the write will fail too and only burns quota.
    return { limited: false, degraded: true }
  }

  const live = times.filter((t) => now - t < WINDOW_MS)

  if (live.length >= MAX_IN_WINDOW) {
    // Deliberately no write on the refusal path. Rewriting the entry on every
    // rejected attempt would let someone hold the key alive indefinitely and,
    // worse, spend the daily write quota that the limiter itself depends on.
    return { limited: true, degraded: false }
  }

  live.push(now)

  try {
    await kv.put(key, JSON.stringify(live), { expirationTtl: TTL_SECONDS })
  } catch {
    // The attempt is allowed — it was under the limit — but it went uncounted.
    return { limited: false, degraded: true }
  }

  return { limited: false, degraded: false }
}

export const RATE_LIMIT = { WINDOW_MS, MAX_IN_WINDOW }
