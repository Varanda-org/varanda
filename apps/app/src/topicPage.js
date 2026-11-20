// Pure model of the Assunto page (the posts under one hashtag). Same trust
// model as topics.js: an index hit from a seeder is only a pointer. A post is
// shown only after the node verified it against the author's signed log AND
// that verified text carries the tag (the injected hasTag), so a seeder that
// forges or pads hits can only make a ref count against the page, never put a
// post under a tag the author did not write. No React, no platform module,
// and hasTag is a parameter so this file does not depend on hashtags.js.

import { foldText, isLastSearchPage, mergeRefs, MAX_FUTURE_MS } from './topics.js'
import { assembleMember, parseRef, planPeeks } from './thread.js'

// A tag may need several index pages before one verified post shows up (a
// seeder can pad pages with hits that do not verify), but one user action
// never reads more than this many.
export const MAX_INDEX_PAGES = 3

// Nor does it peek more than this many refs across those pages: the same work
// as one Busca page, so a padded index cannot turn one tap into many reads.
export const MAX_ACTION_PEEKS = 30

// The tag token rule. Same pattern as TAG_RE in hashtags.js and TAG in
// nav.js; keep the three in step.
const TOKEN = /^[a-z0-9]{2,32}$/

// { token, path } for a tag typed or tapped with or without one '#', or null
// when the rest does not fold to exactly one token. Nothing is split or
// trimmed away, so 'a b ceu' or 'x#ceu' never open the page for 'ceu'.
export function topicPath (tag) {
  if (typeof tag !== 'string') return null
  const token = foldText(tag.startsWith('#') ? tag.slice(1) : tag)
  return TOKEN.test(token) ? { token, path: token } : null
}

export function initialTopic () {
  return { refs: [], items: [], missing: 0, rejected: 0, next: null, cursors: [], atEnd: false, pages: 0, peeks: 0, indexing: false, complete: true, stuck: false }
}

// A new user action ("ver mais", or a retry after a failure) gets a fresh
// budget and keeps the list. A refresh must pass initialTopic() instead, or
// it would continue from the old cursor.
export function beginAction (state) {
  return { ...state, pages: 0, peeks: 0 }
}

// The refs of one index page this action judges: the new ones, in index
// order, up to what is left of the action's peek budget. `cut` when some new
// ref did not fit, so the page must be read again by the next action. Refs
// already judged on an earlier page are left out: foldPage does not count
// them again, so peeking them would only cost requests.
function pageRefs (page, state) {
  const known = new Set(state && Array.isArray(state.refs) ? state.refs : [])
  const used = state && Number.isInteger(state.peeks) && state.peeks > 0 ? state.peeks : 0
  const room = Math.max(0, MAX_ACTION_PEEKS - used)
  const refs = []
  const taken = new Set()
  for (const ref of page && Array.isArray(page.items) ? page.items : []) {
    if (known.has(ref) || taken.has(ref) || parseRef(ref) === null) continue
    if (refs.length >= room) return { refs, cut: true }
    taken.add(ref)
    refs.push(ref)
  }
  return { refs, cut: false }
}

// diary.peek params for one index page (a fetched topic value), within the
// action's peek budget (see pageRefs).
export function planTopicPeeks (page, state) {
  return planPeeks({ refs: pageRefs(page, state).refs, authors: page && page.authors })
}

// The page without the refs of authors the member blocked, so they are
// neither peeked nor counted as missing.
export function dropBlocked (page, isBlocked) {
  if (!page || typeof page !== 'object' || !Array.isArray(page.items) || typeof isBlocked !== 'function') return page
  return {
    ...page,
    items: page.items.filter((ref) => {
      const r = parseRef(ref)
      return r === null || !isBlocked(r.author)
    })
  }
}

const itemKey = (item) => item.author + ':' + item.seq

// Newest first by the post's own signed date, then author, then seq, so equal
// dates order the same on every device. A date ahead of `now` counts as now,
// so claiming a later date within the 24 h skew allowance buys no rank over
// other posts dated now or ahead.
export function sortItems (items, now) {
  const clock = typeof now === 'number' && Number.isFinite(now) ? now : Date.now()
  const at = new Map(items.map((i) => [i, Math.min(Date.parse(i.at), clock)]))
  return items.slice().sort((a, b) => {
    const d = at.get(b) - at.get(a)
    if (d !== 0) return d
    if (a.author !== b.author) return a.author < b.author ? -1 : 1
    return a.seq - b.seq
  })
}

function verifies (hasTag, item, token) {
  try {
    return hasTag(item.text, token) === true
  } catch {
    return false
  }
}

// What the refs of one page become: the shown items, `missing` (no verified
// record came back for the ref: unreadable, gone or malformed, so something
// real may be absent) and `rejected` (verified, but not a post, without the
// tag or dated in the future: the index was wrong, nothing is absent). Never
// throws.
export function assembleTopic ({ refs, peeked, token, hasTag, now } = {}) {
  const items = []
  let missing = 0
  let rejected = 0
  const clock = typeof now === 'number' && Number.isFinite(now) ? now : Date.now()
  try {
    const usable = typeof hasTag === 'function' && typeof token === 'string' && TOKEN.test(token)
    const byAuthor = new Map()
    const seen = new Set()
    for (const ref of Array.isArray(refs) ? refs : []) {
      const r = parseRef(ref)
      if (r === null || seen.has(ref)) continue
      seen.add(ref)
      if (!byAuthor.has(r.author)) byAuthor.set(r.author, [])
      byAuthor.get(r.author).push(r.seq)
    }
    for (const [author, seqs] of byAuthor) {
      const wanted = new Set(seqs)
      const { items: built } = assembleMember({ author, index: { posts: seqs }, peeked })
      const shown = new Set()
      for (const item of built) {
        if (item.author !== author || !wanted.has(item.seq)) continue
        shown.add(item.seq)
        // A verified repost is not a post: the index was wrong, nothing is absent.
        if (item.kind !== 'post') {
          rejected += 1
          continue
        }
        const at = Date.parse(item.at)
        if (!usable || !verifies(hasTag, item, token) || !Number.isFinite(at) || at - clock > MAX_FUTURE_MS) {
          rejected += 1
          continue
        }
        items.push(item)
      }
      missing += seqs.length - shown.size
    }
  } catch {
    return { items, missing, rejected }
  }
  return { items: sortItems(items, clock), missing, rejected }
}

// Folds one index page (a fetched topic value) and its peeked map into the
// state. Refs read before are not counted twice. Only a null cursor ends the
// list: an empty or fully rejected page with a cursor does not. A cursor
// already requested (A, A or A, B, A) ends it too, as a failure (`stuck`),
// never a loop. A page cut by the peek budget folds only the refs that fit
// and keeps `next` at its own cursor, so the next action reads it again and
// judges the rest.
export function foldPage (state, { page, peeked, token, hasTag, now, cursor } = {}) {
  const prev = state || initialTopic()
  const listed = Array.isArray(page && page.items) ? page.items : []
  const { refs: fresh, cut } = pageRefs(page, prev)
  const clock = typeof now === 'number' && Number.isFinite(now) ? now : Date.now()
  const got = assembleTopic({ refs: fresh, peeked, token, hasTag, now: clock })
  const have = new Set(prev.items.map(itemKey))
  const added = got.items.filter((item) => !have.has(itemKey(item)))
  const cursors = Array.isArray(prev.cursors) ? prev.cursors : []
  const requested = typeof cursor === 'string' && !cursors.includes(cursor) ? cursors.concat(cursor) : cursors
  const stuck = !cut && page.next !== null && requested.includes(page.next)
  return {
    refs: mergeRefs(prev.refs, cut ? fresh : listed).refs,
    items: sortItems(prev.items.concat(added), clock),
    missing: prev.missing + got.missing,
    rejected: prev.rejected + got.rejected,
    next: cut ? prev.next : page.next,
    cursors: requested,
    atEnd: !cut && (isLastSearchPage(page) || stuck),
    pages: prev.pages + 1,
    peeks: (Number.isInteger(prev.peeks) ? prev.peeks : 0) + fresh.length,
    indexing: page.indexing === true,
    complete: prev.complete && page.complete === true,
    stuck: prev.stuck || stuck
  }
}

// True when the list may lack posts: the seeder says it is partial or still
// indexing, a listed post could not be read, or the cursor looped. Posts the
// index listed wrongly (`rejected`) do not make it incomplete.
export function isIncomplete (state) {
  return state.complete !== true || state.indexing === true || state.missing > 0 || state.stuck === true
}

// Another action can read more: only a null cursor ends the list, however
// many pages this action already used.
export function hasMore (state) {
  return state.atEnd !== true
}

// Runs one user action: up to MAX_INDEX_PAGES index pages and
// MAX_ACTION_PEEKS peeked refs, stopping at the end of the list, when a page
// added a post (the screen shows it right away) or on an error. `readPage(cursor, state)` -> { ok: true, page, peeked }
// with the page fetched and its new refs peeked (planTopicPeeks(page, state)),
// or { ok: false, reason }. A superseded
// action (`alive()` false) returns null. -> { state, error } where `error` is
// null or the failed read's reason; the state keeps every page already
// folded, with `next` still the cursor of the page that failed.
export async function runAction ({ state, readPage, token, hasTag, now, alive } = {}) {
  let current = beginAction(state || initialTopic())
  const live = typeof alive === 'function' ? alive : () => true
  while (!current.atEnd && current.pages < MAX_INDEX_PAGES && current.peeks < MAX_ACTION_PEEKS) {
    const cursor = current.next
    let res
    try {
      res = await readPage(cursor, current)
    } catch {
      res = { ok: false, reason: 'error' }
    }
    if (!live()) return null
    if (!res || res.ok !== true) return { state: current, error: res && res.reason ? res.reason : 'error' }
    // A malformed page is a failed read, so foldPage never sees it.
    if (!res.page || typeof res.page !== 'object' || (res.page.next !== null && typeof res.page.next !== 'string')) return { state: current, error: 'error' }
    const before = current.items.length
    current = foldPage(current, { page: res.page, peeked: res.peeked, token, hasTag, now: typeof now === 'function' ? now() : now, cursor })
    if (current.items.length > before) break
  }
  return { state: current, error: null }
}

// A refresh that failed before folding any page: the screen keeps the list it
// already shows and only reports the error, as Busca does.
export function refreshFailed (fresh, out) {
  return fresh === true && out !== null && typeof out === 'object' && !!out.error && !!out.state && out.state.pages === 0
}
