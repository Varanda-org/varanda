// Shared progress, a hero (icon disc, spinner or caller node), one title,
// one line, the body and low actions make every onboarding step read alike.
// Presentational only; callers pass text that is already safe to render.

import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Spinner } from './index'
import { Icon } from './Icon'
import { useStyles, useTheme } from './ThemeProvider'
import { fonts, layout, space, type } from './theme'

export function Stepper ({ index, total, title, hint, icon, busy, hero, actions, children }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  const dots = []
  if (typeof total === 'number') {
    for (let i = 0; i < total; i++) {
      dots.push(<View key={i} importantForAccessibility='no' accessibilityElementsHidden style={[styles.dot, i === index ? styles.dotActive : i < index ? styles.dotDone : styles.dotPending]} />)
    }
  }
  return (
    <View style={styles.column}>
      <View style={styles.header}>
        {typeof total === 'number'
          ? (
            // no-hide-descendants would hide this labelled view from TalkBack too,
            // so each dot hides itself instead.
            <View style={styles.dots} accessible accessibilityLabel={'Passo ' + (index + 1) + ' de ' + total}>{dots}</View>
            )
          : null}
        {hero !== undefined
          ? hero
          : busy
            ? (
              <View style={styles.disc} accessible accessibilityLabel='Carregando'><Spinner /></View>
              )
            : icon
              ? (
                <View style={styles.disc}><Icon name={icon} size={32} color={colors.accent} /></View>
                )
              : null}
        <Text accessibilityRole='header' style={styles.title}>{title}</Text>
        {typeof hint === 'string' && hint !== '' ? <Text style={styles.hint}>{hint}</Text> : null}
      </View>
      <View style={styles.body}>{children}</View>
      {actions
        ? (
          <>
            <View style={styles.spacer} />
            <View style={styles.actions}>{actions}</View>
          </>
          )
        : null}
    </View>
  )
}

export function StepLink ({ label, onPress, disabled }) {
  const styles = useStyles(makeStyles)
  return (
    <Pressable
      accessibilityRole='button'
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.link, pressed && styles.linkPressed, disabled && styles.off]}
    >
      <Text style={styles.linkText}>{label}</Text>
    </Pressable>
  )
}

export function StepNotice ({ children }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  if (children === null || children === undefined || children === false || children === '') return null
  return (
    <View style={styles.notice}>
      <Icon name='info' size={16} color={colors.warn} />
      <View style={styles.noticeText}>{children}</View>
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  column: { width: '100%', maxWidth: 400, alignSelf: 'center', paddingHorizontal: space.xl, paddingTop: space.lg, flexGrow: 1, gap: space.md },
  header: { alignItems: 'center', gap: space.sm },
  dots: { flexDirection: 'row', justifyContent: 'center', gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  dotActive: { backgroundColor: colors.accent },
  dotDone: { backgroundColor: colors.accent, opacity: 0.5 },
  dotPending: { backgroundColor: colors.line },
  disc: { width: 72, height: 72, borderRadius: 36, backgroundColor: colors.accentSoft, alignItems: 'center', justifyContent: 'center' },
  title: { ...type.heroTitle, fontFamily: fonts.title, color: colors.ink, textAlign: 'center' },
  hint: { fontSize: 16, lineHeight: 22, color: colors.soft, textAlign: 'center' },
  body: { gap: space.md },
  spacer: { flexGrow: 1, minHeight: space.lg },
  actions: { gap: space.sm },
  link: { minHeight: layout.hit, alignSelf: 'center', justifyContent: 'center', paddingHorizontal: space.md },
  linkPressed: { opacity: 0.6 },
  off: { opacity: 0.45 },
  linkText: { ...type.pill, color: colors.accent, textAlign: 'center' },
  notice: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm },
  noticeText: { flex: 1, gap: space.sm }
})
