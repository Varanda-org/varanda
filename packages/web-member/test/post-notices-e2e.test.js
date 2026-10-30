// Reply, quote and mention notices end to end: a real seeder behind a
// WebSocket server (its diary scan folds posts and username records and
// serves 'varanda/notices/2') and three real browser nodes (lib/node.js over
// in-memory storage) that re-verify every row against signed blocks. A holds
// a verified @nome; B, who A does not follow and who does not follow A,
// replies to, quotes and mentions A; C sees none of it. Loopback only.
const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { WebSocketServer, createWebSocketStream } = require('ws')
const { testnet, tmpDir, localSwarmOptions, until } = require('./helpers/net')
const { stoppedOf } = require('./helpers/session')
const { HOUR, HEX32, noop, association, moderator, snapshot, issuer, iso, webNode, seenOf } = require('./helpers/notices')
const { Seeder } = require('@varanda/core/lib/seeder')
const { createSeederCert, createUsernameRecord } = require('@varanda/core/lib/cert')
const { writeBlocklist } = require('../lib/node-store')

// A confirmed push (notices-e2e.test.js): a once sync that finished, succeeded
// and that the seeder confirmed holding, retried a bounded number of times.
async function push (t, n, label, { attempts = 5 } = {}) {
  let stopped = null
  for (let i = 0; i < attempts; i++) {
    const { runId } = await n.web.request('sync.start', { once: true, timeoutMs: 30000 })
    stopped = await stoppedOf(n.web.events, runId)
    if (stopped.reason === 'done' && stopped.result && stopped.result.ok === true && stopped.result.seederConfirmed === true) break
    t.comment(label + ': attempt ' + (i + 1) + ' not confirmed: ' + JSON.stringify(stopped))
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  t.is(stopped.reason, 'done', label + ' done')
  t.is(stopped.result && stopped.result.ok, true, label + ' ok')
  t.is(stopped.result && stopped.result.seederConfirmed, true, label + ' seeder confirmed')
  return stopped
}

// A settled notices.list read: supported and complete (an empty list from a
// read that timed out proves nothing), polled until `ok` holds.
function settledRead (web, name, ok = () => true) {
  return until(async () => {
    const r = await web.request('notices.list', {})
    return r.supported === true && r.incomplete === false && ok(r) ? r : null
  }, { name, intervalMs: 250, timeoutMs: 45000 })
}

function rowsOf (r) {
  return r.notices.map((n) => [n.key, n.seq, n.kind])
}

function hasRow (r, seq, kind) {
  return r.notices.some((n) => n.seq === seq && n.kind === kind)
}

// Every key of every object reachable from v (packages/core/test/notices.test.js).
function allKeys (v, out = []) {
  if (v !== null && typeof v === 'object') {
    for (const key of Object.keys(v)) {
      out.push(key)
      allKeys(v[key], out)
    }
  }
  return out
}

test('post notices end to end: reply, quote, mention, follow, self and forged refs, rename, other member, block', async (t) => {
  t.timeout(300000)
  const now = Date.now()
  const { bootstrap } = await testnet(t)
  const assoc = association()
  const iss = issuer(assoc)
  const mod = moderator(assoc.kp)

  // The real seeder.
  const seederDir = tmpDir(t, 'varanda-post-notices-e2e-seed-')
  Seeder.ensureConfig(seederDir, assoc.hex)
  const { publicKey: seederKey } = Seeder.createKey(seederDir)
  const certFile = path.join(tmpDir(t, 'varanda-post-notices-e2e-sc-'), 'seeder-cert.json')
  fs.writeFileSync(certFile, JSON.stringify(createSeederCert({ seeder: seederKey }, assoc.kp)))
  Seeder.addCert(seederDir, certFile, assoc.hex)
  const seeder = new Seeder({ dataDir: seederDir, ...localSwarmOptions(bootstrap), log: noop })
  t.teardown(() => seeder.close(), { force: true })
  await seeder.start()
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve) => wss.once('listening', resolve))
  t.teardown(() => {
    for (const s of wss.clients) s.terminate()
    return new Promise((resolve) => wss.close(() => resolve()))
  }, { force: true })
  wss.on('connection', (ws) => {
    const raw = createWebSocketStream(ws)
    raw.on('error', noop)
    seeder.acceptStream(raw)
  })
  const url = 'ws://127.0.0.1:' + wss.address().port + '/seeder'

  // Three certified browser nodes. A's seed is copied for the seen formula
  // (a lock zeroes the pair).
  const kpA = crypto.keyPair()
  const seedA = b4a.from(kpA.secretKey.subarray(0, 32))
  const A = await webNode(t, assoc, url, { certify: true, keyPair: kpA })
  const B = await webNode(t, assoc, url, { certify: true })
  const C = await webNode(t, assoc, url, { certify: true })
  const profile = await A.web.request('profile.set', { name: 'Ana' })
  await B.web.request('profile.set', { name: 'Bia' })
  const named = await A.web.request('username.add', { record: createUsernameRecord({ member: A.key, username: 'ana', date: iso(now - 10 * HOUR) }, iss.keyPair, iss.cert) })
  t.is(named.changed, true, 'A holds @ana')
  const own = await A.web.request('post.create', { text: 'meu post' })
  for (const n of [A, B, C]) await push(t, n, 'pushed')
  for (const n of [A, B, C]) {
    await until(() => { const e = seeder._served.get(n.key); return e && e.gated }, { name: 'served', timeoutMs: 30000 })
  }
  const ownRef = A.key + ':' + own.seq

  // A replies to and mentions itself: never a row.
  await A.web.request('post.reply', { to: ownRef, text: 'eu mesma, @ana' })
  await A.web.request('post.create', { text: '@ana oi' })
  await push(t, A, 'A pushed the self posts')

  // B replies, quotes, mentions, replies with a mention (one reply row) and
  // replies to A's profile block (not a post: no row).
  const reply = await B.web.request('post.reply', { to: ownRef, text: 'concordo' })
  const quote = await B.web.request('post.quote', { to: ownRef, text: 'olha isso' })
  const mention = await B.web.request('post.create', { text: 'oi @ana!' })
  const both = await B.web.request('post.reply', { to: ownRef, text: 'e mais, @ana' })
  await B.web.request('post.reply', { to: A.key + ':' + profile.seq, text: 'a um perfil' })
  await push(t, B, 'B pushed the posts')

  const expected = [
    [B.key, both.seq, 'reply'],
    [B.key, mention.seq, 'mention'],
    [B.key, quote.seq, 'quote'],
    [B.key, reply.seq, 'reply']
  ]
  const first = await settledRead(A.web, 'A sees four rows', (r) => r.notices.length >= 4)
  t.alike(rowsOf(first), expected, 'one row per block, kind from the signed block, nothing else')
  for (const n of first.notices) {
    t.is(n.name, 'Bia', 'the author name')
    t.is(n.username, null, 'B holds no @nome')
    t.ok(HEX32.test(n.seen), 'a 32-hex seen token')
  }
  t.is(first.activity, true, 'activity')
  t.is(first.next, null)
  t.is(first.incomplete, false, 'the non-post reply does not mark incomplete')
  t.is(new Set(first.notices.map((n) => n.seen)).size, 4, 'one seen token per block')
  const banned = ['count', 'total', 'unread']
  t.absent(allKeys(first).some((key) => banned.includes(key)), 'no count in the result')

  // C sees none of it.
  const cList = await settledRead(C.web, 'C settled')
  t.alike(cList.notices, [], 'C cannot see A\'s notices')

  // B follows A: a follow row, its seen token the follows-only formula.
  await B.web.request('follow.add', { key: A.key })
  await push(t, B, 'B pushed the follow')
  const withFollow = await settledRead(A.web, 'A sees the follow', (r) => r.notices.some((n) => n.kind === 'follow'))
  const follow = withFollow.notices.find((n) => n.kind === 'follow')
  t.is(follow.key, B.key)
  t.is(follow.name, 'Bia')
  t.is(follow.seen, seenOf(seedA, A.key, B.key, follow.seq), 'the seen formula is unchanged')
  t.alike(rowsOf(withFollow).filter((r) => r[2] !== 'follow'), expected, 'the post rows stay')

  // A follows B back: only the follow row goes.
  await A.web.request('follow.add', { key: B.key })
  const back = await settledRead(A.web, 'follow back settled')
  t.alike(rowsOf(back), expected, 'a followed author keeps the post rows, not the follow row')
  await A.web.request('follow.remove', { key: B.key })

  // A renames to @ana2: a later mention of @ana still arrives.
  await A.web.request('username.add', { record: createUsernameRecord({ member: A.key, username: 'ana2', date: iso(now - 5 * HOUR) }, iss.keyPair, iss.cert) })
  await push(t, A, 'A pushed the rename')
  const later = await B.web.request('post.create', { text: '@ana de novo' })
  await push(t, B, 'B pushed the later mention')
  const renamed = await settledRead(A.web, 'A sees the old-name mention', (r) => hasRow(r, later.seq, 'mention'))
  t.ok(hasRow(renamed, mention.seq, 'mention'), 'the earlier mention stays')
  t.ok(renamed.notices.every((n) => n.key === B.key), 'only B\'s rows')

  // A blocklist snapshot blocking B removes every row on the next read.
  await writeBlocklist(A.storage, snapshot(mod, { seq: 1, blocked: [B.key] }))
  const blocked = await settledRead(A.web, 'blocked settled')
  t.alike(blocked.notices, [], 'a blocked author\'s rows are dropped')

  for (const n of [A, B, C]) t.alike(n.internal, [], 'no internal error')
  for (const n of [A, B, C]) {
    n.web.port.close()
    for (const s of n.sockets) s.terminate()
  }
})
