// The hosted terms gate around Entrar and Criar conta, as the shell decides
// it. Pure ES module (no React, no globals), so Node's import() tests it.
//
// Every page load starts locked, and so does a brand-new device, so
// termsDecision lets Entrar through and the check moves after it
// (heldView). A new account has no other device to have accepted on: it
// accepts before its passkey ceremony starts, before anything about it is
// sent (createNeedsTerms).

import { heldGate, shouldAskHeld } from './terms.js'
import { emptyCardShown } from './emptyAccount.js'

const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x)

// Whether a new account must accept the Termos first. Only a claim from this
// page load counts: whoever creates an account accepts before creating it,
// and a record that lists someone else on this device says nothing about
// this person (after the ceremony the diary's once sync reaches the seeder
// before the 'account' gate would show).
export function createNeedsTerms ({ hosted, claim } = {}) {
  if (hosted !== true) return false
  return claim === null || claim === undefined
}

// The gate's accept button. In the sign-up path accepting only records the
// acceptance and the person presses Criar again (the passkey ceremony needs
// that press), so it does not promise to continue.
export function acceptLabel ({ create } = {}, otherwise = 'Aceitar e continuar') {
  return create === true ? 'Aceitar' : otherwise
}

const GATE_DECISIONS = ['needed', 'updated', 'account']

// Before the node connects the mode is unknown: node.hosted and the passkey
// arrive only with the connection, so termsDecision runs as if native and
// would put the gate ahead of Entrar. Where the connection may still turn
// out hosted (the hosted page, or an app pointed at an installation, with no
// configuration of its own), the render goes on as if the terms passed: the
// connecting splash, then Conexão after its patience. The raw decision (so
// termsOk) is untouched. A failure ('config-error', 'error') and a node with
// its own configuration (native core node, varanda-serve) show the gate as
// before.
export function modeUnknownPass ({ hostedMode, hostedPage, installation, config, phase, decision } = {}) {
  if (hostedMode === true || !GATE_DECISIONS.includes(decision)) return false
  if (phase !== 'loading' && phase !== 'connecting') return false
  if (hostedPage !== true && (typeof installation !== 'string' || installation === '')) return false
  return config === null || config === undefined || (isObject(config) && config.kind === 'hosted')
}

// After Entrar on a device with no diary for that key, the key is known only
// once Identidade's afterUnlock has created the diary and read the status
// again. In between the state is hosted, unlocked, no member and no claim,
// and termsDecision says 'needed': the splash stands in for the gate while
// the recovery runs, at most RECOVER_WAIT_MS from when that state began.
// window: that state (the caller times it); wait: the splash.
//
// A sign-in that opened no account stops on the empty card
// (src/emptyAccount.js) with the recovery still on, before any diary: on a
// device without accepted Termos that is this same state. card: the card is
// up for the unlocked identity (emptyCardShown), so the shell renders it,
// neither the splash nor the gate; the window is closed meanwhile, so its
// wait starts again when 'Criar conta com ela' takes the card down.
export const RECOVER_WAIT_MS = 15000

export function recoverView ({ hosted, locked, member, claim, decision, recovering, elapsedMs, card, status } = {}) {
  const open = hosted === true && locked === false &&
    (claim === null || claim === undefined) &&
    decision === 'needed'
  const shown = open && emptyCardShown(card, { locked, status })
  const window = open && !shown && (member === null || member === undefined)
  const wait = window && recovering === true &&
    Number.isFinite(elapsedMs) && elapsedMs >= 0 && elapsedMs < RECOVER_WAIT_MS
  return { window, wait, card: shown }
}

// The held check in one render. ask: start the question now (the render
// already waits, so the gate never shows for the frame before the effect).
// offline: the gate shows while offline, so the question is settled 'none'
// and a reconnect never swaps a visible gate for a wait. wait: the splash
// instead of the gate.
export function heldView ({ hosted, member, claim, decision, online, entry, nowMs } = {}) {
  const ask = shouldAskHeld({ hosted, member, claim, decision, online, entry })
  const offline = !ask && online === false && shouldAskHeld({ hosted, member, claim, decision, online: true, entry })
  const elapsedMs = isObject(entry) && Number.isFinite(entry.at) ? nowMs - entry.at : NaN
  const wait = ask || heldGate({ decision, entry, elapsedMs }) === 'wait'
  return { ask, offline, wait }
}

// termsHeldFinish's answer as a heldSettle outcome. Only a string counts as
// held (account.js has checked the version and the date); null (an older
// service) and acceptedAt null are 'none'.
export function heldOutcome (answer) {
  return isObject(answer) && typeof answer.acceptedAt === 'string' ? 'held' : 'none'
}
