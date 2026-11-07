// The actions of one message (or any item) in a compact bottom panel: one 44 pt row per
// action, an icon and a label, danger rows in the danger colour. A row closes
// the sheet first and then runs its onPress once it is gone, so an action that opens another
// sheet or a confirmation never stacks on this one. A light haptic marks the
// opening, which is what tells a long press it worked.
//
// Props: { open, onClose, title, actions: [{ icon, label, danger, onPress }] }
// Rows without a label or an onPress function are skipped.

import { useEffect, useRef } from 'react'
import { displayText } from '@varanda/rpc'
import { Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { tap } from './haptics'
import { Icon } from './Icon'
import { useStyles, useTheme } from './ThemeProvider'
import { layout, radius, space, type } from './theme'

export function usableActions (actions) {
  return (Array.isArray(actions) ? actions : [])
    .filter((a) => a && typeof a.label === 'string' && a.label !== '' && typeof a.onPress === 'function')
}

export function ActionsSheet ({ open, onClose, title, actions }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()
  const rows = usableActions(actions)
  const shown = !!open && rows.length > 0
  useEffect(() => {
    if (shown) tap()
  }, [shown])
  // A row's action runs only once the sheet is gone: the iOS page sheet
  // dismisses asynchronously, so an action that presents another sheet, an
  // Alert or a confirmation right away would collide with it. iOS flushes on
  // the Modal's onDismiss; Android and web have none, so the action runs one
  // tick after `open` turns false. The ref makes it run once, and unmounting
  // drops it.
  const pending = useRef(null)
  const flush = () => {
    const fn = pending.current
    pending.current = null
    if (typeof fn === 'function') fn()
  }
  useEffect(() => {
    if (shown) return undefined
    // Modal reports its dismissal on iOS and on the web (where the closing
    // animation still holds focus), so the action waits for onDismiss there and
    // the timer only covers a dismiss that never reports. Android's Modal has
    // no onDismiss: the action waits out the slide (about 250 ms), or a sheet it
    // opens would be presented while this one is still leaving.
    const t = setTimeout(flush, Platform.OS === 'android' ? 320 : 700)
    return () => clearTimeout(t)
  }, [shown])
  useEffect(() => () => { pending.current = null }, [])
  const run = (fn) => () => {
    if (pending.current !== null) return
    pending.current = fn
    if (typeof onClose === 'function') onClose()
    else flush()
  }
  return (
    // A compact bottom panel as tall as its rows, as the message menus of the
    // chat apps are: a full-height sheet for three actions reads as a new page.
    <Modal visible={shown} transparent animationType='slide' statusBarTranslucent onRequestClose={onClose} onDismiss={flush}>
      <View style={styles.fill}>
        <Pressable style={styles.backdrop} accessibilityRole='button' accessibilityLabel='fechar' onPress={onClose} />
        <View style={[styles.panel, { paddingBottom: Math.max(space.md, insets.bottom) }]}>
          <View style={styles.grabber} />
          {typeof title === 'string' && title !== '' ? <Text style={styles.title} numberOfLines={1}>{displayText(title)}</Text> : null}
          {rows.map((a, i) => {
            const tint = a.danger ? colors.danger : colors.ink
            return (
              <Pressable
                key={i + ':' + a.label}
                accessibilityRole='button'
                accessibilityLabel={a.label}
                onPress={run(a.onPress)}
                style={({ pressed }) => [styles.row, pressed && styles.pressed]}
              >
                {typeof a.icon === 'string' ? <Icon name={a.icon} size={22} color={tint} /> : null}
                <Text style={[styles.label, { color: tint }]} numberOfLines={1}>{a.label}</Text>
              </Pressable>
            )
          })}
        </View>
      </View>
    </Modal>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  fill: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: colors.dim },
  panel: {
    width: '100%',
    maxWidth: layout.column,
    alignSelf: 'center',
    backgroundColor: colors.card,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    paddingTop: space.sm
  },
  grabber: { alignSelf: 'center', width: 36, height: 5, borderRadius: radius.pill, backgroundColor: colors.line, marginBottom: space.sm },
  title: { ...type.cancel, color: colors.soft, paddingHorizontal: space.xl, paddingBottom: space.sm },
  row: {
    minHeight: layout.hit + space.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.lg,
    paddingHorizontal: space.xl
  },
  label: { ...type.cancel, flexShrink: 1 },
  pressed: { backgroundColor: colors.skeleton }
})
