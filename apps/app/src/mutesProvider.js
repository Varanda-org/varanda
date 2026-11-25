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

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useNode } from './node'
import { mutedSetOf } from './memberMutes'
import { isLatestReload } from './blocksProvider'
import { reportMutes } from './pushBlocks'

const EMPTY = new Set()
const noop = () => {}

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

export function MutesProvider ({ children }) {
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
  const [changed, setChanged] = useState(0)

  const commit = useCallback((next) => {
    keysRef.current = next
    setKeys(next)
    reportMutes([...next])
  }, [])

  const reload = useCallback(async (alive = () => true) => {
    const epoch = epochRef.current
    const seq = ++reloadSeqRef.current
    const answer = await requestRef.current('mute.list', {})
    if (!alive() || !isLatestReload(seq, reloadSeqRef.current, epoch, epochRef.current)) return
    commit(mutedSetOf(answer))
  }, [commit])

  // A failed read keeps what is known: the node filters either way.
  useEffect(() => {
    epochRef.current++
    if (!ready) return
    let live = true
    reload(() => live).catch(noop)
    return () => { live = false }
  }, [ready, node.epoch, generation, reload])

  const refresh = useCallback(async () => {
    await reload()
    setChanged((n) => n + 1)
  }, [reload])

  const setMute = useCallback(async (key, on) => {
    try {
      const r = await requestRef.current('mute.set', { key, on })
      const next = new Set(keysRef.current)
      if (on) next.add(key)
      else next.delete(key)
      commit(next)
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
