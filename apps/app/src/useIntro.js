import { useCallback, useEffect, useRef, useState } from 'react'
import { loadIntroRecord, saveIntroRecord } from './introStore'
import { INTRO_VERSION, withSeen } from './intro'

export function useIntro () {
  const [status, setStatus] = useState('loading')
  const [record, setRecord] = useState(null)
  const saveChain = useRef(Promise.resolve())
  // A late read must not undo cards already seen during this page load.
  const touched = useRef(false)

  useEffect(() => {
    let live = true
    loadIntroRecord()
      .catch(() => null)
      .then((r) => {
        if (!live) return
        if (!touched.current) setRecord(r || null)
        setStatus('ready')
      })
    return () => { live = false }
  }, [])

  const markSeen = useCallback(() => {
    const next = withSeen(INTRO_VERSION, new Date().toISOString())
    touched.current = true
    setRecord(next)
    saveChain.current = saveChain.current
      .then(() => saveIntroRecord(next))
      .catch(() => false)
  }, [])

  return { status, record, markSeen }
}
