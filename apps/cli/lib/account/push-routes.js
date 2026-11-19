'use strict'

const nodeCrypto = require('node:crypto')
const { TERMS_VERSION } = require('@varanda/core/lib/terms')
const { endpointHash, verifyPush } = require('@varanda/core/lib/push-proof')
const { validatePushCancel, validatePushEvent } = require('@varanda/core/lib/push-events')
const { openDmNotice, DM_NOTICE_BOX_BYTES } = require('@varanda/core/lib/dm-notice')
const { validateGroupNotice, noticeName } = require('@varanda/core/lib/group-notice')
const { isAllowedEndpoint, sendPush, PUSH_TTL_S, TOPIC_RE } = require('./web-push')
const { validEndpoint, validP256dh, validAuth } = require('./push-store')
const { isPlainObject } = require('@varanda/core/lib/cert')
const { pushBody, inviteDropPayload, deletionPayload } = require('./push-text')

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
//     reply, quote, mention, like or repost aimed at a member (packages/core/lib/push-events.js).
//     It is not under /account/, so Caddy never proxies it, and a Bearer token
//     (VARANDA_PUSH_TOKEN) still gates it because loopback is not trusted
//     (the /moderation-post rule of apps/cli/lib/seed-ws.js). Every valid
//     event is answered 202 before any delivery, so the answer never says
//     whether the recipient has a subscription. An undone follow, like or
//     repost ({ v: 1, op: 'cancel' }) recalls that notice while it still
//     waits for its delay. The seeder's DM notice ({ v: 1, kind: 'dm', box })
//     forwards a box a member sealed to the wake key
//     (packages/core/lib/dm-notice.js): only this service opens it, and the
//     member key inside (or a Página's owner and admins) gets one kind-only
//     notice. The old global wake ({ v: 1, kind: 'dm-wake' }) is accepted
//     and dropped, so a seeder not yet updated gets no error.
//   - notifyInvite, called in process by the account service: an invite
//     drop ({ v: 1, kind: 'invite-drop' }) to every device of one member.
//     No social window is charged (the weekly allowance bounds it), and its
//     jobs take at most INVITE_QUEUE_MAX of the queue so member notices
//     keep their room. Each job carries an absolute deadline: past it the
//     job is dropped unsent, before it the TTL is the seconds left.
//   - notifyDeletion, called in process by Excluir conta (./delete-routes.js)
//     when a deletion is scheduled without a verified passkey: a notice
//     ({ v: 1, kind: 'delete-scheduled' }) to every device of the member, so
//     a person who did not ask sees it and can cancel. Best effort: a full
//     queue drops it (the app still shows the schedule from /account/status).
//
// An endpoint is a capability URL: it is never echoed, counted in an answer
// or logged, and neither are keys, nonces, signatures, tokens, names or the
// notice text. Logs carry only { event, reason } tokens, plus kind: 'dm' or
// 'group' on their notice lines; never whom a notice was for.

const MAX_BODY = 4096
const RELAY_BODY_MAX = 8192
const NONCE_TTL_MS = 600 * 1000
const MAX_NONCES = 1000
const MAX_SEEN = 10000
const MAX_IN_FLIGHT = 8
const MAX_QUEUE = 512
// One notice per actor, recipient, kind and target in this window.
const COOLDOWN_MS = 600 * 1000
const HEX64_RE = /^[0-9a-f]{64}$/
const HEX128_RE = /^[0-9a-f]{128}$/
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/
const ACTIONS = ['on', 'off']
// Every notice is padded to this many plaintext bytes before encryption, so
// its ciphertext length tells the push service neither the kind nor the
// length of the actor's name. The account payload JSON is far below it.
const PUSH_PAD_TO = 1024
const INVITE_QUEUE_MAX = Math.floor(MAX_QUEUE / 4)
// DM notices only enter while the queue is under this many jobs (dmRoom).
const DM_QUEUE_MAX = Math.floor(MAX_QUEUE / 2)
// The Terms version whose text describes DM notices: a member who accepted
// only an older text agreed to push for social notices, not for these.
const DM_NOTICE_TERMS_FLOOR = 93
// One DM notice per received key in this window, however many boxes name it.
const DM_COOLDOWN_MS = 15 * 60 * 1000
const GROUP_QUEUE_MAX = Math.floor(MAX_QUEUE / 2)
const GROUP_NOTICE_TERMS_FLOOR = 94
const GROUP_COOLDOWN_MS = 10 * 60 * 1000
const BOX_B64U_LENGTH = Math.ceil(DM_NOTICE_BOX_BYTES * 4 / 3)
const B64U_RE = /^[A-Za-z0-9_-]+$/
const RELAY_DM_KEYS = 'box,kind,v'

const sha256 = (value) => nodeCrypto.createHash('sha256').update(value).digest()
// Privacy delay before every Web Push send (maintainer decision 2026-11-15).
const PUSH_DELAY_MAX_MS = 60 * 1000
// Total time close() may spend sending the jobs still waiting.
const FLUSH_MS = 3000
const pushDelay = () => nodeCrypto.randomInt(0, PUSH_DELAY_MAX_MS + 1)

function createPushRoutes ({
  association,
  accounts,
  terms = null,
  pushStore = null,
  vapid = null,
  // { publicKey, secretKey } of ./push-wake-key.js, or null: DM boxes are
  // then dropped and /account/push/key carries no wake key.
  wakeKey = null,
  // The Páginas ACL (./pages-store.js) or null: a DM box that names a live
  // Página notifies its owner and admins.
  pagesStore = null,
  send = sendPush,
  relayTokenHash = null,
  // The Topic header travels in clear to the browser vendor's push service.
  // A bare hash of actor:seq:recipient (all public) would let it map each device to
  // the member a record targets, so the topic is keyed with a process secret.
  topicKey = nodeCrypto.randomBytes(32),
  // member -> void, throws 'telefone-pendente' (server.js phoneChecked).
  phoneChecked = () => {},
  log = () => {},
  now = Date.now,
  // Every send waits a uniformly random 0 to PUSH_DELAY_MAX_MS from its
  // enqueue, so the arrival time of a notice does not line up with the
  // event that caused it. Injectable for tests (() => 0 sends at once).
  delayMs = pushDelay,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
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
    // One actor's share of the whole queue: one post can mention several
    // members, so pair and recipient alone let one diary fill MAX_QUEUE.
    actor: keyedWindow(30, 3600 * 1000, now),
    cooldown: keyedWindow(1, COOLDOWN_MS, now),
    // Keyed on the key the box named, before a Página is expanded.
    dmCooldown: keyedWindow(1, DM_COOLDOWN_MS, now),
    // Per member reached by a DM notice, apart from the social budget.
    dmRecipient: keyedWindow(60, 3600 * 1000, now),
    groupCooldown: keyedWindow(1, GROUP_COOLDOWN_MS, now),
    groupRecipient: keyedWindow(60, 3600 * 1000, now)
  }
  const over = () => new RouteError('pedido-invalido', 429)

  // Pending opt-ins and opt-outs by nonce: { member, action, expiresAt },
  // single-use, the oldest evicted for room (start needs no proof).
  const nonces = new Map()
  // actor:seq:recipient, or nid:recipient for groups, FIFO: the seeder may
  // relay one record twice (a restart before its cursor was saved).
  const seen = new Set()
  const queue = []
  // Member notices no device has got yet, oldest first, for cancel: a recall
  // gives their charges back. Gone once a copy reaches a device, once
  // refunded, and past COOLDOWN_MS (a recall then gives nothing back).
  const pending = new Set()
  let inFlight = 0
  let dropped = 0
  // Invite jobs still waiting in the queue, against INVITE_QUEUE_MAX.
  let invitesQueued = 0
  let timer = null
  let closed = false

  // Jobs stay in the queue until their notice's random time (job.at), drawn
  // once per notice so every copy (one per device) leaves together: a push
  // service that sees several copies cannot take the earliest. The cooldowns
  // and budgets are decided at enqueue time, so the delay never double-sends
  // or skips a notice.
  function enqueue (job, at) {
    job.at = at
    queue.push(job)
  }

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

  // `wake` is the only place a client takes the wake key from: a seeder
  // never hands it out, so one cannot swap in a key it holds.
  const wakePublic = wakeKey === null ? null : Buffer.from(wakeKey.publicKey).toString('base64url')

  async function key (req, res) {
    if (vapid === null || !storeUsable()) throw refuse('indisponivel')
    const out = { key: vapid.publicKey }
    if (wakePublic !== null) out.wake = wakePublic
    reply(res, 200, out)
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
    // Only turning push on: turning it off must stay open to everyone.
    if (action === 'on') phoneChecked(member)
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
    if (isLegacyWake(event)) {
      reply(res, 202, {})
      return log({ event: 'push', reason: 'descartado' })
    }
    if (isDmEvent(event)) {
      // Answered before the box is opened, so the answer never says whether
      // it named anyone.
      reply(res, 202, {})
      try {
        dmNotice(event.box)
      } catch {
        log({ event: 'push', reason: 'falhou' })
      }
      return
    }
    if (validateGroupNotice(event)) {
      reply(res, 202, {})
      try {
        notifyGroup(event)
      } catch {
        log({ event: 'push', kind: 'group', reason: 'indisponivel' })
      }
      return
    }
    if (validatePushCancel(event)) {
      reply(res, 202, {})
      try {
        cancel(event)
      } catch {
        log({ event: 'push', reason: 'falhou' })
      }
      return
    }
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
    // One record can notify several members (a quote and a mention).
    const id = actor + ':' + seq + ':' + recipient
    if (seen.has(id)) return log({ event: 'push', reason: 'descartado' })
    seen.add(id)
    while (seen.size > MAX_SEEN) seen.delete(seen.values().next().value)
    // A like toggled off and on again, or a follow repeated, notifies once.
    // Each reply is its own post, so its seq keeps two replies apart. The
    // cooldown runs first so a repeat never spends the recipient's budget.
    const target = kind === 'reply' ? ref + ' ' + seq : (ref === null ? '' : ref)
    const cooldown = actor + ' ' + recipient + ' ' + kind + ' ' + target
    if (!limits.cooldown(cooldown)) {
      return log({ event: 'push', reason: 'descartado' })
    }
    if (vapid === null || !storeUsable()) return
    const subs = pushStore.list(recipient)
    if (subs.length === 0) return
    // A full queue drops the notice before any budget is charged for it.
    if (queue.length >= MAX_QUEUE) {
      dropped += subs.length
      return log({ event: 'push', reason: 'descartado' })
    }
    // Budgets are charged only for a push that will be queued, and one actor
    // cannot spend the whole of a recipient's nor of the queue. All three
    // are checked before any is charged, so a refusal spends none.
    const pairKey = actor + ' ' + recipient
    if (!limits.actor(actor, false) || !limits.pair(pairKey, false) || !limits.recipient(recipient, false)) {
      return log({ event: 'push', reason: 'teto' })
    }
    limits.actor(actor)
    limits.pair(pairKey)
    limits.recipient(recipient)
    // Read after every charge, so no window charged here starts after it
    // (keyedWindow release).
    const charged = now()
    const status = accounts.status(actor)
    const username = status.linked && typeof status.username === 'string' ? status.username : null
    const body = pushBody({ kind, name: event.name, username })
    const payload = JSON.stringify({ v: 1, kind, body, actor, recipient, ref })
    const topic = nodeCrypto.createHmac('sha256', topicKey).update(id).digest('hex').slice(0, 32)
    const at = now() + delayMs()
    // Shared by every copy, for cancel.
    const notice = { kind, actor, recipient, ref, cooldown, pairKey, charged, inFlight: 0, reached: false, cancelled: false }
    for (const subscription of subs) {
      if (queue.length >= MAX_QUEUE) {
        dropped++
        continue
      }
      enqueue({ recipient, subscription, payload, topic, notice }, at)
    }
    // Past MAX_SEEN the oldest live notice goes too and loses its refund
    // (accepted: bounded memory over an exact recall).
    for (const n of pending) {
      if (n.charged + COOLDOWN_MS > charged && pending.size < MAX_SEEN) break
      pending.delete(n)
    }
    pending.add(notice)
    pump()
  }

  // Drops the copies of the matching notices that still wait for their
  // delay; one in flight or sent stays. A notice no device got gives back
  // its cooldown, so a later redo still notifies, and its budgets, so an
  // undo loop inside the delay cannot drain a recipient's budget unseen.
  function cancel ({ kind, actor, recipient, ref }) {
    const matches = (n) => n !== undefined && !n.cancelled && n.kind === kind && n.actor === actor && n.recipient === recipient && n.ref === ref
    const recalled = new Set()
    for (let i = queue.length - 1; i >= 0; i--) {
      if (!matches(queue[i].notice)) continue
      recalled.add(queue[i].notice)
      queue.splice(i, 1)
    }
    const t = now()
    for (const n of pending) if (matches(n) && n.charged + COOLDOWN_MS > t) recalled.add(n)
    if (recalled.size === 0) return log({ event: 'push', reason: 'descartado' })
    for (const n of recalled) {
      n.cancelled = true
      refund(n)
    }
    arm()
    log({ event: 'push', reason: 'cancelado' })
  }

  // A copy in flight at cancel time may still reach a device, so the refund
  // waits until it settles (pump calls this again). Leaving `pending` first
  // makes it happen once.
  function refund (n) {
    if (!n.cancelled || n.reached || n.inFlight > 0 || !pending.has(n)) return
    pending.delete(n)
    limits.cooldown.release(n.cooldown, n.charged)
    limits.actor.release(n.actor, n.charged)
    limits.pair.release(n.pairKey, n.charged)
    limits.recipient.release(n.recipient, n.charged)
  }

  // --- DM notices -------------------------------------------------------------

  function isLegacyWake (e) {
    return isPlainObject(e) && Object.keys(e).sort().join(',') === 'kind,v' && e.v === 1 && e.kind === 'dm-wake'
  }

  // The shape only: a box that does not decode or open is still answered
  // 202, like one that names a member without a device.
  function isDmEvent (e) {
    return isPlainObject(e) && Object.keys(e).sort().join(',') === RELAY_DM_KEYS && e.v === 1 && e.kind === 'dm' &&
      typeof e.box === 'string' && e.box.length <= RELAY_BODY_MAX
  }

  // Exactly DM_NOTICE_BOX_BYTES in canonical unpadded base64url, or null: a
  // second spelling of one box would be a second, unrelated-looking event.
  function decodeBox (value) {
    if (value.length !== BOX_B64U_LENGTH || !B64U_RE.test(value)) return null
    const box = Buffer.from(value, 'base64url')
    return box.length === DM_NOTICE_BOX_BYTES && box.toString('base64url') === value ? box : null
  }

  function dmNotice (value) {
    if (wakeKey === null) return log({ event: 'push', kind: 'dm', reason: 'indisponivel' })
    const box = decodeBox(value)
    const key = box === null ? null : openDmNotice(box, wakeKey)
    if (key === null) return log({ event: 'push', kind: 'dm', reason: 'caixa-invalida' })
    notifyDm(key)
  }

  // A live Página's row, or null. A closed or moved page (moved implies
  // closed) has nobody to tell. An unreadable pages store reads as "not a
  // page": the key then only reaches its own subscriptions, and a page key
  // never has any (turning push on needs a linked member's proof).
  function livePage (key) {
    if (pagesStore === null) return null
    let row
    try {
      row = pagesStore.get(key)
    } catch {
      return null
    }
    if (row === null || row.closed !== null || row.movedTo !== null) return null
    return row
  }

  function runsPage (key, member) {
    const row = livePage(key)
    return row !== null && (row.owner === member || row.admins.includes(member))
  }

  function dmTermsAccepted (member) {
    try {
      return terms.list(member).some((e) => e.version >= DM_NOTICE_TERMS_FLOOR)
    } catch {
      return false
    }
  }

  // DM jobs enter only while the queue is under half full, like invites: a
  // member with stamps decides when a box arrives, so member notices always
  // keep room of their own.
  function dmRoom () {
    return Math.max(0, DM_QUEUE_MAX - queue.length)
  }

  // `key` is the key a box named: a member, or a Página whose owner and
  // admins are told instead. The payload names nobody, only the kind and
  // the enqueue time, so the app knows which Conversas to look at and how
  // old the notice is. The cooldown is charged only once a job is queued: a
  // box that reaches nobody (Terms below the floor, no device, no room, the
  // hourly cap) must not hold back the next message's notice for 15 minutes.
  function notifyDm (key) {
    if (closed || vapid === null || !storeUsable()) return
    if (terms === null || !terms.available()) return log({ event: 'push', kind: 'dm', reason: 'indisponivel' })
    if (!limits.dmCooldown(key, false)) return log({ event: 'push', kind: 'dm', reason: 'descartado' })
    const page = livePage(key)
    const kind = page === null ? 'dm' : 'dm-page'
    const members = page === null ? [key] : [page.owner, ...page.admins]
    const g = now()
    const payload = JSON.stringify({ v: 1, kind, g })
    let queued = false
    for (const member of members) {
      if (!dmTermsAccepted(member)) {
        log({ event: 'push', kind: 'dm', reason: 'termos-pendentes' })
        continue
      }
      let subs
      try {
        subs = pushStore.list(member)
      } catch {
        log({ event: 'push', kind: 'dm', reason: 'indisponivel' })
        continue
      }
      if (subs.length === 0) continue
      if (dmRoom() < subs.length) {
        dropped += subs.length
        log({ event: 'push', kind: 'dm', reason: 'descartado' })
        continue
      }
      if (!limits.dmRecipient(member)) {
        log({ event: 'push', kind: 'dm', reason: 'teto' })
        continue
      }
      // A fresh topic per notice, as for a social one: the push service sees
      // it in clear, and a topic repeated per member would mark these
      // notices apart and tie them to each other.
      const topic = nodeCrypto.createHmac('sha256', topicKey).update('dm ' + key + ' ' + g + ' ' + member).digest('hex').slice(0, 32)
      // One delay per member, shared only by that member's own devices: a
      // delay shared by a Página's owner and admins would tie their notices
      // together for the push service, as one topic would.
      const at = g + delayMs()
      for (const { endpoint, p256dh, auth } of subs) {
        enqueue({ recipient: member, subscription: { endpoint, p256dh, auth }, payload, topic, ...(page === null ? {} : { page: key }) }, at)
      }
      queued = true
    }
    if (queued) limits.dmCooldown(key)
    pump()
  }

  function groupTermsAccepted (member) {
    try {
      return terms.list(member).some((e) => e.version >= GROUP_NOTICE_TERMS_FLOOR)
    } catch {
      return false
    }
  }

  function groupRoom () {
    return Math.max(0, GROUP_QUEUE_MAX - queue.length)
  }

  function notifyGroup ({ group, visibility, name, nid, recipients }) {
    if (closed || vapid === null || !storeUsable()) return
    if (terms === null || !terms.available()) return log({ event: 'push', kind: 'group', reason: 'indisponivel' })
    const g = now()
    const payload = JSON.stringify(visibility === 'private'
      ? { v: 1, kind: 'group-private', g }
      : { v: 1, kind: 'group', group, body: noticeName(name), g })
    for (const member of recipients) {
      const id = nid + ':' + member
      if (seen.has(id)) {
        log({ event: 'push', kind: 'group', reason: 'descartado' })
        continue
      }
      seen.add(id)
      while (seen.size > MAX_SEEN) seen.delete(seen.values().next().value)
      const cooldown = group + ' ' + member
      if (!limits.groupCooldown(cooldown, false)) {
        log({ event: 'push', kind: 'group', reason: 'descartado' })
        continue
      }
      if (!groupTermsAccepted(member)) {
        log({ event: 'push', kind: 'group', reason: 'termos-pendentes' })
        continue
      }
      let subs
      try {
        subs = pushStore.list(member)
      } catch {
        log({ event: 'push', kind: 'group', reason: 'indisponivel' })
        continue
      }
      if (subs.length === 0) continue
      if (groupRoom() < subs.length) {
        dropped += subs.length
        log({ event: 'push', kind: 'group', reason: 'descartado' })
        continue
      }
      if (!limits.groupRecipient(member)) {
        log({ event: 'push', kind: 'group', reason: 'teto' })
        continue
      }
      const topic = nodeCrypto.createHmac('sha256', topicKey).update('group ' + nid + ' ' + g + ' ' + member).digest('hex').slice(0, 32)
      const at = g + delayMs()
      for (const { endpoint, p256dh, auth } of subs) {
        enqueue({ recipient: member, subscription: { endpoint, p256dh, auth }, payload, topic }, at)
      }
      // A notice that reaches nobody must leave the next message's window open.
      limits.groupCooldown(cooldown)
    }
    pump()
  }

  // Invites only enter while the queue is under half full: DM notices may
  // hold the other half (dmRoom), so member notices always keep room of their own.
  // No transport means no room: the loop then claims nothing, so the week's
  // slots are still sent once push comes back. A closed service has no room
  // either: a slot claimed after close() would never be sent.
  function room () {
    if (closed || vapid === null || !storeUsable()) return 0
    return Math.max(0, Math.min(INVITE_QUEUE_MAX - invitesQueued, Math.floor(MAX_QUEUE / 2) - queue.length))
  }

  // 'none' tells the caller that no transport or no device exists, so the
  // slot is marked once and never retried; 'dropped' that devices exist but
  // the queue had no room for all of them. A member gets every device or
  // none: the caller marks the slot either way, so a partial send would
  // leave the newest devices without the notice for good.
  function notifyInvite ({ member, topic, deadline } = {}) {
    if (typeof member !== 'string' || !HEX64_RE.test(member)) throw new TypeError('member inválido')
    if (typeof topic !== 'string' || !TOPIC_RE.test(topic)) throw new TypeError('topic inválido')
    if (!Number.isSafeInteger(deadline)) throw new TypeError('deadline inválido')
    if (vapid === null || !storeUsable()) return 'none'
    const subs = pushStore.list(member)
    if (subs.length === 0) return 'none'
    if (room() < subs.length) {
      dropped += subs.length
      log({ event: 'push', reason: 'descartado' })
      return 'dropped'
    }
    const payload = inviteDropPayload()
    const at = now() + delayMs()
    for (let i = 0; i < subs.length; i++) {
      const { endpoint, p256dh, auth } = subs[i]
      enqueue({ recipient: member, subscription: { endpoint, p256dh, auth }, payload, topic, deadline }, at)
      invitesQueued++
    }
    pump()
    return 'queued'
  }

  function notifyDeletion ({ member } = {}) {
    if (typeof member !== 'string' || !HEX64_RE.test(member)) throw new TypeError('member inválido')
    if (vapid === null || !storeUsable()) return 'none'
    const subs = pushStore.list(member)
    if (subs.length === 0) return 'none'
    if (queue.length + subs.length > MAX_QUEUE) {
      dropped += subs.length
      log({ event: 'push', reason: 'descartado' })
      return 'dropped'
    }
    const payload = deletionPayload()
    const topic = nodeCrypto.createHmac('sha256', topicKey).update('delete-scheduled ' + member).digest('hex').slice(0, 32)
    const at = now() + delayMs()
    for (const { endpoint, p256dh, auth } of subs) {
      enqueue({ recipient: member, subscription: { endpoint, p256dh, auth }, payload, topic }, at)
    }
    pump()
    return 'queued'
  }

  function pump () {
    if (closed) return
    while (inFlight < MAX_IN_FLIGHT) {
      const t = now()
      const i = queue.findIndex((j) => j.at <= t)
      if (i < 0) break
      const job = queue.splice(i, 1)[0]
      if (job.deadline !== undefined) invitesQueued--
      if (job.notice !== undefined) job.notice.inFlight++
      inFlight++
      deliverOne(job).finally(() => {
        inFlight--
        if (job.notice !== undefined) {
          job.notice.inFlight--
          refund(job.notice)
        }
        pump()
      })
    }
    arm()
  }

  // One timer, for the earliest job not yet due. A full pool re-pumps when
  // a send ends, so no timer is needed then.
  function arm () {
    if (timer !== null) clearTimer(timer)
    timer = null
    if (closed || queue.length === 0 || inFlight >= MAX_IN_FLIGHT) return
    const next = queue.reduce((min, j) => Math.min(min, j.at), Infinity)
    timer = setTimer(() => {
      timer = null
      pump()
    }, Math.max(0, next - now()))
    if (timer !== null && typeof timer.unref === 'function') timer.unref()
  }

  // Service shutdown: jobs still waiting for their delay go out now (the
  // jitter is lost), best effort and bounded by FLUSH_MS in all, never
  // retried. Dropping them would lose them for good, and an invite drop's
  // slot is already claimed.
  async function close () {
    if (closed) return
    closed = true
    if (timer !== null) clearTimer(timer)
    timer = null
    const jobs = queue.splice(0)
    invitesQueued = 0
    if (jobs.length === 0) return
    let limit = null
    const expired = new Promise((resolve) => {
      limit = setTimer(resolve, FLUSH_MS)
      if (limit !== null && typeof limit.unref === 'function') limit.unref()
    })
    const worker = async () => {
      while (jobs.length > 0) await deliverOne(jobs.shift())
    }
    const work = Promise.all(Array.from({ length: Math.min(MAX_IN_FLIGHT, jobs.length) }, worker)).catch(() => {})
    await Promise.race([work, expired])
    clearTimer(limit)
    jobs.length = 0
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

  async function deliverOne ({ recipient, subscription: queued, payload, topic, deadline, notice, page }) {
    const subscription = current(recipient, queued)
    if (subscription === null) {
      dropped++
      return log({ event: 'push', reason: 'descartado' })
    }
    // A Página's notice reaches only who still runs it once the delay ends:
    // an admin removed, or a page closed or moved, while the job waited is
    // not told. An unreadable pages store tells nobody.
    if (page !== undefined && !runsPage(page, recipient)) {
      dropped++
      return log({ event: 'push', reason: 'descartado' })
    }
    const opts = { subscription, payload, vapid, topic, padTo: PUSH_PAD_TO }
    if (deadline !== undefined) {
      const left = deadline - now()
      if (left <= 0) {
        dropped++
        return log({ event: 'push', reason: 'descartado' })
      }
      opts.ttlS = Math.min(PUSH_TTL_S, Math.max(1, Math.ceil(left / 1000)))
    }
    let outcome
    try {
      outcome = await send(opts)
    } catch {
      outcome = 'dropped'
    }
    // Only 'gone' says the push service refused the copy. 'dropped' also
    // covers a timeout or a reset after the service may have taken the POST
    // (sendPush cannot tell them apart), so it counts as reached: refunding
    // it would let a like/unlike loop during timeouts notify every cycle.
    if (outcome !== 'gone' && notice !== undefined) {
      notice.reached = true
      pending.delete(notice)
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

  return { owns, handle, handleRelay, stats, notifyInvite, notifyDeletion, room, close }
}

module.exports = {
  RELAY_BODY_MAX,
  DM_NOTICE_TERMS_FLOOR,
  DM_COOLDOWN_MS,
  GROUP_NOTICE_TERMS_FLOOR,
  MAX_QUEUE,
  MAX_IN_FLIGHT,
  PUSH_PAD_TO,
  PUSH_DELAY_MAX_MS,
  pushDelay,
  INVITE_QUEUE_MAX,
  createPushRoutes
}
