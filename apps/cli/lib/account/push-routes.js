'use strict'

const nodeCrypto = require('node:crypto')
const { TERMS_VERSION } = require('@varanda/core/lib/terms')
const { endpointHash, verifyPush } = require('@varanda/core/lib/push-proof')
const { validatePushCancel, validatePushEvent } = require('@varanda/core/lib/push-events')
const { validateDmWake, DM_WAKE_COOLDOWN_MS } = require('@varanda/core/lib/dm-wake')
const { isAllowedEndpoint, sendPush, PUSH_TTL_S, TOPIC_RE } = require('./web-push')
const { validEndpoint, validP256dh, validAuth } = require('./push-store')
const { pushBody, dmWakePayload, inviteDropPayload, deletionPayload } = require('./push-text')

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
//     waits for its delay. The seeder's DM wake
//     ({ v: 1, kind: 'dm-wake' }, packages/core/lib/dm-wake.js) names nobody
//     and becomes one identical notice to every stored subscription, at most
//     once per DM_WAKE_COOLDOWN_MS per process: who got a message is never
//     known here, so everyone with push on is told there may be one.
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
// notice text. Logs carry only { event, reason } tokens, plus a number
// (count) when a DM wake fan-out hits the queue cap.

const MAX_BODY = 4096
const RELAY_BODY_MAX = 1024
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
    cooldown: keyedWindow(1, COOLDOWN_MS, now)
  }
  const over = () => new RouteError('pedido-invalido', 429)

  // Pending opt-ins and opt-outs by nonce: { member, action, expiresAt },
  // single-use, the oldest evicted for room (start needs no proof).
  const nonces = new Map()
  // actor:seq:recipient of the events already taken, FIFO: the seeder may relay one
  // record twice (a restart before its cursor was saved).
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
  // Start of the current DM wake window; one fan-out per window. The
  // offset rotates which subscriptions a capped fan-out reaches first.
  let wakeAt = null
  let wakeAfter = null
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
    if (validateDmWake(event)) {
      reply(res, 202, {})
      try {
        wake()
      } catch {
        log({ event: 'push', reason: 'falhou' })
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

  // One global event: no per-actor window or cooldown applies, and a wake
  // inside the window is accepted and dropped. The window starts only once
  // a job is queued, so a member who turns push on right after a wake that
  // reached nobody still hears of the next one.
  //
  // A fan-out shares the MAX_QUEUE jobs with member notices, which is enough
  // at pilot scale but not for every subscription of a large service. Past
  // the cap the rest of this window's wake is dropped and counted, and the
  // next wake starts where this one stopped, so the same tail is never the
  // one always skipped. Each job keeps its row's member only to check and
  // remove the row; the payload names nobody.
  function wake () {
    const t = now()
    if (wakeAt !== null && t - wakeAt < DM_WAKE_COOLDOWN_MS) return log({ event: 'push', reason: 'descartado' })
    if (vapid === null || !storeUsable()) return
    const subs = pushStore.all()
    if (subs.length === 0) return
    // Any member with stamps decides when a wake fires, so a wake takes at
    // most half the queue: member notices always keep the other half.
    const take = Math.min(subs.length, Math.max(0, Math.floor(MAX_QUEUE / 2) - queue.length))
    const skipped = subs.length - take
    if (skipped > 0) {
      dropped += skipped
      log({ event: 'push', reason: 'teto', count: skipped })
    }
    if (take === 0) return
    // Resume after the last endpoint served, found again by value: a removed
    // row shifts every later index, so a numeric offset would skip rows.
    const after = wakeAfter === null ? -1 : subs.findIndex((s) => s.endpoint === wakeAfter)
    const start = (after + 1) % subs.length
    wakeAfter = subs[(start + take - 1) % subs.length].endpoint
    wakeAt = t
    const payload = dmWakePayload()
    const topic = nodeCrypto.createHmac('sha256', topicKey).update('dm-wake ' + t).digest('hex').slice(0, 32)
    const at = t + delayMs()
    for (let i = 0; i < take; i++) {
      const { member, endpoint, p256dh, auth } = subs[(start + i) % subs.length]
      enqueue({ recipient: member, subscription: { endpoint, p256dh, auth }, payload, topic }, at)
    }
    pump()
  }

  // Invites only enter while the queue is under half full: a DM wake may hold
  // the other half (wake), so member notices always keep room of their own.
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

  async function deliverOne ({ recipient, subscription: queued, payload, topic, deadline, notice }) {
    const subscription = current(recipient, queued)
    if (subscription === null) {
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
  MAX_QUEUE,
  MAX_IN_FLIGHT,
  PUSH_PAD_TO,
  PUSH_DELAY_MAX_MS,
  pushDelay,
  INVITE_QUEUE_MAX,
  createPushRoutes
}
