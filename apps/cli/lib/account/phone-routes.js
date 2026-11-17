'use strict'

const nodeCrypto = require('node:crypto')
const { verifyPhone, isBrMobile } = require('@varanda/core/lib/phone')
const { createPhoneVerified, createPhoneSince } = require('@varanda/core/lib/phone-proof')
const { ceiling } = require('./age-routes')
const { createStartNonces, MAX_SPENT } = require('./start-nonces')
const { TIMEOUT_MS } = require('./phone-client')

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
// window or drop someone's code: each send is charged to a daily ceiling
// first (dailyNew or dailyLinked, or the deletion codes' own), so the keys a
// table can hold are bounded (see maxKeysFor), and a table still full of live
// entries refuses the send before the provider call.

const MAX_BODY = 4096
// The deletion codes' entries.
const PENDING_TTL_MS = 600 * 1000
// A verification code's entry, counted from the moment the send was asked
// for: the provider's code lasts 5 minutes from its own receipt of that
// send, so this clock runs out first. It alone answers codigo-expirado: the
// provider's per-number state (a Declined or Expired code, a 429) also moves
// with the deletion sends, which go out only when the typed @nome and number
// match, so an answer read from it would tell a member whether a number is
// someone's.
const CODE_TTL_MS = 300 * 1000
const RESEND_MS = 60 * 1000
// The provider's Retry re-sends the code still pending for the number, so a
// deletion send up to a code's life (plus a slow provider call) after a
// verification send may text that same code: the deletion check refuses it.
const VERIFY_SHADOW_MS = CODE_TTL_MS + TIMEOUT_MS
// A verification stamp outlives every deletion entry it can shadow.
const VERIFY_KEEP_MS = PENDING_TTL_MS + VERIFY_SHADOW_MS
// The deletion SMS names its purpose; verification SMS carry the default name.
const DELETION_SENDER = 'Varanda excluir conta'
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
// 4 * dailyLimit keys are ever live. The deletion codes' windows (pair,
// number) and pending entries are charged first to their own ceiling of
// min(50, dailyLimit): at most 2 * dailyLimit keys each.
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
  // number index -> { at, flying }: the latest start or end of a
  // verification send handed to the provider (or of a deletion send made in
  // its shadow), and how many are still in flight, for the deletion check
  // only (verifiedSince); never read by a verification route. Idle entries
  // leave oldest first past pendingBound.
  const verifySentAt = new Map()
  // Verification sends from before this start are unknown.
  const startedAt = now()
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
    for (const [k, v] of pending) if (t - v.sentAt >= CODE_TTL_MS) pending.delete(k)
    for (const [k, at] of lastSent) if (t - at >= RESEND_MS) lastSent.delete(k)
  }

  function pendingOf (member) {
    const p = pending.get(member)
    if (p === undefined) return null
    if (now() - p.sentAt >= CODE_TTL_MS) {
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
  function remember (member, phone, index, sentAt) {
    prune()
    pending.delete(member)
    const id = ++seq
    pending.set(member, { id, phone, index, sentAt, attempts: 0, approved: false })
    setTimeout(() => {
      const p = pending.get(member)
      if (p !== undefined && p.id === id) pending.delete(member)
    }, Math.max(0, sentAt + CODE_TTL_MS - now())).unref()
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
    const sentAt = now()
    noteVerifySend(index, sentAt)
    let r
    try {
      r = await client.send({ phone })
    } catch {
      r = { ok: false, reason: 'falha' }
    } finally {
      sending.delete(member)
      noteVerifySettle(index, now())
    }
    let state = null
    let error = null
    let line = 'enviado'
    if (r && r.ok === true && r.status === 'enviado') {
      remember(member, phone, index, sentAt)
      state = 'enviado'
    } else if (r && r.ok === true && r.status === 'bloqueado') {
      log({ event: 'telefone', reason: 'didit-envio-bloqueado' })
      error = 'limite-telefone'
    } else if (r && r.reason === 'http-429') {
      // The provider's hourly sends per number also count the deletion
      // sends, which go only on a matching @nome and number: answered and
      // remembered exactly as a sent code, so the next check asks the
      // provider as after a real send.
      remember(member, phone, index, sentAt)
      state = 'enviado'
      line = 'didit-envio-limite'
    } else {
      logProvider('didit-envio', r)
      if (providerRefused(r && r.reason)) {
        error = 'indisponivel'
      } else {
        remember(member, phone, index, sentAt)
        error = 'resultado-incerto'
      }
    }
    if (state !== null) {
      settle({ state })
      log({ event: 'telefone', reason: line })
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
        // A Declined or Expired code counts as a wrong one (see CODE_TTL_MS):
        // the deletion checks and sends move it too.
        case 'expirado':
          log({ event: 'telefone', reason: 'didit-checagem-expirado' })
        // falls through
        case 'codigo-invalido':
          p.attempts++
          if (p.attempts >= MAX_ATTEMPTS) drop(member, p)
          throw refuse('codigo-invalido')
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

  // Deletion codes for Excluir conta sem a passkey (./delete-routes.js): the
  // person types the @nome and the number, and a code goes only when the
  // typed number's index is the member's live, verified row. Nothing here
  // unseals a number: the code goes to the number typed. Own pending,
  // lastSent and in-flight state, and limits no other route reads: a
  // (member, number) window and a per-number window, both charged only for a
  // match (so their keys stay bounded and a stranger's wrong numbers never
  // spend the owner's sends), and a daily ceiling of its own, so deletion and
  // verification never use up each other's sends and no other answer changes
  // with a deletion send. A send that is skipped for any reason, the full
  // daily ceiling included, says nothing: the route answers the same.
  const delPending = new Map()
  const delLastSent = new Map()
  const delChecking = new Set()
  const delLimits = {
    pair: keyedCeiling(3, DAY_MS, now, windowBound),
    number: keyedCeiling(3, DAY_MS, now, windowBound),
    daily: ceiling(Math.min(50, dailyLimit), DAY_MS, now)
  }
  // Counters only, so a test can wait for the background sends.
  const delCount = { asked: 0, settled: 0 }

  // Stamped before the provider call, since a send that failed may still
  // have texted, and again when it settles, since the provider may take it
  // after a deletion send that started later.
  function noteVerifySend (index, t) {
    const e = verifySentAt.get(index) || { at: t, flying: 0 }
    e.flying++
    stampVerify(index, e, t)
  }

  function noteVerifySettle (index, t) {
    const e = verifySentAt.get(index) || { at: t, flying: 1 }
    e.flying--
    stampVerify(index, e, t)
  }

  // An entry with a send in flight is never dropped; those are bounded by the
  // sends in flight, one per member.
  function stampVerify (index, e, t) {
    e.at = Math.max(e.at, t)
    verifySentAt.delete(index)
    verifySentAt.set(index, e)
    for (const [k, v] of verifySentAt) {
      if (v.flying > 0) continue
      if (verifySentAt.size <= pendingBound && t - v.at < VERIFY_KEEP_MS) break
      verifySentAt.delete(k)
    }
  }

  // The provider keeps one live code per number and checks whichever it
  // holds, so around a verification send (anyone may ask one for any
  // number) the code it holds may be that one, not a deletion code: refuse
  // as a wrong code without asking it.
  function verifiedSince (p) {
    return shadowed(p.index, p.sentAt)
  }

  function shadowed (index, t) {
    if (t < startedAt + VERIFY_SHADOW_MS) return true
    const e = verifySentAt.get(index)
    return e !== undefined && (e.flying > 0 || e.at >= t - VERIFY_SHADOW_MS)
  }

  function delPrune () {
    const t = now()
    for (const [k, v] of delPending) if (t - v.sentAt >= PENDING_TTL_MS) delPending.delete(k)
    for (const [k, at] of delLastSent) if (t - at >= RESEND_MS) delLastSent.delete(k)
  }

  function delPendingOf (member) {
    const p = delPending.get(member)
    if (p === undefined) return null
    if (now() - p.sentAt >= PENDING_TTL_MS) {
      delPending.delete(member)
      return null
    }
    return p
  }

  function delDrop (member, p) {
    if (delPending.get(member) === p) delPending.delete(member)
  }

  // Whether `index` is the member's live, verified number. A store that
  // cannot answer matches nothing.
  function delMatches (member, index) {
    try {
      const live = phones.verified(member) ? phones.live(member) : null
      return live !== null && sameIndex(live.index, index)
    } catch {
      log({ event: 'telefone', reason: 'armazenamento-indisponivel' })
      return false
    }
  }

  // Never throws and never tells the caller what happened. Called after the
  // route answered, so a match and a mismatch take the same time.
  function delSend (member, phone, index, skip = false) {
    delCount.asked++
    let started = false
    try {
      if (skip || !on || !delMatches(member, index)) return
      delPrune()
      if (delLastSent.has(member)) return
      if (!delLimits.daily.has()) {
        log({ event: 'telefone', reason: 'exclusao-teto-diario' })
        return
      }
      const pair = member + index
      if (!delLimits.pair.has(pair) || !delLimits.number.has(index)) return
      if (delPending.size >= pendingBound || delLastSent.size >= pendingBound) {
        log({ event: 'telefone', reason: 'exclusao-tabela-cheia' })
        return
      }
      delLimits.pair.take(pair)
      delLimits.number.take(index)
      delLimits.daily.take()
      const id = ++seq
      // Not ready until the provider answers: a check before that is wrong.
      const p = { id, phone, index, sentAt: now(), attempts: 0, ready: false, approved: null }
      // A Retry may also restart the pending code's life, so a deletion send
      // in a shadow carries it on: stamped like a verification send. One
      // outside every shadow stamps nothing, so its own code stays checkable.
      const chained = shadowed(index, p.sentAt)
      if (chained) noteVerifySend(index, p.sentAt)
      delPending.set(member, p)
      delLastSent.set(member, now())
      setTimeout(() => {
        const q = delPending.get(member)
        if (q !== undefined && q.id === id) delPending.delete(member)
      }, PENDING_TTL_MS).unref()
      started = true
      Promise.resolve().then(() => client.send({ phone, senderName: DELETION_SENDER })).catch(() => ({ ok: false, reason: 'falha' })).then((r) => {
        if (r && r.ok === true && r.status === 'enviado') {
          p.ready = true
          log({ event: 'telefone', reason: 'exclusao-enviado' })
        } else if (r && r.ok === true && r.status === 'bloqueado') {
          delDrop(member, p)
          log({ event: 'telefone', reason: 'exclusao-bloqueado' })
        } else {
          logProvider('exclusao-falhou', r)
          // A refusal proves nothing went; anything else may have texted it.
          if (r && (r.reason === 'http-429' || providerRefused(r.reason))) delDrop(member, p)
          else p.ready = true
        }
      }).catch(() => {
        log({ event: 'telefone', reason: 'exclusao-erro' })
      }).finally(() => {
        if (chained) noteVerifySettle(index, now())
        delCount.settled++
      })
    } catch {
      log({ event: 'telefone', reason: 'exclusao-erro' })
    } finally {
      if (!started) delCount.settled++
    }
  }

  // -> the pending entry once the provider approved `code` for the number
  // whose index is `index`; throws refuse('codigo-invalido') otherwise,
  // whatever the cause, provider failures included (nothing is scheduled on
  // that path). The route answers every refusal at a fixed time, so the
  // provider call is not seen either. Only a check that really compares a
  // code (the number matches, the send is confirmed or the code already
  // approved, no other check in flight for the member) charges the
  // per-member window through `admit()`, and only a wrong code then spends
  // one of MAX_ATTEMPTS. Every other refusal (no code, another number, a send
  // not yet confirmed, a check in flight) changes nothing, so checks made
  // without the code cannot fill the window before the owner's turn. An
  // approved entry stays (the caller drops it) and passes again only with
  // the same code, so a schedule whose write was uncertain is retried without
  // a second provider check. `timeoutMs` bounds the provider call.
  async function delCheck (member, index, code, { admit = () => true, timeoutMs } = {}) {
    const invalid = () => refuse('codigo-invalido')
    if (delChecking.has(member)) throw invalid()
    const p = delPendingOf(member)
    if (p === null || !sameIndex(p.index, index)) throw invalid()
    const admitted = () => {
      if (admit()) return true
      log({ event: 'telefone', reason: 'exclusao-limite-checagem' })
      return false
    }
    const wrong = () => {
      p.attempts++
      if (p.attempts >= MAX_ATTEMPTS) delDrop(member, p)
      return invalid()
    }
    if (p.approved !== null) {
      if (!admitted()) throw invalid()
      if (!nodeCrypto.timingSafeEqual(Buffer.from(p.approved), Buffer.from(code))) throw wrong()
      return p
    }
    if (verifiedSince(p)) throw invalid()
    if (!p.ready) throw invalid()
    if (!admitted()) throw invalid()
    delChecking.add(member)
    let r
    try {
      r = await client.check({ phone: p.phone, code, timeoutMs })
    } catch {
      r = { ok: false, reason: 'falha' }
    } finally {
      delChecking.delete(member)
    }
    if (!r || r.ok !== true) {
      logProvider('exclusao-checagem', r)
      throw invalid()
    }
    switch (r.outcome) {
      case 'aprovado':
        break
      case 'recusado-linha':
        delDrop(member, p)
        log({ event: 'telefone', reason: 'exclusao-recusado-linha' })
        throw invalid()
      case 'codigo-invalido':
        throw wrong()
      case 'expirado':
        delDrop(member, p)
        throw invalid()
      default:
        log({ event: 'telefone', reason: 'exclusao-resultado-desconhecido' })
        throw invalid()
    }
    // A newer send replaced this entry while the provider answered.
    if (delPending.get(member) !== p) throw invalid()
    p.approved = code
    return p
  }

  const deletionCodes = {
    available,
    // The HMAC index of an E.164 number the caller already checked.
    index: (phone) => storeRead(() => phones.indexOf(phone)),
    matches: delMatches,
    // After an approval: true / false, or null when the store cannot answer
    // (the caller keeps the approved entry for a retry).
    matchesNow: (member, index) => {
      try {
        const live = phones.verified(member) ? phones.live(member) : null
        return live !== null && sameIndex(live.index, index)
      } catch {
        log({ event: 'telefone', reason: 'armazenamento-indisponivel' })
        return null
      }
    },
    send: delSend,
    check: delCheck,
    drop: delDrop,
    stats: () => ({ pending: delPending.size, asked: delCount.asked, settled: delCount.settled })
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

  return { owns, handle, required, verified, settled, sweepNow, stats, deletionCodes }
}

module.exports = { createPhoneRoutes, keyedCeiling, maxKeysFor, VERIFY_SHADOW_MS }
