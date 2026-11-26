// The browser HTTP cache already keeps the photos of followed authors (the
// fetch uses force-cache for them), so 'avatars' and 'posts' have no store
// here. The peek kinds (Espiadinha strangers, fetched with no-store) live in
// ./peekPhotos.web.js, bound to one member and wiped, dropped and retained on
// demand through ./keptLoad.js. The web has no file URI: keptUrl is always
// null and a peek photo is read back as bytes (keptBytes), which the caller's
// in-memory cache turns into an object URL and revokes. Each purge returns
// the store's promise, which never rejects.

import { peekPhotos } from './peekPhotos.web.js'

export const KEEP_MAX_BYTES = 67108864
export const KEEP_MAX_FILES = 2000
export const KEEP_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
export const KEEP_RELEASE_GRACE_MS = 120000
export const KEEP_PEEK_MAX_BYTES = 8388608
export const KEEP_PEEK_MAX_FILES = 200
export const KEEP_PEEK_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

const PEEK = Object.freeze(['peekAvatars', 'peekPosts'])

export function keptUrl () { return null }

export function keptBytes (kind, author, d) {
  if (!PEEK.includes(kind)) return null
  return peekPhotos.read(kind, author, d)
}

// Not awaited: the caller already holds the bytes and shows them from memory.
export function keep (kind, author, d, bytes) {
  if (!PEEK.includes(kind)) return null
  peekPhotos.put(kind, author, d, bytes).catch(() => {})
  return null
}

export function dropKeptRanges (ranges) { return peekPhotos.dropRanges(ranges) }
export function dropKeptAuthors (keys) { return peekPhotos.dropAuthors(keys) }

// A follow reconcile leaves peek photos alone, as on the phone: retainKept
// and the other purges remove them.
export function keepOnlyKeptAuthors () { return null }

// Object URLs are released by the in-memory cache that made them.
export function releaseKept () { return null }

export function wipeKept () { return peekPhotos.wipe() }

// The store trims to its caps on every put and drops expired rows at bind.
export function trimKept () { return null }

export function retainKept (kinds, entries) {
  let list
  try { list = Array.from(kinds).filter((k) => PEEK.includes(k)) } catch { return null }
  if (list.length === 0) return null
  return peekPhotos.retain(list, entries)
}

// binding: { origin, association, owner }, or null (Vitrine, page actor,
// locked), which turns the store off until the next bind.
export function bindPeek (binding) { return peekPhotos.bind(binding ?? null) }
