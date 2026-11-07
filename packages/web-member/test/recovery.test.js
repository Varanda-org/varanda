'use strict'

// lib/recovery.js: recovery key derivation (injected HKDF equals WebCrypto),
// root wrap and open, the wrap user-id mark, the recovery code codec, and
// zeroing of what the module allocates. No assertion message carries a
// secret.
const test = require('brittle')
const crypto = require('node:crypto')
const b4a = require('b4a')
const sodium = require('sodium-universal')
const hypercoreCrypto = require('hypercore-crypto')
const { hkdfSha256 } = require('../lib/hkdf')
const { keyPairFromPrf } = require('../lib/passkey')
const {
  WRAP_MARK, RECOVERY_HKDF_SALT, KIND_BYTES, CODE_BYTES, CODE_ALPHABET,
  newWrapUserId, isWrapUserId, deriveRecoveryKeys, wrapRoot, openRoot, isBlob,
  encodeCode, decodeCode, hexToBytes32
} = require('../lib/recovery')

const hmac = (k, d) => new Uint8Array(crypto.createHmac('sha256', k).update(d).digest())
const injected = (ikm, salt, info, length) => hkdfSha256(ikm, salt, info, length, { hmac })
const hex = (u8) => b4a.toString(b4a.from(u8.buffer, u8.byteOffset, u8.byteLength), 'hex')
const rand = (n) => new Uint8Array(crypto.randomBytes(n))

const GOLDEN_SECRET = new Uint8Array(32).map((_, i) => i)
const GOLDEN_LOOKUP = '39c5175aadeb4f3ecb7f72b6e118931000e64036f5e4b91f443e1854ee64cf33'
const GOLDEN_CODE_SECRET = new Uint8Array(20).map((_, i) => i + 1)
const GOLDEN_CODE_LOOKUP = 'c1a11005b710cf322075c5920f358d4254a4a31e67a738b6cfde7bd63a97ca65'
const GOLDEN_CODE = '0410-6105-0r3g-g28a-1c60-t3gf-208h-44rm-gx0d'

async function webcryptoHkdf (ikm, salt, info) {
  const subtle = globalThis.crypto.subtle
  const key = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
  return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, 256))
}

function concat (...parts) {
  return new Uint8Array(b4a.concat(parts.map((p) => b4a.from(p.buffer, p.byteOffset, p.byteLength))))
}

test('constants', (t) => {
  t.is(WRAP_MARK.byteLength, 16)
  t.is(b4a.toString(WRAP_MARK, 'utf8'), 'varanda-wrap-v1\n')
  t.is(b4a.toString(RECOVERY_HKDF_SALT, 'utf8'), 'varanda/member-recovery/hkdf/v1')
  t.alike(KIND_BYTES, { passkey: 1, code: 2 })
  t.is(CODE_BYTES, 20)
  t.is(CODE_ALPHABET, '0123456789abcdefghjkmnpqrstvwxyz')
})

test('golden lookupId: injected HKDF equals WebCrypto and the formula', async (t) => {
  const web = await deriveRecoveryKeys(GOLDEN_SECRET, 'passkey')
  const inj = await deriveRecoveryKeys(GOLDEN_SECRET, 'passkey', { hkdf: injected })
  t.is(web.lookupId, GOLDEN_LOOKUP)
  t.is(inj.lookupId, GOLDEN_LOOKUP)
  t.ok(b4a.equals(web.wrapKey, inj.wrapKey), 'wrap keys agree')
  const info = concat(b4a.from('varanda/member-recovery/lookup/v1', 'utf8'), new Uint8Array([1]))
  t.is(hex(await webcryptoHkdf(GOLDEN_SECRET, RECOVERY_HKDF_SALT, info)), GOLDEN_LOOKUP)
  const wrapInfo = concat(b4a.from('varanda/member-recovery/wrap/v1', 'utf8'), new Uint8Array([1]))
  t.ok(b4a.equals(await webcryptoHkdf(GOLDEN_SECRET, RECOVERY_HKDF_SALT, wrapInfo), web.wrapKey), 'wrap key formula')
  t.not(web.lookupId, hex(web.wrapKey), 'lookup and wrap differ')

  const code = await deriveRecoveryKeys(GOLDEN_CODE_SECRET, 'code', { hkdf: injected })
  t.is(code.lookupId, GOLDEN_CODE_LOOKUP)
  t.is((await deriveRecoveryKeys(GOLDEN_CODE_SECRET, 'code')).lookupId, GOLDEN_CODE_LOOKUP)
})

test('deriveRecoveryKeys refuses bad kinds and secret sizes', async (t) => {
  await t.exception.all(deriveRecoveryKeys(new Uint8Array(32), 'other'), /tipo/)
  await t.exception.all(deriveRecoveryKeys(new Uint8Array(20), 'passkey'), /segredo/)
  await t.exception.all(deriveRecoveryKeys(new Uint8Array(32), 'code'), /segredo/)
  await t.exception.all(deriveRecoveryKeys('00'.repeat(32), 'passkey'), /segredo/)
  await t.exception.all(deriveRecoveryKeys(new Uint8Array(32), 'passkey', { hkdf: async () => new Uint8Array(16) }), /HKDF/)
})

test('wrap and open round trip', async (t) => {
  const root = rand(32)
  const member = hex((await keyPairFromPrf(root)).publicKey)
  const { wrapKey } = await deriveRecoveryKeys(rand(32), 'passkey')
  const blob = wrapRoot({ root, member, kind: 'passkey', wrapKey })
  t.ok(isBlob(blob))
  t.alike(Object.keys(blob).sort(), ['ciphertext', 'kind', 'nonce', 'v'])
  t.is(blob.v, 1)
  t.is(blob.kind, 'passkey')
  t.is(blob.nonce.length, 48)
  t.is(blob.ciphertext.length, 164)
  const opened = openRoot(blob, wrapKey)
  t.ok(opened !== null)
  t.ok(b4a.equals(opened.root, root), 'root recovered')
  t.is(opened.member, member)
  t.ok(openRoot(blob, wrapKey, { member }) !== null, 'expected member matches')
  const again = wrapRoot({ root, member: hexToBytes32(member), kind: 'passkey', wrapKey })
  t.not(again.nonce, blob.nonce, 'fresh nonce')
})

test('two passkeys open the same root, each with its own identity key', async (t) => {
  const root = rand(32)
  const rootKp = await keyPairFromPrf(root)
  const member = hex(rootKp.publicKey)
  const prfA = rand(32)
  const prfB = rand(32)
  const a = await deriveRecoveryKeys(prfA, 'passkey')
  const b = await deriveRecoveryKeys(prfB, 'passkey')
  t.not(a.lookupId, b.lookupId)
  const blobA = wrapRoot({ root, member, kind: 'passkey', wrapKey: a.wrapKey })
  const blobB = wrapRoot({ root, member, kind: 'passkey', wrapKey: b.wrapKey })
  t.ok(b4a.equals(openRoot(blobA, a.wrapKey).root, root))
  t.ok(b4a.equals(openRoot(blobB, b.wrapKey).root, root))
  t.is(openRoot(blobA, b.wrapKey), null, 'one passkey cannot open the other\'s blob')
  const kpA = await keyPairFromPrf(prfA)
  const kpB = await keyPairFromPrf(prfB)
  t.absent(b4a.equals(kpA.publicKey, rootKp.publicKey))
  t.absent(b4a.equals(kpB.publicKey, rootKp.publicKey))
  t.absent(b4a.equals(kpA.publicKey, kpB.publicKey))
})

test('a code wrap opens with the code secret', async (t) => {
  const root = rand(32)
  const member = hex(rand(32))
  const secret = rand(CODE_BYTES)
  const text = encodeCode(secret)
  const { wrapKey } = await deriveRecoveryKeys(secret, 'code')
  const blob = wrapRoot({ root, member, kind: 'code', wrapKey })
  const decoded = decodeCode(text.toUpperCase())
  const again = await deriveRecoveryKeys(decoded, 'code')
  t.ok(b4a.equals(openRoot(blob, again.wrapKey).root, root))
})

test('openRoot returns null on tampering, wrong key, kind, version or member', async (t) => {
  const root = rand(32)
  const member = hex(rand(32))
  const { wrapKey } = await deriveRecoveryKeys(rand(32), 'passkey')
  const blob = wrapRoot({ root, member, kind: 'passkey', wrapKey })

  for (const field of ['nonce', 'ciphertext']) {
    for (const pos of [0, blob[field].length - 1]) {
      const c = blob[field][pos]
      const flipped = { ...blob, [field]: blob[field].slice(0, pos) + (c === '0' ? '1' : '0') + blob[field].slice(pos + 1) }
      t.is(openRoot(flipped, wrapKey), null, 'flipped ' + field + ' at ' + pos)
    }
  }
  t.is(openRoot(blob, rand(32)), null, 'wrong key')
  t.is(openRoot({ ...blob, kind: 'code' }, wrapKey), null, 'wrong kind')
  t.is(openRoot({ ...blob, v: 2 }, wrapKey), null, 'wrong version')
  t.is(openRoot(blob, wrapKey, { member: hex(rand(32)) }), null, 'swapped member')
  t.is(openRoot(blob, wrapKey, { member: 'zz' }), null, 'malformed expected member')
  t.is(openRoot({ ...blob, extra: 1 }, wrapKey), null, 'extra key')
  t.is(openRoot({ ...blob, ciphertext: blob.ciphertext.toUpperCase() }, wrapKey), null, 'uppercase hex')
  t.is(openRoot({ ...blob, ciphertext: blob.ciphertext.slice(2) }, wrapKey), null, 'short ciphertext')
  t.is(openRoot(blob, wrapKey.subarray(0, 31)), null, 'short key')
  for (const bad of [null, undefined, 1, 'x', [], {}]) t.is(openRoot(bad, wrapKey), null)

  // A blob sealed with the right key but a bad inner version or kind byte.
  const seal = (plain) => {
    const nonce = b4a.from(crypto.randomBytes(24))
    const out = b4a.alloc(plain.byteLength + 16)
    sodium.crypto_secretbox_easy(out, b4a.from(plain), nonce, b4a.from(wrapKey))
    return { v: 1, kind: 'passkey', nonce: b4a.toString(nonce, 'hex'), ciphertext: b4a.toString(out, 'hex') }
  }
  const good = concat(new Uint8Array([1, 1]), hexToBytes32(member), root)
  t.ok(openRoot(seal(good), wrapKey) !== null, 'hand-sealed control opens')
  t.is(openRoot(seal(concat(new Uint8Array([2, 1]), hexToBytes32(member), root)), wrapKey), null, 'inner version 2')
  t.is(openRoot(seal(concat(new Uint8Array([1, 2]), hexToBytes32(member), root)), wrapKey), null, 'inner kind code')
})

test('wrapRoot refuses programming errors without echoing secrets', async (t) => {
  const root = rand(32)
  const wrapKey = rand(32)
  const member = hex(rand(32))
  const base = { root, member, kind: 'passkey', wrapKey }
  t.exception.all(() => wrapRoot({ ...base, kind: 'x' }), /tipo/)
  t.exception.all(() => wrapRoot({ ...base, root: rand(31) }), /raiz/)
  t.exception.all(() => wrapRoot({ ...base, wrapKey: rand(16) }), /chave/)
  t.exception.all(() => wrapRoot({ ...base, member: 'ab' }), /membro/)
  t.exception.all(() => wrapRoot({ ...base, randomBytes: () => new Uint8Array(8) }), /randomBytes/)
  try {
    wrapRoot({ ...base, member: 'ab' })
  } catch (err) {
    t.absent(err.message.includes(hex(root)) || err.message.includes(hex(wrapKey)), 'no secret in the message')
  }
})

test('isBlob checks exact keys, kinds and hex lengths', (t) => {
  const blob = { v: 1, kind: 'code', nonce: 'a'.repeat(48), ciphertext: 'b'.repeat(164) }
  t.ok(isBlob(blob))
  t.absent(isBlob({ ...blob, kind: 'other' }))
  t.absent(isBlob({ ...blob, v: '1' }))
  t.absent(isBlob({ ...blob, nonce: 'a'.repeat(46) }))
  t.absent(isBlob({ ...blob, ciphertext: 'b'.repeat(166) }))
  t.absent(isBlob({ ...blob, nonce: 'g'.repeat(48) }))
  const { v, ...noV } = blob
  t.absent(isBlob(noV))
  t.absent(isBlob(null))
  t.absent(isBlob([]))
})

test('wrap user id: random prefix then the mark', (t) => {
  const id = newWrapUserId()
  t.is(id.byteLength, 32)
  t.ok(b4a.equals(id.subarray(16), WRAP_MARK))
  t.ok(isWrapUserId(id))
  t.ok(isWrapUserId(hex(id)))
  t.ok(isWrapUserId(hex(id).toUpperCase()))
  t.not(hex(newWrapUserId()), hex(id), 'random part differs')
  const fixed = newWrapUserId((n) => new Uint8Array(n).fill(0xab))
  t.is(hex(fixed).slice(0, 32), 'ab'.repeat(16))
  t.exception.all(() => newWrapUserId(() => new Uint8Array(4)), /randomBytes/)

  t.absent(isWrapUserId(rand(32)), 'plain random id')
  const prefixOnly = concat(WRAP_MARK, rand(16))
  t.absent(isWrapUserId(prefixOnly), 'mark as a prefix only')
  t.absent(isWrapUserId(hex(prefixOnly)))
  t.absent(isWrapUserId(concat(rand(16), WRAP_MARK, rand(1))), '33 bytes')
  t.absent(isWrapUserId(WRAP_MARK), 'mark alone')
  const oneOff = new Uint8Array(id)
  oneOff[31] ^= 1
  t.absent(isWrapUserId(oneOff))
  for (const bad of [null, undefined, 1, 'zz', hex(id).slice(2), {}]) t.absent(isWrapUserId(bad))
})

// Independent decoder: the 36 symbols as one big number.
function referenceDecode (text) {
  const clean = text.replace(/-/g, '')
  let n = 0n
  for (const c of clean) n = (n << 5n) | BigInt(CODE_ALPHABET.indexOf(c))
  const check = Number(n & 0xfffffn)
  const secretHex = (n >> 20n).toString(16).padStart(40, '0')
  return { secretHex, check }
}

function referenceCheck (secret) {
  const digest = hypercoreCrypto.hash(concat(b4a.from('varanda/recovery-code/v1\n', 'utf8'), secret))
  return (digest[0] << 12) | (digest[1] << 4) | (digest[2] >> 4)
}

test('recovery code: golden, format and reference decoding', (t) => {
  t.is(encodeCode(GOLDEN_CODE_SECRET), GOLDEN_CODE)
  for (let i = 0; i < 20; i++) {
    const secret = rand(CODE_BYTES)
    const text = encodeCode(secret)
    t.ok(/^[0-9a-hjkmnp-tv-z]{4}(-[0-9a-hjkmnp-tv-z]{4}){8}$/.test(text), 'format')
    const ref = referenceDecode(text)
    t.is(ref.secretHex, hex(secret), 'secret bits')
    t.is(ref.check, referenceCheck(secret), 'checksum bits')
    t.ok(b4a.equals(decodeCode(text), secret), 'round trip')
  }
  t.is(encodeCode(new Uint8Array(20)).slice(0, 39), '0000-'.repeat(7) + '0000')
  t.exception.all(() => encodeCode(new Uint8Array(19)), /código/)
})

test('recovery code: normalisation, length and checksum', (t) => {
  const secret = GOLDEN_CODE_SECRET
  const same = (text) => {
    const out = decodeCode(text)
    return out !== null && b4a.equals(out, secret)
  }
  t.ok(same(GOLDEN_CODE.toUpperCase()), 'uppercase')
  t.ok(same(GOLDEN_CODE.replace(/-/g, '')), 'no hyphens')
  t.ok(same(GOLDEN_CODE.replace(/-/g, ' ')), 'spaces')
  t.ok(same(' ' + GOLDEN_CODE.replace(/-/g, ' - ') + ' '), 'mixed separators')
  t.ok(same(GOLDEN_CODE.replace(/0/g, 'O')), 'O reads as 0')
  t.ok(same(GOLDEN_CODE.replace(/0/g, 'o')), 'o reads as 0')
  t.ok(same(GOLDEN_CODE.replace(/1/g, 'I')), 'I reads as 1')
  t.ok(same(GOLDEN_CODE.replace(/1/g, 'l')), 'l reads as 1')

  t.is(decodeCode(GOLDEN_CODE.slice(0, -1)), null, '35 symbols')
  t.is(decodeCode(GOLDEN_CODE + '0'), null, '37 symbols')
  t.is(decodeCode(GOLDEN_CODE.replace(/-/g, '').slice(0, 32)), null, 'secret without checksum')
  t.is(decodeCode(GOLDEN_CODE.slice(0, -1) + 'u'), null, 'u is not in the alphabet')
  t.is(decodeCode(GOLDEN_CODE.replace('-', '_')), null, 'other separator')
  t.is(decodeCode(GOLDEN_CODE.replace('-', '\n')), null, 'newline')

  let rejected = 0
  const clean = GOLDEN_CODE.replace(/-/g, '')
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i]
    const other = CODE_ALPHABET[(CODE_ALPHABET.indexOf(c) + 1) % 32]
    if (decodeCode(clean.slice(0, i) + other + clean.slice(i + 1)) === null) rejected++
  }
  t.is(rejected, clean.length, 'every single-symbol change fails the checksum')
  for (const bad of [null, undefined, 1, {}, '']) t.is(decodeCode(bad), null)
})

test('hexToBytes32 decodes lowercase hex64 only', (t) => {
  const bytes = rand(32)
  t.ok(b4a.equals(hexToBytes32(hex(bytes)), bytes))
  t.is(hexToBytes32(hex(bytes).toUpperCase()), null)
  t.is(hexToBytes32(hex(bytes).slice(2)), null)
  t.is(hexToBytes32(null), null)
})

test('inputs are left unchanged and HKDF copies are zeroed after return', async (t) => {
  const secret = rand(32)
  const secretCopy = new Uint8Array(secret)
  const seen = []
  const spy = async (ikm, salt, info, length) => {
    seen.push(ikm, salt, info)
    const out = await injected(ikm, salt, info, length)
    seen.push(out)
    return out
  }
  const { wrapKey } = await deriveRecoveryKeys(secret, 'passkey', { hkdf: spy })
  t.ok(b4a.equals(secret, secretCopy), 'secret untouched')
  t.is(seen.length, 8)
  t.ok(seen.every((b) => b.every((x) => x === 0)), 'every buffer handed to or returned by hkdf is zeroed')
  t.absent(wrapKey.every((x) => x === 0), 'the returned wrap key is live')
  t.is(b4a.toString(RECOVERY_HKDF_SALT, 'utf8'), 'varanda/member-recovery/hkdf/v1', 'salt constant intact')

  const root = rand(32)
  const rootCopy = new Uint8Array(root)
  const keyCopy = new Uint8Array(wrapKey)
  const member = rand(32)
  const memberCopy = new Uint8Array(member)
  let nonce = null
  const blob = wrapRoot({ root, member, kind: 'passkey', wrapKey, randomBytes: (n) => { nonce = rand(n); return nonce } })
  t.ok(b4a.equals(root, rootCopy) && b4a.equals(wrapKey, keyCopy) && b4a.equals(member, memberCopy), 'wrap inputs untouched')
  t.ok(nonce.every((x) => x === 0), 'the injected random buffer is zeroed after copying')
  const opened = openRoot(blob, wrapKey)
  t.ok(b4a.equals(wrapKey, keyCopy), 'open leaves the key untouched')
  t.ok(b4a.equals(opened.root, root))

  const codeSecret = rand(CODE_BYTES)
  const codeCopy = new Uint8Array(codeSecret)
  encodeCode(codeSecret)
  t.ok(b4a.equals(codeSecret, codeCopy), 'encodeCode leaves the secret untouched')
})
