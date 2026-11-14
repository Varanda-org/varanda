// A row the list unmounts must not take its provider page with it.
// The frame is kept by the screen's list, not by the row.

export function embedKey (rowKey, part, embedUrl) {
  try {
    if (typeof rowKey !== 'string' || !rowKey || typeof embedUrl !== 'string' || !embedUrl) return ''
    if (part !== undefined && typeof part !== 'string') return ''
    return rowKey + (part ? ':' + part : '') + '|' + embedUrl
  } catch {
    return ''
  }
}

export function createEmbedKeep () {
  const entries = new Map()
  const listeners = new Set()
  let snapshot = Object.freeze([])
  let disposed = false

  const changed = (removed = []) => {
    snapshot = Object.freeze([...entries.values()])
    for (const entry of removed) {
      try { entry.release() } catch {}
    }
    for (const fn of [...listeners]) {
      try { fn() } catch {}
    }
  }

  const remove = (keys) => {
    const removed = []
    for (const key of keys) {
      const entry = entries.get(key)
      if (!entry) continue
      entries.delete(key)
      removed.push(entry)
    }
    if (!removed.length) return false
    changed(removed)
    return true
  }

  const show = (key, spec, release, row = '') => {
    if (disposed || typeof key !== 'string' || !key || typeof release !== 'function') return false
    const entry = entries.get(key)
    if (entry && entry.release !== release) return false
    if (typeof row !== 'string') row = ''
    if (entry && entry.spec === spec && entry.row === row) return true
    const next = Object.freeze(entry
      ? { ...entry, row, spec }
      : { key, row, spec, rect: null, release, orphan: false })
    entries.set(key, next)
    changed()
    return entries.get(key) === next
  }

  const place = (key, rect) => {
    const entry = entries.get(key)
    if (!entry || entry.orphan === true) return
    const { x, y, w, h } = rect || {}
    const next = [x, y, w, h].every(Number.isFinite) && w > 0 && h > 0
      ? Object.freeze({ x, y, w, h })
      : null
    const prev = entry.rect
    if (prev === null && next === null) return
    if (prev && next && prev.x === x && prev.y === y && prev.w === w && prev.h === h) return
    entries.set(key, Object.freeze({ ...entry, rect: next }))
    changed()
  }

  const orphan = (key) => {
    if (disposed) return false
    const entry = entries.get(key)
    if (!entry) return false
    if (!entry.orphan || entry.rect !== null) {
      entries.set(key, Object.freeze({ ...entry, orphan: true, rect: null }))
      changed()
    }
    return true
  }

  const claim = (key) => {
    const entry = entries.get(key)
    if (!entry || !entry.orphan) return null
    const next = Object.freeze({ ...entry, orphan: false })
    entries.set(key, next)
    changed()
    if (entries.get(key) !== next) return null
    return { release: entry.release, spec: entry.spec }
  }

  const prune = (isKept) => {
    const keys = []
    for (const entry of entries.values()) {
      if (!entry.orphan) continue
      try {
        if (!isKept(entry.row, entry.key)) keys.push(entry.key)
      } catch {}
    }
    remove(keys)
  }

  const dropAll = () => { remove([...entries.keys()]) }
  const dispose = () => {
    disposed = true
    dropAll()
  }
  const subscribe = (fn) => {
    listeners.add(fn)
    return () => { listeners.delete(fn) }
  }

  return {
    has: (key) => entries.has(key),
    show,
    place,
    orphan,
    claim,
    drop: (key) => remove([key]),
    dropOrphans: () => { remove([...entries.values()].filter((entry) => entry.orphan).map((entry) => entry.key)) },
    prune,
    hasOrphan: () => [...entries.values()].some((entry) => entry.orphan),
    dropAll,
    dispose,
    list: () => snapshot,
    subscribe
  }
}
