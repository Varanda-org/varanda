// Momentos: strip order, viewer navigation and the reply context, from what
// the node already read. Pure: no React, no react-native, no Node built-ins.

export const MOMENT_MS = 24 * 60 * 60 * 1000
export const AUTO_ADVANCE_MS = 5000

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)

export function seenKey (ref) {
  return typeof ref === 'string' ? ref : ''
}

function seenHas (seenRefs, ref) {
  const key = seenKey(ref)
  if (key === '') return false
  if (seenRefs instanceof Set) return seenRefs.has(key)
  if (Array.isArray(seenRefs)) return seenRefs.includes(key)
  if (isObject(seenRefs)) return seenRefs[key] === true
  return false
}

const itemsOf = (author) => (isObject(author) && Array.isArray(author.items) ? author.items : [])

function hasUnseen (author, seenRefs) {
  return itemsOf(author).some((item) => isObject(item) && !seenHas(seenRefs, item.ref))
}

// Own first (when present), then authors with any unseen item, then fully
// seen ones; each group keeps the input order (newest first from the node).
export function ringOrder (authors, seenRefs, ownKey) {
  const list = Array.isArray(authors) ? authors.filter(isObject) : []
  const own = []
  const unseen = []
  const seen = []
  for (const author of list) {
    if (typeof ownKey === 'string' && author.author === ownKey) own.push(author)
    else if (hasUnseen(author, seenRefs)) unseen.push(author)
    else seen.push(author)
  }
  return own.concat(unseen, seen)
}

export function firstUnseenIndex (items, seenRefs) {
  if (!Array.isArray(items)) return 0
  const index = items.findIndex((item) => isObject(item) && !seenHas(seenRefs, item.ref))
  return index === -1 ? 0 : index
}

export function nextIndex (i, length, dir) {
  if (!Number.isInteger(i) || !Number.isInteger(length) || length < 1 || i < 0 || i >= length) return null
  const to = dir === 'next' ? i + 1 : dir === 'prev' ? i - 1 : null
  if (to === null || to < 0 || to >= length) return null
  return to
}

// The PR3 openMessage context for "Responder". `kind` names it a moment in
// the chip and the sent prefix (privateReply.js), never 'a sua publicação'.
export function replyContext (moment, author) {
  return { kind: 'moment', author, seq: moment.seq, at: moment.at, text: moment.text, hasMedia: true }
}

export function canReply (node) {
  return isObject(node) && node.hosted === true
}

export function expiresIn (at, now = Date.now()) {
  const start = new Date(String(at)).getTime()
  if (Number.isNaN(start)) return 0
  return Math.max(0, start + MOMENT_MS - now)
}

// Progress bar fill of each segment: 1 done, 0 not yet; the current one is
// reported as its position so the screen animates it.
export function progressOf (index, length) {
  if (!Number.isInteger(length) || length < 1) return []
  const out = []
  for (let n = 0; n < length; n++) out.push(n < index ? 1 : 0)
  return out
}
