'use strict'

// diaryKeyOfSigner reproduces, without hypercore, the key Hypercore gives
// the default one-signer manifest of a public key: checked against the
// installed Hypercore 11, a real Corestore 7 diary and the Hypercore the
// browser member bundles. No network.
const test = require('brittle')
const path = require('node:path')
const b4a = require('b4a')
const hcrypto = require('hypercore-crypto')
const Corestore = require('corestore')
const Hypercore = require('hypercore')
const Verifier = require('hypercore/lib/verifier')
const { tmpDir } = require('./helpers/tmp')
const { diaryKeyOfSigner, isDiaryOfSigner } = require('../lib/diary-signer')

const hex = (b) => b4a.toString(b, 'hex')
const manifestKey = (pk) => Hypercore.key(Verifier.defaultSignerManifest(pk))

test('a fixed vector', (t) => {
  const key = diaryKeyOfSigner(b4a.alloc(32, 1))
  t.ok(b4a.isBuffer(key))
  t.is(key.byteLength, 32)
  t.is(hex(key), '1ec23a2b047862aa88526b18b8c0c096f6438ecf2a652410ca55c35259dc6e4d')
})

test('equals Hypercore 11 for many random signers, from bytes or hex', (t) => {
  for (let i = 0; i < 256; i++) {
    const pk = hcrypto.keyPair().publicKey
    const expected = manifestKey(pk)
    const fromBytes = diaryKeyOfSigner(pk)
    const fromHex = diaryKeyOfSigner(hex(pk))
    if (!b4a.equals(fromBytes, expected) || !b4a.equals(fromHex, expected)) {
      t.fail('mismatch for ' + hex(pk))
      return
    }
  }
  t.pass('256 signers match')
  const pk = hcrypto.keyPair().publicKey
  t.alike(diaryKeyOfSigner(new Uint8Array(pk)), manifestKey(pk), 'a plain Uint8Array')
})

test('equals the key of a real Corestore diary, whose signer is not the key', async (t) => {
  for (let i = 0; i < 3; i++) {
    const store = new Corestore(tmpDir(t, 'varanda-diary-signer-'))
    t.teardown(() => store.close(), { force: true })
    const core = store.get({ name: 'diary' })
    await core.ready()
    t.absent(b4a.equals(core.keyPair.publicKey, core.key), 'a manifest key')
    t.alike(diaryKeyOfSigner(core.keyPair.publicKey), core.key)
    t.ok(isDiaryOfSigner(hex(core.key), hex(core.keyPair.publicKey)))
  }
})

// The browser member bundles its own Hypercore (10.38.2 today), which has
// the same static API.
test('equals the key the browser member\'s Hypercore gives', (t) => {
  const webMember = path.join(__dirname, '..', '..', 'web-member')
  const main = require.resolve('hypercore', { paths: [webMember] })
  const WebHypercore = require(main)
  const WebVerifier = require(path.join(path.dirname(main), 'lib', 'verifier.js'))
  t.comment('web-member hypercore ' + require(path.join(path.dirname(main), 'package.json')).version)
  for (let i = 0; i < 64; i++) {
    const pk = hcrypto.keyPair().publicKey
    if (!b4a.equals(diaryKeyOfSigner(pk), WebHypercore.key(WebVerifier.defaultSignerManifest(pk)))) {
      t.fail('mismatch for ' + hex(pk))
      return
    }
  }
  t.pass('64 signers match')
})

test('bad signers throw TypeError', (t) => {
  for (const bad of [undefined, null, 1, {}, [], '', 'zz', 'AB'.repeat(32), 'ab'.repeat(31), 'ab'.repeat(33), b4a.alloc(31), b4a.alloc(33)]) {
    t.exception.all(() => diaryKeyOfSigner(bad), TypeError)
  }
})

test('isDiaryOfSigner: only a manifest diary of that signer; never throws', (t) => {
  const a = hcrypto.keyPair()
  const b = hcrypto.keyPair()
  const keyA = hex(manifestKey(a.publicKey))
  t.ok(isDiaryOfSigner(keyA, hex(a.publicKey)))
  t.absent(isDiaryOfSigner(keyA, hex(b.publicKey)), 'another signer')
  t.absent(isDiaryOfSigner(hex(manifestKey(b.publicKey)), hex(a.publicKey)), 'another diary')
  t.absent(isDiaryOfSigner(hex(a.publicKey), hex(a.publicKey)), 'a key that is its own signer')
  t.absent(isDiaryOfSigner(keyA.toUpperCase(), hex(a.publicKey)), 'uppercase key')
  for (const [k, s] of [[undefined, undefined], [null, hex(a.publicKey)], [keyA, null], [keyA, a.publicKey], [manifestKey(a.publicKey), hex(a.publicKey)], [keyA, 'zz'], [{}, []]]) {
    t.absent(isDiaryOfSigner(k, s))
  }
})
