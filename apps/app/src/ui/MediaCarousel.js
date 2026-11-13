// Shared by the in-feed frame and the full-screen viewer. The index is
// controlled: a settled scroll reports the page through onIndex, and a change
// that did not come from the scroll (chevrons, keys, the viewer's buttons)
// scrolls to that page. Pages mount near the open one and then stay mounted,
// so a swipe back does not fetch again. The frame is not one accessibility
// control: that would collapse every photo button into it and VoiceOver would
// lose open and retry. The scroller installs no responder, so the vertical
// feed, pull to refresh and the back-edge swipe keep the gesture; only the
// viewer opts its pages into one (claimTouch, below).

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Animated, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { counterShown, counterText, dotWindow, offsetOf, pageAt, shouldMount, slideLabel, stepIndex } from '../carousel'
import { Icon } from './Icon'
import { MediaView } from './MediaView'
import { useReduceMotion } from './StackLayer'
import { useStyles } from './ThemeProvider'
import { layout, motion, radius, space } from './theme'

// Pages are whole. A fractional or inverted index would land in a gap and the
// next settle would fight the prop, so it is rounded and then clamped.
function clampIndex (index, count) {
  if (!Number.isInteger(count) || count < 1 || !Number.isFinite(index)) return 0
  const whole = Math.round(index)
  if (whole < 0) return 0
  if (whole > count - 1) return count - 1
  return whole
}

// claimTouch: on Android a JS responder that is an ancestor of a native scroll
// view intercepts the whole gesture, so the scroll never pages. A parent that
// claims every touch (the viewer's root) would become that responder over a
// photo with no onPress; a page that claims first keeps the responder below
// the scroll view, as a pressable photo does in the feed.
const claim = () => true

function dotLook (styles, dark, active) {
  if (dark) return active ? styles.dotOnDark : styles.dotOffDark
  return active ? styles.dotOn : styles.dotOff
}

function offsetX (event) {
  const native = event && event.nativeEvent
  const x = native && native.contentOffset && native.contentOffset.x
  return typeof x === 'number' ? x : null
}

function pointerTypeOf (event) {
  const native = event && event.nativeEvent
  return (native && native.pointerType) || (event && event.pointerType) || ''
}

// A tap, a click and the focus a pointer close hands back to the photo do not
// match :focus-visible, so they must not open the chevrons. matches is a
// browser capability: without it (native) this is not a keyboard focus.
function keyboardFocus (event) {
  const target = event && event.target
  if (!target || typeof target.matches !== 'function') return false
  return target.matches(':focus-visible') === true
}

export function MediaCarousel ({
  author,
  media,
  persist = true,
  index,
  onIndex,
  fit,
  dark,
  onPressItem,
  showDots,
  showCounter,
  showArrows,
  frameStyle,
  style,
  claimTouch = false,
  focusRequest = 0
}) {
  const styles = useStyles(makeStyles)
  const reduce = useReduceMotion()
  const items = Array.isArray(media) ? media : []
  const count = items.length
  const page = clampIndex(index, count)
  const [width, setWidth] = useState(0)
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const prevArrow = useRef(null)
  const nextArrow = useRef(null)
  // The chevron to focus once the page changes: 'prev', 'next' or null.
  const refocus = useRef(null)
  const counterOpacity = useRef(new Animated.Value(1)).current
  // Stays false until the first jump has been asked for, so a viewer that
  // opens past the first photo does not paint page 0.
  const [ready, setReady] = useState(false)
  const scroller = useRef(null)
  const target = useRef(null)
  const targetTimer = useRef(null)
  const lastX = useRef(0)
  const reported = useRef(page)
  const placedRef = useRef(false)
  const seenWidth = useRef(0)
  const widthRef = useRef(0)
  const countRef = useRef(count)
  const onIndexRef = useRef(onIndex)
  const mounted = useRef(new Set())
  const pageNodes = useRef([])
  // First paint only. Updating it later would snap an animated move.
  const hint = useRef(null)
  const measured = Number.isFinite(width) && width > 0
  const many = count > 1
  const dots = dotWindow(page, count)

  widthRef.current = width
  countRef.current = count
  onIndexRef.current = onIndex
  if (!measured || !many) hint.current = null
  else if (hint.current === null) hint.current = { x: offsetOf(page, width), y: 0 }

  useEffect(() => () => clearTimeout(targetTimer.current), [])

  useLayoutEffect(() => {
    const shown = showCounter && counterShown({ many, measured, idleMs: 0, hold: motion.hold })
    counterOpacity.setValue(shown ? 1 : 0)
    if (!shown) return
    let fade = null
    const timer = setTimeout(() => {
      if (reduce) {
        counterOpacity.setValue(0)
      } else {
        fade = Animated.timing(counterOpacity, {
          toValue: 0,
          duration: motion.normal,
          useNativeDriver: false,
          isInteraction: false
        })
        fade.start()
      }
    }, motion.hold)
    return () => {
      clearTimeout(timer)
      if (fade) fade.stop()
    }
  }, [page, many, measured, showCounter, reduce, counterOpacity])

  // On the web a closing viewer hands focus back to the photo that opened it,
  // which may no longer be the one on screen; Enter would reopen it. Focus
  // moves to the visible photo, only when it is already inside this strip and
  // without scrolling, which would cut the move short. The shell judges that
  // focus with :focus-visible: a pointer close does not open the chevrons, and
  // a keyboard close (Escape) may. Fabric nodes have ownerDocument and contains
  // too, but no querySelector nor activeElement (contains(undefined) throws),
  // so both are probed first.
  useEffect(() => {
    if (!focusRequest) return
    const strip = scroller.current
    const node = pageNodes.current[page]
    if (!strip || !node || typeof node.querySelector !== 'function') return
    const doc = strip.ownerDocument
    const active = doc && doc.activeElement
    if (!active || typeof strip.contains !== 'function' || !strip.contains(active)) return
    const button = node.querySelector('[role="button"]')
    if (button && button !== active && typeof button.focus === 'function') button.focus({ preventScroll: true })
  }, [focusRequest])

  // While a programmatic scroll animates, intermediate offsets still round to
  // the page we left; they must not be reported. The web ScrollView never
  // reports a drag or a momentum end, so a gesture that interrupts the
  // animation would leave the target set: a timer clears it.
  function settle (x) {
    lastX.current = x
    if (placedRef.current === false) return
    const w = widthRef.current
    const n = countRef.current
    if (!(w > 0) || n < 2) return
    if (target.current !== null) {
      if (Math.abs(x - offsetOf(target.current, w)) > 1) return
      target.current = null
      clearTimeout(targetTimer.current)
    }
    const next = pageAt(x, w, n)
    if (next === reported.current) return
    reported.current = next
    if (typeof onIndexRef.current === 'function') onIndexRef.current(next)
  }

  useLayoutEffect(() => {
    if (!(width > 0) || count < 2) return
    const node = scroller.current
    if (!node || typeof node.scrollTo !== 'function') return
    const first = placedRef.current === false
    const widthChanged = seenWidth.current !== width
    if (!first && !widthChanged && page === reported.current) return
    seenWidth.current = width
    const animated = first === false && widthChanged === false && reduce === false
    clearTimeout(targetTimer.current)
    if (animated) {
      target.current = page
      targetTimer.current = setTimeout(() => {
        target.current = null
        // A focus change can stop the animation without any scroll event; a
        // strip that knows its offset (the web) is trusted over lastX.
        const strip = scroller.current
        const x = strip && typeof strip.scrollLeft === 'number' ? strip.scrollLeft : lastX.current
        const next = pageAt(x, widthRef.current, countRef.current)
        if (next === reported.current) return
        reported.current = next
        if (typeof onIndexRef.current === 'function') onIndexRef.current(next)
      }, 800)
    } else {
      target.current = null
    }
    reported.current = page
    lastX.current = offsetOf(page, width)
    node.scrollTo({ x: offsetOf(page, width), y: 0, animated })
    if (first) {
      placedRef.current = true
      setReady(true)
    }
  }, [width, page, count, reduce])

  function onFrameLayout (event) {
    const next = event && event.nativeEvent && event.nativeEvent.layout
      ? event.nativeEvent.layout.width
      : 0
    if (!Number.isFinite(next) || next <= 0) return
    setWidth((prev) => (Math.abs(prev - next) < 0.5 ? prev : next))
  }

  function go (delta) {
    if (typeof onIndex !== 'function') return
    const next = stepIndex(page, delta, count)
    refocus.current = null
    // The pressed chevron unmounts at either end of the strip, and focus
    // would fall to the document. A keyboard user keeps focus on the other
    // chevron; otherwise focus is cleared, since React delivers no blur for
    // an unmounted node.
    if (next !== page && (next === 0 || next === count - 1)) {
      if (focused) refocus.current = next === 0 ? 'next' : 'prev'
      else setFocused(false)
    }
    onIndex(next)
  }

  useEffect(() => {
    const side = refocus.current
    refocus.current = null
    if (!side) return
    const node = side === 'prev' ? prevArrow.current : nextArrow.current
    if (node && typeof node.focus === 'function') node.focus({ preventScroll: true })
    else setFocused(false)
  }, [page])

  const conceal = many && page !== 0 && ready === false
  let strip = null
  if (count === 1) {
    strip = (
      <MediaView
        author={author}
        descriptor={items[0]}
        persist={persist}
        dark={dark}
        fit={fit}
        label={slideLabel(0, count)}
        style={styles.fill}
        onPress={onPressItem ? () => onPressItem(0) : undefined}
      />
    )
  } else if (many && measured) {
    strip = (
      <ScrollView
        ref={scroller}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        scrollEventThrottle={16}
        style={[styles.scroller, conceal && styles.concealed]}
        contentContainerStyle={styles.strip}
        contentOffset={hint.current}
        onScroll={(event) => {
          const x = offsetX(event)
          if (x !== null) settle(x)
        }}
        onScrollBeginDrag={() => {
          target.current = null
          clearTimeout(targetTimer.current)
        }}
        onMomentumScrollEnd={(event) => {
          target.current = null
          clearTimeout(targetTimer.current)
          const x = offsetX(event)
          if (x !== null) settle(x)
        }}
      >
        {items.map((descriptor, i) => {
          if (shouldMount(i, page)) mounted.current.add(i)
          const live = mounted.current.has(i)
          const current = i === page
          // A page not yet mounted stays empty and transparent: on Android a
          // childless page with a background kept the strip from starting a
          // drag. The neighbours are always mounted, so one is never on screen.
          // A hidden page's photo also leaves the Tab order: focus there
          // would scroll the strip and land on a button screen readers skip.
          return (
            <View
              key={i}
              ref={(node) => { pageNodes.current[i] = node }}
              style={{ width, height: '100%', position: 'relative' }}
              accessibilityElementsHidden={current === false}
              importantForAccessibility={current ? 'auto' : 'no-hide-descendants'}
              aria-hidden={current === false}
              onStartShouldSetResponder={claimTouch ? claim : undefined}
            >
              {live
                ? (
                  <MediaView
                    author={author}
                    descriptor={descriptor}
                    persist={persist}
                    dark={dark}
                    fit={fit}
                    label={slideLabel(i, count)}
                    style={styles.fill}
                    tabIndex={current ? undefined : -1}
                    onPress={onPressItem ? () => onPressItem(i) : undefined}
                  />
                  )
                : null}
            </View>
          )
        })}
      </ScrollView>
    )
  }

  const counterNode = showCounter && many && measured
    ? (
      <Animated.View
        pointerEvents='none'
        style={[styles.counter, { opacity: counterOpacity }]}
        accessibilityElementsHidden
        importantForAccessibility='no-hide-descendants'
        aria-hidden
      >
        <Text style={styles.counterText}>{counterText(page, count)}</Text>
      </Animated.View>
      )
    : null

  const chevronNode = showArrows && (hovered || focused) && many && measured
    ? (
      <>
        {page > 0
          ? (
            <Pressable
              ref={prevArrow}
              accessibilityRole='button'
              accessibilityLabel='foto anterior'
              onPress={() => go(-1)}
              style={[styles.arrow, styles.arrowLeft]}
            >
              <Icon name='chevron-left' size={24} color='#ffffff' />
            </Pressable>
            )
          : null}
        {page < count - 1
          ? (
            <Pressable
              ref={nextArrow}
              accessibilityRole='button'
              accessibilityLabel='próxima foto'
              onPress={() => go(1)}
              style={[styles.arrow, styles.arrowRight]}
            >
              <Icon name='chevron-right' size={24} color='#ffffff' />
            </Pressable>
            )
          : null}
      </>
      )
    : null

  // Android drops an empty view from layout; the frame has to report a width
  // before the strip can mount inside it.
  const frameNode = (
    <View
      style={[styles.frame, frameStyle]}
      onLayout={onFrameLayout}
      accessible={false}
      collapsable={false}
    >
      {strip}
      {counterNode}
      {chevronNode}
    </View>
  )

  const dotsNode = showDots && many && measured
    ? (
      <View
        style={styles.dots}
        pointerEvents='none'
        accessible={false}
        accessibilityElementsHidden
        importantForAccessibility='no-hide-descendants'
        aria-hidden
      >
        {items.slice(dots.start, dots.end).map((_, i) => (
          <View key={dots.start + i} style={[styles.dot, dotLook(styles, dark, dots.start + i === page)]} />
        ))}
      </View>
      )
    : null

  // A mouse can hover but cannot drag a paging ScrollView. Keyboard focus
  // reveals the chevrons too, judged by :focus-visible on the event target
  // (a tap, a click, or button.focus() after a pointer close do not match).
  // The shell is not focusable: that would add a tab stop per post, and on
  // Android tabIndex becomes focusable. Plain pointer events, not a
  // Pressable's hover: each slide is a Pressable, and on the web entering
  // one ends the hover of every Pressable around it.
  const framed = showArrows && many
    ? (
      <View
        style={styles.shell}
        onFocus={(event) => setFocused(keyboardFocus(event))}
        onBlur={(event) => {
          const next = event.relatedTarget || (event.nativeEvent && event.nativeEvent.relatedTarget)
          const shell = event.currentTarget
          if (next && shell && typeof shell.contains === 'function' && shell.contains(next)) return
          setFocused(false)
        }}
        onPointerEnter={(event) => { if (pointerTypeOf(event) !== 'touch') setHovered(true) }}
        onPointerLeave={() => setHovered(false)}
      >
        {frameNode}
      </View>
      )
    : frameNode

  return (
    <View style={style} accessible={false}>
      {framed}
      {dotsNode}
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  frame: { position: 'relative' },
  // Grow, not flex 1: in the feed the parent has no height, and a zero flex
  // basis there collapses the shell under its own photo on native.
  shell: { flexGrow: 1 },
  scroller: { flex: 1 },
  strip: { height: '100%' },
  concealed: { opacity: 0 },
  // Absolute, so a frame sized only by aspect ratio still has a photo in it.
  // A flex child of that frame collapses or stretches the ratio.
  fill: { ...StyleSheet.absoluteFillObject },
  counter: {
    position: 'absolute',
    top: 10,
    right: 10,
    paddingHorizontal: space.sm,
    paddingVertical: 3,
    borderRadius: radius.sm,
    backgroundColor: 'rgba(0,0,0,0.55)'
  },
  counterText: { color: '#ffffff', fontSize: 12, lineHeight: 16, fontWeight: '600' },
  dots: {
    marginTop: space.sm,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: space.xs
  },
  dot: { width: 6, height: 6, borderRadius: 3 },
  dotOn: { backgroundColor: colors.accent },
  // The hairline token (10% ink) vanishes on a 6 pt dot, and the soft text ink
  // is too close to the accent to tell which dot is current.
  dotOff: { backgroundColor: colors.outline },
  dotOnDark: { backgroundColor: '#ffffff' },
  dotOffDark: { backgroundColor: 'rgba(255,255,255,0.4)' },
  arrow: {
    position: 'absolute',
    top: '50%',
    width: layout.hit,
    height: layout.hit,
    marginTop: -(layout.hit / 2),
    borderRadius: layout.hit / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)'
  },
  arrowLeft: { left: space.sm },
  arrowRight: { right: space.sm }
})
