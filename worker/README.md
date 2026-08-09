# worker/

The Cloudflare Worker that serves kyryll.com. It is the whole edge: the site
itself comes from an Azure Blob Storage static website, and everything around it
happens here.

```
src/index.js      routing
src/static.js     serving the build out of blob storage
src/http.js       security headers, JSON responses
src/contact.js    POST /api/contact
src/acs.js        Azure Communication Services, over REST
src/ratelimit.js  rate limiting, in a Durable Object
```

## Why a Worker and not just Cloudflare's proxy

Blob Storage is storage. It has no compute, and it cannot emit an arbitrary
response header — a storage account only lets you set a fixed set of blob
properties (`Cache-Control`, `Content-Type`, `Content-Encoding`,
`Content-Language`, `Content-Disposition`).

That does **not** mean a Worker was the only way to get response headers. It is
worth being exact, because the obvious reading is wrong: Cloudflare Transform
Rules can set any response header at the edge with no code at all, and the
sibling repo this deploy is modelled on does precisely that — it upserts a
ruleset in the `http_response_headers_transform` phase for its own headers.
Cache Rules cover the per-path TTL policy, and an Origin Rule with Host Header
Override would even have solved the apex problem. A Worker-free version of the
static half was entirely feasible.

Three things forced this one, and only these three:

1. **`/api/contact` needs compute**, on the same origin — otherwise the
   `sameOrigin()` CSRF check and `connect-src 'self'` both break. No
   arrangement of rules provides that.
2. **The fallback rewrites a status code.** A missing page must return
   index.html with a **200**, and Transform Rules cannot change a status code.
3. **The storage headers are stripped by prefix.** Removal in a Transform Rule
   is by exact name, and `x-ms-meta-*` is open-ended — the account can define
   any metadata key it likes, so the set is not enumerable in advance.

Given the first of those made a Worker unavoidable, doing the rest in the same
place beat splitting the behaviour across three Cloudflare rulesets *and* code.
That is a preference about where the logic lives, not a claim that it had
nowhere else to go.

Fetching the storage endpoint from inside the Worker means storage only ever
sees its own hostname, so the main path never depends on Azure knowing the
custom domain exists. The deploy registers it anyway, through the indirect
`asverify` method, so the proxied apex record stays a working fallback if the
Worker is ever disabled.

That replaced an Azure Static Web App, which had bundled four separate jobs:
serving the build, applying response headers, rewriting unmatched paths to
index.html, and hosting the API. All four are now in this directory, and the old
`staticwebapp.config.json` is gone — `static.js` is that file as code, with the
tests in `test/static.test.mjs` standing in for the guarantees the platform used
to make.

## `POST /api/contact`

```json
{
  "sendername": "…",
  "email": "…",
  "phone": "…",
  "comments": "…",
  "website": ""
}
```

`website` is a honeypot — hidden off-screen in the form, and a submission that
fills it is silently discarded with a 200.

| Status | Meaning |
|---|---|
| 200 | ACS accepted and processed the message for delivery (or honeypot silently discarded). **Not** confirmation that a mailbox received it — `Succeeded` means "out for delivery", and real delivery confirmation needs Event Grid or the operational logs. |
| 202 | Accepted, but the send had not reached a terminal state within 20s. The wait is bounded so the visitor is told the truth rather than left watching a spinner while a queue drains. |
| 400 | Validation failure. A rejected *field* carries `{ field, message }` and the front end rumbles that field; a malformed body carries `{ message }` alone, with no `field` — read it defensively. |
| 403 | Cross-origin submission. An `Origin` that does not match the host is refused; requests with no `Origin` at all (curl, server-side callers) are allowed through and still face validation and the rate limit. |
| 405 | Not a POST |
| 413 | Body over 32 KB. Checked from Content-Length where present and enforced by counting bytes as they stream, since that header is absent on a chunked body and caller-supplied in any case. The cap sits well above the largest submission the field limits allow. |
| 415 | Content-Type was not application/json |
| 429 | Rate limit tripped: more than 5 submissions from one IP in an hour. See below. |
| 500 | Email is not configured — see Configuration |
| 502 | The send reached a terminal state other than Succeeded, or ACS rejected it outright |

## Rate limiting

A Durable Object, one per IP, holding that IP's recent submission timestamps.

It got there by way of two worse designs, and the second is worth recording
because it looked right:

1. A `Map` in an Azure Function's process memory — lost on every cold start,
   never shared between instances, so the real ceiling was (limit × instances).
2. Workers KV. Durable and shared, which fixed the ceiling. But read-modify-write
   over KV is not atomic, and that turned out to be the whole game: under 100
   concurrent submissions from one IP, all 100 read the same empty bucket, all
   100 were admitted, and 99 writes were lost. **Sequential traffic was limited
   correctly and concurrent traffic was not limited at all** — exactly backwards,
   because for a contact form the abuse case *is* the burst.

A Durable Object serialises requests per object, which is the property the
limiter actually needs. `RateLimiter` also chains its own evaluations rather
than relying on the runtime's input gating alone — belt-and-braces, and it makes
the property testable against a stub that offers no ordering of its own.
`test/ratelimit.test.mjs` issues 100 concurrent requests and asserts that
exactly 5 are admitted.

It still fails open: if the object is unreachable, submissions are allowed
rather than refused. A contact form that rejects everyone because a counter is
down is a worse failure than one that briefly stops counting.

A Cloudflare rate-limiting rule at the zone level is still worth having in front
of this — it is enforced at the edge before the Worker runs, so it also costs
nothing to serve. This is the layer that survives if that is not configured.

## Email

ACS is reached over its REST API rather than `@azure/communication-email`, which
needs Node built-ins the Workers runtime does not provide. Authentication is
Azure's shared-key HMAC scheme.

The signing is the one part of this that cannot be exercised against the real
service without live credentials, and a signature wrong in any detail fails
identically to a wrong access key — a 401, with no hint which of the six inputs
is at fault. So `test/acs.test.mjs` checks it two ways: against an independent
implementation of the documented algorithm written with `node:crypto` and
sharing no code with `src/acs.js`, and against literal pinned values so a change
that breaks both implementations at once still fails.

## Configuration

Three secrets, set once. They persist on the Worker across deploys, so the
deploy workflow never handles them:

```bash
npx wrangler secret put COMMUNICATION_SERVICES_CONNECTION_STRING
```

```bash
npx wrangler secret put CONTACT_SENDER_ADDRESS
```

```bash
npx wrangler secret put CONTACT_RECIPIENT_ADDRESS
```

| Secret | Value |
|---|---|
| `COMMUNICATION_SERVICES_CONNECTION_STRING` | From the Azure Communication Services resource |
| `CONTACT_SENDER_ADDRESS` | Verified sender, e.g. `donotreply@<your-domain>` |
| `CONTACT_RECIPIENT_ADDRESS` | Where messages land |

The recipient is a secret deliberately: it is a real inbox and this repository
is public.

`ORIGIN` is not a secret, but it is not known until the storage account exists,
so `wrangler.toml` carries a placeholder and both the deploy and `npm run dev`
pass the real value as `--var`. The rate limiter needs no id at all — a Durable
Object is addressed by class name — so nothing is substituted into that file.

`ALLOW_LOCALHOST_ORIGIN` must never be set in production. It exists so that Vite
serving the front end on another port can post to a locally running Worker; it
relaxes the cross-origin check to accept any localhost page.

## When the Worker fails

An unhandled exception used to reach Cloudflare's own error page: no CSP, no
HSTS, nothing a visitor could interpret. So an availability outage was also a
security-header outage.

Now the site falls back to fetching storage directly — the same outcome as the
Worker being switched off, where the proxied apex record carries the request —
reached from inside a Worker that is running and broken. Two deliberate
departures from failing silently:

- **The security headers are still applied.** A fallback that served the site
  without a CSP would turn any bug in `static.js` into a silent security
  regression, which is the failure the hardened 502 exists to prevent.
- **The response is `no-store`**, so a degraded response is not cached and then
  served long after recovery.

`/api/contact` does not fall back. Storage has nothing that could serve the
endpoint, and returning its HTML error document to a caller expecting JSON is a
worse answer than an honest 502.

If the fallback fetch fails too — storage genuinely unreachable — the hardened
502 still applies.

## Compatibility date

`compatibility_date` in `wrangler.toml` pins runtime behaviour. Advance it
deliberately — bump it, run the suite, deploy, and exercise the contact form —
rather than on a schedule. CI's `--dry-run` proves the config parses and the
bindings resolve; it cannot tell you a behavioural flag changed underneath you,
and that kind of change is invisible until something breaks in production.
Roughly twice a year is enough for a site of this size.

## Running the tests

From this directory:

```bash
npm test
```

No build step and no Workers runtime needed — the handlers are plain modules
over standard `Request`/`Response`, so `node --test` drives them directly with a
stubbed `fetch` and a `Map`-backed storage stub.

Nothing in the suite reads `wrangler.toml`, so CI runs `wrangler deploy
--dry-run` alongside it. Without that, a malformed config or a broken Durable
Object migration passes every check and fails only after merging. The Durable Object tests run
the real `RateLimiter` class over that stub rather than reimplementing its
logic, so a fake cannot quietly agree with a bug.

## Local development

```bash
npm run dev -- --var ORIGIN:https://<account>.z8.web.core.windows.net
```

`ORIGIN` has to be passed. Plain `wrangler dev` leaves it as the literal
`__ORIGIN__`, which is non-empty and so passes the configuration check in
`static.js`, then fails on `fetch("__ORIGIN__/index.html")` — every page request
throws an invalid-URL `TypeError`. Note `web`, not `blob`, in that hostname:
`primaryEndpoints.web` is the static-website endpoint, and the blob endpoint
serves a different thing entirely.

The rate limiter needs no such care — miniflare runs the Durable Object locally
against its own storage, so nothing reaches Cloudflare.

To exercise the contact form against a local front end, add
`--var ALLOW_LOCALHOST_ORIGIN:true`.
