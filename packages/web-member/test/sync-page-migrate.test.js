'use strict'

// A browser node that follows a moved page K1 follows K2 once, after it
// verified page-moved (K1) and page-origin (K2, read from the verified
// seeder); the follow goes through followPage, the session's signed path.
const test = require('brittle')
const b4a = require('b4a')
const Hypercore = require('hypercore')
const NoiseSecretStream = require('@hyperswarm/secret-stream')
const crypto = require('hypercore-crypto')
const { WebSocketServer, WebSocket } = require('ws')
const { testnet } = require('./helpers/net')
const { connectClient, stoppedOf } = require('./helpers/session')
const { createCert, createSeederCert, createIssuerCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { memberCertRecord, profileRecord, postRecord, deleteRecord } = require('@varanda/core/lib/records')
const { attachAdmission } = require('@varanda/core/lib/admission')
const page = require('@varanda/core/lib/page')
const { createBrowserNode } = require('../lib/node')
const store = require('../lib/node-store')
const ops = require('../lib/member-ops')
const { memoryNodeStorage } = require('../lib/node-storage')
const { memoryStorage } = require('../lib/storage')
const { wsStream } = require('../lib/ws-stream')

const AT = '2026-01-01T00:00:00.000Z'
const hex = (buf) => b4a.toString(buf, 'hex')
const nonce = (c) => c.repeat(43)

function trust () {
  const kp = generateAssociationKeyPair()
  const issuerKp = crypto.keyPair()
  const issuerCert = createIssuerCert({ issuer: hex(issuerKp.publicKey), date: AT }, kp)
  return { kp, hex: hex(kp.publicKey), issuerKp, issuerCert, ownerKp: crypto.keyPair() }
}

function movedRecord (s, k1, k2) {
  const owner = hex(s.ownerKp.publicKey)
  const fields = { type: 'page-moved', page: k1, to: k2, gen: 2, at: AT, nonce: nonce('m'), actor: owner, association: s.hex }
  return page.issuerCountersign({ ...fields, signature: page.signMoved(fields, s.ownerKp) }, s.issuerKp, s.issuerCert)
}

function originRecord (s, k2, from, fromSeq) {
  const owner = hex(s.ownerKp.publicKey)
  const fields = { type: 'page-origin', page: k2, from, fromSeq, gen: 1, owner, admins: [], at: AT, nonce: nonce('g'), actor: owner, association: s.hex }
  return page.issuerCountersign({ ...fields, signature: page.signOrigin(fields, s.ownerKp) }, s.issuerKp, s.issuerCert)
}

// A Hypercore 10 page diary: cert, profile, post (seq 0..2).
async function pageCore (t, s) {
  const core = new Hypercore(memoryStorage(), { valueEncoding: 'json' })
  await core.ready()
  t.teardown(() => core.close(), { force: true })
  await core.append(memberCertRecord(createCert({ member: hex(core.key) }, s.kp)))
  await core.append(profileRecord({ name: 'Página', bio: '' }))
  await core.append(postRecord({ text: 'post' }))
  return core
}

// A seeder stand-in (as sync-gate.test.js) that replicates and advertises
// `cores`; uploads counts the blocks it served per core key.
async function fakeSeeder (t, { signer, cores }) {
  const keyPair = crypto.keyPair()
  const cert = createSeederCert({ seeder: hex(keyPair.publicKey) }, signer)
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve) => wss.once('listening', resolve))
  t.teardown(() => {
    for (const c of wss.clients) c.terminate()
    return new Promise((resolve) => wss.close(() => resolve()))
  }, { force: true })
  const uploads = new Map()
  for (const core of cores) {
    core.on('upload', (index) => {
      const k = hex(core.key)
      if (!uploads.has(k)) uploads.set(k, new Set())
      uploads.get(k).add(index)
    })
  }
  wss.on('connection', (ws) => {
    const noise = new NoiseSecretStream(false, wsStream(ws), { keyPair })
    noise.on('error', () => {})
    noise.once('connect', () => {
      Hypercore.createProtocolStream(noise)
      for (const core of cores) core.replicate(noise)
      attachAdmission(noise, {
        role: 'seeder',
        cert,
        have: cores.map((core) => ({ key: hex(core.key), length: core.length })),
        onmessage: (msg, peer) => {
          if (msg.type !== 'announce') return
          peer.send({ type: 'admitted', key: msg.key, length: peer.remoteHave.get(msg.key) || 0 })
        }
      })
    })
  })
  return { url: 'ws://127.0.0.1:' + wss.address().port + '/seeder', uploads }
}

// K1 (seq 3 page-moved to K2) and K2 (seq 3 from originFor, or a post when
// it returns null) on a fake seeder; a browser node following K1. followPage
// is the session's follow.add unless `locked`.
// pad: forged (unverifiable) page-moved copies appended to K1 before the
// genuine one.
async function scenario (t, { originFor = (s, k1, k2) => originRecord(s, k2, k1, 2), locked = false, syncOptions = {}, pad = 0 } = {}) {
  const s = trust()
  const k1 = await pageCore(t, s)
  const k2 = await pageCore(t, s)
  const genuine = movedRecord(s, hex(k1.key), hex(k2.key))
  const forged = { ...genuine, countersignature: (genuine.countersignature[0] === '0' ? '1' : '0') + genuine.countersignature.slice(1) }
  for (let i = 0; i < pad; i++) await k1.append(forged)
  await k1.append(genuine)
  const origin = originFor(s, hex(k1.key), hex(k2.key))
  await k2.append(origin === null ? postRecord({ text: 'sem origem' }) : origin)
  const seeder = await fakeSeeder(t, { signer: s.kp, cores: [k1, k2] })
  const storage = memoryNodeStorage()
  const calls = []
  const keyPair = crypto.keyPair()
  const ownHex = hex(keyPair.publicKey)
  // What the session passes while unlocked: the signed kv queue, never a
  // request (a follow.add would preempt the run that waits for it).
  const followPage = locked
    ? null
    : async (key) => {
      calls.push(key)
      return ops.queueFollowChange(storage, ownHex, keyPair, key, true)
    }
  const node = createBrowserNode({
    storage,
    association: s.hex,
    seederUrl: seeder.url,
    createSocket: (u) => new WebSocket(u),
    syncOptions: { retryMinMs: 100, retryMaxMs: 200, followPage, ...syncOptions },
    writeGate: false
  })
  t.teardown(() => node.close(), { force: true })
  await node.setKeyPair(keyPair)
  const web = await connectClient(node, { timeoutMs: 30000 })
  const { publicKey } = await web.request('identity.create')
  await web.request('cert.add', { cert: createCert({ member: publicKey }, s.kp) })
  await web.request('follow.add', { key: hex(k1.key) })
  return { k1: hex(k1.key), k2: hex(k2.key), web, storage, seeder, calls }
}

async function onceRun (web, timeoutMs = 15000) {
  const { runId } = await web.request('sync.start', { once: true, timeoutMs })
  return stoppedOf(web.events, runId)
}

async function migrated (storage) {
  try {
    return await storage.readJson('pageMigrated')
  } catch {
    return null
  }
}

function pendingFor (ops, key) {
  return ops.filter((op) => op.key === key && op.on === true).length
}

test('web page migrate: a follower of K1 follows K2 once after both records verify, K1 stays followed, a restart queues nothing', async (t) => {
  t.timeout(120000)
  await testnet(t)
  const { k1, k2, web, storage, calls } = await scenario(t)
  const first = await onceRun(web)
  t.is(first.reason, 'done')
  t.is(first.result.downloaded[k1], 4, 'K1 downloaded')
  t.alike(calls, [k2], 'followPage called once with K2')
  const follows = await store.readFollows(storage)
  t.ok(follows.includes(k1), 'K1 stays followed')
  t.ok(follows.includes(k2), 'K2 followed')
  t.is(pendingFor(await store.readFollowsPending(storage), k2), 1, 'one signed follow op queued for K2')
  t.alike(await migrated(storage), { v: 1, migrated: { [k1]: k2 } })

  // An unfollow of K2 after the move is the member's choice: a restart
  // must not follow K2 again.
  await web.request('follow.remove', { key: k2 })
  const second = await onceRun(web)
  t.is(second.reason, 'done')
  t.alike(calls, [k2], 'not called again')
  t.absent((await store.readFollows(storage)).includes(k2), 'K2 not added back')
})

test('web page migrate: 260 forged page-moved copies before the genuine one still migrate', async (t) => {
  t.timeout(120000)
  await testnet(t)
  const { k1, k2, storage, web, calls } = await scenario(t, { pad: 260 })
  const first = await onceRun(web, 30000)
  t.is(first.reason, 'done')
  t.is(first.result.downloaded[k1], 264, 'K1 downloaded')
  t.alike(calls, [k2], 'followPage called once with K2')
  t.ok((await store.readFollows(storage)).includes(k2), 'K2 followed')
})

test('web page migrate: a missing or forged page-origin never follows K2', async (t) => {
  t.timeout(240000)
  await testnet(t)
  const forged = {
    missing: () => null,
    'wrong from': (s, k1, k2) => originRecord(s, k2, 'e'.repeat(64), 3),
    'fromSeq past the page-moved': (s, k1, k2) => originRecord(s, k2, k1, 4),
    'bad countersign': (s, k1, k2) => {
      const r = originRecord(s, k2, k1, 3)
      return { ...r, countersignature: (r.countersignature[0] === '0' ? '1' : '0') + r.countersignature.slice(1) }
    }
  }
  for (const [name, originFor] of Object.entries(forged)) {
    const { k1, k2, web, storage, seeder, calls } = await scenario(t, { originFor })
    const stopped = await onceRun(web)
    t.is(stopped.reason, 'done', name + ': done')
    t.is(stopped.result.downloaded[k1], 4, name + ': K1 downloaded')
    t.ok(seeder.uploads.has(k2) && seeder.uploads.get(k2).has(3), name + ': K2 block 3 was read')
    t.alike(calls, [], name + ': followPage never called')
    t.alike(await store.readFollows(storage), [k1], name + ': K2 not followed')
    t.is(await migrated(storage), null, name + ': nothing remembered')
  }
})

test('web page migrate: noPageMigrate and a locked session never follow K2', async (t) => {
  t.timeout(120000)
  await testnet(t)

  const off = await scenario(t, { syncOptions: { noPageMigrate: true } })
  const a = await onceRun(off.web)
  t.is(a.result.downloaded[off.k1], 4, 'K1 downloaded')
  t.alike(off.calls, [], 'switch on: followPage never called')
  t.absent(off.seeder.uploads.has(off.k2), 'switch on: K2 never read')
  t.alike(await store.readFollows(off.storage), [off.k1])

  const locked = await scenario(t, { locked: true })
  const b = await onceRun(locked.web)
  t.is(b.result.downloaded[locked.k1], 4, 'K1 downloaded')
  t.alike(await store.readFollows(locked.storage), [locked.k1], 'locked: K2 not followed')
  t.is(pendingFor(await store.readFollowsPending(locked.storage), locked.k2), 0, 'locked: nothing queued')
  t.is(await migrated(locked.storage), null, 'locked: nothing remembered')

  // The same scenario unlocked migrates: the switch was the reason.
  const on = await scenario(t)
  await onceRun(on.web)
  t.alike(on.calls, [on.k2], 'switch off: followPage called')
})

function link (a, b) {
  const sa = new NoiseSecretStream(true)
  const sb = new NoiseSecretStream(false)
  sa.rawStream.on('data', (d) => sb.rawStream.write(d))
  sb.rawStream.on('data', (d) => sa.rawStream.write(d))
  a.replicate(sa)
  b.replicate(sb)
  return () => {
    sa.destroy()
    sb.destroy()
  }
}

test('web page migrate: a page-moved a leaked key tombstoned, fetched after the first scan, still migrates without a restart', async (t) => {
  t.timeout(120000)
  await testnet(t)
  const s = trust()
  const k1 = new Hypercore(memoryStorage(), { valueEncoding: 'json' })
  await k1.ready()
  t.teardown(() => k1.close(), { force: true })
  const k1Hex = hex(k1.key)
  const owner = hex(s.ownerKp.publicKey)
  const fields = { type: 'page-roster', page: k1Hex, gen: 1, owner, admins: [], prev: null, at: AT, nonce: nonce('r'), association: s.hex }
  await k1.append(memberCertRecord(createCert({ member: k1Hex }, s.kp)))
  await k1.append(profileRecord({ name: 'Página', bio: '' }))
  await k1.append(page.issuerCountersign({ ...fields, signature: page.signRoster(fields, s.ownerKp) }, s.issuerKp, s.issuerCert))
  const k2 = await pageCore(t, s)
  await k1.append(movedRecord(s, k1Hex, hex(k2.key)))
  await k1.append(deleteRecord({ seq: 3 }))
  await k2.append(originRecord(s, hex(k2.key), k1Hex, 2))

  // The seeder's copy of K1 lacks the page-moved at first: the follower
  // learns its tombstone and passes the hole.
  const stale = new Hypercore(memoryStorage(), k1.key, { valueEncoding: 'json' })
  await stale.ready()
  t.teardown(() => stale.close(), { force: true })
  let unlink = link(k1, stale)
  while (stale.length < k1.length) await stale.update({ wait: true })
  await stale.download({ start: 0, end: k1.length }).done()
  unlink()
  await stale.clear(3, 4)
  t.absent(await stale.has(3), 'the seeder copy lacks the page-moved')

  const seeder = await fakeSeeder(t, { signer: s.kp, cores: [stale, k2] })
  const storage = memoryNodeStorage()
  const calls = []
  const keyPair = crypto.keyPair()
  const ownHex = hex(keyPair.publicKey)
  const node = createBrowserNode({
    storage,
    association: s.hex,
    seederUrl: seeder.url,
    createSocket: (u) => new WebSocket(u),
    syncOptions: {
      retryMinMs: 100,
      retryMaxMs: 200,
      followPage: async (key) => {
        calls.push(key)
        return ops.queueFollowChange(storage, ownHex, keyPair, key, true)
      }
    },
    writeGate: false
  })
  t.teardown(() => node.close(), { force: true })
  await node.setKeyPair(keyPair)
  const web = await connectClient(node, { timeoutMs: 30000 })
  const { publicKey } = await web.request('identity.create')
  await web.request('cert.add', { cert: createCert({ member: publicKey }, s.kp) })
  await web.request('follow.add', { key: k1Hex })
  await web.request('sync.start', {})

  const until = async (fn, ms) => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      if (await fn()) return true
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    return false
  }
  const served = () => seeder.uploads.has(k1Hex) && [0, 1, 2, 4].every((i) => seeder.uploads.get(k1Hex).has(i))
  t.ok(await until(served, 30000), 'the follower read K1 but the page-moved')
  await new Promise((resolve) => setTimeout(resolve, 1500))
  t.alike(calls, [], 'nothing to migrate before the page-moved is held')

  unlink = link(k1, stale)
  t.teardown(unlink)
  await stale.download({ start: 3, end: 4 }).done()
  t.ok(await until(() => calls.length > 0, 30000), 'the page-moved fetched later is scanned and verified')
  t.alike(calls, [hex(k2.key)], 'followPage called once with K2')
  t.ok((await store.readFollows(storage)).includes(k1Hex), 'K1 stays followed')
})

// Calls of core.has(i) on the diary `key`, per function on the stack
// (FNS); hold(fn, i) parks the first such call until released.
const FNS = ['scanPageAt', 'heldPageType']
function spyHas (t, key) {
  const has = Hypercore.prototype.has
  const calls = Object.fromEntries(FNS.map((fn) => [fn, []]))
  const holds = new Map()
  const releases = []
  Hypercore.prototype.has = async function (i, ...rest) {
    if (this.key && typeof i === 'number' && hex(this.key) === key) {
      const stack = new Error().stack
      const fn = FNS.find((name) => stack.includes(name))
      if (fn) {
        calls[fn].push(i)
        const hold = holds.get(fn + i)
        if (hold) {
          holds.delete(fn + i)
          hold.reached()
          await hold.released
        }
      }
    }
    return has.call(this, i, ...rest)
  }
  t.teardown(() => {
    Hypercore.prototype.has = has
    for (const release of releases) release()
  })
  return {
    calls,
    hold (fn, i) {
      let reached
      let release
      const released = new Promise((resolve) => { release = resolve })
      const at = new Promise((resolve) => { reached = resolve })
      holds.set(fn + i, { reached, released })
      releases.push(release)
      return { at, release }
    }
  }
}

async function until (fn, ms) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await fn()) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return false
}

// A page K1 (roster 2, at 3 a page-moved, or a post when `moved` is false,
// tombstoned at 4, posts after, then a tombstone per seq of `holes`) whose
// seeder copy lacks block 3 and `holes`; a browser node following K1 with
// syncOptions. fill() gives the seeder copy every block.
async function lateWeb (t, { moved = true, posts = 5, holes = [], syncOptions = {} } = {}) {
  const s = trust()
  const k1 = new Hypercore(memoryStorage(), { valueEncoding: 'json' })
  await k1.ready()
  t.teardown(() => k1.close(), { force: true })
  const k1Hex = hex(k1.key)
  const owner = hex(s.ownerKp.publicKey)
  const fields = { type: 'page-roster', page: k1Hex, gen: 1, owner, admins: [], prev: null, at: AT, nonce: nonce('r'), association: s.hex }
  await k1.append(memberCertRecord(createCert({ member: k1Hex }, s.kp)))
  await k1.append(profileRecord({ name: 'Página', bio: '' }))
  await k1.append(page.issuerCountersign({ ...fields, signature: page.signRoster(fields, s.ownerKp) }, s.issuerKp, s.issuerCert))
  const k2 = await pageCore(t, s)
  await k1.append(moved ? movedRecord(s, k1Hex, hex(k2.key)) : postRecord({ text: 'apagado' }))
  await k1.append(deleteRecord({ seq: 3 }))
  for (let i = 0; i < posts; i++) await k1.append(postRecord({ text: 'depois ' + i }))
  for (const seq of holes) await k1.append(deleteRecord({ seq }))
  await k2.append(originRecord(s, hex(k2.key), k1Hex, 2))

  const stale = new Hypercore(memoryStorage(), k1.key, { valueEncoding: 'json' })
  await stale.ready()
  t.teardown(() => stale.close(), { force: true })
  const unlink = link(k1, stale)
  while (stale.length < k1.length) await stale.update({ wait: true })
  await stale.download({ start: 0, end: k1.length }).done()
  unlink()
  for (const seq of [3, ...holes]) await stale.clear(seq, seq + 1)

  const seeder = await fakeSeeder(t, { signer: s.kp, cores: [stale, k2] })
  const storage = memoryNodeStorage()
  const calls = []
  const keyPair = crypto.keyPair()
  const ownHex = hex(keyPair.publicKey)
  const node = createBrowserNode({
    storage,
    association: s.hex,
    seederUrl: seeder.url,
    createSocket: (u) => new WebSocket(u),
    syncOptions: {
      retryMinMs: 100,
      retryMaxMs: 200,
      followPage: async (key) => {
        calls.push(key)
        return ops.queueFollowChange(storage, ownHex, keyPair, key, true)
      },
      ...syncOptions
    },
    writeGate: false
  })
  t.teardown(() => node.close(), { force: true })
  await node.setKeyPair(keyPair)
  const web = await connectClient(node, { timeoutMs: 30000 })
  const { publicKey } = await web.request('identity.create')
  await web.request('cert.add', { cert: createCert({ member: publicKey }, s.kp) })
  await web.request('follow.add', { key: k1Hex })
  const fill = async () => {
    t.teardown(link(k1, stale))
    await stale.download({ start: 0, end: k1.length }).done()
  }
  return { k1Hex, k2Hex: hex(k2.key), length: k1.length, web, calls, fill }
}

test('web page migrate: a pageLate overflow during a running scan keeps the rewound cursor, so the late page-moved is scanned and K2 followed', async (t) => {
  t.timeout(120000)
  await testnet(t)
  const late = await lateWeb(t, { syncOptions: { maxPageLate: 0 } })
  const spy = spyHas(t, late.k1Hex)
  // A walk parks on block 8, past the hole at 3.
  const parked = spy.hold('scanPageAt', 8)
  const landed = spy.hold('heldPageType', 3)
  await late.web.request('sync.start', {})
  await parked.at
  t.ok(spy.calls.scanPageAt.includes(3), 'the walk passed the hole at 3')
  // The page-moved lands while the walk waits; maxPageLate 0 rewinds.
  await late.fill()
  await landed.at
  landed.release()
  await new Promise((resolve) => setTimeout(resolve, 300))
  parked.release()
  t.ok(await until(() => late.calls.length > 0, 30000), 'the rewind survives the walk: the page-moved is scanned and verified')
  t.alike(late.calls, [late.k2Hex], 'followPage called once with K2')
})

test('web page migrate: late deleted posts of a page take no pageLate slot and force no rescan', async (t) => {
  t.timeout(120000)
  await testnet(t)
  const holes = [5, 6, 7, 8, 9]
  const late = await lateWeb(t, { moved: false, holes, syncOptions: { maxPageLate: 0 } })
  const spy = spyHas(t, late.k1Hex)
  await late.web.request('sync.start', {})
  t.ok(await until(() => spy.calls.scanPageAt.includes(late.length - 1), 30000), 'the walk reached the last block')
  await new Promise((resolve) => setTimeout(resolve, 500))
  const walked = spy.calls.scanPageAt.length
  // The follower fetches each deleted post once (a page keeps an unheld
  // target in its download until it is read).
  await late.fill()
  t.ok(await until(() => [3, ...holes].every((i) => spy.calls.heldPageType.includes(i)), 30000), 'the deleted posts arrived late')
  await new Promise((resolve) => setTimeout(resolve, 1000))
  t.is(spy.calls.scanPageAt.length, walked, 'no rescan: a post never rewinds the cursor')
})
