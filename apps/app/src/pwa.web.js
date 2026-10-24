/* global navigator, document */

// Web: registers the service worker on a hosted installation whose document
// carries the release marker the export generator inserts into dist/index.html
// (never public/index.html). Never throws.

import { hostedPage } from './configStore'
import { webMode } from './client/mode'
import { pwaBoot } from './pwa-boot'

export function startPwa () {
  try {
    const meta = document.querySelector('meta[name="varanda-release"]')
    const boot = pwaBoot({
      mode: webMode,
      hosted: hostedPage,
      hasMarker: !!meta && !!meta.getAttribute('content'),
      hasServiceWorker: typeof navigator === 'object' && navigator !== null && !!navigator.serviceWorker
    })
    if (boot.action !== 'register') return Promise.resolve(false)
    return Promise.resolve(navigator.serviceWorker.register(boot.url, { scope: boot.scope, updateViaCache: boot.updateViaCache }))
      .then(() => true, () => false)
  } catch {
    return Promise.resolve(false)
  }
}
