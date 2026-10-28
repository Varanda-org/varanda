// Busca: the result screen of the Espiadinha's "pesquisar por assunto". It
// renders in place of the rounds while a query is active; the Espiadinha keeps
// its own state mounted, so 'limpar' brings the rounds back without a reload.
//
// Trust model: the seeder's /index/topic answer is only a hint of where to
// look (refs). Every post is read and verified with diary.peek (the entry
// checked against the author's signed log) and the VERIFIED text is checked
// again for the words (assembleSearch); a ref whose post is missing, is not a
// post or lacks the words counts as "unavailable" and is never shown. Names
// come only from verified peek fields, never from the index or from a key.
//
// Cost: one /index/topic plus one /index/counts per <= 31 refs per page
// (useSocial), well within Caddy's 20 /index requests per 10 s per client;
// the peeks run one at a time (peekAll) as the node allows two in flight.
// Nothing is requested while typing: the Espiadinha only starts a query on
// submit.
//
// Order: date order of the seeder's index, newest first; no ranking, no
// hidden weights. Followed and own authors are included (the search is over
// everything the seeder holds), so a follow here does not remove rows. A page
// can be short or even empty with a moving cursor (the seeder's candidate
// budget): only a null cursor (or a repeated one) ends the list, and an empty
// page offers 'continuar busca' instead of continuing automatically.
//
// Hosted web only (the Espiadinha renders no field elsewhere). Everything is
// in memory; nothing is persisted. Strangers' photos stay no-store through
// socialRowProps (ARua.js) as in the Espiadinha.

import { useCallback, useEffect, useRef, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { displayText } from '@varanda/rpc'
import { useNode } from '../node'
import { shouldReloadOnShow } from '../paging'
import { fetchTopic } from '../indexClient'
import { planPeeks } from '../thread'
import { whoOf } from '../who'
import {
  SEARCH_BUSY, SEARCH_CONTINUE, SEARCH_CONTINUE_BODY, SEARCH_EMPTY_BODY, SEARCH_EMPTY_TITLE, SEARCH_END, SEARCH_ERROR,
  SEARCH_HINT, SEARCH_INCOMPLETE_NOTE, SEARCH_INDEXING_NOTE, SEARCH_MEMORY, SEARCH_OFFLINE_MESSAGE,
  SEARCH_UNAVAILABLE, assembleSearch, isLastSearchPage, mergeRefs, searchNotice
} from '../topics'
import { CountsNote, refOf, socialRowProps, useSocial } from './ARua'
import { peekAll, useFollowSet } from './Conversa'
import { Soft, errorText, useBottomPad, useNow } from '../ui'
import { PostRow } from '../ui/PostRow'
import { RefreshableList } from '../ui/RefreshableList'
import { EmptyState, ErrorState, ListFooter, Skeleton } from '../ui/States'

// Never the names cache: undefined lets a reply mark wait for its parent.
const noProfile = () => undefined

const itemKey = (item) => item.author + ':' + item.seq

// useSocial's ingest arguments for a page of posts: the posts are originals
// at hand; the posts they quote or answer are resolved; no author is followed.
function pageNeeds (items) {
  const local = new Map()
  const shown = []
  const need = []
  for (const item of items) {
    const ref = itemKey(item)
    local.set(ref, item)
    shown.push(ref)
    for (const r of [refOf(item.quote), refOf(item.replyTo)]) if (r !== null) need.push(r)
  }
  return { local, shown, need, authors: [] }
}

export default function Busca ({ query, header, ownKey, active, scrollToTop, refresh, onReply, onReport, onQuote, onOpenThread, onOpenMember, onOpenEngagers, onFollowsChanged, onFollowed, onSocialChanged, onToast }) {
  const node = useNode()
  const { request } = node
  const social = useSocial({ ownKey, onToast })
  const { ingest } = social
  const now = useNow(60000)
  const bottomPad = useBottomPad()
  const hosted = node.hosted === true
  const followSet = useFollowSet(request)
  const { follows, load: loadFollows, mark: markFollow } = followSet
  const [state, setState] = useState({
    refs: [],
    items: [],
    next: null,
    atEnd: false,
    loading: false,
    loadingMore: false,
    refreshing: false,
    loadError: '',
    moreError: '',
    unavailable: 0,
    flags: { indexing: false, complete: true },
    loadedAt: null,
    following: new Set()
  })
  const { items, atEnd, loading, loadingMore, refreshing, loadError, moreError, unavailable, flags, loadedAt, following } = state
  const stateRef = useRef(state)
  // Only the latest read may commit; the ref also blocks duplicate end reaches.
  const seqRef = useRef(0)
  const commit = useCallback((patch) => {
    stateRef.current = { ...stateRef.current, ...patch }
    setState(stateRef.current)
  }, [])

  // One page: the index answer (a hint), then every ref read and verified by
  // the node, then the shown items. A superseded read stops peeking early.
  // Each page peeks into its own map: planPeeks asks for every author of the
  // page with the index's hints, and a map shared across pages would keep the
  // first @nome seen (mergePeek), so one revoked meanwhile would survive.
  const readPage = useCallback(async (cursor, alive) => {
    const res = await fetchTopic(query.path, cursor)
    if (!res.ok) {
      if (res.reason === 'not-found') throw new Error(SEARCH_UNAVAILABLE)
      if (res.reason === 'network' || res.reason === 'timeout') throw new Error(SEARCH_OFFLINE_MESSAGE)
      if (res.reason === 'rate-limited') throw new Error(SEARCH_BUSY)
      throw new Error(SEARCH_ERROR)
    }
    const peeked = new Map()
    await peekAll(request, planPeeks({ refs: res.value.items, authors: res.value.authors }), peeked, alive)
    const { items: shown, unavailable: missing } = assembleSearch({
      refs: res.value.items,
      peeked,
      tokens: query.tokens,
      now: Date.now()
    })
    return {
      refs: res.value.items,
      items: shown,
      unavailable: missing,
      next: res.value.next,
      flags: { indexing: res.value.indexing, complete: res.value.complete }
    }
  }, [query, request])

  const loadFirst = useCallback(async () => {
    if (!hosted) return
    const mine = ++seqRef.current
    const alive = () => mine === seqRef.current
    // The follow set is read again with every first page (an unfollow made on
    // a profile while this screen is mounted); errors are ignored by the hook.
    loadFollows()
    commit({
      loading: stateRef.current.loadedAt === null,
      refreshing: stateRef.current.loadedAt !== null,
      loadingMore: false,
      loadError: '',
      moreError: ''
    })
    try {
      const page = await readPage(null, alive)
      if (!alive()) return
      ingest({ ...pageNeeds(page.items), reset: true })
      commit({
        refs: mergeRefs([], page.refs).refs,
        items: page.items,
        next: page.next,
        atEnd: isLastSearchPage(page),
        unavailable: page.unavailable,
        flags: page.flags,
        loadedAt: Date.now(),
        loading: false,
        refreshing: false
      })
    } catch (err) {
      if (!alive()) return
      commit({ loading: false, refreshing: false, loadError: errorText(err) })
    }
  }, [hosted, readPage, commit, ingest, loadFollows])

  const loadMore = useCallback(async () => {
    const current = stateRef.current
    if (!active || !hosted || current.loading || current.refreshing || current.loadingMore || current.atEnd || current.next === null) return
    const mine = ++seqRef.current
    const alive = () => mine === seqRef.current
    const after = current.next
    commit({ loadingMore: true, moreError: '' })
    try {
      const page = await readPage(after, alive)
      if (!alive()) return
      // A repeated cursor ends the list: a protocol failure, never a loop.
      const stuck = page.next === after
      const have = new Set(stateRef.current.items.map(itemKey))
      const fresh = page.items.filter((i) => !have.has(itemKey(i)))
      ingest(pageNeeds(fresh))
      commit({
        refs: mergeRefs(stateRef.current.refs, page.refs).refs,
        items: stateRef.current.items.concat(fresh),
        next: page.next,
        atEnd: isLastSearchPage(page) || stuck,
        unavailable: stateRef.current.unavailable + page.unavailable,
        flags: { indexing: page.flags.indexing, complete: stateRef.current.flags.complete && page.flags.complete },
        loadingMore: false
      })
    } catch (err) {
      if (alive()) commit({ loadingMore: false, moreError: errorText(err) })
    }
  }, [active, hosted, readPage, commit, ingest])

  // A new query (or the first one): start over from the first page.
  useEffect(() => {
    commit({ refs: [], items: [], next: null, atEnd: false, unavailable: 0, loadedAt: null })
    loadFirst()
  }, [loadFirst, commit])

  // Reload rules: a reselect or the tab shown again after 60 s reloads the
  // first page. A refresh bump (a follow, here or elsewhere, or a sent post)
  // only re-reads the follow set: the results do not depend on follows, and
  // a reload would throw away the pages already loaded. The first load is
  // the effect above.
  const previous = useRef({ active, refresh, scrollToTop })
  useEffect(() => {
    const prev = previous.current
    const shown = active && !prev.active
    const reselected = scrollToTop !== prev.scrollToTop
    const changed = refresh !== prev.refresh
    previous.current = { active, refresh: active ? refresh : prev.refresh, scrollToTop }
    if (!active) return
    const current = stateRef.current
    const stale = shouldReloadOnShow({ loadedAt: current.loadedAt, now: Date.now(), fresh: false })
    if ((shown || reselected) && stale && !current.loading && !current.refreshing) loadFirst()
    else if (changed) loadFollows()
  }, [active, refresh, scrollToTop, loadFirst, loadFollows])

  useEffect(() => () => {
    seqRef.current += 1
    previous.current.active = false
    stateRef.current = { ...stateRef.current, loading: false, loadingMore: false, refreshing: false }
  }, [])

  // 'seguir': unlike the rounds, the author's rows stay (search results are
  // not "people you do not follow"); the Espiadinha is told so its hidden
  // rounds drop the author. An uncertain failure is reported, never retried.
  const follow = async (author, name, username) => {
    if (stateRef.current.following.has(author)) return
    commit({ following: new Set(stateRef.current.following).add(author) })
    try {
      await request('follow.add', { key: author })
      markFollow(author, true)
      const named = name || username ? ' ' + displayText(whoOf({ name, username }).title) : ''
      if (typeof onToast === 'function') onToast('seguindo' + named)
      if (typeof onFollowed === 'function') onFollowed(author)
      if (typeof onFollowsChanged === 'function') onFollowsChanged()
    } catch (err) {
      if (typeof onToast === 'function') onToast(errorText(err))
    } finally {
      const rest = new Set(stateRef.current.following)
      rest.delete(author)
      commit({ following: rest })
    }
  }

  const notice = searchNotice({ hosted, online: node.online, loadedAt })

  const gone = unavailable > 0
    ? String(unavailable) + (unavailable === 1 ? ' publicação indisponível' : ' publicações indisponíveis')
    : null
  const top = (
    <View>
      {header}
      {notice === null
        ? (
          <View style={styles.notes}>
            <Soft>{SEARCH_HINT}</Soft>
            <Soft>{SEARCH_MEMORY}</Soft>
            {flags.indexing ? <Soft>{SEARCH_INDEXING_NOTE}</Soft> : null}
            {!flags.complete ? <Soft>{SEARCH_INCOMPLETE_NOTE}</Soft> : null}
            {gone ? <Soft>{gone}</Soft> : null}
            <CountsNote social={social} />
          </View>
          )
        : null}
      {notice === null && items.length > 0 && loadError ? <ErrorState message={loadError} onRetry={loadFirst} pending={refreshing} /> : null}
    </View>
  )

  const footer = (
    <ListFooter
      loading={loadingMore}
      atEnd={loadedAt !== null && atEnd && items.length > 0}
      endText={SEARCH_END}
      error={moreError}
      onRetry={loadMore}
      pending={loadingMore || refreshing}
    />
  )

  let empty
  if (notice === 'offline') {
    empty = <EmptyState icon='olho' title='Sem conexão' body={SEARCH_OFFLINE_MESSAGE} actionLabel='tentar de novo' onAction={loadFirst} />
  } else if (loadError) {
    empty = <ErrorState message={loadError} onRetry={loadFirst} pending={loading || refreshing} />
  } else if (loadedAt === null) {
    empty = <Skeleton />
  } else if (atEnd) {
    empty = <EmptyState icon='olho' title={SEARCH_EMPTY_TITLE} body={SEARCH_EMPTY_BODY} />
  } else {
    // A page with nothing verified yet but a moving cursor: the seeder's
    // candidate budget. No automatic continuation; the person decides.
    empty = <EmptyState icon='olho' title={SEARCH_EMPTY_TITLE} body={SEARCH_CONTINUE_BODY} actionLabel={SEARCH_CONTINUE} onAction={loadMore} />
  }

  const reportable = (item) => hosted && typeof onReport === 'function' && typeof ownKey === 'string' && item.author !== ownKey
  const isOwn = (item) => typeof ownKey === 'string' && item.author === ownKey.toLowerCase()
  const known = (item) => follows === null || follows.has(item.author)
  const handlers = { onOpenThread, onOpenMember, onOpenEngagers, onReply, onQuote, onReport }
  const renderItem = ({ item }) => {
    const row = socialRowProps({ post: item, ref: itemKey(item), social, profileOf: noProfile, now, ownKey, h: handlers })
    // A like or repost toggled here may also be in the hidden rounds, whose
    // social cache is then stale: tell the Espiadinha.
    const changed = () => { if (typeof onSocialChanged === 'function') onSocialChanged() }
    const wrap = (fn) => typeof fn === 'function' ? () => { fn(); changed() } : fn
    return (
      <PostRow
        {...row}
        onLike={wrap(row.onLike)}
        onRepost={wrap(row.onRepost)}
        onFollow={isOwn(item) || known(item) ? undefined : () => follow(item.author, item.name, item.username)}
        followPending={following.has(item.author)}
        onReport={reportable(item) ? row.onReport : undefined}
      />
    )
  }

  return (
    <RefreshableList
      data={items}
      keyExtractor={itemKey}
      renderItem={renderItem}
      extraData={{ now, following, follows, social: social.social }}
      ListHeaderComponent={top}
      ListEmptyComponent={empty}
      ListFooterComponent={footer}
      contentContainerStyle={{ paddingBottom: bottomPad }}
      onRefresh={hosted ? loadFirst : undefined}
      refreshing={refreshing}
      // No automatic continuation over an empty list: 'continuar busca' only.
      onLoadMore={active && hosted && !moreError && items.length > 0 ? loadMore : undefined}
      loadingMore={loadingMore}
      loadMoreError={!!moreError}
      atEnd={atEnd}
      scrollToTopSignal={scrollToTop}
    />
  )
}

const styles = StyleSheet.create({
  notes: { paddingHorizontal: 16, paddingBottom: 16, gap: 8 }
})
