// Post text with tappable @nome mentions and links. The text is the peer's,
// so every piece goes through displayText. Links are only what ../links.js
// detected (http, https, and www opened as https), each href checked again
// with isHttpUrl, and they open through ../openExternal with no confirmation.
// Without an onOpenMention handler mentions stay plain but links still open;
// with numberOfLines set links are always plain; with neither a mention nor a
// link it is exactly one plain <Text>.
//
// #tags are tappable only when the caller passes hashtags AND App.js provides
// an opener through HashtagContext (it does only on a hosted node). Both are
// needed so a private surface (DM, group) can never turn its text into a
// public topic link by accident: only the public post call sites pass it.
// With numberOfLines set they stay plain, as links do. A tag span is an
// inline link, like a mention: its target is the glyph box, not 44 pt.
//
// Props: text (raw), onOpenMention(username), onOpenPlain (tap on the plain
// parts), numberOfLines, style, selectable (all applied to the parent Text)
// and hashtags (true at the public post call site only).

import { createContext, useContext } from 'react'
import { StyleSheet, Text } from 'react-native'
import { displayText } from '@varanda/rpc'
import { isHttpUrl, textSegments } from '../links'
import { linkProps } from '../openExternal'
import { useStyles } from './ThemeProvider'

// openTag(token): provided by App.js on a hosted node only; undefined elsewhere.
export const HashtagContext = createContext(undefined)

// The opener to use for a `hashtags` prop: a function only when the prop is
// exactly true and the context holds one.
export function useHashtagOpen (hashtags) {
  const open = useContext(HashtagContext)
  return hashtags === true && typeof open === 'function' ? open : undefined
}

export function hasHashtag (text) {
  return textSegments(text, { hashtags: true }).some((segment) => typeof segment.tag === 'string')
}

// Same segmentation as the renderer, so an @nome inside a link (not tappable
// here) never pulls a quote or post out of its own Pressable.
export function hasMention (text) {
  return textSegments(text, { mentions: true }).some((segment) => segment.username !== null)
}

export function MentionText ({ text, onOpenMention, onOpenPlain, onLongPress, numberOfLines, onTextLayout, style, selectable, hashtags }) {
  // A clamp can hide part of a URL, so the visible prefix would open another site.
  const links = typeof numberOfLines !== 'number'
  // Tags stay plain under a clamp too, like links, so a clamped text has one rule.
  const contextTag = useHashtagOpen(hashtags)
  const openTag = links ? contextTag : undefined
  const segments = textSegments(text, { mentions: typeof onOpenMention === 'function', hashtags: openTag !== undefined })
  const plain = typeof onOpenPlain === 'function' ? onOpenPlain : undefined
  if (!segments.some((segment) => segment.username !== null || (links && segment.href !== null) || (openTag !== undefined && typeof segment.tag === 'string'))) {
    return <Text style={style} numberOfLines={numberOfLines} onTextLayout={onTextLayout} selectable={selectable} onPress={plain} onLongPress={onLongPress}>{displayText(text, { multiline: true })}</Text>
  }
  return (
    <Text style={style} numberOfLines={numberOfLines} onTextLayout={onTextLayout} selectable={selectable}>
      {segments.map((segment, i) => <SegmentSpan key={i} segment={segment} onOpenMention={onOpenMention} onOpenPlain={plain} onLongPress={onLongPress} links={links} onOpenTag={openTag} />)}
    </Text>
  )
}

// One precomputed textSegments entry, drawn exactly as MentionText draws it.
// The segment must come from textSegments on the raw text: RichText passes
// its atoms here so a styled substring is never segmented again.
export function SegmentSpan ({ segment, onOpenMention, onOpenPlain, onLongPress, links = true, onOpenTag }) {
  const styles = useStyles(makeStyles)
  const plain = typeof onOpenPlain === 'function' ? onOpenPlain : undefined
  if (segment.username !== null && typeof onOpenMention === 'function') {
    return (
      <Text
        style={styles.mention}
        accessible
        accessibilityRole='link'
        accessibilityLabel={'abrir o perfil de @' + segment.username}
        onLongPress={onLongPress}
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
  if (typeof segment.tag === 'string' && typeof onOpenTag === 'function') {
    const tag = segment.tag
    return (
      <Text
        style={styles.mention}
        accessible
        accessibilityRole='link'
        accessibilityLabel={'Abrir assunto #' + tag}
        onLongPress={onLongPress}
        onPress={(e) => {
          if (e && e.stopPropagation) e.stopPropagation()
          onOpenTag(tag)
        }}
        onKeyDown={(e) => {
          if ((e.key !== 'Enter' && e.key !== ' ') || e.ctrlKey || e.metaKey || e.altKey) return
          if (e.preventDefault) e.preventDefault()
          if (e.stopPropagation) e.stopPropagation()
          onOpenTag(tag)
        }}
      >
        {displayText(segment.text)}
      </Text>
    )
  }
  if (!links || segment.href === null || !isHttpUrl(segment.href)) {
    return <Text onPress={plain} onLongPress={onLongPress}>{displayText(segment.text, { multiline: true })}</Text>
  }
  const href = segment.href
  const link = linkProps(href)
  return (
    <Text
      style={styles.link}
      accessible
      accessibilityRole='link'
      accessibilityLabel={'abrir ' + href}
      accessibilityHint='abre no navegador'
      href={link.href}
      hrefAttrs={link.hrefAttrs}
      onLongPress={onLongPress}
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
}

const makeStyles = (colors) => StyleSheet.create({
  mention: { color: colors.accent },
  link: { color: colors.accent, textDecorationLine: 'underline' }
})
