// The member diary on Hypercore 10 (memory storage): versions, key shape,
// certificate then post, raw block 0 bytes, reopen on the same storage and a
// wrong-association certificate.
const test = require('brittle')
const { createRequire } = require('node:module')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { testnet } = require('./helpers/net')
const { createCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { validateRecord } = require('@varanda/core/lib/records')
const { createMember, APPEND_MODE } = require('../lib/member')
const { memoryStorage } = require('../lib/storage')
const { DIARY_OPTIONS } = require('../lib/diary-options')

const HEX64 = /^[0-9a-f]{64}$/

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

test('hypercore 10 here, hypercore 11 under @varanda/core', async (t) => {
  await testnet(t)
  const here = createRequire(require.resolve('../lib/member'))
  const core = createRequire(require.resolve('@varanda/core/lib/seeder'))
  t.is(here('hypercore/package.json').version, '10.38.2')
  t.is(core('hypercore/package.json').version, '11.39.0')
  t.is(here('compact-encoding/package.json').version, '3.5.2', 'the workspace itself pins compact-encoding 3')
  t.is(here('@hyperswarm/secret-stream/package.json').version, '6.9.2')
})

test('fresh member: certificate, post, raw block 0, reopen', async (t) => {
  await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const association = hex(assocKp.publicKey)
  const storage = memoryStorage()

  const m = await createMember({ storage, association })
  t.teardown(() => m.close(), { force: true })
  t.ok(HEX64.test(m.key), 'key is hex64')
  t.ok(HEX64.test(m.publicKey), 'publicKey is hex64')
  t.comment('APPEND_MODE=' + APPEND_MODE + ' DIARY_OPTIONS=' + JSON.stringify(DIARY_OPTIONS))
  t.comment('key === publicKey: ' + (m.key === m.publicKey) +
    '; manifest version ' + (m.manifest ? m.manifest.version : null) +
    '; core.compat ' + m.core.core.compat)
  t.is(m.core.length, 0)

  await t.exception(() => m.post('cedo demais'), /certificado ausente/, 'no post before the certificate')

  const cert = createCert({ member: m.key }, assocKp)
  await m.setCert(cert)
  t.is(m.core.length, 1)
  await t.exception(() => m.setCert(cert), /certificado já gravado/)
  await m.post('primeiro poste')
  t.is(m.core.length, 2)

  const raw = await m.core.get(0, { valueEncoding: 'binary' })
  t.ok(b4a.isBuffer(raw) || raw instanceof Uint8Array, 'raw bytes')
  const block0 = JSON.parse(b4a.toString(raw, 'utf8'))
  t.is(block0.type, 'member-cert')
  t.is(block0.cert.member, m.key)
  t.alike(block0, await m.block(0))
  const expected = b4a.from(JSON.stringify({ type: 'member-cert', cert }), 'utf8')
  t.ok(b4a.equals(raw, expected), 'block 0 is exactly JSON.stringify bytes (no prefix)')

  const keyPair = m.keyPair
  await m.close()
  const again = await createMember({ storage, keyPair, association })
  t.teardown(() => again.close(), { force: true })
  t.is(again.key, m.key, 'same key after reopen')
  t.is(again.core.length, 2, 'same length after reopen')
  t.ok(again.core.writable, 'still writable')
  await again.post('terceiro registro')
  t.is(again.core.length, 3)
  t.is((await again.block(2)).text, 'terceiro registro')
})

test('overlapping writes are serialized: one certificate, then ordered posts', async (t) => {
  await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const m = await createMember({ storage: memoryStorage(), association: hex(assocKp.publicKey) })
  t.teardown(() => m.close(), { force: true })
  const cert = createCert({ member: m.key }, assocKp)

  // Both calls start before either append lands: without the write lock both
  // see length 0 and the second certificate ends up in block 1.
  const results = await Promise.allSettled([m.setCert(cert), m.setCert(cert)])
  t.is(results.filter((r) => r.status === 'fulfilled').length, 1, 'exactly one setCert fulfilled')
  const rejected = results.filter((r) => r.status === 'rejected')
  t.is(rejected.length, 1, 'exactly one setCert rejected')
  t.ok(/certificado já gravado/.test(rejected[0].reason.message), rejected[0].reason.message)
  t.is(m.core.length, 1, 'the certificate is the only block')
  t.is((await m.block(0)).type, 'member-cert')

  const [a, b] = await Promise.all([m.post('poste um'), m.post('poste dois')])
  t.is(a, 1, 'first concurrent post is block 1 (length 2)')
  t.is(b, 2, 'second concurrent post is block 2 (length 3)')
  t.is(m.core.length, 3)
  const block1 = await m.block(1)
  const block2 = await m.block(2)
  t.is(block1.type, 'post')
  t.is(block1.text, 'poste um')
  t.is(block2.type, 'post')
  t.is(block2.text, 'poste dois')
  t.is(validateRecord(block1, 1), null, 'block 1 validates at index 1')
  t.is(validateRecord(block2, 2), null, 'block 2 validates at index 2')
})

test('reopening without a key pair restores the stored identity', async (t) => {
  await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const association = hex(assocKp.publicKey)
  const storage = memoryStorage()
  const original = crypto.keyPair()

  const m = await createMember({ storage, keyPair: original, association })
  t.teardown(() => m.close(), { force: true })
  t.is(m.publicKey, hex(original.publicKey), 'created with the given key pair')
  t.is(m.key, m.publicKey, 'compat: key === publicKey')
  t.ok(b4a.equals(m.core.keyPair.publicKey, original.publicKey), 'core signs with the given key pair')
  await m.setCert(createCert({ member: m.key }, assocKp))
  await m.post('antes de reabrir')
  t.is(m.core.length, 2)
  await m.close()

  const again = await createMember({ storage, association })
  t.teardown(() => again.close(), { force: true })
  t.is(again.key, m.key, 'same key without passing the key pair')
  t.is(again.publicKey, m.key, 'publicKey === key')
  t.is(again.publicKey, hex(again.core.keyPair.publicKey), 'publicKey is the core\'s own public key')
  t.ok(b4a.equals(again.keyPair.publicKey, original.publicKey), 'keyPair.publicKey restored')
  t.ok(b4a.equals(again.keyPair.secretKey, original.secretKey), 'keyPair.secretKey restored')
  t.is(again.core.length, 2)
  t.ok(again.core.writable, 'writable with the restored key pair')
  await again.post('depois de reabrir')
  t.is(again.core.length, 3)
  t.is((await again.block(2)).text, 'depois de reabrir')
  await again.close()

  await t.exception(
    () => createMember({ storage, keyPair: crypto.keyPair(), association }),
    /chave não corresponde ao diário/,
    'another key pair does not open this diary'
  )
  const third = await createMember({ storage, keyPair: original, association })
  t.teardown(() => third.close(), { force: true })
  t.is(third.core.length, 3, 'the storage is intact after the refused open')
})

test('a certificate from another association is rejected', async (t) => {
  await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const otherKp = generateAssociationKeyPair()
  const m = await createMember({ storage: memoryStorage(), association: hex(assocKp.publicKey) })
  t.teardown(() => m.close(), { force: true })
  await t.exception(() => m.setCert(createCert({ member: m.key }, otherKp)), /certificado rejeitado/)
  const other = await createMember({ storage: memoryStorage(), association: hex(assocKp.publicKey) })
  t.teardown(() => other.close(), { force: true })
  await t.exception(() => m.setCert(createCert({ member: other.key }, assocKp)), /certificado rejeitado: member-mismatch/)
  t.is(m.core.length, 0, 'nothing appended')
})

test('the certificate is copied before verification: a later change by the caller is not stored', async (t) => {
  await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const association = hex(assocKp.publicKey)
  const m = await createMember({ storage: memoryStorage(), association, ...DIARY_OPTIONS })
  t.teardown(() => m.close(), { force: true })
  const cert = createCert({ member: m.key }, assocKp)
  const original = cert.ageBand
  const pending = m.setCert(cert)
  cert.ageBand = 'mudou-depois'
  await pending
  const block0 = await m.block(0)
  t.is(block0.cert.ageBand, original, 'block 0 holds the certificate as verified')
  t.is(validateRecord(block0, 0), null, 'block 0 is a valid member-cert record')
})
