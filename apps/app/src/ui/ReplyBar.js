import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native'
import { displayText } from '@varanda/rpc'
import { PRESSED_OPACITY } from '../pressMotion'
import { replyChip } from '../threadRows'
import { useAction } from './index'
import { Avatar } from './Avatar'
import { Icon } from './Icon'
import { TEXT_CAP } from './Sheet'
import { useStyles, useTheme } from './ThemeProvider'
import { layout, radius, space, type, webInputReset } from './theme'

const LINE_HEIGHT = type.postText.lineHeight
// The round send and a one-line field share this height, as in the chat composer.
const SEND = 40
const PAD_V = (SEND - LINE_HEIGHT) / 2
const MIN_HEIGHT = SEND

export function ReplyBar ({ target = null, onSend, onExpand, onAttach, onClearTarget, busy = false, disabled = false, note = '', focusSignal, draft = '', onDraftChange, me = null, nonFocalTarget = false }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  const { fontScale } = useWindowDimensions()
  const maxHeight = 4 * LINE_HEIGHT * Math.min(fontScale, TEXT_CAP) + 2 * PAD_V
  const [text, setText] = useState(draft)
  const [height, setHeight] = useState(MIN_HEIGHT)
  const [focused, setFocused] = useState(false)
  const inputRef = useRef(null)
  const action = useAction()
  const off = busy || disabled || action.pending
  // Focus alone would collapse the bar on the blur that a tap on send causes, so text keeps it open.
  const expanded = focused || text.trim() !== '' || nonFocalTarget === true
  // Send waits for text, never focus: on the web a tap on photo or expand blurs the field first, and
  // a send that left on that blur slid both buttons out from under the pointer, so the tap was lost.
  const hasText = text.trim() !== ''
  const attachOff = off || typeof onAttach !== 'function'
  const sendOff = off || text.trim() === ''
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
  const attachPhoto = async () => {
    if (attachOff) return
    const draft = text
    const result = await action.run(() => onAttach(draft))
    if (result.ok && result.value === true) setText((current) => current === draft ? '' : current)
    return result
  }

  return (
    <View style={styles.bar}>
      <View style={styles.line}>
        <View style={[styles.pill, focused && !off && styles.pillFocused, off && styles.pillOff]}>
          {expanded && target
            ? (
              <View style={styles.target}>
                <Text style={styles.targetText} numberOfLines={1} maxFontSizeMultiplier={TEXT_CAP}>{replyChip(target)}</Text>
                <Pressable
                  accessibilityRole='button'
                  accessibilityLabel='cancelar resposta'
                  accessibilityState={{ disabled: off }}
                  disabled={off}
                  onPress={onClearTarget}
                  hitSlop={(layout.hit - SEND) / 2}
                  style={({ pressed }) => [styles.tool, off && styles.dim, pressed && styles.pressed]}
                >
                  <Icon name='fechar' size={18} color={colors.soft} />
                </Pressable>
              </View>
              )
            : null}
          <View style={styles.field}>
            {me ? <View style={styles.avatar}><Avatar name={me.name} publicKey={me.publicKey} picture={me.picture} size={28} persist /></View> : null}
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
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              style={[styles.input, webInputReset, { height: Math.min(height, maxHeight), maxHeight }]}
            />
            <Pressable
              accessibilityRole='button'
              accessibilityLabel='adicionar foto'
              accessibilityState={{ disabled: attachOff }}
              disabled={attachOff}
              onPress={attachPhoto}
              hitSlop={(layout.hit - SEND) / 2}
              style={({ pressed }) => [styles.tool, pressed && styles.pressed]}
            >
              <Icon name='imagem' size={18} color={colors.soft} />
            </Pressable>
            <Pressable
              accessibilityRole='button'
              accessibilityLabel='abrir editor completo'
              accessibilityState={{ disabled: off }}
              disabled={off}
              onPress={expand}
              hitSlop={(layout.hit - SEND) / 2}
              style={({ pressed }) => [styles.tool, pressed && styles.pressed]}
            >
              <Icon name='expandir' size={18} color={colors.soft} />
            </Pressable>
          </View>
        </View>
        {hasText
          ? (
            <Pressable
              accessibilityRole='button'
              accessibilityLabel='Responder'
              accessibilityState={{ disabled: sendOff, busy: action.pending }}
              disabled={sendOff}
              onPress={send}
              hitSlop={(layout.hit - SEND) / 2}
              style={({ pressed }) => [styles.send, sendOff && !action.pending && styles.dim, pressed && styles.pressed]}
            >
              {action.pending ? <ActivityIndicator size='small' color={colors.accentInk} /> : <Icon name='send' size={18} color={colors.accentInk} />}
            </Pressable>
            )
          : null}
      </View>
      {/* Under the line: beside the buttons at large text on a narrow screen it left the field no width. */}
      {length >= 900 ? <Text style={[styles.counter, length > 1000 && styles.over]} maxFontSizeMultiplier={TEXT_CAP}>{length}/1000</Text> : null}
      {note ? <Text style={styles.note} maxFontSizeMultiplier={TEXT_CAP}>{displayText(note)}</Text> : null}
      {action.error ? <Text style={styles.error} accessibilityRole='alert' maxFontSizeMultiplier={TEXT_CAP}>{action.error}</Text> : null}
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  // No bottom padding: Conversa's wrapper pads under the bar with 8 pt or the safe-area inset.
  bar: { paddingTop: space.sm, gap: space.xs, backgroundColor: 'transparent' },
  // paddingLeft lines the label up with the text in the field.
  target: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingLeft: space.md },
  targetText: { ...type.replyMark, color: colors.soft, flex: 1 },
  // The pill grows to four lines; send stays beside its last line.
  line: { flexDirection: 'row', alignItems: 'flex-end', gap: space.sm },
  // minWidth 0: on the web a flex item stays as wide as its placeholder and would push send off the row.
  pill: { flex: 1, minWidth: 0, borderRadius: radius.bubble, backgroundColor: colors.inputOff, borderWidth: StyleSheet.hairlineWidth, borderColor: 'transparent', overflow: 'hidden' },
  pillFocused: { borderColor: colors.accent },
  pillOff: { opacity: 0.6 },
  field: { flexDirection: 'row', alignItems: 'flex-end', minHeight: SEND },
  avatar: { height: SEND, justifyContent: 'center', paddingLeft: space.sm },
  input: { ...type.postText, color: colors.ink, flex: 1, minWidth: 0, paddingVertical: PAD_V, paddingLeft: space.sm, paddingRight: 0, textAlignVertical: 'top', minHeight: MIN_HEIGHT },
  tool: { width: SEND, height: SEND, alignItems: 'center', justifyContent: 'center' },
  send: { width: SEND, height: SEND, borderRadius: SEND / 2, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
  dim: { opacity: 0.5 },
  pressed: { opacity: PRESSED_OPACITY },
  counter: { ...type.counter, color: colors.soft, alignSelf: 'flex-end' },
  over: { color: colors.danger },
  note: { ...type.caption, color: colors.soft },
  error: { ...type.caption, color: colors.danger }
})
