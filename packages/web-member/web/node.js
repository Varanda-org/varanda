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
//                          webauthn, prf, hybrid, platform, signal (each
//                          'yes'|'no'|'unknown'), rpId, rpIdError?,
//                          passkeyKnown, resumed, pending,
//                          refused: [{ userId, code, cleaned, created }] }>
//   identity.unlock({ register = false, any = false, phone = false } = {})
//                       -> Promise<{ publicKey, created, sessionSaved? } | { pending: true }>
//   identity.complete() -> Promise<{ publicKey, created, sessionSaved? }>
//   identity.lock()     -> Promise   (the keys are zero-filled; reads still
//                                     work; the stored session SURVIVES it)
//   identity.signOut()  -> Promise   ('Sair': lock AND forget the stored
//                                     session; rejects SIGNOUT_INCOMPLETE when
//                                     it could not be deleted, still locked)
//   identity.reset()    -> Promise   (the diary, the passkey record and the
//                                     stored session are gone)
//   media.upload({ bytes, mime, width, height, sealed, onProgress })
//                       -> Promise<descriptor>  (lib/node.js mediaUpload;
//                          errors keep their .code and .message)
//   media.putDm({ bytes, mime, width, height })
//                       -> Promise<media item>  (lib/node.js dmPutMedia: the
//                          photo sealed and put on the blob channel; the item
//                          goes back unchanged in dm.send `media`)
//   media.readDm({ from, id, index })
//                       -> Promise<{ bytes, mime }>  (lib/node.js dmReadMedia:
//                          the opened photo of a kept message; errors keep
//                          .code and .message, 'mídia indisponível' when gone)
//   media.readGroup({ diary, item })
//                       -> Promise<{ bytes, mime, w, h }>  (lib/node.js
//                          groupReadMedia: a private group item fetched from
//                          the node's own seeder and opened; 'mídia
//                          indisponível' on any failure)
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
// (UNSUPPORTED, NO_PRF, NOT_SYNCED, CANCELLED, EXISTS, WEBAUTHN, MISMATCH,
// LOCKED) and a pt-BR message; a NO_PRF or NOT_SYNCED from a passkey that
// exists anyway also carries `.credentialId` and `.userId` (hex), and that
// passkey is excluded from every later creation; when the create ceremony of
// this page load refused it (never at 'concluir' or at sign-in, when it may
// already be an identity elsewhere) the browser is asked to drop it
// (passkey.forgetCredential) and `.cleaned` says whether that call went
// through (not that the passkey is gone). MISMATCH (the stored
// diary belongs to another key) also carries `.legacy` (a store from before
// the passkeys: only reset() leaves it).
// unlock({ any: true }) signs in with any Varanda passkey (a discoverable
// get), for a stored record whose passkey is gone; unlock({ phone: true })
// narrows the hints to ['hybrid'] (the phone QR) for that call only.
// The kv entry 'passkeyAttempts' ({ v: 1, rpId, pending, refused }, no
// secret) keeps the pending creation and the refused passkeys across
// reloads: refused ids stay excluded from creation, never from sign-in,
// except a creation of this page refused NOT_SYNCED (it never signs in). A
// sign-in with another passkey moves the pending creation to SUPERSEDED.
// Each refused entry says whether this page created it (`created`). A new
// creation replaces a pending one only once it is bound; if its install
// fails, the old pending stays and the new id is refused INSTALL_FAILED.
// reset() drops it; signOut() keeps it.
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
const PASSKEY_ATTEMPTS_KEY = 'passkeyAttempts'
const REFUSED_MAX = 32
const PHONE_HINTS = ['hybrid']
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

function nonEmptyString (value) {
  return typeof value === 'string' && value !== ''
}

// The check passkey.fromBase64Url applies: a stored id that fails it would
// make every later creation (its excludeCredentials) throw before WebAuthn
// until a reset, so the loader drops it.
function credentialIdOk (value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value) && value.length % 4 !== 1
}

// A passkey this page created and refused as bound to one device: only its
// entry keeps it from signing in, so the cap and reset() never drop it.
function isDeviceBound (e) {
  return e.code === 'NOT_SYNCED' && e.created === true
}

// Caps refused at REFUSED_MAX, evicting the oldest other entries first.
// Device-bound entries are never evicted, even past the cap: each one took a
// creation by the person, so the list stays small.
function capRefused (refused) {
  if (refused.length <= REFUSED_MAX) return refused
  const bound = refused.filter(isDeviceBound).length
  if (bound >= REFUSED_MAX) return refused.filter(isDeviceBound)
  let drop = refused.length - REFUSED_MAX
  return refused.filter((e) => {
    if (drop > 0 && !isDeviceBound(e)) {
      drop--
      return false
    }
    return true
  })
}

// The stored attempts record for this rp.id -> { pending, refused }; a record
// for another rp.id, or anything malformed, reads as empty.
function attemptsRecord (value, rpId) {
  const empty = { pending: null, refused: [] }
  if (value === null || typeof value !== 'object' || value.v !== 1 || value.rpId !== rpId) return empty
  let pending = null
  const p = value.pending
  if (p !== null && typeof p === 'object' && credentialIdOk(p.credentialId)) {
    pending = { credentialId: p.credentialId, userId: typeof p.userId === 'string' ? p.userId : null, phone: p.phone === true }
  }
  const refused = []
  if (Array.isArray(value.refused)) {
    for (const e of value.refused) {
      if (e === null || typeof e !== 'object' || !credentialIdOk(e.credentialId) || !nonEmptyString(e.code)) continue
      // An entry from before `created` existed reads as not created here.
      refused.push({ credentialId: e.credentialId, userId: typeof e.userId === 'string' ? e.userId : null, code: e.code, cleaned: e.cleaned === true, created: e.created === true })
    }
  }
  return { pending, refused: capRefused(refused) }
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
  // { credentialId, userId, phone } of a creation without PRF yet, and the
  // passkeys Varanda refused ({ credentialId, userId, code, cleaned, created }): both
  // mirrored in kv 'passkeyAttempts' so a reload still excludes them.
  let pending = null
  let refused = []
  // The passkey the person chose when the stored diary turned out to be
  // another identity's (MISMATCH): after "recomeçar" (reset) the next
  // "entrar" asks for that passkey only, not any Varanda passkey.
  let chosen = null
  // Credential ids register() returned since this start(): only those may be
  // dropped from the manager, never one restored from kv after a reload.
  const createdHere = new Set()
  let persisting = Promise.resolve()
  let generation = 0
  let resets = 0 // reset() emptied pending and refused (but device-bound): never refill them
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

  // Writes the current attempts (null when there are none) after any write
  // already queued. Never rejects: a failed write keeps the memory copy.
  function persist () {
    persisting = persisting.then(() => {
      const value = pending === null && refused.length === 0
        ? null
        : { v: 1, rpId, pending, refused }
      return storage.writeJson(PASSKEY_ATTEMPTS_KEY, value)
    }).catch(noop)
    return persisting
  }

  function addRefused (entry) {
    // A device-bound refusal is never downgraded: a later NO_PRF (or any other
    // code) for the same passkey would otherwise let it sign in once the
    // manager starts returning PRF, binding the account to one device.
    const prev = refused.find((e) => e.credentialId === entry.credentialId)
    if (prev && prev.code === 'NOT_SYNCED' && prev.created === true) {
      entry = { ...entry, userId: typeof entry.userId === 'string' && entry.userId !== '' ? entry.userId : prev.userId, code: 'NOT_SYNCED', created: true, cleaned: prev.cleaned === true || entry.cleaned === true }
    }
    refused = refused.filter((e) => e.credentialId !== entry.credentialId)
    refused.push(entry)
    refused = capRefused(refused)
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
      refused = refused.filter((e) => e.credentialId !== record.credentialId)
      // Unlocking with another passkey orphans the pending creation: keep it
      // refused (excluded from creation, named for deletion) instead of
      // forgetting it was made here.
      if (prevPending !== null && prevPending.credentialId !== record.credentialId) {
        addRefused({ credentialId: prevPending.credentialId, userId: prevPending.userId, code: 'SUPERSEDED', cleaned: false, created: true })
      }
      await persist()
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
  // `onFail` (the refusal bookkeeping: refused entry, persist, drop request)
  // runs inside the locked section, so a new ceremony is LOCKED until it has
  // settled and no overlapping persist can commit a transient state. The
  // ceremony itself still starts before the first await (user activation).
  async function run (ceremony, after, onFail) {
    const err = precheck()
    if (err !== null) throw err
    busy = true
    const gen = generation
    try {
      try {
        const result = await ceremony(credentialsContainer())
        if (gen !== generation) {
          if (result.prf) result.prf.fill(0)
          throw cancelled()
        }
        const settling = Promise.resolve(after(gen, result))
        finishing = settling.then(noop, noop)
        return await settling
      } catch (failure) {
        if (typeof onFail !== 'function') throw failure
        const noting = Promise.resolve().then(() => onFail(failure))
        finishing = noting.then(noop, noop)
        throw await noting
      }
    } finally {
      busy = false
    }
  }

  function excluded () {
    const ids = new Set(refused.map((e) => e.credentialId))
    if (known !== null) ids.add(known.credentialId)
    if (pending !== null) ids.add(pending.credentialId)
    return [...ids]
  }

  // A NO_PRF or NOT_SYNCED from a passkey that now exists in the manager:
  // remember it as refused and name it on the error (the page tells the
  // person which one it was, label 'Varanda ' + userId.slice(0, 6)). Only
  // the create ceremony itself (mayDrop) asks the manager to drop it: later
  // the passkey may be an identity elsewhere. `created` (a
  // creation by this page, even before a reload) is kept on the entry: the
  // screen names for deletion only passkeys Varanda made.
  async function noteUnusable (err, credentialId, userId, mayDrop, created, epoch) {
    if (!err || (err.code !== 'NO_PRF' && err.code !== 'NOT_SYNCED') || typeof credentialId !== 'string') return err
    // A reset since the ceremony began emptied pending and refused: never
    // refill them with a passkey from before it.
    if (epoch !== resets) return err
    // The pending creation, or a passkey already recorded as made here, was
    // created by this page even when it fails at sign-in.
    const madeHere = created === true ||
      (pending !== null && pending.credentialId === credentialId) ||
      refused.some((e) => e.credentialId === credentialId && e.created)
    const entry = { credentialId, userId: typeof userId === 'string' ? userId : null, code: err.code, cleaned: false, created: madeHere }
    addRefused(entry)
    if (pending !== null && pending.credentialId === credentialId) pending = null
    err.credentialId = credentialId
    err.userId = userId
    await persist()
    const isKnown = known !== null && known.credentialId === credentialId
    if (mayDrop === true && createdHere.has(credentialId) && !isKnown) {
      entry.cleaned = (await passkey.forgetCredential(globalThis, { rpId, credentialId })) === true
      err.cleaned = entry.cleaned
      if (entry.cleaned) await persist()
    }
    return err
  }

  function unlock ({ register = false, any = false, phone = false } = {}) {
    const hints = phone === true ? PHONE_HINTS : undefined
    const epoch = resets
    if (register) {
      let deviceBound = null
      // Ids this request asks the manager to leave alone (the stored, the
      // pending and every refused passkey, any of which may be an account
      // somewhere): if an authenticator ignores the list and hands one back,
      // it is never treated as made here, so it is never asked to be dropped.
      const excludedNow = excluded()
      const wasExcluded = new Set(excludedNow)
      return run(
        (credentials) => passkey.register(credentials, { rpId, excludeCredentialIds: excludedNow, hints }),
        async (gen, result) => {
          const bound = refused.find((e) => e.credentialId === result.credentialId && isDeviceBound(e))
          if (bound !== undefined) {
            // An authenticator that ignored excludeCredentials handed back a
            // passkey refused here as bound to one device, whose data no
            // longer says so: it never becomes an identity, and its entry stays.
            if (result.prf) result.prf.fill(0)
            deviceBound = codedError('NOT_SYNCED', passkey.MESSAGES.NOT_SYNCED)
            deviceBound.credentialId = result.credentialId
            // The stored entry names the passkey's own user handle; the
            // creation's user id is the one this request asked for.
            deviceBound.userId = bound.userId !== null ? bound.userId : result.userId
            deviceBound.cleaned = false
            throw deviceBound
          }
          if (!wasExcluded.has(result.credentialId)) createdHere.add(result.credentialId)
          // A pending creation this one replaces can no longer be completed
          // here: its passkey is orphaned in the manager, never offered again.
          const old = pending !== null && pending.credentialId !== result.credentialId ? pending : null
          const supersede = () => addRefused({ credentialId: old.credentialId, userId: old.userId, code: 'SUPERSEDED', cleaned: false, created: true })
          if (result.pending === true) {
            if (old !== null) supersede()
            pending = { credentialId: result.credentialId, userId: result.userId, phone: phone === true }
            await persist()
            // A lock/signOut/reset during the write: the caller must not be
            // told to 'concluir' (reset already dropped this pending).
            if (gen !== generation) throw cancelled()
            return { pending: true }
          }
          if (old === null) return finish(gen, result.prf, { credentialId: result.credentialId, userId: result.userId, created: true })
          // The old pending is replaced only once the new passkey is bound:
          // until then 'concluir' must still reach it.
          try {
            const out = await finish(gen, result.prf, { credentialId: result.credentialId, userId: result.userId, created: true })
            supersede()
            await persist()
            return out
          } catch (err) {
            if (epoch === resets) {
              if (known !== null && known.credentialId === result.credentialId) {
                // Bound, then cancelled while saving the session: the old
                // pending is gone for good.
                supersede()
              } else {
                addRefused({ credentialId: result.credentialId, userId: result.userId, code: 'INSTALL_FAILED', cleaned: false, created: true })
              }
              await persist()
            }
            throw err
          }
        },
        async (err) => {
          if (err === deviceBound) return err
          const id = err && err.credentialId
          // A handed-back excluded id was not made by this request: it may be
          // an account, so it is neither dropped nor named as made here.
          const madeNow = typeof id === 'string' && !wasExcluded.has(id)
          if (madeNow && (err.code === 'NO_PRF' || err.code === 'NOT_SYNCED')) createdHere.add(id)
          if (err && typeof id === 'string' && !madeNow) err.created = false
          return noteUnusable(err, id, err && err.userId, true, madeNow, epoch)
        })
    }
    const allow = any === true ? [] : (known ? [known.credentialId] : (chosen ? [chosen] : []))
    let deviceBound = null
    return run(
      (credentials) => passkey.signIn(credentials, { rpId, allowCredentialIds: allow, hints }),
      (gen, result) => {
        const bound = refused.find((e) => e.credentialId === result.credentialId && e.code === 'NOT_SYNCED' && e.created)
        if (bound !== undefined) {
          // This page created it and refused it as bound to one device: it
          // never became an identity, so signing in with it must not make it
          // one. Passkeys made elsewhere keep signing in.
          result.prf.fill(0)
          deviceBound = codedError('NOT_SYNCED', passkey.MESSAGES.NOT_SYNCED)
          deviceBound.credentialId = result.credentialId
          deviceBound.userId = result.userHandle !== null ? result.userHandle : bound.userId
          deviceBound.cleaned = false
          throw deviceBound
        }
        const userId = result.userHandle !== null
          ? result.userHandle
          : (known && known.credentialId === result.credentialId ? known.userId : null)
        return finish(gen, result.prf, { credentialId: result.credentialId, userId, created: false })
      },
      async (err) => {
        if (err === deviceBound) return err
        // A chosen passkey without PRF: name it like a fresh one (userId from
        // its userHandle, or the stored record when it is that passkey). It is
        // refused for creation only, and never dropped from the manager.
        const id = err && err.credentialId
        const userId = err && err.userId ? err.userId : (known && known.credentialId === id ? known.userId : null)
        return noteUnusable(err, id, userId, false, false, epoch)
      })
  }

  function complete () {
    if (pending === null) return Promise.reject(codedError('CANCELLED', 'nenhuma criação de passkey pendente'))
    const target = pending
    const epoch = resets
    const hints = target.phone === true ? PHONE_HINTS : undefined
    return run(
      (credentials) => passkey.completeRegistration(credentials, { rpId, credentialId: target.credentialId, hints }),
      (gen, result) => finish(gen, result.prf, { credentialId: result.credentialId, userId: target.userId, created: true }),
      // Never dropped from the manager: between creation and 'concluir' the
      // synced passkey may already have become the account on another device.
      (err) => noteUnusable(err, target.credentialId, target.userId, false, true, epoch))
  }

  async function status () {
    const [stored, support] = await Promise.all([node.identityStatus(), passkey.supportStatus(globalThis)])
    const out = {
      ...stored,
      webauthn: support.webauthn && rpIdError === null && credentialsContainer() !== null,
      prf: support.prf,
      rpId,
      hybrid: support.hybrid,
      platform: support.platform,
      signal: support.signal,
      passkeyKnown: known !== null,
      resumed: resumed && stored.unlocked === true,
      pending: pending !== null,
      refused: refused.map(({ userId, code, cleaned, created }) => ({ userId, code, cleaned, created }))
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
    // Stale answers of a ceremony in flight are cancelled at once. Then the
    // attempts record goes first, and its failure is reported: a reset that
    // cannot forget the refused passkeys leaves them, the record and the
    // unlocked node as they were. Device-bound refusals stay: they describe
    // this browser's password managers, not the account, and only they keep
    // such a passkey from signing in.
    invalidate()
    const kept = refused.filter(isDeviceBound)
    const clearing = persisting.then(() => storage.writeJson(PASSKEY_ATTEMPTS_KEY, kept.length === 0 ? null : { v: 1, rpId, pending: null, refused: kept }))
    persisting = clearing.catch(noop)
    await clearing
    resets++
    resumed = false
    known = null
    pending = null
    refused = kept
    stored = null
    await finishing
    const forgotten = await forgetSignedOut()
    await node.reset()
    // readJson parses the stored 'null' back to null: no record.
    await storage.writeJson(PASSKEY_KEY, null)
    // Only the kept device-bound refusals remain (null when none).
    await persist()
    if (!forgotten) throw incomplete()
  }

  return {
    // Reads the stored record once; the ceremonies use this copy.
    async load () {
      stored = await storage.readJson(PASSKEY_KEY)
      const record = passkeyRecord(stored)
      known = record !== null && record.rpId === rpId ? record : null
      const attempts = attemptsRecord(await storage.readJson(PASSKEY_ATTEMPTS_KEY), rpId)
      pending = attempts.pending
      refused = attempts.refused
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
        },
        // Synchronous too: the node copies the photo before any await.
        putDm (args) {
          try {
            return Promise.resolve(node.dmPutMedia(args))
          } catch (err) {
            return Promise.reject(err)
          }
        },
        readDm (args) {
          try {
            return Promise.resolve(node.dmReadMedia(args))
          } catch (err) {
            return Promise.reject(err)
          }
        },
        readGroup (args) {
          try {
            return Promise.resolve(node.groupReadMedia(args))
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
