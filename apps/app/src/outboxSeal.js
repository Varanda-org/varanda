// The sealed outbox in the app (./outbox item v2): what OutboxProvider does
// with the node's outbox.seal and outbox.open, kept out of React so the rules
// are tested in Node. No React, no react-native, no Node built-ins.
//
// `opened` is the provider's in-memory cache: Map id -> { key, to, text },
// filled only from the node's answers (or from `add`, which sealed that text
// itself) and never persisted. `key` binds an entry to the exact stored item
// (id, author, association, kind, writtenAt, box), so an item changed in
// storage after it was opened is not open any more.
//
// `allowed` is the approval map of outboxProvider.js: id -> fingerprint.

import {
  CLOSED_MESSAGE, LOCKED_MESSAGE, NO_NODE_MESSAGE, SESSION_CLOSED_MESSAGE, TOO_MANY_MESSAGE,
  checkDraft, hydrate, openParams, reconcile, remove, sealParams, sealedItem, storedItem, validBox
} from './outbox'

// The node's refusals by contract name (outbox.seal / outbox.open in
// docs/rpc.md), matched on err.code, then on the whole err.message, then on
// a message prefix: a different name on the node side is one line here. The
// web-member session answers USAGE with these messages. A box the node's
// validator refuses ('parâmetro inválido: box') is not this item's sealed
// form either, so outbox.open drops it like BAD_BOX; any other field it
// refuses only skips the item (reviveItem in ./outbox keeps what the
// validators accept, so that should not happen).
export const SEAL_ERRORS = Object.freeze({
  locked: Object.freeze({ codes: ['LOCKED'], messages: [LOCKED_MESSAGE], prefixes: [] }),
  wrongAuthor: Object.freeze({ codes: ['WRONG_AUTHOR'], messages: ['item da fila de saída de outra identidade'], prefixes: [] }),
  badBox: Object.freeze({ codes: ['BAD_BOX'], messages: ['item da fila de saída inválido', 'parâmetro inválido: box'], prefixes: [] })
})

// No further call can succeed now either (the node is gone, or too busy).
const GONE = Object.freeze({ codes: ['CLOSED', 'TIMEOUT'], messages: [CLOSED_MESSAGE, NO_NODE_MESSAGE, SESSION_CLOSED_MESSAGE, TOO_MANY_MESSAGE], prefixes: [] })

// A definitive refusal of this request: asking again gives the same answer
// (a USAGE error, the validators' messages, an older node without the
// method).
const REFUSED = Object.freeze({
  codes: ['USAGE'],
  messages: ['método desconhecido', 'params inválidos', 'parâmetro desconhecido'],
  prefixes: ['parâmetro inválido', 'parâmetro obrigatório']
})

function matches (err, rule) {
  if (err === null || typeof err !== 'object') return false
  if (typeof err.code === 'string' && rule.codes.includes(err.code)) return true
  if (typeof err.message !== 'string') return false
  return rule.messages.includes(err.message) || rule.prefixes.some((prefix) => err.message.startsWith(prefix))
}

// What a pass does after a failed call: 'stop' (locked, the node is gone or
// too busy), 'drop' (outbox.open says the box is not this item's: planted or
// altered), 'skip' (a definitive refusal, e.g. another identity's item or an
// older node without the method: the item stays, never sent, and the pass
// goes on), 'retry' (anything else, e.g. INTERNAL: the item stays, the pass
// goes on and ends 'retry', so the provider runs it again later).
export function failureAction (err, method) {
  if (matches(err, SEAL_ERRORS.locked) || matches(err, GONE)) return 'stop'
  if (method === 'outbox.open' && matches(err, SEAL_ERRORS.badBox)) return 'drop'
  if (matches(err, SEAL_ERRORS.wrongAuthor) || matches(err, SEAL_ERRORS.badBox) || matches(err, REFUSED)) return 'skip'
  return 'retry'
}

// Whether the provider runs another pass later, on its retry timer.
export function passAgainLater (result) {
  return result === 'stopped' || result === 'retry'
}

// Whether `add` keeps in memory the clear text it just had sealed: only while
// the identity it captured before the seal (`before`, the provider's
// identityRef value) is still the unlocked one at the save (`now`) and is the
// item's author. After a lock or a switch the item is saved sealed only, and
// the next open pass opens it for the identity it belongs to.
export function keepsClearText (before, now, author) {
  return before !== null && before !== undefined && before === now && before.key === author
}

export function sealKey (item) {
  return JSON.stringify([item.id, item.author, item.association, item.kind, item.writtenAt, item.box])
}

// { to, text } of an open item, or null.
export function openedOf (opened, item) {
  if (item.v !== 2) return null
  const entry = opened.get(item.id)
  if (!entry || entry.key !== sealKey(item)) return null
  return { to: entry.to, text: entry.text }
}

export function remember (opened, item, { to, text }) {
  opened.set(item.id, { key: sealKey(item), to, text })
}

// What an approval covers. The box seals the target and the text with the
// item's fields, so another box (another text, or a planted one) is another
// approval. A v1 item is never approved: it is sealed first.
export function fingerprintOf (item) {
  if (item.v !== 2 || !validBox(item.box)) return null
  return JSON.stringify([item.author, item.association, item.kind, item.box])
}

export function approved (allowed, item) {
  const fingerprint = fingerprintOf(item)
  return fingerprint !== null && allowed.get(item.id) === fingerprint
}

// The items the drain may send: approved and open, as open items (the text
// it signs is only ever the one the node opened from this box).
export function sendable (items, allowed, opened) {
  const out = []
  for (const item of items) {
    if (!approved(allowed, item)) continue
    const o = openedOf(opened, item)
    if (o !== null) out.push(hydrate(item, o))
  }
  return out
}

// The items opened in this window, as open items: what the drain reconciles
// and sends, so an item it cannot open (sealed for another key, or not opened
// yet) is never compared with the diary nor sent here.
export function openedOnly (items, opened) {
  const out = []
  for (const item of items) {
    const o = openedOf(opened, item)
    if (o !== null) out.push(hydrate(item, o))
  }
  return out
}

// reconcile (./outbox) on the items opened in this window only; returns the
// stored queue with the result applied (the others untouched, never the
// text). 'none' keeps the same array.
export function reconcileOpened (items, opened, author, association, page, now) {
  const r = reconcile(openedOnly(items, opened), author, association, page, now)
  if (r.status === 'none' || r.status === 'sealed') return { ...r, items }
  const after = new Map(r.items.map((item) => [item.id, item]))
  const next = []
  for (const item of items) {
    if (openedOf(opened, item) === null) next.push(item)
    else if (after.has(item.id)) next.push(storedItem(after.get(item.id)))
  }
  return { ...r, items: next }
}

// 'apagar' from Diário. An open item still 'sending' stays until reconciled
// (./outbox remove); an item not open in this window goes whatever its
// state: it cannot be reconciled here, and nothing resends it automatically.
export function discardItem (items, id, opened) {
  const item = items.find((other) => other.id === id)
  if (item === undefined) return items
  if (openedOf(opened, item) === null) return items.filter((other) => other.id !== id)
  return remove(items, id)
}

// Whether Diário shows 'apagar' for an item as shownItems returns it.
export function canDiscard (shown) {
  return shown.state !== 'sending' || shown.opened !== true
}

// Open items where the cache has them; the rest as stored (for reconcile).
export function withOpened (items, opened) {
  return items.map((item) => {
    const o = openedOf(opened, item)
    return o === null ? item : hydrate(item, o)
  })
}

// Back to the stored form after a change computed on open items.
export function withoutOpened (items) {
  return items.map(storedItem)
}

// For Diário: open items with `opened: true`; the others with `to` and
// `text` null (a v1 item too: its text shows once it is sealed and open).
export function shownItems (items, opened) {
  return items.map((item) => {
    const o = openedOf(opened, item)
    if (o !== null) return { ...hydrate(item, o), opened: true }
    return { ...item, to: null, text: null, opened: false }
  })
}

// What a pass calls, in queue order: v1 items of the identity are sealed
// (the one-time migration), its v2 items not yet open are opened. Another
// identity's items are left alone.
export function openPlan (items, author, opened) {
  const plan = []
  for (const item of items) {
    if (item.author !== author) continue
    if (item.v === 1) plan.push({ method: 'outbox.seal', item })
    else if (openedOf(opened, item) === null) plan.push({ method: 'outbox.open', item })
  }
  return plan
}

// The stored queue without `item`, only while it is still that sealed item.
export function dropSealed (items, item) {
  const key = sealKey(item)
  const next = items.filter((other) => !(other.id === item.id && other.v === 2 && sealKey(other) === key))
  return next.length === items.length ? items : next
}

// The stored queue with the v1 `item` rewritten as v2 under `box`, only while
// it is still that v1 item.
export function migrate (items, item, box) {
  const before = JSON.stringify(sealParams(item))
  let changed = false
  const next = items.map((other) => {
    if (other.id !== item.id || other.v !== 1 || JSON.stringify(sealParams(other)) !== before) return other
    changed = true
    return sealedItem(other, box)
  })
  return changed ? next : items
}

// A node answer to outbox.open that is a valid target and text for the item.
function openedAnswer (item, answer) {
  if (answer === null || typeof answer !== 'object') return null
  const to = answer.to === undefined ? null : answer.to
  try {
    checkDraft({ author: item.author, association: item.association, kind: item.kind, to, text: answer.text })
  } catch {
    return null
  }
  return { to, text: answer.text }
}

// One pass over the stored queue for the unlocked `author`.
// call(method, params): the node request. mutate(op): read-modify-write of
// the stored queue, true when saved. current(): false once the identity this
// pass began with is no longer unlocked (the pass ends, nothing is cached).
// Returns 'done', 'retry' (it went through, but a call failed for a reason
// that may pass), 'stopped' or 'stale'.
export async function openPass ({ items, author, opened, call, mutate, current }) {
  let retry = false
  for (const { method, item } of openPlan(items, author, opened)) {
    if (!current()) return 'stale'
    let answer
    try {
      answer = await call(method, method === 'outbox.seal' ? sealParams(item) : openParams(item))
    } catch (err) {
      if (!current()) return 'stale'
      const action = failureAction(err, method)
      if (action === 'stop') return 'stopped'
      if (action === 'retry') retry = true
      if (action === 'drop') {
        opened.delete(item.id)
        mutate((fresh) => dropSealed(fresh, item))
      }
      continue
    }
    if (!current()) return 'stale'
    if (method === 'outbox.open') {
      const o = openedAnswer(item, answer)
      if (o !== null) remember(opened, item, o)
      continue
    }
    const box = answer !== null && typeof answer === 'object' ? answer.box : null
    if (!validBox(box)) continue
    let migrated = false
    const saved = mutate((fresh) => {
      const next = migrate(fresh, item, box)
      migrated = next !== fresh
      return next
    })
    if (saved && migrated) remember(opened, sealedItem(item, box), { to: item.to, text: item.text })
  }
  return retry ? 'retry' : 'done'
}
