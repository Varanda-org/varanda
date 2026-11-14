// The top bar of a tab or a pushed screen: the chair mark (or, with
// `onBack`, a 'voltar' button in its place), the title, an optional
// `subtitle` under it and an optional right slot. Callers pass display-safe
// text (displayText) as title and subtitle; `compact` sets the chat title
// size. `right` takes a node (the older text pills keep working) or
// { icon, label, onPress, badge } actions, alone or in a list. Actions alone
// share one ActionCapsule of 44 pt icon buttons; a list mixed with nodes
// draws them in a plain row.

import { isValidElement } from 'react'
import { Image, Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Icon } from './Icon'
import { useStyles, useTheme } from './ThemeProvider'
import { ActionCapsule, IconAction } from './TopActions'
import { fonts, layout, space, type } from './theme'

const mark = require('../../assets/cadeira.png')

// One line that shrinks to fit (native) or ends in an ellipsis (web): two
// lines split a one-word title like "Conversas" inside the word at large text.
const TITLE_FIT = { numberOfLines: 1, adjustsFontSizeToFit: true, minimumFontScale: 0.6, maxFontSizeMultiplier: 1.3 }

function isAction (item) {
  return !!item && typeof item === 'object' && !isValidElement(item) && typeof item.icon === 'string'
}

function rightSlot (right, styles) {
  if (isAction(right)) return <ActionCapsule><IconAction {...right} /></ActionCapsule>
  if (!Array.isArray(right)) return right || null
  const items = right.filter(Boolean)
  if (items.length === 0) return null
  const body = items.map((item, i) => isAction(item)
    ? <IconAction key={'a' + i + ':' + item.icon} {...item} />
    : <View key={'n' + i}>{item}</View>)
  if (items.every(isAction)) return <ActionCapsule>{body}</ActionCapsule>
  return <View style={styles.actions}>{body}</View>
}

export function TopBar ({ title, subtitle, right, onBack, leading, onTitlePress, titleLabel, compact }) {
  const styles = useStyles(makeStyles)
  const { colors, scheme } = useTheme()
  const titleStyle = compact ? [styles.title, styles.titleCompact] : styles.title
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
            <Icon name='voltar' size={22} color={colors.ink} />
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
            <Text style={titleStyle} {...TITLE_FIT} accessibilityRole='header'>{title}</Text>
            {subtitle ? <Text style={styles.subtitle} numberOfLines={1}>{subtitle}</Text> : null}
          </Pressable>
          )
        : (
          <View style={styles.titles}>
            <Text style={titleStyle} {...TITLE_FIT} accessibilityRole='header'>{title}</Text>
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
    paddingRight: space.lg,
    backgroundColor: colors.bg
  },
  mark: { width: 32, height: 32 },
  markDisc: { width: 32, height: 32, borderRadius: 16, backgroundColor: '#fbf8f3', alignItems: 'center', justifyContent: 'center' },
  markOnDisc: { width: 24, height: 24 },
  back: { width: layout.hit, height: layout.hit, borderRadius: layout.hit / 2, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line },
  actions: { flexDirection: 'row', alignItems: 'center' },
  pressed: { opacity: 0.6 },
  titles: { flex: 1, minWidth: 0 },
  title: { ...type.barTitle, fontFamily: fonts.title, color: colors.ink },
  titleCompact: { ...type.threadTitle },
  subtitle: { ...type.replyMark, color: colors.soft }
})
