// The top bar of a tab or a pushed screen: the chair mark (or, with
// `onBack`, a 'voltar' button in its place), the title, an optional
// `subtitle` under it and an optional right slot. Callers pass display-safe
// text (displayText) as title and subtitle. `right` takes a node (the older
// text pills keep working) or { icon, label, onPress, badge } actions, alone
// or in a list, each drawn as a 44 pt icon button.

import { isValidElement } from 'react'
import { Image, Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Icon } from './Icon'
import { useStyles, useTheme } from './ThemeProvider'
import { IconAction } from './TopActions'
import { fonts, layout, space, type } from './theme'

const mark = require('../../assets/cadeira.png')

function isAction (item) {
  return !!item && typeof item === 'object' && !isValidElement(item) && typeof item.icon === 'string'
}

function rightSlot (right, styles) {
  if (isAction(right)) return <IconAction {...right} />
  if (!Array.isArray(right)) return right || null
  const items = right.filter(Boolean)
  if (items.length === 0) return null
  return (
    <View style={styles.actions}>
      {items.map((item, i) => isAction(item)
        ? <IconAction key={'a' + i + ':' + item.icon} {...item} />
        : <View key={'n' + i}>{item}</View>)}
    </View>
  )
}

export function TopBar ({ title, subtitle, right, onBack, leading, onTitlePress, titleLabel }) {
  const styles = useStyles(makeStyles)
  const { colors, scheme } = useTheme()
  const insets = useSafeAreaInsets()
  // cadeira.png draws its frame in ink, which vanishes on the dark bar: there
  // it sits on a cream disc, as on the splash.
  const markNode = scheme === 'dark'
    ? <View style={styles.markDisc}><Image source={mark} style={styles.markOnDisc} accessibilityLabel='Varanda' /></View>
    : <Image source={mark} style={styles.mark} accessibilityLabel='Varanda' />
  return (
    <View style={[styles.bar, { paddingTop: insets.top, minHeight: layout.topBar + insets.top }]}>
      {typeof onBack === 'function'
        ? (
          <Pressable
            accessibilityRole='button'
            accessibilityLabel='voltar'
            onPress={onBack}
            style={({ pressed }) => [styles.back, pressed && styles.pressed]}
          >
            <Icon name='voltar' size={28} color={colors.ink} />
          </Pressable>
          )
        : markNode}
      {leading || null}
      {typeof onTitlePress === 'function'
        ? (
          <Pressable
            accessibilityRole='button'
            accessibilityLabel={typeof title === 'string' ? title : undefined}
            accessibilityHint={titleLabel || 'abrir'}
            onPress={onTitlePress}
            style={({ pressed }) => [styles.titles, pressed && styles.pressed]}
          >
            <Text style={styles.title} numberOfLines={2} accessibilityRole='header'>{title}</Text>
            {subtitle ? <Text style={styles.subtitle} numberOfLines={1}>{subtitle}</Text> : null}
          </Pressable>
          )
        : (
          <View style={styles.titles}>
            <Text style={styles.title} numberOfLines={2} accessibilityRole='header'>{title}</Text>
            {subtitle ? <Text style={styles.subtitle} numberOfLines={1}>{subtitle}</Text> : null}
          </View>
          )}
      {rightSlot(right, styles)}
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingLeft: space.lg,
    // Icon buttons carry their own 44 pt target, so the edge keeps less.
    paddingRight: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
    backgroundColor: colors.bg
  },
  mark: { width: 32, height: 32 },
  markDisc: { width: 32, height: 32, borderRadius: 16, backgroundColor: '#fbf8f3', alignItems: 'center', justifyContent: 'center' },
  markOnDisc: { width: 24, height: 24 },
  // A 44 pt target whose arrow still lines up with the mark on the tabs.
  back: { width: layout.hit, height: layout.hit, alignItems: 'center', justifyContent: 'center', marginLeft: -10, marginRight: -6 },
  actions: { flexDirection: 'row', alignItems: 'center' },
  pressed: { opacity: 0.6 },
  titles: { flex: 1, minWidth: 0 },
  title: { ...type.barTitle, fontFamily: fonts.title, color: colors.ink },
  subtitle: { ...type.replyMark, color: colors.soft }
})
