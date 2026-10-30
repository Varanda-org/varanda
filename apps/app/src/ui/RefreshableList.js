// The one list A Rua, Diário and Seguindo use: a FlatList with
// pull-to-refresh, infinite scroll, scroll-to-top on a signal and an optional
// "new items" pill. Native refreshes through RefreshControl; on the web
// (react-native-web's RefreshControl renders nothing) there is no visible
// refresh button: the touch pull is read from the touches on the wrapper View
// (src/pull.js pullState), and a desktop wheel or trackpad pull from a PASSIVE
// `wheel` listener on the list's scrollable DOM node (getScrollableNode(); no
// listener when it is missing) fed to src/pull.js wheelPullState. Both show
// the same indicator. A wheel pull fires on release: when it is armed and the
// wheel then stays idle for WHEEL_DECAY_MS (trackpad inertia keeps it going
// until it ends), onRefresh runs once; an idle pull that is not armed just
// hides the indicator. A visually hidden 'Atualizar' button (web only; off
// screen until it gets keyboard focus, then shown at the top right) serves
// keyboard and screen-reader users.
//
// Invariants:
// - never double-load: onLoadMore runs once per end reach, and never while
//   loadingMore, refreshing or at the end; a failed page is retried only by
//   the person (scrolling out of the end region and back, or the footer's
//   'tentar de novo'), never by itself, so a failing node is not hammered;
// - pagination never stalls while the end is in view: every busy span and
//   every layout checks the end again, a list shorter than the screen loads
//   by itself, and AUTO_DRY_MAX pages in a row that the list asked for and
//   that showed nothing new pause it behind a 'carregar mais' button, so
//   hidden records never become a request loop;
// - never call onRefresh while refreshing: one refresh at a time, whether it
//   comes from the touch pull, the wheel pull, the hidden action or
//   RefreshControl;
// - the pill never covers the first row's actions: it is centred and only
//   the pill itself takes touches, while the row actions sit in the left
//   column under the avatar;
// - a refresh awaits the node's syncNow before onRefresh, once per gesture;
//   never a page reload
//   (the browser's own pull-to-refresh is stopped by the CSS in
//   public/index.html, not by preventDefault, which passive listeners ignore).
// Empty and short lists stay pullable: the gesture is on the wrapper, not on
// the content height.

import { createElement, isValidElement, useCallback, useEffect, useRef, useState } from 'react'
import { Animated, FlatList, Platform, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native'
import { EMPTY_WHEEL, MIN_SPIN_MS, PULL_THRESHOLD, WHEEL_DECAY_MS, pullDecision, pullState, spinRemaining, wheelPullState } from '../pull'
import { endStep, nearListEnd, spanEnd } from '../paging'
import { useNode } from '../node'
import { Spinner } from './index'
import { Icon } from './Icon'
import { NewItemsPill } from './States'
import { colors, motion, type } from './theme'

const web = Platform.OS === 'web'
const INDICATOR = 36
// onEndReachedThreshold, in visible lengths from the end.
const END_THRESHOLD = 0.6
// After a span that changed the row count, the end is checked again this
// long after the commit if no onContentSizeChange came first.
const LAYOUT_SETTLE_MS = 100
// An onLoadMore call that started no load or refresh within this long is
// treated as a no-op (see check()).
const UNSTARTED_MS = 1500
// WheelEvent.deltaMode: lines and pages are turned into pixels.
const LINE_PX = 16

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
  const node = useNode()
  const syncNow = node && node.syncNow
  const busy = useRef(false) // one refresh across web and native gestures
  const [spinning, setSpinning] = useState(false)
  const list = useRef(null)
  const setList = useCallback((node) => {
    list.current = node
    if (typeof listRef === 'function') listRef(node)
    else if (listRef) listRef.current = node
  }, [listRef])

  // Infinite scroll. check() is the one place that starts a page (endStep):
  // - `fired` allows one onLoadMore per end reach; it is re-armed when a busy
  //   span ends without failing, when data changes outside a span, and when
  //   the person scrolls out of the end region (which also clears `dry` and
  //   the pause);
  // - an end reach that comes while a page loads or a refresh runs is not
  //   remembered: the end of that span checks again (spanEnd), right away or
  //   after the new rows are laid out (onContentSizeChange);
  // - `dry` counts the list's own pages in a row that showed no new row;
  //   at AUTO_DRY_MAX the list pauses and the footer offers 'carregar mais';
  // - a failed page (loadMoreError) is left to the caller's footer retry.
  // Callers pass onLoadMore only while it would start a page: a call that
  // starts nothing leaves `fired` set until the data changes or the person
  // scrolls.
  const fired = useRef(false)
  const dry = useRef(0)
  const span = useRef(null) // { len, refreshed, own, started } while a load or refresh runs
  const layoutTimer = useRef(null)
  const measured = useRef(false)
  // Fresh content metrics arrived: the span end's layout wait is over.
  const endLayoutWait = () => {
    if (layoutTimer.current === null) return
    clearTimeout(layoutTimer.current)
    layoutTimer.current = null
  }
  const [paused, setPaused] = useState(false)
  const metrics = useRef({ offset: 0, content: 0, layout: 0 })
  const busyNow = !!loadingMore || !!refreshing || spinning
  const len = Array.isArray(data) ? data.length : 0
  const hasLoader = typeof onLoadMore === 'function'
  const ends = useRef(null)
  ends.current = { onLoadMore, atEnd: !!atEnd, loadMoreError: !!loadMoreError, busyNow, len }
  const checkRef = useRef(null)
  const unstartedTimer = useRef(null)
  const startPage = useCallback(() => {
    const l = ends.current
    fired.current = true
    span.current = { len: l.len, refreshed: false, own: true, started: false, at: Date.now() }
    l.onLoadMore()
    // If that call started nothing, look again once it counts as a no-op,
    // even if no render or scroll comes in between.
    if (unstartedTimer.current) clearTimeout(unstartedTimer.current)
    unstartedTimer.current = setTimeout(() => {
      unstartedTimer.current = null
      if (checkRef.current) checkRef.current()
    }, UNSTARTED_MS + 50)
  }, [])
  const check = useCallback(() => {
    // New rows not measured yet (the span end set the timer): any check now
    // would read the old content height and ask for one page too many.
    if (layoutTimer.current !== null) return
    // Before the first content height a viewport alone looks like the end.
    if (!measured.current) return
    const l = ends.current
    // A call that never started a span (the caller's own guard returned:
    // offline, a first load still running) is forgotten after a while, so a
    // later render can try again instead of leaving the end latched.
    const s = span.current
    if (fired.current && s !== null && s.own && !s.started && Date.now() - s.at >= UNSTARTED_MS) {
      span.current = null
      fired.current = false
    }
    const step = endStep({
      canLoad: typeof l.onLoadMore === 'function',
      atEnd: l.atEnd,
      failed: l.loadMoreError,
      busy: l.busyNow || busy.current,
      near: nearListEnd(metrics.current, END_THRESHOLD),
      fired: fired.current,
      dry: dry.current
    })
    if (step === 'paused') setPaused(true)
    else if (step === 'load') startPage()
  }, [startPage])
  checkRef.current = check
  // Loads one page by hand from the pause; its own count starts over.
  const loadByHand = useCallback(() => {
    const l = ends.current
    if (l.busyNow || busy.current || l.atEnd || l.loadMoreError || typeof l.onLoadMore !== 'function') return
    dry.current = 0
    setPaused(false)
    startPage()
  }, [startPage])
  // Data that changes outside a span (a first load the list does not see as
  // busy, a deletion) re-arms the end reach; a page that never started is
  // forgotten. It runs before the span end below, which may start the next
  // page in the same commit.
  const lastLen = useRef(len)
  useEffect(() => {
    const grew = len > lastLen.current
    lastLen.current = len
    if (ends.current.busyNow || busy.current) return
    if (span.current !== null && !span.current.started) span.current = null
    fired.current = false
    // New rows from outside the list (a reload): the dry count starts over.
    if (grew) {
      dry.current = 0
      setPaused(false)
    }
  }, [data])
  useEffect(() => {
    if (busyNow) {
      if (span.current === null) span.current = { len, refreshed: false, own: false, started: true }
      else span.current.started = true
      if (refreshing || spinning) span.current.refreshed = true
      return
    }
    const s = span.current
    if (s === null || !s.started) return
    span.current = null
    const r = spanEnd({ dry: dry.current, startLen: s.len, len, failed: !!loadMoreError, refreshed: s.refreshed, own: s.own })
    dry.current = r.dry
    if (r.dry === 0) setPaused(false)
    if (r.check === 'none') return
    fired.current = false
    if (r.check === 'now') {
      check()
      return
    }
    // The new rows may already be laid out (a refresh whose rows rendered
    // while the indicator still spun): no onContentSizeChange will come, so
    // check once more after it would have; `fired` makes a second call a no-op.
    if (layoutTimer.current) clearTimeout(layoutTimer.current)
    layoutTimer.current = setTimeout(() => {
      layoutTimer.current = null
      check()
    }, LAYOUT_SETTLE_MS)
  }, [busyNow, refreshing, spinning, len, loadMoreError, check])
  const prevAtEnd = useRef(!!atEnd)
  useEffect(() => {
    // More pages again (a refresh, a sync): the list starts counting afresh.
    if (prevAtEnd.current && !atEnd) {
      fired.current = false
      dry.current = 0
      setPaused(false)
    }
    prevAtEnd.current = !!atEnd
    check()
  }, [atEnd, hasLoader, loadMoreError, check])
  // Every commit checks the end too: conditions a caller guards on (being
  // online, a first load) change without a scroll or a layout. check() is
  // pure until it starts a page, so this costs nothing at rest.
  useEffect(() => { check() })
  const showPaused = paused && !atEnd && !busyNow && !loadMoreError && hasLoader

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
  const mounted = useRef(true)
  const timer = useRef(null)
  const anim = useRef(null)
  const distance = useRef(new Animated.Value(0)).current
  const progress = useRef(new Animated.Value(0)).current
  const [showIndicator, setShowIndicator] = useState(false)
  // The hidden 'Atualizar' action has keyboard focus (it is shown then).
  const [actionFocused, setActionFocused] = useState(false)
  // Wheel pull: the wheelPullState state and its idle (release) timer.
  const wheel = useRef(EMPTY_WHEEL)
  const wheelTimer = useRef(null)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      touch.current = null
      if (timer.current) clearTimeout(timer.current)
      if (wheelTimer.current) clearTimeout(wheelTimer.current)
      wheelTimer.current = null
      if (layoutTimer.current) clearTimeout(layoutTimer.current)
      layoutTimer.current = null
      if (unstartedTimer.current) clearTimeout(unstartedTimer.current)
      unstartedTimer.current = null
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
    const pending = (async () => {
      if (typeof syncNow === 'function') await syncNow()
      if (mounted.current) await onRefresh()
    })()
    pending.then(settle, settle)
  }, [refreshing, onRefresh, syncNow, distance, progress, hide])

  // The wheel listener is attached once; it reads the current values here.
  const live = useRef(null)
  live.current = { refreshing: !!refreshing, runRefresh, hide }
  useEffect(() => {
    if (!web) return
    const host = list.current
    const node = host && typeof host.getScrollableNode === 'function' ? host.getScrollableNode() : null
    if (!node || typeof node.addEventListener !== 'function') return
    const reset = () => {
      if (wheelTimer.current) clearTimeout(wheelTimer.current)
      wheelTimer.current = null
      const was = wheel.current.active
      wheel.current = EMPTY_WHEEL
      return was
    }
    const onIdle = () => {
      wheelTimer.current = null
      const s = wheel.current
      wheel.current = EMPTY_WHEEL
      if (!mounted.current || busy.current) return
      const l = live.current
      if (pullDecision({ armed: s.armed, refreshing: l.refreshing }) === 'refresh') l.runRefresh()
      else l.hide()
    }
    const onWheel = (e) => {
      // A pinch zoom (ctrlKey) or a touch pull in progress is not a wheel pull.
      if (e.ctrlKey || touch.current !== null) return
      const unit = e.deltaMode === 1 ? LINE_PX : (e.deltaMode === 2 ? (node.clientHeight || 1) : 1)
      const l = live.current
      const s = wheelPullState(wheel.current, {
        deltaY: e.deltaY * unit,
        atTop: node.scrollTop <= 0,
        refreshing: l.refreshing || busy.current,
        now: Date.now()
      })
      if (!s.active) {
        if (reset() && !busy.current) l.hide()
        return
      }
      wheel.current = s
      if (anim.current) anim.current.stop()
      distance.setValue(s.distance)
      progress.setValue(s.progress)
      setShowIndicator(true)
      if (wheelTimer.current) clearTimeout(wheelTimer.current)
      wheelTimer.current = setTimeout(onIdle, WHEEL_DECAY_MS)
    }
    node.addEventListener('wheel', onWheel, { passive: true })
    return () => {
      node.removeEventListener('wheel', onWheel, { passive: true })
      reset()
    }
  }, [distance, progress])

  const onScroll = useCallback((e) => {
    const ne = e.nativeEvent
    atTop.current = ne.contentOffset.y <= 0
    metrics.current = { offset: ne.contentOffset.y, content: ne.contentSize.height, layout: ne.layoutMeasurement.height }
    measured.current = true
    if (nearListEnd(metrics.current, END_THRESHOLD)) check()
    else if (fired.current || dry.current > 0 || paused) {
      // Leaving the end region re-arms the end reach, as FlatList does.
      fired.current = false
      dry.current = 0
      setPaused(false)
    }
  }, [check, paused])
  // Short lists never scroll: their end reach comes from laying them out.
  const onContentSizeChange = useCallback((w, h) => {
    metrics.current = { ...metrics.current, content: h }
    measured.current = true
    endLayoutWait()
    check()
  }, [check])
  const onLayout = useCallback((e) => {
    metrics.current = { ...metrics.current, layout: e.nativeEvent.layout.height }
    check()
  }, [check])

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

  // The caller's footer (spinner, end text, error with retry), then, only
  // while paused after dry pages, a note and the by-hand 'carregar mais'.
  const footer = (
    <>
      {renderSlot(ListFooterComponent)}
      {showPaused
        ? (
          <View style={styles.moreBar}>
            <Text style={styles.pausedText}>Nada novo nas últimas páginas.</Text>
            <Pressable
              accessibilityRole='button'
              accessibilityLabel='carregar mais'
              onPress={loadByHand}
              hitSlop={4}
              style={({ pressed }) => [styles.moreAction, pressed && styles.pressed]}
            >
              <Text style={styles.moreText}>carregar mais</Text>
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
      {web
        ? (
          <Pressable
            accessibilityRole='button'
            accessibilityLabel='Atualizar'
            accessibilityState={{ disabled: !!refreshing || spinning }}
            disabled={!!refreshing || spinning}
            onPress={runRefresh}
            onFocus={() => setActionFocused(true)}
            onBlur={() => setActionFocused(false)}
            style={({ pressed }) => [actionFocused ? styles.webAction : styles.hiddenAction, pressed && styles.pressed]}
          >
            <Icon name='atualizar' size={16} color={colors.soft} />
            <Text style={styles.webText}>Atualizar</Text>
          </Pressable>
          )
        : null}
      <FlatList
        ref={setList}
        style={styles.list}
        data={data}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        extraData={extraData}
        ListHeaderComponent={ListHeaderComponent}
        ListFooterComponent={footer}
        ListEmptyComponent={ListEmptyComponent}
        contentContainerStyle={contentContainerStyle}
        onEndReached={check}
        onEndReachedThreshold={END_THRESHOLD}
        keyboardShouldPersistTaps='handled'
        onScroll={onScroll}
        onContentSizeChange={onContentSizeChange}
        onLayout={onLayout}
        scrollEventThrottle={16}
        dataSet={{ pull: 'y' }}
        refreshControl={web
          ? undefined
          : <RefreshControl refreshing={!!refreshing || spinning} onRefresh={runRefresh} tintColor={colors.accent} colors={[colors.accent]} />}
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
  // Off screen and invisible, yet focusable and read by screen readers.
  hiddenAction: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: 1,
    height: 1,
    overflow: 'hidden',
    opacity: 0
  },
  webAction: {
    position: 'absolute',
    top: 8,
    right: 8,
    zIndex: 4,
    borderRadius: 999,
    backgroundColor: colors.card,
    boxShadow: '0px 2px 8px rgba(0,0,0,0.15)',
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
  pausedText: { ...type.postMeta, color: colors.soft },
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
