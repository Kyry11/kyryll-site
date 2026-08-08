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
const { EmailClient } = require('@azure/communication-email')

const LIMITS = {
  sendername: 100,
  email: 254,
  phone: 40,
  comments: 5000,
}

/**
 * In-memory rate limit. A Static Web Apps managed function is a single shared
 * instance for a site this size, so a Map is enough to stop casual abuse; it
 * is not a defence against a distributed flood, which is Cloudflare's job.
 */
const RATE_WINDOW_MS = 60 * 60 * 1000
const RATE_MAX = 5
const seen = new Map()

app.http('contact', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'contact',
  handler: async (request, context) => {
    let body
    try {
      body = await request.json()
    } catch {
      return json(400, { message: 'Expected a JSON body' })
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

      await poller.pollUntilDone()

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

function clientIp(request) {
  const forwarded = request.headers.get('x-forwarded-for')
  if (forwarded) return forwarded.split(',')[0].trim()
  return request.headers.get('x-azure-clientip') ?? 'unknown'
}

function rateLimited(ip) {
  const now = Date.now()

  for (const [key, times] of seen) {
    const recent = times.filter((t) => now - t < RATE_WINDOW_MS)
    if (recent.length === 0) seen.delete(key)
    else seen.set(key, recent)
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
