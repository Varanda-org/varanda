// Loading, empty and error states for lists and screens, the list footer
// and the "new items" pill. Presentational only: callers pass text that has
// already gone through displayText / errorText. No counts, no media.

import { useEffect, useRef, useState } from 'react'
import { Animated, Platform, Pressable, StyleSheet, Text, View } from 'react-native'
import { ErrorText, Soft, Spinner } from './index'
import { Icon } from './Icon'
import { loopTiming } from './loopMotion'
import { Pill } from './Pill'
import { useReduceMotion } from './StackLayer'
import { useStyles, useTheme } from './ThemeProvider'
import { elevation, layout, motion, radius, space, type } from './theme'

// The native driver is a platform API react-native-web does not have (it warns
// and falls back), so this picks the driver, never the behaviour.
const native = Platform.OS !== 'web'

// One value for every skeleton. A loop per mount kept a hidden tab's
// placeholder counting as an interaction, so lists stayed on their first
// rows (see loopMotion). The loop runs only while a skeleton that may move
// is mounted.
const pulse = new Animated.Value(0.5)
let pulseMounts = 0
let pulseLoop = null

function startSharedPulse () {
  pulseMounts += 1
  if (pulseMounts !== 1) return
  pulseLoop = Animated.loop(Animated.sequence([
    Animated.timing(pulse, loopTiming({ toValue: 1, duration: 600, useNativeDriver: native })),
    Animated.timing(pulse, loopTiming({ toValue: 0.5, duration: 600, useNativeDriver: native }))
  ]))
  pulseLoop.start()
}

function stopSharedPulse () {
  pulseMounts -= 1
  if (pulseMounts !== 0 || pulseLoop === null) return
  pulseLoop.stop()
  pulseLoop = null
  // The next mount starts the fade from the resting opacity.
  pulse.setValue(0.5)
}

// Placeholders that share one pulse while the first page loads.
export function Skeleton ({ rows = 3, children }) {
  const styles = useStyles(makeStyles)
  const reduce = useReduceMotion()
  useEffect(() => {
    if (reduce) return
    startSharedPulse()
    return stopSharedPulse
  }, [reduce])
  const items = []
  const count = children === undefined ? rows : 0
  for (let i = 0; i < count; i++) {
    items.push(
      <View key={i} style={styles.skRow}>
        <View style={styles.skAvatar} />
        <View style={styles.skLines}>
          <View style={[styles.skBar, { width: '60%' }]} />
          <View style={[styles.skBar, { width: '90%' }]} />
        </View>
      </View>
    )
  }
  // A pulse is motion, so reduced motion draws the same blocks still.
  const Block = reduce ? View : Animated.View
  return (
    <Block style={reduce ? null : { opacity: pulse }} accessible={false} importantForAccessibility='no-hide-descendants'>
      {children === undefined ? items : children}
    </Block>
  )
}

export function SkeletonProfile () {
  const styles = useStyles(makeStyles)
  return (
    <Skeleton>
      <View style={styles.skProfile}>
        <View style={styles.skBand} />
        <View style={styles.skProfileHead}>
          <View style={styles.skProfileRing}>
            <View style={styles.skProfileAvatar} />
          </View>
        </View>
        <View style={styles.skProfileLines}>
          <View style={[styles.skBar, { width: '48%' }]} />
          <View style={[styles.skBar, { width: '32%' }]} />
          <View style={[styles.skBar, { width: '90%' }]} />
          <View style={styles.skProfileCounts}>
            <View style={[styles.skBar, { width: 72 }]} />
            <View style={[styles.skBar, { width: 88 }]} />
          </View>
        </View>
      </View>
    </Skeleton>
  )
}

export function SkeletonMedia () {
  const styles = useStyles(makeStyles)
  return (
    <Skeleton>
      <View style={styles.skMediaWrap}>
        <View style={styles.skMedia} />
      </View>
    </Skeleton>
  )
}

export function SkeletonRow () {
  return <Skeleton rows={1} />
}

export function SkeletonTile () {
  const styles = useStyles(makeStyles)
  return (
    <Skeleton>
      <View style={styles.skTile}>
        <View style={styles.skImage} />
        <View style={[styles.skBar, { width: '80%' }]} />
        <View style={[styles.skBar, { width: '45%' }]} />
      </View>
    </Skeleton>
  )
}

export function SkeletonBubble () {
  const styles = useStyles(makeStyles)
  return (
    <Skeleton>
      <View style={styles.skBubble} />
    </Skeleton>
  )
}

export function EmptyState ({ icon, title, body, actionLabel, onAction, secondaryLabel, onSecondary }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  return (
    <View style={styles.empty}>
      {icon ? <Icon name={icon} size={40} color={colors.soft} /> : null}
      <Text style={styles.emptyTitle} accessibilityRole='header'>{title}</Text>
      {body ? <Soft style={styles.emptyBody}>{body}</Soft> : null}
      {actionLabel && onAction ? <Pill label={actionLabel} onPress={onAction} filled /> : null}
      {secondaryLabel && onSecondary ? <Pill label={secondaryLabel} onPress={onSecondary} /> : null}
    </View>
  )
}

export function ErrorState ({ message, onRetry, pending }) {
  const styles = useStyles(makeStyles)
  return (
    <View style={styles.empty}>
      <ErrorText>{message}</ErrorText>
      {onRetry ? <Pill label='Tentar de novo' onPress={onRetry} pending={pending} /> : null}
    </View>
  )
}

// The end of a paged list: a spinner while loading, a closing line at the
// end, or an error with a retry.
export function ListFooter ({ loading, atEnd, endText = 'Isso é tudo por enquanto.', error, onRetry, pending }) {
  const styles = useStyles(makeStyles)
  let content = null
  if (error) {
    content = (
      <>
        <ErrorText>{error}</ErrorText>
        {onRetry ? <Pill label='Tentar de novo' onPress={onRetry} pending={pending} /> : null}
      </>
    )
  } else if (loading) {
    content = <Spinner />
  } else if (atEnd) {
    content = <Soft>{endText}</Soft>
  }
  return <View style={styles.footer}>{content}</View>
}

// A pill over the top of a list ("novos posts"); fades and slides in and
// out, and renders nothing once the exit animation has finished.
export function NewItemsPill ({ label, visible, onPress, top = 8 }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  const anim = useRef(new Animated.Value(visible ? 1 : 0)).current
  const [shown, setShown] = useState(visible)
  useEffect(() => {
    if (visible) setShown(true)
    const run = Animated.timing(anim, { toValue: visible ? 1 : 0, duration: motion.normal, useNativeDriver: native })
    run.start(({ finished }) => {
      if (finished && !visible) setShown(false)
    })
    return () => run.stop()
  }, [visible, anim])
  if (!visible && !shown) return null
  return (
    <Animated.View
      style={[styles.newWrap, { top, opacity: anim, transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [-8, 0] }) }] }]}
      pointerEvents={visible ? 'box-none' : 'none'}
    >
      <Pressable accessibilityRole='button' accessibilityLabel={label} onPress={onPress} hitSlop={4} style={styles.newPill}>
        <Icon name='seta_cima' size={14} color={colors.pillInk} />
        <Text style={styles.newText}>{label}</Text>
      </Pressable>
    </Animated.View>
  )
}

// Diario and Membro draw a 96 pt band. layout.band is the older 150.
const PROFILE_BAND = 96

const makeStyles = (colors) => StyleSheet.create({
  skRow: { flexDirection: 'row', gap: 12, paddingVertical: 12, paddingHorizontal: 16, width: '100%', maxWidth: layout.column, alignSelf: 'center' },
  skAvatar: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.skeleton },
  skLines: { flex: 1, gap: 10, justifyContent: 'center' },
  skBar: { height: 12, borderRadius: 6, backgroundColor: colors.skeleton },
  skTile: { gap: space.md, padding: space.lg },
  skImage: { width: '100%', aspectRatio: 1, borderRadius: radius.md, backgroundColor: colors.skeleton },
  skBubble: { width: '65%', height: 56, margin: space.lg, borderRadius: radius.bubble, backgroundColor: colors.skeleton },
  skProfile: { width: '100%' },
  skBand: { height: PROFILE_BAND, backgroundColor: colors.skeleton },
  skProfileHead: { width: '100%', maxWidth: layout.column, alignSelf: 'center', marginTop: -layout.hit, paddingHorizontal: space.lg },
  skProfileRing: { width: layout.hit * 2 + space.sm, height: layout.hit * 2 + space.sm, borderRadius: (layout.hit * 2 + space.sm) / 2, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' },
  skProfileAvatar: { width: layout.hit * 2, height: layout.hit * 2, borderRadius: layout.hit, backgroundColor: colors.skeleton },
  skProfileLines: { width: '100%', maxWidth: layout.column, alignSelf: 'center', gap: 10, paddingTop: space.md, paddingHorizontal: space.lg, paddingBottom: space.md },
  skProfileCounts: { flexDirection: 'row', gap: space.lg, marginTop: space.sm },
  skMediaWrap: { width: '100%', maxWidth: layout.column, alignSelf: 'center', paddingHorizontal: space.lg, paddingVertical: space.md },
  // A post photo, not the square listing tile, clipped like MediaGrid.
  skMedia: { width: '100%', aspectRatio: 4 / 3, borderRadius: radius.bubble - 4, backgroundColor: colors.skeleton },
  empty: { alignItems: 'center', gap: 12, paddingVertical: 32, paddingHorizontal: 16 },
  emptyTitle: { ...type.emptyTitle, color: colors.ink, textAlign: 'center' },
  emptyBody: { textAlign: 'center' },
  footer: { minHeight: 56, alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 8, paddingHorizontal: 16 },
  newWrap: { position: 'absolute', alignSelf: 'center', zIndex: 2 },
  newPill: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 17,
    borderRadius: 999,
    backgroundColor: colors.pillBg,
    boxShadow: `${elevation.raised} ${colors.shadow}`
  },
  newText: { ...type.pill, color: colors.pillInk }
})
