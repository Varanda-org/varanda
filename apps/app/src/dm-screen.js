// Pure helpers for the Conversas screens (Mensagens, Mensagem). No platform
// imports, so they run in the tests.

import { threadOf } from './dm.js'
import { dayHeading } from './format.js'
import { sendPlan as attachmentSendPlan } from './attach-plan.js'

// A message id is unique only per sender (docs/rpc.md 5.78): a row is keyed
// by sender and id together.
export function messageKey (message) {
  const from = message && typeof message.from === 'string' ? message.from : ''
  const id = message && typeof message.id === 'string' ? message.id : ''
  return from + ':' + id
}

function timeOf (value) {
  const t = typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isFinite(t) ? t : null
}

// Same order as threadOf (time, then id), refined by sender so two messages
// that share an id and a time still come out in one fixed order.
function compareRows (a, b) {
  const ta = timeOf(a.at)
  const tb = timeOf(b.at)
  if (ta !== null && tb !== null && ta !== tb) return ta - tb
  if (ta !== null && tb === null) return -1
  if (ta === null && tb !== null) return 1
  if (a.id < b.id) return -1
  if (a.id > b.id) return 1
  const fa = typeof a.from === 'string' ? a.from : ''
  const fb = typeof b.from === 'string' ? b.from : ''
  if (fa < fb) return -1
  if (fa > fb) return 1
  return 0
}

// The rows of a thread: threadOf's display text and quote, plus the source
// message's own key, sender, side and raw text. The input is sorted first in
// an order threadOf's stable sort keeps, so rows pair with messages by index
// and nothing is copied between two messages that share an id.
export function threadRows (messages) {
  const list = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && typeof m === 'object' && typeof m.id === 'string' && m.id.length > 0)
    .slice()
    .sort(compareRows)
  const shown = threadOf(list)
  return shown.map((row, i) => {
    const source = list[i]
    return {
      ...row,
      key: messageKey(source),
      mine: source.mine === true,
      from: typeof source.from === 'string' ? source.from : null,
      rawText: typeof source.text === 'string' ? source.text : ''
    }
  })
}

// Maximum duration of a bubble group, measured from its first message.
export const DM_GROUP_MS = 300000

function dayKey (at) {
  const t = timeOf(at)
  if (t === null) return null
  const d = new Date(t)
  return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate()
}

// The same row objects (so keys and the scroll anchor stay), each with a
// dayMark: the day heading on the first row of a local calendar day, else null.
export function withDayMarks (rows, now = Date.now()) {
  let last = null
  return rows.map((row) => {
    const key = dayKey(row.at)
    const mark = key !== null && key !== last ? dayHeading(row.at, now) : null
    if (key !== null) last = key
    return { ...row, dayMark: mark }
  })
}

function joins (a, b) {
  if (!a || !b || a.mine !== b.mine || a.from !== b.from) return false
  if (a.inviteLink) return false
  const ta = timeOf(a.at)
  const tb = timeOf(b.at)
  if (ta === null || tb === null || Math.abs(tb - ta) > DM_GROUP_MS) return false
  return !b.dayMark && dayKey(a.at) === dayKey(b.at)
}

// 'single' | 'first' | 'middle' | 'last': where row i sits in its group. The
// row whose key is breakKey (its menu is open) stays apart from both
// neighbours, so they end their runs instead of facing its full corners.
export function bubbleShape (rows, i, { breakKey = null } = {}) {
  const apart = (a, b) => breakKey !== null && ((a && a.key === breakKey) || (b && b.key === breakKey))
  const joined = (a, b) => !apart(a, b) && joins(a, b)
  let start = i
  while (start > 0 && joined(rows[start - 1], rows[start])) start--
  // Replay from the uninterrupted sender run so time limits stay anchored
  // to each group's first message, regardless of which row renders first.
  for (let j = start + 1; j <= i; j++) {
    if (Math.abs(timeOf(rows[j].at) - timeOf(rows[start].at)) > DM_GROUP_MS) start = j
  }
  const up = start < i
  const down = joined(rows[i], rows[i + 1]) && Math.abs(timeOf(rows[i + 1].at) - timeOf(rows[start].at)) <= DM_GROUP_MS
  if (up && down) return 'middle'
  if (down) return 'first'
  if (up) return 'last'
  return 'single'
}

// An older page prepended to what the screen holds; the held copy wins.
export function mergeMessages (older, current) {
  const out = new Map()
  for (const m of Array.isArray(older) ? older : []) out.set(messageKey(m), m)
  for (const m of Array.isArray(current) ? current : []) out.set(messageKey(m), m)
  return Array.from(out.values())
}

// The newest thread page over what the screen holds, by effective time only
// (never by a tie-break the node may order differently). A held row whose key
// is in the page takes the page's copy. A held row the node no longer returns
// after the page's oldest time (decline, block, delete) goes away. Held rows
// at exactly that time are kept (the page may have cut a tie), and rows
// strictly older stay. An empty page clears everything. Returns
// { messages, keepOlder }: keepOlder false means the older cursor resets to
// the page's own.
export function refreshThread (current, page) {
  const fresh = Array.isArray(page) ? page.filter((m) => m && typeof m.id === 'string') : []
  if (fresh.length === 0) return { messages: [], keepOlder: false }
  let oldest = null
  for (const m of fresh) {
    const t = timeOf(m.at)
    if (t !== null && (oldest === null || t < oldest)) oldest = t
  }
  const seen = new Set(fresh.map(messageKey))
  const kept = (Array.isArray(current) ? current : []).filter((m) => {
    if (!m || seen.has(messageKey(m))) return false
    const t = timeOf(m.at)
    return t !== null && oldest !== null && t <= oldest
  })
  return { messages: kept.concat(fresh), keepOlder: kept.length > 0 }
}

// The key of the node's newest message: the last of the newest page (oldest
// first within a page). Loading an older page never changes it.
export function newestOf (page) {
  const list = Array.isArray(page) ? page.filter((m) => m && typeof m.id === 'string') : []
  return list.length > 0 ? messageKey(list[list.length - 1]) : ''
}

// One line for a conversation preview: a line break would show as U+FFFD.
export function previewLine (value) {
  return typeof value === 'string' ? value.replace(/\r?\n/g, ' ') : ''
}

// Enviar while a send is held as uncertain: the same text and quote re-put
// the held bytes ('retry'); a different text asks first ('confirm'), since
// the held one may already have reached the peer. No hold: a plain 'send'.
export function sendPlan (hold, text, quoteId, attachments = []) {
  return attachmentSendPlan(hold, text, quoteId, attachments)
}

// Conversas as a page: the screens call the same dm.* names and this maps
// them to the page's signed actions. `act(action, op)` is the page's actAs
// bound to its member and key. dm.pull and dm.enable have no page form (the
// service holds the page's box and pulls), so they answer nothing.
export const PAGE_DM_ACTIONS = Object.freeze({
  'dm.list': 'dm-list',
  'dm.thread': 'dm-thread',
  'dm.send': 'dm-send',
  'dm.set': 'dm-set',
  'dm.seen': 'dm-seen'
})

export const PAGE_DM_SOON = 'Conversas da página em breve'
export const PAGE_DM_CUSTODY = 'A associação pode ler as mensagens desta página'

export function pageInboxTitle (name) {
  const shown = typeof name === 'string' ? name.trim() : ''
  return shown === '' ? 'Conversas da página' : 'Conversas da página ' + shown
}

// A service that has no such action yet answers these two: say so, never
// 'Pedido inválido'. Everything else (and uncertain, retry) passes through.
export function pageDmFailure (err) {
  if (!err || (err.code !== 'pedido-invalido' && err.code !== 'nao-encontrado')) return err
  const soon = new Error(PAGE_DM_SOON)
  soon.code = err.code
  return soon
}

export function pageDmRequest (act) {
  return async (method, params) => {
    const action = PAGE_DM_ACTIONS[method]
    if (action === undefined) return {}
    try {
      return await act(action, params || {})
    } catch (err) {
      throw pageDmFailure(err)
    }
  }
}
