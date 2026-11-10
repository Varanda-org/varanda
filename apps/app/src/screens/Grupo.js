// Grupo: one group's conversation, pushed above the tabs (nav.js screen
// 'grupo', keyed by the group root). Props: { group, onBack,
// onOpenCommunity(community, { group }?), onOpenMember(diary), onMessage(diary), onOpenMention(username),
// onReport(target), onSeen(group), isTop }, with `target` in Denunciar's shape
// { author, name, username, seq, text, group, writer, private }; onSeen runs
// after every group.seen attempt, answered or not. Only what the person sees
// is marked seen, up to the newest painted row: the app visible, this screen
// on top (isTop false: buried under another screen) and the latest read
// painted. Renders GrupoAjustes itself as a sheet, opened by the header's
// settings icon or a tap on its titles. onMessage(diary) adds 'Conversar em
// particular' to another person's message menu (hosted only, never for the
// own diary); it passes the verified diary key and nothing from the group. The header shows the group's name
// and member count; the community is a small line under it that opens it.
// Messages are bubbles (group-screen.js groupRows, ui/Bubble): a long press
// offers Responder, Copiar, Encaminhar (ui/ForwardSheet, forward.js),
// Esconder, Banir and Denunciar under can(). A forwarded message (fwd 1)
// shows "Encaminhada", never its original author. A reply
// is sent as group.post replyTo { writer, seq } and drawn as a quote of the
// loaded target only (never fetched).
// A group without a community (orphan) is read-only. Joining needs the
// community first: a group opened from a /g/<hex> link this node does not
// know is looked up in the seeder index, and its community opens first with
// the group queued after community.join.
// Oldest message on top, newest at the bottom; older pages come from the
// `before` cursor (groups.js applyPage). The screen re-reads when the
// node's version of the group moves (groups.changed) and on pull to refresh.
// Someone who has not joined (opened from a /g/<hex> link) sees what
// group.info knows and an "Entrar no grupo" button; a private group never
// shows a message to them. A member whose writer is not on this device
// reads the same way, but the composer is replaced until this device joins:
// a post without that writer is refused. The draft lives only in this component's state:
// never queued, never persisted (for a private group that would leak the
// plaintext). A mutation answered UNCERTAIN is never resent: the screen
// re-reads, asks groups.js reconcile and only then offers "tentar de novo".
// Hosted node only: a node that is not hosted sees the "Só na versão web"
// state, like Avisos.
// Photos and GIFs (a member posting as themself, when the node offers
// media.upload and is online): the clip opens the attach sheet; the photos
// upload in order (sealed for a private group, so only members open them),
// then one group.post carries them (attach-plan.js composePlan, chatSend.js
// runChatSend) under a progress ring. Cancelar before the post discards
// them. An uncertain post keeps that exact request and only "tentar de novo"
// resends it. Photos in the thread render inside the bubble (ChatMedia).
// Voice notes take the same path: with an empty field the composer records
// one (where the device can make audio/mp4), it is uploaded (sealed in a
// private group) as the only item of one group.post, and the bubble plays
// it (VoiceBubble).
// As a page, the visibility comes only from the node's read with the page's
// key (group.read { group, page }, from the verified header), never from the
// service, which could otherwise get a private post sent as plaintext. A
// private group is read by the node and a post is sealed by it (group.seal)
// and sent as 'group-seal', so the service only appends what it cannot read.
// A public one is read and posted through the service. Until the node
// answers, the composer stays closed.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Keyboard, KeyboardAvoidingView, Pressable, StyleSheet, Text, View } from 'react-native'
import { useKeyboardAvoidEnabled } from '../ui/keyboardAvoid'
import { MAX_TEXT, displayText } from '@varanda/rpc'
import { useNode } from '../node'
import { countChars } from '../format'
import { groupRows, replyPreview } from '../group-screen'
import { pinToEnd } from '../dm-screen'
import { UNNAMED, readsAs, whoOf } from '../who'
import { copyText } from '../share'
import { shareNav } from '../shareNav'
import {
  AS_PAGE_LABEL, DEVICE_APPROVAL_TEXT, DEVICE_JOIN_LABEL, DEVICE_JOIN_TEXT, DEVICE_RESERVE_TEXT, DEVICE_WAIT_TEXT,
  EMPTY_PAGES, OWN_LABEL, PAGE_GROUP_LOADING_TEXT, PAGE_NO_KEY_TEXT, PAGE_JOIN_LABEL, PAGE_LEAVE_LABEL, PAGE_REKEYING_TEXT, PAGE_SEAL_AGAIN_LABEL, PRIVATE_LABEL, REKEY_PENDING_LABEL,
  applyPage, can, canWriteHere, reserveReachedAny, needsReserveConfirm, itemsOf, knownVisibility, membersLabel, needsDeviceJoin, pageCan, pagePostVisibility, postAsPage, readAsPage, pageGroupErrorText, pageMode, pageRoleLabel, pageRoleOf, reconcile, roleLabel, roleOf, sealRaced, sealedLabel, visibilityLabel
} from '../groups'
import { Btn, ConfirmStack, ErrorText, Notice, Soft, errorText, useAction, useNow } from '../ui'
import { useStyles, useTheme } from '../ui/ThemeProvider'
import { Avatar } from '../ui/Avatar'
import { Bubble } from '../ui/Bubble'
import { ChatComposer, useLinkDraft } from '../ui/ChatComposer'
import { cardForSend, withCardFallback } from '../linkCard'
import { ChatHeader } from '../ui/ChatHeader'
import { Icon } from '../ui/Icon'
import { MoreButton } from '../ui/MoreButton'
import { OfflineNote } from '../ui/OfflineNote'
import { Pill } from '../ui/Pill'
import { RefreshableList } from '../ui/RefreshableList'
import { EmptyState, ErrorState, Skeleton } from '../ui/States'
import { TopBar } from '../ui/TopBar'
import { ForwardSheet } from '../ui/ForwardSheet'
import { space } from '../ui/theme'
import { fetchGroup } from '../indexClient'
import { useNames } from '../names'
import { pagesOn } from '../pageGate'
import { pagesGroup } from '../pages'
import { memberKeyOf, useActing } from './Conversa'
import { shouldRedirectToCommunity } from '../groupRedirect'
import { GrupoAjustes } from './GrupoAjustes'
import { composePlan, stagedVoice, voiceUploadError } from '../attach-plan'
import { publicGroupRefusal } from '../wordCheck'
import { chatMediaRefs, followAutocorrect, mediaPostLanded, retryChatSend, runChatSend, stagedOf } from '../chatSend'
import { ChatMedia } from '../ui/ChatMedia'
import { useChatAttachments } from '../ui/AttachSheet'

export const WEB_ONLY_TEXT = 'Comunidades só na versão web'
const ORPHAN_TEXT = 'Este grupo não pertence a nenhuma comunidade.'
const NEED_COMMUNITY = 'entre na comunidade primeiro'
const HEX64 = /^[0-9a-f]{64}$/
const LOCKED_TEXT = 'Desbloqueie para ler este grupo.'
const INCOMPLETE_TEXT = 'Algumas mensagens ainda não chegaram a este aparelho.'
const OFFLINE_POST_TEXT = 'Sem conexão: a mensagem só pode ser enviada com internet.'
const WAITING_TEXT = 'Pedido enviado: aguardando aprovação de um administrador.'
const BANNED_TEXT = 'Você não pode mais participar deste grupo.'
const PENDING_TEXT = 'Aguardando sincronização deste grupo.'
// The node's own wording, so errorText shows the same plain sentence.
const COMMUNITY_WAIT_TEXT = 'aguarde a sincronização da comunidade'
const PRIVATE_OUTSIDE_TEXT = 'As mensagens deste grupo são cifradas de ponta a ponta. Só quem entra consegue ler.'
const CHECK_UNKNOWN = 'Não deu para confirmar se isso foi aplicado. Confira antes de tentar de novo.'
const CHECK_NOT_LANDED = 'Não foi aplicado. Você pode tentar de novo.'

const READERS = ['creator', 'admin', 'member']
const JOINABLE = [null, 'left', 'pending']

export function Grupo ({ group, onBack, onOpenCommunity, onOpenMember, onMessage, onOpenMention, onReport, onSeen, isTop = true }) {
  const styles = useStyles(makeStyles)
  const avoidKeyboard = useKeyboardAvoidEnabled()
  const { colors } = useTheme()
  const node = useNode()
  const hosted = node.hosted === true
  const ownKey = node.passkey && node.passkey.status ? node.passkey.status.publicKey : null
  const acting = useActing()
  const asPage = pageMode({ acting, on: pagesOn({ hosted, accountOrigin: node.accountOrigin }) })
  const names = useNames()
  const namesRef = useRef(names)
  namesRef.current = names
  const version = node.getGroupVersion(group)
  const { request } = node

  const [info, setInfo] = useState(null)
  const [infoError, setInfoError] = useState('')
  const [store, setStore] = useState(EMPTY_PAGES)
  const [meta, setMeta] = useState({ sealed: 0, state: 'ok', incomplete: false, epoch: null })
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [loadedAt, setLoadedAt] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [moreError, setMoreError] = useState('')
  const [loadingMore, setLoadingMore] = useState(false)
  const [draft, setDraft] = useState('')
  // The message being answered, as its 'writer:seq' key; null when none.
  const [replyKey, setReplyKey] = useState(null)
  const [replyQuote, setReplyQuote] = useState(null)
  const [check, setCheck] = useState(null)
  const [banTarget, setBanTarget] = useState(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // { source, refs } of the message the Encaminhar sheet forwards.
  const [forwarding, setForwarding] = useState(null)
  // The community of a group this node does not hold yet (from the index),
  // the community's name, and whether a join was refused for lack of one.
  const [indexCommunity, setIndexCommunity] = useState(null)
  const [communityName, setCommunityName] = useState('')
  // null until community.info answers. Only writerHere false changes the join.
  const [communityJoin, setCommunityJoin] = useState(null)
  const [communityWriterHere, setCommunityWriterHere] = useState(null)
  // The community's and Geral's bound writers: the tap spends slots there too when it calls community.join.
  const [communityBound, setCommunityBound] = useState([])
  const [needCommunity, setNeedCommunity] = useState(false)
  // Set once a device join was sent (answered or not): a second tap could bind another writer.
  const [deviceJoinSent, setDeviceJoinSent] = useState(false)
  const [reserveConfirm, setReserveConfirm] = useState(false)
  const [indexRole, setIndexRole] = useState(undefined)
  const [lookupTick, setLookupTick] = useState(0)
  // As a page: its standing in the group (null until an answer says it), the
  // last failure, and the resend of a signed statement whose outcome is unknown.
  const [pageRole, setPageRole] = useState(null)
  const [pageError, setPageError] = useState('')
  const [pageRetry, setPageRetry] = useState(null)
  const [pagePending, setPagePending] = useState(false)
  // As a page: the group's visibility as the node read it, for this page
  // and group only ({ id, value }; value 'public' | 'private', or null until
  // the node answers), and why it has not answered yet.
  const pageVisRef = useRef({ id: null, value: null })
  const [pageVis, setPageVis] = useState(null)
  const [pageVisNote, setPageVisNote] = useState('')
  // The text of a sealed post the service refused as 'sequencia': sealed
  // again only on the person's tap.
  const [sealAgain, setSealAgain] = useState(null)
  // The text of a post whose outcome is not known: no second send until the
  // person edits the draft or asks for it.
  const [postHold, setPostHold] = useState(null)
  const lookedUp = useRef(false)
  const lookBusy = useRef(false)
  const redirected = useRef(false)
  const post = useAction()
  const act = useAction()
  const join = useAction()
  const attachments = useChatAttachments()
  // The draft link card (not as a page: its posts are signed statements).
  const linkDraft = useLinkDraft({ text: draft, enabled: !asPage.page, photos: attachments.items.length > 0, member: ownKey })
  // { phase, progress } of a photo post; mediaHold { op, text, replyKey }
  // after an uncertain one (the exact group.post it made); sendTokenRef is
  // the running post, which Cancelar marks dead before its request starts.
  const [mediaSend, setMediaSend] = useState(null)
  const [mediaHold, setMediaHold] = useState(null)
  const [mediaError, setMediaError] = useState('')
  const [draftRefusal, setDraftRefusal] = useState('')
  useEffect(() => { setDraftRefusal('') }, [draft])
  const sendTokenRef = useRef(null)
  // The draft text of a send in flight, so an autocorrect of its last word in the same tick is cleared too.
  const inFlightRef = useRef(null)
  // `f` is the ref value taken right after the send call: a send that ended
  // otherwise must not leave it armed for a later, unrelated clear.
  const clearFollowed = (f, text) => {
    if (f && f.text !== text) setDraft((d) => (d === f.text ? '' : d))
  }
  useEffect(() => () => { if (sendTokenRef.current) sendTokenRef.current.live = false }, [])
  const seqRef = useRef(0)
  const storeRef = useRef(store)
  storeRef.current = store
  const onSeenRef = useRef(onSeen)
  onSeenRef.current = onSeen
  const cutRef = useRef(null)
  // The load whose newest read painted; equal to seqRef when none is in flight.
  const paintedRef = useRef(0)
  const listRef = useRef(null)

  const infoRef = useRef(info)
  infoRef.current = info
  const role = asPage.page ? pageRole : roleOf(info, ownKey)
  // group-read answers for a page that is not a member too (public groups).
  const reader = asPage.page ? loadedAt !== null && loadError === '' : READERS.includes(role)
  const deviceJoin = !asPage.page && needsDeviceJoin(info)
  const writerNow = info ? info.writerHere : undefined
  useEffect(() => { if (writerNow === true) setDeviceJoinSent(false) }, [writerNow])
  useEffect(() => { setDeviceJoinSent(false); setReserveConfirm(false) }, [group])
  const isPrivate = info !== null && info.visibility === 'private'

  const loadInfo = useCallback(async () => {
    try {
      const value = await request('group.info', { group })
      setInfo(value)
      setInfoError('')
      return value
    } catch (err) {
      setInfoError(errorText(err))
      return null
    }
  }, [request, group])

  const commitRead = useCallback((read, before) => {
    setStore((prev) => applyPage(before === null ? EMPTY_PAGES : prev, read, before))
    if (before === null) {
      setMeta({
        sealed: Number.isSafeInteger(read.sealed) ? read.sealed : 0,
        state: typeof read.state === 'string' ? read.state : 'ok',
        incomplete: read.incomplete === true,
        epoch: read.epoch || null
      })
    }
  }, [])

  // As a page, the node reads first: a private group is shown from that
  // read; a public one, or one the node has not answered for (the service's
  // read gives the role then), from the service's read.
  const readGroup = useCallback(async (before) => {
    const op = before ? { group, before } : { group }
    if (!asPage.page) return request('group.read', op)
    const id = asPage.key + ':' + group
    const { read, visibility: seen, noKey, nodeError } = await readAsPage({
      nodeRead: () => request('group.read', { ...op, page: asPage.key }),
      serviceRead: async () => pagesGroup(node, { member: await memberKeyOf(request, node), page: asPage.key, action: 'group-read', op })
    })
    const visibility = pagePostVisibility({ visibility: seen, noKey })
    pageVisRef.current = { id, value: visibility }
    setPageVis(visibility)
    let note = ''
    if (visibility === null) note = seen === 'private' ? PAGE_NO_KEY_TEXT : (nodeError ? pageGroupErrorText(nodeError) : PAGE_GROUP_LOADING_TEXT)
    setPageVisNote(note)
    return read
  }, [request, group, node, asPage.page, asPage.key])
  const pageVisNow = () => (pageVisRef.current.id === asPage.key + ':' + group ? pageVisRef.current.value : null)

  const readNewest = useCallback(async () => {
    const read = await readGroup()
    commitRead(read, null)
    const mine = asPage.page ? pageRoleOf(read) : null
    if (mine !== null) setPageRole(mine)
    return read
  }, [readGroup, commitRead, asPage.page])

  // The call carries the newest painted row, so the node marks that post and a
  // message that lands after the paint stays unread. group.seen emits nothing,
  // and a lost answer may have written it, so the caller hears of every
  // attempt, even after a quick back. No cut-off: nothing is sent or told.
  const markSeen = useCallback(async () => {
    const upTo = cutRef.current
    if (upTo === null) return
    try {
      await request('group.seen', { group, upTo })
    } catch {} finally {
      if (typeof onSeenRef.current === 'function') onSeenRef.current(group)
    }
  }, [request, group])

  const load = useCallback(async (pull = false) => {
    if (!hosted) return
    const mine = ++seqRef.current
    if (pull) setRefreshing(true)
    else if (loadedAt === null) setLoading(true)
    setLoadError('')
    if (asPage.page) {
      try {
        await readNewest()
        if (mine !== seqRef.current) return
        setMoreError('')
      } catch (err) {
        if (mine === seqRef.current) setLoadError(pageGroupErrorText(err))
      }
      if (mine !== seqRef.current) return
      setLoadedAt(Date.now())
      setLoading(false)
      setRefreshing(false)
      return
    }
    const fresh = await loadInfo()
    if (mine !== seqRef.current) return
    // A failed info read keeps the last known info and transcript: only a
    // role that really changed clears the messages.
    const value = fresh || infoRef.current
    const r = roleOf(value, ownKey)
    if (READERS.includes(r)) {
      try {
        await readNewest()
        if (mine !== seqRef.current) return
        paintedRef.current = mine
        setMoreError('')
      } catch (err) {
        if (mine === seqRef.current) setLoadError(errorText(err))
      }
    } else if (fresh) {
      setStore(EMPTY_PAGES)
    }
    if (mine !== seqRef.current) return
    setLoadedAt(Date.now())
    setLoading(false)
    setRefreshing(false)
  }, [hosted, loadInfo, readNewest, ownKey, loadedAt, asPage.page])

  const loadRef = useRef(load)
  loadRef.current = load

  // Versions restart at 0 with every epoch: any difference means "re-read".
  const seenVersion = useRef(null)
  useEffect(() => {
    if (seenVersion.current === version) return
    seenVersion.current = version
    loadRef.current()
  }, [version, group])

  useEffect(() => () => { seqRef.current += 1 }, [])

  // The authors of a page-mode read are named through the shared names store.
  useEffect(() => {
    const n = namesRef.current
    if (!asPage.page || !n || typeof n.resolveMany !== 'function') return
    const keys = [...new Set(itemsOf(store).map((i) => i.diary).filter((k) => typeof k === 'string'))]
    if (keys.length > 0) n.resolveMany(keys)
  }, [asPage.page, store])

  // Another identity reads another transcript: nothing of the old one stays.
  const seenPage = useRef(asPage.key)
  useEffect(() => {
    if (seenPage.current === asPage.key) return
    seenPage.current = asPage.key
    setStore(EMPTY_PAGES)
    setPageRole(null)
    setPageError('')
    setPageRetry(null)
    setSealAgain(null)
    pageVisRef.current = { id: null, value: null }
    setPageVis(null)
    setPageVisNote('')
    setLoadError('')
    setLoadedAt(null)
    loadRef.current()
  }, [asPage.key])

  const loadOlder = useCallback(async () => {
    const before = storeRef.current.next
    if (!before || loadingMore) return
    // The pill is a gesture: a short thread shows it without a scroll, and
    // a pinned list would follow the older page out of view.
    endPin.current = pinToEnd(endPin.current, { kind: 'user' })
    setLoadingMore(true)
    setMoreError('')
    try {
      const read = await readGroup(before)
      const next = applyPage(storeRef.current, read, before)
      if (next.stale) {
        await readNewest()
      } else {
        setStore(next)
      }
    } catch (err) {
      setMoreError(errorText(err))
    } finally {
      setLoadingMore(false)
    }
  }, [readGroup, loadingMore, readNewest])

  const rawItems = useMemo(() => itemsOf(store), [store])
  // The day chips ("hoje", "ontem") follow the clock: the rows are rebuilt
  // when the local day changes, even in a quiet group left open.
  const now = useNow(60 * 1000)
  const today = new Date(now).toDateString()
  const rows = useMemo(() => groupRows(rawItems, ownKey, now), [rawItems, ownKey, today])
  const rawById = useMemo(() => {
    const m = new Map()
    for (const i of rawItems) m.set(i.writer + ':' + i.seq, i)
    return m
  }, [rawItems])

  // Re-reads what an uncertain change touched and asks reconcile.
  const verify = useCallback(async (change) => {
    try {
      if (change.action === 'join') {
        const value = await loadInfo()
        return value ? reconcile(change, { state: value.state }) : 'unknown'
      }
      if (change.action === 'ban') {
        const m = await request('group.members', { group })
        const members = Array.isArray(m.members) ? m.members : []
        const found = members.some((r) => r && r.member === change.member)
        if (!found && Number.isSafeInteger(m.total) && m.total > members.length) return 'unknown'
        return reconcile(change, { members })
      }
      const read = await readNewest()
      if (change.action === 'hide') {
        return reconcile(change, { items: (read.items || []).concat(itemsOf(storeRef.current)) })
      }
      return reconcile(change, read)
    } catch {
      return 'unknown'
    }
  }, [loadInfo, request, group, readNewest])

  const settle = useCallback(async (change, retry) => {
    const verdict = await verify(change)
    if (verdict === 'landed') {
      setCheck(null)
      if (change.action === 'post') {
        setDraft((d) => (d === change.text ? '' : d))
        setPostHold(null)
        if (typeof change.replyKey === 'string') setReplyKey((k) => (k === change.replyKey ? null : k))
      }
      return
    }
    setCheck({ change, verdict, retry })
  }, [verify])

  // `text` is the original text: a retry after an uncertain post resends it,
  // never whatever the draft holds by then.
  // A page's statement is signed once. An unknown outcome keeps err.retry (the
  // same signed bytes) for settle's "tentar de novo"; nothing signs again.
  const pageSend = async (fn, text, sentAt) => {
    setPagePending(true)
    setPageError('')
    setSealAgain(null)
    try {
      await fn()
      const followed = inFlightRef.current
      inFlightRef.current = null
      setDraft((d) => (d === text ? '' : d))
      clearFollowed(followed, text)
      setPostHold(null)
      setCheck(null)
      readNewest().then(() => scrollToEnd(), () => {})
    } catch (err) {
      if (err && err.uncertain === true && typeof err.retry === 'function') {
        setPostHold(text)
        settle({ action: 'post', diary: asPage.key, text, sentAt }, () => pageSend(err.retry, text, sentAt))
      } else if (sealRaced(err)) {
        setSealAgain(text)
        setPageError(pageGroupErrorText(err))
        readNewest().catch(() => {})
      } else {
        setPageError(pageGroupErrorText(err))
      }
      inFlightRef.current = null
    } finally {
      setPagePending(false)
    }
  }

  // Join or leave as the page; same rule as pageSend.
  const pageMembership = async (fn) => {
    setPagePending(true)
    setPageError('')
    setPageRetry(null)
    try {
      const answer = await fn()
      const mine = pageRoleOf(answer)
      if (mine !== null) setPageRole(mine)
      loadRef.current()
    } catch (err) {
      if (err && err.uncertain === true && typeof err.retry === 'function') {
        setPageRetry(() => () => pageMembership(err.retry))
        setPageError(CHECK_UNKNOWN)
      } else {
        setPageError(pageGroupErrorText(err))
      }
    } finally {
      setPagePending(false)
    }
  }

  const pageStatement = (action, op) => async () => {
    const member = await memberKeyOf(request, node)
    return pagesGroup(node, { member, page: asPage.key, action, op })
  }

  // A post in a private group: the node seals it with the page's key
  // (writing nothing) and the service appends the envelope it cannot read.
  // A retry of an unknown outcome resends that same envelope (err.retry).
  const pagePost = (visibility, text) => () => postAsPage({
    visibility,
    group,
    text,
    seal: (t) => request('group.seal', { group, page: asPage.key, text: t }),
    send: async (action, op) => pagesGroup(node, { member: await memberKeyOf(request, node), page: asPage.key, action, op }),
    plain: pageStatement('group-post', { group, text })
  })

  // `replyTo` is { writer, seq } exactly (rpc group.post) or null. A page's
  // statement carries no reply: Responder is not offered as a page.
  // heldCard: the card frozen into an uncertain post's retry (null: none); a
  // fresh post (undefined) takes the draft card and uploads its thumbnail
  // once, sealed in a private group. A card the rules refuse goes without
  // its image, then not at all.
  const sendPost = async (text, replyTo = null, heldCard) => {
    if (typeof text !== 'string' || text.trim() === '' || !node.online) return
    if (asPage.page) {
      // Armed here, not in pageSend: its retry closure holds a stale draft.
      inFlightRef.current = { text, at: Date.now(), followed: false }
      // Plaintext only where the node read a public header.
      const vis = pageVisNow()
      if (vis === null) {
        inFlightRef.current = null
        return
      }
      pageSend(pagePost(vis, text), text, Date.now())
      return
    }
    setCheck(null)
    setPostHold(null)
    const sentAt = Date.now()
    // A retry (heldCard defined) may run after the draft changed: never armed.
    inFlightRef.current = heldCard === undefined ? { text, at: sentAt, followed: false } : null
    const plain = replyTo ? { group, text, replyTo: { writer: replyTo.writer, seq: replyTo.seq } } : { group, text }
    // Without the group's info its visibility is unknown: no card, so a
    // private group's thumbnail is never uploaded in the clear.
    const snapshot = heldCard === undefined && info !== null ? linkDraft.take(text) : null
    let card = heldCard === undefined ? null : heldCard
    const r = await post.run(async () => {
      const visibility = isPrivate ? 'private' : 'public'
      if (snapshot !== null) {
        const upload = mediaApi !== null ? (t) => mediaApi.upload({ bytes: t.bytes, mime: t.mime, width: t.width, height: t.height, ...(visibility === 'private' ? { sealed: true } : {}) }) : null
        card = await cardForSend(snapshot, { upload })
      }
      const target = { kind: 'group', group, visibility, ...(replyTo ? { replyTo: { writer: replyTo.writer, seq: replyTo.seq } } : {}) }
      const built = withCardFallback((c) => (c ? composePlan({ text, target, card: c }).send().params : plain), card)
      card = built.card
      return request('group.post', built.op)
    })
    const followed = inFlightRef.current
    inFlightRef.current = null
    if (r.ok) {
      setDraft((d) => (d === text ? '' : d))
      clearFollowed(followed, text)
      if (replyTo) setReplyKey((k) => (k === replyTo.writer + ':' + replyTo.seq ? null : k))
      readNewest().then(() => scrollToEnd(), () => {})
    } else if (r.uncertain) {
      setPostHold(text)
      settle({ action: 'post', diary: ownKey, text, sentAt, replyKey: replyTo ? replyTo.writer + ':' + replyTo.seq : null }, () => sendPost(text, replyTo, card))
    }
  }

  // The reply target is read from its key, never from the loaded pages: a
  // refresh that drops the target from rawById must not turn the reply into a
  // plain message.
  const mediaApi = !asPage.page && node.media && typeof node.media.upload === 'function' ? node.media : null
  const sendingMedia = mediaSend !== null && (mediaSend.phase === 'uploading' || mediaSend.phase === 'sending')

  // The identity a held photo post belongs to: a retry never goes out as
  // anyone else (see the effect below).
  const actingId = asPage.page ? 'page:' + asPage.key : 'self'
  const actingIdRef = useRef(actingId)
  actingIdRef.current = actingId
  useEffect(() => {
    if (sendTokenRef.current) sendTokenRef.current.live = false
    sendTokenRef.current = null
    setMediaSend(null)
    setMediaHold(null)
    setMediaError('')
    attachments.clear()
    // attachments.clear is stable; only the acting identity matters here.
  }, [actingId])

  // Re-reads the group: did the uncertain photo post land after all?
  const mediaLanded = async (held) => {
    try {
      const read = await readNewest()
      return mediaPostLanded({ diary: ownKey, text: held.text, sentAt: held.sentAt, replyKey: held.replyKey, media: held.op.params.media }, read)
    } catch {
      return 'unknown'
    }
  }

  const mediaDone = async (r, text, replyKeyOf, sentAt, acting, followed) => {
    setMediaSend(null)
    if (r.phase === 'uncertain') {
      const held = { op: r.op, text, replyKey: replyKeyOf, sentAt, acting, checking: true }
      setMediaHold(held)
      const verdict = await mediaLanded(held)
      if (actingIdRef.current !== acting) return
      if (verdict !== 'landed') {
        setMediaHold((h) => (h && h.op === held.op ? { ...h, checking: false } : h))
        return
      }
      r = { phase: 'done' }
    }
    if (r.phase === 'done') {
      setDraft((d) => (d === text ? '' : d))
      clearFollowed(followed, text)
      if (replyKeyOf) setReplyKey((k) => (k === replyKeyOf ? null : k))
      setMediaHold(null)
      attachments.clear()
      readNewest().then(() => scrollToEnd(), () => {})
    } else if (r.phase === 'failed') {
      setMediaHold(null)
      setMediaError(errorText(r.error))
    }
  }

  const sendMedia = async (text, replyTo) => {
    if (mediaApi === null || sendingMedia || !attachments.ready || !node.online || info === null) return
    setMediaError('')
    const files = attachments.files
    const visibility = isPrivate ? 'private' : 'public'
    let plan
    try {
      plan = composePlan({ text, attachments: stagedOf(files), target: { kind: 'group', group, visibility, ...(replyTo ? { replyTo: { writer: replyTo.writer, seq: replyTo.seq } } : {}) } })
    } catch (err) {
      setMediaError(errorText(err))
      return
    }
    const sealed = visibility === 'private'
    const acting = actingId
    const sentAt = Date.now()
    inFlightRef.current = { text, at: sentAt, followed: false }
    const token = { live: true }
    sendTokenRef.current = token
    const r = await runChatSend({
      plan,
      files,
      upload: (f) => mediaApi.upload({ bytes: f.bytes, mime: f.mime, width: f.width, height: f.height, ...(sealed ? { sealed: true } : {}) }),
      request,
      live: () => token.live,
      onPhase: (p) => { if (token.live) setMediaSend(p) }
    })
    if (sendTokenRef.current === token) sendTokenRef.current = null
    // A cancelled upload can settle after the next send armed the ref: it
    // must leave that record alone, so the ref is taken only past this check.
    if (r.phase === 'cancelled') return
    const followed = token.live ? inFlightRef.current : null
    if (token.live) inFlightRef.current = null
    mediaDone(r, text, replyTo ? replyTo.writer + ':' + replyTo.seq : null, sentAt, acting, followed)
  }

  // A recorded voice note: one upload, then one group.post, under the same
  // state machine as photos (one commit, retry only on an explicit tap, a
  // change of acting identity discards it).
  const sendVoice = async (recording) => {
    if (mediaApi === null || sendingMedia || mediaHold !== null || attachments.items.length > 0 || !node.online || info === null) return
    if (!recording || !(recording.bytes instanceof Uint8Array)) return
    setMediaError('')
    const k = replyKey !== null ? /^([0-9a-f]{64}):([1-9][0-9]*)$/.exec(replyKey) : null
    const replyTo = k ? { writer: k[1], seq: Number(k[2]) } : null
    const visibility = isPrivate ? 'private' : 'public'
    let plan
    try {
      plan = composePlan({ text: '', attachments: [stagedVoice(recording)], target: { kind: 'group', group, visibility, ...(replyTo ? { replyTo } : {}) } })
    } catch (err) {
      setMediaError(errorText(err))
      return
    }
    const sealed = visibility === 'private'
    const acting = actingId
    const sentAt = Date.now()
    const token = { live: true }
    sendTokenRef.current = token
    const r = await runChatSend({
      plan,
      files: [recording],
      upload: async (f) => {
        try {
          return await mediaApi.upload({ bytes: f.bytes, mime: f.mime, width: 0, height: 0, ms: f.ms, kind: 'voice', ...(sealed ? { sealed: true } : {}) })
        } catch (err) {
          throw voiceUploadError(err)
        }
      },
      request,
      live: () => token.live,
      onPhase: (p) => { if (token.live) setMediaSend(p) }
    })
    if (sendTokenRef.current === token) sendTokenRef.current = null
    if (r.phase === 'cancelled') return
    mediaDone(r, '', replyTo ? replyTo.writer + ':' + replyTo.seq : null, sentAt, acting, null)
  }

  // The explicit retry of an uncertain photo post: the same group.post, once.
  const retryMedia = async () => {
    if (!mediaHold || mediaHold.checking || sendingMedia) return
    const held = mediaHold
    // Only the identity that made the post may resend it.
    if (held.acting !== actingIdRef.current) {
      setMediaHold(null)
      return
    }
    setMediaError('')
    // A post that landed meanwhile is not sent twice.
    if (await mediaLanded(held) === 'landed') {
      mediaDone({ phase: 'done' }, held.text, held.replyKey, held.sentAt, held.acting, null)
      return
    }
    const r = await retryChatSend({ op: held.op, request, onPhase: setMediaSend })
    mediaDone(r, held.text, held.replyKey, held.sentAt, held.acting, null)
  }

  const cancelMedia = () => {
    if (mediaSend !== null && mediaSend.phase === 'sending') return
    if (sendTokenRef.current) sendTokenRef.current.live = false
    sendTokenRef.current = null
    setMediaSend(null)
    setMediaHold(null)
    setMediaError('')
    attachments.clear()
  }

  const sendDraft = () => {
    if (mediaHold) return retryMedia()
    // Before every path below (a caption, a page's statement, plain text). The
    // draft is kept, so the person can edit it.
    const refused = publicGroupRefusal(knownVisibility({ page: asPage.page, info, epoch: meta.epoch, pagePrivate: pageVis === 'private' }), draft)
    setDraftRefusal(refused)
    if (refused !== '') return
    if (attachments.items.length > 0 && !asPage.page) {
      const k = replyKey !== null ? /^([0-9a-f]{64}):([1-9][0-9]*)$/.exec(replyKey) : null
      return sendMedia(draft, k ? { writer: k[1], seq: Number(k[2]) } : null)
    }
    const m = replyKey !== null && !asPage.page ? /^([0-9a-f]{64}):([1-9][0-9]*)$/.exec(replyKey) : null
    sendPost(draft, m ? { writer: m[1], seq: Number(m[2]) } : null)
  }

  // The names cache first, then what the read carried; never key characters.
  const profileFor = (row) => {
    const raw = rawById.get(row.key || row.id)
    const cached = names && typeof row.diary === 'string' ? names.profileOf(row.diary) : undefined
    return cached || (raw ? { name: raw.name, username: raw.username } : undefined)
  }

  // A quote of a loaded message only; a hidden target shows its label alone.
  const quoteOf = (key) => {
    const p = replyPreview({ replyTo: key }, rawById)
    if (!p) return null
    const target = rawById.get(key)
    const known = target && target.hidden !== true && typeof target.diary === 'string' && names ? names.profileOf(target.diary) : undefined
    const mine = !!(target && typeof ownKey === 'string' && target.diary === ownKey)
    // The own message is quoted as OWN_LABEL, as in the private chat; a peer
    // whose name is that same word shows as its @nome (or Pessoa) instead.
    const peerName = known ? whoOf(known).title : p.name
    const peerHandle = known ? whoOf(known).subtitle : (target && !mine ? whoOf({ username: target.username }).subtitle : null)
    const peerQuoted = readsAs(peerName, OWN_LABEL) ? (peerHandle || 'Pessoa') : peerName
    return {
      name: mine && target.hidden !== true ? OWN_LABEL : peerQuoted,
      handle: mine || !target || target.hidden === true ? undefined : (peerHandle || undefined),
      text: p.text,
      senderKey: target ? target.diary || target.writer : undefined,
      mine
    }
  }

  const scrollToKey = (key) => {
    const index = rows.findIndex((r) => r.key === key)
    const list = listRef.current
    if (index < 0 || !list || typeof list.scrollToIndex !== 'function') return
    // A quote jump leaves the end: still pinned, its first animated frame
    // would scroll back to the end.
    endPin.current = pinToEnd(endPin.current, { kind: 'user' })
    // An unmeasured row far up throws without getItemLayout: stay put then.
    try {
      list.scrollToIndex({ index, animated: true, viewPosition: 0.5 })
    } catch {}
  }

  const hide = async (row, on) => {
    setCheck(null)
    const r = await act.run(() => request('group.hide', { group, target: { writer: row.writer, seq: row.seq }, on }))
    if (r.ok) readNewest().catch(() => {})
    else if (r.uncertain) settle({ action: 'hide', writer: row.writer, seq: row.seq, on }, () => hide(row, on))
  }

  const ban = async (row) => {
    setBanTarget(null)
    setCheck(null)
    if (!row.diary) return
    const r = await act.run(() => request('group.ban', { group, member: row.diary, on: true }))
    if (r.ok) readNewest().catch(() => {})
    else if (r.uncertain) settle({ action: 'ban', member: row.diary, on: true }, () => ban(row))
  }

  const rekey = async () => {
    setCheck(null)
    const epoch = meta.epoch
    const r = await act.run(() => request('group.rekey', { group }))
    if (r.ok) readNewest().catch(() => {})
    else if (r.uncertain) settle({ action: 'rekey', epoch }, rekey)
  }

  const enter = async () => {
    if (asPage.page) {
      pageMembership(pageStatement('group-join', communityKey !== null ? { group, community: communityKey } : { group }))
      return
    }
    setCheck(null)
    setNeedCommunity(false)
    // A pending root has no community yet: the index's answer names it.
    const params = communityKey !== null && (info === null || info.community === null) ? { group, community: communityKey } : { group }
    const r = await join.run(async () => {
      try {
        return await request('group.join', params)
      } catch (err) {
        if (err && err.message === NEED_COMMUNITY) setNeedCommunity(true)
        throw err
      }
    })
    if (r.ok) loadRef.current()
    else if (r.uncertain) settle({ action: 'join' }, enter)
  }

  const report = (row) => {
    const raw = rawById.get(row.id)
    if (!raw || typeof onReport !== 'function') return
    onReport({
      author: raw.diary,
      name: raw.name || null,
      username: raw.username || null,
      seq: raw.seq,
      text: raw.text,
      group,
      writer: raw.writer,
      private: isPrivate,
      // A public post's photos stay out of the report target.
      ...(isPrivate && Array.isArray(raw.media) ? { media: raw.media } : {})
    })
  }

  const endPin = useRef({ pinned: true, newest: null, lastY: null })
  // On the web the content size can change before FlatList measured the new
  // row, so the first scroll uses an estimate and stops short: one more once
  // layout settled.
  const settleTimer = useRef(null)
  useEffect(() => () => clearTimeout(settleTimer.current), [])
  const followEnd = useCallback(() => {
    if (!endPin.current.pinned) return
    const list = listRef.current
    if (!list || typeof list.scrollToEnd !== 'function') return
    list.scrollToEnd({ animated: false })
    clearTimeout(settleTimer.current)
    settleTimer.current = setTimeout(() => {
      const now = listRef.current
      if (endPin.current.pinned && now && typeof now.scrollToEnd === 'function') now.scrollToEnd({ animated: false })
    }, 50)
  }, [])
  const releaseEnd = useCallback(() => {
    endPin.current = pinToEnd(endPin.current, { kind: 'user' })
  }, [])
  const scrollToEnd = () => {
    endPin.current = { ...endPin.current, pinned: true }
    followEnd()
  }
  const last = rows.length > 0 ? rows[rows.length - 1] : null
  const lastId = last === null ? null : last.id
  cutRef.current = last !== null && typeof last.at === 'string' ? { at: last.at, writer: last.writer, seq: last.seq } : null
  useEffect(() => {
    if (lastId === null) return
    endPin.current = pinToEnd(endPin.current, { kind: 'newest', newest: lastId })
    followEnd()
  }, [lastId, followEnd])

  // The keyboard shrinks the list: when the person was reading the newest
  // line, keep it above the composer instead of behind it (as in Mensagem).
  // Only a scroll leaves the bottom: a frame where just the list or its
  // content changed size (the keyboard, a sheet closing, a new line) keeps
  // the state, or the newest line stayed behind the composer afterwards.
  const atBottom = useRef(true)
  const lastY = useRef(null)
  const trackBottom = useCallback(({ y, contentHeight, layoutHeight }) => {
    // A frame only updates the pin. Following the end happens on content
    // growth (onContentSizeChange): calling scrollToEnd from every frame of an
    // animated scroll restarts the animation on Android and turns it into a crawl.
    endPin.current = pinToEnd(endPin.current, { kind: 'frame', y, contentHeight, layoutHeight })
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

  // A buried screen keeps re-reading but never marks; a failed or unfinished
  // read marks nothing. Keyed on the newest message on screen, so any paint
  // marks it; uncovering the screen or bringing the app back marks what
  // already shows, without a reload that would drop the older pages.
  // Reading as a page never moves the person's own seen mark.
  const visible = node.visible !== false
  useEffect(() => {
    if (asPage.page) return
    if (!visible || !isTop || !reader || lastId === null || loadedAt === null || loadError !== '') return
    if (paintedRef.current !== seqRef.current) return
    markSeen()
  }, [asPage.page, visible, isTop, reader, lastId, loadedAt, loadError, markSeen])

  const nameText = info && typeof info.name === 'string' && info.name !== ''
    ? info.name
    : (isPrivate || info === null ? PRIVATE_LABEL : 'grupo')
  const subtitle = info ? membersLabel(info.members) || visibilityLabel(info.visibility) : ''
  const heldCommunity = info && typeof info.community === 'string' && HEX64.test(info.community) ? info.community : null
  const communityKey = heldCommunity || indexCommunity
  const orphan = info !== null && info.orphan === true
  // Role 'pending' on a held root: the account is in by another device and
  // its writers are still arriving here, so nothing is joined from this screen.
  const arriving = role === 'pending' && info !== null && info.state !== 'pending'
  const joinable = loadedAt !== null && !READERS.includes(role) && JOINABLE.includes(role) && !arriving

  // The community's name for the pill; the key alone never reaches the screen.
  useEffect(() => {
    if (!hosted || heldCommunity === null) return
    let live = true
    request('community.info', { community: heldCommunity }).then((c) => {
      if (!live || !c) return
      if (typeof c.name === 'string') setCommunityName(c.name)
      setCommunityJoin(typeof c.join === 'string' ? c.join : null)
      setCommunityWriterHere(typeof c.writerHere === 'boolean' ? c.writerHere : null)
      setCommunityBound([c.writersBound, c.generalWritersBound])
    }, () => {})
    return () => { live = false }
  }, [hosted, heldCommunity, request, version])

  // A group this node does not know: ask the index which community it is in,
  // then the node what the person is there. A failed lookup is retried on
  // refresh, reconnect or a new version, never in a loop.
  useEffect(() => {
    if (!hosted || !joinable || heldCommunity !== null || lookedUp.current || lookBusy.current) return
    lookBusy.current = true
    fetchGroup(group).then(async (res) => {
      if (!res || !res.ok || typeof res.value.community !== 'string') return
      const key = res.value.community
      let communityRole = 'none'
      try {
        const c = await request('community.info', { community: key })
        if (c && typeof c.role === 'string') communityRole = c.role
      } catch {}
      lookedUp.current = true
      setIndexCommunity(key)
      setIndexRole(communityRole)
    }).finally(() => { lookBusy.current = false })
  }, [hosted, joinable, heldCommunity, group, request, version, node.online, lookupTick])

  // The community opens first, only for someone outside it (or after a join
  // refused for that reason); a member waits on the group instead.
  useEffect(() => {
    const key = communityKey
    if (redirected.current || key === null || !joinable || typeof onOpenCommunity !== 'function') return
    if (!shouldRedirectToCommunity({ communityRole: heldCommunity !== null ? undefined : indexRole, refused: needCommunity, groupRole: role })) return
    redirected.current = true
    onOpenCommunity(key, { group })
  }, [communityKey, indexRole, needCommunity, heldCommunity, joinable, role, group, onOpenCommunity])

  // community.join creates this device's community writer and joins Geral.
  // Skip group.join when that result is the group already on screen.
  // A failure is shown once: this handler does not resend a mutation, and an
  // uncertain answer re-reads the group before the card is offered again.
  const enterHere = async () => {
    setCheck(null)
    // Set when the fresh counts reach the reserve and the person has not
    // confirmed yet: nothing is sent and the warning is shown.
    let held = false
    const own = infoRef.current && infoRef.current.writersBound
    const r = await join.run(async () => {
      if (communityWriterHere !== true && communityKey !== null) {
        // Read fresh: an unanswered or stale value would send group.join alone
        // (refused) or community.join for a root this device does not hold.
        const c = await request('community.info', { community: communityKey })
        setCommunityWriterHere(typeof (c && c.writerHere) === 'boolean' ? c.writerHere : null)
        if (c && c.writerHere === false) {
          // A community.join on a root not held here only stores a pending
          // writer that may never count and still spends a writer slot.
          if (c.state === 'pending') throw new Error(COMMUNITY_WAIT_TEXT)
          // The cached counts can be unanswered or stale, so judge the reserve
          // on the ones just read.
          if (needsReserveConfirm([own, c.writersBound, c.generalWritersBound], reserveConfirm)) {
            held = true
            return null
          }
          const joined = await request('community.join', { community: communityKey })
          // Landed: a later tap must not send community.join again.
          setCommunityWriterHere(true)
          if (joined && joined.group === group) return joined
        }
      }
      if (needsReserveConfirm([own], reserveConfirm)) {
        held = true
        return null
      }
      return await request('group.join', { group })
    })
    if (held) {
      setReserveConfirm(true)
      return
    }
    if (r.ok) {
      setDeviceJoinSent(true)
      loadRef.current()
    } else if (r.uncertain) {
      // Re-read before any retry; the card returns if the writer is still missing.
      setDeviceJoinSent(true)
      await loadRef.current()
      setDeviceJoinSent(false)
    }
  }

  if (!hosted) {
    return (
      <View style={styles.root}>
        <TopBar title='Grupo' onBack={onBack} />
        <EmptyState icon='cadeira' title='Só na versão web' body={WEB_ONLY_TEXT} />
      </View>
    )
  }

  const canSettings = info !== null && !asPage.page
  const openSettings = canSettings ? () => setSettingsOpen(true) : undefined
  const communityLine = heldCommunity && typeof onOpenCommunity === 'function'
    ? (
      <Pressable
        accessibilityRole='link'
        accessibilityLabel='abrir a comunidade'
        onPress={() => onOpenCommunity(heldCommunity)}
        hitSlop={6}
        style={({ pressed }) => [styles.community, pressed && styles.pressed]}
      >
        <Icon name='gente' size={14} color={colors.soft} />
        <Text style={styles.communityText} numberOfLines={1}>{communityName !== '' ? displayText(communityName) : 'comunidade'}</Text>
        <Icon name='seta' size={14} color={colors.soft} />
      </Pressable>
      )
    : null

  const checkNote = check
    ? (
      <View style={styles.note}>
        <Notice>{check.verdict === 'not-landed' ? CHECK_NOT_LANDED : CHECK_UNKNOWN}</Notice>
        {check.change.action === 'post' && check.verdict !== 'not-landed' ? <Soft>Confira se a mensagem já apareceu antes de enviar de novo.</Soft> : null}
        <View style={styles.inline}>
          {check.verdict === 'not-landed'
            ? <Pill label='Tentar de novo' filled onPress={() => { setCheck(null); check.retry() }} />
            : <Pill label='Conferir' filled onPress={() => settle(check.change, check.retry)} />}
          <Pill label='Dispensar' onPress={() => setCheck(null)} />
        </View>
      </View>
      )
    : null

  const banNote = banTarget
    ? (
      <View style={styles.note}>
        <Soft>Banir {displayText(whoOf(profileFor(banTarget)).title)} deste grupo? A pessoa não poderá mais escrever aqui.</Soft>
        <ConfirmStack
          confirm={{ label: 'Banir', danger: true, onPress: () => ban(banTarget), pending: act.pending }}
          cancel={{ onPress: () => setBanTarget(null) }}
        />
      </View>
      )
    : null

  let outside = null
  if (!reader && loadedAt !== null) {
    if (role === 'requested') {
      outside = <EmptyState icon='cadeira' title='Aguardando aprovação' body={WAITING_TEXT} />
    } else if (role === 'banned') {
      outside = <EmptyState icon='cadeira' title={roleLabel('banned')} body={BANNED_TEXT} />
    } else if (JOINABLE.includes(role)) {
      outside = (
        <View style={styles.outside}>
          {role === 'pending' ? <Soft>{PENDING_TEXT}</Soft> : null}
          {isPrivate ? <Soft>{PRIVATE_OUTSIDE_TEXT}</Soft> : null}
          {infoError && info === null ? <Soft>{infoError}</Soft> : null}
          {orphan ? <Soft>{ORPHAN_TEXT}</Soft> : null}
          {needCommunity && communityKey !== null && typeof onOpenCommunity === 'function'
            ? <Btn label='Entrar na comunidade' onPress={() => onOpenCommunity(communityKey, { group })} />
            : null}
          {arriving ? null : <Btn label='Entrar no grupo' onPress={enter} pending={join.pending} disabled={!node.online || orphan} />}
          {!node.online ? <Soft>Sem conexão agora.</Soft> : null}
          <ErrorText>{join.error}</ErrorText>
        </View>
      )
    }
  }

  const stateNotes = reader
    ? (
      <View>
        {store.next
          ? (
            <View style={styles.older}>
              <Pill label='Mensagens anteriores' onPress={loadOlder} pending={loadingMore} />
              <ErrorText>{moreError}</ErrorText>
            </View>
            )
          : null}
        {infoError && info !== null
          ? (
            <View style={styles.note}>
              <ErrorText>{infoError}</ErrorText>
              <Pill label='Tentar de novo' onPress={() => load()} pending={loading || refreshing} />
            </View>
            )
          : null}
        {meta.state === 'locked' ? <View style={styles.note}><Notice>{LOCKED_TEXT}</Notice></View> : null}
        {meta.sealed > 0 ? <View style={styles.note}><Soft>{sealedLabel(meta.sealed)}</Soft></View> : null}
        {meta.incomplete ? <View style={styles.note}><Soft>{INCOMPLETE_TEXT}</Soft></View> : null}
        {meta.state === 'rekey-pending'
          ? (
            <View style={styles.note}>
              <Notice>{asPage.page ? PAGE_REKEYING_TEXT : REKEY_PENDING_LABEL}</Notice>
              {can('rekey', role) ? <Pill label='Gerar nova chave' onPress={rekey} pending={act.pending} /> : null}
            </View>
            )
          : null}
      </View>
      )
    : null

  let empty
  if (loadError === PAGE_GROUP_LOADING_TEXT && rows.length === 0) empty = <EmptyState icon='cadeira' title='Carregando o grupo' body={PAGE_GROUP_LOADING_TEXT} />
  else if (loadError && rows.length === 0) empty = <ErrorState message={loadError} onRetry={() => load()} pending={loading} />
  else if (loadedAt === null) empty = <Skeleton />
  else if (outside) empty = outside
  else if (reader) empty = <EmptyState icon='cadeira' title='Nenhuma mensagem ainda' body={deviceJoin ? undefined : 'Escreva a primeira.'} />
  else empty = infoError ? <ErrorState message={infoError} onRetry={() => load()} pending={loading} /> : null

  // Esconder, Banir and Denunciar keep the rules of the old row; Responder
  // needs a post this screen can send, and never as a page.
  const actionsOf = (row) => {
    const mine = row.mine === true
    const list = []
    if (!asPage.page && canPost && !row.hidden) {
      list.push({ icon: 'responder', label: 'Responder', onPress: () => { setReplyKey(row.key); setReplyQuote(quoteOf(row.key)) } })
    }
    if (!row.hidden && typeof row.rawText === 'string' && row.rawText !== '') {
      list.push({ icon: 'copiar', label: 'Copiar', onPress: () => { copyText(shareNav(), displayText(row.rawText, { multiline: true })) } })
    }
    // Forwarding writes as the person, never as a page; a hidden message is
    // never forwarded.
    const rawRow = rawById.get(row.key || row.id)
    if (!asPage.page && !row.hidden && info !== null && rawRow) {
      const media = Array.isArray(rawRow.media) ? rawRow.media : []
      const source = { kind: 'group', visibility: isPrivate ? 'private' : 'public', text: typeof row.rawText === 'string' ? row.rawText : '', media }
      const refs = chatMediaRefs('group', { diary: rawRow.diary, media })
      if (source.text !== '' || media.length > 0) {
        list.push({ icon: 'encaminhar', label: 'Encaminhar', onPress: () => setForwarding({ source, refs }) })
      }
    }
    if (typeof onMessage === 'function' && hosted && !mine && typeof row.diary === 'string' && row.diary !== '' && row.diary !== ownKey) {
      list.push({ icon: 'mensagem', label: 'Conversar em particular', onPress: () => onMessage(row.diary) })
    }
    if (!asPage.page && can('hide', role, { own: mine })) {
      list.push({ icon: row.hidden ? 'olho' : 'olho_fechado', label: row.hidden ? 'Mostrar' : 'Esconder', onPress: () => hide(row, !row.hidden) })
    }
    if (!asPage.page && can('ban', role) && !!row.diary && !mine) {
      list.push({ icon: 'slash', label: 'Banir', danger: true, onPress: () => setBanTarget(row) })
    }
    if (typeof onReport === 'function' && !!row.diary && !mine && !row.hidden) {
      list.push({ icon: 'bandeira', label: 'Denunciar', danger: true, onPress: () => report(row) })
    }
    return list
  }

  const renderItem = ({ item: row }) => {
    const mine = row.mine === true
    const profile = profileFor(row)
    const known = whoOf(profile)
    const who = known.title === UNNAMED ? { ...known, title: 'Pessoa' } : known
    const quote = row.replyTo ? quoteOf(row.replyTo) : null
    const openMember = typeof onOpenMember === 'function' && row.diary ? () => onOpenMember(row.diary) : undefined
    const avatar = mine
      ? undefined
      : (
        <Pressable accessibilityRole='link' accessibilityLabel={displayText(who.title) + ', ver perfil'} disabled={!openMember} onPress={openMember} hitSlop={4}>
          <Avatar name={who.avatarName} publicKey={row.diary || row.writer} picture={profile && profile.avatar ? profile.avatar : undefined} size={32} persist={false} />
        </Pressable>
        )
    const rawRow = rawById.get(row.key || row.id)
    const refs = row.hidden || !rawRow ? [] : chatMediaRefs('group', { diary: rawRow.diary, media: rawRow.media })
    return (
      <Bubble
        media={refs.length > 0 ? <ChatMedia refs={refs} identity={ownKey} mine={mine} /> : null}
        item={{ key: row.key, text: row.text, rawText: row.hidden ? undefined : row.rawText, at: row.at, hidden: row.hidden, dayMark: row.dayMark, card: !row.hidden && rawRow && rawRow.card ? rawRow.card : null }}
        cardThumb={rawRow ? { kind: 'group', diary: rawRow.diary, identity: ownKey } : undefined}
        mine={mine}
        shape={row.shape}
        forwarded={!row.hidden && !!rawRow && rawRow.fwd === 1}
        name={mine ? undefined : who.title}
        handle={mine ? undefined : who.subtitle}
        senderKey={row.diary || row.writer}
        avatar={avatar}
        quote={quote ? { ...quote, onPress: () => scrollToKey(row.replyTo) } : null}
        actions={actionsOf(row)}
        actionsTitle={mine ? undefined : who.title}
        onOpenMention={typeof onOpenMention === 'function' ? onOpenMention : undefined}
      />
    )
  }

  const canPost = asPage.page
    ? pageCan('post', pageRole) && meta.state === 'ok' && pageVis !== null
    : reader && can('post', role) && meta.state === 'ok' && !orphan && canWriteHere(info)
  const left = MAX_TEXT - countChars(draft)
  // A writer is here but a post would still be refused. rekey-pending already
  // says so in the placeholder, so it gets no second note.
  const showJoinCard = deviceJoin && !deviceJoinSent
  // Private, writer here, but no epoch key yet: the same words as rekey-pending.
  const awaitingKey = !asPage.page && isPrivate && !canWriteHere(info) && !deviceJoin && meta.state !== 'rekey-pending' && info !== null && info.writerHere !== false
  const waitToWrite = !asPage.page && !showJoinCard && !orphan && !canWriteHere(info) && (role === 'creator' || role === 'admin' || role === 'member') && meta.state !== 'rekey-pending'
  const replyBar = replyKey !== null && !asPage.page ? (quoteOf(replyKey) || replyQuote) : null
  let composer = null
  if (reader && showJoinCard && !orphan) {
    composer = (
      <View style={styles.composer}>
        <Soft>{DEVICE_JOIN_TEXT}</Soft>
        {reserveConfirm || reserveReachedAny([info && info.writersBound, ...(communityWriterHere === false ? communityBound : [])]) ? <Soft>{DEVICE_RESERVE_TEXT}</Soft> : null}
        <Btn label={DEVICE_JOIN_LABEL} onPress={enterHere} pending={join.pending} disabled={!node.online} />
        <ErrorText>{join.error}</ErrorText>
      </View>
    )
  } else if (asPage.page ? pageRole === 'member' : reader) {
    const notes = waitToWrite || orphan || !node.online || post.error || draftRefusal || mediaHold || mediaError || attachments.note
      ? (
        <View style={styles.composeNotes}>
          {waitToWrite ? <Soft>{awaitingKey ? REKEY_PENDING_LABEL : (communityJoin === 'approval' && !isPrivate ? DEVICE_APPROVAL_TEXT : DEVICE_WAIT_TEXT)}</Soft> : null}
          {orphan ? <Soft>{ORPHAN_TEXT}</Soft> : null}
          {!node.online ? <Soft>{OFFLINE_POST_TEXT}</Soft> : null}
          <ErrorText>{post.error}</ErrorText>
          <ErrorText>{draftRefusal}</ErrorText>
          {mediaError || attachments.note ? <ErrorText>{mediaError || attachments.note}</ErrorText> : null}
          {mediaHold
            ? (
              <View style={styles.mediaHold}>
                <Soft>{CHECK_UNKNOWN}</Soft>
                {mediaHold.checking ? null : <Pill label='Tentar de novo' onPress={retryMedia} pending={sendingMedia} />}
                <Pill label='Descartar' onPress={cancelMedia} />
              </View>
              )
            : null}
        </View>
        )
      : null
    const staged = attachments.items.length > 0
    const mediaBlocked = staged && (!attachments.ready || sendingMedia)
    composer = (
      <ChatComposer
        value={draft}
        onChangeText={(t) => { inFlightRef.current = followAutocorrect(inFlightRef.current, t, Date.now()); setDraft(t); setPostHold(null) }}
        onSend={sendDraft}
        sending={post.pending || pagePending || sendingMedia}
        sendDisabled={!canPost || !node.online || left < 0 || postHold !== null || mediaBlocked}
        editable={canPost && mediaHold === null && !sendingMedia}
        onAttach={mediaApi !== null && canPost && postHold === null && check === null ? (kind, file) => attachments.pick(file) : null}
        onVoice={isTop && mediaApi !== null && canPost && postHold === null && check === null && mediaHold === null && attachments.items.length === 0 ? sendVoice : null}
        attachments={staged ? attachments.items : null}
        onRemoveAttachment={mediaHold === null ? attachments.remove : undefined}
        onCancelAttachments={mediaHold === null && !(mediaSend && mediaSend.phase === 'sending') ? cancelMedia : undefined}
        progress={sendingMedia ? mediaSend.progress : null}
        placeholder={asPage.page && pageVis === null ? 'Carregando o grupo' : (meta.state === 'rekey-pending' || awaitingKey ? (asPage.page ? PAGE_REKEYING_TEXT : REKEY_PENDING_LABEL) : 'Mensagem')}
        accessibilityLabel='mensagem para o grupo'
        reply={replyBar ? { name: replyBar.name, text: replyBar.text, senderKey: replyBar.senderKey, mine: replyBar.mine } : null}
        onCancelReply={() => setReplyKey(null)}
        notice={notes}
        ownKey={ownKey}
        linkDraft={linkDraft}
      />
    )
  }

  // The keyboard opens over the bottom composer unless the screen shrinks for
  // it: iOS never resizes, and Android runs edge to edge (targetSdk 36), where
  // adjustResize no longer resizes the window either. On the web it is a View.
  return (
    <KeyboardAvoidingView style={styles.root} behavior='padding' enabled={avoidKeyboard}>
      <ChatHeader
        title={nameText}
        subtitle={subtitle}
        publicKey={group}
        group
        onBack={onBack}
        onPress={openSettings}
        pressLabel='informações do grupo'
        right={canSettings ? { icon: 'engrenagem', label: 'ajustes do grupo', onPress: openSettings } : undefined}
      />
      {communityLine}
      {asPage.page
        ? (
          <View style={[styles.note, styles.pagePanel]}>
            {pageRoleLabel(pageRole) ? <Soft>{AS_PAGE_LABEL + ' · ' + pageRoleLabel(pageRole)}</Soft> : null}
            {pageRoleLabel(pageRole) ? null : <Soft>{AS_PAGE_LABEL}</Soft>}
            <View style={styles.inline}>
              {pageRole === 'member' || pageRole === 'requested'
                ? <MoreButton title={AS_PAGE_LABEL} actions={[{ icon: 'sair', label: PAGE_LEAVE_LABEL, danger: true, pending: pagePending, onPress: () => pageMembership(pageStatement('group-leave', { group })) }]} />
                : <Btn label={PAGE_JOIN_LABEL} onPress={enter} pending={pagePending} disabled={!node.online} />}
              {pageRetry ? <Pill label='Conferir de novo' onPress={pageRetry} pending={pagePending} /> : null}
              {sealAgain !== null ? <Pill label={PAGE_SEAL_AGAIN_LABEL} onPress={() => sendPost(sealAgain)} pending={pagePending} /> : null}
            </View>
            {pageVis === null && loadedAt !== null && pageVisNote !== '' && pageVisNote !== loadError ? <Soft>{pageVisNote}</Soft> : null}
            <ErrorText>{pageError}</ErrorText>
          </View>
          )
        : null}
      <OfflineNote />
      <RefreshableList
        listRef={listRef}
        data={reader ? rows : []}
        keyExtractor={(row) => row.key}
        renderItem={renderItem}
        extraData={{ role, rawById, names, canPost, replyKey }}
        contentContainerStyle={styles.thread}
        ListHeaderComponent={stateNotes}
        ListEmptyComponent={empty}
        ListFooterComponent={<View>{act.error ? <View style={styles.note}><ErrorText>{act.error}</ErrorText></View> : null}{banNote}{checkNote}</View>}
        onRefresh={() => { setLookupTick((n) => n + 1); load(true) }}
        refreshing={refreshing}
        keepVisiblePosition
        onScrollFrame={trackBottom}
        onContentSizeChange={followEnd}
        onUserScroll={releaseEnd}
      />
      {composer}
      {!asPage.page
        ? (
          <ForwardSheet
            open={forwarding !== null}
            onClose={() => setForwarding(null)}
            source={forwarding ? forwarding.source : null}
            refs={forwarding ? forwarding.refs : []}
            identity={ownKey}
          />
          )
        : null}
      {info && !asPage.page
        ? (
          <GrupoAjustes
            group={group}
            visible={settingsOpen}
            onClose={() => setSettingsOpen(false)}
            onLeft={() => { setSettingsOpen(false); loadRef.current() }}
            onOpenMember={onOpenMember}
          />
          )
        : null}
    </KeyboardAvoidingView>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  pressed: { opacity: 0.6 },
  community: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    minHeight: 32,
    paddingHorizontal: space.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line
  },
  communityText: { flexShrink: 1, fontSize: 13, lineHeight: 18, color: colors.soft },
  pagePanel: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  thread: { paddingBottom: space.sm },
  note: { paddingHorizontal: 16, paddingVertical: 8, gap: 6 },
  inline: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  older: { alignItems: 'center', paddingVertical: 10, gap: 4 },
  outside: { padding: 16, gap: 12 },
  composer: {
    borderTopWidth: 1,
    borderTopColor: colors.line,
    backgroundColor: colors.card,
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 4
  },
  composeNotes: { gap: 4, paddingHorizontal: space.xs },
  mediaHold: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.sm }
})
