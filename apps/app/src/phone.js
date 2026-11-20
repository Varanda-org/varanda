// Hosted phone check (Brazilian mobile). Pure ES module: imports nothing, so
// Node's import() tests every branch.
//
// Order is the owner decision of 2026-11-11. `vouched` and `sinceHeld` are
// booleans the screen read from node.info, which the node already checked
// against the issuer. A device record is never an input: storage on the
// origin can be written by anything on the page (the same rule as
// src/ageMemory.js). A fresh 'nenhum' from the service beats a held proof,
// and a policy that says the check is off beats a verdict once the node is
// hosted. A missing policy still blocks ('loading'); a failed read blocks
// only when the node holds the association's phone-since attestation.

// Copied from packages/core/lib/phone.js. The app cannot import
// @varanda/core (see src/legal.js), so the Brazilian mobile pattern lives
// here too: area code without a 0, then the mobile 9 and eight digits.
export const BR_MOBILE_RE = /^\+55[1-9][1-9]9[0-9]{8}$/

// The service only accepts E.164. Separators are what a person types.
export function toBrMobile (text) {
  if (typeof text !== 'string') return null
  const compact = text.replace(/[\s().-]/g, '')
  let e164 = compact
  if (/^[1-9][1-9]9[0-9]{8}$/.test(compact)) e164 = '+55' + compact
  else if (/^55[1-9][1-9]9[0-9]{8}$/.test(compact)) e164 = '+' + compact
  return BR_MOBILE_RE.test(e164) ? e164 : null
}

export function isCode (text) {
  return typeof text === 'string' && /^[0-9]{6}$/.test(text)
}

// The code field's text: digits only, then the first six, so a pasted
// "123-456" keeps all six digits.
export function codeDigits (text) {
  return typeof text === 'string' ? text.replace(/[^0-9]/g, '').slice(0, 6) : ''
}

const isPlainObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x)

export function phoneGate ({ hosted, policy, state, vouched, sinceHeld } = {}) {
  if (hosted !== true) return 'off'
  if (isPlainObject(policy) && policy.required === false) return 'off'
  if (state === 'verificado') return 'ok'
  if (state === 'nenhum') return 'needed'
  if (vouched === true) return 'ok'
  if (isPlainObject(policy) && policy.required === true) return 'loading'
  if (policy === undefined) return 'loading'
  if (sinceHeld === true) return 'needed'
  return 'off'
}

export function phoneBlocking (gate) {
  return gate === 'loading' || gate === 'needed'
}

// Whether the member's phone status may be asked of the service now. Strict:
// anything doubtful is false, same shape as ageReadAllowed.
export function phoneReadAllowed ({ hosted, ready, termsOk, locked, member, policyKnown, policyRequired } = {}) {
  return hosted === true && ready === true && termsOk === true && locked === false &&
    typeof member === 'string' && policyKnown === true && policyRequired === true
}

export const PHONE_UNAVAILABLE_TEXT = 'A confirmação do celular está fora do ar agora. Tente de novo mais tarde.'

// A definite "unavailable" gets the phone wording. Anything else, including
// an uncertain outcome, is left to the caller.
export function phoneErrorText (err) {
  if (err && err.code === 'indisponivel' && err.uncertain !== true) return PHONE_UNAVAILABLE_TEXT
  return null
}

export const PHONE_SENT_TEXT = 'Enviamos um código para o seu celular.'
export const PHONE_UNCERTAIN_TEXT = 'Não deu para confirmar o envio. Se o código chegar, digite abaixo.'

// A canonical ISO date (Date#toISOString), the shape of an attestation's
// date and of node.info's phoneVerifiedDate.
export function isIsoDate (s) {
  if (typeof s !== 'string' || s.length !== 24) return false
  const d = new Date(s)
  return !Number.isNaN(d.getTime()) && d.toISOString() === s
}

// Whether Ajustes shows 'Trocar o celular': an unlocked passkey account on a
// hosted node whose phone gate is open, for a known member (the shell's,
// which markVerified accepts a proof under). The same rule on the web page
// and on the app's in-app web node: both hold a passkey there.
export function phoneChangeShown ({ hosted, hasPasskey, unlocked, gate, member } = {}) {
  return hosted === true && hasPasskey === true && unlocked === true && gate === 'ok' && typeof member === 'string'
}

// Trocar o celular: the service never returns the number, only the date of
// the live verification in a 'verificado' answer's proof (a recorded number
// is a new row with a new date). `before` is the date known when the screen
// opened, `after` the answer's. A doubtful date proves nothing.
export function phoneChange (before, after) {
  if (!isIsoDate(before) || !isIsoDate(after)) return 'unknown'
  const a = Date.parse(after)
  const b = Date.parse(before)
  if (a > b) return 'changed'
  if (a === b) return 'same'
  return 'unknown'
}

export const PHONE_CHANGED_TEXT = 'Celular atualizado.'
export const PHONE_SAME_TEXT = 'Esse já é o seu celular.'
export const PHONE_NOT_CHANGED_TEXT = 'O número ainda não mudou. Confirme o código de novo ou peça outro.'
export const PHONE_CHANGE_UNKNOWN_TEXT = 'Não deu para saber se o número mudou. Se precisar, troque de novo.'

// via: 'send' (the service answered 'verificado' to a send: the number typed
// is already the member's live one, so no code went, whatever the dates
// say), 'check' (to a code) or 'recheck' (the status read after a check
// whose outcome was unknown). stay: the Trocar screen keeps its code field,
// since the service holds an approved code that a new check can still record.
export function phoneChangeOutcome ({ via, before, after } = {}) {
  if (via === 'send') return { stay: false, text: PHONE_SAME_TEXT }
  const change = phoneChange(before, after)
  if (change === 'changed') return { stay: false, text: PHONE_CHANGED_TEXT }
  if (change === 'same' && via === 'recheck') return { stay: true, text: PHONE_NOT_CHANGED_TEXT }
  return { stay: false, text: PHONE_CHANGE_UNKNOWN_TEXT }
}
