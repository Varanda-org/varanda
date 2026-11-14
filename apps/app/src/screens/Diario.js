// Diário: the person's own profile header (sunset band, avatar, name and
// @nome from profile.read, bio, counts) over the own log (log.read), newest first, paged backwards with
// infinite scroll and pull to refresh. On the hosted web, 'Compartilhar'
// under the profile data opens a sheet with the link (copiar link /
// compartilhar; the /m/<key> form is never printed). Only publications are
// listed (PostRows): technical records and invalid blocks are not shown. Posts still in the
// outbox ('Aguardando envio', browser node) are listed above them; they are
// not PostRows (no reply, no publication date yet). The public key is shown
// only in Ajustes > Avançado. A queued item this page session did not write waits for the person
// ('enviar'). The 'ver novidades' pill (web only) follows the own-synced line
// growing, i.e. another device published; the native node has no such
// signal, so on native only the pull, the tab and the refresh prop reload.
// Own posts carry the action bar (counts on the hosted web; liking and
// reposting the own posts is allowed), quotes show the quoted post, and the
// own reposts still on show the original under 'Você republicou' (only the
// newest repost record per target counts; likes are not listed). Originals,
// counts and the own state come from A Rua's useSocial.
// The own 'seguindo' count comes from the local node; 'seguidores' comes
// from the seeder (hosted only, useFollowCounts) and can be lower than
// reality, hence the note under the counts.
// Momentos (hosted only): under the profile header, never a tab, the own
// live moments ('Seus momentos (24 h)', opening the own viewer) and the own
// expired ones ('Momentos anteriores (N)', collapsed) with Apagar
// (../ui/MomentosStrip DiarioMoments, moment.delete after a confirmation).
// Snapshot (../screenSnapshot.js, kind 'diario'): the last fresh first page
// of the own diary is painted at once on the next mount, with loadedAt left
// null so the live read still runs and replaces it. Only while acting as the
// member, never in the Vitrine.
// Design: apps/site/artwork/app-design.md.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { LOG_LIMIT_MAX, displayText } from '@varanda/rpc'
import { perfMarks, useNode } from '../node'
import { useNames } from '../names'
import { useOutbox } from '../outboxProvider'
import { UNCERTAIN_MESSAGE } from '../outbox'
import { deletePostRows } from '../deletion'
import { pinnedContentStyle } from '../profileBar'
import { revokeDeletedMedia } from '../media/cache'
import { formatCount, relativeTime } from '../format'
import { isLastLogPage, logRows, mergeOlderRows, oldestSeq, shouldReloadDiario } from '../paging'
import { lastLocalWrite } from '../localWrites'
import { buildProfileUrl } from '../profileLink'
import { installationOrigin } from '../installation'
import { whoOf } from '../who'
import { fillState, hideFuture, tilesFromLog } from '../mural'
import { ErrorText, SectionHeader, Soft, errorText, plainMessage, useAction, useBottomPad, useNow } from '../ui'
import { Icon } from '../ui/Icon'
import { Pill } from '../ui/Pill'
import { PostRow } from '../ui/PostRow'
import { RefreshableList } from '../ui/RefreshableList'
import { ShareProfile, shareProfileDirect } from '../ui/ShareProfile'
import { Sheet } from '../ui/Sheet'
import { EmptyState, ErrorState, ListFooter, SkeletonRow } from '../ui/States'
import { PressScale } from '../ui/PressScale'
import { ProfileHeader, ProfileStatus } from '../ui/ProfileHeader'
import { MuralFooter, MuralRow, muralGridRows } from '../ui/MuralGrid'
import { Segmented } from '../ui/Segmented'
import { CommunitiesBox } from '../ui/CommunitiesBox'
import { communitiesOf } from '../communitiesBox'
import { BAR, ProfileBar, usePinnedTabSelect, useProfileBar } from '../ui/ProfileBar'
import { BellButton } from '../ui/TopActions'
import { HelpButton } from '../ui/Help'
import { HELP } from '../help'
import { COUNTS_INCOMPLETE_NOTE } from '../pessoas'
import { useFollowCounts } from '../useFollowCounts'
import { LARGE_TEXT, space, type } from '../ui/theme'
import { useStyles } from '../ui/ThemeProvider'
import Perfil from './Perfil'
import { CountsNote, RepostPlaceholder, SocialToast, liveBinding, refOf, snapshotRowsShown, socialRowProps, useSocial } from './ARua'
import { DeletePrompt, useActing, useDelete } from './Conversa'
import { TESTIMONIALS_TAB, useTestimonialTab, useTestimonials } from './Depoimentos'
import { ConfirmMomentDelete, useMoments } from './Momentos'
import { DiarioMoments } from '../ui/MomentosStrip'
import { useBlocks } from '../blocksProvider'
import { cacheGeneration } from '../localCaches'
import { actingAsMember, buildScreenSnapshot } from '../screenSnapshot'
import { clearScreenSnapshot, loadScreenSnapshot, saveScreenSnapshot } from '../screenSnapshotStore'

const BAND = 96
const TABS = [{ id: 'posts', label: 'Publicações' }, { id: 'mural', label: 'Mural' }]
// Depoimentos is the third tab only on a hosted node (node.hosted === true).
const TABS_HOSTED = TABS.concat([TESTIMONIALS_TAB])
// Same coalescing window as the Comunidades list.
const COMMUNITIES_DELAY_MS = 800
// The Vitrine's fixtures never meet this device's stored snapshot.
// Same debounce as A Rua's snapshot write.
const SNAPSHOT_DEBOUNCE_MS = 2000

// -> { data, social } to paint from the stored 'diario' snapshot of
// `binding` (liveBinding) while acting as the member, or null. `data` has the
// shape of a live page plus `seeded` and `oldest` (the next `before`: the
// page's technical records were not kept, so the last row does not bound it).
// `social` is a useSocial seed with the stored originals only.
export function diarioSeed (snapshot) {
  if (snapshot === null || snapshot.body.rows.length === 0) return null
  const b = snapshot.body
  const rows = b.rows.map((r) => ({ seq: r.seq, entry: { seq: r.seq, record: r.record } }))
  return {
    data: { info: { publicKey: snapshot.owner }, rows, atEnd: b.atEnd, oldest: b.oldest, seeded: true },
    social: { originals: Object.entries(b.originals), counts: new Map(), liked: [], reposted: [] }
  }
}

function readDiarioSeed (binding, acting) {
  // Vitrine runs with config null, so liveBinding gives no binding there.
  if (binding === null || !actingAsMember(acting)) return null
  return diarioSeed(loadScreenSnapshot('diario', { ...binding, acting, now: Date.now() }))
}

// The rows on screen as a log.read answer, for buildScreenSnapshot: a deleted
// post is already an invalid slot there, so it is never stored again.
export function diarioLogOf (data, owner) {
  const entries = []
  const invalid = []
  for (const row of data.rows) {
    if (row.entry) entries.push(row.entry)
    else if (row.invalid) invalid.push(row.invalid)
  }
  return { key: owner, entries, invalid, entriesTruncated: data.atEnd ? 0 : 1 }
}

// Whether `rows` still hold a row deleted in this session (`deleted`: seqs).
export function holdsDeleted (rows, deleted) {
  return rows.some((row) => !!row.entry && deleted.has(row.seq))
}

// The seqs of the stored rows that may show, by A Rua's rule for its stored
// rows (snapshotRowsShown): reposts of a blocked author go, and while the
// block list failed only own rows that name no one else stay.
export function seededSeqsShown (rows, blocks, owner, originalOf) {
  const items = []
  for (const row of rows) {
    const record = row.entry && row.entry.record
    if (!record) continue
    if (record.type === 'post') items.push(postOf(owner, row.seq, record))
    else if (record.type === 'repost') items.push({ kind: 'repost', author: owner, seq: row.seq, to: record.to })
  }
  return new Set(snapshotRowsShown(items, blocks.keys, blocks.loadState, owner, originalOf).map((i) => i.seq))
}

// Same rule as A Rua's write: the passkey identity is unlocked, not signed
// out and is `owner`; a node without one has nothing to lock.
function sessionAllowsDiarioSnapshot (passkey, owner) {
  if (passkey === null || passkey === undefined) return true
  const st = passkey.status
  return st !== null && typeof st === 'object' && st.unlocked === true && st.signedOut !== true &&
    typeof st.publicKey === 'string' && st.publicKey.toLowerCase() === owner
}

// The state line of an outbox item. `held`: queued, but not sent
// automatically (found in storage from an earlier visit).
function PendingState ({ item, held }) {
  if (item.state === 'sending') return <ProfileStatus icon='sinc' label='enviando…' />
  if (held) return <ProfileStatus icon='seta_cima' label='toque para enviar' />
  if (item.state === 'uncertain') return <ErrorText>{UNCERTAIN_MESSAGE}</ErrorText>
  if (item.state === 'failed') return <ErrorText>{displayText(plainMessage(item.lastError))}</ErrorText>
  return <ProfileStatus icon='semconexao' label='vai sair quando a conexão voltar' />
}

// Only publications are listed: records the person never wrote by hand (profile,
// certificate, @nome, media, likes) and invalid blocks stay out of the timeline.
const isPostRow = (row) => !row.invalid && !!row.entry && !!row.entry.record && row.entry.record.type === 'post'
const isRepostRow = (row) => !row.invalid && !!row.entry && !!row.entry.record && row.entry.record.type === 'repost'

// The seqs of the repost records still on: the newest record per target, when
// it is `on`. Rows are loaded newest first, so a newer record of the same
// target is always already loaded.
function liveReposts (rows) {
  const latest = new Map()
  for (const row of rows) {
    if (!isRepostRow(row)) continue
    const ref = refOf(row.entry.record.to)
    if (ref === null) continue
    const known = latest.get(ref)
    if (!known || row.seq > known.seq) latest.set(ref, { seq: row.seq, on: row.entry.record.on === true })
  }
  const live = new Set()
  for (const v of latest.values()) if (v.on) live.add(v.seq)
  return live
}

// What a page of own rows needs: counts and own state of the own posts and
// the originals of the reposts; originals and quoted posts to resolve; the
// parents of own replies (useSocial reads only strangers' ones).
function rowNeeds (rows, publicKey) {
  const local = new Map()
  const shown = []
  const need = []
  const parents = new Set()
  for (const row of rows) {
    if (row.invalid || !row.entry || !row.entry.record) continue
    const record = row.entry.record
    if (record.type === 'post') {
      const ref = publicKey + ':' + row.seq
      shown.push(ref)
      local.set(ref, postOf(publicKey, row.seq, record))
      const q = refOf(record.quote)
      if (q !== null) need.push(q)
      const p = refOf(record.replyTo)
      if (p !== null) parents.add(p)
    } else if (record.type === 'repost' && record.on === true) {
      const ref = refOf(record.to)
      if (ref !== null) {
        shown.push(ref)
        need.push(ref)
      }
    }
  }
  for (const ref of local.keys()) parents.delete(ref)
  return { local, shown, need, parents: [...parents], authors: [publicKey] }
}

// A post item (the feed shape) of an own post record.
function postOf (author, seq, record) {
  return {
    kind: 'post',
    author,
    seq,
    at: record.at,
    text: record.text,
    replyTo: record.replyTo || null,
    quote: record.quote || null,
    preview: record.preview || null,
    media: Array.isArray(record.media) && record.media.length > 0 ? record.media : null,
    name: null,
    username: null
  }
}

export default function Diario ({ active, refresh, onSettings, onReply, onPublish, onOpenThread, onOpenMember, onOpenMention, onOpenEngagers, onQuote, onToast, onReport, ownKey, scrollToTop, onDeletedPost, onAvisos, avisosNew, onOpenPeople, onOpenCommunity, onOpenTestimonials, onMessage, onOpenMomentos, onTabChange }) {
  const styles = useStyles(makeStyles)
  const node = useNode()
  const names = useNames()
  const outbox = useOutbox()
  const insets = useSafeAreaInsets()
  const now = useNow(60000)
  const bottomPad = useBottomPad()
  const acting = useActing()
  const memberActing = actingAsMember(acting)
  const binding = useMemo(() => (memberActing ? liveBinding(ownKey, node.config) : null), [memberActing, ownKey, node.config])
  // Read once, in the first render, so the first frame paints it and the
  // first loadNewest (an effect) comes after it.
  const [boot] = useState(() => readDiarioSeed(binding, acting))
  // { info, rows, atEnd } from the loads (plus `seeded` and `oldest` for the
  // stored page), or null before the first answer.
  const [data, setData] = useState(() => (boot === null ? null : boot.data))
  const [loadError, setLoadError] = useState('')
  const [loadingMore, setLoadingMore] = useState(false)
  const [olderError, setOlderError] = useState('')
  // True while the newest page is read: the Mural fill waits for it, then
  // runs again whether the read worked or failed.
  const [newestLoading, setNewestLoading] = useState(false)
  const [editing, setEditing] = useState(false)
  const [sharing, setSharing] = useState(false)
  const [pulls, setPulls] = useState(0)
  // 'posts' | 'mural' | 'depoimentos'. The state lives here, so it survives a
  // visit to a thread.
  const [tab, setTab] = useState('posts')
  const muralPages = useRef(0)
  const { fontScale, height: windowHeight } = useWindowDimensions()
  const pull = useAction()
  const seqRef = useRef(0)
  const olderBusy = useRef(false)
  // A newest page is on its way: an older page started now would take its
  // cursor from the rows that page is about to replace.
  const newestBusy = useRef(false)
  const lastRefresh = useRef(refresh)
  // When the rows on screen were read; null when not fresh (never, failed, or a new node epoch).
  const loadedAtRef = useRef(null)
  const dataRef = useRef(null)
  dataRef.current = data
  // The identity (epoch and passkey generation, both live at the render) the
  // rows' own key was read under; the key is reused only while it still holds.
  const identityRef = useRef(null)
  identityRef.current = { epoch: node.epoch, generation: node.passkey ? node.passkey.generation : undefined, hosted: node.hosted === true }
  const infoIdentityRef = useRef(null)

  const { learn, resolve, invalidate, profileOf } = names
  const { request, ackFresh } = node
  const ownPublicKey = typeof ownKey === 'string' ? ownKey : (data && typeof data.info.publicKey === 'string' ? data.info.publicKey : null)
  const social = useSocial({ ownKey: ownPublicKey, onToast, seed: boot === null ? null : boot.social })
  const blocks = useBlocks()
  // The snapshot write armed after a live first page or a deletion: the
  // generation is read when it is armed, so a wipe or prune meanwhile
  // discards it.
  const snapshotTimer = useRef(null)
  const snapshotGen = useRef(null)
  const deletionsRef = useRef(0)
  // Seqs deleted in this session: a page read before a deletion may still
  // hold one, and it must never be written back.
  const deletedSeqsRef = useRef(new Set())
  const liveMarkedRef = useRef(false)
  const latestRef = useRef(null)
  latestRef.current = { binding, acting, passkey: node.passkey, originals: social.social.originals, persistOf: social.persistOf, blocked: blocks.keys }
  const writeSnapshot = useCallback(() => {
    snapshotTimer.current = null
    const gen = snapshotGen.current
    snapshotGen.current = null
    const l = latestRef.current
    const cur = dataRef.current
    if (gen === null || l.binding === null || cur === null) return
    // Only a deletion arms a write over stored rows: the stored page still
    // holds the deleted post, so it goes until a live page replaces it.
    if (cur.seeded || holdsDeleted(cur.rows, deletedSeqsRef.current)) {
      clearScreenSnapshot('diario')
      return
    }
    if (!actingAsMember(l.acting) || !sessionAllowsDiarioSnapshot(l.passkey, l.binding.owner)) return
    if (typeof cur.info.publicKey !== 'string' || cur.info.publicKey.toLowerCase() !== l.binding.owner) return
    const snapshot = buildScreenSnapshot('diario', {
      ...l.binding,
      acting: l.acting,
      log: diarioLogOf(cur, l.binding.owner),
      originals: l.originals,
      followed: l.persistOf,
      blocked: l.blocked
    })
    // An empty first page leaves nothing to paint, not the old rows.
    if (snapshot === null) clearScreenSnapshot('diario')
    else saveScreenSnapshot('diario', snapshot, gen)
  }, [])
  const armSnapshot = useCallback(() => {
    if (latestRef.current.binding === null) return
    clearTimeout(snapshotTimer.current)
    snapshotGen.current = cacheGeneration()
    snapshotTimer.current = setTimeout(writeSnapshot, SNAPSHOT_DEBOUNCE_MS)
  }, [writeSnapshot])
  useEffect(() => () => clearTimeout(snapshotTimer.current), [])
  useEffect(() => {
    if (boot !== null) perfMarks().mark('rows-snapshot:diario')
  }, [])
  // Stored rows of another owner (sign-out, another diary) never stay.
  useEffect(() => {
    const cur = dataRef.current
    if (cur !== null && cur.seeded && (binding === null || cur.info.publicKey !== binding.owner)) {
      dataRef.current = null
      setData(null)
    }
  }, [binding])
  const followCounts = useFollowCounts(ownPublicKey, String(refresh) + ':' + pulls)
  // Own depoimentos and the ones waiting for approval (hosted only).
  const testimonials = useTestimonials(ownPublicKey, { withPending: true, tick: String(refresh) + ':' + pulls, active: active !== false })
  // Own live and past moments (hosted only).
  const moments = useMoments({ ownKey: ownPublicKey, active: active !== false, tick: String(refresh) + ':' + pulls })
  const [momentDeleting, setMomentDeleting] = useState(null)
  const tabs = node.hosted === true ? TABS_HOSTED : TABS
  // A tab the node no longer offers (not hosted) falls back to Publicações.
  const shownTab = tabs.some((t) => t.id === tab) ? tab : 'posts'
  // The tab on screen, not the raw state: a tab the node no longer offers shows
  // Publicações, and the publish button follows what is shown.
  useEffect(() => { if (onTabChange) onTabChange(shownTab) }, [shownTab])
  const depo = shownTab === 'depoimentos'
  const testimonialTab = useTestimonialTab({
    data: testimonials,
    own: true,
    ownKey: ownPublicKey,
    onOpenAll: typeof onOpenTestimonials === 'function' && ownPublicKey ? () => onOpenTestimonials(ownPublicKey) : undefined,
    onOpenMember,
    onReport: typeof onReport === 'function' ? onReport : undefined
  })
  const { ingest } = social
  // The own admitted communities (community.list), read on every activation,
  // refresh and pull, and again when a group changes: the tab stays mounted
  // while the person joins, creates or leaves a community elsewhere.
  const [communities, setCommunities] = useState([])
  const groupVersions = node.groupVersions
  const communitiesVersions = useRef(groupVersions)
  useEffect(() => {
    let alive = true
    if (node.hosted !== true) {
      setCommunities([])
      return
    }
    if (!active) return
    // A burst of groups.changed events costs one read.
    const delay = groupVersions !== communitiesVersions.current ? COMMUNITIES_DELAY_MS : 0
    communitiesVersions.current = groupVersions
    const timer = setTimeout(() => {
      request('community.list', {}).then((res) => { if (alive) setCommunities(communitiesOf(res)) }, () => {})
    }, delay)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [node.hosted, request, refresh, pulls, active, groupVersions])
  // Replaces the rows with the newest page (a refresh).
  const loadNewest = useCallback(async (refreshProfile = false) => {
    const mine = ++seqRef.current
    const deletions = deletionsRef.current
    // The rows are as fresh as the start of the read: a write that lands
    // while it runs may be missing, so it must still count as newer.
    const startedAt = Date.now()
    newestBusy.current = true
    setNewestLoading(true)
    setLoadingMore(false)
    setOlderError('')
    olderBusy.current = false
    const knownKey = dataRef.current && dataRef.current.info.publicKey
    if (refreshProfile && typeof knownKey === 'string') invalidate([knownKey])
    const identity = identityRef.current
    // Hosted reads borrow the live sync run instead of preempting it, so
    // node.info (a round trip that changes nothing) is skipped when the key
    // was read under this same identity. A new epoch (connect, lock, unlock,
    // sign out) or passkey generation (the identity may have changed) forces
    // the read again, so a key of another identity never reads this diary.
    const reuseInfo = !refreshProfile && identity.hosted && dataRef.current !== null &&
      infoIdentityRef.current !== null && identity.generation !== undefined &&
      infoIdentityRef.current.epoch === identity.epoch &&
      infoIdentityRef.current.generation === identity.generation
    try {
      // Core nodes: one read after the other, since each read preempts a running sync.
      let info = reuseInfo ? dataRef.current.info : await request('node.info', {})
      if (refreshProfile && mine === seqRef.current && typeof info.publicKey === 'string' && info.publicKey !== knownKey) {
        invalidate([info.publicKey])
      }
      const log = await request('log.read', { limit: LOG_LIMIT_MAX })
      // The node can switch identity a round trip before the epoch moves
      // (passkeyOp re-reads the status first): log.read names the diary it
      // read, so a reused key that is not that diary's is read again.
      if (reuseInfo && log.key !== info.publicKey) info = await request('node.info', {})
      if (mine !== seqRef.current) return
      const rows = logRows(log)
      if (!reuseInfo) infoIdentityRef.current = identity
      // The older pages are gone with the replaced rows: the Mural fill
      // budget starts over with them.
      muralPages.current = 0
      setData({ info, rows, atEnd: isLastLogPage(log) })
      loadedAtRef.current = startedAt
      if (!liveMarkedRef.current) {
        liveMarkedRef.current = true
        perfMarks().mark('rows-live:diario')
      }
      // A post deleted while this page was read may still be on it.
      if (deletions === deletionsRef.current) armSnapshot()
      setLoadError('')
      setOlderError('')
      setLoadingMore(false)
      olderBusy.current = false
      ackFresh(['own'])
      if (typeof info.publicKey === 'string') resolve(info.publicKey)
      for (const entry of log.entries) {
        const record = entry.record
        if (record && record.type === 'post' && record.replyTo) resolve(record.replyTo.author)
      }
      if (typeof info.publicKey === 'string') ingest({ ...rowNeeds(rows, info.publicKey), reset: true })
    } catch (err) {
      if (mine === seqRef.current) {
        loadedAtRef.current = null
        setLoadError(errorText(err))
      }
    } finally {
      if (mine === seqRef.current) {
        newestBusy.current = false
        setNewestLoading(false)
      }
    }
  }, [request, ackFresh, resolve, invalidate, ingest, armSnapshot])

  // Appends the next older page; never while one is loading.
  const loadOlder = useCallback(async () => {
    const current = dataRef.current
    if (current === null || current.atEnd || olderBusy.current || newestBusy.current) return
    olderBusy.current = true
    const mine = seqRef.current
    setLoadingMore(true)
    setOlderError('')
    try {
      const before = current.seeded && Number.isSafeInteger(current.oldest) ? current.oldest : oldestSeq(current.rows)
      const log = await request('log.read', { limit: LOG_LIMIT_MAX, before })
      // The cursor came from `current`: a newest page that replaced it
      // meanwhile would leave a gap between the two. A deletion also replaces
      // it, so a stale page must not restore the deleted content.
      if (mine !== seqRef.current || dataRef.current !== current) return
      const base = dataRef.current
      setData({ info: base.info, rows: mergeOlderRows(base.rows, log), atEnd: isLastLogPage(log), ...(base.seeded ? { seeded: true } : {}) })
      for (const entry of log.entries) {
        const record = entry.record
        if (record && record.type === 'post' && record.replyTo) resolve(record.replyTo.author)
      }
      if (typeof base.info.publicKey === 'string') ingest(rowNeeds(logRows(log), base.info.publicKey))
    } catch (err) {
      if (mine !== seqRef.current || dataRef.current !== current) return
      setOlderError(errorText(err))
    } finally {
      if (mine === seqRef.current) {
        setLoadingMore(false)
        olderBusy.current = false
      }
    }
  }, [request, resolve, ingest])

  // The own-diary growth signal at this render: an activation that is about
  // to acknowledge it re-reads the profile too, or a change made on another
  // device would be acknowledged without reaching the header and the editor.
  const ownGrew = !!(node.signals && node.signals.fresh && typeof node.signals.fresh.own === 'number')
  const ownGrewRef = useRef(ownGrew)
  ownGrewRef.current = ownGrew
  // Declared before the activation effect: it runs first when the epoch moves.
  useEffect(() => { loadedAtRef.current = null }, [node.epoch])
  useEffect(() => {
    if (!active) return
    // A refresh bump while hidden is consumed on the next activation.
    const forced = refresh !== lastRefresh.current || ownGrewRef.current
    if (!shouldReloadDiario({ hosted: node.hosted, loadedAt: loadedAtRef.current, now: Date.now(), forced, wroteAt: lastLocalWrite() })) return
    lastRefresh.current = refresh
    loadNewest(forced)
  }, [active, loadNewest, refresh, node.hosted])

  const reload = () => {
    setPulls((n) => n + 1)
    return pull.run(() => loadNewest(true))
  }

  // Pages with no publication (only technical records) are paged through by
  // RefreshableList's infinite scroll, which pauses after a few dry pages.
  // Publications: posts (quotes included) and the reposts still on.
  const shownRows = useMemo(() => {
    if (data === null) return []
    const live = liveReposts(data.rows)
    // Stored rows meet the block list as soon as it is known; live ones come
    // from the node, which already applies it.
    const originals = social.social.originals
    const allowed = data.seeded === true ? seededSeqsShown(data.rows, blocks, data.info.publicKey, (ref) => originals.get(ref)) : null
    return data.rows.filter((row) => (isPostRow(row) || (isRepostRow(row) && live.has(row.seq))) && (allowed === null || allowed.has(row.seq)))
  }, [data, blocks, social.social.originals])

  const info = data === null ? null : data.info
  const posts = shownRows
  const mural = tab === 'mural'
  const publicKey = info && typeof info.publicKey === 'string' ? info.publicKey : null
  const profile = publicKey ? profileOf(publicKey) : undefined
  // Only the rows log.read already loaded: no extra read for the Mural.
  const muralTiles = useMemo(() => {
    if (!mural || data === null || publicKey === null) return []
    return hideFuture(tilesFromLog(publicKey, data.rows), now)
  }, [mural, data, publicKey, now])
  const muralFill = data === null ? 'end' : fillState({ tiles: muralTiles, atEnd: data.atEnd, pages: muralPages.current })
  // Bounded automatic fill: older pages are read while the Mural is short of
  // photos, up to the cap. After that only 'Ver mais' reads one.
  // A page counts only when a read really starts (loadOlder skips while a
  // refresh or another page runs).
  useEffect(() => {
    if (!mural) { muralPages.current = 0; return }
    if (data === null || loadingMore || newestLoading || olderError) return
    if (muralFill !== 'more') return
    const current = dataRef.current
    if (current === null || current.atEnd || olderBusy.current || newestBusy.current) return
    muralPages.current += 1
    loadOlder()
  }, [mural, data, loadingMore, newestLoading, olderError, muralFill, loadOlder])
  const who = whoOf(profile || undefined)
  const bio = profile && profile.bio ? profile.bio : ''
  const profileUrl = node.hosted === true && publicKey ? buildProfileUrl({ origin: installationOrigin() || globalThis.location?.origin || null, username: profile ? profile.username : null, publicKey }) : null

  const bandHeight = insets.top + BAND
  const hasBell = typeof onAvisos === 'function'
  // The Segmented is the tabs View's last child, so its top in the list is
  // the tabs slot's bottom less its own height (heights stay right on the web,
  // where onLayout skips a move that does not resize).
  const [tabsBottom, setTabsBottom] = useState(null)
  const [segmentedHeight, setSegmentedHeight] = useState(null)
  const tabsTop = tabsBottom !== null && segmentedHeight !== null ? tabsBottom - segmentedHeight : null
  const bar = useProfileBar(bandHeight, { controlsBottom: bandHeight - 12, tabsTop, topInset: insets.top })
  const listRef = useRef(null)
  const selectPinnedTab = usePinnedTabSelect(bar, listRef, shownTab, setTab)
  // The band's controls, drawn in the header and again in the pinned bar.
  const bandControls = (inBar) => (
    <>
      <HelpButton doc={HELP.diario} color='#ffffff' style={inBar ? styles.barButton : (hasBell ? styles.infoShifted : styles.info)} />
      <PressScale
        accessibilityRole='button'
        accessibilityLabel='Ajustes'
        hitSlop={8}
        onPress={() => onSettings('lista')}
        style={inBar ? styles.barButton : (hasBell ? styles.gearShifted : styles.gear)}
      >
        <Icon name='engrenagem' size={20} color='#ffffff' />
      </PressScale>
      {hasBell ? <BellButton color='#ffffff' badged={avisosNew === true} onPress={onAvisos} style={inBar ? styles.barButton : styles.bell} /> : null}
    </>
  )

  // Only this identity's items for this association.
  const pending = info && node.config ? outbox.itemsFor(info.publicKey, node.config.association) : []
  // Queued items not approved in this page session (stored before it, or
  // changed in storage since they were approved): they wait for 'enviar',
  // which approves them exactly as shown here.
  const held = pending.filter((item) => item.state === 'queued' && !outbox.isAllowed(item))
  const heldIds = held.map((item) => item.id)
  // The post a queued reply answers, shown before it is approved: the stored
  // target can be changed by any script of this origin, so the person must
  // see which post 'enviar' approves (the approval covers the target too).
  const replyTargetText = (to) => {
    const sep = typeof to === 'string' ? to.indexOf(':') : -1
    if (sep < 0) return displayText(String(to))
    const author = to.slice(0, sep)
    return displayText(whoOf(profileOf(author) || undefined).title) + ' · #' + displayText(to.slice(sep + 1))
  }
  const outboxList = pending.length > 0
    ? (
      <>
        <SectionHeader>Aguardando envio</SectionHeader>
        {heldIds.length > 0
          ? (
            <View style={styles.pendingAll}>
              <Pill label='Enviar tudo' onPress={() => outbox.release(held)} />
            </View>
            )
          : null}
        {pending.map((item) => (
          <View key={item.id} style={styles.pending}>
            <Text style={styles.pendingText}>{displayText(item.text, { multiline: true })}</Text>
            {item.kind === 'reply'
              ? <Soft>{'resposta a ' + replyTargetText(item.to)}</Soft>
              : null}
            <Soft>
              {'escrito ' + (relativeTime(item.writtenAt, now) ?? displayText(item.writtenAt)) +
                ' · a data será a do envio'}
            </Soft>
            <PendingState item={item} held={heldIds.includes(item.id)} />
            {item.state !== 'sending'
              ? (
                <View style={styles.pendingActions}>
                  {heldIds.includes(item.id)
                    ? <Pill label='Enviar' onPress={() => outbox.release([item])} />
                    : null}
                  {!heldIds.includes(item.id) && (item.state === 'uncertain' || item.state === 'failed')
                    ? <Pill label='Tentar de novo' onPress={() => outbox.retry(item)} />
                    : null}
                  <Pill icon='lixeira' accessibilityLabel='apagar' onPress={() => outbox.discard(item.id)} />
                </View>
                )
              : null}
          </View>
        ))}
      </>
      )
    : null

  const header = info === null
    ? (
      <View>
        {loadError ? <View style={[styles.plainBand, { height: bandHeight }]} /> : <ProfileHeader loading bandHeight={bandHeight} />}
      </View>
      )
    : (
      <View>
        <ProfileHeader
          bandHeight={bandHeight}
          topInset={insets.top}
          bandButtons={bar.interactive ? null : bandControls(false)}
          avatar={{ name: who.avatarName, publicKey: info.publicKey, picture: profile && profile.avatar, persist: true }}
          title={displayText(who.title)}
          subtitle={who.subtitle ? displayText(who.subtitle) : null}
          bio={bio || null}
          counts={[{
            label: 'seguindo',
            value: info.followCount === undefined || info.followCount === null ? null : displayText(formatCount(info.followCount)),
            onPress: typeof onOpenPeople === 'function' ? () => onOpenPeople(ownPublicKey, 'seguindo') : undefined
          }, {
            label: followCounts.seguidores === 1 ? 'seguidor' : 'seguidores',
            value: followCounts.seguidores === null ? null : displayText(formatCount(followCounts.seguidores)),
            onPress: typeof onOpenPeople === 'function' ? () => onOpenPeople(ownPublicKey, 'seguidores') : undefined
          }]}
          note={followCounts.incomplete && followCounts.seguidores !== null ? <View style={styles.countsNote}><Soft>{COUNTS_INCOMPLETE_NOTE}</Soft></View> : null}
          corner={<Pill key='edit' label='Editar perfil' onPress={() => setEditing(true)} />}
          actions={[
            profileUrl !== null ? <Pill key='share' icon='compartilhar' accessibilityLabel='compartilhar perfil' onPress={() => { shareProfileDirect(profileUrl).then((done) => { if (!done) setSharing(true) }) }} /> : null
          ]}
          onTabsLayout={(l) => setTabsBottom(l.y + l.height)}
          tabs={
            <View>
              <DiarioMoments
                hosted={node.hosted === true}
                data={moments}
                now={now}
                onOpenOwn={typeof onOpenMomentos === 'function' && ownPublicKey ? () => onOpenMomentos(ownPublicKey) : undefined}
                onDelete={setMomentDeleting}
              />
              <CommunitiesBox items={communities} title='Suas comunidades' onOpen={typeof onOpenCommunity === 'function' ? onOpenCommunity : undefined} />
              <View onLayout={(e) => setSegmentedHeight(e.nativeEvent.layout.height)}>
                <Segmented options={tabs} selected={shownTab} onSelect={setTab} />
              </View>
            </View>
          }
        />
        {outboxList}
        <CountsNote social={social} />
        <ErrorText>{loadError}</ErrorText>
      </View>
      )

  // A failed page shows only the error row with its retry, not Ver mais too.
  const muralState = data === null ? 'loading' : data.atEnd ? 'end' : (loadingMore || newestLoading || (muralFill === 'more' && !olderError)) ? 'loading' : olderError ? 'error' : 'capped'
  const muralFooter = data !== null
    ? (
      <MuralFooter
        count={muralTiles.length}
        state={muralState}
        onMore={loadOlder}
        emptyBody='As fotos que você publicar aparecem aqui.'
        footer={olderError ? <ListFooter error={olderError} onRetry={loadOlder} pending={loadingMore} /> : null}
      />
      )
    : null

  const footer = data !== null && posts.length > 0
    ? (
      <ListFooter
        loading={loadingMore}
        atEnd={data.atEnd}
        endText='Isso é tudo por enquanto.'
        error={olderError}
        onRetry={loadOlder}
      />
      )
    : null

  // Before the first answer, and for an empty log, under the header.
  let empty
  if (data === null) {
    empty = loadError
      ? <ErrorState message={loadError} onRetry={reload} pending={pull.pending} />
      : <><SkeletonRow /><SkeletonRow /><SkeletonRow /></>
  } else {
    empty = !data.atEnd
      // Older pages remain and none shown so far held a publication: loading
      // (or its error and retry), never the empty state.
      ? <ListFooter loading={loadingMore} atEnd={false} error={olderError} onRetry={loadOlder} pending={loadingMore} />
      : (
        <EmptyState
          icon='lapis'
          title='Você ainda não publicou'
          body='Sua primeira publicação aparece aqui.'
          actionLabel='Publicar'
          onAction={onPublish}
        />
        )
  }

  const del = useDelete({
    request,
    node,
    onToast,
    recheck: () => loadNewest(false),
    // The slot stays (as the node reports it) so the paging cursor holds.
    onDeleted: async (t) => {
      social.deleteOriginal(t.ref)
      const cur = dataRef.current
      if (cur !== null) {
        const rows = deletePostRows(cur.rows, t.ref, cur.info.publicKey)
        rows.forEach((row, i) => { if (row !== cur.rows[i]) deletedSeqsRef.current.add(row.seq) })
        dataRef.current = { ...cur, rows }
        setData(dataRef.current)
      }
      // The own post's seq, also when its row is not loaded (t.seq is the
      // tombstone's, never a deleted row).
      const own = cur !== null && typeof cur.info.publicKey === 'string' ? cur.info.publicKey.toLowerCase() + ':' : null
      if (own !== null && typeof t.ref === 'string' && t.ref.toLowerCase().startsWith(own)) {
        const seq = Number(t.ref.slice(own.length))
        if (Number.isSafeInteger(seq)) deletedSeqsRef.current.add(seq)
      }
      deletionsRef.current++
      armSnapshot()
      if (typeof onDeletedPost === 'function') onDeletedPost()
      // The row is gone. The tombstone's ranges leave the image cache too,
      // so a photo still mounted (the header avatar, another tile) loses
      // its blob URL. A range a surviving post or profile shows stays.
      if (t !== null && typeof t === 'object' && Number.isSafeInteger(t.seq)) {
        await revokeDeletedMedia(request, [t.seq], LOG_LIMIT_MAX)
      }
    }
  })
  // onMessage reaches only reposts of other people's posts: socialRowProps drops it for own posts.
  const handlers = { onOpenThread, onOpenMember, onOpenMention, onOpenEngagers, onReply, onQuote, onMessage, onDelete: del.offered ? del.ask : undefined }
  // An own repost is the ORIGINAL post under 'Você republicou' (every action
  // targets the original); an own post (or quote) targets itself.
  const renderItem = ({ item: row }) => {
    const record = row.entry.record
    if (record.type === 'repost') {
      const ref = refOf(record.to)
      const repostedBy = { author: info.publicKey, name: 'Você', username: null }
      const post = social.original(ref)
      if (!post) return <RepostPlaceholder repostedBy={repostedBy} missing={post === null} transient={social.transient(ref)} onRetry={() => social.retry(ref)} />
      return <PostRow {...socialRowProps({ post, ref, repostedBy, social, profileOf, now, ownKey: info.publicKey, h: handlers })} />
    }
    const post = postOf(info.publicKey, row.seq, record)
    return <PostRow {...socialRowProps({ post, ref: info.publicKey + ':' + row.seq, social, profileOf, now, ownKey: info.publicKey, h: handlers })} />
  }

  const muralCols = fontScale >= LARGE_TEXT ? 2 : 3
  const muralRows = useMemo(() => muralGridRows(muralTiles, muralCols), [muralTiles, muralCols])
  // The post a tile came from, seeded as a Publicações row seeds it, so the
  // thread shows it even when the network cannot be read.
  const muralSeed = (tile) => {
    const row = data === null ? null : data.rows.find((r) => r.seq === tile.seq && r.entry && r.entry.record)
    return row ? postOf(tile.author, tile.seq, row.entry.record) : null
  }
  const renderMural = ({ item }) => (
    <MuralRow item={item} columns={muralCols} persist onOpen={(tile) => onOpenThread({ ref: tile.ref, seed: muralSeed(tile) })} />
  )

  // Rows re-render when a name is learned, the clock ticks or the originals,
  // counts or own state change.
  const extra = useMemo(() => ({ profileOf, now, profile, social: social.social, offered: del.offered }), [profileOf, now, profile, social.social, del.offered])

  return (
    <View style={styles.list}>
      <DeletePrompt del={del} />
      <RefreshableList
        data={depo ? testimonialTab.items : mural ? muralRows : posts}
        keyExtractor={depo ? testimonialTab.keyExtractor : mural ? (row) => 'm' + row.key : (row) => (row.invalid ? 'i' : 'e') + row.seq}
        renderItem={depo ? testimonialTab.renderItem : mural ? renderMural : renderItem}
        extraData={depo ? testimonialTab.extraData : extra}
        ListHeaderComponent={header}
        ListFooterComponent={depo ? testimonialTab.footer : mural ? muralFooter : footer}
        ListEmptyComponent={depo || (mural && data !== null) ? null : empty}
        // Always tall enough to scroll the band away: a short list (a small
        // Mural, a tab switch) would otherwise rest with the bar half faded.
        // The 8 pt more tuck the avatar ring, which hangs 48 pt below the
        // band, fully under the 44 pt bar when there is no top inset.
        // Raised further once the tabs are measured, so a tab picked from the
        // pinned copy can always scroll back to the pin boundary.
        contentContainerStyle={pinnedContentStyle({ paddingBottom: bottomPad, minHeight: windowHeight + bandHeight + 8 }, windowHeight, tabsTop, insets.top + BAR)}
        onRefresh={reload}
        refreshing={pull.pending}
        onLoadMore={mural || depo ? undefined : loadOlder}
        loadingMore={loadingMore}
        loadMoreError={!!olderError}
        atEnd={data === null || mural || depo ? true : data.atEnd}
        scrollToTopSignal={scrollToTop}
        onScrollFrame={bar.handleScrollFrame}
        listRef={listRef}
        newItemsTop={info !== null && bar.interactive ? insets.top + BAR + (bar.pinned && segmentedHeight !== null ? segmentedHeight : 0) + 8 : undefined}
        newItems={{
          label: 'ver novidades',
          visible: !!(node.signals && node.signals.fresh && node.signals.fresh.own),
          onPress: reload
        }}
      />
      {info !== null
        ? (
          <ProfileBar bar={bar} topInset={insets.top} title={displayText(who.title)} tabs={<Segmented options={tabs} selected={shownTab} onSelect={selectPinnedTab} />}>
            {bandControls(true)}
          </ProfileBar>
          )
        : null}
      <Perfil
        open={editing}
        ownKey={info ? info.publicKey : null}
        current={{ name: (profile && profile.name) || '', bio, avatar: profile ? profile.avatar : undefined }}
        onClose={() => setEditing(false)}
        onSaved={(values) => {
          if (info && info.publicKey) {
            learn(info.publicKey, values)
            // The authoritative answer also replaces a cleared bio.
            invalidate([info.publicKey])
          }
          setEditing(false)
          pull.run(loadNewest)
        }}
      />
      {profileUrl !== null
        ? (
          <Sheet open={sharing} onClose={() => setSharing(false)} title='Compartilhar perfil'>
            <View style={styles.shareBody}>
              <ShareProfile url={profileUrl} onNotice={typeof onToast === 'function' ? (m) => { setSharing(false); onToast(m) } : undefined} />
            </View>
          </Sheet>
          )
        : null}
      {testimonialTab.sheets}
      <ConfirmMomentDelete open={momentDeleting !== null} target={momentDeleting} onClose={() => setMomentDeleting(null)} />
      <SocialToast text={social.toast} />
    </View>
  )
}

const bandButton = (colors) => ({
  position: 'absolute',
  bottom: 12,
  width: 34,
  height: 34,
  borderRadius: 17,
  backgroundColor: colors.dim,
  alignItems: 'center',
  justifyContent: 'center'
})

const makeStyles = (colors) => StyleSheet.create({
  list: { flex: 1, backgroundColor: colors.bg },
  plainBand: { backgroundColor: colors.bg },
  barButton: { width: 34, height: 34, borderRadius: 17, backgroundColor: colors.dim, alignItems: 'center', justifyContent: 'center' },
  // The band buttons, right to left: bell (when there is one), gear, help.
  bell: { ...bandButton(colors), right: 16 },
  gear: { ...bandButton(colors), right: 16 },
  gearShifted: { ...bandButton(colors), right: 58 },
  countsNote: { marginTop: space.xs },
  info: { ...bandButton(colors), right: 58 },
  infoShifted: { ...bandButton(colors), right: 100 },
  shareBody: { padding: 16, gap: 12 },
  pending: {
    paddingVertical: 10,
    paddingHorizontal: 16,
    gap: 2,
    borderBottomWidth: 1,
    borderBottomColor: colors.line
  },
  pendingText: { ...type.postText, color: colors.ink },
  pendingActions: { flexDirection: 'row', gap: 8, marginTop: 6 },
  pendingAll: { flexDirection: 'row', paddingHorizontal: 16, paddingBottom: 8 }
})
