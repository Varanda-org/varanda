// Varandinha, Barraquinha and Enfeites: the pure model of one balcony's
// stall. It plans which blocks to peek from the seeder's /mimos pointers,
// judges each peeked block and hands the verdict to the contract folds
// (rpc.garden.foldDecor, foldShelf and foldPending), so a forged pointer
// never counts. It also holds the small decisions of the sheets, so the
// screens stay thin. No React, no platform module, no request: the caller
// does the reads this model plans. Nothing here throws on hostile input.

import rpc from '@varanda/rpc'
import { peekBatches } from './fans.js'

const HEX64 = /^[0-9a-f]{64}$/

const isHex64 = (s) => typeof s === 'string' && HEX64.test(s)
const isSeq = (n) => Number.isSafeInteger(n) && n >= 1
const isHint = (v) => v === null || isSeq(v)

function isPlain (v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

// One own data property, never through a getter, or undefined.
function own (o, k) {
  try {
    if (o === null || typeof o !== 'object') return undefined
    const d = Object.getOwnPropertyDescriptor(o, k)
    return d && 'value' in d ? d.value : undefined
  } catch {
    return undefined
  }
}

// The items of a dense plain array of at most `max` data items, or null.
function items (v, max) {
  try {
    if (!Array.isArray(v) || Object.getPrototypeOf(v) !== Array.prototype) return null
    const ld = Object.getOwnPropertyDescriptor(v, 'length')
    const len = ld && ld.value
    if (!Number.isSafeInteger(len) || len < 0 || len > max) return null
    const out = []
    for (let i = 0; i < len; i++) {
      const d = Object.getOwnPropertyDescriptor(v, String(i))
      if (!d || !('value' in d)) return null
      out.push(d.value)
    }
    return out
  } catch {
    return null
  }
}

function blockedBy (isBlocked) {
  return (key) => {
    if (typeof isBlocked !== 'function') return false
    try {
      return isBlocked(key) === true
    } catch {
      return true
    }
  }
}

// The validated /mimos answer (indexClient validGardenStall), checked again
// with the same caps, so a value that skipped the validator plans nothing.
function readStallIndex (index, owner) {
  try {
    if (!isPlain(index)) return null
    const decor = own(index, 'decor')
    if (!isHint(decor)) return null
    const pendingRows = items(own(index, 'pending'), rpc.garden.GARDEN_GIFT_ROWS)
    const shelfRows = items(own(index, 'shelf'), rpc.garden.GARDEN_SHELF_ROWS)
    if (pendingRows === null || shelfRows === null) return null
    const pending = []
    const refs = new Set()
    for (const row of pendingRows) {
      const author = own(row, 'author')
      const seq = own(row, 'seq')
      const followSeq = own(row, 'followSeq')
      if (!isHex64(author) || author === owner || !isSeq(seq) || !isSeq(followSeq)) return null
      const ref = author + ':' + seq
      if (refs.has(ref)) return null
      refs.add(ref)
      pending.push({ author, seq, followSeq })
    }
    const shelf = []
    const seqs = new Set()
    for (const row of shelfRows) {
      const seq = own(row, 'seq')
      const from = own(row, 'from')
      const gseq = own(row, 'gseq')
      if (!isHex64(from) || from === owner || !isSeq(seq) || !isSeq(gseq) || seqs.has(seq)) return null
      seqs.add(seq)
      shelf.push({ seq, from, gseq })
    }
    return { decor, pending, shelf, complete: own(index, 'complete') === true }
  } catch {
    return null
  }
}

// The own takes of garden.stall ({ seq, from, gseq, at }), as rows. `rows`
// is null past GARDEN_TAKE_ROWS (foldShelf counts nothing then, so a reader
// never fetches more gifts than that); `pairs` names every taken gift the
// list can be read for, so a taken mimo never shows as pending again.
function readOwnTakes (ownTakes) {
  const list = items(ownTakes, 1024)
  if (list === null) return null
  const rows = []
  for (const row of list) {
    const seq = own(row, 'seq')
    const from = own(row, 'from')
    const gseq = own(row, 'gseq')
    if (isSeq(seq) && isHex64(from) && isSeq(gseq)) rows.push({ seq, from, gseq })
  }
  return { rows: list.length > rpc.garden.GARDEN_TAKE_ROWS ? null : rows, pairs: rows.map((r) => ({ from: r.from, seq: r.gseq })) }
}

// The shelf pointers: the own takes when given (the own balcony, read from
// the own diary, so an accepted mimo shows before the index has it), else
// the seeder's.
function shelfPointers (idx, takes) {
  if (takes === null) return idx.shelf
  return takes.rows === null ? [] : takes.rows
}

function isOwn (ownTakes) {
  return ownTakes !== undefined && ownTakes !== null
}

export function planStallPeeks (args) {
  const owner = own(args, 'owner')
  const none = { owner: [], givers: [] }
  try {
    if (!isHex64(owner)) return none
    const idx = readStallIndex(own(args, 'index'), owner)
    if (idx === null) return none
    const ownTakes = own(args, 'ownTakes')
    const takes = isOwn(ownTakes) ? readOwnTakes(ownTakes) : null
    if (isOwn(ownTakes) && takes === null) return none
    const blocked = blockedBy(own(args, 'isBlocked'))
    const ownerSeqs = idx.decor === null ? [] : [idx.decor]
    // helperReads-style: one entry per giver, its peek answer (or answers,
    // one per batch) goes in giverReads under the giver's key.
    const byAuthor = new Map()
    const entry = (author) => {
      let e = byAuthor.get(author)
      if (!e) {
        e = { seqs: new Set(), rows: [] }
        byAuthor.set(author, e)
      }
      return e
    }
    for (const row of idx.pending) {
      if (blocked(row.author)) continue
      const e = entry(row.author)
      e.seqs.add(row.seq)
      e.seqs.add(row.followSeq)
      e.rows.push({ kind: 'pending', seq: row.seq, followSeq: row.followSeq })
    }
    for (const row of shelfPointers(idx, takes)) {
      if (row.from === owner || blocked(row.from)) continue
      ownerSeqs.push(row.seq)
      const e = entry(row.from)
      e.seqs.add(row.gseq)
      e.rows.push({ kind: 'shelf', take: row.seq, gseq: row.gseq })
    }
    const givers = []
    for (const [author, e] of byAuthor) {
      givers.push({ author, batches: peekBatches(author, [...e.seqs]), rows: e.rows })
    }
    return { owner: peekBatches(owner, ownerSeqs), givers }
  } catch {
    return none
  }
}

// The records of one author's diary.peek answer(s) by seq. A seq the node
// named invalid or missing is unread, whatever else the answer holds.
function readsOf (key, peeks) {
  const live = new Map()
  const unread = new Set()
  const list = Array.isArray(peeks) ? peeks : [peeks]
  for (const p of list) {
    if (!isPlain(p) || own(p, 'key') !== key) continue
    for (const e of items(own(p, 'entries'), 4096) || []) {
      const seq = own(e, 'seq')
      const record = own(e, 'record')
      if (isSeq(seq) && isPlain(record) && !live.has(seq)) live.set(seq, record)
    }
    for (const s of items(own(p, 'invalid'), 4096) || []) if (isSeq(s)) unread.add(s)
    for (const s of items(own(p, 'missing'), 4096) || []) if (isSeq(s)) unread.add(s)
  }
  for (const s of unread) live.delete(s)
  return { live, unread }
}

const typeIs = (record, type) => isPlain(record) && own(record, 'type') === type

function giverRead (giverReads, author) {
  const raw = giverReads instanceof Map ? giverReads.get(author) : undefined
  return raw === undefined || raw === null ? null : readsOf(author, raw)
}

function emptyStall () {
  return { decor: [], shelf: [], pending: [], incomplete: true }
}

export function assembleStall (args) {
  try {
    const owner = own(args, 'owner')
    const since = own(args, 'since')
    const now = own(args, 'now')
    if (!isHex64(owner) || !isSeq(since) || !Number.isFinite(now)) return emptyStall()
    const idx = readStallIndex(own(args, 'index'), owner)
    if (idx === null) return emptyStall()
    const ownTakes = own(args, 'ownTakes')
    const ownBalcony = isOwn(ownTakes)
    const takes = ownBalcony ? readOwnTakes(ownTakes) : null
    if (ownBalcony && takes === null) return emptyStall()
    const blocked = blockedBy(own(args, 'isBlocked'))
    const giverReads = own(args, 'giverReads')
    const mine = readsOf(owner, own(args, 'ownerReads'))
    let incomplete = idx.complete !== true || (takes !== null && takes.rows === null)

    let decor = []
    if (idx.decor !== null) {
      const record = mine.live.get(idx.decor)
      if (!typeIs(record, 'garden-decor') || idx.decor <= since) incomplete = true
      else decor = rpc.garden.foldDecor({ record, seq: idx.decor, since, now }).items
    }

    // Each take must name exactly the gift its pointer names, so a pointer
    // never pairs a take with another giver's block.
    const shelfRows = []
    const taken = []
    for (const row of shelfPointers(idx, takes)) {
      if (row.from === owner || blocked(row.from)) continue
      const record = mine.live.get(row.seq)
      if (!typeIs(record, 'garden-take') || own(record, 'from') !== row.from || own(record, 'seq') !== row.gseq || row.seq <= since) {
        incomplete = true
        continue
      }
      taken.push({ from: row.from, seq: row.gseq })
      const read = giverRead(giverReads, row.from)
      const gift = read === null ? undefined : read.live.get(row.gseq)
      if (gift === undefined) {
        incomplete = true
        continue
      }
      shelfRows.push({ seq: row.seq, record, gift })
    }
    if (takes !== null) for (const pair of takes.pairs) taken.push(pair)
    const shelf = rpc.garden.foldShelf({ owner, now, since, takes: shelfRows.slice(0, rpc.garden.GARDEN_TAKE_ROWS) }).rows

    const gifts = []
    for (const row of idx.pending) {
      if (blocked(row.author)) continue
      const read = giverRead(giverReads, row.author)
      const record = read === null ? undefined : read.live.get(row.seq)
      const follow = read === null ? undefined : read.live.get(row.followSeq)
      if (record === undefined || follow === undefined) {
        incomplete = true
        continue
      }
      gifts.push({ author: row.author, seq: row.seq, record, follow })
    }
    const followedArg = own(args, 'followed')
    const followed = ownBalcony && followedArg instanceof Set ? followedArg : new Set()
    const pending = rpc.garden.foldPending({ owner, now, gifts, taken, followed }).rows
    return { decor, shelf, pending, incomplete }
  } catch {
    return emptyStall()
  }
}

// The street preview reads only the owner's own diary: blocks 1 and 2 (a
// page's roster), the flag, the state and the decor. Never another diary.
export function previewPlan (args) {
  try {
    const owner = own(args, 'owner')
    if (!isHex64(owner)) return []
    const index = own(args, 'index')
    const stallIndex = own(args, 'stallIndex')
    const seqs = [1, 2]
    for (const s of [own(index, 'on'), own(index, 'state'), own(stallIndex, 'decor')]) if (isSeq(s)) seqs.push(s)
    return peekBatches(owner, seqs)
  } catch {
    return []
  }
}

// The Enfeites of a street preview, only over a verified on flag of a member
// (not a page) and only above it.
export function previewDecor (args) {
  try {
    const owner = own(args, 'owner')
    const now = own(args, 'now')
    const since = own(own(args, 'index'), 'on')
    const seq = own(own(args, 'stallIndex'), 'decor')
    if (!isHex64(owner) || !isSeq(since) || !isSeq(seq) || !Number.isFinite(now)) return []
    const mine = readsOf(owner, own(args, 'ownerReads'))
    if (mine.unread.has(1) || mine.unread.has(2)) return []
    if (typeIs(mine.live.get(1), 'page-roster') || typeIs(mine.live.get(2), 'page-roster')) return []
    const flag = mine.live.get(since)
    if (!typeIs(flag, 'garden') || own(flag, 'on') !== true) return []
    return rpc.garden.foldDecor({ record: mine.live.get(seq), seq, since, now }).items
  } catch {
    return []
  }
}

// ---- sheet decisions -------------------------------------------------------

// The decor list with `id` switched, in GARDEN_DECOR_IDS order (the only
// order garden.decor accepts). Unknown ids, in the list or as `id`, drop out.
export function toggleDecor (list, id) {
  const ids = rpc.garden.GARDEN_DECOR_IDS
  const set = new Set()
  for (const v of items(list, 64) || []) if (ids.includes(v)) set.add(v)
  if (ids.includes(id)) {
    if (set.has(id)) set.delete(id)
    else set.add(id)
  }
  return ids.filter((v) => set.has(v))
}

// What the pot sheet offers for a mimo: `view` is the own pot's potView (the
// caller passes null on another balcony), `unsaved` the pending acts of the
// session, `stall` the own garden.stall answer. The hardest blocker first:
// no stall day, then the day's budget, then unsaved acts (a give saves the
// pot from the node's state, which would drop them).
export function giveChoice (args) {
  try {
    const view = own(args, 'view')
    if (!isPlain(view) || own(view, 'ripe') !== true) return null
    const stall = own(args, 'stall')
    if (!isPlain(stall) || own(stall, 'open') !== true) return 'closed'
    const gifts = own(stall, 'giftsToday')
    if (!Number.isSafeInteger(gifts) || gifts < 0 || gifts >= rpc.garden.GARDEN_GIFTS_DAILY_MAX) return 'spent'
    const unsaved = own(args, 'unsaved')
    if (unsaved === true || (typeof unsaved === 'number' && unsaved !== 0)) return 'unsaved'
    return 'give'
  } catch {
    return null
  }
}

export function stallCount (pending) {
  const list = items(pending, 1024)
  return list === null ? 0 : list.length
}
