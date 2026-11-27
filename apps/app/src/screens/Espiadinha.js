// Espiadinha: up to three publications (posts, replies, quotes, reposts) of
// each diary the person does not follow, one round at a time, newest first.
// No algorithm. Hosted nodes only (the hosted web app and the native app on an
// installation): on varanda-serve or a manual configuration the tab explains
// that and never calls peek.read. The last visible first page is kept on the
// device ('espiadinha' snapshot, ../peekSnapshot.js: 30 rows, no cursor,
// bound to origin, association and owner, never for a page actor or the
// Vitrine), with the originals its rows draw as this run read them, and its
// photos in the bounded peek kinds of the kept store (persist 'peek'), so a
// reopen paints those rows, a repost's post and a reply's parent at once.
// Stored rows of others stay hidden until block.list has answered, offer no
// action and set no mark until a live page confirms them; a live page that
// brings new rows waits behind 'ver novidades' and replaces the list whole.
// Names come from the item (PostRow) or from a verified post the node read;
// only an own or followed author (a reply's parent, a quoted post) reads the
// names cache, as in A Rua, never a stranger. As in A Rua (its useSocial), a
// row opens its conversation and its author's profile, shows the counts and
// offers curtir, republicar and citar; a reply names its parent, a quote
// shows the quoted post and a repost the original, each read and verified by
// the node.
// Word search in posts is the Busca tab's (screens/Busca.js).

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { StyleSheet, View } from 'react-native'
import { FOLLOW_LIMIT_MAX, PEEK_LIMIT_DEFAULT, PEEK_LIMIT_MAX, displayText } from '@varanda/rpc'
import { perfMarks, useNode } from '../node'
import { useNames } from '../names'
import { shouldReloadOnShow } from '../paging'
import { HELP } from '../help'
import { NOT_HOSTED } from '../pessoas'
import {
  PEEK_OFFLINE_MESSAGE, PEEK_SHORT_TEXT, PEEK_WARM_QUIET_MS,
  appendPeekPage, getPeekWarmState, holdLivePage, isExpiredPeekError, isLastPeekPage, isSeederBusyError, isWebOnlyError, pageNeeds, peekKey, peekNotice,
  peekKeptEntries, peekOriginalsOf, peekRetainEntries, peekRowAuthors, readLaterPages, recordFollow, shouldWarmPeek, takePeekPage, takesHeldPage, skippedText, subscribePeekWarm, updatePeekWarmState, withoutFollowed
} from '../peek'
import { whoOf } from '../who'
import { useBlocks } from '../blocksProvider'
import { useMutes } from '../mutesProvider'
import { cachedRowsShown, withoutBlockedRows } from '../cachedRows'
import { allowedAuthor, cacheGeneration, peekKeepAllowed, wipeEpoch } from '../localCaches'
import { peekSeedOf } from '../peekSnapshot'
import { buildScreenSnapshot } from '../screenSnapshot'
import { loadScreenSnapshot, saveScreenSnapshot } from '../screenSnapshotStore'
import * as keptStore from '../media/keep'
import { retainKept } from '../media/keptLoad'
import { pageMode } from '../groups'
import { pagesOn } from '../pageGate'
import { useActing } from './Conversa'
import { bindingKeyOf, memberSnapshotBinding, sameSnapshotBinding } from './Comunidades'
import { CountsNote, RepostPlaceholder, ownDeletions, refOf, socialRowProps, useRowPropsCache, useSocial } from './ARua'
import { Soft, errorText, useBottomPad, useVisibleNow } from '../ui'
import { PostRow } from '../ui/PostRow'
import { PostSheetProvider } from '../ui/PostSheetHost'
import { HelpNote, HelpSheet } from '../ui/Help'
import { RefreshableList } from '../ui/RefreshableList'
import { EmptyState, ErrorState, ListFooter, SkeletonRow } from '../ui/States'
import { Pill } from '../ui/Pill'

// follow.list returns at most FOLLOW_LIMIT_MAX keys. An account follows at
// most 4095 diaries, so nine pages is the whole list and a hard stop.
const FOLLOW_PAGES_MAX = 9

// The live first page is stored this long after it committed, so a quick
// refresh or follow writes once.
const SAVE_DELAY_MS = 2000
const SAVE_ROWS_MAX = 30
const PEEK_KINDS = ['peekAvatars', 'peekPosts']

const noop = () => {}

// The own keys (lowercase): an own post read before an own deletion is not
// stored as an original, and own photos are never kept as peek ones.
function ownKeysOf (...keys) {
  return new Set(keys.filter((k) => typeof k === 'string').map((k) => k.toLowerCase()))
}

// Every author a stored row draws: those it names (peekRowAuthors) and those
// its stored originals name, both levels. useSocial draws a seeded original
// with no block check until the first live ingest turns it into a checked
// stale copy, so the gate has to cover what those originals show.
export function storedRowAuthors (originals) {
  const at = (ref) => (originals instanceof Map && originals.has(ref) ? originals.get(ref) : null)
  return (item) => {
    const out = peekRowAuthors(item)
    for (const o of Object.values(peekOriginalsOf([item], at))) out.push(...peekRowAuthors(o))
    return out
  }
}

// What a save may store for a ref: this run's own read (useSocial's raw map,
// never the seeded copy nor a stale one), a post object (no pending, failed
// or unavailable read), by an author not blocked and not in `own` (lowercase
// keys, given after an own deletion since the page's read: the raw map may
// still hold the deleted post, and the purge of the stored copy already
// ran). `ok(author)`, when given, must also pass. -> the post or null.
export function liveOriginalAt (originals, seeded, blocked, own = null, ok = null) {
  return (ref) => {
    const o = originals instanceof Map ? originals.get(ref) : undefined
    if (o === null || typeof o !== 'object' || o.kind !== 'post' || typeof o.author !== 'string') return null
    if (seeded instanceof Map && seeded.get(ref) === o) return null
    const a = o.author.toLowerCase()
    if (own instanceof Set && own.has(a)) return null
    if (typeof ok === 'function' && ok(a) !== true) return null
    return blocked && typeof blocked.has === 'function' && blocked.has(a) ? null : o
  }
}

// useSocial's original() for the rows on screen: a seeded copy (or the
// stale copy a reset ingest makes of it, the same object) was stored before
// this run's block list, maybe for another identity, and useSocial draws it
// unchecked. It shows only once block.list answered for this run
// (`blocksOk`), while the seed's binding is the current one (`sameSeed`) and
// when neither the ref's author nor the original's is blocked; until then
// it is not there (undefined), as a read still pending.
export function seedGuard (original, seeded, { blocksOk, sameSeed, blocked }) {
  if (!(seeded instanceof Map) || seeded.size === 0) return original
  return (ref) => {
    const o = original(ref)
    if (o === null || typeof o !== 'object' || seeded.get(ref) !== o) return o
    if (blocksOk !== true || sameSeed !== true || typeof ref !== 'string' || typeof o.author !== 'string') return undefined
    const named = ref.slice(0, ref.indexOf(':')).toLowerCase()
    const has = (a) => !!blocked && typeof blocked.has === 'function' && blocked.has(a)
    return has(named) || has(o.author.toLowerCase()) ? undefined : o
  }
}

// The save a shown page arms (`armed` of flushSave): at its request's
// generation, or, when a purge moved it while the read ran, at the current
// one as a re-armed save (`retried`), so saveStep still drops it after a
// wipe, another identity or an own deletion since the read (`refresh`), and
// rowsToWrite applies its re-armed rule. `deletions`: ownDeletions() when
// the page was asked for.
export function armedSave ({ gen, generation, wipe, refresh, deletions, binding, rows, meta }) {
  return { gen: generation, wipe, refresh, deletions, binding, rows, meta, timer: null, due: false, retried: gen !== generation }
}

// The rows a save may write under the purges so far: the poster may be kept
// as a stranger (mayKeep: blocks and the allowed set known, not own,
// followed or denied) and no other author it names is denied (notDenied).
// A follow this list has not reconciled yet (it waits until shown) is caught
// here, since the purge already applied it.
export function purgedRows (rows, { mayKeep, notDenied }) {
  return rows.filter((row) => {
    const [poster, ...named] = peekRowAuthors(row)
    return typeof poster === 'string' && mayKeep(poster) === true && named.every((a) => typeof a === 'string' && notDenied(a) === true)
  })
}

// The rows a due save writes, or null to drop it. With the allowed set
// known, every save is purged as above, and one left with no row of the rows
// it had is dropped (the purge already cleaned the stored copy). Without
// it, no follow purge ran yet (only A Rua sets it), so a save writes as it
// is, past the block and follow filters at its flush; a re-armed one, read
// before a purge, is dropped.
export function rowsToWrite (rows, { armed, allowedKnown, mayKeep, notDenied }) {
  if (!allowedKnown) return armed.retried === true ? null : rows
  const kept = purgedRows(rows, { mayKeep, notDenied })
  return rows.length > 0 && kept.length === 0 ? null : kept
}

// What a due save does: 'write'; 'rearm' after a purge since its request
// (another generation), once, so it is built again after the purge under
// the blocks and follows then; 'drop' after a wipe, under another identity,
// after a second purge, or when a re-arm meets a refresh signal that moved
// since the read (App bumps it with every own deletion, whose count A Rua
// keeps to itself). The next live page saves.
export function saveStep ({ armed, gen, wipe, sameBinding, refresh }) {
  if (armed.wipe !== wipe || sameBinding !== true) return 'drop'
  if ((armed.gen !== gen || armed.retried === true) && armed.refresh !== refresh) return 'drop'
  if (armed.gen === gen) return 'write'
  return armed.retried === true ? 'drop' : 'rearm'
}

// Whether the saved page's originals (`saved`, ref -> post) moved since its
// save: a new or replaced post (an enrichment is a new object), or a saved
// one the node now answers as gone (null). A ref being read again (undefined
// or a transient marker) has not moved.
export function originalsMoved (saved, now, originals) {
  for (const ref of Object.keys(now)) if (saved[ref] !== now[ref]) return true
  for (const ref of Object.keys(saved)) if (originals instanceof Map && originals.get(ref) === null) return true
  return false
}

// One actions sheet for the whole list instead of two per row.
export default function Espiadinha (props) {
  return <PostSheetProvider><EspiadinhaList {...props} /></PostSheetProvider>
}

function EspiadinhaList ({ active, refresh, onReply, onReport, onQuote, onOpenThread, onOpenMember, onOpenMention, onOpenEngagers, onOpenQuotes, ownKey, scrollToTop, followsSignal, onFollowsChanged, onPublish, onToast }) {
  const node = useNode()
  const names = useNames()
  const hosted = node.hosted === true && node.passkey !== null
  // The stored page's binding: null for a page actor, a locked or signed-out
  // session and the Vitrine, which neither read nor write it.
  const acting = useActing()
  const pageKey = pageMode({ acting, on: pagesOn({ hosted: node.hosted === true, accountOrigin: node.accountOrigin }) }).key
  const binding = memberSnapshotBinding({ node, acting, pageKey })
  // The stored page, read once and before useSocial, whose seed draws the
  // stored rows' originals (a repost's post, a reply's parent) at once.
  const [boot] = useState(() => {
    const snapshot = binding !== null && hosted ? loadScreenSnapshot('espiadinha', binding) : null
    return snapshot === null || snapshot.body.rows.length === 0 ? null : { snapshot, binding, seed: peekSeedOf(snapshot.body) }
  })
  const seedOriginals = boot !== null && boot.seed !== null ? boot.seed.originals : null
  const rawSocial = useSocial({ ownKey, onToast, seed: boot !== null ? boot.seed : null })
  const { ingest } = rawSocial
  // The names cache only for own or followed authors; a stranger's parent
  // waits for its post instead (undefined, never a cached guess).
  const profileOf = (a) => rawSocial.persistOf(a) ? names.profileOf(a) : undefined
  const now = useVisibleNow(60000)
  const bottomPad = useBottomPad()
  const [helpOpen, setHelpOpen] = useState(false)
  const blocks = useBlocks()
  const mutes = useMutes()
  const blocksRef = useRef(blocks)
  blocksRef.current = blocks
  // What the rows draw: the seeded originals only under this run's blocks.
  const social = { ...rawSocial, original: seedGuard(rawSocial.original, seedOriginals, { blocksOk: blocks.loadState === 'ok', sameSeed: boot !== null && sameSnapshotBinding(boot.binding, binding), blocked: blocks.keys }) }
  // Read at flush: this run's originals (raw), and the drawn ones.
  const socialRef = useRef(social)
  socialRef.current = social
  const ownKeyRef = useRef(ownKey)
  ownKeyRef.current = ownKey
  const bindingRef = useRef(binding)
  bindingRef.current = binding
  const bindingKey = bindingKeyOf(binding)
  // The peek photos to keep at mount once a binding exists: those of the
  // stored rows, or none when nothing was stored (null: no binding).
  const retainRef = useRef(null)
  const seedBindingRef = useRef(null)
  const [state, setState] = useState(() => {
    const base = {
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
      following: new Set(),
      // Rows painted from the stored page, before any live read answered.
      seeded: false,
      // Keys of stored rows no live page has confirmed yet (null: none).
      // They pass the block gate at render and offer no action.
      unconfirmed: null,
      // A live first page is held behind 'ver novidades'.
      pill: false,
      // Keys of the first page's rows (stored or live): only their own
      // photos go to the peek kinds, since only they can be stored.
      firstKeys: null
    }
    if (binding === null) return base
    if (boot === null) {
      retainRef.current = []
      return base
    }
    seedBindingRef.current = binding
    const rows = boot.snapshot.body.rows
    const own = ownKeysOf(binding.owner, ownKey)
    retainRef.current = peekKeptEntries(rows, boot.snapshot.body.originals || null).filter((e) => !own.has(e.author))
    return { ...base, items: rows, meta: boot.snapshot.body.meta, seeded: true, unconfirmed: new Set(rows.map(peekKey)), firstKeys: new Set(rows.map(peekKey)) }
  })
  const { items: allItems, atEnd, loading, loadingMore, refreshing, loadError, moreError, expired, loadedAt, meta, unsupported, following, seeded, unconfirmed, pill, firstKeys } = state
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
  const { request, promote } = node

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

  // The live first page held behind 'ver novidades' while stored rows are on
  // screen: { rows, next, atEnd, meta }.
  const liveHeldRef = useRef(null)
  // The last live first page shown, for a re-save after a follow or a
  // change of its originals: { rows, meta, binding, wipe, deletions }.
  const lastLiveRef = useRef(null)
  // The armed save: { gen, wipe, refresh, deletions, binding, rows, meta,
  // timer, due, retried } (armedSave).
  // `due` once the debounce elapsed while block.list had not answered yet;
  // `retried` once a purge made it arm again.
  const saveRef = useRef(null)
  // What the last flush stored: { rows, originals }, for the re-save below.
  const savedRef = useRef(null)
  const cancelSave = useCallback(() => {
    const armed = saveRef.current
    saveRef.current = null
    if (armed !== null && armed.timer !== null) clearTimeout(armed.timer)
  }, [])
  // Writes the armed page once block.list answered (saveStep decides).
  const flushSave = useCallback(() => {
    const armed = saveRef.current
    if (armed === null) return
    const b = blocksRef.current
    if (b.loadState !== 'ok') {
      armed.due = true
      return
    }
    saveRef.current = null
    const step = saveStep({ armed, gen: cacheGeneration(), wipe: wipeEpoch(), sameBinding: sameSnapshotBinding(armed.binding, bindingRef.current), refresh: refreshRef.current })
    if (step === 'rearm') armTimer({ ...armed, gen: cacheGeneration(), timer: null, due: false, retried: true })
    if (step !== 'write') return
    const notDenied = (a) => peekKeepAllowed(a) || allowedAuthor(a)
    const rows = rowsToWrite(withoutFollowed(withoutBlockedRows(armed.rows, b.keys, peekRowAuthors), followedHereRef.current).slice(0, SAVE_ROWS_MAX), { armed, allowedKnown: !allowedAuthor(null), mayKeep: peekKeepAllowed, notDenied })
    if (rows === null) return
    const own = ownKeysOf(armed.binding.owner, ownKeyRef.current)
    // Only what this run read: a seeded or stale copy may be gone or edited
    // since, and the save would carry it on.
    const originals = peekOriginalsOf(rows, liveOriginalAt(socialRef.current.social.originals, seedOriginals, b.keys, ownDeletions() === armed.deletions ? null : own, notDenied))
    savedRef.current = { rows, originals }
    const snapshot = buildScreenSnapshot('espiadinha', { ...armed.binding, rows, originals, meta: armed.meta, blocked: b.keys, followed: [...followedHereRef.current.keys()] })
    if (snapshot === null || !saveScreenSnapshot('espiadinha', snapshot, armed.gen)) return
    const cur = stateRef.current
    // The drawn rows keep the originals on screen, seeded or stale ones
    // included: a retain never deletes a photo being shown.
    const drawnOf = (ref) => {
      const o = socialRef.current.original(ref)
      if (!o || typeof o !== 'object' || typeof o.author !== 'string') return null
      const a = o.author.toLowerCase()
      return own.has(a) || (b.keys && b.keys.has(a)) ? null : o
    }
    retainKept(PEEK_KINDS, peekRetainEntries({ saved: snapshot.body.rows, savedOriginals: snapshot.body.originals || null, drawn: withoutBlockedRows(cur.items, b.keys, peekRowAuthors), firstKeys: cur.firstKeys, originalOf: drawnOf }).filter((e) => !own.has(e.author)))
  }, [])
  const armTimer = useCallback((armed) => {
    armed.timer = setTimeout(() => {
      armed.timer = null
      if (saveRef.current === armed) flushSave()
    }, SAVE_DELAY_MS)
    saveRef.current = armed
  }, [flushSave])
  const armSave = useCallback((gen, b, rows, meta, wipe, refresh, deletions) => {
    if (b === null) return
    cancelSave()
    armTimer(armedSave({ gen, generation: cacheGeneration(), wipe, refresh, deletions, binding: b, rows, meta }))
  }, [cancelSave, armTimer])
  // A follow made here or elsewhere: the stored copy loses that author too,
  // under the same rule (generation and identity read now). A page read
  // before a wipe is never stored again.
  const resave = useCallback(() => {
    const last = lastLiveRef.current
    if (last !== null && last.wipe === wipeEpoch() && sameSnapshotBinding(last.binding, bindingRef.current)) armSave(cacheGeneration(), last.binding, last.rows, last.meta, last.wipe, refreshRef.current, last.deletions)
  }, [armSave])
  // A first page goes on screen: with the generation, the wipe count and the
  // binding its request was sent with (`stamp`), it is the page to store.
  const liveMarkedRef = useRef(false)
  const noteShown = useCallback((stamp, rows, meta) => {
    if (!liveMarkedRef.current) {
      liveMarkedRef.current = true
      perfMarks().mark('rows-live:espiadinha')
    }
    if (stamp === null || stamp.binding === null) return
    lastLiveRef.current = { rows, meta, binding: stamp.binding, wipe: stamp.wipe, deletions: stamp.deletions }
    armSave(stamp.gen, stamp.binding, rows, meta, stamp.wipe, stamp.refresh, stamp.deletions)
  }, [armSave])
  // The saved page's originals answered or changed after its save (it is
  // stored 2 s after it is shown, often before diary.peek answers): stored
  // again. Never over an armed save, which re-reads them at its flush.
  const liveOriginals = social.social.originals
  useEffect(() => {
    const saved = savedRef.current
    if (saved === null || saveRef.current !== null || lastLiveRef.current === null) return
    const notDenied = (a) => peekKeepAllowed(a) || allowedAuthor(a)
    const last = lastLiveRef.current
    const now = peekOriginalsOf(saved.rows, liveOriginalAt(liveOriginals, seedOriginals, blocksRef.current.keys, ownDeletions() === last.deletions ? null : ownKeysOf(last.binding.owner, ownKeyRef.current), notDenied))
    if (originalsMoved(saved.originals, now, liveOriginals)) resave()
  }, [liveOriginals, seedOriginals, resave])
  const blockLoad = blocks.loadState
  useEffect(() => {
    if (blockLoad === 'ok' && saveRef.current !== null && saveRef.current.due) flushSave()
  }, [blockLoad, flushSave])

  // The web photo store follows this identity (natively a no-op). Stored rows
  // read for another identity never stay, and neither does a save armed for
  // it.
  useEffect(() => {
    const b = bindingRef.current
    keptStore.bindPeek(b === null ? null : { origin: b.origin, association: b.association, owner: b.owner })
    if (retainRef.current !== null && b !== null) {
      const entries = retainRef.current
      retainRef.current = null
      retainKept(PEEK_KINDS, entries)
    }
    if (saveRef.current !== null && !sameSnapshotBinding(saveRef.current.binding, b)) cancelSave()
    if (lastLiveRef.current !== null && !sameSnapshotBinding(lastLiveRef.current.binding, b)) lastLiveRef.current = null
    const cur = stateRef.current
    if (cur.unconfirmed !== null && !sameSnapshotBinding(seedBindingRef.current, b)) {
      liveHeldRef.current = null
      seedBindingRef.current = null
      const drop = cur.unconfirmed
      commit({ items: cur.items.filter((item) => !drop.has(peekKey(item))), seeded: false, unconfirmed: null, pill: false, firstKeys: null })
    }
  }, [bindingKey, commit, cancelSave])
  useEffect(() => cancelSave, [cancelSave])

  // A first page replaces the list. -> its needs.
  const replaceLive = useCallback((rows, next, atEnd, meta, at) => {
    liveHeldRef.current = null
    const taken = takePeekPage(rows)
    commit({ ...taken, next, atEnd, expired: false, loadedAt: at, meta, pill: false, seeded: false, firstKeys: new Set(taken.items.map(peekKey)) })
    return pageNeeds(rows)
  }, [commit])
  // A live first page over stored rows (holdLivePage): held behind the pill
  // once block.list answered, else it replaces them. -> the needs to ingest.
  const holdLive = useCallback((rows, next, atEnd, meta, at) => {
    const cur = stateRef.current
    const b = blocksRef.current
    const hold = holdLivePage({ items: cur.items, unconfirmed: cur.unconfirmed, rows, blocksOk: b.loadState === 'ok' })
    if (hold === null) return replaceLive(rows, next, atEnd, meta, at)
    const kept = unfollowed(hold.items)
    liveHeldRef.current = { rows, next, atEnd, meta }
    commit({
      items: kept,
      unconfirmed: hold.unconfirmed,
      pill: hold.fresh,
      seeded: false,
      next: null,
      atEnd: false,
      expired: false,
      loadedAt: at,
      meta,
      firstKeys: new Set(kept.map(peekKey))
    })
    return pageNeeds(withoutBlockedRows(kept, b.keys, peekRowAuthors), hold.unconfirmed)
  }, [commit, unfollowed, replaceLive])
  // Run right after the reset ingest of a held page: that live page is the
  // one saved, so its originals are read too and the save can store them.
  // Its rows are this run's live ones, never stored rows.
  const ingestHeld = useCallback(() => {
    const held = liveHeldRef.current
    if (held !== null) ingest(pageNeeds(withoutBlockedRows(unfollowed(held.rows), blocksRef.current.keys, peekRowAuthors)))
  }, [ingest, unfollowed])

  // The node serves one peek at a time ('espiadinha já em andamento'): a
  // refresh, a follow or a reselect while a page is loading waits for the
  // read in flight instead of being refused (the superseded result is then
  // dropped by seqRef). Only the hidden warm read passes a lane. A tap, a
  // pull and a later page pass none, so they stay visible and are never
  // placed in the background lane behind that warm read.
  const inflightRef = useRef(null)
  // `stamp` (a visible first page only) gets the cache generation and the
  // binding in the tick that sends the request: a purge or an identity change
  // while it runs means its answer is not stored.
  const peek = useCallback(async (params, options, stamp) => {
    while (inflightRef.current !== null) await inflightRef.current
    if (stamp) {
      stamp.gen = cacheGeneration()
      stamp.wipe = wipeEpoch()
      stamp.refresh = refreshRef.current
      stamp.deletions = ownDeletions()
      stamp.binding = bindingRef.current
    }
    const p = request('peek.read', { ...params, thumbs: true, alt: true }, options)
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
    resave()
  }, [request, commit, unfollowed, markFollowed, resave])

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
    // Filled when the request is sent. A hidden warm page keeps it until it
    // is first shown: it is never stored by itself.
    const stamp = { gen: null, wipe: null, refresh: null, deletions: null, binding: null }
    try {
      // Hidden warm read only: background, with the token the show transition
      // promotes. A tap or a pull leaves options empty and stays visible.
      const page = await peek({ limit: PEEK_LIMIT_DEFAULT }, quiet ? { priority: 'background', token: opts.token } : undefined, stamp)
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
          at: Date.now(),
          stamp
        }
        commit({ loading: false, refreshing: false })
        return
      }
      const pageMeta = { diaries: page.diaries, skipped: page.skipped, incomplete: page.incomplete === true }
      pendingIngestRef.current = null
      heldRef.current = null
      const place = stateRef.current.seeded ? holdLive : replaceLive
      ingest({ ...place(rows, page.next, isLastPeekPage(page), pageMeta, Date.now()), reset: true })
      ingestHeld()
      commit({ loading: false, refreshing: false })
      noteShown(stamp, rows, pageMeta)
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
        ingestHeld()
      }
      // Follows held while the tab was hidden still drop their rows.
      if (activeRef.current && followsPending.current && stateRef.current.loadedAt !== null) {
        followsPending.current = false
        reconcileFollows(() => true)
      }
    }
  }, [hosted, peek, commit, ingest, ingestHeld, unfollowed, reconcileFollows, node.epoch, holdLive, replaceLive, noteShown])

  const loadMore = useCallback(async () => {
    const current = stateRef.current
    if (!active || !hosted || current.loading || current.refreshing || current.loadingMore) return
    // The end of the stored rows: the held live page's rows not shown yet go
    // after them, and its cursor carries the later rounds on.
    const held = liveHeldRef.current
    if (held !== null) {
      liveHeldRef.current = null
      const rows = unfollowed(held.rows)
      ingest(pageNeeds(rows))
      const merged = appendPeekPage({ items: current.items, unconfirmed: current.unconfirmed, rows })
      commit({ items: unfollowed(merged.items), unconfirmed: merged.unconfirmed, next: held.next, atEnd: held.atEnd, expired: false, meta: held.meta, pill: false })
      return
    }
    if (current.atEnd || current.expired || current.next === null) return
    const mine = ++seqRef.current
    commit({ loadingMore: true, moreError: '' })
    try {
      // An incomplete page that added nothing reads on from its cursor
      // (readLaterPages), all within this one load.
      await readLaterPages({
        after: current.next,
        read: (after) => peek({ limit: PEEK_LIMIT_MAX, after }),
        take: (page, after) => {
          if (mine !== seqRef.current) return null
          // A cursor that did not move ends the list (compared by value), unless
          // the page is incomplete: the node's candidate traversal still moved,
          // and the list's dry-page pause bounds how often it is asked again.
          const stuck = page.incomplete !== true && page.next !== null && page.next.round === after.round && page.next.at === after.at &&
            page.next.author === after.author && page.next.seq === after.seq
          // Later pages may fetch diaries the first page did not reach: keep the
          // newest counts and never drop an incomplete warning.
          const meta = stateRef.current.meta
          const rows = unfollowed(page.items)
          ingest(pageNeeds(rows))
          const merged = appendPeekPage({ items: stateRef.current.items, unconfirmed: stateRef.current.unconfirmed, rows })
          commit({
            items: unfollowed(merged.items),
            unconfirmed: merged.unconfirmed,
            next: page.next,
            atEnd: isLastPeekPage(page) || stuck,
            meta: { diaries: page.diaries, skipped: page.skipped, incomplete: meta.incomplete || page.incomplete === true }
          })
          return activeRef.current ? merged.added : null
        }
      })
      if (mine !== seqRef.current) return
      commit({ loadingMore: false })
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
      // One token per warm, kept with the refresh this read consumes, so
      // opening the tab can promote this request instead of sending it again.
      const token = Symbol('espiadinha-warm')
      previous.current = { ...previous.current, refresh: refreshRef.current, warmToken: token }
      loadFirst({ quiet: true, token }).finally(() => updatePeekWarmState(node.epoch, { pending: false }))
    })
    return () => wait.cancel()
  }, [hosted, node.online, node.phase, seederVerified, node.visible, node.epoch, node.whenIdle, active, state.loadedAt, state.loading, state.refreshing, state.unsupported, loadFirst, peekWarm])

  useEffect(() => {
    const prev = previous.current
    const shown = active && !prev.active
    const reselected = scrollToTop !== prev.scrollToTop
    const changed = refresh !== prev.refresh
    previous.current = { active, refresh: active ? refresh : prev.refresh, scrollToTop, warmToken: prev.warmToken }
    if (!active) return
    // The warm page goes on screen now; its needs load below, or with the
    // reload when it is already old.
    const held = heldRef.current
    if (held !== null && stateRef.current.loadedAt === null) {
      heldRef.current = null
      const rows = unfollowed(held.rows)
      const place = stateRef.current.seeded ? holdLive : replaceLive
      pendingIngestRef.current = place(rows, held.next, held.atEnd, held.meta, held.at)
      noteShown(held.stamp, rows, held.meta)
    }
    const current = stateRef.current
    if (current.loading || current.refreshing) {
      if (changed) reloadAfterRef.current = true
      // Still queued: the same warm read moves to the visible lane. Already
      // in flight, promote does nothing and this show waits, so it is not
      // sent twice. A pull to refresh is a later visible loadFirst.
      if (shown) promote(prev.warmToken)
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
      ingestHeld()
    }
    if (followsPending.current && current.loadedAt !== null) {
      followsPending.current = false
      reconcileFollows(() => true)
    }
  }, [active, refresh, scrollToTop, loadFirst, ingest, ingestHeld, reconcileFollows, commit, unfollowed, promote, holdLive, replaceLive, noteShown])

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
  // page in flight from bringing them back. A failed or uncertain answer
  // (timeout) is reported, never retried automatically, and the follow set
  // is read once again: it says what really happened, so a follow that did
  // land drops the author's rows as a follow made elsewhere would. A list
  // that is hidden or still loading keeps that read for later, like
  // followsSignal; a pass already started stops only on unmount.
  const dropFollowed = (author) => {
    commit({ items: recordFollow(followedHereRef.current, ++followStampRef.current, stateRef.current.items, author) })
    resave()
  }

  // 'ver novidades': the held live page replaces the list whole, as a
  // refresh would, and the list goes back to the top.
  const listRef = useRef(null)
  const takeHeld = () => {
    const held = liveHeldRef.current
    if (held === null) return
    liveHeldRef.current = null
    const rows = unfollowed(held.rows)
    ingest({ ...pageNeeds(rows), reset: true })
    const taken = takePeekPage(rows)
    commit({ ...taken, next: held.next, atEnd: held.atEnd, expired: false, meta: held.meta, pill: false, firstKeys: new Set(taken.items.map(peekKey)) })
    if (listRef.current) listRef.current.scrollToOffset({ offset: 0, animated: true })
  }
  const takeHeldRef = useRef(takeHeld)
  takeHeldRef.current = takeHeld
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])
  const rereadFollows = () => {
    if (stateRef.current.loadedAt === null || !activeRef.current) {
      followsPending.current = true
      return
    }
    reconcileFollows(() => mountedRef.current)
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
      rereadFollows()
    } finally {
      const rest = new Set(stateRef.current.following)
      rest.delete(author)
      commit({ following: rest })
    }
  }

  // GATE: stored rows of others no live page confirmed show only once
  // block.list answered and while their authors are neither blocked nor
  // muted, evaluated on every change (a block arriving later hides them).
  const owner = binding !== null ? binding.owner : null
  const blockKeys = blocks.keys
  const muteKeys = mutes.keys
  const storedAuthors = useMemo(() => storedRowAuthors(seedOriginals), [seedOriginals])
  // `items` below is what the list draws.
  const items = useMemo(() => {
    if (unconfirmed === null) return allItems
    const cached = allItems.filter((item) => unconfirmed.has(peekKey(item)))
    const ok = new Set(cachedRowsShown(cached, { loadState: blockLoad, blocked: blockKeys, muted: muteKeys, owner, authorsOf: storedAuthors }).map(peekKey))
    return withoutFollowed(allItems.filter((item) => !unconfirmed.has(peekKey(item)) || ok.has(peekKey(item))), followedHereRef.current)
  }, [allItems, unconfirmed, blockLoad, blockKeys, muteKeys, owner, storedAuthors])
  // Stored rows on screen stand in for a loaded page: offline they stay.
  // A held page whose stored rows the gate hides entirely goes on screen.
  const drawnCount = items.length
  const snapshotMarkedRef = useRef(false)
  useEffect(() => {
    if (!seeded || drawnCount === 0 || snapshotMarkedRef.current) return
    snapshotMarkedRef.current = true
    perfMarks().mark('rows-snapshot:espiadinha')
  }, [seeded, drawnCount])
  useEffect(() => {
    if (takesHeldPage({ held: liveHeldRef.current !== null, drawn: drawnCount })) takeHeldRef.current()
  }, [drawnCount, unconfirmed])
  const notice = peekNotice({ supported: !unsupported, hosted, online: node.online, loadedAt: loadedAt !== null || (seeded && items.length > 0) ? 0 : loadedAt })
  const skipped = skippedText(meta.skipped)
  const statusNote = expired
    ? 'A lista expirou; puxe para atualizar.'
    : meta.incomplete
      ? 'A lista pode estar incompleta; puxe para atualizar.'
      : skipped || PEEK_SHORT_TEXT
  const statusHelp = !expired && !meta.incomplete && skipped ? HELP.ausentes : HELP.espiadinha

  const header = (
    <View style={styles.header}>
      {!expired ? <HelpNote doc={statusHelp}><Soft>{statusNote}</Soft></HelpNote> : null}
      <CountsNote social={social} />
      {items.length > 0 && loadError ? <ErrorState message={loadError} onRetry={loadFirst} pending={refreshing} /> : null}
    </View>
  )

  const footer = (
    <View>
      {expired
        ? (
          <View style={styles.header}>
            <HelpNote doc={statusHelp}><Soft>{statusNote}</Soft></HelpNote>
            <Pill label='atualizar' onPress={loadFirst} pending={loading || refreshing} />
          </View>
          )
        : null}
      <ListFooter
        loading={loadingMore}
        atEnd={loadedAt !== null && atEnd && !expired && items.length > 0}
        endText='Isso é tudo por enquanto.'
        error={moreError}
        onRetry={loadMore}
        pending={loadingMore || refreshing}
      />
    </View>
  )

  let empty
  if (notice === 'web-only' && node.hosted !== true) {
    empty = <EmptyState icon='olho' title='Espiadinha indisponível' body={NOT_HOSTED} actionLabel='Saiba mais' onAction={() => setHelpOpen(true)} secondaryLabel='publicar' onSecondary={onPublish} />
  } else if (notice === 'web-only') {
    // A hosted node without a passkey identity, or a seeder without peek:
    // telling a native person to use the web would be wrong.
    empty = <EmptyState icon='olho' title='Espiadinha indisponível' body='A Espiadinha não está disponível nesta conexão.' actionLabel='publicar' onAction={onPublish} />
  } else if (notice === 'offline') {
    empty = <EmptyState icon='olho' title='Sem conexão' body={PEEK_OFFLINE_MESSAGE} actionLabel='Tentar de novo' onAction={loadFirst} secondaryLabel='publicar' onSecondary={onPublish} />
  } else if (loadError) {
    empty = <EmptyState icon='olho' title='Não foi possível carregar' body={loadError} actionLabel='Tentar de novo' onAction={loadFirst} secondaryLabel='publicar' onSecondary={onPublish} />
  } else if (loadedAt === null) {
    empty = <View>{[0, 1, 2].map(row => <SkeletonRow key={row} />)}</View>
  } else if (meta.diaries === 0) {
    empty = <EmptyState icon='olho' title='Ninguém para espiar ainda' body='Quando mais pessoas publicarem, as publicações delas aparecem aqui.' actionLabel='publicar' onAction={onPublish} secondaryLabel='atualizar' onSecondary={loadFirst} />
  } else {
    empty = <EmptyState icon='olho' title='Ainda não chegou nada' body='Quando houver publicações de quem você não segue, elas aparecem aqui.' actionLabel='atualizar' onAction={loadFirst} secondaryLabel='publicar' onSecondary={onPublish} />
  }

  const reportable = (item) => hosted && typeof onReport === 'function' && typeof ownKey === 'string' && item.author !== ownKey
  // The node never returns the own diary's rows; the guard stays so that no
  // row offers 'seguir' before the own key is known (it could be the own
  // one), and, as defence in depth, never on an own-key row.
  const canFollow = (author) => typeof ownKey === 'string' && typeof author === 'string' && author.toLowerCase() !== ownKey.toLowerCase()
  const handlers = { onOpenThread, onOpenMember, onOpenMention, onOpenEngagers, onOpenQuotes, onReply, onQuote, onReport }
  const openReposter = (item) => typeof onOpenMember === 'function'
    ? () => onOpenMember(item.author, { name: item.name, username: item.username })
    : undefined
  // A repost row is the ORIGINAL post (every action targets it) under the
  // reposter's line, as in A Rua; 'denunciar' reports the original. Its
  // 'seguir' sits on the reposter's line and follows the reposter.
  const rowCache = useRowPropsCache(items, peekKey, { h: handlers, social })
  // A stored row is not live yet: until a live page confirms it, it offers
  // no action and reads nothing more (built without the props cache, whose
  // live box would hand it the list's handlers).
  const isCached = (item) => unconfirmed !== null && unconfirmed.has(peekKey(item))
  const cachedRowProps = (args) => ({ ...socialRowProps({ ...args, h: {} }), onLike: undefined, onRepost: undefined, onNotice: undefined, onReport: undefined, seq: undefined, link: null })
  // Only a first-page row's photos go to the peek kinds (the rows that can
  // be stored), with those of the originals it draws (a repost's post, a
  // quote), filed under their authors; a row loaded by scrolling is never
  // kept.
  const peekPersist = (item) => binding !== null && firstKeys !== null && firstKeys.has(peekKey(item)) ? 'peek' : false
  // 'seguir' per author: one function for the list's life, calling the newest
  // follow, so the memoized row does not see a new prop on every render.
  const followRef = useRef(null)
  followRef.current = follow
  const followFns = useRef(new Map())
  const followFn = (author, name, username) => {
    let entry = followFns.current.get(author)
    if (!entry) {
      entry = { args: null, fn: () => followRef.current(entry.args.author, entry.args.name, entry.args.username) }
      followFns.current.set(author, entry)
    }
    entry.args = { author, name, username }
    return entry.fn
  }
  useEffect(() => {
    const keep = new Set(items.map(item => item.author))
    for (const author of [...followFns.current.keys()]) if (!keep.has(author)) followFns.current.delete(author)
  }, [items])
  // One renderItem for the list's life: FlatList re-renders the cells on
  // extraData, and the rows whose props did not change skip their render.
  const renderRef = useRef(null)
  const renderItem = useCallback((info) => renderRef.current(info), [])
  renderRef.current = ({ item }) => {
    if (item.kind === 'repost') {
      const ref = refOf(item.to)
      const repostedBy = { author: item.author, name: item.name, username: item.username }
      const post = social.original(ref)
      const cached = isCached(item)
      const followReposter = !cached && canFollow(item.author) ? followFn(item.author, item.name, item.username) : undefined
      const reposterPending = following.has(item.author)
      if (!post) {
        return (
          <RepostPlaceholder
            repostedBy={repostedBy}
            missing={post === null}
            transient={social.transient(ref)}
            onRetry={cached ? undefined : () => social.retry(ref)}
            onOpenReposter={cached ? undefined : openReposter(item)}
            onFollowReposter={followReposter}
            followPending={reposterPending}
          />
        )
      }
      if (cached) return <PostRow {...cachedRowProps({ post, ref, repostedBy, social, profileOf, now, ownKey, strangerPersist: peekPersist(item) })} />
      const row = socialRowProps({ post, ref, repostedBy, social, profileOf, now, ownKey, h: handlers, cache: rowCache, rowKey: peekKey(item), strangerPersist: peekPersist(item) })
      return (
        <PostRow
          {...row}
          onFollowReposter={followReposter}
          followPending={reposterPending}
          onReport={reportable(post) ? row.onReport : undefined}
        />
      )
    }
    if (isCached(item)) return <PostRow {...cachedRowProps({ post: item, ref: peekKey(item), social, profileOf, now, ownKey, strangerPersist: peekPersist(item) })} />
    const row = socialRowProps({ post: item, ref: peekKey(item), social, profileOf, now, ownKey, h: handlers, cache: rowCache, rowKey: peekKey(item), strangerPersist: peekPersist(item) })
    return (
      <PostRow
        {...row}
        onFollow={canFollow(item.author) ? followFn(item.author, item.name, item.username) : undefined}
        followPending={following.has(item.author)}
        onReport={reportable(item) ? row.onReport : undefined}
      />
    )
  }

  // Which handlers exist decides which actions a row offers (as `offered` in A Rua).
  const offered = [onOpenThread, onOpenMember, onOpenMention, onOpenEngagers, onReply, onQuote, onReport].map(fn => typeof fn === 'function' ? 1 : 0).join('')
  const extra = useMemo(() => ({ now, following, social: social.social, names: names.profileOf, ownKey, offered, hosted }), [now, following, social.social, names.profileOf, ownKey, offered, hosted])
  const shownItems = notice === null ? items : []
  return (
    <>
      <RefreshableList
        perfId='espiadinha'
        mediaPersistOf={row => social.persistOf(row.author) || peekPersist(row)}
        listRef={listRef}
        data={shownItems}
        keyExtractor={peekKey}
        renderItem={renderItem}
        extraData={extra}
        ListHeaderComponent={notice === null ? header : null}
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
        newItems={{ label: 'ver novidades', visible: pill && notice === null && items.length > 0, onPress: takeHeld }}
      />
      <HelpSheet open={helpOpen} onClose={() => setHelpOpen(false)} doc={HELP.espiadinha} />
    </>
  )
}

const styles = StyleSheet.create({
  header: { padding: 16, gap: 8 }
})
