const fs = require('node:fs')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
const test = require('brittle')
const { testnet, tmpDir } = require('./helpers/net')
const assoc = require('@varanda/core/lib/assoc')
const cert = require('@varanda/core/lib/cert')

const MEMBER = 'ab'.repeat(32)
const ISSUER = 'cd'.repeat(32)
const SEEDER = 'ef'.repeat(32)
const MODERATOR = '12'.repeat(32)

function secretHex (dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'association.json'), 'utf8')).secretKey
}

test('init then show returns the same public key', async (t) => {
  await testnet(t)
  const dir = path.join(tmpDir(t), 'assoc')
  const created = assoc.initAssociation(dir)
  t.is(created.publicKey.length, 64)
  t.alike(assoc.showAssociation(dir), created)
  t.is(fs.statSync(path.join(dir, 'association.json')).mode & 0o077, 0)
})

test('second init and show on an empty dir fail with codes', async (t) => {
  await testnet(t)
  const dir = tmpDir(t)
  const empty = tmpDir(t)
  assoc.initAssociation(dir)
  t.exception(() => assoc.initAssociation(dir), /associação já existe/)
  try {
    assoc.initAssociation(dir)
    t.fail('should throw')
  } catch (err) {
    t.is(err.code, 'ALREADY_INITIALIZED')
  }
  try {
    assoc.showAssociation(empty)
    t.fail('should throw')
  } catch (err) {
    t.is(err.code, 'NOT_INITIALIZED')
    t.is(err.message, 'associação não inicializada')
  }
  try {
    assoc.issueCertificate(empty, { member: MEMBER })
    t.fail('should throw')
  } catch (err) {
    t.is(err.code, 'NOT_INITIALIZED')
  }
  try {
    assoc.issueSeederCertificate(empty, { seeder: SEEDER })
    t.fail('should throw')
  } catch (err) {
    t.is(err.code, 'NOT_INITIALIZED')
  }
})

test('issueCertificate verifies and stores only public data', async (t) => {
  await testnet(t)
  const dir = tmpDir(t)
  const { publicKey } = assoc.initAssociation(dir)
  const issued = assoc.issueCertificate(dir, { member: MEMBER })
  t.alike(cert.verifyCert(issued, publicKey), { ok: true })
  t.alike(cert.certForKey(issued, MEMBER, publicKey), { ok: true })
  const text = fs.readFileSync(path.join(dir, 'members.jsonl'), 'utf8')
  t.ok(text.endsWith('\n'))
  const lines = text.split('\n').filter(Boolean)
  t.is(lines.length, 1)
  const entry = JSON.parse(lines[0])
  t.alike(Object.keys(entry).sort(), ['ageBand', 'date', 'member', 'method'])
  t.is(entry.member, MEMBER)
  t.is(entry.date, issued.date)
  const secret = secretHex(dir)
  t.absent(JSON.stringify(issued).includes(secret))
  t.absent(text.includes(secret))
  t.absent(text.includes(issued.signature))
})

test('issueSeederCertificate verifies and stores only seeder and date', async (t) => {
  await testnet(t)
  const dir = tmpDir(t)
  const { publicKey } = assoc.initAssociation(dir)
  const issued = assoc.issueSeederCertificate(dir, { seeder: SEEDER.toUpperCase() })
  t.alike(cert.verifySeederCert(issued, publicKey), { ok: true })
  t.alike(cert.seederCertForKey(issued, SEEDER, publicKey), { ok: true })
  assoc.issueSeederCertificate(dir, { seeder: SEEDER })
  const text = fs.readFileSync(path.join(dir, 'seeders.jsonl'), 'utf8')
  t.ok(text.endsWith('\n'))
  const lines = text.split('\n').filter(Boolean)
  t.is(lines.length, 2)
  const entry = JSON.parse(lines[0])
  t.alike(Object.keys(entry).sort(), ['date', 'seeder'])
  t.is(entry.seeder, SEEDER)
  t.is(entry.date, issued.date)
  const secret = secretHex(dir)
  t.absent(JSON.stringify(issued).includes(secret))
  t.absent(text.includes(secret))
  t.absent(text.includes(issued.signature))
  t.exception.all(() => assoc.issueSeederCertificate(dir, { seeder: 'abc' }), TypeError)
  t.absent(fs.existsSync(path.join(dir, 'members.jsonl')))
})

test('association dir and audit logs are private', async (t) => {
  await testnet(t)
  const dir = path.join(tmpDir(t), 'assoc')
  fs.mkdirSync(dir, { mode: 0o755 })
  fs.chmodSync(dir, 0o755)
  assoc.initAssociation(dir)
  assoc.issueCertificate(dir, { member: MEMBER })
  assoc.issueSeederCertificate(dir, { seeder: SEEDER })
  t.is(fs.statSync(dir).mode & 0o077, 0)
  t.is(fs.statSync(path.join(dir, 'association.json')).mode & 0o077, 0)
  t.is(fs.statSync(path.join(dir, 'members.jsonl')).mode & 0o077, 0)
  t.is(fs.statSync(path.join(dir, 'seeders.jsonl')).mode & 0o077, 0)
  t.alike(fs.readdirSync(dir).sort(), ['association.json', 'members.jsonl', 'seeders.jsonl'])
})

test('planted symlinks at the audit logs, the key file and the dir are refused', async (t) => {
  await testnet(t)
  const outside = tmpDir(t)

  // audit logs: never appended through a symlink
  const dir = tmpDir(t)
  assoc.initAssociation(dir)
  for (const [name, issue] of [
    ['members.jsonl', () => assoc.issueCertificate(dir, { member: MEMBER })],
    ['seeders.jsonl', () => assoc.issueSeederCertificate(dir, { seeder: SEEDER })]
  ]) {
    const target = path.join(outside, 'stolen-' + name)
    fs.writeFileSync(target, 'antes\n', { mode: 0o644 })
    fs.chmodSync(target, 0o644)
    fs.symlinkSync(target, path.join(dir, name))
    t.exception(issue, /link simbólico/)
    t.is(fs.readFileSync(target, 'utf8'), 'antes\n', name + ' target untouched')
    t.is(fs.statSync(target).mode & 0o777, 0o644, name + ' target mode untouched')
    // a dangling link is refused too and never creates its target
    const dangling = path.join(outside, 'dangling-' + name)
    fs.unlinkSync(path.join(dir, name))
    fs.symlinkSync(dangling, path.join(dir, name))
    t.exception(issue, /link simbólico/)
    t.absent(fs.existsSync(dangling))
  }

  // association.json as a symlink to a real key: never read through the link
  const realDir = tmpDir(t)
  assoc.initAssociation(realDir)
  const realKey = path.join(realDir, 'association.json')
  const before = fs.readFileSync(realKey, 'utf8')
  const dir2 = tmpDir(t)
  fs.symlinkSync(realKey, path.join(dir2, 'association.json'))
  t.exception(() => assoc.showAssociation(dir2), /chave da associação inválida/)
  t.exception(() => assoc.issueCertificate(dir2, { member: MEMBER }), /chave da associação inválida/)
  t.absent(fs.existsSync(path.join(dir2, 'members.jsonl')))
  t.is(fs.readFileSync(realKey, 'utf8'), before)

  // the association dir itself as a symlink
  fs.chmodSync(realDir, 0o755)
  const linkDir = path.join(tmpDir(t), 'assoc')
  fs.symlinkSync(realDir, linkDir)
  t.exception(() => assoc.initAssociation(linkDir), /diretório é um link simbólico/)
  t.exception(() => assoc.showAssociation(linkDir), /diretório é um link simbólico/)
  t.exception(() => assoc.issueCertificate(linkDir, { member: MEMBER }), /diretório é um link simbólico/)
  t.exception(() => assoc.issueSeederCertificate(linkDir, { seeder: SEEDER }), /diretório é um link simbólico/)
  t.alike(fs.readdirSync(realDir), ['association.json'], 'nothing written in the target dir')
  t.is(fs.statSync(realDir).mode & 0o777, 0o755, 'target dir mode untouched')
  t.is(fs.readFileSync(realKey, 'utf8'), before)
})

test('a FIFO at an audit log is rejected at once and never written', async (t) => {
  await testnet(t)
  const dir = tmpDir(t)
  assoc.initAssociation(dir)
  const fifo = path.join(dir, 'members.jsonl')
  const made = spawnSync('mkfifo', [fifo])
  if (made.error || made.status !== 0) {
    t.comment('mkfifo unavailable: FIFO test skipped')
    t.pass('skipped')
    return
  }
  // Nobody ever reads the FIFO: without O_NONBLOCK the open would hang.
  const started = Date.now()
  t.exception(() => assoc.issueCertificate(dir, { member: MEMBER }), /registro de auditoria inválido/)
  t.ok(Date.now() - started < 2000, 'rejected immediately')
  t.ok(fs.lstatSync(fifo).isFIFO(), 'FIFO untouched')
})

test('concurrent inits: exactly one wins and its key survives', async (t) => {
  await testnet(t)
  const dir = tmpDir(t)
  const results = await Promise.allSettled([
    Promise.resolve().then(() => assoc.initAssociation(dir)),
    Promise.resolve().then(() => assoc.initAssociation(dir))
  ])
  const ok = results.filter((r) => r.status === 'fulfilled')
  const failed = results.filter((r) => r.status === 'rejected')
  t.is(ok.length, 1)
  t.is(failed.length, 1)
  t.is(failed[0].reason.code, 'ALREADY_INITIALIZED')
  t.is(assoc.showAssociation(dir).publicKey, ok[0].value.publicKey)
})

test('concurrent inits across processes: exactly one wins', async (t) => {
  await testnet(t)
  const dir = tmpDir(t)
  const script = 'const a = require(' + JSON.stringify(require.resolve('@varanda/core/lib/assoc')) + ');' +
    'try { process.stdout.write(JSON.stringify({ ok: a.initAssociation(process.argv[1]).publicKey })) }' +
    ' catch (err) { process.stdout.write(JSON.stringify({ code: err.code })) }'
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script, dir])
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.on('error', reject)
    child.on('close', () => resolve(JSON.parse(out)))
  })
  const results = await Promise.all([run(), run(), run(), run()])
  const winners = results.filter((r) => r.ok)
  t.is(winners.length, 1)
  t.is(results.filter((r) => r.code === 'ALREADY_INITIALIZED').length, 3)
  t.is(assoc.showAssociation(dir).publicKey, winners[0].ok)
  t.alike(fs.readdirSync(dir), ['association.json'])
})

test('planted symlinks never redirect the key write', async (t) => {
  await testnet(t)
  const dir = tmpDir(t)
  const outside = tmpDir(t)
  const tmpTarget = path.join(outside, 'stolen-tmp')
  fs.symlinkSync(tmpTarget, path.join(dir, 'association.json.tmp'))
  const { publicKey } = assoc.initAssociation(dir)
  t.absent(fs.existsSync(tmpTarget))
  t.ok(fs.lstatSync(path.join(dir, 'association.json')).isFile())
  t.is(assoc.showAssociation(dir).publicKey, publicKey)

  const dir2 = tmpDir(t)
  const destTarget = path.join(outside, 'stolen-dest')
  fs.symlinkSync(destTarget, path.join(dir2, 'association.json'))
  try {
    assoc.initAssociation(dir2)
    t.fail('should throw')
  } catch (err) {
    t.is(err.code, 'ALREADY_INITIALIZED')
  }
  t.absent(fs.existsSync(destTarget))
  t.alike(fs.readdirSync(dir2), ['association.json'])
})

test('issueIssuerCertificate verifies and stores only issuer and date, 0o600', async (t) => {
  await testnet(t)
  const dir = tmpDir(t)
  const { publicKey } = assoc.initAssociation(dir)
  const issued = assoc.issueIssuerCertificate(dir, { issuer: ISSUER.toUpperCase() })
  t.alike(cert.verifyIssuerCert(issued, publicKey), { ok: true })
  const file = path.join(dir, 'issuers.jsonl')
  const text = fs.readFileSync(file, 'utf8')
  t.ok(text.endsWith('\n'))
  const lines = text.split('\n').filter(Boolean)
  t.is(lines.length, 1)
  const entry = JSON.parse(lines[0])
  t.alike(Object.keys(entry).sort(), ['date', 'issuer'])
  t.is(entry.issuer, ISSUER)
  t.is(entry.date, issued.date)
  t.is(fs.statSync(file).mode & 0o777, 0o600)
  t.absent(text.includes(secretHex(dir)))
  t.absent(text.includes(issued.signature))
  t.alike(fs.readdirSync(dir).sort(), ['association.json', 'issuers.jsonl'], 'no key generated')
})

test('issueIssuerCertificate refuses the association key, bad input and a missing association', async (t) => {
  await testnet(t)
  const dir = tmpDir(t)
  const { publicKey } = assoc.initAssociation(dir)
  t.exception.all(() => assoc.issueIssuerCertificate(dir, { issuer: publicKey }), /differ/)
  t.exception.all(() => assoc.issueIssuerCertificate(dir, { issuer: 'abc' }), TypeError)
  t.absent(fs.existsSync(path.join(dir, 'issuers.jsonl')))
  try {
    assoc.issueIssuerCertificate(tmpDir(t), { issuer: ISSUER })
    t.fail('should throw')
  } catch (err) {
    t.is(err.code, 'NOT_INITIALIZED')
  }
})

test('assoc certify-issuer CLI: file and stdout carry no secret, missing --issuer is exit 2', async (t) => {
  await testnet(t)
  const dir = tmpDir(t)
  const { publicKey } = assoc.initAssociation(dir)
  const bin = path.join(__dirname, '../bin/varanda.js')
  const run = (...args) => spawnSync(process.execPath, [bin, 'assoc', ...args, '--data', dir], { encoding: 'utf8' })
  // A signature is 128 hex by design, so the check is for the secret key itself.
  const secret = secretHex(dir)

  const missing = run('certify-issuer')
  t.is(missing.status, 2)
  t.ok(missing.stderr.includes('informe --issuer <hex>'))

  const out = path.join(tmpDir(t), 'issuer-cert.json')
  const filed = run('certify-issuer', '--issuer', ISSUER, '--out', out, '--json')
  t.is(filed.status, 0)
  t.absent(filed.stdout.includes(secret))
  const fileText = fs.readFileSync(out, 'utf8')
  t.ok(fileText.endsWith('}\n'))
  t.ok(fileText.includes('\n  "issuer"'), 'pretty JSON')
  t.absent(fileText.includes(secret))
  t.alike(cert.verifyIssuerCert(JSON.parse(fileText), publicKey), { ok: true })

  const plain = run('certify-issuer', '--issuer', ISSUER)
  t.is(plain.status, 0)
  t.is(plain.stdout.split('\n').filter(Boolean).length, 1)
  t.alike(cert.verifyIssuerCert(JSON.parse(plain.stdout), publicKey), { ok: true })
  t.absent(plain.stdout.includes(secret))

  t.not(run('certify-issuer', '--issuer', publicKey).status, 0)
})

test('issueModeratorCertificate verifies and stores only moderator and date, 0o600', async (t) => {
  await testnet(t)
  const dir = tmpDir(t)
  const { publicKey } = assoc.initAssociation(dir)
  const issued = assoc.issueModeratorCertificate(dir, { moderator: MODERATOR.toUpperCase() })
  t.is(issued.moderator, MODERATOR)
  t.alike(cert.verifyModeratorCert(issued, publicKey), { ok: true })
  const file = path.join(dir, 'moderators.jsonl')
  const text = fs.readFileSync(file, 'utf8')
  t.ok(text.endsWith('\n'))
  const lines = text.split('\n').filter(Boolean)
  t.is(lines.length, 1)
  const entry = JSON.parse(lines[0])
  t.alike(Object.keys(entry).sort(), ['date', 'moderator'])
  t.is(entry.moderator, MODERATOR)
  t.is(entry.date, issued.date)
  t.is(fs.statSync(file).mode & 0o777, 0o600)
  t.absent(text.includes(secretHex(dir)))
  t.absent(text.includes(issued.signature))
  t.alike(fs.readdirSync(dir).sort(), ['association.json', 'moderators.jsonl'], 'no key generated')
})

test('issueModeratorCertificate refuses the association key, bad input and a missing association', async (t) => {
  await testnet(t)
  const dir = tmpDir(t)
  const { publicKey } = assoc.initAssociation(dir)
  t.exception.all(() => assoc.issueModeratorCertificate(dir, { moderator: publicKey }), /differ/)
  t.exception.all(() => assoc.issueModeratorCertificate(dir, { moderator: publicKey.toUpperCase() }), /differ/)
  t.exception.all(() => assoc.issueModeratorCertificate(dir, { moderator: 'abc' }), TypeError)
  t.absent(fs.existsSync(path.join(dir, 'moderators.jsonl')))
  try {
    assoc.issueModeratorCertificate(tmpDir(t), { moderator: MODERATOR })
    t.fail('should throw')
  } catch (err) {
    t.is(err.code, 'NOT_INITIALIZED')
  }
})

test('assoc certify-moderator CLI: file and stdout carry no secret, missing --moderator is exit 2', async (t) => {
  await testnet(t)
  const dir = tmpDir(t)
  const { publicKey } = assoc.initAssociation(dir)
  const bin = path.join(__dirname, '../bin/varanda.js')
  const run = (...args) => spawnSync(process.execPath, [bin, 'assoc', ...args, '--data', dir], { encoding: 'utf8' })
  const secret = secretHex(dir)

  const missing = run('certify-moderator')
  t.is(missing.status, 2)
  t.ok(missing.stderr.includes('informe --moderator <hex>'))

  const out = path.join(tmpDir(t), 'moderator-cert.json')
  const filed = run('certify-moderator', '--moderator', MODERATOR, '--out', out, '--json')
  t.is(filed.status, 0)
  t.absent(filed.stdout.includes(secret))
  const fileText = fs.readFileSync(out, 'utf8')
  t.ok(fileText.includes('\n  "moderator"'), 'pretty JSON')
  t.absent(fileText.includes(secret))
  t.alike(cert.verifyModeratorCert(JSON.parse(fileText), publicKey), { ok: true })

  const plain = run('certify-moderator', '--moderator', MODERATOR)
  t.is(plain.status, 0)
  t.is(plain.stdout.split('\n').filter(Boolean).length, 1)
  t.alike(cert.verifyModeratorCert(JSON.parse(plain.stdout), publicKey), { ok: true })
  t.absent(plain.stdout.includes(secret))

  t.not(run('certify-moderator', '--moderator', publicKey).status, 0)
})
