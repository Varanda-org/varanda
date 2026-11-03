// In-browser face liveness capture. The screen hands over only
// { sessionId, region, identityPoolId } and gets back onComplete() with no
// arguments or onError(code): the guest credentials are fetched here, at the
// detector's request, and never leave this component.

import { createElement as h, Suspense, lazy, useMemo } from 'react'
import { Spinner } from './ui'
import { createCredentialProvider } from './livenessCredentials.js'

// A separate chunk: the detector carries tensorflow and the streaming client,
// which nobody else needs.
const Detector = lazy(() => import('./livenessDetector.web.js'))

// The detector asks for the camera itself; without a secure context or
// getUserMedia it could only fail, so the screen keeps the hosted page.
export function isAvailable () {
  if (globalThis.isSecureContext !== true) return false
  const nav = globalThis.navigator
  const media = nav && typeof nav === 'object' ? nav.mediaDevices : undefined
  return !!media && typeof media.getUserMedia === 'function'
}

export function LivenessCapture ({ sessionId, region, identityPoolId, onComplete, onError, onCancel }) {
  // Looked up at call time, so a fetch wrapper installed later still applies.
  const credentialProvider = useMemo(
    () => createCredentialProvider({ region, identityPoolId, fetch: (u, i) => globalThis.fetch(u, i) }),
    [region, identityPoolId]
  )
  return h(Suspense, { fallback: h(Spinner, { size: 'large' }) },
    h(Detector, {
      sessionId,
      region,
      credentialProvider,
      onComplete: () => { if (typeof onComplete === 'function') onComplete() },
      onError: (code) => { if (typeof onError === 'function') onError(code) },
      onCancel: () => { if (typeof onCancel === 'function') onCancel() }
    })
  )
}
