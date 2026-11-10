// Mensagens: the "Pedidos de mensagem" folder (docs/rpc.md 5.77, 5.79), a
// stacked screen (nav 'pedidos') pushed from the pinned row of Conversas. It
// lists the request folder in the same compact rows as the inbox; a row opens
// the 'mensagem' thread, which offers Aceitar / Recusar / Bloquear for a
// request. Every dm.set and every pull bumps the node's dmVersion
// (node.bumpDm), so this folder, the inbox and the tab dot read again.
// Answers carry a generation: one that started before a newer read is
// dropped. Acting as a page (actingAs.js), the folder is the page's, kept on
// this device (useDmRequest, docs/rpc.md 5.114); PageInboxNote reads the
// page's keys ('dm-box-read'), stores a share, and lets the owner activate
// the page's private Conversas. Props: { onOpenThread(peer), onBack }.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useNode } from '../node'
import { useNames } from '../names'
import { LABELS, sortConversations } from '../dm'
import { requestsRow } from '../conversas'
import { PAGE_DM_CUSTODY, pageDmClient, pageInboxTitle, previewLine } from '../dm-screen'
import { pagesDm, pagesDmActivate, pagesDmAdopt, pagesDmBoxRead, pagesDmLegacyFinish, pagesDmLegacyPeers } from '../pages'
import { PAGE_DM_ACTIVATE_TEXT, PAGE_DM_ACTIVATE_TITLE, PAGE_DM_ASK_OWNER, PAGE_DM_CONFLICT, PAGE_DM_ROTATE_TEXT, PAGE_DM_ROTATE_TITLE, PAGE_DM_ROTATING, PAGE_DM_BLOCKS_FAILED, PAGE_KEYS_IDLE, blockPeersLine, legacyBundleOf, legacyCardLabel, pageDmState, pageKeyText, pageKeysOf } from '../pageSecrets'
import { pagesOn } from '../pageGate'
import { Btn, ErrorText, Notice, Soft, errorText, useAction, useBottomPad, useNow } from '../ui'
import { ConversationRow } from '../ui/ConversationRow'
import { Pill } from '../ui/Pill'
import { RefreshableList } from '../ui/RefreshableList'
import { EmptyState, Skeleton } from '../ui/States'
import { space, type } from '../ui/theme'
import { TopBar } from '../ui/TopBar'
import { label as actingLabel } from '../actingAs'
import { useStyles } from '../ui/ThemeProvider'
import { atName } from '../who'
import { shortKey } from '../format'
import { memberKeyOf, useActing } from './Conversa'

export const LOCKED_TEXT = 'Desbloqueie com a passkey para ler suas mensagens.'

// The request function for private conversations: the node's own, or the
// page's folder on this device while acting as a page. Shared with Conversas
// so the inbox and this folder always read the same identity.
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
    const sign = async (digest) => pagesDm(nodeRef.current, { member: await memberKeyOf(request, nodeRef.current), page: pageKey, action: 'dm-sign', op: { digest } })
    return pageDmClient({ request, sign, page: pageKey })
  }, [request, pageKey])
  return { dm, pageKey }
}

// The page's keys on this device: reads 'dm-box-read' once per page and
// unlock, stores the own share when there is one, and gives the owner the
// activation. Nothing here repeats a write by itself: an uncertain 'dm-box'
// keeps its retry for 'Tentar de novo', a 'conflito' reads again and waits.
// The inbox's own refreshes (a pull, pull-to-refresh: node.dmVersion) read
// the keys again, at most once per KEYS_REREAD_MS, so a share or a rotation
// made elsewhere is adopted while the screen stays open; a share already
// adopted (same gen and box) is not stored again.
const KEYS_REREAD_MS = 15000
const adopted = new Map()

function usePageKeys (pageKey) {
  const node = useNode()
  const unlocked = !!(node.passkey && node.passkey.status && node.passkey.status.unlocked === true)
  const nodeRef = useRef(node)
  nodeRef.current = node
  // Every state names its page: pageKeysOf drops one read for another page.
  const [stored, setState] = useState(PAGE_KEYS_IDLE)
  const state = pageKeysOf(stored, pageKey)
  const pageRef = useRef(pageKey)
  pageRef.current = pageKey
  const [holdOf, setHoldOf] = useState(null)
  const [blocksOf, setBlocksOf] = useState(null) // the failed legacy step: its retry goes on from there
  const hold = holdOf && holdOf.page === pageKey ? holdOf.err : null
  const blocksHold = blocksOf && blocksOf.page === pageKey ? blocksOf.err : null
  // A late answer for a page no longer shown is dropped.
  const setHold = (err, page = pageRef.current) => { if (page === pageRef.current) setHoldOf(err ? { page, err } : null) }
  const setBlocksHold = (err, page = pageRef.current) => { if (page === pageRef.current) setBlocksOf(err ? { page, err } : null) }
  const act = useAction()
  const blocksAct = useAction()
  const gen = useRef(0)
  const lastRead = useRef(0)

  const read = useCallback(async () => {
    const g = ++gen.current
    const n = nodeRef.current
    lastRead.current = Date.now()
    setState((s) => (s.page === pageKey && s.phase !== 'idle' ? s : { ...PAGE_KEYS_IDLE, page: pageKey, phase: 'reading' }))
    try {
      const member = await memberKeyOf(n.request, n)
      const roster = await n.request('page.read', { key: pageKey })
      const status = await pagesDmBoxRead(n, { member, page: pageKey })
      const owner = !!roster && roster.isOwner === true
      const kind = pageDmState(status, { owner })
      const held = kind === 'share' ? status.share.gen + ':' + status.box : null
      if (held !== null && adopted.get(pageKey) !== held) {
        try {
          await pagesDmAdopt(n, { page: pageKey, status })
        } catch (err) {
          if (g === gen.current) setState({ ...PAGE_KEYS_IDLE, page: pageKey, phase: 'failed', status, owner, roster, member, error: pageKeyText(err) || errorText(err) })
          return
        }
        adopted.set(pageKey, held)
        if (typeof n.bumpDm === 'function') n.bumpDm()
      }
      // The old blocks still to re-apply live only in the node's sealed list.
      const peers = kind === 'share' ? await pagesDmLegacyPeers(n, { page: pageKey }) : []
      if (g === gen.current) setState({ page: pageKey, phase: kind, status, owner, roster, member, error: '', pending: peers.length, peers })
    } catch (err) {
      if (g === gen.current) setState({ ...PAGE_KEYS_IDLE, page: pageKey, phase: 'failed', error: pageKeyText(err) || errorText(err) })
    }
  }, [pageKey])

  useEffect(() => {
    setHoldOf(null)
    setBlocksOf(null)
    gen.current++
    setState({ ...PAGE_KEYS_IDLE, page: pageKey })
    if (pageKey !== null && unlocked) {
      // A lock may have wiped the held secrets: the first read adopts again.
      adopted.delete(pageKey)
      read()
    } else {
      gen.current++
    }
  }, [pageKey, unlocked, read])

  const dmVersion = node.dmVersion
  const seenVersion = useRef(dmVersion)
  useEffect(() => {
    if (seenVersion.current === dmVersion) return
    seenVersion.current = dmVersion
    if (pageKey === null || !unlocked || Date.now() - lastRead.current < KEYS_REREAD_MS) return
    read()
  }, [dmVersion, pageKey, unlocked, read])

  const finish = (r) => {
    if (r.ok) {
      setHold(null)
      const n = nodeRef.current
      if (typeof n.bumpDm === 'function') n.bumpDm()
    }
    return read()
  }

  // The activation, or the owner's new gen after a transfer ('rotate'):
  // both seal for gen + 1 with expectedGen the gen this read saw.
  const activate = async () => {
    const { status, roster, member, page } = state
    if (!status || !roster || !member || page !== pageKey || (state.phase !== 'activate' && state.phase !== 'rotate')) return
    let held = null
    const r = await act.run(async () => {
      try {
        const out = await pagesDmActivate(nodeRef.current, { member, page, status, roster })
        setBlocksHold(out && out.blocksError ? out.blocksError : null, page)
        return out
      } catch (err) {
        if (err && err.uncertain === true && typeof err.retry === 'function') held = err
        if (err && err.uncertain !== true && err.code === 'conflito') err.message = PAGE_DM_CONFLICT
        throw err
      }
    })
    setHold(held, page)
    if (page === pageRef.current) await finish(r)
  }

  const retry = async () => {
    const held = hold
    const page = pageKey
    if (!held) return
    let again = null
    const r = await act.run(async () => {
      try {
        const out = await held.retry()
        // A retried activation ends in the same legacy steps as the first.
        setBlocksHold(out && out.blocksError ? out.blocksError : null, page)
        return out
      } catch (err) {
        if (err && err.uncertain === true && typeof err.retry === 'function') again = err
        throw err
      }
    })
    setHold(again, page)
    if (page === pageRef.current) await finish(r)
  }

  // Only from the owner's tap: the inbox card (an interrupted import, old
  // blocks still pending), or 'Tentar de novo' after a failure (which goes
  // on from the failed step).
  const reapply = async () => {
    const { status, member, page } = state
    if (!status || !member || page !== pageKey) return
    const held = blocksHold
    let failed = null
    const r = await blocksAct.run(async () => {
      try {
        if (held && typeof held.retry === 'function') return await held.retry()
        return await pagesDmLegacyFinish(nodeRef.current, { member, page, bundle: legacyBundleOf(status) })
      } catch (err) {
        failed = err
        throw err
      }
    })
    setBlocksHold(r.ok ? null : failed, page)
    if (r.ok && page === pageRef.current) {
      const n = nodeRef.current
      if (typeof n.bumpDm === 'function') n.bumpDm()
      await read()
    }
  }

  const legacyLabel = pageKey !== null && state.phase === 'share' ? legacyCardLabel({ bundle: legacyBundleOf(state.status), pending: state.pending }) : null

  return { ...state, act, hold, activate, retry, read, blocksAct, blocksHold, legacyLabel, reapply }
}

// The page's inbox title, custody sentence and key state, above its lists.
export function PageInboxNote ({ pageKey }) {
  const styles = useStyles(makeStyles)
  const keys = usePageKeys(pageKey)
  const { activate, retry, read, reapply } = keys
  const { profileOf, resolveMany } = useNames()
  const blockPeers = keys.peers
  useEffect(() => {
    if (blockPeers.length > 0) resolveMany(blockPeers)
  }, [blockPeers, resolveMany])
  if (pageKey === null) return null
  const held = keys.blocksHold
  // The peers an old block re-apply blocks, named before the owner taps.
  const peersLine = !held && legacyBundleOf(keys.status) === null ? blockPeersLine(keys.peers, (k) => atName((profileOf(k) || {}).username) || shortKey(k)) : ''
  const blocks = keys.phase !== 'activate' && keys.phase !== 'rotate' && (held || keys.legacyLabel !== null)
    ? (
      <View style={styles.card}>
        {held
          ? (
            <>
              <Notice>{held.step === 'blocks' ? PAGE_DM_BLOCKS_FAILED : (pageKeyText(held) || errorText(held))}</Notice>
              <Btn label='Tentar de novo' onPress={reapply} pending={keys.blocksAct.pending} />
            </>
            )
          : (
            <>
              {peersLine ? <Soft>{peersLine}</Soft> : null}
              <Btn label={keys.legacyLabel} onPress={reapply} pending={keys.blocksAct.pending} />
            </>
            )}
      </View>
      )
    : null
  let body = null
  if (keys.phase === 'activate' || keys.phase === 'rotate') {
    const rotate = keys.phase === 'rotate'
    body = (
      <View style={styles.card}>
        <Text style={styles.name}>{rotate ? PAGE_DM_ROTATE_TITLE : PAGE_DM_ACTIVATE_TITLE}</Text>
        <Soft>{rotate ? PAGE_DM_ROTATE_TEXT : PAGE_DM_ACTIVATE_TEXT}</Soft>
        <ErrorText>{keys.act.error}</ErrorText>
        {keys.hold
          ? <Btn label='Tentar de novo' onPress={retry} pending={keys.act.pending} />
          : <Btn label={rotate ? 'Gerar chave' : 'Ativar'} onPress={activate} pending={keys.act.pending} />}
      </View>
    )
  } else if (keys.phase === 'ask-owner') {
    body = <Notice>{PAGE_DM_ASK_OWNER}</Notice>
  } else if (keys.phase === 'rotating' || keys.phase === 'failed') {
    body = (
      <View style={styles.card}>
        <Notice>{keys.phase === 'rotating' ? PAGE_DM_ROTATING : keys.error}</Notice>
        {/* A held activation resends its exact request, also mid-rotation. */}
        {keys.hold
          ? <Btn label='Tentar de novo' onPress={retry} pending={keys.act.pending} />
          : <Pill label='tentar de novo' onPress={read} />}
      </View>
    )
  }
  return (
    <View style={styles.pad}>
      <Text style={styles.name}>{pageInboxTitle(actingLabel())}</Text>
      <Soft>{PAGE_DM_CUSTODY}</Soft>
      {body}
      {blocks}
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
  pad: { padding: space.lg, gap: space.sm },
  card: { gap: space.sm, paddingTop: space.sm }
})
