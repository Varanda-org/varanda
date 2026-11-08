// Membro: a member's profile, pushed above the tabs (App.js screen stack,
// entry { screen: 'membro', key: authorHex, params: { seed } } where the seed
// is { name, username, avatar } from the row tapped). The header is the shared
// ProfileHeader (sunset band with the back control, avatar, name, @nome, bio,
// actions), drawn from the top of the scroll content with its own status inset
// like the Diário. Its data comes from profile.read when the node holds the diary, else
// (hosted web) from a diary.peek of the seeder index's profile/username seq
// hints. Seguindo asks for confirmation before follow.remove;
// 'denunciar a conta' opens the report sheet without a post (hosted web). On
// the hosted web the member's posts and reposts are paged from the index
// (/index/member, newest first) and every one is fetched and verified with
// diary.peek (src/thread.js assembleMember). Natively, or offline, only the
// header shows, with a note. No key is ever shown; every peer string goes
// through displayText (PostRow does it for the rows).
//
// A page (docs/protocol.md section 12) is told by the index hint or the seed
// (`page: true`) or by page.read on a hosted node: the header then shows a
// 'Página' badge and the verified roster. The index hint only says where to
// look; the roster comes from page.read alone and an incomplete read never
// invents admins. Owners and admins can act as the page (actingAs store);
// while acting as a page, Seguir on any other diary is the page's follow.
//
// A closed page shows 'Esta página foi encerrada' and no Seguir or action. A
// moved page (page.read's movedTo, or on a hosted node the successor
// statement once K2's verified origin names the same pair, src/pageMove.js)
// shows a banner that opens the new key and 'Seguir a chave nova', the manual
// way to follow K2. The node also follows K2 by itself, once, after it
// verified the move (Terms 15). K1's posts past the move are not shown.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { displayText } from '@varanda/rpc'
import { useNode } from '../node'
import { useNames } from '../names'
import { readBlockedPeek, useBlocks } from '../blocksProvider'
import { BLOCK_TEXTS } from '../memberBlocks'
import { avatarOf } from '../media/avatar'
import { fetchFeiraAuthor, fetchMember, invalidateMember, POSTS_MAX } from '../indexClient'
import { assembleMember, planPeeks } from '../thread'
import { whoOf } from '../who'
import { applyCut, fillState, hideFuture, tilesFromItems } from '../mural'
import * as actingAs from '../actingAs'
import { TEXTS, pagesFollow, pagesFollows, pagesSuccessor } from '../pages'
import { MAX_HOPS, moveOf, pageMoveView, resolveChain, shownUnderCut, successorOf } from '../pageMove'
import { rosterRows } from '../pageRoster'
import { Soft, errorText, useBottomPad, useNow } from '../ui'
import { FollowPill } from '../ui/FollowPill'
import { OfflineNote } from '../ui/OfflineNote'
import { Pill } from '../ui/Pill'
import { MoreButton } from '../ui/MoreButton'
import { PageNoticeSheet } from '../ui/PageNoticeSheet'
import { Sheet } from '../ui/Sheet'
import { ShareProfile } from '../ui/ShareProfile'
import { buildProfileUrl } from '../profileLink'
import { installationOrigin } from '../installation'
import { pageNoticeStore } from '../pageNoticeStore'
import { pageNoticeKey, pageReadKind } from '../pageNotice'
import { ProfileHeader } from '../ui/ProfileHeader'
import { ProfileBar, useProfileBar } from '../ui/ProfileBar'
import { LABELS } from '../dm'
import { COUNTS_INCOMPLETE_NOTE } from '../pessoas'
import { useFollowCounts } from '../useFollowCounts'
import { PostRow } from '../ui/PostRow'
import { RefreshableList } from '../ui/RefreshableList'
import { MuralFooter, MuralRow, muralGridRows } from '../ui/MuralGrid'
import { Segmented } from '../ui/Segmented'
import { CommunitiesBox } from '../ui/CommunitiesBox'
import { commonCommunities, communitiesOf, MAX_COMMON_LOOKUPS } from '../communitiesBox'
import { EmptyState, ErrorState, ListFooter, Skeleton } from '../ui/States'
import { LARGE_TEXT, type } from '../ui/theme'
import { useStyles } from '../ui/ThemeProvider'
import { pagesOn } from '../pageGate'
import { ConfirmTestimonialSheet, RETRACT_TITLE, TESTIMONIALS_TAB, WRITE_UNCERTAIN, WriteTestimonialSheet, ownBlockRef, retractBody, useTestimonialTab, useTestimonials } from './Depoimentos'
import { ratingRefs, ratings } from '../feiraClient'
import { MAX_RATED_LISTINGS, RATINGS_NOTE, collectRatings, summaryLabel } from '../feiraReview'
import { isSeederDown, knownAuthors, memberKeyOf, learnPeeked, peekAll, planWithHints, postAt, refOf, rowProps, useEngagement, useFollowSet } from './Conversa'

const TABS = [{ id: 'posts', label: 'Publicações' }, { id: 'mural', label: 'Mural' }]
// Depoimentos is the third tab only on a hosted node (node.hosted === true).
const TABS_HOSTED = TABS.concat([TESTIMONIALS_TAB])
const NOT_HOSTED_NOTE = 'Publicações completas disponíveis na versão web, com internet.'
const OFFLINE_NOTE = 'Sem internet: as publicações completas aparecem quando a conexão voltar.'

const BAND = 96

const ROSTER_UNAVAILABLE = 'lista de administradores indisponível'
const PAGE_UNCERTAIN = 'Não sabemos se a mudança foi feita. Confira antes de tentar de novo.'

export function canConverseWithPage ({ page, closed, moved, hosted, enabled }) {
  return page === true && closed !== true && moved !== true && hosted === true && enabled === true
}

// The 'Página' badge text from an index hint, a seed or a page.read answer:
// null for a person. Closed and moved pages say so.
export function pageBadgeLabel (info) {
  if (!info || typeof info !== 'object' || info.page !== true) return null
  if (info.closed === true) return 'Página · encerrada'
  if (info.moved === true || (info.movedTo !== undefined && info.movedTo !== null)) return 'Página · mudou de chave'
  return 'Página'
}

// One community.members read (docs/rpc.md 5.65) of at most this many rows.
const MEMBERS_PAGE = 100
// Past this many pages a community counts as not in common (fail closed).
const MEMBERS_PAGES_MAX = 10
// Same pause as the Diário's list and Comunidades: one read for a burst of
// group events.
const COMMON_DELAY_MS = 800

// One page of a community's members, listed in key order: the person's rows
// on it, and the offset of the next page to read, or null when the person is
// found or cannot be on a later page (the last key sorts after theirs, or the
// list ends).
export function membersPageStep (res, person, offset) {
  const members = res && typeof res === 'object' && Array.isArray(res.members) ? res.members : []
  const hits = members.filter((row) => row !== null && typeof row === 'object' && row.member === person)
  if (hits.length > 0 || members.length === 0 || typeof person !== 'string') return { hits, next: null }
  const last = members[members.length - 1]
  if (last && typeof last.member === 'string' && last.member.toLowerCase() > person.toLowerCase()) return { hits, next: null }
  const next = offset + members.length
  const total = res && Number.isSafeInteger(res.total) ? res.total : 0
  return { hits, next: next < total ? next : null }
}

// Whether a page.read answer is about a page (a person's diary has no roster).
const isPageRead = (r, key) => pageReadKind(r, key) === 'page'

function useActingAs () {
  const [state, setState] = useState(() => actingAs.get())
  useEffect(() => {
    setState(actingAs.get())
    return actingAs.subscribe(() => setState(actingAs.get()))
  }, [])
  return state
}

// The verified Dono / Administradores list. An owner or admin that has a
// verified link is shown with its diary's profile name.
function PageRoster ({ read, names, onOpenMember }) {
  const styles = useStyles(makeStyles)
  if (!read || read.complete === false) return <Text style={styles.rosterSoft}>{ROSTER_UNAVAILABLE}</Text>
  const links = Array.isArray(read.links) ? read.links : []
  const { sections } = rosterRows(read)
  return (
    <View style={styles.roster}>
      {sections.map((section) => (
        <View key={section.title} style={styles.rosterSection}>
          <Text style={styles.rosterTitle}>{section.title}</Text>
          {section.keys.map((key) => {
            const link = links.find((l) => l && l.actor === key)
            const shown = link && typeof link.diary === 'string' ? link.diary : key
            const profile = names.profileOf(shown)
            const who = whoOf(profile)
            const title = displayText(who.title)
            const open = typeof onOpenMember === 'function'
              ? () => onOpenMember(shown, { name: profile ? profile.name : null, username: profile ? profile.username : null })
              : undefined
            return (
              <Pressable
                key={key}
                accessibilityRole='link'
                accessibilityLabel={'ver o perfil de ' + title}
                disabled={!open}
                onPress={open}
                style={({ pressed }) => [pressed && open && styles.pressed]}
              >
                <Text style={styles.rosterName} numberOfLines={1}>{title}</Text>
              </Pressable>
            )
          })}
        </View>
      ))}
    </View>
  )
}

const str = (v) => (typeof v === 'string' && v !== '' ? v : null)

// The posts of `items` that are not peeked yet and must be shown: repost
// originals and quoted posts, as diary.peek params (with the index hints of
// the strangers among their authors, so their names are learned).
async function extraPlan (items, peeked, known, alive) {
  const refs = []
  for (const item of items) {
    const target = item.kind === 'repost' ? item.to : item.quote
    if (!target) continue
    const ref = refOf(target.author, target.seq)
    if (postAt(peeked, ref) === null) refs.push(ref)
  }
  return planWithHints(refs, known, alive)
}

// The post a row shows: the item itself, or a repost's original.
function shownPost (item, peeked) {
  return item.kind === 'repost' ? postAt(peeked, refOf(item.to.author, item.to.seq)) : item
}

const INITIAL_POSTS = {
  phase: 'loading', // 'loading' | 'ready' | 'error'
  error: '',
  items: [],
  unavailable: 0,
  before: null,
  atEnd: false,
  indexing: false,
  complete: true,
  loadingMore: false,
  moreError: '',
  refreshing: false
}

export default function Membro ({ entry, ownKey, onBack, onFollowsChanged, onMessage, onReply, onQuote, onReport, onOpenThread, onOpenMember, onOpenMention, onOpenEngagers, onOpenPageSettings, onOpenPeople, onOpenCommunity, onOpenListings, onOpenTestimonials, onToast }) {
  const styles = useStyles(makeStyles)
  const node = useNode()
  const names = useNames()
  const now = useNow(60000)
  const bottomPad = useBottomPad()
  const author = entry.key
  const seed = entry.params && entry.params.seed ? entry.params.seed : null
  const full = !!node.hosted && node.online !== false
  const { request } = node
  const { learnMany, resolveMany } = names
  const eng = useEngagement({ request, node, onToast })
  const { follows, load: loadFollows, mark } = useFollowSet(request)
  const [header, setHeader] = useState(() => ({
    name: seed ? str(seed.name) : null,
    username: seed ? str(seed.username) : null,
    bio: null,
    avatar: seed ? avatarOf(seed.avatar) : null,
    verified: false
  }))
  const headerRef = useRef(header)
  const [posts, setPosts] = useState(INITIAL_POSTS)
  const postsRef = useRef(posts)
  const peekedRef = useRef(new Map())
  const followsRef = useRef(Promise.resolve(new Set()))
  const genRef = useRef(0)
  const [following, setFollowing] = useState(false)
  // 'posts' | 'mural' | 'depoimentos'. The state lives here, so it survives a
  // visit to a thread.
  const [tab, setTab] = useState('posts')
  const muralPages = useRef(0)
  const { fontScale, height: windowHeight } = useWindowDimensions()
  const [sharing, setSharing] = useState(false)
  const [pageRead, setPageRead] = useState(null)
  const [pageNotice, setPageNotice] = useState(null)
  // The index's page/closed/moved fields (a hint until page.read answers),
  // and whether page.read said "not a page" (it overrides every hint).
  const [idxHint, setIdxHint] = useState(null)
  const [notPage, setNotPage] = useState(false)
  // { statement, targetRead, chain } for pageMoveView, once the moves are read.
  const [moveInfo, setMoveInfo] = useState(null)
  const [followingNew, setFollowingNew] = useState(false)
  const acting = useActingAs()
  const actingKey = acting.kind === 'page' ? acting.key : null
  const asPageMode = actingKey !== null && actingKey !== author && typeof ownKey === 'string' && pagesOn({ hosted: node.hosted, accountOrigin: node.accountOrigin })
  // null while unknown; the keys the acting page follows.
  const [pageFollows, setPageFollows] = useState(null)
  const [pageFollowsFailed, setPageFollowsFailed] = useState(false)
  const followsSeqRef = useRef(0)
  const followsKeyRef = useRef(null)
  const loadPageFollowsRef = useRef(() => {})
  const nodeRef = useRef(node)
  nodeRef.current = node
  const [tick, setTick] = useState(0)
  const c = useFollowCounts(author, tick)
  const blocks = useBlocks()
  const blockedHere = blocks.has(author)
  const [unblocking, setUnblocking] = useState(false)
  // Only the communities both people are admitted to, never this person's
  // own list (their interests are sensitive data).
  const [common, setCommon] = useState([])
  // Depoimentos (hosted only): the approved ones in their tab, and the
  // own sealed one to this person, if any. A write or a retraction is
  // remembered here until the index catches up.
  const testimonials = useTestimonials(author, { tick, active: full })
  const [writingTestimonial, setWritingTestimonial] = useState(false)
  const [retractingTestimonial, setRetractingTestimonial] = useState(false)
  const [sentTestimonial, setSentTestimonial] = useState(null)
  // An uncertain write may be published: no second 'Escrever depoimento' on
  // this visit (the person checks Enviados first).
  const [testimonialUncertain, setTestimonialUncertain] = useState(false)
  const [retractedTestimonials, setRetractedTestimonials] = useState(() => new Set())
  const commonGenRef = useRef(0)

  const commitHeader = useCallback((h) => {
    headerRef.current = h
    setHeader(h)
  }, [])
  const commit = useCallback((patch) => {
    postsRef.current = { ...postsRef.current, ...patch }
    setPosts(postsRef.current)
  }, [])

  // The header from profile.read (the node holds the diary); false when the
  // node has no showable diary for this key or the read failed.
  const readProfile = useCallback(async () => {
    try {
      const r = await request('profile.read', { authors: [author] })
      const p = (r && Array.isArray(r.profiles) ? r.profiles : []).find((x) => x && typeof x.author === 'string' && x.author.toLowerCase() === author)
      if (!p) return false
      const h = { name: str(p.name), username: str(p.username), bio: str(p.bio), avatar: avatarOf(p.avatar), verified: true }
      commitHeader(h)
      learnMany([[author, { name: h.name, username: h.username, bio: h.bio, avatar: h.avatar }]])
      return true
    } catch {
      return false
    }
  }, [request, author, commitHeader, learnMany])

  // The moves out of the opened page, up to MAX_HOPS keys: each hop needs
  // page.read of its target, which is what verifies a successor statement.
  const resolveMoves = useCallback(async (r, alive) => {
    const entries = new Map()
    let read = r
    for (let hop = 0; hop < MAX_HOPS && read && read.closed !== true; hop++) {
      let statement = null
      if (!read.movedTo && node.hosted === true) {
        try { statement = successorOf(await pagesSuccessor(read.page)) } catch {}
        if (!alive()) return
      }
      const to = read.movedTo && typeof read.movedTo.to === 'string' ? read.movedTo.to : statement ? statement.to : null
      if (to === null || to === author || entries.has(to)) {
        entries.set(read.page, { read, statement })
        break
      }
      let targetRead = null
      try { targetRead = await request('page.read', { key: to }) } catch {}
      if (!alive()) return
      entries.set(read.page, { read, statement, targetRead })
      if (moveOf(read, { statement, targetRead }) === null || !targetRead || targetRead.page !== to) break
      read = targetRead
    }
    const first = entries.get(author) || {}
    setMoveInfo({ statement: first.statement || null, targetRead: first.targetRead || null, chain: resolveChain(author, (k) => entries.get(k) || null) })
  }, [request, author, node.hosted])

  // page.read of the opened key (hosted only): the roster and lifecycle. A
  // failed read keeps what was known (the previous answer, the index hint)
  // and only a successful "not a page" answer clears the page state.
  const readPageInfo = useCallback(async (alive) => {
    let r
    try {
      r = await request('page.read', { key: author })
    } catch {
      return
    }
    if (!alive()) return
    if (isPageRead(r, author)) {
      setPageRead(r)
      setNotPage(false)
      const h = headerRef.current
      learnMany([[author, { name: h.name, username: h.username, page: true, closed: r.closed === true, moved: r.movedTo !== null && r.movedTo !== undefined }]])
      resolveMoves(r, alive)
    } else if (r && r.complete === true) {
      // Only a read that covered the whole diary proves it is not a page; an
      // incomplete one (roster blocks not fetched yet) keeps what is known.
      setPageRead(null)
      setNotPage(true)
    }
  }, [request, author, learnMany, resolveMoves])

  // The header from a peek (verified profile/username fields only).
  const headerFromPeek = useCallback((peek) => {
    if (!peek) return
    const name = peek.profile && typeof peek.profile.name === 'string' ? str(peek.profile.name) : null
    const bio = peek.profile && typeof peek.profile.bio === 'string' ? str(peek.profile.bio) : null
    const username = str(peek.username)
    const avatar = avatarOf(peek.profile && peek.profile.avatar)
    if (name === null && username === null && bio === null && avatar === null) return
    commitHeader({ name, username, bio, avatar, verified: true })
  }, [commitHeader])

  // One page of the member's index (`before` exclusive), peeked and
  // assembled; returns { items, unavailable, index } or throws.
  const readPage = useCallback(async (before, alive, withHeader) => {
    const res = await fetchMember(author, before)
    if (!alive()) return null
    if (!res.ok) {
      const err = new Error(res.reason === 'not-found' ? 'Este perfil não está disponível.' : 'Não foi possível carregar as publicações.')
      err.reason = res.reason
      throw err
    }
    const index = res.value
    setIdxHint(index.page === true ? { page: true, closed: index.closed === true, moved: index.moved === true } : null)
    const peeked = peekedRef.current
    const hints = { [author]: { profileSeq: index.profileSeq, usernameSeq: index.usernameSeq } }
    const refs = index.posts.map((seq) => refOf(author, seq))
    if (withHeader && refs.length === 0) {
      // No posts: peek only the profile/username blocks for the header.
      const seqs = [...new Set([index.profileSeq, index.usernameSeq].filter((s) => Number.isSafeInteger(s) && s >= 1))].sort((a, b) => a - b)
      if (seqs.length > 0) await peekAll(request, planPeeks({ refs: seqs.map((s) => refOf(author, s)), authors: hints }), peeked, alive)
    } else {
      await peekAll(request, planPeeks({ refs, authors: withHeader ? hints : undefined }), peeked, alive)
    }
    if (!alive()) return null
    // withHeader: profile.read did not answer in this load, so the newest
    // verified peek is applied.
    if (withHeader) headerFromPeek(peeked.get(author))
    const page = assembleMember({ author, index, peeked })
    const followSet = await followsRef.current
    if (!alive()) return null
    const known = () => knownAuthors({ ownKey, follows: followSet, hinted: hints, peeked })
    await peekAll(request, await extraPlan(page.items, peeked, known(), alive), peeked, alive)
    if (!alive()) return null
    // Quotes inside repost originals.
    const originals = page.items.filter((i) => i.kind === 'repost').map((i) => shownPost(i, peeked)).filter(Boolean)
    await peekAll(request, await extraPlan(originals, peeked, known(), alive), peeked, alive)
    if (!alive()) return null
    learnPeeked(learnMany, peeked)
    let unavailable = page.unavailable
    const items = page.items.filter((i) => {
      if (shownPost(i, peeked) !== null) return true
      unavailable++
      return false
    })
    return { items, unavailable, index }
  }, [author, request, headerFromPeek, learnMany, ownKey])

  const { readOwn, readCounts, reset } = eng
  const afterPage = useCallback((items, alive) => {
    const peeked = peekedRef.current
    const shown = items.map((i) => shownPost(i, peeked)).filter(Boolean)
    const refs = shown.map((p) => refOf(p.author, p.seq))
    resolveMany([...new Set(shown.map((p) => p.author).concat(shown.filter((p) => p.replyTo).map((p) => p.replyTo.author), shown.filter((p) => p.quote).map((p) => p.quote.author)))])
    readOwn(refs, alive).then(() => readCounts(refs, alive))
  }, [readOwn, readCounts, resolveMany])

  const load = useCallback(async (refreshing = false) => {
    const mine = ++genRef.current
    const alive = () => mine === genRef.current
    commit(refreshing ? { refreshing: true, error: '' } : { ...INITIAL_POSTS })
    // Every load verifies the header again (the fields stay shown meanwhile).
    commitHeader({ ...headerRef.current, verified: false })
    const held = await readProfile()
    if (!alive()) return
    if (blockedHere) {
      // The name alone, so the block can be undone by a person the screen
      // names. The node refuses this author's posts anyway.
      if (!held) {
        try { headerFromPeek(await readBlockedPeek(request, author)) } catch {}
        if (!alive()) return
      }
      commit({ ...INITIAL_POSTS, phase: 'ready', atEnd: true })
      return
    }
    followsRef.current = loadFollows()
    if (pagesOn({ hosted: node.hosted, accountOrigin: node.accountOrigin })) {
      readPageInfo(alive)
      if (refreshing) loadPageFollowsRef.current()
    }
    if (!full) {
      commit({ phase: 'ready', refreshing: false })
      return
    }
    try {
      // An explicit refresh reads the member index again instead of the
      // cached first page (paging never invalidates: its pages follow it).
      if (refreshing) {
        reset()
        invalidateMember(author)
      }
      peekedRef.current = new Map()
      const page = await readPage(null, alive, !held)
      if (!alive() || page === null) return
      const { items, unavailable, index } = page
      // The first page replaces every older one: the Mural fill budget starts
      // over with it.
      muralPages.current = 0
      commit({
        phase: 'ready',
        error: '',
        refreshing: false,
        items,
        unavailable,
        before: index.posts.length > 0 ? index.posts[index.posts.length - 1] : null,
        atEnd: index.posts.length < POSTS_MAX,
        indexing: index.indexing,
        complete: index.complete,
        loadingMore: false,
        moreError: ''
      })
      afterPage(items, alive)
    } catch (err) {
      if (!alive()) return
      commit({ phase: 'error', refreshing: false, error: isSeederDown(err) ? 'Sem conexão com o servidor agora.' : (err && err.reason ? err.message : errorText(err)) })
    }
  }, [commit, commitHeader, readProfile, loadFollows, full, reset, readPage, afterPage, readPageInfo, node.hosted, node.accountOrigin, blockedHere, headerFromPeek, request, author])

  const loadMore = useCallback(async () => {
    const current = postsRef.current
    if (current.phase !== 'ready' || current.loadingMore || current.refreshing || current.atEnd || current.before === null) return
    const mine = genRef.current
    const alive = () => mine === genRef.current
    commit({ loadingMore: true, moreError: '' })
    try {
      const page = await readPage(current.before, alive, false)
      if (!alive() || page === null) return
      const { items, unavailable, index } = page
      const seen = new Set(postsRef.current.items.map((i) => i.seq))
      const fresh = items.filter((i) => !seen.has(i.seq))
      commit({
        items: postsRef.current.items.concat(fresh),
        unavailable: postsRef.current.unavailable + unavailable,
        before: index.posts.length > 0 ? index.posts[index.posts.length - 1] : current.before,
        atEnd: index.posts.length < POSTS_MAX,
        indexing: index.indexing,
        complete: index.complete,
        loadingMore: false
      })
      afterPage(fresh, alive)
    } catch (err) {
      if (alive()) commit({ loadingMore: false, moreError: isSeederDown(err) ? 'Sem conexão com o servidor agora.' : (err && err.reason ? err.message : errorText(err)) })
    }
  }, [commit, readPage, afterPage])

  useEffect(() => {
    load(false)
    return () => { genRef.current += 1 }
  }, [load])

  const ownProfile = typeof ownKey === 'string' && author === ownKey
  const postsReady = posts.phase === 'ready'
  // Joining or leaving a community anywhere bumps the node's group versions:
  // the box is read again (after a short pause for a burst), keeping what it
  // shows until the new answer, and cleared only for another profile.
  const groupVersions = node.groupVersions
  const commonVersions = useRef(groupVersions)
  const commonFor = useRef(author)
  useEffect(() => {
    const mine = ++commonGenRef.current
    const alive = () => mine === commonGenRef.current
    const delay = groupVersions !== commonVersions.current ? COMMON_DELAY_MS : 0
    commonVersions.current = groupVersions
    if (commonFor.current !== author) {
      commonFor.current = author
      setCommon([])
    }
    if (node.hosted !== true || ownProfile || !postsReady) {
      setCommon([])
      return
    }
    const timer = setTimeout(async () => {
      try {
        const own = communitiesOf(await request('community.list', {}))
        const byCommunity = new Map()
        // One after the other: the browser node serialises requests anyway.
        for (const item of own.slice(0, MAX_COMMON_LOOKUPS)) {
          const rows = []
          let offset = 0
          for (let page = 0; page < MEMBERS_PAGES_MAX && offset !== null; page++) {
            if (!alive()) return
            const res = await request('community.members', { community: item.community, offset, limit: MEMBERS_PAGE })
            const step = membersPageStep(res, author, offset)
            rows.push(...step.hits)
            offset = step.next
          }
          byCommunity.set(item.community, rows)
        }
        if (alive()) setCommon(commonCommunities(own, byCommunity, author).items)
      } catch {}
    }, delay)
    return () => {
      commonGenRef.current += 1
      clearTimeout(timer)
    }
  }, [node.hosted, ownProfile, postsReady, request, author, tick, groupVersions])

  const isPage = !notPage && ((seed && seed.page === true) || (idxHint !== null && idxHint.page === true) || pageRead !== null)
  const roster = isPage && pageRead !== null ? rosterRows(pageRead) : null
  useEffect(() => {
    if (!roster) return
    const keys = new Set(roster.rows.map((r) => r.key))
    for (const l of Array.isArray(pageRead.links) ? pageRead.links : []) {
      if (l && keys.has(l.actor) && typeof l.diary === 'string') keys.add(l.diary)
    }
    resolveMany([...keys])
  }, [roster, pageRead, resolveMany])

  // The page's follows, signed by memberKeyOf (a core node's delegate, never
  // the diary key). Every read and change belongs to the acting page key
  // it was issued for: a result for another page is ignored. A failed read
  // stays retryable (pull-to-refresh, the pill, the next acting change).
  const loadPageFollows = useCallback(async () => {
    const forKey = followsKeyRef.current
    if (forKey === null) return false
    const seq = ++followsSeqRef.current
    setPageFollowsFailed(false)
    try {
      const rows = await pagesFollows(nodeRef.current, { member: await memberKeyOf(nodeRef.current.request, nodeRef.current), page: forKey })
      if (seq !== followsSeqRef.current || followsKeyRef.current !== forKey) return false
      setPageFollows(new Set(rows.map((f) => f.key)))
      return true
    } catch {
      if (seq === followsSeqRef.current && followsKeyRef.current === forKey) {
        setPageFollows(null)
        setPageFollowsFailed(true)
      }
      return false
    }
  }, [ownKey])
  loadPageFollowsRef.current = loadPageFollows
  followsKeyRef.current = asPageMode ? actingKey : null

  useEffect(() => {
    followsSeqRef.current += 1
    setPageFollows(null)
    setPageFollowsFailed(false)
    if (asPageMode) loadPageFollows()
    return () => { followsSeqRef.current += 1 }
  }, [asPageMode, actingKey, loadPageFollows])

  const togglePageFollow = async () => {
    if (following || pageFollows === null) return
    const forKey = actingKey
    const on = !pageFollows.has(author)
    setFollowing(true)
    try {
      await pagesFollow(nodeRef.current, { member: await memberKeyOf(nodeRef.current.request, nodeRef.current), page: forKey, key: author, on })
      if (followsKeyRef.current === forKey) {
        // A follows read that started before this change must not land on top.
        followsSeqRef.current += 1
        setPageFollows((cur) => {
          const next = new Set(cur || [])
          if (on) next.add(author)
          else next.delete(author)
          return next
        })
      }
      if (typeof onFollowsChanged === 'function') onFollowsChanged()
    } catch (err) {
      if (typeof onToast === 'function') onToast(err && err.uncertain === true ? PAGE_UNCERTAIN : errorText(err))
      // Unknown outcome: the list is read again before the next change.
      if (followsKeyRef.current === forKey) {
        setPageFollows(null)
        await loadPageFollows()
      }
    } finally {
      setFollowing(false)
    }
  }

  const isFollowed = follows !== null && follows.has(author)
  const toggleFollow = async () => {
    if (following || follows === null) return
    const on = !isFollowed
    setFollowing(true)
    try {
      await request(on ? 'follow.add' : 'follow.remove', { key: author })
      mark(author, on)
      if (typeof onFollowsChanged === 'function') onFollowsChanged()
    } catch (err) {
      if (typeof onToast === 'function') onToast(errorText(err))
      // Uncertain or failed: read the list again before the next change.
      await loadFollows()
    } finally {
      setFollowing(false)
      setTick((n) => n + 1)
    }
  }

  // The seller's verified ratings over the newest listings (hosted only),
  // read once per opened key; a failure only hides the row.
  const [rated, setRated] = useState(null)
  const ratingsHosted = node.hosted === true
  useEffect(() => {
    setRated(null)
    if (!ratingsHosted || typeof author !== 'string') return undefined
    let live = true
    const read = async () => {
      // The index's hints are enough here: listing.ratings proves each row
      // against the listing itself, so no listing needs a diary read.
      const first = await fetchFeiraAuthor(author)
      if (!live || !first || first.ok !== true) return
      const seqs = first.value.items.map((i) => Number(String(i.ref).slice(author.length + 1))).slice(0, MAX_RATED_LISTINGS)
      const r = await collectRatings({ author, seqs }, {
        refsPage: (cursor) => ratingRefs(author, cursor),
        verify: (q) => ratings(request, q)
      })
      if (live) setRated(r)
    }
    read().catch(() => {})
    return () => { live = false }
  }, [ratingsHosted, author, request])

  const who = whoOf({ name: header.name, username: header.username })
  const own = typeof ownKey === 'string' && author === ownKey
  const canReport = full && !own && typeof onReport === 'function' && typeof ownKey === 'string'
  const canBlock = canReport && blocks.available
  const unblock = async () => {
    setUnblocking(true)
    try {
      await blocks.setBlock(author, false)
      if (typeof onToast === 'function') onToast(BLOCK_TEXTS.undone)
    } catch (err) {
      if (typeof onToast === 'function') onToast(errorText(err))
    } finally {
      setUnblocking(false)
    }
  }

  const moveView = pageRead !== null ? pageMoveView(pageRead, moveInfo || {}) : null
  const movedView = moveView !== null && moveView.moved ? moveView : null
  const pageMoved = pageRead !== null && ((pageRead.movedTo !== null && pageRead.movedTo !== undefined) || movedView !== null)
  const canAct = isPage && pageRead !== null && (pageRead.isOwner === true || pageRead.isAdmin === true) && pagesOn({ hosted: node.hosted, accountOrigin: node.accountOrigin }) &&
    pageRead.closed !== true && !pageMoved && pageRead.complete !== false
  const actingHere = actingKey === author
  // page.read when it answered, else the index hint, else the seed.
  const lifecycle = pageRead !== null
    ? { closed: pageRead.closed === true, moved: pageMoved }
    : idxHint !== null
      ? { closed: idxHint.closed, moved: idxHint.moved }
      : { closed: !!seed && seed.closed === true, moved: !!seed && (seed.moved === true || (seed.movedTo !== undefined && seed.movedTo !== null)) }
  const badge = pageBadgeLabel({ page: isPage, closed: lifecycle.closed, moved: lifecycle.moved })
  const closedPage = isPage && lifecycle.closed === true
  const canConverse = !own && typeof onMessage === 'function' && canConverseWithPage({
    page: isPage,
    closed: lifecycle.closed,
    moved: lifecycle.moved,
    hosted: node.hosted,
    enabled: pagesOn({ hosted: node.hosted, accountOrigin: node.accountOrigin })
  })
  const openPageConversation = () => {
    const key = pageNoticeKey(author)
    if (!canConverse || key === null) return
    try {
      if (pageNoticeStore().getItem(key) === '1') {
        onMessage(author)
        return
      }
    } catch {}
    setPageNotice(author)
  }
  const pageNoticeSheet = (
    <PageNoticeSheet
      open={pageNotice === author && canConverse}
      page={author}
      onClose={() => setPageNotice(null)}
      onContinue={() => {
        if (!canConverse || pageNotice !== author) return
        setPageNotice(null)
        onMessage(author)
      }}
    />
  )
  const listingsRow = node.hosted === true && !(isPage && lifecycle.moved) && typeof onOpenListings === 'function'
    ? (
      <Pressable accessibilityRole='button' accessibilityLabel='Anúncios' onPress={() => onOpenListings(author)} style={({ pressed }) => [styles.listings, pressed && styles.pressed]}>
        <Text style={styles.rosterName}>Anúncios</Text>
      </Pressable>
      )
    : null
  const ratingsRow = ratingsHosted && !(isPage && lifecycle.moved) && rated && rated.summary.count > 0
    ? (
      <View accessibilityLabel='Avaliações' style={styles.listings}>
        <Text style={styles.rosterName}>Avaliações</Text>
        <Soft>{summaryLabel(rated.summary)}</Soft>
        <Soft>{RATINGS_NOTE}</Soft>
      </View>
      )
    : null
  const newKey = movedView !== null ? movedView.key : null
  const canFollowNew = newKey !== null && movedView.follow && !own && !asPageMode && follows !== null && !follows.has(newKey) && newKey !== ownKey

  // Only on this tap: following K2 is never automatic.
  const followNew = async () => {
    if (followingNew || newKey === null) return
    setFollowingNew(true)
    try {
      await request('follow.add', { key: newKey })
      mark(newKey, true)
      if (typeof onFollowsChanged === 'function') onFollowsChanged()
    } catch (err) {
      if (typeof onToast === 'function') onToast(errorText(err))
      await loadFollows()
    } finally {
      setFollowingNew(false)
    }
  }

  let banner = null
  if (closedPage) {
    banner = <Text style={styles.banner} accessibilityRole='text'>{TEXTS.encerrada}</Text>
  } else if (isPage && lifecycle.moved) {
    banner = (
      <View style={styles.bannerBox}>
        <Text style={styles.banner} accessibilityRole='text'>{TEXTS.movida}</Text>
        {newKey !== null
          ? (
            <View style={styles.bannerRow}>
              {typeof onOpenMember === 'function' ? <Pill label='Ver a página nova' onPress={() => onOpenMember(newKey, { page: true })} /> : null}
              {canFollowNew ? <Pill label='Seguir a chave nova' filled pending={followingNew} onPress={followNew} /> : null}
            </View>
            )
          : null}
      </View>
    )
  }
  const pageNote = badge !== null
    ? (
      <View style={styles.pageNote}>
        <Text style={styles.badge} accessibilityRole='text'>{badge}</Text>
        {banner}
        <PageRoster read={pageRead} names={names} onOpenMember={onOpenMember} />
      </View>
      )
    : null
  const countsNote = c.incomplete && (c.seguindo !== null || c.seguidores !== null) ? <View style={styles.countsNote}><Soft>{COUNTS_INCOMPLETE_NOTE}</Soft></View> : null

  const profileUrl = node.hosted === true && author ? buildProfileUrl({ origin: installationOrigin() || globalThis.location?.origin || null, username: header.verified === true ? header.username || null : null, publicKey: author }) : null
  const asPageFollowing = pageFollows !== null && pageFollows.has(author)
  const canTestimonial = node.hosted === true && full && !own && !isPage && typeof ownKey === 'string'
  const canWriteTestimonial = canTestimonial && !testimonialUncertain && !blockedHere
  const myTestimonial = [sentTestimonial, ownBlockRef(testimonials.index, ownKey)].find((r) => typeof r === 'string' && !retractedTestimonials.has(r)) || null
  const tabs = node.hosted === true ? TABS_HOSTED : TABS
  // A tab the node no longer offers (not hosted) falls back to Publicações.
  const shownTab = tabs.some((t) => t.id === tab) ? tab : 'posts'
  const depo = shownTab === 'depoimentos' && full
  const testimonialTab = useTestimonialTab({
    data: testimonials,
    own: false,
    ownKey,
    ownerName: displayText(who.title),
    canWrite: canWriteTestimonial && myTestimonial === null,
    onOpenMember,
    onReport: typeof onReport === 'function' && typeof ownKey === 'string' ? onReport : undefined,
    onRetracted: (ref) => setRetractedTestimonials((set) => new Set(set).add(ref))
  })
  const moreActions = [
    canAct
      ? { label: actingHere ? 'Deixar de agir como a página' : 'Agir como esta página', onPress: () => (actingHere ? actingAs.me() : actingAs.asPage({ key: author, name: header.name, username: header.username, closed: pageRead.closed })) }
      : null,
    !canAct && actingHere ? { label: 'Deixar de agir como a página', onPress: () => actingAs.me() } : null,
    canAct && typeof onOpenPageSettings === 'function' ? { label: 'Ajustes da página', onPress: () => onOpenPageSettings(author) } : null,
    !own && asPageMode && !closedPage && !blockedHere
      ? { label: asPageFollowing ? 'Deixar de seguir como a página' : 'Seguir como a página', pending: following, disabled: pageFollows === null, onPress: togglePageFollow }
      : null,
    profileUrl !== null ? { label: 'Compartilhar perfil', onPress: () => setSharing(true) } : null,
    canWriteTestimonial && myTestimonial === null ? { icon: 'lapis', label: 'Escrever depoimento', onPress: () => setWritingTestimonial(true) } : null,
    canTestimonial && myTestimonial !== null ? { icon: 'lixeira', label: 'Retirar depoimento', danger: true, onPress: () => setRetractingTestimonial(true) } : null,
    canReport ? { icon: 'bandeira', label: 'Denunciar a conta', danger: true, onPress: () => onReport({ author, name: header.name, username: header.username }) } : null,
    canBlock
      ? { icon: 'slash', label: blockedHere ? BLOCK_TEXTS.unblock : BLOCK_TEXTS.block, danger: !blockedHere, pending: unblocking, onPress: blockedHere ? unblock : () => blocks.ask({ author, name: header.name, username: header.username }) }
      : null
  ].filter(Boolean)

  // The Mural reads the same assembled pages as the posts: never a read of
  // its own, and none at all when the screen is not full (hosted and online).
  const mural = tab === 'mural' && full
  const muralTiles = useMemo(() => {
    if (!mural || posts.phase !== 'ready') return []
    const shown = hideFuture(tilesFromItems(posts.items), now)
    return applyCut(shown, movedView !== null ? movedView.cut : null)
  }, [mural, posts.phase, posts.items, now, movedView])
  const muralFill = fillState({ tiles: muralTiles, atEnd: posts.atEnd, pages: muralPages.current })
  // Bounded automatic fill: the next index page is read while the Mural is
  // short of photos, up to the cap. After that only 'Ver mais' reads one.
  useEffect(() => {
    if (!mural) { muralPages.current = 0; return }
    if (posts.phase !== 'ready' || posts.loadingMore || posts.refreshing || posts.moreError) return
    if (muralFill !== 'more') return
    // A page counts only when a read really starts (loadMore skips otherwise).
    const current = postsRef.current
    if (current.atEnd || current.before === null) return
    muralPages.current += 1
    loadMore()
  }, [mural, posts.phase, posts.items, posts.loadingMore, posts.refreshing, posts.moreError, muralFill, loadMore])

  const insets = useSafeAreaInsets()
  const bar = useProfileBar(insets.top + BAND, { controlsBottom: insets.top + 42 })
  const head = (
    <>
      <ProfileHeader
        bandHeight={insets.top + BAND}
        topInset={insets.top}
        onBack={full && bar.interactive ? undefined : onBack}
        bandButtons={null}
        avatar={{ name: who.avatarName, publicKey: author, picture: header.avatar, persist: own || isFollowed }}
        title={displayText(who.title)}
        subtitle={who.subtitle ? displayText(who.subtitle) : null}
        bio={header.bio || null}
        counts={[
          {
            label: 'seguindo',
            value: c.seguindo === null ? null : displayText(String(c.seguindo)),
            onPress: typeof onOpenPeople === 'function' ? () => onOpenPeople(author, 'seguindo') : undefined
          },
          {
            label: c.seguidores === 1 ? 'seguidor' : 'seguidores',
            value: c.seguidores === null ? null : displayText(String(c.seguidores)),
            onPress: typeof onOpenPeople === 'function' ? () => onOpenPeople(author, 'seguidores') : undefined
          }
        ]}
        note={pageNote !== null ? <View>{pageNote}{countsNote}</View> : countsNote}
        actions={[
          !own && asPageMode && !closedPage && !blockedHere
            ? (
              <Pill
                label={pageFollowsFailed ? 'Tentar de novo' : pageFollows !== null && pageFollows.has(author) ? 'Seguindo' : 'Seguir'}
                filled={!pageFollowsFailed && !(pageFollows !== null && pageFollows.has(author))}
                pending={following}
                disabled={pageFollows === null && !pageFollowsFailed}
                onPress={pageFollowsFailed ? loadPageFollows : togglePageFollow}
              />
              )
            : null,
          !own && !asPageMode && !closedPage && !blockedHere
            ? (
              <FollowPill
                following={follows === null ? null : isFollowed}
                title={displayText(who.title)}
                pending={following}
                disabled={false}
                onFollow={toggleFollow}
                onUnfollow={toggleFollow}
              />
              )
            : null,
          canConverse && !blockedHere
            ? <Pill icon='mensagem' label='Conversar' onPress={openPageConversation} />
            : null,
          !own && !isPage && node.hosted === true && typeof onMessage === 'function' && !blockedHere
            ? <Pill icon='mensagem' label={LABELS.message} onPress={() => onMessage(author)} />
            : null
        ].filter(Boolean).slice(0, 2)}
        more={<MoreButton title={displayText(who.title)} actions={moreActions} />}
        tabs={full
          ? (
            <View>
              <CommunitiesBox items={common} title='Comunidades em comum' onOpen={typeof onOpenCommunity === 'function' ? onOpenCommunity : undefined} />
              <Segmented options={tabs} selected={shownTab} onSelect={setTab} />
            </View>
            )
          : null}
      />
      {profileUrl !== null
        ? (
          <Sheet open={sharing} onClose={() => setSharing(false)} title='Compartilhar perfil'>
            <View style={styles.shareBody}>
              <ShareProfile url={profileUrl} />
            </View>
          </Sheet>
          )
        : null}
      {canTestimonial
        ? (
          <>
            <WriteTestimonialSheet
              open={writingTestimonial}
              to={author}
              name={displayText(who.title)}
              onClose={() => setWritingTestimonial(false)}
              onSent={(result) => {
                if (result && typeof result.ref === 'string') setSentTestimonial(result.ref)
                if (typeof onToast === 'function') onToast('Depoimento enviado. Aparece quando a pessoa aprovar.')
              }}
              onUncertain={() => {
                setTestimonialUncertain(true)
                if (typeof onToast === 'function') onToast(WRITE_UNCERTAIN)
              }}
            />
            <ConfirmTestimonialSheet
              open={retractingTestimonial}
              title={RETRACT_TITLE}
              body={retractBody(displayText(who.title))}
              confirmLabel='Retirar'
              onConfirm={async () => {
                const ref = myTestimonial
                await request('testimonial.delete', { to: ref, about: author })
                setRetractedTestimonials((set) => new Set(set).add(ref))
              }}
              onClose={() => setRetractingTestimonial(false)}
            />
          </>
          )
        : null}
    </>
  )

  if (!full) {
    return (
      <View style={styles.flex}>
        <View style={styles.flex}>
          {head}
          {listingsRow}
          {ratingsRow}
          {pageNoticeSheet}
          <OfflineNote />
          <View style={styles.note}><Soft>{node.hosted ? OFFLINE_NOTE : NOT_HOSTED_NOTE}</Soft></View>
        </View>
      </View>
    )
  }

  const { phase, error, items, unavailable, atEnd, indexing, complete, loadingMore, moreError, refreshing } = posts
  // K1's blocks past its move are what a leaked key appended: never shown.
  const cut = movedView !== null ? movedView.cut : null
  const shownItems = cut === null ? items : items.filter((i) => shownUnderCut(cut, i.seq))
  const notes = []
  if (phase === 'ready' && indexing) notes.push('Ainda montando a lista completa…')
  else if (phase === 'ready' && complete === false) notes.push('Algumas publicações podem faltar.')
  if (unavailable > 0) notes.push(unavailable === 1 ? '1 publicação indisponível' : String(unavailable) + ' publicações indisponíveis')

  const listHeader = (
    <View>
      {head}
      {blockedHere ? null : listingsRow}
      {blockedHere ? null : ratingsRow}
      <OfflineNote />
      {notes.length > 0 ? <View style={styles.note}>{notes.map((n) => <Soft key={n}>{n}</Soft>)}</View> : null}
    </View>
  )

  let empty = null
  if (blockedHere && phase !== 'loading') empty = <EmptyState icon='bloquear' title={BLOCK_TEXTS.profileTitle} body={BLOCK_TEXTS.profileBody} />
  else if (phase === 'loading') empty = <Skeleton />
  else if (phase === 'error') empty = <ErrorState message={displayText(error)} onRetry={() => { setTick((n) => n + 1); load(false) }} pending={refreshing} />
  else if (unavailable === 0) empty = <EmptyState icon='lapis' title='Nenhuma publicação ainda' />

  const muralCols = fontScale >= LARGE_TEXT ? 2 : 3
  const muralRows = muralGridRows(muralTiles, muralCols)
  // A failed page shows only the error row with its retry, not Ver mais too.
  const muralState = atEnd ? 'end' : (loadingMore || posts.refreshing || (muralFill === 'more' && !moreError && posts.before !== null)) ? 'loading' : moreError ? 'error' : 'capped'
  // The post a tile came from, seeded as a Publicações row seeds it, so the
  // thread shows it even when the network cannot be read.
  const muralSeed = (tile) => {
    const item = items.find((i) => i.kind === 'post' && i.author === tile.author && i.seq === tile.seq)
    return item ? { ...item, name: item.name || header.name, username: item.username || header.username } : null
  }
  const renderMural = ({ item }) => (
    <MuralRow item={item} columns={muralCols} persist={own || isFollowed} onOpen={(tile) => onOpenThread({ ref: tile.ref, seed: muralSeed(tile) })} />
  )

  const listFooter = phase !== 'ready'
    ? null
    : mural
      ? (
        <MuralFooter
          count={muralTiles.length}
          state={muralState}
          complete={!indexing && complete !== false}
          onMore={loadMore}
          footer={moreError ? <ListFooter error={moreError} onRetry={loadMore} pending={loadingMore} /> : null}
        />
        )
      : (
        <ListFooter
          loading={loadingMore}
          atEnd={atEnd && shownItems.length > 0}
          endText='Isso é tudo por enquanto.'
          error={moreError}
          onRetry={loadMore}
          pending={loadingMore}
        />
        )

  const handlers = { onOpenThread, onOpenMember, onOpenMention, onOpenEngagers, onReply, onQuote, onReport, onMessage }
  const memberWho = { author, name: header.name, username: header.username }
  const renderItem = ({ item }) => {
    const peeked = peekedRef.current
    const post = shownPost(item, peeked)
    if (post === null) return null
    const extra = item.kind === 'repost' ? { repostedBy: memberWho } : {}
    // The member's own posts carry the header's identity.
    const shown = post.author === author ? { ...post, name: post.name || header.name, username: post.username || header.username } : post
    return <PostRow {...rowProps({ item: shown, names, peeked, now, ownKey, follows, eng, handlers, extra })} />
  }

  return (
    <View style={styles.flex}>
      <View style={styles.flex}>
        <RefreshableList
          data={depo ? testimonialTab.items : phase === 'ready' ? (mural ? muralRows : shownItems) : []}
          keyExtractor={depo ? testimonialTab.keyExtractor : mural ? (row) => 'm' + row.key : (i) => i.kind + ':' + i.seq}
          renderItem={depo ? testimonialTab.renderItem : mural ? renderMural : renderItem}
          extraData={depo ? testimonialTab.extraData : { eng, follows, now, header, profileOf: names.profileOf }}
          ListHeaderComponent={listHeader}
          ListEmptyComponent={depo || (mural && phase === 'ready') ? null : empty}
          ListFooterComponent={depo ? testimonialTab.footer : listFooter}
          // Always tall enough to scroll the band away: a short list (a small
          // Mural, a tab switch) would otherwise rest with the bar half faded.
          // The 8 pt more tuck the avatar ring, which hangs 48 pt below the
          // band, fully under the 44 pt bar when there is no top inset.
          contentContainerStyle={{ paddingBottom: bottomPad, minHeight: windowHeight + insets.top + BAND + 8 }}
          onRefresh={() => { setTick((n) => n + 1); load(true) }}
          refreshing={refreshing}
          onLoadMore={phase === 'ready' && !mural && !depo && !atEnd && !moreError ? loadMore : undefined}
          loadingMore={loadingMore}
          loadMoreError={!!moreError}
          atEnd={atEnd || mural || depo}
          onScrollFrame={bar.handleScrollFrame}
        />
        <ProfileBar bar={bar} topInset={insets.top} title={displayText(who.title)} onBack={onBack} />
        {pageNoticeSheet}
      </View>
      {testimonialTab.sheets}
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  note: { paddingHorizontal: 16, paddingVertical: 12, gap: 4 },
  listings: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.line },
  pageNote: { marginTop: 8, gap: 8 },
  badge: { ...type.postMeta, color: colors.ink, fontWeight: '700' },
  banner: { ...type.postName, color: colors.ink },
  bannerBox: { gap: 8 },
  bannerRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  roster: { gap: 6 },
  rosterSection: { gap: 2 },
  rosterTitle: { ...type.postMeta, color: colors.soft },
  rosterName: { ...type.postName, color: colors.ink },
  rosterSoft: { ...type.postMeta, color: colors.soft },
  pressed: { opacity: 0.6 },
  countsNote: { marginTop: 4 },
  shareBody: { padding: 16, gap: 12 }
})
