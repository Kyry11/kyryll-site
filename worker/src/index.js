/**
 * kyryll.com — the whole edge.
 *
 * One Worker in front of an Azure Blob Storage static site. It replaces an
 * Azure Static Web App, which bundled four separate jobs that now live here:
 * serving the built site, applying response headers, rewriting unmatched paths
 * to index.html, and hosting the contact API.
 *
 * Why a Worker rather than pointing Cloudflare's proxy straight at storage:
 * kyryll.com is an apex domain, and Azure Storage will only verify a custom
 * domain via a CNAME on a subdomain — the `asverify` dance. Fetching the
 * storage endpoint from inside the Worker sidesteps the question entirely,
 * because storage only ever sees its own hostname and never needs to know the
 * site has a custom domain at all.
 */

import { serveStatic, passthrough } from './static.js'
import { handleContact } from './contact.js'
import { handleTrack } from './track.js'
import { json, harden } from './http.js'

export { RateLimiter } from './ratelimit.js'

function isApiPath(request) {
  try {
    const { pathname } = new URL(request.url)
    return pathname === '/api' || pathname.startsWith('/api/')
  } catch {
    return false
  }
}

export default {
  async fetch(request, env, ctx) {
    const log = ctx?.console ?? console

    /*
     * Nothing below may reach the runtime uncaught.
     *
     * http.js promises the security headers are applied to every response
     * including errors, and that was false for the one class of error the
     * Worker cannot rule out: storage being unreachable, or ORIGIN
     * misconfigured, threw straight past every response path and surfaced as
     * Cloudflare's own error page — no CSP, no HSTS, no nosniff, and nothing a
     * visitor could interpret. A storage blip became a security-header outage
     * on top of an availability outage.
     */
    try {
      const url = new URL(request.url)

      // Exact `/api` as well as `/api/…`. The old SWA glob missed the bare
      // path too, so this is not a regression, but a typo'd endpoint should
      // read as a missing endpoint rather than quietly returning the site.
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        const endpoint = url.pathname === '/api/contact' || url.pathname === '/api/track'
        if (!endpoint) {
          return json(404, { message: 'No such endpoint' })
        }

        if (request.method !== 'POST') {
          // RFC 9110 requires Allow on a 405.
          const response = json(405, { message: 'Expected POST' })
          response.headers.set('allow', 'POST')
          return response
        }

        if (url.pathname === '/api/track') {
          return await handleTrack(request, env, ctx, log)
        }

        return await handleContact(request, env, log)
      }

      return await serveStatic(request, env)
    } catch (error) {
      log.error('Unhandled failure', error)

      /*
       * The API answers in JSON whatever happens. Falling back to the origin
       * here would return storage's HTML error document to a caller expecting
       * JSON, which is a worse answer than an honest 502 — and there is nothing
       * at the origin that could serve the endpoint anyway.
       */
      if (isApiPath(request)) {
        /*
         * Tracking stays silent even here. Answering 502 on this route and 204
         * everywhere else would hand back exactly the signal the silence is
         * there to withhold.
         */
        if (new URL(request.url).pathname === '/api/track') {
          const headers = harden(new Headers({ 'cache-control': 'no-store' }))
          return new Response(null, { status: 204, headers })
        }
        return json(502, { message: 'Could not reach the server' })
      }

      /*
       * For the site, prefer serving something. This is the same outcome as
       * the Worker being switched off — the proxied apex record carries the
       * request to storage — reached from inside a Worker that is running but
       * broken. The security headers are still applied; see passthrough().
       */
      try {
        return await passthrough(request, env)
      } catch (fallbackError) {
        log.error('Fallback to storage also failed', fallbackError)
      }

      const headers = harden(new Headers({
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
      }))
      return new Response('The site is temporarily unavailable.', { status: 502, headers })
    }
  },
}
