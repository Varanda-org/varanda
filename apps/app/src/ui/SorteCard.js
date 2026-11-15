// Sorte do dia on the own profile: one bundled line per day, chosen on the
// device (src/sorte.js). Nothing is requested and nothing leaves the device.

import { useEffect, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { sorteDoDia } from '../sorte.js'
import { loadSalt } from '../sorteStore'
import { TEXTS } from '../profileExtraView.js'
import { useNow } from './index'
import { radius, space, type } from './theme'
import { useStyles } from './ThemeProvider'

export function SorteCard () {
  const styles = useStyles(makeStyles)
  const now = useNow(60000)
  const [salt, setSalt] = useState(null)
  useEffect(() => {
    let alive = true
    loadSalt().then((s) => { if (alive) setSalt(s) }, () => {})
    return () => { alive = false }
  }, [])
  // Until the salt is read nothing is drawn: a line chosen without it would
  // change a moment later.
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
