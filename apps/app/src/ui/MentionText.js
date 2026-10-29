// Post text with tappable @nome mentions. The text is the peer's, so every
// piece goes through displayText. Without an onOpenMention handler, or when
// the text has no mention, it is exactly one plain <Text>, as before.
//
// Props: text (raw), onOpenMention(username), onOpenPlain (tap on the plain
// parts), numberOfLines and style (both applied to the parent Text).

import { StyleSheet, Text } from 'react-native'
import { displayText, mentionSegments } from '@varanda/rpc'
import { colors } from './theme'

export function hasMention (text) {
  return mentionSegments(text).some((segment) => segment.username !== null)
}

export function MentionText ({ text, onOpenMention, onOpenPlain, numberOfLines, style }) {
  const segments = typeof onOpenMention === 'function' ? mentionSegments(text) : []
  if (!segments.some((segment) => segment.username !== null)) {
    return <Text style={style} numberOfLines={numberOfLines}>{displayText(text, { multiline: true })}</Text>
  }
  const plain = typeof onOpenPlain === 'function' ? onOpenPlain : undefined
  return (
    <Text style={style} numberOfLines={numberOfLines}>
      {segments.map((segment, i) => segment.username === null
        ? <Text key={i} onPress={plain}>{displayText(segment.text, { multiline: true })}</Text>
        : (
          <Text
            key={i}
            style={styles.mention}
            accessible
            accessibilityRole='link'
            accessibilityLabel={'abrir o perfil de @' + segment.username}
            onPress={(e) => {
              if (e && e.stopPropagation) e.stopPropagation()
              onOpenMention(segment.username)
            }}
            onKeyDown={(e) => {
              // react-native-web Text maps onPress to click only.
              if ((e.key !== 'Enter' && e.key !== ' ') || e.ctrlKey || e.metaKey || e.altKey) return
              if (e.preventDefault) e.preventDefault()
              if (e.stopPropagation) e.stopPropagation()
              onOpenMention(segment.username)
            }}
          >
            {displayText(segment.text)}
          </Text>
          ))}
    </Text>
  )
}

const styles = StyleSheet.create({
  mention: { color: colors.accent }
})
