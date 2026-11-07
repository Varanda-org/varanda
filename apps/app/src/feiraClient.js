// Feira reads on the hosted app: the seeder's Feira index (indexClient.js)
// says where to look, the node proves what is there. Pure ES module: no
// React, no platform module, no Node built-ins; `request(method, params)` is
// the node's RPC call, passed in.
//
// Trust model: an index item is a hint { ref, status, statusSeq, editSeq }.
// A listing is shown only after diary.peek returned the root as a `listing`
// record of that author, and the hinted edit and status blocks as records
// about exactly that root. A ref whose block is no listing root is dropped
// (a lying or confused index); a hinted edit or status that cannot be proven
// drops the listing too, because showing the root would show content or a
// status the seller already replaced. What the index leaves out (a newer
// edit or status it does not name) stays the seeder's claim, as on the
// public page. Ratings are verified by the node (listing.ratings): only the
// rows it returns are shown.

import rpc from '@varanda/rpc'
import { fetchFeira, fetchFeiraAuthor, fetchFeiraRatings } from './indexClient.js'
import { diaryPeekSlots } from './engagement.js'
import { listingView } from './feira.js'

const { feira } = rpc

// docs/rpc.md 5.27 PEEK_SEQS_MAX and 5.106 refs.
export const PEEK_SEQS_MAX = 32
export const RATINGS_REFS_MAX = 32

const HEX64 = /^[0-9a-f]{64}$/
const isSeq = (n) => Number.isSafeInteger(n) && n >= 1

function refParts (ref) {
  const i = typeof ref === 'string' ? ref.indexOf(':') : -1
  if (i < 0) return null
  const author = ref.slice(0, i)
  const seq = Number(ref.slice(i + 1))
  return HEX64.test(author) && isSeq(seq) ? { author, seq } : null
}

// The seqs one item needs: its root and the hinted edit and status blocks.
function seqsOf (item) {
  const out = [item.seq]
  if (item.editSeq !== null) out.push(item.editSeq)
  if (item.statusSeq !== null) out.push(item.statusSeq)
  return out
}

// -> [{ author, seqs, profileSeq?, usernameSeq? }], each call <= 32 seqs,
// strictly ascending, every item's seqs in one call. The name hints ride on
// the author's first call only.
export function planPeeks (items, authors = {}) {
  const byAuthor = new Map()
  for (const item of items) {
    if (!byAuthor.has(item.author)) byAuthor.set(item.author, [])
    byAuthor.get(item.author).push(item)
  }
  const plan = []
  for (const [author, list] of byAuthor) {
    let seqs = new Set()
    let first = true
    const flush = () => {
      if (seqs.size === 0) return
      const params = { author, seqs: [...seqs].sort((a, b) => a - b) }
      const h = authors[author]
      if (first && h) {
        if (isSeq(h.profileSeq)) params.profileSeq = h.profileSeq
        if (isSeq(h.usernameSeq)) params.usernameSeq = h.usernameSeq
      }
      first = false
      plan.push(params)
      seqs = new Set()
    }
    for (const item of list) {
      const need = seqsOf(item).filter((s) => !seqs.has(s))
      if (seqs.size + need.length > PEEK_SEQS_MAX) flush()
      for (const s of seqsOf(item)) seqs.add(s)
    }
    flush()
  }
  return plan
}

// The record diary.peek returned at exactly `seq`, or why there is none:
// 'invalid' (a block that failed validRecordCopy: never a listing) or
// 'missing' (not read: a transient failure, a cleared block, the deadline).
function lookup (peek, seq) {
  if (peek) {
    for (const e of peek.entries) if (e && e.seq === seq && e.record && typeof e.record === 'object') return { record: e.record }
    if (peek.invalid.includes(seq)) return { drop: 'mismatch' }
  }
  return { drop: 'missing' }
}

// -> { view } | { drop: 'mismatch' } | { drop: 'missing' }. `peek` holds the
// merged entries of the author's calls ({ entries, invalid, missing }).
export function foldItem (item, peek) {
  const r = lookup(peek, item.seq)
  if (r.drop) return r
  const root = r.record
  if (root.type !== 'listing' || feira.checkListingShape(root) !== null) return { drop: 'mismatch' }
  let edit = null
  if (item.editSeq !== null) {
    const e = lookup(peek, item.editSeq)
    if (e.drop) return e
    edit = e.record
    if (edit.type !== 'listing-edit' || edit.seq !== item.seq || feira.checkEditShape(edit, item.editSeq) !== null ||
      !feira.unitAllowed(root.kind, edit.price, edit.unit)) return { drop: 'mismatch' }
  }
  let status = 'disponivel'
  if (item.statusSeq !== null) {
    const st = lookup(peek, item.statusSeq)
    if (st.drop) return st
    const s = st.record
    if (s.type !== 'listing-status' || s.seq !== item.seq || feira.checkStatusShape(s, item.statusSeq) !== null ||
      (root.kind === 'procura' && s.status === 'reservado')) return { drop: 'mismatch' }
    status = s.status
  }
  const view = listingView({ author: item.author, seq: item.seq, root, edit, editSeq: item.editSeq, status })
  if (view === null || (edit !== null && view.edited !== true)) return { drop: 'mismatch' }
  // The index's status null means stale: the current status (and, with no
  // edit hint, maybe the current content) is unknown. Never shown as
  // disponivel; the screen says so.
  if (item.stale === true) return { view: { ...view, stale: true, status: null, statusLabel: null } }
  return { view: { ...view, stale: false } }
}

function mergeInto (merged, peek) {
  if (!peek || typeof peek !== 'object') return
  if (Array.isArray(peek.entries)) for (const e of peek.entries) merged.entries.push(e)
  if (Array.isArray(peek.invalid)) for (const s of peek.invalid) merged.invalid.push(s)
  if (Array.isArray(peek.missing)) for (const s of peek.missing) merged.missing.push(s)
  if (merged.profile === null && peek.profile && typeof peek.profile === 'object') merged.profile = peek.profile
  if (merged.username === null && typeof peek.username === 'string') merged.username = peek.username
}

// Peeks the plan through the app's shared peek slots; a failed call leaves
// its seqs missing (the item counts as unavailable, never as shown).
async function peekAll (request, plan, slots) {
  const merged = new Map()
  for (const params of plan) {
    if (!merged.has(params.author)) merged.set(params.author, { entries: [], invalid: [], missing: [], profile: null, username: null })
    const into = merged.get(params.author)
    try {
      const peek = await slots.run(() => request('diary.peek', params), { front: true })
      // Only entries of the asked author and seqs count.
      if (peek && (peek.key === undefined || peek.key === params.author)) {
        mergeInto(into, {
          ...peek,
          entries: Array.isArray(peek.entries) ? peek.entries.filter((e) => e && params.seqs.includes(e.seq)) : []
        })
      }
    } catch (err) {
      // The core node never reads on demand (docs/rpc.md 5.27): the screen
      // needs that answer, not a page of "unavailable" rows.
      if (err && err.code === 'USAGE' && /versão web/.test(String(err.message))) throw err
    }
  }
  return merged
}

// Index answer -> verified rows. `value` is an indexClient Feira value.
export async function hydrate (request, value, deps = {}) {
  const slots = deps.peekSlots || diaryPeekSlots
  const items = []
  for (const it of value.items) {
    const p = refParts(it.ref)
    if (p !== null) items.push({ ref: it.ref, author: p.author, seq: p.seq, editSeq: it.editSeq, statusSeq: it.statusSeq, stale: it.status === null })
  }
  const merged = await peekAll(request, planPeeks(items, value.authors), slots)
  const rows = []
  let dropped = 0
  let unavailable = 0
  for (const item of items) {
    const peek = merged.get(item.author)
    const r = foldItem(item, peek)
    if (r.view) {
      const hint = value.authors[item.author] || {}
      rows.push({
        ref: item.ref,
        ...r.view,
        name: peek && peek.profile && typeof peek.profile.name === 'string' ? rpc.displayText(peek.profile.name) : '',
        username: peek && typeof peek.username === 'string' ? peek.username : null,
        page: hint.page === true
      })
    } else if (r.drop === 'mismatch') {
      dropped++
    } else {
      unavailable++
    }
  }
  return { items: rows, next: value.next, dropped, unavailable, indexing: value.indexing, complete: value.complete }
}

async function page (request, fetched, deps) {
  const res = await fetched
  if (!res.ok) return res.reason === 'not-found' ? { off: true } : res
  return { ok: true, ...(await hydrate(request, res.value, deps)) }
}

// Search: { uf, cityKey, kind, cat, tokens, cursor } as indexClient.feiraUrl.
// -> { ok: true, items, next, dropped, unavailable, indexing, complete },
// { off: true } (404: the Feira is off here) or { ok: false, reason }.
export function search (request, query, deps = {}) {
  return page(request, (deps.fetchFeira || fetchFeira)(query, deps.index), deps)
}

// Every live listing of one seller, vendido included.
export function byAuthor (request, author, cursor = null, deps = {}) {
  return page(request, (deps.fetchFeiraAuthor || fetchFeiraAuthor)(author, cursor, deps.index), deps)
}

// The rating hints of a seller: { ok: true, refs: [{ rater, seq }], next } or
// { off: true } or { ok: false, reason }. Not proof of anything.
export async function ratingRefs (author, cursor = null, deps = {}) {
  const res = await (deps.fetchFeiraRatings || fetchFeiraRatings)(author, cursor, deps.index)
  if (!res.ok) return res.reason === 'not-found' ? { off: true } : res
  const refs = []
  for (const it of res.value.items) {
    const p = refParts(it.ref)
    if (p !== null) refs.push({ rater: p.author, seq: p.seq })
  }
  return { ok: true, refs, next: res.value.next }
}

function isRatingRow (r) {
  return r && typeof r === 'object' && typeof r.rater === 'string' && HEX64.test(r.rater) && isSeq(r.seq) &&
    isSeq(r.listingSeq) && feira.isStars(r.stars) && typeof r.text === 'string' && typeof r.at === 'string'
}

// The verified ratings of listing <author>:<seq> among `refs` (the index
// hints): listing.ratings decides; only rows it returned, about this
// listing, are kept, each copied with its text through displayText.
// Throws what the node throws.
export async function ratings (request, { author, seq, refs }) {
  if (typeof author !== 'string' || !HEX64.test(author) || !isSeq(seq) || !Array.isArray(refs)) return { items: [], dropped: 0, incomplete: false }
  const asked = refs.filter((r) => r && HEX64.test(r.rater) && isSeq(r.seq)).slice(0, RATINGS_REFS_MAX)
    .map((r) => ({ rater: r.rater, seq: r.seq }))
  if (asked.length === 0) return { items: [], dropped: 0, incomplete: false }
  const res = await request('listing.ratings', { author, seq, refs: asked })
  const items = []
  if (res && Array.isArray(res.items)) {
    for (const r of res.items) {
      if (!isRatingRow(r) || r.listingSeq !== seq || r.rater === author) continue
      if (!asked.some((a) => a.rater === r.rater && a.seq === r.seq)) continue
      items.push({ rater: r.rater, seq: r.seq, listingSeq: r.listingSeq, stars: r.stars, text: rpc.displayText(r.text), at: r.at })
    }
  }
  return {
    items,
    dropped: res && Number.isSafeInteger(res.dropped) && res.dropped >= 0 ? res.dropped : 0,
    incomplete: !!(res && res.incomplete === true)
  }
}
