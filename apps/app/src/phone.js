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
