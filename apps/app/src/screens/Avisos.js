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
// The node's row avatar covers only the blocks it read for the row, so a
// missing photo is completed from the names cache or one hinted diary.peek of
// the author's profile block, in memory only, bytes still verified by Avatar.
// Names come from the item, never from a key. Rules: docs/app.md.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { NOTICES_LIMIT_DEFAULT, displayText } from '@varanda/rpc'
import { get as actingGet, subscribe as actingSubscribe } from '../actingAs'
import { relativeTime } from '../format'
import { useNode } from '../node'
import { useBlocks } from '../blocksProvider'
import { withoutBlockedKeys } from '../memberBlocks'
import { useNames } from '../names'
import { fetchMember, invalidateMember } from '../indexClient'
import { avatarOf, pickAvatar } from '../media/avatar'
import {
  ACTIVITY_QUIET_TEXT, EMPTY_TEXT, EMPTY_TITLE, NOTICES_FIRST_READ_QUIET_MS, NOTICES_INCOMPLETE_TEXT, NOTICES_OFFLINE_MESSAGE, NOTICES_POLL_MS,
  NOTICES_UNSUPPORTED_MESSAGE, PAGE_EMPTY_TEXT, PAGE_EMPTY_TITLE, PAGE_NOTICES_READ_LINE, PAGE_NOTICES_UNAVAILABLE_TITLE, SEEN_MAX,
  compareNotices, hasNew, hasPageSeenNamespaces, isLastNoticesPage, isPageNoticesUnavailable, isPageSeenNamespace, isWebOnlyError, markSeenPadded, mergePage, mergeRemoteSeen, noticeIcon, noticeId, noticeKind, noticeLine, noticeParts, noticeRef, noticesNotice,
  needsAvatar, padSeen, pageNoticesHeader, pageSeenNamespace, parseSeenNamespace, readNotices, remoteFoldPlan, resolveRowAvatars, rowAvatarSource, seenOnScreen, seenUnion, shouldPoll, shouldStartNoticesFirstRead, snippetOf, writeSeenNamespace
} from '../notices'
import { getPeekWarmState, isSeederBusyError, subscribePeekWarm, updatePeekWarmState } from '../peek'
import { isRef } from '../nav'
import { pagesNotices } from '../pages'
import { LOCKED_MESSAGE } from '../outbox'
import { shouldReloadOnShow } from '../paging'
import { clearSeenText, loadSeenText, saveSeenText } from '../seenStore'
import { planPeeks } from '../thread'
import { whoOf } from '../who'
import { Soft, errorText, useBottomPad, useNow } from '../ui'
import { useStyles, useTheme } from '../ui/ThemeProvider'
import { Avatar } from '../ui/Avatar'
import { Icon } from '../ui/Icon'
import { PressScale } from '../ui/PressScale'
import { NOT_HOSTED } from '../pessoas'
import { HELP } from '../help'
import { HelpSheet } from '../ui/Help'
import { RefreshableList } from '../ui/RefreshableList'
import { EmptyState, ErrorState, ListFooter, SkeletonRow } from '../ui/States'
import { space, type } from '../ui/theme'
import { peekAll, postAt } from './Conversa'

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
const EMPTY_ROWS = Object.freeze([])
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
// The post a row talks about: the other person's post for a reply, quote or
// mention, the caller's own post for a like or repost. Follows have none.
// Only a canonical '<hex64>:<seq>' ref: page notices come from the pages
// service unchecked, and a ref with a comma would never split back out of
// wantedKey, so it would stay untried and re-run the read forever.
function snippetRef (item) {
  const ref = noticeRef(item)
  return isRef(ref) ? ref : null
}

const AVATAR_BATCH = 10

// The node's row avatar covers only the blocks it read for the row, so a
// profile with a photo written in between is missed; one diary.peek of the
// profile block the seeder index names fills it, in memory only, AVATAR_BATCH
// authors at a time (the index pacer allows 18 starts per 10 s). A batch
// stays frozen while in flight, so a names-cache commit for one of its
// authors cannot restart it; a new cycle (once per loadFirst, never per
// partial page) restarts it and asks every author again, so a photo set or
// removed later shows after a reload. A row whose node answer has a photo
// always wins (rowAvatarSource).
function useRowAvatars (items, cachedOf, request, enabled, cycle) {
  const [avatars, setAvatars] = useState({})
  const triedRef = useRef(new Set())
  const batchRef = useRef(null)
  const [, setRound] = useState(0)
  useEffect(() => {
    if (triedRef.current.size === 0) return
    // A reload asks the index again too (as Membro's refresh), so a photo
    // changed within the member cache's 5 minutes is not read from a stale hint.
    for (const k of triedRef.current) invalidateMember(k)
    triedRef.current.clear()
    setRound((n) => n + 1)
  }, [cycle])
  let wantedKey = ''
  if (enabled && batchRef.current !== null) {
    wantedKey = batchRef.current
  } else if (enabled) {
    const wanted = []
    for (const item of items) {
      const k = item.key
      if (triedRef.current.has(k) || wanted.includes(k)) continue
      if (!needsAvatar(item, cachedOf(k))) continue
      wanted.push(k)
      if (wanted.length === AVATAR_BATCH) break
    }
    wantedKey = wanted.join(',')
  }
  useEffect(() => {
    if (wantedKey === '' || typeof request !== 'function') return
    let alive = true
    batchRef.current = wantedKey
    const list = wantedKey.split(',')
    ;(async () => {
      // A fresh Map per chunk: peekAll's mergePeek keeps the first profile it saw.
      const peekChunk = async (chunk) => (await peekAll(request, [chunk], new Map(), () => alive)).get(chunk.author)
      let found = {}
      try {
        found = await resolveRowAvatars(list, { fetchMember, peekChunk, alive: () => alive })
      } catch {}
      if (!alive) return
      batchRef.current = null
      const next = {}
      for (const k of list) {
        triedRef.current.add(k)
        if (found[k] !== undefined) next[k] = avatarOf(found[k])
      }
      if (Object.keys(next).length > 0) setAvatars((a) => ({ ...a, ...next }))
      setRound((n) => n + 1)
    })()
    return () => {
      alive = false
      if (batchRef.current === wantedKey) batchRef.current = null
    }
  }, [wantedKey, request, cycle])
  return avatars
}

const SNIPPET_BATCH = 24

// Whether a diary.peek chunk ({ author, seqs }) asked for this canonical ref.
function chunkHas (params, ref) {
  const i = ref.indexOf(':')
  return params.author === ref.slice(0, i) && params.seqs.includes(Number(ref.slice(i + 1)))
}
const SNIPPET_TRIES = 2

// Reads the posts of the rows on screen with the node's own diary.peek, one
// batch at a time and never again for a ref already tried. A failed read just
// leaves the row without a second line. A read that throws partway keeps the
// refs it found; the rest get one more try in a later batch, then count as
// tried, so a seeder that stays down cannot loop.
function useSnippets (items, request, enabled, retryKey) {
  const [texts, setTexts] = useState({})
  const triedRef = useRef(new Set())
  const triesRef = useRef(new Map())
  const exhaustedRef = useRef(new Set())
  const [round, setRound] = useState(0)
  // A full reload of the list (loadedAt moves: pull to refresh, a reload on
  // show) gives refs that ran out of tries one more chance. The 5-minute poll
  // does not move loadedAt, so it does not retry them.
  useEffect(() => {
    if (exhaustedRef.current.size === 0) return
    for (const r of exhaustedRef.current) {
      triedRef.current.delete(r)
      triesRef.current.delete(r)
    }
    exhaustedRef.current.clear()
    setRound((n) => n + 1)
  }, [retryKey])
  const refs = enabled ? items.map(snippetRef).filter((r) => r !== null) : []
  const wanted = refs.filter((r) => !triedRef.current.has(r)).slice(0, SNIPPET_BATCH)
  const wantedKey = wanted.join(',')
  useEffect(() => {
    if (wantedKey === '' || typeof request !== 'function') return
    let alive = true
    const list = wantedKey.split(',')
    ;(async () => {
      const peeked = new Map()
      // One chunk at a time, so a throw is charged to the chunk that threw:
      // refs of chunks never asked for keep their tries for a later batch.
      const done = []
      let failedAt = null
      for (const params of planPeeks({ refs: list })) {
        if (!alive) return
        try {
          await peekAll(request, [params], peeked, () => alive)
          done.push(params)
        } catch {
          failedAt = params
          break
        }
      }
      if (!alive) return
      const found = {}
      for (const r of list) {
        const post = postAt(peeked, r)
        if (post !== null) found[r] = post.text
        if (post !== null || done.some((p) => chunkHas(p, r))) {
          triedRef.current.add(r)
        } else if (failedAt !== null && chunkHas(failedAt, r)) {
          const tries = (triesRef.current.get(r) || 0) + 1
          triesRef.current.set(r, tries)
          if (tries >= SNIPPET_TRIES) {
            triedRef.current.add(r)
            exhaustedRef.current.add(r)
          }
        }
      }
      if (Object.keys(found).length > 0) setTexts((t) => ({ ...t, ...found }))
      setRound((n) => n + 1)
    })()
    return () => { alive = false }
  }, [wantedKey, request, round])
  return texts
}

function NoticeRow ({ item, now, unread, postText, picture, onOpenMember, onOpenThread }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  const who = whoOf({ name: item.name, username: item.username })
  const subtitle = who.subtitle ? displayText(who.subtitle) : null
  const time = relativeTime(item.at, now)
  const kind = noticeKind(item)
  const parts = noticeParts(who, kind)
  const line = displayText(noticeLine(who, kind))
  const icon = noticeIcon(kind)
  const snippet = displayText(snippetOf(item, postText))
  // The row is one control: a screen reader hears the verified @nome, the
  // quoted post and the unread state the eye gets from the lines and the dot.
  const spoken = [line, subtitle, snippet ? '“' + snippet + '”' : null, unread ? 'não lido' : null].filter(Boolean).join(', ')
  const whoBlock = (
    <>
      <View style={styles.who}>
        {/* Two lines, so the action ("começou a seguir você") is read whole. */}
        <Text style={styles.name} numberOfLines={2}>
          <Text style={styles.nameBold}>{displayText(parts.name)}</Text>
          <Text style={styles.nameRest}>{displayText(parts.rest)}</Text>
        </Text>
        {subtitle ? <Text style={styles.handle} numberOfLines={1}>{subtitle}</Text> : null}
        {/* Post text never takes the verified @nome's place or style: a post
            that reads "@maria" must not pass as the sender's handle. */}
        {snippet ? <Text style={styles.snippet} numberOfLines={1}>{'“' + snippet + '”'}</Text> : null}
      </View>
      <View style={styles.aside}>
        {time ? <Text style={styles.handle} numberOfLines={1}>{time}</Text> : null}
        {unread ? <View style={styles.unreadDot} accessible={false} /> : null}
      </View>
    </>
  )
  // Decorative: the row label already says what happened, and the glyph is
  // not its own control. No badge when the kind has no glyph.
  const face = (
    <View style={styles.avatar}>
      <Avatar name={who.avatarName} publicKey={item.key} size={44} picture={picture} persist={false} />
      {icon === null
        ? null
        : (
          <View
            style={styles.kindBadge}
            accessible={false}
            accessibilityElementsHidden
            importantForAccessibility='no-hide-descendants'
          >
            <Icon name={icon} size={12} color={colors.accentInk} />
          </View>
          )}
    </View>
  )
  if (kind !== 'follow') {
    const ref = noticeRef(item)
    const open = ref !== null && typeof onOpenThread === 'function' ? () => onOpenThread({ ref }) : undefined
    return (
      <PressScale
        style={({ pressed }) => [styles.row, pressed && open && styles.pressed]}
        accessibilityRole='link'
        accessibilityLabel={ref === null ? spoken : spoken + ', abrir publicação'}
        accessibilityHint={ref === null ? undefined : 'abre a conversa'}
        disabled={!open}
        onPress={open}
      >
        {face}
        {whoBlock}
      </PressScale>
    )
  }
  const open = typeof onOpenMember === 'function'
    ? () => onOpenMember(item.key, { name: item.name, username: item.username, avatar: picture || null })
    : undefined
  return (
    <PressScale
      style={({ pressed }) => [styles.row, pressed && open && styles.pressed]}
      accessibilityRole='link'
      accessibilityLabel={spoken + ', ver perfil'}
      accessibilityHint='abre o perfil'
      disabled={!open}
      onPress={open}
    >
      {face}
      {whoBlock}
    </PressScale>
  )
}

// The tokens the latest seen pass returned for this namespace (the person
// or `page:<key>`), from App.js's remoteSeen.
function remoteFor (remoteSeen, namespace) {
  if (!remoteSeen || typeof namespace !== 'string' || namespace.length === 0) return []
  if (isPageSeenNamespace(namespace)) {
    const list = remoteSeen.pages && remoteSeen.pages[namespace]
    return Array.isArray(list) ? list : []
  }
  return Array.isArray(remoteSeen.own) ? remoteSeen.own : []
}

export default function Avisos ({ active, refresh, ownKey, scrollToTop, onFollowsChanged, onToast, onBadge, onSeenState, remoteSeen, onOpenThread, onOpenMember }) {
  const styles = useStyles(makeStyles)
  const [helpOpen, setHelpOpen] = useState(false)
  const node = useNode()
  const blocks = useBlocks()
  const { profileOf, resolveMany } = useNames()
  const now = useNow(60000)
  const [avatarCycle, setAvatarCycle] = useState(0)
  const bottomPad = useBottomPad()
  const acting = useActing()
  const pageKey = acting.kind === 'page' ? acting.key : null
  const hosted = node.hosted === true && node.passkey !== null
  const peekWarm = useSyncExternalStore(subscribePeekWarm, getPeekWarmState, getPeekWarmState)
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
  const { request, promote } = node
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
  const read = useCallback((mine, after = null, onPage, lane) => {
    const live = () => mine === seqRef.current
    const opts = { limit: NOTICES_LIMIT_DEFAULT, after, live, onPage }
    // The hidden first read passes its lane through. A tap, a poll and a
    // later page pass none, so they stay on the visible lane.
    // Each send looks again: a continuation sent after the tab opened goes
    // on the visible lane (promote only moves the request still waiting).
    const send = lane
      ? (method, params) => request(method, params, activeRef.current ? undefined : lane)
      : request
    if (!pageKeyRef.current) return readNotices(send, opts)
    const page = pageKeyRef.current
    return readNotices(async (method, params) => {
      if (method !== 'notices.list') throw new Error('Pedido inválido')
      const member = typeof ownKeyRef.current === 'string' ? ownKeyRef.current.toLowerCase() : ''
      const data = await pagesNotices({ request: send }, {
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
  // A hidden first read keeps its rows in state but draws none until the tab is shown once.
  const shownOnceRef = useRef(false)
  if (active) shownOnceRef.current = true
  const onBadgeRef = useRef(onBadge)
  onBadgeRef.current = onBadge
  const onSeenStateRef = useRef(onSeenState)
  onSeenStateRef.current = onSeenState
  const remoteSeenRef = useRef(remoteSeen)
  remoteSeenRef.current = remoteSeen
  const seenRef = useRef(null)
  const [unread, setUnread] = useState(() => new Set())
  // Set after a poll failed with a non-locked, non-web-only error: the next
  // tick is skipped once.
  const backoffRef = useRef(false)
  const busyRetryRef = useRef(null)
  const loadFirstRef = useRef(null)
  const firstReadEpochRef = useRef(null)
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh
  const reloadAfterRef = useRef(false)

  const badge = useCallback((value) => {
    if (typeof onBadgeRef.current === 'function') onBadgeRef.current(value)
  }, [])
  // The last list the dot was computed from, and the last one on screen: a
  // hidden poll settles its fresh page without committing it.
  const lastListRef = useRef(null)
  const shownListRef = useRef(null)

  // The dot follows what is unseen; with the tab open (mark) everything
  // loaded is seen at once. A list that is not on screen (shown false) is
  // never marked and never reported: its page would replace the rows the
  // pass uploads.
  const seenNamespaceRef = useRef(seenNamespace)
  seenNamespaceRef.current = seenNamespace
  const settleRef = useRef(null)
  const settle = useCallback((list, mark, shown = true) => {
    // A read that began before the own key arrived settles through the
    // current namespace; one of another identity settles nothing.
    if (seenNamespaceRef.current !== seenNamespace) {
      if (seenNamespace.length === 0 && settleRef.current !== null) settleRef.current(list, mark, shown)
      return
    }
    if (mark === undefined) mark = activeRef.current
    lastListRef.current = { list, shown }
    if (shown) shownListRef.current = list
    else mark = false
    // Before the identity is known nothing is read or written: an entry
    // stored for `own: null` would replace the real one.
    if (seenNamespace.length === 0) {
      badge(!mark && hasNew(list, []))
      return
    }
    if (seenRef.current === null) seenRef.current = loadSeen(seenNamespace)
    const seen = seenRef.current
    // Rows unseen when they first loaded keep their dot while this screen
    // lives, even though opening the tab marks them seen. A row read on
    // another device of the passkey is not new: it never gets the dot, and
    // loses it when those marks arrive. The merged marks also echo this
    // device's own, which are stored here already and clear nothing.
    const remote = remoteFor(remoteSeenRef.current, seenNamespace)
    const stored = new Set(seen.ids)
    const elsewhere = remote.filter((id) => !stored.has(id))
    const fresh = list.filter((item) => typeof item.seen === 'string' && !stored.has(item.seen) && !elsewhere.includes(item.seen)).map((item) => item.seen)
    if (fresh.length > 0) setUnread((u) => (fresh.every((id) => u.has(id)) ? u : new Set([...u, ...fresh])))
    if (elsewhere.length > 0) setUnread((u) => (elsewhere.some((id) => u.has(id)) ? new Set([...u].filter((id) => !elsewhere.includes(id))) : u))
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
      // Rows read on another device are stored as seen here too, so their
      // dot stays off after a restart, before any pass. The rows on screen
      // and the latest polled page stay protected.
      if (remote.length > 0 && randomBytes !== null) {
        const { rows } = remoteFoldPlan(shownListRef.current, lastListRef.current)
        const { ids, changed } = mergeRemoteSeen(seen.ids, remote, rows, randomBytes)
        if (changed) {
          seen.ids = ids
          writeSeen(seenNamespace, ids)
        }
      }
      badge(hasNew(list, seenUnion(seen.ids, remote)))
    }
    // Only tokens of loaded rows leave: the padding stays on this device.
    if (shown && typeof onSeenStateRef.current === 'function') onSeenStateRef.current(seenNamespace, seenOnScreen(list, seen.ids))
  }, [seenNamespace, badge])
  settleRef.current = settle

  // Another identity has its own seen ids. Loaded at once when hosted, so a
  // stored entry of an old format (v1 follower keys, v2 salted digests) is
  // removed on the first load, not only at the first settle. A page uses
  // its own namespace in the same store. Declared before the fold below:
  // effects run in order, and the fold must never see the previous
  // namespace's ids or lists.
  const prevNamespaceRef = useRef(null)
  useEffect(() => {
    const prev = prevNamespaceRef.current
    prevNamespaceRef.current = seenNamespace
    seenRef.current = hosted && seenNamespace.length > 0 ? loadSeen(seenNamespace) : null
    setUnread(new Set())
    lastListRef.current = null
    shownListRef.current = null
    // The own key arrived after the first paint: the personal list on
    // screen is this identity's, so it is settled now, not at the next poll.
    if (prev === '' && seenNamespace.length > 0 && !pageKeyRef.current && hosted && stateRef.current.loadedAt !== null) settle(stateRef.current.items)
  }, [seenNamespace, hosted, settle])

  // A seen pass brought the marks of another device: the latest list is
  // settled again, which stores the loaded rows they cover as seen and
  // moves the dot.
  useEffect(() => {
    if (!remoteSeen || seenNamespace.length === 0 || !hosted) return
    if (remoteFor(remoteSeen, seenNamespace).length === 0) return
    const plan = remoteFoldPlan(shownListRef.current, lastListRef.current)
    if (plan.settle === null) return
    if (plan.settle.shown) settle(plan.settle.list)
    else settle(plan.settle.list, false, false)
  }, [remoteSeen, seenNamespace, hosted, settle])

  const loadFirst = useCallback(async (opts) => {
    const current = stateRef.current
    if (!hosted || current.unsupported || current.locked) return
    if (pageKeyRef.current && typeof ownKeyRef.current !== 'string') return
    // Only the scheduled hidden read sets quiet. A tap passes a press event
    // or nothing, and stays a visible request.
    const quiet = !!(opts && opts.quiet === true)
    setAvatarCycle((n) => n + 1)
    const mine = ++seqRef.current
    commit({
      loading: current.loadedAt === null,
      refreshing: current.loadedAt !== null,
      loadingMore: false,
      loadError: '',
      moreError: ''
    })
    let painted = false
    try {
      const page = await read(mine, null, (partial) => {
        if (mine !== seqRef.current) return
        // An empty page with a cursor (filtered candidates) is not the empty
        // list: the skeleton stays until a row or the end arrives.
        if (partial.notices.length === 0 && partial.next !== null) return
        const items = mergePage([], partial.notices).items
        commit({
          items,
          next: partial.next,
          atEnd: partial.next === null,
          incomplete: partial.incomplete === true,
          activity: partial.activity !== false,
          notSupportedByNode: false,
          pageUnavailable: false,
          loadedAt: Date.now(),
          loading: false,
          refreshing: true
        })
        painted = true
        settle(items)
      }, quiet ? { priority: 'background', token: opts.token } : undefined)
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
      if (isSeederBusyError(err)) updatePeekWarmState(node.epoch, { busy: true })
      if (mine !== seqRef.current) return
      if (painted && !isLockedError(err)) {
        // A continuation failed after rows were shown: they stay, and the
        // footer retries from the last cursor.
        backoffRef.current = true
        commit({ loading: false, refreshing: false, moreError: errorText(err) })
        // Opened during a hidden read: what is on screen is seen now.
        if (activeRef.current) settle(stateRef.current.items)
      } else if (pageKeyRef.current && isPageNoticesUnavailable(err)) {
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
        if (!activeRef.current) {
          commit({ loading: false, refreshing: false })
        } else {
          commit({ loading: false, refreshing: false, loadError: errorText(err) })
        }
      }
    }
  }, [hosted, read, commit, settle, badge, node.epoch])
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
    if (current.loadedAt === null) {
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
        settle(page.notices, false, false)
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
    previous.current = { active, refresh: active ? refresh : prev.refresh, scrollToTop, warmToken: prev.warmToken }
    if (!active) return
    const current = stateRef.current
    if (current.loading || current.refreshing) {
      if (changed) reloadAfterRef.current = true
      // Still queued: the same first read moves to the visible lane. Already
      // in flight, promote does nothing and this show waits, so it is not
      // sent twice. A pull to refresh is a later visible loadFirst.
      if (shown) promote(prev.warmToken)
      // Rows a hidden read already painted are on screen now: seen.
      if (shown && current.loadedAt !== null) settle(current.items)
      return
    }
    const stale = shouldReloadOnShow({ loadedAt: current.loadedAt, now: Date.now(), fresh: false })
    if (changed || ((shown || reselected) && stale)) {
      // This load covers a refresh deferred while a read was in flight.
      reloadAfterRef.current = false
      loadFirst()
    } else if (shown && current.loadedAt !== null) settle(current.items)
  }, [active, refresh, scrollToTop, loadFirst, settle, promote])

  useEffect(() => {
    if (active && !state.loading && !state.refreshing && reloadAfterRef.current) {
      reloadAfterRef.current = false
      loadFirst()
    }
  }, [active, state.loading, state.refreshing, loadFirst])

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
    const canStart = () => shouldStartNoticesFirstRead({
      hosted,
      online: node.online,
      phase: node.phase,
      visible: node.visible,
      seederVerified: node.signals?.seederVerified,
      active: activeRef.current,
      ...stateRef.current,
      attempted: firstReadEpochRef.current === node.epoch,
      epoch: node.epoch,
      peekWarm: getPeekWarmState()
    })
    if (!canStart()) return
    // Only once the app has been quiet: the boot reads come first.
    const wait = node.whenIdle(NOTICES_FIRST_READ_QUIET_MS)
    wait.promise.then(() => {
      if (!canStart()) return
      firstReadEpochRef.current = node.epoch
      // One token per first read, kept with the refresh it consumes, so
      // opening the tab can promote this request instead of sending it again.
      const token = Symbol('avisos-warm')
      previous.current = { ...previous.current, refresh: refreshRef.current, warmToken: token }
      loadFirst({ quiet: true, token })
    })
    return () => wait.cancel()
  }, [hosted, node.online, node.phase, node.visible, node.signals?.seederVerified, node.epoch, node.whenIdle, active, state.loadedAt, state.loading, state.refreshing, state.loadingMore, unsupported, locked, peekWarm, loadFirst])

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
  if (notice === 'web-only' && node.hosted !== true) {
    empty = <EmptyState icon='sino' title='Avisos indisponíveis' body={NOT_HOSTED} actionLabel='Saiba mais' onAction={() => setHelpOpen(true)} />
  } else if (notice === 'web-only') {
    empty = <EmptyState icon='sino' title='Avisos indisponíveis' body='Os Avisos não estão disponíveis nesta conexão.' />
  } else if (notice === 'unsupported') {
    empty = <EmptyState icon='sino' title='Sem avisos por aqui' body={NOTICES_UNSUPPORTED_MESSAGE} />
  } else if (notice === 'offline') {
    empty = <EmptyState icon='sino' title='Sem conexão' body={NOTICES_OFFLINE_MESSAGE} actionLabel='Tentar de novo' onAction={loadFirst} />
  } else if (pageUnavailable && pageKey) {
    empty = <EmptyState icon='sino' title={PAGE_NOTICES_UNAVAILABLE_TITLE} body='A instalação ainda não oferece avisos para páginas. Tente de novo mais tarde.' actionLabel='Tentar de novo' onAction={loadFirst} />
  } else if (loadError) {
    empty = <ErrorState message={loadError} onRetry={locked ? () => { commit({ locked: false, loadError: '' }); loadFirst() } : loadFirst} pending={loading || refreshing} />
  } else if (loadedAt === null) {
    empty = <><SkeletonRow /><SkeletonRow /><SkeletonRow /></>
  } else {
    empty = pageKey
      ? <EmptyState icon='sino' title={PAGE_EMPTY_TITLE} body={PAGE_EMPTY_TEXT} />
      : <EmptyState icon='sino' title={EMPTY_TITLE} body={EMPTY_TEXT} />
  }

  const renderItem = ({ item }) => {
    const picture = pickAvatar(profileOf(item.key), rowAvatarSource(item, avatars[item.key]))
    return (
      <NoticeRow
        item={item}
        now={now}
        unread={unread.has(item.seen)}
        postText={snippets[snippetRef(item)]}
        picture={picture}
        onOpenMember={onOpenMember}
        onOpenThread={onOpenThread}
      />
    )
  }

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

  // The node leaves a blocked person out of each read; this clears the rows
  // already held, and the page notices, which the account service answers.
  const shownItems = notice === null ? withoutBlockedKeys(items, blocks.has) : []
  const shownKeys = shownItems.map((i) => i.key).join(',')
  useEffect(() => {
    if (active && hosted && shownKeys !== '') resolveMany(shownKeys.split(','))
  }, [active, hosted, shownKeys, resolveMany])
  const avatars = useRowAvatars(shownItems, profileOf, node.request, active && hosted && notice === null, avatarCycle)
  const snippets = useSnippets(shownItems, node.request, active && hosted && notice === null, loadedAt)
  return (
    <>
      <RefreshableList
        data={shownOnceRef.current ? shownItems : EMPTY_ROWS}
        keyExtractor={noticeId}
        renderItem={renderItem}
        extraData={{ now, onOpenMember, onOpenThread, unread, snippets, avatars, profileOf }}
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
      <HelpSheet open={helpOpen} onClose={() => setHelpOpen(false)} doc={HELP.avisos} />
    </>
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
  avatar: { width: 44, height: 44, position: 'relative' },
  // Off the avatar's corner, so it never covers the initials.
  kindBadge: {
    position: 'absolute',
    right: -4,
    bottom: -4,
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accent,
    borderWidth: 2,
    borderColor: colors.bg
  },
  who: { flex: 1, minWidth: 0 },
  // The line is one Text so it truncates together. The name is weighed apart
  // from the rest; postName itself is 700, so the parent is set back to 400.
  name: { ...type.postName, fontWeight: '400', color: colors.ink },
  nameBold: { fontWeight: '700' },
  nameRest: { fontWeight: '400' },
  handle: { ...type.postMeta, color: colors.soft },
  snippet: { ...type.postMeta, color: colors.ink },
  aside: { alignItems: 'flex-end', gap: space.xs },
  unreadDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.accent },
  pressed: { opacity: 0.6 },
  footer: { padding: 16, gap: 8 },
  pageTitle: { ...type.emptyTitle, color: colors.ink }
})
