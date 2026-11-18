// The probe of src/coreDm.js for a screen: asked again when the node
// changes (epoch) or Conversas changed (dmVersion). activate() calls
// dm.enable once per tap, never by itself; an error is shown, not retried.

import { useCallback, useEffect, useRef, useState } from 'react'
import { View } from 'react-native'
import { CORE_DM_ACTIVATE, CORE_DM_ACTIVATE_NOTE, forgetCoreDm, probeCoreDm, probeCorePageGroups } from '../coreDm'
import { Btn, ErrorText, Soft, errorText } from './index'

// -> { state: 'hosted' | 'on' | 'off' | 'none' | null, activating, error, activate }
export function useCoreDm (node) {
  const hosted = node.hosted !== false
  const [state, setState] = useState(hosted ? 'hosted' : null)
  const [activating, setActivating] = useState(false)
  const [error, setError] = useState('')
  const [tick, setTick] = useState(0)
  const nodeRef = useRef(node)
  nodeRef.current = node
  useEffect(() => {
    if (hosted) {
      setState('hosted')
      return undefined
    }
    let alive = true
    probeCoreDm(nodeRef.current).then((s) => { if (alive) setState(s) }, () => { if (alive) setState(null) })
    return () => { alive = false }
  }, [hosted, node.request, node.accountOrigin, node.epoch, node.dmVersion, tick])
  const activate = useCallback(async () => {
    if (activating) return
    setActivating(true)
    setError('')
    try {
      await nodeRef.current.request('dm.enable', {})
    } catch (err) {
      setError(errorText(err))
    } finally {
      forgetCoreDm(nodeRef.current)
      setActivating(false)
      setTick((n) => n + 1)
      if (typeof nodeRef.current.bumpDm === 'function') nodeRef.current.bumpDm()
    }
  }, [activating])
  return { state, activating, error, activate }
}

// The activation offered on a core node whose engine was never enabled.
export function CoreDmActivate ({ core, style }) {
  return (
    <View style={style}>
      <Soft>{CORE_DM_ACTIVATE_NOTE}</Soft>
      <Btn label={CORE_DM_ACTIVATE} onPress={() => core.activate()} pending={core.activating} disabled={core.activating} />
      {core.error ? <ErrorText>{core.error}</ErrorText> : null}
    </View>
  )
}

// probeCorePageGroups for a screen acting as `page` (null: not a Página).
// -> 'hosted' | 'on' | 'none' | null while unknown.
export function useCorePageGroups (node, page) {
  const hosted = node.hosted !== false
  const [state, setState] = useState(hosted ? 'hosted' : null)
  const nodeRef = useRef(node)
  nodeRef.current = node
  useEffect(() => {
    if (hosted) {
      setState('hosted')
      return undefined
    }
    if (page === null) {
      setState('none')
      return undefined
    }
    let alive = true
    setState(null)
    probeCorePageGroups(nodeRef.current, page).then((s) => { if (alive) setState(s) }, () => { if (alive) setState(null) })
    return () => { alive = false }
  }, [hosted, page, node.request, node.accountOrigin, node.epoch])
  return state
}
