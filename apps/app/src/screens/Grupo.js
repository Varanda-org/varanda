// Grupo: one group's conversation, pushed above the tabs (nav.js screen
// 'grupo', keyed by the group root). Props: { group, onBack,
// onOpenCommunity(community, { group }?), onOpenMember(diary),
// onReport(target), onSeen(group), isTop }, with `target` in Denunciar's shape
// { author, name, username, seq, text, group, writer, private }; onSeen runs
// after every group.seen attempt, answered or not. Only what the person sees
// is marked seen: the app visible, this screen on top (isTop false: buried
// under another screen) and the latest read painted. Renders GrupoAjustes itself
// as a sheet. The top bar names the group's community (a pill that opens it).
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
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { MAX_TEXT, displayText } from '@varanda/rpc'
import { useNode } from '../node'
import { countChars } from '../format'
import {
  DEVICE_APPROVAL_TEXT, DEVICE_JOIN_LABEL, DEVICE_JOIN_TEXT, DEVICE_RESERVE_TEXT, DEVICE_WAIT_TEXT,
  EMPTY_PAGES, PRIVATE_LABEL, REKEY_PENDING_LABEL,
  applyPage, can, canWriteHere, reserveReachedAny, needsReserveConfirm, itemsOf, joinLabel, membersLabel, needsDeviceJoin, reconcile, roleLabel, roleOf, rowsOf, sealedLabel, visibilityLabel
} from '../groups'
import { Btn, ErrorText, Notice, Soft, colors, errorText, useAction, useNow } from '../ui'
import { GroupMessageRow } from '../ui/GroupMessageRow'
import { OfflineNote } from '../ui/OfflineNote'
import { Pill } from '../ui/Pill'
import { RefreshableList } from '../ui/RefreshableList'
import { EmptyState, ErrorState, Skeleton } from '../ui/States'
import { TopBar } from '../ui/TopBar'
import { fetchGroup } from '../indexClient'
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

export function Grupo ({ group, onBack, onOpenCommunity, onOpenMember, onReport, onSeen, isTop = true }) {
  const node = useNode()
  const now = useNow(60000)
  const hosted = node.hosted === true
  const ownKey = node.passkey && node.passkey.status ? node.passkey.status.publicKey : null
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
  // The load whose newest read painted; equal to seqRef when none is in flight.
  const paintedRef = useRef(0)
  const listRef = useRef(null)

  const infoRef = useRef(info)
  infoRef.current = info
  const role = roleOf(info, ownKey)
  const reader = READERS.includes(role)
  const deviceJoin = needsDeviceJoin(info)
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

  const readNewest = useCallback(async () => {
    const read = await request('group.read', { group })
    commitRead(read, null)
    return read
  }, [request, group, commitRead])

  // group.seen emits nothing, and a lost answer may have written the mark, so
  // the caller hears of every attempt, even after a quick back.
  const markSeen = useCallback(async () => {
    try {
      await request('group.seen', { group })
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
  }, [hosted, loadInfo, readNewest, ownKey, loadedAt])

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

  const loadOlder = useCallback(async () => {
    const before = storeRef.current.next
    if (!before || loadingMore) return
    setLoadingMore(true)
    setMoreError('')
    try {
      const read = await request('group.read', { group, before })
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
  }, [request, group, loadingMore, readNewest])

  const rawItems = useMemo(() => itemsOf(store), [store])
  const rows = useMemo(() => rowsOf(rawItems), [rawItems])
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
      }
      return
    }
    setCheck({ change, verdict, retry })
  }, [verify])

  // `text` is the original text: a retry after an uncertain post resends it,
  // never whatever the draft holds by then.
  const sendPost = async (text) => {
    if (typeof text !== 'string' || text.trim() === '' || !node.online) return
    setCheck(null)
    setPostHold(null)
    const sentAt = Date.now()
    const r = await post.run(() => request('group.post', { group, text }))
    if (r.ok) {
      setDraft((d) => (d === text ? '' : d))
      readNewest().then(() => scrollToEnd(), () => {})
    } else if (r.uncertain) {
      setPostHold(text)
      settle({ action: 'post', diary: ownKey, text, sentAt }, () => sendPost(text))
    }
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
  const lastId = rows.length > 0 ? rows[rows.length - 1].id : null
  useEffect(() => {
    if (lastId !== null) scrollToEnd()
  }, [lastId])

  // A buried screen keeps re-reading but never marks; a failed or unfinished
  // read marks nothing. Keyed on the newest message on screen, so any paint
  // marks it; uncovering the screen or bringing the app back marks what
  // already shows, without a reload that would drop the older pages.
  const visible = node.visible !== false
  useEffect(() => {
    if (!visible || !isTop || !reader || lastId === null || loadedAt === null || loadError !== '') return
    if (paintedRef.current !== seqRef.current) return
    markSeen()
  }, [visible, isTop, reader, lastId, loadedAt, loadError, markSeen])

  const nameText = info && typeof info.name === 'string' && info.name !== ''
    ? displayText(info.name)
    : (isPrivate || info === null ? PRIVATE_LABEL : 'grupo')
  const subtitle = info
    ? [visibilityLabel(info.visibility), joinLabel(info.join), membersLabel(info.members)].filter(Boolean).join(' · ')
    : ''
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

  const headerRight = (
    <View style={styles.headerRight}>
      {heldCommunity && typeof onOpenCommunity === 'function'
        ? <Pill label={communityName !== '' ? displayText(communityName) : 'comunidade'} onPress={() => onOpenCommunity(heldCommunity)} accessibilityLabel='abrir a comunidade' />
        : null}
      {info
        ? (
          <Pressable
            accessibilityRole='button'
            accessibilityLabel='ajustes do grupo'
            hitSlop={10}
            onPress={() => setSettingsOpen(true)}
            style={({ pressed }) => [styles.gear, pressed && styles.pressed]}
          >
            <Text style={styles.gearText}>⋯</Text>
          </Pressable>
          )
        : null}
    </View>
  )

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
        <Soft>Banir {banTarget.author} deste grupo? A pessoa não poderá mais escrever aqui.</Soft>
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

  const renderItem = ({ item }) => {
    const raw = rawById.get(item.id)
    const own = typeof ownKey === 'string' && item.diary === ownKey
    return (
      <GroupMessageRow
        item={item}
        name={raw ? raw.name : null}
        username={raw ? raw.username : null}
        own={own}
        now={now}
        canHide={can('hide', role, { own })}
        canBan={can('ban', role) && !!item.diary}
        canReport={typeof onReport === 'function' && !!item.diary}
        onHide={(on) => hide(item, on)}
        onBan={() => setBanTarget(item)}
        onReport={() => report(item)}
        onOpenMember={typeof onOpenMember === 'function' && item.diary ? () => onOpenMember(item.diary) : undefined}
      />
    )
  }

  const canPost = reader && can('post', role) && meta.state === 'ok' && !orphan && canWriteHere(info)
  const left = MAX_TEXT - countChars(draft)
  // A writer is here but a post would still be refused. rekey-pending already
  // says so in the placeholder, so it gets no second note.
  const showJoinCard = deviceJoin && !deviceJoinSent
  // Private, writer here, but no epoch key yet: the same words as rekey-pending.
  const awaitingKey = isPrivate && !canWriteHere(info) && !deviceJoin && meta.state !== 'rekey-pending' && info !== null && info.writerHere !== false
  const waitToWrite = !showJoinCard && !orphan && !canWriteHere(info) && (role === 'creator' || role === 'admin' || role === 'member') && meta.state !== 'rekey-pending'
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
  } else if (reader) {
    composer = (
      <View style={styles.composer}>
        {waitToWrite ? <Soft>{awaitingKey ? REKEY_PENDING_LABEL : (communityJoin === 'approval' && !isPrivate ? DEVICE_APPROVAL_TEXT : DEVICE_WAIT_TEXT)}</Soft> : null}
        {orphan ? <Soft>{ORPHAN_TEXT}</Soft> : null}
        {!node.online ? <Soft>{OFFLINE_POST_TEXT}</Soft> : null}
        <ErrorText>{post.error}</ErrorText>
        <View style={styles.composeRow}>
          <TextInput
            style={styles.input}
            value={draft}
            onChangeText={(t) => { setDraft(t); setPostHold(null) }}
            multiline
            maxLength={MAX_TEXT * 2}
            editable={canPost}
            placeholder={meta.state === 'rekey-pending' || awaitingKey ? REKEY_PENDING_LABEL : 'Escreva uma mensagem'}
            placeholderTextColor={colors.placeholder}
            accessibilityLabel='mensagem para o grupo'
          />
          <Btn
            label='Enviar'
            onPress={() => sendPost(draft)}
            pending={post.pending}
            disabled={!canPost || !node.online || draft.trim() === '' || left < 0 || postHold !== null}
          />
        </View>
        {left < 50 ? <Soft>{left} caracteres restantes</Soft> : null}
      </View>
    )
  }

  // On iOS the keyboard opens over the bottom composer unless the screen
  // shrinks for it (Android resizes the window itself: adjustResize).
  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <TopBar title={nameText} subtitle={subtitle} onBack={onBack} right={headerRight} />
      <OfflineNote />
      <RefreshableList
        listRef={listRef}
        data={reader ? rows : []}
        keyExtractor={(row) => row.id}
        renderItem={renderItem}
        extraData={{ now, role, rawById }}
        ListHeaderComponent={stateNotes}
        ListEmptyComponent={empty}
        ListFooterComponent={<View>{act.error ? <View style={styles.note}><ErrorText>{act.error}</ErrorText></View> : null}{banNote}{checkNote}</View>}
        onRefresh={() => { setLookupTick((n) => n + 1); load(true) }}
        refreshing={refreshing}
        keepVisiblePosition
      />
      {composer}
      {info
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

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  gear: { paddingHorizontal: 6 },
  gearText: { fontSize: 22, color: colors.ink },
  pressed: { opacity: 0.6 },
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
  composeRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  input: {
    flex: 1,
    minHeight: 40,
    maxHeight: 140,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 9,
    fontSize: 16,
    color: colors.ink,
    backgroundColor: colors.bg
  }
})
