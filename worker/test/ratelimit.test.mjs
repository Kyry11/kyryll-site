/**
 * Tests for the rate limiter in isolation.
 *
 * There was no such file while the limiter was KV-backed, and the properties
 * that matter were only ever exercised incidentally through the contact tests.
 * That is how the central defect survived: read-modify-write over KV admitted
 * every request in a burst, and nothing in the suite ever issued one.
 *
 * The storage stub here is deliberately naive — plain async Map access with no
 * ordering guarantees of its own. If the serialisation in RateLimiter were
 * removed, these would fail.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { RateLimiter, rateLimited, RATE_LIMIT } from '../src/ratelimit.js'

function storage() {
  const map = new Map()
  let alarm = null
  return {
    async get(key) { return map.get(key) },
    async put(key, value) { map.set(key, value) },
    async deleteAll() { map.clear() },
    async setAlarm(at) { alarm = at },
    writes: 0,
    _map: map,
    get _alarm() { return alarm },
  }
}

function counting() {
  const inner = storage()
  return Object.assign(inner, {
    async put(key, value) { inner.writes++; return inner._map.set(key, value) },
  })
}

const ask = (limiter, now) =>
  limiter
    .fetch(new Request('https://limiter/check', { method: 'POST', body: JSON.stringify({ now }) }))
    .then((r) => r.json())

test('admits exactly the limit, then refuses', async () => {
  const limiter = new RateLimiter({ storage: storage() })
  const now = 1_000_000

  for (let i = 0; i < RATE_LIMIT.MAX_IN_WINDOW; i++) {
    assert.equal((await ask(limiter, now + i)).limited, false, `attempt ${i + 1}`)
  }
  assert.equal((await ask(limiter, now + 10)).limited, true, 'one past the limit')
})

test('a burst is limited, not admitted wholesale', async () => {
  // The KV implementation admitted all of these: every request read the same
  // empty bucket before any of them wrote.
  const limiter = new RateLimiter({ storage: storage() })
  const now = 1_000_000

  const results = await Promise.all(Array.from({ length: 100 }, () => ask(limiter, now)))
  const admitted = results.filter((r) => !r.limited).length

  assert.equal(admitted, RATE_LIMIT.MAX_IN_WINDOW, `100 at once admitted ${admitted}`)
})

test('the window slides — an old entry stops counting', async () => {
  const limiter = new RateLimiter({ storage: storage() })
  const start = 1_000_000

  for (let i = 0; i < RATE_LIMIT.MAX_IN_WINDOW; i++) await ask(limiter, start + i)
  assert.equal((await ask(limiter, start + 100)).limited, true)

  // One millisecond past the window, the first entry has aged out.
  const later = start + RATE_LIMIT.WINDOW_MS + 1
  assert.equal((await ask(limiter, later)).limited, false, 'the block must expire on its own')
})

test('a refusal does not write, so a blocked sender can age out by waiting', async () => {
  // Rewriting on every rejected attempt would keep the bucket alive for as long
  // as someone kept hitting it, so the block could never expire.
  const store = counting()
  const limiter = new RateLimiter({ storage: store })
  const now = 1_000_000

  for (let i = 0; i < RATE_LIMIT.MAX_IN_WINDOW; i++) await ask(limiter, now + i)
  const writesAfterAdmissions = store.writes

  for (let i = 0; i < 20; i++) await ask(limiter, now + 100 + i)

  assert.equal(store.writes, writesAfterAdmissions, 'refusals must not write')
})

test('stored timestamps stay bounded by the limit', async () => {
  const store = storage()
  const limiter = new RateLimiter({ storage: store })

  for (let i = 0; i < 50; i++) await ask(limiter, 1_000_000 + i)

  assert.ok(
    store._map.get('times').length <= RATE_LIMIT.MAX_IN_WINDOW,
    'the array must not grow without bound',
  )
})

test('an alarm is armed so a one-off sender leaves nothing behind', async () => {
  const store = storage()
  const limiter = new RateLimiter({ storage: store })
  const now = 1_000_000

  await ask(limiter, now)
  assert.ok(store._alarm > now + RATE_LIMIT.WINDOW_MS, 'must outlast the window')

  await limiter.alarm()
  assert.equal(store._map.size, 0, 'the alarm must clear the object')
})

test('rateLimited fails open when the object is unreachable', async () => {
  // A contact form that refuses everyone because a counter is down is a worse
  // failure than one that briefly stops counting.
  const broken = {
    idFromName: (name) => name,
    get() { return { fetch: async () => { throw new Error('DO unreachable') } } },
  }
  assert.deepEqual(await rateLimited(broken, '203.0.113.1'), { limited: false, degraded: true })

  const erroring = {
    idFromName: (name) => name,
    get() { return { fetch: async () => new Response('nope', { status: 500 }) } },
  }
  assert.deepEqual(await rateLimited(erroring, '203.0.113.1'), { limited: false, degraded: true })

  // And with no binding at all.
  assert.deepEqual(await rateLimited(undefined, '203.0.113.1'), { limited: false, degraded: true })
})

test('rateLimited keys one object per IP', async () => {
  const seen = []
  const namespace = {
    idFromName: (name) => { seen.push(name); return name },
    get: () => ({ fetch: async () => Response.json({ limited: false }) }),
  }

  await rateLimited(namespace, '203.0.113.1')
  await rateLimited(namespace, '203.0.113.2')

  assert.deepEqual(seen, ['203.0.113.1', '203.0.113.2'])
})
