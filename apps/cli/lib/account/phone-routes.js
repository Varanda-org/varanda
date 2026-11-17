'use strict'

const nodeCrypto = require('node:crypto')
const { verifyPhone, isBrMobile } = require('@varanda/core/lib/phone')
const { createPhoneVerified, createPhoneSince } = require('@varanda/core/lib/phone-proof')
const { ceiling } = require('./age-routes')
const { createStartNonces, MAX_SPENT } = require('./start-nonces')

// Hosted verification of a Brazilian mobile number with Didit (mounted by
// ./server.js), modelled on ./age-routes.js:
//
//   - GET /account/phone/policy answers exactly { required } even when the
//     feature is off, behind its own window.
//   - GET /account/phone/since answers { since: null | PhoneSince }: a
//     phone-since attestation (packages/core/lib/phone-proof.js) signed by
//     the issuer once the store holds a first verification, so a node can
//     tell offline that the association requires a verified number. It
//     never vouches for a certificate. A store that cannot answer is a 503,
//     never null: null tells the node to drop the one it holds.
//   - start mints a single-use nonce for a member key (./start-nonces.js);
//     it reads no state, stores nothing and reveals nothing, so a flood of
//     unsigned starts cannot push out a member's unspent nonce.
//   - send, check and status each need the member's diary-key proof over
//     that nonce (packages/core/lib/phone.js), action-bound, the nonce spent
//     first. send asks the provider to text a code, check hands the code to
//     the provider and records the number (./phone-store.js), status reads
//     whether the member holds a verified number. A 'verificado' answer
//     carries `proof`, a phone-verified attestation dated the row's
//     verifiedAt, when the service has an issuer.
//
// Uniqueness and burns are answered only after a correct code: send gives
// the same answers and the same log lines for a free, a taken and a burned
// number, so it never tells anyone whose number is whose. A blocked member is
// not refused here, so a first verification (and with it the appeal screen)
// stays reachable; the moderation rule that burns a number is the
// `burnable` callback the store applies at record and sweep time.
//
// The codes sent but not yet checked live in memory only (the number in
// plaintext, needed for the check): a restart forgets them and the member
// asks for a new code. No answer and no log line carries the number, a mask,
// its index, the code, a provider id or a member key. Logs carry only
// { event, reason }.
//
// No table here evicts a live entry to make room, since that would reset a
// window or drop someone's code: each send is charged to one of the two daily
// ceilings, so the keys a table can hold are bounded (see maxKeysFor), and a
// table still full of live entries refuses the send before the provider call.

const MAX_BODY = 4096
const PENDING_TTL_MS = 600 * 1000
const RESEND_MS = 60 * 1000
const MAX_ATTEMPTS = 3
const DAY_MS = 24 * 3600 * 1000
const SWEEP_MS = 3600 * 1000
const SINCE_RESIGN_MS = 60 * 1000

const HEX64_RE = /^[0-9a-f]{64}$/
const CODE_RE = /^[0-9]{6}$/
const LOG_TOKEN_RE = /^[a-z0-9_-]{1,48}$/

// Only a 4xx from the provider (it refused the request) or our own input
// check proves nothing was sent or checked; after a timeout, a dropped
// connection, a 5xx or an unreadable success it may have been.
function providerRefused (reason) {
  return reason === 'entrada' || /^http-4\d\d$/.test(String(reason))
}

function sameIndex (a, b) {
  const x = Buffer.from(a, 'hex')
  const y = Buffer.from(b, 'hex')
  return x.length === y.length && nodeCrypto.timingSafeEqual(x, y)
}

// Every send that charges a keyed window or fills pending and lastSent is
// first charged to dailyNew or dailyLinked, two fixed windows of dailyLimit,
// and any 24-hour interval meets at most two windows of each: at most
// 4 * dailyLimit keys are ever live.
function maxKeysFor (dailyLimit) {
  return 4 * dailyLimit
}

// A keyed fixed window that can be checked without spending it, so a request
// refused by one window never spends another. At most `max` live keys: a live
// window is never evicted (that would reset someone's limit), so has() answers
// false for a new key while the table is full of live windows. take() follows
// a has() that answered true, in the same tick.
function keyedCeiling (limit, windowMs, now, max) {
  if (!Number.isSafeInteger(max) || max < 1) throw new TypeError('max must be a positive integer')
  const windows = new Map()
  function current (key) {
    const w = windows.get(key)
    if (w !== undefined && now() - w.start >= windowMs) {
      windows.delete(key)
      return undefined
    }
    return w
  }
  return {
    has (key) {
      const w = current(key)
      if (w !== undefined) return w.count < limit
      if (windows.size >= max) {
        const t = now()
        for (const [k, v] of windows) if (t - v.start >= windowMs) windows.delete(k)
      }
      return windows.size < max
    },
    take (key) {
      let w = current(key)
      if (w === undefined) {
        w = { start: now(), count: 0 }
        windows.set(key, w)
      }
      w.count++
    },
    size () {
      return windows.size
    }
  }
}

function createPhoneRoutes ({
  client = null,
  phones = null,
  association,
  store,
  ageVerified,
  forgetAge = async () => {},
  linked,
  deleted,
  burnable,
  blocked = () => false,
  cleared = () => false,
  issuer = null,
  log = () => {},
  now = Date.now,
  http,
  dailyLimit = 200,
  // Spent start nonces kept (./server.js sizes it from its token bucket).
  maxSpent = MAX_SPENT,
  // Tests only: smaller bounds than maxKeysFor(dailyLimit).
  maxWindows = null,
  maxPending = null
}) {
  const { send, readJsonBody, checkPost, RouteError, refuse, keyedWindow, fixedWindow } = http
  if (client !== null && (typeof client.send !== 'function' || typeof client.check !== 'function')) {
    throw new TypeError('phoneClient inválido')
  }
  for (const [name, fn] of [['ageVerified', ageVerified], ['linked', linked], ['deleted', deleted], ['burnable', burnable], ['blocked', blocked], ['cleared', cleared]]) {
    if (typeof fn !== 'function') throw new TypeError(name + ' must be a function')
  }
  if (!Number.isSafeInteger(dailyLimit) || dailyLimit < 1) throw new TypeError('phoneDailyLimit must be a positive integer')
  const windowBound = maxWindows ?? maxKeysFor(dailyLimit)
  const pendingBound = maxPending ?? maxKeysFor(dailyLimit)
  if (!Number.isSafeInteger(pendingBound) || pendingBound < 1) throw new TypeError('maxPending must be a positive integer')
  if (issuer !== null && (typeof issuer !== 'object' || !issuer.keyPair || !issuer.cert)) throw new TypeError('issuer must be { keyPair, cert } or null')

  // A store that failed to open is still on: the gates then stay shut
  // instead of silently opening.
  const on = client !== null && phones !== null
  // Evaluated at each call, so the server can widen them (a link in flight).
  const callbacks = {
    linked: (m) => linked(m),
    burnable: (m, since) => burnable(m, since),
    deleted: (m) => deleted(m),
    // Any published block, a self-deletion's included: a burn is never
    // lifted while the key stays on the list.
    blocked: (m) => blocked(m),
    cleared: (m, since) => cleared(m, since)
  }

  // Member keys are free to make, so the unlinked keys share their own daily
  // ceiling of paid sends; linked members have a separate one, so disposable
  // keys cannot lock them out. The number window is keyed by its HMAC index.
  const limits = {
    member: keyedCeiling(5, DAY_MS, now, windowBound),
    number: keyedCeiling(3, DAY_MS, now, windowBound),
    check: keyedWindow(10, 600 * 1000, now),
    status: keyedWindow(30, 600 * 1000, now),
    dailyNew: ceiling(dailyLimit, DAY_MS, now),
    dailyLinked: ceiling(dailyLimit, DAY_MS, now),
    policy: fixedWindow(6000, 60 * 1000, now),
    since: fixedWindow(6000, 60 * 1000, now)
  }

  const nonces = createStartNonces({ label: 'varanda-phone-start-v1', now, max: maxSpent })
  // member -> { phone, index, sentAt, attempts, approved }, at most
  // pendingBound counting the sends in flight (see room).
  const pending = new Map()
  // member -> { index, done: Promise<{ state } | { error }> } of a send in
  // flight.
  const sending = new Map()
  // member -> time of the last send that (maybe) texted a code. Apart from
  // pending, which three wrong codes drop, so the resend wait outlives it.
  // Bounded like pending.
  const lastSent = new Map()
  // Members with a check in flight: one at a time, so parallel checks can
  // neither pass the attempt limit nor drop the entry an approval is about
  // to record.
  const checking = new Set()

  if (on) {
    sweepStore()
    setInterval(sweepStore, SWEEP_MS).unref()
  }

  // Queued at once, so a call queued after it (settled) waits for it.
  function queueSweep () {
    try {
      return Promise.resolve(phones.sweep(callbacks))
    } catch (err) {
      return Promise.reject(err)
    }
  }

  function sweepStore () {
    queueSweep().catch(() => log({ event: 'telefone', reason: 'varredura-falhou' }))
  }

  // Excluir conta runs this before it marks the key deleted, so a key on the
  // published list is burned while the rule still sees it as blocked.
  // Rejects when the sweep fails.
  async function sweepNow () {
    if (!on) return
    await queueSweep()
  }

  function required () {
    return on
  }

  function verified (member) {
    if (!on) return false
    try {
      return phones.verified(member) === true
    } catch {
      return false
    }
  }

  async function settled (member) {
    if (phones !== null) await phones.settled(member)
  }

  function unavailable () {
    log({ event: 'telefone', reason: 'armazenamento-indisponivel' })
    return refuse('indisponivel')
  }

  function available () {
    if (!on) throw refuse('indisponivel')
    let ok = false
    try { ok = phones.available() === true } catch {}
    if (!ok) throw unavailable()
  }

  function storeRead (fn) {
    try {
      return fn()
    } catch {
      throw unavailable()
    }
  }

  // The provider's coarse reason, then each field name it complained about.
  // Tokens only, never a value.
  function logProvider (where, r) {
    const reason = r && typeof r.reason === 'string' && LOG_TOKEN_RE.test(r.reason) ? r.reason : 'falha'
    log({ event: 'telefone', reason: where + '-' + reason })
    const fields = r && Array.isArray(r.fields) ? r.fields : []
    for (const field of fields) {
      if (typeof field === 'string' && LOG_TOKEN_RE.test(field)) log({ event: 'telefone', reason: where + '-campo-' + field })
    }
  }

  function memberParam (value) {
    if (typeof value !== 'string' || !HEX64_RE.test(value)) throw refuse('pedido-invalido')
    return value
  }

  function prune () {
    const t = now()
    for (const [k, v] of pending) if (t - v.sentAt >= PENDING_TTL_MS) pending.delete(k)
    for (const [k, at] of lastSent) if (t - at >= RESEND_MS) lastSent.delete(k)
  }

  function pendingOf (member) {
    const p = pending.get(member)
    if (p === undefined) return null
    if (now() - p.sentAt >= PENDING_TTL_MS) {
      pending.delete(member)
      return null
    }
    return p
  }

  // Whether pending and lastSent can take this member once its send returns.
  // The sends in flight count as taken, so remember never needs to evict.
  function room (member) {
    prune()
    const taken = sending.size + 1
    return (pending.has(member) || pending.size + taken <= pendingBound) &&
      (lastSent.has(member) || lastSent.size + taken <= pendingBound)
  }

  // Also on a timer, so the number leaves memory when its code expires
  // even if no other request comes in to prune it.
  let seq = 0
  function remember (member, phone, index) {
    prune()
    pending.delete(member)
    const id = ++seq
    pending.set(member, { id, phone, index, sentAt: now(), attempts: 0, approved: false })
    setTimeout(() => {
      const p = pending.get(member)
      if (p !== undefined && p.id === id) pending.delete(member)
    }, PENDING_TTL_MS).unref()
    lastSent.delete(member)
    lastSent.set(member, now())
  }

  function drop (member, p) {
    if (pending.get(member) === p) pending.delete(member)
  }

  // Spends the nonce (minted for this member, live and unspent) before
  // anything else, then checks the signature for `action`.
  function prove (body, action) {
    const member = memberParam(body.member)
    const nonce = body.nonce
    if (!nonces.spend(member, nonce)) throw refuse('expirado')
    if (!verifyPhone({ action, nonce, member, association }, body.signature).ok) throw refuse('assinatura-invalida')
    return member
  }

  function notDeleted (member) {
    if (deleted(member)) throw refuse('conta-excluida')
  }

  // null without an issuer or a live sealed row (or a store that just became
  // unreadable: the answer is still 'verificado', only without the proof).
  function proofFor (member) {
    if (issuer === null) return null
    let live
    try {
      if (!phones.verified(member)) return null
      live = phones.live(member)
    } catch {
      return null
    }
    if (live === null) return null
    return createPhoneVerified({ member, date: live.verifiedAt }, issuer.keyPair, issuer.cert)
  }

  function sendVerified (res, member) {
    const proof = proofFor(member)
    send(res, 200, proof === null ? { state: 'verificado' } : { state: 'verificado', proof })
  }

  async function policy (req, res) {
    if (!limits.policy()) throw new RouteError('pedido-invalido', 429)
    send(res, 200, { required: on })
  }

  // Re-signed once the cached date is a minute old, or when `since` changed
  // or the clock went backwards.
  let sinceSigned = null
  let sinceSignedAt = 0
  async function sinceRoute (req, res) {
    if (!limits.since()) throw new RouteError('pedido-invalido', 429)
    if (!on || issuer === null) return send(res, 200, { since: null })
    const first = storeRead(() => phones.since())
    if (first === null) return send(res, 200, { since: null })
    const t = now()
    if (sinceSigned === null || sinceSigned.since !== first || t - sinceSignedAt >= SINCE_RESIGN_MS || t < sinceSignedAt) {
      sinceSigned = createPhoneSince({ since: first, date: new Date(t).toISOString() }, issuer.keyPair, issuer.cert)
      sinceSignedAt = t
    }
    send(res, 200, { since: sinceSigned })
  }

  async function start (req, res, body) {
    if (!on) throw refuse('indisponivel')
    const member = memberParam(body.member)
    prune()
    send(res, 200, { nonce: nonces.mint(member) })
  }

  async function sendCode (req, res, body) {
    available()
    const member = prove(body, 'send')
    notDeleted(member)
    const phone = body.phone
    if (!isBrMobile(phone)) throw refuse('telefone-invalido')
    // SMS only (owner decision, 2026-11-11): a client asking for a channel
    // is not one this service built.
    if (Object.hasOwn(body, 'channel')) throw refuse('pedido-invalido')
    // The brake on paid sends: a band already cost an invite-bounded paid
    // session.
    if (!ageVerified(member)) throw refuse('idade-pendente')
    const isLinked = linked(member) === true
    if (!isLinked && store.isFull()) {
      // The band was recorded before the cap filled: the refusal forgets it.
      await forgetAge(member)
      throw refuse('lista-de-espera')
    }
    const index = storeRead(() => phones.indexOf(phone))
    const live = storeRead(() => (phones.verified(member) ? phones.live(member) : null))
    if (live !== null && sameIndex(live.index, index)) return sendVerified(res, member)
    // A send already in flight for this member and number is shared: a
    // second one would text a second code and charge twice. Another number
    // waits like a resend, so pending only ever holds a number a code was
    // sent to.
    const inflight = sending.get(member)
    if (inflight !== undefined) {
      if (!sameIndex(inflight.index, index)) throw refuse('limite-telefone')
      const shared = await inflight.done
      if (shared.state) return send(res, 200, { state: shared.state })
      throw refuse(shared.error)
    }
    const last = lastSent.get(member)
    if (last !== undefined && now() - last < RESEND_MS) throw refuse('limite-telefone')
    // The shared ceiling is only peeked here and charged last, once the
    // narrower windows let the request through.
    const daily = isLinked ? limits.dailyLinked : limits.dailyNew
    if (!daily.has()) {
      log({ event: 'telefone', reason: 'teto-diario' })
      throw refuse('indisponivel')
    }
    if (!limits.member.has(member)) throw refuse('limite-telefone')
    if (!limits.number.has(index)) throw refuse('limite-telefone')
    if (!room(member)) {
      log({ event: 'telefone', reason: 'tabela-cheia' })
      throw refuse('limite-telefone')
    }
    limits.member.take(member)
    limits.number.take(index)
    daily.take()
    // Registered before the first await, so no other request for this member
    // can pass the checks above while this one waits on the provider.
    let settle
    sending.set(member, { index, done: new Promise((resolve) => { settle = resolve }) })
    let r
    try {
      r = await client.send({ phone })
    } catch {
      r = { ok: false, reason: 'falha' }
    } finally {
      sending.delete(member)
    }
    let state = null
    let error = null
    if (r && r.ok === true && r.status === 'enviado') {
      remember(member, phone, index)
      state = 'enviado'
    } else if (r && r.ok === true && r.status === 'bloqueado') {
      log({ event: 'telefone', reason: 'didit-envio-bloqueado' })
      error = 'limite-telefone'
    } else {
      logProvider('didit-envio', r)
      const reason = r && r.reason
      if (reason === 'http-429') {
        error = 'limite-telefone'
      } else if (providerRefused(reason)) {
        error = 'indisponivel'
      } else {
        remember(member, phone, index)
        error = 'resultado-incerto'
      }
    }
    if (state !== null) {
      settle({ state })
      log({ event: 'telefone', reason: 'enviado' })
      return send(res, 200, { state })
    }
    settle({ error })
    throw refuse(error)
  }

  async function checkCode (req, res, body) {
    available()
    const member = prove(body, 'check')
    notDeleted(member)
    const code = body.code
    if (typeof code !== 'string' || !CODE_RE.test(code)) throw refuse('codigo-invalido')
    if (checking.has(member)) throw refuse('limite-telefone')
    if (!limits.check(member)) throw refuse('limite-telefone')
    checking.add(member)
    try {
      await checkOnce(res, member, code)
    } finally {
      checking.delete(member)
    }
  }

  async function checkOnce (res, member, code) {
    const p = pendingOf(member)
    if (p === null) throw refuse('codigo-expirado')
    if (!p.approved) {
      let r
      try {
        r = await client.check({ phone: p.phone, code })
      } catch {
        r = { ok: false, reason: 'falha' }
      }
      if (!r || r.ok !== true) {
        logProvider('didit-checagem', r)
        throw refuse(providerRefused(r && r.reason) ? 'indisponivel' : 'resultado-incerto')
      }
      switch (r.outcome) {
        case 'aprovado':
          if (r.unknownType === true) log({ event: 'telefone', reason: 'tipo-desconhecido' })
          break
        case 'recusado-linha':
          drop(member, p)
          log({ event: 'telefone', reason: 'recusado-linha' })
          throw refuse('telefone-recusado')
        case 'codigo-invalido':
          p.attempts++
          if (p.attempts >= MAX_ATTEMPTS) drop(member, p)
          throw refuse('codigo-invalido')
        case 'expirado':
          drop(member, p)
          throw refuse('codigo-expirado')
        default:
          log({ event: 'telefone', reason: 'resultado-desconhecido' })
          throw refuse('indisponivel')
      }
    }
    // The provider call may have taken a while: a newer send (or another
    // check that already recorded) replaced this entry, or the account was
    // deleted meanwhile. Either way this approval records nothing.
    if (pending.get(member) !== p) throw refuse('codigo-expirado')
    if (deleted(member)) {
      drop(member, p)
      throw refuse('conta-excluida')
    }
    try {
      await phones.record({ member, phone: p.phone, verifiedAt: new Date(now()).toISOString() }, callbacks)
    } catch (err) {
      if (err && err.code === 'conta-excluida') {
        drop(member, p)
        throw refuse('conta-excluida')
      }
      if (err && err.code === 'telefone-em-uso') {
        drop(member, p)
        log({ event: 'telefone', reason: 'em-uso' })
        throw refuse('telefone-em-uso')
      }
      // The provider approved the code: the retry records without asking it
      // again. The write may still have landed, so the outcome is unknown.
      p.approved = true
      log({ event: 'telefone', reason: 'gravacao-falhou' })
      throw refuse('resultado-incerto')
    }
    drop(member, p)
    log({ event: 'telefone', reason: 'verificado' })
    sendVerified(res, member)
  }

  async function status (req, res, body) {
    available()
    const member = prove(body, 'status')
    if (!limits.status(member)) throw refuse('limite-telefone')
    if (verified(member)) return sendVerified(res, member)
    send(res, 200, { state: 'nenhum' })
  }

  const POST = {
    '/account/phone/start': start,
    '/account/phone/send': sendCode,
    '/account/phone/check': checkCode,
    '/account/phone/status': status
  }

  function owns (pathname) {
    return pathname === '/account/phone' || pathname.startsWith('/account/phone/')
  }

  async function handle (req, res, url) {
    const p = url.pathname
    if (req.method === 'GET' && p === '/account/phone/policy') return policy(req, res)
    if (req.method === 'GET' && p === '/account/phone/since') return sinceRoute(req, res)
    if (req.method === 'POST' && Object.hasOwn(POST, p)) {
      checkPost(req)
      const body = await readJsonBody(req, MAX_BODY)
      return POST[p](req, res, body)
    }
    throw refuse('nao-encontrado')
  }

  // Sizes only, never a nonce, a number or a member key.
  function stats () {
    return { nonces: nonces.size(), pending: pending.size }
  }

  return { owns, handle, required, verified, settled, sweepNow, stats }
}

module.exports = { createPhoneRoutes, keyedCeiling, maxKeysFor }
