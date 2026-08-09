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
import { MAX_BODY_BYTES, BodyTooLarge, readBounded, clientIp } from './request.js'

/*
 * Ten events per IP per hour, as asked. Enough for a visitor to arrive and move
 * through all four scenes several times; short of anything that would fill a
 * mailbox. The window matches the contact form's so there is one rule to
 * remember rather than two.
 */
const TRACK_LIMIT = 10
const TRACK_WINDOW_MS = 60 * 60 * 1000

/*
 * A ceiling across everybody, not just per visitor.
 *
 * A per-IP cap bounds one sender and nothing else: the route is reachable by
 * anything that can make an HTTPS request, so a hundred addresses is a hundred
 * times ten emails, and the bill is real. This is one bucket shared by the
 * whole zone — a hundred events every two hours, after which the route records
 * nothing until the window rolls.
 *
 * Sized for a personal site: a hundred events is roughly twenty attentive
 * visits, which is a great deal more traffic than this gets and a great deal
 * less than an inbox can absorb. It is a spend ceiling, not a capacity plan.
 */
const ZONE_LIMIT = 100
const ZONE_WINDOW_MS = 2 * 60 * 60 * 1000

/*
 * Only these. Both fields reach an email subject, and an allowlist is the
 * difference between a field and an arbitrary string somebody else chooses.
 */
const EVENTS = new Set(['arrived', 'section'])
const SECTIONS = new Set(['', 'intro', 'about', 'work', 'contact'])

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

    /*
     * Stricter than the contact form, deliberately.
     *
     * sameOrigin() lets a request with no Origin through, because curl and
     * server-side callers are not the CSRF case and a real person may have
     * something to say. Nothing legitimate posts here except a browser on this
     * site, so the header must be present and must match. It is not
     * authentication — anything can forge it — but it stops the route being
     * trivially scriptable, and the two ceilings below are what actually bound
     * the damage.
     */
    if (!fromThisSite(request, env)) return nothing()

    let body
    try {
      body = JSON.parse(await readBounded(request, MAX_BODY_BYTES))
    } catch (error) {
      if (!(error instanceof BodyTooLarge)) log.warn('Unreadable tracking beacon')
      return nothing()
    }

    if (body === null || typeof body !== 'object' || Array.isArray(body)) return nothing()

    const event = pick(body.event, EVENTS, 'arrived')
    const section = pick(body.section, SECTIONS, '')
    if (event === null || section === null) return nothing()

    const ip = clientIp(request)

    /*
     * Per sender first, then across everybody. In that order a single noisy
     * address is stopped by its own bucket before it can spend the shared one.
     *
     * `degraded` drops the event rather than letting it through. The contact
     * form makes the opposite call, and both are right: a message from a real
     * person is worth more than an accurate count, and an optional beacon is
     * worth less than the email it would cost. Failing open here would mean a
     * limiter outage removed the only ceiling on ACS spend.
     */
    const perIp = await rateLimited(env.RATE_LIMITER, `track:${ip}`, TRACK_LIMIT, TRACK_WINDOW_MS)
    if (perIp.limited || perIp.degraded) {
      if (perIp.degraded) log.warn('Rate limiter unavailable; dropping tracking event')
      return nothing()
    }

    const zone = await rateLimited(env.RATE_LIMITER, 'track:zone', ZONE_LIMIT, ZONE_WINDOW_MS)
    if (zone.limited || zone.degraded) {
      if (zone.degraded) log.warn('Rate limiter unavailable; dropping tracking event')
      return nothing()
    }

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
      send({ connectionString, sender, recipient, ip, request, body, event, section }).catch((error) => {
        log.error('Tracking email failed', error)
      }),
    )
  } catch (error) {
    // Tracking must never be the reason a visitor sees an error.
    log.error('Tracking failed', error)
  }

  return nothing()
}

/** Returns the value if it is allowed, the fallback if absent, null if not. */
function pick(value, allowed, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value !== 'string') return null
  return allowed.has(value) ? value : null
}

/**
 * True only for a request a browser on this site could have made.
 *
 * The origin must be present and must be this host over HTTPS. Development is
 * the one exception, and it has to be asked for.
 */
function fromThisSite(request, env = {}) {
  const origin = request.headers.get('origin')
  if (!origin) return false

  try {
    const from = new URL(origin)
    const host = request.headers.get('host') ?? new URL(request.url).host

    if (from.protocol === 'https:' && from.host === host) return true

    if (env.ALLOW_LOCALHOST_ORIGIN === 'true') {
      return /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(from.host)
    }

    return false
  } catch {
    return false
  }
}

async function send({ connectionString, sender, recipient, ip, request, body, event, section }) {
  const field = (name) => {
    const value = body[name]
    if (typeof value === 'string') return value.slice(0, FIELDS[name])
    if (typeof value === 'number') return String(value).slice(0, FIELDS[name])
    return ''
  }

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

export const TRACKING = {
  LIMIT: TRACK_LIMIT,
  WINDOW_MS: TRACK_WINDOW_MS,
  ZONE_LIMIT,
  ZONE_WINDOW_MS,
}
