const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { testnet } = require('./helpers/net')
const { tmpDir } = require('./helpers/tmp')
const cert = require('../lib/cert')

const LF = '\n'
const MEMBER = 'ab'.repeat(32)
const SEEDER = 'ef'.repeat(32)
const DATE = '2026-10-19T00:00:00.000Z'

function fixture () {
  const kp = crypto.keyPair()
  return { kp, assocHex: b4a.toString(kp.publicKey, 'hex') }
}

test('createCert and verifyCert round trip', async (t) => {
  await testnet(t)
  const { kp, assocHex } = fixture()
  const c = cert.createCert({ member: MEMBER }, kp)
  t.alike(Object.keys(c).sort(), ['ageBand', 'association', 'date', 'member', 'method', 'signature', 'v'])
  t.is(c.v, 1)
  t.is(c.ageBand, '18+')
  t.is(c.method, 'stub')
  t.is(c.association, assocHex)
  t.is(cert.validateCertShape(c), null)
  t.alike(cert.verifyCert(c, assocHex), { ok: true })
  t.alike(cert.verifyCert(c, assocHex.toUpperCase()), { ok: true })
  t.alike(cert.certForKey(c, MEMBER, assocHex), { ok: true })
})

test('malformed certificates', async (t) => {
  await testnet(t)
  const { kp, assocHex } = fixture()
  const c = cert.createCert({ member: MEMBER, date: DATE }, kp)
  const without = { ...c }
  delete without.method
  const variants = {
    'missing key': without,
    'extra key': { ...c, extra: 1 },
    'v 2': { ...c, v: 2 },
    'uppercase hex': { ...c, member: c.member.toUpperCase() },
    'truncated signature': { ...c, signature: c.signature.slice(0, 126) },
    'ageBand with a space': { ...c, ageBand: '18 +' },
    'bad method': { ...c, method: 'Stub!' },
    'date without milliseconds': { ...c, date: '2026-10-19T00:00:00Z' },
    'invalid month': { ...c, date: '2026-13-01T00:00:00.000Z' },
    'numeric date': { ...c, date: 1760832000000 },
    array: [],
    string: 'cert'
  }
  for (const [name, v] of Object.entries(variants)) {
    t.is(cert.validateCertShape(v), 'malformed', name + ' shape')
    t.alike(cert.verifyCert(v, assocHex), { ok: false, reason: 'malformed' }, name)
    t.alike(cert.certForKey(v, MEMBER, assocHex), { ok: false, reason: 'malformed' }, name + ' certForKey')
  }
})

test('untrusted association, tampering and member mismatch', async (t) => {
  await testnet(t)
  const { kp, assocHex } = fixture()
  const other = fixture()
  const c = cert.createCert({ member: MEMBER, date: DATE }, kp)
  t.alike(cert.verifyCert(c, other.assocHex), { ok: false, reason: 'untrusted-association' })
  t.alike(cert.verifyCert({ ...c, date: '2026-10-20T00:00:00.000Z' }, assocHex), { ok: false, reason: 'bad-signature' })
  t.alike(cert.verifyCert({ ...c, ageBand: '16-17' }, assocHex), { ok: false, reason: 'bad-signature' })
  t.alike(cert.certForKey(c, 'cd'.repeat(32), assocHex), { ok: false, reason: 'member-mismatch' })
  t.alike(cert.certForKey(c, MEMBER, other.assocHex), { ok: false, reason: 'untrusted-association' })
})

test('verifyCert never throws', async (t) => {
  await testnet(t)
  const { kp, assocHex } = fixture()
  const c = cert.createCert({ member: MEMBER }, kp)
  const hostile = {}
  for (const k of Object.keys(c)) {
    Object.defineProperty(hostile, k, { enumerable: true, get () { throw new Error('boom') } })
  }
  for (const v of [null, undefined, 0, 'x', [], hostile, { ...c, date: '2026-13-01T00:00:00.000Z' }]) {
    t.is(cert.verifyCert(v, assocHex).ok, false)
    t.is(cert.certForKey(v, MEMBER, assocHex).ok, false)
    t.is(cert.validateCertShape(v), 'malformed')
  }
  t.alike(cert.verifyCert(c, 'zz'), { ok: false, reason: 'malformed' })
  t.alike(cert.verifyCert(c, null), { ok: false, reason: 'malformed' })
  t.is(cert.certForKey(c, null, assocHex).ok, false)
})

test('member certificate payload is exact', async (t) => {
  await testnet(t)
  const association = 'cd'.repeat(32)
  const c = { v: 1, member: MEMBER, ageBand: '18+', method: 'stub', date: DATE, association, signature: '' }
  const expected = b4a.from('varanda-cert-v1' + LF + MEMBER + LF + '18+' + LF + 'stub' + LF + DATE + LF + association, 'utf8')
  t.ok(b4a.equals(cert.certPayload(c), expected))
})

test('createCert normalizes and validates input', async (t) => {
  await testnet(t)
  const { kp } = fixture()
  const c = cert.createCert({ member: MEMBER.toUpperCase() }, kp)
  t.is(c.member, MEMBER)
  t.is(cert.validateCertShape(c), null)
  t.exception.all(() => cert.createCert({ member: 'abc' }, kp), TypeError)
  t.exception.all(() => cert.createCert({ member: MEMBER, ageBand: 'a b' }, kp), TypeError)
  t.exception.all(() => cert.createCert({ member: MEMBER, method: 'BAD' }, kp), TypeError)
  t.exception.all(() => cert.createCert({ member: MEMBER, date: '2026-10-19T00:00:00Z' }, kp), TypeError)
  t.exception.all(() => cert.createCert({ member: MEMBER, date: '2026-13-01T00:00:00.000Z' }, kp), TypeError)
  t.exception.all(() => cert.createCert({ member: MEMBER }, { publicKey: kp.publicKey, secretKey: b4a.alloc(32) }), TypeError)
})

test('isHex and normalizeHex', async (t) => {
  await testnet(t)
  t.ok(cert.isHex('aB'.repeat(32), 32))
  t.not(cert.isHex('ab', 32))
  t.not(cert.isHex(42, 1))
  t.not(cert.isHex('zz', 1))
  t.is(cert.normalizeHex('ABcd'), 'abcd')
  t.is(cert.normalizeHex('abc'), null)
  t.is(cert.normalizeHex('zz'), null)
  t.is(cert.normalizeHex(null), null)
})

test('seeder certificate round trip and payload', async (t) => {
  await testnet(t)
  const { kp, assocHex } = fixture()
  const c = cert.createSeederCert({ seeder: SEEDER.toUpperCase() }, kp)
  t.alike(Object.keys(c).sort(), ['association', 'date', 'seeder', 'signature', 'v'])
  t.is(c.seeder, SEEDER)
  t.is(c.association, assocHex)
  t.is(cert.validateSeederCertShape(c), null)
  t.alike(cert.verifySeederCert(c, assocHex), { ok: true })
  t.alike(cert.seederCertForKey(c, SEEDER.toUpperCase(), assocHex), { ok: true })

  const association = 'cd'.repeat(32)
  const fixed = { v: 1, seeder: SEEDER, date: DATE, association, signature: '' }
  const expected = b4a.from('varanda-seeder-v1' + LF + SEEDER + LF + DATE + LF + association, 'utf8')
  t.ok(b4a.equals(cert.seederCertPayload(fixed), expected))

  t.exception.all(() => cert.createSeederCert({ seeder: 'abc' }, kp), TypeError)
  t.exception.all(() => cert.createSeederCert({ seeder: SEEDER, date: '2026-13-01T00:00:00.000Z' }, kp), TypeError)
  t.exception.all(() => cert.createSeederCert({ seeder: SEEDER }, { publicKey: kp.publicKey, secretKey: b4a.alloc(10) }), TypeError)
})

test('seeder certificate malformed, untrusted, tampered, mismatch', async (t) => {
  await testnet(t)
  const { kp, assocHex } = fixture()
  const other = fixture()
  const c = cert.createSeederCert({ seeder: SEEDER, date: DATE }, kp)
  const without = { ...c }
  delete without.date
  const variants = {
    'missing key': without,
    'extra key': { ...c, extra: 1 },
    'v 2': { ...c, v: 2 },
    'uppercase seeder': { ...c, seeder: c.seeder.toUpperCase() },
    'uppercase signature': { ...c, signature: c.signature.toUpperCase() },
    'truncated signature': { ...c, signature: c.signature.slice(2) },
    'date without milliseconds': { ...c, date: '2026-10-19T00:00:00Z' },
    'invalid month': { ...c, date: '2026-13-01T00:00:00.000Z' },
    'four keys': { v: 1, seeder: c.seeder, date: c.date, association: c.association }
  }
  for (const [name, v] of Object.entries(variants)) {
    t.is(cert.validateSeederCertShape(v), 'malformed', name + ' shape')
    t.alike(cert.verifySeederCert(v, assocHex), { ok: false, reason: 'malformed' }, name)
    t.alike(cert.seederCertForKey(v, SEEDER, assocHex), { ok: false, reason: 'malformed' }, name + ' seederCertForKey')
  }
  t.alike(cert.verifySeederCert(c, other.assocHex), { ok: false, reason: 'untrusted-association' })
  t.alike(cert.verifySeederCert({ ...c, date: '2026-10-20T00:00:00.000Z' }, assocHex), { ok: false, reason: 'bad-signature' })
  t.alike(cert.seederCertForKey(c, 'cd'.repeat(32), assocHex), { ok: false, reason: 'seeder-mismatch' })
  t.alike(cert.seederCertForKey(c, SEEDER, other.assocHex), { ok: false, reason: 'untrusted-association' })
})

test('domain separation between member and seeder signatures', async (t) => {
  await testnet(t)
  const { kp, assocHex } = fixture()
  // A member signature over the member payload where member === seeder key and same date.
  const m = cert.createCert({ member: SEEDER, date: DATE }, kp)
  const forged = { v: 1, seeder: SEEDER, date: DATE, association: assocHex, signature: m.signature }
  t.is(cert.validateSeederCertShape(forged), null)
  t.alike(cert.verifySeederCert(forged, assocHex), { ok: false, reason: 'bad-signature' })
  // And a seeder signature placed in a member certificate.
  const s = cert.createSeederCert({ seeder: SEEDER, date: DATE }, kp)
  const forgedMember = { ...m, signature: s.signature }
  t.alike(cert.verifyCert(forgedMember, assocHex), { ok: false, reason: 'bad-signature' })
})

test('verifySeederCert never throws', async (t) => {
  await testnet(t)
  const { kp, assocHex } = fixture()
  const c = cert.createSeederCert({ seeder: SEEDER }, kp)
  const hostile = {}
  for (const k of Object.keys(c)) {
    Object.defineProperty(hostile, k, { enumerable: true, get () { throw new Error('boom') } })
  }
  for (const v of [null, undefined, 0, 'x', [], hostile, { ...c, date: '2026-13-01T00:00:00.000Z' }, { ...c, date: 5 }]) {
    t.is(cert.verifySeederCert(v, assocHex).ok, false)
    t.is(cert.seederCertForKey(v, SEEDER, assocHex).ok, false)
    t.is(cert.validateSeederCertShape(v), 'malformed')
  }
  t.alike(cert.verifySeederCert(c, 'zz'), { ok: false, reason: 'malformed' })
  t.is(cert.seederCertForKey(c, null, assocHex).ok, false)
})

test('key pair files: round trip, permissions, garbage', async (t) => {
  await testnet(t)
  const dir = tmpDir(t)
  const kp = cert.generateAssociationKeyPair()
  const file = path.join(dir, 'nested', 'deep', 'key.json')
  cert.saveKeyPairFile(file, kp)
  t.is(fs.statSync(file).mode & 0o077, 0)
  t.is(fs.statSync(path.dirname(file)).mode & 0o077, 0)
  t.absent(fs.existsSync(file + '.tmp'))
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'))
  t.alike(Object.keys(stored), ['v', 'publicKey', 'secretKey'])
  t.is(stored.v, 1)
  const loaded = cert.loadKeyPairFile(file)
  t.ok(b4a.equals(loaded.publicKey, kp.publicKey))
  t.ok(b4a.equals(loaded.secretKey, kp.secretKey))

  const afile = path.join(dir, 'association.json')
  cert.saveAssociationKeyPair(afile, kp)
  t.is(fs.statSync(afile).mode & 0o077, 0)
  const aloaded = cert.loadAssociationKeyPair(afile)
  t.ok(b4a.equals(aloaded.publicKey, kp.publicKey))
  t.ok(b4a.equals(aloaded.secretKey, kp.secretKey))

  const garbage = [
    'not json',
    '[]',
    JSON.stringify({ v: 2, publicKey: stored.publicKey, secretKey: stored.secretKey }),
    JSON.stringify({ v: 1, publicKey: stored.publicKey }),
    JSON.stringify({ v: 1, publicKey: stored.publicKey.toUpperCase(), secretKey: stored.secretKey }),
    JSON.stringify({ v: 1, publicKey: stored.publicKey, secretKey: stored.secretKey.slice(2) })
  ]
  for (const text of garbage) {
    const bad = path.join(dir, 'bad.json')
    fs.writeFileSync(bad, text)
    t.exception(() => cert.loadKeyPairFile(bad), /arquivo de chave inválido/)
    t.exception(() => cert.loadAssociationKeyPair(bad), /chave da associação inválida/)
  }
})

test('saveKeyPairFile: no clobber by default, overwrite on request, private dir', async (t) => {
  await testnet(t)
  const dir = path.join(tmpDir(t), 'keys')
  fs.mkdirSync(dir, { mode: 0o755 })
  fs.chmodSync(dir, 0o755)
  const file = path.join(dir, 'seeder-key.json')
  const kp1 = cert.generateAssociationKeyPair()
  const kp2 = cert.generateAssociationKeyPair()
  cert.saveKeyPairFile(file, kp1)
  t.is(fs.statSync(dir).mode & 0o077, 0)
  try {
    cert.saveKeyPairFile(file, kp2)
    t.fail('should throw')
  } catch (err) {
    t.is(err.code, 'EEXIST')
    t.is(err.message, 'arquivo de chave já existe')
  }
  t.ok(b4a.equals(cert.loadKeyPairFile(file).publicKey, kp1.publicKey))
  cert.saveKeyPairFile(file, kp2, { overwrite: true })
  t.ok(b4a.equals(cert.loadKeyPairFile(file).publicKey, kp2.publicKey))
  t.is(fs.statSync(file).mode & 0o077, 0)
  t.alike(fs.readdirSync(dir), ['seeder-key.json'])
})

test('key files: a symlinked key file or directory is refused', async (t) => {
  await testnet(t)
  const outside = tmpDir(t)
  const realDir = path.join(outside, 'real')
  const realFile = path.join(realDir, 'key.json')
  const kp = cert.generateAssociationKeyPair()
  cert.saveKeyPairFile(realFile, kp)
  const before = fs.readFileSync(realFile, 'utf8')
  fs.chmodSync(realDir, 0o755)

  // planted symlink as the key file: never followed on read
  const dir = tmpDir(t)
  const linked = path.join(dir, 'key.json')
  fs.symlinkSync(realFile, linked)
  t.exception(() => cert.loadKeyPairFile(linked), /arquivo de chave inválido/)
  t.exception(() => cert.loadAssociationKeyPair(linked), /chave da associação inválida/)

  // planted symlink as the directory: refused on save and on load
  const linkDir = path.join(tmpDir(t), 'keys')
  fs.symlinkSync(realDir, linkDir)
  t.exception(() => cert.saveKeyPairFile(path.join(linkDir, 'other.json'), kp), /diretório é um link simbólico/)
  t.exception(() => cert.saveKeyPairFile(path.join(linkDir, 'key.json'), kp, { overwrite: true }), /diretório é um link simbólico/)
  t.exception(() => cert.loadKeyPairFile(path.join(linkDir, 'key.json')), /diretório é um link simbólico/)

  t.is(fs.readFileSync(realFile, 'utf8'), before, 'target key untouched')
  t.alike(fs.readdirSync(realDir), ['key.json'], 'nothing written in the target dir')
  t.is(fs.statSync(realDir).mode & 0o777, 0o755, 'target dir mode untouched')
  // a missing key file keeps its ENOENT code
  try {
    cert.loadKeyPairFile(path.join(dir, 'missing.json'))
    t.fail('should throw')
  } catch (err) {
    t.is(err.code, 'ENOENT')
  }
})

test('key files: a FIFO at the key path is rejected at once', async (t) => {
  await testnet(t)
  const dir = tmpDir(t)
  const fifo = path.join(dir, 'key.json')
  const made = spawnSync('mkfifo', [fifo])
  if (made.error || made.status !== 0) {
    t.comment('mkfifo unavailable: FIFO test skipped')
    t.pass('skipped')
    return
  }
  // Nobody ever writes to the FIFO: without O_NONBLOCK the open would hang.
  const started = Date.now()
  t.exception(() => cert.loadKeyPairFile(fifo), /arquivo de chave inválido/)
  t.exception(() => cert.loadAssociationKeyPair(fifo), /chave da associação inválida/)
  t.ok(Date.now() - started < 2000, 'rejected immediately')
  t.ok(fs.lstatSync(fifo).isFIFO(), 'FIFO untouched')
})

// Issuer certificate, member certificate v2 and the username record
// (docs/protocol.md section 3). Fixed seeds make Ed25519 deterministic, so the
// signatures below are golden vectors shared with the protocol document.
const ASSOC_SEED = b4a.alloc(32, 1)
const ISSUER_SEED = b4a.alloc(32, 2)
const GOLDEN_ASSOC = '8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c'
const GOLDEN_ISSUER = '8139770ea87d175f56a35466c34c7ecccb8d8a91b4ee37a25df60f5b8fc9b394'
const ISSUER_DATE = '2026-10-24T00:00:00.000Z'
const ISSUED_DATE = '2026-10-24T12:00:00.000Z'
const GOLDEN_ISSUER_SIG = '7e06f2e675e84ea405dba956c8bb54f3a2e070c4bfb2803a067f1b9215fae89a76b4cb2a8b1137c1fec106e14cf25a390a58f1e7a0757d762c7cb1c9d9faf50d'
const GOLDEN_V2_SIG = '3e9041b0a15d3ab5066697e6998be04a0a6599dee997649c51ff7420a80238742b258fffc06c29861c65a18bbad04b792b6bb31d9621f2b530319c40d6777605'
const GOLDEN_USERNAME_SIG = '43d469145321e09697cbd68cad520105d594941d173f236c35ca6e9460f2a67d4541990b253f3a0c4544900cb72bf15b8e490b17604081826c88ba4967c42500'

function golden () {
  const assocKp = crypto.keyPair(ASSOC_SEED)
  const issuerKp = crypto.keyPair(ISSUER_SEED)
  const issuerCert = cert.createIssuerCert({ issuer: GOLDEN_ISSUER, date: ISSUER_DATE }, assocKp)
  return { assocKp, issuerKp, issuerCert }
}

function issued () {
  const { kp: assocKp, assocHex } = fixture()
  const issuerKp = crypto.keyPair()
  const issuerCert = cert.createIssuerCert({ issuer: b4a.toString(issuerKp.publicKey, 'hex'), date: ISSUER_DATE }, assocKp)
  return { assocKp, assocHex, issuerKp, issuerCert }
}

test('issuer certificate golden vector', async (t) => {
  await testnet(t)
  const { assocKp, issuerKp, issuerCert } = golden()
  t.is(b4a.toString(assocKp.publicKey, 'hex'), GOLDEN_ASSOC)
  t.is(b4a.toString(issuerKp.publicKey, 'hex'), GOLDEN_ISSUER)
  t.alike(issuerCert, { v: 1, issuer: GOLDEN_ISSUER, date: ISSUER_DATE, association: GOLDEN_ASSOC, signature: GOLDEN_ISSUER_SIG })
  t.alike(Object.keys(issuerCert), ['v', 'issuer', 'date', 'association', 'signature'])
  const expected = b4a.from('varanda-issuer-v1' + LF + GOLDEN_ISSUER + LF + ISSUER_DATE + LF + GOLDEN_ASSOC, 'utf8')
  t.ok(b4a.equals(cert.issuerCertPayload(issuerCert), expected))
  t.is(cert.validateIssuerCertShape(issuerCert), null)
  t.alike(cert.verifyIssuerCert(issuerCert, GOLDEN_ASSOC), { ok: true })
  t.alike(cert.verifyIssuerCert(issuerCert, GOLDEN_ASSOC.toUpperCase()), { ok: true })
})

test('issuer certificate rejections', async (t) => {
  await testnet(t)
  const { assocKp, assocHex, issuerCert } = issued()
  const other = fixture()
  t.alike(cert.verifyIssuerCert({ ...issuerCert, date: '2026-10-25T00:00:00.000Z' }, assocHex), { ok: false, reason: 'bad-signature' })
  t.alike(cert.verifyIssuerCert({ ...issuerCert, signature: 'ab'.repeat(64) }, assocHex), { ok: false, reason: 'bad-signature' })
  t.alike(cert.verifyIssuerCert(issuerCert, other.assocHex), { ok: false, reason: 'untrusted-association' })
  // issuer === association is malformed, whatever the signature
  const self = { ...issuerCert, issuer: assocHex }
  t.is(cert.validateIssuerCertShape(self), 'malformed')
  t.alike(cert.verifyIssuerCert(self, assocHex), { ok: false, reason: 'malformed' })
  t.exception.all(() => cert.createIssuerCert({ issuer: assocHex }, assocKp), TypeError)
  t.exception.all(() => cert.createIssuerCert({ issuer: 'abc' }, assocKp), TypeError)
  t.exception.all(() => cert.createIssuerCert({ issuer: MEMBER, date: '2026-10-24T00:00:00Z' }, assocKp), TypeError)
  const without = { ...issuerCert }
  delete without.date
  const variants = {
    'missing key': without,
    'extra key': { ...issuerCert, extra: 1 },
    'v 2': { ...issuerCert, v: 2 },
    'uppercase issuer': { ...issuerCert, issuer: issuerCert.issuer.toUpperCase() },
    'uppercase signature': { ...issuerCert, signature: issuerCert.signature.toUpperCase() },
    'date without milliseconds': { ...issuerCert, date: '2026-10-24T00:00:00Z' },
    'a seeder certificate': { v: 1, seeder: issuerCert.issuer, date: issuerCert.date, association: assocHex, signature: issuerCert.signature }
  }
  for (const [name, v] of Object.entries(variants)) {
    t.is(cert.validateIssuerCertShape(v), 'malformed', name + ' shape')
    t.alike(cert.verifyIssuerCert(v, assocHex), { ok: false, reason: 'malformed' }, name)
  }
  // domain separation: a seeder signature over the same key and date is not an issuer signature
  const seeder = cert.createSeederCert({ seeder: issuerCert.issuer, date: ISSUER_DATE }, assocKp)
  t.alike(cert.verifyIssuerCert({ ...issuerCert, signature: seeder.signature }, assocHex), { ok: false, reason: 'bad-signature' })
})

test('member certificate v2 golden vector', async (t) => {
  await testnet(t)
  const { issuerKp, issuerCert } = golden()
  const c = cert.createIssuedCert({ member: MEMBER.toUpperCase(), date: ISSUED_DATE }, issuerKp, issuerCert)
  t.alike(Object.keys(c), ['v', 'member', 'ageBand', 'method', 'date', 'association', 'issuer', 'issuerDate', 'issuerSignature', 'signature'])
  t.alike(c, {
    v: 2,
    member: MEMBER,
    ageBand: 'unchecked',
    method: 'google',
    date: ISSUED_DATE,
    association: GOLDEN_ASSOC,
    issuer: GOLDEN_ISSUER,
    issuerDate: ISSUER_DATE,
    issuerSignature: GOLDEN_ISSUER_SIG,
    signature: GOLDEN_V2_SIG
  })
  const expected = b4a.from([
    'varanda-cert-v2', MEMBER, 'unchecked', 'google', ISSUED_DATE, GOLDEN_ASSOC, GOLDEN_ISSUER, ISSUER_DATE, GOLDEN_ISSUER_SIG
  ].join(LF), 'utf8')
  t.ok(b4a.equals(cert.certPayloadV2(c), expected))
  t.is(cert.validateCertShape(c), null)
  t.alike(cert.verifyCert(c, GOLDEN_ASSOC), { ok: true })
  t.alike(cert.certForKey(c, MEMBER, GOLDEN_ASSOC), { ok: true })
  t.alike(cert.certForKey(c, 'cd'.repeat(32), GOLDEN_ASSOC), { ok: false, reason: 'member-mismatch' })
})

test('member certificate v2 rejections', async (t) => {
  await testnet(t)
  const { assocKp, assocHex, issuerKp, issuerCert } = issued()
  const other = fixture()
  const c = cert.createIssuedCert({ member: MEMBER, date: ISSUED_DATE }, issuerKp, issuerCert)
  t.alike(cert.verifyCert(c, assocHex), { ok: true })

  const without = { ...c }
  delete without.issuerDate
  const malformed = {
    'missing key': without,
    'extra key': { ...c, extra: 1 },
    'v 1 with v2 keys': { ...c, v: 1 },
    'v 3': { ...c, v: 3 },
    'ageBand 18+': { ...c, ageBand: '18+' },
    'method stub': { ...c, method: 'stub' },
    'issuer equal to association': { ...c, issuer: c.association },
    'uppercase issuer': { ...c, issuer: c.issuer.toUpperCase() },
    'uppercase issuerSignature': { ...c, issuerSignature: c.issuerSignature.toUpperCase() },
    'truncated signature': { ...c, signature: c.signature.slice(2) },
    'issuerDate without milliseconds': { ...c, issuerDate: '2026-10-24T00:00:00Z' },
    'invalid month': { ...c, date: '2026-13-01T00:00:00.000Z' },
    'a username key': { ...c, username: 'ana' }
  }
  for (const [name, v] of Object.entries(malformed)) {
    t.is(cert.validateCertShape(v), 'malformed', name + ' shape')
    t.alike(cert.verifyCert(v, assocHex), { ok: false, reason: 'malformed' }, name)
    t.alike(cert.certForKey(v, MEMBER, assocHex), { ok: false, reason: 'malformed' }, name + ' certForKey')
  }

  t.alike(cert.verifyCert(c, other.assocHex), { ok: false, reason: 'untrusted-association' })
  t.alike(cert.certForKey(c, MEMBER, other.assocHex), { ok: false, reason: 'untrusted-association' })
  t.alike(cert.verifyCert(c, 'zz'), { ok: false, reason: 'malformed' })

  // The delegation must verify: a swapped issuerSignature, another
  // issuerDate, or a delegation from another association relabelled as ours.
  const sibling = cert.createIssuerCert({ issuer: issuerCert.issuer, date: '2026-10-25T00:00:00.000Z' }, assocKp)
  t.alike(cert.verifyCert({ ...c, issuerSignature: sibling.signature }, assocHex), { ok: false, reason: 'bad-issuer-signature' })
  t.alike(cert.verifyCert({ ...c, issuerDate: '2026-10-25T00:00:00.000Z' }, assocHex), { ok: false, reason: 'bad-issuer-signature' })
  const foreign = cert.createIssuerCert({ issuer: issuerCert.issuer, date: ISSUER_DATE }, other.kp)
  const relabelled = cert.createIssuedCert({ member: MEMBER, date: ISSUED_DATE }, issuerKp, foreign)
  t.alike(cert.verifyCert({ ...relabelled, association: assocHex }, assocHex), { ok: false, reason: 'bad-issuer-signature' })
  t.alike(cert.verifyCert(relabelled, other.assocHex), { ok: true })

  // The issuer's own signature.
  t.alike(cert.verifyCert({ ...c, date: '2026-10-25T00:00:00.000Z' }, assocHex), { ok: false, reason: 'bad-signature' })
  t.alike(cert.verifyCert({ ...c, member: 'cd'.repeat(32) }, assocHex), { ok: false, reason: 'bad-signature' })
  // signed by the association instead of the issuer
  const byAssoc = { ...c, signature: b4a.toString(crypto.sign(cert.certPayloadV2(c), assocKp.secretKey), 'hex') }
  t.alike(cert.verifyCert(byAssoc, assocHex), { ok: false, reason: 'bad-signature' })
  // a v1 signature over the same member and date never passes as a v2 one
  const v1 = cert.createCert({ member: MEMBER, date: ISSUED_DATE }, assocKp)
  t.alike(cert.verifyCert({ ...c, signature: v1.signature }, assocHex), { ok: false, reason: 'bad-signature' })

  // Verdict order.
  t.alike(cert.certForKey({ ...c, method: 'stub' }, 'cd'.repeat(32), other.assocHex), { ok: false, reason: 'malformed' })
  t.alike(cert.certForKey(c, 'cd'.repeat(32), other.assocHex), { ok: false, reason: 'member-mismatch' })
  t.alike(cert.verifyCert({ ...c, issuerSignature: sibling.signature }, other.assocHex), { ok: false, reason: 'untrusted-association' })
  t.alike(cert.verifyCert({ ...c, issuerSignature: sibling.signature, date: '2026-10-25T00:00:00.000Z' }, assocHex), { ok: false, reason: 'bad-issuer-signature' })
})

test('createIssuedCert and createUsernameRecord refuse a foreign or invalid issuer certificate', async (t) => {
  await testnet(t)
  const { issuerKp, issuerCert } = issued()
  const stranger = crypto.keyPair()
  for (const fn of [
    () => cert.createIssuedCert({ member: MEMBER }, stranger, issuerCert),
    () => cert.createIssuedCert({ member: MEMBER }, issuerKp, { ...issuerCert, signature: 'ab'.repeat(64) }),
    () => cert.createIssuedCert({ member: MEMBER }, issuerKp, { ...issuerCert, extra: 1 }),
    () => cert.createIssuedCert({ member: MEMBER }, issuerKp, null),
    () => cert.createIssuedCert({ member: 'abc' }, issuerKp, issuerCert),
    () => cert.createIssuedCert({ member: MEMBER, date: '2026-10-24' }, issuerKp, issuerCert),
    () => cert.createIssuedCert({ member: MEMBER }, { publicKey: issuerKp.publicKey, secretKey: b4a.alloc(32) }, issuerCert),
    () => cert.createUsernameRecord({ member: MEMBER, username: 'ana' }, stranger, issuerCert),
    () => cert.createUsernameRecord({ member: MEMBER, username: 'Ana' }, issuerKp, issuerCert),
    () => cert.createUsernameRecord({ member: MEMBER, username: 'abc123' }, issuerKp, issuerCert),
    () => cert.createUsernameRecord({ member: 'abc', username: 'ana' }, issuerKp, issuerCert)
  ]) {
    t.exception.all(fn, TypeError)
  }
  const c = cert.createIssuedCert({ member: MEMBER }, issuerKp, issuerCert)
  t.alike(cert.verifyCert(c, issuerCert.association), { ok: true })
})

test('usernames', async (t) => {
  await testnet(t)
  t.ok(cert.USERNAME_RE instanceof RegExp)
  for (const ok of ['ana', 'ana_maria', 'a1_', 'z' + 'x'.repeat(19), 'abcdeg', 'abc12', 'abc1234', 'gabcde']) {
    t.ok(cert.isUsername(ok), ok)
  }
  const bad = [
    'Ana', 'ANA', '1ana', '_ana', 'an', 'a'.repeat(21), 'ana-maria', 'ana maria', 'aná', '',
    'abc123', 'deadbe', 'facade', 'beef00', null, 5, ['ana']
  ]
  for (const no of bad) {
    t.absent(cert.isUsername(no), JSON.stringify(no))
  }
})

test('username record golden vector and verification', async (t) => {
  await testnet(t)
  const { issuerKp, issuerCert } = golden()
  const r = cert.createUsernameRecord({ member: MEMBER, username: 'ana_maria', date: ISSUED_DATE }, issuerKp, issuerCert)
  t.alike(Object.keys(r), ['type', 'username', 'member', 'date', 'association', 'issuer', 'issuerDate', 'issuerSignature', 'signature'])
  t.alike(r, {
    type: 'username',
    username: 'ana_maria',
    member: MEMBER,
    date: ISSUED_DATE,
    association: GOLDEN_ASSOC,
    issuer: GOLDEN_ISSUER,
    issuerDate: ISSUER_DATE,
    issuerSignature: GOLDEN_ISSUER_SIG,
    signature: GOLDEN_USERNAME_SIG
  })
  const expected = b4a.from([
    'varanda-username-v1', 'ana_maria', MEMBER, ISSUED_DATE, GOLDEN_ASSOC, GOLDEN_ISSUER, ISSUER_DATE, GOLDEN_ISSUER_SIG
  ].join(LF), 'utf8')
  t.ok(b4a.equals(cert.usernameRecordPayload(r), expected))
  t.is(cert.validateUsernameRecordShape(r), null)
  t.alike(cert.verifyUsernameRecord(r, MEMBER, GOLDEN_ASSOC), { ok: true })
  t.alike(cert.verifyUsernameRecord(r, MEMBER.toUpperCase(), GOLDEN_ASSOC.toUpperCase()), { ok: true })
})

test('username record rejections', async (t) => {
  await testnet(t)
  const { assocKp, assocHex, issuerKp, issuerCert } = issued()
  const other = fixture()
  const r = cert.createUsernameRecord({ member: MEMBER, username: 'ana', date: ISSUED_DATE }, issuerKp, issuerCert)
  t.alike(cert.verifyUsernameRecord(r, MEMBER, assocHex), { ok: true })

  const without = { ...r }
  delete without.issuer
  const malformed = {
    'missing key': without,
    'extra key': { ...r, extra: 1 },
    'wrong type': { ...r, type: 'profile' },
    'uppercase username': { ...r, username: 'Ana' },
    'leading digit': { ...r, username: '1ana' },
    '6-hex username': { ...r, username: 'abc123' },
    'issuer equal to association': { ...r, issuer: r.association },
    'uppercase member': { ...r, member: MEMBER.toUpperCase() },
    'short signature': { ...r, signature: r.signature.slice(2) },
    'bad date': { ...r, date: '2026-13-01T00:00:00.000Z' }
  }
  for (const [name, v] of Object.entries(malformed)) {
    t.is(cert.validateUsernameRecordShape(v), 'malformed', name + ' shape')
    t.alike(cert.verifyUsernameRecord(v, MEMBER, assocHex), { ok: false, reason: 'malformed' }, name)
  }
  t.alike(cert.verifyUsernameRecord(r, 'cd'.repeat(32), assocHex), { ok: false, reason: 'member-mismatch' })
  t.alike(cert.verifyUsernameRecord(r, null, assocHex), { ok: false, reason: 'member-mismatch' })
  t.alike(cert.verifyUsernameRecord(r, MEMBER, other.assocHex), { ok: false, reason: 'untrusted-association' })
  t.alike(cert.verifyUsernameRecord(r, MEMBER, 'zz'), { ok: false, reason: 'malformed' })
  const sibling = cert.createIssuerCert({ issuer: issuerCert.issuer, date: '2026-10-25T00:00:00.000Z' }, assocKp)
  t.alike(cert.verifyUsernameRecord({ ...r, issuerSignature: sibling.signature }, MEMBER, assocHex), { ok: false, reason: 'bad-issuer-signature' })
  t.alike(cert.verifyUsernameRecord({ ...r, username: 'bia' }, MEMBER, assocHex), { ok: false, reason: 'bad-signature' })
  t.alike(cert.verifyUsernameRecord({ ...r, member: 'cd'.repeat(32) }, 'cd'.repeat(32), assocHex), { ok: false, reason: 'bad-signature' })
  // a v2 certificate signature is never a username record signature
  const c = cert.createIssuedCert({ member: MEMBER, date: ISSUED_DATE }, issuerKp, issuerCert)
  t.alike(cert.verifyUsernameRecord({ ...r, signature: c.signature }, MEMBER, assocHex), { ok: false, reason: 'bad-signature' })
  // a username record is not a membership certificate
  t.alike(cert.verifyCert(r, assocHex), { ok: false, reason: 'malformed' })
})

test('v2, issuer and username verifiers never throw', async (t) => {
  await testnet(t)
  const { assocHex, issuerKp, issuerCert } = issued()
  const c = cert.createIssuedCert({ member: MEMBER }, issuerKp, issuerCert)
  const r = cert.createUsernameRecord({ member: MEMBER, username: 'ana' }, issuerKp, issuerCert)
  function hostileOf (o) {
    const h = {}
    for (const k of Object.keys(o)) {
      Object.defineProperty(h, k, { enumerable: true, get () { throw new Error('boom') } })
    }
    return h
  }
  const revoked = Proxy.revocable({}, {})
  revoked.revoke()
  const inputs = [null, undefined, 0, 'x', [], Object.create(null), revoked.proxy, hostileOf(c), hostileOf(r), hostileOf(issuerCert), { ...c, date: 5 }, { ...r, username: 5 }]
  for (const v of inputs) {
    t.execution(() => {
      if (cert.verifyCert(v, assocHex).ok) throw new Error('verifyCert accepted')
      if (cert.certForKey(v, MEMBER, assocHex).ok) throw new Error('certForKey accepted')
      if (cert.validateCertShape(v) !== 'malformed') throw new Error('validateCertShape accepted')
      if (cert.verifyIssuerCert(v, assocHex).ok) throw new Error('verifyIssuerCert accepted')
      if (cert.validateIssuerCertShape(v) !== 'malformed') throw new Error('validateIssuerCertShape accepted')
      if (cert.verifyUsernameRecord(v, MEMBER, assocHex).ok) throw new Error('verifyUsernameRecord accepted')
      if (cert.validateUsernameRecordShape(v) !== 'malformed') throw new Error('validateUsernameRecordShape accepted')
    })
  }
  t.alike(cert.verifyIssuerCert(issuerCert, null), { ok: false, reason: 'malformed' })
  t.alike(cert.verifyCert(c, null), { ok: false, reason: 'malformed' })
  t.alike(cert.verifyUsernameRecord(r, MEMBER, null), { ok: false, reason: 'malformed' })
})

// Moderator certificate (docs/protocol.md section 3): moderator seed = 32
// bytes 0x03, certified by the golden association.
const MODERATOR_SEED = b4a.alloc(32, 3)
const GOLDEN_MODERATOR = 'ed4928c628d1c2c6eae90338905995612959273a5c63f93636c14614ac8737d1'
const GOLDEN_MODERATOR_SIG = '00c028052fd43e7518b5825298baf5ef2d194670421b6422c4211f3b1d3f9a2839b6cec54e628c416c8367191a69628bc2e3db5d4263781df11de781fbe9920d'

test('moderator certificate golden vector', async (t) => {
  await testnet(t)
  const { assocKp } = golden()
  const modKp = crypto.keyPair(MODERATOR_SEED)
  t.is(b4a.toString(modKp.publicKey, 'hex'), GOLDEN_MODERATOR)
  const m = cert.createModeratorCert({ moderator: GOLDEN_MODERATOR.toUpperCase(), date: ISSUER_DATE }, assocKp)
  t.alike(Object.keys(m), ['v', 'moderator', 'date', 'association', 'signature'])
  t.alike(m, { v: 1, moderator: GOLDEN_MODERATOR, date: ISSUER_DATE, association: GOLDEN_ASSOC, signature: GOLDEN_MODERATOR_SIG })
  const expected = b4a.from('varanda-moderator-v1' + LF + GOLDEN_MODERATOR + LF + ISSUER_DATE + LF + GOLDEN_ASSOC, 'utf8')
  t.ok(b4a.equals(cert.moderatorCertPayload(m), expected))
  t.is(cert.validateModeratorCertShape(m), null)
  t.alike(cert.verifyModeratorCert(m, GOLDEN_ASSOC), { ok: true })
  t.alike(cert.verifyModeratorCert(m, GOLDEN_ASSOC.toUpperCase()), { ok: true })
})

test('moderator certificate rejections', async (t) => {
  await testnet(t)
  const { kp: assocKp, assocHex } = fixture()
  const other = fixture()
  const moderator = 'ef'.repeat(32)
  const m = cert.createModeratorCert({ moderator, date: DATE }, assocKp)
  t.alike(cert.verifyModeratorCert(m, assocHex), { ok: true })

  const without = { ...m }
  delete without.date
  const malformed = {
    'missing key': without,
    'extra key': { ...m, extra: 1 },
    'v 2': { ...m, v: 2 },
    'moderator equal to association': { ...m, moderator: m.association },
    'uppercase moderator': { ...m, moderator: moderator.toUpperCase() },
    'short signature': { ...m, signature: m.signature.slice(2) },
    'bad date': { ...m, date: '2026-13-01T00:00:00.000Z' }
  }
  for (const [name, v] of Object.entries(malformed)) {
    t.is(cert.validateModeratorCertShape(v), 'malformed', name + ' shape')
    t.alike(cert.verifyModeratorCert(v, assocHex), { ok: false, reason: 'malformed' }, name)
  }
  t.alike(cert.verifyModeratorCert(m, 'zz'), { ok: false, reason: 'malformed' })
  t.alike(cert.verifyModeratorCert(m, null), { ok: false, reason: 'malformed' })
  t.alike(cert.verifyModeratorCert(m, other.assocHex), { ok: false, reason: 'untrusted-association' })
  t.alike(cert.verifyModeratorCert({ ...m, date: '2026-10-25T00:00:00.000Z' }, assocHex), { ok: false, reason: 'bad-signature' })
  // domain separation: the association's issuer or seeder signature over the
  // same key and date is never a moderator signature, and vice versa
  const issuerCert = cert.createIssuerCert({ issuer: moderator, date: DATE }, assocKp)
  t.alike(cert.verifyModeratorCert({ ...m, signature: issuerCert.signature }, assocHex), { ok: false, reason: 'bad-signature' })
  const seederCert = cert.createSeederCert({ seeder: moderator, date: DATE }, assocKp)
  t.alike(cert.verifyModeratorCert({ ...m, signature: seederCert.signature }, assocHex), { ok: false, reason: 'bad-signature' })
  t.alike(cert.verifyIssuerCert({ v: 1, issuer: moderator, date: DATE, association: assocHex, signature: m.signature }, assocHex), { ok: false, reason: 'bad-signature' })
  // createModeratorCert refuses bad input and the association as moderator
  t.exception.all(() => cert.createModeratorCert({ moderator: 'zz', date: DATE }, assocKp), /moderator/)
  t.exception.all(() => cert.createModeratorCert({ moderator, date: 'yesterday' }, assocKp), /date/)
  t.exception.all(() => cert.createModeratorCert({ moderator: assocHex, date: DATE }, assocKp), /differ/)
  t.exception.all(() => cert.createModeratorCert({ moderator, date: DATE }, {}), /key pair/)
  // never throws
  const revoked = Proxy.revocable({}, {})
  revoked.revoke()
  const hostile = {}
  for (const k of Object.keys(m)) Object.defineProperty(hostile, k, { enumerable: true, get () { throw new Error('boom') } })
  for (const v of [null, undefined, 0, 'x', [], Object.create(null), revoked.proxy, hostile]) {
    t.execution(() => {
      if (cert.verifyModeratorCert(v, assocHex).ok) throw new Error('verifyModeratorCert accepted')
      if (cert.validateModeratorCertShape(v) !== 'malformed') throw new Error('validateModeratorCertShape accepted')
    })
  }
})

test('revoked issuers: v2 certificates and username records fail, v1 unaffected', async (t) => {
  await testnet(t)
  const { kp: assocKp, assocHex } = fixture()
  const issuerKp = crypto.keyPair()
  const issuerHex = b4a.toString(issuerKp.publicKey, 'hex')
  const issuerCert = cert.createIssuerCert({ issuer: issuerHex, date: ISSUER_DATE }, assocKp)
  const c = cert.createIssuedCert({ member: MEMBER, date: ISSUED_DATE }, issuerKp, issuerCert)
  const r = cert.createUsernameRecord({ member: MEMBER, username: 'ana', date: ISSUED_DATE }, issuerKp, issuerCert)
  const v1 = cert.createCert({ member: MEMBER, date: DATE }, assocKp)
  const revokedIssuers = new Set([issuerHex])

  t.alike(cert.verifyCert(c, assocHex, { revokedIssuers }), { ok: false, reason: 'revoked-issuer' })
  t.alike(cert.certForKey(c, MEMBER, assocHex, { revokedIssuers }), { ok: false, reason: 'revoked-issuer' })
  t.alike(cert.verifyUsernameRecord(r, MEMBER, assocHex, { revokedIssuers }), { ok: false, reason: 'revoked-issuer' })
  // another issuer revoked, an empty set, no options or junk options: B1 verdicts
  const unaffected = [{ revokedIssuers: new Set(['cd'.repeat(32)]) }, { revokedIssuers: new Set() }, undefined, null, {}, { revokedIssuers: 5 }, 'x']
  for (const opts of unaffected) {
    t.alike(cert.verifyCert(c, assocHex, opts), { ok: true })
    t.alike(cert.certForKey(c, MEMBER, assocHex, opts), { ok: true })
    t.alike(cert.verifyUsernameRecord(r, MEMBER, assocHex, opts), { ok: true })
  }
  // v1 certificates are signed by the association, never by an issuer
  t.alike(cert.verifyCert(v1, assocHex, { revokedIssuers: new Set([assocHex, issuerHex]) }), { ok: true })
  t.alike(cert.certForKey(v1, MEMBER, assocHex, { revokedIssuers: new Set([assocHex]) }), { ok: true })
  // earlier reasons win: revocation is only claimed for a genuine signature
  t.alike(cert.certForKey(c, 'cd'.repeat(32), assocHex, { revokedIssuers }), { ok: false, reason: 'member-mismatch' })
  t.alike(cert.verifyCert({ ...c, date: DATE }, assocHex, { revokedIssuers }), { ok: false, reason: 'bad-signature' })
  t.alike(cert.verifyUsernameRecord({ ...r, username: 'bia' }, MEMBER, assocHex, { revokedIssuers }), { ok: false, reason: 'bad-signature' })
  // a hostile set never makes a verifier throw
  const hostileSet = { has () { throw new Error('boom') } }
  t.alike(cert.verifyCert(c, assocHex, { revokedIssuers: hostileSet }), { ok: false, reason: 'malformed' })
  t.alike(cert.verifyUsernameRecord(r, MEMBER, assocHex, { revokedIssuers: hostileSet }), { ok: false, reason: 'malformed' })
})
