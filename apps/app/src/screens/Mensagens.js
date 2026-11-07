// Mensagens: the "Pedidos de mensagem" folder (docs/rpc.md 5.77, 5.79), a
// stacked screen (nav 'pedidos') pushed from the pinned row of Conversas. It
// lists the request folder in the same compact rows as the inbox; a row opens
// the 'mensagem' thread, which offers Aceitar / Recusar / Bloquear for a
// request. Every dm.set and every pull bumps the node's dmVersion
// (node.bumpDm), so this folder, the inbox and the tab dot read again.
// Answers carry a generation: one that started before a newer read is
// dropped. Acting as a page (actingAs.js), the folder comes from the page's
// dm-list (useDmRequest). Props: { onOpenThread(peer), onBack }.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useNode } from '../node'
import { useNames } from '../names'
import { LABELS, sortConversations } from '../dm'
import { requestsRow } from '../conversas'
import { PAGE_DM_CUSTODY, pageDmRequest, pageInboxTitle, previewLine } from '../dm-screen'
import { pagesDm } from '../pages'
import { pagesOn } from '../pageGate'
import { ErrorText, Soft, errorText, useBottomPad, useNow } from '../ui'
import { ConversationRow } from '../ui/ConversationRow'
import { Pill } from '../ui/Pill'
import { RefreshableList } from '../ui/RefreshableList'
import { EmptyState, Skeleton } from '../ui/States'
import { space, type } from '../ui/theme'
import { TopBar } from '../ui/TopBar'
import { label as actingLabel } from '../actingAs'
import { useStyles } from '../ui/ThemeProvider'
import { memberKeyOf, useActing } from './Conversa'

export const LOCKED_TEXT = 'Desbloqueie com a passkey para ler suas mensagens.'

// The request function for private conversations: the node's own, or the
// page's dm-list while acting as a page. Shared with Conversas so the inbox
// and this folder always read the same identity.
export function useDmRequest () {
  const node = useNode()
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
  return { dm, pageKey }
}

// The page's inbox title and custody sentence, above its lists.
export function PageInboxNote ({ pageKey }) {
  const styles = useStyles(makeStyles)
  if (pageKey === null) return null
  return (
    <View style={styles.pad}>
      <Text style={styles.name}>{pageInboxTitle(actingLabel())}</Text>
      <Soft>{PAGE_DM_CUSTODY}</Soft>
    </View>
  )
}

export function Mensagens ({ onOpenThread, onBack }) {
  const styles = useStyles(makeStyles)
  const node = useNode()
  const bottomPad = useBottomPad()
  const now = useNow(60000)
  const hosted = node.hosted === true
  const { dm, pageKey } = useDmRequest()
  const unlocked = !!(node.passkey && node.passkey.status && node.passkey.status.unlocked === true)
  const [rows, setRows] = useState([])
  const [next, setNext] = useState(null)
  const [loaded, setLoaded] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [loadingMore, setLoadingMore] = useState(false)
  const [pageError, setPageError] = useState('')
  const genRef = useRef(0)
  const bumpDm = node.bumpDm
  const nextRef = useRef(next)
  nextRef.current = next

  const list = useCallback(async () => {
    const gen = ++genRef.current
    try {
      const r = await dm('dm.list', { folder: 'request' })
      if (gen !== genRef.current) return
      // A refresh starts over from the first page: older pages are loaded
      // again on scroll, never left stale.
      setRows(Array.isArray(r.conversations) ? r.conversations : [])
      setNext(r.next || null)
      setPageError('')
      setError('')
      setLoaded(true)
    } catch (err) {
      if (gen !== genRef.current) return
      setError(errorText(err))
      setLoaded(true)
    }
  }, [dm])

  // A pull that failed may still have filed messages: read again either way.
  const refresh = useCallback(async () => {
    try { await dm('dm.pull', {}) } catch {}
    if (typeof bumpDm === 'function') bumpDm()
    else await list()
  }, [dm, list, bumpDm])

  const ready = hosted && unlocked

  // Another acting identity is another folder: the old rows never stay.
  const seenPage = useRef(pageKey)
  useEffect(() => {
    if (seenPage.current === pageKey) return
    seenPage.current = pageKey
    genRef.current++
    setRows([])
    setNext(null)
    setError('')
    setPageError('')
    setLoaded(false)
  }, [pageKey])

  useEffect(() => {
    if (ready) list()
  }, [ready, node.dmVersion, list])

  // One page at a time; a failed page waits for the footer retry or a pull.
  const loadingMoreRef = useRef(false)
  const loadMore = async () => {
    const gen = genRef.current
    const cursor = nextRef.current
    if (!cursor || loadingMoreRef.current) return
    loadingMoreRef.current = true
    setLoadingMore(true)
    setPageError('')
    try {
      const r = await dm('dm.list', { folder: 'request', before: cursor })
      if (gen === genRef.current && cursor === nextRef.current) {
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

  const bar = <TopBar title={requestsRow(null).title} onBack={onBack} />
  if (!hosted) return <View style={styles.root}>{bar}</View>

  const header = (
    <View>
      <PageInboxNote pageKey={pageKey} />
      {unlocked ? <View style={styles.note}><Soft>{LABELS.requestNote}</Soft></View> : null}
    </View>
  )

  let empty = null
  if (!unlocked) empty = <EmptyState icon='conversas' title='Mensagens bloqueadas' body={LOCKED_TEXT} />
  else if (!loaded) empty = <Skeleton />
  else if (error) empty = <View style={styles.pad}><ErrorText>{error}</ErrorText><Pill label='tentar de novo' onPress={() => list()} /></View>
  else empty = <EmptyState icon='conversas' title={LABELS.emptyRequests} />

  return (
    <View style={styles.root}>
      {bar}
      <RefreshableList
        data={unlocked ? sorted : []}
        keyExtractor={(row) => row.peer}
        renderItem={({ item }) => (
          <ConversationRow
            item={{ kind: 'dm', key: item.peer, preview: previewLine(item.preview), mine: item.mine === true, at: item.at, unread: item.unread === true }}
            now={now}
            onPress={() => onOpenThread(item.peer)}
          />
        )}
        extraData={{ now, names: names.profileOf }}
        ListHeaderComponent={header}
        ListEmptyComponent={empty}
        contentContainerStyle={{ paddingBottom: bottomPad }}
        onRefresh={async () => {
          if (!ready) return
          setRefreshing(true)
          try { await refresh() } finally { setRefreshing(false) }
        }}
        refreshing={refreshing}
        onLoadMore={ready && next && !loadingMore && !pageError ? loadMore : undefined}
        loadingMore={loadingMore}
        loadMoreError={pageError || undefined}
        ListFooterComponent={pageError
          ? <View style={styles.pad}><ErrorText>{pageError}</ErrorText><Pill label='tentar de novo' onPress={loadMore} /></View>
          : null}
        atEnd={!next}
      />
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  name: { ...type.postName, color: colors.ink, flexShrink: 1 },
  note: { paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: space.xs },
  pad: { padding: space.lg, gap: space.sm }
})
