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
//
// Recovery (docs/rpc.md 5.91 to 5.94): a passkey whose user id ends with
// WRAP_MARK holds no diary key of its own; its PRF output only opens a
// wrapped copy of the original one (the root) that the account service
// keeps. signIn() never installs such a PRF: it asks the worklet for the
// lookup id (identity.recoveryLookup, which keeps the wrap key) and resolves
// { wrapped, lookupId }; the app fetches the blob and unlockWrapped() opens it
// in the worklet (identity.recoveryOpen) and installs the ROOT, so the stored
// session holds the root too. A recovery code works the same way, then
// finishRecovery() creates a marked passkey for the root. No HTTP here: the
// app (src/node.js) talks to the account service.
//
// confirm(), as the browser handle's: a fresh user verification with the
// bound passkey while unlocked, before a step the stored session alone must
// not authorize; it never installs, saves or changes anything.

import * as PasskeyPrf from '../modules/passkey-prf'
import { keychainEpoch, sessionStore } from './sessionStore'
import { capRefused, isBound, passkeyLocal } from './passkeyLocal'
import { parseAuthData, syncStateOf } from './authenticatorData'
import {
  CHALLENGE_BYTES,
  USER_ID_BYTES,
  buildCreateOptions,
  buildGetOptions,
  credentialIdOf,
  fromBase64Url,
  parsePrf,
  passkeyError,
  prfEnabled,
  prfOutputPresent,
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
const KNOWN_CODES = ['CANCELLED', 'EXISTS', 'UNSUPPORTED', 'NO_PRF', 'WEBAUTHN', 'NOT_SYNCED', 'NONE']
const MISSING_TEXT = 'a passkey criada não foi encontrada; toque em Criar passkey de novo'
// apps/app/worklet/identity-install.js BAD_ENTRY (docs/rpc.md 5.92).
const BAD_ENTRY_TEXT = 'entrada de recuperação inválida'
const RECOVERY_EXPIRED_TEXT = 'o tempo da recuperação acabou: entre de novo'
const NO_BOUND_TEXT = 'nenhuma passkey ligada a esta sessão: entre de novo com a passkey'
const SIGN_IN_FIRST_TEXT = 'essa passkey não pôde ser concluída: entre com a sua passkey ou com o código de recuperação'
const RECOVERY_UNDONE_TEXT = 'não deu para concluir a recuperação: entre com o código de novo'
// packages/web-member/web/node.js LOCKED_MESSAGE.
const LOCKED_TEXT = 'identidade bloqueada: entre com a passkey'
const BUSY_TEXT = 'outra entrada com a passkey em andamento'
const RECOVERY_MS = 120 * 1000

// packages/web-member/lib/recovery.js WRAP_MARK ('varanda-wrap-v1\n'),
// duplicated as passkeyOptions.js duplicates PRF_INPUT: Metro cannot import
// web-member (metro.config.js).
export const WRAP_MARK_HEX = '766172616e64612d777261702d76310a'
const WRAP_MARK_BYTES = WRAP_MARK_HEX.length / 2
// The bound user id of a recovery passkey whose manager returned no user
// handle: its real one is unknown, but the record must still say "wrapping",
// or the next sign-in without a handle would install that passkey's own PRF.
export const UNKNOWN_WRAP_USER_ID = '00'.repeat(32 - WRAP_MARK_BYTES) + WRAP_MARK_HEX

// A hex64 user handle whose LAST 16 bytes are WRAP_MARK.
export function isWrapUserId (hex) {
  return typeof hex === 'string' && /^[0-9a-f]{64}$/.test(hex) && hex.slice(64 - WRAP_MARK_HEX.length) === WRAP_MARK_HEX
}

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

// The UV flag of a get response's authenticator data (base64url). Missing or
// unreadable data reads as not verified.
function userVerifiedOf (response) {
  try {
    const r = typeof response === 'string' ? JSON.parse(response) : response
    const field = r && r.response ? r.response.authenticatorData : null
    const parsed = typeof field === 'string' && field !== '' ? parseAuthData(fromBase64Url(field)) : null
    return parsed !== null && parsed.flags.uv
  } catch {
    return false
  }
}

// A failure after the manager stored a passkey names it, so the person can
// find it and delete it there (nothing is deleted automatically).
function createdError (err, credentialId, userId) {
  const out = err instanceof Error ? err : new Error(String(err && err.message ? err.message : err))
  if (err && typeof err.code === 'string' && out.code === undefined) out.code = err.code
  out.credentialId = credentialId
  if (userId !== '') out.userId = userId
  return out
}

function validId (id) {
  if (typeof id !== 'string' || id === '') return false
  try {
    fromBase64Url(id)
    return true
  } catch {
    return false
  }
}

// passkey: { isAvailable, create, get } (modules/passkey-prf).
// request(method, params): the connection's request.
// rpId(): the installation's rp.id or null.
// store: { save, load, clear, clearAll } (src/sessionStore.native.js).
// epoch: { present, mark }, the fresh-install marker (keychainEpoch).
// local: { load, save, clear } (src/passkeyLocal.native.js), the pending
// creation and the refused passkeys of each rp.id, kept across restarts.
//
// As in packages/web-member/web/node.js: lock, signOut and reset bump
// `generation`; a ceremony or resume that sees it changed after any await
// stops (no install, no save, no sessionSaved; relocks if it already
// installed) and rejects CANCELLED. signOut and reset wait for the
// post-ceremony part in flight (`finishing`) before they delete the stored
// session, so a save racing 'Sair' is deleted after it.
export function createNativeIdentity ({ request, rpId: rpIdOf, passkey = PasskeyPrf, store = sessionStore, epoch = keychainEpoch, local = passkeyLocal, random = randomBytes, now = Date.now } = {}) {
  if (typeof request !== 'function') throw new TypeError('request required')
  if (typeof rpIdOf !== 'function') throw new TypeError('rpId required')

  let busy = false
  let generation = 0
  // The post-ceremony part (install, save, sessionSaved) or the resume in
  // flight; never the ceremony itself, which may wait on the person.
  let finishing = Promise.resolve()
  // { credentialId, userId } of a creation whose PRF output needs complete().
  let pendingReg = null
  // [{ credentialId, userId, code, cleaned, created }]: passkeys this app
  // refused, kept out of every new creation (excludeCredentials). There is no
  // signal API on native to hide them in the manager, so cleaned stays false.
  // created: this app made it (false for a sign-in passkey without PRF).
  let refused = []
  let loadedFor = null
  let loading = Promise.resolve()
  let resuming = Promise.resolve()
  let epochChecked = false
  // The recovery waiting for the app's fetch: { kind: 'passkey' | 'code',
  // credentialId, userId, expiresAt }. No PRF output is held: the worklet
  // keeps the wrap key.
  let awaiting = null
  // The root opened from a code, waiting for finishRecovery():
  // { prfHex, publicKey, expiresAt, pinned }. A string cannot be zero-filled:
  // it is dropped. pinned: a creation for it is running or pending, so it
  // does not expire until that settles or the person cancels.
  let heldRoot = null
  // { credentialId, userId } of the last install of this run: a passkey the
  // worklet bound even when its status was read before.
  let installedCred = null

  function dropAwaiting () {
    awaiting = null
  }

  function dropRecovery () {
    dropAwaiting()
    heldRoot = null
  }

  function heldRootValid () {
    return heldRoot !== null && (heldRoot.pinned === true || now() <= heldRoot.expiresAt)
  }

  // A creation for the held root settled without using it: the person gets
  // a fresh window to try again.
  function unpinHeldRoot () {
    if (heldRoot !== null && heldRoot.pinned === true) {
      heldRoot = { ...heldRoot, pinned: false, expiresAt: now() + RECOVERY_MS }
    }
  }

  function recoveryExpired () {
    return codedError('RECOVERY_BAD', RECOVERY_EXPIRED_TEXT)
  }

  function wrapUserId () {
    const out = new Uint8Array(USER_ID_BYTES)
    const rand = random(USER_ID_BYTES - WRAP_MARK_BYTES)
    out.set(rand)
    rand.fill(0)
    for (let i = 0; i < WRAP_MARK_BYTES; i++) out[USER_ID_BYTES - WRAP_MARK_BYTES + i] = parseInt(WRAP_MARK_HEX.slice(i * 2, i * 2 + 2), 16)
    return out
  }

  // The durable record of rpId, read once (per rp.id) before any ceremony.
  function loadLocal (rpId) {
    if (typeof rpId !== 'string' || rpId === '' || loadedFor === rpId) return loading
    loadedFor = rpId
    loading = (async () => {
      let rec = null
      try {
        rec = await local.load(rpId)
      } catch {
        // Unreadable for now: keep what memory holds and read again on the
        // next call (persist merges before it writes).
        if (loadedFor === rpId) loadedFor = null
        return
      }
      if (loadedFor !== rpId) return
      pendingReg = rec && rec.pending && validId(rec.pending.credentialId)
        ? { credentialId: rec.pending.credentialId, userId: typeof rec.pending.userId === 'string' ? rec.pending.userId : '' }
        : null
      refused = rec && Array.isArray(rec.refused)
        ? rec.refused.filter((r) => r && validId(r.credentialId)).map((r) => ({ credentialId: r.credentialId, userId: typeof r.userId === 'string' ? r.userId : '', code: String(r.code), cleaned: false, created: r.created === true }))
        : []
    })()
    return loading
  }

  // A failed write keeps the memory state: this run still excludes them.
  async function persist (rpId) {
    try {
      // The record was never read (the file was unreadable): merge it first,
      // or this save would replace it with only what memory holds.
      if (loadedFor !== rpId) {
        const rec = await local.load(rpId)
        const disk = Array.isArray(rec && rec.refused) ? rec.refused.filter((r) => r && validId(r.credentialId)) : []
        for (const r of disk) {
          if (!refused.some((m) => m.credentialId === r.credentialId)) refused.unshift({ credentialId: r.credentialId, userId: typeof r.userId === 'string' ? r.userId : '', code: String(r.code), cleaned: false, created: r.created === true })
        }
        refused = capRefused(refused)
        if (pendingReg === null && rec && rec.pending && validId(rec.pending.credentialId)) {
          pendingReg = { credentialId: rec.pending.credentialId, userId: typeof rec.pending.userId === 'string' ? rec.pending.userId : '' }
        }
        loadedFor = rpId
      }
      await local.save(rpId, { pending: pendingReg, refused: refused.map((r) => ({ ...r })) })
    } catch {}
  }

  // An id that fromBase64Url refuses is dropped: it would throw in
  // buildCreateOptions on every later creation. A passkey this app created
  // stays created: a later sign-in refusal of the same id says nothing else.
  function addRefused (credentialId, userId, code, created) {
    if (!validId(credentialId)) return
    const wasCreated = refused.some((r) => r.credentialId === credentialId && r.created === true)
    // A device-bound refusal is never downgraded: a later NO_PRF for the same
    // passkey would otherwise let it sign in once PRF comes back.
    const bound = refused.find((r) => r.credentialId === credentialId && isBound(r))
    refused = refused.filter((r) => r.credentialId !== credentialId)
    if (bound) {
      // Keeps the creation's user id too: it names the passkey on the card.
      refused.push(bound)
    } else {
      refused.push({ credentialId, userId: typeof userId === 'string' ? userId : '', code, cleaned: false, created: created === true || wasCreated })
    }
    refused = capRefused(refused)
  }

  // A newer creation that returned a credential replaces the pending one,
  // which stays excluded so its manager is not asked for it again.
  function supersede (credentialId) {
    if (pendingReg !== null && pendingReg.credentialId !== credentialId) addRefused(pendingReg.credentialId, pendingReg.userId, 'SUPERSEDED', true)
    pendingReg = null
  }

  // A sign-in with another passkey than the pending creation supersedes it
  // (kept excluded), as a newer creation does.
  //
  // Accepted limit: a process kill between identity.install/store.save of a
  // new credential and this attempts-file write can restore an old pending
  // creation on the next launch. 'concluir' on it then reports MISMATCH, and
  // 'recomeçar' still needs its explicit confirm, so nothing is lost silently.
  async function settleInstalled (rpId, credentialId) {
    supersede(credentialId)
    refused = refused.filter((r) => r.credentialId !== credentialId)
    await persist(rpId)
  }

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
      installedCred = { credentialId, userId: typeof userId === 'string' ? userId : '' }
      // A recovery left armed must never install over this sign-in later.
      dropRecovery()
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

  function boundRefusal (credentialId) {
    return refused.find((r) => r.credentialId === credentialId && isBound(r))
  }

  function boundError (bound, credentialId, userId) {
    const err = passkeyError('NOT_SYNCED')
    err.credentialId = credentialId
    err.userId = bound.userId !== '' ? bound.userId : userId
    return err
  }

  // knownUserId: the pending creation's user id (complete), else null: the
  // assertion's user handle is used only when it is a 32-byte one (the
  // worklet takes hex64 or '').
  // bound: { credentialId, userId } of the passkey bound to the diary (from
  // identity.status, read before the ceremony), or null.
  //
  // The recovery decision, as the browser handle's: the handle checked for
  // the mark is the returned one, else the bound passkey's user id when the
  // credential is the bound one, else the user id of a refused entry for the
  // credential (an abandoned add or recovery passkey). Marked: never
  // installed, resolves { wrapped, lookupId }. Anything else installs
  // directly: a lookup id is never derived from a PRF not known to be a
  // wrapping passkey's, since an ordinary passkey's PRF is the member root
  // and the service's answer must never decide what becomes an identity. A
  // compliant authenticator returns the handle, so only a manager that drops
  // it loses the recovery path.
  async function signIn (gen, rpId, allowCredentialIds, created, knownUserId = null, bound = null) {
    const response = await ceremony('get', buildGetOptions({ rpId, challenge: random(CHALLENGE_BYTES), allowCredentialIds }))
    if (gen !== generation) throw cancelled()
    const credentialId = credentialIdOf(response)
    const handle = userHandleOf(response)
    const userId = typeof knownUserId === 'string' ? knownUserId : (/^[0-9a-f]{64}$/.test(handle) ? handle : '')
    let bytes
    try {
      bytes = parsePrf(response)
    } catch {
      // As the web: a sign-in passkey without PRF is kept out of the next
      // creation. complete() records its own target as a creation.
      // A sign-in that picked the pending creation: it was created here.
      if (!created && pendingReg !== null && pendingReg.credentialId === credentialId) {
        const own = pendingReg
        pendingReg = null
        addRefused(credentialId, own.userId, 'NO_PRF', true)
        await persist(rpId)
        throw noPrf(credentialId, own.userId)
      } else if (!created) {
        addRefused(credentialId, userId, 'NO_PRF', false)
        await persist(rpId)
      }
      throw noPrf(credentialId, userId)
    }
    // A passkey created here and refused as bound to one device never
    // unlocks, whatever manager offers it later: it would lock the member
    // out of every other device.
    const refusal = boundRefusal(credentialId)
    if (refusal) {
      bytes.fill(0)
      throw boundError(refusal, credentialId, userId)
    }
    if (created) {
      // The pending creation of an add or a code recovery: its PRF only
      // wraps the root, it never becomes a diary key.
      if (isWrapUserId(userId)) {
        if (heldRootValid()) return await finishRecover(gen, rpId, bytes, credentialId, userId)
        return await finishAdd(gen, rpId, bytes, credentialId, userId)
      }
    } else {
      const known = [bound, installedCred].find((b) => b !== null && b.credentialId === credentialId) || null
      const entry = known !== null ? null : refused.find((r) => r.credentialId === credentialId && isWrapUserId(r.userId)) || null
      const fallback = known !== null ? known.userId : (entry !== null ? entry.userId : '')
      const markHandle = handle !== '' ? handle : (typeof fallback === 'string' ? fallback : '')
      if (isWrapUserId(markHandle)) return await lookupWrapped(gen, bytes, credentialId, markHandle)
    }
    const out = await track(install(gen, { prfBytes: bytes, credentialId, userId, rpId, created, resumed: false }))
    await settleInstalled(rpId, credentialId)
    return out
  }

  // Asks the worklet for the lookup id of a passkey PRF (the wrap key stays
  // there), only for a marked passkey. The PRF output is zero-filled here.
  async function lookupWrapped (gen, bytes, credentialId, userId) {
    try {
      if (gen !== generation) throw cancelled()
      const res = await request('identity.recoveryLookup', { kind: 'passkey', secret: toHex(bytes) })
      if (gen !== generation) throw cancelled()
      if (!res || typeof res.lookupId !== 'string') throw passkeyError('WEBAUTHN')
      dropRecovery()
      awaiting = { kind: 'passkey', credentialId, userId, expiresAt: now() + RECOVERY_MS }
      return { wrapped: true, lookupId: res.lookupId }
    } finally {
      bytes.fill(0)
    }
  }

  // An add: the new passkey's PRF wraps the root held by the unlocked
  // worklet (identity.recoveryWrap); the session stays the original one.
  async function finishAdd (gen, rpId, bytes, credentialId, userId) {
    let hex
    try { hex = toHex(bytes) } finally { bytes.fill(0) }
    let wrapped
    try {
      if (gen !== generation) throw cancelled()
      wrapped = await request('identity.recoveryWrap', { kind: 'passkey', secret: hex })
      if (gen !== generation) throw cancelled()
    } catch (err) {
      // A pending creation stays pending: 'concluir' can wrap it once unlocked.
      throw createdError(err, credentialId, userId)
    }
    // An older pending creation replaced by this one stays excluded.
    supersede(credentialId)
    await persist(rpId)
    return { credentialId, userId, lookupId: wrapped.lookupId, blob: wrapped.blob }
  }

  // The end of a code recovery: the held ROOT is installed bound to the new
  // marked passkey (its session saved with the root), then wrapped under the
  // new PRF for the app to register. Anything that stops it after the
  // install (a failed wrap, a cancel, lock or sign-out meanwhile) rolls back:
  // a device bound to a passkey with no blob at the service could never be
  // opened from another device, so the node is relocked, its stored session
  // deleted and the new passkey refused.
  async function finishRecover (gen, rpId, bytes, credentialId, userId) {
    let hex
    try { hex = toHex(bytes) } finally { bytes.fill(0) }
    const held = heldRoot
    if (held === null) throw createdError(recoveryExpired(), credentialId, userId)
    const rollback = async (publicKey) => {
      heldRoot = null
      await request('identity.clear').catch(noop)
      await store.clear({ rpId, publicKey }).catch(noop)
      addRefused(credentialId, userId, 'INSTALL_FAILED', true)
      await persist(rpId)
      return createdError(codedError('RECOVERY_BAD', RECOVERY_UNDONE_TEXT), credentialId, userId)
    }
    // One tracked part: signOut and reset wait for the install, the wrap and
    // any rollback, so neither races the keychain item or the local record.
    return await track((async () => {
      let out
      try {
        out = await install(gen, { prfHex: held.prfHex, credentialId, userId, rpId, created: true, resumed: false })
      } catch (err) {
        if (heldRoot === held) heldRoot = null
        // A cancel or lock that landed after the worklet bound the new
        // passkey (install relocked, but its session may be saved): the same
        // rollback. A failure before the install changed nothing.
        if (gen !== generation) {
          const st = await request('identity.status').catch(() => null)
          if (st && st.credentialId === credentialId) throw await rollback(held.publicKey)
        }
        throw createdError(err, credentialId, userId)
      }
      if (heldRoot === held) heldRoot = null
      try {
        await settleInstalled(rpId, credentialId)
        if (gen !== generation) throw cancelled()
        const wrapped = await request('identity.recoveryWrap', { kind: 'passkey', secret: hex })
        if (gen !== generation) throw cancelled()
        return { ...out, credentialId, userId, lookupId: wrapped.lookupId, blob: wrapped.blob }
      } catch {
        throw await rollback(out.publicKey)
      }
    })())
  }

  // A cancelled or failed ceremony keeps the previous pending creation. A
  // passkey bound to one device (BE clear) is refused before its PRF output
  // is read: it would lock the member out of every other device.
  //
  // mode: 'unlock' (a new diary), 'add' (a marked passkey whose PRF wraps
  // the unlocked root) or 'recover' (a marked passkey for the root a code
  // opened). The marked modes never install the new PRF output.
  async function register (gen, rpId, mode = 'unlock') {
    const userIdBytes = mode === 'unlock' ? random(USER_ID_BYTES) : wrapUserId()
    const userId = toHex(userIdBytes)
    const exclude = new Set((await boundCredentials(rpId)).filter(validId))
    if (pendingReg !== null) exclude.add(pendingReg.credentialId)
    for (const r of refused) exclude.add(r.credentialId)
    if (gen !== generation) throw cancelled()
    const response = await ceremony('create', buildCreateOptions({ rpId, userId: userIdBytes, challenge: random(CHALLENGE_BYTES), excludeCredentialIds: [...exclude] }))
    if (gen !== generation) throw cancelled()
    const credentialId = credentialIdOf(response)
    // An authenticator that ignored excludeCredentials can hand back a
    // passkey already refused as bound to one device, now with authenticator
    // data that no longer reads as bound: refused as the sign-in guard does,
    // entry kept.
    const known = boundRefusal(credentialId)
    if (known) {
      try { parsePrf(response).fill(0) } catch {}
      throw boundError(known, credentialId, userId)
    }
    // A handed-back excluded id was not made by this request (it may be an
    // account): recorded and reported as not created here, so never named.
    const madeNow = !exclude.has(credentialId) || (pendingReg !== null && pendingReg.credentialId === credentialId)
    if (syncStateOf(response, fromBase64Url) === 'bound') {
      addRefused(credentialId, userId, 'NOT_SYNCED', madeNow)
      if (pendingReg !== null && pendingReg.credentialId === credentialId) pendingReg = null
      await persist(rpId)
      const err = passkeyError('NOT_SYNCED')
      err.credentialId = credentialId
      err.userId = userId
      if (!madeNow) err.created = false
      throw err
    }
    let bytes
    try {
      bytes = parsePrf(response)
    } catch {
      // A present but unusable output is NO_PRF, never a second ceremony.
      if (prfOutputPresent(response) || !prfEnabled(response)) {
        addRefused(credentialId, userId, 'NO_PRF', madeNow)
        if (pendingReg !== null && pendingReg.credentialId === credentialId) pendingReg = null
        await persist(rpId)
        const err = noPrf(credentialId, userId)
        if (!madeNow) err.created = false
        throw err
      }
      // complete() would put a malformed id in allowCredentials.
      if (!validId(credentialId)) throw passkeyError('WEBAUTHN')
      supersede(credentialId)
      refused = refused.filter((r) => r.credentialId !== credentialId)
      pendingReg = { credentialId, userId }
      // complete() needs the root as long as the creation is pending: it
      // stays pinned (finishRecovery).
      await persist(rpId)
      return { pending: true }
    }
    if (gen !== generation) {
      bytes.fill(0)
      throw cancelled()
    }
    if (mode === 'add') return await finishAdd(gen, rpId, bytes, credentialId, userId)
    if (mode === 'recover') return await finishRecover(gen, rpId, bytes, credentialId, userId)
    // The pending creation is superseded only once the new passkey unlocked:
    // a failed install keeps it, and the new passkey is refused instead.
    let out
    try {
      out = await track(install(gen, { prfBytes: bytes, credentialId, userId, rpId, created: true, resumed: false }))
    } catch (err) {
      // A lock, signOut or reset meanwhile is not the passkey's fault.
      if (gen === generation) {
        addRefused(credentialId, userId, 'INSTALL_FAILED', true)
        await persist(rpId)
      }
      throw err
    }
    supersede(credentialId)
    await settleInstalled(rpId, credentialId)
    return out
  }

  // As the web's signIn: a passkey already bound to this diary is the only
  // one offered, so another Varanda passkey cannot be picked by mistake
  // (MISMATCH, then 'recomeçar' would delete the diary).
  async function boundCredentials (rpId) {
    const rec = await boundRecord(rpId)
    return rec !== null ? [rec.credentialId] : []
  }

  async function boundRecord (rpId) {
    let st = null
    try {
      st = await request('identity.status')
    } catch {}
    if (st && typeof st.credentialId === 'string' && st.credentialId !== '' && st.rpId === rpId) {
      return { credentialId: st.credentialId, userId: typeof st.userId === 'string' ? st.userId : '' }
    }
    return null
  }

  // any: true offers every Varanda passkey of this rp.id (discoverable), for
  // a person whose bound passkey is gone and who signs in with another one.
  async function unlock ({ register: create = false, any = false } = {}) {
    await resuming
    await loadLocal(rpIdOf())
    const rpId = begin()
    const gen = generation
    dropRecovery()
    try {
      if (create) return await register(gen, rpId)
      const bound = await boundRecord(rpId)
      return await signIn(gen, rpId, any === true || bound === null ? [] : [bound.credentialId], false, null, bound)
    } finally {
      busy = false
    }
  }

  // After { wrapped } from a passkey: the app's fetched blob is opened in the
  // worklet (5.92) and its root installed bound to that passkey, so the
  // stored session holds the root. After a code: the root is held for
  // finishRecovery() and { needsPasskey: true } resolves; nothing installed.
  // A missing or expired wait rejects RECOVERY_BAD with the node locked.
  async function unlockWrapped ({ blob, member } = {}) {
    await resuming
    if (awaiting === null || now() > awaiting.expiresAt) {
      dropAwaiting()
      throw codedError('RECOVERY_BAD', BAD_ENTRY_TEXT)
    }
    const rpId = begin()
    const gen = generation
    const wait = awaiting
    // The wait is consumed whatever the outcome, as the worklet's wrap key.
    awaiting = null
    try {
      let opened
      try {
        opened = await request('identity.recoveryOpen', { blob, member })
      } catch (err) {
        if (err && err.message === BAD_ENTRY_TEXT) throw codedError('RECOVERY_BAD', BAD_ENTRY_TEXT)
        throw err
      }
      if (gen !== generation) throw cancelled()
      if (!opened || typeof opened.prf !== 'string' || !/^[0-9a-f]{64}$/.test(opened.prf)) throw codedError('RECOVERY_BAD', BAD_ENTRY_TEXT)
      if (wait.kind === 'code') {
        // member: the root's public key, checked by the worklet (5.92).
        heldRoot = { prfHex: opened.prf, publicKey: member, expiresAt: now() + RECOVERY_MS, pinned: false }
        return { needsPasskey: true }
      }
      // Bound with its marked user id so its next sign-in, even without a
      // handle, takes this path again.
      const userId = isWrapUserId(wait.userId) ? wait.userId : UNKNOWN_WRAP_USER_ID
      const out = await track(install(gen, { prfHex: opened.prf, credentialId: wait.credentialId, userId, rpId, created: false, resumed: false }))
      await settleInstalled(rpId, wait.credentialId)
      return out
    } finally {
      busy = false
    }
  }

  // Kept only so an older caller fails clearly: signIn() never holds a PRF
  // for a direct install after a lookup (it installs an unmarked passkey at
  // once), so there is nothing to install here.
  async function unlockDirect () {
    throw codedError('USAGE', 'pedido inválido')
  }

  // The code goes to the worklet (5.91), which decodes it and keeps the wrap
  // key; a bad code rejects with its USAGE text.
  async function unlockWithCode ({ code } = {}) {
    await resuming
    begin()
    const gen = generation
    dropRecovery()
    try {
      const res = await request('identity.recoveryLookup', { kind: 'code', code: typeof code === 'string' ? code : '' })
      if (gen !== generation) throw cancelled()
      if (!res || typeof res.lookupId !== 'string') throw passkeyError('WEBAUTHN')
      awaiting = { kind: 'code', credentialId: null, userId: '', expiresAt: now() + RECOVERY_MS }
      return { wrapped: true, lookupId: res.lookupId }
    } finally {
      busy = false
    }
  }

  // The app's fetch found nothing or failed, or the person gave up:
  // everything held is dropped and the node stays locked (the worklet's wrap
  // key expires on its own). The generation moves too, so an unlockWrapped or
  // finishRecovery already past its checks cannot install after this.
  //
  // A marked creation still pending for the held root (finishRecovery that
  // answered { pending: true }) is that recovery's own: it is refused
  // SUPERSEDED (kept excluded) so 'concluir' stops showing and the code
  // entry comes back, as the web's abortRecovery drops it.
  async function cancelRecovery () {
    const ownPending = heldRoot !== null && pendingReg !== null && isWrapUserId(pendingReg.userId)
    invalidate()
    dropRecovery()
    if (ownPending) {
      addRefused(pendingReg.credentialId, pendingReg.userId, 'SUPERSEDED', true)
      pendingReg = null
      const rpId = rpIdOf()
      if (typeof rpId === 'string' && rpId !== '') await persist(rpId)
    }
    return {}
  }

  // A code recovery's second step: a new marked passkey for the held root.
  // A stored diary of another identity is refused before any ceremony: the
  // install would fail MISMATCH after the manager stored a passkey.
  async function finishRecovery () {
    await resuming
    await loadLocal(rpIdOf())
    if (!heldRootValid()) {
      heldRoot = null
      throw recoveryExpired()
    }
    const rpId = begin()
    const gen = generation
    let result = null
    try {
      const held = heldRoot
      const st = await request('identity.status')
      if (gen !== generation) throw cancelled()
      if (heldRoot !== held || !heldRootValid()) throw recoveryExpired()
      if (st && st.exists === true && (st.publicKey !== held.publicKey || st.legacy === true)) {
        heldRoot = null
        throw await mismatchError()
      }
      heldRoot = { ...held, pinned: true }
      result = await register(gen, rpId, 'recover')
      return result
    } finally {
      if (!(result && result.pending === true)) unpinHeldRoot()
      busy = false
    }
  }

  // A second passkey for this account, while unlocked: { credentialId,
  // userId, lookupId, blob } for the app to register, or { pending: true }
  // (complete() then returns the same shape).
  async function addPasskey () {
    await resuming
    await loadLocal(rpIdOf())
    const rpId = begin()
    const gen = generation
    try {
      return await register(gen, rpId, 'add')
    } finally {
      busy = false
    }
  }

  // After the app registered an added passkey ('Trocar a passkey'): the
  // worklet binds the diary to it (5.94) and the stored session is saved
  // again for it, with the root prfHex read back from the current session
  // (no second copy kept here). The keychain item is keyed by rp.id and
  // public key, so this save replaces the old passkey's item. With no stored
  // session (its save failed) only the binding changes; the next sign-in
  // with the new passkey goes through unlockWrapped, which saves one.
  // userId: the marked one addPasskey or finishRecovery returned; the bound
  // record must say "wrapping", so anything else is refused here.
  async function bindPasskey ({ credentialId, userId } = {}) {
    if (!validId(credentialId) || !isWrapUserId(userId)) throw codedError('USAGE', 'pedido inválido')
    await resuming
    if (busy) throw codedError('LOCKED', 'outra entrada com a passkey em andamento')
    const rpId = rpIdOf()
    if (typeof rpId !== 'string' || rpId === '') throw passkeyError('UNSUPPORTED')
    busy = true
    const gen = generation
    try {
      const st = await request('identity.status')
      if (gen !== generation) throw cancelled()
      const publicKey = st && st.unlocked === true && typeof st.publicKey === 'string' ? st.publicKey : null
      const record = publicKey !== null ? await store.load({ rpId, publicKey }).catch(() => null) : null
      if (gen !== generation) throw cancelled()
      await request('identity.recoveryBind', { credentialId, userId })
      if (gen !== generation) throw cancelled()
      installedCred = { credentialId, userId }
      if (record === null) return { sessionSaved: false }
      try {
        // Tracked: signOut and reset wait for it, so a completed 'Sair'
        // never leaves this item behind.
        await track(store.save({ rpId, credentialId, publicKey, prfHex: record.prfHex }))
      } catch {
        return { sessionSaved: false }
      }
      return {}
    } finally {
      busy = false
    }
  }

  // A recovery code for this account, while unlocked: { lookupId, blob, code }.
  // The code string exists only in this return value.
  async function makeRecoveryCode () {
    const res = await request('identity.recoveryWrap', { kind: 'code' })
    return { code: res.code, lookupId: res.lookupId, blob: res.blob }
  }

  // A fresh user verification (biometrics or device PIN) with the bound
  // passkey while unlocked, for a step the stored session alone must not
  // authorize (deleting the account). A check only: identity.status is its
  // one request, nothing is installed, saved or refused and the generation
  // does not move; a lock, signOut or reset meanwhile makes it CANCELLED.
  // The module always asks for the PRF output (the iOS request needs its
  // input): that output is never decoded, and being a JS string it cannot be
  // zero-filled, only dropped with the response.
  async function confirm () {
    await resuming
    if (busy) throw codedError('LOCKED', BUSY_TEXT)
    const rpId = rpIdOf()
    if (typeof rpId !== 'string' || rpId === '' || !available()) throw passkeyError('UNSUPPORTED')
    busy = true
    const gen = generation
    try {
      const st = await request('identity.status')
      if (gen !== generation) throw cancelled()
      if (!(st && st.unlocked === true)) throw codedError('LOCKED', LOCKED_TEXT)
      // Strict: only the bound passkey passes; a discoverable get would
      // accept any Varanda passkey the holder of the device has.
      const bound = validId(st.credentialId) && st.rpId === rpId ? st.credentialId : null
      if (bound === null) throw codedError('NONE', NO_BOUND_TEXT)
      const response = await ceremony('get', buildGetOptions({ rpId, challenge: random(CHALLENGE_BYTES), allowCredentialIds: [bound] }))
      if (gen !== generation) throw cancelled()
      const credentialId = credentialIdOf(response)
      if (!userVerifiedOf(response)) throw passkeyError('WEBAUTHN')
      if (credentialId !== bound) throw codedError('MISMATCH', MISMATCH_TEXT)
      return { ok: true }
    } catch (err) {
      if (gen !== generation) throw cancelled()
      throw err
    } finally {
      busy = false
    }
  }

  // The second gesture of a pending creation: a get() restricted to it.
  async function complete () {
    await resuming
    await loadLocal(rpIdOf())
    if (pendingReg === null) throw codedError('CANCELLED', 'nenhuma criação de passkey pendente')
    const target = pendingReg
    const rpId = begin()
    const gen = generation
    try {
      // A marked creation wraps either the held root (code recovery) or the
      // unlocked one (add). With neither (a restart, the hold dropped)
      // keeping it pending is useless: a passkey sign-in supersedes it
      // anyway, and the code entry stays hidden while 'concluir' shows. It is
      // refused SUPERSEDED (kept excluded) so the person can start over.
      if (isWrapUserId(target.userId) && !heldRootValid()) {
        const st = await request('identity.status').catch(() => null)
        if (gen !== generation) throw cancelled()
        if (!(st && st.unlocked === true)) {
          heldRoot = null
          if (pendingReg !== null && pendingReg.credentialId === target.credentialId) pendingReg = null
          addRefused(target.credentialId, target.userId, 'SUPERSEDED', true)
          await persist(rpId)
          throw codedError('RECOVERY_BAD', SIGN_IN_FIRST_TEXT)
        }
      }
      return await signIn(gen, rpId, [target.credentialId], true, target.userId)
    } catch (err) {
      // A reset (or sign-out, lock) while the ceremony was open owns the
      // record now: a late failure must not write the old passkey back.
      if (gen !== generation) throw err
      if (err && err.code === 'NO_PRF') {
        if (pendingReg !== null && pendingReg.credentialId === target.credentialId) pendingReg = null
        addRefused(target.credentialId, target.userId, 'NO_PRF', true)
        await persist(rpId)
        err.credentialId = target.credentialId
        err.userId = target.userId
      }
      // NONE here (Android NoCredentialException) means the pending passkey
      // never reached the manager: a new creation is the way out, not the
      // lost-passkey exit a bound sign-in's NONE leads to.
      if (err && err.code === 'NONE') {
        if (pendingReg !== null && pendingReg.credentialId === target.credentialId) pendingReg = null
        addRefused(target.credentialId, target.userId, 'MISSING', true)
        await persist(rpId)
        throw passkeyError('WEBAUTHN', MISSING_TEXT)
      }
      throw err
    } finally {
      // The pending creation is gone without using the held root.
      if (pendingReg === null) unpinHeldRoot()
      busy = false
    }
  }

  // prf, hybrid and platform stay 'unknown': the platforms offer no
  // capability probe, so only a ceremony can tell (NO_PRF, with the retry
  // path of src/passkeyTrouble.js). signal is 'no': nothing on native can
  // hide a refused passkey in the manager.
  async function status () {
    await resuming
    const rpId = rpIdOf()
    await loadLocal(rpId)
    const st = await request('identity.status')
    return {
      ...st,
      webauthn: available() && typeof rpId === 'string',
      prf: 'unknown',
      hybrid: 'unknown',
      platform: 'unknown',
      signal: 'no',
      pending: pendingReg !== null,
      refused: refused.map((r) => ({ userId: r.userId, code: r.code, cleaned: r.cleaned, created: r.created })),
      rpId: typeof rpId === 'string' ? rpId : null
    }
  }

  // Memory only: the stored session survives it (the next start resumes).
  function lock () {
    invalidate()
    dropRecovery()
    return request('identity.clear')
  }

  // The pending creation and the refused passkeys stay: they describe the
  // managers of this device, not the session.
  async function signOut () {
    invalidate()
    dropRecovery()
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

  // The local record goes first: when it cannot be cleared, nothing else
  // changes, so the refused passkeys are never left behind a reset diary.
  // The passkeys refused as bound to one device stay, on disk and in memory:
  // they describe this device's managers, not the account, and their entry
  // is what keeps them from ever signing in.
  async function reset () {
    const firstRp = rpIdOf()
    let kept = refused.filter(isBound)
    if (typeof firstRp === 'string' && firstRp !== '') {
      try {
        await local.clear(firstRp, { keepBound: true })
      } catch (err) {
        // A file that cannot be read must not block 'recomeçar': drop the
        // whole record (exclusions only, never an account) when the store
        // can; otherwise the reset stops here, changing nothing.
        if (typeof local.drop !== 'function') throw err
        try { await local.drop() } catch { throw err }
        if (kept.length > 0) {
          try { await local.save(firstRp, { pending: null, refused: kept.map((r) => ({ ...r })) }) } catch {}
        }
      }
    }
    invalidate()
    dropRecovery()
    installedCred = null
    pendingReg = null
    refused = kept
    await resuming
    await finishing
    await loading
    for (const r of refused.filter(isBound)) {
      if (!kept.some((k) => k.credentialId === r.credentialId)) kept.push(r)
    }
    kept = capRefused(kept)
    pendingReg = null
    refused = kept
    const localRp = rpIdOf()
    if (typeof localRp === 'string' && localRp !== '') {
      try { await local.clear(localRp, { keepBound: true }) } catch {}
    }
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
    await loadLocal(rpIdOf())
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

  return {
    status,
    unlock,
    complete,
    lock,
    signOut,
    reset,
    resume,
    unlockWrapped,
    unlockDirect,
    unlockWithCode,
    cancelRecovery,
    finishRecovery,
    addPasskey,
    bindPasskey,
    makeRecoveryCode,
    confirm
  }
}
