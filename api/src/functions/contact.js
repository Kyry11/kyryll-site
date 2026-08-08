/**
 * POST /api/contact — delivers the contact form.
 *
 * Replaces the 2012 arrangement, which was:
 *
 *   1. email.php, a PHP mail() script. Azure Blob Storage does not execute
 *      PHP, so it served its own source as text/php to anyone who asked.
 *   2. Later, a GET to https://email.kyryll.com/v1/send with the entire
 *      message in the query string. That host no longer resolves in DNS, so
 *      the form has been dead for years.
 *
 * Neither validated anything much, and the second was called on every section
 * change, mailing a "logged event" containing a visitor id, visit count,
 * first-visit date and the full X-Forwarded-For chain. That is gone: this only
 * runs when someone presses Send.
 */

const { app } = require('@azure/functions')
const { EmailClient, KnownEmailSendStatus } = require('@azure/communication-email')

const LIMITS = {
  sendername: 100,
  email: 254,
  phone: 40,
  comments: 5000,
}

/**
 * Best-effort rate limit, and deliberately no more than that.
 *
 * The counters live in process memory, which on Azure Functions means they are
 * lost on every cold start and are not shared between instances when the host
 * scales out — so the real ceiling is (RATE_MAX x live instances), and it
 * resets whenever the host recycles. An earlier comment here claimed a managed
 * function is "a single shared instance for a site this size"; that is not a
 * guarantee Azure makes, and functions are expected to be stateless.
 *
 * It is kept because it costs nothing and stops the trivial case of somebody
 * holding down Send. Anything stronger belongs where state is durable or where
 * the traffic can be seen in aggregate: a storage-backed counter, or the CDN in
 * front of the site. Do not read this as a defence against a determined or
 * distributed sender.
 */
const RATE_WINDOW_MS = 60 * 60 * 1000
const RATE_MAX = 5

/*
 * Bounded, because the key is attacker-influenced. Without a ceiling a caller
 * cycling addresses grows this without limit, and the sweep below — which
 * walks every key on every request — gets more expensive the harder they try.
 */
const RATE_MAX_KEYS = 10_000
const seen = new Map()

/*
 * How long to wait for Azure to confirm delivery before answering anyway.
 *
 * A Static Web Apps managed API is cut off at 45 seconds. An unbounded
 * pollUntilDone() can outlast that, and the visitor would see a network failure
 * for a message that was in fact accepted and may well arrive. Well inside the
 * limit, so a slow send is reported honestly rather than as an error.
 */
const POLL_BUDGET_MS = 20_000
const POLL_TIMED_OUT = Symbol('poll-timed-out')

app.http('contact', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'contact',
  handler: async (request, context) => {
    /*
     * Reject anything that is not a JSON object *before* reading properties
     * off it. `JSON.parse` accepts bare literals, so a body of exactly `null`
     * parses successfully and then throws on the first property access — an
     * unhandled exception on a public endpoint from a four-byte payload.
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

    // Honeypot. The form ships a field no human sees; anything that fills it
    // is a bot, and gets a cheerful 200 so it does not retry.
    if (typeof body.website === 'string' && body.website.trim() !== '') {
      context.log('Honeypot triggered, discarding submission')
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

    const ip = clientIp(request)
    if (rateLimited(ip)) {
      return json(429, { message: 'Too many messages from here. Try again later.' })
    }

    const connectionString = process.env.COMMUNICATION_SERVICES_CONNECTION_STRING
    const sender = process.env.CONTACT_SENDER_ADDRESS
    const recipient = process.env.CONTACT_RECIPIENT_ADDRESS

    if (!connectionString || !sender || !recipient) {
      context.error('Email is not configured; see api/README.md')
      return json(500, { message: 'Could not reach the server' })
    }

    try {
      const client = new EmailClient(connectionString)

      const poller = await client.beginSend({
        senderAddress: sender,
        replyTo: [{ address: fields.email, displayName: fields.sendername }],
        recipients: { to: [{ address: recipient }] },
        content: {
          subject: `New site message — ${fields.sendername}`,
          plainText: [
            `Name:  ${fields.sendername}`,
            `Email: ${fields.email}`,
            `Phone: ${fields.phone || '—'}`,
            '',
            fields.comments,
          ].join('\n'),
        },
      })

      /*
       * Bounded wait. If Azure has not finished by the budget, stop waiting and
       * tell the truth: accepted, outcome not yet known. 202 is still a success
       * to the browser, so the visitor is not told to retry a message that is
       * probably on its way.
       */
      let timer
      let result
      try {
        result = await Promise.race([
          poller.pollUntilDone(),
          new Promise((resolve) => {
            timer = setTimeout(() => resolve(POLL_TIMED_OUT), POLL_BUDGET_MS)
          }),
        ])
      } finally {
        clearTimeout(timer)
      }

      if (result === POLL_TIMED_OUT) {
        context.warn(`Email still sending after ${POLL_BUDGET_MS}ms; returning 202`)
        return json(202, { message: 'Message accepted — it is on its way' })
      }

      /*
       * The poller resolves for failures too. Ignoring its status meant a
       * rejected or dropped send was reported to the visitor as "Message has
       * been sent", which is the worst possible answer: they believe they have
       * reached you and stop trying.
       */
      if (result?.status !== KnownEmailSendStatus.Succeeded) {
        context.error('Email did not succeed', result?.status, result?.error)
        return json(502, {
          message: 'The message could not be delivered. Please email me directly.',
        })
      }

      return json(200, { message: 'Message has been sent, I will get back to you sooon' })
    } catch (error) {
      context.error('Send failed', error)
      return json(502, { message: 'Could not reach the server' })
    }
  },
})

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
 * The caller's IP, as far as it can be trusted.
 *
 * Not the leftmost X-Forwarded-For entry, which is whatever the client chose
 * to send: a fresh value per request lands in a fresh rate-limit bucket and
 * the limit never fires. Azure's own `x-azure-clientip` is set by the front
 * end and cannot be spoofed from outside, so it wins; failing that, the
 * *rightmost* XFF entry is the one appended by the nearest trusted proxy.
 */
function clientIp(request) {
  const azure = request.headers.get('x-azure-clientip')
  if (azure) return azure.trim()

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
 * its visitors send mail from their own addresses and IPs — spreading the
 * load across exactly the dimension the rate limiter keys on.
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
    const host = request.headers.get('host')
    if (host && from === host) return true
    // Vite serves the front end from another port during development.
    return /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(from)
  } catch {
    return false
  }
}

function rateLimited(ip) {
  const now = Date.now()

  for (const [key, times] of seen) {
    // Timestamps are appended in order, so the first one still inside the
    // window marks where the live entries begin.
    const cut = times.findIndex((t) => now - t < RATE_WINDOW_MS)
    if (cut === -1) seen.delete(key)
    else if (cut > 0) times.splice(0, cut)
  }

  // Map iterates in insertion order, so the front is the oldest bucket.
  while (seen.size >= RATE_MAX_KEYS) {
    const oldest = seen.keys().next()
    if (oldest.done) break
    seen.delete(oldest.value)
  }

  const times = seen.get(ip) ?? []
  if (times.length >= RATE_MAX) return true

  times.push(now)
  seen.set(ip, times)
  return false
}

function json(status, body) {
  return {
    status,
    headers: { 'content-type': 'application/json' },
    jsonBody: body,
  }
}
