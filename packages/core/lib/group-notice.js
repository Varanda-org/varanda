'use strict'

// Rules for group message notices (PR4): a seeder serving a group pushes
// the members of that group when a new message lands, through the account
// service. This module only decides; it holds no keys and does no I/O.
//
// createGroupHint folds the plaintext membership records of one group G and
// of its parent community C into a hint of who is a member now. It is NOT
// buildGroup (lib/group.js): it sees records one at a time, without causal
// order, joins or every core. It is built so that, on the same records, a
// diary it calls a member is one buildGroup calls a member; wherever the
// full fold depends on something the hint does not follow (causal order
// between cores, leave generations, a creator's leave, group-cut marks it
// was not given) it answers 'unknown' or leaves the diary out. A notice to
// a non-member would tell them a group they are not in is active; a missed
// notice only costs a push.
//
// Pure: no fs, no network, no Hypercore.

const b4a = require('b4a')
const sodium = require('sodium-universal')
const {
  MAX_GROUP_NAME, isHex64, isPlainObject, hasExactKeys, charLength, plainCopy
} = require('./records')
const { validateGroupRecord, validateWriterHeader } = require('./group')
const { displayText } = require('@varanda/rpc')

const UNKNOWN = 'unknown'
const GROUP_NOTICE_VERSION = 1
const GROUP_NOTICE_KEYS = ['v', 'kind', 'group', 'visibility', 'name', 'nid', 'recipients']
const MAX_NOTICE_RECIPIENTS = 64
const MAX_NOTICE_NAME = MAX_GROUP_NAME
const NID = /^[0-9a-f]{32}$/

// Estimates include the digest, keys, maps and node, then the folded entry
// and each retained cut/reference (including its memo maps). A 16-cut entry
// costs 9 KiB before seen/lifts; engine overhead varies. Marks pay the base
// too, so cannot grow uncharged.
const GROUP_HINT_BLOCK_BYTES = 512
const GROUP_HINT_ENTRY_BYTES = 512
const GROUP_HINT_REFERENCE_BYTES = 512
// Room for 256 members with 256 ordinary blocks each in both G and C,
// less the extra cost of their headers and membership records.
const MAX_GROUP_HINT_BYTES = 64 * 1024 * 1024
const GROUP_HINT_DIGEST_BYTES = 32
// Shared by indexing and every candidate in one unchanged state. A harder
// order/authority question costs a missed notice, never an unbounded walk.
const GROUP_HINT_WORK_PER_BLOCK = 64
const WORK_EXHAUSTED = Symbol('group hint work exhausted')

function createGroupHintBudget (limit) {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError('invalid hint budget')
  let held = 0
  return {
    held: () => held,
    take (bytes) {
      if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > limit - held) return false
      held += bytes
      return true
    },
    release (bytes) { held -= bytes }
  }
}

function blockDigest (copy) {
  const text = JSON.stringify(copy, (key, value) => {
    if (!isPlainObject(value)) return value
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, value[k]]))
  })
  const digest = b4a.alloc(GROUP_HINT_DIGEST_BYTES)
  sodium.crypto_generichash(digest, b4a.from(text))
  return digest
}

// Validation bounds refs to hex keys and safe integers and cuts to 16
// refs (leaves: 8). Keep only what the fold uses, never names or bodies.
function foldRecord (copy, seq) {
  if (seq === 0) return { type: copy.type, member: copy.member, rejoin: copy.rejoin }
  const record = { type: copy.type }
  for (const key of ['group', 'member', 'on', 'cuts', 'seen', 'lifts', 'join']) {
    if (Object.prototype.hasOwnProperty.call(copy, key)) record[key] = copy[key]
  }
  return record
}

// The records the hint folds; every other valid block is accepted and
// dropped (it can only bind a writer through its header).
const FOLDED = new Set(['group-admit', 'group-ban', 'group-admin', 'group-leave', 'group-meta'])
// The blocks a writer's cut keeps from the cut on (lib/group.js keptPastCut).
const KEPT_PAST_CUT = new Set(['group-leave', 'group-key'])
// Records that travel beside a core's records and are never nodes of the
// causal order (lib/group.js SIDE_TYPES).
const SIDE_TYPES = new Set(['group-react', 'group-topic', 'group-poll', 'group-choice', 'group-event'])
// The community records that become nodes of a group's order when they name
// it (lib/group.js communityLogs), leaves aside.
const VIRTUAL_TYPES = new Set(['group-admit', 'group-ban', 'group-hide', 'group-admin', 'group-invites'])

// Kleene logic over true, false and UNKNOWN.
function and3 (...xs) {
  let out = true
  for (const x of xs) {
    if (x === false) return false
    if (x !== true) out = UNKNOWN
  }
  return out
}

function or3 (...xs) {
  let out = false
  for (const x of xs) {
    if (x === true) return true
    if (x !== false) out = UNKNOWN
  }
  return out
}

function not3 (x) {
  return x === true ? false : x === false ? true : UNKNOWN
}

function cmp (a, b) {
  return a < b ? -1 : a > b ? 1 : 0
}

// Mirrors lib/group.js layerAt (not exported): events in order, each sets
// the state of the writers it lists from their cut on and of every other
// writer from `unlisted`.
function layerAt (events, writer, seq, step) {
  if (!events) return false
  for (let i = events.length - 1; i >= 0; i--) {
    step()
    const e = events[i]
    const c = e.cuts.has(writer) ? e.cuts.get(writer) : e.unlisted
    if (c <= seq) return e.on
  }
  return false
}

function cutsMap (cuts, step) {
  const m = new Map()
  for (const c of cuts) {
    step()
    m.set(c.writer, c.seq)
  }
  return m
}

function pushTo (map, k, v) {
  const list = map.get(k)
  if (list) list.push(v)
  else map.set(k, [v])
}

// The blocks a record names (lib/group.js referencesOf, for the types the
// hint folds): each orders the record after that block and every earlier
// block of its core.
function refsOf (record, step) {
  const refs = []
  if (record.seen) refs.push(record.seen)
  if (Array.isArray(record.cuts)) {
    for (const c of record.cuts) {
      step()
      if (c.seq >= 1) refs.push({ writer: c.writer, seq: c.seq - 1 })
    }
  }
  if (record.type === 'group-ban' && record.lifts) refs.push(record.lifts)
  return refs
}

// Whether `a` is known to come after `b`: on the same core at a higher seq,
// or naming `b` (or a later block of its core) directly. The fold ignores a
// reference past the last node it holds of that core, so one past
// `lastOf(writer)` orders nothing. Mutual references are UNKNOWN: the fold
// breaks cycles by causalOrder, which the hint does not run. No transitive
// closure: anything else is undecided.
function after (a, b, lastOf, step) {
  step()
  if (a.writer === b.writer) return a.seq > b.seq
  const names = (x, y) => {
    const last = lastOf(y.writer)
    return refsOf(x.record, step).some((r) => {
      step()
      return r.writer === y.writer && r.seq >= y.seq && r.seq <= last
    })
  }
  if (!names(a, b)) return false
  return names(b, a) ? UNKNOWN : true
}

function validConfig (c) {
  return isPlainObject(c) && isHex64(c.key) && isHex64(c.creator) && (c.join === 'open' || c.join === 'approval')
}

// One group's membership hint. `group`, `creator`, `join` and `visibility`
// come from G's root header; `community` is { key, creator, join } from the
// parent community's root header (every v2 group has one). A bad config
// makes every answer unknown. maxBytes can lower the local limit; budget
// shares bytes across hints, including marks that may arrive before blocks.
function createGroupHint ({ group, creator, join, visibility = 'public', community, maxBytes = MAX_GROUP_HINT_BYTES, budget = null } = {}) {
  const priv = visibility === 'private'
  const configOk = isHex64(group) && isHex64(creator) && (join === 'open' || join === 'approval') &&
    (visibility === 'public' || (priv && join === 'approval')) && validConfig(community) &&
    community.key !== group
  const G = configOk ? group : null
  const C = configOk ? community.key : null
  community = configOk ? { key: C, creator: community.creator, join: community.join } : null
  maxBytes = Number.isSafeInteger(maxBytes) && maxBytes >= 0 ? Math.min(maxBytes, MAX_GROUP_HINT_BYTES) : 0
  // writer:seq -> { writer, seq, diary, community, record }
  const entries = new Map()
  // writer:diary -> lowest cut a mark of that diary gave.
  const marks = new Map()
  // Writers whose block 0 does not count here.
  const refused = new Set()
  // writer -> seq -> { kept, virtual }: the blocks the fold makes nodes of
  // its causal order, so a reference is judged against what a core holds.
  const nodes = new Map()
  // writer:seq -> { diary, digest } of every block fed, valid or not: a seq
  // two copies disagree on is a fork (lib/group.js mergeCopies drops the
  // whole core), and the seqs held decide the prefix the fold reads.
  const blocks = new Map()
  let tainted = !configOk
  let memo = null
  let heldBytes = 0
  let work = 0
  let workLimit = 0

  function step () {
    if (work >= workLimit) throw WORK_EXHAUSTED
    work++
  }

  function bounded (fn) {
    try { return fn() } catch (err) {
      if (err !== WORK_EXHAUSTED) throw err
      return UNKNOWN
    }
  }

  function take (bytes) {
    if (bytes > maxBytes - heldBytes || (budget !== null && !budget.take(bytes))) {
      incomplete()
      return false
    }
    heldBytes += bytes
    return true
  }

  // Feeds one block of one of G's cores (`community` false) or C's cores
  // (`community` true): `writer` is the core key, `seq` the block's seq and
  // `diary` the diary that core belongs to. Block 0 of every writer core
  // must be fed: a writer counts only through its header, and a folded
  // record on a writer with no header yet makes every answer unknown.
  // Returns whether the block was valid for that core. Never throws.
  function add (record, { diary, writer, seq, community: onC = false } = {}) {
    try {
      if (tainted || !isHex64(diary) || !isHex64(writer) || !Number.isSafeInteger(seq) || seq < 0) return false
      const scopeKey = onC === true ? C : G
      const root = writer === scopeKey
      if (writer === (onC === true ? G : C)) return false
      if (root && diary !== (onC === true ? community.creator : creator)) return false
      const k = writer + ':' + seq
      const held = blocks.get(k)
      const copy = plainCopy(record)
      if (copy === null) return false
      const digest = blockDigest(copy)
      if (held === undefined) {
        if (!take(GROUP_HINT_BLOCK_BYTES)) return false
        blocks.set(k, { diary, digest })
        memo = null
      } else if (held.diary !== diary || !b4a.equals(held.digest, digest)) {
        incomplete()
        return false
      }
      if (seq === 0) {
        if (root) return true
        // header-invalid in lib/group.js bindCores: a group writer names its
        // CW in C, a community writer none, and a box goes with privacy.
        const valid = validateWriterHeader(copy) === null
        // The fold binds a writer to the diary its header names: fed for
        // another one, the caller's view is wrong.
        if (valid && copy.group === scopeKey && copy.diary !== diary) {
          incomplete()
          return false
        }
        const fits = valid && copy.group === scopeKey &&
          (copy.member === null) === (onC === true) && (copy.box !== null) === (onC !== true && priv)
        if (!fits) {
          // Its records count for no one; one valid and one refused block 0
          // is a fork.
          if (!refused.has(writer)) {
            refused.add(writer)
            memo = null
          }
          return false
        }
      } else if (validateGroupRecord(copy, seq, { root, community: onC === true, private: onC !== true && priv }) !== null) {
        return false
      } else {
        if (!SIDE_TYPES.has(copy.type)) {
          let m = nodes.get(writer)
          if (!m) nodes.set(writer, (m = new Map()))
          const virtual = copy.type === 'group-leave' || (VIRTUAL_TYPES.has(copy.type) && copy.group === G)
          if (!m.has(seq)) {
            m.set(seq, { kept: KEPT_PAST_CUT.has(copy.type), virtual })
            memo = null
          }
        }
        if (!FOLDED.has(copy.type)) return true
      }
      if (entries.has(k)) return true
      const folded = foldRecord(copy, seq)
      const references = (folded.cuts ? folded.cuts.length : 0) +
        (folded.seen ? 1 : 0) + (folded.lifts ? 1 : 0) + (folded.rejoin ? 1 : 0)
      if (!take(GROUP_HINT_ENTRY_BYTES + references * GROUP_HINT_REFERENCE_BYTES)) return false
      entries.set(k, { writer, seq, diary, community: onC === true, record: folded })
      memo = null
      return true
    } catch {
      // A block this could not judge may be a ban: never answer as if it
      // were not there.
      incomplete()
      return false
    }
  }

  // A diary's group-cut mark (lib/records.js group-cut): writer records
  // stop counting, leaves excepted; roots have separate authority rules.
  function mark (diary, writer, cut) {
    if (tainted || !isHex64(diary) || !isHex64(writer) || !Number.isSafeInteger(cut) || cut < 0) return false
    // Kept per (writer, diary): only the writer's own diary cuts it, and its
    // header, which may come later, says which diary that is.
    const k = writer + ':' + diary
    if (marks.has(k) && marks.get(k) <= cut) return true
    if (!marks.has(k) && !take(GROUP_HINT_BLOCK_BYTES)) return false
    marks.set(k, cut)
    memo = null
    return true
  }

  // The caller's view lacks something the fold would need (a core it
  // could not read, a writer cap it hit): every answer is unknown from now on.
  function incomplete () {
    tainted = true
    memo = null
    if (budget !== null) budget.release(heldBytes)
    heldBytes = 0
    blocks.clear()
    entries.clear()
    nodes.clear()
    refused.clear()
    marks.clear()
  }

  function state () {
    // Boxed: an unknown hint (null) is a result too.
    if (memo === null) {
      work = 0
      workLimit = GROUP_HINT_WORK_PER_BLOCK * (blocks.size + 1)
      const value = bounded(evaluate)
      memo = { value: value === UNKNOWN ? null : value, members: null }
    }
    return memo.value
  }

  function evaluate () {
    if (tainted) return null
    const Cc = community.creator
    const layer = (events, writer, seq) => layerAt(events, writer, seq, step)
    const ordered = (a, b, lastOf) => after(a, b, lastOf, step)
    // Writer headers: writer -> diary, per scope.
    const writerDiary = new Map([[G, creator], [C, Cc]])
    const headers = { g: [], c: [] }
    for (const e of entries.values()) {
      step()
      if (e.seq !== 0) continue
      writerDiary.set(e.writer, e.diary)
      headers[e.community ? 'c' : 'g'].push(e)
    }
    const cutOf = (writer) => {
      const k = writer + ':' + writerDiary.get(writer)
      return marks.has(k) ? Math.max(marks.get(k), 1) : Infinity
    }
    const isRoot = (writer) => writer === G || writer === C
    // How many blocks from 0 on the hint holds of a core (lib/group.js
    // heldPrefix); a root's header comes with the config.
    const prefixes = new Map()
    const prefixOf = (writer) => {
      if (prefixes.has(writer)) return prefixes.get(writer)
      let n = isRoot(writer) ? 1 : 0
      while (blocks.has(writer + ':' + n)) {
        step()
        n++
      }
      prefixes.set(writer, n)
      return n
    }
    // Whether the fold keeps a writer's block (lib/group.js bindCores): up to
    // its first hole and its cut, and past both only leaves and keys once
    // the hole is at or past the cut. A root keeps its held prefix.
    const keeps = (writer, seq, type) => {
      const prefix = prefixOf(writer)
      if (isRoot(writer)) return seq < prefix
      const end = cutOf(writer)
      return seq < Math.min(prefix, end) || (prefix >= end && KEPT_PAST_CUT.has(type))
    }
    // The last node the fold holds of a core: of a community core inside G,
    // only the records it adds to G's order (`virtual`).
    const lastNodes = { all: new Map(), virtual: new Map() }
    const lastNode = (writer, virtualOnly) => {
      const cache = lastNodes[virtualOnly ? 'virtual' : 'all']
      if (cache.has(writer)) return cache.get(writer)
      const m = nodes.get(writer)
      if (!m) return 0
      let last = 0
      for (const [seq, n] of m) {
        step()
        if (seq > last && (!virtualOnly || n.virtual) && keeps(writer, seq, n.kept ? 'group-leave' : null)) last = seq
      }
      cache.set(writer, last)
      return last
    }
    // Per writer: 'ok' (it counts), 'bad' (it never counts) or 'pending'
    // (it may count once more is fed). Roots count.
    const status = new Map([[G, 'ok'], [C, 'ok']])
    // lib/group.js checkRejoins: a rejoin counts only when it names a
    // group-leave of the same diary on a writer that counts.
    const resolveRejoins = (list) => {
      const open = []
      for (const e of list) {
        step()
        if (e.record.rejoin === null) status.set(e.writer, 'ok')
        else open.push(e)
      }
      const waiting = new Map()
      const known = new Set(list.map((e) => e.writer))
      for (const e of open) {
        step()
        pushTo(waiting, e.record.rejoin.writer, e)
      }
      const queue = open.slice()
      for (let i = 0; i < queue.length; i++) {
        step()
        const e = queue[i]
        if (status.has(e.writer)) continue
        const ref = e.record.rejoin
        const st = status.get(ref.writer)
        let next = null
        if (st === 'bad' || refused.has(ref.writer)) next = 'bad'
        else if (st === 'ok' && ref.seq <= lastNode(ref.writer, false)) {
          const hit = entries.get(ref.writer + ':' + ref.seq)
          next = writerDiary.get(ref.writer) === e.diary && hit && hit.record.type === 'group-leave' &&
            keeps(ref.writer, ref.seq, 'group-leave')
            ? 'ok'
            : 'bad'
        }
        if (next !== null) {
          status.set(e.writer, next)
          for (const dependent of waiting.get(e.writer) || []) {
            step()
            queue.push(dependent)
          }
          waiting.delete(e.writer)
        }
      }
      for (const e of open) {
        step()
        if (status.has(e.writer)) continue
        // Naming a writer of this scope that never counts is invalid; one
        // not known yet may still come.
        const named = status.get(e.record.rejoin.writer)
        status.set(e.writer, named === undefined && !known.has(e.record.rejoin.writer) ? 'pending' : 'bad')
      }
    }
    resolveRejoins(headers.c)
    const cWriters = new Set([C, ...headers.c.map((e) => e.writer)])
    const cwOfG = new Map(headers.g.map((e) => [e.writer, e.record.member]))
    // lib/group.js bindCores: a group writer counts only through a counted
    // CW of its own diary (C's root stands for its creator's).
    const gCands = []
    for (const e of headers.g) {
      step()
      const m = e.record.member
      const st = m === C ? 'ok' : refused.has(m) ? 'bad' : status.get(m)
      if (st === 'ok' && cWriters.has(m)) {
        if (writerDiary.get(m) === e.diary) gCands.push(e)
        else status.set(e.writer, 'bad')
      } else if (st === 'bad' || (st === 'ok' && m !== C)) {
        status.set(e.writer, 'bad')
      } else {
        status.set(e.writer, 'pending')
      }
    }
    resolveRejoins(gCands)

    const rejoins = { g: new Map(), c: new Map() }
    const writersOf = { g: new Map([[creator, [G]]]), c: new Map([[Cc, [C]]]) }
    for (const s of ['g', 'c']) {
      for (const e of headers[s]) {
        step()
        if (status.get(e.writer) !== 'ok') continue
        pushTo(writersOf[s], e.diary, e.writer)
        if (e.record.rejoin !== null) {
          let set = rejoins[s].get(e.diary)
          if (!set) rejoins[s].set(e.diary, (set = new Set()))
          set.add(e.record.rejoin.writer + ':' + e.record.rejoin.seq)
        }
      }
    }
    const counted = []
    for (const e of entries.values()) {
      step()
      if (e.seq === 0 || refused.has(e.writer) || status.get(e.writer) === 'bad') continue
      // A writer counts only through its header. A record whose header is
      // missing, fed for another diary than the header names, or on a
      // writer that may still count, may be a ban the hint would miss.
      if (writerDiary.get(e.writer) !== e.diary || status.get(e.writer) !== 'ok') return null
      // Past a hole in a root the hint cannot tell what the fold reads.
      if (isRoot(e.writer) && e.seq >= prefixOf(e.writer)) return null
      // C ignores root marks. G keeps the records but voids authority;
      // deciding that needs the creator's diary history the hint lacks.
      if (e.writer === G && e.seq >= cutOf(G)) return null
      if (!keeps(e.writer, e.seq, e.record.type)) continue
      counted.push(e)
    }

    const leaves = { g: new Map(), c: new Map() }
    const grants = { g: new Map(), c: new Map() }
    const bans = { g: new Map(), c: new Map() }
    const admits = { g: new Map(), c: new Map() }
    const unbans = { g: new Map(), c: new Map() }
    const everAdmin = { g: new Set([creator]), c: new Set([Cc]) }
    const pending = []
    const metas = { g: null, c: null }
    for (const e of counted) {
      step()
      const r = e.record
      const t = r.type
      if (t === 'group-leave') {
        pushTo(leaves[e.community ? 'c' : 'g'], e.diary, e)
        continue
      }
      // A community core acts in C (`group: null`, or no `group` key on its
      // root's grants and metas) or inside one of its groups; only those
      // naming G matter here.
      const g = Object.prototype.hasOwnProperty.call(r, 'group') ? r.group : null
      let s
      if (!e.community) s = 'g'
      else if (g === null) s = 'c'
      else if (g === G) s = 'g'
      else continue
      if (t === 'group-meta') {
        // Root only (a CW meta is a returning creator's repair, void while
        // the creator has not left, and a creator leave makes all unknown).
        if (e.writer === (e.community ? C : G) && s === (e.community ? 'c' : 'g') &&
          (metas[s] === null || e.seq > metas[s].seq)) metas[s] = e
      } else if (t === 'group-admin') {
        // Grants live on the scope's own root; a CW demotion is a returning
        // creator's repair (see group-meta).
        if (e.writer !== (s === 'c' ? C : G) || r.member === (s === 'c' ? Cc : creator)) continue
        pushTo(grants[s], r.member, { seq: e.seq, on: r.on, cuts: cutsMap(r.cuts, step), unlisted: r.on ? Infinity : 0 })
        if (r.on) everAdmin[s].add(r.member)
      } else if (t === 'group-ban' || t === 'group-admit') {
        pending.push({ s, e })
      }
    }
    // Root grants are now complete. An ordinary member's references cannot
    // matter to membership ordering, even when they name many other cores.
    for (const { s, e } of pending) {
      step()
      if (!everAdmin[e.community ? 'c' : 'g'].has(e.diary)) continue
      const r = e.record
      if (r.type === 'group-admit') pushTo(admits[s], r.member, e)
      else if (r.on) pushTo(bans[s], r.member, e)
      else pushTo(unbans[s], r.member + ':' + r.lifts.writer + ':' + r.lifts.seq, e)
    }
    for (const s of ['g', 'c']) {
      for (const events of grants[s].values()) {
        events.sort((a, b) => {
          step()
          return a.seq - b.seq
        })
      }
    }
    // A creator's leave ends its powers through cuts, confirms and marks
    // the hint does not follow.
    if (leaves.g.has(creator) || leaves.c.has(creator) || leaves.c.has(Cc)) return null

    const memoC = new Map()
    const memoG = new Map()
    const hasBan = (s, d) => bans[s].has(d)
    // Leaving: false for a diary whose every leave a rejoin names (rejoining
    // brings in generations the hint does not follow), true with any leave
    // no rejoin names.
    const leftIn = (s, d) => {
      const list = leaves[s].get(d)
      if (!list) return false
      const named = rejoins[s].get(d)
      const rejoined = list.every((L) => {
        step()
        return named && named.has(L.writer + ':' + L.seq)
      })
      return rejoined ? UNKNOWN : true
    }
    const grantsNow = { g: new Map(), c: new Map() }
    const grantNow = (s, d) => {
      if (!grantsNow[s].has(d)) {
        grantsNow[s].set(d, (writersOf[s].get(d) || []).some((w) => {
          step()
          return layer(grants[s].get(d), w, Number.MAX_SAFE_INTEGER)
        }))
      }
      return grantsNow[s].get(d)
    }

    // C: whether d is a member of the community now.
    const cAdminNow = (d) => d === Cc || grantNow('c', d)
    const cShielded = (d) => cAdminNow(d)
    // Authority of a block on a community core, as a virtual node of G or
    // in C itself: the creator, or an admin by the root's grants at that
    // block who is not banned in C. Leaving voids authority.
    const authC = (e) => {
      const d = e.diary
      if (d === Cc) return true
      if (!layer(grants.c.get(d), e.writer, e.seq)) return false
      if (leaves.c.has(d)) return UNKNOWN
      return cShielded(d) || !hasBan('c', d) ? true : UNKNOWN
    }
    const cMember = (d) => {
      if (memoC.has(d)) return memoC.get(d)
      memoC.set(d, false)
      let out
      if (d === Cc) out = true
      else if (!writersOf.c.has(d)) out = false
      else {
        const banned = bannedIn('c', d, authC, cShielded)
        const approval = approvalOf('c')
        out = and3(not3(banned), not3(leftIn('c', d)), or3(not3(approval), admittedIn('c', d, authC, cShielded), cAdminNow(d)))
      }
      memoC.set(d, out)
      return out
    }
    // A C admin as G sees it (lib/group.js adminC): the creator, or a
    // granted admin who is a member.
    const adminC = (d) => d === Cc ? true : and3(grantNow('c', d), cMember(d))

    // G: the creator's root counts while the creator is in C (rootLive).
    const rootLive = () => cMember(creator)
    const gAdminNow = (d) => and3(grantNow('g', d), rootLive(), cMember(d))
    const gShielded = (d) => or3(d === creator ? rootLive() : false, gAdminNow(d), adminC(d))
    const authG = (e) => {
      if (e.community) return authC(e)
      const d = e.diary
      // The fold gates every non-root writer by its own CW, even when
      // another device brought its diary back into C after a ban.
      const live = e.writer === G ? rootLive() : and3(cMember(d), cwLive(cwOfG.get(e.writer), d))
      if (d === creator) return and3(rootLive(), live)
      const granted = and3(layer(grants.g.get(d), e.writer, e.seq), rootLive(), live)
      if (granted === false) return false
      if (leaves.g.has(d) || leaves.c.has(d)) return UNKNOWN
      const notBanned = gAdminNow(d) === true || !hasBan('g', d) ? true : UNKNOWN
      return and3(granted, cMember(d), notBanned)
    }
    // lib/group.js `live`: a G writer counts while the CW it names is
    // admitted in C and no C ban layer covers it. C's root stands for its
    // creator, who is never banned; retired CWs need a leave in C, which
    // already keeps the diary out of C here.
    const cwLive = (cw, d) => {
      step()
      if (!cWriters.has(cw)) return UNKNOWN
      if (cw === C || d === Cc) return true
      const admitted = or3(not3(approvalOf('c')), admittedIn('c', d, authC, cShielded, cw),
        layer(grants.c.get(d), cw, Number.MAX_SAFE_INTEGER))
      return and3(admitted, not3(bannedIn('c', d, authC, cShielded, cw)))
    }
    const hasLive = (d) => {
      let out = false
      for (const w of writersOf.g.get(d) || []) {
        step()
        out = or3(out, cwLive(cwOfG.get(w), d))
        if (out === true) break
      }
      return out
    }
    const gMember = (d) => {
      if (memoG.has(d)) return memoG.get(d)
      let out
      if (d !== creator && !writersOf.g.has(d)) out = false
      else {
        const inC = cMember(d)
        if (d === creator) out = inC
        else {
          const banned = bannedIn('g', d, authG, gShielded)
          const approval = priv ? true : approvalOf('g')
          const admitted = or3(admittedIn('g', d, authG, gShielded), gAdminNow(d), adminC(d))
          out = and3(inC, hasLive(d), not3(banned), not3(leftIn('g', d)), or3(not3(approval), admitted))
        }
      }
      memoG.set(d, out)
      return out
    }

    // The order edges of a scope reach only the nodes the fold holds.
    const lastOfScope = (s) => (w) => lastNode(w, s === 'g' && cWriters.has(w))

    // Banned: some counted ban no counted unban after it lifts. The fold
    // only lifts the latest ban; reading "any ban left standing" is never
    // looser. With `w`, whether the ban layer covers that writer: an unban
    // frees only the writers its cuts list (lib/group.js bannedCws).
    const banMemo = new Map()
    const admitMemo = new Map()
    function bannedIn (s, d, auth, shielded, w = null) {
      const key = s + ':' + d + ':' + w
      if (banMemo.has(key)) return banMemo.get(key)
      const list = bans[s].get(d) || []
      const sh = shielded(d)
      const eff = (e) => and3(auth(e), not3(sh))
      const lastOf = lastOfScope(s)
      let out = false
      for (const b of list) {
        step()
        const active = eff(b)
        if (active === false) continue
        let lifted = false
        for (const u of unbans[s].get(d + ':' + b.writer + ':' + b.seq) || []) {
          step()
          if (w !== null && !u.record.cuts.some((c) => {
            step()
            return c.writer === w
          })) continue
          const authority = eff(u)
          if (authority === false) continue
          lifted = or3(lifted, and3(authority, ordered(u, b, lastOf)))
          if (lifted === true) break
        }
        out = or3(out, and3(active, not3(lifted)))
        if (out === true) break
      }
      banMemo.set(key, out)
      return out
    }

    // Admitted: the last counted admit is on. Admits on different cores with
    // no reference between them have no order the hint can see.
    // With `w`, whether the admit layer covers that writer: an admit takes
    // in only the writers its cuts list (the fold's automatic cuts for new
    // devices only add to that).
    function admittedIn (s, d, auth, shielded, w = null) {
      const key = s + ':' + d + ':' + w
      if (admitMemo.has(key)) return admitMemo.get(key)
      const result = admitsFor(s, d, auth, shielded, w)
      admitMemo.set(key, result)
      return result
    }

    function admitsFor (s, d, auth, shielded, w) {
      const eff = (e) => e.record.on
        ? (e.diary === d ? false : auth(e))
        : and3(auth(e), not3(shielded(d)))
      const ons = []
      const offs = []
      const writers = new Set()
      let lastOff = -1
      let lastSureOff = -1
      for (const e of admits[s].get(d) || []) {
        step()
        if (w !== null && e.record.on && !e.record.cuts.some((c) => {
          step()
          return c.writer === w
        })) continue
        const x = eff(e)
        if (x === false) continue
        writers.add(e.writer)
        if (e.record.on) ons.push({ e, x })
        else {
          offs.push({ e, x })
          lastOff = Math.max(lastOff, e.seq)
          if (x === true) lastSureOff = Math.max(lastSureOff, e.seq)
        }
      }
      if (ons.length === 0) return false
      // One core has a total order. Across cores, only attempt a bounded
      // number of pairs; a dense order question leaves this diary unknown.
      if (writers.size > 1 && ons.length * offs.length > 2 * (ons.length + offs.length)) return UNKNOWN
      const lastOf = lastOfScope(s)
      let result = false
      for (const a of ons) {
        step()
        if (writers.size === 1) {
          if (a.e.seq > lastOff) result = or3(result, a.x)
          else if (a.e.seq >= lastSureOff) result = or3(result, UNKNOWN)
        } else if (offs.every((o) => ordered(a.e, o.e, lastOf) === true)) {
          result = or3(result, a.x)
        } else if (!offs.some((o) => o.x === true && ordered(o.e, a.e, lastOf) === true)) {
          result = or3(result, UNKNOWN)
        }
        if (result === true) break
      }
      return result
    }

    // Whether the scope asks for approval: the root's last meta while its
    // creator holds it, else the header's join.
    function approvalOf (s) {
      const header = s === 'c' ? community.join : join
      const meta = metas[s]
      const live = s === 'c' ? true : rootLive()
      const now = meta !== null ? meta.record.join : header
      if (live === true) return now === 'approval'
      if (live === false) return header === 'approval'
      return now === header ? header === 'approval' : UNKNOWN
    }

    const candidates = new Set([...writersOf.g.keys()].sort((a, b) => {
      step()
      return cmp(a, b)
    }))
    const member = (d) => {
      if (!memoG.has(d)) {
        memoG.set(d, bounded(() => {
          step()
          return gMember(d)
        }))
      }
      return memoG.get(d)
    }
    return { gMember: member, candidates }
  }

  return {
    add,
    mark,
    incomplete,
    // Deterministic visits/comparisons in the memoized evaluation, for
    // bounded-work tests without depending on machine speed.
    work () { return work },
    held () {
      let digestBytes = 0
      for (const block of blocks.values()) digestBytes += block.digest.byteLength
      return { blocks: blocks.size, marks: marks.size, entries: entries.size, writers: nodes.size, refused: refused.size, digestBytes, bytes: heldBytes }
    },
    // true, false or 'unknown': whether `diary` is a member of G now.
    allowed (diary) {
      if (!isHex64(diary)) return false
      const s = state()
      return s === null ? UNKNOWN : s.candidates.has(diary) ? s.gMember(diary) : false
    },
    // The diaries the hint is sure are members, sorted; null when the hint
    // cannot decide at all. A diary it cannot decide is left out.
    members () {
      const s = state()
      if (s === null) return null
      if (memo.members === null) memo.members = [...s.candidates].filter((d) => s.gMember(d) === true)
      return memo.members.slice()
    }
  }
}

// Whether a valid block of G (plaintext as stored) is a message to notify
// about: a public post, or any sealed envelope of a private group (a post,
// hide, meta or reaction inside cannot be told apart from outside).
function noticeFor (record, { private: priv = false } = {}) {
  try {
    if (!isPlainObject(record)) return false
    const type = priv === true ? 'group-sealed' : 'group-post'
    if (record.type !== type) return false
    return validateGroupRecord(record, 1, { private: priv === true }) === null
  } catch {
    return false
  }
}

// A group name fit for a notice, or null: a string of 1..MAX_NOTICE_NAME
// code points that displays as itself and is not blank.
function noticeName (name) {
  if (typeof name !== 'string') return null
  const n = charLength(name)
  if (n < 1 || n > MAX_NOTICE_NAME || name.trim() === '') return null
  return displayText(name) === name ? name : null
}

function validRecipients (list) {
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_NOTICE_RECIPIENTS) return false
  const seen = new Set()
  for (let i = 0; i < list.length; i++) {
    const k = list[i]
    if (!isHex64(k) || seen.has(k)) return false
    seen.add(k)
  }
  return true
}

// The seeder's event to the account service. True only for exactly
// { v: 1, kind: 'group', group, visibility, name, nid, recipients }: no
// author, a name only for a public group (null for private), `nid` the
// seeder's opaque per-block id. Never throws.
function validateGroupNotice (event) {
  try {
    if (!isPlainObject(event) || !hasExactKeys(event, GROUP_NOTICE_KEYS)) return false
    if (event.v !== GROUP_NOTICE_VERSION || event.kind !== 'group' || !isHex64(event.group)) return false
    if (event.visibility === 'private') {
      if (event.name !== null) return false
    } else if (event.visibility === 'public') {
      if (event.name !== null && noticeName(event.name) === null) return false
    } else {
      return false
    }
    if (typeof event.nid !== 'string' || !NID.test(event.nid)) return false
    return validRecipients(event.recipients)
  } catch {
    return false
  }
}

// The notice text (pt-BR). A private group's name never leaves it.
function groupSentence ({ visibility, name } = {}) {
  if (visibility === 'private') return 'Nova mensagem num grupo privado'
  const n = visibility === 'public' ? noticeName(name) : null
  return n === null ? 'Nova mensagem num grupo' : 'Nova mensagem em ' + n
}

module.exports = {
  UNKNOWN,
  GROUP_NOTICE_VERSION,
  MAX_NOTICE_RECIPIENTS,
  MAX_NOTICE_NAME,
  MAX_GROUP_HINT_BYTES,
  GROUP_HINT_BLOCK_BYTES,
  GROUP_HINT_ENTRY_BYTES,
  GROUP_HINT_REFERENCE_BYTES,
  GROUP_HINT_DIGEST_BYTES,
  GROUP_HINT_WORK_PER_BLOCK,
  createGroupHintBudget,
  createGroupHint,
  noticeFor,
  noticeName,
  validateGroupNotice,
  groupSentence
}
