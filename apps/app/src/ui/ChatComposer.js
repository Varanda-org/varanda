// The composer at the bottom of a chat: an optional notice (errors, a held
// send's buttons), the reply bar with Cancelar, the @ suggestions, then one
// rounded field (emoji button on its left, an attach slot on its right) that
// grows with the text up to six lines, and a round send button that only
// appears once there is something to send. The emoji panel opens under the
// field and inserts at the caret within `max` characters.
//
// @ suggestions follow Publicar's rules: only on a hosted node that is
// online, only while the caret (not a range) is inside an @token of
// MENTION_MIN_QUERY+ characters; a pick replaces the token with '@nome '.
//
// The draft is the caller's (value / onChangeText), so a screen can keep it
// across re-renders and clear only what was sent. onSend() takes no
// argument: the caller sends its own value. Nothing here retries a send.
//
// Props: { value, onChangeText, onSend, sending, sendDisabled, editable,
//   placeholder, accessibilityLabel, reply, onCancelReply, attach, notice,
//   ownKey, mentions = true, max = MAX_TEXT }
//   reply: { name, text, senderKey, mine } or null (ReplyPreview props)

import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Keyboard, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { MAX_TEXT, activeMention } from '@varanda/rpc'
import { countAfterInsert, insertAt } from '../emoji'
import { countChars } from '../format'
import { MENTION_MIN_QUERY, insertMention } from '../mentions'
import { mergeSuggestions } from '../mentionTargets'
import { useNode } from '../node'
import { useMemberSearch } from '../useMemberSearch'
import { EmojiPicker } from './EmojiPicker'
import { tap } from './haptics'
import { Icon } from './Icon'
import { MentionSuggest } from './MentionSuggest'
import { ReplyPreview } from './ReplyPreview'
import { useStyles, useTheme } from './ThemeProvider'
import { layout, radius, space } from './theme'

const LINE = 22
const PAD_V = 9
const MIN_HEIGHT = LINE + PAD_V * 2
const MAX_LINES = 6
const MAX_HEIGHT = LINE * MAX_LINES + PAD_V * 2
const SEND = 40

export function ChatComposer ({
  value,
  onChangeText,
  onSend,
  sending = false,
  sendDisabled = false,
  editable = true,
  placeholder = 'Escreva uma mensagem',
  accessibilityLabel = 'mensagem',
  reply = null,
  onCancelReply,
  attach = null,
  notice = null,
  ownKey = null,
  mentions = true,
  max = MAX_TEXT
}) {
  const styles = useStyles(makeStyles)
  // The composer sits at the bottom of a stacked screen (no tab bar under it),
  // so it clears the home indicator itself; with the keyboard up the inset is
  // already covered and only the normal gap stays. iOS announces the keyboard
  // before it moves (Will), Android only after (Did): the event names differ.
  const insets = useSafeAreaInsets()
  const [keyboard, setKeyboard] = useState(false)
  useEffect(() => {
    const ios = Platform.OS === 'ios'
    const show = Keyboard.addListener(ios ? 'keyboardWillShow' : 'keyboardDidShow', () => setKeyboard(true))
    const hide = Keyboard.addListener(ios ? 'keyboardWillHide' : 'keyboardDidHide', () => setKeyboard(false))
    return () => { show.remove(); hide.remove() }
  }, [])
  const bottomPad = keyboard ? space.sm - 2 : Math.max(space.sm - 2, insets.bottom)
  const { colors } = useTheme()
  const node = useNode()
  const text = typeof value === 'string' ? value : ''
  const change = (next) => { if (typeof onChangeText === 'function') onChangeText(next) }
  const [height, setHeight] = useState(MIN_HEIGHT)
  // On the web the measured content height never falls below the field's
  // current height, so an emptied draft (a send, a clear) drops back to one
  // line here. A partial delete keeps the height: the web skips the
  // content-size event when the line count did not change, and a reset there
  // would hide the remaining lines.
  useEffect(() => {
    if (text === '') setHeight(MIN_HEIGHT)
  }, [text])
  const [emojiOpen, setEmojiOpen] = useState(false)
  const [note, setNote] = useState('')
  // selRef follows the field's selection; forcedSel places the caret once
  // after an insert. `caret` only forces the re-render that moves the @token.
  const [forcedSel, setForcedSel] = useState(null)
  const selRef = useRef(null)
  const inputRef = useRef(null)
  const [caret, setCaret] = useState(0)
  const [collapsed, setCollapsed] = useState(true)

  const hosted = node !== null && node.hosted === true
  const online = node !== null && node.online !== false
  const suggestOn = mentions === true && editable && hosted && online
  const search = useMemberSearch({
    request: node !== null ? node.request : undefined,
    hosted,
    online,
    ownKey: typeof ownKey === 'string' ? ownKey : null
  })
  const caretAt = selRef.current && caret >= 0 ? Math.min(selRef.current.start, text.length) : text.length
  const active = suggestOn && collapsed ? activeMention(text, caretAt) : null
  const mentionQuery = active !== null && active.query.length >= MENTION_MIN_QUERY ? active.query : ''
  const { setQuery: searchSet, clear: searchClear } = search
  useEffect(() => {
    if (mentionQuery !== '') searchSet(mentionQuery)
    else searchClear()
  }, [mentionQuery, searchSet, searchClear])
  const suggestions = mentionQuery !== ''
    ? mergeSuggestions(search.hits, [], mentionQuery, typeof ownKey === 'string' ? ownKey : null)
    : []

  // A sent draft clears the length note with it.
  useEffect(() => {
    if (text === '') setNote('')
  }, [text])

  const left = max - countChars(text)
  const hasText = text.trim() !== ''
  const sendOff = !editable || sendDisabled || sending || left < 0

  const pickEmoji = (emoji) => {
    if (!editable) return
    const next = insertAt(text, selRef.current, emoji)
    if (!countAfterInsert(next.text, '', max).allowed) {
      setNote('limite de ' + max + ' caracteres')
      tap('warn')
      return
    }
    setNote('')
    change(next.text)
    selRef.current = next.selection
    setForcedSel(next.selection)
  }

  const pickMention = (hit) => {
    if (!editable) return
    // The rows were computed for this token: refuse the pick if the text or
    // the caret moved to another one, or a range got selected, since.
    const sel = selRef.current || { start: text.length, end: text.length }
    if (sel.start !== sel.end) return
    const now = activeMention(text, sel.start)
    if (active === null || now === null || now.start !== active.start || now.end !== active.end ||
      now.query !== active.query) return
    const r = insertMention(text, sel, hit.username, max)
    if (!r.changed) {
      setNote('limite de ' + max + ' caracteres')
      tap('warn')
      return
    }
    setNote('')
    change(r.text)
    selRef.current = r.selection
    setCaret(r.selection.start)
    setForcedSel(r.selection)
    setCollapsed(true)
    searchClear()
    // Pressing a row takes the focus (web) and the strip then unmounts, so
    // the field gets it back once the new text is rendered.
    setTimeout(() => {
      const input = inputRef.current
      if (!input) return
      try {
        if (typeof input.focus === 'function') input.focus()
        // Safari puts the caret at the start on focus: place it after the name.
        if (typeof input.setSelectionRange === 'function') input.setSelectionRange(r.selection.start, r.selection.end)
      } catch {}
    }, 0)
  }

  return (
    <View style={[styles.composer, { paddingBottom: bottomPad }]}>
      {notice || null}
      {reply
        ? <ReplyPreview name={reply.name} handle={reply.handle} text={reply.text} senderKey={reply.senderKey} mine={reply.mine} onCancel={onCancelReply} />
        : null}
      <MentionSuggest rows={suggestions} loading={mentionQuery !== '' && search.phase === 'loading'} onPick={pickMention} />
      <View style={styles.row}>
        <View style={[styles.field, !editable && styles.fieldOff]}>
          <Pressable
            accessibilityRole='button'
            accessibilityLabel={emojiOpen ? 'fechar emojis' : 'emojis'}
            accessibilityState={{ expanded: emojiOpen, disabled: !editable }}
            disabled={!editable}
            onPress={() => setEmojiOpen((v) => !v)}
            hitSlop={(layout.hit - SEND) / 2}
            style={({ pressed }) => [styles.tool, pressed && styles.pressed]}
          >
            <Icon name='sorriso' size={22} color={emojiOpen ? colors.accent : colors.soft} />
          </Pressable>
          <TextInput
            ref={inputRef}
            style={[styles.input, { height }]}
            value={text}
            onChangeText={change}
            editable={editable}
            selection={forcedSel || undefined}
            onSelectionChange={(event) => {
              const sel = event.nativeEvent.selection
              selRef.current = sel
              setCaret(sel.start)
              setCollapsed(sel.start === sel.end)
              if (forcedSel) setForcedSel(null)
            }}
            onContentSizeChange={(event) => {
              const h = event.nativeEvent.contentSize.height
              if (typeof h !== 'number' || !Number.isFinite(h)) return
              setHeight(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.ceil(h))))
            }}
            scrollEnabled={height >= MAX_HEIGHT}
            multiline
            maxLength={max * 2}
            placeholder={placeholder}
            placeholderTextColor={colors.placeholder}
            textAlignVertical='top'
            accessibilityLabel={accessibilityLabel}
          />
          {attach || null}
        </View>
        {hasText
          ? (
            <Pressable
              accessibilityRole='button'
              accessibilityLabel='Enviar'
              accessibilityState={{ disabled: sendOff, busy: sending }}
              disabled={sendOff}
              onPress={onSend}
              hitSlop={(layout.hit - SEND) / 2}
              style={({ pressed }) => [styles.send, sendOff && !sending && styles.sendOff, pressed && styles.pressed]}
            >
              {sending
                ? <ActivityIndicator size='small' color={colors.accentInk} />
                : <Icon name='send' size={18} color={colors.accentInk} />}
            </Pressable>
            )
          : null}
      </View>
      {note ? <Text style={styles.soft}>{note}</Text> : null}
      {!note && left < 50 ? <Text style={styles.soft}>{left} caracteres restantes</Text> : null}
      <EmojiPicker open={emojiOpen && editable} onPick={pickEmoji} />
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  composer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
    backgroundColor: colors.bg,
    paddingHorizontal: space.sm,
    paddingVertical: space.sm - 2,
    gap: space.sm - 2
  },
  row: { flexDirection: 'row', alignItems: 'flex-end', gap: space.sm - 2 },
  field: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'flex-end',
    minHeight: SEND,
    borderRadius: radius.lg + 2,
    backgroundColor: colors.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line
  },
  fieldOff: { backgroundColor: colors.inputOff },
  tool: { width: SEND, height: SEND, alignItems: 'center', justifyContent: 'center' },
  input: {
    flex: 1,
    minWidth: 0,
    paddingTop: PAD_V,
    paddingBottom: PAD_V,
    paddingLeft: 0,
    paddingRight: space.md,
    fontSize: 16,
    lineHeight: LINE,
    color: colors.ink
  },
  send: {
    width: SEND,
    height: SEND,
    borderRadius: SEND / 2,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center'
  },
  sendOff: { opacity: 0.5 },
  soft: { fontSize: 13, lineHeight: 18, color: colors.soft, paddingHorizontal: space.xs },
  pressed: { opacity: 0.6 }
})
