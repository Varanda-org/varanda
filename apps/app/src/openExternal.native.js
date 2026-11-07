import { Linking } from 'react-native'

// The system browser. Never throws, so the screen's fallback link stays.
export function openExternal (url) {
  try {
    Linking.openURL(url).catch(() => {})
  } catch {}
}

// React Native's Text ignores href, so the link opens on press.
export function linkProps (url) {
  return { onPress: () => openExternal(url) }
}
