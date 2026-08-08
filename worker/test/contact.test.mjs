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

import worker, { RateLimiter } from '../src/index.js'
import { handleContact } from '../src/contact.js'

const CONNECTION = 'endpoint=https://example.communication.azure.com/;accesskey=a2V5LWZvci10ZXN0aW5nLW9ubHk='

/** Drives the stubbed ACS. Swapped per test. */
let sendStatus = 202
let pollStatuses = ['Succeeded']
let sent = []
let polls = 0
/** When set, the poll endpoint fails this way instead of answering. */
let pollFailure = null
let sendUrls = []

const realFetch = globalThis.fetch

globalThis.fetch = async (url, init = {}) => {
  const target = String(url)

  if (target.includes('/emails:send')) {
    sent.push({ headers: init.headers, body: init.body })
    sendUrls.push(target)
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
    polls++
    if (pollFailure === 'network') throw new Error('connection reset')
    if (pollFailure) return new Response('upstream problem', { status: pollFailure })
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

/**
 * Stand-in for the Durable Object namespace.
 *
 * Deliberately runs the *real* RateLimiter class over a Map-backed storage,
 * rather than reimplementing the limiting logic in the test. A hand-rolled fake
 * would have agreed with whatever the code did, including the KV version's
 * lost-update bug, which is precisely what the previous fake failed to catch.
 */
function fakeStorage() {
  const map = new Map()
  return {
    async get(key) { return map.get(key) },
    async put(key, value) { map.set(key, value) },
    async deleteAll() { map.clear() },
    async setAlarm() {},
    _map: map,
  }
}

function fakeNamespace() {
  const objects = new Map()
  return {
    idFromName: (name) => name,
    get(id) {
      if (!objects.has(id)) objects.set(id, new RateLimiter({ storage: fakeStorage() }))
      const object = objects.get(id)
      // A real stub takes (url, init) and hands the object a Request. Returning
      // the object itself made every call throw on `request.json()`, which
      // rateLimited() catches as "degraded" and fails open — so the limiter
      // looked fine and enforced nothing.
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
  sendUrls = []
  polls = 0
  pollFailure = null
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
  // Without this the test passes for an implementation that sleeps out the
  // whole budget and never asks ACS anything — which is exactly the defect
  // this file was supposed to have caught.
  assert.ok(polls >= 3, `must actually poll while waiting, polled ${polls} times`)
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
  assert.equal(env.RATE_LIMITER._objects.size, 1, 'all twelve must land in one bucket')
})

test('CF-Connecting-IP wins over a client-supplied X-Forwarded-For', async () => {
  const env = makeEnv()

  for (let i = 0; i < 7; i++) {
    await call(
      request({ headers: { 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-for': `10.0.0.${i}` } }),
      env,
    )
  }

  assert.deepEqual([...env.RATE_LIMITER._objects.keys()], ['203.0.113.9'])
})

test('an unavailable rate-limit store fails open rather than refusing everyone', async () => {
  /*
   * This overrode `RATE_LIMIT` with a KV-shaped object — both left over from
   * the KV implementation. Production reads `RATE_LIMITER` and expects a
   * Durable Object namespace, so the broken store was simply ignored, the
   * healthy default was used, and the test asserted a 200 on the happy path
   * while claiming to prove fail-open. Renaming a binding does not fail a test
   * that injects it under the old name; nothing catches that but reading it.
   */
  const broken = {
    idFromName: (name) => name,
    get() {
      return { fetch: async () => { throw new Error('Durable Object unreachable') } }
    },
  }

  const res = await call(request({ headers: freshIp() }), makeEnv({ RATE_LIMITER: broken }))
  assert.equal(res.status, 200, 'a downed counter must not take the contact form with it')
  assert.equal(sent.length, 1, 'and the message must still be sent')
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

test('the content-type gate cannot be smuggled past in a MIME parameter', async () => {
  // CORS decides a request is "simple" — and so skips preflight — from the
  // media type's essence, ignoring parameters. A substring check on the whole
  // header therefore let all three simple types through the guard whose only
  // job is to force a preflight.
  const smuggled = [
    'text/plain; charset=application/json',
    'multipart/form-data; boundary=application/json',
    'application/x-www-form-urlencoded; x=application/json',
    'text/plain;application/json',
  ]

  for (const contentType of smuggled) {
    const res = await call(request({ headers: { ...freshIp(), 'content-type': contentType } }))
    assert.equal(res.status, 415, `must reject: ${contentType}`)
  }

  // Legitimate parameters on the real type still pass.
  for (const contentType of ['application/json', 'application/json; charset=utf-8', 'APPLICATION/JSON']) {
    const res = await call(request({ headers: { ...freshIp(), 'content-type': contentType } }))
    assert.equal(res.status, 200, `must accept: ${contentType}`)
  }
})

test('a localhost origin is refused in production and allowed only in development', async () => {
  // The Vite escape hatch was unconditional, so any page served from the
  // visitor's own machine could drive this endpoint from their address.
  for (const origin of ['http://localhost', 'http://localhost:5173', 'http://127.0.0.1:8080']) {
    const res = await call(request({ headers: { ...freshIp(), origin } }))
    assert.equal(res.status, 403, `${origin} must be refused by default`)
  }

  const dev = makeEnv({ ALLOW_LOCALHOST_ORIGIN: 'true' })
  const res = await call(request({ headers: { ...freshIp(), origin: 'http://localhost:5173' } }), dev)
  assert.equal(res.status, 200, 'and allowed when development sets the flag')
})

test('a transient poll failure does not report a queued message as undeliverable', async () => {
  // The send already got its 202 — ACS has the message. Answering 502 tells the
  // visitor to email directly for something already in flight, so they resend
  // or give up. The Azure SDK retried these internally; nothing here did.
  for (const failure of [500, 429, 'network']) {
    pollFailure = failure
    const res = await call(request({ headers: freshIp() }))

    assert.equal(res.status, 202, `poll ${failure} must not become a 502`)
    assert.equal(sent.length, 1, 'and the send must have happened exactly once')
    assert.ok(polls > 1, `must keep polling through the failure, polled ${polls}`)

    sent = []
    polls = 0
  }
})

test('a burst from one IP is limited, not just a sequence', async () => {
  // The KV implementation limited sequential traffic correctly and concurrent
  // traffic not at all: every request in a burst read the same empty bucket and
  // every one was admitted. For a contact form the abuse case *is* the burst.
  const env = makeEnv()
  const headers = { 'cf-connecting-ip': '203.0.113.99' }

  const responses = await Promise.all(
    Array.from({ length: 40 }, () => call(request({ headers }), env)),
  )

  const accepted = responses.filter((r) => r.status === 200).length
  const refused = responses.filter((r) => r.status === 429).length

  assert.equal(accepted, 5, `exactly the limit must get through, got ${accepted}`)
  assert.equal(refused, 35, `the rest must be refused, got ${refused}`)
  assert.equal(sent.length, 5, `and only ${accepted} emails may be sent, sent ${sent.length}`)
})

test('the rightmost X-Forwarded-For hop is the bucket key', async () => {
  // Asserting only that *something* was limited passes even if clientIp returns
  // a constant, because then every caller shares one bucket. The key itself has
  // to be checked.
  const env = makeEnv()
  await call(request({ headers: { 'x-forwarded-for': '10.0.0.1, 203.0.113.7' } }), env)

  assert.deepEqual([...env.RATE_LIMITER._objects.keys()], ['203.0.113.7'])
})

test('the send and poll are addressed with a pinned api-version', async () => {
  await call(request({ headers: freshIp() }))

  assert.equal(sendUrls.length, 1)
  // The literal version, not a date-shaped pattern: a pattern accepts
  // '2029-99-99' and every other typo. Bumping this is fine — it should just be
  // a decision someone makes, not something that drifts.
  assert.equal(
    sendUrls[0],
    'https://example.communication.azure.com/emails:send?api-version=2023-03-31',
  )
})

test('a 405 carries Allow, as RFC 9110 requires', async () => {
  const res = await call(request({ method: 'GET' }))
  assert.equal(res.status, 405)
  assert.equal(res.headers.get('allow'), 'POST')
})

test('bare /api is a missing endpoint, not the site', async () => {
  const res = await call(new Request('https://kyryll.com/api'))
  assert.equal(res.status, 404)
  assert.equal(res.headers.get('content-type'), 'application/json')
})

test('an oversized body is refused before it is buffered', async () => {
  // request.json() buffers whatever arrives, and Cloudflare accepts bodies up
  // to 100MB against a 128MB isolate limit. Parsing first put a public endpoint
  // one request away from an out-of-memory isolate, with the field-length
  // checks — and the rate limiter — both far too late to help.
  const huge = JSON.stringify({ ...VALID, comments: 'x'.repeat(64 * 1024) })

  const res = await call(request({ raw: huge, headers: freshIp() }))
  assert.equal(res.status, 413)
  assert.equal(sent.length, 0)
})

test('the byte cap holds when Content-Length lies or is absent', async () => {
  // Content-Length is caller-supplied and missing entirely on a chunked body,
  // so it cannot be the enforcement point.
  const payload = new TextEncoder().encode(
    JSON.stringify({ ...VALID, comments: 'x'.repeat(64 * 1024) }),
  )

  const streamed = new Request('https://kyryll.com/api/contact', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...freshIp() },
    body: new ReadableStream({
      start(controller) {
        // Chunked, so the runtime sends no Content-Length at all.
        for (let at = 0; at < payload.length; at += 8192) {
          controller.enqueue(payload.slice(at, at + 8192))
        }
        controller.close()
      },
    }),
    duplex: 'half',
  })

  assert.equal(streamed.headers.get('content-length'), null, 'precondition: no Content-Length')

  const res = await call(streamed)
  assert.equal(res.status, 413)
  assert.equal(sent.length, 0)
})

test('a legitimate maximum-length message still gets through', async () => {
  // The cap must sit above anything validate() would accept, or the two guards
  // disagree and the longer messages the form allows are silently unsendable.
  const atLimit = { ...VALID, comments: 'x'.repeat(5000) }

  const res = await call(request({ body: atLimit, headers: freshIp() }))
  assert.equal(res.status, 200)
  assert.equal(sent.length, 1)
})

test('a declared Content-Length over the cap is refused without reading the body', async () => {
  /*
   * The streaming cap alone would catch this, so removing the header check
   * breaks no other test — which is exactly why this one exists. The point of
   * the header check is that it costs nothing: it rejects before a single byte
   * is pulled off the socket. This asserts that property directly by handing
   * the handler a body that throws if it is touched.
   *
   * Content-Length is a forbidden header on a constructed Request, so the
   * handler is called with a stub rather than through worker.fetch.
   */
  let bodyTouched = false
  const headers = new Map([
    ['content-type', 'application/json'],
    ['content-length', String(100 * 1024 * 1024)],
    ['cf-connecting-ip', '203.0.113.55'],
  ])

  const stub = {
    url: 'https://kyryll.com/api/contact',
    method: 'POST',
    headers: { get: (name) => headers.get(name.toLowerCase()) ?? null },
    get body() { bodyTouched = true; throw new Error('body must not be read') },
  }

  const res = await handleContact(stub, makeEnv(), quiet)

  assert.equal(res.status, 413)
  assert.equal(bodyTouched, false, 'the body must not be touched once the length is known')
  assert.equal(sent.length, 0)
})
