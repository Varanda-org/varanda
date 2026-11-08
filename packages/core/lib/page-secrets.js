'use strict'

// A Página's secrets (docs/protocol.md section 12): two seeds generated on
// the owner's device, from which the page's dm box pair and group box pair
// derive. They travel to the owner and each accepted admin sealed to that
// member's identity-wide dm-key box, and the account service stores the
// envelope opaque. Sealing throws on a programming error; opening never
// throws, since the envelope comes back from the service, and returns null.
//
// Secrets the caller receives (newPageSecrets(), openSecrets(), a pair's
// secretKey, openLegacyBox()) are caller-owned: wipe them when done.

const sodium = require('sodium-universal')
const b4a = require('b4a')
const hcrypto = require('hypercore-crypto')
const groupCrypto = require('./group-crypto')
const { isWeakBoxKey } = require('./group')

const PAGE_SECRETS_V = 1
const SEED_BYTES = sodium.crypto_box_SEEDBYTES
const KEY_BYTES = 32
const TAG_BYTES = 32
const SEAL_BYTES = sodium.crypto_box_SEALBYTES
// v, page, gen, member, dmSeed, groupSeed, tag.
const PAGE_SECRETS_BYTES = 1 + KEY_BYTES + 4 + KEY_BYTES + SEED_BYTES + SEED_BYTES + TAG_BYTES
const PAGE_SECRETS_SEALED_BYTES = PAGE_SECRETS_BYTES + SEAL_BYTES
const TAG_DOMAIN = b4a.from('varanda/page-secrets/v1', 'utf8')
const SHARE_PREFIX = b4a.from('varanda-page-share-v1\n', 'utf8')
const LEGACY_DOMAIN = b4a.from('varanda/page-legacy-box/v1', 'utf8')
const LEGACY_SECRET_BYTES = 32
const LEGACY_SEALED_BYTES = LEGACY_DOMAIN.byteLength + LEGACY_SECRET_BYTES + SEAL_BYTES

const HEADER_BYTES = 1 + KEY_BYTES + 4 + KEY_BYTES
const DM_SEED_OFFSET = HEADER_BYTES
const GROUP_SEED_OFFSET = DM_SEED_OFFSET + SEED_BYTES
const TAG_OFFSET = GROUP_SEED_OFFSET + SEED_BYTES

const HEX64 = /^[0-9a-f]{64}$/
const HEX128 = /^[0-9a-f]{128}$/
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

function isBytes (x, len) {
  return x instanceof Uint8Array && (len === undefined || x.byteLength === len)
}

function isPlainObject (x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
}

function isHex64 (s) {
  return typeof s === 'string' && HEX64.test(s)
}

function isGen (n) {
  return Number.isInteger(n) && n >= 1 && n <= 0xffffffff
}

function wipe (b) {
  if (isBytes(b)) sodium.sodium_memzero(b)
}

// One envelope has one encoding.
function decodeBase64 (s, bytes) {
  if (typeof s !== 'string' || s.length !== Math.ceil(bytes / 3) * 4 || !BASE64.test(s)) return null
  const buf = b4a.from(s, 'base64')
  if (buf.byteLength !== bytes || b4a.toString(buf, 'base64') !== s) return null
  return buf
}

function validSecrets (s) {
  return isPlainObject(s) && isBytes(s.dmSeed, SEED_BYTES) && isBytes(s.groupSeed, SEED_BYTES)
}

function validLabel (l) {
  return isPlainObject(l) && isHex64(l.page) && isGen(l.gen) && isHex64(l.member)
}

function boxPk (hex) {
  if (!isHex64(hex) || isWeakBoxKey(hex)) throw new TypeError('chave fraca')
  return b4a.from(hex, 'hex')
}

function newPageSecrets () {
  const dmSeed = b4a.alloc(SEED_BYTES)
  const groupSeed = b4a.alloc(SEED_BYTES)
  sodium.randombytes_buf(dmSeed)
  sodium.randombytes_buf(groupSeed)
  return { dmSeed, groupSeed }
}

function pairsOf (secrets) {
  if (!validSecrets(secrets)) throw new TypeError('segredos inválidos')
  const dmBox = groupCrypto.boxKeyPairFromSeed(secrets.dmSeed)
  const groupBox = groupCrypto.boxKeyPairFromSeed(secrets.groupSeed)
  if (isWeakBoxKey(b4a.toString(dmBox.publicKey, 'hex')) || isWeakBoxKey(b4a.toString(groupBox.publicKey, 'hex'))) {
    wipe(dmBox.secretKey)
    wipe(groupBox.secretKey)
    throw new TypeError('chave fraca')
  }
  return { dmBox, groupBox }
}

// v, page, gen and member: what binds an envelope to one member, one page and
// one rotation, so the service cannot hand an old or another's envelope back.
function header ({ page, gen, member }) {
  const out = b4a.alloc(HEADER_BYTES)
  out[0] = PAGE_SECRETS_V
  out.set(b4a.from(page, 'hex'), 1)
  out[1 + KEY_BYTES] = gen >>> 24
  out[2 + KEY_BYTES] = (gen >>> 16) & 0xff
  out[3 + KEY_BYTES] = (gen >>> 8) & 0xff
  out[4 + KEY_BYTES] = gen & 0xff
  out.set(b4a.from(member, 'hex'), 1 + KEY_BYTES + 4)
  return out
}

function tagOf (head) {
  const tag = b4a.alloc(TAG_BYTES)
  sodium.crypto_generichash(tag, b4a.concat([TAG_DOMAIN, head.subarray(1)]))
  return tag
}

// label: { page, gen, member, box } (hex64 page and member, gen >= 1, box the
// member's identity-wide dm-key box). Returns canonical base64 of
// PAGE_SECRETS_SEALED_BYTES.
function sealSecrets (secrets, label) {
  if (!validSecrets(secrets)) throw new TypeError('segredos inválidos')
  if (!validLabel(label)) throw new TypeError('destino inválido')
  const pk = boxPk(label.box)
  const head = header(label)
  const plain = b4a.alloc(PAGE_SECRETS_BYTES)
  try {
    plain.set(head, 0)
    plain.set(secrets.dmSeed, DM_SEED_OFFSET)
    plain.set(secrets.groupSeed, GROUP_SEED_OFFSET)
    plain.set(tagOf(head), TAG_OFFSET)
    const sealed = b4a.alloc(PAGE_SECRETS_SEALED_BYTES)
    sodium.crypto_box_seal(sealed, plain, pk)
    return b4a.toString(sealed, 'base64')
  } finally {
    wipe(plain)
  }
}

function openSecrets (b64, recipientBoxPair, label) {
  let plain = null
  try {
    if (!validLabel(label) || !isPlainObject(recipientBoxPair)) return null
    const { publicKey, secretKey } = recipientBoxPair
    if (!isBytes(publicKey, sodium.crypto_box_PUBLICKEYBYTES) || !isBytes(secretKey, sodium.crypto_box_SECRETKEYBYTES)) return null
    if (isWeakBoxKey(b4a.toString(publicKey, 'hex'))) return null
    const sealed = decodeBase64(b64, PAGE_SECRETS_SEALED_BYTES)
    if (sealed === null) return null
    plain = b4a.alloc(PAGE_SECRETS_BYTES)
    if (!sodium.crypto_box_seal_open(plain, sealed, publicKey, secretKey)) return null
    const head = header(label)
    const okHead = sodium.sodium_memcmp(plain.subarray(0, HEADER_BYTES), head)
    const okTag = sodium.sodium_memcmp(plain.subarray(TAG_OFFSET), tagOf(head))
    if (!okHead || !okTag) return null
    return {
      dmSeed: b4a.from(plain.subarray(DM_SEED_OFFSET, DM_SEED_OFFSET + SEED_BYTES)),
      groupSeed: b4a.from(plain.subarray(GROUP_SEED_OFFSET, GROUP_SEED_OFFSET + SEED_BYTES))
    }
  } catch {
    return null
  } finally {
    wipe(plain)
  }
}

function wipeSecrets (s) {
  if (!isPlainObject(s)) return
  wipe(s.dmSeed)
  wipe(s.groupSeed)
}

function validShare (share) {
  return isPlainObject(share) && validLabel(share) && typeof share.sealed === 'string' &&
    decodeBase64(share.sealed, PAGE_SECRETS_SEALED_BYTES) !== null
}

// The sharer (owner or admin) signs the envelope with the identity key, so a
// member only takes seeds from someone the page already trusts, not from the
// service that stores the envelope.
function shareBytes (share) {
  if (!validShare(share)) throw new TypeError('compartilhamento inválido')
  const { gen, member, page, sealed } = share
  const digest = b4a.alloc(32)
  sodium.crypto_hash_sha256(digest, b4a.from(JSON.stringify({ gen, member, page, sealed }), 'utf8'))
  return b4a.concat([SHARE_PREFIX, digest])
}

function signShare (share, signerKeyPair) {
  if (!isPlainObject(signerKeyPair) || !isBytes(signerKeyPair.secretKey, 64)) throw new TypeError('chave de assinatura inválida')
  return b4a.toString(hcrypto.sign(shareBytes(share), signerKeyPair.secretKey), 'hex')
}

function verifyShare (share, sigHex, signerHex) {
  try {
    if (typeof sigHex !== 'string' || !HEX128.test(sigHex) || !isHex64(signerHex)) return false
    return hcrypto.verify(shareBytes(share), b4a.from(sigHex, 'hex'), b4a.from(signerHex, 'hex'))
  } catch {
    return false
  }
}

// Before page secrets, the service kept a page's gen 1 box secret; moving it
// to a device seals that 32-byte secret alone, under its own domain.
function sealLegacyBox (secret, boxHex) {
  if (!isBytes(secret, LEGACY_SECRET_BYTES)) throw new TypeError('segredo inválido')
  const pk = boxPk(boxHex)
  const plain = b4a.concat([LEGACY_DOMAIN, secret])
  try {
    const sealed = b4a.alloc(LEGACY_SEALED_BYTES)
    sodium.crypto_box_seal(sealed, plain, pk)
    return b4a.toString(sealed, 'base64')
  } finally {
    wipe(plain)
  }
}

function openLegacyBox (b64, pair) {
  let plain = null
  try {
    if (!isPlainObject(pair)) return null
    const { publicKey, secretKey } = pair
    if (!isBytes(publicKey, sodium.crypto_box_PUBLICKEYBYTES) || !isBytes(secretKey, sodium.crypto_box_SECRETKEYBYTES)) return null
    if (isWeakBoxKey(b4a.toString(publicKey, 'hex'))) return null
    const sealed = decodeBase64(b64, LEGACY_SEALED_BYTES)
    if (sealed === null) return null
    plain = b4a.alloc(LEGACY_DOMAIN.byteLength + LEGACY_SECRET_BYTES)
    if (!sodium.crypto_box_seal_open(plain, sealed, publicKey, secretKey)) return null
    if (!sodium.sodium_memcmp(plain.subarray(0, LEGACY_DOMAIN.byteLength), LEGACY_DOMAIN)) return null
    return b4a.from(plain.subarray(LEGACY_DOMAIN.byteLength))
  } catch {
    return null
  } finally {
    wipe(plain)
  }
}

module.exports = Object.freeze({
  PAGE_SECRETS_V,
  PAGE_SECRETS_BYTES,
  PAGE_SECRETS_SEALED_BYTES,
  newPageSecrets,
  pairsOf,
  sealSecrets,
  openSecrets,
  wipeSecrets,
  shareBytes,
  signShare,
  verifyShare,
  sealLegacyBox,
  openLegacyBox
})
