'use strict'

// apps/cli/lib/commands/mod.js and apps/cli/lib/mod-publish.js: the
// moderation key on the operator's machine, the signed blocklist chain it
// builds (and the hidden-posts list, #225), and publishing to the
// association's seeder (a certified stand-in on the loopback hyperdht
// testnet), never to an echoing or foreign peer.

const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
const Corestore = require('corestore')
const assoc = require('@varanda/core/lib/assoc')
const { verifySnapshot, acceptSnapshot, verifyHiddenList, acceptHiddenList, createBlocklistState, compareSnapshots } = require('@varanda/core/lib/blocklist')
const { attachBlocklist, PROTOCOL_HIDDEN } = require('@varanda/core/lib/blocklist-net')
const { createSwarm, topicFor, attachAdmission, joinAndFlush, generateNoiseKeyPair } = require('@varanda/core/lib/net')
const { testnet, tmpDir, localSwarmOptions, bootstrapFlags } = require('./helpers/net')

const BIN = path.join(__dirname, '..', 'bin', 'varanda.js')
const A = 'aa'.repeat(32)
const B = 'bb'.repeat(32)
const C = 'cc'.repeat(32)
const ISSUER = 'dd'.repeat(32)

const cleanEnv = {}
for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('VARANDA_')) cleanEnv[k] = v

function cli (args) {
  return spawnSync(process.execPath, [BIN, ...args], { env: cleanEnv, encoding: 'utf8', timeout: 60000 })
}

function cliAsync (args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { env: cleanEnv })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('close', (status) => resolve({ status, stdout, stderr }))
  })
}

function secretOf (file) {
  return JSON.parse(fs.readFileSync(file, 'utf8')).secretKey
}

function readList (modDir) {
  return JSON.parse(fs.readFileSync(path.join(modDir, 'blocklist.json'), 'utf8')).snapshot
}

function readHidden (modDir) {
  return JSON.parse(fs.readFileSync(path.join(modDir, 'hidden-posts.json'), 'utf8')).list
}

// An association, a moderation dir with its key and a certificate from that association.
function setup (t) {
  const root = tmpDir(t)
  const assocDir = path.join(root, 'assoc')
  const modDir = path.join(root, 'mod')
  const { publicKey: association } = assoc.initAssociation(assocDir)
  const init = cli(['mod', 'init', '--association', association, '--data', modDir])
  t.is(init.status, 0, init.stderr)
  const match = /^chave da moderação: ([0-9a-f]{64})\n$/.exec(init.stdout)
  t.ok(match, 'init prints the public key')
  const moderator = match[1]
  const certFile = path.join(root, 'moderator-cert.json')
  fs.writeFileSync(certFile, JSON.stringify(assoc.issueModeratorCertificate(assocDir, { moderator })))
  const added = cli(['mod', 'cert', 'add', '--cert-file', certFile, '--data', modDir])
  t.is(added.status, 0, added.stderr)
  t.is(added.stdout, 'certificado da moderação gravado\n')
  return { root, assocDir, modDir, association, moderator }
}

test('mod init, cert add, block, unblock and revoke build a verified chain', async (t) => {
  await testnet(t)
  const { assocDir, modDir, association, moderator } = setup(t)
  const keyFile = path.join(modDir, 'moderator.json')
  const secret = secretOf(keyFile)
  t.is(fs.statSync(keyFile).mode & 0o777, 0o600)
  t.is(JSON.parse(fs.readFileSync(path.join(modDir, 'config.json'), 'utf8')).role, 'moderator')

  // A second init keeps the key (no clobber) and prints the same public key.
  const before = fs.readFileSync(keyFile, 'utf8')
  const again = cli(['mod', 'init', '--data', modDir])
  t.is(again.status, 0)
  t.is(again.stdout, 'chave da moderação: ' + moderator + '\n')
  t.is(fs.readFileSync(keyFile, 'utf8'), before)

  const empty = cli(['mod', 'show', '--data', modDir])
  t.is(empty.status, 0)
  t.ok(empty.stdout.includes('certificado: válido'))
  t.ok(empty.stdout.endsWith('lista vazia\npublicações ocultas: nenhuma lista\n'))

  const chain = []
  const step = (args, lines) => {
    const res = cli(['mod', ...args, '--no-publish', '--data', modDir])
    t.is(res.status, 0, res.stderr)
    t.is(res.stdout, lines.join('\n') + '\n')
    t.absent(res.stdout.includes(secret) || res.stderr.includes(secret))
    chain.push(readList(modDir))
  }
  step(['block', A.toUpperCase(), '--new-list'], ['conta bloqueada: ' + A, 'lista seq 1 gravada', 'lista não publicada (--no-publish)'])
  step(['block', B], ['conta bloqueada: ' + B, 'lista seq 2 gravada', 'lista não publicada (--no-publish)'])
  step(['unblock', A], ['conta desbloqueada: ' + A, 'lista seq 3 gravada', 'lista não publicada (--no-publish)'])
  step(['unblock', C], ['não estava bloqueada: ' + C, 'lista seq 4 gravada', 'lista não publicada (--no-publish)'])
  step(['block', B], ['já estava bloqueada: ' + B, 'lista seq 5 gravada', 'lista não publicada (--no-publish)'])
  step(['revoke-issuer', ISSUER], ['emissor revogado: ' + ISSUER, 'lista seq 6 gravada', 'lista não publicada (--no-publish)'])
  step(['unrevoke-issuer', ISSUER], ['revogação desfeita: ' + ISSUER, 'lista seq 7 gravada', 'lista não publicada (--no-publish)'])
  step(['revoke-issuer', ISSUER], ['emissor revogado: ' + ISSUER, 'lista seq 8 gravada', 'lista não publicada (--no-publish)'])

  let previous = null
  for (const snapshot of chain) {
    t.alike(verifySnapshot(snapshot, association), { ok: true })
    t.alike(acceptSnapshot(previous, snapshot, association), { ok: true }, 'seq ' + snapshot.seq + ' accepted')
    t.is(snapshot.moderator, moderator)
    previous = snapshot
  }
  t.alike(chain[2].blocked, [B])
  t.alike(chain[0].blocked, [A])
  t.alike(chain[1].blocked, [A, B])
  const last = chain[chain.length - 1]
  t.alike(last.blocked, [B])
  t.alike(last.revokedIssuers, [ISSUER])
  t.is(fs.statSync(path.join(modDir, 'blocklist.json')).mode & 0o777, 0o600)

  const logFile = path.join(modDir, 'moderation.jsonl')
  t.is(fs.statSync(logFile).mode & 0o777, 0o600)
  const lines = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  t.is(lines.length, chain.length)
  t.alike(lines[0], { op: 'block', member: A, seq: 1, date: chain[0].date, source: 'operacao' })
  t.alike(lines[3], { op: 'unblock', member: C, seq: 4, date: chain[3].date, source: 'operacao' })
  t.alike(lines[5], { op: 'revoke-issuer', issuer: ISSUER, seq: 6, date: chain[5].date, source: 'operacao' })
  t.alike(lines[6], { op: 'unrevoke-issuer', issuer: ISSUER, seq: 7, date: chain[6].date, source: 'operacao' })
  for (const line of lines) t.absent('signature' in line)
  t.absent(fs.readFileSync(logFile, 'utf8').includes(secret))

  const shown = cli(['mod', 'show', '--data', modDir])
  t.is(shown.stdout, [
    'associação: ' + association,
    'chave da moderação: ' + moderator,
    'certificado: válido',
    'lista seq 8 de ' + last.date + ': 1 contas bloqueadas, 1 emissores revogados',
    'publicações ocultas: nenhuma lista'
  ].join('\n') + '\n')
  const shownJson = cli(['mod', 'show', '--json', '--data', modDir])
  t.alike(JSON.parse(shownJson.stdout), { association, publicKey: moderator, certificate: 'ok', snapshot: last, hiddenList: null })
  t.absent(fs.existsSync(path.join(modDir, 'hidden-posts.json')), 'no block writes a hidden-posts list')
  t.absent(shownJson.stdout.includes(secret))

  const blockedJson = cli(['mod', 'block', C, '--no-publish', '--json', '--data', modDir])
  t.is(blockedJson.status, 0)
  const result = JSON.parse(blockedJson.stdout.trim().split('\n').pop())
  t.is(result.published, false)
  t.is(result.snapshot.seq, 9)
  t.alike(result.snapshot, readList(modDir))
  t.absent(blockedJson.stdout.includes(secret))

  // Usage errors.
  const missing = cli(['mod', 'block', '--no-publish', '--data', modDir])
  t.is(missing.status, 2)
  t.ok(missing.stderr.includes('informe a chave'))
  const bad = cli(['mod', 'block', 'a'.repeat(63), '--no-publish', '--data', modDir])
  t.is(bad.status, 2)
  t.ok(bad.stderr.includes('chave inválida'))
  t.is(readList(modDir).seq, 9, 'a refused command signs nothing')

  // The association secret never reaches the moderation dir.
  const assocSecret = secretOf(path.join(assocDir, 'association.json'))
  for (const name of fs.readdirSync(modDir)) {
    const file = path.join(modDir, name)
    if (fs.statSync(file).isFile()) t.absent(fs.readFileSync(file, 'utf8').includes(assocSecret), name)
  }
})

test('mod hide and unhide sign a hidden-posts list of their own, with audit lines', async (t) => {
  await testnet(t)
  const { modDir, association, moderator } = setup(t)
  const run = (args) => cli(['mod', ...args, '--no-publish', '--data', modDir])
  const hiddenFile = path.join(modDir, 'hidden-posts.json')
  t.is(run(['block', A, '--new-list']).status, 0)
  const blocklist = readList(modDir)

  // The first hide of a dir needs --new-list, as the first block does.
  const first = run(['hide', B, '7'])
  t.is(first.status, 1)
  t.ok(first.stderr.startsWith('erro: este diretório não tem lista de publicações ocultas;'), first.stderr)
  t.absent(fs.existsSync(hiddenFile), 'nothing signed')

  const chain = []
  const step = (args, lines) => {
    const res = run(args)
    t.is(res.status, 0, res.stderr)
    t.is(res.stdout, lines.join('\n') + '\n')
    chain.push(readHidden(modDir))
  }
  const done = (seq) => ['lista de publicações ocultas seq ' + seq + ' gravada', 'lista não publicada (--no-publish)']
  step(['hide', B.toUpperCase(), '7', '--new-list'], ['publicação oculta: ' + B + ':7', ...done(1)])
  step(['hide', B, '7'], ['publicação já estava oculta: ' + B + ':7', ...done(2)])
  step(['hide', C, '12'], ['publicação oculta: ' + C + ':12', ...done(3)])
  step(['unhide', B, '7'], ['publicação de volta: ' + B + ':7', ...done(4)])
  step(['unhide', B, '7'], ['publicação não estava oculta: ' + B + ':7', ...done(5)])

  let previous = null
  for (const list of chain) {
    t.alike(verifyHiddenList(list, association), { ok: true })
    t.alike(acceptHiddenList(previous, list, association), { ok: true }, 'seq ' + list.seq + ' accepted')
    t.is(list.moderator, moderator)
    previous = list
  }
  t.alike(chain[0].hiddenPosts, [B + ':7'])
  t.alike(chain[2].hiddenPosts, [B + ':7', C + ':12'])
  t.alike(chain[4].hiddenPosts, [C + ':12'])
  t.is(fs.statSync(hiddenFile).mode & 0o777, 0o600)
  t.alike(readList(modDir), blocklist, 'blocklist.json is untouched')

  // A block leaves the hidden-posts list as it is.
  t.is(run(['block', C]).status, 0)
  t.is(readList(modDir).seq, 2)
  t.alike(readHidden(modDir), chain[4])

  const hideLines = auditLines(modDir).map((l) => JSON.parse(l)).filter((l) => l.op === 'hide' || l.op === 'unhide')
  t.alike(hideLines, [
    { op: 'hide', post: B + ':7', seq: 1, date: chain[0].date, source: 'operacao' },
    { op: 'hide', post: B + ':7', seq: 2, date: chain[1].date, source: 'operacao' },
    { op: 'hide', post: C + ':12', seq: 3, date: chain[2].date, source: 'operacao' },
    { op: 'unhide', post: B + ':7', seq: 4, date: chain[3].date, source: 'operacao' },
    { op: 'unhide', post: B + ':7', seq: 5, date: chain[4].date, source: 'operacao' }
  ])

  const shown = cli(['mod', 'show', '--data', modDir])
  t.ok(shown.stdout.endsWith('publicações ocultas: lista seq 5 de ' + chain[4].date + ': 1 publicações\n'), shown.stdout)
  t.alike(JSON.parse(cli(['mod', 'show', '--json', '--data', modDir]).stdout).hiddenList, chain[4])

  const json = cli(['mod', 'hide', B, '9', '--no-publish', '--json', '--data', modDir])
  t.is(json.status, 0, json.stderr)
  const result = JSON.parse(json.stdout.trim().split('\n').pop())
  t.alike(result, { op: 'hide', post: B + ':9', changed: true, published: false, list: readHidden(modDir) })
  t.is(result.list.seq, 6)

  const again = run(['hide', A, '1', '--new-list'])
  t.is(again.status, 1)
  t.is(again.stderr, 'erro: este diretório já tem uma lista de publicações ocultas\n')

  // Usage errors, and nothing signed.
  const missing = run(['hide', B])
  t.is(missing.status, 2)
  t.ok(missing.stderr.includes('informe o número (seq) da publicação'))
  for (const seq of ['0', '01', '1.5', 'x', '12345678901234567']) {
    const bad = run(['hide', B, seq])
    t.is(bad.status, 2, 'seq ' + seq)
    t.ok(bad.stderr.includes('número (seq) da publicação inválido'), 'seq ' + seq)
  }
  t.ok(run(['hide', 'b'.repeat(63), '1']).stderr.includes('chave inválida'))
  t.is(run(['unhide', B, '9', 'extra']).status, 2)
  t.is(readHidden(modDir).seq, 6, 'a refused command signs nothing')

  // A damaged list is an error, never a restart at seq 1.
  fs.writeFileSync(hiddenFile, '{"v":1,"li')
  const damaged = run(['hide', B, '3'])
  t.is(damaged.status, 1)
  t.is(damaged.stderr, 'erro: lista de publicações ocultas gravada inválida\n')
})

test('after a rotation the stored list of the other kind is re-signed under the new certificate', async (t) => {
  await testnet(t)
  const { root, assocDir, modDir, association } = setup(t)
  const run = (dir, args) => cli(['mod', ...args, '--no-publish', '--data', dir])
  t.is(run(modDir, ['block', A, '--new-list']).status, 0)
  t.is(run(modDir, ['hide', B, '7', '--new-list']).status, 0)
  const oldSnapshot = readList(modDir)
  const oldHidden = readHidden(modDir)

  const newDir = path.join(root, 'mod2')
  const init = cli(['mod', 'init', '--association', association, '--data', newDir])
  t.is(init.status, 0, init.stderr)
  const moderator = /([0-9a-f]{64})/.exec(init.stdout)[1]
  const certFile = path.join(root, 'moderator2-cert.json')
  fs.writeFileSync(certFile, JSON.stringify(assoc.issueModeratorCertificate(assocDir, { moderator })))
  t.is(cli(['mod', 'cert', 'add', '--cert-file', certFile, '--data', newDir]).status, 0)
  fs.copyFileSync(path.join(modDir, 'blocklist.json'), path.join(newDir, 'blocklist.json'))
  fs.copyFileSync(path.join(modDir, 'hidden-posts.json'), path.join(newDir, 'hidden-posts.json'))

  // mod hide signs the hidden-posts list and re-signs the snapshot, unchanged
  const hid = run(newDir, ['hide', C, '3'])
  t.is(hid.status, 0, hid.stderr)
  t.is(hid.stdout, ['publicação oculta: ' + C + ':3', 'lista de publicações ocultas seq 2 gravada', 'lista de bloqueio reassinada com o certificado atual, seq 2', 'lista não publicada (--no-publish)'].join('\n') + '\n')
  const snapshot = readList(newDir)
  t.is(snapshot.moderator, moderator)
  t.alike(snapshot.blocked, oldSnapshot.blocked)
  t.alike(snapshot.revokedIssuers, oldSnapshot.revokedIssuers)
  t.alike(acceptSnapshot(oldSnapshot, snapshot, association), { ok: true })
  t.alike(auditLines(newDir).map((l) => JSON.parse(l).op), ['hide'], 'no audit line for the re-signed snapshot')

  // a node holding the new hidden-posts list adopts the re-signed snapshot
  const state = createBlocklistState({ association, save () {}, loadHidden: () => null, saveHidden () {} })
  await state.ready()
  t.is((await state.offer(oldSnapshot)).adopted, true)
  t.is((await state.offerHidden(readHidden(newDir))).adopted, true)
  t.is((await state.offer(oldSnapshot)).reason, 'same')
  t.is((await state.offer(snapshot)).adopted, true)

  // both lists now carry the new certificate: the next change re-signs nothing
  const blocked = run(newDir, ['block', B])
  t.is(blocked.status, 0, blocked.stderr)
  t.absent(blocked.stdout.includes('reassinada'))
  t.is(readHidden(newDir).seq, 2)

  // the other way round: mod block in a rotated dir re-signs the hidden list
  const thirdDir = path.join(root, 'mod3')
  const init3 = cli(['mod', 'init', '--association', association, '--data', thirdDir])
  const moderator3 = /([0-9a-f]{64})/.exec(init3.stdout)[1]
  const certFile3 = path.join(root, 'moderator3-cert.json')
  fs.writeFileSync(certFile3, JSON.stringify(assoc.issueModeratorCertificate(assocDir, { moderator: moderator3 })))
  t.is(cli(['mod', 'cert', 'add', '--cert-file', certFile3, '--data', thirdDir]).status, 0)
  fs.copyFileSync(path.join(modDir, 'blocklist.json'), path.join(thirdDir, 'blocklist.json'))
  fs.copyFileSync(path.join(modDir, 'hidden-posts.json'), path.join(thirdDir, 'hidden-posts.json'))
  const json = cli(['mod', 'block', C, '--no-publish', '--json', '--data', thirdDir])
  t.is(json.status, 0, json.stderr)
  const out = JSON.parse(json.stdout)
  t.is(out.hiddenList.moderator, moderator3)
  t.alike(out.hiddenList, readHidden(thirdDir))
  t.alike(out.hiddenList.hiddenPosts, oldHidden.hiddenPosts)
  t.alike(acceptHiddenList(oldHidden, out.hiddenList, association), { ok: true })
})

test('mod refuses foreign dirs, foreign certificates and a damaged list', async (t) => {
  await testnet(t)
  const { root, assocDir, modDir, association } = setup(t)

  const memberDir = path.join(root, 'member')
  fs.mkdirSync(memberDir)
  fs.writeFileSync(path.join(memberDir, 'config.json'), JSON.stringify({ v: 1, role: 'member', association }))
  for (const args of [['init'], ['show'], ['block', A, '--no-publish']]) {
    const res = cli(['mod', ...args, '--association', association, '--data', memberDir])
    t.is(res.status, 1)
    t.is(res.stderr, 'erro: diretório não é da moderação\n')
  }
  const refusedAssoc = cli(['mod', 'init', '--association', association, '--data', assocDir])
  t.is(refusedAssoc.stderr, 'erro: diretório não é da moderação\n')
  t.absent(fs.existsSync(path.join(assocDir, 'moderator.json')))
  const other = cli(['mod', 'show', '--association', 'ef'.repeat(32), '--data', modDir])
  t.is(other.stderr, 'erro: associação diferente da configurada\n')

  // A certificate for another key, and one from another association.
  const otherKey = assoc.issueModeratorCertificate(assocDir, { moderator: '12'.repeat(32) })
  const otherAssocDir = path.join(root, 'assoc2')
  assoc.initAssociation(otherAssocDir)
  const ownKey = cli(['mod', 'show', '--json', '--data', modDir])
  const foreign = assoc.issueModeratorCertificate(otherAssocDir, { moderator: JSON.parse(ownKey.stdout).publicKey })
  const certFile = path.join(root, 'bad-cert.json')
  fs.writeFileSync(certFile, JSON.stringify(otherKey))
  t.is(cli(['mod', 'cert', 'add', '--cert-file', certFile, '--data', modDir]).stderr, 'erro: certificado da moderação é de outra chave\n')
  fs.writeFileSync(certFile, JSON.stringify(foreign))
  t.is(cli(['mod', 'cert', 'add', '--cert-file', certFile, '--data', modDir]).stderr, 'erro: certificado da moderação inválido (untrusted-association)\n')

  // A damaged list is an error, never a restart at seq 1.
  t.is(cli(['mod', 'block', A, '--no-publish', '--new-list', '--data', modDir]).status, 0)
  fs.writeFileSync(path.join(modDir, 'blocklist.json'), '{"v":1,"snap')
  const damaged = cli(['mod', 'block', B, '--no-publish', '--data', modDir])
  t.is(damaged.status, 1)
  t.is(damaged.stderr, 'erro: lista gravada inválida\n')
  // A parsed null is damaged too, not an absent list.
  fs.writeFileSync(path.join(modDir, 'blocklist.json'), 'null')
  const nulled = cli(['mod', 'block', B, '--no-publish', '--data', modDir])
  t.is(nulled.status, 1)
  t.is(nulled.stderr, 'erro: lista gravada inválida\n')
})

test('--no-publish never calls the network', async (t) => {
  await testnet(t)
  const { modDir, association } = setup(t)
  const modPublish = require('../lib/mod-publish')
  const original = modPublish.publish
  let calls = 0
  modPublish.publish = async () => { calls++; return { delivered: true, peers: 0 } }
  t.teardown(() => { modPublish.publish = original }, { force: true })
  const { commands } = require('../lib/commands/mod')
  const { parseArgs } = require('../lib/cli')
  const flags = parseArgs(['mod', 'block', A, '--no-publish', '--new-list', '--json', '--data', modDir, '--association', association], {}, modDir)
  const write = process.stdout.write
  let out = ''
  process.stdout.write = (chunk) => { out += chunk; return true }
  let code
  try {
    code = await commands.mod.run(flags)
  } finally {
    process.stdout.write = write
  }
  t.is(code, 0)
  t.is(calls, 0)
  t.is(JSON.parse(out).published, false)

  const published = parseArgs(['mod', 'block', B, '--json', '--seeder', C, '--data', modDir], {}, modDir)
  process.stdout.write = (chunk) => { out += chunk; return true }
  try {
    code = await commands.mod.run(published)
  } finally {
    process.stdout.write = write
  }
  t.is(code, 0)
  t.is(calls, 1, 'without the flag the publisher is called')
})

test('two concurrent writes on one dir: the second is refused, nothing is lost', async (t) => {
  await testnet(t)
  const { modDir, association } = setup(t)
  t.is(cli(['mod', 'block', C, '--no-publish', '--new-list', '--data', modDir]).status, 0)
  const base = readList(modDir).seq

  // The first `mod block` holds the lock through its publish (held open here
  // by a stub that waits on a gate), so the second one is certain to run
  // while the first is between its read and its last write.
  const modPublish = require('../lib/mod-publish')
  const original = modPublish.publish
  let entered
  const inPublish = new Promise((resolve) => { entered = resolve })
  let open
  const gate = new Promise((resolve) => { open = resolve })
  modPublish.publish = async () => { entered(); await gate; return { delivered: true, peers: 1 } }
  t.teardown(() => { modPublish.publish = original }, { force: true })
  const { commands } = require('../lib/commands/mod')
  const { parseArgs } = require('../lib/cli')
  const write = process.stdout.write
  let out = ''
  process.stdout.write = (chunk) => { out += chunk; return true }
  let first
  try {
    first = commands.mod.run(parseArgs(['mod', 'block', A, '--seeder', C, '--data', modDir, '--association', association], {}, modDir))
    await inPublish
  } finally {
    process.stdout.write = write
  }

  const second = await cliAsync(['mod', 'block', B, '--no-publish', '--data', modDir])
  t.is(second.status, 1)
  t.is(second.stdout, '')
  t.is(second.stderr, 'erro: outra operação de moderação em andamento\n')
  const cert = cli(['mod', 'cert', 'add', '--cert-file', path.join(modDir, 'moderator-cert.json'), '--data', modDir])
  t.is(cert.stderr, 'erro: outra operação de moderação em andamento\n', 'cert add takes the lock too')
  const shown = cli(['mod', 'show', '--data', modDir])
  t.is(shown.status, 0, 'show is read-only and takes no lock')

  process.stdout.write = (chunk) => { out += chunk; return true }
  let code
  try {
    open()
    code = await first
  } finally {
    process.stdout.write = write
  }
  t.is(code, 0)
  t.is(out, 'conta bloqueada: ' + A + '\nlista seq ' + (base + 1) + ' gravada\nlista publicada\n')
  const after = readList(modDir)
  t.is(after.seq, base + 1)
  t.alike(after.blocked, [A, C].sort(), 'only the successful key')
  t.absent(fs.existsSync(path.join(modDir, '.varanda-lock')), 'the lock is released')
  const logLines = fs.readFileSync(path.join(modDir, 'moderation.jsonl'), 'utf8').split('\n').filter(Boolean)
  t.is(logLines.length, 2, 'the refused command logged nothing')

  const retry = cli(['mod', 'block', B, '--no-publish', '--data', modDir])
  t.is(retry.status, 0, retry.stderr)
  const last = readList(modDir)
  t.is(last.seq, base + 2)
  t.alike(last.blocked, [A, B, C].sort())
  t.alike(acceptSnapshot(after, last, association), { ok: true })
})

function hexOf (buf) {
  return buf.toString('hex')
}

function readConfigFile (modDir) {
  return JSON.parse(fs.readFileSync(path.join(modDir, 'config.json'), 'utf8'))
}

function auditLines (modDir) {
  const file = path.join(modDir, 'moderation.jsonl')
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
}

async function refuseOffer () {
  return { adopted: false, reason: 'stale', added: new Set(), removed: new Set(), revokedAdded: new Set(), revokedRemoved: new Set() }
}

// A raw node reachable by its Noise key (swarm.listen, never a topic): an
// empty corestore for the mux, the blocklist channel, then its admission
// hello (the order the nodes use, C2). certFor(ownKey) gives the seeder
// certificate its hello carries (null: a member hello). With echo, the
// channel never adopts anything and answers the first `have` it receives
// with the same (moderatorDate, seq): all an attacker needs to fake "I hold
// your list" if have values were trusted from anyone. `holding` lists
// snapshots the peer adopts before it listens (the list it already holds).
// It speaks channel 2 (the hidden-posts list, #225) beside channel 1 unless
// `hidden` is false (a seeder from before it); `hiddenAdopted` records the
// seqs adopted there as `adopted` does for channel 1.
async function listeningPeer (t, bootstrap, association, { certFor = () => null, echo = false, holding = [], hidden = true } = {}) {
  const dir = tmpDir(t)
  const store = new Corestore(path.join(dir, 'store'))
  await store.ready()
  const state = createBlocklistState({ association, load: () => null, save: () => {}, saveHidden: () => {} })
  await state.ready()
  for (const snapshot of holding) t.ok((await state.offer(snapshot)).adopted, 'held: seq ' + snapshot.seq)
  // Seqs this peer adopted, recorded as each offer() resolves: blocklist-net.js
  // (offerPending) sends the `have` that tells the publisher "delivered" only
  // after offer() adopted, so once the CLI exits 0 the adoption is already here.
  const adopted = []
  const offer = async (snapshot) => {
    const result = await state.offer(snapshot)
    if (result.adopted) adopted.push(snapshot.seq)
    return result
  }
  const hiddenAdopted = []
  const offerHidden = async (list) => {
    const result = await state.offerHidden(list)
    if (result.adopted) hiddenAdopted.push(list.seq)
    return result
  }
  const swarm = createSwarm({ ...localSwarmOptions(bootstrap), keyPair: generateNoiseKeyPair() })
  t.teardown(() => swarm.destroy(), { force: true })
  t.teardown(() => store.close(), { order: 1, force: true })
  const key = hexOf(swarm.keyPair.publicKey)
  const cert = certFor(key)
  const seen = { connections: 0, echoed: 0 }
  swarm.on('connection', (socket) => {
    socket.on('error', () => {})
    seen.connections++
    store.replicate(socket)
    if (echo) {
      let echoed = null
      attachBlocklist(socket, {
        current: () => echoed,
        offer: refuseOffer,
        compare: compareSnapshots,
        onhave: (have, handle) => {
          if (echoed !== null || have.seq === 0) return
          echoed = { moderatorDate: have.moderatorDate, seq: have.seq }
          seen.echoed++
          handle.announce()
        }
      })
    } else {
      attachBlocklist(socket, { current: state.current, offer, compare: compareSnapshots })
      if (hidden) attachBlocklist(socket, { protocol: PROTOCOL_HIDDEN, current: state.currentHidden, offer: offerHidden, compare: compareSnapshots })
    }
    attachAdmission(socket, cert ? { role: 'seeder', cert, have: [] } : { role: 'member', have: [] })
  })
  await swarm.listen()
  await swarm.flush()
  return { key, state, adopted, hiddenAdopted, seen, swarm }
}

// A peer on the association's public topic only: it must never hear from the publisher.
async function topicListener (t, bootstrap, association) {
  const swarm = createSwarm(localSwarmOptions(bootstrap))
  t.teardown(() => swarm.destroy(), { force: true })
  const seen = { connections: 0 }
  swarm.on('connection', (socket) => {
    socket.on('error', () => {})
    seen.connections++
  })
  await joinAndFlush(swarm, [topicFor(association)])
  return seen
}

const PUBLISH_FAILED = 'erro: não foi possível publicar a lista\na lista ficou gravada; rode mod publish quando o semeador estiver no ar\n'

test('publish delivers to the certified seeder by its key, never through the topic', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const { assocDir, modDir, association } = setup(t)
  const seeder = await listeningPeer(t, bootstrap, association, {
    certFor: (key) => assoc.issueSeederCertificate(assocDir, { seeder: key })
  })
  const onTopic = await topicListener(t, bootstrap, association)

  // The seeder key is stored once by `mod init --seeder` on the existing dir.
  const before = readConfigFile(modDir)
  const stored = cli(['mod', 'init', '--seeder', seeder.key, '--data', modDir])
  t.is(stored.status, 0, stored.stderr)
  t.alike(readConfigFile(modDir), { ...before, seeder: seeder.key }, 'only the seeder field changes')

  const res = await cliAsync(['mod', 'block', A, '--new-list', '--data', modDir, '--timeout-ms', '60000', ...bootstrapFlags(bootstrap)])
  t.is(res.status, 0, res.stderr)
  t.is(res.stdout, 'conta bloqueada: ' + A + '\nlista seq 1 gravada\nlista publicada\n')
  t.absent(/\d+\.\d+\.\d+\.\d+:\d+/.test(res.stdout + res.stderr), 'no peer address printed')
  // No polling: delivery (exit 0) is the seeder's post-adoption `have`.
  t.alike(seeder.adopted, [1], 'adopted before the CLI reported delivery')
  t.alike(seeder.state.current(), readList(modDir))
  t.alike([...seeder.state.blocked()], [A])

  // `mod publish` re-sends the stored list: no seq bump, no audit line.
  const listBefore = fs.readFileSync(path.join(modDir, 'blocklist.json'), 'utf8')
  const again = await cliAsync(['mod', 'publish', '--data', modDir, '--timeout-ms', '60000', ...bootstrapFlags(bootstrap)])
  t.is(again.status, 0, again.stderr)
  t.is(again.stdout, 'lista seq 1 publicada\n')
  t.is(fs.readFileSync(path.join(modDir, 'blocklist.json'), 'utf8'), listBefore, 'the list is unchanged')
  t.is(auditLines(modDir).length, 1, 'no moderation.jsonl line')
  t.alike(seeder.adopted, [1])

  const second = await cliAsync(['mod', 'block', B, '--data', modDir, '--timeout-ms', '60000', ...bootstrapFlags(bootstrap)])
  t.is(second.status, 0, second.stderr)
  t.alike(seeder.adopted, [1, 2])
  t.alike([...seeder.state.blocked()].sort(), [A, B])

  // The topic is never joined. Two checks: a peer that only listens on the
  // association topic got no connection from the three CLI publishes above
  // (end to end, in the child processes), and an in-process publish with
  // Hyperswarm.prototype.join spied never calls it (the direct proof: the
  // listener alone could miss a join whose lookup was slow).
  t.is(onTopic.connections, 0, 'no connection through the public topic')
  const Hyperswarm = require('hyperswarm')
  const join = Hyperswarm.prototype.join
  let joins = 0
  Hyperswarm.prototype.join = function (...args) { joins++; return join.apply(this, args) }
  t.teardown(() => { Hyperswarm.prototype.join = join }, { force: true })
  const modPublish = require('../lib/mod-publish')
  let result
  try {
    result = await modPublish.publish({ snapshot: readList(modDir), association, seeder: seeder.key, bootstrap, host: '127.0.0.1', timeoutMs: 60000 })
  } finally {
    Hyperswarm.prototype.join = join
  }
  t.is(result.delivered, true)
  t.is(joins, 0, 'swarm.join never called')
})

test('mod hide publishes the hidden-posts list on channel 2, and mod publish sends both lists', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const { assocDir, modDir, association } = setup(t)
  const seeder = await listeningPeer(t, bootstrap, association, {
    certFor: (key) => assoc.issueSeederCertificate(assocDir, { seeder: key })
  })
  t.is(cli(['mod', 'init', '--seeder', seeder.key, '--data', modDir]).status, 0)
  const net = ['--data', modDir, '--timeout-ms', '60000', ...bootstrapFlags(bootstrap)]

  const hid = await cliAsync(['mod', 'hide', B, '4', '--new-list', ...net])
  t.is(hid.status, 0, hid.stderr)
  t.is(hid.stdout, 'publicação oculta: ' + B + ':4\nlista de publicações ocultas seq 1 gravada\nlista publicada\n')
  // No polling: delivery (exit 0) is the seeder's post-adoption `have`.
  t.alike(seeder.hiddenAdopted, [1], 'adopted on channel 2 before the CLI reported delivery')
  t.alike(seeder.state.currentHidden(), readHidden(modDir))
  t.alike([...seeder.state.hiddenPosts().get(B)], [4])
  t.is(seeder.state.current(), null, 'channel 1 untouched')

  // `mod publish` re-sends both stored lists: no seq bump, no audit line.
  t.is(cli(['mod', 'block', A, '--new-list', '--no-publish', '--data', modDir]).status, 0)
  const both = await cliAsync(['mod', 'publish', ...net])
  t.is(both.status, 0, both.stderr)
  t.is(both.stdout, 'lista seq 1 publicada\nlista de publicações ocultas seq 1 publicada\n')
  t.alike(seeder.adopted, [1])
  t.alike(seeder.hiddenAdopted, [1], 'the stored hidden list is not adopted twice')
  t.is(auditLines(modDir).length, 2, 'one line for the hide, one for the block')
  const json = await cliAsync(['mod', 'publish', '--json', ...net])
  t.is(json.status, 0, json.stderr)
  t.alike(JSON.parse(json.stdout.trim().split('\n').pop()), { op: 'publish', published: true, snapshot: readList(modDir), hiddenList: readHidden(modDir) })
})

test('a seeder without the hidden-posts channel: mod hide keeps the list and says the seeder must update', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const { assocDir, modDir, association } = setup(t)
  const seeder = await listeningPeer(t, bootstrap, association, {
    certFor: (key) => assoc.issueSeederCertificate(assocDir, { seeder: key }),
    hidden: false
  })
  t.is(cli(['mod', 'init', '--seeder', seeder.key, '--data', modDir]).status, 0)
  const res = await cliAsync(['mod', 'hide', B, '4', '--new-list', '--data', modDir, '--timeout-ms', '60000', ...bootstrapFlags(bootstrap)])
  t.is(res.status, 1)
  t.is(res.stdout, 'publicação oculta: ' + B + ':4\nlista de publicações ocultas seq 1 gravada\n')
  t.is(res.stderr, 'erro: o semeador ainda não recebe a lista de publicações ocultas\na lista ficou gravada; rode mod publish depois de atualizar o semeador\n')
  t.is(readHidden(modDir).seq, 1, 'the list stays stored')
  t.is(seeder.state.currentHidden(), null)
})

test('an echoing peer or a seeder certificate for another key never counts as delivery', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const { assocDir, modDir, association } = setup(t)
  t.is(cli(['mod', 'block', A, '--no-publish', '--new-list', '--data', modDir]).status, 0)

  // An uncertified (member hello) echo attacker, dialed as if it were the seeder.
  const attacker = await listeningPeer(t, bootstrap, association, { echo: true })
  const res = await cliAsync(['mod', 'publish', '--seeder', attacker.key, '--data', modDir, '--timeout-ms', '6000', ...bootstrapFlags(bootstrap)])
  t.is(res.status, 1)
  t.is(res.stdout, '')
  t.is(res.stderr, PUBLISH_FAILED)
  t.ok(attacker.seen.connections > 0, 'the attacker was reached')
  t.ok(attacker.seen.echoed > 0, 'and echoed the publisher\'s have')

  // A seeder hello carrying a valid association certificate, but for another Noise key.
  const foreign = await listeningPeer(t, bootstrap, association, {
    echo: true,
    certFor: () => assoc.issueSeederCertificate(assocDir, { seeder: 'ef'.repeat(32) })
  })
  const res2 = await cliAsync(['mod', 'block', B, '--seeder', foreign.key, '--data', modDir, '--timeout-ms', '6000', ...bootstrapFlags(bootstrap)])
  t.is(res2.status, 1)
  t.is(res2.stdout, 'conta bloqueada: ' + B + '\nlista seq 2 gravada\n')
  t.is(res2.stderr, PUBLISH_FAILED)
  t.ok(foreign.seen.connections > 0 && foreign.seen.echoed > 0, 'the foreign seeder was reached and echoed')
  t.is(readList(modDir).seq, 2, 'the signed list stays written')
})

const PUBLISH_CONFLICT = 'erro: o semeador já tem outra lista com o mesmo número (seq 2); isto acontece ao restaurar uma cópia antiga da moderação\n' +
  'faça uma nova alteração (ela recebe um número maior) ou rode mod publish depois de recuperar a lista mais recente\n'

test('a certified seeder holding another list with the same seq is a conflict, not a delivery', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const { assocDir, modDir, association } = setup(t)
  const listFile = path.join(modDir, 'blocklist.json')
  t.is(cli(['mod', 'block', A, '--no-publish', '--new-list', '--data', modDir]).status, 0)
  const backup = fs.readFileSync(listFile, 'utf8') // seq 1
  t.is(cli(['mod', 'block', B, '--no-publish', '--data', modDir]).status, 0)
  const held = readList(modDir) // seq 2: [A, B], what the seeder holds

  const seeder = await listeningPeer(t, bootstrap, association, {
    certFor: (key) => assoc.issueSeederCertificate(assocDir, { seeder: key }),
    holding: [JSON.parse(backup).snapshot, held]
  })

  // The operator restores the seq 1 backup and signs a DIFFERENT seq 2.
  fs.writeFileSync(listFile, backup)
  const started = Date.now()
  const res = await cliAsync(['mod', 'block', C, '--seeder', seeder.key, '--data', modDir, '--timeout-ms', '60000', ...bootstrapFlags(bootstrap)])
  t.is(res.status, 1)
  t.is(res.stdout, 'conta bloqueada: ' + C + '\nlista seq 2 gravada\n', 'no lista publicada')
  t.is(res.stderr, PUBLISH_CONFLICT)
  t.ok(Date.now() - started < 45000, 'stops at once, not on the timeout')
  const ours = readList(modDir)
  t.is(ours.seq, 2, 'the signed list stays written')
  t.alike(ours.blocked, [A, C].sort())
  t.not(ours.signature, held.signature)
  t.alike(seeder.state.current(), held, 'the seeder keeps its own list')

  // `mod publish` of the same conflicting list: the same answer.
  const again = await cliAsync(['mod', 'publish', '--seeder', seeder.key, '--data', modDir, '--timeout-ms', '60000', ...bootstrapFlags(bootstrap)])
  t.is(again.status, 1)
  t.is(again.stdout, '')
  t.is(again.stderr, PUBLISH_CONFLICT)

  // A new change gets a higher seq and is delivered normally.
  const next = await cliAsync(['mod', 'block', B, '--seeder', seeder.key, '--data', modDir, '--timeout-ms', '60000', ...bootstrapFlags(bootstrap)])
  t.is(next.status, 0, next.stderr)
  t.is(next.stdout, 'conta bloqueada: ' + B + '\nlista seq 3 gravada\nlista publicada\n')
  t.alike(seeder.adopted, [3])
  t.alike(seeder.state.current(), readList(modDir))
})

test('publish with no reachable seeder times out, exits 1 and keeps the signed list', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const { modDir } = setup(t)
  const started = Date.now()
  const res = await cliAsync(['mod', 'block', A, '--new-list', '--seeder', C, '--data', modDir, '--timeout-ms', '1500', ...bootstrapFlags(bootstrap)])
  t.is(res.status, 1)
  t.is(res.stdout, 'conta bloqueada: ' + A + '\nlista seq 1 gravada\n')
  t.is(res.stderr, PUBLISH_FAILED)
  t.ok(Date.now() - started < 30000)
  t.is(readList(modDir).seq, 1)
  t.alike(readList(modDir).blocked, [A])
})

test('a missing seeder key or a missing/extra --new-list refuses before signing', async (t) => {
  await testnet(t)
  const { root, assocDir, modDir, association } = setup(t)
  const listFile = path.join(modDir, 'blocklist.json')

  // No --seeder and none stored: nothing signed, for every publishing command.
  for (const args of [['block', A, '--new-list'], ['unblock', A, '--new-list'], ['revoke-issuer', ISSUER, '--new-list'], ['unrevoke-issuer', ISSUER, '--new-list'], ['publish']]) {
    const res = cli(['mod', ...args, '--data', modDir])
    t.is(res.status, 1, args[0])
    t.is(res.stderr, 'erro: informe --seeder <chave do semeador> (seed status a mostra) ou use --no-publish\n')
    t.absent(fs.existsSync(listFile), 'nothing signed')
  }
  t.is(auditLines(modDir).length, 0)

  // No previous list: refused without --new-list (F2), nothing signed.
  const first = cli(['mod', 'block', A, '--no-publish', '--data', modDir])
  t.is(first.status, 1)
  t.is(first.stderr, 'erro: este diretório não tem lista anterior; copie o blocklist.json da moderação anterior para cá ou, se é a primeira lista da associação, use --new-list\n')
  t.absent(fs.existsSync(listFile))
  const withSeeder = cli(['mod', 'revoke-issuer', ISSUER, '--seeder', C, '--data', modDir])
  t.is(withSeeder.status, 1)
  t.ok(withSeeder.stderr.startsWith('erro: este diretório não tem lista anterior'))
  t.absent(fs.existsSync(listFile))

  // `mod publish` of a dir without a list.
  const empty = cli(['mod', 'publish', '--seeder', C, '--data', modDir])
  t.is(empty.status, 1)
  t.is(empty.stderr, 'erro: nenhuma lista para publicar\n')
  t.is(cli(['mod', 'publish', '--no-publish', '--data', modDir]).status, 2, '--no-publish makes no sense here')

  t.is(cli(['mod', 'block', A, '--no-publish', '--new-list', '--data', modDir]).status, 0)
  const listed = fs.readFileSync(listFile, 'utf8')
  const extra = cli(['mod', 'block', B, '--no-publish', '--new-list', '--data', modDir])
  t.is(extra.status, 1)
  t.is(extra.stderr, 'erro: este diretório já tem uma lista\n')
  t.is(fs.readFileSync(listFile, 'utf8'), listed, 'the existing list is untouched')

  // With a list, a missing seeder still refuses before signing.
  const noSeeder = cli(['mod', 'block', B, '--data', modDir])
  t.is(noSeeder.status, 1)
  t.is(fs.readFileSync(listFile, 'utf8'), listed)
  t.is(auditLines(modDir).length, 1)

  // A rotation: a fresh dir (newer moderator certificate) continues from a
  // copied blocklist.json, no --new-list, and keeps the earlier block.
  const newDir = path.join(root, 'mod2')
  const init = cli(['mod', 'init', '--association', association, '--seeder', C, '--data', newDir])
  t.is(init.status, 0, init.stderr)
  t.is(readConfigFile(newDir).seeder, C)
  const moderator = /([0-9a-f]{64})/.exec(init.stdout)[1]
  const certFile = path.join(root, 'moderator2-cert.json')
  fs.writeFileSync(certFile, JSON.stringify(assoc.issueModeratorCertificate(assocDir, { moderator })))
  t.is(cli(['mod', 'cert', 'add', '--cert-file', certFile, '--data', newDir]).status, 0)
  fs.copyFileSync(listFile, path.join(newDir, 'blocklist.json'))
  const rotated = cli(['mod', 'block', B, '--no-publish', '--data', newDir])
  t.is(rotated.status, 0, rotated.stderr)
  const next = readList(newDir)
  t.is(next.seq, 2)
  t.alike(next.blocked, [A, B].sort(), 'the earlier block survives the rotation')
  t.alike(acceptSnapshot(readList(modDir), next, association), { ok: true })
})
