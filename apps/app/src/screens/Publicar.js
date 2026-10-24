// Publicar: the composer sheet. post.create, or post.reply when a post was
// chosen to answer. The shell keeps this component mounted: the draft lives in
// its state, outside the Modal, so closing the sheet keeps it.
// On the browser node a post that cannot go out now (no network, or the write
// gate could not reach the seeder) is kept in the outbox ('fila de saída',
// ../outboxProvider) and sent later; Diário lists it until then.
// Design: apps/site/artwork/app-design.md.

import { useRef, useState } from 'react'
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { MAX_TEXT, displayText } from '@varanda/rpc'
import { useNode } from '../node'
import { useOutbox } from '../outboxProvider'
import { GATE_MESSAGE } from '../outbox'
import { countChars, handleOf } from '../format'
import { ErrorText, Soft, errorText, useAction } from '../ui'
import { Avatar } from '../ui/Avatar'
import { Pill } from '../ui/Pill'
import { Sheet } from '../ui/Sheet'
import { colors, type } from '../ui/theme'

// Clock slack when an uncertain send is matched by its `at` timestamp. The
// node stamps `at` while it handles the request, from the same clock as the
// app (the device natively, the same machine for varanda-serve on the web),
// so this send's post cannot predate `startedAt` beyond rounding. A wider
// window would take an identical earlier post for this one. An identical post
// confirmed within the slack is excluded by seq: a match must also be newer
// than the last own post this composer confirmed (lastSeqRef).
const MATCH_SLACK_MS = 2000

// The seq of a post.create / post.reply result, or null.
function seqOf (value) {
  return value && Number.isInteger(value.seq) ? value.seq : null
}

// A reply reference as 'author:seq' (lowercase author), or null.
function refOf (replyTo) {
  if (!replyTo || typeof replyTo.author !== 'string') return null
  return replyTo.author.toLowerCase() + ':' + String(replyTo.seq)
}

function sameRef (a, b) {
  if (a === null || b === null) return a === b
  return String(a).toLowerCase() === String(b).toLowerCase()
}

// Progress ring: a grey track and a green arc drawn with two half masks.
// Each half (10x20, overflow hidden) holds a 20x20 circle whose top and right
// borders are green; rotating the circle slides its half-circle arc into view.
function Ring ({ progress }) {
  const deg = Math.max(0, Math.min(1, progress)) * 360
  const rightDeg = -135 + Math.min(deg, 180)
  const leftDeg = 45 + Math.max(0, deg - 180)
  return (
    <View style={styles.ring} accessible={false} importantForAccessibility='no-hide-descendants'>
      <View style={styles.track} />
      {deg > 0
        ? (
          <View style={[styles.half, styles.halfRight]}>
            <View style={[styles.arc, styles.arcInRight, { transform: [{ rotate: rightDeg + 'deg' }] }]} />
          </View>
          )
        : null}
      {deg > 180
        ? (
          <View style={[styles.half, styles.halfLeft]}>
            <View style={[styles.arc, styles.arcInLeft, { transform: [{ rotate: leftDeg + 'deg' }] }]} />
          </View>
          )
        : null}
    </View>
  )
}

export default function Publicar ({ open, reply, me, onClose, onClearReply, onPublished }) {
  const node = useNode()
  const outbox = useOutbox()
  const [text, setText] = useState('')
  // True while the own diary is re-read after an uncertain publish.
  const [checking, setChecking] = useState(false)
  const [checkError, setCheckError] = useState('')
  const action = useAction()
  // Highest own seq this composer confirmed in this session (a successful
  // publish, or a reconciliation that found it), or null.
  const lastSeqRef = useRef(null)
  const confirm = (seq) => {
    if (seq === null) return
    if (lastSeqRef.current === null || seq > lastSeqRef.current) lastSeqRef.current = seq
  }
  const len = countChars(text)
  const valid = len >= 1 && len <= MAX_TEXT
  const busy = action.pending || checking
  const self = me || { publicKey: null, name: null }
  const canQueue = outbox.available && typeof self.publicKey === 'string' && /^[0-9a-f]{64}$/.test(self.publicKey) &&
    !!(node.config && node.config.association)
  const offlineQueue = canQueue && node.online === false

  // Clears only what was sent (an edit made meanwhile stays) and tells the
  // shell, which shows the toast and clears the reply if it still matches.
  const published = (sent, sentReply) => {
    setText((current) => (current === sent ? '' : current))
    onPublished(sentReply ? 'reply' : 'post', sentReply ? sentReply.ref : null)
  }

  // Keeps the post in the outbox (the reply target verbatim). True when it
  // was stored; otherwise the draft stays with the reason.
  const queue = (sent, sentReply) => {
    try {
      outbox.add({
        author: self.publicKey,
        association: node.config.association,
        kind: sentReply ? 'reply' : 'post',
        to: sentReply ? sentReply.ref : null,
        text: sent
      })
    } catch (err) {
      setCheckError(errorText(err))
      return false
    }
    setText((current) => (current === sent ? '' : current))
    onPublished(sentReply ? 'queued-reply' : 'queued-post', sentReply ? sentReply.ref : null)
    return true
  }

  const send = async () => {
    if (busy) return
    setCheckError('')
    // The node stamps `at` from the same clock: a match must be this send's.
    const startedAt = Date.now()
    const sent = text
    const sentReply = reply
    if (offlineQueue) {
      queue(sent, sentReply)
      return
    }
    // The draft is kept on any failure; a request is never resent.
    let raw = null
    const r = await action.run(() => (sentReply
      ? node.request('post.reply', { to: sentReply.ref, text: sent })
      : node.request('post.create', { text: sent })).catch((err) => {
      raw = err
      throw err
    }))
    if (r.ok) {
      confirm(seqOf(r.value))
      return published(sent, sentReply)
    }
    // The write gate could not reach the seeder: nothing was written, so the
    // post waits in the outbox.
    if (canQueue && raw && raw.uncertain !== true && raw.message === GATE_MESSAGE) {
      if (queue(sent, sentReply)) action.clearError()
      return
    }
    if (!r.uncertain) return
    // Uncertain: re-read the own diary before offering the action again
    // (docs/rpc.md section 9). A match has the same text and reply target,
    // an `at` within the slack of `startedAt`, and a seq above the last one
    // this composer confirmed (so an identical post published just before is
    // not taken for this one). Found = published; otherwise the draft and the
    // uncertain message stay and the person decides.
    setChecking(true)
    try {
      const res = await node.request('log.read', {})
      const wanted = sentReply ? sentReply.ref : null
      const floor = lastSeqRef.current
      const found = (res.entries || []).find((entry) => {
        const record = entry && entry.record
        return record && record.type === 'post' && record.text === sent &&
          sameRef(refOf(record.replyTo), wanted) &&
          Date.parse(record.at) >= startedAt - MATCH_SLACK_MS &&
          (floor === null || (Number.isInteger(entry.seq) && entry.seq > floor))
      })
      if (found) {
        confirm(Number.isInteger(found.seq) ? found.seq : null)
        action.clearError()
        published(sent, sentReply)
      }
    } catch (err) {
      setCheckError(errorText(err))
    } finally {
      setChecking(false)
    }
  }

  const replyName = reply
    ? (typeof reply.name === 'string' && reply.name !== '' ? reply.name : handleOf(String(reply.ref).split(':')[0]))
    : ''

  return (
    <Sheet
      open={open}
      onClose={onClose}
      right={<Pill label={offlineQueue ? 'Guardar' : 'Publicar'} filled onPress={send} pending={busy} disabled={!valid} />}
    >
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView style={styles.flex} keyboardShouldPersistTaps='handled'>
          {reply
            ? (
              <>
                <View style={styles.markRow}>
                  <Text style={styles.mark}>
                    {'respondendo a '}
                    <Text style={styles.markName}>{displayText(replyName)}</Text>
                  </Text>
                  <Pressable
                    accessibilityRole='button'
                    accessibilityState={{ disabled: busy }}
                    disabled={busy}
                    onPress={onClearReply}
                    hitSlop={8}
                  >
                    <Text style={styles.markCancel}>cancelar resposta</Text>
                  </Pressable>
                </View>
                <Text style={styles.quote} numberOfLines={2}>{displayText(reply.text, { multiline: true })}</Text>
              </>
              )
            : null}
          <View style={styles.compose}>
            <Avatar name={self.name} publicKey={self.publicKey || ''} size={40} />
            <TextInput
              style={styles.input}
              value={text}
              onChangeText={setText}
              multiline
              placeholder='O que está rolando na varanda?'
              placeholderTextColor={colors.placeholder}
              autoFocus
              textAlignVertical='top'
              accessibilityLabel='texto da publicação'
            />
          </View>
          <View style={styles.counterRow}>
            <Ring progress={len / MAX_TEXT} />
            <Text style={[styles.counter, len >= MAX_TEXT && styles.counterFull]}>{len + '/' + MAX_TEXT}</Text>
          </View>
          {offlineQueue
            ? <View style={styles.errors}><Soft>sem rede: a publicação fica na fila de saída e sai sozinha quando a conexão voltar</Soft></View>
            : null}
          <View style={styles.errors}>
            <ErrorText>{action.error}</ErrorText>
            <ErrorText>{checkError}</ErrorText>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Sheet>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  markRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    marginTop: 4
  },
  mark: { ...type.replyMark, color: colors.soft, flexShrink: 1 },
  markName: { color: colors.accent, fontWeight: '600' },
  markCancel: { ...type.replyMark, color: colors.soft },
  quote: { fontSize: 14, lineHeight: 20, color: colors.soft, paddingHorizontal: 16 },
  compose: { flexDirection: 'row', gap: 12, paddingTop: 10, paddingHorizontal: 16 },
  // Bare text on the sheet (no box); on the web the caret shows focus, so the
  // browser outline is dropped.
  input: {
    flex: 1,
    ...type.compose,
    color: colors.ink,
    minHeight: 120,
    paddingTop: 8,
    borderWidth: 0,
    backgroundColor: 'transparent',
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : null)
  },
  counterRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: 7,
    paddingVertical: 14,
    paddingHorizontal: 16
  },
  counter: { ...type.counter, color: colors.soft },
  counterFull: { color: colors.danger },
  errors: { paddingHorizontal: 16, gap: 4 },
  ring: { width: 20, height: 20 },
  track: { ...StyleSheet.absoluteFillObject, borderRadius: 10, borderWidth: 2.5, borderColor: colors.ring },
  half: { position: 'absolute', top: 0, width: 10, height: 20, overflow: 'hidden' },
  halfRight: { left: 10 },
  halfLeft: { left: 0 },
  arc: {
    position: 'absolute',
    top: 0,
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2.5,
    borderTopColor: colors.accent,
    borderRightColor: colors.accent,
    borderBottomColor: 'transparent',
    borderLeftColor: 'transparent'
  },
  arcInRight: { left: -10 },
  arcInLeft: { left: 0 }
})
