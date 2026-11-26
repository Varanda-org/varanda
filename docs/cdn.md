# Media origin (CDN edge), off by default

An installation may name a second origin, the media origin, from which the web app and the native app load public diary photos and videos. It is meant for a CDN edge in front of `/media`. It is off by default: with no key, every byte comes from the installation as before, and nothing in this document applies.

**Enabling it needs the Terms and privacy text change of Stack B, which the maintainer merges.** The edge is a third party that sees the address of the people who open the app (below), and the current Terms do not say so. Until that change is merged and in force, an operator must not publish the key. This stack only ships the code, off.

## What the edge sees

Plainly, the operator of the media origin learns:

- **The internet address (IP) of every person whose app loads public media**, and the usual request metadata (time, the headers a browser or the app sends, TLS details). The app sends no cookies and no credentials (`credentials: 'omit'`).
- **The public media paths that person requests**: `/media/<author key>/<core key>/<start block>/<block count>`. That tells the edge which public photo or video of which public diary was shown, when, and from which address. Public avatars, the Feira and the Espiadinha load this way too.

The edge does **not** see post text, anything private, chat items, or the person's identity beyond the address. A response served from the edge cache is not seen by the installation either, so the installation sees fewer of those requests.

**The edge logs, the seeder does not.** The seeder never logs paths or addresses. Anything the edge operator keeps (access logs, analytics, security tooling) is a new record of who looked at which public media, held by a party the installation does not control. The Stack B Terms and LGPD text must name this recipient, what it receives and how long it may keep it.

## Retention at the edge

An edge keeps copies. After the installation stops serving an item (the diary was blocked, or the author's media was removed or unbound), a cached copy can still be served from the edge until it expires or is purged, and the installation cannot reach into it.

- When a media origin is set, the deploy (`chore/cdn-ready-deploy`) sends `Cache-Control: ... s-maxage=60` on `/media`, so an edge that honours it drops a copy within about a minute.
- **The operator must configure the edge to honour `s-maxage`**, not to override or extend the TTL, not to serve stale copies past it, and **to purge on a block or a removal** (purge by path: `/media/<author>/...`).
- An edge that ignores this keeps blocked or removed media reachable by anyone who has the path. That is a retention and takedown risk the Stack B Terms and LGPD text must cover, together with the deletion path (who purges, how fast).

## The key

`/varanda.json` of the installation may carry an optional `media`:

```json
{ "v": 1, "association": "<64 hex>", "media": "https://cdn.example.org" }
```

- A bare **https** origin: no path, query, fragment or userinfo, no default port, and a host of ASCII lowercase DNS labels with an optional port from 1 to 65535: the same rule `finish-web.js` applies at build time. IP literals (v4 and bracketed v6) and `localhost` are refused, and so is any non-ASCII, zero-width or soft-hyphen character, whatever the platform URL parser does with it. Anything else is ignored and media stays on the installation. An older client ignores the key.
- A value equal to the installation's own origin is ignored too: it would only make a failure ask the same server twice.
- The app reads it from a live `/varanda.json` answer and keeps it in memory only. It is never written to storage. Every live answer sets or clears it, in the order the answers were requested: a live answer that arrives late is still applied unless a newer one already was, so a later transport failure cannot keep an old value alive, and an older answer cannot undo a newer one. A changed, missing or invalid answer clears it, and so does choosing another installation. Until a live answer arrives, media comes from the installation.
- **Build time, for the offline shell:** `VARANDA_MEDIA_ORIGIN` at `apps/app/scripts/finish-web.js` (the same origin) makes the service worker add it to **`connect-src` only** in the CSP it serves with the cached shell, and to the release id. Set both to the same value.
- **Deploy headers:** the Content-Security-Policy the installation sends must allow the origin in **`connect-src` only**, byte for byte as the shell CSP does. The app reaches the edge with `fetch()` alone and shows the verified bytes through `blob:` URLs, which `img-src` and `media-src` already allow, so those two stay closed to the edge. Without the `connect-src` entry a browser blocks the request and the app falls back to the installation on every photo.
- **Web only, CORS:** the web app fetches cross-origin, so the edge must answer `GET` with `Access-Control-Allow-Origin` for the installation origin (no credentials). The native app does not need it.

## What goes there, and what never does

Only `GET /media/<author>/<core>/<start>/<blocks>` of **public diary media**: post photos, post videos, and the other places the app shows a public diary's image through the same fetch. Never:

- chat items, including photos and voice notes of public group posts (`deps.chat`): they always use the installation;
- `/blob`, `/varanda.json`, `/seeder`, the account service, or any other route;
- anything the person sends, writes or signs.

## The checks do not change

The edge gets the same verification as the installation, so it cannot alter a photo:

1. `credentials: 'omit'` and `redirect: 'error'`; an answer that was redirected, or whose final URL is on another origin than the one asked, fails.
2. Status exactly 200, a `Content-Length` above the descriptor's `bytes` fails before the body is read, and the body is read with a hard cap of `bytes`: more or fewer bytes fail.
3. The SHA-256 of the bytes must equal the descriptor's `sha256`, and the strict image or video parser runs before anything is shown.

A faulty or hostile edge can therefore only refuse, slow down or fail; it cannot make the app show different bytes.

## Fallback

When the attempt on the media origin fails for any reason (no connection, a status, a redirect, another origin, a wrong length, a wrong hash, or the deadline below), the app makes **one** more `GET` to the installation, with every check again, and the error of that second attempt is the one reported. There is no third request, no fallback for chat items, and none when the caller cancelled. A request that changes state is never involved.

The edge attempt, and only it, has a deadline that covers the headers and the whole body: 8 s plus one second per 128 KiB of the item (about 1 Mbit/s as a floor), so a stalled or trickling edge is aborted and the installation is tried, while a slow but working link is not cut off. The installation attempt has no deadline of its own.

## Operator checklist

1. Terms and privacy change of Stack B merged and in force, covering the edge as a recipient of addresses and public media paths, its logs and its retention.
2. The edge only caches `GET /media/*`, forwards to the installation, sends CORS for the installation origin, honours `s-maxage` (no TTL override, no serving stale past it), purges on block or removal, and keeps no logs beyond what the Terms describe.
3. Set `VARANDA_MEDIA_ORIGIN` for the web build, allow the origin in the deploy CSP (`connect-src` only), then add `media` to `/varanda.json`.
4. To turn it off, remove `media` from `/varanda.json`; clients return to the installation on their next live answer.

`docs/app.md` describes `/varanda.json`; its section is updated by Stack B.
