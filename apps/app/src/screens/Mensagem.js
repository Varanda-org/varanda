// Mensagem: one private conversation, pushed above the tabs (nav.js screen
// 'mensagem', keyed by the peer's diary key). Props: { peer, isTop, onBack,
// onOpenMember(peer), onOpenMention(username), onReport({ dm, id, text,
// author }), onOpenInvite(link) }.
// Oldest message on top, the composer at the bottom, scrolled to the end on
// open and on new messages. The header (avatar, name, @nome) names the peer
// from the profile cache, never the raw key; a tap on it opens the profile and
// one icon opens the conversation options. Rows are shared Bubbles (tails,
// day chips, five-minute runs); a long press offers Responder, Copiar and
// Denunciar. An @nome in the text opens its profile. Whether the conversation is a request or blocked
// comes from dm.thread itself (docs/rpc.md 5.78), never from a dm.list page;
// until the first answer neither the composer nor the request actions show.
// dm.seen runs only while this screen is the top of the stack and the app is
// visible; it is a local mark, nothing is told to the peer. After every
// dm.set, dm.seen and dm.pull attempt (success or failure) node.bumpDm makes
// the thread, the list and the tab dot read again: dm.changed is only a
// hint. Rows are keyed by sender and id (an id is unique only per sender).
// A send answered uncertain is never resent by itself: it stays held until
// the person taps "Tentar de novo", sends the same text again (both re-put
// the same bytes), discards it, or confirms sending a different text. No
// read, delivered or typing state anywhere; an own message shows only
// LABELS.sent, and only while it is held or uncertain.
// Acting as a page (actingAs.js), the same calls go through the page's signed
// actions (pages.js); the composer then stays locked after an uncertain send
// until "Tentar de novo" (the same signed bytes) or "Descartar", and never
// signs a second message.
// Photos and GIFs (a personal account, when the node offers media.putDm and
// is online): the clip opens the attach sheet; the photos upload in order,
// then one dm.send carries them (attach-plan.js composePlan, chatSend.js
// runChatSend) under a progress ring. Cancelar before the send discards them.
// An uncertain send keeps that exact request (uploads included) and only
// "Tentar de novo" resends it; nothing is resent by itself. Received photos
// render inside the bubble through ChatMedia (chatMedia.js sourceFor).
// Voice notes take the same path: with an empty field the composer records
// one (where the device can make audio/mp4), it goes to the blob channel as
// the only item of one dm.send, and the bubble plays it (VoiceBubble).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { KeyboardAvoidingView, Platform, StyleSheet, View } from 'react-native'
import { MAX_TEXT, displayText } from '@varanda/rpc'
import { useNode } from '../node'
import { useNames } from '../names'
import { installationOrigin } from '../installation'
import { UNNAMED, readsAs, whoOf } from '../who'
import { OWN_LABEL } from '../groups'
import { copyText } from '../share'
import { shareNav } from '../shareNav'
import { countChars } from '../format'
import { LABELS, UNSURE_SEND } from '../dm'
import { OPEN_INVITE, inviteLinkOf } from '../inviteMessage'
import { mergeMessages, newestOf, pageDmRequest, refreshThread, sendPlan, threadRows, bubbleShape, withDayMarks, messageKey } from '../dm-screen'
import { pagesDm } from '../pages'
import { pagesOn } from '../pageGate'
import { composePlan, stagedVoice, voiceUploadError } from '../attach-plan'
import { chatMediaRefs, retryChatSend, runChatSend, stagedOf } from '../chatSend'
import { Btn, ErrorText, Soft, errorText, useAction, useNow } from '../ui'
import { useStyles } from '../ui/ThemeProvider'
import { Bubble } from '../ui/Bubble'
import { ChatComposer } from '../ui/ChatComposer'
import { ChatMedia } from '../ui/ChatMedia'
import { useChatAttachments } from '../ui/AttachSheet'
import { ChatHeader } from '../ui/ChatHeader'
import { OfflineNote } from '../ui/OfflineNote'
import { Pill } from '../ui/Pill'
import { RefreshableList } from '../ui/RefreshableList'
import { Sheet } from '../ui/Sheet'
import { EmptyState, Skeleton } from '../ui/States'
import { TopBar } from '../ui/TopBar'
import { memberKeyOf, useActing } from './Conversa'

const BLOCKED_SEND = 'você bloqueou esta pessoa'
const unsureSend = (err) => !!(err && (err.uncertain === true || err.message === UNSURE_SEND))

export function Mensagem ({ peer, isTop = true, onBack, onOpenMember, onOpenMention, onReport, onOpenInvite }) {
  const styles = useStyles(makeStyles)
  const origin = installationOrigin() || globalThis.location?.origin || ''
  const node = useNode()
  const now = useNow(60000)
  const { request } = node
  const hosted = node.hosted === true
  const acting = useActing()
  const pageKey = acting.kind === 'page' && pagesOn({ hosted, accountOrigin: node.accountOrigin }) ? acting.key : null
  // Read at call time: on a core node the page statements go to its account
  // origin through the node, and the memo keeps depending on `request` only.
  const nodeRef = useRef(node)
  nodeRef.current = node
  const dm = useMemo(() => {
    if (pageKey === null) return request
    return pageDmRequest(async (action, op) => pagesDm(nodeRef.current, { member: await memberKeyOf(request, nodeRef.current), page: pageKey, action, op }))
  }, [request, pageKey])
  const status = node.passkey && node.passkey.status ? node.passkey.status : null
  const unlocked = !!(status && status.unlocked === true)
  const ownKey = status ? status.publicKey : null
  const names = useNames()
  const { resolveMany } = names
  useEffect(() => {
    resolveMany([peer])
  }, [peer, resolveMany])
  const peerProfile = names.profileOf(peer)
  const peerWho = whoOf(peerProfile)
  // A known name or @nome always wins over the placeholder.
  const nameText = peerWho.title === UNNAMED ? 'Pessoa' : peerWho.title
  // In a quote the own messages are labelled OWN_LABEL: a peer whose display
  // name is that same word shows as its @nome (or Pessoa) there, so a quote of
  // the peer can never read like one of the person's own messages.
  const quoteName = readsAs(nameText, OWN_LABEL) ? (peerWho.subtitle || 'Pessoa') : nameText
  const quoteHandle = peerWho.subtitle || undefined

  const [raw, setRaw] = useState([])
  const [next, setNext] = useState(null)
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [lookup, setLookup] = useState(undefined)
  const [folder, setFolder] = useState(null)
  const [newest, setNewest] = useState('')
  const [blocked, setBlocked] = useState(false)
  const [askNew, setAskNew] = useState(false)
  const [draft, setDraft] = useState('')
  const [replyTo, setReplyTo] = useState(null)
  const [hold, setHold] = useState(null)
  const [menu, setMenu] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const post = useAction()
  const act = useAction()
  const attachments = useChatAttachments()
  // { phase, progress } of a photo send; mediaHold { op } after an uncertain
  // one (the exact dm.send it made); sendTokenRef is the running send, which
  // Cancelar marks dead before its request starts.
  const [mediaSend, setMediaSend] = useState(null)
  const [mediaHold, setMediaHold] = useState(null)
  const [mediaError, setMediaError] = useState('')
  const sendTokenRef = useRef(null)
  // A closed screen uploads nothing more and sends nothing.
  useEffect(() => () => { if (sendTokenRef.current) sendTokenRef.current.live = false }, [])
  const lastErr = useRef(null)
  const genRef = useRef(0)
  const rawRef = useRef(raw)
  rawRef.current = raw
  const nextRef = useRef(next)
  nextRef.current = next
  // True once an older page is held: a newer read then keeps its cursor.
  const olderRef = useRef(false)
  const listRef = useRef(null)
  const bumpDm = node.bumpDm
  const reread = useCallback(() => { if (typeof bumpDm === 'function') bumpDm() }, [bumpDm])

  const readThread = useCallback(async () => {
    const gen = ++genRef.current
    try {
      const r = await dm('dm.thread', { peer })
      if (gen !== genRef.current) return
      const page = Array.isArray(r.messages) ? r.messages : []
      const held = refreshThread(rawRef.current, page)
      if (!held.keepOlder) olderRef.current = false
      rawRef.current = held.messages
      setRaw(held.messages)
      setNewest(newestOf(page))
      if (!olderRef.current) setNext(r.next || null)
      setFolder(r.folder === 'request' ? 'request' : 'inbox')
      setBlocked(r.blocked === true)
      setLoadError('')
    } catch (err) {
      if (gen === genRef.current) setLoadError(errorText(err))
    }
    if (gen === genRef.current) setLoaded(true)
  }, [dm, peer])

  const ready = hosted && unlocked

  // Another acting identity is another inbox: nothing of the old one stays.
  const seenPage = useRef(pageKey)
  useEffect(() => {
    if (seenPage.current === pageKey) return
    seenPage.current = pageKey
    genRef.current++
    olderRef.current = false
    rawRef.current = []
    setRaw([])
    setNext(null)
    setNewest('')
    setFolder(null)
    setBlocked(false)
    setLoaded(false)
    setHold(null)
    setAskNew(false)
    setMediaHold(null)
    attachments.clear()
  }, [pageKey])

  useEffect(() => {
    if (!ready) return
    readThread()
  }, [ready, readThread, node.dmVersion])

  // Read on mount, on pull to refresh and when the screen comes back while
  // the last answer was a miss (so one miss never leaves the composer off for
  // good), never on every dmVersion bump: a read may be a diary.peek.
  const lookupGen = useRef(0)
  const lookupRef = useRef(lookup)
  lookupRef.current = lookup
  const readLookup = useCallback(() => {
    const gen = ++lookupGen.current
    request('dm.lookup', { member: peer }).then((r) => {
      if (gen === lookupGen.current) setLookup(r && typeof r.box === 'string' ? r.box : null)
    }).catch(() => {})
  }, [request, peer])
  useEffect(() => () => { lookupGen.current++ }, [])
  useEffect(() => {
    if (ready) readLookup()
  }, [ready, readLookup])

  const visible = node.visible !== false
  useEffect(() => {
    if (ready && isTop && visible && lookupRef.current === null) readLookup()
  }, [ready, isTop, visible, readLookup])
  useEffect(() => {
    if (!ready || !loaded || !visible || !isTop || newest === '') return
    // Local mark only; a lost answer may still have marked it, so read again.
    dm('dm.seen', { peer }).catch(() => {}).then(reread)
  }, [ready, loaded, visible, isTop, dm, peer, reread, newest])

  // The newest line sits at the bottom: show it on open and when a newer one
  // arrives; an older page loaded above leaves the position alone.
  const shownNewest = useRef('')
  useEffect(() => {
    if (!loaded || newest === '' || newest === shownNewest.current) return
    const first = shownNewest.current === ''
    shownNewest.current = newest
    const t = setTimeout(() => {
      const list = listRef.current
      if (list && typeof list.scrollToEnd === 'function') list.scrollToEnd({ animated: !first })
    }, 50)
    return () => clearTimeout(t)
  }, [loaded, newest])

  const decide = async (state) => {
    const r = await act.run(() => dm('dm.set', { peer, state }))
    reread()
    if (!r.ok) return
    setMenu(false)
    if (state === 'blocked') setBlocked(true)
    if (state === 'unblocked') setBlocked(false)
    if (state === 'deleted') onBack()
  }

  const send = async (text, quoteId) => {
    setAskNew(false)
    lastErr.current = null
    const r = await post.run(async () => {
      try {
        return await dm('dm.send', { to: peer, text, ...(quoteId ? { replyTo: quoteId } : {}) })
      } catch (err) {
        lastErr.current = err
        throw err
      }
    })
    const err = lastErr.current
    if (r.ok) {
      // A retry of a held message can land while a newer draft is being
      // written: only the composer that still holds this text is cleared.
      setDraft((d) => (d === text ? '' : d))
      setReplyTo((rt) => (rt && rt.id === quoteId ? null : rt))
      setHold(null)
    } else if (r.uncertain || (err && err.message === UNSURE_SEND)) {
      setHold({ text, quoteId, retry: pageKey !== null && err && typeof err.retry === 'function' ? err.retry : null })
    } else if (err && err.message === BLOCKED_SEND) {
      setBlocked(true)
    }
    reread()
  }

  // A page's held send resends the same signed bytes, never a new signature.
  const retryHeld = async () => {
    if (typeof hold.retry !== 'function') return undefined
    lastErr.current = null
    const r = await post.run(async () => {
      try {
        return await hold.retry()
      } catch (err) {
        lastErr.current = err
        throw err
      }
    })
    const err = lastErr.current
    if (r.ok) {
      setDraft('')
      setReplyTo(null)
      setHold(null)
    } else if (r.uncertain && err && typeof err.retry === 'function') {
      setHold({ ...hold, retry: err.retry })
    }
    reread()
  }

  const mediaApi = node.media && typeof node.media.putDm === 'function' ? node.media : null
  const canAttach = mediaApi !== null && pageKey === null && node.online !== false
  const sendingMedia = mediaSend !== null && (mediaSend.phase === 'uploading' || mediaSend.phase === 'sending')

  const mediaDone = (r, text, quoteId) => {
    setMediaSend(null)
    if (r.phase === 'done') {
      setDraft((d) => (d === text ? '' : d))
      setReplyTo((rt) => (rt && rt.id === quoteId ? null : rt))
      setMediaHold(null)
      attachments.clear()
    } else if (r.phase === 'uncertain') {
      setMediaHold({ op: r.op, text, quoteId })
    } else if (r.phase === 'failed') {
      setMediaHold(null)
      if (r.error && r.error.message === BLOCKED_SEND) setBlocked(true)
      setMediaError(errorText(r.error))
    }
    if (r.phase === 'done' || r.phase === 'uncertain' || (r.phase === 'failed' && r.op)) reread()
  }

  const sendMedia = async (text, quoteId) => {
    if (mediaApi === null || sendingMedia || !attachments.ready) return
    setMediaError('')
    setAskNew(false)
    const files = attachments.files
    let plan
    try {
      plan = composePlan({ text, attachments: stagedOf(files), target: { kind: 'dm', to: peer, ...(quoteId ? { replyTo: quoteId } : {}) } })
    } catch (err) {
      setMediaError(errorText(err))
      return
    }
    const token = { live: true }
    sendTokenRef.current = token
    const r = await runChatSend({
      plan,
      files,
      upload: (f) => mediaApi.putDm({ bytes: f.bytes, mime: f.mime, width: f.width, height: f.height }),
      request: dm,
      live: () => token.live,
      onPhase: (p) => { if (token.live) setMediaSend(p) },
      uncertain: unsureSend
    })
    if (sendTokenRef.current === token) sendTokenRef.current = null
    if (r.phase === 'cancelled') return
    mediaDone(r, text, quoteId)
  }

  // A recorded voice note: one upload, then one dm.send, under the same
  // state machine as photos (one commit, retry only on an explicit tap).
  const sendVoice = async (recording) => {
    if (mediaApi === null || sendingMedia || mediaHold !== null || attachments.items.length > 0) return
    if (!recording || !(recording.bytes instanceof Uint8Array)) return
    setMediaError('')
    setAskNew(false)
    const quoteId = replyTo ? replyTo.id : null
    let plan
    try {
      plan = composePlan({ text: '', attachments: [stagedVoice(recording)], target: { kind: 'dm', to: peer, ...(quoteId ? { replyTo: quoteId } : {}) } })
    } catch (err) {
      setMediaError(errorText(err))
      return
    }
    const token = { live: true }
    sendTokenRef.current = token
    const r = await runChatSend({
      plan,
      files: [recording],
      upload: async (f) => {
        try {
          return await mediaApi.putDm({ bytes: f.bytes, mime: f.mime, width: 0, height: 0, ms: f.ms, kind: 'voice' })
        } catch (err) {
          throw voiceUploadError(err)
        }
      },
      request: dm,
      live: () => token.live,
      onPhase: (p) => { if (token.live) setMediaSend(p) },
      uncertain: unsureSend
    })
    if (sendTokenRef.current === token) sendTokenRef.current = null
    if (r.phase === 'cancelled') return
    mediaDone(r, '', quoteId)
  }

  // The explicit retry of an uncertain photo send: the same dm.send, once.
  const retryMedia = async () => {
    if (!mediaHold || sendingMedia) return
    const held = mediaHold
    setMediaError('')
    const r = await retryChatSend({ op: held.op, request: dm, onPhase: setMediaSend, uncertain: unsureSend })
    mediaDone(r, held.text, held.quoteId)
  }

  // Before the request starts, Cancelar drops the photos and nothing is sent.
  const cancelMedia = () => {
    if (mediaSend !== null && mediaSend.phase === 'sending') return
    if (sendTokenRef.current) sendTokenRef.current.live = false
    sendTokenRef.current = null
    setMediaSend(null)
    setMediaHold(null)
    setMediaError('')
    attachments.clear()
  }

  const onSend = () => {
    if (mediaHold) return retryMedia()
    if (attachments.items.length > 0) return sendMedia(draft, replyTo ? replyTo.id : null)
    if (hold && pageKey !== null) return retryHeld()
    const quoteId = replyTo ? replyTo.id : null
    const plan = sendPlan(hold, draft, quoteId)
    if (plan === 'confirm') setAskNew(true)
    else if (plan === 'retry') send(hold.text, hold.quoteId)
    else send(draft, quoteId)
  }

  const refreshAll = async () => {
    setRefreshing(true)
    try { await dm('dm.pull', {}) } catch {}
    reread()
    readLookup()
    setRefreshing(false)
  }

  // Lands only while its cursor is still the one shown, so a page that
  // started before another one can neither duplicate nor reorder rows.
  const loadOlder = async () => {
    const cursor = nextRef.current
    if (!cursor || loadingMore) return
    setLoadingMore(true)
    try {
      const r = await dm('dm.thread', { peer, before: cursor })
      if (cursor === nextRef.current) {
        olderRef.current = true
        const merged = mergeMessages(Array.isArray(r.messages) ? r.messages : [], rawRef.current)
        rawRef.current = merged
        setRaw(merged)
        setNext(r.next || null)
      }
    } catch (err) {
      setLoadError(errorText(err))
    }
    setLoadingMore(false)
  }

  const open = onOpenMember ? () => onOpenMember(peer) : undefined
  const topRight = { icon: 'mais', label: 'opções da conversa', onPress: () => setMenu(true) }
  // The peer's own username is known without a lookup, so that mention opens
  // the profile directly; any other @nome goes to the app's resolver.
  const mentionTap = onOpenMember || typeof onOpenMention === 'function'
    ? (username) => {
        if (open && peerProfile && peerProfile.username === username) open()
        else if (typeof onOpenMention === 'function') onOpenMention(username)
      }
    : undefined

  if (!hosted || !unlocked) {
    return (
      <View style={styles.root}>
        <TopBar title='Mensagem' onBack={onBack} />
        <EmptyState icon='conversas' title='Mensagens bloqueadas' body='Desbloqueie com a passkey para ler suas mensagens.' />
      </View>
    )
  }

  const rows = withDayMarks(threadRows(raw), now)
  for (const row of rows) {
    row.inviteLink = row.deleted === true || typeof onOpenInvite !== 'function'
      ? null
      : inviteLinkOf(row.rawText, origin)
  }

  // The author of a quoted message: the row it points to, found through the
  // raw message's reply id (the row only carries the quote's text).
  // Ids are unique only per sender: when two rows share one, the smaller
  // sender key wins, the same rule threadOf uses for the quoted text, so the
  // author and the text of a quote always come from the same message.
  const rowById = new Map()
  for (const r of rows) {
    const held = rowById.get(r.id)
    if (held === undefined || String(r.from) < String(held.from)) rowById.set(r.id, r)
  }
  const replyIdOf = new Map(raw.map((m) => [messageKey(m), m.replyTo]))
  const quoteTarget = (item) => rowById.get(replyIdOf.get(item.key))
  const quoteMine = (item) => {
    const target = quoteTarget(item)
    return !!target && target.mine === true
  }
  // A quote of a message outside the loaded page has no known author yet: no
  // name, rather than one that changes when older messages load.
  const quoteAuthor = (item) => {
    const target = quoteTarget(item)
    if (!target) return ''
    return target.mine === true ? OWN_LABEL : quoteName
  }

  let blockNote = null
  if (blocked) blockNote = LABELS.blockedSend
  else if (peer === ownKey || peer === pageKey) blockNote = LABELS.selfSend
  else if (lookup === null) blockNote = LABELS.noBox

  const left = MAX_TEXT - countChars(draft)
  const staged = attachments.items.length > 0
  const canSend = blockNote === null && node.online !== false && left >= 0 &&
    (staged ? attachments.ready && !sendingMedia : draft.trim() !== '')
  const mediaOf = new Map(raw.map((m) => [messageKey(m), m.media]))

  let composer
  if (folder === null) {
    composer = (
      <View style={styles.composer}>
        {loadError ? <ErrorText>{loadError}</ErrorText> : <Skeleton rows={1} />}
      </View>
    )
  } else if (blocked) {
    composer = (
      <View style={styles.composer}>
        <Soft>{LABELS.blockedSend}</Soft>
        <ErrorText>{act.error}</ErrorText>
        <View style={styles.inline}>
          <Pill label={LABELS.unblock} onPress={() => decide('unblocked')} pending={act.pending} />
        </View>
      </View>
    )
  } else if (folder === 'request') {
    composer = (
      <View style={styles.composer}>
        <Soft>{LABELS.requestNote}</Soft>
        <ErrorText>{act.error}</ErrorText>
        <View style={styles.inline}>
          <Pill label={LABELS.accept} filled onPress={() => decide('accepted')} pending={act.pending} />
          <Pill label={LABELS.decline} onPress={() => decide('declined')} pending={act.pending} />
          <Pill label={LABELS.block} danger onPress={() => decide('blocked')} pending={act.pending} />
        </View>
      </View>
    )
  } else if (blockNote !== null) {
    // No field that takes no typing: say why, and for a missing key let the
    // person check again (the other side publishes it when it opens the app).
    composer = (
      <View style={styles.composer}>
        <Soft>{blockNote}</Soft>
        {lookup === null
          ? <View style={styles.inline}><Pill label='verificar de novo' onPress={readLookup} /></View>
          : null}
      </View>
    )
  } else {
    const notice = (
      <View style={styles.notice}>
        {mediaHold
          ? (
            <View style={styles.inline}>
              <Soft>{LABELS.uncertain}</Soft>
              <Pill label='Tentar de novo' onPress={retryMedia} pending={sendingMedia} />
              <Pill label='descartar' onPress={cancelMedia} />
            </View>
            )
          : null}
        {mediaError || attachments.note ? <ErrorText>{mediaError || attachments.note}</ErrorText> : null}
        {hold
          ? (
            <View style={styles.inline}>
              <Soft>{LABELS.uncertain}</Soft>
              {/* A page re-puts only its signed bytes (hold.retry) and never signs
                  a second message; a personal account sends the same text again. */}
              {typeof hold.retry === 'function' || pageKey === null
                ? <Pill label='Tentar de novo' onPress={typeof hold.retry === 'function' ? retryHeld : () => send(hold.text, hold.quoteId)} pending={post.pending} />
                : null}
              <Pill label='descartar' onPress={() => { setHold(null); setAskNew(false) }} />
            </View>
            )
          : <ErrorText>{post.error}</ErrorText>}
        {hold && askNew && pageKey === null
          ? (
            <View style={styles.inline}>
              <Soft>A mensagem anterior pode já ter chegado. Enviar este novo texto também?</Soft>
              <Pill label='Enviar o novo' filled onPress={() => send(draft, replyTo ? replyTo.id : null)} pending={post.pending} />
              <Pill label='cancelar' onPress={() => setAskNew(false)} />
            </View>
            )
          : null}
      </View>
    )
    composer = (
      <ChatComposer
        value={draft}
        onChangeText={(t) => { setDraft(t); setAskNew(false) }}
        onSend={onSend}
        sending={post.pending || sendingMedia}
        sendDisabled={!canSend}
        editable={!(hold && pageKey !== null) && mediaHold === null && !sendingMedia}
        onAttach={canAttach && !hold ? (kind, file) => attachments.pick(file) : null}
        onVoice={isTop && canAttach && !hold && mediaHold === null && attachments.items.length === 0 ? sendVoice : null}
        attachments={staged ? attachments.items : null}
        onRemoveAttachment={mediaHold === null ? attachments.remove : undefined}
        onCancelAttachments={mediaHold === null && !(mediaSend && mediaSend.phase === 'sending') ? cancelMedia : undefined}
        progress={sendingMedia ? mediaSend.progress : null}
        reply={replyTo ? { name: replyTo.name, handle: replyTo.mine ? undefined : quoteHandle, text: replyTo.text, mine: replyTo.mine, senderKey: replyTo.mine ? undefined : peer } : null}
        onCancelReply={() => setReplyTo(null)}
        notice={notice}
        ownKey={ownKey}
      />
    )
  }

  let empty = null
  if (!loaded) empty = <Skeleton />
  else if (loadError) empty = <View style={styles.pad}><ErrorText>{loadError}</ErrorText></View>
  else empty = <EmptyState icon='conversas' title='Nenhuma mensagem' body='Escreva a primeira.' />

  // On iOS the keyboard opens over the bottom composer unless the screen
  // shrinks for it (Android resizes the window itself: adjustResize).
  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ChatHeader
        title={nameText}
        subtitle={peerWho.subtitle || undefined}
        publicKey={peer}
        picture={peerProfile ? peerProfile.avatar : undefined}
        onBack={onBack}
        onPress={open}
        pressLabel='abrir o perfil'
        right={topRight}
      />
      <OfflineNote />
      <RefreshableList
        data={rows}
        listRef={listRef}
        keyExtractor={(row) => row.key}
        renderItem={({ item, index }) => {
          const mine = item.mine === true
          const link = item.inviteLink || null
          const actions = []
          if (!item.deleted) {
            actions.push({ icon: 'responder', label: 'Responder', onPress: () => setReplyTo({ id: item.id, text: item.text, mine, name: mine ? OWN_LABEL : quoteName }) })
            actions.push({ icon: 'copiar', label: 'Copiar', onPress: () => { copyText(shareNav(), displayText(item.rawText, { multiline: true })) } })
          }
          if (!mine && !item.deleted && typeof onReport === 'function') {
            actions.push({ icon: 'bandeira', label: LABELS.report, danger: true, onPress: () => onReport({ dm: true, id: item.id, text: item.rawText, author: item.from, ...(Array.isArray(mediaOf.get(item.key)) ? { media: mediaOf.get(item.key) } : {}) }) })
          }
          const quoted = item.replyTo !== null && item.replyTo !== undefined
            ? { name: quoteAuthor(item), handle: quoteMine(item) ? undefined : quoteHandle, text: item.replyTo, mine: quoteMine(item), senderKey: quoteMine(item) ? undefined : peer }
            : null
          const refs = item.deleted ? [] : chatMediaRefs('dm', { from: item.from || (mine ? ownKey : null), id: item.id, media: mediaOf.get(item.key) })
          return (
            <Bubble
              media={refs.length > 0 ? <ChatMedia refs={refs} identity={ownKey} mine={mine} deferred={folder === 'request'} /> : null}
              item={{ key: item.key, text: item.text, rawText: link ? undefined : item.rawText, at: item.at, deleted: item.deleted, dayMark: item.dayMark }}
              mine={mine}
              shape={bubbleShape(rows, index)}
              quote={quoted}
              actions={actions}
              onOpenMention={mentionTap}
              below={link !== null ? <Pill label={OPEN_INVITE} accessibilityLabel={OPEN_INVITE + (link.kind === 'grupo' ? ', abre o grupo' : ', abre a comunidade')} onPress={() => onOpenInvite(link)} /> : null}
            />
          )
        }}
        extraData={{ now, nameText, folder }}
        ListHeaderComponent={next ? <View style={styles.pad}><Pill label='mensagens anteriores' onPress={loadOlder} pending={loadingMore} /></View> : null}
        ListEmptyComponent={empty}
        onRefresh={refreshAll}
        refreshing={refreshing}
        keepVisiblePosition
      />
      {composer}
      <Sheet open={menu} onClose={() => setMenu(false)} title='Conversa'>
        <View style={styles.sheet}>
          <ErrorText>{act.error}</ErrorText>
          {blocked
            ? <Btn label={LABELS.unblock} onPress={() => decide('unblocked')} pending={act.pending} secondary />
            : <Btn label={LABELS.block} onPress={() => decide('blocked')} pending={act.pending} secondary />}
          {confirmDelete
            ? (
              <View style={styles.sheet}>
                <Soft>Apagar esta conversa só neste aparelho? A outra pessoa continua com a cópia dela.</Soft>
                <Btn label='Apagar' danger onPress={() => decide('deleted')} pending={act.pending} />
                <Btn label='Cancelar' secondary onPress={() => setConfirmDelete(false)} />
              </View>
              )
            : <Btn label={LABELS.delete} danger onPress={() => setConfirmDelete(true)} />}
        </View>
      </Sheet>
    </KeyboardAvoidingView>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  pad: { padding: 12, alignItems: 'center', gap: 6 },
  sheet: { padding: 16, gap: 12 },
  inline: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  notice: { gap: 6, paddingHorizontal: 12, paddingTop: 6 },
  composer: {
    borderTopWidth: 1,
    borderTopColor: colors.line,
    backgroundColor: colors.card,
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 6
  }
})
