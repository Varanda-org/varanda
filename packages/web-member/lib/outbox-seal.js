'use strict'

// The sealed part of an app outbox item (apps/app/src/outbox.js, docs/rpc.md
// 5.124 and 5.125): its target and text, under the outbox key
// (./passkey.js outboxKeyFromPrf). The plaintext also repeats id, author,
// association, kind and writtenAt, which the item keeps readable; opening
// compares them with the caller's, so an item whose readable fields were
// changed, or a box copied onto another item, does not open.
//
// box = base64url(nonce || crypto_secretbox_easy(plaintext)), no padding,
// plaintext = UTF-8 of JSON.stringify([1, id, author, association, kind,
// to, text, writtenAt]), a fresh random 24-byte nonce per seal.

const b4a = require('b4a')
const { MAX_TEXT } = require('@varanda/rpc')
const { UsageError } = require('@varanda/core/lib/errors')
const sodium = require('./sodium-browser')
const { toBase64Url, fromBase64Url } = require('./passkey')

const VERSION = 1
const KEY_BYTES = 32
const NONCE_BYTES = sodium.crypto_secretbox_NONCEBYTES
const MAC_BYTES = sodium.crypto_secretbox_MACBYTES
// The largest plaintext: 254 bytes of fixed fields (a reply whose seq has
// 16 digits), at most 6 bytes per text char (a lone surrogate is written as
// \udXXX) and a writtenAt of at most 32 chars, 6 bytes each, under 512.
const PLAIN_MAX = 6 * MAX_TEXT + 512
// The same bound as docs/rpc.md 5.124 (packages/rpc/lib/methods.js).
const BOX_MAX = Math.ceil((NONCE_BYTES + MAC_BYTES + PLAIN_MAX) * 4 / 3)

const BAD_BOX = 'item da fila de saída inválido'
const WRONG_AUTHOR = 'item da fila de saída de outra identidade'

function checkKey (key) {
  if (!(key instanceof Uint8Array) || key.byteLength !== KEY_BYTES) throw new TypeError('chave inválida')
}

function checkFields ({ id, author, association, kind, writtenAt }) {
  for (const v of [id, author, association, kind, writtenAt]) {
    if (typeof v !== 'string') throw new TypeError('item inválido')
  }
}

// key: the outbox key (32 bytes, not kept). -> the box string.
function sealOutbox (key, { id, author, association, kind, to, text, writtenAt }) {
  checkKey(key)
  checkFields({ id, author, association, kind, writtenAt })
  if ((to !== null && typeof to !== 'string') || typeof text !== 'string') throw new TypeError('item inválido')
  const plain = b4a.from(JSON.stringify([VERSION, id, author, association, kind, to, text, writtenAt]), 'utf8')
  try {
    if (plain.byteLength > PLAIN_MAX) throw new TypeError('item inválido')
    const out = new Uint8Array(NONCE_BYTES + plain.byteLength + MAC_BYTES)
    const nonce = out.subarray(0, NONCE_BYTES)
    sodium.randombytes_buf(nonce)
    sodium.crypto_secretbox_easy(out.subarray(NONCE_BYTES), plain, nonce, key)
    return toBase64Url(out)
  } finally {
    plain.fill(0)
  }
}

// -> { to, text }; anything that does not decode canonically, does not open
// under `key`, has another version or names other readable fields throws
// UsageError(BAD_BOX).
function openOutbox (key, box, { id, author, association, kind, writtenAt }) {
  checkKey(key)
  checkFields({ id, author, association, kind, writtenAt })
  if (typeof box !== 'string' || box.length > BOX_MAX) throw new UsageError(BAD_BOX)
  let bytes
  try {
    bytes = fromBase64Url(box)
  } catch {
    throw new UsageError(BAD_BOX)
  }
  // One box, one string: trailing bits that decode to the same bytes are
  // refused.
  if (bytes.byteLength <= NONCE_BYTES + MAC_BYTES || toBase64Url(bytes) !== box) throw new UsageError(BAD_BOX)
  const plain = b4a.alloc(bytes.byteLength - NONCE_BYTES - MAC_BYTES)
  let value = null
  try {
    if (sodium.crypto_secretbox_open_easy(plain, bytes.subarray(NONCE_BYTES), bytes.subarray(0, NONCE_BYTES), key)) {
      value = JSON.parse(b4a.toString(plain, 'utf8'))
    }
  } catch {
    value = null
  } finally {
    plain.fill(0)
  }
  if (!Array.isArray(value) || value.length !== 8 || value[0] !== VERSION) throw new UsageError(BAD_BOX)
  const [, sId, sAuthor, sAssociation, sKind, to, text, sWrittenAt] = value
  if (sId !== id || sAuthor !== author || sAssociation !== association || sKind !== kind || sWrittenAt !== writtenAt) throw new UsageError(BAD_BOX)
  if (typeof text !== 'string' || (kind === 'post' ? to !== null : typeof to !== 'string')) throw new UsageError(BAD_BOX)
  return { to, text }
}

module.exports = { sealOutbox, openOutbox, BAD_BOX, WRONG_AUTHOR, BOX_MAX, VERSION }
