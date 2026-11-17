'use strict'

const nodeCrypto = require('node:crypto')
const { verifyAccountLink } = require('@varanda/core/lib/account-link')
const { MAX_KEYS, countedKeys, entryOf } = require('./passkey-store')
const { keyFromAttestation, attestationHash, isAssertion, verifyAssertion, MAX_CREDENTIAL_ID, MAX_ATTESTATION_BYTES } = require('./webauthn')

// Passkey enrolment for Excluir conta (docs/protocol.md "Account deletion"):
// right after a member links the account, the app sends the attestation
// object of the passkey that created it, and the account service keeps that
// passkey's public key (./passkey-store.js), so a deletion can be authorized
// by a fresh assertion it verifies itself (./delete-routes.js). Mounted by
// ./server.js.
//
//   - POST /account/passkey/start { member, list? } -> { nonce } or, with
//     `list: true`, { nonce, passkeys, username }: no proof, a linked member
//     only (as /account/delete/start, which answers the same credential ids
//     and @nome). `passkeys` names the credentials whose key is stored, so
//     the app only asks for an assertion from one that can vouch for a new
//     passkey; `username` is the @nome the add's proof must name. Only
//     on request: older apps read the answer as exactly { nonce }, and an
//     older server ignores `list`, so a new app that gets no list skips the
//     extra passkey step. `list` other than absent or true is
//     'pedido-invalido'. The nonce is single-use, in memory, for
//     NONCE_TTL_MS; the table is bounded and its oldest row goes first.
//   - POST /account/passkey/add { member, nonce, signature, credentialId,
//     attestationObject, assertion?, lookupId? } -> { added }: the
//     account-link proof
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
// An extra passkey (a 'passkey' recovery entry, ./recovery-store.js) gets a
// key only through a chain of trust: `assertion` is a fresh assertion over
// the same nonce by a passkey whose key the service already holds (checked
// as ./delete-routes.js checks a deletion), and `lookupId` names the
// member's live 'passkey' entry the new key belongs to (stored with that
// entry's createdAt, so a later entry at the same lookupId is another
// entry, passkey-store countedKeys). An unlocked session
// alone cannot produce that assertion. The key is linked to the entry, so
// removing the entry drops it (./recovery-routes.js), and an extra key counts
// (here as a voucher and in the list, in ./delete-routes.js to delete at
// once) only while its entry is live (passkey-store countedKeys). Without `assertion`
// the answer stays 'passkey-registrada', as for older apps (an older server
// ignores `assertion` and `lookupId` and answers the same). An assertion
// that does not verify, or a lookupId that is not the member's live
// 'passkey' entry, is 'passkey-invalida'; an entry that already has a key is
// 'pedido-invalido'; MAX_KEYS keys is 'limite-recuperacao'; recovery.json
// unusable is 'indisponivel'. `assertion` or `lookupId` while no key is
// stored is 'pedido-invalido': the first key comes only from the link.
//
// Logs carry only { event: 'passkey', reason }: never a key, a credential id
// or a name.

// An attestation object and an assertion in one body.
const MAX_BODY = 16384
const NONCE_TTL_MS = 600 * 1000
const MAX_NONCES = 1000
const LINK_WINDOW_MS = 3600 * 1000
const HEX64_RE = /^[0-9a-f]{64}$/
const HEX128_RE = /^[0-9a-f]{128}$/
const NONCE_RE = /^[A-Za-z0-9_-]{43}$/
const CREDENTIAL_RE = /^[A-Za-z0-9_-]+$/

// createPasskeyRoutes({ store, recovery, accounts, rpId, origins,
// association, now, log, memberLimit, send, refuse, fromStore, checkPost,
// readJsonBody, over }) -> { owns, handle, stats }. `store` null or
// unavailable answers 503 'indisponivel' on these routes only; `recovery`
// (an openRecoveryStore) null or unavailable does so for an extra passkey
// only.
function createPasskeyRoutes ({ store = null, recovery = null, accounts, rpId, origins = [], association, now = Date.now, log = () => {}, memberLimit, send, refuse, fromStore, checkPost, readJsonBody, over }) {
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
    if (body.list !== undefined && body.list !== true) throw refuse('pedido-invalido')
    const { username } = linked(member)
    let passkeys = null
    if (body.list === true) {
      try {
        passkeys = countedKeys(store.keys(member), recovery, member).map((k) => k.credentialId)
      } catch (err) {
        throw fromStore(err)
      }
    }
    sweep()
    while (nonces.size >= MAX_NONCES) nonces.delete(nonces.keys().next().value)
    const nonce = nodeCrypto.randomBytes(32).toString('base64url')
    nonces.set(nonce, { member, expiresAt: now() + NONCE_TTL_MS })
    send(res, 200, passkeys === null ? { nonce } : { nonce, passkeys, username })
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
    const assertion = body.assertion
    const lookupId = body.lookupId
    if (assertion !== undefined && !isAssertion(assertion)) throw refuse('pedido-invalido')
    if (lookupId !== undefined && (typeof lookupId !== 'string' || !HEX64_RE.test(lookupId))) throw refuse('pedido-invalido')
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
    if (stored.length === 0 && (assertion !== undefined || lookupId !== undefined)) throw refuse('pedido-invalido')
    if (same === undefined && stored.length > 0) {
      if (assertion === undefined) throw refuse('passkey-registrada')
      return addExtra(res, { member, nonce, credentialId, key, stored, assertion, lookupId })
    }
    if (same === undefined && !fresh(linkedAt)) throw refuse('vinculo-antigo')
    let out
    try {
      out = await store.add({ member, credentialId, alg: key.alg, spki: key.spki, signCount: key.signCount, first: true })
    } catch (err) {
      throw fromStore(err)
    }
    if (out.changed) log({ event: 'passkey', reason: 'registrada' })
    send(res, 200, { added: out.changed })
  }

  // A new key vouched for by a stored one (see the top of the file).
  async function addExtra (res, { member, nonce, credentialId, key, stored, assertion, lookupId }) {
    if (lookupId === undefined) throw refuse('pedido-invalido')
    const signer = countedKeys(stored, recovery, member).find((k) => k.credentialId === assertion.credentialId)
    const checked = signer === undefined
      ? { ok: false, reason: 'desconhecida' }
      : verifyAssertion({ assertion, key: signer, challenge: Buffer.from(nonce, 'base64url'), rpId, origins })
    if (!checked.ok) {
      log({ event: 'passkey', reason: 'passkey-' + checked.reason })
      throw refuse('passkey-invalida')
    }
    if (recovery === null || !recovery.available()) throw refuse('indisponivel')
    let entry
    try {
      entry = recovery.list(member).find((r) => r.lookupId === lookupId)
    } catch {
      throw refuse('indisponivel')
    }
    if (entry === undefined || entry.kind !== 'passkey') {
      log({ event: 'passkey', reason: 'entrada-ausente' })
      throw refuse('passkey-invalida')
    }
    if (stored.some((k) => k.lookupId === lookupId)) throw refuse('pedido-invalido')
    if (stored.length >= MAX_KEYS) await dropUnlinked(member, stored, signer.credentialId)
    // As in a deletion: the counter only matters for clone detection, and
    // the add below re-reads the file anyway.
    try {
      await store.touch({ member, credentialId: signer.credentialId, signCount: checked.signCount })
    } catch {}
    let out
    try {
      out = await store.add({ member, credentialId, alg: key.alg, spki: key.spki, signCount: key.signCount, first: false, lookupId, entryAt: entry.createdAt, voucher: signer.credentialId })
    } catch (err) {
      throw fromStore(err)
    }
    if (out.changed) log({ event: 'passkey', reason: 'registrada-extra' })
    send(res, 200, { added: out.changed })
  }

  // At the cap, the keys whose recovery entry is gone (removed by an older
  // server, which left the key behind) stop holding a slot. The asserting
  // key stays: it just proved it is the person's. Only here, so a deletion
  // never depends on recovery.json.
  async function dropUnlinked (member, stored, keep) {
    let rows
    try {
      rows = recovery.list(member)
    } catch {
      throw refuse('indisponivel')
    }
    for (const k of stored) {
      if (k.lookupId === null || k.credentialId === keep || entryOf(k, rows)) continue
      try {
        await store.removeByLookup({ member, lookupId: k.lookupId })
      } catch (err) {
        throw fromStore(err)
      }
    }
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
