// The roda (conversation circle) of one comment: every reply of that
// comment's whole subtree, shown flat under it with a quote of the message
// each deeper reply answers. Pure module: no React, react-native or Node
// built-ins.
//
// Trust: the /index/roda page (indexClient.js fetchRoda) only says which refs
// to peek. Its `to` field, its `top` and its order are never read here. An
// item joins only when its verified record (thread.js lookupPost, the same
// item shape as the rest of the thread) is a post whose SIGNED replyTo is the
// top comment or a reply that already joined. A reply the seeder put in a
// roda it does not belong to never chains to top, so it cannot show.
//
// Layout: two levels only. Level 0 is a comment on the post, level 1 is a
// reply in its roda. No row opens another thread.

import { lookupPost, parseRef, target } from './thread.js'
import { childLabel, compareAtSeq } from './threadRows.js'
import { isAuthorKey } from './nav.js'
import { musicRefOf } from './music.js'

// Neutral on purpose: the root may be a person of any gender or a page.
export const AUTHOR_TAG = 'quem publicou'

const isPlain = (o) => !!o && typeof o === 'object' && !Array.isArray(o)
const isSeq = (n) => Number.isSafeInteger(n) && n >= 1
const isCount = (n) => Number.isSafeInteger(n) && n >= 0

function refOf (item) {
  if (!isPlain(item) || !isAuthorKey(item.author) || !isSeq(item.seq)) return null
  return item.author + ':' + item.seq
}

function parentRefOf (item) {
  if (!isPlain(item)) return null
  const to = target(item.replyTo)
  return to === null ? null : to.author + ':' + to.seq
}

function canonical (ref) {
  const r = typeof ref === 'string' ? parseRef(ref) : null
  return r === null ? null : r.author + ':' + r.seq
}

function read (box, key) {
  if (box instanceof Map) return box.has(key) ? box.get(key) : undefined
  if (box instanceof Set) return box.has(key) ? true : undefined
  if (!isPlain(box)) return undefined
  return Object.prototype.hasOwnProperty.call(box, key) ? box[key] : undefined
}

function listOf (value) {
  if (Array.isArray(value)) return value
  if (value instanceof Map) return [...value.values()]
  return []
}

// A reply item kept for the gate: a post with an author, a seq and a signed
// parent. Anything else can never chain.
function candidate (item) {
  if (!isPlain(item) || item.kind !== 'post') return null
  const ref = refOf(item)
  const parent = parentRefOf(item)
  return ref === null || parent === null ? null : { ref, parent, item }
}

// The seeder's scan bound for one roda: more replies than that can never be
// waiting for a parent, so the rest are counted, not kept.
export const RODA_WAIT_MAX = 1000

// -> { replies, waiting, unavailable }
// - replies: every item of the roda known after this pass (held, own and the
//   page), unordered; pass it to rodaOrder, then back as `held` next time.
// - waiting: verified replies whose signed parent has not joined yet (it may
//   be on a later page, or outside this roda). Pass them back as `waiting`
//   with the next page so they join once their parent does. At most
//   RODA_WAIT_MAX; empty when `last`.
// - unavailable: listed refs with no verified post that answers anything,
//   plus waiting replies past RODA_WAIT_MAX and, on the last page, every
//   reply still waiting: no later page can bring its parent.
// held: items accepted earlier. They go through the same gate, so a held
// reply whose parent the screen dropped (deleted) leaves with it, as on the
// server. own: replies this device just sent, which the index may not list
// yet. last: the page had no `next`. Never throws on malformed input.
export function assembleRoda ({ top, index, peeked, held, own, waiting, last = false } = {}) {
  const topRef = canonical(top)
  if (topRef === null) return { replies: [], waiting: [], unavailable: 0 }
  const pool = new Map()
  const heldRefs = new Set()
  for (const item of listOf(held)) {
    const c = candidate(item)
    if (c === null || c.ref === topRef || pool.has(c.ref)) continue
    pool.set(c.ref, c)
    heldRefs.add(c.ref)
  }
  for (const item of [...listOf(own), ...listOf(waiting)]) {
    const c = candidate(item)
    if (c === null || c.ref === topRef || pool.has(c.ref)) continue
    pool.set(c.ref, c)
  }
  let unavailable = 0
  const listed = new Set()
  const items = isPlain(index) && Array.isArray(index.items) ? index.items : []
  for (const entry of items) {
    const ref = typeof entry === 'string' ? entry : isPlain(entry) ? entry.ref : null
    if (typeof ref !== 'string' || listed.has(ref)) continue
    listed.add(ref)
    const c = candidate(lookupPost(peeked, ref))
    if (c === null) {
      // A failed re-peek of a reply already kept from an earlier pass: that
      // copy still counts as shown or waiting, so counting it here too would
      // count it twice.
      const key = canonical(ref)
      if (key === null || !pool.has(key)) unavailable++
      continue
    }
    if (c.ref === topRef) {
      unavailable++
      continue
    }
    // The fresh peek carries the current name and username.
    pool.set(c.ref, c)
    heldRefs.delete(c.ref)
  }
  const children = new Map()
  for (const c of pool.values()) {
    if (!children.has(c.parent)) children.set(c.parent, [])
    children.get(c.parent).push(c.ref)
  }
  // Walk down from top over signed links: each ref is visited once, so a
  // cycle (refs are predictable, two diaries can answer each other's future
  // posts) never joins and the walk ends.
  const joined = new Set([topRef])
  const queue = [topRef]
  for (let i = 0; i < queue.length; i++) {
    for (const child of children.get(queue[i]) || []) {
      if (joined.has(child)) continue
      joined.add(child)
      queue.push(child)
    }
  }
  const replies = []
  const left = []
  for (const c of pool.values()) {
    if (joined.has(c.ref)) replies.push(c.item)
    else if (!heldRefs.has(c.ref)) left.push(c.item)
  }
  const keep = last ? 0 : Math.min(left.length, RODA_WAIT_MAX)
  unavailable += left.length - keep
  return { replies, waiting: left.slice(0, keep), unavailable }
}

// The seeder's instant (engagement-index.js atMillis): unparseable or not
// after the epoch counts as 0.
function atMs (item) {
  const ms = isPlain(item) && typeof item.at === 'string' ? Date.parse(item.at) : NaN
  return Number.isFinite(ms) && ms > 0 ? ms : 0
}

// The seeder's order (engagement-index.js roda), on signed data: a direct
// reply to top at its own instant, a deeper one at max(instant, parent + 1),
// then author, then seq. A parent therefore always comes before its children,
// even under a skewed clock, and the order is the page order of /index/roda,
// so an appended page never moves a row already shown.
// One exception: a reply just sent from this device (own) sits at its real
// instant, near now, before the index lists it, so a later page can still
// bring older replies that sort above it. Pinning it would break the
// seeder's order once the index lists it.
export function rodaOrder (replies, top) {
  const topRef = canonical(top)
  const byRef = new Map()
  for (const item of Array.isArray(replies) ? replies : []) {
    const ref = refOf(item)
    if (ref === null || ref === topRef || byRef.has(ref)) continue
    byRef.set(ref, item)
  }
  const eff = new Map()
  for (const ref of byRef.keys()) {
    if (eff.has(ref)) continue
    // Climb to the nearest ancestor already known (or top, or a link that
    // leaves the set), then fill in on the way back down.
    const path = []
    const onPath = new Set()
    let cur = ref
    let base
    for (;;) {
      if (eff.has(cur)) {
        base = eff.get(cur)
        break
      }
      if (onPath.has(cur)) {
        base = undefined
        break
      }
      path.push(cur)
      onPath.add(cur)
      const parent = parentRefOf(byRef.get(cur))
      if (parent === null || parent === topRef || !byRef.has(parent)) {
        base = undefined
        break
      }
      cur = parent
    }
    for (let i = path.length - 1; i >= 0; i--) {
      const own = atMs(byRef.get(path[i]))
      const value = base === undefined ? own : Math.max(own, base + 1)
      eff.set(path[i], value)
      base = value
    }
  }
  return [...byRef.entries()]
    .map(([ref, item]) => ({ key: eff.get(ref), item }))
    .sort((a, b) => {
      if (a.key !== b.key) return a.key < b.key ? -1 : 1
      if (a.item.author !== b.item.author) return a.item.author < b.item.author ? -1 : 1
      return a.item.seq - b.item.seq
    })
    .map((entry) => entry.item)
}

// The quote above a reply in a roda: null when it answers the top comment
// itself, else the answered message, or { ref, missing: true } when that
// message is not loaded (deleted, or on a page not fetched yet). name and
// text are the peer's raw strings: ui/ReplyPreview passes both through
// displayText.
export function rodaQuote (item, topRef, byRef) {
  const parent = parentRefOf(item)
  if (parent === null) return null
  const top = canonical(topRef)
  if (parent === top) return null
  const answered = read(byRef, parent)
  if (!isPlain(answered) || refOf(answered) !== parent) return { ref: parent, missing: true }
  return {
    ref: parent,
    author: answered.author,
    name: typeof answered.name === 'string' ? answered.name : null,
    username: typeof answered.username === 'string' ? answered.username : null,
    text: typeof answered.text === 'string' ? answered.text : ''
  }
}

function hasKey (set, key) {
  if (set instanceof Set || set instanceof Map) return set.has(key)
  if (Array.isArray(set)) return set.includes(key)
  return isPlain(set) && Object.prototype.hasOwnProperty.call(set, key) && !!set[key]
}

// One loaded page of comments: own and followed authors first, then the
// rest, each group oldest first. Only one page at a time: the screen appends
// pages, so a later page never reorders comments already on screen.
export function commentOrder (page, { follows, ownKey } = {}) {
  const near = []
  const rest = []
  const seen = new Set()
  for (const item of Array.isArray(page) ? page : []) {
    const ref = refOf(item)
    if (ref === null || seen.has(ref)) continue
    seen.add(ref)
    if (item.author === ownKey || hasKey(follows, item.author)) near.push(item)
    else rest.push(item)
  }
  return [...near.sort(compareAtSeq), ...rest.sort(compareAtSeq)]
}

// The comment a link pointed at goes first, even when its index page comes
// later; the list is unchanged when it is not there.
export function withAnchor (comments, anchorRef) {
  const list = Array.isArray(comments) ? comments : []
  const key = canonical(anchorRef)
  if (key === null) return list.slice()
  const i = list.findIndex((item) => refOf(item) === key)
  if (i <= 0) return list.slice()
  return [list[i], ...list.slice(0, i), ...list.slice(i + 1)]
}

// n: the roda's total once it was loaded. Before that, the screen only knows
// the comment's direct reply count from /index/counts, a floor: deeper
// replies are not in it.
export function rodaLabel (n, open) {
  return childLabel(n, open)
}

// A counts entry: a number or { replies }. flagged: present but unusable.
function countOf (counts, key) {
  const value = read(counts, key)
  if (value === undefined) return { n: null, flagged: false }
  if (isCount(value)) return { n: value, flagged: true }
  if (isPlain(value) && isCount(value.replies)) return { n: value.replies, flagged: true }
  return { n: null, flagged: true }
}

// Flat rows for the comment list: 'comment' (depth 0), then, for a comment
// with replies, a 'toggle'; when its roda is open, its 'reply' rows (depth 1,
// each with its quote), a 'more' row when the roda has a next page and an
// 'error' row when its last load failed. Never a deeper level.
// comments: ordered comment items. rodas: comment ref -> ordered replies
// (rodaOrder). open, more, errors: comment ref -> true. counts: /index/counts
// entries. totals: comment ref -> roda total from /index/roda. postAuthor:
// the root's author key, for isAuthor.
// A reply being sent has no seq yet, so pending comes from the screen
// and never from the loaded comments or rodas.
export function commentRows ({ comments, rodas, open, counts, totals, more, errors, postAuthor, pending } = {}) {
  const rows = []
  const seen = new Set()
  const isAuthor = (item) => isAuthorKey(postAuthor) && item.author === postAuthor
  const pendingItem = isPlain(pending) && typeof pending.id === 'string' && pending.id !== '' &&
    isPlain(pending.item) && pending.item.kind === 'post' && isAuthorKey(pending.item.author) && pending.item.seq === undefined
    ? pending.item
    : null
  const pendingToRoot = pendingItem !== null && pending.toRoot === true
  const pendingHolder = pendingItem !== null && !pendingToRoot ? canonical(pending.holder) : null
  if (pendingToRoot) {
    rows.push({ kind: 'comment', item: pendingItem, depth: 0, isAuthor: isAuthor(pendingItem), pending: true, key: 'comment:pending:' + pending.id })
  }
  for (const comment of Array.isArray(comments) ? comments : []) {
    const ref = refOf(comment)
    if (ref === null || seen.has(ref)) continue
    seen.add(ref)
    rows.push({ kind: 'comment', item: comment, depth: 0, isAuthor: isAuthor(comment), key: 'comment:' + ref })
    const replies = Array.isArray(read(rodas, ref)) ? read(rodas, ref) : []
    const isOpen = read(open, ref) === true
    const total = read(totals, ref)
    const direct = countOf(counts, ref)
    const known = isCount(total) ? total : direct.n
    // A reply sent here may be held before the index counts it.
    const n = known === null ? null : Math.max(known, replies.length)
    if (isOpen || replies.length > 0 || (n !== null && n > 0) || (n === null && direct.flagged)) {
      rows.push({ kind: 'toggle', parent: comment, count: n, open: isOpen, label: rodaLabel(n, isOpen), key: 'toggle:' + ref })
    }
    const byRef = isOpen ? new Map([[ref, comment]]) : null
    if (byRef !== null) {
      for (const reply of replies) {
        const r = refOf(reply)
        if (r !== null && !byRef.has(r)) byRef.set(r, reply)
      }
      for (const reply of replies) {
        const r = refOf(reply)
        if (r === null || seen.has(r)) continue
        seen.add(r)
        rows.push({
          kind: 'reply',
          item: reply,
          parent: comment,
          depth: 1,
          quote: rodaQuote(reply, ref, byRef),
          isAuthor: isAuthor(reply),
          key: 'reply:' + r
        })
      }
    }
    if (ref === pendingHolder) {
      const quote = byRef === null ? null : rodaQuote(pendingItem, ref, byRef)
      rows.push({
        kind: 'reply',
        item: pendingItem,
        parent: comment,
        depth: 1,
        quote: quote?.missing === true ? null : quote,
        isAuthor: isAuthor(pendingItem),
        pending: true,
        key: 'reply:pending:' + pending.id
      })
    }
    if (!isOpen) continue
    if (read(more, ref) === true) rows.push({ kind: 'more', parent: comment, key: 'more:' + ref })
    if (read(errors, ref)) rows.push({ kind: 'error', parent: comment, key: 'error:' + ref })
  }
  return rows
}

// Swipe to reply stays off where the row's own content takes horizontal
// drags: the carousel of 2 or more media is a horizontal pager
// (ui/MediaCarousel.js), and the music player's scrubber is a PanResponder
// that never refuses termination (ui/MusicPlayerCard.js, which PostRow draws
// for a post without media whose link carries a music ref). A
// row without a seq is still being sent and has nothing to answer.
export function canSwipeReply (item) {
  if (!isPlain(item) || !isSeq(item.seq)) return false
  const media = Array.isArray(item.media) ? item.media.length : 0
  if (media >= 2) return false
  if (media === 0 && isPlain(item.preview) && musicRefOf(item.preview.url) !== null) return false
  return true
}
