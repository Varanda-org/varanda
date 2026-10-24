'use strict'

// The node session (lib/session.js) without the network: configuration
// checks, every member method through a real dispatcher + client pair,
// log.read invalid-block marking, feed.read caps, the error table, the
// LOCKED error state, the one-shot `recover`, suspend/resume and close.
const test = require('brittle')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { MAX_LIST, RpcError } = require('@varanda/rpc')
const { tmpDir } = require('./helpers/tmp')
const { newSession, connect, failure, scanWire } = require('./helpers/net')
const { createSession, toRpcError, checkConfig, redactLogLine } = require('../lib/session')
const { initAssociation, issueCertificate, issueIssuerCertificate } = require('../lib/assoc')
const { createCert, createUsernameRecord } = require('../lib/cert')
const { Seeder } = require('../lib/seeder')
const { UsageError } = require('../lib/errors')
const { postRecord, validateRecord } = require('../lib/records')
const store = require('../lib/store')

// A bootstrap that is never dialled: these tests start no sync.
const BOOTSTRAP = ['127.0.0.1:49737']

function randomKey () {
  return b4a.toString(crypto.randomBytes(32), 'hex')
}

function association (t) {
  const dir = path.join(tmpDir(t, 'varanda-assoc-'), 'assoc')
  const { publicKey } = initAssociation(dir)
  return { dir, hex: publicKey }
}

function throwsUsage (t, fn, message) {
  try {
    fn()
    t.fail('expected UsageError ' + message)
  } catch (err) {
    t.ok(err instanceof UsageError, 'UsageError: ' + err.message)
    t.is(err.message, message)
  }
}

// A connected session over a fresh member dir (identity and cert optional).
async function member (t, { cert = false, assoc = association(t), opts = {} } = {}) {
  const dataDir = tmpDir(t)
  const session = newSession(t, { dataDir, association: assoc.hex, bootstrap: BOOTSTRAP, ...opts })
  const link = await connect(t, session)
  let publicKey = null
  if (cert) {
    ;({ publicKey } = await link.call('identity.create'))
    t.alike(await link.call('cert.add', { cert: issueCertificate(assoc.dir, { member: publicKey }) }), { seq: 0 })
  }
  return { dataDir, session, assoc, publicKey, ...link }
}

test('config: association, member dir, bootstrap and public DHT', (t) => {
  const assoc = association(t)
  const dataDir = tmpDir(t)
  const base = { dataDir, association: assoc.hex, bootstrap: BOOTSTRAP }

  throwsUsage(t, () => createSession({ ...base, association: undefined }), 'chave da associação inválida')
  throwsUsage(t, () => createSession({ ...base, association: 'ab'.repeat(31) }), 'chave da associação inválida')
  throwsUsage(t, () => createSession({ ...base, association: 'zz'.repeat(32) }), 'chave da associação inválida')
  t.is(checkConfig({ ...base, association: assoc.hex.toUpperCase(), allowPublicDht: false }).association, assoc.hex, 'lowercased')

  throwsUsage(t, () => createSession({ ...base, bootstrap: null }), 'bootstrap inválido (vazio)')
  throwsUsage(t, () => createSession({ ...base, bootstrap: [] }), 'bootstrap inválido (vazio)')
  throwsUsage(t, () => createSession({ ...base, bootstrap: undefined }), 'bootstrap inválido (vazio)')
  throwsUsage(t, () => createSession({ ...base, bootstrap: ['127.0.0.1'] }), 'bootstrap inválido')
  throwsUsage(t, () => createSession({ ...base, bootstrap: ['127.0.0.1:080'] }), 'bootstrap inválido')
  throwsUsage(t, () => createSession({ ...base, bootstrap: [42] }), 'bootstrap inválido')
  throwsUsage(t, () => createSession({ ...base, bootstrap: '127.0.0.1:1' }), 'bootstrap inválido')
  throwsUsage(t, () => createSession({ ...base, allowPublicDht: true }), 'bootstrap e DHT pública são exclusivos')
  throwsUsage(t, () => createSession({ ...base, allowPublicDht: true, bootstrap: [] }), 'bootstrap e DHT pública são exclusivos')
  throwsUsage(t, () => createSession({ ...base, dhtHost: '' }), 'dht-host inválido')
  throwsUsage(t, () => createSession({ ...base, dhtHost: 'a b' }), 'dht-host inválido')
  t.ok(createSession({ ...base, bootstrap: null, allowPublicDht: true }), 'public DHT only when asked for')
  // A DHT bound to loopback never reaches a public peer (issue #10).
  for (const dhtHost of ['127.0.0.1', '127.8.9.10', 'localhost', 'LOCALHOST', '::1', '[::1]']) {
    throwsUsage(t, () => createSession({ ...base, bootstrap: null, allowPublicDht: true, dhtHost }), 'dht-host de loopback e DHT pública são exclusivos')
  }

  // Loopback bootstrap implies the loopback DHT host (V7).
  const cfg = (over) => checkConfig({ ...base, allowPublicDht: false, dhtHost: null, ...over })
  t.is(cfg({ bootstrap: ['127.0.0.1:1', 'localhost:2', '127.8.9.10:3'] }).dhtHost, '127.0.0.1')
  t.is(cfg({ bootstrap: ['127.0.0.1:1', '10.0.0.1:2'] }).dhtHost, null, 'one non-loopback host: no implied host')
  t.is(cfg({ bootstrap: ['127.0.0.300:1'] }).dhtHost, null, 'not an IPv4 address')
  t.is(cfg({ bootstrap: ['127.0.0.1:1'], dhtHost: '192.168.1.5' }).dhtHost, '192.168.1.5', 'an explicit host is kept')
  t.is(cfg({ bootstrap: null, allowPublicDht: true }).dhtHost, null)
  t.is(cfg({ bootstrap: null, allowPublicDht: true, dhtHost: '192.168.1.5' }).dhtHost, '192.168.1.5', 'public DHT: a host that is not loopback is kept')
  t.is(cfg({ bootstrap: ['127.0.0.1:1'], dhtHost: '127.0.0.1' }).dhtHost, '127.0.0.1', 'private bootstrap: a loopback host is kept')
  t.alike(cfg({ bootstrap: ['a.example:5'] }).bootstrap, ['a.example:5'])
})

test('config: seeder and association dirs are refused', (t) => {
  const assoc = association(t)
  const seederDir = tmpDir(t, 'varanda-seed-')
  Seeder.ensureConfig(seederDir, assoc.hex)
  throwsUsage(t, () => createSession({ dataDir: seederDir, association: assoc.hex, bootstrap: BOOTSTRAP }), 'diretório não é de um membro')
  throwsUsage(t, () => createSession({ dataDir: assoc.dir, association: assoc.hex, bootstrap: BOOTSTRAP }), 'diretório não é de um membro')
  const odd = tmpDir(t)
  fs.writeFileSync(path.join(odd, 'config.json'), '{ not json')
  throwsUsage(t, () => createSession({ dataDir: odd, association: assoc.hex, bootstrap: BOOTSTRAP }), 'diretório não é de um membro')
})

test('before an identity: node.info creates nothing, member methods are NOT_FOUND', async (t) => {
  const m = await member(t)
  t.alike(await m.call('node.info'), {
    publicKey: null,
    memberCert: false,
    followCount: 0,
    sync: { state: 'idle' },
    publicDht: false
  })
  const nf = { code: 'NOT_FOUND', message: 'identidade não encontrada' }
  t.alike(await failure(m.call('identity.show')), nf)
  t.alike(await failure(m.call('log.read')), nf)
  t.alike(await failure(m.call('feed.read')), nf)
  t.alike(await failure(m.call('follow.list')), nf)
  t.alike(await failure(m.call('post.create', { text: 'oi' })), nf)
  t.alike(await failure(m.call('sync.start')), nf)
  t.alike(fs.readdirSync(m.dataDir), [], 'nothing was created in the data dir')
  t.alike(await m.call('sync.status'), { state: 'idle' })
})

test('identity, certificate, profile, posts and node.info', async (t) => {
  const m = await member(t)
  const created = await m.call('identity.create')
  t.ok(/^[0-9a-f]{64}$/.test(created.publicKey))
  t.alike(created, { publicKey: created.publicKey, association: m.assoc.hex })
  t.alike(await m.call('identity.create'), created, 'idempotent')
  t.alike(await m.call('identity.show'), created)
  const pk = created.publicKey

  t.alike(await m.call('node.info'), { publicKey: pk, memberCert: false, followCount: 0, sync: { state: 'idle' }, publicDht: false })
  t.alike(await failure(m.call('post.create', { text: 'cedo' })), { code: 'USAGE', message: 'grave o certificado de membro antes de publicar' })
  t.alike(await failure(m.call('profile.set', { name: 'Ana' })), { code: 'USAGE', message: 'grave o certificado de membro antes de publicar' })

  const foreign = crypto.keyPair()
  t.alike(await failure(m.call('cert.add', { cert: createCert({ member: pk }, foreign) })), { code: 'USAGE', message: 'certificado inválido (untrusted-association)' })
  t.alike(await failure(m.call('cert.add', { cert: issueCertificate(m.assoc.dir, { member: randomKey() }) })), { code: 'USAGE', message: 'certificado inválido (member-mismatch)' })
  const cert = issueCertificate(m.assoc.dir, { member: pk })
  t.alike(await m.call('cert.add', { cert }), { seq: 0 })
  t.alike(await m.call('cert.add', { cert }), { seq: 0 }, 'identical block 0: ok')
  const other = issueCertificate(m.assoc.dir, { member: pk, ageBand: '16-17' })
  t.alike(await failure(m.call('cert.add', { cert: other })), { code: 'USAGE', message: 'certificado já gravado' })

  t.alike((await m.call('node.info')).memberCert, true)
  t.alike(await m.call('profile.set', { name: 'Ana', bio: 'oi' }), { seq: 1, ref: pk + ':1' })
  t.alike(await m.call('post.create', { text: 'olá varanda' }), { seq: 2, ref: pk + ':2' })
  t.alike(await m.call('post.reply', { to: pk + ':2', text: 'eu mesma' }), { seq: 3, ref: pk + ':3' })
  t.alike(await failure(m.call('profile.set', { name: 'A\u0007na' })), { code: 'USAGE', message: 'registro inválido: control-chars' })
  t.alike(await failure(m.call('post.create', { text: 'x', extra: 1 })), { code: 'USAGE', message: 'parâmetro desconhecido' })

  const log = await m.call('log.read')
  t.is(log.key, pk)
  t.alike(log.entries.map((e) => e.seq), [0, 1, 2, 3])
  t.alike(log.entries.map((e) => e.record.type), ['member-cert', 'profile', 'post', 'post'])
  t.alike(log.invalid, [])
  t.is(log.entriesTruncated, 0)
  const page = await m.call('log.read', { limit: 2 })
  t.alike(page.entries.map((e) => e.seq), [2, 3], 'the newest blocks')
  t.is(page.entriesTruncated, 2)
  t.alike(await m.call('log.read', { author: pk, limit: 1 }), { key: pk, entries: [log.entries[3]], invalid: [], entriesTruncated: 3 })

  const feed = await m.call('feed.read')
  t.alike(feed.items.map((i) => i.text), ['olá varanda', 'eu mesma'])
  t.is(feed.items[0].name, 'Ana')
  t.alike(feed.items[1].replyTo, { author: pk, seq: 2 })
  t.alike([feed.skipped, feed.skippedTruncated, feed.future, feed.futureTruncated], [[], 0, [], 0])
  t.alike(m.session.internal, [], 'no internal error')
})

test('account.sign is refused by the node session (USAGE, not INTERNAL)', async (t) => {
  const params = { phase: 'reserve', nonce: 'n'.repeat(43), username: 'ana_1', sub: '' }
  const fresh = await member(t)
  t.alike(await failure(fresh.call('account.sign', params)), { code: 'USAGE', message: 'assinatura disponível só no navegador' }, 'before an identity')
  const m = await member(t, { cert: true })
  const before = await m.call('log.read')
  t.alike(await failure(m.call('account.sign', params)), { code: 'USAGE', message: 'assinatura disponível só no navegador' })
  t.alike(await failure(m.call('account.sign', { ...params, phase: 'finish', sub: '1234' })), { code: 'USAGE', message: 'assinatura disponível só no navegador' })
  t.alike(await m.call('log.read'), before, 'nothing written')
  t.alike([fresh.session.internal, m.session.internal], [[], []], 'no internal error')
})

test('username.add: a record that does not verify for the diary key is refused, nothing written', async (t) => {
  const issuerKp = crypto.keyPair()
  const fresh = await member(t)
  const m = await member(t, { cert: true })
  const issuerCert = issueIssuerCertificate(m.assoc.dir, { issuer: b4a.toString(issuerKp.publicKey, 'hex') })
  const BAD = { code: 'USAGE', message: 'registro de nome inválido' }

  const forOther = createUsernameRecord({ member: randomKey(), username: 'ana' }, issuerKp, issuerCert)
  t.alike(await failure(fresh.call('username.add', { record: forOther })), { code: 'NOT_FOUND', message: 'identidade não encontrada' }, 'before an identity')
  const before = await m.call('log.read')
  t.alike(await failure(m.call('username.add', { record: forOther })), BAD, 'a record for another member')
  const tampered = { ...createUsernameRecord({ member: m.publicKey, username: 'ana' }, issuerKp, issuerCert), username: 'bia' }
  t.alike(await failure(m.call('username.add', { record: tampered })), BAD, 'a tampered record')
  t.alike(await failure(m.call('username.add', { record: { type: 'username' } })), BAD, 'a malformed record')
  // The refusal of a record not newer than the diary's latest one (USAGE
  // 'registro de nome antigo') is reached only after a record verifies for
  // the diary key, which a Hypercore diary key normally never does; the
  // verification refusal above comes first and writes nothing either.
  t.alike(await failure(m.call('username.add', { record: { ...forOther, date: '2000-01-01T00:00:00.000Z' } })), BAD, 'an old record for another member')
  t.alike(await m.call('log.read'), before, 'nothing written')
  t.alike([fresh.session.internal, m.session.internal], [[], []], 'no internal error')
})

test('follows: add, remove, list paging, unknown author', async (t) => {
  const m = await member(t, { cert: true })
  t.alike(await failure(m.call('follow.add', { key: m.publicKey })), { code: 'USAGE', message: 'não é possível seguir a própria chave' })
  const keys = [randomKey(), randomKey(), randomKey()]
  t.alike(await m.call('follow.add', { key: keys[0] }), { changed: true, followCount: 1 })
  t.alike(await m.call('follow.add', { key: keys[1] }), { changed: true, followCount: 2 })
  t.alike(await m.call('follow.add', { key: keys[2] }), { changed: true, followCount: 3 })
  t.alike(await m.call('follow.add', { key: keys[0] }), { changed: false, followCount: 3 })
  t.alike(await m.call('follow.remove', { key: keys[1] }), { changed: true, followCount: 2 })
  t.alike(await m.call('follow.remove', { key: keys[1] }), { changed: false, followCount: 2 })
  const kept = [keys[0], keys[2]].sort()
  t.alike(await m.call('follow.list'), { follows: kept, total: 2 })
  t.alike(await m.call('follow.list', { limit: 1 }), { follows: [kept[0]], total: 2 })
  t.alike(await m.call('follow.list', { offset: 1, limit: 1 }), { follows: [kept[1]], total: 2 })
  t.alike(await m.call('follow.list', { offset: 2 }), { follows: [], total: 2 })
  t.alike(await m.call('follow.list', { offset: 99 }), { follows: [], total: 2 })
  t.is((await m.call('node.info')).followCount, 2)
  t.alike(await failure(m.call('log.read', { author: keys[0] })), { code: 'NOT_FOUND', message: 'sem dados locais para este diário' })

  const feed = await m.call('feed.read')
  t.alike(feed.skipped, kept.map((key) => ({ key, reason: 'no-cert' })))
  t.is(feed.skippedTruncated, 0)
})

test('log.read marks invalid blocks with a reason, never their content', async (t) => {
  const m = await member(t, { cert: true })
  await m.call('post.create', { text: 'válido' })
  const badPost = { type: 'post', text: '', at: new Date().toISOString(), replyTo: null }
  // Raw blocks appended through the store, bypassing the record builder.
  const s = await store.openStore(m.dataDir)
  try {
    const raw = s.get({ name: 'diary' })
    await raw.ready()
    await raw.append(b4a.from('{ not json'))
    await raw.append(b4a.from(JSON.stringify(badPost)))
    await raw.append(b4a.from(JSON.stringify(['array'])))
  } finally {
    await s.close()
  }
  const log = await m.call('log.read')
  t.alike(log.entries.map((e) => e.seq), [0, 1])
  t.alike(log.invalid, [
    { seq: 2, reason: 'malformed' },
    { seq: 3, reason: validateRecord(badPost, 3) },
    { seq: 4, reason: 'malformed' }
  ])
  t.ok(log.invalid[1].reason && log.invalid[1].reason !== 'malformed', 'the validateRecord reason')
  const newest = await m.call('log.read', { limit: 2 })
  t.alike(newest, { key: m.publicKey, entries: [], invalid: [{ seq: 3, reason: log.invalid[1].reason }, { seq: 4, reason: 'malformed' }], entriesTruncated: 3 })
})

test('feed.read caps future and reports the cut', async (t) => {
  t.timeout(60000)
  const m = await member(t, { cert: true })
  await m.call('post.create', { text: 'agora' })
  const far = new Date(Date.now() + 30 * 86400000).toISOString()
  const s = await store.openStore(m.dataDir)
  try {
    const diary = await store.openDiary(s)
    for (let i = 0; i < MAX_LIST + 3; i++) await store.appendRecord(diary, postRecord({ text: 'futuro ' + i, at: far }))
  } finally {
    await s.close()
  }
  const feed = await m.call('feed.read', { limit: 1 })
  t.alike(feed.items.map((i) => i.text), ['agora'])
  t.is(feed.future.length, MAX_LIST)
  t.is(feed.futureTruncated, 3)
  t.is(feed.future[0], m.publicKey + ':2')
  t.alike(feed.skipped, [])
  t.is(feed.skippedTruncated, 0)
})

test('toRpcError: the error table, row by row', (t) => {
  const internal = []
  const map = (err) => {
    const e = toRpcError(err, (x) => internal.push(x))
    t.ok(e instanceof RpcError)
    return { code: e.code, message: e.message }
  }
  const plain = (message, code) => {
    const err = new Error(message)
    if (code) err.code = code
    return err
  }
  const usage = [
    'certificado inválido (malformed)',
    'certificado inválido (bad-signature)',
    'certificado já gravado',
    'registro inválido: text-length',
    'grave o certificado de membro antes de publicar',
    'não é possível seguir a própria chave',
    'limite de diários seguidos atingido',
    'limite do diário atingido',
    'diretório não é de um membro',
    'associação diferente da configurada'
  ]
  for (const message of usage) t.alike(map(plain(message)), { code: 'USAGE', message }, message)
  t.alike(map(plain('registro inválido: genesis-required', 'INVALID_RECORD')), { code: 'USAGE', message: 'registro inválido: genesis-required' })
  t.alike(map(new UsageError('referência inválida')), { code: 'USAGE', message: 'referência inválida' })
  t.alike(map(new UsageError('arquivo /etc/x')), { code: 'USAGE', message: 'pedido inválido' }, 'an unsafe UsageError message is replaced')
  t.alike(map(plain('identidade não encontrada')), { code: 'NOT_FOUND', message: 'identidade não encontrada' })
  t.alike(map(plain('sem dados locais para este diário')), { code: 'NOT_FOUND', message: 'sem dados locais para este diário' })
  t.alike(map(plain('diretório de dados em uso', 'LOCKED')), { code: 'LOCKED', message: 'diretório de dados em uso' })
  t.alike(map(plain('lock inválido (não é um diretório): /tmp/x/.varanda-lock', 'LOCK_INVALID')), { code: 'LOCKED', message: 'diretório de dados em uso' })
  t.is(internal.length, 0, 'mapped rows are not internal')

  const storeInvalid = plain('store/ não é um diretório (link simbólico recusado): /tmp/x/store', 'STORE_INVALID')
  const internalRows = [
    storeInvalid,
    plain("ENOENT: no such file or directory, open '/tmp/x'", 'ENOENT'),
    plain('certificado inválido (/etc/passwd)'),
    plain('certificado já gravado', 'EIO'),
    plain('registro inválido: ' + 'a'.repeat(80)),
    plain('something unexpected'),
    plain('USAGE'),
    new TypeError('x is not a function'),
    null,
    undefined,
    'texto',
    42,
    { get code () { throw new Error('hostile') }, get message () { throw new Error('hostile') } }
  ]
  for (const err of internalRows) t.alike(map(err), { code: 'INTERNAL', message: 'erro interno' })
  t.is(internal.length, internalRows.length, 'every INTERNAL row reaches onInternalError')
  t.is(internal[0], storeInvalid, 'with the original error')
  t.alike(toRpcError(plain('x'), () => { throw new Error('host log failed') }).code, 'INTERNAL', 'a throwing onInternalError is ignored')
})

test('an unexpected error is INTERNAL on the wire and reported to the host', async (t) => {
  const m = await member(t)
  // A symlinked store/ is refused by the store with a message carrying a path.
  fs.symlinkSync(tmpDir(t), path.join(m.dataDir, 'store'))
  t.alike(await failure(m.call('identity.create')), { code: 'INTERNAL', message: 'erro interno' })
  t.is(m.session.internal.length, 1)
  t.is(m.session.internal[0].code, 'STORE_INVALID')
  t.is(m.session.state, 'open', 'not an error state')
})

test('LOCKED: another opener holds the dir -> error state for every later request', async (t) => {
  const m = await member(t, { cert: true })
  const other = await store.openStore(m.dataDir)
  let otherOpen = true
  t.teardown(async () => { if (otherOpen) await other.close() }, { force: true })
  const locked = { code: 'LOCKED', message: 'diretório de dados em uso' }
  t.alike(await failure(m.call('post.create', { text: 'bloqueado' })), locked)
  t.is(m.session.state, 'error')
  await other.close()
  otherOpen = false
  t.alike(await failure(m.call('post.create', { text: 'ainda bloqueado' })), locked, 'the error state stays')
  t.alike(await failure(m.call('node.info')), locked)
  t.alike(await failure(m.call('sync.status')), locked)
  t.alike(await failure(m.call('sync.start')), locked)
  t.alike(m.session.internal, [])
})

function plantForeignLock (dir) {
  const lockDir = path.join(dir, '.varanda-lock')
  fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(lockDir, 'pid'), '4242 ' + 'ab'.repeat(16) + '\n', { mode: 0o600 })
  return lockDir
}

test('storeOptions.recover applies to the first store open only', async (t) => {
  const assoc = association(t)
  const dataDir = tmpDir(t)
  const lockDir = plantForeignLock(dataDir)
  const session = newSession(t, { dataDir, association: assoc.hex, bootstrap: BOOTSTRAP, storeOptions: { lock: 'worklet', recover: true } })
  const m = await connect(t, session)
  const { publicKey } = await m.call('identity.create')
  t.ok(publicKey, 'the first open took over the stale worklet lock')
  t.absent(fs.existsSync(lockDir), 'and released it')
  t.alike(await m.call('identity.show'), { publicKey, association: assoc.hex }, 'a later open without a foreign lock works')

  // A second worklet now holds the dir: this session must never take it over.
  plantForeignLock(dataDir)
  const owner = fs.readFileSync(path.join(lockDir, 'pid'), 'utf8')
  t.alike(await failure(m.call('identity.show')), { code: 'LOCKED', message: 'diretório de dados em uso' })
  t.is(fs.readFileSync(path.join(lockDir, 'pid'), 'utf8'), owner, 'the live lock is untouched')
  t.is(session.state, 'error')
})

test('recover: false (default) never takes over a worklet lock', async (t) => {
  const assoc = association(t)
  const dataDir = tmpDir(t)
  plantForeignLock(dataDir)
  const session = newSession(t, { dataDir, association: assoc.hex, bootstrap: BOOTSTRAP, storeOptions: { lock: 'worklet' } })
  const m = await connect(t, session)
  t.alike(await failure(m.call('identity.create')), { code: 'LOCKED', message: 'diretório de dados em uso' })
})

test('serialization: concurrent requests run one at a time, in order', async (t) => {
  const m = await member(t, { cert: true })
  const texts = ['um', 'dois', 'três', 'quatro', 'cinco', 'seis']
  const results = await Promise.all(texts.map((text) => m.call('post.create', { text })))
  t.alike(results.map((r) => r.seq), [1, 2, 3, 4, 5, 6])
  const log = await m.call('log.read')
  t.alike(log.entries.slice(1).map((e) => e.record.text), texts)
})

test('suspend queues requests until resume; close refuses later ones', async (t) => {
  const m = await member(t, { cert: true })
  await m.session.suspend()
  t.is(m.session.state, 'suspended')
  let done = false
  const p = m.call('post.create', { text: 'depois' }).then((r) => { done = true; return r })
  await new Promise((resolve) => setTimeout(resolve, 200))
  t.absent(done, 'queued while suspended')
  m.session.resume()
  t.alike(await p, { seq: 1, ref: m.publicKey + ':1' })
  t.is(m.session.state, 'open')

  const closing = m.session.close()
  t.is(m.session.close(), closing, 'idempotent')
  await closing
  t.is(m.session.state, 'closed')
  t.alike(await failure(m.call('node.info')), { code: 'LOCKED', message: 'sessão encerrada' })
  await m.session.suspend()
  m.session.resume()
  t.is(m.session.state, 'closed')
})

test('close while suspended rejects the queued requests', async (t) => {
  const m = await member(t, { cert: true })
  await m.session.suspend()
  const p = failure(m.call('post.create', { text: 'nunca' }))
  await new Promise((resolve) => setTimeout(resolve, 50))
  await m.session.close()
  t.alike(await p, { code: 'LOCKED', message: 'sessão encerrada' })
  t.is((await m.call('log.read').catch((e) => e)).code, 'LOCKED')
})

test('runSync log lines with a path or key material are redacted', (t) => {
  t.alike(redactLogLine('aviso: inventário incompleto (abcd1234)'), ['aviso: inventário incompleto (abcd1234)', false])
  t.alike(redactLogLine('aviso: falha ao abrir réplica abcd1234: ENOENT: no such file, open \'/tmp/x/store/CURRENT\''),
    ['aviso: falha ao abrir réplica abcd1234: erro interno', true])
  t.alike(redactLogLine('aviso: canal de admissão: C:\\dados\\x'), ['aviso: canal de admissão: erro interno', true])
  t.alike(redactLogLine('aviso: redescoberta: chave ' + 'f'.repeat(64)), ['aviso: redescoberta: erro interno', true])
  t.alike(redactLogLine('aviso /a/b'), ['aviso: erro interno', true])
  t.alike(redactLogLine('aviso: /a/b: c'), ['aviso: erro interno', true], 'a path in the prefix itself')
})

test('no response or event of this file carries a path', (t) => {
  scanWire(t, process.env.VARANDA_TEST_TMPDIR || os.tmpdir())
})
