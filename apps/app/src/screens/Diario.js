// Diário: the person's own profile header (sunset band, avatar, name and
// @nome from profile.read, bio, counts) over the own log (log.read), newest first, paged backwards with
// infinite scroll and pull to refresh. On the hosted web, 'Compartilhar'
// under the profile data opens a sheet with the link (copiar link /
// compartilhar; the /m/<key> form is never printed). Only publications are
// listed (PostRows): technical records and invalid blocks are not shown. Posts still in the
// outbox ('Aguardando envio', browser node) are listed above them; they are
// not PostRows (no reply, no publication date yet). The public key is shown
// only in Ajustes > Avançado. A queued item this page session did not write waits for the person
// ('enviar'). The 'ver novidades' pill follows newer publications held after
// a snapshot paint or the hosted node's own-diary growth signal.
// Own posts carry the action bar (counts on the hosted web; liking and
// reposting the own posts is allowed), quotes show the quoted post, and the
// own reposts still on show the original under 'Você republicou' (only the
// newest repost record per target counts; likes are not listed). Originals,
// counts and the own state come from A Rua's useSocial.
// The own 'seguindo' count comes from the local node; 'seguidores' comes
// from the seeder (hosted only, useFollowCounts) and can be lower than
// reality, hence the note under the counts.
// Momentos (hosted only): the avatar ring opens the person's live moments,
// even while acting as a Page. Its unseen state follows the shared seen list;
// expired moments stay out of the ring and the profile body.
// Snapshot (../screenSnapshot.js, kind 'diario'): the last fresh first page
// of the own diary is painted at once on the next mount, with loadedAt left
// null so the first live read still runs and verifies the rows in its span.
// log.read asks for publications only (`posts`); a first page that still
// shows none (an older core node) keeps the stored copy until the bounded
// fill finds one, and saves the verified rows down to it.
// Only while acting as the member, never in the Vitrine.
// Design: apps/site/artwork/app-design.md.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { LOG_LIMIT_MAX, displayText } from '@varanda/rpc'
import { perfMarks, useNode } from '../node'
import { useNames } from '../names'
import { useOutbox } from '../outboxProvider'
import { UNCERTAIN_MESSAGE } from '../outbox'
import { canDiscard } from '../outboxSeal'
import { deletePostRows } from '../deletion'
import { pinnedContentStyle } from '../profileBar'
import { revokeDeletedMedia } from '../media/cache'
import { formatCount, relativeTime } from '../format'
import { isLastLogPage, logRows, mergeOlderRows, oldestSeq, settleSeeded, settleSpan, shouldReloadDiario } from '../paging'
import { lastLocalWrite } from '../localWrites'
import { buildProfileUrl } from '../profileLink'
import { installationOrigin } from '../installation'
import { whoOf } from '../who'
import { fillState, hideFuture, tilesFromLog } from '../mural'
import { ErrorText, SectionHeader, Soft, errorText, plainMessage, useAction, useBottomPad, useVisibleNow } from '../ui'
import { Icon } from '../ui/Icon'
import { Pill } from '../ui/Pill'
import { useSaved } from '../savedProvider'
import { PostRow } from '../ui/PostRow'
import { ReminderBanner } from '../ui/ReminderBanner'
import { PostSheetProvider } from '../ui/PostSheetHost'
import { RefreshableList } from '../ui/RefreshableList'
import { ShareProfile, shareProfileDirect } from '../ui/ShareProfile'
import { Sheet, TEXT_CAP } from '../ui/Sheet'
import { EmptyState, ErrorState, ListFooter, SkeletonRow } from '../ui/States'
import { PressScale } from '../ui/PressScale'
import { ProfileHeader, ProfileStatus } from '../ui/ProfileHeader'
import { AboutCard, useProfileExtra } from '../ui/AboutCard'
import { AboutLink, AboutSheet } from '../ui/ProfileAbout'
import { ProfileShortcuts } from '../ui/ProfileShortcuts'
import { ABOUT_LABEL_OWN, aboutHint, avatarMoments, OWN_SHORTCUTS, shortcutList } from '../profileSlim'
import { useOwnMarks } from '../ui/FanButton'
import { TopFriendsRow, useTopFriends } from '../ui/TopFriendsRow'
import { fansCountView, NOTICES } from '../fans.js'
import { ownTopRows } from '../fansView.js'
import { MoodChip } from '../ui/MoodChip'
import { SorteCard } from '../ui/SorteCard'
import { bandTint, extraView } from '../profileExtraView.js'
import { MuralFooter, MuralRow, muralGridRows } from '../ui/MuralGrid'
import { Segmented } from '../ui/Segmented'
import { CommunitiesBox } from '../ui/CommunitiesBox'
import { PublicGroupsBox } from '../ui/PublicGroupsBox'
import { usePublicGroups } from '../usePublicGroups'
import { communitiesOf } from '../communitiesBox'
import { BAR, ProfileBar, usePinnedTabSelect, useProfileBar } from '../ui/ProfileBar'
import { BellButton } from '../ui/TopActions'
import { HelpButton, HelpNote } from '../ui/Help'
import { ProfileQr } from '../ui/ProfileQr'
import { HELP, QR_HINT } from '../help'
import { COUNTS_INCOMPLETE_NOTE } from '../pessoas'
import { useFollowCounts } from '../useFollowCounts'
import { LARGE_TEXT, layout, radius, space, type } from '../ui/theme'
import { useStyles, useTheme } from '../ui/ThemeProvider'
import Perfil from './Perfil'
import { CountsNote, RepostPlaceholder, SocialToast, liveBinding, ownDeletions, refOf, snapshotRowsShown, socialRowProps, useRowPropsCache, useSocial } from './ARua'
import { DeletePrompt, useActing, useDelete } from './Conversa'
import { EditPostSheet } from '../ui/EditPostSheet'
import { editedRecord } from '../postEdit'
import { TESTIMONIALS_TAB, useTestimonialTab, useTestimonials } from './Depoimentos'
import { useMoments, useMomentSeen } from './Momentos'
import { useBlocks } from '../blocksProvider'
import { allowedAuthor, cacheGeneration, wipeEpoch } from '../localCaches'
import { actingAsMember, buildScreenSnapshot } from '../screenSnapshot'
import { sameSnapshotBinding } from './Comunidades'
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
// shape of a live page plus `seeded`, `stored` (the seqs of the stored rows:
// older live pages appended later are not under the stored rows' rule) and
// `oldest` (the next `before`: the page's technical records were not kept, so
// the last row does not bound it).
// `social` is a useSocial seed with the stored originals only.
export function diarioSeed (snapshot) {
  if (snapshot === null || snapshot.body.rows.length === 0) return null
  const b = snapshot.body
  const rows = b.rows.map((r) => ({ seq: r.seq, entry: { seq: r.seq, record: r.record } }))
  return {
    data: { info: { publicKey: snapshot.owner }, rows, atEnd: b.atEnd, oldest: b.oldest, seeded: true, stored: new Set(rows.map((r) => r.seq)) },
    social: { originals: Object.entries(b.originals), counts: new Map(), liked: [], reposted: [] }
  }
}

const rowKeyOf = (row) => (row.invalid ? 'i' : 'e') + row.seq
const keyOf = (row) => String(row.seq)
const compare = (a, b) => a.seq - b.seq
const muralKeyOf = (row) => 'm' + row.key

function readDiarioSeed (binding, acting) {
  // Vitrine runs with config null, so liveBinding gives no binding there.
  if (binding === null || !actingAsMember(acting)) return null
  return diarioSeed(loadScreenSnapshot('diario', { ...binding, acting, now: Date.now() }))
}

// The live rows as a log.read answer, for buildScreenSnapshot: a deleted
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

// The seq of the own post `ref` names, or null. Only that entry is deleted:
// an own repost of it leaves the rows on screen but is still a live entry of
// the diary, so it must not mark the page as holding a deleted row (that
// would keep clearing the copy all session).
export function ownDeletedSeq (ref, owner) {
  if (typeof ref !== 'string' || typeof owner !== 'string') return null
  const own = owner.toLowerCase() + ':'
  if (!ref.toLowerCase().startsWith(own)) return null
  const seq = Number(ref.slice(own.length))
  return Number.isSafeInteger(seq) && seq >= 0 ? seq : null
}

// The stored seqs (`stored`) the block list hides now, by seededSeqsShown.
// Live rows never: the node already applied the list to them.
export function hiddenStoredSeqs (rows, stored, blocks, owner, originalOf) {
  const hidden = new Set()
  if (!(stored instanceof Set) || stored.size === 0) return hidden
  const kept = rows.filter((row) => stored.has(row.seq))
  const allowed = seededSeqsShown(kept, blocks, owner, originalOf)
  for (const row of kept) {
    const record = row.entry && row.entry.record
    if (record && (record.type === 'post' || record.type === 'repost') && !allowed.has(row.seq)) hidden.add(row.seq)
  }
  return hidden
}

// The stored own posts the originals lookup found gone (null): their cached
// text and photos must not stay up until an older page reaches them. A
// pending (undefined) or transient read keeps the row.
export function deletedStoredSeqs (rows, stored, owner, originalOf) {
  const gone = new Set()
  if (!(stored instanceof Set) || stored.size === 0 || typeof owner !== 'string') return gone
  for (const row of rows) {
    if (!stored.has(row.seq) || !isPostRow(row)) continue
    if (originalOf(owner + ':' + row.seq) === null) gone.add(row.seq)
  }
  return gone
}

// `data.rows` without the stored rows the block list hides now
// (hiddenStoredSeqs) or the originals lookup found deleted
// (deletedStoredSeqs): the list and the Mural both read these. Live rows come
// from the node, which already applies both.
export function storedRowsKept (data, blocks, originalOf) {
  if (data.seeded !== true) return data.rows
  const hidden = hiddenStoredSeqs(data.rows, data.stored, blocks, data.info.publicKey, originalOf)
  const gone = deletedStoredSeqs(data.rows, data.stored, data.info.publicKey, originalOf)
  if (hidden.size === 0 && gone.size === 0) return data.rows
  return data.rows.filter((row) => !hidden.has(row.seq) && !gone.has(row.seq))
}

// The seqs of the stored rows that may show, by A Rua's rule for its stored
// rows (snapshotRowsShown): reposts of a blocked author go, and while the
// block list failed only own rows that name no one else stay.
export function seededSeqsShown (rows, blocks, owner, originalOf) {
  const items = []
  for (const row of rows) {
    const record = row.entry && row.entry.record
    if (!record) continue
    if (record.type === 'post') items.push(postOf(owner, row.seq, record, row.entry.edited))
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

// An outbox item whose text is still sealed (not opened since the unlock).
const SEALED_TEXT = 'Texto protegido até desbloquear.'

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
// target is always already loaded. `held` rows (behind the pill) are not
// shown, but a newer repost state among them still turns an older one off.
function liveReposts (rows, held) {
  const latest = new Map()
  for (const row of held ? rows.concat(held) : rows) {
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

// The data after the first live page over a seed (`seeded`: the painted
// data, `live`: { info, rows, atEnd, oldest }), or null to replace. New posts
// or reposts stay held behind the pill (kept in `held`). The older-page
// cursor is the live page's oldest seq even then: log.read's `before` is
// exclusive and every unverified painted row sits below it, so the next older
// read verifies them and also brings any rows between the painted page and
// the live one.
export function firstLivePage (seeded, live) {
  const r = settleSeeded({ seeded: seeded.rows, live: live.rows, last: live.atEnd, complete: true, tail: 'keep', keyOf, compare })
  if (r.replace) return null
  const held = r.held.some((row) => isPostRow(row) || isRepostRow(row))
  return {
    held,
    next: {
      info: live.info,
      rows: held ? r.items : r.items.concat(r.held).sort((a, b) => compare(b, a)),
      atEnd: live.atEnd && r.unverified.length === 0,
      oldest: live.oldest ?? seeded.oldest,
      seeded: r.unverified.length > 0,
      stored: new Set(r.unverified.map(Number)),
      held: held ? r.held : null
    }
  }
}

// The data after an older page `log` read `before` the cursor. Rows the page
// brings above the painted ones (the gap under a held live page) merge in
// place, and stored rows settle only in the span the page covers.
export function olderPageData (current, log, before) {
  const page = logRows(log)
  const end = isLastLogPage(log)
  const { items: rows, unverified } = settleSpan({
    items: mergeOlderRows(current.rows, log),
    unverified: Array.from(current.stored ?? [], String),
    page,
    complete: true,
    from: { seq: before },
    end,
    keyOf,
    compare
  })
  return {
    page,
    data: {
      info: current.info,
      rows,
      atEnd: end,
      oldest: oldestSeq(page) ?? before,
      seeded: unverified.length > 0,
      stored: new Set(unverified.map(Number)),
      held: current.held ?? null
    }
  }
}

// What the debounced snapshot write does: 'save', 'clear' or null. A clear
// writes no data, so it never waits on the session, the binding or the
// generation: a deletion whose save is refused (the session locked, or a
// block or follow change bumped the generation) clears the stored copy, or the
// next launch would paint the deleted post.
export function diarioSnapshotAction ({ live, seeded, holdsDeleted, deletionPending, allowed, current }) {
  if (!live) return seeded ? 'clear' : null
  if (holdsDeleted) return 'clear'
  if (allowed && current) return 'save'
  return deletionPending ? 'clear' : null
}

// What a save does with the built snapshot: 'save', 'clear' or 'keep' (no
// write). `shown`: the publications the source rows show. A page with none
// never overwrites the stored copy unless the whole diary was read, and a page
// with some never clears it because the build painted none of them.
export function diarioSnapshotWrite ({ built, shown, atEnd }) {
  const paints = built !== null && built !== undefined &&
    built.body.rows.some((r) => r.record.type === 'post' || r.record.on === true)
  if (shown > 0) return paints ? 'save' : 'keep'
  return atEnd === true ? 'clear' : 'keep'
}

// Whether a save armed with `gen` may run now: 'current', 'retry' (a prune
// or block change bumped the generation during the delay: the build filters
// by the lists of the flush, so it runs once more as a fresh save) or 'drop'
// (a wipe since the page was read, or the retry was spent).
export function diarioSaveTiming ({ gen, retried, liveGen, liveWipe, generation, wipe }) {
  if (liveWipe !== wipe) return 'drop'
  if (gen === generation && (liveGen === gen || retried === true)) return 'current'
  return retried === true || gen === generation ? 'drop' : 'retry'
}

// The save a first live page arms once its read is done: { gen, retried },
// or null after a deletion, here (`deletions`) or on any screen (`own`),
// since the read began, as the rows may still hold the post. A purge alone
// (the generation moved while the read ran) arms a retried save at the
// current generation: its rows go through purgedRows and the build filters
// under the lists of the flush, and a wipe or a later bump drops it.
export function firstPageSave ({ deletions, deletionsNow, own, ownNow, gen, generation }) {
  if (deletions !== deletionsNow || own !== ownNow) return null
  return gen === generation ? { gen, retried: false } : { gen: generation, retried: true }
}

// The rows that show a publication: posts and the reposts still on. A save
// builds from these, so repost-offs never fill the snapshot's row cap.
export function publicationRows (rows, held) {
  const live = liveReposts(rows, held)
  return rows.filter((row) => isPostRow(row) || (isRepostRow(row) && live.has(row.seq)))
}

export function publicationCount (rows, held) {
  return publicationRows(rows, held).length
}

// The rows a save builds from: the first live page, or, when it shows no
// publication, the newest rows the node verified since (the older pages
// loadOlder appended to `data`, held rows on top). Rows below `data.oldest`
// are still the stored copy's.
export function diarioSnapshotSource (live, data) {
  if (publicationCount(live.rows, null) > 0 || data === null || data === undefined || data.info.publicKey !== live.info.publicKey) return live
  const verified = data.seeded === true
    ? data.rows.filter((row) => typeof data.oldest === 'number' && row.seq >= data.oldest)
    : data.rows
  return { ...live, rows: (data.held ?? []).concat(verified), atEnd: data.atEnd === true && data.seeded !== true }
}

// The rows of the copy on disk (`seededRows`, as the screen started with
// them) without those this run superseded: a row the live reads settled away,
// a repost a newer loaded record turned off, a post the originals lookup found
// deleted. null when none was. A kept copy is rewritten from these, so it
// never paints what the live read already took back.
export function storedCopyRows (seededRows, data, originalOf) {
  if (!Array.isArray(seededRows) || data === null || data === undefined) return null
  const bySeq = new Map(data.rows.map((row) => [row.seq, row]))
  const live = liveReposts(data.rows, data.held)
  const gone = deletedStoredSeqs(data.rows, data.stored, data.info.publicKey, originalOf)
  const kept = []
  for (const was of seededRows) {
    const row = bySeq.get(was.seq)
    if (row === undefined || !row.entry || gone.has(row.seq)) continue
    if (isRepostRow(row) && row.entry.record.on === true && !live.has(row.seq)) continue
    kept.push(row)
  }
  return kept.length === seededRows.length ? null : kept
}

// Whether an older page settled a save that found nothing to store: its
// rows now show a publication, or the whole diary was read (a clear).
export function fillSettled (source) {
  return publicationCount(source.rows, null) > 0 || source.atEnd === true
}

// `rows` without the own reposts of another author that `allowed` now
// refuses: a retried save writes rows read before a purge, and the build
// filters only the originals. As the stored copy's purge (screenSnapshot.js
// prune), an own quote post stays: only its quoted original goes.
export function purgedRows (rows, owner, allowed) {
  const own = owner.toLowerCase()
  return rows.filter((row) => {
    const record = row.entry && row.entry.record
    if (!record || record.type !== 'repost') return true
    const author = record.to && typeof record.to.author === 'string' ? record.to.author.toLowerCase() : null
    return author === null || author === own || allowed(author)
  })
}

// 'more' while no publication is shown, older pages remain and fewer than
// `cap` were read for this first page; else 'full', 'end' or 'capped'.
export function publicationsFill ({ shown, atEnd, pages, cap = 4 }) {
  if (shown > 0) return 'full'
  if (atEnd === true) return 'end'
  if (pages >= cap) return 'capped'
  return 'more'
}

// A core node older than log.read's `posts` refuses it.
export function isUnknownParam (err) {
  return !!err && err.code === 'USAGE' && err.message === 'parâmetro desconhecido'
}

// What a page of own rows needs: counts and own state of the own posts and
// the originals of the reposts; originals and quoted posts to resolve; the
// parents of own replies (useSocial reads only strangers' ones).
// `unverified` seqs are still the cache's text: they are read again, not
// copied into the originals map.
function rowNeeds (rows, publicKey, unverified) {
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
      if (unverified instanceof Set && unverified.has(row.seq)) need.push(ref)
      else local.set(ref, postOf(publicKey, row.seq, record, row.entry.edited))
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

// One post object per record: socialRowProps caches by post identity, so a
// fresh object per render would rebuild every own-post row.
const ownPosts = new WeakMap()
function ownPostOf (author, seq, record, edited = false) {
  const hit = ownPosts.get(record)
  if (hit && hit.author === author && hit.seq === seq && hit.edited === (edited === true)) return hit
  const post = postOf(author, seq, record, edited)
  ownPosts.set(record, post)
  return post
}

// A post item (the feed shape) of an own post record.
function postOf (author, seq, record, edited = false) {
  return {
    kind: 'post',
    edited: edited === true,
    author,
    seq,
    at: record.at,
    text: record.text,
    replyTo: record.replyTo || null,
    quote: record.quote || null,
    preview: record.preview || null,
    media: Array.isArray(record.media) && record.media.length > 0 ? record.media : null,
    ...(Array.isArray(record.poll) ? { poll: record.poll } : {}),
    ...(record.event && typeof record.event === 'object' ? { event: record.event } : {}),
    name: null,
    username: null
  }
}

// One actions sheet for the whole list instead of two per row.
export default function Diario (props) {
  return <PostSheetProvider><DiarioList {...props} /></PostSheetProvider>
}

function DiarioList ({ active, refresh, onSettings, onReply, onPublish, onOpenThread, onOpenMember, onOpenMention, onOpenEngagers, onOpenQuotes, onQuote, onToast, onReport, ownKey, scrollToTop, onDeletedPost, onAvisos, avisosNew, onOpenPeople, onOpenCommunity, onOpenGroup, onOpenTestimonials, onMessage, onOpenMomentos, onOpenSalvos, onOpenRecados, onOpenEventos, onOpenVisitas, onOpenVarandinha, onTabChange, onOpenTop }) {
  const styles = useStyles(makeStyles)
  const { colors, scheme } = useTheme()
  const node = useNode()
  const savedList = useSaved()
  const names = useNames()
  const outbox = useOutbox()
  const insets = useSafeAreaInsets()
  const now = useVisibleNow(60000)
  const bottomPad = useBottomPad()
  const acting = useActing()
  const memberActing = actingAsMember(acting)
  const binding = useMemo(() => (memberActing ? liveBinding(ownKey, node.config) : null), [memberActing, ownKey, node.config])
  // Read once, in the first render, so the first frame paints it and the
  // first loadNewest (an effect) comes after it.
  const [boot] = useState(() => readDiarioSeed(binding, acting))
  // { info, rows, atEnd, oldest } from the loads, with `seeded` and `stored`
  // tracking rows the node has yet to verify.
  const [data, setData] = useState(() => (boot === null ? null : boot.data))
  const [heldNew, setHeldNew] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [loadingMore, setLoadingMore] = useState(false)
  const [olderError, setOlderError] = useState('')
  // True while the newest page is read: the Mural fill waits for it, then
  // runs again whether the read worked or failed.
  const [newestLoading, setNewestLoading] = useState(false)
  const [editing, setEditing] = useState(false)
  const [sharing, setSharing] = useState(false)
  const [showingQr, setShowingQr] = useState(false)
  const [aboutOpen, setAboutOpen] = useState(false)
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
  const liveRef = useRef(null)
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
  // The snapshot write armed after a live first page or a deletion: it
  // carries the generation read when the page's log read started, so a wipe
  // or prune meanwhile refuses the save.
  const snapshotTimer = useRef(null)
  const deletionsRef = useRef(0)
  // deletionsRef at the last write that saved or cleared the copy: a
  // deletion after it is not on the stored copy yet.
  const writtenDeletionsRef = useRef(0)
  // Seqs deleted in this session: a page read before a deletion may still
  // hold one, and it must never be written back.
  const deletedSeqsRef = useRef(new Set())
  const liveMarkedRef = useRef(false)
  const latestRef = useRef(null)
  latestRef.current = { binding, acting, passkey: node.passkey, originals: social.social.originals, persistOf: social.persistOf, blocked: blocks.keys }
  // A save found no publication to store before the end of the diary: the
  // older page that first brings one arms it again.
  const fillSaveRef = useRef(false)
  // The rows the copy on disk holds while it is still the boot seed (or its
  // rewrite), and this run's data still settles them; null once a save, a
  // clear or a replacing read took that away.
  const seedRowsRef = useRef(boot === null ? null : boot.data.rows)
  const writeSnapshot = useCallback((gen, retried) => {
    snapshotTimer.current = null
    const l = latestRef.current
    const live = liveRef.current
    if (l.binding === null) return
    const deletions = deletionsRef.current
    const deletionPending = deletions !== writtenDeletionsRef.current
    let source = live === null ? null : diarioSnapshotSource(live, dataRef.current)
    if (source !== null && retried === true) source = { ...source, rows: purgedRows(source.rows, l.binding.owner, allowedAuthor) }
    const timing = live === null ? 'drop' : diarioSaveTiming({ gen, retried, liveGen: live.gen, liveWipe: live.wipe, generation: cacheGeneration(), wipe: wipeEpoch() })
    const allowed = live !== null && actingAsMember(l.acting) && sessionAllowsDiarioSnapshot(l.passkey, l.binding.owner) &&
      sameSnapshotBinding(live.binding, l.binding) && typeof live.info.publicKey === 'string' && live.info.publicKey.toLowerCase() === l.binding.owner
    // A deletion before the first live page invalidates the stored copy. A
    // deletion arms this timer and then bumps the generation, and it can arm
    // after a wipe whose live page predates it: only a save is refused then.
    const action = diarioSnapshotAction({
      live: live !== null,
      seeded: dataRef.current?.seeded === true,
      holdsDeleted: source !== null && holdsDeleted(source.rows, deletedSeqsRef.current),
      deletionPending,
      allowed,
      current: timing === 'current'
    })
    if (action === null) {
      // Not after a deletion since the read: the rows may still hold it.
      if (timing === 'retry' && allowed && live.deletions === deletions && live.ownDeletions === ownDeletions()) {
        const next = cacheGeneration()
        snapshotTimer.current = setTimeout(() => writeSnapshot(next, true), SNAPSHOT_DEBOUNCE_MS)
      }
      return
    }
    if (action === 'clear') {
      writtenDeletionsRef.current = deletions
      seedRowsRef.current = null
      clearScreenSnapshot('diario')
      return
    }
    const snapshot = buildScreenSnapshot('diario', {
      ...l.binding,
      acting: l.acting,
      log: diarioLogOf({ ...source, rows: publicationRows(source.rows, null) }, l.binding.owner),
      originals: l.originals,
      followed: l.persistOf,
      blocked: l.blocked
    })
    const write = diarioSnapshotWrite({ built: snapshot, shown: publicationCount(source.rows, null), atEnd: source.atEnd })
    // A pending deletion still clears: the stored copy may hold the post.
    if (write === 'keep' && !deletionPending) {
      fillSaveRef.current = true
      const trimmed = storedCopyRows(seedRowsRef.current, dataRef.current, (ref) => l.originals.get(ref))
      if (trimmed === null) return
      const rows = purgedRows(trimmed, l.binding.owner, allowedAuthor)
      const copy = buildScreenSnapshot('diario', {
        ...l.binding,
        acting: l.acting,
        log: diarioLogOf({ rows: publicationRows(rows, null), atEnd: false }, l.binding.owner),
        originals: l.originals,
        followed: l.persistOf,
        blocked: l.blocked
      })
      const save = diarioSnapshotWrite({ built: copy, shown: publicationCount(rows, null), atEnd: false }) === 'save'
      seedRowsRef.current = save ? rows : null
      if (save) saveScreenSnapshot('diario', copy, gen)
      else clearScreenSnapshot('diario')
      return
    }
    writtenDeletionsRef.current = deletions
    seedRowsRef.current = null
    if (write === 'save') saveScreenSnapshot('diario', snapshot, gen)
    else clearScreenSnapshot('diario')
  }, [])
  const armSnapshot = useCallback((gen, retried = false) => {
    if (latestRef.current.binding === null) return
    clearTimeout(snapshotTimer.current)
    snapshotTimer.current = setTimeout(() => writeSnapshot(gen, retried), SNAPSHOT_DEBOUNCE_MS)
  }, [writeSnapshot])
  useEffect(() => () => clearTimeout(snapshotTimer.current), [])
  useEffect(() => {
    if (boot !== null) perfMarks().mark('rows-snapshot:diario')
  }, [])
  // Stored rows of another binding never stay: another owner (sign-out,
  // another diary), and another installation or association with the same
  // key, whose store was already wiped.
  const seedBindingRef = useRef(binding)
  useEffect(() => {
    const cur = dataRef.current
    if (cur !== null && cur.seeded && (!sameSnapshotBinding(seedBindingRef.current, binding) || cur.info.publicKey !== binding.owner)) {
      dataRef.current = null
      setData(null)
      setHeldNew(false)
    }
  }, [binding])
  const followCounts = useFollowCounts(ownPublicKey, String(refresh) + ':' + pulls)
  // Own depoimentos and the ones waiting for approval (hosted only).
  const testimonials = useTestimonials(ownPublicKey, { ownKey: ownPublicKey, withPending: true, withSent: true, sentProbe: true, tick: String(refresh) + ':' + pulls, active: active !== false })
  const moments = useMoments({ ownKey: ownPublicKey, active: active !== false, tick: String(refresh) + ':' + pulls })
  const seenState = useMomentSeen()
  const ring = avatarMoments({ data: moments, author: ownPublicKey, ownKey: ownPublicKey, seen: seenState.seen, now })
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
    onOpenAll: typeof onOpenTestimonials === 'function' && ownPublicKey ? (section) => onOpenTestimonials(ownPublicKey, section) : undefined,
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
  // What anyone sees on this profile, read on the same signals as the
  // communities. Away from the tab the last version stands, so leaving it
  // costs no read; coming back reads again.
  const publicGroupsVersionRef = useRef(null)
  const publicGroupsVersion = useMemo(() => {
    if (active !== false || publicGroupsVersionRef.current === null) publicGroupsVersionRef.current = { refresh, pulls, groupVersions }
    return publicGroupsVersionRef.current
  }, [refresh, pulls, active, groupVersions])
  const publicGroups = usePublicGroups(ownPublicKey, { enabled: node.hosted === true, version: publicGroupsVersion })
  // node.epoch at which log.read refused `posts`: the pages are read without
  // it, technical records included, until the epoch moves. Only the read is
  // repeated.
  const plainLogEpochRef = useRef(null)
  const readLog = useCallback(async (params) => {
    const epoch = identityRef.current.epoch
    if (plainLogEpochRef.current !== epoch) {
      try {
        return await request('log.read', { ...params, posts: true })
      } catch (err) {
        if (!isUnknownParam(err)) throw err
        plainLogEpochRef.current = epoch
      }
    }
    return request('log.read', params)
  }, [request])
  // Older pages read for the first page while it shows no publication.
  const postsPages = useRef(0)
  // Replaces the rows with the newest page (a refresh), except the first
  // read over a seed, which settles the painted rows instead.
  const loadNewest = useCallback(async (refreshProfile = false, replace = false) => {
    const mine = ++seqRef.current
    const deletions = deletionsRef.current
    // Deletions on any screen (noteDeleted): a retried save never writes rows
    // read before one.
    const anyDeletions = ownDeletions()
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
      const readBinding = latestRef.current.binding
      const gen = cacheGeneration()
      const wipe = wipeEpoch()
      const log = await readLog({ limit: LOG_LIMIT_MAX })
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
      postsPages.current = 0
      fillSaveRef.current = false
      const atEnd = isLastLogPage(log)
      const live = { info, rows, atEnd, oldest: oldestSeq(rows) }
      const seeded = !replace && dataRef.current?.seeded === true && liveRef.current === null &&
        dataRef.current.info.publicKey === info.publicKey && sameSnapshotBinding(seedBindingRef.current, latestRef.current.binding)
        ? dataRef.current
        : null
      liveRef.current = { ...live, gen, wipe, deletions, ownDeletions: anyDeletions, binding: readBinding }
      // A read that replaces the rows no longer settles the copy on disk.
      if (seeded === null) seedRowsRef.current = null
      let next = live
      let held = false
      const settled = seeded === null ? null : firstLivePage(seeded, live)
      if (settled !== null) {
        next = settled.next
        held = settled.held
      }
      dataRef.current = next
      setData(next)
      setHeldNew(held)
      loadedAtRef.current = startedAt
      if (!liveMarkedRef.current) {
        liveMarkedRef.current = true
        perfMarks().mark('rows-live:diario')
      }
      const save = firstPageSave({ deletions, deletionsNow: deletionsRef.current, own: anyDeletions, ownNow: ownDeletions(), gen, generation: cacheGeneration() })
      if (save !== null) armSnapshot(save.gen, save.retried)
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
      // A reset drops originals it is not asked for, so kept seeded rows are
      // asked for too. Their seqs in next.stored are still cache text.
      if (typeof info.publicKey === 'string') ingest({ ...rowNeeds(next.rows, info.publicKey, next.stored), reset: true })
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
  }, [request, readLog, ackFresh, resolve, invalidate, ingest, armSnapshot])

  // Appends the next older page; never while one is loading.
  const loadOlder = useCallback(async () => {
    const current = dataRef.current
    if (current === null || current.atEnd || olderBusy.current || newestBusy.current) return
    olderBusy.current = true
    const mine = seqRef.current
    setLoadingMore(true)
    setOlderError('')
    try {
      const before = current.oldest ?? oldestSeq(current.rows)
      const log = await readLog({ limit: LOG_LIMIT_MAX, before })
      // The cursor came from `current`: a newest page that replaced it
      // meanwhile would leave a gap between the two. A deletion also replaces
      // it, so a stale page must not restore the deleted content.
      if (mine !== seqRef.current || dataRef.current !== current) return
      const { page, data: next } = olderPageData(current, log, before)
      dataRef.current = next
      setData(next)
      const live = liveRef.current
      if (fillSaveRef.current && live !== null && fillSettled(diarioSnapshotSource(live, next))) {
        fillSaveRef.current = false
        armSnapshot(live.gen)
      }
      for (const entry of log.entries) {
        const record = entry.record
        if (record && record.type === 'post' && record.replyTo) resolve(record.replyTo.author)
      }
      if (typeof current.info.publicKey === 'string') ingest(rowNeeds(page, current.info.publicKey))
    } catch (err) {
      if (mine !== seqRef.current || dataRef.current !== current) return
      setOlderError(errorText(err))
    } finally {
      if (mine === seqRef.current) {
        setLoadingMore(false)
        olderBusy.current = false
      }
    }
  }, [readLog, resolve, ingest, armSnapshot])

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
    return pull.run(() => loadNewest(true, true))
  }

  // Pages with no publication (only technical records) are paged through by
  // RefreshableList's infinite scroll, which pauses after a few dry pages.
  // Publications: posts (quotes included) and the reposts still on.
  const keptRows = useMemo(() => {
    if (data === null) return []
    const originals = social.social.originals
    return storedRowsKept(data, blocks, (ref) => originals.get(ref))
  }, [data, blocks, social.social.originals])
  const shownRows = useMemo(() => {
    if (data === null) return []
    const live = liveReposts(data.rows, data.held)
    return keptRows.filter((row) => isPostRow(row) || (isRepostRow(row) && live.has(row.seq)))
  }, [data, keptRows])

  const info = data === null ? null : data.info
  const posts = shownRows
  const mural = tab === 'mural'
  const publicKey = info && typeof info.publicKey === 'string' ? info.publicKey : null
  const profile = publicKey ? profileOf(publicKey) : undefined
  // Only the rows log.read already loaded: no extra read for the Mural.
  const muralTiles = useMemo(() => {
    if (!mural || data === null || publicKey === null) return []
    return hideFuture(tilesFromLog(publicKey, keptRows), now)
  }, [mural, data, keptRows, publicKey, now])
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
  // Same bounded fill for Publicações: a first page with no publication (a
  // diary topped by likes or repost-offs on an older node) reads up to `cap`
  // older pages before it offers 'Carregar mais'.
  const postsFill = data === null ? 'end' : publicationsFill({ shown: posts.length, atEnd: data.atEnd, pages: postsPages.current, cap: 4 })
  useEffect(() => {
    if (shownTab !== 'posts') return
    if (data === null || loadingMore || newestLoading || olderError) return
    if (postsFill !== 'more') return
    const current = dataRef.current
    if (current === null || current.atEnd || olderBusy.current || newestBusy.current) return
    postsPages.current += 1
    loadOlder()
  }, [shownTab, data, loadingMore, newestLoading, olderError, postsFill, loadOlder])
  const who = whoOf(profile || undefined)
  const bio = profile && profile.bio ? profile.bio : ''
  const profileUrl = node.hosted === true && publicKey ? buildProfileUrl({ origin: installationOrigin() || globalThis.location?.origin || null, username: profile ? profile.username : null, publicKey }) : null

  // Rich profile (hosted only); the Sorte do dia is local and always shown.
  const rich = useProfileExtra({ author: publicKey || ownPublicKey, enabled: node.hosted === true, request })
  const extraShown = extraView(rich.held, now)
  const topOwner = publicKey || ownPublicKey
  const ownMarks = useOwnMarks({ request, ownKey: topOwner, enabled: node.hosted === true })
  const topRead = useTopFriends({ owner: topOwner, ownKey: topOwner, index: rich.index, request, enabled: node.hosted === true })
  const topRows = ownTopRows(ownMarks.marks.top, topRead.view)
  const fansView = fansCountView({ fans: rich.index ? rich.index.fans : null, complete: rich.index ? rich.index.complete : false })
  const tint = bandTint(extraShown.theme, scheme)

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
  // On a themed band the control discs are the ink color (the pinned bar keeps
  // the sunset band and its scrim).
  const disc = (style, inBar) => (tint !== null && !inBar ? [style, { backgroundColor: tint.disc }] : style)
  const bandControls = (inBar) => (
    <>
      <HelpButton doc={HELP.diario} color={tint !== null && !inBar ? tint.icon : colors.onMedia} style={disc(inBar ? styles.barButton : (hasBell ? styles.infoShifted : styles.info), inBar)} />
      <PressScale
        accessibilityRole='button'
        accessibilityLabel='Ajustes'
        hitSlop={8}
        onPress={() => onSettings('lista')}
        style={disc(inBar ? styles.barButton : (hasBell ? styles.gearShifted : styles.gear), inBar)}
      >
        <Icon name='engrenagem' size={20} color={tint !== null && !inBar ? tint.icon : colors.onMedia} />
      </PressScale>
      {hasBell ? <BellButton color={tint !== null && !inBar ? tint.icon : colors.onMedia} badged={avisosNew === true} onPress={onAvisos} style={disc(inBar ? styles.barButton : styles.bell, inBar)} /> : null}
    </>
  )

  // Only this identity's items for this association.
  const pending = info && node.config ? outbox.itemsFor(info.publicKey, node.config.association) : []
  // Queued items not approved in this page session (stored before it, or
  // changed in storage since they were approved): they wait for 'enviar',
  // which approves them exactly as shown here. An item not open yet (its
  // text still sealed, src/outboxSeal.js) cannot be approved: it shows the
  // placeholder and no action but 'apagar'.
  const held = pending.filter((item) => item.state === 'queued' && item.opened && !outbox.isAllowed(item))
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
  // Several queued items look alike to a screen reader: each action names its item.
  const queuedLabel = (item) => 'a publicação escrita ' + (relativeTime(item.writtenAt, now) ?? displayText(item.writtenAt))
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
            <Text style={styles.pendingText}>{item.opened ? displayText(item.text, { multiline: true }) : SEALED_TEXT}</Text>
            {item.opened && item.kind === 'reply'
              ? <Soft>{'resposta a ' + replyTargetText(item.to)}</Soft>
              : null}
            <Soft>
              {'escrito ' + (relativeTime(item.writtenAt, now) ?? displayText(item.writtenAt)) +
                ' · a data será a do envio'}
            </Soft>
            {item.opened || item.state !== 'queued' ? <PendingState item={item} held={heldIds.includes(item.id)} /> : null}
            {/* An open 'sending' item waits for its reconciliation; one not
                open in this window is never reconciled here, so it can go. */}
            {canDiscard(item)
              ? (
                <View style={styles.pendingActions}>
                  {heldIds.includes(item.id)
                    ? <Pill label='Enviar' accessibilityLabel={'enviar ' + queuedLabel(item)} onPress={() => outbox.release([item])} />
                    : null}
                  {item.opened && !heldIds.includes(item.id) && (item.state === 'uncertain' || item.state === 'failed')
                    ? <Pill label='Tentar de novo' accessibilityLabel={'tentar de novo enviar ' + queuedLabel(item)} onPress={() => outbox.retry(item)} />
                    : null}
                  <Pill icon='lixeira' accessibilityLabel={'apagar ' + queuedLabel(item)} onPress={() => outbox.discard(item.id)} />
                </View>
                )
              : null}
          </View>
        ))}
      </>
      )
    : null

  const showSalvos = node.hosted === true && savedList.available && typeof onOpenSalvos === 'function'
  const showEventos = node.hosted === true && ownPublicKey && typeof onOpenEventos === 'function'
  const showVisitas = node.hosted === true && typeof onOpenVisitas === 'function'
  const showRecados = node.hosted === true && ownPublicKey && typeof onOpenRecados === 'function'
  const showVarandinha = node.hosted === true && ownPublicKey && typeof onOpenVarandinha === 'function'

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
          theme={extraShown.theme}
          mood={extraShown.mood ? <MoodChip mood={extraShown.mood} now={now} theme={extraShown.theme} onPress={node.hosted === true ? () => setEditing(true) : undefined} /> : null}
          link={<AboutLink label={ABOUT_LABEL_OWN} hint={aboutHint(extraShown.about)} onPress={() => setAboutOpen(true)} />}
          moments={node.hosted === true && typeof onOpenMomentos === 'function' && ring !== null
            ? { unseen: seenState.loaded && ring.unseen, label: 'seus momentos', onPress: () => onOpenMomentos(ownPublicKey) }
            : null}
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
          }, node.hosted === true
            ? {
                label: fansView.count === 1 ? 'fã' : 'fãs',
                value: fansView.count === null ? null : displayText(formatCount(fansView.count)),
                onPress: typeof onOpenPeople === 'function' ? () => onOpenPeople(ownPublicKey, 'fas') : undefined
              }
            : null]}
          note={(followCounts.incomplete && followCounts.seguidores !== null) || (node.hosted === true && fansView.count !== null && fansView.incomplete) ? <View style={styles.countsNote}><Soft>{COUNTS_INCOMPLETE_NOTE}</Soft></View> : null}
          corner={<Pill key='edit' label='Editar perfil' onPress={() => setEditing(true)} maxFontSizeMultiplier={TEXT_CAP} />}
          cornerActions={[
            profileUrl !== null ? <Pill key='share' icon='compartilhar' accessibilityLabel='compartilhar perfil' onPress={() => { shareProfileDirect(profileUrl).then((done) => { if (!done) setSharing(true) }) }} /> : null,
            profileUrl !== null ? <Pill key='qr' label='Meu QR' accessibilityLabel='mostrar meu QR' onPress={() => setShowingQr(true)} maxFontSizeMultiplier={TEXT_CAP} /> : null
          ]}
          rows={
            <ProfileShortcuts
              items={shortcutList(OWN_SHORTCUTS, { salvos: showSalvos, eventos: showEventos, visitas: showVisitas, recados: showRecados, varandinha: showVarandinha })}
              onOpen={(id) => {
                if (id === 'salvos') onOpenSalvos()
                if (id === 'eventos') onOpenEventos(ownPublicKey)
                if (id === 'visitas') onOpenVisitas()
                if (id === 'recados') onOpenRecados(ownPublicKey)
                if (id === 'varandinha') onOpenVarandinha(ownPublicKey)
              }}
            />
          }
          onTabsLayout={(l) => setTabsBottom(l.y + l.height)}
          tabs={
            <View>
              {node.hosted === true ? <ReminderBanner now={now} onOpenThread={onOpenThread} /> : null}
              <CommunitiesBox items={communities} title='Suas comunidades' onOpen={typeof onOpenCommunity === 'function' ? onOpenCommunity : undefined} />
              {publicGroups.hidden || typeof onOpenGroup !== 'function'
                ? null
                : <PublicGroupsBox items={publicGroups.rows} title='Seus grupos públicos' note='Qualquer pessoa vê isto no seu perfil.' onOpen={onOpenGroup} />}
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
  const skeleton = <View>{[0, 1, 2].map((row) => <SkeletonRow key={row} />)}</View>
  let empty
  if (data === null) {
    empty = loadError
      ? <ErrorState message={loadError} onRetry={reload} pending={pull.pending} />
      : skeleton
  } else {
    // Older pages remain and none shown so far held a publication: never a
    // blank list nor the empty state.
    empty = !data.atEnd
      ? olderError
        ? <ErrorState message={olderError} onRetry={loadOlder} pending={loadingMore} />
        : loadingMore || newestLoading || postsFill === 'more'
          ? skeleton
          : <View style={styles.loadMore}><Pill label='Carregar mais' onPress={loadOlder} /></View>
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

  const [editTarget, setEditTarget] = useState(null)
  const onEdited = async ({ ref, text }) => {
    setEditTarget(null)
    const patch = (cur) => {
      if (cur === null) return cur
      return {
        ...cur,
        rows: cur.rows.map((row) => cur.info.publicKey + ':' + row.seq === ref && row.entry?.record?.type === 'post'
          ? { ...row, entry: { ...row.entry, record: editedRecord(row.entry.record, text), edited: true } }
          : row)
      }
    }
    dataRef.current = patch(dataRef.current)
    setData(dataRef.current)
    liveRef.current = patch(liveRef.current)
    await loadNewest(false)
  }
  const editOffered = info?.postEdit === true

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
        dataRef.current = { ...cur, rows }
        setData(dataRef.current)
      }
      // The own post's seq, also when its row is not loaded (t.seq is the
      // tombstone's, never a deleted row). An own repost of it is not.
      const deletedSeq = cur !== null ? ownDeletedSeq(t.ref, cur.info.publicKey) : null
      if (deletedSeq !== null) deletedSeqsRef.current.add(deletedSeq)
      const live = liveRef.current
      if (live !== null) liveRef.current = { ...live, rows: deletePostRows(live.rows, t.ref, live.info.publicKey) }
      deletionsRef.current++
      armSnapshot(cacheGeneration())
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
  const handlers = { onOpenThread, onOpenMember, onOpenMention, onOpenEngagers, onOpenQuotes, onReply, onQuote, onMessage, onDelete: del.offered ? del.ask : undefined, onEdit: editOffered ? setEditTarget : undefined }
  // An own repost is the ORIGINAL post under 'Você republicou' (every action
  // targets the original); an own post (or quote) targets itself.
  const rowCache = useRowPropsCache(posts, rowKeyOf, { h: handlers, social })
  // One renderItem for the list's life: it reads the newest render through the ref.
  const renderRef = useRef(null)
  const renderItem = useCallback((info) => renderRef.current(info), [])
  renderRef.current = ({ item: row }) => {
    const rowKey = rowKeyOf(row)
    const record = row.entry.record
    if (record.type === 'repost') {
      const ref = refOf(record.to)
      const repostedBy = { author: info.publicKey, name: 'Você', username: null }
      const post = social.original(ref)
      if (!post) return <RepostPlaceholder repostedBy={repostedBy} missing={post === null} transient={social.transient(ref)} onRetry={() => social.retry(ref)} />
      return <PostRow {...socialRowProps({ post, ref, repostedBy, social, profileOf, now, ownKey: info.publicKey, h: handlers, cache: rowCache, rowKey })} />
    }
    const post = ownPostOf(info.publicKey, row.seq, record, row.entry.edited)
    return <PostRow {...socialRowProps({ post, ref: info.publicKey + ':' + row.seq, social, profileOf, now, ownKey: info.publicKey, h: handlers, cache: rowCache, rowKey })} />
  }

  const muralCols = fontScale >= LARGE_TEXT ? 2 : 3
  const muralRows = useMemo(() => muralGridRows(muralTiles, muralCols), [muralTiles, muralCols])
  // The post a tile came from, seeded as a Publicações row seeds it, so the
  // thread shows it even when the network cannot be read.
  const muralSeed = (tile) => {
    const row = data === null ? null : data.rows.find((r) => r.seq === tile.seq && r.entry && r.entry.record)
    return row ? postOf(tile.author, tile.seq, row.entry.record, row.entry.edited) : null
  }
  const renderMural = ({ item }) => (
    <MuralRow item={item} columns={muralCols} persist onOpen={(tile) => onOpenThread({ ref: tile.ref, seed: muralSeed(tile) })} />
  )

  // Rows re-render when a name is learned, the clock ticks or the originals,
  // counts or own state change.
  const extra = useMemo(() => ({ profileOf, now, profile, social: social.social, offered: del.offered, editOffered }), [profileOf, now, profile, social.social, del.offered, editOffered])

  return (
    <View style={styles.list}>
      <DeletePrompt del={del} />
      {editTarget !== null ? <EditPostSheet key={editTarget.ref} target={editTarget} request={request} onClose={() => setEditTarget(null)} onEdited={onEdited} onUncertain={() => loadNewest(false)} /> : null}
      <RefreshableList
        perfId='diario'
        data={depo ? testimonialTab.items : mural ? muralRows : posts}
        keyExtractor={depo ? testimonialTab.keyExtractor : mural ? muralKeyOf : rowKeyOf}
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
        // With no publication shown, the bounded fill and 'Carregar mais' are
        // the only readers: the list's own paging would add its dry pages.
        onLoadMore={posts.length === 0 || mural || depo ? undefined : loadOlder}
        loadingMore={loadingMore}
        loadMoreError={!!olderError}
        atEnd={data === null || mural || depo ? true : data.atEnd}
        scrollToTopSignal={scrollToTop}
        onScrollFrame={bar.handleScrollFrame}
        onDragState={bar.handleDragState}
        listRef={listRef}
        newItemsTop={info !== null && bar.interactive ? insets.top + BAR + (bar.pinned && segmentedHeight !== null ? segmentedHeight : 0) + 8 : undefined}
        newItems={{
          label: 'ver novidades',
          visible: ownGrew || heldNew,
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
        onExtraSaved={(kind, seq) => rich.apply(kind, seq)}
        onExtraDeleted={(kind) => rich.drop(kind)}
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
          <Sheet open={sharing} onClose={() => setSharing(false)} title='Compartilhar perfil' closeLabel='Fechar'>
            <View style={styles.shareBody}>
              <ShareProfile url={profileUrl} onNotice={typeof onToast === 'function' ? (m) => { setSharing(false); onToast(m) } : undefined} />
            </View>
          </Sheet>
          )
        : null}
      {profileUrl !== null
        ? (
          <Sheet open={showingQr} onClose={() => setShowingQr(false)} title='Meu QR' closeLabel='Fechar'>
            <View style={styles.shareBody}>
              <ProfileQr url={profileUrl} label={profile && profile.username ? '@' + profile.username : 'meu perfil'} />
              <HelpNote doc={HELP.meuQr}><Soft>{QR_HINT}</Soft></HelpNote>
              <ShareProfile url={profileUrl} onNotice={typeof onToast === 'function' ? (m) => { setShowingQr(false); onToast(m) } : undefined} />
            </View>
          </Sheet>
          )
        : null}
      {testimonialTab.sheets}
      <AboutSheet open={aboutOpen} onClose={() => setAboutOpen(false)} title={ABOUT_LABEL_OWN}>
        <View style={styles.aboutSection}>
          {extraShown.about !== null
            ? <AboutCard about={extraShown.about} theme={extraShown.theme} />
            : rich.status === 'ready'
              ? (
                <>
                  <Soft>Você ainda não escreveu o Sobre mim.</Soft>
                  {node.hosted === true ? <Pill label='Editar perfil' onPress={() => { setAboutOpen(false); setEditing(true) }} /> : null}
                </>
                )
              : rich.status === 'failed' || rich.status === 'unsure'
                ? <Soft>{rich.status === 'failed' ? 'Não deu para ler o seu perfil agora.' : 'Não deu para ler o seu diário inteiro agora.'}</Soft>
                : null}
        </View>
        {node.hosted === true && typeof onOpenTop === 'function'
          ? (
            <View style={styles.aboutSection}>
              <TopFriendsRow rows={topRows} mine onEdit={() => { setAboutOpen(false); onOpenTop() }} onOpen={typeof onOpenMember === 'function' ? (...args) => { setAboutOpen(false); onOpenMember(...args) } : undefined} loading={ownMarks.marks.status === 'loading'} notice={ownMarks.marks.status === 'unsure' && !ownMarks.marks.top ? NOTICES.unreadable : null} />
            </View>
            )
          : null}
        <View style={styles.aboutSection}>
          <SorteCard ownerKey={topOwner} />
        </View>
      </AboutSheet>
      <SocialToast text={social.toast} />
    </View>
  )
}

const bandButton = (colors) => ({
  position: 'absolute',
  bottom: 12,
  width: layout.hit,
  height: layout.hit,
  borderRadius: radius.pill,
  backgroundColor: colors.dim,
  alignItems: 'center',
  justifyContent: 'center'
})

const makeStyles = (colors) => StyleSheet.create({
  list: { flex: 1, backgroundColor: colors.bg },
  plainBand: { backgroundColor: colors.bg },
  barButton: { width: layout.hit, height: layout.hit, borderRadius: radius.pill, backgroundColor: colors.dim, alignItems: 'center', justifyContent: 'center' },
  // The band buttons, right to left: bell (when there is one), gear, help.
  bell: { ...bandButton(colors), right: space.xl },
  gear: { ...bandButton(colors), right: space.xl },
  gearShifted: { ...bandButton(colors), right: space.xl + 52 },
  countsNote: { marginTop: space.xs },
  aboutSection: { paddingHorizontal: space.xl, gap: space.md },
  info: { ...bandButton(colors), right: space.xl + 52 },
  infoShifted: { ...bandButton(colors), right: space.xl + 104 },
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
  pendingAll: { flexDirection: 'row', paddingHorizontal: 16, paddingBottom: 8 },
  loadMore: { alignItems: 'center', paddingVertical: space.lg }
})
