# kyryll.com

Personal site, originally built 2012. This branch preserves the original
exactly as it ran and ports it onto a current toolchain without changing what
it is.

```
faithful/   the port: same site, current stack, responsive, accessible
api/        Azure Function backing the contact form
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
| contact form POSTing to a host that no longer resolves | `/api/contact`, an Azure Function |
| a tracking beacon emailed on every section change | removed |
| sound `.play()` on load (blocked by every browser since 2017) | starts on the visitor's first interaction; speaker hidden on desktop, as the original did |

**Payload:** 18 KB of app JavaScript (6.9 KB gzipped) plus 502 KB of three.js
(126 KB gzipped) loaded *after* the opening sequence, so it never blocks first
paint. The original shipped ~906 KB of unminified JavaScript, all of it
render-blocking in `<head>`.

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
- **No speaker on desktop.** The original showed it on touch devices only,
  where a gesture is required before audio can play. Space bar mutes.

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

Azure Static Web Apps, behind Cloudflare for DNS and CDN.
[.github/workflows/deploy.yml](.github/workflows/deploy.yml) builds `faithful/`
and deploys it with the function in `api/`. Pull requests get their own preview
URL.

One secret is required, as a GitHub encrypted secret:

- `AZURE_STATIC_WEB_APPS_API_TOKEN` — deployment token from the Static Web App

`GITHUB_TOKEN` is provided automatically.

The contact form additionally needs three application settings on the Static
Web App itself. See [api/README.md](api/README.md).

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
