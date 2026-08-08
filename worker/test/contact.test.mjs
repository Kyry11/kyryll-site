/**
 * Tests for POST /api/contact, driven through the Worker's own fetch handler
 * so routing is covered along with the handler.
 *
 * Every case here is carried over from api/test/contact.test.mjs, which listed
 * its reason for existing: these are the things that were wrong at some point
 * and would be silent if they broke again — a null body crashing the worker, a
 * spoofed forwarding header walking past the rate limit, a cross-origin post,
 * and a failed send reported to the visitor as success. The port is exactly the
 * moment they are most likely to break again.
 *
 * ACS is stubbed at the global fetch boundary rather than at a module seam, so
 * the real signing, request shaping and status handling all run.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import worker from '../src/index.js'

const CONNECTION = 'endpoint=https://example.communication.azure.com/;accesskey=a2V5LWZvci10ZXN0aW5nLW9ubHk='

/** Drives the stubbed ACS. Swapped per test. */
let sendStatus = 202
let pollStatuses = ['Succeeded']
let sent = []

const realFetch = globalThis.fetch

globalThis.fetch = async (url, init = {}) => {
  const target = String(url)

  if (target.includes('/emails:send')) {
    sent.push({ headers: init.headers, body: init.body })
    if (sendStatus !== 202) {
      return new Response('rejected', { status: sendStatus })
    }
    return new Response(JSON.stringify({ id: 'op-1', status: 'NotStarted' }), {
      status: 202,
      headers: {
        'operation-location': 'https://example.communication.azure.com/emails/operations/op-1?api-version=2023-03-31',
        'retry-after': '20',
      },
    })
  }

  if (target.includes('/emails/operations/')) {
    // Walks the script, repeating the last entry once exhausted.
    const status = pollStatuses.length > 1 ? pollStatuses.shift() : pollStatuses[0]
    return new Response(
      JSON.stringify({ id: 'op-1', status, error: status === 'Failed' ? { message: 'nope' } : undefined }),
      { status: 200 },
    )
  }

  throw new Error(`unexpected fetch to ${target}`)
}

test.after(() => { globalThis.fetch = realFetch })

/** Map-backed stand-in for the KV binding. */
function fakeKV() {
  const store = new Map()
  return {
    async get(key, options) {
      const raw = store.get(key)
      if (raw === undefined) return null
      return options?.type === 'json' ? JSON.parse(raw) : raw
    },
    async put(key, value) { store.set(key, value) },
    _store: store,
  }
}

const quiet = { log() {}, warn() {}, error() {} }

function makeEnv(overrides = {}) {
  return {
    COMMUNICATION_SERVICES_CONNECTION_STRING: CONNECTION,
    CONTACT_SENDER_ADDRESS: 'donotreply@example.test',
    CONTACT_RECIPIENT_ADDRESS: 'inbox@example.test',
    RATE_LIMIT: fakeKV(),
    ORIGIN: 'https://example.z8.web.core.windows.net',
    // Keeps the slow-send case from spending twenty real seconds per run. Long
    // enough for several polls at the real intervals, so the backoff is
    // genuinely exercised rather than short-circuited.
    POLL_BUDGET_MS: 2000,
    ...overrides,
  }
}

const VALID = { sendername: 'Kyryll', email: 'k@example.com', comments: 'hello there' }

function request({ body = VALID, headers = {}, raw, method = 'POST' } = {}) {
  return new Request('https://kyryll.com/api/contact', {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: method === 'POST' ? (raw === undefined ? JSON.stringify(body) : raw) : undefined,
  })
}

/** Distinct IP per test, so one test's rate limit cannot fail another. */
let ipCounter = 0
const freshIp = () => ({ 'cf-connecting-ip': `198.51.100.${++ipCounter}` })

const call = (req, env = makeEnv()) => worker.fetch(req, env, { console: quiet })

test.beforeEach(() => {
  sendStatus = 202
  pollStatuses = ['Succeeded']
  sent = []
})

test('rejects bodies that are not JSON objects', async () => {
  for (const raw of ['null', '[]', '"hi"', '42', 'not json at all']) {
    const res = await call(request({ raw, headers: freshIp() }))
    assert.equal(res.status, 400, `body ${raw} should be rejected, not crash`)
  }
})

test('requires application/json', async () => {
  // text/plain is a "simple" request and skips preflight, so this is the CSRF
  // vector CORS alone does not close.
  const res = await call(request({ headers: { ...freshIp(), 'content-type': 'text/plain' } }))
  assert.equal(res.status, 415)
})

test('rejects cross-origin submissions but allows no-Origin callers', async () => {
  const cross = await call(request({ headers: { ...freshIp(), origin: 'https://evil.test' } }))
  assert.equal(cross.status, 403)

  const same = await call(request({ headers: { ...freshIp(), origin: 'https://kyryll.com' } }))
  assert.equal(same.status, 200)

  const curl = await call(request({ headers: freshIp() }))
  assert.equal(curl.status, 200)
})

test('validates required fields and the address shape', async () => {
  const cases = [
    [{ ...VALID, sendername: '' }, 'sendername'],
    [{ ...VALID, email: '' }, 'email'],
    [{ ...VALID, comments: '' }, 'comments'],
    [{ ...VALID, email: 'not-an-address' }, 'email'],
    [{ ...VALID, sendername: 'a\r\nBcc: someone@else' }, 'sendername'],
    [{ ...VALID, comments: 'x'.repeat(5001) }, 'comments'],
  ]

  for (const [body, field] of cases) {
    const res = await call(request({ body, headers: freshIp() }))
    assert.equal(res.status, 400)
    assert.equal((await res.json()).field, field)
  }
})

test('honeypot is discarded without sending', async () => {
  const res = await call(request({ body: { ...VALID, website: 'http://spam.test' }, headers: freshIp() }))

  assert.equal(res.status, 200, 'bots get a cheerful 200 so they do not retry')
  assert.equal(sent.length, 0, 'but nothing is actually sent')
})

test('a failed send is not reported as success', async () => {
  for (const status of ['Failed', 'Canceled']) {
    pollStatuses = [status]
    const res = await call(request({ headers: freshIp() }))
    assert.equal(res.status, 502, `${status} must not be a 200`)
  }

  // ACS refusing the send outright.
  sendStatus = 400
  const rejected = await call(request({ headers: freshIp() }))
  assert.equal(rejected.status, 502)
})

test('a slow send is bounded and answered as accepted', async () => {
  pollStatuses = ['Running']

  const started = Date.now()
  const res = await call(request({ headers: freshIp() }))
  const elapsed = Date.now() - started

  assert.equal(res.status, 202, 'accepted, outcome not yet known')
  assert.ok(elapsed >= 2000, `must actually wait out the budget, waited ${elapsed}ms`)
  assert.ok(elapsed < 8000, `must not run past the budget, took ${elapsed}ms`)
})

test('a send that turns Succeeded after a few polls is a 200', async () => {
  pollStatuses = ['NotStarted', 'Running', 'Succeeded']
  const res = await call(request({ headers: freshIp() }))
  assert.equal(res.status, 200)
})

test('rate limit is not bypassed by a spoofed X-Forwarded-For', async () => {
  // No CF-Connecting-IP, so the handler falls back to XFF. The leftmost hop is
  // attacker-controlled; only the rightmost is appended by a trusted proxy.
  const env = makeEnv()
  let limited = 0

  for (let i = 0; i < 12; i++) {
    const res = await call(
      request({ headers: { 'x-forwarded-for': `10.0.0.${i}, 203.0.113.7` } }),
      env,
    )
    if (res.status === 429) limited++
  }

  assert.ok(limited > 0, 'rotating the spoofable hop must not reset the bucket')
  assert.equal(env.RATE_LIMIT._store.size, 1, 'all twelve must land in one bucket')
})

test('CF-Connecting-IP wins over a client-supplied X-Forwarded-For', async () => {
  const env = makeEnv()

  for (let i = 0; i < 7; i++) {
    await call(
      request({ headers: { 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-for': `10.0.0.${i}` } }),
      env,
    )
  }

  assert.deepEqual([...env.RATE_LIMIT._store.keys()], ['rl:203.0.113.9'])
})

test('an unavailable rate-limit store fails open rather than refusing everyone', async () => {
  const broken = {
    async get() { throw new Error('KV down') },
    async put() { throw new Error('KV down') },
  }

  const res = await call(request({ headers: freshIp() }), makeEnv({ RATE_LIMIT: broken }))
  assert.equal(res.status, 200, 'a downed counter must not take the contact form with it')
})

test('missing email configuration is a 500, not a crash or a false success', async () => {
  const res = await call(
    request({ headers: freshIp() }),
    makeEnv({ COMMUNICATION_SERVICES_CONNECTION_STRING: '' }),
  )
  assert.equal(res.status, 500)
  assert.equal(sent.length, 0)
})

test('the send is signed and shaped the way ACS expects', async () => {
  await call(request({ headers: freshIp() }))

  assert.equal(sent.length, 1)
  const { headers, body } = sent[0]

  assert.match(headers.Authorization, /^HMAC-SHA256 SignedHeaders=x-ms-date;host;x-ms-content-sha256&Signature=.+/)
  assert.ok(headers['x-ms-date'].endsWith('GMT'))
  assert.ok(headers['x-ms-content-sha256'])
  assert.equal(headers['content-type'], 'application/json')

  const payload = JSON.parse(body)
  assert.equal(payload.senderAddress, 'donotreply@example.test')
  assert.equal(payload.recipients.to[0].address, 'inbox@example.test')
  // The visitor's address is the reply-to, never the sender: sending as them
  // would fail SPF for their domain.
  assert.equal(payload.replyTo[0].address, 'k@example.com')
  assert.match(payload.content.plainText, /hello there/)
})

test('non-POST methods and unknown API paths do not fall through to the site', async () => {
  const wrongMethod = await call(request({ method: 'GET' }))
  assert.equal(wrongMethod.status, 405)

  const unknown = await call(new Request('https://kyryll.com/api/nope', { method: 'POST' }))
  assert.equal(unknown.status, 404)
  assert.equal(unknown.headers.get('content-type'), 'application/json')
})

test('API responses carry the security headers and are never cached', async () => {
  const res = await call(request({ headers: freshIp() }))

  assert.equal(res.headers.get('cache-control'), 'no-store')
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/)
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
  assert.match(res.headers.get('strict-transport-security'), /max-age=31536000/)
})
