// The display URL of a post photo or an avatar, read from the kept store
// (./keep) when it holds a verified copy, so a restart shows the own and
// followed authors' photos with no fetch and no hash. Only bytes that passed
// the verified fetch (and validate, for avatars) are ever kept, and only for
// persist !== false and a lowercase hex author key: photos of strangers
// never reach the disk.
//
// A purge (wipe, author drop, range revoke) bumps the cache generation
// (../localCaches.js); a fetch that started before it does not keep its
// bytes, so work in flight cannot recreate what the purge removed.
//
// Pure: every dependency is injected, no React, react-native or Node imports.

const HEX64 = /^[0-9a-f]{64}$/

// -> a display URL (kept file URI or urlFromBytes). Errors of fetchBytes pass
// through unchanged; bytes that fail validate are 'foto inválida'.
// requestedGeneration: the generation read when the photo was requested,
// before the load waited behind the cache's concurrency limit; a purge while
// it was queued must also prevent the keep. Defaults to the value at start.
export async function loadKept ({ kind, author, d, persist, keptUrl, keep, fetchBytes, urlFromBytes, generation, requestedGeneration, validate }) {
  const keepable = persist !== false && typeof author === 'string' && HEX64.test(author)
  if (keepable) {
    const hit = keptUrl(kind, author, d)
    if (typeof hit === 'string' && hit !== '') return hit
  }
  const g = !keepable ? null : Number.isSafeInteger(requestedGeneration) ? requestedGeneration : generation()
  const bytes = await fetchBytes(d)
  if (typeof validate === 'function' && !validate(bytes, d)) throw new Error('foto inválida')
  if (keepable && generation() === g) {
    const uri = keep(kind, author, d, bytes)
    if (typeof uri === 'string' && uri !== '') return uri
  }
  if (typeof urlFromBytes !== 'function') throw new Error('sem exibição')
  return urlFromBytes(bytes, d.mime)
}

let registered = false
const memoryCaches = new Set()

function clearMemory () {
  for (const cache of memoryCaches) {
    try { cache.clear() } catch {}
  }
}

// Wires the kept store into range revocation (../media/cache.js) and the
// local cache registry (../localCaches.js), once per run whatever the number
// of callers. Each caller also hands its in-memory URL cache (`cache`): a
// wipe, an author drop or a keep-only clears it whole, since post keys carry
// no author, so no entry keeps answering with a deleted kept file. A range
// revoke needs nothing here: revokeMedia already drops those entries.
// Clearing releases the URLs through the cache's revoke, which ignores kept
// files. -> true when this call registered the store.
export function registerKeptStore ({ onRevokedRanges, bumpCacheGeneration, registerLocalCache, store, cache }) {
  if (cache && typeof cache.clear === 'function') memoryCaches.add(cache)
  if (registered) return false
  registered = true
  onRevokedRanges((ranges) => {
    bumpCacheGeneration()
    store.dropKeptRanges(ranges)
  })
  registerLocalCache({
    wipe () {
      store.wipeKept()
      clearMemory()
    },
    dropAuthors (keys) {
      store.dropKeptAuthors(keys)
      clearMemory()
    },
    keepOnlyAuthors (allowed) {
      store.keepOnlyKeptAuthors(allowed)
      clearMemory()
    }
  })
  return true
}
