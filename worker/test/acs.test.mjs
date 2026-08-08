/**
 * Tests for the ACS REST signing.
 *
 * This is the part of the port with no safety net: it cannot be exercised
 * against the real service without live credentials, and a signature that is
 * wrong in any detail fails identically to a wrong access key — 401, with no
 * hint as to which of the six inputs is at fault.
 *
 * So it is checked two ways. First against an independent implementation of the
 * documented algorithm written with node:crypto rather than WebCrypto, derived
 * from the Microsoft tutorial and sharing no code with src/acs.js. Second
 * against literal expected values, so a change that breaks both implementations
 * at once still fails.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'

import {
  parseConnectionString,
  contentHash,
  rfc1123,
  signedHeaders,
} from '../src/acs.js'

/** The documented scheme, implemented independently of src/acs.js. */
function reference({ method, pathAndQuery, host, date, body, accessKey }) {
  const hash = createHash('sha256').update(body, 'utf8').digest('base64')
  const stringToSign = `${method}\n${pathAndQuery}\n${date};${host};${hash}`
  const signature = createHmac('sha256', Buffer.from(accessKey, 'base64'))
    .update(stringToSign, 'utf8')
    .digest('base64')
  return { hash, signature }
}

// Fixed inputs. The key is arbitrary but must be valid base64, since the real
// one is base64 and is decoded before use.
const KEY = 'c2VjcmV0LWtleS1mb3ItdGVzdGluZy1vbmx5LTEyMzQ1Ng=='
const DATE = new Date(Date.UTC(2026, 7, 9, 12, 0, 0))
const ENDPOINT = 'https://example.australiaeast.communication.azure.com'

test('connection string parsing survives the key containing "="', () => {
  const parsed = parseConnectionString(`endpoint=${ENDPOINT}/;accesskey=${KEY}`)
  assert.equal(parsed.endpoint, ENDPOINT, 'the trailing slash must be trimmed')
  assert.equal(parsed.accessKey, KEY, 'base64 padding must not be truncated')

  // Order is not guaranteed by the portal.
  const reversed = parseConnectionString(`accesskey=${KEY};endpoint=${ENDPOINT}`)
  assert.equal(reversed.accessKey, KEY)
  assert.equal(reversed.endpoint, ENDPOINT)

  for (const bad of ['', 'endpoint=https://x/', `accesskey=${KEY}`, 'nonsense']) {
    assert.throws(() => parseConnectionString(bad), /Malformed/, `should reject: ${bad}`)
  }
})

test('the date is RFC 1123 in GMT', () => {
  assert.equal(rfc1123(DATE), 'Sun, 09 Aug 2026 12:00:00 GMT')
})

test('the content hash is base64 SHA-256, and empty bodies are hashed not skipped', async () => {
  // The well-known SHA-256 of the empty string. The polling GET sends no body
  // and still has to carry this value.
  assert.equal(await contentHash(''), '47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=')
  assert.equal(
    await contentHash('{"a":1}'),
    createHash('sha256').update('{"a":1}', 'utf8').digest('base64'),
  )
})

test('the signature matches an independent implementation of the documented scheme', async () => {
  const cases = [
    { method: 'POST', url: `${ENDPOINT}/emails:send?api-version=2023-03-31`, body: '{"senderAddress":"a@b.c"}' },
    { method: 'GET', url: `${ENDPOINT}/emails/operations/abc-123?api-version=2023-03-31`, body: '' },
    // A body with non-ASCII, because the hash is over UTF-8 bytes and a
    // char-length shortcut would pass every ASCII test and fail here.
    { method: 'POST', url: `${ENDPOINT}/emails:send?api-version=2023-03-31`, body: '{"subject":"New site message — Kyryll"}' },
  ]

  for (const { method, url, body } of cases) {
    const headers = await signedHeaders({ method, url, body, accessKey: KEY, date: DATE })
    const target = new URL(url)
    const expected = reference({
      method,
      pathAndQuery: target.pathname + target.search,
      host: target.host,
      date: rfc1123(DATE),
      body,
      accessKey: KEY,
    })

    assert.equal(headers['x-ms-content-sha256'], expected.hash, `content hash for ${method} ${body.slice(0, 20)}`)
    assert.equal(
      headers.Authorization,
      `HMAC-SHA256 SignedHeaders=x-ms-date;host;x-ms-content-sha256&Signature=${expected.signature}`,
      `authorization for ${method}`,
    )
    assert.equal(headers['x-ms-date'], 'Sun, 09 Aug 2026 12:00:00 GMT')
  }
})

test('the signature is pinned to a literal, so both implementations cannot drift together', async () => {
  const headers = await signedHeaders({
    method: 'POST',
    url: `${ENDPOINT}/emails:send?api-version=2023-03-31`,
    body: '{"senderAddress":"a@b.c"}',
    accessKey: KEY,
    date: DATE,
  })

  assert.equal(headers['x-ms-content-sha256'], 'JppGVhXOsxjTDFEjYrQyeJE/eLwcSbSYvYuKFodVIO0=')
  assert.equal(
    headers.Authorization,
    'HMAC-SHA256 SignedHeaders=x-ms-date;host;x-ms-content-sha256' +
      '&Signature=8HyIADEDp4LC8YqI8O3FJ5EQrV351exhebmlFqt5nw0=',
  )
})

test('the query string is part of the signed path', async () => {
  const withQuery = await signedHeaders({
    method: 'GET',
    url: `${ENDPOINT}/emails/operations/abc?api-version=2023-03-31`,
    body: '',
    accessKey: KEY,
    date: DATE,
  })
  const withoutQuery = await signedHeaders({
    method: 'GET',
    url: `${ENDPOINT}/emails/operations/abc`,
    body: '',
    accessKey: KEY,
    date: DATE,
  })

  assert.notEqual(
    withQuery.Authorization,
    withoutQuery.Authorization,
    'dropping the api-version from the signed path must change the signature',
  )
})
