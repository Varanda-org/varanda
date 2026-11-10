// Web Escape for stacked layers (Sheet, ActionsSheet): one key closes only the
// layer on top. App's Escape (window keydown, bubble) pops the screen unless
// the event was handled, and react-native-web's Modal closes on keyup, so both
// phases are taken at the window in capture while any layer is open: the press
// is marked handled, the release is consumed and closes the top layer only.
// On native there is no window listener and the hook only keeps the count.

import { useEffect, useRef } from 'react'

export function createEscapeStack () {
  const layers = []
  return {
    push (layer) { layers.push(layer) },
    pop (layer) {
      const i = layers.lastIndexOf(layer)
      if (i > -1) layers.splice(i, 1)
    },
    top () { return layers.length > 0 ? layers[layers.length - 1] : null },
    count (kind) {
      if (kind === undefined) return layers.length
      return layers.filter((l) => l.kind === kind).length
    }
  }
}

// Returns true when the event was taken for a layer.
export function handleKey (stack, event) {
  if (!event || event.key !== 'Escape') return false
  const top = stack.top()
  if (top === null) return false
  if (event.type === 'keydown') {
    event.preventDefault()
    return true
  }
  if (event.type === 'keyup') {
    event.preventDefault()
    event.stopImmediatePropagation()
    if (typeof top.onClose === 'function') top.onClose()
    return true
  }
  return false
}

const stack = createEscapeStack()
let installed = false

function install () {
  if (installed) return
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return
  installed = true
  const onKey = (event) => { handleKey(stack, event) }
  window.addEventListener('keydown', onKey, true)
  window.addEventListener('keyup', onKey, true)
}

export function escapeLayerCount (kind) {
  return stack.count(kind)
}

// The latest onClose is called through a ref, so a new closure each render
// does not re-register the layer (which would move it to the top).
export function useEscapeLayer (active, onClose, kind) {
  const latest = useRef(onClose)
  latest.current = onClose
  useEffect(() => {
    if (!active) return undefined
    install()
    const layer = { kind, onClose: () => { if (typeof latest.current === 'function') latest.current() } }
    stack.push(layer)
    return () => stack.pop(layer)
  }, [active, kind])
}
