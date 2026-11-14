// post.shared, post.share and post.unshare on the browser node (docs/rpc.md
// 5.121 to 5.123): lib/session.js through lib/node.js and an in-memory
// client, member-ops' live-share walk, on memory storage. Any live share
// counts, the target must be a live post of the own diary, a locked
// identity reads but never writes, and a write pushes to the seeder. Most
// tests dial a loopback port nothing listens on with the write gate off;
// the push test uses a loopback seeder stand-in, as sync-gate.test.js does.
const test = require('brittle')
const net = require('node:net')
const b4a = require('b4a')
const Hypercore = require('hypercore')
const NoiseSecretStream = require('@hyperswarm/secret-stream')
const crypto = require('hypercore-crypto')
const { WebSocketServer, WebSocket } = require('ws')
const { testnet } = require('./helpers/net')
const { connectClient, stoppedOf, errorOf } = require('./helpers/session')
const { createCert, createSeederCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { postRecord, postShareRecord, deleteRecord, validateRecord } = require('@varanda/core/lib/records')
const { attachAdmission } = require('@varanda/core/lib/admission')
const { memoryNodeStorage } = require('../lib/node-storage')
const { wsStream } = require('../lib/ws-stream')
const store = require('../lib/node-store')
const member = require('../lib/member-ops')
const { createBrowserNode } = require('../lib/node')

const LOCKED = 'identidade bloqueada: entre com a passkey'
const BAD_REF = 'referência inválida'
const NOT_POST = 'o registro não é uma publicação'
const FULL = 'limite do diário atingido'
const WRITERS = ['post.share', 'post.unshare']
const ALL = ['post.shared', ...WRITERS]

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function association () {
  const kp = generateAssociationKeyPair()
  return { kp, hex: hex(kp.publicKey) }
}

async function deadPort () {
  const server = net.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

async function setup (t, { storage = memoryNodeStorage(), assoc = association(), keyPair = crypto.keyPair(), seederUrl = null, ...options } = {}) {
  const url = seederUrl === null ? 'ws://127.0.0.1:' + (await deadPort()) + '/seeder' : seederUrl
  const internal = []
  const node = createBrowserNode({
    storage,
    association: assoc.hex,
    seederUrl: url,
    createSocket: (u) => {
      const ws = new WebSocket(u)
      ws.on('error', () => {})
      return ws
    },
    onInternalError: (err) => internal.push(err),
    writeGate: false,
    ...options
  })
  t.teardown(() => node.close(), { force: true })
  if (keyPair !== null) await node.setKeyPair(keyPair)
  const web = await connectClient(node, { timeoutMs: 30000 })
  return { node, web, assoc, storage, keyPair, internal }
}

async function certified (t, options) {
  const s = await setup(t, options)
  const { publicKey } = await s.web.request('identity.create')
  await s.web.request('cert.add', { cert: createCert({ member: publicKey }, s.assoc.kp) })
  return { ...s, key: publicKey }
}

// A certified diary written straight through the store before any node
// opens the storage; make(key) -> the records appended after block 0 (one
// atomic append, at most 8).
async function prepared (make) {
  const assoc = association()
  const keyPair = crypto.keyPair()
  const storage = memoryNodeStorage()
  const ctx = { storage, association: assoc.hex, keyPair }
  const { publicKey } = await member.idCreate(ctx)
  await member.certAdd(ctx, createCert({ member: publicKey }, assoc.kp))
  const records = make(publicKey)
  if (records.length > 0) await member.withIdentity(ctx, ({ diary }) => store.appendRecords(diary, records))
  return { assoc, keyPair, storage, key: publicKey }
}

async function errorPair (p) {
  const err = await errorOf(p)
  return [err && err.code, err && err.message]
}

async function length (web) {
  const log = await web.request('log.read', {})
  return log.entries.length + log.invalid.length
}

test('post.share: share, repeat, unshare, repeat, share again; a reply and a quote too', async (t) => {
  await testnet(t)
  const { web, key, internal } = await certified(t)
  t.is((await web.request('post.create', { text: 'pública' })).seq, 1)
  const to = key + ':1'

  t.alike(await web.request('post.shared', { to }), { shareSeq: null }, 'never shared')
  t.alike(await web.request('post.share', { to }), { shareSeq: 2, created: true })
  const block = (await web.request('log.read', {})).entries.find((e) => e.seq === 2).record
  t.alike([block.type, block.seq, Object.keys(block).sort()], ['post-share', 1, ['at', 'seq', 'type']], 'one post-share naming the post')
  t.is(validateRecord(block, 2), null, 'valid at its seq')
  t.alike(await web.request('post.shared', { to }), { shareSeq: 2 })

  t.alike(await web.request('post.share', { to }), { shareSeq: 2, created: false }, 'the repeat writes nothing')
  t.is(await length(web), 3, 'nothing appended')

  t.alike(await web.request('post.unshare', { to }), { ok: true, changed: true })
  const tomb = (await web.request('log.read', {})).entries.find((e) => e.seq === 3).record
  t.alike([tomb.type, tomb.seq, 'media' in tomb], ['delete', 2, false], 'one plain tombstone on the share')
  t.alike(await web.request('post.shared', { to }), { shareSeq: null })
  t.alike(await web.request('post.unshare', { to }), { ok: true, changed: false }, 'the repeat writes nothing')
  t.is(await length(web), 4, 'nothing appended')

  t.alike(await web.request('post.share', { to }), { shareSeq: 4, created: true }, 'a new, higher share')
  t.alike(await web.request('post.shared', { to }), { shareSeq: 4 })
  t.is((await web.request('log.read', {})).entries.find((e) => e.seq === 1).record.text, 'pública', 'the post itself is untouched')

  const reply = (await web.request('post.reply', { to, text: 'resposta' })).seq
  const quote = (await web.request('post.quote', { to, text: 'citação' })).seq
  t.alike(await web.request('post.share', { to: key + ':' + reply }), { shareSeq: quote + 1, created: true }, 'a reply is a post')
  t.alike(await web.request('post.share', { to: key + ':' + quote }), { shareSeq: quote + 2, created: true }, 'a quote is a post')
  t.alike(await web.request('post.shared', { to }), { shareSeq: 4 }, 'each post has its own share')
  t.alike(internal, [], 'no internal error')
})

test('any live share counts; a tombstoned one never does; unshare tombstones every live one', async (t) => {
  await testnet(t)
  // 1 post, 2 an older share, 3 a newer share, 4 the newer one's tombstone.
  const p = await prepared(() => [
    postRecord({ text: 'um' }),
    postShareRecord({ seq: 1 }),
    postShareRecord({ seq: 1 }),
    deleteRecord({ seq: 3 })
  ])
  const { web } = await setup(t, { storage: p.storage, assoc: p.assoc, keyPair: p.keyPair })
  const to = p.key + ':1'
  t.alike(await web.request('post.shared', { to }), { shareSeq: 2 }, 'an older live share under a tombstoned newer one still counts')
  t.alike(await web.request('post.share', { to }), { shareSeq: 2, created: false }, 'already shared: nothing written')
  t.is(await length(web), 5, 'nothing appended')
  t.alike(await web.request('post.unshare', { to }), { ok: true, changed: true })
  const tomb = (await web.request('log.read', {})).entries.find((e) => e.seq === 5).record
  t.alike([tomb.type, tomb.seq], ['delete', 2], 'the live share got the tombstone')
  t.is(await length(web), 6, 'one tombstone')
  t.alike(await web.request('post.shared', { to }), { shareSeq: null })

  // Two live shares: one unshare tombstones both in one append.
  const q = await prepared(() => [postRecord({ text: 'um' }), postShareRecord({ seq: 1 }), postShareRecord({ seq: 1 })])
  const two = await setup(t, { storage: q.storage, assoc: q.assoc, keyPair: q.keyPair })
  const toQ = q.key + ':1'
  t.alike(await two.web.request('post.shared', { to: toQ }), { shareSeq: 3 }, 'the highest live share')
  t.alike(await two.web.request('post.unshare', { to: toQ }), { ok: true, changed: true })
  const tombs = (await two.web.request('log.read', {})).entries.filter((e) => e.seq >= 4).map((e) => [e.record.type, e.record.seq])
  t.alike(tombs, [['delete', 2], ['delete', 3]], 'both shares tombstoned')
  t.alike(await two.web.request('post.shared', { to: toQ }), { shareSeq: null })
  t.alike(await two.web.request('post.unshare', { to: toQ }), { ok: true, changed: false }, 'the repeat writes nothing')

  // More live shares than one append takes: every one is tombstoned.
  const r = await prepared(() => [postRecord({ text: 'um' }), ...Array.from({ length: 7 }, () => postShareRecord({ seq: 1 }))])
  await member.withIdentity({ storage: r.storage, association: r.assoc.hex, keyPair: r.keyPair }, ({ diary }) => store.appendRecords(diary, [postShareRecord({ seq: 1 }), postShareRecord({ seq: 1 })]))
  const many = await setup(t, { storage: r.storage, assoc: r.assoc, keyPair: r.keyPair })
  const toR = r.key + ':1'
  t.alike(await many.web.request('post.shared', { to: toR }), { shareSeq: 10 })
  t.alike(await many.web.request('post.unshare', { to: toR }), { ok: true, changed: true })
  const targets = (await many.web.request('log.read', {})).entries.filter((e) => e.seq >= 11).map((e) => e.record.seq)
  t.alike(targets, [2, 3, 4, 5, 6, 7, 8, 9, 10], 'nine tombstones')
  t.alike(await many.web.request('post.shared', { to: toR }), { shareSeq: null })

  // A tombstone of the tombstone brings the share back.
  const u = await prepared(() => [
    postRecord({ text: 'um' }),
    postShareRecord({ seq: 1 }),
    deleteRecord({ seq: 2 }),
    deleteRecord({ seq: 3 })
  ])
  const back = await setup(t, { storage: u.storage, assoc: u.assoc, keyPair: u.keyPair })
  t.alike(await back.web.request('post.shared', { to: u.key + ':1' }), { shareSeq: 2 }, 'the deletion fold decides liveness')
})

test('post.shared, post.share, post.unshare: the target must be a live own post', async (t) => {
  await testnet(t)
  const { web, key } = await certified(t)
  const other = hex(crypto.keyPair().publicKey)
  await web.request('profile.set', { name: 'Bia' })
  await web.request('post.create', { text: 'apagada' })
  await web.request('post.delete', { to: key + ':2' })
  await web.request('post.create', { text: 'viva' })
  t.alike(await web.request('post.share', { to: key + ':4' }), { shareSeq: 5, created: true })
  const len = await length(web)

  for (const method of ALL) {
    t.alike(await errorPair(web.request(method, { to: other + ':4' })), ['USAGE', BAD_REF], method + ': another author')
    t.alike(await errorPair(web.request(method, { to: key + ':' + len })), ['USAGE', BAD_REF], method + ': at the length')
    t.alike(await errorPair(web.request(method, { to: key + ':999' })), ['USAGE', BAD_REF], method + ': past the length')
    t.alike(await errorPair(web.request(method, { to: key + ':2' })), ['USAGE', BAD_REF], method + ': a deleted and cleared post')
    t.alike(await errorPair(web.request(method, { to: key + ':1' })), ['USAGE', NOT_POST], method + ': a profile')
    t.alike(await errorPair(web.request(method, { to: key + ':3' })), ['USAGE', NOT_POST], method + ': a tombstone')
    t.alike(await errorPair(web.request(method, { to: key + ':5' })), ['USAGE', NOT_POST], method + ': a post-share')
    const zero = await errorOf(web.request(method, { to: key + ':0' }))
    t.is(zero && zero.code, 'USAGE', method + ': block 0')
  }
  t.is(await length(web), len, 'nothing appended')

  // A tombstoned post whose block is still readable is refused the same way.
  const p = await prepared(() => [postRecord({ text: 'um' }), deleteRecord({ seq: 1 })])
  const s = await setup(t, { storage: p.storage, assoc: p.assoc, keyPair: p.keyPair })
  t.is((await member.withIdentity({ storage: p.storage, association: p.assoc.hex }, async ({ diary }) => store.readRaw(diary)))[1].record.text, 'um', 'the block is still readable')
  for (const method of ALL) {
    t.alike(await errorPair(s.web.request(method, { to: p.key + ':1' })), ['USAGE', BAD_REF], method + ': a tombstoned post')
  }
  t.is(await length(s.web), 3, 'nothing appended')
})

test('post.share: a full diary is refused and writes nothing', async (t) => {
  await testnet(t)
  const p = await prepared(() => [postRecord({ text: 'um' })])
  const { web } = await setup(t, { storage: p.storage, assoc: p.assoc, keyPair: p.keyPair, limits: { maxLogBlocks: 2 } })
  t.alike(await errorPair(web.request('post.share', { to: p.key + ':1' })), ['USAGE', FULL])
  t.is(await length(web), 2, 'nothing appended')

  const q = await prepared(() => [postRecord({ text: 'um' }), postShareRecord({ seq: 1 })])
  const full = await setup(t, { storage: q.storage, assoc: q.assoc, keyPair: q.keyPair, limits: { maxLogBlocks: 3 } })
  t.alike(await errorPair(full.web.request('post.unshare', { to: q.key + ':1' })), ['USAGE', FULL])
  t.alike(await full.web.request('post.shared', { to: q.key + ':1' }), { shareSeq: 2 }, 'still shared')
})

test('post.share and post.unshare refuse a locked identity; post.shared works locked', async (t) => {
  await testnet(t)
  const p = await prepared(() => [postRecord({ text: 'um' }), postShareRecord({ seq: 1 }), postRecord({ text: 'dois' })])
  const locked = await setup(t, { storage: p.storage, assoc: p.assoc, keyPair: null })
  for (const method of WRITERS) {
    t.alike(await errorPair(locked.web.request(method, { to: p.key + ':1' })), ['USAGE', LOCKED], method + ' locked')
    t.alike(await errorPair(locked.web.request(method, { to: p.key + ':3' })), ['USAGE', LOCKED], method + ' locked, unshared post')
  }
  t.alike(await locked.web.request('post.shared', { to: p.key + ':1' }), { shareSeq: 2 }, 'read while locked')
  t.alike(await locked.web.request('post.shared', { to: p.key + ':3' }), { shareSeq: null })
  t.alike(await errorPair(locked.web.request('post.shared', { to: p.key + ':0' })), ['USAGE', 'parâmetro inválido: to'])
  t.is(await length(locked.web), 4, 'nothing appended')
  t.absent(locked.web.events.some((e) => e.name === 'sync.started'), 'no run for a locked identity')
})

// Drops one stored block of a prepared diary (not a tombstone target), as a
// block not downloaded yet: the stored blocks then have a hole.
async function clearBlock (p, seq) {
  await member.withIdentity({ storage: p.storage, association: p.assoc.hex, keyPair: p.keyPair }, ({ diary }) => diary.clear(seq, seq + 1))
}

test('blocks stored past a hole count: a tombstone, a share, and a target in the hole', async (t) => {
  await testnet(t)
  // 1 post, 2 its share, 3 a post not held, 4 the share's tombstone.
  const p = await prepared(() => [postRecord({ text: 'um' }), postShareRecord({ seq: 1 }), postRecord({ text: 'buraco' }), deleteRecord({ seq: 2 })])
  await clearBlock(p, 3)
  const a = await setup(t, { storage: p.storage, assoc: p.assoc, keyPair: p.keyPair })
  t.alike(await a.web.request('post.shared', { to: p.key + ':1' }), { shareSeq: null }, 'the tombstone past the hole withdraws the share')
  for (const method of ALL) {
    t.alike(await errorPair(a.web.request(method, { to: p.key + ':3' })), ['USAGE', BAD_REF], method + ': a target not held')
  }

  // 1 post, 2 a post not held, 3 a live share of 1.
  const q = await prepared(() => [postRecord({ text: 'um' }), postRecord({ text: 'buraco' }), postShareRecord({ seq: 1 })])
  await clearBlock(q, 2)
  const b = await setup(t, { storage: q.storage, assoc: q.assoc, keyPair: q.keyPair })
  const to = q.key + ':1'
  t.alike(await b.web.request('post.shared', { to }), { shareSeq: 3 }, 'the share past the hole is live')
  t.alike(await b.web.request('post.share', { to }), { shareSeq: 3, created: false }, 'already shared')
  t.alike(await b.web.request('post.unshare', { to }), { ok: true, changed: true }, 'the share past the hole is withdrawn')
  t.alike(await b.web.request('post.shared', { to }), { shareSeq: null })
  t.alike(await b.web.request('post.unshare', { to }), { ok: true, changed: false })
})

test('shareRoom: the reader keeps a bounded number of shared posts', (t) => {
  const entries = [
    { seq: 0, record: null },
    { seq: 1, record: postRecord({ text: 'a' }) },
    { seq: 2, record: postRecord({ text: 'b' }) },
    { seq: 3, record: postRecord({ text: 'c' }) },
    { seq: 4, record: postShareRecord({ seq: 1 }) },
    { seq: 5, record: postShareRecord({ seq: 2 }) },
    { seq: 6, record: deleteRecord({ seq: 5 }) }
  ]
  t.is(member.shareRoom(entries, 3, 3), true, 'room left')
  t.is(member.shareRoom(entries, 3, 2), false, 'full: a new post is refused')
  t.is(member.shareRoom(entries, 1, 2), true, 'a post with a live share')
  t.is(member.shareRoom(entries, 2, 2), true, 'a post with a withdrawn share can be shared again')
  t.is(member.shareRoom(entries.slice(0, 4), 3, 0), false, 'a cap of 0 holds nothing')
  t.is(member.shareRoom(entries, 3), true, 'the default cap')
})

// ---- the push ----

// A seeder stand-in (as sync-gate.test.js): role 'seeder' with a certificate
// signed by `signer`, holding no diary; it admits an announce at the length
// the member advertised.
async function fakeSeeder (t, { signer }) {
  const keyPair = crypto.keyPair()
  const cert = createSeederCert({ seeder: hex(keyPair.publicKey) }, signer)
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve) => wss.once('listening', resolve))
  t.teardown(() => {
    for (const c of wss.clients) c.terminate()
    return new Promise((resolve) => wss.close(() => resolve()))
  }, { force: true })
  wss.on('connection', (ws) => {
    const noise = new NoiseSecretStream(false, wsStream(ws), { keyPair })
    noise.on('error', () => {})
    noise.once('connect', () => {
      Hypercore.createProtocolStream(noise)
      attachAdmission(noise, {
        role: 'seeder',
        cert,
        have: [],
        onmessage: (msg, peer) => {
          if (msg.type !== 'announce') return
          peer.send({ type: 'admitted', key: msg.key, length: peer.remoteHave.get(msg.key) || 0 })
        }
      })
    })
  })
  return { url: 'ws://127.0.0.1:' + wss.address().port + '/seeder' }
}

// The runs started since event index `from`: [{ lines, stopped }].
async function runsSince (web, from) {
  const out = []
  for (const e of web.events.slice(from)) {
    if (e.name !== 'sync.started') continue
    const { runId } = e.data
    const lines = web.events.filter((x) => x.name === 'sync.event' && x.data.runId === runId).map((x) => x.data.line)
    out.push({ lines, stopped: await stoppedOf(web.events, runId) })
  }
  return out
}

test('post.share and post.unshare catch up, then push what they wrote', async (t) => {
  t.timeout(90000)
  await testnet(t)
  const p = await prepared(() => [postRecord({ text: 'um' })])
  const seeder = await fakeSeeder(t, { signer: p.assoc.kp })
  const { web } = await setup(t, { storage: p.storage, assoc: p.assoc, keyPair: p.keyPair, seederUrl: seeder.url, writeGate: true, syncOptions: { retryMinMs: 100, retryMaxMs: 200 } })
  const to = p.key + ':1'

  for (const [i, [method, result]] of [['post.share', { shareSeq: 2, created: true }], ['post.unshare', { ok: true, changed: true }], ['post.share', { shareSeq: 4, created: true }]].entries()) {
    const from = web.events.length
    t.alike(await web.request(method, { to }), result, method)
    const runs = await runsSince(web, from)
    t.alike(runs.map((r) => r.lines[0]), ['sincronizando antes de publicar', 'enviando ao semeador'], i + ' ' + method + ': the gate run, then a push run')
    t.is(runs[1].stopped.reason, 'done', i + ' ' + method + ': the push ended')
    t.is(runs[1].stopped.result.seederConfirmed, true, i + ' ' + method + ': the seeder confirmed the new length')
  }

  const from = web.events.length
  t.alike(await web.request('post.shared', { to }), { shareSeq: 4 })
  t.absent(web.events.slice(from).some((e) => e.name === 'sync.started'), 'post.shared starts no run')
})

test('post.unshare that fails across appends counts and pushes what landed', async (t) => {
  t.timeout(90000)
  await testnet(t)
  // 1 the post with 9 live shares (2 to 10), 11 another post.
  const p = await prepared(() => [postRecord({ text: 'um' }), ...Array.from({ length: 7 }, () => postShareRecord({ seq: 1 }))])
  await member.withIdentity({ storage: p.storage, association: p.assoc.hex, keyPair: p.keyPair }, ({ diary }) => store.appendRecords(diary, [postShareRecord({ seq: 1 }), postShareRecord({ seq: 1 }), postRecord({ text: 'dois' })]))
  const seeder = await fakeSeeder(t, { signer: p.assoc.kp })
  // 12 the share of 11, 13 to 20 the first chunk of tombstones; 21 is refused.
  const { web } = await setup(t, { storage: p.storage, assoc: p.assoc, keyPair: p.keyPair, seederUrl: seeder.url, writeGate: true, limits: { maxLogBlocks: 21 }, syncOptions: { retryMinMs: 100, retryMaxMs: 200 } })
  t.alike(await web.request('post.share', { to: p.key + ':11' }), { shareSeq: 12, created: true }, 'a confirmed push first')

  const from = web.events.length
  t.alike(await errorPair(web.request('post.unshare', { to: p.key + ':1' })), ['USAGE', FULL], 'the second append fails')
  const runs = await runsSince(web, from)
  t.alike(runs.map((r) => r.lines[0]), ['sincronizando antes de publicar', 'enviando ao semeador'], 'what landed is pushed')
  t.is(runs[1].stopped.result.seederConfirmed, true, 'the seeder confirmed the new length')
  const targets = (await web.request('log.read', {})).entries.filter((e) => e.seq >= 13).map((e) => e.record.seq)
  t.alike(targets, [2, 3, 4, 5, 6, 7, 8, 9], 'the first 8 tombstones are stored, nothing retried')
  t.alike(await web.request('post.shared', { to: p.key + ':1' }), { shareSeq: 10 }, 'the last share is still live')
})
