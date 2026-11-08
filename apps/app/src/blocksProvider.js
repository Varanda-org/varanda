// The member's own block list in the app (docs/rpc.md 5.111 and 5.112). The node
// holds it and filters every read; this keeps a copy so screens can clear rows
// at once and offer Desbloquear. Hosted nodes only: the core node has no list.
//
// `changed` counts the changes made here, so the shell reloads A Rua once per
// change. The confirmation is a separate context: opening it must not redraw
// every post row.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useNode } from './node'
import { diaryPeekSlots } from './engagement'
import { fetchMember } from './indexClient'
import { blockedPeekParams, blockedSetOf } from './memberBlocks'
import { reportBlocks } from './pushBlocks'

const EMPTY = new Set()
const noop = () => {}

const FALLBACK = {
  available: false,
  keys: EMPTY,
  changed: 0,
  has: () => false,
  ask: noop,
  setBlock: async () => { throw new Error('bloqueio indisponível') }
}

const BlocksContext = createContext(FALLBACK)
const AskContext = createContext({ asking: null, close: noop })

export function useBlocks () {
  return useContext(BlocksContext)
}

export function useBlockAsk () {
  return useContext(AskContext)
}

export function BlocksProvider ({ children }) {
  const node = useNode()
  const available = node.hosted === true
  const generation = node.passkey ? node.passkey.generation : 0
  const ready = available && node.phase === 'ready'
  const requestRef = useRef(node.request)
  requestRef.current = node.request
  const [keys, setKeys] = useState(EMPTY)
  const [changed, setChanged] = useState(0)
  const [asking, setAsking] = useState(null)

  const keysRef = useRef(EMPTY)
  const commit = useCallback((next) => {
    keysRef.current = next
    setKeys(next)
    reportBlocks([...next])
  }, [])

  const reload = useCallback(async (alive = () => true) => {
    const answer = await requestRef.current('block.list', {})
    if (alive()) commit(blockedSetOf(answer))
  }, [commit])

  // A failed read keeps what is known: the node filters either way.
  useEffect(() => {
    if (!ready) return
    let live = true
    reload(() => live).catch(noop)
    return () => { live = false }
  }, [ready, node.epoch, generation, reload])

  const setBlock = useCallback(async (key, on) => {
    try {
      const r = await requestRef.current('block.set', { key, on })
      const next = new Set(keysRef.current)
      if (on) next.add(key)
      else next.delete(key)
      commit(next)
      setChanged((n) => n + 1)
      return r
    } catch (err) {
      // Not resent. The outcome is unknown, so what the node holds decides.
      if (err && err.uncertain === true) reload().catch(noop)
      throw err
    }
  }, [commit, reload])

  const value = useMemo(() => ({
    available,
    keys,
    changed,
    has: (key) => typeof key === 'string' && keys.has(key),
    ask: setAsking,
    setBlock
  }), [available, keys, changed, setBlock])
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
