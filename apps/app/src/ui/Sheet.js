// A bottom sheet with a top row (Cancelar, optional title, a right slot).
// iOS uses the native page sheet (it dims and shrinks the screen behind);
// Android and web draw a backdrop and a rounded panel. Modal unmounts its
// children when closed, so callers keep drafts outside the sheet. `background`
// colours the body down to the bottom edge (home indicator included); it
// defaults to the card colour.

import { useState } from 'react'
import { Modal, Platform, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native'
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context'
import { Backdrop } from './Backdrop'
import { scrollerFocusProps } from './scrollerFocus'
import { useStyles, useTheme } from './ThemeProvider'
import { layout, type } from './theme'
import { sideInset } from './sideInset'
import { useEscapeLayer } from './escapeLayer'

export const TEXT_CAP = 1.3
// The row's 16 pt edge plus 8 pt of air between a side control and the title.
const TITLE_GAP = 24

// The title stays centred on the sheet but is padded by the wider of the two
// side controls, measured: with large text "‹ Ajustes" or "Cancelar" grow and a
// fixed padding let the title run into them. One line, capped growth.
function TopRow ({ onClose, title, left, right }) {
  const styles = useStyles(makeStyles)
  const [sides, setSides] = useState({ left: 0, right: 0, row: 0 })
  const measure = (side) => (event) => {
    const w = Math.ceil(event.nativeEvent.layout.width)
    setSides((s) => (s[side] === w ? s : { ...s, [side]: w }))
  }
  // Centred by the wider side; on a narrow phone (under 360 pt) each side
  // pads only its own control, so "Ajustes do grupo" beside a lone Cancelar
  // is not cut to "Ajustes do gru…" at 320.
  const pad = Math.max(sides.left, sides.right) + TITLE_GAP
  const titlePad = sides.row > 0 && sides.row < 360
    ? { paddingLeft: sides.left + TITLE_GAP, paddingRight: sides.right + TITLE_GAP }
    : { paddingHorizontal: pad }
  return (
    <View style={styles.topRow} onLayout={measure('row')}>
      {title
        ? (
          <View style={[styles.titleWrap, titlePad]} pointerEvents='none'>
            <Text style={styles.title} numberOfLines={1} maxFontSizeMultiplier={TEXT_CAP} accessibilityRole='header'>{title}</Text>
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

// `dismissable` false turns off the iOS swipe-down, which can close the page
// sheet without waiting for onClose (a sheet with a send in flight).
export function Sheet ({ open, onClose, onBack, title, left, right, background, grabber = false, dismissable = true, children }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  const bodyBackground = background ?? colors.card
  const insets = useSafeAreaInsets()
  const { width } = useWindowDimensions()
  // Web: Escape closes this sheet only, not the screen behind it, and leaves
  // the key to a menu opened on top.
  useEscapeLayer(!!open, onClose, 'sheet')
  if (Platform.OS === 'ios') {
    return (
      <Modal
        visible={!!open}
        animationType='slide'
        presentationStyle='pageSheet'
        // A swipe down has already dismissed the page sheet when this runs,
        // so it always closes (onBack is the Android back button only).
        onRequestClose={onClose}
        allowSwipeDismissal={dismissable}
      >
        <SafeAreaProvider>
          <IosContent onClose={onClose} title={title} left={left} right={right} background={bodyBackground} grabber={grabber}>{children}</IosContent>
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
      animationType='slide'
      transparent
      statusBarTranslucent
      onRequestClose={typeof onBack === 'function' ? onBack : onClose}
    >
      <Backdrop style={styles.backdrop} onClose={onClose} />
      <View style={[styles.panel, { top: insets.top + layout.sheetTop }]} {...scrollerFocusProps}>
        {grabber ? <View style={styles.grabberRow} pointerEvents='none'><View style={styles.grabber} /></View> : null}
        <View style={{ paddingLeft: padL, paddingRight: padR }}>
          <TopRow onClose={onClose} title={title} left={left} right={right} />
        </View>
        <View style={[styles.children, { paddingBottom: insets.bottom, paddingLeft: padL, paddingRight: padR, backgroundColor: bodyBackground }]}>{children}</View>
      </View>
    </Modal>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  // A 44 pt target: the word alone was 22 pt tall.
  cancelHit: { minHeight: 44, justifyContent: 'center' },
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
  side: { flexShrink: 0, flexDirection: 'row', alignItems: 'center' },
  title: { ...type.sheetTitle, color: colors.ink, textAlign: 'center' },
  cancel: { ...type.cancel, color: colors.ink },
  children: { flex: 1 }
})
