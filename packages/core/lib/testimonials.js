'use strict'

// Depoimentos (docs/protocol.md). The writer publishes a `testimonial` in
// their own diary: only that they wrote a sealed depoimento to `to`, the
// text sealed with crypto_box_seal to the recipient's dm-key box key, and a
// sha256 commitment over utf8(nonce + text). The recipient, to publish it,
// writes a `testimonial-show` with the text and nonce in their own diary.
// A reader shows it only while the writer's block still commits to that
// text for that owner: the writer revokes by tombstoning the testimonial,
// the owner removes by tombstoning the show.
//
// Sealing validates its inputs and throws on a programming error; opening
// and verifying never throw, since everything they read comes from a peer.
// Errors never carry the text or key material.

const sodium = require('sodium-universal')
const b4a = require('b4a')
const {
  MAX_TESTIMONIAL, MAX_TESTIMONIAL_BOX, MIN_TESTIMONIAL_PLAIN, MAX_TESTIMONIAL_PLAIN, MAX_TESTIMONIAL_SEALED,
  isPlainObject, hasExactKeys, isHex64, validTestimonialText, validRecordCopy
} = require('./records')
const { deletedSeqs } = require('./deletion')
const { isWeakBoxKey } = require('./group')

const SEAL_BYTES = sodium.crypto_box_SEALBYTES
const BOX_PUBLIC_BYTES = sodium.crypto_box_PUBLICKEYBYTES
const BOX_SECRET_BYTES = sodium.crypto_box_SECRETKEYBYTES
const NONCE_BYTES = 32
const PLAIN_KEYS = ['text', 'nonce']

if (SEAL_BYTES + MAX_TESTIMONIAL_PLAIN !== MAX_TESTIMONIAL_SEALED) throw new Error('testimonial seal size mismatch')

function isBytes (b, len) {
  return b4a.isBuffer(b) || b instanceof Uint8Array ? (len === undefined || b.byteLength === len) : false
}

// The exact sealed bytes: key order fixed, JSON.stringify escaping.
function canonicalPlain (text, nonce) {
  return '{"text":' + JSON.stringify(text) + ',"nonce":' + JSON.stringify(nonce) + '}'
}

// from: the writer's lowercase hex64 diary key. It binds the block to its
// author: the sealed plaintext cannot name the writer (its size bound is
// already tight), so whoever opens a box checks it against the commitment
// computed with the key of the diary that holds the block.
function commitment (from, nonce, text) {
  const input = b4a.from(from + nonce + text, 'utf8')
  const out = b4a.alloc(sodium.crypto_hash_sha256_BYTES)
  sodium.crypto_hash_sha256(out, input)
  sodium.sodium_memzero(input)
  return b4a.toString(out, 'hex')
}

function boxKeyBytes (boxPk) {
  if (typeof boxPk === 'string') {
    if (!isHex64(boxPk) || isWeakBoxKey(boxPk)) throw new TypeError('chave de caixa inválida')
    return b4a.from(boxPk, 'hex')
  }
  if (!isBytes(boxPk, BOX_PUBLIC_BYTES) || isWeakBoxKey(b4a.toString(boxPk, 'hex'))) throw new TypeError('chave de caixa inválida')
  return boxPk
}

// from: the writer's own diary key (lowercase hex64); boxPk: the
// recipient's dm-key box public key (hex or 32 bytes). Returns
// { hash, box, nonce } for testimonialRecord (hash, box) and for the
// writer's own copy (nonce).
function sealOffer ({ from, text, boxPk } = {}) {
  if (!isHex64(from)) throw new TypeError('autor inválido')
  if (!validTestimonialText(text)) throw new TypeError('depoimento inválido')
  const pk = boxKeyBytes(boxPk)
  const nonceBytes = b4a.alloc(NONCE_BYTES)
  sodium.randombytes_buf(nonceBytes)
  const nonce = b4a.toString(nonceBytes, 'hex')
  const plain = b4a.from(canonicalPlain(text, nonce), 'utf8')
  try {
    if (plain.byteLength > MAX_TESTIMONIAL_PLAIN) throw new TypeError('depoimento inválido')
    const sealed = b4a.alloc(plain.byteLength + SEAL_BYTES)
    sodium.crypto_box_seal(sealed, plain, pk)
    return { hash: commitment(from, nonce, text), box: b4a.toString(sealed, 'base64'), nonce }
  } finally {
    sodium.sodium_memzero(plain)
  }
}

// box: the record's base64; boxKeyPair: { publicKey, secretKey } of the
// dm-key generation the record names. Returns { text, nonce } or null.
// The caller binds the result to the block's author with commitment().
function openOffer (box, boxKeyPair) {
  let out = null
  try {
    if (typeof box !== 'string' || box.length === 0 || box.length > MAX_TESTIMONIAL_BOX) return null
    const sealed = b4a.from(box, 'base64')
    if (b4a.toString(sealed, 'base64') !== box) return null
    if (sealed.byteLength < MIN_TESTIMONIAL_PLAIN + SEAL_BYTES || sealed.byteLength > MAX_TESTIMONIAL_SEALED) return null
    if (!isPlainObject(boxKeyPair)) return null
    const { publicKey, secretKey } = boxKeyPair
    if (!isBytes(publicKey, BOX_PUBLIC_BYTES) || !isBytes(secretKey, BOX_SECRET_BYTES)) return null
    if (isWeakBoxKey(b4a.toString(publicKey, 'hex'))) return null
    out = b4a.alloc(sealed.byteLength - SEAL_BYTES)
    if (!sodium.crypto_box_seal_open(out, sealed, publicKey, secretKey)) return null
    const json = b4a.toString(out, 'utf8')
    const body = JSON.parse(json)
    if (!isPlainObject(body) || !hasExactKeys(body, PLAIN_KEYS)) return null
    if (!validTestimonialText(body.text) || !isHex64(body.nonce)) return null
    // The exact bytes are sealed: a reordered or re-escaped JSON is refused.
    if (canonicalPlain(body.text, body.nonce) !== json) return null
    return { text: body.text, nonce: body.nonce }
  } catch {
    return null
  } finally {
    if (out !== null) sodium.sodium_memzero(out)
  }
}

// show: the owner's testimonial-show; writerRecord: block show.seq of
// show.from's diary (null when missing or tombstoned); ownerHex: the diary
// that holds the show. True only when the writer's block commits to this
// text for this owner.
function verifyShow (show, writerRecord, ownerHex) {
  try {
    if (!isHex64(ownerHex)) return false
    const s = validRecordCopy(show, 1)
    const w = validRecordCopy(writerRecord, 1)
    if (s === null || w === null) return false
    if (s.type !== 'testimonial-show' || w.type !== 'testimonial') return false
    if (s.from === ownerHex || w.to !== ownerHex) return false
    return commitment(s.from, s.nonce, s.text) === w.hash
  } catch {
    return false
  }
}

// entries: the owner's diary ({ seq, record }). One row per writer: the
// newest live show decides. A tombstoned record reads back as null (or is
// gone), so it cannot name its writer: removing a writer from the profile
// therefore tombstones EVERY show of that writer (testimonial.delete in the
// web node), never only the newest, or an older show would come back.
// Rows are candidates: the caller checks each with verifyShow against the
// writer's block before showing it. Newest first. Never throws.
function shownRows (entries) {
  if (!Array.isArray(entries)) return []
  let deleted
  try {
    deleted = deletedSeqs(entries)
  } catch {
    return []
  }
  const newest = new Map()
  for (let i = 0; i < entries.length; i++) {
    try {
      const entry = entries[i]
      if (entry === null || typeof entry !== 'object') continue
      const showSeq = entry.seq
      if (!Number.isSafeInteger(showSeq) || showSeq < 1) continue
      const copy = validRecordCopy(entry.record, showSeq)
      if (copy === null || copy.type !== 'testimonial-show') continue
      const prev = newest.get(copy.from)
      if (prev === undefined || showSeq > prev.showSeq) newest.set(copy.from, { showSeq, record: copy })
    } catch {}
  }
  const rows = []
  for (const { showSeq, record } of newest.values()) {
    if (deleted.has(showSeq)) continue
    rows.push({ from: record.from, seq: record.seq, showSeq, text: record.text, nonce: record.nonce, at: record.at })
  }
  rows.sort((a, b) => b.showSeq - a.showSeq)
  return rows
}

module.exports = {
  MAX_TESTIMONIAL,
  MAX_TESTIMONIAL_BOX,
  MAX_TESTIMONIAL_SEALED,
  sealOffer,
  openOffer,
  verifyShow,
  shownRows,
  commitment
}
