// Entrar with a passkey that opens no account, the pure part (no React, no
// react-native, no Node built-ins). The provider (src/node.js) settles a
// sign-in on a hosted install with these steps, and Identidade shows the
// card when the result says `empty: true`.
//
// A passkey whose manager returned no user handle and that this device does
// not know comes back from the handle as { check: true, publicKey, lookupId }
// (docs/protocol.md "Web member storage (B2)"): publicKey is the diary key
// its PRF output would install, lookupId the id it would have as an added
// passkey. The account status of publicKey decides; lookupId goes to the
// account service only when that key has no account, so no value derived
// from the PRF output of an account's own passkey ever reaches it. The
// service cannot turn the passkey into another identity: a blob it answers
// opens only under the wrap key the node holds, and a blob that does not
// open falls back to the direct install. Once the status says the key has no
// account, every direct install (no entry, a lookup that failed, a blob that
// does not open) is a new empty identity, so it gets the card.

export const EMPTY_TITLE = 'Esta passkey não abriu nenhuma conta'
export const EMPTY_TEXT = 'Ela não está ligada a nenhuma conta do Varanda neste endereço. Se você tem outra passkey do Varanda, entre com ela. Para começar uma conta nova com esta passkey, siga em frente.'
export const EMPTY_OTHER_LABEL = 'Entrar com outra passkey'
export const EMPTY_CREATE_LABEL = 'Criar conta com ela'

const KEY_RE = /^[0-9a-f]{64}$/

// An /account/status answer -> 'free' (the key has no account, is not
// deleted and is not a Página), 'taken', or 'unknown' (anything else).
export function keyState (status) {
  if (status === null || typeof status !== 'object') return 'unknown'
  if (status.linked === true || status.deleted !== undefined || status.unavailable === true) return 'taken'
  return status.linked === false ? 'free' : 'unknown'
}

// The identity status read before the sign-in -> true only when it says this
// device had no diary, so the key the sign-in installed is new here. An
// unread status (null) is not new: the card would offer to forget it.
export function newHere (before, publicKey) {
  if (before === null || typeof before !== 'object' || typeof publicKey !== 'string' || !KEY_RE.test(publicKey)) return false
  return before.exists === false
}

async function stateOf (accountStatus, publicKey) {
  try {
    return keyState(await accountStatus(publicKey))
  } catch {
    return 'unknown'
  }
}

// The handle's sign-in result -> the result the screen sees.
//   accountStatus(publicKey)  the account service's status of a key
//   recoveryFetch(lookupId)   the entry { member, blob }, null on the marked
//                             404, throws when it could not ask
//   direct()                  the handle's unlockDirect()
//   wrapped({ blob, member }) the handle's unlockWrapped()
//   stale()                   true once a newer sign-in started (the caller
//                             then throws SUPERSEDED)
// `before`: the identity status read before the ceremony. Only a hosted
// install calls it. A plain result (not { check }) gets `empty: true` when
// it is a sign-in (not a creation) of a key new here that has no account.
export async function settleSignIn (r, { before, accountStatus, recoveryFetch, direct, wrapped, stale = () => false }) {
  if (!r || typeof r !== 'object' || r.pending === true || r.wrapped === true || r.needsPasskey === true) return r
  if (r.check !== true) {
    if (r.created !== false || !newHere(before, r.publicKey)) return r
    const state = await stateOf(accountStatus, r.publicKey)
    return state === 'free' ? { ...r, empty: true } : r
  }
  const state = typeof r.publicKey === 'string' && KEY_RE.test(r.publicKey) ? await stateOf(accountStatus, r.publicKey) : 'unknown'
  if (stale()) return null
  if (state !== 'free') return direct()
  const directEmpty = async () => {
    const out = await direct()
    return out && out.created === false && newHere(before, out.publicKey) ? { ...out, empty: true } : out
  }
  let entry
  try {
    entry = await recoveryFetch(r.lookupId)
  } catch {
    if (stale()) return null
    return directEmpty()
  }
  if (stale()) return null
  if (entry === null) return directEmpty()
  try {
    return await wrapped({ blob: entry.blob, member: entry.member })
  } catch (err) {
    // A blob that does not open is no account of this passkey: it installs
    // as before. Any other refusal (a cancel, another diary) stands.
    if (err && err.code === 'RECOVERY_BAD' && !stale()) return directEmpty()
    throw err
  }
}

// The key the card is raised for after a sign-in result, or null.
// afterCreateReset: this sign-in follows a 'recomeçar' that a creation's
// MISMATCH led to, so its passkey was made here for a new account and the
// onboarding goes on with no card.
export function emptyKeyOf (r, { afterCreateReset = false } = {}) {
  if (!r || r.empty !== true || typeof r.publicKey !== 'string' || afterCreateReset === true) return null
  return r.publicKey
}

// Whether the card raised for emptyKey still applies: only while that
// identity is the one unlocked here. Its diary is created after the card, so
// an unlocked status with no diary yet (publicKey null) still counts; a lock
// or another key never does.
export function emptyCardShown (emptyKey, { locked, status }) {
  if (typeof emptyKey !== 'string' || locked === true) return false
  if (status === null || typeof status !== 'object' || status.unlocked !== true) return false
  if (status.publicKey === emptyKey) return true
  return status.exists === false && (status.publicKey === null || status.publicKey === undefined)
}

// The card's two buttons. 'other': the identity this sign-in just made here
// (new here, no account) is forgotten, then Entrar with any passkey starts;
// signIn is called only when it may still run (canSignIn: the web needs the
// tap's activation). 'create': onboarding continues as today.
export async function chooseEmpty (choice, { forget, signIn, proceed, canSignIn = () => true }) {
  if (choice === 'create') return proceed()
  if (choice !== 'other') return undefined
  await forget()
  if (canSignIn()) return signIn()
  return undefined
}
