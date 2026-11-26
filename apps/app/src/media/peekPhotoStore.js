// Espiadinha photos (authors the device does not follow) kept by the app on
// the web and the installed PWA, instead of the browser HTTP cache, so they
// can be bound to one member and wiped, dropped and expired on demand. The
// backend (./peekPhotos.web.js: IndexedDB) is injected so this file stays
// loadable in Node.
//
// Binding: every entry belongs to one { origin, association, owner }. A bind
// to anything else, or with nothing recorded, clears the store before the new
// binding is recorded, so one member never reads another's photos. Until a
// bind succeeds nothing is read or written: Vitrine and a page actor (binding
// null) never touch the store.
//
// Ordering: every call runs through one promise queue in call order. Every
// mutation (bind, wipe, drop, retain) bumps an epoch the moment it is called,
// and a put or read re-checks it after every await, so a put still in flight
// never writes back what a later wipe, drop or retain removed, and a read in
// flight never answers for a binding that has gone.
//
// Nothing here throws or rejects: a backend failure answers null or false,
// and the caller falls back to the network.

import { validDescriptor } from './fetch.js'

export const PEEK_PHOTO_KINDS = Object.freeze(['peekAvatars', 'peekPosts'])
export const PEEK_PHOTO_MAX_BYTES = 8388608
export const PEEK_PHOTO_MAX_FILES = 200
export const PEEK_PHOTO_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

const HEX64 = /^[0-9a-f]{64}$/

function authorOf (author) {
  if (typeof author !== 'string') return null
  const lower = author.toLowerCase()
  return HEX64.test(lower) ? lower : null
}

export function peekPhotoName (kind, author, d) {
  if (!PEEK_PHOTO_KINDS.includes(kind)) return null
  const a = authorOf(author)
  if (a === null || !validDescriptor(d)) return null
  return kind + '/' + a + '-' + d.core + '-' + d.start + '-' + d.blocks
}

function asBinding (b) {
  if (!b || typeof b !== 'object') return null
  const { origin, association, owner } = b
  if (typeof origin !== 'string' || origin === '') return null
  if (typeof association !== 'string' || association === '') return null
  if (typeof owner !== 'string' || owner === '') return null
  return { origin, association, owner }
}

const bindingKey = (b) => b === null ? null : JSON.stringify([b.origin, b.association, b.owner])

function asRange (m) {
  if (!m || typeof m !== 'object') return null
  if (typeof m.core !== 'string' || !HEX64.test(m.core)) return null
  if (!Number.isSafeInteger(m.start) || !Number.isSafeInteger(m.blocks)) return null
  if (m.start < 0 || m.blocks < 1) return null
  return m
}

// Same rule as ./keep.native.js: same core and intersecting block intervals.
function overlaps (a, b) {
  return a.core === b.core && a.start < b.start + b.blocks && b.start < a.start + a.blocks
}

function validRow (row) {
  if (!row || typeof row !== 'object') return false
  if (typeof row.name !== 'string' || !PEEK_PHOTO_KINDS.includes(row.kind)) return false
  if (typeof row.author !== 'string' || typeof row.core !== 'string') return false
  if (!Number.isSafeInteger(row.start) || !Number.isSafeInteger(row.blocks)) return false
  if (!Number.isSafeInteger(row.size) || row.size < 0) return false
  if (!Number.isFinite(row.savedAt)) return false
  return row.name === row.kind + '/' + row.author + '-' + row.core + '-' + row.start + '-' + row.blocks
}

// Removals remembered before the first bind; past this many the bind clears
// everything instead.
const MAX_PENDING = 64

// Any iterable but a string, as an array; null otherwise.
function listOf (x) {
  if (x === null || x === undefined || typeof x === 'string' || typeof x[Symbol.iterator] !== 'function') return null
  try { return Array.from(x) } catch { return null }
}

const byAge = (a, b) => (a.savedAt - b.savedAt) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)

export function createPeekPhotoStore ({
  backend,
  now = Date.now,
  maxBytes = PEEK_PHOTO_MAX_BYTES,
  maxFiles = PEEK_PHOTO_MAX_FILES,
  maxAgeMs = PEEK_PHOTO_MAX_AGE_MS
} = {}) {
  let tail = Promise.resolve()
  let epoch = 0
  // Bumped only by a change of binding and by wipe: a drop or retain called
  // while a bind is pending runs after it in the queue and must not cancel it.
  let bindEpoch = 0
  // The binding asked for last, and the one a finished bind made current.
  let wanted = null
  let ready = null
  let readyBinding = null
  // A drop or retain removes data, so it runs once any bind succeeded in
  // this process, even while unbound. Before that it is remembered and
  // applied inside the first bind, before the store turns on: a block.list
  // answered before the bind must still remove what an earlier session kept.
  let opened = false
  let pending = []
  let pendingAll = false

  function enqueue (fn, fallback) {
    const run = tail.then(fn).then((v) => v, () => fallback)
    tail = run.then(() => {}, () => {})
    return run
  }

  const live = (at) => at === epoch
  const bindLive = (at) => at === bindEpoch
  const tooOld = (row, t) => !(t - row.savedAt <= maxAgeMs && t - row.savedAt >= 0)

  async function rows () {
    const out = await backend.list()
    return Array.isArray(out) ? out : []
  }

  async function removeNames (names) {
    if (names.length === 0) return true
    return (await backend.remove(names)) === true
  }

  function bind (binding) {
    const next = asBinding(binding)
    const key = bindingKey(next)
    if (key !== wanted || key !== ready) {
      epoch++
      bindEpoch++
      ready = null
    }
    wanted = key
    const at = bindEpoch
    return enqueue(async () => {
      // Even a repeat of the current binding turns the store off until it
      // succeeds, so a failed verification or expiry never leaves it on.
      ready = null
      if (next === null) return true
      const stored = asBinding(await backend.getBinding())
      if (!bindLive(at)) return false
      if (bindingKey(stored) !== key) {
        if ((await backend.clear()) !== true) return false
        if (!bindLive(at)) return false
        if ((await backend.setBinding(next)) !== true) return false
        if (!bindLive(at)) return false
      }
      const t = now()
      const stale = (await rows()).filter((row) => !validRow(row) || tooOld(row, t)).map((row) => row?.name).filter((n) => typeof n === 'string')
      if (!bindLive(at)) return false
      if (!(await removeNames(stale))) return false
      if (!bindLive(at)) return false
      if (pendingAll || pending.length > 0) {
        const picks = pending
        const all = pendingAll
        const names = (await rows()).filter((row) => row && typeof row.name === 'string' && (all || picks.some((pick) => pick(row)))).map((row) => row.name)
        if (!bindLive(at)) return false
        if (!(await removeNames(names))) return false
        if (!bindLive(at)) return false
        pending = pending.slice(picks.length)
        if (all) pendingAll = false
      }
      ready = key
      readyBinding = next
      opened = true
      return true
    }, false)
  }

  function read (kind, author, d) {
    const name = peekPhotoName(kind, author, d)
    const at = epoch
    return enqueue(async () => {
      if (name === null || ready === null || !live(at)) return null
      const row = (await rows()).find((r) => r && r.name === name)
      if (!live(at) || row === undefined) return null
      const fits = validRow(row) && row.sha256 === d.sha256 && row.size === d.bytes && row.mime === d.mime && !tooOld(row, now())
      if (!fits) {
        await removeNames([name])
        return null
      }
      const bytes = await backend.get(name, readyBinding)
      // Rebound by another tab: not this account's entry to remove.
      if (!live(at) || bytes === false) return null
      if (!(bytes instanceof Uint8Array) || bytes.length !== d.bytes) {
        await removeNames([name])
        return null
      }
      return bytes
    }, null)
  }

  function put (kind, author, d, bytes) {
    const name = peekPhotoName(kind, author, d)
    const at = epoch
    return enqueue(async () => {
      if (name === null || ready === null || !live(at)) return false
      if (!(bytes instanceof Uint8Array) || bytes.length !== d.bytes || bytes.length > maxBytes) return false
      const t = now()
      const others = (await rows()).filter((r) => r && r.name !== name)
      if (!live(at)) return false
      const evict = []
      const kept = []
      for (const row of others) {
        if (!validRow(row) || tooOld(row, t)) {
          if (typeof row.name === 'string') evict.push(row.name)
        } else {
          kept.push(row)
        }
      }
      kept.sort(byAge)
      let total = kept.reduce((sum, row) => sum + row.size, 0)
      let count = kept.length
      for (const row of kept) {
        if (total + bytes.length <= maxBytes && count + 1 <= maxFiles) break
        evict.push(row.name)
        total -= row.size
        count--
      }
      if (!(await removeNames(evict))) return false
      if (!live(at)) return false
      const a = authorOf(author)
      const row = { name, kind, author: a, core: d.core, start: d.start, blocks: d.blocks, sha256: d.sha256, mime: d.mime, size: d.bytes, savedAt: t }
      // The backend checks the stored binding inside its write: another tab
      // may have wiped or rebound the store since this tab's bind.
      return (await backend.put(row, bytes.slice(), readyBinding)) === true
    }, false)
  }

  function removeWhere (pick) {
    epoch++
    return enqueue(async () => {
      if (!opened) {
        if (pending.length < MAX_PENDING) pending.push(pick)
        else pendingAll = true
        // Not applied yet: false, as every answer of a store that is off.
        return false
      }
      const names = (await rows()).filter((row) => row && typeof row.name === 'string' && pick(row)).map((row) => row.name)
      return removeNames(names)
    }, false)
  }

  function dropAuthors (keys) {
    const list = listOf(keys)
    if (list === null) return Promise.resolve(false)
    const set = new Set(list.map(authorOf).filter((k) => k !== null))
    return removeWhere((row) => set.has(row.author))
  }

  function dropRanges (ranges) {
    const given = listOf(ranges)
    if (given === null) return Promise.resolve(false)
    const list = given.map(asRange).filter((r) => r !== null)
    return removeWhere((row) => list.some((r) => overlaps(r, row)))
  }

  function retain (kinds, entries) {
    const kindList = listOf(kinds)
    const entryList = listOf(entries)
    if (kindList === null || entryList === null) return Promise.resolve(false)
    const scope = new Set(kindList.filter((k) => PEEK_PHOTO_KINDS.includes(k)))
    const keep = new Set()
    for (const e of entryList) {
      const name = e && typeof e === 'object' ? peekPhotoName(e.kind, e.author, e.d) : null
      if (name !== null) keep.add(name)
    }
    return removeWhere((row) => !validRow(row) ? true : scope.has(row.kind) && !keep.has(row.name))
  }

  function wipe () {
    epoch++
    bindEpoch++
    wanted = null
    ready = null
    readyBinding = null
    return enqueue(async () => (await backend.clear()) === true, false)
  }

  return { bind, read, put, dropAuthors, dropRanges, retain, wipe }
}
