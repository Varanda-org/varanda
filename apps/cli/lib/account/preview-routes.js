'use strict'

const https = require('node:https')
const dns = require('node:dns')
const { isHostname, publicAddress, httpsTarget, createSafeFetch } = require('./safe-fetch')
const { refundableWindow, createMemberSession } = require('./member-session')
const { MAX_CARD_URL, MAX_CARD_TITLE, MAX_CARD_DESC, cardUrlHost, parseOg } = require('@varanda/rpc')

// Link previews through the account service (mounted by ./server.js), so the
// member's device never opens a link it did not tap and the site sees this
// service's address, never the member's. On by default: it needs no
// third-party key, and the operator can turn it off (server option
// `preview: false`).
//
//   - GET /account/preview/policy answers { enabled } even when off, so the
//     app can hide previews. Every other /account/preview/* route then
//     answers 404 { error: 'feature-off' }.
//   - POST /account/preview/session/start and /finish: the member session of
//     ./member-session.js under its own prefix 'preview' (own HMAC key, own
//     nonce domain, own tokens), so a GIF nonce or token never works here
//     and a preview one never works at the GIF routes.
//   - POST /account/preview with a body of exactly { url } and
//     `Authorization: Bearer <token>` -> { url, host, title, desc, image }.
//     The page is fetched through ./safe-fetch.js (https on port 443 only,
//     a dotted hostname, public addresses only, at most 3 redirects each
//     re-checked, DEADLINE_MS, PAGE_CAP, text/html only) and read inertly by
//     parseOg of @varanda/rpc, the reader the app uses; nothing is run,
//     framed or loaded except the og:image, fetched under the same guards
//     (IMAGE_CAP, an image type confirmed by its leading bytes) and returned
//     as base64 bytes. `url` and `host` name the final page after redirects.
//
// Nothing is stored: no URL, title or token reaches memory beyond the
// request or any log line; logs carry { event: 'preview', reason } counts.

const FEATURE_OFF = 'feature-off'
const DEADLINE_MS = 5 * 1000
const MAX_REDIRECTS = 3
const PAGE_CAP = 512 * 1024
const IMAGE_CAP = 256 * 1024
const MAX_URL = MAX_CARD_URL
const MAX_TITLE = MAX_CARD_TITLE
const MAX_DESC = MAX_CARD_DESC
const MAX_INFLIGHT = 16
// The member picks the target, so one member could hold every global slot
// with a host that never answers: each member runs at most this many at once
// (a third answers 503 indisponivel, like the global cap, so the app never
// reads it as the daily limit).
const MAX_INFLIGHT_PER_MEMBER = 2
const DAY_MS = 24 * 3600 * 1000
const PREVIEWS_PER_DAY = 60
const USER_AGENT = 'varanda-preview/1'
const PAGE_TYPES = ['text/html']
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/ // eslint-disable-line no-control-regex

// --- page reading ---------------------------------------------------------------

// The card of a page read from `html` at `finalUrl` (the URL it was fetched
// from, after redirects), or null when that URL is not one a card may carry.
// The reader is parseOg of @varanda/rpc, the one the app uses, so both build
// the same card from the same page; `title` and `desc` are '' when empty,
// as core's link card requires strings.
function cardFromPage (html, finalUrl) {
  const host = cardUrlHost(finalUrl)
  if (host === null || httpsTarget(finalUrl) === null) return null
  const { title, desc, imageUrl } = parseOg(html, finalUrl)
  return { url: finalUrl, host, title: title || '', desc: desc || '', imageUrl }
}

// The image type its leading bytes show, or null.
function sniffImage (buf) {
  if (buf.length >= 8 && buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG' && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return 'image/png'
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf.length >= 6 && (buf.toString('latin1', 0, 6) === 'GIF87a' || buf.toString('latin1', 0, 6) === 'GIF89a')) return 'image/gif'
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp'
  return null
}

// The member's link as a URL this service may fetch, or null: https, a
// dotted hostname (no IP literal), port 443, no user or password, at most
// MAX_URL characters before and after normalizing, and a normalized form
// core's link card accepts (cardUrlHost of @varanda/rpc: no brace, pipe or
// other character outside the canonical set; the fragment is kept), and
// never a /convite path.
function linkParam (v) {
  if (typeof v !== 'string' || v.length < 1 || v.length > MAX_URL || CONTROL_RE.test(v) || v.trim() !== v) return null
  let url
  try {
    url = new URL(v)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '') return null
  const host = url.hostname.toLowerCase()
  if (!isHostname(host) || !host.includes('.')) return null
  // A signup invite link on any host: its fragment can carry the card's
  // name, message and code, so it is refused like any other bad link.
  if (url.pathname === '/convite' || url.pathname.startsWith('/convite/')) return null
  if (url.href.length > MAX_URL || cardUrlHost(url.href) !== host) return null
  return url
}

// --- routes -------------------------------------------------------------------

// `enabled` false answers the policy { enabled: false } and 404 feature-off
// everywhere else. `request`, `lookup`, `allowAddress` and `deadlineMs`
// default to https.request, dns.lookup, publicAddress and DEADLINE_MS; only
// tests replace them, to reach a loopback fixture. `maxSpent` is replaced
// only by tests.
function createPreviewRoutes ({
  enabled = true,
  store,
  terms = null,
  blocklist = null,
  association,
  log = () => {},
  now = Date.now,
  request = https.request,
  lookup = dns.lookup,
  allowAddress = publicAddress,
  deadlineMs = DEADLINE_MS,
  maxSpent,
  http
}) {
  const { send, readJsonBody, checkPost, RouteError, refuse } = http
  const on = enabled === true
  let inflight = 0
  const inflightOf = new Map()

  const quota = refundableWindow(PREVIEWS_PER_DAY, DAY_MS, now)
  const featureOff = () => new RouteError(FEATURE_OFF, 404)
  const unavailable = () => refuse('indisponivel')
  const overLimit = () => new RouteError('limite-previa', 429)
  const auth = createMemberSession({ prefix: 'preview', overLimit, store, terms, blocklist, association, log, now, maxSpent, http })
  const safeFetch = createSafeFetch({ request, lookup, allowAddress, target: httpsTarget, userAgent: USER_AGENT, deadlineMs, maxRedirects: MAX_REDIRECTS })

  // A page fetch that also says whether this service refused it before any
  // socket could open: a name whose addresses the address check refuses,
  // with no earlier hop admitted. Only that failure gives the daily count
  // back; a target that fails after the address was admitted (slow, too big,
  // wrong type) is the member's choice and stays counted.
  function watchedFetch (href, opts) {
    const seen = { admitted: false, refused: false }
    const watch = (hostname, options, cb) => lookup(hostname, options, (err, addrs) => {
      if (!err) {
        const list = Array.isArray(addrs) ? addrs : []
        if (list.length > 0 && list.every((a) => a && allowAddress(a.address))) seen.admitted = true
        else seen.refused = true
      }
      cb(err, addrs)
    })
    const fetch = createSafeFetch({ request, lookup: watch, allowAddress, target: httpsTarget, userAgent: USER_AGENT, deadlineMs, maxRedirects: MAX_REDIRECTS })
    return { seen, done: fetch(href, opts) }
  }

  // The og:image (already resolved and checked by parseOg) as { mime, bytes }
  // or null; never fails the preview.
  async function fetchImage (href) {
    if (href === null || httpsTarget(href) === null) return null
    try {
      const { body } = await safeFetch(href, { cap: IMAGE_CAP, accept: IMAGE_TYPES.join(', '), types: IMAGE_TYPES, plain: true })
      const mime = sniffImage(body)
      if (mime === null) return null
      return { mime, bytes: body.toString('base64') }
    } catch {
      return null
    }
  }

  async function preview (res, member, body) {
    for (const k of Object.keys(body)) if (k !== 'url') throw refuse('pedido-invalido')
    const url = linkParam(body.url)
    if (url === null) throw refuse('pedido-invalido')
    const mine = inflightOf.get(member) || 0
    if (inflight >= MAX_INFLIGHT || mine >= MAX_INFLIGHT_PER_MEMBER) throw unavailable()
    if (!quota(member)) throw overLimit()
    inflight++
    inflightOf.set(member, mine + 1)
    let card
    let image
    try {
      let page
      const { seen, done } = watchedFetch(url.href, { cap: PAGE_CAP, accept: 'text/html', types: PAGE_TYPES, plain: true })
      try {
        page = await done
      } catch {
        if (seen.refused && !seen.admitted) quota.giveBack(member)
        log({ event: 'preview', reason: 'indisponivel' })
        throw unavailable()
      }
      // The answer names the page the text came from: after a redirect, the
      // final URL and its host, never the link that was sent.
      card = cardFromPage(page.body.toString('utf8'), page.url)
      if (card === null) {
        log({ event: 'preview', reason: 'destino' })
        throw unavailable()
      }
      image = await fetchImage(card.imageUrl)
    } finally {
      inflight--
      const left = inflightOf.get(member) - 1
      if (left > 0) inflightOf.set(member, left)
      else inflightOf.delete(member)
    }
    log({ event: 'preview', reason: image === null ? 'previa' : 'previa-imagem' })
    send(res, 200, { url: card.url, host: card.host, title: card.title, desc: card.desc, image })
  }

  function owns (pathname) {
    return pathname === '/account/preview' || pathname.startsWith('/account/preview/')
  }

  async function handle (req, res, url) {
    const pathname = url.pathname
    if (req.method === 'GET' && pathname === '/account/preview/policy') return send(res, 200, { enabled: on })
    if (!on) throw featureOff()
    if (req.method === 'POST' && (pathname === '/account/preview/session/start' || pathname === '/account/preview/session/finish')) {
      checkPost(req)
      const body = await readJsonBody(req)
      return pathname.endsWith('/start') ? auth.start(req, res, body) : auth.finish(req, res, body)
    }
    if (req.method === 'POST' && pathname === '/account/preview') {
      checkPost(req)
      const member = auth.member(req)
      return preview(res, member, await readJsonBody(req))
    }
    throw refuse('nao-encontrado')
  }

  function stats () {
    return { ...auth.stats(), inflight }
  }

  return { owns, handle, stats, enabled: () => on }
}

module.exports = {
  DEADLINE_MS,
  PAGE_CAP,
  IMAGE_CAP,
  MAX_TITLE,
  MAX_DESC,
  MAX_URL,
  PREVIEWS_PER_DAY,
  MAX_INFLIGHT_PER_MEMBER,
  USER_AGENT,
  cardFromPage,
  sniffImage,
  createPreviewRoutes
}
