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
// Insertion order is the wire order; packages/core/lib/dm.js signs the same.
const DM_INNER_KEYS = Object.freeze(['v', 'kind', 'id', 'from', 'to', 'replyTo', 'text', 'op', 'peer', 'at', 'cert'])
const DM_INNER_KEYS_V2 = Object.freeze(['v', 'kind', 'id', 'from', 'to', 'replyTo', 'text', 'media', 'card', 'fwd', 'op', 'peer', 'at', 'cert'])
// v3 (a Página's digest-signed inner) writes the v2 keys; only its signature differs.
const DM_INNER_KEYS_V3 = DM_INNER_KEYS_V2
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
// so readers without v2 still open it. Never 3: only a Página asks for v3.
function innerVersion (b) {
  return b.media !== null || b.card !== null || b.fwd !== 0 ? 2 : 1
}

// body has every key of its version; media items (and a card's image) are
// written in DM_MEDIA_KEYS order and a card in DM_CARD_KEYS order whatever
// order the caller built them in.
function canonicalInnerJson (body) {
  const keys = body.v === 2 || body.v === 3 ? DM_INNER_KEYS_V2 : DM_INNER_KEYS
  const o = {}
  for (const k of keys) {
    o[k] = k === 'media' && Array.isArray(body.media)
      ? body.media.map(canonicalMediaItem)
      : k === 'card' ? canonicalCard(body.card) : body[k]
  }
  return JSON.stringify(o)
}

// Bytes a text takes inside the JSON string (escapes included, quotes not).
function dmTextBytes (text) {
  if (typeof text !== 'string') return 0
  return utf8ByteLength(JSON.stringify(text)) - 2
}

// fields: { v?, kind?, id?, from?, to?, replyTo?, media?, card?, fwd?, op?,
// peer?, at?, cert? }; text is ignored. v 3 measures a Página's inner,
// which always carries the v2 keys. Returns the dmTextBytes still free
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
  body.v = f.v === 3 ? 3 : innerVersion(body)
  return DM_INNER_BYTES - DM_INNER_FRAMING_BYTES - utf8ByteLength(canonicalInnerJson(body))
}

module.exports = {
  MEMBER_CERT_STANDIN,
  DM_INNER_BYTES,
  DM_INNER_FRAMING_BYTES,
  DM_INNER_KEYS,
  DM_INNER_KEYS_V2,
  DM_INNER_KEYS_V3,
  DM_MEDIA_KEYS,
  DM_CARD_KEYS,
  innerVersion,
  canonicalInnerJson,
  dmTextBytes,
  dmTextBudget
}
