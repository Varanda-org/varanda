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
  forward('wipe')
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
