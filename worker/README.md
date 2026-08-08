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
`Content-Language`, `Content-Disposition`). So the CSP, HSTS and the rest have
nowhere to live, and there is nothing to run the contact form.

Pointing a proxied Cloudflare record straight at the storage endpoint does not
work either, because **kyryll.com is an apex domain**. Azure Storage only
verifies a custom domain through a CNAME on a subdomain — the `asverify` record.
Fetching the storage endpoint from inside the Worker sidesteps that entirely:
storage only ever sees its own hostname and never has to know the site has a
custom domain at all.

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

## Running the tests

From this directory:

```bash
npm test
```

No build step and no Workers runtime needed — the handlers are plain modules
over standard `Request`/`Response`, so `node --test` drives them directly with a
stubbed `fetch` and a `Map`-backed storage stub. The Durable Object tests run
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
