// Momentos seen on this device: the refs 'author:seq' of the moments the
// viewer showed. It writes no record and tells nobody (Momentos have no view
// counts); another device keeps its own list. Also the pure helpers the
// strip and the Diário share: the moments.read answer cleaned up, the live
// items of a list and whether the strip shows at all. Pure: the storage is
// injected (momentSeenStore.native.js / .web.js); no React, no react-native.

import { expiresIn } from './moments.js'

export const STORAGE_KEY = 'varanda-moments-seen'
export const FILE_NAME = 'varanda-moments-seen.json'
// A moment lives 24 hours and moments.read answers at most 32 x 4 + 4 live
// items, so the newest 512 cover every ring several times over.
export const SEEN_MAX = 512

const REF = /^([0-9a-f]{64}):([1-9][0-9]*)$/
const HEX64 = /^[0-9a-f]{64}$/

export function isSeenId (s) {
  if (typeof s !== 'string') return false
  const m = REF.exec(s)
  if (!m) return false
  const seq = Number(m[2])
  return Number.isSafeInteger(seq) && String(seq) === m[2]
}

// A stored value back to a clean list: only valid ids, once each, the
// newest SEEN_MAX kept.
export function seenListOf (value) {
  if (!Array.isArray(value)) return []
  const out = []
  const seen = new Set()
  for (const id of value) {
    if (!isSeenId(id) || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out.length > SEEN_MAX ? out.slice(out.length - SEEN_MAX) : out
}

export function withSeen (list, id) {
  const base = seenListOf(list)
  if (!isSeenId(id) || base.includes(id)) return base
  return seenListOf(base.concat([id]))
}

export function createMomentSeenStore ({ read, write }) {
  let memory = null
  let writes = Promise.resolve()
  const listeners = new Set()
  const emit = () => {
    for (const fn of [...listeners]) {
      try { fn(memory.slice()) } catch {}
    }
  }
  return {
    async load () {
      if (memory !== null) return memory.slice()
      try {
        const stored = seenListOf(JSON.parse(await read()))
        if (memory === null) memory = stored
      } catch {}
      return memory === null ? [] : memory.slice()
    },
    async mark (id) {
      if (!isSeenId(id)) return false
      const current = memory !== null ? memory : await this.load()
      if (current.includes(id)) return true
      memory = withSeen(current, id)
      emit()
      const raw = JSON.stringify(memory)
      const pending = writes.then(() => write(raw)).then(() => true, () => false)
      writes = pending
      return pending
    },
    subscribe (fn) {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    }
  }
}

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)

function cleanItem (item) {
  if (!isObject(item) || !Number.isSafeInteger(item.seq) || item.seq < 1 || !isSeenId(item.ref)) return null
  return {
    seq: item.seq,
    ref: item.ref,
    text: typeof item.text === 'string' ? item.text : '',
    at: typeof item.at === 'string' ? item.at : '',
    media: isObject(item.media) ? item.media : null
  }
}

const cleanList = (list) => (Array.isArray(list) ? list.map(cleanItem).filter(Boolean) : [])

// The moments.read answer (docs/rpc.md 5.113) with anything malformed left
// out: { authors: [{ author, items }], own, past }. The own key never shows
// among the authors (own first is the app's job).
export function momentsOf (answer, ownKey) {
  const r = isObject(answer) ? answer : {}
  const authors = []
  for (const a of Array.isArray(r.authors) ? r.authors : []) {
    if (!isObject(a) || typeof a.author !== 'string' || !HEX64.test(a.author) || a.author === ownKey) continue
    const items = cleanList(a.items)
    if (items.length > 0) authors.push({ author: a.author, items })
  }
  return { authors, own: cleanList(r.own), past: cleanList(r.past) }
}

// The items still inside their 24 hours at `now` (the node answered them
// live; the screen may stay open past the end of one).
export function liveItems (items, now = Date.now()) {
  return Array.isArray(items) ? items.filter((item) => expiresIn(item.at, now) > 0) : []
}

// The authors with any live item, each with only those.
export function liveAuthors (authors, now = Date.now()) {
  const out = []
  for (const a of Array.isArray(authors) ? authors : []) {
    const items = liveItems(a && a.items, now)
    if (items.length > 0) out.push({ author: a.author, items })
  }
  return out
}

// The node can publish a momento: hosted, with the momento media upload.
export function canPublishMoment (node) {
  return isObject(node) && node.hosted === true && isObject(node.media) && typeof node.media.putMoment === 'function'
}

// The strip shows on a hosted node only, when there is a ring to show or the
// node can publish one.
export function stripShown ({ hosted, authors, own, canPublish }) {
  if (hosted !== true) return false
  return (Array.isArray(authors) && authors.length > 0) || (Array.isArray(own) && own.length > 0) || canPublish === true
}

// Every item of a ring seen on this device: the ring takes the line colour.
export function ringSeen (items, seen) {
  const set = seen instanceof Set ? seen : new Set(seenListOf(seen))
  return Array.isArray(items) && items.length > 0 && items.every((item) => item && set.has(item.ref))
}
