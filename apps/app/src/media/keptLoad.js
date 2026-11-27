// The display URL of a post photo or an avatar, read from the kept store
// (./keep) when it holds a verified copy, so a restart shows the own and
// followed authors' photos with no fetch and no hash. Only bytes that passed
// the verified fetch (and validate, for avatars) are ever kept, and only for
// persist !== false and a lowercase hex author key: photos of strangers
// never reach the disk, except persist 'peek' (below).
//
// A purge (wipe, author drop, range revoke) bumps the cache generation
// (../localCaches.js); a fetch that started before it does not keep its
// bytes, so work in flight cannot recreate what the purge removed.
//
// Defence in depth: once the registry knows the complete allowed set
// (../localCaches.js allowedAuthor), an author outside it is shown but never
// kept, whatever persist says.
//
// persist 'peek': a stranger shown by the Espiadinha. Its photos go to their
// own kinds (storeKindOf), with their own caps, and only once
// ../localCaches.js peekKeepAllowed says so: never before block.list
// answered in this run, never for a blocked author.
//
// persist 'copy': a photo a reopened screen may draw from its saved copy. A
// followed author's photo goes to the main kinds; a stranger's to the copy
// kinds (copyKindOf), on the same rule as a peek photo. A copy file is read
// back once a block list is known or was adopted from storage
// (copyReadAllowed), so a reopen draws it before block.list answers.
//
// No kept file, of any kind, answers for a denied author.
//
// Pure: no React, react-native or Node imports; the store is injected.

import { allowedAuthor, copyReadAllowed, deniedAuthor, followedAuthor, peekKeepAllowed } from '../localCaches.js'

const HEX64 = /^[0-9a-f]{64}$/
const COPY_KINDS = Object.freeze(['copyAvatars', 'copyPosts'])

// -> the store kind for a photo: the peek kinds for persist 'peek', so a peek
// file can never answer for a followed author's entry.
export function storeKindOf (kind, persist) {
  if (persist === 'peek') return kind === 'avatars' ? 'peekAvatars' : 'peekPosts'
  return kind
}

// -> the persist mode of a caller's prop: 'peek', 'copy', false (also for
// null and undefined) or true.
export function persistMode (p) {
  if (p === 'peek' || p === 'copy') return p
  if (p === false || p === null || p === undefined) return false
  return true
}

export function copyKindOf (kind) {
  return kind === 'avatars' ? 'copyAvatars' : 'copyPosts'
}

// -> whether the HTTP cache may hold the bytes of a fetch in `mode`: a copy
// mode stranger's photo never reaches a cache no purge can reach. Never on
// a platform whose registered store says its HTTP cache cannot be purged
// (./keep.web.js httpCacheKeeps false): there the stores hold every photo.
export function fetchPersist (mode, author) {
  if (bound !== null && bound.store && bound.store.httpCacheKeeps === false) return false
  if (mode === true) return true
  if (mode === 'copy') return followedAuthor(author)
  return false
}

// -> a display URL (kept file URI or urlFromBytes). Errors of fetchBytes pass
// through unchanged; bytes that fail validate are 'foto inválida'.
// requestedGeneration: the generation read when the photo was requested,
// before the load waited behind the cache's concurrency limit; a purge while
// it was queued must also prevent the keep. Defaults to the value at start.
// keptBytes (optional): the asynchronous read of a store that cannot hand
// out a URI (the web). Its bytes become a URL through urlFromBytes, owned
// and revoked by the caller's in-memory cache like any fetched photo.
export async function loadKept (args) {
  if (args.persist === 'copy') return loadCopy(args)
  const { kind, author, d, persist, keptUrl, keptBytes, keep, fetchBytes, urlFromBytes, generation, requestedGeneration, validate } = args
  const keepable = persist !== false && typeof author === 'string' && HEX64.test(author)
  const storeKind = storeKindOf(kind, persist)
  // A peek copy is read under the same rule as it is written: a blocked
  // author's file never answers, even before its drop reached the store.
  const readable = keepable && (persist !== 'peek' || peekKeepAllowed(author))
  if (readable && !deniedAuthor(author)) {
    const hit = keptUrl(storeKind, author, d)
    if (typeof hit === 'string' && hit !== '') return notePeekUri(persist, storeKind, author, d, hit)
    const held = await readHeld(storeKind, author, d, keptBytes, urlFromBytes, generation, validate)
    if (held !== null) return held
  }
  const g = !keepable ? null : Number.isSafeInteger(requestedGeneration) ? requestedGeneration : generation()
  const pg = peekRetains
  const bytes = await fetchBytes(d)
  if (typeof validate === 'function' && !validate(bytes, d)) throw new Error('foto inválida')
  const current = (persist !== 'peek' || peekRetains === pg || retainedLast(storeKind, author, d)) && (persist === 'peek' ? peekKeepAllowed(author) : allowedAuthor(author))
  if (keepable && generation() === g && current) {
    const uri = keep(storeKind, author, d, bytes)
    if (typeof uri === 'string' && uri !== '') return notePeekUri(persist, storeKind, author, d, uri)
  }
  if (typeof urlFromBytes !== 'function') throw new Error('sem exibição')
  return urlFromBytes(bytes, d.mime)
}

// -> a display URL of the bytes keptBytes holds for the entry, or null.
async function readHeld (kind, author, d, keptBytes, urlFromBytes, generation, validate) {
  if (typeof keptBytes !== 'function' || typeof urlFromBytes !== 'function') return null
  const before = generation()
  let held = null
  try { held = await keptBytes(kind, author, d) } catch {}
  // A purge during the read wins: its bytes are not shown.
  if (generation() === before && held instanceof Uint8Array && held.byteLength === d.bytes && (typeof validate !== 'function' || validate(held, d))) {
    return urlFromBytes(held, d.mime)
  }
  return null
}

// persist 'copy'. The peek retain counters are not consulted: a copy file
// is never retained by a screen (retainKept refuses the copy kinds). The
// main kind is read first, then the copy kind, each through keptUrl and then
// keptBytes (the web's stores).
async function loadCopy ({ kind, author, d, keptUrl, keptBytes, keep, fetchBytes, urlFromBytes, generation, requestedGeneration, validate }) {
  const keepable = typeof author === 'string' && HEX64.test(author)
  if (keepable && !deniedAuthor(author)) {
    const hit = keptUrl(kind, author, d)
    if (typeof hit === 'string' && hit !== '') return hit
    const mainHeld = await readHeld(kind, author, d, keptBytes, urlFromBytes, generation, validate)
    if (mainHeld !== null) return mainHeld
    if (copyReadAllowed(author)) {
      const copyKind = copyKindOf(kind)
      const copyHit = keptUrl(copyKind, author, d)
      if (typeof copyHit === 'string' && copyHit !== '') return copyHit
      const held = await readHeld(copyKind, author, d, keptBytes, urlFromBytes, generation, validate)
      if (held !== null) return held
    }
  }
  const g = !keepable ? null : Number.isSafeInteger(requestedGeneration) ? requestedGeneration : generation()
  const bytes = await fetchBytes(d)
  if (typeof validate === 'function' && !validate(bytes, d)) throw new Error('foto inválida')
  if (keepable && generation() === g) {
    const target = followedAuthor(author) ? kind : peekKeepAllowed(author) ? copyKindOf(kind) : null
    if (target !== null) {
      const uri = keep(target, author, d, bytes)
      if (typeof uri === 'string' && uri !== '') return uri
    }
  }
  if (typeof urlFromBytes !== 'function') throw new Error('sem exibição')
  return urlFromBytes(bytes, d.mime)
}

let registered = false
const memoryCaches = new Set()
// The registered store, for retainKept.
let bound = null
// Bumped by retainKept: only a peek fetch in flight checks it, so a retain of
// the peek kinds never stops another screen's keep or snapshot save.
let peekRetains = 0
// The entry ids the latest retain named: a peek fetch that overlapped it
// still keeps a photo the retain chose to keep.
let lastRetained = null
// Entry id -> the kept peek file URI this process handed out, so a retain can
// drop exactly the memory entries that point at files it deleted.
const peekUris = new Map()
const PEEK_URIS_MAX = 512

function entryId (kind, author, d) {
  if (!d || typeof d !== 'object' || typeof author !== 'string') return null
  return kind + '/' + author + '/' + d.core + ':' + d.start + ':' + d.blocks + ':' + d.sha256
}

function retainedLast (kind, author, d) {
  const id = entryId(kind, author, d)
  return lastRetained !== null && id !== null && lastRetained.has(id)
}

function notePeekUri (persist, kind, author, d, uri) {
  if (persist !== 'peek') return uri
  const id = entryId(kind, author, d)
  if (id === null) return uri
  peekUris.delete(id)
  peekUris.set(id, uri)
  while (peekUris.size > PEEK_URIS_MAX) peekUris.delete(peekUris.keys().next().value)
  return uri
}

function clearMemory () {
  peekUris.clear()
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
// files. A URL the cache evicts (or clears) releases the kept file's in-use
// mark, so the store's trim may delete it again. -> true when this call
// registered the store.
export function registerKeptStore ({ onRevokedRanges, bumpCacheGeneration, registerLocalCache, store, cache }) {
  if (cache && typeof cache.clear === 'function' && !memoryCaches.has(cache)) {
    memoryCaches.add(cache)
    if (typeof cache.onEvicted === 'function' && store && typeof store.releaseKept === 'function') {
      cache.onEvicted((url) => { try { store.releaseKept(url) } catch {} })
    }
  }
  if (registered) return false
  registered = true
  bound = { store, bumpCacheGeneration }
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

// Keeps only the files of `kinds` that `entries` ([{ kind, author, d }])
// names, through the registered store (./keep retainKept). It bumps only
// the peek counter and records the named entries first, so a peek fetch in
// flight keeps its photo only when the retain kept that entry. The global
// cache generation stays, and only the memory entries holding a peek file
// URI the retain deleted are forgotten: anything else would drop every other
// screen's save in flight and refetch every photo on screen.
// Does nothing before registerKeptStore.
export function retainKept (kinds, entries) {
  if (bound === null || typeof bound.store.retainKept !== 'function') return
  if (!Array.isArray(kinds) || !Array.isArray(entries)) return
  // The copy kinds hold photos any reopened screen may draw: no single
  // screen's retain may delete them.
  kinds = kinds.filter((k) => !COPY_KINDS.includes(k))
  if (kinds.length === 0) return
  const named = new Set()
  for (const e of entries) {
    const id = e && typeof e === 'object' ? entryId(e.kind, e.author, e.d) : null
    if (id !== null) named.add(id)
  }
  peekRetains++
  lastRetained = named
  try { bound.store.retainKept(kinds, entries) } catch {}
  for (const [id, uri] of [...peekUris]) {
    if (named.has(id) || !kinds.includes(id.slice(0, id.indexOf('/')))) continue
    peekUris.delete(id)
    for (const cache of memoryCaches) {
      if (typeof cache.forgetUrl !== 'function') continue
      try { cache.forgetUrl(uri) } catch {}
    }
  }
}
