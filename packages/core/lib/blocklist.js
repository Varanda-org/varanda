'use strict'

// The signed blocklist snapshot (docs/protocol.md section 3, "Blocklist
// snapshot"): the association certifies a moderator key (cert.js
// createModeratorCert) and the moderator signs numbered snapshots of the
// blocked diary keys and the revoked issuer keys. Every node keeps the newest
// snapshot it accepted and enforces it; snapshots travel peer to peer
// (blocklist-net.js), so this module only decides which snapshot wins.
//
// The same moderator also signs the hidden-posts list (#225, "Hidden-posts
// list"): single posts hidden without blocking their author. It is a
// separate document with its own prefix, numbering and channel
// ('varanda/blocklist/2', section 18 V7), so the snapshot, its file and
// channel 1 stay exactly what every older node reads.
//
// Pure: b4a, hypercore-crypto and ./cert only (no '#fs', no network). The
// caller supplies `load`/`save` (and `loadHidden`/`saveHidden`) to
// createBlocklistState.
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { verify } = require('./verified')
const cert = require('./cert')

const LF = '\n'
const PREFIX = 'varanda-blocklist-v1'
const SNAPSHOT_KEYS = ['v', 'seq', 'date', 'blocked', 'revokedIssuers', 'moderator', 'moderatorDate', 'moderatorSignature', 'signature']
// At least MAX_INVENTORY (packages/core/lib/admission.js): a seeder never
// serves more logs than one snapshot can block. Above it because a deleted
// account's key stays blocked for good (certificates never expire), so the
// list only grows. Raised from 4096: an older build reads a longer list as
// 'malformed' and keeps its last valid one (docs/protocol.md section 3).
const MAX_BLOCKED = 16384
const MAX_REVOKED_ISSUERS = 64
// 16384 x 67 bytes (64 hex, two quotes, a comma) + 64 x 67 + the header is
// 1102534 bytes at most (expanded-year dates, seq MAX_SAFE_INTEGER): 1.125
// MiB leaves about 75 KB of room and stays far under MAX_EXTERNAL_FRAME
// (frame-guard.js, 8 MiB). Every bound that carries a snapshot is sized
// from this one (blocklist-net.js, apps/cli mod-apply.js and
// account/mod-routes.js).
const MAX_SNAPSHOT_BYTES = 1179648
const HIDDEN_PREFIX = 'varanda-hidden-posts-v1'
const HIDDEN_KEYS = ['v', 'seq', 'date', 'hiddenPosts', 'moderator', 'moderatorDate', 'moderatorSignature', 'signature']
const MAX_HIDDEN_POSTS = 512
// 512 x 84 bytes ('<hex64>:<16 digits>', two quotes, a comma) + the header
// is about 43.5 KB at most (expanded-year dates, seq MAX_SAFE_INTEGER).
// blocklist-net.js MAX_HIDDEN_MESSAGE (64 KiB) holds it with its wrapper.
const MAX_HIDDEN_BYTES = 49152
const HIDDEN_RE = /^([0-9a-f]{64}):([1-9][0-9]{0,15})$/

// 'author:seq' -> { author, seq } or null. seq is a safe integer >= 1 in
// canonical decimal (block 0 is the certificate, never a post).
function parseHiddenRef (ref) {
  if (typeof ref !== 'string') return null
  const m = HIDDEN_RE.exec(ref)
  if (m === null) return null
  const seq = Number(m[2])
  if (!Number.isSafeInteger(seq)) return null
  return { author: m[1], seq }
}

function hiddenRef (author, seq) {
  return author + ':' + seq
}

// Strictly increasing (as strings) valid refs, at most MAX_HIDDEN_POSTS of
// them. Empty is valid: unhiding the last post publishes an empty list.
function validHiddenList (list) {
  if (!Array.isArray(list) || list.length > MAX_HIDDEN_POSTS) return false
  for (let i = 0; i < list.length; i++) {
    if (parseHiddenRef(list[i]) === null) return false
    if (i > 0 && !(list[i - 1] < list[i])) return false
  }
  return true
}

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

// null for a valid hidden-posts list shape, else 'malformed'. Never throws.
function validateHiddenShape (h) {
  try {
    if (!cert.isPlainObject(h) || !cert.hasExactKeys(h, HIDDEN_KEYS)) return 'malformed'
    if (h.v !== 1) return 'malformed'
    if (!Number.isSafeInteger(h.seq) || h.seq < 1) return 'malformed'
    if (!cert.isCanonicalIso(h.date) || !cert.isCanonicalIso(h.moderatorDate)) return 'malformed'
    if (!validHiddenList(h.hiddenPosts)) return 'malformed'
    if (!cert.isLowerHex(h.moderator, 32)) return 'malformed'
    if (!cert.isLowerHex(h.moderatorSignature, 64) || !cert.isLowerHex(h.signature, 64)) return 'malformed'
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

// The same layout under its own prefix, with the refs on one line.
function hiddenPayload (h) {
  return b4a.from([
    HIDDEN_PREFIX,
    String(h.seq),
    h.date,
    h.hiddenPosts.join(','),
    h.moderator,
    h.moderatorDate,
    h.moderatorSignature
  ].join(LF), 'utf8')
}

// Plain-data copy with fresh arrays, so a caller (or a getter) can never
// change a snapshot after it was checked.
function copyKeys (s, keys) {
  const out = {}
  for (const k of keys) {
    const v = s[k]
    out[k] = Array.isArray(v) ? Array.from(v) : v
  }
  return out
}

function copySnapshot (s) {
  return copyKeys(s, SNAPSHOT_KEYS)
}

function copyHidden (h) {
  return copyKeys(h, HIDDEN_KEYS)
}

// What verifyWith and acceptWith need to know about each signed document.
const SNAPSHOT_KIND = { validate: validateSnapshotShape, copy: copySnapshot, payload: snapshotPayload }
const HIDDEN_KIND = { validate: validateHiddenShape, copy: copyHidden, payload: hiddenPayload }

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

// [{ author, seq }] or 'author:seq' strings, any key case and order, with
// repeats -> sorted distinct canonical refs.
function normalizeHiddenList (list) {
  if (!Array.isArray(list)) throw new TypeError('hiddenPosts must be an array')
  const refs = new Set()
  for (const item of list) {
    let ref = null
    if (typeof item === 'string') {
      const i = item.indexOf(':')
      if (i > 0) ref = item.slice(0, i).toLowerCase() + item.slice(i)
    } else if (item !== null && typeof item === 'object' && cert.isHex(item.author, 32) && Number.isSafeInteger(item.seq)) {
      ref = hiddenRef(item.author.toLowerCase(), item.seq)
    }
    if (parseHiddenRef(ref) === null) throw new TypeError('hiddenPosts must hold an author key and a seq >= 1')
    refs.add(ref)
  }
  if (refs.size > MAX_HIDDEN_POSTS) throw new TypeError('hiddenPosts holds more than ' + MAX_HIDDEN_POSTS + ' posts')
  return [...refs].sort()
}

// The moderator certificate must verify for its own association and name
// the signing key, so a moderator never signs a document a verifier would
// reject for its certificate.
function checkModerator (moderatorKeyPair, moderatorCert) {
  if (!moderatorKeyPair || !isKeyBytes(moderatorKeyPair.secretKey, 64) || !isKeyBytes(moderatorKeyPair.publicKey, 32)) {
    throw new TypeError('moderator key pair must have a 32-byte public key and a 64-byte secret key')
  }
  if (cert.validateModeratorCertShape(moderatorCert) !== null) throw new TypeError('invalid moderator certificate')
  if (b4a.toString(moderatorKeyPair.publicKey, 'hex') !== moderatorCert.moderator) throw new TypeError('moderator certificate is for another key')
  if (!cert.verifyModeratorCert(moderatorCert, moderatorCert.association).ok) throw new TypeError('invalid moderator certificate')
}

// Keys are accepted in any case and order; they are stored lowercase, sorted
// and de-duplicated.
function createSnapshot ({ seq, date = new Date().toISOString(), blocked = [], revokedIssuers = [] } = {}, moderatorKeyPair, moderatorCert) {
  if (!Number.isSafeInteger(seq) || seq < 1) throw new TypeError('seq must be a safe integer >= 1')
  if (!cert.isCanonicalIso(date)) throw new TypeError('date must be a canonical ISO-8601 UTC string')
  const blockedKeys = normalizeKeyList(blocked, MAX_BLOCKED, 'blocked')
  const revokedKeys = normalizeKeyList(revokedIssuers, MAX_REVOKED_ISSUERS, 'revokedIssuers')
  checkModerator(moderatorKeyPair, moderatorCert)
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

// `hiddenPosts` items are { author, seq } or '<author>:<seq>' (any key case,
// order, with repeats); they are stored canonical, sorted and distinct.
function createHiddenList ({ seq, date = new Date().toISOString(), hiddenPosts = [] } = {}, moderatorKeyPair, moderatorCert) {
  if (!Number.isSafeInteger(seq) || seq < 1) throw new TypeError('seq must be a safe integer >= 1')
  if (!cert.isCanonicalIso(date)) throw new TypeError('date must be a canonical ISO-8601 UTC string')
  const refs = normalizeHiddenList(hiddenPosts)
  checkModerator(moderatorKeyPair, moderatorCert)
  const list = {
    v: 1,
    seq,
    date,
    hiddenPosts: refs,
    moderator: moderatorCert.moderator,
    moderatorDate: moderatorCert.date,
    moderatorSignature: moderatorCert.signature,
    signature: ''
  }
  list.signature = b4a.toString(crypto.sign(hiddenPayload(list), moderatorKeyPair.secretKey), 'hex')
  if (b4a.byteLength(JSON.stringify(list)) > MAX_HIDDEN_BYTES) throw new Error('hidden-posts list exceeds MAX_HIDDEN_BYTES')
  return list
}

function isKeyBytes (buf, length) {
  return (b4a.isBuffer(buf) || buf instanceof Uint8Array) && buf.byteLength === length
}

// { ok: true } | { ok: false, reason } with the FIRST failing reason in the
// order 'malformed', 'bad-moderator-signature', 'bad-signature'. The
// document carries no association field: its embedded moderator certificate
// is checked against `associationHex`, so a moderator of another association
// fails as 'bad-moderator-signature' ('untrusted-association' is only
// reachable through verifyModeratorCert on a whole certificate). An issuer
// key or the association key itself cannot moderate: their signatures use
// other prefixes. Never throws.
function verifyWith (kind, doc, associationHex) {
  try {
    if (kind.validate(doc) !== null) return { ok: false, reason: 'malformed' }
    if (!cert.isHex(associationHex, 32)) return { ok: false, reason: 'malformed' }
    const s = kind.copy(doc)
    if (kind.validate(s) !== null) return { ok: false, reason: 'malformed' }
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
    if (!verify(kind.payload(s), b4a.from(s.signature, 'hex'), b4a.from(s.moderator, 'hex'))) {
      return { ok: false, reason: 'bad-signature' }
    }
    return { ok: true }
  } catch {
    return { ok: false, reason: 'malformed' }
  }
}

function verifySnapshot (snapshot, associationHex) {
  return verifyWith(SNAPSHOT_KIND, snapshot, associationHex)
}

function verifyHiddenList (list, associationHex) {
  return verifyWith(HIDDEN_KIND, list, associationHex)
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
// 0 when equal, positive when newer. `a`/`b` may be snapshots, hidden-posts
// lists, `have` messages ({ moderatorDate, seq }, moderatorDate '' when
// none) or null (= nothing). This is the order acceptSnapshot uses; it does
// not look at the moderator, so two moderators certified at the same date
// compare by seq here while acceptSnapshot keeps the first one stored. Never
// throws.
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

// Whether `next` replaces `previous` (the document this node holds, trusted
// local state, or null). { ok: true } | { ok: false, reason } where reason is
// a verifyWith reason, 'same' (the very document already held: a no-op, not
// an error) or 'stale'. Accepted when `next` verifies and
//   - previous is null, or
//   - next.moderatorDate is later (a newer association-certified moderator
//     replaces an older one; its seq restarts), or
//   - same moderator and moderatorDate and a higher seq.
// A different moderator with the same moderatorDate is 'stale': the first
// one stored wins. Never throws.
function acceptWith (kind, previous, next0, associationHex) {
  try {
    if (kind.validate(next0) !== null) return { ok: false, reason: 'malformed' }
    // Verify and order the SAME plain copy: reading `next0` twice would let
    // an object with getters pass verification with one seq and the ordering
    // check with another.
    const next = kind.copy(next0)
    const verdict = verifyWith(kind, next, associationHex)
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

function acceptSnapshot (previous, next, associationHex) {
  return acceptWith(SNAPSHOT_KIND, previous, next, associationHex)
}

function acceptHiddenList (previous, next, associationHex) {
  return acceptWith(HIDDEN_KIND, previous, next, associationHex)
}

// The moderation.status answer (docs/rpc.md 5.177) for a snapshot that
// already verified, or for null: no keys, only the list's number and dates.
function snapshotStatus (snapshot) {
  if (snapshot === null || typeof snapshot !== 'object') return { seq: null, date: null, moderatorDate: null }
  return { seq: snapshot.seq, date: snapshot.date, moderatorDate: snapshot.moderatorDate }
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

// author -> Set of hidden seqs of a hidden-posts list (empty Map for null).
function hiddenPostMap (list) {
  const out = new Map()
  try {
    for (const ref of list && Array.isArray(list.hiddenPosts) ? list.hiddenPosts : []) {
      const p = parseHiddenRef(ref)
      if (p === null) continue
      if (!out.has(p.author)) out.set(p.author, new Set())
      out.get(p.author).add(p.seq)
    }
  } catch {}
  return out
}

function hiddenRefSet (list) {
  try {
    return new Set(list && Array.isArray(list.hiddenPosts) ? list.hiddenPosts : [])
  } catch {
    return new Set()
  }
}

// Whether `map` (hiddenPostMap) hides block `seq` of diary `key` (any case).
function isHiddenPost (map, key, seq) {
  try {
    const k = cert.normalizeHex(key)
    const seqs = k === null ? undefined : map.get(k)
    return seqs !== undefined && seqs.has(seq)
  } catch {
    return false
  }
}

// `entries` ([{ seq, record }] of diary `key`) without its hidden posts: a
// fresh array, or the same one when nothing of `key` is hidden. Only a
// `post` record is hidden (a listed seq holding anything else, a profile, a
// key or a tombstone, stays), and a reader treats it as a block it does
// not hold. So the hole a seeder left there, passed by the present walk
// (lib/deletion.js hiddenOf), goes too: a reader that held the post and
// one that never did answer alike. A tombstoned block stays as it is.
function withoutHidden (entries, key, map) {
  try {
    const k = cert.normalizeHex(key)
    const seqs = k === null || !map ? undefined : map.get(k)
    if (seqs === undefined || seqs.size === 0 || !Array.isArray(entries)) return entries
    return entries.filter((e) => !(e && seqs.has(e.seq) && (e.record ? e.record.type === 'post' : e.record === null && e.deleted !== true)))
  } catch {
    return entries
  }
}

// `map` without author `key`: the author's own reads keep their posts.
function exceptAuthor (map, key) {
  try {
    const k = cert.normalizeHex(key)
    if (k === null || !(map instanceof Map) || !map.has(k)) return map
    const out = new Map(map)
    out.delete(k)
    return out
  } catch {
    return map
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

function noChange () {
  return { added: new Set(), removed: new Set(), revokedAdded: new Set(), revokedRemoved: new Set(), hiddenAdded: new Set(), hiddenRemoved: new Set() }
}

// The node's current snapshot and hidden-posts list. `load()` /
// `loadHidden()` (sync or async) return the stored document or null; a
// stored one that no longer verifies for `association` is ignored.
// `save(snapshot)` / `saveHidden(list)` (sync or async) persist one.
//
// offer(snapshot) and offerHidden(list) run in ONE promise queue per state:
// inside the queue each re-runs its accept rule against the then-current
// document, awaits the save and only then swaps, so two offers racing each
// other can never both be adopted on a stale comparison (a write queue alone
// would not repeat the comparison). Both resolve { adopted, reason, added,
// removed, revokedAdded, revokedRemoved, hiddenAdded, hiddenRemoved } (the
// Sets are the blocked keys, revoked issuer keys and hidden 'author:seq'
// refs that changed; empty unless adopted, and an offer only ever changes
// its own document's Sets; reason null when adopted). The two documents are
// ordered and enforced apart: blocked() and revokedIssuers() come from the
// snapshot only, hiddenPosts() (hiddenPostMap) from the hidden-posts list
// only. They share one moderator certificate floor: an offer signed under an
// older moderator certificate than the other held document is 'stale', so a
// key a rotation retired (docs/protocol.md, "Moderator compromise") cannot
// sign the document of the other kind either. A held document is never
// dropped for it.
// A failing save rejects that offer and keeps the previous document; a
// failing load rejects ready() and every offer. With no `saveHidden`,
// offerHidden rejects (a list that could not survive a restart would let an
// older one back in).
function createBlocklistState ({ association, load, save, loadHidden, saveHidden } = {}) {
  if (!cert.isHex(association, 32)) throw new TypeError('association must be 64 hex characters')
  if (typeof save !== 'function') throw new TypeError('save must be a function')
  const associationHex = association.toLowerCase()
  let snapshot = null
  let blocked = new Set()
  let revoked = new Set()
  let hiddenList = null
  let hiddenRefs = new Set()
  let hidden = new Map()

  // Whether `next` (verified) was signed under an older moderator
  // certificate than `other`, the held document of the other kind.
  function belowFloor (next, other) {
    if (other === null) return false
    try {
      return dateValue(next.moderatorDate) < dateValue(other.moderatorDate)
    } catch {
      return true
    }
  }

  function adopt (s) {
    snapshot = s
    blocked = blockedSet(s)
    revoked = revokedIssuerSet(s)
  }

  function adoptHidden (h) {
    hiddenList = h
    hiddenRefs = hiddenRefSet(h)
    hidden = hiddenPostMap(h)
  }

  // Adopt exactly the copy that was verified (never re-read `stored`).
  async function loaded (fn, kind) {
    if (typeof fn !== 'function') return null
    const stored = await fn()
    if (stored === null || stored === undefined) return null
    let copy = null
    try {
      if (kind.validate(stored) === null) copy = kind.copy(stored)
    } catch {}
    return copy !== null && verifyWith(kind, copy, associationHex).ok ? copy : null
  }

  const ready = Promise.resolve().then(async () => {
    const s = await loaded(load, SNAPSHOT_KIND)
    if (s !== null) adopt(s)
    const h = await loaded(loadHidden, HIDDEN_KIND)
    if (h !== null) adoptHidden(h)
  })
  let queue = ready.catch(() => {})

  function enqueue (fn) {
    // A failed load fails every offer (fail closed): adopting on top of an
    // unknown stored document could replace a newer one with an older one.
    const run = queue.then(async () => {
      await ready
      return fn()
    })
    // The queue survives a failing load or save; the caller still sees it.
    queue = run.catch(() => {})
    return run
  }

  function offer (next) {
    return enqueue(async () => {
      let copy = null
      try {
        if (validateSnapshotShape(next) === null) copy = copySnapshot(next)
      } catch {}
      const verdict = copy === null ? { ok: false, reason: 'malformed' } : acceptSnapshot(snapshot, copy, associationHex)
      if (!verdict.ok) return { adopted: false, reason: verdict.reason, ...noChange() }
      if (belowFloor(copy, hiddenList)) return { adopted: false, reason: 'stale', ...noChange() }
      const prevBlocked = blocked
      const prevRevoked = revoked
      await save(copy)
      adopt(copy)
      return {
        ...noChange(),
        adopted: true,
        reason: null,
        added: difference(blocked, prevBlocked),
        removed: difference(prevBlocked, blocked),
        revokedAdded: difference(revoked, prevRevoked),
        revokedRemoved: difference(prevRevoked, revoked)
      }
    })
  }

  function offerHidden (next) {
    return enqueue(async () => {
      if (typeof saveHidden !== 'function') throw new Error('no storage for the hidden-posts list')
      let copy = null
      try {
        if (validateHiddenShape(next) === null) copy = copyHidden(next)
      } catch {}
      const verdict = copy === null ? { ok: false, reason: 'malformed' } : acceptHiddenList(hiddenList, copy, associationHex)
      if (!verdict.ok) return { adopted: false, reason: verdict.reason, ...noChange() }
      if (belowFloor(copy, snapshot)) return { adopted: false, reason: 'stale', ...noChange() }
      const prevHidden = hiddenRefs
      await saveHidden(copy)
      adoptHidden(copy)
      return {
        ...noChange(),
        adopted: true,
        reason: null,
        hiddenAdded: difference(hiddenRefs, prevHidden),
        hiddenRemoved: difference(prevHidden, hiddenRefs)
      }
    })
  }

  return {
    ready: () => ready,
    current: () => snapshot,
    currentHidden: () => hiddenList,
    blocked: () => blocked,
    revokedIssuers: () => revoked,
    hiddenPosts: () => hidden,
    offer,
    offerHidden
  }
}

module.exports = {
  PREFIX,
  SNAPSHOT_KEYS,
  MAX_BLOCKED,
  MAX_REVOKED_ISSUERS,
  MAX_SNAPSHOT_BYTES,
  HIDDEN_PREFIX,
  HIDDEN_KEYS,
  MAX_HIDDEN_POSTS,
  MAX_HIDDEN_BYTES,
  snapshotPayload,
  validateSnapshotShape,
  createSnapshot,
  verifySnapshot,
  compareSnapshots,
  acceptSnapshot,
  hiddenPayload,
  validateHiddenShape,
  createHiddenList,
  verifyHiddenList,
  acceptHiddenList,
  snapshotStatus,
  blockedSet,
  revokedIssuerSet,
  hiddenPostMap,
  hiddenRefSet,
  hiddenRef,
  parseHiddenRef,
  isHiddenPost,
  withoutHidden,
  exceptAuthor,
  isBlocked,
  createBlocklistState
}
