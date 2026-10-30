'use strict'

const nodeCrypto = require('node:crypto')
const { verifyAge } = require('@varanda/core/lib/age')
const { inviteId, CODE_RE } = require('./invites-store')

// Hosted age verification with Didit (mounted by ./server.js):
//
//   - GET /account/age/policy answers { required } even when the feature is
//     off: the app treats any failure as "required", so the off answer has
//     to be explicit.
//   - start mints a single-use nonce for a member key with no proof and no
//     directory link (the key may be a fresh passkey that is not linked yet),
//     bounded like the other unsigned starts by its table and the global
//     bucket.
//   - session and result each need the member's diary-key proof over that
//     nonce (packages/core/lib/age.js), action-bound, the nonce spent first.
//     session opens one paid Didit session per member at most, reusing its
//     hosted URL for an hour so a lost answer never opens a second one, and
//     only after the same eligibility checks a link would face (member cap,
//     invite), so nobody shows a face or a document for a link that would
//     be refused anyway. result reads the decision and records only the age
//     band in age.json (./age-store.js), then asks Didit to delete the
//     session.
//
// The open sessions live in memory only: a restart forgets them and the
// member starts over. The Didit session id and URL, the API key, the vendor
// JSON, the band and any age never reach a log line; the URL reaches only
// the member that just proved its key. Logs carry only { event, reason }.

const MAX_BODY = 4096
const NONCE_TTL_MS = 600 * 1000
const MAX_NONCES = 1000
const URL_REUSE_MS = 3600 * 1000
const SESSION_TTL_MS = 24 * 3600 * 1000
const MAX_SESSIONS = 10000
const DAY_MS = 24 * 3600 * 1000
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
  cleanupDelays = CLEANUP_DELAYS_MS
}) {
  const { send, readJsonBody, checkPost, RouteError, refuse, keyedWindow, fixedWindow } = http
  if (didit !== null && (typeof didit.createSession !== 'function' || typeof didit.decision !== 'function' || typeof didit.deleteSession !== 'function')) {
    throw new TypeError('didit inválido')
  }
  if (!Number.isSafeInteger(dailyLimit) || dailyLimit < 1) throw new TypeError('ageDailyLimit must be a positive integer')

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
    // The policy answer is a constant the app needs before anything else: its
    // own window, so a flood of other lookups cannot 429 it.
    policy: fixedWindow(6000, 60 * 1000, now)
  }

  // nonce -> { member, expiresAt }, single-use, the oldest evicted for room.
  const nonces = new Map()
  // member -> { sessionId, url, createdAt }, the oldest evicted for room.
  const sessions = new Map()
  // member -> Promise<{ url } | { error } | {}> of a session creation in flight.
  const creating = new Map()
  // Abandoned sessions reach the provider's deletion even with no traffic.
  if (on) setInterval(sweep, 3600 * 1000).unref()

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

  function finalize (member, open) {
    if (sessions.get(member) === open) sessions.delete(member)
    cleanup(open.sessionId)
  }

  async function policy (req, res) {
    if (!limits.policy()) throw new RouteError('pedido-invalido', 429)
    send(res, 200, { required: on })
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

  async function session (req, res, body) {
    available()
    const member = prove(body, 'session')
    if (verified(member)) return send(res, 200, { state: 'verificado' })
    const open = sessions.get(member)
    if (open !== undefined && now() - open.createdAt < URL_REUSE_MS) return send(res, 200, { url: open.url })
    // A creation already in flight for this member is shared: a second paid
    // session would replace (and delete) the one whose URL was just returned.
    const inflight = creating.get(member)
    if (inflight !== undefined) {
      // { url } or { error } of the shared creation, the same answer as the
      // request that made it (an uncertain outcome stays uncertain here too).
      const shared = await inflight
      if (shared.url) return send(res, 200, { url: shared.url })
      // The creation was dropped because the member got approved meanwhile.
      if (verified(member)) return send(res, 200, { state: 'verificado' })
      throw refuse(shared.error || 'indisponivel')
    }
    // Eligibility before biometrics: a key the link would refuse never pays
    // for, nor shows anything to, the provider.
    const linked = store.status(member).linked
    if (!linked) {
      if (store.isFull()) throw refuse('lista-de-espera')
      if (inviting) {
        if (typeof body.invite !== 'string') throw refuse('convite-obrigatorio')
        if (!inviteOk(body.invite)) throw refuse('convite-invalido')
      }
    }
    // The shared ceiling is only peeked here, so a day at the ceiling does not
    // burn the member's own attempts; it is charged last, once the narrower
    // windows let the request through.
    const daily = linked ? limits.dailyLinked : limits.dailyNew
    if (!daily.has()) {
      log({ event: 'idade', reason: 'teto-diario' })
      throw refuse('indisponivel')
    }
    if (!limits.session(member)) throw refuse('limite-idade')
    if (!linked && inviting && !limits.invite(inviteId(body.invite))) throw refuse('limite-idade')
    daily.take()
    // Registered before the first await, so no other request for this member
    // can pass the checks above while this one waits on the provider.
    let settle
    creating.set(member, new Promise((resolve) => { settle = resolve }))
    let r
    try {
      r = await didit.createSession({
        vendorData: nodeCrypto.randomBytes(16).toString('base64url'),
        callback: origin + '/?idade=volta',
        language: 'pt'
      })
    } catch {
      r = { ok: false, reason: 'falha' }
    } finally {
      creating.delete(member)
    }
    // A result call may have approved the member while this creation waited:
    // the new session is then useless and goes straight to deletion.
    if (r.ok && verified(member)) {
      settle({})
      cleanup(r.sessionId)
      return send(res, 200, { state: 'verificado' })
    }
    if (!r.ok) {
      logProvider('didit-sessao', r)
      const error = createFailureToken(r.reason)
      settle({ error })
      throw refuse(error)
    }
    settle({ url: r.url })
    sweep()
    const replaced = sessions.get(member)
    if (replaced !== undefined) {
      sessions.delete(member)
      cleanup(replaced.sessionId)
    }
    while (sessions.size >= MAX_SESSIONS) {
      const [oldest, evicted] = sessions.entries().next().value
      sessions.delete(oldest)
      cleanup(evicted.sessionId)
    }
    sessions.set(member, { sessionId: r.sessionId, url: r.url, createdAt: now() })
    log({ event: 'idade', reason: 'sessao' })
    send(res, 200, { url: r.url })
  }

  async function result (req, res, body) {
    available()
    const member = prove(body, 'result')
    if (!limits.result(member)) throw refuse('limite-idade')
    if (verified(member)) {
      // A session left open after the approval (a race with a replacement)
      // is closed here rather than at the 24 h sweep.
      const leftover = sessions.get(member)
      if (leftover !== undefined) finalize(member, leftover)
      return send(res, 200, { state: 'verificado' })
    }
    const open = sessions.get(member)
    if (open === undefined || now() - open.createdAt >= SESSION_TTL_MS) {
      if (open !== undefined) {
        sessions.delete(member)
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
      finalize(member, open)
    } else if (state === 'recusado' || state === 'inconclusivo' || state === 'expirado') {
      finalize(member, open)
    } else if (state !== 'pendente') {
      log({ event: 'idade', reason: 'estado-desconhecido' })
      throw refuse('indisponivel')
    }
    log({ event: 'idade', reason: state })
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
  createAgeRoutes
}
