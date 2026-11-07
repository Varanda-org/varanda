'use strict'

// Pages: a diary appended only by the hosted service, whose authority is a
// chain of `page-roster` records (owner-signed, issuer-countersigned). Pure
// helpers, no I/O. Record shapes are in lib/records.js; the signed bytes are
// the prefix and the listed fields joined with LF, no trailing LF.
// Every verify* and pageState never throw, whatever the input (hostile
// getters included); the sign* builders throw a TypeError on bad input.
// The folds read RAW entries (never after applyDeletes): a tombstone of a
// page-* record has no effect on them. A replica that already CLEARED such a
// block loses it; that residual risk needs a leaked page key and is covered
// by the service pausing on an external append and by `mod block`.

const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { verify } = require('./verified')
const {
  isHex,
  normalizeHex,
  validateIssuerCertShape,
  verifyIssuerCert
} = require('./cert')
const {
  PAGE_KEYS,
  MAX_PAGE_ADMINS,
  isPlainObject,
  validRecordCopy
} = require('./records')
const { followSet } = require('./media')

const LF = '\n'
const PAGE_ROSTER_REFRESH_BLOCKS = 256
// admission.js MAX_INVENTORY - 1.
const MAX_PAGE_FOLLOWS = 4095

const ROSTER_PREFIX = 'varanda-page-roster-v1'
const ROSTER_ISSUER_PREFIX = 'varanda-page-roster-issuer-v1'
const ORIGIN_PREFIX = 'varanda-page-origin-v1'
const ORIGIN_ISSUER_PREFIX = 'varanda-page-origin-issuer-v1'
const CLOSE_PREFIX = 'varanda-page-close-v1'
const CLOSE_ISSUER_PREFIX = 'varanda-page-close-issuer-v1'
const MOVED_PREFIX = 'varanda-page-moved-v1'
const MOVED_ISSUER_PREFIX = 'varanda-page-moved-issuer-v1'
const ACCEPT_PREFIX = 'varanda-page-accept-v1'
const OFFER_PREFIX = 'varanda-page-offer-v1'
const LINK_PREFIX = 'varanda-page-link-v1'

const nul = (v) => v === null ? 'null' : String(v)

const OWNER_FIELDS = {
  'page-roster': [ROSTER_PREFIX, (r) => [r.page, r.gen, r.owner, r.admins.join(','), nul(r.prev), r.at, r.nonce, r.association]],
  'page-origin': [ORIGIN_PREFIX, (r) => [r.page, r.from, r.fromSeq, r.gen, r.owner, r.admins.join(','), r.at, r.nonce, r.actor, r.association]],
  'page-close': [CLOSE_PREFIX, (r) => [r.page, r.gen, r.at, r.nonce, r.actor, r.association]],
  'page-moved': [MOVED_PREFIX, (r) => [r.page, r.to, r.gen, r.at, r.nonce, r.actor, r.association]],
  'page-accept': [ACCEPT_PREFIX, (r) => [r.page, r.gen, r.rosterSignature, r.at, r.nonce, r.actor]],
  'page-offer': [OFFER_PREFIX, (r) => [r.page, nul(r.to), nul(r.exp), r.gen, r.at, r.nonce, r.actor]],
  'page-link': [LINK_PREFIX, (r) => [r.page, r.diary, r.actor, r.at, r.nonce, r.association]]
}

const ISSUER_PREFIXES = {
  'page-roster': ROSTER_ISSUER_PREFIX,
  'page-origin': ORIGIN_ISSUER_PREFIX,
  'page-close': CLOSE_ISSUER_PREFIX,
  'page-moved': MOVED_ISSUER_PREFIX
}

// The key whose `signature` a record carries (page-link: the issuer).
function signerOf (r) {
  if (r.type === 'page-roster') return r.owner
  if (r.type === 'page-link') return r.issuer
  return r.actor
}

function has (obj, k) {
  return Object.prototype.hasOwnProperty.call(obj, k)
}

function joinPayload (prefix, fields) {
  return b4a.from([prefix, ...fields.map(String)].join(LF), 'utf8')
}

function ownerPayload (record) {
  if (!isPlainObject(record) || !has(OWNER_FIELDS, record.type)) throw new TypeError('unsupported page record type')
  const [prefix, fields] = OWNER_FIELDS[record.type]
  return joinPayload(prefix, fields(record))
}

function issuerPayload (record) {
  if (!isPlainObject(record) || !has(ISSUER_PREFIXES, record.type)) throw new TypeError('unsupported page record type')
  return joinPayload(ISSUER_PREFIXES[record.type], [...OWNER_FIELDS[record.type][1](record), record.signature])
}

function isKeyBytes (buf, length) {
  return (b4a.isBuffer(buf) || buf instanceof Uint8Array) && buf.byteLength === length
}

function checkKeyPair (keyPair, who) {
  if (!keyPair || !isKeyBytes(keyPair.secretKey, 64) || !isKeyBytes(keyPair.publicKey, 32)) {
    throw new TypeError(who + ' key pair must have a 32-byte public key and a 64-byte secret key')
  }
}

// A record of `type` built from `fields` in key order, any signature or
// delegation field it lacks filled with a placeholder of the right shape, so
// the shape rules of lib/records.js check every field the signer covers.
const PLACEHOLDER_SIG = '0'.repeat(128)
function shapedCandidate (type, fields) {
  if (!isPlainObject(fields)) throw new TypeError('invalid ' + type)
  const out = {}
  for (const k of PAGE_KEYS[type]) out[k] = has(fields, k) ? fields[k] : undefined
  out.type = type
  for (const k of ['signature', 'countersignature', 'issuerSignature']) {
    if (has(out, k) && out[k] === undefined) out[k] = PLACEHOLDER_SIG
  }
  if (has(out, 'issuerDate') && out.issuerDate === undefined) out.issuerDate = out.at
  if (has(out, 'issuer') && out.issuer === undefined) out.issuer = out.association === 'f'.repeat(64) ? 'e'.repeat(64) : 'f'.repeat(64)
  if (validRecordCopy(out, 1) === null) throw new TypeError('invalid ' + type)
  return out
}

function signAs (type, fields, keyPair) {
  const record = shapedCandidate(type, fields)
  checkKeyPair(keyPair, 'signer')
  if (b4a.toString(keyPair.publicKey, 'hex') !== signerOf(record)) throw new TypeError('key pair is not the signer of this ' + type)
  return b4a.toString(crypto.sign(ownerPayload(record), keyPair.secretKey), 'hex')
}

function signRoster (fields, keyPair) { return signAs('page-roster', fields, keyPair) }
function signAccept (fields, keyPair) { return signAs('page-accept', fields, keyPair) }
function signOffer (fields, keyPair) { return signAs('page-offer', fields, keyPair) }
function signOrigin (fields, keyPair) { return signAs('page-origin', fields, keyPair) }
function signClose (fields, keyPair) { return signAs('page-close', fields, keyPair) }
function signMoved (fields, keyPair) { return signAs('page-moved', fields, keyPair) }

// Same refusals as cert.js checkIssuer (not exported there): the issuer never
// signs anything a verifier would reject.
function checkIssuer (keyPair, issuerCert) {
  checkKeyPair(keyPair, 'issuer')
  if (validateIssuerCertShape(issuerCert) !== null) throw new TypeError('invalid issuer certificate')
  if (b4a.toString(keyPair.publicKey, 'hex') !== issuerCert.issuer) throw new TypeError('issuer certificate is for another key')
  if (!verifyIssuerCert(issuerCert, issuerCert.association).ok) throw new TypeError('invalid issuer certificate')
}

// The issuer countersigns an owner-signed roster, origin, close or moved
// record: the delegation trio comes from the issuer certificate (as
// createUsernameRecord), `countersignature` is over the issuer payload. The
// owner signature must already verify.
function issuerCountersign (record, issuerKeyPair, issuerCert) {
  if (!isPlainObject(record) || !has(ISSUER_PREFIXES, record.type)) throw new TypeError('unsupported page record type')
  checkIssuer(issuerKeyPair, issuerCert)
  if (has(record, 'association') && record.association !== issuerCert.association) throw new TypeError('record names another association')
  const out = {}
  for (const k of PAGE_KEYS[record.type]) out[k] = record[k]
  out.association = issuerCert.association
  out.issuer = issuerCert.issuer
  out.issuerDate = issuerCert.date
  out.issuerSignature = issuerCert.signature
  out.countersignature = PLACEHOLDER_SIG
  if (validRecordCopy(out, 1) === null) throw new TypeError('invalid ' + record.type)
  if (!crypto.verify(ownerPayload(out), b4a.from(out.signature, 'hex'), b4a.from(signerOf(out), 'hex'))) {
    throw new TypeError('bad owner signature')
  }
  out.countersignature = b4a.toString(crypto.sign(issuerPayload(out), issuerKeyPair.secretKey), 'hex')
  return out
}

function revokedSet (opts) {
  if (opts === null || typeof opts !== 'object') return null
  const set = opts.revokedIssuers
  return set !== null && typeof set === 'object' && typeof set.has === 'function' ? set : null
}

function sigOk (payload, sigHex, keyHex) {
  return verify(payload, b4a.from(sigHex, 'hex'), b4a.from(keyHex, 'hex'))
}

const fail = (reason) => ({ ok: false, reason })

// A plain-data copy of a shape-valid page record of one of `types`, or null.
function shaped (record, types) {
  const copy = validRecordCopy(record, 1)
  return copy !== null && types.includes(copy.type) ? copy : null
}

// Association, then the issuer delegation, then (by `check`) the record
// signatures, then revocation last (as cert.js verifyIssued).
function verifyDelegated (r, associationHex, opts, check) {
  if (!isHex(associationHex, 32)) return fail('malformed')
  if (r.association !== normalizeHex(associationHex)) return fail('untrusted-association')
  const delegation = { v: 1, issuer: r.issuer, date: r.issuerDate, association: r.association, signature: r.issuerSignature }
  if (!verifyIssuerCert(delegation, r.association).ok) return fail('bad-issuer-signature')
  const reason = check()
  if (reason) return fail(reason)
  const revoked = revokedSet(opts)
  if (revoked !== null) {
    let isRevoked = false
    try {
      isRevoked = revoked.has(r.issuer) === true
    } catch {
      return fail('malformed')
    }
    if (isRevoked) return fail('revoked-issuer')
  }
  return { ok: true }
}

// Steps 1-7 of the countersigned-record check for page-roster, page-origin,
// page-close and page-moved; `pageKey` is the log being read.
function verifyCountersigned (record, pageKey, associationHex, opts) {
  return verifyCountersignedOf(Object.keys(ISSUER_PREFIXES), record, pageKey, associationHex, opts)
}

function verifyCountersignedOf (types, record, pageKey, associationHex, opts) {
  try {
    const r = shaped(record, types)
    if (r === null || !isHex(pageKey, 32)) return fail('malformed')
    if (r.page !== normalizeHex(pageKey)) return fail('page-mismatch')
    return verifyDelegated(r, associationHex, opts, () => {
      if (!sigOk(issuerPayload(r), r.countersignature, r.issuer)) return 'bad-issuer-signature'
      if (!sigOk(ownerPayload(r), r.signature, signerOf(r))) return 'bad-signature'
      return null
    })
  } catch {
    return fail('malformed')
  }
}

// A page-link: signed by the issuer alone.
function verifyIssuerOnly (record, associationHex, opts) {
  try {
    const r = shaped(record, ['page-link'])
    if (r === null) return fail('malformed')
    return verifyDelegated(r, associationHex, opts, () => {
      return sigOk(ownerPayload(r), r.signature, r.issuer) ? null : 'bad-signature'
    })
  } catch {
    return fail('malformed')
  }
}

function verifyRoster (record, pageKey, associationHex, opts) {
  return verifyCountersignedOf(['page-roster'], record, pageKey, associationHex, opts)
}

function verifyOrigin (record, pageKey, associationHex, opts) {
  return verifyCountersignedOf(['page-origin'], record, pageKey, associationHex, opts)
}

// Actor-only records carry no issuer: `associationHex` and `opts` are taken
// for a uniform call shape.
function verifyActorOnly (type, record, pageKey) {
  try {
    const r = shaped(record, [type])
    if (r === null || !isHex(pageKey, 32)) return fail('malformed')
    if (r.page !== normalizeHex(pageKey)) return fail('page-mismatch')
    return sigOk(ownerPayload(r), r.signature, r.actor) ? { ok: true } : fail('bad-signature')
  } catch {
    return fail('malformed')
  }
}

function verifyAccept (record, pageKey, associationHex, opts) {
  return verifyActorOnly('page-accept', record, pageKey)
}

function verifyOffer (record, pageKey, associationHex, opts) {
  return verifyActorOnly('page-offer', record, pageKey)
}

const FOLDED = ['page-roster', 'page-accept', 'page-offer', 'page-origin']

// Each entry read once; shape-valid page records naming `pageHex` by seq
// (the first entry wins a duplicated seq).
function pageEntries (entries, pageHex) {
  const bySeq = new Map()
  if (!Array.isArray(entries)) return bySeq
  const n = entries.length
  for (let i = 0; i < n; i++) {
    try {
      const entry = entries[i]
      if (entry === null || typeof entry !== 'object') continue
      const seq = entry.seq
      if (!Number.isSafeInteger(seq) || seq < 1 || bySeq.has(seq)) continue
      const copy = validRecordCopy(entry.record, seq)
      if (copy === null || !FOLDED.includes(copy.type) || copy.page !== pageHex) continue
      bySeq.set(seq, copy)
    } catch {}
  }
  return bySeq
}

function sameList (a, b) {
  return a.length === b.length && a.every((x, i) => x === b[i])
}

function isSubset (a, b) {
  return a.every((x) => b.includes(x))
}

// The newest offer by `owner` in seqs (after, before), or null.
function newestOffer (bySeq, owner, after, before, pageHex) {
  let best = null
  for (const [seq, r] of bySeq) {
    if (r.type !== 'page-offer' || r.actor !== owner || seq <= after || seq >= before) continue
    if (best !== null && seq < best.seq) continue
    if (!verifyOffer(r, pageHex).ok) continue
    best = { seq, record: r }
  }
  return best
}

// `since` is the first seq of the previous roster (its first copy), so an
// offer made before a refresh copy still counts whichever copy `prev` names.
function chainsFrom (prev, next, since, bySeq, pageHex) {
  const r = next.record
  const p = prev.record
  if (r.owner === p.owner) {
    if (isSubset(r.admins, p.admins)) return true
    if (r.admins.length !== p.admins.length + 1 || !isSubset(p.admins, r.admins)) return false
    const added = r.admins.find((a) => !p.admins.includes(a))
    const accept = bySeq.get(next.seq - 1)
    return accept !== undefined && accept.type === 'page-accept' && accept.actor === added &&
      accept.gen === r.gen && accept.rosterSignature === r.signature && verifyAccept(accept, pageHex).ok
  }
  const expected = [...p.admins.filter((a) => a !== r.owner), p.owner].sort()
  if (!sameList(r.admins, expected)) return false
  const offer = newestOffer(bySeq, p.owner, since, next.seq, pageHex)
  if (offer === null) return false
  const o = offer.record
  // A consistency check only: `at` is the signer's choice; the service
  // enforces expiry against its own clock before countersigning.
  return o.to === r.owner && o.gen === r.gen - 1 && Date.parse(o.exp) >= Date.parse(r.at)
}

function genesisOk (genesis, bySeq, pageHex, associationHex, opts) {
  const r = genesis.record
  if (r.admins.length === 0) return true
  const origin = bySeq.get(3)
  return genesis.seq < 3 && origin !== undefined && origin.type === 'page-origin' &&
    origin.owner === r.owner && sameList(origin.admins, r.admins) &&
    verifyOrigin(origin, pageHex, associationHex, opts).ok
}

// Walks the roster chain from gen 1. A refresh (the same roster appended
// again, same gen and signature) extends the current link: `prev` of the
// next roster may name any of its copies, and the newest copy is reported.
function walkChain (rosters, bySeq, pageHex, associationHex, opts) {
  const genesis = rosters.find((x) => x.record.gen === 1 && x.record.prev === null && genesisOk(x, bySeq, pageHex, associationHex, opts))
  if (genesis === undefined) return null
  let cur = genesis
  let copies = [genesis.seq]
  for (;;) {
    for (const x of rosters) {
      if (x.seq > copies[copies.length - 1] && x.record.gen === cur.record.gen && x.record.signature === cur.record.signature) copies.push(x.seq)
    }
    const next = rosters.find((x) => x.seq > cur.seq && x.record.gen === cur.record.gen + 1 &&
      copies.includes(x.record.prev) && x.seq > x.record.prev && chainsFrom(cur, x, copies[0], bySeq, pageHex))
    if (next === undefined) break
    cur = next
    copies = [next.seq]
  }
  return { record: cur.record, seq: copies[copies.length - 1] }
}

function emptyState (pageHex, follows) {
  return { page: false, owner: null, admins: [], gen: 0, seq: null, follows, key: pageHex }
}

// The page's current roster. Bounded: the highest gen (ties: the highest
// seq) that verifies. Full: only rosters that chain from gen 1. Blocks after
// a close or a move are the caller's to slice off first.
function pageState (entries, pageKey, associationHex, options) {
  let pageHex = null
  let follows = []
  try {
    if (isHex(pageKey, 32)) pageHex = normalizeHex(pageKey)
    follows = followSet(entries, pageHex === null ? pageKey : pageHex)
  } catch {}
  try {
    if (pageHex === null) return emptyState(null, follows)
    if (options !== undefined && (options === null || typeof options !== 'object')) return emptyState(pageHex, follows)
    const { revokedIssuers, full = false } = options === undefined ? {} : options
    const opts = { revokedIssuers }
    const bySeq = pageEntries(entries, pageHex)
    const verifies = (x) => verifyRoster(x.record, pageHex, associationHex, opts).ok
    const rosters = []
    for (const [seq, record] of bySeq) {
      if (record.type === 'page-roster') rosters.push({ seq, record })
    }
    let best = null
    if (full === true) {
      best = walkChain(rosters.filter(verifies).sort((a, b) => a.seq - b.seq), bySeq, pageHex, associationHex, opts)
    } else {
      rosters.sort((a, b) => (b.record.gen - a.record.gen) || (b.seq - a.seq))
      best = rosters.find(verifies) || null
    }
    if (best === null) return emptyState(pageHex, follows)
    const r = best.record
    return { page: true, owner: r.owner, admins: [...r.admins], gen: r.gen, seq: best.seq, follows, key: pageHex }
  } catch {
    return emptyState(pageHex, follows)
  }
}

// The open transfer offer of the current owner at the current gen: the
// newest such offer, null when none, when it is a cancel or when it expired
// before `now` (ms since epoch, optional).
function pendingOffer (entries, state, now) {
  try {
    if (!isPlainObject(state) || state.page !== true) return null
    const key = state.key
    if (!isHex(key, 32)) return null
    const pageHex = normalizeHex(key)
    const bySeq = pageEntries(entries, pageHex)
    let best = null
    for (const [seq, r] of bySeq) {
      if (r.type !== 'page-offer' || r.actor !== state.owner || r.gen !== state.gen) continue
      if (best !== null && seq < best.seq) continue
      if (!verifyOffer(r, pageHex).ok) continue
      best = { seq, record: r }
    }
    if (best === null || best.record.to === null) return null
    const o = best.record
    if (now !== undefined && !(Date.parse(o.exp) >= now)) return null
    return { to: o.to, exp: o.exp, gen: o.gen, at: o.at, seq: best.seq }
  } catch {
    return null
  }
}

module.exports = {
  MAX_PAGE_ADMINS,
  PAGE_ROSTER_REFRESH_BLOCKS,
  MAX_PAGE_FOLLOWS,
  ROSTER_PREFIX,
  ROSTER_ISSUER_PREFIX,
  ORIGIN_PREFIX,
  ORIGIN_ISSUER_PREFIX,
  CLOSE_PREFIX,
  CLOSE_ISSUER_PREFIX,
  MOVED_PREFIX,
  MOVED_ISSUER_PREFIX,
  ACCEPT_PREFIX,
  OFFER_PREFIX,
  LINK_PREFIX,
  ownerPayload,
  issuerPayload,
  signRoster,
  signAccept,
  signOffer,
  signOrigin,
  signClose,
  signMoved,
  issuerCountersign,
  verifyCountersigned,
  verifyIssuerOnly,
  verifyRoster,
  verifyAccept,
  verifyOffer,
  verifyOrigin,
  pageState,
  pendingOffer
}
