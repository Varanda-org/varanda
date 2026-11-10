// The actions of one message (or any item) in a compact bottom panel: one 44 pt row per
// action, an icon and a label, danger rows in the danger colour. A row closes
// the sheet first and then runs its onPress once it is gone, so an action that opens another
// sheet or a confirmation never stacks on this one. A light haptic marks the
// opening, which is what tells a long press it worked.
//
// Props: { open, onClose, title, actions: [{ icon, label, danger, disabled, pending, selected, description, onPress }] }
// Rows without a label or an onPress function are skipped. A disabled or
// pending row is shown but does not run; `description` is a Soft line under the label.
// `selected` marks the current choice of a picker with a check at the end, at
// full strength even when it is also disabled. The title is a small caption
// over a divider, so it never reads as one more row.

import { useEffect, useRef } from 'react'
import { displayText } from '@varanda/rpc'
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { tap } from './haptics'
import { Backdrop } from './Backdrop'
import { scrollerFocusProps } from './scrollerFocus'
import { Icon } from './Icon'
import { escapeLayerCount, useEscapeLayer } from './escapeLayer'
import { useStyles, useTheme } from './ThemeProvider'
import { layout, radius, space, type } from './theme'

// Open menus, so a parent layer with its own key handling can leave Escape
// to the menu on top of it.
export function actionsSheetOpen () {
  return escapeLayerCount('actions') > 0
}

export function usableActions (actions) {
  return (Array.isArray(actions) ? actions : [])
    .filter((a) => a && typeof a.label === 'string' && a.label !== '' && typeof a.onPress === 'function')
}

export function ActionsSheet ({ open, onClose, title, actions }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()
  const { height } = useWindowDimensions()
  const rows = usableActions(actions)
  const shown = !!open && rows.length > 0
  useEffect(() => {
    if (shown) tap()
  }, [shown])
  // Web: Escape closes only this menu, never the sheet or screen under it.
  useEscapeLayer(shown, onClose, 'actions')
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
        <Backdrop style={styles.backdrop} onClose={onClose} />
        {/* Capped at 85% of the screen and scrolling inside: long labels at
            large text can make a menu taller than a small phone. */}
        <View style={[styles.panel, { paddingBottom: Math.max(space.md, insets.bottom), maxHeight: Math.round(height * 0.85) }]} {...scrollerFocusProps}>
          <View style={styles.grabber} />
          {typeof title === 'string' && title !== ''
            ? <View style={styles.titleBox}><Text style={styles.title} numberOfLines={1} accessibilityRole='header'>{displayText(title)}</Text></View>
            : null}
          <ScrollView bounces={false} style={styles.rows} keyboardShouldPersistTaps='handled'>
            {rows.map((a, i) => {
              const tint = a.danger ? colors.danger : colors.ink
              const off = a.disabled === true || a.pending === true
              const selected = a.selected === true
              return (
                <Pressable
                  key={i + ':' + a.label}
                  accessibilityRole='button'
                  accessibilityLabel={typeof a.description === 'string' && a.description !== '' ? a.label + ', ' + a.description : a.label}
                  accessibilityState={{ disabled: off, busy: a.pending === true, selected }}
                  disabled={off}
                  onPress={off ? undefined : run(a.onPress)}
                  style={({ pressed }) => [styles.row, off && !selected && styles.off, pressed && !off && styles.pressed]}
                >
                  {typeof a.icon === 'string' ? <Icon name={a.icon} size={22} color={tint} /> : null}
                  <View style={styles.text}>
                    <Text style={[styles.label, { color: tint }]}>{a.pending ? a.label + '…' : a.label}</Text>
                    {typeof a.description === 'string' && a.description !== '' ? <Text style={styles.description}>{displayText(a.description)}</Text> : null}
                  </View>
                  {selected ? <Icon name='ok' size={22} color={colors.accent} /> : null}
                </Pressable>
              )
            })}
          </ScrollView>
        </View>
      </View>
    </Modal>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  fill: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: colors.dim },
  rows: { flexGrow: 0 },
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
  titleBox: { paddingHorizontal: space.xl, paddingBottom: space.sm, marginBottom: space.xs, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  title: { ...type.replyMark, fontWeight: '600', color: colors.soft },
  row: {
    minHeight: layout.hit + space.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.lg,
    paddingHorizontal: space.xl
  },
  text: { flex: 1, minWidth: 0, paddingVertical: space.xs },
  label: { ...type.cancel },
  description: { ...type.replyMark, color: colors.soft },
  off: { opacity: 0.45 },
  pressed: { backgroundColor: colors.skeleton }
})
