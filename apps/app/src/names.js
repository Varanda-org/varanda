// Per-session profiles cache: author key -> { name, username, bio, avatar }
// (or null: the node has no showable diary for that key), read with
// profile.read (docs/rpc.md 5.21). Feed items seed name and username (a
// non-authoritative seed: it never marks the bio as loaded, so a resolve()
// still asks the node); a seed changes the avatar only when it carries an
// 'avatar' key. avatar is undefined while unknown, null when there is none.
// The entry rules live in ./namesCache.js.
// learnVerified takes node-verified diary.peek answers: for a key whose
// profile.read says `missing` (or an older node, which has no profile.read)
// the peek stays as the entry instead of null; a profile.read answer always
// wins over it. Each answer carries the peekScope it started in, and one of an
// older scope is dropped. forgetVerified drops a kept peek once its diary is
// gone; isPeeked says whether a key shows one.
// Everything stored is raw peer data and the SCREENS render it through
// displayText, as plain text.
//
// profile.read is a member read. The native node's read preempts a running
// sync (docs/rpc.md 6.1) and that node restarts a continuous run after it.
// The browser node serves the read from the live run's cores. Lookups stay
// batched (100 ms debounce, at most PROFILE_LIMIT_MAX keys per request, one
// request in flight, at least 1 s between automatic batches) so bursts from
// several screens coalesce: fewer requests, and fewer native preemptions.
// The own key and the keys a screen asks for (resolve, resolveMany: what is
// on screen) go first. BACKGROUND batches (freshness re-fetches and failure
// retries) wait until the current continuous run has lasted 5 s or entered
// its idle gap (while no failure backoff is pending), so a native restart
// gets time to reach the seeder (#66). The freshness re-ask is the profile.read
// sent with background priority; the debounced resolve of a name on screen
// keeps the default visible lane, so a tap is not queued behind that re-ask.
// Lookups never run while a ONCE run
// is active (a native read would end it for good), while a sync.start is in
// flight or while the provider reconciles an uncertain start.
// A failure (connection lost, timeout, no identity) keeps the keys for a retry
// when the node is ready again, when a once run ends, or on a resolve() 5 s
// later; an older node without profile.read ('método desconhecido') answers
// null for every key, with no further request. The cache belongs to one
// connection epoch and one passkey generation.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { isKey, PROFILE_LIMIT_MAX, USAGE } from '@varanda/rpc'
import { useNode, useSyncSignals } from './node'
import { namesQuiet } from './autoSyncPolicy'
import { absentSeeds, applySeed, authoritative, fieldsOf, forgottenEntry, isPeekedKey, missingEntry, peekReplaces, peekedEntry, stableView } from './namesCache'

// The seeder's page hint rides with the name (only a hint: Membro verifies
// with page.read). profile.read never says it, so it is carried over.
function pageHintFields (f, known) {
  if (typeof f.page === 'boolean') {
    const page = f.page
    return { page, closed: page && f.closed === true, moved: page && f.moved === true }
  }
  return known && known.page === true ? { page: true, closed: known.closed === true, moved: known.moved === true } : null
}

const DEBOUNCE_MS = 100
const MIN_GAP_MS = 1000
const FRESH_DEBOUNCE_MS = 2000
const RETRY_AFTER_MS = 5000
const QUIET_MS = 5000
const MAX_REASK_KEYS = 500

const NamesContext = createContext(null)

export function useNames () {
  return useContext(NamesContext)
}

export function NamesProvider ({ children }) {
  const node = useNode()
  const { phase, sync, request, epoch } = node
  const promoteRef = useRef(node.promote)
  promoteRef.current = node.promote
  // Every fresh key, not only the own one useNode().signals keeps.
  const signals = useSyncSignals()
  const autoSync = node.autoSync || { wanted: false, reconciling: false }
  const generation = node.passkey ? node.passkey.generation : 0
  // The scope a diary.peek starts in. learnVerified drops one from an older
  // epoch or generation, even after the screen that asked has closed.
  const peekScope = epoch + ':' + generation
  const peekScopeRef = useRef(peekScope)
  peekScopeRef.current = peekScope
  const ownKey = node.passkey && node.passkey.status && typeof node.passkey.status.publicKey === 'string'
    ? node.passkey.status.publicKey.toLowerCase()
    : null

  // lowercase key -> null | { name, username, bio, avatar, loaded }
  const [cache, setCache] = useState(() => new Map())
  const cacheRef = useRef(cache)
  const [unsupported, setUnsupported] = useState(false)
  const unsupportedRef = useRef(false)
  // Queued keys, in insertion order: on-screen first, background after.
  const frontRef = useRef(new Set())
  const backRef = useRef(new Set())
  // Keys whose re-ask is a freshness pass. A failure retry has no entry, so
  // its batch stays on the visible lane, as it did before.
  const backLaneRef = useRef(new Map())
  // The token of the background batch in progress, or null.
  const backTokenRef = useRef(null)
  // Oldest to newest screen ask, including loaded and in-flight keys.
  const recentRef = useRef(new Set())
  // key -> time of the failed lookup.
  const retryRef = useRef(new Map())
  const busyRef = useRef(false)
  const lastBatchRef = useRef(0)
  const timerRef = useRef(null)
  const freshTimerRef = useRef(null)
  const freshPendingRef = useRef(new Set())
  const freshSeenRef = useRef(new Map())
  const mountedRef = useRef(true)
  // lowercase key -> peekedEntry of a verified diary.peek, kept for `missing`.
  const peekedRef = useRef(new Map())
  // Keys whose last profile.read answer in this scope was a profile.
  const heldRef = useRef(new Set())
  // Bumped with the epoch/generation: a response of an older scope is dropped.
  const scopeRef = useRef(0)
  const ownKeyRef = useRef(ownKey)
  ownKeyRef.current = ownKey

  const gate = phase === 'ready' &&
    !(sync.active && sync.active.once) &&
    !sync.starting &&
    !autoSync.reconciling
  const gateRef = useRef(gate)
  gateRef.current = gate
  const continuous = signals && signals.runId !== null && signals.once === false ? signals.startedAt : null
  const quietRef = useRef({ wanted: false, startedAt: null })
  quietRef.current = { wanted: autoSync.wanted === true, startedAt: continuous, idleSince: autoSync.idleSince, failureUntil: autoSync.failureUntil || 0 }

  const commit = useCallback((next) => {
    cacheRef.current = next
    setCache(next)
  }, [])

  // Merges seeds (namesCache.applySeed).
  const apply = useCallback((entries) => {
    const next = new Map(cacheRef.current)
    let changed = false
    for (const [rawKey, value] of entries) {
      if (typeof rawKey !== 'string' || !isKey(rawKey)) continue
      const key = rawKey.toLowerCase()
      const known = next.get(key) || null
      let merged = applySeed(known, value)
      const hint = pageHintFields(fieldsOf(value), known)
      const had = known && known.page === true
      const same = merged === null && known !== null && (hint === null ? !had : had ? hint.page && hint.closed === known.closed && hint.moved === known.moved : !hint.page)
      if (merged === null && !(known !== null && !same)) continue
      if (merged === null) merged = { ...known }
      if (hint !== null) Object.assign(merged, hint)
      next.set(key, merged)
      changed = true
    }
    if (changed) commit(next)
  }, [commit])

  const learn = useCallback((key, fields) => apply([[key, fields]]), [apply])
  const learnMany = useCallback((entries) => apply(entries), [apply])
  // Seeds for keys not in the cache yet only (namesCache.absentSeeds).
  const seedMany = useCallback((entries) => apply(absentSeeds(cacheRef.current, entries)), [apply])

  // Node-verified diary.peek answers ([key, value] pairs). They fill a key the
  // node has no profile for (`missing`, or an older node) or that only a seed
  // named, keeping its page hints, never one a pending or answered
  // profile.read owns; one that lands before the answer waits in
  // peekedRef for it. heldRef: the last answer was a profile, so a later peek
  // (two can be in flight) must not bring the key back. The caller passes the
  // peekScope it started in; an answer of an older scope is dropped.
  const learnVerified = useCallback((entries, scope) => {
    if (scope !== peekScopeRef.current) return
    const next = new Map(cacheRef.current)
    let changed = false
    for (const [rawKey, value] of Array.isArray(entries) ? entries : []) {
      if (typeof rawKey !== 'string' || !isKey(rawKey)) continue
      const key = rawKey.toLowerCase()
      const entry = peekedEntry(value)
      if (entry === null || heldRef.current.has(key)) continue
      const peeked = peekedRef.current
      const had = peeked.has(key)
      peeked.delete(key)
      peeked.set(key, entry)
      while (peeked.size > MAX_REASK_KEYS) {
        const evicted = peeked.keys().next().value
        peeked.delete(evicted)
        // Nothing would re-check an evicted peek, so its name must not stay.
        if (heldRef.current.has(evicted)) continue
        const old = next.get(evicted)
        const forgotten = forgottenEntry(old, pageHintFields({}, old))
        if (forgotten === undefined) continue
        next.set(evicted, forgotten)
        changed = true
      }
      const known = next.get(key)
      if (peekReplaces(known, had, unsupportedRef.current)) {
        const hint = pageHintFields({}, known)
        next.set(key, hint === null ? { ...entry } : { ...entry, ...hint })
        changed = true
      }
    }
    if (changed) commit(next)
  }, [commit])

  // A function, not state: the caller re-checks a shown peek on each open.
  const isPeeked = useCallback((key) => isPeekedKey(peekedRef.current, heldRef.current, key), [])

  // The diary of a peeked key is gone (blocked, @nome revoked): drop the kept
  // peek so `missing` no longer restores it, and show the key unnamed. Same
  // scope rule as learnVerified; a key profile.read holds is never touched.
  const forgetVerified = useCallback((keys, scope) => {
    if (scope !== peekScopeRef.current) return
    const next = new Map(cacheRef.current)
    let changed = false
    for (const rawKey of Array.isArray(keys) ? keys : []) {
      if (typeof rawKey !== 'string' || !isKey(rawKey)) continue
      const key = rawKey.toLowerCase()
      peekedRef.current.delete(key)
      if (heldRef.current.has(key)) continue
      const known = next.get(key)
      const entry = forgottenEntry(known, pageHintFields({}, known))
      if (entry === undefined) continue
      next.set(key, entry)
      changed = true
    }
    if (changed) commit(next)
  }, [commit])

  const quietOk = (now) => namesQuiet({ ...quietRef.current, now, quietMs: QUIET_MS })

  // Ref-held so the timers always run the current flush.
  const flushRef = useRef(() => {})

  const schedule = useCallback((ms = DEBOUNCE_MS) => {
    if (!mountedRef.current || timerRef.current !== null) return
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      flushRef.current()
    }, ms)
  }, [])

  flushRef.current = async () => {
    if (busyRef.current || !gateRef.current || unsupportedRef.current) return
    const front = frontRef.current
    const back = backRef.current
    if (front.size === 0 && back.size === 0) return
    const now = Date.now()
    const wait = lastBatchRef.current + MIN_GAP_MS - now
    if (wait > 0) { schedule(wait); return }
    const quiet = quietOk(now)
    const order = []
    const own = ownKeyRef.current
    if (own !== null && (front.has(own) || (quiet && back.has(own)))) order.push(own)
    for (const key of front) if (key !== own) order.push(key)
    if (quiet) for (const key of back) if (key !== own && !front.has(key)) order.push(key)
    if (order.length === 0) {
      // Only background keys, and the run is not quiet yet: wait for it.
      const startedAt = quietRef.current.startedAt
      if (startedAt !== null) schedule(Math.max(DEBOUNCE_MS, startedAt + QUIET_MS - now))
      return
    }
    const authors = order.slice(0, PROFILE_LIMIT_MAX)
    // On-screen keys (front) and failure retries stay visible. Only a batch
    // that is entirely a freshness re-ask yields the lane.
    const freshOnly = authors.length > 0 && authors.every((key) => {
      return !front.has(key) && backLaneRef.current.get(key) === 'background'
    })
    // A background batch carries a token: a name asked for the screen while
    // it still waits in the queue promotes it (only one batch runs at once).
    const lane = freshOnly ? { priority: 'background', token: Symbol('names-fresh') } : undefined
    backTokenRef.current = lane ? lane.token : null
    for (const key of authors) {
      front.delete(key)
      back.delete(key)
      backLaneRef.current.delete(key)
    }
    busyRef.current = true
    lastBatchRef.current = now
    const scope = scopeRef.current
    try {
      const res = await request('profile.read', { authors }, lane)
      if (scope !== scopeRef.current) return
      const next = new Map(cacheRef.current)
      for (const p of (res && res.profiles) || []) {
        if (!p || typeof p.author !== 'string') continue
        const key = p.author.toLowerCase()
        // Authoritative: a null removes what a seed said (username included).
        const old = next.get(key)
        const entry = authoritative(p)
        if (old && old.page === true) Object.assign(entry, { page: true, closed: old.closed === true, moved: old.moved === true })
        next.set(key, entry)
        peekedRef.current.delete(key)
        heldRef.current.add(key)
        retryRef.current.delete(key)
      }
      for (const rawKey of (res && res.missing) || []) {
        if (typeof rawKey !== 'string') continue
        const key = rawKey.toLowerCase()
        heldRef.current.delete(key)
        next.set(key, missingEntry(peekedRef.current.get(key)))
        retryRef.current.delete(key)
      }
      commit(next)
    } catch (err) {
      if (scope !== scopeRef.current) return
      if (err && err.code === USAGE && err.message === 'método desconhecido') {
        // An older node: no profiles, ever, for this scope.
        unsupportedRef.current = true
        setUnsupported(true)
        frontRef.current.clear()
        backRef.current.clear()
        backLaneRef.current.clear()
        retryRef.current.clear()
        return
      }
      // CLOSED / TIMEOUT / NOT_FOUND (and anything unexpected): kept for a
      // later retry, never re-sent in a loop.
      const at = Date.now()
      for (const key of authors) retryRef.current.set(key, at)
    } finally {
      busyRef.current = false
      backTokenRef.current = null
      if (mountedRef.current && (frontRef.current.size > 0 || backRef.current.size > 0)) schedule(MIN_GAP_MS)
    }
  }

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (timerRef.current !== null) clearTimeout(timerRef.current)
      if (freshTimerRef.current !== null) clearTimeout(freshTimerRef.current)
      timerRef.current = null
      freshTimerRef.current = null
    }
  }, [])

  // A new epoch or generation clears values, then re-asks cached/on-screen
  // keys in front, retaining up to 500 with the most recent asks preferred.
  // Stable resolve callbacks do not make mounted screens ask again.
  useEffect(() => {
    const keys = new Set([...cacheRef.current.keys(), ...frontRef.current])
    for (const key of recentRef.current) { keys.delete(key); keys.add(key) }
    // The own key is always kept (the composer and Diário name it).
    const own = typeof ownKeyRef.current === 'string' ? ownKeyRef.current.toLowerCase() : null
    if (own !== null && isKey(own)) { keys.delete(own); keys.add(own) }
    const retained = [...keys].slice(-MAX_REASK_KEYS)
    scopeRef.current += 1
    cacheRef.current = new Map()
    setCache(cacheRef.current)
    unsupportedRef.current = false
    setUnsupported(false)
    frontRef.current = new Set(retained)
    recentRef.current = new Set(retained)
    backRef.current.clear()
    backLaneRef.current.clear()
    retryRef.current.clear()
    peekedRef.current.clear()
    heldRef.current.clear()
    freshPendingRef.current.clear()
    freshSeenRef.current.clear()
    if (freshTimerRef.current !== null) clearTimeout(freshTimerRef.current)
    freshTimerRef.current = null
    if (retained.length > 0) schedule()
  }, [epoch, generation, schedule])

  // On-screen keys: queued first, unless loaded (and not stale).
  const askFront = useCallback((keys) => {
    const now = Date.now()
    let queued = false
    for (const raw of keys) {
      if (typeof raw !== 'string' || !isKey(raw)) continue
      const key = raw.toLowerCase()
      const recent = recentRef.current
      recent.delete(key)
      recent.add(key)
      if (recent.size > MAX_REASK_KEYS) recent.delete(recent.values().next().value)
      if (unsupportedRef.current) continue
      const known = cacheRef.current.get(key)
      if (known === null || (known && known.loaded)) continue
      const failedAt = retryRef.current.get(key)
      if (failedAt !== undefined) {
        if (now - failedAt < RETRY_AFTER_MS) continue
        retryRef.current.delete(key)
      }
      if (frontRef.current.has(key)) continue
      backRef.current.delete(key)
      backLaneRef.current.delete(key)
      frontRef.current.add(key)
      queued = true
    }
    if (queued && backTokenRef.current !== null && typeof promoteRef.current === 'function') promoteRef.current(backTokenRef.current)
    if (queued) schedule()
  }, [schedule])

  const resolve = useCallback((key) => askFront([key]), [askFront])
  const resolveMany = useCallback((keys) => askFront(Array.isArray(keys) ? keys : []), [askFront])

  // `priority` is set only by the freshness re-ask. Other callers pass none,
  // so a failure retry is still sent on the visible lane.
  const queueBack = useCallback((keys, priority) => {
    let queued = false
    for (const key of keys) {
      if (frontRef.current.has(key) || backRef.current.has(key)) continue
      backRef.current.add(key)
      if (priority === 'background') backLaneRef.current.set(key, priority)
      queued = true
    }
    if (queued) schedule()
  }, [schedule])

  // Marks entries as not loaded (their values stay as a seed) and asks again.
  const invalidate = useCallback((keys) => {
    const list = (Array.isArray(keys) ? keys : [keys]).filter((k) => typeof k === 'string' && isKey(k)).map((k) => k.toLowerCase())
    const next = new Map(cacheRef.current)
    let changed = false
    for (const key of list) {
      const known = next.get(key)
      if (known === undefined) continue
      next.set(key, known === null ? { name: null, username: null, bio: null, avatar: undefined, loaded: false } : { ...known, loaded: false })
      changed = true
    }
    if (changed) commit(next)
    for (const key of list) retryRef.current.delete(key)
    askFront(list)
  }, [commit, askFront])

  const requeueRetries = useCallback(() => {
    const keys = [...retryRef.current.keys()]
    retryRef.current.clear()
    queueBack(keys)
  }, [queueBack])

  // The gate opened (or the quiet window may have): try a batch.
  const quietNow = continuous === null ? !autoSync.wanted : null
  useEffect(() => {
    if (gate) schedule()
  }, [gate, quietNow, continuous, autoSync.idleSince, autoSync.failureUntil, schedule])

  // The node became ready again: the failed keys are retried once.
  const prevPhaseRef = useRef(phase)
  useEffect(() => {
    const prev = prevPhaseRef.current
    prevPhaseRef.current = phase
    if (phase === 'ready' && prev !== 'ready' && retryRef.current.size > 0) requeueRetries()
  }, [phase, requeueRetries])

  // A once run ended: the failed keys are retried once.
  const onceRunRef = useRef(null)
  if (sync.active && sync.active.once) onceRunRef.current = sync.active.runId
  const stopped = sync.stopped
  useEffect(() => {
    if (!stopped || onceRunRef.current === null || stopped.runId !== onceRunRef.current) return
    onceRunRef.current = null
    if (retryRef.current.size > 0) requeueRetries()
  }, [stopped, requeueRetries])

  // Freshness: a diary that grew may carry a new profile. Cached keys are
  // marked stale and re-fetched (in the background) after 2 s of quiet.
  const fresh = signals ? signals.fresh : null
  useEffect(() => {
    if (!fresh) return
    let added = false
    for (const [key, n] of Object.entries(fresh)) {
      if (key === 'own' || freshSeenRef.current.get(key) === n) continue
      freshSeenRef.current.set(key, n)
      if (!cacheRef.current.has(key)) continue
      freshPendingRef.current.add(key)
      added = true
    }
    if (!added || unsupportedRef.current) return
    if (freshTimerRef.current !== null) clearTimeout(freshTimerRef.current)
    freshTimerRef.current = setTimeout(() => {
      freshTimerRef.current = null
      const keys = [...freshPendingRef.current]
      freshPendingRef.current.clear()
      const next = new Map(cacheRef.current)
      for (const key of keys) {
        const known = next.get(key)
        if (known) next.set(key, { ...known, loaded: false })
      }
      commit(next)
      queueBack(keys, 'background')
    }, FRESH_DEBOUNCE_MS)
  }, [fresh, commit, queueBack])

  // The views handed out, per key: the same object while the entry says the
  // same thing, so memoized rows skip a re-render when another key changed.
  const viewsRef = useRef(new Map())
  const profileOf = useCallback((key) => {
    if (typeof key !== 'string') return undefined
    const k = key.toLowerCase()
    const entry = cache.get(k)
    if (entry === undefined) return unsupported ? null : undefined
    if (entry === null) return null
    const prev = viewsRef.current.get(k)
    const view = stableView(entry, prev)
    if (view !== prev) viewsRef.current.set(k, view)
    return view
  }, [cache, unsupported])

  // Compat: string | null (looked up, no name) | undefined (unknown).
  const nameOf = useCallback((key) => {
    const p = profileOf(key)
    if (p === undefined) return undefined
    return p === null ? null : p.name
  }, [profileOf])

  const value = useMemo(() => ({ profileOf, nameOf, learn, learnMany, learnVerified, isPeeked, forgetVerified, seedMany, resolve, resolveMany, invalidate, unsupported, peekScope }), [profileOf, nameOf, learn, learnMany, learnVerified, isPeeked, forgetVerified, seedMany, resolve, resolveMany, invalidate, unsupported, peekScope])

  return <NamesContext.Provider value={value}>{children}</NamesContext.Provider>
}
