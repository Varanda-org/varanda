import { useState } from 'react'
import { Image, StyleSheet, View } from 'react-native'
import { displayText } from '@varanda/rpc'
import { Icon } from './Icon'
import { useStyles, useTheme } from './ThemeProvider'
import { radius } from './theme'

// Only a base64 JPEG, PNG or WebP data: URI is drawn: the cover the session
// cache already holds (src/musicCover.js). Nothing here fetches, so a peer's
// or provider's URL can never become a request, and an SVG never reaches the
// image decoder whatever builds the URI; anything else, or bytes the decoder
// refuses, is the tile generated on the device.
const COVER_URI_RE = /^data:image\/(jpeg|png|webp);base64,/
const isCoverUri = (uri) => typeof uri === 'string' && COVER_URI_RE.test(uri)

export function MusicCover ({ size = 48, uri, label = 'Capa da música' }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  const [failed, setFailed] = useState(null)
  const shape = { width: size, height: size, borderRadius: size >= 96 ? radius.md : radius.sm }
  if (isCoverUri(uri) && failed !== uri) {
    return (
      <View style={[styles.tile, shape]}>
        <Image
          source={{ uri }}
          resizeMode='cover'
          style={styles.image}
          accessibilityIgnoresInvertColors
          accessibilityRole='image'
          accessibilityLabel={displayText(label)}
          onError={() => setFailed(uri)}
        />
      </View>
    )
  }
  return (
    <View
      style={[styles.tile, shape]}
      accessibilityLabel={displayText(label)}
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility='no-hide-descendants'
      aria-hidden
    >
      <Icon name='musica' size={Math.round(size * 0.42)} color={colors.soft} />
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  tile: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden', backgroundColor: colors.skeleton },
  image: { width: '100%', height: '100%' }
})
