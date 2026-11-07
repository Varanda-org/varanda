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

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { FOLLOW_LIMIT_MAX, displayText } from '@varanda/rpc'
import { useNode } from '../node'
import { useNames } from '../names'
import { fetchCounts, fetchMember, fetchPost, COUNTS_MAX } from '../indexClient'
import { assembleMember, assembleThread, planPeeks } from '../thread'
import { applyToggle, countsAfter, diaryPeekSlots, emptyState, fromRead, mergeCounts } from '../engagement'
import { noteLocalWrite } from '../localWrites'
import { replyNameOf, whoOf } from '../who'
import { avatarOf, pickAvatar } from '../media/avatar'
import { canDelete, isPageRef } from '../deletion'
import * as actingStore from '../actingAs'
import { actAs } from '../pages'
import { pagesCore } from '../pageGate'
import { coreActor } from '../pageCore'
import { Btn, ErrorText, Row, Soft, UNCERTAIN, errorText, useAction, useBottomPad, useNow } from '../ui'
import { OfflineNote } from '../ui/OfflineNote'
import { PostRow } from '../ui/PostRow'
import { RefreshableList } from '../ui/RefreshableList'
import { Sheet } from '../ui/Sheet'
import { ErrorState, ListFooter, Skeleton } from '../ui/States'
import { TopBar } from '../ui/TopBar'
import { revokeDeletedMedia } from '../media/cache'
import { type } from '../ui/theme'
import { useStyles } from '../ui/ThemeProvider'

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

// Who the app acts as (src/actingAs.js): re-renders on a change.
export function useActing () {
  return useSyncExternalStore(actingStore.subscribe, actingStore.get, actingStore.get)
}

// The key of the page acted as, or null (the member).
export function actingPageKey () {
  const a = actingStore.get()
  return a.kind === 'page' ? a.key : null
}

// The own member key, for the statements a page acts with. Read on every
// action, never cached: after a sign-out and the unlock of another diary,
// page.sign signs with the new key. On a core node (`node` given, pageGate.js
// pagesCore) it is the node's delegate (pageCore.js coreActor), since its
// identity.show key is the diary's, which the service never links to a page.
export async function memberKeyOf (request, node) {
  if (node && pagesCore({ hosted: node.hosted, accountOrigin: node.accountOrigin })) return (await coreActor(node)).actor
  const r = await request('identity.show', {})
  const key = r && typeof r.publicKey === 'string' ? r.publicKey.toLowerCase() : ''
  if (!/^[0-9a-f]{64}$/.test(key)) throw new Error('Serviço indisponível')
  return key
}

// A node, or a bare request function from a caller that has no node (then
// the hosted path: identity.show and the relative account path).
const nodeOf = (source) => (typeof source === 'function' ? { request: source } : source)

// The page's own likes and reposts (the signed 'status' read), by page. A
// toggle that succeeds updates its entry and bumps the page's generation, so
// a read that started before it never replaces the entry afterwards.
const pageStatus = new Map()
const pageGen = new Map()
const genOf = (page) => pageGen.get(page) || 0

export async function pageEngagement (source, page, { fresh = false } = {}) {
  if (!fresh && pageStatus.has(page)) return pageStatus.get(page)
  const started = genOf(page)
  const node = nodeOf(source)
  const member = await memberKeyOf(node.request, node)
  const data = await actAs(node, { member, action: 'status', page })
  const eng = data && typeof data.engagement === 'object' && data.engagement !== null ? data.engagement : {}
  const entry = {
    liked: new Set(Array.isArray(eng.liked) ? eng.liked : []),
    reposted: new Set(Array.isArray(eng.reposted) ? eng.reposted : [])
  }
  if (genOf(page) !== started) return pageStatus.get(page) || entry
  pageStatus.set(page, entry)
  return entry
}

// engagement.read of `refs`, as the member or as the page acted as.
export async function readEngagement (source, refs, page = actingPageKey()) {
  if (page === null) return nodeOf(source).request('engagement.read', { refs })
  const entry = await pageEngagement(source, page)
  return { liked: refs.filter((r) => entry.liked.has(r)), reposted: refs.filter((r) => entry.reposted.has(r)) }
}

// like.set / repost.set, as the member or as the page acted as. A page
// failure after the signature is 'uncertain' (actAs) and never signs again:
// its err.retry resends the same bytes and settles the cache like a first
// answer. -> { on, changed }: for a page, `changed` compares with the state
// cached before this statement (true when none was cached).
export async function setEngagement (source, kind, ref, on, page = actingPageKey()) {
  const node = nodeOf(source)
  if (page === null) return node.request(kind === 'like' ? 'like.set' : 'repost.set', { to: ref, on })
  const member = await memberKeyOf(node.request, node)
  const prior = pageStatus.get(page)
  const was = prior ? (kind === 'like' ? prior.liked : prior.reposted).has(ref) : null
  const settle = () => {
    pageGen.set(page, genOf(page) + 1)
    const entry = pageStatus.get(page)
    if (entry) {
      const set = kind === 'like' ? entry.liked : entry.reposted
      if (on) set.add(ref)
      else set.delete(ref)
    }
    return { on, changed: was === null ? true : was !== on }
  }
  const run = (send) => send().then(settle, (err) => {
    if (err && typeof err.retry === 'function') {
      const again = err.retry
      err.retry = () => run(again)
    }
    throw err
  })
  return run(() => actAs(node, { member, action: kind, page, op: { to: ref, on } }))
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
// added to), each through the app-wide diaryPeekSlots so every screen stays
// within the node's peek limit. 'semeador indisponível' is retried once after
// 2 s and then thrown; 'ocupado' (still possible beside a page.read probe) is
// retried a few times and then skipped, like 'diário indisponível' (the posts
// count as unavailable). `alive()` false stops early, also for a peek still
// waiting for a slot.
export async function peekAll (request, plan, peeked, alive = () => true) {
  for (const params of plan) {
    if (!alive()) return peeked
    let seederRetried = false
    let busyTries = 0
    for (;;) {
      try {
        // A screen the person opened: ahead of the feed's background quote reads.
        const peek = await diaryPeekSlots.run(() => alive() ? request('diary.peek', params) : null, { front: true })
        // A delete meanwhile invalidates this load: merging would bring the entry back.
        if (!alive()) return peeked
        mergePeek(peeked, peek)
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

// Deleting an own post: ask({ ref, seq }) opens the confirmation (DeletePrompt),
// confirm sends post.delete once. After an uncertain failure `recheck` (a read
// of the diary) runs before the action is offered again; nothing is resent.
// `node` (optional) lets a page post be deleted from a core node.
export function useDelete ({ request, node, onToast, onDeleted, recheck }) {
  const action = useAction()
  const sourceRef = useRef(null)
  sourceRef.current = node || request
  const [target, setTarget] = useState(null)
  const [rechecking, setRechecking] = useState(false)
  const notify = (text) => { if (typeof onToast === 'function') onToast(text) }
  const ask = (t) => {
    action.clearError()
    setTarget(t)
  }
  const cancel = () => {
    if (action.pending) return
    action.clearError()
    setTarget(null)
  }
  const confirm = async () => {
    if (target === null) return
    // A page post is deleted as the page (never the member's own request).
    const page = isPageRef(target.ref, actingPageKey()) ? actingPageKey() : null
    const r = await action.run(async () => {
      if (page === null) return request('post.delete', { to: target.ref })
      const source = nodeOf(sourceRef.current)
      const member = await memberKeyOf(source.request, source)
      return actAs(source, { member, action: 'delete', page, op: { to: target.ref } })
    })
    if (r.ok) {
      setTarget(null)
      notify('publicação apagada')
      await onDeleted(target)
    } else if (r.uncertain) {
      setTarget(null)
      setRechecking(true)
      notify(UNCERTAIN)
      try {
        await recheck()
      } catch {} finally {
        setRechecking(false)
      }
    }
  }
  return { target, pending: action.pending, error: action.error, offered: !rechecking, ask, cancel, confirm }
}

export function DeletePrompt ({ del }) {
  const styles = useStyles(makeStyles)
  return (
    <Sheet open={del.target !== null} onClose={() => del.cancel()} title='Apagar publicação'>
      <View style={styles.prompt}>
        <Soft>Apagar esta publicação? Ela some do seu diário e dos feeds de quem te segue.</Soft>
        <ErrorText>{del.error}</ErrorText>
        <Row>
          <Btn label='Apagar' danger onPress={() => del.confirm()} pending={del.pending} />
        </Row>
      </View>
    </Sheet>
  )
}

// The own like/repost state and the index counts on screen, with optimistic
// toggles: the change shows at once, like.set / repost.set is sent, and a
// failure reverts it and shows the error. A read never overrides a field
// (liked/reposted of a ref) with a toggle pending, or one that started or
// ended after that read started: `touched` keeps a stamp per field and ref.
// `node` (optional): the page statements go through it on a core node. It is
// read at call time, so the callbacks keep depending on `request` only.
export function useEngagement ({ request, node, onToast }) {
  const sourceRef = useRef(null)
  sourceRef.current = node || request
  const [state, setState] = useState(emptyState)
  const [counts, setCounts] = useState(() => new Map())
  const [pending, setPending] = useState(() => new Map())
  const pendingRef = useRef(new Map())
  const stateRef = useRef(state)
  stateRef.current = state
  const clockRef = useRef(0)
  const touchedRef = useRef(new Map()) // 'liked|<ref>' -> stamp
  const touch = (field, ref) => touchedRef.current.set(field + '|' + ref, ++clockRef.current)
  const readRefs = useRef(new Set())

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
      const as = actingPageKey()
      try {
        readRefs.current = new Set([...readRefs.current, ...part])
        const r = fromRead(await readEngagement(sourceRef.current, part, as))
        if (!alive()) return
        // Read for another identity than the one acted as now.
        if (as !== actingPageKey()) continue
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

  // Acting as another identity: the own state of the rows on screen is the
  // other identity's, so it is read again.
  const acting = useActing()
  const actingKey = acting.kind === 'page' ? acting.key : null
  const seenActing = useRef(actingKey)
  useEffect(() => {
    if (seenActing.current === actingKey) return undefined
    seenActing.current = actingKey
    const refs = [...readRefs.current]
    setState(emptyState())
    if (refs.length === 0) return undefined
    let live = true
    const again = async () => {
      if (actingKey !== null) {
        try { await pageEngagement(sourceRef.current, actingKey, { fresh: true }) } catch {}
      }
      if (live) await readOwn(refs, () => live)
    }
    again()
    return () => { live = false }
  }, [actingKey, request, readOwn])

  const toggle = useCallback(async (kind, ref, requestedOn) => {
    if (pendingRef.current.has(ref)) {
      if (requestedOn === false && typeof onToast === 'function') onToast('Aguarde um instante e tente de novo.')
      return
    }
    const field = kind === 'like' ? 'liked' : 'reposted'
    // The identity this toggle is for: its answer is that identity's state.
    const as = actingPageKey()
    let moved = false
    const was = stateRef.current[field].has(ref)
    // The undo always sends off: idempotent on the diary, and it still lands
    // when a refresh has cleared the local state (then the count is left alone).
    const on = requestedOn === false ? false : !was
    const delta = on ? 1 : (was ? -1 : 0)
    let succeeded = false
    const nextPending = new Map(pendingRef.current).set(ref, kind)
    pendingRef.current = nextPending
    setPending(nextPending)
    touch(field, ref)
    setState((s) => applyToggle(s, kind, ref, on))
    setCounts((m) => (m.has(ref) ? new Map(m).set(ref, countsAfter(m.get(ref), kind, delta)) : m))
    try {
      const r = await setEngagement(sourceRef.current, kind, ref, on, as)
      // Diário compares this with its load time (it gets no refresh bump).
      noteLocalWrite()
      // The diary's answer is the state, of the identity it was sent as.
      touch(field, ref)
      moved = as !== actingPageKey()
      if (!moved && r && typeof r.on === 'boolean') setState((s) => applyToggle(s, kind, ref, r.on))
      // Already in that state on the diary: the state is right, the count
      // had already counted it.
      if (r && r.changed === false) setCounts((m) => (m.has(ref) ? new Map(m).set(ref, countsAfter(m.get(ref), kind, -delta)) : m))
      succeeded = kind === 'repost' && on && !(r && r.on === false) && !(r && r.changed === false)
    } catch (err) {
      touch(field, ref)
      moved = as !== actingPageKey()
      if (!moved) setState((s) => applyToggle(s, kind, ref, was))
      setCounts((m) => (m.has(ref) ? new Map(m).set(ref, countsAfter(m.get(ref), kind, -delta)) : m))
      if (typeof onToast === 'function') onToast(errorText(err))
    } finally {
      const after = new Map(pendingRef.current)
      after.delete(ref)
      pendingRef.current = after
      setPending(after)
    }
    // Acted as someone else meanwhile: the row shows that identity's state.
    if (moved) readOwn([ref])
    // After pending cleared, so the undo (a second signed write) is not
    // dropped; it only undoes as the identity that reposted.
    if (succeeded && !moved && typeof onToast === 'function') {
      onToast({ text: 'Republicado', actionLabel: 'Desfazer', onAction: () => { if (actingPageKey() === as) toggle('repost', ref, false) } })
    }
  }, [request, onToast, readOwn])

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
  const { onOpenThread, onOpenMember, onOpenMention, onOpenEngagers, onReply, onQuote, onReport, onDelete } = handlers
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
    onDelete: hasSeq && typeof onDelete === 'function' && canDelete(item, typeof ownKey === 'string' ? ownKey.toLowerCase() : null, actingPageKey())
      ? () => onDelete({ ref, seq: item.seq })
      : undefined,
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

export default function Conversa ({ entry, ownKey, onBack, onReply, onQuote, onReport, onOpenThread, onOpenMember, onOpenMention, onOpenEngagers, onToast, onDeletedPost }) {
  const styles = useStyles(makeStyles)
  const node = useNode()
  const names = useNames()
  const now = useNow(60000)
  const bottomPad = useBottomPad()
  const focal = entry.key
  const seed = useMemo(() => seedItem(entry.params ? entry.params.seed : null, focal), [entry, focal])
  const full = !!node.hosted && node.online !== false
  const { request } = node
  const { learnMany, resolveMany } = names
  const eng = useEngagement({ request, node, onToast })
  const { follows, load: loadFollows } = useFollowSet(request)
  const [view, setView] = useState(INITIAL)
  const [parentHeight, setParentHeight] = useState(null)
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

  const del = useDelete({
    request,
    node,
    onToast,
    recheck: () => load(true),
    onDeleted: async (t) => {
      // Drops the result of a load started before the delete: it would bring the row back.
      genRef.current += 1
      if (typeof onDeletedPost === 'function') onDeletedPost()
      // Cached photos of the deleted post go too, wherever they were shown.
      revokeDeletedMedia(request, [t.seq])
      if (t.ref === focal) {
        onBack()
        return
      }
      // A quote of the deleted post must not keep showing its text.
      const [author, seqText] = t.ref.split(':')
      const known = peekedRef.current.get(author)
      if (known) peekedRef.current.set(author, { ...known, entries: known.entries.filter((e) => e.seq !== Number(seqText)) })
      const cur = viewRef.current
      const wasReply = cur.replies.some((r) => refOf(r.author, r.seq) === t.ref)
      commit({
        replies: cur.replies.filter((r) => refOf(r.author, r.seq) !== t.ref),
        parent: cur.parent && refOf(cur.parent.author, cur.parent.seq) === t.ref ? null : cur.parent,
        meta: wasReply && cur.meta ? { ...cur.meta, repliesTotal: Math.max(0, cur.meta.repliesTotal - 1) } : cur.meta,
        // The loads invalidated above never clear their own flags.
        loadingMore: false,
        refreshing: false
      })
    }
  })
  const handlers = { onOpenThread, onOpenMember, onOpenMention, onOpenEngagers, onReply, onQuote, onReport, onDelete: del.offered ? del.ask : undefined }
  const props = (item, extra) => rowProps({ item, names, peeked: peekedRef.current, now, ownKey, follows, eng: full ? eng : null, handlers, extra })

  const title = 'Conversa'
  const top = <TopBar title={title} onBack={onBack} />

  if (!full) {
    return (
      <View style={styles.flex}>
        {top}
        <DeletePrompt del={del} />
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
    <View style={styles.header}>
      {parent
        ? (
          <View style={styles.parent} onLayout={(e) => setParentHeight(e.nativeEvent.layout.height)}>
            <PostRow {...props(parent)} />
          </View>
          )
        : null}
      {post
        ? (
          <View style={styles.focal}>
            <PostRow {...props(post, parent ? { onOpenParent: () => onOpenThread({ ref: refOf(parent.author, parent.seq), seed: parent }), replyToName: whoOf(identityOf(names, parent.author, parent)).title } : {})} />
            {/* After the row: PostRow paints an opaque bg, and later siblings paint on top. */}
            <View pointerEvents='none' style={styles.accentBar} />
          </View>
          )
        : null}
      {parent && post && parentHeight !== null
        ? <View pointerEvents='none' accessible={false} style={[styles.connector, { height: parentHeight - 52 }]} />
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
      <DeletePrompt del={del} />
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

const makeStyles = (colors) => StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  note: { paddingHorizontal: 16, paddingVertical: 12 },
  prompt: { paddingHorizontal: 16, paddingVertical: 12, gap: 8 },
  header: { position: 'relative' },
  parent: { opacity: 0.72 },
  focal: { position: 'relative' },
  accentBar: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, backgroundColor: colors.accent },
  // Avatar centre x is 38 (paddingHorizontal 16 + 44 / 2); starts 4 below the parent avatar (12 + 44).
  connector: { position: 'absolute', left: 37, top: 60, width: 2, backgroundColor: colors.line },
  repliesHead: { paddingHorizontal: 16, paddingVertical: 12, gap: 4, borderBottomWidth: 1, borderBottomColor: colors.line },
  repliesTitle: { ...type.section, color: colors.soft }
})
