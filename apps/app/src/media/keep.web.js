// The web keeps every photo in IndexedDB (./peekPhotos.web.js), never in
// the browser HTTP cache, which nothing can erase on lock, Sair, reset or an
// account change: httpCacheKeeps is false, so ./keptLoad.js fetchPersist
// fetches every photo with no-store. Three stores, each its own database and
// caps: the main kinds ('avatars', 'posts': own and followed authors), the
// peek kinds (Espiadinha strangers) and the copy kinds (strangers a reopened
// screen draws, and decrypted private group pictures). Wipes, author drops
// and range drops reach all three; keepOnlyKeptAuthors only the main store,
// retainKept only the peek store, and only retainGroupThumbs prunes the group
// pictures, as on the phone. The web has no file URI: keptUrl is always null
// and a kept photo is read back as bytes (keptBytes), which the caller's
// in-memory cache turns into an object URL and revokes. Each purge returns a
// promise of the stores' answers, which never rejects.

import { copyPhotos, keptPhotos, peekPhotos } from './peekPhotos.web.js'

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
export const httpCacheKeeps = false

const PEEK = Object.freeze(['peekAvatars', 'peekPosts'])
const COPY = Object.freeze(['copyAvatars', 'copyPosts'])
const MAIN = Object.freeze(['avatars', 'posts'])
const HEX64 = /^[0-9a-f]{64}$/

const storeOf = (kind) => MAIN.includes(kind) ? keptPhotos : PEEK.includes(kind) ? peekPhotos : COPY.includes(kind) ? copyPhotos : null

// -> true only when every store answered true.
function all (...answers) {
  return Promise.all(answers).then((list) => list.every((x) => x === true), () => false)
}

export function keptUrl () { return null }

export function keptBytes (kind, author, d) {
  const store = storeOf(kind)
  return store === null ? null : store.read(kind, author, d)
}

// Not awaited: the caller already holds the bytes and shows them from memory.
export function keep (kind, author, d, bytes) {
  const store = storeOf(kind)
  if (store === null) return null
  store.put(kind, author, d, bytes).catch(() => {})
  return null
}

// A decrypted private group picture: author is the image author, sha the
// plaintext hash. -> a promise of its bytes, or null.
export function keptGroupThumb (author, sha) { return copyPhotos.readThumb(author, sha) }

// Not awaited, as keep.
export function keepGroupThumb (author, sha, bytes, mime) {
  copyPhotos.putThumb(author, sha, bytes, mime).catch(() => {})
  return null
}

// Deletes every group picture pairs ([{ author, sha }]) does not name.
export function retainGroupThumbs (pairs) { return copyPhotos.retainThumbs(pairs) }

export function dropKeptRanges (ranges) { return all(keptPhotos.dropRanges(ranges), peekPhotos.dropRanges(ranges), copyPhotos.dropRanges(ranges)) }
export function dropKeptAuthors (keys) { return all(keptPhotos.dropAuthors(keys), peekPhotos.dropAuthors(keys), copyPhotos.dropAuthors(keys)) }

// A follow reconcile prunes only the main store, as on the phone: retainKept
// and the other purges remove peek and copy photos. The store cancels the
// puts queued before it, so none lands after its listing. Anything but an
// iterable of keys is ignored rather than read as "nobody".
export function keepOnlyKeptAuthors (allowed) {
  if (allowed === null || typeof allowed !== 'object' || typeof allowed[Symbol.iterator] !== 'function') return null
  let keepSet
  try { keepSet = Array.from(allowed, (k) => typeof k === 'string' ? k.toLowerCase() : null).filter((k) => k !== null && HEX64.test(k)) } catch { return null }
  return keptPhotos.keepOnlyAuthors(keepSet).then((ok) => ok === true, () => false)
}

// Object URLs are released by the in-memory cache that made them.
export function releaseKept () { return null }

export function wipeKept () { return all(keptPhotos.wipe(), peekPhotos.wipe(), copyPhotos.wipe()) }

// The stores trim to their caps on every put and drop expired rows at bind.
export function trimKept () { return null }

// Only the peek kinds: any reopened screen may draw a copy photo, so no
// single screen's retain may delete it.
export function retainKept (kinds, entries) {
  let list
  try { list = Array.from(kinds).filter((k) => PEEK.includes(k)) } catch { return null }
  if (list.length === 0) return null
  return peekPhotos.retain(list, entries)
}

// binding: { origin, association, owner }, or null (Vitrine, page actor,
// locked), which turns the three stores off until the next bind.
export function bindPeek (binding) {
  const b = binding ?? null
  return all(keptPhotos.bind(b), peekPhotos.bind(b), copyPhotos.bind(b))
}
