'use strict'

const nodeCrypto = require('node:crypto')

// Stateless single-use nonces for the unsigned start routes of ./phone-routes.js
// and ./age-routes.js. start allocates nothing, so a flood of starts cannot
// push out a member's unspent nonce; only spent nonces are kept, until they
// expire, to refuse a replay.
//
// A nonce is base64url of exactly 32 bytes (43 characters, the same opaque
// token clients already handle): 12 random bytes, a 4-byte big-endian expiry
// in unix seconds, and the first 16 bytes of HMAC-SHA256 under a per-process
// secret over the route's label, the member key, the random bytes and the
// expiry. A restart draws a new secret, which expires every outstanding nonce.

const TTL_MS = 600 * 1000
// Every spend needs a request through the service's one global token bucket
// (./server.js, by default 20/s with a burst of 100), so within one 10-minute
// TTL at most about 12100 nonces can be spent. A full table refuses the spend
// instead of evicting a live entry, which would reopen a replay. This is the
// floor: ./server.js sizes the table from its bucket with spentCapacity.
const MAX_SPENT = 16384
const RAW_BYTES = 32
const RANDOM_BYTES = 12
const EXPIRY_BYTES = 4
const MAC_BYTES = 16
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/
const HEX64_RE = /^[0-9a-f]{64}$/

// createStartNonces({ label, now, ttlMs, max }) -> { mint, spend, size }.
// `label` keeps one route's nonces from spending at another.
function createStartNonces ({ label, now = Date.now, ttlMs = TTL_MS, max = MAX_SPENT }) {
  if (typeof label !== 'string' || label.length === 0 || label.includes('\n')) throw new TypeError('label must be a non-empty string')
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000) throw new TypeError('ttlMs must be an integer of at least 1000')
  if (!Number.isSafeInteger(max) || max < 1) throw new TypeError('max must be a positive integer')
  const prefix = Buffer.from(label + '\n')
  let secret = nodeCrypto.randomBytes(32)
  // nonce -> expiresAt (ms) of the nonces already spent.
  const spent = new Map()

  // Never steps back, as the recovery nonce clock (./recovery-routes.js): a
  // wall clock corrected backwards must not revive a nonce whose spent entry
  // was already pruned. A step back of more than one TTL voids every
  // outstanding nonce instead (a new secret fails each old MAC, which is what
  // makes clearing the spent table safe).
  let highWater = 0
  function clock () {
    const t = now()
    if (t + ttlMs < highWater) {
      secret = nodeCrypto.randomBytes(32)
      spent.clear()
      highWater = t
    } else if (t > highWater) {
      highWater = t
    }
    return highWater
  }

  function macOf (member, random, expiry) {
    const h = nodeCrypto.createHmac('sha256', secret)
    h.update(prefix)
    h.update(Buffer.from(member, 'hex'))
    h.update(random)
    h.update(expiry)
    return h.digest().subarray(0, MAC_BYTES)
  }

  function prune (t) {
    for (const [k, at] of spent) if (at <= t) spent.delete(k)
  }

  function mint (member) {
    if (typeof member !== 'string' || !HEX64_RE.test(member)) throw new TypeError('member must be hex64')
    const random = nodeCrypto.randomBytes(RANDOM_BYTES)
    const expiry = Buffer.alloc(EXPIRY_BYTES)
    expiry.writeUInt32BE(Math.ceil((clock() + ttlMs) / 1000))
    return Buffer.concat([random, expiry, macOf(member, random, expiry)]).toString('base64url')
  }

  // -> true when this process minted `nonce` for `member`, it has not expired
  // and was not spent yet; it is then spent. Only the canonical spelling is
  // accepted (43 characters carry 2 spare bits), so the spent table cannot be
  // dodged by re-spelling a nonce. The clock is read before the MAC, so a
  // secret rotation it triggers fails this nonce.
  function spend (member, nonce) {
    const t = clock()
    if (typeof member !== 'string' || !HEX64_RE.test(member)) return false
    if (typeof nonce !== 'string' || !TOKEN_RE.test(nonce)) return false
    const raw = Buffer.from(nonce, 'base64url')
    if (raw.length !== RAW_BYTES || raw.toString('base64url') !== nonce) return false
    const random = raw.subarray(0, RANDOM_BYTES)
    const expiry = raw.subarray(RANDOM_BYTES, RANDOM_BYTES + EXPIRY_BYTES)
    const mac = raw.subarray(RANDOM_BYTES + EXPIRY_BYTES)
    if (!nodeCrypto.timingSafeEqual(mac, macOf(member, random, expiry))) return false
    const expiresAt = expiry.readUInt32BE(0) * 1000
    if (expiresAt <= t || spent.has(nonce)) return false
    if (spent.size >= max) prune(t)
    if (spent.size >= max) return false
    spent.set(nonce, expiresAt)
    return true
  }

  // The live spent entries.
  function size () {
    prune(clock())
    return spent.size
  }

  return { mint, spend, size }
}

// The spent table a service needs when every spend rides one request through
// a token bucket of `ratePerSecond` and `burst`: one TTL holds at most
// rate x TTL + burst of them. Never below MAX_SPENT.
function spentCapacity (ratePerSecond, burst, ttlMs = TTL_MS) {
  return Math.max(MAX_SPENT, Math.ceil(ratePerSecond * ttlMs / 1000) + burst)
}

module.exports = { createStartNonces, spentCapacity, MAX_SPENT }
