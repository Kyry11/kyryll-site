/**
 * Guards that apply to any public endpoint here, kept in one place because
 * /api/contact and /api/track need exactly the same ones and a copy of each
 * would let them drift.
 */

/*
 * The largest body worth reading. The comments field is capped at 5000
 * characters and the other three at 100/254/40, so even with every character
 * three bytes of UTF-8 a legitimate submission is well under this.
 */
export const MAX_BODY_BYTES = 32 * 1024

export class BodyTooLarge extends Error {}

/**
 * Reads the body as text, aborting once it exceeds `limit` bytes.
 *
 * Counts as it streams rather than trusting Content-Length, which is absent on
 * a chunked body and is in any case supplied by the caller. Bodies are UTF-8,
 * so byte length is what matters; the decode happens once at the end.
 */
export async function readBounded(request, limit) {
  if (!request.body) return ''

  const reader = request.body.getReader()
  const chunks = []
  let total = 0

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break

      total += value.byteLength
      if (total > limit) {
        // Stop pulling. Without this the sender keeps streaming into a socket
        // we have already decided to reject.
        await reader.cancel()
        throw new BodyTooLarge()
      }

      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const joined = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    joined.set(chunk, at)
    at += chunk.byteLength
  }

  return new TextDecoder().decode(joined)
}

/**
 * The caller's IP.
 *
 * CF-Connecting-IP is written by Cloudflare on the way in and overwrites
 * anything the client sent under that name, so unlike X-Forwarded-For it is not
 * attacker-controlled. The XFF fallback exists only for running the Worker
 * outside Cloudflare — `wrangler dev` and the tests — and takes the *rightmost*
 * hop, which is the one appended by the nearest trusted proxy. The leftmost is
 * whatever the client chose to send: a fresh value per request would land in a
 * fresh bucket and the limit would never fire.
 */
export function clientIp(request) {
  const connecting = request.headers.get('cf-connecting-ip')
  if (connecting) return connecting.trim()

  const forwarded = request.headers.get('x-forwarded-for')
  if (forwarded) {
    const hops = forwarded.split(',').map((h) => h.trim()).filter(Boolean)
    if (hops.length > 0) return hops[hops.length - 1]
  }

  return 'unknown'
}

/**
 * CORS stops a hostile page *reading* the response; it does not stop the
 * request arriving. A form post with `content-type: text/plain` is a "simple"
 * request that skips preflight entirely, so without this any page could make
 * its visitors send mail from their own addresses and IPs — spreading the load
 * across exactly the dimension the rate limiter keys on.
 *
 * Requests with no Origin at all (curl, server-side callers) are allowed
 * through; they are not the CSRF case, and they still face validation and the
 * rate limit.
 */
export function sameOrigin(request, env = {}) {
  const origin = request.headers.get('origin')
  if (!origin) return true

  try {
    const from = new URL(origin).host
    const host = request.headers.get('host') ?? new URL(request.url).host
    if (host && from === host) return true

    /*
     * Vite serves the front end from another port during development, so a
     * localhost origin has to be allowed — but only in development.
     *
     * This was unconditional, carried over verbatim from the Azure function
     * where it was equally wrong. In production it meant any page served from
     * the visitor's own machine — a dev server, an Electron app's local HTTP
     * server, a locally installed tool with an XSS — could drive this endpoint
     * from their address. Narrow, but there is no reason to leave it open, and
     * the gate costs one variable that production never sets.
     */
    if (env.ALLOW_LOCALHOST_ORIGIN === 'true') {
      return /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(from)
    }

    return false
  } catch {
    return false
  }
}
