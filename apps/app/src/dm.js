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
  noBox: 'Esta pessoa ainda não recebe mensagens. Assim que ela abrir o Varanda com a versão nova, dá para escrever.',
  blockedSend: 'Você bloqueou esta pessoa',
  selfSend: 'Não é possível enviar para si',
  noStamps: 'O limite de envio de hoje acabou',
  tooLong: 'Mensagem longa demais',
  sent: 'Enviada',
  uncertain: 'Não deu para confirmar o envio. Tentar de novo manda a mesma mensagem.',
  deletedQuote: 'respondendo a uma mensagem apagada neste aparelho',
  olderQuote: 'respondendo a uma mensagem anterior',
  missingQuote: 'respondendo a uma mensagem que não está neste aparelho',
  reportNote: 'Só esta mensagem e a conta de quem enviou vão para a moderação. Nada mais da conversa.'
})

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
// LABELS.olderQuote, and a bound reply whose message this device does not
// hold quotes LABELS.missingQuote.
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

// The loaded rows a quote can point at: by sender and id, and by id alone
// for a bare-id reply. dm.thread rows have one id per thread (@varanda/core
// lib/dm-fold.js); should two rows share one, the smaller sender key wins,
// as replyTarget does.
export function quoteIndex (messages) {
  const byKey = new Map()
  const byId = new Map()
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!isMessage(message)) continue
    byKey.set(String(message.from) + ':' + message.id, message)
    const held = byId.get(message.id)
    if (held === undefined || String(message.from) < String(held.from)) byId.set(message.id, message)
  }
  return { byKey, byId }
}

// What a message quotes: null for no reply, else { missing, target }. A
// bound reply (rpc 5.78) carries `replyFrom` when this device holds the
// message it was made for, found here by sender and id, and
// `replyMissing` when it does not: then there is no target, never another
// message under that id. A bare id from an earlier build is found by id.
// target null with missing false: not among the loaded rows.
export function quoteOf (message, index) {
  const ref = message && typeof message === 'object' ? message.replyTo : null
  if (typeof ref !== 'string' || ref.length === 0) return null
  if (message.replyMissing === true) return { missing: true, target: null }
  const target = typeof message.replyFrom === 'string'
    ? index.byKey.get(message.replyFrom + ':' + ref)
    : index.byId.get(ref)
  return { missing: false, target: target || null }
}

function quoteText (quote) {
  if (quote === null) return null
  if (quote.missing) return LABELS.missingQuote
  const target = quote.target
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
  const index = quoteIndex(ordered)
  return ordered.map((message) => {
    const deleted = message.deleted === true
    return {
      id: message.id,
      at: typeof message.at === 'string' ? message.at : null,
      text: deleted ? '' : shownText(message.text),
      deleted,
      replyTo: quoteText(quoteOf(message, index))
    }
  })
}
