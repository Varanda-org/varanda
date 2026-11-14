// A short sunset bar pinned over a profile list (Diário, Membro) once the
// ProfileHeader's band has scrolled away: the name and the band's own
// controls, so they stay in reach. The caller places it after the list, under
// its Modals, and feeds useProfileBar's handleScrollFrame to RefreshableList.
// Opacity follows the scroll through an Animated.Value (no render per frame);
// its buttons mount only once the bar is interactive, which is when the
// header's own buttons have left the screen. With reduce motion it snaps.
// Once the list's tabs reach the bar, a copy of them mounts in a slot under
// its row (tabsTop, list-content y of the tabs, comes from the screen).

import { useCallback, useEffect, useRef, useState } from 'react'
import { AccessibilityInfo, Animated, StyleSheet, Text, View } from 'react-native'
import { pinnedTabOffset, profileBarState, tabsPinned } from '../profileBar'
import { Icon } from './Icon'
import { SunsetBand } from './SunsetBand'
import { PressScale } from './PressScale'
import { space, type } from './theme'
import { useStyles } from './ThemeProvider'

export const BAR = 44

export function useProfileBar (bandHeight, { controlsBottom = bandHeight, tabsTop = null, topInset = 0 } = {}) {
  const opacity = useRef(new Animated.Value(0)).current
  const [interactive, setInteractive] = useState(false)
  const [pinned, setPinned] = useState(false)
  const shown = useRef(false)
  const pinnedNow = useRef(false)
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
    // Pinned only on an interactive bar: a faded bar would show the tabs half
    // transparent over the list.
    const pin = on && tabsPinned(y, tabsTop, topInset + BAR)
    if (pin !== pinnedNow.current) {
      pinnedNow.current = pin
      setPinned(pin)
    }
  }, [bandHeight, controlsBottom, tabsTop, topInset, opacity])

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
  const pinnedOffset = useCallback(() => pinnedTabOffset(lastY.current, tabsTop, topInset + BAR), [tabsTop, topInset])
  return { opacity, interactive, pinned, handleScrollFrame, pinnedOffset }
}

// onSelect for the pinned tabs copy: swapping the list data alone would keep
// the old tab's offset and open the new tab partway down. listRef is
// RefreshableList's listRef (the FlatList). The header's own tabs keep onSelect.
export function usePinnedTabSelect (bar, listRef, selected, onSelect) {
  const pending = useRef(null)
  useEffect(() => {
    const p = pending.current
    if (p === null || p.id !== selected) return
    pending.current = null
    listRef.current?.scrollToOffset?.({ offset: p.offset, animated: false })
  }, [selected, listRef])
  const { pinnedOffset } = bar
  return useCallback((id) => {
    if (id !== selected) {
      const offset = pinnedOffset()
      pending.current = offset === null ? null : { id, offset }
    }
    onSelect(id)
  }, [pinnedOffset, selected, onSelect])
}

export function ProfileBar ({ bar, topInset = 0, title, onBack, tabs, children }) {
  const styles = useStyles(makeStyles)
  const on = bar.interactive
  const pinned = on && bar.pinned === true && !!tabs
  // Shown, the opaque bar takes every tap on itself: box-none would pass taps
  // on its empty parts to the profile under it (a bio link, Seguir). The wrap
  // takes its height from its content, so it grows by the tabs slot while
  // pinned: Android drops touches outside a parent's bounds.
  return (
    <Animated.View
      pointerEvents={on ? 'auto' : 'none'}
      accessibilityElementsHidden={!on}
      importantForAccessibility={on ? 'auto' : 'no-hide-descendants'}
      aria-hidden={!on}
      style={[styles.wrap, { opacity: bar.opacity }]}
    >
      <View style={{ height: topInset + BAR }} pointerEvents={on ? 'auto' : 'none'}>
        <View pointerEvents='none'>
          <SunsetBand height={topInset + BAR} />
        </View>
        <View style={[styles.row, { top: topInset }]} pointerEvents={on ? 'auto' : 'none'}>
          {/* The buttons mount only while the bar is interactive: on the web
              box-none gives children pointer-events auto past a hidden parent,
              and a mounted Pressable stays focusable at opacity 0. */}
          {on && typeof onBack === 'function'
            ? (
              <PressScale
                accessibilityRole='button'
                accessibilityLabel='voltar'
                hitSlop={8}
                onPress={onBack}
                style={styles.back}
              >
                <Icon name='voltar' size={22} color='#ffffff' />
              </PressScale>
              )
            : null}
          <View style={styles.name} pointerEvents='none'>
            <Text style={styles.title} numberOfLines={1} accessibilityRole='header'>{title || ''}</Text>
          </View>
          {on && children ? <View style={styles.controls} pointerEvents='box-none'>{children}</View> : null}
        </View>
      </View>
      {/* Mounted only while pinned, like the buttons: a hidden copy of the
          tabs would stay focusable. */}
      {pinned ? <View style={styles.tabs}>{tabs}</View> : null}
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
    paddingHorizontal: space.lg,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm
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
  controls: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  tabs: { backgroundColor: colors.bg, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line }
})
