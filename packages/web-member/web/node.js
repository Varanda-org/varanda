/* global WebSocket, navigator, location */
// Entry of the browser node bundle (scripts/build.js writes it as
// varanda-node.js; the app's web build serves it next to the page and
// apps/app src/client/browser.js loads it). It defines ONE global:
//
//   VarandaWebNode = { version: 1, start(config) }
//   start({ association, seederUrl }) -> Promise<handle>, a frozen
//   { connect(send, { onClose }), close(), identity, media, follows }:
//
//   identity.status()   -> Promise<{ exists, publicKey, legacy, unlocked, synced,
//                          webauthn, prf: 'yes'|'no'|'unknown', rpId,
//                          rpIdError?, passkeyKnown, resumed }>
//   identity.unlock({ register = false } = {})
//                       -> Promise<{ publicKey, created, sessionSaved? } | { pending: true }>
//   identity.complete() -> Promise<{ publicKey, created, sessionSaved? }>
//   identity.lock()     -> Promise   (the keys are zero-filled; reads still
//                                     work; the stored session SURVIVES it)
//   identity.signOut()  -> Promise   ('Sair': lock AND forget the stored
//                                     session; rejects SIGNOUT_INCOMPLETE when
//                                     it could not be deleted, still locked)
//   identity.reset()    -> Promise   (the diary, the passkey record and the
//                                     stored session are gone)
//   media.upload({ bytes, mime, width, height, onProgress })
//                       -> Promise<descriptor>  (lib/node.js mediaUpload;
//                          errors keep their .code and .message)
//   follows.legacy()    -> Promise<{ keys }>  (the follows kept from before
//                          `follow` records existed, awaiting confirmation)
//   follows.confirmLegacy(keys)
//                       -> Promise<{ published }>  (publishes exactly those;
//                          the rest leave the list; errors keep .code)
//
// start() opens the node over IndexedDB (database 'varanda-node') and
// returns the lib/node.js handle; nothing else of the node (session,
// storage, cores, keys) is reachable from the page.
//
// The diary's key pair is derived from the PRF output of the member's
// passkey (../lib/passkey.js) and lives only in the session's memory: it is
// never stored, and no getter or signing call hands it to the page. The
// media key pair (the signer of this DEVICE's media cores) comes from the
// same PRF output and a random 32-byte nonce drawn once per device and kept
// in kv 'mediaDevice' ({ v: 1, nonce }, not a secret: useless without the
// PRF output); it lives in the session's memory beside the identity pair and
// is zeroed with it. A reset forgets the nonce, so the next identity's media
// cores have new keys. The kv
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
// Stay signed in until 'Sair': after a successful unlock (and only then: a
// MISMATCH or any other failure saves nothing) the 32-byte PRF output is
// kept by ../lib/session-store.js in its own IndexedDB database
// ('varanda-session'), sealed with AES-GCM-256 under a non-extractable
// CryptoKey and bound to this rp.id and the identity's public key. start()
// reopens it, with no WebAuthn call, when the stored passkey record is for
// this rp.id, the stored diary exists (not legacy) and the stored session
// names the same passkey and public key; then status().resumed is true.
// Anything else (another passkey, a tampered record, a key that does not
// open the diary) clears the stored session and leaves the node locked;
// start() never fails because of it. What this protects: no secret is on
// disk in clear, and a copied record opens nowhere else. What it does NOT:
// a script on this origin can use the stored CryptoKey and so act as the
// member, and anyone holding the unlocked device (or the browser profile)
// can post until 'Sair'. signOut() ('Sair') and reset() erase it; lock()
// does not (a memory-only lock, the next start() resumes). A failure to save
// still unlocks: the result then carries sessionSaved: false.
// Two independent barriers make 'Sair' stick: signOut() and reset() first
// write the kv marker 'signedOut' (node storage), which makes start() refuse
// (and clear again) any stored session until the next successful ceremony
// saves a new one; then they delete the record (sessionStore.clear(), and
// failing that the whole 'varanda-session' database). When both deletions
// fail they reject SIGNOUT_INCOMPLETE ('não foi possível sair por completo
// neste aparelho: tente de novo'); the node is locked either way.
//
// One node per browser profile: start() takes the exclusive Web Lock
// 'varanda-node' (ifAvailable) and holds it until close(), so a second tab
// is refused with LOCKED instead of two tabs rewriting the same diary. A
// browser without the Web Locks API runs unguarded.
const b4a = require('b4a')
const { createBrowserNode } = require('../lib/node')
const { idbNodeStorage } = require('../lib/node-storage')
const passkey = require('../lib/passkey')
const store = require('../lib/node-store')
const { createSessionStore } = require('../lib/session-store')

const DB_NAME = 'varanda-node'
const LOCK_NAME = 'varanda-node'
const PASSKEY_KEY = 'passkey'
const NONCE_BYTES = 32
const SIGNED_OUT_KEY = 'signedOut'
const SESSION_DB = 'varanda-session'

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

function zeroPair (kp) {
  if (kp === null) return
  kp.secretKey.fill(0)
  kp.publicKey.fill(0)
}

// -> true once the database is deleted; false on an error, a block (another
// connection holds it) or no IndexedDB.
function deleteDatabase (idb, name) {
  return new Promise((resolve) => {
    let req
    try {
      req = idb.deleteDatabase(name)
    } catch {
      resolve(false)
      return
    }
    req.onsuccess = () => resolve(true)
    req.onerror = () => resolve(false)
    req.onblocked = () => resolve(false)
  })
}

function createIdentity (node, storage, sessionStore, idb) {
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
  let finishing = Promise.resolve() // the post-ceremony part (or the resume) in flight
  let busy = false
  let resumed = false // the current unlock came from the stored session

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

  // This device's media nonce (kv 'mediaDevice'), drawn and written once.
  async function mediaNonce () {
    const device = await store.readMediaDevice(storage)
    if (device !== null) return new Uint8Array(b4a.from(device.nonce, 'hex'))
    const nonce = new Uint8Array(NONCE_BYTES)
    globalThis.crypto.getRandomValues(nonce)
    await store.writeMediaDevice(storage, b4a.toString(nonce, 'hex'))
    return nonce
  }

  // A PRF output -> the unlocked node, for a finished ceremony (resumed
  // false: the passkey record is bound) and for the stored session (resumed
  // true). Saves the session only once everything else succeeded; any
  // failure leaves the node locked. Zeroes prf.
  async function install (gen, prf, { credentialId, userId, created, resumed: fromSession }) {
    let kp = null
    let media = null
    let nonce = null
    let installed = false
    let done = false
    try {
      if (gen !== generation) throw cancelled()
      kp = await passkey.keyPairFromPrf(prf)
      if (gen !== generation) throw cancelled()
      nonce = await mediaNonce()
      media = await passkey.mediaKeyPairFromPrf(prf, nonce)
      if (gen !== generation) throw cancelled()
      const publicKey = b4a.toString(kp.publicKey, 'hex')
      // setKeyPair copies both pairs and the PRF (group writer keys derive
      // from it) synchronously: the local copies are zeroed below.
      const setting = node.setKeyPair(kp, { media, prf })
      zeroPair(kp)
      zeroPair(media)
      installed = true
      await setting
      const status = await node.identityStatus()
      if (gen !== generation) throw cancelled()
      if (status.exists && (status.publicKey !== publicKey || status.legacy)) {
        const err = codedError('MISMATCH', 'passkey não corresponde ao diário guardado')
        err.legacy = status.legacy === true
        if (!fromSession) chosen = credentialId
        throw err
      }
      if (gen !== generation) throw cancelled()
      if (!fromSession) {
        await bind(gen, { v: 1, credentialId, rpId, userId })
        chosen = null
      }
      let sessionSaved = true
      try {
        await sessionStore.save(prf, { rpId, credentialId, publicKey })
      } catch {
        sessionSaved = false
      }
      // A ceremony that saved a new session lifts the sign-out barrier (a
      // failed save keeps it: an older record may still be there).
      if (!fromSession && sessionSaved) await storage.writeJson(SIGNED_OUT_KEY, null).catch(() => {})
      // A lock/signOut/reset during the save: still locked (signOut and
      // reset wait for this to settle before they clear the stored session).
      if (gen !== generation) throw cancelled()
      resumed = fromSession === true
      done = true
      const out = { publicKey, created }
      if (!sessionSaved) out.sessionSaved = false
      return out
    } finally {
      // Any failure after the pairs went in leaves the node locked.
      if (installed && !done) await node.clearKeyPair().catch(() => {})
      prf.fill(0)
      if (nonce !== null) nonce.fill(0)
      zeroPair(kp)
      zeroPair(media)
    }
  }

  // The PRF output of a finished ceremony -> the unlocked node. Zeroes prf.
  function finish (gen, prf, details) {
    return install(gen, prf, { ...details, resumed: false })
  }

  // start(): reopens the stored session without WebAuthn, when it names the
  // stored passkey and the stored diary's key. Never rejects; any failure
  // clears the stored session and leaves the node locked.
  async function resume () {
    if (known === null) return
    const gen = generation
    busy = true
    const attempt = (async () => {
      let opened = null
      try {
        const mark = await storage.readJson(SIGNED_OUT_KEY)
        if (mark !== null && mark !== undefined) {
          // Signed out: whatever record survived is never used.
          await forgetSession()
          return
        }
        const status = await node.identityStatus()
        if (!status.exists || status.legacy || typeof status.publicKey !== 'string') return
        opened = await sessionStore.load({ rpId, publicKey: status.publicKey })
        if (opened === null) return
        if (gen !== generation || known === null || opened.credentialId !== known.credentialId) {
          throw cancelled()
        }
        const prf = opened.prf
        opened = null
        await install(gen, prf, { credentialId: known.credentialId, userId: known.userId, created: false, resumed: true })
      } catch {
        if (opened !== null) opened.prf.fill(0)
        await sessionStore.clear().catch(() => {})
      }
    })()
    finishing = attempt.then(noop, noop)
    try {
      await attempt
    } finally {
      busy = false
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
      passkeyKnown: known !== null,
      resumed: resumed && stored.unlocked === true
    }
    if (rpIdError !== null) out.rpIdError = rpIdError.message
    return out
  }

  // A memory-only lock: the stored session survives it (the next start()
  // resumes). 'Sair' is signOut().
  function lock () {
    invalidate()
    resumed = false
    return node.clearKeyPair()
  }

  // Deletes the stored session: the record, or failing that the database.
  // -> true when one of them is gone.
  async function forgetSession () {
    try {
      await sessionStore.clear()
      return true
    } catch {}
    if (idb === undefined || idb === null) return false
    return deleteDatabase(idb, SESSION_DB)
  }

  // The barrier first, then the record.
  async function forgetSignedOut () {
    await storage.writeJson(SIGNED_OUT_KEY, { v: 1 }).catch(() => {})
    return forgetSession()
  }

  function incomplete () {
    return codedError('SIGNOUT_INCOMPLETE', 'não foi possível sair por completo neste aparelho: tente de novo')
  }

  // 'Sair': lock and forget the stored session. The node is locked even when
  // the session store fails; then it rejects SIGNOUT_INCOMPLETE.
  async function signOut () {
    invalidate()
    resumed = false
    let forgotten = false
    try {
      // A post-ceremony part in flight may still save: let it settle first.
      await finishing
      forgotten = await forgetSignedOut()
    } finally {
      await node.clearKeyPair()
    }
    if (!forgotten) throw incomplete()
  }

  async function reset () {
    invalidate()
    resumed = false
    known = null
    pending = null
    stored = null
    await finishing
    const forgotten = await forgetSignedOut()
    await node.reset()
    // readJson parses the stored 'null' back to null: no record.
    await storage.writeJson(PASSKEY_KEY, null)
    if (!forgotten) throw incomplete()
  }

  return {
    // Reads the stored record once; the ceremonies use this copy.
    async load () {
      stored = await storage.readJson(PASSKEY_KEY)
      const record = passkeyRecord(stored)
      known = record !== null && record.rpId === rpId ? record : null
    },
    resume,
    invalidate,
    // Resolves once a ceremony's post-WebAuthn part (key, diary check, kv
    // record or its restore, session save) or the resume has settled; never
    // waits on the browser.
    settled: () => finishing,
    api: Object.freeze({ status, unlock, complete, lock, signOut, reset })
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
      createSocket: (url) => new WebSocket(url),
      // Lease off (lib/session.js header, docs/rpc.md 6.1): a visible hosted
      // page keeps its seeder link; the app stops it when the tab is hidden.
      // The lease stays as an escape hatch for seeder capacity.
      leaseHoldMs: 0
    })
    const sessionStore = createSessionStore({ indexedDB: globalThis.indexedDB, crypto: globalThis.crypto })
    const identity = createIdentity(node, storage, sessionStore, globalThis.indexedDB)
    await identity.load()
    await identity.resume()
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
      identity: identity.api,
      media: Object.freeze({
        // Called synchronously so the node copies the bytes at once.
        upload (args) {
          try {
            return Promise.resolve(node.mediaUpload(args))
          } catch (err) {
            return Promise.reject(err)
          }
        }
      }),
      // The follows kept from before `follow` records existed: listed, and
      // published only for the keys the person confirms (lib/node.js).
      follows: Object.freeze({
        legacy: () => node.legacyFollows(),
        confirmLegacy (keys) {
          try {
            return Promise.resolve(node.confirmLegacyFollows(keys))
          } catch (err) {
            return Promise.reject(err)
          }
        }
      })
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
