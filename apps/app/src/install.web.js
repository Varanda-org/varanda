// Web only: bind at module evaluation to catch beforeinstallprompt before React
// mounts. Use the same hosted browser gate as the service worker. The Samsung
// Internet manifest removal also runs at module evaluation, the earliest the
// bundle can run (CSP forbids inline scripts).
/* global window, navigator, localStorage, document */

import { useSyncExternalStore } from 'react'
import { webMode } from './client/mode'
import { hostedPage } from './configStore'
import { createInstallOffer } from './install-offer'

const offer = createInstallOffer({
  eligible: webMode === 'browser' && hostedPage === true,
  win: typeof window === 'undefined' ? null : window,
  nav: typeof navigator === 'undefined' ? null : navigator,
  doc: typeof document === 'undefined' ? null : document,
  storage: () => localStorage
})

export function getInstall () {
  return offer.getSnapshot()
}

export function getInstallCard () {
  return offer.getCard()
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
  const card = useSyncExternalStore(subscribeInstall, getInstallCard, getInstallCard)
  return { note, canPrompt, card, promptInstall, dismissInstall }
}
