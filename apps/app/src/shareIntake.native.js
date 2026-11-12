import { AppState } from 'react-native'
import { listen as onPending } from '../modules/share-intake'

export { clear, peek, release, sweep } from '../modules/share-intake'

// A share stored while the app is suspended can miss onPending. Becoming
// active runs the same callback so the composer still sees it.
export function listen (fn) {
  if (typeof fn !== 'function') return function () {}
  const off = onPending(fn)
  let sub = null
  try {
    sub = AppState.addEventListener('change', (s) => { if (s === 'active') fn() })
  } catch {}
  return function () {
    try { off() } catch {}
    const current = sub
    sub = null
    try {
      if (current && typeof current.remove === 'function') current.remove()
    } catch {}
  }
}
