import { AccessibilityInfo } from 'react-native'

// Read once for the module and kept current by the listener, so callers read
// it at the moment they act, not per render. While VoiceOver or TalkBack runs,
// a tap on a post opens at once and never reaches the double tap: VoiceOver
// turns its own activation of plain text into a synthetic touch, and two of
// them would like. Post music never starts by itself before an answer.
let on = false
let known = false
try {
  Promise.resolve(AccessibilityInfo.isScreenReaderEnabled()).then((value) => { on = value === true; known = true }, () => {})
  AccessibilityInfo.addEventListener('screenReaderChanged', (value) => { on = value === true; known = true })
} catch {}

export function screenReaderOn () {
  return on
}

export function screenReaderKnown () {
  return known
}
