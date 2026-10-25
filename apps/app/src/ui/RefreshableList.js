// The one list A Rua, Diário and Seguindo use: a FlatList with
// pull-to-refresh, infinite scroll, scroll-to-top on a signal and an optional
// "new items" pill. Native refreshes through RefreshControl; on the web
// (react-native-web's RefreshControl renders nothing) the gesture is read from
// the touches on the wrapper View with the math in src/pull.js, and a quiet
// 'Atualizar' action in the header serves keyboard and assistive users.
//
// Invariants:
// - never double-load: onLoadMore runs once per end reach, and never while
//   loadingMore, refreshing or at the end; a failed page is retried only by
//   the person (scrolling out of the end region and back, or the footer's
//   'tentar de novo'), never by itself, so a failing node is not hammered;
//   a quiet 'mostrar mais' in the footer loads the next page by hand, so
//   pagination can never stall;
// - never call onRefresh while refreshing: one refresh at a time, whether it
//   comes from the gesture, the header action or RefreshControl;
// - the pill never covers the first row's actions: it is centred and only
//   the pill itself takes touches, while the row actions sit in the left
//   column under the avatar;
// - a refresh only calls onRefresh: never sync.start, never a page reload
//   (the browser's own pull-to-refresh is stopped by the CSS in
//   public/index.html, not by preventDefault, which passive listeners ignore).
// Empty and short lists stay pullable: the gesture is on the wrapper, not on
// the content height.

import { createElement, isValidElement, useCallback, useEffect, useRef, useState } from 'react'
import { Animated, FlatList, Platform, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native'
import { MIN_SPIN_MS, PULL_THRESHOLD, pullDecision, pullState, spinRemaining } from '../pull'
import { Spinner } from './index'
import { Icon } from './Icon'
import { NewItemsPill } from './States'
import { colors, motion, type } from './theme'

const web = Platform.OS === 'web'
const INDICATOR = 36
// onEndReachedThreshold, in visible lengths from the end.
const END_THRESHOLD = 0.6

// A touch that starts in a text field or inside a text selection is not a pull.
function ignoredTarget (target) {
  if (typeof document === 'undefined' || !target) return false
  const tag = typeof target.tagName === 'string' ? target.tagName.toLowerCase() : ''
  if (tag === 'input' || tag === 'textarea' || target.isContentEditable === true) return true
  const sel = typeof window !== 'undefined' && window.getSelection ? window.getSelection() : null
  if (sel && !sel.isCollapsed && sel.rangeCount > 0) {
    try {
      if (sel.containsNode(target, true)) return true
    } catch {}
  }
  return false
}

function renderSlot (slot) {
  if (!slot) return null
  return isValidElement(slot) ? slot : createElement(slot)
}

export function RefreshableList ({
  data,
  renderItem,
  keyExtractor,
  extraData,
  ListHeaderComponent,
  ListFooterComponent,
  ListEmptyComponent,
  contentContainerStyle,
  onRefresh,
  refreshing,
  onLoadMore,
  loadingMore,
  loadMoreError,
  atEnd,
  scrollToTopSignal,
  newItems,
  listRef
}) {
  const list = useRef(null)
  const setList = useCallback((node) => {
    list.current = node
    if (typeof listRef === 'function') listRef(node)
    else if (listRef) listRef.current = node
  }, [listRef])

  // Infinite scroll: one onLoadMore per end reach. FlatList sends
  // onEndReached once per content length, also on content-size changes, and
  // again only after the list has left the end region (VirtualizedList
  // `_sentEndForContentLength`), so the guard mirrors that:
  // - it is re-armed by a new page (data change), by the end of a refresh, or
  //   by the person scrolling out of the end region; never by a content-size
  //   change alone, so a failing page cannot retry in a loop (the footer
  //   swaps between spinner and error; its 'tentar de novo' retries);
  // - an end reach FlatList sends while a page loads or a refresh runs is
  //   remembered and served once that span ends, if the page succeeded (data
  //   changed) or it was a refresh, and the end is still in view;
  // - whatever FlatList does, the footer's 'mostrar mais' loads the next page
  //   by hand whenever one exists, so pagination can never stall.
  const endFired = useRef(false)
  const endPending = useRef(false)
  const span = useRef(null) // { data, refreshed } while a load or refresh runs
  const metrics = useRef({ offset: 0, content: 0, layout: 0 })
  const busyNow = !!loadingMore || !!refreshing
  const nearEnd = useCallback(() => {
    const m = metrics.current
    return m.layout > 0 && m.content - (m.offset + m.layout) <= END_THRESHOLD * m.layout
  }, [])
  const servePending = useCallback(() => {
    if (!endPending.current || busyNow || typeof onLoadMore !== 'function') return
    if (atEnd) {
      endPending.current = false
      return
    }
    if (!nearEnd()) return
    endPending.current = false
    endFired.current = true
    onLoadMore()
  }, [busyNow, atEnd, onLoadMore, nearEnd])
  useEffect(() => { endFired.current = false }, [data])
  useEffect(() => {
    if (busyNow) {
      if (span.current === null) span.current = { data, refreshed: false }
      if (refreshing) span.current.refreshed = true
      return
    }
    const s = span.current
    span.current = null
    if (s === null) return
    if (s.refreshed) endFired.current = false
    // A page that failed (data unchanged, no refresh) is not retried here.
    if (!s.refreshed && s.data === data) endPending.current = false
    servePending()
  }, [busyNow, refreshing, data, servePending])
  const onEndReached = useCallback(() => {
    if (atEnd || typeof onLoadMore !== 'function') return
    if (busyNow) {
      endPending.current = true
      return
    }
    if (endFired.current) return
    endFired.current = true
    onLoadMore()
  }, [busyNow, atEnd, onLoadMore])
  const loadMoreByHand = useCallback(() => {
    if (busyNow || atEnd || typeof onLoadMore !== 'function') return
    endFired.current = true
    onLoadMore()
  }, [busyNow, atEnd, onLoadMore])
  const showMore = !atEnd && !busyNow && !loadMoreError && typeof onLoadMore === 'function' &&
    Array.isArray(data) && data.length > 0

  // Scroll to the top whenever the signal changes (not on mount).
  const lastSignal = useRef(scrollToTopSignal)
  useEffect(() => {
    if (scrollToTopSignal === lastSignal.current) return
    lastSignal.current = scrollToTopSignal
    if (list.current) list.current.scrollToOffset({ offset: 0, animated: true })
  }, [scrollToTopSignal])

  // Web pull-to-refresh state.
  const atTop = useRef(true)
  const touch = useRef(null) // { startX, startY, lock, armed } while a single touch is tracked
  const busy = useRef(false) // a web refresh is running (gesture or header action)
  const mounted = useRef(true)
  const timer = useRef(null)
  const anim = useRef(null)
  const distance = useRef(new Animated.Value(0)).current
  const progress = useRef(new Animated.Value(0)).current
  const [showIndicator, setShowIndicator] = useState(false)
  const [spinning, setSpinning] = useState(false)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      touch.current = null
      if (timer.current) clearTimeout(timer.current)
      if (anim.current) anim.current.stop()
    }
  }, [])

  const hide = useCallback(() => {
    if (anim.current) anim.current.stop()
    const run = Animated.parallel([
      Animated.timing(distance, { toValue: 0, duration: motion.normal, useNativeDriver: false }),
      Animated.timing(progress, { toValue: 0, duration: motion.normal, useNativeDriver: false })
    ])
    anim.current = run
    run.start(({ finished }) => {
      if (finished && mounted.current) {
        setShowIndicator(false)
        setSpinning(false)
      }
    })
  }, [distance, progress])

  const runRefresh = useCallback(() => {
    if (busy.current || refreshing || typeof onRefresh !== 'function') return
    busy.current = true
    if (anim.current) anim.current.stop()
    distance.setValue(PULL_THRESHOLD)
    progress.setValue(1)
    setShowIndicator(true)
    setSpinning(true)
    const startedAt = Date.now()
    const settle = () => {
      if (!mounted.current) return
      timer.current = setTimeout(() => {
        timer.current = null
        busy.current = false
        if (mounted.current) hide()
      }, spinRemaining({ startedAt, now: Date.now(), min: MIN_SPIN_MS }))
    }
    let pending
    try {
      pending = Promise.resolve(onRefresh())
    } catch {
      pending = Promise.resolve()
    }
    pending.then(settle, settle)
  }, [refreshing, onRefresh, distance, progress, hide])

  const onScroll = useCallback((e) => {
    const ne = e.nativeEvent
    atTop.current = ne.contentOffset.y <= 0
    metrics.current = { offset: ne.contentOffset.y, content: ne.contentSize.height, layout: ne.layoutMeasurement.height }
    // Leaving the end region re-arms the end reach, as FlatList does.
    if (!nearEnd()) endFired.current = false
  }, [nearEnd])
  const onContentSizeChange = useCallback((w, h) => {
    metrics.current = { ...metrics.current, content: h }
    // New rows are laid out: a remembered end reach may be served now.
    servePending()
  }, [servePending])
  const onLayout = useCallback((e) => { metrics.current = { ...metrics.current, layout: e.nativeEvent.layout.height } }, [])

  // The indicator is never left visible without an active pull or a running
  // refresh: every path that abandons a tracked gesture (a second finger, a
  // rejected lock, a start while tracking) hides it unless a refresh is busy.
  const onTouchStart = useCallback((e) => {
    const ev = e.nativeEvent
    const abandoned = touch.current !== null
    touch.current = null
    if (abandoned && !busy.current) hide()
    if (!atTop.current || busy.current || refreshing) return
    if (!ev.touches || ev.touches.length !== 1) return
    if (ignoredTarget(e.target)) return
    const t = ev.touches[0]
    touch.current = { startX: t.pageX, startY: t.pageY, lock: null, armed: false }
  }, [refreshing, hide])

  const onTouchMove = useCallback((e) => {
    const cur = touch.current
    if (!cur) return
    const ev = e.nativeEvent
    if (!ev.touches || ev.touches.length !== 1) {
      touch.current = null
      if (!busy.current) hide()
      return
    }
    const t = ev.touches[0]
    const s = pullState({
      startX: cur.startX,
      startY: cur.startY,
      x: t.pageX,
      y: t.pageY,
      atTop: atTop.current,
      refreshing: refreshing || busy.current,
      lock: cur.lock
    })
    cur.lock = s.lock
    cur.armed = s.armed
    if (s.lock === 'rejected') {
      touch.current = null
      if (!busy.current) hide()
      return
    }
    if (s.active) {
      if (anim.current) anim.current.stop()
      distance.setValue(s.distance)
      progress.setValue(s.progress)
      setShowIndicator(true)
    }
  }, [refreshing, distance, progress, hide])

  const onTouchEnd = useCallback(() => {
    const cur = touch.current
    touch.current = null
    if (busy.current) return
    if (!cur) {
      // No gesture tracked (it was abandoned earlier): a still-visible
      // indicator has nothing to wait for.
      if (showIndicator) hide()
      return
    }
    if (pullDecision({ armed: cur.armed, refreshing: !!refreshing }) === 'refresh') runRefresh()
    else hide()
  }, [refreshing, runRefresh, hide, showIndicator])

  const onTouchCancel = useCallback(() => {
    touch.current = null
    if (!busy.current) hide()
  }, [hide])

  const header = web
    ? (
      <>
        <View style={styles.webBar}>
          <Pressable
            accessibilityRole='button'
            accessibilityLabel='Atualizar'
            accessibilityState={{ disabled: !!refreshing || spinning }}
            disabled={!!refreshing || spinning}
            onPress={runRefresh}
            style={({ pressed }) => [styles.webAction, pressed && styles.pressed]}
          >
            <Icon name='atualizar' size={16} color={colors.soft} />
            <Text style={styles.webText}>Atualizar</Text>
          </Pressable>
        </View>
        {renderSlot(ListHeaderComponent)}
      </>
      )
    : ListHeaderComponent

  // The caller's footer (spinner, end text, error with retry), then the
  // by-hand 'mostrar mais' when another page exists and nothing is loading.
  const footer = (
    <>
      {renderSlot(ListFooterComponent)}
      {showMore
        ? (
          <View style={styles.moreBar}>
            <Pressable
              accessibilityRole='button'
              accessibilityLabel='mostrar mais'
              onPress={loadMoreByHand}
              hitSlop={4}
              style={({ pressed }) => [styles.moreAction, pressed && styles.pressed]}
            >
              <Text style={styles.moreText}>mostrar mais</Text>
            </Pressable>
          </View>
          )
        : null}
    </>
  )

  const rotate = progress.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '180deg'] })

  return (
    <View
      style={styles.wrap}
      onTouchStart={web ? onTouchStart : undefined}
      onTouchMove={web ? onTouchMove : undefined}
      onTouchEnd={web ? onTouchEnd : undefined}
      onTouchCancel={web ? onTouchCancel : undefined}
    >
      <FlatList
        ref={setList}
        style={styles.list}
        data={data}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        extraData={extraData}
        ListHeaderComponent={header}
        ListFooterComponent={footer}
        ListEmptyComponent={ListEmptyComponent}
        contentContainerStyle={contentContainerStyle}
        onEndReached={onEndReached}
        onEndReachedThreshold={END_THRESHOLD}
        keyboardShouldPersistTaps='handled'
        onScroll={onScroll}
        onContentSizeChange={onContentSizeChange}
        onLayout={onLayout}
        scrollEventThrottle={16}
        dataSet={{ pull: 'y' }}
        refreshControl={web
          ? undefined
          : <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} tintColor={colors.accent} colors={[colors.accent]} />}
      />
      {web && showIndicator
        ? (
          <Animated.View
            pointerEvents='none'
            accessible={false}
            importantForAccessibility='no-hide-descendants'
            style={[
              styles.indicator,
              {
                opacity: spinning ? 1 : progress,
                transform: [
                  { translateY: Animated.subtract(distance, INDICATOR) },
                  { rotate: spinning ? '0deg' : rotate }
                ]
              }
            ]}
          >
            {spinning ? <Spinner /> : <Icon name='atualizar' size={18} color={colors.accent} />}
          </Animated.View>
          )
        : null}
      {newItems ? <NewItemsPill label={newItems.label} visible={!!newItems.visible} onPress={() => newItems.onPress && newItems.onPress()} /> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: colors.bg },
  list: { flex: 1, backgroundColor: colors.bg },
  webBar: { flexDirection: 'row', justifyContent: 'flex-end', paddingHorizontal: 8 },
  webAction: {
    minHeight: 44,
    minWidth: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 10
  },
  webText: { ...type.postMeta, color: colors.soft },
  moreBar: { alignItems: 'center', paddingBottom: 12 },
  moreAction: { minHeight: 44, minWidth: 44, justifyContent: 'center', paddingHorizontal: 12 },
  moreText: { ...type.postMeta, color: colors.accent, fontWeight: '600' },
  pressed: { opacity: 0.6 },
  indicator: {
    position: 'absolute',
    top: 0,
    alignSelf: 'center',
    width: INDICATOR,
    height: INDICATOR,
    borderRadius: INDICATOR / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.card,
    boxShadow: '0px 2px 8px rgba(0,0,0,0.15)',
    zIndex: 3
  }
})
