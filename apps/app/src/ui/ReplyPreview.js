// A quoted message: a coloured bar, the author's name and up to `lines` lines
// of the text. Inside a bubble it is the reply's quote; above the composer it
// is the reply bar, with a Cancelar button when onCancel is given. `name` and
// `text` may be the peer's raw strings: both go through displayText here.
// `senderKey` picks the bar and name colour (senderColor), so a person keeps
// the same colour in quotes, name lines and avatars.
//
// Props: { name, text, senderKey, mine, onMine, onPress, onCancel, lines = 2 }
// `onMine` is a quote drawn inside the reader's own bubble.

import { Pressable, StyleSheet, Text, View } from 'react-native'
import { displayText } from '@varanda/rpc'
import { avatarColorOf } from '../format'
import { quoteText } from '../chatPreview'
import { Icon } from './Icon'
import { useStyles, useTheme } from './ThemeProvider'
import { layout, radius, space, type } from './theme'

// The avatar stripe hues (theme.js stripes, same order), tuned so a name in
// that colour stays readable as text on the card and the accent tint of each
// scheme: the stripe yellow and orange are too light for text on white.
export const SENDER_LIGHT = ['#206496', '#9b4728', '#7b5a00', '#b13025', '#1d6b4f', '#7d4470', '#0b6a71', '#a3336a']
export const SENDER_DARK = ['#7db9e8', '#f0a07f', '#f2c94c', '#ff8f87', '#5dcaa0', '#d6a0cb', '#4fd1d6', '#f49ac1']
// The same hues one step lighter, for a quote inside my own bubble in the
// dark scheme: the green bubble is lighter than the card, and several dark
// names (the accent too) fall below text contrast there.
export const SENDER_ON_MINE_DARK = ['#a6cfef', '#f5bea7', '#f2c94c', '#ffb8b3', '#8ad9bb', '#e3bfdc', '#70dade', '#f7b8d4']
// The quoted text and @nome there: the scheme's soft grey falls just short.
export const SOFT_ON_MINE_DARK = '#d0d0d0'

// -> the name colour of the person whose key starts with `key` (hex), stable
// across sessions. Anything that is not a hex key gets the accent's hue.
export function senderColor (key, scheme, onMine = false) {
  const list = scheme === 'dark' ? (onMine ? SENDER_ON_MINE_DARK : SENDER_DARK) : SENDER_LIGHT
  return list[avatarColorOf(typeof key === 'string' ? key : '')] || list[4]
}

export function ReplyPreview ({ name, handle, text, senderKey, mine, onMine = false, onPress, onLongPress, onCancel, lines = 2 }) {
  const styles = useStyles(makeStyles)
  const { colors, scheme } = useTheme()
  const onMineDark = onMine && scheme === 'dark'
  const own = mine || typeof senderKey !== 'string'
  const tint = own ? (onMineDark ? SENDER_ON_MINE_DARK[4] : colors.accent) : senderColor(senderKey, scheme, onMine)
  const shownName = typeof name === 'string' ? displayText(name).trim() : ''
  const shownText = quoteText(text)
  const body = (
    <View style={styles.body}>
      {shownName
        ? (
          <Text style={[styles.name, { color: tint }]} numberOfLines={1}>
            {shownName}
            {!mine && typeof handle === 'string' && handle !== '' ? <Text style={[styles.handle, onMineDark && { color: SOFT_ON_MINE_DARK }]}>{' ' + displayText(handle)}</Text> : null}
          </Text>
          )
        : null}
      <Text style={[styles.text, onMineDark && { color: SOFT_ON_MINE_DARK }]} numberOfLines={lines}>{shownText}</Text>
    </View>
  )
  const cancel = typeof onCancel === 'function'
  return (
    <View style={[styles.box, cancel && styles.bar]}>
      <View style={[styles.stripe, { backgroundColor: tint }]} />
      {typeof onPress === 'function'
        ? (
          <Pressable
            accessibilityRole='button'
            accessibilityLabel={(shownName ? shownName + ': ' : '') + shownText}
            accessibilityHint='mostrar a mensagem respondida'
            onPress={onPress}
            onLongPress={onLongPress}
            style={({ pressed }) => [styles.press, pressed && styles.pressed]}
          >
            {body}
          </Pressable>
          )
        : <View style={styles.press}>{body}</View>}
      {cancel
        ? (
          <Pressable
            accessibilityRole='button'
            accessibilityLabel='Cancelar'
            accessibilityHint='não responder a esta mensagem'
            onPress={onCancel}
            style={({ pressed }) => [styles.cancel, pressed && styles.pressed]}
          >
            <Icon name='fechar' size={20} color={colors.soft} />
          </Pressable>
          )
        : null}
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  box: {
    flexDirection: 'row',
    alignItems: 'stretch',
    borderRadius: radius.sm,
    backgroundColor: colors.skeleton,
    overflow: 'hidden'
  },
  bar: { alignItems: 'center' },
  stripe: { width: 3, alignSelf: 'stretch' },
  press: { flex: 1, minWidth: 0 },
  body: { paddingHorizontal: space.sm, paddingVertical: space.xs + 2, gap: 1 },
  name: { ...type.counter },
  handle: { fontWeight: '400', color: colors.soft },
  text: { fontSize: 14, lineHeight: 19, color: colors.soft },
  cancel: { width: layout.hit, height: layout.hit, alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: 0.6 }
})
