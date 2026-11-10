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

// Kept files ('<kind>/<name>') whose URI this process handed out: an
// in-memory URL cache may still serve it, so trimKept never deletes them.
// The purges below do (the registry clears those caches with them).
const inUse = new Set()

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

function remove (file) {
  try { if (file.exists) file.delete() } catch {}
}

function dropEntry (k) {
  inUse.delete(k.key)
  remove(k.file)
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
      inUse.delete(kind + '/' + name)
      remove(file)
      return null
    }
    inUse.add(kind + '/' + name)
    return file.uri
  } catch {
    return null
  }
}

// Writes verified bytes under their name and returns the URI, or null. The
// bytes go to <name>.tmp first and are moved into place, so a crash never
// leaves a partial file under a name keptUrl would serve.
export function keep (kind, author, d, bytes) {
  let tmp = null
  try {
    const name = nameOf(kind, author, d)
    if (name === null || !(bytes instanceof Uint8Array) || bytes.byteLength !== d.bytes) return null
    const dir = kindDir(kind)
    dir.create({ intermediates: true, idempotent: true })
    const dest = new File(dir, name)
    if (dest.exists) {
      if (dest.size === d.bytes) {
        inUse.add(kind + '/' + name)
        return dest.uri
      }
      dest.delete()
    }
    tmp = new File(dir, name + TMP)
    remove(tmp)
    tmp.create()
    tmp.write(bytes)
    tmp.move(dest)
    tmp = null
    inUse.add(kind + '/' + name)
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

export function wipeKept () {
  inUse.clear()
  try {
    const dir = root()
    if (dir.exists) dir.delete()
  } catch {}
}

const cap = (n, fallback) => Number.isSafeInteger(n) && n >= 0 ? n : fallback

// Deletes the oldest files (by modification time) until both caps hold.
// Leftover .tmp files go first, whatever their age. Files whose URI this
// process handed out count toward the caps but are never deleted here: when
// only those are left over the cap, trimming stops.
export function trimKept ({ maxBytes = KEEP_MAX_BYTES, maxFiles = KEEP_MAX_FILES } = {}) {
  try {
    const bytesCap = cap(maxBytes, KEEP_MAX_BYTES)
    const filesCap = cap(maxFiles, KEEP_MAX_FILES)
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
      kept.push({ file: k.file, size, time, used: inUse.has(k.key) })
    }
    kept.sort((a, b) => a.time - b.time || (a.file.uri < b.file.uri ? -1 : a.file.uri > b.file.uri ? 1 : 0))
    let total = 0
    for (const k of kept) total += k.size
    let count = kept.length
    for (const k of kept) {
      if (count <= filesCap && total <= bytesCap) break
      if (k.used) continue
      remove(k.file)
      count--
      total -= k.size
    }
  } catch {}
}
