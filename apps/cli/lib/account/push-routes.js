'use strict'

const nodeCrypto = require('node:crypto')
const { TERMS_VERSION } = require('@varanda/core/lib/terms')
const { endpointHash, verifyPush } = require('@varanda/core/lib/push-proof')
const { validatePushEvent } = require('@varanda/core/lib/push-events')
const { isAllowedEndpoint, sendPush } = require('./web-push')
const { validEndpoint, validP256dh, validAuth } = require('./push-store')
const { pushBody } = require('./push-text')

// Web Push for the hosted PWA (mounted by ./server.js):
//
//   - the browser routes under /account/push/: the VAPID public key, and the
//     opt-in and opt-out of one browser subscription with the member's
//     diary-key proof over a single-use nonce (packages/core/lib/push-proof.js),
//     the same flow and order as the terms routes. Turning push on also needs
//     an acceptance of the current terms, whose text covers these notices.
//     /account/push/check needs no proof but takes the subscription's keys
//     with its endpoint: the browser vendor's push service knows every
//     endpoint it issued, never the RFC 8291 keys, so it cannot ask which
//     member owns one of its devices.
//   - the relay sink POST /push-event: the local seeder's notice of a follow,
//     reply, like or repost aimed at a member (packages/core/lib/push-events.js).
//     It is not under /account/, so Caddy never proxies it, and a Bearer token
//     (VARANDA_PUSH_TOKEN) still gates it because loopback is not trusted
//     (the /moderation-post rule of apps/cli/lib/seed-ws.js). Every valid
//     event is answered 202 before any delivery, so the answer never says
//     whether the recipient has a subscription.
//
// An endpoint is a capability URL: it is never echoed, counted in an answer
// or logged, and neither are keys, nonces, signatures, tokens, names or the
// notice text. Logs carry only { event, reason } tokens.

const MAX_BODY = 4096
const RELAY_BODY_MAX = 1024
const NONCE_TTL_MS = 600 * 1000
const MAX_NONCES = 1000
const MAX_SEEN = 10000
const MAX_IN_FLIGHT = 8
const MAX_QUEUE = 512
const HEX64_RE = /^[0-9a-f]{64}$/
const HEX128_RE = /^[0-9a-f]{128}$/
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/
const ACTIONS = ['on', 'off']
// Every notice is padded to this many plaintext bytes before encryption, so
// its ciphertext length tells the push service neither the kind nor the
// length of the actor's name. The account payload JSON is far below it.
const PUSH_PAD_TO = 1024

const sha256 = (value) => nodeCrypto.createHash('sha256').update(value).digest()

function createPushRoutes ({
  association,
  accounts,
  terms = null,
  pushStore = null,
  vapid = null,
  send = sendPush,
  relayTokenHash = null,
  // The Topic header travels in clear to the browser vendor's push service.
  // A bare hash of actor:seq (both public) would let it map each device to
  // the member a record targets, so the topic is keyed with a process secret.
  topicKey = nodeCrypto.randomBytes(32),
  log = () => {},
  now = Date.now,
  http
}) {
  const { send: reply, sendError, readJsonBody, checkPost, RouteError, refuse, fromStore, keyedWindow } = http
  if (relayTokenHash !== null && !(Buffer.isBuffer(relayTokenHash) && relayTokenHash.length === 32)) {
    throw new TypeError('relayTokenHash must be a sha256 digest')
  }

  // Every per-member window is charged only after a proof, as in server.js,
  // except check's, which no proof precedes (see the note at the top).
  const limits = {
    finish: keyedWindow(10, 600 * 1000, now),
    check: keyedWindow(30, 600 * 1000, now),
    recipient: keyedWindow(60, 3600 * 1000, now),
    // One actor's share of a recipient's budget.
    pair: keyedWindow(10, 3600 * 1000, now),
    cooldown: keyedWindow(1, 600 * 1000, now)
  }
  const over = () => new RouteError('pedido-invalido', 429)

  // Pending opt-ins and opt-outs by nonce: { member, action, expiresAt },
  // single-use, the oldest evicted for room (start needs no proof).
  const nonces = new Map()
  // actor:seq of the events already taken, FIFO: the seeder may relay one
  // record twice (a restart before its cursor was saved).
  const seen = new Set()
  const queue = []
  let inFlight = 0
  let dropped = 0

  function storeUsable () {
    return pushStore !== null && pushStore.available()
  }

  function available (action) {
    if (!storeUsable() || (action === 'on' && vapid === null)) throw refuse('indisponivel')
  }

  function memberParam (value) {
    if (typeof value !== 'string' || !HEX64_RE.test(value)) throw refuse('pedido-invalido')
    return value
  }

  function actionParam (value) {
    if (!ACTIONS.includes(value)) throw refuse('pedido-invalido')
    return value
  }

  // A non-canonical spelling (an explicit :443, an uppercase host, dot
  // segments) would let one device hold two rows for one subscription.
  function endpointParam (value) {
    if (typeof value !== 'string' || !validEndpoint(value)) throw refuse('pedido-invalido')
    let href
    try {
      href = new URL(value).href
    } catch {
      throw refuse('pedido-invalido')
    }
    if (href !== value) throw refuse('pedido-invalido')
    try {
      endpointHash(value)
    } catch {
      throw refuse('pedido-invalido')
    }
    return value
  }

  // base64url keys compared in constant time once decoded.
  function sameKey (stored, given) {
    if (typeof stored !== 'string') return false
    const a = Buffer.from(stored, 'base64url')
    const b = Buffer.from(given, 'base64url')
    return a.length === b.length && nodeCrypto.timingSafeEqual(a, b)
  }

  function linked (member) {
    if (!accounts.status(member).linked) throw refuse('nao-vinculado')
  }

  function sweep () {
    const t = now()
    for (const [k, v] of nonces) if (v.expiresAt <= t) nonces.delete(k)
  }

  async function key (req, res) {
    if (vapid === null || !storeUsable()) throw refuse('indisponivel')
    reply(res, 200, { key: vapid.publicKey })
  }

  async function start (req, res, body) {
    const member = memberParam(body.member)
    const action = actionParam(body.action)
    available(action)
    linked(member)
    sweep()
    while (nonces.size >= MAX_NONCES) nonces.delete(nonces.keys().next().value)
    const nonce = nodeCrypto.randomBytes(32).toString('base64url')
    nonces.set(nonce, { member, action, expiresAt: now() + NONCE_TTL_MS })
    reply(res, 200, { nonce })
  }

  // Same order as termsFinish in server.js: the nonce is spent first, the
  // per-member window is charged only after the signature verified.
  async function finish (req, res, body) {
    const member = memberParam(body.member)
    const nonce = typeof body.nonce === 'string' && TOKEN_RE.test(body.nonce) ? body.nonce : null
    const action = actionParam(body.action)
    if (typeof body.signature !== 'string' || !HEX128_RE.test(body.signature)) throw refuse('assinatura-invalida')
    const signature = body.signature
    const row = nonce === null ? undefined : nonces.get(nonce)
    if (nonce !== null) nonces.delete(nonce)
    if (row === undefined || row.member !== member || row.action !== action || row.expiresAt <= now()) throw refuse('expirado')
    const endpoint = endpointParam(body.endpoint)
    const { p256dh, auth } = body
    if (!validP256dh(p256dh) || !validAuth(auth)) throw refuse('pedido-invalido')
    const fields = { nonce, member, association, action, endpointHash: endpointHash(endpoint), p256dh, auth }
    if (!verifyPush(fields, signature).ok) throw refuse('assinatura-invalida')
    if (!limits.finish(member)) throw over()
    available(action)
    linked(member)
    let result
    if (action === 'on') {
      if (!isAllowedEndpoint(endpoint)) throw refuse('pedido-invalido')
      // Consent to the text that describes these notices comes before an
      // endpoint is stored.
      if (terms === null || !terms.available()) throw refuse('indisponivel')
      let accepted
      try {
        accepted = terms.list(member).some((e) => e.version === TERMS_VERSION)
      } catch (err) {
        throw fromStore(err)
      }
      if (!accepted) throw refuse('termos-pendentes')
      try {
        result = await pushStore.put({ member, endpoint, p256dh, auth })
      } catch (err) {
        throw fromStore(err)
      }
    } else {
      try {
        result = await pushStore.remove({ member, endpoint })
      } catch (err) {
        throw fromStore(err)
      }
    }
    reply(res, 200, { ok: true, changed: result.changed })
  }

  async function check (req, res, body) {
    const member = memberParam(body.member)
    const endpoint = endpointParam(body.endpoint)
    const { p256dh, auth } = body
    if (!validP256dh(p256dh) || !validAuth(auth)) throw refuse('pedido-invalido')
    if (!isAllowedEndpoint(endpoint)) throw refuse('pedido-invalido')
    // No proof precedes a check, so a window keyed by the public member key
    // alone could be drained by anyone; only the browser knows its endpoint.
    if (!limits.check(member + ' ' + endpointHash(endpoint))) throw over()
    if (!storeUsable()) throw refuse('indisponivel')
    let registered
    try {
      registered = pushStore.list(member).some((r) => r.endpoint === endpoint && sameKey(r.p256dh, p256dh) && sameKey(r.auth, auth))
    } catch (err) {
      throw fromStore(err)
    }
    reply(res, 200, { registered })
  }

  const POST = {
    '/account/push/start': start,
    '/account/push/finish': finish,
    '/account/push/check': check
  }

  function owns (pathname) {
    return pathname === '/account/push' || pathname.startsWith('/account/push/')
  }

  async function handle (req, res, url) {
    const p = url.pathname
    if (req.method === 'GET' && p === '/account/push/key') return key(req, res)
    if (req.method === 'POST' && Object.hasOwn(POST, p)) {
      checkPost(req)
      const body = await readJsonBody(req, MAX_BODY)
      return POST[p](req, res, body)
    }
    throw refuse('nao-encontrado')
  }

  // --- relay ----------------------------------------------------------------

  // The 404 of every refusal before the token is proven: the body is never
  // read and the socket goes once the answer is flushed.
  function hidden (req, res) {
    res.setHeader('Connection', 'close')
    res.once('finish', () => req.socket.destroy())
    sendError(res, refuse('nao-encontrado'))
  }

  // Constant-time, as seed-ws.js triageAuthorized: a missing or malformed
  // header compares the digest of '' instead.
  function relayAuthorized (req) {
    const header = req.headers.authorization
    const given = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : ''
    return nodeCrypto.timingSafeEqual(sha256(given), relayTokenHash)
  }

  async function handleRelay (req, res) {
    // Without a token the path is the generic 404 and no header is read.
    if (relayTokenHash === null) return hidden(req, res)
    // The seeder never sends an Origin; a browser always does on a POST.
    if (req.headers.origin !== undefined || req.method !== 'POST') return hidden(req, res)
    if (!relayAuthorized(req)) return hidden(req, res)
    checkPost(req, { requireOrigin: false })
    const event = await readJsonBody(req, RELAY_BODY_MAX)
    if (!validatePushEvent(event)) throw refuse('pedido-invalido')
    reply(res, 202, {})
    try {
      deliver(event)
    } catch {
      log({ event: 'push', reason: 'falhou' })
    }
  }

  function deliver (event) {
    const { kind, actor, recipient, seq, ref } = event
    const id = actor + ':' + seq
    if (seen.has(id)) return log({ event: 'push', reason: 'descartado' })
    seen.add(id)
    while (seen.size > MAX_SEEN) seen.delete(seen.values().next().value)
    // A like toggled off and on again, or a follow repeated, notifies once.
    // Each reply is its own post, so its seq keeps two replies apart. The
    // cooldown runs first so a repeat never spends the recipient's budget.
    const target = kind === 'reply' ? ref + ' ' + seq : (ref === null ? '' : ref)
    if (!limits.cooldown(actor + ' ' + recipient + ' ' + kind + ' ' + target)) {
      return log({ event: 'push', reason: 'descartado' })
    }
    if (vapid === null || !storeUsable()) return
    const subs = pushStore.list(recipient)
    if (subs.length === 0) return
    // Budgets are charged only for a push that will be queued, and one actor
    // cannot spend the whole of a recipient's.
    if (!limits.pair(actor + ' ' + recipient)) return log({ event: 'push', reason: 'teto' })
    if (!limits.recipient(recipient)) return log({ event: 'push', reason: 'teto' })
    const status = accounts.status(actor)
    const username = status.linked && typeof status.username === 'string' ? status.username : null
    const body = pushBody({ kind, name: event.name, username })
    const payload = JSON.stringify({ v: 1, kind, body, actor, recipient, ref })
    const topic = nodeCrypto.createHmac('sha256', topicKey).update(id).digest('hex').slice(0, 32)
    for (const subscription of subs) {
      if (queue.length >= MAX_QUEUE) {
        dropped++
        continue
      }
      queue.push({ recipient, subscription, payload, topic })
    }
    pump()
  }

  function pump () {
    while (inFlight < MAX_IN_FLIGHT && queue.length > 0) {
      const job = queue.shift()
      inFlight++
      deliverOne(job).finally(() => {
        inFlight--
        pump()
      })
    }
  }

  // The row queued may have been turned off (or re-keyed) while the job
  // waited: send only to the row as it stands now.
  function current (recipient, queued) {
    if (!storeUsable()) return null
    try {
      const row = pushStore.list(recipient).find((r) => r.endpoint === queued.endpoint)
      return row !== undefined && row.p256dh === queued.p256dh && row.auth === queued.auth ? row : null
    } catch {
      return null
    }
  }

  async function deliverOne ({ recipient, subscription: queued, payload, topic }) {
    const subscription = current(recipient, queued)
    if (subscription === null) {
      dropped++
      return log({ event: 'push', reason: 'descartado' })
    }
    let outcome
    try {
      outcome = await send({ subscription, payload, vapid, topic, padTo: PUSH_PAD_TO })
    } catch {
      outcome = 'dropped'
    }
    if (outcome === 'ok') return log({ event: 'push', reason: 'enviado' })
    if (outcome === 'gone') {
      // Only the row this send used: one re-registered with new keys while
      // the request was out is a live subscription.
      if (current(recipient, subscription) === null) return log({ event: 'push', reason: 'descartado' })
      try {
        await pushStore.remove({ member: recipient, endpoint: subscription.endpoint })
        return log({ event: 'push', reason: 'removido' })
      } catch {}
    }
    log({ event: 'push', reason: 'falhou' })
  }

  // Sizes only, never a nonce or an endpoint.
  function stats () {
    return { nonces: nonces.size, seen: seen.size, queued: queue.length, inFlight, dropped }
  }

  return { owns, handle, handleRelay, stats }
}

module.exports = {
  RELAY_BODY_MAX,
  MAX_QUEUE,
  MAX_IN_FLIGHT,
  PUSH_PAD_TO,
  createPushRoutes
}
