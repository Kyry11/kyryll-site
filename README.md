# kyryll.com

Personal site, originally built 2012. This branch preserves the original
exactly as it ran and ports it onto a current toolchain without changing what
it is.

```
faithful/   the port: same site, current stack, responsive, accessible
worker/     the Cloudflare Worker: serves the site, and the contact API
```

The 2012 original is tagged **`original-2012`** rather than kept as a folder —
it is the same blobs git has held since the initial commit, so a working copy
adds nothing to its safety and 52 MB to every clone.

```bash
git show original-2012:src/kyryll.html      # read a single file
git checkout original-2012 -- src           # restore the whole site on disk
```

## Preservation

The tag is a byte-accurate copy of what kyryll.com served. All 209 files were
fetched and compared against the live origin — including Azure's own
`content-md5` for `/`, which reports the hash of the stored blob and so is
immune to anything Cloudflare does at the edge. The method and result are in
[PRESERVATION.md](PRESERVATION.md), along with the list of things that were
already broken in production so they are not mistaken for porting errors.

Restored to disk it runs as static files — but note four images 404 on a
case-sensitive filesystem, and both PHP endpoints and the contact form are
dead.

## The port

Same site. The cold open, the four night scenes, the drifting clouds, the
flocking birds, the inertial section cycling, the ambient track, the envelope
fold and the shatter are all there and behave as they did.

What changed is underneath:

| Before | After |
|---|---|
| jQuery 3.4.1 (and a second copy, 2.0.3) | none |
| `util.js` — 350 KB of concatenated plugins (cooltext, jrumble, label_better, scrollTo/localScroll, Cycle Lite, TweenMax, Howler, FancyZoom) | none — each replaced by platform equivalents or ~30 lines of TypeScript |
| three.js r62 with `CanvasRenderer` | three.js 0.185 with `WebGLRenderer`, lazy-loaded after the intro |
| no build step, nothing minified | Vite + TypeScript, strict mode |
| `viewport width=1000, user-scalable=no` | responsive, pinch-zoom restored |
| Universal Analytics (dead since July 2023) | none |
| contact form POSTing to a host that no longer resolves | `/api/contact`, handled in the Worker |
| a tracking beacon emailed on every section change | removed |
| sound `.play()` on load (blocked by every browser since 2017) | starts on the visitor's first interaction; speaker hidden on desktop, as the original did |

**Payload:** 29 KB of app JavaScript (11 KB gzipped) across three chunks — the
entry, plus `birds` and `fireworks` split out — and 491 KB of three.js (123 KB
gzipped) loaded *after* the opening sequence, so none of it blocks first paint.
The original shipped ~906 KB of unminified JavaScript, all of it render-blocking
in `<head>`.

### Things that look like bugs and are not

Several decisions here reproduce the original deliberately, and they are easy
to mistake for faults:

- **You cannot scroll.** `body { overflow: hidden }`, as in 2012. The four
  scenes are reachable only through the nav, each arrival animated. It is why
  the site reads as a sequence of composed views rather than a long page.
  Applied from script, so a JS failure degrades to an ordinary scrollable page.
- **The four sky plates are at natural size, not `cover`.** They are one
  continuous 4000px sky — the moon is split across the `bg3`/`bg4` boundary and
  only stitches at 1:1.
- **The flock renders into two canvases.** Not redundancy: `#birdsMain` sits
  under the content column so birds pass behind the text, `#birdsFooter` sits
  above the skyline plate so they pass in front of the city. One element cannot
  be both. The seam between them is computed from the content geometry so it
  always falls below the text panels — load with `?debug` to see it drawn.
- **The cold open always plays.** Skippable by button, click or Escape, but
  never skipped automatically.
- **No speaker on desktop while the sound is playing.** The original showed it
  on touch devices only, where a gesture is required before audio can play.
  Space bar mutes — and the icon reappears whenever the sound is off, because
  hiding it in *both* states made one stray space bar silence every future
  visit with nothing on screen to undo it.

## Running it

```bash
npm install --prefix faithful
```

```bash
npm run dev --prefix faithful
```

```bash
npm run build --prefix faithful
```

`npm run build` typechecks before bundling, so a type error fails the build.

## Deployment

A Cloudflare Worker in front of an Azure Blob Storage static website.
[.github/workflows/deploy.yml](.github/workflows/deploy.yml) builds `faithful/`,
uploads it to the `$web` container, deploys the Worker, and purges the cache.

It is two jobs, and the split is a security boundary rather than tidiness.
`validate` builds and tests on every trigger and holds **no secrets at all**;
`deploy` carries the credentials and only comes into existence for a push to
`master`. A single job with the secrets at job scope exposed them to everything
it ran — including pull-request code and every package in the install tree —
and a deploy-time `if:` does nothing about that, because the secrets are already
on the runner by then. `deploy` names a `production` environment, so the secrets
can be moved from repository scope to that environment and put behind a required
reviewer if you ever want it.

The Worker is the whole edge — it serves the build, applies the response
headers, rewrites unmatched paths to index.html, and hosts `/api/contact`.
Storage does none of that: it has no compute, and a storage account cannot emit
an arbitrary response header at all. See [worker/README.md](worker/README.md).

It replaced Azure Static Web Apps, which bundled all four jobs. Fetching the
storage endpoint from inside the Worker means storage only ever sees its own
hostname, so the main serving path does not depend on Azure knowing the custom
domain exists at all. (The deploy registers it anyway, for the fallback — see
below.)

Five GitHub encrypted secrets:

| Secret | What it is |
|---|---|
| `AZURE_CREDENTIALS` | Service principal JSON for `azure/login` |
| `AZURE_RESOURCE_GROUP` | Resource group holding the storage account |
| `AZURE_STORAGE_ACCOUNT` | Storage account name |
| `CLOUDFLARE_API_TOKEN` | See the scopes below |
| `CLOUDFLARE_ACCOUNT_ID` | Required by wrangler |

`AZURE_LOCATION` is optional and defaults to `australiaeast`.
`CLOUDFLARE_ZONE_ID` is optional; without it the cache is not purged and a
deploy is visible once the edge TTL expires.

The Cloudflare token needs five scopes:

| Scope | Permission | Why |
|---|---|---|
| Account | Workers Scripts: Edit | uploads the Worker and its Durable Object |
| Zone | Workers Routes: Edit | binds `kyryll.com/*` |
| Zone | Zone: Read | `wrangler.toml` resolves the zone by `zone_name` |
| Zone | DNS: Edit | the `asverify` record and the apex record |
| Zone | Cache Purge: Purge | the final step |

Zone: Read is the one people miss — without it wrangler cannot turn
`zone_name = "kyryll.com"` into a zone and fails at route creation, having
appeared to work. Cache Purge has no *Edit* level, only Purge.

Until those exist the workflow still installs, typechecks, builds and runs the
Worker's tests — it skips only the deploy and says so, rather than failing. A
red check that only ever means "nothing is provisioned yet" teaches everyone to
ignore red checks. On `master` it is not optional: a push there with secrets
missing fails loudly, because the alternative is the site quietly ceasing to
update.

Pull requests build and test but never deploy. There is one environment;
previews would need a second storage account and a Worker route per branch.

Assets dropped from a build are not deleted immediately — they are kept for
seven days. A page that is already open goes on requesting hashed chunks long
after its HTML arrived (`fireworks` three seconds in, `birds` about ten seconds
later), and index.html itself is edge-cached for a minute, so deleting a
departed hash on the spot breaks visitors who are mid-visit. Everything in the
current build is re-uploaded every deploy, so anything still in use keeps a
fresh timestamp and never ages out.

A Worker route only fires for a hostname that already has a **proxied** DNS
record. Once the route exists the Worker intercepts before the origin is
consulted, so nothing about serving the site depends on where that record
points — but deleting it, or turning the proxy off, takes the site down.

### The fallback

The deploy keeps that record pointed at the current storage account and
registers the account's custom domain, so switching the Worker off leaves a
working site rather than a broken one. Azure only answers to `Host: kyryll.com`
if the domain is registered, and verification goes through an `asverify` CNAME —
the indirect method — so the apex record is never unproxied or repointed and
there is no outage window. That is also why the apex being a zone apex is not
the obstacle it first appears: the record Azure inspects is a subdomain either
way.

The apex step is deliberately non-destructive. That record is what makes the
route fire at all, so it updates a CNAME it finds and creates one where the apex
is empty, but if it finds A/AAAA records it reports and stops rather than
deleting them.

**On origin TLS.** An earlier version of this section claimed the fallback
needed SSL/TLS mode `Full` rather than `Full (Strict)`. That was wrong. In
Full (Strict) Cloudflare validates the origin certificate against the *target*
hostname — the CNAME target — and Azure serves a valid public certificate for
`*.z8.web.core.windows.net`. The zone runs Full (strict) today and has been
serving from blob storage through Cloudflare the whole time, which settles it.
Nothing here requires weakening origin authentication.

**On apex custom domains.** Microsoft's custom-domain page is written around
the direct CNAME method, which a root domain cannot satisfy. The indirect
`asverify` method verifies a *subdomain* record, and apex registration works:
this subscription already has `kyryll.com`, `cronti.me` and `no1.gives`
registered on storage accounts that way.

**One real constraint.** A custom domain belongs to exactly one storage account
at a time. If it is still held elsewhere the deploy names the holder and the
command to clear it, then skips rather than failing — the site does not depend
on the fallback, so losing it is not a reason to stop shipping. The apex step
logs whether the fallback is actually live, so a half-configured state says so
rather than waiting to be discovered during an incident.

The contact form additionally needs three Worker secrets, set once with
`wrangler secret put` so the workflow never handles them. See
[worker/README.md](worker/README.md).

## Security note

The workflow this replaces committed a Cloudflare API token in plain text from
April 2021, in a repository that has been public. **The token has been revoked.**

The string is still reachable in history and always will be — deleting a file
does not remove its content from earlier commits, and rewriting history to
purge it would break every existing clone and reference for no benefit now that
the credential is dead. It can be seen at:

```bash
git show original-2012:.github/workflows/main.yml
```

Left there deliberately, and not repeated here: a revoked token is a historical
record, but writing it into a current file would trip every secret scanner
pointed at this repository from now on.

`phpinfo.php` and `error_log` are preserved at the tag for the record and are
not deployed. The log contains PHP notices and an old cPanel path; it has no IP
addresses, credentials, or email addresses.

## Content

The copy is still the 2012 text, deliberately — the technology rebuild and the
content refresh are separate passes. It refers to Visual Studio 2013, .NET
1–4.5, "10+ years", and a work history ending at procQ.

Two dead links were dropped rather than preserved: the WordPress blog at
`/blog` and its RSS feed, both of which 404 on the live site.
