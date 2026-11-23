// The blurred, dimmed copy of a photo that MediaView puts behind a contained
// photo, so the tile keeps the caller's size. The caller's tile clips it
// (overflow hidden), which is why the scale below may overshoot.
// No pointerEvents here: Android counts a pointerEvents child as hovered
// without letting it send the hover event, so TalkBack touch exploration
// would skip a button that contains this layer (see MediaGrid.js). An Image
// takes no presses, so the parent's press still works.

import { Image, Platform, StyleSheet, View } from 'react-native'

const BACKDROP_BLUR = 24

// Android's Image fades for 300 ms on its own (fadeDuration). iOS and the web
// have no such prop, and the web warns if it is passed through.
const imageFadeOff = Platform.OS === 'android' ? { fadeDuration: 0 } : null

export function MediaBackdrop ({ url }) {
  return (
    <View
      style={styles.layer}
      accessibilityElementsHidden
      importantForAccessibility='no-hide-descendants'
      aria-hidden
    >
      <Image
        source={{ uri: url }}
        style={styles.image}
        resizeMode='cover'
        blurRadius={BACKDROP_BLUR}
        // Android decodes at the view size before blurring, not at full size.
        resizeMethod='resize'
        accessibilityIgnoresInvertColors
        {...imageFadeOff}
      />
      <View style={styles.dim} />
    </View>
  )
}

const styles = StyleSheet.create({
  layer: { ...StyleSheet.absoluteFillObject },
  // Scaled up so the soft, transparent edge of the blur falls outside the tile.
  image: { ...StyleSheet.absoluteFillObject, transform: [{ scale: 1.2 }] },
  dim: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.35)' }
})
