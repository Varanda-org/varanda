// The member's own mute list in the app (docs/rpc.md 5.178 and 5.179). The node
// holds it and leaves muted people out of feed.read, moments.read and
// notices.list; this keeps a copy so A Rua and Avisos clear rows at once and
// the menus offer Deixar de silenciar. Hosted nodes only: the core node has no
// list.
//
// `changed` counts the changes made here or brought by another device of the
// passkey (`refresh`, after a seen pass), so the shell reloads A Rua once per
// change. Each list also goes to the web service worker, which keeps a muted
// person's pushes quiet as it does a blocked one's (pushBlocks.web.js).
// The last list read live is stored and used at once on a reopen, as the
// block list is (blocksProvider.js).

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useNode } from './node'
import { mutedSetOf } from './memberMutes'
import { isLatestReload, rereadsAfterWrites, saveQuietList, useQuietSeed } from './blocksProvider'
import { openPushLists, reportMutes } from './pushBlocks'
import { registerLocalCache, wipeEpoch } from './localCaches'

const EMPTY = new Set()
const noop = () => {}

// As pushSessionKey in blocksProvider.js: an open, signed-in session's key.
function sessionKeyOf (status) {
  if (status === null || typeof status !== 'object') return null
  if (status.unlocked !== true || status.signedOut === true || typeof status.publicKey !== 'string') return null
  return status.publicKey.toLowerCase()
}

const FALLBACK = {
  available: false,
  keys: EMPTY,
  changed: 0,
  has: () => false,
  setMute: async () => { throw new Error('silenciar indisponível') },
  refresh: async () => {}
}

const MutesContext = createContext(FALLBACK)

export function useMutes () {
  return useContext(MutesContext)
}

export function MutesProvider ({ children, bindingOf }) {
  const node = useNode()
  const available = node.hosted === true
  const generation = node.passkey ? node.passkey.generation : 0
  const ready = available && node.phase === 'ready'
  const requestRef = useRef(node.request)
  requestRef.current = node.request
  const [keys, setKeys] = useState(EMPTY)
  const keysRef = useRef(EMPTY)
  const epochRef = useRef(0)
  const reloadSeqRef = useRef(0)
  // Counts the settled sets: a list read they overlapped is read again.
  const writesRef = useRef(0)
  const [changed, setChanged] = useState(0)
  // Whether a list read was committed since the last wipe: only such a list
  // may go to the web worker again when an account opens.
  const listedRef = useRef(false)
  useEffect(() => registerLocalCache({ wipe: () => { listedRef.current = false } }), [])
  // As in BlocksProvider: only a list from a key array is stored.
  const trustedRef = useRef(false)
  useEffect(() => registerLocalCache({ wipe: () => { trustedRef.current = false } }), [])
  const sessionKey = sessionKeyOf(node.passkey ? node.passkey.status : null)

  const { binding, bindingKey, seed, forget, mayStore } = useQuietSeed(bindingOf, node.passkey ? node.passkey.status : null, node.config)
  const bindingRef = useRef(binding)
  bindingRef.current = binding
  // As in BlocksProvider: a stored list never replaces what a live answer
  // or a set brought, and adopting it reports nothing.
  const adoptedRef = useRef(null)
  const liveWipeRef = useRef(-1)
  if (seed !== null && adoptedRef.current !== seed && liveWipeRef.current !== wipeEpoch()) {
    adoptedRef.current = seed
    keysRef.current = seed.mutes
    setKeys(seed.mutes)
  }
  useEffect(() => registerLocalCache({
    wipe: () => {
      adoptedRef.current = null
      forget()
    }
  }), [forget])

  const commit = useCallback((next) => {
    keysRef.current = next
    liveWipeRef.current = wipeEpoch()
    setKeys(next)
  }, [])

  const reload = useCallback(async (alive = () => true) => {
    const epoch = epochRef.current
    const seq = ++reloadSeqRef.current
    const writes = writesRef.current
    const wiped = wipeEpoch()
    // The control lane, as block.list: until it answers, a muted person's
    // stored rows are not cleared, so it must not queue behind screen reads.
    const answer = await requestRef.current('mute.list', {}, { priority: 'control' })
    if (!alive() || !isLatestReload(seq, reloadSeqRef.current, epoch, epochRef.current)) return
    if (rereadsAfterWrites(writes, writesRef.current)) return reload(alive)
    // An answer asked before a wipe may be the previous account's list:
    // committed, it would also stop the new identity's stored list from
    // being adopted. Read again (a read, never a write), as block.list does.
    if (wipeEpoch() !== wiped) return reload(alive)
    commit(mutedSetOf(answer))
    // A malformed answer reads as no mutes on screen, but as "nobody muted"
    // the web worker would show their pushes: it keeps the last whole list,
    // and nothing is stored.
    const listed = Boolean(answer && Array.isArray(answer.keys))
    if (listed) reportMutes([...keysRef.current])
    listedRef.current = listed
    trustedRef.current = listed
    if (listed) saveQuietList('silenciados', bindingRef.current, keysRef.current)
  }, [commit])

  // A failed read keeps what is known: the node filters either way.
  useEffect(() => {
    epochRef.current++
    if (!ready) return
    let live = true
    reload(() => live).catch(noop)
    return () => { live = false }
  }, [ready, node.epoch, generation, reload])

  // mute.list also answers with no account open, so the lists go to the
  // worker only once one is; a list read before that is sent now.
  useEffect(() => {
    if (sessionKey === null) return
    openPushLists()
    if (listedRef.current) reportMutes([...keysRef.current])
  }, [sessionKey, node.epoch])

  useEffect(() => {
    if (mayStore && listedRef.current && trustedRef.current) saveQuietList('silenciados', bindingRef.current, keysRef.current)
  }, [mayStore, bindingKey])

  const refresh = useCallback(async () => {
    await reload()
    setChanged((n) => n + 1)
  }, [reload])

  const setMute = useCallback(async (key, on) => {
    try {
      const r = await requestRef.current('mute.set', { key, on })
      writesRef.current++
      const next = new Set(keysRef.current)
      if (on) next.add(key)
      else next.delete(key)
      commit(next)
      // One key over a list never read whole this run would replace the
      // worker's whole list; the next whole read reports it with this key.
      if (listedRef.current) reportMutes([...next])
      if (listedRef.current && trustedRef.current) saveQuietList('silenciados', bindingRef.current, next)
      setChanged((n) => n + 1)
      return r
    } catch (err) {
      // Not resent. The outcome is unknown, so what the node holds decides,
      // and A Rua reloads in case the write landed.
      if (err && err.uncertain === true) refresh().catch(noop)
      throw err
    }
  }, [commit, refresh])

  const value = useMemo(() => ({
    available,
    keys,
    changed,
    has: (key) => typeof key === 'string' && keys.has(key),
    setMute,
    refresh
  }), [available, keys, changed, setMute, refresh])

  return <MutesContext.Provider value={value}>{children}</MutesContext.Provider>
}
