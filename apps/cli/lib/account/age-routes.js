'use strict'

const nodeCrypto = require('node:crypto')
const { verifyAge } = require('@varanda/core/lib/age')
const { createAgeVerified, createAgeSince } = require('@varanda/core/lib/age-proof')
const { isCanonicalIso } = require('@varanda/core/lib/cert')
const { inviteId, CODE_RE } = require('./invites-store')
const { isAppRequest, ageReturnUrl } = require('./app-return')

// Hosted age verification with Didit (mounted by ./server.js):
//
//   - GET /account/age/policy answers { required } even when the feature is
//     off: the app treats any failure as "required", so the off answer has
//     to be explicit. Its body stays exactly { required }: installed app
//     versions refuse a policy with any other key.
//   - GET /account/age/since answers { since: null | AgeSince }: an age-since
//     attestation (packages/core/lib/age-proof.js) signed by the issuer while
//     the check is on, `since` is configured, the service has an issuer and
//     at least one band is on record. It is signed fresh, its `date` the
//     signing time (one signed object is reused for at most a minute), and
//     the node accepts it only for member certificates dated within
//     [since, date]: a saved older attestation never vouches for
//     certificates issued after it, when the check may have been off. Its
//     `since` is never earlier than the start of the UTC day after the first
//     band on record (never a record's own timestamp) nor than the last time
//     the check was turned on (enabledAt of ./age-check-state.js, kept in
//     age-check.json in the data directory) nor than the directory floor
//     (directoryFloor of ./age-check-state.js: just after the latest
//     certificate of a linked member with no band). The service issues no
//     certificate to a key without a recorded band while the check is on, so
//     the node treats a member certificate dated in that window as already
//     verified, on any device. An age store, age-check.json or directory
//     floor that cannot answer is the usual 503 indisponivel, never a null: null tells the node
//     to drop the since it holds, so it is kept for the cases above. A
//     separate route because installed apps parse the policy strictly.
//   - start mints a single-use nonce for a member key with no proof and no
//     directory link (the key may be a fresh passkey that is not linked yet),
//     bounded like the other unsigned starts by its table and the global
//     bucket.
//   - session and result each need the member's diary-key proof over that
//     nonce (packages/core/lib/age.js), action-bound, the nonce spent first.
//     session opens one paid Didit session per member and client (web or
//     app) at most, reusing its hosted URL for an hour so a lost answer
//     never opens a second one, and
//     only after the same eligibility checks a link would face (member cap,
//     invite), so nobody shows a face or a document for a link that would
//     be refused anyway. A Feira code (./invites-pair.js feiraOwner, a
//     one-hour code charged to a listing owner, minted on demand by people
//     who are not members) has its own paid-session ceilings, so minting
//     them can never spend the ordinary sign-ups' budget: at most one
//     session per code per day and FEIRA_AGE_DAILY a day for all Feira codes
//     (never a window keyed by the owner, which anonymous minters could
//     spend to lock that owner out), which
//     do not count against the daily ceiling of the other unlinked keys.
//     Each answers 'limite-idade'. Residual: a distributed attacker can
//     spend the Feira ceiling and stop Feira sign-ups for the day, never
//     ordinary ones. result reads the decision and records only the age
//     band in age.json (./age-store.js), then asks Didit to delete the
//     session. A 'verificado' answer from either carries `proof`, an
//     age-verified attestation for the member dated the band's checkedAt
//     (never the band itself), when the service has an issuer.
//
// The open sessions live in memory only: a restart forgets them and the
// member starts over. The Didit session id and URL, the API key, the vendor
// JSON, the band and any age never reach a log line; the URL reaches only
// the member that just proved its key. Logs carry only { event, reason }.
//
// The native app (header x-varanda-client: app) gets Didit's return at
// GET /account/age/app-return, which ignores every parameter and sends the
// system browser to the fixed varanda://idade?volta=1: nothing the provider
// or a forger appends reaches the app, which re-asks the result with its
// signature as the web does.

const MAX_BODY = 4096
const NONCE_TTL_MS = 600 * 1000
const MAX_NONCES = 1000
const URL_REUSE_MS = 3600 * 1000
const SESSION_TTL_MS = 24 * 3600 * 1000
const MAX_SESSIONS = 10000
const DAY_MS = 24 * 3600 * 1000
const SINCE_RESIGN_MS = 60 * 1000
const FEIRA_AGE_DAILY = 50
const HEX64_RE = /^[0-9a-f]{64}$/
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/
const LOG_TOKEN_RE = /^[a-z0-9_-]{1,48}$/
// Only a 4xx from the provider (it refused the request) or our own input check
// proves no session was created; after a timeout, a dropped connection, a 5xx
// or an unreadable success the provider may have created (and billed) one.
function createFailureToken (reason) {
  return reason === 'entrada' || /^http-4\d\d$/.test(String(reason)) ? 'indisponivel' : 'resultado-incerto'
}
const CLEANUP_DELAYS_MS = Object.freeze([30 * 1000, 120 * 1000, 600 * 1000])

// The start of the UTC day after the one holding `iso`.
function nextUtcDay (iso) {
  const d = new Date(iso)
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString()
}

// A fixed window whose room can be checked without spending it: a request is
// only charged once every narrower limit let it through, so refused attempts
// never fill the shared ceiling.
function ceiling (limit, windowMs, now) {
  let start = now()
  let count = 0
  function roll () {
    const t = now()
    if (t - start >= windowMs) {
      start = t
      count = 0
    }
  }
  return {
    has () { roll(); return count < limit },
    take () { roll(); count++ }
  }
}

function createAgeRoutes ({
  didit = null,
  ages = null,
  association,
  origin,
  store,
  invites = null,
  inviting = false,
  log = () => {},
  now = Date.now,
  http,
  dailyLimit = 200,
  since = null,
  issuer = null,
  ageCheck = null,
  directoryFloor = null,
  cleanupDelays = CLEANUP_DELAYS_MS
}) {
  const { send, redirect, readJsonBody, checkPost, RouteError, refuse, keyedWindow, fixedWindow } = http
  if (didit !== null && (typeof didit.createSession !== 'function' || typeof didit.decision !== 'function' || typeof didit.deleteSession !== 'function')) {
    throw new TypeError('didit inválido')
  }
  if (!Number.isSafeInteger(dailyLimit) || dailyLimit < 1) throw new TypeError('ageDailyLimit must be a positive integer')
  if (since !== null && !isCanonicalIso(since)) throw new TypeError('since must be a canonical ISO timestamp')
  if (issuer !== null && (typeof issuer !== 'object' || !issuer.keyPair || !issuer.cert)) throw new TypeError('issuer must be { keyPair, cert } or null')
  if (ageCheck !== null && (typeof ageCheck !== 'object' || (ageCheck.ok === true && ageCheck.enabledAt !== null && !isCanonicalIso(ageCheck.enabledAt)))) {
    throw new TypeError('ageCheck must be a settleAgeCheck result or null')
  }
  if (directoryFloor !== null && (typeof directoryFloor !== 'object' || (directoryFloor.ok === true && directoryFloor.floor !== null && !isCanonicalIso(directoryFloor.floor)))) {
    throw new TypeError('directoryFloor must be a directoryFloor result or null')
  }

  const on = didit !== null && ages !== null

  // Member keys are free to make, so the per-member window alone does not
  // bound paid sessions for keys that are not linked yet: those also share a
  // window per invite code (when invites are on) and their own daily ceiling.
  // Linked members (each one cost a Google account and, when on, an invite)
  // have a separate ceiling, so disposable keys cannot lock them out.
  const limits = {
    session: keyedWindow(3, DAY_MS, now),
    invite: keyedWindow(3, DAY_MS, now),
    result: keyedWindow(30, 600 * 1000, now),
    dailyNew: ceiling(dailyLimit, DAY_MS, now),
    dailyLinked: ceiling(dailyLimit, DAY_MS, now),
    feiraCode: keyedWindow(1, DAY_MS, now),
    dailyFeira: ceiling(FEIRA_AGE_DAILY, DAY_MS, now),
    // The policy answer is a constant the app needs before anything else: its
    // own window, so a flood of other lookups cannot 429 it.
    policy: fixedWindow(6000, 60 * 1000, now),
    since: fixedWindow(6000, 60 * 1000, now)
  }

  // nonce -> { member, expiresAt }, single-use, the oldest evicted for room.
  const nonces = new Map()
  // slot -> { sessionId, url, createdAt }, the oldest evicted for room. A
  // slot is the member and the client kind (see slotOf): the return URL is
  // fixed when the session is created, so a web session is never handed to
  // the app nor an app session to the web.
  const sessions = new Map()
  // slot -> Promise<{ url } | { error } | {}> of a session creation in flight.
  const creating = new Map()
  // Abandoned sessions reach the provider's deletion even with no traffic.
  if (on) setInterval(sweep, 3600 * 1000).unref()

  function slotOf (member, app) {
    return (app ? 'app:' : 'web:') + member
  }

  function required () {
    return on
  }

  function verified (member) {
    if (!on) return false
    try {
      return ages.verified(member) === true
    } catch {
      return false
    }
  }

  // A store that cannot record the band must not send anyone to the provider:
  // the person would hand over a selfie for a result that can never be kept.
  function available () {
    if (!on) throw refuse('indisponivel')
    let ok = false
    try { ok = ages.available() === true } catch {}
    if (!ok) {
      log({ event: 'idade', reason: 'armazenamento-indisponivel' })
      throw refuse('indisponivel')
    }
  }

  // Every 503 says why in the log, so the operator can tell a refused key or
  // callback from a full ceiling: the provider's coarse reason, then each
  // field name it complained about. Tokens only, never a value.
  function logProvider (where, r) {
    const reason = r && typeof r.reason === 'string' && LOG_TOKEN_RE.test(r.reason) ? r.reason : 'falha'
    log({ event: 'idade', reason: where + '-' + reason })
    const fields = r && Array.isArray(r.fields) ? r.fields : []
    for (const field of fields) {
      if (typeof field === 'string' && LOG_TOKEN_RE.test(field)) log({ event: 'idade', reason: where + '-campo-' + field })
    }
  }

  function memberParam (value) {
    if (typeof value !== 'string' || !HEX64_RE.test(value)) throw refuse('pedido-invalido')
    return value
  }

  function sweep () {
    const t = now()
    for (const [k, v] of nonces) if (v.expiresAt <= t) nonces.delete(k)
    // An abandoned session still holds images at the provider: drop it there too.
    for (const [k, v] of sessions) {
      if (t - v.createdAt >= SESSION_TTL_MS) {
        sessions.delete(k)
        cleanup(v.sessionId)
      }
    }
  }

  // Spends the nonce before anything else, then checks the member, the
  // expiry and the signature for `action`.
  function prove (body, action) {
    const member = memberParam(body.member)
    const nonce = typeof body.nonce === 'string' && TOKEN_RE.test(body.nonce) ? body.nonce : null
    const row = nonce === null ? undefined : nonces.get(nonce)
    if (nonce !== null) nonces.delete(nonce)
    if (row === undefined || row.member !== member || row.expiresAt <= now()) throw refuse('expirado')
    if (!verifyAge({ action, nonce, member, association }, body.signature).ok) throw refuse('assinatura-invalida')
    return member
  }

  // Read-only: the code is neither reserved nor consumed here, start and
  // finish still do that for the link itself.
  function inviteOk (code) {
    if (typeof code !== 'string' || !CODE_RE.test(code)) return false
    if (!invites.available()) throw refuse('indisponivel')
    const id = inviteId(code)
    let why
    try {
      why = invites.check(id)
    } catch {
      throw refuse('indisponivel')
    }
    return why === null && !store.inviteUsed(id)
  }

  // The quota owner when `code` (already accepted by inviteOk) is a Feira
  // code, else null. An owner that cannot be named fails closed.
  function feiraOwnerOf (code) {
    if (typeof invites.feiraOwner !== 'function') return null
    try {
      return invites.feiraOwner(inviteId(code))
    } catch {
      throw refuse('indisponivel')
    }
  }

  // Deletion runs in the background so the answer never waits on it; a
  // temporary failure is retried on unref'd timers, since the session (and
  // its images) would otherwise stay at the provider.
  function cleanup (sessionId, attempt = 0) {
    Promise.resolve()
      .then(() => didit.deleteSession(sessionId))
      .catch(() => ({ ok: false, retry: true }))
      .then((r) => {
        if (r && r.ok) return
        if (r && r.retry && attempt < cleanupDelays.length) {
          const timer = setTimeout(() => cleanup(sessionId, attempt + 1), cleanupDelays[attempt])
          timer.unref()
          return
        }
        log({ event: 'idade', reason: 'limpeza-falhou' })
      })
  }

  function finalize (slot, open) {
    if (sessions.get(slot) === open) sessions.delete(slot)
    cleanup(open.sessionId)
  }

  // Closes every open session of an approved member, web and app.
  function finalizeAll (member) {
    for (const kind of [false, true]) {
      const leftover = sessions.get(slotOf(member, kind))
      if (leftover !== undefined) finalize(slotOf(member, kind), leftover)
    }
  }

  async function policy (req, res) {
    if (!limits.policy()) throw new RouteError('pedido-invalido', 429)
    send(res, 200, { required: on })
  }

  // null when there is no issuer or no band on record for `member` (or the
  // store just became unreadable: the answer is still 'verificado', only
  // without the proof). The attestation is deterministic per member, so it
  // needs no cache.
  function proofFor (member) {
    if (issuer === null) return null
    let entry
    try {
      entry = ages.get(member)
    } catch {
      return null
    }
    if (entry === null) return null
    return createAgeVerified({ member, date: entry.checkedAt }, issuer.keyPair, issuer.cert)
  }

  function sendVerified (res, member) {
    const proof = proofFor(member)
    send(res, 200, proof === null ? { state: 'verificado' } : { state: 'verificado', proof })
  }

  // Off, `since` is never served: certificates issued then carry no band.
  // Before the first band on record no certificate can vouch, and a value
  // earlier than that band's next UTC day, or than the last time the check
  // was turned on, or than the latest certificate of an unbanded link, would
  // vouch for certificates issued while it was not really on. A failing
  // store, age-check.json or directory floor refuses instead: null would
  // tell the node to drop the since it already holds.
  let checkLogged = false
  function effectiveSince () {
    if (!on || since === null || issuer === null) return null
    if ((ageCheck !== null && ageCheck.ok !== true) || (directoryFloor !== null && directoryFloor.ok !== true)) {
      if (!checkLogged) log({ event: 'idade', reason: 'estado-indisponivel' })
      checkLogged = true
      throw refuse('indisponivel')
    }
    let first
    try {
      first = ages.earliest()
    } catch {
      log({ event: 'idade', reason: 'armazenamento-indisponivel' })
      throw refuse('indisponivel')
    }
    if (first === null) return null
    let effective = since
    const floors = [nextUtcDay(first), ageCheck === null ? null : ageCheck.enabledAt, directoryFloor === null ? null : directoryFloor.floor]
    for (const floor of floors) {
      if (floor !== null && floor > effective) effective = floor
    }
    return effective
  }

  // Re-signed once the cached date is a minute old, so the date (the upper
  // bound the node applies) stays fresh.
  let sinceSigned = null
  let sinceSignedAt = 0
  async function sinceRoute (req, res) {
    if (!limits.since()) throw new RouteError('pedido-invalido', 429)
    const effective = effectiveSince()
    if (effective === null) return send(res, 200, { since: null })
    const t = now()
    if (sinceSigned === null || sinceSigned.since !== effective || t - sinceSignedAt >= SINCE_RESIGN_MS || t < sinceSignedAt) {
      sinceSigned = createAgeSince({ since: effective, date: new Date(t).toISOString() }, issuer.keyPair, issuer.cert)
      sinceSignedAt = t
    }
    send(res, 200, { since: sinceSigned })
  }

  // No window of its own: a fixed redirect with no secret and no paid call,
  // and a 429 here would strand the browser on an error page instead of
  // returning to the app. The global bucket still bounds it.
  async function appReturn (req, res) {
    redirect(res, ageReturnUrl())
  }

  async function start (req, res, body) {
    available()
    const member = memberParam(body.member)
    sweep()
    while (nonces.size >= MAX_NONCES) nonces.delete(nonces.keys().next().value)
    const nonce = nodeCrypto.randomBytes(32).toString('base64url')
    nonces.set(nonce, { member, expiresAt: now() + NONCE_TTL_MS })
    send(res, 200, { nonce })
  }

  // A key that deleted its account (Excluir conta) never links again, so it
  // never pays for, nor shows anything to, the provider, and gets no band.
  function notDeleted (member) {
    if (typeof store.deletedAt === 'function' && store.deletedAt(member) !== null) throw refuse('conta-excluida')
  }

  async function session (req, res, body) {
    available()
    const member = prove(body, 'session')
    notDeleted(member)
    if (verified(member)) return sendVerified(res, member)
    const app = isAppRequest(req)
    const slot = slotOf(member, app)
    const open = sessions.get(slot)
    if (open !== undefined && now() - open.createdAt < URL_REUSE_MS) return send(res, 200, { url: open.url })
    // A creation already in flight for this slot is shared: a second paid
    // session would replace (and delete) the one whose URL was just returned.
    const inflight = creating.get(slot)
    if (inflight !== undefined) {
      // { url } or { error } of the shared creation, the same answer as the
      // request that made it (an uncertain outcome stays uncertain here too).
      const shared = await inflight
      if (shared.url) return send(res, 200, { url: shared.url })
      // The creation was dropped because the member got approved meanwhile.
      if (verified(member)) return sendVerified(res, member)
      throw refuse(shared.error || 'indisponivel')
    }
    // Eligibility before biometrics: a key the link would refuse never pays
    // for, nor shows anything to, the provider.
    const linked = store.status(member).linked
    let feiraOwner = null
    if (!linked) {
      if (store.isFull()) throw refuse('lista-de-espera')
      if (inviting) {
        if (typeof body.invite !== 'string') throw refuse('convite-obrigatorio')
        if (!inviteOk(body.invite)) throw refuse('convite-invalido')
        feiraOwner = feiraOwnerOf(body.invite)
      }
    }
    // The shared ceiling is only peeked here, so a day at the ceiling does not
    // burn the member's own attempts; it is charged last, once the narrower
    // windows let the request through.
    if (feiraOwner !== null) {
      if (!limits.dailyFeira.has()) {
        log({ event: 'idade', reason: 'teto-diario-feira' })
        throw refuse('limite-idade')
      }
      if (!limits.session(member)) throw refuse('limite-idade')
      // No window keyed by the owner: anonymous callers mint the codes, so it
      // would let them lock an owner out. Cost is bounded by one session per
      // code and the Feira-only daily ceiling; real sign-ups by the weekly cap.
      if (!limits.feiraCode(inviteId(body.invite))) throw refuse('limite-idade')
      limits.dailyFeira.take()
    } else {
      const daily = linked ? limits.dailyLinked : limits.dailyNew
      if (!daily.has()) {
        log({ event: 'idade', reason: 'teto-diario' })
        throw refuse('indisponivel')
      }
      if (!limits.session(member)) throw refuse('limite-idade')
      if (!linked && inviting && !limits.invite(inviteId(body.invite))) throw refuse('limite-idade')
      daily.take()
    }
    // Registered before the first await, so no other request for this member
    // can pass the checks above while this one waits on the provider.
    let settle
    creating.set(slot, new Promise((resolve) => { settle = resolve }))
    let r
    try {
      r = await didit.createSession({
        vendorData: nodeCrypto.randomBytes(16).toString('base64url'),
        callback: app ? origin + '/account/age/app-return' : origin + '/?idade=volta',
        language: 'pt'
      })
    } catch {
      r = { ok: false, reason: 'falha' }
    } finally {
      creating.delete(slot)
    }
    // A result call may have approved the member while this creation waited:
    // the new session is then useless and goes straight to deletion.
    if (r.ok && verified(member)) {
      settle({})
      cleanup(r.sessionId)
      return sendVerified(res, member)
    }
    if (!r.ok) {
      logProvider('didit-sessao', r)
      const error = createFailureToken(r.reason)
      settle({ error })
      throw refuse(error)
    }
    settle({ url: r.url })
    sweep()
    const replaced = sessions.get(slot)
    if (replaced !== undefined) {
      sessions.delete(slot)
      cleanup(replaced.sessionId)
    }
    while (sessions.size >= MAX_SESSIONS) {
      const [oldest, evicted] = sessions.entries().next().value
      sessions.delete(oldest)
      cleanup(evicted.sessionId)
    }
    sessions.set(slot, { sessionId: r.sessionId, url: r.url, createdAt: now() })
    log({ event: 'idade', reason: 'sessao' })
    send(res, 200, { url: r.url })
  }

  async function result (req, res, body) {
    available()
    const member = prove(body, 'result')
    if (typeof store.deletedAt === 'function' && store.deletedAt(member) !== null) {
      // A session opened before the deletion is closed at the provider now.
      finalizeAll(member)
      throw refuse('conta-excluida')
    }
    if (!limits.result(member)) throw refuse('limite-idade')
    if (verified(member)) {
      // A session left open after the approval (a race with a replacement)
      // is closed here rather than at the 24 h sweep.
      finalizeAll(member)
      return sendVerified(res, member)
    }
    // Each client reads the session it opened.
    const slot = slotOf(member, isAppRequest(req))
    const open = sessions.get(slot)
    if (open === undefined || now() - open.createdAt >= SESSION_TTL_MS) {
      if (open !== undefined) {
        sessions.delete(slot)
        cleanup(open.sessionId)
      }
      return send(res, 200, { state: 'nenhum' })
    }
    const r = await didit.decision(open.sessionId)
    if (!r.ok) {
      logProvider('didit-decisao', r)
      throw refuse('indisponivel')
    }
    const state = r.outcome.state
    if (state === 'verificado') {
      try {
        await ages.record({ member, band: r.outcome.band, method: 'didit', checkedAt: new Date(now()).toISOString() })
      } catch {
        // The session stays open, so a retry reads the decision again. The
        // write may still have landed, so the outcome is unknown.
        log({ event: 'idade', reason: 'gravacao-falhou' })
        throw refuse('resultado-incerto')
      }
      // The other client's session is useless now too.
      finalize(slot, open)
      finalizeAll(member)
    } else if (state === 'recusado' || state === 'inconclusivo' || state === 'expirado') {
      finalize(slot, open)
    } else if (state !== 'pendente') {
      log({ event: 'idade', reason: 'estado-desconhecido' })
      throw refuse('indisponivel')
    }
    log({ event: 'idade', reason: state })
    if (state === 'verificado') return sendVerified(res, member)
    send(res, 200, { state })
  }

  const POST = {
    '/account/age/start': start,
    '/account/age/session': session,
    '/account/age/result': result
  }

  function owns (pathname) {
    return pathname === '/account/age' || pathname.startsWith('/account/age/')
  }

  async function handle (req, res, url) {
    const p = url.pathname
    if (req.method === 'GET' && p === '/account/age/policy') return policy(req, res)
    if (req.method === 'GET' && p === '/account/age/since') return sinceRoute(req, res)
    if (req.method === 'GET' && p === '/account/age/app-return') return appReturn(req, res)
    if (req.method === 'POST' && Object.hasOwn(POST, p)) {
      checkPost(req)
      const body = await readJsonBody(req, MAX_BODY)
      return POST[p](req, res, body)
    }
    throw refuse('nao-encontrado')
  }

  // Sizes only, never a nonce, a session id or a URL.
  function stats () {
    return { nonces: nonces.size, sessions: sessions.size }
  }

  return { owns, handle, required, verified, stats }
}

module.exports = {
  FEIRA_AGE_DAILY,
  createAgeRoutes
}
