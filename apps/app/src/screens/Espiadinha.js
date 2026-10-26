// Espiadinha: up to three posts of each diary the person does not follow, one
// round at a time, newest first. No algorithm, no counts. Hosted web only: on
// native and varanda-serve the tab explains that and never calls peek.read.
// The rows live in memory only; nothing is persisted. Names come from the item
// (PostRow), never from the names cache or from a key.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { PEEK_LIMIT_DEFAULT, PEEK_LIMIT_MAX, displayText } from '@varanda/rpc'
import { useNode } from '../node'
import { shouldReloadOnShow } from '../paging'
import {
  PEEK_OFFLINE_MESSAGE, PEEK_RULE_TEXT, PEEK_SHORT_TEXT, PEEK_WEB_ONLY_MESSAGE,
  isLastPeekPage, isWebOnlyError, mergePage, peekKey, peekNotice, roundLabel, roundStarts, withoutAuthor
} from '../peek'
import { whoOf } from '../who'
import { Soft, colors, errorText, useBottomPad, useNow } from '../ui'
import { PostRow } from '../ui/PostRow'
import { RefreshableList } from '../ui/RefreshableList'
import { EmptyState, ErrorState, ListFooter, Skeleton } from '../ui/States'
import { type } from '../ui/theme'

const MEMORY_TEXT = 'As publicações ficam só na memória do navegador enquanto a aba está aberta.'

const noop = () => {}

export default function Espiadinha ({ active, refresh, onReply, onReport, ownKey, scrollToTop, onFollowsChanged, onToast }) {
  const node = useNode()
  const now = useNow(60000)
  const bottomPad = useBottomPad()
  const hosted = node.hosted === true && node.passkey !== null
  const [state, setState] = useState({
    items: [],
    next: null,
    atEnd: false,
    loading: false,
    loadingMore: false,
    refreshing: false,
    loadError: '',
    moreError: '',
    loadedAt: null,
    meta: { diaries: 0, skipped: 0, incomplete: false },
    unsupported: false,
    following: new Set()
  })
  const { items, atEnd, loading, loadingMore, refreshing, loadError, moreError, loadedAt, meta, unsupported, following } = state
  const [rule, setRule] = useState(false)
  const stateRef = useRef(state)
  // Only the latest read may commit; the ref also blocks duplicate end reaches.
  const seqRef = useRef(0)
  const commit = useCallback((patch) => {
    stateRef.current = { ...stateRef.current, ...patch }
    setState(stateRef.current)
  }, [])
  const { request } = node

  // The node serves one peek at a time ('espiadinha já em andamento'): a
  // refresh, a follow or a reselect while a page is loading waits for the
  // read in flight instead of being refused (the superseded result is then
  // dropped by seqRef).
  const inflightRef = useRef(null)
  const peek = useCallback(async (params) => {
    while (inflightRef.current !== null) await inflightRef.current
    const p = request('peek.read', params)
    const settled = p.then(noop, noop)
    inflightRef.current = settled
    settled.then(() => { if (inflightRef.current === settled) inflightRef.current = null })
    return p
  }, [request])

  const loadFirst = useCallback(async () => {
    if (!hosted || stateRef.current.unsupported) return
    const mine = ++seqRef.current
    commit({
      loading: stateRef.current.loadedAt === null,
      refreshing: stateRef.current.loadedAt !== null,
      loadingMore: false,
      loadError: '',
      moreError: ''
    })
    try {
      const page = await peek({ limit: PEEK_LIMIT_DEFAULT })
      if (mine !== seqRef.current) return
      commit({
        items: mergePage([], page.items).items,
        next: page.next,
        atEnd: isLastPeekPage(page),
        loadedAt: Date.now(),
        meta: { diaries: page.diaries, skipped: page.skipped, incomplete: page.incomplete === true },
        loading: false,
        refreshing: false
      })
    } catch (err) {
      if (mine !== seqRef.current) return
      // An old node bundle or a native / serve node: never asked again.
      if (isWebOnlyError(err)) commit({ unsupported: true, loading: false, refreshing: false })
      else commit({ loading: false, refreshing: false, loadError: errorText(err) })
    }
  }, [hosted, peek, commit])

  const loadMore = useCallback(async () => {
    const current = stateRef.current
    if (!active || !hosted || current.loading || current.refreshing || current.loadingMore || current.atEnd || current.next === null) return
    const mine = ++seqRef.current
    const after = current.next
    commit({ loadingMore: true, moreError: '' })
    try {
      const page = await peek({ limit: PEEK_LIMIT_MAX, after })
      if (mine !== seqRef.current) return
      // A cursor that did not move ends the list (compared by value).
      const stuck = page.next !== null && page.next.round === after.round && page.next.at === after.at &&
        page.next.author === after.author && page.next.seq === after.seq
      // Later pages may fetch diaries the first page did not reach: keep the
      // newest counts and never drop an incomplete warning.
      const meta = stateRef.current.meta
      commit({
        items: mergePage(stateRef.current.items, page.items).items,
        next: page.next,
        atEnd: isLastPeekPage(page) || stuck,
        meta: { diaries: page.diaries, skipped: page.skipped, incomplete: meta.incomplete || page.incomplete === true },
        loadingMore: false
      })
    } catch (err) {
      if (mine === seqRef.current) commit({ loadingMore: false, moreError: errorText(err) })
    }
  }, [active, hosted, peek, commit])

  // Reload rules as A Rua: first show, a reselect after 60 s, a refresh bump.
  const previous = useRef({ active: false, refresh, scrollToTop })
  useEffect(() => {
    const prev = previous.current
    const shown = active && !prev.active
    const reselected = scrollToTop !== prev.scrollToTop
    const changed = refresh !== prev.refresh
    previous.current = { active, refresh: active ? refresh : prev.refresh, scrollToTop }
    if (!active) return
    const current = stateRef.current
    const stale = shouldReloadOnShow({ loadedAt: current.loadedAt, now: Date.now(), fresh: false })
    if (changed || ((shown || reselected) && stale && !current.loading && !current.refreshing)) loadFirst()
  }, [active, refresh, scrollToTop, loadFirst])

  useEffect(() => () => {
    seqRef.current += 1
    previous.current.active = false
    stateRef.current = { ...stateRef.current, loading: false, loadingMore: false, refreshing: false }
  }, [])

  // 'seguir': the author's rows leave the list once the follow is applied. An
  // uncertain failure (timeout) is reported, never retried automatically.
  const follow = async (author, name, username) => {
    if (stateRef.current.following.has(author)) return
    commit({ following: new Set(stateRef.current.following).add(author) })
    try {
      await request('follow.add', { key: author })
      commit({ items: withoutAuthor(stateRef.current.items, author) })
      const named = name || username ? ' ' + displayText(whoOf({ name, username }).title) : ''
      if (typeof onToast === 'function') onToast('seguindo' + named)
      if (typeof onFollowsChanged === 'function') onFollowsChanged()
    } catch (err) {
      if (typeof onToast === 'function') onToast(errorText(err))
    } finally {
      const rest = new Set(stateRef.current.following)
      rest.delete(author)
      commit({ following: rest })
    }
  }

  const notice = peekNotice({ supported: !unsupported, hosted, online: node.online, loadedAt })
  const starts = useMemo(() => roundStarts(items), [items])

  const header = (
    <View style={styles.header}>
      <Soft>{PEEK_SHORT_TEXT}</Soft>
      <Pressable
        accessibilityRole='button'
        accessibilityLabel='como funciona'
        accessibilityState={{ expanded: rule }}
        onPress={() => setRule((v) => !v)}
        hitSlop={6}
      >
        <Text style={styles.toggle}>{rule ? 'esconder' : 'como funciona'}</Text>
      </Pressable>
      {rule ? <Soft>{PEEK_RULE_TEXT}</Soft> : null}
      <Soft>{MEMORY_TEXT}</Soft>
    </View>
  )

  const skipped = meta.skipped > 0
    ? String(meta.skipped) + (meta.skipped === 1 ? ' diário não aparece' : ' diários não aparecem') + ' (sem certificado válido, bloqueados pela associação ou sem resposta a tempo)'
    : null
  const footer = (
    <View>
      <ListFooter
        loading={loadingMore}
        atEnd={loadedAt !== null && atEnd && items.length > 0}
        endText='Isso é tudo por enquanto.'
        error={moreError}
        onRetry={loadMore}
        pending={loadingMore || refreshing}
      />
      {skipped || meta.incomplete
        ? (
          <View style={styles.footer}>
            {skipped ? <Soft>{skipped}</Soft> : null}
            {meta.incomplete ? <Soft>A lista pode estar incompleta; puxe para atualizar.</Soft> : null}
          </View>
          )
        : null}
    </View>
  )

  let empty
  if (notice === 'web-only') {
    empty = <EmptyState icon='olho' title='Só na versão web' body={PEEK_WEB_ONLY_MESSAGE} />
  } else if (notice === 'offline') {
    empty = <EmptyState icon='olho' title='Sem conexão' body={PEEK_OFFLINE_MESSAGE} actionLabel='tentar de novo' onAction={loadFirst} />
  } else if (loadError) {
    empty = <ErrorState message={loadError} onRetry={loadFirst} pending={loading || refreshing} />
  } else if (loadedAt === null) {
    empty = <Skeleton />
  } else if (meta.diaries === 0) {
    empty = <EmptyState icon='olho' title='Ninguém para espiar ainda' body='Quando mais pessoas publicarem, as publicações delas aparecem aqui.' />
  } else {
    empty = <EmptyState icon='olho' title='Ainda não chegou nada' body='Quando houver publicações de quem você não segue, aparecem aqui.' />
  }

  const reportable = (item) => hosted && typeof onReport === 'function' && typeof ownKey === 'string' && item.author !== ownKey
  const renderItem = ({ item, index }) => {
    const label = starts.has(index) && index > 0 ? roundLabel(item.round) : null
    return (
      <View>
        {label ? <View style={styles.separator}><Soft>{label}</Soft></View> : null}
        <PostRow
          author={item.author}
          name={item.name}
          username={item.username}
          at={item.at}
          text={item.text}
          media={item.media || null}
          replyToName={null}
          now={now}
          onReply={typeof onReply === 'function'
            ? () => onReply({ ref: item.author + ':' + item.seq, name: item.name, username: item.username, text: item.text })
            : undefined}
          onFollow={() => follow(item.author, item.name, item.username)}
          followPending={following.has(item.author)}
          onReport={reportable(item)
            ? () => onReport({ author: item.author, name: item.name, username: item.username, seq: item.seq, text: item.text })
            : undefined}
        />
      </View>
    )
  }

  const shownItems = notice === null ? items : []
  return (
    <RefreshableList
      data={shownItems}
      keyExtractor={peekKey}
      renderItem={renderItem}
      extraData={{ now, following, starts }}
      ListHeaderComponent={notice === null && items.length > 0 && loadError ? <ErrorState message={loadError} onRetry={loadFirst} pending={refreshing} /> : (notice === null ? header : null)}
      ListEmptyComponent={empty}
      ListFooterComponent={notice === null ? footer : null}
      contentContainerStyle={{ paddingBottom: bottomPad }}
      onRefresh={hosted && !unsupported ? loadFirst : undefined}
      refreshing={refreshing}
      onLoadMore={active && hosted && !moreError ? loadMore : undefined}
      loadingMore={loadingMore}
      loadMoreError={!!moreError}
      atEnd={atEnd}
      scrollToTopSignal={scrollToTop}
    />
  )
}

const styles = StyleSheet.create({
  toggle: { ...type.counter, color: colors.accent },
  header: { padding: 16, gap: 8 },
  footer: { padding: 16, gap: 8 },
  separator: { paddingHorizontal: 16, paddingVertical: 10, borderTopWidth: 1, borderTopColor: colors.line }
})
