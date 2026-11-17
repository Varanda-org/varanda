/* global __DEV__ */

// The reader clock of the Varandinha screens. Growth, the dry check and the
// 72 h help window are judged on the reader's own clock, so this is
// Date.now(). The Vitrine answers on its demo clock instead (fixtures.now,
// plus a second per write), so a Vitrine bundle reads that clock here too:
// on the real clock every demo plant would read ripe, no demo watering would
// fall inside the window, and nothing could be watered.

import { vitrineEnabled } from './vitrine/enabled.js'

const VITRINE = vitrineEnabled({ EXPO_PUBLIC_VARANDA_VITRINE: process.env.EXPO_PUBLIC_VARANDA_VITRINE }, typeof __DEV__ !== 'undefined' && __DEV__)
let offset = 0
if (typeof __DEV__ !== 'undefined' && __DEV__ && process.env.EXPO_PUBLIC_VARANDA_VITRINE === '1' && VITRINE) {
  const { fixtures } = require('./vitrine/fixtures')
  offset = Date.parse(fixtures.now) - Date.now()
}

export function gardenTime (ms = Date.now()) {
  return ms + offset
}
