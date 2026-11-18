// Conversas on a node that sends text only: a core node's engine
// (packages/web-member/lib/core-dm.js) refuses media and link cards with
// DM_TEXT_ONLY before any upload, and its handle offers no media.putDm. The
// composer then offers no photo, voice or video and attaches no card, so
// nothing is refused after the person pressed send. No imports: Metro
// bundles the file and the tests load it with import().

export const DM_TEXT_ONLY = 'mídia disponível só na versão web'

// -> true for a node that is not hosted and offers no media.putDm.
export function dmTextOnly (node) {
  if (!node || node.hosted !== false) return false
  return !(node.media && typeof node.media.putDm === 'function')
}

// The engine's refusal, should a card or an item still reach it.
export function isTextOnlyRefusal (err) {
  return !!err && err.message === DM_TEXT_ONLY
}
