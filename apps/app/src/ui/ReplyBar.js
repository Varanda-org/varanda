import { useEffect, useRef, useState } from 'react'
import { StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native'
import { displayText } from '@varanda/rpc'
import { replyChip } from '../threadRows'
import { useAction } from './index'
import { Pill } from './Pill'
import { TEXT_CAP } from './Sheet'
import { useStyles, useTheme } from './ThemeProvider'
import { space, type } from './theme'

const LINE_HEIGHT = type.postText.lineHeight
const MIN_HEIGHT = LINE_HEIGHT + 2 * space.sm

export function ReplyBar ({ target = null, onSend, onExpand, onClearTarget, busy = false, disabled = false, note = '', focusSignal, draft = '', onDraftChange }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  const { fontScale } = useWindowDimensions()
  const maxHeight = 4 * LINE_HEIGHT * Math.min(fontScale, TEXT_CAP) + 2 * space.sm
  const [text, setText] = useState(draft)
  const [height, setHeight] = useState(MIN_HEIGHT)
  const inputRef = useRef(null)
  const action = useAction()
  const off = busy || disabled || action.pending
  const length = [...text].length

  useEffect(() => {
    if (focusSignal !== undefined && inputRef.current) inputRef.current.focus()
  }, [focusSignal])
  useEffect(() => { if (text === '') setHeight(MIN_HEIGHT) }, [text])
  useEffect(() => {
    if (typeof onDraftChange === 'function') onDraftChange(text)
  }, [text, onDraftChange])

  const send = async () => {
    if (off || text.trim() === '') return
    const sent = text
    const result = await action.run(() => onSend(sent))
    if (result.ok && result.value === true) setText((current) => current === sent ? '' : current)
  }
  const expand = async () => {
    if (off) return
    const draft = text
    const result = await action.run(() => onExpand(draft))
    if (result.ok && result.value === true) setText((current) => current === draft ? '' : current)
    return result
  }
  const grow = (event) => {
    const size = event.nativeEvent.contentSize
    if (size && Number.isFinite(size.height)) setHeight(Math.max(MIN_HEIGHT, Math.min(maxHeight, size.height)))
  }

  return (
    <View style={styles.bar}>
      {target
        ? (
          <View style={styles.target}>
            <Text style={styles.targetText} numberOfLines={1} maxFontSizeMultiplier={TEXT_CAP}>{replyChip(target)}</Text>
            <Pill icon='fechar' accessibilityLabel='cancelar resposta' onPress={onClearTarget} disabled={off} />
          </View>
          )
        : null}
      <View style={styles.line}>
        <TextInput
          ref={inputRef}
          value={text}
          onChangeText={setText}
          editable={!off}
          multiline
          placeholder='Escreva uma resposta'
          accessibilityLabel='Escreva uma resposta'
          placeholderTextColor={colors.placeholder}
          maxFontSizeMultiplier={TEXT_CAP}
          onContentSizeChange={grow}
          style={[styles.input, { height: Math.min(height, maxHeight), maxHeight }]}
        />
        <Pill icon='maximize-2' accessibilityLabel='abrir editor completo' onPress={expand} disabled={off} />
        <Pill label='Responder' filled onPress={send} disabled={off || text.trim() === ''} pending={action.pending} maxFontSizeMultiplier={TEXT_CAP} />
      </View>
      {/* Under the line: beside the buttons at large text on a narrow screen it left the field no width. */}
      {length >= 900 ? <Text style={[styles.counter, length > 1000 && styles.over]} maxFontSizeMultiplier={TEXT_CAP}>{length}/1000</Text> : null}
      {note ? <Text style={styles.note} maxFontSizeMultiplier={TEXT_CAP}>{displayText(note)}</Text> : null}
      {action.error ? <Text style={styles.error} accessibilityRole='alert' maxFontSizeMultiplier={TEXT_CAP}>{action.error}</Text> : null}
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  bar: { padding: space.md, gap: space.sm, backgroundColor: colors.card, borderTopWidth: 1, borderTopColor: colors.outline },
  target: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  targetText: { ...type.replyMark, color: colors.soft, flex: 1 },
  // The field grows to four lines; send stays on the last line of this row.
  // minWidth 0: on the web a flex item stays as wide as its placeholder and would push send off the row.
  line: { flexDirection: 'row', alignItems: 'flex-end', gap: space.sm },
  input: { ...type.postText, color: colors.ink, flex: 1, minWidth: 0, padding: space.sm, textAlignVertical: 'top', minHeight: MIN_HEIGHT },
  counter: { ...type.counter, color: colors.soft, alignSelf: 'flex-end' },
  over: { color: colors.danger },
  note: { ...type.caption, color: colors.soft },
  error: { ...type.caption, color: colors.danger }
})
