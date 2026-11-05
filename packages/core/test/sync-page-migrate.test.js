'use strict'

const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { testnet, localSwarmOptions } = require('./helpers/net')
const { tmpDir } = require('./helpers/tmp')
const { runSync } = require('../lib/sync')
const {
  openStore,
  openDiary,
  openReplica,
  readAll,
  appendRecord,
  writeConfig,
  readFollows,
  writeFollows
} = require('../lib/store')
const NoiseSecretStream = require('@hyperswarm/secret-stream')
const { memberCertRecord, profileRecord, postRecord, followRecord, deleteRecord } = require('../lib/records')
const { createCert, createIssuerCert, generateAssociationKeyPair } = require('../lib/cert')
const page = require('../lib/page')
const Hypercore = require('hypercore')

const AT = '2026-01-01T00:00:00.000Z'
const hex = (buf) => b4a.toString(buf, 'hex')
const nonce = (c) => c.repeat(43)

function trust () {
  const kp = generateAssociationKeyPair()
  const issuerKp = crypto.keyPair()
  const issuerCert = createIssuerCert({ issuer: hex(issuerKp.publicKey), date: AT }, kp)
  return { kp, assoc: hex(kp.publicKey), issuerKp, issuerCert, ownerKp: crypto.keyPair() }
}

async function makeMember (t, kp, posts) {
  const dir = tmpDir(t, 'varanda-migrate-')
  const store = await openStore(dir)
  try {
    const diary = await openDiary(store)
    const key = hex(diary.key)
    writeConfig(dir, { v: 1, role: 'member', association: hex(kp.publicKey) })
    await appendRecord(diary, memberCertRecord(createCert({ member: key }, kp)))
    await appendRecord(diary, profileRecord({ name: 'Página', bio: '' }))
    for (let i = 0; i < posts; i++) await appendRecord(diary, postRecord({ text: 'post ' + i }))
    return { dir, key }
  } finally {
    await store.close()
  }
}

async function append (dir, record) {
  const store = await openStore(dir)
  try {
    return await appendRecord(await openDiary(store), record)
  } finally {
    await store.close()
  }
}

async function ownEntries (dir) {
  const store = await openStore(dir)
  try {
    return await readAll(await openDiary(store))
  } finally {
    await store.close()
  }
}

function movedRecord (s, k1, k2) {
  const owner = hex(s.ownerKp.publicKey)
  const fields = { type: 'page-moved', page: k1, to: k2, gen: 2, at: AT, nonce: nonce('m'), actor: owner, association: s.assoc }
  return page.issuerCountersign({ ...fields, signature: page.signMoved(fields, s.ownerKp) }, s.issuerKp, s.issuerCert)
}

function originRecord (s, k2, from, fromSeq) {
  const owner = hex(s.ownerKp.publicKey)
  const fields = { type: 'page-origin', page: k2, from, fromSeq, gen: 1, owner, admins: [], at: AT, nonce: nonce('g'), actor: owner, association: s.assoc }
  return page.issuerCountersign({ ...fields, signature: page.signOrigin(fields, s.ownerKp) }, s.issuerKp, s.issuerCert)
}

// K1 (seq 3 page-moved to K2) and K2 (seq 3 from originFor(s, k1, k2), or a
// post when it returns null), both served by long-running runs; a follower B
// of K1. The page diaries are member-shaped: the gate reads block 0 only.
// pad: forged (unverifiable) page-moved copies appended to K1 before the
// genuine one, which then sits at seq 3 + pad.
async function scenario (t, bootstrap, { originFor = (s, k1, k2) => originRecord(s, k2, k1, 2), pad = 0, serveK2 = true, s = trust() } = {}) {
  const k1 = await makeMember(t, s.kp, 1)
  const k2 = await makeMember(t, s.kp, 1)
  if (pad > 0) {
    const genuine = movedRecord(s, k1.key, k2.key)
    const forged = { ...genuine, countersignature: (genuine.countersignature[0] === '0' ? '1' : '0') + genuine.countersignature.slice(1) }
    const store = await openStore(k1.dir)
    try {
      const diary = await openDiary(store)
      for (let i = 0; i < pad; i++) await appendRecord(diary, forged)
    } finally {
      await store.close()
    }
  }
  t.is(await append(k1.dir, movedRecord(s, k1.key, k2.key)), 3 + pad)
  const origin = originFor(s, k1.key, k2.key)
  t.is(await append(k2.dir, origin === null ? postRecord({ text: 'sem origem' }) : origin), 3)
  const b = await makeMember(t, s.kp, 0)
  writeFollows(b.dir, [k1.key])
  const controller = new AbortController()
  const serve = { ...localSwarmOptions(bootstrap), signal: controller.signal }
  const runs = []
  const start = (m) => {
    let onReady
    const ready = new Promise((resolve) => { onReady = resolve })
    runs.push(runSync({ ...serve, dataDir: m.dir, onEvent: (ev) => { if (ev.event === 'ready') onReady() } }))
    return ready
  }
  t.teardown(async () => {
    controller.abort()
    await Promise.allSettled(runs)
  })
  await Promise.all(serveK2 ? [start(k1), start(k2)] : [start(k1)])
  return { s, k1, k2, b, serveK2: () => start(k2), stop: async () => { controller.abort(); await Promise.allSettled(runs) } }
}

function syncB (bootstrap, b, extra = {}) {
  const events = []
  const p = runSync({ ...localSwarmOptions(bootstrap), dataDir: b.dir, once: true, timeoutMs: 30000, onEvent: (ev) => events.push(ev), ...extra })
  return p.then((result) => ({ result, events }))
}

function migrateEvents (events) {
  return events.filter((ev) => ev.event === 'page-migrate')
}

function followCount (entries, key) {
  return entries.filter((e) => e.record && e.record.type === 'follow' && e.record.key === key && e.record.on === true).length
}

test('page migrate: a follower of K1 follows K2 once after both records verify, K1 stays followed, a restart appends nothing', async (t) => {
  t.timeout(180000)
  const { bootstrap } = await testnet(t)
  const { k1, k2, b } = await scenario(t, bootstrap)

  const first = await syncB(bootstrap, b)
  t.ok(first.result.ok, 'B ok ' + JSON.stringify(first.result.errors))
  t.is(first.result.downloaded[k1.key], 4, 'K1 downloaded')
  t.alike(migrateEvents(first.events), [{ event: 'page-migrate', reason: 'migrated' }])
  for (const ev of migrateEvents(first.events)) t.absent(JSON.stringify(ev).includes(k1.key.slice(0, 8)), 'no key in the log')
  const follows = readFollows(b.dir)
  t.ok(follows.includes(k1.key), 'K1 stays in follows.json')
  t.ok(follows.includes(k2.key), 'K2 in follows.json')
  let entries = await ownEntries(b.dir)
  t.is(followCount(entries, k2.key), 1, 'one follow of K2 in the own diary')
  const memoryFile = path.join(b.dir, 'page-migrated.json')
  const memory = fs.existsSync(memoryFile) ? JSON.parse(fs.readFileSync(memoryFile, 'utf8')) : null
  t.alike(memory, { v: 1, migrated: { [k1.key]: k2.key } })

  // An unfollow of K2 after the move is the member's choice: a restart must
  // not follow K2 again.
  await append(b.dir, followRecord({ key: k2.key, on: false }))
  writeFollows(b.dir, [k1.key])
  const second = await syncB(bootstrap, b)
  t.ok(second.result.ok, 'B ok again ' + JSON.stringify(second.result.errors))
  entries = await ownEntries(b.dir)
  t.is(followCount(entries, k2.key), 1, 'still one follow of K2')
  t.alike(readFollows(b.dir), [k1.key], 'K2 not added back')
  t.alike(migrateEvents(second.events), [{ event: 'page-migrate', reason: 'already-migrated' }])
})

test('page migrate: 260 forged page-moved copies before the genuine one still migrate', async (t) => {
  t.timeout(180000)
  const { bootstrap } = await testnet(t)
  const { k1, k2, b } = await scenario(t, bootstrap, { pad: 260 })
  const { result, events } = await syncB(bootstrap, b)
  t.ok(result.ok, 'B ok ' + JSON.stringify(result.errors))
  t.is(result.downloaded[k1.key], 264, 'K1 downloaded')
  t.alike(migrateEvents(events), [{ event: 'page-migrate', reason: 'migrated' }])
  t.ok(readFollows(b.dir).includes(k2.key), 'K2 followed')
})

test('page migrate: K2 unreadable at first, then served, migrates without a restart', async (t) => {
  t.timeout(180000)
  const { bootstrap } = await testnet(t)
  const { k1, k2, b, serveK2 } = await scenario(t, bootstrap, { serveK2: false })
  const events = []
  let seen = null
  const unreadable = new Promise((resolve) => { seen = resolve })
  let done = null
  const migratedOnce = new Promise((resolve) => { done = resolve })
  const controller = new AbortController()
  const run = runSync({
    ...localSwarmOptions(bootstrap),
    dataDir: b.dir,
    signal: controller.signal,
    onEvent: (ev) => {
      events.push(ev)
      if (ev.event !== 'page-migrate') return
      if (ev.reason === 'unreadable') seen()
      if (ev.reason === 'migrated') done()
    }
  })
  t.teardown(async () => {
    controller.abort()
    await run.catch(() => {})
  })
  await unreadable
  t.pass('the first try finds K2 unreadable')
  await serveK2()
  await migratedOnce
  controller.abort()
  await run.catch(() => {})
  t.ok(migrateEvents(events).every((ev) => ev.reason === 'unreadable' || ev.reason === 'migrated'), 'only retries, then the move')
  t.ok(readFollows(b.dir).includes(k2.key), 'K2 followed')
  t.ok(readFollows(b.dir).includes(k1.key), 'K1 stays followed')
  t.is(followCount(await ownEntries(b.dir), k2.key), 1, 'one follow of K2')
})

test('page migrate: a missing or forged page-origin never follows K2', async (t) => {
  t.timeout(300000)
  const { bootstrap } = await testnet(t)
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
    const { k1, k2, b, stop } = await scenario(t, bootstrap, { originFor })
    const { result, events } = await syncB(bootstrap, b)
    t.ok(result.ok, name + ': B ok ' + JSON.stringify(result.errors))
    t.is(result.downloaded[k1.key], 4, name + ': K1 downloaded')
    t.alike(migrateEvents(events), [{ event: 'page-migrate', reason: 'unverified' }], name + ': refused')
    t.alike(readFollows(b.dir), [k1.key], name + ': K2 not followed')
    t.is(followCount(await ownEntries(b.dir), k2.key), 0, name + ': nothing appended')
    t.absent(fs.existsSync(path.join(b.dir, 'page-migrated.json')), name + ': nothing remembered')
    await stop()
  }
})

test('page migrate: the kill switch (noPageMigrate and VARANDA_NO_PAGE_MIGRATE=1) never follows K2', async (t) => {
  t.timeout(180000)
  const { bootstrap } = await testnet(t)
  const { k1, k2, b } = await scenario(t, bootstrap)

  const opt = await syncB(bootstrap, b, { noPageMigrate: true })
  t.ok(opt.result.ok, 'B ok ' + JSON.stringify(opt.result.errors))
  t.is(opt.result.downloaded[k1.key], 4, 'K1 downloaded')
  t.alike(migrateEvents(opt.events), [], 'no check with the option')

  const saved = process.env.VARANDA_NO_PAGE_MIGRATE
  process.env.VARANDA_NO_PAGE_MIGRATE = '1'
  let env
  try {
    env = await syncB(bootstrap, b)
  } finally {
    if (saved === undefined) delete process.env.VARANDA_NO_PAGE_MIGRATE
    else process.env.VARANDA_NO_PAGE_MIGRATE = saved
  }
  t.ok(env.result.ok, 'B ok ' + JSON.stringify(env.result.errors))
  t.alike(migrateEvents(env.events), [], 'no check with the env switch')
  t.alike(readFollows(b.dir), [k1.key])
  t.is(followCount(await ownEntries(b.dir), k2.key), 0)

  // Switched back on, the same data dir migrates: the switch was the reason.
  const on = await syncB(bootstrap, b)
  t.alike(migrateEvents(on.events), [{ event: 'page-migrate', reason: 'migrated' }])
  t.alike(readFollows(b.dir).sort(), [k1.key, k2.key].sort())
})

// A replica of `source` in `follower`'s store without block `hole` (a seq or
// a list of them): what a
// follower holds after a peer served the tombstone but not its target.
async function staleReplica (follower, source, hole) {
  const a = await openStore(source.dir)
  const b = await openStore(follower.dir)
  const sa = new NoiseSecretStream(true)
  const sb = new NoiseSecretStream(false)
  sa.rawStream.on('data', (d) => sb.rawStream.write(d))
  sb.rawStream.on('data', (d) => sa.rawStream.write(d))
  try {
    a.replicate(sa)
    b.replicate(sb)
    const src = await openDiary(a)
    const replica = await openReplica(b, source.key)
    while (replica.length < src.length) await replica.update({ wait: true })
    await replica.download({ start: 0, end: src.length }).done()
    for (const seq of [].concat(hole)) await replica.clear(seq, seq + 1)
    return src.length
  } finally {
    sa.destroy()
    sb.destroy()
    await b.close()
    await a.close()
  }
}

test('page migrate: a page-moved a leaked key tombstoned, fetched after the first scan, still migrates without a restart', async (t) => {
  t.timeout(180000)
  const { bootstrap } = await testnet(t)
  const s = trust()
  const k1 = await makeMember(t, s.kp, 0)
  const k2 = await makeMember(t, s.kp, 1)
  const owner = hex(s.ownerKp.publicKey)
  const fields = { type: 'page-roster', page: k1.key, gen: 1, owner, admins: [], prev: null, at: AT, nonce: nonce('r'), association: s.assoc }
  t.is(await append(k1.dir, page.issuerCountersign({ ...fields, signature: page.signRoster(fields, s.ownerKp) }, s.issuerKp, s.issuerCert)), 2)
  t.is(await append(k1.dir, movedRecord(s, k1.key, k2.key)), 3)
  t.is(await append(k1.dir, deleteRecord({ seq: 3 })), 4)
  t.is(await append(k2.dir, originRecord(s, k2.key, k1.key, 2)), 3)
  const b = await makeMember(t, s.kp, 0)
  writeFollows(b.dir, [k1.key])
  t.is(await staleReplica(b, k1, 3), 5, 'B holds K1 but the page-moved')

  const controller = new AbortController()
  const runs = []
  const start = (m) => {
    let onReady
    const ready = new Promise((resolve) => { onReady = resolve })
    runs.push(runSync({ ...localSwarmOptions(bootstrap), signal: controller.signal, dataDir: m.dir, onEvent: (ev) => { if (ev.event === 'ready') onReady() } }))
    return ready
  }
  t.teardown(async () => {
    controller.abort()
    await Promise.allSettled(runs)
  })
  await start(k2)

  const events = []
  let scanned = null
  const grown = new Promise((resolve) => { scanned = resolve })
  let done = null
  const migrated = new Promise((resolve) => { done = resolve })
  runs.push(runSync({
    ...localSwarmOptions(bootstrap),
    dataDir: b.dir,
    signal: controller.signal,
    onEvent: (ev) => {
      events.push(ev)
      // The stored replica is activated (and scanned) before 'ready'.
      if (ev.event === 'ready') scanned()
      if (ev.event === 'page-migrate' && ev.reason === 'migrated') done()
    }
  }))
  await grown
  // The first scan passes the hole; nothing serves the page-moved yet.
  await new Promise((resolve) => setTimeout(resolve, 1000))
  t.alike(migrateEvents(events), [], 'nothing to migrate before the page-moved is held')

  await start(k1)
  const late = await Promise.race([migrated.then(() => true), new Promise((resolve) => setTimeout(resolve, 30000, false))])
  t.ok(late, 'the page-moved fetched later is scanned and verified')
  t.ok(readFollows(b.dir).includes(k2.key), 'K2 followed')
  t.ok(readFollows(b.dir).includes(k1.key), 'K1 stays followed')
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
    if (fn()) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return false
}

// A page K1 (roster 2, at 3 a page-moved, or a post when `moved` is false,
// tombstoned at 4, posts after, then a tombstone per seq of `holes`); B
// holds all of it but block 3 and `holes`, and follows K1; K2 is served.
async function lateScenario (t, bootstrap, { moved = true, posts = 5, holes = [] } = {}) {
  const s = trust()
  const k1 = await makeMember(t, s.kp, 0)
  const k2 = await makeMember(t, s.kp, 1)
  const owner = hex(s.ownerKp.publicKey)
  const fields = { type: 'page-roster', page: k1.key, gen: 1, owner, admins: [], prev: null, at: AT, nonce: nonce('r'), association: s.assoc }
  t.is(await append(k1.dir, page.issuerCountersign({ ...fields, signature: page.signRoster(fields, s.ownerKp) }, s.issuerKp, s.issuerCert)), 2)
  t.is(await append(k1.dir, moved ? movedRecord(s, k1.key, k2.key) : postRecord({ text: 'apagado' })), 3)
  t.is(await append(k1.dir, deleteRecord({ seq: 3 })), 4)
  for (let i = 0; i < posts; i++) await append(k1.dir, postRecord({ text: 'depois ' + i }))
  for (const seq of holes) await append(k1.dir, deleteRecord({ seq }))
  t.is(await append(k2.dir, originRecord(s, k2.key, k1.key, 2)), 3)
  const b = await makeMember(t, s.kp, 0)
  writeFollows(b.dir, [k1.key])
  const length = await staleReplica(b, k1, [3, ...holes])
  const controller = new AbortController()
  const runs = []
  const start = (m, extra = {}) => {
    let onReady
    const ready = new Promise((resolve) => { onReady = resolve })
    const onEvent = (ev) => {
      if (ev.event === 'ready') onReady()
      if (extra.onEvent) extra.onEvent(ev)
    }
    runs.push(runSync({ ...localSwarmOptions(bootstrap), signal: controller.signal, dataDir: m.dir, ...extra, onEvent }))
    return ready
  }
  t.teardown(async () => {
    controller.abort()
    await Promise.allSettled(runs)
  })
  await start(k2)
  return { k1, k2, b, start, length }
}

test('page migrate: a pageLate overflow during a running scan keeps the rewound cursor, so the late page-moved is scanned and K2 followed', async (t) => {
  t.timeout(180000)
  const { bootstrap } = await testnet(t)
  const { k1, k2, b, start } = await lateScenario(t, bootstrap)
  const spy = spyHas(t, k1.key)
  // The first walk parks on block 8, past the hole at 3.
  const parked = spy.hold('scanPageAt', 8)
  const landed = spy.hold('heldPageType', 3)
  let done = null
  const migrated = new Promise((resolve) => { done = resolve })
  start(b, { maxPageLate: 0, onEvent: (ev) => { if (ev.event === 'page-migrate' && ev.reason === 'migrated') done() } })
  await parked.at
  t.ok(spy.calls.scanPageAt.includes(3), 'the walk passed the hole at 3')
  // The page-moved lands while the walk waits; maxPageLate 0 rewinds.
  start(k1)
  await landed.at
  landed.release()
  await new Promise((resolve) => setTimeout(resolve, 300))
  parked.release()
  const ok = await Promise.race([migrated.then(() => true), new Promise((resolve) => setTimeout(resolve, 30000, false))])
  t.ok(ok, 'the rewind survives the walk: the page-moved is scanned and verified')
  t.ok(readFollows(b.dir).includes(k2.key), 'K2 followed')
})

test('page migrate: late deleted posts of a page take no pageLate slot and force no rescan', async (t) => {
  t.timeout(180000)
  const { bootstrap } = await testnet(t)
  const holes = [5, 6, 7, 8, 9]
  const { k1, b, start, length } = await lateScenario(t, bootstrap, { moved: false, holes })
  const spy = spyHas(t, k1.key)
  await start(b, { maxPageLate: 0 })
  t.ok(await until(() => spy.calls.scanPageAt.includes(length - 1), 10000), 'the first walk ended')
  await new Promise((resolve) => setTimeout(resolve, 300))
  const walked = spy.calls.scanPageAt.length
  // B fetches each deleted post once (a page keeps an unheld target in its
  // download until it is read).
  start(k1)
  t.ok(await until(() => [3, ...holes].every((i) => spy.calls.heldPageType.includes(i)), 30000), 'the deleted posts arrived late')
  await new Promise((resolve) => setTimeout(resolve, 1000))
  t.is(spy.calls.scanPageAt.length, walked, 'no rescan: a post never rewinds the cursor')
})

test('page migrate: two pages that move at once both land in follows.json', async (t) => {
  t.timeout(180000)
  const { bootstrap } = await testnet(t)
  const s = trust()
  const a = await scenario(t, bootstrap, { s })
  const c = await scenario(t, bootstrap, { s })
  writeFollows(a.b.dir, [a.k1.key, c.k1.key])
  // The first follow append waits until the second migration appends too
  // (3 s at most): without one writer at a time, both read follows.json
  // before either writes it.
  const append = Hypercore.prototype.append
  let first = null
  let second = null
  const secondStarted = new Promise((resolve) => { second = resolve })
  Hypercore.prototype.append = async function (...args) {
    if (this.key && hex(this.key) === a.b.key) {
      if (first === null) {
        first = true
        await Promise.race([secondStarted, new Promise((resolve) => setTimeout(resolve, 3000))])
      } else second()
    }
    return append.apply(this, args)
  }
  t.teardown(() => { Hypercore.prototype.append = append })
  const { events } = await syncB(bootstrap, a.b)
  t.alike(migrateEvents(events).map((ev) => ev.reason), ['migrated', 'migrated'])
  const follows = readFollows(a.b.dir)
  t.ok(follows.includes(a.k2.key), 'the first K2 is followed')
  t.ok(follows.includes(c.k2.key), 'the second K2 is followed')
  const own = await ownEntries(a.b.dir)
  t.is(followCount(own, a.k2.key) + followCount(own, c.k2.key), 2, 'one follow record each')
})

test('page migrate: a diary that already follows K2 writes K2 back to follows.json', async (t) => {
  t.timeout(180000)
  const { bootstrap } = await testnet(t)
  const { k1, k2, b } = await scenario(t, bootstrap)
  // A crash after the append, before follows.json was written.
  await append(b.dir, followRecord({ key: k2.key, on: true }))
  t.alike(readFollows(b.dir), [k1.key])
  const { events } = await syncB(bootstrap, b)
  t.alike(migrateEvents(events).map((ev) => ev.reason), ['already-following'])
  t.ok(readFollows(b.dir).includes(k2.key), 'K2 written back')
  t.is(followCount(await ownEntries(b.dir), k2.key), 1, 'no second follow record')
})
