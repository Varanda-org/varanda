// Espiadinha: up to three publications (posts, replies, quotes, reposts) of
// each diary the person does not follow, one round at a time, newest first.
// No algorithm. Hosted nodes only (the hosted web app and the native app on an
// installation): on varanda-serve or a manual configuration the tab explains
// that and never calls peek.read. The rows live in memory only; nothing is
// persisted (their photos are fetched no-store: these authors are not
// followed). Names come from the item (PostRow) or from a verified post the
// node read; only an own or followed author (a reply's parent, a quoted post)
// reads the names cache, as in A Rua, never a stranger. As in A Rua (its
// useSocial), a row opens its conversation and its author's profile, shows
// the counts and offers curtir, republicar and citar; a reply names its
// parent, a quote shows the quoted post and a repost the original, each
// read and verified by the node.
// Word search in posts is the Busca tab's (screens/Busca.js).

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { StyleSheet, View } from 'react-native'
import { FOLLOW_LIMIT_MAX, PEEK_LIMIT_DEFAULT, PEEK_LIMIT_MAX, displayText } from '@varanda/rpc'
import { useNode } from '../node'
import { useNames } from '../names'
import { shouldReloadOnShow } from '../paging'
import { HELP } from '../help'
import {
  PEEK_OFFLINE_MESSAGE, PEEK_SHORT_TEXT, PEEK_WARM_QUIET_MS, PEEK_WEB_ONLY_MESSAGE,
  getPeekWarmState, isExpiredPeekError, isLastPeekPage, isSeederBusyError, isWebOnlyError, mergePage, pageNeeds, peekKey, peekNotice,
  recordFollow, shouldWarmPeek, skippedText, subscribePeekWarm, updatePeekWarmState, withoutFollowed
} from '../peek'
import { whoOf } from '../who'
import { CountsNote, RepostPlaceholder, refOf, socialRowProps, useSocial } from './ARua'
import { Soft, errorText, useBottomPad, useNow } from '../ui'
import { PostRow } from '../ui/PostRow'
import { HelpNote } from '../ui/Help'
import { RefreshableList } from '../ui/RefreshableList'
import { EmptyState, ErrorState, ListFooter, Skeleton } from '../ui/States'
import { Pill } from '../ui/Pill'

// follow.list returns at most FOLLOW_LIMIT_MAX keys. An account follows at
// most 4095 diaries, so nine pages is the whole list and a hard stop.
const FOLLOW_PAGES_MAX = 9

const noop = () => {}

export default function Espiadinha ({ active, refresh, onReply, onReport, onQuote, onOpenThread, onOpenMember, onOpenMention, onOpenEngagers, ownKey, scrollToTop, followsSignal, onFollowsChanged, onPublish, onToast }) {
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
  const stateRef = useRef(state)
  // Read after a wait: the warm decides from the latest tab and refresh, not
  // the render that armed the timer.
  const activeRef = useRef(active)
  activeRef.current = active
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh
  const peekWarm = useSyncExternalStore(subscribePeekWarm, getPeekWarmState, getPeekWarmState)
  // pageNeeds held back until the tab is shown.
  const pendingIngestRef = useRef(null)
  // A warm first page kept off screen until the first show: thirty hidden
  // rows with photos would compete with A Rua for a phone's main thread.
  const heldRef = useRef(null)
  // A refresh bump that landed while a peek.read was already in flight.
  const reloadAfterRef = useRef(false)
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
  const unfollowed = useCallback((list) => withoutFollowed(list, followedHereRef.current), [])

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

  const loadFirst = useCallback(async (opts) => {
    if (!hosted || stateRef.current.unsupported) return
    // Pills pass the press event and pull-to-refresh passes nothing. Only the
    // hidden warm sets quiet.
    const quiet = !!(opts && opts.quiet === true)
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
      // A hidden warm renders nothing and reads nothing more (no follow.list,
      // engagement.read, counts or diary peeks): the first show commits it.
      if (quiet && !activeRef.current) {
        heldRef.current = {
          rows,
          next: page.next,
          atEnd: isLastPeekPage(page),
          meta: { diaries: page.diaries, skipped: page.skipped, incomplete: page.incomplete === true },
          at: Date.now()
        }
        commit({ loading: false, refreshing: false })
        return
      }
      ingest({ ...pageNeeds(rows), reset: true })
      pendingIngestRef.current = null
      heldRef.current = null
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
      if (followsPending.current && activeRef.current) {
        followsPending.current = false
        reconcileFollows(() => true)
      }
    } catch (err) {
      if (isSeederBusyError(err)) updatePeekWarmState(node.epoch, { busy: true })
      if (mine !== seqRef.current) return
      // An old node bundle or a native / serve node: never asked again.
      // A quiet miss while hidden sets no error: the first real show loads.
      if (isWebOnlyError(err)) commit({ unsupported: true, loading: false, refreshing: false })
      else if (quiet && !activeRef.current) commit({ loading: false, refreshing: false })
      else commit({ loading: false, refreshing: false, loadError: errorText(err) })
      // A failed refresh keeps the warm rows on screen: their held needs
      // still load.
      if (activeRef.current && pendingIngestRef.current !== null) {
        ingest({ ...pendingIngestRef.current, reset: true })
        pendingIngestRef.current = null
      }
      // Follows held while the tab was hidden still drop their rows.
      if (activeRef.current && followsPending.current && stateRef.current.loadedAt !== null) {
        followsPending.current = false
        reconcileFollows(() => true)
      }
    }
  }, [hosted, peek, commit, ingest, unfollowed, reconcileFollows, node.epoch])

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
  // The warm page's quotes, counts and hearts start on the first show. A read
  // already in flight is not joined by another: a refresh bump waits for it,
  // a show or a reselect just waits.
  const previous = useRef({ active: false, refresh, scrollToTop })
  const seederVerified = !!(node.signals && node.signals.seederVerified)
  // Warm the first page while this tab is hidden, once the seeder link is
  // verified, so opening it finds the rows already there. The refresh stored
  // on `previous` is consumed: this read is newer than a bump that arrived
  // before it.
  useEffect(() => {
    const warm = getPeekWarmState()
    const eligible = shouldWarmPeek({
      hosted,
      online: node.online,
      phase: node.phase,
      seederVerified,
      visible: node.visible,
      active,
      loadedAt: state.loadedAt,
      loading: state.loading,
      refreshing: state.refreshing,
      unsupported: state.unsupported,
      attempted: warm?.epoch === node.epoch && warm.attempted,
      busy: warm?.epoch === node.epoch && warm.busy
    }) && heldRef.current === null
    updatePeekWarmState(node.epoch, { eligible })
    if (!eligible) return
    // Only once the app has been quiet: the boot reads come first.
    const wait = node.whenIdle(PEEK_WARM_QUIET_MS)
    wait.promise.then(() => {
      const current = stateRef.current
      const warm = getPeekWarmState()
      // The tab may have opened, or a read started, during the wait.
      if (warm?.epoch !== node.epoch || warm.busy || warm.attempted || current.loadedAt !== null || current.loading || current.refreshing || activeRef.current || heldRef.current !== null) return
      updatePeekWarmState(node.epoch, { attempted: true, pending: true })
      previous.current = { ...previous.current, refresh: refreshRef.current }
      loadFirst({ quiet: true }).finally(() => updatePeekWarmState(node.epoch, { pending: false }))
    })
    return () => wait.cancel()
  }, [hosted, node.online, node.phase, seederVerified, node.visible, node.epoch, node.whenIdle, active, state.loadedAt, state.loading, state.refreshing, state.unsupported, loadFirst, peekWarm])

  useEffect(() => {
    const prev = previous.current
    const shown = active && !prev.active
    const reselected = scrollToTop !== prev.scrollToTop
    const changed = refresh !== prev.refresh
    previous.current = { active, refresh: active ? refresh : prev.refresh, scrollToTop }
    if (!active) return
    // The warm page goes on screen now; its needs load below, or with the
    // reload when it is already old.
    const held = heldRef.current
    if (held !== null && stateRef.current.loadedAt === null) {
      heldRef.current = null
      const rows = unfollowed(held.rows)
      commit({ items: mergePage([], rows).items, next: held.next, atEnd: held.atEnd, expired: false, loadedAt: held.at, meta: held.meta })
      pendingIngestRef.current = pageNeeds(rows)
    }
    const current = stateRef.current
    if (current.loading || current.refreshing) {
      if (changed) reloadAfterRef.current = true
      return
    }
    const stale = shouldReloadOnShow({ loadedAt: current.loadedAt, now: Date.now(), fresh: false })
    if (changed || ((shown || reselected) && stale)) {
      // This load ingests its own page on success (and the warm page's held
      // needs on failure); a deferred refresh is covered by it.
      reloadAfterRef.current = false
      loadFirst()
      return
    }
    if (pendingIngestRef.current !== null) {
      ingest({ ...pendingIngestRef.current, reset: true })
      pendingIngestRef.current = null
    }
    if (followsPending.current && current.loadedAt !== null) {
      followsPending.current = false
      reconcileFollows(() => true)
    }
  }, [active, refresh, scrollToTop, loadFirst, ingest, reconcileFollows, commit, unfollowed])

  // A warm page nobody has seen is dropped with its node session: its cursor
  // lived in that session's snapshot. The next epoch warms again.
  const shownOnceRef = useRef(false)
  if (active) shownOnceRef.current = true
  useEffect(() => {
    if (shownOnceRef.current) return
    if (heldRef.current === null && !stateRef.current.loading) return
    seqRef.current += 1
    heldRef.current = null
    pendingIngestRef.current = null
    commit({ loading: false, refreshing: false })
  }, [node.epoch, commit])

  useEffect(() => {
    if (!active || state.loading || state.refreshing || !reloadAfterRef.current) return
    reloadAfterRef.current = false
    loadFirst()
  }, [active, state.loading, state.refreshing, loadFirst])

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
    // A hidden list keeps it for the next show.
    if (stateRef.current.loadedAt === null || !activeRef.current) {
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
  const dropFollowed = (author) => {
    commit({ items: recordFollow(followedHereRef.current, ++followStampRef.current, stateRef.current.items, author) })
  }

  const follow = async (author, name, username) => {
    if (stateRef.current.following.has(author)) return
    commit({ following: new Set(stateRef.current.following).add(author) })
    try {
      await request('follow.add', { key: author })
      dropFollowed(author)
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

  const header = (
    <View style={styles.header}>
      <Soft>{PEEK_SHORT_TEXT}</Soft>
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
            {skipped ? <HelpNote doc={HELP.ausentes}><Soft>{skipped}</Soft></HelpNote> : null}
            {meta.incomplete ? <Soft>A lista pode estar incompleta; puxe para atualizar.</Soft> : null}
          </View>
          )
        : null}
    </View>
  )

  let empty
  if (notice === 'web-only' && node.hosted !== true) {
    empty = <EmptyState icon='olho' title='Só na versão web' body={PEEK_WEB_ONLY_MESSAGE} />
  } else if (notice === 'web-only') {
    // A hosted node without a passkey identity, or a seeder without peek:
    // telling a native person to use the web would be wrong.
    empty = <EmptyState icon='olho' title='Espiadinha indisponível' body='A Espiadinha não está disponível nesta conexão.' />
  } else if (notice === 'offline') {
    empty = <EmptyState icon='olho' title='Sem conexão' body={PEEK_OFFLINE_MESSAGE} actionLabel='tentar de novo' onAction={loadFirst} />
  } else if (loadError) {
    empty = <ErrorState message={loadError} onRetry={loadFirst} pending={loading || refreshing} />
  } else if (loadedAt === null) {
    empty = <Skeleton />
  } else if (meta.diaries === 0) {
    empty = <EmptyState icon='olho' title='Ninguém para espiar ainda' body='Quando mais pessoas publicarem, as publicações delas aparecem aqui.' actionLabel={typeof onPublish === 'function' ? 'publicar' : undefined} onAction={typeof onPublish === 'function' ? onPublish : undefined} />
  } else {
    empty = <EmptyState icon='olho' title='Ainda não chegou nada' body='Quando houver publicações de quem você não segue, elas aparecem aqui.' actionLabel='atualizar' onAction={loadFirst} />
  }

  const reportable = (item) => hosted && typeof onReport === 'function' && typeof ownKey === 'string' && item.author !== ownKey
  // The node never returns the own diary's rows; the guard stays so that no
  // row offers 'seguir' before the own key is known (it could be the own
  // one), and, as defence in depth, never on an own-key row.
  const canFollow = (author) => typeof ownKey === 'string' && typeof author === 'string' && author.toLowerCase() !== ownKey.toLowerCase()
  const handlers = { onOpenThread, onOpenMember, onOpenMention, onOpenEngagers, onReply, onQuote, onReport }
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
  const renderItem = ({ item }) => rowOf(item)

  const shownItems = notice === null ? items : []
  return (
    <RefreshableList
      data={shownItems}
      keyExtractor={peekKey}
      renderItem={renderItem}
      extraData={{ now, following, social: social.social, names: names.profileOf }}
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
  header: { padding: 16, gap: 8 },
  footer: { padding: 16, gap: 8 }
})
