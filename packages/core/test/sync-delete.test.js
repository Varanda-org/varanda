const test = require('brittle')
const b4a = require('b4a')
const Corestore = require('corestore')
const { testnet, until, localSwarmOptions } = require('./helpers/net')
const { tmpDir } = require('./helpers/tmp')
const { runSync } = require('../lib/sync')
const member = require('../lib/member')
const {
  openStore,
  openDiary,
  openReplica,
  readAll,
  appendRecord,
  writeConfig,
  writeFollows,
  replicaStored
} = require('../lib/store')
const { memberCertRecord, profileRecord, postRecord, deleteRecord } = require('../lib/records')
const { createCert, createSeederCert, certForKey, generateAssociationKeyPair } = require('../lib/cert')
const {
  createSwarm,
  topicFor,
  joinAndFlush,
  attachAdmission,
  watchContiguous,
  generateNoiseKeyPair
} = require('../lib/net')

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

// block 0 cert, 1 profile, 2 'post 0', 3 'post 1'
async function makeMember (t, kp, { posts = 2 } = {}) {
  const dir = tmpDir(t, 'varanda-sync-del-')
  const store = await openStore(dir)
  try {
    const diary = await openDiary(store)
    const key = hex(diary.key)
    writeConfig(dir, { v: 1, role: 'member', association: hex(kp.publicKey) })
    await appendRecord(diary, memberCertRecord(createCert({ member: key }, kp)))
    await appendRecord(diary, profileRecord({ name: 'Membro', bio: '' }))
    for (let i = 0; i < posts; i++) await appendRecord(diary, postRecord({ text: 'post ' + i }))
    return { dir, key }
  } finally {
    await store.close()
  }
}

// A raw node that ignores tombstones: it keeps every block of `key` it ever
// downloaded and advertises it. As a seeder (verified cert) it also admits
// announced diaries, like the fake seeder of sync.test.js.
async function staleHolder (t, bootstrap, kp, key, { seeder = false } = {}) {
  const association = hex(kp.publicKey)
  const store = new Corestore(tmpDir(t, 'varanda-stale-'))
  await store.ready()
  const noise = generateNoiseKeyPair()
  const cert = seeder ? createSeederCert({ seeder: hex(noise.publicKey) }, kp) : null
  const swarm = createSwarm({ ...localSwarmOptions(bootstrap), keyPair: noise })
  const peers = new Set()
  const stops = []
  t.teardown(async () => {
    for (const stop of stops) stop()
    await swarm.destroy()
    await store.close()
  }, { force: true })

  const held = []
  const hold = async (k) => {
    const core = store.get({ key: b4a.from(k, 'hex') })
    await core.ready()
    held.push(core)
    const range = core.download({ start: 0, end: -1 })
    stops.push(() => range.destroy())
    stops.push(watchContiguous(core, (length) => {
      for (const p of peers) p.send({ type: 'have', key: k, length })
    }))
    return core
  }
  const core = await hold(key)

  const admit = async (msg, peer) => {
    if (!certForKey(msg.cert, msg.key, association).ok) return
    const c = await hold(msg.key)
    await c.get(0, { timeout: 10000 })
    peer.send({ type: 'admitted', key: msg.key, length: c.contiguousLength })
  }
  swarm.on('connection', (socket) => {
    socket.on('error', () => {})
    store.replicate(socket)
    const peer = attachAdmission(socket, {
      role: seeder ? 'seeder' : 'member',
      cert,
      have: held.map((c) => ({ key: hex(c.key), length: c.contiguousLength })),
      onmessage: (msg, p) => {
        if (seeder && msg.type === 'announce') admit(msg, p).catch(() => {})
      },
      onclose: (p) => peers.delete(p)
    })
    peers.add(peer)
  })
  await joinAndFlush(swarm, [topicFor(association), core.discoveryKey])
  return { core }
}

// What a member's store holds of `key`: block 3 local, readAll, stored.
async function inspect (dir, key) {
  const store = await openStore(dir)
  try {
    if (!(await replicaStored(store, key))) return { stored: false }
    const replica = await openReplica(store, key)
    try {
      return { stored: true, has3: await replica.has(3), entries: await readAll(replica) }
    } finally {
      await replica.close()
    }
  } finally {
    await store.close()
  }
}

// Stopped on teardown too, so a failed assertion never leaves the data-dir
// lock held while the directory is removed.
function longRun (t, bootstrap, dataDir) {
  const controller = new AbortController()
  const done = runSync({ ...localSwarmOptions(bootstrap), dataDir, signal: controller.signal })
  const stop = () => { controller.abort(); return done }
  t.teardown(() => stop().catch(() => {}), { force: true })
  return { done, stop }
}

// One follower at a time: a --once run ends as soon as the peers that said
// hello leave nothing unmet, so a sibling still at an older length would end
// it early. Only A and C, both at the target length, are up meanwhile.
async function onceEach (runs) {
  const results = []
  for (const opts of runs) results.push(await runSync(opts))
  return results
}

test('a deleted block is cleared by followers and never fetched back from a stale peer', async (t) => {
  t.timeout(240000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const a = await makeMember(t, kp)
  const b = await makeMember(t, kp, { posts: 0 })
  const e = await makeMember(t, kp, { posts: 0 })
  const f = await makeMember(t, kp, { posts: 0 })
  writeFollows(b.dir, [a.key])
  writeFollows(e.dir, [a.key])
  writeFollows(f.dir, [a.key])
  const once = { ...localSwarmOptions(bootstrap), once: true, timeoutMs: 30000 }

  // 1. C copies A; B and E follow A and hold every block.
  const c = await staleHolder(t, bootstrap, kp, a.key)
  {
    const ra = longRun(t, bootstrap, a.dir)
    await until(() => c.core.contiguousLength === 4, { timeoutMs: 30000, name: 'C holds A' })
    const [rb, re, rf] = await onceEach([b, e, f].map((m) => ({ ...once, dataDir: m.dir })))
    await ra.stop()
    t.ok(rb.ok && re.ok && rf.ok, 'first sync ok ' + JSON.stringify([rb.errors, re.errors, rf.errors]))
    t.is(rb.downloaded[a.key], 4)
    t.ok((await inspect(b.dir, a.key)).has3, 'B holds block 3')
    t.ok((await inspect(f.dir, a.key)).has3, 'F holds block 3')
  }

  // 2. A deletes block 3 (its writer clears its own copy). F syncs and clears
  //    the block it held when the tombstone arrives. B and E sync with the
  //    kill switch: they hold the tombstone and keep the bytes. C, which
  //    ignores tombstones, downloads the tombstone and keeps block 3.
  {
    const store = await openStore(a.dir)
    try {
      const diary = await openDiary(store)
      await appendRecord(diary, deleteRecord({ seq: 3 }))
      await diary.clear(3, 4)
    } finally {
      await store.close()
    }
    const ra = longRun(t, bootstrap, a.dir)
    // C first: a run that only meets a peer still advertising 4 ends there.
    await until(() => c.core.contiguousLength === 5, { timeoutMs: 30000, name: 'C holds the tombstone' })
    const [rb, re, rf] = await onceEach([
      { ...once, dataDir: b.dir, noClear: true },
      { ...once, dataDir: e.dir, noClear: true },
      { ...once, dataDir: f.dir }
    ])
    await ra.stop()
    t.ok(rb.ok && re.ok && rf.ok, 'second sync ok ' + JSON.stringify([rb.errors, re.errors, rf.errors]))
    t.is(rf.downloaded[a.key], 5)
    const iff = await inspect(f.dir, a.key)
    t.absent(iff.has3, 'F cleared block 3 when the tombstone arrived')
    t.ok(iff.entries[3].deleted, 'F marks it deleted')
    t.is(rb.downloaded[a.key], 5, 'the deleted hole does not hold the present length back')
    const ib = await inspect(b.dir, a.key)
    t.ok(ib.has3, 'kill switch: B keeps the bytes')
    t.ok(ib.entries[3].deleted, 'the fold still hides the block')
  }

  // 3. A is offline; only the stale C is there. B clears block 3 at startup
  //    and never fetches it back, run after run.
  for (let run = 0; run < 2; run++) {
    const rb = await runSync({ ...once, dataDir: b.dir })
    t.ok(rb.ok, 'sync with the stale peer ok ' + JSON.stringify(rb.errors))
    t.is(rb.downloaded[a.key], 5)
    t.ok(await c.core.has(3), 'C still holds block 3')
    const ib = await inspect(b.dir, a.key)
    t.absent(ib.has3, 'B lacks block 3 (run ' + run + ')')
    t.is(ib.entries.length, 5)
    t.ok(ib.entries[3].deleted, 'block 3 stays a deleted slot')
  }
  const feed = await member.feedRead({ dataDir: b.dir })
  const seqs = feed.items.filter((i) => i.author === a.key).map((i) => i.seq)
  t.ok(seqs.includes(2), 'the other post is shown')
  t.absent(seqs.includes(3), 'the feed hides the deleted post')

  // 4. E lists A past the follow limit: not synced but still served, so the
  //    startup sweep clears its deleted block. Unfollowed, the replica is
  //    purged, unless the kill switch is set.
  {
    const quiet = { ...localSwarmOptions(bootstrap), once: true, timeoutMs: 2000 }
    t.ok((await inspect(e.dir, a.key)).has3, 'E kept block 3 under the kill switch')
    await runSync({ ...quiet, dataDir: e.dir, maxFollows: 0 })
    const ie = await inspect(e.dir, a.key)
    t.ok(ie.stored, 'a listed replica is kept')
    t.absent(ie.has3, 'its deleted block is cleared')
    t.is(ie.entries.length, 5)

    writeFollows(e.dir, [])
    await runSync({ ...quiet, dataDir: e.dir, noClear: true })
    t.ok((await inspect(e.dir, a.key)).stored, 'kill switch: the unfollowed replica stays')
    await runSync({ ...quiet, dataDir: e.dir })
    t.absent((await inspect(e.dir, a.key)).stored, 'the unfollowed replica is purged')
  }

  // 5. A fresh follower D bootstrapped only from stale holders (C and a
  //    seeder that copied A from C) ends without block 3.
  {
    const s = await staleHolder(t, bootstrap, kp, a.key, { seeder: true })
    await until(() => s.core.contiguousLength === 5, { timeoutMs: 30000, name: 'the seeder copies A from C' })
    t.ok(await s.core.has(3), 'the seeder holds block 3')
    const d = await makeMember(t, kp, { posts: 0 })
    writeFollows(d.dir, [a.key])
    const rd = await runSync({ ...once, dataDir: d.dir })
    t.ok(rd.ok, 'fresh follower ok ' + JSON.stringify(rd.errors))
    t.is(rd.downloaded[a.key], 5)
    const id = await inspect(d.dir, a.key)
    t.absent(id.has3, 'D lacks block 3 after its scan')
    t.is(id.entries.length, 5)
    t.ok(id.entries[3].deleted, 'and marks it deleted')
  }
})

test('a truncate still drops a followed diary with a deleted block', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const store = new Corestore(tmpDir(t, 'varanda-raw-'))
  await store.ready()
  const diary = store.get({ name: 'diary', valueEncoding: 'json' })
  await diary.ready()
  const key = hex(diary.key)
  await diary.append(memberCertRecord(createCert({ member: key }, kp)))
  await diary.append(postRecord({ text: 'um' }))
  await diary.append(postRecord({ text: 'dois' }))
  await diary.append(deleteRecord({ seq: 1 }))
  await diary.clear(1, 2)
  const swarm = createSwarm(localSwarmOptions(bootstrap))
  t.teardown(async () => {
    await swarm.destroy()
    await store.close()
  }, { force: true })
  swarm.on('connection', (socket) => {
    socket.on('error', () => {})
    store.replicate(socket)
    attachAdmission(socket, { role: 'member', have: [{ key, length: diary.length }], onmessage: () => {} })
  })
  await joinAndFlush(swarm, [topicFor(hex(kp.publicKey)), diary.discoveryKey])

  const b = await makeMember(t, kp, { posts: 0 })
  writeFollows(b.dir, [key])
  const events = []
  const controller = new AbortController()
  t.teardown(() => controller.abort(), { force: true })
  const pb = runSync({ ...localSwarmOptions(bootstrap), dataDir: b.dir, signal: controller.signal, onEvent: (ev) => events.push(ev) })
  await until(() => events.some((ev) => ev.event === 'downloaded' && ev.key === key && ev.length === 4), { timeoutMs: 30000, name: 'downloaded 4 past the hole' })

  await diary.truncate(2, { fork: 1 })
  await diary.append(postRecord({ text: 'reescrito' }))
  await until(() => events.some((ev) => ev.event === 'skipped' && ev.key === key && ev.reason === 'fork'), { timeoutMs: 30000, name: 'skipped fork' })
  controller.abort()
  const rb = await pb
  t.alike(rb.skipped, [{ key, reason: 'fork' }])
  t.absent((await inspect(b.dir, key)).stored, 'purged')
})

test('a burst of arriving tombstones is folded in a few merged recomputes', async (t) => {
  t.timeout(120000)
  const N = 40
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const store = new Corestore(tmpDir(t, 'varanda-raw-'))
  await store.ready()
  const diary = store.get({ name: 'diary', valueEncoding: 'json' })
  await diary.ready()
  const key = hex(diary.key)
  await diary.append(memberCertRecord(createCert({ member: key }, kp)))
  for (let i = 0; i < N; i++) await diary.append(postRecord({ text: 'post ' + i }))
  for (let i = 1; i <= N; i++) await diary.append(deleteRecord({ seq: i }))
  const total = diary.length
  const swarm = createSwarm(localSwarmOptions(bootstrap))
  t.teardown(async () => {
    await swarm.destroy()
    await store.close()
  }, { force: true })
  swarm.on('connection', (socket) => {
    socket.on('error', () => {})
    store.replicate(socket)
    attachAdmission(socket, { role: 'member', have: [{ key, length: total }], onmessage: () => {} })
  })
  await joinAndFlush(swarm, [topicFor(hex(kp.publicKey)), diary.discoveryKey])

  const b = await makeMember(t, kp, { posts: 0 })
  writeFollows(b.dir, [key])
  const events = []
  let inspector = null
  const controller = new AbortController()
  t.teardown(() => controller.abort(), { force: true })
  const pb = runSync({
    ...localSwarmOptions(bootstrap),
    dataDir: b.dir,
    signal: controller.signal,
    onEvent: (ev) => events.push(ev),
    inspectHook: (i) => { inspector = i }
  })
  await until(() => events.some((ev) => ev.event === 'downloaded' && ev.key === key && ev.length === total), { timeoutMs: 30000, name: 'downloaded past every tombstone' })
  controller.abort()
  await pb
  const recomputes = inspector.recomputeCount()
  t.comment('recomputes for ' + N + ' tombstones: ' + recomputes)
  t.ok(recomputes >= 1, 'the tombstones were folded')
  t.ok(recomputes <= N / 4, 'requests made during a recompute merge (' + recomputes + ')')

  const ib = await inspect(b.dir, key)
  t.is(ib.entries.length, total)
  const deleted = ib.entries.filter((e) => e.deleted).map((e) => e.seq)
  t.alike(deleted, Array.from({ length: N }, (_, i) => i + 1), 'every post is deleted')
  const bs = await openStore(b.dir)
  try {
    const replica = await openReplica(bs, key)
    try {
      let held = 0
      for (let i = 1; i <= N; i++) if (await replica.has(i)) held++
      t.is(held, 0, 'every deleted post is cleared')
    } finally {
      await replica.close()
    }
  } finally {
    await bs.close()
  }
})
