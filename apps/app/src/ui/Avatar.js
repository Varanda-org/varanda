// A round avatar with the person's initials on the stripe colour picked by
// the first byte of the key. With no name it shows a person glyph instead:
// no character derived from a key is ever drawn. Decorative: the name is
// read elsewhere.

import { StyleSheet, Text, View } from 'react-native'
import { displayText } from '@varanda/rpc'
import { avatarColorOf } from '../format'
import { Icon } from './Icon'
import { colors, stripes } from './theme'

// First letter of the first and last word, or two letters of a single word;
// '' when the name is missing or blank.
function initialsFromName (name) {
  const upper = (s) => s.toLocaleUpperCase('pt-BR')
  const words = typeof name === 'string' ? name.trim().split(/\s+/).filter((w) => w !== '') : []
  if (words.length >= 2) return upper(Array.from(words[0])[0] + Array.from(words[words.length - 1])[0])
  if (words.length === 1) return upper(Array.from(words[0]).slice(0, 2).join(''))
  return ''
}

export function Avatar ({ name, publicKey, size = 44, ring = false }) {
  const stripe = stripes[avatarColorOf(publicKey)]
  const fontSize = size >= 80 ? 30 : size <= 40 ? 15 : 16
  const initials = initialsFromName(name)
  const circle = (
    <View
      style={[styles.circle, { width: size, height: size, borderRadius: size / 2, backgroundColor: stripe.bg }]}
      accessible={false}
      importantForAccessibility='no-hide-descendants'
    >
      {initials === ''
        ? <Icon name='pessoa' size={size * 0.5} color={stripe.ink} />
        : <Text style={[styles.initials, { color: stripe.ink, fontSize }]} numberOfLines={1}>{displayText(initials)}</Text>}
    </View>
  )
  if (!ring) return circle
  const outer = size + 8
  return (
    <View
      style={[styles.circle, { width: outer, height: outer, borderRadius: outer / 2, backgroundColor: colors.bg }]}
      accessible={false}
      importantForAccessibility='no-hide-descendants'
    >
      {circle}
    </View>
  )
}

const styles = StyleSheet.create({
  circle: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  initials: { fontWeight: '700' }
})
