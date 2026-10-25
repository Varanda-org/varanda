// Publicar: the composer sheet. post.create, or post.reply when a post was
// chosen to answer. The shell keeps this component mounted: the draft lives in
// its state, outside the Modal, so closing the sheet keeps it.
// On the browser node a post that cannot go out now (no network, or the write
// gate could not reach the seeder) is kept in the outbox ('fila de saída',
// ../outboxProvider) and sent later; Diário lists it until then.
// Emoji: an inline panel (../ui/EmojiPicker) inserts at the caret (the
// TextInput selection is tracked) within the MAX_TEXT code-point limit.
// Photos and GIFs (web only, when the node offers `media`, and online): a
// 'Foto' button picks files (../media/attach), each is encoded at once
// (../media/encode: photos re-encoded, which strips EXIF/GPS; GIFs as they
// are) and kept ONLY in this page (bytes in memory, a blob: thumbnail): no
// network, no node call. Privacy by construction: the media core is public
// (the seeder serves any range of it), so nothing is uploaded before the
// person presses Publicar; removing an item or closing the composer before
// that discards it with nothing uploaded. On Publicar the items are uploaded
// one at a time (progress per item), then post.create / post.reply carries
// their descriptors; text may then be empty. If an upload fails, the post is
// not sent, the descriptors already obtained are kept (a new Publicar does
// not upload them again) and the item shows 'falhou · tentar de novo'.
// Bytes already uploaded cannot be taken back: if Publicar was pressed and
// the upload or the post then failed, closing the composer leaves those
// blocks unused but public in the own media core. Media is never queued in
// the outbox (it is text-only): offline, attaching is disabled.
// Design: apps/site/artwork/app-design.md.

/* global URL, Blob */

import { useEffect, useRef, useState } from 'react'
import { Image, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { MAX_TEXT, displayText } from '@varanda/rpc'
import { useNode } from '../node'
import { useOutbox } from '../outboxProvider'
import { GATE_MESSAGE } from '../outbox'
import { countChars } from '../format'
import { whoOf } from '../who'
import { countAfterInsert, insertAt } from '../emoji'
import { MAX_MEDIA_PER_POST } from '../media/plan'
import { validDescriptor } from '../media/fetch'
import { pickImages } from '../media/attach'
import { encodeFile } from '../media/encode'
import { ErrorText, Soft, errorText, useAction } from '../ui'
import { Avatar } from '../ui/Avatar'
import { EmojiPicker } from '../ui/EmojiPicker'
import { Icon } from '../ui/Icon'
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

// True when a record's media is the list that was sent (null: none).
function sameMedia (recorded, sent) {
  const list = Array.isArray(recorded) && recorded.length > 0 ? recorded : null
  if (list === null || sent === null) return list === sent
  const id = (d) => d && d.core + ':' + d.start + ':' + d.blocks + ':' + d.sha256
  return list.length === sent.length && list.every((d, i) => id(d) === id(sent[i]))
}

// An upload progress report as a fraction 0..1: a number, or an object with
// done/loaded/uploaded and total.
function fractionOf (p) {
  let f = 0
  if (typeof p === 'number') f = p
  else if (p && typeof p === 'object') {
    const done = [p.done, p.loaded, p.uploaded].find((n) => typeof n === 'number')
    const total = [p.total, p.blocks].find((n) => typeof n === 'number')
    if (done !== undefined && total > 0) f = done / total
  }
  return Number.isFinite(f) ? Math.max(0, Math.min(1, f)) : 0
}

let lastItemId = 0
const nextItemId = () => ++lastItemId

function revokeUrl (url) {
  if (!url) return
  try { URL.revokeObjectURL(url) } catch {}
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
  // Emoji panel and the caret: selRef follows the TextInput selection;
  // forcedSel places the caret once after an insert.
  const [emojiOpen, setEmojiOpen] = useState(false)
  const [forcedSel, setForcedSel] = useState(null)
  const selRef = useRef(null)
  const [note, setNote] = useState('')
  // Attached items: { id, status: 'encoding' | 'invalid' | 'ready' |
  // 'uploading' | 'failed' | 'done', progress, thumb, encoded, descriptor,
  // error }. liveRef holds the ids still attached (updated synchronously),
  // thumbsRef the blob: URL of each thumbnail, genRef bumps on discard.
  const [items, setItems] = useState([])
  const liveRef = useRef(new Set())
  const thumbsRef = useRef(new Map())
  const genRef = useRef(0)
  // True while Publicar uploads the items (one send at a time).
  const uploadingRef = useRef(false)
  const [uploading, setUploading] = useState(false)
  const media = node.media && typeof node.media.upload === 'function' ? node.media : null
  const canAttach = typeof pickImages === 'function' && media !== null
  const mediaOnline = node.online !== false

  const len = countChars(text)
  const hasMedia = items.length > 0
  // Every item encoded (or already uploaded by an earlier Publicar).
  const mediaReady = hasMedia && items.every((item) => item.descriptor || (item.encoded && item.status !== 'uploading'))
  const busy = action.pending || checking || uploading
  const self = me || { publicKey: null, name: null }
  const canQueue = outbox.available && typeof self.publicKey === 'string' && /^[0-9a-f]{64}$/.test(self.publicKey) &&
    !!(node.config && node.config.association)
  const offlineQueue = canQueue && node.online === false
  // Media is never queued: offline, a post with photos waits for the network.
  const valid = len <= MAX_TEXT && (hasMedia ? mediaReady && mediaOnline && media !== null : len >= 1)

  const patch = (id, fields) => {
    setItems((list) => list.map((item) => (item.id === id ? { ...item, ...fields } : item)))
  }

  const removeItems = (ids) => {
    const gone = new Set(ids)
    for (const id of gone) {
      liveRef.current.delete(id)
      revokeUrl(thumbsRef.current.get(id))
      thumbsRef.current.delete(id)
    }
    setItems((list) => list.filter((item) => !gone.has(item.id)))
  }

  // Closing the composer discards the pending items (the text draft stays);
  // a late encode or upload result of a discarded item is ignored. Nothing
  // was uploaded unless Publicar was pressed (see the header).
  useEffect(() => {
    if (open) return
    genRef.current++
    removeItems(Array.from(liveRef.current))
    setEmojiOpen(false)
    setNote('')
  }, [open])

  useEffect(() => () => {
    genRef.current++
    for (const url of thumbsRef.current.values()) revokeUrl(url)
    thumbsRef.current.clear()
  }, [])

  // Uploads, on Publicar only, the items that have no descriptor yet, one at
  // a time. -> the descriptors in item order, or null when it stopped (an
  // upload failed, the item was removed or the composer was closed).
  const uploadAll = async (list) => {
    const gen = genRef.current
    const out = []
    for (const item of list) {
      if (item.descriptor) {
        out.push(item.descriptor)
        continue
      }
      if (!item.encoded || media === null) return null
      const { id, encoded } = item
      const live = () => gen === genRef.current && liveRef.current.has(id)
      patch(id, { status: 'uploading', progress: 0, error: '' })
      let descriptor
      try {
        descriptor = await media.upload({
          bytes: encoded.bytes,
          mime: encoded.mime,
          width: encoded.width,
          height: encoded.height,
          onProgress: (p) => { if (live()) patch(id, { progress: fractionOf(p) }) }
        })
      } catch (err) {
        if (live()) patch(id, { status: 'failed', progress: 0, error: errorText(err) })
        return null
      }
      if (!live()) return null
      if (!validDescriptor(descriptor) || descriptor.mime !== encoded.mime) {
        patch(id, { status: 'failed', progress: 0, error: 'resposta inválida' })
        return null
      }
      patch(id, { status: 'done', progress: 1, descriptor })
      out.push(descriptor)
    }
    return gen === genRef.current ? out : null
  }

  const attach = async () => {
    if (!canAttach || !mediaOnline || busy) return
    setNote('')
    let files
    try {
      files = await pickImages()
    } catch {
      return
    }
    if (!Array.isArray(files) || files.length === 0) return
    const room = Math.max(0, MAX_MEDIA_PER_POST - liveRef.current.size)
    if (files.length > room) setNote('até ' + MAX_MEDIA_PER_POST + ' fotos por publicação')
    const chosen = files.slice(0, room).map((file) => ({ id: nextItemId(), file }))
    if (chosen.length === 0) return
    const gen = genRef.current
    for (const { id } of chosen) liveRef.current.add(id)
    setItems((list) => [...list, ...chosen.map(({ id }) => ({
      id, status: 'encoding', progress: 0, thumb: null, encoded: null, descriptor: null, error: ''
    }))])
    // One at a time: decoding big photos in parallel would use a lot of memory.
    for (const { id, file } of chosen) {
      if (gen !== genRef.current) return
      let encoded
      try {
        encoded = await encodeFile(file)
      } catch (err) {
        if (gen === genRef.current && liveRef.current.has(id)) patch(id, { status: 'invalid', error: errorText(err) })
        continue
      }
      if (gen !== genRef.current || !liveRef.current.has(id)) continue
      let thumb = null
      try {
        thumb = URL.createObjectURL(new Blob([encoded.bytes], { type: encoded.mime }))
        thumbsRef.current.set(id, thumb)
      } catch {}
      patch(id, { status: 'ready', encoded, thumb })
    }
  }

  const pickEmoji = (emoji) => {
    const next = insertAt(text, selRef.current, emoji)
    if (!countAfterInsert(next.text, '', MAX_TEXT).allowed) {
      setNote('limite de ' + MAX_TEXT + ' caracteres')
      return
    }
    setNote('')
    setText(next.text)
    selRef.current = next.selection
    setForcedSel(next.selection)
  }

  // Clears only what was sent (an edit made meanwhile stays) and tells the
  // shell, which shows the toast and clears the reply if it still matches.
  const published = (sent, sentReply, sentIds = []) => {
    setText((current) => (current === sent ? '' : current))
    if (sentIds.length > 0) removeItems(sentIds)
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
    if (busy || uploadingRef.current) return
    setCheckError('')
    const sent = text
    const sentReply = reply
    const sentIds = items.map((item) => item.id)
    let sentMedia = null
    if (hasMedia) {
      if (!mediaReady || !mediaOnline || media === null) return
      uploadingRef.current = true
      setUploading(true)
      try {
        sentMedia = await uploadAll(items)
      } finally {
        uploadingRef.current = false
        setUploading(false)
      }
      if (sentMedia === null) return
    } else if (offlineQueue) {
      queue(sent, sentReply)
      return
    }
    // The node stamps `at` from the same clock: a match must be this send's.
    const startedAt = Date.now()
    const params = sentMedia !== null ? { text: sent, media: sentMedia } : { text: sent }
    // The draft is kept on any failure; a request is never resent.
    let raw = null
    const r = await action.run(() => (sentReply
      ? node.request('post.reply', { to: sentReply.ref, ...params })
      : node.request('post.create', params)).catch((err) => {
      raw = err
      throw err
    }))
    if (r.ok) {
      confirm(seqOf(r.value))
      return published(sent, sentReply, sentIds)
    }
    // The write gate could not reach the seeder: nothing was written, so the
    // post waits in the outbox (text only: a post with photos stays here).
    if (sentMedia === null && canQueue && raw && raw.uncertain !== true && raw.message === GATE_MESSAGE) {
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
          sameRef(refOf(record.replyTo), wanted) && sameMedia(record.media, sentMedia) &&
          Date.parse(record.at) >= startedAt - MATCH_SLACK_MS &&
          (floor === null || (Number.isInteger(entry.seq) && entry.seq > floor))
      })
      if (found) {
        confirm(Number.isInteger(found.seq) ? found.seq : null)
        action.clearError()
        published(sent, sentReply, sentIds)
      }
    } catch (err) {
      setCheckError(errorText(err))
    } finally {
      setChecking(false)
    }
  }

  const replyName = reply ? displayText(whoOf({ name: reply.name, username: reply.username }).title) : ''

  return (
    <Sheet
      open={open}
      onClose={onClose}
      right={<Pill label={offlineQueue && !hasMedia ? 'Guardar' : 'Publicar'} filled onPress={send} pending={busy} disabled={!valid} />}
    >
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView style={styles.flex} keyboardShouldPersistTaps='handled'>
          {reply
            ? (
              <>
                <View style={styles.markRow}>
                  <Text style={styles.mark}>
                    {'respondendo a '}
                    <Text style={styles.markName}>{replyName}</Text>
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
            <Avatar name={self.name || self.username || null} publicKey={self.publicKey || ''} size={40} />
            <TextInput
              style={styles.input}
              value={text}
              onChangeText={setText}
              selection={forcedSel || undefined}
              onSelectionChange={(event) => {
                selRef.current = event.nativeEvent.selection
                if (forcedSel) setForcedSel(null)
              }}
              multiline
              placeholder='O que está rolando na varanda?'
              placeholderTextColor={colors.placeholder}
              autoFocus
              textAlignVertical='top'
              accessibilityLabel='texto da publicação'
            />
          </View>
          {hasMedia
            ? (
              <View style={styles.thumbs}>
                {items.map((item, i) => (
                  <Thumb
                    key={item.id}
                    item={item}
                    index={i}
                    count={items.length}
                    busy={busy}
                    onRemove={() => removeItems([item.id])}
                    onRetry={send}
                  />
                ))}
              </View>
              )
            : null}
          <View style={styles.counterRow}>
            <View style={styles.tools}>
              <Pressable
                accessibilityRole='button'
                accessibilityLabel={emojiOpen ? 'fechar emojis' : 'emojis'}
                accessibilityState={{ expanded: emojiOpen }}
                onPress={() => setEmojiOpen((v) => !v)}
                hitSlop={6}
                style={({ pressed }) => [styles.tool, pressed && styles.toolPressed]}
              >
                <Icon name='smile' size={21} color={emojiOpen ? colors.accent : colors.soft} />
              </Pressable>
              {canAttach
                ? (
                  <Pressable
                    accessibilityRole='button'
                    accessibilityLabel='Foto'
                    accessibilityState={{ disabled: !mediaOnline || busy }}
                    disabled={!mediaOnline || busy}
                    onPress={() => {
                      if (items.length >= MAX_MEDIA_PER_POST) setNote('até ' + MAX_MEDIA_PER_POST + ' fotos por publicação')
                      else attach()
                    }}
                    hitSlop={6}
                    style={({ pressed }) => [styles.tool, !mediaOnline && styles.toolOff, pressed && styles.toolPressed]}
                  >
                    <Icon name='image' size={21} color={colors.soft} />
                    <Text style={styles.toolText}>Foto</Text>
                  </Pressable>
                  )
                : null}
            </View>
            <View style={styles.count}>
              <Ring progress={len / MAX_TEXT} />
              <Text style={[styles.counter, len >= MAX_TEXT && styles.counterFull]}>{len + '/' + MAX_TEXT}</Text>
            </View>
          </View>
          <EmojiPicker open={emojiOpen} onPick={pickEmoji} />
          {canAttach && !mediaOnline
            ? <View style={styles.errors}><Soft>Fotos precisam de internet</Soft></View>
            : null}
          {note ? <View style={styles.errors}><Soft>{note}</Soft></View> : null}
          {offlineQueue && !hasMedia
            ? <View style={styles.errors}><Soft>Sem rede: a publicação fica aguardando envio e sai sozinha quando a conexão voltar.</Soft></View>
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

// One attached item: the thumbnail of the encoded bytes, a remove button, a
// progress bar while uploading and the retry line after a failure.
function Thumb ({ item, index, count, busy, onRemove, onRetry }) {
  const label = 'foto ' + (index + 1) + ' de ' + count
  const failed = item.status === 'failed'
  const invalid = item.status === 'invalid'
  const showBar = item.status === 'uploading'
  return (
    <View style={styles.thumbWrap}>
      <View style={styles.thumb} accessible accessibilityRole='image' accessibilityLabel={label}>
        {item.thumb
          ? <Image source={{ uri: item.thumb }} style={styles.thumbImg} resizeMode='cover' />
          : <View style={[styles.thumbImg, styles.thumbEmpty]}><Icon name='image' size={20} color={colors.soft} /></View>}
        {showBar
          ? (
            <View style={styles.bar}>
              <View style={[styles.barFill, { width: Math.round(item.progress * 100) + '%' }]} />
            </View>
            )
          : null}
      </View>
      <Pressable
        accessibilityRole='button'
        accessibilityLabel={'remover ' + label}
        accessibilityState={{ disabled: busy }}
        disabled={busy}
        onPress={onRemove}
        hitSlop={6}
        style={styles.remove}
      >
        <Icon name='x' size={14} color='#ffffff' />
      </Pressable>
      {failed
        ? (
          <Pressable accessibilityRole='button' accessibilityLabel={label + ': falhou, tentar de novo'} disabled={busy} onPress={onRetry} hitSlop={4}>
            <Text style={styles.thumbError}>falhou · tentar de novo</Text>
          </Pressable>
          )
        : null}
      {invalid ? <Text style={styles.thumbError} numberOfLines={2}>{item.error || 'falhou'}</Text> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  thumbs: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, paddingTop: 10, paddingLeft: 68, paddingRight: 16 },
  thumbWrap: { width: 80, gap: 4 },
  thumb: { width: 80, height: 80, borderRadius: 12, overflow: 'hidden', backgroundColor: colors.skeleton },
  thumbImg: { ...StyleSheet.absoluteFillObject },
  thumbEmpty: { alignItems: 'center', justifyContent: 'center' },
  bar: { position: 'absolute', left: 6, right: 6, bottom: 6, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.6)', overflow: 'hidden' },
  barFill: { height: 4, backgroundColor: colors.accent },
  remove: {
    position: 'absolute',
    top: 4,
    right: 4,
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.6)'
  },
  thumbError: { fontSize: 12, lineHeight: 15, color: colors.danger },
  tools: { flexDirection: 'row', alignItems: 'center', gap: 4, flex: 1 },
  tool: { flexDirection: 'row', alignItems: 'center', gap: 5, minHeight: 44, minWidth: 44, paddingHorizontal: 8, borderRadius: 22, justifyContent: 'center' },
  toolOff: { opacity: 0.45 },
  toolPressed: { backgroundColor: colors.accentSoft },
  toolText: { fontSize: 14, lineHeight: 18, fontWeight: '600', color: colors.soft },
  count: { flexDirection: 'row', alignItems: 'center', gap: 7 },
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
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 7,
    paddingVertical: 8,
    paddingHorizontal: 12
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
