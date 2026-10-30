'use strict'

// Deletion fold over one diary's entries ({ seq, record }). A `delete`
// record (lib/records.js) at block b removes block `seq` whatever that
// block is and whether or not this replica holds it. Walking from the
// highest block down, a tombstone takes effect only if no later effective
// tombstone deleted it, so the result is the same on every replica that
// holds the same blocks. The fold is pure: no I/O, never throws (also
// loaded by the browser node).

const { validRecordCopy, decodeBlock, MAX_LOG_BLOCKS } = require('./records')

// Always a fresh copy: reading entries can run getters, which must not be
// able to change a caller's set while the fold consults it.
function toSet (v) {
  if (v instanceof Set) return new Set(v)
  return new Set(Array.isArray(v) ? v : [])
}

// Valid tombstones, highest block first, one per block.
function tombstones (entries) {
  const out = []
  if (!Array.isArray(entries)) return out
  const seen = new Set()
  for (let i = 0; i < entries.length; i++) {
    try {
      const entry = entries[i]
      if (entry === null || typeof entry !== 'object') continue
      const seq = entry.seq
      if (!Number.isSafeInteger(seq) || seen.has(seq)) continue
      const copy = validRecordCopy(entry.record, seq)
      if (copy === null || copy.type !== 'delete') continue
      seen.add(seq)
      out.push({ seq, record: copy })
    } catch {}
  }
  return out.sort((a, b) => b.seq - a.seq)
}

function fold (entries) {
  const deleted = new Set()
  const effective = []
  for (const t of tombstones(entries)) {
    if (deleted.has(t.seq)) continue
    deleted.add(t.record.seq)
    effective.push(t)
  }
  return { deleted, effective }
}

function deletedSeqs (entries) {
  return fold(entries).deleted
}

// Targets of every valid tombstone, effective or not.
function targetSeqs (entries) {
  const out = new Set()
  for (const t of tombstones(entries)) out.add(t.record.seq)
  return out
}

// Same length and order as entries, so slicing by index is unchanged.
function applyDeletes (entries) {
  if (!Array.isArray(entries)) return []
  const { deleted } = fold(entries)
  const out = new Array(entries.length)
  for (let i = 0; i < entries.length; i++) {
    let entry
    let seq
    try {
      entry = entries[i]
      seq = entry !== null && typeof entry === 'object' ? entry.seq : undefined
    } catch {}
    out[i] = Number.isSafeInteger(seq) && deleted.has(seq) ? { seq, record: null, deleted: true } : entry
  }
  return out
}

// A range that a surviving post or profile still overlaps is never returned:
// writers never emit one, and a hand-made tombstone must not erase bytes a
// live record shows.
// The survivors are indexed once, so the cost stays O((T + R) log R) for T
// tombstone ranges and R live refs: a diary near its quotas holds tens of
// thousands of both, and comparing every pair blocked a seeder's startup.
function deletedRanges (entries, cores) {
  const allowed = toSet(cores)
  const live = coverage(liveMediaRefs(entries))
  const out = []
  for (const { record } of fold(entries).effective) {
    if (!Array.isArray(record.media)) continue
    for (const r of record.media) {
      if (!allowed.has(r.core) || covered(live, r)) continue
      out.push({ core: r.core, start: r.start, blocks: r.blocks })
    }
  }
  return out
}

// Per core, the live refs as sorted disjoint [start, end) intervals.
function coverage (refs) {
  const byCore = new Map()
  for (const { core, start, blocks } of refs) {
    let list = byCore.get(core)
    if (list === undefined) byCore.set(core, (list = []))
    list.push([start, start + blocks])
  }
  for (const [core, list] of byCore) {
    list.sort((a, b) => a[0] - b[0])
    const merged = []
    for (const [start, end] of list) {
      const last = merged[merged.length - 1]
      if (last !== undefined && start <= last[1]) last[1] = Math.max(last[1], end)
      else merged.push([start, end])
    }
    byCore.set(core, merged)
  }
  return byCore
}

// Same answer as overlaps() against every ref: the last interval starting
// before the range's end is the only one that can reach into it.
function covered (index, r) {
  const list = index.get(r.core)
  if (list === undefined) return false
  const end = r.start + r.blocks
  let lo = 0
  let hi = list.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (list[mid][0] < end) lo = mid + 1
    else hi = mid
  }
  return lo > 0 && list[lo - 1][1] > r.start
}

// Media still referenced by a surviving post or profile, other than the
// blocks in exceptSeqs.
function liveMediaRefs (entries, exceptSeqs) {
  const except = toSet(exceptSeqs)
  const out = []
  if (!Array.isArray(entries)) return out
  const { deleted } = fold(entries)
  for (let i = 0; i < entries.length; i++) {
    try {
      const entry = entries[i]
      if (entry === null || typeof entry !== 'object') continue
      const seq = entry.seq
      if (!Number.isSafeInteger(seq) || deleted.has(seq) || except.has(seq)) continue
      const copy = validRecordCopy(entry.record, seq)
      if (copy === null) continue
      let descriptors = []
      if (copy.type === 'post' && Array.isArray(copy.media)) descriptors = copy.media
      else if (copy.type === 'profile' && copy.avatar !== undefined) descriptors = [copy.avatar]
      for (const d of descriptors) out.push({ core: d.core, start: d.start, blocks: d.blocks })
    } catch {}
  }
  return out
}

function overlaps (a, b) {
  try {
    return a.core === b.core && a.start < b.start + b.blocks && b.start < a.start + a.blocks
  } catch {
    return false
  }
}

// Byte deletion over a hypercore session passed in (Node or browser engine,
// so nothing here requires one). contiguousLength is never trusted: the
// browser engine does not keep its lowered value across a reopen after a
// clear, so the present length is always walked with has(i).

// Every local block of [0, core.length) is read, past holes too, so a
// tombstone above a hole this replica never had is still learned (a fresh
// replica must not wait on a block nobody serves any more).
// -> { raw, entries, deleted, present }: raw as decoded (a hole or an
// undecodable block is { seq, record: null }), entries = applyDeletes(raw),
// present = first hole no valid tombstone targets, else core.length.
// A target of an undone tombstone counts too: its bytes may be cleared
// everywhere, and stopping there would hide every later block forever. Such
// a revived seq reads as absent, and the present length never drops when a
// deletion is undone.
// core.length is the signed length: an author can sign one far past the
// blocks anyone serves, so no walk goes past MAX_LOG_BLOCKS (a longer diary
// is refused by quota and is never valid content), and raw ends at the last
// local block, so a withheld tail allocates nothing. Targets are always
// below their tombstone, so every hole a tombstone explains is inside raw.
async function presentState (core) {
  const length = core.length
  const limit = Math.min(length, MAX_LOG_BLOCKS)
  const raw = []
  const holes = []
  for (let i = 0; i < limit; i++) {
    if (!(await core.has(i))) continue
    const block = await core.get(i, { wait: false, raw: true })
    if (block === null) continue
    for (let h = raw.length; h < i; h++) {
      holes.push(h)
      raw.push({ seq: h, record: null })
    }
    raw.push({ seq: i, record: decodeBlock(block) })
  }
  const deleted = deletedSeqs(raw)
  const targets = targetSeqs(raw)
  let present = raw.length
  for (const seq of holes) {
    if (!targets.has(seq)) {
      present = seq
      break
    }
  }
  return { raw, entries: applyDeletes(raw), deleted, present }
}

// Present length walked from `from`, a present length the caller computed
// before (it only grows). `deleted` is a fast path: a hole outside it is
// still passed when a local tombstone above it targets it, the same rule
// as presentState, so callers holding only the effective set agree.
// `targets`, when given, is every tombstone target the caller holds
// (effective or not) and replaces the local scan above a hole.
async function presentLength (core, deleted, from = 0, targets) {
  const length = Math.min(core.length, MAX_LOG_BLOCKS)
  const gone = deleted instanceof Set ? deleted : new Set()
  const known = targets instanceof Set ? targets : null
  let i = Number.isSafeInteger(from) && from > 0 ? Math.min(from, length) : 0
  for (; i < length; i++) {
    if (gone.has(i) || (await core.has(i))) continue
    if (known !== null ? !known.has(i) : !(await targetedAbove(core, i, length))) break
  }
  return i
}

// Per core: the tombstones read in a range of blocks already checked, and
// per target the lowest tombstone block naming it, so a hole is answered
// with one lookup instead of a pass over every tombstone. The
// hole above the download frontier is asked about on every pass, so a range
// is checked once and afterwards only blocks a 'download' reports, or a
// length growth adds, are read. Blocks are signed and append-only and
// tombstones are never cleared, so an answer holds until a fork rewrites the
// core. A block that lands without a 'download' event comes with an upgrade,
// past the range checked so far.
const scanned = new WeakMap()

function scanCache (core) {
  const fork = Number.isSafeInteger(core.fork) ? core.fork : 0
  let cache = scanned.get(core)
  if (cache !== undefined && cache.fork === fork) return cache
  if (cache !== undefined) cache.stop()
  cache = { fork, tombs: new Map(), targets: new Map(), lo: 0, hi: 0, dirty: new Set(), live: false, stop () {} }
  if (typeof core.on === 'function' && typeof core.off === 'function') {
    const onDownload = (index) => {
      if (Number.isSafeInteger(index) && index >= 0 && index < MAX_LOG_BLOCKS) cache.dirty.add(index)
    }
    core.on('download', onDownload)
    cache.live = true
    cache.stop = () => core.off('download', onDownload)
  }
  scanned.set(core, cache)
  return cache
}

// A read error leaves the block to be checked again on the next pass.
async function checkBlock (core, cache, b) {
  try {
    if (!(await core.has(b))) return
    const copy = validRecordCopy(decodeBlock(await core.get(b, { wait: false, raw: true })), b)
    if (copy !== null && copy.type === 'delete') {
      cache.tombs.set(b, copy.seq)
      const lowest = cache.targets.get(copy.seq)
      if (lowest === undefined || b < lowest) cache.targets.set(copy.seq, b)
    }
  } catch {
    cache.dirty.add(b)
  }
}

async function checkRange (core, cache, start, end) {
  for (let b = start; b < end; b++) {
    if (!cache.tombs.has(b)) await checkBlock(core, cache, b)
  }
}

async function targetedAbove (core, seq, length) {
  let cache = null
  try {
    cache = scanCache(core)
  } catch {
    return false
  }
  const start = seq + 1
  if (!cache.live) {
    await checkRange(core, cache, start, length)
  } else {
    if (cache.lo === cache.hi) {
      await checkRange(core, cache, start, length)
      cache.lo = start
      cache.hi = Math.max(start, length)
    } else {
      if (start < cache.lo) {
        await checkRange(core, cache, start, cache.lo)
        cache.lo = start
      }
      if (cache.hi < length) {
        const from = cache.hi
        await checkRange(core, cache, from, length)
        cache.hi = Math.max(cache.hi, length)
      }
    }
    // Indexes outside the range are read when the range grows over them.
    for (const b of [...cache.dirty]) {
      cache.dirty.delete(b)
      if (b >= cache.lo && b < cache.hi && !cache.tombs.has(b)) await checkBlock(core, cache, b)
    }
  }
  // A target is always below its tombstone, so the lowest tombstone of seq
  // is above it; only the length bound is left to check.
  const lowest = cache.targets.get(seq)
  return lowest !== undefined && lowest < length
}

// True when block seq is local and a valid tombstone.
async function tombstoneAt (core, seq) {
  try {
    if (!Number.isSafeInteger(seq) || seq < 1 || seq >= core.length || !(await core.has(seq))) return false
    const copy = validRecordCopy(decodeBlock(await core.get(seq, { wait: false, raw: true })), seq)
    return copy !== null && copy.type === 'delete'
  } catch {
    return false
  }
}

// Sorted deletable seqs: block 0 never is.
function sortedSeqs (deleted) {
  return [...toSet(deleted)].filter((s) => Number.isSafeInteger(s) && s > 0).sort((a, b) => a - b)
}

// Clears every deleted block still local -> the cleared seqs. Block 0 and
// tombstones are never cleared: every replica needs the tombstones to
// compute the same fold, and a tombstone a later one deleted becomes
// effective again if that later one is itself deleted.
async function clearDeleted (core, deleted) {
  return clearSeqs(core, sortedSeqs(deleted), () => true)
}

// stillDeleted(seq) is asked again after every await, right before the
// clear, so a seq an update took out of the set is never cleared.
async function clearSeqs (core, seqs, stillDeleted) {
  const cleared = []
  for (const seq of seqs) {
    if (await clearable(core, seq, stillDeleted)) {
      await core.clear(seq, seq + 1)
      cleared.push(seq)
    }
  }
  return cleared
}

// Fails closed: only a block read back and known not to be a valid
// tombstone may be cleared; a read error or a missing block never is.
async function clearable (core, seq, stillDeleted) {
  try {
    if (!stillDeleted(seq) || seq >= core.length || !(await core.has(seq))) return false
    const block = await core.get(seq, { wait: false, raw: true })
    if (block === null || block === undefined) return false
    const copy = validRecordCopy(decodeBlock(block), seq)
    if (copy !== null && copy.type === 'delete') return false
    return stillDeleted(seq) && seq < core.length
  } catch {
    return false
  }
}

// Hypercore keeps its ranges in an array that every add and remove walks,
// so a handle never opens more than this many at once. High enough that a
// person who deleted many posts keeps exact gaps (no refetch from a stale
// peer); the cap only bites on diaries crafted with thousands of gaps.
const MAX_RANGES = 1024

// One range per gap between deleted seqs, the last one live (end -1), so a
// stale peer that still holds a deleted block is never asked for it; a
// single { start: 0, end: -1 } range would fetch it back.
// Past MAX_RANGES - 1 gap ranges the rest is one live range: a deleted seq
// in it can still be fetched from a stale peer, and the 'download' listener
// clears it again. Only a diary with that many deletions pays that.
// -> { update(deleted), destroy(), idle() }. update replaces the ranges and
// then clears the deleted blocks it has not tried to clear yet (one
// fetched later is cleared on 'download'). Destroying a range does not
// cancel a request already answered on the wire, so a 'download' of a
// deleted seq is cleared again; idle() waits for those clears.
// Ranges are linear so the readable prefix fills in order instead of
// stalling on its earliest gap while later blocks are stored.
// A clear already in flight can still remove a seq an update just took out
// of the set (the engine awaits a lock before deleting), after the new
// ranges counted it as held; such a seq is re-checked once the clears
// settle and the ranges are reopened so a peer that holds it refills it.
function downloadExcept (core, deleted) {
  let current = new Set(sortedSeqs(deleted))
  let ranges = []
  let destroyed = false
  // Start of the live range, and whether deleted seqs fall inside it.
  let tailStart = 0
  let capped = false
  const pending = new Set()
  const revived = new Set()
  // Seqs already handed to a clear: a later update clears only the others.
  const tried = new Set()

  const open = () => {
    let start = 0
    capped = false
    for (const seq of current) {
      if (ranges.length >= MAX_RANGES - 1) {
        capped = true
        break
      }
      if (seq > start) ranges.push(core.download({ start, end: seq, linear: true }))
      start = seq + 1
    }
    tailStart = start
    ranges.push(core.download({ start, end: -1, linear: true }))
  }
  const close = () => {
    for (const r of ranges) {
      try { r.destroy() } catch {}
    }
    ranges = []
  }
  const track = (p) => {
    pending.add(p)
    p.finally(() => pending.delete(p)).catch(() => {})
    return p
  }
  const onDownload = (index) => {
    if (!current.has(index)) return
    track(clearSeqs(core, [index], (seq) => current.has(seq)).catch(() => []))
  }
  const idle = async () => {
    while (pending.size > 0) await Promise.allSettled([...pending])
  }
  // Once the clears settled, fresh ranges cover a missing revived seq, so
  // each one is checked once. -> true when one is missing locally.
  const refillNeeded = async () => {
    let missing = false
    for (const seq of [...revived]) {
      revived.delete(seq)
      if (current.has(seq)) continue
      try {
        if (seq < core.length && (await core.has(seq))) continue
      } catch {}
      missing = true
    }
    return missing
  }

  core.on('download', onDownload)
  open()

  return {
    async update (next) {
      if (destroyed) return []
      const before = current
      current = new Set(sortedSeqs(next))
      let shrunk = false
      for (const seq of before) {
        if (current.has(seq)) continue
        shrunk = true
        revived.add(seq)
        tried.delete(seq)
      }
      // Growth inside the live range of a capped handle changes no range:
      // the gap ranges stay the same and the live range already covers it.
      let reopen = shrunk || !capped
      if (!reopen) {
        for (const seq of current) {
          if (!before.has(seq) && seq < tailStart) {
            reopen = true
            break
          }
        }
      }
      if (reopen) {
        close()
        open()
      }
      const fresh = []
      for (const seq of current) {
        if (tried.has(seq)) continue
        tried.add(seq)
        fresh.push(seq)
      }
      const cleared = await track(clearSeqs(core, fresh, (seq) => current.has(seq)))
      await idle()
      // destroy() can run while refillNeeded awaits has(): check again
      // after it, or a destroyed handle would reopen its ranges.
      if (!destroyed && (await refillNeeded()) && !destroyed) {
        close()
        open()
      }
      return cleared
    },
    destroy () {
      if (destroyed) return
      destroyed = true
      core.off('download', onDownload)
      close()
    },
    idle
  }
}

// Clears media ranges ({ start, blocks }) of the core passed in, clamped to
// its length; the caller picks the core named by each range.
async function clearRanges (core, ranges) {
  if (!Array.isArray(ranges)) return
  for (const r of ranges) {
    if (r === null || typeof r !== 'object') continue
    const { start, blocks } = r
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(blocks) || start < 0 || blocks < 1) continue
    const end = Math.min(start + blocks, core.length)
    if (start < end) await core.clear(start, end)
  }
}

module.exports = {
  deletedSeqs,
  applyDeletes,
  deletedRanges,
  liveMediaRefs,
  overlaps,
  presentState,
  presentLength,
  tombstoneAt,
  clearDeleted,
  downloadExcept,
  clearRanges
}
