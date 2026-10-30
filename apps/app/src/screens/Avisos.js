// Avisos: who followed you (and whom you do not follow yet), and who replied,
// quoted or mentioned you, newest first. A follow row opens the person's
// profile (the Seguir button is there) and leaves on the next read once you
// follow back (App.js bumps `refresh` on any follow change). A reply, quote or
// mention has no pill and opens that post. Private and quiet: no counts, a plain dot never
// a number, and no push. Nothing is persisted except the notices already
// seen, as the node's opaque `seen` tokens (keyed by the identity secret,
// never a follower key or anything derivable from one; web only,
// localStorage). Hosted web only: on native and varanda-serve the tab says
// so and never calls notices.list. The screen stays mounted, so it polls
// while the page is visible and online (that is how the dot lights up).
// Names come from the item, never from a key. Rules: docs/app.md.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native'
import { NOTICES_LIMIT_DEFAULT, displayText } from '@varanda/rpc'
import { relativeTime } from '../format'
import { useNode } from '../node'
import {
  ACTIVITY_QUIET_TEXT, EMPTY_TEXT, EMPTY_TITLE, NOTICES_INCOMPLETE_TEXT, NOTICES_OFFLINE_MESSAGE, NOTICES_POLL_MS,
  NOTICES_UNSUPPORTED_MESSAGE, NOTICES_WEB_ONLY_MESSAGE, SEEN_MAX, SEEN_STORAGE_KEY,
  compareNotices, hasNew, isLastNoticesPage, isWebOnlyError, markSeenPadded, mergePage, noticeId, noticeKind, noticeLine, noticeRef, noticesNotice,
  padSeen, parseSeen, readNotices, serializeSeen, shouldPoll
} from '../notices'
import { LOCKED_MESSAGE } from '../outbox'
import { shouldReloadOnShow } from '../paging'
import { whoOf } from '../who'
import { Soft, colors, errorText, useBottomPad, useNow } from '../ui'
import { Avatar } from '../ui/Avatar'
import { RefreshableList } from '../ui/RefreshableList'
import { EmptyState, ErrorState, ListFooter, Skeleton } from '../ui/States'
import { type } from '../ui/theme'

const web = Platform.OS === 'web'

const isLockedError = (err) => Boolean(err && err.code === 'USAGE' && err.message === LOCKED_MESSAGE)
// The node reads one page at a time: a load that meets a read in flight (a
// background poll) is not an error, it is tried again shortly.
const BUSY_MESSAGE = 'avisos já em andamento'
const BUSY_RETRY_MS = 1500
const isBusyError = (err) => Boolean(err && err.code === 'USAGE' && err.message === BUSY_MESSAGE)
// A busy node on a next page: shown with its retry, or the list would stall.
const AVISOS_BUSY_MORE = 'Os avisos ainda estão carregando. Tente de novo.'

// The seen ids of this identity (the node's `seen` tokens). A stored entry
// that is not a v3 entry for this identity (none, corrupt, another
// identity's, a v1 list of follower keys or a v2 list of salted digests) is
// REMOVED at once, which wipes any old format on the first hosted load.
// Never throws.
function loadSeen (ownKey) {
  let ids = []
  try {
    ids = parseSeen(globalThis.localStorage.getItem(SEEN_STORAGE_KEY), ownKey)
  } catch {}
  if (!web) return { ids }
  if (randomBytes === null) {
    // Nothing is written without a random source; an entry this browser
    // cannot pad (old format, another identity) goes.
    if (ids.length === 0) {
      try { globalThis.localStorage.removeItem(SEEN_STORAGE_KEY) } catch {}
    }
    return { ids }
  }
  // The entry always exists and always holds SEEN_MAX entries, even before
  // any notice was seen: neither its presence nor its length tells anything.
  if (ids.length < SEEN_MAX) {
    try {
      ids = padSeen(ids, randomBytes)
      writeSeen(ownKey, ids)
    } catch {}
  }
  return { ids }
}

// The random source for the padding of the stored seen list. Without
// crypto.getRandomValues there is none: the seen list then stays in memory
// only and is never written (an unpadded list would show how many notices
// were seen).
const randomBytes = typeof globalThis.crypto?.getRandomValues === 'function'
  ? (n) => globalThis.crypto.getRandomValues(new Uint8Array(n))
  : null

// Only ever writes the padded list: exactly SEEN_MAX 32-hex entries.
function writeSeen (ownKey, ids) {
  if (!web || randomBytes === null || ids.length !== SEEN_MAX) return
  try {
    globalThis.localStorage.setItem(SEEN_STORAGE_KEY, serializeSeen(ownKey, ids))
  } catch {}
}

// A poll's first page merged into the list: every current row stays (a poll
// never drops what was paged in) and compareNotices puts a row that arrives
// late in place.
function prependNew (currentItems, pageItems) {
  const { items } = mergePage(currentItems, pageItems)
  return items.slice().sort(compareNotices)
}

function pageVisible () {
  return typeof document === 'undefined' || document.visibilityState === 'visible'
}

// A follow row opens the person's profile. A reply, quote or mention opens
// the post.
function NoticeRow ({ item, now, onOpenMember, onOpenThread }) {
  const who = whoOf({ name: item.name, username: item.username })
  const subtitle = who.subtitle ? displayText(who.subtitle) : null
  const time = relativeTime(item.at, now)
  const kind = noticeKind(item)
  const line = displayText(noticeLine(who, kind))
  const whoBlock = (
    <View style={styles.who}>
      <Text style={styles.name} numberOfLines={1}>{line}</Text>
      {subtitle ? <Text style={styles.handle} numberOfLines={1}>{subtitle}</Text> : null}
      {time ? <Text style={styles.handle} numberOfLines={1}>{time}</Text> : null}
    </View>
  )
  if (kind !== 'follow') {
    const open = typeof onOpenThread === 'function' ? () => onOpenThread({ ref: noticeRef(item) }) : undefined
    return (
      <Pressable
        style={({ pressed }) => [styles.row, pressed && open && styles.pressed]}
        accessibilityRole='link'
        accessibilityLabel={line + ', abrir publicação'}
        accessibilityHint='abre a conversa'
        disabled={!open}
        onPress={open}
      >
        <Avatar name={who.avatarName} publicKey={item.key} size={44} picture={item.avatar} persist={false} />
        {whoBlock}
      </Pressable>
    )
  }
  const open = typeof onOpenMember === 'function'
    ? () => onOpenMember(item.key, { name: item.name, username: item.username, avatar: item.avatar || null })
    : undefined
  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && open && styles.pressed]}
      accessibilityRole='link'
      accessibilityLabel={line + ', ver perfil'}
      accessibilityHint='abre o perfil'
      disabled={!open}
      onPress={open}
    >
      <Avatar name={who.avatarName} publicKey={item.key} size={44} picture={item.avatar} persist={false} />
      {whoBlock}
    </Pressable>
  )
}

export default function Avisos ({ active, refresh, ownKey, scrollToTop, onFollowsChanged, onToast, onBadge, onOpenThread, onOpenMember }) {
  const node = useNode()
  const now = useNow(60000)
  const bottomPad = useBottomPad()
  const hosted = node.hosted === true && node.passkey !== null
  const generation = node.passkey ? node.passkey.generation : 0
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
    incomplete: false,
    // True until a read says otherwise. activity false is the quiet line, not
    // an empty list: an answer that omits the field is not that state.
    activity: true,
    unsupported: false,
    notSupportedByNode: false,
    locked: false
  })
  const { items, atEnd, loading, loadingMore, refreshing, loadError, moreError, loadedAt, incomplete, activity, unsupported, notSupportedByNode, locked } = state
  const stateRef = useRef(state)
  // Only the latest read may commit; the ref also blocks duplicate end reaches.
  const seqRef = useRef(0)
  const commit = useCallback((patch) => {
    stateRef.current = { ...stateRef.current, ...patch }
    setState(stateRef.current)
  }, [])
  const { request } = node
  // Every read goes through readNotices: a short page that still has a
  // cursor (a gap of candidates the node filtered out) is followed by the
  // pages after it, a bounded number of times, so the followers behind the
  // gap show without a tap; a read that stopped being the latest reads no
  // further page.
  const read = useCallback((mine, after = null) => readNotices(request, {
    limit: NOTICES_LIMIT_DEFAULT,
    after,
    live: () => mine === seqRef.current
  }), [request])

  const activeRef = useRef(active)
  activeRef.current = active
  const onBadgeRef = useRef(onBadge)
  onBadgeRef.current = onBadge
  const seenRef = useRef(null)
  // Set after a poll failed with a non-locked, non-web-only error: the next
  // tick is skipped once.
  const backoffRef = useRef(false)
  const busyRetryRef = useRef(null)
  const loadFirstRef = useRef(null)

  const badge = useCallback((value) => {
    if (typeof onBadgeRef.current === 'function') onBadgeRef.current(value)
  }, [])

  // The dot follows what is unseen; with the tab open (mark) everything
  // loaded is seen at once (web only: native never stores anything).
  const settle = useCallback((list, mark = activeRef.current) => {
    if (!web) {
      badge(false)
      return
    }
    // Before the identity is known nothing is read or written: an entry
    // stored for `own: null` would replace the real one.
    if (typeof ownKey !== 'string' || ownKey.length === 0) {
      badge(!mark && hasNew(list, []))
      return
    }
    if (seenRef.current === null) seenRef.current = loadSeen(ownKey)
    const seen = seenRef.current
    if (mark) {
      if (randomBytes === null) {
        // No random source: remembered in memory only, never written.
        seen.ids = [...new Set(seen.ids.concat(list.map((item) => item.seen)))]
      } else {
        const { ids, changed } = markSeenPadded(seen.ids, list, randomBytes)
        if (changed) {
          seen.ids = ids
          writeSeen(ownKey, ids)
        }
      }
      badge(false)
    } else {
      badge(hasNew(list, seen.ids))
    }
  }, [ownKey, badge])

  // Another identity has its own seen ids. Loaded at once when hosted, so a
  // stored entry of an old format (v1 follower keys, v2 salted digests) is
  // removed on the first load, not only at the first settle.
  useEffect(() => {
    seenRef.current = web && hosted && typeof ownKey === 'string' && ownKey.length > 0 ? loadSeen(ownKey) : null
  }, [ownKey, hosted])

  const loadFirst = useCallback(async () => {
    const current = stateRef.current
    if (!hosted || current.unsupported || current.locked) return
    const mine = ++seqRef.current
    commit({
      loading: current.loadedAt === null,
      refreshing: current.loadedAt !== null,
      loadingMore: false,
      loadError: '',
      moreError: ''
    })
    try {
      const page = await read(mine)
      if (mine !== seqRef.current) return
      backoffRef.current = false
      if (page.supported === false) {
        commit({ items: [], next: null, atEnd: true, notSupportedByNode: true, loadedAt: Date.now(), loading: false, refreshing: false })
        badge(false)
        return
      }
      const merged = mergePage([], page.notices).items
      commit({
        items: merged,
        next: page.next,
        atEnd: isLastNoticesPage(page),
        incomplete: page.incomplete === true,
        activity: page.activity !== false,
        notSupportedByNode: false,
        loadedAt: Date.now(),
        loading: false,
        refreshing: false
      })
      settle(merged)
    } catch (err) {
      if (mine !== seqRef.current) return
      if (isWebOnlyError(err)) {
        // An old node bundle or a native / serve node: never asked again.
        commit({ unsupported: true, loading: false, refreshing: false })
        badge(false)
      } else if (isLockedError(err)) {
        commit({ locked: true, loading: false, refreshing: false, loadError: errorText(err) })
      } else if (isBusyError(err)) {
        commit({ loading: false, refreshing: false })
        clearTimeout(busyRetryRef.current)
        busyRetryRef.current = setTimeout(() => {
          busyRetryRef.current = null
          if (mine === seqRef.current && loadFirstRef.current) loadFirstRef.current()
        }, BUSY_RETRY_MS)
      } else {
        backoffRef.current = true
        commit({ loading: false, refreshing: false, loadError: errorText(err) })
      }
    }
  }, [hosted, read, commit, settle, badge])
  loadFirstRef.current = loadFirst

  const loadMore = useCallback(async () => {
    const current = stateRef.current
    if (!active || !hosted || current.loading || current.refreshing || current.loadingMore || current.atEnd || current.next === null) return
    const mine = ++seqRef.current
    const after = current.next
    commit({ loadingMore: true, moreError: '' })
    try {
      // readNotices ends the list on a cursor that did not move.
      const page = await read(mine, after)
      if (mine !== seqRef.current) return
      const merged = mergePage(stateRef.current.items, page.notices).items
      commit({
        items: merged,
        next: page.next,
        atEnd: isLastNoticesPage(page),
        incomplete: stateRef.current.incomplete || page.incomplete === true,
        activity: stateRef.current.activity !== false && page.activity !== false,
        loadingMore: false
      })
      settle(merged)
    } catch (err) {
      if (mine === seqRef.current) commit({ loadingMore: false, moreError: isBusyError(err) ? AVISOS_BUSY_MORE : errorText(err) })
    }
  }, [active, hosted, read, commit, settle])

  // A poll reads the first page without replacing the list. Tab not shown:
  // only the dot is refreshed (the list reloads when the tab is shown). Tab
  // shown: new rows are merged on top and the cursor is kept. Rows gone
  // upstream (unfollowed, followed back elsewhere) stay until the next full
  // load (pull-to-refresh, show, refresh bump, follows change). It takes a
  // sequence number like any read, so a later full load or page wins.
  const poll = useCallback(async () => {
    const current = stateRef.current
    if (!hosted || current.unsupported || current.locked) return
    if (activeRef.current && current.loadedAt === null) {
      loadFirst()
      return
    }
    const mine = ++seqRef.current
    try {
      const page = await read(mine)
      if (mine !== seqRef.current) return
      backoffRef.current = false
      if (page.supported === false) {
        commit({ items: [], next: null, atEnd: true, notSupportedByNode: true, loadedAt: Date.now() })
        badge(false)
        return
      }
      if (!activeRef.current || stateRef.current.loadedAt === null) {
        if ((page.activity === false) !== (stateRef.current.activity === false)) {
          commit({ activity: page.activity !== false })
        }
        settle(page.notices, false)
        return
      }
      // A full first page whose last row is not on screen yet may leave a gap
      // between it and the rows already shown, which paging could never
      // reach: reload the list instead of merging.
      const known = new Set(stateRef.current.items.map(noticeId))
      const last = page.notices[page.notices.length - 1]
      if (page.next !== null && last !== undefined && !known.has(noticeId(last))) {
        loadFirst()
        return
      }
      const merged = prependNew(stateRef.current.items, page.notices)
      commit({
        items: merged,
        notSupportedByNode: false,
        incomplete: stateRef.current.incomplete || page.incomplete === true,
        activity: page.activity !== false,
        loadError: ''
      })
      settle(merged)
    } catch (err) {
      if (mine !== seqRef.current) return
      if (isWebOnlyError(err)) {
        commit({ unsupported: true })
        badge(false)
      } else if (isLockedError(err)) {
        commit({ locked: true, loadError: errorText(err) })
      } else if (!isBusyError(err)) {
        backoffRef.current = true
        commit({ loadError: errorText(err) })
      }
    }
  }, [hosted, read, commit, settle, badge, loadFirst])

  // Reload rules as Espiadinha: first show, a reselect after 60 s, a refresh bump.
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
    else if (shown && current.loadedAt !== null) settle(current.items)
  }, [active, refresh, scrollToTop, loadFirst, settle])

  // Follows changed (here or on another device): the list is read again, also
  // while the tab is not shown.
  const followsVersion = node.followsVersion
  const followsRef = useRef(followsVersion)
  useEffect(() => {
    if (followsVersion === followsRef.current) return
    followsRef.current = followsVersion
    if (!stateRef.current.loading && !stateRef.current.refreshing) loadFirst()
  }, [followsVersion, loadFirst])

  // Unlock, lock or reset: a locked answer is no longer true.
  const generationRef = useRef(generation)
  useEffect(() => {
    if (generation === generationRef.current) return
    generationRef.current = generation
    commit({ locked: false, loadError: '' })
    seenRef.current = null
  }, [generation, commit])

  // The poll runs even when the tab is not active (the screen stays mounted).
  const [visible, setVisible] = useState(pageVisible)
  useEffect(() => {
    if (typeof document === 'undefined') return
    const onChange = () => setVisible(pageVisible())
    document.addEventListener('visibilitychange', onChange)
    return () => document.removeEventListener('visibilitychange', onChange)
  }, [])
  const polling = shouldPoll({ hosted, online: node.online, visible }) && !unsupported && !locked
  useEffect(() => {
    if (!polling) return
    const timer = setInterval(() => {
      if (backoffRef.current) {
        backoffRef.current = false
        return
      }
      const current = stateRef.current
      if (current.loading || current.refreshing || current.loadingMore) return
      poll()
    }, NOTICES_POLL_MS)
    return () => clearInterval(timer)
  }, [polling, poll])

  useEffect(() => () => {
    clearTimeout(busyRetryRef.current)
    seqRef.current += 1
    previous.current.active = false
    stateRef.current = { ...stateRef.current, loading: false, loadingMore: false, refreshing: false }
  }, [])

  const notice = unsupported
    ? 'web-only'
    : noticesNotice({ hosted, supported: !notSupportedByNode, online: node.online, loadedAt })

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
      {incomplete ? <View style={styles.footer}><Soft>{NOTICES_INCOMPLETE_TEXT}</Soft></View> : null}
    </View>
  )

  let empty
  if (notice === 'web-only') {
    empty = <EmptyState icon='sino' title='Só na versão web' body={NOTICES_WEB_ONLY_MESSAGE} />
  } else if (notice === 'unsupported') {
    empty = <EmptyState icon='sino' title='Sem avisos por aqui' body={NOTICES_UNSUPPORTED_MESSAGE} />
  } else if (notice === 'offline') {
    empty = <EmptyState icon='sino' title='Sem conexão' body={NOTICES_OFFLINE_MESSAGE} actionLabel='tentar de novo' onAction={loadFirst} />
  } else if (loadError) {
    empty = <ErrorState message={loadError} onRetry={locked ? () => { commit({ locked: false, loadError: '' }); loadFirst() } : loadFirst} pending={loading || refreshing} />
  } else if (loadedAt === null) {
    empty = <Skeleton />
  } else {
    empty = <EmptyState icon='sino' title={EMPTY_TITLE} body={EMPTY_TEXT} />
  }

  const renderItem = ({ item }) => (
    <NoticeRow
      item={item}
      now={now}
      onOpenMember={onOpenMember}
      onOpenThread={onOpenThread}
    />
  )

  // activity false: this seeder still only sends follows. The rows stay; the
  // line says the rest are not available here. Web-only, unsupported and
  // offline stay on noticesNotice, and a locked read stays the error it was.
  const showQuiet = notice === null && activity === false && loadedAt !== null
  const showLoadError = notice === null && items.length > 0 && loadError
  let header = null
  if (showQuiet) {
    header = (
      <View>
        <View style={styles.footer}><Soft>{ACTIVITY_QUIET_TEXT}</Soft></View>
        {showLoadError ? <ErrorState message={loadError} onRetry={loadFirst} pending={refreshing} /> : null}
      </View>
    )
  } else if (showLoadError) {
    header = <ErrorState message={loadError} onRetry={loadFirst} pending={refreshing} />
  }

  const shownItems = notice === null ? items : []
  return (
    <RefreshableList
      data={shownItems}
      keyExtractor={noticeId}
      renderItem={renderItem}
      extraData={{ now, onOpenMember, onOpenThread }}
      ListHeaderComponent={header}
      ListEmptyComponent={empty}
      ListFooterComponent={notice === null ? footer : null}
      contentContainerStyle={{ paddingBottom: bottomPad }}
      onRefresh={hosted && !unsupported && !locked ? loadFirst : undefined}
      refreshing={refreshing}
      onLoadMore={active && hosted && !moreError && !loading && state.next !== null ? loadMore : undefined}
      loadingMore={loadingMore}
      loadMoreError={!!moreError}
      atEnd={atEnd}
      scrollToTopSignal={scrollToTop}
    />
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: colors.line
  },
  who: { flex: 1, minWidth: 0 },
  name: { ...type.postName, color: colors.ink },
  handle: { ...type.postMeta, color: colors.soft },
  pressed: { opacity: 0.6 },
  footer: { padding: 16, gap: 8 }
})
