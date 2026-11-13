'use strict'

const nodeCrypto = require('node:crypto')
const { TERMS_VERSION } = require('@varanda/core/lib/terms')
const { HASH_NONE, SEEN_ACTIONS, blobHash, verifySeen } = require('@varanda/core/lib/seen-proof')
const { SEEN_BLOB_BYTES, SEEN_BLOB_B64 } = require('@varanda/core/lib/seen-blob')

// The encrypted "seen" blob of each member (mounted by ./server.js), kept by
// ./seen-store.js so every device of the same passkey shows the same read
// marks. Two routes under /account/seen/, the flow and order of the push
// routes (./push-routes.js):
//
//   - start { member, action }: a single-use nonce bound to the member and
//     the action. It needs no proof, so it says nothing about the file. The
//     nonce is stateless (an HMAC over the member, the action and an expiry
//     with a secret of this process, as mod-routes.js mints its nonces), so
//     anonymous starts fill no shared table and cannot expire an honest
//     device's nonce; a restart only makes pending nonces 'expirado'.
//   - finish { member, nonce, action, signature, prevHash, blob? }: the
//     member's diary key signs the statement of packages/core/lib/seen-proof.js
//     over the nonce. prevHash makes a write or a delete a compare-and-swap
//     on the exact ciphertext; a conflict answers 409 'conflito' with the
//     current hash (and blob for a write), and nothing is written: the device
//     merges and signs a NEW write, never resends this one.
//
// Only a write needs an acceptance of the current terms: a read keeps older
// clients working and a delete is the erasure path. There is no list route
// and no operator read. Logs carry only { event: 'seen', reason } tokens:
// never a member, nonce, hash, blob or signature.

// The finish body: SEEN_BLOB_B64 base64 characters plus the other fields.
const SEEN_BODY_MAX = 49152
const MAX_BODY = 4096
const NONCE_TTL_MS = 600 * 1000
const NONCE_DOMAIN = 'varanda-seen-nonce-v1'
const SPENT_SWEEP_MS = 1000
// expiry (8) + random (16) + mac (16), canonical base64url of 54 characters.
const NONCE_RAW_BYTES = 40
const NONCE_MAC_BYTES = 16
const NONCE_STR_RE = /^[A-Za-z0-9_-]{54}$/
const HEX64_RE = /^[0-9a-f]{64}$/
const HEX128_RE = /^[0-9a-f]{128}$/
const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/

function createSeenRoutes ({
  association,
  accounts,
  terms = null,
  seenStore = null,
  // { read, write, delete }: keyed windows of server.js, charged per member
  // only after the signature verified.
  limits,
  // member -> void, throws 'telefone-pendente' (server.js phoneChecked).
  phoneChecked = () => {},
  log = () => {},
  now = Date.now,
  http
}) {
  const { send: reply, readJsonBody, checkPost, RouteError, refuse, fromStore } = http
  const over = () => new RouteError('pedido-invalido', 429)

  const nonceSecret = nodeCrypto.randomBytes(32)
  // Nonces already used, until they expire. A nonce is spent only once its
  // signature verified, so only the member's own key adds entries (bounded
  // by the per-member windows) and anonymous traffic adds none. The check,
  // the verification and the spend run with no await between them, so two
  // finishes with one nonce cannot both pass. Nothing live is ever evicted;
  // expired entries are swept at most once a second.
  const spent = new Map()
  let sweptAt = 0

  function note (reason) {
    try { log({ event: 'seen', reason }) } catch {}
  }

  function available () {
    if (seenStore === null || !seenStore.available()) throw refuse('indisponivel')
  }

  function storeError (err) {
    const routeErr = fromStore(err)
    note(routeErr.token)
    return routeErr
  }

  function memberParam (value) {
    if (typeof value !== 'string' || !HEX64_RE.test(value)) throw refuse('pedido-invalido')
    return value
  }

  function actionParam (value) {
    if (!SEEN_ACTIONS.includes(value)) throw refuse('pedido-invalido')
    return value
  }

  function hashParam (value) {
    if (typeof value !== 'string' || !HEX64_RE.test(value)) throw refuse('pedido-invalido')
    return value
  }

  // Canonical standard base64 of exactly SEEN_BLOB_BYTES, so one blob has
  // one spelling and the decoded bytes are the ones the signature names.
  function blobParam (value) {
    if (typeof value !== 'string' || value.length !== SEEN_BLOB_B64 || !B64_RE.test(value)) throw refuse('pedido-invalido')
    const bytes = Buffer.from(value, 'base64')
    if (bytes.length !== SEEN_BLOB_BYTES || bytes.toString('base64') !== value) throw refuse('pedido-invalido')
    return bytes
  }

  function linked (member) {
    if (!accounts.status(member).linked) throw refuse('nao-vinculado')
  }

  function sameHash (a, b) {
    return nodeCrypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
  }

  // member and action are hex64 and an action name: no LF, so the LF-joined
  // prefix is unambiguous.
  function nonceMac (member, action, expiry, random) {
    const h = nodeCrypto.createHmac('sha256', nonceSecret)
    h.update(NONCE_DOMAIN + '\n' + member + '\n' + action + '\n')
    h.update(expiry)
    h.update(random)
    return h.digest().subarray(0, NONCE_MAC_BYTES)
  }

  function mintNonce (member, action) {
    const expiry = Buffer.alloc(8)
    expiry.writeBigUInt64BE(BigInt(now() + NONCE_TTL_MS))
    const random = nodeCrypto.randomBytes(16)
    return Buffer.concat([expiry, random, nonceMac(member, action, expiry, random)]).toString('base64url')
  }

  // -> the expiry (ms) when this process minted the nonce for exactly this
  // member and action and it has not expired, else null. Only the canonical
  // spelling is accepted, so the spent set cannot be dodged by re-spelling.
  function checkNonce (nonce, member, action) {
    if (typeof nonce !== 'string' || !NONCE_STR_RE.test(nonce)) return null
    const raw = Buffer.from(nonce, 'base64url')
    if (raw.length !== NONCE_RAW_BYTES || raw.toString('base64url') !== nonce) return null
    const expiry = raw.subarray(0, 8)
    const random = raw.subarray(8, 24)
    if (!nodeCrypto.timingSafeEqual(raw.subarray(24), nonceMac(member, action, expiry, random))) return null
    const expiresAt = Number(expiry.readBigUInt64BE())
    return expiresAt > now() ? expiresAt : null
  }

  function spend (nonce, expiresAt) {
    const t = now()
    if (t - sweptAt >= SPENT_SWEEP_MS) {
      sweptAt = t
      for (const [k, at] of spent) if (at <= t) spent.delete(k)
    }
    spent.set(nonce, expiresAt)
  }

  async function start (req, res, body) {
    const member = memberParam(body.member)
    const action = actionParam(body.action)
    available()
    linked(member)
    reply(res, 200, { nonce: mintNonce(member, action) })
  }

  // The nonce is spent and the per-member window charged only after the
  // signature verified.
  async function finish (req, res, body) {
    const member = memberParam(body.member)
    const nonce = typeof body.nonce === 'string' ? body.nonce : null
    const action = actionParam(body.action)
    if (typeof body.signature !== 'string' || !HEX128_RE.test(body.signature)) throw refuse('assinatura-invalida')
    const signature = body.signature
    const expiresAt = nonce === null ? null : checkNonce(nonce, member, action)
    if (expiresAt === null || spent.has(nonce)) throw refuse('expirado')
    const prevHash = hashParam(body.prevHash)
    let blob = null
    if (action === 'write') blob = blobParam(body.blob)
    else if (body.blob !== undefined && body.blob !== null) throw refuse('pedido-invalido')
    const newHash = blob === null ? HASH_NONE : blobHash(blob)
    if (!verifySeen({ nonce, member, association, action, prevHash, newHash }, signature).ok) throw refuse('assinatura-invalida')
    // The window first: a refused (429) request spends nothing, so spent
    // entries stay within the per-member windows.
    if (!limits[action](member)) throw over()
    spend(nonce, expiresAt)
    available()
    linked(member)
    // A read and a delete stay open, as with the terms (see the top).
    if (action === 'write') phoneChecked(member)
    if (action === 'read') return read(res, member, prevHash)
    if (action === 'write') return write(res, member, prevHash, blob)
    return remove(res, member, prevHash)
  }

  function read (res, member, prevHash) {
    let current
    try {
      current = seenStore.get(member)
    } catch (err) {
      throw storeError(err)
    }
    if (current === null) return reply(res, 200, { hash: null, blob: null })
    if (sameHash(current.hash, prevHash)) return reply(res, 200, { hash: current.hash, blob: null, unchanged: true })
    reply(res, 200, { hash: current.hash, blob: current.blob.toString('base64') })
  }

  async function write (res, member, prevHash, blob) {
    if (terms === null || !terms.available()) throw refuse('indisponivel')
    let accepted
    try {
      accepted = terms.list(member).some((e) => e.version === TERMS_VERSION)
    } catch (err) {
      throw fromStore(err)
    }
    if (!accepted) throw refuse('termos-pendentes')
    let result
    try {
      result = await seenStore.put({ member, blob, expectedHash: prevHash })
    } catch (err) {
      throw storeError(err)
    }
    if (!result.ok) {
      note('conflito')
      throw refuse('conflito', { hash: result.hash, blob: result.blob === null ? null : Buffer.from(result.blob).toString('base64') })
    }
    reply(res, 200, { ok: true, hash: result.hash })
  }

  async function remove (res, member, prevHash) {
    let result
    try {
      result = await seenStore.forget(member, prevHash)
    } catch (err) {
      throw storeError(err)
    }
    if (!result.ok) {
      note('conflito')
      throw refuse('conflito', { hash: result.hash })
    }
    reply(res, 200, { ok: true, changed: result.changed })
  }

  function owns (pathname) {
    return pathname === '/account/seen' || pathname.startsWith('/account/seen/')
  }

  async function handle (req, res, url) {
    const p = url.pathname
    if (req.method === 'POST' && p === '/account/seen/start') {
      checkPost(req)
      return start(req, res, await readJsonBody(req, MAX_BODY))
    }
    if (req.method === 'POST' && p === '/account/seen/finish') {
      checkPost(req)
      return finish(req, res, await readJsonBody(req, SEEN_BODY_MAX))
    }
    throw refuse('nao-encontrado')
  }

  return { owns, handle }
}

module.exports = {
  createSeenRoutes,
  SEEN_BODY_MAX,
  NONCE_TTL_MS
}
