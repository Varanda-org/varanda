// Publicar: the composer sheet. post.create, post.reply when a post was
// chosen to answer, or post.quote when one was chosen to quote (`quote`, the
// same shape as `reply`: { ref, name, username, text }). Quotes need a
// connection: they are never queued in the outbox, and offline the send and
// the photo button are disabled ('Citações precisam de internet'). The shell keeps this component mounted: the draft lives in
// its state, outside the Modal, so closing the sheet keeps it.
// On the browser node a post that cannot go out now (no network, or the write
// gate could not reach the seeder) is kept in the outbox ('fila de saída',
// ../outboxProvider) and sent later; Diário lists it until then.
// Emoji: an inline panel (../ui/EmojiPicker) inserts at the caret (the
// TextInput selection is tracked) within the MAX_TEXT code-point limit.
// Photos and GIFs (when the node offers `media` and the platform has a
// picker, and online): a 'Foto' button picks files (../media/attach), each is
// encoded at once (../media/encode: photos re-encoded, which strips
// EXIF/GPS; GIFs as they are) and kept ONLY in this page (bytes in memory, a blob: thumbnail): no
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
// @ suggestions (hosted web, online only): while the caret is inside an
// @token of 2+ characters the member search (../useMemberSearch) lists up to
// 5 verified members under the compose box; tapping one replaces the token
// with '@nome ' (../mentions). No strip on native, offline or non-hosted. The
// text is sent exactly as typed: names are never resolved at send time.
// Design: apps/site/artwork/app-design.md.

import { useEffect, useRef, useState } from 'react'
import { Image, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { MAX_TEXT, activeMention, displayText } from '@varanda/rpc'
import { MENTION_MIN_QUERY, insertMention } from '../mentions'
import { mergeSuggestions } from '../mentionTargets'
import { useMemberSearch } from '../useMemberSearch'
import { MentionSuggest } from '../ui/MentionSuggest'
import { sha256 } from '@noble/hashes/sha2.js'
import { useNode } from '../node'
import { useNames } from '../names'
import * as actingStore from '../actingAs'
import { actAs, pagesMedia, pagesOrigin, pagesStart } from '../pages'
import { memberKeyOf, useActing } from './Conversa'
import { useOutbox } from '../outboxProvider'
import { GATE_MESSAGE, isQuoteRecord } from '../outbox'
import { countChars } from '../format'
import { whoOf } from '../who'
import { ringState } from '../composeRing'
import { countAfterInsert, insertAt } from '../emoji'
import { MAX_MEDIA_PER_POST } from '../media/plan'
import { validDescriptor } from '../media/fetch'
import { pickImages } from '../media/attach'
import { revokeUrl, urlFromBytes } from '../media/display'
import { encodeFile } from '../media/encode'
import { Btn, ErrorText, Soft, errorText, useAction } from '../ui'
import { Avatar } from '../ui/Avatar'
import { EmojiPicker } from '../ui/EmojiPicker'
import { Icon } from '../ui/Icon'
import { Pill } from '../ui/Pill'
import { LinkDraftCard, useLinkDraft } from '../ui/ChatComposer'
import { cardForSend, withCardFallback } from '../linkCard'
import { withPreview } from '../attach-plan'
import { Sheet } from '../ui/Sheet'
import { tap } from '../ui/haptics'
import { type } from '../ui/theme'
import { useStyles, useTheme } from '../ui/ThemeProvider'
import { pagesOn } from '../pageGate'

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

const PAGE_KEY = /^[0-9a-f]{64}$/
const hexOf = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

let lastItemId = 0
const nextItemId = () => ++lastItemId

// Progress ring: a grey track and a toned arc drawn with two half masks.
// Each half (10x20, overflow hidden) holds a 20x20 circle whose top and right
// borders take the tone colour; rotating the circle slides its half-circle arc into view.
function Ring ({ progress, tone }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  const arcColor = colors[tone] || colors.accent
  const deg = Math.max(0, Math.min(1, progress)) * 360
  const rightDeg = -135 + Math.min(deg, 180)
  const leftDeg = 45 + Math.max(0, deg - 180)
  return (
    <View style={styles.ring} accessible={false} importantForAccessibility='no-hide-descendants'>
      <View style={styles.track} />
      {deg > 0
        ? (
          <View style={[styles.half, styles.halfRight]}>
            <View style={[styles.arc, styles.arcInRight, { borderTopColor: arcColor, borderRightColor: arcColor, transform: [{ rotate: rightDeg + 'deg' }] }]} />
          </View>
          )
        : null}
      {deg > 180
        ? (
          <View style={[styles.half, styles.halfLeft]}>
            <View style={[styles.arc, styles.arcInLeft, { borderTopColor: arcColor, borderRightColor: arcColor, transform: [{ rotate: leftDeg + 'deg' }] }]} />
          </View>
          )
        : null}
    </View>
  )
}

// `quote` takes precedence over `reply` (the shell keeps them exclusive);
// `onClearQuote` (optional) adds 'cancelar citação'. onPublished(kind, ref)
// with kind 'post' | 'reply' | 'quote' | 'queued-post' | 'queued-reply'.
export default function Publicar ({ open, reply: replyProp, quote = null, me, onClose, onClearReply, onClearQuote, onPublished }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  const reply = quote ? null : replyProp
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
  const inputRef = useRef(null)
  // Re-renders on a caret move so the active @token follows it.
  const [caret, setCaret] = useState(0)
  // A range selection has no single caret, so it gets no suggestions: a pick
  // there would be refused by insertMention.
  const [collapsed, setCollapsed] = useState(true)
  const [note, setNote] = useState('')
  // The composer stays mounted with its draft while closed: no searches then.
  const suggestOn = open === true && node.hosted === true && node.online !== false
  const search = useMemberSearch({
    request: node.request,
    hosted: node.hosted === true,
    online: node.online !== false,
    ownKey: me ? me.publicKey : null
  })
  // `caret` only forces the re-render; the live position is selRef.
  const caretAt = selRef.current && caret >= 0 ? Math.min(selRef.current.start, text.length) : text.length
  const active = suggestOn && collapsed ? activeMention(text, caretAt) : null
  const mentionQuery = active !== null && active.query.length >= MENTION_MIN_QUERY ? active.query : ''
  const { setQuery: searchSet, clear: searchClear } = search
  useEffect(() => {
    if (mentionQuery !== '') searchSet(mentionQuery)
    else searchClear()
  }, [mentionQuery, searchSet, searchClear])
  const suggestions = mentionQuery !== ''
    ? mergeSuggestions(search.hits, [], mentionQuery, me ? me.publicKey : null)
    : []
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
  const mediaOnline = node.online !== false

  // Publicar como: the page chosen (hosted only), whose posts, replies and
  // quotes go through the service and never the outbox.
  const names = useNames()
  const acting = useActing()
  const asPage = pagesOn({ hosted: node.hosted, accountOrigin: node.accountOrigin }) && acting.kind === 'page' ? acting.key : null
  const [roster, setRoster] = useState([])
  const [rosterFailed, setRosterFailed] = useState(false)
  // A sent-but-unknown page post ({ retry, page, sent, reply, quote, ids }):
  // retry() resends the same signed bytes. While it is set the draft is
  // locked and nothing new is signed.
  const pageRetryRef = useRef(null)
  const [pageRetry, setPageRetryState] = useState(null)
  const setPageRetry = (next) => {
    pageRetryRef.current = next
    setPageRetryState(next)
  }
  const locked = pageRetry !== null
  // True from the moment a page publish is sent until it settles: the draft
  // (text, photos, the chips) is then exactly what gets signed, so a retry
  // resends what is on screen.
  const pageSendingRef = useRef(false)
  const [pageSending, setPageSendingState] = useState(false)
  const setPageSending = (next) => {
    pageSendingRef.current = next
    setPageSendingState(next)
  }
  const frozen = locked || pageSending
  const openRef = useRef(open)
  openRef.current = open
  const asPageRef = useRef(asPage)
  asPageRef.current = asPage
  const canAttach = typeof pickImages === 'function' && (media !== null || asPage !== null)
  const { request: nodeRequest, hosted: nodeHosted } = node
  // Read at call time: on a core node the page statements go to its account
  // origin through the node (pages.js pagesOrigin).
  const nodeRef = useRef(node)
  nodeRef.current = node
  const pagesShown = pagesOn({ hosted: nodeHosted, accountOrigin: node.accountOrigin })
  const { resolveMany } = names
  useEffect(() => {
    if (!open || !pagesShown || node.online === false) return undefined
    let live = true
    const load = async () => {
      let rows
      try {
        const member = await memberKeyOf(nodeRequest, nodeRef.current)
        const data = await actAs(nodeRef.current, { member, action: 'list' })
        rows = [...(Array.isArray(data.owned) ? data.owned : []), ...(Array.isArray(data.admin) ? data.admin : [])]
          .filter((p) => p && PAGE_KEY.test(p.page) && p.closed !== true && !p.movedTo)
          .map((p) => p.page)
      } catch {
        // The last roster and the acting choice stay; only a list that was
        // read can say a page is no longer run.
        if (live) setRosterFailed(true)
        return
      }
      if (!live) return
      setRoster(rows)
      setRosterFailed(false)
      resolveMany(rows)
      // A page the person no longer runs is never acted as.
      const now = actingStore.get()
      if (now.kind === 'page' && !rows.includes(now.key)) actingStore.me()
    }
    load()
    return () => { live = false }
  }, [open, pagesShown, node.online, nodeRequest, resolveMany])
  // Photos uploaded for one identity are not valid for another. A post
  // being sent or waiting for its retry keeps its photos: they are in the
  // signed bytes.
  useEffect(() => {
    if (pageRetryRef.current !== null || pageSendingRef.current) return
    genRef.current++
    removeItems(Array.from(liveRef.current))
  }, [asPage])
  // Drops the post waiting for its retry and unlocks the draft. Its photos
  // stay only for the page they were uploaded for.
  const discardRetry = () => {
    const pending = pageRetryRef.current
    if (pending === null || busy) return
    setPageRetry(null)
    action.clearError()
    if (pending.page !== asPage) {
      genRef.current++
      removeItems(Array.from(liveRef.current))
    }
  }

  const len = countChars(text)
  const hasMedia = items.length > 0
  // Every item encoded (or already uploaded by an earlier Publicar).
  const mediaReady = hasMedia && items.every((item) => item.descriptor || (item.encoded && item.status !== 'uploading'))
  const busy = action.pending || checking || uploading
  const self = me || { publicKey: null, name: null }
  // Natively only the installation's node needs the queue: the manual (core)
  // node writes its own diary offline.
  const canQueue = outbox.available && (Platform.OS === 'web' || node.hosted === true) &&
    typeof self.publicKey === 'string' && /^[0-9a-f]{64}$/.test(self.publicKey) &&
    !!(node.config && node.config.association)
  // Quotes are never queued: offline they wait for the network.
  const offlineQueue = canQueue && asPage === null && node.online === false && !quote
  const quoteOffline = !!quote && node.online === false
  // The draft link card (not as a page: its posts are signed statements).
  // cardRef keeps the card a Publicar already built from a snapshot, so a
  // new press after a failure never uploads its thumbnail again.
  const linkDraft = useLinkDraft({ text, enabled: open === true && asPage === null, photos: hasMedia, member: self.publicKey })
  const cardRef = useRef(null)
  // A page never queues: it needs the service.
  const pageOffline = asPage !== null && node.online === false
  // Media is never queued: offline, a post with photos waits for the network.
  // A quote always needs text (1..MAX_TEXT), photos or not.
  // A post waiting for its retry only needs the network: its bytes are signed.
  const valid = locked
    ? node.online !== false
    : len <= MAX_TEXT && !quoteOffline && !pageOffline && (quote ? len >= 1 : true) &&
      (hasMedia ? mediaReady && mediaOnline && (media !== null || asPage !== null) : len >= 1)

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
  // was uploaded unless Publicar was pressed (see the header). A page post
  // being sent or waiting for its retry keeps its photos with its text: only
  // 'Descartar' frees them (or the send settling, see settledAsPage).
  useEffect(() => {
    if (open) return
    setEmojiOpen(false)
    setNote('')
    if (pageRetryRef.current !== null || pageSendingRef.current) return
    genRef.current++
    removeItems(Array.from(liveRef.current))
  }, [open])

  useEffect(() => () => {
    genRef.current++
    for (const url of thumbsRef.current.values()) revokeUrl(url)
    thumbsRef.current.clear()
  }, [])

  // One photo as the page: its own statement (start, page.sign) and the raw
  // bytes to the service. -> the descriptor.
  const uploadForPage = async (page, item) => {
    if (typeof item.retry === 'function') return (await item.retry()).descriptor
    const { encoded } = item
    const member = await memberKeyOf(nodeRequest, nodeRef.current)
    const origin = pagesOrigin(nodeRef.current)
    const { nonce } = await pagesStart({ member, action: 'media', page, origin })
    const op = { sha256: hexOf(sha256(encoded.bytes)), mime: encoded.mime, width: encoded.width, height: encoded.height, bytes: encoded.bytes.byteLength }
    const signed = await nodeRequest('page.sign', { action: 'media', nonce, page, op })
    const res = await pagesMedia({ member, nonce, page, op, signature: signed.signature, bytes: encoded.bytes, origin })
    return res.descriptor
  }

  // Uploads, on Publicar only, the items that have no descriptor yet, one at
  // a time. -> the descriptors in item order, or null when it stopped (an
  // upload failed, the item was removed or the composer was closed).
  const uploadAll = async (list, page = null) => {
    const gen = genRef.current
    const out = []
    for (const item of list) {
      if (item.descriptor) {
        out.push(item.descriptor)
        continue
      }
      if (!item.encoded || (media === null && page === null)) return null
      const { id, encoded } = item
      const live = () => gen === genRef.current && liveRef.current.has(id)
      patch(id, { status: 'uploading', progress: 0, error: '' })
      let descriptor
      try {
        descriptor = page !== null
          ? await uploadForPage(page, item)
          : await media.upload({
            bytes: encoded.bytes,
            mime: encoded.mime,
            width: encoded.width,
            height: encoded.height,
            onProgress: (p) => { if (live()) patch(id, { progress: fractionOf(p) }) }
          })
      } catch (err) {
        // After an unknown outcome the next try resends the same signed upload.
        const retry = err && err.uncertain === true && typeof err.retry === 'function' ? err.retry : null
        if (live()) patch(id, { status: 'failed', progress: 0, error: errorText(err), retry })
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
    if (!canAttach || !mediaOnline || busy || frozen) return
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
        thumb = urlFromBytes(encoded.bytes, encoded.mime)
        thumbsRef.current.set(id, thumb)
      } catch {}
      patch(id, { status: 'ready', encoded, thumb })
    }
  }

  const pickEmoji = (emoji) => {
    if (frozen) return
    const next = insertAt(text, selRef.current, emoji)
    if (!countAfterInsert(next.text, '', MAX_TEXT).allowed) {
      setNote('limite de ' + MAX_TEXT + ' caracteres')
      tap('warn')
      return
    }
    setNote('')
    setText(next.text)
    selRef.current = next.selection
    setForcedSel(next.selection)
  }

  const pickMention = (hit) => {
    if (frozen) return
    // The suggestion was computed for this token: refuse it silently if the
    // text or the caret moved to another one, or a range got selected, since.
    const sel = selRef.current || { start: text.length, end: text.length }
    if (sel.start !== sel.end) return
    const now = activeMention(text, sel.start)
    if (active === null || now === null || now.start !== active.start || now.end !== active.end ||
      now.query !== active.query) return
    const r = insertMention(text, sel, hit.username)
    if (!r.changed) {
      // Selection and token were checked above and rows carry valid names,
      // so the only refusal left is the length limit.
      setNote('limite de ' + MAX_TEXT + ' caracteres')
      tap('warn')
      return
    }
    setNote('')
    setText(r.text)
    selRef.current = r.selection
    setCaret(r.selection.start)
    setForcedSel(r.selection)
    setCollapsed(true)
    searchClear()
    // Pressing a row moves focus to it (web) and the strip then unmounts, so
    // typing would go nowhere: give the editor focus back once the new text
    // and selection are rendered, with the caret after the name.
    const caretSel = r.selection
    setTimeout(() => {
      const input = inputRef.current
      if (!input) return
      try {
        if (typeof input.focus === 'function') input.focus()
        if (typeof input.setSelectionRange === 'function') input.setSelectionRange(caretSel.start, caretSel.end)
      } catch {}
    }, 0)
  }

  // Clears only what was sent (an edit made meanwhile stays) and tells the
  // shell, which shows the toast and clears the reply or quote if it still
  // matches.
  const published = (sent, sentReply, sentIds = [], sentQuote = null) => {
    tap('success')
    setText((current) => (current === sent ? '' : current))
    if (sentIds.length > 0) removeItems(sentIds)
    if (sentQuote) return onPublished('quote', sentQuote.ref)
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

  // The post as the page: start, page.sign, POST (never the outbox). After an
  // unknown outcome the draft locks and 'Tentar de novo' resends the same
  // signed bytes (retry), to the page they were signed for.
  // A page send settled with nothing waiting for a retry: photos kept only
  // because it was in flight go now if the composer closed meanwhile or the
  // identity changed (they were uploaded for `page`).
  const settledAsPage = (page) => {
    if (pageRetryRef.current !== null || pageSendingRef.current) return
    if (openRef.current && asPageRef.current === page) return
    genRef.current++
    removeItems(Array.from(liveRef.current))
  }

  const sendAsPage = async () => {
    const page = asPage
    const pending = pageRetryRef.current
    if (pending !== null) {
      const r = await action.run(() => pending.retry())
      if (pageRetryRef.current !== pending) return
      if (r.ok) {
        setPageRetry(null)
        published(pending.sent, pending.reply, pending.ids, pending.quote)
      } else if (!r.uncertain) {
        // Refused for sure: nothing was published, the draft is free again.
        setPageRetry(null)
      }
      settledAsPage(pending.page)
      return
    }
    if (page === null) return
    const sent = text
    const sentReply = reply
    const sentQuote = quote
    if (sentQuote && countChars(sent) < 1) return
    setPageSending(true)
    try {
      await sendNewAsPage(page, sent, sentReply, sentQuote)
    } finally {
      setPageSending(false)
    }
    settledAsPage(page)
  }

  const sendNewAsPage = async (page, sent, sentReply, sentQuote) => {
    const sentIds = items.map((item) => item.id)
    let sentMedia = null
    if (hasMedia) {
      if (!mediaReady || !mediaOnline) return
      uploadingRef.current = true
      setUploading(true)
      try {
        sentMedia = await uploadAll(items, page)
      } finally {
        uploadingRef.current = false
        setUploading(false)
      }
      if (sentMedia === null) return
    }
    const kind = sentQuote ? 'quote' : sentReply ? 'reply' : 'post'
    const op = { text: sent }
    if (sentQuote) op.to = sentQuote.ref
    else if (sentReply) op.to = sentReply.ref
    if (sentMedia !== null) op.media = sentMedia
    let raw = null
    const r = await action.run(async () => {
      try {
        return await actAs(nodeRef.current, { member: await memberKeyOf(nodeRequest, nodeRef.current), action: kind, page, op })
      } catch (err) {
        raw = err
        throw err
      }
    })
    if (r.ok) return published(sent, sentReply, sentIds, sentQuote)
    if (r.uncertain && raw && typeof raw.retry === 'function') {
      setPageRetry({ retry: raw.retry, page, sent, reply: sentReply, quote: sentQuote, ids: sentIds })
    }
  }

  const send = async () => {
    if (busy || uploadingRef.current) return
    setCheckError('')
    // Never a new signature while a signed post waits for its retry.
    if (pageRetryRef.current !== null || asPage !== null) return sendAsPage()
    const sent = text
    const sentReply = reply
    const sentQuote = quote
    if (sentQuote && (node.online === false || countChars(sent) < 1)) return
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
    } else if (offlineQueue && !sentQuote) {
      queue(sent, sentReply)
      return
    }
    // The node stamps `at` from the same clock: a match must be this send's.
    const startedAt = Date.now()
    const base = sentMedia !== null ? { text: sent, media: sentMedia } : { text: sent }
    const method = sentQuote ? 'post.quote' : sentReply ? 'post.reply' : 'post.create'
    const to = sentQuote ? { to: sentQuote.ref } : sentReply ? { to: sentReply.ref } : {}
    // A link card goes with text only; its thumbnail joins the public media
    // core like a post photo, uploaded once per snapshot.
    let card = null
    const snapshot = sentMedia === null ? linkDraft.take(sent) : null
    if (snapshot !== null) {
      const prev = cardRef.current
      if (prev && prev.url === snapshot.url && prev.thumb === (snapshot.thumb ? snapshot.thumb.bytes : null)) {
        card = prev.card
      } else {
        const upload = media !== null
          ? async (t) => {
            const d = await media.upload({ bytes: t.bytes, mime: t.mime, width: t.width, height: t.height })
            if (!validDescriptor(d) || d.mime !== t.mime) throw new Error('resposta inválida')
            return d
          }
          : null
        uploadingRef.current = true
        setUploading(true)
        try {
          card = await cardForSend(snapshot, { upload })
        } finally {
          uploadingRef.current = false
          setUploading(false)
        }
        cardRef.current = { url: snapshot.url, thumb: snapshot.thumb ? snapshot.thumb.bytes : null, card }
      }
    }
    const built = withCardFallback((c) => (c ? withPreview(method, { ...to, ...base }, c) : { ...to, ...base }), card)
    const params = built.op
    // The draft is kept on any failure; a request is never resent.
    let raw = null
    const call = () => node.request(method, params)
    const r = await action.run(() => call().catch((err) => {
      raw = err
      throw err
    }))
    if (r.ok) {
      confirm(seqOf(r.value))
      return published(sent, sentReply, sentIds, sentQuote)
    }
    // The write gate could not reach the seeder: nothing was written, so the
    // post waits in the outbox (text only: a post with photos or a quote
    // stays here).
    if (sentMedia === null && !sentQuote && canQueue && raw && raw.uncertain !== true && raw.message === GATE_MESSAGE) {
      if (queue(sent, sentReply)) action.clearError()
      return
    }
    if (!r.uncertain) return
    // Uncertain: re-read the own diary before offering the action again
    // (docs/rpc.md section 9). A match has the same text and reply target,
    // an `at` within the slack of `startedAt`, and a seq above the last one
    // this composer confirmed (so an identical post published just before is
    // not taken for this one). Found = published; otherwise the draft and the
    // uncertain message stay and the person decides. A quote matches only a
    // record quoting the same post; a post or reply never matches a quote.
    setChecking(true)
    try {
      const res = await node.request('log.read', {})
      const wanted = sentReply ? sentReply.ref : null
      const floor = lastSeqRef.current
      const found = (res.entries || []).find((entry) => {
        const record = entry && entry.record
        const quoteOk = sentQuote
          ? isQuoteRecord(record) && sameRef(refOf(record.quote), sentQuote.ref)
          : !isQuoteRecord(record)
        return record && record.type === 'post' && record.text === sent && quoteOk &&
          sameRef(refOf(record.replyTo), wanted) && sameMedia(record.media, sentMedia) &&
          Date.parse(record.at) >= startedAt - MATCH_SLACK_MS &&
          (floor === null || (Number.isInteger(entry.seq) && entry.seq > floor))
      })
      if (found) {
        confirm(Number.isInteger(found.seq) ? found.seq : null)
        action.clearError()
        published(sent, sentReply, sentIds, sentQuote)
      }
    } catch (err) {
      setCheckError(errorText(err))
    } finally {
      setChecking(false)
    }
  }

  const replyName = reply ? displayText(whoOf({ name: reply.name, username: reply.username }).title) : ''
  const quoteName = quote ? displayText(whoOf({ name: quote.name, username: quote.username }).title) : ''
  const ring = ringState(len, MAX_TEXT)
  const selfWho = whoOf({ name: self.name, username: self.username })
  const attachOff = !mediaOnline || quoteOffline
  // Locked: the draft is what was signed and waits for its retry. Frozen
  // also covers a page send in flight.
  const held = busy || frozen
  let pillLabel = offlineQueue && !hasMedia ? 'Guardar' : 'Publicar'
  if (locked) pillLabel = 'Tentar de novo'

  return (
    <Sheet
      open={open}
      onClose={onClose}
      grabber
      right={<Pill label={pillLabel} filled onPress={send} pending={busy} disabled={!valid} />}
    >
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView style={styles.flex} keyboardShouldPersistTaps='handled'>
          {pagesOn({ hosted: node.hosted, accountOrigin: node.accountOrigin }) && roster.length > 0
            ? (
              <View style={styles.asRow} accessibilityRole='radiogroup'>
                <Text style={styles.asLabel}>Publicar como</Text>
                <Chip label='Você' on={asPage === null} disabled={held} onPress={() => actingStore.me()} />
                {roster.map((key) => {
                  const p = names.profileOf(key)
                  return (
                    <Chip
                      key={key}
                      label={pageLabel(p)}
                      on={asPage === key}
                      disabled={held}
                      onPress={() => actingStore.asPage({ key, name: p && p.name, username: p && p.username })}
                    />
                  )
                })}
              </View>
              )
            : null}
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
                    disabled={held}
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
          {quote
            ? (
              <>
                <View style={styles.markRow}>
                  <Text style={styles.mark}>
                    {'citando '}
                    <Text style={styles.markName}>{quoteName}</Text>
                  </Text>
                  {typeof onClearQuote === 'function'
                    ? (
                      <Pressable
                        accessibilityRole='button'
                        accessibilityState={{ disabled: busy }}
                        disabled={held}
                        onPress={onClearQuote}
                        hitSlop={8}
                      >
                        <Text style={styles.markCancel}>cancelar citação</Text>
                      </Pressable>
                      )
                    : null}
                </View>
                <View style={styles.quoteCard}>
                  <Text style={styles.quoteCardName} numberOfLines={1}>{quoteName}</Text>
                  {typeof quote.text === 'string' && quote.text !== ''
                    ? <Text style={styles.quote} numberOfLines={3}>{displayText(quote.text, { multiline: true })}</Text>
                    : null}
                </View>
              </>
              )
            : null}
          <View style={styles.compose}>
            <Avatar name={self.name || self.username || null} publicKey={self.publicKey || ''} size={40} picture={self.avatar} persist />
            <View style={styles.composeBody}>
              <Text style={styles.author} numberOfLines={1}>
                <Text style={styles.authorName}>{displayText(selfWho.title)}</Text>
                {selfWho.subtitle ? <Text style={styles.authorMeta}>{'  ' + displayText(selfWho.subtitle)}</Text> : null}
              </Text>
              <TextInput
                ref={inputRef}
                style={styles.input}
                value={text}
                onChangeText={setText}
                editable={!frozen}
                selection={forcedSel || undefined}
                onSelectionChange={(event) => {
                  selRef.current = event.nativeEvent.selection
                  setCaret(event.nativeEvent.selection.start)
                  setCollapsed(event.nativeEvent.selection.start === event.nativeEvent.selection.end)
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
                    busy={held}
                    onRemove={() => removeItems([item.id])}
                    onRetry={send}
                  />
                ))}
              </View>
              )
            : <LinkDraftCard draft={linkDraft} />}
          <MentionSuggest rows={frozen ? [] : suggestions} loading={!frozen && mentionQuery !== '' && search.phase === 'loading'} onPick={pickMention} />
          <View style={styles.counterRow}>
            <View style={styles.tools}>
              <Pressable
                accessibilityRole='button'
                accessibilityLabel={emojiOpen ? 'fechar emojis' : 'emojis'}
                accessibilityState={{ expanded: emojiOpen, disabled: frozen }}
                disabled={frozen}
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
                    accessibilityState={{ disabled: attachOff || held }}
                    disabled={attachOff || held}
                    onPress={() => {
                      if (items.length >= MAX_MEDIA_PER_POST) setNote('até ' + MAX_MEDIA_PER_POST + ' fotos por publicação')
                      else attach()
                    }}
                    hitSlop={6}
                    style={({ pressed }) => [styles.tool, attachOff && styles.toolOff, pressed && styles.toolPressed]}
                  >
                    <Icon name='image' size={21} color={colors.soft} />
                    <Text style={styles.toolText}>Foto</Text>
                  </Pressable>
                  )
                : null}
            </View>
            <View style={styles.count}>
              <Ring progress={ring.progress} tone={ring.tone} />
              <Text style={[styles.counter, ring.tone === 'warn' && styles.counterWarn, ring.tone === 'danger' && styles.counterFull]}>
                {ring.remaining === null ? len + '/' + MAX_TEXT : String(ring.remaining)}
              </Text>
            </View>
          </View>
          <EmojiPicker open={emojiOpen && !frozen} onPick={pickEmoji} />
          {quoteOffline
            ? <View style={styles.errors}><Soft>Citações precisam de internet</Soft></View>
            : null}
          {pageOffline && !quoteOffline
            ? <View style={styles.errors}><Soft>Publicar como página precisa de internet</Soft></View>
            : null}
          {canAttach && !mediaOnline && !quoteOffline
            ? <View style={styles.errors}><Soft>Fotos precisam de internet</Soft></View>
            : null}
          {note ? <View style={styles.errors}><Soft>{note}</Soft></View> : null}
          {offlineQueue && !hasMedia
            ? <View style={styles.errors}><Soft>Sem rede: a publicação fica aguardando envio e sai sozinha quando a conexão voltar.</Soft></View>
            : null}
          {rosterFailed && roster.length > 0
            ? <View style={styles.errors}><Soft>Não deu para atualizar suas páginas</Soft></View>
            : null}
          {locked
            ? (
              <View style={styles.errors}>
                <Soft>Não sabemos se a publicação saiu. Toque em Tentar de novo para reenviar a mesma, ou descarte.</Soft>
                <View style={styles.retryRow}>
                  <Btn label='Descartar' secondary onPress={discardRetry} disabled={busy} />
                </View>
              </View>
              )
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

// Never a raw key as a label.
function pageLabel (profile) {
  const name = profile && profile.name ? displayText(profile.name).trim() : ''
  if (name !== '') return name
  const username = profile && profile.username ? displayText(profile.username).trim() : ''
  return username !== '' ? '@' + username : 'Página'
}

function Chip ({ label, on, disabled, onPress }) {
  const styles = useStyles(makeStyles)
  return (
    <Pressable
      accessibilityRole='radio'
      accessibilityLabel={label}
      accessibilityState={{ checked: on, disabled }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={4}
      style={[styles.chip, on && styles.chipOn]}
    >
      <Text style={[styles.chipText, on && styles.chipTextOn]} numberOfLines={1}>{label}</Text>
    </Pressable>
  )
}

// One attached item: the thumbnail of the encoded bytes, a remove button, a
// progress bar while uploading and the retry line after a failure.
function Thumb ({ item, index, count, busy, onRemove, onRetry }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
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

const makeStyles = (colors) => StyleSheet.create({
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
  retryRow: { flexDirection: 'row', marginTop: 8 },
  asRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingTop: 8 },
  asLabel: { ...type.replyMark, color: colors.soft },
  chip: { minHeight: 36, maxWidth: 200, paddingHorizontal: 12, borderRadius: 18, borderWidth: 1, borderColor: colors.line, justifyContent: 'center' },
  chipOn: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  chipText: { fontSize: 14, lineHeight: 18, fontWeight: '600', color: colors.soft },
  chipTextOn: { color: colors.accent },
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
  quoteCard: {
    marginTop: 8,
    marginHorizontal: 16,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 12,
    gap: 2
  },
  quoteCardName: { ...type.postName, color: colors.ink, paddingHorizontal: 16 },
  compose: { flexDirection: 'row', gap: 12, paddingTop: 10, paddingHorizontal: 16 },
  // minWidth 0 so a long name ellipsizes instead of widening the row on native.
  composeBody: { flex: 1, minWidth: 0 },
  author: { paddingTop: 2 },
  authorName: { ...type.postName, color: colors.ink },
  authorMeta: { ...type.postMeta, color: colors.soft },
  // Bare text on the sheet (no box); on the web the caret shows focus, so the
  // browser outline is dropped. No flex: inside the author column a basis-0
  // flex would pin the field at minHeight instead of growing with the draft.
  input: {
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
  counterWarn: { color: colors.warn },
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
