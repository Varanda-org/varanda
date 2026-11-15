// The legacy per-device "Agora não" list, read only for the one-time move
// into node decisions (migrateHidden). Nothing writes to it any more. Ids
// are the writer block refs 'from:seq'. Pure: the storage is injected
// (testimonialHideStore.native.js / .web.js).

export const STORAGE_KEY = 'varanda-testimonial-hidden'
export const FILE_NAME = 'varanda-testimonial-hidden.json'
// Older ids are dropped first, so the stored list stays small.
export const HIDDEN_MAX = 256

const ID = /^([0-9a-f]{64}):([1-9][0-9]*)$/

export function isHideId (s) {
  if (typeof s !== 'string') return false
  const m = ID.exec(s)
  if (!m) return false
  const seq = Number(m[2])
  return Number.isSafeInteger(seq) && String(seq) === m[2]
}

// A stored value back to a clean list: only valid ids, once each, the
// newest HIDDEN_MAX kept.
export function hiddenListOf (value) {
  if (!Array.isArray(value)) return []
  const out = []
  const seen = new Set()
  for (const id of value) {
    if (!isHideId(id) || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out.length > HIDDEN_MAX ? out.slice(out.length - HIDDEN_MAX) : out
}

const SEQ_MAX = 4294967295

// The newest `max` valid ids (the list keeps oldest first) as
// testimonial.decide params; ifNew leaves an existing decision untouched.
// With `allowed` (a Set of 'from:seq'), only those ids are kept.
export function migrationParams (list, max = 64, allowed) {
  const out = []
  const ids = hiddenListOf(list)
  for (let i = ids.length - 1; i >= 0 && out.length < max; i--) {
    if (allowed && !allowed.has(ids[i])) continue
    const [from, seq] = ids[i].split(':')
    if (Number(seq) > SEQ_MAX) continue
    out.push({ from, seq: Number(seq), state: 'kept', ifNew: true })
  }
  return out
}

// One-time move of the per-device hide list into node decisions. A failed
// decision is never reissued (the node may have applied it), its row just
// returns to "Para aprovar". `allowed` limits it to refs the current account
// can see: the list is per device, so after an account switch the other
// account's refs must not become decisions here.
export async function migrateHidden ({ load, clear, request, allowed }) {
  const list = await load()
  if (!Array.isArray(list) || list.length === 0) return 0
  // The list is cleared before anything is sent: a crash or a storage
  // failure afterwards must not make a later run resend a decide that may
  // have gone out (uncertain). If the clear fails, nothing is sent now.
  const params = migrationParams(list, 64, allowed)
  if (await clear() === false) return 0
  let ok = 0
  for (const p of params) {
    try {
      await request('testimonial.decide', p)
      ok++
    } catch {}
  }
  return ok
}

export function createTestimonialHideStore ({ read, write }) {
  let memory = null
  let writes = Promise.resolve()
  return {
    async load () {
      if (memory !== null) return memory.slice()
      try {
        const stored = hiddenListOf(JSON.parse(await read()))
        if (memory === null) memory = stored
      } catch {}
      return memory === null ? [] : memory.slice()
    },
    async clear () {
      memory = []
      const pending = writes.then(() => write('[]')).then(() => true, () => false)
      writes = pending
      return pending
    }
  }
}
