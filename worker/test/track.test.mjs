/**
 * Tests for POST /api/track.
 *
 * The behaviour worth pinning is the silence. Every refusal — rate limited,
 * malformed, cross-origin, unconfigured — has to be indistinguishable from a
 * recorded event, or the limit can be measured from outside by whoever wants to
 * pace themselves under it. An endpoint that is *supposed* to look like it is
 * working when it is not is exactly the kind that rots unnoticed, so these
 * assert on what was sent rather than on what was answered.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import worker, { RateLimiter } from '../src/index.js'
import { TRACKING } from '../src/track.js'

const CONNECTION = 'endpoint=https://example.communication.azure.com/;accesskey=a2V5LWZvci10ZXN0aW5nLW9ubHk='

let sent = []
let sendStatus = 202

const realFetch = globalThis.fetch

globalThis.fetch = async (url, init = {}) => {
  const target = String(url)
  if (target.includes('/emails:send')) {
    sent.push(JSON.parse(init.body))
    if (sendStatus !== 202) return new Response('no', { status: sendStatus })
    return new Response(JSON.stringify({ id: 'op', status: 'NotStarted' }), {
      status: 202,
      headers: { 'operation-location': 'https://example.communication.azure.com/emails/operations/op' },
    })
  }
  if (target.includes('/emails/operations/')) {
    return new Response(JSON.stringify({ id: 'op', status: 'Succeeded' }), { status: 200 })
  }
  throw new Error(`unexpected fetch to ${target}`)
}

test.after(() => { globalThis.fetch = realFetch })

function fakeStorage() {
  const map = new Map()
  return {
    async get(k) { return map.get(k) },
    async put(k, v) { map.set(k, v) },
    async deleteAll() { map.clear() },
    async setAlarm() {},
  }
}

function fakeNamespace() {
  const objects = new Map()
  return {
    idFromName: (name) => name,
    get(id) {
      if (!objects.has(id)) objects.set(id, new RateLimiter({ storage: fakeStorage() }))
      const object = objects.get(id)
      return { fetch: (url, init) => object.fetch(new Request(url, init)) }
    },
    _objects: objects,
  }
}

const quiet = { log() {}, warn() {}, error() {} }

function makeEnv(overrides = {}) {
  return {
    COMMUNICATION_SERVICES_CONNECTION_STRING: CONNECTION,
    CONTACT_SENDER_ADDRESS: 'donotreply@example.test',
    CONTACT_RECIPIENT_ADDRESS: 'inbox@example.test',
    RATE_LIMITER: fakeNamespace(),
    ORIGIN: 'https://example.z8.web.core.windows.net',
    ...overrides,
  }
}

const EVENT = { event: 'section', section: 'about', visitor: 'v1', visits: 3, first: '2026-08-01' }

function request({ body = EVENT, headers = {}, raw, method = 'POST', noOrigin = false } = {}) {
  // A browser on this site always sends an Origin; the route now requires it.
  // noOrigin exists because spreading cannot remove a default.
  const base = noOrigin ? {} : { origin: 'https://kyryll.com' }
  return new Request('https://kyryll.com/api/track', {
    method,
    headers: { 'content-type': 'application/json', ...base, ...headers },
    body: method === 'POST' ? (raw === undefined ? JSON.stringify(body) : raw) : undefined,
  })
}

/** Collects waitUntil work so the email can be awaited without the handler doing it. */
function context() {
  const pending = []
  return {
    console: quiet,
    waitUntil: (p) => pending.push(p),
    settle: () => Promise.allSettled(pending),
  }
}

let ipCounter = 0
const freshIp = () => ({ 'cf-connecting-ip': `198.51.100.${++ipCounter}` })

async function call(req, env = makeEnv()) {
  const ctx = context()
  const res = await worker.fetch(req, env, ctx)
  await ctx.settle()
  return res
}

test.beforeEach(() => { sent = []; sendStatus = 202 })

test('a tracked event is emailed', async () => {
  const res = await call(request({ headers: freshIp() }))

  assert.equal(res.status, 204)
  assert.equal(sent.length, 1)
  assert.match(sent[0].content.subject, /section: about/)
  assert.match(sent[0].content.plainText, /Visitor:\s+v1/)
  assert.match(sent[0].content.plainText, /Visit:\s+3, first seen 2026-08-01/)
})

test('every refusal is indistinguishable from a recorded event', async () => {
  // The whole design: a 429 would tell whoever hit it where the ceiling is.
  const cases = [
    ['wrong content type', request({ headers: { ...freshIp(), 'content-type': 'text/plain' } })],
    ['cross-origin', request({ headers: { ...freshIp(), origin: 'https://evil.test' } })],
    ['malformed body', request({ raw: 'not json', headers: freshIp() })],
    ['a bare literal body', request({ raw: 'null', headers: freshIp() })],
    ['an array body', request({ raw: '[]', headers: freshIp() })],
  ]

  for (const [label, req] of cases) {
    sent = []
    const res = await call(req)
    assert.equal(res.status, 204, label)
    assert.equal(res.headers.get('content-type'), null, `${label}: no body to read`)
    assert.equal(sent.length, 0, `${label}: nothing sent`)
  }
})

test('the limit is ten per IP, and the eleventh is silent', async () => {
  const env = makeEnv()
  const headers = { 'cf-connecting-ip': '203.0.113.50' }

  const statuses = []
  for (let i = 0; i < 14; i++) {
    statuses.push((await call(request({ headers }), env)).status)
  }

  assert.equal(TRACKING.LIMIT, 10)
  assert.equal(sent.length, 10, `only the limit is emailed, sent ${sent.length}`)
  assert.deepEqual([...new Set(statuses)], [204], 'and every answer is the same')
})

test('tracking and the contact form do not share an allowance', async () => {
  // One bucket would let somebody browsing the site exhaust the allowance the
  // contact form needs, which is the more important of the two.
  const env = makeEnv()
  const headers = { 'cf-connecting-ip': '203.0.113.51' }

  for (let i = 0; i < 12; i++) await call(request({ headers }), env)

  const keys = [...env.RATE_LIMITER._objects.keys()]
  assert.ok(keys.includes('track:203.0.113.51'), 'tracking must key its own per-IP bucket')
  assert.ok(keys.includes('track:zone'), 'and consult the shared one')
  assert.ok(
    !keys.some((k) => k.startsWith('contact:')),
    'and never touch the contact form\'s',
  )
})

test('a burst from one IP cannot exceed the limit', async () => {
  const env = makeEnv()
  const headers = { 'cf-connecting-ip': '203.0.113.52' }

  await Promise.all(Array.from({ length: 40 }, () => call(request({ headers }), env)))

  assert.equal(sent.length, 10, `concurrent events must be limited too, sent ${sent.length}`)
})

test('an unconfigured mailbox is silent rather than an error', async () => {
  const res = await call(
    request({ headers: freshIp() }),
    makeEnv({ COMMUNICATION_SERVICES_CONNECTION_STRING: '' }),
  )

  assert.equal(res.status, 204)
  assert.equal(sent.length, 0)
})

test('a failing mail service does not surface to the visitor', async () => {
  sendStatus = 500
  const res = await call(request({ headers: freshIp() }))

  assert.equal(res.status, 204, 'the beacon still gets its 204')
})

test('the visitor is never told the send failed, even on an unhandled error', async () => {
  const saved = globalThis.fetch
  globalThis.fetch = async () => { throw new TypeError('everything is down') }

  try {
    const res = await call(request({ headers: freshIp() }))
    assert.equal(res.status, 204)
    // Not the JSON 502 the contact route gives: that would single this route
    // out as the one that is broken.
    assert.equal(res.headers.get('content-type'), null)
  } finally {
    globalThis.fetch = saved
  }
})

test('oversized beacons are dropped without being buffered', async () => {
  const huge = JSON.stringify({ ...EVENT, referrer: 'x'.repeat(64 * 1024) })
  const res = await call(request({ raw: huge, headers: freshIp() }))

  assert.equal(res.status, 204)
  assert.equal(sent.length, 0)
})

test('long free-text fields are truncated rather than mailed whole', async () => {
  // referrer and visitor are attacker-supplied strings with no allowlist to
  // constrain them, so length is the only bound.
  await call(request({
    body: { ...EVENT, referrer: 'r'.repeat(4000), visitor: 'v'.repeat(4000) },
    headers: freshIp(),
  }))

  assert.equal(sent.length, 1)
  const text = sent[0].content.plainText
  assert.ok(text.length < 2000, `the email must not carry the raw field, got ${text.length}`)
})

test('only known events and sections are accepted', async () => {
  // Both reach an email subject. Without an allowlist they are arbitrary
  // strings chosen by whoever calls the route.
  const rejected = [
    { ...EVENT, event: 'anything' },
    { ...EVENT, section: 'not-a-scene' },
    { ...EVENT, event: '<script>' },
    { ...EVENT, section: { nested: true } },
    { ...EVENT, event: 42 },
  ]

  for (const body of rejected) {
    sent = []
    const res = await call(request({ body, headers: freshIp() }))
    assert.equal(res.status, 204, JSON.stringify(body))
    assert.equal(sent.length, 0, `must not send: ${JSON.stringify(body)}`)
  }

  for (const section of ['intro', 'about', 'work', 'contact']) {
    sent = []
    await call(request({ body: { ...EVENT, section }, headers: freshIp() }))
    assert.equal(sent.length, 1, `must send: ${section}`)
  }
})

test('the route is not callable without a browser origin', async () => {
  // Not authentication — anything can forge a header — but it stops the route
  // being trivially scriptable, and the ceilings are what bound the damage.
  const rejected = [
    ['no origin at all', {}, true],
    ['plain http', { origin: 'http://kyryll.com' }, false],
    ['another site', { origin: 'https://evil.test' }, false],
    ['a lookalike host', { origin: 'https://kyryll.com.evil.test' }, false],
  ]

  for (const [label, headers, noOrigin] of rejected) {
    sent = []
    const res = await call(request({ headers: { ...freshIp(), ...headers }, noOrigin }))
    assert.equal(res.status, 204, label)
    assert.equal(sent.length, 0, `${label}: nothing sent`)
  }
})

test('an unavailable rate limiter drops the event rather than letting it through', async () => {
  /*
   * The opposite call from the contact form, and deliberately so. A message
   * from a real person is worth more than an accurate count; an optional beacon
   * is worth less than the email it would cost. Failing open here would mean a
   * limiter outage removed the only ceiling on ACS spend.
   */
  const broken = {
    missing: undefined,
    throwing: {
      idFromName: (n) => n,
      get: () => ({ fetch: async () => { throw new Error('DO unreachable') } }),
    },
    erroring: {
      idFromName: (n) => n,
      get: () => ({ fetch: async () => new Response('nope', { status: 500 }) }),
    },
    malformed: {
      idFromName: (n) => n,
      get: () => ({ fetch: async () => new Response('<html>not json</html>', { status: 200 }) }),
    },
  }

  for (const [label, RATE_LIMITER] of Object.entries(broken)) {
    sent = []
    const res = await call(request({ headers: freshIp() }), makeEnv({ RATE_LIMITER }))
    assert.equal(res.status, 204, label)
    assert.equal(sent.length, 0, `${label}: a broken limiter must not become no limiter`)
  }
})

test('each ceiling fails closed on its own, not because the other one caught it', async () => {
  /*
   * Breaking both at once proves nothing about either: whichever check runs
   * second will stop the event regardless, so removing the first one's
   * `degraded` test would not fail anything. Each is broken alone here so each
   * is independently load-bearing.
   */
  const healthy = fakeNamespace()

  const brokenFor = (badKey) => ({
    idFromName: (n) => n,
    get(id) {
      if (id === badKey) {
        return { fetch: async () => { throw new Error('DO unreachable') } }
      }
      return healthy.get(id)
    },
  })

  for (const badKey of ['track:198.51.100.200', 'track:zone']) {
    sent = []
    const res = await call(
      request({ headers: { 'cf-connecting-ip': '198.51.100.200' } }),
      makeEnv({ RATE_LIMITER: brokenFor(badKey) }),
    )
    assert.equal(res.status, 204, badKey)
    assert.equal(sent.length, 0, `a degraded ${badKey} alone must drop the event`)
  }
})

test('a zone-wide ceiling bounds the total, not just each sender', async () => {
  // A per-IP cap bounds one sender and nothing else: a hundred addresses is a
  // hundred times ten emails, and the bill is real.
  const env = makeEnv()

  // Eleven addresses, each spending its own allowance of ten.
  for (let ip = 0; ip < 11; ip++) {
    for (let i = 0; i < 10; i++) {
      await call(request({ headers: { 'cf-connecting-ip': `203.0.114.${ip}` } }), env)
    }
  }

  assert.equal(TRACKING.ZONE_LIMIT, 100)
  assert.equal(TRACKING.ZONE_WINDOW_MS, 2 * 60 * 60 * 1000)
  assert.equal(sent.length, 100, `the zone ceiling must hold at 100, sent ${sent.length}`)
  assert.ok(
    [...env.RATE_LIMITER._objects.keys()].includes('track:zone'),
    'and it must be one shared bucket',
  )
})

test('the response carries the security headers and is never cached', async () => {
  const res = await call(request({ headers: freshIp() }))

  assert.equal(res.headers.get('cache-control'), 'no-store')
  assert.match(res.headers.get('content-security-policy') ?? '', /default-src 'self'/)
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
})

test('a non-POST is refused the same way as any other endpoint', async () => {
  const res = await call(request({ method: 'GET' }))
  assert.equal(res.status, 405)
  assert.equal(res.headers.get('allow'), 'POST')
})
