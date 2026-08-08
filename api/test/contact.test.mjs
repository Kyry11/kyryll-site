/**
 * Tests for POST /api/contact.
 *
 * The handler is loaded with @azure/functions and @azure/communication-email
 * stubbed, so this exercises the real request-handling and send-outcome logic
 * without a Functions host or an Azure resource. Run with `npm test --prefix
 * api`, which is what CI does.
 *
 * These cover the cases that were wrong at some point and would be silent if
 * they broke again — a null body crashing the worker, a spoofed
 * X-Forwarded-For walking past the rate limit, a cross-origin post, and a
 * failed send being reported to the visitor as success.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const handlerPath = resolve(here, '../src/functions/contact.js')
const require = createRequire(import.meta.url)

/** Swapped per test to drive the poller. */
let poll = async () => ({ status: 'Succeeded' })

const Module = require('node:module')
const originalResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request === '@azure/functions') return 'STUB_FUNCTIONS'
  if (request === '@azure/communication-email') return 'STUB_EMAIL'
  return originalResolve.call(this, request, ...rest)
}

const routes = {}
require.cache.STUB_FUNCTIONS = {
  id: 'STUB_FUNCTIONS',
  loaded: true,
  exports: { app: { http: (name, config) => { routes[name] = config.handler } } },
}
require.cache.STUB_EMAIL = {
  id: 'STUB_EMAIL',
  loaded: true,
  exports: {
    KnownEmailSendStatus: { Succeeded: 'Succeeded', Failed: 'Failed', Canceled: 'Canceled' },
    EmailClient: class {
      async beginSend() {
        return { pollUntilDone: (options) => poll(options) }
      }
    },
  },
}

process.env.COMMUNICATION_SERVICES_CONNECTION_STRING = 'endpoint=https://example.test/;accesskey=k'
process.env.CONTACT_SENDER_ADDRESS = 'donotreply@example.test'
process.env.CONTACT_RECIPIENT_ADDRESS = 'inbox@example.test'

require(handlerPath)
const handler = routes.contact

const context = { log() {}, warn() {}, error() {} }

const VALID = { sendername: 'Kyryll', email: 'k@example.com', comments: 'hello there' }

/** A request object shaped like the one the Functions v4 model passes in. */
function request({ body = VALID, headers = {}, raw } = {}) {
  const all = {
    'content-type': 'application/json',
    host: 'kyryll.com',
    ...headers,
  }
  return {
    headers: { get: (k) => all[k.toLowerCase()] ?? null },
    json: async () => (raw === undefined ? body : JSON.parse(raw)),
  }
}

/** Distinct IP per test, so one test's rate limit cannot fail another. */
let ipCounter = 0
const freshIp = () => ({ 'x-azure-clientip': `198.51.100.${++ipCounter}` })

test('rejects bodies that are not JSON objects', async () => {
  for (const raw of ['null', '[]', '"hi"', '42']) {
    const res = await handler(request({ raw, headers: freshIp() }), context)
    assert.equal(res.status, 400, `body ${raw} should be rejected, not crash`)
  }
})

test('requires application/json', async () => {
  const res = await handler(
    request({ headers: { ...freshIp(), 'content-type': 'text/plain' } }),
    context,
  )
  // text/plain is a "simple" request and skips preflight, so this is the CSRF
  // vector CORS alone does not close.
  assert.equal(res.status, 415)
})

test('rejects cross-origin submissions but allows no-Origin callers', async () => {
  const cross = await handler(
    request({ headers: { ...freshIp(), origin: 'https://evil.test' } }),
    context,
  )
  assert.equal(cross.status, 403)

  const same = await handler(
    request({ headers: { ...freshIp(), origin: 'https://kyryll.com' } }),
    context,
  )
  assert.equal(same.status, 200)

  const curl = await handler(request({ headers: freshIp() }), context)
  assert.equal(curl.status, 200)
})

test('validates required fields and the address shape', async () => {
  const cases = [
    [{ ...VALID, sendername: '' }, 'sendername'],
    [{ ...VALID, email: '' }, 'email'],
    [{ ...VALID, comments: '' }, 'comments'],
    [{ ...VALID, email: 'not-an-address' }, 'email'],
    [{ ...VALID, sendername: 'a\r\nBcc: someone@else' }, 'sendername'],
  ]

  for (const [body, field] of cases) {
    const res = await handler(request({ body, headers: freshIp() }), context)
    assert.equal(res.status, 400)
    assert.equal(res.jsonBody.field, field)
  }
})

test('honeypot is discarded without sending', async () => {
  let sent = false
  poll = async () => { sent = true; return { status: 'Succeeded' } }

  const res = await handler(
    request({ body: { ...VALID, website: 'http://spam.test' }, headers: freshIp() }),
    context,
  )

  assert.equal(res.status, 200, 'bots get a cheerful 200 so they do not retry')
  assert.equal(sent, false, 'but nothing is actually sent')
  poll = async () => ({ status: 'Succeeded' })
})

test('a failed send is not reported as success', async () => {
  for (const status of ['Failed', 'Canceled']) {
    poll = async () => ({ status, error: { message: 'nope' } })
    const res = await handler(request({ headers: freshIp() }), context)
    assert.equal(res.status, 502, `${status} must not be a 200`)
  }

  poll = async () => { throw new Error('network') }
  const thrown = await handler(request({ headers: freshIp() }), context)
  assert.equal(thrown.status, 502)

  poll = async () => ({ status: 'Succeeded' })
})

test('a slow send is bounded and the poller is aborted', async () => {
  let signal
  poll = (options) => {
    signal = options?.abortSignal
    return new Promise((_, reject) => {
      // Resolve only if aborted, mirroring the real poller's behaviour.
      signal?.addEventListener('abort', () => reject(new Error('aborted')))
    })
  }

  const started = Date.now()
  const res = await handler(request({ headers: freshIp() }), context)
  const elapsed = Date.now() - started

  assert.equal(res.status, 202, 'accepted, delivery unconfirmed')
  assert.ok(elapsed < 40_000, `must answer inside the 45s platform cap, took ${elapsed}ms`)
  assert.ok(signal, 'an abort signal must be passed to pollUntilDone')
  assert.equal(signal.aborted, true, 'the losing poller must be cancelled, not abandoned')

  poll = async () => ({ status: 'Succeeded' })
})

test('rate limit is not bypassed by a spoofed X-Forwarded-For', async () => {
  // No x-azure-clientip, so the handler falls back to XFF. The leftmost hop is
  // attacker-controlled; only the rightmost is appended by a trusted proxy.
  let limited = 0
  for (let i = 0; i < 12; i++) {
    const res = await handler(
      request({ headers: { 'x-forwarded-for': `10.0.0.${i}, 203.0.113.7` } }),
      context,
    )
    if (res.status === 429) limited++
  }

  assert.ok(limited > 0, 'rotating the spoofable hop must not reset the bucket')
})
