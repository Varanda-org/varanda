// Names the people a screen lists that profile.read has no profile for (it
// answers "missing" for anyone the node does not hold), the way the Conversas
// list does: the seeder index hints, then one node-verified diary.peek per key
// (rowPeek.js, peerProfile.js). Only while `enabled`; the core node refuses
// the peek and a row keeps its unnamed text. `keys` are the first rows on
// screen, newest asks first; at most PEEK_WINDOW of them are asked.

import { useEffect, useRef } from 'react'
import { useNode } from './node'
import { useNames } from './names'
import { fetchMember } from './indexClient'
import { diaryPeekSlots } from './engagement'
import { readPeerEntry } from './peerProfile'
import { planRowPeeks, runRowPeeks } from './rowPeek'

export function useRowPeeks (keys, enabled) {
  const node = useNode()
  const { profileOf, isPeeked, learnVerified, forgetVerified, peekScope } = useNames()
  const latest = useRef({})
  latest.current = { keys, profileOf, isPeeked, learnVerified, forgetVerified, request: node.request, peekScope }
  const tried = useRef(new Set())
  const run = useRef(0)
  const active = useRef(null)
  const gate = enabled && node.hosted === true && node.visible !== false && node.online !== false
  useEffect(() => {
    if (!gate) {
      run.current++
      active.current = null
      return undefined
    }
    const scope = latest.current.peekScope
    // A walk of this scope is already running and re-plans on its own.
    if (active.current !== null && active.current.scope === scope) return undefined
    const id = ++run.current
    const current = () => run.current === id && latest.current.peekScope === scope
    active.current = { run: id, scope }
    runRowPeeks({
      plan: () => planRowPeeks({ peers: latest.current.keys, profileOf: latest.current.profileOf, isPeeked: latest.current.isPeeked, tried: tried.current, scope }),
      tried: tried.current,
      scope,
      read: (peer) => readPeerEntry(peer, {
        fetchMember,
        peek: (params) => diaryPeekSlots.run(() => current() ? latest.current.request('diary.peek', params) : null, { front: true })
      }),
      current,
      learn: (peer, entry) => latest.current.learnVerified([[peer, entry]], scope),
      forget: (peer) => latest.current.forgetVerified([peer], scope)
    }).then(() => {
      if (active.current !== null && active.current.run === id) active.current = null
    })
    return undefined
  // profileOf changes with every answer of profile.read: that is when a key
  // turns "missing" and becomes worth asking.
  }, [gate, keys, peekScope, profileOf])
  useEffect(() => () => { run.current++ }, [])
}
