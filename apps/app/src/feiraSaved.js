// Saved Feira listings ("Salvos"): references only, kept on this device per
// installation origin. Pure ES module: no React, no platform module, no Node
// built-ins; the platform stores (feiraSavedStore.web.js / .native.js) only
// pass read and write. The stored JSON holds origins and { author, seq }
// pairs, never a title or any other text from a peer, so nothing a seller
// wrote is kept after the listing is gone.

import { validOrigin } from './feiraLink.js'

export const STORAGE_KEY = 'varanda-feira-saved'
export const FILE_NAME = 'varanda-feira-saved.json'
export const MAX_SAVED = 100
// Installations this device ever opened; the oldest is forgotten past it.
export const MAX_ORIGINS = 8

const HEX64 = /^[0-9a-f]{64}$/

function refOf (ref) {
  if (!ref || typeof ref !== 'object') return null
  const { author, seq } = ref
  if (typeof author !== 'string' || !HEX64.test(author) || !Number.isSafeInteger(seq) || seq < 1) return null
  return { author, seq }
}

const sameRef = (a, b) => a.author === b.author && a.seq === b.seq

// Untrusted on every read: rebuilt field by field, doubtful entries dropped,
// duplicates kept once, at most MAX_SAVED refs per origin.
export function decodeSaved (raw) {
  const out = new Map()
  let o
  try { o = typeof raw === 'string' ? JSON.parse(raw) : null } catch { return out }
  if (!o || typeof o !== 'object' || o.v !== 1 || !Array.isArray(o.origins)) return out
  for (const entry of o.origins.slice(0, MAX_ORIGINS)) {
    if (!entry || typeof entry !== 'object' || !validOrigin(entry.origin) || out.has(entry.origin)) continue
    if (!Array.isArray(entry.refs)) continue
    const refs = []
    for (const r of entry.refs) {
      const ref = refOf(r)
      if (ref !== null && !refs.some((x) => sameRef(x, ref))) refs.push(ref)
      if (refs.length >= MAX_SAVED) break
    }
    out.set(entry.origin, refs)
  }
  return out
}

export function encodeSaved (map) {
  const origins = []
  for (const [origin, refs] of map) {
    origins.push({ origin, refs: refs.map((r) => ({ author: r.author, seq: r.seq })) })
  }
  return JSON.stringify({ v: 1, origins })
}

// The saved lists of this device. Another tab or store may write the same
// storage, so every call reads it fresh and a change is applied to that
// fresh copy before it is written back; calls of one store run one after
// the other. A failed read falls back to what this store last saw, so a
// refused write still shows for this run. Every call answers and never
// rejects.
export function createSavedStore ({ read, write }) {
  let memory = new Map()
  let queue = Promise.resolve()

  function serial (fn) {
    const run = queue.then(fn)
    queue = run.catch(() => {})
    return run
  }

  async function fresh () {
    try {
      memory = decodeSaved(await read())
    } catch {}
    return memory
  }

  async function persist (map) {
    memory = map
    try {
      await write(encodeSaved(map))
      return true
    } catch {
      return false
    }
  }

  function withOrigin (map, origin, refs) {
    const next = new Map(map)
    next.delete(origin)
    if (refs.length > 0) next.set(origin, refs)
    while (next.size > MAX_ORIGINS) next.delete(next.keys().next().value)
    return next
  }

  return {
    // Newest first.
    list (origin) {
      if (!validOrigin(origin)) return Promise.resolve([])
      return serial(async () => ((await fresh()).get(origin) || []).map((r) => ({ ...r })))
    },
    has (origin, ref) {
      const r = refOf(ref)
      if (!validOrigin(origin) || r === null) return Promise.resolve(false)
      return serial(async () => ((await fresh()).get(origin) || []).some((x) => sameRef(x, r)))
    },
    // -> { saved, full, persisted }: `full` when the list already holds
    // MAX_SAVED refs and nothing was added.
    toggle (origin, ref) {
      const r = refOf(ref)
      if (!validOrigin(origin) || r === null) return Promise.resolve({ saved: false, full: false, persisted: false })
      return serial(async () => {
        const map = await fresh()
        const refs = map.get(origin) || []
        if (refs.some((x) => sameRef(x, r))) {
          return { saved: false, full: false, persisted: await persist(withOrigin(map, origin, refs.filter((x) => !sameRef(x, r)))) }
        }
        if (refs.length >= MAX_SAVED) return { saved: false, full: true, persisted: false }
        return { saved: true, full: false, persisted: await persist(withOrigin(map, origin, [r, ...refs])) }
      })
    },
    remove (origin, ref) {
      const r = refOf(ref)
      if (!validOrigin(origin) || r === null) return Promise.resolve(false)
      return serial(async () => {
        const map = await fresh()
        const refs = map.get(origin) || []
        if (!refs.some((x) => sameRef(x, r))) return true
        return persist(withOrigin(map, origin, refs.filter((x) => !sameRef(x, r))))
      })
    },
    clear (origin) {
      if (!validOrigin(origin)) return Promise.resolve(false)
      return serial(async () => {
        const map = await fresh()
        if (!map.has(origin)) return true
        return persist(withOrigin(map, origin, []))
      })
    }
  }
}

export const SAVED_FULL_TEXT = 'Você já tem ' + MAX_SAVED + ' anúncios salvos. Tire um para salvar outro.'
