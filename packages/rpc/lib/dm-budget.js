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
const DM_MEDIA_KEYS = Object.freeze(['id', 'key', 'nonce', 'chunks', 'bytes', 'sha256', 'mime', 'w', 'h', 'ms'])

// Fixed-length stand-ins for values a UI does not know before sending: an
// id is 32 hex, a key 64 hex, a canonical time 24 characters.
const ID_STANDIN = '0'.repeat(32)
const KEY_STANDIN = '0'.repeat(64)
const AT_STANDIN = '0000-00-00T00:00:00.000Z'

function orNull (x) {
  return x === undefined ? null : x
}

function canonicalMediaItem (d) {
  const o = {}
  for (const k of DM_MEDIA_KEYS) o[k] = d[k]
  return o
}

// The v2 key set only when something needs it: a text-only message stays v1
// so readers without v2 still open it.
function innerVersion (b) {
  return b.media !== null || b.card !== null || b.fwd !== 0 ? 2 : 1
}

// body has every key of its version; media items are written in
// DM_MEDIA_KEYS order whatever order the caller built them in.
function canonicalInnerJson (body) {
  const keys = body.v === 2 ? DM_INNER_KEYS_V2 : DM_INNER_KEYS
  const o = {}
  for (const k of keys) {
    o[k] = k === 'media' && Array.isArray(body.media) ? body.media.map(canonicalMediaItem) : body[k]
  }
  return JSON.stringify(o)
}

// Bytes a text takes inside the JSON string (escapes included, quotes not).
function dmTextBytes (text) {
  if (typeof text !== 'string') return 0
  return utf8ByteLength(JSON.stringify(text)) - 2
}

// fields: { kind?, id?, from?, to?, replyTo?, media?, card?, fwd?, op?,
// peer?, at?, cert? }; text is ignored. Returns the dmTextBytes still free
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
  body.v = innerVersion(body)
  return DM_INNER_BYTES - DM_INNER_FRAMING_BYTES - utf8ByteLength(canonicalInnerJson(body))
}

module.exports = {
  DM_INNER_BYTES,
  DM_INNER_FRAMING_BYTES,
  DM_INNER_KEYS,
  DM_INNER_KEYS_V2,
  DM_MEDIA_KEYS,
  innerVersion,
  canonicalInnerJson,
  dmTextBytes,
  dmTextBudget
}
