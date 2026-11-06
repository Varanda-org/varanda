'use strict'

// Deletion fold over one diary's entries ({ seq, record }). A `delete`
// record (lib/records.js) at block b removes block `seq` whatever that
// block is (a page-* record aside, below) and whether or not this replica
// holds it. Walking from the
// highest block down, a tombstone takes effect only if no later effective
// tombstone deleted it, so the result is the same on every replica that
// holds the same blocks. The fold is pure: no I/O, never throws (also
// loaded by the browser node).
// A tombstone whose target is a page-* record has no effect (docs/
// protocol.md §12): a leaked page key must not undo a roster, a close or a
// move. The fold can only tell when the target block is present; a
// tombstone over a block this replica never held is folded as before, and
// the clear path never clears a page-* block, so a present one stays.

const { validRecordCopy, decodeBlock, MAX_LOG_BLOCKS, PAGE_KEYS } = require('./records')

const PAGE_TYPES = new Set(Object.keys(PAGE_KEYS))

function isPageType (type) {
  return typeof type === 'string' && PAGE_TYPES.has(type)
}

// Always a fresh copy: reading entries can run getters, which must not be
// able to change a caller's set while the fold consults it.
function toSet (v) {
  if (v instanceof Set) return new Set(v)
  return new Set(Array.isArray(v) ? v : [])
}

// Valid tombstones, highest block first, one per block, and the seqs of the
// valid page-* records, in one pass: validating each record once keeps the
// fold as cheap as it was before the page rule.
function scan (entries) {
  const out = []
  const pages = new Set()
  if (!Array.isArray(entries)) return { tombstones: out, pages }
  const seen = new Set()
  for (let i = 0; i < entries.length; i++) {
    try {
      const entry = entries[i]
      if (entry === null || typeof entry !== 'object') continue
      const seq = entry.seq
      if (!Number.isSafeInteger(seq)) continue
      const copy = validRecordCopy(entry.record, seq)
      if (copy === null) continue
      if (isPageType(copy.type)) pages.add(seq)
      else if (copy.type === 'delete' && !seen.has(seq)) {
        seen.add(seq)
        out.push({ seq, record: copy })
      }
    } catch {}
  }
  out.sort((a, b) => b.seq - a.seq)
  return { tombstones: out, pages }
}

function fold (entries) {
  return foldScanned(scan(entries))
}

function foldScanned ({ tombstones: valid, pages }) {
  const deleted = new Set()
  const effective = []
  for (const t of valid) {
    if (deleted.has(t.seq) || pages.has(t.record.seq)) continue
    deleted.add(t.record.seq)
    effective.push(t)
  }
  return { deleted, effective }
}

function deletedSeqs (entries) {
  return fold(entries).deleted
}

// Same length and order as entries, so slicing by index is unchanged.
function applyDeletes (entries) {
  if (!Array.isArray(entries)) return []
  return withDeleted(entries, fold(entries).deleted)
}

function withDeleted (entries, deleted) {
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
  // One scan for the three answers, over the only records it can count: raw
  // holds decodeBlock output (JSON.parse, plain data, no accessors), so the
  // type read here is the type validRecordCopy would copy, and any other
  // record is skipped by scan anyway after a clone and a full validation.
  const scanned = scan(raw.filter((e) => e.record !== null && (e.record.type === 'delete' || isPageType(e.record.type))))
  const { deleted } = foldScanned(scanned)
  // Targets of every valid tombstone, effective or not.
  const targets = new Set(scanned.tombstones.map((t) => t.record.seq))
  let present = raw.length
  for (const seq of holes) {
    if (!targets.has(seq)) {
      present = seq
      break
    }
  }
  return { raw, entries: withDeleted(raw, deleted), deleted, present }
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

// Clears every deleted block still local -> the cleared seqs. Block 0,
// tombstones and page-* records are never cleared: every replica needs the
// tombstones to compute the same fold, a tombstone a later one deleted
// becomes effective again if that later one is itself deleted, and a page-*
// record is never deletable (a seeder holding a set computed elsewhere
// still keeps it).
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

// Fails closed: only a block read back and known to be neither a valid
// tombstone nor a valid page-* record may be cleared; a read error or a
// missing block never is.
async function clearable (core, seq, stillDeleted) {
  try {
    if (!stillDeleted(seq) || seq >= core.length || !(await core.has(seq))) return false
    const block = await core.get(seq, { wait: false, raw: true })
    if (block === null || block === undefined) return false
    const copy = validRecordCopy(decodeBlock(block), seq)
    if (copy !== null && (copy.type === 'delete' || isPageType(copy.type))) return false
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

// Page diaries (docs/protocol.md §12): the fold ignores a tombstone whose
// target is a page-* record only when the target is held, so a replica that
// learns the tombstone first must still fetch the target, or a leaked page
// key hides a page-close or page-moved from it. A diary is a page diary when
// its block 1 or 2 is a page-roster (the genesis puts it at 2), and a
// personal one once block 2 was read as anything else; until then it may be
// one, and every target stays in the download (fail toward fetching). A target leaves the download once held: read as a
// non page-* record it is remembered and leaves for good (it is cleared),
// and a page-* one is never cleared. Personal diaries exclude every target
// at once, as before. There is no give-up: Hypercore only asks a peer that
// advertises a block, so a target nobody serves any more costs no request,
// only its seq in the range.
// A tombstone over an unheld block 2 settles the type first: block 2 ALONE
// is asked from a peer that advertises it, within ROSTER_PROBE_MS (a leaked
// page key may delete the roster and the close together, so "deleted block
// 2 means personal" would lose the cut). Only block 2 actually read settles
// it: a page-roster makes it a page; anything else makes it personal and is
// cleared at once. Until then no other target is fetched (the privacy
// rule), and block 2 is probed again later: on the next call, when a peer
// connects, or when a pending retry fires. A probe that timed out waits
// ROSTER_REPROBE_MS before the next one, and only one runs at a time, so a
// personal diary whose block 2 is gone for good costs almost nothing. A
// probe with no peer connected returns at once and does not count.
const PAGE_GENESIS_SEQS = [1, 2]
const ROSTER_SEQ = 2
const ROSTER_PROBE_MS = 2000
const ROSTER_REPROBE_MS = 30000
const PROBE_POLL_MS = 50

// Whether a connected peer advertised block seq (Hypercore: its
// contiguous range, then its bitfield), and whether any peer is connected.
function advertisedBy (core, seq) {
  let peers = false
  try {
    for (const peer of core.peers) {
      peers = true
      if (seq < peer.remoteContiguousLength || peer.remoteBitfield.get(seq) === true) return { peers, yes: true }
    }
  } catch {}
  return { peers, yes: false }
}

// -> the type of block 2 fetched alone ('' for an invalid record), null
// when no peer advertised it in time (or it did not arrive), 'none' at
// once when no peer is connected.
async function probeRoster (core, probeMs) {
  const deadline = Date.now() + probeMs
  for (let first = true; ; first = false) {
    const ad = advertisedBy(core, ROSTER_SEQ)
    if (first && !ad.peers) return 'none'
    const left = deadline - Date.now()
    if (ad.yes && left > 0) {
      try {
        const block = await core.get(ROSTER_SEQ, { raw: true, timeout: left })
        if (block !== null && block !== undefined) {
          const copy = validRecordCopy(decodeBlock(block), ROSTER_SEQ)
          return copy === null ? '' : copy.type
        }
      } catch {}
      return null
    }
    if (left <= 0) return null
    await new Promise((resolve) => setTimeout(resolve, Math.min(PROBE_POLL_MS, left)))
  }
}

// The type of the held block at seq, '' for a block that is not a valid
// record, null when it is not held (or the read failed).
async function heldType (core, seq) {
  try {
    if (seq >= core.length || !(await core.has(seq))) return null
    const block = await core.get(seq, { wait: false, raw: true })
    if (block === null || block === undefined) return null
    const copy = validRecordCopy(decodeBlock(block), seq)
    return copy === null ? '' : copy.type
  } catch {
    return null
  }
}

// -> { excludable (deleted, { wait }) -> Set, page () -> true | false |
// null, watch (fn) -> unwatch, destroy () }: the seqs of `deleted` that may
// leave the download now. Read every held target before a clear, so a
// cleared one is not fetched back. `wait` false does not wait for a roster
// probe (it settles later; watch(fn) is told). The guard may outlive one
// download (the browser follower reopens it), so only its owner destroys it;
// the peer-add listener also goes once the type is settled.
function pageTargets (core, { probeMs = ROSTER_PROBE_MS, reprobeMs = ROSTER_REPROBE_MS } = {}) {
  let page = null
  const read = new Set()
  let probing = null
  let nextAt = 0
  let timer = null
  let armed = false
  let destroyed = false
  const watchers = new Set()
  const disarm = () => {
    if (armed) core.off('peer-add', onPeer)
    armed = false
    clearTimeout(timer)
    timer = null
  }
  const settled = () => {
    disarm()
    for (const fn of [...watchers]) {
      try { fn() } catch {}
    }
  }
  const probe = () => {
    if (probing !== null) return probing
    if (page !== null || destroyed) return null
    const wait = nextAt - Date.now()
    if (wait > 0) {
      if (timer === null) {
        timer = setTimeout(() => {
          timer = null
          probe()
        }, wait)
        if (timer.unref) timer.unref()
      }
      return null
    }
    probing = (async () => {
      const type = await probeRoster(core, probeMs)
      if (page !== null || destroyed) return
      if (type === null) {
        nextAt = Date.now() + reprobeMs
        return
      }
      if (type === 'none') return
      // Classification only: once the diary reads as a person, every target
      // is excluded and the download's own clear path, which checks that the
      // block is still deleted, clears block 2. Clearing here could drop a
      // block whose tombstone was undone during the probe.
      page = type === 'page-roster'
    })().catch(() => {}).finally(() => {
      probing = null
      if (page !== null && !destroyed) settled()
      // A timed-out probe arms its own retry: with a stable peer set and no
      // further call nothing else would probe again.
      else if (page === null && !destroyed && nextAt > Date.now()) probe()
    })
    return probing
  }
  function onPeer () {
    if (page !== null || destroyed) return disarm()
    probe()
  }
  const arm = () => {
    if (armed || destroyed || page !== null) return
    armed = true
    core.on('peer-add', onPeer)
  }
  return {
    page: () => page,
    watch (fn) {
      watchers.add(fn)
      return () => watchers.delete(fn)
    },
    destroy () {
      destroyed = true
      disarm()
      watchers.clear()
    },
    async excludable (deleted, { wait = true } = {}) {
      const all = sortedSeqs(deleted)
      if (page === null) {
        for (const seq of PAGE_GENESIS_SEQS) {
          const type = await heldType(core, seq)
          if (type === 'page-roster') page = true
          else if (type !== null && seq === ROSTER_SEQ) page = false
          if (page !== null) break
        }
      }
      // An unheld block 2 named by a tombstone: block 2 alone settles it.
      // Fetching the other targets on "maybe" would pull deleted posts
      // from stale peers.
      const unsettled = () => page === null && all.includes(ROSTER_SEQ)
      if (unsettled()) {
        arm()
        const run = probe()
        if (wait && run !== null) await run
      }
      if (page === false) return new Set(all)
      const out = new Set()
      for (const seq of all) {
        if (!read.has(seq)) {
          const type = await heldType(core, seq)
          if (type === null) continue
          if (!isPageType(type)) read.add(seq)
          // A deleted block 2 read once settles it, cleared or not.
          if (seq === ROSTER_SEQ && page === null) {
            page = type === 'page-roster'
            settled()
          }
        }
        out.add(seq)
      }
      // Until block 2 settles the type, every target stays out: a personal
      // diary never fetches a deleted post from a stale or hostile peer, and
      // a page fetches its targets once the roster lands (downloadExceptPages
      // refreshes on block 1 or 2).
      if (page !== true) return new Set(all)
      return out
    }
  }
}

// make(core, skip) (downloadExcept, or the browser's linearExcept) over the
// excludable part of `deleted` only (pageTargets); a 'download' of a target
// still in the range, or of a genesis block, recomputes it. Same { update,
// destroy, idle } as make's handle; the first ranges open once the first
// read is done, and update(next) waits for the recompute.
function downloadExceptPages (core, deleted, { make = downloadExcept, guard: given = null } = {}) {
  // A guard made here is this download's own; a given one is its caller's.
  const guard = given !== null ? given : pageTargets(core)
  let wanted = toSet(deleted)
  let waiting = new Set(sortedSeqs(wanted))
  let inner = null
  let destroyed = false
  let unsettled = false // the type was unknown at the last refresh
  let chain = Promise.resolve()
  const refresh = (clear) => {
    const run = chain.then(async () => {
      if (destroyed) return []
      const next = wanted
      const skip = await guard.excludable(next)
      if (destroyed) return []
      unsettled = guard.page() === null
      const wait = new Set()
      for (const seq of sortedSeqs(next)) if (!skip.has(seq)) wait.add(seq)
      waiting = wait
      if (inner === null) {
        inner = make(core, skip)
        if (!clear) return []
      }
      return (await inner.update(skip)) || []
    })
    chain = run.catch(() => {})
    return run
  }
  const onDownload = (index) => {
    if (destroyed) return
    if (waiting.has(index) || (PAGE_GENESIS_SEQS.includes(index) && (waiting.size > 0 || unsettled))) refresh(true).catch(() => {})
  }
  core.on('download', onDownload)
  // A roster probe settled outside a refresh (a peer connected, a retry).
  const unwatch = typeof guard.watch === 'function' ? guard.watch(() => { refresh(true).catch(() => {}) }) : null
  refresh(false).catch(() => {})
  return {
    update (next) {
      if (destroyed) return Promise.resolve([])
      wanted = toSet(next)
      return refresh(true)
    },
    destroy () {
      if (destroyed) return
      destroyed = true
      core.off('download', onDownload)
      if (unwatch !== null) unwatch()
      if (given === null) guard.destroy()
      if (inner !== null) inner.destroy()
    },
    async idle () {
      await chain
      if (inner !== null && typeof inner.idle === 'function') await inner.idle()
    }
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
  downloadExceptPages,
  pageTargets,
  clearRanges
}
