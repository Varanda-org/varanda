// The handle's `identity` API (docs/rpc.md section 11: status, unlock,
// complete, lock, signOut, reset) for the in-app web node. The host runs the
// passkey ceremony itself (modules/passkey-prf: Android Credential Manager,
// iOS AuthenticationServices) with the same rp.id (the installation hostname)
// and PRF input as the web (src/passkeyOptions.js), so the credential manager
// offers the passkey the web created and the worklet derives the same diary
// key. Only the 32-byte PRF output crosses the IPC (identity.install, 5.35),
// once per ceremony or resume; it never goes to a log, an event or a result.
//
// Staying signed in mirrors the browser node: after a successful non-resumed
// install the PRF output is stored (src/sessionStore.native.js) and only a
// successful save calls identity.sessionSaved (5.40), which lifts the sign-out
// barrier; a failed save still unlocks, with sessionSaved: false. resume()
// reopens the stored session at start with no ceremony. 'Sair' writes the
// worklet's signedOut marker first (identity.forget, 5.39), then deletes the
// stored item; when that delete fails it rejects SIGNOUT_INCOMPLETE with the
// node locked.

import * as PasskeyPrf from '../modules/passkey-prf'
import { sessionStore } from './sessionStore'
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

// passkey: { isAvailable, create, get } (modules/passkey-prf).
// request(method, params): the connection's request.
// rpId(): the installation's rp.id or null.
// store: { save, load, clear } (src/sessionStore.native.js).
export function createNativeIdentity ({ request, rpId: rpIdOf, passkey = PasskeyPrf, store = sessionStore, random = randomBytes } = {}) {
  if (typeof request !== 'function') throw new TypeError('request required')
  if (typeof rpIdOf !== 'function') throw new TypeError('rpId required')

  let busy = false
  let prf = 'unknown'
  // { credentialId, userId } of a creation whose PRF output needs complete().
  let pendingReg = null
  let resuming = Promise.resolve()

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

  function noPrf (credentialId, userId) {
    prf = 'no'
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

  // A finished ceremony's PRF output -> the unlocked node. Zeroes prfBytes.
  async function install (prfBytes, { credentialId, userId, rpId, created }) {
    let result
    const prfHex = toHex(prfBytes)
    try {
      result = await request('identity.install', { prf: prfHex, credentialId, userId, rpId, resumed: false })
    } catch (err) {
      if (err && err.message === MISMATCH_TEXT) throw await mismatchError()
      throw err
    } finally {
      prfBytes.fill(0)
    }
    let sessionSaved = false
    try {
      await store.save({ rpId, credentialId, publicKey: result.publicKey, prfHex })
      sessionSaved = true
    } catch {}
    if (sessionSaved) {
      try {
        await request('identity.sessionSaved')
      } catch {
        // The barrier stays: the next start refuses the saved record and
        // deletes it, so the person is asked for the passkey once more.
        sessionSaved = false
      }
    }
    const out = { publicKey: result.publicKey, created }
    if (!sessionSaved) out.sessionSaved = false
    return out
  }

  function begin () {
    if (busy) throw codedError('LOCKED', 'outra entrada com a passkey em andamento')
    const rpId = rpIdOf()
    if (typeof rpId !== 'string' || rpId === '' || !available()) throw passkeyError('UNSUPPORTED')
    busy = true
    return rpId
  }

  async function signIn (rpId, allowCredentialIds, created) {
    const response = await ceremony('get', buildGetOptions({ rpId, challenge: random(CHALLENGE_BYTES), allowCredentialIds }))
    const credentialId = credentialIdOf(response)
    const userId = userHandleOf(response)
    let bytes
    try {
      bytes = parsePrf(response)
    } catch {
      throw noPrf(credentialId, userId)
    }
    return install(bytes, { credentialId, userId, rpId, created })
  }

  async function register (rpId) {
    pendingReg = null
    const userIdBytes = random(USER_ID_BYTES)
    const userId = toHex(userIdBytes)
    const response = await ceremony('create', buildCreateOptions({ rpId, userId: userIdBytes, challenge: random(CHALLENGE_BYTES) }))
    const credentialId = credentialIdOf(response)
    let bytes
    try {
      bytes = parsePrf(response)
    } catch {
      if (!prfEnabled(response)) throw noPrf(credentialId, userId)
      pendingReg = { credentialId, userId }
      return { pending: true }
    }
    return install(bytes, { credentialId, userId, rpId, created: true })
  }

  async function unlock ({ register: create = false } = {}) {
    await resuming
    const rpId = begin()
    try {
      return create ? await register(rpId) : await signIn(rpId, [], false)
    } finally {
      busy = false
    }
  }

  // The second gesture of a pending creation: a get() restricted to it.
  async function complete () {
    await resuming
    if (pendingReg === null) throw passkeyError('WEBAUTHN')
    const rpId = begin()
    const target = pendingReg
    try {
      const out = await signIn(rpId, [target.credentialId], true)
      pendingReg = null
      return out
    } catch (err) {
      if (err && err.code === 'NO_PRF') pendingReg = null
      throw err
    } finally {
      busy = false
    }
  }

  async function status () {
    await resuming
    const st = await request('identity.status')
    const rpId = rpIdOf()
    return { ...st, webauthn: available() && typeof rpId === 'string', prf, rpId: typeof rpId === 'string' ? rpId : null }
  }

  function lock () {
    return request('identity.clear')
  }

  async function signOut () {
    await resuming
    pendingReg = null
    const st = await request('identity.status').catch(() => null)
    await request('identity.forget')
    try {
      await store.clear({ rpId: rpIdOf(), publicKey: st ? st.publicKey : null })
    } catch {
      throw codedError('SIGNOUT_INCOMPLETE', SIGNOUT_INCOMPLETE_TEXT)
    }
    return {}
  }

  async function reset () {
    await resuming
    pendingReg = null
    const st = await request('identity.status').catch(() => null)
    let failure = null
    try {
      await request('identity.reset')
    } catch (err) {
      failure = err
    }
    // Deleted whatever the answer (docs/rpc.md 5.38).
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
  async function resumeOnce () {
    const rpId = rpIdOf()
    if (typeof rpId !== 'string' || rpId === '') return
    let st
    try {
      st = await request('identity.status')
    } catch {
      return
    }
    if (!st || st.unlocked === true) return
    if (st.signedOut === true) {
      try { await store.clear({ rpId, publicKey: st.publicKey }) } catch {}
      return
    }
    if (st.exists !== true || st.legacy === true || typeof st.publicKey !== 'string') return
    const record = await store.load({ rpId, publicKey: st.publicKey }).catch(() => null)
    if (record === null) return
    if (typeof st.credentialId === 'string' && st.credentialId !== record.credentialId) {
      try { await store.clear({ rpId, publicKey: st.publicKey }) } catch {}
      return
    }
    try {
      await request('identity.install', { prf: record.prfHex, credentialId: record.credentialId, userId: '', rpId, resumed: true })
    } catch (err) {
      // A refusal (signedOut, another diary) ends the stored session; a lost
      // connection keeps it for the next start.
      if (err && err.code === 'USAGE') {
        try { await store.clear({ rpId, publicKey: st.publicKey }) } catch {}
      }
    }
  }

  function resume () {
    resuming = resumeOnce().catch(() => {})
    return resuming
  }

  return { status, unlock, complete, lock, signOut, reset, resume }
}
