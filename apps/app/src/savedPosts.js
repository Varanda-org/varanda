// Saved posts ("Salvos"): references only, kept on this device per
// installation origin and per own diary key. Pure ES module: no React, no
// platform module, no Node built-ins; the platform stores
// (savedPostsStore.web.js / .native.js) only pass read and write. The stored
// JSON holds { author, seq, savedAt } and nothing else: no text from a peer
// is kept, posts are re-read and verified when the list opens.

import { validOrigin } from './feiraLink.js'

export const STORAGE_KEY = 'varanda-saved-posts'
export const FILE_NAME = 'varanda-saved-posts.json'
export const MAX_SAVED = 100
// Scopes (origin plus own diary key) with at least one saved post. A scope
// with no entries is never stored. Past the limit a new scope is refused
// (reason 'scopes'): a list is never dropped silently.
export const MAX_ORIGINS = 8

export const SAVED_FULL_TEXT = 'Você já tem ' + MAX_SAVED + ' publicações salvas. Tire uma para salvar outra.'
export const SAVED_SCOPES_TEXT = 'Este aparelho já guarda salvos de ' + MAX_ORIGINS + ' contas. Tire todos os salvos de uma delas para salvar aqui.'

const HEX64 = /^[0-9a-f]{64}$/

const validKey = (k) => typeof k === 'string' && HEX64.test(k)
const scopeId = (origin, key) => origin + '\n' + key

function refOf (ref) {
  if (!ref || typeof ref !== 'object') return null
  const { author, seq } = ref
  if (typeof author !== 'string' || !HEX64.test(author) || !Number.isSafeInteger(seq) || seq < 1) return null
  return { author, seq }
}

const sameRef = (a, b) => a.author === b.author && a.seq === b.seq

function entryOf (e) {
  const ref = refOf(e)
  if (ref === null) return null
  const savedAt = Number.isSafeInteger(e.savedAt) && e.savedAt >= 0 ? e.savedAt : 0
  return { ...ref, savedAt }
}

// Untrusted on every read: rebuilt field by field, malformed and duplicate
// entries dropped, at most MAX_SAVED per scope. Scopes are validated first,
// scopes with no entries are skipped, then the last MAX_ORIGINS are kept.
// Map order is recency: only add, remove and forgetScope move a scope to the
// end; load and has never change the order.
// -> Map scopeId -> { origin, key, entries }
export function sanitize (raw) {
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
      if (entry !== null && !entries.some((x) => sameRef(x, entry))) entries.push(entry)
      if (entries.length >= MAX_SAVED) break
    }
    if (entries.length > 0) out.set(id, { origin: s.origin, key: s.key, entries })
  }
  while (out.size > MAX_ORIGINS) out.delete(out.keys().next().value)
  return out
}

export function encode (map) {
  const scopes = []
  for (const s of map.values()) {
    scopes.push({
      origin: s.origin,
      key: s.key,
      entries: s.entries.map((e) => ({ author: e.author, seq: e.seq, savedAt: e.savedAt }))
    })
  }
  return JSON.stringify({ v: 1, scopes })
}

// Every call reads the storage fresh, applies its change to that copy and
// writes it back; calls of one store run one after the other. A failed read
// falls back to what this store last saw and then never writes (it could
// replace lists this store cannot see): the change stays in memory and the
// answer says persisted: false. Every call answers and never rejects.
export function createSavedStore ({ read, write, now = Date.now }) {
  let memory = new Map()
  let queue = Promise.resolve()

  function serial (fn) {
    const run = queue.then(fn)
    queue = run.catch(() => {})
    return run
  }

  // -> { map, ok }; ok is false when the read failed.
  async function fresh () {
    try {
      memory = sanitize(await read())
      return { map: memory, ok: true }
    } catch {
      return { map: memory, ok: false }
    }
  }

  async function persist (map, readOk) {
    memory = map
    if (!readOk) return false
    try {
      await write(encode(map))
      return true
    } catch {
      return false
    }
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
    // Newest first.
    load (origin, key) {
      if (!okScope(origin, key)) return Promise.resolve([])
      return serial(async () => entriesOf((await fresh()).map, origin, key).map((e) => ({ ...e })))
    },
    has (origin, key, ref) {
      const r = refOf(ref)
      if (!okScope(origin, key) || r === null) return Promise.resolve(false)
      return serial(async () => entriesOf((await fresh()).map, origin, key).some((x) => sameRef(x, r)))
    },
    // -> { ok, reason, persisted }; reason is 'full' (MAX_SAVED reached),
    // 'scopes' (MAX_ORIGINS scopes in use, this one is new), 'invalid', or
    // absent. Nothing is ever dropped. Saving a saved post is ok; it is
    // persisted when the fresh read proved the entry is on disk.
    add (origin, key, ref) {
      const r = refOf(ref)
      if (!okScope(origin, key) || r === null) return Promise.resolve({ ok: false, reason: 'invalid', persisted: false })
      return serial(async () => {
        const { map, ok } = await fresh()
        const entries = entriesOf(map, origin, key)
        if (entries.some((x) => sameRef(x, r))) return { ok: true, persisted: ok }
        if (entries.length === 0 && map.size >= MAX_ORIGINS) return { ok: false, reason: 'scopes', persisted: false }
        if (entries.length >= MAX_SAVED) return { ok: false, reason: 'full', persisted: false }
        const savedAt = now()
        const entry = { ...r, savedAt: Number.isSafeInteger(savedAt) && savedAt >= 0 ? savedAt : 0 }
        return { ok: true, persisted: await persist(withScope(map, origin, key, [entry, ...entries]), ok) }
      })
    },
    remove (origin, key, ref) {
      const r = refOf(ref)
      if (!okScope(origin, key) || r === null) return Promise.resolve(false)
      return serial(async () => {
        const { map, ok } = await fresh()
        const entries = entriesOf(map, origin, key)
        if (!entries.some((x) => sameRef(x, r))) return ok
        return persist(withScope(map, origin, key, entries.filter((x) => !sameRef(x, r))), ok)
      })
    },
    // The account was removed from this device: forget its list.
    forgetScope (origin, key) {
      if (!okScope(origin, key)) return Promise.resolve(false)
      return serial(async () => {
        const { map, ok } = await fresh()
        if (!map.has(scopeId(origin, key))) return ok
        return persist(withScope(map, origin, key, []), ok)
      })
    },
    // The account was removed from this device: forget its list under every
    // installation origin this device kept one for. false when the read
    // failed (memory only, nothing written): callers may ignore it.
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
