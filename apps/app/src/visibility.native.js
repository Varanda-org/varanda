import { AppState } from 'react-native'

// Raw visibility follows AppState. Only the web kind (hosted) needs the shell
// to pause it: the core kind's worklet suspends and resumes the session in
// Bare itself, and a shell sync.stop queued behind that suspend would clear
// the continuous intent the resume restores.
function visibleFromState (state) {
  return state !== 'background' && state !== 'inactive'
}

export function isVisible () {
  return visibleFromState(AppState.currentState)
}

export function pausesWhenHidden (hosted) {
  return hosted === true
}

export function effectiveVisible (visible, hosted) {
  return visible || !pausesWhenHidden(hosted)
}

export function subscribeVisible (fn) {
  let last = isVisible()
  const subscription = AppState.addEventListener('change', (state) => {
    const visible = visibleFromState(state)
    if (visible === last) return
    last = visible
    fn(visible)
  })
  return () => subscription.remove()
}
