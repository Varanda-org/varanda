// Momentos seen: the refs 'author:seq' of the moments the viewer showed. It
// writes no record and tells nobody (Momentos have no view counts). Where the
// node is hosted and answers moments.seen, the list lives in the encrypted
// seen document, per identity, and syncs across the devices of the same
// passkey (docs/rpc.md 5.149 and 5.150); otherwise it stays on this device. Also the
// pure helpers the strip and the Diário share: the moments.read answer
// cleaned up, the live items of a list and whether the strip shows at all.
// Pure: the storage is injected (momentSeenStore.native.js / .web.js); no
// React, no react-native.

import rpc from '@varanda/rpc'
import { expiresIn, momentMusicOf } from './moments.js'

const { MOMENT_SEEN_MAX } = rpc

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

// The answers that mean the node keeps no seen list of its own: the list
// stays on this device. Any other failure is passing (a lock, a dropped link).
const LOCAL_ONLY_MESSAGES = ['método desconhecido', 'estado de vistos sincronizado só no navegador']
export function seenLocalOnly (err) {
  return !!err && LOCAL_ONLY_MESSAGES.includes(err.message)
}

// The legacy per-device list becomes node marks once: the list is cleared
// before anything is sent, so a crash or a storage failure afterwards never
// makes a later run send it again; if the clear fails, nothing is sent. Only
// refs in `allowed` (the moments the node answers now) go, the newest
// MOMENT_SEEN_MAX of them. Answers how many marks the node took.
export async function migrateMomentSeen ({ load, clear, request, allowed }) {
  if (!(allowed instanceof Set) || allowed.size === 0) return 0
  const list = seenListOf(await load())
  if (list.length === 0) return 0
  const refs = list.filter((ref) => allowed instanceof Set && allowed.has(ref)).slice(-MOMENT_SEEN_MAX)
  if (await clear() === false) return 0
  let ok = 0
  for (const ref of refs) {
    const i = ref.indexOf(':')
    try {
      await request('moment.seen', { author: ref.slice(0, i), seq: Number(ref.slice(i + 1)) })
      ok++
    } catch {}
  }
  return ok
}

// `read` / `write` hold the per-device list. bind({ key, request }) points
// the store at a node (key: the node epoch); the first moments.seen answer
// decides where the list lives until the key changes.
export function createMomentSeenStore ({ read, write }) {
  let memory = null
  let writes = Promise.resolve()
  let source = null // { key, request, mode: 'probe' | 'node' | 'local' }
  let gen = 0
  let inflight = null
  const migrated = new Set()
  const listeners = new Set()
  const emit = () => {
    const list = memory === null ? [] : memory.slice()
    for (const fn of [...listeners]) {
      try { fn(list.slice()) } catch {}
    }
  }
  const readLocal = async () => {
    await writes
    try { return seenListOf(JSON.parse(await read())) } catch { return [] }
  }
  const queueWrite = (raw) => {
    const pending = writes.then(() => write(raw)).then(() => true, () => false)
    writes = pending
    return pending
  }
  const nodeMode = () => source !== null && source.mode === 'node'
  return {
    bind (next) {
      const key = next && next.key !== undefined && next.key !== null && typeof next.request === 'function' ? next.key : null
      if (key === null) {
        if (source === null) return
        source = null
      } else if (source !== null && source.key === key) {
        source.request = next.request
        return
      } else {
        source = { key, request: next.request, mode: 'probe' }
      }
      gen++
      memory = null
      this.load().then(emit, () => {})
    },
    // One read at a time per binding: the bind and the screens share it.
    load () {
      if (memory !== null) return Promise.resolve(memory.slice())
      if (inflight !== null && inflight.gen === gen) return inflight.promise.then((list) => list.slice())
      const run = gen
      const promise = this.fetch().finally(() => { if (inflight !== null && inflight.promise === promise) inflight = null })
      inflight = { gen: run, promise }
      return promise.then((list) => list.slice())
    },
    async fetch () {
      const run = gen
      const at = source
      let list = null
      if (at !== null && at.mode !== 'local') {
        try {
          const answer = await at.request('moments.seen', {})
          list = seenListOf(answer && answer.refs)
          if (run === gen) at.mode = 'node'
        } catch (err) {
          if (run === gen && seenLocalOnly(err)) at.mode = 'local'
          else return []
        }
      }
      if (list === null) list = await readLocal()
      if (run === gen && memory === null) memory = list
      return memory === null || run !== gen ? list.slice() : memory.slice()
    },
    async mark (id) {
      if (!isSeenId(id)) return false
      const run = gen
      const current = memory !== null ? memory : await this.load()
      // A node that has not answered yet: no mark rather than one in the
      // wrong place.
      if (run !== gen || (source !== null && source.mode === 'probe')) return false
      if (current.includes(id)) return true
      memory = withSeen(current, id)
      emit()
      if (nodeMode()) {
        const i = id.indexOf(':')
        try {
          await source.request('moment.seen', { author: id.slice(0, i), seq: Number(id.slice(i + 1)) })
          return true
        } catch {
          // Not on the node: forget it here too, so the person's next view
          // sends it again (no timer, no retry loop).
          if (run === gen && memory !== null) {
            memory = memory.filter((x) => x !== id)
            emit()
          }
          return false
        }
      }
      return queueWrite(JSON.stringify(memory))
    },
    // A seen pass brought marks from another device: read the node again.
    async refresh () {
      if (!nodeMode()) return
      const run = ++gen
      const at = source
      let list
      try {
        const answer = await at.request('moments.seen', {})
        list = seenListOf(answer && answer.refs)
      } catch {
        return // a failed read keeps the list it has
      }
      if (run !== gen) return
      memory = list
      emit()
    },
    // Once per node key, after a moments.read answer: the legacy list moves
    // into the node. Answers the number of marks sent.
    async migrate (allowed) {
      if (!nodeMode() || migrated.has(source.key)) return 0
      // An answer with no moments says nothing about the old list: wait for one.
      if (!(allowed instanceof Set) || allowed.size === 0) return 0
      migrated.add(source.key)
      const n = await migrateMomentSeen({ load: readLocal, clear: () => queueWrite('[]'), request: source.request, allowed })
      if (n > 0) await this.refresh()
      return n
    },
    // Sign-out and reset: the per-device list belonged to the account that
    // leaves.
    clear () {
      if (!nodeMode()) {
        gen++
        memory = null
        emit()
      }
      return queueWrite('[]')
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
  const music = momentMusicOf(item)
  return {
    seq: item.seq,
    ref: item.ref,
    text: typeof item.text === 'string' ? item.text : '',
    at: typeof item.at === 'string' ? item.at : '',
    media: isObject(item.media) ? item.media : null,
    ...(music === null ? {} : { music })
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

// Every item of a ring already seen (synced where the node is hosted, on this
// device otherwise): the ring takes the line colour.
export function ringSeen (items, seen) {
  const set = seen instanceof Set ? seen : new Set(seenListOf(seen))
  return Array.isArray(items) && items.length > 0 && items.every((item) => item && set.has(item.ref))
}
