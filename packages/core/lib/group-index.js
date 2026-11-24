'use strict'

// Group index of a seeder (docs/protocol.md section 10): which writer cores
// belong to which group, which groups each diary joined and the display
// and folded names of each PUBLIC group root (a private root has none). It lives IN MEMORY only, fed by the
// seeder's diary scan and its group admissions (lib/seeder.js), and only
// says WHERE TO LOOK: a member re-reads and gates every writer and every
// header from the cores themselves (groups-net.js, the /index routes).
//
// A writer stays listed after its diary withdraws the join (`left`): leaving
// never purges a core (the moderation record of a departed member stays
// verifiable), so the index keeps answering for it.
//
// Bounds: maxGroups groups and maxWritersPerGroup writers per group. A NEW
// group or writer past a cap is refused (false, nothing stored); existing
// entries always update. Pure and total: no I/O, no timers, and no method
// ever throws (a hostile argument answers false / null / empty).
//
// Communities (docs/protocol.md section 10, "Catalogue hints"): a group
// header names its parent community for good (or none: a standalone group,
// which no community attaches), and only the community's
// creator creates groups. For each served community root the seeder folds
// its group-meta, group-image, group-about and group-create records once, in
// log order (foldRoot); a public group root folds its group-meta, group-image
// and group-about. A group is attached while its header names C, its header
// diary is C's creator and C's catalogue hint lists it (catalogueOf). Like everything here it is a
// hint: lib/group.js judges each create at its position.
//
// The creator's other devices write the charter too (docs/protocol.md,
// "Charter from the creator's other devices"): the seeder also folds the
// group-meta, group-image and group-about of the writers bound by the root's
// diary below their diary cut (foldCharter), one source per core. Each shown
// value is ranked by anchor as the fold orders charter (pickCharter), with
// no authority fold. A community's CWs of that diary add their group-create
// records after the root's, and a group-leave on one of them lists the
// root's alone (catalogueOf).
const { MAX_GROUP_WRITERS, MAX_GROUPS_PER_DIARY, MAX_GROUPS_PER_COMMUNITY } = require('./records')
const { foldTokens, parseQuery, searchRank, RESULTS_MAX } = require('./search-text')
const { isStandaloneHeader } = require('./group')

const DEFAULT_MAX_GROUPS = 4096
const BROWSE_MAX = RESULTS_MAX
const RECENT_PER_CREATOR = 2
const PUBLIC_GROUPS_PAGE = 32
const TREND_WINDOW_MS = 604800000
const TREND_MIN_ACTIVE = 2
// Same clock tolerance as lib/group.js.
const MAX_FUTURE_MS = 86400000
// A header date is the creator's own claim, so a later date must not buy a
// better place in 'recent'; 5 minutes covers ordinary device clock drift.
const CREATED_SKEW_MS = 300000
const PAGE_MAX = 64
const HEX64 = /^[0-9a-f]{64}$/

function isHex64 (s) {
  return typeof s === 'string' && HEX64.test(s)
}

function cmp (a, b) {
  return a < b ? -1 : a > b ? 1 : 0
}

function validSeq (seq) {
  return Number.isSafeInteger(seq) && seq >= 1
}

function createdOf (at) {
  if (typeof at !== 'string') return null
  const ms = Date.parse(at)
  return Number.isSafeInteger(ms) && ms >= 0 && new Date(ms).toISOString() === at ? ms : null
}

function shown (fn, ...args) {
  if (typeof fn !== 'function') return true
  try {
    return fn(...args) === true
  } catch {
    return false
  }
}

function charterAt (at) {
  if (typeof at !== 'string') return NaN
  const ms = Date.parse(at)
  return Number.isSafeInteger(ms) ? ms : NaN
}

// The winning entry of one field (docs/protocol.md, "Charter from the
// creator's other devices"), or null. `root`: the root's latest record of
// the field ({ seq } or null). `siblings`: Map key -> { entry: { seq, seen,
// at, anchorAt }, cutAt, live }, the latest record of each creator-bound
// sibling below its applied cut (cutAt: that cut's `at` in ms, null with
// none; live: its row is not left). The fold places a sibling's record at
// what its `seen` names: a root seq s held here (rootLength) ranks s + 0.5,
// the latest same-field record of another such sibling ranks as that
// record one level deeper (a cycle names nothing), anything else ranks below
// every root record. `at` ranks nothing. A record that does not count (left,
// or past its cut) voids only itself: one naming it still ranks through it.
// A chain's trusted `at` is the greatest of its root anchor's and of every
// counted record's in it; under a cut a record counts only when the greater
// of its own `at` and that trusted `at` is at or below the cut's `at`, else
// its source offers nothing. A record whose chain passes a record that does
// not count ranks below the root unless that trusted `at` is at or below its
// own. With rootCut the root alone answers. The highest rank wins, then
// depth, writer key and seq, the greater as in the fold.
function pickCharter (root, rootKey, siblings, rootLength, rootCut) {
  const memo = new Map()
  const info = (key, visiting) => {
    if (memo.has(key)) return memo.get(key)
    const floor = { anchored: null, counts: false }
    if (visiting.has(key)) return floor
    visiting.add(key)
    const s = siblings.get(key)
    const e = s.entry
    const seen = e.seen
    let a = null
    if (seen !== null && typeof seen === 'object' && Number.isSafeInteger(seen.seq) && seen.seq >= 0) {
      if (seen.writer === rootKey) {
        if (seen.seq < rootLength) a = { rank: seen.seq + 0.5, depth: 1, trusted: e.anchorAt, broken: false }
      } else if (seen.writer !== key && siblings.has(seen.writer) && siblings.get(seen.writer).entry.seq === seen.seq) {
        const q = info(seen.writer, visiting)
        if (q.anchored !== null) {
          const p = q.anchored
          const trusted = q.counts ? Math.max(p.trusted, siblings.get(seen.writer).entry.at) : p.trusted
          a = { rank: p.rank, depth: p.depth + 1, trusted, broken: p.broken || !q.counts }
        }
      }
    }
    if (a !== null && a.broken && !(a.trusted <= e.at)) a = null
    const bound = a === null ? e.at : Math.max(e.at, a.trusted)
    const r = { anchored: a, counts: s.live !== false && (s.cutAt === null || (Number.isFinite(bound) && bound <= s.cutAt)) }
    visiting.delete(key)
    memo.set(key, r)
    return r
  }
  let best = root === null ? null : { key: rootKey, rank: Number.isSafeInteger(root.seq) ? root.seq : 0, depth: 0, seq: root.seq, entry: root }
  if (rootCut) return best === null ? null : best.entry
  for (const [key, s] of siblings) {
    const c = info(key, new Set())
    if (!c.counts) continue
    const a = c.anchored
    const cand = { key, rank: a === null ? -Infinity : a.rank, depth: a === null ? 0 : a.depth, seq: s.entry.seq, entry: s.entry }
    if (best === null || cand.rank > best.rank || (cand.rank === best.rank && (cand.depth > best.depth ||
      (cand.depth === best.depth && (cand.key > best.key || (cand.key === best.key && cand.seq > best.seq)))))) best = cand
  }
  return best === null ? null : best.entry
}

function count (fn, key) {
  if (typeof fn !== 'function') return 0
  try {
    const n = fn(key)
    return Number.isSafeInteger(n) && n >= 0 ? n : 0
  } catch {
    return 0
  }
}

function createGroupIndex ({ maxGroups = DEFAULT_MAX_GROUPS, maxWritersPerGroup = MAX_GROUP_WRITERS } = {}) {
  const groupCap = Number.isSafeInteger(maxGroups) && maxGroups >= 1 ? maxGroups : DEFAULT_MAX_GROUPS
  const writerCap = Number.isSafeInteger(maxWritersPerGroup) && maxWritersPerGroup >= 1 ? maxWritersPerGroup : MAX_GROUP_WRITERS
  // group -> { header: null | { kind, visibility, join, diary, name, community, member }, created, tokens,
  //   writers: Map<writer, { diary, seq, left }>, sources, ...rootState() }
  // `sources`: core -> { meta, image, about, cutAt, creates }, each field
  // null or the last such record of that core in log order ({ name, join }
  // or { value }, with its seq, seen, at and anchorAt), cutAt the `at` of a
  // sibling's applied cut (null with none), creates the distinct groups a
  // community CW's group-create records name, in log order: the root's
  // (foldRoot, whose creates live in `creates`) and the creator's other
  // writers' (foldCharter).
  const groups = new Map()
  const writerGroup = new Map() // writer -> group
  const diaryWriters = new Map() // diary -> Set<writer>
  // community root -> Set<G> its root's group-create records name (at most
  // MAX_GROUPS_PER_COMMUNITY: the fold never counts more).
  const creates = new Map()

  function ensureGroup (group) {
    let g = groups.get(group)
    if (g) return g
    if (groups.size >= groupCap) return null
    // leftDiaries: the diaries that withdrew a join of one of their writers
    // here (markLeave), sticky until the diary is removed. creatorLeaves:
    // the community root and the CWs a group-leave was read on (foldRoot,
    // foldCharter), kept across a CW reset, a root rescan and the writer's
    // removal: the fold keeps a leave past any cut, and a reader that holds
    // the core still counts it.
    g = { header: null, standalone: false, created: null, tokens: [], writers: new Map(), sources: new Map(), leftDiaries: new Set(), creatorLeaves: new Set(), ...rootState() }
    groups.set(group, g)
    return g
  }

  // What a community root or a public group root shows, resolved from its
  // sources (resolve): the group-meta name and join (metaSeen once one
  // counts), image and description; and what ranks them: the root length
  // read (setRootLength) and whether the root is cut (setRootCut).
  function rootState () {
    return { meta: null, metaJoin: null, metaSeen: false, image: null, about: null, rootLength: 0, rootCut: false }
  }

  // A sibling source is read while its writer row is still the header
  // diary's; it counts only while that row is live too.
  function sourceBound (g, key) {
    const w = g.writers.get(key)
    return w !== undefined && g.header !== null && w.diary === g.header.diary
  }

  function resolve (g, root) {
    const pick = (field) => {
      const own = g.sources.has(root) ? g.sources.get(root)[field] : null
      const siblings = new Map()
      for (const [key, s] of g.sources) {
        if (key !== root && s[field] !== null && sourceBound(g, key)) siblings.set(key, { entry: s[field], cutAt: s.cutAt, live: !g.writers.get(key).left })
      }
      // A leave of the creator's diary ends sibling charter in the fold for
      // good (a root cut in a group, the gate in a community).
      const alone = g.rootCut || (g.header !== null && g.leftDiaries.has(g.header.diary))
      return pickCharter(own, root, siblings, g.rootLength, alone)
    }
    const meta = pick('meta')
    const image = pick('image')
    const about = pick('about')
    g.meta = meta === null ? null : meta.name
    g.metaJoin = meta === null ? null : meta.join
    g.metaSeen = meta !== null
    g.image = image === null ? null : image.value
    g.about = about === null ? null : about.value
    retoken(g)
  }

  // Folds one charter record at `seq` into source `key` of g; false when it
  // is none. `anchorAt`: the `at` of the root record its `seen` names, when
  // read; `cutAt`: see `sources`.
  function foldSource (g, key, record, seq, anchorAt, cutAt = null) {
    let s = g.sources.get(key)
    const fresh = s === undefined
    if (fresh) s = { meta: null, image: null, about: null, cutAt: null, creates: [] }
    const seen = record.seen !== null && typeof record.seen === 'object' && isHex64(record.seen.writer) && Number.isSafeInteger(record.seen.seq)
      ? { writer: record.seen.writer, seq: record.seen.seq }
      : null
    // anchorRead: the named root block was read (its `at` may still be NaN).
    const rank = { seq: Number.isSafeInteger(seq) ? seq : null, seen, at: charterAt(record.at), anchorAt: Number.isFinite(anchorAt) ? anchorAt : NaN, anchorRead: anchorAt !== undefined }
    if (record.type === 'group-image') {
      s.image = { value: record.image === null ? null : { ...record.image }, ...rank }
    } else if (record.type === 'group-about' && (record.about === null || typeof record.about === 'string')) {
      s.about = { value: record.about, ...rank }
    } else if (record.type === 'group-meta' && (record.name === null || typeof record.name === 'string')) {
      // A cleared name (null) counts too: it hides the header's.
      const join = record.join === 'open' || record.join === 'approval' ? record.join : (s.meta === null ? null : s.meta.join)
      s.meta = { name: record.name, join, ...rank }
    } else {
      return false
    }
    s.cutAt = Number.isFinite(cutAt) ? cutAt : cutAt === null ? null : NaN
    if (fresh) g.sources.set(key, s)
    return true
  }

  // Forgets source `key` of g; whether it had one.
  function dropSource (g, root, key) {
    if (!g.sources.delete(key)) return false
    resolve(g, root)
    return true
  }

  // The name a public group shows and is found by: the last group-meta its
  // root folded (null clears it), else its header's. A hint only: no
  // authority check, as for a community's name.
  function groupName (g) {
    if (g.header === null || g.header.visibility !== 'public') return null
    return g.metaSeen ? g.meta : g.header.name
  }

  // A community is found by the name it shows, so a renamed one is found by
  // its new name.
  function retoken (g) {
    const n = g.header === null ? null : g.header.kind === 'group' ? groupName(g) : (g.metaSeen ? g.meta : g.header.name)
    g.tokens = typeof n === 'string' ? foldTokens(n) : []
  }

  function dropCreates (root) {
    return creates.delete(root)
  }

  function prune (group) {
    const g = groups.get(group)
    if (g && g.header === null && g.writers.size === 0) groups.delete(group)
  }

  function unlinkWriter (writer) {
    const group = writerGroup.get(writer)
    if (group === undefined) return false
    writerGroup.delete(writer)
    const g = groups.get(group)
    const w = g ? g.writers.get(writer) : undefined
    if (g) {
      g.writers.delete(writer)
      if (writer !== group) dropSource(g, group, writer)
    }
    if (w) {
      const set = diaryWriters.get(w.diary)
      if (set) {
        set.delete(writer)
        if (set.size === 0) diaryWriters.delete(w.diary)
      }
    }
    prune(group)
    return true
  }

  // A writer moves only by being removed first: its block 0 names one group
  // and one diary for good.
  function addWriter (group, writer, diary, seq) {
    try {
      if (!isHex64(group) || !isHex64(writer) || !isHex64(diary) || !validSeq(seq)) return false
      const known = writerGroup.get(writer)
      if (known !== undefined && known !== group) return false
      const g = known === undefined ? ensureGroup(group) : groups.get(group)
      if (!g) return false
      const prev = g.writers.get(writer)
      if (prev) {
        if (prev.diary !== diary) return false
        prev.seq = seq
        // A rejoin: a source it holds counts again.
        if (prev.left && writer !== group && g.sources.has(writer)) {
          prev.left = false
          resolve(g, group)
        }
        prev.left = false
        return true
      }
      if (g.writers.size >= writerCap) {
        prune(group)
        return false
      }
      g.writers.set(writer, { diary, seq, left: false })
      writerGroup.set(writer, group)
      let set = diaryWriters.get(diary)
      if (!set) {
        set = new Set()
        diaryWriters.set(diary, set)
      }
      set.add(writer)
      return true
    } catch {
      return false
    }
  }

  function setLeft (writer, left) {
    try {
      const group = writerGroup.get(writer)
      if (group === undefined) return false
      const g = groups.get(group)
      const w = g.writers.get(writer)
      const was = w.left
      w.left = left === true
      if (was !== w.left && writer !== group && g.sources.has(writer)) resolve(g, group)
      return true
    } catch {
      return false
    }
  }

  function removeWriter (writer) {
    try {
      return unlinkWriter(writer)
    } catch {
      return false
    }
  }

  function removeDiary (diary) {
    try {
      const set = diaryWriters.get(diary)
      if (!set) return false
      for (const writer of set) {
        const g = groups.get(writerGroup.get(writer))
        if (g) g.leftDiaries.delete(diary)
      }
      for (const writer of [...set]) unlinkWriter(writer)
      return true
    } catch {
      return false
    }
  }

  function removeGroup (group) {
    try {
      const g = groups.get(group)
      if (!g) return false
      for (const writer of [...g.writers.keys()]) unlinkWriter(writer)
      dropCreates(group)
      groups.delete(group)
      return true
    } catch {
      return false
    }
  }

  // header: a validated group-header (lib/group.js), or null to forget it.
  // Only a public header's name is kept (as written, for display) and
  // folded for search; a private root keeps none.
  function setHeader (group, header) {
    try {
      if (!isHex64(group)) return false
      if (header === null) {
        const g = groups.get(group)
        if (!g) return false
        g.header = null
        g.standalone = false
        g.created = null
        g.tokens = []
        Object.assign(g, rootState())
        g.sources.clear()
        dropCreates(group)
        prune(group)
        return true
      }
      const g = ensureGroup(group)
      if (!g) return false
      const { kind, visibility, join, diary, name } = header
      const community = isHex64(header.community) ? header.community : null
      const member = isHex64(header.member) ? header.member : null
      const created = createdOf(header.at)
      if (g.header !== null && g.header.kind !== kind) {
        Object.assign(g, rootState())
        g.sources.clear()
        dropCreates(group)
      }
      const shownName = visibility === 'public' && typeof name === 'string' ? name : null
      g.header = { kind, visibility, join, diary, name: shownName, community, member }
      // Only the root's own header makes a group standalone: never a missing
      // parent or catalogue, and no catalogue claim can undo it.
      g.standalone = isStandaloneHeader(header)
      g.created = created
      retoken(g)
      return true
    } catch {
      return false
    }
  }

  // The name a public group root shows (see groupName), or null.
  function nameOf (group) {
    try {
      const g = groups.get(group)
      return g && g.header !== null && g.header.kind === 'group' ? groupName(g) : null
    } catch {
      return null
    }
  }

  // The name a community root shows (its latest group-meta, else the header
  // name), or null, without building the community's group list.
  function communityNameOf (C) {
    try {
      const c = groups.get(C)
      return c && c.header !== null && c.header.kind === 'community' ? (c.metaSeen ? c.meta : c.header.name) : null
    } catch {
      return null
    }
  }

  function imageOf (root) {
    try {
      const g = groups.get(root)
      return g && g.header !== null && g.header.visibility === 'public' && g.image !== null ? { ...g.image } : null
    } catch {
      return null
    }
  }

  function aboutOf (root) {
    try {
      const g = groups.get(root)
      return g && g.header !== null && g.header.visibility === 'public' && typeof g.about === 'string' ? g.about : null
    } catch {
      return null
    }
  }

  function header (group) {
    const g = groups.get(group)
    return g && g.header ? { ...g.header } : null
  }

  // The row of one writer ({ group, diary, seq, left }), or null.
  function writer (key) {
    try {
      const group = writerGroup.get(key)
      if (group === undefined) return null
      const w = groups.get(group).writers.get(key)
      return { group, diary: w.diary, seq: w.seq, left: w.left }
    } catch {
      return null
    }
  }

  // The writers of a group in ascending key order after the exclusive
  // cursor `after`; `visible(diary, writer)` filters at read time,
  // `lengthOf(writer)` gives the length the caller holds (its contiguous
  // prefix) and `signedOf(writer)` the signed length, never below `length`.
  // `next` is the last key of the page when more may follow, else null.
  function page (group, after = null, limit = PAGE_MAX, { visible = null, lengthOf = null, signedOf = null } = {}) {
    try {
      if (!isHex64(group) || (after !== null && !isHex64(after))) return null
      const n = Number.isSafeInteger(limit) && limit >= 1 ? Math.min(limit, PAGE_MAX) : PAGE_MAX
      const g = groups.get(group)
      if (!g) return { items: [], next: null }
      const keys = [...g.writers.keys()].sort(cmp)
      const items = []
      let next = null
      for (const key of keys) {
        if (after !== null && key <= after) continue
        const w = g.writers.get(key)
        if (!shown(visible, w.diary, key)) continue
        if (items.length >= n) {
          next = items[items.length - 1].key
          break
        }
        const length = count(lengthOf, key)
        const signed = Math.max(length, count(signedOf, key))
        items.push({ key, diary: w.diary, length, signed, seq: w.seq, left: w.left })
      }
      return { items, next }
    } catch {
      return null
    }
  }

  // The groups a diary writes to, ONE row per group by group key, at most
  // MAX_GROUPS_PER_DIARY: a diary may bind hundreds of writers to one group
  // (one per device join), so a row per writer would outgrow any answer.
  // The row names the diary's newest live join (highest seq) among the
  // writers `visible(group, writer)` admits; `left` only when every such
  // writer left, the row then naming the newest of them.
  function groupsOf (diary, visible = null) {
    try {
      const set = diaryWriters.get(diary)
      if (!set) return []
      const best = new Map() // group -> { group, writer, seq, left }
      for (const writer of set) {
        const group = writerGroup.get(writer)
        if (!shown(visible, group, writer)) continue
        const w = groups.get(group).writers.get(writer)
        const cur = best.get(group)
        if (cur === undefined || (cur.left && !w.left) || (cur.left === w.left &&
          (w.seq > cur.seq || (w.seq === cur.seq && writer < cur.writer)))) {
          best.set(group, { group, writer, seq: w.seq, left: w.left })
        }
      }
      // Current memberships first: departed writers are kept, so a diary can
      // collect more than MAX_GROUPS_PER_DIARY groups it left, and the cap
      // must never hide one it still belongs to.
      return [...best.values()]
        .sort((a, b) => (a.left === b.left ? 0 : a.left ? 1 : -1) || cmp(a.group, b.group))
        .slice(0, MAX_GROUPS_PER_DIARY)
    } catch {
      return []
    }
  }

  // Public groups whose folded name matches the route segment, with their
  // display name, at most RESULTS_MAX, ordered by (rank, members desc,
  // group key). A member is a diary with a writer that has not left. null
  // for a malformed segment.
  function search (segment, visible = null) {
    try {
      const q = parseQuery(segment)
      if (q === null) return null
      const exact = q.join(' ')
      const hits = []
      for (const [group, g] of groups) {
        // A standalone group stays out: installed apps join any group a hit
        // names, and only discovery that knows the shape may list one.
        if (!g.header || g.header.kind !== 'group' || g.header.visibility !== 'public' || g.header.community === null || g.tokens.length === 0) continue
        if (searchRank(q, g.tokens, null) < 0) continue
        if (!shown(visible, group)) continue
        const members = new Set()
        for (const w of g.writers.values()) if (!w.left) members.add(w.diary)
        hits.push({ group, name: groupName(g), rank: g.tokens.join(' ') === exact ? 0 : 1, members: members.size })
      }
      hits.sort((a, b) => a.rank - b.rank || b.members - a.members || cmp(a.group, b.group))
      return {
        groups: hits.slice(0, RESULTS_MAX).map(({ group, name, members }) => ({ group, name, members })),
        more: hits.length > RESULTS_MAX
      }
    } catch {
      return null
    }
  }

  // One record of root `root` at `seq` (validated by the caller with
  // validateGroupRecord, in log order, each once): group-meta, group-image,
  // group-about and, for a community root, group-create and group-leave.
  // Anything else, or a root that is neither a community nor a public
  // group, answers false.
  function foldRoot (root, record, seq) {
    try {
      const g = groups.get(root)
      if (!g || g.header === null || record === null || typeof record !== 'object') return false
      // A private root seals its meta and has no public image, so it folds nothing.
      const publicGroup = g.header.kind === 'group' && g.header.visibility === 'public'
      if (g.header.kind !== 'community' && !publicGroup) return false
      if (record.type === 'group-image' || record.type === 'group-about' || record.type === 'group-meta') {
        if (!foldSource(g, root, record, seq)) return false
        if (validSeq(seq)) g.rootLength = Math.max(g.rootLength, seq + 1)
        resolve(g, root)
        return true
      }
      if (record.type === 'group-create' && !publicGroup) {
        if (!isHex64(record.group) || record.group === root) return false
        let set = creates.get(root)
        if (set === undefined) {
          set = new Set()
          creates.set(root, set)
        }
        if (set.has(record.group)) return true
        if (set.size >= MAX_GROUPS_PER_COMMUNITY) return false
        set.add(record.group)
        return true
      }
      // An unconfirmed leave on the root retires the CWs of its generation
      // in the fold, which then counts their creates only below a confirmed
      // bound.
      if (record.type === 'group-leave' && !publicGroup) {
        g.creatorLeaves.add(root)
        return true
      }
      return false
    } catch {
      return false
    }
  }

  // Forgets what foldRoot folded for root, so the caller can fold it again.
  // The other writers' sources stay: each has its own scan.
  function resetRoot (root) {
    try {
      const g = groups.get(root)
      if (!g) return false
      g.sources.delete(root)
      dropCreates(root)
      resolve(g, root)
      return true
    } catch {
      return false
    }
  }

  // One group-meta, group-image or group-about of writer `writer` of root
  // `root` at `seq`, or a group-create or group-leave when the root is a
  // community's, another core of the root's header diary (validated by
  // the caller with validateGroupRecord off the root, in log order, each
  // once, only below that writer's diary cut). `anchorAt` and `cutAt` as in
  // foldSource. Anything else, a writer of another diary or group, or a root
  // that is neither a community nor a public group, answers false.
  function foldCharter (root, writer, record, { seq, anchorAt, cutAt = null } = {}) {
    try {
      if (!isHex64(writer) || writer === root || writerGroup.get(writer) !== root) return false
      const g = groups.get(root)
      if (!g || g.header === null || record === null || typeof record !== 'object') return false
      if (g.header.kind !== 'community' && !(g.header.kind === 'group' && g.header.visibility === 'public')) return false
      if (g.writers.get(writer).diary !== g.header.diary) return false
      if (record.type === 'group-create' && g.header.kind === 'community') return foldCreate(g, root, writer, record.group)
      if (record.type === 'group-leave' && g.header.kind === 'community') {
        g.creatorLeaves.add(writer)
        return true
      }
      if (record.type !== 'group-image' && record.type !== 'group-about' && record.type !== 'group-meta') return false
      if (!foldSource(g, writer, record, seq, anchorAt, cutAt)) return false
      resolve(g, root)
      return true
    } catch {
      return false
    }
  }

  // A group-create of CW `writer` naming G: kept once per writer, at most
  // MAX_GROUPS_PER_COMMUNITY (the fold never counts more from all sources).
  function foldCreate (g, root, writer, G) {
    if (!isHex64(G) || G === root) return false
    let s = g.sources.get(writer)
    if (s === undefined) {
      s = { meta: null, image: null, about: null, cutAt: null, creates: [] }
      g.sources.set(writer, s)
    }
    if (s.creates.includes(G)) return true
    if (s.creates.length >= MAX_GROUPS_PER_COMMUNITY) {
      s.createsFull = true
      return false
    }
    s.creates.push(G)
    return true
  }

  // The groups community root C's catalogue hints list (docs/protocol.md
  // section 10, "Catalogue hints"): the root's creates in root order, then
  // those of the live writers its creator's diary binds, by writer key then
  // seq, each group once. A hint may answer less than the fold, never more,
  // so the root's alone answer when the fold may count none of the CWs' (a
  // leave of the creator's diary, a root cut, a group-leave read on the
  // root or one of its CWs, which retires that generation), and when the root's and the
  // CWs' distinct groups pass MAX_GROUPS_PER_COMMUNITY: the fold takes the
  // CWs in causal order, unknown here, so any CW create may be its orphan.
  function catalogueOf (C) {
    const own = creates.get(C)
    const out = new Set(own)
    const c = groups.get(C)
    if (!c || c.header === null || c.header.kind !== 'community') return out
    if (c.rootCut || c.leftDiaries.has(c.header.diary)) return out
    if (c.creatorLeaves.size > 0) return out
    const keys = []
    const all = new Set(out)
    for (const [key, s] of c.sources) {
      if (key === C || !sourceBound(c, key)) continue
      if (s.createsFull) return out
      for (const G of s.creates) all.add(G)
      if (s.creates.length > 0 && !c.writers.get(key).left) keys.push(key)
    }
    if (all.size > MAX_GROUPS_PER_COMMUNITY) return out
    keys.sort(cmp)
    for (const key of keys) {
      for (const G of c.sources.get(key).creates) {
        if (out.has(G)) continue
        if (out.size >= MAX_GROUPS_PER_COMMUNITY) return out
        out.add(G)
      }
    }
    return out
  }

  // How much of root `root` was read: a sibling `seen` naming a root seq at
  // or past it ranks with no anchor.
  function setRootLength (root, length) {
    try {
      const g = groups.get(root)
      if (!g || !Number.isSafeInteger(length) || length < 0) return false
      if (g.rootLength !== length) {
        g.rootLength = length
        resolve(g, root)
      }
      return true
    } catch {
      return false
    }
  }

  // The shown records of root `root`'s other writers whose `seen` names a
  // root seq below `length` not read yet, at most one per field and writer:
  // [{ writer, field, seq }].
  function anchorsWanted (root, length) {
    try {
      const g = groups.get(root)
      if (!g) return []
      const out = []
      for (const [writer, s] of g.sources) {
        if (writer === root) continue
        for (const field of ['meta', 'image', 'about']) {
          const e = s[field]
          if (e !== null && !e.anchorRead && e.seen !== null && e.seen.writer === root && e.seen.seq < length) out.push({ writer, field, seq: e.seen.seq })
        }
      }
      return out
    } catch {
      return []
    }
  }

  // The `at` (ms, NaN when the block has none) of root block `seq`, for the
  // record of `writer` in `field` that still names it.
  function setAnchorAt (root, writer, field, seq, at) {
    try {
      const g = groups.get(root)
      const s = g ? g.sources.get(writer) : undefined
      const e = s && writer !== root ? s[field] : undefined
      if (!e || e.anchorRead || e.seen === null || e.seen.writer !== root || e.seen.seq !== seq) return false
      e.anchorRead = true
      e.anchorAt = Number.isFinite(at) ? at : NaN
      resolve(g, root)
      return true
    } catch {
      return false
    }
  }

  // Writer `writer`'s diary withdrew its join (an on:false group-join, not a
  // release by a cut): when that diary is the root header's, its other
  // writers' charter stops counting, also after a rejoin.
  function markLeave (writer) {
    try {
      const group = writerGroup.get(writer)
      if (group === undefined) return false
      const g = groups.get(group)
      const diary = g.writers.get(writer).diary
      if (g.leftDiaries.has(diary)) return true
      g.leftDiaries.add(diary)
      if (g.header !== null && g.header.diary === diary) resolve(g, group)
      return true
    } catch {
      return false
    }
  }

  // Whether a mark of the creator's diary cuts root `root`: the fold then
  // counts no sibling charter, so the root alone answers.
  function setRootCut (root, cut) {
    try {
      const g = groups.get(root)
      if (!g) return false
      if (g.rootCut !== (cut === true)) {
        g.rootCut = cut === true
        resolve(g, root)
      }
      return true
    } catch {
      return false
    }
  }

  // Forgets what foldCharter folded for writer, so the caller can fold it
  // again (a cut moved) or never (dropped).
  function resetCharter (root, writer) {
    try {
      const g = groups.get(root)
      if (!g || writer === root) return false
      dropSource(g, root, writer)
      return true
    } catch {
      return false
    }
  }

  // The writer keys of `diary` in group `group` other than the root, key
  // order.
  function writersOf (group, diary) {
    try {
      const g = groups.get(group)
      const set = diaryWriters.get(diary)
      if (!g || !set) return []
      return [...set].filter((k) => k !== group && writerGroup.get(k) === group).sort(cmp)
    } catch {
      return []
    }
  }

  function attachedTo (c, C, G, set) {
    const g = groups.get(G)
    if (!g || g.header === null || g.header.kind !== 'group' || g.header.community !== C) return false
    if (g.header.diary !== c.header.diary) return false
    return (set === undefined ? catalogueOf(C) : set).has(G)
  }

  // Whether community root C's catalogue hints attach group G.
  function attached (C, G) {
    try {
      const c = groups.get(C)
      if (!c || c.header === null || c.header.kind !== 'community') return false
      return attachedTo(c, C, G)
    } catch {
      return false
    }
  }

  // The community group G's header names, when that community is a root
  // here that attaches G and `visible(C)` admits it; else null.
  function communityOf (group, visible = null) {
    try {
      const g = groups.get(group)
      if (!g || g.header === null || g.header.kind !== 'group' || g.header.community === null) return null
      const C = g.header.community
      return attached(C, group) && shown(visible, C) ? C : null
    } catch {
      return null
    }
  }

  // The groups some create names in C (attached or not), key order: what
  // C's answers must wait for while one of them is still being admitted.
  function createdIn (C) {
    try {
      return [...catalogueOf(C)].sort(cmp)
    } catch {
      return []
    }
  }

  // The root folds in log order, so its first create names Geral; a CW
  // create never does.
  function generalOf (C) {
    try {
      if (!isHex64(C)) return null
      const set = creates.get(C)
      return set === undefined || set.size === 0 ? null : set.values().next().value
    } catch {
      return null
    }
  }

  function memberCount (g, visible) {
    const members = new Set()
    for (const [key, w] of g.writers) if (!w.left && shown(visible, w.diary, key)) members.add(w.diary)
    return members.size
  }

  function activeCount (g, now, f, activeMember, lastActivity) {
    const oldest = now - TREND_WINDOW_MS
    const newest = now + MAX_FUTURE_MS
    const diaries = new Set()
    for (const [key, w] of g.writers) {
      // Also a member by the row's own filter, so active never exceeds the
      // member count whatever filters the caller pairs.
      if (w.left || !shown(f.members, w.diary, key) || !shown(activeMember, w.diary, key)) continue
      let time
      try {
        time = lastActivity(key)
      } catch {
        continue
      }
      if (Number.isSafeInteger(time) && time >= oldest && time <= newest) diaries.add(w.diary)
    }
    return diaries.size
  }

  function listed (key, g, f) {
    if (g.header === null || g.header.kind !== 'group' || g.header.visibility !== 'public') return null
    const name = groupName(g)
    if (typeof name !== 'string' || name.length === 0) return null
    const { community: C, diary: creator } = g.header
    if (!isHex64(C) || !attached(C, key) || !shown(f.parent, C)) return null
    const c = groups.get(C)
    const communityName = c.metaSeen ? c.meta : c.header.name
    if (typeof communityName !== 'string' || communityName.length === 0) return null
    if (!shown(f.visible, key, creator)) return null
    const members = memberCount(g, f.members)
    if (members < 1) return null
    return { group: key, name, creator, community: C, communityName, members, created: g.created, active: null }
  }

  function browse (order, now, filters = {}) {
    try {
      const trending = order === 'trending'
      if ((order !== 'members' && order !== 'recent' && !trending) || !Number.isSafeInteger(now)) return null
      const { activeMember, lastActivity } = trending ? filters : {}
      if (trending && typeof lastActivity !== 'function') return { groups: [], more: false }
      const { visible, parent, members } = filters
      const f = { visible, parent, members }
      let rows = []
      for (const [key, g] of groups) {
        const row = listed(key, g, f)
        if (row === null) continue
        if (row.created !== null && row.created > now + CREATED_SKEW_MS) row.created = null
        if (order === 'recent' && row.created === null) continue
        if (trending) {
          // A live writer may still be awaiting admission in an approval group.
          if ((g.metaJoin || g.header.join) !== 'open') continue
          row.active = activeCount(g, now, f, activeMember, lastActivity)
          if (row.active < TREND_MIN_ACTIVE) continue
        }
        rows.push(row)
      }
      if (order === 'members') {
        rows.sort((a, b) => b.members - a.members || cmp(a.group, b.group))
      } else if (trending) {
        rows.sort((a, b) => b.active - a.active || cmp(a.group, b.group))
      } else {
        rows.sort((a, b) => b.created - a.created || cmp(a.group, b.group))
        const perCreator = new Map()
        rows = rows.filter(({ creator }) => {
          const kept = perCreator.get(creator) || 0
          if (kept >= RECENT_PER_CREATOR) return false
          perCreator.set(creator, kept + 1)
          return true
        })
      }
      return { groups: rows.slice(0, BROWSE_MAX), more: rows.length > BROWSE_MAX }
    } catch {
      return null
    }
  }

  function publicGroupsOf (diary, options = {}) {
    try {
      if (!isHex64(diary)) return null
      const { visible, parent, members, joined, after = null, limit = PUBLIC_GROUPS_PAGE } = options
      if (after !== null && !isHex64(after)) return null
      if (!Number.isSafeInteger(limit) || limit < 1) return null
      const max = Math.min(limit, PUBLIC_GROUPS_PAGE)
      const set = diaryWriters.get(diary)
      if (!set) return { groups: [], next: null }
      const live = new Map()
      for (const writer of set) {
        const group = writerGroup.get(writer)
        if (groups.get(group).writers.get(writer).left) continue
        const writers = live.get(group)
        if (writers) writers.push(writer)
        else live.set(group, [writer])
      }

      // `joined` runs last and only for a group the list would show, so it
      // never judges a Geral, an approval or an unlisted group (the seeder's
      // completeness check lives in it), and for every candidate, those
      // before the cursor and past the page too, so every page agrees.
      const f = { visible, parent, members }
      const rows = []
      let next = null
      for (const key of [...live.keys()].sort(cmp)) {
        const g = groups.get(key)
        const row = listed(key, g, f)
        if (row === null || generalOf(row.community) === key) continue
        // A live writer may still be awaiting admission in an approval group.
        if ((g.metaJoin || g.header.join) !== 'open') continue
        if (!live.get(key).some((writer) => shown(joined, key, writer))) continue
        if (after !== null && key <= after) continue
        if (rows.length >= max) {
          next = rows[rows.length - 1].group
          continue
        }
        const { group, name, creator, community, communityName, members } = row
        rows.push({ group, name, creator, community, communityName, members })
      }
      return { groups: rows, next }
    } catch {
      return null
    }
  }

  // Community root C: its display name (the last group-meta, else its
  // header's), join, header diary, members (diaries with a writer of C not
  // left that `members(diary, writer)` admits, the root counting for its
  // creator) and its attached groups that `visible(group)` admits, in key
  // order after the exclusive cursor `after`, at most `limit`, each row
  // { group, visibility, join, name, writerCount } (name and writerCount
  // null for a private group). `next` is the last listed key when more
  // follow. null when C is no community root here.
  function community (C, visible = null, { after = null, limit = MAX_GROUPS_PER_COMMUNITY, members = null } = {}) {
    try {
      if (!isHex64(C) || (after !== null && !isHex64(after))) return null
      const c = groups.get(C)
      if (!c || c.header === null || c.header.kind !== 'community') return null
      const n = Number.isSafeInteger(limit) && limit >= 1 ? Math.min(limit, MAX_GROUPS_PER_COMMUNITY) : MAX_GROUPS_PER_COMMUNITY
      const name = c.metaSeen ? c.meta : c.header.name
      const rows = []
      let next = null
      const set = catalogueOf(C)
      for (const G of [...set].sort(cmp)) {
        if (after !== null && G <= after) continue
        if (!attachedTo(c, C, G, set) || !shown(visible, G)) continue
        if (rows.length >= n) {
          next = rows[rows.length - 1].group
          break
        }
        const g = groups.get(G)
        const priv = g.header.visibility !== 'public'
        rows.push({
          group: G,
          visibility: priv ? 'private' : 'public',
          join: (!priv && g.metaJoin) || g.header.join,
          name: priv ? null : groupName(g),
          writerCount: priv ? null : memberCount(g, null)
        })
      }
      return { name, join: c.metaJoin || c.header.join, creator: c.header.diary, members: memberCount(c, members), groups: rows, next }
    } catch {
      return null
    }
  }

  // Discovery listings (standalone groups and communities). A group whose
  // header names a community, Geral included, never appears in them. Member
  // counts are distinct visible diaries with a live writer: hints only.
  function standaloneRow (key, g, f) {
    if (!g.standalone || g.header === null || g.header.visibility !== 'public') return null
    const name = groupName(g)
    if (typeof name !== 'string' || name.length === 0) return null
    const creator = g.header.diary
    if (!shown(f.visible, key, creator)) return null
    const members = memberCount(g, f.members)
    if (members < 1) return null
    return { group: key, name, creator, members, created: g.created, active: null }
  }

  function communityRow (key, c, f) {
    if (c.header === null || c.header.kind !== 'community' || c.header.visibility !== 'public') return null
    const name = c.metaSeen ? c.meta : c.header.name
    if (typeof name !== 'string' || name.length === 0) return null
    const creator = c.header.diary
    if (!shown(f.visible, key, creator)) return null
    const members = memberCount(c, f.members)
    if (members < 1) return null
    return { community: key, name, creator, join: c.metaJoin || c.header.join, members, created: c.created }
  }

  function capRecent (rows, keyOf) {
    rows.sort((a, b) => b.created - a.created || cmp(keyOf(a), keyOf(b)))
    const perCreator = new Map()
    return rows.filter(({ creator }) => {
      const kept = perCreator.get(creator) || 0
      if (kept >= RECENT_PER_CREATOR) return false
      perCreator.set(creator, kept + 1)
      return true
    })
  }

  function browseStandalone (order, now, filters = {}) {
    try {
      const trending = order === 'trending'
      if ((order !== 'members' && order !== 'recent' && !trending) || !Number.isSafeInteger(now)) return null
      const { activeMember, lastActivity } = trending ? filters : {}
      if (trending && typeof lastActivity !== 'function') return { groups: [], more: false }
      const f = { visible: filters.visible, members: filters.members }
      let rows = []
      for (const [key, g] of groups) {
        const row = standaloneRow(key, g, f)
        if (row === null) continue
        if (row.created !== null && row.created > now + CREATED_SKEW_MS) row.created = null
        if (order === 'recent' && row.created === null) continue
        if (trending) {
          if ((g.metaJoin || g.header.join) !== 'open') continue
          row.active = activeCount(g, now, f, activeMember, lastActivity)
          if (row.active < TREND_MIN_ACTIVE) continue
        }
        rows.push(row)
      }
      if (order === 'members') rows.sort((a, b) => b.members - a.members || cmp(a.group, b.group))
      else if (trending) rows.sort((a, b) => b.active - a.active || cmp(a.group, b.group))
      else rows = capRecent(rows, (r) => r.group)
      return { groups: rows.slice(0, BROWSE_MAX), more: rows.length > BROWSE_MAX }
    } catch {
      return null
    }
  }

  function browseCommunities (order, now, filters = {}) {
    try {
      if ((order !== 'members' && order !== 'recent') || !Number.isSafeInteger(now)) return null
      const f = { visible: filters.visible, members: filters.members }
      let rows = []
      for (const [key, c] of groups) {
        const row = communityRow(key, c, f)
        if (row === null) continue
        if (row.created !== null && row.created > now + CREATED_SKEW_MS) row.created = null
        if (order === 'recent' && row.created === null) continue
        rows.push(row)
      }
      if (order === 'members') rows.sort((a, b) => b.members - a.members || cmp(a.community, b.community))
      else rows = capRecent(rows, (r) => r.community)
      return { communities: rows.slice(0, BROWSE_MAX), more: rows.length > BROWSE_MAX }
    } catch {
      return null
    }
  }

  // Standalone groups and communities whose folded name matches the route
  // segment, each list ranked like search() and capped at RESULTS_MAX.
  function discoverSearch (segment, filters = {}) {
    try {
      const q = parseQuery(segment)
      if (q === null) return null
      const exact = q.join(' ')
      const f = { visible: filters.visible, members: filters.members }
      const gs = []
      const cs = []
      for (const [key, g] of groups) {
        if (g.tokens.length === 0 || searchRank(q, g.tokens, null) < 0) continue
        const rank = g.tokens.join(' ') === exact ? 0 : 1
        const row = g.header !== null && g.header.kind === 'community' ? communityRow(key, g, f) : standaloneRow(key, g, f)
        if (row === null) continue
        if (row.community !== undefined) cs.push({ community: key, name: row.name, creator: row.creator, members: row.members, rank })
        else gs.push({ group: key, name: row.name, creator: row.creator, members: row.members, rank })
      }
      gs.sort((a, b) => a.rank - b.rank || b.members - a.members || cmp(a.group, b.group))
      cs.sort((a, b) => a.rank - b.rank || b.members - a.members || cmp(a.community, b.community))
      return {
        groups: gs.slice(0, RESULTS_MAX).map(({ group, name, creator, members }) => ({ group, name, creator, members })),
        communities: cs.slice(0, RESULTS_MAX).map(({ community, name, creator, members }) => ({ community, name, creator, members })),
        moreGroups: gs.length > RESULTS_MAX,
        moreCommunities: cs.length > RESULTS_MAX
      }
    } catch {
      return null
    }
  }

  // The open standalone groups a diary belongs to, paged like publicGroupsOf.
  function standaloneGroupsOf (diary, options = {}) {
    try {
      if (!isHex64(diary)) return null
      const { visible, members, joined, after = null, limit = PUBLIC_GROUPS_PAGE } = options
      if (after !== null && !isHex64(after)) return null
      if (!Number.isSafeInteger(limit) || limit < 1) return null
      const max = Math.min(limit, PUBLIC_GROUPS_PAGE)
      const set = diaryWriters.get(diary)
      if (!set) return { groups: [], next: null }
      const live = new Map()
      for (const writer of set) {
        const group = writerGroup.get(writer)
        if (groups.get(group).writers.get(writer).left) continue
        const writers = live.get(group)
        if (writers) writers.push(writer)
        else live.set(group, [writer])
      }
      const f = { visible, members }
      const rows = []
      let next = null
      for (const key of [...live.keys()].sort(cmp)) {
        const g = groups.get(key)
        const row = standaloneRow(key, g, f)
        if (row === null) continue
        if ((g.metaJoin || g.header.join) !== 'open') continue
        if (!live.get(key).some((writer) => shown(joined, key, writer))) continue
        if (after !== null && key <= after) continue
        if (rows.length >= max) {
          next = rows[rows.length - 1].group
          continue
        }
        const { group, name, creator, members } = row
        rows.push({ group, name, creator, members })
      }
      return { groups: rows, next }
    } catch {
      return null
    }
  }

  function clear () {
    groups.clear()
    writerGroup.clear()
    diaryWriters.clear()
    creates.clear()
  }

  function stats () {
    return { groups: groups.size, writers: writerGroup.size, maxGroups: groupCap, saturated: groups.size >= groupCap }
  }

  return { addWriter, setLeft, removeWriter, removeDiary, removeGroup, setHeader, header, nameOf, communityNameOf, imageOf, aboutOf, writer, page, groupsOf, search, browse, publicGroupsOf, browseStandalone, browseCommunities, discoverSearch, standaloneGroupsOf, foldRoot, resetRoot, foldCharter, resetCharter, setRootLength, setRootCut, anchorsWanted, setAnchorAt, markLeave, writersOf, attached, communityOf, createdIn, generalOf, community, clear, stats }
}

module.exports = {
  DEFAULT_MAX_GROUPS,
  BROWSE_MAX,
  RECENT_PER_CREATOR,
  PUBLIC_GROUPS_PAGE,
  CREATED_SKEW_MS,
  TREND_WINDOW_MS,
  TREND_MIN_ACTIVE,
  createGroupIndex,
  pickCharter
}
