// ReactionPicker: the full emoji sheet.
// WhoReacted rows are { emoji, names: string[], count }. Each name is its
// own line under the emoji, inside the sheet scroll. A longer count adds
// "e mais N". No names: "N pessoas" (or "1 pessoa"). Names come from peers,
// so each line goes through displayText before it is drawn.

import { ScrollView, StyleSheet, Text, View } from 'react-native'
import { displayText } from '@varanda/rpc'
import { whoLines } from '../reactions'
import { EmojiPicker } from './EmojiPicker'
import { Sheet } from './Sheet'
import { useStyles } from './ThemeProvider'
import { space, type } from './theme'

function namesOf (row) {
  if (!row || typeof row !== 'object' || !Array.isArray(row.names)) return []
  return row.names.filter((name) => typeof name === 'string')
}

export function ReactionPicker ({ open, onClose, onPick }) {
  const pick = (emoji) => {
    if (typeof onPick === 'function') onPick(emoji)
  }
  return (
    <Sheet open={open} onClose={onClose} title='Reações'>
      <EmojiPicker open={!!open} onPick={pick} />
    </Sheet>
  )
}

export function WhoReacted ({ open, onClose, rows }) {
  const styles = useStyles(makeStyles)
  const list = Array.isArray(rows) ? rows : []
  return (
    <Sheet open={open} onClose={onClose} title='Quem reagiu'>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.list} keyboardShouldPersistTaps='handled'>
        {list.map((row, i) => {
          const emoji = displayText(row && typeof row.emoji === 'string' ? row.emoji : '')
          const count = row && Number.isSafeInteger(row.count) ? row.count : undefined
          const lines = whoLines(namesOf(row), count).map((line) => displayText(line))
          if (emoji === '' && lines.length === 0) return null
          return (
            <View key={i + ':' + emoji} style={styles.whoBlock}>
              {emoji !== '' ? <Text style={styles.whoEmoji}>{emoji}</Text> : null}
              {lines.map((line, j) => (
                <Text key={j} style={styles.whoLine}>{line}</Text>
              ))}
            </View>
          )
        })}
      </ScrollView>
    </Sheet>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  scroll: { flex: 1 },
  list: { paddingBottom: space.lg },
  whoBlock: {
    gap: space.xs,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line
  },
  whoEmoji: { fontSize: 22, lineHeight: 28 },
  whoLine: { ...type.postMeta, color: colors.ink }
})
