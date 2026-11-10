// Verified photos of the own and followed authors, kept across starts so a
// restart does not download and hash them again. A separate directory from
// ./display's varanda-media, which is swept at every start and holds random
// names only, so neither that sweep nor an LRU eviction ever reaches a kept
// file. Avatars and post photos live in separate subdirectories: a post photo
// entry can never answer for an avatar. A file name is built only from the
// validated author key and descriptor fields, so no peer text reaches a path.
// The caller decides who is kept (own and followed authors) and drops files
// on sign-out, lock, reset, block, unfollow and deletion. No index file: the
// file system is the index, and trimKept uses modification times. Every
// function never throws; a failure leaves the photo to the network path.
//
// Budget: keep() admits a file only while both caps hold. A running tally
// (built from one listing, then updated on every keep and delete) says when
// a new file would cross one. When the files in use alone leave no room the
// bytes are not kept (the caller shows them from memory) and nothing is
// deleted. Otherwise the bytes are written to a .tmp and moved into place
// first, and only then are the oldest files not in use trimmed, down to 7/8
// of the caps so the next keeps need no listing: a failed write or move
// deletes nothing. A file leaves the tally only once it is really gone, so a
// failed delete never makes the store look smaller than it is. A file is in use from
// the moment its URI is handed out until KEEP_RELEASE_GRACE_MS after an
// in-memory URL cache evicts it (releaseKept): a mounted view may still show
// that URI for a while. Files older than
// KEEP_MAX_AGE_MS go at every trim, so photos of posts a followed author
// deleted do not stay forever; reading a file does not refresh its age.

import { Directory, File, Paths } from 'expo-file-system'
import { validDescriptor } from './fetch.js'

const ROOT = 'varanda-media-keep'
const KINDS = Object.freeze(['avatars', 'posts'])
const EXT = Object.freeze({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' })
const HEX64 = /^[0-9a-f]{64}$/
const NAME = /^([0-9a-f]{64})-([0-9a-f]{64})-([0-9]+)-([0-9]+)-([0-9]+)-([0-9a-f]{64})-([0-9]+)x([0-9]+)\.(jpg|png|webp|gif)$/
const TMP = '.tmp'

export const KEEP_MAX_BYTES = 67108864
export const KEEP_MAX_FILES = 2000
export const KEEP_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
export const KEEP_RELEASE_GRACE_MS = 120000

// A trim started by keep() leaves this much room under each cap.
const SLACK = 8

// Kept files ('<kind>/<name>') whose URI this process handed out: an
// in-memory URL cache may still serve it, so trimKept never deletes them.
// The purges below do (the registry clears those caches with them).
const inUse = new Set()
// key -> when releaseKept let it go; protected until the grace runs out.
const released = new Map()

function protectedKey (key, now) {
  if (inUse.has(key)) return true
  const at = released.get(key)
  if (at === undefined) return false
  if (now - at < KEEP_RELEASE_GRACE_MS) return true
  released.delete(key)
  return false
}

function markUsed (key) {
  inUse.add(key)
  released.delete(key)
}

function unmark (key) {
  inUse.delete(key)
  released.delete(key)
}

// key -> size of every kept file (no .tmp), or null until a keep needs it.
let tally = null
let tallyBytes = 0
function forget (key) {
  if (tally !== null && tally.has(key)) {
    tallyBytes -= tally.get(key)
    tally.delete(key)
  }
}

function count (key, size) {
  if (tally === null) return
  forget(key)
  tally.set(key, size)
  tallyBytes += size
}

function sizeOf (file) {
  try { return file.size || 0 } catch { return 0 }
}

function ensureTally () {
  if (tally !== null) return
  const next = new Map()
  let bytes = 0
  for (const k of listKept()) {
    if (k.tmp) continue
    const size = sizeOf(k.file)
    next.set(k.key, size)
    bytes += size
  }
  tally = next
  tallyBytes = bytes
}

const root = () => new Directory(Paths.cache, ROOT)
const kindDir = (kind) => new Directory(root(), kind)

function authorOf (author) {
  if (typeof author !== 'string') return null
  const lower = author.toLowerCase()
  return HEX64.test(lower) ? lower : null
}

function nameOf (kind, author, d) {
  if (!KINDS.includes(kind)) return null
  const a = authorOf(author)
  if (a === null || !validDescriptor(d) || !Object.hasOwn(EXT, d.mime)) return null
  return [a, d.core, d.start, d.blocks, d.bytes, d.sha256, d.width + 'x' + d.height].join('-') + '.' + EXT[d.mime]
}

function asRange (m) {
  if (!m || typeof m !== 'object') return null
  if (typeof m.core !== 'string' || !HEX64.test(m.core)) return null
  if (!Number.isSafeInteger(m.start) || !Number.isSafeInteger(m.blocks)) return null
  if (m.start < 0 || m.blocks < 1) return null
  return m
}

// Same rule as ./cache.js: same core and intersecting block intervals.
function overlaps (a, b) {
  return a.core === b.core && a.start < b.start + b.blocks && b.start < a.start + a.blocks
}

// -> true when the file is gone afterwards.
function remove (file) {
  try { if (file.exists) file.delete() } catch {}
  try { return !file.exists } catch { return false }
}

function dropEntry (k) {
  unmark(k.key)
  if (remove(k.file)) forget(k.key)
}

// Every kept file (and every leftover .tmp of an interrupted write), parsed
// from its name. Entries with any other name are left alone.
function listKept () {
  const out = []
  for (const kind of KINDS) {
    let entries
    try {
      const dir = kindDir(kind)
      if (!dir.exists) continue
      entries = dir.list()
    } catch {
      continue
    }
    for (const entry of entries) {
      const raw = entry && typeof entry.name === 'string' ? entry.name : ''
      const tmp = raw.endsWith(TMP)
      const m = NAME.exec(tmp ? raw.slice(0, -TMP.length) : raw)
      if (m === null) continue
      out.push({
        key: kind + '/' + raw,
        file: new File(kindDir(kind), raw),
        tmp,
        author: m[1],
        core: m[2],
        start: Number(m[3]),
        blocks: Number(m[4])
      })
    }
  }
  return out
}

// The kept file's URI, or null. A file whose size is not d.bytes is deleted:
// it was cut short and would show a broken photo.
export function keptUrl (kind, author, d) {
  try {
    const name = nameOf(kind, author, d)
    if (name === null) return null
    const file = new File(kindDir(kind), name)
    if (!file.exists) return null
    if (file.size !== d.bytes) {
      unmark(kind + '/' + name)
      if (remove(file)) forget(kind + '/' + name)
      return null
    }
    markUsed(kind + '/' + name)
    return file.uri
  } catch {
    return null
  }
}

const fits = (size) => tally.size + 1 <= KEEP_MAX_FILES && tallyBytes + size <= KEEP_MAX_BYTES

// Whether one more file of `size` bytes can fit once every file not
// protected is gone: decided from the tally, before anything is deleted.
function feasible (size) {
  if (size > KEEP_MAX_BYTES) return false
  const now = Date.now()
  let files = 0
  let bytes = 0
  for (const [key, n] of tally) {
    if (!protectedKey(key, now)) continue
    files++
    bytes += n
  }
  return files + 1 <= KEEP_MAX_FILES && bytes + size <= KEEP_MAX_BYTES
}

// After a new file joined the tally: trims the oldest files not protected
// (the new one is in use) back under the caps, with room to spare.
function settle () {
  if (tally.size <= KEEP_MAX_FILES && tallyBytes <= KEEP_MAX_BYTES) return
  trim(
    Math.max(0, KEEP_MAX_BYTES - Math.floor(KEEP_MAX_BYTES / SLACK)),
    Math.max(0, KEEP_MAX_FILES - Math.floor(KEEP_MAX_FILES / SLACK))
  )
}

// Writes verified bytes under their name and returns the URI, or null (also
// when the caps leave no room). The bytes go to <name>.tmp first and are
// moved into place, so a crash never leaves a partial file under a name
// keptUrl would serve; only a committed file makes the store trim others.
export function keep (kind, author, d, bytes) {
  let tmp = null
  try {
    const name = nameOf(kind, author, d)
    if (name === null || !(bytes instanceof Uint8Array) || bytes.byteLength !== d.bytes) return null
    const key = kind + '/' + name
    const dir = kindDir(kind)
    dir.create({ intermediates: true, idempotent: true })
    const dest = new File(dir, name)
    if (dest.exists) {
      if (dest.size === d.bytes) {
        markUsed(key)
        count(key, d.bytes)
        return dest.uri
      }
      dest.delete()
      forget(key)
    }
    ensureTally()
    if (!fits(d.bytes) && !feasible(d.bytes)) return null
    tmp = new File(dir, name + TMP)
    remove(tmp)
    tmp.create()
    tmp.write(bytes)
    tmp.move(dest)
    tmp = null
    markUsed(key)
    count(key, d.bytes)
    try { settle() } catch {}
    return new File(dir, name).uri
  } catch {
    if (tmp !== null) remove(tmp)
    return null
  }
}

// Deletes every kept file whose core and block interval overlap a range.
export function dropKeptRanges (ranges) {
  try {
    const list = Array.isArray(ranges) ? ranges.map(asRange).filter((r) => r !== null) : []
    if (list.length === 0) return
    for (const k of listKept()) {
      if (list.some((r) => overlaps(k, r))) dropEntry(k)
    }
  } catch {}
}

function authorSet (keys) {
  const set = new Set()
  if (keys === null || typeof keys !== 'object' || typeof keys[Symbol.iterator] !== 'function') return null
  for (const key of keys) {
    const a = authorOf(key)
    if (a !== null) set.add(a)
  }
  return set
}

// Deletes every kept file of these authors (any iterable of keys).
export function dropKeptAuthors (keys) {
  try {
    const drop = authorSet(keys)
    if (drop === null || drop.size === 0) return
    for (const k of listKept()) if (drop.has(k.author)) dropEntry(k)
  } catch {}
}

// Deletes every kept file of an author outside `allowed` (any iterable of
// keys; an empty one deletes everything). Anything that is not an iterable
// is ignored rather than read as "nobody".
export function keepOnlyKeptAuthors (allowed) {
  try {
    const keepSet = authorSet(allowed)
    if (keepSet === null) return
    for (const k of listKept()) if (!keepSet.has(k.author)) dropEntry(k)
  } catch {}
}

// The in-memory cache that held this URI let it go: trimKept may delete
// the file again once KEEP_RELEASE_GRACE_MS has passed (a mounted view may
// still show it). Never deletes anything itself.
export function releaseKept (uri) {
  try {
    if (typeof uri !== 'string') return
    const base = root().uri
    if (!uri.startsWith(base)) return
    const key = uri.slice(base.length)
    const slash = key.indexOf('/')
    if (slash < 0 || !KINDS.includes(key.slice(0, slash)) || !NAME.test(key.slice(slash + 1))) return
    if (inUse.delete(key)) released.set(key, Date.now())
  } catch {}
}

export function wipeKept () {
  inUse.clear()
  released.clear()
  tally = null
  tallyBytes = 0
  try {
    const dir = root()
    if (dir.exists) dir.delete()
  } catch {}
}

const cap = (n, fallback) => Number.isSafeInteger(n) && n >= 0 ? n : fallback

// Deletes leftover .tmp files, files older than KEEP_MAX_AGE_MS, then the
// oldest files (by modification time) until both caps hold, skipping files
// in use or released less than KEEP_RELEASE_GRACE_MS ago; rebuilds the
// tally from what is really left (a failed delete still counts).
function trim (bytesCap, filesCap) {
  const now = Date.now()
  const kept = []
  for (const k of listKept()) {
    if (k.tmp) {
      remove(k.file)
      continue
    }
    let size = 0
    let time = 0
    try {
      size = k.file.size || 0
      time = k.file.modificationTime || 0
    } catch {}
    const used = protectedKey(k.key, now)
    // An unreadable time (0) is not read as very old.
    if (!used && time > 0 && now - time > KEEP_MAX_AGE_MS && remove(k.file)) continue
    kept.push({ key: k.key, file: k.file, size, time, used })
  }
  kept.sort((a, b) => a.time - b.time || (a.file.uri < b.file.uri ? -1 : a.file.uri > b.file.uri ? 1 : 0))
  let total = 0
  for (const k of kept) total += k.size
  let left = kept.length
  const next = new Map()
  for (const k of kept) {
    if (!k.used && (left > filesCap || total > bytesCap) && remove(k.file)) {
      left--
      total -= k.size
      continue
    }
    next.set(k.key, k.size)
  }
  tally = next
  tallyBytes = total
}

// Deletes leftover .tmp files and files older than KEEP_MAX_AGE_MS, then the
// oldest files until both caps hold. Files whose URI this process handed out
// count toward the caps but are never deleted here: when only those are left
// over the cap, trimming stops.
export function trimKept ({ maxBytes = KEEP_MAX_BYTES, maxFiles = KEEP_MAX_FILES } = {}) {
  try {
    trim(cap(maxBytes, KEEP_MAX_BYTES), cap(maxFiles, KEEP_MAX_FILES))
  } catch {}
}
