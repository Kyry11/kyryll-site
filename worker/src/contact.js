/**
 * POST /api/contact — delivers the contact form.
 *
 * Ported from the Azure Static Web Apps managed function this replaced — it was
 * api/src/functions/contact.js, and is still in git history. Every guard is
 * preserved, in the same order and with the same status codes, because each one
 * is there for a reason. Three things genuinely changed:
 *
 *   1. The email goes out over the ACS REST API rather than the Node SDK,
 *      which cannot run here. See acs.js.
 *   2. The caller's IP comes from CF-Connecting-IP. Cloudflare sets that header
 *      itself and overwrites any client-supplied copy, so it cannot be spoofed
 *      from outside — strictly better than the rightmost-X-Forwarded-For hop
 *      the Azure version had to settle for.
 *   3. The rate limit is KV-backed instead of per-process. See ratelimit.js.
 *
 * The lineage before that: a PHP mail() script that Blob Storage served as
 * source text because it cannot execute PHP, then a GET to a host that no
 * longer resolves, carrying the whole message in the query string and firing on
 * every section change rather than on Send.
 */

import { json } from './http.js'
import { rateLimited } from './ratelimit.js'
import { beginSend, pollOnce, TERMINAL } from './acs.js'

const LIMITS = {
  sendername: 100,
  email: 254,
  phone: 40,
  comments: 5000,
}

/*
 * How long to wait for ACS to reach a terminal state before answering anyway.
 *
 * The 45-second Static Web Apps cut-off that originally set this is gone —
 * Workers bill CPU time, and time spent awaiting a subrequest is not CPU time.
 * The budget stays because the reason behind it was never really the platform:
 * a visitor should not be left watching a spinner while a queue drains, and a
 * bounded wait lets a slow send be reported honestly as accepted rather than
 * as an error.
 */
const POLL_BUDGET_MS = 20_000

/*
 * ACS answers 202 with `retry-after: 20`, which is advice for a batch client,
 * not for someone watching a form — honouring it would spend the entire budget
 * before the first poll, so it is deliberately ignored. Starting short and
 * backing off gently gives roughly eight polls inside the budget: responsive
 * for the common case where the send completes almost at once, without
 * hammering the service on the slow one.
 */
const FIRST_POLL_MS = 400
const MAX_POLL_INTERVAL_MS = 4000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export async function handleContact(request, env, log = console) {
  /*
   * Reject anything that is not a JSON object *before* reading properties off
   * it. JSON.parse accepts bare literals, so a body of exactly `null` parses
   * successfully and then throws on the first property access — an unhandled
   * exception on a public endpoint from a four-byte payload.
   */
  const contentType = request.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) {
    return json(415, { message: 'Expected application/json' })
  }

  if (!sameOrigin(request)) {
    return json(403, { message: 'Cross-origin submissions are not accepted' })
  }

  let body
  try {
    body = await request.json()
  } catch {
    return json(400, { message: 'Expected a JSON body' })
  }

  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return json(400, { message: 'Expected a JSON object' })
  }

  // Honeypot. The form ships a field no human sees; anything that fills it is a
  // bot, and gets a cheerful 200 so it does not retry.
  if (typeof body.website === 'string' && body.website.trim() !== '') {
    log.log('Honeypot triggered, discarding submission')
    return json(200, { message: 'Message has been sent' })
  }

  const fields = {
    sendername: str(body.sendername),
    email: str(body.email),
    phone: str(body.phone),
    comments: str(body.comments),
  }

  const problem = validate(fields)
  if (problem) return json(400, problem)

  const { limited, degraded } = await rateLimited(env.RATE_LIMIT, clientIp(request))
  if (limited) {
    return json(429, { message: 'Too many messages from here. Try again later.' })
  }
  if (degraded) {
    log.warn('Rate limit store unavailable; submission allowed uncounted')
  }

  const connectionString = env.COMMUNICATION_SERVICES_CONNECTION_STRING
  const sender = env.CONTACT_SENDER_ADDRESS
  const recipient = env.CONTACT_RECIPIENT_ADDRESS

  if (!connectionString || !sender || !recipient) {
    log.error('Email is not configured; see worker/README.md')
    return json(500, { message: 'Could not reach the server' })
  }

  try {
    const operation = await beginSend({
      connectionString,
      sender,
      recipient,
      replyTo: { address: fields.email, displayName: fields.sendername },
      subject: `New site message — ${fields.sendername}`,
      text: [
        `Name:  ${fields.sendername}`,
        `Email: ${fields.email}`,
        `Phone: ${fields.phone || '—'}`,
        '',
        fields.comments,
      ].join('\n'),
    })

    // Overridable so the slow-send test does not have to burn the real budget
    // on every CI run; unset in production, where the constant applies.
    const budget = Number(env.POLL_BUDGET_MS) || POLL_BUDGET_MS
    const outcome = await awaitOutcome(operation, budget)

    if (outcome.status === 'TimedOut') {
      log.warn(`Email still sending after ${budget}ms; returning 202`)
      return json(202, { message: 'Message accepted — it is on its way' })
    }

    /*
     * The operation reaches a terminal state for failures too. Ignoring the
     * status meant a rejected or dropped send was reported to the visitor as
     * "Message has been sent", which is the worst possible answer: they believe
     * they have reached you and stop trying.
     *
     * Note what Succeeded actually means: ACS has accepted and processed the
     * message for delivery. It is not confirmation that a mailbox received it —
     * that needs Event Grid or the operational logs. So this distinguishes
     * "ACS refused it" from "ACS took it", and no further.
     */
    if (outcome.status !== 'Succeeded') {
      log.error('Email did not succeed', outcome.status, outcome.error)
      return json(502, {
        message: 'The message could not be delivered. Please email me directly.',
      })
    }

    return json(200, { message: 'Message has been sent, I will get back to you sooon' })
  } catch (error) {
    log.error('Send failed', error)
    return json(502, { message: 'Could not reach the server' })
  }
}

/**
 * Polls until terminal or until the budget runs out.
 *
 * Returns `{ status: 'TimedOut' }` rather than throwing on expiry: a send that
 * is merely slow is not a failure, and the caller reports it as 202.
 *
 * Unlike the Azure version there is nothing to abort. That code had to cancel
 * the losing poller explicitly, because pollUntilDone() kept running against
 * the service after the handler returned and a warm worker accumulated them.
 * Here the loop simply stops; no request survives its own response.
 */
async function awaitOutcome(operation, budgetMs) {
  const deadline = Date.now() + budgetMs

  if (TERMINAL.has(operation.status)) return { status: operation.status }

  let wait = FIRST_POLL_MS

  for (;;) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) return { status: 'TimedOut' }

    /*
     * Always poll after sleeping, never sleep and then give up. An earlier
     * arrangement checked the clock again after the sleep and broke out, so
     * when the remaining budget was shorter than the interval it burnt what was
     * left and reported a timeout without ever having asked — turning any send
     * slower than the first interval into a 202 regardless of its real outcome.
     */
    await sleep(Math.min(wait, remaining))

    const result = await pollOnce(operation)
    if (TERMINAL.has(result.status)) return result

    wait = Math.min(wait * 1.5, MAX_POLL_INTERVAL_MS)
  }
}

function str(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function validate(fields) {
  if (!fields.sendername) return { field: 'sendername', message: 'Please fill in your name' }
  if (!fields.email) return { field: 'email', message: 'Please fill in your email' }
  if (!fields.comments) return { field: 'comments', message: 'Please write a message' }

  // Deliberately permissive. The address only has to be plausible enough to
  // reply to; the delivery attempt is the real test.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields.email)) {
    return { field: 'email', message: 'That email address does not look right' }
  }

  for (const [name, max] of Object.entries(LIMITS)) {
    if (fields[name].length > max) {
      return { field: name, message: `That is longer than ${max} characters` }
    }
  }

  // Header injection. The 2012 script checked for this with a regex over the
  // email field only; here nothing user-supplied reaches a header except the
  // reply-to address, which is already constrained by the pattern above.
  if (/[\r\n]/.test(fields.sendername)) {
    return { field: 'sendername', message: 'No injection attacks, sorry' }
  }

  return null
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
function sameOrigin(request) {
  const origin = request.headers.get('origin')
  if (!origin) return true

  try {
    const from = new URL(origin).host
    const host = request.headers.get('host') ?? new URL(request.url).host
    if (host && from === host) return true
    // Vite serves the front end from another port during development.
    return /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(from)
  } catch {
    return false
  }
}
