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
// deletes nothing. A file leaves the tally, and loses its protection, only
// once it is really gone, so a failed delete never makes the store look
// smaller than it is nor lets a trim take a file a view shows. A file is in use from
// the moment its URI is handed out until KEEP_RELEASE_GRACE_MS after an
// in-memory URL cache evicts it (releaseKept): a mounted view may still show
// that URI for a while. Files older than
// KEEP_MAX_AGE_MS go at every trim, so photos of posts a followed author
// deleted do not stay forever; reading a file does not refresh its age.
//
// Peek kinds (peekAvatars, peekPosts): photos of strangers the Espiadinha
// shows, kept only when ../localCaches.js peekKeepAllowed says so (see
// ./keptLoad.js). They live in their own directories, so a peek file never
// answers for a followed author's entry, and have their own tally and much
// smaller caps (KEEP_PEEK_*), so they never push out a followed author's
// photo. A follow reconcile (keepOnlyKeptAuthors) leaves them alone; a block,
// a range revoke, a wipe and retainKept remove them.
//
// Copy kinds (copyAvatars, copyPosts): photos of strangers that A Rua, the
// Diário, Conversas and Avisos show, kept so a reopened screen draws them
// (./keptLoad.js persist 'copy'). A third pool with its own directories,
// tally and caps (KEEP_COPY_*), so it never evicts a main or peek file. A
// block, a range revoke and a wipe remove them; a follow reconcile and
// retainKept never do, since any reopened screen may draw them. The pool also
// holds copyGroupThumbs: decrypted private group pictures, one file per image
// author and plaintext hash (THUMB_NAME), at most KEEP_GROUP_THUMB_MAX_BYTES
// each, pruned by list only through retainGroupThumbs.

import { Directory, File, Paths } from 'expo-file-system'
import { validDescriptor } from './fetch.js'

const ROOT = 'varanda-media-keep'
const THUMBS = 'copyGroupThumbs'
const MAIN_KINDS = Object.freeze(['avatars', 'posts'])
const PEEK_KINDS = Object.freeze(['peekAvatars', 'peekPosts'])
const COPY_KINDS = Object.freeze(['copyAvatars', 'copyPosts', THUMBS])
const KINDS = Object.freeze([...MAIN_KINDS, ...PEEK_KINDS, ...COPY_KINDS])
const EXT = Object.freeze({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' })
const HEX64 = /^[0-9a-f]{64}$/
const NAME = /^([0-9a-f]{64})-([0-9a-f]{64})-([0-9]+)-([0-9]+)-([0-9]+)-([0-9a-f]{64})-([0-9]+)x([0-9]+)\.(jpg|png|webp|gif|avif)$/
// copyGroupThumbs: <image author>-<plaintext sha256>.<ext>
const THUMB_NAME = /^([0-9a-f]{64})-([0-9a-f]{64})\.(jpg|png|webp|gif|avif)$/
const nameRule = (kind) => kind === THUMBS ? THUMB_NAME : NAME
const TMP = '.tmp'
// The previous file while keep(replace) moves new bytes under its name.
const OLD = '.old'

export const KEEP_MAX_BYTES = 67108864
export const KEEP_MAX_FILES = 2000
export const KEEP_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
export const KEEP_RELEASE_GRACE_MS = 120000
export const KEEP_PEEK_MAX_BYTES = 8388608
export const KEEP_PEEK_MAX_FILES = 200
export const KEEP_PEEK_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
export const KEEP_COPY_MAX_BYTES = 8388608
export const KEEP_COPY_MAX_FILES = 200
export const KEEP_COPY_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000
export const KEEP_GROUP_THUMB_MAX_BYTES = 262144
// The only picture the live draw shows (a 512x512 JPEG), so one file per
// author and hash.
const THUMB_MIME = 'image/jpeg'
// A followed author's photo may also be fetched into the HTTP cache
// (./keptLoad.js fetchPersist); the web's answer (./keep.web.js) is no.
export const httpCacheKeeps = true

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

// One budget per group of kinds. tally: key -> size of every kept file of
// those kinds (no .tmp), or null until a keep needs it.
function pool (kinds, maxBytes, maxFiles, maxAge) {
  return { kinds, maxBytes, maxFiles, maxAge, tally: null, bytes: 0 }
}
const MAIN = pool(MAIN_KINDS, KEEP_MAX_BYTES, KEEP_MAX_FILES, KEEP_MAX_AGE_MS)
const PEEK = pool(PEEK_KINDS, KEEP_PEEK_MAX_BYTES, KEEP_PEEK_MAX_FILES, KEEP_PEEK_MAX_AGE_MS)
const COPY = pool(COPY_KINDS, KEEP_COPY_MAX_BYTES, KEEP_COPY_MAX_FILES, KEEP_COPY_MAX_AGE_MS)
const POOLS = Object.freeze([MAIN, PEEK, COPY])

const poolOfKind = (kind) => PEEK_KINDS.includes(kind) ? PEEK : COPY_KINDS.includes(kind) ? COPY : MAIN
const poolOfKey = (key) => poolOfKind(key.slice(0, key.indexOf('/')))

function forget (key) {
  const p = poolOfKey(key)
  if (p.tally !== null && p.tally.has(key)) {
    p.bytes -= p.tally.get(key)
    p.tally.delete(key)
  }
}

function count (key, size) {
  const p = poolOfKey(key)
  if (p.tally === null) return
  forget(key)
  p.tally.set(key, size)
  p.bytes += size
}

function sizeOf (file) {
  try { return file.size || 0 } catch { return 0 }
}

function ensureTally (p) {
  if (p.tally !== null) return
  const next = new Map()
  let bytes = 0
  for (const k of listKept(p.kinds)) {
    if (k.tmp) continue
    const size = sizeOf(k.file)
    next.set(k.key, size)
    bytes += size
  }
  p.tally = next
  p.bytes = bytes
}

const root = () => new Directory(Paths.cache, ROOT)
const kindDir = (kind) => new Directory(root(), kind)

function authorOf (author) {
  if (typeof author !== 'string') return null
  const lower = author.toLowerCase()
  return HEX64.test(lower) ? lower : null
}

function nameOf (kind, author, d) {
  if (kind === THUMBS || !KINDS.includes(kind)) return null
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
  if (!remove(k.file)) return
  unmark(k.key)
  forget(k.key)
}

// Every kept file (and every leftover .tmp of an interrupted write or .old
// of an interrupted replace, both with tmp set), parsed from its name.
// Entries with any other name are left alone.
function listKept (kinds = KINDS) {
  const out = []
  for (const kind of kinds) {
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
      const old = raw.endsWith(OLD)
      const tmp = old || raw.endsWith(TMP)
      const name = tmp ? raw.slice(0, -(old ? OLD : TMP).length) : raw
      const m = nameRule(kind).exec(name)
      if (m === null) continue
      // A group picture has no range: no range revoke reaches it.
      const thumb = kind === THUMBS
      out.push({
        key: kind + '/' + raw,
        file: new File(kindDir(kind), raw),
        kind,
        name,
        tmp,
        old,
        author: m[1],
        core: thumb ? null : m[2],
        sha: thumb ? m[2] : null,
        start: thumb ? 0 : Number(m[3]),
        blocks: thumb ? 0 : Number(m[4])
      })
    }
  }
  return out
}

// The peek and copy kinds are trimmed (age and caps) once per start, at
// their first use: otherwise a pool under its caps would never reach trim and
// keep a stranger's photo past its pool's age.
const trimmedOnce = new Set()
function trimOnce (p) {
  if (p === MAIN || trimmedOnce.has(p)) return
  trimmedOnce.add(p)
  try { trim(p, p.maxBytes, p.maxFiles) } catch {}
}

// Whether a file is past its pool's age (an unreadable time, 0, is not read
// as very old, as in trim).
function expired (file, maxAge) {
  let time = 0
  try { time = file.modificationTime || 0 } catch {}
  return time > 0 && Date.now() - time > maxAge
}

// The kept file's URI, or null. A file whose size is not d.bytes is deleted:
// it was cut short and would show a broken photo. So is a peek or copy file
// past its pool's age: a stranger's photo never answers longer than that.
export function keptUrl (kind, author, d) {
  try {
    const name = nameOf(kind, author, d)
    if (name === null) return null
    const p = poolOfKind(kind)
    trimOnce(p)
    const file = new File(kindDir(kind), name)
    if (!file.exists) return null
    if (file.size !== d.bytes || (p !== MAIN && expired(file, p.maxAge))) {
      dropEntry({ key: kind + '/' + name, file })
      return null
    }
    markUsed(kind + '/' + name)
    return file.uri
  } catch {
    return null
  }
}

const fits = (p, size) => p.tally.size + 1 <= p.maxFiles && p.bytes + size <= p.maxBytes

// Whether one more file of `size` bytes can fit once every file not
// protected is gone: decided from the tally, before anything is deleted.
function feasible (p, size) {
  if (size > p.maxBytes) return false
  const now = Date.now()
  let files = 0
  let bytes = 0
  for (const [key, n] of p.tally) {
    if (!protectedKey(key, now)) continue
    files++
    bytes += n
  }
  return files + 1 <= p.maxFiles && bytes + size <= p.maxBytes
}

// After a new file joined the tally: trims the oldest files not protected
// (the new one is in use) back under the caps, with room to spare.
function settle (p) {
  if (p.tally.size <= p.maxFiles && p.bytes <= p.maxBytes) return
  trim(
    p,
    Math.max(0, p.maxBytes - Math.floor(p.maxBytes / SLACK)),
    Math.max(0, p.maxFiles - Math.floor(p.maxFiles / SLACK))
  )
}

// Writes verified bytes under their name and returns the URI, or null (also
// when the caps leave no room). The bytes go to <name>.tmp first and are
// moved into place, so a crash never leaves a partial file under a name
// keptUrl would serve; only a committed file makes the store trim others.
// A file already under the name is served as is, unless `replace` (a view
// could not draw it). A move does not overwrite, so once the new bytes are
// in the .tmp the old file moves to <name>.old, the .tmp moves into place
// and only then is the .old deleted. A failed step moves the old file back
// and returns null; a crash in between leaves a .old the next trim moves
// back. The name keeps its protection and its tally entry throughout.
export function keep (kind, author, d, bytes, { replace = false } = {}) {
  try {
    const name = nameOf(kind, author, d)
    if (name === null || !(bytes instanceof Uint8Array) || bytes.byteLength !== d.bytes) return null
    return write(kind, name, bytes, replace === true)
  } catch {
    return null
  }
}

// keep() once the name and bytes were checked.
function write (kind, name, bytes, replace) {
  let tmp = null
  let putBack = null
  try {
    const size = bytes.byteLength
    const key = kind + '/' + name
    const p = poolOfKind(kind)
    trimOnce(p)
    const dir = kindDir(kind)
    dir.create({ intermediates: true, idempotent: true })
    const dest = new File(dir, name)
    const swap = replace && dest.exists
    if (!swap && dest.exists) {
      if (dest.size === size) {
        markUsed(key)
        count(key, size)
        return dest.uri
      }
      dest.delete()
      forget(key)
    }
    ensureTally(p)
    if (!swap && !fits(p, size) && !feasible(p, size)) return null
    tmp = new File(dir, name + TMP)
    remove(tmp)
    tmp.create()
    tmp.write(bytes)
    if (swap) {
      const backup = new File(dir, name + OLD)
      remove(backup)
      new File(dir, name).move(backup)
      putBack = () => { try { new File(dir, name + OLD).move(new File(dir, name)) } catch {} }
    }
    tmp.move(new File(dir, name))
    tmp = null
    putBack = null
    if (swap) remove(new File(dir, name + OLD))
    markUsed(key)
    count(key, size)
    try { settle(p) } catch {}
    return new File(dir, name).uri
  } catch {
    if (tmp !== null) remove(tmp)
    if (putBack !== null) putBack()
    return null
  }
}

function thumbParts (author, sha) {
  const a = authorOf(author)
  if (a === null || typeof sha !== 'string' || !HEX64.test(sha)) return null
  return a + '-' + sha
}

// The URI of a kept decrypted group picture (image author, plaintext hash),
// or null. A file past the copy age, empty or over KEEP_GROUP_THUMB_MAX_BYTES
// is deleted.
export function keptGroupThumb (author, sha) {
  try {
    const base = thumbParts(author, sha)
    if (base === null) return null
    trimOnce(COPY)
    const name = base + '.' + EXT[THUMB_MIME]
    const file = new File(kindDir(THUMBS), name)
    if (!file.exists) return null
    const size = file.size
    if (size < 1 || size > KEEP_GROUP_THUMB_MAX_BYTES || expired(file, COPY.maxAge)) {
      dropEntry({ key: THUMBS + '/' + name, file })
      return null
    }
    markUsed(THUMBS + '/' + name)
    return file.uri
  } catch {
    return null
  }
}

// Keeps a decrypted group picture under the copy pool's caps. -> its URI or
// null. The caller decides who may be kept and checked the hash.
export function keepGroupThumb (author, sha, bytes, mime) {
  try {
    const base = thumbParts(author, sha)
    if (base === null || mime !== THUMB_MIME || !(bytes instanceof Uint8Array)) return null
    if (bytes.byteLength < 1 || bytes.byteLength > KEEP_GROUP_THUMB_MAX_BYTES) return null
    return write(THUMBS, base + '.' + EXT[mime], bytes, false)
  } catch {
    return null
  }
}

// Deletes every group picture that pairs ([{ author, sha }]) does not name;
// an empty list deletes them all. Anything that is not an array is ignored.
export function retainGroupThumbs (pairs) {
  try {
    if (!Array.isArray(pairs)) return null
    const names = new Set()
    for (const pair of pairs) {
      const base = pair && typeof pair === 'object' ? thumbParts(pair.author, pair.sha) : null
      if (base !== null) names.add(base)
    }
    for (const k of listKept([THUMBS])) if (k.tmp || !names.has(k.author + '-' + k.sha)) dropEntry(k)
  } catch {}
  return null
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
// is ignored rather than read as "nobody". The peek kinds hold strangers by
// design, so a follow reconcile leaves them to retainKept and the purges.
export function keepOnlyKeptAuthors (allowed) {
  try {
    const keepSet = authorSet(allowed)
    if (keepSet === null) return
    for (const k of listKept(MAIN_KINDS)) if (!keepSet.has(k.author)) dropEntry(k)
  } catch {}
}

// Deletes every file of `kinds` (an array of kind names) that `entries`
// ([{ kind, author, d }]) does not name; an empty list deletes them all.
// Anything that is not an array is ignored rather than read as "nothing".
// The copy kinds are never retained: any reopened screen may draw them.
export function retainKept (kinds, entries) {
  try {
    if (!Array.isArray(kinds) || !Array.isArray(entries)) return null
    const list = KINDS.filter((kind) => !COPY_KINDS.includes(kind) && kinds.includes(kind))
    if (list.length === 0) return null
    const names = new Set()
    for (const e of entries) {
      if (!e || typeof e !== 'object') continue
      const name = nameOf(e.kind, e.author, e.d)
      if (name !== null) names.add(e.kind + '/' + name)
    }
    for (const k of listKept(list)) if (k.tmp || !names.has(k.key)) dropEntry(k)
  } catch {}
  return null
}

// Files are read by URI here (keptUrl): no bytes read.
export function keptBytes () { return null }

// The web store binds its peek and copy stores here; natively nothing to
// bind, but a call runs the once-per-start trim of the peek and copy kinds.
export function bindPeek () {
  trimOnce(PEEK)
  trimOnce(COPY)
  return null
}

// The '<kind>/<name>' key of a kept file's URI, or null for any URI that is
// not exactly a kept name directly under a kind directory of the store.
function keptKeyOf (uri) {
  if (typeof uri !== 'string') return null
  const base = root().uri
  if (!uri.startsWith(base)) return null
  const key = uri.slice(base.length)
  const slash = key.indexOf('/')
  const kind = key.slice(0, slash)
  if (slash < 0 || !KINDS.includes(kind) || !nameRule(kind).test(key.slice(slash + 1))) return null
  return key
}

// The in-memory cache that held this URI let it go: trimKept may delete
// the file again once KEEP_RELEASE_GRACE_MS has passed (a mounted view may
// still show it). Never deletes anything itself.
export function releaseKept (uri) {
  try {
    const key = keptKeyOf(uri)
    if (key === null) return
    if (inUse.delete(key)) released.set(key, Date.now())
  } catch {}
}

export function wipeKept () {
  inUse.clear()
  released.clear()
  for (const p of POOLS) {
    p.tally = null
    p.bytes = 0
  }
  try {
    const dir = root()
    if (dir.exists) dir.delete()
  } catch {}
}

const cap = (n, fallback) => Number.isSafeInteger(n) && n >= 0 ? n : fallback

function liveExists (k) {
  try { return new File(kindDir(k.kind), k.name).exists } catch { return false }
}

// Moves back an orphaned .old, deletes other leftover .tmp and .old files,
// files older than KEEP_MAX_AGE_MS, then the oldest files (by modification time) until both caps hold, skipping files
// in use or released less than KEEP_RELEASE_GRACE_MS ago; rebuilds the
// tally from what is really left (a failed delete still counts).
function trim (p, bytesCap, filesCap) {
  const now = Date.now()
  // A replace interrupted after the old file moved aside: it goes back
  // under its name, so a crash never costs the kept copy. Nothing marked it
  // in use while its name was empty, so this pass does not delete it either.
  const restored = new Set()
  for (const k of listKept(p.kinds)) {
    if (!k.old) continue
    try {
      const dest = new File(kindDir(k.kind), k.name)
      if (!dest.exists) {
        k.file.move(dest)
        restored.add(k.kind + '/' + k.name)
      }
    } catch {}
  }
  const kept = []
  for (const k of listKept(p.kinds)) {
    if (k.tmp) {
      // A .old whose name is still empty could not move back: it is the
      // only copy, left for the next trim.
      if (!k.old || liveExists(k)) remove(k.file)
      continue
    }
    let size = 0
    let time = 0
    try {
      size = k.file.size || 0
      time = k.file.modificationTime || 0
    } catch {}
    const used = protectedKey(k.key, now) || restored.has(k.key)
    // An unreadable time (0) is not read as very old.
    if (!used && time > 0 && now - time > p.maxAge && remove(k.file)) continue
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
  p.tally = next
  p.bytes = total
}

// Deletes leftover .tmp files and files older than KEEP_MAX_AGE_MS, then the
// oldest files until both caps hold. Files whose URI this process handed out
// count toward the caps but are never deleted here: when only those are left
// over the cap, trimming stops. The options set the main caps; the peek and
// copy kinds are trimmed the same way under their own (KEEP_PEEK_*,
// KEEP_COPY_*).
export function trimKept ({ maxBytes = KEEP_MAX_BYTES, maxFiles = KEEP_MAX_FILES } = {}) {
  try {
    trim(MAIN, cap(maxBytes, KEEP_MAX_BYTES), cap(maxFiles, KEEP_MAX_FILES))
  } catch {}
  for (const p of [PEEK, COPY]) {
    try {
      trim(p, p.maxBytes, p.maxFiles)
    } catch {}
  }
}
