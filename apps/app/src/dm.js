// Conversation list and thread for Conversas. No UI runtime and no Node
// built-ins, so the Node tests can load it. Peer text is untrusted and goes
// through displayText before a row can show it.

import rpc from '@varanda/rpc'

const { displayText } = rpc

// dm.send's answer when the put was written but no ack came back: the
// uncertain signal (rpc 5.75), shared by every screen that sends.
export const UNSURE_SEND = 'não deu para confirmar o envio'

export const LABELS = Object.freeze({
  accept: 'Aceitar',
  decline: 'Recusar',
  block: 'Bloquear mensagens',
  unblock: 'Desbloquear mensagens',
  delete: 'Apagar conversa neste aparelho',
  report: 'Denunciar',
  reply: 'Responder',
  message: 'Mensagem',
  newMessage: 'Nova mensagem',
  requests: 'Pedidos de mensagem',
  emptyInbox: 'Nenhuma conversa ainda. Abra o perfil de alguém e toque em Mensagem.',
  emptyRequests: 'Nenhum pedido de mensagem',
  requestNote: 'Até você aceitar, quem enviou não sabe se você leu',
  noBox: 'Esta pessoa ainda não recebe mensagens',
  blockedSend: 'Você bloqueou esta pessoa',
  selfSend: 'Não é possível enviar para si',
  noStamps: 'O limite de envio de hoje acabou',
  tooLong: 'Mensagem longa demais',
  sent: 'Enviada',
  uncertain: 'Não deu para confirmar o envio. Tentar de novo manda a mesma mensagem.',
  deletedQuote: 'respondendo a uma mensagem apagada neste aparelho',
  olderQuote: 'respondendo a uma mensagem anterior',
  reportNote: 'Só esta mensagem e a conta de quem enviou vão para a moderação. Nada mais da conversa.'
})

export function selectorItems () {
  return [
    { id: 'mensagens', label: 'Mensagens' },
    { id: 'comunidades', label: 'Comunidades' }
  ]
}

// Date.parse, not string order: a negative-year ISO date sorts wrong as text
// (notices.js compareNotices).
function timeOf (item) {
  if (!item || typeof item.at !== 'string') return null
  const n = Date.parse(item.at)
  return Number.isFinite(n) ? n : null
}

function peerOf (item) {
  return item && typeof item.peer === 'string' ? item.peer : ''
}

function comparePeer (a, b) {
  const pa = peerOf(a)
  const pb = peerOf(b)
  if (pa < pb) return -1
  if (pa > pb) return 1
  return 0
}

// Newest first. A missing instant sorts after every readable one, then peer
// ascending, so two rows at the same instant do not follow arrival order.
function compareConversations (a, b) {
  const ta = timeOf(a)
  const tb = timeOf(b)
  if (ta !== null && tb !== null && ta !== tb) return tb - ta
  if (ta !== null && tb === null) return -1
  if (ta === null && tb !== null) return 1
  return comparePeer(a, b)
}

export function sortConversations (items) {
  if (!Array.isArray(items)) return []
  return items.filter((item) => item && typeof item === 'object').sort(compareConversations)
}

// Any other folder is dropped: a bad row must not show up under Mensagens.
export function splitFolders (items) {
  const inbox = []
  const requests = []
  if (!Array.isArray(items)) return { inbox, requests }
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    if (item.folder === 'inbox') inbox.push(item)
    else if (item.folder === 'request') requests.push(item)
  }
  return { inbox, requests }
}

// The tab shows a dot, never a number, and only for a row marked unread.
// Nothing here is told to the other person.
function hasUnread (list) {
  if (!Array.isArray(list)) return false
  for (const item of list) {
    if (item && item.unread === true) return true
  }
  return false
}

export function tabDot (folders) {
  const box = folders && typeof folders === 'object' ? folders : null
  if (!box) return false
  return hasUnread(box.inbox) || hasUnread(box.requests)
}

export function requestsDot (requests) {
  return hasUnread(requests)
}

// Oldest first, so the newest line sits at the bottom. A replyTo id becomes
// that message's text. A message marked deleted quotes LABELS.deletedQuote
// instead of its text. No quote stays null; an id that is not among the loaded rows quotes
// LABELS.olderQuote.
function compareMessages (a, b) {
  const ta = timeOf(a)
  const tb = timeOf(b)
  if (ta !== null && tb !== null && ta !== tb) return ta - tb
  if (ta !== null && tb === null) return -1
  if (ta === null && tb !== null) return 1
  if (a.id < b.id) return -1
  if (a.id > b.id) return 1
  return 0
}

function shownText (value) {
  return typeof value === 'string' ? displayText(value, { multiline: true }) : ''
}

function quoteOf (ref, byId) {
  if (typeof ref !== 'string' || ref.length === 0) return null
  const target = byId.get(ref)
  if (!target) return LABELS.olderQuote
  if (target.deleted === true) return LABELS.deletedQuote
  return typeof target.text === 'string' ? displayText(target.text, { multiline: true }) : null
}

function isMessage (message) {
  if (!message || typeof message !== 'object') return false
  return typeof message.id === 'string' && message.id.length > 0
}

export function threadOf (messages) {
  const list = Array.isArray(messages) ? messages.filter(isMessage) : []
  const ordered = list.sort(compareMessages)
  // dm.thread rows have one id per thread (@varanda/core lib/dm-fold.js);
  // should two rows share one, the smaller sender key wins, as replyTarget
  // does.
  const byId = new Map()
  for (const message of ordered) {
    const held = byId.get(message.id)
    if (held === undefined || String(message.from) < String(held.from)) byId.set(message.id, message)
  }
  return ordered.map((message) => {
    const deleted = message.deleted === true
    return {
      id: message.id,
      at: typeof message.at === 'string' ? message.at : null,
      text: deleted ? '' : shownText(message.text),
      deleted,
      replyTo: quoteOf(message.replyTo, byId)
    }
  })
}
