/* global WebSocket, navigator, location */
// Entry of the browser node bundle (scripts/build.js writes it as
// varanda-node.js; the app's web build serves it next to the page and
// apps/app src/client/browser.js loads it). It defines ONE global:
//
//   VarandaWebNode = { version: 1, start(config) }
//   start({ association, seederUrl }) -> Promise<handle>, a frozen
//   { connect(send, { onClose }), close(), identity }:
//
//   identity.status()   -> Promise<{ exists, publicKey, legacy, unlocked, synced,
//                          webauthn, prf: 'yes'|'no'|'unknown', rpId,
//                          rpIdError?, passkeyKnown }>
//   identity.unlock({ register = false } = {})
//                       -> Promise<{ publicKey, created } | { pending: true }>
//   identity.complete() -> Promise<{ publicKey, created }>
//   identity.lock()     -> Promise   (the key is zero-filled; reads still work)
//   identity.reset()    -> Promise   (the diary and the passkey record are gone)
//
// start() opens the node over IndexedDB (database 'varanda-node') and
// returns the lib/node.js handle; nothing else of the node (session,
// storage, cores, keys) is reachable from the page.
//
// The diary's key pair is derived from the PRF output of the member's
// passkey (../lib/passkey.js) and lives only in the session's memory: it is
// never stored, and no getter or signing call hands it to the page. The kv
// entry 'passkey' holds only { v: 1, credentialId, rpId, userId } (no
// secret, no email); it is read ONCE at start() so unlock() reaches
// navigator.credentials.create/get without any await, inside the click that
// called it. unlock({ register: true }) creates a passkey; when the
// authenticator only reports PRF as enabled it resolves { pending: true }
// and complete() (a second click) fetches the PRF. created is true when the
// call ended a passkey creation. lock(), reset() and close() cancel a
// ceremony in flight (its result is zeroed and it rejects CANCELLED); one
// unlock/complete runs at a time (LOCKED). Errors carry a `.code`
// (UNSUPPORTED, NO_PRF, CANCELLED, EXISTS, WEBAUTHN, MISMATCH, LOCKED) and a
// pt-BR message; a NO_PRF from a passkey that was created anyway (register,
// or complete) also carries `.credentialId` and `.userId` (hex), and that
// passkey is excluded from the next creation; MISMATCH (the stored diary belongs to another key) also
// carries `.legacy` (a store from before the passkeys: only reset() leaves it).
//
// One node per browser profile: start() takes the exclusive Web Lock
// 'varanda-node' (ifAvailable) and holds it until close(), so a second tab
// is refused with LOCKED instead of two tabs rewriting the same diary. A
// browser without the Web Locks API runs unguarded.
const b4a = require('b4a')
const { createBrowserNode } = require('../lib/node')
const { idbNodeStorage } = require('../lib/node-storage')
const passkey = require('../lib/passkey')

const DB_NAME = 'varanda-node'
const LOCK_NAME = 'varanda-node'
const PASSKEY_KEY = 'passkey'

let current = null

function noop () {}

function codedError (code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

function lockedError () {
  return codedError('LOCKED', 'outra aba já usa o Varanda neste navegador')
}

// -> Promise<release()>; rejects LOCKED when another tab holds the lock.
function takeLock () {
  const locks = typeof navigator === 'object' && navigator !== null ? navigator.locks : undefined
  if (!locks || typeof locks.request !== 'function') return Promise.resolve(() => {})
  return new Promise((resolve, reject) => {
    locks.request(LOCK_NAME, { ifAvailable: true }, (lock) => {
      if (lock === null) {
        reject(lockedError())
        return undefined
      }
      // Held until the returned promise settles, i.e. until release().
      return new Promise((_resolve) => resolve(_resolve))
    }).catch(reject)
  })
}

// The stored passkey record, or null for anything else.
function passkeyRecord (value) {
  if (value === null || typeof value !== 'object' || value.v !== 1) return null
  if (typeof value.credentialId !== 'string' || value.credentialId === '') return null
  if (typeof value.rpId !== 'string' || value.rpId === '') return null
  const userId = typeof value.userId === 'string' ? value.userId : null
  return { v: 1, credentialId: value.credentialId, rpId: value.rpId, userId }
}

function credentialsContainer () {
  return typeof navigator === 'object' && navigator !== null && navigator.credentials ? navigator.credentials : null
}

// Synchronous: the unlock path cannot await supportStatus().
function webauthnPresent () {
  return typeof globalThis.PublicKeyCredential === 'function' && globalThis.isSecureContext === true &&
    credentialsContainer() !== null
}

function createIdentity (node, storage) {
  let rpId = null
  let rpIdError = null
  try {
    rpId = passkey.rpIdFor(typeof location === 'object' && location !== null ? location.hostname : '')
  } catch (err) {
    rpIdError = err
  }
  let known = null // the stored record, for this rp.id only
  let stored = null // the kv entry as last read or written (any rp.id)
  let pending = null // { credentialId, userId } of a creation without PRF yet
  // The passkey the person chose when the stored diary turned out to be
  // another identity's (MISMATCH): after "recomeçar" (reset) the next
  // "entrar" asks for that passkey only, not any Varanda passkey.
  let chosen = null
  // Passkeys created here that gave no usable PRF (memory only): excluded
  // from the next creation so the manager does not offer them again.
  const unusable = new Set()
  let generation = 0
  let finishing = Promise.resolve() // the post-ceremony part in flight
  let busy = false

  function invalidate () {
    generation++
  }

  // -> an Error to reject with, or null when a ceremony may start.
  function precheck () {
    if (rpIdError !== null) return rpIdError
    if (!webauthnPresent()) return codedError('UNSUPPORTED', passkey.MESSAGES.UNSUPPORTED)
    if (busy) return codedError('LOCKED', 'outra entrada com a passkey em andamento')
    return null
  }

  function cancelled () {
    return codedError('CANCELLED', passkey.MESSAGES.CANCELLED)
  }

  // Publishes the passkey of a successful unlock: the in-memory record and
  // the kv entry. Any failure (the write, or a lock/close meanwhile) puts the
  // previous record and pending creation back, in memory and in kv, so a
  // passkey that never unlocked is never remembered. A reset meanwhile has
  // already replaced both (known is no longer this record): left alone.
  async function bind (gen, record) {
    const prevKnown = known
    const prevPending = pending
    const prevStored = stored
    known = record
    pending = null
    try {
      await storage.writeJson(PASSKEY_KEY, record)
      if (gen !== generation) throw cancelled()
      stored = record
    } catch (err) {
      if (known === record) {
        known = prevKnown
        if (pending === null) pending = prevPending
        await storage.writeJson(PASSKEY_KEY, prevStored).catch(() => {})
      }
      throw err
    }
  }

  // The PRF output of a finished ceremony -> the unlocked node. Zeroes prf.
  async function finish (gen, prf, { credentialId, userId, created }) {
    let kp = null
    let installed = false
    let done = false
    try {
      if (gen !== generation) throw cancelled()
      kp = await passkey.keyPairFromPrf(prf)
      prf.fill(0)
      if (gen !== generation) throw cancelled()
      const publicKey = b4a.toString(kp.publicKey, 'hex')
      // setKeyPair copies the pair synchronously: the local copy is zeroed below.
      const setting = node.setKeyPair(kp)
      kp.secretKey.fill(0)
      kp.publicKey.fill(0)
      installed = true
      await setting
      const status = await node.identityStatus()
      if (gen !== generation) throw cancelled()
      if (status.exists && (status.publicKey !== publicKey || status.legacy)) {
        const err = codedError('MISMATCH', 'passkey não corresponde ao diário guardado')
        err.legacy = status.legacy === true
        chosen = credentialId
        throw err
      }
      if (gen !== generation) throw cancelled()
      await bind(gen, { v: 1, credentialId, rpId, userId })
      chosen = null
      done = true
      return { publicKey, created }
    } finally {
      // Any failure after the pair went in leaves the node locked.
      if (installed && !done) await node.clearKeyPair().catch(() => {})
      prf.fill(0)
      if (kp !== null) {
        kp.secretKey.fill(0)
        kp.publicKey.fill(0)
      }
    }
  }

  // Runs one ceremony: `ceremony()` must call navigator.credentials first
  // thing (the ../lib/passkey.js functions do), so nothing here awaits
  // before it.
  async function run (ceremony, after) {
    const err = precheck()
    if (err !== null) throw err
    busy = true
    const gen = generation
    try {
      const result = await ceremony(credentialsContainer())
      if (gen !== generation) {
        if (result.prf) result.prf.fill(0)
        throw cancelled()
      }
      const settling = Promise.resolve(after(gen, result))
      finishing = settling.then(noop, noop)
      return await settling
    } finally {
      busy = false
    }
  }

  function excluded () {
    const ids = new Set(unusable)
    if (known !== null) ids.add(known.credentialId)
    if (pending !== null) ids.add(pending.credentialId)
    return [...ids]
  }

  // A NO_PRF from a passkey that now exists in the manager: remember it and
  // name it on the error (the page tells the person which one to delete,
  // label 'Varanda ' + userId.slice(0, 6)).
  function noteUnusable (err, credentialId, userId) {
    if (!err || err.code !== 'NO_PRF' || typeof credentialId !== 'string') return err
    unusable.add(credentialId)
    if (pending !== null && pending.credentialId === credentialId) pending = null
    err.credentialId = credentialId
    err.userId = userId
    return err
  }

  function unlock ({ register = false } = {}) {
    if (register) {
      return run(
        (credentials) => passkey.register(credentials, { rpId, excludeCredentialIds: excluded() }),
        async (gen, result) => {
          // A pending creation this one replaces can no longer be completed
          // here: its passkey is orphaned in the manager, never offered again.
          const superseded = pending !== null && pending.credentialId !== result.credentialId ? pending.credentialId : null
          if (result.pending === true) {
            pending = { credentialId: result.credentialId, userId: result.userId }
            if (superseded !== null) unusable.add(superseded)
            return { pending: true }
          }
          const out = await finish(gen, result.prf, { credentialId: result.credentialId, userId: result.userId, created: true })
          if (superseded !== null) unusable.add(superseded)
          return out
        }).catch((err) => { throw noteUnusable(err, err && err.credentialId, err && err.userId) })
    }
    return run(
      (credentials) => passkey.signIn(credentials, { rpId, allowCredentialIds: known ? [known.credentialId] : (chosen ? [chosen] : []) }),
      (gen, result) => {
        const userId = result.userHandle !== null
          ? result.userHandle
          : (known && known.credentialId === result.credentialId ? known.userId : null)
        return finish(gen, result.prf, { credentialId: result.credentialId, userId, created: false })
      }).catch((err) => {
      // A chosen passkey without PRF: name it like a fresh one (userId from
      // its userHandle, or the stored record when it is that passkey).
      const id = err && err.credentialId
      const userId = err && err.userId ? err.userId : (known && known.credentialId === id ? known.userId : null)
      throw noteUnusable(err, id, userId)
    })
  }

  function complete () {
    if (pending === null) return Promise.reject(codedError('CANCELLED', 'nenhuma criação de passkey pendente'))
    const target = pending
    return run(
      (credentials) => passkey.completeRegistration(credentials, { rpId, credentialId: target.credentialId }),
      (gen, result) => finish(gen, result.prf, { credentialId: result.credentialId, userId: target.userId, created: true }))
      .catch((err) => { throw noteUnusable(err, target.credentialId, target.userId) })
  }

  async function status () {
    const [stored, support] = await Promise.all([node.identityStatus(), passkey.supportStatus(globalThis)])
    const out = {
      ...stored,
      webauthn: support.webauthn && rpIdError === null && credentialsContainer() !== null,
      prf: support.prf,
      rpId,
      passkeyKnown: known !== null
    }
    if (rpIdError !== null) out.rpIdError = rpIdError.message
    return out
  }

  function lock () {
    invalidate()
    return node.clearKeyPair()
  }

  async function reset () {
    invalidate()
    known = null
    pending = null
    stored = null
    await node.reset()
    // readJson parses the stored 'null' back to null: no record.
    await storage.writeJson(PASSKEY_KEY, null)
  }

  return {
    // Reads the stored record once; the ceremonies use this copy.
    async load () {
      stored = await storage.readJson(PASSKEY_KEY)
      const record = passkeyRecord(stored)
      known = record !== null && record.rpId === rpId ? record : null
    },
    invalidate,
    // Resolves once a ceremony's post-WebAuthn part (key, diary check, kv
    // record or its restore) has settled; never waits on the browser.
    settled: () => finishing,
    api: Object.freeze({ status, unlock, complete, lock, reset })
  }
}

async function start ({ association, seederUrl } = {}) {
  if (current !== null) await current.close()
  const release = await takeLock()
  let storage = null
  let node = null
  try {
    storage = await idbNodeStorage(DB_NAME)
    node = createBrowserNode({
      storage,
      association,
      seederUrl,
      createSocket: (url) => new WebSocket(url)
    })
    const identity = createIdentity(node, storage)
    await identity.load()
    let closing = null
    const handle = Object.freeze({
      connect: (send, options) => node.connect(send, options),
      close () {
        if (closing !== null) return closing
        identity.invalidate()
        closing = identity.settled().then(() => node.close()).finally(() => {
          release()
          if (current === handle) current = null
        })
        return closing
      },
      identity: identity.api
    })
    current = handle
    return handle
  } catch (err) {
    if (node !== null) await node.close().catch(() => {})
    else if (storage !== null) await storage.close().catch(() => {})
    release()
    throw err
  }
}

globalThis.VarandaWebNode = Object.freeze({ version: 1, start })
