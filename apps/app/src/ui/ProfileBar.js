// A short sunset bar pinned over a profile list (Diário, Membro) once the
// ProfileHeader's band has scrolled away: the name and the band's own
// controls, so they stay in reach. The caller places it after the list, under
// its Modals, and feeds useProfileBar's handleScrollFrame to RefreshableList.
// Opacity follows the scroll through an Animated.Value (no render per frame);
// its buttons mount only once the bar is interactive, which is when the
// header's own buttons have left the screen. With reduce motion it snaps.

import { useCallback, useEffect, useRef, useState } from 'react'
import { AccessibilityInfo, Animated, Pressable, StyleSheet, Text, View } from 'react-native'
import { profileBarState } from '../profileBar'
import { Icon } from './Icon'
import { SunsetBand } from './SunsetBand'
import { type } from './theme'
import { useStyles } from './ThemeProvider'

export const BAR = 44

export function useProfileBar (bandHeight, { controlsBottom = bandHeight } = {}) {
  const opacity = useRef(new Animated.Value(0)).current
  const [interactive, setInteractive] = useState(false)
  const shown = useRef(false)
  const reduce = useRef(false)
  const lastY = useRef(0)

  const apply = useCallback((y) => {
    lastY.current = y
    const { opacity: v, interactive: on } = profileBarState(y, bandHeight, reduce.current, controlsBottom)
    opacity.setValue(v)
    if (on !== shown.current) {
      shown.current = on
      setInteractive(on)
    }
  }, [bandHeight, controlsBottom, opacity])

  // The band height moves with the safe-area inset.
  useEffect(() => { apply(lastY.current) }, [apply])

  useEffect(() => {
    let live = true
    let sub = null
    const set = (r) => {
      if (!live) return
      reduce.current = r === true
      apply(lastY.current)
    }
    try {
      Promise.resolve(AccessibilityInfo.isReduceMotionEnabled()).then(set, () => {})
    } catch {}
    try {
      sub = AccessibilityInfo.addEventListener('reduceMotionChanged', set)
    } catch {}
    return () => {
      live = false
      sub?.remove?.()
    }
  }, [apply])

  const handleScrollFrame = useCallback(({ y }) => apply(y), [apply])
  return { opacity, interactive, handleScrollFrame }
}

export function ProfileBar ({ bar, topInset = 0, title, onBack, children }) {
  const styles = useStyles(makeStyles)
  const on = bar.interactive
  // Shown, the opaque bar takes every tap on itself: box-none would pass taps
  // on its empty parts to the profile under it (a bio link, Seguir).
  return (
    <Animated.View
      pointerEvents={on ? 'auto' : 'none'}
      accessibilityElementsHidden={!on}
      importantForAccessibility={on ? 'auto' : 'no-hide-descendants'}
      aria-hidden={!on}
      style={[styles.wrap, { height: topInset + BAR, opacity: bar.opacity }]}
    >
      <View pointerEvents={on ? 'auto' : 'none'}>
        <View pointerEvents='none'>
          <SunsetBand height={topInset + BAR} />
        </View>
        <View style={[styles.row, { top: topInset }]} pointerEvents={on ? 'auto' : 'none'}>
          {/* The buttons mount only while the bar is interactive: on the web
              box-none gives children pointer-events auto past a hidden parent,
              and a mounted Pressable stays focusable at opacity 0. */}
          {on && typeof onBack === 'function'
            ? (
              <Pressable
                accessibilityRole='button'
                accessibilityLabel='voltar'
                hitSlop={8}
                onPress={onBack}
                style={styles.back}
              >
                <Icon name='voltar' size={22} color='#ffffff' />
              </Pressable>
              )
            : null}
          <View style={styles.name} pointerEvents='none'>
            <Text style={styles.title} numberOfLines={1} accessibilityRole='header'>{title || ''}</Text>
          </View>
          {on && children ? <View style={styles.controls} pointerEvents='box-none'>{children}</View> : null}
        </View>
      </View>
    </Animated.View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  wrap: { position: 'absolute', top: 0, left: 0, right: 0 },
  row: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: BAR,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8
  },
  back: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: colors.dim,
    alignItems: 'center',
    justifyContent: 'center'
  },
  name: { flex: 1 },
  title: { ...type.sheetTitle, color: '#ffffff' },
  controls: { flexDirection: 'row', alignItems: 'center', gap: 8 }
})
