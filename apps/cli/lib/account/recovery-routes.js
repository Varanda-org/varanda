'use strict'

const nodeCrypto = require('node:crypto')
const { verifyRecovery, blobHashOf, KINDS } = require('@varanda/core/lib/recovery-proof')
const { isBlob } = require('./recovery-store')

// The member's recovery entries (mounted by ./server.js after the age routes):
// an extra passkey or the recovery code wraps the member's root, and the
// wrapped blob is kept here (./recovery-store.js) under a lookupId derived
// from that secret.
//
//   - POST /account/recovery/start { member } -> { nonce }: no proof, a
//     linked member only (as /account/terms/start). The nonce is stateless
//     (as the report nonces in ./mod-routes.js): its expiry, random bytes and
//     a MAC under a per-process secret over the member. start stores nothing
//     and has no per-member quota (anyone may name any public key, so such a
//     quota would let a stranger lock a member out of removing a leaked
//     code); only the global bucket bounds it. A restart draws a new secret,
//     which expires every outstanding nonce.
//   - POST put, remove and list each need the member's diary-key proof over
//     that nonce (@varanda/core/lib/recovery-proof), action-bound. A nonce
//     is recorded as spent only after the proof verified and the member's
//     window allowed it, and is kept only until its own expiry, so the spent
//     set grows with validly signed requests (at most the member window per
//     linked member), never with anonymous traffic; a refused proof spends
//     nothing. put's blobHash is recomputed here from the blob that is
//     stored, never taken from the request.
//   - put answers { createdAt, changed } and remove { changed }: `changed`
//     is false for a no-op (the entry was already there, or already gone).
//     list answers { entries }. list and fetch never answer from stale
//     memory after an uncertain write: the store re-reads the file first or
//     throws, answered 503 'indisponivel'.
//   - POST fetch { lookupId } -> { member, kind, blob } needs no proof: the
//     lookupId is the secret's HKDF output, and the blob opens only with the
//     wrap key derived beside it. It is charged on the shared public-read
//     window and the global bucket only. No per-IP or per-connection limit:
//     nothing here reads a client address (see the note at the top of
//     ./server.js). An unknown or malformed id grows no state. A miss is
//     404 { error: 'nao-encontrado', recovery: true }.
//
// put and remove: a failure after the proof that can follow a write (the
// store's guard answering false after the rename, a failed write) is answered
// 'resultado-incerto' (503), never as a definite refusal: the entry may have
// been stored or removed, and the client keeps the outcome unknown. Only the
// store's own refusals ('pedido-invalido', 'limite-recuperacao'), raised
// before any write, are definite.
//
// `store` null or unavailable answers 503 'indisponivel' on these routes only.
// Logs carry only { event: 'recovery', reason }: never an id, a blob, a member
// or an address.

const MAX_BODY = 4096
const NONCE_TTL_MS = 600 * 1000
// expiry (8) || random (16) || MAC (16): 54 base64url characters, inside the
// 43 to 128 the proof and the RPC accept.
const NONCE_RAW_BYTES = 40
const NONCE_MAC_BYTES = 16
const NONCE_STR_RE = /^[A-Za-z0-9_-]{54}$/
const NONCE_DOMAIN = 'varanda-recovery-nonce-v1'
const HEX64_RE = /^[0-9a-f]{64}$/
const HEX128_RE = /^[0-9a-f]{128}$/
const DEFINITE = new Set(['pedido-invalido', 'limite-recuperacao'])

// createRecoveryRoutes({ store, accounts, association, now, log, limits,
// send, refuse, checkPost, readJsonBody, over }) -> { owns, handle, stats }.
// `limits` is { lookup, member }: the shared public-read window and a keyed
// window per member charged after the proof; `over()` is the 429 the server
// answers for both.
function createRecoveryRoutes ({ store = null, accounts, association, now = Date.now, log = () => {}, limits, send, refuse, checkPost, readJsonBody, over }) {
  let nonceSecret = nodeCrypto.randomBytes(32)
  // nonce -> expiresAt, for nonces a verified request already used. A live
  // entry is never evicted early: that would reopen a replay.
  const spent = new Map()
  // The nonce clock never steps back: a wall clock that jumped forward (so a
  // spent entry was pruned) and was then corrected must not make that nonce
  // live again and reopen a replay. A step back within one TTL holds the
  // clock, so TTLs grow by less than one TTL. A larger step would hold it
  // until the wall clock caught up, with unbounded TTLs and a spent set that
  // never prunes, so it voids every outstanding nonce instead: a new secret
  // fails each old MAC, which is what makes clearing the spent set safe.
  let highWater = 0
  function clock () {
    const t = now()
    if (t + NONCE_TTL_MS < highWater) {
      nonceSecret = nodeCrypto.randomBytes(32)
      spent.clear()
      highWater = t
    } else if (t > highWater) {
      highWater = t
    }
    return highWater
  }

  function nonceMac (member, expiry, random) {
    const h = nodeCrypto.createHmac('sha256', nonceSecret)
    // member is hex64, so the LF-joined prefix is unambiguous.
    h.update(NONCE_DOMAIN + '\n' + member + '\n')
    h.update(expiry)
    h.update(random)
    return h.digest().subarray(0, NONCE_MAC_BYTES)
  }

  function mintNonce (member) {
    const expiry = Buffer.alloc(8)
    expiry.writeBigUInt64BE(BigInt(clock() + NONCE_TTL_MS))
    const random = nodeCrypto.randomBytes(16)
    return Buffer.concat([expiry, random, nonceMac(member, expiry, random)]).toString('base64url')
  }

  // -> the nonce's expiry (ms) when this process minted it for this member
  // and it has not expired, else null. Only the canonical base64url spelling
  // is accepted (54 characters carry 4 spare bits), so one nonce has one
  // string and the spent set cannot be dodged by re-spelling it. The clock is
  // read before the MAC: a rotation it triggers must fail this nonce, never
  // follow a MAC already checked under the old secret.
  function checkNonce (nonce, member) {
    const t = clock()
    if (typeof nonce !== 'string' || !NONCE_STR_RE.test(nonce)) return null
    const raw = Buffer.from(nonce, 'base64url')
    if (raw.length !== NONCE_RAW_BYTES || raw.toString('base64url') !== nonce) return null
    const expiry = raw.subarray(0, 8)
    const random = raw.subarray(8, 24)
    const mac = raw.subarray(24)
    if (!nodeCrypto.timingSafeEqual(mac, nonceMac(member, expiry, random))) return null
    const expiresAt = Number(expiry.readBigUInt64BE())
    return expiresAt > t ? expiresAt : null
  }

  function prune () {
    const t = clock()
    for (const [k, at] of spent) if (at <= t) spent.delete(k)
  }

  function available () {
    if (store === null || !store.available()) {
      log({ event: 'recovery', reason: 'indisponivel' })
      throw refuse('indisponivel')
    }
  }

  function linked (member) {
    if (!accounts.status(member).linked) throw refuse('nao-vinculado')
  }

  function memberParam (value) {
    if (typeof value !== 'string' || !HEX64_RE.test(value)) throw refuse('pedido-invalido')
    return value
  }

  function lookupParam (value) {
    if (typeof value !== 'string' || !HEX64_RE.test(value)) throw refuse('pedido-invalido')
    return value
  }

  function kindParam (value) {
    if (!KINDS.includes(value)) throw refuse('pedido-invalido')
    return value
  }

  // Parses member, nonce and signature and checks the nonce was minted for
  // this member, is live and was not used yet. Spends nothing.
  // -> { member, nonce, expiresAt, signature }.
  function nonceOf (body) {
    const member = memberParam(body.member)
    if (typeof body.signature !== 'string' || !HEX128_RE.test(body.signature)) throw refuse('assinatura-invalida')
    const expiresAt = checkNonce(body.nonce, member)
    if (expiresAt === null || spent.has(body.nonce)) throw refuse('expirado')
    return { member, nonce: body.nonce, expiresAt, signature: body.signature }
  }

  // The proof, then the member's window, then the nonce is spent, then
  // availability and the link, in that order: nothing before the proof is
  // charged or stored. All synchronous, so two requests with one nonce
  // cannot both pass between the check and the spend.
  function proven (fields, expiresAt, signature) {
    if (!verifyRecovery({ ...fields, association }, signature).ok) throw refuse('assinatura-invalida')
    if (!limits.member(fields.member)) throw over()
    prune()
    spent.set(fields.nonce, expiresAt)
    available()
    linked(fields.member)
  }

  function uncertain (err) {
    const code = err && typeof err.code === 'string' ? err.code : null
    return DEFINITE.has(code) ? refuse(code) : refuse('resultado-incerto')
  }

  async function start (req, res, body) {
    const member = memberParam(body.member)
    available()
    linked(member)
    send(res, 200, { nonce: mintNonce(member) })
  }

  async function put (req, res, body) {
    const { member, nonce, expiresAt, signature } = nonceOf(body)
    const kind = kindParam(body.kind)
    const lookupId = lookupParam(body.lookupId)
    if (!isBlob(body.blob) || body.blob.kind !== kind) throw refuse('pedido-invalido')
    const blob = { v: 1, kind, nonce: body.blob.nonce, ciphertext: body.blob.ciphertext }
    const blobHash = blobHashOf({ kind, lookupId, blob })
    proven({ action: 'put', nonce, member, kind, lookupId, blobHash }, expiresAt, signature)
    let result
    try {
      result = await store.put({ member, kind, lookupId, blob })
    } catch (err) {
      throw uncertain(err)
    }
    log({ event: 'recovery', reason: 'put' })
    send(res, 200, { createdAt: result.createdAt, changed: result.changed === true })
  }

  async function remove (req, res, body) {
    const { member, nonce, expiresAt, signature } = nonceOf(body)
    const kind = kindParam(body.kind)
    const lookupId = lookupParam(body.lookupId)
    proven({ action: 'remove', nonce, member, kind, lookupId, blobHash: '' }, expiresAt, signature)
    let result
    try {
      result = await store.remove({ member, lookupId })
    } catch (err) {
      throw uncertain(err)
    }
    log({ event: 'recovery', reason: 'remove' })
    send(res, 200, { changed: result.changed === true })
  }

  async function list (req, res, body) {
    const { member, nonce, expiresAt, signature } = nonceOf(body)
    proven({ action: 'list', nonce, member, kind: '', lookupId: '', blobHash: '' }, expiresAt, signature)
    let entries
    try {
      entries = store.list(member)
    } catch {
      throw refuse('indisponivel')
    }
    log({ event: 'recovery', reason: 'list' })
    send(res, 200, { entries })
  }

  async function fetch (req, res, body) {
    if (!limits.lookup()) throw over()
    const lookupId = lookupParam(body.lookupId)
    available()
    let found
    try {
      found = store.fetch(lookupId)
    } catch {
      throw refuse('indisponivel')
    }
    log({ event: 'recovery', reason: 'fetch' })
    // `recovery: true` marks this route's miss, so a client never reads an
    // older server's generic 404 for an unknown route as "no entry".
    if (found === null) throw refuse('nao-encontrado', { recovery: true })
    send(res, 200, { member: found.member, kind: found.kind, blob: found.blob })
  }

  const POST = {
    '/account/recovery/start': start,
    '/account/recovery/put': put,
    '/account/recovery/remove': remove,
    '/account/recovery/list': list,
    '/account/recovery/fetch': fetch
  }

  function owns (pathname) {
    return pathname === '/account/recovery' || pathname.startsWith('/account/recovery/')
  }

  async function handle (req, res, url) {
    const p = url.pathname
    if (req.method === 'POST' && Object.hasOwn(POST, p)) {
      checkPost(req)
      const body = await readJsonBody(req, MAX_BODY)
      return POST[p](req, res, body)
    }
    throw refuse('nao-encontrado')
  }

  // Sizes only, never a nonce.
  function stats () {
    return { spent: spent.size }
  }

  return { owns, handle, stats }
}

module.exports = {
  createRecoveryRoutes
}
