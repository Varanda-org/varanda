// Loading, empty and error states for lists and screens, the list footer
// and the "new items" pill. Presentational only: callers pass text that has
// already gone through displayText / errorText. No counts, no media.

import { useEffect, useRef, useState } from 'react'
import { Animated, Platform, Pressable, StyleSheet, Text, View } from 'react-native'
import { ErrorText, Soft, Spinner } from './index'
import { Icon } from './Icon'
import { Pill } from './Pill'
import { colors, layout, motion, type } from './theme'

const native = Platform.OS !== 'web'

// Post-shaped placeholders that pulse while the first page loads.
export function Skeleton ({ rows = 3 }) {
  const pulse = useRef(new Animated.Value(0.5)).current
  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: 1, duration: 600, useNativeDriver: native }),
      Animated.timing(pulse, { toValue: 0.5, duration: 600, useNativeDriver: native })
    ]))
    loop.start()
    return () => loop.stop()
  }, [pulse])
  const items = []
  for (let i = 0; i < rows; i++) {
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
  return (
    <Animated.View style={{ opacity: pulse }} accessible={false} importantForAccessibility='no-hide-descendants'>
      {items}
    </Animated.View>
  )
}

export function EmptyState ({ icon, title, body, actionLabel, onAction }) {
  return (
    <View style={styles.empty}>
      {icon ? <Icon name={icon} size={40} color={colors.dim} /> : null}
      <Text style={styles.emptyTitle} accessibilityRole='header'>{title}</Text>
      {body ? <Soft>{body}</Soft> : null}
      {actionLabel && onAction ? <Pill label={actionLabel} onPress={onAction} filled /> : null}
    </View>
  )
}

export function ErrorState ({ message, onRetry, pending }) {
  return (
    <View style={styles.empty}>
      <ErrorText>{message}</ErrorText>
      {onRetry ? <Pill label='tentar de novo' onPress={onRetry} pending={pending} /> : null}
    </View>
  )
}

// The end of a paged list: a spinner while loading, a closing line at the
// end, or an error with a retry.
export function ListFooter ({ loading, atEnd, endText = 'Isso é tudo por enquanto.', error, onRetry, pending }) {
  let content = null
  if (error) {
    content = (
      <>
        <ErrorText>{error}</ErrorText>
        {onRetry ? <Pill label='tentar de novo' onPress={onRetry} pending={pending} /> : null}
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
export function NewItemsPill ({ label, visible, onPress }) {
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
      style={[styles.newWrap, { opacity: anim, transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [-8, 0] }) }] }]}
      pointerEvents={visible ? 'box-none' : 'none'}
    >
      <Pressable accessibilityRole='button' accessibilityLabel={label} onPress={onPress} hitSlop={4} style={styles.newPill}>
        <Icon name='seta_cima' size={14} color={colors.pillInk} />
        <Text style={styles.newText}>{label}</Text>
      </Pressable>
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  skRow: { flexDirection: 'row', gap: 12, paddingVertical: 12, paddingHorizontal: 16, width: '100%', maxWidth: layout.column, alignSelf: 'center' },
  skAvatar: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.skeleton },
  skLines: { flex: 1, gap: 10, justifyContent: 'center' },
  skBar: { height: 12, borderRadius: 6, backgroundColor: colors.skeleton },
  empty: { alignItems: 'center', gap: 12, paddingVertical: 32, paddingHorizontal: 16 },
  emptyTitle: { ...type.emptyTitle, color: colors.ink, textAlign: 'center' },
  footer: { minHeight: 56, alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 8, paddingHorizontal: 16 },
  newWrap: { position: 'absolute', top: 8, alignSelf: 'center', zIndex: 2 },
  newPill: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 17,
    borderRadius: 999,
    backgroundColor: colors.pillBg,
    boxShadow: '0px 6px 16px rgba(29,107,79,0.35)'
  },
  newText: { ...type.pill, color: colors.pillInk }
})
