/**
 * Shared response helpers.
 *
 * The security headers were `globalHeaders` in staticwebapp.config.json. Static
 * Web Apps applied them to everything it served; nothing in Azure Blob Storage
 * can, because a storage account only lets you set a fixed set of blob
 * properties (Cache-Control, Content-Type, Content-Encoding, Content-Language,
 * Content-Disposition) and has no way to emit an arbitrary response header. So
 * the Worker is now the only thing standing between the site and having no
 * CSP at all — they are applied here, in one place, to every response including
 * errors.
 */

export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'geolocation=(), camera=(), microphone=()',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  /*
   * Byte-for-byte the policy from staticwebapp.config.json. 'self' throughout
   * with no 'unsafe-inline' anywhere is only viable because the markup carries
   * no inline script or style — see the note in faithful/index.html. Adding one
   * inline handler silently breaks the page under this policy.
   */
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; media-src 'self'; font-src 'self'; " +
    "style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; " +
    "base-uri 'self'; form-action 'self'",
}

/** Applies the security headers to a response, in place. */
export function harden(headers) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(name, value)
  }
  return headers
}

/** A JSON response, hardened. The API's only response shape. */
export function json(status, body) {
  const headers = new Headers({
    'content-type': 'application/json',
    // API responses are per-request and must never be held at the edge or in
    // the browser; the rate-limit and validation answers are caller-specific.
    'cache-control': 'no-store',
  })
  harden(headers)
  return new Response(JSON.stringify(body), { status, headers })
}
