// The device's age refusals (src/ageMemory.js) as React state for the shell.
// The record never opens the gate: open() answers the node's verdict
// (nodeVouches) unless a refusal for this member and installation is on
// record or was answered in this run.
//
// Loaded once on mount (a missing or unreadable record: no denial known). A change
// made before the load answered is queued, applied in order on top of what
// the load read and saved, even when the component unmounted meanwhile: only
// the React state is skipped then, so a refusal is never lost to a quick
// navigation. Every save re-reads the stored record and applies its change on
// top, one save after another and under the store's lock (withAgeLock: Web
// Locks across tabs), so a second tab's denial is never overwritten. A record
// that is there but unreadable is never saved over: it may hold other
// refusals, so the change stays in this run only.
//
// A denial must stick: the member stays closed for this run even if the save
// fails (the session set, keyed by member and installation), and a failed
// save (a deny or a clear) is retried once. A clear sticks the same way: a
// refusal it could not remove from the disk would come back with the next
// save's fresh read, so the `cleared` set ignores it for the rest of the run.
//
// Another tab's save is heard through onAgeRecordChange (web 'storage'
// events) and reread, never saved, so a refusal made there closes this tab.

import { useCallback, useEffect, useRef, useState } from 'react'
import { loadAgeRecord, onAgeRecordChange, saveAgeRecord, withAgeLock } from './ageStore'
import { AGE_RECORD_UNREADABLE, ageRecordOf, denialKey, emptyAgeRecord, isDenied, withDenied, withoutDenied } from './ageMemory.js'

// Pure: whether the gate may open for this member and installation. `vouched`
// is nodeVouches(node.info); nothing from the record can open it. `cleared`:
// keys this run cleared, whose refusal on the record is stale.
export function openNow (record, denied, member, origin, vouched = false, cleared = null) {
  const key = denialKey(member, origin)
  if (denied instanceof Set && denied.has(key)) return false
  if (!(cleared instanceof Set && cleared.has(key)) && isDenied(record, member, origin)) return false
  return vouched === true
}

// Pure: the queued changes applied in order to a record (null: empty).
// Ops: { op: 'deny', member, origin }, { op: 'clear', member, origin }.
export function applyPending (record, ops) {
  let out = ageRecordOf(record) || emptyAgeRecord()
  for (const o of Array.isArray(ops) ? ops : []) {
    if (o === null || typeof o !== 'object') continue
    if (o.op === 'deny') out = withDenied(out, o.member, o.origin)
    else if (o.op === 'clear') out = withoutDenied(out, o.member, o.origin)
  }
  return out
}

// Pure: one save of `ops` on top of the record stored now (another tab may
// have written since this one loaded), inside `lock`, retried once with a
// fresh read when asked. The record written, or null when no attempt was
// saved (an unreadable or failed read is never saved over). Never throws.
export async function persistOps ({ load, save, lock = (fn) => fn() }, ops, retry = false) {
  let unreadable = false
  const attempt = async () => {
    const stored = await Promise.resolve().then(() => load()).catch(() => AGE_RECORD_UNREADABLE)
    if (stored === AGE_RECORD_UNREADABLE) {
      unreadable = true
      return null
    }
    const next = applyPending(stored, ops)
    const ok = await Promise.resolve().then(() => save(next)).catch(() => false)
    return ok === true ? next : null
  }
  const once = () => Promise.resolve().then(() => lock(attempt)).catch(() => null)
  const first = await once()
  if (first !== null || !retry || unreadable) return first
  return once()
}

export function useAgeMemory () {
  const [loaded, setLoaded] = useState(false)
  const [record, setRecord] = useState(null)
  // Bumped on every session set change so the render sees it.
  const [, setDenyTick] = useState(0)
  const recordRef = useRef(null)
  const deniedNow = useRef(new Set())
  const clearedNow = useRef(new Set())
  const saveChain = useRef(Promise.resolve())
  const loadedRef = useRef(false)
  const liveRef = useRef(true)
  // Changes made before the load answered, in order.
  const pending = useRef([])
  // Changes handed to the save chain and not yet written.
  const inflight = useRef([])

  const show = useCallback((next) => {
    recordRef.current = next
    if (liveRef.current) setRecord(next)
  }, [])

  const save = useCallback((ops) => {
    inflight.current.push(...ops)
    saveChain.current = saveChain.current
      .then(() => persistOps({ load: loadAgeRecord, save: saveAgeRecord, lock: withAgeLock }, ops, true))
      .catch(() => null)
      .then((written) => {
        inflight.current = inflight.current.filter((o) => !ops.includes(o))
        if (written !== null) show(applyPending(written, inflight.current))
      })
  }, [show])

  useEffect(() => {
    liveRef.current = true
    loadAgeRecord()
      .catch(() => null)
      .then((r) => {
        if (loadedRef.current) return
        loadedRef.current = true
        const ops = pending.current
        pending.current = []
        show(ops.length > 0 ? applyPending(r, ops) : (ageRecordOf(r) || null))
        if (liveRef.current) setLoaded(true)
        if (ops.length > 0) save(ops)
      })
    const off = onAgeRecordChange(() => {
      loadAgeRecord()
        .catch(() => null)
        .then((r) => {
          // Before the first load answers, that load reads the new record.
          if (!loadedRef.current || !liveRef.current) return
          show(applyPending(ageRecordOf(r), inflight.current))
        })
    })
    return () => {
      liveRef.current = false
      off()
    }
  }, [save, show])

  const apply = useCallback((op) => {
    if (!loadedRef.current) {
      // Only the session view until the load answers; the disk is written
      // once, on top of the loaded record.
      pending.current.push(op)
      show(applyPending(null, pending.current))
      return
    }
    show(applyPending(recordRef.current, [op]))
    save([op])
  }, [save, show])

  const deny = useCallback((member, origin) => {
    if (typeof member !== 'string' || typeof origin !== 'string') return
    deniedNow.current.add(denialKey(member, origin))
    clearedNow.current.delete(denialKey(member, origin))
    if (liveRef.current) setDenyTick((n) => n + 1)
    apply({ op: 'deny', member, origin })
  }, [apply])

  const clearDenial = useCallback((member, origin) => {
    if (typeof member !== 'string' || typeof origin !== 'string') return
    deniedNow.current.delete(denialKey(member, origin))
    clearedNow.current.add(denialKey(member, origin))
    if (liveRef.current) setDenyTick((n) => n + 1)
    apply({ op: 'clear', member, origin })
  }, [apply])

  // The ref holds what `record` shows; the dependency renews the callback.
  const open = useCallback(
    (member, origin, vouched) => openNow(recordRef.current, deniedNow.current, member, origin, vouched, clearedNow.current),
    [record]
  )

  return { loaded, open, deny, clearDenial }
}
