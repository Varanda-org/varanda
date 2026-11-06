'use strict'

const nodeCrypto = require('node:crypto')
const { verifyInvite } = require('@varanda/core/lib/invite')
const { TERMS_VERSION } = require('@varanda/core/lib/terms')

// A short member session for a read-only feature of the account service
// (GIF search, link previews), proved with the node's read-only invite.sign
// 'summary' signature:
//
//   - start({ member }) -> { nonce } for a linked, unblocked member. Member
//     keys are public, so start stores nothing and counts nothing: the nonce
//     is stateless, bound to the member by an HMAC under a key that lives
//     only in this process (mintNonce).
//   - finish({ member, nonce, signature }) -> { token, expiresAt }. In
//     order: the nonce, the signature, the spent table, the Terms and the
//     member's standing, and only then its per-member limit, the nonce
//     spent and the token issued. So nobody without the member's key can
//     lock that member out or evict another member's state, and a replayed
//     or refused finish never spends the member's window. A full spent
//     table refuses instead of forgetting a live entry, which would allow
//     a replay.
//   - member(req) reads `Authorization: Bearer <token>` and re-checks that
//     the member is still linked and not blocked, at most RECHECK_MS stale
//     (and at once when the clock reads earlier than the last check).
//
// Every feature builds its own session: its own HMAC key, its own nonce
// domain (`varanda/<prefix>-nonce/v1`) and its own token table, so a nonce
// or a token of one feature never works at another. The MAC domain also
// keeps a nonce from ever being an invite nonce.

const SESSION_TTL_MS = 12 * 3600 * 1000
const MAX_SESSIONS = 10000
const NONCE_TTL_S = 600
// A spent nonce is kept this long past its own expiry, so a wall clock
// stepped back by up to one nonce lifetime cannot make it valid again
// after the sweep forgot it.
const SPENT_MARGIN_MS = NONCE_TTL_S * 1000
const MAX_SPENT = 10000
const FINISH_LIMIT = 10
const FINISH_WINDOW_MS = 600 * 1000
const RECHECK_MS = 60 * 1000
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/
const BEARER_RE = /^bearer ([A-Za-z0-9_-]{43})$/i
const HEX64_RE = /^[0-9a-f]{64}$/
const HEX128_RE = /^[0-9a-f]{128}$/
const PREFIX_RE = /^[a-z]{1,16}$/

// The fixed window of ./server.js keyedWindow (same eviction: a new key is
// always admitted, a full table forgets the oldest window), plus
// giveBack(key), which returns one use when the remote fetch failed.
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

// `prefix` names the feature (log event, nonce domain); `overLimit` builds
// the 429 error of the feature. `terms` ({ available, list } or null: no
// session) must hold the member's acceptance of the current Terms.
// `blocklist` ({ has(key) } or null) is the moderation desk's. `maxSpent`
// is replaced only by tests.
function createMemberSession ({
  prefix,
  overLimit,
  store,
  terms = null,
  blocklist = null,
  association,
  log = () => {},
  now = Date.now,
  maxSpent = MAX_SPENT,
  http
}) {
  if (typeof prefix !== 'string' || !PREFIX_RE.test(prefix)) throw new TypeError('prefix inválido')
  const { send, refuse } = http
  const nonceDomain = 'varanda/' + prefix + '-nonce/v1'

  // Memory only: a restart invalidates every outstanding nonce.
  const nonceKey = nodeCrypto.randomBytes(32)
  // nonce -> { expiresAt }: nonces whose signature verified, kept until
  // SPENT_MARGIN_MS past their expiry so none is used twice.
  const spent = new Map()
  // sha256(token) -> { member, expiresAt, checkedAt }: a lookup by digest
  // leaks no timing about the token itself.
  const sessions = new Map()
  const finishLimit = refundableWindow(FINISH_LIMIT, FINISH_WINDOW_MS, now)

  const unavailable = () => refuse('indisponivel')

  function sweep (map, margin = 0) {
    const t = now()
    for (const [k, v] of map) if (v.expiresAt + margin <= t) map.delete(k)
  }

  function digest (token) {
    return nodeCrypto.createHash('sha256').update(token).digest('hex')
  }

  // null when `member` may hold a session, else the refusal token. The one
  // check of start, finish and every use of a token.
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

  // The member of the request's Bearer token, or 401 nao-autorizado.
  function member (req) {
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
    if (t < row.checkedAt || t - row.checkedAt >= RECHECK_MS) {
      if (standing(row.member) !== null) {
        sessions.delete(key)
        log({ event: prefix, reason: 'sessao-revogada' })
        throw refuse('nao-autorizado')
      }
      row.checkedAt = t
    }
    return row.member
  }

  function nonceMac (member, random, expiry) {
    return nodeCrypto.createHmac('sha256', nonceKey)
      .update(nonceDomain)
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

  async function start (req, res, body) {
    const m = memberParam(body.member)
    allowed(m)
    send(res, 200, { nonce: mintNonce(m) })
  }

  async function finish (req, res, body) {
    const m = memberParam(body.member)
    const nonce = typeof body.nonce === 'string' && TOKEN_RE.test(body.nonce) ? body.nonce : null
    const signature = typeof body.signature === 'string' && HEX128_RE.test(body.signature) ? body.signature : null
    const nonceExpiresAt = nonceExpiry(m, nonce)
    if (nonceExpiresAt === null) throw refuse('expirado')
    if (signature === null || !verifyInvite({ action: 'summary', nonce, member: m, association }, signature).ok) throw refuse('assinatura-invalida')
    sweep(spent, SPENT_MARGIN_MS)
    // A replay is refused before anything is charged.
    if (spent.has(nonce)) throw refuse('expirado')
    // Fail closed: forgetting a live entry would let it be replayed.
    if (spent.size >= maxSpent) throw refuse('indisponivel')
    // The current Terms come before a session, as push and Pages require theirs.
    if (terms === null || !terms.available()) throw refuse('indisponivel')
    let accepted
    try {
      accepted = terms.list(m).some((e) => e.version === TERMS_VERSION)
    } catch {
      throw refuse('indisponivel')
    }
    if (!accepted) throw refuse('termos-pendentes')
    allowed(m)
    // Only a finish that would issue a token counts, so nobody else can
    // lock the member out; a member over the limit keeps the nonce.
    if (!finishLimit(m)) throw overLimit()
    spent.set(nonce, { expiresAt: nonceExpiresAt })
    sweep(sessions)
    while (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value)
    const token = nodeCrypto.randomBytes(32).toString('base64url')
    const t = now()
    const expiresAt = t + SESSION_TTL_MS
    sessions.set(digest(token), { member: m, expiresAt, checkedAt: t })
    log({ event: prefix, reason: 'sessao' })
    send(res, 200, { token, expiresAt: new Date(expiresAt).toISOString() })
  }

  function stats () {
    return { sessions: sessions.size, spent: spent.size }
  }

  return { start, finish, member, stats }
}

module.exports = {
  FINISH_LIMIT,
  RECHECK_MS,
  NONCE_TTL_S,
  SPENT_MARGIN_MS,
  refundableWindow,
  createMemberSession
}
