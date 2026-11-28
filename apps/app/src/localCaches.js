// One registry for every local cache of other people's content (kept photos,
// and later A Rua and per-screen snapshots). The session's identity,
// installation and blocks decide what such a cache may hold, so src/node.js
// and src/blocksProvider.js invalidate all of them here instead of knowing
// each store.
//
// Every invalidation bumps a generation. A writer reads cacheGeneration()
// before a debounce or a fetch and drops its write when the number changed,
// so work already in flight can never recreate what a purge removed.
//
// Pure: no React, react-native or Node imports, so the tests load it as is.

const caches = new Set()
let generation = 0
// The complete set of authors a cache may keep (own key included by the
// caller), or null while none is known.
let allowed = null
// Authors dropped this run (a block): never allowed again, whatever a later
// allowed set says, since the follow list is not filtered by blocks. An
// unblock is not tracked: the author stays denied until the next wipe, which
// is the safe side (photos are only shown, not kept).
const denied = new Set()
// Whether block.list answered in this run (since the last wipe). Until it
// has, nothing of a stranger may be kept: a blocked author is not denied yet.
let blocksKnown = false
// Whether a stored block list (saved by an earlier run of this identity) was
// adopted since the last wipe. It lets a copy already on disk be read, never
// a stranger's photo be written: only blocksKnown does that.
let blocksSeeded = false
// Bumped by every wipe only (an identity may have changed), unlike the cache
// generation, which every purge bumps, the deny of a list read included.
let wipes = 0

const HEX64 = /^[0-9a-f]{64}$/

function keySet (keys) {
  if (keys === null || typeof keys !== 'object' || typeof keys[Symbol.iterator] !== 'function') return null
  const set = new Set()
  for (const key of keys) if (typeof key === 'string') set.add(key.toLowerCase())
  return set
}

// keys: the complete allowed set (any iterable), or null to forget it.
// Anything else is ignored.
export function setAllowedAuthors (keys) {
  if (keys === null) {
    allowed = null
    return
  }
  const set = keySet(keys)
  if (set !== null) allowed = set
}

// -> false for a dropped author; else true while no complete set is known,
// else whether `key` is in it.
export function allowedAuthor (key) {
  if (typeof key !== 'string') return allowed === null
  const k = key.toLowerCase()
  if (denied.has(k)) return false
  return allowed === null || allowed.has(k)
}

// -> a token read before a block.list request; a wipe changes it.
export function wipeEpoch () {
  return wipes
}

// Called once a whole block.list answer was committed (its new blocks are
// denied by then). since: the wipeEpoch() read before the request. An answer
// that started before a wipe was for what may be another identity: it marks
// nothing.
export function noteBlocksKnown (since) {
  if (since !== wipes) return
  blocksKnown = true
}

// -> whether a photo of `key` may go to the peek kinds: only once the blocks
// are known, never for a denied author, and only for an author outside a
// known allowed set (an own or followed author belongs to the main kinds).
export function peekKeepAllowed (key) {
  if (typeof key !== 'string' || !blocksKnown || allowed === null) return false
  const k = key.toLowerCase()
  return !denied.has(k) && !allowed.has(k)
}

// Called once a stored block list was adopted (its keys denied through
// denyAuthors). since: the wipeEpoch() read before the list was loaded.
export function noteBlocksSeeded (since) {
  if (since !== wipes) return
  blocksSeeded = true
}

// keys: authors of a stored block list. Each one already went through
// dropAuthors in the run that saved it, so nothing is purged and the
// generation stays: a purge here would drop what screens show on reopen.
export function denyAuthors (keys) {
  const set = keySet(keys)
  if (set !== null) for (const key of set) denied.add(key)
}

export function deniedAuthor (key) {
  return typeof key === 'string' && denied.has(key.toLowerCase())
}

// -> true only for an author inside a known allowed set and not denied.
export function followedAuthor (key) {
  if (typeof key !== 'string' || allowed === null) return false
  const k = key.toLowerCase()
  return allowed.has(k) && !denied.has(k)
}

// -> whether a copy-kind photo of `key` already on disk may be read: once a
// block list is known or adopted in this run, never for a denied author.
export function copyReadAllowed (key) {
  if (typeof key !== 'string' || (!blocksKnown && !blocksSeeded)) return false
  return !denied.has(key.toLowerCase())
}

// -> whether a private group picture by `author` may be kept: once this
// run's block list is known, never for a denied author. Follow status does
// not matter: a group's author is often followed, which peekKeepAllowed
// refuses.
export function groupThumbKeepAllowed (author) {
  if (typeof author !== 'string' || !blocksKnown) return false
  const k = author.toLowerCase()
  return HEX64.test(k) && !denied.has(k)
}

// entry: { wipe, dropAuthors, keepOnlyAuthors }, each optional.
// -> a function that removes the entry.
export function registerLocalCache (entry) {
  const own = { ...entry }
  caches.add(own)
  return () => { caches.delete(own) }
}

export function cacheGeneration () {
  return generation
}

export function bumpCacheGeneration () {
  generation++
}

// A failing store must not keep the others (or the caller's identity change)
// from going ahead: each call is isolated.
function forward (name, arg) {
  generation++
  for (const cache of [...caches]) {
    const fn = cache[name]
    if (typeof fn !== 'function') continue
    try {
      const out = name === 'wipe' ? fn() : fn(arg)
      if (out && typeof out.then === 'function') out.then(null, () => {})
    } catch {}
  }
}

// The identity may change: the allowed and denied sets are forgotten with
// the content.
export function wipeLocalCaches () {
  allowed = null
  denied.clear()
  blocksKnown = false
  blocksSeeded = false
  wipes++
  forward('wipe')
}

// status: the first identity.status() of a connection, read after the kept
// session's resume; failed: that read threw. -> true when it says no session
// is open (expired, signed out elsewhere, never made) or could not say, so
// nothing private outlives it on disk (a later re-read never wipes); false
// for null or undefined without a failure (the node has no identity API).
export function shouldWipeOnStart (status, failed = false) {
  if (failed === true) return true
  if (status === null || typeof status !== 'object') return false
  return status.unlocked !== true
}

// keys: the author keys whose content must go. They are denied from now on.
export function dropAuthors (keys) {
  const drop = keySet(keys)
  if (drop !== null) for (const key of drop) denied.add(key)
  forward('dropAuthors', keys)
}

// keys: a Set of the author keys a cache may keep, recorded as the allowed
// set (a value that is not an iterable records nothing).
export function keepOnlyAuthors (keys) {
  const set = keySet(keys)
  if (set !== null) allowed = set
  forward('keepOnlyAuthors', keys)
}

// -> the keys of `next` (a Set) that `prev` lacks.
export function newlyBlocked (prev, next) {
  const out = []
  if (!next) return out
  for (const key of next) {
    if (!prev || !prev.has(key)) out.push(key)
  }
  return out
}
