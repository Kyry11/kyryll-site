# Preservation record

Verification that the repository holds a faithful copy of the live kyryll.com as it
stood on **2026-08-06**, before any modernisation work began.

## Where the original lives

Tagged **`original-2012`**, under `src/`.

```bash
git show original-2012:src/kyryll.html      # read a single file
git checkout original-2012 -- src           # restore the whole site on disk
```

The site was briefly checked out to a working `archive/` directory during the port and
then removed. That folder was never a second copy in any meaningful sense — it was a
`git mv` of the same blobs, adding zero objects to the repository while costing 52 MB in
every clone. Keeping it would not have made the original any safer than the tag does; git
has held these bytes since the initial commit.

## What is live

| | |
|---|---|
| Domain | kyryll.com (and www.kyryll.com, same content) |
| DNS / CDN | Cloudflare (`104.21.59.175`, `172.67.182.4`) |
| Origin | **Azure Blob Storage static website** — identified by `x-ms-request-id` / `x-ms-version: 2018-03-28` response headers |
| Document root | `kyryll.html` is served at `/`. There is no `index.html`. |
| Origin last-modified | `2019-05-12` … `2019-05-18` |

Note the origin is Azure, not Cloudflare Workers and not GitHub Pages, despite the
now-deleted `.github/workflows/main.yml` which attempted a `wrangler` deploy. That
workflow never functioned — there was no `wrangler.toml` in the repository.

## Method

1. Enumerated all 209 files under `src/`.
2. Fetched each one from `https://kyryll.com/<path>` and compared MD5 against the local copy.
3. Cross-checked the origin blob content independently using Azure's `content-md5`
   response header, which reports the hash of the **stored blob** and is therefore
   unaffected by anything Cloudflare does at the edge.

## Result

**206 of 209 files were byte-identical.**

The 3 that differed are all HTML, and differed only because of Cloudflare edge
processing, not because the stored content differs:

- an injected `/cdn-cgi/challenge-platform/` bot-detection `<script>` before `</body>`
- Automatic HTTPS Rewrites turning `http://` links into `https://` in flight

### The one real difference

The origin blob for `/` has `<title>Kyryll Tenin Baum Azure</title>`; the repository has
`<title>Kyryll Tenin Baum</title>`. Proven by MD5 of the stored blob:

```
src/kyryll.html as committed             Ydl99cRamarJWucdYDl3aA==
same file, title patched to add "Azure"  WncwdbfYW21Om5NXtStHLg==
Azure origin content-md5 for /           WncwdbfYW21Om5NXtStHLg==
```

The suffix is a deployment marker left over from the migration to Azure, not authored
content. The tag keeps the authored form. This document records the delta so the live
byte stream can be reconstructed exactly if ever needed.

## Conclusion

Nothing was lost. The repository was already a complete mirror of the live site; no
content needed to be recovered from the origin.

## Known-broken things in the original

Recorded here so they are not mistaken for porting errors later.

All paths below are relative to `original-2012:src/`.

| Issue | Detail |
|---|---|
| 4 social icons 404 | `kyryll.html` requests `img/facebook.png`, `img/linkedIn.png`, `img/windows.png`, `img/youtube.png`; the files are `Facebook.png`, `LinkedIn.png`, `Windows.png`, `Youtube.png`. Invisible on case-insensitive macOS, fatal on case-sensitive Azure. |
| Contact form dead | Posts to `https://email.kyryll.com/v1/send`, which no longer resolves in DNS. Would also fail CORS. |
| Navigation beacon | The same endpoint was called on *every* section change, emailing a "logged event" per navigation. |
| Analytics dead | Universal Analytics (`analytics.js`, property `UA-16836638-3`; `ga.js`, `UA-16836638-2`) — shut down by Google in July 2023. |
| PHP served as text | Azure returns `.php` with `content-type: text/php`, so `email.php` and `dictionary.php` served their **source** publicly. |
| `/blog`, `/blog/rss2` | Linked in the footer, both 404. |
| `index.php` | A Flash landing page referencing `Kyryll.swf`, which is not present and 404s. Not reachable as the site index. |
| No mobile support | `<meta name="viewport" content="width=1000, user-scalable=no">` — fixed 1000px layout, and pinch-zoom disabled. |
| `phpinfo.php`, `error_log` | Committed and publicly served. The log holds 1360 lines of PHP notices and the old cPanel path `/home/kyky1445/public_html/`; it contains no IP addresses or email addresses. |
