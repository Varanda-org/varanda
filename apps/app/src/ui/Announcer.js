// A status line the screen reader speaks when it changes (a saved
// certificate, a renamed @nome). It stays mounted and takes no room: a live
// region inserted together with its text is often not announced. iOS has no
// accessibilityLiveRegion, so it is spoken there. The text is transparent,
// not opacity 0: Android drops an invisible view from the accessibility tree.

import { useEffect } from 'react'
import { AccessibilityInfo, Platform, StyleSheet, Text } from 'react-native'

export function Announcer ({ text }) {
  useEffect(() => {
    if (!text || Platform.OS !== 'ios') return
    try { AccessibilityInfo.announceForAccessibility(text) } catch {}
  }, [text])
  return <Text style={styles.hidden} accessibilityLiveRegion='polite' aria-live='polite'>{text}</Text>
}

const styles = StyleSheet.create({
  hidden: { position: 'absolute', width: 1, height: 1, overflow: 'hidden', color: 'transparent' }
})
