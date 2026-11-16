// The "Prévia de links" switch (../previewPref), read once and then followed
// live: switched off, every embedded player unloads at once and no new one
// loads (App.js holds them all, ./MusicEmbedCard draws the stored card).
import { useSyncExternalStore } from 'react'
import { onPreviewsChange, previewsEnabled } from '../previewPref'
import { onPreviewPrefStorage, previewPrefStore } from '../previewBuild'

// One read for every card: on the phone the store is a file read.
let current = null

function read () {
  if (current === null) current = previewsEnabled(previewPrefStore())
  return current
}

// This tab's switch, or (on the web) another tab's, read again from the store.
function subscribe (fn) {
  const offSwitch = onPreviewsChange((on) => {
    current = on
    fn()
  })
  const offStorage = onPreviewPrefStorage(() => {
    current = null
    fn()
  })
  return () => {
    offSwitch()
    offStorage()
  }
}

export function usePreviewsEnabled () {
  return useSyncExternalStore(subscribe, read, read)
}
