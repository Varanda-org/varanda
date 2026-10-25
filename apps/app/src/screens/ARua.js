// A Rua: a newest-first timeline with backward cursors and explicit refreshes.
// Fresh sync hints offer new posts without moving the person's reading position.
// PostRow escapes raw peer strings and never derives display names from keys.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { FEED_LIMIT_DEFAULT, FEED_LIMIT_MAX } from '@varanda/rpc'
import { useNode } from '../node'
import { useNames } from '../names'
import { cursorMoved, cursorOf, feedKey, isLastFeedPage, mergeOlder, resetWith, shouldReloadOnShow } from '../paging'
import { freshKeys, hasFresh } from '../syncSignals'
import { replyNameOf } from '../who'
import { Soft, errorText, useBottomPad, useNow } from '../ui'
import { PostRow } from '../ui/PostRow'
import { RefreshableList } from '../ui/RefreshableList'
import { EmptyState, ErrorState, ListFooter, Skeleton } from '../ui/States'

// Feed skip reasons that come from the association's signed blocklist.
const MODERATION_REASONS = ['blocked', 'revoked-issuer']

export default function ARua ({ active, refresh, onReply, onReport, ownKey, followCount, scrollToTop, onFollowSomeone }) {
  const node = useNode()
  const names = useNames()
  const now = useNow(60000)
  const bottomPad = useBottomPad()
  const [feed, setFeed] = useState({
    items: [],
    cursor: null,
    atEnd: false,
    loading: false,
    loadingMore: false,
    refreshing: false,
    loadError: '',
    moreError: '',
    loadedAt: null,
    meta: { skipped: [], skippedTruncated: 0, future: [], futureTruncated: 0 }
  })
  const { items, atEnd, loading, loadingMore, refreshing, loadError, moreError, loadedAt, meta } = feed
  const feedRef = useRef(feed)
  const listRef = useRef(null)
  const signalsRef = useRef(node.signals)
  signalsRef.current = node.signals
  // Only the latest read may commit; the ref also blocks duplicate end reaches
  // before React renders. Rows and their loading flags always change together.
  const seqRef = useRef(0)
  const commit = useCallback((patch) => {
    feedRef.current = { ...feedRef.current, ...patch }
    setFeed(feedRef.current)
  }, [])

  const { request, ackFresh } = node
  const { learnMany, resolveMany } = names
  const learnPage = useCallback((items) => {
    learnMany(items.map((i) => [i.author, { name: i.name, username: i.username }]))
    resolveMany(items.filter((i) => i.replyTo).map((i) => i.replyTo.author))
  }, [learnMany, resolveMany])

  const ownSeenRef = useRef(null)
  const loadNewest = useCallback(async () => {
    const mine = ++seqRef.current
    const seen = signalsRef.current
    ownSeenRef.current = seen && typeof seen.ownLength === 'number' ? seen.ownLength : null
    commit({
      loading: feedRef.current.loadedAt === null,
      refreshing: feedRef.current.loadedAt !== null,
      loadingMore: false,
      loadError: '',
      moreError: ''
    })
    try {
      const page = await request('feed.read', { limit: FEED_LIMIT_DEFAULT })
      if (mine !== seqRef.current) return
      const { skipped, skippedTruncated, future, futureTruncated } = page
      commit({
        items: resetWith(page.items),
        cursor: cursorOf(page.items),
        atEnd: isLastFeedPage(page, FEED_LIMIT_DEFAULT),
        loadedAt: Date.now(),
        meta: { skipped, skippedTruncated, future, futureTruncated },
        loading: false,
        refreshing: false
      })
      learnPage(page.items)
      // Leave growth that arrived during this read available for the next pill.
      ackFresh(freshKeys(seen).filter((key) => key !== 'own' && seen.fresh[key] === signalsRef.current.fresh[key]))
    } catch (err) {
      if (mine === seqRef.current) commit({ loading: false, refreshing: false, loadError: errorText(err) })
    }
  }, [request, ackFresh, commit, learnPage])

  const loadOlder = useCallback(async () => {
    const current = feedRef.current
    if (!active || current.loading || current.refreshing || current.loadingMore || current.atEnd || current.cursor === null) return
    const mine = ++seqRef.current
    const before = current.cursor
    commit({ loadingMore: true, moreError: '' })
    try {
      const page = await request('feed.read', { limit: FEED_LIMIT_MAX, before })
      if (mine !== seqRef.current) return
      const cursor = cursorOf(page.items)
      commit({
        items: mergeOlder(feedRef.current.items, page.items).items,
        cursor,
        atEnd: isLastFeedPage(page, FEED_LIMIT_MAX) || !cursorMoved(before, cursor),
        loadingMore: false
      })
      learnPage(page.items)
    } catch (err) {
      if (mine === seqRef.current) commit({ loadingMore: false, moreError: errorText(err) })
    }
  }, [active, request, commit, learnPage])

  // Own posts published on another device: A Rua compares the own diary's
  // synced length (signals.ownLength, never acknowledged, unlike fresh.own,
  // which Diário clears) with the length it last loaded; the first length
  // seen after a load is the baseline.
  const ownLength = node.signals && typeof node.signals.ownLength === 'number' ? node.signals.ownLength : null
  useEffect(() => {
    if (ownSeenRef.current === null && ownLength !== null) ownSeenRef.current = ownLength
  }, [ownLength])
  const ownNew = ownLength !== null && ownSeenRef.current !== null && ownLength > ownSeenRef.current
  const fresh = hasFresh(node.signals, { except: ownKey }) || ownNew
  const previous = useRef({ active: false, refresh, scrollToTop })
  useEffect(() => {
    const prev = previous.current
    const shown = active && !prev.active
    const reselected = scrollToTop !== prev.scrollToTop
    const changed = refresh !== prev.refresh
    // A publish while hidden invalidates the next show even inside 60 seconds.
    previous.current = { active, refresh: active ? refresh : prev.refresh, scrollToTop }
    if (!active) return
    const current = feedRef.current
    const stale = shouldReloadOnShow({ loadedAt: current.loadedAt, now: Date.now(), fresh })
    if (changed || ((shown || reselected) && stale && !current.loading && !current.refreshing)) loadNewest()
  }, [active, refresh, scrollToTop, fresh, loadNewest])

  useEffect(() => () => {
    seqRef.current += 1
    // Effect replay may show the mounted screen again after cancelling a read.
    previous.current.active = false
    feedRef.current = { ...feedRef.current, loading: false, loadingMore: false, refreshing: false }
  }, [])

  const showNewItems = () => {
    if (listRef.current) listRef.current.scrollToOffset({ offset: 0, animated: true })
    if (!feedRef.current.loading && !feedRef.current.refreshing) return loadNewest()
  }

  // Only the association's blocklist gets a sentence (plain words); other
  // skipped or future-dated entries are not shown to people.
  const blocked = meta.skipped.filter((s) => MODERATION_REASONS.includes(s.reason)).length
  const footer = (
    <View>
      <ListFooter
        loading={loadingMore}
        atEnd={loadedAt !== null && atEnd && items.length > 0}
        endText='Isso é tudo por enquanto.'
        error={moreError}
        onRetry={loadOlder}
        pending={loadingMore || refreshing}
      />
      {blocked > 0
        ? (
          <View style={styles.footer}>
            <Soft>{blocked === 1 ? 'Uma pessoa que você segue não aparece aqui.' : String(blocked) + ' pessoas que você segue não aparecem aqui.'}</Soft>
          </View>
          )
        : null}
    </View>
  )

  let empty
  if (loadError) empty = <ErrorState message={loadError} onRetry={loadNewest} pending={loading || refreshing} />
  else if (loadedAt === null) empty = <Skeleton />
  else if (followCount === 0) {
    empty = (
      <EmptyState
        icon='gente'
        title='A Rua está vazia'
        body='Siga pessoas para ver as publicações delas aqui.'
        actionLabel='Seguir alguém'
        onAction={onFollowSomeone}
      />
    )
  } else {
    empty = (
      <EmptyState
        icon='gente'
        title='Ainda não chegou nada'
        body='Quando as pessoas que você segue publicarem, aparece aqui.'
      />
    )
  }

  // Reply names re-render when the cache changes; relative dates on each tick.
  const extra = useMemo(() => ({ profileOf: names.profileOf, now }), [names.profileOf, now])
  // Until the own key is known, no post can safely offer a report action.
  const reportable = (item) => typeof onReport === 'function' && typeof ownKey === 'string' && item.author !== ownKey
  const renderItem = ({ item }) => (
    <PostRow
      author={item.author}
      name={item.name}
      username={item.username}
      at={item.at}
      text={item.text}
      media={item.media || null}
      replyToName={item.replyTo ? replyNameOf(names.profileOf(item.replyTo.author)) : null}
      now={now}
      onReply={typeof onReply === 'function'
        ? () => onReply({ ref: feedKey(item), name: item.name, username: item.username, text: item.text })
        : undefined}
      onReport={reportable(item)
        ? () => onReport({ author: item.author, name: item.name, username: item.username, seq: item.seq, text: item.text })
        : undefined}
    />
  )

  return (
    <RefreshableList
      listRef={listRef}
      data={items}
      keyExtractor={feedKey}
      renderItem={renderItem}
      extraData={extra}
      ListHeaderComponent={items.length > 0 && loadError ? <ErrorState message={loadError} onRetry={loadNewest} pending={refreshing} /> : null}
      ListEmptyComponent={empty}
      ListFooterComponent={footer}
      contentContainerStyle={{ paddingBottom: bottomPad }}
      onRefresh={loadNewest}
      refreshing={refreshing}
      onLoadMore={active && !moreError ? loadOlder : undefined}
      loadingMore={loadingMore}
      loadMoreError={!!moreError}
      atEnd={atEnd}
      scrollToTopSignal={scrollToTop}
      newItems={{ label: 'ver novidades', visible: fresh && loadedAt !== null, onPress: showNewItems }}
    />
  )
}

const styles = StyleSheet.create({
  footer: { padding: 16, gap: 8 }
})
