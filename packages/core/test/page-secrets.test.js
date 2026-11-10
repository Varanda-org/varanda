'use strict'

// A Página's seeds envelope and its signed share (lib/page-secrets.js). No network.
const test = require('brittle')
const b4a = require('b4a')
const sodium = require('sodium-universal')
const hcrypto = require('hypercore-crypto')
const ps = require('../lib/page-secrets')

function boxPair () {
  const publicKey = b4a.alloc(32)
  const secretKey = b4a.alloc(32)
  sodium.crypto_box_keypair(publicKey, secretKey)
  return { publicKey, secretKey, hex: b4a.toString(publicKey, 'hex') }
}

const PAGE = 'a'.repeat(64)
const MEMBER = 'b'.repeat(64)
const OTHER = 'c'.repeat(64)
// An X25519 low-order point (group.js WEAK_BOX_KEYS): the all-zero key.
const WEAK = '0'.repeat(64)

test('page-secrets: constants', (t) => {
  t.ok(Object.isFrozen(ps))
  t.is(ps.PAGE_SECRETS_V, 1)
  t.is(ps.PAGE_SECRETS_BYTES, 165)
  t.is(ps.PAGE_SECRETS_SEALED_BYTES, 213)
})

test('page-secrets: seeds and the pairs they derive', (t) => {
  const s = ps.newPageSecrets()
  t.is(s.dmSeed.byteLength, 32)
  t.is(s.groupSeed.byteLength, 32)
  t.unlike(s.dmSeed, s.groupSeed)
  const a = ps.pairsOf(s)
  const b = ps.pairsOf({ dmSeed: b4a.from(s.dmSeed), groupSeed: b4a.from(s.groupSeed) })
  t.alike(a.dmBox.publicKey, b.dmBox.publicKey, 'deterministic')
  t.alike(a.groupBox.secretKey, b.groupBox.secretKey)
  t.unlike(a.dmBox.publicKey, a.groupBox.publicKey)
  t.exception.all(() => ps.pairsOf({ dmSeed: b4a.alloc(31), groupSeed: s.groupSeed }), /segredos inválidos/)
})

test('page-secrets: seal and open round trip, always 213 bytes', (t) => {
  const me = boxPair()
  const s = ps.newPageSecrets()
  const label = { page: PAGE, gen: 2, member: MEMBER }
  for (let i = 0; i < 4; i++) {
    const b64 = ps.sealSecrets(s, { ...label, box: me.hex })
    t.is(b4a.from(b64, 'base64').byteLength, 213)
  }
  const b64 = ps.sealSecrets(s, { ...label, box: me.hex })
  const opened = ps.openSecrets(b64, me, label)
  t.alike(opened.dmSeed, s.dmSeed)
  t.alike(opened.groupSeed, s.groupSeed)
  ps.wipeSecrets(opened)
  t.alike(opened.dmSeed, b4a.alloc(32), 'wiped')
  t.alike(opened.groupSeed, b4a.alloc(32))
  t.is(ps.openSecrets(b64, boxPair(), label), null, 'another box')
})

test('page-secrets: an envelope opens only under its own label', (t) => {
  const me = boxPair()
  const s = ps.newPageSecrets()
  const label = { page: PAGE, gen: 3, member: MEMBER }
  const b64 = ps.sealSecrets(s, { ...label, box: me.hex })
  t.is(ps.openSecrets(b64, me, { ...label, page: OTHER }), null, 'wrong page')
  t.is(ps.openSecrets(b64, me, { ...label, gen: 2 }), null, 'wrong gen')
  t.is(ps.openSecrets(b64, me, { ...label, gen: 4 }), null)
  t.is(ps.openSecrets(b64, me, { ...label, member: OTHER }), null, 'wrong member')
  t.is(ps.openSecrets(b64, me, { ...label, gen: 0 }), null)
  const raw = b4a.from(b64, 'base64')
  t.is(ps.openSecrets(b4a.toString(raw.subarray(0, 212), 'base64'), me, label), null, 'truncated')
  t.is(ps.openSecrets(b64.slice(0, -4), me, label), null)
  t.is(ps.openSecrets(b64 + 'AAAA', me, label), null, 'longer')
  const flipped = b4a.from(raw)
  flipped[100] ^= 1
  t.is(ps.openSecrets(b4a.toString(flipped, 'base64'), me, label), null, 'tampered')
  for (const bad of [null, '', 42, {}, '!'.repeat(b64.length)]) t.is(ps.openSecrets(bad, me, label), null)
  t.is(ps.openSecrets(b64, null, label), null)
  t.is(ps.openSecrets(b64, me, null), null)
})

test('page-secrets: the tag binds the label inside the envelope', (t) => {
  // A plaintext with a valid header for the label but a wrong tag is refused.
  const me = boxPair()
  const label = { page: PAGE, gen: 1, member: MEMBER }
  const good = ps.sealSecrets(ps.newPageSecrets(), { ...label, box: me.hex })
  const plain = b4a.alloc(165)
  t.ok(sodium.crypto_box_seal_open(plain, b4a.from(good, 'base64'), me.publicKey, me.secretKey))
  plain[164] ^= 1
  const sealed = b4a.alloc(213)
  sodium.crypto_box_seal(sealed, plain, me.publicKey)
  t.is(ps.openSecrets(b4a.toString(sealed, 'base64'), me, label), null)
})

test('page-secrets: weak keys and bad labels are refused', (t) => {
  const s = ps.newPageSecrets()
  const label = { page: PAGE, gen: 1, member: MEMBER }
  t.exception.all(() => ps.sealSecrets(s, { ...label, box: WEAK }), /chave fraca/)
  t.exception.all(() => ps.sealLegacyBox(b4a.alloc(32, 1), WEAK), /chave fraca/)
  const me = boxPair()
  for (const bad of [{ ...label, gen: 0 }, { ...label, gen: 1.5 }, { ...label, page: 'A'.repeat(64) }, { ...label, member: null }]) {
    t.exception.all(() => ps.sealSecrets(s, { ...bad, box: me.hex }), /destino inválido/)
  }
  t.exception.all(() => ps.sealSecrets(null, { ...label, box: me.hex }), /segredos inválidos/)
  t.is(ps.openSecrets(ps.sealSecrets(s, { ...label, box: me.hex }), { publicKey: b4a.alloc(32), secretKey: me.secretKey }, label), null, 'weak recipient')
})

test('page-secrets: share signature', (t) => {
  const me = boxPair()
  const owner = hcrypto.keyPair()
  const ownerHex = b4a.toString(owner.publicKey, 'hex')
  const sealed = ps.sealSecrets(ps.newPageSecrets(), { page: PAGE, gen: 2, member: MEMBER, box: me.hex })
  const share = { page: PAGE, gen: 2, member: MEMBER, sealed }
  const bytes = ps.shareBytes(share)
  t.alike(bytes.subarray(0, 22), b4a.from('varanda-page-share-v1\n'))
  const d = b4a.alloc(32)
  sodium.crypto_hash_sha256(d, b4a.from(JSON.stringify({ gen: 2, member: MEMBER, page: PAGE, sealed })))
  t.alike(bytes.subarray(22), d, 'sha256 of the canonical json')
  const sig = ps.signShare(share, owner)
  t.is(sig.length, 128)
  t.ok(ps.verifyShare(share, sig, ownerHex))
  t.ok(ps.verifyShare({ sealed, member: MEMBER, gen: 2, page: PAGE }, sig, ownerHex), 'key order does not matter')
  t.absent(ps.verifyShare({ ...share, member: OTHER }, sig, ownerHex), 're-labelled to another member')
  t.absent(ps.verifyShare({ ...share, gen: 3 }, sig, ownerHex))
  t.absent(ps.verifyShare({ ...share, page: OTHER }, sig, ownerHex))
  t.absent(ps.verifyShare(share, sig, b4a.toString(hcrypto.keyPair().publicKey, 'hex')), 'another signer')
  t.absent(ps.verifyShare(share, sig.slice(0, 126), ownerHex))
  t.absent(ps.verifyShare({ ...share, sealed: 'x' }, sig, ownerHex))
  t.absent(ps.verifyShare(null, sig, ownerHex))
  t.exception.all(() => ps.signShare({ ...share, sealed: 'x' }, owner), /compartilhamento inválido/)
})

test('page-secrets: legacy box seal and open', (t) => {
  const me = boxPair()
  const secret = b4a.alloc(32)
  sodium.randombytes_buf(secret)
  const b64 = ps.sealLegacyBox(secret, me.hex)
  t.alike(ps.openLegacyBox(b64, me), secret)
  t.is(ps.openLegacyBox(b64, boxPair()), null)
  t.is(ps.openLegacyBox(b64.slice(0, -4), me), null)
  // The same bytes sealed without the domain prefix are refused.
  const bare = b4a.alloc(b4a.from(b64, 'base64').byteLength)
  sodium.crypto_box_seal(bare, b4a.concat([b4a.alloc(26), secret]), me.publicKey)
  t.is(ps.openLegacyBox(b4a.toString(bare, 'base64'), me), null)
  t.exception.all(() => ps.sealLegacyBox(b4a.alloc(31), me.hex), /segredo inválido/)
})
