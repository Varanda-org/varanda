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
- **That limit lives in the deploy's Caddyfile, not in the seeder.** The seeder answers `/media` with `public, max-age=31536000, immutable`. Publish the key only on a deploy that has `chore/cdn-ready-deploy`, with the edge in front of that Caddy. An edge in front of a seeder without that rule may keep each answer, blocked or removed media included, for up to a year.
- **The operator must configure the edge to keep a copy at most 60 seconds**: honour `s-maxage`, or override the cache time to 60 s or less (as the Bunny section below does), never longer; not to serve stale copies past it; and **to purge on a block or a removal** (purge by path: `/media/<author>/...`).
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

## Bunny

Bunny publishes no fixed address ranges that only your pull zone uses: every Bunny customer reaches your origin from the same edge servers, with any headers they like. `VARANDA_TRUSTED_PROXIES` therefore stays **empty** with Bunny. The installation trusts Bunny by a shared secret instead:

- `VARANDA_CDN_SECRET` in `deploy/seeder/.env`: 64 lowercase hex digits, generated with `openssl rand -hex 32`. Never commit it, never paste it in an issue or a log. `deploy.sh` and `update.sh` check only its format and never print it. With it set, `VARANDA_MEDIA_ORIGIN` no longer needs `VARANDA_TRUSTED_PROXIES`.
- Bunny sends the same value in the `X-Varanda-Edge` request header (step 2 below). On `/media/*`, Caddy reads `X-Real-IP` only when that header equals the secret, and keys the per-address limit on it (zone `media-cdn`) only when it has the shape of one address (only hex digits, colons and dots, 2 to 45 characters, so never a list; the check does not prove it is a valid IP) and equals `X-Forwarded-For`. Bunny's documentation ([request headers](https://bunny.net/docs/cdn/request-headers-to-origin)) says `X-Real-IP` is the visitor's address, and that Bunny drops any `X-Forwarded-For` the visitor sent and sends one address, the visitor's. To choose its own key, a visitor would have to choose both. `X-Forwarded-For` is never a key on its own: a Bunny support article describes it as a list.
- With the right secret but anything else (a header missing, a list, the two headers different), the limit falls back to the connection address, a Bunny server (zone `media-cdn-borda`): visitors behind that server share one window, and none of them picks its own key.
- After zone `media-cdn`, one ceiling covers the whole CDN path: 2560 requests per 10 s (zone `media-cdn-total`), the hosted seeder's media rate (`VARANDA_MEDIA_RATE=256`). The per-address zone runs first, so a request it refuses never spends the ceiling and one address cannot use it up for everyone. Each new address in `media-cdn` holds a window in Caddy's memory until the next sweep, as in zone `media` by `{client_ip}`; whoever holds a leaked secret could create windows at will until the secret is rotated.
- A request without the right secret, from anyone, keeps the old limit by its own connection address (zone `media`).
- Caddy strips `X-Varanda-Edge` before the seeder, and deletes it from every log entry it writes.
- Any request with a non-empty `X-Varanda-Edge` outside `/media/*` gets 403 (`no-store`) from Caddy (an empty one counts as absent), so the Bunny hostname never reaches `/seeder`, `/account/*` or the app, even if a Bunny rule is missing.
- Empty secret: none of this applies, and the deploy behaves as before.

`node scripts/bunny.js` does steps 1 to 6 below through Bunny's API (pull zone, hostname, the three Edge Rules, stale delivery off, logs) and step 8 (`purge /media/...`), and `cert` asks for the certificate once the hostname's DNS points at Bunny and the three rules are in place. The maintainer runs it in their own terminal, with the API key in `BUNNY_API_KEY` or typed at its prompt, and `--env-file` pointing at the `.env` that holds the secret; it never prints either. Run `plan` first (it writes nothing), then `apply` on a throwaway zone (`--name varanda-media-test`) and check it in the dashboard before the real one. On the throwaway zone, also check that `/media/<item>?x`, a 404 and a 429 are never served from Bunny's cache; if they are, the cache rule needs a status-200 trigger. On a zone that already exists, `apply` purges the whole zone after it changes rules or settings (if the run stops before that purge, run `apply --purge` until it succeeds), and it stops with no write if Perma-Cache, an edge script or a middleware script is on. The pre-check below, the DNS record and the `.env` value stay manual. The list below stays the reference for what the script sets.

Maintainer steps in the Bunny dashboard (no agent does these; check the labels against the dashboard, which may have changed):

1. **Pull zone.** Origin URL `https://<domain>` (the installation). Add the media origin hostname (for example `media.<domain>`) as the custom hostname, with its certificate. `VARANDA_MEDIA_ORIGIN` is `https://<that hostname>`.
2. **Edge Rule: the secret.** Action "Set Request Header", header `X-Varanda-Edge`, value: the secret, on every request of the pull zone.
3. **Edge Rule: only `/media/`.** Block every request whose path does not start with `/media/`. Caddy refuses those too (403 above); this rule keeps them off the origin.
4. **Edge Rule: cache time.** "Override Cache Time" of 60 seconds on `/media/*`. Do not rely on Bunny honouring `s-maxage=60` from the origin: this rule is what bounds how long a removed photo stays at the edge.
5. **Stale cache delivery off.** A stale copy served while the origin is slow or down would outlive the 60 seconds.
6. **Logs.** Bunny keeps request logs (with the visitor address) for up to 3 days. Keep IP anonymization on: "Drop all" preferred, "Remove last octet" acceptable. Bunny's documentation describes the anonymization as applied when the logs are read through its interfaces, so do not assume Bunny stores only anonymized addresses: treat full addresses as held by Bunny for up to 3 days, and say so in the Terms. Never accept the DPA option that turns on full-IP logging, and keep Permanent Log Storage off.
7. **CORS.** The origin already answers `/media/*` with `Access-Control-Allow-Origin: https://<domain>` when `VARANDA_MEDIA_ORIGIN` is set, and Bunny caches it with the body. If Bunny's own CORS header option is on, it must name only the installation origin, never `*`.
8. **Purge by path** on every block or removal: `/media/<author>/...` in the pull zone's purge, so the copy does not wait for the 60 seconds.

**Before turning it on (blocking).** Put a temporary origin that echoes the request headers behind a test pull zone with the same Edge Rules, and request it with your own `X-Real-IP` and `X-Forwarded-For` headers. `X-Real-IP` and `X-Forwarded-For` must both arrive as exactly your real address, the same text, never your values. If they differ or either carries a list, every visitor would share a Bunny server's window (zone `media-cdn-borda`); if your own values survive in both, a visitor could pick its key. In either case do not set `VARANDA_CDN_SECRET`.

Then set `VARANDA_CDN_SECRET` (and `VARANDA_MEDIA_ORIGIN`):

- Push deployment (`deploy.sh`): in `deploy/seeder/.env`, then run `deploy.sh`. A change of the secret alone recreates the `web` container, even on the same commit.
- Pull deployment (`update.sh`): in `/etc/varanda/varanda.env`, then run `update.sh reconfigure`.

To rotate the secret, change the Bunny Edge Rule and the `.env` value one right after the other, at a quiet time. In between, Bunny's requests carry a secret the origin does not accept and fall into zone `media`, keyed on Bunny's server addresses: visitors behind one server share a window and may get 429.

**Live checks** after turning it on (not run by the tests, which have no Bunny and no Caddy binary):

- `GET https://<media hostname>/media/<a public item>` returns 200, and a second request shows a cache HIT in Bunny's response headers.
- A direct request to the origin, `https://<domain>/media/...`, with a fake `X-Real-IP`, a fake `X-Forwarded-For` and no secret is limited by its real address: past 480 requests in 10 s it gets 429 whatever those headers say.
- `https://<media hostname>/seeder` (and `/account/health`) gets 403, from Bunny's rule or from Caddy.
- A removed or blocked photo stops loading through the media hostname within about 60 s, or at once after a purge.

## Operator checklist

1. Terms and privacy change of Stack B merged and in force, covering the edge as a recipient of addresses and public media paths, its logs and its retention.
2. The edge only caches `GET /media/*`, forwards to the installation, sends CORS for the installation origin, keeps a copy at most 60 s (honours `s-maxage`, or overrides the cache time to 60 s or less, never longer; no serving stale past it), purges on block or removal, and keeps no logs beyond what the Terms describe.
3. Set `VARANDA_MEDIA_ORIGIN` for the web build, allow the origin in the deploy CSP (`connect-src` only), then add `media` to `/varanda.json`.
4. To turn it off, remove `media` from `/varanda.json`; clients return to the installation on their next live answer.

`docs/app.md` describes `/varanda.json`; its section is updated by Stack B.
