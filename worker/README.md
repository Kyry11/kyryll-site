# worker/

The Cloudflare Worker that serves kyryll.com. It is the whole edge: the site
itself comes from an Azure Blob Storage static website, and everything around it
happens here.

```
src/index.js      routing
src/static.js     serving the build out of blob storage
src/http.js       security headers, JSON responses
src/contact.js    POST /api/contact
src/track.js      POST /api/track
src/request.js    guards shared by both endpoints
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

## `POST /api/track`

The 2012 site's visit tracking, restored. The original called an endpoint on
every section change and emailed the result — visitor id, visit count, date of
first visit — and this does the same, on a route of its own.

**It answers 204 to everything.** Recorded, rate limited, malformed,
cross-origin, unconfigured, broken: one response. That is deliberate. A limiter
that answers 429 tells whoever hit it exactly where the ceiling is and how to
pace themselves beneath it; one that never varies cannot be measured from
outside.

The cost of that is worth stating plainly: **this endpoint is unobservable when
it breaks.** Nothing on the site will look wrong. The only evidence is mail that
stops arriving, and the Worker's logs.

| | |
|---|---|
| Per sender | 10 events per IP per hour, in its own bucket — browsing cannot spend the contact form's five |
| Across everyone | **100 events every 2 hours**, one bucket shared by the whole zone |
| Origin | Required, and must be this host over HTTPS — stricter than the contact form, which allows callers with no `Origin` |
| Fields | `event` and `section` are allowlisted; free text is truncated; body capped at 32 KB |
| Send | Queued with `waitUntil` and not polled — nobody is waiting on the result, unlike the contact form |
| Payload | Event, section, referrer, visitor id, visit count, first-seen date, plus the IP and Cloudflare's geo |

### Two ceilings, and why

A per-IP cap bounds one sender and nothing else. The route is reachable by
anything that can make an HTTPS request, so a hundred addresses is a hundred
times ten emails and the bill is real. The zone ceiling is the spend limit; the
per-IP one just stops a single visitor using it all.

The origin check is not authentication — anything can forge a header — but it
stops the route being trivially scriptable, and the ceilings are what actually
bound the damage.

**Both ceilings fail closed.** If the limiter is unavailable, unreachable, or
answers with anything other than a real boolean — unreadable, or valid JSON that
simply does not say — the event is dropped. That is the opposite of
what the contact form does with the same signal, and both are right: a message
from a real person is worth more than an accurate count, while an optional
beacon is worth less than the email it would cost. Failing open here would mean
a limiter outage removed the only ceiling on ACS spend.

A Cloudflare rate-limiting rule at the zone level is still worth adding in front
of all this. It is enforced at the edge before the Worker runs, so unlike these
it also costs nothing to serve.

If the volume ever becomes a nuisance, the cheaper shape is to batch — one
summary email per visit rather than one per event — or to track only `arrived`.
Both are small changes; neither is done here because the ask was to restore what
the original did.

`faithful/src/modules/track.ts` is the other half: `sendBeacon` where available
so the last event of a visit survives the page closing, `fetch(keepalive)`
otherwise, everything fire-and-forget and every path wrapped, because it is the
least important code on the page and shares a thread with everything that
matters.

**One thing this does not do is ask.** It records IP addresses and browsing
behaviour, which is personal data; for EU visitors GDPR and ePrivacy apply, and
there is no notice or consent anywhere on the site. That is a decision to make
deliberately rather than one to inherit from 2012.

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

Three secrets. The deploy provisions the Azure resources and sets them on the
first run — see `scripts/deploy/provision-email.sh` — so the only thing you have
to supply is where the mail should land, as the `CONTACT_RECIPIENT_ADDRESS`
repository secret. Without it the provisioning step says so and skips, and the
endpoint keeps answering 500.

It never overwrites a secret that already exists. Rotation is therefore an
explicit act: delete the secret and redeploy. To set them by hand instead:

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
| `CONTACT_RECIPIENT_ADDRESS` | Where messages land |

`CONTACT_SENDER_ADDRESS` is not in that list: the deploy publishes it as a
variable, derived from the linked domain. Setting it by hand as a secret would
shadow the variable, so the deploy removes such a secret if it finds one.

The recipient is a secret deliberately: it is a real inbox and this repository
is public.

`CONTACT_SENDER_ADDRESS` is a **variable**, not a secret. It is a public From
address, so nothing is gained by hiding it and a great deal is lost: a secret
cannot be read back, so the deploy could only guess whether it was current — and
it guessed by watching for changes it made itself. Change the linked domain in
the Azure portal instead and the link looks correct, nothing appears to have
changed, and the Worker goes on naming a domain that no longer exists. Every
send fails and no redeploy repairs it. As a variable it is rewritten on every
deploy from whatever Azure reports is linked, including the local part, which is
read from the domain's registered sender usernames rather than assumed to be
`donotreply`.

Every read behind that is fail-stop. A read that fails is not treated as
evidence that nothing is linked, and an unreadable or empty list of sender
usernames is not treated as evidence that `donotreply` is valid — in both cases
the deploy leaves the existing configuration alone rather than publishing a
guess. The deploy also passes `--keep-vars`, so a run that could not work the
sender out does not delete the one that was working.

`ORIGIN` is not a secret either, and is not known until the storage account exists,
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
