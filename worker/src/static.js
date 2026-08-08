/**
 * Serves the built site out of the Azure Blob Storage `$web` container.
 *
 * This is the half of staticwebapp.config.json that Static Web Apps used to do
 * for free — `routes`, `navigationFallback`, `responseOverrides`, `mimeTypes`.
 * Blob Storage does none of it: it hands back a blob, or a 404 with whatever
 * error document the account is configured with. Everything below is that
 * config, reimplemented.
 */

import { harden } from './http.js'

/*
 * Cache-Control by prefix, straight from the `routes` block of the old config.
 *
 * /assets is Vite's hashed output and /fonts never changes, so both are
 * immutable for a year. Images and audio are stable but not content-hashed —
 * a week, so a replaced file is picked up without a purge. index.html must
 * revalidate every time or a deploy is invisible until the cache ages out.
 */
const CACHE_RULES = [
  { prefix: '/assets/', value: 'public, max-age=31536000, immutable', edgeTtl: 31536000 },
  { prefix: '/fonts/', value: 'public, max-age=31536000, immutable', edgeTtl: 31536000 },
  { prefix: '/img/', value: 'public, max-age=604800', edgeTtl: 604800 },
  { prefix: '/sound/', value: 'public, max-age=604800', edgeTtl: 604800 },
]

const HTML_CACHE = { value: 'no-cache', edgeTtl: 60 }

/*
 * Anything with a file extension that is not a page.
 *
 * The build drops favicon.ico, apple-touch-icon.png and animated_favicon.gif at
 * the root, outside every prefix above. Without this they were treated as
 * pages: revalidated on every request, and — worse — a missing one fell through
 * to index.html and was served as HTML with a 200, so the browser got markup
 * where it asked for an icon and nothing said anything was wrong.
 */
const ASSET_CACHE = { value: 'public, max-age=604800', edgeTtl: 604800 }

function isAsset(path) {
  const slash = path.lastIndexOf('/')
  const dot = path.lastIndexOf('.')
  if (dot <= slash + 1) return false
  return path.slice(dot) !== '.html'
}

/*
 * Prefixes excluded from the fallback, exactly as `navigationFallback.exclude`
 * listed them.
 *
 * Without this a mistyped image path returns index.html with a 200, so a broken
 * asset looks to the browser like a successful load of the wrong content type —
 * and to anyone debugging, like the file exists. A missing asset must 404.
 */
const NO_FALLBACK = ['/img/', '/fonts/', '/sound/', '/assets/', '/api/']

/*
 * Content types Blob Storage gets wrong or omits.
 *
 * `az storage blob upload-batch` infers from the extension and misses these,
 * and the deploy sets them explicitly on upload. This is the safety net for a
 * blob uploaded some other way: without the correct type Safari refuses the
 * audio outright, which would look exactly like the audio bug that started all
 * this.
 */
const MIME_FIXES = {
  '.m4a': 'audio/mp4',
  '.woff': 'font/woff',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
}

/** Request headers worth passing through to storage. */
const FORWARD = ['range', 'if-none-match', 'if-modified-since', 'accept-encoding']

export async function serveStatic(request, env) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const headers = harden(new Headers({ allow: 'GET, HEAD' }))
    return new Response('Method not allowed', { status: 405, headers })
  }

  const url = new URL(request.url)
  const path = url.pathname === '/' ? '/index.html' : url.pathname

  let response = await fromStorage(request, env, path)

  /*
   * The fallback. Static Web Apps rewrote unmatched paths to index.html and,
   * via responseOverrides, returned 200 rather than 404. Blob Storage is
   * configured with index.html as its own error document but serves it with a
   * 404 status, which is the part that has to be corrected here.
   */
  if (response.status === 404 && shouldFallBack(path)) {
    response = await fromStorage(request, env, '/index.html')
    if (response.status === 200) {
      response = new Response(response.body, { status: 200, headers: response.headers })
    }
  }

  return decorate(response, path)
}

function shouldFallBack(path) {
  if (NO_FALLBACK.some((prefix) => path.startsWith(prefix))) return false
  // A request for a file is a request for that file. Only pages fall back.
  return !isAsset(path)
}

async function fromStorage(request, env, path) {
  const origin = String(env.ORIGIN ?? '').replace(/\/+$/, '')
  if (!origin) throw new Error('ORIGIN is not configured')

  /*
   * The query string is deliberately dropped. Nothing the site serves varies by
   * query, and forwarding one to a storage account means forwarding whatever a
   * caller invents — including parameters the Blob REST API assigns its own
   * meaning to, such as SAS fields and `comp`.
   */
  const target = `${origin}${path}`

  const headers = new Headers()
  for (const name of FORWARD) {
    const value = request.headers.get(name)
    if (value) headers.set(name, value)
  }

  const { edgeTtl } = cacheFor(path)

  return fetch(target, {
    method: request.method,
    headers,
    // Storage sends no useful Cache-Control of its own, so the edge is told
    // explicitly how long to hold each class of asset.
    cf: { cacheEverything: true, cacheTtl: edgeTtl },
  })
}

function cacheFor(path) {
  for (const rule of CACHE_RULES) {
    if (path.startsWith(rule.prefix)) return rule
  }
  return isAsset(path) ? ASSET_CACHE : HTML_CACHE
}

function decorate(response, path) {
  const headers = new Headers(response.headers)

  headers.set('cache-control', cacheFor(path).value)

  const extension = path.slice(path.lastIndexOf('.'))
  if (MIME_FIXES[extension]) headers.set('content-type', MIME_FIXES[extension])

  /*
   * Range requests are what let the browser seek in the ambient track and start
   * playing before five minutes of audio has arrived. Storage advertises this;
   * saying so on the way out keeps it true through the Worker.
   */
  headers.set('accept-ranges', 'bytes')

  // Storage's own request identifiers say nothing to a visitor and name the
  // backing account.
  headers.delete('x-ms-request-id')
  headers.delete('x-ms-version')
  headers.delete('x-ms-lease-status')
  headers.delete('x-ms-blob-type')
  headers.delete('server')

  harden(headers)

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
