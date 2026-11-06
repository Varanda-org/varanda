'use strict'

const https = require('node:https')
const dns = require('node:dns')
const { isHostname, publicAddress, createSafeFetch } = require('./safe-fetch')
const { FINISH_LIMIT, refundableWindow, createMemberSession } = require('./member-session')

// GIF search through the account service (mounted by ./server.js), off
// unless the operator sets VARANDA_GIF_API_URL and VARANDA_GIF_API_KEY:
//
//   - GET /account/gif/policy answers { enabled } even when the feature is
//     off (200 { enabled: false }), so the app can hide the button. Every
//     other /account/gif/* route then answers 404 { error: 'feature-off' }.
//   - POST /account/gif/session/start { member } -> { nonce } for a linked,
//     unblocked member; POST /account/gif/session/finish { member, nonce,
//     signature } -> { token, expiresAt }. The signature is the member's
//     invite.sign statement in the read-only 'summary' action over that
//     nonce (packages/core/lib/invite.js): it proves the diary key with a
//     signer the node already has, and grants nothing beyond this read.
//     Member keys are public, so start stores nothing and counts nothing:
//     the nonce is stateless, bound to the member by an HMAC under a key
//     that lives only in this process (mintNonce), and finish counts its
//     per-member limit and spends the nonce only after the signature
//     verified. Nobody without the member's key can lock that member out
//     or evict another member's state. The MAC domain makes it never an
//     invite nonce, and an invite nonce is never one of these.
//   - POST /account/gif/search { q } or { q, cursor } and GET
//     /account/gif/image/<id>?size=tiny|full need the session token as
//     `Authorization: Bearer <token>`. The search text rides in the body and
//     the token in Authorization because Caddy's logger serializes the URI
//     and the headers of a failed request, redacting only Authorization and
//     the cookies, and never logs a body. Every use of a token re-checks
//     that the member is still linked and not blocked (cached RECHECK_MS per
//     session); a member who fails it loses the session (401). Search answers only
//     { items: [{ id, width, height, bytes }], next }: no provider URL ever
//     reaches the member. The provider URLs of recent results stay here
//     (id -> URLs, one hour, at most MAX_CACHED ids), and the image route
//     only fetches a URL from that table: the client never names a URL.
//
// What reaches the provider: the search text, the operator's key and this
// service's own address. Never the member's address, key, cookie or any
// identifier: requests carry a fixed User-Agent and nothing else of ours.
// The key, the query text and the provider URLs never reach a log line;
// logs carry { event: 'gif', reason } counts only.
//
// SSRF: a provider URL must be https on the API host or one of the operator's
// VARANDA_GIF_MEDIA_HOSTS (exact names, never an IP literal), and the name
// must resolve only to public addresses (checked in the socket's own lookup,
// so the address that is checked is the address that is dialled). Redirects
// follow the same rules, at most MAX_REDIRECTS.

//
// The address checks and the guarded fetch live in ./safe-fetch.js, the
// session (nonce, finish, token, re-check) in ./member-session.js, shared
// with the link previews of ./preview-routes.js; each feature keeps its own
// nonce key, domain and token table.

const FEATURE_OFF = 'feature-off'
const CACHE_TTL_MS = 3600 * 1000
const MAX_CACHED = 5000
const PAGE_SIZE = 24
const MAX_OFFSET = 4999
const MAX_ITEMS = 50
const MAX_QUERY = 64
// The app refuses a search page with a side above 4096 (apps/app/src/gif.js):
// such items are dropped here, one by one, never the whole page.
const MAX_SIDE = 4096
const TINY_CAP = 512 * 1024
const FULL_CAP = 8 * 1024 * 1024
const SEARCH_CAP = 512 * 1024
const DEADLINE_MS = 10 * 1000
const MAX_REDIRECTS = 3
const MAX_INFLIGHT = 16
const DAY_MS = 24 * 3600 * 1000
const SEARCHES_PER_DAY = 120
const FULL_PER_DAY = 60
const TINY_PER_DAY = 2000
const USER_AGENT = 'varanda-gif/1'
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const CURSOR_RE = /^(0|[1-9][0-9]{0,3})$/
const INT_RE = /^(0|[1-9][0-9]{0,9})$/
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/ // eslint-disable-line no-control-regex
const GIF87 = Buffer.from('GIF87a', 'latin1')
const GIF89 = Buffer.from('GIF89a', 'latin1')
const IMAGE_CSP = "default-src 'none'; sandbox"

// --- configuration ---------------------------------------------------------

// { apiUrl, apiKey, mediaHosts } -> the parsed config, or null with a token
// in `reason`. Never echoes a value.
function parseGifConfig ({ apiUrl, apiKey, mediaHosts = [] } = {}) {
  if (typeof apiKey !== 'string' || apiKey.length < 1 || apiKey.length > 256 || !/^[\x21-\x7e]+$/.test(apiKey)) return null
  if (typeof apiUrl !== 'string' || apiUrl.length > 512) return null
  let url
  try {
    url = new URL(apiUrl)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') return null
  const apiHost = url.hostname.toLowerCase()
  if (!isHostname(apiHost)) return null
  if (!Array.isArray(mediaHosts)) return null
  const hosts = new Set([apiHost])
  for (const h of mediaHosts) {
    if (!isHostname(h)) return null
    hosts.add(h)
  }
  return { base: url.origin + url.pathname.replace(/\/+$/, ''), apiHost, apiPort: url.port, apiKey, hosts }
}

// --- provider adapter ----------------------------------------------------------

function intOf (v) {
  if (Number.isSafeInteger(v)) return v
  if (typeof v === 'string' && INT_RE.test(v)) return Number(v)
  return null
}

function httpsUrl (v) {
  if (typeof v !== 'string' || v.length > 2048) return null
  let url
  try {
    url = new URL(v)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return null
  url.hash = ''
  return url.href
}

// The ONE place that knows the provider's answer (a Giphy-compatible
// search: { data: [{ id, images: { fixed_width_small, original } }] }).
// -> [{ id, width, height, bytes, tinyUrl, fullUrl }], dropping any item
// with a bad id, a missing or non-https URL, or a size that is not an
// integer in range. Swapping the provider means swapping this function.
function fromProvider (json) {
  const data = json && Array.isArray(json.data) ? json.data.slice(0, MAX_ITEMS) : []
  const items = []
  for (const it of data) {
    if (!it || typeof it !== 'object' || typeof it.id !== 'string' || !ID_RE.test(it.id)) continue
    const images = it.images && typeof it.images === 'object' ? it.images : null
    const tiny = images && images.fixed_width_small
    const full = images && images.original
    if (!tiny || !full || typeof tiny !== 'object' || typeof full !== 'object') continue
    const tinyUrl = httpsUrl(tiny.url)
    const fullUrl = httpsUrl(full.url)
    const width = intOf(full.width)
    const height = intOf(full.height)
    const bytes = intOf(full.size)
    const tinyBytes = intOf(tiny.size)
    if (tinyUrl === null || fullUrl === null || width === null || height === null || bytes === null || tinyBytes === null) continue
    if (width < 1 || height < 1 || width > MAX_SIDE || height > MAX_SIDE) continue
    if (bytes < 1 || bytes > FULL_CAP || tinyBytes < 1 || tinyBytes > TINY_CAP) continue
    items.push({ id: it.id, width, height, bytes, tinyUrl, fullUrl })
  }
  return items
}

// The next cursor from the provider's pagination, or null at the end.
function nextCursor (json, offset) {
  const p = json && json.pagination
  const count = p ? intOf(p.count) : null
  const total = p ? intOf(p.total_count) : null
  if (count === null || count < 1) return null
  const next = offset + count
  if (next > MAX_OFFSET || (total !== null && next >= total)) return null
  return String(next)
}

// --- routes -------------------------------------------------------------------

// `config` is parseGifConfig's result or null (off). `blocklist` ({ has(key) }
// or null) is the moderation desk's published blocklist. `request`, `lookup` and
// `allowAddress` default to https.request, dns.lookup and publicAddress;
// only tests replace them, to reach a loopback fake provider. `maxSpent`
// (the spent-nonce table cap) is replaced only by tests.
function createGifRoutes ({
  config = null,
  store,
  terms = null,
  blocklist = null,
  association,
  log = () => {},
  now = Date.now,
  request = https.request,
  lookup = dns.lookup,
  allowAddress = publicAddress,
  maxSpent,
  http
}) {
  const { send, readJsonBody, checkPost, RouteError, refuse } = http
  const enabled = config !== null

  const cache = new Map()
  let inflight = 0

  const limits = {
    search: refundableWindow(SEARCHES_PER_DAY, DAY_MS, now),
    full: refundableWindow(FULL_PER_DAY, DAY_MS, now),
    tiny: refundableWindow(TINY_PER_DAY, DAY_MS, now)
  }

  const featureOff = () => new RouteError(FEATURE_OFF, 404)
  const unavailable = () => refuse('indisponivel')
  const overLimit = () => new RouteError('limite-gif', 429)

  // The Terms that describe the search text going to the provider (v20)
  // come before a session.
  const auth = createMemberSession({ prefix: 'gif', overLimit, store, terms, blocklist, association, log, now, maxSpent, http })
  const session = auth.member

  // A provider URL this service may fetch, as request options, or null.
  function target (href) {
    let url
    try {
      url = new URL(href)
    } catch {
      return null
    }
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return null
    const host = url.hostname.toLowerCase()
    if (!isHostname(host) || !config.hosts.has(host)) return null
    // Only the API host may use the API URL's own port; every other host is 443.
    if (url.port !== '' && !(host === config.apiHost && url.port === config.apiPort)) return null
    return { hostname: host, port: url.port === '' ? 443 : Number(url.port), path: url.pathname + url.search, href: url.href }
  }

  const safeFetch = createSafeFetch({ request, lookup, allowAddress, target, userAgent: USER_AGENT, deadlineMs: DEADLINE_MS, maxRedirects: MAX_REDIRECTS })

  // GET href -> Buffer of at most `cap` bytes, following at most
  // MAX_REDIRECTS redirects that pass `target` again; one DEADLINE_MS for
  // the whole exchange. Any failure rejects with no detail.
  async function fetchCapped (href, cap, accept) {
    return (await safeFetch(href, { cap, accept })).body
  }

  function remember (item) {
    cache.delete(item.id)
    cache.set(item.id, { tinyUrl: item.tinyUrl, fullUrl: item.fullUrl, expiresAt: now() + CACHE_TTL_MS })
    while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value)
  }

  function recalled (id) {
    const row = cache.get(id)
    if (row === undefined) return null
    if (row.expiresAt <= now()) {
      cache.delete(id)
      return null
    }
    cache.delete(id)
    cache.set(id, row)
    return row
  }

  function queryParam (v) {
    if (typeof v !== 'string' || CONTROL_RE.test(v)) throw refuse('pedido-invalido')
    const length = [...v].length
    if (length < 1 || length > MAX_QUERY || v.trim() === '') throw refuse('pedido-invalido')
    return v
  }

  function cursorParam (v) {
    if (v === undefined || v === null || v === '') return 0
    if (typeof v !== 'string' || !CURSOR_RE.test(v) || Number(v) > MAX_OFFSET) throw refuse('pedido-invalido')
    return Number(v)
  }

  function allowedItem (item) {
    return target(item.tinyUrl) !== null && target(item.fullUrl) !== null
  }

  // A body of exactly { q } or { q, cursor }.
  async function search (res, member, body) {
    for (const k of Object.keys(body)) if (k !== 'q' && k !== 'cursor') throw refuse('pedido-invalido')
    const q = queryParam(body.q)
    const offset = cursorParam(body.cursor)
    // Counted before the provider call, so concurrent searches stay bounded;
    // given back when the provider fails.
    if (!limits.search(member)) throw overLimit()
    const params = new URLSearchParams({ api_key: config.apiKey, q, limit: String(PAGE_SIZE), offset: String(offset), rating: 'g' })
    let json
    try {
      const raw = await fetchCapped(config.base + '/gifs/search?' + params.toString(), SEARCH_CAP, 'application/json')
      json = JSON.parse(raw.toString('utf8'))
    } catch {
      limits.search.giveBack(member)
      log({ event: 'gif', reason: 'indisponivel' })
      throw unavailable()
    }
    const items = fromProvider(json).filter(allowedItem)
    for (const item of items) remember(item)
    log({ event: 'gif', reason: 'busca' })
    send(res, 200, {
      items: items.map(({ id, width, height, bytes }) => ({ id, width, height, bytes })),
      next: nextCursor(json, offset)
    })
  }

  async function image (req, res, url, id) {
    const member = session(req)
    if (!ID_RE.test(id)) throw refuse('pedido-invalido')
    const size = url.searchParams.get('size')
    if (size !== 'tiny' && size !== 'full') throw refuse('pedido-invalido')
    const row = recalled(id)
    if (row === null) throw refuse('nao-encontrado')
    if (inflight >= MAX_INFLIGHT) throw unavailable()
    if (!limits[size](member)) throw overLimit()
    inflight++
    let body
    try {
      body = await fetchCapped(size === 'tiny' ? row.tinyUrl : row.fullUrl, size === 'tiny' ? TINY_CAP : FULL_CAP, 'image/gif')
    } catch {
      limits[size].giveBack(member)
      log({ event: 'gif', reason: 'indisponivel' })
      throw unavailable()
    } finally {
      inflight--
    }
    const head = body.subarray(0, 6)
    if (!(head.equals(GIF87) || head.equals(GIF89))) {
      log({ event: 'gif', reason: 'indisponivel' })
      throw unavailable()
    }
    log({ event: 'gif', reason: size === 'tiny' ? 'miniatura' : 'imagem' })
    res.writeHead(200, {
      'Content-Type': 'image/gif',
      'Content-Length': body.length,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=3600',
      'Content-Security-Policy': IMAGE_CSP,
      'Referrer-Policy': 'no-referrer'
    })
    res.end(body)
  }

  function owns (pathname) {
    return pathname === '/account/gif' || pathname.startsWith('/account/gif/')
  }

  async function handle (req, res, url) {
    const pathname = url.pathname
    if (req.method === 'GET' && pathname === '/account/gif/policy') return send(res, 200, { enabled })
    if (!enabled) throw featureOff()
    if (req.method === 'POST' && (pathname === '/account/gif/session/start' || pathname === '/account/gif/session/finish')) {
      checkPost(req)
      const body = await readJsonBody(req)
      return pathname.endsWith('/start') ? auth.start(req, res, body) : auth.finish(req, res, body)
    }
    if (req.method === 'POST' && pathname === '/account/gif/search') {
      checkPost(req)
      const member = session(req)
      return search(res, member, await readJsonBody(req))
    }
    if (req.method === 'GET' && pathname.startsWith('/account/gif/image/')) return image(req, res, url, pathname.slice('/account/gif/image/'.length))
    throw refuse('nao-encontrado')
  }

  function stats () {
    return { ...auth.stats(), cached: cache.size, inflight }
  }

  return { owns, handle, stats, enabled: () => enabled }
}

module.exports = {
  FEATURE_OFF,
  TINY_CAP,
  FULL_CAP,
  SEARCHES_PER_DAY,
  FULL_PER_DAY,
  TINY_PER_DAY,
  FINISH_LIMIT,
  USER_AGENT,
  parseGifConfig,
  publicAddress,
  fromProvider,
  createGifRoutes
}
