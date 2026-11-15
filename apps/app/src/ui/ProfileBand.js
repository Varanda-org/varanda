// The band behind a profile's name. Without a theme it is the usual sunset
// band, untouched; with one it is a flat band in the theme's colors for the
// current scheme, with a thin accent line at its foot.

import { StyleSheet, View } from 'react-native'
import { themeColors } from '../profileThemes.js'
import { SunsetBand } from './SunsetBand'
import { useTheme } from './ThemeProvider'

const LINE = 4

export function ProfileBand ({ height, theme = null, children }) {
  const { scheme } = useTheme()
  if (theme === null || theme === undefined) return <SunsetBand height={height}>{children}</SunsetBand>
  const c = themeColors(theme, scheme)
  return (
    <View style={[styles.band, { height, backgroundColor: c.band }]} accessible={false}>
      <View style={[styles.line, { backgroundColor: c.accent }]} />
      {children}
    </View>
  )
}

const styles = StyleSheet.create({
  band: { position: 'relative', overflow: 'hidden' },
  line: { position: 'absolute', left: 0, right: 0, bottom: 0, height: LINE }
})
