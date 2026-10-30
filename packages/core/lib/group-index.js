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
const { MAX_GROUP_WRITERS, MAX_GROUPS_PER_DIARY } = require('./records')
const { foldTokens, parseQuery, searchRank, RESULTS_MAX } = require('./search-text')

const DEFAULT_MAX_GROUPS = 4096
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

function shown (fn, ...args) {
  if (typeof fn !== 'function') return true
  try {
    return fn(...args) === true
  } catch {
    return false
  }
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
  // group -> { header: null | { kind, visibility, join, diary, name }, tokens, writers: Map<writer, { diary, seq, left }> }
  const groups = new Map()
  const writerGroup = new Map() // writer -> group
  const diaryWriters = new Map() // diary -> Set<writer>

  function ensureGroup (group) {
    let g = groups.get(group)
    if (g) return g
    if (groups.size >= groupCap) return null
    g = { header: null, tokens: [], writers: new Map() }
    groups.set(group, g)
    return g
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
    if (g) g.writers.delete(writer)
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
      const w = groups.get(group).writers.get(writer)
      w.left = left === true
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
        g.tokens = []
        prune(group)
        return true
      }
      const g = ensureGroup(group)
      if (!g) return false
      const { kind, visibility, join, diary, name } = header
      const shownName = visibility === 'public' && typeof name === 'string' ? name : null
      g.header = { kind, visibility, join, diary, name: shownName }
      g.tokens = shownName === null ? [] : foldTokens(shownName)
      return true
    } catch {
      return false
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
        if (!g.header || g.header.visibility !== 'public' || g.tokens.length === 0) continue
        if (searchRank(q, g.tokens, null) < 0) continue
        if (!shown(visible, group)) continue
        const members = new Set()
        for (const w of g.writers.values()) if (!w.left) members.add(w.diary)
        hits.push({ group, name: g.header.name, rank: g.tokens.join(' ') === exact ? 0 : 1, members: members.size })
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

  function clear () {
    groups.clear()
    writerGroup.clear()
    diaryWriters.clear()
  }

  function stats () {
    return { groups: groups.size, writers: writerGroup.size, maxGroups: groupCap, saturated: groups.size >= groupCap }
  }

  return { addWriter, setLeft, removeWriter, removeDiary, removeGroup, setHeader, header, writer, page, groupsOf, search, clear, stats }
}

module.exports = {
  DEFAULT_MAX_GROUPS,
  createGroupIndex
}
