// Sorte do dia on the own profile: one bundled line per day, chosen from the
// diary's public key (src/sorte.js), so every device of the person agrees.
// Nothing is requested and nothing leaves the device.

import { StyleSheet, Text, View } from 'react-native'
import { saltOfKey, sorteDoDia } from '../sorte.js'
import { TEXTS } from '../profileExtraView.js'
import { useNow } from './index'
import { radius, space, type } from './theme'
import { useStyles } from './ThemeProvider'

export function SorteCard ({ ownerKey }) {
  const styles = useStyles(makeStyles)
  const now = useNow(60000)
  const salt = saltOfKey(ownerKey)
  if (salt === null) return null
  const line = sorteDoDia(new Date(now), salt)
  return (
    <View style={styles.card} accessible accessibilityLabel={TEXTS.sorteTitle + ': ' + line}>
      <Text style={styles.title}>{TEXTS.sorteTitle}</Text>
      <Text style={styles.line}>{line}</Text>
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  card: { backgroundColor: colors.warm, borderRadius: radius.md, padding: space.md, gap: space.xs },
  title: { ...type.section, color: colors.soft },
  line: { ...type.postText, color: colors.ink }
})
