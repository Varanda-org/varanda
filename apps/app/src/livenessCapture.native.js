// Native face liveness capture (Android and iOS). The screen hands over only
// { sessionId, region, identityPoolId } and gets back onComplete() with no
// arguments, onError(code) or onCancel(), the same as the web twin. The guest
// credentials are fetched here and passed straight to the native module: they
// live only in the call frame of attempt(), never in a ref, state or module
// variable.

import { createElement as h, useEffect, useRef, useState } from 'react'
import { fetch as expoFetch } from 'expo/fetch'
import { cancel, isAvailable as moduleAvailable, start } from '../modules/face-liveness'
import { Btn, Spinner } from './ui'
import { createCredentialProvider } from './livenessCredentials.js'

// expo/fetch honours credentials: 'omit' and redirect: 'error' on both
// platforms; React Native's global fetch is only the fallback.
const nativeFetch = typeof expoFetch === 'function'
  ? (u, i) => expoFetch(u, i)
  : (u, i) => globalThis.fetch(u, i)

// The codes the web detector emits; anything else is a plain failure.
const SHOWN = ['CAMERA_DENIED', 'SESSION_EXPIRED', 'UNSUPPORTED']

export function isAvailable () {
  try {
    return moduleAvailable() === true
  } catch {
    return false
  }
}

export function LivenessCapture ({ sessionId, region, identityPoolId, onComplete, onError, onCancel }) {
  const [denied, setDenied] = useState(false)
  const alive = useRef(false)
  const started = useRef(false)
  const running = useRef(false)
  const handlers = useRef(null)
  handlers.current = { onComplete, onError, onCancel }

  const attempt = async () => {
    if (running.current) return
    running.current = true
    setDenied(false)
    let outcome = 'FAILED'
    try {
      const credentials = await createCredentialProvider({ region, identityPoolId, fetch: nativeFetch })()
      if (!alive.current) {
        running.current = false
        return
      }
      try {
        await start({ sessionId, region, credentials })
        outcome = 'OK'
      } catch (err) {
        const code = err && err.code
        if (code === 'CANCELLED' || SHOWN.includes(code)) outcome = code
      }
    } catch {}
    running.current = false
    if (!alive.current) return
    const { onComplete, onError, onCancel } = handlers.current
    if (outcome === 'OK') {
      if (typeof onComplete === 'function') onComplete()
    } else if (outcome === 'CANCELLED') {
      if (typeof onCancel === 'function') onCancel()
    } else {
      // The native screen is already closed: only the person's tap opens it again.
      if (outcome === 'CAMERA_DENIED') setDenied(true)
      if (typeof onError === 'function') onError(outcome)
    }
  }

  // A second effect run (StrictMode) on the same mount never starts again.
  // The native screen outlives this one, so a real unmount closes it; the
  // check waits a tick because a StrictMode replay runs the effect again
  // right after the cleanup, and that must not close it.
  useEffect(() => {
    alive.current = true
    if (!started.current) {
      started.current = true
      attempt()
    }
    return () => {
      alive.current = false
      setTimeout(() => {
        if (!alive.current && running.current) cancel()
      }, 0)
    }
  }, [])

  if (denied) return h(Btn, { label: 'Tentar de novo', onPress: () => { attempt() } })
  return h(Spinner, { size: 'large' })
}
