// Mensagens: the private conversations list inside Conversas (docs/rpc.md
// 5.73 to 5.81). Hosted and unlocked only; a node that is not hosted never
// mounts it (the tab is absent). dm.pull runs on mount, on pull to refresh,
// and every 5 minutes while visible (never while hidden; App.js owns the
// pull when the app comes back to the foreground); after EVERY pull attempt and every dm.set the
// node's dmVersion is bumped (node.bumpDm), so this list, an open thread and
// the tab dot read again (dm.changed is only a hint). Answers carry a
// generation: one that started before a folder switch or a newer read is
// dropped. The first row is always "Pedidos de mensagem" with a
// dot, never a count. Previews are peer text and go through displayText.
// Props: { onOpenThread(peer) }.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { displayText } from '@varanda/rpc'
import { useNode } from '../node'
import { useNames } from '../names'
import { whoOf } from '../who'
import { relativeTime } from '../format'
import { LABELS, requestsDot, sortConversations } from '../dm'
import { previewLine } from '../dm-screen'
import { useMemberSearch } from '../useMemberSearch'
import { Btn, ErrorText, Soft, colors, errorText, useAction, useNow } from '../ui'
import { Avatar } from '../ui/Avatar'
import { Pill } from '../ui/Pill'
import { RefreshableList } from '../ui/RefreshableList'
import { EmptyState, Skeleton } from '../ui/States'
import { layout, type } from '../ui/theme'

export const PULL_EVERY_MS = 5 * 60 * 1000
const LOCKED_TEXT = 'Desbloqueie com a passkey para ler suas mensagens.'

function previewOf (row) {
  const text = displayText(previewLine(row.preview))
  const shown = row.mine === true ? 'Você: ' + text : text
  return shown
}

function Row ({ row, name, avatar, now, onPress, onDecide, pending }) {
  const time = typeof row.at === 'string' ? relativeTime(row.at, now) : ''
  return (
    <View>
      <Pressable
        accessibilityRole='button'
        accessibilityLabel={'conversa com ' + name}
        onPress={onPress}
        style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      >
        <Avatar name={name} publicKey={row.peer} size={44} picture={avatar} persist={false} />
        <View style={styles.body}>
          <View style={styles.head}>
            <Text style={styles.name} numberOfLines={1}>{name}</Text>
            {time ? <Text style={styles.meta}>{time}</Text> : null}
          </View>
          <Text style={[styles.preview, row.unread === true && styles.unreadText]} numberOfLines={2}>{previewOf(row)}</Text>
        </View>
        {row.unread === true ? <View style={styles.dot} accessibilityLabel='novidade' /> : null}
      </Pressable>
      {onDecide
        ? (
          <View style={styles.decide}>
            <Pill label={LABELS.accept} filled onPress={() => onDecide(row.peer, 'accepted')} pending={pending} />
            <Pill label={LABELS.decline} onPress={() => onDecide(row.peer, 'declined')} pending={pending} />
            <Pill label={LABELS.block} danger onPress={() => onDecide(row.peer, 'blocked')} pending={pending} />
          </View>
          )
        : null}
    </View>
  )
}

function NewMessage ({ onPick, onClose }) {
  const node = useNode()
  const ownKey = node.passkey && node.passkey.status ? node.passkey.status.publicKey : null
  const search = useMemberSearch({ request: node.request, hosted: node.hosted === true, online: node.online, ownKey })
  const hits = search.hits.filter((h) => h.author !== ownKey)
  return (
    <View style={styles.search}>
      <TextInput
        style={styles.input}
        value={search.query}
        onChangeText={(text) => search.setQuery(text)}
        placeholder='Buscar pelo nome'
        placeholderTextColor={colors.placeholder}
        autoCapitalize='none'
        autoCorrect={false}
        accessibilityLabel='buscar pessoa'
      />
      {search.phase === 'loading' && hits.length === 0 ? <Skeleton rows={2} /> : null}
      {hits.map((hit) => {
        const label = typeof hit.name === 'string' && hit.name.trim() !== '' ? displayText(hit.name) : (typeof hit.username === 'string' ? '@' + displayText(hit.username) : 'Pessoa')
        return (
          <Pressable key={hit.author} accessibilityRole='button' accessibilityLabel={'mensagem para ' + label} onPress={() => onPick(hit.author)} style={({ pressed }) => [styles.hit, pressed && styles.pressed]}>
            <Avatar name={label} publicKey={hit.author} size={36} persist={false} />
            <Text style={styles.name} numberOfLines={1}>{label}</Text>
          </Pressable>
        )
      })}
      {search.phase === 'ready' && hits.length === 0 ? <Soft>Ninguém encontrado com esse nome.</Soft> : null}
      {search.phase === 'error' ? <ErrorText>{search.error}</ErrorText> : null}
      <Pill label='cancelar' onPress={onClose} />
    </View>
  )
}

export function Mensagens ({ onOpenThread }) {
  const node = useNode()
  const insets = useSafeAreaInsets()
  const now = useNow(60000)
  const { request } = node
  const hosted = node.hosted === true
  const unlocked = !!(node.passkey && node.passkey.status && node.passkey.status.unlocked === true)
  const [folder, setFolder] = useState('inbox')
  const [rows, setRows] = useState([])
  const [next, setNext] = useState(null)
  const [requests, setRequests] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [searching, setSearching] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [pageError, setPageError] = useState('')
  const decide = useAction()
  const folderRef = useRef(folder)
  folderRef.current = folder
  const genRef = useRef(0)
  const enabled = useRef(false)
  const visible = node.visible !== false
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  const bumpDm = node.bumpDm
  const nextRef = useRef(next)
  nextRef.current = next

  const list = useCallback(async () => {
    const gen = ++genRef.current
    const asked = folderRef.current
    try {
      const r = await request('dm.list', { folder: asked })
      if (gen !== genRef.current) return
      // A refresh starts over from the first page: older pages are loaded
      // again on scroll, never left stale.
      setRows(Array.isArray(r.conversations) ? r.conversations : [])
      setNext(r.next || null)
      setPageError('')
      setRequests(r.requests === true)
      setError('')
      setLoaded(true)
    } catch (err) {
      if (gen !== genRef.current) return
      setError(errorText(err))
      setLoaded(true)
    }
  }, [request])

  // A pull that failed may still have filed messages: read again either way
  // (the bump re-reads this list, an open thread and the tab dot).
  const refresh = useCallback(async () => {
    try { await request('dm.pull', {}) } catch {}
    if (typeof bumpDm === 'function') bumpDm()
    else await list()
  }, [request, list, bumpDm])
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh

  const ready = hosted && unlocked

  useEffect(() => {
    if (!ready) return
    let alive = true
    const start = async () => {
      if (!enabled.current) {
        enabled.current = true
        // Starts the wallet top-up early; the first send calls it again.
        try { await request('dm.enable', {}) } catch { enabled.current = false }
      }
      if (alive) refreshRef.current()
    }
    start()
    return () => { alive = false }
  }, [ready, request, node.epoch])

  // Runs only while the app is visible; hiding it clears the timer.
  useEffect(() => {
    if (!ready || !visible) return
    const timer = setInterval(() => {
      if (visibleRef.current) refreshRef.current()
    }, PULL_EVERY_MS)
    return () => clearInterval(timer)
  }, [ready, visible])

  useEffect(() => {
    if (ready) list()
  }, [ready, node.dmVersion, folder, list])

  // A lost answer may still have applied: read again either way.
  const decideOn = (peer, state) => {
    decide.run(() => request('dm.set', { peer, state })).then(() => {
      if (typeof bumpDm === 'function') bumpDm()
      else list()
    })
  }

  // The old folder's rows never stay on screen beside the new folder's
  // actions, and an answer still in flight for them is dropped.
  const switchFolder = (to) => {
    genRef.current++
    folderRef.current = to
    setRows([])
    setNext(null)
    setError('')
    setPageError('')
    setLoadingMore(false)
    setLoaded(false)
    setFolder(to)
  }

  // One page at a time; a failed page waits for the footer retry or a pull.
  const loadingMoreRef = useRef(false)
  const loadMore = async () => {
    const gen = genRef.current
    const asked = folderRef.current
    const cursor = nextRef.current
    if (!cursor || loadingMoreRef.current) return
    loadingMoreRef.current = true
    setLoadingMore(true)
    setPageError('')
    try {
      const r = await request('dm.list', { folder: asked, before: cursor })
      if (gen === genRef.current && asked === folderRef.current && cursor === nextRef.current) {
        const page = Array.isArray(r.conversations) ? r.conversations : []
        setRows((cur) => {
          const have = new Set(cur.map((row) => row.peer))
          return cur.concat(page.filter((row) => row && !have.has(row.peer)))
        })
        setNext(r.next || null)
      }
    } catch (err) {
      if (gen === genRef.current) setPageError(errorText(err))
    }
    loadingMoreRef.current = false
    setLoadingMore(false)
  }

  const peers = useMemo(() => rows.map((r) => r.peer), [rows])
  const names = useNames()
  const { resolveMany } = names
  useEffect(() => {
    if (peers.length > 0) resolveMany(peers)
  }, [peers, resolveMany])
  const sorted = useMemo(() => sortConversations(rows), [rows])

  if (!hosted) return null
  if (!unlocked) {
    return <EmptyState icon='conversas' title='Mensagens bloqueadas' body={LOCKED_TEXT} />
  }

  const inRequests = folder === 'request'
  const header = (
    <View>
      {inRequests
        ? (
          <Pressable accessibilityRole='button' onPress={() => switchFolder('inbox')} style={styles.back}>
            <Text style={styles.backText}>‹ Mensagens</Text>
          </Pressable>
          )
        : (
          <Pressable
            accessibilityRole='button'
            accessibilityLabel={LABELS.requests}
            onPress={() => switchFolder('request')}
            style={({ pressed }) => [styles.row, pressed && styles.pressed]}
          >
            <Text style={[styles.name, styles.grow]}>{LABELS.requests}</Text>
            {requestsDot(requests ? [{ unread: true }] : []) ? <View style={styles.dot} accessibilityLabel='há pedidos novos' /> : null}
          </Pressable>
          )}
      {searching ? <NewMessage onPick={(peer) => { setSearching(false); onOpenThread(peer) }} onClose={() => setSearching(false)} /> : null}
      <ErrorText>{decide.error}</ErrorText>
    </View>
  )

  let empty = null
  if (!loaded) empty = <Skeleton />
  else if (error) empty = <View style={styles.pad}><ErrorText>{error}</ErrorText><Pill label='tentar de novo' onPress={() => list()} /></View>
  else empty = <EmptyState icon='conversas' title={inRequests ? LABELS.emptyRequests : LABELS.emptyInbox} />

  // The tab bar is drawn over the tab's area: stop the list and the "Nova
  // mensagem" button above it, or the button sits hidden behind the tabs.
  return (
    <View style={[styles.root, { paddingBottom: layout.tabBar + insets.bottom }]}>
      <RefreshableList
        data={sorted}
        keyExtractor={(row) => row.peer}
        renderItem={({ item }) => (
          <Row
            row={item}
            name={whoOf(names.profileOf(item.peer)).title}
            avatar={(names.profileOf(item.peer) || {}).avatar}
            now={now}
            onPress={() => onOpenThread(item.peer)}
            onDecide={inRequests ? decideOn : null}
            pending={decide.pending}
          />
        )}
        extraData={{ now, names: names.profileOf, pending: decide.pending }}
        ListHeaderComponent={header}
        ListEmptyComponent={empty}
        onRefresh={async () => {
          setRefreshing(true)
          try { await refresh() } finally { setRefreshing(false) }
        }}
        refreshing={refreshing}
        onLoadMore={next && !loadingMore && !pageError ? loadMore : undefined}
        loadingMore={loadingMore}
        loadMoreError={pageError || undefined}
        ListFooterComponent={pageError
          ? <View style={styles.pad}><ErrorText>{pageError}</ErrorText><Pill label='tentar de novo' onPress={loadMore} /></View>
          : null}
        atEnd={!next}
      />
      {!inRequests
        ? (
          <View style={styles.footer}>
            <Btn label={LABELS.newMessage} onPress={() => setSearching(true)} />
          </View>
          )
        : null}
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.line },
  pressed: { opacity: 0.6 },
  body: { flex: 1, gap: 2 },
  grow: { flex: 1 },
  head: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  name: { ...type.postName, color: colors.ink, flexShrink: 1 },
  meta: { fontSize: 12, color: colors.soft },
  preview: { fontSize: 14, color: colors.soft },
  unreadText: { color: colors.ink, fontWeight: '600' },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.accent },
  decide: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 16, paddingBottom: 10 },
  back: { paddingHorizontal: 16, paddingVertical: 12 },
  backText: { fontSize: 16, color: colors.ink },
  pad: { padding: 16, gap: 8 },
  footer: { padding: 12, borderTopWidth: 1, borderTopColor: colors.line, backgroundColor: colors.card },
  search: { padding: 16, gap: 10 },
  input: { borderWidth: 1, borderColor: colors.line, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 9, fontSize: 16, color: colors.ink, backgroundColor: colors.bg },
  hit: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6 }
})
