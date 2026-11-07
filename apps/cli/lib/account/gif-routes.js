'use strict'

const https = require('node:https')
const dns = require('node:dns')
const net = require('node:net')
const nodeCrypto = require('node:crypto')
const { verifyInvite } = require('@varanda/core/lib/invite')
const { TERMS_VERSION } = require('@varanda/core/lib/terms')

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

const FEATURE_OFF = 'feature-off'
const SESSION_TTL_MS = 12 * 3600 * 1000
const MAX_SESSIONS = 10000
const NONCE_TTL_S = 600
const NONCE_DOMAIN = 'varanda/gif-nonce/v1'
const MAX_SPENT = 10000
const FINISH_LIMIT = 10
const FINISH_WINDOW_MS = 600 * 1000
const RECHECK_MS = 60 * 1000
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
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/
const BEARER_RE = /^bearer ([A-Za-z0-9_-]{43})$/i
const HEX64_RE = /^[0-9a-f]{64}$/
const HEX128_RE = /^[0-9a-f]{128}$/
const CURSOR_RE = /^(0|[1-9][0-9]{0,3})$/
const INT_RE = /^(0|[1-9][0-9]{0,9})$/
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/ // eslint-disable-line no-control-regex
const HOST_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/
const GIF87 = Buffer.from('GIF87a', 'latin1')
const GIF89 = Buffer.from('GIF89a', 'latin1')
const IMAGE_CSP = "default-src 'none'; sandbox"

// --- configuration ---------------------------------------------------------

function isHostname (host) {
  return typeof host === 'string' && host.length <= 253 && HOST_RE.test(host) && net.isIP(host) === 0
}

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

// --- addresses ---------------------------------------------------------------

function v4Public (ip) {
  const p = ip.split('.').map(Number)
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false
  const [a, b, c] = p
  if (a === 0 || a === 10 || a === 127) return false
  if (a === 100 && b >= 64 && b <= 127) return false
  if (a === 169 && b === 254) return false
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && b === 168) return false
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false
  if (a === 198 && (b === 18 || b === 19)) return false
  if (a === 198 && b === 51 && c === 100) return false
  if (a === 203 && b === 0 && c === 113) return false
  if (a >= 224) return false
  return true
}

// The 8 hextets of an IPv6 literal (embedded IPv4 folded in), or null.
function v6Hextets (ip) {
  let text = ip.toLowerCase()
  const zone = text.indexOf('%')
  if (zone !== -1) text = text.slice(0, zone)
  const tail = text.match(/:(\d+\.\d+\.\d+\.\d+)$/)
  if (tail) {
    const p = tail[1].split('.').map(Number)
    text = text.slice(0, -tail[1].length) + ((p[0] << 8) | p[1]).toString(16) + ':' + ((p[2] << 8) | p[3]).toString(16)
  }
  const halves = text.split('::')
  if (halves.length > 2) return null
  const head = halves[0] === '' ? [] : halves[0].split(':')
  const rest = halves.length === 2 ? (halves[1] === '' ? [] : halves[1].split(':')) : []
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0
  if (fill < 0) return null
  const all = [...head, ...new Array(fill).fill('0'), ...rest].map((h) => parseInt(h, 16))
  if (all.length !== 8 || all.some((n) => !Number.isInteger(n) || n < 0 || n > 0xffff)) return null
  return all
}

// Refuses loopback, private, link-local, CGNAT, multicast, reserved and
// documentation ranges, IPv6 ULA, link-local and site-local, and every
// IPv6 form that can carry an IPv4 address (IPv4-mapped, IPv4-compatible,
// IPv4-translated, NAT64, 6to4, Teredo): a GIF provider never needs them,
// and each can route to an internal IPv4 address.
function publicAddress (ip) {
  const family = net.isIP(ip)
  if (family === 4) return v4Public(ip)
  if (family !== 6) return false
  const h = v6Hextets(ip)
  if (h === null) return false
  if (h.slice(0, 6).every((n) => n === 0)) return false // ::, ::1 and ::/96
  if (h.slice(0, 5).every((n) => n === 0) && h[5] === 0xffff) {
    return v4Public([h[6] >> 8, h[6] & 255, h[7] >> 8, h[7] & 255].join('.'))
  }
  if (h.slice(0, 4).every((n) => n === 0) && h[4] === 0xffff && h[5] === 0) return false // IPv4-translated ::ffff:0:0:0/96
  if ((h[0] & 0xfe00) === 0xfc00) return false
  if ((h[0] & 0xffc0) === 0xfe80) return false
  if ((h[0] & 0xffc0) === 0xfec0) return false
  if ((h[0] & 0xff00) === 0xff00) return false
  if (h[0] === 0x64 && h[1] === 0xff9b) return false // 64:ff9b::/96 and 64:ff9b:1::/48
  if (h[0] === 0x2001 && h[1] === 0x0db8) return false
  if (h[0] === 0x2002) return false
  if (h[0] === 0x2001 && h[1] === 0) return false
  return true
}

// A net lookup that only ever answers addresses `allowAddress` admits:
// every address of the name must pass, or the socket never opens.
function guardedLookup (baseLookup, allowAddress) {
  return (hostname, options, cb) => {
    if (typeof options === 'function') {
      cb = options
      options = {}
    }
    const opts = typeof options === 'number' ? { family: options } : (options || {})
    baseLookup(hostname, { all: true, family: opts.family || 0 }, (err, addrs) => {
      if (err) return cb(err)
      const list = Array.isArray(addrs) ? addrs : []
      if (list.length === 0 || list.some((a) => !a || !allowAddress(a.address))) {
        const blocked = new Error('endereço recusado')
        blocked.code = 'EBLOCKED'
        return cb(blocked)
      }
      if (opts.all) return cb(null, list)
      cb(null, list[0].address, list[0].family)
    })
  }
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

// The fixed window of ./server.js keyedWindow (same eviction: a new key is
// always admitted, a full table forgets the oldest window), plus
// giveBack(key), which returns one use when the provider failed.
function refundableWindow (limit, windowMs, now, max = 10000) {
  const windows = new Map()
  const take = (key) => {
    const t = now()
    let w = windows.get(key)
    if (w !== undefined && t - w.start >= windowMs) {
      windows.delete(key)
      w = undefined
    }
    if (w === undefined) {
      if (windows.size >= max) {
        for (const [k, v] of windows) if (t - v.start >= windowMs) windows.delete(k)
        if (windows.size >= max) windows.delete(windows.keys().next().value)
      }
      w = { start: t, count: 0 }
      windows.set(key, w)
    }
    if (w.count >= limit) return false
    w.count++
    return true
  }
  take.giveBack = (key) => {
    const w = windows.get(key)
    if (w !== undefined && w.count > 0) w.count--
  }
  return take
}

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
  maxSpent = MAX_SPENT,
  http
}) {
  const { send, readJsonBody, checkPost, RouteError, refuse } = http
  const enabled = config !== null
  const socketLookup = guardedLookup(lookup, allowAddress)

  // Memory only: a restart invalidates every outstanding nonce.
  const nonceKey = nodeCrypto.randomBytes(32)
  // nonce -> { expiresAt }: nonces whose signature verified, kept until
  // they expire so none is used twice.
  const spent = new Map()
  // sha256(token) -> { member, expiresAt, checkedAt }: a lookup by digest
  // leaks no timing about the token itself.
  const sessions = new Map()
  const cache = new Map()
  let inflight = 0

  const limits = {
    finish: refundableWindow(FINISH_LIMIT, FINISH_WINDOW_MS, now),
    search: refundableWindow(SEARCHES_PER_DAY, DAY_MS, now),
    full: refundableWindow(FULL_PER_DAY, DAY_MS, now),
    tiny: refundableWindow(TINY_PER_DAY, DAY_MS, now)
  }

  const featureOff = () => new RouteError(FEATURE_OFF, 404)
  const unavailable = () => refuse('indisponivel')
  const overLimit = () => new RouteError('limite-gif', 429)

  function sweep (map) {
    const t = now()
    for (const [k, v] of map) if (v.expiresAt <= t) map.delete(k)
  }

  function digest (token) {
    return nodeCrypto.createHash('sha256').update(token).digest('hex')
  }

  // null when `member` may hold a GIF session, else the refusal token. The
  // one check of session start, finish and every use of a token.
  function standing (member) {
    let status
    let blocked = false
    try {
      status = store.status(member)
      if (blocklist !== null) blocked = blocklist.has(member) === true
    } catch {
      throw unavailable()
    }
    if (!status || !status.linked) return 'nao-vinculado'
    if (blocked) return 'sem-permissao'
    return null
  }

  function allowed (member) {
    const reason = standing(member)
    if (reason !== null) throw refuse(reason)
  }

  function memberParam (v) {
    if (typeof v !== 'string' || !HEX64_RE.test(v)) throw refuse('pedido-invalido')
    return v
  }

  function session (req) {
    const header = req.headers.authorization
    const m = typeof header === 'string' ? header.match(BEARER_RE) : null
    if (m === null) throw refuse('nao-autorizado')
    const key = digest(m[1])
    const row = sessions.get(key)
    if (row === undefined) throw refuse('nao-autorizado')
    const t = now()
    if (row.expiresAt <= t) {
      sessions.delete(key)
      throw refuse('nao-autorizado')
    }
    if (t - row.checkedAt >= RECHECK_MS) {
      if (standing(row.member) !== null) {
        sessions.delete(key)
        log({ event: 'gif', reason: 'sessao-revogada' })
        throw refuse('nao-autorizado')
      }
      row.checkedAt = t
    }
    return row.member
  }

  function nonceMac (member, random, expiry) {
    return nodeCrypto.createHmac('sha256', nonceKey)
      .update(NONCE_DOMAIN)
      .update(Buffer.from(member, 'hex'))
      .update(random)
      .update(expiry)
      .digest()
      .subarray(0, 16)
  }

  // 32 bytes, 43 base64url characters (an invite.sign nonce): 12 random
  // bytes, the expiry in unix seconds (4 bytes, big-endian) and the first
  // 16 bytes of the HMAC over the domain, the member key and both.
  function mintNonce (member) {
    const random = nodeCrypto.randomBytes(12)
    const expiry = Buffer.alloc(4)
    expiry.writeUInt32BE(Math.floor(now() / 1000) + NONCE_TTL_S)
    return Buffer.concat([random, expiry, nonceMac(member, random, expiry)]).toString('base64url')
  }

  // The nonce's expiry in ms when it was minted here for `member` and has
  // not expired, else null. Only the canonical spelling passes, so the
  // spent table sees one key per nonce.
  function nonceExpiry (member, nonce) {
    if (nonce === null) return null
    const buf = Buffer.from(nonce, 'base64url')
    if (buf.length !== 32 || buf.toString('base64url') !== nonce) return null
    const random = buf.subarray(0, 12)
    const expiry = buf.subarray(12, 16)
    if (!nodeCrypto.timingSafeEqual(buf.subarray(16), nonceMac(member, random, expiry))) return null
    const expiresAt = expiry.readUInt32BE(0) * 1000
    return expiresAt > now() ? expiresAt : null
  }

  async function sessionStart (req, res, body) {
    const member = memberParam(body.member)
    allowed(member)
    send(res, 200, { nonce: mintNonce(member) })
  }

  async function sessionFinish (req, res, body) {
    const member = memberParam(body.member)
    const nonce = typeof body.nonce === 'string' && TOKEN_RE.test(body.nonce) ? body.nonce : null
    const signature = typeof body.signature === 'string' && HEX128_RE.test(body.signature) ? body.signature : null
    const nonceExpiresAt = nonceExpiry(member, nonce)
    if (nonceExpiresAt === null) throw refuse('expirado')
    if (signature === null || !verifyInvite({ action: 'summary', nonce, member, association }, signature).ok) throw refuse('assinatura-invalida')
    // Only a finish signed by the member counts, so nobody else can lock
    // the member out; a member over the limit keeps the nonce.
    if (!limits.finish(member)) throw overLimit()
    sweep(spent)
    if (spent.has(nonce)) throw refuse('expirado')
    // Fail closed: forgetting a live entry would let it be replayed.
    if (spent.size >= maxSpent) throw refuse('indisponivel')
    spent.set(nonce, { expiresAt: nonceExpiresAt })
    // The Terms that describe the search text going to the provider (v20)
    // come before a session, as push and Pages require theirs.
    if (terms === null || !terms.available()) throw refuse('indisponivel')
    let accepted
    try {
      accepted = terms.list(member).some((e) => e.version === TERMS_VERSION)
    } catch {
      throw refuse('indisponivel')
    }
    if (!accepted) throw refuse('termos-pendentes')
    allowed(member)
    sweep(sessions)
    while (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value)
    const token = nodeCrypto.randomBytes(32).toString('base64url')
    const t = now()
    const expiresAt = t + SESSION_TTL_MS
    sessions.set(digest(token), { member, expiresAt, checkedAt: t })
    log({ event: 'gif', reason: 'sessao' })
    send(res, 200, { token, expiresAt: new Date(expiresAt).toISOString() })
  }

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

  // GET href -> Buffer of at most `cap` bytes, following at most
  // MAX_REDIRECTS redirects that pass `target` again; one DEADLINE_MS for
  // the whole exchange. Any failure rejects with no detail.
  function fetchCapped (href, cap, accept) {
    return new Promise((resolve, reject) => {
      let done = false
      let current = null
      const finish = (err, value) => {
        if (done) return
        done = true
        clearTimeout(timer)
        if (current) current.destroy()
        if (err) reject(err)
        else resolve(value)
      }
      const timer = setTimeout(() => finish(new Error('prazo')), DEADLINE_MS)
      const hop = (location, left) => {
        const t = target(location)
        if (t === null) return finish(new Error('destino'))
        let req
        try {
          req = request({
            hostname: t.hostname,
            port: t.port,
            path: t.path,
            method: 'GET',
            agent: false,
            lookup: socketLookup,
            headers: { 'User-Agent': USER_AGENT, Accept: accept }
          })
        } catch {
          return finish(new Error('pedido'))
        }
        current = req
        req.on('error', () => finish(new Error('rede')))
        req.on('response', (res) => {
          const status = res.statusCode
          if (status >= 300 && status < 400 && res.headers.location !== undefined) {
            res.resume()
            if (left < 1) return finish(new Error('redirecionamentos'))
            let next
            try {
              next = new URL(res.headers.location, t.href).href
            } catch {
              return finish(new Error('destino'))
            }
            current = null
            req.destroy()
            return hop(next, left - 1)
          }
          if (status !== 200) {
            res.resume()
            return finish(new Error('status'))
          }
          const declared = Number(res.headers['content-length'])
          if (Number.isFinite(declared) && declared > cap) return finish(new Error('grande'))
          const chunks = []
          let size = 0
          res.on('data', (chunk) => {
            size += chunk.length
            if (size > cap) return finish(new Error('grande'))
            chunks.push(chunk)
          })
          res.on('error', () => finish(new Error('rede')))
          res.on('aborted', () => finish(new Error('rede')))
          res.on('end', () => {
            current = null
            finish(null, Buffer.concat(chunks))
          })
        })
        req.end()
      }
      hop(href, MAX_REDIRECTS)
    })
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
      return pathname.endsWith('/start') ? sessionStart(req, res, body) : sessionFinish(req, res, body)
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
    return { sessions: sessions.size, spent: spent.size, cached: cache.size, inflight }
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
