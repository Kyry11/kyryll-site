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

import { serveStatic } from './static.js'
import { handleContact } from './contact.js'
import { json } from './http.js'

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)

    if (url.pathname === '/api/contact') {
      if (request.method !== 'POST') {
        return json(405, { message: 'Expected POST' })
      }
      return handleContact(request, env, ctx?.console ?? console)
    }

    // Nothing else under /api exists. Answering in JSON rather than falling
    // through to the site means a typo'd endpoint reads as a missing endpoint,
    // not as a page.
    if (url.pathname.startsWith('/api/')) {
      return json(404, { message: 'No such endpoint' })
    }

    return serveStatic(request, env)
  },
}
