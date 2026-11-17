// The Conversas option "Copiar conversas para outro aparelho", its sheet and
// the notice a receiving device shows (texts and state: ../historyCopy.js).
// The copy runs only when the person taps the button (rpc dm.historyCopy,
// browser node, one at a time in the engine); a failure shows its message and
// a button to try again, and nothing here starts it twice by itself. The row
// shows wherever the node can copy (hosted and unlocked), whatever the system.

import { useCallback, useRef, useState, useSyncExternalStore } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useNode } from '../node'
import { copyStore, COPY_AGAIN, COPY_CLOSE, COPY_POINTS, COPY_ROW_HINT, COPY_ROW_LABEL, COPY_START, COPY_TITLE, IMPORTED_DISMISS, IMPORTED_TITLE, importedText, progressText, resultLines } from '../historyCopy'
import { ErrorText, Soft, errorText } from '../ui'
import { Icon } from './Icon'
import { Pill } from './Pill'
import { Sheet } from './Sheet'
import { useStyles, useTheme } from './ThemeProvider'
import { layout, radius, space, type } from './theme'

function useCopyState () {
  return useSyncExternalStore(copyStore.subscribe, copyStore.get, copyStore.get)
}

// The row under the filters.
export function HistoryCopyRow ({ onPress }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  return (
    <Pressable
      accessibilityRole='button'
      accessibilityLabel={COPY_ROW_LABEL}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <Icon name='conversas' size={20} color={colors.soft} />
      <View style={styles.rowText}>
        <Text style={styles.rowLabel} numberOfLines={1}>{COPY_ROW_LABEL}</Text>
        <Text style={styles.rowHint} numberOfLines={1}>{COPY_ROW_HINT}</Text>
      </View>
      <Icon name='seta' size={18} color={colors.soft} />
    </Pressable>
  )
}

export function HistoryCopySheet ({ open, onClose }) {
  const styles = useStyles(makeStyles)
  const { request } = useNode()
  const { progress } = useCopyState()
  // 'idle' | 'running' | 'done' | 'failed'
  const [phase, setPhase] = useState('idle')
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')
  const running = useRef(false)

  const start = useCallback(async () => {
    if (running.current) return
    running.current = true
    copyStore.clearProgress()
    setError('')
    setPhase('running')
    try {
      setResult(await request('dm.historyCopy', {}))
      setPhase('done')
    } catch (err) {
      setError(errorText(err))
      setPhase('failed')
    } finally {
      running.current = false
    }
  }, [request])

  const close = useCallback(() => {
    if (running.current) return
    if (phase === 'done' || phase === 'failed') setPhase('idle')
    onClose()
  }, [onClose, phase])

  return (
    <Sheet open={open === true} onClose={close} title={COPY_TITLE} closeLabel={COPY_CLOSE} dismissable={phase !== 'running'}>
      <ScrollView contentContainerStyle={styles.body}>
        {COPY_POINTS.map((line) => <Soft key={line}>{line}</Soft>)}
        {phase === 'running' ? <View accessible accessibilityLiveRegion='polite'><Text style={styles.status}>{progressText(progress)}</Text></View> : null}
        {phase === 'done' ? <View accessible accessibilityLiveRegion='polite'>{resultLines(result).map((line) => <Text key={line} style={styles.status}>{line}</Text>)}</View> : null}
        {phase === 'failed' ? <ErrorText>{error}</ErrorText> : null}
        {phase === 'idle' || phase === 'failed' || phase === 'running'
          ? <Pill label={phase === 'failed' ? COPY_AGAIN : COPY_START} filled onPress={start} pending={phase === 'running'} />
          : <Pill label={COPY_CLOSE} onPress={close} />}
      </ScrollView>
    </Sheet>
  )
}

// What a device that just received a copy shows at the top of Conversas.
export function HistoryImportedNote () {
  const styles = useStyles(makeStyles)
  const { imported } = useCopyState()
  if (imported === null) return null
  return (
    <View style={styles.note} accessible accessibilityLiveRegion='polite'>
      <Text style={styles.noteTitle}>{IMPORTED_TITLE}</Text>
      <Soft>{importedText(imported)}</Soft>
      <Pill label={IMPORTED_DISMISS} small onPress={() => copyStore.clearImported()} />
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: layout.hit, paddingHorizontal: space.lg },
  rowText: { flex: 1 },
  rowLabel: { ...type.more, color: colors.ink },
  rowHint: { ...type.more, color: colors.soft },
  pressed: { backgroundColor: colors.line },
  body: { paddingHorizontal: space.lg, paddingVertical: space.md, gap: space.md },
  status: { ...type.more, color: colors.ink },
  note: { marginHorizontal: space.lg, marginVertical: space.sm, padding: space.md, gap: space.sm, borderRadius: radius.sm, backgroundColor: colors.card },
  noteTitle: { ...type.more, color: colors.ink }
})
