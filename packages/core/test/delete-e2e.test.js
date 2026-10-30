'use strict'

// Deletion end to end between node sessions (lib/session.js through a real
// dispatcher + client pair) on the loopback testnet: an author deletes a
// post, a reply and a quote; a follower that syncs through a certified seeder
// stops showing them (feed.read, log.read 'deleted'); a tombstone in another
// diary naming the author's seq changes nothing in the author's diary; a
// tombstone of a tombstone, which the writer refuses to emit, makes the first
// ineffective on the follower too; and a truncated author diary still reads
// as a fork, the way the protocol always detected it (lib/net.js watchFork).
const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const { tmpDir } = require('./helpers/tmp')
const { testnet, localSwarmOptions, until, newSession, connect, failure } = require('./helpers/net')
const { initAssociation, issueCertificate, issueSeederCertificate } = require('../lib/assoc')
const storeLib = require('../lib/store')
const { postRecord, deleteRecord } = require('../lib/records')
const { Seeder } = require('../lib/seeder')

const OTHER = 'ab'.repeat(32)
const BAD_REF = { code: 'USAGE', message: 'referência inválida' }
const NOT_DELETABLE = { code: 'USAGE', message: 'não é possível apagar este registro' }

function association (t) {
  const dir = path.join(tmpDir(t, 'varanda-assoc-'), 'assoc')
  const { publicKey } = initAssociation(dir)
  return { dir, hex: publicKey }
}

async function startSeeder (t, bootstrap, assoc) {
  const dataDir = tmpDir(t, 'varanda-seed-')
  Seeder.ensureConfig(dataDir, assoc.hex)
  const { publicKey } = Seeder.createKey(dataDir)
  const certFile = path.join(tmpDir(t, 'varanda-sc-'), 'seeder-cert.json')
  fs.writeFileSync(certFile, JSON.stringify(issueSeederCertificate(assoc.dir, { seeder: publicKey })))
  Seeder.addCert(dataDir, certFile, assoc.hex)
  const seeder = new Seeder({ dataDir, ...localSwarmOptions(bootstrap) })
  t.teardown(() => seeder.close(), { force: true })
  await seeder.start()
  return seeder
}

async function member (t, bootstrap, assoc) {
  const dataDir = tmpDir(t)
  const session = newSession(t, { dataDir, association: assoc.hex, bootstrap })
  const link = await connect(t, session)
  const { publicKey } = await link.call('identity.create')
  await link.call('cert.add', { cert: issueCertificate(assoc.dir, { member: publicKey }) })
  return { dataDir, session, publicKey, ...link }
}

// Appends straight to the diary while the session is idle (it holds no store
// open between calls), for records the writer never emits.
async function appendDirect (dataDir, records) {
  const s = await storeLib.openStore(dataDir)
  try {
    const diary = await storeLib.openDiary(s)
    let seq = null
    for (const r of records) seq = await storeLib.appendRecord(diary, r)
    return seq
  } finally {
    await s.close()
  }
}

function eventOf (m, event, match = () => true) {
  return m.events.find((e) => e.event === event && match(e.data))
}

async function syncOnce (t, m, label) {
  const { runId } = await m.call('sync.start', { once: true, timeoutMs: 30000 })
  const stopped = await until(() => eventOf(m, 'sync.stopped', (d) => d.runId === runId), { timeoutMs: 60000, name: label })
  t.is(stopped.data.reason, 'done', label + ' done')
  t.is(stopped.data.result.ok, true, label + ' ok')
  return stopped.data.result
}

// Once runs of the follower until its replica of `author` reaches `length`
// (a once run ends when the seeder it reached is caught up, so one run is
// normally enough; a second covers a seeder still taking the author's tail).
async function followerSync (t, b, author, length, label) {
  for (let i = 0; i < 3; i++) {
    await syncOnce(t, b, label + ' #' + (i + 1))
    const log = await b.call('log.read', { author })
    if (log.entries.length + log.invalid.length >= length) return
  }
  t.fail(label + ': the follower never reached length ' + length)
}

function postTexts (feed, author) {
  return feed.items.filter((i) => i.kind === 'post' && i.author === author).map((i) => [i.seq, i.text]).sort((x, y) => x[0] - y[0])
}

function bySeq (list) {
  return list.slice().sort((a, b) => a.seq - b.seq)
}

test('a follower stops showing deleted posts; a foreign tombstone changes nothing; an undo is deterministic', async (t) => {
  await deletionScenario(t, { clearing: true })
})

test('with byte clearing off (VARANDA_NO_CLEAR=1), an undone deletion brings the post back', async (t) => {
  const before = process.env.VARANDA_NO_CLEAR
  process.env.VARANDA_NO_CLEAR = '1'
  t.teardown(() => {
    if (before === undefined) delete process.env.VARANDA_NO_CLEAR
    else process.env.VARANDA_NO_CLEAR = before
  }, { order: Infinity })
  await deletionScenario(t, { clearing: false })
})

async function deletionScenario (t, { clearing }) {
  t.timeout(300000)
  const { bootstrap } = await testnet(t)
  const assoc = association(t)
  await startSeeder(t, bootstrap, assoc)

  const a = await member(t, bootstrap, assoc)
  await a.call('profile.set', { name: 'Ana' })
  const post = await a.call('post.create', { text: 'um' })
  const reply = await a.call('post.reply', { to: post.ref, text: 'resposta' })
  const quote = await a.call('post.quote', { to: post.ref, text: 'citação' })
  const keep = await a.call('post.create', { text: 'fica' })
  t.alike([post.seq, reply.seq, quote.seq, keep.seq], [2, 3, 4, 5])
  await syncOnce(t, a, 'author sync')

  const b = await member(t, bootstrap, assoc)
  await b.call('follow.add', { key: a.publicKey })
  await followerSync(t, b, a.publicKey, 6, 'follower first sync')
  t.alike(postTexts(await b.call('feed.read'), a.publicKey), [[2, 'um'], [3, 'resposta'], [4, 'citação'], [5, 'fica']], 'the follower sees all four')

  const d1 = await a.call('post.delete', { to: post.ref })
  const d2 = await a.call('post.delete', { to: reply.ref })
  const d3 = await a.call('post.delete', { to: a.publicKey + ':' + quote.seq })
  t.alike([d1.deleted, d2.deleted, d3.deleted], [[2], [3], [4]])
  t.alike([d1.seq, d2.seq, d3.seq], [6, 7, 8])
  await syncOnce(t, a, 'author sync after delete')
  await followerSync(t, b, a.publicKey, 9, 'follower sync after delete')

  t.alike(postTexts(await b.call('feed.read'), a.publicKey), [[5, 'fica']], 'only the kept post on the follower')
  const seen = await b.call('log.read', { author: a.publicKey })
  t.alike(bySeq(seen.invalid), [2, 3, 4].map((seq) => ({ seq, reason: 'deleted' })), 'log.read reports the deleted slots')
  t.alike(seen.entries.filter((e) => e.record.type === 'delete').map((e) => e.record.seq), [2, 3, 4], 'the tombstones themselves are readable')
  t.absent(JSON.stringify(seen.entries).includes('"resposta"'), 'no deleted text in the log page')

  // Another member's tombstone carries no author: it names a seq of its OWN
  // diary, so it can only hide that member's block, never the author's.
  const c = await member(t, bootstrap, assoc)
  for (let i = 1; i <= 5; i++) await c.call('post.create', { text: 'c' + i })
  t.alike(await failure(c.call('post.delete', { to: a.publicKey + ':' + keep.seq })), BAD_REF, 'the writer refuses another author')
  t.is(await appendDirect(c.dataDir, [deleteRecord({ seq: keep.seq })]), 6)
  await syncOnce(t, c, 'other member sync')
  await b.call('follow.add', { key: c.publicKey })
  await followerSync(t, b, c.publicKey, 7, 'follower sync of the other member')
  const mixed = await b.call('feed.read')
  t.alike(postTexts(mixed, a.publicKey), [[5, 'fica']], 'the author\'s post is untouched')
  t.alike(postTexts(mixed, c.publicKey).map(([seq]) => seq), [1, 2, 3, 4], 'the tombstone hid only the other member\'s own block 5')

  // A tombstone of a tombstone: the writer never emits it, and a replica that
  // folds it makes the first tombstone ineffective, as on the author's node.
  // With clearing on, the post's bytes are already gone everywhere, so it
  // stays absent, and the hole never hides the blocks after it.
  t.alike(await failure(a.call('post.delete', { to: d1.ref })), NOT_DELETABLE, 'the writer refuses to delete a tombstone')
  t.is(await appendDirect(a.dataDir, [deleteRecord({ seq: d1.seq })]), 9)
  const after = await a.call('post.create', { text: 'depois' })
  t.is(after.seq, 10)
  const shown = clearing ? [[5, 'fica'], [10, 'depois']] : [[2, 'um'], [5, 'fica'], [10, 'depois']]
  t.alike(postTexts(await a.call('feed.read'), a.publicKey), shown, clearing ? 'the cleared post stays absent on the author\'s node, later posts stay visible' : 'the post is back on the author\'s node')
  await syncOnce(t, a, 'author sync after undo')
  await followerSync(t, b, a.publicKey, 11, 'follower sync after undo')
  t.alike(postTexts(await b.call('feed.read'), a.publicKey), shown, 'and on the follower')
  const undone = await b.call('log.read', { author: a.publicKey })
  const slots = [3, 4, 6].map((seq) => ({ seq, reason: 'deleted' }))
  if (clearing) slots.unshift({ seq: 2, reason: 'malformed' })
  t.alike(bySeq(undone.invalid), slots, clearing ? 'the undone tombstone is the deleted slot now, the revived seq has no record' : 'the undone tombstone is the deleted slot now')
  t.ok(undone.entries.some((e) => e.seq === 10), 'the follower reads past the revived seq')

  for (const m of [a, b, c]) t.alike(m.session.internal, [], 'no internal error')
}

test('a truncated author diary is still a fork on the follower', async (t) => {
  t.timeout(300000)
  const { bootstrap } = await testnet(t)
  const assoc = association(t)
  const a = await member(t, bootstrap, assoc)
  const post = await a.call('post.create', { text: 'um' })
  await a.call('post.create', { text: 'dois' })
  await a.call('post.delete', { to: post.ref })

  const b = await member(t, bootstrap, assoc)
  await b.call('follow.add', { key: a.publicKey })
  await a.call('sync.start')
  await b.call('sync.start')
  await until(() => eventOf(b, 'sync.event', (d) => d.line === 'downloaded ' + a.publicKey + ' 4'), { timeoutMs: 60000, name: 'downloaded 4' })
  await b.call('sync.stop')
  await a.call('sync.stop')
  t.alike(postTexts(await b.call('feed.read'), a.publicKey), [[2, 'dois']], 'the deleted post is hidden on a direct replica too')

  const s = await storeLib.openStore(a.dataDir)
  try {
    const diary = await storeLib.openDiary(s)
    await diary.truncate(2, { fork: 1 })
    await storeLib.appendRecord(diary, postRecord({ text: 'reescrito' }))
  } finally {
    await s.close()
  }
  await a.call('sync.start')
  await b.call('sync.start')
  const fork = 'aviso: diário ' + a.publicKey.slice(0, 8) + ' ignorado (fork)'
  await until(() => eventOf(b, 'warning', (d) => d.line === fork), { timeoutMs: 60000, name: 'fork warning' })
  t.pass('the follower reported the fork')
  await b.call('sync.stop')
  await a.call('sync.stop')
  t.absent(postTexts(await b.call('feed.read'), a.publicKey).some(([, text]) => text === 'reescrito'), 'the rewritten history is never shown')
  t.alike(b.session.internal, [], 'no internal error')
})

test('the app worklet runs the same session dispatcher, with no handler of its own for deletion', async (t) => {
  const main = fs.readFileSync(path.join(__dirname, '../../../apps/app/worklet/main.js'), 'utf8')
  t.ok(main.includes("require('@varanda/core/lib/session')"), 'the worklet builds the node session')
  t.absent(/post\.delete|profile\.delete/.test(main), 'no duplicate handler in the worklet')
  const session = newSession(t, { dataDir: tmpDir(t), association: OTHER, bootstrap: ['127.0.0.1:49737'] })
  t.is(typeof session.handlers['post.delete'], 'function')
  t.is(typeof session.handlers['profile.delete'], 'function')
})
