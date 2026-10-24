// Whether this page registers the service worker. Pure: no imports. Never
// unregisters: the development server, varanda-serve mode (same web client
// module) and a document without the generated release marker must neither
// register nor touch other registrations.
export function pwaBoot ({ mode, hosted, hasMarker, hasServiceWorker }) {
  if (mode === 'browser' && hosted === true && hasMarker === true && hasServiceWorker === true) {
    return { action: 'register', url: '/sw.js', scope: '/', updateViaCache: 'none' }
  }
  return { action: 'none' }
}
