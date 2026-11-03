// Post text with tappable @nome mentions and links. The text is the peer's,
// so every piece goes through displayText. Links are only what ../links.js
// detected (http, https, and www opened as https), each href checked again
// with isHttpUrl, and they open through ../openExternal with no confirmation.
// Without an onOpenMention handler mentions stay plain but links still open;
// with numberOfLines set links are always plain; with neither a mention nor a
// link it is exactly one plain <Text>.
//
// Props: text (raw), onOpenMention(username), onOpenPlain (tap on the plain
// parts), numberOfLines, style and selectable (all applied to the parent Text).

import { StyleSheet, Text } from 'react-native'
import { displayText } from '@varanda/rpc'
import { isHttpUrl, textSegments } from '../links'
import { linkProps } from '../openExternal'
import { colors } from './theme'

// Same segmentation as the renderer, so an @nome inside a link (not tappable
// here) never pulls a quote or post out of its own Pressable.
export function hasMention (text) {
  return textSegments(text, { mentions: true }).some((segment) => segment.username !== null)
}

export function MentionText ({ text, onOpenMention, onOpenPlain, numberOfLines, style, selectable }) {
  const segments = textSegments(text, { mentions: typeof onOpenMention === 'function' })
  // A clamp can hide part of a URL, so the visible prefix would open another site.
  const links = typeof numberOfLines !== 'number'
  const plain = typeof onOpenPlain === 'function' ? onOpenPlain : undefined
  if (!segments.some((segment) => segment.username !== null || (links && segment.href !== null))) {
    return <Text style={style} numberOfLines={numberOfLines} selectable={selectable} onPress={plain}>{displayText(text, { multiline: true })}</Text>
  }
  return (
    <Text style={style} numberOfLines={numberOfLines} selectable={selectable}>
      {segments.map((segment, i) => {
        if (segment.username !== null) {
          return (
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
          )
        }
        if (!links || segment.href === null || !isHttpUrl(segment.href)) {
          return <Text key={i} onPress={plain}>{displayText(segment.text, { multiline: true })}</Text>
        }
        const href = segment.href
        const link = linkProps(href)
        return (
          <Text
            key={i}
            style={styles.link}
            accessible
            accessibilityRole='link'
            accessibilityLabel={'abrir ' + href}
            accessibilityHint='abre no navegador'
            href={link.href}
            hrefAttrs={link.hrefAttrs}
            onPress={(e) => {
              // On web the anchor navigates by itself, so opening here too
              // would open the page twice.
              if (e && e.stopPropagation) e.stopPropagation()
              if (typeof link.onPress === 'function') link.onPress()
            }}
            onKeyDown={(e) => {
              // The anchor activates on Enter natively; a parent must not react too.
              if (e.key === 'Enter' && e.stopPropagation) e.stopPropagation()
            }}
          >
            {displayText(segment.text)}
          </Text>
        )
      })}
    </Text>
  )
}

const styles = StyleSheet.create({
  mention: { color: colors.accent },
  link: { color: colors.accent, textDecorationLine: 'underline' }
})
