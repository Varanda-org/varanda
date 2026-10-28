// The top bar of a tab or a pushed screen: the chair mark (or, with
// `onBack`, a 'voltar' button in its place), the title, an optional
// `subtitle` under it and an optional right slot. Callers pass display-safe
// text (displayText) as title and subtitle.

import { Image, Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Icon } from './Icon'
import { colors, fonts, layout, type } from './theme'

const mark = require('../../assets/cadeira.png')

export function TopBar ({ title, subtitle, right, onBack }) {
  const insets = useSafeAreaInsets()
  return (
    <View style={[styles.bar, { paddingTop: insets.top, minHeight: layout.topBar + insets.top }]}>
      {typeof onBack === 'function'
        ? (
          <Pressable
            accessibilityRole='button'
            accessibilityLabel='voltar'
            hitSlop={10}
            onPress={onBack}
            style={({ pressed }) => [styles.back, pressed && styles.pressed]}
          >
            <Icon name='voltar' size={28} color={colors.ink} />
          </Pressable>
          )
        : <Image source={mark} style={styles.mark} accessibilityLabel='Varanda' />}
      <View style={styles.titles}>
        <Text style={styles.title} numberOfLines={2} accessibilityRole='header'>{title}</Text>
        {subtitle ? <Text style={styles.subtitle} numberOfLines={1}>{subtitle}</Text> : null}
      </View>
      {right || null}
    </View>
  )
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
    backgroundColor: colors.bg
  },
  mark: { width: 32, height: 32 },
  back: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center', marginLeft: -4 },
  pressed: { opacity: 0.6 },
  titles: { flex: 1, minWidth: 0 },
  title: { ...type.barTitle, fontFamily: fonts.title, color: colors.ink },
  subtitle: { ...type.replyMark, color: colors.soft }
})
