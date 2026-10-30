// A Rua: a newest-first timeline with backward cursors and explicit refreshes.
// Fresh sync hints offer new posts without moving the person's reading position.
// PostRow escapes raw peer strings and never derives display names from keys.
//
// Reposts and quotes: a feed item `kind: 'repost'` (its text is null and is
// never shown) renders the ORIGINAL post `item.to` under 'Nome republicou'; a
// post with a `quote` renders the quoted post in a QuoteCard. Originals are
// read with diary.peek (one call per author per page; on the hosted web with
// the seeder index's member hints, so strangers get their name and @nome;
// followed authors are served locally by the node). A node without
// diary.peek (the core node: 'leitura sob demanda só na versão web') falls
// back to log.read, which covers own and followed diaries. Every action on a
// repost item targets the original (reply, like, repost, quote, open,
// report), never the reposter's engagement record.
// Reply parents of strangers (not own, not followed) are read the same way,
// on the hosted web only, so their reply mark shows the verified name and
// @nome; elsewhere (the core node refuses diary.peek, and without the index
// hints a peek carries no name) they are not read and the mark reads 'sem
// nome'. A reposted original's parent is not on the page: the second pass
// (secondPassRefs) asks for it, and for what that original quotes, one level.
// Counts (hosted web only) come from the seeder index (/index/counts, 31 refs
// per call) and the own like/repost state from engagement.read (62 refs per
// call); like and repost taps are optimistic (../engagement.js), then
// like.set / repost.set; a failure reverts and shows the error for a moment.
// A failed counts chunk marks the index incomplete. A failed member lookup
// for an unknown author is retried once per ref, so a nameless original can
// still receive its name. `useSocial`, `socialRowProps` and `RepostPlaceholder`
// are shared with Diário (and the first two with the Espiadinha).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { ENGAGEMENT_LIMIT_MAX, FEED_LIMIT_DEFAULT, FEED_LIMIT_MAX, FOLLOW_LIMIT_MAX, displayText } from '@varanda/rpc'
import { useNode } from '../node'
import { useNames } from '../names'
import { pickAvatar } from '../media/avatar'
import { FEED_SYNCING_END, canSyncRead, cursorMoved, cursorOf, feedKey, feedStillSyncing, isLastFeedPage, mergeOlder, quietNewestPlan, rearmDelay, resetWith, shouldReloadOnShow, syncBaseline, syncReadKind, syncTruncated } from '../paging'
import { freshKeys, hasFresh } from '../syncSignals'
import { replyMarkOf, whoOf } from '../who'
import { COUNTS_MAX, MAX_COOLDOWN_MS, fetchCounts, fetchMember } from '../indexClient'
import { assembleMember, planPeeks } from '../thread'
import { applyToggle, countsAfter, emptyState, mergeCounts, secondPassRefs } from '../engagement'
import { DeletePrompt, isBusy, isDiaryGone, isSeederDown, useDelete } from './Conversa'
import { canDelete } from '../deletion'
import { revokeDeletedMedia } from '../media/cache'
import { HELP } from '../help'
import { Soft, errorText, useBottomPad, useNow } from '../ui'
import { HelpNote } from '../ui/Help'
import { Icon } from '../ui/Icon'
import { PostRow } from '../ui/PostRow'
import { RefreshableList } from '../ui/RefreshableList'
import { EmptyState, ErrorState, ListFooter, Skeleton } from '../ui/States'
import { colors, type } from '../ui/theme'

// Feed skip reasons that come from the association's signed blocklist.
const MODERATION_REASONS = ['blocked', 'revoked-issuer']
const TOAST_MS = 4000
// log.read page maximum (the fallback read of a node without diary.peek).
const LOG_WINDOW = 36
const FALLBACK_WINDOWS = 4
// Transient peek errors: 'semeador indisponível' is retried once after 2 s,
// 'ocupado' up to 3 times with a growing pause (like Conversa's peekAll); if
// it persists, the refs stay undefined (a later pass retries them).
const SEEDER_RETRY_MS = 2000
const BUSY_RETRY_MS = 600
const BUSY_RETRIES = 3
const INCOMPLETE_NOTE = 'Alguns números podem estar incompletos.'
// A failed member lookup (no profile hints) can store an original with no
// name. One re-read per ref per epoch, after retryAfterMs when the lookup
// gave a finite positive delay, otherwise 10 s. The cap is the index
// client's cooldown ceiling: a shorter one would fire the only retry while
// the shared cooldown still refuses every lookup, burning it for nothing.
const NAME_RETRY_MS = 10000
const NAME_RETRY_CAP_MS = MAX_COOLDOWN_MS
// Stored in `originals` for a ref whose read failed for a transient reason
// even after the bounded retries: shown as 'indisponível agora', retried on
// the next page, refresh or tap. Never exposed by original().
const TRANSIENT = Object.freeze({ transient: true })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function nameRetryDelay (ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return NAME_RETRY_MS
  return ms < NAME_RETRY_CAP_MS ? ms : NAME_RETRY_CAP_MS
}

// Name or @nome the row can show. Without either it reads 'sem nome', which
// is what a member lookup that failed leaves behind (no profile hints).
function hasName (item) {
  if (!item || item === TRANSIENT) return false
  const named = (v) => typeof v === 'string' && v !== ''
  return named(item.name) || named(item.username)
}

// 'author:seq' (lowercase author) of a { author, seq } target, or null.
export function refOf (t) {
  if (!t || typeof t.author !== 'string' || !Number.isSafeInteger(t.seq) || t.seq < 1) return null
  return t.author.toLowerCase() + ':' + t.seq
}

function chunks (list, size) {
  const out = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

const seqOfRef = (ref) => Number(ref.slice(ref.indexOf(':') + 1))
const authorOfRef = (ref) => ref.slice(0, ref.indexOf(':'))

// Originals, counts and the own like/repost state of the rows on screen.
// - ingest({ shown, need, parents, local, authors, reset }): `shown` = refs
//   whose counts and own state are wanted (the posts with an action bar);
//   `need` = refs to resolve (repost originals, quoted posts). What those
//   resolve to is read one level further (quote and replyTo); `parents` =
//   reply parents, resolved only on the hosted web and when their author is
//   neither own nor followed (for the reply mark's name); `local` = a Map ref ->
//   post item already at hand (feed posts); `authors` = keys known to be own
//   or followed (their photos may be kept). Calls run one after the other
//   (the browser node allows only two concurrent peeks).
// - original(ref): the post item, null (unavailable) or undefined (loading).
// - pending(ref): true while `ref` was asked for and has no answer yet (not
//   a transient failure either).
// - toggle(kind, ref): 'like' | 'repost', optimistic.
// - persistOf(author): true only for own or followed authors.
// - toast: the text of the last failed toggle for a moment (when the shell
//   gives no `onToast`).
export function useSocial ({ ownKey, onToast }) {
  const node = useNode()
  const names = useNames()
  const { request, hosted } = node
  const online = node.online !== false
  const { learnMany, resolveMany } = names
  // flags: the index's `indexing` / `complete` of the counts shown.
  const [social, setSocial] = useState(() => ({ originals: new Map(), counts: new Map(), eng: emptyState(), pending: new Map(), flags: { indexing: false, complete: true } }))
  const socialRef = useRef(social)
  // Bumped whenever `originals` is dropped (refresh, follows/moderation may
  // have changed): a read started before never writes into the new map.
  const epochRef = useRef(0)
  // The refs asked for since the last refresh, to re-resolve after a drop.
  const seenRef = useRef({ need: new Set(), local: new Map() })
  const deletedRef = useRef(new Set())
  const change = useCallback((update) => {
    const patch = update(socialRef.current)
    // Queued pages and pending original reads must not restore deleted content.
    if (patch.originals) {
      for (const ref of deletedRef.current) patch.originals.set(ref, null)
    }
    socialRef.current = { ...socialRef.current, ...patch }
    setSocial(socialRef.current)
  }, [])
  const deleteOriginal = useCallback((ref) => {
    deletedRef.current.add(ref)
    seenRef.current.local.delete(ref)
    change((prev) => ({ originals: new Map(prev.originals) }))
  }, [change])
  // Keys known to be own or followed: rebuilt on every refresh from the
  // page's authors and follow.list.
  const knownRef = useRef(new Set())
  const followsLoadedRef = useRef(false)
  // Refs already given one name retry in this epoch, and the timers that run
  // it. Both drop when the epoch bumps, so a new follow set can try again.
  const nameRetryRef = useRef(new Set())
  const nameTimersRef = useRef(new Set())
  const resolveRef = useRef(async () => [])
  const queueRef = useRef(Promise.resolve())
  const mountedRef = useRef(true)
  // Stamps per field and ref: an engagement.read never overrides a ref whose
  // toggle started or ended after that read started.
  const clockRef = useRef(0)
  const touchedRef = useRef(new Map())
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      for (const timer of nameTimersRef.current) clearTimeout(timer)
      nameTimersRef.current.clear()
    }
  }, [])

  const [toast, setToast] = useState('')
  const toastTimer = useRef(null)
  useEffect(() => () => clearTimeout(toastTimer.current), [])
  const showToast = useCallback((text) => {
    if (typeof onToast === 'function') return onToast(text)
    clearTimeout(toastTimer.current)
    setToast(text)
    toastTimer.current = setTimeout(() => setToast(''), TOAST_MS)
  }, [onToast])

  const own = typeof ownKey === 'string' ? ownKey.toLowerCase() : null
  const isKnown = useCallback((author) => author === own || knownRef.current.has(author), [own])

  // follow.list once per refresh (after a failure, again on the next need).
  const loadFollows = useCallback(async () => {
    if (followsLoadedRef.current) return
    followsLoadedRef.current = true
    const set = knownRef.current
    try {
      const r = await request('follow.list', { offset: 0, limit: FOLLOW_LIMIT_MAX })
      for (const k of Array.isArray(r.follows) ? r.follows : []) if (typeof k === 'string') set.add(k.toLowerCase())
    } catch {
      if (set === knownRef.current) followsLoadedRef.current = false
    }
  }, [request])

  // The post items at `refs` (all of one author), as a Map ref -> item.
  // `memberMiss` (ok: false): this author is not known and the member index
  // did not answer, so the peek had no profile hints. The posts can still be
  // read, without a name; resolve retries those refs once.
  const readAuthor = useCallback(async (author, refs) => {
    let hints = {}
    let memberMiss = null
    if (hosted && online && !isKnown(author)) {
      const m = await fetchMember(author)
      if (m.ok) hints = { [author]: { profileSeq: m.value.profileSeq, usernameSeq: m.value.usernameSeq } }
      else memberMiss = m
    }
    const out = new Map()
    const take = (peek, seqs) => {
      const { items } = assembleMember({ author, index: { posts: seqs.slice().sort((a, b) => b - a) }, peeked: new Map([[author, peek]]) })
      for (const item of items) if (item.kind === 'post') out.set(author + ':' + item.seq, item)
    }
    let fallback = false
    // Refs whose peek failed for a transient reason: not stored as
    // unavailable, so a later pass retries them.
    const transient = new Set()
    const plan = planPeeks({ refs, authors: hints })
    for (let i = 0; i < plan.length; i++) {
      const chunk = plan[i]
      let peek
      let seederRetried = false
      let busyTries = 0
      let failure = null
      for (;;) {
        try {
          peek = await request('diary.peek', chunk)
          break
        } catch (err) {
          if (isSeederDown(err) && !seederRetried) {
            seederRetried = true
            await sleep(SEEDER_RETRY_MS)
            continue
          }
          if (isBusy(err) && busyTries < BUSY_RETRIES) {
            busyTries++
            await sleep(BUSY_RETRY_MS * busyTries)
            continue
          }
          failure = err
          break
        }
      }
      if (failure) {
        if (isSeederDown(failure) || isBusy(failure)) {
          // Transient: this chunk and the rest stay undefined.
          for (const c of plan.slice(i)) for (const seq of c.seqs) transient.add(author + ':' + seq)
        } else if (!isDiaryGone(failure) && failure.code === 'USAGE') {
          // USAGE other than 'ocupado': this node has no on-demand reads.
          fallback = true
        }
        break
      }
      take(peek, chunk.seqs)
      if (peek && (peek.profile || peek.username)) {
        learnMany([[author, { name: peek.profile ? peek.profile.name : null, username: peek.username || null }]])
      }
    }
    if (fallback) {
      // Local data only: own and followed diaries. The seqs are grouped into
      // log.read windows (each covers its seqs), newest first, at most
      // FALLBACK_WINDOWS per author per page; seqs beyond them stay
      // unavailable until a later page or refresh.
      const desc = refs.map(seqOfRef).sort((a, b) => b - a)
      const groups = []
      for (const seq of desc) {
        const g = groups[groups.length - 1]
        if (g && g.max - seq < LOG_WINDOW) g.seqs.push(seq)
        else groups.push({ max: seq, seqs: [seq] })
      }
      for (const g of groups.slice(0, FALLBACK_WINDOWS)) {
        const min = g.seqs[g.seqs.length - 1]
        try {
          const log = await request('log.read', { author, before: g.max + 1, limit: g.max - min + 1 })
          const wanted = new Set(g.seqs)
          const entries = Array.isArray(log.entries) ? log.entries.filter((e) => e && wanted.has(e.seq)) : []
          take({ key: author, entries, profile: null, username: null }, entries.map((e) => e.seq))
        } catch {}
      }
    }
    out.transient = transient
    out.memberMiss = memberMiss
    return out
  }, [hosted, online, request, isKnown, learnMany])

  const dropNameRetries = useCallback(() => {
    nameRetryRef.current = new Set()
    for (const timer of nameTimersRef.current) clearTimeout(timer)
    nameTimersRef.current.clear()
  }, [])
  // One re-resolve of `refs`, on the same queue as ingest, after the member
  // lookup's retryAfterMs (else 10 s, capped at the index cooldown ceiling). Dropped when this epoch
  // ended or the screen unmounted. Recorded so a second failure does not
  // schedule again.
  const scheduleNameRetry = useCallback((refs, retryAfterMs, epoch) => {
    const fresh = []
    for (const ref of refs) {
      if (nameRetryRef.current.has(ref)) continue
      nameRetryRef.current.add(ref)
      fresh.push(ref)
    }
    if (fresh.length === 0) return
    const timer = setTimeout(() => {
      nameTimersRef.current.delete(timer)
      if (!mountedRef.current || epoch !== epochRef.current) return
      const run = queueRef.current.then(() => {
        if (!mountedRef.current || epoch !== epochRef.current) return null
        return resolveRef.current(fresh, { replaceNameless: true })
      }).catch(() => {})
      queueRef.current = run
    }, nameRetryDelay(retryAfterMs))
    nameTimersRef.current.add(timer)
  }, [])

  // Resolves the refs not known yet; -> the items found. With
  // `{ replaceNameless: true }` a ref already stored without a name is read
  // again and replaced only when the new item has a name (the one retry
  // after a failed member lookup). A normal call never overwrites a stored
  // original, so that retry cannot loop.
  const resolve = useCallback(async (need, opts) => {
    const replaceNameless = !!(opts && opts.replaceNameless)
    const epoch = epochRef.current
    const todo = need.filter((ref) => {
      const cur = socialRef.current.originals.get(ref)
      if (cur === undefined || cur === TRANSIENT) return true
      // null is "unavailable", not a nameless post: leave it for a real retry.
      return replaceNameless && cur !== null && !hasName(cur)
    })
    if (todo.length === 0) return []
    const byAuthor = new Map()
    for (const ref of todo) {
      const author = authorOfRef(ref)
      if (!byAuthor.has(author)) byAuthor.set(author, [])
      byAuthor.get(author).push(ref)
    }
    if ([...byAuthor.keys()].some((a) => !isKnown(a))) await loadFollows()
    const found = new Map()
    const missed = []
    for (const [author, refs] of byAuthor) {
      let got
      try {
        got = await readAuthor(author, refs)
      } catch {
        got = new Map()
      }
      if (!mountedRef.current) return []
      const later = got.transient || new Set()
      for (const ref of refs) found.set(ref, got.get(ref) || (later.has(ref) ? TRANSIENT : null))
      if (got.memberMiss && got.memberMiss.ok === false) missed.push({ refs, retryAfterMs: got.memberMiss.retryAfterMs })
    }
    // The originals were dropped while reading: these results are stale.
    if (epoch !== epochRef.current) return []
    change((prev) => {
      const originals = new Map(prev.originals)
      for (const [ref, item] of found) {
        const cur = originals.get(ref)
        if (!cur || cur === TRANSIENT) originals.set(ref, item)
        else if (replaceNameless && !hasName(cur) && hasName(item)) originals.set(ref, item)
      }
      return { originals }
    })
    // Failed member lookup, and the original came back with no name: one
    // later re-read of exactly those refs. Not on the replace path (that
    // re-read is the one try; another failure must not schedule a loop).
    if (!replaceNameless) {
      for (const miss of missed) {
        const nameless = []
        for (const ref of miss.refs) {
          const item = found.get(ref)
          if (item && item !== TRANSIENT && !hasName(item)) nameless.push(ref)
        }
        if (nameless.length > 0) scheduleNameRetry(nameless, miss.retryAfterMs, epoch)
      }
    }
    const items = [...found.values()].filter((i) => i && i !== TRANSIENT)
    const unnamed = items.filter((i) => isKnown(i.author) && !i.name).map((i) => i.author)
    if (unnamed.length > 0) resolveMany([...new Set(unnamed)])
    return items
  }, [request, readAuthor, isKnown, change, resolveMany, loadFollows, scheduleNameRetry])
  resolveRef.current = resolve

  const ingestNow = useCallback(async ({ shown = [], need = [], parents = [], local = new Map(), authors = [], reset = false }) => {
    // A refresh rebuilds the followed set (an unfollowed author's photos are
    // no longer kept): this page's authors (own or followed now) plus a
    // fresh follow.list; older pages only add their own authors.
    if (reset) {
      knownRef.current = new Set()
      followsLoadedRef.current = false
      epochRef.current++
      seenRef.current = { need: new Set(), local: new Map() }
      dropNameRetries()
    }
    for (const a of authors) if (typeof a === 'string') knownRef.current.add(a.toLowerCase())
    if (reset) await loadFollows()
    // Reply parents: only those of strangers are read (verified, with the
    // name and @nome); own and followed parent authors come from profile.read.
    // Only on the hosted web with a network: without the index hints the
    // peek carries no name. The native node's log.read fallback preempts the
    // sync for a mark that still reads 'sem nome'. The browser node serves
    // member reads from the live run's cores, so batching them still saves
    // requests and native preemptions.
    const asked = hosted && online ? parents.filter((r) => typeof r === 'string') : []
    if (asked.some((r) => !isKnown(authorOfRef(r)))) await loadFollows()
    const needed = need.filter((r) => typeof r === 'string')
    const strangers = asked.filter((r) => !isKnown(authorOfRef(r)))
    for (const r of needed.concat(strangers)) seenRef.current.need.add(r)
    for (const [ref, item] of local) {
      if (!deletedRef.current.has(ref)) seenRef.current.local.set(ref, item)
    }
    change((prev) => {
      // A refresh starts from an empty cache: every original (and each
      // unavailable one) passes diary.peek again, which refuses authors the
      // association has blocked since.
      const originals = reset ? new Map() : new Map(prev.originals)
      for (const [ref, item] of local) originals.set(ref, item)
      return { originals, ...(reset ? { flags: { indexing: false, complete: true } } : {}) }
    })
    const refs = [...new Set(shown.filter((r) => typeof r === 'string'))]
    // engagement.read first: a native read preempts the sync; the browser
    // node serves it from the live run's cores. Batching the chunks still
    // saves requests and native preemptions.
    for (const chunk of chunks(refs, ENGAGEMENT_LIMIT_MAX)) {
      const started = ++clockRef.current
      try {
        const r = await request('engagement.read', { refs: chunk })
        const liked = new Set(Array.isArray(r.liked) ? r.liked : [])
        const reposted = new Set(Array.isArray(r.reposted) ? r.reposted : [])
        // A read never overrides a ref with a pending toggle or a toggle that
        // started or ended after this read started.
        const fresh = (field, ref) => !socialRef.current.pending.has(ref) && !((touchedRef.current.get(field + '|' + ref) || 0) > started)
        change((prev) => {
          let eng = prev.eng
          for (const ref of chunk) {
            if (fresh('liked', ref)) eng = applyToggle(eng, 'like', ref, liked.has(ref))
            if (fresh('reposted', ref)) eng = applyToggle(eng, 'repost', ref, reposted.has(ref))
          }
          return { eng }
        })
      } catch {}
      if (!mountedRef.current) return
    }
    if (hosted && online) {
      for (const chunk of chunks(refs, COUNTS_MAX)) {
        const r = await fetchCounts(chunk)
        if (!mountedRef.current) return
        if (!r.ok) {
          // This chunk's numbers never arrived. indexing stays as it is; an
          // incomplete index is what CountsNote already explains.
          change((prev) => ({ flags: { indexing: prev.flags.indexing, complete: false } }))
          continue
        }
        change((prev) => {
          const fetched = {}
          for (const ref of Object.keys(r.value.counts)) if (!prev.pending.has(ref)) fetched[ref] = r.value.counts[ref]
          // Keep the index flags: indexing hides the counts, an incomplete
          // index gets a note.
          const flags = { indexing: r.value.indexing === true, complete: prev.flags.complete && r.value.complete !== false }
          return { counts: mergeCounts(prev.counts, fetched), flags }
        })
      }
    }
    // Originals, then (one level) what those originals quote or reply to,
    // then the page's stranger reply parents in a pass of their own: a slow
    // parent lookup (only a name) never holds back the originals already
    // read. The second pass uses every original at hand, not only the ones
    // just read: one cached earlier may quote a post never asked for, and a
    // reposted reply's parent is not on the page. resolve skips the refs it
    // already knows, and drops the write if the epoch moved.
    const firstRefs = [...new Set(needed)]
    await resolve(firstRefs)
    const at = (ref) => {
      const item = socialRef.current.originals.get(ref)
      return item && item !== TRANSIENT ? item : null
    }
    const second = secondPassRefs(firstRefs.map(at).filter(Boolean))
    if (second.length > 0 && mountedRef.current) await resolve(second)
    if (strangers.length > 0 && mountedRef.current) await resolve([...new Set(strangers)])
  }, [request, hosted, online, change, resolve, loadFollows, isKnown, dropNameRetries])

  // Stable identity (the screens' load callbacks depend on it): the queued
  // run uses the latest ingestNow.
  const ingestNowRef = useRef(ingestNow)
  ingestNowRef.current = ingestNow
  const ingest = useCallback((args) => {
    const run = queueRef.current.then(() => (mountedRef.current ? ingestNowRef.current(args) : null)).catch(() => {})
    queueRef.current = run
    return run
  }, [])

  const toggle = useCallback(async (kind, ref) => {
    if ((kind !== 'like' && kind !== 'repost') || typeof ref !== 'string' || socialRef.current.pending.has(ref)) return
    const field = kind === 'like' ? 'liked' : 'reposted'
    const was = socialRef.current.eng[field].has(ref)
    const on = !was
    const delta = on ? 1 : -1
    const shift = (prev, d) => {
      if (!prev.counts.has(ref)) return prev.counts
      const counts = new Map(prev.counts)
      counts.set(ref, countsAfter(prev.counts.get(ref), kind, d))
      return counts
    }
    const pendingWith = (prev, set) => {
      const pending = new Map(prev.pending)
      if (set) pending.set(ref, kind)
      else pending.delete(ref)
      return pending
    }
    touchedRef.current.set(field + '|' + ref, ++clockRef.current)
    change((prev) => ({ eng: applyToggle(prev.eng, kind, ref, on), counts: shift(prev, delta), pending: pendingWith(prev, true) }))
    try {
      const r = await request(kind === 'like' ? 'like.set' : 'repost.set', { to: ref, on })
      if (!mountedRef.current) return
      touchedRef.current.set(field + '|' + ref, ++clockRef.current)
      const final = r && typeof r.on === 'boolean' ? r.on : on
      change((prev) => ({
        eng: applyToggle(prev.eng, kind, ref, final),
        // Already in that state: the index had counted it before this tap.
        counts: r && r.changed === false ? shift(prev, -delta) : prev.counts,
        pending: pendingWith(prev, false)
      }))
    } catch (err) {
      if (!mountedRef.current) return
      touchedRef.current.set(field + '|' + ref, ++clockRef.current)
      change((prev) => ({ eng: applyToggle(prev.eng, kind, ref, was), counts: shift(prev, -delta), pending: pendingWith(prev, false) }))
      showToast(errorText(err))
    }
  }, [request, change, showToast])

  // The follows changed (and the node's moderation may have): drop the cache
  // and resolve what was asked for again. The known set is rebuilt from
  // follow.list on that pass; leaving it would keep isKnown/persistOf on the
  // old follows, so an unfollowed author's photos would still be kept.
  const followsVersion = typeof node.followsVersion === 'number' ? node.followsVersion : 0
  const seenFollows = useRef(followsVersion)
  useEffect(() => {
    if (seenFollows.current === followsVersion) return
    seenFollows.current = followsVersion
    epochRef.current++
    knownRef.current = new Set()
    followsLoadedRef.current = false
    dropNameRetries()
    const { need, local } = seenRef.current
    change(() => ({ originals: new Map(local) }))
    if (need.size > 0) ingest({ need: [...need], local })
  }, [followsVersion, change, ingest, dropNameRetries])

  const original = useCallback((ref) => {
    if (typeof ref !== 'string') return null
    const item = social.originals.get(ref)
    return item === TRANSIENT ? undefined : item
  }, [social])
  const transient = useCallback((ref) => typeof ref === 'string' && social.originals.get(ref) === TRANSIENT, [social])
  // The ask is recorded before the change that renders the page's originals,
  // and each answer changes `originals`, so renders after the ask see it
  // current (rows rendered before ingest runs read not pending).
  const pending = useCallback((ref) => typeof ref === 'string' && seenRef.current.need.has(ref) && social.originals.get(ref) === undefined, [social])
  const retry = useCallback((ref) => {
    if (typeof ref === 'string') ingest({ need: [ref] })
  }, [ingest])
  const persistOf = useCallback((author) => typeof author === 'string' && isKnown(author.toLowerCase()), [isKnown])

  return { social, ingest, toggle, original, transient, pending, retry, persistOf, toast, deleteOriginal }
}

// The PostRow props of `post` (a post item) whose actions target `ref`.
// `h`: { onOpenThread, onOpenMember, onOpenMention, onOpenEngagers, onReply, onQuote, onReport, onDelete } (each
// optional; onOpenMention(username, { author, username }) gets the row author's verified
// name so a tap on it needs no lookup). A repost passes the ORIGINAL as `post` and `repostedBy`.
export function socialRowProps ({ post, ref, repostedBy = null, social, profileOf, avatarOf = profileOf, now, ownKey, h, persist }) {
  const prof = profileOf(post.author) || null
  const name = post.name || (prof ? prof.name : null) || null
  const username = post.username || (prof ? prof.username : null) || null
  const quoteRef = refOf(post.quote)
  let quote = null
  if (quoteRef !== null) {
    const q = social.original(quoteRef)
    const qp = profileOf(post.quote.author) || null
    quote = {
      author: post.quote.author,
      name: (q && q.name) || (qp ? qp.name : null) || null,
      username: (q && q.username) || (qp ? qp.username : null) || null,
      avatar: pickAvatar(avatarOf(post.quote.author), q || null),
      at: q ? q.at : null,
      text: q ? q.text : null,
      media: q ? q.media : null,
      // A transient failure is shown as unavailable; tapping retries it.
      missing: q === null || (q === undefined && social.transient(quoteRef)),
      persist: social.persistOf(post.quote.author),
      hasQuote: !!(q && q.quote),
      onOpen: q === undefined && social.transient(quoteRef)
        ? () => social.retry(quoteRef)
        : typeof h.onOpenThread === 'function' ? () => h.onOpenThread({ ref: quoteRef, seed: q || undefined }) : undefined,
      onOpenMention: typeof h.onOpenMention === 'function' ? (u) => h.onOpenMention(u, { author: post.quote.author, username: quote.username }) : undefined
    }
  }
  const s = social.social
  const parentRef = refOf(post.replyTo)
  // The reply mark: the names cache, else the parent when it was resolved
  // (verified by the node: A Rua, Diário and the Espiadinha ask for the
  // parents of strangers' replies); '…' while either is on its way.
  let replyToName = null
  if (parentRef !== null) {
    replyToName = replyMarkOf({
      cached: profileOf(post.replyTo.author),
      parent: social.original(parentRef),
      pending: typeof social.pending === 'function' ? social.pending(parentRef) : false
    })
  }
  const own = typeof ownKey === 'string' ? ownKey.toLowerCase() : null
  return {
    author: post.author,
    name,
    username,
    avatar: pickAvatar(avatarOf(post.author), post),
    at: post.at,
    text: post.text,
    media: post.media || null,
    replyToName,
    // Feed posts pass persist: true (own or followed by construction).
    persistMedia: persist === true ? true : social.persistOf(post.author),
    now,
    quote,
    repostedBy,
    // While the index is still being built a count would be misleadingly small.
    counts: s.flags.indexing ? null : (s.counts.get(ref) || null),
    liked: s.eng.liked.has(ref),
    reposted: s.eng.reposted.has(ref),
    pending: s.pending.get(ref) || null,
    onOpen: typeof h.onOpenThread === 'function' ? () => h.onOpenThread({ ref, seed: post }) : undefined,
    onOpenAuthor: typeof h.onOpenMember === 'function' ? () => h.onOpenMember(post.author, { name, username }) : undefined,
    onOpenMention: typeof h.onOpenMention === 'function' ? (u) => h.onOpenMention(u, { author: post.author, username }) : undefined,
    onOpenParent: parentRef !== null && typeof h.onOpenThread === 'function' ? () => h.onOpenThread({ ref: parentRef }) : undefined,
    onOpenReposter: repostedBy && typeof h.onOpenMember === 'function' && repostedBy.author !== own
      ? () => h.onOpenMember(repostedBy.author, { name: repostedBy.name, username: repostedBy.username })
      : undefined,
    onReply: typeof h.onReply === 'function' ? () => h.onReply({ ref, name, username, text: post.text }) : undefined,
    onQuote: typeof h.onQuote === 'function' ? () => h.onQuote({ ref, name, username, text: post.text }) : undefined,
    onOpenLikes: typeof h.onOpenEngagers === 'function' ? () => h.onOpenEngagers({ ref, kind: 'likes' }) : undefined,
    onOpenReposts: typeof h.onOpenEngagers === 'function' ? () => h.onOpenEngagers({ ref, kind: 'reposts' }) : undefined,
    onLike: () => social.toggle('like', ref),
    onRepost: () => social.toggle('repost', ref),
    // Until the own key is known, no post can safely offer a report action.
    // Only the own post itself, never the original of a repost by someone else.
    onDelete: typeof h.onDelete === 'function' && canDelete(post, own) && repostedBy === null
      ? () => h.onDelete({ ref, seq: post.seq })
      : undefined,
    onReport: typeof h.onReport === 'function' && own !== null && post.author !== own
      ? () => h.onReport({ author: post.author, name, username, seq: post.seq, text: post.text })
      : undefined
  }
}

// 'Alguns números podem estar incompletos.' once at the top of a list (only
// when counts were read from the index, i.e. on the hosted web).
export function CountsNote ({ social }) {
  const f = social.social.flags
  if (f.indexing || f.complete !== false) return null
  return <View style={styles.footer}><Soft>{INCOMPLETE_NOTE}</Soft></View>
}

// A repost whose original is loading (`missing` false) or unavailable.
// `transient`: unavailable for now; a tap calls `onRetry`.
// `onFollowReposter` (optional, with `followPending`): a small 'seguir' on
// the reposter's line. A Rua and Diário pass neither.
export function RepostPlaceholder ({ repostedBy, missing, transient, onRetry, onOpenReposter, onFollowReposter, followPending }) {
  const who = displayText(whoOf({ name: repostedBy.name, username: repostedBy.username }).title)
  const followReposter = typeof onFollowReposter === 'function' ? onFollowReposter : null
  return (
    <View style={styles.placeholder}>
      <View style={styles.repostedLine}>
        <Text
          style={styles.reposted}
          onPress={onOpenReposter}
          accessibilityRole={onOpenReposter ? 'link' : 'text'}
          accessibilityLabel={who + ' republicou'}
        >
          <Icon name='republicar' size={14} color={colors.soft} />
          {' ' + who + ' republicou'}
        </Text>
        {followReposter
          ? (
            <Pressable
              accessibilityRole='button'
              accessibilityLabel={'seguir ' + who}
              accessibilityState={{ disabled: !!followPending }}
              disabled={!!followPending}
              onPress={followReposter}
              hitSlop={6}
              style={followPending ? styles.followOff : undefined}
            >
              <Text style={styles.follow}>seguir</Text>
            </Pressable>
            )
          : null}
      </View>
      {transient
        ? (
          <Pressable onPress={onRetry} accessibilityRole='button' accessibilityLabel='Publicação indisponível agora, tentar de novo'>
            <Soft>Publicação indisponível agora · toque para tentar de novo</Soft>
          </Pressable>
          )
        : missing ? <Soft>Publicação indisponível</Soft> : <View style={styles.skeleton} accessible={false} />}
    </View>
  )
}

// The transient error line of a failed toggle (when the shell gives no toast).
export function SocialToast ({ text }) {
  if (!text) return null
  return (
    <View style={styles.toast} pointerEvents='none'>
      <Text style={styles.toastText} accessibilityRole='alert'>{text}</Text>
    </View>
  )
}

const pageIncomplete = (page) => ({
  incomplete: Array.isArray(page.incomplete) ? page.incomplete : [],
  incompleteTruncated: Number.isSafeInteger(page.incompleteTruncated) ? page.incompleteTruncated : 0,
  syncTruncated: syncTruncated(page)
})

// The refs a feed page needs: counts and own state for every row's target,
// originals for reposts, quoted posts, reply parents; feed posts are already
// at hand.
function pageNeeds (pageItems) {
  const local = new Map()
  const shown = []
  const need = []
  const authors = []
  for (const i of pageItems) {
    authors.push(i.author)
    if (i.kind === 'repost') {
      const r = refOf(i.to)
      if (r !== null) {
        shown.push(r)
        need.push(r)
      }
      continue
    }
    const r = feedKey(i)
    local.set(r, i)
    shown.push(r)
    const q = refOf(i.quote)
    if (q !== null) need.push(q)
  }
  // Reply parents not on this page (useSocial reads only strangers' ones).
  const parents = new Set()
  for (const i of pageItems) {
    if (i.kind === 'repost' || !i.replyTo) continue
    const p = refOf(i.replyTo)
    if (p !== null && !local.has(p)) parents.add(p)
  }
  return { local, shown, need, parents: [...parents], authors }
}

export default function ARua ({ active, refresh, onReply, onReport, ownKey, followCount, scrollToTop, onFollowSomeone, onOpenThread, onOpenMember, onOpenMention, onOpenEngagers, onQuote, onToast, onDeletedPost }) {
  const node = useNode()
  const names = useNames()
  const now = useNow(60000)
  const bottomPad = useBottomPad()
  const social = useSocial({ ownKey, onToast })
  const { ingest } = social
  const [feed, setFeed] = useState({
    items: [],
    cursor: null,
    atEnd: false,
    loading: false,
    loadingMore: false,
    refreshing: false,
    loadError: '',
    moreError: '',
    retryKind: 'older',
    loadedAt: null,
    meta: { skipped: [], skippedTruncated: 0, future: [], futureTruncated: 0 },
    incomplete: [],
    incompleteTruncated: 0,
    syncTruncated: 0,
    syncBase: {},
    emptyStreak: 0,
    deep: false,
    probeOlder: false
  })
  const { items, atEnd, loading, loadingMore, refreshing, loadError, moreError, loadedAt, meta } = feed
  const feedRef = useRef(feed)
  const listRef = useRef(null)
  const signalsRef = useRef(node.signals)
  signalsRef.current = node.signals
  const activeRef = useRef(active)
  activeRef.current = active
  const rearmRef = useRef(null)
  // Only the latest read may commit; the ref also blocks duplicate end reaches
  // before React renders. Rows and their loading flags always change together.
  const seqRef = useRef(0)
  const commit = useCallback((patch) => {
    feedRef.current = { ...feedRef.current, ...patch }
    setFeed(feedRef.current)
  }, [])

  const { request, ackFresh } = node
  const { learnMany, resolveMany } = names
  const learnPage = useCallback((items) => {
    learnMany(items.map((i) => [i.author, { name: i.name, username: i.username }]))
    resolveMany(items.map((i) => i.author))
    resolveMany(items.filter((i) => i.replyTo).map((i) => i.replyTo.author))
  }, [learnMany, resolveMany])

  const ownSeenRef = useRef(null)
  const loadNewest = useCallback(async ({ quiet = false } = {}) => {
    if (quiet) {
      const current = feedRef.current
      if (!activeRef.current || current.loading || current.refreshing || current.loadingMore) return
      const mine = ++seqRef.current
      const seen = signalsRef.current
      const base = seen && seen.lengths ? seen.lengths : {}
      commit({ loadingMore: true, moreError: '' })
      try {
        const page = await request('feed.read', { limit: FEED_LIMIT_DEFAULT })
        if (mine !== seqRef.current) return
        const { skipped, skippedTruncated, future, futureTruncated } = page
        // A full page would cut rows off the end of the list being read: the
        // list stays and the unacknowledged 'ver novidades' pill shows the
        // newer rows. It stays at its end too: a full newest page says nothing
        // about rows older than the oldest shown, so the next automatic read
        // probes below the list (loadOlder fromSync) instead of the person
        // paging into a before read that comes back empty.
        const plan = quietNewestPlan(page, FEED_LIMIT_DEFAULT, feedRef.current.items)
        if (!plan.replace) {
          commit({ ...pageIncomplete(page), syncBase: syncBaseline(page, base), deep: true, probeOlder: true, loadingMore: false })
          return
        }
        commit({
          items: resetWith(page.items),
          cursor: cursorOf(page.items),
          atEnd: plan.atEnd,
          meta: { skipped, skippedTruncated, future, futureTruncated },
          ...pageIncomplete(page),
          syncBase: syncBaseline(page, base),
          emptyStreak: 0,
          deep: false,
          probeOlder: plan.probeOlder,
          loadingMore: false
        })
        learnPage(page.items)
        // No ack and no reset. On the native node any other request would
        // preempt the sync again. The browser node serves reads from the
        // live run's cores, so keeping this path small still saves requests
        // and native preemptions.
        ingest(pageNeeds(page.items))
      } catch (err) {
        if (mine === seqRef.current) commit({ loadingMore: false, moreError: errorText(err), retryKind: 'newest' })
      }
      return
    }
    const mine = ++seqRef.current
    const seen = signalsRef.current
    ownSeenRef.current = seen && typeof seen.ownLength === 'number' ? seen.ownLength : null
    commit({
      loading: feedRef.current.loadedAt === null,
      refreshing: feedRef.current.loadedAt !== null,
      loadingMore: false,
      loadError: '',
      moreError: ''
    })
    // Taken before the read so growth during it stays visible to the next pass.
    const base = seen && seen.lengths ? seen.lengths : {}
    try {
      const page = await request('feed.read', { limit: FEED_LIMIT_DEFAULT })
      if (mine !== seqRef.current) return
      const { skipped, skippedTruncated, future, futureTruncated } = page
      commit({
        items: resetWith(page.items),
        cursor: cursorOf(page.items),
        atEnd: isLastFeedPage(page, FEED_LIMIT_DEFAULT),
        loadedAt: Date.now(),
        meta: { skipped, skippedTruncated, future, futureTruncated },
        ...pageIncomplete(page),
        syncBase: syncBaseline(page, base),
        emptyStreak: 0,
        deep: false,
        probeOlder: false,
        loading: false,
        refreshing: false
      })
      learnPage(page.items)
      // Leave growth that arrived during this read available for the next pill.
      ackFresh(freshKeys(seen).filter((key) => key !== 'own' && seen.fresh[key] === signalsRef.current.fresh[key]))
      ingest({ ...pageNeeds(page.items), reset: true })
    } catch (err) {
      if (mine === seqRef.current) commit({ loading: false, refreshing: false, loadError: errorText(err) })
    }
  }, [request, ackFresh, commit, learnPage, ingest])

  const loadOlder = useCallback(async ({ fromSync = false } = {}) => {
    const current = feedRef.current
    if (!active || current.loading || current.refreshing || current.loadingMore || (current.atEnd && !fromSync) || current.cursor === null) return
    const mine = ++seqRef.current
    const before = current.cursor
    const seen = signalsRef.current
    const base = seen && seen.lengths ? seen.lengths : {}
    commit({ loadingMore: true, moreError: '' })
    try {
      const page = await request('feed.read', { limit: FEED_LIMIT_MAX, before })
      if (mine !== seqRef.current) return
      const cursor = cursorOf(page.items)
      const prev = feedRef.current
      commit({
        items: mergeOlder(prev.items, page.items).items,
        // An empty page keeps the cursor so a later sync pass can ask again.
        cursor: cursor === null ? before : cursor,
        atEnd: isLastFeedPage(page, FEED_LIMIT_MAX) || !cursorMoved(before, cursor),
        ...pageIncomplete(page),
        syncBase: syncBaseline(page, base),
        emptyStreak: page.items.length > 0 ? 0 : fromSync ? prev.emptyStreak + 1 : prev.emptyStreak,
        deep: prev.deep || page.items.length > 0,
        probeOlder: false,
        loadingMore: false
      })
      learnPage(page.items)
      ingest(pageNeeds(page.items))
    } catch (err) {
      if (mine === seqRef.current) commit({ loadingMore: false, moreError: errorText(err), retryKind: 'older' })
    }
  }, [active, request, commit, learnPage, ingest])

  // Own posts published on another device: A Rua compares the own diary's
  // synced length (signals.ownLength, never acknowledged, unlike fresh.own,
  // which Diário clears) with the length it last loaded; the first length
  // seen after a load is the baseline.
  const ownLength = node.signals && typeof node.signals.ownLength === 'number' ? node.signals.ownLength : null
  useEffect(() => {
    if (ownSeenRef.current === null && ownLength !== null) ownSeenRef.current = ownLength
  }, [ownLength])
  const ownNew = ownLength !== null && ownSeenRef.current !== null && ownLength > ownSeenRef.current
  const fresh = hasFresh(node.signals, { except: ownKey }) || ownNew
  const previous = useRef({ active: false, refresh, scrollToTop })
  useEffect(() => {
    const prev = previous.current
    const shown = active && !prev.active
    const reselected = scrollToTop !== prev.scrollToTop
    const changed = refresh !== prev.refresh
    // A publish while hidden invalidates the next show even inside 60 seconds.
    previous.current = { active, refresh: active ? refresh : prev.refresh, scrollToTop }
    if (!active) return
    const current = feedRef.current
    const stale = shouldReloadOnShow({ loadedAt: current.loadedAt, now: Date.now(), fresh })
    if (changed || ((shown || reselected) && stale && !current.loading && !current.refreshing)) loadNewest()
  }, [active, refresh, scrollToTop, fresh, loadNewest])

  // On the native node every feed.read preempts the sync run and the
  // continuous run restarts after it (docs/rpc.md section 6.1). The browser
  // node serves the read from the live run's cores. The first growth past
  // the baseline (or a pending probe below the list) starts one timer
  // (longer after empty older reads): later growth neither resets it nor
  // adds another, and this effect has no cleanup, which would debounce it on
  // every lengths change. That batching saves requests and native
  // preemptions. A short list re-reads the newest page, which shows arrivals
  // that sort inside the shown range. A full or deep list reads below its
  // oldest row: a diary that downloads newest first can add older rows
  // there, while newer rows reach it only through the 'ver novidades' pill.
  const lengths = node.signals ? node.signals.lengths : undefined
  const loadersRef = useRef(null)
  loadersRef.current = { loadNewest, loadOlder }
  useEffect(() => {
    if (rearmRef.current !== null || !canSyncRead(feedRef.current, lengths, active)) return
    const kindOf = (f) => syncReadKind({ deep: f.deep, probeOlder: f.probeOlder, shown: f.items.length, limit: FEED_LIMIT_DEFAULT })
    rearmRef.current = setTimeout(() => {
      rearmRef.current = null
      const current = feedRef.current
      const now = signalsRef.current ? signalsRef.current.lengths : undefined
      if (!canSyncRead(current, now, activeRef.current)) return
      if (kindOf(current) === 'older') loadersRef.current.loadOlder({ fromSync: true })
      else loadersRef.current.loadNewest({ quiet: true })
    }, rearmDelay(kindOf(feedRef.current) === 'older' ? feedRef.current.emptyStreak : 0))
  }, [active, lengths, atEnd, loading, loadingMore, refreshing, loadError, moreError, loadedAt, feed.syncBase, feed.incomplete, feed.syncTruncated, feed.emptyStreak, feed.probeOlder])

  useEffect(() => {
    if (!active && rearmRef.current !== null) {
      clearTimeout(rearmRef.current)
      rearmRef.current = null
    }
  }, [active])

  useEffect(() => () => {
    if (rearmRef.current !== null) {
      clearTimeout(rearmRef.current)
      rearmRef.current = null
    }
    seqRef.current += 1
    // Effect replay may show the mounted screen again after cancelling a read.
    previous.current.active = false
    feedRef.current = { ...feedRef.current, loading: false, loadingMore: false, refreshing: false }
  }, [])

  const showNewItems = () => {
    if (listRef.current) listRef.current.scrollToOffset({ offset: 0, animated: true })
    if (!feedRef.current.loading && !feedRef.current.refreshing) return loadNewest()
  }

  // Only the association's blocklist gets a sentence (plain words); other
  // skipped or future-dated entries are not shown to people.
  const blocked = meta.skipped.filter((s) => MODERATION_REASONS.includes(s.reason)).length
  // A failed manual read never commits atEnd, so an older error with atEnd
  // true came from an automatic read and its retry must bypass the end guard.
  const stillSyncing = feedStillSyncing(feed)
  const footer = (
    <View>
      <ListFooter
        loading={loadingMore}
        atEnd={loadedAt !== null && atEnd && items.length > 0}
        endText={stillSyncing ? FEED_SYNCING_END : 'Isso é tudo por enquanto.'}
        error={moreError}
        onRetry={() => feedRef.current.retryKind === 'newest' ? loadNewest({ quiet: true }) : loadOlder({ fromSync: feedRef.current.atEnd })}
        pending={loadingMore || refreshing}
      />
      {blocked > 0
        ? (
          <View style={styles.footer}>
            <HelpNote doc={HELP.bloqueio}>
              <Soft>{blocked === 1 ? 'Uma pessoa que você segue não aparece aqui.' : String(blocked) + ' pessoas que você segue não aparecem aqui.'}</Soft>
            </HelpNote>
          </View>
          )
        : null}
    </View>
  )

  let empty
  if (loadError) empty = <ErrorState message={loadError} onRetry={loadNewest} pending={loading || refreshing} />
  else if (loadedAt === null) empty = <Skeleton />
  else if (followCount === 0) {
    empty = (
      <EmptyState
        icon='gente'
        title='A Rua está vazia'
        body='Siga pessoas para ver as publicações delas aqui.'
        actionLabel='Seguir alguém'
        onAction={onFollowSomeone}
      />
    )
  } else {
    empty = (
      <EmptyState
        icon='gente'
        title='Ainda não chegou nada'
        body='Quando as pessoas que você segue publicarem, aparece aqui.'
      />
    )
  }

  const del = useDelete({
    request,
    onToast,
    recheck: loadNewest,
    onDeleted: async (t) => {
      social.deleteOriginal(t.ref)
      const cur = feedRef.current
      commit({ items: cur.items.filter((i) => (i.kind === 'repost' ? refOf(i.to) : feedKey(i)) !== t.ref) })
      if (typeof onDeletedPost === 'function') onDeletedPost()
      // Cached photos of the deleted post go too, wherever they were shown.
      await revokeDeletedMedia(request, [t.seq])
    }
  })
  // Reply names re-render when the cache changes; relative dates on each tick.
  // Originals, counts, the own state and whether deleting is offered re-render
  // the rows too.
  const extra = useMemo(() => ({ profileOf: names.profileOf, now, social: social.social, offered: del.offered }), [names.profileOf, now, social.social, del.offered])
  const handlers = { onOpenThread, onOpenMember, onOpenMention, onOpenEngagers, onReply, onQuote, onReport, onDelete: del.offered ? del.ask : undefined }
  // A repost row is the ORIGINAL post (every action targets it), under the
  // reposter's line; its own text (null) is never shown.
  const renderItem = ({ item }) => {
    if (item.kind === 'repost') {
      const ref = refOf(item.to)
      const repostedBy = { author: item.author, name: item.name, username: item.username }
      const post = social.original(ref)
      if (!post) {
        return (
          <RepostPlaceholder
            repostedBy={repostedBy}
            missing={post === null}
            transient={social.transient(ref)}
            onRetry={() => social.retry(ref)}
            onOpenReposter={typeof onOpenMember === 'function' ? () => onOpenMember(item.author, { name: item.name, username: item.username }) : undefined}
          />
        )
      }
      return <PostRow {...socialRowProps({ post, ref, repostedBy, social, profileOf: names.profileOf, now, ownKey, h: handlers })} />
    }
    return <PostRow {...socialRowProps({ post: item, ref: feedKey(item), social, profileOf: names.profileOf, now, ownKey, h: handlers, persist: true })} />
  }

  return (
    <View style={styles.flex}>
      <DeletePrompt del={del} />
      <RefreshableList
        listRef={listRef}
        data={items}
        keyExtractor={feedKey}
        renderItem={renderItem}
        extraData={extra}
        ListHeaderComponent={(
          <View>
            {items.length > 0 && loadError ? <ErrorState message={loadError} onRetry={loadNewest} pending={refreshing} /> : null}
            <CountsNote social={social} />
          </View>
        )}
        ListEmptyComponent={empty}
        ListFooterComponent={footer}
        contentContainerStyle={{ paddingBottom: bottomPad }}
        onRefresh={loadNewest}
        refreshing={refreshing}
        onLoadMore={active && !moreError && !loading && loadedAt !== null && !atEnd && feed.cursor !== null ? loadOlder : undefined}
        loadingMore={loadingMore}
        loadMoreError={!!moreError}
        atEnd={atEnd}
        scrollToTopSignal={scrollToTop}
        newItems={{ label: 'ver novidades', visible: fresh && loadedAt !== null, onPress: showNewItems }}
      />
      <SocialToast text={social.toast} />
    </View>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  footer: { padding: 16, gap: 8 },
  placeholder: {
    paddingVertical: 12,
    paddingHorizontal: 16,
    gap: 6,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
    backgroundColor: colors.bg
  },
  repostedLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  reposted: { ...type.replyMark, color: colors.soft, fontWeight: '600', flexShrink: 1 },
  follow: { ...type.counter, color: colors.accent },
  followOff: { opacity: 0.5 },
  skeleton: { height: 14, width: '60%', borderRadius: 7, backgroundColor: colors.skeleton },
  toast: {
    position: 'absolute',
    top: 12,
    left: 16,
    right: 16,
    alignItems: 'center'
  },
  toastText: {
    ...type.counter,
    color: '#ffffff',
    backgroundColor: colors.ink,
    borderRadius: 18,
    paddingVertical: 8,
    paddingHorizontal: 14,
    overflow: 'hidden'
  }
})
