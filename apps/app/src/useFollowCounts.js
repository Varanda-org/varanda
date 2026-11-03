// The public 'seguindo' and 'seguidores' numbers of a diary, from the seeder
// index (fetchFollowCounts). They are the seeder's word, not verified records:
// shown as counts only. Asked only on a hosted node that is not offline, once
// per author and again when `tick` changes. Never throws.

import { useEffect, useRef, useState } from 'react'
import { useNode } from './node'
import { fetchFollowCounts } from './indexClient'

const HEX64 = /^[0-9a-f]{64}$/

const EMPTY = Object.freeze({ seguindo: null, seguidores: null, incomplete: false, phase: 'idle' })

const isCount = (n) => Number.isSafeInteger(n) && n >= 0

export function useFollowCounts (author, tick) {
  const node = useNode()
  const hosted = node.hosted === true
  const online = node.online !== false
  const valid = typeof author === 'string' && HEX64.test(author)
  const [state, setState] = useState(EMPTY)
  // Only the latest request may commit; unmount bumps it too.
  const gen = useRef(0)
  // The author the current values belong to: another author starts empty.
  const shownFor = useRef(null)
  const answered = useRef(null)

  useEffect(() => () => { gen.current++ }, [])

  useEffect(() => {
    if (!hosted || !valid) {
      gen.current++
      shownFor.current = null
      answered.current = null
      setState(EMPTY)
      return
    }
    // Offline: keep what was shown; a stale answer for another author is not shown.
    if (!online) {
      if (shownFor.current !== author) setState(EMPTY)
      return
    }
    // Coming back online re-asks only when this author and tick have no answer.
    const asked = author + '|' + String(tick)
    if (answered.current === asked) return
    const mine = ++gen.current
    if (shownFor.current !== author) {
      shownFor.current = author
      setState({ ...EMPTY, phase: 'loading' })
    } else {
      setState((s) => ({ ...s, phase: 'loading' }))
    }
    const run = async () => {
      let res
      try {
        res = await fetchFollowCounts(author)
      } catch {
        res = null
      }
      if (gen.current !== mine) return
      const v = res && res.ok ? res.value : null
      if (v && isCount(v.seguindo) && isCount(v.seguidores)) {
        answered.current = asked
        setState({
          seguindo: v.seguindo,
          seguidores: v.seguidores,
          incomplete: v.indexing === true || v.complete !== true,
          phase: 'ready'
        })
      } else {
        // A failed refresh keeps the numbers already shown for this author.
        setState((s) => ({ ...s, phase: 'error' }))
      }
    }
    run()
  }, [hosted, online, valid, author, tick])

  return state
}

export default useFollowCounts
