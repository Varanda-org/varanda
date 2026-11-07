// A quoted message: a coloured bar, the author's name and up to `lines` lines
// of the text. Inside a bubble it is the reply's quote; above the composer it
// is the reply bar, with a Cancelar button when onCancel is given. `name` and
// `text` may be the peer's raw strings: both go through displayText here.
// `senderKey` picks the bar and name colour (senderColor), so a person keeps
// the same colour in quotes, name lines and avatars.
//
// Props: { name, text, senderKey, mine, onPress, onCancel, lines = 2 }

import { Pressable, StyleSheet, Text, View } from 'react-native'
import { displayText } from '@varanda/rpc'
import { avatarColorOf } from '../format'
import { Icon } from './Icon'
import { useStyles, useTheme } from './ThemeProvider'
import { layout, radius, space, type } from './theme'

// The avatar stripe hues (theme.js stripes, same order), tuned so a name in
// that colour stays readable as text on the card and the accent tint of each
// scheme: the stripe yellow and orange are too light for text on white.
const SENDER_LIGHT = ['#2576b0', '#b4532f', '#8a6500', '#c23528', '#1d6b4f']
const SENDER_DARK = ['#7db9e8', '#f0a07f', '#f2c94c', '#ff8f87', '#5dcaa0']

// -> the name colour of the person whose key starts with `key` (hex), stable
// across sessions. Anything that is not a hex key gets the accent's hue.
export function senderColor (key, scheme) {
  const list = scheme === 'dark' ? SENDER_DARK : SENDER_LIGHT
  return list[avatarColorOf(typeof key === 'string' ? key : '')] || list[4]
}

export function ReplyPreview ({ name, handle, text, senderKey, mine, onPress, onLongPress, onCancel, lines = 2 }) {
  const styles = useStyles(makeStyles)
  const { colors, scheme } = useTheme()
  const tint = mine || typeof senderKey !== 'string' ? colors.accent : senderColor(senderKey, scheme)
  const shownName = typeof name === 'string' ? displayText(name).trim() : ''
  const shownText = typeof text === 'string' ? displayText(text, { multiline: true }) : ''
  const body = (
    <View style={styles.body}>
      {shownName
        ? (
          <Text style={[styles.name, { color: tint }]} numberOfLines={1}>
            {shownName}
            {!mine && typeof handle === 'string' && handle !== '' ? <Text style={styles.handle}>{' ' + displayText(handle)}</Text> : null}
          </Text>
          )
        : null}
      <Text style={styles.text} numberOfLines={lines}>{shownText}</Text>
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
