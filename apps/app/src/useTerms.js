// The device's terms acceptance record (src/terms.js) as React state for the
// shell. Loaded once on mount (a failed or refused read is null: ask again);
// every change is computed from a ref, so two updates in one render never
// lose each other, and the saves run one after another so the last one wins
// on disk. A refused save keeps the acceptance in memory for this page load
// and raises saveFailed (Ajustes says it was not kept); a later good save
// clears it.
//
// `claim` is an acceptance made before anyone signed in ({at}, or null). It
// lives only in this page's memory, never on disk, and is spent the moment
// a member is known (bind): it never carries over to another identity.

import { useCallback, useEffect, useRef, useState } from 'react'
import { loadTermsRecord, saveTermsRecord } from './termsStore'
import { withMember, withSynced, withoutMember } from './terms'

export function useTerms (version) {
  const [status, setStatus] = useState('loading')
  const [record, setRecord] = useState(null)
  const [claim, setClaim] = useState(null)
  const [saveFailed, setSaveFailed] = useState(false)
  const recordRef = useRef(null)
  const claimRef = useRef(null)
  const saveChain = useRef(Promise.resolve())
  // An update made before the load answered wins over what the load reads.
  const touched = useRef(false)

  useEffect(() => {
    let live = true
    loadTermsRecord()
      .catch(() => null)
      .then((r) => {
        if (!live) return
        if (!touched.current) {
          recordRef.current = r || null
          setRecord(r || null)
        }
        setStatus('ready')
      })
    return () => { live = false }
  }, [])

  const commit = useCallback((next) => {
    if (next === recordRef.current) return
    touched.current = true
    recordRef.current = next
    setRecord(next)
    saveChain.current = saveChain.current
      .then(() => saveTermsRecord(next))
      .catch(() => false)
      .then((ok) => setSaveFailed(ok !== true))
  }, [])

  const takeClaim = useCallback((c) => {
    claimRef.current = c
    setClaim(c)
  }, [])

  const accept = useCallback((member) => {
    const at = new Date().toISOString()
    const m = member === undefined ? null : member
    commit(withMember(recordRef.current, version, m, at))
    takeClaim(m === null ? { at } : null)
  }, [version, commit, takeClaim])

  // Spends the claim on the member that just became known: recorded with the
  // claim's time, or simply dropped when that member had accepted already.
  const bind = useCallback((member) => {
    const c = claimRef.current
    if (c === null || !member) return
    takeClaim(null)
    const r = recordRef.current
    if (r && r.version === version && Object.hasOwn(r.members, member)) return
    commit(withMember(r, version, member, c.at))
  }, [version, commit, takeClaim])

  const markSynced = useCallback((member) => {
    commit(withSynced(recordRef.current, member))
  }, [commit])

  const dropMember = useCallback((member) => {
    commit(withoutMember(recordRef.current, member))
  }, [commit])

  return { status, record, claim, saveFailed, accept, bind, markSynced, dropMember }
}
