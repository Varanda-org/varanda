import rpc from '@varanda/rpc'
import { canReply, MOMENT_MS } from './moments.js'
import { UNSURE_SEND } from './dm.js'

export const REACTION_SENT = 'Reação enviada.'
export const REACTION_UNSURE = 'Não deu para confirmar o envio. Confira a conversa antes de tentar de novo.'
export const MOMENT_GONE = 'Momento indisponível'

const isSequence = (seq) => Number.isSafeInteger(seq) && seq >= 1

export function canReact (node) {
  return canReply(node) && node.online === true && node.passkey?.status?.unlocked === true
}

export function reactionParams (item, author, emoji) {
  if (!rpc.isKey(author) || !isSequence(item?.seq) || !rpc.isReaction(emoji)) return null
  return { to: author, text: emoji, moment: item.seq }
}

export function isMomentReaction (row) {
  return isSequence(row?.moment) && rpc.isReaction(row.rawText)
}

export function momentAuthor (row, { peer, ownKey }) {
  return row.mine ? peer : ownKey
}

export function reactionLabel (mine) {
  return mine ? 'Você reagiu a um momento' : 'Reagiu ao seu momento'
}

export function unsure (err) {
  return err?.uncertain === true || err?.message === UNSURE_SEND
}

// moment.lookup answers `at` as the record's ISO string, never a number.
function momentStart (at) {
  if (typeof at !== 'string') return null
  const start = Date.parse(at)
  return Number.isFinite(start) ? start : null
}

export function previewPlan (lookup) {
  if (!lookup || typeof lookup !== 'object' || Array.isArray(lookup) ||
      momentStart(lookup.at) === null || !isSequence(lookup.w) || !isSequence(lookup.h)) {
    return { kind: 'gone' }
  }
  if (rpc.MEDIA_MIMES.includes(lookup.mime) && lookup.ms === 0) return { kind: 'image' }
  if (lookup.mime === rpc.VIDEO_MIME && isSequence(lookup.ms)) return { kind: 'video' }
  return { kind: 'gone' }
}

export function previewUntil (lookup) {
  const start = momentStart(lookup?.at)
  return start === null ? null : start + MOMENT_MS
}
