/**
 * Tests for serving the site out of blob storage.
 *
 * Everything here was previously declared in staticwebapp.config.json and
 * enforced by Static Web Apps. Reimplemented in the Worker, it is now ordinary
 * code that can be wrong — and most of the ways it can be wrong are invisible
 * in a browser until much later: a missing CSP looks fine, a 404 served as 200
 * looks fine, a dropped Range header looks fine until someone tries to seek
 * five minutes into the ambient track.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import worker from '../src/index.js'

const ORIGIN = 'https://example.z8.web.core.windows.net'

/** What storage will pretend to hold. */
let blobs = {}
let requested = []

const realFetch = globalThis.fetch

globalThis.fetch = async (url, init = {}) => {
  requested.push({ url: String(url), method: init.method, headers: init.headers, cf: init.cf })

  const path = String(url).slice(ORIGIN.length)
  const blob = blobs[path]

  if (!blob) {
    // Blob Storage serves its configured error document with a 404 status.
    return new Response('<!doctype html>not found', {
      status: 404,
      headers: { 'content-type': 'text/html' },
    })
  }

  // Storage always announces itself; the Worker is expected to strip this.
  const headers = new Headers({
    'content-type': blob.type ?? 'application/octet-stream',
    'x-ms-request-id': 'f70e7a88-501e-005f-4b48-27fb63000000',
    'x-ms-version': '2018-03-28',
    server: 'Windows-Azure-Blob/1.0',
    ...blob.headers,
  })

  const range = init.headers?.get?.('range') ?? init.headers?.range
  if (range) {
    return new Response('partial', {
      status: 206,
      headers: { ...Object.fromEntries(headers), 'content-range': 'bytes 0-6/1000' },
    })
  }

  return new Response(blob.body ?? 'ok', { status: 200, headers })
}

test.after(() => { globalThis.fetch = realFetch })

const env = { ORIGIN }
const get = (path, init) => worker.fetch(new Request(`https://kyryll.com${path}`, init), env, {})

test.beforeEach(() => {
  requested = []
  blobs = {
    '/index.html': { type: 'text/html', body: '<!doctype html>site' },
    '/assets/main-abc123.js': { type: 'text/javascript', body: 'console.log(1)' },
    '/img/bg1.jpg': { type: 'image/jpeg' },
    '/sound/odessa.m4a': { type: 'application/octet-stream' },
    '/fonts/chennai-bold.woff': { type: 'application/octet-stream' },
    // The build drops these at the root, outside every prefix rule.
    '/favicon.ico': { type: 'image/x-icon' },
    '/apple-touch-icon.png': { type: 'image/png' },
  }
})

test('root-level icons are treated as assets, not as pages', async () => {
  // They sit outside every prefix. Falling through to the page rules meant
  // revalidating them on every request, and a missing one being served as
  // index.html with a 200 — markup where the browser asked for an icon.
  const icon = await get('/favicon.ico')
  assert.equal(icon.status, 200)
  assert.equal(icon.headers.get('cache-control'), 'public, max-age=604800')

  const missing = await get('/apple-touch-icon-precomposed.png')
  assert.equal(missing.status, 404, 'a missing icon must 404, not return HTML')
  assert.equal(requested.length, 2, 'and must not trigger a fallback fetch')
})

test('the root serves index.html from storage', async () => {
  const res = await get('/')

  assert.equal(res.status, 200)
  assert.equal(requested[0].url, `${ORIGIN}/index.html`)
  assert.match(await res.text(), /site/)
})

test('every response carries the security headers', async () => {
  for (const path of ['/', '/assets/main-abc123.js', '/img/bg1.jpg', '/nope']) {
    const res = await get(path)
    assert.match(
      res.headers.get('content-security-policy') ?? '',
      /default-src 'self'.*frame-ancestors 'none'/,
      `CSP missing on ${path}`,
    )
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff', path)
    assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin', path)
    assert.match(res.headers.get('strict-transport-security') ?? '', /max-age=31536000/, path)
  }
})

test('cache-control follows the path, as the old routes block did', async () => {
  const cases = [
    ['/', 'no-cache'],
    ['/index.html', 'no-cache'],
    ['/assets/main-abc123.js', 'public, max-age=31536000, immutable'],
    ['/fonts/chennai-bold.woff', 'public, max-age=31536000, immutable'],
    ['/img/bg1.jpg', 'public, max-age=604800'],
    ['/sound/odessa.m4a', 'public, max-age=604800'],
  ]

  for (const [path, expected] of cases) {
    const res = await get(path)
    assert.equal(res.headers.get('cache-control'), expected, path)
  }
})

test('an unknown page falls back to index.html with a 200, not a 404', async () => {
  const res = await get('/about-me')

  assert.equal(res.status, 200, 'responseOverrides turned this into a 200')
  assert.match(await res.text(), /site/)
  assert.deepEqual(
    requested.map((r) => r.url),
    [`${ORIGIN}/about-me`, `${ORIGIN}/index.html`],
    'it should try the real path first',
  )
})

test('a missing asset 404s instead of falling back', async () => {
  // Without the exclusions, a mistyped image path returns index.html with a
  // 200 — so a broken asset looks like a successful load of the wrong content
  // type, and like the file exists to anyone debugging it.
  for (const path of ['/img/missing.png', '/sound/missing.mp3', '/assets/missing.js', '/fonts/missing.woff']) {
    const res = await get(path)
    assert.equal(res.status, 404, path)
    assert.equal(requested.length, 1, `${path} must not trigger a second fetch`)
    requested = []
  }
})

test('content types storage gets wrong are corrected', async () => {
  // Safari refuses audio served as application/octet-stream, which would look
  // exactly like the audio bug this repo already spent a session on.
  assert.equal((await get('/sound/odessa.m4a')).headers.get('content-type'), 'audio/mp4')
  assert.equal((await get('/fonts/chennai-bold.woff')).headers.get('content-type'), 'font/woff')
  // Types storage gets right are left alone.
  assert.equal((await get('/img/bg1.jpg')).headers.get('content-type'), 'image/jpeg')
})

test('range requests are forwarded and 206 is passed through', async () => {
  const res = await get('/sound/odessa.m4a', { headers: { range: 'bytes=0-6' } })

  assert.equal(res.status, 206, 'seeking in the ambient track depends on this')
  assert.equal(res.headers.get('content-range'), 'bytes 0-6/1000')
  assert.equal(res.headers.get('accept-ranges'), 'bytes')
  assert.equal(requested[0].headers.get('range'), 'bytes=0-6')
})

test('storage identifiers are not leaked to the visitor', async () => {
  const res = await get('/')

  for (const header of ['x-ms-request-id', 'x-ms-version', 'server']) {
    assert.equal(res.headers.get(header), null, `${header} names the backing account`)
  }
})

test('the query string is not forwarded to storage', async () => {
  // Storage assigns its own meaning to query parameters — SAS fields, `comp` —
  // so forwarding whatever a caller invents is handing them a lever.
  await get('/index.html?comp=list&restype=container')

  assert.equal(requested[0].url, `${ORIGIN}/index.html`)
})

test('write methods are refused', async () => {
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const res = await get('/index.html', { method })
    assert.equal(res.status, 405, method)
    assert.equal(res.headers.get('allow'), 'GET, HEAD')
  }
})

test('the edge is told how long to hold each class of asset', async () => {
  await get('/assets/main-abc123.js')
  assert.equal(requested[0].cf.cacheEverything, true)
  assert.equal(requested[0].cf.cacheTtl, 31536000)

  requested = []
  await get('/')
  assert.equal(requested[0].cf.cacheTtl, 60, 'index.html must not be pinned at the edge')
})
