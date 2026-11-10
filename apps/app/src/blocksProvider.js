// The member's own block list in the app (docs/rpc.md 5.111 and 5.112). The node
// holds it and filters every read; this keeps a copy so screens can clear rows
// at once and offer Desbloquear. Hosted nodes only: the core node has no list.
//
// `changed` counts the changes made here or brought by another device of the
// passkey (`refresh`, after a seen pass), so the shell reloads A Rua once per
// change. The confirmation is a separate context: opening it must not redraw
// every post row.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useNode } from './node'
import { diaryPeekSlots } from './engagement'
import { fetchMember } from './indexClient'
import { blockedPeekParams, blockedSetOf } from './memberBlocks'
import { reportBlocks } from './pushBlocks'
import { dropAuthors, newlyBlocked } from './localCaches'

const EMPTY = new Set()
const noop = () => {}

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

const FALLBACK = {
  available: false,
  keys: EMPTY,
  loadState: 'pending',
  changed: 0,
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

export function BlocksProvider ({ children }) {
  const node = useNode()
  const available = node.hosted === true
  const generation = node.passkey ? node.passkey.generation : 0
  const ready = available && node.phase === 'ready'
  const requestRef = useRef(node.request)
  requestRef.current = node.request
  const [keys, setKeys] = useState(EMPTY)
  const [loadState, setLoadState] = useState('pending')
  // Counts the epochs: an answer from an older one never sets the state.
  const epochRef = useRef(0)
  // Counts the reloads: only the latest one asked commits or sets the state.
  const reloadSeqRef = useRef(0)
  const [changed, setChanged] = useState(0)
  const [asking, setAsking] = useState(null)

  const keysRef = useRef(EMPTY)
  const commit = useCallback((next) => {
    // Kept copies of a newly blocked author go before any screen can show
    // them again, whether the block was made here, on another device of the
    // passkey (reload) or is the first list read at launch.
    const added = newlyBlocked(keysRef.current, next)
    if (added.length > 0) dropAuthors(added)
    keysRef.current = next
    setKeys(next)
    reportBlocks([...next])
  }, [])

  // Only a whole list read marks the epoch 'ok': setBlock's commit adds one
  // key to what is known, which is not the list after a failed read.
  const reload = useCallback(async (alive = () => true) => {
    const epoch = epochRef.current
    const seq = ++reloadSeqRef.current
    const current = () => alive() && isLatestReload(seq, reloadSeqRef.current, epoch, epochRef.current)
    let answer
    try {
      answer = await requestRef.current('block.list', {})
    } catch (err) {
      if (current()) setLoadState((s) => nextLoadState(s, 'failed'))
      throw err
    }
    if (!current()) return
    commit(blockedSetOf(answer))
    setLoadState((s) => nextLoadState(s, 'loaded'))
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

  const refresh = useCallback(async () => {
    await reload()
    setChanged((n) => n + 1)
  }, [reload])

  const value = useMemo(() => ({
    available,
    keys,
    loadState,
    changed,
    has: (key) => typeof key === 'string' && keys.has(key),
    ask: setAsking,
    setBlock,
    refresh
  }), [available, keys, loadState, changed, setBlock, refresh])
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
