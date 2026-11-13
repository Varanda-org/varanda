import { useCallback, useEffect, useRef, useState } from 'react'
import * as shareIntake from './shareIntake'
import { EMPTY, SHARE_TTL_MS, acceptShare, shareStep } from './sharedIntent'

export function useSharedIntent ({ ready, locked, ownKey, gone, onOpen, onToast }) {
  const [state, setState] = useState(EMPTY)
  const stateRef = useRef(EMPTY)
  const pendingRead = useRef(false)
  const readRef = useRef(null)
  const latest = useRef({ ready, locked, ownKey, gone, onOpen, onToast })
  latest.current = { ready, locked, ownKey, gone, onOpen, onToast }

  const send = useCallback((event) => {
    const wasTaken = stateRef.current.taken
    const next = shareStep(stateRef.current, event)
    stateRef.current = next.state
    setState(next.state)
    for (const effect of next.effects) {
      if (effect.type === 'release') shareIntake.release(effect.id)
      else if (effect.type === 'toast') latest.current.onToast(effect.text)
      else if (effect.type === 'open') latest.current.onOpen()
    }
    if (wasTaken && !next.state.taken && pendingRead.current) {
      pendingRead.current = false
      if (readRef.current) readRef.current()
    }
  }, [])

  const tick = useCallback(() => {
    const { ready, locked, ownKey, gone } = latest.current
    send({ type: 'tick', ready, locked, ownKey, gone, now: Date.now() })
  }, [send])

  useEffect(() => {
    let alive = true
    const blocked = () => {
      if (!alive) return true
      if (stateRef.current.taken) {
        pendingRead.current = true
        return true
      }
      return false
    }
    const read = () => {
      if (blocked()) return
      return shareIntake.peek().then((raw) => {
        if (blocked() || raw === null) return
        const share = acceptShare(raw, Date.now())
        if (share === null) {
          if (raw && typeof raw.id === 'string') shareIntake.release(raw.id)
          return
        }
        send({ type: 'inbox', share, ownKey: latest.current.ownKey })
        tick()
      }, () => {}).then(() => {
        if (!blocked()) shareIntake.sweep(SHARE_TTL_MS)
      })
    }
    readRef.current = read
    read()
    const off = shareIntake.listen(read)
    return () => {
      alive = false
      readRef.current = null
      pendingRead.current = false
      off()
    }
  }, [send, tick])

  const { held, phase } = state
  const heldId = held === null ? null : held.id
  useEffect(() => {
    tick()
  }, [ready, locked, ownKey, gone, heldId, phase, tick])

  useEffect(() => {
    if (held === null) return
    const timer = setTimeout(tick, Math.max(0, held.at + SHARE_TTL_MS + 1 - Date.now()))
    return () => clearTimeout(timer)
  }, [held, tick])

  const done = useCallback((id) => send({ type: 'done', id }), [send])
  const requeue = useCallback(() => send({ type: 'requeue' }), [send])
  const taken = useCallback((id) => send({ type: 'taken', id }), [send])
  return { shared: phase === 'shown' ? held : null, done, requeue, taken }
}
