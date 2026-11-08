'use strict'

// The member's own block list: whose posts, notices and messages this member
// chose not to see. It filters what this member reads and nothing else:
// diaries are public and replicated, so the other person can still read, follow and
// reply, is never told, and nothing about the block is published.
// Pure: no I/O and no clock, and it never throws on stored data.
//
// Entries are { key, on, t }, one per key, t in unix seconds. An unblock stays
// as on: false, so devices that merge their lists do not bring a block back.

const { BLOCK_MAX } = require('@varanda/rpc')

const HEX64 = /^[0-9a-f]{64}$/
const U32_MAX = 4294967295
// Unblocks kept beside the active entries; the oldest go first.
const UNBLOCKS_MAX = 128

function validEntry (e) {
  return e !== null && typeof e === 'object' && typeof e.key === 'string' && HEX64.test(e.key) &&
    typeof e.on === 'boolean' && Number.isSafeInteger(e.t) && e.t >= 0 && e.t <= U32_MAX
}

// The newer entry wins. At equal times the block wins, so the result does not
// depend on the order the entries arrive in (the rule of dm-fold's block ops).
function newer (a, b) {
  if (a.t !== b.t) return a.t > b.t ? a : b
  return a.on ? a : b
}

function oldestFirst (a, b) {
  return a.t - b.t || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
}

// Canonical form: valid entries only, one per key, oldest first, active and
// unblocked entries each cut to their cap (the newest stay).
function normalizeBlocks (list) {
  const byKey = new Map()
  for (const e of Array.isArray(list) ? list : []) {
    if (!validEntry(e)) continue
    const held = byKey.get(e.key)
    const entry = { key: e.key, on: e.on, t: e.t }
    byKey.set(e.key, held === undefined ? entry : newer(held, entry))
  }
  const all = [...byKey.values()].sort(oldestFirst)
  const active = all.filter((e) => e.on).slice(-BLOCK_MAX)
  const unblocked = all.filter((e) => !e.on).slice(-UNBLOCKS_MAX)
  return active.concat(unblocked).sort(oldestFirst)
}

// The keys this member blocked, as a Set.
function blockedKeys (list) {
  const keys = new Set()
  for (const e of normalizeBlocks(list)) if (e.on) keys.add(e.key)
  return keys
}

// -> { entries, changed, full }. A change gets a time above the key's last
// one, so it wins even on a device whose clock runs behind. The same state
// again changes nothing, and a new block past BLOCK_MAX is `full`.
function applyBlock (list, key, on, nowSec) {
  const entries = normalizeBlocks(list)
  const held = entries.find((e) => e.key === key)
  if (held === undefined ? !on : held.on === on) return { entries, changed: false, full: false }
  if (on && entries.filter((e) => e.on).length >= BLOCK_MAX) return { entries, changed: false, full: true }
  const floor = held === undefined ? 0 : Math.min(held.t + 1, U32_MAX)
  const t = Math.min(Math.max(nowSec, floor), U32_MAX)
  const next = entries.filter((e) => e.key !== key)
  next.push({ key, on, t })
  return { entries: normalizeBlocks(next), changed: true, full: false }
}

module.exports = { UNBLOCKS_MAX, normalizeBlocks, blockedKeys, applyBlock }
