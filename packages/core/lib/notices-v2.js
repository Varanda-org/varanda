'use strict'

// 'varanda/notices/2': the notices channel of notices-net.js with kinded
// items (who followed, replied to, quoted or mentioned the proved key). The
// flow, the proof and the bounds are v1's; what changes is the item shape
// ({ key, seq, at, kind }) and the cursor, which carries seq because one
// author may now have several notices at the same instant.
//
// The proof prefix differs from v1's, so a signature made for one protocol
// never verifies on the other: a v1 proof cannot open v2 pages and back.
//
// Browser-safe, like notices.js: b4a, hypercore-crypto and ./records only.
const b4a = require('b4a')
const hcrypto = require('hypercore-crypto')
const { isHex64, isCanonicalIso } = require('./records')
const {
  NOTICES_LIMIT_MAX,
  MAX_NOTICES_MESSAGE,
  signNoticeProof
} = require('./notices')

const NOTICES_V2_PROTOCOL = 'varanda/notices/2'
const NOTICE_V2_PROOF_PREFIX = 'varanda-notices-v2\n'
const NOTICE_KINDS = Object.freeze(['follow', 'reply', 'quote', 'mention'])

const HEX128 = /^[0-9a-f]{128}$/

function isHex128 (s) {
  return typeof s === 'string' && HEX128.test(s)
}

function isPlainObject (x) {
  if (x === null || typeof x !== 'object' || Array.isArray(x)) return false
  const proto = Object.getPrototypeOf(x)
  return proto === Object.prototype || proto === null
}

function hasExactKeys (obj, keys) {
  const own = Object.keys(obj)
  if (own.length !== keys.length) return false
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) return false
  }
  return true
}

function isSeq (n) {
  return Number.isSafeInteger(n) && n >= 1
}

function noticeV2Payload (nonceHex, noiseHex, ownHex) {
  return b4a.from(NOTICE_V2_PROOF_PREFIX + nonceHex + '\n' + noiseHex + '\n' + ownHex, 'utf8')
}

// Never throws.
function verifyNoticeV2Proof (fields, sigHex) {
  try {
    if (fields === null || typeof fields !== 'object') return false
    const nonce = fields.nonce
    const noise = fields.noise
    const key = fields.key
    if (!isHex64(nonce) || !isHex64(noise) || !isHex64(key) || !isHex128(sigHex)) return false
    return hcrypto.verify(noticeV2Payload(nonce, noise, key), b4a.from(sigHex, 'hex'), b4a.from(key, 'hex')) === true
  } catch {
    return false
  }
}

function validCursor (c) {
  if (c === null) return true
  return isPlainObject(c) && hasExactKeys(c, ['at', 'key', 'seq']) &&
    isCanonicalIso(c.at) && isHex64(c.key) && isSeq(c.seq)
}

function validLimit (n) {
  return Number.isSafeInteger(n) && n >= 1 && n <= NOTICES_LIMIT_MAX
}

function validItem (it) {
  return isPlainObject(it) && hasExactKeys(it, ['key', 'seq', 'at', 'kind']) &&
    isHex64(it.key) && isSeq(it.seq) && isCanonicalIso(it.at) &&
    typeof it.kind === 'string' && NOTICE_KINDS.includes(it.kind)
}

// Exact keys and lower-case hex for every message of the channel. Never
// throws on hostile input (getters, proxies, odd prototypes).
function validateNoticesV2Message (msg) {
  try {
    if (!isPlainObject(msg)) return false
    switch (msg.type) {
      case 'challenge':
        return hasExactKeys(msg, ['type', 'nonce']) && isHex64(msg.nonce)
      case 'proof':
        return hasExactKeys(msg, ['type', 'key', 'sig']) && isHex64(msg.key) && isHex128(msg.sig)
      case 'page':
        return hasExactKeys(msg, ['type', 'after', 'limit']) && validCursor(msg.after) && validLimit(msg.limit)
      case 'items': {
        if (!hasExactKeys(msg, ['type', 'items', 'next', 'incomplete'])) return false
        const items = msg.items
        if (!Array.isArray(items) || items.length > NOTICES_LIMIT_MAX) return false
        for (let i = 0; i < items.length; i++) {
          if (!validItem(items[i])) return false
        }
        return validCursor(msg.next) && typeof msg.incomplete === 'boolean'
      }
      default:
        return false
    }
  } catch {
    return false
  }
}

module.exports = {
  NOTICES_V2_PROTOCOL,
  NOTICE_V2_PROOF_PREFIX,
  NOTICE_KINDS,
  MAX_NOTICES_MESSAGE,
  noticeV2Payload,
  signNoticeProof,
  verifyNoticeV2Proof,
  validateNoticesV2Message
}
