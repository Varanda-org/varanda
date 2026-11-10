// "Agora não" on a pending depoimento: a hide kept on this device only. It
// writes no record and tells nobody; the writer's sealed block stays where
// it is and the depoimento can still be shown from another device. Hidden
// ids are the writer block refs 'from:seq'. Pure: the storage is injected
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

export function withHidden (list, id) {
  const base = hiddenListOf(list)
  if (!isHideId(id)) return base
  return hiddenListOf(base.filter((x) => x !== id).concat([id]))
}

// Pending rows (testimonials.js pendingRows) minus the ones hidden here.
export function visiblePending (rows, hidden) {
  if (!Array.isArray(rows)) return []
  const set = hidden instanceof Set ? hidden : new Set(hiddenListOf(hidden))
  return rows.filter((r) => r && typeof r.ref === 'string' && !set.has(r.ref))
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
    async hide (id) {
      if (!isHideId(id)) return false
      const current = memory !== null ? memory : await this.load()
      memory = withHidden(current, id)
      const raw = JSON.stringify(memory)
      const pending = writes.then(() => write(raw)).then(() => true, () => false)
      writes = pending
      return pending
    }
  }
}
