// The posts under one hashtag (entry { screen: 'assunto', key: token }),
// pushed above the tabs. Hosted nodes only. The seeder index lists refs; every
// ref is peeked (verified by the node against the author's signed log) and
// shown only if that text carries the tag (src/topicPage.js). Rows go through
// the same PostRow pipeline as Busca. One user action (open, pull to refresh,
// 'Ver mais') reads at most MAX_INDEX_PAGES index pages and peeks at most
// MAX_ACTION_PEEKS refs. No count is shown:
// the index may be partial, so a number would be a claim it cannot back.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { displayText } from '@varanda/rpc'
import { useBlocks } from '../blocksProvider'
import { tagTitle } from '../hashtagNav'
import { hasTag } from '../hashtags'
import { fetchTopic } from '../indexClient'
import { useNode } from '../node'
import {
  SEARCH_BUSY, SEARCH_CONTINUE, SEARCH_CONTINUE_BODY, SEARCH_EMPTY_BODY, SEARCH_EMPTY_TITLE, SEARCH_END, SEARCH_ERROR,
  SEARCH_INCOMPLETE_NOTE, SEARCH_INDEXING_NOTE, SEARCH_OFFLINE_MESSAGE, SEARCH_UNAVAILABLE, searchNotice
} from '../topics'
import { dropBlocked, hasMore, initialTopic, isIncomplete, planTopicPeeks, refreshFailed, runAction, topicPath } from '../topicPage'
import { refOf, socialRowProps, useRowPropsCache, useSocial } from './ARua'
import { peekAll } from './Conversa'
import { Btn, Soft, errorText, useBottomPad, useNow } from '../ui'
import { OfflineNote } from '../ui/OfflineNote'
import { PostRow } from '../ui/PostRow'
import { PostSheetProvider } from '../ui/PostSheetHost'
import { RefreshableList } from '../ui/RefreshableList'
import { EmptyState, ErrorState, ListFooter, SkeletonRow } from '../ui/States'
import { TopBar } from '../ui/TopBar'
import { space } from '../ui/theme'
import { useStyles } from '../ui/ThemeProvider'

const noProfile = () => undefined
const itemKey = (item) => item.author + ':' + item.seq

// useSocial's ingest arguments for posts: they are originals at hand; the
// posts they quote or answer are resolved; no author is followed.
function needs (items) {
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

// One actions sheet for the whole list instead of two per row.
export default function Assunto (props) {
  return <PostSheetProvider><AssuntoList {...props} /></PostSheetProvider>
}

function AssuntoList ({ entry, ownKey, onBack, onReply, onReport, onQuote, onOpenThread, onOpenMember, onOpenMention, onOpenEngagers, onOpenQuotes, onToast }) {
  const styles = useStyles(makeStyles)
  const node = useNode()
  const { request } = node
  const hosted = node.hosted === true
  const social = useSocial({ ownKey, onToast })
  const { ingest } = social
  const now = useNow(60000)
  const bottomPad = useBottomPad()
  const blocks = useBlocks()
  // Read at fetch time, so a block does not rebuild the callbacks and refetch.
  const blockedRef = useRef(blocks.has)
  blockedRef.current = blocks.has
  // No ref is planned for a peek before the block list is known: until then
  // `has` is false for everyone. A failed list read does not wait forever;
  // the node refuses reads of blocked authors either way.
  const blocksKnown = blocks.loadState !== 'pending'
  const key = typeof entry.key === 'string' ? entry.key : ''
  // Memoized on the string: a new object each render would rebuild readPage
  // and act, rerun the effect below and fetch again on every render.
  const path = useMemo(() => topicPath(key), [key])
  // `retryFresh`: the failed action was a refresh that kept the old list, so
  // its retry must refresh again, not continue the old cursor.
  const [view, setView] = useState({ topic: initialTopic(), loading: false, refreshing: false, error: '', retryFresh: false, loadedAt: null })
  const viewRef = useRef(view)
  // Only the latest action may commit.
  const seqRef = useRef(0)
  const commit = useCallback((patch) => {
    viewRef.current = { ...viewRef.current, ...patch }
    setView(viewRef.current)
  }, [])

  // The index page, then every ref of it read and verified by the node, each
  // page into its own Map (a shared one would keep the first @nome seen).
  // Failures become the Busca notice texts.
  const readPage = useCallback(async (cursor, state, alive) => {
    const res = await fetchTopic(path.path, cursor)
    if (!res.ok) {
      if (res.reason === 'not-found') return { ok: false, reason: SEARCH_UNAVAILABLE }
      if (res.reason === 'network' || res.reason === 'timeout') return { ok: false, reason: SEARCH_OFFLINE_MESSAGE }
      if (res.reason === 'rate-limited') return { ok: false, reason: SEARCH_BUSY }
      return { ok: false, reason: SEARCH_ERROR }
    }
    const page = dropBlocked(res.value, blockedRef.current)
    const plan = planTopicPeeks(page, state)
    const peeked = new Map()
    if (plan.length > 0) {
      try {
        await peekAll(request, plan, peeked, alive)
      } catch (err) {
        return { ok: false, reason: errorText(err) }
      }
    }
    return { ok: true, page, peeked }
  }, [path, request])

  const act = useCallback(async (fresh) => {
    if (!hosted || path === null || !blocksKnown) return
    const current = viewRef.current
    // A refresh supersedes a running 'Ver mais', as in Busca.
    if (current.refreshing || (current.loading && !fresh)) return
    const mine = ++seqRef.current
    const alive = () => mine === seqRef.current
    const had = current.loadedAt !== null
    commit({ loading: !had || !fresh, refreshing: had && fresh, error: '', retryFresh: false })
    const known = new Set((fresh ? [] : current.topic.items).map(itemKey))
    const out = await runAction({
      state: fresh ? initialTopic() : current.topic,
      readPage: (cursor, state) => readPage(cursor, state, alive),
      token: path.token,
      hasTag,
      now: Date.now,
      alive
    })
    if (out === null || !alive()) return
    if (refreshFailed(fresh, out)) {
      commit({ loading: false, refreshing: false, error: out.error, retryFresh: true })
      return
    }
    ingest({ ...needs(out.state.items.filter((i) => !known.has(itemKey(i)))), reset: fresh })
    commit({ topic: out.state, loading: false, refreshing: false, error: out.error || '', loadedAt: Date.now() })
  }, [hosted, path, blocksKnown, readPage, commit, ingest])

  useEffect(() => {
    // A rerun after a dependency change drops the earlier action; its busy
    // flags would otherwise block this one.
    commit({ loading: false, refreshing: false })
    act(true)
    return () => { seqRef.current += 1 }
  }, [act, commit])

  const { topic, loading, refreshing, error, retryFresh, loadedAt } = view
  const retry = () => act(retryFresh === true)
  const items = topic.items
  const notice = searchNotice({ hosted, online: node.online, loadedAt })
  const title = path === null ? '' : tagTitle(path.token)
  const notes = [topic.indexing && SEARCH_INDEXING_NOTE, isIncomplete(topic) && !topic.indexing && SEARCH_INCOMPLETE_NOTE].filter(Boolean)

  let empty
  if (path === null || notice === 'web-only') {
    empty = <EmptyState icon='lupa' title={SEARCH_UNAVAILABLE} />
  } else if (notice === 'offline') {
    empty = <EmptyState icon='olho' title='Sem conexão' body={SEARCH_OFFLINE_MESSAGE} actionLabel='Tentar de novo' onAction={() => act(true)} />
  } else if (error) {
    empty = <EmptyState icon='olho' title='Não foi possível abrir' body={error} actionLabel='Tentar de novo' onAction={retry} />
  } else if (loadedAt === null) {
    empty = <View accessible accessibilityLabel='Buscando publicações' accessibilityLiveRegion='polite'>{[0, 1, 2].map((row) => <SkeletonRow key={row} />)}</View>
  } else if (!hasMore(topic)) {
    empty = <EmptyState icon='olho' title={SEARCH_EMPTY_TITLE} body={SEARCH_EMPTY_BODY} actionLabel='Tentar de novo' onAction={() => act(true)} />
  } else {
    // Nothing verified yet but a moving cursor: the person decides to go on.
    empty = <EmptyState icon='olho' title={SEARCH_EMPTY_TITLE} body={SEARCH_CONTINUE_BODY} actionLabel={SEARCH_CONTINUE} onAction={() => act(false)} />
  }

  const header = notice === null && notes.length > 0
    ? <View style={styles.notes}>{notes.map((n) => <Soft key={n}>{n}</Soft>)}</View>
    : null
  const footer = items.length > 0
    ? (
      <View>
        {error ? <ErrorState message={error} onRetry={retry} pending={loading || refreshing} /> : null}
        {hasMore(topic) && !error
          ? <View style={styles.more}><Btn label='Ver mais' secondary onPress={() => act(false)} pending={loading} /></View>
          : null}
        {!hasMore(topic) ? <ListFooter atEnd endText={SEARCH_END} /> : null}
      </View>
      )
    // An action over an empty list already loaded once ('continuar busca'):
    // the empty state stays, so the progress shows below it.
    : loading && loadedAt !== null ? <ListFooter loading /> : null

  const handlers = { onOpenThread, onOpenMember, onOpenMention, onOpenEngagers, onOpenQuotes, onReply, onQuote, onReport }
  // Row props from A Rua's cache, as in Busca: a row whose inputs did not
  // change keeps its props, and its handlers read the newest ones at call time.
  const rowCache = useRowPropsCache(items, itemKey, { h: handlers, social })
  const renderItem = ({ item }) => {
    const key = itemKey(item)
    const row = socialRowProps({ post: item, ref: key, social, profileOf: noProfile, avatarOf: noProfile, now, ownKey, h: handlers, cache: rowCache, rowKey: key })
    const mine = typeof ownKey === 'string' && item.author === ownKey.toLowerCase()
    return (
      <PostRow
        {...row}
        onReport={hosted && typeof onReport === 'function' && typeof ownKey === 'string' && !mine ? row.onReport : undefined}
      />
    )
  }

  return (
    <View style={styles.flex}>
      <TopBar title={displayText(title)} onBack={onBack} />
      <OfflineNote />
      <RefreshableList
        data={items}
        keyExtractor={itemKey}
        renderItem={renderItem}
        extraData={{ now, social: social.social }}
        ListHeaderComponent={header}
        ListEmptyComponent={empty}
        ListFooterComponent={footer}
        contentContainerStyle={{ paddingBottom: bottomPad }}
        onRefresh={hosted && path !== null ? () => act(true) : undefined}
        refreshing={refreshing}
        atEnd
      />
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  notes: { paddingHorizontal: space.lg, paddingVertical: space.md, gap: space.xs },
  more: { paddingHorizontal: space.lg, paddingVertical: space.md }
})
