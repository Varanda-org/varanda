// Conversa: a thread as comments, pushed above the tabs (App.js screen stack,
// entry { screen: 'conversa', key: ref, params: { seed, focus } }). The key
// may be any post of the thread: src/rodaLoad.js resolveRoot finds its root
// (the only main post) and the comment holding it. Two levels only: the
// root's direct replies are the comments, and under each comment its roda
// (src/roda.js), every reply of its subtree shown flat with a quote of the
// message it answers. No row opens another thread. On the hosted web the
// seeder index (src/indexClient.js) says where to look and every post shown
// is fetched and verified by the node with diary.peek: a comment passes
// src/thread.js assembleThread (signed replyTo is the root), a roda reply
// passes assembleRoda (signed replyTo chains to its comment). engagement.read
// runs BEFORE the peeks of each page (it preempts sync; the peeks then follow
// one at a time). Natively, or offline, only the row the person tapped (the
// seed) shows, with a note.
//
// The peek, follow and like/repost helpers are exported for Membro.js.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { AccessibilityInfo, KeyboardAvoidingView, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { FOLLOW_LIMIT_MAX, displayText } from '@varanda/rpc'
import { useNode } from '../node'
import { readFollowKeys } from '../follow'
import { useNames } from '../names'
import { fetchCounts, fetchMember, fetchPost, fetchRoda, COUNTS_MAX } from '../indexClient'
import { assembleMember, assembleThread, planPeeks } from '../thread'
import { mergeChildren, withOwnReply } from '../threadRows'
import { AUTHOR_TAG, assembleRoda, canSwipeReply, commentOrder, commentRows, rodaOrder, withAnchor } from '../roda'
import { SEEK_PAGES, resolveRoot, seekTarget } from '../rodaLoad'
import { isRef } from '../nav'
import { quickReplyPlan, sendPageTextReply, sendTextReply } from '../replySend'
import { hasLink } from '../links'
import { refusalOf } from '../wordCheck'
import { applyToggle, countsAfter, diaryPeekSlots, emptyState, fromRead, mergeCounts } from '../engagement'
import { noteLocalWrite } from '../localWrites'
import { registerLocalCache, cacheGeneration } from '../localCaches'
import { replyNameOf, whoOf } from '../who'
import { avatarOf, pickAvatar } from '../media/avatar'
import { isPageRef } from '../deletion'
import { canDeletePost } from '../postActions'
import { installationOrigin } from '../installation'
import { postLink } from '../postLink'
import * as actingStore from '../actingAs'
import { actAs, pagesChoice } from '../pages'
import { pickedFromStatus, pickedOf, withPick } from '../pageChoice'
import { pagesCore } from '../pageGate'
import { coreActor } from '../pageCore'
import { Btn, ErrorText, Row, Soft, UNCERTAIN, errorText, useAction, useBottomPad, useVisibleNow } from '../ui'
import { BranchLink } from '../ui/BranchLink'
import { OfflineNote } from '../ui/OfflineNote'
import { PostRow } from '../ui/PostRow'
import { PostSheetProvider } from '../ui/PostSheetHost'
import { ReplyBar } from '../ui/ReplyBar'
import { useKeyboardAvoidEnabled, useKeyboardOpen } from '../ui/keyboardAvoid'
import { EmbedBandBottom } from '../ui/screenVisible'
import { cachedRow, pruneRows } from '../namesCache'
import { RefreshableList } from '../ui/RefreshableList'
import { Sheet } from '../ui/Sheet'
import { SwipeReply } from '../ui/SwipeReply'
import { ErrorState, ListFooter, Skeleton } from '../ui/States'
import { TopBar } from '../ui/TopBar'
import { BUSY_RETRIES, BUSY_RETRY_MS, isBusy } from '../busyRetry'
import { revokeDeletedMedia } from '../media/cache'
import { space } from '../ui/theme'
import { useStyles } from '../ui/ThemeProvider'

// Same value as packages/rpc/lib/limits.js ENGAGEMENT_LIMIT_MAX.
export const ENGAGEMENT_MAX = 62
const SEEDER_RETRY_MS = 2000
const NOT_HOSTED_NOTE = 'Conversa completa disponível na versão web, com internet.'
const OFFLINE_NOTE = 'Sem internet: a conversa completa aparece quando a conexão voltar.'
const RESEND_NOTE = 'A mensagem anterior pode ter sido enviada. Envie de novo sem mudar o texto: ela é reenviada, sem duplicar.'
const MAYBE_SENT_NOTE = 'A resposta pode ter sido enviada. Confira a conversa antes de enviar de novo.'
// How long held page bytes are resent: the account service accepts a nonce
// for 600 s (apps/cli/lib/account/pages-routes.js NONCE_TTL_MS); this stops
// two minutes short, since the bytes were signed before the lost send.
const HELD_RETRY_MS = 8 * 60 * 1000
const PARENT_GONE_NOTE = 'A publicação respondida está indisponível.'
const CUT_NOTE = 'O começo desta conversa está mais acima e não pôde ser mostrado.'
const MISSING_QUOTE = 'Mensagem indisponível'
const RODA_ERROR = 'Não foi possível carregar as respostas.'
const HINT_AUTHORS_MAX = 10
const OUTSIDE_NOTE = 'Mensagem fora do trecho carregado'
const JUMP_RETRY_MS = 120
const ANCHOR_TRIES = 4
const FLASH_MS = 900

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// The delete rule lives in postActions.js (canDeletePost).
export function canDeleteHere (item, ownKey) {
  return canDeletePost(item, { ownKey, page: actingPageKey() })
}

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

// One read per page at a time: a plain read joins the one in flight, and a
// failed read is not kept, so the next call reads again.
const pageReads = new Map()

export function pageEngagement (source, page, { fresh = false } = {}) {
  if (!fresh && pageStatus.has(page)) return Promise.resolve(pageStatus.get(page))
  if (!fresh && pageReads.has(page)) return pageReads.get(page)
  const started = genOf(page)
  const read = (async () => {
    const node = nodeOf(source)
    const member = await memberKeyOf(node.request, node)
    const data = await actAs(node, { member, action: 'status', page })
    const eng = data && typeof data.engagement === 'object' && data.engagement !== null ? data.engagement : {}
    const entry = {
      liked: new Set(Array.isArray(eng.liked) ? eng.liked : []),
      reposted: new Set(Array.isArray(eng.reposted) ? eng.reposted : []),
      picked: pickedFromStatus(data)
    }
    if (genOf(page) !== started) return pageStatus.get(page) || entry
    pageStatus.set(page, entry)
    return entry
  })()
  pageReads.set(page, read)
  const done = () => { if (pageReads.get(page) === read) pageReads.delete(page) }
  read.then(done, done)
  return read
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

// The page's own pick on the poll or event `ref` ('author:seq') of `count`
// options: an option index, or null for none. Reads the page's 'status' once
// per page.
export async function readPagePick (source, page, ref, count) {
  const entry = await pageEngagement(source, page)
  return pickedOf(entry.picked, ref, count)
}

// The page's vote or RSVP ('choice'; pick null withdraws). A failure after
// the signature is 'uncertain' and never signs again: its err.retry resends
// the same bytes and settles the cache like a first answer.
export async function setPagePick (source, page, ref, pick) {
  const node = nodeOf(source)
  const member = await memberKeyOf(node.request, node)
  const settle = () => {
    pageGen.set(page, genOf(page) + 1)
    const entry = pageStatus.get(page)
    if (entry) entry.picked = withPick(entry.picked, ref, pick)
    return { pick }
  }
  // After an unknown outcome the cached pick may be the old one: the entry
  // is dropped, so the next read asks the service again.
  const run = (send) => send().then(settle, (err) => {
    if (err && err.uncertain === true) {
      pageGen.set(page, genOf(page) + 1)
      pageStatus.delete(page)
    }
    if (err && typeof err.retry === 'function') {
      const again = err.retry
      err.retry = () => run(again)
    }
    throw err
  })
  return run(() => pagesChoice(node, { member, page, to: ref, pick }))
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
export { isBusy }

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
// Kept per peek object (mergePeek replaces it, never edits it), so the same
// entries give the same item and a cached row's inputs stay identical.
const postsByPeek = new WeakMap()
export function postAt (peeked, ref) {
  const r = parseRef(ref)
  if (r === null) return null
  const peek = peeked instanceof Map ? peeked.get(r.author) : null
  const memo = peek !== null && typeof peek === 'object' ? (postsByPeek.get(peek) || new Map()) : null
  if (memo !== null && memo.has(r.seq)) return memo.get(r.seq)
  const { items } = assembleMember({ author: r.author, index: { posts: [r.seq] }, peeked })
  const post = items.length === 1 && items[0].kind === 'post' ? items[0] : null
  if (memo !== null) {
    memo.set(r.seq, post)
    postsByPeek.set(peek, memo)
  }
  return post
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
// strangers' photos are never kept). Null until read. A failed read changes
// nothing (the set read before stays, or null: the safe side, no-store) and
// resolves to an empty set for callers that wait on it.
export function useFollowSet (request) {
  const [follows, setFollows] = useState(null)
  const load = useCallback(async () => {
    const set = await readFollowKeys(request, FOLLOW_LIMIT_MAX)
    if (set === null) return new Set()
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
export function useDelete ({ request, node, onToast, onDeleted, recheck, onUncertain }) {
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
    const refs = new Set([target.ref])
    if (r.ok || r.uncertain) dropOwnReplies(ownReplyCache, refs)
    if (r.ok) {
      setTarget(null)
      notify('publicação apagada')
      // onDeleted and the Conversas below find the parent in their own copy
      // of the replies sent here to lower its count, so those copies are
      // dropped only after both have run.
      try {
        await onDeleted(target)
      } finally {
        announceDeleted(refs)
        forgetOwnReplies(refs)
      }
    } else if (r.uncertain) {
      setTarget(null)
      setRechecking(true)
      notify(UNCERTAIN)
      try {
        if (onUncertain) onUncertain(target)
        forgetOwnReplies(refs)
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
  const countsRef = useRef(counts)
  countsRef.current = counts

  // Returns an undo for a refresh that fails after the clear: the rows stay on
  // screen, so their counts and own likes come back (a field touched, a ref
  // read or a count read since wins over the old one).
  const reset = useCallback(() => {
    const priorState = stateRef.current
    const priorCounts = countsRef.current
    const stamp = ++clockRef.current
    setState(emptyState())
    setCounts(new Map())
    // Toggles still in flight keep protecting their refs.
    const kept = new Map()
    for (const [k, v] of touchedRef.current) if (pendingRef.current.has(k.slice(k.indexOf('|') + 1))) kept.set(k, v)
    touchedRef.current = kept
    return () => {
      const since = (field, ref) => (touchedRef.current.get(field + '|' + ref) || 0) > stamp
      const stale = (field, ref) => since(field, ref) || since('read', ref)
      setState((s) => {
        const liked = new Set(s.liked)
        const reposted = new Set(s.reposted)
        for (const ref of priorState.liked) if (!stale('liked', ref)) liked.add(ref)
        for (const ref of priorState.reposted) if (!stale('reposted', ref)) reposted.add(ref)
        return { liked, reposted }
      })
      setCounts((m) => new Map([...priorCounts, ...m]))
    }
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
        for (const ref of part) touch('read', ref)
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

  return useMemo(() => ({ state, counts, pending, reset, readOwn, readCounts, setCount, toggle }), [state, counts, pending, reset, readOwn, readCounts, setCount, toggle])
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
// (repostedBy, onOpenReposter, replyToName...). With a `cache` (a Map from
// useThreadRowCache) and a string `rowKey`, the same props object comes back
// while what the row shows is unchanged, so a memoized PostRow skips its
// render; its callbacks read the newest handlers and engagement at call time.
export function rowProps ({ item, names, peeked, now, ownKey, follows, eng, handlers, extra = {}, cache, rowKey }) {
  const offers = Object.keys(handlers).filter((k) => typeof handlers[k] === 'function')
  const has = (k) => offers.includes(k)
  const ref = refOf(item.author, item.seq)
  const authorProfile = names.profileOf(item.author)
  const qref = item.quote ? refOf(item.quote.author, item.quote.seq) : null
  const q = qref !== null && peeked ? postAt(peeked, qref) : null
  const qProfile = q ? names.profileOf(q.author) : null
  const parentProfile = item.replyTo ? names.profileOf(item.replyTo.author) : null
  const acting = actingPageKey()
  const origin = installationOrigin() || globalThis.location?.origin || null
  const build = (live) => {
    const who = identityOf(names, item.author, item)
    const hasSeq = Number.isSafeInteger(item.seq) && item.seq >= 1
    let quote = null
    if (item.quote) {
      if (q) {
        const qwho = identityOf(names, q.author, q)
        quote = { author: q.author, name: qwho.name, username: qwho.username, avatar: qwho.avatar, at: q.at, text: q.text, media: q.media, preview: q.preview || null, persist: q.author === ownKey || (follows !== null && follows.has(q.author)), missing: false, onOpen: () => live.handlers.onOpenThread({ ref: qref, seed: q }), onOpenMention: has('onOpenMention') ? (u) => live.handlers.onOpenMention(u, { author: q.author, username: qwho.username }) : undefined }
      } else {
        quote = { author: item.quote.author, name: null, username: null, avatar: null, at: null, text: null, media: null, persist: false, missing: true, onOpen: () => live.handlers.onOpenThread({ ref: qref }) }
      }
    }
    const parentRef = item.replyTo ? refOf(item.replyTo.author, item.replyTo.seq) : null
    const onMessage = (author, options) => live.handlers.onMessage(author, options)
    const reportable = has('onReport') && typeof ownKey === 'string' && item.author !== ownKey && hasSeq
    // Someone else's post, not a page's: PostRow adds the hosted check.
    const messageable = has('onMessage') && typeof ownKey === 'string' && hasSeq &&
      String(item.author).toLowerCase() !== ownKey.toLowerCase() && !(authorProfile && authorProfile.page === true)
    // The seeder's public page shows diary posts only. Chats, groups and
    // moments never come through here and are not kind 'post'; a page's diary
    // is told apart by its profile.
    const actingPage = actingPageKey()
    const actingOwn = actingPage !== null && String(item.author).toLowerCase() === actingPage
    const diaryPost = item.kind === 'post' && hasSeq && (!(authorProfile && authorProfile.page === true) || actingOwn)
    // A poll or an event shows for a page's post too: a page votes and
    // answers like a person. Only the public web link stays off for a page.
    const pollable = item.kind === 'post' && hasSeq
    const authorKey = String(item.author).toLowerCase()
    const postRef = diaryPost ? authorKey + ':' + item.seq : null
    const link = postRef !== null ? postLink(installationOrigin() || globalThis.location?.origin || null, postRef) : null
    // The member's own diary, or the acting Page's own posts (shared through
    // the page action): the writer refuses a person's post-share for any other
    // diary. Membro passes a repost's original with extra.repostedBy.
    const publishable = postRef !== null && typeof ownKey === 'string' && ((authorKey === ownKey.toLowerCase() && authorKey !== actingPage) || actingOwn) &&
      (extra.repostedBy === undefined || extra.repostedBy === null)
    return {
      author: item.author,
      name: who.name,
      username: who.username,
      avatar: who.avatar,
      at: item.at,
      text: item.text,
      replyToName: parentRef ? replyNameOf(parentProfile) : null,
      media: item.media || null,
      preview: item.preview || null,
      // A post only: the poll card asks the seeder and the own diary (a page's, its status).
      ...(pollable && Array.isArray(item.poll) ? { poll: item.poll } : {}),
      ...(pollable && item.event && typeof item.event === 'object' ? { event: item.event } : {}),
      persistMedia: item.author === ownKey || (follows !== null && follows.has(item.author)),
      now,
      quote,
      repostedBy: null,
      counts: eng && eng.counts.has(ref) ? eng.counts.get(ref) : null,
      liked: !!eng && eng.state.liked.has(ref),
      reposted: !!eng && eng.state.reposted.has(ref),
      pending: eng && eng.pending.has(ref) ? eng.pending.get(ref) : null,
      onOpen: hasSeq ? () => live.handlers.onOpenThread({ ref, seed: item }) : undefined,
      onOpenAuthor: () => live.handlers.onOpenMember(item.author, who),
      onOpenMention: has('onOpenMention') ? (u) => live.handlers.onOpenMention(u, { author: item.author, username: who.username }) : undefined,
      onOpenParent: parentRef ? () => live.handlers.onOpenThread({ ref: parentRef }) : undefined,
      onOpenReposter: undefined,
      onReply: hasSeq && has('onReply') ? () => live.handlers.onReply({ ref, name: who.name, username: who.username, text: item.text }) : undefined,
      onQuote: hasSeq && has('onQuote') ? () => live.handlers.onQuote({ ref, name: who.name, username: who.username, text: item.text }) : undefined,
      onOpenLikes: eng && hasSeq && has('onOpenEngagers') ? () => live.handlers.onOpenEngagers({ ref, kind: 'likes' }) : undefined,
      onOpenReposts: eng && hasSeq && has('onOpenEngagers') ? () => live.handlers.onOpenEngagers({ ref, kind: 'reposts' }) : undefined,
      onOpenQuotes: eng && hasSeq && has('onOpenQuotes') ? () => live.handlers.onOpenQuotes({ ref }) : undefined,
      onLike: eng && hasSeq ? () => live.eng.toggle('like', ref) : undefined,
      onRepost: eng && hasSeq ? () => live.eng.toggle('repost', ref) : undefined,
      onReport: reportable ? () => live.handlers.onReport({ author: item.author, name: who.name, username: who.username, seq: item.seq, text: item.text }) : undefined,
      onDelete: hasSeq && has('onDelete') && canDeleteHere(item, typeof ownKey === 'string' ? ownKey : null)
        ? () => live.handlers.onDelete({ ref, seq: item.seq })
        : undefined,
      seq: hasSeq ? item.seq : undefined,
      onMessage: messageable ? onMessage : undefined,
      // Before ...extra, so a link a caller passes (an offer's) keeps winning.
      link,
      publishable,
      onNotice: has('onNotice') ? (notice) => live.handlers.onNotice(notice) : undefined,
      ...extra
    }
  }
  const latest = { handlers, eng }
  if (!(cache instanceof Map) || typeof rowKey !== 'string') return build(latest)
  // Everything the props are derived from, by identity. Handlers are not
  // here (the live box carries them); only which are offered, since that
  // adds or removes a button.
  const counts = eng && eng.counts.has(ref) ? eng.counts.get(ref) : null
  const inputs = {
    item,
    now,
    ownKey,
    follows,
    eng: !!eng,
    // By value: a refetch answers with new objects for the same numbers.
    counts: counts !== null && typeof counts === 'object',
    replies: counts ? counts.replies : null,
    likes: counts ? counts.likes : null,
    reposts: counts ? counts.reposts : null,
    quotes: counts ? counts.quotes : null,
    liked: !!eng && eng.state.liked.has(ref),
    reposted: !!eng && eng.state.reposted.has(ref),
    pending: eng && eng.pending.has(ref) ? eng.pending.get(ref) : null,
    authorProfile,
    quoteOriginal: q,
    quoteProfile: qProfile,
    parentProfile,
    acting,
    origin,
    offers: offers.join(),
    ...Object.fromEntries(Object.entries(extra || {}).map(([k, v]) => ['extra.' + k, v]))
  }
  return cachedRow(cache, rowKey, inputs, latest, build)
}

// The rowProps cache of one list. Every render hands `latest` ({ handlers,
// eng }) to all cached rows, also those the list does not render again, so a
// tap never runs a handler of an older render; rows that left `keys` are
// dropped after the commit.
export function useThreadRowCache (keys, latest) {
  const cache = useRef(null)
  if (cache.current === null) cache.current = new Map()
  for (const row of cache.current.values()) Object.assign(row.live, latest)
  const joined = keys.join('\n')
  useEffect(() => {
    pruneRows(cache.current, joined === '' ? [] : joined.split('\n'))
  }, [joined])
  return cache.current
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
    preview: seed.preview && typeof seed.preview === 'object' ? seed.preview : null,
    ...(Array.isArray(seed.poll) ? { poll: seed.poll } : {}),
    ...(seed.event && typeof seed.event === 'object' ? { event: seed.event } : {}),
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

// The open rodas that get a 'Ver mais respostas' row: one with a next page,
// and one whose first load never landed (a delete or a lost connection
// dropped it), which would otherwise stay open and empty with nothing to tap.
function rodaMore ({ open, rodas, errors, busy }) {
  const more = new Map()
  for (const key of open) {
    if (errors.has(key)) continue
    const roda = rodas.get(key)
    if (roda && roda.loaded ? typeof roda.next === 'string' : !busy.has(key)) more.set(key, true)
  }
  return more
}

// The row the screen was opened for, once its root is known: { top, target,
// proven }, or null. The opener's focus is only its word, so it counts as
// unproven until the verified roda holds the target.
export function anchorOf (res, focusRef, focusTop) {
  if (!res || res.status !== 'ok') return null
  if (isRef(res.top) && isRef(res.target)) return { top: res.top, target: res.target, proven: res.proven === true }
  if (res.top === null && isRef(focusTop) && isRef(focusRef)) return { top: focusTop, target: focusRef, proven: false }
  return null
}

// Only posts just signed on this device enter this cache. Keyed the way the
// screen holds them: a comment under the root's ref, a reply under the ref of
// the comment whose roda holds it, so a deep own reply lands once, in its roda.
const ownReplyCache = new Map()
registerLocalCache({ wipe: () => ownReplyCache.clear() })

function cacheOwnReply (parentKey, item) {
  const items = withOwnReply(ownReplyCache.get(parentKey) || [], item)
  ownReplyCache.delete(parentKey)
  ownReplyCache.set(parentKey, items.slice(-20))
  while (ownReplyCache.size > 50) ownReplyCache.delete(ownReplyCache.keys().next().value)
}

function dropOwnReplies (cache, refs) {
  for (const [key, items] of cache) {
    const kept = items.filter((item) => !refs.has(refOf(item.author, item.seq)))
    if (kept.length) cache.set(key, kept)
    else cache.delete(key)
  }
}

// A Conversa kept open under a newer one never sees a deletion made above it:
// each mounted copy listens here and drops the post from its own lists.
const deletionListeners = new Set()

function announceDeleted (refs) {
  for (const listener of deletionListeners) listener(refs)
}

// Each mounted Conversa keeps its own copy of the replies it sent; a deletion
// anywhere (Diário, A Rua, another Conversa) must reach every copy, or a
// refresh merges the deleted reply back.
const ownReplyCopies = new Set()

function forgetOwnReplies (refs) {
  dropOwnReplies(ownReplyCache, refs)
  for (const own of ownReplyCopies) dropOwnReplies(own.current, refs)
}

function pruneOwnReplies (refs, own) {
  const listed = new Set(refs)
  dropOwnReplies(ownReplyCache, listed)
  dropOwnReplies(own, listed)
}

function ownFor (parentKey, own) {
  return (own.get(parentKey) || []).reduce(withOwnReply, ownReplyCache.get(parentKey) || [])
}

const refsOf = (items) => items.map((item) => refOf(item.author, item.seq))

// Comments already on screen keep their place: a later page only appends the
// ones not shown yet (the anchor comment, or an own one sent here).
function appendComments (shown, page) {
  const seen = new Set(refsOf(shown))
  return shown.concat(page.filter((item) => !seen.has(refOf(item.author, item.seq))))
}

// The comment whose roda holds `ref`: `ref` itself for a comment, null when
// it is not on screen.
function topOf (ref, comments, rodas) {
  if (comments.some((item) => refOf(item.author, item.seq) === ref)) return ref
  for (const [top, roda] of rodas) {
    if (roda.replies.some((item) => refOf(item.author, item.seq) === ref)) return top
  }
  return null
}

// No row inside the thread pushes another Conversa: the comment level is
// drawn by the list itself, and the quote above a reply says what it answers.
const THREAD_ROW = { onOpen: undefined, onOpenParent: undefined, replyToName: null }
// The tapped row before its thread is known keeps its chip, without the tap.
const SEED_ROW = { onOpen: undefined, onOpenParent: undefined }

const INITIAL = {
  phase: 'loading', // 'loading' | 'ready' | 'error'
  error: '',
  meta: null, // { indexing, complete } of the root
  resolved: null, // the resolveRoot result the thread was built from
  root: null, // the main post's ref
  status: null, // 'ok' | 'orphan' (the root answers a post that cannot be read)
  cut: false, // orphan: the climb stopped at its limit, not at a missing parent
  proven: false, // signed records tie the root to the target (resolveRoot, showAnchor)
  post: null,
  comments: [],
  unavailable: 0,
  next: null,
  loadingMore: false,
  moreError: '',
  refreshing: false
}

// One actions sheet for the whole list instead of two per row.
export default function Conversa (props) {
  return <PostSheetProvider><ConversaList {...props} /></PostSheetProvider>
}

function ConversaList ({ entry, ownKey, me, onBack, onReply, onQuote, onReport, onOpenThread, onOpenMember, onOpenMention, onOpenEngagers, onOpenQuotes, onToast, onDeletedPost, onMessage, composeSignal, onComposeSeen, onPublished }) {
  const styles = useStyles(makeStyles)
  const node = useNode()
  const names = useNames()
  const now = useVisibleNow(60000)
  const bottomPad = useBottomPad()
  const avoidKeyboard = useKeyboardAvoidEnabled()
  // A row under the reply bar is not seen, and measureInWindow reports
  // clipped rows unclipped, so the list tells its cards where the bar
  // starts. Measured on every check: the keyboard moves the bar.
  const barBox = useRef(null)
  const band = useMemo(() => ({
    measure: (done) => {
      const node = barBox.current
      if (node === null || typeof node.measureInWindow !== 'function') { done(null); return }
      node.measureInWindow((x, y, w, h) => done(Number.isFinite(y) && y > 0 && h > 0 ? y : null))
    }
  }), [])
  // The post the screen was opened for: any post of the thread.
  const focal = entry.key
  const seed = useMemo(() => seedItem(entry.params ? entry.params.seed : null, focal), [entry, focal])
  // focus { ref, top }: the opener already knows focal is the root. Only the
  // top's shape is taken here; the comment is placed only once its signed
  // replyTo is the root.
  const focus = entry.params && entry.params.focus && typeof entry.params.focus === 'object' ? entry.params.focus : null
  const focusTop = focus !== null && isRef(focus.top) ? focus.top : null
  const focusRef = focus !== null && isRef(focus.ref) ? focus.ref : null
  const seedIsRoot = seed !== null && (seed.replyTo === null || focus !== null)
  const full = !!node.hosted && node.online !== false
  const { request } = node
  const { learnMany, resolveMany } = names
  const eng = useEngagement({ request, node, onToast })
  const { follows, load: loadFollows } = useFollowSet(request)
  const [view, setView] = useState(INITIAL)
  const [open, setOpen] = useState(new Set())
  // comment ref -> { replies, waiting, mode, complete, total, next, loaded }
  const [rodas, setRodas] = useState(new Map())
  const [rodaErrors, setRodaErrors] = useState(new Map())
  const [rodaBusy, setRodaBusy] = useState(new Set())
  const [replyTarget, setReplyTarget] = useState(null)
  const [focusSignal, setFocusSignal] = useState(undefined)
  const [note, setNote] = useState('')
  const [sending, setSending] = useState(false)
  const sendingRef = useRef(false)
  // A page reply whose answer was lost: { retry, page, ref, text }.
  const pageRetryRef = useRef(null)
  // The bar's target ref now, for a send that settles after a change.
  const barTargetRef = useRef(null)
  const rodaRequests = useRef(new Map())
  // Bumped when the open rodas are dropped, so a page still in flight
  // cannot land in, or release, the roda that replaced it.
  const branchGen = useRef(0)
  const rodasRef = useRef(rodas)
  const putRodas = useCallback((next) => {
    rodasRef.current = next
    setRodas(next)
  }, [])
  // The first roda page resolveRoot already fetched, used once by its comment.
  const rodaSeed = useRef(null)
  const resolvedRef = useRef(null)
  // The anchor of the next ready load, shown once.
  const anchorRef = useRef(null)
  const listRef = useRef(null)
  const rowsRef = useRef([])
  const [flashKey, setFlashKey] = useState(null)
  const jumpTimer = useRef(null)
  const flashTimer = useRef(null)
  const pendingJump = useRef(null)
  const [jumpTick, setJumpTick] = useState(0)
  const scrollRef = useRef(null)
  const quotes = useRef(new Map())
  const ownReplies = useRef(new Map())
  useEffect(() => {
    ownReplyCopies.add(ownReplies)
    return () => { ownReplyCopies.delete(ownReplies) }
  }, [])
  const openRef = useRef(open)
  openRef.current = open
  const loadRodaRef = useRef(null)
  const replyDraft = useRef({ focal, text: '' })
  if (replyDraft.current.focal !== focal) replyDraft.current = { focal, text: '' }
  const sessionRef = useRef(0)
  const lastCompose = useRef(null)
  const viewRef = useRef(view)
  const peekedRef = useRef(new Map())
  const followsRef = useRef(Promise.resolve(new Set()))
  const genRef = useRef(0)
  const focalRef = useRef(focal)
  focalRef.current = focal
  const commit = useCallback((patch) => {
    viewRef.current = { ...viewRef.current, ...patch }
    setView(viewRef.current)
  }, [])

  useEffect(() => {
    sessionRef.current += 1
    setOpen(new Set())
    putRodas(new Map())
    setRodaBusy(new Set())
    setRodaErrors(new Map())
    rodaRequests.current.clear()
    branchGen.current += 1
    ownReplies.current.clear()
    resolvedRef.current = null
    rodaSeed.current = null
    anchorRef.current = null
    pendingJump.current = null
    clearTimeout(jumpTimer.current)
    clearTimeout(flashTimer.current)
    setFlashKey(null)
    quotes.current.clear()
    setReplyTarget(null)
    setFocusSignal(undefined)
    setNote('')
    return () => { sessionRef.current += 1 }
  }, [focal, putRodas])
  useEffect(() => () => {
    clearTimeout(jumpTimer.current)
    clearTimeout(flashTimer.current)
  }, [])

  const targetReply = useCallback((target) => {
    if (sendingRef.current) return
    setReplyTarget(target)
    setNote('')
    setFocusSignal((signal) => (signal || 0) + 1)
  }, [])
  // Waits for the root: until then the bar cannot tell a comment from a reply.
  const root = view.root
  useEffect(() => {
    if (full && root !== null && composeSignal && composeSignal !== lastCompose.current && composeSignal.target.ref === focal) {
      lastCompose.current = composeSignal
      targetReply(composeSignal.target)
      if (typeof onComposeSeen === 'function') onComposeSeen()
    }
  }, [composeSignal, focal, root, full, targetReply, onComposeSeen])

  const { readOwn, readCounts, setCount, reset } = eng
  const load = useCallback(async (refreshing = false) => {
    const mine = ++genRef.current
    const alive = () => mine === genRef.current
    let undoReset = null
    commit(refreshing ? { refreshing: true, error: '' } : { ...INITIAL })
    const failed = (reason) => commit({
      phase: refreshing && viewRef.current.phase === 'ready' ? 'ready' : 'error',
      refreshing: false,
      loadingMore: false,
      error: refreshing && viewRef.current.phase === 'ready' ? 'Não foi possível atualizar a conversa.' : reason === 'not-found' || reason === 'unavailable' ? 'Esta conversa não está disponível.' : 'Não foi possível abrir a conversa.'
    })
    try {
      const peeked = new Map()
      // No seed is passed: the root's own read costs nothing extra, since
      // its index answer and its peek are reused below, and a seed is only
      // what the feed showed.
      const read = async (refs, hints) => {
        await peekAll(request, planPeeks({ refs, authors: hints }), peeked, alive)
        return new Map(refs.map((ref) => [ref, postAt(peeked, ref)]))
      }
      const held = resolvedRef.current
      const fresh = held === null || held.focal !== focal
      let res = fresh ? await resolveRoot({ key: focal }, { fetchPost, fetchRoda, read }) : held.res
      if (!alive()) return
      // Read-only, so the first open tries once more after a lost connection.
      if (fresh && res.status === 'error' && (res.reason === 'network' || res.reason === 'timeout')) {
        await sleep(SEEDER_RETRY_MS)
        if (!alive()) return
        res = await resolveRoot({ key: focal }, { fetchPost, fetchRoda, read })
        if (!alive()) return
      }
      if (res.status !== 'ok' && res.status !== 'orphan') {
        failed(res.reason)
        return
      }
      if (fresh) resolvedRef.current = { focal, res }
      const rootRef = res.root
      let index = fresh && res.index ? res.index : null
      if (index === null) {
        let r = await fetchPost(rootRef)
        if (!alive()) return
        if (!r.ok && (r.reason === 'network' || r.reason === 'timeout')) {
          await sleep(SEEDER_RETRY_MS)
          if (!alive()) return
          r = await fetchPost(rootRef)
          if (!alive()) return
        }
        if (!r.ok) {
          failed(r.reason)
          return
        }
        index = r.value
      }
      const anchor = res.top || focusTop
      const extra = anchor !== null && anchor !== rootRef && !index.replies.includes(anchor) ? [anchor] : []
      const refs = [rootRef].concat(index.replies, extra)
      // engagement.read first: it preempts sync, so it goes before the peeks.
      if (refreshing) undoReset = reset()
      await readOwn(refs, alive)
      if (!alive()) return
      followsRef.current = loadFollows()
      const hints = { ...(fresh && res.page ? res.page.authors : {}), ...index.authors }
      await peekAll(request, planPeeks({ refs: refs.filter((ref) => postAt(peeked, ref) === null), authors: hints }), peeked, alive)
      if (!alive()) return
      const { parent, post, replies, unavailable } = assembleThread({ focal: rootRef, index, peeked })
      // The anchor's index page may come later: read now, placed only when
      // its signed replyTo is the root.
      const anchored = extra.length > 0 ? postAt(peeked, anchor) : null
      const page = anchored !== null && anchored.replyTo && refOf(anchored.replyTo.author, anchored.replyTo.seq) === rootRef ? replies.concat([anchored]) : replies
      const followSet = await followsRef.current
      if (!alive()) return
      // Only an own post whose signed replyTo is the root is a comment: the
      // cache key can be a comment that is now an orphan's top-most message.
      const ownComments = ownFor(rootRef, ownReplies.current).filter((item) => !!item.replyTo && refOf(item.replyTo.author, item.replyTo.seq) === rootRef)
      await peekAll(request, await quotePlan([post].concat(page, ownComments), peeked, knownAuthors({ ownKey, follows: followSet, hinted: index.authors, peeked }), alive), peeked, alive)
      if (!alive()) return
      peekedRef.current = peeked
      learnPeeked(learnMany, peeked)
      resolveMany([...new Set([post].concat(page).filter(Boolean).flatMap((i) => i.quote ? [i.author, i.quote.author] : [i.author]))])
      if (refreshing) {
        putRodas(new Map())
        setRodaErrors(new Map())
        rodaRequests.current.clear()
        branchGen.current += 1
        setRodaBusy(new Set())
        // A page from before the refresh never paints a roda opened after it.
        rodaSeed.current = null
      }
      pruneOwnReplies(index.replies, ownReplies.current)
      const comments = withAnchor(commentOrder(ownComments.reduce(withOwnReply, page), { follows: followSet, ownKey }), anchor)
      // The action bar is the only place the screen shows the count, so it
      // keeps the floor the old header had: an own comment the index has not
      // counted yet still shows.
      setCount(rootRef, { replies: Math.max(index.repliesTotal, comments.length), likes: index.likes, reposts: index.reposts, quotes: index.quotesTotal })
      // A refresh keeps an unconfirmed root unconfirmed: its check runs again.
      if (!refreshing || viewRef.current.proven !== true) anchorRef.current = anchorOf(res, focusRef, focusTop)
      commit({
        phase: 'ready',
        error: '',
        refreshing: false,
        meta: { indexing: index.indexing, complete: index.complete },
        resolved: res,
        root: rootRef,
        status: res.status,
        cut: res.cut === true,
        proven: res.status === 'orphan' || res.proven === true,
        post,
        comments,
        // The root's own parent is the orphan note, not an unavailable comment.
        unavailable: unavailable - (index.parent && !parent ? 1 : 0),
        next: index.next,
        loadingMore: false,
        moreError: ''
      })
      if (fresh && res.top && res.page) rodaSeed.current = { top: res.top, page: res.page }
      if (refreshing) for (const key of openRef.current) loadRodaRef.current(key)
      readCounts(refsOf(comments), alive)
    } catch (err) {
      if (!alive()) return
      if (undoReset) undoReset()
      commit({ phase: refreshing && viewRef.current.phase === 'ready' ? 'ready' : 'error', refreshing: false, loadingMore: false, error: refreshing && viewRef.current.phase === 'ready' ? 'Não foi possível atualizar a conversa.' : isSeederDown(err) ? 'Sem conexão com o servidor agora.' : errorText(err) })
    }
  }, [focal, focusRef, focusTop, request, commit, putRodas, readOwn, readCounts, setCount, reset, loadFollows, learnMany, resolveMany, ownKey])

  const loadMore = useCallback(async () => {
    const current = viewRef.current
    if (current.phase !== 'ready' || current.loadingMore || current.refreshing || current.next === null || current.root === null) return
    const mine = genRef.current
    const alive = () => mine === genRef.current
    commit({ loadingMore: true, moreError: '' })
    try {
      const res = await fetchPost(current.root, current.next)
      if (!alive()) return
      if (!res.ok) {
        commit({ loadingMore: false, moreError: 'Não foi possível carregar mais comentários.' })
        return
      }
      const index = res.value
      await readOwn(index.replies, alive)
      if (!alive()) return
      const peeked = peekedRef.current
      await peekAll(request, planPeeks({ refs: index.replies, authors: index.authors }), peeked, alive)
      if (!alive()) return
      // The parent was counted with the first page.
      const page = assembleThread({ focal: current.root, index: { ...index, parent: null }, peeked })
      const followSet = await followsRef.current
      if (!alive()) return
      await peekAll(request, await quotePlan(page.replies, peeked, knownAuthors({ ownKey, follows: followSet, hinted: index.authors, peeked }), alive), peeked, alive)
      if (!alive()) return
      learnPeeked(learnMany, peeked)
      resolveMany([...new Set(page.replies.flatMap((i) => i.quote ? [i.author, i.quote.author] : [i.author]))])
      pruneOwnReplies(index.replies, ownReplies.current)
      const before = viewRef.current.comments
      const comments = appendComments(before, commentOrder(page.replies, { follows: followSet, ownKey }))
      commit({
        comments,
        unavailable: viewRef.current.unavailable + page.unavailable,
        next: index.next === current.next ? null : index.next,
        meta: { indexing: index.indexing, complete: index.complete },
        loadingMore: false
      })
      readCounts(refsOf(comments.slice(before.length)), alive)
    } catch (err) {
      if (alive()) commit({ loadingMore: false, moreError: isSeederDown(err) ? 'Sem conexão com o servidor agora.' : errorText(err) })
    }
  }, [request, commit, readOwn, readCounts, learnMany, resolveMany, ownKey])

  // One page of the roda of comment `top`. A seeder without /index/roda
  // (404, 'not-found') gives the comment's direct replies only, paged by its
  // post index: no walk down from here. Every row passes assembleRoda first.
  // -> { next } once the page landed, null when it did not (failed, stale or
  // already in flight), for seekTarget.
  const loadRoda = async (top, cursor = null) => {
    const mine = genRef.current
    const branch = branchGen.current
    const held = rodaRequests.current.get(top)
    if (!full || (held && held.mine === mine && held.branch === branch)) return null
    const token = { mine, branch }
    rodaRequests.current.set(top, token)
    setRodaBusy((previous) => new Set(previous).add(top))
    setRodaErrors((previous) => {
      const next = new Map(previous)
      next.delete(top)
      return next
    })
    const alive = () => mine === genRef.current && branch === branchGen.current
    try {
      const prior = rodasRef.current.get(top)
      let mode = prior && prior.loaded ? prior.mode : 'roda'
      let page = null
      if (mode === 'roda') {
        const seeded = cursor === null && rodaSeed.current !== null && rodaSeed.current.top === top ? rodaSeed.current.page : null
        if (seeded !== null) rodaSeed.current = null
        const res = seeded !== null ? { ok: true, value: seeded } : await fetchRoda(top, cursor)
        if (!alive()) return null
        if (res.ok && res.value.top === top) page = { items: res.value.items.map((it) => it.ref), authors: res.value.authors, next: res.value.next, total: res.value.total, complete: res.value.complete }
        // Another top: the seeder sees this comment deeper in a thread whose
        // start this screen could not reach. Its direct replies still show.
        else if (cursor === null && (res.ok || res.reason === 'not-found')) mode = 'direct'
        else throw new Error(RODA_ERROR)
      }
      if (mode === 'direct') {
        const res = await fetchPost(top, cursor)
        if (!alive()) return null
        if (!res.ok) throw new Error(RODA_ERROR)
        page = { items: res.value.replies, authors: res.value.authors, next: res.value.next, total: res.value.repliesTotal, complete: res.value.complete }
      }
      await readOwn(page.items, alive)
      if (!alive()) return null
      const peeked = peekedRef.current
      await peekAll(request, planPeeks({ refs: page.items, authors: page.authors }), peeked, alive)
      if (!alive()) return null
      const next = page.next === cursor ? null : page.next
      const before = rodasRef.current.get(top)
      const out = assembleRoda({
        top,
        index: { items: page.items },
        peeked,
        held: before ? before.replies : [],
        own: ownFor(top, ownReplies.current),
        waiting: before ? before.waiting : [],
        last: next === null
      })
      const followSet = await followsRef.current
      if (!alive()) return null
      await peekAll(request, await quotePlan(out.replies, peeked, knownAuthors({ ownKey, follows: followSet, hinted: page.authors, peeked }), alive), peeked, alive)
      if (!alive()) return null
      learnPeeked(learnMany, peeked)
      // Rows from earlier pages already had their names and counts asked.
      const shownBefore = new Set(refsOf(before ? before.replies : []))
      const added = out.replies.filter((item) => !shownBefore.has(refOf(item.author, item.seq)))
      resolveMany([...new Set(added.flatMap((item) => item.quote ? [item.author, item.quote.author] : [item.author]))])
      pruneOwnReplies(page.items, ownReplies.current)
      // Read again: a reply sent during the quote peeks joined the roda after `before`.
      const latest = rodasRef.current.get(top)
      const known = new Set(refsOf((before ? before.replies : []).concat(out.replies)))
      const sent = latest ? latest.replies.filter((item) => !known.has(refOf(item.author, item.seq))) : []
      putRodas(new Map(rodasRef.current).set(top, {
        replies: out.replies.concat(sent),
        waiting: out.waiting,
        mode,
        complete: page.complete,
        total: page.total,
        next,
        loaded: true
      }))
      readCounts(refsOf(added), alive)
      return { next }
    } catch (err) {
      // The cursor that failed: the retry asks for the same page.
      if (alive()) setRodaErrors((previous) => new Map(previous).set(top, { text: errorText(err), cursor }))
      return null
    } finally {
      if (rodaRequests.current.get(top) === token) {
        rodaRequests.current.delete(top)
        setRodaBusy((previous) => {
          const next = new Set(previous)
          next.delete(top)
          return next
        })
      }
    }
  }

  loadRodaRef.current = loadRoda

  const toggleRoda = (row) => {
    const top = refOf(row.parent.author, row.parent.seq)
    setOpen((previous) => {
      const next = new Set(previous)
      if (row.open) next.delete(top)
      else next.add(top)
      return next
    })
    const roda = rodasRef.current.get(top)
    if (!row.open && !(roda && roda.loaded)) loadRoda(top)
  }

  // Opens the roda holding the anchor and pages it (seekTarget) until the
  // target shows, then scrolls to it; not found, the roda stays open with its
  // 'Ver mais respostas'. A target no verified roda holds, under an unproven
  // root, gets its own signed climb: a seeder can pair a post with an
  // unrelated conversation. Until one of them confirms it, an unproven root
  // is never left on screen as the target's conversation.
  const showAnchor = async (anchor) => {
    const { top, target, proven } = anchor
    const mine = genRef.current
    const session = sessionRef.current
    const alive = () => mine === genRef.current
    // A load or a delete meanwhile ended this run without a verdict: the next
    // ready load runs the check again.
    const stale = () => {
      if (!proven && sessionRef.current === session && anchorRef.current === null) anchorRef.current = anchor
    }
    const held = (ref) => {
      const roda = rodasRef.current.get(top)
      return !!roda && roda.replies.some((item) => refOf(item.author, item.seq) === ref)
    }
    const confirm = () => {
      const kept = resolvedRef.current
      if (kept && kept.focal === focal && kept.res) resolvedRef.current = { focal, res: { ...kept.res, proven: true } }
      commit({ proven: true })
    }
    const dropRodas = () => {
      setOpen(new Set())
      putRodas(new Map())
      setRodaErrors(new Map())
      setRodaBusy(new Set())
      rodaRequests.current.clear()
      branchGen.current += 1
      rodaSeed.current = null
    }
    // A roda shows only under its comment, and the comment only once its signed replyTo is the root.
    const shown = viewRef.current.comments.some((item) => refOf(item.author, item.seq) === top)
    let found = false
    if (!shown) found = false
    else if (target === top) found = true
    else {
      setOpen((previous) => new Set(previous).add(top))
      // Its first page is the one resolveRoot fetched, when it gave one.
      const first = await loadRoda(top)
      if (!alive()) return stale()
      found = held(target)
      if (!found && first !== null && first.next !== null) {
        const seek = await seekTarget({ target, cursor: first.next, maxPages: SEEK_PAGES }, { loadPage: (cursor) => loadRoda(top, cursor), has: held })
        if (!alive()) return stale()
        found = seek.found
      }
    }
    if (found) {
      if (!proven) confirm()
      pendingJump.current = (target === top ? 'comment:' : 'reply:') + target
      setJumpTick((tick) => tick + 1)
      return
    }
    if (proven) return
    const peeked = peekedRef.current
    const read = async (refs, hints) => {
      await peekAll(request, planPeeks({ refs, authors: hints }), peeked, alive)
      return new Map(refs.map((ref) => [ref, postAt(peeked, ref)]))
    }
    const climbed = await resolveRoot({ key: target, climbOnly: true }, { fetchPost, fetchRoda, read })
    if (!alive()) return stale()
    if (climbed.status === 'error') {
      // The climb is read-only, but it is not repeated here: the error's own
      // retry opens the post again from the start, check included.
      resolvedRef.current = null
      dropRodas()
      commit({ ...INITIAL, phase: 'error', error: climbed.reason === 'not-found' || climbed.reason === 'unavailable' ? 'Esta conversa não está disponível.' : 'Não foi possível abrir a conversa.' })
      return
    }
    if (climbed.status === 'ok' && climbed.root === viewRef.current.root) return confirm()
    // A climb cut at its hop limit still ends at a signed ancestor of the
    // target: when that is the comment, or a row its verified roda holds, the
    // target is under the root shown, and the cut view would only lose it.
    if (climbed.status === 'orphan' && climbed.cut === true && shown && (climbed.root === top || held(climbed.root))) return confirm()
    // Its signed chain leads to another conversation: that one is shown.
    resolvedRef.current = { focal, res: climbed }
    dropRodas()
    load(false)
  }

  useEffect(() => {
    if (full) load(false)
    else loadFollows()
    return () => { genRef.current += 1 }
  }, [full, load, loadFollows])
  // After the ready view rendered, so the roda it opens starts from that view.
  useEffect(() => {
    if (view.phase !== 'ready' || view.refreshing || anchorRef.current === null) return
    const anchor = anchorRef.current
    anchorRef.current = null
    showAnchor(anchor)
  }, [view])
  // After the render that holds the anchor's rows: an index read sooner misses them.
  useEffect(() => {
    const key = pendingJump.current
    if (key === null) return
    pendingJump.current = null
    if (typeof scrollRef.current === 'function') scrollRef.current(key, true)
  }, [jumpTick])

  // Drops a deleted post from this screen's own copies (the comments, the
  // open rodas, the replies sent from here) and lowers its parent's count.
  // Runs for a deletion made here and, through announceDeleted, for one made
  // on another screen above this one in the stack, which would otherwise
  // show the reply until a reload. Nothing found here means nothing to do.
  const dropDeleted = useRef(null)
  dropDeleted.current = (ref, force = false) => {
    const cur = viewRef.current
    const gone = (item) => refOf(item.author, item.seq) === ref
    const [author, seqText] = ref.split(':')
    const known = peekedRef.current.get(author)
    // A quote of the deleted post must not keep showing its text.
    const quoted = !!known && known.entries.some((e) => e.seq === Number(seqText))
    const wasComment = cur.comments.some(gone)
    const held = [...rodasRef.current.values()].some((roda) => roda.replies.some(gone)) || [...ownReplies.current.values()].some((items) => items.some(gone))
    if (!force && !held && !quoted && !wasComment) return
    // A load started before the deletion would bring the row back.
    genRef.current += 1
    if (known) peekedRef.current.set(author, { ...known, entries: known.entries.filter((e) => e.seq !== Number(seqText)) })
    const deleted = cur.comments.find(gone) || [...rodasRef.current.values()].flatMap((roda) => roda.replies).find(gone) || [...ownReplies.current.values()].flat().find(gone) || null
    let parentKey = null
    let remaining = 0
    if (deleted !== null && deleted.replyTo) {
      parentKey = refOf(deleted.replyTo.author, deleted.replyTo.seq)
      const count = eng.counts.get(parentKey)
      remaining = Math.max(0, (count && Number.isSafeInteger(count.replies) ? count.replies : 0) - 1)
      setCount(parentKey, { ...count, replies: remaining })
    }
    const kept = new Map()
    const emptied = []
    for (const [top, roda] of rodasRef.current) {
      // A deleted comment takes its roda with it.
      if (top === ref) continue
      if (!roda.replies.some(gone)) {
        kept.set(top, roda)
        continue
      }
      // Its replies leave too, as on the server (removePost drops the
      // deleted post's edges): the gate keeps only rows still chained to top.
      const replies = assembleRoda({ top, held: roda.replies.filter((item) => !gone(item)) }).replies
      const total = Number.isSafeInteger(roda.total) ? Math.max(0, roda.total - (roda.replies.length - replies.length)) : roda.total
      kept.set(top, { ...roda, replies, total })
      const direct = parentKey === top ? remaining : (eng.counts.get(top) && Number.isSafeInteger(eng.counts.get(top).replies) ? eng.counts.get(top).replies : 0)
      if (replies.length === 0 && direct === 0) emptied.push(top)
    }
    putRodas(kept)
    if (emptied.length > 0) {
      setOpen((previous) => {
        const next = new Set(previous)
        for (const top of emptied) next.delete(top)
        return next
      })
    }
    for (const [key, items] of ownReplyCache) ownReplyCache.set(key, items.filter((item) => !gone(item)))
    ownReplies.current = new Map([...ownReplies.current].map(([key, items]) => [key, items.filter((item) => !gone(item))]))
    commit({
      comments: cur.comments.filter((item) => !gone(item)),
      // The loads invalidated above never clear their own flags.
      loadingMore: false,
      refreshing: false
    })
  }
  useEffect(() => {
    // The main post of an older screen (its root once known) is left to its own flow.
    const listener = (refs) => { for (const ref of refs) if (ref !== (viewRef.current.root || focalRef.current)) dropDeleted.current(ref) }
    deletionListeners.add(listener)
    return () => { deletionListeners.delete(listener) }
  }, [])
  const del = useDelete({
    request,
    node,
    onToast,
    recheck: () => load(true),
    onUncertain: (target) => dropOwnReplies(ownReplies.current, new Set([target.ref])),
    onDeleted: async (t) => {
      // Drops the result of a load started before the delete: it would bring the row back.
      genRef.current += 1
      if (typeof onDeletedPost === 'function') onDeletedPost()
      // Cached photos of the deleted post go too, wherever they were shown.
      revokeDeletedMedia(request, [t.seq])
      const cur = viewRef.current
      if (t.ref === (cur.root || focal)) {
        onBack()
        return
      }
      dropDeleted.current(t.ref, true)
    }
  })
  const handlers = { onOpenThread, onOpenMember, onOpenMention, onOpenEngagers, onOpenQuotes, onReply: full ? targetReply : onReply, onQuote, onReport, onDelete: del.offered ? del.ask : undefined, onMessage, onNotice: onToast }
  const props = (item, extra, rowKey) => rowProps({ item, names, peeked: peekedRef.current, now, ownKey, follows, eng: full ? eng : null, handlers, extra, cache: rowKey === undefined ? undefined : rowCache, rowKey })
  // Before the offline return: hooks run on every render.
  const shownRodas = useMemo(() => new Map([...rodas].map(([key, roda]) => [key, rodaOrder(roda.replies, key)])), [rodas])
  const rows = commentRows({
    comments: view.comments,
    rodas: shownRodas,
    open,
    counts: eng.counts,
    totals: new Map([...rodas].filter(([, roda]) => roda.loaded && Number.isSafeInteger(roda.total)).map(([key, roda]) => [key, roda.total])),
    more: rodaMore({ open, rodas, errors: rodaErrors, busy: rodaBusy }),
    errors: rodaErrors,
    // An orphan's top-most message is not the post's author.
    postAuthor: view.post && view.status === 'ok' ? view.post.author : null
  })
  const rowCache = useThreadRowCache(rows.map((row) => row.key), { handlers, eng: full ? eng : null })
  // One renderItem for the list's life: the cells re-render on extraData, and
  // the post rows whose cached props did not change skip their render.
  const renderRef = useRef(null)
  const renderItem = useCallback(({ item: row }) => renderRef.current(row), [])
  const extra = useMemo(() => ({ eng, follows, now, rodas, rodaBusy, rodaErrors, flashKey, sending, styles, profileOf: names.profileOf }), [eng, follows, now, rodas, rodaBusy, rodaErrors, flashKey, sending, styles, names.profileOf])
  // Acting as a page, the bar shows the page: the reply is published as it.
  const barActing = useActing()
  const barPageKey = barActing.kind === 'page' ? barActing.key : null
  useEffect(() => { if (barPageKey !== null) resolveMany([barPageKey]) }, [barPageKey, resolveMany])
  const barPage = barPageKey === null ? null : names.profileOf(barPageKey)
  const barPageName = barPageKey === null ? '' : displayText((barPage && (barPage.name || barPage.username)) || barActing.name || barActing.username || 'Página').trim()
  const barPageAvatar = barPage ? barPage.avatar : undefined
  // A note about one target or identity goes when either changes; a held page
  // retry stays keyed to its page, target and text.
  const noteTargetRef = replyTarget ? replyTarget.ref : null
  useEffect(() => { setNote('') }, [noteTargetRef, barPageKey])
  const barMe = useMemo(() => (barPageKey === null
    ? me
    : { name: barPageName, publicKey: barPageKey, picture: barPageAvatar }), [barPageKey, barPageName, barPageAvatar, me])

  const title = 'Comentários'
  const top = <TopBar title={title} onBack={onBack} />

  // A send in flight keeps the thread and its bar mounted: a bar remounted
  // when the connection returns would bring the sent text back.
  if (!full && !sending) {
    return (
      <View style={styles.flex}>
        {top}
        <DeletePrompt del={del} />
        <OfflineNote />
        <View style={styles.flex}>
          {seed
            ? seed.replyTo
              ? <PostRow {...props(seed, SEED_ROW)} level='comment' />
              : <PostRow {...props(seed, SEED_ROW)} level='post' expanded />
            : null}
          <View style={styles.note}><Soft>{node.hosted ? OFFLINE_NOTE : NOT_HOSTED_NOTE}</Soft></View>
        </View>
      </View>
    )
  }

  const { phase, error, meta, status, comments, unavailable, next, loadingMore, moreError, refreshing } = view
  const post = view.post || (phase !== 'ready' && seedIsRoot ? seed : null)
  const rootKey = root || (seedIsRoot ? focal : null)
  // An unconfirmed root is not where a reply goes by default; a row tapped
  // for a reply is signed and checked on its own.
  const rootTarget = rootKey === null || (root !== null && view.proven !== true) ? null : { ref: rootKey, ...(post ? identityOf(names, post.author, post) : {}), text: post ? post.text : '' }
  const target = replyTarget || rootTarget
  const toRoot = target !== null && target.ref === rootKey
  barTargetRef.current = target !== null ? target.ref : null
  const barPlaceholder = barPageKey !== null ? (toRoot ? 'Comente como ' : 'Responda como ') + barPageName : (toRoot ? 'Escreva um comentário' : undefined)
  const expandReply = async (draft, target = replyTarget || rootTarget, attach) => {
    if (typeof onReply !== 'function' || !target) return false
    // Publicar signs a new reply: only this bar resends the held bytes.
    if (heldRetry(actingPageKey(), target.ref, draft) !== null) setNote(RESEND_NOTE)
    const accepted = await onReply(attach ? { ...target, draft, attach } : { ...target, draft })
    if (accepted === true && replyDraft.current.focal === focal && replyDraft.current.text === draft) replyDraft.current.text = ''
    return accepted
  }
  const sendReply = async (text) => {
    if (sendingRef.current || !target) return false
    const refusal = refusalOf(text)
    // The identity can change while the service answers: this send stays the page it started as.
    const pageKey = actingPageKey()
    const plan = quickReplyPlan({ text, nodeReady: full, actingAsPage: pageKey !== null, hasLink: hasLink(text), refusal })
    if (plan.kind === 'empty') return false
    // A page reply whose answer was lost keeps its signed bytes: the same
    // text, target and page resend them (once per tap). Anything else signs
    // anew, and the held bytes stay until a different reply is sent or they
    // settle: a refusal, Publicar or a failure before signing keeps them.
    const resend = heldRetry(pageKey, target.ref, text)
    const heldAt = resend !== null ? pageRetryRef.current.at : Date.now()
    // Bytes held past the nonce's life can no longer be resent: they are
    // dropped and the person is asked to check the conversation first. The
    // next tap with the same text signs anew.
    if (resend === null && heldStale(pageKey, target.ref, text)) {
      pageRetryRef.current = null
      setNote(MAYBE_SENT_NOTE)
      return false
    }
    if (plan.kind === 'refuse') {
      setNote(refusal)
      return false
    }
    if (plan.kind === 'expand') return expandReply(text, target)
    sendingRef.current = true
    setSending(true)
    setNote('')
    const session = sessionRef.current
    const cacheEpoch = cacheGeneration()
    const at = new Date().toISOString()
    // Where the reply will show, decided now: the view may change meanwhile.
    // A deep message no loaded roda holds: the comment resolveRoot found for
    // it, when shown; else none, and the reply shows once its roda loads.
    const shownView = viewRef.current
    const resolvedTop = shownView.resolved && shownView.resolved.status === 'ok' && shownView.resolved.target === target.ref ? shownView.resolved.top : null
    const holder = toRoot
      ? target.ref
      : topOf(target.ref, shownView.comments, rodasRef.current) || (resolvedTop !== null && shownView.comments.some((c) => refOf(c.author, c.seq) === resolvedTop) ? resolvedTop : null)
    try {
      let result
      if (plan.kind === 'send-page') {
        // memberKeyOf throws before any signature: same note path as a refused send.
        try {
          if (resend !== null) {
            result = await sendPageTextReply({ retry: resend, page: pageKey, text, replyTo: target.ref })
          } else {
            const member = await memberKeyOf(node.request, node)
            result = await sendPageTextReply({
              act: (op) => actAs(nodeOf(node), { member, action: 'reply', page: pageKey, op }),
              page: pageKey,
              text,
              replyTo: target.ref
            })
          }
          // The optimistic row shows the page's name and photo once the cache has them.
          if (result.ok) resolveMany([pageKey])
        } catch (error) {
          result = { ok: false, ref: null, error }
        }
        if (typeof result.retry === 'function') pageRetryRef.current = { retry: result.retry, page: pageKey, ref: target.ref, text, at: heldAt }
        else if (resend !== null) pageRetryRef.current = null
      } else {
        result = await sendTextReply({ request, text, replyTo: target.ref })
      }
      const sent = result.ok ? parseRef(result.ref) : null
      const item = sent ? { kind: 'post', ...sent, at, text, replyTo: parseRef(target.ref), ...identityOf(names, sent.author) } : null
      if (item && holder !== null && cacheEpoch === cacheGeneration()) cacheOwnReply(holder, item)
      if (result.ok && replyDraft.current.focal === focal && replyDraft.current.text === text) replyDraft.current.text = ''
      if (result.ok && typeof onPublished === 'function') onPublished('quick-reply', target.ref)
      if (session !== sessionRef.current) return result.ok
      // A page has no outbox gate: a refusal stays on the bar.
      if (pageKey === null && result.gated) return expandReply(text, target)
      if (!result.ok) {
        setNote(result.refused || (result.error && result.error.uncertain === true
          ? (typeof result.retry === 'function' && actingPageKey() === pageKey && barTargetRef.current === target.ref
              ? RESEND_NOTE
              : MAYBE_SENT_NOTE)
          : errorText(result.error)))
        return false
      }
      if (holder !== null) ownReplies.current = mergeChildren(ownReplies.current, holder, [item])
      // An own comment goes first, as own comments do in each page.
      if (toRoot) {
        commit({ comments: [item].concat(viewRef.current.comments) })
      } else if (holder !== null) {
        const roda = rodasRef.current.get(holder)
        putRodas(new Map(rodasRef.current).set(holder, roda
          ? { ...roda, replies: roda.replies.concat([item]) }
          : { replies: [item], waiting: [], mode: 'roda', complete: true, total: null, next: null, loaded: false }))
        setOpen((previous) => new Set(previous).add(holder))
        if (!roda || !roda.loaded) loadRoda(holder)
      }
      const count = eng.counts.get(target.ref)
      setCount(target.ref, { ...count, replies: (count && Number.isSafeInteger(count.replies) ? count.replies : 0) + 1 })
      return true
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }
  const heldFor = (page, ref, text) => {
    const held = pageRetryRef.current
    return held !== null && page !== null && held.page === page && held.ref === ref && held.text === text ? held : null
  }
  // The held retry for this page, target and text while its nonce lives.
  const heldRetry = (page, ref, text) => {
    const held = heldFor(page, ref, text)
    return held !== null && Date.now() - held.at < HELD_RETRY_MS ? held.retry : null
  }
  const heldStale = (page, ref, text) => {
    const held = heldFor(page, ref, text)
    return held !== null && Date.now() - held.at >= HELD_RETRY_MS
  }
  // Same pattern as the chat's quote jump (Mensagem.js): scrollToIndex
  // throws for a row it cannot place, and the first offset can be an
  // estimate, so it is tried again after a moment before the flash. `quiet`:
  // the anchor, whose miss leaves the roda open with nothing announced.
  const scrollToKey = (key, quiet = false) => {
    clearTimeout(jumpTimer.current)
    clearTimeout(flashTimer.current)
    setFlashKey(null)
    const missing = () => {
      if (quiet) return
      AccessibilityInfo.announceForAccessibility(OUTSIDE_NOTE)
      if (typeof onToast === 'function') onToast(OUTSIDE_NOTE)
    }
    const start = rowsRef.current.findIndex((row) => row.key === key)
    const list = listRef.current
    if (start < 0 || !list || typeof list.scrollToIndex !== 'function') return missing()
    // Brings the last row the list can place into view, so the cells after it mount.
    const towardEnd = (below) => {
      for (let at = below - 1; at >= 0; at--) {
        try {
          list.scrollToIndex({ index: at, animated: false, viewPosition: 1 })
          return
        } catch {}
      }
    }
    const jump = (index, tries) => {
      try {
        list.scrollToIndex({ index, animated: false, viewPosition: 0.5 })
      } catch {
        // The anchor's row lands in the same commit as its jump, before the
        // list measured it: tried again a few times before a quiet miss.
        if (!quiet || tries >= ANCHOR_TRIES) return missing()
        towardEnd(index)
        jumpTimer.current = setTimeout(() => {
          if (listRef.current !== list) return
          const again = rowsRef.current.findIndex((row) => row.key === key)
          if (again < 0) return missing()
          jump(again, tries + 1)
        }, JUMP_RETRY_MS)
        return
      }
      jumpTimer.current = setTimeout(() => {
        if (listRef.current !== list) return
        // A page can land in between and shift the index.
        const at = rowsRef.current.findIndex((row) => row.key === key)
        if (at < 0) return missing()
        try {
          list.scrollToIndex({ index: at, animated: false, viewPosition: 0.5 })
          setFlashKey(key)
          flashTimer.current = setTimeout(() => setFlashKey(null), FLASH_MS)
        } catch {
          missing()
        }
      }, JUMP_RETRY_MS)
    }
    jump(start, 1)
  }
  rowsRef.current = rows
  scrollRef.current = scrollToKey
  const swipeOff = (item) => !full || sending || !canSwipeReply(item)
  const swipeTo = (item) => () => {
    const who = identityOf(names, item.author, item)
    targetReply({ ref: refOf(item.author, item.seq), name: who.name, username: who.username, text: item.text })
  }
  const flashOf = (row) => flashKey === row.key ? <View pointerEvents='none' style={styles.flash} /> : null
  // PostRow is memoized: the same quote keeps the same object across renders,
  // and its tap reads the latest scroll helper through scrollRef.
  const quoteOf = (row) => {
    const q = row.quote
    if (!q) return undefined
    const name = q.missing ? null : whoOf(identityOf(names, q.author, q)).title
    const text = q.missing ? MISSING_QUOTE : q.text
    const senderKey = q.missing ? undefined : q.author
    const ref = q.ref
    const held = quotes.current.get(row.key)
    if (held && held.name === name && held.text === text && held.senderKey === senderKey && held.ref === ref) return held
    // A quote never answers the comment itself (rodaQuote), so it is a reply row.
    const value = { name, text, senderKey, ref, onPress: () => scrollRef.current('reply:' + ref) }
    quotes.current.set(row.key, value)
    return value
  }
  renderRef.current = (row) => {
    if (row.kind === 'toggle') {
      const key = refOf(row.parent.author, row.parent.seq)
      return <View style={styles.branchAction}><BranchLink label={row.label} expanded={row.open} onPress={() => toggleRoda(row)} pending={rodaBusy.has(key)} /></View>
    }
    if (row.kind === 'more' || row.kind === 'error') {
      const key = refOf(row.parent.author, row.parent.seq)
      const failure = rodaErrors.get(key)
      return (
        <View style={[styles.child, styles.branchAction, row.kind === 'error' && styles.branchError]}>
          {row.kind === 'error'
            ? <><ErrorText>{displayText(failure ? failure.text : RODA_ERROR)}</ErrorText><BranchLink label='Tentar de novo' onPress={() => loadRoda(key, failure ? failure.cursor : null)} pending={rodaBusy.has(key)} /></>
            : <BranchLink label='Ver mais respostas' onPress={() => loadRoda(key, rodas.has(key) && rodas.get(key).loaded ? rodas.get(key).next : null)} pending={rodaBusy.has(key)} />}
        </View>
      )
    }
    const tag = row.isAuthor ? AUTHOR_TAG : undefined
    // The reply icon stays: the swipe is a shortcut, never the only way.
    if (row.kind === 'reply') {
      return (
        <View style={styles.child}>
          <SwipeReply disabled={swipeOff(row.item)} onReply={swipeTo(row.item)}>
            <View style={styles.rowBox}>
              <PostRow {...props(row.item, THREAD_ROW, row.key)} level='reply' tag={tag} replyQuote={quoteOf(row)} />
              {flashOf(row)}
            </View>
          </SwipeReply>
        </View>
      )
    }
    return (
      <SwipeReply disabled={swipeOff(row.item)} onReply={swipeTo(row.item)}>
        <View style={styles.rowBox}>
          <PostRow {...props(row.item, THREAD_ROW, row.key)} level='comment' tag={tag} />
          {flashOf(row)}
        </View>
      </SwipeReply>
    )
  }
  // A roda the seeder cut, or direct replies only (a seeder without
  // /index/roda) where one of them has replies of its own.
  const rodaGaps = [...rodas].some(([, roda]) => roda.loaded && (roda.complete === false || (roda.mode === 'direct' && roda.replies.some((item) => {
    const count = eng.counts.get(refOf(item.author, item.seq))
    return !!count && Number.isSafeInteger(count.replies) && count.replies > 0
  }))))
  const notes = []
  if (phase === 'ready' && !view.post) notes.push('Esta publicação não pôde ser verificada agora.')
  if (error && phase === 'ready') notes.push(error)
  if (phase === 'ready' && status === 'orphan') notes.push(view.cut ? CUT_NOTE : PARENT_GONE_NOTE)
  if (meta && meta.indexing) notes.push('Ainda montando a conversa completa…')
  else if ((meta && meta.complete === false) || rodaGaps) notes.push('Algumas respostas podem faltar.')
  if (unavailable > 0) notes.push(unavailable === 1 ? '1 comentário indisponível' : String(unavailable) + ' comentários indisponíveis')

  const header = (
    <View style={styles.header}>
      {post && (phase !== 'ready' || status === 'ok')
        ? (
          <View style={styles.focal}>
            <PostRow expanded level='post' {...props(post, THREAD_ROW)} />
            {/* After the row: PostRow paints an opaque bg, and later siblings paint on top. */}
            <View pointerEvents='none' style={styles.accentBar} />
          </View>
          )
        : null}
      {/* The top-most message that could be read, with its replies under it. */}
      {post && phase === 'ready' && status === 'orphan'
        ? <PostRow level='comment' {...props(post, THREAD_ROW)} />
        : null}
      {/* A reply tapped in a feed: its thread's main post is still on its way. */}
      {phase !== 'ready' && seed && !seedIsRoot
        ? (
          <>
            {phase === 'loading' ? <Skeleton rows={1} /> : null}
            <PostRow level='comment' {...props(seed, SEED_ROW)} />
          </>
          )
        : null}
      {phase === 'error'
        ? <ErrorState message={displayText(error)} onRetry={() => load(false)} />
        : null}
      {/* The count is not repeated here: the main post's action bar shows it. */}
      {phase === 'ready' && notes.length > 0
        ? (
          <View style={styles.repliesHead}>
            {notes.map((n) => <Soft key={n}>{n}</Soft>)}
          </View>
          )
        : null}
    </View>
  )

  // The screen pads for the keyboard, as Mensagem and Grupo do: padding on a
  // view whose height follows its content would count the keyboard twice.
  return (
    <KeyboardAvoidingView style={styles.flex} behavior='padding' enabled={avoidKeyboard}>
      {top}
      <DeletePrompt del={del} />
      <OfflineNote />
      <View style={styles.flex}>
        <EmbedBandBottom.Provider value={full || sending ? band : null}>
          <RefreshableList
            perfId='conversa'
            data={phase === 'ready' ? rows : []}
            keyExtractor={(row) => row.key}
            renderItem={renderItem}
            extraData={extra}
            listRef={listRef}
            ListHeaderComponent={header}
            ListEmptyComponent={phase === 'loading' ? <Skeleton /> : null}
            ListFooterComponent={phase === 'ready'
              ? (
                <ListFooter
                  loading={loadingMore}
                  atEnd={next === null && comments.length > 0}
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
        </EmbedBandBottom.Provider>
      </View>
      {/* Kept through a send that outlives the connection, so its own
          success clears the text instead of a remounted copy. */}
      {full || sending
        ? (
          <ReplyDock barBox={barBox} style={styles.barWrap}>
            <ReplyBar
              key={focal}
              target={target}
              draft={replyDraft.current.text}
              onDraftChange={(text) => { if (replyDraft.current.focal === focal) replyDraft.current.text = text }}
              onSend={sendReply}
              onExpand={expandReply}
              onAttach={(draft) => expandReply(draft, undefined, 'photo')}
              me={barMe}
              nonFocalTarget={replyTarget !== null && !toRoot}
              placeholder={barPlaceholder}
              sendLabel={toRoot ? 'Comentar' : undefined}
              onClearTarget={() => { if (!sendingRef.current) setReplyTarget(null) }}
              busy={sending}
              disabled={!target || (!post && !replyTarget)}
              note={note}
              focusSignal={focusSignal}
            />
          </ReplyDock>
          )
        : null}
    </KeyboardAvoidingView>
  )
}

// The reply bar's wrapper owns the keyboard state, so opening or closing the
// keyboard renders the bar, not the thread list.
// The open keyboard already covers the gesture bar: its inset would leave a
// band between the bar and the keyboard. The page background shows around
// the floating pill, so the padding keeps it off the edges.
export function ReplyDock ({ barBox, style, children }) {
  const insets = useSafeAreaInsets()
  const keyboardOpen = useKeyboardOpen()
  return (
    <View ref={barBox} collapsable={false} style={[style, { paddingBottom: keyboardOpen ? 8 : Math.max(8, insets.bottom) }]}>
      {children}
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  barWrap: { backgroundColor: colors.bg, paddingHorizontal: space.md, paddingTop: space.sm },
  note: { paddingHorizontal: 16, paddingVertical: 12 },
  prompt: { paddingHorizontal: 16, paddingVertical: 12, gap: 8 },
  child: { marginLeft: space.xl, borderLeftWidth: 1, borderLeftColor: colors.line },
  // 68 is the post text column (PostRow padding 16 + avatar 40 + gap 12). No vertical padding: the 44 pt box of the link is the row.
  branchAction: { paddingLeft: 68, paddingRight: space.lg, alignItems: 'flex-start' },
  branchError: { paddingTop: space.sm },
  header: { position: 'relative' },
  focal: { position: 'relative' },
  accentBar: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, backgroundColor: colors.accent },
  rowBox: { position: 'relative' },
  // Over the row: PostRow paints an opaque bg, so a tint under it would not show.
  flash: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, backgroundColor: colors.accent, opacity: 0.12 },
  repliesHead: { paddingHorizontal: 16, paddingVertical: 12, gap: 4, borderBottomWidth: 1, borderBottomColor: colors.line }
})
