'use strict'

// The signed blocklist snapshot (docs/protocol.md section 3, "Blocklist
// snapshot"): the association certifies a moderator key (cert.js
// createModeratorCert) and the moderator signs numbered snapshots of the
// blocked diary keys and the revoked issuer keys. Every node keeps the newest
// snapshot it accepted and enforces it; snapshots travel peer to peer
// (blocklist-net.js), so this module only decides which snapshot wins.
//
// Pure: b4a, hypercore-crypto and ./cert only (no '#fs', no network). The
// caller supplies `load`/`save` to createBlocklistState.
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const cert = require('./cert')

const LF = '\n'
const PREFIX = 'varanda-blocklist-v1'
const SNAPSHOT_KEYS = ['v', 'seq', 'date', 'blocked', 'revokedIssuers', 'moderator', 'moderatorDate', 'moderatorSignature', 'signature']
// Equal to MAX_INVENTORY (packages/core/lib/admission.js:18): a seeder never
// serves more logs than one snapshot can block.
const MAX_BLOCKED = 4096
const MAX_REVOKED_ISSUERS = 64
// 4096 x 67 bytes (64 hex, two quotes, a comma) + 64 x 67 + the header fits
// with room to spare, and stays far under MAX_EXTERNAL_FRAME (seeder.js:102).
const MAX_SNAPSHOT_BYTES = 393216

// A sorted list of distinct lowercase hex64 keys, at most `max` long.
// Strictly increasing implies both sorted and distinct.
function validKeyList (list, max) {
  if (!Array.isArray(list) || list.length > max) return false
  for (let i = 0; i < list.length; i++) {
    if (!cert.isLowerHex(list[i], 32)) return false
    if (i > 0 && !(list[i - 1] < list[i])) return false
  }
  return true
}

// null for a valid snapshot shape, else 'malformed'. Never throws.
function validateSnapshotShape (s) {
  try {
    if (!cert.isPlainObject(s) || !cert.hasExactKeys(s, SNAPSHOT_KEYS)) return 'malformed'
    if (s.v !== 1) return 'malformed'
    if (!Number.isSafeInteger(s.seq) || s.seq < 1) return 'malformed'
    if (!cert.isCanonicalIso(s.date) || !cert.isCanonicalIso(s.moderatorDate)) return 'malformed'
    if (!validKeyList(s.blocked, MAX_BLOCKED)) return 'malformed'
    if (!validKeyList(s.revokedIssuers, MAX_REVOKED_ISSUERS)) return 'malformed'
    if (!cert.isLowerHex(s.moderator, 32)) return 'malformed'
    if (!cert.isLowerHex(s.moderatorSignature, 64) || !cert.isLowerHex(s.signature, 64)) return 'malformed'
    return null
  } catch {
    return 'malformed'
  }
}

// LF-joined, no trailing LF; seq in decimal; each key list joined by ','
// ('' when empty).
function snapshotPayload (s) {
  return b4a.from([
    PREFIX,
    String(s.seq),
    s.date,
    s.blocked.join(','),
    s.revokedIssuers.join(','),
    s.moderator,
    s.moderatorDate,
    s.moderatorSignature
  ].join(LF), 'utf8')
}

// Plain-data copy with fresh arrays, so a caller (or a getter) can never
// change a snapshot after it was checked.
function copySnapshot (s) {
  const out = {}
  for (const k of SNAPSHOT_KEYS) {
    const v = s[k]
    out[k] = Array.isArray(v) ? Array.from(v) : v
  }
  return out
}

function normalizeKeyList (list, max, name) {
  if (!Array.isArray(list)) throw new TypeError(name + ' must be an array')
  const keys = new Set()
  for (const k of list) {
    if (!cert.isHex(k, 32)) throw new TypeError(name + ' must hold 64 hex character keys')
    keys.add(k.toLowerCase())
  }
  if (keys.size > max) throw new TypeError(name + ' holds more than ' + max + ' keys')
  return [...keys].sort()
}

// Keys are accepted in any case and order; they are stored lowercase, sorted
// and de-duplicated. The moderator certificate must verify for its own
// association and name the signing key, so a moderator never signs a
// snapshot a verifier would reject for its certificate.
function createSnapshot ({ seq, date = new Date().toISOString(), blocked = [], revokedIssuers = [] } = {}, moderatorKeyPair, moderatorCert) {
  if (!Number.isSafeInteger(seq) || seq < 1) throw new TypeError('seq must be a safe integer >= 1')
  if (!cert.isCanonicalIso(date)) throw new TypeError('date must be a canonical ISO-8601 UTC string')
  const blockedKeys = normalizeKeyList(blocked, MAX_BLOCKED, 'blocked')
  const revokedKeys = normalizeKeyList(revokedIssuers, MAX_REVOKED_ISSUERS, 'revokedIssuers')
  if (!moderatorKeyPair || !isKeyBytes(moderatorKeyPair.secretKey, 64) || !isKeyBytes(moderatorKeyPair.publicKey, 32)) {
    throw new TypeError('moderator key pair must have a 32-byte public key and a 64-byte secret key')
  }
  if (cert.validateModeratorCertShape(moderatorCert) !== null) throw new TypeError('invalid moderator certificate')
  if (b4a.toString(moderatorKeyPair.publicKey, 'hex') !== moderatorCert.moderator) throw new TypeError('moderator certificate is for another key')
  if (!cert.verifyModeratorCert(moderatorCert, moderatorCert.association).ok) throw new TypeError('invalid moderator certificate')
  const snapshot = {
    v: 1,
    seq,
    date,
    blocked: blockedKeys,
    revokedIssuers: revokedKeys,
    moderator: moderatorCert.moderator,
    moderatorDate: moderatorCert.date,
    moderatorSignature: moderatorCert.signature,
    signature: ''
  }
  snapshot.signature = b4a.toString(crypto.sign(snapshotPayload(snapshot), moderatorKeyPair.secretKey), 'hex')
  if (b4a.byteLength(JSON.stringify(snapshot)) > MAX_SNAPSHOT_BYTES) throw new Error('snapshot exceeds MAX_SNAPSHOT_BYTES')
  return snapshot
}

function isKeyBytes (buf, length) {
  return (b4a.isBuffer(buf) || buf instanceof Uint8Array) && buf.byteLength === length
}

// { ok: true } | { ok: false, reason } with the FIRST failing reason in the
// order 'malformed', 'bad-moderator-signature', 'bad-signature'. The
// snapshot carries no association field: its embedded moderator certificate
// is checked against `associationHex`, so a moderator of another association
// fails as 'bad-moderator-signature' ('untrusted-association' is only
// reachable through verifyModeratorCert on a whole certificate). An issuer
// key or the association key itself cannot moderate: their signatures use
// other prefixes. Never throws.
function verifySnapshot (snapshot, associationHex) {
  try {
    if (validateSnapshotShape(snapshot) !== null) return { ok: false, reason: 'malformed' }
    if (!cert.isHex(associationHex, 32)) return { ok: false, reason: 'malformed' }
    const s = copySnapshot(snapshot)
    if (validateSnapshotShape(s) !== null) return { ok: false, reason: 'malformed' }
    const moderatorCert = {
      v: 1,
      moderator: s.moderator,
      date: s.moderatorDate,
      association: associationHex.toLowerCase(),
      signature: s.moderatorSignature
    }
    const verdict = cert.verifyModeratorCert(moderatorCert, associationHex)
    if (!verdict.ok) {
      return { ok: false, reason: verdict.reason === 'bad-signature' ? 'bad-moderator-signature' : verdict.reason }
    }
    if (!crypto.verify(snapshotPayload(s), b4a.from(s.signature, 'hex'), b4a.from(s.moderator, 'hex'))) {
      return { ok: false, reason: 'bad-signature' }
    }
    return { ok: true }
  } catch {
    return { ok: false, reason: 'malformed' }
  }
}

// Milliseconds of a moderatorDate, -Infinity for '' (no snapshot). Canonical
// ISO dates may have expanded years ('+010000-...'), which do not sort as
// strings, so dates are compared as numbers.
function dateValue (d) {
  if (d === '' || d === undefined || d === null) return -Infinity
  const ms = Date.parse(d)
  return Number.isFinite(ms) ? ms : -Infinity
}

// Total order on (moderatorDate, seq): negative when `a` is older than `b`,
// 0 when equal, positive when newer. `a`/`b` may be snapshots, `have`
// messages ({ moderatorDate, seq }, moderatorDate '' when none) or null
// (= nothing). This is the order acceptSnapshot uses; it does not look at
// the moderator, so two moderators certified at the same date compare by seq
// here while acceptSnapshot keeps the first one stored. Never throws.
function compareSnapshots (a, b) {
  try {
    const da = a ? dateValue(a.moderatorDate) : -Infinity
    const db = b ? dateValue(b.moderatorDate) : -Infinity
    if (da !== db) return da < db ? -1 : 1
    const sa = a && Number.isSafeInteger(a.seq) ? a.seq : 0
    const sb = b && Number.isSafeInteger(b.seq) ? b.seq : 0
    if (sa !== sb) return sa < sb ? -1 : 1
    return 0
  } catch {
    return 0
  }
}

// Whether `next` replaces `previous` (the snapshot this node holds, trusted
// local state, or null). { ok: true } | { ok: false, reason } where reason is
// a verifySnapshot reason, 'same' (the very snapshot already held: a no-op,
// not an error) or 'stale'. Accepted when `next` verifies and
//   - previous is null, or
//   - next.moderatorDate is later (a newer association-certified moderator
//     replaces an older one; its seq restarts), or
//   - same moderator and moderatorDate and a higher seq.
// A different moderator with the same moderatorDate is 'stale': the first
// one stored wins. Never throws.
function acceptSnapshot (previous, next0, associationHex) {
  try {
    if (validateSnapshotShape(next0) !== null) return { ok: false, reason: 'malformed' }
    // Verify and order the SAME plain copy: reading `next0` twice would let
    // an object with getters pass verification with one seq and the ordering
    // check with another.
    const next = copySnapshot(next0)
    const verdict = verifySnapshot(next, associationHex)
    if (!verdict.ok) return verdict
    if (previous === null || previous === undefined) return { ok: true }
    if (next.seq === previous.seq && next.moderator === previous.moderator && next.signature === previous.signature) {
      return { ok: false, reason: 'same' }
    }
    const dn = dateValue(next.moderatorDate)
    const dp = dateValue(previous.moderatorDate)
    if (dn > dp) return { ok: true }
    if (dn === dp && next.moderator === previous.moderator && next.seq > previous.seq) return { ok: true }
    return { ok: false, reason: 'stale' }
  } catch {
    return { ok: false, reason: 'malformed' }
  }
}

function blockedSet (snapshot) {
  try {
    return new Set(snapshot && Array.isArray(snapshot.blocked) ? snapshot.blocked : [])
  } catch {
    return new Set()
  }
}

function revokedIssuerSet (snapshot) {
  try {
    return new Set(snapshot && Array.isArray(snapshot.revokedIssuers) ? snapshot.revokedIssuers : [])
  } catch {
    return new Set()
  }
}

function isBlocked (set, key) {
  try {
    const k = cert.normalizeHex(key)
    return k !== null && set.has(k)
  } catch {
    return false
  }
}

function difference (a, b) {
  const out = new Set()
  for (const k of a) if (!b.has(k)) out.add(k)
  return out
}

// The node's one current snapshot. `load()` (sync or async) returns the
// stored snapshot or null; a stored snapshot that no longer verifies for
// `association` is ignored. `save(snapshot)` (sync or async) persists it.
//
// offer(snapshot) runs in ONE promise queue per state: inside the queue it
// re-runs acceptSnapshot against the then-current snapshot, awaits `save`
// and only then swaps, so two offers racing each other can never both be
// adopted on a stale comparison (a write queue alone would not repeat the
// comparison). It resolves { adopted, reason, added, removed,
// revokedAdded, revokedRemoved } (the four Sets are the blocked / revoked
// issuer keys that changed; empty unless adopted; reason null when adopted).
// A failing `save` rejects that offer and keeps the previous snapshot; a
// failing `load` rejects ready() and every offer.
function createBlocklistState ({ association, load, save } = {}) {
  if (!cert.isHex(association, 32)) throw new TypeError('association must be 64 hex characters')
  if (typeof save !== 'function') throw new TypeError('save must be a function')
  const associationHex = association.toLowerCase()
  let snapshot = null
  let blocked = new Set()
  let revoked = new Set()

  function adopt (s) {
    snapshot = s
    blocked = blockedSet(s)
    revoked = revokedIssuerSet(s)
  }

  const ready = Promise.resolve().then(async () => {
    if (typeof load !== 'function') return
    const stored = await load()
    if (stored === null || stored === undefined) return
    // Adopt exactly the copy that was verified (never re-read `stored`).
    let copy = null
    try {
      if (validateSnapshotShape(stored) === null) copy = copySnapshot(stored)
    } catch {}
    if (copy !== null && verifySnapshot(copy, associationHex).ok) adopt(copy)
  })
  let queue = ready.catch(() => {})

  function offer (next) {
    const run = queue.then(async () => {
      // A failed load fails every offer (fail closed): adopting on top of an
      // unknown stored snapshot could replace a newer one with an older one.
      await ready
      let copy = null
      try {
        if (validateSnapshotShape(next) === null) copy = copySnapshot(next)
      } catch {}
      const verdict = copy === null ? { ok: false, reason: 'malformed' } : acceptSnapshot(snapshot, copy, associationHex)
      if (!verdict.ok) {
        return { adopted: false, reason: verdict.reason, added: new Set(), removed: new Set(), revokedAdded: new Set(), revokedRemoved: new Set() }
      }
      const prevBlocked = blocked
      const prevRevoked = revoked
      await save(copy)
      adopt(copy)
      return {
        adopted: true,
        reason: null,
        added: difference(blocked, prevBlocked),
        removed: difference(prevBlocked, blocked),
        revokedAdded: difference(revoked, prevRevoked),
        revokedRemoved: difference(prevRevoked, revoked)
      }
    })
    // The queue survives a failing load or save; the caller still sees it.
    queue = run.catch(() => {})
    return run
  }

  return {
    ready: () => ready,
    current: () => snapshot,
    blocked: () => blocked,
    revokedIssuers: () => revoked,
    offer
  }
}

module.exports = {
  PREFIX,
  SNAPSHOT_KEYS,
  MAX_BLOCKED,
  MAX_REVOKED_ISSUERS,
  MAX_SNAPSHOT_BYTES,
  snapshotPayload,
  validateSnapshotShape,
  createSnapshot,
  verifySnapshot,
  compareSnapshots,
  acceptSnapshot,
  blockedSet,
  revokedIssuerSet,
  isBlocked,
  createBlocklistState
}
