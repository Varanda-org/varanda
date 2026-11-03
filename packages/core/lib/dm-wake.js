'use strict'

// The Web Push wake for a stored DM drop. It names nobody: no sender, no
// recipient, no drop id. The account service answers it with one coalesced
// fan-out to every subscription, so the push service learns only that some
// drop landed somewhere. Pure: no I/O, no clock, never throws.

const DM_WAKE_COOLDOWN_MS = 15 * 60 * 1000
const DM_WAKE_TEXT = 'Pode haver uma mensagem nova na Varanda'

function validateDmWake (ev) {
  if (ev === null || typeof ev !== 'object' || Array.isArray(ev)) return false
  const proto = Object.getPrototypeOf(ev)
  if (proto !== Object.prototype && proto !== null) return false
  const keys = Object.keys(ev)
  return keys.length === 2 &&
    Object.prototype.hasOwnProperty.call(ev, 'v') &&
    Object.prototype.hasOwnProperty.call(ev, 'kind') &&
    ev.v === 1 &&
    ev.kind === 'dm-wake'
}

module.exports = {
  DM_WAKE_COOLDOWN_MS,
  DM_WAKE_TEXT,
  validateDmWake
}
