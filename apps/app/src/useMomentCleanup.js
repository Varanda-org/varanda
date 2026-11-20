import { useEffect, useLayoutEffect, useRef } from 'react'
import { createCleanupPlanner } from './momentCleanup'
import * as store from './momentCleanupStore'
import { runCleanupPass } from './momentCleanupPass'
import { momentsOf } from './momentSeen'
import { momentsChanged } from './screens/Momentos'
import { isVisible, subscribeVisible } from './visibility'
import { isOnline, subscribeOnline } from './online'

const OWN_RUNS_KEPT = 8

// Run ids restart with each node session, so an own run is only known under
// the epoch, identity and passkey generation it was seen with.
function scopeOf (epoch, identity, generation) {
  return JSON.stringify([epoch ?? null, identity ?? null, generation ?? null])
}

function runKey (scope, runId) {
  return scope + ' ' + JSON.stringify(runId)
}

// A one-off run (Sincronizar, the recovery, a write gate) is never preempted,
// as in App's outbox drain gate. moment.delete starts once runs of its own
// (catching up before the write, pushing after it); those must not stop the
// pass that sent it. `starting` comes only from a sync.start request, never
// from the node's own runs.
function syncFree (sync, scope, ownRuns) {
  if (sync && sync.starting === true) return false
  if (!(sync && sync.active && sync.active.once)) return true
  return ownRuns.has(runKey(scope, sync.active.runId))
}

// A once run first seen while the pass's own delete is in flight, in the same
// scope, is that delete's own run. One seen at any other time is someone else's.
function noteOwnRun (sync, scope, ownInFlight, ownRuns) {
  if (!(ownInFlight.get(scope) > 0) || !(sync && sync.active && sync.active.once)) return
  const { runId } = sync.active
  if (runId === undefined || runId === null) return
  const key = runKey(scope, runId)
  if (ownRuns.has(key)) return
  ownRuns.add(key)
  for (const old of ownRuns) {
    if (ownRuns.size <= OWN_RUNS_KEPT) break
    ownRuns.delete(old)
  }
}

// The planner settles as gone every ledger entry missing from a short list, so
// anything but a whole moments.read answer must fail the read, never read as empty.
function pastOf (answer, identity) {
  if (!answer || typeof answer !== 'object' || !Array.isArray(answer.past)) throw new Error('Resposta de momentos inválida.')
  const { past } = momentsOf(answer, identity)
  if (!Array.isArray(past) || past.length !== answer.past.length) throw new Error('Resposta de momentos inválida.')
  return past
}

export function useMomentCleanup ({ node, identity, enabled }) {
  const latest = useRef(null)
  const own = useRef(null)
  if (own.current === null) own.current = { inFlight: new Map(), runs: new Set() }
  const generation = node.passkey?.generation
  const scope = scopeOf(node.epoch, identity, generation)
  noteOwnRun(node.sync, scope, own.current.inFlight, own.current.runs)
  const unlocked = node.passkey?.status?.unlocked === true && node.passkey.status.publicKey === identity
  // Vitrine has no configuration, as in App's snapshot gate. The pass is spent
  // on its first read, so a node still starting never begins it.
  const allowed = enabled && unlocked && node.phase === 'ready' && node.hosted === true && node.config != null &&
    node.online !== false && node.visible !== false && syncFree(node.sync, scope, own.current.runs)
  latest.current = { allowed, identity, epoch: node.epoch, generation, sync: node.sync }
  const turn = useRef(0)
  const stopRef = useRef(null)
  useLayoutEffect(() => {
    turn.current++
    return () => {
      turn.current++
      stopRef.current?.()
    }
  }, [allowed, identity, node.epoch, generation])

  const { epoch, request, whenIdle } = node
  useEffect(() => {
    if (!allowed || typeof whenIdle !== 'function') return
    let live = true
    const mine = turn.current
    const ctrl = new AbortController()
    const alive = () => {
      const now = latest.current
      const nowScope = scopeOf(now.epoch, now.identity, now.generation)
      noteOwnRun(now.sync, nowScope, own.current.inFlight, own.current.runs)
      return live && turn.current === mine && now.allowed && now.identity === identity &&
        now.epoch === epoch && now.generation === generation && syncFree(now.sync, nowScope, own.current.runs) &&
        isVisible() && isOnline()
    }
    const stop = () => {
      live = false
      ctrl.abort()
    }
    stopRef.current = stop
    const offVisible = subscribeVisible((visible) => { if (!visible) stop() })
    const offOnline = subscribeOnline((online) => { if (!online) stop() })
    const wait = whenIdle(4000)
    wait.promise.then(async () => {
      if (!alive()) return
      const removed = await runCleanupPass({
        store,
        planner: createCleanupPlanner({ store, identity }),
        identity,
        alive,
        now: () => Date.now(),
        listPast: async () => pastOf(await request('moments.read', {}, { signal: ctrl.signal, gate: alive }), identity),
        remove: async (ref) => {
          // Marked as never sent, so the pass gives the try back.
          if (!alive()) throw Object.assign(new Error('Passagem encerrada.'), { queued: true })
          // An answer that arrives after the pass stopped is still a done delete.
          const { inFlight } = own.current
          const sent = scopeOf(epoch, identity, generation)
          inFlight.set(sent, (inFlight.get(sent) || 0) + 1)
          try {
            return await request('moment.delete', { to: ref }, { signal: ctrl.signal, gate: alive })
          } finally {
            const left = inFlight.get(sent) - 1
            if (left > 0) inFlight.set(sent, left)
            else inFlight.delete(sent)
          }
        }
      })
      // Without the Web Lock the pass resolves to null.
      if (typeof removed === 'number' && removed > 0) momentsChanged()
    }).catch(() => {})
    return () => {
      stop()
      if (stopRef.current === stop) stopRef.current = null
      wait.cancel()
      offVisible()
      offOnline()
    }
  }, [allowed, identity, epoch, generation, request, whenIdle])
}
