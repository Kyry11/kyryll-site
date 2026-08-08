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
src/ratelimit.js  KV-backed rate limiting
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
| 415 | Content-Type was not application/json |
| 400 | Validation failure. Body carries `{ field, message }`; the front end rumbles that field. |
| 429 | Rate limit tripped: more than 5 submissions from one IP in an hour. See below. |
| 500 | Email is not configured — see Configuration |
| 502 | The send reached a terminal state other than Succeeded, or ACS rejected it outright |

## Rate limiting

Backed by Workers KV, which is a real improvement on what this replaced — a
`Map` in an Azure Function's process memory, lost on every cold start and never
shared between instances, so the true ceiling was (limit × live instances).

It is still not exact, and the honest limits are:

- **Reads are eventually consistent.** A write in one colo can take up to about
  a minute to be visible in another, so a sender hitting several colos at once
  can exceed the limit for roughly that long.
- **Read-modify-write is not atomic.** Two simultaneous requests can both read
  the same count and both write count+1, losing one.
- **It fails open.** If KV is unavailable or the account's daily write quota is
  exhausted, submissions are allowed rather than refused. A contact form that
  rejects everyone because a counter is down is a worse failure than one that
  briefly stops counting.

The exact answer is a Cloudflare rate-limiting rule at the zone level, enforced
at the edge before the Worker runs and subject to none of the above. This is the
cheap layer beneath it, not a substitute for it.

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

`ORIGIN` and the KV namespace id are not secrets, but they are not known until
the resources exist, so `wrangler.toml` carries placeholders that the deploy
workflow substitutes.

## Running the tests

```bash
npm test --prefix worker
```

No build step and no Workers runtime needed — the handlers are plain modules
over standard `Request`/`Response`, so `node --test` drives them directly with a
stubbed `fetch` and a `Map`-backed stand-in for KV.

## Local development

```bash
npx wrangler dev
```

Without substituting the KV placeholder the binding fails to resolve, which is
harmless: `ratelimit.js` treats a missing binding as "no limiter" and fails
open, exactly as it does when KV is unavailable in production.
