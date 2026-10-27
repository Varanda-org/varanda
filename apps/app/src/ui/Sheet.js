// A bottom sheet with a top row (Cancelar, optional title, a right slot).
// iOS uses the native page sheet (it dims and shrinks the screen behind);
// Android and web draw a backdrop and a rounded panel. Modal unmounts its
// children when closed, so callers keep drafts outside the sheet. `background`
// colours the body down to the bottom edge (home indicator included); it
// defaults to white.

import { Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native'
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context'
import { colors, layout, type } from './theme'

function TopRow ({ onClose, title, left, right }) {
  return (
    <View style={styles.topRow}>
      {title
        ? (
          <View style={styles.titleWrap} pointerEvents='none'>
            <Text style={styles.title} numberOfLines={2} accessibilityRole='header'>{title}</Text>
          </View>
          )
        : null}
      {left !== undefined
        ? left
        : (
          <Pressable accessibilityRole='button' accessibilityLabel='Cancelar' onPress={onClose} hitSlop={8}>
            <Text style={styles.cancel}>Cancelar</Text>
          </Pressable>
          )}
      {right || null}
    </View>
  )
}

// Inside the iOS page sheet: its own safe-area insets.
function IosContent ({ onClose, title, left, right, background, children }) {
  const insets = useSafeAreaInsets()
  return (
    <View style={styles.iosRoot}>
      <TopRow onClose={onClose} title={title} left={left} right={right} />
      <View style={[styles.children, { paddingBottom: insets.bottom, backgroundColor: background }]}>{children}</View>
    </View>
  )
}

export function Sheet ({ open, onClose, title, left, right, background = colors.card, children }) {
  const insets = useSafeAreaInsets()
  if (Platform.OS === 'ios') {
    return (
      <Modal
        visible={!!open}
        animationType='slide'
        presentationStyle='pageSheet'
        onRequestClose={onClose}
        allowSwipeDismissal
      >
        <SafeAreaProvider>
          <IosContent onClose={onClose} title={title} left={left} right={right} background={background}>{children}</IosContent>
        </SafeAreaProvider>
      </Modal>
    )
  }
  return (
    <Modal
      visible={!!open}
      animationType='slide'
      transparent
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <Pressable style={styles.backdrop} accessibilityRole='button' accessibilityLabel='fechar' onPress={onClose} />
      <View style={[styles.panel, { top: insets.top + layout.sheetTop }]}>
        <TopRow onClose={onClose} title={title} left={left} right={right} />
        <View style={[styles.children, { paddingBottom: insets.bottom, backgroundColor: background }]}>{children}</View>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
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
  topRow: {
    height: layout.sheetTopRow,
    paddingHorizontal: 16,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center'
  },
  titleWrap: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 96 },
  title: { ...type.sheetTitle, color: colors.ink },
  cancel: { ...type.cancel, color: colors.ink },
  children: { flex: 1 }
})
