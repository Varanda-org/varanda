// Avisos: who followed you (and whom you do not follow yet), who replied,
// quoted or mentioned you, and who liked or reposted your posts, newest
// first. A follow row opens the person's profile (the Seguir button is
// there) and leaves on the next read once you follow back (App.js bumps `refresh` on any follow change). A
// reply, quote or mention has no pill and opens that post. A like or repost
// has no pill and opens the caller's post when the row has a ref, and stays
// disabled when it does not. Private and quiet: no counts, a plain dot never
// a number, and no push. Nothing is persisted except the notices already
// seen, as the node's opaque `seen` tokens (keyed by the identity secret,
// never a follower key or anything derivable from one; seenStore.*: browser
// localStorage, or a file in the app's document dir on native). Hosted only:
// on a manually configured node and varanda-serve the tab says so and never
// calls notices.list. The screen stays mounted, so it polls
// while node.visible and online (that is how the dot lights up).
// Acting as a page, the same screen reads that page's notices
// (pagesNotices), titles them with the page's name and keeps seen tokens
// under a page namespace in this same store. Switching who you act as
// clears the list. The personal poll is untouched while you act as
// yourself. A page has no push opt-in. One line says the association
// reads the page's notices, once per session.
// Names come from the item, never from a key. Rules: docs/app.md.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { NOTICES_LIMIT_DEFAULT, displayText } from '@varanda/rpc'
import { get as actingGet, subscribe as actingSubscribe } from '../actingAs'
import { relativeTime } from '../format'
import { useNode } from '../node'
import {
  ACTIVITY_QUIET_TEXT, EMPTY_TEXT, EMPTY_TITLE, NOTICES_INCOMPLETE_TEXT, NOTICES_OFFLINE_MESSAGE, NOTICES_POLL_MS,
  NOTICES_UNSUPPORTED_MESSAGE, NOTICES_WEB_ONLY_MESSAGE, PAGE_EMPTY_TEXT, PAGE_EMPTY_TITLE, PAGE_NOTICES_READ_LINE, PAGE_NOTICES_UNAVAILABLE_TITLE, SEEN_MAX,
  compareNotices, hasNew, hasPageSeenNamespaces, isLastNoticesPage, isPageNoticesUnavailable, isPageSeenNamespace, isWebOnlyError, markSeenPadded, mergePage, noticeId, noticeKind, noticeLine, noticeRef, noticesNotice,
  padSeen, pageNoticesHeader, pageSeenNamespace, parseSeenNamespace, readNotices, shouldPoll, writeSeenNamespace
} from '../notices'
import { pagesNotices } from '../pages'
import { LOCKED_MESSAGE } from '../outbox'
import { shouldReloadOnShow } from '../paging'
import { clearSeenText, loadSeenText, saveSeenText } from '../seenStore'
import { whoOf } from '../who'
import { Soft, errorText, useBottomPad, useNow } from '../ui'
import { useStyles } from '../ui/ThemeProvider'
import { Avatar } from '../ui/Avatar'
import { RefreshableList } from '../ui/RefreshableList'
import { EmptyState, ErrorState, ListFooter, Skeleton } from '../ui/States'
import { type } from '../ui/theme'

function useActing () {
  return useSyncExternalStore(actingSubscribe, actingGet, actingGet)
}

// Shown the first time this session is acting as a page, then not again.
let pageReadLineUsed = false

function usePageReadLine (active) {
  const [show, setShow] = useState(() => active && !pageReadLineUsed)
  useEffect(() => {
    if (!active) {
      if (show) pageReadLineUsed = true
      if (show) setShow(false)
      return
    }
    if (!pageReadLineUsed && !show) setShow(true)
  }, [active, show])
  return show && active
}

const KEY64 = /^[0-9a-f]{64}$/i

// Peer name, then @nome. A raw key is not a name, so it is skipped.
function pageDisplayName (acting) {
  const name = typeof acting.name === 'string' ? displayText(acting.name).trim() : ''
  if (name !== '' && !KEY64.test(name)) return name
  const username = typeof acting.username === 'string' ? displayText(acting.username).trim() : ''
  const bare = username.startsWith('@') ? username.slice(1) : username
  if (bare === '' || KEY64.test(bare)) return ''
  return '@' + bare
}

// pagesNotices answers the notices.list shape. A missing field is the same
// default readNotices uses (activity and supported true, next null).
function noticePageFromService (data) {
  const page = data && typeof data === 'object' ? data : {}
  return {
    notices: Array.isArray(page.notices) ? page.notices : [],
    next: Object.hasOwn(page, 'next') ? page.next : null,
    incomplete: page.incomplete === true,
    supported: page.supported !== false,
    activity: page.activity !== false
  }
}

const isLockedError = (err) => Boolean(err && err.code === 'USAGE' && err.message === LOCKED_MESSAGE)
// The node reads one page at a time: a load that meets a read in flight (a
// background poll) is not an error, it is tried again shortly.
const BUSY_MESSAGE = 'avisos já em andamento'
const BUSY_RETRY_MS = 1500
const isBusyError = (err) => Boolean(err && err.code === 'USAGE' && err.message === BUSY_MESSAGE)
// A busy node on a next page: shown with its retry, or the list would stall.
const AVISOS_BUSY_MORE = 'Os avisos ainda estão carregando. Tente de novo.'

// The seen ids of this namespace (the person's own key, or `page:<key>`).
// A stored entry that is not a v3 entry for this namespace (none, corrupt,
// another identity's, a v1 list of follower keys or a v2 list of salted
// digests) is REMOVED at once, which wipes any old format on the first
// hosted load. A page list in the same blob is kept. Never throws.
function loadSeen (namespace) {
  let ids = []
  let text = null
  try {
    text = loadSeenText()
    ids = parseSeenNamespace(text, namespace)
  } catch {}
  if (randomBytes === null) {
    // Nothing is written without a random source; an entry this browser
    // cannot pad (old format, another identity) goes. A page namespace
    // shares the blob, so an empty personal read must not wipe it.
    if (ids.length === 0 && !isPageSeenNamespace(namespace)) {
      let keep = false
      try { keep = hasPageSeenNamespaces(text) } catch {}
      if (!keep) clearSeenText()
    }
    return { ids }
  }
  // The entry always exists and always holds SEEN_MAX entries, even before
  // any notice was seen: neither its presence nor its length tells anything.
  if (ids.length < SEEN_MAX) {
    try {
      ids = padSeen(ids, randomBytes)
      writeSeen(namespace, ids)
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
// The other namespace (the person, or each page) stays in the same text.
function writeSeen (namespace, ids) {
  if (randomBytes === null || ids.length !== SEEN_MAX) return
  if (typeof namespace !== 'string' || namespace.length === 0) return
  try {
    saveSeenText(writeSeenNamespace(loadSeenText(), namespace, ids))
  } catch {}
}

// A poll's first page merged into the list: every current row stays (a poll
// never drops what was paged in) and compareNotices puts a row that arrives
// late in place.
function prependNew (currentItems, pageItems) {
  const { items } = mergePage(currentItems, pageItems)
  return items.slice().sort(compareNotices)
}

// A follow row opens the person's profile. A reply, quote or mention opens
// the post. A like or repost opens the caller's post when noticeRef has one,
// and stays disabled when it does not (not a profile, and no post to open).
function NoticeRow ({ item, now, onOpenMember, onOpenThread }) {
  const styles = useStyles(makeStyles)
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
    const ref = noticeRef(item)
    const open = ref !== null && typeof onOpenThread === 'function' ? () => onOpenThread({ ref }) : undefined
    return (
      <Pressable
        style={({ pressed }) => [styles.row, pressed && open && styles.pressed]}
        accessibilityRole='link'
        accessibilityLabel={ref === null ? line : line + ', abrir publicação'}
        accessibilityHint={ref === null ? undefined : 'abre a conversa'}
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
  const styles = useStyles(makeStyles)
  const node = useNode()
  const now = useNow(60000)
  const bottomPad = useBottomPad()
  const acting = useActing()
  const pageKey = acting.kind === 'page' ? acting.key : null
  const hosted = node.hosted === true && node.passkey !== null
  // The association line is a page notice, and only while the list can load.
  const showReadLine = usePageReadLine(hosted && pageKey !== null)
  const pageHeader = pageKey ? pageNoticesHeader(pageDisplayName(acting)) : null
  // Person: the own key, unchanged. Page: `page:<key>`, never that key.
  const seenNamespace = pageKey ? (pageSeenNamespace(pageKey) || '') : (typeof ownKey === 'string' ? ownKey : '')
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
    pageUnavailable: false,
    locked: false
  })
  const { items, atEnd, loading, loadingMore, refreshing, loadError, moreError, loadedAt, incomplete, activity, unsupported, notSupportedByNode, pageUnavailable, locked } = state
  const stateRef = useRef(state)
  // Only the latest read may commit; the ref also blocks duplicate end reaches.
  const seqRef = useRef(0)
  const commit = useCallback((patch) => {
    stateRef.current = { ...stateRef.current, ...patch }
    setState(stateRef.current)
  }, [])
  const { request } = node
  const pageKeyRef = useRef(pageKey)
  pageKeyRef.current = pageKey
  const ownKeyRef = useRef(ownKey)
  ownKeyRef.current = ownKey
  // Every read goes through readNotices: a short page that still has a
  // cursor (a gap of candidates the node filtered out) is followed by the
  // pages after it, a bounded number of times, so the followers behind the
  // gap show without a tap; a read that stopped being the latest reads no
  // further page. Acting as yourself calls notices.list, as before. Acting
  // as a page calls pagesNotices once per page of that loop. No push opt-in
  // either way: a page has none.
  const read = useCallback((mine, after = null) => {
    const live = () => mine === seqRef.current
    const opts = { limit: NOTICES_LIMIT_DEFAULT, after, live }
    if (!pageKeyRef.current) return readNotices(request, opts)
    const page = pageKeyRef.current
    return readNotices(async (method, params) => {
      if (method !== 'notices.list') throw new Error('Pedido inválido')
      const member = typeof ownKeyRef.current === 'string' ? ownKeyRef.current.toLowerCase() : ''
      const data = await pagesNotices({ request }, {
        member,
        page,
        after: params ? params.after : undefined,
        limit: params ? params.limit : undefined
      })
      return noticePageFromService(data)
    }, opts)
  }, [request])

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
  // loaded is seen at once.
  const settle = useCallback((list, mark = activeRef.current) => {
    // Before the identity is known nothing is read or written: an entry
    // stored for `own: null` would replace the real one.
    if (seenNamespace.length === 0) {
      badge(!mark && hasNew(list, []))
      return
    }
    if (seenRef.current === null) seenRef.current = loadSeen(seenNamespace)
    const seen = seenRef.current
    if (mark) {
      if (randomBytes === null) {
        // No random source: remembered in memory only, never written.
        seen.ids = [...new Set(seen.ids.concat(list.map((item) => item.seen)))]
      } else {
        const { ids, changed } = markSeenPadded(seen.ids, list, randomBytes)
        if (changed) {
          seen.ids = ids
          writeSeen(seenNamespace, ids)
        }
      }
      badge(false)
    } else {
      badge(hasNew(list, seen.ids))
    }
  }, [seenNamespace, badge])

  // Another identity has its own seen ids. Loaded at once when hosted, so a
  // stored entry of an old format (v1 follower keys, v2 salted digests) is
  // removed on the first load, not only at the first settle. A page uses
  // its own namespace in the same store.
  useEffect(() => {
    seenRef.current = hosted && seenNamespace.length > 0 ? loadSeen(seenNamespace) : null
  }, [seenNamespace, hosted])

  const loadFirst = useCallback(async () => {
    const current = stateRef.current
    if (!hosted || current.unsupported || current.locked) return
    if (pageKeyRef.current && typeof ownKeyRef.current !== 'string') return
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
        pageUnavailable: false,
        loadedAt: Date.now(),
        loading: false,
        refreshing: false
      })
      settle(merged)
    } catch (err) {
      if (mine !== seqRef.current) return
      if (pageKeyRef.current && isPageNoticesUnavailable(err)) {
        commit({ items: [], next: null, atEnd: true, pageUnavailable: true, loadedAt: Date.now(), loading: false, refreshing: false })
        badge(false)
      } else if (isWebOnlyError(err)) {
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
    if (pageKeyRef.current && typeof ownKeyRef.current !== 'string') return
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
        pageUnavailable: false,
        incomplete: stateRef.current.incomplete || page.incomplete === true,
        activity: page.activity !== false,
        loadError: ''
      })
      settle(merged)
    } catch (err) {
      if (mine !== seqRef.current) return
      if (pageKeyRef.current && isPageNoticesUnavailable(err)) {
        commit({ items: [], next: null, atEnd: true, pageUnavailable: true, loadedAt: stateRef.current.loadedAt === null ? Date.now() : stateRef.current.loadedAt })
        badge(false)
      } else if (isWebOnlyError(err)) {
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

  // Who you act as changed: the other list must not stay on screen. The
  // personal poll (notices.list, same interval) resumes when acting is you.
  const actingKey = pageKey || ''
  const actingKeyRef = useRef(actingKey)
  useEffect(() => {
    if (actingKeyRef.current === actingKey) return
    actingKeyRef.current = actingKey
    seqRef.current += 1
    seenRef.current = null
    clearTimeout(busyRetryRef.current)
    busyRetryRef.current = null
    backoffRef.current = false
    commit({
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
      activity: true,
      unsupported: false,
      notSupportedByNode: false,
      pageUnavailable: false,
      locked: false
    })
    badge(false)
    if (loadFirstRef.current) loadFirstRef.current()
  }, [actingKey, commit, badge])

  // The page read is signed as the member. ownKey can arrive after the
  // first paint; the personal list does not reload for that.
  const memberRef = useRef(ownKey)
  useEffect(() => {
    if (memberRef.current === ownKey) return
    memberRef.current = ownKey
    if (!pageKeyRef.current) return
    if (loadFirstRef.current) loadFirstRef.current()
  }, [ownKey])

  // Unlock, lock or reset: a locked answer is no longer true.
  const generationRef = useRef(generation)
  useEffect(() => {
    if (generation === generationRef.current) return
    generationRef.current = generation
    commit({ locked: false, loadError: '' })
    seenRef.current = null
  }, [generation, commit])

  // The poll runs even when the tab is not active (the screen stays mounted).
  const polling = shouldPoll({ hosted, online: node.online, visible: node.visible }) && !unsupported && !locked
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

  const notice = noticesNotice({ hosted, supported: !(unsupported || notSupportedByNode), online: node.online, loadedAt })

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
  } else if (pageUnavailable && pageKey) {
    empty = <EmptyState icon='sino' title={PAGE_NOTICES_UNAVAILABLE_TITLE} body='' />
  } else if (loadError) {
    empty = <ErrorState message={loadError} onRetry={locked ? () => { commit({ locked: false, loadError: '' }); loadFirst() } : loadFirst} pending={loading || refreshing} />
  } else if (loadedAt === null) {
    empty = <Skeleton />
  } else {
    empty = pageKey
      ? <EmptyState icon='sino' title={PAGE_EMPTY_TITLE} body={PAGE_EMPTY_TEXT} />
      : <EmptyState icon='sino' title={EMPTY_TITLE} body={EMPTY_TEXT} />
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
  // No push opt-in for a page: this header is the name and, once per
  // session, the line that the association reads the page's notices.
  const banner = pageHeader
    ? (
      <View style={styles.footer}>
        <Text style={styles.pageTitle} accessibilityRole='header' numberOfLines={2}>{pageHeader}</Text>
        {showReadLine ? <Soft>{PAGE_NOTICES_READ_LINE}</Soft> : null}
      </View>
      )
    : null
  let header = null
  if (showQuiet) {
    header = (
      <View>
        {banner}
        <View style={styles.footer}><Soft>{ACTIVITY_QUIET_TEXT}</Soft></View>
        {showLoadError ? <ErrorState message={loadError} onRetry={loadFirst} pending={refreshing} /> : null}
      </View>
    )
  } else if (showLoadError) {
    header = banner
      ? (
        <View>
          {banner}
          <ErrorState message={loadError} onRetry={loadFirst} pending={refreshing} />
        </View>
        )
      : <ErrorState message={loadError} onRetry={loadFirst} pending={refreshing} />
  } else if (banner) {
    header = banner
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

const makeStyles = (colors) => StyleSheet.create({
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
  footer: { padding: 16, gap: 8 },
  pageTitle: { ...type.emptyTitle, color: colors.ink }
})
