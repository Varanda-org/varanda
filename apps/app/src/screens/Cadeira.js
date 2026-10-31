// Cadeira: one group's conversation, pushed above the tabs (nav.js screen
// 'cadeira', keyed by the group root). Props: { group, onBack,
// onOpenCommunity(community), onOpenMember(diary), onReport(target) }, with
// `target` in Denunciar's shape { author, name, username, seq, text, group,
// writer, private }. Renders CadeiraAjustes itself as a sheet.
// Oldest message on top, newest at the bottom; older pages come from the
// `before` cursor (groups.js applyPage). The screen re-reads when the
// node's version of the group moves (groups.changed) and on pull to refresh.
// Someone who has not joined (opened from a /g/<hex> link) sees what
// group.info knows and an "Entrar na cadeira" button; a private group never
// shows a message to them. The draft lives only in this component's state:
// never queued, never persisted (for a private group that would leak the
// plaintext). A mutation answered UNCERTAIN is never resent: the screen
// re-reads, asks groups.js reconcile and only then offers "tentar de novo".
// Hosted web only: elsewhere the screen says so, like Avisos.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { MAX_TEXT, displayText } from '@varanda/rpc'
import { useNode } from '../node'
import { countChars } from '../format'
import {
  EMPTY_PAGES, PRIVATE_LABEL, REKEY_PENDING_LABEL,
  applyPage, can, itemsOf, joinLabel, membersLabel, reconcile, roleLabel, roleOf, rowsOf, sealedLabel, visibilityLabel
} from '../groups'
import { Btn, ErrorText, Notice, Soft, colors, errorText, useAction, useNow } from '../ui'
import { GroupMessageRow } from '../ui/GroupMessageRow'
import { OfflineNote } from '../ui/OfflineNote'
import { Pill } from '../ui/Pill'
import { RefreshableList } from '../ui/RefreshableList'
import { EmptyState, ErrorState, Skeleton } from '../ui/States'
import { TopBar } from '../ui/TopBar'
import { CadeiraAjustes } from './CadeiraAjustes'

export const WEB_ONLY_TEXT = 'Cadeiras de Praia só na versão web'
const LOCKED_TEXT = 'Desbloqueie para ler esta cadeira.'
const INCOMPLETE_TEXT = 'Algumas mensagens ainda não chegaram a este aparelho.'
const OFFLINE_POST_TEXT = 'Sem conexão: a mensagem só pode ser enviada com internet.'
const WAITING_TEXT = 'Pedido enviado: aguardando aprovação de um administrador.'
const BANNED_TEXT = 'Você não pode mais participar desta cadeira.'
const PENDING_TEXT = 'Aguardando sincronização desta cadeira.'
const PRIVATE_OUTSIDE_TEXT = 'As mensagens desta cadeira são cifradas de ponta a ponta. Só quem entra consegue ler.'
const CHECK_UNKNOWN = 'Não deu para confirmar se isso foi aplicado. Confira antes de tentar de novo.'
const CHECK_NOT_LANDED = 'Não foi aplicado. Você pode tentar de novo.'

const READERS = ['creator', 'admin', 'member']
const JOINABLE = [null, 'left', 'pending']

export function Cadeira ({ group, onBack, onOpenCommunity, onOpenMember, onReport }) {
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
  const post = useAction()
  const act = useAction()
  const join = useAction()
  const seqRef = useRef(0)
  const storeRef = useRef(store)
  storeRef.current = store
  const listRef = useRef(null)

  const infoRef = useRef(info)
  infoRef.current = info
  const role = roleOf(info, ownKey)
  const reader = READERS.includes(role)
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
      if (change.action === 'post') setDraft((d) => (d === change.text ? '' : d))
      return
    }
    setCheck({ change, verdict, retry })
  }, [verify])

  // `text` is the original text: a retry after an uncertain post resends it,
  // never whatever the draft holds by then.
  const sendPost = async (text) => {
    if (typeof text !== 'string' || text.trim() === '' || !node.online) return
    setCheck(null)
    const sentAt = Date.now()
    const r = await post.run(() => request('group.post', { group, text }))
    if (r.ok) {
      setDraft((d) => (d === text ? '' : d))
      readNewest().then(() => scrollToEnd(), () => {})
    } else if (r.uncertain) {
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
    const r = await join.run(() => request('group.join', { group }))
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

  const nameText = info && typeof info.name === 'string' && info.name !== ''
    ? displayText(info.name)
    : (isPrivate || info === null ? PRIVATE_LABEL : 'cadeira')
  const subtitle = info
    ? [visibilityLabel(info.visibility), joinLabel(info.join), membersLabel(info.members)].filter(Boolean).join(' · ')
    : ''
  const community = info && Array.isArray(info.communities) && info.communities.length > 0 ? info.communities[0] : null

  if (!hosted) {
    return (
      <View style={styles.root}>
        <TopBar title='Cadeira' onBack={onBack} />
        <EmptyState icon='cadeira' title='Só na versão web' body={WEB_ONLY_TEXT} />
      </View>
    )
  }

  const headerRight = (
    <View style={styles.headerRight}>
      {community && typeof onOpenCommunity === 'function'
        ? <Pill label='comunidade' onPress={() => onOpenCommunity(community)} accessibilityLabel='abrir a comunidade' />
        : null}
      {info
        ? (
          <Pressable
            accessibilityRole='button'
            accessibilityLabel='ajustes da cadeira'
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
        <Soft>Banir {banTarget.author} desta cadeira? A pessoa não poderá mais escrever aqui.</Soft>
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
          <Btn label='Entrar na cadeira' onPress={enter} pending={join.pending} disabled={!node.online} />
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
  else if (reader) empty = <EmptyState icon='cadeira' title='Nenhuma mensagem ainda' body='Escreva a primeira.' />
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

  const canPost = reader && can('post', role) && meta.state === 'ok'
  const left = MAX_TEXT - countChars(draft)

  return (
    <View style={styles.root}>
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
        onRefresh={() => load(true)}
        refreshing={refreshing}
        keepVisiblePosition
      />
      {reader
        ? (
          <View style={styles.composer}>
            {!node.online ? <Soft>{OFFLINE_POST_TEXT}</Soft> : null}
            <ErrorText>{post.error}</ErrorText>
            <View style={styles.composeRow}>
              <TextInput
                style={styles.input}
                value={draft}
                onChangeText={setDraft}
                multiline
                maxLength={MAX_TEXT * 2}
                editable={canPost}
                placeholder={meta.state === 'rekey-pending' ? REKEY_PENDING_LABEL : 'Escreva uma mensagem'}
                placeholderTextColor={colors.placeholder}
                accessibilityLabel='mensagem para a cadeira'
              />
              <Btn
                label='Enviar'
                onPress={() => sendPost(draft)}
                pending={post.pending}
                disabled={!canPost || !node.online || draft.trim() === '' || left < 0}
              />
            </View>
            {left < 50 ? <Soft>{left} caracteres restantes</Soft> : null}
          </View>
          )
        : null}
      {info
        ? (
          <CadeiraAjustes
            group={group}
            visible={settingsOpen}
            onClose={() => setSettingsOpen(false)}
            onLeft={() => { setSettingsOpen(false); loadRef.current() }}
            onOpenMember={onOpenMember}
            onOpenCommunity={onOpenCommunity}
          />
          )
        : null}
    </View>
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
