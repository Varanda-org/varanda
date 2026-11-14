/* global requestAnimationFrame, cancelAnimationFrame */
// A bottom sheet with a top row (Cancelar, optional title, a right slot).
// iOS uses the native page sheet (it dims and shrinks the screen behind);
// Android and web draw a backdrop and a rounded panel. Modal unmounts its
// children when closed, so callers keep drafts outside the sheet. `background`
// colours the body down to the bottom edge (home indicator included); it
// defaults to the card colour.

import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Animated, Modal, PanResponder, Platform, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native'
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context'
import { Backdrop } from './Backdrop'
import { scrollerFocusProps } from './scrollerFocus'
import { useStyles, useTheme } from './ThemeProvider'
import { layout, motion, type } from './theme'
import { sideInset } from './sideInset'
import { useEscapeLayer } from './escapeLayer'
import { holdEmbeds } from '../embedLive'
import { ScreenVisible, SheetDepth } from './screenVisible'
import { useReduceMotion } from './StackLayer'
import { claimDrag, dragVerdict } from '../sheetDrag'

export const TEXT_CAP = 1.3
// The row's 16 pt edge plus 8 pt of air between a side control and the title.
const TITLE_GAP = 24
// A title that does not fit beside the side controls shrinks down to this
// share of its size before it is cut (a little further on a phone under
// 360 pt, where both side controls take more of the row).
const TITLE_MIN_SCALE = 0.7
const TITLE_MIN_SCALE_NARROW = 0.6
// Text does not narrow in proportion to its size (measured on the web: 5%
// wider than proportional near 70%), so the scale keeps this margin.
const TITLE_FIT_MARGIN = 0.93

// The title stays centred on the sheet but is padded by the wider of the two
// side controls, measured: with large text "‹ Ajustes" or "Cancelar" grow and a
// fixed padding let the title run into them. One line, capped growth, shrunk
// to fit before it is cut.
function TopRow ({ onClose, title, left, right }) {
  const styles = useStyles(makeStyles)
  const [sides, setSides] = useState({ left: 0, right: 0, row: 0 })
  const [natural, setNatural] = useState(0)
  const measure = (side) => (event) => {
    const w = Math.ceil(event.nativeEvent.layout.width)
    setSides((s) => (s[side] === w ? s : { ...s, [side]: w }))
  }
  const measureTitle = (event) => {
    const w = Math.ceil(event.nativeEvent.layout.width)
    setNatural((n) => (n === w ? n : w))
  }
  // Centred by the wider side; on a narrow phone (under 360 pt) each side
  // pads only its own control, so "Ajustes do grupo" beside a lone Cancelar
  // is not cut to "Ajustes do gru…" at 320.
  const pad = Math.max(sides.left, sides.right) + TITLE_GAP
  const narrow = sides.row > 0 && sides.row < 360
  const titlePad = narrow
    ? { paddingLeft: sides.left + TITLE_GAP, paddingRight: sides.right + TITLE_GAP }
    : { paddingHorizontal: pad }
  // The title's own width, measured on a hidden copy, against the room the
  // padding leaves: the font shrinks to fit (down to TITLE_MIN_SCALE) on
  // every platform, react-native-web included, where adjustsFontSizeToFit
  // does nothing ('Escrever depoimento' beside Cancelar and Enviar at 375).
  const room = sides.row > 0 ? sides.row - (narrow ? sides.left + sides.right + 2 * TITLE_GAP : 2 * pad) : 0
  const scale = natural > 0 && room > 0 && natural > room ? Math.max(narrow ? TITLE_MIN_SCALE_NARROW : TITLE_MIN_SCALE, (room / natural) * TITLE_FIT_MARGIN) : 1
  const fit = scale < 1 ? { fontSize: type.sheetTitle.fontSize * scale, lineHeight: Math.ceil(type.sheetTitle.lineHeight * scale) } : null
  return (
    <View style={styles.topRow} onLayout={measure('row')}>
      {title
        ? (
          <View style={[styles.titleWrap, titlePad]} pointerEvents='none'>
            <Text style={[styles.title, fit]} numberOfLines={1} maxFontSizeMultiplier={TEXT_CAP} adjustsFontSizeToFit minimumFontScale={narrow ? TITLE_MIN_SCALE_NARROW : TITLE_MIN_SCALE} accessibilityRole='header'>{title}</Text>
          </View>
          )
        : null}
      {title
        ? (
          <View style={styles.titleMeasure} pointerEvents='none' aria-hidden importantForAccessibility='no-hide-descendants' accessibilityElementsHidden>
            <Text style={styles.title} maxFontSizeMultiplier={TEXT_CAP} onLayout={measureTitle}>{title}</Text>
          </View>
          )
        : null}
      <View style={styles.side} onLayout={measure('left')}>
        {left !== undefined
          ? left
          : (
            <Pressable accessibilityRole='button' accessibilityLabel='Cancelar' onPress={onClose} hitSlop={8} style={styles.cancelHit}>
              <Text style={styles.cancel} maxFontSizeMultiplier={TEXT_CAP}>Cancelar</Text>
            </Pressable>
            )}
      </View>
      <View style={styles.side} onLayout={measure('right')}>{right || null}</View>
    </View>
  )
}

// Inside the iOS page sheet: its own safe-area insets.
function IosContent ({ onClose, title, left, right, background, grabber, children }) {
  const styles = useStyles(makeStyles)
  const insets = useSafeAreaInsets()
  return (
    <View style={styles.iosRoot}>
      <TopRow onClose={onClose} title={title} left={left} right={right} />
      {grabber ? <View style={styles.grabberRow} pointerEvents='none'><View style={styles.grabber} /></View> : null}
      <View style={[styles.children, { paddingBottom: insets.bottom, backgroundColor: background }]}>{children}</View>
    </View>
  )
}

function usePanelDrag ({ open, dismissable, onClose, reduceMotion }) {
  const y = useRef(new Animated.Value(0)).current
  const height = useRef(0)
  const active = useRef(false)
  // A touch that starts on the empty header moves nothing until claimDrag
  // accepts it, so a sideways swipe there cannot close the sheet.
  const unclaimed = useRef(false)
  const start = useRef(0)
  const [dragging, setDragging] = useState(false)
  const releaseTimer = useRef(null)
  const closeFrame = useRef(null)
  const latest = useRef(null)
  latest.current = { open, dismissable, onClose, reduceMotion }
  const finish = () => {
    active.current = false
    unclaimed.current = false
    clearTimeout(releaseTimer.current)
    // Keep header buttons out of hit testing until the release click is dispatched.
    releaseTimer.current = setTimeout(() => setDragging(false), 0)
  }
  const responder = useRef(null)
  if (responder.current === null) {
    const enabled = () => latest.current.open && latest.current.dismissable !== false
    const reset = (immediate = false) => {
      y.stopAnimation()
      if (!latest.current.open) return
      if (immediate || latest.current.reduceMotion) y.setValue(0)
      else Animated.timing(y, { toValue: 0, duration: motion.fast, useNativeDriver: false }).start()
    }
    const accepts = (_event, gesture) => {
      const yes = enabled() && claimDrag(gesture)
      if (yes) unclaimed.current = false
      return yes
    }
    responder.current = PanResponder.create({
      // React Native's Modal takes every touch start no child took, and then
      // offers the moves only to its own ancestors. So the header takes a touch
      // that starts on its empty part; a button inside it claims first.
      onStartShouldSetPanResponder: () => {
        const yes = enabled()
        unclaimed.current = yes
        return yes
      },
      onMoveShouldSetPanResponder: accepts,
      onMoveShouldSetPanResponderCapture: accepts,
      onPanResponderGrant: () => {
        clearTimeout(releaseTimer.current)
        cancelAnimationFrame(closeFrame.current)
        // A grab during the return animation continues from where the panel is.
        start.current = 0
        y.stopAnimation((value) => { start.current = Math.max(0, value) })
        active.current = enabled()
        setDragging(active.current)
      },
      onPanResponderMove: (_event, gesture) => {
        if (!enabled()) {
          finish()
          return reset(true)
        }
        if (!active.current) return
        if (unclaimed.current) {
          if (!claimDrag(gesture)) return
          unclaimed.current = false
        }
        y.setValue(Math.max(0, start.current + gesture.dy))
      },
      onPanResponderRelease: (_event, gesture) => {
        if (!active.current) return
        const close = !unclaimed.current && enabled() && dragVerdict({ ...gesture, dy: start.current + gesture.dy, height: height.current }) === 'close'
        finish()
        if (!close) return reset()
        latest.current.onClose()
        // Keep the release position during exit; a dirty draft may refuse to close.
        closeFrame.current = requestAnimationFrame(() => {
          if (latest.current.open) reset()
        })
      },
      onPanResponderTerminate: () => {
        finish()
        reset()
      },
      // react-native-web ends the responder on a text selection unless refused.
      onPanResponderTerminationRequest: () => !active.current || unclaimed.current
    })
  }
  useLayoutEffect(() => {
    finish()
    y.stopAnimation()
    if (open) y.setValue(0)
    return () => {
      active.current = false
      clearTimeout(releaseTimer.current)
      cancelAnimationFrame(closeFrame.current)
      y.stopAnimation()
    }
  }, [open, dismissable, reduceMotion, y])
  return {
    y,
    dragging,
    panHandlers: responder.current.panHandlers,
    handleLayout: (event) => { height.current = event.nativeEvent.layout.height }
  }
}

// `dismissable` false also turns off the native iOS swipe, which can close
// the page sheet without waiting for onClose (a sheet with a send in flight).
export function Sheet ({ open, onClose, onBack, title, left, right, background, grabber = true, dismissable = true, children }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  const bodyBackground = background ?? colors.card
  const insets = useSafeAreaInsets()
  const { width } = useWindowDimensions()
  const reduceMotion = useReduceMotion()
  const drag = usePanelDrag({ open, dismissable, onClose, reduceMotion })
  // Web: Escape closes this sheet only, not the screen behind it, and leaves
  // the key to a menu opened on top.
  useEscapeLayer(!!open, onClose, 'sheet')
  // An open sheet covers what is under it, so the players there unload, while
  // a card inside the sheet (the composer's preview) sees the sheet as its
  // screen.
  const depth = useContext(SheetDepth)
  useEffect(() => (open ? holdEmbeds() : undefined), [open])
  const body = <SheetDepth.Provider value={depth + 1}><ScreenVisible.Provider value={!!open}>{children}</ScreenVisible.Provider></SheetDepth.Provider>
  if (Platform.OS === 'ios') {
    return (
      <Modal
        visible={!!open}
        animationType={reduceMotion ? 'none' : 'slide'}
        presentationStyle='pageSheet'
        // A swipe down has already dismissed the page sheet when this runs,
        // so it always closes (onBack is the Android back button only).
        onRequestClose={onClose}
        allowSwipeDismissal={dismissable}
      >
        <SafeAreaProvider>
          <IosContent onClose={onClose} title={title} left={left} right={right} background={bodyBackground} grabber={grabber}>{body}</IosContent>
        </SafeAreaProvider>
      </Modal>
    )
  }
  // Landscape notch/cutout. Web centres the panel (auto margins), so only the
  // part of each side inset that centring leaves uncovered is padded; native
  // pads the whole inset rather than rely on Yoga centring an absolute box.
  const web = Platform.OS === 'web'
  const padL = web ? sideInset(insets.left, width, layout.column) : insets.left
  const padR = web ? sideInset(insets.right, width, layout.column) : insets.right
  return (
    <Modal
      visible={!!open}
      animationType={reduceMotion ? 'none' : 'slide'}
      transparent
      statusBarTranslucent
      onRequestClose={typeof onBack === 'function' ? onBack : onClose}
    >
      <Backdrop style={styles.backdrop} onClose={onClose} />
      <Animated.View style={[styles.panel, { top: insets.top + layout.sheetTop, transform: [{ translateY: drag.y }] }]} onLayout={drag.handleLayout} {...scrollerFocusProps}>
        {/* Android flattens a layout-only View, so a touch on the empty header
            would land on the panel and never reach these handlers. */}
        <View style={[styles.dragHeader, { paddingLeft: padL, paddingRight: padR }]} collapsable={false} {...drag.panHandlers}>
          <View pointerEvents={drag.dragging ? 'none' : 'auto'}>
            {grabber ? <View style={styles.grabberRow} pointerEvents='none'><View style={styles.grabber} /></View> : null}
            <TopRow onClose={onClose} title={title} left={left} right={right} />
          </View>
        </View>
        <View style={[styles.children, { paddingBottom: insets.bottom, paddingLeft: padL, paddingRight: padR, backgroundColor: bodyBackground }]}>{body}</View>
      </Animated.View>
    </Modal>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  // A 44 pt target: the word alone was 22 pt tall.
  cancelHit: { minHeight: 44, justifyContent: 'center' },
  // The browser must not take over a vertical header drag for page scrolling
  // or turn it into a text selection.
  dragHeader: Platform.select({ web: { touchAction: 'pan-x', userSelect: 'none' }, default: {} }),
  iosRoot: { flex: 1, backgroundColor: colors.card },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.45)' },
  panel: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    width: '100%',
    maxWidth: layout.column,
    // Web: an absolutely positioned box applies align-self along the block
    // (vertical) axis, which centred the panel vertically; the auto side
    // margins centre it there. Yoga centres it with alignSelf.
    ...Platform.select({ web: {}, default: { alignSelf: 'center' } }),
    marginHorizontal: 'auto',
    backgroundColor: colors.card,
    borderTopLeftRadius: layout.sheetRadius,
    borderTopRightRadius: layout.sheetRadius,
    overflow: 'hidden'
  },
  // Floats over the top row so the row does not move. Drawn on iOS too: the
  // page sheet has no system grabber (prefersGrabberVisible is never set).
  // A full-width row centres the pill on every platform (absolute + alignSelf
  // centres on the wrong axis on the web) and takes no touches.
  grabberRow: { position: 'absolute', top: 6, left: 0, right: 0, alignItems: 'center', zIndex: 1 },
  grabber: { width: 36, height: 4, borderRadius: 2, backgroundColor: colors.line },
  topRow: {
    height: layout.sheetTopRow,
    paddingHorizontal: 16,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center'
  },
  titleWrap: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  // Off screen and invisible: only its width is read.
  titleMeasure: { position: 'absolute', left: 0, top: 0, opacity: 0 },
  side: { flexShrink: 0, flexDirection: 'row', alignItems: 'center' },
  title: { ...type.sheetTitle, color: colors.ink, textAlign: 'center' },
  cancel: { ...type.cancel, color: colors.ink },
  children: { flex: 1 }
})
