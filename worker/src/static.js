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
    /*
     * Range is dropped on the way to the fallback. Forwarding it meant
     * `GET /about-me` with `Range: bytes=0-5` came back 206 with a six-byte
     * slice of index.html and index.html's Content-Range — a range over a
     * document the client never asked for. Browsers do not range-request
     * navigations, so this was theory rather than practice, but the honest
     * answer to "that page does not exist, here is the app shell" is the whole
     * shell.
     */
    response = await fromStorage(request, env, '/index.html', { dropRange: true })
    if (response.ok) {
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

async function fromStorage(request, env, path, { dropRange = false } = {}) {
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
    if (dropRange && name === 'range') continue
    const value = request.headers.get(name)
    if (value) headers.set(name, value)
  }

  const { edgeTtl } = cacheFor(path)

  return fetch(target, {
    method: request.method,
    headers,
    /*
     * Storage sends no useful Cache-Control of its own, so the edge is told
     * explicitly how long to hold each class of asset.
     *
     * cacheTtlByStatus, not cacheTtl. The flat form applies the TTL whatever
     * the status, so a 404 for a hashed asset — entirely possible for a few
     * seconds mid-deploy, since a blob upload is not atomic — would have been
     * held at the edge for a year. Failures get seconds; only success gets the
     * long TTL.
     */
    cf: {
      cacheEverything: true,
      cacheTtlByStatus: {
        '200-299': edgeTtl,
        '304': edgeTtl,
        '404': 5,
        '400-403': 5,
        '405-499': 5,
        '500-599': 0,
      },
    },
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

  // 2xx and 304 only. Everything else is a failure, and a failure must not
  // inherit the asset policy — `immutable, max-age=31536000` on a 404 for a
  // hashed bundle pins that 404 in the visitor's browser for a year, which no
  // purge can undo and no redeploy can reach.
  const succeeded = response.ok || response.status === 304
  headers.set('cache-control', succeeded ? cacheFor(path).value : 'no-store')

  if (succeeded) {
    const extension = path.slice(path.lastIndexOf('.'))
    // Applied only on success for the same reason: on a 404 this labelled
    // storage's HTML error document as audio/mp4, and with nosniff set the
    // browser got a body it could not decode and no explanation.
    if (MIME_FIXES[extension]) headers.set('content-type', MIME_FIXES[extension])
  }

  /*
   * Range requests are what let the browser seek in the ambient track and start
   * playing before five minutes of audio has arrived. Storage advertises this;
   * saying so on the way out keeps it true through the Worker.
   */
  headers.set('accept-ranges', 'bytes')

  /*
   * Swept by prefix, not by name.
   *
   * This was a list of five headers, which is the wrong shape for the job:
   * storage also sends x-ms-creation-time, x-ms-server-encrypted,
   * x-ms-blob-content-md5, x-azure-ref — and x-ms-meta-*, which carries
   * whatever blob metadata the account happens to define and is therefore the
   * header class most likely to name the account. A deny-list defeated the
   * stated purpose while looking like it served it.
   */
  for (const name of [...headers.keys()]) {
    if (name.startsWith('x-ms-') || name.startsWith('x-azure-')) headers.delete(name)
  }
  headers.delete('server')

  harden(headers)

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

/**
 * Last-resort fetch of the origin, used when the normal path has thrown.
 *
 * This is the in-Worker equivalent of what happens when the Worker is disabled
 * altogether: Cloudflare stops intercepting, the proxied apex record carries
 * the request to the storage account, and the site is served raw. The deploy
 * keeps that record pointed at the current account and registers the custom
 * domain so the arrangement genuinely works — this function makes the same
 * thing happen for a Worker that is running but broken.
 *
 * Two deliberate departures from "fail silently":
 *
 *   - The security headers are still applied. A fallback that served the site
 *     without a CSP would turn any bug in this file into a silent security
 *     regression, which is the failure mode the hardened 502 was added to
 *     prevent in the first place. Availability is worth having; it is not worth
 *     that.
 *   - The response is marked no-store. A degraded response must not be cached
 *     and then served long after the Worker recovers.
 *
 * The origin is fetched by its storage hostname rather than by re-requesting
 * kyryll.com. A same-zone subrequest does bypass the Worker and reach the
 * origin, so that would also work, but it depends on subtle routing semantics
 * and on the DNS record being right; this does not.
 */
export async function passthrough(request, env) {
  const origin = String(env.ORIGIN ?? '').replace(/\/+$/, '')
  if (!origin) throw new Error('ORIGIN is not configured')

  const url = new URL(request.url)
  const path = url.pathname === '/' ? '/index.html' : url.pathname

  const get = (at) => fetch(`${origin}${at}`, {
    method: request.method === 'HEAD' ? 'HEAD' : 'GET',
  })

  let response = await get(path)

  /*
   * The fallback applies here too.
   *
   * Without it a degraded /about-me returned storage's error document with a
   * 404 — the site's own navigation broken in a way the normal path handles,
   * and only on the code path that runs when something has already gone wrong.
   * A fallback that quietly changes the site's routing behaviour is worse than
   * one that is obviously absent.
   */
  if (response.status === 404 && shouldFallBack(path)) {
    response = await get('/index.html')
    if (response.ok) {
      response = new Response(response.body, { status: 200, headers: response.headers })
    }
  }

  const headers = new Headers(response.headers)
  for (const name of [...headers.keys()]) {
    if (name.startsWith('x-ms-') || name.startsWith('x-azure-')) headers.delete(name)
  }
  headers.delete('server')
  headers.set('cache-control', 'no-store')
  harden(headers)

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
