// The notice a device that just received a history copy shows at the top of
// Conversas (texts and state: ../historyCopy.js). The copy itself needs no
// tap: the node makes it in the background.

import { useSyncExternalStore } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { copyStore, IMPORTED_DISMISS, IMPORTED_TITLE, importedText } from '../historyCopy'
import { Soft } from '../ui'
import { Pill } from './Pill'
import { useStyles } from './ThemeProvider'
import { radius, space, type } from './theme'

export function HistoryImportedNote () {
  const styles = useStyles(makeStyles)
  const { imported } = useSyncExternalStore(copyStore.subscribe, copyStore.get, copyStore.get)
  if (imported === null) return null
  return (
    <View style={styles.note} accessible accessibilityLiveRegion='polite'>
      <Text style={styles.noteTitle}>{IMPORTED_TITLE}</Text>
      <Soft>{importedText(imported)}</Soft>
      <Pill label={IMPORTED_DISMISS} small onPress={() => copyStore.clearImported()} />
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  note: { marginHorizontal: space.lg, marginVertical: space.sm, padding: space.md, gap: space.sm, borderRadius: radius.sm, backgroundColor: colors.card },
  noteTitle: { ...type.more, color: colors.ink }
})
