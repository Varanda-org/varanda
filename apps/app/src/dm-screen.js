// Pure helpers for the Conversas screens (Mensagens, Mensagem). No platform
// imports, so they run in the tests.

import { threadOf, quoteIndex, quoteOf } from './dm.js'
import { dayHeading } from './format.js'
import { sendPlan as attachmentSendPlan } from './attach-plan.js'
import { plainPreview } from './chatPreview.js'

export function dmReactions (reactions) {
  return (Array.isArray(reactions) ? reactions : [])
    .filter((row) => row && typeof row.emoji === 'string' && row.emoji !== '')
    .map((row) => ({ emoji: row.emoji, count: 1, mine: row.mine === true }))
}

// dm.thread marks a row that takes no reaction (stored before message
// digests) with reactable: false; the node refuses dm.react on it.
export function dmReactable (message) {
  return !!message && !message.deleted && message.reactable !== false
}

// A held older row takes only the reaction state of a fresh read: its
// reactions and its reactable mark.
export function withFreshReactions (row, fresh) {
  const { reactable, ...rest } = row
  return { ...rest, reactions: fresh.reactions, ...(fresh.reactable === false ? { reactable: false } : {}) }
}

// An incomplete answer can identify a person; an index hint cannot hide chips.
export function dmReactionGate ({ read, peer, peerKind, pageKey = null, hosted, unlocked, online, isTop, blocked, folder }) {
  const hidden = pageKey !== null || peerKind === 'page'
  const disabled = hidden || read?.page !== peer || !hosted || !unlocked || !online || !isTop || blocked || folder !== 'inbox'
  return { hidden, disabled }
}

// Keep the first choice across the whole burst: returning to it costs no stamps.
export function reactDebounce (ms = 600, clock = globalThis) {
  const pending = new Map()
  const cancel = (key) => {
    const entry = pending.get(key)
    if (!entry) return
    clock.clearTimeout(entry.timer)
    pending.delete(key)
    entry.onCancel()
  }
  const dispatch = (key, flushing = false) => {
    const entry = pending.get(key)
    if (!entry) return
    clock.clearTimeout(entry.timer)
    pending.delete(key)
    if (entry.emoji === entry.starting && !entry.retry) entry.onCancel()
    else entry.send(entry.emoji, flushing)
  }
  return {
    has: (key) => pending.has(key),
    flush: () => { for (const key of pending.keys()) dispatch(key, true) },
    cancel,
    clear: () => { for (const key of pending.keys()) cancel(key) },
    schedule (key, starting, emoji, send, onCancel = () => {}, retry = false) {
      const previous = pending.get(key)
      if (previous) clock.clearTimeout(previous.timer)
      const entry = { starting: previous ? previous.starting : starting, emoji, send, onCancel, retry }
      entry.timer = clock.setTimeout(() => dispatch(key), ms)
      pending.set(key, entry)
    }
  }
}

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
      reactions: dmReactions(source.reactions),
      from: typeof source.from === 'string' ? source.from : null,
      rawText: typeof source.text === 'string' ? source.text : ''
    }
  })
}

// What each message quotes among the loaded rows, by the message's key: the
// { missing, target } of dm.js quoteOf, target a row of `rows`. The same
// rule threadOf gives the quoted text, so a quote's author, text and scroll
// target always name one message.
export function quoteTargets (messages, rows) {
  const index = quoteIndex(rows)
  const out = new Map()
  for (const m of Array.isArray(messages) ? messages : []) {
    const quote = quoteOf(m, index)
    if (quote !== null) out.set(messageKey(m), quote)
  }
  return out
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

// A measured end can still grow as FlatList renders its remaining batches.
// Animated scrollToEnd frames move down and must not release the pin.
export function pinToEnd (state, event) {
  const next = { ...state }
  if (event.kind === 'newest' && event.newest !== state.newest) {
    next.pinned = true
    next.newest = event.newest
  } else if (event.kind === 'user') {
    next.pinned = false
  } else if (event.kind === 'frame') {
    if (state.lastY !== null && event.y < state.lastY - 48) next.pinned = false
    next.lastY = event.y
  }
  return next
}

// One line for a conversation preview: a line break would show as U+FFFD.
export function previewLine (value) {
  return plainPreview(value).replace(/\r?\n/g, ' ')
}

// Enviar while a send is held as uncertain: the same text and quote re-put
// the held bytes ('retry'); a different text asks first ('confirm'), since
// the held one may already have reached the peer. No hold: a plain 'send'.
export function sendPlan (hold, text, quoteId, attachments = []) {
  return attachmentSendPlan(hold, text, quoteId, attachments)
}

// Conversas as a page: the screens call the same dm.* names. The page's
// conversations live on this device (docs/rpc.md 5.114): dm.list, dm.thread
// and dm.seen read the node with `page`; dm.send and dm.set draft on the
// node (dm.pageDraft), the page signs the digest ('dm-sign', `sign(digest)`,
// answering { signature, expiresAt }: the service picks the expiry) and the
// node sends it (dm.pageSend). An uncertain dm.pageSend keeps a retry of that
// exact request; nothing is drafted or signed again.
export const PAGE_DM_CUSTODY = 'Só quem administra a página lê estas mensagens'
export const PAGE_DM_UNSURE = 'não deu para confirmar o envio'

export function pageInboxTitle (name) {
  const shown = typeof name === 'string' ? name.trim() : ''
  return shown === '' ? 'Conversas da página' : 'Conversas da página ' + shown
}

const PAGE_READS = ['dm.list', 'dm.thread', 'dm.seen']

export function pageDmClient ({ request, sign, page }) {
  const send = async (draftParams) => {
    const draft = await request('dm.pageDraft', { page, ...draftParams })
    const { signature, expiresAt } = await sign(draft.digest)
    const params = { page, id: draft.id, signature, expiresAt }
    const put = () => request('dm.pageSend', params).catch((err) => {
      if (err && (err.uncertain === true || err.message === PAGE_DM_UNSURE)) {
        err.uncertain = true
        err.retry = put
      }
      throw err
    })
    return put()
  }
  return async (method, params = {}) => {
    if (PAGE_READS.includes(method)) return request(method, { ...params, page })
    if (method === 'dm.pull') return request('dm.pull', {})
    if (method === 'dm.send') {
      const { to, text, replyTo, fwd } = params
      const op = { kind: 'msg', to, text }
      if (replyTo !== undefined) op.replyTo = replyTo
      if (fwd !== undefined) op.fwd = fwd
      return send(op)
    }
    if (method === 'dm.set') {
      await send({ kind: 'ctl', peer: params.peer, op: params.state })
      return { ok: true }
    }
    return {}
  }
}
