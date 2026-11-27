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
//
// kinds: which kinds one store holds. The Espiadinha's store holds the peek
// kinds; the copy store (photos of strangers a reopened screen draws, and
// decrypted private group pictures under COPY_GROUP_THUMBS) the copy kinds,
// in its own database with its own caps, so neither evicts the other's rows.

import { validDescriptor } from './fetch.js'

export const PEEK_PHOTO_KINDS = Object.freeze(['peekAvatars', 'peekPosts'])
export const PEEK_PHOTO_MAX_BYTES = 8388608
export const PEEK_PHOTO_MAX_FILES = 200
export const PEEK_PHOTO_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
export const COPY_GROUP_THUMBS = 'copyGroupThumbs'
export const COPY_PHOTO_KINDS = Object.freeze(['copyAvatars', 'copyPosts', COPY_GROUP_THUMBS])
export const COPY_PHOTO_MAX_BYTES = 8388608
export const COPY_PHOTO_MAX_FILES = 200
export const COPY_PHOTO_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000
export const GROUP_THUMB_MAX_BYTES = 262144
const THUMB_MIMES = Object.freeze(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'])

const HEX64 = /^[0-9a-f]{64}$/

function authorOf (author) {
  if (typeof author !== 'string') return null
  const lower = author.toLowerCase()
  return HEX64.test(lower) ? lower : null
}

function photoName (kinds, kind, author, d) {
  if (kind === COPY_GROUP_THUMBS || !kinds.includes(kind)) return null
  const a = authorOf(author)
  if (a === null || !validDescriptor(d)) return null
  return kind + '/' + a + '-' + d.core + '-' + d.start + '-' + d.blocks
}

export function peekPhotoName (kind, author, d) {
  return photoName(PEEK_PHOTO_KINDS, kind, author, d)
}

// A decrypted group picture: the image author and the plaintext hash.
function thumbName (kinds, author, sha) {
  if (!kinds.includes(COPY_GROUP_THUMBS)) return null
  const a = authorOf(author)
  if (a === null || typeof sha !== 'string' || !HEX64.test(sha)) return null
  return COPY_GROUP_THUMBS + '/' + a + '-' + sha
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

function validRow (row, kinds) {
  if (!row || typeof row !== 'object') return false
  if (typeof row.name !== 'string' || !kinds.includes(row.kind)) return false
  if (row.kind === COPY_GROUP_THUMBS) return validThumbRow(row)
  if (typeof row.author !== 'string' || typeof row.core !== 'string') return false
  if (!Number.isSafeInteger(row.start) || !Number.isSafeInteger(row.blocks)) return false
  if (!Number.isSafeInteger(row.size) || row.size < 0) return false
  if (!Number.isFinite(row.savedAt)) return false
  return row.name === row.kind + '/' + row.author + '-' + row.core + '-' + row.start + '-' + row.blocks
}

function validThumbRow (row) {
  if (typeof row.author !== 'string' || typeof row.sha256 !== 'string') return false
  if (!THUMB_MIMES.includes(row.mime)) return false
  if (!Number.isSafeInteger(row.size) || row.size < 1 || row.size > GROUP_THUMB_MAX_BYTES) return false
  if (!Number.isFinite(row.savedAt)) return false
  return row.name === COPY_GROUP_THUMBS + '/' + row.author + '-' + row.sha256
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
  maxAgeMs = PEEK_PHOTO_MAX_AGE_MS,
  kinds = PEEK_PHOTO_KINDS
} = {}) {
  const kindList = Array.isArray(kinds) ? kinds.slice() : PEEK_PHOTO_KINDS
  const valid = (row) => validRow(row, kindList)
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
  // epoch -> the names the retainThumbs that bumped to it keeps. A put that
  // only such retains overtook, each naming it, still lands: the retain runs
  // after it in the queue and keeps it.
  const spared = new Map()
  const SPARED_MAX = 64
  function survives (at, name) {
    for (let e = at + 1; e <= epoch; e++) {
      const keep = spared.get(e)
      if (keep === undefined || !keep.has(name)) return false
    }
    return true
  }
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
      const stale = (await rows()).filter((row) => !valid(row) || tooOld(row, t)).map((row) => row?.name).filter((n) => typeof n === 'string')
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

  // matches(row): whether a valid row answers for what the caller asked.
  function readName (name, matches) {
    const at = epoch
    return enqueue(async () => {
      if (name === null || ready === null || !live(at)) return null
      const row = (await rows()).find((r) => r && r.name === name)
      if (!live(at) || row === undefined) return null
      const fits = valid(row) && matches(row) && !tooOld(row, now())
      if (!fits) {
        await removeNames([name])
        return null
      }
      const bytes = await backend.get(name, readyBinding)
      // Rebound by another tab: not this account's entry to remove.
      if (!live(at) || bytes === false) return null
      if (!(bytes instanceof Uint8Array) || bytes.length !== row.size) {
        await removeNames([name])
        return null
      }
      return bytes
    }, null)
  }

  function read (kind, author, d) {
    const name = photoName(kindList, kind, author, d)
    return readName(name, (row) => row.sha256 === d.sha256 && row.size === d.bytes && row.mime === d.mime)
  }

  // -> the bytes of a kept group picture, or null.
  function readThumb (author, sha) {
    return readName(thumbName(kindList, author, sha), () => true)
  }

  // rowAt(t): the row to write, saved at t. bytes were checked by the caller.
  function putName (name, rowAt, bytes) {
    const at = epoch
    return enqueue(async () => {
      if (name === null || ready === null || !survives(at, name)) return false
      if (bytes.length > maxBytes) return false
      const t = now()
      const others = (await rows()).filter((r) => r && r.name !== name)
      if (!survives(at, name)) return false
      const evict = []
      const kept = []
      for (const row of others) {
        if (!valid(row) || tooOld(row, t)) {
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
      if (!survives(at, name)) return false
      // The backend checks the stored binding inside its write: another tab
      // may have wiped or rebound the store since this tab's bind.
      return (await backend.put(rowAt(t), bytes.slice(), readyBinding)) === true
    }, false)
  }

  function put (kind, author, d, bytes) {
    const name = photoName(kindList, kind, author, d)
    if (name === null || !(bytes instanceof Uint8Array) || bytes.length !== d.bytes) return putName(null)
    const a = authorOf(author)
    return putName(name, (t) => ({ name, kind, author: a, core: d.core, start: d.start, blocks: d.blocks, sha256: d.sha256, mime: d.mime, size: d.bytes, savedAt: t }), bytes)
  }

  // Keeps a decrypted group picture (at most GROUP_THUMB_MAX_BYTES).
  function putThumb (author, sha, bytes, mime) {
    const name = thumbName(kindList, author, sha)
    if (name === null || !(bytes instanceof Uint8Array) || bytes.length < 1 || bytes.length > GROUP_THUMB_MAX_BYTES || !THUMB_MIMES.includes(mime)) return putName(null)
    const a = authorOf(author)
    return putName(name, (t) => ({ name, kind: COPY_GROUP_THUMBS, author: a, sha256: sha, mime, size: bytes.length, savedAt: t }), bytes)
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
    const kindsAsked = listOf(kinds)
    const entryList = listOf(entries)
    if (kindsAsked === null || entryList === null) return Promise.resolve(false)
    // Group pictures are pruned only by retainThumbs.
    const scope = new Set(kindsAsked.filter((k) => k !== COPY_GROUP_THUMBS && kindList.includes(k)))
    const keep = new Set()
    for (const e of entryList) {
      const name = e && typeof e === 'object' ? photoName(kindList, e.kind, e.author, e.d) : null
      if (name !== null) keep.add(name)
    }
    return removeWhere((row) => !valid(row) ? true : scope.has(row.kind) && !keep.has(row.name))
  }

  // Deletes every group picture that pairs ([{ author, sha }]) does not name;
  // an empty list deletes them all.
  function retainThumbs (pairs) {
    const list = listOf(pairs)
    if (list === null || !kindList.includes(COPY_GROUP_THUMBS)) return Promise.resolve(false)
    const keep = new Set()
    for (const p of list) {
      const name = p && typeof p === 'object' ? thumbName(kindList, p.author, p.sha) : null
      if (name !== null) keep.add(name)
    }
    const run = removeWhere((row) => !valid(row) ? true : row.kind === COPY_GROUP_THUMBS && !keep.has(row.name))
    spared.set(epoch, keep)
    if (spared.size > SPARED_MAX) spared.delete(spared.keys().next().value)
    return run
  }

  function wipe () {
    epoch++
    bindEpoch++
    wanted = null
    ready = null
    readyBinding = null
    return enqueue(async () => (await backend.clear()) === true, false)
  }

  return { bind, read, put, readThumb, putThumb, dropAuthors, dropRanges, retain, retainThumbs, wipe }
}
