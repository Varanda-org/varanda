'use strict'

// How much text still fits in a direct message inner (docs/protocol.md
// section 11) next to its certificate and media. The node checks the real
// size when it signs; this is the same measurement for a UI that cannot load
// @varanda/core. Zero dependencies, no Node built-ins: JSON.stringify gives
// the exact escaping core's canonicalJson writes.

const { utf8ByteLength } = require('./text')

const DM_INNER_BYTES = 5120
// Two length bytes and the 64-byte signature.
const DM_INNER_FRAMING_BYTES = 66
// A v3 frame also carries its uint64be expiry after the signature.
const DM_INNER_V3_EXPIRY_BYTES = 8
// Insertion order is the wire order; packages/core/lib/dm.js signs the same.
const DM_INNER_KEYS = Object.freeze(['v', 'kind', 'id', 'from', 'to', 'replyTo', 'text', 'op', 'peer', 'at', 'cert'])
const DM_INNER_KEYS_V2 = Object.freeze(['v', 'kind', 'id', 'from', 'to', 'replyTo', 'text', 'media', 'card', 'fwd', 'op', 'peer', 'at', 'cert'])
// v3 (a Página's digest-signed inner) writes the v2 keys; only its signature differs.
const DM_INNER_KEYS_V3 = DM_INNER_KEYS_V2
// v4 is a reaction (kind 'react'), signed under its own domain.
const DM_INNER_KEYS_V4 = Object.freeze(['v', 'kind', 'id', 'from', 'to', 'target', 'emoji', 'rev', 'at', 'cert'])
// v5 is a reaction to a momento of `to`: a msg with the v1 keys plus the
// moment's seq, signed under its own domain.
const DM_INNER_KEYS_V5 = Object.freeze(['v', 'kind', 'id', 'from', 'to', 'replyTo', 'text', 'moment', 'op', 'peer', 'at', 'cert'])
// v6 is a visit ping (kind 'visit'): who looked at whose profile, at day
// precision (`day` is a canonical date, YYYY-MM-DD). `to` and `cert` stay
// because a recipient opens an inner only if it is addressed to it and the
// sender's certificate holds; without `to` a ping could be re-sealed to
// someone else. Signed under its own domain.
const DM_INNER_KEYS_V6 = Object.freeze(['v', 'kind', 'id', 'from', 'to', 'day', 'cert'])
// v7 is a history copy pointer (kind 'copy', docs/protocol.md section 11): the
// copy's id, the blob descriptor of its manifest and the time, sealed to the
// own box and signed by the own key under its own domain. `from` and `to` are
// both the own key and there is no certificate, as a ctl has none.
const DM_INNER_KEYS_V7 = Object.freeze(['v', 'kind', 'id', 'from', 'to', 'copy', 'at'])
// v8 is a history copy claim (kind 'claim', docs/protocol.md section 11): the
// own device `by` announces that it will make copy `copy` for the own devices
// `for`, so another own device seeing an earlier claim leaves the copy to it.
// Sealed to the own box and signed by the own key under its own domain, with
// no certificate, as the v7 pointer.
const DM_INNER_KEYS_V8 = Object.freeze(['v', 'kind', 'id', 'from', 'to', 'copy', 'for', 'by', 'at'])
// v9 is a msg or ctl from a manifest diary (a Hypercore 11 core node): `from`
// is the diary key, which is the hash of its signer's manifest and so cannot
// verify a signature, and `signer` is the key that signs. The v2 keys plus
// `signer`, signed under its own domain.
const DM_INNER_KEYS_V9 = Object.freeze(['v', 'kind', 'id', 'from', 'signer', 'to', 'replyTo', 'text', 'media', 'card', 'fwd', 'op', 'peer', 'at', 'cert'])
// v10 is a reaction from a manifest diary: the v4 keys plus `signer`.
const DM_INNER_KEYS_V10 = Object.freeze(['v', 'kind', 'id', 'from', 'signer', 'to', 'target', 'emoji', 'rev', 'at', 'cert'])
// The six keys of a blob descriptor (core lib/blob.js), in wire order.
const DM_BLOB_KEYS = Object.freeze(['id', 'key', 'nonce', 'chunks', 'bytes', 'sha256'])
// A reaction's target, and a bound reply's replyTo (v2 and v3): the
// message's sender and id, and the hex64 sha256 of the canonical JSON of
// that message's opened inner body, so it names only the message it was
// made for.
const DM_TARGET_KEYS = Object.freeze(['from', 'id', 'digest'])
const DM_MEDIA_KEYS = Object.freeze(['id', 'key', 'nonce', 'chunks', 'bytes', 'sha256', 'mime', 'w', 'h', 'ms'])
// A link card (core lib/link-card.js CARD_KEYS); its image is a media item.
const DM_CARD_KEYS = Object.freeze(['url', 'host', 'title', 'desc', 'image'])

// Fixed-length stand-ins for values a UI does not know before sending: an
// id is 32 hex, a key 64 hex, a canonical time 24 characters.
const ID_STANDIN = '0'.repeat(32)
const KEY_STANDIN = '0'.repeat(64)
const AT_STANDIN = '0000-00-00T00:00:00.000Z'
// The largest membership certificate a msg carries (core lib/cert.js: the
// issued v2 shape; a v1 certificate is smaller even with 32-character
// ageBand and method). A UI that does not hold its own certificate measures
// with this, so a caption that fits here fits with the real one, and no
// photo is uploaded for a message the node would then refuse as too long.
const MEMBER_CERT_STANDIN = Object.freeze({
  v: 2,
  member: KEY_STANDIN,
  ageBand: 'unchecked',
  method: 'google',
  date: AT_STANDIN,
  association: KEY_STANDIN,
  issuer: KEY_STANDIN,
  issuerDate: AT_STANDIN,
  issuerSignature: '0'.repeat(128),
  signature: '0'.repeat(128)
})

function orNull (x) {
  return x === undefined ? null : x
}

function canonicalMediaItem (d) {
  const o = {}
  for (const k of DM_MEDIA_KEYS) o[k] = d[k]
  return o
}

function isObject (x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
}

function canonicalCard (c) {
  if (!isObject(c)) return c
  const o = {}
  for (const k of DM_CARD_KEYS) o[k] = c[k]
  if (isObject(o.image)) o.image = canonicalMediaItem(o.image)
  return o
}

// The v2 key set only when something needs it: a text-only message stays v1
// so readers without v2 still open it. A bound reply (replyTo an object)
// needs v2: v1 keeps the bare id. Never 3: only a Página asks for v3.
function innerVersion (b) {
  return b.media !== null || b.card !== null || b.fwd !== 0 || isObject(b.replyTo) ? 2 : 1
}

// body has every key of its version; media items (and a card's image) are
// written in DM_MEDIA_KEYS order and a card in DM_CARD_KEYS order whatever
// order the caller built them in.
function canonicalTarget (t) {
  if (!isObject(t)) return t
  const o = {}
  for (const k of DM_TARGET_KEYS) o[k] = t[k]
  return o
}

function canonicalBlobDescriptor (d) {
  if (!isObject(d)) return d
  const o = {}
  for (const k of DM_BLOB_KEYS) o[k] = d[k]
  return o
}

// v1 and anything unknown use the v1 list; v3 signs the v2 keys.
const INNER_KEYS_BY_V = new Map([
  [2, DM_INNER_KEYS_V2],
  [3, DM_INNER_KEYS_V2],
  [4, DM_INNER_KEYS_V4],
  [5, DM_INNER_KEYS_V5],
  [6, DM_INNER_KEYS_V6],
  [7, DM_INNER_KEYS_V7],
  [8, DM_INNER_KEYS_V8],
  [9, DM_INNER_KEYS_V9],
  [10, DM_INNER_KEYS_V10]
])

function canonicalInnerJson (body) {
  const keys = INNER_KEYS_BY_V.get(body.v) || DM_INNER_KEYS
  const o = {}
  for (const k of keys) {
    o[k] = k === 'media' && Array.isArray(body.media)
      ? body.media.map(canonicalMediaItem)
      : k === 'card'
        ? canonicalCard(body.card)
        : k === 'copy' && body.v === 7 ? canonicalBlobDescriptor(body.copy) : k === 'target' || k === 'replyTo' ? canonicalTarget(body[k]) : body[k]
  }
  return JSON.stringify(o)
}

// Bytes a text takes inside the JSON string (escapes included, quotes not).
function dmTextBytes (text) {
  if (typeof text !== 'string') return 0
  return utf8ByteLength(JSON.stringify(text)) - 2
}

// fields: { v?, kind?, id?, from?, to?, replyTo?, media?, card?, fwd?, op?,
// peer?, at?, cert?, signer? }; text is ignored. replyTo is measured as
// given: a bare id, or a bound { from, id, digest }. v 3 measures a Página's
// inner, which always carries the v2 keys; v 9 (or a signer) the inner of a
// manifest diary, the v2 keys plus `signer`. Returns the dmTextBytes still free
// under DM_INNER_BYTES; below zero nothing fits, not even empty text.
function dmTextBudget (fields = {}) {
  const f = fields !== null && typeof fields === 'object' ? fields : {}
  const body = {
    kind: f.kind === undefined ? 'msg' : f.kind,
    id: f.id === undefined ? ID_STANDIN : f.id,
    from: f.from === undefined ? KEY_STANDIN : f.from,
    to: f.to === undefined ? KEY_STANDIN : f.to,
    replyTo: orNull(f.replyTo),
    text: '',
    media: orNull(f.media),
    card: orNull(f.card),
    fwd: f.fwd === undefined ? 0 : f.fwd,
    op: orNull(f.op),
    peer: orNull(f.peer),
    at: f.at === undefined ? AT_STANDIN : f.at,
    cert: orNull(f.cert)
  }
  if (f.v === 9 || f.signer !== undefined) {
    body.v = 9
    body.signer = f.signer === undefined ? KEY_STANDIN : f.signer
  } else {
    body.v = f.v === 3 ? 3 : innerVersion(body)
  }
  const framing = DM_INNER_FRAMING_BYTES + (body.v === 3 ? DM_INNER_V3_EXPIRY_BYTES : 0)
  return DM_INNER_BYTES - framing - utf8ByteLength(canonicalInnerJson(body))
}

module.exports = {
  MEMBER_CERT_STANDIN,
  DM_INNER_BYTES,
  DM_INNER_FRAMING_BYTES,
  DM_INNER_V3_EXPIRY_BYTES,
  DM_INNER_KEYS,
  DM_INNER_KEYS_V2,
  DM_INNER_KEYS_V3,
  DM_INNER_KEYS_V4,
  DM_INNER_KEYS_V5,
  DM_INNER_KEYS_V6,
  DM_INNER_KEYS_V7,
  DM_INNER_KEYS_V8,
  DM_INNER_KEYS_V9,
  DM_INNER_KEYS_V10,
  DM_BLOB_KEYS,
  DM_TARGET_KEYS,
  DM_MEDIA_KEYS,
  DM_CARD_KEYS,
  innerVersion,
  canonicalInnerJson,
  dmTextBytes,
  dmTextBudget
}
