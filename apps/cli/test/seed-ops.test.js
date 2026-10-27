// Operating the seeder (issue #34): `seed status`, `seed list`, `seed drop`
// and the health endpoint of `seed --health-port`.
const test = require('brittle')
const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
const b4a = require('b4a')
const Corestore = require('corestore')
const { discoveryKey } = require('hypercore-crypto')
const { testnet, tmpDir, until, localSwarmOptions, bootstrapFlags } = require('./helpers/net')
const { Seeder } = require('@varanda/core/lib/seeder')
const { createCert, createSeederCert, createModeratorCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { createSnapshot } = require('@varanda/core/lib/blocklist')
const { memberCertRecord } = require('@varanda/core/lib/records')
const { openStore, writeBlocklist } = require('@varanda/core/lib/store')
const { keyPair: signingKeyPair } = require('hypercore-crypto')
const { startHealth, metricsText } = require('../lib/health')

const BIN = path.join(__dirname, '..', 'bin', 'varanda.js')
const HEX64_ANYWHERE = /[0-9a-f]{64}/i

const env = {}
for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('VARANDA_')) env[k] = v

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function varanda (dataDir, args) {
  const r = spawnSync(process.execPath, [BIN, ...args, '--data', dataDir], { env, encoding: 'utf8', timeout: 60000 })
  return { code: r.status, stdout: r.stdout, stderr: r.stderr }
}

function lastJson (r) {
  const lines = r.stdout.trim().split('\n')
  return JSON.parse(lines[lines.length - 1])
}

function makeAssociation () {
  const kp = generateAssociationKeyPair()
  return { kp, hex: hex(kp.publicKey) }
}

// A seeder data dir with config, Noise key pair and seeder certificate.
function prepareSeederDir (t, assoc) {
  const dataDir = tmpDir(t, 'varanda-seed-')
  Seeder.ensureConfig(dataDir, assoc.hex)
  const { publicKey } = Seeder.createKey(dataDir)
  const certFile = path.join(tmpDir(t, 'varanda-sc-'), 'seeder-cert.json')
  fs.writeFileSync(certFile, JSON.stringify(createSeederCert({ seeder: publicKey }, assoc.kp)))
  Seeder.addCert(dataDir, certFile, assoc.hex)
  return { dataDir, publicKey }
}

function readAdmitted (dataDir) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, 'admitted.json'), 'utf8')).admitted
}

function writeAdmitted (dataDir, admitted) {
  fs.writeFileSync(path.join(dataDir, 'admitted.json'), JSON.stringify({ v: 1, admitted }))
}

// Stores a valid three-block member log in the stopped seeder's main store
// (no network) and returns { key, cert }; the caller lists it.
async function storeLog (t, dataDir, assoc) {
  const src = new Corestore(tmpDir(t, 'varanda-src-'))
  await src.ready()
  t.teardown(() => src.close(), { force: true })
  const core = src.get({ name: 'diary', valueEncoding: 'json' })
  await core.ready()
  const key = hex(core.key)
  const cert = createCert({ member: key }, assoc.kp)
  const at = new Date().toISOString()
  for (const block of [memberCertRecord(cert), { type: 'post', text: 'um', at, replyTo: null }, { type: 'post', text: 'dois', at, replyTo: null }]) {
    await core.append(block)
  }
  const store = new Corestore(path.join(dataDir, 'store'))
  await store.ready()
  const replica = store.get({ key: b4a.from(key, 'hex') })
  await replica.ready()
  const s1 = src.replicate(true)
  const s2 = store.replicate(false)
  s1.on('error', () => {})
  s2.on('error', () => {})
  s1.pipe(s2).pipe(s1)
  await replica.download({ start: 0, end: 3 }).done()
  s1.destroy()
  s2.destroy()
  await store.close()
  return { key, cert }
}

async function stored (dataDir, key) {
  const store = await openStore(dataDir)
  try {
    return await store.storage.hasCore(discoveryKey(b4a.from(key, 'hex')))
  } finally {
    await store.close()
  }
}

// `seed` as a child process; lines are its stdout JSON events.
function seedProcess (t, dataDir, args) {
  const child = spawn(process.execPath, [BIN, 'seed', '--json', '--data', dataDir, ...args], { env })
  const proc = { child, stdout: '', stderr: '', code: null }
  child.stdout.on('data', (d) => { proc.stdout += d })
  child.stderr.on('data', (d) => { proc.stderr += d })
  proc.exited = new Promise((resolve) => child.on('close', (code) => { proc.code = code; resolve(code) }))
  proc.event = (name) => until(() => proc.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.event === name), {
    name: 'evento ' + name,
    timeoutMs: 30000
  })
  t.teardown(async () => {
    if (proc.code === null) {
      child.kill('SIGKILL')
      await proc.exited
    }
  }, { force: true })
  return proc
}

test('seed status: reads the dir without the lock, a store or a write', async (t) => {
  await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const before = fs.readdirSync(dataDir).sort()

  const r = varanda(dataDir, ['seed', 'status', '--json'])
  t.is(r.code, 0, r.stderr)
  t.alike(lastJson(r), { association: assoc.hex, publicKey, certificate: 'ok', admitted: 0, blocklist: null, running: false })
  t.alike(fs.readdirSync(dataDir).sort(), before, 'nothing created: no store/, no lock')

  const human = varanda(dataDir, ['seed', 'status'])
  t.is(human.code, 0)
  t.is(human.stdout, [
    'associação: ' + assoc.hex,
    'chave do semeador: ' + publicKey,
    'certificado: válido',
    'diários admitidos: 0',
    'lista de bloqueio: nenhuma',
    'estado: parado'
  ].join('\n') + '\n')

  // The stored moderation snapshot is reported only when it verifies.
  const moderator = signingKeyPair()
  const modCert = createModeratorCert({ moderator: hex(moderator.publicKey) }, assoc.kp)
  const date = '2026-10-24T12:00:00.000Z'
  writeBlocklist(dataDir, createSnapshot({ seq: 3, date, blocked: ['b'.repeat(64)] }, moderator, modCert))
  t.alike(lastJson(varanda(dataDir, ['seed', 'status', '--json'])).blocklist, { seq: 3, date })
  t.ok(varanda(dataDir, ['seed', 'status']).stdout.includes('lista de bloqueio: seq 3 de ' + date + '\n'))
  const foreign = makeAssociation()
  const foreignCert = createModeratorCert({ moderator: hex(moderator.publicKey) }, foreign.kp)
  writeBlocklist(dataDir, createSnapshot({ seq: 4, date }, moderator, foreignCert))
  t.is(lastJson(varanda(dataDir, ['seed', 'status', '--json'])).blocklist, null, 'another association: ignored')
  fs.rmSync(path.join(dataDir, 'blocklist.json'))

  // Answers while another process holds the data dir (here: this test).
  writeAdmitted(dataDir, { ['a'.repeat(64)]: {}, 'not-a-key': {} })
  const store = await openStore(dataDir)
  try {
    const held = lastJson(varanda(dataDir, ['seed', 'status', '--json']))
    t.is(held.running, true, 'running while the lock is held')
    t.is(held.admitted, 1, 'counts hex64 keys only')
    t.ok(varanda(dataDir, ['seed', 'status']).stdout.includes('estado: em execução\n'))
  } finally {
    await store.close()
  }

  // Certificate problems are reported, not thrown.
  const other = Seeder.createKey(tmpDir(t, 'varanda-other-')).publicKey
  fs.writeFileSync(path.join(dataDir, 'seeder-cert.json'), JSON.stringify(createSeederCert({ seeder: other }, assoc.kp)))
  t.is(lastJson(varanda(dataDir, ['seed', 'status', '--json'])).certificate, 'seeder-mismatch')
  t.ok(varanda(dataDir, ['seed', 'status']).stdout.includes('certificado: inválido (seeder-mismatch)\n'))
  fs.writeFileSync(path.join(dataDir, 'seeder-cert.json'), '{')
  t.is(lastJson(varanda(dataDir, ['seed', 'status', '--json'])).certificate, 'malformed')
  fs.rmSync(path.join(dataDir, 'seeder-cert.json'))
  fs.rmSync(path.join(dataDir, 'seeder-key.json'))
  const bare = lastJson(varanda(dataDir, ['seed', 'status', '--json']))
  t.is(bare.publicKey, null)
  t.is(bare.certificate, 'missing')
  const bareHuman = varanda(dataDir, ['seed', 'status']).stdout
  t.ok(bareHuman.includes('chave do semeador: ausente (use seed key)\n'))
  t.ok(bareHuman.includes('certificado: ausente (use seed cert add)\n'))

  // Not a seeder dir, or another association: refused, nothing written.
  const empty = tmpDir(t, 'varanda-empty-')
  const missing = varanda(empty, ['seed', 'status', '--association', assoc.hex])
  t.is(missing.code, 1)
  t.is(missing.stderr, 'erro: diretório não é de um semeador\n')
  t.alike(fs.readdirSync(empty), [], 'status never writes config.json')
  const member = tmpDir(t, 'varanda-member-')
  t.is(varanda(member, ['id', 'create', '--association', assoc.hex]).code, 0)
  t.is(varanda(member, ['seed', 'status']).stderr, 'erro: diretório não é de um semeador\n')
  const mismatch = varanda(dataDir, ['seed', 'status', '--association', makeAssociation().hex])
  t.is(mismatch.code, 1)
  t.is(mismatch.stderr, 'erro: associação diferente da configurada\n')
})

test('seed list and seed drop work with the seeder stopped and refuse while it runs', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)

  const empty = varanda(dataDir, ['seed', 'list'])
  t.is(empty.code, 0, empty.stderr)
  t.is(empty.stdout, 'nenhum diário admitido\n')
  t.alike(lastJson(varanda(dataDir, ['seed', 'list', '--json'])), { admitted: [] })

  const a = await storeLog(t, dataDir, assoc)
  const b = await storeLog(t, dataDir, assoc)
  const ghost = 'c'.repeat(64) // listed, never stored
  writeAdmitted(dataDir, { [a.key]: a.cert, [b.key]: b.cert, [ghost]: a.cert })

  const listed = varanda(dataDir, ['seed', 'list', '--json'])
  t.is(listed.code, 0, listed.stderr)
  const entries = lastJson(listed).admitted
  t.alike(entries.map((e) => e.key), [a.key, b.key, ghost], 'admitted.json order')
  t.alike(entries.map((e) => e.length), [3, 3, 0])
  t.ok(entries[0].byteLength > 0 && entries[1].byteLength > 0, 'signed byte lengths')
  t.is(entries[2].byteLength, 0)
  t.absent(await stored(dataDir, ghost), 'listing never creates a core')
  const human = varanda(dataDir, ['seed', 'list']).stdout.split('\n')
  t.is(human[0], a.key + ' 3 blocos ' + entries[0].byteLength + ' bytes')
  t.is(human[2], ghost + ' 0 blocos 0 bytes')

  // While another process holds the data dir: LOCKED, nothing changed.
  const holder = await openStore(dataDir)
  try {
    const locked = varanda(dataDir, ['seed', 'list'])
    t.is(locked.code, 1)
    t.is(locked.stderr, 'erro: diretório de dados em uso\n')
    const lockedDrop = varanda(dataDir, ['seed', 'drop', a.key])
    t.is(lockedDrop.code, 1)
    t.is(lockedDrop.stderr, 'erro: diretório de dados em uso\n')
    t.ok(a.key in readAdmitted(dataDir), 'admitted.json untouched')
  } finally {
    await holder.close()
  }

  // Drop: the replica is purged and the key leaves admitted.json.
  const dropped = varanda(dataDir, ['seed', 'drop', a.key.toUpperCase()])
  t.is(dropped.code, 0, dropped.stderr)
  t.is(dropped.stdout, 'diário removido do semeador: ' + a.key + '\n')
  t.alike(Object.keys(readAdmitted(dataDir)), [b.key, ghost], 'the others are kept')
  t.absent(await stored(dataDir, a.key), 'replica purged')
  t.ok(await stored(dataDir, b.key), 'other replica kept')

  const again = varanda(dataDir, ['seed', 'drop', a.key])
  t.is(again.code, 1)
  t.is(again.stderr, 'erro: diário não está no semeador\n')
  t.alike(lastJson(varanda(dataDir, ['seed', 'drop', ghost, '--json'])), { key: ghost })
  t.alike(Object.keys(readAdmitted(dataDir)), [b.key])

  t.is(varanda(dataDir, ['seed', 'drop']).stderr, 'uso: informe a chave do diário\n')
  t.is(varanda(dataDir, ['seed', 'drop', 'abc']).stderr, 'uso: chave inválida\n')
  t.is(varanda(dataDir, ['seed', 'drop', 'abc']).code, 2)
  const extra = varanda(dataDir, ['seed', 'drop', b.key, 'extra'])
  t.is(extra.code, 2)
  t.is(extra.stderr, 'uso: node bin/varanda.js seed [key|cert add|list|drop <chave>|status]\n')
  t.is(varanda(tmpDir(t, 'varanda-empty-'), ['seed', 'list']).stderr, 'erro: diretório não é de um semeador\n')

  // The next start serves what is left and nothing that was dropped.
  const seeder = new Seeder({ dataDir, ...localSwarmOptions(bootstrap) })
  t.teardown(() => seeder.close(), { force: true })
  const ready = await seeder.start()
  t.alike(ready.admitted, [b.key])
  const stats = seeder.stats()
  t.is(stats.status, 'ok')
  t.is(stats.admitted, 1)
  t.is(stats.blocks, 3)
  await seeder.close()
  t.is(seeder.stats().status, 'closing')
})

test('seed --health-port: health and metrics, counts only, bound to loopback', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const log = await storeLog(t, dataDir, assoc)
  writeAdmitted(dataDir, { [log.key]: log.cert })

  const proc = seedProcess(t, dataDir, ['--health-port', '0', ...bootstrapFlags(bootstrap)])
  const health = await proc.event('health')
  t.is(health.host, '127.0.0.1', 'loopback by default')
  t.ok(health.port > 0)
  await proc.event('ready')
  const base = 'http://127.0.0.1:' + health.port

  const res = await fetch(base + '/health')
  t.is(res.status, 200)
  t.is(res.headers.get('cache-control'), 'no-store')
  t.is(res.headers.get('access-control-allow-origin'), null, 'no CORS')
  const text = await res.text()
  const body = JSON.parse(text)
  t.alike(Object.keys(body), ['status', 'uptimeSeconds', 'admitted', 'dropping', 'blocks', 'bytes', 'connections', 'swarm', 'external', 'maxConnections', 'maxExternal', 'peers', 'firewalled', 'blocked', 'blocklistSeq', 'mediaCores', 'mediaBytes', 'indexRecords', 'indexSaturated', 'topicPosts', 'topicSaturated'])
  t.is(body.status, 'ok')
  t.is(body.admitted, 1)
  t.is(body.dropping, 0)
  t.is(body.blocked, 0)
  t.is(body.blocklistSeq, 0)
  t.is(body.mediaCores, 0)
  t.is(body.mediaBytes, 0)
  t.is(body.blocks, 3)
  t.ok(body.bytes > 0)
  t.ok(Number.isInteger(body.connections) && Number.isInteger(body.peers))
  t.ok(Number.isInteger(body.swarm) && Number.isInteger(body.external), 'swarm and external are counts')
  t.is(body.connections, body.swarm + body.external, 'connections = swarm + external')
  t.is(body.maxConnections, 64, 'default swarm cap')
  t.is(body.maxExternal, 32, 'default external cap: half of maxConnections')
  t.ok(Number.isInteger(body.indexRecords) && body.indexRecords >= 0, 'index records is a count')
  t.is(body.indexSaturated, false)
  t.ok(Number.isInteger(body.topicPosts) && body.topicPosts >= 0, 'search posts is a count')
  t.is(body.topicSaturated, false)
  t.absent(HEX64_ANYWHERE.test(text), 'no key in /health')

  const metrics = await fetch(base + '/metrics?x=1')
  t.is(metrics.status, 200)
  t.ok(metrics.headers.get('content-type').startsWith('text/plain; version=0.0.4'))
  const mtext = await metrics.text()
  t.ok(mtext.includes('\nvaranda_seeder_admitted_diaries 1\n'))
  t.ok(mtext.includes('\nvaranda_seeder_ready 1\n'))
  t.ok(mtext.includes('# TYPE varanda_seeder_bytes gauge\n'))
  t.ok(mtext.includes('\nvaranda_seeder_blocked 0\n'), 'blocked gauge (count only)')
  t.ok(mtext.includes('\nvaranda_seeder_blocklist_seq 0\n'), 'blocklist seq gauge')
  t.ok(mtext.includes('# TYPE varanda_seeder_blocklist_seq gauge\n'))
  t.ok(mtext.includes('# TYPE varanda_seeder_media_cores gauge\nvaranda_seeder_media_cores 0\n'), 'media cores gauge (count only)')
  t.ok(mtext.includes('# TYPE varanda_seeder_media_bytes gauge\nvaranda_seeder_media_bytes 0\n'), 'media bytes gauge')
  t.ok(/# TYPE varanda_seeder_index_records gauge\nvaranda_seeder_index_records [0-9]+\n/.test(mtext), 'index records gauge (count only)')
  t.ok(mtext.includes('# TYPE varanda_seeder_index_saturated gauge\nvaranda_seeder_index_saturated 0\n'), 'index saturated gauge')
  t.ok(/# TYPE varanda_seeder_swarm gauge\nvaranda_seeder_swarm [0-9]+\n/.test(mtext), 'swarm gauge')
  t.ok(/# TYPE varanda_seeder_external gauge\nvaranda_seeder_external [0-9]+\n/.test(mtext), 'external gauge')
  t.ok(mtext.includes('# TYPE varanda_seeder_max_connections gauge\nvaranda_seeder_max_connections 64\n'), 'max connections gauge')
  t.ok(mtext.includes('# TYPE varanda_seeder_max_external gauge\nvaranda_seeder_max_external 32\n'), 'max external gauge')
  t.ok(/# TYPE varanda_seeder_topic_posts gauge\nvaranda_seeder_topic_posts [0-9]+\n/.test(mtext), 'topic posts gauge (count only)')
  t.ok(mtext.includes('# TYPE varanda_seeder_topic_saturated gauge\nvaranda_seeder_topic_saturated 0\n'), 'topic saturated gauge')
  t.absent(HEX64_ANYWHERE.test(mtext), 'no key in /metrics')
  t.absent(mtext.includes(publicKey.slice(0, 8)) || mtext.includes(log.key.slice(0, 8)))

  const head = await fetch(base + '/health', { method: 'HEAD' })
  t.is(head.status, 200)
  t.is(await head.text(), '')
  const post = await fetch(base + '/health', { method: 'POST', body: 'x' })
  t.is(post.status, 405)
  t.is(post.headers.get('allow'), 'GET, HEAD')
  t.is((await fetch(base + '/')).status, 404)
  t.is((await fetch(base + '/health/x')).status, 404)

  // Status answers while it runs; list does not take the lock from it.
  t.is(lastJson(varanda(dataDir, ['seed', 'status', '--json'])).running, true)
  const locked = varanda(dataDir, ['seed', 'list'])
  t.is(locked.code, 1)
  t.is(locked.stderr, 'erro: diretório de dados em uso\n')

  proc.child.kill('SIGTERM')
  t.is(await proc.exited, 0, 'SIGTERM: exit 0 ' + proc.stderr)
  await t.exception.all(() => fetch(base + '/health'), 'the endpoint closed with the seeder')
  t.is(lastJson(varanda(dataDir, ['seed', 'status', '--json'])).running, false, 'lock released')
})

test('seed --health-port on a busy port fails before touching the data dir', async (t) => {
  t.timeout(60000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const busy = net.createServer()
  await new Promise((resolve) => busy.listen(0, '127.0.0.1', resolve))
  t.teardown(() => new Promise((resolve) => busy.close(resolve)), { force: true })

  const r = spawnSync(process.execPath, [BIN, 'seed', '--data', dataDir, '--health-port', String(busy.address().port), ...bootstrapFlags(bootstrap)], {
    env,
    encoding: 'utf8',
    timeout: 60000
  })
  t.is(r.status, 1)
  t.is(r.stderr, 'erro: porta em uso\n')
  t.absent(fs.existsSync(path.join(dataDir, 'store')), 'no store opened')
  t.absent(fs.existsSync(path.join(dataDir, '.varanda-lock')), 'no lock taken')
})

test('health endpoint: 503 while the seeder starts or closes', async (t) => {
  await testnet(t)
  let status = 'starting'
  const stats = () => ({ status, admitted: 0, dropping: 0, blocks: 0, bytes: 0, connections: 0, swarm: 0, external: 0, maxConnections: 64, maxExternal: 32, peers: 0, firewalled: null, blocked: 0, blocklistSeq: 0, mediaCores: 0, mediaBytes: 0, indexRecords: 0, indexSaturated: false, topicPosts: 0, topicSaturated: false })
  const server = await startHealth({ port: 0, stats })
  t.teardown(() => server.close(), { force: true })
  const base = 'http://127.0.0.1:' + server.port
  const starting = await fetch(base + '/health')
  t.is(starting.status, 503)
  t.is((await starting.json()).status, 'starting')
  t.ok((await (await fetch(base + '/metrics')).text()).includes('\nvaranda_seeder_ready 0\n'))
  status = 'ok'
  t.is((await fetch(base + '/health')).status, 200)
  status = 'closing'
  t.is((await fetch(base + '/health')).status, 503)
  await server.close()
  await server.close()
  await t.exception.all(() => fetch(base + '/health'), 'closed')
})

test('metrics: blocklist and media gauges carry counts only', (t) => {
  const text = metricsText({ status: 'ok', admitted: 2, dropping: 0, blocks: 9, bytes: 100, connections: 3, swarm: 1, external: 2, maxConnections: 64, maxExternal: 32, peers: 1, firewalled: false, blocked: 3, blocklistSeq: 7, mediaCores: 2, mediaBytes: 65536, indexRecords: 12, indexSaturated: true, topicPosts: 3, topicSaturated: false, uptimeSeconds: 5 })
  t.ok(text.includes('# TYPE varanda_seeder_blocked gauge\nvaranda_seeder_blocked 3\n'))
  t.ok(text.includes('# TYPE varanda_seeder_blocklist_seq gauge\nvaranda_seeder_blocklist_seq 7\n'))
  t.ok(text.includes('# TYPE varanda_seeder_media_cores gauge\nvaranda_seeder_media_cores 2\n'))
  t.ok(text.includes('# TYPE varanda_seeder_media_bytes gauge\nvaranda_seeder_media_bytes 65536\n'))
  t.ok(text.includes('# TYPE varanda_seeder_index_records gauge\nvaranda_seeder_index_records 12\n'))
  t.ok(text.includes('# TYPE varanda_seeder_index_saturated gauge\nvaranda_seeder_index_saturated 1\n'))
  t.ok(text.includes('# TYPE varanda_seeder_connections gauge\nvaranda_seeder_connections 3\n'))
  t.ok(text.includes('# TYPE varanda_seeder_swarm gauge\nvaranda_seeder_swarm 1\n'))
  t.ok(text.includes('# TYPE varanda_seeder_external gauge\nvaranda_seeder_external 2\n'))
  t.ok(text.includes('# TYPE varanda_seeder_max_connections gauge\nvaranda_seeder_max_connections 64\n'))
  t.ok(text.includes('# TYPE varanda_seeder_max_external gauge\nvaranda_seeder_max_external 32\n'))
  t.ok(text.indexOf('varanda_seeder_connections ') < text.indexOf('varanda_seeder_swarm '), 'the cap gauges follow connections')
  t.ok(text.includes('# TYPE varanda_seeder_topic_posts gauge\nvaranda_seeder_topic_posts 3\n'))
  t.ok(text.includes('# TYPE varanda_seeder_topic_saturated gauge\nvaranda_seeder_topic_saturated 0\n'))
  t.absent(HEX64_ANYWHERE.test(text))
})

test('metrics: a missing or non-finite connection gauge prints 0', (t) => {
  const text = metricsText({ status: 'ok', connections: 0, swarm: NaN, external: undefined, maxConnections: Infinity })
  t.ok(text.includes('\nvaranda_seeder_swarm 0\n'))
  t.ok(text.includes('\nvaranda_seeder_external 0\n'))
  t.ok(text.includes('\nvaranda_seeder_max_connections 0\n'))
  t.ok(text.includes('\nvaranda_seeder_max_external 0\n'))
})
