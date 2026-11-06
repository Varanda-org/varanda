'use strict'

const nodeCrypto = require('node:crypto')
const { verifyAccountLink } = require('@varanda/core/lib/account-link')
const { keyFromAttestation, attestationHash, MAX_CREDENTIAL_ID, MAX_ATTESTATION_BYTES } = require('./webauthn')

// Passkey enrolment for Excluir conta (docs/protocol.md "Account deletion"):
// right after a member links the account, the app sends the attestation
// object of the passkey that created it, and the account service keeps that
// passkey's public key (./passkey-store.js), so a deletion can be authorized
// by a fresh assertion it verifies itself (./delete-routes.js). Mounted by
// ./server.js.
//
//   - POST /account/passkey/start { member } -> { nonce }: no proof, a
//     linked member only (as /account/delete/start). The nonce is
//     single-use, in memory, for NONCE_TTL_MS; the table is bounded and its
//     oldest row goes first.
//   - POST /account/passkey/add { member, nonce, signature, credentialId,
//     attestationObject } -> { added }: the account-link proof
//     (packages/core/lib/account-link.js) at phase 'passkey' over the nonce,
//     the member's current @nome and, as `sub`, the hex SHA-256 of the
//     attestation object's bytes, charged on a per-member window after it
//     verified. The key is read from the attestation object (./webauthn.js:
//     this installation's rpIdHash, the same credential id, user presence,
//     ES256 or RS256).
//
// A key is trusted on first use only: add is accepted while the member has
// no stored key AND the link is at most LINK_WINDOW_MS old, so it can only
// happen at sign-up. Later, a session that is merely unlocked (someone
// holding the person's unlocked device, with a forged authenticator) holds
// the diary key and could sign an enrolment, but the window has passed
// ('vinculo-antigo') and a stored key is never replaced
// ('passkey-registrada'). The same credential again answers { added: false },
// so a retry after an unknown outcome ends well.
//
// Logs carry only { event: 'passkey', reason }: never a key, a credential id
// or a name.

const MAX_BODY = 8192
const NONCE_TTL_MS = 600 * 1000
const MAX_NONCES = 1000
const LINK_WINDOW_MS = 3600 * 1000
const HEX64_RE = /^[0-9a-f]{64}$/
const HEX128_RE = /^[0-9a-f]{128}$/
const NONCE_RE = /^[A-Za-z0-9_-]{43}$/
const CREDENTIAL_RE = /^[A-Za-z0-9_-]+$/

// createPasskeyRoutes({ store, accounts, rpId, association, now, log,
// memberLimit, send, refuse, fromStore, checkPost, readJsonBody, over })
// -> { owns, handle, stats }. `store` null or unavailable answers 503
// 'indisponivel' on these routes only.
function createPasskeyRoutes ({ store = null, accounts, rpId, association, now = Date.now, log = () => {}, memberLimit, send, refuse, fromStore, checkPost, readJsonBody, over }) {
  const nonces = new Map()

  function sweep () {
    const t = now()
    for (const [n, row] of nonces) {
      if (row.expiresAt <= t) nonces.delete(n)
    }
  }

  function memberParam (value) {
    if (typeof value !== 'string' || !HEX64_RE.test(value)) throw refuse('pedido-invalido')
    return value
  }

  function usable () {
    if (store === null || !store.available()) throw refuse('indisponivel')
  }

  // -> the linked member's { username, linkedAt }; refuses a deleted or
  // unlinked key.
  function linked (member) {
    if (accounts.deletedAt(member) !== null) throw refuse('conta-excluida')
    const st = accounts.status(member)
    if (!st.linked) throw refuse('nao-vinculado')
    return { username: st.username, linkedAt: accounts.linkedAt(member) }
  }

  function fresh (linkedAt) {
    const at = typeof linkedAt === 'string' ? Date.parse(linkedAt) : NaN
    return Number.isFinite(at) && now() - at <= LINK_WINDOW_MS
  }

  async function start (req, res, body) {
    usable()
    const member = memberParam(body.member)
    linked(member)
    sweep()
    while (nonces.size >= MAX_NONCES) nonces.delete(nonces.keys().next().value)
    const nonce = nodeCrypto.randomBytes(32).toString('base64url')
    nonces.set(nonce, { member, expiresAt: now() + NONCE_TTL_MS })
    send(res, 200, { nonce })
  }

  async function add (req, res, body) {
    usable()
    const member = memberParam(body.member)
    const nonce = typeof body.nonce === 'string' && NONCE_RE.test(body.nonce) ? body.nonce : null
    if (typeof body.signature !== 'string' || !HEX128_RE.test(body.signature)) throw refuse('assinatura-invalida')
    const credentialId = body.credentialId
    const attestationObject = body.attestationObject
    if (typeof credentialId !== 'string' || credentialId.length > Math.ceil(MAX_CREDENTIAL_ID * 4 / 3) || !CREDENTIAL_RE.test(credentialId)) throw refuse('pedido-invalido')
    if (typeof attestationObject !== 'string' || attestationObject.length > Math.ceil(MAX_ATTESTATION_BYTES * 4 / 3) + 2) throw refuse('pedido-invalido')
    const row = nonce === null ? undefined : nonces.get(nonce)
    if (nonce !== null) nonces.delete(nonce)
    if (row === undefined || row.member !== member || row.expiresAt <= now()) throw refuse('expirado')
    const { username, linkedAt } = linked(member)
    const hash = attestationHash(attestationObject)
    if (hash === null) throw refuse('passkey-invalida')
    const fields = { phase: 'passkey', nonce, member, username, association, sub: hash }
    if (!verifyAccountLink(fields, body.signature).ok) throw refuse('assinatura-invalida')
    if (!memberLimit(member)) throw over()
    const key = keyFromAttestation({ attestationObject, credentialId, rpId })
    if (key === null) {
      log({ event: 'passkey', reason: 'atestado-invalido' })
      throw refuse('passkey-invalida')
    }
    let stored
    try {
      stored = store.keys(member)
    } catch (err) {
      throw fromStore(err)
    }
    const same = stored.find((k) => k.credentialId === credentialId)
    if (same === undefined) {
      if (stored.length > 0) throw refuse('passkey-registrada')
      if (!fresh(linkedAt)) throw refuse('vinculo-antigo')
    }
    let out
    try {
      out = await store.add({ member, credentialId, alg: key.alg, spki: key.spki, signCount: key.signCount, first: true })
    } catch (err) {
      throw fromStore(err)
    }
    if (out.changed) log({ event: 'passkey', reason: 'registrada' })
    send(res, 200, { added: out.changed })
  }

  const POST = {
    '/account/passkey/start': start,
    '/account/passkey/add': add
  }

  function owns (pathname) {
    return pathname === '/account/passkey' || pathname.startsWith('/account/passkey/')
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

  function stats () {
    return { nonces: nonces.size }
  }

  return { owns, handle, stats }
}

module.exports = {
  LINK_WINDOW_MS,
  NONCE_TTL_MS,
  createPasskeyRoutes
}
