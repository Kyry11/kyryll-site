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
import { MAX_BODY_BYTES, BodyTooLarge, readBounded, clientIp, sameOrigin } from './request.js'

export { clientIp }
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
  /*
   * The essence of the media type, not a substring of the whole header.
   *
   * `includes('application/json')` also matched the *parameter* section, and
   * CORS classifies a request as simple by the essence alone, ignoring
   * parameters — so `text/plain; charset=application/json`,
   * `multipart/form-data; boundary=application/json` and the urlencoded
   * equivalent all sailed through a check whose entire purpose is to force a
   * preflight. sameOrigin() below still stood behind it, but this is meant to
   * be two layers and was one.
   */
  const essence = (request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  if (essence !== 'application/json') {
    return json(415, { message: 'Expected application/json' })
  }

  if (!sameOrigin(request, env)) {
    return json(403, { message: 'Cross-origin submissions are not accepted' })
  }

  /*
   * Bound the body before reading it.
   *
   * request.json() buffers whatever arrives, and Cloudflare accepts request
   * bodies up to 100 MB against a 128 MB isolate limit — so a public endpoint
   * that parses first is one request away from an out-of-memory isolate, and
   * the field-length checks in validate() are far too late to help. The rate
   * limiter is later still, and would not have been reached.
   *
   * MAX_BODY_BYTES is generous against the real payload: the largest legitimate
   * submission is roughly the 5000-character comments limit plus the other three
   * fields, comfortably under 16 KB even with every character multi-byte.
   */
  const declared = Number(request.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return json(413, { message: 'That message is too large' })
  }

  let raw
  try {
    // Content-Length is absent on a chunked body and is attacker-supplied in
    // any case, so the real enforcement is counting the bytes as they arrive.
    raw = await readBounded(request, MAX_BODY_BYTES)
  } catch (error) {
    if (error instanceof BodyTooLarge) {
      return json(413, { message: 'That message is too large' })
    }
    return json(400, { message: 'Expected a JSON body' })
  }

  let body
  try {
    body = JSON.parse(raw)
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

  const { limited, degraded } = await rateLimited(env.RATE_LIMITER, `contact:${clientIp(request)}`)
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
    const outcome = await awaitOutcome(operation, budget, log)

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
async function awaitOutcome(operation, budgetMs, log) {
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

    /*
     * A failed poll is not a failed send.
     *
     * This used to throw straight out to the handler's catch, which answers
     * 502 "could not reach the server" — for a message ACS had already
     * accepted and was going to deliver. It is a regression against the Azure
     * SDK's pollUntilDone(), which retried transient failures internally so a
     * single 429 or 500 never reached the visitor. And ACS throttling the poll
     * is most likely exactly when sends are queuing, so the visitor was told to
     * email directly at the worst moment: they resend, or they give up.
     *
     * Keep polling within the budget instead. If nothing terminal arrives the
     * loop expires into the 202 path, which is the truthful answer — accepted,
     * outcome not yet known.
     */
    let result
    try {
      result = await pollOnce(operation)
    } catch (error) {
      log?.warn?.('Poll failed; the send is still queued, continuing', error)
      wait = Math.min(wait * 1.5, MAX_POLL_INTERVAL_MS)
      continue
    }

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
