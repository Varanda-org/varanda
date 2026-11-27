// The member's own block list in the app (docs/rpc.md 5.111 and 5.112). The node
// holds it and filters every read; this keeps a copy so screens can clear rows
// at once and offer Desbloquear. Hosted nodes only: the core node has no list.
//
// `changed` counts the changes made here or brought by another device of the
// passkey (`refresh`, after a seen pass), so the shell reloads A Rua once per
// change. The confirmation is a separate context: opening it must not redraw
// every post row.
//
// The last lists read live are stored on the device (kinds 'bloqueios' and
// 'silenciados', ./quietLists.js) and used at once on a reopen, before
// block.list answers, so stored rows of other people paint offline too.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { perfMarks, useNode } from './node'
import { diaryPeekSlots } from './engagement'
import { fetchMember } from './indexClient'
import { blockedPeekParams, blockedSetOf } from './memberBlocks'
import { openPushLists, reportBlocks } from './pushBlocks'
import { cacheGeneration, denyAuthors, dropAuthors, newlyBlocked, noteBlocksKnown, noteBlocksSeeded, registerLocalCache, wipeEpoch } from './localCaches'
import { bootLists, clearBootLists, mayStoreQuietLists, subscribeQuietLists } from './quietLists'
import { buildScreenSnapshot } from './screenSnapshot'
import { loadScreenSnapshot, saveScreenSnapshot } from './screenSnapshotStore'

const EMPTY = new Set()
const noop = () => {}
const MEMBER = Object.freeze({ kind: 'me' })

// Whether `keys` is the node's list for the current epoch: 'pending' until
// block.list answers, 'ok' once it did, 'failed' when it was refused. Screens
// that show rows stored before this run (A Rua's snapshot) fail closed on
// 'failed': an empty set then means unknown, not nothing blocked.
// event: 'epoch' (new node epoch or passkey generation), 'loaded', 'failed'.
// A refusal after a good read of the same epoch keeps 'ok': that list stands.
export function nextLoadState (state, event) {
  if (event === 'epoch') return 'pending'
  if (event === 'loaded') return 'ok'
  if (event === 'failed') return state === 'ok' ? 'ok' : 'failed'
  return state
}

// Whether a block.list answer may still be used: it is the latest reload
// asked (`mine` === `latest`) and of the epoch now in force. An older one,
// answered late, would undo a newer list.
export function isLatestReload (mine, latest, epochAt, epochNow) {
  return mine === latest && epochAt === epochNow
}

// Whether a list answer must be read again instead of committed: a set that
// settled while the read was in flight (the write count moved from `writesAt`
// to `writesNow`) may be missing from it, and committing it would undo that
// set. Only the read is repeated, never the set.
export function rereadsAfterWrites (writesAt, writesNow) {
  return writesAt !== writesNow
}

// The account the web worker's lists may belong to: an open, signed-in
// session's key, else null (pushBlocks.web.js keeps the reports back then).
export function pushSessionKey (status) {
  if (status === null || typeof status !== 'object') return null
  if (status.unlocked !== true || status.signedOut === true || typeof status.publicKey !== 'string') return null
  return status.publicKey.toLowerCase()
}

// The load state screens see. An adopted stored list counts as known while
// the live read is pending, so an offline reopen paints; a refused read
// still fails closed, as before.
export function shownLoadState (live, seeded) {
  if (live === 'ok' || live === 'failed') return live
  return seeded === true ? 'ok' : live
}

// Whether a stored pair of lists may be used: both lists present, read
// since the last wipe and, once the identity is known, saved for it.
export function usableSeed (seed, binding, wipe) {
  if (seed === null || typeof seed !== 'object') return false
  if (!(seed.blocks instanceof Set) || !(seed.mutes instanceof Set)) return false
  if (seed.wipe !== wipe) return false
  if (binding === null || binding === undefined) return true
  return seed.owner === binding.owner && seed.origin === binding.origin && seed.association === binding.association
}

// bindingOf: App.js's liveBinding, or absent (nothing is read or stored).
export function quietBinding (bindingOf, sessionKey, config) {
  if (typeof bindingOf !== 'function' || sessionKey === null) return null
  const b = bindingOf(sessionKey, config)
  return b === null || typeof b !== 'object' ? null : b
}

const bindingKeyOf = (b) => (b === null ? '' : b.origin + '|' + b.association + '|' + b.owner)

// Both stored lists of `binding`, or null when either is missing.
function storedSeed (binding) {
  if (binding === null) return null
  const wipe = wipeEpoch()
  const member = { ...binding, acting: MEMBER }
  const blocks = loadScreenSnapshot('bloqueios', member)
  const mutes = loadScreenSnapshot('silenciados', member)
  if (blocks === null || mutes === null) return null
  return { owner: binding.owner, origin: binding.origin, association: binding.association, blocks: new Set(blocks.body.keys), mutes: new Set(mutes.body.keys), wipe }
}

// Stores a list read live. The caller passes only lists a whole live read
// started; a stored list is never saved back.
export function saveQuietList (kind, binding, keys) {
  if (!mayStoreQuietLists() || binding === null) return false
  const gen = cacheGeneration()
  const snapshot = buildScreenSnapshot(kind, { ...binding, acting: MEMBER, keys: [...keys] })
  return snapshot !== null && saveScreenSnapshot(kind, snapshot, gen)
}

// -> { binding, bindingKey, seed, forget, mayStore }: the stored lists to
// start from (the boot hand-off first, then this binding's copies, read once
// per binding), or null. forget() reads the copies again on the next render.
export function useQuietSeed (bindingOf, status, config) {
  const binding = quietBinding(bindingOf, pushSessionKey(status), config)
  const bindingKey = bindingKeyOf(binding)
  const boot = useSyncExternalStore(subscribeQuietLists, bootLists)
  const mayStore = useSyncExternalStore(subscribeQuietLists, mayStoreQuietLists)
  const readStored = () => ({ key: bindingKey, seed: storedSeed(binding) })
  const [stored, setStored] = useState(readStored)
  if (stored.key !== bindingKey) setStored(readStored())
  const forget = useCallback(() => setStored({ key: null, seed: null }), [])
  const wipe = wipeEpoch()
  let seed = null
  if (usableSeed(boot, binding, wipe)) seed = boot
  else if (binding !== null && stored.key === bindingKey && usableSeed(stored.seed, binding, wipe)) seed = stored.seed
  return { binding, bindingKey, seed, forget, mayStore }
}

const FALLBACK = {
  available: false,
  keys: EMPTY,
  loadState: 'pending',
  changed: 0,
  live: false,
  seeded: false,
  has: () => false,
  ask: noop,
  setBlock: async () => { throw new Error('bloqueio indisponível') },
  refresh: async () => {}
}

const BlocksContext = createContext(FALLBACK)
const AskContext = createContext({ asking: null, close: noop })

export function useBlocks () {
  return useContext(BlocksContext)
}

export function useBlockAsk () {
  return useContext(AskContext)
}

export function BlocksProvider ({ children, bindingOf }) {
  const node = useNode()
  const available = node.hosted === true
  const generation = node.passkey ? node.passkey.generation : 0
  const ready = available && node.phase === 'ready'
  const requestRef = useRef(node.request)
  requestRef.current = node.request
  const [keys, setKeys] = useState(EMPTY)
  // The live state: what block.list said in this epoch (nextLoadState).
  const [liveLoad, setLoadState] = useState('pending')
  // Counts the epochs: an answer from an older one never sets the state.
  const epochRef = useRef(0)
  // Counts the reloads: only the latest one asked commits or sets the state.
  const reloadSeqRef = useRef(0)
  // Counts the settled sets: a list read they overlapped is read again.
  const writesRef = useRef(0)
  const markedRef = useRef(false)
  const [changed, setChanged] = useState(0)
  const [asking, setAsking] = useState(null)

  const keysRef = useRef(EMPTY)
  // A wipe forgets the denied authors with the caches: the next list read
  // then counts every block as new and denies them again, owner unchanged.
  useEffect(() => registerLocalCache({ wipe: () => { keysRef.current = EMPTY } }), [])
  // Whether a whole list read was committed since the last wipe: only such a
  // list may go to the web worker again when an account opens.
  const listedRef = useRef(false)
  useEffect(() => registerLocalCache({ wipe: () => { listedRef.current = false } }), [])
  // Whether the keys rest on a block.list answer that was a key array: a
  // malformed one reads as no blocks for the screens, but stored it would
  // paint other people's rows on the next offline reopen.
  const trustedRef = useRef(false)
  useEffect(() => registerLocalCache({ wipe: () => { trustedRef.current = false } }), [])
  const sessionKey = pushSessionKey(node.passkey ? node.passkey.status : null)

  const { binding, bindingKey, seed, forget, mayStore } = useQuietSeed(bindingOf, node.passkey ? node.passkey.status : null, node.config)
  const bindingRef = useRef(binding)
  bindingRef.current = binding
  // The seed adopted, and the wipe epoch of the last live commit: a stored
  // list never replaces what a live answer or a set brought.
  const adoptedRef = useRef(null)
  const liveWipeRef = useRef(-1)
  const [seeded, setSeeded] = useState(false)
  // During render, so the first frame already hides the blocked. A second
  // render of the same seed changes nothing. Its authors were dropped in the
  // run that stored it: denied again here, with no purge and no report.
  if (seed !== null && adoptedRef.current !== seed && liveWipeRef.current !== wipeEpoch()) {
    adoptedRef.current = seed
    denyAuthors(seed.blocks)
    noteBlocksSeeded(wipeEpoch())
    keysRef.current = seed.blocks
    setKeys(seed.blocks)
    setSeeded(true)
  }
  useEffect(() => registerLocalCache({
    wipe: () => {
      adoptedRef.current = null
      setSeeded(false)
      forget()
      clearBootLists()
    }
  }), [forget])

  const commit = useCallback((next) => {
    // Kept copies of a newly blocked author go before any screen can show
    // them again, whether the block was made here, on another device of the
    // passkey (reload) or is the first list read at launch.
    const added = newlyBlocked(keysRef.current, next)
    if (added.length > 0) dropAuthors(added)
    keysRef.current = next
    liveWipeRef.current = wipeEpoch()
    setKeys(next)
  }, [])

  // Only a whole list read marks the epoch 'ok': setBlock's commit adds one
  // key to what is known, which is not the list after a failed read.
  const reload = useCallback(async (alive = () => true) => {
    const epoch = epochRef.current
    const seq = ++reloadSeqRef.current
    const current = () => alive() && isLatestReload(seq, reloadSeqRef.current, epoch, epochRef.current)
    // A wipe while the list is in flight (sign-out, owner change) makes the
    // answer stale: committing it would leave the old identity's blocks as
    // already known, so the next list would not deny them again.
    const wiped = wipeEpoch()
    const writes = writesRef.current
    let answer
    try {
      // The control lane: stored rows of other people wait for this answer,
      // so it must not queue behind the screens' reads.
      answer = await requestRef.current('block.list', {}, { priority: 'control' })
    } catch (err) {
      if (current()) setLoadState((s) => nextLoadState(s, 'failed'))
      throw err
    }
    if (current() && rereadsAfterWrites(writes, writesRef.current)) return reload(alive)
    if (!current()) return
    // Read again (a read, never a write) so the load state does not wait for
    // the next epoch; each further pass needs another wipe.
    if (wipeEpoch() !== wiped) return reload(alive)
    commit(blockedSetOf(answer))
    // A malformed answer reads as no blocks for the screens, but is not a
    // list the peek kinds may trust.
    if (answer && Array.isArray(answer.keys)) noteBlocksKnown(wiped)
    // Nor the web worker: as "nobody blocked" it would show their pushes, so
    // the worker keeps the last whole list it got.
    const listed = Boolean(answer && Array.isArray(answer.keys))
    if (listed) reportBlocks([...keysRef.current])
    setLoadState((s) => nextLoadState(s, 'loaded'))
    listedRef.current = listed
    trustedRef.current = listed
    if (listed) saveQuietList('bloqueios', bindingRef.current, keysRef.current)
    if (!markedRef.current) {
      markedRef.current = true
      perfMarks().mark('blocks-ok')
    }
  }, [commit])

  // A failed read keeps what is known: the node filters either way. The
  // load state says it failed, so stored rows fail closed.
  useEffect(() => {
    epochRef.current++
    setLoadState((s) => nextLoadState(s, 'epoch'))
    if (!ready) return
    let live = true
    reload(() => live).catch(noop)
    return () => { live = false }
  }, [ready, node.epoch, generation, reload])

  // block.list also answers with no account open, so the lists go to the
  // worker only once one is; a list read before that is sent now.
  useEffect(() => {
    if (sessionKey === null) return
    openPushLists()
    if (listedRef.current) reportBlocks([...keysRef.current])
  }, [sessionKey, node.epoch])

  // A list read before storing was allowed, or before the identity was
  // known, is stored once it is.
  useEffect(() => {
    if (mayStore && listedRef.current && trustedRef.current) saveQuietList('bloqueios', bindingRef.current, keysRef.current)
  }, [mayStore, bindingKey])

  const setBlock = useCallback(async (key, on) => {
    try {
      const r = await requestRef.current('block.set', { key, on })
      writesRef.current++
      const next = new Set(keysRef.current)
      if (on) next.add(key)
      else next.delete(key)
      commit(next)
      // One key over a list never read whole this run would replace the
      // worker's whole list; the next whole read reports it with this key.
      if (listedRef.current) reportBlocks([...next])
      if (listedRef.current && trustedRef.current) saveQuietList('bloqueios', bindingRef.current, next)
      setChanged((n) => n + 1)
      return r
    } catch (err) {
      // Not resent. The outcome is unknown, so what the node holds decides.
      if (err && err.uncertain === true) reload().catch(noop)
      throw err
    }
  }, [commit, reload])

  const refresh = useCallback(async () => {
    await reload()
    setChanged((n) => n + 1)
  }, [reload])

  const loadState = shownLoadState(liveLoad, seeded)
  const live = liveLoad === 'ok'
  const value = useMemo(() => ({
    available,
    keys,
    loadState,
    changed,
    live,
    seeded,
    has: (key) => typeof key === 'string' && keys.has(key),
    ask: setAsking,
    setBlock,
    refresh
  }), [available, keys, loadState, changed, live, seeded, setBlock, refresh])
  const askValue = useMemo(() => ({ asking, close: () => setAsking(null) }), [asking])

  return (
    <BlocksContext.Provider value={value}>
      <AskContext.Provider value={askValue}>
        {children}
      </AskContext.Provider>
    </BlocksContext.Provider>
  )
}

// The name and @nome of a blocked key, or null. The only read a blocked author
// still answers, and it brings no posts.
export async function readBlockedPeek (request, key) {
  const member = await fetchMember(key)
  if (!member.ok) return null
  const params = blockedPeekParams(key, member.value)
  if (params === null) return null
  return diaryPeekSlots.run(() => request('diary.peek', params), { front: true })
}
