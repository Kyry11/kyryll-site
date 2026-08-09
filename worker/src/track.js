/**
 * POST /api/track — the 2012 site's visit tracking, restored.
 *
 * The original called a `logEvent` endpoint on every section change and emailed
 * the result: a visitor id, a visit count, the date of the first visit, and the
 * whole X-Forwarded-For chain. The port removed it, and this puts it back on a
 * route of its own rather than folded into the contact endpoint, because the
 * two want different limits and different failure behaviour.
 *
 * Everything here answers 204, always.
 *
 * That is the point rather than laziness. A rate limiter that answers 429 tells
 * whoever hit it exactly where the ceiling is and how to pace themselves under
 * it; one that keeps answering 204 does not distinguish "recorded" from
 * "dropped", so the limit cannot be measured from outside. The same reasoning
 * covers a malformed body, a cross-origin post and an unconfigured mailbox: a
 * beacon has nothing useful to do with any answer, so none is given.
 *
 * The consequence worth stating plainly: this endpoint is unobservable when it
 * breaks. Nothing on the site will look wrong. The only evidence is mail that
 * stops arriving, and the Worker's own logs.
 */

import { harden } from './http.js'
import { rateLimited } from './ratelimit.js'
import { beginSend } from './acs.js'
import { MAX_BODY_BYTES, BodyTooLarge, readBounded, clientIp, sameOrigin } from './request.js'

/*
 * Ten events per IP per hour, as asked. Enough for a visitor to arrive and move
 * through all four scenes several times; short of anything that would fill a
 * mailbox. The window matches the contact form's so there is one rule to
 * remember rather than two.
 */
const TRACK_LIMIT = 10

/** Fields the beacon may set, and how much of each is kept. */
const FIELDS = {
  event: 40,
  section: 40,
  referrer: 300,
  visitor: 64,
  visits: 12,
  first: 40,
}

/** The only response this route ever gives. */
function nothing() {
  const headers = harden(new Headers({ 'cache-control': 'no-store' }))
  return new Response(null, { status: 204, headers })
}

export async function handleTrack(request, env, ctx, log = console) {
  try {
    const essence = (request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
    if (essence !== 'application/json') return nothing()
    if (!sameOrigin(request, env)) return nothing()

    let body
    try {
      body = JSON.parse(await readBounded(request, MAX_BODY_BYTES))
    } catch (error) {
      if (!(error instanceof BodyTooLarge)) log.warn('Unreadable tracking beacon')
      return nothing()
    }

    if (body === null || typeof body !== 'object' || Array.isArray(body)) return nothing()

    const ip = clientIp(request)

    const { limited } = await rateLimited(env.RATE_LIMITER, `track:${ip}`, TRACK_LIMIT)
    if (limited) return nothing()

    const connectionString = env.COMMUNICATION_SERVICES_CONNECTION_STRING
    const sender = env.CONTACT_SENDER_ADDRESS
    const recipient = env.CONTACT_RECIPIENT_ADDRESS
    if (!connectionString || !sender || !recipient) return nothing()

    /*
     * Queued, not awaited. A beacon is fired as the visitor moves between
     * scenes and sometimes as the page unloads; making them wait on an email
     * round trip would be a self-inflicted delay in the one place the site is
     * meant to feel unhurried. waitUntil keeps the Worker alive for the send
     * after the 204 has already gone.
     */
    ctx?.waitUntil?.(
      send({ connectionString, sender, recipient, ip, request, body }).catch((error) => {
        log.error('Tracking email failed', error)
      }),
    )
  } catch (error) {
    // Tracking must never be the reason a visitor sees an error.
    log.error('Tracking failed', error)
  }

  return nothing()
}

async function send({ connectionString, sender, recipient, ip, request, body }) {
  const field = (name) => {
    const value = body[name]
    if (typeof value === 'string') return value.slice(0, FIELDS[name])
    if (typeof value === 'number') return String(value).slice(0, FIELDS[name])
    return ''
  }

  const event = field('event') || 'visit'
  const section = field('section')

  /*
   * Cloudflare's own view of where the request came from. The original mailed
   * the raw X-Forwarded-For chain, which was both less accurate — the leftmost
   * hop is whatever the client claimed — and less useful than this.
   */
  const geo = request.cf ?? {}
  const place = [geo.city, geo.region, geo.country].filter(Boolean).join(', ')

  const lines = [
    `Event:    ${event}${section ? ` — ${section}` : ''}`,
    `From:     ${ip}${place ? ` (${place})` : ''}`,
    `Visitor:  ${field('visitor') || 'unknown'}`,
    `Visit:    ${field('visits') || '?'}, first seen ${field('first') || 'unknown'}`,
    `Referrer: ${field('referrer') || 'none'}`,
    `Agent:    ${(request.headers.get('user-agent') ?? '').slice(0, 300)}`,
  ]

  const operation = await beginSend({
    connectionString,
    sender,
    recipient,
    replyTo: { address: recipient, displayName: 'kyryll.com' },
    subject: `kyryll.com — ${event}${section ? `: ${section}` : ''}`,
    text: lines.join('\n'),
  })

  /*
   * Deliberately not polled. The contact form waits for a terminal status
   * because a visitor is owed an honest answer about their message; nobody is
   * waiting on this one, and polling would hold the Worker open for a result
   * that changes nothing. The 202 from ACS is enough.
   */
  return operation
}

export const TRACKING = { LIMIT: TRACK_LIMIT }
