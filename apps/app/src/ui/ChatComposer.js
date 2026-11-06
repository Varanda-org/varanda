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
// Photos: with onAttach (the screen passes it only when the node offers
// media for this chat) and the node online, a clip button opens AttachSheet;
// its pick calls onAttach(kind). The staged photos show as thumbnails above
// the field, each with an x, and 'Cancelar' discards them all; the caption
// is optional, so the send button shows for photos alone. `progress` (0..1,
// or null) draws a ring around the send button while the photos upload and
// the message is sent.
//
// Props: { value, onChangeText, onSend, sending, sendDisabled, editable,
//   placeholder, accessibilityLabel, reply, onCancelReply, attach, notice,
//   ownKey, mentions = true, max = MAX_TEXT, onAttach, attachments,
//   onRemoveAttachment(id), onCancelAttachments, progress }
//   reply: { name, text, senderKey, mine } or null (ReplyPreview props)
//   attachments: [{ id, status: 'encoding' | 'ready' | 'invalid', thumb, error }]

import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Image, Keyboard, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { MAX_TEXT, activeMention } from '@varanda/rpc'
import { countAfterInsert, insertAt } from '../emoji'
import { countChars } from '../format'
import { MENTION_MIN_QUERY, insertMention } from '../mentions'
import { mergeSuggestions } from '../mentionTargets'
import { useNode } from '../node'
import { useMemberSearch } from '../useMemberSearch'
import { AttachSheet } from './AttachSheet'
import { EmojiPicker } from './EmojiPicker'
import { tap } from './haptics'
import { Icon } from './Icon'
import { MentionSuggest } from './MentionSuggest'
import { ReplyPreview } from './ReplyPreview'
import { useStyles, useTheme } from './ThemeProvider'
import { layout, radius, space, webInputReset } from './theme'

const LINE = 22
const PAD_V = 9
const MIN_HEIGHT = LINE + PAD_V * 2
const MAX_LINES = 6
const MAX_HEIGHT = LINE * MAX_LINES + PAD_V * 2
const SEND = 40
const THUMB = 64
const RING = SEND + 6

// A thin ring around the send button: two half masks, each rotating a
// half-bordered circle into view (the same drawing as Publicar's ring).
function ProgressRing ({ progress }) {
  const styles = useStyles(makeStyles)
  const deg = Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0)) * 360
  const rightDeg = -135 + Math.min(deg, 180)
  const leftDeg = 45 + Math.max(0, deg - 180)
  return (
    <View style={styles.ring} pointerEvents='none' accessible={false} importantForAccessibility='no-hide-descendants'>
      <View style={styles.ringTrack} />
      {deg > 0
        ? (
          <View style={[styles.ringHalf, styles.ringHalfRight]}>
            <View style={[styles.ringArc, styles.ringArcRight, { transform: [{ rotate: rightDeg + 'deg' }] }]} />
          </View>
          )
        : null}
      {deg > 180
        ? (
          <View style={[styles.ringHalf, styles.ringHalfLeft]}>
            <View style={[styles.ringArc, styles.ringArcLeft, { transform: [{ rotate: leftDeg + 'deg' }] }]} />
          </View>
          )
        : null}
    </View>
  )
}

function Thumbs ({ items, onRemove, onCancel, locked }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  return (
    <View style={styles.thumbsRow}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.thumbs}>
        {items.map((item, i) => (
          <View key={item.id} style={styles.thumb} accessible accessibilityLabel={'Foto ' + (i + 1) + (item.status === 'invalid' ? ', ' + item.error : '')}>
            {item.thumb
              ? <Image source={{ uri: item.thumb }} style={styles.thumbImage} resizeMode='cover' accessibilityIgnoresInvertColors />
              : item.status === 'encoding'
                ? <ActivityIndicator size='small' color={colors.soft} />
                : <Icon name='imagem' size={20} color={colors.danger} />}
            {!locked && typeof onRemove === 'function'
              ? (
                <Pressable
                  accessibilityRole='button'
                  accessibilityLabel='Remover foto'
                  onPress={() => onRemove(item.id)}
                  hitSlop={8}
                  style={styles.thumbX}
                >
                  <Icon name='fechar' size={12} color='#ffffff' />
                </Pressable>
                )
              : null}
          </View>
        ))}
      </ScrollView>
      {typeof onCancel === 'function'
        ? (
          <Pressable accessibilityRole='button' accessibilityLabel='Cancelar' onPress={onCancel} hitSlop={8}>
            <Text style={styles.cancel}>Cancelar</Text>
          </Pressable>
          )
        : null}
    </View>
  )
}

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
  max = MAX_TEXT,
  onAttach = null,
  attachments = null,
  onRemoveAttachment,
  onCancelAttachments,
  progress = null
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
  const [focused, setFocused] = useState(false)
  const [note, setNote] = useState('')
  // selRef follows the field's selection; forcedSel places the caret once
  // after an insert. `caret` only forces the re-render that moves the @token.
  const [forcedSel, setForcedSel] = useState(null)
  const selRef = useRef(null)
  const inputRef = useRef(null)
  const [caret, setCaret] = useState(0)
  const [collapsed, setCollapsed] = useState(true)
  const [sheetOpen, setSheetOpen] = useState(false)
  const staged = Array.isArray(attachments) ? attachments : []

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
  const hasText = text.trim() !== '' || staged.length > 0
  const canClip = typeof onAttach === 'function' && online && editable && !sending
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
      {staged.length > 0
        ? <Thumbs items={staged} onRemove={onRemoveAttachment} onCancel={onCancelAttachments} locked={sending} />
        : null}
      <MentionSuggest rows={suggestions} loading={mentionQuery !== '' && search.phase === 'loading'} onPick={pickMention} />
      <View style={styles.row}>
        <View style={[styles.field, focused && editable && styles.fieldFocused, !editable && styles.fieldOff]}>
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
            style={[styles.input, webInputReset, { height }]}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
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
          {canClip
            ? (
              <Pressable
                accessibilityRole='button'
                accessibilityLabel='Anexar'
                onPress={() => setSheetOpen(true)}
                hitSlop={(layout.hit - SEND) / 2}
                style={({ pressed }) => [styles.tool, pressed && styles.pressed]}
              >
                <Icon name='clipe' size={22} color={colors.soft} />
              </Pressable>
              )
            : null}
        </View>
        {hasText
          ? (
            <View style={styles.sendWrap}>
              {sending && Number.isFinite(progress) ? <ProgressRing progress={progress} /> : null}
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
            </View>
            )
          : null}
      </View>
      {note ? <Text style={styles.soft}>{note}</Text> : null}
      {!note && left < 50 ? <Text style={styles.soft}>{left} caracteres restantes</Text> : null}
      <EmojiPicker open={emojiOpen && editable} onPick={pickEmoji} />
      {typeof onAttach === 'function'
        ? <AttachSheet open={sheetOpen && canClip} onClose={() => setSheetOpen(false)} onPick={(kind) => { setSheetOpen(false); onAttach(kind) }} />
        : null}
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
  fieldFocused: { borderColor: colors.accent },
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
  sendWrap: { width: SEND, height: SEND, alignItems: 'center', justifyContent: 'center' },
  ring: { position: 'absolute', left: (SEND - RING) / 2, top: (SEND - RING) / 2, width: RING, height: RING },
  ringTrack: { ...StyleSheet.absoluteFillObject, borderRadius: RING / 2, borderWidth: 2.5, borderColor: colors.line },
  ringHalf: { position: 'absolute', top: 0, width: RING / 2, height: RING, overflow: 'hidden' },
  ringHalfRight: { left: RING / 2 },
  ringHalfLeft: { left: 0 },
  ringArc: {
    position: 'absolute',
    top: 0,
    width: RING,
    height: RING,
    borderRadius: RING / 2,
    borderWidth: 2.5,
    borderTopColor: colors.accent,
    borderRightColor: colors.accent,
    borderBottomColor: 'transparent',
    borderLeftColor: 'transparent'
  },
  ringArcRight: { left: -RING / 2 },
  ringArcLeft: { left: 0 },
  thumbsRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  thumbs: { gap: space.sm, paddingVertical: space.xs, paddingHorizontal: space.xs },
  thumb: {
    width: THUMB,
    height: THUMB,
    borderRadius: radius.md,
    overflow: 'hidden',
    backgroundColor: colors.skeleton,
    alignItems: 'center',
    justifyContent: 'center'
  },
  thumbImage: { ...StyleSheet.absoluteFillObject },
  thumbX: {
    position: 'absolute',
    top: 4,
    right: 4,
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.6)'
  },
  cancel: { fontSize: 15, lineHeight: 20, color: colors.accent, paddingHorizontal: space.xs },
  soft: { fontSize: 13, lineHeight: 18, color: colors.soft, paddingHorizontal: space.xs },
  pressed: { opacity: 0.6 }
})
