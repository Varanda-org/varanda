'use strict'

const https = require('node:https')
const dns = require('node:dns')
const nodeCrypto = require('node:crypto')
const { publicAddress, httpsTarget } = require('./safe-fetch')
const { refundableWindow, createMemberSession } = require('./member-session')
const { createStreamFetch, parseRange, readCapped, pipeCapped } = require('./stream-fetch')
const { requestFor, fromTrack, fromPlaylist, fromResolve, isAudiusPermalink, listOf, nextCursor, ID_RE } = require('./audius-provider')

// Music from Audius through the account service, off unless the operator
// configures it (parseAudiusConfig in ./audius-provider.js):
//
//   - GET /account/audius/policy answers { enabled, moments } even when the
//     feature is off; every other /account/audius/* route then answers 404
//     { error: 'feature-off' }.
//   - POST /account/audius/session/start and /session/finish: the member
//     session of ./member-session.js, exactly as the GIF search.
//   - POST /account/audius/search { q, kind[, cursor] }, /item { kind, id },
//     /resolve { url } and /play { id } need `Authorization: Bearer <token>`.
//     The member is resolved before any counter is charged, so a request
//     without a valid session never spends quota. Answers carry only the
//     fields of trackItem and playlistItem: no artwork URL, user id or
//     provider URL reaches the member. With `?covers=1` on the path and the
//     operator's covers switch on, each item carries one more key, `cover`
//     (true when the service holds an artwork URL for it); an older service
//     ignores the query, so a newer app can ask without breaking it. With
//     `?info=1`, each track (never a playlist) also carries `genre` and `year`
//     when the provider had them; without it the keys are today's exact ones.
//   - POST /account/audius/art { kind, id } (bearer, covers switch on)
//     answers { mime, bytes } with the item's 150x150 cover: at most
//     ART_MAX_BYTES, JPEG, PNG or WebP by magic bytes only, ARTS_PER_DAY per
//     member, one budget unit per contact with the art host (each redirect
//     hop is one). The art host GET is not a provider call, so covers cannot
//     starve search and play; the lookup by id that an item row no longer
//     cached needs is one, and counts in the member's provider calls. The use
//     is given back only when no art host was contacted (the MAX_ART_INFLIGHT
//     cover slots, apart from the provider's, were full, the member already
//     had ART_PER_MEMBER covers waiting, or the budget was spent first);
//     concurrent loads of one cover share one fetch. With exactly
//     `?size=480` it answers the 480x480 cover instead, cached apart under
//     kind:id:480, with the same caps, slots and one art use; an item without
//     one gets the 150x150 path, and a large miss (oversize, not an image, a
//     4xx) answers the 150x150 cover in the same request when its URL
//     differs and a whole fetch still fits in ART_ANSWER_MS (else 404); a
//     remembered large miss with no cached item row is the 150x150 request.
//     Bytes are kept in memory only, at most
//     MAX_ART_CACHED for CACHE_TTL_MS each, as the Audius terms allow a
//     session cache and nothing more; nothing is written to disk.
//   - /play answers a ticket; GET /account/audius/audio/<ticket> relays the
//     audio. A media element cannot send Authorization, so the ticket is the
//     credential: 32 random bytes, kept here only by digest, naming no track,
//     living TICKET_TTL_MS, minted only after a fresh check of the member's
//     standing, which is checked again on an open at most RECHECK_MS after
//     the last check and every RECHECK_MS while audio is relayed. The audio
//     passes through in memory: nothing is written to disk and no byte is
//     kept after a response ends.
//   - Every JSON call to the provider is counted first against the member's
//     PROVIDER_CALLS_PER_DAY, never given back once the provider was
//     contacted, so no member can spend the shared daily budget alone.
//   - Every audio request that reaches the provider spends one unit of the
//     shared daily budget, so it is counted first and never given back:
//     AUDIO_OPENS_PER_DAY per member (then limite-musica) and
//     OPENS_PER_TICKET per ticket (then the ticket is retired, 404). Bytes
//     are bounded by TICKET_BYTES per ticket and DAILY_BYTES per member.
//
// What reaches the provider: the query text, an id or a permalink, the
// operator's key (in a header, first hop only) and app name, this service's
// address and a fixed User-Agent. Never the member's address, key or token.
// What reaches the art host: a GET from this service's address with
// User-Agent and Accept only, never the key, a cookie or anything of the
// member. Logs carry { event: 'audius', reason } only, never the key, the
// query, a ticket, an art URL or an id.
//
// SSRF: every JSON call is pinned to the API host, redirects included. The
// stream's first hop is pinned to the API host and its redirects (to a
// storage node) go to any https host on port 443 whose name resolves only to
// public addresses, checked in the socket's own lookup. The art fetch follows
// the same rule from its first hop: an https host on 443 that resolves only to
// public addresses, at most 3 redirects, each one checked again.

const FEATURE_OFF = 'feature-off'
const PAGE_SIZE = 12
const MAX_CURSOR = 500
const MAX_QUERY = 64
const MAX_PLAYLIST_TRACKS = 50
const CACHE_TTL_MS = 10 * 60 * 1000
const MAX_CACHED = 2000
const TICKET_TTL_MS = 30 * 60 * 1000
const TICKETS_PER_MEMBER = 8
const MAX_TICKETS = 5000
const RECHECK_MS = 60 * 1000
const DAY_MS = 24 * 3600 * 1000
const SEARCHES_PER_DAY = 200
const ITEMS_PER_DAY = 600
const RESOLVES_PER_DAY = 60
const PLAYS_PER_DAY = 300
const AUDIO_OPENS_PER_DAY = 1000
const OPENS_PER_TICKET = 64
const PROVIDER_PER_DAY = 12000
const ARTS_PER_DAY = 600
const ART_MAX_BYTES = 128 * 1024
// 128 covers of ART_MAX_BYTES: 16 MiB at worst.
const MAX_ART_CACHED = 128
// Cover fetches have their own slots: a slow art host must not fill the
// provider's MAX_INFLIGHT and turn search and play away.
const MAX_ART_INFLIGHT = 6
// One member's cover requests waiting on an art host fetch at once: the app
// loads three at once, and one member cannot hold every cover slot.
const ART_PER_MEMBER = 3
const ART_ACCEPT = 'image/jpeg, image/png, image/webp'
// A size=480 request answers within this, under the app's 25 s art timeout
// (AUDIUS_ART_TIMEOUT_MS): a lookup and the large fetch may already have
// taken a deadline each, so the small fallback fetch starts only while a
// whole art fetch still fits.
const ART_ANSWER_MS = 20 * 1000
// One member's provider JSON calls a day, never given back once the provider
// was contacted: what the search, item, resolve and play limits allow (a
// search, a resolve and a play are one call each, a playlist item two), so
// one member cannot spend the shared budget. The art route adds a lookup by
// id when the item's row is no longer cached, counted here too, so a member
// who loads covers of expired rows can reach it sooner.
const PROVIDER_CALLS_PER_DAY = SEARCHES_PER_DAY + 2 * ITEMS_PER_DAY + RESOLVES_PER_DAY + PLAYS_PER_DAY
const TICKET_BYTES = 256 * 1024 * 1024
const DAILY_BYTES = 1024 * 1024 * 1024
const STALL_MS = 20 * 1000
const TOTAL_MS = 15 * 60 * 1000
const STREAMS_PER_MEMBER = 2
const MAX_INFLIGHT = 16
const DEADLINE_MS = 10 * 1000
const JSON_CAP = 1024 * 1024
const MAX_BYTE_WINDOWS = 10000
const RETRY_AFTER_S = '5'
// Provider 4xx that point at our key (401, 403) or at load (408, 429), not
// at what was asked.
const NOT_AN_ANSWER = new Set([401, 403, 408, 429])
const USER_AGENT = 'varanda-music/1'
const TICKET_RE = /^[A-Za-z0-9_-]{43}$/
const CURSOR_RE = /^(0|[1-9][0-9]{0,2})$/
const CONTENT_RANGE_RE = /^bytes (\d{1,15})-(\d{1,15})\/(\d{1,15}|\*)$/
const UNSATISFIED_RANGE_RE = /^bytes \*\/\d{1,15}$/
const LENGTH_RE = /^\d{1,15}$/
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/ // eslint-disable-line no-control-regex
const AUDIO_TYPES = new Set(['audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/aac', 'audio/x-m4a', 'audio/ogg', 'audio/wav', 'audio/x-wav', 'audio/flac'])
const AUDIO_CSP = "default-src 'none'; sandbox"
const AUDIO_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': AUDIO_CSP,
  'Referrer-Policy': 'no-referrer'
})

// Bytes per member per day, with the eviction of refundableWindow (a full
// table forgets expired windows first, then the oldest). A clock that steps
// back keeps the row, as keyedWindow does: dropping it would forget the
// bytes already counted that day.
function byteWindow (limit, windowMs, now, max = MAX_BYTE_WINDOWS) {
  const windows = new Map()
  function row (key) {
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
      w = { start: t, used: 0 }
      windows.set(key, w)
    }
    return w
  }
  return {
    left: (key) => Math.max(0, limit - row(key).used),
    add: (key, n) => { row(key).used += n },
    giveBack: (key, n) => {
      const w = windows.get(key)
      if (w !== undefined) w.used = Math.max(0, w.used - n)
    }
  }
}

// The image type of `bytes` by its magic number, or null. GIF is not taken:
// a cover is a still image, and three formats are all Audius serves.
function imageType (bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'image/webp'
  return null
}

// `config` is parseAudiusConfig's result or null (off). `request`, `lookup`
// and `allowAddress` default to https.request, dns.lookup and publicAddress;
// `setTimer` and `clearTimer` (the cover expiry), `maxSpent` and `caps`
// ({ budget, calls, opens, arts, artMs, answerMs, ticketBytes, dailyBytes, stallMs,
// totalMs, recheckMs }) are replaced only by tests.
function createAudiusRoutes ({
  config = null,
  store,
  terms = null,
  blocklist = null,
  association,
  log = () => {},
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  request = https.request,
  lookup = dns.lookup,
  allowAddress = publicAddress,
  maxSpent,
  caps = {},
  http
}) {
  const { send, readJsonBody, checkPost, RouteError, refuse } = http
  const enabled = config !== null
  const moments = enabled && config.moments === true
  const covers = enabled && config.covers === true
  const artMs = caps.artMs ?? DEADLINE_MS
  const answerMs = caps.answerMs ?? ART_ANSWER_MS
  const budgetPerDay = caps.budget ?? PROVIDER_PER_DAY
  const ticketBytes = caps.ticketBytes ?? TICKET_BYTES
  const stallMs = caps.stallMs ?? STALL_MS
  const totalMs = caps.totalMs ?? TOTAL_MS
  const recheckMs = caps.recheckMs ?? RECHECK_MS

  const limits = {
    search: refundableWindow(SEARCHES_PER_DAY, DAY_MS, now),
    item: refundableWindow(ITEMS_PER_DAY, DAY_MS, now),
    resolve: refundableWindow(RESOLVES_PER_DAY, DAY_MS, now),
    play: refundableWindow(PLAYS_PER_DAY, DAY_MS, now),
    audio: refundableWindow(caps.opens ?? AUDIO_OPENS_PER_DAY, DAY_MS, now),
    art: refundableWindow(caps.arts ?? ARTS_PER_DAY, DAY_MS, now)
  }
  const budget = refundableWindow(budgetPerDay, DAY_MS, now, 1)
  const providerCalls = refundableWindow(caps.calls ?? PROVIDER_CALLS_PER_DAY, DAY_MS, now)
  const dailyBytes = byteWindow(caps.dailyBytes ?? DAILY_BYTES, DAY_MS, now)

  // kind:id -> { value, expiresAt }: provider metadata, memory only. A row
  // keeps the item's artwork URLs as `art` and `artLarge` (each a string or
  // null, never bytes), which the cover answer and the art route read, and a
  // track row its `genre` and `year` when the provider had them.
  const cache = new Map()
  // kind:id, or kind:id:480 for the large cover -> { mime, bytes, href,
  // expiresAt, timer }: cover bytes, memory only; `bytes` null records a
  // cover the art host did not serve as an image, `href` the URL it came
  // from. While the item's row is cached, an art row of another href (null
  // included) is dropped; once that row is gone, the art row still answers
  // until its own timer.
  const arts = new Map()
  // The arts key and href -> { promise, startedAt }: the running fetch of
  // that cover, shared by concurrent requests, and its Date.now() start.
  const pendingArt = new Map()
  // sha256(ticket) -> { member, id, expiresAt, checkedAt, bytes, opens }
  const tickets = new Map()
  const memberStreams = new Map()
  // member -> its art requests waiting on a host fetch, started or joined.
  const memberArts = new Map()
  let streams = 0
  let inflight = 0
  let artInflight = 0

  const featureOff = () => new RouteError(FEATURE_OFF, 404)
  const overLimit = () => new RouteError('limite-musica', 429)
  const unavailable = () => refuse('indisponivel')
  const notFound = () => refuse('nao-encontrado')
  const busy = () => {
    const err = refuse('indisponivel')
    err.headers = { 'Retry-After': RETRY_AFTER_S }
    return err
  }

  const auth = createMemberSession({ prefix: 'audius', overLimit, store, terms, blocklist, association, log, now, maxSpent, http })

  // The API URL's own port, when it names one: only the API host may use it.
  const apiPort = enabled ? new URL(config.base).port : ''

  function apiTarget (href) {
    let url
    try {
      url = new URL(href)
    } catch {
      return null
    }
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return null
    if (url.hostname.toLowerCase() !== config.apiHost || url.port !== apiPort) return null
    return { hostname: config.apiHost, port: apiPort === '' ? 443 : Number(apiPort), path: url.pathname + url.search, href: url.href }
  }

  const openJson = enabled ? createStreamFetch({ request, lookup, allowAddress, firstTarget: apiTarget, nextTarget: apiTarget, userAgent: USER_AGENT }) : null
  // A storage node may be any public https host: the redirect target is the
  // provider's choice, so only the address rules bind it.
  const openAudio = enabled ? createStreamFetch({ request, lookup, allowAddress, firstTarget: apiTarget, userAgent: USER_AGENT }) : null

  // One provider call against the service-wide daily budget, or a rejection
  // with a short token ('orcamento' when the budget is spent).
  function spendBudget () {
    if (!budget('all')) throw new Error('orcamento')
  }

  // -> the parsed JSON answer of a provider request for `member`, or a
  // rejection with a short token: 'status' when the provider answered with an
  // error status, 'limite' when the member's PROVIDER_CALLS_PER_DAY are
  // spent, anything else when no usable answer came. The member's call is
  // given back only when the provider is not contacted at all.
  async function providerJson (spec, member) {
    if (spec === null) throw new Error('pedido')
    if (inflight >= MAX_INFLIGHT) throw new Error('lotado')
    if (!providerCalls(member)) throw new Error('limite')
    try {
      spendBudget()
    } catch (err) {
      providerCalls.giveBack(member)
      throw err
    }
    inflight++
    const started = Date.now()
    let up = null
    let timer = null
    try {
      up = await openJson(spec.href, { firstHeaders: spec.firstHeaders, accept: 'application/json', connectMs: DEADLINE_MS })
      if (up.type !== 'application/json') throw new Error('tipo')
      // One deadline for the whole exchange: what the headers left of it.
      timer = setTimeout(() => up.destroy(), Math.max(0, DEADLINE_MS - (Date.now() - started)))
      const raw = await readCapped(up.stream, JSON_CAP)
      return JSON.parse(raw.toString('utf8'))
    } finally {
      clearTimeout(timer)
      if (up !== null) up.destroy()
      inflight--
    }
  }

  // The refusal of a failed provider call. A 4xx other than 401, 403, 408
  // and 429 is the provider's answer about the request: on a lookup by id it
  // is 'nao-encontrado', on a search 'indisponivel', and the use is not given
  // back, so a request the provider refuses cannot be looped for free. Any
  // other failure (an outage, throttling, our key refused, a member over
  // PROVIDER_CALLS_PER_DAY) says nothing about the request, so the use is
  // given back; the member's provider call, once made, never is.
  function failed (err, limit, member, { byId = false } = {}) {
    const token = err && err.message
    if (token === 'limite') {
      limit.giveBack(member)
      return overLimit()
    }
    const answered = token === 'status' && err.status >= 400 && err.status < 500 && !NOT_AN_ANSWER.has(err.status)
    if (answered && byId) return notFound()
    if (!answered) limit.giveBack(member)
    log({ event: 'audius', reason: token === 'orcamento' ? 'orcamento' : 'indisponivel' })
    return unavailable()
  }

  function remember (key, value) {
    cache.delete(key)
    cache.set(key, { value, expiresAt: now() + CACHE_TTL_MS })
    while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value)
  }

  function recalled (key) {
    const row = cache.get(key)
    if (row === undefined) return null
    const t = now()
    if (row.expiresAt <= t || row.expiresAt - t > CACHE_TTL_MS) {
      cache.delete(key)
      return null
    }
    cache.delete(key)
    cache.set(key, row)
    return row.value
  }

  function trackItem (t) {
    return { id: t.id, title: t.title, artist: t.artist, duration: t.duration, url: t.url }
  }

  function playlistItem (p) {
    return { id: p.id, title: p.title, artist: p.artist, count: p.count, url: p.url }
  }

  function hrefOf (mapped) {
    return typeof mapped.art === 'string' ? mapped.art : null
  }

  function largeHrefOf (mapped) {
    return typeof mapped.artLarge === 'string' ? mapped.artLarge : null
  }

  // The song info of a mapped track or a cached row: only the keys it holds.
  function infoOf (t) {
    const out = {}
    if (typeof t.genre === 'string') out.genre = t.genre
    if (Number.isInteger(t.year)) out.year = t.year
    return out
  }

  // The cached row of a mapped track: its answer keys, the artwork URLs and
  // the song info, which only shown() reads back.
  function trackRow (track) {
    return { ...trackItem(track), art: hrefOf(track), artLarge: largeHrefOf(track), ...infoOf(track) }
  }

  // -> the cached row of a track: its answer keys plus `art`, `artLarge` and
  // the song info, which trackItem strips from every answer. With `wanted`, a
  // track under another id is refused before it is cached.
  function mappedTrack (json, wanted = null) {
    const track = fromTrack(json)
    if (track === null) return null
    if (wanted !== null && track.id !== wanted) return null
    const row = trackRow(track)
    remember('track:' + row.id, row)
    return row
  }

  // A playlist seen without its tracks (a search, a resolve, the art route)
  // is cached with `tracks` null: its cover is known, and lookupPlaylist
  // still fetches the tracks. A full row is never replaced by such a row, but
  // takes its `art` and `artLarge`: the newest mapping wins, so the cover flag
  // of this answer is what the art route reads.
  function rememberPlaylist (playlist) {
    const row = { ...playlistItem(playlist), art: hrefOf(playlist), artLarge: largeHrefOf(playlist), tracks: null }
    const old = recalled('playlist:' + row.id)
    if (old === null || old.tracks === null) remember('playlist:' + row.id, row)
    else {
      old.art = row.art
      old.artLarge = row.artLarge
    }
    return row
  }

  // The answer form of an item: today's keys, plus `cover` only when the app
  // asked for it and the operator turned covers on, and a track's `genre` and
  // `year` only when the app asked for them: an installed app parses exact
  // keys. `row` is the cached row; a playlist row holds no song info.
  function shown (item, row, withCovers, withInfo = false) {
    let out = item
    if (withCovers) out = { ...out, cover: typeof row.art === 'string' }
    if (withInfo) out = { ...out, ...infoOf(row) }
    return out
  }

  function wantsCovers (url) {
    return covers && url !== undefined && url !== null && url.searchParams.get('covers') === '1'
  }

  function wantsInfo (url) {
    return url !== undefined && url !== null && url.searchParams.get('info') === '1'
  }

  function wantsLarge (url) {
    return url !== undefined && url !== null && url.searchParams.get('size') === '480'
  }

  // The provider's single object, as an object or an array of one.
  function single (json) {
    const data = json !== null && typeof json === 'object' ? json.data : undefined
    if (Array.isArray(data)) return data.length === 1 ? data[0] : null
    return data
  }

  function exactKeys (body, required, optional = []) {
    for (const k of Object.keys(body)) if (!required.includes(k) && !optional.includes(k)) throw refuse('pedido-invalido')
    for (const k of required) if (body[k] === undefined) throw refuse('pedido-invalido')
  }

  function kindParam (v) {
    if (v !== 'track' && v !== 'playlist') throw refuse('pedido-invalido')
    return v
  }

  function idParam (v) {
    if (typeof v !== 'string' || !ID_RE.test(v)) throw refuse('pedido-invalido')
    return v
  }

  function queryParam (v) {
    if (typeof v !== 'string' || CONTROL_RE.test(v)) throw refuse('pedido-invalido')
    const length = [...v].length
    if (length < 1 || length > MAX_QUERY || v.trim() === '') throw refuse('pedido-invalido')
    return v
  }

  function cursorParam (v) {
    if (v === undefined) return 0
    if (typeof v !== 'string' || !CURSOR_RE.test(v) || Number(v) > MAX_CURSOR) throw refuse('pedido-invalido')
    return Number(v)
  }

  async function search (res, member, body, url) {
    exactKeys(body, ['q', 'kind'], ['cursor'])
    const q = queryParam(body.q)
    const kind = kindParam(body.kind)
    const offset = cursorParam(body.cursor)
    if (!limits.search(member)) throw overLimit()
    const spec = requestFor(config, kind === 'track' ? 'searchTracks' : 'searchPlaylists', { query: q, limit: PAGE_SIZE, offset })
    let list
    try {
      list = listOf(await providerJson(spec, member))
      if (list === null) throw new Error('forma')
    } catch (err) {
      throw failed(err, limits.search, member)
    }
    const rows = []
    for (const it of list.slice(0, PAGE_SIZE)) {
      if (kind === 'track') {
        const track = mappedTrack(it)
        if (track !== null) rows.push(track)
      } else {
        const playlist = fromPlaylist(it)
        if (playlist !== null) rows.push(rememberPlaylist(playlist))
      }
    }
    const next = nextCursor(offset, list.length, PAGE_SIZE)
    log({ event: 'audius', reason: 'busca' })
    const withCovers = wantsCovers(url)
    const withInfo = kind === 'track' && wantsInfo(url)
    const items = rows.map((row) => shown(kind === 'track' ? trackItem(row) : playlistItem(row), row, withCovers, withInfo))
    send(res, 200, { items, next: next !== null && Number(next) <= MAX_CURSOR ? next : null })
  }

  // The track by id, through the cache: null when the provider has no track
  // that fromTrack admits, or answers another id. /play checks the track it
  // got but tickets the id it was asked, so the two must be the same track.
  // Rejects like providerJson.
  async function lookupTrack (id, member) {
    const cached = recalled('track:' + id)
    if (cached !== null) return cached
    return mappedTrack(single(await providerJson(requestFor(config, 'track', { id }), member)), id)
  }

  async function lookupPlaylist (id, member) {
    const cached = recalled('playlist:' + id)
    if (cached !== null && cached.tracks !== null) return cached
    const playlist = fromPlaylist(single(await providerJson(requestFor(config, 'playlist', { id }), member)))
    if (playlist === null || playlist.id !== id) return null
    const list = listOf(await providerJson(requestFor(config, 'playlistTracks', { id }), member))
    if (list === null) throw new Error('forma')
    const tracks = []
    for (const it of list) {
      if (tracks.length >= MAX_PLAYLIST_TRACKS) break
      const track = mappedTrack(it)
      if (track !== null) tracks.push(track)
    }
    const value = { ...playlistItem(playlist), art: hrefOf(playlist), artLarge: largeHrefOf(playlist), tracks }
    remember('playlist:' + id, value)
    return value
  }

  async function item (res, member, body, url) {
    exactKeys(body, ['kind', 'id'])
    const kind = kindParam(body.kind)
    const id = idParam(body.id)
    if (!limits.item(member)) throw overLimit()
    let value
    try {
      value = kind === 'track' ? await lookupTrack(id, member) : await lookupPlaylist(id, member)
    } catch (err) {
      throw failed(err, limits.item, member, { byId: true })
    }
    if (value === null) throw notFound()
    log({ event: 'audius', reason: 'item' })
    const withCovers = wantsCovers(url)
    const withInfo = wantsInfo(url)
    if (kind === 'track') return send(res, 200, shown(trackItem(value), value, withCovers, withInfo))
    // A listed track's flag comes from its own row, which a later search may
    // have replaced: that row is what the art route reads.
    const own = (x) => (withCovers ? recalled('track:' + x.id) ?? x : x)
    send(res, 200, { ...shown(playlistItem(value), value, withCovers), tracks: value.tracks.map((x) => shown(trackItem(x), own(x), withCovers, withInfo)) })
  }

  async function resolve (res, member, body, url) {
    exactKeys(body, ['url'])
    if (!isAudiusPermalink(body.url)) throw refuse('pedido-invalido')
    if (!limits.resolve(member)) throw overLimit()
    let found
    try {
      found = fromResolve(await providerJson(requestFor(config, 'resolve', { url: body.url }), member))
    } catch (err) {
      throw failed(err, limits.resolve, member, { byId: true })
    }
    if (found === null) throw notFound()
    log({ event: 'audius', reason: 'resolve' })
    const withCovers = wantsCovers(url)
    if (found.kind === 'track') {
      const row = trackRow(found.item)
      remember('track:' + row.id, row)
      return send(res, 200, { kind: 'track', item: shown(trackItem(row), row, withCovers, wantsInfo(url)) })
    }
    const row = rememberPlaylist(found.item)
    send(res, 200, { kind: 'playlist', item: shown(playlistItem(row), row, withCovers) })
  }

  // Each row expires by its own timer, so a cover nobody asks for again is
  // gone after CACHE_TTL_MS too, not kept until the next read.
  function dropArt (key) {
    const row = arts.get(key)
    if (row === undefined) return
    clearTimer(row.timer)
    arts.delete(key)
  }

  function storeArt (key, mime, bytes, href) {
    dropArt(key)
    const row = { mime, bytes, href, expiresAt: now() + CACHE_TTL_MS, timer: null }
    row.timer = setTimer(() => {
      if (arts.get(key) === row) arts.delete(key)
    }, CACHE_TTL_MS)
    if (row.timer && typeof row.timer.unref === 'function') row.timer.unref()
    arts.set(key, row)
    while (arts.size > MAX_ART_CACHED) dropArt(arts.keys().next().value)
  }

  function storedArt (key) {
    const row = arts.get(key)
    if (row === undefined) return null
    const t = now()
    if (row.expiresAt <= t || row.expiresAt - t > CACHE_TTL_MS) {
      dropArt(key)
      return null
    }
    return row
  }

  // The item's cached row, or one provider call by id: null when the
  // provider has no such item. Rejects like providerJson.
  async function artRow (kind, id, member) {
    const row = recalled(kind + ':' + id)
    if (row !== null) return row
    const json = single(await providerJson(requestFor(config, kind, { id }), member))
    if (kind === 'track') return mappedTrack(json, id)
    const playlist = fromPlaylist(json)
    if (playlist === null || playlist.id !== id) return null
    return rememberPlaylist(playlist)
  }

  // The small art URL of an item. Rejects like providerJson.
  async function artHref (kind, id, member) {
    const row = await artRow(kind, id, member)
    return row === null ? null : row.art
  }

  // The request of every art hop, first and redirects alike: each contact
  // with the art host spends one unit of the shared budget, never given
  // back, and is counted in `state.contacts`. The stream fetch reports a
  // throw here as a failed request, so the spent budget is also recorded in
  // `state`.
  function budgetedRequest (state) {
    return (opts) => {
      try {
        spendBudget()
      } catch {
        state.budgetSpent = true
        const err = new Error('orcamento')
        err.budgetSpent = true
        throw err
      }
      state.contacts++
      return request(opts)
    }
  }

  // One fetch of a cover, shared by every request for `key` while it runs.
  // Never rejects: -> { row } with the bytes, { missing: true } for a cover
  // the host does not serve as an image, or { contacted } for any other
  // failure, `contacted` false only when no art host was reached.
  async function fetchArt (key, href) {
    const state = { budgetSpent: false, contacts: 0 }
    const openArt = createStreamFetch({ request: budgetedRequest(state), lookup, allowAddress, firstTarget: httpsTarget, userAgent: USER_AGENT })
    artInflight++
    const started = Date.now()
    let up = null
    let timer = null
    let bytes
    try {
      up = await openArt(href, { accept: ART_ACCEPT, connectMs: artMs })
      if (up.status !== 200) throw new Error('status-parcial')
      timer = setTimeout(() => up.destroy(), Math.max(0, artMs - (Date.now() - started)))
      bytes = await readCapped(up.stream, ART_MAX_BYTES)
    } catch (err) {
      const token = err && err.message
      const answered = token === 'status' && err.status >= 400 && err.status < 500 && !NOT_AN_ANSWER.has(err.status)
      // An oversize cover is oversize on every try: asking again would only
      // spend the budget.
      if (answered || token === 'grande') {
        storeArt(key, null, null, href)
        return { missing: true }
      }
      log({ event: 'audius', reason: state.budgetSpent ? 'orcamento' : 'indisponivel' })
      return { contacted: state.contacts > 0 }
    } finally {
      clearTimeout(timer)
      if (up !== null) up.destroy()
      artInflight--
    }
    const mime = imageType(bytes)
    if (mime === null) {
      storeArt(key, null, null, href)
      return { missing: true }
    }
    storeArt(key, mime, bytes, href)
    return { row: { mime, bytes } }
  }

  function sendArt (res, row) {
    log({ event: 'audius', reason: 'capa' })
    send(res, 200, { mime: row.mime, bytes: row.bytes.toString('base64') }, { 'X-Content-Type-Options': 'nosniff' })
  }

  async function art (res, member, body, url) {
    exactKeys(body, ['kind', 'id'])
    const kind = kindParam(body.kind)
    const id = idParam(body.id)
    if (!covers) throw featureOff()
    if (!limits.art(member)) throw overLimit()
    if (wantsLarge(url)) return largeArt(res, member, kind, id)
    return smallArt(res, member, kind, id)
  }

  // The 150x150 cover, the only one an older app asks for.
  async function smallArt (res, member, kind, id) {
    const key = kind + ':' + id
    const current = recalled(key)
    let hit = storedArt(key)
    if (hit !== null && current !== null && hit.href !== current.art) {
      dropArt(key)
      hit = null
    }
    if (hit !== null) {
      if (hit.bytes === null) throw notFound()
      return sendArt(res, hit)
    }
    let href
    try {
      href = await artHref(kind, id, member)
    } catch (err) {
      throw failed(err, limits.art, member, { byId: true })
    }
    if (typeof href !== 'string') throw notFound()
    const out = await loadArt(member, key, href)
    if (out.row !== undefined) return sendArt(res, out.row)
    throw notFound()
  }

  // The 480x480 cover under its own arts key, so the two sizes never answer
  // each other. An item without one gets the small path as is. A large miss
  // answers the small cover in the same request and art use, when its href
  // differs: an oversize 480 must not cost the member the cover. A busy or
  // failed fetch is answered as is, never retried at another size.
  async function largeArt (res, member, kind, id) {
    const started = Date.now()
    const key = kind + ':' + id
    const largeKey = key + ':480'
    let row = recalled(key)
    const hit = storedArt(largeKey)
    if (hit !== null && row !== null && hit.href !== row.artLarge) dropArt(largeKey)
    else if (hit !== null && hit.bytes !== null) return sendArt(res, hit)
    // A remembered large miss with no cached row is the small request, cache
    // first, as plain art answers it: no lookup only to learn the small href.
    else if (hit !== null && row === null) return smallArt(res, member, kind, id)
    if (row === null) {
      try {
        row = await artRow(kind, id, member)
      } catch (err) {
        throw failed(err, limits.art, member, { byId: true })
      }
      if (row === null) throw notFound()
    }
    const large = largeHrefOf(row)
    // A concurrent request may have stored a newer row meanwhile.
    if (hit !== null && arts.get(largeKey) === hit && hit.href !== large) dropArt(largeKey)
    if (large === null) return smallArt(res, member, kind, id)
    const out = await loadArt(member, largeKey, large)
    if (out.row !== undefined) return sendArt(res, out.row)
    const small = hrefOf(row)
    if (small === null || small === large) throw notFound()
    const back = await loadArt(member, key, small, out.fetched, started + answerMs - artMs)
    if (back.row !== undefined) return sendArt(res, back.row)
    throw notFound()
  }

  // The cover of `href` under the arts `key`: -> { row } with its bytes, or
  // { missing, fetched } for a cover the host does not serve as an image,
  // `fetched` false when that miss was already remembered. Throws busy() or
  // unavailable(), giving the art use back only when no art host was
  // contacted; `keepUse` says this request already had one contacted. Past
  // `startBy` (a Date.now() instant) no fetch starts and none is joined that
  // started after it, as it could end past the deadline: -> { late: true }.
  async function loadArt (member, key, href, keepUse = false, startBy = Infinity) {
    const pending = key + ' ' + href
    const running = pendingArt.get(pending)
    let fetching = running === undefined ? undefined : running.promise
    if (fetching === undefined) {
      const done = storedArt(key)
      if (done !== null && done.href === href) return done.bytes === null ? { missing: true, fetched: false } : { row: done }
      if (Date.now() > startBy) return { late: true }
    } else if (running.startedAt > startBy) return { late: true }
    const waiting = memberArts.get(member) || 0
    if (waiting >= ART_PER_MEMBER || (fetching === undefined && artInflight >= MAX_ART_INFLIGHT)) {
      if (!keepUse) limits.art.giveBack(member)
      throw busy()
    }
    if (fetching === undefined) {
      const startedAt = Date.now()
      fetching = fetchArt(key, href)
      const entry = { promise: fetching, startedAt }
      pendingArt.set(pending, entry)
      const settled = () => {
        if (pendingArt.get(pending) === entry) pendingArt.delete(pending)
      }
      fetching.then(settled, settled)
    }
    memberArts.set(member, waiting + 1)
    let out
    try {
      out = await fetching
    } finally {
      const n = memberArts.get(member) - 1
      if (n > 0) memberArts.set(member, n)
      else memberArts.delete(member)
    }
    if (out.row !== undefined) return out
    if (out.missing) return { missing: true, fetched: true }
    // Each failed contact spent the shared budget: keeping the use is what
    // stops one member looping on a failing cover from spending it for all.
    if (!out.contacted && !keepUse) limits.art.giveBack(member)
    throw unavailable()
  }

  function digest (ticket) {
    return nodeCrypto.createHash('sha256').update(ticket).digest('hex')
  }

  function sweepTickets () {
    const t = now()
    for (const [k, v] of tickets) if (v.expiresAt <= t) tickets.delete(k)
  }

  async function play (res, member, body) {
    exactKeys(body, ['id'])
    const id = idParam(body.id)
    if (!limits.play(member)) throw overLimit()
    let track
    try {
      track = await lookupTrack(id, member)
    } catch (err) {
      throw failed(err, limits.play, member, { byId: true })
    }
    if (track === null) throw notFound()
    // auth.member may reuse a standing check up to RECHECK_MS old while the
    // ticket records its check as now, so the standing is checked fresh here:
    // without it a member blocked just before this could open audio for up
    // to two RECHECK_MS. With it, and with the re-check of every running
    // relay in audio(), a member blocked at any time loses audio within one
    // RECHECK_MS. The refusal is liveTicket's, and the use stays spent, as
    // for any other nao-encontrado.
    if (auth.standing(member) !== null) throw notFound()
    sweepTickets()
    // A ninth ticket retires the member's oldest: a member skipping through
    // songs is the common case, and only the newest few can still play.
    let own = 0
    let oldest = null
    for (const [k, v] of tickets) {
      if (v.member !== member) continue
      own++
      if (oldest === null) oldest = k
    }
    if (own >= TICKETS_PER_MEMBER) tickets.delete(oldest)
    // Fail closed: forgetting another member's live ticket would stop its song.
    if (tickets.size >= MAX_TICKETS) {
      limits.play.giveBack(member)
      throw unavailable()
    }
    const ticket = nodeCrypto.randomBytes(32).toString('base64url')
    const t = now()
    const expiresAt = t + TICKET_TTL_MS
    tickets.set(digest(ticket), { member, id, expiresAt, checkedAt: t, bytes: 0, opens: 0 })
    log({ event: 'audius', reason: 'toque' })
    send(res, 200, { ticket, expiresAt: new Date(expiresAt).toISOString() })
  }

  // The live ticket row, or a 404. The member's standing is re-checked at
  // most every RECHECK_MS; a member who fails it loses the ticket.
  function liveTicket (ticket) {
    if (!TICKET_RE.test(ticket)) throw notFound()
    const key = digest(ticket)
    const row = tickets.get(key)
    if (row === undefined) throw notFound()
    const t = now()
    if (row.expiresAt <= t) {
      tickets.delete(key)
      throw notFound()
    }
    if (t < row.checkedAt || t - row.checkedAt >= RECHECK_MS) {
      if (auth.standing(row.member) !== null) {
        tickets.delete(key)
        throw notFound()
      }
      row.checkedAt = t
    }
    return { key, row }
  }

  async function audio (req, res, ticket) {
    const { key, row } = liveTicket(ticket)
    const member = row.member
    if (streams >= config.streams || (memberStreams.get(member) || 0) >= STREAMS_PER_MEMBER) {
      log({ event: 'audius', reason: 'indisponivel' })
      throw busy()
    }
    // Charged when the response ends. Two streams of one member may each
    // start from the same remainder, so the caps hold within a factor of
    // STREAMS_PER_MEMBER; reserving the room up front instead would starve
    // the second request a seeking media element makes.
    const room = Math.min(ticketBytes - row.bytes, dailyBytes.left(member))
    if (room <= 0) {
      if (ticketBytes - row.bytes <= 0) {
        tickets.delete(key)
        throw notFound()
      }
      throw overLimit()
    }
    const spec = requestFor(config, 'stream', { id: row.id })
    if (spec === null) throw notFound()
    // A request may send no audio and so charge no byte (a range past the
    // end), yet it spends the shared budget: counting opens is what stops one
    // ticket from looping until music is off for every member.
    if (row.opens >= OPENS_PER_TICKET) {
      tickets.delete(key)
      throw notFound()
    }
    if (!limits.audio(member)) throw overLimit()
    row.opens++
    try {
      spendBudget()
    } catch {
      log({ event: 'audius', reason: 'orcamento' })
      throw unavailable()
    }

    streams++
    memberStreams.set(member, (memberStreams.get(member) || 0) + 1)
    let released = false
    let skip = 0
    // Charges what was downloaded: the bytes sent and those discarded of a
    // skip, which may be fewer than planned when the upstream closed early.
    const release = (sent, skipped) => {
      if (released) return
      released = true
      streams--
      const n = memberStreams.get(member) - 1
      if (n > 0) memberStreams.set(member, n)
      else memberStreams.delete(member)
      if (skipped + sent > 0) {
        row.bytes += skipped + sent
        dailyBytes.add(member, skipped + sent)
      }
    }
    let gone = false
    res.once('close', () => { gone = true })

    const range = parseRange(req.headers.range)
    let up
    try {
      up = await openAudio(spec.href, { firstHeaders: spec.firstHeaders, range: range === null ? null : req.headers.range, accept: 'audio/*' })
    } catch (err) {
      release(0, 0)
      if (err.status === 416) {
        // A range past the end: the media element needs the 416 to stop.
        const headers = { ...AUDIO_HEADERS, 'Content-Length': 0 }
        if (typeof err.contentRange === 'string' && UNSATISFIED_RANGE_RE.test(err.contentRange)) headers['Content-Range'] = err.contentRange
        res.writeHead(416, headers)
        return res.end()
      }
      log({ event: 'audius', reason: 'indisponivel' })
      throw unavailable()
    }
    const refuseUp = (err) => {
      up.destroy()
      release(0, 0)
      return err
    }
    if (gone) throw refuseUp(unavailable())
    if (!AUDIO_TYPES.has(up.type)) {
      log({ event: 'audius', reason: 'indisponivel' })
      throw refuseUp(unavailable())
    }

    const lengthHeader = up.headers['content-length']
    const length = typeof lengthHeader === 'string' && LENGTH_RE.test(lengthHeader) ? Number(lengthHeader) : null
    const headers = { 'Content-Type': up.type, ...AUDIO_HEADERS }
    let status
    let size = null
    if (up.status === 206) {
      const m = typeof up.headers['content-range'] === 'string' ? up.headers['content-range'].match(CONTENT_RANGE_RE) : null
      const start = m === null ? NaN : Number(m[1])
      const end = m === null ? NaN : Number(m[2])
      const total = m === null || m[3] === '*' ? null : Number(m[3])
      const valid = range !== null && m !== null && start === range.start && end >= start && (total === null || end < total) &&
        (length === null || length === end - start + 1)
      if (!valid) {
        log({ event: 'audius', reason: 'indisponivel' })
        throw refuseUp(unavailable())
      }
      // A node may answer more than was asked: only the asked slice is
      // relayed and charged.
      const last = range.end !== null && end > range.end ? range.end : end
      status = 206
      size = last - start + 1
      headers['Content-Range'] = 'bytes ' + start + '-' + last + '/' + (total === null ? '*' : total)
      headers['Accept-Ranges'] = 'bytes'
    } else if (range !== null && length !== null) {
      // The node ignored Range: the asked slice is cut from the full body.
      log({ event: 'audius', reason: 'sem-range' })
      if (range.start >= length) {
        up.destroy()
        release(0, 0)
        res.writeHead(416, { ...AUDIO_HEADERS, 'Content-Range': 'bytes */' + length, 'Content-Length': 0 })
        return res.end()
      }
      const end = range.end === null ? length - 1 : Math.min(range.end, length - 1)
      status = 206
      size = end - range.start + 1
      headers['Content-Range'] = 'bytes ' + range.start + '-' + end + '/' + length
      headers['Accept-Ranges'] = 'bytes'
    } else {
      status = 200
      size = length
      if (length !== null) headers['Accept-Ranges'] = 'bytes'
    }
    if (size !== null) headers['Content-Length'] = size
    if (status === 206 && up.status === 200) skip = range.start

    // The skipped bytes are downloaded too, so they count against the room:
    // that bounds what a far Range can make this service fetch.
    const avail = room - skip
    if (avail <= 0) throw refuseUp(overLimit())
    const cap = size === null ? avail : Math.min(avail, size)
    log({ event: 'audius', reason: 'audio' })
    res.writeHead(status, headers)
    // A relay outlives the open's standing check by up to TOTAL_MS, so the
    // standing is checked again while it runs. A failing member loses the
    // ticket; a store that cannot answer cuts the relay but keeps the ticket,
    // as liveTicket refuses then without retiring it. Destroying the upstream
    // makes pipeCapped cut the response, unended, charging what was sent.
    const recheck = setInterval(() => {
      let good
      try {
        good = auth.standing(member) === null
      } catch {
        log({ event: 'audius', reason: 'indisponivel' })
        return up.destroy()
      }
      if (good) {
        row.checkedAt = now()
        return
      }
      tickets.delete(key)
      log({ event: 'audius', reason: 'sessao-revogada' })
      up.destroy()
    }, recheckMs)
    pipeCapped(up.stream, res, {
      skip,
      cap,
      size,
      stallMs,
      totalMs,
      onDone: (reason, bytes, skipped) => {
        clearInterval(recheck)
        up.destroy()
        release(bytes, skipped)
      }
    })
  }

  function owns (pathname) {
    return pathname === '/account/audius' || pathname.startsWith('/account/audius/')
  }

  const BEARER = {
    '/account/audius/search': search,
    '/account/audius/item': item,
    '/account/audius/resolve': resolve,
    '/account/audius/play': play,
    '/account/audius/art': art
  }

  async function handle (req, res, url) {
    const pathname = url.pathname
    if (req.method === 'GET' && pathname === '/account/audius/policy') return send(res, 200, { enabled, moments })
    if (!enabled) throw featureOff()
    if (pathname.startsWith('/account/audius/audio/')) {
      if (req.method !== 'GET') {
        const err = new RouteError('pedido-invalido', 405)
        err.headers = { Allow: 'GET' }
        throw err
      }
      return audio(req, res, pathname.slice('/account/audius/audio/'.length))
    }
    if (req.method === 'POST' && (pathname === '/account/audius/session/start' || pathname === '/account/audius/session/finish')) {
      checkPost(req)
      const body = await readJsonBody(req)
      return pathname.endsWith('/start') ? auth.start(req, res, body) : auth.finish(req, res, body)
    }
    if (req.method === 'POST' && Object.hasOwn(BEARER, pathname)) {
      checkPost(req)
      const member = auth.member(req)
      return BEARER[pathname](res, member, await readJsonBody(req), url)
    }
    throw notFound()
  }

  function stats () {
    return { ...auth.stats(), cached: cache.size, covers: arts.size, inflight, artInflight, tickets: tickets.size, streams }
  }

  return { owns, handle, stats, enabled: () => enabled }
}

module.exports = {
  FEATURE_OFF,
  USER_AGENT,
  PAGE_SIZE,
  SEARCHES_PER_DAY,
  ITEMS_PER_DAY,
  RESOLVES_PER_DAY,
  PLAYS_PER_DAY,
  AUDIO_OPENS_PER_DAY,
  OPENS_PER_TICKET,
  PROVIDER_PER_DAY,
  PROVIDER_CALLS_PER_DAY,
  ARTS_PER_DAY,
  ART_MAX_BYTES,
  MAX_ART_CACHED,
  MAX_ART_INFLIGHT,
  ART_PER_MEMBER,
  ART_ANSWER_MS,
  TICKET_TTL_MS,
  TICKETS_PER_MEMBER,
  STREAMS_PER_MEMBER,
  createAudiusRoutes
}
