'use strict'

// Connection slots shared fairly by remote address (issue #32). A full table
// makes room for a newcomer by displacing an unprotected connection of an
// address group that holds more slots than the newcomer's, so one address
// can no longer fill every slot and lock everyone else out, while connections
// the caller protects (certified seeders, proven members) are never touched.
// Browser-safe: pure string and table work, no node, hypercore or network
// modules, so the address is used only in memory and never leaves this table.
const clock = require('./clock')

// Same as HELLO_TIMEOUT_MS: a connection gets the time a hello (and a
// `prove`) may take before a newcomer of an address with no slot, or a
// rotation of its own address, can displace it.
const PROBATION_MS = 10000
// Hosts get a /64 from their provider, so a single host can hold a whole /64
// and must count as one address.
const IPV6_GROUP_BITS = 64
const UNKNOWN = 'unknown'
// Longer than any textual IPv6 address with a zone we accept, so garbage
// input costs nothing to reject.
const MAX_HOST_LENGTH = 128

const OCTET_RE = /^(0|[1-9][0-9]{0,2})$/
const HEXTET_RE = /^[0-9a-f]{1,4}$/
const ZONE_RE = /^[0-9a-z._~-]{1,64}$/

// -> [a, b, c, d] or null. Leading zeros are refused because some stacks
// read them as octal, so '010.0.0.1' could name two different addresses.
function parseIPv4 (s) {
  const parts = s.split('.')
  if (parts.length !== 4) return null
  const out = []
  for (const p of parts) {
    if (!OCTET_RE.test(p)) return null
    const n = Number(p)
    if (n > 255) return null
    out.push(n)
  }
  return out
}

// -> 8 numbers (16 bits each) or null.
function parseIPv6 (s) {
  const halves = s.split('::')
  if (halves.length > 2) return null
  const head = halves[0] === '' ? [] : halves[0].split(':')
  const tail = halves.length === 2 ? (halves[1] === '' ? [] : halves[1].split(':')) : null
  const all = tail === null ? head : head.concat(tail)
  // A dotted quad may only end the address, never sit before a trailing '::'.
  const v4Last = tail === null || tail.length > 0
  const groups = []
  for (let i = 0; i < all.length; i++) {
    const part = all[i]
    if (v4Last && i === all.length - 1 && part.includes('.')) {
      const v4 = parseIPv4(part)
      if (v4 === null) return null
      groups.push(v4[0] * 256 + v4[1], v4[2] * 256 + v4[3])
      continue
    }
    if (!HEXTET_RE.test(part)) return null
    groups.push(parseInt(part, 16))
  }
  if (tail === null) return groups.length === 8 ? groups : null
  // '::' stands for at least one zero group.
  if (groups.length > 7) return null
  const zeros = new Array(8 - groups.length).fill(0)
  const headLen = head.length
  return groups.slice(0, headLen).concat(zeros, groups.slice(headLen))
}

function addressGroup (host) {
  try {
    if (typeof host !== 'string' || host.length === 0 || host.length > MAX_HOST_LENGTH) return UNKNOWN
    let s = host.toLowerCase()
    if (!s.includes(':')) {
      const v4 = parseIPv4(s)
      return v4 === null ? UNKNOWN : v4.join('.')
    }
    if (s[0] === '[') {
      if (s[s.length - 1] !== ']') return UNKNOWN
      s = s.slice(1, -1)
    }
    const pct = s.indexOf('%')
    if (pct !== -1) {
      if (!ZONE_RE.test(s.slice(pct + 1))) return UNKNOWN
      s = s.slice(0, pct)
    }
    const g = parseIPv6(s)
    if (g === null) return UNKNOWN
    // An IPv4-mapped address is the IPv4 host itself (dual-stack sockets
    // report IPv4 peers this way), so it shares that host's group.
    if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) {
      return [g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff].join('.')
    }
    return g.slice(0, IPV6_GROUP_BITS / 16).map((n) => n.toString(16)).join(':') + '::/' + IPV6_GROUP_BITS
  } catch {
    return UNKNOWN
  }
}

function createSlots ({ limit, probationMs = PROBATION_MS, now = clock.now, isProtected = () => false } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('limit must be an integer >= 1')
  if (typeof probationMs !== 'number' || !(probationMs >= 0)) throw new TypeError('probationMs must be a number >= 0')
  if (typeof now !== 'function') throw new TypeError('now must be a function')
  if (typeof isProtected !== 'function') throw new TypeError('isProtected must be a function')

  // entry -> admission sequence (insertion order; breaks ties on `since`).
  const live = new Map()
  const counts = new Map()
  let seq = 0

  function count (group) {
    return counts.get(group) || 0
  }

  // A throwing isProtected must not shield a flood entry.
  function guarded (e) {
    try {
      return isProtected(e) === true
    } catch {
      return false
    }
  }

  function remove (entry) {
    if (!live.has(entry)) return false
    live.delete(entry)
    const n = count(entry.group) - 1
    if (n > 0) counts.set(entry.group, n)
    else counts.delete(entry.group)
    return true
  }

  // Shares are counted over unprotected entries only: a protected entry
  // keeps its slot without weighing on its address, so members that proved
  // never make a newcomer of their own (shared) address look like a flood.
  // Rules, n being the newcomer's unprotected group size:
  //   (a) a group with n + 2 or more gives its newest entry, at any age;
  //   (b) an address with no unprotected entry takes an expired slot of any
  //       address, so a newcomer always gets in once slots have aged;
  //   (c) an address rotates its own expired entries.
  // Groups one apart never swap (no rule for n + 1 when n > 0): a swap
  // gains no fairness and the displaced client would swap back on redial.
  function pickVictim (group, t) {
    const free = new Map()
    const candidates = []
    for (const [e, s] of live) {
      if (guarded(e)) continue
      free.set(e.group, (free.get(e.group) || 0) + 1)
      candidates.push([e, s])
    }
    const n = free.get(group) || 0
    let best = null
    let bestCount = -1
    let bestSince = -Infinity
    let bestSeq = -1
    for (const [e, s] of candidates) {
      const cg = free.get(e.group)
      const expired = t - e.since >= probationMs
      if (!(cg >= n + 2 || (n === 0 && expired) || (e.group === group && expired))) continue
      if (cg < bestCount) continue
      if (cg === bestCount && (e.since < bestSince || (e.since === bestSince && s < bestSeq))) continue
      best = e
      bestCount = cg
      bestSince = e.since
      bestSeq = s
    }
    return best
  }

  function admit (group) {
    if (typeof group !== 'string') group = UNKNOWN
    const t = now()
    let victim = null
    if (live.size >= limit) {
      victim = pickVictim(group, t)
      if (victim === null) return null
      remove(victim)
    }
    const entry = { group, since: t, data: null }
    live.set(entry, seq++)
    counts.set(group, count(group) + 1)
    return { entry, victim }
  }

  return {
    admit,
    remove,
    count,
    get size () {
      return live.size
    },
    entries () {
      return Array.from(live.keys())[Symbol.iterator]()
    }
  }
}

module.exports = {
  PROBATION_MS,
  IPV6_GROUP_BITS,
  addressGroup,
  createSlots
}
