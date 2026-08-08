/**
 * Azure Communication Services Email, over the REST API.
 *
 * The @azure/communication-email SDK is not an option here: it pulls in Node
 * built-ins that the Workers runtime does not provide. The wire protocol is
 * small enough to speak directly, and doing so removes the whole SDK from the
 * bundle.
 *
 * Authentication is Azure's shared-key HMAC scheme, documented at
 * learn.microsoft.com/azure/communication-services/tutorials/hmac-header-tutorial.
 * The parts that are easy to get subtly wrong, and are therefore pinned by
 * tests in test/acs.test.mjs:
 *
 *   - the access key is base64 *decoded* before being used as the HMAC key,
 *     not used as raw text;
 *   - the string to sign is `VERB\npathAndQuery\ndate;host;contentHash`, where
 *     pathAndQuery includes the query string, and the last three are joined
 *     with semicolons on one line;
 *   - the content hash is base64(SHA-256(body)) and must be computed over the
 *     exact bytes sent, so the serialised body is passed around as a string and
 *     never re-serialised;
 *   - an empty body still gets a hash — base64(SHA-256("")) — rather than
 *     being omitted, which is what the polling GET needs.
 *
 * `host` is only ever part of the string to sign. The runtime derives the real
 * Host header from the URL and forbids setting it, which is fine: they agree by
 * construction.
 */

/*
 * Pinned rather than floating. 2023-03-31 is the long-standing GA version and
 * is what the SDK spoke; later versions add attachment and tracking fields this
 * does not use, and the send/poll shapes relied on here are identical across
 * them. One line to move if that ever stops being true.
 */
const API_VERSION = '2023-03-31'

/** Terminal states. Anything else means the operation is still in flight. */
export const TERMINAL = new Set(['Succeeded', 'Failed', 'Canceled'])

/**
 * Pulls the endpoint and access key out of an ACS connection string.
 *
 * Format: `endpoint=https://x.communication.azure.com/;accesskey=<base64>`.
 * Order is not guaranteed and the key itself contains `=` padding, so this
 * splits on the first `=` only.
 */
export function parseConnectionString(connectionString) {
  const parts = String(connectionString).split(';')
  let endpoint = ''
  let accessKey = ''

  for (const part of parts) {
    const at = part.indexOf('=')
    if (at === -1) continue
    const name = part.slice(0, at).trim().toLowerCase()
    const value = part.slice(at + 1).trim()
    if (name === 'endpoint') endpoint = value
    else if (name === 'accesskey') accessKey = value
  }

  if (!endpoint || !accessKey) {
    throw new Error('Malformed ACS connection string: need endpoint and accesskey')
  }

  return { endpoint: endpoint.replace(/\/+$/, ''), accessKey }
}

function base64(bytes) {
  let binary = ''
  const view = new Uint8Array(bytes)
  for (let i = 0; i < view.length; i++) binary += String.fromCharCode(view[i])
  return btoa(binary)
}

function fromBase64(text) {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** base64(SHA-256(utf8(content))). Empty content is hashed, not skipped. */
export async function contentHash(content) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content))
  return base64(digest)
}

/**
 * RFC 1123 in GMT, locale-independent.
 *
 * `toUTCString()` is specified to produce exactly this format, so the manual
 * day/month tables the Azure samples use are unnecessary here.
 */
export function rfc1123(date) {
  return date.toUTCString()
}

/**
 * Builds the three auth headers for one request.
 *
 * Split out from send/poll and exported so a test can pin the signature
 * against a fixed key, date and body — the one part of this file that cannot
 * be exercised without real credentials otherwise.
 */
export async function signedHeaders({ method, url, body, accessKey, date }) {
  const target = new URL(url)
  const pathAndQuery = target.pathname + target.search
  const stamp = rfc1123(date)
  const hash = await contentHash(body)

  const stringToSign = `${method}\n${pathAndQuery}\n${stamp};${target.host};${hash}`

  const key = await crypto.subtle.importKey(
    'raw',
    fromBase64(accessKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = base64(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(stringToSign)),
  )

  return {
    'x-ms-date': stamp,
    'x-ms-content-sha256': hash,
    Authorization: `HMAC-SHA256 SignedHeaders=x-ms-date;host;x-ms-content-sha256&Signature=${signature}`,
  }
}

/**
 * Queues one message. Resolves to the operation id and the URL to poll.
 *
 * ACS answers 202 immediately — that means queued, and nothing more. The
 * outcome only exists at the other end of the poll below.
 */
export async function beginSend({ connectionString, sender, recipient, replyTo, subject, text }, now = new Date()) {
  const { endpoint, accessKey } = parseConnectionString(connectionString)
  const url = `${endpoint}/emails:send?api-version=${API_VERSION}`

  const body = JSON.stringify({
    senderAddress: sender,
    recipients: { to: [{ address: recipient }] },
    replyTo: [{ address: replyTo.address, displayName: replyTo.displayName }],
    content: { subject, plainText: text },
  })

  const headers = await signedHeaders({ method: 'POST', url, body, accessKey, date: now })
  headers['content-type'] = 'application/json'

  const response = await fetch(url, { method: 'POST', headers, body })

  if (response.status !== 202) {
    const detail = await response.text().catch(() => '')
    throw new Error(`ACS rejected the send: ${response.status} ${detail.slice(0, 500)}`)
  }

  const operationLocation = response.headers.get('operation-location')
  const payload = await response.json().catch(() => ({}))

  return {
    // Prefer the header: it carries the api-version already, and the id alone
    // would mean reconstructing the URL and guessing the path.
    pollUrl: operationLocation || `${endpoint}/emails/operations/${payload.id}?api-version=${API_VERSION}`,
    accessKey,
    status: payload.status ?? 'NotStarted',
  }
}

/** One poll of the operation. Returns `{ status, error }`. */
export async function pollOnce({ pollUrl, accessKey }, now = new Date()) {
  const headers = await signedHeaders({
    method: 'GET',
    url: pollUrl,
    body: '',
    accessKey,
    date: now,
  })

  const response = await fetch(pollUrl, { method: 'GET', headers })

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`ACS poll failed: ${response.status} ${detail.slice(0, 500)}`)
  }

  const payload = await response.json().catch(() => ({}))
  return { status: payload.status ?? 'Running', error: payload.error }
}
