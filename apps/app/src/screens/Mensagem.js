// Mensagem: one private conversation, pushed above the tabs (nav.js screen
// 'mensagem', keyed by the peer's diary key). Props: { peer, isTop, onBack,
// onOpenMember(peer), onOpenMention(username), onReport({ dm, id, text,
// author }), onOpenInvite(link) }.
// Oldest message on top, the composer at the bottom, scrolled to the end on
// open and on new messages. The header (avatar, name, @nome) names the peer
// from the profile cache, never the raw key; a tap on it opens the profile and
// one icon opens the conversation options. Rows are shared Bubbles (tails,
// day chips, five-minute runs); a long press offers Responder, Copiar,
// Encaminhar (ui/ForwardSheet, forward.js; a forwarded message shows
// "Encaminhada" and never its original author) and
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
// Feira offers (feiraOffer.js): while the thread holds a link to one of the
// peer's listings, "Fazer oferta" sends the offer link (a card and the text;
// a page sends text only). The listing author sees Aceitar and Recusar on
// the latest open offer: Aceitar first shows what the signature means, then
// signs listing.consent (as a page, the listing-consent action) and replies
// with the aceite link; the proposer then sees Avaliar (onAvaliar). The
// offer state is read from the thread every time, nothing else is stored,
// and an uncertain offer, aceite or recusa is resent only by "Tentar de novo".

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Keyboard, KeyboardAvoidingView, StyleSheet, View } from 'react-native'
import { useKeyboardAvoidEnabled } from '../ui/keyboardAvoid'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
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
import { listingLinkOf } from '../feiraChat'
import { parsePriceText, quickReplies } from '../feira'
import { CONSENT_NOTE, acceptCard, acceptText, buttonState, centsLabel, consentParams, declineCard, declineText, offerCard, offerOfMessage, offerState, offerTarget, proposalText, validCents } from '../feiraOffer'
import { mergeMessages, newestOf, pageDmRequest, refreshThread, sendPlan, threadRows, bubbleShape, withDayMarks, messageKey } from '../dm-screen'
import { actAs, pagesDm } from '../pages'
import { pagesOn } from '../pageGate'
import { cardFits, composePlan, stagedVoice, voiceUploadError } from '../attach-plan'
import { cardForSend, draftView, freezeSnapshot, linkDraftIdle, linkDraftStep, withCardFallback } from '../linkCard'
import { previewTarget } from '../preview'
import { revokeUrl, urlFromBytes } from '../media/display'
import { chatMediaRefs, retryChatSend, runChatSend, stagedOf } from '../chatSend'
import { Btn, ErrorText, Field, Soft, errorText, useAction, useNow } from '../ui'
import { useStyles } from '../ui/ThemeProvider'
import { Bubble } from '../ui/Bubble'
import { ChatComposer, useLinkDraft } from '../ui/ChatComposer'
import { ChatMedia } from '../ui/ChatMedia'
import { useChatAttachments } from '../ui/AttachSheet'
import { ChatHeader } from '../ui/ChatHeader'
import { OfflineNote } from '../ui/OfflineNote'
import { Pill } from '../ui/Pill'
import { RefreshableList } from '../ui/RefreshableList'
import { ActionsSheet } from '../ui/ActionsSheet'
import { Sheet } from '../ui/Sheet'
import { EmptyState, Skeleton } from '../ui/States'
import { ForwardSheet } from '../ui/ForwardSheet'
import { dmForwardSource } from '../forward'
import { TopBar } from '../ui/TopBar'
import { memberKeyOf, useActing } from './Conversa'

const BLOCKED_SEND = 'você bloqueou esta pessoa'
const unsureSend = (err) => !!(err && (err.uncertain === true || err.message === UNSURE_SEND))

export function initialMessage (initial) {
  const draft = typeof initial?.draft === 'string' ? displayText(initial.draft, { multiline: true }) : ''
  let card = linkDraftIdle()
  if (initial?.card && previewTarget(draft) === initial.card.url) {
    card = linkDraftStep(card, { type: 'target', url: initial.card.url })
    card = linkDraftStep(card, { type: 'built', url: initial.card.url, data: initial.card })
  }
  return { draft, card }
}

export function listingLinkForRow (row, origin) {
  if (!row || row.deleted === true) return null
  return listingLinkOf(row.rawText, origin) || listingLinkOf(row.card, origin)
}

// The quick replies are a buyer's questions: they show while the newest
// listing link in the thread names someone else's listing (the buyer sent
// the seller's card, or the seller sent one of theirs). `me` is the identity
// in use: the member, or the page acted as.
export function showListingReplies (rows, me) {
  for (let i = rows.length - 1; i >= 0; i--) {
    const link = rows[i].listingLink
    if (link !== null && link !== undefined) return typeof me === 'string' && link.author !== me
  }
  return false
}

export function messageEntry (previous, identity, initial) {
  if (!previous) return { identity, initial }
  return previous.identity === identity ? previous : { identity, initial: null }
}

export function Mensagem ({ initial, ...props }) {
  const node = useNode()
  const acting = useActing()
  const identity = (node.passkey?.status?.publicKey || '') + ':' + (acting.kind === 'page' ? acting.key : '')
  const entry = useRef(null)
  entry.current = messageEntry(entry.current, identity + ':' + props.peer, initial)
  // Remounting discards every draft, held send and attachment on a switch.
  return <MensagemThread key={identity + ':' + props.peer} {...props} initial={entry.current.initial} />
}

function MensagemThread ({ peer, initial, isTop = true, onBack, onOpenMember, onOpenMention, onReport, onOpenInvite, onOpenListing, onAvaliar }) {
  const styles = useStyles(makeStyles)
  const avoidKeyboard = useKeyboardAvoidEnabled()
  const insets = useSafeAreaInsets()
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
  const [draft, setDraft] = useState(() => initialMessage(initial).draft)
  const [initialCard, setInitialCard] = useState(() => initialMessage(initial).card)
  const [replyTo, setReplyTo] = useState(null)
  const [hold, setHold] = useState(null)
  const [menu, setMenu] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  // { source, refs } of the message the Encaminhar sheet forwards.
  const [forwarding, setForwarding] = useState(null)
  const post = useAction()
  const act = useAction()
  // Offers: the "Fazer oferta" sheet and its value, the offer an Aceitar
  // waits to confirm ({ offer, listing }), and offerHold { op, retry } after
  // an uncertain offer, aceite or recusa (resent only on a tap).
  const offerAct = useAction()
  const [offerOpen, setOfferOpen] = useState(false)
  const [offerValue, setOfferValue] = useState('')
  const [offerNote, setOfferNote] = useState('')
  const [confirming, setConfirming] = useState(null)
  const [offerHold, setOfferHold] = useState(null)
  const attachments = useChatAttachments()
  // The draft link card (not as a page: its sends are signed statements).
  const initialTarget = initialCard.url !== null && previewTarget(draft) === initialCard.url
  const automaticDraft = useLinkDraft({ text: draft, enabled: pageKey === null && !initialTarget, photos: attachments.items.length > 0, member: ownKey })
  useEffect(() => {
    if (attachments.items.length > 0) setInitialCard((s) => linkDraftStep(s, { type: 'photo' }))
  }, [attachments.items.length])
  const snapshot = pageKey === null && attachments.items.length === 0 ? freezeSnapshot(initialCard, draft) : null
  const [initialImage, setInitialImage] = useState(null)
  const thumb = snapshot?.thumb || null
  const thumbBytes = thumb?.bytes
  useEffect(() => {
    let uri = null
    if (thumbBytes) {
      try { uri = urlFromBytes(thumbBytes, thumb.mime) } catch {}
    }
    setInitialImage(uri)
    return () => { if (uri !== null) revokeUrl(uri) }
  }, [thumbBytes])
  const linkDraft = initialTarget
    ? {
        view: snapshot ? draftView(initialCard) : null,
        imageUri: snapshot ? initialImage : null,
        dismiss: () => setInitialCard((s) => linkDraftStep(s, { type: 'dismiss' })),
        take: (text) => attachments.items.length === 0 ? freezeSnapshot(initialCard, text) : null
      }
    : automaticDraft
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => { live.current = false }
  }, [])
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
    setOfferHold(null)
    setConfirming(null)
    setOfferOpen(false)
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

  // The keyboard shrinks the list: when the person was reading the newest
  // line, keep it above the composer instead of behind it.
  // Only a scroll leaves the bottom: a frame where just the list or its
  // content changed size (the keyboard, a sheet closing, a new line) keeps
  // the state, or the newest line stayed behind the composer afterwards.
  const atBottom = useRef(true)
  const lastY = useRef(null)
  const trackBottom = useCallback(({ y, contentHeight, layoutHeight }) => {
    const bottom = y + layoutHeight >= contentHeight - 48
    const resized = lastY.current !== null && y === lastY.current
    lastY.current = y
    if (resized && !bottom) return
    atBottom.current = bottom
  }, [])
  useEffect(() => {
    let timers = []
    const clear = () => { timers.forEach(clearTimeout); timers = [] }
    const sub = Keyboard.addListener('keyboardDidShow', () => {
      if (!atBottom.current) return
      clear()
      const toEnd = () => {
        const list = listRef.current
        if (list && typeof list.scrollToEnd === 'function') list.scrollToEnd({ animated: true })
      }
      // Twice: on Android the keyboard padding turns on with a re-render
      // (src/ui/keyboardAvoid.js), so the list shrinks after this event and
      // the first scroll can land before it (the newest message stayed under the composer).
      timers = [setTimeout(toEnd, 50), setTimeout(toEnd, 300)]
    })
    return () => {
      clear()
      sub.remove()
    }
  }, [])

  const decide = async (state) => {
    const r = await act.run(() => dm('dm.set', { peer, state }))
    reread()
    if (!r.ok) return
    setMenu(false)
    if (state === 'blocked') setBlocked(true)
    if (state === 'unblocked') setBlocked(false)
    if (state === 'deleted') onBack()
  }

  // heldCard: the card frozen into a held send (null: none). A fresh send
  // (undefined) takes the draft card, uploads its thumbnail once and keeps
  // the result with the hold, so an explicit retry never builds or uploads
  // again. A card the rules refuse goes without its image, then not at all.
  const send = async (text, quoteId, heldCard) => {
    setAskNew(false)
    lastErr.current = null
    const snapshot = heldCard === undefined && pageKey === null ? linkDraft.take(text) : null
    let card = heldCard === undefined ? null : heldCard
    const r = await post.run(async () => {
      try {
        const plain = { to: peer, text, ...(quoteId ? { replyTo: quoteId } : {}) }
        const target = { kind: 'dm', to: peer, ...(quoteId ? { replyTo: quoteId } : {}) }
        if (snapshot !== null) {
          // `to` keeps the thumbnail's blob to this conversation (rpc 5.97).
          const upload = mediaApi !== null ? (t) => mediaApi.putDm({ bytes: t.bytes, mime: t.mime, width: t.width, height: t.height, to: peer }) : null
          card = await cardForSend(snapshot, { upload, fits: (c) => cardFits({ text, target, card: c }) })
        }
        if (!live.current) return null
        const built = withCardFallback((c) => (c ? composePlan({ text, target, card: c }).send().params : plain), card)
        card = built.card
        return await dm('dm.send', built.op)
      } catch (err) {
        lastErr.current = err
        throw err
      }
    })
    if (!live.current) return
    const err = lastErr.current
    if (r.ok) {
      // A retry of a held message can land while a newer draft is being
      // written: only the composer that still holds this text is cleared.
      setDraft((d) => (d === text ? '' : d))
      setReplyTo((rt) => (rt && rt.id === quoteId ? null : rt))
      setHold(null)
    } else if (r.uncertain || (err && err.message === UNSURE_SEND)) {
      setHold({ text, quoteId, card, retry: pageKey !== null && err && typeof err.retry === 'function' ? err.retry : null })
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
      // `to` keeps this photo's blob to this conversation (rpc 5.97).
      upload: (f) => mediaApi.putDm({ bytes: f.bytes, mime: f.mime, width: f.width, height: f.height, to: peer }),
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
          return await mediaApi.putDm({ bytes: f.bytes, mime: f.mime, width: 0, height: 0, ms: f.ms, kind: 'voice', to: peer })
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

  // One offer step's dm.send. `op` is kept with an uncertain answer and only
  // "Tentar de novo" sends it again (a page re-puts its signed bytes).
  const offerSend = async (build) => {
    let lastOffer = null
    let sent = null
    const r = await offerAct.run(async () => {
      try {
        const step = await build()
        sent = step
        return await (step.retry ? step.retry() : dm('dm.send', step.op))
      } catch (err) {
        lastOffer = err
        throw err
      }
    })
    if (!live.current) return
    if (r.ok) {
      setOfferHold(null)
      setOfferOpen(false)
      setOfferValue('')
      setConfirming(null)
    } else if (sent !== null && (r.uncertain || unsureSend(lastOffer))) {
      const retry = pageKey !== null && lastOffer && typeof lastOffer.retry === 'function' ? lastOffer.retry : null
      setOfferHold({ op: sent.op, retry })
      setOfferOpen(false)
      setConfirming(null)
    } else if (lastOffer && lastOffer.message === BLOCKED_SEND) {
      setBlocked(true)
    }
    reread()
  }

  // A personal account sends the link as a card and in the text; a page's
  // sends are text only (signed statements), so the text always holds it.
  const offerOp = (text, card, replyId) => {
    const target = { kind: 'dm', to: peer, ...(replyId ? { replyTo: replyId } : {}) }
    if (pageKey !== null || card === null) return { to: peer, text, ...(replyId ? { replyTo: replyId } : {}) }
    return composePlan({ text, target, card }).send().params
  }

  const sendOffer = (listing) => {
    setOfferNote('')
    const cents = parsePriceText(offerValue)
    if (!validCents(cents)) {
      setOfferNote('Escreva um valor maior que zero, como 80 ou 12,50.')
      return
    }
    const card = offerCard({ origin, listing, cents })
    if (card === null) {
      setOfferNote('Não foi possível montar a oferta.')
      return
    }
    offerSend(async () => ({ op: offerOp(proposalText(listing, cents, card.url, { asPage: pageKey !== null }), card, null) }))
  }

  const acceptOffer = ({ offer, listing }) => offerSend(async () => {
    const params = consentParams(listing, offer)
    if (params === null) throw new Error('oferta não encontrada')
    let signed
    if (pageKey !== null) {
      const n = nodeRef.current
      signed = await actAs(n, { member: await memberKeyOf(request, n), action: 'listing-consent', page: pageKey, op: params })
    } else {
      signed = await request('listing.consent', params)
    }
    const card = acceptCard({ origin, listing, cents: offer.cents, consent: signed && signed.consent })
    if (card === null) throw new Error('Não foi possível montar a resposta.')
    return { op: offerOp(acceptText(offer.cents, card.url), card, offer.id) }
  })

  const declineOffer = ({ offer, listing }) => offerSend(async () => {
    const card = declineCard({ origin, listing, cents: offer.cents })
    if (card === null) throw new Error('oferta não encontrada')
    return { op: offerOp(declineText(offer.cents, card.url), card, offer.id) }
  })

  const retryOffer = () => {
    if (!offerHold) return
    const held = offerHold
    offerSend(async () => ({ op: held.op, retry: held.retry }))
  }

  const onSend = () => {
    if (mediaHold) return retryMedia()
    if (attachments.items.length > 0) return sendMedia(draft, replyTo ? replyTo.id : null)
    if (hold && pageKey !== null) return retryHeld()
    const quoteId = replyTo ? replyTo.id : null
    const plan = sendPlan(hold, draft, quoteId)
    if (plan === 'confirm') setAskNew(true)
    else if (plan === 'retry') send(hold.text, hold.quoteId, hold.card || null)
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
  // The keyboard is put away first: it came back by itself after the sheets
  // and covered the newest line.
  const topRight = { icon: 'mais', label: 'opções da conversa', onPress: () => { Keyboard.dismiss(); setMenu(true) } }
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

  const cardOf = new Map(raw.map((m) => [messageKey(m), m.card]))
  const rows = withDayMarks(threadRows(raw), now)
  for (const row of rows) {
    row.inviteLink = row.deleted === true || typeof onOpenInvite !== 'function'
      ? null
      : inviteLinkOf(row.rawText, origin)
    row.listingLink = listingLinkForRow({ ...row, card: cardOf.get(row.key) }, origin)
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

  // The thread as offer input: every row with its card, reply id and sender.
  const me = pageKey !== null ? pageKey : ownKey
  const offerMsgs = rows.map((r) => ({ id: r.id, from: r.from, mine: r.mine, text: r.rawText, card: cardOf.get(r.key), replyTo: replyIdOf.get(r.key), at: r.at, deleted: r.deleted }))
  const linkOfMsg = (m) => listingLinkOf(m.text, origin) || listingLinkOf(m.card, origin)
  const offerListing = peer !== me ? offerTarget(offerMsgs, peer, origin, linkOfMsg) : null
  const offerStates = new Map()
  const offerOfRow = (index) => {
    const m = offerMsgs[index]
    const ref = offerOfMessage(m, origin)
    if (ref === null || ref.aceite !== null || ref.recusada) return null
    const listing = { author: ref.author, seq: ref.seq }
    const key = ref.author + ':' + ref.seq
    if (!offerStates.has(key)) offerStates.set(key, offerState(offerMsgs, me, listing, origin))
    const offer = offerStates.get(key)
    if (!offer || offer.id !== m.id || offer.from !== (m.mine ? me : m.from)) return null
    const buttons = buttonState(offer, me, listing)
    // A page does not rate in v1.
    const rate = buttons.rate && pageKey === null && node.online !== false && typeof onAvaliar === 'function'
    return buttons.answer || rate ? { offer, listing, answer: buttons.answer, rate } : null
  }
  const offerBusy = offerAct.pending || offerHold !== null
  // Answers go out only where the composer could send.
  const canAnswer = folder === 'inbox' && !blocked && node.online !== false && !offerBusy

  let blockNote = null
  if (blocked) blockNote = LABELS.blockedSend
  else if (peer === ownKey || peer === pageKey) blockNote = LABELS.selfSend
  else if (lookup === null) blockNote = LABELS.noBox

  const left = MAX_TEXT - countChars(draft)
  const staged = attachments.items.length > 0
  const canSend = blockNote === null && node.online !== false && left >= 0 &&
    (staged ? attachments.ready && !sendingMedia : draft.trim() !== '')
  const mediaOf = new Map(raw.map((m) => [messageKey(m), m.media]))
  const fwdOf = new Map(raw.map((m) => [messageKey(m), m.fwd]))
  // Forwarding writes as the person, never as a page.
  const canForward = pageKey === null && unlocked

  // Footers without a field sit on the gesture bar: keep their buttons above it.
  const footer = [styles.composer, { paddingBottom: Math.max(8, insets.bottom) }]
  let composer
  if (folder === null) {
    composer = (
      <View style={footer}>
        {loadError ? <ErrorText>{loadError}</ErrorText> : <Skeleton rows={1} />}
      </View>
    )
  } else if (blocked) {
    composer = (
      <View style={footer}>
        <Soft>{LABELS.blockedSend}</Soft>
        <ErrorText>{act.error}</ErrorText>
        <View style={styles.inline}>
          <Pill label={LABELS.unblock} onPress={() => decide('unblocked')} pending={act.pending} />
        </View>
      </View>
    )
  } else if (folder === 'request') {
    composer = (
      <View style={footer}>
        <Soft>{LABELS.requestNote}</Soft>
        <ErrorText>{act.error}</ErrorText>
        <View style={styles.decide}>
          <View style={styles.decideItem}><Pill label={LABELS.accept} filled onPress={() => decide('accepted')} pending={act.pending} /></View>
          <View style={styles.decideItem}><Pill label={LABELS.decline} onPress={() => decide('declined')} pending={act.pending} /></View>
        </View>
      </View>
    )
  } else if (blockNote !== null) {
    // No field that takes no typing: say why, and for a missing key let the
    // person check again (the other side publishes it when it opens the app).
    composer = (
      <View style={footer}>
        <Soft>{blockNote}</Soft>
        <ErrorText>{act.error}</ErrorText>
        {lookup === null
          ? <View style={styles.inline}><Pill label='verificar de novo' onPress={readLookup} /></View>
          : null}
      </View>
    )
  } else {
    const notice = (
      <View style={styles.notice}>
        {/* The conversation menu closes before its action runs: a failed
            block or delete says so here. */}
        <ErrorText>{act.error}</ErrorText>
        {showListingReplies(rows, pageKey !== null ? pageKey : ownKey) && !hold && !mediaHold && !sendingMedia && !post.pending
          ? (
            <View style={styles.inline}>
              {quickReplies().map((text) => <Pill key={text} label={text} onPress={() => { setDraft((d) => d.trim() ? d + '\n' + text : text); setAskNew(false) }} />)}
            </View>
            )
          : null}
        {offerListing !== null && !hold && !mediaHold && !sendingMedia && !post.pending && !offerBusy
          ? <View style={styles.inline}><Pill label='Fazer oferta' onPress={() => { setOfferNote(''); offerAct.clearError(); setOfferOpen(true) }} /></View>
          : null}
        {offerHold
          ? (
            <View style={styles.inline}>
              <Soft>{LABELS.uncertain}</Soft>
              {offerHold.retry !== null || pageKey === null
                ? <Pill label='Tentar de novo' onPress={retryOffer} pending={offerAct.pending} />
                : null}
              <Pill label='descartar' onPress={() => setOfferHold(null)} />
            </View>
            )
          : (!offerOpen && confirming === null && offerAct.error ? <ErrorText>{offerAct.error}</ErrorText> : null)}
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
                ? <Pill label='Tentar de novo' onPress={typeof hold.retry === 'function' ? retryHeld : () => send(hold.text, hold.quoteId, hold.card || null)} pending={post.pending} />
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
        linkDraft={linkDraft}
      />
    )
  }

  let empty = null
  if (!loaded) empty = <Skeleton />
  else if (loadError) empty = <View style={styles.pad}><ErrorText>{loadError}</ErrorText></View>
  else empty = <EmptyState icon='conversas' title='Nenhuma mensagem' body='Escreva a primeira.' />

  // The keyboard opens over the bottom composer unless the screen shrinks for
  // it: iOS never resizes, and Android runs edge to edge (targetSdk 36), where
  // adjustResize no longer resizes the window either. On the web it is a View.
  return (
    <KeyboardAvoidingView style={styles.root} behavior='padding' enabled={avoidKeyboard}>
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
          const listing = item.listingLink
          const offerRow = item.deleted ? null : offerOfRow(index)
          const actions = []
          const refs = item.deleted ? [] : chatMediaRefs('dm', { from: item.from || (mine ? ownKey : null), id: item.id, media: mediaOf.get(item.key) })
          if (!item.deleted) {
            actions.push({ icon: 'responder', label: 'Responder', onPress: () => setReplyTo({ id: item.id, text: item.text, mine, name: mine ? OWN_LABEL : quoteName }) })
            actions.push({ icon: 'copiar', label: 'Copiar', onPress: () => { copyText(shareNav(), displayText(item.rawText, { multiline: true })) } })
          }
          // A message with no text whose media expired has nothing to forward.
          const forwardSource = !item.deleted && canForward ? dmForwardSource(item.rawText, mediaOf.get(item.key)) : null
          if (forwardSource !== null) {
            actions.push({ icon: 'encaminhar', label: 'Encaminhar', onPress: () => setForwarding({ source: forwardSource, refs }) })
          }
          if (!mine && !item.deleted && typeof onReport === 'function') {
            actions.push({ icon: 'bandeira', label: LABELS.report, danger: true, onPress: () => onReport({ dm: true, id: item.id, text: item.rawText, author: item.from, ...(Array.isArray(mediaOf.get(item.key)) ? { media: mediaOf.get(item.key) } : {}) }) })
          }
          const quoted = item.replyTo !== null && item.replyTo !== undefined
            ? { name: quoteAuthor(item), handle: quoteMine(item) ? undefined : quoteHandle, text: item.replyTo, mine: quoteMine(item), senderKey: quoteMine(item) ? undefined : peer }
            : null
          return (
            <Bubble
              media={refs.length > 0 ? <ChatMedia refs={refs} identity={ownKey} mine={mine} deferred={folder === 'request'} /> : null}
              item={{ key: item.key, text: item.text, rawText: link ? undefined : item.rawText, at: item.at, deleted: item.deleted, dayMark: item.dayMark, card: !item.deleted && cardOf.get(item.key) ? cardOf.get(item.key) : null }}
              mine={mine}
              cardThumb={item.deleted || pageKey !== null ? undefined : { kind: 'dm', from: item.from || (mine ? ownKey : null), id: item.id, identity: ownKey }}
              shape={bubbleShape(rows, index)}
              forwarded={!item.deleted && fwdOf.get(item.key) === 1}
              quote={quoted}
              actions={actions}
              onOpenMention={mentionTap}
              below={link !== null || offerRow !== null || (listing !== null && typeof onOpenListing === 'function')
                ? (
                  <View style={styles.inline}>
                    {link !== null ? <Pill label={OPEN_INVITE} accessibilityLabel={OPEN_INVITE + (link.kind === 'grupo' ? ', abre o grupo' : ', abre a comunidade')} onPress={() => onOpenInvite(link)} /> : null}
                    {listing !== null && typeof onOpenListing === 'function' ? <Pill label='Ver anúncio' onPress={() => onOpenListing(listing.author, listing.seq)} /> : null}
                    {offerRow !== null && offerRow.answer && canAnswer
                      ? <Pill label='Aceitar' filled onPress={() => { offerAct.clearError(); setConfirming({ offer: offerRow.offer, listing: offerRow.listing }) }} />
                      : null}
                    {offerRow !== null && offerRow.answer && canAnswer
                      ? <Pill label='Recusar' onPress={() => declineOffer({ offer: offerRow.offer, listing: offerRow.listing })} />
                      : null}
                    {offerRow !== null && offerRow.rate
                      ? <Pill label='Avaliar' onPress={() => onAvaliar({ author: offerRow.listing.author, seq: offerRow.listing.seq, offer: offerRow.offer.id })} />
                      : null}
                  </View>
                  )
                : null}
            />
          )
        }}
        extraData={{ now, nameText, folder }}
        ListHeaderComponent={next ? <View style={styles.pad}><Pill label='mensagens anteriores' onPress={loadOlder} pending={loadingMore} /></View> : null}
        ListEmptyComponent={empty}
        onRefresh={refreshAll}
        refreshing={refreshing}
        keepVisiblePosition
        onScrollFrame={trackBottom}
      />
      {composer}
      <ForwardSheet
        open={forwarding !== null}
        onClose={() => setForwarding(null)}
        source={forwarding ? forwarding.source : null}
        refs={forwarding ? forwarding.refs : []}
        identity={ownKey}
      />
      <Sheet open={offerOpen && offerListing !== null} onClose={() => { if (!offerAct.pending) setOfferOpen(false) }} title='Fazer oferta'>
        <View style={styles.sheet}>
          <Soft>{offerListing !== null && offerListing.title !== '' ? displayText(offerListing.title) : 'Anúncio na Feira'}</Soft>
          <Field label='Valor (R$)' value={offerValue} onChangeText={(t) => { setOfferValue(t); setOfferNote('') }} placeholder='80,00' maxLength={16} editable={!offerAct.pending} />
          <Soft>A oferta vai como mensagem nesta conversa. Não é um pagamento: vocês combinam o resto por aqui.</Soft>
          <ErrorText>{offerNote || offerAct.error}</ErrorText>
          <Btn label='Enviar oferta' onPress={() => sendOffer(offerListing)} pending={offerAct.pending} disabled={node.online === false || offerValue.trim() === ''} />
          <Btn label='Cancelar' secondary onPress={() => setOfferOpen(false)} disabled={offerAct.pending} />
        </View>
      </Sheet>
      <Sheet open={confirming !== null} onClose={() => { if (!offerAct.pending) setConfirming(null) }} title='Aceitar oferta'>
        <View style={styles.sheet}>
          <Soft>{confirming !== null ? 'Oferta de ' + centsLabel(confirming.offer.cents) + '.' : ''}</Soft>
          <Soft>{CONSENT_NOTE}</Soft>
          <ErrorText>{offerAct.error}</ErrorText>
          <Btn label='Aceitar e assinar' onPress={() => acceptOffer(confirming)} pending={offerAct.pending} disabled={node.online === false} />
          <Btn label='Cancelar' secondary onPress={() => setConfirming(null)} disabled={offerAct.pending} />
        </View>
      </Sheet>
      {/* Two actions: the compact menu, and the delete confirmation as its own
          compact step with one Cancelar. */}
      <ActionsSheet
        open={menu}
        onClose={() => setMenu(false)}
        title='Conversa'
        actions={[
          blocked
            ? { icon: 'ok', label: LABELS.unblock, onPress: () => decide('unblocked'), pending: act.pending }
            : { icon: 'slash', label: LABELS.block, onPress: () => decide('blocked'), pending: act.pending },
          { icon: 'lixeira', label: LABELS.delete, danger: true, onPress: () => setConfirmDelete(true) }
        ]}
      />
      <ActionsSheet
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title='Apagar esta conversa?'
        // Cancelar first: on the web the sheet's focus lands on its first row,
        // so a second Enter after "Apagar conversa" never deletes by accident.
        actions={[
          { icon: 'fechar', label: 'Cancelar', onPress: () => {} },
          { icon: 'lixeira', label: 'Apagar', danger: true, description: 'Só neste aparelho. A outra pessoa continua com a cópia dela.', pending: act.pending, onPress: () => decide('deleted') }
        ]}
      />
    </KeyboardAvoidingView>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  pad: { padding: 12, alignItems: 'center', gap: 6 },
  inline: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  // Accept and decline split the row evenly, like the request bars of other messengers.
  decide: { flexDirection: 'row', gap: 8 },
  decideItem: { flex: 1, alignItems: 'stretch' },
  notice: { gap: 6, paddingHorizontal: 12, paddingTop: 6 },
  composer: {
    borderTopWidth: 1,
    borderTopColor: colors.line,
    backgroundColor: colors.card,
    paddingHorizontal: 16,
    paddingVertical: 8,
    gap: 6
  }
})
