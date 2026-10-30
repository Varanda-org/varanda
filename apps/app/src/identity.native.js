// The handle's `identity` API (docs/rpc.md section 11: status, unlock,
// complete, lock, signOut, reset) for the in-app web node. The host runs the
// passkey ceremony itself (modules/passkey-prf: Android Credential Manager,
// iOS AuthenticationServices) with the same rp.id (the installation hostname)
// and PRF input as the web (src/passkeyOptions.js), so the credential manager
// offers the passkey the web created and the worklet derives the same diary
// key. Only the 32-byte PRF output crosses the IPC (identity.install, 5.50),
// once per ceremony or resume; it never goes to a log, an event or a result.
//
// Staying signed in mirrors the browser node: after a successful non-resumed
// install the PRF output is stored (src/sessionStore.native.js) and only a
// successful save calls identity.sessionSaved (5.55), which lifts the sign-out
// barrier; a failed save still unlocks, with sessionSaved: false. resume()
// reopens the stored session at start with no ceremony. 'Sair' writes the
// worklet's signedOut marker first (identity.forget, 5.54), then deletes the
// stored item; when that delete fails it rejects SIGNOUT_INCOMPLETE with the
// node locked.

import * as PasskeyPrf from '../modules/passkey-prf'
import { keychainEpoch, sessionStore } from './sessionStore'
import {
  CHALLENGE_BYTES,
  USER_ID_BYTES,
  buildCreateOptions,
  buildGetOptions,
  credentialIdOf,
  parsePrf,
  passkeyError,
  prfEnabled,
  toHex,
  userHandleOf
} from './passkeyOptions'

// packages/web-member/lib/node-store.js MISMATCH, the worklet's refusal of a
// key for another diary.
const MISMATCH_TEXT = 'passkey não corresponde ao diário guardado'
// apps/app/worklet/identity-install.js SIGNED_OUT, its refusal of a resumed
// install after 'Sair' (docs/rpc.md 5.50).
const SIGNED_OUT_TEXT = 'sessão encerrada neste aparelho: entre com a passkey'
const SIGNOUT_INCOMPLETE_TEXT = 'não foi possível sair por completo neste aparelho: tente de novo'
const KNOWN_CODES = ['CANCELLED', 'EXISTS', 'UNSUPPORTED', 'NO_PRF', 'WEBAUTHN']

function codedError (code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

function randomBytes (n) {
  const out = new Uint8Array(n)
  globalThis.crypto.getRandomValues(out)
  return out
}

// The module's codes keep their fixed pt-BR text; anything else is WEBAUTHN.
function mapCeremonyError (err) {
  const code = err && typeof err.code === 'string' ? err.code : ''
  return passkeyError(KNOWN_CODES.includes(code) ? code : 'WEBAUTHN')
}

function noop () {}

// passkey: { isAvailable, create, get } (modules/passkey-prf).
// request(method, params): the connection's request.
// rpId(): the installation's rp.id or null.
// store: { save, load, clear, clearAll } (src/sessionStore.native.js).
// epoch: { present, mark }, the fresh-install marker (keychainEpoch).
//
// As in packages/web-member/web/node.js: lock, signOut and reset bump
// `generation`; a ceremony or resume that sees it changed after any await
// stops (no install, no save, no sessionSaved; relocks if it already
// installed) and rejects CANCELLED. signOut and reset wait for the
// post-ceremony part in flight (`finishing`) before they delete the stored
// session, so a save racing 'Sair' is deleted after it.
export function createNativeIdentity ({ request, rpId: rpIdOf, passkey = PasskeyPrf, store = sessionStore, epoch = keychainEpoch, random = randomBytes } = {}) {
  if (typeof request !== 'function') throw new TypeError('request required')
  if (typeof rpIdOf !== 'function') throw new TypeError('rpId required')

  let busy = false
  let generation = 0
  // The post-ceremony part (install, save, sessionSaved) or the resume in
  // flight; never the ceremony itself, which may wait on the person.
  let finishing = Promise.resolve()
  // { credentialId, userId } of a creation whose PRF output needs complete().
  let pendingReg = null
  let resuming = Promise.resolve()
  let epochChecked = false

  function invalidate () {
    generation++
  }

  function cancelled () {
    return passkeyError('CANCELLED')
  }

  function track (promise) {
    finishing = promise.then(noop, noop)
    return promise
  }

  function available () {
    try {
      return passkey.isAvailable() === true
    } catch {
      return false
    }
  }

  async function ceremony (kind, options) {
    let response
    try {
      response = await passkey[kind](JSON.stringify(options))
    } catch (err) {
      throw mapCeremonyError(err)
    }
    if (typeof response !== 'string' || response === '') throw passkeyError('WEBAUTHN')
    return response
  }

  // The web handle's NO_PRF (passkey.js register/signIn plus node.js
  // noteUnusable): code, text and the passkey it names. status().prf is not
  // touched: one manager without PRF says nothing about the next try.
  function noPrf (credentialId, userId) {
    const err = passkeyError('NO_PRF')
    err.credentialId = credentialId
    if (userId !== '') err.userId = userId
    return err
  }

  async function mismatchError () {
    const err = codedError('MISMATCH', MISMATCH_TEXT)
    try {
      const st = await request('identity.status')
      if (st && st.legacy === true) err.legacy = true
    } catch {}
    return err
  }

  // A PRF output -> the unlocked node, for a finished ceremony (resumed
  // false: saves the session, then sessionSaved) and for the stored session
  // (resumed true, prfHex from the store). Any stop after the install
  // relocks. Zeroes prfBytes.
  async function install (gen, { prfBytes = null, prfHex, credentialId, userId, rpId, created, resumed }) {
    let installed = false
    let done = false
    const hex = prfBytes !== null ? toHex(prfBytes) : prfHex
    try {
      if (gen !== generation) throw cancelled()
      let result
      try {
        result = await request('identity.install', { prf: hex, credentialId, userId, rpId, resumed })
      } catch (err) {
        if (!resumed && err && err.message === MISMATCH_TEXT) throw await mismatchError()
        throw err
      }
      installed = true
      if (prfBytes !== null) prfBytes.fill(0)
      if (gen !== generation) throw cancelled()
      if (resumed) {
        done = true
        return { publicKey: result.publicKey, created }
      }
      let sessionSaved = false
      try {
        await store.save({ rpId, credentialId, publicKey: result.publicKey, prfHex: hex })
        sessionSaved = true
      } catch {}
      // A lock/signOut/reset during the save: relocked, barrier kept
      // (signOut and reset delete the item once this settles).
      if (gen !== generation) throw cancelled()
      if (sessionSaved) {
        try {
          await request('identity.sessionSaved')
        } catch {
          // The barrier stays: the next start refuses the saved record and
          // deletes it, so the person is asked for the passkey once more.
          sessionSaved = false
        }
      }
      if (gen !== generation) throw cancelled()
      done = true
      const out = { publicKey: result.publicKey, created }
      if (!sessionSaved) out.sessionSaved = false
      return out
    } finally {
      if (prfBytes !== null) prfBytes.fill(0)
      if (installed && !done) await request('identity.clear').catch(noop)
    }
  }

  function begin () {
    if (busy) throw codedError('LOCKED', 'outra entrada com a passkey em andamento')
    const rpId = rpIdOf()
    if (typeof rpId !== 'string' || rpId === '' || !available()) throw passkeyError('UNSUPPORTED')
    busy = true
    invalidate()
    return rpId
  }

  // knownUserId: the pending creation's user id (complete), else null: the
  // assertion's user handle is used only when it is a 32-byte one (the
  // worklet takes hex64 or ''; status does not expose a bound userId).
  async function signIn (gen, rpId, allowCredentialIds, created, knownUserId = null) {
    const response = await ceremony('get', buildGetOptions({ rpId, challenge: random(CHALLENGE_BYTES), allowCredentialIds }))
    if (gen !== generation) throw cancelled()
    const credentialId = credentialIdOf(response)
    const handle = userHandleOf(response)
    const userId = typeof knownUserId === 'string' ? knownUserId : (/^[0-9a-f]{64}$/.test(handle) ? handle : '')
    let bytes
    try {
      bytes = parsePrf(response)
    } catch {
      throw noPrf(credentialId, userId)
    }
    return track(install(gen, { prfBytes: bytes, credentialId, userId, rpId, created, resumed: false }))
  }

  async function register (gen, rpId) {
    pendingReg = null
    const userIdBytes = random(USER_ID_BYTES)
    const userId = toHex(userIdBytes)
    const response = await ceremony('create', buildCreateOptions({ rpId, userId: userIdBytes, challenge: random(CHALLENGE_BYTES) }))
    if (gen !== generation) throw cancelled()
    const credentialId = credentialIdOf(response)
    let bytes
    try {
      bytes = parsePrf(response)
    } catch {
      if (!prfEnabled(response)) throw noPrf(credentialId, userId)
      pendingReg = { credentialId, userId }
      return { pending: true }
    }
    return track(install(gen, { prfBytes: bytes, credentialId, userId, rpId, created: true, resumed: false }))
  }

  // As the web's signIn: a passkey already bound to this diary is the only
  // one offered, so another Varanda passkey cannot be picked by mistake
  // (MISMATCH, then 'recomeçar' would delete the diary).
  async function boundCredentials (rpId) {
    let st = null
    try {
      st = await request('identity.status')
    } catch {}
    if (st && typeof st.credentialId === 'string' && st.credentialId !== '' && st.rpId === rpId) return [st.credentialId]
    return []
  }

  async function unlock ({ register: create = false } = {}) {
    await resuming
    const rpId = begin()
    const gen = generation
    try {
      return create ? await register(gen, rpId) : await signIn(gen, rpId, await boundCredentials(rpId), false)
    } finally {
      busy = false
    }
  }

  // The second gesture of a pending creation: a get() restricted to it.
  async function complete () {
    await resuming
    if (pendingReg === null) throw codedError('CANCELLED', 'nenhuma criação de passkey pendente')
    const target = pendingReg
    const rpId = begin()
    const gen = generation
    try {
      const out = await signIn(gen, rpId, [target.credentialId], true, target.userId)
      pendingReg = null
      return out
    } catch (err) {
      if (err && err.code === 'NO_PRF') {
        pendingReg = null
        err.credentialId = target.credentialId
        err.userId = target.userId
      }
      throw err
    } finally {
      busy = false
    }
  }

  // prf stays 'unknown': the platforms offer no capability probe, so only a
  // ceremony can tell (NO_PRF, with the retry path of src/passkeyTrouble.js).
  async function status () {
    await resuming
    const st = await request('identity.status')
    const rpId = rpIdOf()
    return { ...st, webauthn: available() && typeof rpId === 'string', prf: 'unknown', rpId: typeof rpId === 'string' ? rpId : null }
  }

  // Memory only: the stored session survives it (the next start resumes).
  function lock () {
    invalidate()
    return request('identity.clear')
  }

  async function signOut () {
    invalidate()
    pendingReg = null
    await resuming
    // A post-ceremony part in flight may still save: let it settle first.
    await finishing
    const st = await request('identity.status').catch(() => null)
    let forgotten = true
    try {
      await request('identity.forget')
    } catch {
      forgotten = false
      await request('identity.clear').catch(noop)
    }
    // Without the marker the item is the only thing a restart could resume
    // from: it goes either way.
    let cleared = true
    try {
      await store.clear({ rpId: rpIdOf(), publicKey: st ? st.publicKey : null })
    } catch {
      cleared = false
    }
    if (!forgotten || !cleared) throw codedError('SIGNOUT_INCOMPLETE', SIGNOUT_INCOMPLETE_TEXT)
    return {}
  }

  async function reset () {
    invalidate()
    pendingReg = null
    await resuming
    await finishing
    const st = await request('identity.status').catch(() => null)
    let failure = null
    try {
      await request('identity.reset')
    } catch (err) {
      failure = err
    }
    // Deleted whatever the answer (docs/rpc.md 5.53).
    try {
      await store.clear({ rpId: rpIdOf(), publicKey: st ? st.publicKey : null })
    } catch {
      if (failure === null) failure = codedError('SIGNOUT_INCOMPLETE', SIGNOUT_INCOMPLETE_TEXT)
    }
    if (failure !== null) throw failure
    return {}
  }

  // At start: the stored session reopens the node with no ceremony when the
  // stored diary exists, is not legacy, is for the same public key and 'Sair'
  // did not happen since. Fails closed and never throws.
  async function resumeOnce (gen) {
    // A fresh install (iOS keeps keychain items across app deletion): every
    // stored session goes before anything can load one. The marker is
    // written only once that delete went through, so a refusal tries again
    // on the next start.
    if (!epochChecked) {
      epochChecked = true
      let fresh = false
      try { fresh = epoch.present() !== true } catch {}
      if (fresh) {
        try {
          await store.clearAll()
          epoch.mark()
        } catch {
          return
        }
      }
    }
    const rpId = rpIdOf()
    if (typeof rpId !== 'string' || rpId === '') return
    let st
    try {
      st = await request('identity.status')
    } catch {
      return
    }
    if (!st || st.unlocked === true || gen !== generation) return
    if (st.signedOut === true) {
      try { await store.clear({ rpId, publicKey: st.publicKey }) } catch {}
      return
    }
    // No diary (a reinstall wiped it) or a legacy one: no stored session of
    // this rp.id can resume, so none is left behind.
    if (st.exists !== true || st.legacy === true) {
      try { await store.clearAll({ rpId }) } catch {}
      return
    }
    if (typeof st.publicKey !== 'string') return
    const record = await store.load({ rpId, publicKey: st.publicKey }).catch(() => null)
    if (record === null || gen !== generation) return
    if (typeof st.credentialId === 'string' && st.credentialId !== record.credentialId) {
      try { await store.clear({ rpId, publicKey: st.publicKey }) } catch {}
      return
    }
    try {
      await install(gen, { prfHex: record.prfHex, credentialId: record.credentialId, userId: '', rpId, created: false, resumed: true })
    } catch (err) {
      // Only the refusals that make the record useless (signed out, another
      // diary) end it; anything else (a lost connection, too many pending
      // requests, a lock meanwhile) keeps it for the next start.
      if (err && err.code === 'USAGE' && (err.message === SIGNED_OUT_TEXT || err.message === MISMATCH_TEXT)) {
        try { await store.clear({ rpId, publicKey: st.publicKey }) } catch {}
      }
    }
  }

  function resume () {
    resuming = track(resumeOnce(generation).catch(noop))
    return resuming
  }

  return { status, unlock, complete, lock, signOut, reset, resume }
}
