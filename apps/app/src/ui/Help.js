// Help that stays out of the way: an info button opens a sheet with
// the explanation. A doc is { title, paragraphs }, the app's own copy.
//
// Each trigger renders its sheet as its own child, so inside an open Sheet
// (Ajustes, Denunciar) the help Modal nests in that Modal and presents above
// it. At stack depth 0 the shell's Back and Escape handlers do nothing, so
// the help Modal handles them. A module-level store keeps at most one help
// sheet open app-wide; the shell calls closeHelp() on Back and on navigation.

import { useEffect, useRef, useSyncExternalStore } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { Sheet } from './Sheet'
import { Icon } from './Icon'
import { colors, type } from './theme'
import { Body } from './index'

let current = null
const listeners = new Set()

function setCurrent (token) {
  if (current === token) return
  current = token
  for (const listener of listeners) listener()
}

function subscribe (listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// Closes the open help sheet, if any. True when one was open.
export function closeHelp () {
  if (current === null) return false
  setCurrent(null)
  return true
}

export function useHelpOpen () {
  return useSyncExternalStore(subscribe, () => current !== null)
}

function useHelpTrigger () {
  const ref = useRef(null)
  if (ref.current === null) ref.current = {}
  const token = ref.current
  const open = useSyncExternalStore(subscribe, () => current === token)
  useEffect(() => () => {
    if (current === token) setCurrent(null)
  }, [token])
  return {
    open,
    handleShow: () => setCurrent(token),
    handleHide: () => {
      if (current === token) setCurrent(null)
    }
  }
}

// No Sheet title: it is centred with wide side padding and cuts long titles.
export function HelpSheet ({ open, onClose, doc }) {
  if (!doc) return null
  return (
    <Sheet
      open={open}
      onClose={onClose}
      left={
        <Pressable accessibilityRole='button' accessibilityLabel='Fechar' onPress={onClose} hitSlop={8}>
          <Text style={styles.close}>Fechar</Text>
        </Pressable>
      }
    >
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title} accessibilityRole='header'>{doc.title}</Text>
        {doc.paragraphs.map((paragraph, i) => <Body key={i}>{paragraph}</Body>)}
      </ScrollView>
    </Sheet>
  )
}

export function HelpButton ({ doc, color = colors.soft, style, size = 22 }) {
  const help = useHelpTrigger()
  if (!doc) return null
  return (
    <>
      <Pressable
        accessibilityRole='button'
        accessibilityLabel={doc.title}
        hitSlop={6}
        onPress={help.handleShow}
        style={({ pressed }) => [styles.button, style, pressed && styles.pressed]}
      >
        <Icon name='info' size={size} color={color} />
      </Pressable>
      <HelpSheet open={help.open} onClose={help.handleHide} doc={doc} />
    </>
  )
}

export function HelpNote ({ doc, children }) {
  return (
    <View style={styles.note}>
      <View style={styles.noteText}>{children}</View>
      <HelpButton doc={doc} size={18} />
    </View>
  )
}

const styles = StyleSheet.create({
  close: { ...type.cancel, color: colors.ink },
  content: { padding: 16, gap: 12 },
  title: { ...type.sheetTitle, color: colors.ink },
  button: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: 0.6 },
  note: { flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'stretch' },
  noteText: { flexShrink: 1 }
})
