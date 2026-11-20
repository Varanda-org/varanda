import { AccessibilityInfo } from 'react-native'

// iOS ignores accessibilityLiveRegion, so the note is announced instead. That
// call works on Android too, so the live region stays off there.
export const liveRegion = 'none'
export function announce (text) {
  try { AccessibilityInfo.announceForAccessibility(text) } catch {}
}
