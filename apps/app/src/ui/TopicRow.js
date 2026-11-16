// One topic of a public group (forum.js topicList row): the title, who opened
// it, how many replies and the last reply, and a mark when it carries a poll.
// The whole row is one 44 pt (or taller) target. Peer text goes through
// displayText; the name comes from the names cache, never from the row.

import { useEffect } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { displayText } from '@varanda/rpc'
import { useNames } from '../names'
import { UNNAMED, whoOf } from '../who'
import { Icon } from './Icon'
import { useStyles, useTheme } from './ThemeProvider'
import { layout, space, type } from './theme'

// row: { key, diary, title, replies (null when not known), lastReplyLabel, poll? }
export function TopicRow ({ row, onPress }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  const names = useNames()
  const resolve = names ? names.resolve : null
  const diary = typeof row.diary === 'string' ? row.diary : null
  useEffect(() => {
    if (resolve && diary !== null) resolve(diary)
  }, [resolve, diary])
  const cached = names && diary !== null ? names.profileOf(diary) : undefined
  const who = whoOf({ name: cached ? cached.name : null, username: cached ? cached.username : null }).title
  const author = who === UNNAMED ? 'Pessoa' : displayText(who)
  const title = displayText(row.title)
  const n = Number.isSafeInteger(row.replies) && row.replies >= 0 ? row.replies : null
  const count = n === null ? '' : n === 1 ? '1 resposta' : n + ' respostas'
  const line = [author, count, row.lastReplyLabel].filter((x) => typeof x === 'string' && x !== '').join(' · ')
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole='button'
      accessibilityLabel={'tópico: ' + title + (row.poll ? ', com enquete' : '') + '. ' + line}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <View style={styles.text}>
        <Text style={styles.title} numberOfLines={2} maxFontSizeMultiplier={1.3}>{title}</Text>
        <Text style={styles.line} numberOfLines={2} maxFontSizeMultiplier={1.3}>{line}</Text>
      </View>
      {row.poll ? <Icon name='enquete' size={18} color={colors.soft} /> : null}
    </Pressable>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: layout.hit,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line
  },
  pressed: { opacity: 0.6 },
  text: { flex: 1, gap: 2 },
  title: { ...type.postName, color: colors.ink },
  line: { ...type.meta, color: colors.soft }
})
