// Composer @ suggestions: up to MENTION_SUGGESTIONS_MAX verified members under
// the compose box. Rows arrive already confirmed by diary.peek
// (../useMemberSearch), so the name and @nome are the member's own signed
// fields; both still go through displayText. Never a count, never a raw key.

import { Pressable, StyleSheet, Text, View } from 'react-native'
import { displayText } from '@varanda/rpc'
import { whoOf } from '../who'
import { Soft } from '../ui'
import { Avatar } from './Avatar'
import { colors, type } from './theme'

export function MentionSuggest ({ rows, loading, onPick }) {
  if (rows.length === 0 && !loading) return null
  return (
    <View style={styles.box} accessibilityLabel='sugestões de menção'>
      {rows.map((hit) => (
        <Pressable
          key={hit.author}
          accessibilityRole='button'
          accessibilityLabel={'mencionar @' + hit.username}
          onPress={() => onPick(hit)}
          style={({ pressed }) => [styles.row, pressed && styles.pressed]}
        >
          <Avatar name={hit.name || hit.username || null} publicKey={hit.author} size={32} />
          <View style={styles.text}>
            <Text style={styles.title} numberOfLines={1}>{displayText(whoOf({ name: hit.name, username: hit.username }).title)}</Text>
            <Text style={styles.handle} numberOfLines={1}>{'@' + displayText(hit.username)}</Text>
          </View>
        </Pressable>
      ))}
      {loading ? <View style={styles.loading}><Soft>procurando...</Soft></View> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  box: { paddingHorizontal: 16, paddingVertical: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44, paddingVertical: 4 },
  pressed: { opacity: 0.6 },
  text: { flex: 1 },
  title: { ...type.postName, color: colors.ink },
  handle: { color: colors.soft, fontSize: 13 },
  loading: { paddingVertical: 6 }
})
