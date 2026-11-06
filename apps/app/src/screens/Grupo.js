// Grupo: one group's conversation, pushed above the tabs (nav.js screen
// 'grupo', keyed by the group root). Props: { group, onBack,
// onOpenCommunity(community, { group }?), onOpenMember(diary), onOpenMention(username),
// onReport(target), onSeen(group), isTop }, with `target` in Denunciar's shape
// { author, name, username, seq, text, group, writer, private }; onSeen runs
// after every group.seen attempt, answered or not. Only what the person sees
// is marked seen, up to the newest painted row: the app visible, this screen
// on top (isTop false: buried under another screen) and the latest read
// painted. Renders GrupoAjustes itself as a sheet, opened by the header's
// settings icon or a tap on its titles. The header shows the group's name
// and member count; the community is a small line under it that opens it.
// Messages are bubbles (group-screen.js groupRows, ui/Bubble): a long press
// offers Responder, Copiar, Esconder, Banir and Denunciar under can(). A reply
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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, View } from 'react-native'
import { MAX_TEXT, displayText } from '@varanda/rpc'
import { useNode } from '../node'
import { countChars } from '../format'
import { groupRows, replyPreview } from '../group-screen'
import { UNNAMED, readsAs, whoOf } from '../who'
import { copyText } from '../share'
import { shareNav } from '../shareNav'
import {
  AS_PAGE_LABEL, DEVICE_APPROVAL_TEXT, DEVICE_JOIN_LABEL, DEVICE_JOIN_TEXT, DEVICE_RESERVE_TEXT, DEVICE_WAIT_TEXT,
  EMPTY_PAGES, OWN_LABEL, PAGE_JOIN_LABEL, PAGE_LEAVE_LABEL, PRIVATE_LABEL, REKEY_PENDING_LABEL,
  applyPage, can, canWriteHere, reserveReachedAny, needsReserveConfirm, itemsOf, membersLabel, needsDeviceJoin, pageCan, pageErrorText, pageMode, pageRoleLabel, pageRoleOf, reconcile, roleLabel, roleOf, sealedLabel, visibilityLabel
} from '../groups'
import { Btn, ErrorText, Notice, Soft, errorText, useAction, useNow } from '../ui'
import { useStyles, useTheme } from '../ui/ThemeProvider'
import { Avatar } from '../ui/Avatar'
import { Bubble } from '../ui/Bubble'
import { ChatComposer } from '../ui/ChatComposer'
import { ChatHeader } from '../ui/ChatHeader'
import { Icon } from '../ui/Icon'
import { OfflineNote } from '../ui/OfflineNote'
import { Pill } from '../ui/Pill'
import { RefreshableList } from '../ui/RefreshableList'
import { EmptyState, ErrorState, Skeleton } from '../ui/States'
import { TopBar } from '../ui/TopBar'
import { space } from '../ui/theme'
import { fetchGroup } from '../indexClient'
import { useNames } from '../names'
import { pagesOn } from '../pageGate'
import { pagesGroup } from '../pages'
import { memberKeyOf, useActing } from './Conversa'
import { shouldRedirectToCommunity } from '../groupRedirect'
import { GrupoAjustes } from './GrupoAjustes'

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

export function Grupo ({ group, onBack, onOpenCommunity, onOpenMember, onOpenMention, onReport, onSeen, isTop = true }) {
  const styles = useStyles(makeStyles)
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
  // The text of a post whose outcome is not known: no second send until the
  // person edits the draft or asks for it.
  const [postHold, setPostHold] = useState(null)
  const lookedUp = useRef(false)
  const lookBusy = useRef(false)
  const redirected = useRef(false)
  const post = useAction()
  const act = useAction()
  const join = useAction()
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

  const readGroup = useCallback(async (before) => {
    if (!asPage.page) return request('group.read', before ? { group, before } : { group })
    const member = await memberKeyOf(request, node)
    return pagesGroup(node, { member, page: asPage.key, action: 'group-read', op: before ? { group, before } : { group } })
  }, [request, group, node, asPage.page, asPage.key])

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
        if (mine === seqRef.current) setLoadError(pageErrorText(err))
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
    setLoadError('')
    setLoadedAt(null)
    loadRef.current()
  }, [asPage.key])

  const loadOlder = useCallback(async () => {
    const before = storeRef.current.next
    if (!before || loadingMore) return
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
    try {
      await fn()
      setDraft((d) => (d === text ? '' : d))
      setPostHold(null)
      setCheck(null)
      readNewest().then(() => scrollToEnd(), () => {})
    } catch (err) {
      if (err && err.uncertain === true && typeof err.retry === 'function') {
        setPostHold(text)
        settle({ action: 'post', diary: asPage.key, text, sentAt }, () => pageSend(err.retry, text, sentAt))
      } else {
        setPageError(pageErrorText(err))
      }
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
        setPageError(pageErrorText(err))
      }
    } finally {
      setPagePending(false)
    }
  }

  const pageStatement = (action, op) => async () => {
    const member = await memberKeyOf(request, node)
    return pagesGroup(node, { member, page: asPage.key, action, op })
  }

  // `replyTo` is { writer, seq } exactly (rpc group.post) or null. A page's
  // statement carries no reply: Responder is not offered as a page.
  const sendPost = async (text, replyTo = null) => {
    if (typeof text !== 'string' || text.trim() === '' || !node.online) return
    if (asPage.page) {
      pageSend(pageStatement('group-post', { group, text }), text, Date.now())
      return
    }
    setCheck(null)
    setPostHold(null)
    const sentAt = Date.now()
    const params = replyTo ? { group, text, replyTo: { writer: replyTo.writer, seq: replyTo.seq } } : { group, text }
    const r = await post.run(() => request('group.post', params))
    if (r.ok) {
      setDraft((d) => (d === text ? '' : d))
      if (replyTo) setReplyKey((k) => (k === replyTo.writer + ':' + replyTo.seq ? null : k))
      readNewest().then(() => scrollToEnd(), () => {})
    } else if (r.uncertain) {
      setPostHold(text)
      settle({ action: 'post', diary: ownKey, text, sentAt, replyKey: replyTo ? replyTo.writer + ':' + replyTo.seq : null }, () => sendPost(text, replyTo))
    }
  }

  // The reply target is read from its key, never from the loaded pages: a
  // refresh that drops the target from rawById must not turn the reply into a
  // plain message.
  const sendDraft = () => {
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
      private: isPrivate
    })
  }

  const scrollToEnd = () => {
    const list = listRef.current
    if (list && typeof list.scrollToEnd === 'function') {
      setTimeout(() => list.scrollToEnd({ animated: false }), 0)
    }
  }
  const last = rows.length > 0 ? rows[rows.length - 1] : null
  const lastId = last === null ? null : last.id
  cutRef.current = last !== null && typeof last.at === 'string' ? { at: last.at, writer: last.writer, seq: last.seq } : null
  useEffect(() => {
    if (lastId !== null) scrollToEnd()
  }, [lastId])

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
            ? <Pill label='tentar de novo' onPress={() => { setCheck(null); check.retry() }} />
            : <Pill label='conferir' onPress={() => settle(check.change, check.retry)} />}
          <Pill label='dispensar' onPress={() => setCheck(null)} />
        </View>
      </View>
      )
    : null

  const banNote = banTarget
    ? (
      <View style={styles.note}>
        <Soft>Banir {displayText(whoOf(profileFor(banTarget)).title)} deste grupo? A pessoa não poderá mais escrever aqui.</Soft>
        <View style={styles.inline}>
          <Pill label='banir' danger onPress={() => ban(banTarget)} pending={act.pending} />
          <Pill label='cancelar' onPress={() => setBanTarget(null)} />
        </View>
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
              <Pill label='mensagens anteriores' onPress={loadOlder} pending={loadingMore} />
              <ErrorText>{moreError}</ErrorText>
            </View>
            )
          : null}
        {infoError && info !== null
          ? (
            <View style={styles.note}>
              <ErrorText>{infoError}</ErrorText>
              <Pill label='tentar de novo' onPress={() => load()} pending={loading || refreshing} />
            </View>
            )
          : null}
        {meta.state === 'locked' ? <View style={styles.note}><Notice>{LOCKED_TEXT}</Notice></View> : null}
        {meta.sealed > 0 ? <View style={styles.note}><Soft>{sealedLabel(meta.sealed)}</Soft></View> : null}
        {meta.incomplete ? <View style={styles.note}><Soft>{INCOMPLETE_TEXT}</Soft></View> : null}
        {meta.state === 'rekey-pending'
          ? (
            <View style={styles.note}>
              <Notice>{REKEY_PENDING_LABEL}</Notice>
              {can('rekey', role) ? <Pill label='Gerar nova chave' onPress={rekey} pending={act.pending} /> : null}
            </View>
            )
          : null}
      </View>
      )
    : null

  let empty
  if (loadError && rows.length === 0) empty = <ErrorState message={loadError} onRetry={() => load()} pending={loading} />
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
    if (!asPage.page && can('hide', role, { own: mine })) {
      list.push({ icon: row.hidden ? 'olho' : 'olho_fechado', label: row.hidden ? 'Mostrar' : 'Esconder', onPress: () => hide(row, !row.hidden) })
    }
    if (!asPage.page && can('ban', role) && !!row.diary && !mine) {
      list.push({ icon: 'fechar', label: 'Banir', danger: true, onPress: () => setBanTarget(row) })
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
    return (
      <Bubble
        item={{ key: row.key, text: row.text, rawText: row.hidden ? undefined : row.rawText, at: row.at, hidden: row.hidden, dayMark: row.dayMark }}
        mine={mine}
        shape={row.shape}
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
    ? pageCan('post', pageRole) && meta.state === 'ok'
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
    const notes = waitToWrite || orphan || !node.online || post.error
      ? (
        <View style={styles.composeNotes}>
          {waitToWrite ? <Soft>{awaitingKey ? REKEY_PENDING_LABEL : (communityJoin === 'approval' && !isPrivate ? DEVICE_APPROVAL_TEXT : DEVICE_WAIT_TEXT)}</Soft> : null}
          {orphan ? <Soft>{ORPHAN_TEXT}</Soft> : null}
          {!node.online ? <Soft>{OFFLINE_POST_TEXT}</Soft> : null}
          <ErrorText>{post.error}</ErrorText>
        </View>
        )
      : null
    composer = (
      <ChatComposer
        value={draft}
        onChangeText={(t) => { setDraft(t); setPostHold(null) }}
        onSend={sendDraft}
        sending={post.pending || pagePending}
        sendDisabled={!canPost || !node.online || left < 0 || postHold !== null}
        editable={canPost}
        placeholder={meta.state === 'rekey-pending' || awaitingKey ? REKEY_PENDING_LABEL : 'Escreva uma mensagem'}
        accessibilityLabel='mensagem para o grupo'
        reply={replyBar ? { name: replyBar.name, text: replyBar.text, senderKey: replyBar.senderKey, mine: replyBar.mine } : null}
        onCancelReply={() => setReplyKey(null)}
        notice={notes}
        ownKey={ownKey}
      />
    )
  }

  // On iOS the keyboard opens over the bottom composer unless the screen
  // shrinks for it (Android resizes the window itself: adjustResize).
  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
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
                ? <Pill label={PAGE_LEAVE_LABEL} onPress={() => pageMembership(pageStatement('group-leave', { group }))} pending={pagePending} />
                : <Btn label={PAGE_JOIN_LABEL} onPress={enter} pending={pagePending} disabled={!node.online} />}
              {pageRetry ? <Pill label='conferir de novo' onPress={pageRetry} pending={pagePending} /> : null}
            </View>
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
      />
      {composer}
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
  composeNotes: { gap: 4, paddingHorizontal: space.xs }
})
