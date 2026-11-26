// Grupo: one group's conversation, pushed above the tabs (nav.js screen
// 'grupo', keyed by the group root). Props: { group, onBack,
// onOpenCommunity(community, { group }?), onOpenMember(diary), onMessage(diary), onOpenMention(username),
// onReport(target), onSeen(group), onOpenTopic(group, ref, root), isTop }, with `target` in Denunciar's shape
// { author, name, username, seq, text, group, writer, private }; onSeen runs
// after every group.seen attempt, answered or not. Only what the person sees
// is marked seen, up to the newest message of the read (a topic reply the chat
// hides included): the app visible, this screen on top (isTop false: buried
// under another screen) and the latest read painted. Renders GrupoAjustes itself as a sheet, opened by the header's
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
// A group whose community root is missing (orphan) is read-only. Joining a
// community group needs the community first: a group opened from a /g/<hex>
// link this node does not know is looked up in the seeder index, and its
// community opens first with the group queued after community.join. A group
// without community (standalone: the held header says so, or the index hints
// it for a root not held yet) is joined directly, with no community step. The
// outside card follows groupRedirect.js joinOffer and offers nothing while the
// community role is unknown.
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
// Group access requires the hosted node capability.
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

import { pictureProps } from '../groupImage'
import { createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AccessibilityInfo, Keyboard, KeyboardAvoidingView, Pressable, StyleSheet, Text, View } from 'react-native'
import { useKeyboardAvoidEnabled } from '../ui/keyboardAvoid'
import { MAX_TEXT, displayText } from '@varanda/rpc'
import { useNode } from '../node'
import { countChars } from '../format'
import { groupRows, replyPreview } from '../group-screen'
import { chatView, seenCut, topicList } from '../forum'
import { heldBubble, pageDmClient, pinToEnd } from '../dm-screen'
import { GROWTH_PLACES, atEnd, awayAfterFrame, groupTarget, jumpState, landingAway, latchOpen, openPlan, readCursor, settleStep, unreadBelow } from '../readPosition'
import { UNNAMED, readsAs, whoOf } from '../who'
import { copyText } from '../share'
import { shareNav } from '../shareNav'
import {
  AS_PAGE_LABEL, DEVICE_APPROVAL_TEXT, DEVICE_JOIN_LABEL, DEVICE_JOIN_TEXT, DEVICE_WAIT_TEXT,
  EMPTY_PAGES, OWN_LABEL, PAGE_GROUP_LOADING_TEXT, PAGE_NO_KEY_TEXT, PAGE_JOIN_LABEL, PAGE_LEAVE_LABEL, PAGE_REKEYING_TEXT, PAGE_SEAL_AGAIN_LABEL, REKEY_PENDING_LABEL,
  applyPage, mergeNewest, reloadDone, reloadWalks, can, canWriteHere, communitySlots, groupSlots, reserveReachedAny, reserveText, slotRefusal, needsReserveConfirm, itemsOf, knownVisibility, membersLabel, needsDeviceJoin, pageCan, pageGroupHideOp, pageGroupPostOp, pageGroupReactOp, pagePostVisibility, postAsPage, readAsPage, pageCommunityToEnter, pageCommunities, pageGroupErrorText, groupNameText, isStandaloneInfo, nextLookup, outsideAbout, outsideNote, pageMode, pageRoleLabel, pageRoleOf, reconcile, roleLabel, roleOf, sealedLabel, visibilityLabel
} from '../groups'
import { Btn, ConfirmStack, ErrorText, Label, Notice, Soft, errorText, useAction, useNow } from '../ui'
import { useStyles, useTheme } from '../ui/ThemeProvider'
import { Avatar } from '../ui/Avatar'
import { Bubble } from '../ui/Bubble'
import { Divider } from '../ui/Divider'
import { ChatSheetProvider } from '../ui/ChatSheetHost'
import { SwipeReply } from '../ui/SwipeReply'
import { JumpToEnd } from '../ui/JumpToEnd'
import { olderInitial, olderStep } from '../olderTrigger'
import { ReactionChips, QuickReactions } from '../ui/Reactions'
import { ReactionPicker, WhoReacted } from '../ui/ReactionPicker'
import { toggleOf, applyOptimistic } from '../reactions'
import { hasRich, parseRich } from '../richText'
import { cardBesideSpoilers } from '../ui/RichText'
import { ChatComposer, useLinkDraft } from '../ui/ChatComposer'
import { cardForSend, withCardFallback } from '../linkCard'
import { ChatHeader } from '../ui/ChatHeader'
import { Icon } from '../ui/Icon'
import { MoreButton } from '../ui/MoreButton'
import { OfflineNote } from '../ui/OfflineNote'
import { Pill } from '../ui/Pill'
import { Segmented } from '../ui/Segmented'
import { TopicRow } from '../ui/TopicRow'
import { NewTopicSheet } from '../ui/NewTopicSheet'
import { RefreshableList } from '../ui/RefreshableList'
import { EmbedBandBottom } from '../ui/screenVisible'
import { EmptyState, ErrorState, Skeleton } from '../ui/States'
import { TopBar } from '../ui/TopBar'
import { ForwardSheet } from '../ui/ForwardSheet'
import { space, type } from '../ui/theme'
import { fetchGroup, fetchGroupAbouts } from '../indexClient'
import { useNames } from '../names'
import { pagesOn } from '../pageGate'
import { groupScreenOpen } from '../coreDm'
import { useCorePageGroups } from '../ui/useCoreDm'
import { actAs, pagesDm, pagesGroup, pagesMedia, pagesOrigin, pagesStart } from '../pages'
import { sha256 } from '@noble/hashes/sha2.js'
import { pageForwardSource } from '../forward'
import { pageVoice } from '../pageVoice'
import { carriesPrivateItems, heldPageSender, pageSealParams, privateItemOf, sealAgainAfter, sealedUploadOp, sendSealed } from '../pageGroupMedia'
import { memberKeyOf, useActing } from './Conversa'
import { isCommunityMember, joinOffer, shouldRedirectToCommunity } from '../groupRedirect'
import { GrupoAjustes } from './GrupoAjustes'
import { BAD_VOICE, VOICE_MIME, composePlan, stagedVoice, voiceUploadError } from '../attach-plan'
import { publicGroupPreviewRefusal, publicGroupRefusal } from '../wordCheck'
import { chatMediaRefs, followAutocorrect, mediaPostLanded, retryChatSend, runChatSend, stagedOf } from '../chatSend'
import { ChatMedia } from '../ui/ChatMedia'
import { useChatAttachments } from '../ui/AttachSheet'
import { useBlocks } from '../blocksProvider'
import { cacheGeneration } from '../localCaches'
import { putGroup, removeGroup } from '../privateSnapshot'
import { buildScreenSnapshot } from '../screenSnapshot'
import { clearScreenSnapshot, loadScreenSnapshot, saveScreenSnapshot } from '../screenSnapshotStore'
import { memberSnapshotBinding, sameSnapshotBinding } from './Comunidades'

const FORUM_TABS = [{ id: 'conversa', label: 'Conversa' }, { id: 'topicos', label: 'Tópicos' }]
export const WEB_ONLY_TEXT = 'Comunidades disponíveis no site da associação ou no app ligado à instalação.'
const ORPHAN_TEXT = 'Este grupo não pertence a nenhuma comunidade.'
const NEED_COMMUNITY = 'entre na comunidade primeiro'
// The node's refusals of a join hint the group root contradicts, written
// before anything: shown as one plain sentence, never resent by the screen.
const HINT_REFUSALS = ['parâmetro inválido: standalone', 'parâmetro inválido: community', 'o grupo não é dessa comunidade']
const HINT_REFUSED_TEXT = 'Os dados deste grupo mudaram. Puxe para atualizar antes de tentar de novo.'
// The browser node could not read the group root yet. Nothing is queued, so
// the person is told to try again, not to wait.
const ROOT_UNREAD = 'aguarde a sincronização do grupo para entrar'
const ROOT_UNREAD_TEXT = 'Não deu para ler este grupo agora. Tente de novo em instantes.'
const HEX64 = /^[0-9a-f]{64}$/
const hexOf = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
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
const IDLE_LOOKUP = nextLookup(null, { type: 'reset' })

function clearKeyboardTimers (timers) {
  timers.current.forEach(clearTimeout)
  timers.current = []
}

// The stored tail ('grupoMensagens', ../privateSnapshot.js): at most one
// default group.read page, so the live newest page never shrinks the list.
const CACHE_ITEMS_MAX = 26
const CACHE_SAVE_MS = 2000

// A group.read item as the stored row: media only as the stub { mime, w, h,
// ms? } and a card without its image, so a media key or nonce never reaches
// the store (the codec also refuses either name on its own parse).
function groupCacheItem (item) {
  const stubOf = (m) => {
    if (m === null || typeof m !== 'object') return null
    const stub = { mime: typeof m.plainMime === 'string' ? m.plainMime : m.mime, w: Number.isInteger(m.w) ? m.w : m.width, h: Number.isInteger(m.h) ? m.h : m.height }
    if (Number.isSafeInteger(m.ms)) stub.ms = m.ms
    return stub
  }
  const c = item.card
  const r = item.replyTo
  const out = {
    writer: item.writer,
    diary: item.diary,
    seq: item.seq,
    at: item.at,
    text: item.text,
    replyTo: r !== null && typeof r === 'object' ? { writer: r.writer, seq: r.seq } : null,
    fwd: item.fwd === 1 ? 1 : 0,
    media: Array.isArray(item.media) ? item.media.map(stubOf) : null,
    card: c !== null && typeof c === 'object' ? { url: c.url, host: c.host, title: c.title, desc: c.desc, image: null } : null,
    hidden: item.hidden === true,
    name: item.name === undefined ? null : item.name,
    username: item.username === undefined ? null : item.username
  }
  if (Array.isArray(item.reactions) && item.reactions.length > 0) out.reactions = item.reactions.map((x) => ({ emoji: x.emoji, count: x.count, mine: x.mine }))
  return out
}

// A stored row painted before the node answers: each media stub shows
// 'Carregando mídia' (ChatMedia) until the live row brings its reference.
function seededItem (item) {
  return Array.isArray(item.media) ? { ...item, media: item.media.map((m) => ({ ...m, pending: true })) } : item
}

// Fail closed: stored rows show only once block.list answered, and never a
// row of a blocked member. A block names the member's diary, not the group
// writer (a separate core).
function seededShown (items, loadState, blocked) {
  if (loadState !== 'ok' || blocked === null || typeof blocked !== 'object' || typeof blocked.has !== 'function') return []
  return items.filter((i) => !blocked.has(i.diary))
}

export function Grupo (props) {
  return <ChatSheetProvider><GrupoScreen {...props} /></ChatSheetProvider>
}

function GrupoScreen ({ group, onBack, onOpenCommunity, onOpenMember, onMessage, onOpenMention, onReport, onSeen, onOpenTopic, isTop = true }) {
  const styles = useStyles(makeStyles)
  const avoidKeyboard = useKeyboardAvoidEnabled()
  // A list row under the composer is not seen, and measureInWindow reports
  // clipped rows unclipped, so the list tells its cards where the composer
  // starts. Measured on every check: the keyboard moves the composer.
  const composerBox = useRef(null)
  const band = useMemo(() => ({
    measure: (done) => {
      const node = composerBox.current
      if (node === null || typeof node.measureInWindow !== 'function') { done(null); return }
      node.measureInWindow((x, y, w, h) => done(Number.isFinite(y) && y > 0 && h > 0 ? y : null))
    }
  }), [])
  const { colors } = useTheme()
  const node = useNode()
  const hosted = node.hosted === true
  const ownKey = node.passkey && node.passkey.status ? node.passkey.status.publicKey : null
  const acting = useActing()
  const asPage = pageMode({ acting, on: pagesOn({ hosted, accountOrigin: node.accountOrigin }) })
  // A core node opens a group only as a Página, once it reads groups as one.
  const coreGroups = useCorePageGroups(node, asPage.page ? asPage.key : null)
  const open = groupScreenOpen({ hosted, asPage, core: coreGroups })
  // The diary key the rows are compared with: the page's own when acting as one.
  const selfKey = asPage.page ? asPage.key : ownKey
  const names = useNames()
  const namesRef = useRef(names)
  namesRef.current = names
  const version = node.getGroupVersion(group)
  const { request } = node
  const nodeRef = useRef(node)
  nodeRef.current = node
  // The page's Conversas client, for Encaminhar as a page (one signed draft per send).
  const pageKeyNow = asPage.page ? asPage.key : null
  const pageDm = useMemo(() => {
    if (pageKeyNow === null) return null
    const sign = async (digest) => pagesDm(nodeRef.current, { member: await memberKeyOf(request, nodeRef.current), page: pageKeyNow, action: 'dm-sign', op: { digest } })
    return pageDmClient({ request, sign, page: pageKeyNow })
  }, [request, pageKeyNow])

  // The stored tail is read and written only for a member acting as
  // themself on an unlocked identity (null as a page, locked or signed out).
  const blocks = useBlocks()
  const blocksRef = useRef(blocks)
  blocksRef.current = blocks
  const binding = memberSnapshotBinding({ node, acting, pageKey: pageKeyNow })
  const actingRef = useRef(acting)
  actingRef.current = acting
  const pageKeyRef = useRef(pageKeyNow)
  pageKeyRef.current = pageKeyNow
  // Whether a live group.read has committed for this group. Until then the
  // rows are the stored tail: gated by block.list, offering no action and
  // never marked seen.
  const liveRef = useRef(false)
  // Before a live read the rows are the stored tail, filtered at render on
  // every block change. After one nothing is filtered here: group.read is
  // outside the block list by protocol.
  const live = liveRef.current
  const blockLoad = blocks.loadState
  const blockKeys = blocks.keys

  const [info, setInfo] = useState(null)
  const [infoError, setInfoError] = useState('')
  const [store, setStore] = useState(() => {
    if (binding === null) return EMPTY_PAGES
    const snapshot = loadScreenSnapshot('grupoMensagens', binding)
    const groups = snapshot === null ? null : snapshot.body.groups
    const entry = groups && Object.prototype.hasOwnProperty.call(groups, group) ? groups[group] : null
    if (entry === null || entry.items.length === 0) return EMPTY_PAGES
    return applyPage(EMPTY_PAGES, { items: entry.items.map(seededItem) })
  })
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
  const [reactionOverrides, setReactionOverrides] = useState(new Map())
  const [reactionError, setReactionError] = useState('')
  const [reactionPicker, setReactionPicker] = useState(null)
  const [whoReacted, setWhoReacted] = useState(null)
  const reactionContext = useMemo(() => ({ live: true, sending: new Set(), unsure: new Map(), reading: new Set(), who: 0, read: 0, readStarts: new WeakMap(), settled: new Map() }), [group, ownKey, asPage.key, asPage.page, request])
  const reactionContextRef = useRef(reactionContext)
  reactionContextRef.current = reactionContext
  useEffect(() => {
    reactionContext.live = true
    setReactionOverrides(new Map())
    setReactionError('')
    setReactionPicker(null)
    setWhoReacted(null)
    return () => { reactionContext.live = false }
  }, [reactionContext])
  // The community of a group this node does not hold yet (from the index),
  // the community's name, and whether a join was refused for lack of one.
  const [indexCommunity, setIndexCommunity] = useState(null)
  const [communityName, setCommunityName] = useState('')
  // null until community.info answers. Only writerHere false changes the join.
  const [communityJoin, setCommunityJoin] = useState(null)
  const [communityWriterHere, setCommunityWriterHere] = useState(null)
  // The community's and Geral's bound writers: the tap spends slots there too when it calls community.join.
  const [communitySlotsKnown, setCommunitySlotsKnown] = useState([])
  const [needCommunity, setNeedCommunity] = useState(false)
  // Set once a device join was sent (answered or not): a second tap could bind another writer.
  const [deviceJoinSent, setDeviceJoinSent] = useState(false)
  const [reserveConfirm, setReserveConfirm] = useState(false)
  const [indexRole, setIndexRole] = useState(undefined)
  // The index hints a root not held here has no community (kind 'group',
  // root served, community null). Only a hint: the node decides on join.
  const [indexStandalone, setIndexStandalone] = useState(false)
  // The person's role in the held root's community, for the outside card:
  // { community, role, failed }, role undefined until community.info answers.
  const [heldRole, setHeldRole] = useState({ community: null, role: undefined, failed: false })
  const [heldRoleTick, setHeldRoleTick] = useState(0)
  // As a page: its standing in the group's community, from the service status
  // as Comunidade's PagePanel reads it ({ page, community, role }).
  const [pageCommunity, setPageCommunity] = useState({ page: null, community: null, role: undefined, failed: false })
  const [pageStatusTick, setPageStatusTick] = useState(0)
  const [lookupState, setLookup] = useState(IDLE_LOOKUP)
  const [lookupTick, setLookupTick] = useState(0)
  const aboutRequest = useRef(null)
  const [indexAbout, setIndexAbout] = useState(null)
  // As a page: its standing in the group (null until an answer says it), the
  // last failure, and the resend of a signed statement whose outcome is unknown.
  const [pageRole, setPageRole] = useState(null)
  const [pageError, setPageError] = useState('')
  const [pageRetry, setPageRetry] = useState(null)
  const [pageJoinError, setPageJoinError] = useState(null)
  const [pagePending, setPagePending] = useState(false)
  // As a page: the group's visibility as the node read it, for this page
  // and group only ({ id, value }; value 'public' | 'private', or null until
  // the node answers), and why it has not answered yet.
  const pageVisRef = useRef({ id: null, value: null })
  const [pageVis, setPageVis] = useState(null)
  // The node's verified header read as it came, kept for the title: pageVis is null for a private group whose key this device lacks.
  const [pageSeen, setPageSeen] = useState(null)
  const [pageVisNote, setPageVisNote] = useState('')
  // A sealed post the service refused as 'sequencia' ({ text, replyTo,
  // card }, the card already uploaded): sealed again only on the person's tap.
  const [sealAgain, setSealAgain] = useState(null)
  // The text of a post whose outcome is not known: no second send until the
  // person edits the draft or asks for it.
  const [postHold, setPostHold] = useState(null)
  const lookedUp = useRef(false)
  const lookBusy = useRef(false)
  const lookToken = useRef(0)
  const lookRetry = useRef(false)
  const lookGroup = useRef(group)
  const redirected = useRef(false)
  const post = useAction()
  const act = useAction()
  const join = useAction()
  const attachments = useChatAttachments()
  // The draft link card. As a page, once the node read the group's
  // visibility: a public post carries it in its signed 'group-post', a
  // private one in the record the node seals, its thumbnail sealed too.
  const linkDraft = useLinkDraft({ text: draft, enabled: !asPage.page || pageVis !== null, photos: attachments.items.length > 0, member: ownKey })
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
  const walksRef = useRef(null)
  if (walksRef.current === null) walksRef.current = reloadWalks()
  // Counts the reload walks that ended: the open's older walk waits for one,
  // and a walk that ends without a commit changes nothing else it watches.
  const [walkEnds, setWalkEnds] = useState(0)
  const onSeenRef = useRef(onSeen)
  onSeenRef.current = onSeen
  const cutRef = useRef(null)
  const openLatch = useRef(null)
  const openScope = useRef('')
  openScope.current = group + '|' + ownKey
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
  // Foruns: public groups on the hosted node. A page's rows carry the topic
  // mark itself (group-read), so its chat never waits on the topics list. A
  // private group shows no forum option.
  const forumOn = hosted && (asPage.page ? pageVis === 'public' : info !== null && info.visibility === 'public')
  const [forumTab, setForumTab] = useState('conversa')
  const [topics, setTopics] = useState(null)
  const [topicsNext, setTopicsNext] = useState(null)
  const [topicsError, setTopicsError] = useState('')
  const [topicsLoading, setTopicsLoading] = useState(false)
  const [newTopicOpen, setNewTopicOpen] = useState(false)
  const [topicRefusal, setTopicRefusal] = useState('')
  const topicSeq = useRef(0)
  const newTopic = useAction()
  // A page topic whose outcome is unknown: { key, retry } of the same signed statement.
  const topicHold = useRef(null)
  useEffect(() => { topicHold.current = null }, [asPage.key, group])

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

  // The armed save of the stored tail: { gen, binding, group, newest, timer,
  // due }; `due` once the debounce elapsed before block.list answered.
  const saveRef = useRef(null)
  const cancelSave = useCallback(() => {
    const armed = saveRef.current
    saveRef.current = null
    if (armed !== null && armed.timer !== null) clearTimeout(armed.timer)
  }, [])
  // Writes the armed page: the generation and the identity must still be the
  // ones read when its group.read was sent. A refused save is not retried;
  // the next live read saves.
  const flushSave = useCallback(() => {
    const armed = saveRef.current
    if (armed === null) return
    const b = blocksRef.current
    if (b.loadState !== 'ok') {
      armed.due = true
      return
    }
    saveRef.current = null
    const now = memberSnapshotBinding({ node: nodeRef.current, acting: actingRef.current, pageKey: pageKeyRef.current })
    if (cacheGeneration() !== armed.gen || !sameSnapshotBinding(armed.binding, now)) return
    const current = loadScreenSnapshot('grupoMensagens', armed.binding)
    const body = putGroup(current === null ? null : current.body, armed.group, armed.newest.map(groupCacheItem), Date.now())
    if (body === null) return
    const snapshot = buildScreenSnapshot('grupoMensagens', { ...armed.binding, previous: body, blocked: b.keys })
    if (snapshot !== null) saveScreenSnapshot('grupoMensagens', snapshot, armed.gen)
  }, [])
  // What a newest group.read is stored under, read in the tick that sends
  // it: a purge or another identity since then means its answer is not.
  const saveStamp = useCallback(() => ({
    gen: cacheGeneration(),
    binding: memberSnapshotBinding({ node: nodeRef.current, acting: actingRef.current, pageKey: pageKeyRef.current })
  }), [])
  // Stores the answer's own page (newest first), never the loaded store,
  // which after older pages holds history.
  const armSave = useCallback((stamp, read) => {
    if (stamp.binding === null || cacheGeneration() !== stamp.gen || !Array.isArray(read.items)) return
    cancelSave()
    const armed = { gen: stamp.gen, binding: stamp.binding, group, newest: read.items.slice(0, CACHE_ITEMS_MAX), timer: null, due: false }
    armed.timer = setTimeout(() => {
      armed.timer = null
      if (saveRef.current === armed) flushSave()
    }, CACHE_SAVE_MS)
    saveRef.current = armed
  }, [group, cancelSave, flushSave])
  useEffect(() => {
    if (blockLoad === 'ok' && saveRef.current !== null && saveRef.current.due) flushSave()
  }, [blockLoad, flushSave])
  useEffect(() => () => cancelSave(), [cancelSave])
  // Another group on this screen starts from its own stored tail rules.
  const liveGroup = useRef(group)
  useEffect(() => {
    if (liveGroup.current === group) return
    liveGroup.current = group
    liveRef.current = false
    cancelSave()
  }, [group, cancelSave])
  // No reading role any more (left, banned, the group gone): its stored tail
  // goes. A failed rewrite drops the whole kind rather than keep it.
  const forgetGroup = useCallback(() => {
    cancelSave()
    const b = memberSnapshotBinding({ node: nodeRef.current, acting: actingRef.current, pageKey: pageKeyRef.current })
    if (b === null) return
    const current = loadScreenSnapshot('grupoMensagens', b)
    if (current === null) return
    const body = removeGroup(current.body, group)
    const snapshot = body === null ? null : buildScreenSnapshot('grupoMensagens', { ...b, previous: body, blocked: blocksRef.current.keys })
    if (snapshot === null || !saveScreenSnapshot('grupoMensagens', snapshot, cacheGeneration())) clearScreenSnapshot('grupoMensagens')
  }, [group, cancelSave])

  // What a committed read settles besides the store: the overrides it may
  // clear and, for the newest page, the read's meta.
  const noteRead = useCallback((read, newest) => {
    const context = reactionContextRef.current
    const unsure = new Map(context.unsure)
    setReactionOverrides((prev) => {
      const next = new Map(prev)
      for (const item of read.items || []) {
        const key = item.writer + ':' + item.seq
        // A read begun before the append cannot replace this device's known state.
        const recovered = context.readStarts.get(read) > unsure.get(key)
        if (recovered) context.unsure.delete(key)
        if ((recovered || !context.sending.has(key)) && context.readStarts.get(read) > context.settled.get(key)) next.delete(key)
      }
      return next
    })
    if (newest) {
      setMeta({
        sealed: Number.isSafeInteger(read.sealed) ? read.sealed : 0,
        state: typeof read.state === 'string' ? read.state : 'ok',
        incomplete: read.incomplete === true,
        epoch: read.epoch || null
      })
    }
  }, [])

  const commitRead = useCallback((read, before) => {
    liveRef.current = true
    setStore((prev) => {
      const next = applyPage(before === null ? EMPTY_PAGES : prev, read, before)
      return before !== null && next.stale ? prev : next
    })
    noteRead(read, before === null)
  }, [noteRead])

  // As a page, the node reads first: a private group is shown from that
  // read; a public one, or one the node has not answered for (the service's
  // read gives the role then), from the service's read.
  const readGroup = useCallback(async (before) => {
    const context = reactionContextRef.current
    const started = ++context.read
    const op = before ? { group, before } : { group }
    if (forumOn && !asPage.page) op.marks = true
    if (!asPage.page) {
      const read = await request('group.read', op)
      context.readStarts.set(read, started)
      // The first newest page decides where this open lands; a reread after
      // group.seen does not move it.
      if (!before) openLatch.current = latchOpen(openLatch.current, { scope: openScope.current, value: read.firstUnread })
      return read
    }
    const id = asPage.key + ':' + group
    const { read, visibility: seen, noKey, nodeError } = await readAsPage({
      nodeRead: () => request('group.read', { ...op, page: asPage.key }),
      serviceRead: async () => pagesGroup(node, { member: await memberKeyOf(request, node), page: asPage.key, action: 'group-read', op })
    })
    const visibility = pagePostVisibility({ visibility: seen, noKey })
    pageVisRef.current = { id, value: visibility }
    setPageVis(visibility)
    setPageSeen(seen)
    let note = ''
    if (visibility === null) note = seen === 'private' ? PAGE_NO_KEY_TEXT : (nodeError ? pageGroupErrorText(nodeError) : PAGE_GROUP_LOADING_TEXT)
    setPageVisNote(note)
    context.readStarts.set(read, started)
    return read
  }, [request, group, node, asPage.page, asPage.key, forumOn])
  const pageVisNow = () => (pageVisRef.current.id === asPage.key + ':' + group ? pageVisRef.current.value : null)

  // The older pages of a reload, re-read into a local copy that replaces the
  // loaded ones in one commit at the end, so the rows being read never
  // vanish. A superseded walk commits nothing; a failed or stale older page
  // ends the walk and keeps the merged list ("Mensagens anteriores" still
  // reads on from there).
  const walkOlder = useCallback(async (walk, read) => {
    const walks = walksRef.current
    // An older page loaded meanwhile may have deepened the target.
    const goal = () => walks.current(walk.token) ? walks.target() : walk.target
    let local = applyPage(EMPTY_PAGES, read, null)
    const olderReads = []
    let reached = true
    while (!reloadDone(local, goal())) {
      const before = local.next
      let older = null
      try {
        older = await readGroup(before)
      } catch {}
      if (!walks.current(walk.token)) return
      const next = older === null ? null : applyPage(local, older, before)
      if (next === null || next.stale) {
        // The merged list stays, old-version pages included (a newly hidden
        // post shows until then): no list jump, and the next walk corrects it.
        reached = false
        break
      }
      local = next
      olderReads.push(older)
    }
    const target = goal()
    if (!walks.end(walk.token)) return
    setWalkEnds((n) => n + 1)
    if (!reached || target === null) return
    setStore(local)
    for (const older of olderReads) noteRead(older, false)
  }, [readGroup, noteRead])

  // A version reload keeps the reading position. The fresh newest page is
  // merged over the loaded pages at once, so a message just sent shows and
  // the caller goes on (scroll, spinner) without waiting for the older pages
  // the walk re-reads.
  const readNewest = useCallback(async () => {
    const walks = walksRef.current
    const walk = walks.begin(storeRef.current)
    const stamp = saveStamp()
    let read
    try {
      read = await readGroup()
    } catch (err) {
      if (walks.end(walk.token)) setWalkEnds((n) => n + 1)
      throw err
    }
    if (!walks.current(walk.token)) return read
    // A one-page store (the stored tail) is replaced whole: no stored row
    // outlives the first live read.
    liveRef.current = true
    setStore((prev) => mergeNewest(prev, read))
    noteRead(read, true)
    // armSave changes only with `group`, which readGroup already follows.
    armSave(stamp, read)
    const mine = asPage.page ? pageRoleOf(read) : null
    if (mine !== null) setPageRole(mine)
    walkOlder(walk, read)
    return read
  }, [readGroup, noteRead, walkOlder, asPage.page])

  // The call carries the newest message of the read, so the node marks that
  // post and a message that lands after the paint stays unread. group.seen emits nothing,
  // and a lost answer may have written it, so the caller hears of every
  // attempt, even after a quick back. No cut-off: nothing is sent or told.
  const markSeen = useCallback(async () => {
    // A cached paint is not a read: nothing is marked before a live one.
    if (!liveRef.current) return
    const upTo = cutRef.current
    if (upTo === null) return
    try {
      await request('group.seen', { group, upTo })
    } catch {} finally {
      if (typeof onSeenRef.current === 'function') onSeenRef.current(group)
    }
  }, [request, group])

  const load = useCallback(async (pull = false) => {
    if (!open) return
    const mine = ++seqRef.current
    if (pull) setRefreshing(true)
    else if (loadedAt === null) setLoading(true)
    // The page's community standing is read again too (a failed read included).
    if (pull && asPage.page) setPageStatusTick((n) => n + 1)
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
      walksRef.current.reset()
      storeRef.current = EMPTY_PAGES
      setStore(EMPTY_PAGES)
      forgetGroup()
    }
    if (mine !== seqRef.current) return
    setLoadedAt(Date.now())
    setLoading(false)
    setRefreshing(false)
  }, [open, loadInfo, readNewest, ownKey, loadedAt, asPage.page, forgetGroup])

  const loadRef = useRef(load)
  loadRef.current = load

  // The first read may precede group.info: read again, with marks, once the
  // group is known to be public.
  const markedOnce = useRef(false)
  useEffect(() => {
    if (!forumOn || asPage.page || markedOnce.current) return
    markedOnce.current = true
    loadRef.current()
  }, [forumOn, asPage.page])

  // Tópicos: group.topics is authoritative (newest root first); more come from its cursor.
  const loadTopics = useCallback(async (more = false) => {
    if (!forumOn) return
    const mine = ++topicSeq.current
    const acting = actingId
    setTopicsLoading(true)
    setTopicsError('')
    try {
      const op = more && topicsNext ? { group, before: topicsNext } : { group }
      const value = asPage.page
        ? await pagesGroup(node, { member: await memberKeyOf(request, node), page: asPage.key, action: 'group-topics', op })
        : await request('group.topics', op)
      // Another identity is on screen now: this read is not its.
      if (mine !== topicSeq.current || actingIdRef.current !== acting) return
      const items = value && Array.isArray(value.items) ? value.items : []
      setTopics((prev) => (more && prev ? prev.concat(items) : items))
      setTopicsNext(value && value.next ? value.next : null)
    } catch (err) {
      if (mine === topicSeq.current && actingIdRef.current === acting) setTopicsError(asPage.page ? pageGroupErrorText(err) : errorText(err))
    } finally {
      if (mine === topicSeq.current) setTopicsLoading(false)
    }
  }, [forumOn, request, group, topicsNext, asPage.page, asPage.key, node])
  const loadTopicsRef = useRef(loadTopics)
  loadTopicsRef.current = loadTopics
  useEffect(() => { if (forumOn && forumTab === 'topicos') loadTopicsRef.current() }, [forumOn, forumTab, version, group, asPage.page, asPage.key])
  useEffect(() => { if (!forumOn) setForumTab('conversa') }, [forumOn])
  useEffect(() => () => { topicSeq.current += 1 }, [])

  // The topic's title, its poll options and the replies are public text like a
  // chat post: the on-device word check runs before anything is sent.
  async function createTopic (text, poll, event) {
    const refused = publicGroupRefusal('public', text, ...(poll ? poll.options : []), ...(event ? [event.title, event.place] : []))
    setTopicRefusal(refused)
    if (refused !== '') return { ok: false }
    const acting = actingId
    // A page posts the topic as itself: one signed 'group-post'. After an
    // unknown outcome the next send resends that same statement (err.retry),
    // only while the identity, text and options are unchanged.
    const holdKey = JSON.stringify([acting, group, text, poll ? poll.options : null, event || null])
    const r = await newTopic.run(async () => {
      if (!asPage.page) return request('group.post', { group, text, topic: true, ...(poll ? { poll: poll.options } : {}), ...(event ? { event } : {}) })
      const held = topicHold.current
      topicHold.current = null
      try {
        if (held !== null && held.key === holdKey) return await held.retry()
        return await pagesGroup(node, { member: await memberKeyOf(request, node), page: asPage.key, action: 'group-post', op: pageGroupPostOp({ group, text, topic: true, poll: poll ? poll.options : undefined, event }) })
      } catch (err) {
        if (err && err.uncertain === true && typeof err.retry === 'function' && actingIdRef.current === acting) topicHold.current = { key: holdKey, retry: err.retry }
        throw err
      }
    })
    // Another identity is on screen now: this result is not its.
    if (actingIdRef.current !== acting) return { ok: false }
    if (r.ok) {
      setNewTopicOpen(false)
      loadTopicsRef.current()
      loadRef.current()
    }
    return { ok: r.ok }
  }

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
    // The next reload must not walk back to the old identity's position.
    walksRef.current.reset()
    storeRef.current = EMPTY_PAGES
    setStore(EMPTY_PAGES)
    setPageRole(null)
    setPageError('')
    setPageJoinError(null)
    setPageRetry(null)
    setSealAgain(null)
    topicSeq.current += 1
    setTopics(null)
    setTopicsNext(null)
    setTopicsError('')
    pageVisRef.current = { id: null, value: null }
    setPageVis(null)
    setPageSeen(null)
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
        walksRef.current.deepen(next)
        commitRead(read, before)
      }
    } catch (err) {
      setMoreError(errorText(err))
      setOpenFailed(true)
    } finally {
      setLoadingMore(false)
    }
  }, [readGroup, loadingMore, readNewest, commitRead])

  const rawItems = useMemo(() => (live ? itemsOf(store) : seededShown(itemsOf(store), blockLoad, blockKeys)), [store, live, blockLoad, blockKeys])
  const seedShown = !live && rawItems.length > 0
  // The stored tail shows before group.info names a reading role.
  const listed = reader || seedShown
  // The day chips ("hoje", "ontem") follow the clock: the rows are rebuilt
  // when the local day changes, even in a quiet group left open.
  const now = useNow(60 * 1000)
  const today = new Date(now).toDateString()
  // With marks the node says which messages open or belong to a topic: a root
  // shows as a compact card, what is inside a topic stays in Tópicos.
  const forumView = useMemo(() => (forumOn ? chatView(rawItems) : null), [forumOn, rawItems])
  const chatItems = useMemo(() => (forumView === null ? rawItems : forumView.map((v) => v.message)), [forumView, rawItems])
  const topicCards = useMemo(() => new Map((forumView || []).filter((v) => v.kind === 'topic').map((v) => [v.ref, v])), [forumView])
  const topicRows = useMemo(() => topicList(topics, now), [topics, today, now])
  const rows = useMemo(() => groupRows(chatItems, selfKey, now), [chatItems, selfKey, today])
  const rowsRef = useRef(rows)
  rowsRef.current = rows
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

  // A retry of a held post failed for sure, so it still has not landed: the
  // faded bubble stays with "Tentar de novo" and "Dispensar", as before the
  // retry, and nothing is sent until the person taps one.
  const holdNotLanded = (change, retry) => setCheck({ change, verdict: 'not-landed', retry })

  // `text` is the original text: a retry after an uncertain post resends it,
  // never whatever the draft holds by then.
  // A page's statement is signed once. An unknown outcome keeps err.retry (the
  // same signed bytes) for settle's "tentar de novo"; nothing signs again.
  // `again` ({ replyTo, keep }) is what a seal-again sends with the text: the
  // reply and the card the first try built (keep.card).
  const pageSend = async (fn, text, sentAt, retrying = false, replyKeyOf = null, again = null) => {
    // Another identity on screen owns the composer now: this result is not its.
    const acting = 'page:' + asPage.key
    const dropReply = () => { if (replyKeyOf !== null) setReplyKey((k) => (k === replyKeyOf ? null : k)) }
    setPagePending(true)
    setPageError('')
    setSealAgain(null)
    try {
      await fn()
      if (actingIdRef.current !== acting) return
      const followed = inFlightRef.current
      inFlightRef.current = null
      setDraft((d) => (d === text ? '' : d))
      clearFollowed(followed, text)
      dropReply()
      setPostHold(null)
      setCheck(null)
      readNewest().then(() => scrollToEnd(), () => {})
    } catch (err) {
      if (actingIdRef.current !== acting) return
      if (err && err.uncertain === true && typeof err.retry === 'function') {
        // The held text is a faded bubble now: the composer is free.
        setDraft((d) => (d === text ? '' : d))
        clearFollowed(inFlightRef.current, text)
        dropReply()
        setPostHold({ text, at: Date.now() })
        settle({ action: 'post', diary: asPage.key, text, sentAt, replyKey: replyKeyOf }, () => pageSend(err.retry, text, sentAt, true, replyKeyOf, again))
      } else if (sealAgainAfter(err)) {
        // The page's key changed: the same envelope cannot land. The held
        // text goes back to the composer and PAGE_SEAL_AGAIN_LABEL seals it
        // anew, with the card already uploaded (the media path's rule).
        if (retrying) {
          setPostHold(null)
          setDraft((d) => (d.trim() === '' ? text : d))
        }
        setSealAgain({ text, replyTo: again ? again.replyTo : null, card: again && again.keep ? again.keep.card : undefined })
        setPageError(pageGroupErrorText(err))
        readNewest().catch(() => {})
      } else {
        if (retrying) holdNotLanded({ action: 'post', diary: asPage.key, text, sentAt, replyKey: replyKeyOf }, () => pageSend(fn, text, sentAt, true, replyKeyOf, again))
        setPageError(pageGroupErrorText(err))
      }
      inFlightRef.current = null
    } finally {
      setPagePending(false)
    }
  }

  // Back from the community after the page joined it: the refusal is stale.
  useEffect(() => {
    if (pageRole !== 'member' && pageRole !== 'requested') return
    setPageJoinError(null)
    setPageError('')
  }, [pageRole])
  const wasTop = useRef(isTop)
  useEffect(() => {
    const was = wasTop.current
    wasTop.current = isTop
    if (asPage.page && was === false && isTop === true) loadRef.current()
  }, [isTop, asPage.page])

  // Join or leave as the page; same rule as pageSend.
  const pageMembership = async (fn) => {
    setPagePending(true)
    setPageError('')
    setPageRetry(null)
    setPageJoinError(null)
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
        setPageJoinError(err)
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
  // `build` makes the post's op, the person's group.post params (a card is
  // uploaded in it, once: the signed retry of an unknown outcome keeps the
  // same bytes); in a private group the node seals that same post.
  const pagePost = (visibility, text, build = async () => ({ group, text })) => () => postAsPage({
    visibility,
    group,
    text,
    seal: async () => request('group.seal', pageSealParams(await build(), asPage.key)),
    send: async (action, op) => pagesGroup(node, { member: await memberKeyOf(request, node), page: asPage.key, action, op }),
    plain: async () => pageStatement('group-post', await build())()
  })

  // `replyTo` is { writer, seq } exactly (rpc group.post) or null.
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
      let snapshot = null
      if (heldCard === undefined) {
        snapshot = linkDraft.take(text)
        if (snapshot && cardBesideSpoilers(hasRich(text) ? parseRich(text) : null, { url: snapshot.url }) === null) snapshot = null
      }
      const keep = { op: null, card: undefined }
      const build = vis === 'public' ? pagePublicOp(text, replyTo, snapshot) : pagePrivateOp(text, replyTo, snapshot, heldCard, keep)
      pageSend(pagePost(vis, text, build), text, Date.now(), false, replyTo ? replyTo.writer + ':' + replyTo.seq : null, { replyTo, keep })
      return
    }
    setCheck(null)
    const sentAt = Date.now()
    // A retry (heldCard defined) may run after the draft changed: never armed.
    inFlightRef.current = heldCard === undefined ? { text, at: sentAt, followed: false } : null
    const plain = replyTo ? { group, text, replyTo: { writer: replyTo.writer, seq: replyTo.seq } } : { group, text }
    // Without the group's info its visibility is unknown: no card, so a
    // private group's thumbnail is never uploaded in the clear.
    let snapshot = heldCard === undefined && info !== null ? linkDraft.take(text) : null
    const blocks = hasRich(text) ? parseRich(text) : null
    if (snapshot && cardBesideSpoilers(blocks, { url: snapshot.url }) === null) snapshot = null
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
    const replyKeyOf = replyTo ? replyTo.writer + ':' + replyTo.seq : null
    if (r.ok) {
      setDraft((d) => (d === text ? '' : d))
      clearFollowed(followed, text)
      if (replyKeyOf !== null) setReplyKey((k) => (k === replyKeyOf ? null : k))
      setPostHold(null)
      readNewest().then(() => scrollToEnd(), () => {})
    } else if (r.uncertain) {
      setDraft((d) => (d === text ? '' : d))
      clearFollowed(followed, text)
      // As in a conversation, the faded bubble holds the reply too.
      if (replyKeyOf !== null) setReplyKey((k) => (k === replyKeyOf ? null : k))
      setPostHold({ text, at: Date.now() })
      settle({ action: 'post', diary: ownKey, text, sentAt, replyKey: replyKeyOf }, () => sendPost(text, replyTo, card))
    } else if (heldCard !== undefined) {
      holdNotLanded({ action: 'post', diary: ownKey, text, sentAt, replyKey: replyKeyOf }, () => sendPost(text, replyTo, card))
    }
  }

  // One signed page media upload (the page's own start, page.sign and bytes
  // to the service): a photo, a GIF, a card thumbnail or a voice note.
  // -> the descriptor. Never retried here.
  const pageUpload = async ({ bytes: given, mime, width, height, ms: givenMs }) => {
    // A voice note goes out stripped of its metadata, with the container's ms
    // (the service accepts nothing else); checked before any nonce is spent.
    const voice = mime === VOICE_MIME ? pageVoice({ bytes: given, ms: givenMs }) : null
    if (mime === VOICE_MIME && voice === null) throw new TypeError(BAD_VOICE)
    const bytes = voice !== null ? voice.bytes : given
    const ms = voice !== null ? voice.ms : givenMs
    const page = asPage.key
    const member = await memberKeyOf(request, node)
    const origin = pagesOrigin(node)
    const { nonce } = await pagesStart({ member, action: 'media', page, origin })
    // A voice note carries width 0 and height 0, as the service requires.
    const op = mime === VOICE_MIME
      ? { sha256: hexOf(sha256(bytes)), mime, width: 0, height: 0, ms, bytes: bytes.byteLength }
      : { sha256: hexOf(sha256(bytes)), mime, width, height, bytes: bytes.byteLength }
    const signed = await request('page.sign', { action: 'media', nonce, page, op })
    const answer = await pagesMedia({ member, nonce, page, op, signature: signed.signature, bytes, origin })
    if (!answer || typeof answer.descriptor !== 'object' || answer.descriptor === null || answer.descriptor.mime !== mime) throw new Error('resposta inesperada')
    return answer.descriptor
  }

  // The runChatSend request of a page: its group.post is the page's signed
  // 'group-post'. An unknown outcome throws { uncertain, retry }.
  const pageGroupRequest = async (method, params) => {
    if (method !== 'group.post') throw new Error('pedido inesperado')
    return pagesGroup(node, { member: await memberKeyOf(request, node), page: asPage.key, action: 'group-post', op: pageGroupPostOp({ group, ...params }) })
  }

  // The public post of a page: the person's reply, link card and word
  // budget (composePlan), as one signed 'group-post'. The card's thumbnail is
  // one of the page's own uploads.
  const pagePublicOp = (text, replyTo, snapshot) => async () => {
    const target = { kind: 'group', group, visibility: 'public', ...(replyTo ? { replyTo: { writer: replyTo.writer, seq: replyTo.seq } } : {}) }
    const card = snapshot !== null ? await cardForSend(snapshot, { upload: pageUpload }) : null
    return pageGroupPostOp(withCardFallback((c) => composePlan({ text, target, card: c }).send().params, card).op)
  }

  // A page's photo, GIF, voice note or card thumbnail in a private group:
  // sealed on this device (the item key stays in the post), the ciphertext
  // uploaded as the page with the `group` op, then the private item from the
  // service's descriptor. One signed upload, never retried here. A photo,
  // GIF or voice failure stops the post before anything is sealed; a card
  // thumbnail failure only drops the image (cardForSend), as for a person.
  const pagePrivateUpload = async ({ bytes: given, mime, width, height, ms: givenMs }) => {
    const sealer = node.media && typeof node.media.sealPage === 'function' ? node.media : null
    if (sealer === null) throw new Error('mídia indisponível')
    // Stripped of its recording time and device tags before it is sealed.
    const voice = mime === VOICE_MIME ? pageVoice({ bytes: given, ms: givenMs }) : null
    if (mime === VOICE_MIME && voice === null) throw new TypeError(BAD_VOICE)
    const page = asPage.key
    const { cipher, item } = await sealer.sealPage(voice !== null
      ? { page, bytes: voice.bytes, mime, width: 0, height: 0, kind: 'voice', ms: voice.ms }
      : { page, bytes: given, mime, width, height })
    const member = await memberKeyOf(request, node)
    const origin = pagesOrigin(node)
    const { nonce } = await pagesStart({ member, action: 'media', page, origin })
    const op = sealedUploadOp({ group, item })
    const signed = await request('page.sign', { action: 'media', nonce, page, op })
    const answer = await pagesMedia({ member, nonce, page, op, signature: signed.signature, bytes: cipher, origin })
    const full = privateItemOf(answer && answer.descriptor, item)
    if (full === null) throw new Error('resposta inesperada')
    return full
  }

  // The private post of a page: the person's reply, card and word budget
  // (composePlan), built once (keep.op), so a resend after a failure never
  // uploads the thumbnail again. heldCard: the card of a seal-again.
  const pagePrivateOp = (text, replyTo, snapshot, heldCard, keep) => async () => {
    if (keep.op !== null) return keep.op
    const target = { kind: 'group', group, visibility: 'private', ...(replyTo ? { replyTo: { writer: replyTo.writer, seq: replyTo.seq } } : {}) }
    const card = heldCard !== undefined ? heldCard : (snapshot !== null ? await cardForSend(snapshot, { upload: pagePrivateUpload }) : null)
    const built = withCardFallback((c) => composePlan({ text, target, card: c }).send().params, card)
    keep.op = built.op
    keep.card = built.card
    return built.op
  }

  // One record sealed for the page (group.seal) and sent as its signed
  // 'group-seal'. An unknown outcome throws { uncertain, retry }: the same
  // envelope, resent only on a tap.
  const pageSealSend = (params) => sendSealed({
    group,
    seal: () => request('group.seal', { ...params, group, page: asPage.key }),
    send: async (action, op) => pagesGroup(node, { member: await memberKeyOf(request, node), page: asPage.key, action, op })
  })

  // The runChatSend request of a page in a private group: the photo or voice
  // post the person would send, sealed by the node.
  const pageSealedRequest = async (method, params) => {
    if (method !== 'group.post') throw new Error('pedido inesperado')
    return pageSealSend(pageSealParams(params, asPage.key))
  }

  // The reply target is read from its key, never from the loaded pages: a
  // refresh that drops the target from rawById must not turn the reply into a
  // plain message.
  // A page uploads its own items (signed, never the person's); in a private
  // group only where this node can seal them.
  const canSealPage = !!node.media && typeof node.media.sealPage === 'function'
  const mediaApi = asPage.page
    ? (pageVis === 'public' ? { upload: pageUpload } : pageVis === 'private' && canSealPage ? { upload: pagePrivateUpload } : null)
    : (node.media && typeof node.media.upload === 'function' ? node.media : null)
  // The group's visibility is known: group.info for a person, the node's read for a page.
  const visKnown = asPage.page ? pageVis !== null : info !== null
  const sendRequest = asPage.page ? (pageVis === 'private' ? pageSealedRequest : pageGroupRequest) : request
  // The visibility a photo or voice post goes under: a page's from the node's read.
  const mediaVisibility = asPage.page ? pageVis : (isPrivate ? 'private' : 'public')
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
      return mediaPostLanded({ diary: selfKey, text: held.text, sentAt: held.sentAt, replyKey: held.replyKey, media: held.op.params.media }, read)
    } catch {
      return 'unknown'
    }
  }

  const mediaDone = async (r, text, replyKeyOf, sentAt, acting, followed) => {
    // Another identity owns the composer now (its effect reset the send state).
    if (actingIdRef.current !== acting) return
    setMediaSend(null)
    if (r.phase === 'uncertain') {
      const held = { op: r.op, text, replyKey: replyKeyOf, sentAt, acting, checking: true, uncertain: true, sealed: carriesPrivateItems(r.op && r.op.params), retry: asPage.page && r.error && typeof r.error.retry === 'function' ? r.error.retry : null }
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
      if (asPage.page && pageVis === 'private' && r.op && sealAgainAfter(r.error)) {
        // The uploads stand: "Tentar de novo" seals the same post again
        // (retry null: never the refused envelope), only on the person's tap.
        setMediaHold({ op: r.op, text, replyKey: replyKeyOf, sentAt, acting, checking: false, uncertain: false, sealed: true, retry: null })
        setMediaError(pageGroupErrorText(r.error))
        readNewest().catch(() => {})
        return
      }
      setMediaHold(null)
      setMediaError(asPage.page ? pageGroupErrorText(r.error) : errorText(r.error))
    }
  }

  const sendMedia = async (text, replyTo) => {
    if (mediaApi === null || sendingMedia || !attachments.ready || !node.online || !visKnown) return
    setMediaError('')
    const files = attachments.files
    const visibility = mediaVisibility
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
      request: sendRequest,
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
    if (mediaApi === null || sendingMedia || mediaHold !== null || attachments.items.length > 0 || !node.online || !visKnown) return
    if (!recording || !(recording.bytes instanceof Uint8Array)) return
    setMediaError('')
    const k = replyKey !== null ? /^([0-9a-f]{64}):([1-9][0-9]*)$/.exec(replyKey) : null
    const replyTo = k ? { writer: k[1], seq: Number(k[2]) } : null
    const visibility = mediaVisibility
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
      request: sendRequest,
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
    // A page resends the same signed statement (err.retry), never a new one;
    // a sealed post is sealed again only while the node reads the group as
    // private, never sent as a plain 'group-post'.
    let send = request
    if (asPage.page) {
      const how = heldPageSender(held, pageVisNow())
      if (how === null) {
        setMediaError(pageVisNote || PAGE_GROUP_LOADING_TEXT)
        return
      }
      send = how === 'retry' ? async () => held.retry() : how === 'sealed' ? pageSealedRequest : pageGroupRequest
    }
    const r = await retryChatSend({ op: held.op, request: send, onPhase: setMediaSend })
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
    const visibility = knownVisibility({ page: asPage.page, info, epoch: meta.epoch, pagePrivate: pageVis === 'private' })
    const refused = publicGroupRefusal(visibility, draft) || publicGroupPreviewRefusal(visibility, linkDraft.take(draft))
    setDraftRefusal(refused)
    if (refused !== '') return
    if (attachments.items.length > 0) {
      const k = replyKey !== null ? /^([0-9a-f]{64}):([1-9][0-9]*)$/.exec(replyKey) : null
      return sendMedia(draft, k ? { writer: k[1], seq: Number(k[2]) } : null)
    }
    const m = replyKey !== null ? /^([0-9a-f]{64}):([1-9][0-9]*)$/.exec(replyKey) : null
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
    const mine = !!(target && typeof selfKey === 'string' && target.diary === selfKey)
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
    clearTimeout(jumpTimer.current)
    clearTimeout(quoteTimer.current)
    setFlashKey(null)
    setQuoteToast(false)
    const missing = () => {
      setQuoteToast(true)
      AccessibilityInfo.announceForAccessibility('Mensagem fora do trecho carregado')
      quoteTimer.current = setTimeout(() => setQuoteToast(false), 3000)
    }
    const index = rows.findIndex((row) => row.key === key)
    const list = listRef.current
    if (index < 0 || !list || typeof list.scrollToIndex !== 'function') return missing()
    // Released before the scroll so no follow-up frame pulls the list back
    // to the end; a scroll that throws never moved, so it is put back.
    const before = { away: away.current, pin: endPin.current }
    away.current = true
    endPin.current = pinToEnd(endPin.current, { kind: 'user' })
    // A row not measured yet fails through onScrollToIndexFailed instead of
    // throwing: the same way back.
    let failed = false
    const fail = () => {
      failed = true
      away.current = before.away
      endPin.current = before.pin
      missing()
    }
    indexJump.current = { kind: 'quote', fail }
    try {
      list.scrollToIndex({ index, animated: false, viewPosition: 0.5 })
    } catch {
      indexJump.current = null
      if (!failed) fail()
      return
    }
    indexJump.current = null
    if (failed) return
    // The first offset can be an estimate even when scrollToIndex succeeds.
    jumpTimer.current = setTimeout(() => {
      if (listRef.current !== list) return
      // An older page can land in between and shift the index.
      const at = rowsRef.current.findIndex((row) => row.key === key)
      if (at < 0) return missing()
      let lost = false
      indexJump.current = { kind: 'quote', fail: () => { lost = true; missing() } }
      try {
        list.scrollToIndex({ index: at, animated: false, viewPosition: 0.5 })
      } catch {
        if (!lost) missing()
        lost = true
      }
      indexJump.current = null
      if (lost) return
      setFlashKey(key)
      quoteTimer.current = setTimeout(() => setFlashKey(null), 900)
    }, 120)
  }
  const indexFailed = useCallback((info) => {
    const jump = indexJump.current
    indexJump.current = null
    if (jump !== null) jump.fail(info)
  }, [])

  const hide = async (row, on) => {
    if (!liveRef.current) return
    const vis = asPage.page ? pageVisNow() : null
    // A page whose group the node has not read now sends nothing: a private
    // group's hide must not go out as the plain 'group-hide'.
    if (asPage.page && vis === null) return
    setCheck(null)
    const target = { writer: row.writer, seq: row.seq }
    // A page hides only its own message, through its signed 'group-hide', or
    // in a private group the hide record the node seals.
    const acting = actingId
    const sealed = asPage.page && vis === 'private'
    // An unknown page outcome keeps err.retry: the same signed statement.
    let signedRetry = null
    const r = await act.run(async () => {
      if (!asPage.page) return request('group.hide', { group, target, on })
      try {
        if (sealed) return await pageSealSend({ hide: { target, on } })
        return await pagesGroup(node, { member: await memberKeyOf(request, node), page: asPage.key, action: 'group-hide', op: pageGroupHideOp({ group, target, on }) })
      } catch (err) {
        if (err && err.uncertain === true && typeof err.retry === 'function') signedRetry = err.retry
        throw err
      }
    })
    if (actingIdRef.current !== acting) return
    if (r.ok) readNewest().catch(() => {})
    else if (r.uncertain) {
      const retry = signedRetry === null ? () => hide(row, on) : async () => { await signedRetry(); readNewest().catch(() => {}) }
      settle({ action: 'hide', writer: row.writer, seq: row.seq, on }, retry)
    }
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
      if (pageOffer !== 'group') return
      pageMembership(pageStatement('group-join', communityKey !== null ? { group, community: communityKey } : { group }))
      return
    }
    if (offer !== 'group') return
    setCheck(null)
    setNeedCommunity(false)
    // A held root's header decides. A root not held here needs the index's
    // hint: no community, or the community it names.
    let params = { group }
    if (!heldRoot && standalone) params = { group, standalone: true }
    else if (!heldRoot && communityKey !== null) params = { group, community: communityKey }
    const r = await join.run(async () => {
      try {
        return await request('group.join', params)
      } catch (err) {
        if (err && err.message === NEED_COMMUNITY) setNeedCommunity(true)
        if (err && err.uncertain !== true && HINT_REFUSALS.includes(err.message)) {
          // Drop the hint so a pull asks the index again; nothing is resent.
          lookedUp.current = false
          setIndexStandalone(false)
          setIndexCommunity(null)
          setIndexRole(undefined)
          throw new Error(HINT_REFUSED_TEXT)
        }
        if (err && err.uncertain !== true && err.message === ROOT_UNREAD) throw new Error(ROOT_UNREAD_TEXT)
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

  const away = useRef(false)
  const latestKey = rows.length > 0 ? rows[rows.length - 1].key : null
  const latestKeyRef = useRef(null)
  latestKeyRef.current = latestKey
  // Mirrors away.current for the render: the jump button shows while it holds.
  const [showJump, setShowJump] = useState(false)
  const scrollFrame = useRef({ y: 0, contentHeight: 0, layoutHeight: 0 })
  const [flashKey, setFlashKey] = useState(null)
  const [quoteToast, setQuoteToast] = useState(false)
  const quoteTimer = useRef(null)
  const jumpTimer = useRef(null)
  const keyboardTimers = useRef([])
  // Older pages load near the top only after the person scrolled: the first
  // layout and the opening scroll to the end are frames too.
  const userScrolled = useRef(false)
  const olderState = useRef(olderInitial())
  const olderLive = useRef({ hasNext: false, loading: false, failed: false, loadOlder: null })
  // One open of this group: whether its landing ran, finished (placed), how
  // many older pages it asked for and how often it retried.
  const openRun = useRef({ started: false, placed: false, older: 0, tries: 0, grown: 0, watch: false })
  const openTimer = useRef(null)
  const [placed, setPlaced] = useState(false)
  // An older page failed during this open. It stays failed for the whole open:
  // a later reload clears moreError, but the walk must not ask again, and no
  // cut may pass the unread run that page held.
  const [openFailed, setOpenFailed] = useState(false)
  // The newest row the person had on screen since the landing: group.seen
  // never marks past it.
  const [cursor, setCursor] = useState(null)
  const cursorRef = useRef(null)
  const viewableRef = useRef([])
  // Which scrollToIndex is in flight, so one onScrollToIndexFailed serves the
  // quote jump and the opening placement.
  const indexJump = useRef(null)
  const rowKeys = useMemo(() => rows.map((row) => row.key), [rows])
  const rowKeysRef = useRef(rowKeys)
  rowKeysRef.current = rowKeys
  // Reading as a page opens at the end: its own seen mark is not the person's.
  const openFirst = !asPage.page && openLatch.current !== null && openLatch.current.scope === openScope.current ? openLatch.current.value : null
  const openKey = openFirst === null ? null : groupTarget({ items: rawItems, rowKeys, firstUnread: openFirst, isOwn: (it) => typeof ownKey === 'string' && it.diary === ownKey })
  const plan = (loadedAt !== null || (openFirst !== null && rowKeys.length > 0)) ? openPlan({ targetKey: openKey, rowKeys, hasOlder: reader && !!store.next, olderPagesLoaded: openRun.current.older, loading: loadingMore, failed: openFailed }) : null
  // The first unread sits on an older page that failed to load: a cut at a
  // newer row would also mark that unread run, so only the end marks.
  const openMissed = openKey !== null && !rowKeys.includes(openKey) && openFailed
  // Read by the effects of this same render.
  const planRef = useRef(plan)
  planRef.current = plan
  useEffect(() => {
    clearKeyboardTimers(keyboardTimers)
    away.current = false
    userScrolled.current = false
    olderState.current = olderInitial()
    setShowJump(false)
    setFlashKey(null)
    setQuoteToast(false)
    openRun.current = { started: false, placed: false, older: 0, tries: 0, grown: 0, watch: false }
    cursorRef.current = null
    viewableRef.current = []
    setPlaced(false)
    setOpenFailed(false)
    setCursor(null)
    return () => {
      clearTimeout(openTimer.current)
      clearTimeout(quoteTimer.current)
      clearTimeout(jumpTimer.current)
    }
  }, [group, ownKey, asPage.key])

  const endPin = useRef({ pinned: true, newest: null, lastY: null })
  // On the web the content size can change before FlatList measured the new
  // row, so the first scroll uses an estimate and stops short: one more once
  // layout settled.
  const settleTimer = useRef(null)
  useEffect(() => () => clearTimeout(settleTimer.current), [])
  const followEnd = useCallback(() => {
    if (away.current) return
    if (!endPin.current.pinned) return
    const list = listRef.current
    if (!list || typeof list.scrollToEnd !== 'function') return
    list.scrollToEnd({ animated: false })
    clearTimeout(settleTimer.current)
    settleTimer.current = setTimeout(() => {
      if (away.current) return
      const now = listRef.current
      if (endPin.current.pinned && now && typeof now.scrollToEnd === 'function') now.scrollToEnd({ animated: false })
    }, 50)
  }, [])
  const releaseEnd = useCallback(() => {
    clearTimeout(jumpTimer.current)
    endPin.current = pinToEnd(endPin.current, { kind: 'user' })
  }, [])
  const scrollToEnd = () => {
    clearTimeout(jumpTimer.current)
    openRun.current.watch = false
    away.current = false
    setShowJump(false)
    endPin.current = { ...endPin.current, pinned: true }
    followEnd()
  }
  // Moves the read cursor over the rows on screen, only after the landing:
  // the rows the opening scroll passed over were not read.
  const moveCursor = useCallback(() => {
    if (!openRun.current.placed) return
    const at = readCursor(cursorRef.current, { rowKeys: rowKeysRef.current, viewableKeys: viewableRef.current })
    if (at === cursorRef.current) return
    cursorRef.current = at
    setCursor(at)
  }, [])
  // The landing is done: from here what the person sees moves the cursor.
  const settleOpen = useCallback((toEnd) => {
    const run = openRun.current
    if (run.placed) return
    run.placed = true
    clearTimeout(openTimer.current)
    if (indexJump.current !== null && indexJump.current.kind === 'open') indexJump.current = null
    setPlaced(true)
    // An open at the end shows the newest row: the cursor starts there.
    if (toEnd === true && latestKeyRef.current !== null) {
      cursorRef.current = latestKeyRef.current
      setCursor(latestKeyRef.current)
    }
    moveCursor()
    // While heading for a row the view counted as away. Until a scroll frame
    // follows, the sizes decide (watchLanding): an unread run that fits on one
    // screen lands at the end with no frame, and the web can land before the
    // list measured itself.
    if (toEnd !== true) {
      run.watch = true
      away.current = landingAway(scrollFrame.current)
      setShowJump(away.current)
    }
  }, [moveCursor])
  // Puts the first unread row at the top. Rows past the first batch are not
  // measured yet, so a failed scrollToIndex jumps near it by estimate and
  // tries again, a bounded number of times.
  const placeOpenRow = useCallback((growth) => {
    const run = openRun.current
    const plan = planRef.current
    if (!run.started || run.placed || plan === null || plan.kind !== 'row') return
    const index = rowKeysRef.current.indexOf(plan.key)
    const list = listRef.current
    if (index < 0 || !list || typeof list.scrollToIndex !== 'function') return
    // A content-size frame places the row again without spending a try: the
    // first batches grow the list many times in a row.
    let wait
    if (growth === true) {
      if (run.grown >= GROWTH_PLACES) return
      run.grown++
      wait = settleStep(run.tries).wait
    } else {
      const step = settleStep(run.tries)
      run.tries = step.next
      if (!step.again) return settleOpen()
      wait = step.wait
    }
    const retry = () => {
      clearTimeout(openTimer.current)
      openTimer.current = setTimeout(placeOpenRow, wait)
    }
    const jump = {
      kind: 'open',
      fail: (info) => {
        const average = info && Number.isFinite(info.averageItemLength) ? info.averageItemLength : 0
        if (typeof list.scrollToOffset === 'function') list.scrollToOffset({ offset: Math.max(0, average * index), animated: false })
        retry()
      }
    }
    indexJump.current = jump
    try {
      list.scrollToIndex({ index, viewPosition: 0, animated: false })
    } catch {
      if (indexJump.current === jump) indexJump.current = null
      return retry()
    }
    if (indexJump.current !== jump) return
    indexJump.current = null
    // Landed; growth before this timer places it again.
    clearTimeout(openTimer.current)
    openTimer.current = setTimeout(settleOpen, 250)
  }, [settleOpen])
  // Starts the landing once per open; false while it heads for a row.
  const startOpen = () => {
    openRun.current.started = true
    const first = planRef.current
    if (first !== null && first.kind !== 'end') {
      // Unread messages: the open lands on the first one, not at the end.
      away.current = true
      releaseEnd()
      return false
    }
    settleOpen(true)
    return true
  }
  const startOpenRef = useRef(startOpen)
  startOpenRef.current = startOpen
  const last = rows.length > 0 ? rows[rows.length - 1] : null
  const lastId = last === null ? null : last.id
  const openKind = plan === null ? null : plan.kind
  const openRowKey = plan !== null && plan.kind === 'row' ? plan.key : null
  const openHeading = () => !openRun.current.placed && planRef.current !== null && planRef.current.kind !== 'end'
  // The seen mark follows the newest message the node holds, painted or not: a
  // reply inside a topic is hidden from the chat, and it must still clear the
  // unread count without opening the topic. That holds once the end was on
  // screen (the cursor reached the newest row); before, only up to the row
  // behind the cursor, and nothing before the landing.
  const seenAt = seenCut(rawItems)
  const endShown = placed && latestKey !== null && cursor === latestKey
  const cursorItem = cursor === null ? null : rawById.get(cursor)
  if (!placed) cutRef.current = null
  else if (!live) cutRef.current = null
  else if (endShown) cutRef.current = seenAt
  else cutRef.current = cursorItem && !openMissed ? { at: cursorItem.at, writer: cursorItem.writer, seq: cursorItem.seq } : null
  const seenKey = cutRef.current === null ? null : cutRef.current.writer + ':' + cutRef.current.seq
  const jump = jumpState({ away: showJump, unread: unreadBelow({ rows, cursorKey: cursor, openKey }) })
  useEffect(() => {
    if (lastId === null) return
    endPin.current = pinToEnd(endPin.current, { kind: 'newest', newest: lastId })
    if (!openRun.current.started) {
      // Not loaded yet: the driver below starts the landing.
      if (planRef.current === null) return followEnd()
      if (!startOpenRef.current()) return
    }
    followEnd()
  }, [lastId, followEnd])

  useEffect(() => {
    const run = openRun.current
    if (openKind === null || run.placed) return
    // The rows can paint before the read that decides the landing: the first
    // newest run then had no plan, and the landing starts here.
    if (!run.started && startOpenRef.current()) return followEnd()
    if (openKind === 'older') {
      // One older walk at a time: not during a reload's walk-back. Its end
      // bumps walkEnds, so the open goes on even when it commits nothing.
      const live = olderLive.current
      if (live.loading || walksRef.current.target() !== null || typeof live.loadOlder !== 'function') return
      run.older++
      live.loadOlder()
      return
    }
    if (openKind === 'end') {
      // Nothing to land on after all: back to the end.
      settleOpen(true)
      away.current = false
      setShowJump(false)
      endPin.current = { ...endPin.current, pinned: true }
      followEnd()
      return
    }
    placeOpenRow()
  }, [openKind, openRowKey, loadingMore, rowKeys, walkEnds, settleOpen, placeOpenRow, followEnd])

  // The keyboard shrinks the list: when the person was reading the newest
  // line, keep it above the composer instead of behind it (as in Mensagem).
  // Only a scroll leaves the bottom: a frame where just the list or its
  // content changed size (the keyboard, a sheet closing, a new line) keeps
  // the state, or the newest line stayed behind the composer afterwards.
  const atBottom = useRef(true)
  const lastY = useRef(null)
  // Given to the list from its first render (it fixes the choice then). It
  // only moves the cursor; marking waits for the effect below.
  const viewable = useCallback(({ viewableItems }) => {
    viewableRef.current = (Array.isArray(viewableItems) ? viewableItems : []).filter((v) => v && v.isViewable !== false && v.item).map((v) => v.item.key)
    moveCursor()
  }, [moveCursor])
  const userScroll = useCallback(() => {
    clearKeyboardTimers(keyboardTimers)
    userScrolled.current = true
    releaseEnd()
    // The person took over: the landing stops where they are.
    if (openRun.current.started) settleOpen()
  }, [releaseEnd, settleOpen])
  // A size change after a landing no scroll frame has followed yet.
  const watchLanding = useCallback(() => {
    if (!openRun.current.watch) return
    away.current = landingAway(scrollFrame.current)
    setShowJump(away.current)
  }, [])
  const trackBottom = useCallback(({ y, contentHeight, layoutHeight }) => {
    scrollFrame.current = { y, contentHeight, layoutHeight }
    openRun.current.watch = false
    // A frame only updates the pin. Following the end happens on content
    // growth (onContentSizeChange): calling scrollToEnd from every frame of an
    // animated scroll restarts the animation on Android and turns it into a crawl.
    endPin.current = pinToEnd(endPin.current, { kind: 'frame', y, contentHeight, layoutHeight, opening: userScrolled.current !== true })
    const live = olderLive.current
    const older = olderStep(olderState.current, { y, userScrolled: userScrolled.current, hasNext: live.hasNext, loading: live.loading, failed: live.failed })
    olderState.current = older.state
    if (older.load && typeof live.loadOlder === 'function') live.loadOlder()
    const bottom = atEnd({ y, contentHeight, layoutHeight })
    const resized = lastY.current !== null && y === lastY.current
    lastY.current = y
    if (!resized || bottom) atBottom.current = bottom
    away.current = awayAfterFrame({ away: away.current, pinned: endPin.current.pinned, bottom, resized, heading: openHeading() })
    setShowJump(away.current)
  }, [])
  useEffect(() => {
    const sub = Keyboard.addListener('keyboardDidShow', () => {
      if (!atBottom.current) return
      if (away.current) return
      clearKeyboardTimers(keyboardTimers)
      const toEnd = () => {
        if (away.current) return
        const list = listRef.current
        if (list && typeof list.scrollToEnd === 'function') list.scrollToEnd({ animated: true })
      }
      // Twice: on Android the keyboard padding turns on with a re-render
      // (src/ui/keyboardAvoid.js), so the list shrinks after this event and
      // the first scroll can land before it (the newest message stayed under the composer).
      keyboardTimers.current = [setTimeout(toEnd, 50), setTimeout(toEnd, 300)]
    })
    return () => {
      clearKeyboardTimers(keyboardTimers)
      sub.remove()
    }
  }, [])

  // A buried screen keeps re-reading but never marks; a failed or unfinished
  // read marks nothing. Keyed on the newest message on screen, so any paint
  // marks it; uncovering the screen or bringing the app back marks what
  // already shows, without a reload that would drop the older pages.
  // Reading as a page never moves the person's own seen mark.
  // Nothing is marked before the landing; after it the mark follows the read
  // cursor with a short wait, so a scroll sends one mark.
  const visible = node.visible !== false
  const seenTimer = useRef(null)
  const seenPending = useRef(false)
  const flushSeen = useRef(null)
  flushSeen.current = () => {
    clearTimeout(seenTimer.current)
    if (!seenPending.current) return
    seenPending.current = false
    markSeen()
  }
  useEffect(() => () => { if (flushSeen.current) flushSeen.current() }, [])
  useEffect(() => {
    if (asPage.page) return
    if (!visible || !isTop || !reader || seenKey === null || loadedAt === null || loadError !== '' || !placed) {
      clearTimeout(seenTimer.current)
      seenPending.current = false
      return
    }
    if (paintedRef.current !== seqRef.current) return
    seenPending.current = true
    if (endShown) return flushSeen.current()
    clearTimeout(seenTimer.current)
    seenTimer.current = setTimeout(() => flushSeen.current(), 400)
  }, [asPage.page, visible, isTop, reader, seenKey, loadedAt, loadError, placed, endShown, markSeen])
  olderLive.current = { hasNext: reader && !!store.next, loading: loadingMore, failed: moreError !== '', loadOlder }

  const sameLookupGroup = lookGroup.current === group
  const lookup = sameLookupGroup ? lookupState : IDLE_LOOKUP
  const nameText = groupNameText({ info, page: asPage.page, visibility: pageSeen, hint: lookup.status === 'done' ? lookup : undefined })
  const subtitle = info ? membersLabel(info.members) || visibilityLabel(info.visibility) : ''
  const heldCommunity = info && typeof info.community === 'string' && HEX64.test(info.community) ? info.community : null
  const communityKey = heldCommunity || (sameLookupGroup ? indexCommunity : null)
  // The join this screen offers (groupRedirect.js joinOffer). A held root's
  // header decides standalone; the index hint counts only for a root not held.
  const heldStandalone = isStandaloneInfo(info)
  const heldRoot = info !== null && info.state !== 'pending'
  const standalone = heldStandalone || (!heldRoot && sameLookupGroup && indexStandalone)
  const offerRole = heldCommunity !== null
    ? (heldRole.community === heldCommunity ? heldRole.role : undefined)
    : (sameLookupGroup && indexCommunity !== null ? indexRole : undefined)
  const offer = joinOffer({ standalone, communityRole: offerRole })
  const heldRoleFailed = heldCommunity !== null && heldRole.community === heldCommunity && heldRole.failed
  const pageStatusNow = communityKey !== null && pageCommunity.page === asPage.key && pageCommunity.community === communityKey
  const pageCommunityRole = pageStatusNow ? pageCommunity.role : undefined
  const pageStatusFailed = pageStatusNow && pageCommunity.failed === true
  // A core node has no index lookup: for a root it does not hold, the
  // community stays unknown here and the service decides the page's join
  // (it refuses 'fora-da-comunidade').
  const pageServiceDecides = !hosted && !heldRoot && communityKey === null
  // A page never joins a group without community: the service refuses it.
  const pageOffer = standalone ? 'none' : pageServiceDecides ? 'group' : joinOffer({ standalone: false, communityRole: pageCommunityRole })
  const pageEnterCommunity = pageCommunityToEnter({ error: pageJoinError, communityKey })
  // A page outside the group's community enters the community first, as a person does.
  const pageInside = pageRole === 'member' || pageRole === 'requested'
  const pageCommunityTarget = pageEnterCommunity !== null ? pageEnterCommunity : (!pageInside && pageOffer === 'community' ? communityKey : null)
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
      if (!live) return
      // The same read gives the join offer its role; without one it stays unknown.
      setHeldRole({ community: heldCommunity, role: c && typeof c.role === 'string' ? c.role : undefined, failed: !c })
      if (!c) return
      if (typeof c.name === 'string') setCommunityName(c.name)
      setCommunityJoin(typeof c.join === 'string' ? c.join : null)
      setCommunityWriterHere(typeof c.writerHere === 'boolean' ? c.writerHere : null)
      setCommunitySlotsKnown(communitySlots(c))
    }, () => { if (live) setHeldRole({ community: heldCommunity, role: undefined, failed: true }) })
    return () => { live = false }
  }, [hosted, heldCommunity, request, version, heldRoleTick])

  // As a page: whether it is in the group's community, read again each time
  // the screen is on top (back from joining the community). A community it
  // is not listed in is one it is not in; a failed read stays unknown.
  useEffect(() => {
    if (!asPage.page || communityKey === null || isTop === false) return
    let live = true
    const page = asPage.key
    const community = communityKey
    setPageCommunity({ page, community, role: undefined, failed: false })
    ;(async () => {
      try {
        const member = await memberKeyOf(request, nodeRef.current)
        const status = await actAs(nodeRef.current, { member, action: 'status', page })
        const mine = pageCommunities(status).find((c) => c.community === community)
        const role = mine ? pageRoleOf(mine) : 'left'
        if (live) setPageCommunity({ page, community, role: role === null ? undefined : role, failed: role === null })
      } catch {
        if (live) setPageCommunity({ page, community, role: undefined, failed: true })
      }
    })()
    return () => { live = false }
  }, [asPage.page, asPage.key, communityKey, isTop, request, pageStatusTick])

  // A refusal for lack of the community no longer stands once the screen
  // comes back on top (the person may have joined it) or a read newly says
  // member. A re-read on each new version keeps it.
  const clearTop = useRef(isTop)
  const clearMember = useRef(false)
  useEffect(() => {
    const member = isCommunityMember(heldRole.role)
    const back = isTop === true && clearTop.current === false
    const joined = member && !clearMember.current
    clearTop.current = isTop
    clearMember.current = member
    if (back || joined) setNeedCommunity(false)
  }, [isTop, heldRole])

  // Drop pending answers before the next group can paint.
  useLayoutEffect(() => {
    lookGroup.current = group
    lookedUp.current = false
    lookRetry.current = false
    setLookup(IDLE_LOOKUP)
    setIndexCommunity(null)
    setIndexRole(undefined)
    setIndexStandalone(false)
    return () => {
      lookToken.current += 1
      lookBusy.current = false
    }
  }, [group])

  // The index can label an unknown group and point to its community. Only
  // the node tells us the person's role there.
  // A failed lookup is retried on refresh, reconnect or a new version, never in a loop.
  useEffect(() => {
    const retry = lookRetry.current
    lookRetry.current = false
    if (!hosted || !joinable || heldCommunity !== null || heldStandalone || lookedUp.current) return
    if (lookBusy.current && !retry) return
    setLookup((prev) => nextLookup(prev, { type: 'start', retry }))
    // A tap can use the answer from a refresh already in flight.
    if (lookBusy.current) return
    lookBusy.current = true
    const token = ++lookToken.current
    fetchGroup(group).catch(() => null).then(async (res) => {
      if (token !== lookToken.current) return
      if (!res || !res.ok) {
        setLookup((prev) => nextLookup(prev, { type: 'fail' }))
        return
      }
      const { name, visibility } = res.value
      setLookup((prev) => nextLookup(prev, { type: 'ok', name, visibility }))
      if (res.value.kind === 'group' && res.value.rootServed === true && res.value.community === null) {
        lookedUp.current = true
        setIndexStandalone(true)
        return
      }
      if (typeof res.value.community !== 'string') return
      const key = res.value.community
      let communityRole = 'none'
      try {
        const c = await request('community.info', { community: key })
        if (c && typeof c.role === 'string') communityRole = c.role
      } catch {}
      if (token !== lookToken.current) return
      lookedUp.current = true
      setIndexCommunity(key)
      setIndexRole(communityRole)
    }).finally(() => { if (token === lookToken.current) lookBusy.current = false })
  }, [hosted, joinable, heldCommunity, heldStandalone, group, request, version, node.online, lookupTick])

  // The community opens first, only for someone outside it (or after a join
  // refused for that reason); a member waits on the group instead.
  useEffect(() => {
    const key = communityKey
    if (redirected.current || key === null || !joinable || typeof onOpenCommunity !== 'function') return
    if (!shouldRedirectToCommunity({ communityRole: heldCommunity !== null ? undefined : indexRole, refused: needCommunity, groupRole: role })) return
    redirected.current = true
    onOpenCommunity(key, { group })
  }, [communityKey, indexRole, needCommunity, heldCommunity, joinable, role, group, onOpenCommunity])

  useEffect(() => {
    if (!hosted || !joinable || reader || isPrivate || lookup.status !== 'done' || lookup.visibility !== 'public') return
    if (aboutRequest.current?.group !== group) {
      aboutRequest.current = { group, result: fetchGroupAbouts([group]) }
    }
    let live = true
    aboutRequest.current.result.then((abouts) => {
      if (live) setIndexAbout({ group, about: abouts.get(group) })
    }, () => {})
    return () => { live = false }
  }, [group, hosted, joinable, reader, isPrivate, lookup])

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
          let joined
          try {
            joined = await request('community.join', { community: communityKey })
          } catch (err) {
            throw await slotRefusal(err, () => request('community.info', { community: communityKey }), communitySlots, 'comunidade')
          }
          // Landed: a later tap must not send community.join again.
          setCommunityWriterHere(true)
          if (joined && joined.group === group) return joined
        }
      }
      if (needsReserveConfirm([own], reserveConfirm)) {
        held = true
        return null
      }
      try {
        return await request('group.join', { group })
      } catch (err) {
        throw await slotRefusal(err, () => request('group.info', { group }), groupSlots)
      }
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

  // A page reacts in a group it is a member of, once the node read the
  // visibility: a private group's reaction is a record the node seals.
  const pageActs = asPage.page && pageCan('post', pageRole) && pageVis !== null
  const replyOk = !asPage.page || pageVis !== null
  const reactionsDisabled = !node.online || node.passkey?.status?.unlocked !== true || meta.state === 'locked' || meta.state === 'rekey-pending' || (asPage.page ? !pageActs : !canWriteHere(info)) || !reader || orphan
  const reactionViewRef = useRef(null)
  // A stored row takes no reaction until a live read replaces it.
  reactionViewRef.current = { disabled: reactionsDisabled || !live, rawById, overrides: reactionOverrides, picker: reactionPicker, whoOpen: whoReacted !== null }
  useEffect(() => {
    if (reactionsDisabled) {
      reactionContext.who++
      setReactionPicker(null)
      setWhoReacted(null)
    }
  }, [reactionsDisabled, reactionContext])

  const canPost = asPage.page
    ? pageCan('post', pageRole) && meta.state === 'ok' && pageVis !== null
    : reader && can('post', role) && meta.state === 'ok' && !orphan && canWriteHere(info)
  // The chat list draws every row on the web, so a keystroke must not redraw
  // them: one renderItem and one set of row calls for the list life, and
  // extraData that changes only with what rows read. Above the early return,
  // since `open` can flip.
  const rowLive = useRef(null)
  const rowCalls = useMemo(() => liveGroupRowCalls(rowLive), [])
  const renderRef = useRef(null)
  const renderItem = useCallback((info) => renderRef.current(info), [])
  // extraData waits for every row's derived view, only known below the early
  // return, so it is memoized by hand there.
  const extraMemo = useRef(null)
  const listLive = useRef(null)
  const { refreshChat, chatLayout, chatContentSize } = useMemo(() => liveGroupListCalls(listLive), [])

  const reactionsFor = (row) => row.hidden ? [] : (reactionOverrides.get(row.key) || row.reactions || [])
  const whoReactedRows = whoReacted?.map((r) => ({
    ...r,
    names: r.by.map((diary) => {
      const profile = names?.profileOf(diary) || rawItems.find((i) => i.diary === diary && !i.hidden)
      const title = whoOf(profile).title
      return displayText(title === UNNAMED ? 'Pessoa' : title)
    })
  }))

  function openReactionPicker (key) {
    if (reactionViewRef.current.disabled || reactionViewRef.current.whoOpen || reactionContext.sending.has(key) || reactionContext.unsure.has(key)) return
    reactionContext.who++
    reactionViewRef.current.picker = key
    setReactionPicker(key)
  }

  async function toggleReaction (key, picked) {
    const context = reactionContext
    const view = reactionViewRef.current
    const item = view.rawById.get(key)
    if (!context.live || context !== reactionContextRef.current || view.disabled || !item || item.hidden || context.sending.has(key) || context.unsure.has(key)) return
    const pageVisible = asPage.page ? pageVisNow() : null
    // As in hide: a page's reaction in a group of unknown kind is not sent.
    if (asPage.page && pageVisible === null) return
    const before = view.overrides.get(key)
    const reactions = before || item.reactions || []
    const emoji = toggleOf(reactions, picked)
    const target = { writer: item.writer, seq: item.seq }
    context.sending.add(key)
    context.settled.delete(key)
    setReactionError('')
    setReactionOverrides((prev) => new Map(prev).set(key, applyOptimistic(reactions, emoji)))
    try {
      try {
        if (asPage.page && pageVisible === 'private') await pageSealSend({ react: { target, emoji } })
        else if (asPage.page) await pagesGroup(node, { member: await memberKeyOf(request, node), page: asPage.key, action: 'group-react', op: pageGroupReactOp({ group, target, emoji }) })
        else await request('group.react', { group, target, emoji })
      } catch (err) {
        if (context.live && context === reactionContextRef.current) {
          context.unsure.set(key, context.read)
          context.settled.set(key, context.read)
          setReactionOverrides((prev) => {
            const next = new Map(prev)
            if (before === undefined) next.delete(key)
            else next.set(key, before)
            return next
          })
          setReactionError(errorText(err))
          await readNewest().catch(() => {})
        }
        return
      }
      if (!context.live || context !== reactionContextRef.current) return
      context.settled.set(key, context.read)
    } finally {
      context.sending.delete(key)
      // The ref-held flight must repaint so the chips become pressable again.
      if (context.live && context === reactionContextRef.current) setReactionOverrides((prev) => new Map(prev))
    }
  }

  async function showReactors (key, emoji) {
    const context = reactionContext
    const view = reactionViewRef.current
    const item = view.rawById.get(key)
    if (asPage.page || !context.live || context !== reactionContextRef.current || view.disabled || view.picker !== null || view.whoOpen || !item || item.hidden || context.reading.has(key) || context.sending.has(key) || context.unsure.has(key)) return
    context.reading.add(key)
    const ticket = ++context.who
    setReactionError('')
    try {
      const result = await request('group.reactors', { group, target: { writer: item.writer, seq: item.seq } })
      if (!context.live || context !== reactionContextRef.current || ticket !== context.who || reactionViewRef.current.disabled) return
      const current = reactionViewRef.current
      if (current.picker !== null || current.whoOpen || !current.rawById.has(key) || current.rawById.get(key).hidden) return
      const rows = (result.reactions || []).filter((r) => !emoji || r.emoji === emoji).map((r) => ({
        emoji: r.emoji,
        count: r.count,
        by: r.by || []
      }))
      const unknown = [...new Set(rows.flatMap((r) => r.by))].filter((diary) => namesRef.current?.profileOf(diary) === undefined)
      if (unknown.length > 0) namesRef.current?.resolveMany(unknown)
      current.whoOpen = true
      setWhoReacted(rows)
    } catch (err) {
      if (context.live && context === reactionContextRef.current && ticket === context.who) setReactionError(errorText(err))
    } finally {
      context.reading.delete(key)
    }
  }

  if (!open) {
    return (
      <View style={styles.root}>
        <TopBar title='Grupo' onBack={onBack} />
        <EmptyState icon='cadeira' title='Comunidades indisponíveis' body={WEB_ONLY_TEXT} />
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
          <Pill label='Dispensar' onPress={() => { setCheck(null); if (check.change.action === 'post') setPostHold(null) }} />
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
  // As a page, the page's standing decides; its community button is on the page panel.
  const cardOffer = asPage.page ? pageOffer : offer
  if (!reader && loadedAt !== null) {
    if (role === 'requested') {
      outside = <EmptyState icon='cadeira' title='Aguardando aprovação' body={WAITING_TEXT} />
    } else if (role === 'banned') {
      outside = <EmptyState icon='cadeira' title={roleLabel('banned')} body={BANNED_TEXT} />
    } else if (hosted && info === null && lookup.status === 'loading' && JOINABLE.includes(role)) {
      outside = <Skeleton />
    } else if (JOINABLE.includes(role)) {
      const about = outsideAbout({ group, info, lookup, indexAbout })
      const note = outsideNote({ hosted, infoError: info === null ? infoError : '', lookup: info === null ? lookup.status : 'idle' })
      outside = (
        <View style={styles.outside}>
          {about
            ? (
              <View>
                <Label>Descrição</Label>
                <Text style={styles.about} numberOfLines={3}>{displayText(about)}</Text>
              </View>
              )
            : null}
          {role === 'pending' ? <Soft>{PENDING_TEXT}</Soft> : null}
          {isPrivate ? <Soft>{PRIVATE_OUTSIDE_TEXT}</Soft> : null}
          {note ? <Soft>{note}</Soft> : null}
          {hosted && info === null && lookup.status === 'failed'
            ? <Pill label='Tentar de novo' onPress={() => { lookRetry.current = true; loadInfo(); setLookupTick((n) => n + 1) }} />
            : null}
          {!asPage.page && heldRoleFailed && cardOffer === 'wait'
            ? <Pill label='Tentar de novo' onPress={() => setHeldRoleTick((n) => n + 1)} />
            : null}
          {orphan ? <Soft>{ORPHAN_TEXT}</Soft> : null}
          {!asPage.page && (cardOffer === 'community' || needCommunity) && communityKey !== null && typeof onOpenCommunity === 'function'
            ? <Btn label='Entrar na comunidade' onPress={() => onOpenCommunity(communityKey, { group })} />
            : null}
          {arriving || cardOffer !== 'group' || needCommunity ? null : <Btn label='Entrar no grupo' onPress={enter} pending={join.pending} disabled={!node.online || orphan} />}
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
    // A stored row is not confirmed by the node yet: no reaction, reply,
    // forward, hide or report until a live read replaces it.
    if (!live) return []
    const mine = row.mine === true
    const list = []
    if (!asPage.page && !row.hidden && reactionsFor(row).length > 0) {
      list.push({ icon: 'gente', label: 'Ver quem reagiu', disabled: reactionsDisabled || reactionContext.sending.has(row.key) || reactionContext.unsure.has(row.key), onPress: () => showReactors(row.key) })
    }
    if (canPost && replyOk && !row.hidden) {
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
    } else if (pageActs && !row.hidden && rawRow && typeof row.rawText === 'string' && row.rawText !== '') {
      // A page forwards the text into its own Conversas; a group's photos are
      // not DM media, so they stay behind.
      const source = { kind: 'dm', text: row.rawText, media: [], page: true }
      if (pageForwardSource(source) !== null) list.push({ icon: 'encaminhar', label: 'Encaminhar', onPress: () => setForwarding({ source, refs: [] }) })
    }
    if (typeof onMessage === 'function' && hosted && !mine && typeof row.diary === 'string' && row.diary !== '' && row.diary !== ownKey) {
      list.push({ icon: 'mensagem', label: 'Conversar em particular', onPress: () => onMessage(row.diary) })
    }
    if (asPage.page ? pageActs && pageCan('hide', pageRole, { own: mine }) : can('hide', role, { own: mine })) {
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

  rowLive.current = { profileFor, quoteOf, actionsOf, reactionsFor, scrollToKey, toggleReaction, showReactors, openReactionPicker }
  listLive.current = {
    refreshChat: () => { setLookupTick((n) => n + 1); load(true) },
    chatLayout: (e) => {
      scrollFrame.current.layoutHeight = e.nativeEvent.layout.height
      watchLanding()
    },
    chatContentSize: (width, height) => {
      scrollFrame.current.contentHeight = height
      watchLanding()
      // While the open heads for an unread row, growth places that
      // row and never follows the end.
      if (openHeading()) placeOpenRow(true)
      else followEnd()
    }
  }
  // A cell redraws only when extraData changes, so what each row derives from
  // screen state is computed here for all rows and folded into viewKey.
  const rowViews = new Map()
  const viewParts = []
  for (const row of listed ? rows : NO_ROWS) {
    const profile = profileFor(row)
    const known = whoOf(profile)
    const quote = row.replyTo ? quoteOf(row.replyTo) : null
    const view = {
      whoKey: [known.title, known.subtitle, known.avatarName].join('\n'),
      picture: profile && profile.avatar ? profile.avatar : undefined,
      quoteKey: quote ? JSON.stringify(quote) : null,
      reactions: reactionOverrides.get(row.key) || row.reactions || null,
      busy: reactionContext.sending.has(row.key) || reactionContext.unsure.has(row.key),
      actionsKey: actionsOf(row).map((action) => action.label + (action.disabled ? '!' : '')).join('\n')
    }
    rowViews.set(row.key, view)
    viewParts.push(row.key, view.whoKey, JSON.stringify(view.picture ?? null), view.quoteKey, view.busy, view.actionsKey)
  }
  const viewKey = JSON.stringify(viewParts)
  const extraDeps = [role, rawById, names, canPost, replyKey, flashKey, openKey, reactionOverrides, reactionsDisabled, viewKey, topicCards, styles, group, ownKey, reactionContext, onOpenMember, onOpenTopic, onOpenMention, rowCalls, live]
  if (!sameDeps(extraMemo.current, extraDeps)) extraMemo.current = { deps: extraDeps }
  const extra = extraMemo.current
  renderRef.current = ({ item: row }) => {
    // A cell from a render React threw away may ask for a row this render lacks.
    const view = rowViews.get(row.key) || {}
    return (
      <GroupRow
        row={row}
        calls={rowCalls}
        styles={styles}
        group={group}
        ownKey={ownKey}
        flash={flashKey === row.key}
        newMark={row.key === openKey}
        card={topicCards.get(row.key)}
        rawRow={rawById.get(row.key || row.id)}
        reactionContext={reactionContext}
        reactionsDisabled={reactionsDisabled || !live}
        onOpenMember={onOpenMember}
        onOpenTopic={onOpenTopic}
        onOpenMention={onOpenMention}
        whoKey={view.whoKey}
        picture={view.picture}
        quoteKey={view.quoteKey}
        reactions={view.reactions}
        busy={view.busy}
        actionsKey={view.actionsKey}
      />
    )
  }

  const inTopics = forumOn && forumTab === 'topicos'
  const left = MAX_TEXT - countChars(draft)
  // A writer is here but a post would still be refused. rekey-pending already
  // says so in the placeholder, so it gets no second note.
  const showJoinCard = deviceJoin && !deviceJoinSent
  // Private, writer here, but no epoch key yet: the same words as rekey-pending.
  const awaitingKey = !asPage.page && isPrivate && !canWriteHere(info) && !deviceJoin && meta.state !== 'rekey-pending' && info !== null && info.writerHere !== false
  const waitToWrite = !asPage.page && !showJoinCard && !orphan && !canWriteHere(info) && (role === 'creator' || role === 'admin' || role === 'member') && meta.state !== 'rekey-pending'
  const replyBar = replyKey !== null && replyOk ? (quoteOf(replyKey) || replyQuote) : null
  let composer = null
  if (reader && showJoinCard && !orphan) {
    const reserveSlots = [...groupSlots(info), ...(communityWriterHere === false ? communitySlotsKnown : [])]
    composer = (
      <View style={styles.composer}>
        <Soft>{DEVICE_JOIN_TEXT}</Soft>
        {reserveConfirm || reserveReachedAny(reserveSlots.map((s) => s.bound)) ? <Soft>{reserveText(reserveSlots)}</Soft> : null}
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
                {mediaHold.uncertain ? <Soft>{CHECK_UNKNOWN}</Soft> : null}
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
        onChangeText={(t) => { inFlightRef.current = followAutocorrect(inFlightRef.current, t, Date.now()); setDraft(t) }}
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
        onOpenReply={replyBar ? () => scrollToKey(replyKey) : undefined}
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
        {...pictureProps(info)}
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
                : pageOffer === 'group' ? <Btn label={PAGE_JOIN_LABEL} onPress={enter} pending={pagePending} disabled={!node.online} /> : null}
              {pageCommunityTarget !== null && typeof onOpenCommunity === 'function' ? <Btn label='Entrar na comunidade' onPress={() => onOpenCommunity(pageCommunityTarget, { group })} /> : null}
              {pageStatusFailed && pageOffer === 'wait' && !pageInside ? <Pill label='Tentar de novo' onPress={() => setPageStatusTick((n) => n + 1)} /> : null}
              {pageRetry ? <Pill label='Conferir de novo' onPress={pageRetry} pending={pagePending} /> : null}
              {sealAgain !== null ? <Pill label={PAGE_SEAL_AGAIN_LABEL} onPress={() => sendPost(sealAgain.text, sealAgain.replyTo, sealAgain.card)} pending={pagePending} /> : null}
            </View>
            {pageVis === null && loadedAt !== null && pageVisNote !== '' && pageVisNote !== loadError ? <Soft>{pageVisNote}</Soft> : null}
            <ErrorText>{pageError}</ErrorText>
          </View>
          )
        : null}
      <OfflineNote />
      {forumOn ? <Segmented options={FORUM_TABS} selected={forumTab} onSelect={setForumTab} /> : null}
      {forumOn && forumTab === 'topicos'
        ? (
          <RefreshableList
            data={reader ? topicRows : []}
            keyExtractor={(r) => r.key}
            renderItem={({ item }) => <TopicRow row={item} onPress={typeof onOpenTopic === 'function' ? () => onOpenTopic(group, { writer: item.writer, seq: item.seq }, { hidden: item.hidden, text: item.text }) : undefined} />}
            ListHeaderComponent={
              <View style={styles.note}>
                {canPost ? <Pill label='Novo tópico' icon='lapis' onPress={() => setNewTopicOpen(true)} disabled={!node.online} /> : null}
                {topicsError ? <ErrorText>{topicsError}</ErrorText> : null}
              </View>
            }
            ListEmptyComponent={topics === null && topicsLoading ? <Skeleton rows={3} /> : (topics !== null && !topicsError ? <EmptyState icon='conversas' title='Nenhum tópico ainda' body='Abra o primeiro tópico deste grupo.' /> : null)}
            onRefresh={() => loadTopics()}
            refreshing={topicsLoading && topics !== null}
            onLoadMore={topicsNext ? () => loadTopics(true) : undefined}
            loadingMore={topicsLoading && topics !== null}
            atEnd={topics !== null && !topicsNext}
          />
          )
        : (
          <EmbedBandBottom.Provider value={composer ? band : null}>
            <GroupListSlots.Provider
              value={{
                header: stateNotes,
                empty: (
                  <View>
                    {empty}
                    {loadedAt !== null && !loadError && canPost && node.online && node.passkey?.status?.unlocked === true && !post.pending && !pagePending && postHold === null && check === null && mediaHold === null && !sendingMedia
                      ? <View style={[styles.note, styles.inline]}>{['Oi', 'Tudo bem?'].map((text) => <Pill key={text} label={text} onPress={() => setDraft((d) => d.trim() ? d + '\n' + text : text)} />)}</View>
                      : null}
                  </View>
                ),
                footer: <View>{heldBubble(postHold) !== null ? <Bubble item={heldBubble(postHold)} mine status='uncertain' shape='single' /> : null}{reactionError ? <View style={styles.note}><ErrorText>{reactionError}</ErrorText></View> : null}{act.error ? <View style={styles.note}><ErrorText>{act.error}</ErrorText></View> : null}{banNote}{checkNote}</View>
              }}
            >
              <GroupChatList
                perfId='grupo'
                listRef={listRef}
                data={listed ? rows : NO_ROWS}
                keyExtractor={rowKeyOf}
                renderItem={renderItem}
                extraData={extra}
                allRowsOnWeb
                contentContainerStyle={styles.thread}
                ListHeaderComponent={GroupListHeader}
                ListEmptyComponent={GroupListEmpty}
                ListFooterComponent={GroupListFooter}
                onRefresh={refreshChat}
                refreshing={refreshing}
                // Only after the landing. On native, rows prepended under this
                // prop hold the list's window until a scroll event comes, and
                // the open walk prepends its older page to a list still shorter
                // than its view, which never scrolls: it stayed at the first 8 rows.
                keepVisiblePosition={placed}
                onScrollFrame={trackBottom}
                onLayout={chatLayout}
                onContentSizeChange={chatContentSize}
                onUserScroll={userScroll}
                onScrollToIndexFailed={indexFailed}
                onViewableItemsChanged={viewable}
              />
            </GroupListSlots.Provider>
          </EmbedBandBottom.Provider>
          )}
      {quoteToast && !inTopics ? <View pointerEvents='none' style={styles.quoteToast}><Text accessibilityLiveRegion='polite' style={styles.quoteToastText}>Mensagem fora do trecho carregado</Text></View> : null}
      {!inTopics && jump.show ? <JumpToEnd text={jump.text} hint={jump.hint} onPress={scrollToEnd} /> : null}
      {composer && !inTopics ? <View ref={composerBox} collapsable={false}>{composer}</View> : null}
      <ReactionPicker
        open={reactionPicker !== null && !reactionsDisabled && !reactionContext.sending.has(reactionPicker) && !reactionContext.unsure.has(reactionPicker)}
        onClose={() => setReactionPicker(null)}
        onPick={(emoji) => { const key = reactionPicker; setReactionPicker(null); if (key !== null) toggleReaction(key, emoji) }}
      />
      {forumOn ? <NewTopicSheet open={newTopicOpen} onClose={() => { setNewTopicOpen(false); setTopicRefusal('') }} onCreate={createTopic} pending={newTopic.pending} error={topicRefusal || newTopic.error} /> : null}
      <WhoReacted open={whoReacted !== null && !reactionsDisabled} onClose={() => { reactionContext.who++; setWhoReacted(null) }} rows={whoReactedRows} />
      <ForwardSheet
        open={forwarding !== null}
        onClose={() => setForwarding(null)}
        source={forwarding ? forwarding.source : null}
        refs={forwarding ? forwarding.refs : []}
        identity={ownKey}
        {...(asPage.page ? { request: pageDm, page: asPage.key } : {})}
      />
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

// Stands in for the per-render handlers of the group chat: each call reads
// the newest one, so the memoized list never runs a handler of the render that
// last drew it.
const GROUP_LIST_CALLS = ['refreshChat', 'chatLayout', 'chatContentSize']
function liveGroupListCalls (live) {
  return Object.fromEntries(GROUP_LIST_CALLS.map((name) => [name, (...args) => live.current[name](...args)]))
}

function sameDeps (cached, deps) {
  return cached !== null && cached.deps.length === deps.length && cached.deps.every((dep, i) => Object.is(dep, deps[i]))
}

// The chat list skips a screen render that changed none of its props (a
// keystroke); its header, empty and footer slots follow the screen through
// GroupListSlots, which reaches them past the memo.
const GroupChatList = memo(RefreshableList)
const NO_ROWS = Object.freeze([])
const rowKeyOf = (row) => row.key
const GroupListSlots = createContext(null)
function GroupListHeader () { const slots = useContext(GroupListSlots); return slots ? slots.header : null }
function GroupListEmpty () { const slots = useContext(GroupListSlots); return slots ? slots.empty : null }
function GroupListFooter () { const slots = useContext(GroupListSlots); return slots ? slots.footer : null }

const GROUP_ROW_CALLS = ['profileFor', 'quoteOf', 'actionsOf', 'reactionsFor', 'scrollToKey', 'toggleReaction', 'showReactors', 'openReactionPicker']
export function liveGroupRowCalls (live) {
  return Object.fromEntries(GROUP_ROW_CALLS.map((name) => [name, (...args) => live.current[name](...args)]))
}

// Shallow compare on every prop, row included: the row is the memoized object
// of the rows list, so a new one carries new text, reactions or shape. whoKey,
// picture, quoteKey, reactions, busy and actionsKey are not read here (the row
// asks `calls`); they redraw it when what those calls answer changed.
const GroupRow = memo(function GroupRow ({ row, calls, styles, group, ownKey, flash, newMark, card, rawRow, reactionContext, reactionsDisabled, onOpenMember, onOpenTopic, onOpenMention, whoKey, picture, quoteKey, reactions, busy, actionsKey }) {
  const { profileFor, quoteOf, actionsOf, reactionsFor, scrollToKey, toggleReaction, showReactors, openReactionPicker } = calls
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
        <Avatar name={who.avatarName} publicKey={row.diary || row.writer} picture={picture} size={32} persist={false} />
      </Pressable>
      )
  if (card) {
    return (
      <TopicRow
        row={{ key: card.ref, diary: card.message.diary, title: card.title, replies: null, lastReplyLabel: '', poll: card.poll }}
        onPress={typeof onOpenTopic === 'function' ? () => onOpenTopic(group, { writer: card.message.writer, seq: card.message.seq }, { hidden: false, text: typeof card.message.text === 'string' ? card.message.text : '' }) : undefined}
      />
    )
  }
  const refs = row.hidden || !rawRow ? [] : chatMediaRefs('group', { diary: rawRow.diary, media: rawRow.media })
  // A sheet stays open across redraws it does not see, so each action is
  // looked up again by label when pressed.
  const actions = actionsOf(row).map((action) => ({ ...action, onPress: () => { const now = calls.actionsOf(row).find((a) => a.label === action.label); if (now) now.onPress() } }))
  const reply = actions.find((action) => action.label === 'Responder')
  return (
    <SwipeReply disabled={!reply} onReply={reply?.onPress}>
      <View style={flash ? styles.quoteFlash : undefined}>
        {newMark
          ? (
            <View style={styles.newMark} pointerEvents='none' accessible accessibilityLabel='Mensagens novas a partir daqui'>
              <Divider label='Mensagens novas' />
            </View>
            )
          : null}
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
          actions={actions}
          actionsTitle={mine ? undefined : who.title}
          below={<ReactionChips reactions={reactionsFor(row)} disabled={reactionsDisabled || reactionContext.sending.has(row.key) || reactionContext.unsure.has(row.key)} onToggle={(emoji) => toggleReaction(row.key, emoji)} onShowWho={(emoji) => showReactors(row.key, emoji)} overlap />}
          actionsHeader={!row.hidden && !reactionsDisabled && !reactionContext.sending.has(row.key) && !reactionContext.unsure.has(row.key)
            ? ({ closeThen }) => <QuickReactions mine={reactionsFor(row).find((r) => r.mine)?.emoji} onPick={(emoji) => closeThen(() => toggleReaction(row.key, emoji))} onMore={() => closeThen(() => openReactionPicker(row.key))} />
            : null}
          onOpenMention={typeof onOpenMention === 'function' ? onOpenMention : undefined}
        />
      </View>
    </SwipeReply>
  )
})

const makeStyles = (colors) => StyleSheet.create({
  quoteFlash: { backgroundColor: colors.line },
  newMark: { paddingHorizontal: space.lg, paddingVertical: space.sm },
  quoteToast: { padding: 12, borderRadius: 12, marginHorizontal: 16, backgroundColor: colors.ink },
  quoteToastText: { color: colors.bg, textAlign: 'center' },
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
  about: { ...type.postMeta, color: colors.soft },
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
