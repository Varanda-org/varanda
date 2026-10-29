// Conversa: a post with its parent and ALL its replies, pushed above the
// tabs (App.js screen stack, entry { screen: 'conversa', key: ref, params:
// { seed } }). On the hosted web the seeder index (src/indexClient.js) says
// where to look (the parent ref, the replies paged with its cursor, seq hints
// and counts) and every post shown is fetched and verified by the node with
// diary.peek, then assembled by src/thread.js (a reply is kept only if its
// own signed replyTo is this post). engagement.read runs BEFORE the peeks
// (it preempts sync; the peeks then follow one at a time). Natively, or
// offline, only the row the person tapped (the seed) shows, with a note.
//
// The peek, follow and like/repost helpers are exported for Membro.js.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { FOLLOW_LIMIT_MAX, displayText } from '@varanda/rpc'
import { useNode } from '../node'
import { useNames } from '../names'
import { fetchCounts, fetchMember, fetchPost, COUNTS_MAX } from '../indexClient'
import { assembleMember, assembleThread, planPeeks } from '../thread'
import { applyToggle, countsAfter, emptyState, fromRead, mergeCounts } from '../engagement'
import { replyNameOf, whoOf } from '../who'
import { avatarOf, pickAvatar } from '../media/avatar'
import { Soft, errorText, useBottomPad, useNow } from '../ui'
import { OfflineNote } from '../ui/OfflineNote'
import { PostRow } from '../ui/PostRow'
import { RefreshableList } from '../ui/RefreshableList'
import { ErrorState, ListFooter, Skeleton } from '../ui/States'
import { TopBar } from '../ui/TopBar'
import { colors, type } from '../ui/theme'

// Same value as packages/rpc/lib/limits.js ENGAGEMENT_LIMIT_MAX.
export const ENGAGEMENT_MAX = 62
const SEEDER_RETRY_MS = 2000
const BUSY_RETRY_MS = 600
const BUSY_RETRIES = 3
const NOT_HOSTED_NOTE = 'Conversa completa disponível na versão web, com internet.'
const OFFLINE_NOTE = 'Sem internet: a conversa completa aparece quando a conexão voltar.'
const PARENT_GONE_NOTE = 'A publicação respondida está indisponível.'
const HINT_AUTHORS_MAX = 10

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function refOf (author, seq) {
  return author + ':' + seq
}

function parseRef (ref) {
  const i = typeof ref === 'string' ? ref.indexOf(':') : -1
  return i > 0 ? { author: ref.slice(0, i), seq: Number(ref.slice(i + 1)) } : null
}

function chunks (list, size) {
  const out = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

// NOT_FOUND 'semeador indisponível': no seeder reachable right now
// (retryable). 'diário indisponível': that author cannot be read (skipped).
export const isSeederDown = (err) => !!err && err.code === 'NOT_FOUND' && err.message === 'semeador indisponível'
export const isDiaryGone = (err) => !!err && err.code === 'NOT_FOUND' && err.message === 'diário indisponível'
export const isBusy = (err) => !!err && err.code === 'USAGE' && err.message === 'ocupado'

// Merges a peek result into the per-author map: entries are added, the
// first known profile and username are kept.
function mergePeek (peeked, peek) {
  if (!peek || typeof peek.key !== 'string') return
  const known = peeked.get(peek.key)
  if (!known) {
    peeked.set(peek.key, {
      key: peek.key,
      entries: Array.isArray(peek.entries) ? peek.entries.slice() : [],
      profile: peek.profile || null,
      username: typeof peek.username === 'string' ? peek.username : null
    })
    return
  }
  const entries = known.entries.concat(Array.isArray(peek.entries) ? peek.entries : [])
  peeked.set(peek.key, {
    key: peek.key,
    entries,
    profile: known.profile || peek.profile || null,
    username: known.username || (typeof peek.username === 'string' ? peek.username : null)
  })
}

// Runs the planned diary.peek calls one at a time into `peeked` (a Map,
// added to). 'semeador indisponível' is retried once after 2 s and then
// thrown; 'ocupado' (too many peeks at once) is retried a few times and then
// skipped, like 'diário indisponível' (the posts count as unavailable).
// `alive()` false stops early.
export async function peekAll (request, plan, peeked, alive = () => true) {
  for (const params of plan) {
    if (!alive()) return peeked
    let seederRetried = false
    let busyTries = 0
    for (;;) {
      try {
        mergePeek(peeked, await request('diary.peek', params))
        break
      } catch (err) {
        if (isSeederDown(err) && !seederRetried) {
          seederRetried = true
          await sleep(SEEDER_RETRY_MS)
          if (!alive()) return peeked
          continue
        }
        if (isBusy(err) && busyTries < BUSY_RETRIES) {
          busyTries++
          await sleep(BUSY_RETRY_MS * busyTries)
          if (!alive()) return peeked
          continue
        }
        if (isDiaryGone(err) || isBusy(err)) break
        throw err
      }
    }
  }
  return peeked
}

// The post item at `ref` from the peeked map (src/thread.js rules), or null.
export function postAt (peeked, ref) {
  const r = parseRef(ref)
  if (r === null) return null
  const { items } = assembleMember({ author: r.author, index: { posts: [r.seq] }, peeked })
  return items.length === 1 && items[0].kind === 'post' ? items[0] : null
}

// Names learned from the peeks (the verified profile/username fields only).
export function learnPeeked (learnMany, peeked) {
  const entries = []
  for (const [author, peek] of peeked) {
    const name = peek.profile && typeof peek.profile.name === 'string' ? peek.profile.name : null
    if (name !== null || peek.username !== null) entries.push([author, { name, username: peek.username }])
  }
  if (entries.length > 0) learnMany(entries)
}

// diary.peek params for `refs`, with the seeder index's member hints for the
// authors the node may not hold (strangers), so their names and verified
// usernames are learned. `known` = lowercase keys to skip (own, followed,
// already hinted or peeked). At most HINT_AUTHORS_MAX authors are looked up;
// a failed lookup just means no hint.
export async function planWithHints (refs, known, alive = () => true) {
  const authors = []
  for (const ref of refs) {
    const r = parseRef(ref)
    if (r !== null && !known.has(r.author) && !authors.includes(r.author)) authors.push(r.author)
  }
  const hints = {}
  for (const author of authors.slice(0, HINT_AUTHORS_MAX)) {
    if (!alive()) break
    const m = await fetchMember(author)
    if (m.ok) hints[author] = { profileSeq: m.value.profileSeq, usernameSeq: m.value.usernameSeq }
  }
  return planPeeks({ refs, authors: hints })
}

// The lowercase keys the hint lookup skips: own, followed, the ones with
// hints from the post index and the ones already peeked.
export function knownAuthors ({ ownKey, follows, hinted, peeked }) {
  const known = new Set()
  if (typeof ownKey === 'string') known.add(ownKey.toLowerCase())
  if (follows) for (const k of follows) known.add(k)
  if (hinted) for (const k of Object.keys(hinted)) known.add(k)
  if (peeked) for (const k of peeked.keys()) known.add(k)
  return known
}

// The follow list as a Set (own key not included), read once per screen
// load: decides the media cache (own/followed authors keep the long cache;
// strangers' photos are never kept). Null until read; a failed read is an
// empty set (the safe side: no-store).
export function useFollowSet (request) {
  const [follows, setFollows] = useState(null)
  const load = useCallback(async () => {
    const keys = []
    try {
      for (let offset = 0; offset < 10000;) {
        const r = await request('follow.list', { offset, limit: FOLLOW_LIMIT_MAX })
        const page = Array.isArray(r && r.follows) ? r.follows : []
        for (const k of page) if (typeof k === 'string') keys.push(k.toLowerCase())
        offset += page.length
        if (page.length === 0 || !(r && Number.isSafeInteger(r.total)) || offset >= r.total) break
      }
    } catch {}
    const set = new Set(keys)
    setFollows(set)
    return set
  }, [request])
  const mark = useCallback((key, on) => {
    setFollows((f) => {
      const next = new Set(f || [])
      if (on) next.add(key)
      else next.delete(key)
      return next
    })
  }, [])
  return { follows, load, mark }
}

// The own like/repost state and the index counts on screen, with optimistic
// toggles: the change shows at once, like.set / repost.set is sent, and a
// failure reverts it and shows the error. A read never overrides a field
// (liked/reposted of a ref) with a toggle pending, or one that started or
// ended after that read started: `touched` keeps a stamp per field and ref.
export function useEngagement ({ request, onToast }) {
  const [state, setState] = useState(emptyState)
  const [counts, setCounts] = useState(() => new Map())
  const [pending, setPending] = useState(() => new Map())
  const pendingRef = useRef(new Map())
  const stateRef = useRef(state)
  stateRef.current = state
  const clockRef = useRef(0)
  const touchedRef = useRef(new Map()) // 'liked|<ref>' -> stamp
  const touch = (field, ref) => touchedRef.current.set(field + '|' + ref, ++clockRef.current)

  const reset = useCallback(() => {
    setState(emptyState())
    setCounts(new Map())
    // Toggles still in flight keep protecting their refs.
    const kept = new Map()
    for (const [k, v] of touchedRef.current) if (pendingRef.current.has(k.slice(k.indexOf('|') + 1))) kept.set(k, v)
    touchedRef.current = kept
  }, [])
  // engagement.read for `refs` (chunks of ENGAGEMENT_MAX); a failure leaves
  // those refs shown as not liked/reposted.
  const readOwn = useCallback(async (refs, alive = () => true) => {
    for (const part of chunks([...new Set(refs)], ENGAGEMENT_MAX)) {
      if (!alive()) return
      const started = ++clockRef.current
      try {
        const r = fromRead(await request('engagement.read', { refs: part }))
        if (!alive()) return
        const fresh = (field, ref) => !pendingRef.current.has(ref) && !((touchedRef.current.get(field + '|' + ref) || 0) > started)
        setState((s) => {
          const liked = new Set(s.liked)
          const reposted = new Set(s.reposted)
          for (const ref of part) {
            if (fresh('liked', ref)) {
              if (r.liked.has(ref)) liked.add(ref)
              else liked.delete(ref)
            }
            if (fresh('reposted', ref)) {
              if (r.reposted.has(ref)) reposted.add(ref)
              else reposted.delete(ref)
            }
          }
          return { liked, reposted }
        })
      } catch {}
    }
  }, [request])
  // Index counts for `refs` (chunks of COUNTS_MAX); unknown refs stay null.
  const readCounts = useCallback(async (refs, alive = () => true) => {
    for (const part of chunks([...new Set(refs)], COUNTS_MAX)) {
      if (!alive()) return
      const r = await fetchCounts(part)
      if (!alive()) return
      if (r.ok) setCounts((m) => mergeCounts(m, r.value.counts))
    }
  }, [])
  const setCount = useCallback((ref, c) => setCounts((m) => mergeCounts(m, { [ref]: c })), [])

  const toggle = useCallback(async (kind, ref) => {
    if (pendingRef.current.has(ref)) return
    const field = kind === 'like' ? 'liked' : 'reposted'
    const on = !stateRef.current[field].has(ref)
    const delta = on ? 1 : -1
    const nextPending = new Map(pendingRef.current).set(ref, kind)
    pendingRef.current = nextPending
    setPending(nextPending)
    touch(field, ref)
    setState((s) => applyToggle(s, kind, ref, on))
    setCounts((m) => (m.has(ref) ? new Map(m).set(ref, countsAfter(m.get(ref), kind, delta)) : m))
    try {
      const r = await request(kind === 'like' ? 'like.set' : 'repost.set', { to: ref, on })
      // The diary's answer is the state.
      touch(field, ref)
      if (r && typeof r.on === 'boolean') setState((s) => applyToggle(s, kind, ref, r.on))
      // Already in that state on the diary: the state is right, the count
      // had already counted it.
      if (r && r.changed === false) setCounts((m) => (m.has(ref) ? new Map(m).set(ref, countsAfter(m.get(ref), kind, -delta)) : m))
    } catch (err) {
      touch(field, ref)
      setState((s) => applyToggle(s, kind, ref, !on))
      setCounts((m) => (m.has(ref) ? new Map(m).set(ref, countsAfter(m.get(ref), kind, -delta)) : m))
      if (typeof onToast === 'function') onToast(errorText(err))
    } finally {
      const after = new Map(pendingRef.current)
      after.delete(ref)
      pendingRef.current = after
      setPending(after)
    }
  }, [request, onToast])

  return { state, counts, pending, reset, readOwn, readCounts, setCount, toggle }
}

// Names prefer the verified peek; avatars prefer the authoritative cache.
// Raw strings: PostRow escapes them.
export function identityOf (names, author, item) {
  const p = names.profileOf(author)
  return {
    name: (item && item.name) || (p ? p.name : null) || null,
    username: (item && item.username) || (p ? p.username : null) || null,
    avatar: pickAvatar(p, item)
  }
}

// The PostRow props for an assembled (or seed) post item. `extra` overrides
// (repostedBy, onOpenReposter, replyToName...).
export function rowProps ({ item, names, peeked, now, ownKey, follows, eng, handlers, extra = {} }) {
  const { onOpenThread, onOpenMember, onOpenMention, onOpenEngagers, onReply, onQuote, onReport } = handlers
  const ref = refOf(item.author, item.seq)
  const who = identityOf(names, item.author, item)
  const hasSeq = Number.isSafeInteger(item.seq) && item.seq >= 1
  let quote = null
  if (item.quote) {
    const qref = refOf(item.quote.author, item.quote.seq)
    const q = peeked ? postAt(peeked, qref) : null
    if (q) {
      const qwho = identityOf(names, q.author, q)
      quote = { author: q.author, name: qwho.name, username: qwho.username, avatar: qwho.avatar, at: q.at, text: q.text, media: q.media, persist: q.author === ownKey || (follows !== null && follows.has(q.author)), missing: false, onOpen: () => onOpenThread({ ref: qref, seed: q }), onOpenMention: typeof onOpenMention === 'function' ? (u) => onOpenMention(u, { author: q.author, username: qwho.username }) : undefined }
    } else {
      quote = { author: item.quote.author, name: null, username: null, avatar: null, at: null, text: null, media: null, persist: false, missing: true, onOpen: () => onOpenThread({ ref: qref }) }
    }
  }
  const parentRef = item.replyTo ? refOf(item.replyTo.author, item.replyTo.seq) : null
  const reportable = typeof onReport === 'function' && typeof ownKey === 'string' && item.author !== ownKey && hasSeq
  return {
    author: item.author,
    name: who.name,
    username: who.username,
    avatar: who.avatar,
    at: item.at,
    text: item.text,
    replyToName: parentRef ? replyNameOf(names.profileOf(item.replyTo.author)) : null,
    media: item.media || null,
    persistMedia: item.author === ownKey || (follows !== null && follows.has(item.author)),
    now,
    quote,
    repostedBy: null,
    counts: eng && eng.counts.has(ref) ? eng.counts.get(ref) : null,
    liked: !!eng && eng.state.liked.has(ref),
    reposted: !!eng && eng.state.reposted.has(ref),
    pending: eng && eng.pending.has(ref) ? eng.pending.get(ref) : null,
    onOpen: hasSeq ? () => onOpenThread({ ref, seed: item }) : undefined,
    onOpenAuthor: () => onOpenMember(item.author, who),
    onOpenMention: typeof onOpenMention === 'function' ? (u) => onOpenMention(u, { author: item.author, username: who.username }) : undefined,
    onOpenParent: parentRef ? () => onOpenThread({ ref: parentRef }) : undefined,
    onOpenReposter: undefined,
    onReply: hasSeq && typeof onReply === 'function' ? () => onReply({ ref, name: who.name, username: who.username, text: item.text }) : undefined,
    onQuote: hasSeq && typeof onQuote === 'function' ? () => onQuote({ ref, name: who.name, username: who.username, text: item.text }) : undefined,
    onOpenLikes: eng && hasSeq && typeof onOpenEngagers === 'function' ? () => onOpenEngagers({ ref, kind: 'likes' }) : undefined,
    onOpenReposts: eng && hasSeq && typeof onOpenEngagers === 'function' ? () => onOpenEngagers({ ref, kind: 'reposts' }) : undefined,
    onLike: eng && hasSeq ? () => eng.toggle('like', ref) : undefined,
    onRepost: eng && hasSeq ? () => eng.toggle('repost', ref) : undefined,
    onReport: reportable ? () => onReport({ author: item.author, name: who.name, username: who.username, seq: item.seq, text: item.text }) : undefined,
    ...extra
  }
}

// A seed (the feed item tapped) as a post item, or null.
export function seedItem (seed, ref) {
  if (!seed || typeof seed !== 'object') return null
  const r = parseRef(ref)
  if (r === null || seed.author !== r.author) return null
  return {
    kind: 'post',
    author: r.author,
    seq: r.seq,
    at: typeof seed.at === 'string' ? seed.at : null,
    text: typeof seed.text === 'string' ? seed.text : '',
    replyTo: seed.replyTo || null,
    quote: seed.quote || null,
    media: Array.isArray(seed.media) && seed.media.length > 0 ? seed.media : null,
    name: typeof seed.name === 'string' ? seed.name : null,
    username: typeof seed.username === 'string' ? seed.username : null,
    avatar: avatarOf(seed.avatar)
  }
}

// The quoted posts of `items` not peeked yet, as diary.peek params.
async function quotePlan (items, peeked, known, alive) {
  const refs = []
  for (const item of items) {
    if (!item || !item.quote) continue
    const ref = refOf(item.quote.author, item.quote.seq)
    if (postAt(peeked, ref) === null) refs.push(ref)
  }
  return planWithHints(refs, known, alive)
}

const INITIAL = {
  phase: 'loading', // 'loading' | 'ready' | 'error'
  error: '',
  meta: null, // { indexing, complete, repliesTotal }
  parentGone: false, // the index lists a parent that cannot be shown
  parent: null,
  post: null,
  replies: [],
  unavailable: 0,
  next: null,
  loadingMore: false,
  moreError: '',
  refreshing: false
}

export default function Conversa ({ entry, ownKey, onBack, onReply, onQuote, onReport, onOpenThread, onOpenMember, onOpenMention, onOpenEngagers, onToast }) {
  const node = useNode()
  const names = useNames()
  const now = useNow(60000)
  const bottomPad = useBottomPad()
  const focal = entry.key
  const seed = useMemo(() => seedItem(entry.params ? entry.params.seed : null, focal), [entry, focal])
  const full = !!node.hosted && node.online !== false
  const { request } = node
  const { learnMany, resolveMany } = names
  const eng = useEngagement({ request, onToast })
  const { follows, load: loadFollows } = useFollowSet(request)
  const [view, setView] = useState(INITIAL)
  const viewRef = useRef(view)
  const peekedRef = useRef(new Map())
  const followsRef = useRef(Promise.resolve(new Set()))
  const genRef = useRef(0)
  const commit = useCallback((patch) => {
    viewRef.current = { ...viewRef.current, ...patch }
    setView(viewRef.current)
  }, [])

  const { readOwn, readCounts, setCount, reset } = eng
  const load = useCallback(async (refreshing = false) => {
    const mine = ++genRef.current
    const alive = () => mine === genRef.current
    commit(refreshing ? { refreshing: true, error: '' } : { ...INITIAL })
    try {
      let res = await fetchPost(focal)
      if (!alive()) return
      if (!res.ok && (res.reason === 'network' || res.reason === 'timeout')) {
        await sleep(SEEDER_RETRY_MS)
        if (!alive()) return
        res = await fetchPost(focal)
        if (!alive()) return
      }
      if (!res.ok) {
        commit({ phase: 'error', refreshing: false, error: res.reason === 'not-found' ? 'Esta conversa não está disponível.' : 'Não foi possível abrir a conversa.' })
        return
      }
      const index = res.value
      const refs = [focal].concat(index.parent ? [index.parent] : [], index.replies)
      // engagement.read first: it preempts sync, so it goes before the peeks.
      if (refreshing) reset()
      await readOwn(refs, alive)
      if (!alive()) return
      followsRef.current = loadFollows()
      const peeked = new Map()
      await peekAll(request, planPeeks({ refs, authors: index.authors }), peeked, alive)
      if (!alive()) return
      const { parent, post, replies, unavailable } = assembleThread({ focal, index, peeked })
      const followSet = await followsRef.current
      if (!alive()) return
      await peekAll(request, await quotePlan([parent, post].concat(replies), peeked, knownAuthors({ ownKey, follows: followSet, hinted: index.authors, peeked }), alive), peeked, alive)
      if (!alive()) return
      peekedRef.current = peeked
      learnPeeked(learnMany, peeked)
      resolveMany([...new Set([post, parent].concat(replies).filter(Boolean).flatMap((i) => i.quote ? [i.author, i.quote.author] : [i.author]))])
      setCount(focal, { replies: index.repliesTotal, likes: index.likes, reposts: index.reposts, quotes: index.quotesTotal })
      commit({
        phase: 'ready',
        error: '',
        refreshing: false,
        meta: { indexing: index.indexing, complete: index.complete, repliesTotal: index.repliesTotal },
        parent,
        post,
        replies,
        // An unavailable parent is not counted as an unavailable reply.
        parentGone: !!index.parent && !parent,
        unavailable: unavailable - (index.parent && !parent ? 1 : 0),
        next: index.next,
        loadingMore: false,
        moreError: ''
      })
      readCounts((parent ? [refOf(parent.author, parent.seq)] : []).concat(replies.map((r) => refOf(r.author, r.seq))), alive)
    } catch (err) {
      if (!alive()) return
      commit({ phase: 'error', refreshing: false, error: isSeederDown(err) ? 'Sem conexão com o servidor agora.' : errorText(err) })
    }
  }, [focal, request, commit, readOwn, readCounts, setCount, reset, loadFollows, learnMany, resolveMany, ownKey])

  const loadMore = useCallback(async () => {
    const current = viewRef.current
    if (current.phase !== 'ready' || current.loadingMore || current.refreshing || current.next === null) return
    const mine = genRef.current
    const alive = () => mine === genRef.current
    commit({ loadingMore: true, moreError: '' })
    try {
      const res = await fetchPost(focal, current.next)
      if (!alive()) return
      if (!res.ok) {
        commit({ loadingMore: false, moreError: 'Não foi possível carregar mais respostas.' })
        return
      }
      const index = res.value
      await readOwn(index.replies, alive)
      if (!alive()) return
      const peeked = peekedRef.current
      await peekAll(request, planPeeks({ refs: index.replies, authors: index.authors }), peeked, alive)
      if (!alive()) return
      // The parent was counted with the first page.
      const page = assembleThread({ focal, index: { ...index, parent: null }, peeked })
      const followSet = await followsRef.current
      if (!alive()) return
      await peekAll(request, await quotePlan(page.replies, peeked, knownAuthors({ ownKey, follows: followSet, hinted: index.authors, peeked }), alive), peeked, alive)
      if (!alive()) return
      learnPeeked(learnMany, peeked)
      resolveMany([...new Set(page.replies.flatMap((i) => i.quote ? [i.author, i.quote.author] : [i.author]))])
      const seen = new Set(viewRef.current.replies.map((r) => refOf(r.author, r.seq)))
      const fresh = page.replies.filter((r) => !seen.has(refOf(r.author, r.seq)))
      commit({
        replies: viewRef.current.replies.concat(fresh),
        unavailable: viewRef.current.unavailable + page.unavailable,
        next: index.next === current.next ? null : index.next,
        meta: { indexing: index.indexing, complete: index.complete, repliesTotal: index.repliesTotal },
        loadingMore: false
      })
      readCounts(fresh.map((r) => refOf(r.author, r.seq)), alive)
    } catch (err) {
      if (alive()) commit({ loadingMore: false, moreError: isSeederDown(err) ? 'Sem conexão com o servidor agora.' : errorText(err) })
    }
  }, [focal, request, commit, readOwn, readCounts, learnMany, resolveMany, ownKey])

  useEffect(() => {
    if (full) load(false)
    else loadFollows()
    return () => { genRef.current += 1 }
  }, [full, load, loadFollows])

  const handlers = { onOpenThread, onOpenMember, onOpenMention, onOpenEngagers, onReply, onQuote, onReport }
  const props = (item, extra) => rowProps({ item, names, peeked: peekedRef.current, now, ownKey, follows, eng: full ? eng : null, handlers, extra })

  const title = 'Conversa'
  const top = <TopBar title={title} onBack={onBack} />

  if (!full) {
    return (
      <View style={styles.flex}>
        {top}
        <OfflineNote />
        <View style={styles.flex}>
          {seed ? <PostRow {...props(seed)} /> : null}
          <View style={styles.note}><Soft>{node.hosted ? OFFLINE_NOTE : NOT_HOSTED_NOTE}</Soft></View>
        </View>
      </View>
    )
  }

  const { phase, error, meta, parent, replies, unavailable, next, loadingMore, moreError, refreshing } = view
  const post = view.post || (phase !== 'ready' ? seed : null)
  const notes = []
  if (view.parentGone) notes.push(PARENT_GONE_NOTE)
  if (meta && meta.indexing) notes.push('Ainda montando a conversa completa…')
  else if (meta && meta.complete === false) notes.push('Algumas respostas podem faltar.')
  if (unavailable > 0) notes.push(unavailable === 1 ? '1 resposta indisponível' : String(unavailable) + ' respostas indisponíveis')

  const header = (
    <View>
      {parent
        ? (
          <View style={styles.parent}>
            <PostRow {...props(parent)} />
          </View>
          )
        : null}
      {post
        ? (
          <View style={styles.focal}>
            <PostRow {...props(post, parent ? { onOpenParent: () => onOpenThread({ ref: refOf(parent.author, parent.seq), seed: parent }), replyToName: whoOf(identityOf(names, parent.author, parent)).title } : {})} />
          </View>
          )
        : null}
      {phase === 'ready' && !view.post
        ? <View style={styles.note}><Soft>Esta publicação não pôde ser verificada agora.</Soft></View>
        : null}
      {phase === 'error'
        ? <ErrorState message={displayText(error)} onRetry={() => load(false)} />
        : null}
      {phase === 'ready'
        ? (
          <View style={styles.repliesHead}>
            <Text style={styles.repliesTitle} accessibilityRole='header'>
              {meta && meta.repliesTotal === 1 ? '1 resposta' : String(meta ? meta.repliesTotal : 0) + ' respostas'}
            </Text>
            {notes.map((n) => <Soft key={n}>{n}</Soft>)}
          </View>
          )
        : null}
    </View>
  )

  return (
    <View style={styles.flex}>
      {top}
      <OfflineNote />
      <View style={styles.flex}>
        <RefreshableList
          data={phase === 'ready' ? replies : []}
          keyExtractor={(r) => refOf(r.author, r.seq)}
          renderItem={({ item }) => <PostRow {...props(item, { replyToName: null, onOpenParent: undefined })} />}
          extraData={{ eng, follows, now, profileOf: names.profileOf }}
          ListHeaderComponent={header}
          ListEmptyComponent={phase === 'loading' ? <Skeleton /> : null}
          ListFooterComponent={phase === 'ready'
            ? (
              <ListFooter
                loading={loadingMore}
                atEnd={next === null && replies.length > 0}
                endText='Isso é tudo nesta conversa.'
                error={moreError}
                onRetry={loadMore}
                pending={loadingMore}
              />
              )
            : null}
          contentContainerStyle={{ paddingBottom: bottomPad }}
          onRefresh={() => load(true)}
          refreshing={refreshing}
          onLoadMore={phase === 'ready' && next !== null && !moreError ? loadMore : undefined}
          loadingMore={loadingMore}
          loadMoreError={!!moreError}
          atEnd={next === null}
        />
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  note: { paddingHorizontal: 16, paddingVertical: 12 },
  parent: { opacity: 0.72 },
  focal: { borderLeftWidth: 3, borderLeftColor: colors.accent },
  repliesHead: { paddingHorizontal: 16, paddingVertical: 12, gap: 4, borderBottomWidth: 1, borderBottomColor: colors.line },
  repliesTitle: { ...type.section, color: colors.soft }
})
