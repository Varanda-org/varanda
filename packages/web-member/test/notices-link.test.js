'use strict'

// The notices link across chained pages (lib/notices.js, docs/rpc.md 5.28,
// docs/protocol.md 'Notices link'): a read that ends with a cursor keeps its
// link NOTICES_LINGER_MS for the next page of the same own key, and the link
// asks the seeder for no inventory (CAP_NO_INVENTORY). Loopback only: the
// seeder stand-in of ./helpers/notices.js, and the real seeder on a local
// DHT for the lean hello.
const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('hypercore-crypto')
const { WebSocketServer, WebSocket, createWebSocketStream } = require('ws')
const { testnet, tmpDir, localSwarmOptions, until } = require('./helpers/net')
const { hex, noop, association, iso, diary, certOf, noticesSeeder, HOUR } = require('./helpers/notices')
const { Seeder } = require('@varanda/core/lib/seeder')
const { createCert, createSeederCert } = require('@varanda/core/lib/cert')
const { followRecord } = require('@varanda/core/lib/records')
const { signNoticeProof } = require('@varanda/core/lib/notices')
const { createNoticer, NOTICES_LINGER_MS } = require('../lib/notices')
const { createMember } = require('../lib/member')
const { connectSeeder } = require('../lib/seeder-link')
const { memoryNodeStorage } = require('../lib/node-storage')
const { memoryStorage } = require('../lib/storage')

const NO_SEEDER = 'sem conexão com o semeador'

// A noticer on `url` whose sockets are recorded, each with the time the
// client first closed it (closedAt). who.pair is the identity read for.
function noticerOf (t, assoc, url, who, limits = {}) {
  const sockets = []
  const noticer = createNoticer({
    storage: memoryNodeStorage(),
    association: assoc.hex,
    seederUrl: url,
    createSocket: (u) => {
      const ws = new WebSocket(u)
      ws.on('error', noop)
      ws.closedAt = null
      const close = ws.close.bind(ws)
      ws.close = (...args) => {
        if (ws.closedAt === null) ws.closedAt = Date.now()
        return close(...args)
      }
      ws.on('close', () => { if (ws.closedAt === null) ws.closedAt = Date.now() })
      sockets.push(ws)
      return ws
    },
    ownKey: async () => hex(who.pair.publicKey),
    sign: (payload) => signNoticeProof(payload, who.pair),
    seenToken: () => '0'.repeat(32),
    limits
  })
  t.teardown(() => noticer.close(), { force: true })
  return { noticer, sockets }
}

// Three followers of `me`, one per seeder page (v1: { at, key } cursors),
// newest first.
async function chained (t, assoc, me) {
  const now = Date.now()
  const rows = []
  for (let i = 0; i < 3; i++) {
    const at = iso(now - HOUR - i * 1000)
    const F = await diary(t, [certOf(assoc), () => followRecord({ key: me, on: true, at })])
    rows.push({ key: hex(F.key), seq: 1, at, core: F })
  }
  const state = {
    cores: rows.map((r) => r.core),
    page: (target, after) => {
      if (target !== me) return { items: [], next: null, incomplete: false }
      const i = after === null ? 0 : rows.findIndex((r) => r.key === after.key) + 1
      if (i >= rows.length) return { items: [], next: null, incomplete: false }
      const r = rows[i]
      return { items: [{ key: r.key, seq: r.seq, at: r.at }], next: i + 1 < rows.length ? { at: r.at, key: r.key } : null, incomplete: false }
    }
  }
  const seeder = await noticesSeeder(t, { signer: assoc.kp, state })
  return { seeder, keys: rows.map((r) => r.key) }
}

const keysOf = (r) => r.notices.map((n) => n.key)

test('three chained pages open ONE socket, and the link closes at once when next is null', async (t) => {
  t.timeout(60000)
  const assoc = association()
  const who = { pair: crypto.keyPair() }
  const me = hex(who.pair.publicKey)
  const { seeder, keys } = await chained(t, assoc, me)
  const { noticer, sockets } = noticerOf(t, assoc, seeder.url, who)
  const r1 = await noticer.read({ limit: 1 })
  t.alike(keysOf(r1), [keys[0]])
  t.ok(r1.next !== null, 'a cursor after page 1')
  const r2 = await noticer.read({ limit: 1, after: r1.next })
  t.alike(keysOf(r2), [keys[1]])
  const r3 = await noticer.read({ limit: 1, after: r2.next })
  const endedAt = Date.now()
  t.alike(keysOf(r3), [keys[2]])
  t.is(r3.next, null)
  t.is(sockets.length, 1, 'one socket for the three pages')
  t.is(seeder.connections, 1, 'one connection (one hello, one proof) at the seeder')
  t.is(seeder.pages.length, 3, 'three seeder pages')
  await until(() => sockets[0].closedAt !== null, { timeoutMs: 1000, name: 'closed at once' })
  t.ok(sockets[0].closedAt - endedAt < NOTICES_LINGER_MS / 2, 'closed on the last page, not after the linger')
})

test('a first page always opens a new socket and closes the idle one', async (t) => {
  t.timeout(60000)
  const assoc = association()
  const who = { pair: crypto.keyPair() }
  const me = hex(who.pair.publicKey)
  const { seeder, keys } = await chained(t, assoc, me)
  const { noticer, sockets } = noticerOf(t, assoc, seeder.url, who)
  const r1 = await noticer.read({ limit: 1 })
  t.ok(r1.next !== null)
  t.is(sockets[0].closedAt, null, 'the link lingers after a page with a cursor')
  const again = await noticer.read({ limit: 1 })
  t.alike(keysOf(again), [keys[0]])
  t.is(sockets.length, 2, 'a new socket for the first page')
  await until(() => sockets[0].closedAt !== null, { timeoutMs: 1000, name: 'the idle link was closed' })
  t.pass('the idle link was closed')
})

test('the idle link closes NOTICES_LINGER_MS after the last page', async (t) => {
  t.timeout(60000)
  t.is(NOTICES_LINGER_MS, 2000)
  const assoc = association()
  const who = { pair: crypto.keyPair() }
  const me = hex(who.pair.publicKey)
  const { seeder } = await chained(t, assoc, me)
  const { noticer, sockets } = noticerOf(t, assoc, seeder.url, who)
  const r1 = await noticer.read({ limit: 1 })
  const endedAt = Date.now()
  t.ok(r1.next !== null)
  await until(() => sockets[0].closedAt !== null, { timeoutMs: 15000, name: 'closed after the linger' })
  const lingered = sockets[0].closedAt - endedAt
  t.ok(lingered >= NOTICES_LINGER_MS - 100, 'open until the linger ended (' + lingered + ' ms)')
  // A chained page after the link closed dials again.
  const r2 = await noticer.read({ limit: 1, after: r1.next })
  t.is(r2.notices.length, 1)
  t.is(sockets.length, 2, 'a new socket once the idle link closed')
})

test('abort and close() close the idle link at once', async (t) => {
  t.timeout(60000)
  const assoc = association()
  const who = { pair: crypto.keyPair() }
  const me = hex(who.pair.publicKey)
  const { seeder } = await chained(t, assoc, me)
  const { noticer, sockets } = noticerOf(t, assoc, seeder.url, who)
  const r1 = await noticer.read({ limit: 1 })
  t.ok(r1.next !== null)
  const abortedAt = Date.now()
  noticer.abort()
  await until(() => sockets[0].closedAt !== null, { timeoutMs: 1000, name: 'abort closed the idle link' })
  t.ok(sockets[0].closedAt - abortedAt < NOTICES_LINGER_MS / 2, 'abort closed the idle link at once')
  const r2 = await noticer.read({ limit: 1, after: r1.next })
  t.is(r2.notices.length, 1)
  t.is(sockets.length, 2, 'the chained page after an abort dials again')
  t.ok(r2.next !== null)
  noticer.close()
  await until(() => sockets[1].closedAt !== null, { timeoutMs: 1000, name: 'close() closed the idle link' })
  t.pass('close() closed the idle link')
  await t.exception(noticer.read({ limit: 1, after: r2.next }), new RegExp(NO_SEEDER))
  t.is(sockets.length, 2, 'a closed noticer dials nothing')
})

test('an identity change never reuses the link or its proof', async (t) => {
  t.timeout(60000)
  const assoc = association()
  const who = { pair: crypto.keyPair() }
  const me = hex(who.pair.publicKey)
  const { seeder, keys } = await chained(t, assoc, me)
  const { noticer, sockets } = noticerOf(t, assoc, seeder.url, who)
  const r1 = await noticer.read({ limit: 1 })
  t.ok(r1.next !== null)
  const first = who.pair
  who.pair = crypto.keyPair()
  const other = await noticer.read({ limit: 1, after: r1.next })
  t.is(sockets.length, 2, 'another own key dials a new link')
  await until(() => sockets[0].closedAt !== null, { timeoutMs: 1000, name: 'the other identity\'s link closed' })
  t.pass('the link proved for the other identity was closed')
  t.alike(other.notices, [], 'the new identity has no notices')
  t.is(seeder.connections, 2)
  t.alike(seeder.pages.map((p) => p.target), [me, hex(who.pair.publicKey)], 'each page served for the key its own link proved')
  // Back to the first identity: its chained page dials too (no idle link of
  // its own is left).
  who.pair = first
  const r2 = await noticer.read({ limit: 1, after: r1.next })
  t.alike(keysOf(r2), [keys[1]])
  t.is(sockets.length, 3)
})

test('a link lost while idle: the chained page dials again', async (t) => {
  t.timeout(60000)
  const assoc = association()
  const who = { pair: crypto.keyPair() }
  const me = hex(who.pair.publicKey)
  const { seeder, keys } = await chained(t, assoc, me)
  const { noticer, sockets } = noticerOf(t, assoc, seeder.url, who)
  const r1 = await noticer.read({ limit: 1 })
  t.ok(r1.next !== null)
  sockets[0].terminate()
  await until(() => sockets[0].readyState === WebSocket.CLOSED, { timeoutMs: 5000, name: 'socket gone' })
  const r2 = await noticer.read({ limit: 1, after: r1.next })
  t.alike(keysOf(r2), [keys[1]], 'the page is read in full on a new link')
  t.is(sockets.length, 2)
})

// The real seeder on a local DHT serving `own`, followed by F, both pushed.
async function realSeeder (t, bootstrap, assoc, opts) {
  const dir = tmpDir(t, 'varanda-notices-link-seed-')
  Seeder.ensureConfig(dir, assoc.hex)
  const { publicKey: seederKey } = Seeder.createKey(dir)
  const certFile = path.join(tmpDir(t, 'varanda-notices-link-sc-'), 'seeder-cert.json')
  fs.writeFileSync(certFile, JSON.stringify(createSeederCert({ seeder: seederKey }, assoc.kp)))
  Seeder.addCert(dir, certFile, assoc.hex)
  const seeder = new Seeder({ dataDir: dir, ...localSwarmOptions(bootstrap), log: noop, ...opts })
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
  return { seeder, seederKey, url: 'ws://127.0.0.1:' + wss.address().port + '/seeder' }
}

async function push (t, member, url, assoc, seederKey) {
  const link = connectSeeder({ member, socket: new WebSocket(url), association: assoc.hex, seederPublicKey: seederKey, timeoutMs: 60000 })
  t.teardown(() => link.close(), { force: true })
  await link.admitted
  await link.waitServed(member.core.length)
  link.close()
}

test('lean: a discovery seeder sends no inventory; one with discovery false sends it and the read works unchanged', async (t) => {
  t.timeout(240000)
  const { bootstrap } = await testnet(t)
  const assoc = association()
  for (const discovery of [true, false]) {
    const { url, seederKey } = await realSeeder(t, bootstrap, assoc, { discovery })
    const ownPair = crypto.keyPair()
    const O = await createMember({ storage: memoryStorage(), keyPair: ownPair, association: assoc.hex })
    t.teardown(() => O.close(), { force: true })
    await O.setCert(createCert({ member: O.key }, assoc.kp))
    await push(t, O, url, assoc, seederKey)
    const F = await createMember({ storage: memoryStorage(), association: assoc.hex })
    t.teardown(() => F.close(), { force: true })
    await F.setCert(createCert({ member: F.key }, assoc.kp))
    await F.core.append(followRecord({ key: O.key, on: true }))
    await push(t, F, url, assoc, seederKey)

    let events = []
    const { noticer } = noticerOf(t, assoc, url, { pair: ownPair }, { trace: (ev) => { if (ev.type === 'admission') events.push(ev) } })
    const r = await until(async () => {
      events = []
      const r = await noticer.read({ limit: 5 })
      return r.notices.length === 1 && !r.incomplete ? r : null
    }, { name: 'F listed', intervalMs: 250, timeoutMs: 30000 })
    t.alike(keysOf(r), [F.key], 'the follower is listed (discovery ' + discovery + ')')
    const hello = events.find((e) => e.msg === 'hello')
    const haves = events.filter((e) => e.msg === 'have').length
    if (discovery) {
      t.is(hello.count, 0, 'a lean hello')
      t.is(haves, 0, 'zero have messages')
    } else {
      t.ok(hello.count >= 2, 'the full inventory from a seeder with discovery false (' + hello.count + ')')
    }
    noticer.close()
  }
})
