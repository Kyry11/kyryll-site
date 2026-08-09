/**
 * Rate limiting, in a Durable Object.
 *
 * The lineage matters, because each step fixed the previous one's central flaw:
 *
 *   1. A `Map` in an Azure Function's process memory. Lost on every cold start,
 *      never shared between instances, so the real ceiling was (limit × live
 *      instances). Its own documentation admitted it stopped nothing but
 *      somebody holding down Send.
 *
 *   2. Workers KV. Durable and shared, which fixed the ceiling — but
 *      read-modify-write over KV is not atomic, and that turned out to be the
 *      whole game. Under 100 concurrent submissions from one IP, all 100 read
 *      the same empty bucket, all 100 were admitted, and 99 of the writes were
 *      lost. Sequential traffic was limited correctly and concurrent traffic
 *      was not limited at all — exactly backwards, because for a contact form
 *      the abuse case *is* the burst. An earlier version of this comment said
 *      two simultaneous requests could "lose one"; that understated it by a
 *      factor of the burst size.
 *
 *   3. This. A Durable Object is single-threaded per object and requests to one
 *      object are serialised, so the read and the write cannot interleave. One
 *      object per IP — `idFromName(ip)` — so unrelated senders never queue
 *      behind each other.
 *
 * It still fails open: if the object is unreachable, submissions are allowed
 * rather than refused. A contact form that rejects everyone because a counter
 * is down is a worse failure than one that briefly stops counting.
 *
 * A Cloudflare rate-limiting rule at the zone level is still worth having in
 * front of this — it is enforced at the edge before the Worker runs, so it also
 * costs nothing to serve. This is the layer that survives if that is not
 * configured.
 */

const WINDOW_MS = 60 * 60 * 1000
const MAX_IN_WINDOW = 5

/**
 * One instance per IP, holding the timestamps of that IP's recent submissions.
 *
 * Registered in wrangler.toml as a SQLite-backed class, which is what makes
 * Durable Objects available on the Workers free plan.
 */
export class RateLimiter {
  constructor(state) {
    this.state = state
    // Tail of the serialisation chain. See fetch().
    this.tail = Promise.resolve()
  }

  async fetch(request) {
    // The limit travels with the request rather than being baked in, because
    // two routes want different ones: five submissions an hour for the contact
    // form, ten events for tracking. The caller is this Worker, so there is
    // nothing to validate — a visitor cannot reach the object directly.
    // Limit and window both travel with the request. Three callers want three
    // different pairs: five an hour per IP for the contact form, ten an hour
    // per IP for tracking, and one hundred every two hours across everyone.
    const { now, limit, window } = await request.json()

    /*
     * Each evaluation waits for the previous one, explicitly.
     *
     * The runtime's input gating already stops events being delivered while a
     * storage operation is outstanding, so on Cloudflare this chain is
     * belt-and-braces. It is here for two reasons anyway: the correctness of a
     * rate limiter should not rest on a subtle platform guarantee that a future
     * refactor could quietly step outside, and — more practically — it is the
     * difference between a test that proves the property and a test that can
     * only assert it. A fake that modelled input gating would pass by
     * construction; this holds under a fake that does not.
     */
    const evaluation = this.tail.then(
      () => this.evaluate(now, limit, window),
      () => this.evaluate(now, limit, window),
    )
    this.tail = evaluation.catch(() => {})

    return Response.json(await evaluation)
  }

  async evaluate(now, limit = MAX_IN_WINDOW, windowMs = WINDOW_MS) {
    const times = (await this.state.storage.get('times')) ?? []
    const live = times.filter((t) => now - t < windowMs)

    if (live.length >= limit) {
      /*
       * Deliberately no write on the refusal path. Rewriting the entry on every
       * rejected attempt would let someone hold their own bucket alive
       * indefinitely, so a blocked sender could never age out by waiting.
       */
      return { limited: true }
    }

    live.push(now)
    await this.state.storage.put('times', live)

    /*
     * Drop the object's storage once the window has fully passed, so an IP that
     * submits once does not leave state behind for ever. Re-armed on each
     * write, which is what makes it track the newest entry rather than the
     * oldest.
     */
    await this.state.storage.setAlarm(now + windowMs + 60_000)

    return { limited: false }
  }

  async alarm() {
    await this.state.storage.deleteAll()
  }
}

/**
 * Records an attempt and reports whether it should be refused.
 *
 * The key is namespaced by the caller — `contact:<ip>`, `track:<ip>` — so the
 * two routes count separately. Sharing one bucket would let a visitor browsing
 * the site spend the allowance the contact form needs.
 *
 * @param {DurableObjectNamespace | undefined} namespace
 * @param {string} key
 * `degraded` says the answer is not trustworthy — no binding, an unreachable
 * object, an unreadable reply. What to do about that is the caller's decision
 * and the two callers here make opposite ones: the contact form lets a message
 * through, because refusing everybody over a broken counter is worse than
 * miscounting; tracking drops the event, because it is optional and every one
 * that gets past costs an email.
 *
 * @param {number} limit
 * @param {number} windowMs
 * @param {number} now
 * @returns {Promise<{ limited: boolean, degraded: boolean }>}
 */
export async function rateLimited(namespace, key, limit = MAX_IN_WINDOW, windowMs = WINDOW_MS, now = Date.now()) {
  // No binding at all — a test that does not care, or a misconfigured deploy.
  if (!namespace) return { limited: false, degraded: true }

  try {
    const stub = namespace.get(namespace.idFromName(key))
    const response = await stub.fetch('https://limiter/check', {
      method: 'POST',
      body: JSON.stringify({ now, limit, window: windowMs }),
    })

    if (!response.ok) return { limited: false, degraded: true }

    const { limited } = await response.json()
    return { limited: Boolean(limited), degraded: false }
  } catch {
    return { limited: false, degraded: true }
  }
}

export const RATE_LIMIT = { WINDOW_MS, MAX_IN_WINDOW }
