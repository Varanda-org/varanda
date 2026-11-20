'use strict'

// Seeder-wide storage budget (docs/protocol.md section 5, "Storage budget").
// The per-log quotas bound one core; this bounds the sum of every core the
// seeder holds (diaries, media cores, group cores), so the total no longer
// grows with members x the per-log quota.
//
// Pure bookkeeping, no I/O: the seeder tells it what it holds and asks it
// three questions. Every answer depends only on the charges it was given,
// which come from the signed sizes of the cores, so a restart over the same
// stored cores reaches the same answers (the drop order included).
//
// - held = served + leaving (a core being purged is still on disk).
// - An admission fits while held + reserved + charge <= budget - reserve,
//   and while its member's share stays within memberCap (a fair share per
//   member: its own cores plus the group roots its joins brought in). A
//   root admission counts the whole share; an admission of the member's own
//   core counts only its own cores, so roots, whose size their key holder
//   sets, never keep a member's own cores out: they are shed instead.
// - Served cores may grow into the reserve; past the budget itself, owners
//   go until served <= budget - reserve (hysteresis: the next block does
//   not trigger another drop at once): roots first, then members, each the
//   largest first.
// - A member whose served share grows past memberCap sheds its roots,
//   largest first, and goes itself only when its own cores still pass it.
//
// Requires nothing, so it loads on every runtime.

// Bytes charged per block on top of its payload: an estimate of the tree
// nodes and index entries the store keeps for it.
const STORAGE_BLOCK_OVERHEAD = 128
const DEFAULT_STORAGE_BYTES = 68719476736 // 64 GiB

function reserveFor (budget) {
  return Math.floor(budget / 10)
}

// A signed size past the safe integers counts as unbounded, never as 0: a
// tree can claim more than Number can sum exactly.
function count (n) {
  if (Number.isSafeInteger(n)) return n > 0 ? n : 0
  return n > 0 ? Infinity : 0
}

// The charge of a core from its signed sizes. maxBytes / maxBlocks cap what
// is counted for a core whose kept part is bounded below its signed size (a
// cut group writer keeps at most the log quota). Infinity when nothing caps
// a size past the safe integers: no admission fits it (reserveCharge), and
// such a core fails its log quota before it is ever served.
function coreCharge ({ length, byteLength } = {}, { maxBytes = Infinity, maxBlocks = Infinity } = {}) {
  const charge = Math.min(count(byteLength), maxBytes) + Math.min(count(length), maxBlocks) * STORAGE_BLOCK_OVERHEAD
  return Number.isSafeInteger(charge) ? charge : Infinity
}

function checkCharge (charge) {
  if (!Number.isSafeInteger(charge) || charge < 0) throw new TypeError('charge must be a non-negative safe integer')
}

// The fair share of one member: a sixteenth of the budget, never less
// than one member at every quota (`full`, from the seeder's limits).
function memberCapFor (budget, full = 0) {
  return Math.max(Math.floor(budget / 16), full)
}

function createStorageBudget ({ budget, reserve = null, memberCap = Infinity } = {}) {
  if (!Number.isSafeInteger(budget) || budget < 1) throw new TypeError('budget must be a positive safe integer')
  const kept = reserve === null ? reserveFor(budget) : reserve
  if (!Number.isSafeInteger(kept) || kept < 0 || kept >= budget) throw new TypeError('reserve must be a safe integer in [0, budget)')
  if (memberCap !== Infinity && (!Number.isSafeInteger(memberCap) || memberCap < 1)) throw new TypeError('memberCap must be a positive safe integer')
  const limit = budget - kept

  const served = new Map() // key -> { owner, member, first, charge }
  const leaving = new Map() // key -> charge
  const reserved = new Map() // key -> { charge, member, first }
  // member -> { served, reserved, ownServed, ownReserved }: own* leave out
  // the roots
  const members = new Map()
  const overCap = new Set() // members whose served share passes memberCap
  let servedSum = 0
  let leavingSum = 0
  let reservedSum = 0

  function share (member, field, delta, first) {
    if (member === null) return
    let e = members.get(member)
    if (e === undefined) members.set(member, (e = { served: 0, reserved: 0, ownServed: 0, ownReserved: 0 }))
    e[field] += delta
    if (!first) e[field === 'served' ? 'ownServed' : 'ownReserved'] += delta
    if (e.served > memberCap) overCap.add(member)
    else overCap.delete(member)
    if (e.served === 0 && e.reserved === 0) members.delete(member)
  }

  // The share member uses: every core, or with own only its own cores.
  function memberUse (member, { own = false } = {}) {
    const e = members.get(member)
    if (e === undefined) return 0
    return own ? e.ownServed + e.ownReserved : e.served + e.reserved
  }

  function unreserve (key) {
    const entry = reserved.get(key)
    if (entry === undefined) return
    reserved.delete(key)
    reservedSum -= entry.charge
    share(entry.member, 'reserved', -entry.charge, entry.first)
  }

  function unleave (key) {
    const charge = leaving.get(key)
    if (charge === undefined) return
    leaving.delete(key)
    leavingSum -= charge
  }

  function unserve (key) {
    const entry = served.get(key)
    if (entry === undefined) return null
    served.delete(key)
    servedSum -= entry.charge
    share(entry.member, 'served', -entry.charge, entry.first)
    return entry
  }

  // A served core, or a new charge for one (growth). Its reservation, if
  // any, ends here and is the floor of this charge: a core is served before
  // its replica holds the signed sizes the reservation was made from, so a
  // charge read from it then would let other admissions overshoot.
  // `owner` is the unit the drop order counts and drops; `member` is whose
  // fair share it uses (a root: its own owner, the share of the member
  // whose join brought it in); `first` marks a root, dropped before members.
  function set (key, owner, charge, { member = owner, first = false } = {}) {
    if (typeof owner !== 'string') throw new TypeError('owner must be a string')
    if (typeof member !== 'string') throw new TypeError('member must be a string')
    checkCharge(charge)
    const prev = reserved.get(key)
    const kept = Math.max(charge, prev === undefined ? 0 : prev.charge)
    unreserve(key)
    unleave(key)
    unserve(key)
    served.set(key, { owner, member, first: first === true, charge: kept })
    servedSum += kept
    share(member, 'served', kept, first === true)
  }

  // Served -> being purged: still on disk, no longer counted as served.
  function leave (key) {
    const entry = unserve(key)
    if (entry === null) return
    unleave(key)
    leaving.set(key, entry.charge)
    leavingSum += entry.charge
  }

  // Gone from the store (purged), or never stored.
  function release (key) {
    unserve(key)
    unleave(key)
    unreserve(key)
  }

  function held () {
    return servedSum + leavingSum
  }

  // Records charge for an admission in flight when it fits the budget and,
  // with a member, that member's fair share (a root, `first`, against the
  // whole share; the member's own core against its own cores); false
  // otherwise.
  function reserveCharge (key, charge, member = null, { first = false } = {}) {
    if (charge === Infinity) return false
    checkCharge(charge)
    const root = first === true
    if (!fits(key, charge)) return false
    const prev = reserved.get(key)
    if (member !== null) {
      const mine = prev !== undefined && prev.member === member && (root || !prev.first) ? prev.charge : 0
      if (memberUse(member, { own: !root }) - mine + charge > memberCap) return false
    }
    unreserve(key)
    reserved.set(key, { charge, member, first: root })
    reservedSum += charge
    share(member, 'reserved', charge, root)
    return true
  }

  // Whether charge for key fits the budget alone, whatever the shares
  // (tells a refusal by the budget from one by a member's share).
  function fits (key, charge) {
    if (!Number.isSafeInteger(charge) || charge < 0) return false
    const prev = reserved.get(key)
    return held() + reservedSum - (prev === undefined ? 0 : prev.charge) + charge <= limit
  }

  // Whether any admission could fit (checked before fetching a block 0).
  function room () {
    return held() + reservedSum < limit
  }

  // Whether an admission for member could fit its fair share: a root
  // (`first`) against the whole share, its own core against its own cores.
  function memberRoom (member, { first = false } = {}) {
    return memberUse(member, { own: first !== true }) < memberCap
  }

  function capOver () {
    return overCap.size > 0
  }

  // For each member whose served share passes memberCap (by member key):
  // the roots it sheds, largest first (ties to the smaller key), until it
  // fits, what it holds then (`left`), and whether that still passes the
  // share (`drop`: only its own cores are left, and they pass it).
  function capVictims () {
    const out = []
    for (const member of [...overCap].sort()) {
      const e = members.get(member)
      const roots = []
      for (const [key, entry] of served) {
        if (entry.first && entry.member === member && entry.owner !== member) roots.push({ key, bytes: entry.charge })
      }
      roots.sort((a, b) => (b.bytes - a.bytes) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      let left = e.served
      const shed = []
      for (const root of roots) {
        if (left <= memberCap) break
        shed.push(root)
        left -= root.bytes
      }
      out.push({ member, bytes: e.served, roots: shed, drop: left > memberCap, left })
    }
    return out
  }

  function over () {
    return servedSum > budget
  }

  // The owners to drop, in order, with their charges: [] unless over().
  // Roots first (re-fetchable, while a member drop loses a diary), then
  // members; within each, the largest charge first; ties go to the larger
  // rank(owner) (the newer admission), then to the smaller owner key. The
  // shortest prefix that brings served down to budget - reserve, or every
  // owner.
  function victims (rank = () => -1) {
    if (!over()) return []
    const owners = new Map()
    for (const { owner, first, charge } of served.values()) {
      const o = owners.get(owner)
      if (o === undefined) owners.set(owner, { charge, first })
      else o.charge += charge
    }
    const list = []
    for (const [owner, { charge, first }] of owners) {
      const r = rank(owner)
      list.push({ owner, charge, first: first ? 1 : 0, rank: Number.isFinite(r) ? r : -1 })
    }
    list.sort((a, b) => (b.first - a.first) || (b.charge - a.charge) || (b.rank - a.rank) || (a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0))
    const out = []
    let left = servedSum
    for (const { owner, charge } of list) {
      if (left <= limit) break
      out.push({ owner, bytes: charge })
      left -= charge
    }
    return out
  }

  // The served keys charged to owner.
  function keysOf (owner) {
    const keys = []
    for (const [key, entry] of served) if (entry.owner === owner) keys.push(key)
    return keys
  }

  function stats () {
    return { used: held(), served: servedSum, reserved: reservedSum, budget, reserve: kept }
  }

  return {
    budget,
    reserve: kept,
    limit,
    memberCap,
    set,
    leave,
    release,
    reserveCharge,
    unreserve,
    fits,
    room,
    memberRoom,
    memberUse,
    over,
    capOver,
    victims,
    capVictims,
    keysOf,
    stats
  }
}

module.exports = {
  STORAGE_BLOCK_OVERHEAD,
  DEFAULT_STORAGE_BYTES,
  reserveFor,
  memberCapFor,
  coreCharge,
  createStorageBudget
}
