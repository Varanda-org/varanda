// Espiadinha: up to three publications (posts, replies, quotes, reposts) of
// each diary the person does not follow, their own included, one round at a
// time, newest first.
// No algorithm. Hosted web only: on native and varanda-serve the tab explains
// that and never calls peek.read. The rows live in memory only; nothing is
// persisted (their photos are fetched no-store: these authors are not
// followed). Names come from the item (PostRow) or from a verified post the
// node read; only an own or followed author (a reply's parent, a quoted post)
// reads the names cache, as in A Rua, never a stranger. As in A Rua (its
// useSocial), a row opens its conversation and its author's profile, shows
// the counts and offers curtir, republicar and citar; a reply names its
// parent, a quote shows the quoted post and a repost the original, each
// read and verified by the node.
// Hosted web only, a field "pesquisar por assunto" above the explanation: on
// submit (never per keystroke) the Busca screen replaces the rounds with the
// posts of any diary the seeder indexed that contain the words; 'limpar'
// brings the rounds back from memory, unchanged.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { FOLLOW_LIMIT_MAX, PEEK_LIMIT_DEFAULT, PEEK_LIMIT_MAX, displayText } from '@varanda/rpc'
import { useNode } from '../node'
import { useNames } from '../names'
import { shouldReloadOnShow } from '../paging'
import {
  PEEK_OFFLINE_MESSAGE, PEEK_RULE_TEXT, PEEK_SHORT_TEXT, PEEK_WEB_ONLY_MESSAGE,
  isExpiredPeekError, isLastPeekPage, isWebOnlyError, mergePage, pageNeeds, peekKey, peekNotice,
  roundLabel, roundStarts, skippedText, withoutAuthor
} from '../peek'
import { whoOf } from '../who'
import { SEARCH_BUTTON, SEARCH_CLEAR, SEARCH_INPUT_MAX, SEARCH_INVALID, SEARCH_LABEL, SEARCH_PLACEHOLDER, SEARCH_TRUNCATED, searchPath } from '../topics'
import Busca from './Busca'
import { CountsNote, RepostPlaceholder, refOf, socialRowProps, useSocial } from './ARua'
import { Btn, Field, Soft, colors, errorText, useBottomPad, useNow } from '../ui'
import { PostRow } from '../ui/PostRow'
import { RefreshableList } from '../ui/RefreshableList'
import { EmptyState, ErrorState, ListFooter, Skeleton } from '../ui/States'
import { Pill } from '../ui/Pill'
import { type } from '../ui/theme'

const MEMORY_TEXT = 'As publicações ficam só na memória do navegador enquanto a aba está aberta.'

// follow.list returns at most FOLLOW_LIMIT_MAX keys. An account follows at
// most 4095 diaries, so nine pages is the whole list and a hard stop.
const FOLLOW_PAGES_MAX = 9

const noop = () => {}

export default function Espiadinha ({ active, refresh, onReply, onReport, onQuote, onOpenThread, onOpenMember, onOpenEngagers, ownKey, scrollToTop, followsSignal, onFollowsChanged, onPublish, onToast }) {
  const node = useNode()
  const names = useNames()
  const social = useSocial({ ownKey, onToast })
  const { ingest } = social
  // The names cache only for own or followed authors; a stranger's parent
  // waits for its post instead (undefined, never a cached guess).
  const profileOf = (a) => social.persistOf(a) ? names.profileOf(a) : undefined
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
    // The node dropped this list's snapshot: the rows stay, the cursor is
    // dead, so no more continuations until a refresh.
    expired: false,
    loadedAt: null,
    meta: { diaries: 0, skipped: 0, incomplete: false },
    unsupported: false,
    following: new Set()
  })
  const { items, atEnd, loading, loadingMore, refreshing, loadError, moreError, expired, loadedAt, meta, unsupported, following } = state
  const [rule, setRule] = useState(false)
  // The typed text and the active search ({ tokens, path } or null).
  const [draft, setDraft] = useState('')
  const [query, setQuery] = useState(null)
  const stateRef = useRef(state)
  // Only the latest read may commit; the ref also blocks duplicate end reaches.
  const seqRef = useRef(0)
  const commit = useCallback((patch) => {
    stateRef.current = { ...stateRef.current, ...patch }
    setState(stateRef.current)
  }, [])
  const { request } = node

  // Authors followed while this list is shown (here or elsewhere, lowercase).
  // Every commit of rows drops theirs, so a page read before the follow (one
  // in flight, a later continuation of the same snapshot) never puts them
  // back. A repost row counts by its reposter (item.author). Each entry holds
  // the stamp of its latest follow: a refresh clears only the entries it saw
  // when it started, so a follow repeated while it runs (after an unfollow
  // elsewhere, which never removes an entry) still filters its answer.
  const followedHereRef = useRef(new Map())
  const followStampRef = useRef(0)
  const markFollowed = useCallback((author) => {
    followedHereRef.current.set(author.toLowerCase(), ++followStampRef.current)
  }, [])
  const unfollowed = useCallback((list) => {
    const map = followedHereRef.current
    if (map.size === 0) return list
    return list.filter((item) => typeof item.author !== 'string' || !map.has(item.author.toLowerCase()))
  }, [])

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

  // A followsSignal that arrived before the first page committed. Several
  // of them are still one pass, run from loadFirst once that page exists.
  const followsPending = useRef(false)
  // One follow.list pass: every page, then drop those authors. An error is
  // ignored, as before, so the next reload reconciles. `alive` is false once
  // the effect that started this pass was cleaned up, and that pass stops
  // so the one that replaced it is what commits.
  const reconcileFollows = useCallback(async (alive) => {
    const keys = []
    let offset = 0
    try {
      for (let n = 0; n < FOLLOW_PAGES_MAX; n++) {
        if (!alive()) return
        const r = await request('follow.list', { offset, limit: FOLLOW_LIMIT_MAX })
        if (!alive()) return
        const follows = Array.isArray(r && r.follows) ? r.follows : []
        for (const k of follows) if (typeof k === 'string') keys.push(k.toLowerCase())
        // Next offset is 500 on. An empty page, or offset at or past total,
        // is the end; a missing total ends after the page just read.
        const total = r && Number.isSafeInteger(r.total) ? r.total : offset
        offset += FOLLOW_LIMIT_MAX
        if (follows.length === 0 || offset >= total) break
      }
    } catch {
      return
    }
    if (!alive()) return
    // Only new keys get a stamp: re-stamping every follow would make a
    // refresh in flight keep all of them, hiding a later unfollow one more
    // refresh. An explicit 'seguir' (follow below) always re-stamps.
    for (const k of keys) if (!followedHereRef.current.has(k)) markFollowed(k)
    commit({ items: unfollowed(stateRef.current.items) })
  }, [request, commit, unfollowed, markFollowed])

  const loadFirst = useCallback(async () => {
    if (!hosted || stateRef.current.unsupported) return
    const mine = ++seqRef.current
    const before = new Map(followedHereRef.current)
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
      // A fresh first page replaces the list: the follows made before it was
      // asked for are the node's to apply. Only those made while it was in
      // flight (a new stamp) still filter it.
      for (const [a, stamp] of before) {
        if (followedHereRef.current.get(a) === stamp) followedHereRef.current.delete(a)
      }
      const rows = unfollowed(page.items)
      ingest({ ...pageNeeds(rows), reset: true })
      commit({
        items: mergePage([], rows).items,
        next: page.next,
        atEnd: isLastPeekPage(page),
        expired: false,
        loadedAt: Date.now(),
        meta: { diaries: page.diaries, skipped: page.skipped, incomplete: page.incomplete === true },
        loading: false,
        refreshing: false
      })
      // Signals that arrived while loadedAt was null share this one pass.
      // Clear the flag as it starts. Nothing cleans this pass up: it has to
      // finish so the rows just committed lose those authors.
      if (followsPending.current) {
        followsPending.current = false
        reconcileFollows(() => true)
      }
    } catch (err) {
      if (mine !== seqRef.current) return
      // An old node bundle or a native / serve node: never asked again.
      if (isWebOnlyError(err)) commit({ unsupported: true, loading: false, refreshing: false })
      else commit({ loading: false, refreshing: false, loadError: errorText(err) })
    }
  }, [hosted, peek, commit, ingest, unfollowed, reconcileFollows])

  const loadMore = useCallback(async () => {
    const current = stateRef.current
    if (!active || !hosted || current.loading || current.refreshing || current.loadingMore || current.atEnd || current.expired || current.next === null) return
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
      const rows = unfollowed(page.items)
      ingest(pageNeeds(rows))
      commit({
        items: unfollowed(mergePage(stateRef.current.items, rows).items),
        next: page.next,
        atEnd: isLastPeekPage(page) || stuck,
        meta: { diaries: page.diaries, skipped: page.skipped, incomplete: meta.incomplete || page.incomplete === true },
        loadingMore: false
      })
    } catch (err) {
      if (mine !== seqRef.current) return
      // An expired snapshot is not a retryable failure ('tentar de novo'
      // would only repeat it) nor the end of the list: ask for a refresh.
      if (isExpiredPeekError(err)) commit({ loadingMore: false, expired: true })
      else commit({ loadingMore: false, moreError: errorText(err) })
    }
  }, [active, hosted, peek, commit, ingest, unfollowed])

  // Reload rules as A Rua: first show, a reselect after 60 s, a refresh bump.
  const previous = useRef({ active: false, refresh, scrollToTop })
  useEffect(() => {
    const prev = previous.current
    const shown = active && !prev.active
    const reselected = scrollToTop !== prev.scrollToTop
    const changed = refresh !== prev.refresh
    // While a search is shown, Busca handles its own reloads: the refresh value
    // is NOT advanced, so a bump during the search (a follow) is still seen as
    // `changed` once the query is cleared and the rounds reload.
    const searching = query !== null
    previous.current = { active, refresh: active && !searching ? refresh : prev.refresh, scrollToTop }
    if (!active || searching) return
    const current = stateRef.current
    const stale = shouldReloadOnShow({ loadedAt: current.loadedAt, now: Date.now(), fresh: false })
    if (changed || ((shown || reselected) && stale && !current.loading && !current.refreshing)) loadFirst()
  }, [active, refresh, scrollToTop, loadFirst, query])

  // A follow made elsewhere (Membro, Seguindo, A Rua, another device): drop
  // the followed authors' rows without reloading, so the pages and the
  // scroll stay. An unfollow adds nothing back; the next reload shows those
  // rows. A failure is ignored: the next reload reconciles. follow.list is
  // paged (500 keys; at most 4095 follows, so nine pages) and the pass reads
  // every one. A signal while the first page is still loading is remembered,
  // and one pass runs once that page has committed.
  const followsSeen = useRef(followsSignal)
  useEffect(() => {
    if (followsSignal === followsSeen.current) return
    followsSeen.current = followsSignal
    if (!hosted) return
    // The page in flight was read with the old follow set. Keep the signal
    // until that page commits, or that author's rows stay until a refresh.
    if (stateRef.current.loadedAt === null) {
      followsPending.current = true
      return
    }
    let alive = true
    reconcileFollows(() => alive)
    return () => { alive = false }
  }, [followsSignal, hosted, reconcileFollows])

  useEffect(() => () => {
    seqRef.current += 1
    previous.current.active = false
    stateRef.current = { ...stateRef.current, loading: false, loadingMore: false, refreshing: false }
  }, [])

  // 'seguir': the author's rows leave the list once the follow is applied,
  // without a reload (the pages and the scroll stay); followedHereRef keeps a
  // page in flight from bringing them back. An uncertain failure (timeout) is
  // reported, never retried automatically.
  const follow = async (author, name, username) => {
    if (stateRef.current.following.has(author)) return
    commit({ following: new Set(stateRef.current.following).add(author) })
    try {
      await request('follow.add', { key: author })
      markFollowed(author)
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

  // Submit only: the seeder allows a few /index requests per client per 10 s.
  const submit = () => {
    const r = searchPath(draft)
    if (r === null) {
      if (typeof onToast === 'function') onToast(SEARCH_INVALID)
      return
    }
    if (r.truncated && typeof onToast === 'function') onToast(SEARCH_TRUNCATED)
    setQuery({ tokens: r.tokens, path: r.path })
  }
  // Set when Busca toggled a like or repost: the rounds' cache is then stale.
  const socialDirtyRef = useRef(false)
  const clear = () => {
    if (socialDirtyRef.current) {
      // Re-read counts and own state of the kept rounds; no peek.read reload.
      socialDirtyRef.current = false
      ingest({ ...pageNeeds(stateRef.current.items), reset: true })
    }
    setQuery(null)
    setDraft('')
  }

  const searchBox = (
    <View>
      {hosted && notice === null
        ? (
          <View style={styles.searchBox}>
            <Field
              label={SEARCH_LABEL}
              placeholder={SEARCH_PLACEHOLDER}
              value={draft}
              onChangeText={setDraft}
              maxLength={SEARCH_INPUT_MAX}
              returnKeyType='search'
              onSubmitEditing={submit}
              mono
            />
            <Btn label={SEARCH_BUTTON} onPress={submit} disabled={draft.trim() === ''} secondary />
            {query !== null
              ? (
                <Pressable accessibilityRole='button' accessibilityLabel={SEARCH_CLEAR} onPress={clear} hitSlop={6}>
                  <Text style={styles.toggle}>{SEARCH_CLEAR}</Text>
                </Pressable>
                )
              : null}
          </View>
          )
        : null}
    </View>
  )

  const header = (
    <View style={styles.header}>
      {searchBox}
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
      <CountsNote social={social} />
    </View>
  )

  const skipped = skippedText(meta.skipped)
  const footer = (
    <View>
      <ListFooter
        loading={loadingMore}
        atEnd={loadedAt !== null && atEnd && !expired && items.length > 0}
        endText='Isso é tudo por enquanto.'
        error={moreError}
        onRetry={loadMore}
        pending={loadingMore || refreshing}
      />
      {expired
        ? (
          <View style={styles.footer}>
            <Soft>A lista expirou; puxe para atualizar.</Soft>
            <Pill label='atualizar' onPress={loadFirst} pending={loading || refreshing} />
          </View>
          )
        : null}
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
    empty = <EmptyState icon='olho' title='Ninguém para espiar ainda' body='Quando mais pessoas publicarem, as publicações delas aparecem aqui.' actionLabel={typeof onPublish === 'function' ? 'publicar' : undefined} onAction={typeof onPublish === 'function' ? onPublish : undefined} />
  } else {
    empty = <EmptyState icon='olho' title='Ainda não chegou nada' body='Quando houver publicações de quem você não segue ou suas, elas aparecem aqui.' actionLabel='atualizar' onAction={loadFirst} />
  }

  const reportable = (item) => hosted && typeof onReport === 'function' && typeof ownKey === 'string' && item.author !== ownKey
  // The own diary shows here too; its rows offer no 'seguir', and neither
  // does any row before the own key is known (it could be the own one).
  const canFollow = (author) => typeof ownKey === 'string' && typeof author === 'string' && author.toLowerCase() !== ownKey.toLowerCase()
  const handlers = { onOpenThread, onOpenMember, onOpenEngagers, onReply, onQuote, onReport }
  const openReposter = (item) => typeof onOpenMember === 'function'
    ? () => onOpenMember(item.author, { name: item.name, username: item.username })
    : undefined
  // A repost row is the ORIGINAL post (every action targets it) under the
  // reposter's line, as in A Rua; 'denunciar' reports the original. Its
  // 'seguir' sits on the reposter's line and follows the reposter.
  const rowOf = (item) => {
    if (item.kind === 'repost') {
      const ref = refOf(item.to)
      const repostedBy = { author: item.author, name: item.name, username: item.username }
      const post = social.original(ref)
      const followReposter = canFollow(item.author) ? () => follow(item.author, item.name, item.username) : undefined
      const reposterPending = following.has(item.author)
      if (!post) {
        return (
          <RepostPlaceholder
            repostedBy={repostedBy}
            missing={post === null}
            transient={social.transient(ref)}
            onRetry={() => social.retry(ref)}
            onOpenReposter={openReposter(item)}
            onFollowReposter={followReposter}
            followPending={reposterPending}
          />
        )
      }
      const row = socialRowProps({ post, ref, repostedBy, social, profileOf, now, ownKey, h: handlers })
      return (
        <PostRow
          {...row}
          onFollowReposter={followReposter}
          followPending={reposterPending}
          onReport={reportable(post) ? row.onReport : undefined}
        />
      )
    }
    const row = socialRowProps({ post: item, ref: peekKey(item), social, profileOf, now, ownKey, h: handlers })
    return (
      <PostRow
        {...row}
        onFollow={canFollow(item.author) ? () => follow(item.author, item.name, item.username) : undefined}
        followPending={following.has(item.author)}
        onReport={reportable(item) ? row.onReport : undefined}
      />
    )
  }
  const renderItem = ({ item, index }) => {
    // Every round is labelled, the first one too; only a separator below
    // other rows draws a top border.
    const label = starts.has(index) ? roundLabel(item.round) : null
    return (
      <View>
        {label
          ? (
            <View style={[styles.separator, index > 0 && styles.separatorLine]}>
              <Text accessibilityRole='header' style={styles.separatorText}>{label}</Text>
            </View>
            )
          : null}
        {rowOf(item)}
      </View>
    )
  }

  const shownItems = notice === null ? items : []
  // The rounds stay mounted (state and social cache) under the search. Only
  // 'web-only' hides it: the rounds' 'offline' notice (no round loaded yet)
  // must not unmount a search that loaded, which has its own offline state.
  if (query !== null && hosted && notice !== 'web-only') {
    return (
      <Busca
        query={query}
        header={<View style={styles.searchTop}>{searchBox}</View>}
        ownKey={ownKey}
        active={active}
        scrollToTop={scrollToTop}
        refresh={refresh}
        onReply={onReply}
        onReport={onReport}
        onQuote={onQuote}
        onOpenThread={onOpenThread}
        onOpenMember={onOpenMember}
        onOpenEngagers={onOpenEngagers}
        onFollowsChanged={onFollowsChanged}
        onFollowed={(author) => commit({ items: withoutAuthor(stateRef.current.items, author) })}
        onSocialChanged={() => { socialDirtyRef.current = true }}
        onToast={onToast}
      />
    )
  }
  return (
    <RefreshableList
      data={shownItems}
      keyExtractor={peekKey}
      renderItem={renderItem}
      extraData={{ now, following, starts, social: social.social, names: names.profileOf }}
      ListHeaderComponent={notice === null && items.length > 0 && loadError ? <ErrorState message={loadError} onRetry={loadFirst} pending={refreshing} /> : (notice === null ? header : null)}
      ListEmptyComponent={empty}
      ListFooterComponent={notice === null ? footer : null}
      contentContainerStyle={{ paddingBottom: bottomPad }}
      onRefresh={hosted && !unsupported ? loadFirst : undefined}
      refreshing={refreshing}
      onLoadMore={active && hosted && !moreError && !expired ? loadMore : undefined}
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
  searchTop: { padding: 16 },
  searchBox: { gap: 8 },
  footer: { padding: 16, gap: 8 },
  separator: { paddingHorizontal: 16, paddingVertical: 10 },
  separatorLine: { borderTopWidth: 1, borderTopColor: colors.line },
  separatorText: { fontSize: 14, lineHeight: 20, color: colors.soft }
})
