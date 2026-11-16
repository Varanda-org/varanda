// Event reminders: references and start times only, kept on this device per
// installation origin and per own diary key (scoped like savedPosts.js). No
// text from a peer is stored; the event is re-read when the banner opens.
// Pure ES module: no React, no platform module.

import { validOrigin } from './feiraLink.js'

export const STORAGE_KEY = 'varanda-event-reminders'
export const FILE_NAME = 'varanda-event-reminders.json'
export const MAX_REMINDERS = 50
export const MAX_ORIGINS = 8
export const WINDOW_MS = 24 * 60 * 60 * 1000

const HEX64 = /^[0-9a-f]{64}$/
const validKey = (k) => typeof k === 'string' && HEX64.test(k)
const scopeId = (origin, key) => origin + '\n' + key
const validStart = (n) => Number.isSafeInteger(n) && n >= 0

function entryOf (e) {
  if (!e || typeof e !== 'object') return null
  const { author, seq, start } = e
  if (typeof author !== 'string' || !HEX64.test(author) || !Number.isSafeInteger(seq) || seq < 1 || !validStart(start)) return null
  return { author, seq, start }
}

const same = (a, b) => a.author === b.author && a.seq === b.seq

export function sanitize (raw, now = 0) {
  const out = new Map()
  let o
  try { o = typeof raw === 'string' ? JSON.parse(raw) : null } catch { return out }
  if (!o || typeof o !== 'object' || o.v !== 1 || !Array.isArray(o.scopes)) return out
  for (const s of o.scopes) {
    if (!s || typeof s !== 'object' || !validOrigin(s.origin) || !validKey(s.key) || !Array.isArray(s.entries)) continue
    const id = scopeId(s.origin, s.key)
    if (out.has(id)) continue
    const entries = []
    for (const e of s.entries) {
      const entry = entryOf(e)
      if (entry !== null && entry.start >= now && !entries.some((x) => same(x, entry))) entries.push(entry)
      if (entries.length >= MAX_REMINDERS) break
    }
    if (entries.length > 0) out.set(id, { origin: s.origin, key: s.key, entries })
  }
  while (out.size > MAX_ORIGINS) out.delete(out.keys().next().value)
  return out
}

export function encode (map) {
  const scopes = []
  for (const s of map.values()) {
    scopes.push({ origin: s.origin, key: s.key, entries: s.entries.map((e) => ({ author: e.author, seq: e.seq, start: e.start })) })
  }
  return JSON.stringify({ v: 1, scopes })
}

// Entries whose start is within the next 24 hours (a start already passed by
// more than nothing is not due). Soonest first.
export function dueReminders (entries, now = Date.now()) {
  return (Array.isArray(entries) ? entries : [])
    .filter((e) => e && validStart(e.start) && e.start >= now && e.start - now <= WINDOW_MS)
    .sort((a, b) => a.start - b.start)
}

// Same read-fresh, change, write-back shape as createSavedStore; calls run
// one after the other and never reject. A failed read never writes.
export function createReminderStore ({ read, write, now = Date.now }) {
  let memory = new Map()
  let queue = Promise.resolve()
  const serial = (fn) => {
    const run = queue.then(fn)
    queue = run.catch(() => {})
    return run
  }
  async function fresh () {
    try {
      memory = sanitize(await read(), now())
      return { map: memory, ok: true }
    } catch {
      return { map: memory, ok: false }
    }
  }
  async function persist (map, ok) {
    memory = map
    if (!ok) return false
    try { await write(encode(map)); return true } catch { return false }
  }
  function withScope (map, origin, key, entries) {
    const next = new Map(map)
    const id = scopeId(origin, key)
    next.delete(id)
    if (entries.length > 0) next.set(id, { origin, key, entries })
    return next
  }
  const entriesOf = (map, origin, key) => (map.get(scopeId(origin, key)) || { entries: [] }).entries
  const okScope = (origin, key) => validOrigin(origin) && validKey(key)

  return {
    load (origin, key) {
      if (!okScope(origin, key)) return Promise.resolve([])
      return serial(async () => entriesOf((await fresh()).map, origin, key).map((e) => ({ ...e })))
    },
    has (origin, key, ref) {
      const r = entryOf({ ...ref, start: 0 })
      if (!okScope(origin, key) || r === null) return Promise.resolve(false)
      return serial(async () => entriesOf((await fresh()).map, origin, key).some((x) => same(x, r)))
    },
    // -> { ok, reason ('full' | 'scopes' | 'invalid'), persisted }. Setting a
    // reminder again updates its start.
    set (origin, key, ref, start) {
      const r = entryOf({ author: ref && ref.author, seq: ref && ref.seq, start })
      if (!okScope(origin, key) || r === null) return Promise.resolve({ ok: false, reason: 'invalid', persisted: false })
      return serial(async () => {
        const { map, ok } = await fresh()
        const entries = entriesOf(map, origin, key)
        const rest = entries.filter((x) => !same(x, r))
        if (entries.length === 0 && map.size >= MAX_ORIGINS) return { ok: false, reason: 'scopes', persisted: false }
        if (rest.length >= MAX_REMINDERS) return { ok: false, reason: 'full', persisted: false }
        return { ok: true, persisted: await persist(withScope(map, origin, key, [r, ...rest]), ok) }
      })
    },
    remove (origin, key, ref) {
      const r = entryOf({ ...ref, start: 0 })
      if (!okScope(origin, key) || r === null) return Promise.resolve(false)
      return serial(async () => {
        const { map, ok } = await fresh()
        const entries = entriesOf(map, origin, key)
        if (!entries.some((x) => same(x, r))) return ok
        return persist(withScope(map, origin, key, entries.filter((x) => !same(x, r))), ok)
      })
    },
    forgetKey (key) {
      if (!validKey(key)) return Promise.resolve(false)
      return serial(async () => {
        const { map, ok } = await fresh()
        const next = new Map()
        for (const [id, s] of map) if (s.key !== key) next.set(id, s)
        if (next.size === map.size) return ok
        return persist(next, ok)
      })
    }
  }
}
