'use strict'
// The identity host controls of the in-app web node (docs/rpc.md 5.50 to
// 5.55), IPC only: the host runs the WebAuthn ceremony (or reopens its
// stored session) and hands over only the passkey's PRF output; this module
// derives the key pairs and drives the web-member session, as the browser
// entry (packages/web-member/web/node.js) does around its install / bind /
// signedOut logic. Pure: no Bare global and no runtime module, so the same
// code runs in the worklet and in the Node tests; hkdf and randomBytes are
// injected (bare-crypto in the worklet, node:crypto in the tests).
//
//   const host = createIdentityHost({ session, storage, hkdf, randomBytes })
//   host.install({ prf, credentialId, userId, rpId, resumed }) -> { publicKey, resumed }
//   host.clear() / host.reset() / host.forget() / host.sessionSaved() -> {}
//   host.status() -> docs/rpc.md 5.52
//   host.recoveryLookup({ kind, secret, code }) -> { lookupId }     (5.91)
//   host.recoveryOpen({ blob, member }) -> { prf }                  (5.92)
//   host.recoveryWrap({ kind, secret }) -> { lookupId, blob, code? } (5.93)
//   host.recoveryBind({ credentialId, userId }) -> {}               (5.94)
//   host.close() zeroes the held root and any pending wrap key
//
// The PRF output (hex on the wire) is copied into a buffer that is zeroed
// in a finally, with the nonce and both derived pairs; it never reaches a
// result, an error message or a log. The controls run one at a time, in
// arrival order (the session's own chain serializes only its handlers).
//
// The sign-out barrier (kv 'signedOut', 5.54): a resumed install is refused
// while it is set, and nothing here lifts it except sessionSaved, which the
// host calls only after durably storing the session of a NON-resumed
// install; it is refused unless the last successful install of this
// worklet generation was non-resumed and the node is still unlocked with
// that key (every path that changes or drops the key goes through here and
// forgets that install).
//
// Recovery (5.91 to 5.94): while the node is unlocked, a zeroable copy of
// the PRF of the last successful install (the root) is kept to wrap it for
// a second passkey or a recovery code; every path that drops the key drops
// the root too, and so does any install attempt until it succeeds. The root
// is never handed to session.setKeyPair (it gets { media } only). A lookup
// keeps one wrap key pending for RECOVERY_PENDING_MS; the next open consumes
// it whatever the outcome.
const b4a = require('b4a')
const { RpcError } = require('@varanda/rpc')
const passkey = require('@varanda/web-member/lib/passkey')
const store = require('@varanda/web-member/lib/node-store')
const recovery = require('@varanda/web-member/lib/recovery')

const PASSKEY_KEY = 'passkey'
const SIGNED_OUT_KEY = 'signedOut'
const NONCE_BYTES = 32
const PRF_RE = /^[0-9a-f]{64}$/
const SIGNED_OUT = 'sessão encerrada neste aparelho: entre com a passkey'
const NO_NEW_INSTALL = 'nenhuma entrada nova com a passkey'
const BAD_CODE = 'código de recuperação inválido'
const BAD_ENTRY = 'entrada de recuperação inválida'
const BAD_WRAP_PASSKEY = 'passkey de recuperação inválida'
const RECOVERY_PENDING_MS = 120 * 1000

function usage (message) {
  return new RpcError('USAGE', message)
}

// The stored passkey record, or null for anything else (web/node.js).
function passkeyRecord (value) {
  if (value === null || typeof value !== 'object' || value.v !== 1) return null
  if (typeof value.credentialId !== 'string' || value.credentialId === '') return null
  if (typeof value.rpId !== 'string' || value.rpId === '') return null
  const userId = typeof value.userId === 'string' ? value.userId : null
  return { v: 1, credentialId: value.credentialId, rpId: value.rpId, userId }
}

function zeroPair (kp) {
  if (kp === null) return
  kp.secretKey.fill(0)
  kp.publicKey.fill(0)
}

// keys: the derivation functions (lib/passkey.js; a test seam).
// now: the clock of the pending wrap key's expiry (a test seam).
function createIdentityHost ({ session, storage, hkdf, randomBytes, keys = passkey, now = Date.now } = {}) {
  if (session === null || typeof session !== 'object') throw new TypeError('session required')
  if (storage === null || typeof storage !== 'object') throw new TypeError('storage required')
  if (typeof hkdf !== 'function') throw new TypeError('hkdf required')
  if (typeof randomBytes !== 'function') throw new TypeError('randomBytes required')

  let chain = Promise.resolve()
  // { publicKey, resumed } of the last successful install while its key is
  // still in the session; null otherwise.
  let current = null
  // The PRF of that install (Uint8Array(32)) while it is current; null otherwise.
  let root = null
  // rpId of that install, for recoveryBind when no record is stored.
  let rootRpId = null
  // { wrapKey, kind, expiresAt } of the latest recoveryLookup; null otherwise.
  let pending = null

  function dropRoot () {
    if (root !== null) root.fill(0)
    root = null
    rootRpId = null
  }

  function dropPending () {
    if (pending !== null) pending.wrapKey.fill(0)
    pending = null
  }

  function serial (fn) {
    return (...args) => {
      const next = chain.then(() => fn(...args))
      chain = next.catch(() => {})
      return next
    }
  }

  async function signedOut () {
    const mark = await storage.readJson(SIGNED_OUT_KEY)
    return mark !== null && mark !== undefined
  }

  // This device's media nonce (kv 'mediaDevice'), drawn and written once.
  async function mediaNonce () {
    const device = await store.readMediaDevice(storage)
    if (device !== null) return new Uint8Array(b4a.from(device.nonce, 'hex'))
    const raw = randomBytes(NONCE_BYTES)
    const nonce = new Uint8Array(NONCE_BYTES)
    nonce.set(raw)
    raw.fill(0)
    await store.writeMediaDevice(storage, b4a.toString(nonce, 'hex'))
    return nonce
  }

  // Binds the passkey record; a failed write puts the previous one back.
  async function bind (record) {
    const prev = await storage.readJson(PASSKEY_KEY)
    try {
      await storage.writeJson(PASSKEY_KEY, record)
    } catch (err) {
      await storage.writeJson(PASSKEY_KEY, prev === undefined ? null : prev).catch(() => {})
      throw err
    }
  }

  // Validated by the dispatcher (5.50); checked again since prf is the root
  // secret. -> a fresh 32-byte buffer the caller zeroes. Decoded by hand:
  // b4a.from would leave a copy in the shared buffer pool that nothing zeroes.
  function prfBytes (hex) {
    if (typeof hex !== 'string' || !PRF_RE.test(hex)) throw usage('pedido inválido')
    const out = new Uint8Array(hex.length / 2)
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
    return out
  }

  const install = serial(async ({ prf: prfHex, credentialId, userId, rpId, resumed } = {}) => {
    let prf = null
    let kp = null
    let media = null
    let nonce = null
    let installed = false
    let done = false
    dropRoot()
    try {
      prf = prfBytes(prfHex)
      const fromSession = resumed === true
      if (fromSession && await signedOut()) throw usage(SIGNED_OUT)
      kp = await keys.keyPairFromPrf(prf, { hkdf })
      nonce = await mediaNonce()
      media = await keys.mediaKeyPairFromPrf(prf, nonce, { hkdf })
      const publicKey = b4a.toString(kp.publicKey, 'hex')
      // Forgotten only now: a refused or failed attempt before the new pairs
      // go in leaves the previous install (and its sessionSaved) as it was.
      current = null
      // setKeyPair copies both pairs synchronously: the local copies are zeroed below.
      const setting = session.setKeyPair(kp, { media })
      zeroPair(kp)
      zeroPair(media)
      installed = true
      await setting
      const status = await session.identityStatus()
      if (status.exists && (status.publicKey !== publicKey || status.legacy)) throw usage(store.MISMATCH)
      if (!fromSession) {
        await bind({ v: 1, credentialId, rpId, userId: userId === '' ? null : userId })
      }
      current = { publicKey, resumed: fromSession }
      root = new Uint8Array(prf)
      rootRpId = typeof rpId === 'string' && rpId !== '' ? rpId : null
      done = true
      return { publicKey, resumed: fromSession }
    } finally {
      // A failed attempt holds no recovery secret either, as clear/forget/close.
      if (!done) dropPending()
      // Any failure after the pairs went in leaves the node locked.
      if (installed && !done) await session.clearKeyPair().catch(() => {})
      if (prf !== null) prf.fill(0)
      if (nonce !== null) nonce.fill(0)
      zeroPair(kp)
      zeroPair(media)
    }
  })

  const clear = serial(async () => {
    current = null
    dropRoot()
    dropPending()
    await session.clearKeyPair()
    return {}
  })

  // The barrier first, then the lock; a marker that could not be written
  // still locks, and fails the call.
  const forget = serial(async () => {
    current = null
    dropRoot()
    dropPending()
    try {
      await storage.writeJson(SIGNED_OUT_KEY, { v: 1 })
    } finally {
      await session.clearKeyPair()
    }
    return {}
  })

  // The marker before anything is deleted: no deletion without it. The
  // session's reset removes the diary, the media cores and kv mediaDevice;
  // the nonce is cleared here as well so the next identity draws a new one.
  const reset = serial(async () => {
    current = null
    dropRoot()
    dropPending()
    try {
      await storage.writeJson(SIGNED_OUT_KEY, { v: 1 })
    } catch (err) {
      await session.clearKeyPair().catch(() => {})
      throw err
    }
    try {
      await session.reset()
      await storage.writeJson('mediaDevice', null)
      await storage.writeJson(PASSKEY_KEY, null)
    } catch (err) {
      await session.clearKeyPair().catch(() => {})
      throw err
    }
    return {}
  })

  // A ceremony that saved a new session lifts the sign-out barrier (a
  // failed save never calls this: an older record may still be there).
  const sessionSaved = serial(async () => {
    const status = await session.identityStatus()
    if (status.unlocked !== true) throw usage(store.LOCKED)
    if (current === null || current.resumed) throw usage(NO_NEW_INSTALL)
    if (status.exists && status.publicKey !== current.publicKey) throw usage(NO_NEW_INSTALL)
    await storage.writeJson(SIGNED_OUT_KEY, null)
    return {}
  })

  const status = serial(async () => {
    const s = await session.identityStatus()
    const record = passkeyRecord(await storage.readJson(PASSKEY_KEY))
    const unlocked = s.unlocked === true
    return {
      exists: s.exists === true,
      publicKey: typeof s.publicKey === 'string' ? s.publicKey : null,
      legacy: s.legacy === true,
      unlocked,
      synced: s.synced === true,
      resumed: unlocked && current !== null && current.resumed,
      passkeyKnown: record !== null,
      credentialId: record !== null ? record.credentialId : null,
      rpId: record !== null ? record.rpId : null,
      userId: record !== null ? record.userId : null,
      signedOut: await signedOut()
    }
  })

  // The root, only while the node is still unlocked with its install.
  async function heldRoot () {
    const s = await session.identityStatus()
    if (root === null || current === null || s.unlocked !== true) throw usage(store.LOCKED)
    if (s.exists && s.publicKey !== current.publicKey) throw usage(store.LOCKED)
    return root
  }

  const recoveryLookup = serial(async ({ kind, secret: secretHex, code } = {}) => {
    let secret = null
    let derived = null
    try {
      if (kind === 'passkey') {
        secret = prfBytes(secretHex)
      } else if (kind === 'code') {
        secret = recovery.decodeCode(code)
        if (secret === null) throw usage(BAD_CODE)
      } else {
        throw usage('pedido inválido')
      }
      derived = await recovery.deriveRecoveryKeys(secret, kind, { hkdf })
      dropPending()
      pending = { wrapKey: derived.wrapKey, kind, expiresAt: now() + RECOVERY_PENDING_MS }
      const lookupId = derived.lookupId
      derived = null
      return { lookupId }
    } finally {
      if (secret !== null) secret.fill(0)
      if (derived !== null) derived.wrapKey.fill(0)
    }
  })

  // Every failure is the same fixed error: which check failed tells an
  // attacker holding a stolen blob nothing.
  const recoveryOpen = serial(async ({ blob, member } = {}) => {
    const held = pending
    pending = null
    let opened = null
    let kp = null
    try {
      if (held === null || now() > held.expiresAt) throw usage(BAD_ENTRY)
      if (blob === null || typeof blob !== 'object' || blob.kind !== held.kind) throw usage(BAD_ENTRY)
      if (typeof member !== 'string' || !PRF_RE.test(member)) throw usage(BAD_ENTRY)
      opened = recovery.openRoot(blob, held.wrapKey, { member })
      if (opened === null || opened.member !== member) throw usage(BAD_ENTRY)
      kp = await keys.keyPairFromPrf(opened.root, { hkdf }).catch(() => null)
      if (kp === null || b4a.toString(kp.publicKey, 'hex') !== member) throw usage(BAD_ENTRY)
      let prf = ''
      for (let i = 0; i < opened.root.length; i++) prf += opened.root[i].toString(16).padStart(2, '0')
      return { prf }
    } finally {
      if (held !== null) held.wrapKey.fill(0)
      if (opened !== null) opened.root.fill(0)
      zeroPair(kp)
    }
  })

  const recoveryWrap = serial(async ({ kind, secret: secretHex } = {}) => {
    let secret = null
    let derived = null
    try {
      if (kind !== 'passkey' && kind !== 'code') throw usage('pedido inválido')
      const held = await heldRoot()
      if (kind === 'passkey') {
        secret = prfBytes(secretHex)
      } else {
        const raw = randomBytes(recovery.CODE_BYTES)
        secret = new Uint8Array(recovery.CODE_BYTES)
        secret.set(raw)
        raw.fill(0)
      }
      derived = await recovery.deriveRecoveryKeys(secret, kind, { hkdf })
      // The await above may have let a lock in: check again.
      if (root !== held) throw usage(store.LOCKED)
      const blob = recovery.wrapRoot({ root: held, member: current.publicKey, kind, wrapKey: derived.wrapKey, randomBytes })
      const out = { lookupId: derived.lookupId, blob }
      if (kind === 'code') out.code = recovery.encodeCode(secret)
      return out
    } finally {
      if (secret !== null) secret.fill(0)
      if (derived !== null) derived.wrapKey.fill(0)
    }
  })

  // Only a wrap-marked user id: a bound record without the mark would let the
  // next sign-in install that passkey's own PRF as a diary key.
  const recoveryBind = serial(async ({ credentialId, userId } = {}) => {
    await heldRoot()
    if (typeof credentialId !== 'string' || credentialId === '') throw usage('pedido inválido')
    if (typeof userId !== 'string' || !PRF_RE.test(userId) || !recovery.isWrapUserId(userId)) throw usage(BAD_WRAP_PASSKEY)
    const stored = passkeyRecord(await storage.readJson(PASSKEY_KEY))
    const rpId = stored !== null ? stored.rpId : rootRpId
    if (rpId === null) throw usage('pedido inválido')
    await bind({ v: 1, credentialId, rpId, userId })
    return {}
  })

  // Synchronous on purpose: the worklet's shutdown zeroes the secrets even
  // when a control is still running.
  function close () {
    current = null
    dropRoot()
    dropPending()
  }

  return {
    install,
    recoveryLookup,
    recoveryOpen,
    recoveryWrap,
    recoveryBind,
    close,
    clear: () => clear(),
    status: () => status(),
    reset: () => reset(),
    forget: () => forget(),
    sessionSaved: () => sessionSaved()
  }
}

module.exports = { createIdentityHost, passkeyRecord, SIGNED_OUT_KEY, PASSKEY_KEY, RECOVERY_PENDING_MS }
