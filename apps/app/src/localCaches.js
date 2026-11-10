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

export function wipeLocalCaches () {
  forward('wipe')
}

// keys: the author keys whose content must go.
export function dropAuthors (keys) {
  forward('dropAuthors', keys)
}

// allowed: a Set of the author keys a cache may keep.
export function keepOnlyAuthors (allowed) {
  forward('keepOnlyAuthors', allowed)
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
