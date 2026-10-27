// Web only: bind at module evaluation to catch beforeinstallprompt before React
// mounts. Use the same hosted browser gate as the service worker.
/* global window, navigator, localStorage */

import { useSyncExternalStore } from 'react'
import { webMode } from './client/mode'
import { hostedPage } from './configStore'
import { createInstallOffer } from './install-offer'

const offer = createInstallOffer({
  eligible: webMode === 'browser' && hostedPage === true,
  win: typeof window === 'undefined' ? null : window,
  nav: typeof navigator === 'undefined' ? null : navigator,
  storage: () => localStorage
})

export function getInstall () {
  return offer.getSnapshot()
}

export function subscribeInstall (fn) {
  return offer.subscribe(fn)
}

export function promptInstall () {
  return offer.prompt()
}

export function dismissInstall () {
  return offer.dismiss()
}

export function useInstall () {
  const { note, canPrompt } = useSyncExternalStore(subscribeInstall, getInstall, getInstall)
  return { note, canPrompt, promptInstall, dismissInstall }
}
